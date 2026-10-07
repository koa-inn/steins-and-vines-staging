'use strict';

/**
 * Staff Access API — Phase 86 Plan 12 (DB-05, D-02, D-03).
 *
 * Owner-only, audited management of the staff allowlist.
 *
 *   GET    /api/staff-access/me      any staff session -> {email, role, break_glass, store}
 *   GET    /api/staff-access         owner -> {ok, staff, break_glass_only, audit}
 *   POST   /api/staff-access         owner {email, role}
 *   PUT    /api/staff-access/:email  owner {role}
 *   DELETE /api/staff-access/:email  owner
 *
 * Guard chain (every route; the global /api guard skips GET so requireTiers is called inline):
 *   requireTiers(['session']) -> authTier must be exactly 'session' (requireTiers lets a lone
 *   legacy x-api-key through without checking allowedTiers) -> session presented via the
 *   x-session-token header (a SameSite=None cookie alone is CSRF-able) and any sv_session cookie
 *   must match -> Origin, when sent, must be allowlisted -> owner role re-derived from the
 *   database with the cache bypassed (owner routes only).
 */

var express = require('express');
var authTiers = require('../lib/authTiers');
var staffAccess = require('../lib/staff-access');
var staffAccessPg = require('../lib/staff-access-pg');
var db = require('../lib/db');
var log = require('../lib/logger');
var allowedOrigins = require('../lib/allowed-origins');

var router = express.Router();

var DENIED_WARN_INTERVAL_MS = 60000;
var lastDeniedWarn = {};

var STATUS_BY_ERROR = {
  invalid_email: 422,
  invalid_role: 422,
  staff_exists: 409,
  cannot_remove_self: 409,
  cannot_change_own_role: 409,
  last_owner: 409,
  break_glass_member: 409,
  not_found: 404
};

function deny(res, status, code) {
  return res.status(status).json({ error: code, code: code });
}

function unavailable(res, err, where) {
  log.error('[staff-access] ' + where + ' failed: ' + (err && err.name));
  return res.status(503).json({ error: 'staff_access_unavailable', code: 'staff_access_unavailable' });
}

function normaliseTarget(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

/** Best-effort audit of a refused owner mutation; never throws, never blocks the 403. */
function auditDenied(req, target) {
  var actorHash = staffAccess.hashEmail(req.staffEmail);
  var now = Date.now();
  if (!lastDeniedWarn[actorHash] || now - lastDeniedWarn[actorHash] > DENIED_WARN_INTERVAL_MS) {
    lastDeniedWarn[actorHash] = now;
    log.warn('[staff-access] non-owner mutation refused h=' + actorHash + ' ' + req.method);
  }
  return db.withTransaction(function (client) {
    return staffAccessPg.recordDenied(client, {
      actor: req.staffEmail,
      target: target,
      note: req.method + ' ' + (req.baseUrl || '') + (req.path || '')
    });
  }).catch(function () { /* audit is best-effort here; the request is refused regardless */ });
}

/**
 * Builds the guard middleware. opts.owner: also require the owner role and a Postgres-backed store.
 * opts.targetOf(req): the email a refused mutation was aimed at (for the denied audit row).
 */
function guard(opts) {
  return function (req, res, next) {
    authTiers.requireTiers(['session'])(req, res, function () {
      var isSession = req.authTier === 'session';
      if (!isSession) return deny(res, 403, 'session_required');

      var headerToken = req.headers['x-session-token'];
      if (typeof headerToken !== 'string' || !headerToken) return deny(res, 403, 'header_token_required');
      var cookieSid = req.cookies && req.cookies.sv_session;
      if (cookieSid && cookieSid !== headerToken) return deny(res, 403, 'header_token_required');

      var origin = req.headers.origin;
      if (origin && !allowedOrigins.isAllowedOrigin(origin)) return deny(res, 403, 'origin_not_allowed');

      if (!opts.owner) return next();

      if (staffAccess.getMode() === 'sheets') {
        return res.status(503).json({
          error: 'staff_access_requires_postgres', code: 'staff_access_requires_postgres'
        });
      }

      return staffAccess.resolve(req.staffEmail, { bypassCache: true }).then(function (decision) {
        if (!decision.allowed && decision.degraded) {
          return res.status(503).json({ error: 'staff_access_unavailable', code: 'staff_access_unavailable' });
        }
        if (!decision.allowed || decision.role !== 'owner') {
          if (req.method === 'GET') return deny(res, 403, 'owner_required');
          var target = opts.targetOf ? opts.targetOf(req) : null;
          return auditDenied(req, target).then(function () {
            return deny(res, 403, 'owner_required');
          });
        }
        return next();
      }).catch(function (err) {
        return unavailable(res, err, 'guard');
      });
    });
  };
}

function bodyTarget(req) { return normaliseTarget(req.body && req.body.email); }
function paramTarget(req) { return normaliseTarget(req.params && req.params.email); }

/** Runs a staff-access-pg mutation in a transaction and maps the result. */
function mutate(req, res, fn, okStatus) {
  return db.withTransaction(function (client) {
    return fn(client);
  }).then(function (result) {
    if (!result || !result.ok) {
      var code = (result && result.error) || 'unknown';
      var status = STATUS_BY_ERROR[code] || 409;
      return res.status(status).json({ error: (result && result.message) || code, code: code });
    }
    staffAccess.clearCache();
    return res.status(okStatus).json({ ok: true });
  }).catch(function (err) {
    return unavailable(res, err, 'mutation');
  });
}

router.get('/api/staff-access/me', guard({ owner: false }), function (req, res) {
  return staffAccess.resolve(req.staffEmail, { bypassCache: true }).then(function (decision) {
    var email = String(req.staffEmail).trim().toLowerCase();
    return res.json({
      email: req.staffEmail,
      role: decision.role,
      break_glass: staffAccess.breakGlassEmails().indexOf(email) !== -1,
      store: staffAccess.getMode()
    });
  }).catch(function (err) {
    return unavailable(res, err, 'me');
  });
});

router.get('/api/staff-access', guard({ owner: true }), function (req, res) {
  var breakGlass = staffAccess.breakGlassEmails();
  return Promise.all([staffAccessPg.listStaff(db), staffAccessPg.listAudit(db, { limit: 50 })])
    .then(function (results) {
      var rows = results[0];
      var seen = {};
      var staff = rows.map(function (r) {
        seen[r.email] = true;
        return {
          email: r.email,
          role: r.role,
          added_by: r.added_by,
          added_at: r.added_at,
          break_glass: breakGlass.indexOf(r.email) !== -1
        };
      });
      var breakGlassOnly = breakGlass.filter(function (e) { return !seen[e]; });
      return res.json({ ok: true, staff: staff, break_glass_only: breakGlassOnly, audit: results[1] });
    }).catch(function (err) {
      return unavailable(res, err, 'list');
    });
});

router.post('/api/staff-access', guard({ owner: true, targetOf: bodyTarget }), function (req, res) {
  var body = req.body || {};
  return mutate(req, res, function (client) {
    return staffAccessPg.addStaff(client, {
      actor: req.staffEmail,
      target: normaliseTarget(body.email),
      role: body.role,
      breakGlass: staffAccess.breakGlassEmails()
    });
  }, 201);
});

router.put('/api/staff-access/:email', guard({ owner: true, targetOf: paramTarget }), function (req, res) {
  var body = req.body || {};
  return mutate(req, res, function (client) {
    return staffAccessPg.changeRole(client, {
      actor: req.staffEmail,
      target: paramTarget(req),
      role: body.role,
      breakGlass: staffAccess.breakGlassEmails()
    });
  }, 200);
});

router.delete('/api/staff-access/:email', guard({ owner: true, targetOf: paramTarget }), function (req, res) {
  return mutate(req, res, function (client) {
    return staffAccessPg.removeStaff(client, {
      actor: req.staffEmail,
      target: paramTarget(req),
      breakGlass: staffAccess.breakGlassEmails()
    });
  }, 200);
});

module.exports = router;

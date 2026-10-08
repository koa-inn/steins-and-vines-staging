'use strict';

/**
 * Phase 86 Plan 15 - Vessels editor API (DB-05, D-05..D-08, D-16).
 *
 * Staff-only (legacy + session tiers; device excluded). Every route calls requireTiers inline
 * because the global /api guard skips GET. There is deliberately NO DELETE route (D-07):
 * vessels are archived, never removed. In sheets mode every route answers 503 so the admin
 * tab can show an empty state.
 *
 * Session-tier mutations must present the session in the x-session-token header (a
 * SameSite=None sv_session cookie alone is CSRF-able), matching any cookie, from an
 * allowlisted Origin when one is sent - the same check routes/staff-access.js applies.
 */

var express = require('express');
var log = require('../lib/logger');
var authTiers = require('../lib/authTiers');
var vesselStore = require('../lib/vessel-store');
var allowedOrigins = require('../lib/allowed-origins');

var router = express.Router();

var TIERS = ['legacy', 'session'];
var VESSEL_ID_RE = /^[A-Z]{2,6}-[0-9]{3,}$/;
var PREFIX_RE = /^[A-Z]{2,6}$/;

var STALE_MESSAGE = 'This vessel was changed since you opened it — reload to see the latest';
var SHEETS_MESSAGE = 'The vessels editor is available once vessels move to the database';

function actorOf(req) {
  return req.staffEmail || 'middleware';
}

/** Sends the sheets-mode 503 and returns true when the editor is unavailable. */
function sheetsBlocked(res) {
  if (vesselStore.getMode() === 'sheets') {
    res.status(503).json({ error: SHEETS_MESSAGE, code: 'vessels_editor_requires_postgres' });
    return true;
  }
  return false;
}

/** Sends a 403 and returns true when a session-tier write is not proven by the header token. */
function sessionWriteBlocked(req, res) {
  if (req.authTier !== 'session') return false;
  var headerToken = req.headers && req.headers['x-session-token'];
  var cookieSid = req.cookies && req.cookies.sv_session;
  var code = null;
  if (typeof headerToken !== 'string' || !headerToken || (cookieSid && cookieSid !== headerToken)) {
    code = 'header_token_required';
  } else if (req.headers.origin && !allowedOrigins.isAllowedOrigin(req.headers.origin)) {
    code = 'origin_not_allowed';
  }
  if (!code) return false;
  res.status(403).json({ error: code, code: code });
  return true;
}

function invalid(res, message) {
  return res.status(422).json({ error: message, code: 'invalid_vessel' });
}

/** Maps a resolved {ok:false} store result onto the HTTP contract. */
function sendBusinessError(res, data) {
  var code = data.error;
  var message = data.message || code || 'Request failed';
  if (code === 'stale_vessel') {
    return res.status(409).json({ error: STALE_MESSAGE, code: 'stale_vessel' });
  }
  if (code === 'vessel_exists' || code === 'vessel_in_use') {
    return res.status(409).json({ error: message, code: code });
  }
  if (code === 'not_found') {
    return res.status(404).json({ error: message, code: 'not_found' });
  }
  if (code === 'vessel_id_immutable') {
    return res.status(422).json({ error: message, code: 'vessel_id_immutable' });
  }
  return res.status(422).json({ error: message, code: 'invalid_vessel' });
}

function sendFailure(res, op, id, err) {
  log.error('[api/vessels] ' + op + ' ' + id + ' failed: ' + ((err && err.message) || String(err)));
  return res.status(502).json({ error: 'Unable to save vessel', code: 'save_failed' });
}

function writeResult(res, data, successStatus) {
  if (!data || data.ok !== true) return sendBusinessError(res, data || {});
  return res.status(successStatus).json({ ok: true, vessel: data.vessel });
}

// GET /api/vessels
router.get('/api/vessels', function (req, res) {
  authTiers.requireTiers(TIERS)(req, res, function () {
    if (sheetsBlocked(res)) return;
    vesselStore.list().then(function (data) {
      res.json({ ok: true, vessels: (data && data.data && data.data.vessels) || [] });
    }).catch(function (err) {
      log.error('[api/vessels] GET list failed: ' + err.message);
      res.status(502).json({ error: 'Unable to load vessels', code: 'load_failed' });
    });
  });
});

// GET /api/vessels/next-id?prefix=PCB
router.get('/api/vessels/next-id', function (req, res) {
  authTiers.requireTiers(TIERS)(req, res, function () {
    if (sheetsBlocked(res)) return;
    var prefix = req.query && req.query.prefix;
    if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
      return invalid(res, 'prefix must be 2-6 uppercase letters');
    }
    vesselStore.nextVesselNumber(prefix).then(function (id) {
      res.json({ ok: true, vessel_id: id });
    }).catch(function (err) {
      log.error('[api/vessels] GET next-id ' + prefix + ' failed: ' + err.message);
      res.status(502).json({ error: 'Unable to load vessels', code: 'load_failed' });
    });
  });
});

// POST /api/vessels
router.post('/api/vessels', function (req, res) {
  authTiers.requireTiers(TIERS)(req, res, function () {
    if (sessionWriteBlocked(req, res) || sheetsBlocked(res)) return;
    var body = req.body || {};
    var id = body.vessel_id;
    if (typeof id !== 'string' || !VESSEL_ID_RE.test(id.trim())) {
      return invalid(res, 'vessel_id must look like PREFIX-NNN (e.g. PCB-050)');
    }
    vesselStore.create(body, { actor: actorOf(req) }).then(function (data) {
      writeResult(res, data, 201);
    }).catch(function (err) {
      sendFailure(res, 'POST', id, err);
    });
  });
});

// PUT /api/vessels/:id
router.put('/api/vessels/:id', function (req, res) {
  authTiers.requireTiers(TIERS)(req, res, function () {
    if (sessionWriteBlocked(req, res) || sheetsBlocked(res)) return;
    var id = req.params.id;
    if (!VESSEL_ID_RE.test(id)) return invalid(res, 'Invalid vessel id');
    var payload = {};
    var body = req.body || {};
    Object.keys(body).forEach(function (k) {
      if (k !== 'expected_updated_at') payload[k] = body[k];
    });
    vesselStore.update(id, payload, {
      actor: actorOf(req),
      expectedUpdatedAt: body.expected_updated_at
    }).then(function (data) {
      writeResult(res, data, 200);
    }).catch(function (err) {
      sendFailure(res, 'PUT', id, err);
    });
  });
});

function archiveHandler(op) {
  return function (req, res) {
    authTiers.requireTiers(TIERS)(req, res, function () {
      if (sessionWriteBlocked(req, res) || sheetsBlocked(res)) return;
      var id = req.params.id;
      if (!VESSEL_ID_RE.test(id)) return invalid(res, 'Invalid vessel id');
      var body = req.body || {};
      vesselStore[op](id, {
        actor: actorOf(req),
        expectedUpdatedAt: body.expected_updated_at
      }).then(function (data) {
        writeResult(res, data, 200);
      }).catch(function (err) {
        sendFailure(res, op, id, err);
      });
    });
  };
}

// POST /api/vessels/:id/archive and /unarchive
router.post('/api/vessels/:id/archive', archiveHandler('archive'));
router.post('/api/vessels/:id/unarchive', archiveHandler('unarchive'));

module.exports = router;

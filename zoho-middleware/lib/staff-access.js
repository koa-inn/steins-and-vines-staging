'use strict';

/**
 * Staff allowlist authorisation decision — Phase 86 Plan 07 (DB-05, D-01, D-02, D-10, D-20).
 *
 * resolve(email) answers "may this verified Google email use the staff tools, and as what role?".
 *
 *  - Break-glass (D-01): members of the Railway STAFF_EMAILS env var are ALWAYS allowed and never
 *    need the database to be reachable. In sheets mode that env list is the whole decision, exactly
 *    as before this phase. In dual/postgres mode a STAFF_EMAILS member with a staff_access row takes
 *    the row's role (D-02: pre-trim regular staff are not owners); with no row, or with Postgres
 *    down, they resolve as owner.
 *  - Fail closed (D-20): in dual/postgres mode a non-break-glass email is allowed only with a
 *    staff_access row. A Postgres error DENIES (there is no grace cache and no Sheets fallback) and
 *    logs a hashed-email warning.
 *  - Role is re-derived from staff_access on every resolve, never trusted from a session payload.
 *  - Never mirrored (D-10): the staff list is never written to any sheet. STAFF_ACCESS_STORE
 *    'dual' only adds a shadow compare: an env-allowed email with no row is reported (hash only,
 *    at most once an hour per email).
 *  - Cache: allowed decisions are cached for 5000 ms (denials and degraded results never are).
 *    Revocation therefore takes effect within 5 s, or immediately on the same instance once the
 *    routes call clearCache() after a mutation. This bound assumes a SINGLE middleware instance
 *    (Pitfall 10). bypassCache skips both the read and the write.
 *
 * Requires of store-flag and db are lazy (Pitfall 15) so mocked-constants route tests can load
 * this module without those side effects.
 */

var crypto = require('crypto');
var log = require('./logger');

var CACHE_TTL_MS = 5000;
var REPORT_INTERVAL_MS = 3600000;

var cache = {};
var lastReported = {};

function normalise(email) {
  return String(email === null || email === undefined ? '' : email).trim().toLowerCase();
}

function getMode() {
  return require('./store-flag').resolveStoreMode('STAFF_ACCESS_STORE');
}

/** Lower-cased, trimmed, non-empty entries of STAFF_EMAILS (same parse as routes/auth.js). */
function breakGlassEmails() {
  return String(process.env.STAFF_EMAILS || '')
    .split(',')
    .map(function (e) { return e.trim().toLowerCase(); })
    .filter(function (e) { return e.length > 0; });
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(normalise(email)).digest('hex').slice(0, 10);
}

function clearCache() {
  cache = {};
}

function lookupRole(email) {
  var db = require('./db');
  return db.query('select role from staff_access where email = $1', [email]).then(function (res) {
    return res && res.rows && res.rows.length ? res.rows[0].role : null;
  });
}

function reportShadow(email) {
  var hash = hashEmail(email);
  var now = Date.now();
  if (lastReported[hash] && now - lastReported[hash] < REPORT_INTERVAL_MS) return;
  lastReported[hash] = now;
  log.warn('[dual-write] staff-access env-only decision differs h=' + hash);
}

function denied(degraded) {
  return { allowed: false, role: null, source: 'none', breakGlass: false, degraded: !!degraded };
}

function decide(email, mode, isBreakGlass) {
  if (mode === 'sheets' || (mode !== 'dual' && mode !== 'postgres')) {
    if (isBreakGlass) return Promise.resolve({ allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: false });
    return Promise.resolve(denied(false));
  }

  return lookupRole(email).then(function (role) {
    if (role) {
      return { allowed: true, role: role, source: 'pg', breakGlass: isBreakGlass, degraded: false };
    }
    if (isBreakGlass) {
      if (mode === 'dual') reportShadow(email);
      return { allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: false };
    }
    return denied(false);
  }, function () {
    if (isBreakGlass) {
      log.warn('[staff-access] lookup failed, break-glass allowed h=' + hashEmail(email));
      return { allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: true };
    }
    log.warn('[staff-access] lookup failed h=' + hashEmail(email));
    return denied(true);
  });
}

/**
 * @param {string} email
 * @param {{bypassCache: boolean}} [opts]
 * @returns {Promise<{allowed:boolean, role:(string|null), source:string, breakGlass:boolean, degraded:boolean}>}
 *   Never rejects.
 */
function resolve(email, opts) {
  var bypass = !!(opts && opts.bypassCache);
  var key = normalise(email);
  var isBreakGlass = false;

  try {
    if (!key) return Promise.resolve(denied(false));
    isBreakGlass = breakGlassEmails().indexOf(key) !== -1;

    if (!bypass) {
      var hit = cache[key];
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);
    }

    return decide(key, getMode(), isBreakGlass).then(function (value) {
      if (!bypass && value.allowed && !value.degraded) {
        cache[key] = { at: Date.now(), value: value };
      }
      return value;
    }).catch(function () {
      return fallback(key, isBreakGlass);
    });
  } catch (err) {
    log.warn('[staff-access] resolve error h=' + hashEmail(key) + ' ' + (err && err.name));
    return Promise.resolve(fallback(key, isBreakGlass));
  }
}

function fallback(key, isBreakGlass) {
  if (isBreakGlass) return { allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: true };
  return denied(true);
}

module.exports = {
  resolve: resolve,
  breakGlassEmails: breakGlassEmails,
  clearCache: clearCache,
  hashEmail: hashEmail,
  getMode: getMode
};

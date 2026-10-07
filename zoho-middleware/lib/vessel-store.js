'use strict';

/**
 * Phase 86 vessel store facade (DB-05, D-10, D-19). Postgres is authoritative; used only when
 * OPS_DATA_STORE is dual or postgres. In sheets mode every call rejects with err.code
 * 'sheets_mode' so callers keep the untouched Apps Script path. Reads never fall back to the
 * sheet: a Postgres failure rejects (route returns 502).
 *
 * Postgres business rejections resolve {ok:false, error, message}; only infrastructure failures
 * reject. Successful writes schedule the production-only ops mirror and strip underscore keys.
 *
 * Deliberately does NOT require ./constants (route tests mock it partially).
 */

var storeFlag = require('./store-flag');
var db = require('./db');
var vesselPg = require('./vessel-pg');
var opsMirror = require('./ops-mirror');
var log = require('./logger');

function getMode() {
  return storeFlag.resolveStoreMode('OPS_DATA_STORE');
}

/** Returns a rejected promise in sheets mode, otherwise null. */
function sheetsGuard() {
  if (getMode() === 'sheets') {
    var err = new Error('OPS_DATA_STORE is sheets; vessel store is not active');
    err.code = 'sheets_mode';
    return Promise.reject(err);
  }
  return null;
}

function runPg(fn) {
  return db.withTransaction(fn);
}

function strip(result) {
  if (!result || typeof result !== 'object') return result;
  var out = {};
  Object.keys(result).forEach(function (key) {
    if (key.charAt(0) !== '_') out[key] = result[key];
  });
  return out;
}

function scheduleMirror(id) {
  try {
    opsMirror.schedule('vessel', id);
  } catch (err) {
    log.warn('[vessels] mirror schedule failed vessel=' + id + ': ' +
      ((err && err.message) || String(err)));
  }
}

function finish(raw) {
  if (raw && raw.ok && raw._vesselId) scheduleMirror(raw._vesselId);
  return strip(raw);
}

function writeOpts(opts) {
  opts = opts || {};
  return {
    actor: opts.actor || 'middleware',
    expectedUpdatedAt: opts.expectedUpdatedAt,
    now: new Date()
  };
}

function list() {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.listVessels(client);
  }).then(function (vessels) {
    return { ok: true, data: { vessels: vessels } };
  });
}

function get(id) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.getVessel(client, id);
  });
}

function create(payload, opts) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.createVessel(client, payload, writeOpts(opts));
  }).then(finish);
}

function update(id, payload, opts) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.updateVessel(client, id, payload, writeOpts(opts));
  }).then(finish);
}

function archive(id, opts) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.archiveVessel(client, id, writeOpts(opts));
  }).then(finish);
}

function unarchive(id, opts) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.unarchiveVessel(client, id, writeOpts(opts));
  }).then(finish);
}

function applyStatusChanges(changes, opts) {
  var blocked = sheetsGuard();
  if (blocked) return blocked;
  if (!Array.isArray(changes)) {
    return Promise.resolve({ applied: [], unchanged: [], unknown: [], invalid: [] });
  }
  var o = writeOpts(opts);
  return runPg(function (client) {
    return vesselPg.applyStatusChanges(client, changes, { actor: o.actor, now: o.now });
  }).then(function (result) {
    (result.applied || []).forEach(scheduleMirror);
    return result;
  });
}

function nextVesselNumber(prefix) {
  return sheetsGuard() || runPg(function (client) {
    return vesselPg.nextVesselNumber(client, prefix);
  });
}

module.exports = {
  getMode: getMode,
  list: list,
  get: get,
  create: create,
  update: update,
  archive: archive,
  unarchive: unarchive,
  applyStatusChanges: applyStatusChanges,
  nextVesselNumber: nextVesselNumber
};

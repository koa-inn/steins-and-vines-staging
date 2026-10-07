'use strict';

/**
 * Phase 86 fermentation-schedule store facade (DB-05, D-10, D-14, D-15, D-19). Postgres is
 * authoritative; used only when OPS_DATA_STORE is dual or postgres. In sheets mode every call
 * rejects with err.code 'sheets_mode' so callers keep the untouched Apps Script path. Reads never
 * fall back to the sheet: a Postgres failure rejects (route returns 502).
 *
 * Seams to Apps Script (batches stay in the sheet until Phase 87):
 *   - hasBatchReferences: ferm_schedule_ref_count (delete fails closed when unavailable)
 *   - propagate: propagate_ferm_schedule with steps loaded from Postgres (client steps ignored)
 *
 * Known gap (T-86-13-05): remove() resolves the batch and recipe counts BEFORE the delete
 * transaction, so a reference created in that window is not seen. Archive is the safe action.
 *
 * Deliberately does NOT require ./constants (route tests mock it partially).
 */

var axios = require('axios');
var storeFlag = require('./store-flag');
var db = require('./db');
var fermSchedulePg = require('./ferm-schedule-pg');
var recipeStore = require('./recipe-store');
var opsMirror = require('./ops-mirror');
var log = require('./logger');

function getMode() {
  return storeFlag.resolveStoreMode('OPS_DATA_STORE');
}

/** Returns a rejected promise in sheets mode, otherwise null. */
function sheetsGuard() {
  if (getMode() === 'sheets') {
    var err = new Error('OPS_DATA_STORE is sheets; ferm schedule store is not active');
    err.code = 'sheets_mode';
    return Promise.reject(err);
  }
  return null;
}

// ─── Apps Script transport (copy of recipe-store callAppsScript) ─────────

function callAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    log.warn('[ferm-schedules] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured');
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return axios.post(url, JSON.stringify(Object.assign({}, payload, {
    action: action,
    server_token: token
  })), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    maxRedirects: 5
  }).then(function (resp) {
    return resp.data;
  });
}

// ─── Postgres transport ───────────────────────────────────────────────────

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
    opsMirror.schedule('fermsched', id);
  } catch (err) {
    log.warn('[ferm-schedules] mirror schedule failed schedule=' + id + ': ' +
      ((err && err.message) || String(err)));
  }
}

function finish(raw) {
  if (raw && raw.ok && raw._scheduleId) scheduleMirror(raw._scheduleId);
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

// ─── reads ────────────────────────────────────────────────────────────────

function list(opts) {
  opts = opts || {};
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.listSchedules(client, { includeArchived: opts.includeArchived === true });
  }).then(function (schedules) {
    return { ok: true, data: { schedules: schedules } };
  });
}

function get(id) {
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.getSchedule(client, id);
  });
}

/** D-14: steps for create_batch injection, always from Postgres. */
function getStepsJson(id) {
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.getSchedule(client, id);
  }).then(function (row) {
    if (!row) return { ok: false, error: 'not_found', message: 'Schedule not found: ' + id };
    return { ok: true, steps_json: JSON.stringify(row.steps_parsed) };
  });
}

// ─── writes ───────────────────────────────────────────────────────────────

function create(payload, opts) {
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.createSchedule(client, payload, writeOpts(opts));
  }).then(finish);
}

function update(payload, opts) {
  payload = payload || {};
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.updateSchedule(client, payload.schedule_id, payload, writeOpts(opts));
  }).then(finish);
}

function archive(payload, opts) {
  payload = payload || {};
  return sheetsGuard() || runPg(function (client) {
    return fermSchedulePg.archiveSchedule(client, payload.schedule_id, writeOpts(opts));
  }).then(finish);
}

// ─── reference counts (D-15) ──────────────────────────────────────────────

function refUnavailable(code, label, reason) {
  var err = new Error(label + ' reference check unavailable: ' + reason);
  err.code = code;
  return err;
}

/**
 * Batch reference count from Apps Script (read-only). Seam: Phase 87 replaces the body with SQL.
 * Rejects code 'batch_ref_unavailable' on any transport or shape failure so delete fails closed.
 */
function hasBatchReferences(id) {
  return sheetsGuard() || callAppsScript('ferm_schedule_ref_count', { schedule_id: id }).then(function (data) {
    if (!data || data.ok !== true || !Number.isInteger(data.count) || data.count < 0) {
      throw refUnavailable('batch_ref_unavailable', 'Batch', 'unexpected response');
    }
    return data.count;
  }, function (err) {
    throw refUnavailable('batch_ref_unavailable', 'Batch', (err && err.message) || String(err));
  });
}

/**
 * Recipe reference count. Postgres when RECIPES_STORE is not sheets (separate read-only
 * transaction), else counted from the recipe store's sheet list. Rejects
 * 'recipe_ref_unavailable' on failure.
 */
function countRecipeReferences(id) {
  var blocked = sheetsGuard();
  if (blocked) return blocked;
  var counting;
  if (storeFlag.resolveStoreMode('RECIPES_STORE') !== 'sheets') {
    counting = runPg(function (client) {
      return fermSchedulePg.countRecipeReferences(client, id);
    });
  } else {
    counting = recipeStore.list({}).then(function (resp) {
      var recipes = resp && resp.ok === true && resp.data && resp.data.recipes;
      if (!Array.isArray(recipes)) throw new Error('unexpected recipe list response');
      return recipes.filter(function (r) { return r && r.schedule_id === id; }).length;
    });
  }
  return counting.then(function (n) {
    if (!Number.isInteger(n) || n < 0) throw new Error('invalid count');
    return n;
  }).catch(function (err) {
    throw refUnavailable('recipe_ref_unavailable', 'Recipe', (err && err.message) || String(err));
  });
}

function remove(payload, opts) {
  var blocked = sheetsGuard();
  if (blocked) return blocked;
  payload = payload || {};
  var id = payload.schedule_id;
  var o = writeOpts(opts);
  // Both counts BEFORE the delete transaction; either failing rejects (fail closed).
  // Sequential so an unavailable batch count opens no transaction at all.
  return hasBatchReferences(id).then(function (batchRefCount) {
    return countRecipeReferences(id).then(function (recipeRefCount) {
      return runPg(function (client) {
        return fermSchedulePg.deleteSchedule(client, id, {
          expectedUpdatedAt: o.expectedUpdatedAt,
          batchRefCount: batchRefCount,
          recipeRefCount: recipeRefCount,
          now: o.now,
          actor: o.actor
        });
      });
    });
  }).then(finish);
}

// ─── propagate (D-14) ─────────────────────────────────────────────────────

function propagate(payload, opts) {
  var blocked = sheetsGuard();
  if (blocked) return blocked;
  payload = payload || {};
  opts = opts || {};
  var id = payload.schedule_id;
  return runPg(function (client) {
    return fermSchedulePg.getSchedule(client, id);
  }).then(function (row) {
    if (!row) return { ok: false, error: 'not_found', message: 'Schedule not found: ' + id };
    return callAppsScript('propagate_ferm_schedule', {
      schedule_id: id,
      steps: JSON.stringify(row.steps_parsed),
      acting_user: opts.actor || 'middleware'
    }).then(function (data) {
      if (data && typeof data === 'object' && !Array.isArray(data.batches_failed)) {
        data = Object.assign({}, data, { batches_failed: [] });
      }
      return data;
    });
  });
}

module.exports = {
  getMode: getMode,
  list: list,
  get: get,
  create: create,
  update: update,
  archive: archive,
  remove: remove,
  propagate: propagate,
  getStepsJson: getStepsJson,
  hasBatchReferences: hasBatchReferences,
  countRecipeReferences: countRecipeReferences
};

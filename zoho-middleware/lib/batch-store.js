'use strict';

/**
 * Phase 87 batch store facade (DB-06, D-05, D-13, D-14). The single issuer of batch operations.
 *
 * - BATCHES_STORE unset (sheets): every op resolves null so callers fall through to their
 *   existing, untouched Apps Script code.
 * - BATCHES_STORE=postgres: every op runs ONE db.withTransaction over the batch-pg-* modules,
 *   schedules the production-only ops mirror ('batch' per touched batch, 'vessel' per applied
 *   vessel change) after commit, and strips underscore-prefixed internal keys.
 * - BATCHES_FREEZE set: every WRITE op resolves the maintenance envelope in BOTH modes. Reads are
 *   never frozen.
 * - Postgres failures reject (the route maps that to 502); there is never a sheet fallback.
 *   Business rejections resolve {ok:false, error, message}.
 *
 * Deliberately does NOT require ./constants (route tests mock it partially). Collaborators are
 * required lazily so sheets mode never loads a pg module.
 */

var crypto = require('crypto');
var log = require('./logger');

var WRITE_OPS = [
  'create', 'update', 'updateSchedule', 'remove', 'updateTask', 'bulkUpdateTasks', 'addTask',
  'bulkAddReadings', 'updateReading', 'deleteReading', 'regenerateToken', 'publicUpdateTask',
  'publicAddReadings', 'propagate'
];

var BATCH_ID_RE = /^SV-B-[0-9]{6,}$/;
var TOKEN_RE = /^[0-9a-f]{32}$/;

function flag() { return require('./batch-flag'); }
function db() { return require('./db'); }
function mirror() { return require('./ops-mirror'); }
function pgRead() { return require('./batch-pg-read'); }
function pgCreate() { return require('./batch-pg-create'); }
function pgUpdate() { return require('./batch-pg-update'); }
function pgTasks() { return require('./batch-pg-tasks'); }
function scheduleStore() { return require('./ferm-schedule-store'); }

function getMode() {
  return flag().getMode();
}

function isPostgres() {
  return getMode() === 'postgres';
}

function isFrozen() {
  return flag().isFrozen();
}

function runPg(fn) {
  return db().withTransaction(fn);
}

function strip(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  var out = {};
  Object.keys(result).forEach(function (key) {
    if (key.charAt(0) !== '_') out[key] = result[key];
  });
  return out;
}

function scheduleMirror(entity, id) {
  try {
    mirror().schedule(entity, id);
  } catch (err) {
    log.warn('[batch-store] mirror schedule failed ' + entity + '=' + id + ': ' +
      ((err && err.message) || String(err)));
  }
}

/** Schedules mirrors for a successful write result, then strips internal keys. */
function finish(raw) {
  if (raw && raw.ok) {
    var seen = {};
    var batchIds = [];
    if (raw._batchId) batchIds.push(raw._batchId);
    if (Array.isArray(raw._batchIds)) batchIds = batchIds.concat(raw._batchIds);
    batchIds.forEach(function (id) {
      if (id && !seen[id]) {
        seen[id] = true;
        scheduleMirror('batch', id);
      }
    });
    if (Array.isArray(raw._vesselApplied)) {
      raw._vesselApplied.forEach(function (id) { scheduleMirror('vessel', id); });
    }
  }
  return strip(raw);
}

function writeOpts(payload, opts) {
  opts = opts || {};
  return {
    actor: opts.actor || (payload && payload.acting_user) || 'middleware',
    now: new Date()
  };
}

/**
 * Wraps one op. kind 'write' honours the freeze in both modes; every op resolves null outside
 * postgres mode. fn(client) does the work inside the single transaction.
 */
function dispatch(name, fn, post) {
  if (WRITE_OPS.indexOf(name) !== -1 && isFrozen()) {
    return Promise.resolve(flag().maintenanceEnvelope());
  }
  if (!isPostgres()) return Promise.resolve(null);
  return runPg(fn).then(post || function (r) { return r; });
}

// ─── reads ────────────────────────────────────────────────────────────────

function list(payload) {
  var p = payload || {};
  return dispatch('list', function (client) {
    return pgRead().listBatches(client, { status: p.status, limit: p.limit, offset: p.offset });
  });
}

function detail(payload) {
  var p = payload || {};
  return dispatch('detail', function (client) {
    return pgRead().getBatchDetail(client, p.batch_id);
  });
}

function dashboard() {
  return dispatch('dashboard', function (client) {
    return pgRead().getDashboardSummary(client, { now: new Date() });
  });
}

function calendar(payload) {
  var p = payload || {};
  return dispatch('calendar', function (client) {
    return pgRead().getTasksCalendar(client, p.start_date, p.end_date);
  });
}

function upcoming(payload) {
  var p = payload || {};
  return dispatch('upcoming', function (client) {
    return pgRead().getTasksUpcoming(client, Number(p.limit) || 50);
  });
}

/** get_batch_init: {batches, schedules:{schedules}, summary} (Apps Script shape). */
function batchInit(payload) {
  var p = payload || {};
  if (!isPostgres()) return Promise.resolve(null);
  return runPg(function (client) {
    var out = {};
    // Sequential on purpose: one client never runs concurrent queries.
    return pgRead().listBatches(client, { status: p.status, limit: p.limit, offset: p.offset })
      .then(function (batches) {
        out.batches = batches.data;
        return pgRead().getDashboardSummary(client, { now: new Date() });
      }).then(function (summary) {
        out.summary = summary.data;
        return out;
      });
  }).then(function (out) {
    return scheduleStore().list().then(function (r) {
      return {
        ok: true,
        data: {
          batches: out.batches,
          schedules: { schedules: (r && r.data && r.data.schedules) || [] },
          summary: out.summary
        }
      };
    });
  });
}

/** Every batch in list shape (status all): the reconcile / scan dedup index. */
function listAll() {
  return dispatch('listAll', function (client) {
    return pgRead().listAllForIndex(client);
  });
}

function countByRecipe(id) {
  return dispatch('countByRecipe', function (client) {
    return pgRead().countByRecipe(client, id);
  });
}

function countBySchedule(id) {
  return dispatch('countBySchedule', function (client) {
    return pgRead().countBySchedule(client, id);
  });
}

// ─── writes ───────────────────────────────────────────────────────────────

function create(payload, opts) {
  if (isFrozen()) {
    // D-04: the refusal is logged (invoice number only) so Scan invoices can recover it.
    var invoice = payload && payload.zoho_so_number ? String(payload.zoho_so_number) : '';
    log.warn('[batch-store] create_batch refused: maintenance' + (invoice ? ' invoice=' + invoice : ''));
  }
  return dispatch('create', function (client) {
    var o = writeOpts(payload, opts);
    var pgOpts = { actor: o.actor, now: o.now };
    if (opts && typeof opts.replayWindowMs === 'number') pgOpts.replayWindowMs = opts.replayWindowMs;
    return pgCreate().createBatch(client, payload, pgOpts);
  }, finish);
}

function simpleWrite(name, modFn, fnName) {
  return function (payload, opts) {
    return dispatch(name, function (client) {
      return modFn()[fnName](client, payload, writeOpts(payload, opts));
    }, finish);
  };
}

var update = simpleWrite('update', pgUpdate, 'updateBatch');
var updateSchedule = simpleWrite('updateSchedule', pgUpdate, 'updateBatchSchedule');
var remove = simpleWrite('remove', pgUpdate, 'deleteBatch');
var regenerateToken = simpleWrite('regenerateToken', pgUpdate, 'regenerateToken');
var updateTask = simpleWrite('updateTask', pgTasks, 'updateBatchTask');
var bulkUpdateTasks = simpleWrite('bulkUpdateTasks', pgTasks, 'bulkUpdateBatchTasks');
var addTask = simpleWrite('addTask', pgTasks, 'addBatchTask');
var bulkAddReadings = simpleWrite('bulkAddReadings', pgTasks, 'bulkAddPlatoReadings');
var updateReading = simpleWrite('updateReading', pgTasks, 'updatePlatoReading');
var deleteReading = simpleWrite('deleteReading', pgTasks, 'deletePlatoReading');

function propagate(scheduleId, steps, opts) {
  return dispatch('propagate', function (client) {
    return pgTasks().propagateSchedule(client, scheduleId, steps, writeOpts(null, opts));
  }, finish);
}

// ─── public (token) ops, D-14 ─────────────────────────────────────────────

function invalidToken(message) {
  return { ok: false, error: 'invalid_token', message: message || 'Invalid batch token' };
}

function tokenOk(stored, supplied) {
  var a = Buffer.from(String(stored));
  var b = Buffer.from(String(supplied));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getPublic(batchId, token) {
  return dispatch('getPublic', function (client) {
    return pgRead().getBatchPublic(client, batchId, token);
  });
}

/**
 * Validates the token inside the caller's transaction (row locked, no cache) so a regenerated
 * token is refused immediately. Resolves an invalid_token envelope or null when valid.
 */
function checkToken(client, batchId, token) {
  var id = batchId ? String(batchId) : '';
  var tok = token ? String(token) : '';
  if (!BATCH_ID_RE.test(id) || !TOKEN_RE.test(tok)) {
    return Promise.resolve(invalidToken('Invalid batch ID or token format'));
  }
  return pgRead().lockBatch(client, id).then(function (row) {
    if (!row || !tokenOk(row.access_token, tok)) return invalidToken();
    return null;
  });
}

function publicUpdateTask(batchId, token, body) {
  var b = body || {};
  var supplied = b.updates || {};
  // Only completed and notes may be set from the public page (T-87-11-04).
  var updates = {};
  if (supplied.completed !== undefined) updates.completed = supplied.completed;
  if (supplied.notes !== undefined) updates.notes = supplied.notes;
  return dispatch('publicUpdateTask', function (client) {
    return checkToken(client, batchId, token).then(function (bad) {
      if (bad) return bad;
      return pgTasks().updateBatchTask(client, { task_id: b.task_id, updates: updates }, {
        actor: 'batch-url',
        now: new Date(),
        publicBatchId: String(batchId)
      });
    });
  }, finish);
}

function publicAddReadings(batchId, token, readings) {
  return dispatch('publicAddReadings', function (client) {
    return checkToken(client, batchId, token).then(function (bad) {
      if (bad) return bad;
      return pgTasks().bulkAddPlatoReadings(client,
        { batch_id: String(batchId), readings: readings }, {
          actor: 'batch-url',
          now: new Date(),
          publicBatchId: String(batchId)
        });
    });
  }, finish);
}

module.exports = {
  getMode: getMode,
  isPostgres: isPostgres,
  isFrozen: isFrozen,
  list: list,
  detail: detail,
  dashboard: dashboard,
  calendar: calendar,
  upcoming: upcoming,
  batchInit: batchInit,
  listAll: listAll,
  create: create,
  update: update,
  updateSchedule: updateSchedule,
  remove: remove,
  updateTask: updateTask,
  bulkUpdateTasks: bulkUpdateTasks,
  addTask: addTask,
  bulkAddReadings: bulkAddReadings,
  updateReading: updateReading,
  deleteReading: deleteReading,
  regenerateToken: regenerateToken,
  getPublic: getPublic,
  publicUpdateTask: publicUpdateTask,
  publicAddReadings: publicAddReadings,
  countByRecipe: countByRecipe,
  countBySchedule: countBySchedule,
  propagate: propagate,
  WRITE_OPS: WRITE_OPS
};

'use strict';

/**
 * Postgres batch reads — Phase 87 Plan 06 (DB-06, D-01, D-06, D-14).
 *
 * This module never requires 'pg' and never creates a pool: every function receives `client`
 * (a pool client or a transaction client). SQL uses $n placeholders only, lives in module-level
 * constants, and the status filter is mapped through a fixed set, never interpolated.
 *
 * Rows are fetched with SQL and shaped by lib/batch-rules.js (the pure port of adminApi.gs,
 * proven against the Apps Script golden outputs), so sort orders, truncations and bucket math
 * live in exactly one place. Nothing here is cached (the Apps Script gds/gb: cache gaps are
 * deliberately not reproduced).
 *
 * node-pg returns `date` columns as local-midnight Date objects; batch-rules reads them with
 * local getters, so no UTC conversion happens anywhere in this module.
 *
 * Business rejections RESOLVE {ok:false, error, message}; infrastructure errors propagate.
 */

var crypto = require('crypto');
var batchRules = require('./batch-rules');

// The Apps Script project timezone (87-DESIGN Q3, approved). Drives "today", the week window
// and the month buckets of the dashboard.
var DEFAULT_TIMEZONE = 'America/Vancouver';

var BATCH_ID_RE = /^SV-B-[0-9]{6,}$/;
var TOKEN_RE = /^[0-9a-f]{32}$/;

// ─── SQL (module-level constants only) ─────────────────────────────────────

// Id order = sheet row order (numeric suffix); length first so 7+ digit ids still sort right.
var ID_ORDER_BATCH = 'order by length(batch_id), batch_id';

var BATCH_BY_ID_SQL = 'select * from batches where batch_id = $1';
var BATCH_LOCK_SQL = 'select * from batches where batch_id = $1 for update';

var TASKS_BY_BATCH_SQL =
  'select * from batch_tasks where batch_id = $1 order by length(task_id), task_id';
var READINGS_BY_BATCH_SQL =
  'select * from plato_readings where batch_id = $1 order by length(reading_id), reading_id';
var HISTORY_BY_BATCH_SQL =
  'select * from vessel_history where batch_id = $1 order by length(history_id), history_id';

// List: statuses are check-constrained lowercase, so comparing against lower($1) is exact.
var LIST_ALL_SQL = 'select * from batches ' + ID_ORDER_BATCH;
var LIST_ACTIVE_SQL =
  "select * from batches where status in ('pending', 'primary', 'secondary') " + ID_ORDER_BATCH;
var LIST_STATUS_SQL = 'select * from batches where status = lower($1) ' + ID_ORDER_BATCH;
var COUNT_ALL_SQL = 'select count(*) as n from batches';

var TASK_COUNTS_SQL =
  'select batch_id, count(*) as total, count(*) filter (where completed) as done ' +
  'from batch_tasks group by batch_id';

// Dashboard: only the columns the summary reads.
var DASHBOARD_BATCHES_SQL =
  'select batch_id, status, product_name, customer_name, customer_firstname, customer_lastname, ' +
  'customer_email, vessel_id, shelf_id, source, zoho_so_number, created_at, last_updated, start_date ' +
  'from batches ' + ID_ORDER_BATCH;
var ACTIVE_BATCHES_SQL =
  "select * from batches where status in ('primary', 'secondary') " + ID_ORDER_BATCH;
var ACTIVE_BATCH_TASKS_SQL =
  'select t.* from batch_tasks t join batches b on b.batch_id = t.batch_id ' +
  "where b.status in ('primary', 'secondary') order by length(t.task_id), t.task_id";
// Open tasks of active batches: served by batch_tasks_open_due_idx (partial, completed = false).
var OPEN_ACTIVE_TASKS_SQL =
  'select t.* from batch_tasks t join batches b on b.batch_id = t.batch_id ' +
  "where t.completed = false and b.status in ('primary', 'secondary') " +
  'order by length(t.task_id), t.task_id';

// Location conflict: the status predicate is literally the batches_location_idx partial predicate.
var LOCATION_CONFLICT_SQL =
  'select batch_id from batches ' +
  "where status in ('primary', 'secondary') " +
  'and vessel_id = $1 and shelf_id = $2 and bin_id = $3 ' +
  "and ($4::text = '' or batch_id <> $4::text) " +
  'order by length(batch_id), batch_id limit 1';

var COUNT_BY_RECIPE_SQL = 'select count(*) as n from batches where recipe_id = $1';
var COUNT_BY_SCHEDULE_SQL = 'select count(*) as n from batches where schedule_id = $1';

// ─── Helpers ───────────────────────────────────────────────────────────────

function firstRow(result) {
  return result.rows.length ? result.rows[0] : null;
}

function ok(data) {
  return { ok: true, data: data };
}

/** Constant-time token compare (T-87-06-01). Both values are already format-checked. */
function tokenMatches(stored, supplied) {
  var a = Buffer.from(String(stored));
  var b = Buffer.from(String(supplied));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function countsMap(rows) {
  var map = {};
  rows.forEach(function (r) {
    map[String(r.batch_id)] = { total: Number(r.total), done: Number(r.done) };
  });
  return map;
}

function loadChildren(client, batchId) {
  return Promise.all([
    client.query(TASKS_BY_BATCH_SQL, [batchId]),
    client.query(READINGS_BY_BATCH_SQL, [batchId]),
    client.query(HISTORY_BY_BATCH_SQL, [batchId])
  ]).then(function (res) {
    return { tasks: res[0].rows, readings: res[1].rows, history: res[2].rows };
  });
}

// ─── Reads ─────────────────────────────────────────────────────────────────

/**
 * getBatches: status filter ('active' | 'all' | a status, case-insensitive), limit/offset.
 * `total` is the unfiltered row count, `filtered` the count after the status filter (script parity).
 */
function listBatches(client, opts) {
  var o = opts || {};
  var status = o.status;
  var listSql = LIST_ALL_SQL;
  var params = [];
  if (status && status !== 'all') {
    if (status === 'active') {
      listSql = LIST_ACTIVE_SQL;
    } else {
      listSql = LIST_STATUS_SQL;
      params = [String(status)];
    }
  }
  return Promise.all([
    client.query(listSql, params),
    client.query(TASK_COUNTS_SQL),
    client.query(COUNT_ALL_SQL)
  ]).then(function (res) {
    var out = batchRules.buildBatchList(res[0].rows, countsMap(res[1].rows), {
      limit: o.limit,
      offset: o.offset,
      total: Number(res[2].rows[0].n)
    });
    return ok(out);
  });
}

/** Every batch in list shape (status all, no token): the reconcile / dedupe index. */
function listAllForIndex(client) {
  return listBatches(client, { status: 'all' }).then(function (res) {
    return res.data.batches;
  });
}

function getBatchDetail(client, batchId) {
  if (!batchId) return Promise.resolve(ok(batchRules.buildBatchDetail('', null, [], [], [])));
  return client.query(BATCH_BY_ID_SQL, [String(batchId)]).then(function (res) {
    var row = firstRow(res);
    if (!row) return ok(batchRules.buildBatchDetail(batchId, null, [], [], []));
    return loadChildren(client, row.batch_id).then(function (kids) {
      return ok(batchRules.buildBatchDetail(batchId, row, kids.tasks, kids.readings, kids.history));
    });
  });
}

/**
 * handleGetBatchPublic: format pre-check, not_found, constant-time token compare, disabled check.
 * Strips customer_email, reservation_id and access_token (D-14).
 */
function getBatchPublic(client, batchId, token) {
  var id = batchId ? String(batchId) : '';
  var tok = token ? String(token) : '';
  if (!id || !tok || !BATCH_ID_RE.test(id) || !TOKEN_RE.test(tok)) {
    return Promise.resolve(batchRules.buildPublicView(id, tok, null, [], [], []));
  }
  return client.query(BATCH_BY_ID_SQL, [id]).then(function (res) {
    var row = firstRow(res);
    if (!row || !tokenMatches(row.access_token, tok)) {
      // A wrong token never reaches the child queries; buildPublicView yields the exact
      // not_found / invalid_token object.
      return batchRules.buildPublicView(id, tok, row, [], [], []);
    }
    if (String(row.status).toLowerCase() === 'disabled') {
      return batchRules.buildPublicView(id, tok, row, [], [], []);
    }
    return loadChildren(client, row.batch_id).then(function (kids) {
      return batchRules.buildPublicView(id, tok, row, kids.tasks, kids.readings, kids.history);
    });
  });
}

function getDashboardSummary(client, opts) {
  var o = opts || {};
  return Promise.all([
    client.query(DASHBOARD_BATCHES_SQL),
    client.query(ACTIVE_BATCH_TASKS_SQL)
  ]).then(function (res) {
    var summary = batchRules.buildDashboardSummary(
      { batches: res[0].rows, tasks: res[1].rows },
      { now: o.now, timezone: o.timezone || DEFAULT_TIMEZONE }
    );
    return ok(summary);
  });
}

function getTasksCalendar(client, start, end) {
  if (!start || !end) return Promise.resolve(ok({ tasks: [] }));
  return Promise.all([
    client.query(ACTIVE_BATCHES_SQL),
    client.query(ACTIVE_BATCH_TASKS_SQL)
  ]).then(function (res) {
    return ok(batchRules.buildCalendar(res[1].rows, res[0].rows, String(start), String(end)));
  });
}

function getTasksUpcoming(client, limit) {
  var n = Number(limit) || 50;
  return Promise.all([
    client.query(ACTIVE_BATCHES_SQL),
    client.query(OPEN_ACTIVE_TASKS_SQL)
  ]).then(function (res) {
    return ok(batchRules.buildUpcoming(res[1].rows, res[0].rows, n));
  });
}

/**
 * checkLocationConflict: batch_id of the first primary/secondary batch (other than excludeBatchId)
 * on the same vessel + shelf + bin, or ''. Empty vessel_id never conflicts.
 */
function findLocationConflict(client, location, excludeBatchId) {
  var loc = location || {};
  if (!loc.vessel_id) return Promise.resolve('');
  var params = [
    String(loc.vessel_id),
    loc.shelf_id === undefined || loc.shelf_id === null ? '' : String(loc.shelf_id),
    loc.bin_id === undefined || loc.bin_id === null ? '' : String(loc.bin_id),
    excludeBatchId ? String(excludeBatchId) : ''
  ];
  return client.query(LOCATION_CONFLICT_SQL, params).then(function (res) {
    return res.rows.length ? String(res.rows[0].batch_id) : '';
  });
}

/** select ... for update on one batch row; null when it does not exist. */
function lockBatch(client, batchId) {
  return client.query(BATCH_LOCK_SQL, [String(batchId)]).then(firstRow);
}

/** The four sheet-shaped row sets of one batch for the Sheets mirror; null when absent. */
function getBatchBundle(client, batchId) {
  return client.query(BATCH_BY_ID_SQL, [String(batchId)]).then(function (res) {
    var row = firstRow(res);
    if (!row) return null;
    return loadChildren(client, row.batch_id).then(function (kids) {
      return {
        batch: batchRules.serializeBatch(row),
        tasks: kids.tasks.map(batchRules.serializeTask),
        readings: kids.readings.map(batchRules.serializeReading),
        history: kids.history.map(batchRules.serializeHistory)
      };
    });
  });
}

function countByRecipe(client, recipeId) {
  return client.query(COUNT_BY_RECIPE_SQL, [String(recipeId)]).then(function (res) {
    return Number(res.rows[0].n);
  });
}

function countBySchedule(client, scheduleId) {
  return client.query(COUNT_BY_SCHEDULE_SQL, [String(scheduleId)]).then(function (res) {
    return Number(res.rows[0].n);
  });
}

module.exports = {
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE,
  LOCATION_CONFLICT_SQL: LOCATION_CONFLICT_SQL,
  listBatches: listBatches,
  listAllForIndex: listAllForIndex,
  getBatchDetail: getBatchDetail,
  getBatchPublic: getBatchPublic,
  getDashboardSummary: getDashboardSummary,
  getTasksCalendar: getTasksCalendar,
  getTasksUpcoming: getTasksUpcoming,
  findLocationConflict: findLocationConflict,
  lockBatch: lockBatch,
  getBatchBundle: getBatchBundle,
  countByRecipe: countByRecipe,
  countBySchedule: countBySchedule
};

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

// Phase 94 S1 (D-21): lean aggregate. Explicit column whitelist, never select *; no customer_*,
// access_token, notes or snapshot columns. $1 is the timezone for the completion day.
var DASH_STATS_BATCHES_SQL =
  'select b.batch_id, b.status, b.batch_type, b.batch_type_source, ' +
  "to_char(b.start_date, 'YYYY-MM-DD') as start_date, " +
  "to_char(b.completed_at at time zone $1, 'YYYY-MM-DD') as completed_day, " +
  'b.completed_at, b.completed_at_source, b.vessel_id, b.source, b.product_sku, b.product_name, ' +
  'b.recipe_id, b.schedule_id, ' +
  "lower(coalesce(s.category, '')) as schedule_category, b.target_volume_l, " +
  'coalesce(tc.total, 0)::int as tasks_total, coalesce(tc.done, 0)::int as tasks_done ' +
  'from batches b left join ferm_schedules s on s.schedule_id = b.schedule_id ' +
  'left join (' + TASK_COUNTS_SQL + ') tc on tc.batch_id = b.batch_id ' +
  'order by length(b.batch_id), b.batch_id';
// Phase 95 (D-08): ids only, never customer columns. Kept out of DASH_STATS_BATCHES_SQL so the
// per-row lean key set is unchanged.
var DASH_STATS_STAFF_SQL =
  'select batch_id from batches where staff_batch = true order by length(batch_id), batch_id';
var DASH_STATS_TASKS_SQL =
  'select t.batch_id, t.task_id, to_char(t.due_date, \'YYYY-MM-DD\') as due_date, t.completed, ' +
  "to_char(t.completed_at at time zone $1, 'YYYY-MM-DD') as completed_day, " +
  't.is_packaging, t.is_transfer ' +
  'from batch_tasks t join batches b on b.batch_id = t.batch_id ' +
  "where b.status in ('primary', 'secondary') order by length(t.task_id), t.task_id";
var DASH_STATS_READINGS_SQL =
  'select distinct on (r.batch_id) r.batch_id, r.reading_at, r.degrees_plato, r.temperature, r.ph ' +
  'from plato_readings r join batches b on b.batch_id = r.batch_id ' +
  "where b.status in ('primary', 'secondary') order by r.batch_id, r.reading_at desc";

// Phase 96 (Plan 02): new arrays for the extra dashboard widgets. Explicit whitelists: never
// completed_by, recorded_by, notes, customer_*, access_token, zoho_so_number or raw recipe_snapshot.
var DASH_STATS_TASK_ROWS_SQL =
  'select t.batch_id, t.task_id, t.title, to_char(t.due_date, \'YYYY-MM-DD\') as due_date, t.completed, ' +
  "to_char(t.completed_at at time zone $1, 'YYYY-MM-DD') as completed_day, " +
  't.is_packaging, t.is_transfer ' +
  'from batch_tasks t join batches b on b.batch_id = t.batch_id ' +
  "where (t.completed = false and b.status in ('primary', 'secondary')) " +
  'or (t.completed = true and t.completed_at is not null) ' +
  'order by length(t.task_id), t.task_id';
var DASH_STATS_ALL_READINGS_SQL =
  'select r.batch_id, r.reading_at, ' +
  "to_char(r.reading_at at time zone $1, 'YYYY-MM-DD') as reading_day, " +
  'r.degrees_plato, r.temperature, r.ph ' +
  'from plato_readings r join batches b on b.batch_id = r.batch_id ' +
  "where b.status in ('primary', 'secondary') order by r.batch_id, r.reading_at";
var DASH_STATS_VESSELS_SQL =
  'select vessel_id, type, capacity_liters, archived from vessels order by position';
var DASH_STATS_BATCH_META_SQL =
  "select b.batch_id, (b.zoho_so_number <> '') as has_invoice_link, b.recipe_snapshot, " +
  '(select max(t.day_offset) from batch_tasks t where t.batch_id = b.batch_id) as planned_days ' +
  'from batches b order by length(b.batch_id), b.batch_id';

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
 * Phase 94 review WR-02: Postgres-only type extras for the staff list/detail reads. Opt-in
 * (opts.includeType) so the sheet-shaped default (golden parity, the mirror bundle and the
 * reconcile index) is unchanged. The sheet has no such columns.
 */
function addBatchType(batch, row) {
  batch.batch_type = row && row.batch_type ? String(row.batch_type) : null;
  batch.batch_type_source = row && row.batch_type_source ? String(row.batch_type_source) : null;
  batch.staff_batch = !!(row && row.staff_batch === true);
}

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
    if (o.includeType) {
      var rowById = {};
      res[0].rows.forEach(function (r) { rowById[String(r.batch_id)] = r; });
      out.batches.forEach(function (b) { addBatchType(b, rowById[String(b.batch_id)]); });
    }
    return ok(out);
  });
}

/** Every batch in list shape (status all, no token): the reconcile / dedupe index. */
function listAllForIndex(client) {
  return listBatches(client, { status: 'all' }).then(function (res) {
    return res.data.batches;
  });
}

function getBatchDetail(client, batchId, opts) {
  var includeType = !!(opts && opts.includeType);
  if (!batchId) return Promise.resolve(ok(batchRules.buildBatchDetail('', null, [], [], [])));
  return client.query(BATCH_BY_ID_SQL, [String(batchId)]).then(function (res) {
    var row = firstRow(res);
    if (!row) return ok(batchRules.buildBatchDetail(batchId, null, [], [], []));
    return loadChildren(client, row.batch_id).then(function (kids) {
      var detail = batchRules.buildBatchDetail(batchId, row, kids.tasks, kids.readings, kids.history);
      if (includeType && detail.batch) addBatchType(detail.batch, row);
      return ok(detail);
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

function numOrNull(v) {
  if (v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function snapshotString(v) {
  return v === null || v === undefined || typeof v === 'object' ? '' : String(v).trim().slice(0, 120);
}

function snapshotPlato(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'object') return null;
  var n = Number(v);
  return isFinite(n) && n >= 2 && n <= 40 ? n : null;
}

/**
 * Phase 96: pure, tolerant parse of the stored recipe_snapshot text. Never throws; a malformed or
 * non-object snapshot yields empty strings and nulls. OG / target FG are degrees Plato (2..40).
 */
function parseDashSnapshot(text) {
  var out = { recipe_name: '', recipe_style: '', og: null, target_fg: null };
  var snap;
  try { snap = JSON.parse(text); } catch { return out; }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return out;
  out.recipe_name = snapshotString(snap.name);
  out.recipe_style = snapshotString(snap.style);
  out.og = snapshotPlato(snap.og);
  out.target_fg = snapshotPlato(snap.target_fg !== undefined && snap.target_fg !== null ? snap.target_fg : snap.fg);
  return out;
}

/**
 * Phase 94 S1: one lean read for every dashboard widget. Sequential on one client. Subcategory,
 * brand and manufacturer are '' here; lib/batch-store enriches them from the kiosk product cache.
 */
function getDashboardStats(client, opts) {
  var o = opts || {};
  var now = o.now || new Date();
  var tz = o.timezone || DEFAULT_TIMEZONE;
  var out = {};
  return client.query(DASH_STATS_BATCHES_SQL, [tz]).then(function (res) {
    out.batches = res.rows.map(function (r) {
      r.target_volume_l = numOrNull(r.target_volume_l);
      r.product_subcategory = '';
      r.product_brand = '';
      r.product_manufacturer = '';
      return r;
    });
    return client.query(DASH_STATS_TASKS_SQL, [tz]);
  }).then(function (res) {
    out.tasks = res.rows;
    return client.query(DASH_STATS_READINGS_SQL);
  }).then(function (res) {
    out.latestReadings = res.rows.map(function (r) {
      r.degrees_plato = numOrNull(r.degrees_plato);
      r.temperature = numOrNull(r.temperature);
      r.ph = numOrNull(r.ph);
      return r;
    });
    return client.query(DASH_STATS_STAFF_SQL);
  }).then(function (res) {
    out.staffBatchIds = res.rows.map(function (r) { return r.batch_id; });
    return client.query(DASH_STATS_TASK_ROWS_SQL, [tz]);
  }).then(function (res) {
    out.taskRows = res.rows;
    return client.query(DASH_STATS_ALL_READINGS_SQL, [tz]);
  }).then(function (res) {
    out.readings = res.rows.map(function (r) {
      r.degrees_plato = numOrNull(r.degrees_plato);
      r.temperature = numOrNull(r.temperature);
      r.ph = numOrNull(r.ph);
      return r;
    });
    return client.query(DASH_STATS_VESSELS_SQL);
  }).then(function (res) {
    out.vessels = res.rows.map(function (r) {
      return { vessel_id: r.vessel_id, type: r.type, capacity_liters: numOrNull(r.capacity_liters), archived: r.archived === true };
    });
    return client.query(DASH_STATS_BATCH_META_SQL);
  }).then(function (res) {
    out.batchMeta = res.rows.map(function (r) {
      var meta = parseDashSnapshot(r.recipe_snapshot);
      meta.batch_id = r.batch_id;
      meta.has_invoice_link = r.has_invoice_link === true;
      meta.planned_days = numOrNull(r.planned_days);
      return meta;
    });
    return getDashboardSummary(client, { now: now, timezone: tz });
  }).then(function (summary) {
    var today = batchRules.formatDay(now, tz);
    return ok({
      asOf: { today: today, year: Number(today.slice(0, 4)), tz: tz },
      batches: out.batches,
      tasks: out.tasks,
      latestReadings: out.latestReadings,
      staffBatchIds: out.staffBatchIds,
      summary: summary.data,
      taskRows: out.taskRows,
      readings: out.readings,
      vessels: out.vessels,
      batchMeta: out.batchMeta
    });
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
  getDashboardStats: getDashboardStats,
  parseDashSnapshot: parseDashSnapshot,
  getTasksCalendar: getTasksCalendar,
  getTasksUpcoming: getTasksUpcoming,
  findLocationConflict: findLocationConflict,
  lockBatch: lockBatch,
  getBatchBundle: getBatchBundle,
  countByRecipe: countByRecipe,
  countBySchedule: countBySchedule
};

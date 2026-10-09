'use strict';

/**
 * Four-table batch comparator - Phase 87 Plan 14 (DB-06, ROADMAP SC3, D-06).
 *
 * PURE: no I/O, no clock. Shared by scripts/backfill/batches-verify.js (owner-run evidence) and
 * the production drift check (87-15) so both apply exactly the same rules.
 *
 *   normalizeSheetTables(workbookRows, opts) -> {tables, headers, rejects}
 *     workbookRows: {Batches, BatchTasks, PlatoReadings, VesselHistory}, each {headers, rows}
 *     (read-xlsx shape). Rows are normalised by the backfill's own plan builder, so verify and
 *     backfill can never disagree about what a cell means.
 *   compareBatchTables(pgTables, sheetTables) ->
 *     {mismatches:[{table,id,field}], counts:{table:{pg,sheet}}, orphans:{table:n}, headerOk}
 *     pgTables: {batches, batch_tasks, plato_readings, vessel_history} as raw `select *` rows.
 *   summarize(result) -> {ok, mismatchCount, lines}
 *
 * Rules (field by field): booleans normalised, '' equals NULL, text trimmed, dates date-only,
 * timestamps by epoch ms, numbers by value, bin_id as text. unit_seq is Postgres-only (derived at
 * backfill) and never compared. Output carries table, id and field NAMES and counts - never a value.
 */

var backfill = require('../scripts/backfill/batches-backfill');
var batchSpec = require('../scripts/backfill/specs/batches');
var taskSpec = require('../scripts/backfill/specs/batch-tasks');
var readingSpec = require('../scripts/backfill/specs/plato-readings-final');
var historySpec = require('../scripts/backfill/specs/vessel-history-final');

var TABLES = [
  { table: 'batches', sheet: 'Batches', spec: batchSpec, idField: 'batch_id' },
  { table: 'batch_tasks', sheet: 'BatchTasks', spec: taskSpec, idField: 'task_id' },
  { table: 'plato_readings', sheet: 'PlatoReadings', spec: readingSpec, idField: 'reading_id' },
  { table: 'vessel_history', sheet: 'VesselHistory', spec: historySpec, idField: 'history_id' }
];

var HEADER_REASONS = { missing_header: true, unexpected_header: true };

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function text(v) {
  return isEmpty(v) ? '' : String(v).trim();
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// node-pg returns date columns as local-midnight Dates; sheet-side values are 'YYYY-MM-DD'.
function dateOnly(v) {
  if (isEmpty(v)) return '';
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  return String(v).trim().slice(0, 10);
}

function epoch(v) {
  if (isEmpty(v)) return null;
  var t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return isNaN(t) ? 'invalid' : t;
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

function sameNumber(a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  return Number(a) === Number(b);
}

function sameValue(type, a, b) {
  switch (type) {
    case 'date':
      return dateOnly(a) === dateOnly(b);
    case 'timestamptz':
      return epoch(a) === epoch(b);
    case 'number':
    case 'integer':
      return sameNumber(a, b);
    case 'boolean':
      return asBool(a) === asBool(b);
    default:
      return text(a) === text(b);
  }
}

function indexBy(rows, idField) {
  var by = {};
  (rows || []).forEach(function (r) {
    var id = text(r[idField]);
    if (id) by[id] = r;
  });
  return by;
}

/** Normalises the four sheets with the backfill plan builder. Rejects hold no cell values. */
function normalizeSheetTables(workbookRows, opts) {
  var wb = workbookRows || {};
  var plan = backfill.buildBatchesBackfillPlan(wb, { timezone: opts && opts.timezone });
  var headers = {};
  TABLES.forEach(function (t) {
    headers[t.table] = ((wb[t.sheet] && wb[t.sheet].headers) || []).map(function (h) { return String(h).trim(); });
  });
  return { tables: plan.tables, headers: headers, rejects: plan.rejects };
}

function headersMatch(spec, actual) {
  var pinned = spec.columns.map(function (c) { return c.header; });
  if (pinned.length !== actual.length) return false;
  for (var i = 0; i < pinned.length; i++) {
    if (pinned[i] !== actual[i]) return false;
  }
  return true;
}

function compareTable(t, pgRows, shRows, out) {
  var pgBy = indexBy(pgRows, t.idField);
  var shBy = indexBy(shRows, t.idField);

  Object.keys(pgBy).forEach(function (id) {
    var sh = shBy[id];
    if (!sh) {
      out.push({ table: t.table, id: id, field: 'missing_in_sheet' });
      return;
    }
    t.spec.columns.forEach(function (col) {
      if (!sameValue(col.type, pgBy[id][col.name], sh[col.name])) {
        out.push({ table: t.table, id: id, field: col.name });
      }
    });
  });
  Object.keys(shBy).forEach(function (id) {
    if (!pgBy[id]) out.push({ table: t.table, id: id, field: 'missing_in_postgres' });
  });
  return { pg: Object.keys(pgBy).length, sheet: Object.keys(shBy).length };
}

function pgOrphanCount(rows, parentIds) {
  var n = 0;
  (rows || []).forEach(function (r) {
    if (!parentIds[text(r.batch_id)]) n++;
  });
  return n;
}

function compareBatchTables(pgTables, sheetTables) {
  var pg = pgTables || {};
  var sheet = sheetTables || {};
  var shTables = sheet.tables || {};
  var shHeaders = sheet.headers || {};
  var out = [];
  var counts = {};
  var orphans = {};
  var headerOk = true;

  var pgParents = {};
  (pg.batches || []).forEach(function (b) { pgParents[text(b.batch_id)] = true; });

  TABLES.forEach(function (t) {
    if (!headersMatch(t.spec, shHeaders[t.table] || [])) headerOk = false;
    counts[t.table] = compareTable(t, pg[t.table], shTables[t.table], out);
    orphans[t.table] = t.table === 'batches' ? 0 : pgOrphanCount(pg[t.table], pgParents);
  });

  // Rows the backfill normaliser refused: report id + field name only; orphans are counted apart.
  (sheet.rejects || []).forEach(function (r) {
    if (HEADER_REASONS[r.reason]) return; // covered by headerOk
    var t = TABLES.filter(function (x) { return x.sheet === r.sheet; })[0];
    if (!t) return;
    if (r.reason === 'orphan_parent') {
      orphans[t.table]++;
      return;
    }
    out.push({ table: t.table, id: r.id || '(row ' + r.row + ')', field: 'sheet_' + r.reason });
  });

  return { mismatches: out, counts: counts, orphans: orphans, headerOk: headerOk };
}

function summarize(result) {
  var lines = [];
  var ok = result.headerOk;
  lines.push('Headers: ' + (result.headerOk ? 'match' : 'DIFFER'));
  result.mismatches.forEach(function (m) { lines.push(m.table + ' ' + m.id + ' ' + m.field); });
  Object.keys(result.counts).forEach(function (table) {
    var c = result.counts[table];
    var orphanCount = result.orphans[table] || 0;
    if (c.pg !== c.sheet || orphanCount > 0) ok = false;
    lines.push('Counts ' + table + ': postgres ' + c.pg + ', sheet ' + c.sheet +
      (c.pg === c.sheet ? ' (match)' : ' (DIFFER)') + ', orphans ' + orphanCount);
  });
  if (result.mismatches.length > 0) ok = false;
  lines.push(result.mismatches.length + ' mismatches');
  return { ok: ok, mismatchCount: result.mismatches.length, lines: lines };
}

module.exports = {
  TABLES: TABLES,
  compareBatchTables: compareBatchTables,
  normalizeSheetTables: normalizeSheetTables,
  summarize: summarize
};

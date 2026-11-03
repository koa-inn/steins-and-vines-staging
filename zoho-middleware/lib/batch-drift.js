'use strict';

/**
 * Daily Postgres-vs-sheet drift check - Phase 87 Plan 15 (DB-06, D-08, approved Q12).
 *
 * After the BATCHES_STORE flip the sheet tabs are a mirror. This check guards the rollback week:
 * once a day (production only) it pulls export_batch_tabs from Apps Script, normalises it with the
 * same backfill plan builder the verify CLI uses, compares it with Postgres through
 * lib/batch-compare.js and raises Sentry on any mismatch.
 *
 * Output (logs and Sentry) carries counts, table names, ids and field names only - never a value.
 * runDriftCheck never throws: a failure to run is itself reported ('batches drift check failed').
 * Staging never mirrors, so the timer is a no-op unless sheetMirror.isMirrorEnabled() and
 * BATCHES_STORE=postgres.
 */

var DRIFT_INTERVAL_MS = 24 * 60 * 60 * 1000;
var EXPORT_TIMEOUT_MS = 30000;
var DEFAULT_TIMEZONE = 'America/Vancouver';
var SENTRY_TAGS = { component: 'batches-drift' };
var MAX_LOGGED_LINES = 50;

// Constant SQL - nothing here is built from input.
var PG_SQL = {
  batches: 'select * from batches order by length(batch_id), batch_id',
  batch_tasks: 'select * from batch_tasks order by length(task_id), task_id',
  plato_readings: 'select * from plato_readings order by length(reading_id), reading_id',
  vessel_history: 'select * from vessel_history order by length(history_id), history_id'
};

function defaultSentry() {
  return require('@sentry/node');
}

function report(sentry, message, extra) {
  try {
    sentry.captureMessage(message, { level: 'error', tags: SENTRY_TAGS, extra: extra });
  } catch {
    // Telemetry must never break the process.
  }
}

var ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * toSheetDate(raw, timezone) -> 'YYYY-MM-DD' for a JSON date cell, else raw unchanged.
 * Apps Script turns a true date cell into an ISO instant (midnight in the sheet's time zone, as
 * UTC), e.g. 2026-01-15 -> "2026-01-15T08:00:00.000Z". The backfill parser only takes plain dates,
 * so without this every row was rejected and reported missing_in_sheet (2026-11-03).
 */
function toSheetDate(raw, timezone) {
  if (typeof raw !== 'string' || !ISO_INSTANT_RE.test(raw.trim())) return raw;
  var d = new Date(raw.trim());
  if (isNaN(d.getTime())) return raw;
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// export_batch_tabs returns header-keyed objects per tab; the plan builder wants read-xlsx rows.
// Date-only columns are converted from JSON instants back to sheet calendar dates.
function toWorkbookRows(data, tables, timezone) {
  var wb = {};
  tables.forEach(function (t) {
    var rows = (data && data[t.sheet]) || [];
    var dateHeaders = t.spec.columns
      .filter(function (c) { return c.type === 'date'; })
      .map(function (c) { return c.header; });
    wb[t.sheet] = {
      headers: (data && data.headers && data.headers[t.sheet]) || [],
      rows: rows.map(function (values, i) {
        var copy = Object.assign({}, values);
        dateHeaders.forEach(function (h) {
          if (Object.prototype.hasOwnProperty.call(copy, h)) copy[h] = toSheetDate(copy[h], timezone);
        });
        return { rowNumber: i + 2, values: copy };
      })
    };
  });
  return wb;
}

// "sheet rows rejected: N (Batches start_date invalid_date 2, ...)" - sheet, column, reason and
// counts only, never a value. A rejected row is also reported missing_in_sheet by the compare.
function rejectSummary(rejects) {
  var counts = {};
  var order = [];
  rejects.forEach(function (r) {
    var key = [r.sheet || '?', r.field || '?', r.reason || '?'].join(' ');
    if (!counts[key]) { counts[key] = 0; order.push(key); }
    counts[key] += 1;
  });
  return 'sheet rows rejected: ' + rejects.length + ' (' +
    order.map(function (k) { return k + ' ' + counts[k]; }).join(', ') + ')';
}

async function fetchSheetExport(axios, env) {
  var url = env.APPS_SCRIPT_URL;
  var token = env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) throw new Error('APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured');
  // export_batch_tabs lives in doPost's server_token chain (not doGet).
  var res = await axios.post(url, JSON.stringify({ action: 'export_batch_tabs', server_token: token }), {
    headers: { 'Content-Type': 'application/json' },
    timeout: EXPORT_TIMEOUT_MS,
    maxRedirects: 5
  });
  var body = res && res.data;
  if (!body || body.ok !== true || !body.data) throw new Error('export_batch_tabs returned ok:false');
  return body.data;
}

// One read-only transaction, sequential queries on the single client.
function fetchPgTables(withTransaction) {
  return withTransaction(async function (client) {
    await client.query('set transaction read only');
    var out = {};
    var names = Object.keys(PG_SQL);
    for (var i = 0; i < names.length; i++) {
      out[names[i]] = (await client.query(PG_SQL[names[i]])).rows;
    }
    return out;
  });
}

/**
 * runDriftCheck(deps) -> Promise<{ok, mismatchCount?, error?}>. Never throws.
 * deps (all optional, for tests): {axios, withTransaction, sentry, log, env}.
 */
async function runDriftCheck(deps) {
  deps = deps || {};
  var log = deps.log || require('./logger');
  var env = deps.env || process.env;
  var sentry = deps.sentry || defaultSentry();

  try {
    var axios = deps.axios || require('axios');
    var withTransaction = deps.withTransaction || require('./db').withTransaction;
    var batchCompare = require('./batch-compare');

    var exported = await fetchSheetExport(axios, env);
    var pgTables = await fetchPgTables(withTransaction);

    var timezone = env.BATCHES_TIMEZONE || DEFAULT_TIMEZONE;
    var sheetTables = batchCompare.normalizeSheetTables(
      toWorkbookRows(exported, batchCompare.TABLES, timezone),
      { timezone: timezone }
    );
    var result = batchCompare.compareBatchTables(pgTables, sheetTables);
    var summary = batchCompare.summarize(result);

    if (sheetTables.rejects && sheetTables.rejects.length) {
      log.warn('[batches-drift] ' + rejectSummary(sheetTables.rejects));
    }

    if (summary.ok) {
      log.info('[batches-drift] 0 mismatches');
      return { ok: true, mismatchCount: 0 };
    }

    var tables = {};
    result.mismatches.forEach(function (m) { tables[m.table] = (tables[m.table] || 0) + 1; });
    summary.lines.slice(0, MAX_LOGGED_LINES).forEach(function (line) {
      log.warn('[batches-drift] ' + line);
    });
    report(sentry, 'batches drift detected', {
      mismatchCount: summary.mismatchCount,
      tables: tables,
      headerOk: result.headerOk
    });
    return { ok: false, mismatchCount: summary.mismatchCount };
  } catch (err) {
    var message = (err && err.message) || String(err);
    try {
      log.error('[batches-drift] check failed: ' + message);
    } catch {
      // logging must never throw out of the timer
    }
    report(sentry, 'batches drift check failed', { error: message });
    return { ok: false, error: message };
  }
}

/**
 * registerDriftTimer(deps) -> timer handle, or null when not applicable.
 * Production mirror environment AND BATCHES_STORE=postgres only. The handle is unref'd.
 */
function registerDriftTimer(deps) {
  deps = deps || {};
  var sheetMirror = deps.sheetMirror || require('./sheet-mirror');
  var batchFlag = deps.batchFlag || require('./batch-flag');
  var log = deps.log || require('./logger');

  if (!sheetMirror.isMirrorEnabled()) return null;
  if (batchFlag.getMode() !== 'postgres') return null;

  var handle = setInterval(function () {
    runDriftCheck(deps);
  }, DRIFT_INTERVAL_MS);
  if (handle && typeof handle.unref === 'function') handle.unref();
  log.info('[batches-drift] Daily drift check registered: every 24 hours');
  return handle;
}

module.exports = {
  runDriftCheck: runDriftCheck,
  registerDriftTimer: registerDriftTimer,
  toSheetDate: toSheetDate,
  DRIFT_INTERVAL_MS: DRIFT_INTERVAL_MS
};

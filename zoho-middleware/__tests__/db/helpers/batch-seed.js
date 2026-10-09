'use strict';

/**
 * Loads the 87-03 synthetic workbook (invented data) into a real Postgres that has migrations
 * 0001-0005 applied. Shared by the batch read/write real-PG tests (Phase 87).
 *
 * Mirrors the sheet -> PG-shaped conversion in __tests__/batch-rules.test.js: blank dates and
 * timestamps become NULL, schedule_id '' becomes NULL, numerics and bin_id are bound as text,
 * `date` cells are bound as YYYY-MM-DD. Ids are explicit, so the sequences are not advanced.
 */

var workbook = require('../../fixtures/batches/synthetic-workbook');

var DATE_COLS = { start_date: 1, due_date: 1 };
var TS_COLS = {
  created_at: 1, last_updated: 1, last_regenerated_at: 1, fermentation_started_at: 1,
  completed_at: 1, bottling_invite_sent_at: 1, reading_at: 1, transferred_at: 1
};
var NUM_COLS = { target_volume_l: 1, scale_factor: 1, degrees_plato: 1, temperature: 1, ph: 1 };

var TABLES = [
  { sheet: 'Batches', table: 'batches' },
  { sheet: 'BatchTasks', table: 'batch_tasks' },
  { sheet: 'PlatoReadings', table: 'plato_readings' },
  { sheet: 'VesselHistory', table: 'vessel_history' }
];

function ddlName(header) {
  return header === 'timestamp' ? 'reading_at' : header.toLowerCase();
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

function toPgValue(col, v) {
  if (DATE_COLS[col]) {
    if (isBlank(v)) return null;
    return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  }
  if (TS_COLS[col]) {
    if (isBlank(v)) return null;
    return v instanceof Date ? new Date(v.getTime()) : new Date(v);
  }
  if (NUM_COLS[col]) return isBlank(v) ? null : String(v);
  if (col === 'schedule_id') return isBlank(v) ? null : v;
  if (col === 'bin_id') return isBlank(v) ? '' : String(v);
  return v;
}

function insertSheet(client, sheet, table) {
  var headers = workbook.headers[sheet];
  var cols = headers.map(ddlName);
  var placeholders = cols.map(function (c, i) { return '$' + (i + 1); }).join(', ');
  var sql = 'insert into ' + table + ' (' + cols.join(', ') + ') values (' + placeholders + ')';
  var rows = workbook.rows[sheet];
  var chain = Promise.resolve();
  rows.forEach(function (row) {
    chain = chain.then(function () {
      var values = cols.map(function (c, i) { return toPgValue(c, row[i]); });
      return client.query(sql, values);
    });
  });
  return chain;
}

/** Inserts FS-000001 (referenced by the batches) and every synthetic row. */
function seed(client) {
  var at = new Date('2026-01-01T00:00:00.000Z');
  var chain = client.query(
    'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) ' +
    'values ($1, $2, $3::jsonb, $4, $4)',
    ['FS-000001', 'Synthetic schedule', JSON.stringify([]), at]
  );
  TABLES.forEach(function (t) {
    chain = chain.then(function () { return insertSheet(client, t.sheet, t.table); });
  });
  return chain;
}

module.exports = { seed: seed, workbook: workbook };

'use strict';

/**
 * Regression tests for the 2026-11-03 drift false positive. export_batch_tabs sends true date
 * cells as JSON, so a sheet date of 2026-01-15 arrives as "2026-01-15T08:00:00.000Z". The
 * drift check rejected every such row and then reported it as missing_in_sheet.
 */

var batchCompare = require('../lib/batch-compare');
var drift = require('../lib/batch-drift');

var QUIET = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function pinnedHeaders() {
  var h = {};
  batchCompare.TABLES.forEach(function (t) {
    h[t.sheet] = t.spec.columns.map(function (c) { return c.header; });
  });
  return h;
}

function columns(sheet) {
  return batchCompare.TABLES.filter(function (t) { return t.sheet === sheet; })[0].spec.columns;
}

function fakeTx(tablesByName) {
  return function (fn) {
    return fn({
      query: function (sql) {
        if (/^set transaction/.test(sql)) return Promise.resolve({ rows: [] });
        var name = /from (\w+)/.exec(sql)[1];
        return Promise.resolve({ rows: tablesByName[name] || [] });
      }
    });
  };
}

function deps(exported, pg) {
  return {
    axios: { post: jest.fn().mockResolvedValue({ data: { ok: true, data: exported } }) },
    withTransaction: fakeTx(pg),
    sentry: { captureMessage: jest.fn() },
    log: QUIET,
    env: { APPS_SCRIPT_URL: 'https://script.example.invalid/exec', APPS_SCRIPT_SERVER_TOKEN: 'srv' }
  };
}

// One valid sheet batch row, built from the pinned spec so every required column is present.
function sheetBatch(overrides) {
  var row = {};
  columns('Batches').forEach(function (c) { row[c.header] = ''; });
  row.batch_id = 'SV-B-000002';
  row.status = 'complete';
  row.access_token = 'a'.repeat(32);
  row.created_at = '2026-01-15T18:30:00.000Z';
  row.last_updated = '2026-01-20T18:30:00.000Z';
  Object.keys(overrides || {}).forEach(function (k) { row[k] = overrides[k]; });
  return row;
}

function exportWith(batchRows) {
  var data = { headers: pinnedHeaders() };
  batchCompare.TABLES.forEach(function (t) { data[t.sheet] = []; });
  data.Batches = batchRows;
  return data;
}

beforeEach(function () {
  Object.keys(QUIET).forEach(function (k) { QUIET[k].mockClear(); });
});

describe('drift check reads JSON date cells from export_batch_tabs', function () {
  test('toSheetDate turns a JSON date cell into the America/Vancouver calendar date', function () {
    // Midnight Vancouver in winter (UTC-8) and summer (UTC-7) as Apps Script serialises them.
    expect(drift.toSheetDate('2026-01-15T08:00:00.000Z', 'America/Vancouver')).toBe('2026-01-15');
    expect(drift.toSheetDate('2026-07-01T07:00:00.000Z', 'America/Vancouver')).toBe('2026-07-01');
    // Already a plain date, or not a timestamp at all: unchanged.
    expect(drift.toSheetDate('2026-01-15', 'America/Vancouver')).toBe('2026-01-15');
    expect(drift.toSheetDate('not a date', 'America/Vancouver')).toBe('not a date');
    expect(drift.toSheetDate('', 'America/Vancouver')).toBe('');
  });

  test('a batch whose start_date arrives as an ISO timestamp is not reported missing_in_sheet', async function () {
    var exported = exportWith([sheetBatch({ start_date: '2026-01-15T08:00:00.000Z' })]);
    var d = deps(exported, { batches: [{ batch_id: 'SV-B-000002' }] });
    await drift.runDriftCheck(d);
    var logged = QUIET.warn.mock.calls.join('\n');
    expect(logged).not.toContain('SV-B-000002 missing_in_sheet');
    expect(logged).not.toMatch(/start_date.*invalid_date/);
  });

  test('sheet rows that cannot be read are logged as reject counts, with no values', async function () {
    var exported = exportWith([sheetBatch({ start_date: 'Secret garbage', customer_name: 'Secret Name' })]);
    var d = deps(exported, {});
    await drift.runDriftCheck(d);
    var logged = QUIET.warn.mock.calls.join('\n');
    expect(logged).toMatch(/\[batches-drift\] sheet rows rejected: 1 \(Batches start_date invalid_date 1\)/);
    expect(logged).not.toContain('Secret');
  });
});

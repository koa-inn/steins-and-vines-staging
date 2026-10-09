'use strict';

/**
 * Tests for lib/batch-compare.js and scripts/backfill/batches-verify.js - Phase 87 Plan 14.
 * Synthetic fixtures, fake pool and mocked workbook reader: no database, sheet or network.
 */

var fs = require('fs');

jest.mock('../../scripts/backfill/read-xlsx');

var readXlsx = require('../../scripts/backfill/read-xlsx');
var batchCompare = require('../../lib/batch-compare');
var verify = require('../../scripts/backfill/batches-verify');
var batchSpec = require('../../scripts/backfill/specs/batches');
var taskSpec = require('../../scripts/backfill/specs/batch-tasks');
var readingSpec = require('../../scripts/backfill/specs/plato-readings-final');
var historySpec = require('../../scripts/backfill/specs/vessel-history-final');

var TOKEN = 'a'.repeat(32);
var TS = '2026-10-01T10:00:00.000Z';

function headersOf(spec) {
  return spec.columns.map(function (c) { return c.header; });
}

// ── Sheet-side fixture (header-keyed cell values) ──
function sheetBatch(over) {
  return Object.assign({
    batch_id: 'SV-B-000001', status: 'primary', product_sku: 'SKU1', product_name: 'Ale', customer_id: '',
    customer_name: 'Ann', customer_email: 'ann@example.invalid', start_date: '2026-10-01', schedule_id: '',
    schedule_snapshot: '', vessel_id: 'FV-001', shelf_id: 'A', bin_id: 7, notes: '', access_token: TOKEN,
    reservation_id: '', created_at: TS, created_by: 'staff', last_updated: TS, last_regenerated_at: '',
    source: 'kiosk', zoho_so_number: 'SO-1', fermentation_started_at: '', completed_at: '',
    customer_firstname: 'Ann', customer_lastname: 'Lee', recipe_id: '', customer_phone: '',
    target_volume_L: '', scale_factor: 1.5, recipe_snapshot: '', bottling_invite_sent_at: '',
    bottling_invite_email: ''
  }, over || {});
}

function sheetTask(over) {
  return Object.assign({
    task_id: 'BT-000003', batch_id: 'SV-B-000001', step_number: 1, title: 'Pitch yeast', description: '',
    day_offset: 0, due_date: '2026-10-01', is_packaging: 'FALSE', is_transfer: false, completed: 'TRUE',
    completed_at: TS, completed_by: 'staff', notes: '', last_updated: TS
  }, over || {});
}

function sheetReading(over) {
  return Object.assign({
    reading_id: 'PR-000001', batch_id: 'SV-B-000001', timestamp: TS, degrees_plato: 12.5, notes: '',
    recorded_by: 'staff', created_at: TS, temperature: '', ph: ''
  }, over || {});
}

function sheetHistory(over) {
  return Object.assign({
    history_id: 'VH-000001', batch_id: 'SV-B-000001', vessel_id: 'FV-001', shelf_id: 'A', bin_id: 7,
    transferred_at: TS, transferred_by: 'staff', notes: ''
  }, over || {});
}

function sheet(spec, rows, headers) {
  return {
    headers: headers || headersOf(spec),
    rows: rows.map(function (v, i) { return { rowNumber: i + 2, values: v }; })
  };
}

function workbook(over) {
  over = over || {};
  return {
    Batches: over.Batches || sheet(batchSpec, [sheetBatch()]),
    BatchTasks: over.BatchTasks || sheet(taskSpec, [sheetTask()]),
    PlatoReadings: over.PlatoReadings || sheet(readingSpec, [sheetReading()]),
    VesselHistory: over.VesselHistory || sheet(historySpec, [sheetHistory()])
  };
}

// ── Postgres-side fixture (DDL columns, node-pg value types) ──
function pgBatch(over) {
  return Object.assign({
    batch_id: 'SV-B-000001', status: 'primary', product_sku: 'SKU1', product_name: 'Ale', customer_id: '',
    customer_name: 'Ann', customer_email: 'ann@example.invalid', start_date: new Date(2026, 9, 1),
    schedule_id: null, schedule_snapshot: '', vessel_id: 'FV-001', shelf_id: 'A', bin_id: '7', notes: '',
    access_token: TOKEN, reservation_id: '', created_at: new Date(TS), created_by: 'staff',
    last_updated: new Date(TS), last_regenerated_at: null, source: 'kiosk', zoho_so_number: 'SO-1',
    fermentation_started_at: null, completed_at: null, customer_firstname: 'Ann', customer_lastname: 'Lee',
    recipe_id: '', customer_phone: '', target_volume_l: null, scale_factor: '1.50', recipe_snapshot: '',
    bottling_invite_sent_at: null, bottling_invite_email: '', unit_seq: 1
  }, over || {});
}

function pgTask(over) {
  return Object.assign({
    task_id: 'BT-000003', batch_id: 'SV-B-000001', step_number: 1, title: 'Pitch yeast', description: '',
    day_offset: 0, due_date: new Date(2026, 9, 1), is_packaging: false, is_transfer: false, completed: true,
    completed_at: new Date(TS), completed_by: 'staff', notes: '', last_updated: new Date(TS)
  }, over || {});
}

function pgReading(over) {
  return Object.assign({
    reading_id: 'PR-000001', batch_id: 'SV-B-000001', reading_at: new Date(TS), degrees_plato: '12.50',
    notes: '', recorded_by: 'staff', created_at: new Date(TS), temperature: null, ph: null
  }, over || {});
}

function pgHistory(over) {
  return Object.assign({
    history_id: 'VH-000001', batch_id: 'SV-B-000001', vessel_id: 'FV-001', shelf_id: 'A', bin_id: '7',
    transferred_at: new Date(TS), transferred_by: 'staff', notes: ''
  }, over || {});
}

function pgTables(over) {
  over = over || {};
  return {
    batches: over.batches || [pgBatch()],
    batch_tasks: over.batch_tasks || [pgTask()],
    plato_readings: over.plato_readings || [pgReading()],
    vessel_history: over.vessel_history || [pgHistory()]
  };
}

function run(pgOver, wbOver) {
  var sheetTables = batchCompare.normalizeSheetTables(workbook(wbOver), { timezone: 'America/Vancouver' });
  return batchCompare.compareBatchTables(pgTables(pgOver), sheetTables);
}

describe('compareBatchTables', function () {
  it('identical synthetic data: no mismatches, equal counts, headers ok', function () {
    var r = run();
    expect(r.mismatches).toEqual([]);
    expect(r.headerOk).toBe(true);
    Object.keys(r.counts).forEach(function (t) { expect(r.counts[t].pg).toBe(r.counts[t].sheet); });
    expect(r.counts.batches).toEqual({ pg: 1, sheet: 1 });
    expect(r.orphans).toEqual({ batches: 0, batch_tasks: 0, plato_readings: 0, vessel_history: 0 });
    expect(batchCompare.summarize(r).ok).toBe(true);
  });

  it('a changed task title is exactly one mismatch line and the title is never printed', function () {
    var r = run({}, { BatchTasks: sheet(taskSpec, [sheetTask({ title: 'SECRET-TITLE-XYZ' })]) });
    expect(r.mismatches).toEqual([{ table: 'batch_tasks', id: 'BT-000003', field: 'title' }]);
    var s = batchCompare.summarize(r);
    expect(s.ok).toBe(false);
    expect(s.lines).toContain('batch_tasks BT-000003 title');
    expect(s.lines.join('\n')).not.toMatch(/SECRET-TITLE-XYZ|Pitch yeast/);
  });

  it('treats blank vs NULL, 12.50 vs 12.5, TRUE vs true, Date cell vs PG date, bin 7 vs "7" as equal', function () {
    var r = run(
      { plato_readings: [pgReading({ degrees_plato: '12.50' })] },
      {
        PlatoReadings: sheet(readingSpec, [sheetReading({ degrees_plato: 12.5, temperature: '', ph: null })]),
        BatchTasks: sheet(taskSpec, [sheetTask({ completed: 'TRUE', due_date: new Date(Date.UTC(2026, 9, 1)) })]),
        VesselHistory: sheet(historySpec, [sheetHistory({ bin_id: 7 })])
      }
    );
    expect(r.mismatches).toEqual([]);
    var r2 = run({ batch_tasks: [pgTask({ completed: true })] }, { BatchTasks: sheet(taskSpec, [sheetTask({ completed: true })]) });
    expect(r2.mismatches).toEqual([]);
  });

  it('compares timestamps by epoch ms (same instant, different offset text)', function () {
    var r = run({}, { Batches: sheet(batchSpec, [sheetBatch({ created_at: '2026-10-01T03:00:00.000-07:00' })]) });
    expect(r.mismatches).toEqual([]);
    var off = run({}, { Batches: sheet(batchSpec, [sheetBatch({ created_at: '2026-10-01T10:00:00.001Z' })]) });
    expect(off.mismatches).toEqual([{ table: 'batches', id: 'SV-B-000001', field: 'created_at' }]);
  });

  it('an extra row in Postgres only differs in counts and the id is reported', function () {
    var r = run({ batch_tasks: [pgTask(), pgTask({ task_id: 'BT-000009', step_number: 2 })] });
    expect(r.counts.batch_tasks).toEqual({ pg: 2, sheet: 1 });
    expect(r.mismatches).toEqual([{ table: 'batch_tasks', id: 'BT-000009', field: 'missing_in_sheet' }]);
    var s = batchCompare.summarize(r);
    expect(s.ok).toBe(false);
    expect(s.lines.join('\n')).toMatch(/Counts batch_tasks: postgres 2, sheet 1 \(DIFFER\)/);
  });

  it('a row only on the sheet is reported as missing_in_postgres', function () {
    var r = run({}, { PlatoReadings: sheet(readingSpec, [sheetReading(), sheetReading({ reading_id: 'PR-000005' })]) });
    expect(r.mismatches).toEqual([{ table: 'plato_readings', id: 'PR-000005', field: 'missing_in_postgres' }]);
  });

  it('counts a sheet child whose batch is missing as an orphan', function () {
    var r = run({}, { VesselHistory: sheet(historySpec, [sheetHistory(), sheetHistory({ history_id: 'VH-000002', batch_id: 'SV-B-000099' })]) });
    expect(r.orphans.vessel_history).toBe(1);
    expect(batchCompare.summarize(r).ok).toBe(false);
  });

  it('counts a Postgres child whose batch is missing as an orphan', function () {
    var r = run({ batch_tasks: [pgTask(), pgTask({ task_id: 'BT-000010', batch_id: 'SV-B-000077' })] });
    expect(r.orphans.batch_tasks).toBe(1);
    expect(batchCompare.summarize(r).ok).toBe(false);
  });

  it('a Batches header row that differs from the pinned 33 list is headerOk false', function () {
    var headers = headersOf(batchSpec).slice();
    headers[3] = 'product_nam';
    var r = run({}, { Batches: sheet(batchSpec, [sheetBatch()], headers) });
    expect(r.headerOk).toBe(false);
    expect(batchCompare.summarize(r).ok).toBe(false);
  });

  it('a sheet row the backfill normaliser refuses is a field-name-only mismatch', function () {
    var r = run({}, { PlatoReadings: sheet(readingSpec, [sheetReading({ degrees_plato: 'not-a-number-VALUE' })]) });
    expect(r.mismatches).toEqual(expect.arrayContaining([
      { table: 'plato_readings', id: 'PR-000001', field: 'sheet_invalid_number' }
    ]));
    expect(JSON.stringify(r)).not.toMatch(/not-a-number-VALUE/);
  });
});

describe('parseArgs', function () {
  it('accepts --file and --timezone, refuses Postgres URLs and unknown flags', function () {
    expect(verify.parseArgs(['--file=/tmp/a.xlsx']).file).toBe('/tmp/a.xlsx');
    expect(function () { verify.parseArgs(['--db=postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { verify.parseArgs(['--nope=1']); }).toThrow(/unknown flag/);
  });
});

describe('runBatchesVerify', function () {
  function fakePool(tables) {
    var queries = [];
    var client = {
      query: jest.fn(function (sql) {
        queries.push(sql);
        if (/^(begin transaction read only|commit|rollback)$/.test(sql)) return Promise.resolve({ rows: [] });
        var m = /^select \* from (\w+) /.exec(sql);
        if (m && tables[m[1]]) return Promise.resolve({ rows: tables[m[1]] });
        return Promise.reject(new Error('unexpected query: ' + sql));
      }),
      release: jest.fn()
    };
    return { queries: queries, connect: jest.fn(function () { return Promise.resolve(client); }) };
  }

  function mockWorkbook(wb) {
    readXlsx.readSheet.mockImplementation(function (file, name) { return Promise.resolve(wb[name]); });
  }

  beforeEach(function () {
    readXlsx.readSheet.mockReset();
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
  });

  afterEach(function () {
    jest.restoreAllMocks();
  });

  it('exits 0 on identical data inside a read-only transaction that never writes', async function () {
    mockWorkbook(workbook());
    var pool = fakePool(pgTables());
    var lines = [];
    var out = await verify.runBatchesVerify({ file: '/tmp/fresh.xlsx' }, { pool: pool, log: function (l) { lines.push(l); } });
    expect(out.exitCode).toBe(0);
    expect(pool.queries[0]).toBe('begin transaction read only');
    expect(pool.queries[pool.queries.length - 1]).toBe('commit');
    expect(pool.queries.some(function (q) { return /\b(insert|update|delete)\b/i.test(q); })).toBe(false);
    expect(lines).toContain('0 mismatches');
  });

  it('exits 4 on a mismatch and prints the field, never the value or an email', async function () {
    mockWorkbook(workbook({ BatchTasks: sheet(taskSpec, [sheetTask({ title: 'LEAKY-TITLE' })]) }));
    var lines = [];
    var out = await verify.runBatchesVerify({ file: '/tmp/fresh.xlsx' }, { pool: fakePool(pgTables()), log: function (l) { lines.push(l); } });
    expect(out.exitCode).toBe(4);
    expect(lines).toContain('batch_tasks BT-000003 title');
    expect(lines.join('\n')).not.toMatch(/LEAKY-TITLE|@/);
  });

  it('exits 4 when a header row differs', async function () {
    var headers = headersOf(batchSpec).slice();
    headers[0] = 'batchid';
    mockWorkbook(workbook({ Batches: sheet(batchSpec, [sheetBatch()], headers) }));
    var out = await verify.runBatchesVerify({ file: '/tmp/fresh.xlsx' }, { pool: fakePool(pgTables()), log: function () {} });
    expect(out.exitCode).toBe(4);
  });

  it('refuses a snapshot path inside the repo with exit 1', async function () {
    var logged = [];
    var out = await verify.runBatchesVerify(
      { file: require('path').join(__dirname, '..', '..', 'snapshot.xlsx') },
      { pool: fakePool(pgTables()), log: function (l) { logged.push(l); } }
    );
    expect(out.exitCode).toBe(1);
    expect(readXlsx.readSheet).not.toHaveBeenCalled();
  });
});

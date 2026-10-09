'use strict';

/**
 * Pure plan builder tests for the batches backfill (Phase 87 Plan 05). Synthetic data only.
 */

var plan = require('../../scripts/backfill/batches-backfill');
var batchSpec = require('../../scripts/backfill/specs/batches');
var taskSpec = require('../../scripts/backfill/specs/batch-tasks');
var readingSpec = require('../../scripts/backfill/specs/plato-readings-final');
var historySpec = require('../../scripts/backfill/specs/vessel-history-final');

function headers(spec) {
  return spec.columns.map(function (c) { return c.header; });
}

function sheet(spec, rows, extraHeaders) {
  var h = headers(spec).concat(extraHeaders || []);
  return {
    headers: h,
    rows: rows.map(function (values, i) {
      var full = {};
      h.forEach(function (name) { full[name] = values[name] !== undefined ? values[name] : ''; });
      return { rowNumber: i + 2, values: full };
    })
  };
}

function tok(n) {
  var s = String(n);
  while (s.length < 32) s = 'a' + s;
  return s;
}

function batch(n, overrides) {
  var id = 'SV-B-' + ('000000' + n).slice(-6);
  return Object.assign({
    batch_id: id, status: 'primary', product_sku: 'K1', product_name: 'Pale Ale', customer_name: 'Test Person',
    start_date: new Date(Date.UTC(2026, 0, 5)), access_token: tok(n), created_at: '2026-01-01T10:00:00Z',
    last_updated: '2026-01-02T10:00:00Z', source: 'manual', bin_id: 7
  }, overrides || {});
}

function task(n, batchId, overrides) {
  return Object.assign({
    task_id: 'BT-' + ('000000' + n).slice(-6), batch_id: batchId, step_number: n, title: 'Step', day_offset: 0,
    due_date: new Date(Date.UTC(2026, 0, 6)), is_packaging: false, is_transfer: 'FALSE', completed: true,
    last_updated: '2026-01-03T10:00:00Z'
  }, overrides || {});
}

function reading(n, batchId, overrides) {
  return Object.assign({
    reading_id: 'PR-' + ('000000' + n).slice(-6), batch_id: batchId, timestamp: new Date(Date.UTC(2026, 0, 7, 9, 30)),
    degrees_plato: 12.5, created_at: '2026-01-07T17:30:00Z', temperature: 18.25, ph: ''
  }, overrides || {});
}

function hist(n, batchId, overrides) {
  return Object.assign({
    history_id: 'VH-' + ('000000' + n).slice(-6), batch_id: batchId, vessel_id: 'FV-001', bin_id: 7,
    transferred_at: '2026-01-05T10:00:00Z'
  }, overrides || {});
}

function workbook(parts) {
  parts = parts || {};
  return {
    Batches: sheet(batchSpec, parts.batches || [], parts.batchExtra),
    BatchTasks: sheet(taskSpec, parts.tasks || []),
    PlatoReadings: sheet(readingSpec, parts.readings || []),
    VesselHistory: sheet(historySpec, parts.history || [])
  };
}

function clean() {
  return workbook({
    batches: [batch(1), batch(7)],
    tasks: [task(1, 'SV-B-000001'), task(2, 'SV-B-000007')],
    readings: [reading(3, 'SV-B-000001')],
    history: [hist(9, 'SV-B-000007')]
  });
}

describe('buildBatchesBackfillPlan', function () {
  test('clean plan: no rejects, per-table counts and sequence seeds', function () {
    var p = plan.buildBatchesBackfillPlan(clean(), {});
    expect(p.rejects).toEqual([]);
    expect(p.counts).toEqual({ batches: 2, batch_tasks: 2, plato_readings: 1, vessel_history: 1 });
    expect(p.seeds).toEqual({
      batch_id_seq: 7, batch_task_id_seq: 2, plato_reading_id_seq: 3, vessel_history_id_seq: 9
    });
  });

  test('values are converted: bin_id text, dates, wall-clock timestamps, numerics as text, booleans', function () {
    var p = plan.buildBatchesBackfillPlan(clean(), { timezone: 'America/Vancouver' });
    var b = p.tables.batches[0];
    expect(b.bin_id).toBe('7');
    expect(b.start_date).toBe('2026-01-05');
    expect(b.schedule_id).toBeNull();
    expect(b.target_volume_l).toBeNull();
    expect(b.notes).toBe('');
    var t = p.tables.batch_tasks[0];
    expect(t.due_date).toBe('2026-01-06');
    expect(t.is_transfer).toBe(false);
    expect(t.is_packaging).toBe(false);
    expect(t.completed).toBe(true);
    var r = p.tables.plato_readings[0];
    // 09:30 wall clock in Vancouver (PST, UTC-8) is 17:30Z
    expect(r.reading_at).toBe('2026-01-07T17:30:00.000Z');
    expect(r.degrees_plato).toBe('12.5');
    expect(r.temperature).toBe('18.25');
    expect(r.ph).toBeNull();
    expect(p.tables.vessel_history[0].bin_id).toBe('7');
  });

  test('target_volume_L header maps to target_volume_l and keeps full precision', function () {
    var wb = workbook({ batches: [batch(1, { target_volume_L: 19.5, scale_factor: '1.538461' })] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([]);
    expect(p.tables.batches[0].target_volume_l).toBe('19.5');
    expect(p.tables.batches[0].scale_factor).toBe('1.538461');
  });

  test('blank batch_id tail rows are skipped, not rejected or counted', function () {
    var wb = workbook({ batches: [batch(1), { status: '', notes: '' }, {}] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([]);
    expect(p.counts.batches).toBe(1);
  });

  test('orphan task is rejected with sheet/row/id/field/reason and no cell value', function () {
    var wb = workbook({ batches: [batch(1)], tasks: [task(567, 'SV-B-000108', { title: 'SECRET TITLE' })] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'BatchTasks', row: 2, id: 'BT-000567', field: 'batch_id', reason: 'orphan_parent' }
    ]);
    expect(JSON.stringify(p.rejects)).not.toMatch(/SECRET|SV-B-000108/);
    expect(p.counts.batch_tasks).toBe(0);
  });

  test('unknown status, non-hex token and bad id format are rejected', function () {
    var wb = workbook({
      batches: [
        batch(1, { status: 'active' }),
        batch(2, { access_token: 'ZZ' + tok(2).slice(2) }),
        batch(3, { batch_id: 'SV-B-12' })
      ]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    var byField = p.rejects.map(function (r) { return r.field + ':' + r.reason; });
    expect(byField).toEqual(['status:invalid_status', 'access_token:invalid_token', 'batch_id:invalid_id']);
    expect(p.counts.batches).toBe(0);
  });

  test('duplicate batch_id and duplicate token reject the later occurrence', function () {
    var wb = workbook({
      batches: [batch(1), batch(1, { access_token: tok(99) }), batch(2, { access_token: tok(1) })]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'Batches', row: 3, id: 'SV-B-000001', field: 'batch_id', reason: 'duplicate_id' },
      { sheet: 'Batches', row: 4, id: 'SV-B-000002', field: 'access_token', reason: 'duplicate_token' }
    ]);
    expect(p.counts.batches).toBe(1);
  });

  test('non-numeric plato, day_offset and step_number are rejected', function () {
    var wb = workbook({
      batches: [batch(1)],
      tasks: [task(1, 'SV-B-000001', { day_offset: 'soon' }), task(2, 'SV-B-000001', { step_number: 1.5 })],
      readings: [reading(1, 'SV-B-000001', { degrees_plato: 'abc' })]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects.map(function (r) { return r.sheet + '.' + r.field + ':' + r.reason; })).toEqual([
      'BatchTasks.day_offset:invalid_number',
      'BatchTasks.step_number:invalid_number',
      'PlatoReadings.degrees_plato:invalid_number'
    ]);
  });

  test('bad timestamps and dates are rejected', function () {
    var wb = workbook({
      batches: [batch(1, { created_at: 'yesterday', start_date: '2026-02-31' })],
      history: []
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects.map(function (r) { return r.field + ':' + r.reason; })).toEqual([
      'start_date:invalid_date', 'created_at:invalid_timestamp'
    ]);
  });

  test('missing required cell is a required reject', function () {
    var wb = workbook({ batches: [batch(1, { last_updated: '' })] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'Batches', row: 2, id: 'SV-B-000001', field: 'last_updated', reason: 'required' }
    ]);
  });

  test('duplicate (batch_id, step_number) task pairs are both accepted', function () {
    var wb = workbook({
      batches: [batch(1)],
      tasks: [task(1, 'SV-B-000001', { step_number: 3 }), task(2, 'SV-B-000001', { step_number: 3 })]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([]);
    expect(p.counts.batch_tasks).toBe(2);
  });

  test('unit_seq follows created_at then batch_id per invoice+sku; null without both', function () {
    var wb = workbook({
      batches: [
        batch(5, { zoho_so_number: 'INV-1', product_sku: 'K1', created_at: '2026-01-02T10:00:00Z' }),
        batch(4, { zoho_so_number: 'INV-1', product_sku: 'K1', created_at: '2026-01-01T10:00:00Z' }),
        batch(6, { zoho_so_number: 'INV-1', product_sku: 'K2', created_at: '2026-01-01T10:00:00Z' }),
        batch(7, { zoho_so_number: 'INV-1', product_sku: '' }),
        batch(8, { zoho_so_number: '', product_sku: 'K1' })
      ]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    var seq = {};
    p.tables.batches.forEach(function (b) { seq[b.batch_id] = b.unit_seq; });
    expect(seq).toEqual({
      'SV-B-000005': 2, 'SV-B-000004': 1, 'SV-B-000006': 1, 'SV-B-000007': null, 'SV-B-000008': null
    });
  });

  test('equal created_at ties break by batch_id', function () {
    var wb = workbook({
      batches: [
        batch(2, { zoho_so_number: 'INV-9', product_sku: 'K1' }),
        batch(1, { zoho_so_number: 'INV-9', product_sku: 'K1' })
      ]
    });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    var seq = {};
    p.tables.batches.forEach(function (b) { seq[b.batch_id] = b.unit_seq; });
    expect(seq).toEqual({ 'SV-B-000001': 1, 'SV-B-000002': 2 });
  });

  test('unexpected header with a customer name is redacted and never echoed', function () {
    var wb = workbook({ batches: [batch(1)], batchExtra: ['Jane Q. Customer, 604-555-0100'] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'Batches', row: null, id: null, field: '<redacted header>', reason: 'unexpected_header' }
    ]);
    expect(JSON.stringify(p)).not.toMatch(/Jane|604/);
    expect(p.counts.batches).toBe(0);
  });

  test('a plain identifier-like unexpected header is named', function () {
    var wb = workbook({ batches: [batch(1)], batchExtra: ['extra_col'] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'Batches', row: null, id: null, field: 'extra_col', reason: 'unexpected_header' }
    ]);
  });

  test('a missing header is a missing_header reject and the sheet is not planned', function () {
    var wb = clean();
    wb.BatchTasks.headers = wb.BatchTasks.headers.filter(function (h) { return h !== 'title'; });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toEqual([
      { sheet: 'BatchTasks', row: null, id: null, field: 'title', reason: 'missing_header' }
    ]);
    expect(p.counts.batch_tasks).toBe(0);
  });

  test('reject records never contain a cell value from a bad row', function () {
    var wb = workbook({ batches: [batch(1, { status: 'TOPSECRETSTATUS', customer_name: 'Jane Customer' })] });
    var p = plan.buildBatchesBackfillPlan(wb, {});
    expect(p.rejects).toHaveLength(1);
    expect(JSON.stringify(p.rejects)).not.toMatch(/TOPSECRET|Jane/);
  });
});

describe('parseArgs', function () {
  test('refuses a Postgres URL in argv', function () {
    expect(function () { plan.parseArgs(['--file=x.xlsx', 'postgres://u:p@h/db']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { plan.parseArgs(['--out-dir=postgresql://u:p@h/db']); }).toThrow(/BACKFILL_DATABASE_URL/);
  });

  test('rejects unknown flags and parses equals-form flags', function () {
    expect(function () { plan.parseArgs(['--bogus']); }).toThrow(/unknown flag/);
    var o = plan.parseArgs(['--file=a.xlsx', '--timezone=UTC', '--dry-run']);
    expect(o.file).toBe('a.xlsx');
    expect(o.timezone).toBe('UTC');
    expect(o.dryRun).toBe(true);
    expect(o.promote).toBe(false);
  });
});

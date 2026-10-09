'use strict';

// Phase 87-03: lib/batch-rules.js must reproduce every golden.json entry (the real adminApi.gs
// batch reads run over the synthetic workbook by tests/frontend/adminapi-batch-golden.test.js)
// from the same rows expressed the way Postgres returns them.

var crypto = require('crypto');
var rules = require('../lib/batch-rules');
var workbook = require('./fixtures/batches/synthetic-workbook');
var golden = require('./fixtures/batches/golden.json');

// ─── Sheet row -> PG-shaped row adapter ────────────────────────────────────

var DATE_COLS = { start_date: 1, due_date: 1 };
var TS_COLS = {
  created_at: 1, last_updated: 1, last_regenerated_at: 1, fermentation_started_at: 1, completed_at: 1,
  bottling_invite_sent_at: 1, timestamp: 1, transferred_at: 1
};
var NUM_COLS = { target_volume_l: 1, scale_factor: 1, degrees_plato: 1, temperature: 1, ph: 1 };
var NULLABLE_TEXT = { schedule_id: 1 };

function ddlName(header) {
  return header === 'timestamp' ? 'reading_at' : header.toLowerCase();
}

// node-pg returns `date` as a local-midnight Date, timestamptz as Date, numeric as string.
function toPgValue(header, v) {
  var col = ddlName(header);
  var blank = v === '' || v === null || v === undefined;
  if (col === 'reading_at') return new Date(v instanceof Date ? v.getTime() : v);
  if (DATE_COLS[col]) {
    if (blank) return null;
    var iso = v instanceof Date ? v.toISOString() : String(v);
    return new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  }
  if (TS_COLS[header]) {
    if (blank) return null;
    return v instanceof Date ? new Date(v.getTime()) : new Date(v);
  }
  if (NUM_COLS[col]) return blank ? null : String(v);
  if (NULLABLE_TEXT[col]) return blank ? null : v;
  if (col === 'bin_id') return blank ? '' : String(v);
  if (typeof v === 'number' && (col === 'step_number' || col === 'day_offset')) return v;
  return v;
}

function toPgRows(name) {
  var headers = workbook.headers[name];
  return workbook.rows[name].map(function (r) {
    var o = {};
    headers.forEach(function (h, i) { o[ddlName(h)] = toPgValue(h, r[i]); });
    return o;
  });
}

var BATCHES = toPgRows('Batches');
var TASKS = toPgRows('BatchTasks');
var READINGS = toPgRows('PlatoReadings');
var HISTORY = toPgRows('VesselHistory');
var CLOCK = { now: workbook.now, timezone: workbook.timezone };

function forBatch(rows, id) { return rows.filter(function (r) { return r.batch_id === id; }); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function tokenFor(n) {
  var s = String(n);
  while (s.length < 32) s = 'a' + s;
  return s;
}

// ─── Golden parity ─────────────────────────────────────────────────────────

describe('golden.json parity (real adminApi.gs output vs pure rules)', function () {
  var counts = rules.taskCountsByBatch(TASKS);

  test('golden covers every call family', function () {
    var keys = Object.keys(golden);
    ['getBatches', 'getBatchDetail', 'handleGetBatchPublic', 'getTasksCalendar', 'getTasksUpcoming',
      'getBatchDashboardSummary', 'checkLocationConflict', 'batchDedupDecision'].forEach(function (family) {
      expect(keys.some(function (k) { return k.indexOf(family) === 0; })).toBe(true);
    });
  });

  describe('getBatches', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('getBatches:') === 0; }).forEach(function (key) {
      test(key, function () {
        var p = key.split(':');
        var out = rules.buildBatchList(BATCHES, counts, { limit: Number(p[1]), offset: Number(p[2]), status: p[3] });
        expect(plain(out)).toEqual(golden[key]);
      });
    });

    test('lists never carry access_token', function () {
      var out = rules.buildBatchList(BATCHES, counts, { status: 'all' });
      out.batches.forEach(function (b) { expect(b).not.toHaveProperty('access_token'); });
    });
  });

  describe('getBatchDetail', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('getBatchDetail:') === 0; }).forEach(function (key) {
      test(key, function () {
        var id = key.slice('getBatchDetail:'.length);
        var batch = BATCHES.filter(function (b) { return b.batch_id === id; })[0] || null;
        var out = rules.buildBatchDetail(id, batch, forBatch(TASKS, id), forBatch(READINGS, id), forBatch(HISTORY, id));
        expect(plain(out)).toEqual(golden[key]);
      });
    });

    test('detail keeps access_token', function () {
      var out = rules.buildBatchDetail('SV-B-000001', BATCHES[0], forBatch(TASKS, 'SV-B-000001'), [], []);
      expect(out.batch.access_token).toBe(tokenFor(1));
    });
  });

  describe('handleGetBatchPublic', function () {
    var CASES = {
      'valid': ['SV-B-000001', tokenFor(1)],
      'valid-duplicate-steps': ['SV-B-000002', tokenFor(2)],
      'valid-pending': ['SV-B-000005', tokenFor(5)],
      'wrong-token': ['SV-B-000001', tokenFor(2)],
      'malformed-token': ['SV-B-000001', 'abc123'],
      'malformed-batch-id': ['SV-B-1', tokenFor(1)],
      'missing-token': ['SV-B-000001', ''],
      'disabled': ['SV-B-000009', tokenFor(9)],
      'unknown-batch': ['SV-B-000099', tokenFor(1)]
    };
    Object.keys(CASES).forEach(function (name) {
      test(name, function () {
        var id = CASES[name][0];
        var batch = BATCHES.filter(function (b) { return b.batch_id === id; })[0] || null;
        var out = rules.buildPublicView(id, CASES[name][1], batch, forBatch(TASKS, id), forBatch(READINGS, id), forBatch(HISTORY, id));
        expect(plain(out)).toEqual(golden['handleGetBatchPublic:' + name]);
      });
    });

    test('every golden public key has a case', function () {
      Object.keys(golden).filter(function (k) { return k.indexOf('handleGetBatchPublic:') === 0; }).forEach(function (k) {
        expect(CASES).toHaveProperty(k.slice('handleGetBatchPublic:'.length));
      });
    });

    test('public view strips only customer_email, reservation_id and access_token', function () {
      var full = rules.serializeBatch(BATCHES[0]);
      var pub = rules.stripForPublic(full);
      expect(Object.keys(full).filter(function (k) { return !(k in pub); }).sort())
        .toEqual(['access_token', 'customer_email', 'reservation_id']);
      expect(pub.customer_phone).toBe('555-0100');
    });
  });

  describe('getTasksCalendar / getTasksUpcoming', function () {
    var RANGES = {
      'month': ['2026-10-01', '2026-10-31'],
      'week': ['2026-10-11', '2026-10-17'],
      'wide': ['2026-01-01', '2026-12-31'],
      'missing-end': ['2026-10-01', ''],
      'missing-start': ['', '2026-10-31']
    };
    Object.keys(RANGES).forEach(function (name) {
      test('getTasksCalendar:' + name, function () {
        expect(plain(rules.buildCalendar(TASKS, BATCHES, RANGES[name][0], RANGES[name][1])))
          .toEqual(golden['getTasksCalendar:' + name]);
      });
    });

    [50, 2].forEach(function (limit) {
      test('getTasksUpcoming:' + limit, function () {
        expect(plain(rules.buildUpcoming(TASKS, BATCHES, limit))).toEqual(golden['getTasksUpcoming:' + limit]);
      });
    });
  });

  test('getBatchDashboardSummary', function () {
    expect(plain(rules.buildDashboardSummary({ batches: BATCHES, tasks: TASKS }, CLOCK)))
      .toEqual(golden['getBatchDashboardSummary']);
  });

  describe('checkLocationConflict', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('checkLocationConflict:') === 0; }).forEach(function (key) {
      test(key, function () {
        var i = golden[key].input;
        expect(rules.findLocationConflict(BATCHES, i.vessel_id, i.shelf_id, i.bin_id, i.exclude))
          .toBe(golden[key].result);
      });
    });
  });

  describe('batchDedupDecision', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('batchDedupDecision:') === 0; }).forEach(function (key) {
      test(key, function () {
        var out = rules.dedupDecision(BATCHES, golden[key].input);
        expect(plain(out)).toEqual(golden[key].result);
      });
    });
  });
});

// ─── Serializers ───────────────────────────────────────────────────────────

describe('serializers', function () {
  test('column lists match the real sheet headers', function () {
    expect(rules.BATCH_COLUMNS).toEqual(workbook.headers.Batches);
    expect(rules.TASK_COLUMNS).toEqual(workbook.headers.BatchTasks);
    expect(rules.READING_COLUMNS).toEqual(workbook.headers.PlatoReadings);
    expect(rules.HISTORY_COLUMNS).toEqual(workbook.headers.VesselHistory);
  });

  test('serializeBatch emits sheet header keys in header order, NULL as empty string', function () {
    var out = rules.serializeBatch(BATCHES[5]); // pending, mostly blank
    expect(Object.keys(out)).toEqual(workbook.headers.Batches);
    expect(out.start_date).toBe('');
    expect(out.schedule_id).toBe('');
    expect(out.target_volume_L).toBe('');
    expect(out.fermentation_started_at).toBe('');
  });

  test('DDL target_volume_l maps back to the sheet key target_volume_L', function () {
    var out = rules.serializeBatch(BATCHES[0]);
    expect(out.target_volume_L).toBe(23);
    expect(out).not.toHaveProperty('target_volume_l');
    expect(out.scale_factor).toBe(1.15);
  });

  test('bin_id is a JSON number when numeric and text otherwise (Q4)', function () {
    expect(rules.serializeBatch({ bin_id: '12' }).bin_id).toBe(12);
    expect(rules.serializeBatch({ bin_id: 'B3' }).bin_id).toBe('B3');
    expect(rules.serializeBatch({ bin_id: '' }).bin_id).toBe('');
    expect(rules.serializeBatch({ bin_id: null }).bin_id).toBe('');
  });

  test('start_date is YYYY-MM-DD and timestamps are ISO', function () {
    var out = rules.serializeBatch(BATCHES[0]);
    expect(out.start_date).toBe('2026-10-05');
    expect(out.created_at).toBe('2026-10-05T18:00:00.123Z');
    expect(rules.serializeBatch({ start_date: '2026-03-04' }).start_date).toBe('2026-03-04');
  });

  test('serializeTask maps booleans, numbers and blanks', function () {
    var out = rules.serializeTask(TASKS[2]);
    expect(out.is_packaging).toBe(true);
    expect(out.completed).toBe(false);
    expect(out.due_date).toBe('');
    expect(out.completed_at).toBe('');
    expect(out.step_number).toBe(3);
    expect(Object.keys(out)).toEqual(workbook.headers.BatchTasks);
  });

  test('serializeReading uses the sheet key timestamp and blank numerics', function () {
    var out = rules.serializeReading(READINGS[2]);
    expect(Object.keys(out)).toEqual(workbook.headers.PlatoReadings);
    expect(out.degrees_plato).toBe('');
    expect(out.temperature).toBe(19);
    expect(out.ph).toBe(3.4);
    expect(out.timestamp).toBe('2026-10-10T07:00:00.000Z');
  });

  test('serializeHistory keeps header order and numeric bin_id', function () {
    var out = rules.serializeHistory(HISTORY[0]);
    expect(Object.keys(out)).toEqual(workbook.headers.VesselHistory);
    expect(out.bin_id).toBe(1);
  });

  test('stripForList drops access_token without mutating the input', function () {
    var full = rules.serializeBatch(BATCHES[0]);
    var stripped = rules.stripForList(full);
    expect(stripped).not.toHaveProperty('access_token');
    expect(full.access_token).toBe(tokenFor(1));
  });
});

// ─── Dedup (D-15 parity) ───────────────────────────────────────────────────

describe('dedupDecision', function () {
  var payload = { zoho_so_number: 'INV-1', product_sku: 'K1', unit_total: 2 };

  test('returns the exact duplicate_so_number object at the limit (ids form)', function () {
    expect(rules.dedupDecision(['SV-B-000010', 'SV-B-000011'], payload)).toEqual({
      ok: false,
      error: 'duplicate_so_number',
      message: 'SO/invoice INV-1 + SKU K1 already has 2 of 2 batch(es): SV-B-000010, SV-B-000011'
    });
  });

  test('returns null below the limit', function () {
    expect(rules.dedupDecision(['SV-B-000010'], payload)).toBeNull();
    expect(rules.dedupDecision([], payload)).toBeNull();
  });

  test('legacy callers without unit_total allow exactly one', function () {
    var out = rules.dedupDecision(['SV-B-000010'], { zoho_so_number: 'INV-1', product_sku: 'K1' });
    expect(out.message).toBe('SO/invoice INV-1 + SKU K1 already has 1 of 1 batch(es): SV-B-000010');
  });

  test('invoice without SKU is a duplicate on the first existing id', function () {
    var out = rules.dedupDecision(['SV-B-000010'], { zoho_so_number: 'INV-1' });
    expect(out).toEqual({
      ok: false,
      error: 'duplicate_so_number',
      message: 'A batch for SO/invoice INV-1 already exists: SV-B-000010'
    });
  });

  test('no invoice means no guard', function () {
    expect(rules.dedupDecision(['SV-B-000010'], { product_sku: 'K1' })).toBeNull();
  });
});

// ─── Due date ──────────────────────────────────────────────────────────────

describe('calculateDueDate', function () {
  test('adds days across a month end', function () {
    expect(rules.calculateDueDate('2026-10-30', 3)).toBe('2026-11-02');
  });

  test('negative offset means TBD', function () {
    expect(rules.calculateDueDate('2026-10-30', -1)).toBe('');
  });

  test('does not shift a day across the 2026-11-01 DST change', function () {
    expect(rules.calculateDueDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(rules.calculateDueDate('2026-10-31', 2)).toBe('2026-11-02');
    expect(rules.calculateDueDate('2026-10-01', 31)).toBe('2026-11-01');
    expect(rules.calculateDueDate('2026-03-07', 2)).toBe('2026-03-09');
  });

  test('crosses a year end and leap day', function () {
    expect(rules.calculateDueDate('2026-12-30', 3)).toBe('2027-01-02');
    expect(rules.calculateDueDate('2028-02-28', 1)).toBe('2028-02-29');
  });

  test('tolerates a datetime string and rejects garbage', function () {
    expect(rules.calculateDueDate('2026-10-30T07:00:00.000Z', 1)).toBe('2026-10-31');
    expect(rules.calculateDueDate('not-a-date', 1)).toBe('');
    expect(rules.calculateDueDate('2026-10-30', 'x')).toBe('');
  });
});

// ─── Status and vessel transitions ─────────────────────────────────────────

describe('status and vessel transitions', function () {
  test('isActiveStatus is case-insensitive primary/secondary only', function () {
    expect(rules.isActiveStatus('Primary')).toBe(true);
    expect(rules.isActiveStatus('SECONDARY')).toBe(true);
    expect(rules.isActiveStatus('pending')).toBe(false);
    expect(rules.isActiveStatus('complete')).toBe(false);
    expect(rules.isActiveStatus(undefined)).toBe(false);
  });

  test('validateUpdateStatus rejects pending and unknown values', function () {
    var bad = rules.validateUpdateStatus('pending');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('invalid_status');
    expect(bad.message).toBe('Invalid status: pending. Must be one of: primary, secondary, complete, disabled');
    expect(rules.validateUpdateStatus('bogus').error).toBe('invalid_status');
  });

  test('validateUpdateStatus lowercases valid values', function () {
    expect(rules.validateUpdateStatus('Secondary')).toEqual({ ok: true, status: 'secondary' });
    expect(rules.validateUpdateStatus('DISABLED')).toEqual({ ok: true, status: 'disabled' });
  });

  test('vesselChangesForStatus frees on leaving active and occupies on entering', function () {
    expect(rules.vesselChangesForStatus('primary', 'complete', 'PCB-1')).toEqual([{ vessel_id: 'PCB-1', status: 'Empty' }]);
    expect(rules.vesselChangesForStatus('secondary', 'disabled', 'PCB-1')).toEqual([{ vessel_id: 'PCB-1', status: 'Empty' }]);
    expect(rules.vesselChangesForStatus('complete', 'primary', 'PCB-1')).toEqual([{ vessel_id: 'PCB-1', status: 'In-Use' }]);
    expect(rules.vesselChangesForStatus('pending', 'primary', 'PCB-1')).toEqual([{ vessel_id: 'PCB-1', status: 'In-Use' }]);
    expect(rules.vesselChangesForStatus('primary', 'secondary', 'PCB-1')).toEqual([]);
    expect(rules.vesselChangesForStatus('primary', 'complete', '')).toEqual([]);
  });

  test('vesselChangesForLocation flips old to Empty and new to In-Use', function () {
    expect(rules.vesselChangesForLocation('A-1', 'B-2')).toEqual([
      { vessel_id: 'A-1', status: 'Empty' }, { vessel_id: 'B-2', status: 'In-Use' }
    ]);
    expect(rules.vesselChangesForLocation('', 'B-2')).toEqual([{ vessel_id: 'B-2', status: 'In-Use' }]);
    expect(rules.vesselChangesForLocation('A-1', '')).toEqual([{ vessel_id: 'A-1', status: 'Empty' }]);
    expect(rules.vesselChangesForLocation('A-1', 'A-1')).toEqual([]);
  });

  test('statusAfterTransfer advances primary only', function () {
    expect(rules.statusAfterTransfer('primary')).toBe('secondary');
    expect(rules.statusAfterTransfer('Primary')).toBe('secondary');
    expect(rules.statusAfterTransfer('secondary')).toBe('secondary');
    expect(rules.statusAfterTransfer('complete')).toBe('complete');
  });
});

// ─── Reading validators ────────────────────────────────────────────────────

describe('validateReading', function () {
  test('plato above 40 is invalid_value', function () {
    expect(rules.validateReading({ degrees_plato: 41 }))
      .toEqual({ ok: false, error: 'invalid_value', message: 'degrees_plato must be 40 or less' });
    expect(rules.validateReading({ degrees_plato: 'abc' }).error).toBe('invalid_value');
  });

  test('ph outside 0..14 is invalid_value', function () {
    expect(rules.validateReading({ degrees_plato: 10, ph: 15 }))
      .toEqual({ ok: false, error: 'invalid_value', message: 'ph must be a number between 0 and 14' });
    expect(rules.validateReading({ ph: -0.5 }).error).toBe('invalid_value');
  });

  test('no measurement is invalid_input', function () {
    expect(rules.validateReading({})).toEqual({
      ok: false, error: 'invalid_input', message: 'At least one of degrees_plato, temperature, or ph is required'
    });
    expect(rules.validateReading({ degrees_plato: '', temperature: '', ph: '' }).error).toBe('invalid_input');
  });

  test('timestamp must be a real YYYY-MM-DD date', function () {
    expect(rules.validateReading({ degrees_plato: 10, timestamp: '2026-13-01' }).error).toBe('invalid_value');
    expect(rules.validateReading({ degrees_plato: 10, timestamp: '2026-02-30' }).error).toBe('invalid_value');
    expect(rules.validateReading({ degrees_plato: 10, timestamp: '10/01/2026' }).error).toBe('invalid_value');
    expect(rules.validateReading({ degrees_plato: 10, timestamp: '2026-10-01' }).ok).toBe(true);
  });

  test('temperature must be numeric', function () {
    expect(rules.validateReading({ temperature: 'warm' }))
      .toEqual({ ok: false, error: 'invalid_value', message: 'temperature must be a number' });
  });

  test('valid readings return parsed numbers and null for blanks', function () {
    expect(rules.validateReading({ degrees_plato: '12.5', temperature: '20', timestamp: '2026-10-01' })).toEqual({
      ok: true, degrees_plato: 12.5, temperature: 20, ph: null, timestamp: '2026-10-01'
    });
    expect(rules.validateReading({ ph: 3.5 })).toEqual({
      ok: true, degrees_plato: null, temperature: null, ph: 3.5, timestamp: ''
    });
  });

  test('plato exactly 40 and ph bounds are accepted', function () {
    expect(rules.validateReading({ degrees_plato: 40 }).ok).toBe(true);
    expect(rules.validateReading({ ph: 0 }).ok).toBe(true);
    expect(rules.validateReading({ ph: 14 }).ok).toBe(true);
  });
});

describe('validateReadingUpdate', function () {
  test('mirrors updatePlatoReading validation', function () {
    expect(rules.validateReadingUpdate({ degrees_plato: 41 }).error).toBe('invalid_value');
    expect(rules.validateReadingUpdate({ ph: 20 }).error).toBe('invalid_value');
    expect(rules.validateReadingUpdate({ timestamp: '2026-13-01' }).error).toBe('invalid_value');
    expect(rules.validateReadingUpdate({ temperature: 'x' }).error).toBe('invalid_value');
    expect(rules.validateReadingUpdate({ temperature: '', ph: '', timestamp: '' }).ok).toBe(true);
    expect(rules.validateReadingUpdate({ notes: 'hello' }).ok).toBe(true);
  });
});

// ─── Manual create fingerprint ─────────────────────────────────────────────

describe('manualCreateFingerprint', function () {
  var base = {
    product_sku: 'KIT-A', recipe_id: 'RCP-1', customer_name: 'Test Customer A', start_date: '2026-10-05',
    schedule_id: 'FS-1', vessel_id: 'PCB-1', shelf_id: 'A', bin_id: 3, notes: 'n'
  };

  function clone(over) {
    var o = {};
    Object.keys(base).forEach(function (k) { o[k] = base[k]; });
    Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
    return o;
  }

  test('is the sha256 hex of the pipe-joined fields', function () {
    var expected = crypto.createHash('sha256')
      .update('actor@example.com|KIT-A|RCP-1|Test Customer A|2026-10-05|FS-1|PCB-1|A|3|n')
      .digest('hex');
    expect(rules.manualCreateFingerprint('actor@example.com', base)).toBe(expected);
    expect(rules.manualCreateFingerprint('actor@example.com', base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is stable for identical input', function () {
    expect(rules.manualCreateFingerprint('a', base)).toBe(rules.manualCreateFingerprint('a', clone()));
  });

  test('changes when the actor or any named field changes', function () {
    var ref = rules.manualCreateFingerprint('a', base);
    expect(rules.manualCreateFingerprint('b', base)).not.toBe(ref);
    ['product_sku', 'recipe_id', 'customer_name', 'start_date', 'schedule_id', 'vessel_id', 'shelf_id', 'bin_id', 'notes']
      .forEach(function (f) {
        expect(rules.manualCreateFingerprint('a', clone((function () { var o = {}; o[f] = 'changed'; return o; })()))).not.toBe(ref);
      });
  });

  test('treats missing fields as empty so the delimiter cannot be confused', function () {
    expect(rules.manualCreateFingerprint('a', {})).toBe(rules.manualCreateFingerprint('a', { notes: '' }));
    expect(rules.manualCreateFingerprint('a', { product_sku: 'x', recipe_id: '' }))
      .not.toBe(rules.manualCreateFingerprint('a', { product_sku: '', recipe_id: 'x' }));
  });
});

// ─── Dashboard timezone ────────────────────────────────────────────────────

describe('buildDashboardSummary timezone', function () {
  test('today follows the injected timezone, not UTC', function () {
    // 2026-10-12T02:00Z is still 2026-10-11 in Vancouver.
    var late = rules.buildDashboardSummary({ batches: BATCHES, tasks: TASKS },
      { now: '2026-10-12T02:00:00.000Z', timezone: 'America/Vancouver' });
    var utc = rules.buildDashboardSummary({ batches: BATCHES, tasks: TASKS },
      { now: '2026-10-12T02:00:00.000Z', timezone: 'UTC' });
    expect(late.tasksDueToday).toBe(golden.getBatchDashboardSummary.tasksDueToday);
    expect(utc.tasksDueToday).not.toBe(late.tasksDueToday);
  });

  test('month buckets always list six consecutive months ending this month', function () {
    var s = rules.buildDashboardSummary({ batches: [], tasks: [] }, { now: '2026-01-15T12:00:00.000Z', timezone: 'America/Vancouver' });
    expect(s.batchesByMonth.map(function (m) { return m.month; }))
      .toEqual(['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01']);
    expect(s.batchesByMonth[0].label).toBe('Aug');
  });
});

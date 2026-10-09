'use strict';

// Phase 87-03: golden capture of the REAL apps-script/adminApi.gs batch read functions over the
// synthetic workbook (zoho-middleware/__tests__/fixtures/batches/synthetic-workbook.js).
//
//   UPDATE_BATCH_GOLDEN=1 npx jest tests/frontend/adminapi-batch-golden.test.js   -> rewrite golden.json
//   npx jest tests/frontend/adminapi-batch-golden.test.js                         -> fail on any drift
//
// zoho-middleware/__tests__/batch-rules.test.js reproduces every golden entry with the pure
// rules in zoho-middleware/lib/batch-rules.js. adminApi.gs is NOT edited by this plan.

// "today", the DST-sensitive month keys and Date arithmetic inside the script all use the
// process-local zone; Apps Script runs in the script zone, so pin it for this file.
var ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'America/Vancouver';

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');
var FIXTURE_DIR = path.join(__dirname, '../../zoho-middleware/__tests__/fixtures/batches');
var GOLDEN_PATH = path.join(FIXTURE_DIR, 'golden.json');
var workbook = require(path.join(FIXTURE_DIR, 'synthetic-workbook.js'));

var SOURCE = fs.readFileSync(ADMIN_API_PATH, 'utf8');
var RealDate = Date;
var NOW_MS = new RealDate(workbook.now).getTime();

afterAll(function () {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

// Date whose no-argument constructor returns the fixed instant.
function FakeDate() {
  var args = Array.prototype.slice.call(arguments);
  if (args.length === 0) return new RealDate(NOW_MS);
  return new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = function () { return NOW_MS; };
FakeDate.UTC = RealDate.UTC;
FakeDate.parse = RealDate.parse;
Object.defineProperty(FakeDate, Symbol.hasInstance, { value: function (x) { return x instanceof RealDate; } });

function zoneParts(date, tz) {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date);
  var out = {};
  parts.forEach(function (p) { out[p.type] = p.value; });
  return out;
}

var Utilities = {
  formatDate: function (date, tz, fmt) {
    var p = zoneParts(date, tz);
    if (fmt === 'yyyy-MM-dd') return p.year + '-' + p.month + '-' + p.day;
    if (fmt === 'yyyy-MM') return p.year + '-' + p.month;
    if (fmt === 'MMM') {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short' }).format(date);
    }
    throw new Error('unsupported format ' + fmt);
  },
  getUuid: function () { return '00000000-0000-4000-8000-000000000000'; }
};

function makeSheet(rows) {
  return {
    getLastRow: function () { return rows.length; },
    getLastColumn: function () { return rows[0].length; },
    getDataRange: function () {
      return { getValues: function () { return rows.map(function (r) { return r.slice(); }); } };
    }
  };
}

function makeSheets() {
  var sheets = {};
  Object.keys(workbook.headers).forEach(function (name) {
    sheets[name] = makeSheet([workbook.headers[name].slice()].concat(
      workbook.rows[name].map(function (r) { return r.slice(); })));
  });
  return sheets;
}

var NAMES = ['getBatches', 'getBatchDetail', 'handleGetBatchPublic', 'getTasksCalendar', 'getTasksUpcoming',
  'getBatchDashboardSummary', 'checkLocationConflict', 'batchDedupDecision', 'sheetToObjects'];

var factory = new Function('SpreadsheetApp', 'CacheService', 'LockService', 'Logger', 'Session', 'Utilities', 'Date',
  SOURCE + '\nreturn {' + NAMES.map(function (n) { return n + ': ' + n; }).join(',') + '};');

// Fresh script instance per call: the script's per-request sheet cache must not leak between cases.
function load() {
  var sheets = makeSheets();
  var noopCache = { get: function () { return null; }, put: function () {}, remove: function () {}, removeAll: function () {} };
  return factory(
    { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; } }; } },
    { getScriptCache: function () { return noopCache; } },
    { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    { log: function () {} },
    { getScriptTimeZone: function () { return workbook.timezone; } },
    Utilities,
    FakeDate
  );
}

function plain(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }

function run(fn) { return plain(fn(load())); }

function pub(batchId, token) {
  return run(function (api) { return api.handleGetBatchPublic({ parameter: { batch_id: batchId, token: token } }); });
}

function tokenFor(n) {
  var s = String(n);
  while (s.length < 32) s = 'a' + s;
  return s;
}

function collect() {
  var g = {};
  var batchIds = workbook.rows.Batches.map(function (r) { return r[0]; });

  g['getBatches:0:0:all'] = run(function (api) { return api.getBatches(0, 0, 'all'); });
  g['getBatches:0:0:active'] = run(function (api) { return api.getBatches(0, 0, 'active'); });
  g['getBatches:3:0:all'] = run(function (api) { return api.getBatches(3, 0, 'all'); });
  g['getBatches:2:2:all'] = run(function (api) { return api.getBatches(2, 2, 'all'); });
  g['getBatches:0:11:all'] = run(function (api) { return api.getBatches(0, 11, 'all'); });
  g['getBatches:0:0:complete'] = run(function (api) { return api.getBatches(0, 0, 'complete'); });
  g['getBatches:0:0:PRIMARY'] = run(function (api) { return api.getBatches(0, 0, 'PRIMARY'); });

  batchIds.forEach(function (id) {
    g['getBatchDetail:' + id] = run(function (api) { return api.getBatchDetail(id); });
  });
  g['getBatchDetail:SV-B-999999'] = run(function (api) { return api.getBatchDetail('SV-B-999999'); });
  g['getBatchDetail:'] = run(function (api) { return api.getBatchDetail(''); });

  g['handleGetBatchPublic:valid'] = pub('SV-B-000001', tokenFor(1));
  g['handleGetBatchPublic:valid-duplicate-steps'] = pub('SV-B-000002', tokenFor(2));
  g['handleGetBatchPublic:valid-pending'] = pub('SV-B-000005', tokenFor(5));
  g['handleGetBatchPublic:wrong-token'] = pub('SV-B-000001', tokenFor(2));
  g['handleGetBatchPublic:malformed-token'] = pub('SV-B-000001', 'abc123');
  g['handleGetBatchPublic:malformed-batch-id'] = pub('SV-B-1', tokenFor(1));
  g['handleGetBatchPublic:missing-token'] = pub('SV-B-000001', '');
  g['handleGetBatchPublic:disabled'] = pub('SV-B-000009', tokenFor(9));
  g['handleGetBatchPublic:unknown-batch'] = pub('SV-B-000099', tokenFor(1));

  g['getTasksCalendar:month'] = run(function (api) { return api.getTasksCalendar('2026-10-01', '2026-10-31'); });
  g['getTasksCalendar:week'] = run(function (api) { return api.getTasksCalendar('2026-10-11', '2026-10-17'); });
  g['getTasksCalendar:wide'] = run(function (api) { return api.getTasksCalendar('2026-01-01', '2026-12-31'); });
  g['getTasksCalendar:missing-end'] = run(function (api) { return api.getTasksCalendar('2026-10-01', ''); });
  g['getTasksCalendar:missing-start'] = run(function (api) { return api.getTasksCalendar('', '2026-10-31'); });

  g['getTasksUpcoming:50'] = run(function (api) { return api.getTasksUpcoming(50); });
  g['getTasksUpcoming:2'] = run(function (api) { return api.getTasksUpcoming(2); });

  g['getBatchDashboardSummary'] = run(function (api) { return api.getBatchDashboardSummary(); });

  var locations = [
    ['occupied-primary', 'PCB-001', 'A', 1, ''],
    ['occupied-numeric-vs-string-bin', 'PCB-002', 'B', '12', ''],
    ['occupied-secondary', 'PCB-003', 'C', 3, ''],
    ['excluded-self', 'PCB-001', 'A', 1, 'SV-B-000001'],
    ['free-slot', 'PCB-001', 'A', 99, ''],
    ['free-vessel', 'PCB-777', 'A', 1, ''],
    ['pending-slot-ignored', 'PCB-005', 'D', 7, ''],
    ['complete-slot-ignored', 'PCB-007', 'A', 1, ''],
    ['disabled-slot-ignored', 'PCB-009', 'E', 9, ''],
    ['no-shelf-no-bin', 'CRB-004', '', '', ''],
    ['no-vessel', '', 'A', 1, '']
  ];
  locations.forEach(function (c) {
    g['checkLocationConflict:' + c[0]] = run(function (api) {
      return { input: { vessel_id: c[1], shelf_id: c[2], bin_id: c[3], exclude: c[4] },
        result: api.checkLocationConflict(c[1], c[2], c[3], c[4]) };
    });
  });

  var dedups = [
    ['two-of-two-duplicate', { zoho_so_number: 'INV-000400', product_sku: 'KIT-C', unit_total: 2 }],
    ['two-of-three-allowed', { zoho_so_number: 'INV-000400', product_sku: 'KIT-C', unit_total: 3 }],
    ['legacy-no-unit-total', { zoho_so_number: 'INV-000400', product_sku: 'KIT-C' }],
    ['one-of-one-single-sku', { zoho_so_number: 'INV-000300', product_sku: 'KIT-B' }],
    ['one-of-two-allowed', { zoho_so_number: 'INV-000300', product_sku: 'KIT-B', unit_total: 2 }],
    ['fractional-unit-total', { zoho_so_number: 'INV-000400', product_sku: 'KIT-C', unit_total: 2.9 }],
    ['zero-unit-total-is-one', { zoho_so_number: 'INV-000300', product_sku: 'KIT-B', unit_total: 0 }],
    ['non-numeric-unit-total-is-one', { zoho_so_number: 'INV-000300', product_sku: 'KIT-B', unit_total: 'abc' }],
    ['different-sku-allowed', { zoho_so_number: 'INV-000400', product_sku: 'KIT-Z', unit_total: 1 }],
    ['new-invoice-allowed', { zoho_so_number: 'INV-000999', product_sku: 'KIT-C', unit_total: 1 }],
    ['trimmed-match', { zoho_so_number: ' INV-000400 ', product_sku: ' KIT-C ', unit_total: 2 }],
    ['invoice-only-duplicate', { zoho_so_number: 'INV-000400' }],
    ['invoice-only-new', { zoho_so_number: 'INV-000999' }],
    ['no-invoice', { product_sku: 'KIT-C', unit_total: 1 }]
  ];
  dedups.forEach(function (c) {
    g['batchDedupDecision:' + c[0]] = run(function (api) {
      return { input: c[1], result: api.batchDedupDecision(api.sheetToObjects('Batches', true), c[1]) };
    });
  });

  return g;
}

describe('adminApi.gs batch reads over the synthetic workbook', function () {
  var captured = collect();

  test('golden.json carries every expected call key', function () {
    var keys = Object.keys(captured);
    ['getBatches:0:0:all', 'getBatchDashboardSummary', 'getTasksCalendar:month', 'getTasksUpcoming:50',
      'handleGetBatchPublic:valid', 'batchDedupDecision:two-of-two-duplicate',
      'checkLocationConflict:occupied-primary', 'getBatchDetail:SV-B-000001'].forEach(function (k) {
      expect(keys).toContain(k);
    });
  });

  if (process.env.UPDATE_BATCH_GOLDEN === '1') {
    test('UPDATE_BATCH_GOLDEN=1 writes golden.json', function () {
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(captured, null, 2) + '\n');
      expect(fs.existsSync(GOLDEN_PATH)).toBe(true);
    });
  } else {
    test('adminApi.gs output has not drifted from golden.json', function () {
      var golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
      expect(Object.keys(captured).sort()).toEqual(Object.keys(golden).sort());
      Object.keys(golden).forEach(function (k) {
        expect({ key: k, value: captured[k] }).toEqual({ key: k, value: golden[k] });
      });
    });
  }
});

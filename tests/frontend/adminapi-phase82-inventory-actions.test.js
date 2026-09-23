'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file (same technique as adminapi-giftcard-ledger.test.js /
// adminapi-phase82-locks.test.js / adminapi-phase82-dispatch.test.js) and evaluates it via
// `new Function` to extract only the PURE helper functions under test. Everything else here is
// a source-shape assertion on the raw text of `adminApi.gs` (handleReadAction, doPost, the six
// impure write wrappers, the deletions) — it cannot observe a real Apps Script HTTP round-trip,
// a real Sheets write, or a real LockService acquisition.
//
// Loader/slicer copied verbatim from adminapi-giftcard-ledger.test.js per the plan's explicit
// instruction not to import test helpers across test files.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var _cachedApi = null;

function loadAdminApi() {
  if (_cachedApi) return _cachedApi;
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  // Each property uses a `typeof` guard so this factory itself never throws a ReferenceError
  // when a helper hasn't been implemented yet (RED stage) — instead the property is `undefined`,
  // and the individual test that calls it fails with a clear "api.<name> is not a function"
  // naming that specific helper, rather than every test in the file failing identically.
  var factory = new Function(
    src + '\nreturn {' +
      'resolveInventorySheetName: (typeof resolveInventorySheetName !== "undefined" ? resolveInventorySheetName : undefined),' +
      'validateInventoryCellUpdates: (typeof validateInventoryCellUpdates !== "undefined" ? validateInventoryCellUpdates : undefined),' +
      'validateAppendRow: (typeof validateAppendRow !== "undefined" ? validateAppendRow : undefined),' +
      'validateKitsImport: (typeof validateKitsImport !== "undefined" ? validateKitsImport : undefined),' +
      'buildManualHoldRow: (typeof buildManualHoldRow !== "undefined" ? buildManualHoldRow : undefined),' +
      'validateScheduleSlotRows: (typeof validateScheduleSlotRows !== "undefined" ? validateScheduleSlotRows : undefined),' +
      'planScheduleSlotUpdates: (typeof planScheduleSlotUpdates !== "undefined" ? planScheduleSlotUpdates : undefined)' +
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

// Evaluates ONLY the raw file body (no trailing `return { ... }` referencing the seven
// not-yet-implemented helpers) so this is a pure syntax/executability check on adminApi.gs
// itself, independent of whether the new helpers exist yet.
function evaluateSourceOnly() {
  var src = rawSource();
  var fn = new Function(src);
  fn();
}

// Slice a named function's source text by locating `function <name>(` and brace-matching to
// its closing brace.
function sliceFunctionSource(src, name) {
  var marker = 'function ' + name + '(';
  var start = src.indexOf(marker);
  if (start === -1) return null;
  var braceStart = src.indexOf('{', start);
  if (braceStart === -1) return null;
  var depth = 0;
  for (var i = braceStart; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function countOccurrences(str, needle) {
  if (!str) return 0;
  return str.split(needle).length - 1;
}

describe('adminApi.gs — whole-file evaluation (syntax gate)', function () {
  test('adminApi.gs parses and evaluates without throwing', function () {
    expect(function () { evaluateSourceOnly(); }).not.toThrow();
  });
});

describe('INGREDIENTS_SHEET_NAME constant (D-15)', function () {
  test('adminApi.gs declares var INGREDIENTS_SHEET_NAME = \'Ingredients\'', function () {
    var src = rawSource();
    expect(src).toMatch(/var\s+INGREDIENTS_SHEET_NAME\s*=\s*['"]Ingredients['"]\s*;/);
  });
});

describe('get_ingredients read action (D-15)', function () {
  test('handleReadAction contains exactly one case \'get_ingredients\'', function () {
    var src = rawSource();
    expect(countOccurrences(src, "case 'get_ingredients'")).toBe(1);
  });

  test('getIngredients() function exists exactly once', function () {
    var src = rawSource();
    expect(countOccurrences(src, 'function getIngredients(')).toBe(1);
  });

  test('getIngredients() uses getDisplayValues(), mirrors getKits() shape', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'getIngredients');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toMatch(/getDisplayValues\(\)/);
    expect(fnSrc).toMatch(/INGREDIENTS_SHEET_NAME/);
    expect(fnSrc).toMatch(/values:\s*\[\]/);
  });
});

describe('get_homepage read action — display-value parity (D-21)', function () {
  test('getHomepage() now uses getDisplayValues() instead of getValues()', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'getHomepage');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toMatch(/getDisplayValues\(\)/);
    expect(fnSrc).not.toMatch(/\.getValues\(\)/);
  });

  test('case \'get_homepage\' still exists exactly once (retained per D-21)', function () {
    var src = rawSource();
    expect(countOccurrences(src, "case 'get_homepage'")).toBe(1);
  });
});

describe('resolveInventorySheetName — pure helper', function () {
  test('resolves Kits and Ingredients to their sheet-name constants', function () {
    var api = loadAdminApi();
    expect(api.resolveInventorySheetName('Kits')).toBe('Kits');
    expect(api.resolveInventorySheetName('Ingredients')).toBe('Ingredients');
  });

  test('returns null for any other key, empty string, or undefined', function () {
    var api = loadAdminApi();
    expect(api.resolveInventorySheetName('Holds')).toBeNull();
    expect(api.resolveInventorySheetName('')).toBeNull();
    expect(api.resolveInventorySheetName(undefined)).toBeNull();
  });
});

describe('validateInventoryCellUpdates — pure helper', function () {
  var headers = ['sku', 'stock', 'on_hold', 'last_updated'];

  test('valid single update resolves the header-name field to a 1-based column', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [{ row: 2, field: 'stock', value: 5 }]);
    expect(result).toEqual({ ok: true, writes: [{ row: 2, col: 2, value: 5 }] });
  });

  test('unknown field name is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [{ row: 2, field: 'price', value: 5 }]);
    expect(result).toEqual({ ok: false, error: 'invalid_field' });
  });

  test('header row (row 1) is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [{ row: 1, field: 'stock', value: 5 }]);
    expect(result).toEqual({ ok: false, error: 'invalid_row' });
  });

  test('row beyond lastRow is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [{ row: 11, field: 'stock', value: 5 }]);
    expect(result).toEqual({ ok: false, error: 'invalid_row' });
  });

  test('non-integer string row is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [{ row: '2', field: 'stock', value: 5 }]);
    expect(result).toEqual({ ok: false, error: 'invalid_row' });
  });

  test('empty updates array is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, []);
    expect(result).toEqual({ ok: false, error: 'invalid_updates' });
  });

  test('more than 500 updates is rejected', function () {
    var api = loadAdminApi();
    var tooMany = [];
    for (var i = 0; i < 501; i++) tooMany.push({ row: 2, field: 'stock', value: i });
    var result = api.validateInventoryCellUpdates(headers, 501, tooMany);
    expect(result).toEqual({ ok: false, error: 'invalid_updates' });
  });

  test('any single invalid entry fails the whole batch (no partial writes)', function () {
    var api = loadAdminApi();
    var result = api.validateInventoryCellUpdates(headers, 10, [
      { row: 2, field: 'stock', value: 5 },
      { row: 1, field: 'stock', value: 6 }
    ]);
    expect(result.ok).toBe(false);
  });
});

describe('validateAppendRow — pure helper', function () {
  test('values no longer than headers is valid', function () {
    var api = loadAdminApi();
    var result = api.validateAppendRow(['a', 'b', 'c'], ['x', 'y']);
    expect(result).toEqual({ ok: true });
  });

  test('values longer than headers is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateAppendRow(['a', 'b'], ['x', 'y', 'z']);
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });

  test('empty values array is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateAppendRow(['a', 'b', 'c'], []);
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });

  test('non-array values is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateAppendRow(['a', 'b', 'c'], 'not-an-array');
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });
});

describe('validateKitsImport — pure helper', function () {
  var headers = ['sku', 'name', 'stock'];

  test('valid import: first row equals headers, every row matches header length', function () {
    var api = loadAdminApi();
    var result = api.validateKitsImport(headers, [headers, ['K1', 'Kit One', 5]]);
    expect(result).toEqual({ ok: true });
  });

  test('first row not equal to headers is a header_mismatch', function () {
    var api = loadAdminApi();
    var result = api.validateKitsImport(headers, [['sku', 'name', 'wrong'], ['K1', 'Kit One', 5]]);
    expect(result).toEqual({ ok: false, error: 'header_mismatch' });
  });

  test('a short row is invalid_values', function () {
    var api = loadAdminApi();
    var result = api.validateKitsImport(headers, [headers, ['K1', 'Kit One']]);
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });

  test('only the header row (length 1) is invalid_values', function () {
    var api = loadAdminApi();
    var result = api.validateKitsImport(headers, [headers]);
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });

  test('more than 2001 rows is invalid_values', function () {
    var api = loadAdminApi();
    var tooMany = [headers];
    for (var i = 0; i < 2001; i++) tooMany.push(['K' + i, 'Kit ' + i, i]);
    var result = api.validateKitsImport(headers, tooMany);
    expect(result).toEqual({ ok: false, error: 'invalid_values' });
  });
});

describe('buildManualHoldRow — pure helper', function () {
  var nowIso = '2026-09-23T00:00:00.000Z';

  test('builds the 10-column row in the exact admin.js order', function () {
    var api = loadAdminApi();
    var result = api.buildManualHoldRow(
      { hold_id: 'H-20260923-M123', sku: 'K1', product_name: 'X', qty: 2, notes: 'n' },
      nowIso
    );
    expect(result).toEqual(['H-20260923-M123', '', 'K1', 'X', 2, 'pending', nowIso, '', '', 'n']);
  });

  test('bad hold_id format is invalid_hold', function () {
    var api = loadAdminApi();
    var result = api.buildManualHoldRow(
      { hold_id: 'not-a-hold-id', sku: 'K1', product_name: 'X', qty: 2, notes: 'n' },
      nowIso
    );
    expect(result).toEqual({ ok: false, error: 'invalid_hold' });
  });

  test('empty sku is invalid_hold', function () {
    var api = loadAdminApi();
    var result = api.buildManualHoldRow(
      { hold_id: 'H-20260923-M123', sku: '', product_name: 'X', qty: 2, notes: 'n' },
      nowIso
    );
    expect(result).toEqual({ ok: false, error: 'invalid_hold' });
  });

  test('qty of 0 is invalid_hold', function () {
    var api = loadAdminApi();
    var result = api.buildManualHoldRow(
      { hold_id: 'H-20260923-M123', sku: 'K1', product_name: 'X', qty: 0, notes: 'n' },
      nowIso
    );
    expect(result).toEqual({ ok: false, error: 'invalid_hold' });
  });
});

describe('validateScheduleSlotRows — pure helper', function () {
  test('a valid available-status row is accepted', function () {
    var api = loadAdminApi();
    var result = api.validateScheduleSlotRows([['2026-10-01', '10:00 AM', 'available']]);
    expect(result.ok).toBe(true);
  });

  test('a badly formatted date is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateScheduleSlotRows([['2026-1-1', '10:00 AM', 'available']]);
    expect(result).toEqual({ ok: false, error: 'invalid_rows' });
  });

  test('status "booked" cannot be created via append', function () {
    var api = loadAdminApi();
    var result = api.validateScheduleSlotRows([['2026-10-01', '10:00 AM', 'booked']]);
    expect(result).toEqual({ ok: false, error: 'invalid_rows' });
  });

  test('empty time is rejected', function () {
    var api = loadAdminApi();
    var result = api.validateScheduleSlotRows([['2026-10-01', '', 'available']]);
    expect(result).toEqual({ ok: false, error: 'invalid_rows' });
  });

  test('more than 1000 rows is rejected', function () {
    var api = loadAdminApi();
    var tooMany = [];
    for (var i = 0; i < 1001; i++) tooMany.push(['2026-10-01', '10:00 AM', 'available']);
    var result = api.validateScheduleSlotRows(tooMany);
    expect(result).toEqual({ ok: false, error: 'invalid_rows' });
  });
});

describe('planScheduleSlotUpdates — pure helper', function () {
  test('skips a row whose current status is booked (case-insensitive), writes the rest', function () {
    var api = loadAdminApi();
    var result = api.planScheduleSlotUpdates(
      [{ row: 2, status: 'blocked' }, { row: 3, status: 'available' }],
      { 2: 'Booked', 3: 'blocked' }
    );
    expect(result).toEqual({ writes: [{ row: 3, status: 'available' }], skipped: [2] });
  });

  test('attempting to set status to booked is invalid_updates', function () {
    var api = loadAdminApi();
    var result = api.planScheduleSlotUpdates(
      [{ row: 2, status: 'booked' }],
      { 2: 'available' }
    );
    expect(result).toEqual({ ok: false, error: 'invalid_updates' });
  });

  test('empty updates array is invalid_updates', function () {
    var api = loadAdminApi();
    var result = api.planScheduleSlotUpdates([], {});
    expect(result).toEqual({ ok: false, error: 'invalid_updates' });
  });

  test('more than 1000 updates is invalid_updates', function () {
    var api = loadAdminApi();
    var tooMany = [];
    var statusMap = {};
    for (var i = 0; i < 1001; i++) {
      tooMany.push({ row: i + 2, status: 'available' });
      statusMap[i + 2] = 'available';
    }
    var result = api.planScheduleSlotUpdates(tooMany, statusMap);
    expect(result).toEqual({ ok: false, error: 'invalid_updates' });
  });
});

describe('Purity — all seven new helpers reference no Apps Script globals or sheet I/O', function () {
  var helperNames = [
    'resolveInventorySheetName',
    'validateInventoryCellUpdates',
    'validateAppendRow',
    'validateKitsImport',
    'buildManualHoldRow',
    'validateScheduleSlotRows',
    'planScheduleSlotUpdates'
  ];

  helperNames.forEach(function (name) {
    test(name + '() source references neither SpreadsheetApp, LockService, CacheService, nor PropertiesService', function () {
      var src = rawSource();
      var fnSrc = sliceFunctionSource(src, name);
      expect(fnSrc).not.toBeNull();
      expect(fnSrc).not.toMatch(/SpreadsheetApp|LockService|CacheService|PropertiesService/);
    });
  });
});

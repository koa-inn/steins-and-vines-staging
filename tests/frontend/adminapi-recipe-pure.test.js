'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file, verifies it has no top-level executable statements (only `var`
// declarations and `function` declarations), and evaluates it via `new Function` to extract
// just the pure helper functions under test. Any attempt to actually CALL a function that
// touches SpreadsheetApp/LockService/etc. would throw ReferenceError in this sandbox — which is
// exactly why this suite only exercises the four new pure helpers (plus sanitizeInput and
// generateNextId, referenced read-only for cross-checking, never invoked here).

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
  // naming that specific helper, rather than every test in the file failing identically on
  // whichever helper happens to be referenced first.
  var factory = new Function(
    src + '\nreturn {' +
      'formatPaddedId: (typeof formatPaddedId !== "undefined" ? formatPaddedId : undefined),' +
      'maxIdNumFromColumn: (typeof maxIdNumFromColumn !== "undefined" ? maxIdNumFromColumn : undefined),' +
      'normalizeRecipeIngredientTuple: (typeof normalizeRecipeIngredientTuple !== "undefined" ? normalizeRecipeIngredientTuple : undefined),' +
      'recipeIngredientsUnchanged: (typeof recipeIngredientsUnchanged !== "undefined" ? recipeIngredientsUnchanged : undefined),' +
      'sanitizeInput: (typeof sanitizeInput !== "undefined" ? sanitizeInput : undefined),' +
      'generateNextId: (typeof generateNextId !== "undefined" ? generateNextId : undefined)' +
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

// Evaluates ONLY the raw file body (no trailing `return { ... }` referencing the four
// not-yet-implemented helpers) so this is a pure syntax/executability check on adminApi.gs
// itself, independent of whether the four new helpers exist yet. Used by the RED-stage
// "parses and evaluates without throwing" test, which must pass before Task 2 exists.
function evaluateSourceOnly() {
  var src = rawSource();
  var fn = new Function(src);
  fn();
}

// Slice a named function's source text by locating `function <name>(` and brace-matching to
// its closing brace. Used only by the purity assertion below.
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

describe('adminApi.gs — whole-file evaluation (syntax gate)', function () {
  test('adminApi.gs parses and evaluates without throwing', function () {
    expect(function () { evaluateSourceOnly(); }).not.toThrow();
  });
});

describe('formatPaddedId', function () {
  test("('RI-', 1, 6) -> 'RI-000001'", function () {
    var api = loadAdminApi();
    expect(api.formatPaddedId('RI-', 1, 6)).toBe('RI-000001');
  });

  test("('RI-', 14, 6) -> 'RI-000014'", function () {
    var api = loadAdminApi();
    expect(api.formatPaddedId('RI-', 14, 6)).toBe('RI-000014');
  });

  test("('RI-', 999999, 6) -> 'RI-999999'", function () {
    var api = loadAdminApi();
    expect(api.formatPaddedId('RI-', 999999, 6)).toBe('RI-999999');
  });

  test("('RI-', 1234567, 6) -> 'RI-1234567' (over-length is NOT truncated)", function () {
    var api = loadAdminApi();
    expect(api.formatPaddedId('RI-', 1234567, 6)).toBe('RI-1234567');
  });

  test('cross-check against generateNextId-equivalent literal expectations', function () {
    var api = loadAdminApi();
    // generateNextId cannot run without SpreadsheetApp, so we assert against the same literal
    // expected strings above — this test documents the intent, not a new assertion.
    expect(api.formatPaddedId('RI-', 1, 6)).toBe('RI-000001');
    expect(api.formatPaddedId('RI-', 999999, 6)).toBe('RI-999999');
  });
});

describe('maxIdNumFromColumn', function () {
  test('[] -> 0', function () {
    var api = loadAdminApi();
    expect(api.maxIdNumFromColumn([], 0, 'RI-')).toBe(0);
  });

  test("[['RI-000001'],['RI-000013'],['RI-000007']], col 0, 'RI-' -> 13", function () {
    var api = loadAdminApi();
    var rows = [['RI-000001'], ['RI-000013'], ['RI-000007']];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(13);
  });

  test('out-of-order input still yields the max, not the last', function () {
    var api = loadAdminApi();
    var rows = [['RI-000013'], ['RI-000002'], ['RI-000009']];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(13);
  });

  test("rows carrying a different prefix ('SV-R-000099') are ignored -> 0", function () {
    var api = loadAdminApi();
    var rows = [['SV-R-000099']];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(0);
  });

  test('blank, null and undefined cells are ignored, not counted as 0-prefix matches', function () {
    var api = loadAdminApi();
    var rows = [[''], [null], [undefined]];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(0);
  });

  test('a numeric cell value (Sheets returns 5, not "5") is ignored — it has no prefix', function () {
    var api = loadAdminApi();
    var rows = [[5]];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(0);
  });

  test("'RI-abc' (non-numeric suffix) is ignored", function () {
    var api = loadAdminApi();
    var rows = [['RI-abc']];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(0);
  });

  test('mixed sheet with blanks, other-prefix and null rows -> 9', function () {
    var api = loadAdminApi();
    var rows = [['RI-000004'], [''], ['SV-R-000100'], ['RI-000009'], [null]];
    expect(api.maxIdNumFromColumn(rows, 0, 'RI-')).toBe(9);
  });

  test('respects colIndex: same data at column 2 with colIndex 2 -> same answer', function () {
    var api = loadAdminApi();
    var rows = [
      ['x', 'y', 'RI-000004'],
      ['x', 'y', ''],
      ['x', 'y', 'SV-R-000100'],
      ['x', 'y', 'RI-000009'],
      ['x', 'y', null]
    ];
    expect(api.maxIdNumFromColumn(rows, 2, 'RI-')).toBe(9);
  });
});

describe('normalizeRecipeIngredientTuple', function () {
  test('quantity undefined -> same key as quantity 0', function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', undefined, 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple('123', 0, 'kg'));
  });

  test("quantity '' -> same key as 0; quantity null -> same key as 0", function () {
    var api = loadAdminApi();
    var zero = api.normalizeRecipeIngredientTuple('123', 0, 'kg');
    expect(api.normalizeRecipeIngredientTuple('123', '', 'kg')).toBe(zero);
    expect(api.normalizeRecipeIngredientTuple('123', null, 'kg')).toBe(zero);
  });

  test("quantity '5' (JSON string) -> same key as 5 (Sheets number)", function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', '5', 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple('123', 5, 'kg'));
  });

  test('quantity 0.30000000000000004 -> same key as 0.3 (float drift tolerance at 1e-9)', function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', 0.30000000000000004, 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple('123', 0.3, 'kg'));
  });

  test('quantity 0.01 vs 0.011 -> DIFFERENT keys (real edits at brewing magnitudes are preserved)', function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', 0.01, 'kg'))
      .not.toBe(api.normalizeRecipeIngredientTuple('123', 0.011, 'kg'));
  });

  test("unit ' kg' -> same key as 'kg' (trimmed)", function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', 5, ' kg'))
      .toBe(api.normalizeRecipeIngredientTuple('123', 5, 'kg'));
  });

  test("unit 'KG' -> DIFFERENT key from 'kg' (NO case folding)", function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple('123', 5, 'KG'))
      .not.toBe(api.normalizeRecipeIngredientTuple('123', 5, 'kg'));
  });

  test("itemId ' 123 ' -> same key as '123' (trimmed); itemId null/undefined -> same key as ''", function () {
    var api = loadAdminApi();
    expect(api.normalizeRecipeIngredientTuple(' 123 ', 5, 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple('123', 5, 'kg'));
    expect(api.normalizeRecipeIngredientTuple(null, 5, 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple(undefined, 5, 'kg'));
    expect(api.normalizeRecipeIngredientTuple(null, 5, 'kg'))
      .toBe(api.normalizeRecipeIngredientTuple('', 5, 'kg'));
  });

  test("a non-numeric quantity ('abc') produces a key that is NEVER equal to any finite-quantity key", function () {
    var api = loadAdminApi();
    var nonFinite = api.normalizeRecipeIngredientTuple('123', 'abc', 'kg');
    expect(nonFinite).not.toBe(api.normalizeRecipeIngredientTuple('123', 0, 'kg'));
    expect(nonFinite).not.toBe(api.normalizeRecipeIngredientTuple('123', NaN, 'kg'));
    expect(nonFinite).not.toBe(api.normalizeRecipeIngredientTuple('123', Infinity, 'kg'));
    // Two independently-computed non-finite keys must still be equal to each other (same
    // sentinel token) — this is checked separately by recipeIngredientsUnchanged's own
    // non-finite guard, not required to differ tuple-to-tuple here.
  });
});

describe('recipeIngredientsUnchanged', function () {
  test('([], []) -> true', function () {
    var api = loadAdminApi();
    expect(api.recipeIngredientsUnchanged([], [])).toBe(true);
  });

  test('identical 3-element arrays -> true', function () {
    var api = loadAdminApi();
    var arr = ['a', 'b', 'c'];
    expect(api.recipeIngredientsUnchanged(arr, arr.slice())).toBe(true);
  });

  test('incoming has one MORE element -> false', function () {
    var api = loadAdminApi();
    expect(api.recipeIngredientsUnchanged(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
  });

  test('incoming has one FEWER element -> false', function () {
    var api = loadAdminApi();
    expect(api.recipeIngredientsUnchanged(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
  });

  test('same elements in a different ORDER -> false', function () {
    var api = loadAdminApi();
    expect(api.recipeIngredientsUnchanged(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(false);
  });

  test('one quantity differs -> false', function () {
    var api = loadAdminApi();
    var incoming = [api.normalizeRecipeIngredientTuple('1', 5, 'kg')];
    var stored = [api.normalizeRecipeIngredientTuple('1', 6, 'kg')];
    expect(api.recipeIngredientsUnchanged(incoming, stored)).toBe(false);
  });

  test('one unit differs -> false', function () {
    var api = loadAdminApi();
    var incoming = [api.normalizeRecipeIngredientTuple('1', 5, 'kg')];
    var stored = [api.normalizeRecipeIngredientTuple('1', 5, 'g')];
    expect(api.recipeIngredientsUnchanged(incoming, stored)).toBe(false);
  });

  test('one item_id differs -> false', function () {
    var api = loadAdminApi();
    var incoming = [api.normalizeRecipeIngredientTuple('1', 5, 'kg')];
    var stored = [api.normalizeRecipeIngredientTuple('2', 5, 'kg')];
    expect(api.recipeIngredientsUnchanged(incoming, stored)).toBe(false);
  });

  test('if ANY tuple on EITHER side carries a non-finite quantity -> false, unconditionally', function () {
    var api = loadAdminApi();
    var nonFinite = api.normalizeRecipeIngredientTuple('1', 'abc', 'kg');
    var fine = api.normalizeRecipeIngredientTuple('1', 5, 'kg');
    // Same sentinel appears on both sides — must NOT be treated as "unchanged".
    expect(api.recipeIngredientsUnchanged([nonFinite], [nonFinite])).toBe(false);
    expect(api.recipeIngredientsUnchanged([nonFinite, fine], [nonFinite, fine])).toBe(false);
  });

  test('a 13-element realistic list built from JSON-style strings vs Sheets-style numbers -> true', function () {
    var api = loadAdminApi();
    var jsonIncoming = [];
    var sheetsStored = [];
    for (var i = 0; i < 13; i++) {
      var itemId = 'ITEM-' + i;
      var qtyJson = String((i + 1) * 0.1); // e.g. "0.1", "0.2", ...
      var qtyNum = (i + 1) * 0.1;          // 0.1, 0.2, ... as Sheets numbers
      var unit = i % 2 === 0 ? 'kg' : 'g';
      jsonIncoming.push(api.normalizeRecipeIngredientTuple(itemId, qtyJson, unit));
      sheetsStored.push(api.normalizeRecipeIngredientTuple(itemId, qtyNum, unit));
    }
    expect(api.recipeIngredientsUnchanged(jsonIncoming, sheetsStored)).toBe(true);
  });
});

describe('purity — no Apps Script globals referenced by the four new helpers', function () {
  var FORBIDDEN = /SpreadsheetApp|LockService|Session\.|Utilities\.|CacheService/;
  var HELPER_NAMES = [
    'formatPaddedId',
    'maxIdNumFromColumn',
    'normalizeRecipeIngredientTuple',
    'recipeIngredientsUnchanged'
  ];

  HELPER_NAMES.forEach(function (name) {
    test(name + ' source contains no Apps Script globals', function () {
      var src = rawSource();
      var fnSrc = sliceFunctionSource(src, name);
      expect(fnSrc).not.toBeNull();
      expect(fnSrc).not.toMatch(FORBIDDEN);
    });
  });
});

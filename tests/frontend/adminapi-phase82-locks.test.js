'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file (same technique as adminapi-giftcard-ledger.test.js, Phase 51's
// precedent) and evaluates it via `new Function` to extract just the pure helper function
// under test (`batchDedupDecision`).
//
// WHAT THIS SUITE CANNOT PROVE: it never touches a Sheets write or the real LockService. It
// exercises `batchDedupDecision` as a pure function, and asserts on the RAW TEXT of adminApi.gs
// for the lock-ordering shape of `createBatch` and `updateGiftCardInvoice` (D-18). It cannot
// observe a real concurrent request racing the lock — that is only verifiable against the live
// Apps Script runtime (out of scope for this repo's Jest harness, same limitation documented in
// adminapi-giftcard-ledger.test.js).

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var _cachedApi = null;

function loadAdminApi() {
  if (_cachedApi) return _cachedApi;
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  // Each property uses a `typeof` guard so this factory itself never throws a ReferenceError
  // when the helper hasn't been implemented yet (RED stage) — instead the property is
  // `undefined`, and the individual test that calls it fails with a clear
  // "api.batchDedupDecision is not a function" naming the specific helper.
  var factory = new Function(
    src + '\nreturn {' +
      'batchDedupDecision: (typeof batchDedupDecision !== "undefined" ? batchDedupDecision : undefined)' +
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

// Evaluates ONLY the raw file body (no trailing `return { ... }`) so this is a pure
// syntax/executability check on adminApi.gs itself.
function evaluateSourceOnly() {
  var src = rawSource();
  var fn = new Function(src);
  fn();
}

// Slice a named function's source text by locating `function <name>(` and brace-matching to
// its closing brace. Copied verbatim from adminapi-giftcard-ledger.test.js.
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

// Builds a Batches row fixture shaped like what sheetToObjects() returns for the fields
// batchDedupDecision cares about.
function batchRow(overrides) {
  var row = {
    batch_id: 'SV-B-000001',
    zoho_so_number: 'INV-001',
    product_sku: 'SKU-A'
  };
  if (overrides) {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) row[k] = overrides[k];
    }
  }
  return row;
}

describe('adminApi.gs — whole-file evaluation (syntax gate)', function () {
  test('adminApi.gs parses and evaluates without throwing', function () {
    expect(function () { evaluateSourceOnly(); }).not.toThrow();
  });
});

describe('batchDedupDecision — invoice+SKU with unit_total', function () {
  test('0, 1, or 2 matching rows all allow (unit_total:3) — returns null', function () {
    var api = loadAdminApi();
    var payload = { zoho_so_number: 'INV-001', product_sku: 'SKU-A', unit_total: 3 };
    expect(api.batchDedupDecision([], payload)).toBeNull();
    expect(api.batchDedupDecision([batchRow()], payload)).toBeNull();
    expect(api.batchDedupDecision(
      [batchRow({ batch_id: 'SV-B-000001' }), batchRow({ batch_id: 'SV-B-000002' })],
      payload
    )).toBeNull();
  });

  test('3 matching rows (unit_total:3) — returns duplicate_so_number listing the matching batch_ids', function () {
    var api = loadAdminApi();
    var payload = { zoho_so_number: 'INV-001', product_sku: 'SKU-A', unit_total: 3 };
    var rows = [
      batchRow({ batch_id: 'SV-B-000001' }),
      batchRow({ batch_id: 'SV-B-000002' }),
      batchRow({ batch_id: 'SV-B-000003' })
    ];
    var result = api.batchDedupDecision(rows, payload);
    expect(result).not.toBeNull();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('duplicate_so_number');
    expect(result.message).toMatch(/SV-B-000001/);
    expect(result.message).toMatch(/SV-B-000002/);
    expect(result.message).toMatch(/SV-B-000003/);
  });

  test('no unit_total (legacy) — 1 matching row is duplicate, 0 matching rows is allowed', function () {
    var api = loadAdminApi();
    var payload = { zoho_so_number: 'INV-001', product_sku: 'SKU-A' };
    expect(api.batchDedupDecision([], payload)).toBeNull();
    var result = api.batchDedupDecision([batchRow()], payload);
    expect(result).not.toBeNull();
    expect(result.error).toBe('duplicate_so_number');
  });

  test('a different SKU (SKU-B) is independent of SKU-A rows on the same invoice — returns null', function () {
    var api = loadAdminApi();
    var payload = { zoho_so_number: 'INV-001', product_sku: 'SKU-B', unit_total: 3 };
    var rows = [batchRow({ product_sku: 'SKU-A' }), batchRow({ product_sku: 'SKU-A', batch_id: 'SV-B-000002' })];
    expect(api.batchDedupDecision(rows, payload)).toBeNull();
  });
});

describe('batchDedupDecision — invoice-only fallback (no product_sku)', function () {
  test('a matching row on the same invoice — returns duplicate_so_number', function () {
    var api = loadAdminApi();
    var payload = { zoho_so_number: 'INV-9' };
    var rows = [batchRow({ zoho_so_number: 'INV-9', batch_id: 'SV-B-000009' })];
    var result = api.batchDedupDecision(rows, payload);
    expect(result).not.toBeNull();
    expect(result.error).toBe('duplicate_so_number');
    expect(result.message).toMatch(/SV-B-000009/);
  });
});

describe('batchDedupDecision — no zoho_so_number', function () {
  test('an empty payload always returns null', function () {
    var api = loadAdminApi();
    expect(api.batchDedupDecision([batchRow()], {})).toBeNull();
  });
});

describe('batchDedupDecision — purity (no Apps Script globals or sheet reads)', function () {
  test('source references neither SpreadsheetApp, LockService, CacheService, nor sheetToObjects', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'batchDedupDecision');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).not.toMatch(/SpreadsheetApp|LockService|CacheService|sheetToObjects/);
  });
});

describe('createBatch — D-18 lock-ordering (source shape)', function () {
  test('acquireScriptLock(15000) precedes batchDedupDecision( inside createBatch', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'createBatch');
    expect(fnSrc).not.toBeNull();
    var lockIdx = fnSrc.indexOf('acquireScriptLock(15000)');
    var dedupIdx = fnSrc.indexOf('batchDedupDecision(');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(dedupIdx);
  });

  test("sheetToObjects(BATCHES_SHEET_NAME, true) appears after the lock inside createBatch", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'createBatch');
    var lockIdx = fnSrc.indexOf('acquireScriptLock(15000)');
    var skipCacheReadIdx = fnSrc.indexOf('sheetToObjects(BATCHES_SHEET_NAME, true)');
    expect(skipCacheReadIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(skipCacheReadIdx);
  });

  test('the old pre-lock unqualified read is gone: zero occurrences of var existingBatches = sheetToObjects(BATCHES_SHEET_NAME);', function () {
    var src = rawSource();
    expect(src).not.toMatch(/var existingBatches\s*=\s*sheetToObjects\(BATCHES_SHEET_NAME\);/);
    expect(src).not.toMatch(/var existingBatches2\s*=\s*sheetToObjects\(BATCHES_SHEET_NAME\);/);
  });

  test('exactly one function batchDedupDecision( definition exists in the file', function () {
    var src = rawSource();
    var matches = src.match(/function batchDedupDecision\(/g) || [];
    expect(matches.length).toBe(1);
  });
});

describe('updateGiftCardInvoice — D-18 lock (source shape)', function () {
  test('acquireScriptLock(15000) precedes findRowById(GIFT_CARDS_SHEET_NAME inside updateGiftCardInvoice', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'updateGiftCardInvoice');
    expect(fnSrc).not.toBeNull();
    var lockIdx = fnSrc.indexOf('acquireScriptLock(15000)');
    var findIdx = fnSrc.indexOf('findRowById(GIFT_CARDS_SHEET_NAME');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(findIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(findIdx);
  });

  test('contains a finally block that releases the lock', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'updateGiftCardInvoice');
    expect(fnSrc).toMatch(/finally/);
    expect(fnSrc).toMatch(/lock\.releaseLock\(\)/);
  });
});

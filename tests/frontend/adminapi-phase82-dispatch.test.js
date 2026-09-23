'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file (same technique as adminapi-giftcard-ledger.test.js /
// adminapi-phase82-locks.test.js) and evaluates it via `new Function` to extract only the pure
// helper function under test (`_uniqueBatchIds`). Everything else here is a source-shape
// assertion on the raw text of `doPost`, `updateBatchTask`, and `bulkUpdateBatchTasks` — it
// cannot observe a real Apps Script HTTP round-trip or a real cache bust.
//
// Loader/slicer copied verbatim from adminapi-giftcard-ledger.test.js / adminapi-phase82-locks
// per the plan's explicit instruction not to import test helpers across test files.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var _cachedApi = null;

function loadAdminApi() {
  if (_cachedApi) return _cachedApi;
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var factory = new Function(
    src + '\nreturn {' +
      '_uniqueBatchIds: (typeof _uniqueBatchIds !== "undefined" ? _uniqueBatchIds : undefined)' +
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

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

// Scopes assertions to the server_token if-chain inside doPost, between the
// `if (payload.server_token) {` guard and the final `Unknown server action` fallback.
function serverTokenSubBlock() {
  var src = rawSource();
  var doPostSrc = sliceFunctionSource(src, 'doPost');
  var startMarker = 'if (payload.server_token) {';
  var endMarker = 'Unknown server action';
  var start = doPostSrc.indexOf(startMarker);
  var end = doPostSrc.indexOf(endMarker);
  if (start === -1 || end === -1) return null;
  return doPostSrc.slice(start, end);
}

// Scopes assertions to the staff switch (the block after `var authResult = checkAuthorization`).
function staffSwitchBlock() {
  var src = rawSource();
  var doPostSrc = sliceFunctionSource(src, 'doPost');
  var startMarker = 'switch (action) {';
  var start = doPostSrc.indexOf(startMarker);
  if (start === -1) return null;
  return doPostSrc.slice(start);
}

describe('adminApi.gs — whole-file evaluation (syntax gate)', function () {
  test('adminApi.gs parses and evaluates without throwing', function () {
    expect(function () { evaluateSourceOnly(); }).not.toThrow();
  });
});

describe('doPost server_token branch — D-11 seven new admin-write entries', function () {
  var expectedActions = [
    'update_reservation',
    'update_hold',
    'update_homepage',
    'add_batch_task',
    'update_batch_task',
    'propagate_ferm_schedule',
    'regenerate_batch_token'
  ];

  expectedActions.forEach(function (action) {
    test("server_token branch contains exactly one action === '" + action + "'", function () {
      var block = serverTokenSubBlock();
      expect(block).not.toBeNull();
      var needle = "action === '" + action + "'";
      expect(countOccurrences(block, needle)).toBe(1);
    });
  });

  var actorArgActions = [
    'update_reservation',
    'update_hold',
    'add_batch_task',
    'update_batch_task',
    'propagate_ferm_schedule'
  ];

  actorArgActions.forEach(function (action) {
    test("server_token dispatch of '" + action + "' passes the literal 'middleware' as the actor argument", function () {
      var block = serverTokenSubBlock();
      var actionIdx = block.indexOf("action === '" + action + "'");
      expect(actionIdx).toBeGreaterThan(-1);
      // Scan a generous window after the action check for the handler call + its args.
      var window = block.slice(actionIdx, actionIdx + 400);
      expect(window).toMatch(/'middleware'/);
    });
  });

  test('does not add read actions here — no get_ handler calls appear in the new admin-write block comment region', function () {
    var block = serverTokenSubBlock();
    // The Phase 82 D-11 block is introduced by its own comment; slice from there onward.
    var markerIdx = block.indexOf('Phase 82 D-11');
    expect(markerIdx).toBeGreaterThan(-1);
    var newBlock = block.slice(markerIdx);
    expect(newBlock).not.toMatch(/handleReadAction/);
  });
});

describe('doPost staff switch — no case removed (D-19, old browser path stays live)', function () {
  var preservedCases = [
    'update_reservation',
    'update_hold',
    'update_homepage',
    'add_batch_task',
    'update_batch_task',
    'propagate_ferm_schedule',
    'regenerate_batch_token'
  ];

  preservedCases.forEach(function (action) {
    test("staff switch still contains case '" + action + "'", function () {
      var block = staffSwitchBlock();
      expect(block).not.toBeNull();
      expect(block).toMatch(new RegExp("case '" + action + "':"));
    });
  });
});

describe('_uniqueBatchIds — pure helper', function () {
  test('de-duplicates, preserves order, and drops falsy-ok / empty batch_id entries', function () {
    var api = loadAdminApi();
    var results = [
      { ok: true, batch_id: 'SV-B-000001' },
      { ok: true, batch_id: 'SV-B-000002' },
      { ok: true, batch_id: 'SV-B-000001' },
      { ok: false, batch_id: 'SV-B-000003' },
      { ok: true }
    ];
    expect(api._uniqueBatchIds(results)).toEqual(['SV-B-000001', 'SV-B-000002']);
  });

  test('empty array returns []', function () {
    var api = loadAdminApi();
    expect(api._uniqueBatchIds([])).toEqual([]);
  });

  test('undefined input returns [] (tolerant of non-array input)', function () {
    var api = loadAdminApi();
    expect(api._uniqueBatchIds(undefined)).toEqual([]);
  });
});

describe('updateBatchTask — D-09 server half: success return includes batch_id', function () {
  test("final success return contains 'batch_id:'", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'updateBatchTask');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toMatch(/batch_id:/);
  });
});

describe('bulkUpdateBatchTasks — D-09 server half: per-batch cache-bust', function () {
  test('calls _uniqueBatchIds( and _invalidateBatchCache( and returns affected_batch_ids', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'bulkUpdateBatchTasks');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toMatch(/_uniqueBatchIds\(/);
    expect(fnSrc).toMatch(/_invalidateBatchCache\(/);
    expect(fnSrc).toMatch(/affected_batch_ids/);
  });
});

describe('doPost update_batch_task dispatch sites bust the task\'s own batch (D-09)', function () {
  test('server_token entry invalidates r.batch_id || payload.batch_id (or the equivalent result variable)', function () {
    var block = serverTokenSubBlock();
    var actionIdx = block.indexOf("action === 'update_batch_task'");
    expect(actionIdx).toBeGreaterThan(-1);
    var window = block.slice(actionIdx, actionIdx + 500);
    expect(window).toMatch(/_invalidateBatchCache\(\s*\w+\.batch_id\s*\|\|\s*payload\.batch_id\s*\)/);
  });

  test("staff switch case 'update_batch_task' invalidates r.batch_id || payload.batch_id", function () {
    var block = staffSwitchBlock();
    var caseIdx = block.indexOf("case 'update_batch_task':");
    expect(caseIdx).toBeGreaterThan(-1);
    var window = block.slice(caseIdx, caseIdx + 400);
    expect(window).toMatch(/_invalidateBatchCache\(\s*\w+\.batch_id\s*\|\|\s*payload\.batch_id\s*\)/);
  });
});

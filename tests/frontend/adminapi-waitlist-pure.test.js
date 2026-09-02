'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file (same technique as adminapi-giftcard-ledger.test.js, Phase 51's
// precedent) and evaluates it via `new Function` to extract just the pure helper functions
// under test.
//
// WHAT THIS SUITE CANNOT PROVE: it never touches a Sheets write. It exercises
// normalizeWaitlistEmail / waitlistCellSafe / waitlistSyncedTrue / waitlistDedupeDecision as
// pure functions, and asserts on the RAW TEXT of adminApi.gs for everything else (the sheet
// constant, ensureWaitlistSheet's header shape, purity of the four helpers, the three handlers'
// existence/shape, and the doPost/handleReadAction dispatch wiring). It cannot observe
// ensureWaitlistSheet, addWaitlistEntry, getWaitlist or updateWaitlistStatus actually reading or
// writing a Sheets row — those are asserted by source shape only. Their real behaviour is proven
// by the live probe in plan 78-04, after the owner's manual Apps Script redeploy.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

var _cachedApi = null;

function loadAdminApi() {
  if (_cachedApi) return _cachedApi;
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  // Each property uses a `typeof` guard so this factory itself never throws a ReferenceError
  // when a helper hasn't been implemented yet — instead the property is `undefined`, and the
  // individual test that calls it fails with a clear "api.<name> is not a function" naming that
  // specific helper, rather than every test in the file failing identically.
  var factory = new Function(
    src + '\nreturn {' +
      'normalizeWaitlistEmail: (typeof normalizeWaitlistEmail !== "undefined" ? normalizeWaitlistEmail : undefined),' +
      'waitlistCellSafe: (typeof waitlistCellSafe !== "undefined" ? waitlistCellSafe : undefined),' +
      'waitlistSyncedTrue: (typeof waitlistSyncedTrue !== "undefined" ? waitlistSyncedTrue : undefined),' +
      'waitlistDedupeDecision: (typeof waitlistDedupeDecision !== "undefined" ? waitlistDedupeDecision : undefined)' +
      '};'
  );
  _cachedApi = factory();
  return _cachedApi;
}

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

// Evaluates ONLY the raw file body (no trailing `return { ... }` referencing helpers that may
// not exist yet) so this is a pure syntax/executability check on adminApi.gs itself.
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

// Builds a Waitlist row fixture shaped exactly like what sheetToObjects() returns: string keys
// from the 7-column header row.
function waitlistRow(overrides) {
  var row = {
    id: 'uuid-0001',
    email: 'jane@example.com',
    category: 'beer',
    status: 'waiting',
    signed_up_at: '2026-09-02T00:00:00.000Z',
    mailerlite_synced: false,
    notes: '',
    _row: 2
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

describe('normalizeWaitlistEmail', function () {
  test("'  Jane@Example.COM ' -> 'jane@example.com' (trim + lowercase)", function () {
    var api = loadAdminApi();
    expect(api.normalizeWaitlistEmail('  Jane@Example.COM ')).toBe('jane@example.com');
  });

  test('null / undefined / empty string -> empty string', function () {
    var api = loadAdminApi();
    expect(api.normalizeWaitlistEmail(null)).toBe('');
    expect(api.normalizeWaitlistEmail(undefined)).toBe('');
    expect(api.normalizeWaitlistEmail('')).toBe('');
  });

  test("a leading apostrophe (formula-injection escape char) is stripped before normalizing: \"'jane@example.com\" -> 'jane@example.com'", function () {
    var api = loadAdminApi();
    expect(api.normalizeWaitlistEmail("'jane@example.com")).toBe('jane@example.com');
  });

  test('only ONE leading apostrophe is stripped, not all of them', function () {
    var api = loadAdminApi();
    expect(api.normalizeWaitlistEmail("''jane@example.com")).toBe("'jane@example.com");
  });
});

describe('waitlistCellSafe', function () {
  test.each([
    ['=IMPORTRANGE("x","y")'],
    ['+1'],
    ['-1'],
    ['@sum']
  ])('%p gains a leading apostrophe', function (value) {
    var api = loadAdminApi();
    var result = api.waitlistCellSafe(value);
    expect(result.charAt(0)).toBe("'");
  });

  test('ordinary text is returned unchanged', function () {
    var api = loadAdminApi();
    expect(api.waitlistCellSafe('Please call after 5pm')).toBe('Please call after 5pm');
  });

  test('an ordinary email is returned unchanged', function () {
    var api = loadAdminApi();
    expect(api.waitlistCellSafe('jane@example.com')).toBe('jane@example.com');
  });
});

describe('waitlistSyncedTrue', function () {
  test.each([
    [true], ['TRUE'], ['true'], [1], ['1']
  ])('%p -> true', function (value) {
    var api = loadAdminApi();
    expect(api.waitlistSyncedTrue(value)).toBe(true);
  });

  test.each([
    [false], ['FALSE'], [''], [null], [undefined], ['no']
  ])('%p -> false', function (value) {
    var api = loadAdminApi();
    expect(api.waitlistSyncedTrue(value)).toBe(false);
  });
});

describe('waitlistDedupeDecision', function () {
  test('first-ever signup (empty rows) -> new, row null', function () {
    var api = loadAdminApi();
    var result = api.waitlistDedupeDecision([], 'jane@example.com', 'beer');
    expect(result.action).toBe('new');
    expect(result.row).toBeNull();
  });

  test('exact duplicate email+category -> existing, row = the matching row object', function () {
    var api = loadAdminApi();
    var row = waitlistRow();
    var result = api.waitlistDedupeDecision([row], 'jane@example.com', 'beer');
    expect(result.action).toBe('existing');
    expect(result.row).toEqual(row);
  });

  test('same email with a DIFFERENT category -> new', function () {
    var api = loadAdminApi();
    var rows = [waitlistRow({ category: 'beer' })];
    var result = api.waitlistDedupeDecision(rows, 'jane@example.com', 'cider');
    expect(result.action).toBe('new');
    expect(result.row).toBeNull();
  });

  test('case and surrounding-whitespace variance still matches: " Jane@Example.COM "', function () {
    var api = loadAdminApi();
    var rows = [waitlistRow({ email: 'jane@example.com', category: 'beer' })];
    var result = api.waitlistDedupeDecision(rows, ' Jane@Example.COM ', 'beer');
    expect(result.action).toBe('existing');
  });

  test('a stored email written with the leading-apostrophe escape still matches the plain input', function () {
    var api = loadAdminApi();
    var rows = [waitlistRow({ email: "'jane@example.com", category: 'beer' })];
    var result = api.waitlistDedupeDecision(rows, 'jane@example.com', 'beer');
    expect(result.action).toBe('existing');
  });

  test('empty/null email returns new with row null even when rows is non-empty', function () {
    var api = loadAdminApi();
    var rows = [waitlistRow()];
    expect(api.waitlistDedupeDecision(rows, '', 'beer').action).toBe('new');
    expect(api.waitlistDedupeDecision(rows, '', 'beer').row).toBeNull();
    expect(api.waitlistDedupeDecision(rows, null, 'beer').action).toBe('new');
  });

  test("a matching row whose status is 'removed' still returns existing — re-signup must not duplicate a removed row", function () {
    var api = loadAdminApi();
    var rows = [waitlistRow({ status: 'removed' })];
    var result = api.waitlistDedupeDecision(rows, 'jane@example.com', 'beer');
    expect(result.action).toBe('existing');
  });
});

describe('source assertions — the honest substitute for an end-to-end test', function () {
  // These prove the file's SHAPE (constant declared once, header order, purity of the four
  // helpers). They do NOT prove a Sheets write ever happens correctly; see the file header
  // comment above.

  test("WAITLIST_SHEET_NAME is declared exactly once with literal 'Waitlist'", function () {
    var src = rawSource();
    var matches = src.match(/var\s+WAITLIST_SHEET_NAME\s*=\s*'Waitlist'\s*;/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);
  });

  describe('purity — no Apps Script globals referenced by the four pure helpers', function () {
    var FORBIDDEN = /SpreadsheetApp|LockService|Session|CacheService|Logger/;
    var HELPER_NAMES = [
      'normalizeWaitlistEmail',
      'waitlistCellSafe',
      'waitlistSyncedTrue',
      'waitlistDedupeDecision'
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

  test('ensureWaitlistSheet declares the 7 header names in the exact documented order', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'ensureWaitlistSheet');
    expect(fnSrc).not.toBeNull();
    var normalized = fnSrc.replace(/\s+/g, ' ');
    expect(normalized).toMatch(
      /'id'\s*,\s*'email'\s*,\s*'category'\s*,\s*'status'\s*,\s*'signed_up_at'\s*,\s*'mailerlite_synced'\s*,\s*'notes'/
    );
  });

  test("ensureWaitlistSheet fails closed with the literal 'waitlist_unavailable' on header drift and never repairs/reorders an existing header row", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'ensureWaitlistSheet');
    expect(fnSrc).toMatch(/insertSheet\(/);
    expect(fnSrc).toMatch(/'waitlist_unavailable'/);
    expect(fnSrc).not.toMatch(/setValue/);
  });
});

describe('bootstrap helpers — source-shape assertions only (cannot be invoked outside Google)', function () {
  var IO_HELPER_NAMES = ['ensureWaitlistSheet', 'setupWaitlist'];

  IO_HELPER_NAMES.forEach(function (name) {
    test(name + ' exists as a top-level function', function () {
      var src = rawSource();
      expect(sliceFunctionSource(src, name)).not.toBeNull();
    });
  });

  test('setupWaitlist calls ensureWaitlistSheet(', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'setupWaitlist');
    expect(fnSrc).toMatch(/ensureWaitlistSheet\(/);
  });
});

// ─── 78-01 Task 2: handlers (add / list / update) + dispatch wiring ─────────────────────────
// These handlers touch SpreadsheetApp and cannot be executed in Jest — source-shape assertions
// are the only automatable check available. Their real behaviour is proven by the live probe in
// plan 78-04, after the owner's manual Apps Script redeploy.

describe('waitlist handlers — existence + source-shape assertions only (cannot be invoked outside Google)', function () {
  var HANDLER_NAMES = ['addWaitlistEntry', 'getWaitlist', 'updateWaitlistStatus'];

  HANDLER_NAMES.forEach(function (name) {
    test(name + ' exists as a top-level function', function () {
      var src = rawSource();
      expect(sliceFunctionSource(src, name)).not.toBeNull();
    });
  });

  ['addWaitlistEntry', 'updateWaitlistStatus'].forEach(function (name) {
    test(name + ' body contains no occurrence of acquireScriptLock — no lock needed (RESEARCH.md Pitfall 5)', function () {
      var src = rawSource();
      var fnSrc = sliceFunctionSource(src, name);
      expect(fnSrc).not.toMatch(/acquireScriptLock/);
    });
  });

  test('addWaitlistEntry body contains waitlistDedupeDecision( and Utilities.getUuid(', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'addWaitlistEntry');
    expect(fnSrc).toMatch(/waitlistDedupeDecision\(/);
    expect(fnSrc).toMatch(/Utilities\.getUuid\(\)/);
  });

  test("addWaitlistEntry never discloses membership — body contains no occurrence of 'already' or 'duplicate' (D-06 non-disclosure)", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'addWaitlistEntry');
    expect(fnSrc).not.toMatch(/already/i);
    expect(fnSrc).not.toMatch(/duplicate/i);
  });

  test('updateWaitlistStatus body contains headers.indexOf( and the four D-05 status literals', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'updateWaitlistStatus');
    expect(fnSrc).toMatch(/headers\.indexOf\(/);
    expect(fnSrc).toMatch(/'waiting'/);
    expect(fnSrc).toMatch(/'contacted'/);
    expect(fnSrc).toMatch(/'booked'/);
    expect(fnSrc).toMatch(/'removed'/);
  });

  test("getWaitlist body does not contain _cachedGet and does not contain '_row'", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'getWaitlist');
    expect(fnSrc).not.toMatch(/_cachedGet/);
    expect(fnSrc).not.toMatch(/_row/);
  });
});

describe('dispatch wiring — doPost / handleReadAction', function () {
  test("doPost source contains action === 'add_waitlist_entry' and action === 'update_waitlist_status', both AFTER the first occurrence of payload.server_token (inside the validated block)", function () {
    var src = rawSource();
    var serverTokenIdx = src.indexOf('payload.server_token');
    var addIdx = src.indexOf("action === 'add_waitlist_entry'");
    var updateIdx = src.indexOf("action === 'update_waitlist_status'");
    expect(serverTokenIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(serverTokenIdx);
    expect(updateIdx).toBeGreaterThan(serverTokenIdx);
  });

  test("handleReadAction source contains case 'get_waitlist':", function () {
    var src = rawSource();
    expect(src).toMatch(/case 'get_waitlist':/);
  });
});

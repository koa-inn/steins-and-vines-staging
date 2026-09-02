'use strict';

// apps-script/adminApi.gs runs inside Google's Apps Script environment (SpreadsheetApp,
// LockService, Session, Utilities, CacheService are all Apps Script globals with no local
// implementation). This harness does NOT stub those globals or provide a fake Sheets runtime —
// it loads the REAL file (same technique as adminapi-recipe-pure.test.js, Phase 79's precedent)
// and evaluates it via `new Function` to extract just the pure helper functions under test.
//
// WHAT THIS SUITE CANNOT PROVE: it never touches a Sheets write. It exercises
// `giftCardLedgerDecision` (and its three small helpers) as pure functions, and asserts on the
// RAW TEXT of adminApi.gs for everything else (purity of the four helpers, the sheet-name
// constant, the unchanged GiftCards schema). It cannot observe `ensureGiftCardLedgerSheet`,
// `appendGiftCardClaim`, `settleGiftCardClaim` or `flagGiftCardClaim` actually writing a row —
// those are asserted by source-shape only in Task 3. `redeemGiftCard`/`reloadGiftCard` are not
// modified until 51-02 and are not tested here at all.
//
// WHY NOT THE MIDDLEWARE SUITE: zoho-middleware/__tests__/pos-gift-card.test.js:18-21 does
// `jest.mock('axios', ...)` before any test runs, so every middleware gift-card test asserts
// "the middleware called axios.post with the right JSON body," never "the Apps Script side
// actually wrote the Sheets row correctly, once, atomically." No test in this repo can reach a
// real Sheets write — the honest response (D-02/51-CONTEXT.md) is to extract as much of the
// idempotency DECISION as possible into a pure function and hammer that here; the rest is
// verified by the 51-03 live probe against a real Google Sheet.
//
// A green run of this file is NOT proof the money path is fixed. It is proof the DECISION LOGIC
// is correct; the claim-before-mutate write ordering and durable needs_manual_review persistence
// are unverifiable outside Google's runtime.

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
      'normalizeCertNumber: (typeof normalizeCertNumber !== "undefined" ? normalizeCertNumber : undefined),' +
      'roundGiftCardAmount: (typeof roundGiftCardAmount !== "undefined" ? roundGiftCardAmount : undefined),' +
      'ledgerFlagTrue: (typeof ledgerFlagTrue !== "undefined" ? ledgerFlagTrue : undefined),' +
      'giftCardLedgerDecision: (typeof giftCardLedgerDecision !== "undefined" ? giftCardLedgerDecision : undefined)' +
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
// itself, independent of whether the four new helpers exist yet.
function evaluateSourceOnly() {
  var src = rawSource();
  var fn = new Function(src);
  fn();
}

// Slice a named function's source text by locating `function <name>(` and brace-matching to
// its closing brace. Used by the purity assertion and the GiftCards-schema-unchanged assertion.
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

// Builds a ledger row fixture shaped exactly like what sheetToObjects() (adminApi.gs:1422-1454)
// returns: string keys from the 12-column GiftCardTransactions header row, plus a numeric _row.
function ledgerRow(overrides) {
  var row = {
    tx_id: 'TX-0000001',
    cert_number: 'GC-000001',
    tx_ref: 'KIOSK-1000',
    kind: 'redeem',
    amount: 10,
    balance_before: 50,
    balance_after: '',
    status: 'claimed',
    needs_manual_review: false,
    created_at: '2026-09-02T00:00:00.000Z',
    settled_at: '',
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

describe('normalizeCertNumber', function () {
  test("'  gc-000001 ' -> 'GC-000001' (trim + uppercase)", function () {
    var api = loadAdminApi();
    expect(api.normalizeCertNumber('  gc-000001 ')).toBe('GC-000001');
  });

  test('null / undefined / empty string -> empty string', function () {
    var api = loadAdminApi();
    expect(api.normalizeCertNumber(null)).toBe('');
    expect(api.normalizeCertNumber(undefined)).toBe('');
    expect(api.normalizeCertNumber('')).toBe('');
  });

  test('a number 5 -> the string "5"', function () {
    var api = loadAdminApi();
    expect(api.normalizeCertNumber(5)).toBe('5');
  });
});

describe('roundGiftCardAmount', function () {
  test('10.005 lands on a value already rounded to 2 decimals (idempotent under re-rounding)', function () {
    var api = loadAdminApi();
    var result = api.roundGiftCardAmount(10.005);
    expect(api.roundGiftCardAmount(result)).toBe(result);
  });

  test('20 - 9.995 (float noise) lands on a value already rounded to 2 decimals', function () {
    var api = loadAdminApi();
    var result = api.roundGiftCardAmount(20 - 9.995);
    expect(api.roundGiftCardAmount(result)).toBe(result);
  });

  test('0.1 + 0.2 -> 0.3 exactly (the canonical float-drift case)', function () {
    var api = loadAdminApi();
    expect(api.roundGiftCardAmount(0.1 + 0.2)).toBe(0.3);
  });
});

describe('ledgerFlagTrue', function () {
  test.each([
    [true], ['TRUE'], ['true'], [' Yes '], ['y'], [1], ['1']
  ])('%p -> true', function (value) {
    var api = loadAdminApi();
    expect(api.ledgerFlagTrue(value)).toBe(true);
  });

  test.each([
    [false], [''], ['FALSE'], ['no'], [null], [undefined], [0]
  ])('%p -> false', function (value) {
    var api = loadAdminApi();
    expect(api.ledgerFlagTrue(value)).toBe(false);
  });
});

describe('giftCardLedgerDecision', function () {
  test('empty rows array -> proceed, row null, unsettled false', function () {
    var api = loadAdminApi();
    var result = api.giftCardLedgerDecision([], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('proceed');
    expect(result.row).toBeNull();
    expect(result.unsettled).toBe(false);
  });

  test('rows for a DIFFERENT cert only (even a claimed one) do not affect this cert -> proceed', function () {
    var api = loadAdminApi();
    var rows = [ledgerRow({ cert_number: 'GC-000099', tx_ref: 'KIOSK-OTHER', status: 'claimed' })];
    var result = api.giftCardLedgerDecision(rows, 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('proceed');
    expect(result.unsettled).toBe(false);
  });

  test('cert matching is via normalizeCertNumber on both sides — whitespace/case do not create false negatives', function () {
    var api = loadAdminApi();
    var rows = [ledgerRow({ cert_number: 'GC-000001', tx_ref: 'KIOSK-OLD', status: 'settled' })];
    var result = api.giftCardLedgerDecision(rows, ' gc-000001 ', 'KIOSK-OLD');
    expect(result.action).toBe('replay');
  });

  test('a settled row matching cert+ref -> replay, row = that row (criterion-6: interleaved retry of the identical ref)', function () {
    var api = loadAdminApi();
    var settledRow = ledgerRow({ status: 'settled', tx_ref: 'KIOSK-1000', settled_at: '2026-09-02T00:01:00.000Z' });
    var result = api.giftCardLedgerDecision([settledRow], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('replay');
    expect(result.row).toEqual(settledRow);
  });

  // The consumed-ref rule: a tx_ref that already appears anywhere in the ledger has been consumed,
  // regardless of what the row's status was edited to (short of deleting the row entirely).
  // Without this rule the staff escape hatch below would silently un-protect the exact ref it
  // just rescued. This is the block the acceptance criteria call out explicitly.
  ['resolved', '', 'a-typo-value'].forEach(function (status) {
    test('SAME cert AND SAME tx_ref, status "' + status + '" -> replay, NOT proceed (consumed-ref rule survives an escape-hatch status edit)', function () {
      var api = loadAdminApi();
      var row = ledgerRow({ status: status, tx_ref: 'KIOSK-1000' });
      var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-1000');
      expect(result.action).toBe('replay');
      expect(result.action).not.toBe('proceed');
    });
  });

  test('SAME cert AND SAME tx_ref, status "cleared" (arbitrary non-claimed value) -> replay', function () {
    var api = loadAdminApi();
    var row = ledgerRow({ status: 'cleared', tx_ref: 'KIOSK-1000' });
    var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('replay');
  });

  test('a claimed row for the cert with a DIFFERENT tx_ref, no settled match -> blocked, row = claimed row, unsettled true (the D-12 case)', function () {
    var api = loadAdminApi();
    var claimedRow = ledgerRow({ status: 'claimed', tx_ref: 'KIOSK-OLD' });
    var result = api.giftCardLedgerDecision([claimedRow], 'GC-000001', 'KIOSK-NEW');
    expect(result.action).toBe('blocked');
    expect(result.row).toEqual(claimedRow);
    expect(result.unsettled).toBe(true);
  });

  test('same fixture (claimed row, different ref) with status changed to "resolved" -> action is no longer blocked (escape hatch)', function () {
    var api = loadAdminApi();
    var row = ledgerRow({ status: 'resolved', tx_ref: 'KIOSK-OLD' });
    var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-NEW');
    expect(result.action).not.toBe('blocked');
  });

  test('a claimed row for the cert with the SAME tx_ref -> blocked (not replay) — balance may or may not have moved, fail closed', function () {
    var api = loadAdminApi();
    var claimedRow = ledgerRow({ status: 'claimed', tx_ref: 'KIOSK-1000' });
    var result = api.giftCardLedgerDecision([claimedRow], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('blocked');
    expect(result.action).not.toBe('replay');
    expect(result.unsettled).toBe(true);
  });

  test('a settled same-ref row AND a separate claimed row -> replay, with unsettled true so the caller can see the cert is dirty', function () {
    var api = loadAdminApi();
    var settledRow = ledgerRow({ tx_id: 'TX-0000001', status: 'settled', tx_ref: 'KIOSK-1000', _row: 2 });
    var claimedRow = ledgerRow({ tx_id: 'TX-0000002', status: 'claimed', tx_ref: 'KIOSK-2000', _row: 3 });
    var result = api.giftCardLedgerDecision([settledRow, claimedRow], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('replay');
    expect(result.unsettled).toBe(true);
  });

  // The staff escape hatch (D-12): editing the status cell clears the CARD-level block for a NEW
  // ref, without requiring a code change or redeploy. Blocking requires an exact 'claimed' match.
  ['resolved', 'RESOLVED', 'cleared', ''].forEach(function (status) {
    test('escape hatch: a claimed row edited to status "' + status + '" no longer blocks a NEW tx_ref', function () {
      var api = loadAdminApi();
      var row = ledgerRow({ status: status, tx_ref: 'KIOSK-OLD' });
      var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-NEW');
      expect(result.action).not.toBe('blocked');
    });
  });

  test('when the matching row is ABSENT entirely (deleted) -> proceed for that cert+ref (deletion is the only full reset)', function () {
    var api = loadAdminApi();
    var result = api.giftCardLedgerDecision([], 'GC-000001', 'KIOSK-1000');
    expect(result.action).toBe('proceed');
  });

  test('escape-hatch interaction: after a status edit, resubmitting the ORIGINAL ref stays replay-protected while a fresh ref proceeds', function () {
    var api = loadAdminApi();
    var row = ledgerRow({ status: 'resolved', tx_ref: 'KIOSK-OLD' });
    var replayResult = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-OLD');
    expect(replayResult.action).toBe('replay');
    var proceedResult = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-NEW');
    expect(proceedResult.action).toBe('proceed');
  });

  test('status matching is case- and whitespace-insensitive: " Claimed " still blocks', function () {
    var api = loadAdminApi();
    var row = ledgerRow({ status: ' Claimed ', tx_ref: 'KIOSK-OLD' });
    var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-NEW');
    expect(result.action).toBe('blocked');
  });

  test('a row missing the status key entirely is treated as not-claimed and does not block', function () {
    var api = loadAdminApi();
    var row = ledgerRow({ tx_ref: 'KIOSK-OLD' });
    delete row.status;
    var result = api.giftCardLedgerDecision([row], 'GC-000001', 'KIOSK-NEW');
    expect(result.action).not.toBe('blocked');
  });
});

describe('source assertions — the honest substitute for an end-to-end test', function () {
  // These prove the file's SHAPE (constant declared once, helpers stay Apps-Script-free, the
  // existing GiftCards schema is untouched). They do NOT prove a Sheets write ever happens
  // correctly; see the file header comment above.

  test("GIFT_CARD_TRANSACTIONS_SHEET_NAME is declared exactly once with literal 'GiftCardTransactions'", function () {
    var src = rawSource();
    var matches = src.match(/var\s+GIFT_CARD_TRANSACTIONS_SHEET_NAME\s*=\s*'GiftCardTransactions'\s*;/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBe(1);
  });

  describe('purity — no Apps Script globals referenced by the four new pure helpers', function () {
    var FORBIDDEN = /SpreadsheetApp|LockService|Session|CacheService|Logger/;
    var HELPER_NAMES = [
      'normalizeCertNumber',
      'roundGiftCardAmount',
      'ledgerFlagTrue',
      'giftCardLedgerDecision'
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

  test("the GiftCards 10-column appendRow schema in issueGiftCard is unchanged — this phase is additive and must not reshape the GiftCards tab", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'issueGiftCard');
    expect(fnSrc).not.toBeNull();
    var normalized = fnSrc.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ');
    expect(normalized).toMatch(
      /certNum\s*,\s*faceValue\s*,\s*faceValue\s*,\s*'active'\s*,\s*today\s*,\s*issuedBy\s*,\s*''\s*,\s*notes\s*,\s*now\s*,\s*''/
    );
  });
});

// The five ledger IO helpers (Task 3) touch SpreadsheetApp and cannot be invoked in this sandbox
// — see the file header comment. These are source-shape assertions only, the honest substitute
// for exercising the Sheets write itself; the 51-03 live probe is the real verification.
describe('ledger IO helpers — source-shape assertions only (cannot be invoked outside Google)', function () {
  var IO_HELPER_NAMES = [
    'ensureGiftCardLedgerSheet',
    'appendGiftCardClaim',
    'settleGiftCardClaim',
    'flagGiftCardClaim',
    'setupGiftCardLedger'
  ];

  IO_HELPER_NAMES.forEach(function (name) {
    test(name + ' exists as a top-level function', function () {
      var src = rawSource();
      expect(sliceFunctionSource(src, name)).not.toBeNull();
    });
  });

  test('appendGiftCardClaim mints tx_id via Utilities.getUuid( and does NOT use generateNextId( (Phase 79 O(n)-scan cost avoided)', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'appendGiftCardClaim');
    expect(fnSrc).toMatch(/Utilities\.getUuid\(/);
    expect(fnSrc).not.toMatch(/generateNextId\(/);
  });

  ['appendGiftCardClaim', 'settleGiftCardClaim', 'flagGiftCardClaim'].forEach(function (name) {
    test(name + ' invalidates the GiftCardTransactions sheet cache after writing', function () {
      var src = rawSource();
      var fnSrc = sliceFunctionSource(src, name);
      expect(fnSrc).toMatch(/invalidateSheetCache\(GIFT_CARD_TRANSACTIONS_SHEET_NAME\)/);
    });
  });

  test("ensureGiftCardLedgerSheet creates the tab via insertSheet( and fails closed with the literal 'ledger_unavailable' on header drift", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'ensureGiftCardLedgerSheet');
    expect(fnSrc).toMatch(/insertSheet\(/);
    expect(fnSrc).toMatch(/'ledger_unavailable'/);
  });

  test('ensureGiftCardLedgerSheet declares the 12 header names in the exact documented order', function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'ensureGiftCardLedgerSheet');
    var normalized = fnSrc.replace(/\s+/g, ' ');
    expect(normalized).toMatch(
      /'tx_id'\s*,\s*'cert_number'\s*,\s*'tx_ref'\s*,\s*'kind'\s*,\s*'amount'\s*,\s*'balance_before'\s*,\s*'balance_after'\s*,\s*'status'\s*,\s*'needs_manual_review'\s*,\s*'created_at'\s*,\s*'settled_at'\s*,\s*'notes'/
    );
  });

  test("flagGiftCardClaim writes the needs_manual_review column and routes noteText through sanitizeInput( — the persisted-flag half of D-08", function () {
    var src = rawSource();
    var fnSrc = sliceFunctionSource(src, 'flagGiftCardClaim');
    expect(fnSrc).toMatch(/col\.needs_manual_review/);
    expect(fnSrc).toMatch(/sanitizeInput\(/);
  });

  test('generateNextId( total count across the file is unchanged from its pre-plan value (13) — no existing call site was added or removed', function () {
    var src = rawSource();
    var matches = src.match(/generateNextId\(/g) || [];
    expect(matches.length).toBe(13);
  });
});

'use strict';

// ---------------------------------------------------------------------------
// reconcile-unconfirmed-void.test.js
//
// Regression coverage for a D-50-02b collision hole found by review after
// 50-01 Tasks 1-2 landed (phase 50 MONEY-02, roadmap SC#3 / T-50-02):
//
// ROOT DEFECT: lib/helcim.js voidTransaction() throws
//   new Error('Helcim void not confirmed (status=' + (data.status || 'none') + ')')
// The static wording avoids the four collision substrings
// (already/reversal/reversed/voided), but `data.status` is Helcim-controlled
// input interpolated verbatim into the message. A plausible real Helcim
// status such as 'reversal_pending', 'not_reversed', 'partially_voided', or
// 'already_processed' smuggles a collision substring back into err.message.
//
// lib/reconcile.js:149 isAlreadyVoidedError does a case-insensitive substring
// match on err.message BEFORE checking anything else, so it then returns
// true — misclassifying a genuinely UNCONFIRMED void as an "already voided
// by another path" success.
//
// Live blast radius (lib/reconcile.js:261-274): reconcilePendingCharge calls
// voidTransaction on an orphan charge; it rejects unconfirmed; isAlreadyVoidedError
// says "already voided"; reconcile clears the pending sentinel (cache.del) with
// NO sv:void-failure record and NO staff alert. The orphaned charge becomes
// permanently invisible — precisely the failure class T-50-02 exists to close,
// reintroduced through the error text.
//
// FIX: isAlreadyVoidedError checks err.isUnconfirmedVoid === true FIRST and
// returns false immediately — the flag set by voidTransaction is the reliable
// structural signal, not string content. Substring matching stays intact
// below the guard for the genuine already-voided 422 path.
//
// Case A MUST FAIL against pre-fix reconcile.js (the guard does not exist,
// so a status-smuggled message is misclassified as already-voided). Case B
// is the reconcile-level integration proof: on the unconfirmed-void path,
// the sv:void-failure record is persisted and the staff alert fires instead
// of the pending sentinel being silently cleared.
// ---------------------------------------------------------------------------

jest.mock('../lib/helcim');
jest.mock('../lib/mailer');
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(),
    del: jest.fn().mockResolvedValue(),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(),
    isConnected: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockResolvedValue({
      keys: jest.fn().mockResolvedValue([])
    })
  };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var helcimLib = require('../lib/helcim');
var mailer    = require('../lib/mailer');
var cache     = require('../lib/cache');
var C         = require('../lib/constants');
var reconcile = require('../lib/reconcile');

function deps() {
  return { helcim: helcimLib, mailer: mailer };
}

function oldPendingCtx(overrides) {
  return Object.assign({
    reference_number: 'KIOSK-UV-001',
    amount: 33.00,
    idempotency_key: 'idem-uv-001',
    created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()  // 15 min ago
  }, overrides || {});
}

// Simulates the exact error voidTransaction() constructs: static wording
// plus a Helcim-controlled status string interpolated verbatim, and the
// isUnconfirmedVoid flag D-50-02a sets on every unconfirmed rejection.
function makeUnconfirmedVoidError(helcimStatus) {
  var err = new Error('Helcim void not confirmed (status=' + helcimStatus + ')');
  err.isUnconfirmedVoid = true;
  err.helcimResponse = { status: helcimStatus };
  return err;
}

describe('isAlreadyVoidedError — D-50-02b structural guard', function () {
  beforeEach(function () {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case A: a genuinely unconfirmed void whose Helcim status happens to
  // contain a collision substring must NOT be classified as already-voided.
  // -------------------------------------------------------------------------
  test.each([
    'reversal_pending',
    'not_reversed',
    'partially_voided',
    'already_processed'
  ])('A. isUnconfirmedVoid rejection with status=%s is NOT classified as already-voided', function (status) {
    var err = makeUnconfirmedVoidError(status);
    // Sanity: the message really does contain a collision substring (proves
    // this test exercises the smuggling path, not a no-op).
    var msg = err.message.toLowerCase();
    var containsCollisionSubstring = ['already', 'reversal', 'reversed', 'voided'].some(function (s) {
      return msg.indexOf(s) !== -1;
    });
    expect(containsCollisionSubstring).toBe(true);

    expect(reconcile.isAlreadyVoidedError(err)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Anti-regression: the genuine already-voided 422 path (no isUnconfirmedVoid
  // flag, Helcim's real "already reversed" wording) must still be classified
  // as already-voided — the substring logic stays intact below the guard.
  // -------------------------------------------------------------------------
  test('A2 (anti-regression): a genuine already-reversed error (no isUnconfirmedVoid flag) is still classified as already-voided', function () {
    var err = new Error('Transaction already reversed');
    expect(reconcile.isAlreadyVoidedError(err)).toBe(true);
  });
});

describe('reconcilePendingCharge — unconfirmed void must alert, not silently clear the sentinel', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    cache.isConnected.mockReturnValue(true);
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue();
    cache.del.mockResolvedValue();
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-uv-001' });
  });

  // -------------------------------------------------------------------------
  // Case B: voidTransaction rejects with isUnconfirmedVoid:true and a
  // status-smuggled message. reconcile must persist sv:void-failure + fire
  // the staff alert — NOT clear the pending sentinel as an already-voided
  // success (the live blast radius at reconcile.js:261-274).
  // -------------------------------------------------------------------------
  test('B. unconfirmed-void rejection (status=reversal_pending) → sv:void-failure persisted + alert fired, pending sentinel NOT cleared', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-uv-001',
      invoiceNumber: 'KIOSK-UV-001',
      cardType: 'Visa',
      amount: 33
    });

    var pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-UV-001';

    cache.get.mockImplementation(function (key) {
      if (key === pendingKey) {
        return Promise.resolve(oldPendingCtx());
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-uv-001') {
        return Promise.resolve(null);  // confirm never ran
      }
      return Promise.resolve(null);
    });

    helcimLib.voidTransaction.mockRejectedValue(makeUnconfirmedVoidError('reversal_pending'));

    return reconcile.reconcilePendingCharge('txn-uv-001', deps()).then(function () {
      expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-uv-001');

      // Must NOT silently clear the pending sentinel as an already-voided success
      expect(cache.del).not.toHaveBeenCalledWith(pendingKey);

      // Must persist the sv:void-failure record
      expect(cache.set).toHaveBeenCalledWith(
        expect.stringMatching(/^sv:void-failure:/),
        expect.objectContaining({ needs_manual_review: true, txn_id: 'txn-uv-001' }),
        expect.any(Number)
      );

      // Must fire the staff alert
      expect(mailer.sendVoidFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ txnId: 'txn-uv-001' })
      );
    });
  });
});

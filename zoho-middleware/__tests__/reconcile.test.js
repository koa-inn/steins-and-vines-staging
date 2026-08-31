'use strict';

// ---------------------------------------------------------------------------
// reconcile.test.js — Phase 45-08 D-13 orphan-charge reconciliation backstop
//
// Tests for lib/reconcile.js:
//   - reconcilePendingCharge(transactionId, deps): 3 required branches
//       T1: APPROVED + no matching Zoho order → voidTransaction called
//       T1b: void fails → sv:void-failure persisted + sendVoidFailureAlert
//       T2: APPROVED + matching Zoho order (confirm ran) → pending cleared, no void
//       T3: Helcim lookup failure → pending record left intact
//   - sweepPendingCharges(deps):
//       T4: Redis disconnected → no-op (getClient not called)
//       T5: Redis connected, terminal result cached + old record → reconcilePendingCharge called
//       T6: Redis connected, no terminal result, old record → flagged for manual review
//
// Run alone: cd zoho-middleware && npm test -- reconcile
// ---------------------------------------------------------------------------

jest.mock('../lib/helcim');
jest.mock('../lib/mailer');
// D-50-07 (50-05): hasMatchingZohoOrder now makes a real Zoho call once the
// cache fast path misses. Without this mock the real zoho-api module hits
// zohoAuth.getAccessToken(), which rejects immediately in this test
// environment (no Zoho credentials configured) — an "unanswerable" call that
// the new fail-CLOSED policy correctly refuses to void on. A definitive
// "no matching order" answer here lets T1/T1b/T5's orphan scenarios remain
// POSITIVELY PROVEN orphans, exactly as they were designed to test, rather
// than accidentally exercising the (also-correct, but different) unanswerable
// branch. No assertion in this file changes — only this precondition.
jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn().mockResolvedValue({ invoices: [] }),
    zohoPost: jest.fn(),
    zohoPut: jest.fn()
  };
});
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(),
    del: jest.fn().mockResolvedValue(),
    // WR-02(c): lock primitives added to support the new serialisation path
    // in reconcilePendingCharge.  Defaults: acquired=true, release=OK so all
    // existing tests continue to exercise the full reconcile logic path.
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

var reconcile; // loaded after mocks

// Helper: pending context shape (kiosk/sale, 15 min old = "late approval")
// WR-02(a): MIN_ORPHAN_AGE_SECONDS raised from 120 to 600.  Records must be
// at least 600 s old to trigger orphan detection.  15 min (900 s) > 600 s —
// tests continue to exercise the full orphan-detection path unchanged.
function oldPendingCtx(overrides) {
  return Object.assign({
    reference_number: 'KIOSK-TEST-001',
    amount: 70.00,
    idempotency_key: 'idem-test-abc',
    created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()  // 15 min ago
  }, overrides || {});
}

// Helper: deps for test injection (avoids lazy-require picking up wrong mocks)
function deps() {
  return { helcim: helcimLib, mailer: mailer };
}

describe('reconcilePendingCharge', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    // Restore reasonable defaults after clearAllMocks
    cache.isConnected.mockReturnValue(true);
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue();
    cache.del.mockResolvedValue();
    // WR-02(c): lock defaults — acquired=true so existing tests exercise the full path
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });

    helcimLib.voidTransaction.mockResolvedValue({ ok: true, transactionId: 'txn-001', status: 'voided' });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-001' });

    // Load (or re-use) reconcile after all mocks are set
    reconcile = require('../lib/reconcile');
  });

  // ---------------------------------------------------------------------------
  // T1: APPROVED + no matching Zoho order → voidTransaction called
  // ---------------------------------------------------------------------------
  test('T1: APPROVED txn with no matching Zoho order → voidTransaction called', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-001',
      invoiceNumber: 'KIOSK-TEST-001',
      cardType: 'Visa',
      amount: 70
    });

    // Pending record exists (old = late approval)
    // Confirm idem key absent (confirm never ran)
    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-001') {
        return Promise.resolve(oldPendingCtx());
      }
      // confirm idem key: KIOSK_IDEM_PREFIX + 'confirm:' + idempotency_key
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-test-abc') {
        return Promise.resolve(null);  // confirm never ran
      }
      return Promise.resolve(null);
    });

    return reconcile.reconcilePendingCharge('txn-001', deps()).then(function () {
      expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-001');
      expect(cache.del).toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-001');
    });
  });

  // ---------------------------------------------------------------------------
  // T1b: APPROVED + no order + void fails → sv:void-failure persisted + alert
  // ---------------------------------------------------------------------------
  test('T1b: void failure → sv:void-failure record persisted + sendVoidFailureAlert', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-002',
      invoiceNumber: 'KIOSK-TEST-002',
      cardType: 'Visa',
      amount: 50
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-002') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-002',
          amount: 50,
          idempotency_key: 'idem-test-xyz'
        }));
      }
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-test-xyz') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    helcimLib.voidTransaction.mockRejectedValue(new Error('Void declined by Helcim'));

    return reconcile.reconcilePendingCharge('txn-002', deps()).then(function () {
      expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-002');
      // sv:void-failure record written
      expect(cache.set).toHaveBeenCalledWith(
        expect.stringMatching(/^sv:void-failure:/),
        expect.objectContaining({ needs_manual_review: true, txn_id: 'txn-002' }),
        expect.any(Number)
      );
      // Staff alert sent
      expect(mailer.sendVoidFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({ txnId: 'txn-002' })
      );
    });
  });

  // ---------------------------------------------------------------------------
  // T2: APPROVED + matching Zoho order (confirm ran) → pending cleared, no void
  // ---------------------------------------------------------------------------
  test('T2: APPROVED txn with matching Zoho order → pending cleared, no void', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-003',
      invoiceNumber: 'KIOSK-TEST-003',
      cardType: 'Debit',
      amount: 100
    });

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-003') {
        return Promise.resolve(oldPendingCtx({
          reference_number: 'KIOSK-TEST-003',
          amount: 100,
          idempotency_key: 'idem-confirmed-key'
        }));
      }
      // Confirm ran → confirm idem key is present in Redis
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-confirmed-key') {
        return Promise.resolve({ invoice_number: 'INV-4508-001', status: 201 });
      }
      return Promise.resolve(null);
    });

    return reconcile.reconcilePendingCharge('txn-003', deps()).then(function () {
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).toHaveBeenCalledWith(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-TEST-003');
    });
  });

  // ---------------------------------------------------------------------------
  // T3: Helcim lookup failure → pending record left intact (no destructive action)
  // ---------------------------------------------------------------------------
  test('T3: Helcim lookup failure → pending record left intact', function () {
    helcimLib.getCardTransactionById.mockRejectedValue(new Error('Helcim API unavailable'));

    return reconcile.reconcilePendingCharge('txn-999', deps()).then(function () {
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(mailer.sendVoidFailureAlert).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // T3b: No pending record → no-op (not a kiosk transaction we care about)
  // ---------------------------------------------------------------------------
  test('T3b: no pending record for transactionId → no-op', function () {
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-888',
      invoiceNumber: 'CHECKOUT-XYZ',  // not a kiosk pending charge
      cardType: 'Visa',
      amount: 30
    });

    cache.get.mockResolvedValue(null);  // no pending record

    return reconcile.reconcilePendingCharge('txn-888', deps()).then(function () {
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// sweepPendingCharges
// ---------------------------------------------------------------------------

describe('sweepPendingCharges', function () {
  var TERMINAL_RESULT_KEY_PREFIX = 'helcim:terminal:result:';

  beforeEach(function () {
    jest.clearAllMocks();
    cache.isConnected.mockReturnValue(true);
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue();
    cache.del.mockResolvedValue();
    // WR-02(c): lock defaults for sweep tests (acquired=true — same reasoning as above)
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });

    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-sweep-001',
      invoiceNumber: 'KIOSK-SWEEP-001',
      cardType: 'Visa',
      amount: 80
    });
    helcimLib.voidTransaction.mockResolvedValue({ ok: true });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-sweep-001' });

    reconcile = require('../lib/reconcile');
  });

  // ---------------------------------------------------------------------------
  // T4: Redis disconnected → sweep is a no-op
  // ---------------------------------------------------------------------------
  test('T4: Redis disconnected → sweep no-ops (getClient not called)', function () {
    cache.isConnected.mockReturnValue(false);

    return reconcile.sweepPendingCharges(deps()).then(function () {
      expect(cache.getClient).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // T5: Connected, terminal result cached + old record → reconcilePendingCharge called
  // ---------------------------------------------------------------------------
  test('T5: old pending record with APPROVED terminal result → reconcile called (void attempted)', function () {
    var pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-SWEEP-001';
    var resultKey  = TERMINAL_RESULT_KEY_PREFIX + 'KIOSK-SWEEP-001';
    var ctx = oldPendingCtx({
      reference_number: 'KIOSK-SWEEP-001',
      amount: 80,
      idempotency_key: 'idem-sweep-001'
    });

    // Terminal result stored as a double-stringify (webhooks.js convention)
    var terminalResult = JSON.stringify({
      status: 'APPROVED',
      transactionId: 'txn-sweep-001',
      approved: true,
      cardType: 'Visa'
    });

    cache.getClient.mockResolvedValue({
      keys: jest.fn().mockResolvedValue([pendingKey])
    });

    cache.get.mockImplementation(function (key) {
      if (key === pendingKey)    return Promise.resolve(ctx);
      if (key === resultKey)     return Promise.resolve(terminalResult); // double-stringify inner string
      // No confirm key → orphan
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:idem-sweep-001') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });

    return reconcile.sweepPendingCharges(deps()).then(function () {
      // reconcilePendingCharge should have been invoked for txn-sweep-001 → void called
      expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-sweep-001');
    });
  });

  // ---------------------------------------------------------------------------
  // T6: Connected, no terminal result, old record → flagged for manual review
  // ---------------------------------------------------------------------------
  test('T6: old pending record with no terminal result → flagged for manual review', function () {
    var pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-OLD-001';
    var resultKey  = TERMINAL_RESULT_KEY_PREFIX + 'KIOSK-OLD-001';
    var ctx = oldPendingCtx({
      reference_number: 'KIOSK-OLD-001',
      amount: 60,
      idempotency_key: 'idem-old-001'
    });

    cache.getClient.mockResolvedValue({
      keys: jest.fn().mockResolvedValue([pendingKey])
    });

    cache.get.mockImplementation(function (key) {
      if (key === pendingKey) return Promise.resolve(ctx);
      if (key === resultKey)  return Promise.resolve(null); // result expired
      return Promise.resolve(null);
    });

    return reconcile.sweepPendingCharges(deps()).then(function () {
      // voidTransaction cannot be called (no transactionId)
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      // void-failure record written for manual review
      expect(cache.set).toHaveBeenCalledWith(
        expect.stringMatching(/^sv:void-failure:/),
        expect.objectContaining({ needs_manual_review: true }),
        expect.any(Number)
      );
      // Alert sent
      expect(mailer.sendVoidFailureAlert).toHaveBeenCalled();
      // Regression (re-alert flood): the pending record must be re-written with
      // a manual_review_alerted marker so the next sweep does not re-alert.
      expect(cache.set).toHaveBeenCalledWith(
        pendingKey,
        expect.objectContaining({ manual_review_alerted: true, reference_number: 'KIOSK-OLD-001' }),
        expect.any(Number)
      );
    });
  });

  // ---------------------------------------------------------------------------
  // T6b: already-flagged pending record → NO duplicate alert (single sweep)
  // ---------------------------------------------------------------------------
  test('T6b: pending record already marked manual_review_alerted → no duplicate alert', function () {
    var pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-OLD-002';
    var resultKey  = TERMINAL_RESULT_KEY_PREFIX + 'KIOSK-OLD-002';
    var ctx = oldPendingCtx({
      reference_number: 'KIOSK-OLD-002',
      amount: 60,
      idempotency_key: 'idem-old-002',
      manual_review_alerted: true  // a prior sweep already alerted + flagged this record
    });

    cache.getClient.mockResolvedValue({
      keys: jest.fn().mockResolvedValue([pendingKey])
    });

    cache.get.mockImplementation(function (key) {
      if (key === pendingKey) return Promise.resolve(ctx);
      if (key === resultKey)  return Promise.resolve(null); // result expired
      return Promise.resolve(null);
    });

    return reconcile.sweepPendingCharges(deps()).then(function () {
      // Already flagged — no new sentinel, no new email
      expect(mailer.sendVoidFailureAlert).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalledWith(
        expect.stringMatching(/^sv:void-failure:/),
        expect.anything(),
        expect.anything()
      );
    });
  });

  // ---------------------------------------------------------------------------
  // T6c: regression — two consecutive sweeps of the SAME stuck record alert ONCE
  // (reproduces the observed email flood: one alert per record per 5-min sweep
  //  for up to the 7-day pending TTL). With the marker persisted across sweeps,
  //  only the first sweep alerts.
  // ---------------------------------------------------------------------------
  test('T6c: two sweeps of the same stuck record → alert sent exactly once', function () {
    var pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-FLOOD-001';
    var resultKey  = TERMINAL_RESULT_KEY_PREFIX + 'KIOSK-FLOOD-001';

    // Stateful store so the marker written in sweep #1 is visible in sweep #2.
    var store = {};
    store[pendingKey] = oldPendingCtx({
      reference_number: 'KIOSK-FLOOD-001',
      amount: 1,
      idempotency_key: 'idem-flood-001'
    });

    cache.getClient.mockResolvedValue({
      keys: jest.fn().mockResolvedValue([pendingKey])
    });
    cache.get.mockImplementation(function (key) {
      if (key === resultKey) return Promise.resolve(null); // no terminal result, ever
      return Promise.resolve(Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null);
    });
    cache.set.mockImplementation(function (key, value) {
      store[key] = value;
      return Promise.resolve();
    });

    return reconcile.sweepPendingCharges(deps()).then(function () {
      return reconcile.sweepPendingCharges(deps());
    }).then(function () {
      expect(mailer.sendVoidFailureAlert).toHaveBeenCalledTimes(1);
    });
  });
});

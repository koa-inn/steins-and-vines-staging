'use strict';

// ---------------------------------------------------------------------------
// reconcile-wr02-wr07.test.js — Phase 45 Fix2: WR-02 regression tests
//
// WR-02: Reconcile can false-positive-void in-flight charges; race/double-void.
//   WR-02-B: Verify settled-signal key alignment with FIX1 confirm key scheme
//            (idempotency_key in pending record = refNumber → confirm idem key
//             = KIOSK_IDEM_PREFIX + 'confirm:' + refNumber — must match what
//             pos.js confirm handler writes after FIX1).
//   WR-02-C-LOCK: reconcilePendingCharge must acquire a Redis lock; concurrent
//                  calls for the same txn must not both void.
//   WR-02-C-ALREADY-VOIDED: "already reversed/voided" void error must be treated
//                             as success — no sv:void-failure, no alert email.
//
// WR-07 route test is in webhook-wr07.test.js (separate file, because jest.mock
// for '../lib/reconcile' is hoisted and would shadow the real module here).
//
// Run alone: cd zoho-middleware && npm test -- reconcile-wr02-wr07
// ---------------------------------------------------------------------------

jest.mock('../lib/helcim');
jest.mock('../lib/mailer');
// D-50-07 (50-05): see reconcile.test.js for the full rationale — without
// this mock, hasMatchingZohoOrder's Zoho call hits the real zoho-api module
// and gets an "unanswerable" auth rejection in this test environment,
// changing WR-02-C-ALREADY-VOIDED's genuine-orphan scenario into an
// unprovable one. A definitive "no matching order" answer restores it.
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
    // WR-02(c): lock primitives — must be present for new lock path
    acquireLock: jest.fn().mockResolvedValue(true),   // default: lock acquired
    releaseLock: jest.fn().mockResolvedValue(),        // default: release OK
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

// Helper: pending context with FIX1 key scheme (idempotency_key = refNumber)
function oldPendingCtx(overrides) {
  return Object.assign({
    reference_number: 'KIOSK-WR02-001',
    amount: 70.00,
    idempotency_key: 'KIOSK-WR02-001', // FIX1: sale body.idempotency_key = refNumber
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()  // 10 min ago
  }, overrides || {});
}

function deps() {
  return { helcim: helcimLib, mailer: mailer };
}

describe('WR-02: reconcilePendingCharge lock + already-voided + settled-signal alignment', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    // Restore defaults after clearAllMocks
    cache.isConnected.mockReturnValue(true);
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue();
    cache.del.mockResolvedValue();
    cache.acquireLock.mockResolvedValue(true);
    cache.releaseLock.mockResolvedValue();
    cache.getClient.mockResolvedValue({ keys: jest.fn().mockResolvedValue([]) });

    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-wr02-001',
      invoiceNumber: 'KIOSK-WR02-001',
      cardType: 'Visa',
      amount: 70
    });
    helcimLib.voidTransaction.mockResolvedValue({ ok: true, transactionId: 'txn-wr02-001', status: 'voided' });
    mailer.sendVoidFailureAlert.mockResolvedValue({ id: 'mail-wr02-001' });

    reconcile = require('../lib/reconcile');
  });

  // -------------------------------------------------------------------------
  // WR-02-B: Settled-signal alignment — idempotency_key = refNumber (FIX1 scheme)
  //
  // The sale handler stores idempotency_key = body.idempotency_key = refNumber.
  // The confirm handler writes the confirm idem key as
  //   KIOSK_IDEM_PREFIX + 'confirm:' + refNumber.
  // reconcile.js must check the same key (confirm:refNumber) — verify alignment.
  // This test documents the FIX1 key contract and must stay GREEN.
  // -------------------------------------------------------------------------
  test('WR-02-B: settled-signal uses idempotency_key=refNumber aligning with FIX1 confirm key scheme', function () {
    var refNumber = 'KIOSK-B2B-001';
    helcimLib.getCardTransactionById.mockResolvedValue({
      status: 'APPROVED',
      transactionId: 'txn-b2b-001',
      invoiceNumber: refNumber,
      cardType: 'Visa',
      amount: 80
    });

    cache.get.mockImplementation(function (key) {
      // Pending record written by pos.js sale handler after FIX1:
      //   idempotency_key = body.idempotency_key = refNumber
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber) {
        return Promise.resolve(oldPendingCtx({
          reference_number: refNumber,
          idempotency_key: refNumber  // FIX1: sale body.idempotency_key is now refNumber
        }));
      }
      // Confirm idem key as written by pos.js confirm handler after FIX1:
      //   seed = body.idempotency_key = refNumber
      //   key  = KIOSK_IDEM_PREFIX + 'confirm:' + refNumber
      // reconcile.hasMatchingZohoOrder checks: KIOSK_IDEM_PREFIX + 'confirm:' + ctx.idempotency_key
      //   = KIOSK_IDEM_PREFIX + 'confirm:' + refNumber  → MUST MATCH
      if (key === C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:' + refNumber) {
        return Promise.resolve({ ok: true, invoice_number: 'INV-B2B-001' });
      }
      return Promise.resolve(null);
    });

    return reconcile.reconcilePendingCharge('txn-b2b-001', deps()).then(function () {
      // Confirm idem key found → settled → no void
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      // Pending record cleared (settled signal consumed)
      expect(cache.del).toHaveBeenCalledWith(
        C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber
      );
    });
  });

  // -------------------------------------------------------------------------
  // WR-02-C-LOCK: concurrent calls must not both void the same transaction.
  //
  // Before fix: no lock → acquireLock never called → voidTransaction fires
  //   even when lock would have been denied → assertion FAILS (RED).
  // After fix: acquireLock called; when it returns false → early return,
  //   voidTransaction NOT called → assertion PASSES (GREEN).
  // -------------------------------------------------------------------------
  test('WR-02-C-LOCK: when lock not acquired for txn, void is not attempted', function () {
    // Simulate lock already held by another concurrent reconcile
    cache.acquireLock.mockResolvedValue(false);

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-WR02-001') {
        return Promise.resolve(oldPendingCtx());
      }
      // No confirm key → would try to void if lock were acquired
      return Promise.resolve(null);
    });

    return reconcile.reconcilePendingCharge('txn-wr02-001', deps()).then(function () {
      // Lock was denied → must NOT proceed to void
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      // No false-alert either
      expect(mailer.sendVoidFailureAlert).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // WR-02-C-ALREADY-VOIDED: "already reversed" error from void must be treated
  //   as success — pending record cleared, no sv:void-failure, no alert.
  //
  // Before fix: any voidTransaction rejection → sv:void-failure + alert → FAIL.
  // After fix: "already reversed" → SUCCESS path → clear pending, no alert.
  // -------------------------------------------------------------------------
  test('WR-02-C-ALREADY-VOIDED: "already reversed" void error treated as success — no alert, pending cleared', function () {
    cache.acquireLock.mockResolvedValue(true);

    cache.get.mockImplementation(function (key) {
      if (key === C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-WR02-001') {
        return Promise.resolve(oldPendingCtx());
      }
      // No confirm key → will attempt void
      return Promise.resolve(null);
    });

    // Simulate Helcim returning "already reversed" (transaction was already voided)
    helcimLib.voidTransaction.mockRejectedValue(
      new Error('Transaction already reversed')
    );

    return reconcile.reconcilePendingCharge('txn-wr02-001', deps()).then(function () {
      // Must NOT send a false-positive alert
      expect(mailer.sendVoidFailureAlert).not.toHaveBeenCalled();
      // Must NOT persist a sv:void-failure record (charge is already cleared)
      expect(cache.set).not.toHaveBeenCalledWith(
        expect.stringMatching(/^sv:void-failure:/),
        expect.anything(),
        expect.anything()
      );
      // Pending record must be cleared (charge is settled — already voided elsewhere)
      expect(cache.del).toHaveBeenCalledWith(
        C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + 'KIOSK-WR02-001'
      );
    });
  });
});

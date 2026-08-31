'use strict';

/**
 * pos-confirm-amount-drift.test.js — Regression tests for Phase 50-03 (M-A3 / SC#1)
 *
 * The kiosk `sale` leg charges `terminal_amount` on the Helcim terminal. The
 * `confirm` leg then INDEPENDENTLY recomputes `grandTotal` from the catalog
 * cache and books THAT figure as the `customerpayment` — never comparing it
 * against the amount actually captured. A catalog refresh between the two
 * legs (the kiosk busts/reloads `zoho:kiosk-products` routinely) silently
 * books a payment that is not the money that was taken.
 *
 * D-50-04: the captured amount (helcimLib.getCardTransactionById) is the
 * sole authority, read back and compared against `terminalApplied` (NOT
 * `grandTotal` — that would false-reject every split-tender sale) with a
 * ±$0.01 tolerance, BEFORE any Zoho side-effect. Unlike checkout.js (which
 * tolerates a customer-chosen overpayment), the kiosk is strict in BOTH
 * directions (D-50-04) — on the kiosk the server sets the charge amount, so
 * an over-capture means OUR OWN catalog drifted, not a customer choice.
 *
 * This check applies to the plain terminal / manual-confirm paths, which
 * currently have NO captured-amount verification at all (the actual M-A3
 * gap). It deliberately does NOT re-verify tender:'moto' (already covered by
 * the pre-existing 70-02 verifyMotoCharge gate) or tender:'cash' (no Helcim
 * charge exists to verify, T-70-03).
 *
 * RED phase: cases 1, 2, 4, and the manual-confirm regression FAIL against
 * current source — nothing in pos.js's plain-terminal confirm path reads
 * back the captured amount, so a drifted or unverifiable capture books
 * anyway. Cases 3, 5, 6 PASS against current source already (anti-regression
 * half — a normal sale must not start voiding itself once the check lands).
 */

// =============================================================================
// Mocks — cloned from pos-moto-tender.test.js (the closest existing template
// for a getCardTransactionById-driven confirm-route check).
// =============================================================================

jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-drift-1' }),
    pollTerminalResult: jest.fn(),
    initializeCheckout: jest.fn().mockResolvedValue({ checkoutToken: 'tok-drift-test' }),
    getCardTransactionById: jest.fn(),
    voidTransaction: jest.fn().mockResolvedValue({ ok: true }),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-drift-so-1'),
    cancelTerminal: jest.fn().mockResolvedValue({})
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-drift-1', invoice_number: 'INV-DRIFT-001' } }),
    zohoPut: jest.fn()
  };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue()
  };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});

jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn().mockResolvedValue({}) };
});

jest.mock('../lib/inventory-ledger', function () {
  return { decrementStock: jest.fn().mockResolvedValue({}), reconcileFromZoho: jest.fn() };
});

jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn(), detectRecipeSale: jest.fn() };
});

jest.mock('../lib/discount-match', function () {
  return { classifyCatalogItem: jest.fn().mockReturnValue([]), matches: jest.fn().mockReturnValue(false) };
});

jest.mock('../lib/checkout-helpers', function () {
  return { buildContactPayload: jest.fn(), withTimeout: function (p) { return p; } };
});

jest.mock('../lib/money-path', function () {
  return {
    acquireIdempotencyLock: jest.fn().mockResolvedValue({ status: 'acquired' }),
    voidWithTimeout: jest.fn().mockImplementation(function (helcimLike, txnId) {
      return helcimLike.voidTransaction(txnId).then(function () {}).catch(function () {});
    }),
    CHECKOUT_IDEMPOTENCY_TTL: 600
  };
});

jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS:              'test:kiosk-products',
      RECENT_ORDERS:               'test:recent-orders',
      KIOSK_IDEM_PREFIX:           'test:idem:',
      KIOSK_SALESORDERS:           'test:kiosk-salesorders',
      KIOSK_DISCOUNT_PRESETS:      'test:kiosk-discount-presets',
      CONSIGNMENT_REPORT_PREFIX:   'test:consignment:report:',
      KIOSK_PENDING_CHARGE_PREFIX: 'test:kiosk:pending-charge:',
      INGREDIENTS_ALL:             'zoho:ingredients:all'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' },
    LEDGER_KEYS: {},
    RATE_LIMIT_PREFIX: 'test:rl:'
  };
});

// =============================================================================
// Test harness (mirrors pos-moto-tender.test.js getHandlers)
// =============================================================================

var cache, helcimLib, zohoApi, router, handlers;

function getHandlers() {
  jest.resetModules();
  cache      = require('../lib/cache');
  helcimLib  = require('../lib/helcim');
  zohoApi    = require('../lib/zoho-api');
  require('../routes/pos');
  router   = require('express').Router();
  handlers = {};
  router.post.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
  router.get.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
}

function mockRes() {
  var r = { json: jest.fn(), status: jest.fn(), headersSent: false };
  r.status.mockReturnValue(r);
  return r;
}

function captureStatus(res) {
  var captured = { code: null };
  res.status.mockImplementation(function (code) { captured.code = code; return res; });
  return captured;
}

// A single tax-exempt custom line: bypasses the catalog check entirely on
// /confirm (item.custom === true). rate controls grandTotal exactly.
function driftCartItems(rate) {
  return [{ custom: true, description: 'Drift Test Item', quantity: 1, rate: rate, taxable: false }];
}

describe('pos — 50-03 M-A3 captured-amount verification at confirm (SC#1)', function () {

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.NODE_ENV;
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;
  });

  // ---------------------------------------------------------------------
  // Case 1: Drift DOWN — the money-losing attack. Terminal captured $50,
  // confirm recomputes terminalApplied = $45 (catalog changed between legs).
  // ---------------------------------------------------------------------

  test('Case 1: captured ($50) > terminalApplied ($45) by more than tolerance → NO invoice, NO customerpayment, voided, 402', function (done) {
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 50.00 });
    var req = {
      body: {
        items: driftCartItems(45),
        transaction_id: 'txn-drift-down',
        reference_number: 'KIOSK-DRIFT-001'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(402);
        var invoiceCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
        expect(invoiceCalls.length).toBe(0);
        var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
        expect(paymentCalls.length).toBe(0);
        expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-drift-down');
        expect(body.payment_voided).toBe(true);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 2: Drift UP — the customer-overcharged case (D-50-04). Unlike
  // checkout.js, the kiosk REJECTS this too: the server set the charge
  // amount, so an over-capture means OUR catalog moved, not the customer's
  // choice to overpay.
  // ---------------------------------------------------------------------

  test('Case 2: captured ($45) < terminalApplied ($50) by more than tolerance → NO invoice, NO customerpayment, voided, 402', function (done) {
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 45.00 });
    var req = {
      body: {
        items: driftCartItems(50),
        transaction_id: 'txn-drift-up',
        reference_number: 'KIOSK-DRIFT-002'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(402);
        var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
        expect(paymentCalls.length).toBe(0);
        expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-drift-up');
        expect(body.payment_voided).toBe(true);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 3: Within tolerance — anti-regression. A normal sale must not
  // start voiding itself once the check lands.
  // ---------------------------------------------------------------------

  describe('Case 3: within tolerance (anti-regression)', function () {

    test('captured === terminalApplied exactly → invoice + customerpayment created, 201', function (done) {
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 50.00 });
      var req = {
        body: {
          items: driftCartItems(50),
          transaction_id: 'txn-exact-match',
          reference_number: 'KIOSK-DRIFT-003A'
        }
      };
      var res = mockRes();
      var statusCapture = captureStatus(res);
      res.json.mockImplementation(function (body) {
        try {
          expect(statusCapture.code).toBe(201);
          var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
          expect(paymentCalls.length).toBe(1);
          expect(paymentCalls[0][1].amount).toBe(50.00);
          expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
          done();
        } catch (e) { done(e); }
      });
      handlers['/api/kiosk/sale/confirm'](req, res);
    });

    test('$49.995 rounding drift within ±$0.01 → still books, 201', function (done) {
      helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 49.995 });
      var req = {
        body: {
          items: driftCartItems(50),
          transaction_id: 'txn-rounding',
          reference_number: 'KIOSK-DRIFT-003B'
        }
      };
      var res = mockRes();
      var statusCapture = captureStatus(res);
      res.json.mockImplementation(function (body) {
        try {
          expect(statusCapture.code).toBe(201);
          expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
          done();
        } catch (e) { done(e); }
      });
      handlers['/api/kiosk/sale/confirm'](req, res);
    });

  });

  // ---------------------------------------------------------------------
  // Case 4: Unverifiable readback fails closed.
  // ---------------------------------------------------------------------

  test('Case 4: getCardTransactionById rejects → NO customerpayment, voided, 402 (fail-closed)', function (done) {
    helcimLib.getCardTransactionById.mockRejectedValue(new Error('Helcim card-transactions API error'));
    var req = {
      body: {
        items: driftCartItems(50),
        transaction_id: 'txn-unreachable',
        reference_number: 'KIOSK-DRIFT-004'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(402);
        var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
        expect(paymentCalls.length).toBe(0);
        expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-unreachable');
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 5: Split tender compares against terminalApplied, NOT grandTotal.
  // grandTotal $50, gift card $20 applied, terminalApplied = $30. Captured
  // $30 must PASS — asserting against grandTotal here would false-reject
  // every split-tender sale.
  // ---------------------------------------------------------------------

  test('Case 5: split tender — captured ($30) matches terminalApplied ($30), NOT grandTotal ($50) → 201', function (done) {
    process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = 'acct-gc-clearing-test';
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 30.00 });
    var req = {
      body: {
        items: driftCartItems(50),
        transaction_id: 'txn-split-tender',
        reference_number: 'KIOSK-DRIFT-005',
        gift_card: { cert_number: 'GC-000001', amount_applied: 20 }
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(201);
        var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
        expect(paymentCalls.length).toBe(2);
        var creditcardCall = paymentCalls.find(function (c) { return c[1].payment_mode === 'creditcard'; });
        var gcCall = paymentCalls.find(function (c) { return c[1].payment_mode === 'others'; });
        expect(creditcardCall).toBeTruthy();
        expect(creditcardCall[1].amount).toBe(30.00);
        expect(gcCall).toBeTruthy();
        expect(gcCall[1].amount).toBe(20.00);
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Case 6: 100%-gift-card sale — no terminal charge exists, so the readback
  // must not even run.
  // ---------------------------------------------------------------------

  test('Case 6: terminalApplied === 0 (100% gift card) → getCardTransactionById NOT called, confirm succeeds', function (done) {
    process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = 'acct-gc-clearing-test';
    var req = {
      body: {
        items: driftCartItems(20),
        reference_number: 'KIOSK-DRIFT-006',
        gift_card: { cert_number: 'GC-000002', amount_applied: 20 }
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(201);
        expect(helcimLib.getCardTransactionById).not.toHaveBeenCalled();
        var paymentCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
        var creditcardCall = paymentCalls.find(function (c) { return c[1].payment_mode === 'creditcard'; });
        expect(creditcardCall).toBeFalsy();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  // ---------------------------------------------------------------------
  // Regression (Rule 1 fix, discovered during implementation): a manual-
  // confirm mismatch must void the REAL Helcim transaction id resolved by
  // pollTerminalResult — NOT the literal client-sent string 'manual-confirm'
  // (which body.transaction_id still holds; the resolved id lives only in
  // the confirm continuation's local `txnId`, invisible to the outer catch
  // unless threaded through the tagged error).
  // ---------------------------------------------------------------------

  test('Regression: manual-confirm + mismatch voids the RESOLVED real txn id, not the literal "manual-confirm" string', function (done) {
    helcimLib.pollTerminalResult.mockResolvedValue({
      approved: true, transactionId: 'txn-real-resolved-999', status: 'APPROVED'
    });
    // Resolved real txn captured $45 — short of the $50 terminalApplied.
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 45.00 });
    var req = {
      body: {
        items: driftCartItems(50),
        transaction_id: 'manual-confirm',
        reference_number: 'KIOSK-DRIFT-MC-001'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(402);
        expect(helcimLib.getCardTransactionById).toHaveBeenCalledWith('txn-real-resolved-999');
        expect(helcimLib.voidTransaction).toHaveBeenCalledWith('txn-real-resolved-999');
        expect(helcimLib.voidTransaction).not.toHaveBeenCalledWith('manual-confirm');
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

});

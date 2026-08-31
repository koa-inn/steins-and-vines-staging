'use strict';

var crypto = require('crypto');

// ---------------------------------------------------------------------------
// pos-giftcard.test.js — Phase 45-07 gift-card security hardening
//
// Task 1 (D-12): split-tender balance validation + needs_manual_review on
//   redeem failure.  gcApplied is now validated against the certificate's
//   real server-side balance before the reduced terminal amount is charged.
//
// Task 2 (D-13): pending-charge context persisted on terminal timeout so the
//   45-08 reconciliation backstop can find orphaned charges.
//
// Run alone: cd zoho-middleware && npm test -- pos-giftcard
// ---------------------------------------------------------------------------

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
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-gc-1' }),
    pollTerminalResult: jest.fn().mockResolvedValue({
      approved: true, transactionId: 'txn-gc-123', authorizationCode: 'AUTH1', cardType: 'Visa'
    }),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-gc-so-1'),
    // 50-03 (M-A3): captured-amount readback, added by plan 50-03 to the
    // plain-terminal confirm path. No default — set where needed (below) with
    // the SAME total the test's own cart/catalog establishes.
    getCardTransactionById: jest.fn()
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({
      invoice: { invoice_id: 'inv-4507-1', invoice_number: 'INV-4507-001' }
    }),
    zohoPut: jest.fn()
  };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1)
  };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn().mockResolvedValue({}) };
});
jest.mock('../lib/inventory-ledger', function () {
  return {
    decrementStock: jest.fn().mockResolvedValue({}),
    reconcileFromZoho: jest.fn()
  };
});
jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn() };
});
jest.mock('../lib/checkout-helpers', function () {
  // withTimeout pass-through — required by moneyPath.voidWithTimeout (D-12 outer catch)
  return { buildContactPayload: jest.fn(), withTimeout: function (p) { return p; } };
});

// Include KIOSK_PENDING_CHARGE_PREFIX so D-13 persist can be asserted
jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS:              'test:kiosk-products',
      RECENT_ORDERS:               'test:recent-orders',
      KIOSK_IDEM_PREFIX:           'test:idem:',
      KIOSK_SALESORDERS:           'test:kiosk-salesorders',
      KIOSK_DISCOUNT_PRESETS:      'test:kiosk-discount-presets',
      CONSIGNMENT_REPORT_PREFIX:   'test:consignment:report:',
      KIOSK_PENDING_CHARGE_PREFIX: 'test:kiosk:pending-charge:'   // D-13
    },
    LEDGER_KEYS: {},
    RATE_LIMIT_PREFIX: 'test:rl:'
  };
});

// ---------------------------------------------------------------------------
// Catalog fixtures (tax-exempt $100 item)
// ---------------------------------------------------------------------------

var CATALOG_EXEMPT = [
  {
    item_id:        'item-gc-test',
    name:           'Gift Test Item',
    rate:           100.00,
    stock_on_hand:  10,
    tax_percentage: 0,
    tax_id:         'gc-test-exempt',   // blocks default 5% → grandTotal = $100
    custom_fields:  []
  }
];

// ---------------------------------------------------------------------------
// Test harness (mirrors pos-gift-card.test.js)
// ---------------------------------------------------------------------------

describe('pos routes — gift-card hardening Phase 45-07', function () {
  var cache, zohoApi, helcimLib, axiosMock, router, handlers;

  function getHandlers() {
    jest.resetModules();
    cache     = require('../lib/cache');
    zohoApi   = require('../lib/zoho-api');
    helcimLib = require('../lib/helcim');
    axiosMock = require('axios');
    require('../routes/pos');
    router   = require('express').Router();
    handlers = {};
    router.post.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
    router.get.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
    router.put.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
  }

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn(), headersSent: false };
    res.status.mockReturnValue(res);
    return res;
  }

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_CONTACT_ID                  = 'contact-walkin';
    process.env.APPS_SCRIPT_URL                   = 'https://script.example.com/exec';
    process.env.APPS_SCRIPT_SERVER_TOKEN          = 'server-token-test';
    process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = '109900000000873231';
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;
  });

  // =========================================================================
  // TASK 1 — Split-tender balance validation + needs_manual_review (D-12)
  // =========================================================================

  describe('Task 1: balance-validated split-tender (D-12)', function () {

    // -----------------------------------------------------------------------
    // /api/kiosk/sale — balance lookup clamps gcApplied to real balance
    // -----------------------------------------------------------------------
    describe('/api/kiosk/sale — gcApplied clamped to realBalance', function () {

      test('T1: gcApplied > realBalance → terminalPurchase called with grandTotal − realBalance', function (done) {
        // Catalog: $100 item (tax-exempt) → grandTotal = $100
        // Submitted: amount_applied = $50  /  realBalance = $30
        // Expected: terminalPurchase($70) = $100 − $30  (not $50)
        cache.get.mockResolvedValue(CATALOG_EXEMPT);
        axiosMock.post.mockImplementation(function (url, body) {
          var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
          if (parsed.action === 'lookup_gift_card') {
            return Promise.resolve({ data: { ok: true, data: { current_balance: 30 } } });
          }
          return Promise.resolve({ data: { ok: true } });
        });

        var req = {
          body: {
            items:     [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            gift_card: { cert_number: 'GC-000001', amount_applied: 50 }
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function (body) {
          try {
            expect(body.pending).toBe(true);
            var termCall = helcimLib.terminalPurchase.mock.calls[0];
            expect(termCall).toBeTruthy();
            // terminal should be $70, not $50 (= $100 − realBalance $30)
            expect(termCall[0]).toBeCloseTo(70, 2);
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale'](req, res);
      });

      test('T3: gcApplied <= realBalance → terminalPurchase called with original terminal_amount (unchanged)', function (done) {
        // Catalog: $100 item → grandTotal = $100
        // Submitted: amount_applied = $40  /  realBalance = $60  (no clamping)
        // Expected: terminalPurchase($60) = $100 − $40
        cache.get.mockResolvedValue(CATALOG_EXEMPT);
        axiosMock.post.mockImplementation(function (url, body) {
          var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
          if (parsed.action === 'lookup_gift_card') {
            return Promise.resolve({ data: { ok: true, data: { current_balance: 60 } } });
          }
          return Promise.resolve({ data: { ok: true } });
        });

        var req = {
          body: {
            items:     [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            gift_card: { cert_number: 'GC-000002', amount_applied: 40 }
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function (body) {
          try {
            expect(body.pending).toBe(true);
            var termCall = helcimLib.terminalPurchase.mock.calls[0];
            expect(termCall).toBeTruthy();
            // No clamping — still $60
            expect(termCall[0]).toBeCloseTo(60, 2);
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale'](req, res);
      });

      test('T-FIELD: real Apps Script shape (current_balance) is recognized → clamp applies (45-09 regression)', function (done) {
        // Apps Script lookup_gift_card returns the balance under `current_balance`
        // (proven by gift-cards.test.js), NOT `balance`. Reading the wrong key made
        // the sale path treat every prod lookup as 'unavailable' → 503 fail-closed.
        // Catalog: $100 item → grandTotal = $100; realBalance = $30; submitted = $50
        // Expected: terminalPurchase($70) = $100 − $30 (clamped to real balance).
        cache.get.mockResolvedValue(CATALOG_EXEMPT);
        axiosMock.post.mockImplementation(function (url, body) {
          var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
          if (parsed.action === 'lookup_gift_card') {
            return Promise.resolve({ data: { ok: true, data: { current_balance: 30, status: 'active', face_value: 100 } } });
          }
          return Promise.resolve({ data: { ok: true } });
        });

        var req = {
          body: {
            items:     [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            gift_card: { cert_number: 'GC-000001', amount_applied: 50 }
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function (body) {
          try {
            expect(body.pending).toBe(true);
            var termCall = helcimLib.terminalPurchase.mock.calls[0];
            expect(termCall).toBeTruthy();
            // clamp must apply off current_balance → $70, not the submitted-amount $50
            expect(termCall[0]).toBeCloseTo(70, 2);
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale'](req, res);
      });
    });

    // -----------------------------------------------------------------------
    // /api/kiosk/sale/confirm — redeem failure sets needs_manual_review
    // -----------------------------------------------------------------------
    describe('/api/kiosk/sale/confirm — redeem failure → needs_manual_review', function () {

      test('T2: redeem_gift_card failure → needs_manual_review:true in 201 response', function (done) {
        // Setup: catalog present; invoice creation OK; redeem fails
        cache.get.mockResolvedValue(CATALOG_EXEMPT);
        zohoApi.zohoPost.mockResolvedValue({
          invoice: { invoice_id: 'inv-4507-redeem', invoice_number: 'INV-4507-RD' }
        });
        axiosMock.post.mockImplementation(function (url, body) {
          var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
          if (parsed.action === 'redeem_gift_card') {
            // Simulate Apps Script returning failure (e.g. insufficient balance at redeem time)
            return Promise.resolve({ data: { ok: false, error: 'insufficient_balance' } });
          }
          if (parsed.action === 'lookup_gift_card') {
            return Promise.resolve({ data: { ok: true, data: { current_balance: 40 } } });
          }
          return Promise.resolve({ data: { ok: true } });
        });
        // 50-03 (M-A3): rate=100, tax 0%, gift card $40 applied -> terminalApplied=60
        helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 60.00 });

        var req = {
          body: {
            items:          [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            transaction_id: 'txn-4507-rd',
            reference_number: 'KIOSK-4507-RD',
            gift_card:      { cert_number: 'GC-000010', amount_applied: 40 }
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function (body) {
          try {
            // confirm still succeeds (invoice paid; redeem is post-payment best-effort)
            expect(body.ok).toBe(true);
            // but needs_manual_review must be set so staff are alerted
            expect(body.needs_manual_review).toBe(true);
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale/confirm'](req, res);
      });
    });
  });

  // =========================================================================
  // TASK 2 — Pending-charge context persisted on terminal timeout (D-13)
  // =========================================================================

  describe('Task 2: pending-charge persist on terminal timeout (D-13)', function () {

    // -----------------------------------------------------------------------
    // /api/kiosk/sale — pending context written after push succeeds (D-13)
    // -----------------------------------------------------------------------
    describe('/api/kiosk/sale — pending context persisted after push', function () {

      test('T4: after push success, cache.set called with KIOSK_PENDING_CHARGE_PREFIX + refNumber', function (done) {
        cache.get.mockResolvedValue(CATALOG_EXEMPT);
        helcimLib.terminalPurchase.mockResolvedValue({});
        // No gift card — pure terminal; ensure pending key = prefix + refNumber
        var req = {
          body: {
            items:            [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            reference_number: 'REF-D13-001'
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function (body) {
          try {
            expect(body.pending).toBe(true);
            var setCalls = cache.set.mock.calls;
            var pendingCall = setCalls.find(function (c) {
              return typeof c[0] === 'string' &&
                     c[0].indexOf('test:kiosk:pending-charge:') === 0;
            });
            expect(pendingCall).toBeTruthy();
            expect(pendingCall[0]).toBe('test:kiosk:pending-charge:REF-D13-001');
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale'](req, res);
      });

      test('T5: kiosk/sale pending record has reference_number, amount, idempotency_key, created_at', function (done) {
        // Key-aware mock: return catalog for the products key, null for idempotency key
        // (null prevents the acquireIdempotencyLock from short-circuiting as a replay)
        cache.get.mockImplementation(function (key) {
          if (key === 'test:kiosk-products') return Promise.resolve(CATALOG_EXEMPT);
          return Promise.resolve(null);
        });
        helcimLib.terminalPurchase.mockResolvedValue({});
        var req = {
          body: {
            items:            [{ item_id: 'item-gc-test', name: 'Gift Test Item', quantity: 1 }],
            reference_number: 'REF-D13-SHAPE',
            idempotency_key:  'idem-key-d13'
          }
        };
        var res = mockRes();

        res.json.mockImplementation(function () {
          try {
            var setCalls = cache.set.mock.calls;
            var pendingCall = setCalls.find(function (c) {
              return typeof c[0] === 'string' &&
                     c[0].indexOf('test:kiosk:pending-charge:') === 0;
            });
            expect(pendingCall).toBeTruthy();
            var record = pendingCall[1];
            expect(record.reference_number).toBe('REF-D13-SHAPE');
            expect(typeof record.amount).toBe('number');
            expect(record.idempotency_key).toBe('idem-key-d13');
            expect(typeof record.created_at).toBe('string');
            done();
          } catch (e) { done(e); }
        });
        res.status.mockImplementation(function (code) {
          if (code >= 400) {
            return { json: function (b) { done(new Error('Got ' + code + ': ' + JSON.stringify(b))); } };
          }
          return res;
        });

        handlers['/api/kiosk/sale'](req, res);
      });
    });

    // -----------------------------------------------------------------------
    // /api/kiosk/salesorder-pay — pending context persisted on timeout (D-13)
    // -----------------------------------------------------------------------
    describe('/api/kiosk/salesorder-pay — pending context persisted on timeout', function () {

      function makeSoPayReq(soId) {
        return { body: { salesorder_id: soId }, headers: {} };
      }

      function makeSoGetMock(soId, soNumber, balance) {
        return {
          salesorder: {
            salesorder_id:     soId,
            salesorder_number: soNumber,
            balance:           balance,
            status:            'confirmed',
            customer_id:       'CUST-D13'
          }
        };
      }

      // D-50-01b (50-02): salesorder-pay now gives each attempt a UNIQUE
      // terminal reference (soNumber + '-' + a 6-char slice of the
      // deterministic Helcim idempotency key) instead of reusing the bare
      // soNumber — two attempts against the same order previously collided
      // on this exact string (T-50-08), which is the defect these two
      // assertions used to encode as correct. No idempotency_key is sent in
      // makeSoPayReq, so the route falls back to the SO-id-scoped key
      // ('so:' + soId) per D-50-01 — replicated here to compute the expected
      // reference the same way routes/pos.js does.
      function expectedSoPayRefNumber(soId, soNumber) {
        var effectiveKey = 'so:' + soId;
        var helcimIdemKey = crypto.createHash('sha256').update(effectiveKey).digest('hex').substring(0, 25);
        return (soNumber + '-' + helcimIdemKey.substring(0, 6)).slice(0, 64);
      }

      test('T6: salesorder-pay timeout → cache.set called with KIOSK_PENDING_CHARGE_PREFIX + refNumber (D-50-01b unique reference)', function (done) {
        zohoApi.zohoGet.mockResolvedValue(
          makeSoGetMock('SO-D13-001', 'SO-00D13', 80.00)
        );
        helcimLib.terminalPurchase.mockRejectedValue(new Error('Terminal timeout after 90s'));

        var req = makeSoPayReq('SO-D13-001');
        var res = mockRes();
        var expectedRef = expectedSoPayRefNumber('SO-D13-001', 'SO-00D13');

        res.status.mockImplementation(function (code) {
          return {
            json: function () {
              try {
                expect(code).toBe(504);
                var setCalls = cache.set.mock.calls;
                var pendingCall = setCalls.find(function (c) {
                  return typeof c[0] === 'string' &&
                         c[0].indexOf('test:kiosk:pending-charge:') === 0;
                });
                expect(pendingCall).toBeTruthy();
                expect(pendingCall[0]).toBe('test:kiosk:pending-charge:' + expectedRef);
                done();
              } catch (e) { done(e); }
            }
          };
        });

        handlers['/api/kiosk/salesorder-pay'](req, res);
      });

      test('T7: salesorder-pay pending record has salesorder_id, reference_number, amount, idempotency_key, created_at', function (done) {
        zohoApi.zohoGet.mockResolvedValue(
          makeSoGetMock('SO-D13-002', 'SO-00D14', 120.00)
        );
        helcimLib.terminalPurchase.mockRejectedValue(new Error('Terminal timeout after 90s'));

        var req = makeSoPayReq('SO-D13-002');
        var res = mockRes();
        var expectedRef = expectedSoPayRefNumber('SO-D13-002', 'SO-00D14');

        res.status.mockImplementation(function (code) {
          return {
            json: function () {
              try {
                var setCalls = cache.set.mock.calls;
                var pendingCall = setCalls.find(function (c) {
                  return typeof c[0] === 'string' &&
                         c[0].indexOf('test:kiosk:pending-charge:') === 0;
                });
                expect(pendingCall).toBeTruthy();
                var record = pendingCall[1];
                expect(record.salesorder_id).toBe('SO-D13-002');
                expect(record.reference_number).toBe(expectedRef);
                expect(record.amount).toBeCloseTo(120.00, 2);
                expect(typeof record.idempotency_key).toBe('string');
                expect(record.idempotency_key.length).toBeGreaterThan(0);
                expect(typeof record.created_at).toBe('string');
                done();
              } catch (e) { done(e); }
            }
          };
        });

        handlers['/api/kiosk/salesorder-pay'](req, res);
      });

      test('T8: salesorder-pay timeout → staff still receive 504 response', function (done) {
        zohoApi.zohoGet.mockResolvedValue(
          makeSoGetMock('SO-D13-003', 'SO-00D15', 50.00)
        );
        helcimLib.terminalPurchase.mockRejectedValue(new Error('Terminal timeout after 90s'));

        var req = makeSoPayReq('SO-D13-003');
        var res = mockRes();

        res.status.mockImplementation(function (code) {
          return {
            json: function (body) {
              try {
                expect(code).toBe(504);
                expect(body.error).toMatch(/time/i);
                done();
              } catch (e) { done(e); }
            }
          };
        });

        handlers['/api/kiosk/salesorder-pay'](req, res);
      });
    });
  });
});

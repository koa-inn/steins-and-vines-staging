'use strict';

// ---------------------------------------------------------------------------
// giftcard-account-failclosed.test.js — 52-03 (M3, RESIL-01)
//
// Defect: `/api/kiosk/sale/confirm`'s gift-card clearing customerpayment
// (Payment-2) hardcoded a fallback ledger account_id
// (`process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID || '109900000000873231'`)
// — if the env var is unset or mis-pointed, a live redemption silently posts
// to a guessed Zoho account instead of the real "Gift Cards Sold" clearing
// account.
//
// Fix: no hardcoded fallback. When a gift-card redemption is in play
// (gcApplied > 0 && gcCertNum) but ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID is
// unset, the confirm handler fails CLOSED — before the Zoho invoice is even
// created (mirrors the adjacent CR-02 gcConfirmLookup 'invalid' void-then-
// reject precedent) — voiding any terminal charge already pushed instead of
// posting a customerpayment to a guessed ledger.
//
// RED phase (this file, before the pos.js fix): the confirm handler posts a
// customerpayment with the literal fallback account_id and does NOT fail
// closed.
// GREEN phase (after the fix): no customerpayment ever carries the literal
// fallback account_id; the redemption fails closed when the env is unset,
// and posts with the real env account_id when it is set (preserved).
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
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-m3-1' }),
    pollTerminalResult: jest.fn().mockResolvedValue({
      approved: true, transactionId: 'txn-m3-real', authorizationCode: 'AUTH1', cardType: 'Visa'
    }),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-m3-so-1'),
    cancelTerminal: jest.fn().mockResolvedValue({}),
    // 50-03 (M-A3): captured-amount readback, added by plan 50-03 to the
    // plain-terminal confirm path. No default — set where needed (below) with
    // the SAME total the test's own cart/catalog establishes.
    getCardTransactionById: jest.fn()
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-m3-1', invoice_number: 'INV-M3-001' } }),
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

jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
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

var HARDCODED_FALLBACK_ACCOUNT_ID = '109900000000873231';

var CATALOG_EXEMPT = [
  {
    item_id:        'item-m3-test',
    name:           'M3 Test Item',
    rate:           100.00,
    stock_on_hand:  10,
    tax_percentage: 0,
    tax_id:         'm3-test-exempt', // blocks default 5% -> grandTotal = $100
    custom_fields:  []
  }
];

describe('gift-card clearing account — fails closed when env unset (52-03 M3)', function () {
  var cache, zohoApi, helcimLib, moneyPath, router, handlers;

  function getHandlers() {
    jest.resetModules();
    cache     = require('../lib/cache');
    zohoApi   = require('../lib/zoho-api');
    helcimLib = require('../lib/helcim');
    moneyPath = require('../lib/money-path');
    require('../routes/pos');
    router   = require('express').Router();
    handlers = {};
    router.post.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
    router.get.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
  }

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn(), headersSent: false };
    res.status.mockReturnValue(res);
    return res;
  }

  beforeEach(function () {
    getHandlers();
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(CATALOG_EXEMPT);
      return Promise.resolve(null);
    });
    // No APPS_SCRIPT_URL/TOKEN set — gcConfirmBalanceLookup resolves null,
    // gcApplied = gcSubmittedConfirm directly (isolates the M3 account check).
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
  });

  function confirmReq() {
    return {
      body: {
        items:             [{ item_id: 'item-m3-test', name: 'M3 Test Item', quantity: 1 }],
        transaction_id:    'txn-m3-real', // real txn id -> isManualConfirm = false, no poll needed
        reference_number:  'KIOSK-M3-REF',
        gift_card:         { cert_number: 'GC-000099', amount_applied: 40 } // partial redemption
      }
    };
  }

  test('env UNSET: redemption fails closed — no customerpayment carries the hardcoded fallback account_id', function (done) {
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;

    var req = confirmReq();
    var res = mockRes();
    var statusCapture = { code: null };
    res.status.mockImplementation(function (code) { statusCapture.code = code; return res; });
    res.json.mockImplementation(function (body) {
      try {
        // Must fail closed — not proceed as a normal 201 booking.
        expect(statusCapture.code).not.toBe(201);
        expect(body.error).toBeTruthy();

        // No customerpayment ever posted with the literal hardcoded account_id.
        var gcPayCalls = zohoApi.zohoPost.mock.calls.filter(function (c) {
          return c[0] === '/customerpayments' && c[1] && c[1].account_id === HARDCODED_FALLBACK_ACCOUNT_ID;
        });
        expect(gcPayCalls.length).toBe(0);

        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('env UNSET: no invoice is created at all — fails closed before the Zoho invoice/payment chain', function (done) {
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;

    var req = confirmReq();
    var res = mockRes();
    var statusCapture = { code: null };
    res.status.mockImplementation(function (code) { statusCapture.code = code; return res; });
    res.json.mockImplementation(function () {
      try {
        var invoiceCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
        expect(invoiceCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('env UNSET: terminal charge already pushed is voided rather than left orphaned', function (done) {
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;

    var req = confirmReq();
    var res = mockRes();
    res.status.mockReturnValue(res);
    res.json.mockImplementation(function () {
      try {
        expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('env SET: clearing payment still posts with the real env account_id (preserved behavior)', function (done) {
    process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = '109900000000873209';
    // 50-03 (M-A3): rate=100, tax 0%, gift card $40 applied -> terminalApplied=60
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 60.00 });

    var req = confirmReq();
    var res = mockRes();
    var statusCapture = { code: null };
    res.status.mockImplementation(function (code) { statusCapture.code = code; return res; });
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code === null || statusCapture.code === 201).toBe(true);
        expect(body.ok).toBe(true);
        var gcPayCalls = zohoApi.zohoPost.mock.calls.filter(function (c) {
          return c[0] === '/customerpayments' && c[1] && c[1].payment_mode === 'others';
        });
        expect(gcPayCalls.length).toBe(1);
        expect(gcPayCalls[0][1].account_id).toBe('109900000000873209');
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });
});

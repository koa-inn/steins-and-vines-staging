'use strict';

/**
 * pos-money-defects.test.js — Regression tests for CR-01, CR-02, WR-03
 *
 * CR-01: confirm fallback seed prevents orphan charge after terminal push
 *   - pos.js /api/kiosk/sale/confirm: T6 in pos-money.test.js covers this
 *   - pos-recipe.js /api/kiosk/recipe-sale/confirm: covered here
 *
 * CR-02: discriminated GC balance lookup rejects invalid certs (hard-reject, not undercharge)
 *   - pos.js sale path: bogus cert (ok:false) → 400, not undercharge terminal
 *   - pos.js sale path: unavailable Apps Script + production → 503
 *   - pos.js confirm path: bogus cert → 400
 *
 * WR-03: idempotency lock released on terminal failure so retries can re-acquire
 *   - pos.js sale path: cache.releaseLock called when terminal push fails
 *
 * RED phase: all tests FAIL before the fixes.
 * GREEN phase: all tests PASS after.
 */

// =============================================================================
// Shared mocks used by BOTH pos.js AND pos-recipe.js describe blocks
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
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-def-1' }),
    pollTerminalResult: jest.fn().mockResolvedValue({
      approved: true, transactionId: 'txn-def-123', authorizationCode: 'AUTH1', cardType: 'Visa'
    }),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-def-so-1'),
    cancelTerminal: jest.fn().mockResolvedValue({}),
    // 50-03 (M-A3): captured-amount readback, added by plan 50-03 to the
    // plain-terminal confirm path. No default — set where needed (F2 describe
    // block below) with the SAME total the test's own cart/catalog establishes.
    getCardTransactionById: jest.fn()
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-def-1', invoice_number: 'INV-DEF-001' } }),
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
      return helcimLike.voidTransaction(txnId)
        .then(function () {})
        .catch(function () {});
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

// recipe-scaling mock needed for pos-recipe.js
jest.mock('../lib/recipe-scaling', function () {
  return {
    scaleIngredients: jest.fn().mockReturnValue([
      { item_id: 'ing-malt-1', item_name: 'Pale Malt', quantity: 5.5, unit: 'kg' }
    ]),
    checkScaledStock: jest.fn().mockReturnValue({ ok: true, conflicts: [] }),
    computeScaledRecipeTotal: jest.fn().mockReturnValue(245),
    computeModifiedRecipeTotal: jest.fn().mockReturnValue(245),
    // 73-03: pos-recipe.js now routes every invoice line + quote line_total
    // through ingredientLineCost (D-01/D-02). This mock's fixtures are all
    // same-unit (kg/kg), so a simple pass-through (no real conversion) keeps
    // this file's existing (non-conversion) assertions unchanged.
    ingredientLineCost: jest.fn().mockImplementation(function (item, line) {
      var qty = Number(line && line.quantity) || 0;
      var rate = Number(item && item.rate) || 0;
      return { ok: true, convertedQty: qty, cost: Math.round(qty * rate * 100) / 100 };
    })
  };
});

// =============================================================================
// Test catalog fixtures
// =============================================================================

var CATALOG_EXEMPT = [
  {
    item_id:        'item-gc-def',
    name:           'Test Item',
    rate:           100.00,
    stock_on_hand:  10,
    tax_percentage: 0,
    tax_id:         'exempt-tax',
    custom_fields:  []
  }
];

// Mock recipe response that callAppsScriptPost returns
var MOCK_RECIPE_RESPONSE = {
  ok: true,
  data: {
    recipe: {
      recipe_id:    'RCP-DEF-001',
      name:         'Test Pale Ale',
      style:        'APA',
      abv:          5.2,
      batch_size_l: 20,
      locked_price: 195.00,
      service_fee:  45.00,
      materials_fee: 5.00,
      pricing_mode: 'locked',
      status:       'active'
    },
    ingredients: [
      { ingredient_id: 'ING-001', item_id: 'ing-malt-1', item_name: 'Pale Malt', quantity: 5.5, unit: 'kg' }
    ]
  }
};

// =============================================================================
// Test harness for pos.js
// =============================================================================

var cache, helcimLib, axiosMock, zohoApi, moneyPath, router, handlers;

function getPosHandlers() {
  jest.resetModules();
  cache      = require('../lib/cache');
  helcimLib  = require('../lib/helcim');
  axiosMock  = require('axios');
  zohoApi    = require('../lib/zoho-api');
  moneyPath  = require('../lib/money-path');
  require('../routes/pos');
  router   = require('express').Router();
  handlers = {};
  router.post.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
  router.get.mock.calls.forEach(function (call) { handlers[call[0]] = call[call.length - 1]; });
}

// Test harness for pos-recipe.js (uses different handler registry pattern)
var mockRouteHandlers = {};
jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post:   jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
    put:    jest.fn(function (path, handler) { mockRouteHandlers['PUT:' + path] = handler; }),
    delete: jest.fn(function (path, handler) { mockRouteHandlers['DELETE:' + path] = handler; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

function getRecipeMocks() {
  mockRouteHandlers = {};
  jest.resetModules();
  var mocks = {
    cache:   require('../lib/cache'),
    zohoApi: require('../lib/zoho-api'),
    helcim:  require('../lib/helcim'),
    axios:   require('axios'),
    moneyPath: require('../lib/money-path')
  };
  require('../routes/pos-recipe');
  return mocks;
}

function callRecipeHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var key = method + ':' + path;
    var handler = mockRouteHandlers[key];
    if (!handler) return reject(new Error('No handler registered for ' + key));
    var res = {
      _status: 200, _body: null, headersSent: false,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; res.headersSent = true; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
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

// =============================================================================
// CR-01 — recipe-sale/confirm: idempotency key derived from transaction_id
// =============================================================================

describe('CR-01 — recipe-sale/confirm acquires idempotency lock from transaction_id seed', function () {
  var recipeMocks;

  beforeEach(function () {
    recipeMocks = getRecipeMocks();
    process.env.BEER_SALES_ENABLED        = 'true';
    process.env.APPS_SCRIPT_URL           = 'https://script.example.com/exec';
    process.env.APPS_SCRIPT_SERVER_TOKEN  = 'server-token-test';
    process.env.KIOSK_CONTACT_ID          = 'contact-default';
    process.env.MAKERS_FEE_ITEM_ID        = 'fee-makers-1';
    process.env.MATERIALS_FEE_ITEM_ID     = 'fee-materials-1';

    recipeMocks.moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    recipeMocks.cache.acquireLock.mockResolvedValue(true);
    recipeMocks.cache.releaseLock.mockResolvedValue();
    recipeMocks.cache.del.mockResolvedValue(1);
    recipeMocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve([
        { item_id: 'ing-malt-1', name: 'Pale Malt', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' }
      ]);
      return Promise.resolve(null);
    });
    // Apps Script returns recipe
    recipeMocks.axios.post.mockResolvedValue({ data: MOCK_RECIPE_RESPONSE });
    recipeMocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-cr01', invoice_number: 'INV-CR01' } });
  });

  afterEach(function () {
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.NODE_ENV;
  });

  test('CR-01-A: recipe-sale/confirm calls acquireIdempotencyLock with confirm:transaction_id seed', function () {
    // CR-01 fix: recipe-sale/confirm must acquire idempotency lock from
    // body.idempotency_key || body.transaction_id || body.reference seed.
    // Before the fix, moneyPath.acquireIdempotencyLock is never called.
    return callRecipeHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id:      'RCP-DEF-001',
        transaction_id: 'txn-cr01-123',
        reference:      'RECIPE-CR01-001',
        sale_type:      'in-store'
        // no idempotency_key — must fall back to transaction_id
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(recipeMocks.moneyPath.acquireIdempotencyLock).toHaveBeenCalledWith(
        recipeMocks.cache,
        'test:idem:confirm:txn-cr01-123',
        expect.any(Number)
      );
    });
  });

  test('CR-01-B: recipe-sale/confirm in production with only transaction_id → proceeds (not 400)', function () {
    process.env.NODE_ENV = 'production';
    return callRecipeHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id:      'RCP-DEF-001',
        transaction_id: 'txn-cr01-prod',
        reference:      'RECIPE-CR01-PROD',
        sale_type:      'in-store'
        // no idempotency_key
      }
    }).then(function (res) {
      // Must NOT 400 — card was charged; bare 400 = orphan charge
      expect(res._status).toBe(201);
      expect(res._body.ok).toBe(true);
    });
  });

  test('CR-01-C: recipe-sale/confirm replay returns cached result without second invoice', function () {
    var cachedResult = { ok: true, invoice_number: 'INV-CR01-REPLAY', total: 245 };
    recipeMocks.moneyPath.acquireIdempotencyLock.mockResolvedValueOnce({
      status: 'replay',
      cached: cachedResult
    });
    return callRecipeHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id:       'RCP-DEF-001',
        transaction_id:  'txn-cr01-replay',
        idempotency_key: 'idem-cr01-replay',
        reference:       'RECIPE-CR01-REPLAY',
        sale_type:       'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.invoice_number).toBe('INV-CR01-REPLAY');
      // Must NOT have called zohoPost — replay short-circuits
      var invoiceCalls = recipeMocks.zohoApi.zohoPost.mock.calls.filter(function (c) {
        return c[0] === '/invoices';
      });
      expect(invoiceCalls.length).toBe(0);
    });
  });
});

// =============================================================================
// CR-02 — discriminated GC balance validation
// =============================================================================

describe('CR-02 — gift card balance validation: discriminated result rejects invalid certs', function () {

  beforeEach(function () {
    getPosHandlers();
    process.env.KIOSK_CONTACT_ID           = 'contact-walkin';
    process.env.APPS_SCRIPT_URL            = 'https://script.example.com/exec';
    process.env.APPS_SCRIPT_SERVER_TOKEN   = 'server-token-test';
    process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = '109900000000873231';
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(CATALOG_EXEMPT);
      return Promise.resolve(null);
    });
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-cr02', invoice_number: 'INV-CR02' } });
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;
    delete process.env.NODE_ENV;
  });

  // ---- SALE PATH ----

  test('CR-02-A: sale with bogus cert (Apps Script ok:false) + amount_applied=grandTotal → 400 hard reject, terminal NOT charged', function (done) {
    // The bug: ok:false → null → fail-open → terminal charged $0, bogus cert accepted
    // The fix: ok:false → { state: invalid } → hard-reject 400
    axiosMock.post.mockImplementation(function (url, body) {
      var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
      if (parsed && parsed.action === 'lookup_gift_card') {
        return Promise.resolve({ data: { ok: false, error: 'not_found' } });
      }
      return Promise.resolve({ data: { ok: true } });
    });

    var req = {
      body: {
        items:     [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        gift_card: { cert_number: 'GC-999999', amount_applied: 100 }  // bogus cert, covers full $100
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(400);
        expect(body.error).toMatch(/gift card/i);
        // Terminal must NOT have been charged (bogus cert must be rejected before push)
        expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('CR-02-B: sale with App Script unreachable + production → 503', function (done) {
    process.env.NODE_ENV = 'production';
    axiosMock.post.mockRejectedValue(new Error('Network timeout'));

    var req = {
      body: {
        items:           [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        // idempotency_key required by the sale endpoint in production (D-12 prod guard)
        idempotency_key: 'idem-cr02-b-prod',
        gift_card:       { cert_number: 'GC-000001', amount_applied: 50 }
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function () {
      try {
        expect(statusCapture.code).toBe(503);
        expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('CR-02-C: sale with valid cert + over-applied → clamped terminal amount (ok path unchanged)', function (done) {
    // Catalog: $100 item → grandTotal=$100; cert balance=$30; submitted=$60 → clamp to $30
    axiosMock.post.mockImplementation(function (url, body) {
      var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
      if (parsed && parsed.action === 'lookup_gift_card') {
        return Promise.resolve({ data: { ok: true, data: { current_balance: 30 } } });
      }
      return Promise.resolve({ data: { ok: true } });
    });

    var req = {
      body: {
        items:     [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        gift_card: { cert_number: 'GC-000001', amount_applied: 60 }  // balance=30, clamp to 30
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(body.pending).toBe(true);
        var termCall = helcimLib.terminalPurchase.mock.calls[0];
        expect(termCall).toBeTruthy();
        // terminal = grandTotal - clamped_gift = 100 - 30 = 70
        expect(termCall[0]).toBeCloseTo(70, 2);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  // ---- CONFIRM PATH ----

  test('CR-02-D: confirm with bogus cert (ok:false) in production → 400 hard reject', function (done) {
    process.env.NODE_ENV = 'production';
    axiosMock.post.mockImplementation(function (url, body) {
      var parsed = (typeof body === 'string') ? JSON.parse(body) : body;
      if (parsed && parsed.action === 'lookup_gift_card') {
        return Promise.resolve({ data: { ok: false, error: 'not_found' } });
      }
      return Promise.resolve({ data: { ok: true } });
    });

    var req = {
      body: {
        items:          [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        transaction_id: 'txn-cr02-confirm',
        reference_number: 'KIOSK-CR02-CONFIRM',
        idempotency_key: 'idem-cr02-confirm',
        gift_card:      { cert_number: 'GC-999999', amount_applied: 100 }
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(400);
        expect(body.error).toMatch(/gift card/i);
        // zohoPost /invoices must NOT be called (reject before invoice creation)
        var invoiceCalls = zohoApi.zohoPost.mock.calls.filter(function (c) {
          return c[0] === '/invoices';
        });
        expect(invoiceCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });
});

// =============================================================================
// WR-03 — idempotency lock released on terminal failure
// =============================================================================

describe('WR-03 — idempotency lock released on terminal failure so retries can re-acquire', function () {

  beforeEach(function () {
    getPosHandlers();
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(CATALOG_EXEMPT);
      return Promise.resolve(null);
    });
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    helcimLib.terminalPurchase.mockRejectedValue(new Error('Terminal connection refused'));
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
  });

  test('WR-03-A: terminal failure → cache.releaseLock called with the idempotency key', function (done) {
    var req = {
      body: {
        items:           [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        idempotency_key: 'wr03-idem-key-001'
      }
    };
    var res = mockRes();
    res.json.mockImplementation(function () {
      try {
        // Lock must be released on terminal failure so retries can re-acquire
        expect(cache.releaseLock).toHaveBeenCalledWith('test:idem:wr03-idem-key-001');
        done();
      } catch (e) { done(e); }
    });
    res.status.mockImplementation(function (code) {
      expect(code).toBe(502);
      return res;
    });
    handlers['/api/kiosk/sale'](req, res);
  });

  test('WR-03-B: terminal failure → 502 response (not a different error code)', function (done) {
    var req = {
      body: {
        items:           [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        idempotency_key: 'wr03-idem-key-002'
      }
    };
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(502);
        expect(body.error).toBeTruthy();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale'](req, res);
  });
});

// =============================================================================
// F2 (45-09) — manual-confirm verifies the terminal charge before booking
//
// Root cause (UAT 45-09): the "Confirm Manually" fallback books a creditcard
// payment on trust — it never verifies a charge actually happened and records the
// literal string 'manual-confirm' instead of the real Helcim txn id. That is a
// phantom-revenue risk (uncharged invoice booked as paid) plus a reconciliation
// gap. Fix: when confirm carries no real terminal txn id ('manual-confirm' / none)
// and a card amount is owed, resolve the approved transaction from Helcim first;
// fail closed (no invoice, no payment) if it can't be positively verified.
//
// RED before the pos.js fix, GREEN after.
// =============================================================================

describe('F2 — manual-confirm verifies terminal charge before booking', function () {

  beforeEach(function () {
    getPosHandlers();
    process.env.KIOSK_CONTACT_ID = 'contact-walkin';
    delete process.env.NODE_ENV;
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(CATALOG_EXEMPT);
      return Promise.resolve(null);
    });
    moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'acquired' });
    zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-f2', invoice_number: 'INV-F2-001' } });
    // 50-03 (M-A3): CATALOG_EXEMPT item-gc-def rate=100, tax 0% -> grandTotal=100
    // for every F2 test that reaches the invoice chain (F2-A, F2-D).
    helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 100.00 });
  });

  afterEach(function () {
    delete process.env.KIOSK_CONTACT_ID;
  });

  function manualConfirmReq(txnId) {
    return {
      body: {
        items:            [{ item_id: 'item-gc-def', name: 'Test Item', quantity: 1 }],
        transaction_id:   txnId,               // 'manual-confirm' or a real id
        reference_number: 'KIOSK-F2-REF',
        idempotency_key:  'idem-f2-' + String(txnId)
      }
    };
  }

  test('F2-A: manual-confirm with an APPROVED terminal txn → books the REAL Helcim id (not "manual-confirm")', function (done) {
    helcimLib.pollTerminalResult.mockResolvedValue({
      approved: true, transactionId: 'txn-real-approved', status: 'APPROVED', cardType: 'Visa'
    });
    var req = manualConfirmReq('manual-confirm');
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(201);
        expect(body.ok).toBe(true);
        // Verification must have resolved the real charge for THIS reference
        expect(helcimLib.pollTerminalResult).toHaveBeenCalledWith('KIOSK-F2-REF');
        // The booked response + creditcard payment carry the real id, never 'manual-confirm'
        expect(body.transaction_id).toBe('txn-real-approved');
        var cardPay = zohoApi.zohoPost.mock.calls.filter(function (c) {
          return c[0] === '/customerpayments' && c[1] && c[1].payment_mode === 'creditcard';
        });
        expect(cardPay.length).toBe(1);
        expect(cardPay[0][1].reference_number).toBe('txn-real-approved');
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('F2-B: manual-confirm but terminal reports DECLINED → 400, nothing booked (no invoice)', function (done) {
    helcimLib.pollTerminalResult.mockResolvedValue({
      approved: false, transactionId: '', status: 'DECLINED', cardType: ''
    });
    var req = manualConfirmReq('manual-confirm');
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(400);
        expect(body.error).toBeTruthy();
        var invoiceCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
        expect(invoiceCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('F2-C: manual-confirm but terminal result still PENDING/unverifiable → 409, nothing booked', function (done) {
    helcimLib.pollTerminalResult.mockResolvedValue({
      approved: false, transactionId: null, status: 'PENDING', cardType: ''
    });
    var req = manualConfirmReq('manual-confirm');
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(409);
        expect(body.error).toMatch(/reconcil|verif|re-?charge/i);
        var invoiceCalls = zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
        expect(invoiceCalls.length).toBe(0);
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });

  test('F2-D: a real terminal transaction_id (auto-confirm) is trusted — pollTerminalResult NOT called', function (done) {
    var req = manualConfirmReq('txn-real-999');
    var res = mockRes();
    var statusCapture = captureStatus(res);
    res.json.mockImplementation(function (body) {
      try {
        expect(statusCapture.code).toBe(201);
        expect(body.transaction_id).toBe('txn-real-999');
        expect(helcimLib.pollTerminalResult).not.toHaveBeenCalled();
        done();
      } catch (e) { done(e); }
    });
    handlers['/api/kiosk/sale/confirm'](req, res);
  });
});

'use strict';

/**
 * Phase 101-05 Task 1: computeCartPricing / taxGroups are a behaviour-neutral
 * extraction of the /sale pricing core. These tests pin computeTax results and
 * prove computeCartPricing equals what /sale actually charges.
 */

jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });
jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({ idempotencyKey: 'idem-1' }),
    pollTerminalResult: jest.fn(),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    generateIdempotencyKey: jest.fn().mockReturnValue('idem-so-1'),
    cancelTerminal: jest.fn().mockResolvedValue({})
  };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
});
var mockProducts = [];
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(mockProducts);
      return Promise.resolve(null);
    }),
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
jest.mock('../lib/mailer', function () { return { sendVoidFailureAlert: jest.fn().mockResolvedValue({}) }; });
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
    voidWithTimeout: jest.fn().mockResolvedValue(),
    CHECKOUT_IDEMPOTENCY_TTL: 600
  };
});
jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS: 'test:kiosk-products',
      RECENT_ORDERS: 'test:recent-orders',
      KIOSK_IDEM_PREFIX: 'test:idem:',
      KIOSK_SALESORDERS: 'test:kiosk-salesorders',
      KIOSK_DISCOUNT_PRESETS: 'test:kiosk-discount-presets',
      CONSIGNMENT_REPORT_PREFIX: 'test:consignment:report:',
      KIOSK_PENDING_CHARGE_PREFIX: 'test:kiosk:pending-charge:',
      INGREDIENTS_ALL: 'zoho:ingredients:all'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' },
    LEDGER_KEYS: {},
    RATE_LIMIT_PREFIX: 'test:rl:'
  };
});

var pos, router, handlers, helcimLib;

function load() {
  jest.resetModules();
  helcimLib = require('../lib/helcim');
  pos = require('../routes/pos');
  router = require('express').Router();
  handlers = {};
  router.post.mock.calls.forEach(function (c) { handlers[c[0]] = c[c.length - 1]; });
}

function mockRes() {
  var r = { json: jest.fn(), status: jest.fn(), headersSent: false };
  r.status.mockReturnValue(r);
  return r;
}

function r2(n) { return Math.round(n * 100) / 100; }

var CATALOG = {
  'p-beer': { item_id: 'p-beer', name: 'Beer', rate: 10, tax_percentage: 12, sales_tax_rule_id: undefined },
  'p-food': { item_id: 'p-food', name: 'Snack', rate: 7.33, tax_percentage: 5 },
  'p-zero': { item_id: 'p-zero', name: 'Zero', rate: 4, tax_percentage: 0, tax_id: 'tz' },
  'p-can': { item_id: 'p-can', name: 'Can', rate: 3.19, tax_percentage: 12 }
};

describe('computeTax / taxGroups (behaviour-neutral split)', function () {
  beforeEach(load);

  var fixtures = [
    { name: 'single 12%', lines: [{ item_id: 'p-beer', quantity: 3, rate: 10 }], tax: 3.6 },
    { name: 'mixed 5% + 12%', lines: [
      { item_id: 'p-beer', quantity: 1, rate: 10 },
      { item_id: 'p-food', quantity: 3, rate: 7.33 }
    ], tax: r2(1.2) + r2(21.99 * 0.05) },
    { name: 'canning bundle-like discounted lines', lines: [
      { item_id: 'p-can', quantity: 6, rate: 3.19, discount: '10%' },
      { item_id: 'p-zero', quantity: 2, rate: 4 },
      { custom: true, description: 'x', quantity: 1, rate: 12.5, tax_percentage: 5 }
    ], tax: null }
  ];

  fixtures.forEach(function (f) {
    test('computeTax equals the per-group rounded sum: ' + f.name, function () {
      var res = pos.computeTax(f.lines, CATALOG);
      var groups = pos.taxGroups(f.lines, CATALOG);
      var sum = 0;
      Object.keys(groups.byRate).forEach(function (k) { sum += r2(groups.byRate[k]); });
      expect(res.taxTotal).toBe(r2(sum));
      if (f.tax !== null) expect(res.taxTotal).toBe(r2(f.tax));
    });
  });

  test('unresolved tax returns the same fail-closed error from both', function () {
    var lines = [{ item_id: 'p-x', quantity: 1, rate: 1 }];
    var map = { 'p-x': { item_id: 'p-x', name: 'Mystery' } };
    var a = pos.computeTax(lines, map);
    var b = pos.taxGroups(lines, map);
    expect(a.error).toMatch(/Cannot determine tax for "Mystery"/);
    expect(b.error).toBe(a.error);
  });
});

describe('computeCartPricing on product-only carts', function () {
  beforeEach(function () {
    load();
    mockProducts = Object.keys(CATALOG).map(function (k) { return CATALOG[k]; });
  });

  test('returns the same grandTotal /sale charges the terminal', function (done) {
    var body = {
      items: [
        { item_id: 'p-beer', quantity: 2 },
        { item_id: 'p-food', quantity: 3 },
        { item_id: 'p-can', quantity: 6 }
      ]
    };
    pos.computeCartPricing(JSON.parse(JSON.stringify(body)), CATALOG).then(function (pricing) {
      expect(pricing.ok).toBe(true);
      expect(pricing.recipe).toBe(null);
      expect(pricing.lineItems).toHaveLength(3);
      var res = mockRes();
      res.json.mockImplementation(function () {
        try {
          expect(helcimLib.terminalPurchase).toHaveBeenCalled();
          expect(helcimLib.terminalPurchase.mock.calls[0][0]).toBe(pricing.grandTotal);
          done();
        } catch (e) { done(e); }
      });
      handlers['/api/kiosk/sale']({ body: body }, res);
    }).catch(done);
  });

  test('error contract: unresolved tax -> {ok:false, status:400, tag:tax}', function () {
    var map = { 'p-x': { item_id: 'p-x', name: 'Mystery', rate: 5 } };
    return pos.computeCartPricing({ items: [{ item_id: 'p-x', quantity: 1 }] }, map).then(function (p) {
      expect(p.ok).toBe(false);
      expect(p.status).toBe(400);
      expect(p.tag).toBe('tax');
      expect(p.error).toMatch(/Cannot determine tax/);
    });
  });

  test('missing gift-card item id -> 503 bundle-tagged error, same order as before', function () {
    delete process.env.KIOSK_GIFT_CARD_ITEM_ID;
    return pos.computeCartPricing({ items: [{ gift_cert: true, cert_number: 'GC-000001', rate: 50 }] }, CATALOG).then(function (p) {
      expect(p.ok).toBe(false);
      expect(p.status).toBe(503);
    });
  });
});

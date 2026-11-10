'use strict';

/**
 * Phase 101-07 (D-19): POST /api/kiosk/cart-quote returns exactly what
 * /api/kiosk/sale would charge for the same body, read-only (no lock, no Helcim,
 * no Zoho, no catalog rebuild).
 */

var mockRouteHandlers = {};

jest.mock('../routes/catalog', function () {
  return {
    rebuildKioskCatalog: jest.fn(function () {
      return Promise.resolve(global.__rebuildCatalog || []);
    })
  };
});

jest.mock('express', function () {
  var router = {
    get: jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post: jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
    put: jest.fn(function (path, handler) { mockRouteHandlers['PUT:' + path] = handler; }),
    delete: jest.fn(function (path, handler) { mockRouteHandlers['DELETE:' + path] = handler; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    initializeCheckout: jest.fn().mockResolvedValue({ checkoutToken: 'tok-1' }),
    voidTransaction: jest.fn().mockResolvedValue({})
  };
});

jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(),
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
jest.mock('../lib/mailer', function () { return { sendVoidFailureAlert: jest.fn().mockResolvedValue() }; });
jest.mock('../lib/inventory-ledger', function () {
  return { decrementStock: jest.fn().mockResolvedValue({}), reconcileFromZoho: jest.fn() };
});
jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn(), detectRecipeSale: jest.fn() };
});
jest.mock('../lib/recipe-store', function () { return { get: jest.fn() }; });
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
      RECIPES: 'sv:recipes',
      RECIPES_TS: 'sv:recipes:ts',
      INGREDIENTS: 'zoho:ingredients',
      INGREDIENTS_ALL: 'zoho:ingredients:all',
      KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets',
      KIOSK_IDEM_PREFIX: 'kiosk:idem:',
      KIOSK_PENDING_CHARGE_PREFIX: 'kiosk:pending-charge:'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' }
  };
});

var fx = require('./fixtures/recipe-mixed-carts');

var ENV_KEYS = ['MAKERS_FEE_ITEM_ID', 'MATERIALS_FEE_ITEM_ID', 'MILLING_FEE_ITEM_ID', 'BEER_SALES_ENABLED'];
var saved = {};
var cache, helcimLib, recipeStore, eventLog, recipeLines, pos, zohoApi, catalogRoute;
var ingredientStock;

// Product catalog entries the kiosk sells next to recipes.
var PRODUCTS = [
  { item_id: 'p-5', name: 'Snack', rate: 5, tax_percentage: 5 },
  { item_id: 'p-12', name: 'Gadget', rate: 5, tax_percentage: 12 }
];

function kioskCatalog() {
  return fx.KIOSK_FEE_CATALOG.concat(PRODUCTS);
}

function ingredientCatalog() {
  return fx.MOCK_INGREDIENTS_CATALOG.map(function (p) {
    var c = Object.assign({}, p);
    if (ingredientStock && ingredientStock[p.item_id] !== undefined) c.stock_on_hand = ingredientStock[p.item_id];
    return c;
  });
}

function load() {
  jest.resetModules();
  Object.keys(mockRouteHandlers).forEach(function (k) { delete mockRouteHandlers[k]; });
  cache = require('../lib/cache');
  helcimLib = require('../lib/helcim');
  recipeStore = require('../lib/recipe-store');
  eventLog = require('../lib/eventLog');
  zohoApi = require('../lib/zoho-api');
  catalogRoute = require('../routes/catalog');
  pos = require('../routes/pos');
  recipeLines = require('../lib/recipe-sale-lines');
  cache.get.mockImplementation(function (key) {
    if (key === 'test:kiosk-products') return Promise.resolve(kioskCatalog());
    if (key === 'zoho:ingredients:all') return Promise.resolve(ingredientCatalog());
    if (key === 'kiosk:discount-presets') return Promise.resolve(fx.DISCOUNT_PRESETS);
    return Promise.resolve(null);
  });
  recipeStore.get.mockImplementation(function (id) {
    return Promise.resolve(fx.MOCK_RECIPES[id] || { ok: false });
  });
}

function mockRes() {
  var finishHandlers = [];
  var r = { statusCode: 200, headersSent: false, locals: {} };
  r.status = jest.fn(function (c) { r.statusCode = c; return r; });
  r.json = jest.fn(function () {
    finishHandlers.forEach(function (h) { h(); });
    return r;
  });
  r.on = jest.fn(function (evt, h) { if (evt === 'finish') finishHandlers.push(h); });
  return r;
}

function sale(body) {
  var res = mockRes();
  return new Promise(function (resolve) {
    var origJson = res.json;
    res.json = jest.fn(function (b) {
      origJson(b);
      resolve({ code: res.statusCode, body: b, res: res });
      return res;
    });
    mockRouteHandlers['POST:/api/kiosk/sale']({ body: body }, res);
  });
}

function quote(body) {
  var res = mockRes();
  return new Promise(function (resolve) {
    var origJson = res.json;
    res.json = jest.fn(function (b) {
      origJson(b);
      resolve({ code: res.statusCode, body: b, res: res });
      return res;
    });
    mockRouteHandlers['POST:/api/kiosk/cart-quote']({ body: body }, res);
  });
}

function recipeEntry(recipeId, extra) {
  return Object.assign({ recipe_id: recipeId, sale_type: 'in-store' }, extra || {});
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

beforeEach(function () {
  ENV_KEYS.forEach(function (k) { saved[k] = process.env[k]; });
  process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
  process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
  process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
  process.env.BEER_SALES_ENABLED = 'true';
  ingredientStock = null;
  global.__rebuildCatalog = kioskCatalog();
  load();
});

afterEach(function () {
  ENV_KEYS.forEach(function (k) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

var CASES = {
  'product-only': { items: [{ item_id: 'p-5', quantity: 3 }, { item_id: 'p-12', quantity: 1 }] },
  'recipe-only in-store': { items: [], recipes: [recipeEntry('RCP-LOCKED')] },
  'recipe-only take-out milled dynamic': {
    items: [], recipes: [recipeEntry('RCP-DYN', { sale_type: 'take-out', mill_grain: true })]
  },
  'mixed': { items: [{ item_id: 'p-5', quantity: 2 }], recipes: [recipeEntry('RCP-LOCKED')] },
  'mixed with fixed cart discount': {
    items: [{ item_id: 'p-12', quantity: 2 }], recipes: [recipeEntry('RCP-LOCKED')],
    discount: { preset_id: 'p-cart-fixed' }
  },
  'two of the same recipe': { recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED')] }
};

describe('cart-quote total equals what /sale charges', function () {
  Object.keys(CASES).forEach(function (name) {
    test(name, function () {
      var body = clone(CASES[name]);
      return quote(clone(body)).then(function (q) {
        expect(q.code).toBe(200);
        var saleBody = clone(body);
        saleBody.client_grand_total = q.body.total;
        return sale(saleBody).then(function (out) {
          expect(out.code).toBe(202);
          expect(helcimLib.terminalPurchase.mock.calls[0][0]).toBe(q.body.total);
        });
      });
    });
  });

  test('recipe-only oracle charge', function () {
    return quote({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (q) {
      expect(q.body.total).toBe(fx.ORACLE.initiate['RCP-LOCKED/in-store/none'].charge);
    });
  });
});

describe('cart-quote response shape', function () {
  test('exact top-level keys', function () {
    return quote({ items: [{ item_id: 'p-5', quantity: 1 }] }).then(function (q) {
      expect(Object.keys(q.body).sort()).toEqual(
        ['discount', 'discount_total', 'recipes', 'stock', 'subtotal', 'tax_total', 'total']);
      expect(q.body.discount).toBeNull();
      expect(q.body.recipes).toEqual([]);
      expect(q.body.stock.ok).toBe(true);
      expect(q.body.discount_total).toBe(0);
    });
  });

  test('per-recipe totals and discount_total for a mixed discounted cart', function () {
    return quote(clone(CASES['mixed with fixed cart discount'])).then(function (q) {
      expect(q.body.recipes).toHaveLength(1);
      var r = q.body.recipes[0];
      ['index', 'label', 'total_before_discount', 'discount', 'pre_tax', 'sale_type', 'mill_grain', 'target_volume_l']
        .forEach(function (k) { expect(r).toHaveProperty(k); });
      expect(q.body.discount.preset_id).toBe('p-cart-fixed');
      expect(q.body.discount_total).toBe(7.5);
      expect(q.body.subtotal + r.pre_tax + q.body.tax_total).toBeCloseTo(q.body.total, 2);
    });
  });

  test('product-only discount_total is gross minus discounted subtotal', function () {
    return quote({ items: [{ item_id: 'p-5', quantity: 4 }], discount: { preset_id: 'p-cart-pct' } }).then(function (q) {
      expect(q.body.discount_total).toBe(2);
      expect(q.body.subtotal).toBe(18);
    });
  });
});

describe('cart-quote errors and stock', function () {
  test('short stock is a 200 with stock.ok false (never 409)', function () {
    ingredientStock = { 'ing-grain-1': 0 };
    return quote({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (q) {
      expect(q.code).toBe(200);
      expect(q.body.stock.ok).toBe(false);
      expect(q.body.stock.conflicts.length).toBeGreaterThan(0);
      expect(q.body.stock.recipes_short.length).toBe(1);
    });
  });

  test('recipes while BEER_SALES_ENABLED is off -> 403', function () {
    process.env.BEER_SALES_ENABLED = 'false';
    return quote({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (q) {
      expect(q.code).toBe(403);
    });
  });

  test('invalid recipes -> 400', function () {
    return quote({ recipes: [{ recipe_id: 'RCP-LOCKED', sale_type: 'nonsense' }] }).then(function (q) {
      expect(q.code).toBe(400);
    });
  });

  test('empty cart -> 400', function () {
    return quote({ items: [] }).then(function (q) {
      expect(q.code).toBe(400);
      expect(q.body.error).toBe('Cart is empty');
    });
  });

  test('unknown item -> 400 with the /sale message', function () {
    return quote({ items: [{ item_id: 'nope', quantity: 1 }] }).then(function (q) {
      expect(q.code).toBe(400);
      expect(q.body.error).toBe('Item not found in current catalog: nope. Refresh the product list and try again.');
    });
  });

  test('catalog unavailable -> 503', function () {
    cache.get.mockImplementation(function () { return Promise.resolve(null); });
    return quote({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (q) {
      expect(q.code).toBe(503);
      expect(q.body.error).toBeTruthy();
    });
  });

  test('unexpected throw -> 502 with the generic message', function () {
    recipeStore.get.mockImplementation(function () { throw new Error('boom'); });
    return quote({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (q) {
      expect(q.code).toBe(502);
      expect(q.body.error).toBe('Failed to price cart. Please try again.');
    });
  });
});

describe('cart-quote has no side effects', function () {
  test('no lock, no Helcim, no Zoho, no catalog rebuild', function () {
    return quote(clone(CASES['mixed with fixed cart discount'])).then(function (q) {
      expect(q.code).toBe(200);
      expect(cache.acquireLock).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
      expect(helcimLib.initializeCheckout).not.toHaveBeenCalled();
      expect(zohoApi.zohoGet).not.toHaveBeenCalled();
      expect(zohoApi.zohoPost).not.toHaveBeenCalled();
      expect(zohoApi.zohoPut).not.toHaveBeenCalled();
      expect(catalogRoute.rebuildKioskCatalog).not.toHaveBeenCalled();
    });
  });

  test('getKioskCatalogForSale is called with rebuild:false', function () {
    var kc = require('../lib/kiosk-sale-catalog');
    var spy = jest.spyOn(kc, 'getKioskCatalogForSale');
    return quote({ items: [{ item_id: 'p-5', quantity: 1 }] }).then(function () {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].rebuild).toBe(false);
      spy.mockRestore();
    });
  });
});

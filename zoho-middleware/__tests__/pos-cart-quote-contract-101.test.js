'use strict';

/**
 * Phase 101 review WR-01: client/server contract for POST /api/kiosk/cart-quote.
 *
 * The client test used to mock a quote shape the server cannot produce, so the
 * kiosk rendered the wrong Subtotal while both sides' tests passed. This test
 * pins fixtures/cart-quote-contract-101.json to what the REAL route returns;
 * tests/frontend/kiosk-cart-quote-contract-101.test.js feeds the same file to
 * the client. If the server response changes, this test fails until the
 * fixture is regenerated, and the client test then runs against the new shape.
 *
 * Regenerate: WRITE_CART_QUOTE_CONTRACT=1 npx jest __tests__/pos-cart-quote-contract-101.test.js
 * (then fill in `gross` by hand: products at catalog price + recipe totals before discount).
 *
 * Harness copied from __tests__/pos-cart-quote.test.js.
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


var fs = require('fs');
var path = require('path');
var FIXTURE_PATH = path.join(__dirname, 'fixtures', 'cart-quote-contract-101.json');

// `gross` is hand-derived: products at catalog price plus each recipe's total
// before discount. It is what the kiosk must show as "Subtotal".
var CONTRACT_CASES = [
  { name: 'recipe-only', request: { items: [], recipes: [recipeEntry('RCP-LOCKED')] } },
  { name: 'product + recipe, no discount', request: { items: [{ item_id: 'p-5', quantity: 2 }], recipes: [recipeEntry('RCP-LOCKED')] } },
  {
    name: 'product + recipe, fixed cart discount',
    request: { items: [{ item_id: 'p-12', quantity: 2 }], recipes: [recipeEntry('RCP-LOCKED')], discount: { preset_id: 'p-cart-fixed' } }
  },
  {
    name: 'product + recipe, percentage cart discount',
    request: { items: [{ item_id: 'p-5', quantity: 4 }], recipes: [recipeEntry('RCP-LOCKED')], discount: { preset_id: 'p-cart-pct' } }
  },
  { name: 'two recipes', request: { recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-DYN')] } }
];

describe('cart-quote contract fixture matches the real route', function () {
  if (process.env.WRITE_CART_QUOTE_CONTRACT) {
    test('write fixture', function () {
      var out = [];
      return CONTRACT_CASES.reduce(function (p, c) {
        return p.then(function () {
          return quote(clone(c.request)).then(function (q) {
            out.push({ name: c.name, request: c.request, gross: null, response: q.body });
          });
        });
      }, Promise.resolve()).then(function () {
        fs.writeFileSync(FIXTURE_PATH, JSON.stringify(out, null, 2) + '\n');
      });
    });
    return;
  }

  var fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  test('fixture covers every contract case', function () {
    expect(fixture.map(function (f) { return f.name; })).toEqual(CONTRACT_CASES.map(function (c) { return c.name; }));
  });

  CONTRACT_CASES.forEach(function (c, i) {
    test(c.name, function () {
      return quote(clone(c.request)).then(function (q) {
        expect(q.code).toBe(200);
        expect(JSON.parse(JSON.stringify(q.body))).toEqual(fixture[i].response);
        // What the client derives its Subtotal row from.
        var b = q.body;
        expect(Math.round((b.total - b.tax_total + b.discount_total) * 100) / 100).toBe(fixture[i].gross);
      });
    });
  });
});

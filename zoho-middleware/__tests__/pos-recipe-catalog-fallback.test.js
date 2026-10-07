'use strict';

// Regression: kiosk recipe quote / sale / confirm returned 503 "Ingredient
// catalog not available" whenever the zoho:ingredients:all Redis key had
// expired (1 h TTL, warmed only at 05:00/13:00 UTC or by an admin page),
// even though ingredients-all-cache.json held the same catalog. Observed on
// production 2026-10-07. The handlers must fall back to the file, as
// routes/recipes.js and routes/catalog.js already do.

var fs = require('fs');
var path = require('path');

var mockRouteHandlers = {};

jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (p, handler) { mockRouteHandlers['GET:' + p] = handler; }),
    post:   jest.fn(function (p, handler) { mockRouteHandlers['POST:' + p] = handler; }),
    put:    jest.fn(),
    delete: jest.fn()
  };
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
    terminalPurchase: jest.fn().mockResolvedValue({}),
    voidTransaction: jest.fn().mockResolvedValue({}),
    getCardTransactionById: jest.fn().mockResolvedValue({ amount: 245, status: 'APPROVED' })
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn().mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } }),
    zohoPut: jest.fn()
  };
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

jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      KIOSK_PRODUCTS: 'test:kiosk-products',
      RECIPES: 'sv:recipes',
      RECIPES_TS: 'sv:recipes:ts',
      INGREDIENTS: 'zoho:ingredients',
      INGREDIENTS_ALL: 'zoho:ingredients:all',
      KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' }
  };
});

jest.mock('../lib/brewpad-integration', function () {
  return { detectRecipeSale: jest.fn(), createBatchesFromSale: jest.fn() };
});

var CATALOG_FILE = path.join(__dirname, '..', 'ingredients-all-cache.json');

var CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-hops-1', name: 'Cascade Hops', rate: 8.00, tax_id: 'tax-gst', stock_on_hand: 2, unit: 'kg' },
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 10, unit: 'pcs' }
];

var INGREDIENTS = [
  { ingredient_id: 'ING-001', recipe_id: 'RCP-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
  { ingredient_id: 'ING-002', recipe_id: 'RCP-001', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' },
  { ingredient_id: 'ING-003', recipe_id: 'RCP-001', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
];

function recipeBody() {
  return {
    ok: true,
    data: {
      recipe: {
        recipe_id: 'RCP-001', name: 'Cascade Pale Ale', batch_size_l: 20,
        locked_price: 195.00, service_fee: 45.00, materials_fee: 5.00, status: 'active'
      },
      ingredients: JSON.parse(JSON.stringify(INGREDIENTS))
    }
  };
}

var mocks;
var fileReads;

/**
 * redisCatalog: what zoho:ingredients:all returns from Redis (null = expired).
 * fileCatalog: contents of ingredients-all-cache.json (null = file missing).
 */
function load(redisCatalog, fileCatalog) {
  mockRouteHandlers = {};
  jest.resetModules();
  jest.doMock('../lib/recipe-store', function () {
    return {
      getMode: function () { return 'postgres'; },
      get: jest.fn(function () { return Promise.resolve(recipeBody()); }),
      getFromSheet: jest.fn()
    };
  });
  require('../routes/pos-recipe');
  mocks = { cache: require('../lib/cache') };
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all') return Promise.resolve(redisCatalog);
    return Promise.resolve(null);
  });

  fileReads = 0;
  var realRead = fs.readFileSync;
  jest.spyOn(fs, 'readFileSync').mockImplementation(function (p) {
    if (String(p) === CATALOG_FILE) {
      fileReads++;
      if (fileCatalog === null) {
        var err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.stringify(fileCatalog);
    }
    return realRead.apply(fs, arguments);
  });
}

function callHandler(method, p, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + p];
    if (!handler) return reject(new Error('No handler registered for ' + method + ':' + p));
    var res = {
      _status: 200, _body: null, headersSent: false,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; res.headersSent = true; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
}

beforeEach(function () {
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
  process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
});

afterEach(function () {
  jest.restoreAllMocks();
  ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN', 'BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID',
    'MATERIALS_FEE_ITEM_ID', 'KIOSK_CONTACT_ID'].forEach(function (k) {
    delete process.env[k];
  });
});

describe('quote: expired Redis catalog falls back to ingredients-all-cache.json', function () {
  test('Redis expired + file present -> 200 with the same total as a warm cache', function () {
    load(null, CATALOG);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.total).toBe(245);
      expect(fileReads).toBe(1);
    });
  });

  test('Redis warm -> file is not read', function () {
    load(CATALOG, CATALOG);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(fileReads).toBe(0);
    });
  });

  test('Redis expired + file missing -> still 503 (fail closed)', function () {
    load(null, null);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(503);
      expect(res._body.error).toMatch(/Ingredient catalog not available/);
    });
  });

  test('Redis expired + file holds a non-array -> 503', function () {
    load(null, { not: 'an array' });
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(503);
    });
  });
});

describe('sale and post-charge confirm use the same fallback', function () {
  test('recipe-sale: Redis expired + file present -> not a catalog 503', function () {
    load(null, CATALOG);
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'k-sale-1' },
      headers: {}
    }).then(function (res) {
      expect(fileReads).toBeGreaterThanOrEqual(1);
      expect(res._status).not.toBe(503);
    });
  });

  test('confirm (card already charged): Redis expired + file present -> not a catalog 503', function () {
    load(null, CATALOG);
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001', sale_type: 'in-store',
        transaction_id: 'txn-1', reference: 'ref-1', idempotency_key: 'k-confirm-1'
      },
      headers: {}
    }).then(function (res) {
      expect(fileReads).toBeGreaterThanOrEqual(1);
      expect(res._status).not.toBe(503);
    });
  });
});

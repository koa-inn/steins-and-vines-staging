'use strict';

// Phase 85-08 Task 1: kiosk recipe money path reads through lib/recipe-store.js
// and prices identically whichever store supplied the recipe (ROADMAP SC2/SC3).

var mockRouteHandlers = {};

jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post:   jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
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
    voidTransaction: jest.fn().mockResolvedValue({})
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

var CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-hops-1', name: 'Cascade Hops', rate: 8.00, tax_id: 'tax-gst', stock_on_hand: 2, unit: 'kg' },
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 10, unit: 'pcs' },
  { item_id: 'fee-mill-1', name: 'Milling', rate: 4.00, tax_id: 'tax-gst', stock_on_hand: 99, unit: 'pcs' }
];

var PRESETS = [
  { id: 'p-10', name: '10 off', active: true, type: 'percentage', value: 10, scope: 'cart' }
];

var INGREDIENTS = [
  { ingredient_id: 'ING-001', recipe_id: 'RCP-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
  { ingredient_id: 'ING-002', recipe_id: 'RCP-001', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' },
  { ingredient_id: 'ING-003', recipe_id: 'RCP-001', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
];

function recipeBody(overrides) {
  var recipe = Object.assign({
    recipe_id: 'RCP-001', name: 'Cascade Pale Ale', batch_size_l: 20,
    locked_price: 195.00, service_fee: 45.00, materials_fee: 5.00, status: 'active'
  }, overrides || {});
  return { ok: true, data: { recipe: recipe, ingredients: JSON.parse(JSON.stringify(INGREDIENTS)) } };
}

var storeGet;

/** mode 'sheets' => real recipe-store over the axios mock; 'postgres' => mocked store. */
function load(mode) {
  mockRouteHandlers = {};
  jest.resetModules();
  storeGet = jest.fn();
  if (mode === 'postgres') {
    jest.doMock('../lib/recipe-store', function () {
      return {
        getMode: function () { return 'postgres'; },
        get: storeGet,
        getFromSheet: jest.fn()
      };
    });
  } else {
    jest.dontMock('../lib/recipe-store');
    process.env.RECIPES_STORE = 'sheets';
  }
  require('../routes/pos-recipe');
  var mocks = {
    axios: require('axios'),
    cache: require('../lib/cache'),
    helcim: require('../lib/helcim'),
    zohoApi: require('../lib/zoho-api')
  };
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(CATALOG);
    if (key === 'kiosk:discount-presets') return Promise.resolve(PRESETS);
    return Promise.resolve(null);
  });
  return mocks;
}

function supplyRecipe(mode, mocks, body) {
  if (mode === 'postgres') {
    storeGet.mockImplementation(function () { return Promise.resolve(JSON.parse(JSON.stringify(body))); });
  } else {
    mocks.axios.post.mockImplementation(function () { return Promise.resolve({ data: JSON.parse(JSON.stringify(body)) }); });
  }
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + path];
    if (!handler) return reject(new Error('No handler registered for ' + method + ':' + path));
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
  process.env.MILLING_FEE_ITEM_ID = 'fee-mill-1';
});

afterEach(function () {
  ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN', 'BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID',
    'MATERIALS_FEE_ITEM_ID', 'KIOSK_CONTACT_ID', 'MILLING_FEE_ITEM_ID', 'RECIPES_STORE'].forEach(function (k) {
    delete process.env[k];
  });
});

describe('sheets mode keeps the get_recipe axios call', function () {
  test('quote makes one get_recipe axios.post with the recipe id', function () {
    var mocks = load('sheets');
    supplyRecipe('sheets', mocks, recipeBody());
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(mocks.axios.post).toHaveBeenCalledTimes(1);
      var payload = JSON.parse(mocks.axios.post.mock.calls[0][1]);
      expect(payload.action).toBe('get_recipe');
      expect(payload.recipe_id).toBe('RCP-001');
    });
  });
});

describe('postgres mode reads through recipe-store', function () {
  test('quote loads the recipe via recipeStore.get and never calls axios', function () {
    var mocks = load('postgres');
    supplyRecipe('postgres', mocks, recipeBody());
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(storeGet).toHaveBeenCalledWith('RCP-001');
      expect(mocks.axios.post).not.toHaveBeenCalled();
      expect(res._body.total).toBe(245);
    });
  });

  test('store {ok:false} -> 404 Recipe not found', function () {
    load('postgres');
    storeGet.mockResolvedValue({ ok: false, error: 'not_found', message: 'Recipe not found' });
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-404', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(404);
      expect(res._body.error).toBe('Recipe not found');
    });
  });

  test('inactive recipe -> 400 Recipe is not active', function () {
    var mocks = load('postgres');
    supplyRecipe('postgres', mocks, recipeBody({ status: 'inactive' }));
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toBe('Recipe is not active');
    });
  });

  test('unit mismatch line -> 422 fail-closed (Phase 73 guard unchanged)', function () {
    var mocks = load('postgres');
    var body = recipeBody();
    body.data.ingredients[0].unit = 'ml'; // catalog item is kg-based; ml is not convertible
    supplyRecipe('postgres', mocks, body);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(422);
    });
  });

  test('/confirm loads via recipeStore.get; a store rejection -> 502, lock released, no sheet fallback', function () {
    var mocks = load('postgres');
    storeGet.mockRejectedValue(new Error('pg down'));
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: { recipe_id: 'RCP-001', transaction_id: 'txn-1', reference: 'R-1', sale_type: 'in-store' }
    }).then(function (res) {
      expect(storeGet).toHaveBeenCalledWith('RCP-001');
      expect(res._status).toBe(502);
      expect(res._body.error).toBe('Failed to fetch recipe. Please try again.');
      expect(mocks.cache.releaseLock).toHaveBeenCalled();
      expect(mocks.axios.post).not.toHaveBeenCalled();
      expect(mocks.zohoApi.zohoPost).not.toHaveBeenCalled();
    });
  });
});

describe('cross-store pricing parity (quote and sale)', function () {
  var scenarios = [
    { name: 'locked 1x', recipe: {}, query: { sale_type: 'in-store' } },
    { name: 'locked 2x scale', recipe: {}, query: { sale_type: 'in-store', target_volume_l: '40' } },
    { name: 'dynamic', recipe: { locked_price: 0, pricing_mode: 'dynamic' }, query: { sale_type: 'in-store' } },
    { name: 'dynamic 2x take-out with milling',
      recipe: { locked_price: 0, pricing_mode: 'dynamic' }, query: { sale_type: 'take-out', target_volume_l: '40' }, mill: true },
    { name: 'modified ingredients',
      recipe: { locked_price: 0, pricing_mode: 'dynamic' },
      query: {
        sale_type: 'in-store',
        modified_ingredients: JSON.stringify([
          { ingredient_id: 'ING-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 7, unit: 'kg' },
          { ingredient_id: 'ING-003', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 2, unit: 'pcs' }
        ])
      } },
    { name: 'discount preset', recipe: {}, query: { sale_type: 'in-store', discount_preset_id: 'p-10' } }
  ];

  scenarios.forEach(function (sc) {
    test('quote: ' + sc.name + ' prices identically from sheets and postgres', function () {
      var results = {};
      var q = Object.assign({ recipe_id: 'RCP-001' }, sc.query);
      var m1 = load('sheets');
      supplyRecipe('sheets', m1, recipeBody(sc.recipe));
      return callHandler('GET', '/api/kiosk/recipe-quote', { query: q }).then(function (res) {
        results.sheets = res;
        var m2 = load('postgres');
        supplyRecipe('postgres', m2, recipeBody(sc.recipe));
        return callHandler('GET', '/api/kiosk/recipe-quote', { query: q });
      }).then(function (res) {
        results.postgres = res;
        expect(results.sheets._status).toBe(200);
        expect(results.postgres._status).toBe(results.sheets._status);
        expect(results.postgres._body).toEqual(results.sheets._body);
      });
    });

    test('sale: ' + sc.name + ' charges the same terminal amount from sheets and postgres', function () {
      var amounts = {};
      var saleBody = { recipe_id: 'RCP-001', sale_type: sc.query.sale_type, mill_grain: !!sc.mill };
      if (sc.query.target_volume_l) saleBody.target_volume_l = Number(sc.query.target_volume_l);
      if (sc.query.modified_ingredients) saleBody.modified_ingredients = JSON.parse(sc.query.modified_ingredients);
      if (sc.query.discount_preset_id) saleBody.discount = { preset_id: sc.query.discount_preset_id };
      var m1 = load('sheets');
      supplyRecipe('sheets', m1, recipeBody(sc.recipe));
      return callHandler('POST', '/api/kiosk/recipe-sale', { body: saleBody }).then(function (res) {
        expect(res._status).toBe(202);
        amounts.sheets = res._body.total;
        var m2 = load('postgres');
        supplyRecipe('postgres', m2, recipeBody(sc.recipe));
        return callHandler('POST', '/api/kiosk/recipe-sale', { body: saleBody });
      }).then(function (res) {
        expect(res._status).toBe(202);
        expect(res._body.total).toBe(amounts.sheets);
      });
    });
  });
});

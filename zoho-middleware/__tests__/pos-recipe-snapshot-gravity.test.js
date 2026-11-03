'use strict';

// ---------------------------------------------------------------------------
// Express mock — captures route handlers keyed by method:path
// ---------------------------------------------------------------------------

var mockRouteHandlers = {};

// Recipe fee tax (2026-10-13): fee tax rates come from the kiosk products
// catalog; on a cache miss pos-recipe rebuilds it via routes/catalog. Serve the
// configured fee items at their real Zoho rates (Makers 5% GST, Materials and
// Milling 12% PST + GST).
jest.mock('../routes/catalog', function () {
  return {
    rebuildKioskCatalog: jest.fn(function () {
      return Promise.resolve([
        { item_id: process.env.MAKERS_FEE_ITEM_ID, tax_percentage: 5 },
        { item_id: process.env.MATERIALS_FEE_ITEM_ID, tax_percentage: 12 },
        { item_id: process.env.MILLING_FEE_ITEM_ID, tax_percentage: 12 }
      ]);
    })
  };
});

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

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});

jest.mock('../lib/helcim', function () {
  return {
    // Recipe confirm captured-amount readback (2026-10-13). No default —
    // set per test below to the total that test's own recipe/cart produces.
    getCardTransactionById: jest.fn(),
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

jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});

jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn().mockResolvedValue() };
});

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
  return {
    detectRecipeSale: jest.fn(),
    createBatchesFromSale: jest.fn()
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAndLoadPosRecipe() {
  mockRouteHandlers = {};
  jest.resetModules();
  require('../routes/pos-recipe');
  return {
    axios: require('axios'),
    cache: require('../lib/cache'),
    helcim: require('../lib/helcim'),
    zohoApi: require('../lib/zoho-api'),
    brewpad: require('../lib/brewpad-integration'),
    C: require('../lib/constants')
  };
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var key = method + ':' + path;
    var handler = mockRouteHandlers[key];
    if (!handler) return reject(new Error('No handler registered for ' + key));
    var res = {
      _status: 200,
      _body: null,
      headersSent: false,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; res.headersSent = true; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

var CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 10, unit: 'pcs',
    cf_type: 'Yeast', custom_fields: [{ api_name: 'cf_subcategory', value: 'Yeast' }] }
];

function recipeResponse(recipeExtra) {
  var recipe = {
    recipe_id: 'RCP-001', name: 'Cascade Pale Ale', style: 'American Pale Ale', abv: 5.2,
    batch_size_l: 20, locked_price: 195.00, service_fee: 45.00, materials_fee: 5.00, status: 'active'
  };
  Object.keys(recipeExtra || {}).forEach(function (k) { recipe[k] = recipeExtra[k]; });
  return {
    data: { ok: true, data: { recipe: recipe, ingredients: [
      { ingredient_id: 'ING-001', recipe_id: 'RCP-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
      { ingredient_id: 'ING-003', recipe_id: 'RCP-001', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' },
      { ingredient_id: 'ING-009', recipe_id: 'RCP-001', item_id: 'ing-gone', item_name: 'Not In Catalog', quantity: 1, unit: 'pcs' }
    ] } }
  };
}

function snapshotFor(recipeExtra) {
  var mocks = resetAndLoadPosRecipe();
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
  process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
  delete process.env.MILLING_FEE_ITEM_ID;
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(CATALOG);
    return Promise.resolve(null);
  });
  mocks.axios.post.mockResolvedValue(recipeResponse(recipeExtra));
  mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
  return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
    body: { recipe_id: 'RCP-001', transaction_id: 'txn-g', reference: 'RECIPE-G', sale_type: 'in-store', customer_name: 'A', contact_id: 'C-001' }
  }).then(function () {
    expect(mocks.brewpad.detectRecipeSale).toHaveBeenCalled();
    return mocks.brewpad.detectRecipeSale.mock.calls[0][1];
  });
}

describe('recipe-sale confirm snapshot: gravity, IBU, batch size, typed ingredients', function () {
  afterEach(function () {
    ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN', 'BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID',
      'MATERIALS_FEE_ITEM_ID', 'KIOSK_CONTACT_ID'].forEach(function (k) { delete process.env[k]; });
  });

  test('carries og, target_fg, ibu, batch_size_l from the recipe', function () {
    return snapshotFor({ target_og: 12, target_fg: 3, ibu: 32, batch_size_l: 28 }).then(function (s) {
      expect(s.og).toBe(12);
      expect(s.target_fg).toBe(3);
      expect(s.ibu).toBe(32);
      expect(s.batch_size_l).toBe(28);
    });
  });

  test('empty-string gravity becomes null', function () {
    return snapshotFor({ target_og: '', target_fg: '' }).then(function (s) {
      expect(s.og).toBeNull();
      expect(s.target_fg).toBeNull();
    });
  });

  test('missing gravity keys (pre-97-01 shape) become null without throwing', function () {
    return snapshotFor({}).then(function (s) {
      expect(s.og).toBeNull();
      expect(s.target_fg).toBeNull();
    });
  });

  test('ingredients carry cf_type and cf_subcategory from the catalog', function () {
    return snapshotFor({}).then(function (s) {
      var y = s.ingredients.filter(function (i) { return i.item_id === 'ing-yeast-1'; })[0];
      expect(y.cf_type).toBe('Yeast');
      expect(y.cf_subcategory).toBe('Yeast');
    });
  });

  test('ingredient absent from catalog gets empty type fields', function () {
    return snapshotFor({}).then(function (s) {
      var g = s.ingredients.filter(function (i) { return i.item_id === 'ing-gone'; })[0];
      expect(g.cf_type).toBe('');
      expect(g.cf_subcategory).toBe('');
    });
  });
});

'use strict';

// Recipe invoice vs charge, round 2 (D-17 re-test 2026-10-15, INV-000238):
// 1. Zoho stores line quantities to 3 decimals (2.3 g Whirlfloc = 0.0023 kg
//    became 0.002), so line math on 4dp quantities predicted a line sum
//    $0.10 above Zoho's and the adjustment came out wrong.
// 2. The re-balancing PUT re-sent lines without their tax_id, and Zoho
//    re-defaulted untagged lines to GST (Materials Fee 12% -> 5%), so the
//    +0.10 adjustment only moved the total +0.08.
// Harness copied from pos-recipe-invoice-reconcile.test.js.

// ---------------------------------------------------------------------------
// Express mock — captures route handlers keyed by method:path
// ---------------------------------------------------------------------------

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

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    voidTransaction: jest.fn().mockResolvedValue({}),
    pollTerminalResult: jest.fn(),
    getCardTransactionById: jest.fn()
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
      KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets',
      KIOSK_PENDING_CHARGE_PREFIX: 'kiosk:pending-charge:',
      KIOSK_IDEM_PREFIX: 'kiosk:idem:'
    },
    LOCK_KEYS: { RECIPE_SALE: 'recipe-sale' }
  };
});

jest.mock('../routes/catalog', function () {
  return { rebuildKioskCatalog: jest.fn() };
});

jest.mock('../lib/brewpad-integration', function () {
  return {
    detectRecipeSale: jest.fn(),
    createBatchesFromSale: jest.fn()
  };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

var MOCK_INGREDIENTS_CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-hops-1', name: 'Cascade Hops', rate: 8.00, tax_id: 'tax-gst', stock_on_hand: 2, unit: 'kg' },
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 10, unit: 'pcs' },
  { item_id: 'ing-dry-hop-1', name: 'Centennial Hops (Dry Hop)', rate: 10.00, tax_id: 'tax-gst', stock_on_hand: 5, unit: 'kg' }
];

var MOCK_RECIPE_RESPONSE = {
  data: {
    ok: true,
    data: {
      recipe: {
        recipe_id: 'RCP-001',
        name: 'Cascade Pale Ale',
        style: 'American Pale Ale',
        abv: 5.2,
        batch_size_l: 20,
        locked_price: 195.00,
        service_fee: 45.00,
        materials_fee: 5.00,
        status: 'active'
      },
      ingredients: [
        { ingredient_id: 'ING-001', recipe_id: 'RCP-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
        { ingredient_id: 'ING-002', recipe_id: 'RCP-001', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' },
        { ingredient_id: 'ING-003', recipe_id: 'RCP-001', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
      ]
    }
  }
};

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
// Tests
// ---------------------------------------------------------------------------


// Fee items as the kiosk products catalog carries them (tax from Zoho).
var FEE_CATALOG = [
  { item_id: 'fee-makers-1', name: 'Makers Fee', rate: 45, tax_percentage: 5 },
  { item_id: 'fee-materials-1', name: 'Materials Fee', rate: 5, tax_percentage: 12 }
];

function setEnv() {
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
  process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
  delete process.env.MILLING_FEE_ITEM_ID;
}

afterEach(function () {
  ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN', 'BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID',
    'MATERIALS_FEE_ITEM_ID', 'KIOSK_CONTACT_ID', 'MILLING_FEE_ITEM_ID'].forEach(function (k) { delete process.env[k]; });
});

function load(feeCatalog) {
  var mocks = resetAndLoadPosRecipe();
  setEnv();
  mocks.catalog = require('../routes/catalog');
  mocks.catalog.rebuildKioskCatalog.mockRejectedValue(new Error('zoho down'));
  mocks.helcim.isTerminalEnabled.mockReturnValue(true);
  mocks.helcim.terminalPurchase.mockResolvedValue({});
  mocks.helcim.voidTransaction.mockResolvedValue({});
  mocks.cache.acquireLock.mockResolvedValue(true);
  mocks.cache.releaseLock.mockResolvedValue();
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(MOCK_INGREDIENTS_CATALOG);
    if (key === 'test:kiosk-products') return Promise.resolve(feeCatalog === undefined ? FEE_CATALOG : feeCatalog);
    return Promise.resolve(null);
  });
  mocks.axios.post.mockResolvedValue(MOCK_RECIPE_RESPONSE);
  mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  return mocks;
}

function quote(saleType) {
  return callHandler('GET', '/api/kiosk/recipe-quote', { query: { recipe_id: 'RCP-001', sale_type: saleType || 'in-store' }, headers: {} });
}

function confirm() {
  return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
    body: { recipe_id: 'RCP-001', sale_type: 'in-store', transaction_id: 'txn-tax-1', reference: 'KIOSK-T-1', idempotency_key: 'KIOSK-T-1' }
  });
}

function postBody(mocks, path) {
  var c = mocks.zohoApi.zohoPost.mock.calls.filter(function (x) { return x[0] === path; });
  return c.length ? c[0][1] : null;
}

function r2(n) { return Math.round(n * 100) / 100; }


function invoiceResp(total) {
  return { invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001', total: total } };
}

function recipeWith(ingredients) {
  var r = JSON.parse(JSON.stringify(MOCK_RECIPE_RESPONSE));
  r.data.data.ingredients = ingredients;
  return r;
}

describe('recipe invoice lines match how Zoho stores them', function () {
  test('ingredient quantities are sent to Zoho rounded to 3 decimals', function () {
    var mocks = load();
    MOCK_INGREDIENTS_CATALOG.push({ item_id: 'ing-whirlfloc', name: 'Whirlfloc T Bulk', rate: 139.13, tax_id: 'tax-zero', tax_percentage: 0, stock_on_hand: 1, unit: 'kg' });
    mocks.axios.post.mockResolvedValue(recipeWith(MOCK_RECIPE_RESPONSE.data.data.ingredients.concat([
      { ingredient_id: 'ING-009', recipe_id: 'RCP-001', item_id: 'ing-whirlfloc', item_name: 'Whirlfloc T Bulk', quantity: 2.3, unit: 'g' }
    ])));
    mocks.helcim.getCardTransactionById.mockImplementation(function () {
      return Promise.resolve({ status: 'APPROVED', amount: 247.85 });
    });
    return confirm().then(function (res) {
      MOCK_INGREDIENTS_CATALOG.pop();
      var created = postBody(mocks, '/invoices');
      expect(created).not.toBeNull();
      var wf = created.line_items.filter(function (li) { return li.item_id === 'ing-whirlfloc'; })[0];
      expect(wf.quantity).toBe(0.002);
      created.line_items.forEach(function (li) {
        expect(Math.round(li.quantity * 1000) / 1000).toBe(li.quantity);
      });
    });
  });

  test('re-balancing PUT re-sends the lines as Zoho created them, tax_id and line_item_id included', function () {
    var mocks = load();
    mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    var zohoLines = [
      { line_item_id: 'li-1', item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', quantity: 5.5, rate: 3.5, discount: 0, tax_id: 'tax-zero', unit: 'kg', item_total: 19.25 },
      { line_item_id: 'li-2', item_id: 'fee-materials-1', name: 'Materials Fee', quantity: 1, rate: 5, discount: 0, tax_id: 'tax-gst-pst', item_total: 5 }
    ];
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001', total: 247.75, line_items: zohoLines } });
    mocks.zohoApi.zohoPut.mockResolvedValue(invoiceResp(247.85));
    return confirm().then(function (res) {
      expect(res._status).toBe(201);
      var put = mocks.zohoApi.zohoPut.mock.calls[0][1];
      expect(put.line_items).toEqual([
        { line_item_id: 'li-1', item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', quantity: 5.5, rate: 3.5, discount: 0, tax_id: 'tax-zero' },
        { line_item_id: 'li-2', item_id: 'fee-materials-1', name: 'Materials Fee', quantity: 1, rate: 5, discount: 0, tax_id: 'tax-gst-pst' }
      ]);
    });
  });
});

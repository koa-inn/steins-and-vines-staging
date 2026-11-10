'use strict';

// Recipe fee tax (2026-10-13, owner decision: charge tax on recipe fees like
// kit sales). The Brewing (Makers) and Materials fees are taxed at their
// Zoho rates from the kiosk products catalog, rounded per rate group like
// Zoho's entity_level setting. The terminal charges pre-tax + tax, and the
// Zoho invoice carries an adjustment so its total equals the charge even
// though a locked package price differs from the sum of ingredient lines.
//
// Harness copied from __tests__/pos-recipe-confirm-verification.test.js.

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

describe('recipe quote reports fee tax separately', function () {
  test('in-store: pre-tax total unchanged, tax_total 2.85, total_with_tax 247.85', function () {
    load();
    return quote().then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.total).toBe(245);
      expect(res._body.tax_total).toBe(2.85);
      expect(res._body.total_with_tax).toBe(247.85);
    });
  });

  test('take-out without milling carries no fee lines, so no tax', function () {
    load();
    return quote('take-out').then(function (res) {
      expect(res._body.tax_total).toBe(0);
      expect(res._body.total_with_tax).toBe(res._body.total);
    });
  });

  test('a fee whose tax cannot be resolved fails closed before any charge', function () {
    load([]); // empty kiosk catalog, rebuild fails
    return quote().then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/tax/i);
    });
  });
});

describe('recipe confirm books the taxed total and balances the invoice', function () {
  test('payment is 247.85 and invoice lines + tax + adjustment equal the charge', function () {
    var mocks = load();
    mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    return confirm().then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.total).toBe(247.85);
      var pay = postBody(mocks, '/customerpayments');
      expect(pay.amount).toBe(247.85);
      expect(pay.invoices[0].amount_applied).toBe(247.85);
      var inv = postBody(mocks, '/invoices');
      var lineSum = r2(inv.line_items.reduce(function (s, li) {
        return s + r2((Number(li.quantity) || 0) * (Number(li.rate) || 0)) - (Number(li.discount) || 0);
      }, 0));
      expect(typeof inv.adjustment).toBe('number');
      // tax 2.85 only comes from the two fee lines (ingredients are 0%)
      expect(r2(lineSum + 2.85 + inv.adjustment)).toBe(247.85);
    });
  });

  test('a capture of the old pre-tax amount is now a mismatch and is voided', function () {
    var mocks = load();
    mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 245 });
    return confirm().then(function (res) {
      expect(res._status).toBe(402);
      expect(mocks.helcim.voidTransaction).toHaveBeenCalledWith('txn-tax-1');
    });
  });
});

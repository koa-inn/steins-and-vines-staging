'use strict';

// ---------------------------------------------------------------------------
// pos-recipe-money-path.test.js — Phase 50-05 (M12 / roadmap SC#5)
//
// Regression coverage for the recipe confirm leg's void-on-failure routed
// through moneyPath.voidWithTimeout instead of a raw helcimLib.voidTransaction
// call (audit H5/L18). The initiate-leg money-path cases (idempotency gate,
// deterministic Helcim key, pending-charge record, lock release) moved to
// pos-sale-recipes.test.js when the legacy initiate route was retired (101-09).
//
// Mirrors the mocking conventions of pos-recipe.test.js. Does NOT mock
// ../lib/money-path — the real primitive is exercised (consistent with how
// the pre-existing confirm leg already uses it), and this file spies on it
// with jest.spyOn (call-through by default) to observe invocations.
//
// Run alone: cd zoho-middleware && npx jest pos-recipe-money-path
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
      KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets',
      KIOSK_IDEM_PREFIX: 'kiosk:idem:',
      KIOSK_PENDING_CHARGE_PREFIX: 'kiosk:pending-charge:'
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
// Test fixtures
// ---------------------------------------------------------------------------

var MOCK_INGREDIENTS_CATALOG = [
  { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
  { item_id: 'ing-hops-1', name: 'Cascade Hops', rate: 8.00, tax_id: 'tax-gst', stock_on_hand: 2, unit: 'kg' },
  { item_id: 'ing-yeast-1', name: 'US-05 Yeast', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 10, unit: 'pcs' }
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
  var moneyPath = require('../lib/money-path'); // real impl, loaded fresh per test
  require('../routes/pos-recipe');
  return {
    axios: require('axios'),
    cache: require('../lib/cache'),
    helcim: require('../lib/helcim'),
    zohoApi: require('../lib/zoho-api'),
    brewpad: require('../lib/brewpad-integration'),
    mailer: require('../lib/mailer'),
    C: require('../lib/constants'),
    moneyPath: moneyPath
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

describe('POST /api/kiosk/recipe-sale/confirm — hardened void (T-50-28, audit H5/L18)', function () {
  var mocks;

  beforeEach(function () {
    mocks = resetAndLoadPosRecipe();
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    process.env.BEER_SALES_ENABLED = 'true';
    process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
    process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
    process.env.KIOSK_CONTACT_ID = 'contact-default';
    delete process.env.MILLING_FEE_ITEM_ID;
    mocks.helcim.isTerminalEnabled.mockReturnValue(true);
    mocks.helcim.voidTransaction.mockResolvedValue({});
    mocks.cache.acquireLock.mockResolvedValue(true);
    mocks.cache.releaseLock.mockResolvedValue();
    mocks.cache.del.mockResolvedValue(1);
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve(MOCK_INGREDIENTS_CATALOG);
      if (key === 'zoho:ingredients') return Promise.resolve(MOCK_INGREDIENTS_CATALOG);
      return Promise.resolve(null);
    });
    mocks.axios.post.mockResolvedValue(MOCK_RECIPE_RESPONSE);
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 7: recipe confirm void goes through the primitive
  // -------------------------------------------------------------------------
  test('7. a failed Zoho invoice creation routes the void through moneyPath.voidWithTimeout (not a raw helcimLib.voidTransaction call from the route)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    var voidSpy = jest.spyOn(mocks.moneyPath, 'voidWithTimeout');
    mocks.zohoApi.zohoPost.mockImplementation(function (path) {
      if (path === '/invoices') return Promise.reject(new Error('Zoho unavailable'));
      return Promise.resolve({});
    });

    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-money-path-7',
        reference: 'RECIPE-MP-7',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body.payment_voided).toBe(true);
      expect(voidSpy).toHaveBeenCalledTimes(1);
      var voidCallArgs = voidSpy.mock.calls[0];
      // 1st arg is a helcim-shaped wrapper (the _voidFailed-tracking shim —
      // mirrors pos.js), NOT necessarily the bare helcimLib module reference.
      expect(typeof voidCallArgs[0].voidTransaction).toBe('function');
      expect(voidCallArgs[1]).toBe('txn-money-path-7');
      expect(typeof voidCallArgs[2]).toBe('number');
      expect(voidCallArgs[3]).toEqual(expect.objectContaining({ mailer: mocks.mailer }));
      // The underlying Helcim call still happens (the primitive wraps it) —
      // the assertion above proves it happens THROUGH the primitive, not
      // as a raw route-level call outside it.
      expect(mocks.helcim.voidTransaction).toHaveBeenCalledWith('txn-money-path-7');
    });
  });
});

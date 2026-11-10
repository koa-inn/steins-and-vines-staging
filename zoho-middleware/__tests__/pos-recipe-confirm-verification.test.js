'use strict';

// Kiosk recipe-sale money path, brought to parity with /api/kiosk/sale
// (2026-10-13, follow-up named in c961e6bb):
//   A. The sale leg minted its own 'RECIPE-<ts>' Helcim reference and ignored
//      the kiosk's reference_number, while /confirm keys the pending-charge
//      sentinel, the invoice reference and (now) the terminal poll on the
//      kiosk's reference. Use the kiosk reference, like pos.js:803.
//   B. A manual confirm ('manual-confirm') was booked as paid without asking
//      Helcim whether the card was approved. Resolve it via
//      pollTerminalResult first; fail closed with nothing booked.
//   C. The captured card amount was never checked against the recomputed
//      total. Read it back before the invoice; void on mismatch (D-50-04).
//
// Harness copied from __tests__/pos-recipe.test.js with the two extra Helcim
// functions and constants these paths use.

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


var SALE_BODY = { recipe_id: 'RCP-001', sale_type: 'in-store', reference_number: 'KIOSK-REF-1', idempotency_key: 'KIOSK-REF-1' };

function setEnv() {
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
  process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
  delete process.env.MILLING_FEE_ITEM_ID;
}

function clearEnv() {
  ['APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN', 'BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID',
    'MATERIALS_FEE_ITEM_ID', 'KIOSK_CONTACT_ID', 'MILLING_FEE_ITEM_ID'].forEach(function (k) { delete process.env[k]; });
}

function load() {
  var mocks = resetAndLoadPosRecipe();
  setEnv();
  mocks.helcim.isTerminalEnabled.mockReturnValue(true);
  mocks.helcim.terminalPurchase.mockResolvedValue({});
  mocks.helcim.voidTransaction.mockResolvedValue({});
  mocks.cache.acquireLock.mockResolvedValue(true);
  mocks.cache.releaseLock.mockResolvedValue();
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(MOCK_INGREDIENTS_CATALOG);
    return Promise.resolve(null);
  });
  mocks.axios.post.mockResolvedValue(MOCK_RECIPE_RESPONSE);
  mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  return mocks;
}

// Learn the amount a sale of SALE_BODY charges: the quote route prices through
// the same computeRecipeQuote the confirm leg re-checks (the legacy initiate
// route is retired from tests, 101-09).
function chargedTotal() {
  return callHandler('GET', '/api/kiosk/recipe-quote', {
    query: { recipe_id: SALE_BODY.recipe_id, sale_type: SALE_BODY.sale_type }, headers: {}
  }).then(function (res) {
    return res._body.total_with_tax;
  });
}

function confirm(txnId) {
  return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
    body: { recipe_id: 'RCP-001', sale_type: 'in-store', transaction_id: txnId, reference: 'KIOSK-REF-1', idempotency_key: 'KIOSK-REF-1' }
  });
}

function invoiceCalls(mocks) {
  return mocks.zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
}

afterEach(clearEnv);

describe('B. manual confirm is verified against Helcim before booking', function () {
  test('approved: books the real Helcim id, never the literal manual-confirm', function () {
    var mocks = load();
    return chargedTotal().then(function (total) {
      mocks.helcim.pollTerminalResult.mockResolvedValue({ approved: true, transactionId: 'H-999', status: 'APPROVED' });
      mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: total });
      return confirm('manual-confirm');
    }).then(function (res) {
      expect(mocks.helcim.pollTerminalResult).toHaveBeenCalledWith('KIOSK-REF-1');
      expect(res._status).toBe(201);
      expect(res._body.transaction_id).toBe('H-999');
      var pay = mocks.zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
      expect(pay[0][1].reference_number).toBe('H-999');
    });
  });

  test('declined: 400, nothing booked, nothing voided', function () {
    var mocks = load();
    mocks.helcim.pollTerminalResult.mockResolvedValue({ approved: false, status: 'DECLINED' });
    return confirm('manual-confirm').then(function (res) {
      expect(res._status).toBe(400);
      expect(invoiceCalls(mocks)).toHaveLength(0);
      expect(mocks.helcim.voidTransaction).not.toHaveBeenCalled();
    });
  });

  test('unverifiable: 409, nothing booked, confirm lock released for a retry', function () {
    var mocks = load();
    mocks.helcim.pollTerminalResult.mockResolvedValue(null);
    return confirm('manual-confirm').then(function (res) {
      expect(res._status).toBe(409);
      expect(invoiceCalls(mocks)).toHaveLength(0);
      expect(mocks.cache.releaseLock).toHaveBeenCalledWith('kiosk:idem:confirm:KIOSK-REF-1');
    });
  });

  test('poll error: 409, nothing booked', function () {
    var mocks = load();
    mocks.helcim.pollTerminalResult.mockRejectedValue(new Error('helcim down'));
    return confirm('manual-confirm').then(function (res) {
      expect(res._status).toBe(409);
      expect(invoiceCalls(mocks)).toHaveLength(0);
    });
  });
});


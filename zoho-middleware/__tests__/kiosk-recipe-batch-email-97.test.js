'use strict';

// Phase 97-10 Task 2 (D-03 support): kiosk in-store recipe sales carry the selected
// customer's email onto the new batch (customer_email) so Cal.com packaging
// bookings can match by email. Walk-in / no-email sales are unchanged.

var mockRouteHandlers = {};

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
    isConnected: jest.fn().mockReturnValue(true),
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
        recipe_id: 'RCP-001', name: 'Cascade Pale Ale', style: 'American Pale Ale', abv: 5.2,
        batch_size_l: 20, locked_price: 195.00, service_fee: 45.00, materials_fee: 5.00, status: 'active'
      },
      ingredients: [
        { ingredient_id: 'ING-001', recipe_id: 'RCP-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
        { ingredient_id: 'ING-002', recipe_id: 'RCP-001', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' },
        { ingredient_id: 'ING-003', recipe_id: 'RCP-001', item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
      ]
    }
  }
};

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
    log: require('../lib/logger')
  };
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

function tick() { return new Promise(function (resolve) { setImmediate(resolve); }); }

describe('detectRecipeSale customerEmail (97-10)', function () {
  var axios;

  beforeEach(function () {
    jest.resetModules();
    axios = require('axios');
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { ok: true, batch_id: 'SV-B-000001' } });
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
  });

  test('sixth argument lands in the create payload as customer_email', async function () {
    var real = jest.requireActual('../lib/brewpad-integration');
    real.detectRecipeSale('RCP-1', { name: 'Pale' }, 'INV-1', 'Jane Doe', 'C-1', 'jane@example.com');
    await tick();
    expect(axios.post).toHaveBeenCalledTimes(1);
    var payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(payload.customer_email).toBe('jane@example.com');
    expect(payload.source).toBe('kiosk_recipe');
  });

  test('five arguments or empty sixth: no customer_email key', async function () {
    var real = jest.requireActual('../lib/brewpad-integration');
    real.detectRecipeSale('RCP-1', { name: 'Pale' }, 'INV-1', 'Jane Doe', 'C-1');
    real.detectRecipeSale('RCP-1', { name: 'Pale' }, 'INV-1', 'Jane Doe', 'C-1', '');
    await tick();
    expect(axios.post).toHaveBeenCalledTimes(2);
    axios.post.mock.calls.forEach(function (c) {
      expect(Object.prototype.hasOwnProperty.call(JSON.parse(c[1]), 'customer_email')).toBe(false);
    });
  });
});

describe('pos-recipe confirm customer_email pass-through (97-10)', function () {
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
    mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    mocks.cache.acquireLock.mockResolvedValue(true);
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(MOCK_INGREDIENTS_CATALOG);
      return Promise.resolve(null);
    });
    mocks.axios.post.mockResolvedValue(MOCK_RECIPE_RESPONSE);
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
  });

  function confirm(extra) {
    var n = Math.random().toString(36).slice(2, 8);
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: Object.assign({
        recipe_id: 'RCP-001', transaction_id: 'txn-' + n, reference: 'RECIPE-' + n,
        sale_type: 'in-store', customer_name: 'John Smith', contact_id: 'C-001'
      }, extra)
    });
  }

  test('valid email is trimmed and passed as the sixth argument', async function () {
    await confirm({ customer_email: ' Jane@Example.com ' });
    expect(mocks.brewpad.detectRecipeSale).toHaveBeenCalledTimes(1);
    var args = mocks.brewpad.detectRecipeSale.mock.calls[0];
    expect(args.length).toBe(6);
    expect(args[5]).toBe('Jane@Example.com');
  });

  test.each([
    ['bad shape', 'not-an-email'],
    ['over 254 chars', new Array(250).join('a') + '@example.com'],
    ['non-string', 12345],
    ['object', { a: 1 }]
  ])('invalid email (%s) keeps the five-argument call', async function (label, value) {
    await confirm({ customer_email: value });
    expect(mocks.brewpad.detectRecipeSale.mock.calls[0].length).toBe(5);
  });

  test('missing email keeps the five-argument call', async function () {
    await confirm({});
    expect(mocks.brewpad.detectRecipeSale.mock.calls[0].length).toBe(5);
  });

  test('the email never appears in any log call', async function () {
    await confirm({ customer_email: 'jane@example.com' });
    ['info', 'warn', 'error', 'debug'].forEach(function (lvl) {
      mocks.log[lvl].mock.calls.forEach(function (c) {
        c.forEach(function (a) {
          expect(typeof a === 'string' ? a : JSON.stringify(a)).not.toContain('@');
        });
      });
    });
  });
});

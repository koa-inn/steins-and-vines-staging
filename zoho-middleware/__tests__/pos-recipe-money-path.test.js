'use strict';

// ---------------------------------------------------------------------------
// pos-recipe-money-path.test.js — Phase 50-05 (M12 / roadmap SC#5)
//
// Regression coverage for /api/kiosk/recipe-sale adopting the SAME
// money-path primitives already used by /api/kiosk/sale (pos.js):
//   - moneyPath.acquireIdempotencyLock as a distinct duplicate-charge guard,
//     acquired BEFORE the pre-existing RECIPE_SALE inventory mutex (D-50-06)
//   - a deterministic sha256-derived Helcim idempotency key (D-50-06a)
//   - a pending-charge record (KIOSK_PENDING_CHARGE_PREFIX) so an orphaned
//     recipe charge becomes visible to lib/reconcile.js (M12)
//   - the recipe confirm leg's void-on-failure routed through
//     moneyPath.voidWithTimeout instead of a raw helcimLib.voidTransaction
//     call (audit H5/L18)
//
// Mirrors the mocking conventions of pos-recipe.test.js. Does NOT mock
// ../lib/money-path — the real primitive is exercised (consistent with how
// the pre-existing confirm leg already uses it), and this file spies on it
// with jest.spyOn (call-through by default) to observe invocations.
//
// Run alone: cd zoho-middleware && npx jest pos-recipe-money-path
// ---------------------------------------------------------------------------

var crypto = require('crypto');

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

describe('POST /api/kiosk/recipe-sale — money-path primitives (M12, D-50-06)', function () {
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
    delete process.env.NODE_ENV;
    mocks.helcim.isTerminalEnabled.mockReturnValue(true);
    mocks.helcim.terminalPurchase.mockResolvedValue({});
    mocks.cache.acquireLock.mockResolvedValue(true);
    mocks.cache.releaseLock.mockResolvedValue();
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
    delete process.env.NODE_ENV;
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: Duplicate recipe-sale -> one charge
  // -------------------------------------------------------------------------
  test('1. duplicate recipe-sale with the same idempotency_key produces exactly ONE terminal charge', function () {
    var lockSpy = jest.spyOn(mocks.moneyPath, 'acquireIdempotencyLock')
      .mockResolvedValueOnce({ status: 'acquired' })
      .mockResolvedValueOnce({ status: 'contention' });

    var body = { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'dup-key-001' };

    return callHandler('POST', '/api/kiosk/recipe-sale', { body: body }).then(function (res1) {
      expect(res1._status).toBe(202);
      return callHandler('POST', '/api/kiosk/recipe-sale', { body: body }).then(function (res2) {
        expect(res2._status).toBe(409);
        expect(mocks.helcim.terminalPurchase).toHaveBeenCalledTimes(1);
        expect(lockSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: idempotency lock is a distinct guard from the RECIPE_SALE mutex
  // -------------------------------------------------------------------------
  test('2. BOTH the idempotency lock (kiosk:idem:) AND the RECIPE_SALE mutex are acquired, idempotency gate FIRST (D-50-06)', function () {
    var lockSpy = jest.spyOn(mocks.moneyPath, 'acquireIdempotencyLock');

    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'order-key-002' }
    }).then(function (res) {
      expect(res._status).toBe(202);
      expect(lockSpy).toHaveBeenCalledWith(mocks.cache, 'kiosk:idem:order-key-002', expect.any(Number));
      expect(mocks.cache.acquireLock).toHaveBeenCalledWith('recipe-sale', 30);

      var lockCallOrder = lockSpy.mock.invocationCallOrder[0];
      var mutexCallOrder = mocks.cache.acquireLock.mock.invocationCallOrder[0];
      expect(lockCallOrder).toBeLessThan(mutexCallOrder);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: required in production
  // -------------------------------------------------------------------------
  test('3. idempotency_key is required when NODE_ENV=production; terminalPurchase NOT called', function () {
    process.env.NODE_ENV = 'production';
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/idempotency_key is required/);
      expect(mocks.helcim.terminalPurchase).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: deterministic Helcim key (D-50-06a)
  // -------------------------------------------------------------------------
  test('4. terminalPurchase receives a deterministic 3rd-arg Helcim key = sha256(idempotency_key).hex.slice(0,25)', function () {
    var idemKey = 'order-key-004';
    var expectedHelcimKey = crypto.createHash('sha256').update(idemKey).digest('hex').substring(0, 25);

    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: idemKey }
    }).then(function (res) {
      expect(res._status).toBe(202);
      expect(mocks.helcim.terminalPurchase).toHaveBeenCalledTimes(1);
      var callArgs = mocks.helcim.terminalPurchase.mock.calls[0];
      expect(callArgs[2]).toBe(expectedHelcimKey);
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: pending-charge record written (M12)
  // -------------------------------------------------------------------------
  test('5. a pending-charge record is written under kiosk:pending-charge:<refNumber> matching the Helcim invoiceNumber', function () {
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'order-key-005' }
    }).then(function (res) {
      expect(res._status).toBe(202);
      var refNumber = mocks.helcim.terminalPurchase.mock.calls[0][1];
      expect(typeof refNumber).toBe('string');
      var expectedKey = 'kiosk:pending-charge:' + refNumber;
      var pendingSetCall = mocks.cache.set.mock.calls.find(function (c) { return c[0] === expectedKey; });
      expect(pendingSetCall).toBeTruthy();
      expect(pendingSetCall[1]).toEqual(expect.objectContaining({
        reference_number: refNumber,
        amount: expect.any(Number),
        idempotency_key: 'order-key-005',
        created_at: expect.any(String)
      }));
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: lock released on terminal-push failure
  // -------------------------------------------------------------------------
  test('6. terminal-push failure releases BOTH the idempotency key and the RECIPE_SALE mutex', function () {
    mocks.helcim.terminalPurchase.mockRejectedValue(new Error('Terminal unavailable'));
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'order-key-006' }
    }).then(function (res) {
      expect(res._status).toBe(502);
      expect(mocks.cache.releaseLock).toHaveBeenCalledWith('recipe-sale');
      expect(mocks.cache.releaseLock).toHaveBeenCalledWith('kiosk:idem:order-key-006');
    });
  });
});

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

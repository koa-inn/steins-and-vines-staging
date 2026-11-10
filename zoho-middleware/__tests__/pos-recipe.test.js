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

describe('POST /api/kiosk/recipe-sale/confirm', function () {
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
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
  });

  test('8. confirm returns 403 when BEER_SALES_ENABLED is false', function () {
    process.env.BEER_SALES_ENABLED = 'false';
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: { recipe_id: 'RCP-001', transaction_id: 'txn-123', reference: 'RECIPE-1234', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(403);
      expect(res._body.error).toBe('Recipe sales are not enabled');
    });
  });

  test('9. confirm creates invoice with per-ingredient line items plus fee', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-123',
        reference: 'RECIPE-1234',
        sale_type: 'in-store',
        customer_name: 'Jane Doe'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.ok).toBe(true);
      expect(res._body.invoice_number).toBe('INV-001');
      // Verify zohoPost was called with /invoices and line_items containing ingredients + fees
      var invoiceCalls = mocks.zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
      expect(invoiceCalls.length).toBe(1);
      var lineItems = invoiceCalls[0][1].line_items;
      // Should have 3 ingredient lines (malt + hops + yeast) + 2 fee lines (Brewing Fee + Materials Fee)
      expect(lineItems.length).toBe(5);
      var brewingFee = lineItems.find(function (li) { return li.name === 'Brewing Fee'; });
      var materialsFee = lineItems.find(function (li) { return li.name === 'Materials Fee'; });
      expect(brewingFee).toBeTruthy();
      expect(materialsFee).toBeTruthy();
      expect(brewingFee.item_id).toBe('fee-makers-1');
      expect(materialsFee.item_id).toBe('fee-materials-1');
    });
  });

  test('10. confirm voids transaction on Zoho invoice failure', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    mocks.zohoApi.zohoPost.mockRejectedValue(new Error('Zoho unavailable'));
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-456',
        reference: 'RECIPE-5678',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(mocks.helcim.voidTransaction).toHaveBeenCalledWith('txn-456');
      expect(res._status).toBe(502);
      expect(res._body.payment_voided).toBe(true);
    });
  });

  test('11. confirm releases lock after void on Zoho failure', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    mocks.zohoApi.zohoPost.mockRejectedValue(new Error('Zoho unavailable'));
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-789',
        reference: 'RECIPE-7890',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(mocks.cache.releaseLock).toHaveBeenCalledWith('recipe-sale');
    });
  });

  test('12. confirm calls detectRecipeSale for in-store sale', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-101',
        reference: 'RECIPE-1010',
        sale_type: 'in-store',
        customer_name: 'John Smith',
        contact_id: 'C-001'
      }
    }).then(function (res) {
      expect(mocks.brewpad.detectRecipeSale).toHaveBeenCalledWith(
        'RCP-001',
        expect.objectContaining({ name: 'Cascade Pale Ale', style: 'American Pale Ale' }),
        'INV-001',
        'John Smith',
        'C-001'
      );
    });
  });

  test('13. confirm does NOT call detectRecipeSale for take-out sale', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 195 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-202',
        reference: 'RECIPE-2020',
        sale_type: 'take-out',
        customer_name: 'Jane Smith'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(mocks.brewpad.detectRecipeSale).not.toHaveBeenCalled();
    });
  });

  test('14. confirm busts both kiosk products and ingredients caches', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-303',
        reference: 'RECIPE-3030',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var delCalls = mocks.cache.del.mock.calls.map(function (c) { return c[0]; });
      expect(delCalls).toContain('test:kiosk-products');
      expect(delCalls).toContain('zoho:ingredients');
      // Stock checks now read the full INGREDIENTS_ALL catalog (35-05); the
      // post-sale stock decrement must invalidate it too or availability goes stale.
      expect(delCalls).toContain('zoho:ingredients:all');
    });
  });

  test('17. confirm uses locked_price as grand total when pricing_mode is locked', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    // MOCK_RECIPE_RESPONSE has locked_price: 195 and no pricing_mode (defaults to locked)
    // Dynamic total would be: 5.5*3.50 + 0.1*8.00 + 45 + 5 = 70.05
    // But locked mode should charge 195.00
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-locked',
        reference: 'RECIPE-LOCKED',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      // Invoice should still have per-ingredient line items (for inventory deduction)
      expect(capturedInvoicePayload.line_items.length).toBeGreaterThan(0);
      var ingredientLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-malt-1'; });
      expect(ingredientLine).toBeTruthy();
    });
  });

  test('18. confirm computes from ingredients when pricing_mode is dynamic', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 72.9 });
    var dynamicRecipeResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-002',
            name: 'Dynamic Pale Ale',
            batch_size_l: 20,
            locked_price: 999,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active',
            pricing_mode: 'dynamic'
          },
          ingredients: [
            { ingredient_id: 'ING-001', recipe_id: 'RCP-002', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
            { ingredient_id: 'ING-002', recipe_id: 'RCP-002', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(dynamicRecipeResponse);
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-2', invoice_number: 'INV-002' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-002',
        transaction_id: 'txn-dynamic',
        reference: 'RECIPE-DYN',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      // Dynamic: 5.5*3.50 + 0.1*8.00 + 45 + 5 = 70.05 (not 999)
      // Verify per-ingredient line items are present
      var ingredientLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-malt-1'; });
      expect(ingredientLine).toBeTruthy();
      expect(ingredientLine.rate).toBe(3.50);
    });
  });
});

// ---------------------------------------------------------------------------
// Scaling tests — Task 1 (SCALE-01, SCALE-03, SCALE-05)
// ---------------------------------------------------------------------------

describe('POST /api/kiosk/recipe-sale/confirm — scaling (SCALE-04, SCALE-05)', function () {
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
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
  });

  test('C1. invoice line items use scaled quantities at 1.5x (SCALE-04)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 345.35 });
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
    });
    // batch_size_l=20, target=30 => factor=1.5
    // malt 5.5 * 1.5 = 8.25 kg; hops 0.1 * 1.5 = 0.15 kg; yeast 1 * 1.5 -> ceil(1.5) = 2 pcs
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-scale',
        reference: 'RECIPE-SCALE',
        sale_type: 'in-store',
        target_volume_l: 30
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var maltLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-malt-1'; });
      expect(maltLine).toBeTruthy();
      expect(maltLine.quantity).toBeCloseTo(8.25, 4);
      var hopsLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-hops-1'; });
      expect(hopsLine).toBeTruthy();
      expect(hopsLine.quantity).toBeCloseTo(0.15, 4);
      var yeastLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-yeast-1'; });
      expect(yeastLine).toBeTruthy();
      // discrete ceil: Math.max(1, Math.ceil(1 * 1.5)) = Math.max(1, 2) = 2
      expect(yeastLine.quantity).toBe(2);
    });
  });

  test('C2. confirm locked at 1.5x grand total matches quote (locked_price * 1.5 + fees)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 345.35 });
    // locked: 195 * 1.5 + 45 + 5 = 342.50
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-locked-scale',
        reference: 'RECIPE-LOCKED-SCALE',
        sale_type: 'in-store',
        target_volume_l: 30
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.total).toBe(345.35); // + $2.85 fee tax (2026-10-13)
    });
  });

  test('C3. recipe_snapshot passed to detectRecipeSale includes target_volume_l and scale_factor (SCALE-04)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 345.35 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-snapshot',
        reference: 'RECIPE-SNAP',
        sale_type: 'in-store',
        customer_name: 'Test User',
        contact_id: 'C-001',
        target_volume_l: 30
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var snapshotArg = mocks.brewpad.detectRecipeSale.mock.calls[0][1];
      expect(snapshotArg.target_volume_l).toBe(30);
      expect(snapshotArg.scale_factor).toBeCloseTo(1.5, 4);
      // snapshot ingredients should be scaled
      var maltIng = snapshotArg.ingredients.find(function (i) { return i.item_id === 'ing-malt-1'; });
      expect(maltIng.quantity).toBeCloseTo(8.25, 4);
    });
  });

  test('C4. returns 409 at confirm time if stock depleted between quote and confirm (D-09)', function () {
    // Recipe with hops qty=2, stock_on_hand=2, target=30 (1.5x) => 3 needed > 2 stock => conflict
    var conflictResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-CONFLICT',
            name: 'Stock Conflict Recipe',
            batch_size_l: 20,
            locked_price: 195.00,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active'
          },
          ingredients: [
            { ingredient_id: 'ING-002', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 2, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(conflictResponse);
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-CONFLICT',
        transaction_id: 'txn-stock-check',
        reference: 'RECIPE-STOCK',
        sale_type: 'in-store',
        target_volume_l: 30
      }
    }).then(function (res) {
      expect(res._status).toBe(409);
      expect(Array.isArray(res._body.conflicts)).toBe(true);
    });
  });

  test('C5. confirm with no target_volume_l defaults to 1.0x against batch_size_l (not silent short-circuit)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    // Omitting target_volume_l — handler must default to batch_size_l=20 => factor 1.0
    // locked: 195 * 1.0 + 45 + 5 = 245.00
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-default-1x',
        reference: 'RECIPE-DEFAULT',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.total).toBe(247.85); // + $2.85 fee tax (2026-10-13)
    });
  });

  test('C6. confirm with no batch_size_l on recipe returns 400 (D-11)', function () {
    var noBaseResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-NOBASE',
            name: 'No Base',
            batch_size_l: 0,
            locked_price: 195.00,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active'
          },
          ingredients: [
            { ingredient_id: 'ING-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(noBaseResponse);
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-NOBASE',
        transaction_id: 'txn-nobase',
        reference: 'RECIPE-NOBASE',
        sale_type: 'in-store',
        target_volume_l: 20
      }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/batch size/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: SCALE-05 — internal-only ingredient stock visibility
// ---------------------------------------------------------------------------
// Internal-only ingredients (e.g. Gypsum Bulk, item_id 109900000000028635) are
// absent from the purchasable-only INGREDIENTS catalog but present in INGREDIENTS_ALL
// with real stock_on_hand. The handlers must read INGREDIENTS_ALL so the stock gate
// and pricing see the correct catalog entry.

describe('SCALE-05 regression — internal-only ingredient reads INGREDIENTS_ALL', function () {
  var mocks;
  var INTERNAL_ITEM_ID = '109900000000028635'; // Gypsum (Calcium Sulfate) (Bulk)

  // Catalog that simulates INGREDIENTS_ALL — includes the internal item
  var INGREDIENTS_ALL_CATALOG = [
    { item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50, unit: 'kg' },
    { item_id: INTERNAL_ITEM_ID, name: 'Gypsum (Calcium Sulfate) (Bulk)', rate: 0.50, tax_id: 'tax-gst', stock_on_hand: 20.83, unit: 'kg' }
  ];

  // Recipe with only the internal-only ingredient (dynamic pricing so rate matters)
  var INTERNAL_ONLY_RECIPE_RESPONSE = {
    data: {
      ok: true,
      data: {
        recipe: {
          recipe_id: 'RCP-INTERNAL',
          name: 'Internal Ingredient Recipe',
          style: 'Test',
          abv: 5.0,
          batch_size_l: 20,
          locked_price: 0,
          service_fee: 45.00,
          materials_fee: 5.00,
          status: 'active',
          pricing_mode: 'dynamic'
        },
        ingredients: [
          { ingredient_id: 'ING-GYP', recipe_id: 'RCP-INTERNAL', item_id: INTERNAL_ITEM_ID, item_name: 'Gypsum (Calcium Sulfate) (Bulk)', quantity: 2, unit: 'kg' }
        ]
      }
    }
  };

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
    mocks.helcim.terminalPurchase.mockResolvedValue({});
    mocks.helcim.voidTransaction.mockResolvedValue({});
    mocks.cache.acquireLock.mockResolvedValue(true);
    mocks.cache.releaseLock.mockResolvedValue();
    mocks.cache.del.mockResolvedValue(1);
    // INGREDIENTS_ALL has the internal item; INGREDIENTS (purchasable-only) does NOT
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve(INGREDIENTS_ALL_CATALOG);
      if (key === 'zoho:ingredients') return Promise.resolve([{ item_id: 'ing-malt-1', name: 'Pale Malt 2-Row', rate: 3.50, tax_id: 'tax-gst', stock_on_hand: 50 }]);
      return Promise.resolve(null);
    });
    mocks.axios.post.mockResolvedValue(INTERNAL_ONLY_RECIPE_RESPONSE);
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-int', invoice_number: 'INV-INT' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
  });

  test('SCALE-05a (quote): internal-only ingredient with sufficient stock returns 200 with correct rate-inclusive total', function () {
    // dynamic: 2 kg Gypsum @ rate 0.50 = 1.00 + service_fee 45 + materials_fee 5 = 51.00
    // Against unfixed source (reads INGREDIENTS, item absent) → rate=0 → total = 0 + 50 = 50.00
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-INTERNAL', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      // Total must include the ingredient rate from INGREDIENTS_ALL (rate=0.50 * qty=2 = 1.00)
      expect(res._body.total_with_tax).toBe(53.85); // + $2.85 fee tax (2026-10-13)
    });
  });

  test('SCALE-05b (confirm): internal-only ingredient with sufficient stock returns 201 and invoice includes ingredient line', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 53.85 });
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-int', invoice_number: 'INV-INT' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-INTERNAL',
        transaction_id: 'txn-internal',
        reference: 'RECIPE-INT',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      // Invoice must include the internal ingredient line with correct rate
      var gypsumLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === INTERNAL_ITEM_ID; });
      expect(gypsumLine).toBeTruthy();
      expect(gypsumLine.rate).toBe(0.50);
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/kiosk/recipe-quote — dry-run quote (SCALE-01, 35-06)
// ---------------------------------------------------------------------------
// This endpoint must:
//   - Run the identical scale+price+stock compute as POST recipe-sale
//   - Return 200 with scaled totals + scaled ingredients + stock status
//   - NOT call helcim.terminalPurchase or cache.acquireLock (read-only)
//   - Mirror the BEER_SALES_ENABLED feature gate and same validation errors

describe('GET /api/kiosk/recipe-quote (dry-run, SCALE-01, 35-06)', function () {
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
  });

  test('Q1. returns 200 with ok:true, scale_factor, and total for valid in-store request at 1x', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.recipe_id).toBe('RCP-001');
      expect(res._body.base_volume_l).toBe(20);
      expect(res._body.target_volume_l).toBe(20);
      expect(res._body.scale_factor).toBe(1.0);
      // locked: 195 * 1.0 + 45 + 5 = 245.00
      expect(res._body.total).toBe(245.00);
      expect(res._body.pricing_mode).toBe('locked');
      expect(Array.isArray(res._body.ingredients)).toBe(true);
      expect(res._body.stock).toBeDefined();
      expect(typeof res._body.stock.ok).toBe('boolean');
    });
  });

  test('Q2. quote total_with_tax for locked 1.5x in-store is 345.35 (the charge; quote == sale parity lives in pos-cart-quote.test.js)', function () {
    // locked: 195 * 1.5 + 45 + 5 = 342.50, + $2.85 fee tax (2026-10-13)
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '30', sale_type: 'in-store' }
    }).then(function (quoteRes) {
      expect(quoteRes._status).toBe(200);
      expect(quoteRes._body.total_with_tax).toBe(345.35);
    });
  });

  test('Q3. quote does NOT call helcim.terminalPurchase and does NOT call cache.acquireLock', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(mocks.helcim.terminalPurchase).not.toHaveBeenCalled();
      expect(mocks.cache.acquireLock).not.toHaveBeenCalled();
    });
  });

  test('Q4. returns scaled ingredient list with item_id, item_name, unit, base_quantity, quantity, rate, line_total', function () {
    // 1.5x: malt 5.5*1.5=8.25; hops 0.1*1.5=0.15; yeast ceil(1*1.5)=2
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '30', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.ingredients.length).toBe(3);
      var malt = res._body.ingredients.find(function (i) { return i.item_id === 'ing-malt-1'; });
      expect(malt).toBeTruthy();
      expect(malt.base_quantity).toBe(5.5);
      expect(malt.quantity).toBeCloseTo(8.25, 4);
      expect(malt.rate).toBe(3.50);
      expect(malt.line_total).toBeCloseTo(8.25 * 3.50, 2);
      var hops = res._body.ingredients.find(function (i) { return i.item_id === 'ing-hops-1'; });
      expect(hops.quantity).toBeCloseTo(0.15, 4);
      var yeast = res._body.ingredients.find(function (i) { return i.item_id === 'ing-yeast-1'; });
      expect(yeast.quantity).toBe(2); // discrete ceil
    });
  });

  test('Q5. returns stock.ok=false with conflicts when scaled qty oversells', function () {
    var conflictResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-CONFLICT',
            name: 'Stock Conflict Recipe',
            batch_size_l: 20,
            locked_price: 195.00,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active'
          },
          ingredients: [
            { ingredient_id: 'ING-002', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 2, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(conflictResponse);
    // 2 * 1.5 = 3 needed, stock_on_hand = 2 => conflict
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-CONFLICT', target_volume_l: '30', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true); // 200 (quote always returns, stock status is informational)
      expect(res._body.stock.ok).toBe(false);
      expect(Array.isArray(res._body.stock.conflicts)).toBe(true);
      expect(res._body.stock.conflicts.length).toBeGreaterThan(0);
      expect(res._body.stock.conflicts[0].item_id).toBe('ing-hops-1');
    });
  });

  test('Q6. returns 400 when target_volume_l is <= 0', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '0', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/target_volume_l/);
    });
  });

  test('Q7. returns 400 when target_volume_l exceeds 10x base (fat-finger guard, D-11)', function () {
    // batch_size_l=20, target=201 (> 20*10=200)
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '201', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/maximum/i);
    });
  });

  test('Q8. returns 400 when recipe has no batch_size_l (cannot scale, D-11)', function () {
    var noBaseResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-NOBASE',
            name: 'No Base Recipe',
            batch_size_l: 0,
            locked_price: 195.00,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active'
          },
          ingredients: [
            { ingredient_id: 'ING-001', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(noBaseResponse);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-NOBASE', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.error).toMatch(/batch size/i);
    });
  });

  test('Q9. returns 404 when recipe not found from Apps Script', function () {
    mocks.axios.post.mockResolvedValue({
      data: { ok: false, data: null }
    });
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-MISSING', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(404);
      expect(res._body.error).toMatch(/not found/i);
    });
  });

  test('Q10. returns 503 when INGREDIENTS_ALL catalog is cold (cache miss)', function () {
    mocks.cache.get.mockResolvedValue(null);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(503);
      expect(res._body.error).toMatch(/catalog/i);
    });
  });

  test('Q11. returns 403 when BEER_SALES_ENABLED is false (mirrors feature gate)', function () {
    process.env.BEER_SALES_ENABLED = 'false';
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(403);
      expect(res._body.error).toMatch(/not enabled/i);
    });
  });

  test('Q12. defaults target_volume_l to base volume (scale_factor 1.0) when omitted', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.scale_factor).toBe(1.0);
      expect(res._body.target_volume_l).toBe(20);
      expect(res._body.total).toBe(245.00);
    });
  });
});

// ---------------------------------------------------------------------------
// MOD-02: GET /api/kiosk/recipe-quote — modified_ingredients (Task 1, 36-03)
// ---------------------------------------------------------------------------
// Tests for when a modified_ingredients list is supplied (JSON-encoded array of
// base-quantity ingredients) in the query string. The server prices the modified
// list via computeModifiedRecipeTotal and returns scaled+modified ingredient lines.

describe('GET /api/kiosk/recipe-quote — modified_ingredients (MOD-02, 36-03)', function () {
  var mocks;

  // MOCK_RECIPE_RESPONSE fixture:
  //   recipe: locked_price=195, service_fee=45, materials_fee=5, batch_size_l=20
  //   ingredients: malt(5.5kg), hops(0.1kg), yeast(1pcs)
  //
  // LOCKED_ADD fixture: replace hops with dry-hop, add yeast still in list
  // modifiedIngredients (base, pre-scale): malt(5.5kg) + dry-hop(0.5kg) + yeast(1pcs)
  // → hops (ING-002) REMOVED, Centennial Dry Hop ADDED at 0.5kg
  //
  // Locked-add total at 1x:
  //   base locked = 195 * 1.0 + 45 + 5 = 245.00
  //   added Centennial 0.5kg scaled (1x) = 0.5 * 10.00 = 5.00
  //   total = 250.00
  //
  // Locked-remove total at 1x (hops removed, rest unchanged):
  //   base locked = 195 * 1.0 + 45 + 5 = 245.00 (no credit for removed)
  //   total = 245.00

  var LOCKED_ADD_MODIFIED = [
    { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
    { item_id: 'ing-dry-hop-1', item_name: 'Centennial Hops (Dry Hop)', quantity: 0.5, unit: 'kg' },
    { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
  ];

  var LOCKED_REMOVE_MODIFIED = [
    { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
    { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
  ];

  beforeEach(function () {
    mocks = resetAndLoadPosRecipe();
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    process.env.BEER_SALES_ENABLED = 'true';
    process.env.MAKERS_FEE_ITEM_ID = 'fee-makers-1';
    process.env.MATERIALS_FEE_ITEM_ID = 'fee-materials-1';
    process.env.KIOSK_CONTACT_ID = 'contact-default';
    delete process.env.MILLING_FEE_ITEM_ID;
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
  });

  test('M-Q1. locked-add: base locked total + added-ingredient scaled price (D-07)', function () {
    // Locked-add: locked 195*1 + 45 + 5 = 245; + Centennial 0.5*10 = 5 => 250
    var modJson = JSON.stringify(LOCKED_ADD_MODIFIED);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store', modified_ingredients: modJson }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.ok).toBe(true);
      expect(res._body.total).toBe(250.00);
      expect(res._body.is_modified).toBe(true);
    });
  });

  test('M-Q2. locked-remove: no credit for removed ingredient — total identical to unmodified quote (D-08)', function () {
    // Remove hops from the list — locked base still 245.00 (no reduction)
    var modJson = JSON.stringify(LOCKED_REMOVE_MODIFIED);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store', modified_ingredients: modJson }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.total).toBe(245.00);
      expect(res._body.is_modified).toBe(true);
    });
  });

  test('M-Q3. dynamic-modify: total = sum over modified scaled list + fees (D-09)', function () {
    var dynamicRecipeResponse = {
      data: {
        ok: true,
        data: {
          recipe: {
            recipe_id: 'RCP-DYN',
            name: 'Dynamic Recipe',
            batch_size_l: 20,
            locked_price: 0,
            service_fee: 45.00,
            materials_fee: 5.00,
            status: 'active',
            pricing_mode: 'dynamic'
          },
          ingredients: [
            { ingredient_id: 'ING-001', recipe_id: 'RCP-DYN', item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
            { ingredient_id: 'ING-002', recipe_id: 'RCP-DYN', item_id: 'ing-hops-1', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg' }
          ]
        }
      }
    };
    mocks.axios.post.mockResolvedValue(dynamicRecipeResponse);
    // Modified: remove hops, add dry-hop at 0.5kg
    var modified = [
      { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
      { item_id: 'ing-dry-hop-1', item_name: 'Centennial Hops (Dry Hop)', quantity: 0.5, unit: 'kg' }
    ];
    // dynamic total at 1x: 5.5*3.50 + 0.5*10.00 + 45 + 5 = 19.25 + 5.00 + 50 = 74.25
    var modJson = JSON.stringify(modified);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-DYN', target_volume_l: '20', sale_type: 'in-store', modified_ingredients: modJson }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.total).toBe(74.25);
      expect(res._body.is_modified).toBe(true);
    });
  });

  test('M-Q4. malformed JSON in modified_ingredients treated as null — returns unmodified quote, no 500 (regression guard)', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store', modified_ingredients: '{not-json' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      // Unmodified locked total: 195 * 1 + 45 + 5 = 245
      expect(res._body.total).toBe(245.00);
      // is_modified should be false (no valid modified list was parsed)
      expect(res._body.is_modified).toBe(false);
    });
  });

  test('M-Q5. no modified_ingredients — returns exact Phase 35 total (regression)', function () {
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.total).toBe(245.00);
      expect(res._body.is_modified).toBe(false);
    });
  });

  test('M-Q6. modified quote ingredient list reflects SCALED modified lines (not original recipe)', function () {
    // At 1.5x: malt 5.5*1.5=8.25kg; dry-hop 0.5*1.5=0.75kg; yeast ceil(1*1.5)=2pcs
    var modJson = JSON.stringify(LOCKED_ADD_MODIFIED);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '30', sale_type: 'in-store', modified_ingredients: modJson }
    }).then(function (res) {
      expect(res._status).toBe(200);
      var ings = res._body.ingredients;
      // Should show modified list (malt + dry-hop + yeast), NOT original (malt + hops + yeast)
      var dryHop = ings.find(function (i) { return i.item_id === 'ing-dry-hop-1'; });
      var origHops = ings.find(function (i) { return i.item_id === 'ing-hops-1'; });
      expect(dryHop).toBeTruthy();
      expect(origHops).toBeUndefined(); // original hops removed
      // dry-hop scaled: 0.5 * 1.5 = 0.75 (continuous kg)
      expect(dryHop.quantity).toBeCloseTo(0.75, 4);
    });
  });

  test('M-Q7. added item_id not in catalog contributes zero to total (T-36-07)', function () {
    // An unknown item_id that is not in catalogMap should be silently skipped
    var modWithUnknown = [
      { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
      { item_id: 'FAKE-ID-999', item_name: 'Ghost Ingredient', quantity: 10, unit: 'kg' },
      { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
    ];
    var modJson = JSON.stringify(modWithUnknown);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-001', target_volume_l: '20', sale_type: 'in-store', modified_ingredients: modJson }
    }).then(function (res) {
      expect(res._status).toBe(200);
      // locked base 245; FAKE-ID-999 not in catalog => 0 contribution; total unchanged
      expect(res._body.total).toBe(245.00);
    });
  });
});

// ---------------------------------------------------------------------------
// MOD-02: POST /api/kiosk/recipe-sale — modified_ingredients (Task 1, 36-03)
// ---------------------------------------------------------------------------

describe('POST /api/kiosk/recipe-sale/confirm — modified_ingredients + snapshot (MOD-02, 36-03)', function () {
  var mocks;

  var LOCKED_ADD_MODIFIED = [
    { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
    { item_id: 'ing-dry-hop-1', item_name: 'Centennial Hops (Dry Hop)', quantity: 0.5, unit: 'kg' },
    { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
  ];

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
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
  });

  test('M-C1. confirm with locked-add modified list charges LOCKED_ADD total (displayed==charged)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 252.85 });
    // locked-add at 1x: 195*1 + 45 + 5 = 245; + Centennial 0.5*10 = 5 => 250
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-mod-add',
        reference: 'RECIPE-MOD-ADD',
        sale_type: 'in-store',
        modified_ingredients: LOCKED_ADD_MODIFIED
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.total).toBe(252.85); // + $2.85 fee tax (2026-10-13)
    });
  });

  test('M-C2. confirm total matches quote total for same modified inputs (displayed==charged)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 252.85 });
    // Must be identical to M-Q1 total (250.00) — core MOD-02 guarantee
    var quoteTotal;
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: {
        recipe_id: 'RCP-001',
        target_volume_l: '20',
        sale_type: 'in-store',
        modified_ingredients: JSON.stringify(LOCKED_ADD_MODIFIED)
      }
    }).then(function (quoteRes) {
      expect(quoteRes._status).toBe(200);
      quoteTotal = quoteRes._body.total_with_tax; // confirm books the taxed total (fee tax, 2026-10-13)
      return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
        body: {
          recipe_id: 'RCP-001',
          transaction_id: 'txn-parity',
          reference: 'RECIPE-PARITY',
          sale_type: 'in-store',
          target_volume_l: 20,
          modified_ingredients: LOCKED_ADD_MODIFIED
        }
      });
    }).then(function (confirmRes) {
      expect(confirmRes._status).toBe(201);
      expect(confirmRes._body.total).toBe(quoteTotal);
      expect(quoteTotal).toBe(252.85); // + $2.85 fee tax (2026-10-13)
    });
  });

  test('M-C3. snapshot.modified_base_ingredients equals pre-scale submitted list; is_modified=true', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 252.85 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-snapshot-mod',
        reference: 'RECIPE-SNAP-MOD',
        sale_type: 'in-store',
        customer_name: 'Test User',
        contact_id: 'C-001',
        modified_ingredients: LOCKED_ADD_MODIFIED
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var snapshotArg = mocks.brewpad.detectRecipeSale.mock.calls[0][1];
      expect(snapshotArg.is_modified).toBe(true);
      expect(snapshotArg.modified_base_ingredients).toEqual(LOCKED_ADD_MODIFIED);
    });
  });

  test('M-C4. snapshot.ingredients reflects the SCALED MODIFIED list (not original recipe)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 252.85 });
    // modified list has dry-hop, not hops; snapshot.ingredients must show scaled modified
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-snap-scaled',
        reference: 'RECIPE-SNAP-SCALED',
        sale_type: 'in-store',
        customer_name: 'Test User',
        contact_id: 'C-001',
        target_volume_l: 20,
        modified_ingredients: LOCKED_ADD_MODIFIED
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var snapshotArg = mocks.brewpad.detectRecipeSale.mock.calls[0][1];
      var dryHop = snapshotArg.ingredients.find(function (i) { return i.item_id === 'ing-dry-hop-1'; });
      var origHops = snapshotArg.ingredients.find(function (i) { return i.item_id === 'ing-hops-1'; });
      expect(dryHop).toBeTruthy();
      expect(origHops).toBeUndefined();
      // 0.5kg dry-hop scaled at 1x (factor=1): 0.5 * 1.0 = 0.5 (continuous)
      expect(dryHop.quantity).toBeCloseTo(0.5, 4);
    });
  });

  test('M-C5. invoice line items use scaled MODIFIED list (Zoho inventory deduction uses modified)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 252.85 });
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-inv-mod',
        reference: 'RECIPE-INV-MOD',
        sale_type: 'in-store',
        target_volume_l: 20,
        modified_ingredients: LOCKED_ADD_MODIFIED
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var dryHopLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-dry-hop-1'; });
      var origHopsLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-hops-1'; });
      expect(dryHopLine).toBeTruthy();
      expect(origHopsLine).toBeUndefined();
    });
  });

  test('M-C6. confirm without modified_ingredients: snapshot.is_modified=false, modified_base_ingredients=null (regression)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 247.85 });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-no-mod',
        reference: 'RECIPE-NO-MOD',
        sale_type: 'in-store',
        customer_name: 'Test User',
        contact_id: 'C-001'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      // Regression: Phase 35 total unchanged
      expect(res._body.total).toBe(247.85); // + $2.85 fee tax (2026-10-13)
      var snapshotArg = mocks.brewpad.detectRecipeSale.mock.calls[0][1];
      expect(snapshotArg.is_modified).toBe(false);
      expect(snapshotArg.modified_base_ingredients).toBeNull();
    });
  });

  test('M-C7. modified list that oversells stock returns 409 (scaled-stock gate uses modified quantities)', function () {
    // Modified list: add Centennial at 10kg (large qty). stock_on_hand=5 => 10*1=10 needed > 5 stock => conflict
    var largeQtyModified = [
      { item_id: 'ing-malt-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
      { item_id: 'ing-dry-hop-1', item_name: 'Centennial Hops (Dry Hop)', quantity: 10, unit: 'kg' },
      { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
    ];
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-001',
        transaction_id: 'txn-stock-mod',
        reference: 'RECIPE-STOCK-MOD',
        sale_type: 'in-store',
        modified_ingredients: largeQtyModified
      }
    }).then(function (res) {
      expect(res._status).toBe(409);
      expect(Array.isArray(res._body.conflicts)).toBe(true);
      var conflict = res._body.conflicts.find(function (c) { return c.item_id === 'ing-dry-hop-1'; });
      expect(conflict).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Unit conversion — sale/stock money path (73-03, D-01/D-02, AC-01/AC-03)
// ---------------------------------------------------------------------------
// The CRITICAL sale/stock sum-site: _runRecipeConfirm's invoice lineItems
// build + the kiosk quote's display line_total must both go through the
// shared scaling.ingredientLineCost helper so the Zoho invoice quantity
// (= real stock decrement) and the displayed quote total are unit-converted
// and match each other. A non-convertible line must refuse BEFORE any
// charge; if one somehow reaches post-charge confirm, the transaction is
// voided rather than silently mis-charged (D-02 tiered fail-closed).

describe('Unit conversion — sale/stock money path (73-03, D-01/D-02)', function () {
  var mocks;

  // Catalog: hop pellets priced per KG; a cross-family "bad unit" item (count
  // vs mass — non-convertible) used for the tiered fail-closed tests.
  // stock_on_hand is set generously above the raw (pre-conversion) scaled
  // quantity too — checkScaledStock compares needed-vs-stock in whatever unit
  // the recipe line carries (a separate, out-of-scope gap from this plan's
  // D-01/D-02 pricing/invoice-quantity fix), so a tight stock figure here
  // would spuriously 409 before we ever reach the code path under test.
  var CONVERSION_CATALOG = [
    { item_id: 'ing-hop-pellets', name: 'Hop Pellets', rate: 20.00, tax_id: 'tax-gst', stock_on_hand: 100, unit: 'kg' },
    { item_id: 'ing-badunit-1', name: 'Bad Unit Item', rate: 5.00, tax_id: 'tax-gst', stock_on_hand: 100, unit: 'kg' }
  ];

  // Dynamic recipe: single 12g line against a per-kg catalog item.
  // convertedQty = 12 * 0.001 = 0.012 kg; cost = 0.012 * 20.00 = 0.24
  var GRAM_RECIPE_RESPONSE = {
    data: {
      ok: true,
      data: {
        recipe: {
          recipe_id: 'RCP-GRAM',
          name: 'Gram-Line Recipe',
          batch_size_l: 20,
          locked_price: 0,
          service_fee: 45.00,
          materials_fee: 5.00,
          status: 'active',
          pricing_mode: 'dynamic'
        },
        ingredients: [
          { ingredient_id: 'ING-G1', recipe_id: 'RCP-GRAM', item_id: 'ing-hop-pellets', item_name: 'Hop Pellets', quantity: 12, unit: 'g' }
        ]
      }
    }
  };

  // Cross-family recipe: catalog item is 'kg' (mass), recipe line is 'pcs'
  // (count) — non-convertible.
  var CROSS_FAMILY_RECIPE_RESPONSE = {
    data: {
      ok: true,
      data: {
        recipe: {
          recipe_id: 'RCP-BADUNIT',
          name: 'Bad Unit Recipe',
          batch_size_l: 20,
          locked_price: 0,
          service_fee: 45.00,
          materials_fee: 5.00,
          status: 'active',
          pricing_mode: 'dynamic'
        },
        ingredients: [
          { ingredient_id: 'ING-B1', recipe_id: 'RCP-BADUNIT', item_id: 'ing-badunit-1', item_name: 'Bad Unit Item', quantity: 3, unit: 'pcs' }
        ]
      }
    }
  };

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
    mocks.helcim.terminalPurchase.mockResolvedValue({});
    mocks.helcim.voidTransaction.mockResolvedValue({});
    mocks.cache.acquireLock.mockResolvedValue(true);
    mocks.cache.releaseLock.mockResolvedValue();
    mocks.cache.del.mockResolvedValue(1);
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve(CONVERSION_CATALOG);
      if (key === 'zoho:ingredients') return Promise.resolve(CONVERSION_CATALOG);
      return Promise.resolve(null);
    });
    mocks.axios.post.mockResolvedValue(GRAM_RECIPE_RESPONSE);
    mocks.zohoApi.zohoPost.mockResolvedValue({ invoice: { invoice_id: 'inv-conv', invoice_number: 'INV-CONV' } });
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    delete process.env.BEER_SALES_ENABLED;
    delete process.env.MAKERS_FEE_ITEM_ID;
    delete process.env.MATERIALS_FEE_ITEM_ID;
    delete process.env.KIOSK_CONTACT_ID;
    delete process.env.MILLING_FEE_ITEM_ID;
  });

  test('U1. confirm invoice lineItems quantity is the CONVERTED qty (12g -> 0.012), not the raw scaled qty', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 53.09 });
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-conv', invoice_number: 'INV-CONV' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-GRAM',
        transaction_id: 'txn-conv',
        reference: 'RECIPE-CONV',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      var hopLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-hop-pellets'; });
      expect(hopLine).toBeTruthy();
      expect(hopLine.quantity).toBeCloseTo(0.012, 4);
      expect(hopLine.quantity).not.toBe(12);
    });
  });

  test('U2. quote total equals the summed invoice line totals the confirm/sale path builds (quote == sale, converted)', function () {
    // Recipe confirm captured-amount readback (2026-10-13): the capture equals
    // this test's recomputed total, so the booking proceeds as before.
    require('../lib/helcim').getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: 53.09 });
    var capturedInvoicePayload;
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-conv', invoice_number: 'INV-CONV' } });
    });
    var quoteTotal;
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-GRAM', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (quoteRes) {
      expect(quoteRes._status).toBe(200);
      quoteTotal = quoteRes._body.total;
      return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
        body: {
          recipe_id: 'RCP-GRAM',
          transaction_id: 'txn-conv-parity',
          reference: 'RECIPE-CONV-PARITY',
          sale_type: 'in-store'
        }
      });
    }).then(function (confirmRes) {
      expect(confirmRes._status).toBe(201);
      var lineItems = capturedInvoicePayload.line_items;
      var summedInvoiceTotal = lineItems.reduce(function (sum, li) {
        return sum + (Number(li.quantity) || 0) * (Number(li.rate) || 0);
      }, 0);
      summedInvoiceTotal = Math.round(summedInvoiceTotal * 100) / 100;
      expect(summedInvoiceTotal).toBe(quoteTotal);
      // dynamic: 0.012kg * 20.00/kg = 0.24; + fees 45 + 5 = 50.24
      expect(quoteTotal).toBe(50.24);
    });
  });

  test('U3. discount on a converted line caps/distributes proportionally to the CONVERTED line cost', function () {
    var capturedInvoicePayload;
    var presets = [{
      id: 'preset-full', active: true, name: 'Full Off', type: 'percentage', value: 100, scope: 'cart'
    }];
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve(CONVERSION_CATALOG);
      if (key === 'zoho:ingredients') return Promise.resolve(CONVERSION_CATALOG);
      if (key === 'kiosk:discount-presets') return Promise.resolve(presets);
      return Promise.resolve(null);
    });
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') capturedInvoicePayload = payload;
      return Promise.resolve({ invoice: { invoice_id: 'inv-conv', invoice_number: 'INV-CONV' } });
    });
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-GRAM',
        transaction_id: 'txn-conv-disc',
        reference: 'RECIPE-CONV-DISC',
        sale_type: 'in-store',
        discount: { preset_id: 'preset-full' }
      }
    }).then(function (res) {
      expect(res._status).toBe(201);
      // grandTotal before discount = 0.24 + 45 + 5 = 50.24; 100% off => total 0
      expect(res._body.total).toBe(0);
      var hopLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'ing-hop-pellets'; });
      expect(hopLine).toBeTruthy();
      // Discount distribution must be proportional to the CONVERTED line cost
      // (0.24), never the raw pre-conversion figure (12 * 20 = 240) which would
      // starve the fee lines of their fair share / blow the per-line cap.
      expect(hopLine.discount).toBeCloseTo(0.24, 2);
      var makersFeeLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'fee-makers-1'; });
      expect(makersFeeLine.discount).toBeCloseTo(45.00, 2);
      var materialsFeeLine = capturedInvoicePayload.line_items.find(function (li) { return li.item_id === 'fee-materials-1'; });
      expect(materialsFeeLine.discount).toBeCloseTo(5.00, 2);
    });
  });

  test('U4a. GET recipe-quote returns 422 naming the line for a cross-family (non-convertible) unit', function () {
    mocks.axios.post.mockResolvedValue(CROSS_FAMILY_RECIPE_RESPONSE);
    return callHandler('GET', '/api/kiosk/recipe-quote', {
      query: { recipe_id: 'RCP-BADUNIT', target_volume_l: '20', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Bad Unit Item');
      expect(res._body.error).toMatch(/not convertible/i);
    });
  });

  test('U4c. POST recipe-sale/confirm (post-charge safety net) voids the transaction instead of a bare 400', function () {
    mocks.axios.post.mockResolvedValue(CROSS_FAMILY_RECIPE_RESPONSE);
    return callHandler('POST', '/api/kiosk/recipe-sale/confirm', {
      body: {
        recipe_id: 'RCP-BADUNIT',
        transaction_id: 'txn-badunit',
        reference: 'RECIPE-BADUNIT',
        sale_type: 'in-store'
      }
    }).then(function (res) {
      expect(mocks.helcim.voidTransaction).toHaveBeenCalledWith('txn-badunit');
      expect(res._status).not.toBe(400);
      expect(res._status).toBe(502);
      expect(res._body.payment_voided).toBe(true);
      expect(mocks.cache.releaseLock).toHaveBeenCalledWith('recipe-sale');
    });
  });
});

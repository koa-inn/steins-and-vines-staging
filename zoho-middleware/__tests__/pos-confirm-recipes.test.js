'use strict';

/**
 * Phase 101-06: POST /api/kiosk/sale/confirm books recipe-bearing carts as ONE
 * Zoho invoice + ONE payment, re-pricing the whole cart server-side through
 * computeCartPricing. Every recipe failure after a charge voids the charge
 * (never a bare 4xx).
 */

var mockRouteHandlers = {};

jest.mock('../routes/catalog', function () {
  return { rebuildKioskCatalog: jest.fn(function () { return Promise.resolve(global.__rebuildCatalog || []); }) };
});

jest.mock('express', function () {
  var router = {
    get: jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post: jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
    put: jest.fn(function (path, handler) { mockRouteHandlers['PUT:' + path] = handler; }),
    delete: jest.fn(function (path, handler) { mockRouteHandlers['DELETE:' + path] = handler; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });

jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    isEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    initializeCheckout: jest.fn().mockResolvedValue({ checkoutToken: 'tok-1' }),
    pollTerminalResult: jest.fn(),
    getCardTransactionById: jest.fn(),
    voidTransaction: jest.fn().mockResolvedValue({ ok: true })
  };
});

jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
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
jest.mock('../lib/inventory-ledger', function () {
  return { decrementStock: jest.fn().mockResolvedValue({}), reconcileFromZoho: jest.fn() };
});
jest.mock('../lib/brewpad-integration', function () {
  return { createBatchesFromSale: jest.fn(), detectRecipeSale: jest.fn() };
});
jest.mock('../lib/gift-card-store', function () {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    lookup: jest.fn().mockResolvedValue({ ok: true, data: { current_balance: 500 } }),
    redeem: jest.fn().mockResolvedValue({ ok: true }),
    issue: jest.fn().mockResolvedValue({ ok: true }),
    reload: jest.fn().mockResolvedValue({ ok: true }),
    updateInvoice: jest.fn().mockResolvedValue({}),
    actorFromRequest: jest.fn().mockReturnValue('test')
  };
});
jest.mock('../lib/recipe-store', function () { return { get: jest.fn() }; });
jest.mock('../lib/money-path', function () {
  return {
    acquireIdempotencyLock: jest.fn().mockResolvedValue({ status: 'acquired' }),
    voidWithTimeout: jest.fn().mockImplementation(function (helcimLike, txnId) {
      return helcimLike.voidTransaction(txnId).then(function () {}).catch(function () {});
    }),
    CHECKOUT_IDEMPOTENCY_TTL: 600
  };
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

var fx = require('./fixtures/recipe-mixed-carts');

var ENV_KEYS = ['MAKERS_FEE_ITEM_ID', 'MATERIALS_FEE_ITEM_ID', 'MILLING_FEE_ITEM_ID', 'BEER_SALES_ENABLED',
  'KIOSK_CONTACT_ID', 'ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID', 'KIOSK_GIFT_CARD_ITEM_ID', 'NODE_ENV'];
var saved = {};
var cache, helcimLib, recipeStore, eventLog, zohoApi, moneyPath, ledger, pos, giftCardStore;
var ingredientStock;
var invoicePayloads;

var PRODUCTS = [
  { item_id: 'p-5', name: 'Snack', rate: 5, tax_percentage: 5, tax_id: 'tax-gst' },
  { item_id: 'p-12', name: 'Gadget', rate: 5, tax_percentage: 12, tax_id: 'tax-pst' }
];

function kioskCatalog() { return fx.KIOSK_FEE_CATALOG.concat(PRODUCTS); }

function ingredientCatalog() {
  return fx.MOCK_INGREDIENTS_CATALOG.map(function (p) {
    var c = Object.assign({}, p);
    if (ingredientStock && ingredientStock[p.item_id] !== undefined) c.stock_on_hand = ingredientStock[p.item_id];
    return c;
  });
}

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Tax per rate group (entity_level), derived independently from posted lines.
function deriveTax(lines) {
  var pctById = {};
  fx.MOCK_INGREDIENTS_CATALOG.forEach(function (e) { pctById[e.item_id] = e.tax_percentage || 0; });
  fx.KIOSK_FEE_CATALOG.forEach(function (e) { pctById[e.item_id] = e.tax_percentage; });
  PRODUCTS.forEach(function (e) { pctById[e.item_id] = e.tax_percentage; });
  var groups = {};
  lines.forEach(function (li) {
    var base = r2(li.quantity * li.rate);
    var disc = 0;
    if (typeof li.discount === 'string' && li.discount.indexOf('%') !== -1) {
      disc = r2(base * parseFloat(li.discount) / 100);
    } else {
      disc = Number(li.discount) || 0;
    }
    var amount = Math.max(r2(base - disc), 0);
    var pct = pctById[li.item_id] || 0;
    groups[pct] = (groups[pct] || 0) + amount * pct / 100;
  });
  var total = 0;
  Object.keys(groups).forEach(function (k) { total += r2(groups[k]); });
  return r2(total);
}

function echoTotal(payload) {
  var sum = payload.line_items.reduce(function (s, li) {
    var base = r2(li.quantity * li.rate);
    var disc = (typeof li.discount === 'string' && li.discount.indexOf('%') !== -1)
      ? r2(base * parseFloat(li.discount) / 100) : (Number(li.discount) || 0);
    return s + Math.max(r2(base - disc), 0);
  }, 0);
  return r2(sum + deriveTax(payload.line_items) + (payload.adjustment || 0));
}

function load() {
  jest.resetModules();
  Object.keys(mockRouteHandlers).forEach(function (k) { delete mockRouteHandlers[k]; });
  cache = require('../lib/cache');
  helcimLib = require('../lib/helcim');
  recipeStore = require('../lib/recipe-store');
  eventLog = require('../lib/eventLog');
  zohoApi = require('../lib/zoho-api');
  moneyPath = require('../lib/money-path');
  ledger = require('../lib/inventory-ledger');
  giftCardStore = require('../lib/gift-card-store');
  pos = require('../routes/pos');
  cache.get.mockImplementation(function (key) {
    if (key === 'test:kiosk-products') return Promise.resolve(kioskCatalog());
    if (key === 'zoho:ingredients:all') return Promise.resolve(ingredientCatalog());
    if (key === 'kiosk:discount-presets') return Promise.resolve(fx.DISCOUNT_PRESETS);
    return Promise.resolve(null);
  });
  recipeStore.get.mockImplementation(function (id) {
    return Promise.resolve(fx.MOCK_RECIPES[id] || { ok: false });
  });
  invoicePayloads = [];
  zohoApi.zohoPost.mockImplementation(function (path, payload) {
    if (path === '/invoices') {
      invoicePayloads.push(payload);
      return Promise.resolve({
        invoice: {
          invoice_id: 'inv-1', invoice_number: 'INV-001',
          total: echoTotal(payload), line_items: payload.line_items
        }
      });
    }
    return Promise.resolve({});
  });
  zohoApi.zohoPut.mockResolvedValue({});
}

function mockRes() {
  var finishHandlers = [];
  var r = { statusCode: 200, headersSent: false, locals: {} };
  r.status = jest.fn(function (c) { r.statusCode = c; return r; });
  r.json = jest.fn(function () {
    r.headersSent = true;
    finishHandlers.forEach(function (h) { h(); });
    return r;
  });
  r.on = jest.fn(function (evt, h) { if (evt === 'finish') finishHandlers.push(h); });
  return r;
}

function confirm(body) {
  var res = mockRes();
  return new Promise(function (resolve) {
    var origJson = res.json;
    res.json = jest.fn(function (b) {
      origJson(b);
      resolve({ code: res.statusCode, body: b, res: res });
      return res;
    });
    mockRouteHandlers['POST:/api/kiosk/sale/confirm']({ body: body, id: 'req-1' }, res);
  });
}

function flush() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function recipeEntry(recipeId, extra) {
  return Object.assign({ recipe_id: recipeId, sale_type: 'in-store' }, extra || {});
}

var CHARGE = fx.ORACLE.initiate['RCP-LOCKED/in-store/none'].charge;

function approveCharge(amount) {
  helcimLib.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: amount });
}

function paymentCalls() {
  return zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/customerpayments'; });
}
function invoiceCalls() {
  return zohoApi.zohoPost.mock.calls.filter(function (c) { return c[0] === '/invoices'; });
}

beforeEach(function () {
  ENV_KEYS.forEach(function (k) { saved[k] = process.env[k]; });
  process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
  process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
  process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.KIOSK_CONTACT_ID = 'contact-default';
  process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID = 'acct-gc';
  process.env.KIOSK_GIFT_CARD_ITEM_ID = 'gc-item';
  ingredientStock = null;
  global.__rebuildCatalog = kioskCatalog();
  load();
});

afterEach(function () {
  ENV_KEYS.forEach(function (k) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

// ---------------------------------------------------------------------------
// Task 1: re-pricing + tagged __recipeInvalid
// ---------------------------------------------------------------------------

describe('confirm re-prices a recipe-bearing cart server-side', function () {
  test('recipe-only confirm (no items[]) books and the payment equals the oracle charge', function () {
    approveCharge(CHARGE);
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-1', reference_number: 'REF-1'
    }).then(function (out) {
      expect(out.code).toBe(201);
      expect(out.body.total).toBe(CHARGE);
      expect(invoiceCalls()).toHaveLength(1);
      expect(paymentCalls()).toHaveLength(1);
      expect(paymentCalls()[0][1].amount).toBe(CHARGE);
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
    });
  });

  test('client prices in recipes[] are ignored (server prices)', function () {
    approveCharge(CHARGE);
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED', { price: 1, rate: 1, total: 1 })],
      transaction_id: 'txn-1', reference_number: 'REF-1', client_grand_total: 1
    }).then(function (out) {
      expect(out.code).toBe(201);
      expect(out.body.total).toBe(CHARGE);
    });
  });

  test('computeCartPricing is the pricing core (cart total = pricing grandTotal)', function () {
    var body = { recipes: [recipeEntry('RCP-LOCKED')], items: [] };
    var map = {};
    kioskCatalog().forEach(function (p) { map[p.item_id] = p; });
    return pos.computeCartPricing(body, map).then(function (p) {
      expect(p.grandTotal).toBe(CHARGE);
    });
  });
});

describe('recipe failures are tagged: void after a charge, plain 4xx otherwise', function () {
  test('recipe 404 WITH transaction_id voids the charge (no bare 404)', function () {
    return confirm({
      recipes: [recipeEntry('RCP-NOPE')], transaction_id: 'txn-404', reference_number: 'REF-404'
    }).then(function (out) {
      expect(out.code).not.toBe(404);
      expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
      expect(moneyPath.voidWithTimeout.mock.calls[0][1]).toBe('txn-404');
      expect(out.body.payment_voided).toBe(true);
      expect(invoiceCalls()).toHaveLength(0);
    });
  });

  test('recipe 404 WITHOUT transaction_id (cash) returns 404 and releases the confirm lock', function () {
    return confirm({
      tender: 'cash', recipes: [recipeEntry('RCP-NOPE')], reference_number: 'REF-404C'
    }).then(function (out) {
      expect(out.code).toBe(404);
      expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
      return flush().then(function () {
        expect(cache.releaseLock).toHaveBeenCalled();
      });
    });
  });

  test('BEER_SALES_ENABLED off at confirm WITH transaction_id voids', function () {
    delete process.env.BEER_SALES_ENABLED;
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-off', reference_number: 'REF-OFF'
    }).then(function (out) {
      expect(out.code).not.toBe(403);
      expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
      expect(out.body.payment_voided).toBe(true);
    });
  });

  test('BEER_SALES_ENABLED off at confirm WITHOUT transaction_id returns 403', function () {
    delete process.env.BEER_SALES_ENABLED;
    return confirm({ tender: 'cash', recipes: [recipeEntry('RCP-LOCKED')], reference_number: 'REF-OFF2' })
      .then(function (out) {
        expect(out.code).toBe(403);
        expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
      });
  });

  test('invalid recipes[] WITH transaction_id voids', function () {
    return confirm({
      recipes: [{ recipe_id: 'RCP-LOCKED', sale_type: 'bogus' }],
      transaction_id: 'txn-bad', reference_number: 'REF-BAD'
    }).then(function (out) {
      expect(out.code).not.toBe(400);
      expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
      expect(out.body.payment_voided).toBe(true);
    });
  });

  test('invalid recipes[] WITHOUT transaction_id returns 400', function () {
    return confirm({
      tender: 'cash', recipes: [{ recipe_id: 'RCP-LOCKED', sale_type: 'bogus' }], reference_number: 'REF-BAD2'
    }).then(function (out) {
      expect(out.code).toBe(400);
      expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
    });
  });

  test('ingredient catalog unavailable (503) WITH transaction_id voids', function () {
    cache.get.mockImplementation(function (key) {
      if (key === 'test:kiosk-products') return Promise.resolve(kioskCatalog());
      return Promise.resolve(null);
    });
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-503', reference_number: 'REF-503'
    }).then(function (out) {
      expect(out.code).not.toBe(503);
      expect(moneyPath.voidWithTimeout).toHaveBeenCalled();
    });
  });
});

describe('short stock at confirm never blocks', function () {
  test('short ingredient stock books anyway and logs kiosk.confirm_stock_short', function () {
    ingredientStock = { 'ing-grain-1': 1 };
    approveCharge(CHARGE);
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-s', reference_number: 'REF-S'
    }).then(function (out) {
      expect(out.code).toBe(201);
      var evt = eventLog.logEvent.mock.calls.filter(function (c) { return c[0] === 'kiosk.confirm_stock_short'; });
      expect(evt).toHaveLength(1);
      expect(evt[0][1].recipes_short).toBe(1);
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
    });
  });
});

describe('product-only confirm is unchanged', function () {
  test('items-only body still books with its product lines and ledger decrement', function () {
    var expected = r2(5 + 0.25);
    approveCharge(expected);
    return confirm({
      items: [{ item_id: 'p-5', quantity: 1 }], transaction_id: 'txn-p', reference_number: 'REF-P'
    }).then(function (out) {
      expect(out.code).toBe(201);
      expect(out.body.total).toBe(expected);
      expect(invoicePayloads[0].line_items).toHaveLength(1);
      expect(invoicePayloads[0].adjustment).toBeUndefined();
      expect(ledger.decrementStock).toHaveBeenCalledTimes(1);
    });
  });

  test('empty cart without recipes is still 400', function () {
    return confirm({ items: [] }).then(function (out) {
      expect(out.code).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2: one invoice — line order, notes, numeric discounts, adjustment, reconcile
// ---------------------------------------------------------------------------

var MODES = {
  'in-store': { sale_type: 'in-store', mill_grain: false },
  'take-out': { sale_type: 'take-out', mill_grain: false },
  'take-out-mill': { sale_type: 'take-out', mill_grain: true }
};
var MODIFIED = {
  'RCP-LOCKED': [
    { item_id: 'ing-grain-1', item_name: 'Pale Malt 2-Row', quantity: 5.5, unit: 'kg' },
    { item_id: 'ing-hop-1', item_name: 'Cascade Hops', quantity: 150, unit: 'g' },
    { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 1, unit: 'pcs' }
  ],
  'RCP-DYN': [
    { item_id: 'ing-grain-1', item_name: 'Pale Malt 2-Row', quantity: 6, unit: 'kg' },
    { item_id: 'ing-hop-1', item_name: 'Cascade Hops', quantity: 80, unit: 'g' },
    { item_id: 'ing-yeast-1', item_name: 'US-05 Yeast', quantity: 2, unit: 'pcs' }
  ]
};

describe('recipe-only confirm posts the Plan 01 oracle invoice', function () {
  Object.keys(fx.ORACLE.confirm).forEach(function (key, i) {
    test('ORACLE.confirm ' + key, function () {
      var parts = key.split('/');
      var mode = MODES[parts[1]];
      var entry = recipeEntry(parts[0], { sale_type: mode.sale_type, mill_grain: mode.mill_grain });
      if (parts[3] === 'scale2x') entry.target_volume_l = 46;
      if (parts[3] === 'modified') entry.modified_ingredients = MODIFIED[parts[0]];
      var body = { recipes: [entry], transaction_id: 'txn-or-' + i, reference_number: 'REF-OR-' + i };
      if (fx.DISCOUNT_KEYS[parts[2]]) body.discount = { preset_id: fx.DISCOUNT_KEYS[parts[2]] };
      var charge = fx.ORACLE.initiate[key].charge;
      approveCharge(charge);
      return confirm(body).then(function (out) {
        expect(out.code).toBe(201);
        expect(zohoApi.zohoPut).not.toHaveBeenCalled();
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
        var payload = invoicePayloads[0];
        var payCall = paymentCalls()[0];
        expect({
          line_items: payload.line_items.map(function (li) {
            return { item_id: li.item_id, quantity: li.quantity, rate: li.rate, discount: li.discount, tax_id: li.tax_id };
          }),
          adjustment: payload.adjustment,
          adjustment_description: payload.adjustment_description,
          tax: deriveTax(payload.line_items),
          payment_amount: payCall[1].amount
        }).toEqual(fx.ORACLE.confirm[key]);
        expect(payCall[1].amount).toBe(charge);
      });
    });
  });
});

describe('mixed carts book ONE invoice and ONE payment', function () {
  function mixedBody(extra) {
    return Object.assign({
      items: [
        { item_id: 'p-5', quantity: 1 },
        { gift_cert: true, gift_action: 'issue', cert_number: 'GC-000042', rate: 25 }
      ],
      recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-DYN')],
      transaction_id: 'txn-mix', reference_number: 'REF-MIX'
    }, extra || {});
  }

  function priceMixed(body) {
    var map = {};
    kioskCatalog().forEach(function (p) { map[p.item_id] = p; });
    var copy = JSON.parse(JSON.stringify(body));
    return pos.computeCartPricing(copy, map);
  }

  test('line order: non-recipe lines, then recipe 1 lines, then recipe 2 lines; notes list the recipes', function () {
    var body = mixedBody();
    return priceMixed(body).then(function (p) {
      approveCharge(p.grandTotal);
      return confirm(body).then(function (out) {
        expect(out.code).toBe(201);
        expect(invoiceCalls()).toHaveLength(1);
        expect(paymentCalls()).toHaveLength(1);
        var items = invoicePayloads[0].line_items.map(function (li) { return li.item_id; });
        expect(items.slice(0, 2)).toEqual(['p-5', 'gc-item']);
        var rest = items.slice(2);
        var rec1 = p.recipe.sections[0].lines.map(function (li) { return li.item_id; });
        var rec2 = p.recipe.sections[1].lines.map(function (li) { return li.item_id; });
        expect(rest).toEqual(rec1.concat(rec2));
        expect(invoicePayloads[0].notes).toContain('Recipes: ');
        expect(invoicePayloads[0].notes).toContain('Locked Pale Ale');
        expect(invoicePayloads[0].notes).toContain('Dynamic Amber');
        // gift_cert tracking fields never reach Zoho
        expect(invoicePayloads[0].line_items[1]).toEqual({ item_id: 'gc-item', name: 'Gift Certificate GC-000042', quantity: 1, rate: 25 });
        expect(giftCardStore.issue).toHaveBeenCalledTimes(1);
      });
    });
  });

  test('ledger decrement sees only the non-recipe lines', function () {
    var body = mixedBody();
    return priceMixed(body).then(function (p) {
      approveCharge(p.grandTotal);
      return confirm(body).then(function () {
        var lines = ledger.decrementStock.mock.calls[0][0];
        expect(lines.map(function (l) { return l.item_id; })).toEqual(['p-5', 'gc-item']);
        var batch = require('../lib/brewpad-integration').createBatchesFromSale.mock.calls[0][0];
        expect(batch.map(function (l) { return l.item_id; })).toEqual(['p-5', 'gc-item']);
      });
    });
  });

  test('two locked recipes sum their adjustments into one invoice adjustment', function () {
    var single = fx.ORACLE.confirm['RCP-LOCKED/in-store/none'].adjustment;
    var body = { recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED')], transaction_id: 'txn-2', reference_number: 'REF-2' };
    return priceMixed(body).then(function (p) {
      approveCharge(p.grandTotal);
      return confirm(body).then(function (out) {
        expect(out.code).toBe(201);
        expect(invoicePayloads[0].adjustment).toBe(r2(single * 2));
        expect(invoicePayloads[0].adjustment_description).toBe('Recipe package price');
        expect(invoicePayloads[0].notes).toContain('Locked Pale Ale #1');
        expect(invoicePayloads[0].notes).toContain('Locked Pale Ale #2');
      });
    });
  });

  test('a product percentage discount in a recipe-bearing sale is posted as a number', function () {
    var body = {
      items: [{ item_id: 'p-5', quantity: 1 }], recipes: [recipeEntry('RCP-LOCKED')],
      discount: { preset_id: fx.DISCOUNT_KEYS['cart-pct'] }, transaction_id: 'txn-d', reference_number: 'REF-D'
    };
    return priceMixed(body).then(function (p) {
      approveCharge(p.grandTotal);
      return confirm(body).then(function (out) {
        expect(out.code).toBe(201);
        var productLine = invoicePayloads[0].line_items[0];
        expect(productLine.item_id).toBe('p-5');
        expect(productLine.discount).toBe(0.5);
        expect(typeof productLine.discount).toBe('number');
        expect(zohoApi.zohoPut).not.toHaveBeenCalled();
      });
    });
  });

  test('a product-only sale still posts the percentage string', function () {
    approveCharge(4.73);
    return confirm({
      items: [{ item_id: 'p-5', quantity: 1 }], discount: { preset_id: fx.DISCOUNT_KEYS['cart-pct'] },
      transaction_id: 'txn-po', reference_number: 'REF-PO'
    }).then(function (out) {
      expect(out.code).toBe(201);
      expect(invoicePayloads[0].line_items[0].discount).toBe('10%');
    });
  });
});

describe('reconcile after create', function () {
  test('Zoho echoing a total 0.01 off re-balances via PUT and the sale books', function () {
    approveCharge(CHARGE);
    var base = zohoApi.zohoPost.getMockImplementation();
    zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') {
        return base(path, payload).then(function (d) { d.invoice.total = r2(d.invoice.total + 0.01); return d; });
      }
      return base(path, payload);
    });
    zohoApi.zohoPut.mockResolvedValue({ invoice: { total: CHARGE } });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-r1', reference_number: 'REF-R1' })
      .then(function (out) {
        expect(out.code).toBe(201);
        expect(zohoApi.zohoPut).toHaveBeenCalledTimes(1);
        expect(zohoApi.zohoPut.mock.calls[0][0]).toBe('/invoices/inv-1');
        expect(zohoApi.zohoPut.mock.calls[0][1].adjustment).toBe(r2(162.75 - 0.01));
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      });
  });

  test('Zoho echoing a total 2.00 off rejects and voids the whole terminal transaction', function () {
    approveCharge(CHARGE);
    var base = zohoApi.zohoPost.getMockImplementation();
    zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') {
        return base(path, payload).then(function (d) { d.invoice.total = r2(d.invoice.total + 2); return d; });
      }
      return base(path, payload);
    });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-r2', reference_number: 'REF-R2' })
      .then(function (out) {
        expect(out.code).toBe(502);
        expect(out.body.payment_voided).toBe(true);
        expect(moneyPath.voidWithTimeout).toHaveBeenCalledTimes(1);
        expect(moneyPath.voidWithTimeout.mock.calls[0][1]).toBe('txn-r2');
        expect(paymentCalls()).toHaveLength(0);
      });
  });
});

// ---------------------------------------------------------------------------
// Task 3: money-path parity per tender (verify, void, replay, sentinel)
// ---------------------------------------------------------------------------

describe('terminal tender verification', function () {
  test('captured amount != recipe-bearing grandTotal -> 402, void, nothing booked', function () {
    approveCharge(CHARGE - 5);
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-cap', reference_number: 'REF-CAP' })
      .then(function (out) {
        expect(out.code).toBe(402);
        expect(out.body.payment_voided).toBe(true);
        expect(moneyPath.voidWithTimeout).toHaveBeenCalledTimes(1);
        expect(moneyPath.voidWithTimeout.mock.calls[0][1]).toBe('txn-cap');
        expect(invoiceCalls()).toHaveLength(0);
      });
  });

  test('manual-confirm that cannot be verified -> 409 and nothing booked or voided', function () {
    helcimLib.pollTerminalResult.mockResolvedValue({ approved: false, status: 'PENDING' });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], reference_number: 'REF-MV' }).then(function (out) {
      expect(out.code).toBe(409);
      expect(invoiceCalls()).toHaveLength(0);
      expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
    });
  });

  test('manual-confirm declined -> 400 and nothing booked', function () {
    helcimLib.pollTerminalResult.mockResolvedValue({ approved: false, status: 'DECLINED' });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'manual-confirm', reference_number: 'REF-MD' })
      .then(function (out) {
        expect(out.code).toBe(400);
        expect(invoiceCalls()).toHaveLength(0);
        expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
      });
  });

  test('manual-confirm approved resolves the real txn id onto the payment', function () {
    helcimLib.pollTerminalResult.mockResolvedValue({ approved: true, transactionId: 'real-77' });
    approveCharge(CHARGE);
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], reference_number: 'REF-MA' }).then(function (out) {
      expect(out.code).toBe(201);
      expect(paymentCalls()[0][1].reference_number).toBe('real-77');
      expect(paymentCalls()[0][1].payment_mode).toBe('creditcard');
    });
  });
});

describe('moto tender', function () {
  test('APPROVED transaction with amount == terminalApplied books a creditcard payment', function () {
    approveCharge(CHARGE);
    return confirm({ tender: 'moto', recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-m1', reference_number: 'REF-M1' })
      .then(function (out) {
        expect(out.code).toBe(201);
        expect(paymentCalls()[0][1].amount).toBe(CHARGE);
        expect(paymentCalls()[0][1].notes).toContain('card-not-present');
      });
  });

  test('MOTO amount mismatch is rejected and the charge voided', function () {
    approveCharge(CHARGE + 3);
    return confirm({ tender: 'moto', recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-m2', reference_number: 'REF-M2' })
      .then(function (out) {
        expect(out.code).toBe(502);
        expect(out.body.payment_voided).toBe(true);
        expect(moneyPath.voidWithTimeout.mock.calls[0][1]).toBe('txn-m2');
        expect(invoiceCalls()).toHaveLength(0);
      });
  });
});

describe('cash tender', function () {
  test('books a cash customerpayment and never touches Helcim', function () {
    return confirm({ tender: 'cash', recipes: [recipeEntry('RCP-LOCKED')], reference_number: 'REF-CASH' })
      .then(function (out) {
        expect(out.code).toBe(201);
        var pay = paymentCalls()[0][1];
        expect(pay.payment_mode).toBe('cash');
        expect(pay.amount).toBe(CHARGE);
        expect(pay.reference_number).toBe('REF-CASH');
        expect(helcimLib.pollTerminalResult).not.toHaveBeenCalled();
        expect(helcimLib.getCardTransactionById).not.toHaveBeenCalled();
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      });
  });

  test('invoice create failure shows the error, books no payment, and calls no void (D-10)', function () {
    zohoApi.zohoPost.mockImplementation(function (path) {
      if (path === '/invoices') return Promise.reject(new Error('zoho down'));
      return Promise.resolve({});
    });
    return confirm({ tender: 'cash', recipes: [recipeEntry('RCP-LOCKED')], reference_number: 'REF-CF' })
      .then(function (out) {
        expect(out.code).toBe(502);
        expect(paymentCalls()).toHaveLength(0);
        expect(moneyPath.voidWithTimeout).not.toHaveBeenCalled();
        expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
      });
  });
});

describe('gift card split with a recipe', function () {
  test('posts the creditcard leg and the gift-card others leg, redeeming last', function () {
    var gift = 20;
    approveCharge(r2(CHARGE - gift));
    return confirm({
      recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-gc', reference_number: 'REF-GC',
      gift_card: { cert_number: 'GC-000001', amount_applied: gift }
    }).then(function (out) {
      expect(out.code).toBe(201);
      var pays = paymentCalls().map(function (c) { return c[1]; });
      expect(pays).toHaveLength(2);
      expect(pays[0].payment_mode).toBe('creditcard');
      expect(pays[0].amount).toBe(r2(CHARGE - gift));
      expect(pays[1].payment_mode).toBe('others');
      expect(pays[1].amount).toBe(gift);
      expect(giftCardStore.redeem).toHaveBeenCalledTimes(1);
      var lastPayOrder = zohoApi.zohoPost.mock.invocationCallOrder[zohoApi.zohoPost.mock.calls.length - 1];
      expect(giftCardStore.redeem.mock.invocationCallOrder[0]).toBeGreaterThan(lastPayOrder);
    });
  });
});

describe('failure after a charge voids the whole payment', function () {
  test('customerpayments failure voids the full charge and reports payment_voided (D-21)', function () {
    approveCharge(CHARGE);
    var base = zohoApi.zohoPost.getMockImplementation();
    zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/customerpayments') return Promise.reject(new Error('payment rejected'));
      return base(path, payload);
    });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-pf', reference_number: 'REF-PF' })
      .then(function (out) {
        expect(out.code).toBe(502);
        expect(out.body.payment_voided).toBe(true);
        expect(out.body.voided_transaction_id).toBe('txn-pf');
        expect(moneyPath.voidWithTimeout).toHaveBeenCalledTimes(1);
      });
  });

  test('a failed void reports needs_manual_review and keeps the confirm lock', function () {
    approveCharge(CHARGE);
    helcimLib.voidTransaction.mockRejectedValue(new Error('void failed'));
    moneyPath.voidWithTimeout.mockImplementation(function (h, id) {
      return h.voidTransaction(id).catch(function () {});
    });
    var base = zohoApi.zohoPost.getMockImplementation();
    zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/customerpayments') return Promise.reject(new Error('payment rejected'));
      return base(path, payload);
    });
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-vf', reference_number: 'REF-VF' })
      .then(function (out) {
        expect(out.code).toBe(502);
        expect(out.body.payment_voided).toBe(false);
        expect(out.body.needs_manual_review).toBe(true);
        expect(out.res.locals.__keepIdemLock).toBe(true);
        return flush().then(function () {
          expect(cache.releaseLock).not.toHaveBeenCalled();
        });
      });
  });
});

describe('idempotency and the pending-charge sentinel', function () {
  test('a second confirm with the same key replays the cached 201 without booking again', function () {
    approveCharge(CHARGE);
    var cached = null;
    cache.set.mockImplementation(function (key, value) {
      if (key.indexOf('confirm:') !== -1) cached = value;
      return Promise.resolve('OK');
    });
    var body = { recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-id', reference_number: 'REF-ID', idempotency_key: 'idem-1' };
    return confirm(body).then(function (first) {
      expect(first.code).toBe(201);
      expect(cached).not.toBe(null);
      var postsAfterFirst = zohoApi.zohoPost.mock.calls.length;
      moneyPath.acquireIdempotencyLock.mockResolvedValue({ status: 'replay', cached: cached });
      return confirm(body).then(function (second) {
        expect(second.code).toBe(201);
        expect(second.body.invoice_number).toBe('INV-001');
        expect(zohoApi.zohoPost.mock.calls.length).toBe(postsAfterFirst);
      });
    });
  });

  test('the pending-charge sentinel is deleted after a successful recipe-bearing confirm', function () {
    approveCharge(CHARGE);
    return confirm({ recipes: [recipeEntry('RCP-LOCKED')], transaction_id: 'txn-sn', reference_number: 'REF-SN' })
      .then(function (out) {
        expect(out.code).toBe(201);
        expect(cache.del).toHaveBeenCalledWith('kiosk:pending-charge:REF-SN');
      });
  });
});

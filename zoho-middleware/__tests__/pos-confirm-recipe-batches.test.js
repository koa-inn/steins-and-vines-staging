'use strict';

/**
 * Phase 101-07: after a recipe-bearing /api/kiosk/sale/confirm, one BrewPad batch
 * is created per IN-STORE recipe entry (unit_total = in-store count of that recipe),
 * non-recipe lines alone reach createBatchesFromSale / the ledger, recipe sales bust
 * the ingredient caches, and the 201 carries recipes[] for the receipt.
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
var cache, helcimLib, recipeStore, eventLog, zohoApi, moneyPath, ledger, pos, giftCardStore, brewpad;
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
  brewpad = require('../lib/brewpad-integration');
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


function priceOf(body) {
  var map = {};
  kioskCatalog().forEach(function (p) { map[p.item_id] = p; });
  return pos.computeCartPricing(JSON.parse(JSON.stringify(body)), map).then(function (p) { return p.grandTotal; });
}

function confirmOk(body) {
  return priceOf(body).then(function (total) {
    approveCharge(total);
    // The harness's independent invoice-total echo is not under test here: the Zoho
    // invoice simply reports the charged amount so confirm books normally.
    zohoApi.zohoPost.mockImplementation(function (path) {
      if (path === '/invoices') {
        return Promise.resolve({ invoice: { invoice_id: 'inv-1', invoice_number: 'INV-001', total: total } });
      }
      return Promise.resolve({});
    });
    return confirm(Object.assign({ transaction_id: 'txn-1', reference_number: 'REF-1' }, body));
  }).then(function (out) {
    expect(out.code).toBe(201);
    return flush().then(function () { return out; });
  });
}

function recipeItemIds() {
  var ids = fx.MOCK_INGREDIENTS_CATALOG.map(function (e) { return e.item_id; });
  return ids.concat([fx.FEE_IDS.makers, fx.FEE_IDS.materials, fx.FEE_IDS.milling]);
}

describe('recipe batches after confirm', function () {
  test('kit product + in-store recipe: createBatchesFromSale gets only the product lines, one recipe batch', function () {
    return confirmOk({ items: [{ item_id: 'p-5', quantity: 1 }], recipes: [recipeEntry('RCP-LOCKED')] }).then(function () {
      expect(brewpad.createBatchesFromSale).toHaveBeenCalledTimes(1);
      var lineItems = brewpad.createBatchesFromSale.mock.calls[0][0];
      expect(lineItems.map(function (l) { return l.item_id; })).toEqual(['p-5']);
      lineItems.forEach(function (l) { expect(recipeItemIds()).not.toContain(l.item_id); });
      expect(brewpad.detectRecipeSale).toHaveBeenCalledTimes(1);
      expect(brewpad.detectRecipeSale.mock.calls[0][0]).toBe('RCP-LOCKED');
    });
  });

  test('ledger.decrementStock receives non-recipe lines only', function () {
    return confirmOk({ items: [{ item_id: 'p-5', quantity: 2 }], recipes: [recipeEntry('RCP-LOCKED')] }).then(function () {
      expect(ledger.decrementStock).toHaveBeenCalledTimes(1);
      var lines = ledger.decrementStock.mock.calls[0][0];
      expect(lines.map(function (l) { return l.item_id; })).toEqual(['p-5']);
    });
  });

  test('two in-store entries of one recipe: two calls, each with unit_total 2', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED')] }).then(function () {
      expect(brewpad.detectRecipeSale).toHaveBeenCalledTimes(2);
      brewpad.detectRecipeSale.mock.calls.forEach(function (c) {
        expect(c[6]).toEqual({ unit_total: 2 });
      });
    });
  });

  test('one in-store + one take-out of the same recipe: one call, no unit_total', function () {
    return confirmOk({
      recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED', { sale_type: 'take-out' })]
    }).then(function () {
      expect(brewpad.detectRecipeSale).toHaveBeenCalledTimes(1);
      expect(brewpad.detectRecipeSale.mock.calls[0][6]).toBeUndefined();
    });
  });

  test('take-out only: no recipe batch', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED', { sale_type: 'take-out' })] }).then(function () {
      expect(brewpad.detectRecipeSale).not.toHaveBeenCalled();
    });
  });

  test('snapshot carries scaled ingredients, volume and invoice number', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED')], customer_name: 'Pat' }).then(function () {
      var c = brewpad.detectRecipeSale.mock.calls[0];
      expect(c[1].name).toBeTruthy();
      expect(Array.isArray(c[1].ingredients)).toBe(true);
      expect(c[1].ingredients.length).toBeGreaterThan(0);
      expect(c[1].is_modified).toBe(false);
      expect(c[2]).toBe('INV-001');
      expect(c[3]).toBe('Pat');
    });
  });

  test('valid customer_email is trimmed and reaches the recipe batch only', function () {
    return confirmOk({
      items: [{ item_id: 'p-5', quantity: 1 }], recipes: [recipeEntry('RCP-LOCKED')], customer_email: ' A@B.co '
    }).then(function () {
      expect(brewpad.detectRecipeSale.mock.calls[0][5]).toBe('A@B.co');
      // Kit batches keep today's argument list (no email).
      expect(brewpad.createBatchesFromSale.mock.calls[0]).toHaveLength(6);
    });
  });

  test('invalid customer_email is omitted', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED')], customer_email: 'not-an-email' }).then(function () {
      expect(brewpad.detectRecipeSale.mock.calls[0][5]).toBe('');
    });
  });

  test('a rejected detectRecipeSale never fails the sale', function () {
    brewpad.detectRecipeSale.mockReturnValue(Promise.reject(new Error('boom')));
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function (out) {
      expect(out.code).toBe(201);
    });
  });
});

describe('cache busting and receipt shape', function () {
  function deleted() { return cache.del.mock.calls.map(function (c) { return c[0]; }); }

  test('recipe sale busts products, ingredients, ingredients-all and recipes ts', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED')] }).then(function () {
      ['test:kiosk-products', 'zoho:ingredients', 'zoho:ingredients:all', 'sv:recipes:ts'].forEach(function (k) {
        expect(deleted()).toContain(k);
      });
    });
  });

  test('product-only sale busts only the kiosk products cache', function () {
    return confirmOk({ items: [{ item_id: 'p-5', quantity: 1 }] }).then(function () {
      expect(deleted()).toContain('test:kiosk-products');
      expect(deleted()).not.toContain('zoho:ingredients');
      expect(deleted()).not.toContain('zoho:ingredients:all');
      expect(deleted()).not.toContain('sv:recipes:ts');
    });
  });

  test('201 result.recipes lists one item per entry with numbered duplicate labels', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED', { sale_type: 'take-out' })] }).then(function (out) {
      expect(out.body.recipes).toHaveLength(2);
      expect(out.body.recipes[0].label).toMatch(/ #1$/);
      expect(out.body.recipes[1].label).toMatch(/ #2$/);
      expect(out.body.recipes[0].sale_type).toBe('in-store');
      expect(out.body.recipes[1].sale_type).toBe('take-out');
      expect(typeof out.body.recipes[0].total).toBe('number');
      expect(out.body.recipes[0]).toHaveProperty('target_volume_l');
      expect(out.body.recipes[0]).toHaveProperty('mill_grain');
    });
  });

  test('product-only 201 has no recipes key', function () {
    return confirmOk({ items: [{ item_id: 'p-5', quantity: 1 }] }).then(function (out) {
      expect(out.body.recipes).toBeUndefined();
    });
  });

  test('kiosk.sale_completed gains has_recipes and recipe_count', function () {
    return confirmOk({ recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED')] }).then(function () {
      var ev = eventLog.logEvent.mock.calls.filter(function (c) { return c[0] === 'kiosk.sale_completed'; })[0][1];
      expect(ev.has_recipes).toBe(true);
      expect(ev.recipe_count).toBe(2);
    });
  });

  test('product-only sale_completed event is unchanged', function () {
    return confirmOk({ items: [{ item_id: 'p-5', quantity: 1 }] }).then(function () {
      var ev = eventLog.logEvent.mock.calls.filter(function (c) { return c[0] === 'kiosk.sale_completed'; })[0][1];
      expect(ev.has_recipes).toBeUndefined();
    });
  });
});

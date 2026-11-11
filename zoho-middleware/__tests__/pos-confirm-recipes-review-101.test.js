'use strict';

/**
 * Phase 101 pre-production review fixes on POST /api/kiosk/sale/confirm
 * (101-REVIEW.md). Harness copied from __tests__/pos-confirm-recipes.test.js.
 *
 * HI-01: the reconcile PUT must keep the text of custom / canning-bundle lines.
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

// Zoho echoes created lines with its own ids; a line without a backing item
// comes back with an empty item_id / name and keeps its text in description.
function zohoEcho(payload, total) {
  return {
    invoice: {
      invoice_id: 'inv-1', invoice_number: 'INV-001',
      total: total,
      line_items: payload.line_items.map(function (li, i) {
        return {
          line_item_id: 'li-' + (i + 1),
          item_id: li.item_id || '',
          name: li.name || '',
          description: li.description || '',
          quantity: li.quantity,
          rate: li.rate,
          discount: li.discount || 0,
          tax_id: li.tax_id || ''
        };
      })
    }
  };
}

// ---------------------------------------------------------------------------
// HI-01: reconcile PUT keeps custom-line descriptions
// ---------------------------------------------------------------------------

describe('HI-01: re-balance PUT on a mixed invoice keeps custom line text', function () {
  var savedGst;
  beforeEach(function () { savedGst = process.env.KIOSK_GST_TAX_ID; process.env.KIOSK_GST_TAX_ID = 'tax-gst'; });
  afterEach(function () {
    if (savedGst === undefined) delete process.env.KIOSK_GST_TAX_ID; else process.env.KIOSK_GST_TAX_ID = savedGst;
  });

  function body() {
    return {
      items: [
        { custom: true, description: 'Bottle rental', note: '', quantity: 1, rate: 5, taxable: true }
      ],
      recipes: [recipeEntry('RCP-LOCKED')],
      transaction_id: 'txn-h1', reference_number: 'REF-H1'
    };
  }

  test('a 0.01 gap re-sends the custom line with its description and no empty item_id/name', function () {
    var map = {};
    kioskCatalog().forEach(function (p) { map[p.item_id] = p; });
    return pos.computeCartPricing(JSON.parse(JSON.stringify(body())), map).then(function (p) {
      approveCharge(p.grandTotal);
      zohoApi.zohoPost.mockImplementation(function (path, payload) {
        if (path === '/invoices') return Promise.resolve(zohoEcho(payload, r2(p.grandTotal + 0.01)));
        return Promise.resolve({});
      });
      zohoApi.zohoPut.mockResolvedValue({ invoice: { total: p.grandTotal } });
      return confirm(body());
    }).then(function (out) {
      expect(out.code).toBe(201);
      expect(zohoApi.zohoPut).toHaveBeenCalledTimes(1);
      var putLines = zohoApi.zohoPut.mock.calls[0][1].line_items;
      var custom = putLines[0];
      expect(custom.line_item_id).toBe('li-1');
      expect(custom.description).toBe('Bottle rental');
      expect(custom).not.toHaveProperty('item_id');
      expect(custom).not.toHaveProperty('name');
      // Item-backed lines still carry their identity and tax.
      putLines.slice(1).forEach(function (li) {
        expect(li.item_id).toBeTruthy();
        expect(li.name).toBeTruthy();
      });
      expect(helcimLib.voidTransaction).not.toHaveBeenCalled();
    });
  });
});

'use strict';

// ---------------------------------------------------------------------------
// pos-recipe-characterization.test.js — Phase 101-01 (MIXR-02, D-20)
//
// Phase 101 oracle (D-20). Later plans assert the merged /api/kiosk/sale path
// produces these exact values. Do not regenerate these literals from new code.
//
// Pins what the legacy recipe route charges (POST /api/kiosk/recipe-sale) and
// books (POST /api/kiosk/recipe-sale/confirm) for a recipe-only cart. Expected
// values are literals in fixtures/recipe-mixed-carts.js ORACLE. Test names
// carry the caseKey so later plans can reference them.
//
// Run alone: cd zoho-middleware && npx jest pos-recipe-characterization
// ---------------------------------------------------------------------------

var fx = require('./fixtures/recipe-mixed-carts');

var mockRouteHandlers = {};

jest.mock('../routes/catalog', function () {
  return {
    rebuildKioskCatalog: jest.fn(function () {
      return Promise.resolve(require('./fixtures/recipe-mixed-carts').KIOSK_FEE_CATALOG);
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

jest.mock('../lib/recipe-store', function () {
  return {
    getMode: jest.fn(function () { return 'sheets'; }),
    get: jest.fn(function (id) {
      var all = require('./fixtures/recipe-mixed-carts').MOCK_RECIPES;
      return Promise.resolve(JSON.parse(JSON.stringify(all[id] || { ok: false })));
    })
  };
});

jest.mock('../lib/helcim', function () {
  return {
    getCardTransactionById: jest.fn(),
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    voidTransaction: jest.fn().mockResolvedValue({}),
    pollTerminalResult: jest.fn()
  };
});

jest.mock('../lib/zoho-api', function () {
  return {
    zohoGet: jest.fn(),
    zohoPost: jest.fn(),
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
// Case matrix
// ---------------------------------------------------------------------------

var RECIPES = ['RCP-LOCKED', 'RCP-DYN'];
var MODES = {
  'in-store': { sale_type: 'in-store', mill_grain: false },
  'take-out': { sale_type: 'take-out', mill_grain: false },
  'take-out-mill': { sale_type: 'take-out', mill_grain: true }
};
var DISCOUNTS = Object.keys(fx.DISCOUNT_KEYS);

// Hop quantity swapped 100 g -> 150 g / 50 g -> 80 g (modified base list).
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

var CASES = [];
RECIPES.forEach(function (rid) {
  Object.keys(MODES).forEach(function (mode) {
    DISCOUNTS.forEach(function (disc) {
      CASES.push({ key: rid + '/' + mode + '/' + disc, recipe: rid, mode: mode, disc: disc });
    });
  });
  CASES.push({ key: rid + '/in-store/none/scale2x', recipe: rid, mode: 'in-store', disc: 'none', target: 46 });
  CASES.push({ key: rid + '/take-out-mill/cart-pct/scale2x', recipe: rid, mode: 'take-out-mill', disc: 'cart-pct', target: 46 });
  CASES.push({ key: rid + '/in-store/none/modified', recipe: rid, mode: 'in-store', disc: 'none', modified: true });
  CASES.push({ key: rid + '/take-out/type-recipe/modified', recipe: rid, mode: 'take-out', disc: 'type-recipe', modified: true });
});

function buildBody(c, extra) {
  var m = MODES[c.mode];
  var body = {
    recipe_id: c.recipe,
    sale_type: m.sale_type,
    mill_grain: m.mill_grain
  };
  if (c.target) body.target_volume_l = c.target;
  if (c.modified) body.modified_ingredients = MODIFIED[c.recipe];
  if (fx.DISCOUNT_KEYS[c.disc]) body.discount = { preset_id: fx.DISCOUNT_KEYS[c.disc] };
  return Object.assign(body, extra || {});
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function resetAndLoadPosRecipe() {
  mockRouteHandlers = {};
  jest.resetModules();
  require('../routes/pos-recipe');
  return {
    cache: require('../lib/cache'),
    helcim: require('../lib/helcim'),
    zohoApi: require('../lib/zoho-api')
  };
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + path];
    if (!handler) return reject(new Error('No handler registered for ' + method + ':' + path));
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

function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

// bucket is 'initiate' (ORACLE.initiate) or 'confirm' (ORACLE.confirm).
function expectOracle(bucket, key, actual) {
  expect(fx.ORACLE[bucket][key]).toBeDefined();
  expect(actual).toEqual(fx.ORACLE[bucket][key]);
}

var SAVED_ENV = {};
var ENV_KEYS = ['BEER_SALES_ENABLED', 'MAKERS_FEE_ITEM_ID', 'MATERIALS_FEE_ITEM_ID', 'MILLING_FEE_ITEM_ID', 'KIOSK_CONTACT_ID', 'NODE_ENV'];

function setupEnv() {
  ENV_KEYS.forEach(function (k) { SAVED_ENV[k] = process.env[k]; });
  process.env.BEER_SALES_ENABLED = 'true';
  process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
  process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
  process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
  process.env.KIOSK_CONTACT_ID = 'contact-default';
}

function restoreEnv() {
  ENV_KEYS.forEach(function (k) {
    if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
  });
}

function stubCache(mocks, catalog) {
  mocks.cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all' || key === 'zoho:ingredients') return Promise.resolve(catalog || fx.MOCK_INGREDIENTS_CATALOG);
    if (key === 'kiosk:discount-presets') return Promise.resolve(fx.DISCOUNT_PRESETS);
    return Promise.resolve(null);
  });
}

// ---------------------------------------------------------------------------
// Initiate leg
// ---------------------------------------------------------------------------

describe('recipe-sale initiate oracle', function () {
  var mocks;

  beforeEach(function () {
    setupEnv();
    mocks = resetAndLoadPosRecipe();
    mocks.helcim.isTerminalEnabled.mockReturnValue(true);
    mocks.helcim.terminalPurchase.mockResolvedValue({});
    mocks.cache.acquireLock.mockResolvedValue(true);
    stubCache(mocks);
  });

  afterEach(function () {
    restoreEnv();
    jest.restoreAllMocks();
  });

  CASES.forEach(function (c) {
    test('initiate ' + c.key, function () {
      return callHandler('POST', '/api/kiosk/recipe-sale', { body: buildBody(c) }).then(function (res) {
        expect(res._status).toBe(202);
        expect(mocks.helcim.terminalPurchase).toHaveBeenCalledTimes(1);
        expectOracle('initiate', c.key, {
          charge: mocks.helcim.terminalPurchase.mock.calls[0][0],
          total_before_tax: res._body.total_before_tax,
          tax_total: res._body.tax_total
        });
        // The 202 body total is the terminal charge.
        expect(res._body.total).toBe(mocks.helcim.terminalPurchase.mock.calls[0][0]);
      });
    });
  });

  test('initiate stock shortfall -> 409 Insufficient stock for scaled batch', function () {
    var shortCatalog = fx.MOCK_INGREDIENTS_CATALOG.map(function (e) {
      return e.item_id === 'ing-grain-1' ? Object.assign({}, e, { stock_on_hand: 1 }) : e;
    });
    stubCache(mocks, shortCatalog);
    return callHandler('POST', '/api/kiosk/recipe-sale', {
      body: { recipe_id: 'RCP-LOCKED', sale_type: 'in-store' }
    }).then(function (res) {
      expect(res._status).toBe(409);
      expect(res._body.error).toBe('Insufficient stock for scaled batch');
      expect(res._body.conflicts[0].item_id).toBe('ing-grain-1');
      expect(mocks.helcim.terminalPurchase).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Confirm leg
// ---------------------------------------------------------------------------

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Independent tax derivation from the posted invoice lines: per-rate group,
// each group rounded on its own (Zoho entity_level rounding).
function deriveTax(lines) {
  var pctById = {};
  fx.MOCK_INGREDIENTS_CATALOG.forEach(function (e) { pctById[e.item_id] = e.tax_percentage || 0; });
  fx.KIOSK_FEE_CATALOG.forEach(function (e) { pctById[e.item_id] = e.tax_percentage; });
  var groups = {};
  lines.forEach(function (li) {
    var amount = Math.max(r2(r2(li.quantity * li.rate) - (li.discount || 0)), 0);
    var pct = pctById[li.item_id] || 0;
    groups[pct] = (groups[pct] || 0) + amount * pct / 100;
  });
  var total = 0;
  Object.keys(groups).forEach(function (k) { total += r2(groups[k]); });
  return r2(total);
}

describe('recipe-sale/confirm oracle', function () {
  var mocks;
  var invoicePayload;

  beforeEach(function () {
    setupEnv();
    mocks = resetAndLoadPosRecipe();
    invoicePayload = null;
    mocks.helcim.isTerminalEnabled.mockReturnValue(true);
    mocks.cache.acquireLock.mockResolvedValue(true);
    stubCache(mocks);
    mocks.zohoApi.zohoPost.mockImplementation(function (path, payload) {
      if (path === '/invoices') {
        invoicePayload = payload;
        var lineSum = payload.line_items.reduce(function (s, li) {
          return s + Math.max(r2(r2(li.quantity * li.rate) - (li.discount || 0)), 0);
        }, 0);
        var total = r2(lineSum + deriveTax(payload.line_items) + (payload.adjustment || 0));
        return Promise.resolve({
          invoice: {
            invoice_id: 'inv-1',
            invoice_number: 'INV-001',
            total: total,
            line_items: payload.line_items
          }
        });
      }
      return Promise.resolve({});
    });
    mocks.zohoApi.zohoPut.mockResolvedValue({});
  });

  afterEach(function () {
    restoreEnv();
    jest.restoreAllMocks();
  });

  CASES.forEach(function (c, i) {
    test('confirm ' + c.key, function () {
      var charge = fx.ORACLE.initiate[c.key].charge;
      mocks.helcim.getCardTransactionById.mockResolvedValue({ status: 'APPROVED', amount: charge });
      var body = buildBody(c, { transaction_id: 'txn-char-' + i, reference: 'RECIPE-CHAR-' + i });
      return callHandler('POST', '/api/kiosk/recipe-sale/confirm', { body: body }).then(function (res) {
        expect(res._status).toBe(201);
        expect(res._body.total).toBe(charge);
        return flush().then(function () { return flush(); }).then(function () {
          var payCall = mocks.zohoApi.zohoPost.mock.calls.filter(function (call) { return call[0] === '/customerpayments'; })[0];
          expect(payCall).toBeDefined();
          // No re-balance PUT: the invoice Zoho echoes already equals the charge.
          expect(mocks.zohoApi.zohoPut).not.toHaveBeenCalled();
          expect(mocks.helcim.voidTransaction).not.toHaveBeenCalled();
          expectOracle('confirm', c.key, {
            line_items: invoicePayload.line_items.map(function (li) {
              return { item_id: li.item_id, quantity: li.quantity, rate: li.rate, discount: li.discount, tax_id: li.tax_id };
            }),
            adjustment: invoicePayload.adjustment,
            adjustment_description: invoicePayload.adjustment_description,
            tax: deriveTax(invoicePayload.line_items),
            payment_amount: payCall[1].amount
          });
          // tax + pre-tax lines/adjustment reconcile to the charge
          expect(payCall[1].amount).toBe(charge);
        });
      });
    });
  });
});

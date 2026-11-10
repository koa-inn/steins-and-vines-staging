'use strict';

/**
 * Phase 101-05: POST /api/kiosk/sale accepts recipes[] next to items.
 * Recipe components are priced server-side by lib/recipe-sale-lines and merged
 * into one cart: discount spans the cart, tax merges per rate group.
 */

var mockRouteHandlers = {};

jest.mock('../routes/catalog', function () {
  return {
    rebuildKioskCatalog: jest.fn(function () {
      return Promise.resolve(global.__rebuildCatalog || []);
    })
  };
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
    voidTransaction: jest.fn().mockResolvedValue({})
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
jest.mock('../lib/recipe-store', function () { return { get: jest.fn() }; });
jest.mock('../lib/money-path', function () {
  return {
    acquireIdempotencyLock: jest.fn().mockResolvedValue({ status: 'acquired' }),
    voidWithTimeout: jest.fn().mockResolvedValue(),
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

var ENV_KEYS = ['MAKERS_FEE_ITEM_ID', 'MATERIALS_FEE_ITEM_ID', 'MILLING_FEE_ITEM_ID', 'BEER_SALES_ENABLED'];
var saved = {};
var cache, helcimLib, recipeStore, eventLog, recipeLines, pos;
var ingredientStock;

// Product catalog entries the kiosk sells next to recipes.
var PRODUCTS = [
  { item_id: 'p-5', name: 'Snack', rate: 5, tax_percentage: 5 },
  { item_id: 'p-12', name: 'Gadget', rate: 5, tax_percentage: 12 }
];

function kioskCatalog() {
  return fx.KIOSK_FEE_CATALOG.concat(PRODUCTS);
}

function ingredientCatalog() {
  return fx.MOCK_INGREDIENTS_CATALOG.map(function (p) {
    var c = Object.assign({}, p);
    if (ingredientStock && ingredientStock[p.item_id] !== undefined) c.stock_on_hand = ingredientStock[p.item_id];
    return c;
  });
}

function load() {
  jest.resetModules();
  Object.keys(mockRouteHandlers).forEach(function (k) { delete mockRouteHandlers[k]; });
  cache = require('../lib/cache');
  helcimLib = require('../lib/helcim');
  recipeStore = require('../lib/recipe-store');
  eventLog = require('../lib/eventLog');
  pos = require('../routes/pos');
  recipeLines = require('../lib/recipe-sale-lines');
  cache.get.mockImplementation(function (key) {
    if (key === 'test:kiosk-products') return Promise.resolve(kioskCatalog());
    if (key === 'zoho:ingredients:all') return Promise.resolve(ingredientCatalog());
    if (key === 'kiosk:discount-presets') return Promise.resolve(fx.DISCOUNT_PRESETS);
    return Promise.resolve(null);
  });
  recipeStore.get.mockImplementation(function (id) {
    return Promise.resolve(fx.MOCK_RECIPES[id] || { ok: false });
  });
}

function mockRes() {
  var finishHandlers = [];
  var r = { statusCode: 200, headersSent: false, locals: {} };
  r.status = jest.fn(function (c) { r.statusCode = c; return r; });
  r.json = jest.fn(function () {
    finishHandlers.forEach(function (h) { h(); });
    return r;
  });
  r.on = jest.fn(function (evt, h) { if (evt === 'finish') finishHandlers.push(h); });
  return r;
}

function sale(body) {
  var res = mockRes();
  return new Promise(function (resolve) {
    var origJson = res.json;
    res.json = jest.fn(function (b) {
      origJson(b);
      resolve({ code: res.statusCode, body: b, res: res });
      return res;
    });
    mockRouteHandlers['POST:/api/kiosk/sale']({ body: body }, res);
  });
}

function r2(n) { return Math.round(n * 100) / 100; }

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

function recipeEntry(recipeId, extra) {
  return Object.assign({ recipe_id: recipeId, sale_type: 'in-store' }, extra || {});
}

beforeEach(function () {
  ENV_KEYS.forEach(function (k) { saved[k] = process.env[k]; });
  process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
  process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
  process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
  process.env.BEER_SALES_ENABLED = 'true';
  ingredientStock = null;
  PRODUCTS[0].rate = 5;
  global.__rebuildCatalog = kioskCatalog();
  load();
});

afterEach(function () {
  ENV_KEYS.forEach(function (k) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

function chargedAmount() {
  return helcimLib.terminalPurchase.mock.calls[0][0];
}

describe('recipe-only carts charge the Plan 01 oracle amount', function () {
  Object.keys(fx.ORACLE.initiate).forEach(function (key) {
    test(key, function () {
      var parts = key.split('/');
      var mode = MODES[parts[1]];
      var entry = recipeEntry(parts[0], { sale_type: mode.sale_type, mill_grain: mode.mill_grain });
      if (parts[3] === 'scale2x') entry.target_volume_l = 46;
      if (parts[3] === 'modified') entry.modified_ingredients = MODIFIED[parts[0]];
      var body = { items: [], recipes: [entry], client_grand_total: fx.ORACLE.initiate[key].charge };
      if (fx.DISCOUNT_KEYS[parts[2]]) body.discount = { preset_id: fx.DISCOUNT_KEYS[parts[2]] };
      return sale(body).then(function (out) {
        expect(out.code).toBe(202);
        expect(out.body.pending).toBe(true);
        expect(chargedAmount()).toBe(fx.ORACLE.initiate[key].charge);
      });
    });
  });

  test('items may be omitted for a recipe-only cart', function () {
    var oracle = fx.ORACLE.initiate['RCP-LOCKED/in-store/none'];
    return sale({ recipes: [recipeEntry('RCP-LOCKED')], client_grand_total: oracle.charge }).then(function (out) {
      expect(out.code).toBe(202);
      expect(chargedAmount()).toBe(oracle.charge);
    });
  });

  test('two entries of the same recipe charge twice the pre-tax price with tax merged per rate group', function () {
    var single = fx.ORACLE.initiate['RCP-LOCKED/in-store/none'];
    return recipeLines.priceRecipeEntries([
      { index: 0, recipe_id: 'RCP-LOCKED', sale_type: 'in-store', mill_grain: false, target_volume_l: null }
    ]).then(function (priced) {
      var e = priced.entries[0];
      return recipeLines.recipeTaxGroups(e.lines, e.catalog_map).then(function (g) {
        var tax = 0;
        Object.keys(g.byRate).forEach(function (k) { tax += r2(g.byRate[k] * 2); });
        var expected = r2(single.total_before_tax * 2 + r2(tax));
        return sale({
          items: [],
          recipes: [recipeEntry('RCP-LOCKED'), recipeEntry('RCP-LOCKED')],
          client_grand_total: expected
        }).then(function (out) {
          expect(out.code).toBe(202);
          expect(chargedAmount()).toBe(expected);
          expect(Math.abs(expected - single.charge * 2)).toBeLessThanOrEqual(0.02);
        });
      });
    });
  });

  test('the RECIPE_SALE mutex is never taken by the merged route', function () {
    return sale({
      recipes: [recipeEntry('RCP-LOCKED')],
      client_grand_total: fx.ORACLE.initiate['RCP-LOCKED/in-store/none'].charge
    }).then(function () {
      cache.acquireLock.mock.calls.forEach(function (c) { expect(c[0]).not.toBe('recipe-sale'); });
    });
  });
});

describe('mixed product + recipe carts', function () {
  function recipeOnlyGroups(entry) {
    return recipeLines.priceRecipeEntries([Object.assign({
      index: 0, mill_grain: false, target_volume_l: null, modified_ingredients: undefined
    }, entry)]).then(function (priced) {
      var e = priced.entries[0];
      return recipeLines.recipeTaxGroups(e.lines, e.catalog_map).then(function (g) {
        return { groups: g.byRate, preTax: e.base_total };
      });
    });
  }

  test('tax merges per rate group before rounding (differs from separately rounded taxes)', function () {
    return recipeOnlyGroups({ recipe_id: 'RCP-LOCKED', sale_type: 'in-store' }).then(function (rec) {
      // Find a 5% product price where merged rounding != separate rounding.
      var price = null;
      for (var c = 100; c <= 2000 && price === null; c++) {
        var p = c / 100;
        var sep = r2(rec.groups['5']) + r2(p * 0.05);
        var merged = r2(rec.groups['5'] + p * 0.05);
        if (r2(sep) !== merged) price = p;
      }
      expect(price).not.toBe(null);
      PRODUCTS[0].rate = price;
      var recipeTax = 0;
      Object.keys(rec.groups).forEach(function (k) {
        recipeTax += (k === '5') ? 0 : r2(rec.groups[k]);
      });
      var mergedFive = r2(rec.groups['5'] + price * 0.05);
      var expected = r2(price + rec.preTax + r2(recipeTax + mergedFive));
      var separate = r2(price + rec.preTax + r2(recipeTax + r2(rec.groups['5'])) + r2(price * 0.05));
      expect(expected).not.toBe(separate);
      return sale({
        items: [{ item_id: 'p-5', quantity: 1 }],
        recipes: [recipeEntry('RCP-LOCKED')],
        client_grand_total: expected
      }).then(function (out) {
        expect(out.code).toBe(202);
        expect(chargedAmount()).toBe(expected);
      });
    });
  });

  function mixedExpected() {
    return recipeOnlyGroups({ recipe_id: 'RCP-LOCKED', sale_type: 'in-store' }).then(function (rec) {
      var groups = {};
      Object.keys(rec.groups).forEach(function (k) { groups[k] = rec.groups[k]; });
      groups['5'] = (groups['5'] || 0) + 0.25; // product $5 at 5%
      var tax = 0;
      Object.keys(groups).forEach(function (k) { tax += r2(groups[k]); });
      return r2(5 + rec.preTax + r2(tax));
    });
  }

  test('cash tender returns 202 pending:false cash:true', function () {
    return mixedExpected().then(function (total) {
      return sale({
        tender: 'cash', items: [{ item_id: 'p-5', quantity: 1 }],
        recipes: [recipeEntry('RCP-LOCKED')], client_grand_total: total
      }).then(function (out) {
        expect(out.code).toBe(202);
        expect(out.body.pending).toBe(false);
        expect(out.body.cash).toBe(true);
        expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
      });
    });
  });

  test('moto tender initialises HelcimPay with the grand total', function () {
    return mixedExpected().then(function (total) {
      return sale({
        tender: 'moto', items: [{ item_id: 'p-5', quantity: 1 }],
        recipes: [recipeEntry('RCP-LOCKED')], client_grand_total: total
      }).then(function (out) {
        expect(out.code).toBe(202);
        expect(out.body.moto).toBe(true);
        expect(helcimLib.initializeCheckout).toHaveBeenCalledWith(total, 'CAD');
      });
    });
  });

  test('terminal tender with a partial gift card charges grand total minus the gift amount', function () {
    return mixedExpected().then(function (total) {
      return sale({
        items: [{ item_id: 'p-5', quantity: 1 }],
        recipes: [recipeEntry('RCP-LOCKED')],
        gift_card: { cert_number: 'GC-000001', amount_applied: 20 },
        client_grand_total: total
      }).then(function (out) {
        expect(out.code).toBe(202);
        expect(chargedAmount()).toBe(r2(total - 20));
      });
    });
  });

  test('a gift card covering the whole total skips the terminal', function () {
    return mixedExpected().then(function (total) {
      return sale({
        items: [{ item_id: 'p-5', quantity: 1 }],
        recipes: [recipeEntry('RCP-LOCKED')],
        gift_card: { cert_number: 'GC-000001', amount_applied: total + 50 },
        client_grand_total: total
      }).then(function (out) {
        expect(out.code).toBe(202);
        expect(helcimLib.terminalPurchase).not.toHaveBeenCalled();
      });
    });
  });
});

describe('discounts span the mixed cart', function () {
  // Product $5 @5% + RCP-LOCKED in-store (locked $195, fees 45 + 5).
  function discountedTotal(presetId, expectFn) {
    var body = {
      items: [{ item_id: 'p-5', quantity: 1 }],
      recipes: [recipeEntry('RCP-LOCKED')],
      discount: { preset_id: presetId },
      client_grand_total: 0
    };
    // Pricing core is called directly so the discount math is asserted without a tender.
    return pos.computeCartPricing(body, {
      'p-5': PRODUCTS[0], 'p-12': PRODUCTS[1]
    }).then(function (p) {
      expect(p.ok).toBe(true);
      return expectFn(p);
    });
  }

  test('cart fixed $7.50 is split across the product line and the recipe, summing to 7.50', function () {
    return discountedTotal('p-cart-fixed', function (p) {
      var productDisc = r2(5 - (p.subtotal));
      var recipeDisc = p.recipe.sections[0].discount_amount;
      expect(r2(productDisc + recipeDisc)).toBe(7.5);
      expect(productDisc).toBeGreaterThan(0);
      expect(recipeDisc).toBeGreaterThan(0);
      expect(p.discountApplied.amount).toBe(7.5);
    });
  });

  test('type recipe 10% leaves the product line undiscounted and discounts the product portion', function () {
    return discountedTotal('p-type-recipe', function (p) {
      expect(p.subtotal).toBe(5);
      expect(p.recipe.sections[0].discount_amount).toBe(19.5); // 10% of the 195 product portion
    });
  });

  test('type service 10% discounts only the recipe fee portion', function () {
    return discountedTotal('p-type-service', function (p) {
      expect(p.subtotal).toBe(5);
      expect(p.recipe.sections[0].discount_amount).toBe(5); // 10% of (45 + 5)
    });
  });

  test('cart percentage hits the product line and the recipe', function () {
    return discountedTotal('p-cart-pct', function (p) {
      expect(p.subtotal).toBe(4.5);
      expect(p.recipe.sections[0].discount_amount).toBe(24.5);
    });
  });

  test('product-only resolveDiscount is unchanged without recipeUnits', function () {
    var lines = [{ item_id: 'p-5', quantity: 1, rate: 5 }];
    return pos.resolveDiscount({ discount: { preset_id: 'p-cart-fixed' } }, lines, 5, { 'p-5': PRODUCTS[0] })
      .then(function (r) {
        expect(r.subtotal).toBe(0);
        expect(r.recipeAmounts).toBeUndefined();
        expect(r.discountApplied.amount).toBeUndefined();
      });
  });
});

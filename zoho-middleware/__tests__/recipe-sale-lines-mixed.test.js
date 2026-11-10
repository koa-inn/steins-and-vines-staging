'use strict';

jest.mock('../lib/kiosk-sale-catalog', function () {
  return { getKioskCatalogForSale: jest.fn() };
});
jest.mock('../lib/recipe-store', function () {
  return { get: jest.fn() };
});
jest.mock('../lib/cache', function () {
  return { get: jest.fn(), set: jest.fn() };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn(), zohoDelete: jest.fn() };
});

var kioskSaleCatalog = require('../lib/kiosk-sale-catalog');
var recipeStore = require('../lib/recipe-store');
var cache = require('../lib/cache');
var zohoApi = require('../lib/zoho-api');
var lines = require('../lib/recipe-sale-lines');
var fx = require('./fixtures/recipe-mixed-carts');

var ENV_KEYS = ['MAKERS_FEE_ITEM_ID', 'MATERIALS_FEE_ITEM_ID', 'MILLING_FEE_ITEM_ID'];
var saved = {};
var stockOnHand;

function catalogWithStock(grainStock) {
  return fx.MOCK_INGREDIENTS_CATALOG.map(function (p) {
    var c = Object.assign({}, p);
    if (p.item_id === 'ing-grain-1' && grainStock !== undefined) c.stock_on_hand = grainStock;
    return c;
  });
}

function ent(recipeId, extra) {
  return Object.assign({
    index: 0, recipe_id: recipeId, sale_type: 'in-store', mill_grain: false,
    target_volume_l: null, modified_ingredients: undefined
  }, extra || {});
}

beforeEach(function () {
  ENV_KEYS.forEach(function (k) { saved[k] = process.env[k]; });
  process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
  process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
  process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
  stockOnHand = undefined;
  kioskSaleCatalog.getKioskCatalogForSale.mockReset();
  kioskSaleCatalog.getKioskCatalogForSale.mockResolvedValue({ items: fx.KIOSK_FEE_CATALOG, source: 'fresh' });
  recipeStore.get.mockReset();
  recipeStore.get.mockImplementation(function (id) {
    return Promise.resolve(fx.MOCK_RECIPES[id] || { ok: false });
  });
  cache.get.mockReset();
  cache.get.mockImplementation(function (key) {
    if (key === 'zoho:ingredients:all') return Promise.resolve(catalogWithStock(stockOnHand));
    if (key === 'kiosk:discount-presets') return Promise.resolve(fx.DISCOUNT_PRESETS);
    return Promise.resolve(null);
  });
  Object.keys(zohoApi).forEach(function (k) { zohoApi[k].mockClear(); });
});

afterEach(function () {
  ENV_KEYS.forEach(function (k) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  });
});

function ingredientLoads() {
  return cache.get.mock.calls.filter(function (c) { return c[0] === 'zoho:ingredients:all'; }).length;
}

describe('validateRecipeEntries', function () {
  var good = { recipe_id: 'RCP-LOCKED', sale_type: 'in-store' };

  it('rejects empty, oversized, and malformed entries', function () {
    expect(lines.validateRecipeEntries([]).status).toBe(400);
    expect(lines.validateRecipeEntries('x').status).toBe(400);
    var many = [];
    for (var i = 0; i < 26; i++) many.push(good);
    expect(lines.validateRecipeEntries(many).status).toBe(400);
    expect(lines.validateRecipeEntries([{ recipe_id: 'R', sale_type: 'delivery' }]).status).toBe(400);
    expect(lines.validateRecipeEntries([{ recipe_id: new Array(66).join('a'), sale_type: 'in-store' }]).status).toBe(400);
    expect(lines.validateRecipeEntries([{ recipe_id: 'R', sale_type: 'in-store', target_volume_l: 'abc' }]).status).toBe(400);
    expect(lines.validateRecipeEntries([{ recipe_id: 'R', sale_type: 'in-store', target_volume_l: -1 }]).status).toBe(400);
    expect(lines.validateRecipeEntries([{ recipe_id: 'R', sale_type: 'in-store', modified_ingredients: {} }]).status).toBe(400);
  });

  it('accepts exactly MAX_RECIPE_ENTRIES', function () {
    var many = [];
    for (var i = 0; i < lines.MAX_RECIPE_ENTRIES; i++) many.push(good);
    expect(lines.validateRecipeEntries(many).ok).toBe(true);
  });

  it('drops client price/total fields and coerces mill_grain', function () {
    var r = lines.validateRecipeEntries([Object.assign({ price: 1, total: 1, mill_grain: 'yes' }, good)]);
    expect(r.ok).toBe(true);
    expect(r.entries[0]).not.toHaveProperty('price');
    expect(r.entries[0]).not.toHaveProperty('total');
    expect(r.entries[0].mill_grain).toBe(false);
    expect(r.entries[0].index).toBe(0);
  });
});

describe('priceRecipeEntries', function () {
  it('prices several entries (incl. the same recipe twice) with one catalog load and no Zoho calls', function () {
    var entries = [ent('RCP-LOCKED', { index: 0 }), ent('RCP-DYN', { index: 1 }), ent('RCP-LOCKED', { index: 2, target_volume_l: 46 })];
    return lines.priceRecipeEntries(entries).then(function (res) {
      expect(res.entries.map(function (e) { return e.recipe_id; })).toEqual(['RCP-LOCKED', 'RCP-DYN', 'RCP-LOCKED']);
      expect(ingredientLoads()).toBe(1);
      expect(cache.get.mock.calls.filter(function (c) { return c[0] === 'zoho:ingredients:all'; }).length).toBeLessThanOrEqual(1);
      expect(recipeStore.get).toHaveBeenCalledTimes(3);
      Object.keys(zohoApi).forEach(function (k) { expect(zohoApi[k]).not.toHaveBeenCalled(); });
      // each entry carries its own batch size
      expect(res.entries[0].target_volume_l).toBe(23);
      expect(res.entries[2].target_volume_l).toBe(46);
      expect(res.entries[2].base_total).toBeGreaterThan(res.entries[0].base_total);
    });
  });

  it('rejects an unknown recipe with the priceRecipe shape', function () {
    return lines.priceRecipeEntries([ent('NOPE')]).then(function () {
      throw new Error('should reject');
    }, function (err) {
      expect(err.status).toBe(404);
      expect(err.body.error).toBeDefined();
    });
  });

  it('503s when the ingredient catalog is unavailable', function () {
    cache.get.mockResolvedValue(null);
    return lines.priceRecipeEntries([ent('RCP-LOCKED')]).then(function () {
      throw new Error('should reject');
    }, function (err) {
      expect(err.status).toBe(503);
    });
  });
});

describe('checkCombinedStock / recipeEntryLabels', function () {
  it('sums need per item across recipes and names every short recipe', function () {
    // grain need: LOCKED 5.5 + DYN 6 = 11.5 kg; each alone fits 8
    stockOnHand = 8;
    return lines.priceRecipeEntries([ent('RCP-LOCKED', { index: 0 }), ent('RCP-DYN', { index: 1 })]).then(function (priced) {
      expect(priced.entries[0].stock_check.ok).toBe(true);
      expect(priced.entries[1].stock_check.ok).toBe(true);
      var r = lines.checkCombinedStock(priced);
      expect(r.ok).toBe(false);
      expect(r.conflicts).toHaveLength(1);
      expect(r.conflicts[0].item_id).toBe('ing-grain-1');
      expect(r.conflicts[0].needed).toBeCloseTo(11.5, 6);
      expect(r.conflicts[0].stock).toBe(8);
      expect(r.conflicts[0].recipes).toEqual(['Locked Pale Ale', 'Dynamic Amber']);
      expect(r.recipes_short.map(function (s) { return s.recipe_id; })).toEqual(['RCP-LOCKED', 'RCP-DYN']);
    });
  });

  it('labels duplicates #1/#2 in conflicts', function () {
    stockOnHand = 8;
    return lines.priceRecipeEntries([ent('RCP-LOCKED', { index: 0 }), ent('RCP-LOCKED', { index: 1 })]).then(function (priced) {
      expect(lines.recipeEntryLabels(priced)).toEqual(['Locked Pale Ale #1', 'Locked Pale Ale #2']);
      var r = lines.checkCombinedStock(priced);
      expect(r.ok).toBe(false);
      expect(r.conflicts[0].recipes).toEqual(['Locked Pale Ale #1', 'Locked Pale Ale #2']);
    });
  });

  it('is ok with enough stock', function () {
    return lines.priceRecipeEntries([ent('RCP-LOCKED', { index: 0 }), ent('RCP-DYN', { index: 1 })]).then(function (priced) {
      var r = lines.checkCombinedStock(priced);
      expect(r.ok).toBe(true);
      expect(r.conflicts).toEqual([]);
      expect(lines.recipeEntryLabels(priced)).toEqual(['Locked Pale Ale', 'Dynamic Amber']);
    });
  });

  it('fails closed on a non-convertible unit', function () {
    var priced = { entries: [{
      index: 0, recipe_id: 'R', recipe_name: 'R',
      scaled_ingredients: [{ item_id: 'ing-grain-1', item_name: 'Grain', quantity: 1, unit: 'L' }],
      catalog_map: { 'ing-grain-1': { item_id: 'ing-grain-1', unit: 'kg', stock_on_hand: 99, rate: 1 } }
    }] };
    var r = lines.checkCombinedStock(priced);
    expect(r.ok).toBe(false);
    expect(r.conflicts[0].item_id).toBe('ing-grain-1');
  });
});

describe('discount base / apply / adjustment / notes', function () {
  it('recipeDiscountBase mirrors computeRecipeDiscount for every preset', function () {
    fx.DISCOUNT_PRESETS.forEach(function (p) {
      var disc = lines.computeRecipeDiscount(p, 245, 50);
      expect(lines.recipeDiscountBase(p, 245, 50)).toBe(disc.base);
      if (p.type === 'percentage') {
        expect(disc.discountAmount).toBe(lines.round2(lines.recipeDiscountBase(p, 245, 50) * p.value / 100));
      }
    });
    expect(lines.recipeDiscountBase(null, 245, 50)).toBe(0);
  });

  it('applyRecipeDiscount distributes exactly the amount and does not mutate the entry', function () {
    return lines.priceRecipeEntries([ent('RCP-DYN')]).then(function (priced) {
      var e = priced.entries[0];
      var preset = fx.DISCOUNT_PRESETS[0];
      var amount = lines.computeRecipeDiscount(preset, e.base_total, e.fee_portion).discountAmount;
      var out = lines.applyRecipeDiscount(e, amount, preset);
      var sum = out.lines.reduce(function (a, li) { return a + (li.discount || 0); }, 0);
      expect(lines.round2(sum)).toBe(amount);
      expect(out.pre_tax).toBe(lines.round2(e.base_total - amount));
      expect(e.lines.some(function (li) { return li.discount; })).toBe(false);
    });
  });

  it('recipeNotesSummary lists each recipe', function () {
    var priced = { entries: [
      { recipe_name: 'House Pale', sale_type: 'in-store', mill_grain: false, target_volume_l: 23 },
      { recipe_name: 'Saison', sale_type: 'take-out', mill_grain: true, target_volume_l: 23 }
    ] };
    expect(lines.recipeNotesSummary(priced)).toBe('Recipes: House Pale (in-store, 23 L), Saison (take-out, milled, 23 L)');
  });
});

describe('oracle parity (recipe-only cart prices as the legacy route)', function () {
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

  Object.keys(fx.ORACLE.initiate).forEach(function (key) {
    it(key, function () {
      var parts = key.split('/');
      var mode = MODES[parts[1]];
      var preset = null;
      fx.DISCOUNT_PRESETS.forEach(function (p) { if (p.id === fx.DISCOUNT_KEYS[parts[2]]) preset = p; });
      var entry = ent(parts[0], { sale_type: mode.sale_type, mill_grain: mode.mill_grain });
      if (parts[3] === 'scale2x') entry.target_volume_l = 46;
      if (parts[3] === 'modified') entry.modified_ingredients = MODIFIED[parts[0]];

      return lines.priceRecipeEntries([entry]).then(function (priced) {
        var e = priced.entries[0];
        var amount = 0;
        if (preset) {
          var base = lines.recipeDiscountBase(preset, e.base_total, e.fee_portion);
          amount = preset.type === 'percentage'
            ? lines.computeRecipeDiscount(preset, e.base_total, e.fee_portion).discountAmount
            : lines.round2(Math.min(preset.value, base));
        }
        var applied = lines.applyRecipeDiscount(e, amount, preset);
        return lines.recipeTaxGroups(applied.lines, e.catalog_map).then(function (groups) {
          expect(groups.error).toBeUndefined();
          var tax = 0;
          Object.keys(groups.byRate).forEach(function (k) { tax += lines.round2(groups.byRate[k]); });
          tax = lines.round2(tax);
          var charge = lines.round2(applied.pre_tax + tax);
          expect(charge).toBe(fx.ORACLE.initiate[key].charge);

          var adj = lines.recipeAdjustment(applied.pre_tax, applied.lines);
          expect({
            line_items: applied.lines.map(function (li) {
              return { item_id: li.item_id, quantity: li.quantity, rate: li.rate, discount: li.discount, tax_id: li.tax_id };
            }),
            adjustment: adj !== 0 ? adj : undefined,
            tax: tax,
            payment_amount: charge
          }).toEqual({
            line_items: fx.ORACLE.confirm[key].line_items,
            adjustment: fx.ORACLE.confirm[key].adjustment,
            tax: fx.ORACLE.confirm[key].tax,
            payment_amount: fx.ORACLE.confirm[key].payment_amount
          });
        });
      });
    });
  });
});

'use strict';

jest.mock('../lib/kiosk-sale-catalog', function () {
  return { getKioskCatalogForSale: jest.fn() };
});

var kioskSaleCatalog = require('../lib/kiosk-sale-catalog');
var lines = require('../lib/recipe-sale-lines');
var posRecipe = require('../routes/pos-recipe');
var fx = require('./fixtures/recipe-mixed-carts');

function mapOf(catalog) {
  var m = {};
  catalog.forEach(function (p) { m[p.item_id] = p; });
  return m;
}

describe('recipe-sale-lines', function () {
  var catalogMap = mapOf(fx.MOCK_INGREDIENTS_CATALOG);
  var savedEnv;

  beforeEach(function () {
    savedEnv = {
      mk: process.env.MAKERS_FEE_ITEM_ID,
      ma: process.env.MATERIALS_FEE_ITEM_ID,
      mi: process.env.MILLING_FEE_ITEM_ID
    };
    process.env.MAKERS_FEE_ITEM_ID = fx.FEE_IDS.makers;
    process.env.MATERIALS_FEE_ITEM_ID = fx.FEE_IDS.materials;
    process.env.MILLING_FEE_ITEM_ID = fx.FEE_IDS.milling;
    kioskSaleCatalog.getKioskCatalogForSale.mockReset();
    kioskSaleCatalog.getKioskCatalogForSale.mockResolvedValue({ items: fx.KIOSK_FEE_CATALOG, source: 'fresh' });
  });
  afterEach(function () {
    process.env.MAKERS_FEE_ITEM_ID = savedEnv.mk;
    process.env.MATERIALS_FEE_ITEM_ID = savedEnv.ma;
    process.env.MILLING_FEE_ITEM_ID = savedEnv.mi;
    if (savedEnv.mk === undefined) delete process.env.MAKERS_FEE_ITEM_ID;
    if (savedEnv.ma === undefined) delete process.env.MATERIALS_FEE_ITEM_ID;
    if (savedEnv.mi === undefined) delete process.env.MILLING_FEE_ITEM_ID;
  });

  it('pos-recipe re-exports the same discount helpers (identity)', function () {
    expect(posRecipe.computeRecipeDiscount).toBe(lines.computeRecipeDiscount);
    expect(posRecipe.distributeRecipeDiscount).toBe(lines.distributeRecipeDiscount);
  });

  var mixedLines = [
    { item_id: 'ing-grain-1', name: 'Grain', rate: 3.5, quantity: 10 },
    { item_id: 'ing-hop-1', name: 'Hops', rate: 80, quantity: 0.1 },
    { item_id: 'ing-yeast-1', name: 'Yeast', rate: 5, quantity: 1 },
    { item_id: fx.FEE_IDS.makers, name: 'Makers', rate: 40, quantity: 1 },
    { item_id: fx.FEE_IDS.materials, name: 'Materials', rate: 10, quantity: 1 }
  ];

  it('recipeTaxGroups returns un-rounded per-rate amounts', function () {
    return lines.recipeTaxGroups(mixedLines, catalogMap).then(function (res) {
      expect(res.error).toBeUndefined();
      var keys = Object.keys(res.byRate).sort();
      expect(keys).toEqual(['0', '12', '5']);
      expect(res.byRate['12']).toBeCloseTo(1.2, 10);
      expect(res.byRate['5']).toBeCloseTo((35 + 8 + 40) * 0.05, 10);
    });
  });

  it('computeRecipeTax equals the per-group rounded sum of recipeTaxGroups', function () {
    return Promise.all([
      lines.recipeTaxGroups(mixedLines, catalogMap),
      lines.computeRecipeTax(mixedLines, catalogMap)
    ]).then(function (r) {
      var sum = 0;
      Object.keys(r[0].byRate).forEach(function (k) { sum += lines.round2(r[0].byRate[k]); });
      expect(r[1].taxTotal).toBe(lines.round2(sum));
    });
  });

  it('fails closed with the same error when a fee item has no tax rate', function () {
    kioskSaleCatalog.getKioskCatalogForSale.mockResolvedValue({ items: [], source: 'fresh' });
    return Promise.all([
      lines.recipeTaxGroups(mixedLines, catalogMap),
      lines.computeRecipeTax(mixedLines, catalogMap)
    ]).then(function (r) {
      expect(r[0].error).toMatch(/Cannot determine tax for "Makers"/);
      expect(r[1].error).toBe(r[0].error);
    });
  });

  it('flags a stale fee catalog on computeRecipeTax', function () {
    kioskSaleCatalog.getKioskCatalogForSale.mockResolvedValue({ items: fx.KIOSK_FEE_CATALOG, source: 'stale', staleAt: 'x' });
    return lines.computeRecipeTax(mixedLines, catalogMap).then(function (r) {
      expect(r.catalogSource).toBe('stale');
    });
  });
});

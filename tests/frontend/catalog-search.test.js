'use strict';

// ---------------------------------------------------------------------------
// catalog-search.test.js
//
// Tests the fuzzy search filter algorithm used in:
//   js/modules/07-catalog-kits.js  (applyFilters — _kitsFuse / _kitsFuseSet)
//   js/modules/08-catalog-ingredients.js (renderIngredients — _ingredientsFuse / _ingFuseSet)
//
// Both modules share the same pattern:
//   1. Build a Fuse index over the product array (if Fuse is defined globally)
//   2. In the filter callback: if there is a query AND a Fuse index:
//        build a Set from Fuse results, return set.has(item)
//      otherwise: fall back to simple indexOf on name / description fields
//
// We test the algorithm directly — both with real Fuse.js and with Fuse absent.
// ---------------------------------------------------------------------------

var Fuse = require('../../js/vendor/fuse.min.js');

// ---------------------------------------------------------------------------
// Helpers — mirror the exact filter logic from the two modules
// ---------------------------------------------------------------------------

/**
 * Kits filter logic (mirrors applyFilters() in 07-catalog-kits.js)
 * Returns the filtered subset of `products` for the given `query`.
 */
function filterKits(products, query, fuseInstance) {
  var _kitsFuseSet = null;
  if (query && fuseInstance) {
    var fuseResults = fuseInstance.search(query);
    _kitsFuseSet = new Set(fuseResults.map(function (r) { return r.item; }));
  }

  return products.filter(function (r) {
    if (!query) return true;
    if (_kitsFuseSet) return _kitsFuseSet.has(r);
    // indexOf fallback (Fuse absent)
    var name = (r.name || '').toLowerCase();
    var sub = (r.subcategory || '').toLowerCase();
    var notes = (r.tasting_notes || '').toLowerCase();
    var brand = (r.brand || '').toLowerCase();
    return name.indexOf(query) !== -1 || sub.indexOf(query) !== -1 ||
           notes.indexOf(query) !== -1 || brand.indexOf(query) !== -1;
  });
}

/**
 * Ingredients filter logic (mirrors renderIngredients() in 08-catalog-ingredients.js)
 * Returns the filtered subset of `products` for the given `query`.
 */
function filterIngredients(products, query, fuseInstance) {
  var _ingFuseSet = null;
  if (query && fuseInstance) {
    var ingFuseResults = fuseInstance.search(query);
    _ingFuseSet = new Set(ingFuseResults.map(function (r) { return r.item; }));
  }

  return products.filter(function (r) {
    if (!query) return true;
    if (_ingFuseSet) return _ingFuseSet.has(r);
    // indexOf fallback (Fuse absent)
    var name = (r.name || '').toLowerCase();
    var desc = (r.description || '').toLowerCase();
    return name.indexOf(query) !== -1 || desc.indexOf(query) !== -1;
  });
}

/**
 * Build a Fuse instance for kits (same options as 07-catalog-kits.js).
 */
function buildKitsFuse(products) {
  return new Fuse(products, {
    keys: ['name', 'brand', 'subcategory', 'tasting_notes'],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true
  });
}

/**
 * Build a Fuse instance for ingredients (same options as 08-catalog-ingredients.js).
 */
function buildIngredientsFuse(products) {
  return new Fuse(products, {
    keys: ['name', 'description'],
    threshold: 0.35,
    minMatchCharLength: 2,
    ignoreLocation: true
  });
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------
var KIT_PRODUCTS = [
  { name: 'Merlot Kit', brand: 'Winexpert', subcategory: 'Red Wine', tasting_notes: 'Plum and cherry' },
  { name: 'Pinot Grigio', brand: 'RJS', subcategory: 'White Wine', tasting_notes: 'Crisp and citrus' },
  { name: 'Blonde Ale', brand: 'Brewhouse', subcategory: 'Beer', tasting_notes: 'Light malt' },
  { name: 'Cabernet Sauvignon', brand: 'Winexpert', subcategory: 'Red Wine', tasting_notes: 'Dark fruit and oak' }
];

var INGREDIENT_PRODUCTS = [
  { name: 'Wine Yeast EC-1118', description: 'Champagne yeast for strong fermentation' },
  { name: 'Pectic Enzyme', description: 'Breaks down pectin in fruit wines' },
  { name: 'Bentonite', description: 'Fining agent to clarify wine' },
  { name: 'Oak Spiral', description: 'Adds oak character to wine or beer' }
];

// ---------------------------------------------------------------------------
// Kits — fuzzy search with Fuse
// ---------------------------------------------------------------------------
describe('Kits fuzzy search (Fuse enabled)', function () {
  var fuse;

  beforeEach(function () {
    fuse = buildKitsFuse(KIT_PRODUCTS);
  });

  test('empty query returns all products', function () {
    var result = filterKits(KIT_PRODUCTS, '', fuse);
    expect(result).toHaveLength(KIT_PRODUCTS.length);
  });

  test('exact match on name returns the correct product', function () {
    var result = filterKits(KIT_PRODUCTS, 'Merlot Kit', fuse);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Merlot Kit');
  });

  test('fuzzy match — "Merlo" finds "Merlot Kit"', function () {
    var result = filterKits(KIT_PRODUCTS, 'Merlo', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Merlot Kit');
  });

  test('fuzzy match — "pinot" (lowercase) finds "Pinot Grigio"', function () {
    var result = filterKits(KIT_PRODUCTS, 'pinot', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Pinot Grigio');
  });

  test('fuzzy match — "caberne" finds "Cabernet Sauvignon"', function () {
    var result = filterKits(KIT_PRODUCTS, 'caberne', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Cabernet Sauvignon');
  });

  test('gibberish query returns no results', function () {
    var result = filterKits(KIT_PRODUCTS, 'xzxzqqqq', fuse);
    expect(result).toHaveLength(0);
  });

  test('search on brand field — "Winexpert" matches multiple kits', function () {
    var result = filterKits(KIT_PRODUCTS, 'Winexpert', fuse);
    var brands = result.map(function (r) { return r.brand; });
    brands.forEach(function (b) { expect(b).toBe('Winexpert'); });
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  test('search on subcategory field — "Red Wine" includes red wine kits', function () {
    var result = filterKits(KIT_PRODUCTS, 'Red Wine', fuse);
    var subs = result.map(function (r) { return r.subcategory; });
    // Fuse fuzzy-matches "Red Wine" — at minimum the Red Wine kits should appear
    expect(subs).toContain('Red Wine');
    // The subcategory search should surface Merlot and Cabernet Sauvignon
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Merlot Kit');
    expect(names).toContain('Cabernet Sauvignon');
  });

  test('query with no active Fuse (null) falls back to indexOf', function () {
    // Pass null as the fuse instance — simulates Fuse not loaded
    var result = filterKits(KIT_PRODUCTS, 'merlot', null);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Merlot Kit');
  });

  test('indexOf fallback is case-insensitive (lowercase query matches mixed-case name)', function () {
    var result = filterKits(KIT_PRODUCTS, 'blonde ale', null);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Blonde Ale');
  });

  test('indexOf fallback returns empty for gibberish', function () {
    var result = filterKits(KIT_PRODUCTS, 'xzxzqqqq', null);
    expect(result).toHaveLength(0);
  });

  test('indexOf fallback matches on tasting_notes field', function () {
    var result = filterKits(KIT_PRODUCTS, 'plum and cherry', null);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Merlot Kit');
  });
});

// ---------------------------------------------------------------------------
// Ingredients — fuzzy search with Fuse
// ---------------------------------------------------------------------------
describe('Ingredients fuzzy search (Fuse enabled)', function () {
  var fuse;

  beforeEach(function () {
    fuse = buildIngredientsFuse(INGREDIENT_PRODUCTS);
  });

  test('empty query returns all products', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, '', fuse);
    expect(result).toHaveLength(INGREDIENT_PRODUCTS.length);
  });

  test('exact match on name returns the correct product', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'Bentonite', fuse);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Bentonite');
  });

  test('fuzzy match — "yeast" finds "Wine Yeast EC-1118"', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'yeast', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Wine Yeast EC-1118');
  });

  test('fuzzy match — "pectik" (typo) finds "Pectic Enzyme"', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'pectik', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Pectic Enzyme');
  });

  test('gibberish query returns no results', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'xzxzqqqq', fuse);
    expect(result).toHaveLength(0);
  });

  test('search on description field — "clarify" matches Bentonite', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'clarify', fuse);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Bentonite');
  });

  test('indexOf fallback (no Fuse) matches name', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'oak spiral', null);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Oak Spiral');
  });

  test('indexOf fallback returns empty for gibberish', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'xzxzqqqq', null);
    expect(result).toHaveLength(0);
  });

  test('indexOf fallback matches on description field', function () {
    var result = filterIngredients(INGREDIENT_PRODUCTS, 'champagne yeast', null);
    var names = result.map(function (r) { return r.name; });
    expect(names).toContain('Wine Yeast EC-1118');
  });
});

// ---------------------------------------------------------------------------
// Fuse Set correctness — the Set is built from result.item references
// so it uses object identity (===), not deep equality
// ---------------------------------------------------------------------------
describe('Fuse result Set uses object identity (reference equality)', function () {
  test('Set.has() matches the exact product object reference', function () {
    var products = [
      { name: 'Merlot Kit', brand: 'Winexpert', subcategory: 'Red Wine', tasting_notes: '' }
    ];
    var fuse = buildKitsFuse(products);
    var fuseResults = fuse.search('merlot');
    var fuseSet = new Set(fuseResults.map(function (r) { return r.item; }));

    // The item in the Set must be === the original product object
    expect(fuseSet.has(products[0])).toBe(true);

    // A copy with the same values is NOT in the Set
    var copy = { name: 'Merlot Kit', brand: 'Winexpert', subcategory: 'Red Wine', tasting_notes: '' };
    expect(fuseSet.has(copy)).toBe(false);
  });
});

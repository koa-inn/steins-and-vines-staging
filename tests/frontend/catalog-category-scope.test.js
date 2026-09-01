'use strict';

// Regression coverage for Phase 74 Plan 02 — category-scoped kit loading,
// the beer-card waitlist CTA (D-12), and per-category filter row sorting (D-13).

// Stub KIT_CATEGORIES so 07-catalog-kits.js loads in Node without error.
global.KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

// Stub browser globals that 07-catalog-kits.js references at module scope.
global.document = { getElementById: function () { return null; } };
global.fetch = function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); };
global.localStorage = {
  getItem: function () { return null; },
  setItem: function () {}
};
global.SHEETS_CONFIG = { MIDDLEWARE_URL: '' };
global.window = global.window || {};
global.showCatalogSkeletons = function () {};
global.formatCurrency = function (val) { return '$' + Number(val).toFixed(2); };

var mod = require('../../js/modules/07-catalog-kits.js');

// ---------------------------------------------------------------------------
// Task 1 — matchesKitCategory (D-01/D-09 category scoping)
// ---------------------------------------------------------------------------

describe('matchesKitCategory', function () {
  test('is exported from the module', function () {
    expect(typeof mod.matchesKitCategory).toBe('function');
  });

  test('a Wine-typed item matches "wine" and not "beer"', function () {
    var item = { type: 'Wine' };
    expect(mod.matchesKitCategory(item, 'wine')).toBe(true);
    expect(mod.matchesKitCategory(item, 'beer')).toBe(false);
  });

  test('a Beer-typed item matches "beer" and not "wine"', function () {
    var item = { type: 'Beer' };
    expect(mod.matchesKitCategory(item, 'beer')).toBe(true);
    expect(mod.matchesKitCategory(item, 'wine')).toBe(false);
  });

  test('both match when categoryFilter is empty string (back-compat)', function () {
    var wine = { type: 'Wine' };
    var beer = { type: 'Beer' };
    expect(mod.matchesKitCategory(wine, '')).toBe(true);
    expect(mod.matchesKitCategory(beer, '')).toBe(true);
  });

  test('both match when categoryFilter is omitted (back-compat)', function () {
    var wine = { type: 'Wine' };
    var beer = { type: 'Beer' };
    expect(mod.matchesKitCategory(wine)).toBe(true);
    expect(mod.matchesKitCategory(beer)).toBe(true);
  });

  test('an item whose category resolves via _zoho_category is matched', function () {
    var item = { _zoho_category: 'Beer Kits' };
    expect(mod.matchesKitCategory(item, 'beer')).toBe(true);
  });

  test('an item with no category at all returns false', function () {
    var item = { name: 'Mystery Item' };
    expect(mod.matchesKitCategory(item, 'wine')).toBe(false);
    expect(mod.matchesKitCategory(item)).toBe(false);
  });

  test('an unknown filter value such as "mead" returns false for every item', function () {
    var wine = { type: 'Wine' };
    var beer = { type: 'Beer' };
    expect(mod.matchesKitCategory(wine, 'mead')).toBe(false);
    expect(mod.matchesKitCategory(beer, 'mead')).toBe(false);
  });

  test('guards a missing/undefined obj', function () {
    expect(mod.matchesKitCategory(undefined, 'wine')).toBe(false);
    expect(mod.matchesKitCategory(null, 'wine')).toBe(false);
  });
});

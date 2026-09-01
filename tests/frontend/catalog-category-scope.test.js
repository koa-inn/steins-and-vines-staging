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

// ---------------------------------------------------------------------------
// Task 2 — buildWaitlistCtaLink (D-12 beer card waitlist CTA)
// ---------------------------------------------------------------------------

// Minimal jsdom-like document stub sufficient for createElement/appendChild/
// getAttribute — real jsdom is available via testEnvironment but we build a
// throwaway document-like object here to keep this test self-contained and
// match the require()'d Node harness pattern used above.
function makeFakeDoc(dataPage) {
  function makeElement(tag) {
    return {
      tagName: tag,
      className: '',
      textContent: '',
      href: '',
      children: [],
      appendChild: function (child) { this.children.push(child); },
      getAttribute: function () { return null; }
    };
  }
  return {
    body: dataPage === undefined ? null : {
      getAttribute: function (name) {
        return name === 'data-page' ? dataPage : null;
      }
    },
    createElement: function (tag) { return makeElement(tag); }
  };
}

describe('buildWaitlistCtaLink', function () {
  test('is exported from the module', function () {
    expect(typeof mod.buildWaitlistCtaLink).toBe('function');
  });

  test('anchor has class btn and exact textContent "Join the Waitlist"', function () {
    var doc = makeFakeDoc('beer');
    var wrap = mod.buildWaitlistCtaLink(doc);
    var anchor = wrap.children[0];
    expect(anchor.className).toBe('btn');
    expect(anchor.textContent).toBe('Join the Waitlist');
  });

  test('href is "#waitlist" (no beer.html prefix) when body has data-page="beer"', function () {
    var doc = makeFakeDoc('beer');
    var wrap = mod.buildWaitlistCtaLink(doc);
    var anchor = wrap.children[0];
    expect(anchor.href).toBe('#waitlist');
  });

  test('href is "beer.html#waitlist" when body does not have data-page="beer"', function () {
    var doc = makeFakeDoc('wine');
    var wrap = mod.buildWaitlistCtaLink(doc);
    var anchor = wrap.children[0];
    expect(anchor.href).toBe('beer.html#waitlist');
  });

  test('wrapper className does not contain product-reserve-wrap', function () {
    var doc = makeFakeDoc('beer');
    var wrap = mod.buildWaitlistCtaLink(doc);
    expect(wrap.className.indexOf('product-reserve-wrap')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Task 3 — sortFilterValues (D-13 per-category filter rows + ABV field)
// ---------------------------------------------------------------------------

describe('sortFilterValues', function () {
  test('is exported from the module', function () {
    expect(typeof mod.sortFilterValues).toBe('function');
  });

  test('abv sorts ascending numerically, tolerating a trailing %', function () {
    expect(mod.sortFilterValues('abv', ['12%', '5.8', '9'])).toEqual(['5.8', '9', '12%']);
  });

  test('subcategory applies the wine styleOrder when categoryFilter is "wine"', function () {
    expect(mod.sortFilterValues('subcategory', ['White', 'Red'], 'wine')).toEqual(['Red', 'White']);
  });

  test('subcategory falls through to alphabetical order when categoryFilter is "beer"', function () {
    expect(mod.sortFilterValues('subcategory', ['Stout', 'IPA', 'Lager'], 'beer')).toEqual(['IPA', 'Lager', 'Stout']);
  });

  test('body still produces its existing domain order', function () {
    expect(mod.sortFilterValues('body', ['full', 'light', 'medium'])).toEqual(['light', 'medium', 'full']);
  });

  test('sweetness still produces its existing domain order', function () {
    expect(mod.sortFilterValues('sweetness', ['sweet', 'dry', 'off-dry'])).toEqual(['dry', 'off-dry', 'sweet']);
  });

  test('time still sorts numerically ascending', function () {
    expect(mod.sortFilterValues('time', ['12 weeks', '4 weeks', '8 weeks'])).toEqual(['4 weeks', '8 weeks', '12 weeks']);
  });

  test('does not mutate the input array', function () {
    var input = ['White', 'Red'];
    mod.sortFilterValues('subcategory', input, 'wine');
    expect(input).toEqual(['White', 'Red']);
  });
});

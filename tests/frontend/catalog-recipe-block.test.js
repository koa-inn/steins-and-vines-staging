'use strict';

// Regression coverage for Phase 74 Plan 03 — the public recipe card (D-07),
// the recipe fetch + block renderer (D-05), and dual-block ordering (D-01/D-02/D-03/D-04).

// Stub KIT_CATEGORIES so 07-catalog-kits.js loads in Node without error.
global.KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

// Stub non-DOM browser globals that 07-catalog-kits.js references at module scope.
// jest's testEnvironment is jsdom (jest.config.js), so `document`/`window` are
// already real — we deliberately do NOT overwrite `document` here (unlike
// catalog-category-scope.test.js's bare stub) because this file's assertions
// need real textContent aggregation, querySelectorAll and classList behaviour
// for the recipe card and block-renderer DOM shapes.
global.fetch = global.fetch || function () { return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } }); };
global.localStorage = global.localStorage || {
  getItem: function () { return null; },
  setItem: function () {}
};
global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'https://mw.example.test' };
global.showCatalogSkeletons = function () {};
global.formatCurrency = function (val) { return '$' + Number(val).toFixed(2); };

var mod = require('../../js/modules/07-catalog-kits.js');

// ---------------------------------------------------------------------------
// Task 1 — recipeDisplayPrice (D-07 price fallback / "From " convention)
// ---------------------------------------------------------------------------

describe('recipeDisplayPrice', function () {
  test('is exported from the module', function () {
    expect(typeof mod.recipeDisplayPrice).toBe('function');
  });

  test('returns "Price set when you book" when price is null', function () {
    expect(mod.recipeDisplayPrice({ price: null })).toBe('Price set when you book');
  });

  test('returns "Price set when you book" when price is missing entirely', function () {
    expect(mod.recipeDisplayPrice({})).toBe('Price set when you book');
  });

  test('returns "Price set when you book" when price is NaN', function () {
    expect(mod.recipeDisplayPrice({ price: NaN })).toBe('Price set when you book');
  });

  test('returns a bare formatted currency string when price_from is not set', function () {
    expect(mod.recipeDisplayPrice({ price: 45 })).toBe('$45.00');
  });

  test('returns a "From "-prefixed formatted currency string when price_from is true', function () {
    expect(mod.recipeDisplayPrice({ price: 30, price_from: true })).toBe('From $30.00');
  });
});

// ---------------------------------------------------------------------------
// Task 1 — buildRecipeCard (D-07 field allowlist, plain .product-card idiom)
// ---------------------------------------------------------------------------

describe('buildRecipeCard', function () {
  test('is exported from the module', function () {
    expect(typeof mod.buildRecipeCard).toBe('function');
  });

  test('root has class product-card and never label-beer/label-wine', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.className).toBe('product-card');
    expect(card.className.indexOf('label-beer')).toBe(-1);
    expect(card.className.indexOf('label-wine')).toBe(-1);
  });

  test('h4 textContent equals the recipe name', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.querySelector('h4').textContent).toBe('Czech Lager');
  });

  test('a card built from a recipe with empty description contains zero .service-description elements, and price slot reads the fallback', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.querySelectorAll('.service-description').length).toBe(0);
    expect(card.querySelector('.product-price-value').textContent).toBe('Price set when you book');
  });

  test('a card built with a description contains exactly one .service-description whose text equals the description', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var descs = card.querySelectorAll('.service-description');
    expect(descs.length).toBe(1);
    expect(descs[0].textContent).toBe('A crisp, clean pilsner.');
  });

  test('the card\'s full textContent contains no $-prefixed number other than the single price string', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var matches = card.textContent.match(/\$[0-9,.]+/g) || [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('$45.00');
  });

  test('the card contains exactly one a.btn reading "Join the Waitlist"', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var links = card.querySelectorAll('a.btn');
    expect(links.length).toBe(1);
    expect(links[0].textContent).toBe('Join the Waitlist');
  });

  test('field order is exactly name -> style -> price -> blurb -> CTA', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var order = [];
    Array.prototype.forEach.call(card.children, function (child) {
      order.push(child.className);
    });
    expect(order).toEqual(['product-card-header', 'product-prices service-price', 'service-description', 'reserve-link']);
  });

  test('reads no property outside the public allowlist — extra fields are ignored', function () {
    var card = mod.buildRecipeCard({
      recipe_id: 'SV-R-000004',
      name: 'Czech Lager',
      style: 'Lager',
      description: 'A crisp, clean pilsner.',
      price: 45,
      ingredients: [{ name: 'malt', cost: 12 }],
      locked_price: 999,
      service_fee: 5,
      materials_fee: 3,
      computed_price: 999,
      pricing_mode: 'dynamic'
    }, document);
    expect(card.textContent.indexOf('999')).toBe(-1);
    expect(card.textContent.indexOf('malt')).toBe(-1);
  });
});

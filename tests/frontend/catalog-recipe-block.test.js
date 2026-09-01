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
// Task 1 — buildRecipeCard (D-07 field allowlist, label-beer card idiom)
// D-02 revised by owner UAT 2026-09-01: recipe cards now use the same
// bottle-label idiom as kit cards so both blocks read as one catalogue.
// The D-07 field allowlist below is UNCHANGED and still enforced.
// ---------------------------------------------------------------------------

describe('buildRecipeCard', function () {
  test('is exported from the module', function () {
    expect(typeof mod.buildRecipeCard).toBe('function');
  });

  test('root uses the label-beer idiom and never label-wine', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.className).toBe('label-beer');
    expect(card.className.indexOf('label-wine')).toBe(-1);
  });

  test('.beer-name textContent equals the recipe name', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.querySelector('.beer-name').textContent).toBe('Czech Lager');
  });

  test('a card built from a recipe with empty description contains zero .service-description elements, and price slot reads the fallback', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000002', name: 'Czech Lager', style: 'Lager', description: '', price: null }, document);
    expect(card.querySelectorAll('.service-description').length).toBe(0);
    expect(card.querySelector('.price-value').textContent).toBe('Price set when you book');
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

  test('card structure is exactly body -> price footer -> CTA', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var order = [];
    Array.prototype.forEach.call(card.children, function (child) {
      order.push(child.className);
    });
    expect(order).toEqual(['label-body', 'price-footer', 'reserve-link']);
  });

  test('inside the body, field order is name -> style -> blurb', function () {
    var card = mod.buildRecipeCard({ recipe_id: 'SV-R-000003', name: 'Czech Lager', style: 'Lager', description: 'A crisp, clean pilsner.', price: 45 }, document);
    var body = card.querySelector('.label-body');
    var order = [];
    Array.prototype.forEach.call(body.children, function (child) {
      order.push(child.className);
    });
    expect(order.indexOf('beer-name')).toBeLessThan(order.indexOf('subcategory'));
    expect(order.indexOf('subcategory')).toBeLessThan(order.indexOf('service-description'));
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

// ---------------------------------------------------------------------------
// Task 2 — fetchActiveRecipes / renderRecipeBlock (D-05, per-block error isolation)
// ---------------------------------------------------------------------------

describe('fetchActiveRecipes', function () {
  test('is exported from the module', function () {
    expect(typeof mod.fetchActiveRecipes).toBe('function');
  });

  test('resolves { ok: true, recipes: [] } immediately when categoryFilter is falsy — no fetch called', function () {
    var fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    return mod.fetchActiveRecipes('', 'https://mw.example.test').then(function (result) {
      expect(result).toEqual({ ok: true, recipes: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  test('resolves { ok: true, recipes: [] } when categoryFilter is not "beer" — no fetch called', function () {
    var fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    return mod.fetchActiveRecipes('wine', 'https://mw.example.test').then(function (result) {
      expect(result).toEqual({ ok: true, recipes: [] });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  test('fetches the public status=active endpoint with no headers when categoryFilter is "beer"', function () {
    var recipes = [{ recipe_id: 'SV-R-1', name: 'Czech Lager', price: 45 }];
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ source: 'cache', recipes: recipes, total: 1 }); } });
    });
    return mod.fetchActiveRecipes('beer', 'https://mw.example.test').then(function (result) {
      expect(global.fetch).toHaveBeenCalledWith('https://mw.example.test/api/recipes?status=active');
      expect(result).toEqual({ ok: true, recipes: recipes });
    });
  });

  test('resolves { ok: false } on a non-ok response', function () {
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({}); } });
    });
    return mod.fetchActiveRecipes('beer', 'https://mw.example.test').then(function (result) {
      expect(result).toEqual({ ok: false });
    });
  });

  test('resolves { ok: false } when fetch itself throws/rejects', function () {
    global.fetch = jest.fn(function () { return Promise.reject(new Error('network down')); });
    return mod.fetchActiveRecipes('beer', 'https://mw.example.test').then(function (result) {
      expect(result).toEqual({ ok: false });
    });
  });
});

describe('renderRecipeBlock', function () {
  beforeEach(function () {
    document.body.innerHTML = '<div id="product-catalog"><p id="sentinel">kit content already rendered</p></div><div id="recipe-catalog"></div>';
  });

  test('is exported from the module', function () {
    expect(typeof mod.renderRecipeBlock).toBe('function');
  });

  test('no-ops cleanly when #recipe-catalog is absent', function () {
    document.body.innerHTML = '<div id="product-catalog"></div>';
    expect(function () {
      mod.renderRecipeBlock({ ok: true, recipes: [] }, false, '', '', document);
    }).not.toThrow();
  });

  test('a zero-length recipe list leaves #recipe-catalog innerHTML exactly empty', function () {
    mod.renderRecipeBlock({ ok: true, recipes: [] }, false, 'beer', '', document);
    expect(document.getElementById('recipe-catalog').innerHTML).toBe('');
  });

  test('a failed result yields exactly one .catalog-error with the exact copy string and one .btn-retry', function () {
    mod.renderRecipeBlock({ ok: false }, false, 'beer', '', document);
    var recipeEl = document.getElementById('recipe-catalog');
    var errors = recipeEl.querySelectorAll('.catalog-error');
    expect(errors.length).toBe(1);
    expect(errors[0].querySelector('p').textContent).toBe("Couldn't load recipes right now. Check your connection and try again.");
    expect(recipeEl.querySelectorAll('.btn-retry').length).toBe(1);
  });

  test('a failed result leaves #product-catalog untouched (sentinel child survives)', function () {
    mod.renderRecipeBlock({ ok: false }, false, 'beer', '', document);
    expect(document.getElementById('sentinel')).not.toBeNull();
    expect(document.getElementById('sentinel').textContent).toBe('kit content already rendered');
  });

  test('a two-recipe result yields one .catalog-section, one h2.catalog-section-title reading "Beer Recipes", and a .product-grid carrying product-grid--compact', function () {
    var recipes = [
      { recipe_id: 'SV-R-1', name: 'Czech Lager', style: 'Lager', description: 'Crisp.', price: 45 },
      { recipe_id: 'SV-R-2', name: 'Amber Ale', style: 'Ale', description: 'Malty.', price: 40 }
    ];
    mod.renderRecipeBlock({ ok: true, recipes: recipes }, false, 'beer', '', document);
    var recipeEl = document.getElementById('recipe-catalog');
    expect(recipeEl.querySelectorAll('.catalog-section').length).toBe(1);
    var heading = recipeEl.querySelector('h2.catalog-section-title');
    expect(heading.textContent).toBe('Beer Recipes');
    var grid = recipeEl.querySelector('.product-grid');
    expect(grid.className.indexOf('product-grid--compact')).not.toBe(-1);
  });

  test('a four-recipe result yields a .product-grid WITHOUT product-grid--compact', function () {
    var recipes = [1, 2, 3, 4].map(function (n) {
      return { recipe_id: 'SV-R-' + n, name: 'Recipe ' + n, style: 'Ale', description: 'x', price: 10 };
    });
    mod.renderRecipeBlock({ ok: true, recipes: recipes }, false, 'beer', '', document);
    var grid = document.getElementById('recipe-catalog').querySelector('.product-grid');
    expect(grid.className.indexOf('product-grid--compact')).toBe(-1);
  });

  test('appends the sub-copy note only when showSubCopy is true', function () {
    var recipes = [{ recipe_id: 'SV-R-1', name: 'Czech Lager', style: 'Lager', description: 'Crisp.', price: 45 }];
    mod.renderRecipeBlock({ ok: true, recipes: recipes }, true, 'beer', '', document);
    var note = document.getElementById('recipe-catalog').querySelector('.process-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toBe('Book a session and brew your own batch in our studio.');
  });

  test('omits the sub-copy note when showSubCopy is falsy', function () {
    var recipes = [{ recipe_id: 'SV-R-1', name: 'Czech Lager', style: 'Lager', description: 'Crisp.', price: 45 }];
    mod.renderRecipeBlock({ ok: true, recipes: recipes }, false, 'beer', '', document);
    var note = document.getElementById('recipe-catalog').querySelector('.process-note');
    expect(note).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 3 — orderCatalogBlocks (D-03 dual-block ordering, LOCKED tie-break)
// ---------------------------------------------------------------------------

describe('orderCatalogBlocks', function () {
  test('is exported from the module', function () {
    expect(typeof mod.orderCatalogBlocks).toBe('function');
  });

  test('an exact tie (the /beer launch state) leads with kits', function () {
    expect(mod.orderCatalogBlocks(1, 1)).toEqual(['kits', 'recipes']);
  });

  test('more recipes than kits leads with recipes', function () {
    expect(mod.orderCatalogBlocks(0, 3)).toEqual(['recipes', 'kits']);
  });

  test('more kits than recipes leads with kits', function () {
    expect(mod.orderCatalogBlocks(5, 2)).toEqual(['kits', 'recipes']);
  });

  test('a zero/zero tie leads with kits', function () {
    expect(mod.orderCatalogBlocks(0, 0)).toEqual(['kits', 'recipes']);
  });
});

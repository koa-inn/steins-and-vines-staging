'use strict';

// Minimal global stubs for admin.js IIFE to load without errors.
// admin.js relies on DOM, SHEETS_CONFIG, google auth, etc.

var mockElements = {};
function createMockElement() {
  return {
    style: {},
    className: '',
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    setAttribute: jest.fn(),
    getAttribute: jest.fn(function () { return null; }),
    addEventListener: jest.fn(),
    querySelector: jest.fn(function () { return null; }),
    querySelectorAll: jest.fn(function () { return []; }),
    appendChild: jest.fn(),
    closest: jest.fn(function () { return null; }),
    remove: jest.fn(),
    classList: { add: jest.fn(), remove: jest.fn(), contains: jest.fn() },
    parentNode: { querySelector: jest.fn(function () { return null; }), appendChild: jest.fn() },
    focus: jest.fn()
  };
}

global.document = {
  getElementById: jest.fn(function (id) {
    if (!mockElements[id]) mockElements[id] = createMockElement();
    return mockElements[id];
  }),
  querySelectorAll: jest.fn(function () { return []; }),
  querySelector: jest.fn(function () { return null; }),
  addEventListener: jest.fn(),
  createElement: jest.fn(function () { return createMockElement(); }),
  body: { appendChild: jest.fn() }
};

global.window = {
  confirm: jest.fn(function () { return true; }),
  location: { search: '', pathname: '/admin.html', href: '' },
  addEventListener: jest.fn(),
  matchMedia: jest.fn(function () { return { matches: false, addEventListener: jest.fn() }; })
};

global.navigator = { userAgent: 'test' };
global.localStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.sessionStorage = {
  getItem: jest.fn(function () { return null; }),
  setItem: jest.fn(),
  removeItem: jest.fn()
};
global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
};
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
});
global.setTimeout = jest.fn(function (fn) { if (typeof fn === 'function') fn(); return 1; });
global.clearTimeout = jest.fn();
global.setInterval = jest.fn(function () { return 1; });
global.clearInterval = jest.fn();
global.alert = jest.fn();
global.Image = jest.fn(function () { return {}; });
global.URLSearchParams = function (s) {
  this.get = function () { return null; };
  this.has = function () { return false; };
};
global.MutationObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});

// Google Identity stubs
global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };

// SHEETS_CONFIG stub (normally from js/sheets-config.js)
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://localhost:3001',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

// Load admin.js (the IIFE will run and export via module.exports)
var admin = require('../../js/admin.js');

// ---------------------------------------------------------------------------
// canActivateRecipe
// ---------------------------------------------------------------------------
describe('canActivateRecipe', function () {
  test('returns ok:false when locked_price is 0', function () {
    var result = admin.canActivateRecipe({ locked_price: 0 }, [{ item_id: '123', quantity: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('locked price');
  });

  test('returns ok:false when locked_price is empty string', function () {
    var result = admin.canActivateRecipe({ locked_price: '' }, [{ item_id: '123', quantity: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('locked price');
  });

  test('returns ok:false when ingredients array is empty', function () {
    var result = admin.canActivateRecipe({ locked_price: 150 }, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ingredient');
  });

  test('returns ok:true when locked_price > 0 and ingredients has items', function () {
    var result = admin.canActivateRecipe({ locked_price: 150 }, [{ item_id: '123', quantity: 1 }]);
    expect(result.ok).toBe(true);
  });

  test('returns ok:false when locked_price is NaN (e.g. "abc")', function () {
    var result = admin.canActivateRecipe({ locked_price: 'abc' }, [{ item_id: '123', quantity: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('locked price');
  });

  test('returns ok:false when ingredients is null', function () {
    var result = admin.canActivateRecipe({ locked_price: 100 }, null);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ingredient');
  });

  // -------------------------------------------------------------------------
  // Regression: the caller gates on `status === 'active'`, not on "is being
  // activated", so this guard re-runs on EVERY save of an already-active
  // recipe. A dynamic-priced recipe prices from computed_price and
  // legitimately has locked_price 0 — which made renaming one impossible.
  // -------------------------------------------------------------------------

  test('returns ok:true for a dynamic recipe with no locked_price', function () {
    var result = admin.canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: 0 },
      [{ item_id: '123', quantity: 1 }]
    );
    expect(result.ok).toBe(true);
  });

  test('returns ok:true for a dynamic recipe with a blank locked_price field', function () {
    var result = admin.canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: '' },
      [{ item_id: '123', quantity: 1 }]
    );
    expect(result.ok).toBe(true);
  });

  test('a dynamic recipe still requires ingredients — its price derives from them', function () {
    var result = admin.canActivateRecipe(
      { pricing_mode: 'dynamic', locked_price: 0 },
      []
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ingredient/i);
  });

  test('a locked recipe still requires a locked_price', function () {
    var result = admin.canActivateRecipe(
      { pricing_mode: 'locked', locked_price: 0 },
      [{ item_id: '123', quantity: 1 }]
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/price/i);
  });

  test('an absent pricing_mode is treated as locked and still requires a price', function () {
    var result = admin.canActivateRecipe({ locked_price: 0 }, [{ item_id: '123', quantity: 1 }]);
    expect(result.ok).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// filterIngredientCatalog
// ---------------------------------------------------------------------------
describe('filterIngredientCatalog', function () {
  beforeEach(function () {
    admin._recipesState.catalog = [
      { name: 'Pale Malt (2-Row)', sku: 'MALT-PALE-2ROW', item_id: '101', unit: 'kg', stock_on_hand: 45 },
      { name: 'Cascade Hops', sku: 'HOP-CASCADE', item_id: '102', unit: 'g', stock_on_hand: 500 },
      { name: 'US-05 Yeast', sku: 'YEAST-US05', item_id: '103', unit: 'pkt', stock_on_hand: 10 },
      { name: 'Crystal Malt 60L', sku: 'MALT-CRYSTAL-60', item_id: '104', unit: 'kg', stock_on_hand: 20 },
      { name: 'Centennial Hops', sku: 'HOP-CENTENNIAL', item_id: '105', unit: 'g', stock_on_hand: 300 },
      { name: 'Chinook Hops', sku: 'HOP-CHINOOK', item_id: '106', unit: 'g', stock_on_hand: 250 },
      { name: 'Pilsner Malt', sku: 'MALT-PILSNER', item_id: '107', unit: 'kg', stock_on_hand: 55 },
      { name: 'Munich Malt', sku: 'MALT-MUNICH', item_id: '108', unit: 'kg', stock_on_hand: 30 }
    ];
    admin._recipesState.catalogLoaded = true;
  });

  test('returns up to 6 items when query is empty', function () {
    var results = admin.filterIngredientCatalog('');
    expect(results.length).toBe(6);
  });

  test('filters by name substring (case-insensitive)', function () {
    var results = admin.filterIngredientCatalog('cascade');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Cascade Hops');
  });

  test('filters by SKU substring', function () {
    var results = admin.filterIngredientCatalog('HOP-CHIN');
    expect(results.length).toBe(1);
    expect(results[0].sku).toBe('HOP-CHINOOK');
  });

  test('returns empty array when no matches', function () {
    var results = admin.filterIngredientCatalog('zzzznotexist');
    expect(results).toEqual([]);
  });

  test('limits results to 6 even with more matches', function () {
    // "Malt" matches 4 items, "Hops" matches 3, all together > 6 items contain "l"
    admin._recipesState.catalog = [];
    for (var i = 0; i < 20; i++) {
      admin._recipesState.catalog.push({ name: 'Item ' + i, sku: 'SKU-' + i, item_id: String(i), unit: 'kg' });
    }
    var results = admin.filterIngredientCatalog('Item');
    expect(results.length).toBe(6);
  });

  test('matches partial name at any position', function () {
    var results = admin.filterIngredientCatalog('malt');
    expect(results.length).toBe(4); // Pale Malt, Crystal Malt, Pilsner Malt, Munich Malt
  });
});

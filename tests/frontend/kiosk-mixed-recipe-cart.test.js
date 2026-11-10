'use strict';

// Phase 101 (D-01..D-08, D-15): a recipe is a LIST ENTRY in the cart, never a
// replacement for it. Replaces the bbca0f28 guard tests (kiosk-recipe-cart-guard,
// D-20 owner-approved). Runs against both the standalone kiosk and the admin POS.

global.window = global.window || {};
global.window.confirm = global.window.confirm || jest.fn(function () { return true; });
global.navigator = global.navigator || { userAgent: 'test' };
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.alert = jest.fn();
global.fetch = jest.fn();
global.Image = global.Image || jest.fn(function () { return {}; });
global.MutationObserver = global.MutationObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = global.IntersectionObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});
global.google = {
  accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } }
};

global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://localhost:3001',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

var DEVICE_TOKEN_KEY = 'sv_kiosk_device_token';

var PRODUCT = { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 };
var RECIPE = { recipe_id: 'RCP-001', name: 'House Pale', pricing_mode: 'locked', locked_price: 120 };
var RECIPE_2 = { recipe_id: 'RCP-002', name: 'Dark Stout', pricing_mode: 'locked', locked_price: 90 };
var CAN_473 = { item_id: 'can473', name: 'Can 473 mL', sku: 'CAN-473', rate: 0.5, tax_percentage: 12, product_type: 'goods', stock_on_hand: 5000 };

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 8; i++) { p = p.then(function () {}); }
  return p;
}

function injectEl(id, tag) {
  var el = document.getElementById(id);
  if (el) { el.innerHTML = ''; return el; }
  el = document.createElement(tag || 'div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function loadSurface(path) {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require(path); // eslint-disable-line global-require -- per-surface isolation
  var core = global.window.KioskCore;
  ['kiosk-toast-container', 'kiosk-cart-items', 'kiosk-cart-totals', 'kiosk-checkout-btn',
    'kiosk-checkout-total', 'kiosk-product-grid'].forEach(function (id) { injectEl(id); });
  return core;
}

function toastText() {
  return document.getElementById('kiosk-toast-container').textContent;
}

function addRecipe(core, recipe, opts) {
  opts = opts || {};
  core._setSelectedRecipe(recipe);
  core._setSaleType(opts.saleType || 'in-store');
  core._setMillGrain(!!opts.mill);
  core._setTargetVolumeL(opts.volume || 20);
  core.addRecipeToCart();
  return flush();
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function (url) {
    var body = {};
    var m = typeof url === 'string' && url.match(/\/api\/recipes\/(RCP-00\d)/);
    if (m) {
      body = {
        recipe: { recipe_id: m[1], name: m[1] === 'RCP-001' ? 'House Pale' : 'Dark Stout', pricing_mode: 'locked' },
        ingredients: [{ item_id: 'ing1', item_name: 'Pale Malt', quantity: 5, unit: 'kg', rate: 3 }]
      };
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  });
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('mixed recipe cart: ' + surfacePath, function () {
    test('adding a recipe keeps the products already in the cart', async function () {
      var core = loadSurface(surfacePath);
      core._setCart({ p1: { item: PRODUCT, qty: 2 } });

      await addRecipe(core, RECIPE);

      expect(core._getCart().p1.qty).toBe(2);
      expect(core._getRecipeEntries()).toHaveLength(1);
      expect(core._getRecipeEntries()[0].recipe_id).toBe('RCP-001');
      expect(core._getRecipeEntries()[0].total_before_discount).toBe(120);
      expect(toastText()).toMatch(/Added House Pale to cart/);
    });

    test('the same recipe twice makes two entries with their own snapshots', async function () {
      var core = loadSurface(surfacePath);
      var mods = [{ ingredient_id: 'ing1', quantity: 7 }];
      core._setModifiedIngredients(mods);
      await addRecipe(core, RECIPE, { volume: 20 });

      mods[0].quantity = 99; // later edits on the screen must not leak into entry 1
      core._setModifiedIngredients([{ ingredient_id: 'ing1', quantity: 11 }]);
      await addRecipe(core, RECIPE, { volume: 40, saleType: 'take-out', mill: true });

      var entries = core._getRecipeEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].entry_id).not.toBe(entries[1].entry_id);
      expect(entries[0].target_volume_l).toBe(20);
      expect(entries[1].target_volume_l).toBe(40);
      expect(entries[0].modified_ingredients).toEqual([{ ingredient_id: 'ing1', quantity: 7 }]);
      expect(entries[1].modified_ingredients).toEqual([{ ingredient_id: 'ing1', quantity: 11 }]);
      expect(entries[0].sale_type).toBe('in-store');
      expect(entries[1].sale_type).toBe('take-out');
      expect(entries[1].mill_grain).toBe(true);
    });

    test('a different recipe joins as a third-party entry without clearing', async function () {
      var core = loadSurface(surfacePath);
      await addRecipe(core, RECIPE);
      await addRecipe(core, RECIPE_2);
      expect(core._getRecipeEntries().map(function (e) { return e.recipe_id; })).toEqual(['RCP-001', 'RCP-002']);
    });

    test('products can be added, re-quantified and removed with entries present', async function () {
      var core = loadSurface(surfacePath);
      await addRecipe(core, RECIPE);

      core.addToCart(PRODUCT);
      expect(core._getCart().p1.qty).toBe(1);
      core.setQty('p1', 3);
      expect(core._getCart().p1.qty).toBe(3);
      core.removeFromCart('p1');
      expect(core._getCart().p1).toBeUndefined();
      expect(core._getRecipeEntries()).toHaveLength(1);
    });

    test('a canning bundle can be added alongside a recipe entry', async function () {
      var core = loadSurface(surfacePath);
      core.init({ showCanningBundleModal: function () {} });
      core._getProducts().length = 0;
      core._getProducts().push(CAN_473);
      await addRecipe(core, RECIPE);

      var r = core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });

      expect(r.ok).toBe(true);
      expect(core._getRecipeEntries()).toHaveLength(1);
    });

    test('removeRecipeEntry removes only that entry', async function () {
      var core = loadSurface(surfacePath);
      core._setCart({ p1: { item: PRODUCT, qty: 1 } });
      await addRecipe(core, RECIPE);
      await addRecipe(core, RECIPE_2);
      var first = core._getRecipeEntries()[0].entry_id;

      core.removeRecipeEntry(first);

      var left = core._getRecipeEntries();
      expect(left).toHaveLength(1);
      expect(left[0].recipe_id).toBe('RCP-002');
      expect(core._getCart().p1).toBeDefined();
    });

    test('clearCart empties entries and the sticky stock override', async function () {
      var core = loadSurface(surfacePath);
      await addRecipe(core, RECIPE);
      core._setStockOverride(true);

      core.clearCart();

      expect(core._getRecipeEntries()).toEqual([]);
      expect(core._getStockOverride()).toBe(false);
    });

    test('a cart with only entries is not empty and renders a row with remove', async function () {
      var core = loadSurface(surfacePath);
      await addRecipe(core, RECIPE);

      expect(core.cartIsEmpty()).toBe(false);
      expect(document.querySelector('.kiosk-cart-empty')).toBeNull();
      expect(document.querySelectorAll('.kiosk-recipe-entry')).toHaveLength(1);
      expect(document.getElementById('kiosk-add-custom-btn')).not.toBeNull();
      expect(document.getElementById('kiosk-add-gc-btn')).not.toBeNull();

      document.querySelector('.kiosk-recipe-entry-remove').click();
      expect(core._getRecipeEntries()).toEqual([]);
    });

    test('the old recipe-cart guard text is gone', async function () {
      var core = loadSurface(surfacePath);
      core._setCart({ p1: { item: PRODUCT, qty: 1 } });
      await addRecipe(core, RECIPE);
      expect(toastText()).not.toMatch(/check out or clear/i);
      expect(document.querySelector('.kiosk-recipe-cart-note')).toBeNull();
    });
  });
});

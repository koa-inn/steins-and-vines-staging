'use strict';

// Kiosk recipe carts (owner report 2026-11-10).
// A recipe sale goes to /api/kiosk/recipe-sale, which charges ONLY the recipe
// and only on the card terminal. So a recipe cart must never hold or show
// anything the server will not charge:
//   - adding a recipe must not silently wipe products already in the cart
//   - products / custom items / gift cards cannot join a recipe cart
//   - recipe lines cannot be re-quantified, and removing one removes the recipe
//   - recipe checkout says it is card only (no Cash / Gift Card / Phone order)
// Harness mirrors kiosk-recipe-client-totals.test.js.

global.window = global.window || {};
global.navigator = global.navigator || { userAgent: 'test' };
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.alert = jest.fn();
global.fetch = jest.fn();

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

function recipeCart() {
  return {
    'recipe-ing-0-ing1': {
      item: { item_id: 'ing1', name: 'Pale Malt (5 kg)', rate: 0, tax_percentage: 0, product_type: 'recipe_ingredient' },
      qty: 1
    },
    'recipe-total': {
      item: { item_id: 'RCP-001', name: 'House Pale — Package Price', rate: 120, tax_percentage: 0, product_type: 'recipe' },
      qty: 1
    }
  };
}

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function injectEl(id, tag) {
  var el = document.createElement(tag || 'div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function load() {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require('../../js/kiosk.js');
  var core = global.window.KioskCore;
  ['kiosk-toast-container', 'kiosk-cart-items', 'kiosk-cart-totals', 'kiosk-checkout-btn',
    'kiosk-checkout-total', 'kiosk-product-grid', 'kiosk-payment-items', 'kiosk-payment-amount',
    'kiosk-terminal-msg', 'kiosk-spinner'].forEach(function (id) { injectEl(id); });
  return core;
}

function toastText() {
  return document.getElementById('kiosk-toast-container').textContent;
}

function recipeFetches() {
  return global.fetch.mock.calls.filter(function (c) {
    return typeof c[0] === 'string' && c[0].indexOf('/api/recipes/') !== -1;
  });
}

function asRecipeCart(core) {
  core._setCart(recipeCart());
  core._setRecipeContext({ recipe_id: 'RCP-001', recipe_name: 'House Pale', sale_type: 'in-store', mill_grain: false });
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function (url) {
    var body = {};
    if (typeof url === 'string' && url.indexOf('/api/recipes/RCP-001') !== -1) {
      body = { recipe: { recipe_id: 'RCP-001', name: 'House Pale', pricing_mode: 'locked' }, ingredients: [] };
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  });
});

describe('adding a recipe', function () {
  test('does not wipe products already in the cart', async function () {
    var core = load();
    core._setCart({ p1: { item: PRODUCT, qty: 2 } });
    core._setSelectedRecipe(RECIPE);
    core._setSaleType('in-store');

    core.addRecipeToCart();
    await flushPromises();

    expect(core._getCart()).toEqual({ p1: { item: PRODUCT, qty: 2 } });
    expect(core._getRecipeContext()).toBeNull();
    expect(recipeFetches()).toHaveLength(0);
    expect(toastText()).toMatch(/check out or clear/i);
  });

  test('works on an empty cart', async function () {
    var core = load();
    core._setCart({});
    core._setSelectedRecipe(RECIPE);
    core._setSaleType('in-store');

    core.addRecipeToCart();
    await flushPromises();
    await flushPromises();

    expect(core._getRecipeContext().recipe_id).toBe('RCP-001');
    expect(core._getCart()['recipe-total'].item.rate).toBe(120);
  });

  test('replaces a recipe that is already in the cart', async function () {
    var core = load();
    asRecipeCart(core);
    core._setSelectedRecipe(RECIPE);
    core._setSaleType('in-store');

    core.addRecipeToCart();
    await flushPromises();
    await flushPromises();

    expect(recipeFetches()).toHaveLength(1);
    expect(core._getCart()['recipe-total']).toBeDefined();
  });
});

describe('a cart holding a recipe', function () {
  test('refuses products', function () {
    var core = load();
    asRecipeCart(core);

    core.addToCart(PRODUCT);

    expect(core._getCart().p1).toBeUndefined();
    expect(Object.keys(core._getCart())).toEqual(['recipe-ing-0-ing1', 'recipe-total']);
    expect(toastText()).toMatch(/recipe/i);
  });

  test('shows no custom item or gift card buttons, and a card-only note', function () {
    var core = load();
    asRecipeCart(core);
    core.renderCart();

    expect(document.getElementById('kiosk-add-custom-btn')).toBeNull();
    expect(document.getElementById('kiosk-add-gc-btn')).toBeNull();
    expect(document.querySelector('.kiosk-recipe-cart-note').textContent).toMatch(/card/i);
  });

  test('recipe lines have no quantity stepper', function () {
    var core = load();
    asRecipeCart(core);
    core.renderCart();

    expect(document.querySelectorAll('#kiosk-cart-items .kiosk-qty-btn')).toHaveLength(0);
    expect(document.querySelectorAll('#kiosk-cart-items .kiosk-qty-input')).toHaveLength(0);
  });

  test('changing a recipe line quantity is ignored', function () {
    var core = load();
    asRecipeCart(core);

    core.setQty('recipe-total', 3);

    expect(core._getCart()['recipe-total'].qty).toBe(1);
  });

  test('removing any recipe line removes the whole recipe', function () {
    var core = load();
    asRecipeCart(core);

    core.removeFromCart('recipe-ing-0-ing1');

    expect(core._getCart()).toEqual({});
    expect(core._getRecipeContext()).toBeNull();
  });
});

describe('checkout', function () {
  test('a recipe sale says it is card only', async function () {
    var core = load();
    asRecipeCart(core);

    core.proceedToPayment();
    await flushPromises();

    var panel = document.getElementById('kiosk-gc-panel');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toMatch(/card terminal only/i);
    expect(document.getElementById('kgcr-cash-btn')).toBeNull();
  });

  test('a products sale still offers Cash and Gift Card', async function () {
    var core = load();
    core._setCart({ p1: { item: PRODUCT, qty: 1 } });

    core.proceedToPayment();
    await flushPromises();

    expect(document.getElementById('kgcr-cash-btn')).not.toBeNull();
    expect(document.getElementById('kgcr-open-btn')).not.toBeNull();
  });
});

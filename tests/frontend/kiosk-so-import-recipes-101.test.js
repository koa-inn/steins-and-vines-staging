'use strict';

// Phase 101 review HI-02: recipe entries must never sit next to an imported
// Sales Order. The SO checkout charges only the SO's items, so a recipe in the
// same cart was never charged, invoiced or batched, and leaked into the next
// customer's cart. Harness copied from kiosk-mixed-recipe-checkout.test.js.

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
  MIDDLEWARE_URL: 'http://mw.test',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};


var DEVICE_TOKEN_KEY = 'sv_kiosk_device_token';

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 20; i++) { p = p.then(function () {}); }
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
  ['kiosk-toast-container', 'kiosk-product-grid', 'kiosk-payment-items', 'kiosk-payment-amount',
    'kiosk-terminal-msg', 'kiosk-spinner', 'kiosk-so-list'].forEach(function (id) { injectEl(id); });
  return core;
}

function respond(status, data) {
  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(data); } });
}

var RECIPE_ENTRY = {
  entry_id: 'r1', recipe_id: 'RCP-001', recipe_name: 'House Pale', sale_type: 'in-store', mill_grain: false,
  target_volume_l: 20, modified_ingredients: null, pricing_mode: 'locked', locked_price: 180,
  total_before_discount: 180, added_seq: 1, lines: [], fee_lines: []
};

var SO = { salesorder_id: 'SO-1', salesorder_number: 'SO-001234', customer_id: 'C-1', balance: 60, total: 60 };

function urlsCalled() {
  return global.fetch.mock.calls.map(function (c) { return String(c[0]); });
}

function toastText() {
  return document.getElementById('kiosk-toast-container').textContent;
}

// Routes the SO list + SO detail; everything else is an empty 200.
function mockSoBackend() {
  global.fetch.mockImplementation(function (url) {
    if (/\/api\/kiosk\/salesorders$/.test(url)) return respond(200, { salesorders: [SO] });
    if (/\/api\/kiosk\/salesorder\/SO-1$/.test(url)) {
      return respond(200, { line_items: [{ item_id: 'p1', name: 'Bottle Caps', quantity: 2, rate: 5 }] });
    }
    return respond(200, {});
  });
}

async function loadSoList(core) {
  core.loadSalesOrders();
  await flush();
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () { return respond(200, {}); });
  window.confirm = jest.fn(function () { return true; });
  global.confirm = window.confirm;
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('HI-02 Sales Order import vs recipe entries: ' + surfacePath, function () {
    test('a recipe-only cart still gets the "Replace current cart?" prompt, and declining keeps the recipe', async function () {
      var core = loadSurface(surfacePath);
      mockSoBackend();
      await loadSoList(core);
      core._setProductsLoaded(true);
      core._setCart({});
      core._setRecipeEntries([RECIPE_ENTRY]);
      window.confirm.mockReturnValue(false);

      core.importSoToCart('SO-1');
      await flush();

      expect(window.confirm).toHaveBeenCalledTimes(1);
      expect(core._getRecipeEntries()).toHaveLength(1);
      expect(core._getImportedSoId()).toBeNull();
      expect(urlsCalled().filter(function (u) { return /\/salesorder\/SO-1$/.test(u); })).toHaveLength(0);
    });

    test('accepting the import clears the recipe entries along with the cart', async function () {
      var core = loadSurface(surfacePath);
      mockSoBackend();
      await loadSoList(core);
      core._setProductsLoaded(true);
      core._setCart({});
      core._setRecipeEntries([RECIPE_ENTRY]);

      core.importSoToCart('SO-1');
      await flush();

      expect(core._getImportedSoId()).toBe('SO-1');
      expect(core._getRecipeEntries()).toHaveLength(0);
    });

    test('a recipe cannot be added while a Sales Order is imported', async function () {
      var core = loadSurface(surfacePath);
      core._setImportedSo('SO-1', 'SO-001234');
      core._setSelectedRecipe({ recipe_id: 'RCP-001', name: 'House Pale', locked_price: 180 });
      core._setSaleType('in-store');
      core._setRecipeAvailability(null);
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/recipes\/RCP-001$/.test(url)) {
          return respond(200, { recipe: { recipe_id: 'RCP-001', name: 'House Pale', locked_price: 180 }, ingredients: [] });
        }
        return respond(200, {});
      });

      core.addRecipeToCart();
      await flush();

      expect(core._getRecipeEntries()).toHaveLength(0);
      expect(urlsCalled().filter(function (u) { return /\/api\/recipes\//.test(u); })).toHaveLength(0);
      expect(toastText()).toMatch(/Sales Order/);
    });

    test('checkout refuses an imported Sales Order cart that still holds a recipe (nothing is sent)', async function () {
      var core = loadSurface(surfacePath);
      core._setCart({ p1: { item: { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 }, qty: 2 } });
      core._setRecipeEntries([RECIPE_ENTRY]);
      core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 190, discount_total: 0, tax_total: 9.5, total: 199.5 } });
      core._setImportedSo('SO-1', 'SO-001234');
      global.fetch.mockClear();

      core.proceedToPayment();
      await flush();

      expect(urlsCalled().filter(function (u) { return /salesorder-update|salesorder-pay|\/api\/kiosk\/sale/.test(u); })).toHaveLength(0);
      expect(toastText()).toMatch(/Sales Order/);
      expect(core._getRecipeEntries()).toHaveLength(1); // staff decide what to remove
    });
  });
});

'use strict';

// Phase 101 review WR-03: duplicates are allowed since D-02, so a double-
// registered tap on "Add to Cart" added the recipe twice (double charge, two
// BrewPad batches). One add at a time: a second call while the first is still
// loading is ignored. Harness copied from kiosk-mixed-recipe-checkout.test.js.

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
  var el = document.createElement(tag || 'div');
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
  ['kiosk-toast-container', 'kiosk-product-grid'].forEach(function (id) { injectEl(id); });
  injectEl('kiosk-add-recipe-to-cart', 'button');
  return core;
}

function respond(status, data) {
  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(data); } });
}

var RECIPE = { recipe_id: 'RCP-001', name: 'House Pale', locked_price: 180, pricing_mode: 'locked' };

function selectRecipe(core) {
  core._setSelectedRecipe(RECIPE);
  core._setSaleType('in-store');
  core._setRecipeAvailability(null);
}

function recipeFetches() {
  return global.fetch.mock.calls.filter(function (c) { return /\/api\/recipes\/RCP-001$/.test(String(c[0])); });
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.alert.mockClear();
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('WR-03 recipe add-to-cart re-entrancy: ' + surfacePath, function () {
    test('a double tap adds the recipe once and disables the button while loading', async function () {
      var core = loadSurface(surfacePath);
      var release;
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/recipes\/RCP-001$/.test(url)) {
          return new Promise(function (resolve) {
            release = function () {
              resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ recipe: RECIPE, ingredients: [] }); } });
            };
          });
        }
        return respond(200, {});
      });
      selectRecipe(core);
      var btn = document.getElementById('kiosk-add-recipe-to-cart');

      core.addRecipeToCart();
      core.addRecipeToCart();
      expect(recipeFetches()).toHaveLength(1);
      expect(btn.disabled).toBe(true);

      release();
      await flush();
      expect(core._getRecipeEntries()).toHaveLength(1);
      expect(btn.disabled).toBe(false);
    });

    test('a deliberate second add after the first finished still works (duplicates allowed, D-02)', async function () {
      var core = loadSurface(surfacePath);
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/recipes\/RCP-001$/.test(url)) return respond(200, { recipe: RECIPE, ingredients: [] });
        return respond(200, {});
      });
      selectRecipe(core);
      core.addRecipeToCart();
      await flush();
      selectRecipe(core);
      core.addRecipeToCart();
      await flush();
      expect(core._getRecipeEntries()).toHaveLength(2);
    });

    test('a failed load releases the guard so staff can try again', async function () {
      var core = loadSurface(surfacePath);
      var fail = true;
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/recipes\/RCP-001$/.test(url)) {
          if (fail) return Promise.reject(new Error('offline'));
          return respond(200, { recipe: RECIPE, ingredients: [] });
        }
        return respond(200, {});
      });
      selectRecipe(core);
      core.addRecipeToCart();
      await flush();
      expect(core._getRecipeEntries()).toHaveLength(0);
      expect(document.getElementById('kiosk-add-recipe-to-cart').disabled).toBe(false);

      fail = false;
      core.addRecipeToCart();
      await flush();
      expect(core._getRecipeEntries()).toHaveLength(1);
    });

    test('a response without a recipe releases the guard too', async function () {
      var core = loadSurface(surfacePath);
      global.fetch.mockImplementation(function () { return respond(200, {}); });
      selectRecipe(core);
      core.addRecipeToCart();
      await flush();
      global.fetch.mockClear();
      core.addRecipeToCart();
      expect(recipeFetches()).toHaveLength(1);
    });
  });
});

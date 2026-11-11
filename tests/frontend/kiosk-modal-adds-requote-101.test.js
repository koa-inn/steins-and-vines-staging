'use strict';

// Phase 101 review WR-02: the custom-item and gift-card modals (kiosk.js and
// admin.js, six cart writes) wrote the cart directly and never asked the
// server for a new price. A recipe cart is priced ONLY by the server
// cart-quote, so the old total stayed on screen and checkout was rejected as
// "Totals changed". Each add must put the quote back to pending and re-quote
// with the new line. Harness copied from kiosk-mixed-recipe-checkout.test.js.

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
  ['kiosk-toast-container', 'kiosk-product-grid', 'kiosk-cart-items', 'kiosk-cart-totals',
    'admin-modal', 'admin-modal-title', 'admin-modal-body'].forEach(function (id) { injectEl(id); });
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

function seedRecipeCart(core) {
  core._setCart({});
  core._setRecipeEntries([RECIPE_ENTRY]);
  core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 180, discount_total: 0, tax_total: 9, total: 189 } });
  core.renderCart();
}

function setValue(id, value) {
  var el = document.getElementById(id);
  if (!el) throw new Error('expected #' + id);
  el.value = value;
}

function click(id) {
  var el = document.getElementById(id);
  if (!el) throw new Error('expected #' + id);
  el.click();
}

function quoteBodies() {
  return global.fetch.mock.calls
    .filter(function (c) { return /\/api\/kiosk\/cart-quote$/.test(String(c[0])); })
    .map(function (c) { return JSON.parse(c[1].body); });
}

beforeEach(function () {
  jest.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () { return respond(200, {}); });
});

afterEach(function () {
  jest.useRealTimers();
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('WR-02 modal adds re-quote a recipe cart: ' + surfacePath, function () {
    test('custom item', function () {
      var core = loadSurface(surfacePath);
      seedRecipeCart(core);
      click('kiosk-add-custom-btn');
      setValue('kci-desc', 'Bottle rental');
      setValue('kci-price', '5');
      setValue('kci-qty', '1');
      click('kci-add');

      expect(Object.keys(core._getCart())).toHaveLength(1);
      expect(core._getCartQuote().status).toBe('pending');
      jest.advanceTimersByTime(300);
      var bodies = quoteBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0].items).toHaveLength(1);
      expect(bodies[0].items[0].description).toBe('Bottle rental');
      expect(bodies[0].recipes).toHaveLength(1);
    });

    test('gift certificate issue', function () {
      var core = loadSurface(surfacePath);
      seedRecipeCart(core);
      click('kiosk-add-gc-btn');
      setValue('kgci-cert', 'GC-000042');
      setValue('kgci-value', '50');
      click('kgci-issue');

      expect(Object.keys(core._getCart())).toHaveLength(1);
      expect(core._getCartQuote().status).toBe('pending');
      jest.advanceTimersByTime(300);
      var bodies = quoteBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0].items[0].gift_cert).toBe(true);
    });

    test('gift certificate reload', async function () {
      var core = loadSurface(surfacePath);
      seedRecipeCart(core);
      global.fetch.mockImplementation(function (url) {
        if (/gift-card\/lookup/.test(String(url))) {
          return respond(200, { ok: true, data: { cert_number: 'GC-000042', status: 'active', current_balance: 10 } });
        }
        return respond(200, {});
      });
      click('kiosk-add-gc-btn');
      click('kgci-mode-reload');
      setValue('kgci-cert', 'GC-000042');
      setValue('kgci-value', '25');
      click('kgci-issue');
      await flush();

      expect(Object.keys(core._getCart())).toHaveLength(1);
      expect(core._getCartQuote().status).toBe('pending');
      jest.advanceTimersByTime(300);
      var bodies = quoteBodies();
      expect(bodies).toHaveLength(1);
      expect(bodies[0].items[0].gift_action).toBe('reload');
    });

    test('a product-only cart is not quoted (no recipes, no server round trip)', function () {
      var core = loadSurface(surfacePath);
      core._setCart({});
      core._setRecipeEntries([]);
      core._setCartQuote(null);
      core.renderCart();
      click('kiosk-add-custom-btn');
      setValue('kci-desc', 'Bottle rental');
      setValue('kci-price', '5');
      setValue('kci-qty', '1');
      click('kci-add');
      jest.advanceTimersByTime(300);
      expect(Object.keys(core._getCart())).toHaveLength(1);
      expect(core._getCartQuote()).toBeNull();
      expect(quoteBodies()).toHaveLength(0);
    });
  });
});

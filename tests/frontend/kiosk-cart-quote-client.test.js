'use strict';

// Phase 101 (D-19, MIXR-11): client side of the server cart-quote. Debounced,
// sequence-checked fetch on cart change; checkout gated on an ok quote.

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
var MODS = [{ item_id: 'ING-1', item_name: 'Pale Malt', quantity: 9, unit: 'kg' }];
var QUOTE = { subtotal: 220, discount_total: 10, tax_total: 5.25, total: 215.25 };

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 12; i++) { p = p.then(function () {}); }
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
    'kiosk-terminal-msg', 'kiosk-spinner'].forEach(function (id) { injectEl(id); });
  injectEl('kiosk-cancel-payment', 'button');
  var confirm = injectEl('kiosk-confirm-payment', 'button');
  confirm.style.display = 'none';
  return core;
}

function respond(status, data) {
  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(data); } });
}

function deferred() {
  var d = {};
  d.promise = new Promise(function (resolve) { d.resolve = resolve; });
  return d;
}

function quoteCalls() {
  return global.fetch.mock.calls.filter(function (c) { return typeof c[0] === 'string' && /\/api\/kiosk\/cart-quote$/.test(c[0]); });
}

function saleCalls() {
  return global.fetch.mock.calls.filter(function (c) { return typeof c[0] === 'string' && /\/api\/kiosk\/sale$/.test(c[0]); });
}

function seedProduct(core) {
  core._setCart({ p1: { item: { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 }, qty: 2 } });
}

function seedRecipe(core) {
  core._setRecipeEntries([
    { entry_id: 'r1', recipe_id: 'RCP-001', recipe_name: 'House Pale', sale_type: 'in-store', mill_grain: true,
      target_volume_l: 20, modified_ingredients: MODS, pricing_mode: 'locked', locked_price: 120,
      total_before_discount: 120, added_seq: 1, lines: [{ junk: 1 }], fee_lines: [] }
  ]);
}

beforeEach(function () {
  jest.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () { return respond(200, QUOTE); });
});

afterEach(function () {
  jest.useRealTimers();
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('cart-quote client: ' + surfacePath, function () {
    test('recipe cart change sends one debounced POST and applies the server total', async function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      core.requestCartQuote();
      expect(core._getCartQuote().status).toBe('pending');
      expect(core.calcTotals().pending).toBe(true);
      expect(quoteCalls()).toHaveLength(0);

      jest.advanceTimersByTime(300);
      await flush();

      expect(quoteCalls()).toHaveLength(1);
      var call = quoteCalls()[0];
      expect(call[1].method).toBe('POST');
      var body = JSON.parse(call[1].body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].item_id).toBe('p1');
      expect(body.recipes).toEqual([{ recipe_id: 'RCP-001', sale_type: 'in-store', mill_grain: true, target_volume_l: 20, modified_ingredients: MODS }]);
      expect(core._getCartQuote().status).toBe('ok');
      expect(core.calcTotals().total).toBe(215.25);
    });

    test('two changes within the debounce produce one request', async function () {
      var core = loadSurface(surfacePath);
      seedRecipe(core);
      core.requestCartQuote();
      jest.advanceTimersByTime(100);
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(quoteCalls()).toHaveLength(1);
    });

    test('overlapping requests: only the latest response is applied', async function () {
      var core = loadSurface(surfacePath);
      seedRecipe(core);
      var first = deferred();
      var second = deferred();
      var n = 0;
      global.fetch.mockImplementation(function () {
        n++;
        return n === 1 ? first.promise : second.promise;
      });
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      expect(quoteCalls()).toHaveLength(2);

      second.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ subtotal: 1, discount_total: 0, tax_total: 0, total: 2 }); } });
      await flush();
      first.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ subtotal: 9, discount_total: 0, tax_total: 0, total: 99 }); } });
      await flush();

      expect(core._getCartQuote().status).toBe('ok');
      expect(core.calcTotals().total).toBe(2);
    });

    test('non-2xx and fetch rejection leave an error state', async function () {
      var core = loadSurface(surfacePath);
      seedRecipe(core);
      global.fetch.mockImplementation(function () { return respond(502, { error: 'x' }); });
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(core._getCartQuote().status).toBe('error');

      global.fetch.mockImplementation(function () { return Promise.reject(new Error('net')); });
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(core._getCartQuote().status).toBe('error');
      expect(core.calcTotals().pending).toBe(true);
    });

    test('product-only cart changes make no cart-quote request', async function () {
      var core = loadSurface(surfacePath);
      core.addToCart({ item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 });
      core.requestCartQuote();
      jest.advanceTimersByTime(500);
      await flush();
      expect(quoteCalls()).toHaveLength(0);
      expect(core._getCartQuote()).toBeNull();
    });

    test('adding and removing a recipe entry triggers a quote through the cart mutation paths', async function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      core.removeRecipeEntry('r1');
      jest.advanceTimersByTime(500);
      await flush();
      expect(quoteCalls()).toHaveLength(0); // no recipe left, product-only
      seedRecipe(core);
      core.setQty('p1', 3);
      jest.advanceTimersByTime(500);
      await flush();
      expect(quoteCalls()).toHaveLength(1);
      expect(JSON.parse(quoteCalls()[0][1].body).items[0].quantity).toBe(3);
    });

    test('checkout makes no sale request while the quote is pending or errored', function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      core._setCartQuote({ seq: 1, status: 'pending', data: null });
      core.proceedToPayment();
      core._setCartQuote({ seq: 1, status: 'error', data: null });
      core.proceedToPayment();
      expect(saleCalls()).toHaveLength(0);
    });

    test('cart-quote 404 from an old middleware leaves Checkout blocked with no sale request', async function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      global.fetch.mockImplementation(function () { return respond(404, { error: 'not found' }); });
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(core._getCartQuote().status).toBe('error');
      core.proceedToPayment();
      expect(saleCalls()).toHaveLength(0);
    });

    test('a change after the quote resolved re-pends the quote and blocks checkout', async function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(core._getCartQuote().status).toBe('ok');
      core.setQty('p1', 5);
      expect(core._getCartQuote().status).toBe('pending');
      core.proceedToPayment();
      expect(saleCalls()).toHaveLength(0);
    });

    test('an ok quote lets checkout start and the sale carries client_grand_total = quote total', async function () {
      var core = loadSurface(surfacePath);
      seedProduct(core);
      seedRecipe(core);
      core._setCustomer({ contact_id: 'C-1', name: 'Jane', email: 'jane@example.com' });
      core.requestCartQuote();
      jest.advanceTimersByTime(300);
      await flush();
      expect(core.calcTotals().total).toBe(215.25);
      core.proceedToPayment();
      var skip = document.getElementById('kgcr-skip-btn');
      expect(skip).toBeTruthy();
      skip.click();
      await flush();
      var sales = saleCalls();
      expect(sales).toHaveLength(1);
      expect(JSON.parse(sales[0][1].body).client_grand_total).toBe(215.25);
    });
  });
});

'use strict';

// Phase 101 (D-09, D-10, D-16, D-19): a cart with recipe entries checks out
// through the ONE standard route (/api/kiosk/sale + /sale/confirm) on every
// tender, with parameters-only recipe wire objects and the quote total as
// client_grand_total. Runs against both the standalone kiosk and the admin POS.

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
var QUOTE_TOTAL = 215.25;

var WIRE_KEYS = ['mill_grain', 'modified_ingredients', 'recipe_id', 'sale_type', 'target_volume_l'];
var MODS = [{ item_id: 'ING-1', item_name: 'Pale Malt', quantity: 9, unit: 'kg' }];

function flush() {
  var p = Promise.resolve();
  for (var i = 0; i < 10; i++) { p = p.then(function () {}); }
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
  var cancel = injectEl('kiosk-cancel-payment', 'button');
  cancel.id = 'kiosk-cancel-payment';
  var confirm = injectEl('kiosk-confirm-payment', 'button');
  confirm.style.display = 'none';
  return core;
}

function seedMixedCart(core, opts) {
  opts = opts || {};
  core._setCart({ p1: { item: { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 }, qty: 2 } });
  core._setRecipeEntries([
    { entry_id: 'r1', recipe_id: 'RCP-001', recipe_name: 'House Pale', sale_type: 'in-store', mill_grain: true,
      target_volume_l: 20, modified_ingredients: MODS, pricing_mode: 'locked', locked_price: 120,
      total_before_discount: 120, added_seq: 1, lines: [{ junk: 1 }], fee_lines: [] },
    { entry_id: 'r2', recipe_id: 'RCP-002', recipe_name: 'Dark Stout', sale_type: 'take-home', mill_grain: false,
      target_volume_l: 40, modified_ingredients: null, pricing_mode: 'locked', locked_price: 90,
      total_before_discount: 90, added_seq: 2, lines: [], fee_lines: [] }
  ]);
  core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 220, discount_total: 10, tax_total: 5.25, total: QUOTE_TOTAL } });
  core._setCustomer(opts.customer === undefined ? { contact_id: 'C-1', name: 'Jane', email: 'jane@example.com' } : opts.customer);
}

function salePostBodies() {
  return global.fetch.mock.calls
    .filter(function (c) { return typeof c[0] === 'string' && /\/api\/kiosk\/sale$/.test(c[0]); })
    .map(function (c) { return JSON.parse(c[1].body); });
}

function confirmBodies() {
  return global.fetch.mock.calls
    .filter(function (c) { return typeof c[0] === 'string' && /\/api\/kiosk\/sale\/confirm$/.test(c[0]); })
    .map(function (c) { return JSON.parse(c[1].body); });
}

function assertRecipeWire(body) {
  expect(body.recipes).toHaveLength(2);
  body.recipes.forEach(function (r) { expect(Object.keys(r).sort()).toEqual(WIRE_KEYS); });
  expect(body.recipes[0]).toEqual({ recipe_id: 'RCP-001', sale_type: 'in-store', mill_grain: true, target_volume_l: 20, modified_ingredients: MODS });
  expect(body.recipes[1].recipe_id).toBe('RCP-002');
  expect(body.recipes[1].modified_ingredients).toBeNull();
  expect(body.customer_email).toBe('jane@example.com');
  expect(body.override).toBe(false);
}

function respond(status, data) {
  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(data); } });
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () { return respond(200, {}); });
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('mixed recipe checkout: ' + surfacePath, function () {
    test('tender panel is shown for a recipe cart with gift card, cash, phone order and no terminal-only note', function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      core.proceedToPayment();

      var panel = document.getElementById('kiosk-gc-panel');
      expect(panel).toBeTruthy();
      expect(panel.style.display).not.toBe('none');
      expect(panel.querySelector('#kgcr-open-btn')).toBeTruthy();
      expect(panel.querySelector('#kgcr-cash-btn')).toBeTruthy();
      expect(panel.querySelector('#kgcr-moto-btn')).toBeTruthy();
      expect(panel.querySelector('#kgcr-skip-btn')).toBeTruthy();
      expect(panel.textContent).not.toMatch(/card terminal only/i);
      expect(salePostBodies()).toHaveLength(0); // nothing is pushed before staff pick a tender
    });

    test('card terminal: /sale then /sale/confirm both carry recipes, override and customer_email', async function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(202, { ok: true, pending: true, reference: 'REF-1' });
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();

      var sale = salePostBodies()[0];
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].item_id).toBe('p1');
      assertRecipeWire(sale);
      expect(sale.client_grand_total).toBe(QUOTE_TOTAL);

      document.getElementById('kiosk-confirm-payment').click();
      await flush();
      var confirm = confirmBodies()[0];
      expect(confirm).toBeTruthy();
      expect(confirm.recipes).toEqual(sale.recipes);
      expect(confirm.override).toBe(false);
      expect(confirm.customer_email).toBe('jane@example.com');
    });

    test('cash: /sale (tender cash) then /sale/confirm both carry recipes, override and customer_email', async function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(202, { ok: true, cash: true, reference: 'REF-C' });
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-cash-btn').click();
      var tendered = document.getElementById('kcash-tendered');
      tendered.value = '300';
      tendered.dispatchEvent(new Event('input'));
      document.getElementById('kcash-complete-btn').click();
      await flush();

      var sale = salePostBodies()[0];
      expect(sale.tender).toBe('cash');
      assertRecipeWire(sale);
      expect(sale.client_grand_total).toBe(QUOTE_TOTAL);
      var confirm = confirmBodies()[0];
      expect(confirm).toBeTruthy();
      expect(confirm.tender).toBe('cash');
      expect(confirm.recipes).toEqual(sale.recipes);
      expect(confirm.override).toBe(false);
      expect(confirm.customer_email).toBe('jane@example.com');
    });

    test('phone order: /sale (tender moto) carries recipes, override and customer_email', async function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      global.fetch.mockImplementation(function () { return respond(500, { error: 'stop here' }); });
      core.proceedToPayment();
      document.getElementById('kgcr-moto-btn').click();
      await flush();

      var sale = salePostBodies()[0];
      expect(sale.tender).toBe('moto');
      assertRecipeWire(sale);
      expect(sale.client_grand_total).toBe(QUOTE_TOTAL);
    });

    test('the moto confirm shares the same confirm body builder (recipes, override, customer_email)', function () {
      var fs = require('fs');
      var path = require('path');
      var src = fs.readFileSync(path.join(__dirname, '../../js/kiosk-core.js'), 'utf8');
      var start = src.indexOf("fetch(mwUrl + '/api/kiosk/sale/confirm'");
      var end = src.indexOf('.then', start);
      var block = src.slice(start, end);
      expect(block).toContain('recipes: recipeWire.length ? recipeWire : undefined');
      expect(block).toContain('override: _kioskStockOverride');
      expect(block).toContain('customer_email: saleCustomerEmail');
      // moto resolves through confirmSale(txnId, 'moto')
      expect(src).toContain("confirmSale(");
    });

    test('no fetch ever targets the legacy recipe-sale routes', async function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(202, { ok: true, pending: true, reference: 'REF-1' });
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();
      document.getElementById('kiosk-confirm-payment').click();
      await flush();
      global.fetch.mock.calls.forEach(function (c) { expect(String(c[0])).not.toMatch(/recipe-sale/); });
    });

    test('a product-only cart sends no recipes key', async function () {
      var core = loadSurface(surfacePath);
      core._setCart({ p1: { item: { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 }, qty: 2 } });
      global.fetch.mockImplementation(function () { return respond(500, { error: 'x' }); });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();
      var sale = salePostBodies()[0];
      expect(sale.recipes).toBeUndefined();
      expect(sale.override).toBe(false);
    });

    test('a recipe cart with no ok quote does not start checkout (never a client-priced total)', async function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      core._setCartQuote({ seq: 2, status: 'pending', data: null });
      core.proceedToPayment();
      await flush();
      expect(document.getElementById('kiosk-gc-panel')).toBeNull();
      expect(salePostBodies()).toHaveLength(0);
    });

    test('_kioskStockOverride resets at the top of proceedToPayment (Pitfall 5)', function () {
      var core = loadSurface(surfacePath);
      seedMixedCart(core);
      core._setStockOverride(true);
      core.proceedToPayment();
      expect(core._getStockOverride()).toBe(false);
    });
  });
});

'use strict';

// Phase 67 review fix (WR-04) — recipe sales previously bypassed the
// quote-vs-charge divergence contract entirely: recipeSaleBody carried no
// client_grand_total / client_tax_total, so /api/kiosk/recipe-sale had no
// way to detect that the payment screen's displayed total diverged from the
// server's recomputed charge (the dynamically-priced recipe path is
// arguably the highest-divergence surface).
//
// Contract this test pins: POST /api/kiosk/sale carries
// client_grand_total === totals.total and client_tax_total === totals.tax
// (same field names as the standard sale body, pinned by the 67-01
// interface contract). The SERVER side of this contract is log-only for
// recipes (see pos-recipe.test.js WR-04a..c for why it must not block).
//
// Harness mirrors kiosk-missing-tax.test.js.

global.window = global.window || {};
global.navigator = global.navigator || { userAgent: 'test' };

global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };

global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
});

global.alert = jest.fn();

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

function loadSurface(path) {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  var mod = require(path); // intentional dynamic per-surface isolation
  return { mod: mod, core: global.window.KioskCore };
}

function injectEl(id, tag) {
  var el = document.createElement(tag || 'div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

beforeEach(function () {
  localStorage.clear();
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  });
});

describe('WR-04 — recipe sale body carries the kiosk displayed totals', function () {

  test('POST /api/kiosk/sale carries client_grand_total and client_tax_total matching the displayed totals', async function () {
    localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
    var core = loadSurface('../../js/kiosk.js').core;
    injectEl('kiosk-product-grid');
    injectEl('kiosk-payment-items');
    injectEl('kiosk-payment-amount');
    injectEl('kiosk-terminal-msg');
    injectEl('kiosk-spinner');

    // A recipe cart: totals come only from the server cart-quote (D-19).
    core._setCart({});
    core._setRecipeEntries([{ entry_id: 'r1', recipe_id: 'RCP-001', recipe_name: 'R', sale_type: 'in-store', mill_grain: false, target_volume_l: 20, modified_ingredients: null }]);
    core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 62.5, discount_total: 0, tax_total: 2.25, total: 64.75 } });

    var totals = core.calcTotals();
    expect(totals.total).toBe(64.75);
    expect(totals.tax).toBe(2.25);

    core.proceedToPayment();
    document.getElementById('kgcr-skip-btn').click(); // tender panel is always shown (D-09)
    await flushPromises();

    var saleCall = global.fetch.mock.calls.find(function (c) {
      return typeof c[0] === 'string' && /\/api\/kiosk\/(recipe-)?sale$/.test(c[0]);
    });
    expect(saleCall).toBeTruthy();
    var body = JSON.parse(saleCall[1].body);
    // Same field names as the standard sale body (67-01 interface contract).
    expect(body.client_grand_total).toBe(totals.total);
    expect(body.client_tax_total).toBe(totals.tax);
    // Existing recipe body fields must be untouched by the addition.
    expect(body.recipes[0].recipe_id).toBe('RCP-001');
    expect(body.recipes[0].sale_type).toBe('in-store');
  });

  test('Checkout is disabled + aria-busy while the recipe cart quote is not ok, enabled once ok', function () {
    localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
    var core = loadSurface('../../js/kiosk.js').core;
    injectEl('kiosk-cart-items');
    injectEl('kiosk-cart-totals');
    injectEl('kiosk-checkout-total');
    var btn = injectEl('kiosk-checkout-btn', 'button');
    core._setCart({});
    core._setRecipeEntries([{ entry_id: 'r1', recipe_id: 'RCP-001', recipe_name: 'R', sale_type: 'in-store', total_before_discount: 50 }]);
    core._setCartQuote({ seq: 1, status: 'pending', data: null });
    core.renderCart();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 50, discount_total: 0, tax_total: 0, total: 50 } });
    core.renderCart();
    expect(btn.disabled).toBe(false);
    expect(btn.hasAttribute('aria-busy')).toBe(false);
  });
});

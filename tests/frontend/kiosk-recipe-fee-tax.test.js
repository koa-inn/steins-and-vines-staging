'use strict';

// Recipe fee tax (2026-10-13): the server now charges recipe sales pre-tax
// total + fee tax (Makers 5%, Materials 12%) and returns it as the quote's
// tax_total. A locked recipe cart is one untaxed "Package Price" line, so the
// kiosk must show the server's tax_total or it displays less than the
// terminal charges. Harness copied from kiosk-tax-rounding-entity-level.test.js.
global.window = global.window || {};
global.navigator = global.navigator || { userAgent: 'test' };
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.alert = jest.fn();
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
});
global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://localhost:3001',
  MW_API_KEY: 'test-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

function loadCore() {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require('../../js/kiosk.js'); // eslint-disable-line global-require -- per-test isolation
  return global.window.KioskCore;
}

function line(id, name, rate, pct) {
  return { item: { item_id: id, name: name, rate: rate, tax_percentage: pct }, qty: 1 };
}

function recipeCore(quoteData, discount) {
  var core = loadCore();
  core.init({
    getRecipeEntries: function () { return [{ recipe_id: 'SV-R-000002', sale_type: 'in-store' }]; },
    getDiscount: function () { return discount || null; }
  });
  core._setCartQuote(quoteData === null ? null : { seq: 1, status: quoteData.status || 'ok', data: quoteData });
  core._setCart({ prod: line('P1', 'Product', 10, 5) });
  return core;
}

describe('kioskCalcTotals — recipe carts show the server cart-quote (D-19)', function () {
  test('uses the quote values: subtotal 120, tax 2.85, total 122.85', function () {
    var t = recipeCore({ subtotal: 120, discount_total: 0, tax_total: 2.85, total: 122.85 }).calcTotals();
    expect(t.subtotal).toBe(120);
    expect(t.tax).toBe(2.85);
    expect(t.total).toBe(122.85);
  });

  test('shows the server discount and tax together', function () {
    var t = recipeCore(
      { subtotal: 120, discount_total: 10, tax_total: 2.35, total: 112.35 },
      { scope: 'cart', type: 'fixed', value: 10 }
    ).calcTotals();
    expect(t.discount).toBe(10);
    expect(t.tax).toBe(2.35);
    expect(t.total).toBe(112.35);
  });

  test('no quote yet -> pending, never a client-computed total', function () {
    var t = recipeCore(null).calcTotals();
    expect(t.pending).toBe(true);
    expect(t.total).toBe(0);
  });

  test('pending quote -> pending', function () {
    var t = recipeCore({ status: 'pending' }).calcTotals();
    expect(t.pending).toBe(true);
    expect(t.error).toBe(false);
  });

  test('error quote -> pending + error', function () {
    var t = recipeCore({ status: 'error' }).calcTotals();
    expect(t.pending).toBe(true);
    expect(t.error).toBe(true);
  });

  test('standard (non-recipe) carts ignore any stale recipe quote', function () {
    var core = loadCore();
    core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 1, discount_total: 0, tax_total: 9, total: 10 } });
    core._setQuote({ ok: true, recipe_id: 'SV-R-000002', total: 120, tax_total: 2.85 });
    core._setCart({ makers: line('makers', 'Makers Fee', 45, 5) });
    expect(core.calcTotals().tax).toBe(2.25);
  });
});

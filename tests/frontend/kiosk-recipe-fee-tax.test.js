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

function recipeCore(quote, discount) {
  var core = loadCore();
  core.init({
    getRecipeEntries: function () { return [{ recipe_id: 'SV-R-000002', sale_type: 'in-store' }]; },
    getDiscount: function () { return discount || null; }
  });
  core._setQuote(quote);
  core._setCart({ pkg: line('SV-R-000002', 'Czech Lager — Package Price', 120, 0) });
  return core;
}

describe('kioskCalcTotals — recipe carts show the server fee tax', function () {
  test('uses the quote tax_total: 120 + 2.85 = 122.85', function () {
    var t = recipeCore({ ok: true, recipe_id: 'SV-R-000002', total: 120, tax_total: 2.85, total_with_tax: 122.85 }).calcTotals();
    expect(t.tax).toBe(2.85);
    expect(t.total).toBe(122.85);
  });

  test('applies the server discount and the server tax together', function () {
    var t = recipeCore(
      { ok: true, recipe_id: 'SV-R-000002', total: 110, total_before_discount: 120, tax_total: 2.35,
        total_with_tax: 112.35, discount: { amount: 10, name: 'Staff' } },
      { scope: 'cart', type: 'fixed', value: 10 }
    ).calcTotals();
    expect(t.discount).toBe(10);
    expect(t.tax).toBe(2.35);
    expect(t.total).toBe(112.35);
  });

  test('falls back to line tax when the quote has no tax_total (older server)', function () {
    var t = recipeCore({ ok: true, recipe_id: 'SV-R-000002', total: 120 }).calcTotals();
    expect(t.tax).toBe(0);
    expect(t.total).toBe(120);
  });

  test('standard (non-recipe) carts ignore any stale recipe quote', function () {
    var core = loadCore();
    core._setQuote({ ok: true, recipe_id: 'SV-R-000002', total: 120, tax_total: 2.85 });
    core._setCart({ makers: line('makers', 'Makers Fee', 45, 5) });
    expect(core.calcTotals().tax).toBe(2.25);
  });
});

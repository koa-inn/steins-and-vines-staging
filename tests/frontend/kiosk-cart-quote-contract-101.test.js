'use strict';

// Phase 101 review WR-01: client side of the cart-quote contract. The quote
// responses here are REAL server output: zoho-middleware/__tests__/
// pos-cart-quote-contract-101.test.js pins the fixture file to what the route
// returns. The server's `subtotal` is the discounted, products-only subtotal,
// so rendering it as the cart Subtotal showed "$0.00" on a recipe-only cart
// and rows that did not add up next to a Discount row.

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


var CONTRACT = require('../../zoho-middleware/__tests__/fixtures/cart-quote-contract-101.json');

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
    'kiosk-subtotal', 'kiosk-tax', 'kiosk-total'].forEach(function (id) { injectEl(id); });
  return core;
}

function r2(n) { return Math.round(n * 100) / 100; }

function seed(core, c) {
  core._setCart({});
  core._setRecipeEntries(c.request.recipes.map(function (r, i) {
    return {
      entry_id: 'r' + (i + 1), recipe_id: r.recipe_id, recipe_name: r.recipe_id, sale_type: r.sale_type,
      mill_grain: false, target_volume_l: null, modified_ingredients: null, pricing_mode: 'locked',
      total_before_discount: 0, added_seq: i + 1, lines: [], fee_lines: []
    };
  }));
  core._setCartQuote({ seq: 1, status: 'ok', data: c.response });
}

beforeEach(function () {
  localStorage.clear();
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  });
});

test('the fixture is real server output with recipes in every case', function () {
  expect(CONTRACT.length).toBeGreaterThanOrEqual(4);
  CONTRACT.forEach(function (c) {
    expect(Object.keys(c.response).sort()).toEqual(
      ['discount', 'discount_total', 'recipes', 'stock', 'subtotal', 'tax_total', 'total']);
    expect(c.response.recipes.length).toBeGreaterThan(0);
  });
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('WR-01 totals from a real cart-quote response: ' + surfacePath, function () {
    CONTRACT.forEach(function (c) {
      test(c.name + ': Subtotal is the gross cart and the rows add up', function () {
        var core = loadSurface(surfacePath);
        seed(core, c);
        var t = core.calcTotals();
        expect(t.pending).toBeFalsy();
        expect(t.subtotal).toBe(c.gross);
        expect(t.discount).toBe(c.response.discount_total);
        expect(t.tax).toBe(c.response.tax_total);
        expect(t.total).toBe(c.response.total);
        expect(r2(t.subtotal - t.discount + t.tax)).toBe(t.total);
      });
    });

    test('a recipe-only cart never renders "Subtotal $0.00"', function () {
      var core = loadSurface(surfacePath);
      seed(core, CONTRACT[0]);
      core.renderCart();
      expect(document.getElementById('kiosk-subtotal').textContent).toBe('$245.00');
      expect(document.getElementById('kiosk-total').textContent).toBe('$249.21');
    });
  });
});

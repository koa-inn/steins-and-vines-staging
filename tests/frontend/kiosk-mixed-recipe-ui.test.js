'use strict';

// Phase 101 Plan 12 (D-04..D-08, D-12, D-13, D-14, D-19, D-15): grouped recipe
// blocks, quote pending/error rows, the shared low-stock panel on every tender,
// total-changed message and recipe sections on payment + receipt. Runs against
// both the standalone kiosk and the admin POS.

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
var PRODUCT = { item_id: 'p1', name: 'Bottle Caps', rate: 5, tax_percentage: 5, product_type: 'goods', stock_on_hand: 50 };

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

function respond(status, data) {
  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(data); } });
}

function loadSurface(path) {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require(path); // eslint-disable-line global-require -- per-surface isolation
  var core = global.window.KioskCore;
  ['kiosk-toast-container', 'kiosk-cart-items', 'kiosk-cart-totals', 'kiosk-checkout-btn',
    'kiosk-checkout-total', 'kiosk-subtotal', 'kiosk-tax', 'kiosk-total', 'kiosk-product-grid',
    'kiosk-payment-items', 'kiosk-payment-amount', 'kiosk-terminal-msg', 'kiosk-spinner',
    'kiosk-receipt-body', 'kiosk-error-title', 'kiosk-error-msg', 'kiosk-view-browse',
    'kiosk-view-payment', 'kiosk-view-error', 'kiosk-view-receipt', 'kiosk-stock-conflict'].forEach(function (id) { injectEl(id); });
  injectEl('kiosk-cancel-payment', 'button');
  injectEl('kiosk-confirm-payment', 'button').style.display = 'none';
  return core;
}

function entry(id, recipeId, name, seq, extra) {
  var e = {
    entry_id: id, recipe_id: recipeId, recipe_name: name, sale_type: 'in-store', mill_grain: false,
    target_volume_l: 23, modified_ingredients: null, pricing_mode: 'locked', locked_price: 120,
    total_before_discount: 120, added_seq: seq,
    lines: [{ name: 'Pale Malt', qty_text: '5 kg', amount: 15 }],
    fee_lines: [{ name: 'Brewing fee', amount: 20 }]
  };
  Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
  return e;
}

function seedCart(core, entries, withQuote) {
  core._setCart({
    p1: { item: PRODUCT, qty: 1, added_seq: 1 },
    'bundle-line': { item: { item_id: 'b', name: 'Canning bundle', rate: 10, tax_percentage: 5, bundle_key: 'beer-25' }, qty: 1, added_seq: 3 }
  });
  core._setRecipeEntries(entries);
  if (withQuote !== false) {
    core._setCartQuote({ seq: 1, status: 'ok', data: {
      subtotal: 220, discount_total: 0, tax_total: 0, total: QUOTE_TOTAL,
      recipes: entries.map(function (e, i) { return { index: i, label: e.recipe_name, pre_tax: 100 + i }; })
    } });
  }
}

function mixedEntries() {
  return [entry('r1', 'RCP-001', 'House Pale', 2), entry('r2', 'RCP-001', 'House Pale', 4, { sale_type: 'take-out', mill_grain: true })];
}

beforeEach(function () {
  localStorage.clear();
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () { return respond(200, {}); });
});

['../../js/kiosk.js', '../../js/admin.js'].forEach(function (surfacePath) {
  describe('mixed recipe UI: ' + surfacePath, function () {
    test('blocks render interleaved with other lines in add order with #n labels', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      core.renderCart();
      var lines = Array.prototype.slice.call(document.querySelectorAll('#kiosk-cart-items > .kiosk-cart-line'));
      expect(lines).toHaveLength(4);
      expect(lines[0].textContent).toMatch(/Bottle Caps/);
      expect(lines[1].classList.contains('kiosk-recipe-group')).toBe(true);
      expect(lines[1].querySelector('.kiosk-recipe-group-name').textContent).toBe('House Pale #1');
      expect(lines[2].classList.contains('kiosk-bundle-group')).toBe(true);
      expect(lines[3].querySelector('.kiosk-recipe-group-name').textContent).toBe('House Pale #2');
    });

    test('block shows meta, server total, detail lines, one 44px remove and no stepper', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      core.renderCart();
      var blocks = document.querySelectorAll('.kiosk-recipe-group');
      expect(blocks[0].querySelector('.kiosk-recipe-group-meta').textContent).toBe('23 L · Brew in store');
      expect(blocks[1].querySelector('.kiosk-recipe-group-meta').textContent).toBe('23 L · Take-out · Milled');
      expect(blocks[0].querySelector('.kiosk-recipe-group-total').textContent).toBe('$100.00');
      expect(blocks[1].querySelector('.kiosk-recipe-group-total').textContent).toBe('$101.00');
      expect(blocks[0].textContent).toMatch(/5 kg Pale Malt/);
      expect(blocks[0].textContent).toMatch(/Brewing fee/);
      expect(blocks[0].querySelector('.kiosk-qty-btn')).toBeNull();
      expect(blocks[0].querySelector('.kiosk-cart-remove-btn')).toBeNull();
      var rm = blocks[1].querySelectorAll('button.kiosk-recipe-remove');
      expect(rm).toHaveLength(1);
      expect(rm[0].getAttribute('aria-label')).toBe('Remove House Pale #2 from cart');
    });

    test('clicking the remove button removes only that entry and the label drops its number', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      core.renderCart();
      document.querySelectorAll('button.kiosk-recipe-remove')[1].click();
      expect(core._getRecipeEntries().map(function (e) { return e.entry_id; })).toEqual(['r1']);
      expect(core._getCart().p1).toBeDefined();
      expect(core._getCart()['bundle-line']).toBeDefined();
      expect(document.querySelector('.kiosk-recipe-group-name').textContent).toBe('House Pale');
    });

    test('names are escaped (no element injection)', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, [entry('r1', 'RCP-009', '<img src=x onerror=alert(1)>', 2, { lines: [{ name: '<b id=evil>', qty_text: '1 kg' }] })]);
      core.renderCart();
      expect(document.querySelector('#kiosk-cart-items img')).toBeNull();
      expect(document.getElementById('evil')).toBeNull();
    });

    test('pending quote shows Calculating and disables Checkout', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries(), false);
      core._setCartQuote({ seq: 1, status: 'pending', data: null });
      core.renderCart();
      expect(document.getElementById('kiosk-total').textContent).toBe('Calculating…');
      expect(document.getElementById('kiosk-checkout-btn').disabled).toBe(true);
    });

    test('quote error shows the inline alert and retry re-requests the quote', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries(), false);
      core._setCartQuote({ seq: 1, status: 'error', data: null });
      core.renderCart();
      var err = document.querySelector('.kiosk-quote-error');
      expect(err.getAttribute('role')).toBe('alert');
      expect(err.textContent).toContain("Couldn't price this cart. Check the connection and try again.");
      expect(document.getElementById('kiosk-checkout-btn').disabled).toBe(true);
      global.fetch.mockClear();
      var btn = err.querySelector('button');
      expect(btn.textContent).toBe('Try pricing again');
      jest.useFakeTimers();
      btn.click();
      jest.advanceTimersByTime(400);
      jest.useRealTimers();
      var q = global.fetch.mock.calls.filter(function (c) { return /cart-quote/.test(c[0]); });
      expect(q.length).toBe(1);
    });

    test('add custom item shows for a recipe cart; empty copy only when nothing is in the cart', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      core.renderCart();
      expect(document.getElementById('kiosk-add-custom-btn')).not.toBeNull();
      expect(document.querySelector('.kiosk-cart-empty')).toBeNull();
      core._setCart({});
      core._setRecipeEntries([]);
      core.renderCart();
      expect(document.querySelector('.kiosk-cart-empty')).not.toBeNull();
    });

    function stockBody() {
      return {
        error: 'Insufficient stock for scaled batch',
        conflicts: [
          { item_id: 'i1', item_name: 'Pale malt', needed: 5, stock: 3, unit: 'kg', recipes: ['House Pale #2'] },
          { item_id: 'i2', item_name: 'Cascade', needed: 100, stock: 40, unit: 'g', recipes: ['House Pale #1', 'House Pale #2'] }
        ]
      };
    }

    function salePosts() {
      return global.fetch.mock.calls.filter(function (c) { return typeof c[0] === 'string' && /\/api\/kiosk\/sale$/.test(c[0]); });
    }

    ['card', 'cash', 'moto'].forEach(function (tender) {
      test('409 on ' + tender + ' opens the shared panel; Sell anyway resubmits with override and the same key', async function () {
        var core = loadSurface(surfacePath);
        seedCart(core, mixedEntries());
        core._setCustomer({ contact_id: 'C-1', name: 'Jane', email: 'j@x.ca' });
        var calls = 0;
        global.fetch.mockImplementation(function (url) {
          if (/\/api\/kiosk\/sale$/.test(url)) {
            calls++;
            return calls === 1 ? respond(409, stockBody()) : respond(500, { error: 'stop' });
          }
          return respond(200, {});
        });
        core.proceedToPayment();
        if (tender === 'card') document.getElementById('kgcr-skip-btn').click();
        if (tender === 'moto') document.getElementById('kgcr-moto-btn').click();
        if (tender === 'cash') {
          document.getElementById('kgcr-cash-btn').click();
          var t = document.getElementById('kcash-tendered');
          t.value = '300';
          t.dispatchEvent(new Event('input'));
          document.getElementById('kcash-complete-btn').click();
        }
        await flush();

        var panel = document.getElementById('kiosk-stock-conflict');
        expect(panel.style.display).not.toBe('none');
        expect(panel.getAttribute('role')).toBe('alert');
        expect(panel.querySelector('.kiosk-stock-conflict-title').textContent).toBe('Not enough stock');
        expect(panel.textContent).toContain('House Pale #2');
        expect(panel.textContent).toContain('- Pale malt: need 5 kg, have 3 kg');
        expect(panel.textContent).toContain('Combined need is more than we have.');
        expect(document.getElementById('kiosk-stock-override-btn').textContent).toBe('Sell anyway');
        var first = JSON.parse(salePosts()[0][1].body);
        expect(first.override).toBe(false);

        document.getElementById('kiosk-stock-override-btn').click();
        await flush();
        var posts = salePosts();
        expect(posts).toHaveLength(2);
        var second = JSON.parse(posts[1][1].body);
        expect(second.override).toBe(true);
        expect(second.idempotency_key).toBe(first.idempotency_key);
      });
    });

    test('Back to cart hides the panel, returns to the cart and sends nothing more', async function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(409, stockBody());
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();
      global.fetch.mockClear();
      document.getElementById('kiosk-stock-back-btn').click();
      expect(document.getElementById('kiosk-stock-conflict').style.display).toBe('none');
      expect(document.getElementById('kiosk-view-browse').style.display).toBe('');
      expect(document.getElementById('kiosk-view-payment').style.display).toBe('none');
      expect(salePosts()).toHaveLength(0);
    });

    test('a 409 panel escapes recipe and ingredient names', async function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) {
          return respond(409, { conflicts: [{ item_id: 'i', item_name: '<img src=x onerror=alert(1)>', needed: 1, stock: 0, unit: 'kg', recipes: ['<i id=evil>x'] }] });
        }
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();
      expect(document.querySelector('#kiosk-stock-conflict img')).toBeNull();
      expect(document.getElementById('evil')).toBeNull();
    });

    test('server total-changed rejection shows the review message and charges nothing', async function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(400, { error: 'Totals changed — refresh the product list and re-ring the sale.' });
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-skip-btn').click();
      await flush();
      expect(document.getElementById('kiosk-error-msg').textContent).toBe('The total changed. Review the cart and check out again.');
      expect(core._getRecipeEntries()).toHaveLength(2);
      expect(confirmPosts()).toHaveLength(0);
    });

    function confirmPosts() {
      return global.fetch.mock.calls.filter(function (c) { return typeof c[0] === 'string' && /\/sale\/confirm$/.test(c[0]); });
    }

    test('payment screen lists a section per recipe then other items', function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      core.proceedToPayment();
      var html = document.getElementById('kiosk-payment-items').innerHTML;
      expect(html.indexOf('House Pale #1')).toBeGreaterThan(-1);
      expect(html.indexOf('House Pale #2')).toBeGreaterThan(html.indexOf('House Pale #1'));
      expect(html.indexOf('Bottle Caps')).toBeGreaterThan(html.indexOf('House Pale #2'));
      expect(html).toContain('23 L · Take-out · Milled');
      expect(html).toContain('5 kg Pale Malt');
    });

    test('receipt shows recipe sections, one total', async function () {
      var core = loadSurface(surfacePath);
      seedCart(core, mixedEntries());
      global.fetch.mockImplementation(function (url) {
        if (/\/api\/kiosk\/sale$/.test(url)) return respond(202, { ok: true, cash: true, reference: 'R' });
        if (/\/sale\/confirm$/.test(url)) return respond(201, { ok: true, total: QUOTE_TOTAL, invoice_number: 'INV-1' });
        return respond(200, {});
      });
      core.proceedToPayment();
      document.getElementById('kgcr-cash-btn').click();
      var t = document.getElementById('kcash-tendered');
      t.value = '300';
      t.dispatchEvent(new Event('input'));
      document.getElementById('kcash-complete-btn').click();
      await flush();
      var html = document.getElementById('kiosk-receipt-body').innerHTML;
      expect(html).toContain('House Pale #1');
      expect(html).toContain('House Pale #2');
      expect(html).toContain('Brewing fee');
      expect(html.match(/<strong>Total<\/strong>/g)).toHaveLength(1);
      expect(html).toContain('$215.25');
    });
  });
});

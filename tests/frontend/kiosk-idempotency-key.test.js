'use strict';

// =============================================================================
// Tests: kiosk double-tap idempotency-key regression (Phase 50-04, D-50-05)
//
// Closes M-B1's client half: js/kiosk-core.js must not let a double-tap of a
// money-path button (Proceed/Skip, or a sales-order Pay button) fire the same
// charge twice, and any request that DOES reach the server for the same
// payment attempt must carry the SAME idempotency_key so the Phase 45
// server-side lock actually recognises the duplicate.
//
// NOTE on plan drift (found during read_first verification, not assumed):
// the 50-04-PLAN.md's description of the defect ("refNumber minted INSIDE
// _kioskPushToTerminal, per invocation") no longer matches this file. The
// refNumber/idempotency-key mint site was already hoisted up into
// kioskProceedToPayment() as a per-attempt closure variable (visible today at
// kiosk-core.js, function kioskProceedToPayment) sometime after the plan was
// authored -- most likely during the Phase 70 cash/moto tender work (WR-02),
// which needed a stable per-attempt base key for its tender-suffixed variants.
// That refactor incidentally already fixed the "re-entry within ONE attempt
// shares the same key" half of the bug (the gift-card panel step, the
// stock-override resubmit at what is now kiosk-core.js:3040, all read the
// SAME closure variable and are exercised by
// kiosk-core-parity.test.js's Manager Override suite).
//
// The defect that is STILL live is the other half: TWO SEPARATE calls to
// kioskProceedToPayment() -- i.e. an actual double-tap of Proceed/Skip, which
// is never disabled -- each mint their OWN refNumber via their OWN
// Date.now() call, so two taps really do produce two different keys, and
// the buttons are never disabled to stop the second tap in the first place.
// The sales-order-pay half (kioskCollectPayment) matches the plan exactly:
// no idempotency_key at all, no disable, no re-entrancy guard.
//
// Cases 1, 2, 4, 6, 7 below reproduce genuine defects and MUST fail against
// this unmodified source. Cases 3 and 5 assert the guard rails from
// over-correcting (D-50-05's inverse risks) and may already hold.
// =============================================================================

global.window = global.window || {};
global.window.addEventListener = global.window.addEventListener || jest.fn();
global.window.confirm = global.window.confirm || jest.fn(function () { return true; });

global.navigator = global.navigator || { userAgent: 'test' };

global.console = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn()
};

global.fetch = jest.fn(function () {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve({}); }
  });
});

// setTimeout fires immediately so any debounce/poll-timeout logic collapses in tests
global.setTimeout = jest.fn(function (fn) {
  if (typeof fn === 'function') fn();
  return 1;
});
global.clearTimeout = jest.fn();
// setInterval intentionally does NOT auto-fire -- keeps the terminal-status poll inert.
global.setInterval = jest.fn(function () { return 1; });
global.clearInterval = jest.fn();
global.alert = jest.fn();

global.Image = global.Image || jest.fn(function () { return {}; });
global.MutationObserver = global.MutationObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn() };
});
global.IntersectionObserver = global.IntersectionObserver || jest.fn(function () {
  return { observe: jest.fn(), disconnect: jest.fn(), unobserve: jest.fn() };
});
global.google = {
  accounts: {
    oauth2: {
      initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; })
    }
  }
};

global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: 'http://mw.test',
  MW_API_KEY: 'test-api-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token'
};

var DEVICE_TOKEN_KEY = 'sv_kiosk_device_token';

function injectEl(id, tag) {
  var existing = document.getElementById(id);
  if (existing) {
    existing.innerHTML = '';
    existing.style.display = '';
    return existing;
  }
  var el = document.createElement(tag || 'div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

// Mirrors tests/frontend/kiosk-device-token.test.js's T3 shell -- the DOM
// elements kioskShowCustomerStep() wires the Proceed/Skip handlers onto.
function injectCustomerStepShell() {
  injectEl('kiosk-customer-search', 'input');
  injectEl('kiosk-customer-results');
  injectEl('kiosk-customer-selected');
  injectEl('kiosk-customer-proceed', 'button');
  injectEl('kiosk-customer-skip', 'button');
  injectEl('kiosk-customer-back', 'button');
  injectEl('kiosk-new-customer-toggle', 'button');
  injectEl('kiosk-new-customer-form');
  injectEl('kiosk-new-customer-save', 'button');
}

// Flushes fetch(...).then().then()... microtask chains (mirrors
// kiosk-core-parity.test.js's flushPromises).
function flushPromises() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) {
    p = p.then(function () {});
  }
  return p;
}

// Guarantees Date.now() advances on every call, so a real double-tap bug
// (two independent 'KIOSK-' + Date.now() mints) is reproducible even on a
// test runner fast enough that two synchronous calls could otherwise land in
// the same millisecond.
function mockAdvancingDateNow() {
  var t = 1700000000000;
  return jest.spyOn(Date, 'now').mockImplementation(function () {
    t += 1000;
    return t;
  });
}

function loadSurface(path) {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  var mod = require(path); // eslint-disable-line global-require -- intentional dynamic per-surface isolation
  return { mod: mod, core: global.window.KioskCore };
}

var PRODUCT_A = {
  item_id: 'PROD-1',
  name: 'Test Wine',
  sku: 'SKU-1',
  rate: 25,
  product_type: 'goods',
  cf_type: '',
  tax_percentage: 5,
  stock_on_hand: 0 // 0 => kioskCheckStockOverflow never blocks (guard: `stock <= 0` returns true)
};

function seedSalesOrders(surface, orders) {
  global.fetch.mockImplementationOnce(function () {
    return Promise.resolve({
      status: 200,
      json: function () { return Promise.resolve({ salesorders: orders }); }
    });
  });
  surface.core.loadSalesOrders();
  return flushPromises();
}

beforeEach(function () {
  localStorage.clear();
  document.body.innerHTML = '';
  global.fetch.mockClear();
  global.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve({}); }
  });
});

afterEach(function () {
  document.body.innerHTML = '';
  jest.restoreAllMocks();
});

// =============================================================================
// Sale path (Proceed/Skip -> /api/kiosk/sale)
// =============================================================================
describe('kiosk idempotency key -- sale path double-tap', function () {
  test('case 1: two rapid proceedToPayment() calls for the same attempt send exactly ONE /api/kiosk/sale request', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    var nowSpy = mockAdvancingDateNow();

    surface.core.addToCart(PRODUCT_A);
    global.fetch.mockClear();
    surface.core.proceedToPayment();
    surface.core.proceedToPayment(); // simulated second tap, same attempt

    expect(global.fetch).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  test('case 2: if a double-tap DID reach the server more than once, every request for that attempt carries the SAME idempotency_key', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    var nowSpy = mockAdvancingDateNow();

    surface.core.addToCart(PRODUCT_A);
    global.fetch.mockClear();
    surface.core.proceedToPayment();
    surface.core.proceedToPayment(); // simulated second tap, same attempt

    var keys = global.fetch.mock.calls.map(function (c) {
      return JSON.parse(c[1].body).idempotency_key;
    });
    keys.forEach(function (k) {
      expect(k).toBe(keys[0]);
    });
    nowSpy.mockRestore();
  });

  test('case 3: completing one attempt in error and starting a genuinely NEW attempt mints a DIFFERENT idempotency_key', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    var nowSpy = mockAdvancingDateNow();

    surface.core.addToCart(PRODUCT_A);
    global.fetch.mockClear();
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({ status: 400, json: function () { return Promise.resolve({ error: 'terminal error' }); } });
    });
    surface.core.proceedToPayment();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    var key1 = JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key;

    return flushPromises().then(function () {
      // Attempt 1 terminated (Terminal Error) -- staff return to the cart and retry.
      global.fetch.mockClear();
      global.fetch.mockResolvedValueOnce({
        ok: true, status: 202,
        json: function () { return Promise.resolve({ ok: true, pending: true, reference: 'ATTEMPT-2' }); }
      });
      surface.core.proceedToPayment();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var key2 = JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key;
      expect(key2).not.toBe(key1);
      nowSpy.mockRestore();
    });
  });

  test('case 4: Skip is disabled immediately after being clicked', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    surface.core.addToCart(PRODUCT_A);
    injectCustomerStepShell();
    surface.core.showCustomerStep();

    var skipBtn = document.getElementById('kiosk-customer-skip');
    expect(skipBtn.style.display).not.toBe('none');

    global.fetch.mockClear();
    skipBtn.click();

    expect(skipBtn.disabled).toBe(true);
  });

  test('case 5: a failed sale re-enables Skip so a subsequent tap starts a genuinely NEW attempt (no bricked kiosk)', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    surface.core.addToCart(PRODUCT_A);
    injectCustomerStepShell();
    surface.core.showCustomerStep();
    var skipBtn = document.getElementById('kiosk-customer-skip');

    global.fetch.mockClear();
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({ status: 502, json: function () { return Promise.resolve({ error: 'bad gateway' }); } });
    });
    skipBtn.click();

    return flushPromises().then(function () {
      expect(skipBtn.disabled).toBe(false);

      global.fetch.mockClear();
      global.fetch.mockResolvedValueOnce({
        ok: true, status: 202,
        json: function () { return Promise.resolve({ ok: true, pending: true, reference: 'RETRY-1' }); }
      });
      skipBtn.click();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// Sales-order-pay path (.kiosk-so-pay-btn -> /api/kiosk/salesorder-pay)
// =============================================================================
describe('kiosk idempotency key -- salesorder-pay double-tap', function () {
  test('case 6: double-tapping collectPayment for the same order sends exactly ONE salesorder-pay request, carrying an idempotency_key', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    surface.core.setTerminalStatus(true, 'Terminal ready');

    return seedSalesOrders(surface, [
      { salesorder_id: 'SO-1', salesorder_number: 'SO-1001', balance: 42, customer_name: 'Test Customer', line_items: [] }
    ]).then(function () {
      global.fetch.mockClear();
      surface.core.collectPayment('SO-1');
      surface.core.collectPayment('SO-1'); // simulated double-tap, same order

      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(typeof body.idempotency_key).toBe('string');
      expect(body.idempotency_key.length).toBeGreaterThan(0);
    });
  });

  test('case 7: the SO-pay key is stable across a double-tap of the SAME order but distinct for a DIFFERENT order', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'idem-test-token');
    surface.core.setTerminalStatus(true, 'Terminal ready');
    var nowSpy = mockAdvancingDateNow();

    return seedSalesOrders(surface, [
      { salesorder_id: 'SO-A', salesorder_number: 'SO-A001', balance: 10, customer_name: 'A', line_items: [] },
      { salesorder_id: 'SO-B', salesorder_number: 'SO-B001', balance: 20, customer_name: 'B', line_items: [] }
    ]).then(function () {
      global.fetch.mockClear();
      surface.core.collectPayment('SO-A');
      var keyA1 = JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key;

      surface.core.collectPayment('SO-A'); // double-tap, same order
      var lastCall = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
      var keyA2 = JSON.parse(lastCall[1].body).idempotency_key;
      expect(keyA2).toBe(keyA1);

      global.fetch.mockClear();
      surface.core.collectPayment('SO-B'); // a DIFFERENT order must get a DIFFERENT key
      var keyB = JSON.parse(global.fetch.mock.calls[0][1].body).idempotency_key;
      expect(keyB).not.toBe(keyA1);

      nowSpy.mockRestore();
    });
  });
});

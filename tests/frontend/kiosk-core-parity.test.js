'use strict';

// =============================================================================
// Tests: kiosk-core parity — standalone kiosk vs admin-embedded kiosk (Phase 48
// de-fork, SC#2/D-03/D-07)
//
// Proves the de-fork is behaviour-identical across both consumer surfaces:
//   1. For an identical cart, both surfaces' sale-trigger fetch calls hit the
//      SAME URL with the SAME body (excluding the non-deterministic
//      reference_number/idempotency_key pair, which is itself asserted to be
//      unified per-surface per D-05).
//   2. Auth injection diverges correctly: kiosk sends x-device-token; admin
//      sends credentials:'include' with no x-device-token key (T-48-14).
//   3. Manager Override (D-07) parity: both surfaces send an `override` key
//      (default false) on recipe sales, and on a mocked 409 `conflicts`
//      response both wire #kiosk-stock-override-btn -> override=true ->
//      resubmit identically (T-48-14O).
//
// Mechanism note: js/kiosk.js and js/admin.js each call the shared
// KioskCore.init(env) ONCE, synchronously, at require-time — and KioskCore
// itself is a singleton (window.KioskCore), so the LAST surface required
// would otherwise "win" the env pointer for both. To drive each surface with
// its own correct env (own cart var, own auth), each surface is loaded in
// full isolation via jest.resetModules() + deleting window.KioskCore, which
// forces a brand-new kiosk-core.js closure (and thus a fresh KioskCore
// singleton) to be created for that surface only.
// =============================================================================

// ---------------------------------------------------------------------------
// Environment stubs — union of kiosk-device-token.test.js's stub block (for
// js/kiosk.js) and admin-recipe-modify.test.js's stub block (for js/admin.js),
// since this file requires both files across its test cases.
// ---------------------------------------------------------------------------
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
// setInterval intentionally does NOT auto-fire — this keeps the terminal-status
// poll inert in tests, so only the initial push fetch call is ever recorded.
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

// ---------------------------------------------------------------------------
// Helper: inject a real jsdom element into document.body
// ---------------------------------------------------------------------------
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

// PATTERNS.md/kiosk.html:145-147 + admin.html:663-665 — identical markup on
// both surfaces (verbatim port). Injecting this lets the 409/override wiring
// path actually find its DOM targets in jsdom.
function injectStockConflictMarkup() {
  var wrap = injectEl('kiosk-stock-conflict');
  wrap.style.display = 'none';
  var msg = document.createElement('div');
  msg.className = 'kiosk-stock-conflict-msg';
  wrap.appendChild(msg);
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'kiosk-stock-override-btn';
  wrap.appendChild(btn);
  return wrap;
}

// Flushes pending native Promise microtask chains (fetch().then().then()...)
// without relying on fake timers or setImmediate (unavailable in this jsdom
// test environment) — chaining enough real .then() hops drains every
// microtask queued by a fetch(...).then(r => r.json().then(...)).then(...)
// chain (at most 3 hops deep anywhere in this file) before the next assertion runs.
function flushPromises() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) {
    p = p.then(function () {});
  }
  return p;
}

// ---------------------------------------------------------------------------
// Helper: load a consumer surface (js/kiosk.js or js/admin.js) in full
// isolation — fresh require cache + fresh window.KioskCore singleton — so
// its own KioskCore.init(env) call is the ONLY one active for this surface.
// ---------------------------------------------------------------------------
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

var RECIPE_A = {
  recipe_id: 'RCP-1',
  name: 'Test IPA',
  batch_size_l: 23,
  pricing_mode: 'dynamic',
  locked_price: 0,
  service_fee: 0
};

var RECIPE_DETAIL_RESPONSE = {
  recipe: {
    recipe_id: 'RCP-1',
    name: 'Test IPA',
    pricing_mode: 'dynamic',
    locked_price: 0,
    service_fee: 0,
    milling_fee_tax: 0,
    brewing_fee_tax: 0
  },
  ingredients: [
    { item_id: 'ING-1', item_name: 'Pale Malt', quantity: 5, unit: 'kg', rate: 4, tax_percentage: 0 },
    { item_id: 'ING-2', item_name: 'Cascade Hops', quantity: 0.1, unit: 'kg', rate: 20, tax_percentage: 0 }
  ]
};

function stripNonDeterministic(body) {
  var copy = JSON.parse(JSON.stringify(body));
  var referenceNumber = copy.reference_number;
  var idempotencyKey = copy.idempotency_key;
  delete copy.reference_number;
  delete copy.idempotency_key;
  return { stripped: copy, referenceNumber: referenceNumber, idempotencyKey: idempotencyKey };
}

function assertAuthDivergence(kioskOpts, adminOpts) {
  expect(kioskOpts.headers['x-device-token']).toBe('parity-test-device-token');
  expect(kioskOpts.credentials).toBeUndefined();
  expect(adminOpts.headers['x-device-token']).toBeUndefined();
  expect(adminOpts.credentials).toBe('include');
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
});

// =============================================================================
// SC#2/D-03: plain product sale — identical URL + body (modulo idempotency),
// correct per-surface auth
// =============================================================================
describe('kiosk-core parity — plain product sale', function () {
  test('kiosk and admin produce the same fetch URL + body for an identical cart, with correct per-surface auth', function () {
    // ---- kiosk surface ----
    var kioskSurface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');
    kioskSurface.core.addToCart(PRODUCT_A);
    global.fetch.mockClear();
    kioskSurface.core.proceedToPayment();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    var kioskCall = global.fetch.mock.calls[0];

    // ---- admin surface (fully isolated — own fresh KioskCore singleton) ----
    var adminSurface = loadSurface('../../js/admin.js');
    adminSurface.core.addToCart(PRODUCT_A);
    global.fetch.mockClear();
    adminSurface.core.proceedToPayment();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    var adminCall = global.fetch.mock.calls[0];

    // URL parity
    expect(kioskCall[0]).toBe('http://mw.test/api/kiosk/sale');
    expect(adminCall[0]).toBe('http://mw.test/api/kiosk/sale');
    expect(kioskCall[0]).toBe(adminCall[0]);

    // Body parity (modulo reference_number/idempotency_key)
    var kioskBody = JSON.parse(kioskCall[1].body);
    var adminBody = JSON.parse(adminCall[1].body);
    var kioskNorm = stripNonDeterministic(kioskBody);
    var adminNorm = stripNonDeterministic(adminBody);
    expect(kioskNorm.stripped).toEqual(adminNorm.stripped);

    // D-05: idempotency_key unifies on reference_number (no Math.random() suffix) — both surfaces
    expect(kioskNorm.idempotencyKey).toBe(kioskNorm.referenceNumber);
    expect(adminNorm.idempotencyKey).toBe(adminNorm.referenceNumber);

    // Auth divergence (T-48-14)
    assertAuthDivergence(kioskCall[1], adminCall[1]);
  });
});

// =============================================================================
// SC#2/D-03 + Pitfall 3: recipe sale — modified_ingredients + override:false
// parity (D-07 default)
// =============================================================================
describe('kiosk-core parity — recipe sale', function () {
  function seedRecipeCart(surface) {
    surface.core._setSelectedRecipe(RECIPE_A);
    surface.core._setSaleType('in-store');
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(RECIPE_DETAIL_RESPONSE); }
      });
    });
    surface.core.addRecipeToCart();
    return flushPromises().then(function () {
      // 101 D-19: recipe carts are priced by the server cart-quote.
      surface.core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 50, discount_total: 0, tax_total: 0, total: 50 } });
    });
  }

  test('kiosk and admin produce the same fetch URL + body for an identical recipe cart, including override:false', function () {
    return (function () {
      var kioskSurface = loadSurface('../../js/kiosk.js');
      localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');
      return seedRecipeCart(kioskSurface).then(function () {
        global.fetch.mockClear();
        kioskSurface.core.proceedToPayment();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        var kioskCall = global.fetch.mock.calls[0];

        var adminSurface = loadSurface('../../js/admin.js');
        return seedRecipeCart(adminSurface).then(function () {
          global.fetch.mockClear();
          adminSurface.core.proceedToPayment();
          expect(global.fetch).toHaveBeenCalledTimes(1);
          var adminCall = global.fetch.mock.calls[0];

          expect(kioskCall[0]).toBe('http://mw.test/api/kiosk/sale');
          expect(adminCall[0]).toBe('http://mw.test/api/kiosk/sale');

          var kioskBody = JSON.parse(kioskCall[1].body);
          var adminBody = JSON.parse(adminCall[1].body);

          // Pitfall 3 (modified_ingredients forwarding) is exercised with a REAL
          // modification in the dedicated WR-05 test below — this case seeds none.

          var kioskNorm = stripNonDeterministic(kioskBody);
          var adminNorm = stripNonDeterministic(adminBody);
          expect(kioskNorm.stripped).toEqual(adminNorm.stripped);
          expect(kioskNorm.idempotencyKey).toBe(kioskNorm.referenceNumber);
          expect(adminNorm.idempotencyKey).toBe(adminNorm.referenceNumber);

          // D-07: override key present, default false, on BOTH surfaces
          expect(kioskBody.override).toBe(false);
          expect(adminBody.override).toBe(false);

          assertAuthDivergence(kioskCall[1], adminCall[1]);
        });
      });
    })();
  });

  // WR-05 (Phase 48 review): Pitfall 3 (admin previously dropped
  // modified_ingredients) is the exact drift bug this de-fork fixes, so the parity
  // suite must actually exercise an edited quantity — the prior assertion only
  // checked key presence with no modification seeded and could never fail.
  test('edited modified_ingredients are forwarded identically on both surfaces (Pitfall 3)', function () {
    var mods = [
      { item_id: 'ING-1', item_name: 'Pale Malt', quantity: 9, unit: 'kg' },
      { item_id: 'ING-2', item_name: 'Cascade Hops', quantity: 0.25, unit: 'kg' }
    ];

    var kioskSurface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');
    kioskSurface.core._setModifiedIngredients(mods);
    return seedRecipeCart(kioskSurface).then(function () {
      global.fetch.mockClear();
      kioskSurface.core.proceedToPayment();
      var kioskBody = JSON.parse(global.fetch.mock.calls[0][1].body);

      var adminSurface = loadSurface('../../js/admin.js');
      adminSurface.core._setModifiedIngredients(mods);
      return seedRecipeCart(adminSurface).then(function () {
        global.fetch.mockClear();
        adminSurface.core.proceedToPayment();
        var adminBody = JSON.parse(global.fetch.mock.calls[0][1].body);

        // Non-tautological: the edited quantities are actually present...
        expect(kioskBody.recipes[0].modified_ingredients).toEqual(mods);
        expect(kioskBody.recipes[0].modified_ingredients[0].quantity).toBe(9);
        // ...and identical across both surfaces (the whole point of the de-fork).
        expect(adminBody.recipes[0].modified_ingredients).toEqual(kioskBody.recipes[0].modified_ingredients);
      });
    });
  });

  // WR-01 (Phase 48 review): the core must resolve the middleware URL lazily, so a
  // MIDDLEWARE_URL value that lands after KioskCore.init (async / late SHEETS_CONFIG
  // or script-order change) is still honored — the pre-phase kioskMwUrl() re-evaluated
  // per call. Before the fix the URL was captured once at init and a later change was
  // permanently ignored (every middleware call would silently target the stale URL).
  test('the core resolves the middleware URL lazily — a MIDDLEWARE_URL change after init is honored', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');
    var origUrl = global.SHEETS_CONFIG.MIDDLEWARE_URL;
    // Config changes AFTER KioskCore.init already ran.
    global.SHEETS_CONFIG.MIDDLEWARE_URL = 'http://mw-late.test';
    return seedRecipeCart(surface).then(function () {
      global.fetch.mockClear();
      surface.core.proceedToPayment();
      var saleUrl = global.fetch.mock.calls[0][0];
      global.SHEETS_CONFIG.MIDDLEWARE_URL = origUrl; // restore before asserting (shared global)
      expect(saleUrl).toBe('http://mw-late.test/api/kiosk/sale');
    });
  });
});

// =============================================================================
// D-07 Manager Override — 409 conflicts -> #kiosk-stock-override-btn ->
// resubmit with override:true, identically on both surfaces
// =============================================================================
describe('kiosk-core parity — Manager Override (D-07)', function () {
  function seedRecipeCart(surface) {
    surface.core._setSelectedRecipe(RECIPE_A);
    surface.core._setSaleType('in-store');
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(RECIPE_DETAIL_RESPONSE); }
      });
    });
    surface.core.addRecipeToCart();
    return flushPromises().then(function () {
      // 101 D-19: recipe carts are priced by the server cart-quote.
      surface.core._setCartQuote({ seq: 1, status: 'ok', data: { subtotal: 50, discount_total: 0, tax_total: 0, total: 50 } });
    });
  }

  function runOverrideFlow(surface) {
    injectStockConflictMarkup();
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({
        status: 409,
        json: function () {
          return Promise.resolve({
            error: 'Insufficient stock for scaled batch',
            conflicts: [{ item_name: 'Pale Malt', needed: 5, unit: 'kg', stock: 2 }]
          });
        }
      });
    });
    surface.core.proceedToPayment();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    var initialCall = global.fetch.mock.calls[0];
    var initialBody = JSON.parse(initialCall[1].body);

    return flushPromises().then(function () {
      var conflictEl = document.getElementById('kiosk-stock-conflict');
      var overrideBtn = document.getElementById('kiosk-stock-override-btn');
      expect(conflictEl.style.display).not.toBe('none');
      expect(overrideBtn.onclick).toEqual(expect.any(Function));

      global.fetch.mockClear();
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: function () { return Promise.resolve({ ok: true, pending: true, reference: 'RECIPE-1' }); }
      });

      overrideBtn.click();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var resubmitCall = global.fetch.mock.calls[0];
      var resubmitBody = JSON.parse(resubmitCall[1].body);

      return {
        initialUrl: initialCall[0],
        initialOpts: initialCall[1],
        initialBody: initialBody,
        resubmitUrl: resubmitCall[0],
        resubmitOpts: resubmitCall[1],
        resubmitBody: resubmitBody,
        conflictHiddenAfterClick: conflictEl.style.display === 'none'
      };
    });
  }

  test('409 conflicts render the panel and #kiosk-stock-override-btn resubmits with override:true identically on both surfaces', function () {
    var kioskSurface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');

    return seedRecipeCart(kioskSurface).then(function () {
      global.fetch.mockClear();
      return runOverrideFlow(kioskSurface).then(function (kioskResult) {
        var adminSurface = loadSurface('../../js/admin.js');
        return seedRecipeCart(adminSurface).then(function () {
          global.fetch.mockClear();
          return runOverrideFlow(adminSurface).then(function (adminResult) {
            // Initial push: both include override:false, same URL
            expect(kioskResult.initialUrl).toBe('http://mw.test/api/kiosk/sale');
            expect(adminResult.initialUrl).toBe('http://mw.test/api/kiosk/sale');
            expect(kioskResult.initialBody.override).toBe(false);
            expect(adminResult.initialBody.override).toBe(false);

            // Conflict panel hidden again after the override click, on both
            expect(kioskResult.conflictHiddenAfterClick).toBe(true);
            expect(adminResult.conflictHiddenAfterClick).toBe(true);

            // Resubmit: same URL, override:true, identical body (modulo idempotency)
            expect(kioskResult.resubmitUrl).toBe('http://mw.test/api/kiosk/sale');
            expect(adminResult.resubmitUrl).toBe('http://mw.test/api/kiosk/sale');
            expect(kioskResult.resubmitBody.override).toBe(true);
            expect(adminResult.resubmitBody.override).toBe(true);

            var kioskNorm = stripNonDeterministic(kioskResult.resubmitBody);
            var adminNorm = stripNonDeterministic(adminResult.resubmitBody);
            expect(kioskNorm.stripped).toEqual(adminNorm.stripped);
            expect(kioskNorm.idempotencyKey).toBe(kioskNorm.referenceNumber);
            expect(adminNorm.idempotencyKey).toBe(adminNorm.referenceNumber);

            // Auth divergence holds on the resubmit call too
            assertAuthDivergence(kioskResult.resubmitOpts, adminResult.resubmitOpts);
          });
        });
      });
    });
  });

  // WR-03 (Phase 48 review): the manual-confirm fallback must NOT be armed on a
  // 409 stock-conflict early-return. Before the fix, _kioskPushToTerminal scheduled
  // the "Confirm Manually" setTimeout unconditionally (outside the fetch chain), so
  // ~45s after a 409 it overlaid the override panel and offered to book a sale the
  // server had just rejected for insufficient stock.
  test('a 409 stock conflict does NOT reveal the manual-confirm fallback (no overlay of the override panel)', function () {
    var surface = loadSurface('../../js/kiosk.js');
    localStorage.setItem(DEVICE_TOKEN_KEY, 'parity-test-device-token');
    return seedRecipeCart(surface).then(function () {
      global.fetch.mockClear();
      injectStockConflictMarkup();
      var confirmBtn = document.createElement('button');
      confirmBtn.id = 'kiosk-confirm-payment';
      confirmBtn.style.display = 'none';
      document.body.appendChild(confirmBtn);

      global.fetch.mockImplementationOnce(function () {
        return Promise.resolve({
          status: 409,
          json: function () {
            return Promise.resolve({
              error: 'Insufficient stock for scaled batch',
              conflicts: [{ item_name: 'Pale Malt', needed: 5, unit: 'kg', stock: 2 }]
            });
          }
        });
      });

      surface.core.proceedToPayment();
      return flushPromises().then(function () {
        // Conflict panel is shown...
        expect(document.getElementById('kiosk-stock-conflict').style.display).not.toBe('none');
        // ...and the manual-confirm fallback was never armed, so it stays hidden.
        // (With the pre-fix unconditional setTimeout — which the test harness fires
        // synchronously — this button would have been revealed.)
        expect(confirmBtn.style.display).toBe('none');
      });
    });
  });
});

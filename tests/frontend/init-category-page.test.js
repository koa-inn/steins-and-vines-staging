'use strict';

// =============================================================================
// Regression tests: /wine and /beer never dispatch their category catalogue,
// and beer.html's waitlist form has never been wired on its own page.
//
// Bug: beer.html is <body data-page="beer"> and contains #beer-waitlist-form,
// but js/modules/13-init.js only calls setupBeerWaitlistForm() inside the
// page === 'home' branch — so the form has shipped since 2026-08-31 doing a
// native submit + page reload instead of posting to /api/waitlist.
//
// Fix target: a module-scope, exported initCategoryCatalogPage(page) that
// handles 'wine' and 'beer' by loading the category-scoped catalogue (via
// loadProducts(page), matching the 74-02 contract) and, for 'beer' only,
// wiring the waitlist form. Against today's code this function does not
// exist at all, so every test below fails with
// "initCategoryCatalogPage is not a function" — a legitimate RED for a
// capability (and the dispatch branch it represents) that is simply absent.
// =============================================================================

// ---------------------------------------------------------------------------
// Globals required by 13-init.js at load time (mirrors kiosk-attract-reset.test.js,
// the closest existing example of requiring this module standalone).
// ---------------------------------------------------------------------------
global.SHEETS_CONFIG = { SPREADSHEET_ID: 'test', MIDDLEWARE_URL: '' };
global.navigator = global.navigator || {};
global.navigator.vibrate = jest.fn();
global.navigator.standalone = false;

var FERMENT_KEY    = 'sv-cart-ferment';
var INGREDIENT_KEY = 'sv-cart-ingredients';
var LEGACY_KEY      = 'sv-reservation';
global.RESERVATION_KEY     = LEGACY_KEY;
global.FERMENT_CART_KEY    = FERMENT_KEY;
global.INGREDIENT_CART_KEY = INGREDIENT_KEY;
global.CART_KEYS = {
  FERMENT: FERMENT_KEY,
  INGREDIENTS: INGREDIENT_KEY,
  LEGACY_RESERVATION: LEGACY_KEY
};

global.getReservation  = function (key) {
  try { var r = localStorage.getItem(key); return r ? JSON.parse(r) : []; } catch (e) { return []; }
};
global.saveReservation = function (items, key) {
  try { localStorage.setItem(key, JSON.stringify(items)); } catch (e) {}
};
global.refreshAllReserveControls    = function () {};
global.updateReservationBar         = function () {};
global.refreshReservationDependents = function () {};
global.renderCartSidebar            = function () {};
global.trackEvent                   = jest.fn();
global.formatCurrency               = function (n) { return '$' + parseFloat(n).toFixed(2); };
global.escapeHTML                   = function (s) { return String(s || ''); };
global.loadTimeslots                = function () {};
global.updateCompletionEstimate     = function () {};
global.PAYMENT_DISABLED             = false;

// ---------------------------------------------------------------------------
// The dispatch-target functions this plan's dispatch calls. All of these are
// defined in OTHER modules (07-catalog-kits.js, 08-catalog-ingredients.js,
// 05-catalog-view.js, 10-tabs.js, 11-cart.js, 12-checkout.js), so from
// 13-init.js's own module scope they resolve as bare (undeclared) identifiers
// that fall through to the global object — exactly the mechanism
// checkout-waitlist.test.js and kiosk-attract-reset.test.js already rely on.
// (initMobileBottomControls is the one exception: it is declared locally
// inside 13-init.js itself, so this stub cannot intercept it. It is still
// defined per the plan's read_first note — the real implementation is inert
// under jsdom with no .catalog-controls elements present, and no test below
// asserts on its call count.)
// ---------------------------------------------------------------------------
global.loadProducts             = jest.fn();
global.initReservationBar       = jest.fn();
global.initCartDrawer           = jest.fn();
global.initMobileBottomControls = jest.fn();
global.initCatalogViewToggle    = jest.fn();
global.initProductTabs          = jest.fn();
global.setupBeerWaitlistForm    = jest.fn();
global.loadIngredients          = jest.fn();

var init = require('../../js/modules/13-init');

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeEach(function () {
  localStorage.clear();
  sessionStorage.clear();
  jest.clearAllMocks();
});

afterEach(function () {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('initCategoryCatalogPage — /wine and /beer dispatch (D-09) + beer waitlist wiring (D-11)', function () {

  test('T1: initCategoryCatalogPage("beer") calls setupBeerWaitlistForm exactly once — pins the shipped defect', function () {
    init.initCategoryCatalogPage('beer');
    expect(global.setupBeerWaitlistForm).toHaveBeenCalledTimes(1);
  });

  test('T2: initCategoryCatalogPage("beer") calls loadProducts exactly once with "beer"', function () {
    init.initCategoryCatalogPage('beer');
    expect(global.loadProducts).toHaveBeenCalledTimes(1);
    expect(global.loadProducts).toHaveBeenCalledWith('beer');
  });

  test('T3: initCategoryCatalogPage("wine") calls loadProducts exactly once with "wine" and does NOT call setupBeerWaitlistForm', function () {
    init.initCategoryCatalogPage('wine');
    expect(global.loadProducts).toHaveBeenCalledTimes(1);
    expect(global.loadProducts).toHaveBeenCalledWith('wine');
    expect(global.setupBeerWaitlistForm).not.toHaveBeenCalled();
  });

  test('T4: neither "wine" nor "beer" calls initProductTabs — the kits/ingredients tab switcher is a hub-only artifact', function () {
    init.initCategoryCatalogPage('wine');
    init.initCategoryCatalogPage('beer');
    expect(global.initProductTabs).not.toHaveBeenCalled();
  });

  test('T5: both "wine" and "beer" call initCartDrawer and initCatalogViewToggle', function () {
    init.initCategoryCatalogPage('wine');
    expect(global.initCartDrawer).toHaveBeenCalledTimes(1);
    expect(global.initCatalogViewToggle).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();

    init.initCategoryCatalogPage('beer');
    expect(global.initCartDrawer).toHaveBeenCalledTimes(1);
    expect(global.initCatalogViewToggle).toHaveBeenCalledTimes(1);
  });

  test('T6: initCategoryCatalogPage("home") and ("ferment-in-store") call loadProducts zero times and return falsy', function () {
    var homeResult = init.initCategoryCatalogPage('home');
    var hubResult = init.initCategoryCatalogPage('ferment-in-store');
    expect(global.loadProducts).not.toHaveBeenCalled();
    expect(homeResult).toBeFalsy();
    expect(hubResult).toBeFalsy();
  });
});

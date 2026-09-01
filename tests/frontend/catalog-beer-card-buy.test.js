'use strict';

// Regression coverage for the Phase 74 owner-UAT revision of D-12 (2026-09-01):
// beer kits are purchasable as a TAKE-HOME KIT ONLY. The ferment-in-store
// experience is booked through the recipe waitlist, so a beer kit card must
// offer a kit-buy control and must NOT offer a Reserve/ferment-in-store path
// or an in-store price — advertising either would promise a purchase route
// that cannot be fulfilled.
//
// buildBeerCard was lifted out of the loadProducts closure to module scope so
// this path could be tested at all; before that it had no unit coverage and
// the buy path rested entirely on manual browser checks.

global.KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

// jest testEnvironment is jsdom (jest.config.js) — `document` is real and is
// deliberately NOT overwritten, because these assertions need genuine
// querySelectorAll / textContent behaviour on the built card.
global.fetch = global.fetch || function () {
  return Promise.resolve({ ok: false, json: function () { return Promise.resolve({}); } });
};
global.localStorage = global.localStorage || {
  getItem: function () { return null; },
  setItem: function () {}
};
global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'https://mw.example.test' };
global.showCatalogSkeletons = function () {};
global.formatCurrency = function (val) {
  var n = typeof val === 'number' ? val : parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return '$' + Number(n).toFixed(2);
};

// Cross-module helpers buildBeerCard calls. These live in modules 02/04/11 and
// are real globals in the concatenated bundle; here they are stubbed to the
// smallest shape that exercises buildBeerCard's own wiring.
global.SV_LOGO_SVG = '<svg data-stub="sv-logo"></svg>';
global.getTintClass = function () { return ''; };
global.buildLabelNotesToggle = function () {
  var el = document.createElement('div');
  el.className = 'notes-toggle';
  return el;
};
global.buildProductLinkBtn = function (sku) {
  var a = document.createElement('a');
  a.className = 'product-link-btn';
  a.setAttribute('data-sku', sku);
  return a;
};
global.getProductKey = function (product) { return product.sku || product.name; };

// Cart globals reached by renderKitBuyControl (module 11). setReservationQty is
// a spy so the Buy Kit click can be asserted end-to-end rather than only by
// button presence.
global.INGREDIENT_CART_KEY = 'sv-ingredient-cart';
global.reservationCalls = [];
global.reservedQty = 0;
global.getReservedQty = function () { return global.reservedQty; };
global.setReservationQty = function (item, qty) {
  global.reservationCalls.push({ item: item, qty: qty });
};
global.trackEvent = function () {};
global.ga4AddToCart = function () {};

// Mirrors the real buildLabelPriceFooter contract from 04-label-cards.js,
// including the { kitOnly } option this revision introduced.
global.buildLabelPriceFooter = function (product, opts) {
  var options = opts || {};
  var instore = options.kitOnly ? '' : (product.retail_instore || '').trim();
  var kit = (product.retail_kit || '').trim();
  var footer = document.createElement('div');
  footer.className = 'price-footer';
  if (instore) {
    var c1 = document.createElement('div');
    c1.className = 'price-col';
    var l1 = document.createElement('div');
    l1.className = 'price-label';
    l1.textContent = 'Ferment in store';
    var v1 = document.createElement('div');
    v1.className = 'price-value';
    v1.textContent = global.formatCurrency(instore);
    c1.appendChild(l1);
    c1.appendChild(v1);
    footer.appendChild(c1);
  }
  if (kit) {
    var c2 = document.createElement('div');
    c2.className = 'price-col';
    var l2 = document.createElement('div');
    l2.className = 'price-label';
    l2.textContent = 'Kit only';
    var v2 = document.createElement('div');
    v2.className = 'price-value';
    v2.textContent = global.formatCurrency(kit);
    c2.appendChild(l2);
    c2.appendChild(v2);
    footer.appendChild(c2);
  }
  return footer;
};

var mod = require('../../js/modules/07-catalog-kits.js');

function beerKit(overrides) {
  var base = {
    sku: 'BEER-IPA-23',
    name: 'Festa Brew West Coast IPA Kit',
    brand: 'Festa Brew',
    subcategory: 'IPA',
    type: 'Beer',
    retail_instore: '130.00',
    retail_kit: '80.00',
    'batch_size_(l)': '23'
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  }
  return base;
}

describe('buildBeerCard — export', function () {
  test('is exported from the module', function () {
    expect(typeof mod.buildBeerCard).toBe('function');
  });
});

describe('buildBeerCard — kit buy path (D-12 revised)', function () {
  test('renders exactly one product-reserve-wrap for the kit-buy control', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.querySelectorAll('.product-reserve-wrap').length).toBe(1);
  });

  test('the buy wrap is wired to renderKitBuyControl, not the reserve renderer', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    var wrap = card.querySelector('.product-reserve-wrap');
    expect(typeof wrap._reserveRenderer).toBe('function');
    expect(wrap._reserveRenderer.name).toBe('renderKitBuyControl');
  });

  test('the buy wrap carries the product and its cart key so cart re-renders can find it', function () {
    var product = beerKit();
    var card = mod.buildBeerCard(product, document);
    var wrap = card.querySelector('.product-reserve-wrap');
    expect(wrap._reserveProduct).toBe(product);
    expect(wrap._reserveKey).toBe('BEER-IPA-23');
  });

  test('offers no ferment-in-store Reserve control', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.querySelectorAll('.reserve-link--secondary').length).toBe(0);
    var renderers = Array.prototype.map.call(
      card.querySelectorAll('.product-reserve-wrap'),
      function (w) { return w._reserveRenderer && w._reserveRenderer.name; }
    );
    expect(renderers.indexOf('renderReserveControl')).toBe(-1);
  });

  test('no longer renders the waitlist CTA — that moved to recipe cards', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.textContent.indexOf('Join the Waitlist')).toBe(-1);
    expect(card.querySelectorAll('a[href$="#waitlist"]').length).toBe(0);
  });
});

describe('buildBeerCard — kit-only pricing', function () {
  test('shows the Kit only price and never a Ferment in store price', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    var labels = Array.prototype.map.call(
      card.querySelectorAll('.price-label'),
      function (el) { return el.textContent; }
    );
    expect(labels).toEqual(['Kit only']);
    expect(card.textContent.indexOf('Ferment in store')).toBe(-1);
  });

  test('the in-store price value never reaches the DOM even though the field is populated', function () {
    var card = mod.buildBeerCard(beerKit({ retail_instore: '130.00' }), document);
    expect(card.textContent.indexOf('$130.00')).toBe(-1);
    expect(card.textContent.indexOf('$80.00')).toBeGreaterThan(-1);
  });

  test('a kit with no kit price renders no price footer at all', function () {
    var card = mod.buildBeerCard(beerKit({ retail_kit: '' }), document);
    expect(card.querySelectorAll('.price-footer').length).toBe(0);
  });

  test('the buy control is still offered when only the kit price is set', function () {
    var card = mod.buildBeerCard(beerKit({ retail_instore: '' }), document);
    expect(card.querySelectorAll('.product-reserve-wrap').length).toBe(1);
  });
});

describe('buildBeerCard — card shape', function () {
  test('uses the label-beer idiom and carries its sku', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.className.indexOf('label-beer')).toBe(0);
    expect(card.getAttribute('data-sku')).toBe('BEER-IPA-23');
  });

  test('renders the kit name and subcategory', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.querySelector('.beer-name').textContent).toBe('Festa Brew West Coast IPA Kit');
    expect(card.querySelector('.subcategory').textContent).toBe('IPA');
  });

  test('a discounted kit renders a discount badge', function () {
    var card = mod.buildBeerCard(beerKit({ discount: '20' }), document);
    var badge = card.querySelector('.discount-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('20% OFF');
  });
});

describe('buildBeerCard — Buy Kit actually adds to the cart', function () {
  beforeEach(function () {
    global.reservationCalls = [];
    global.reservedQty = 0;
  });

  test('renders a "Buy Kit" button when nothing is in the cart yet', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    var btn = card.querySelector('.product-reserve-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Buy Kit');
  });

  test('clicking Buy Kit adds exactly one kit-purchase line', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    card.querySelector('.product-reserve-btn').click();
    expect(global.reservationCalls.length).toBe(1);
    expect(global.reservationCalls[0].qty).toBe(1);
    expect(global.reservationCalls[0].item._item_type).toBe('kit-purchase');
  });

  test('the line added is priced at the kit-only price, not the in-store price', function () {
    var card = mod.buildBeerCard(beerKit(), document);
    card.querySelector('.product-reserve-btn').click();
    expect(global.reservationCalls[0].item.price).toBe('80.00');
  });

  test('once in the cart the control becomes qty steppers rather than a second Buy Kit', function () {
    global.reservedQty = 1;
    var card = mod.buildBeerCard(beerKit(), document);
    expect(card.querySelectorAll('.product-qty-controls').length).toBe(1);
    var buyBtns = Array.prototype.filter.call(
      card.querySelectorAll('button'),
      function (b) { return b.textContent === 'Buy Kit'; }
    );
    expect(buyBtns.length).toBe(0);
  });
});

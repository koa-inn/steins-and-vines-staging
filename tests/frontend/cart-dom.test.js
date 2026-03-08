'use strict';

global.SHEETS_CONFIG = { SPREADSHEET_ID: 'test', MIDDLEWARE_URL: '' };
global.navigator = global.navigator || {};
global.navigator.vibrate = jest.fn();
global.trackEvent = jest.fn();

beforeEach(function () {
  localStorage.clear();
  jest.clearAllMocks();
});

var cart = require('../../js/modules/11-cart');
var renderReserveControl = cart.renderReserveControl;
var renderWeightControl  = cart.renderWeightControl;
var saveReservation      = cart.saveReservation;

var FERMENT_KEY    = 'sv-cart-ferment';
var INGREDIENT_KEY = 'sv-cart-ingredients';

function makeWrap() {
  return document.createElement('div');
}

function makeKit(overrides) {
  return Object.assign({
    name: 'Wine Kit', brand: 'RJS', _item_type: 'kit',
    sku: 'WK-001', max_order_qty: '', stock: 10
  }, overrides);
}

function makeIngredient(overrides) {
  return Object.assign({
    name: 'Pale Malt', brand: '', _item_type: 'ingredient',
    sku: 'IG-001', max_order_qty: '', stock: 20, unit: 'kg',
    price_per_unit: '$3.50', low_amount: '0.5', high_amount: '',
    step: '0.5'
  }, overrides);
}

// ---------------------------------------------------------------------------
// renderReserveControl — empty cart
// ---------------------------------------------------------------------------
describe('renderReserveControl — empty cart (qty = 0)', function () {
  test('kit: renders Reserve button', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit(), 'Wine Kit|RJS');
    var btn = wrap.querySelector('.product-reserve-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Reserve');
    expect(btn.disabled).toBe(false);
  });

  test('ingredient: renders Add to Cart button', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeIngredient(), 'Pale Malt|');
    var btn = wrap.querySelector('.product-reserve-btn');
    expect(btn.textContent).toBe('Add to Cart');
  });

  test('out of stock: renders disabled button', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeIngredient({ stock: 0 }), 'Pale Malt|');
    var btn = wrap.querySelector('.product-reserve-btn');
    expect(btn.textContent).toBe('Out of Stock');
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain('product-reserve-btn--disabled');
  });

  test('stores product/key references on wrap element', function () {
    var wrap = makeWrap();
    var product = makeKit();
    renderReserveControl(wrap, product, 'Wine Kit|RJS');
    expect(wrap._reserveProduct).toBe(product);
    expect(wrap._reserveKey).toBe('Wine Kit|RJS');
  });

  test('clears previous content before rendering', function () {
    var wrap = makeWrap();
    wrap.innerHTML = '<span>old content</span>';
    renderReserveControl(wrap, makeKit(), 'Wine Kit|RJS');
    expect(wrap.querySelector('span')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderReserveControl — item in cart (qty > 0)
// ---------------------------------------------------------------------------
describe('renderReserveControl — item in cart (qty > 0)', function () {
  beforeEach(function () {
    saveReservation([{ name: 'Wine Kit', brand: 'RJS', qty: 2 }], FERMENT_KEY);
  });

  test('renders qty controls (not a button)', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit(), 'Wine Kit|RJS');
    expect(wrap.querySelector('.product-qty-controls')).not.toBeNull();
    expect(wrap.querySelector('.product-reserve-btn')).toBeNull();
  });

  test('shows current qty in span', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit(), 'Wine Kit|RJS');
    var qtySpan = wrap.querySelector('.qty-value');
    expect(qtySpan).not.toBeNull();
    expect(qtySpan.textContent).toBe('2');
  });

  test('minus and plus buttons present', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit(), 'Wine Kit|RJS');
    var btns = wrap.querySelectorAll('.qty-btn');
    expect(btns.length).toBe(2);
  });

  test('plus button disabled when at max qty', function () {
    // max_order_qty=2, qty=2 → at max
    saveReservation([{ name: 'Wine Kit', brand: 'RJS', qty: 2 }], FERMENT_KEY);
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit({ max_order_qty: '2' }), 'Wine Kit|RJS');
    var btns = wrap.querySelectorAll('.qty-btn');
    var plusBtn = btns[btns.length - 1];
    expect(plusBtn.disabled).toBe(true);
    expect(plusBtn.className).toContain('qty-btn--disabled');
  });

  test('plus button enabled when below max qty', function () {
    var wrap = makeWrap();
    renderReserveControl(wrap, makeKit({ max_order_qty: '5' }), 'Wine Kit|RJS');
    var btns = wrap.querySelectorAll('.qty-btn');
    var plusBtn = btns[btns.length - 1];
    expect(plusBtn.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderWeightControl — empty cart
// ---------------------------------------------------------------------------
describe('renderWeightControl — empty cart (qty = 0)', function () {
  test('renders Add to Cart button', function () {
    var wrap = makeWrap();
    renderWeightControl(wrap, makeIngredient(), 'Pale Malt|');
    var btn = wrap.querySelector('.product-reserve-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Add to Cart');
  });

  test('stores product/key references on wrap element', function () {
    var wrap = makeWrap();
    var product = makeIngredient();
    renderWeightControl(wrap, product, 'Pale Malt|');
    expect(wrap._reserveProduct).toBe(product);
    expect(wrap._reserveKey).toBe('Pale Malt|');
  });
});

// ---------------------------------------------------------------------------
// renderWeightControl — item in cart (qty > 0)
// ---------------------------------------------------------------------------
describe('renderWeightControl — item in cart (qty > 0)', function () {
  beforeEach(function () {
    saveReservation([{ name: 'Pale Malt', brand: '', qty: 1.5 }], INGREDIENT_KEY);
  });

  test('renders weight-control container (not reserve button)', function () {
    var wrap = makeWrap();
    renderWeightControl(wrap, makeIngredient(), 'Pale Malt|');
    expect(wrap.querySelector('.weight-control')).not.toBeNull();
    expect(wrap.querySelector('.product-reserve-btn')).toBeNull();
  });

  test('amount badge shows qty + unit', function () {
    var wrap = makeWrap();
    renderWeightControl(wrap, makeIngredient(), 'Pale Malt|');
    var badge = wrap.querySelector('.weight-control-amount-badge');
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain('kg');
    expect(badge.textContent).toContain('1.50');
  });

  test('renders slider row', function () {
    var wrap = makeWrap();
    renderWeightControl(wrap, makeIngredient(), 'Pale Malt|');
    expect(wrap.querySelector('.weight-control-slider-row')).not.toBeNull();
  });
});

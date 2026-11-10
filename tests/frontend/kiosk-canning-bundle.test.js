'use strict';

// Phase 90 (D-11..D-16, D-25): kiosk canning bundle lifecycle, rendering, payload.

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

var DEVICE_TOKEN_KEY = 'sv_kiosk_device_token';

function loadKiosk() {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  require('../../js/kiosk.js'); // eslint-disable-line global-require -- per-test isolation
  return global.window.KioskCore;
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

var CAN_473 = { item_id: 'can473', name: 'Can 473 mL', sku: 'CAN-473', rate: 0.5, tax_percentage: 12, product_type: 'goods', stock_on_hand: 5000 };
var CAN_355 = { item_id: 'can355', name: 'Can 355 mL', sku: 'can-355', rate: 0.45, tax_percentage: 12, product_type: 'goods', stock_on_hand: 5000 };
var KIT = { item_id: 'kit1', name: 'Zero Kit', sku: 'kit-1', rate: 80, tax_percentage: 0, product_type: 'goods' };

function seedCatalog(core, items) {
  var products = core._getProducts();
  products.length = 0;
  (items || [CAN_473, CAN_355]).forEach(function (p) { products.push(p); });
}

function setup(withCatalog) {
  localStorage.clear();
  var core = loadKiosk();
  injectEl('kiosk-cart-items');
  injectEl('kiosk-cart-totals');
  injectEl('kiosk-subtotal');
  injectEl('kiosk-tax');
  injectEl('kiosk-total');
  core._setCart({});
  if (withCatalog !== false) seedCatalog(core);
  return core;
}

beforeEach(function () {
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  });
});

describe('addCanningBundle', function () {
  test('adds the bundle line and a $0 can copy; catalog keeps its rate', function () {
    var core = setup();
    var res = core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    expect(res.ok).toBe(true);
    var cart = core._getCart();
    expect(cart['bundle-line'].qty).toBe(1);
    expect(cart['bundle-line'].item).toMatchObject({
      custom: true,
      bundle_key: 'beer-25',
      description: 'Canning Bundle — Beer 25 L (473 mL)',
      rate: 40,
      tax_percentage: 12,
      taxable: true
    });
    expect(cart['bundle-can'].qty).toBe(52);
    expect(cart['bundle-can'].item.rate).toBe(0);
    expect(cart['bundle-can'].item.bundle_can).toBe(true);
    expect(cart['bundle-can'].item.item_id).toBe('can473');
    expect(CAN_473.rate).toBe(0.5);
    expect(CAN_473.bundle_can).toBeUndefined();
    expect(cart['bundle-can'].item).not.toBe(CAN_473);
  });

  test('bundle keys are the first keys of the cart even with earlier items', function () {
    var core = setup();
    core._setCart({ kit1: { item: KIT, qty: 1 } });
    core.addCanningBundle({ bundleKey: 'cider-23', canSize: 355, count: 64 });
    expect(Object.keys(core._getCart())).toEqual(['bundle-line', 'bundle-can', 'kit1']);
  });

  test('bundle alone totals 40.00 + 4.80 = 44.80', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var t = core.calcTotals();
    expect(t.subtotal).toBe(40);
    expect(t.tax).toBe(4.8);
    expect(t.total).toBe(44.8);
  });

  test('rejections leave the cart unchanged', function () {
    var core = setup();
    expect(core.addCanningBundle({ bundleKey: 'wine-still', canSize: 473, count: 10 })).toEqual({ ok: false, reason: 'unknown_bundle' });
    expect(core.addCanningBundle({ bundleKey: 'beer-25', canSize: 500, count: 10 }).ok).toBe(false);
    expect(core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 0 }).reason).toBe('bad_count');
    expect(core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 101 }).reason).toBe('bad_count');
    expect(Object.keys(core._getCart())).toEqual([]);

    seedCatalog(core, [CAN_355]);
    expect(core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 })).toEqual({ ok: false, reason: 'can_item_missing' });
    expect(Object.keys(core._getCart())).toEqual([]);
  });

  test('a second bundle is refused', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var before = JSON.stringify(core._getCart());
    expect(core.addCanningBundle({ bundleKey: 'cider-23', canSize: 355, count: 64 })).toEqual({ ok: false, reason: 'already_added' });
    expect(JSON.stringify(core._getCart())).toBe(before);
  });
});

describe('bundle lifecycle', function () {
  test('can count edits change only the can line and report the cap', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var r = core.setBundleCanCount(60);
    expect(r.overCap).toBe(true);
    expect(core._getCart()['bundle-can'].qty).toBe(60);
    expect(core._getCart()['bundle-line'].item.rate).toBe(40);
    expect(core.calcTotals().total).toBe(44.8);
    expect(core.setBundleCanCount(54).overCap).toBe(false);
    expect(core.setBundleCanCount(55).overCap).toBe(false);
    expect(core.setBundleCanCount(56).overCap).toBe(true);
  });

  test('bundle line qty is pinned at 1', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var container = document.getElementById('kiosk-cart-items');
    expect(container.querySelector('[data-id="bundle-line"].kiosk-qty-btn')).toBeNull();
    expect(container.querySelector('input[data-id="bundle-line"]')).toBeNull();
    expect(container.querySelector('input[data-id="bundle-can"]')).not.toBeNull();
  });

  test('removing either line removes both; so does clear cart', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    document.querySelector('.kiosk-cart-remove-btn[data-id="bundle-line"]').click();
    expect(Object.keys(core._getCart())).toEqual([]);

    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    document.querySelector('.kiosk-cart-remove-btn[data-id="bundle-can"]').click();
    expect(Object.keys(core._getCart())).toEqual([]);

    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    core.removeCanningBundle();
    expect(Object.keys(core._getCart())).toEqual([]);
  });

  test('decrementing the can line to zero removes both lines', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 1 });
    document.querySelector('.kiosk-qty-btn[data-id="bundle-can"][data-action="dec"]').click();
    expect(Object.keys(core._getCart())).toEqual([]);
  });

  test('discounts never touch the bundle line (D-14)', function () {
    var core = setup();
    core.init({ getDiscount: function () { return { scope: 'cart', type: 'percentage', value: 50 }; } });
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var t = core.calcTotals();
    expect(t.discount).toBe(0);
    expect(t.total).toBe(44.8);
  });
});

describe('cart rendering', function () {
  test('bundle row shows 12% tax, can row shows Included in bundle', function () {
    var core = setup();
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var html = document.getElementById('kiosk-cart-items').innerHTML;
    expect(html).toContain('12% tax');
    expect(html).toContain('Included in bundle');
    expect(html).toContain('Canning Bundle');
    expect(html).not.toContain('Above the bundle cap');
  });

  test('over-cap shows an inline warning with OK, one batch and never calls confirm()', function () {
    var core = setup();
    global.confirm = jest.fn(function () { return true; });
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    document.querySelector('.kiosk-qty-btn[data-id="bundle-can"][data-action="inc"]').click(); // 53
    expect(document.querySelector('.kiosk-bundle-cap-warn')).toBeNull();
    core.setBundleCanCount(56);
    var warn = document.querySelector('.kiosk-bundle-cap-warn');
    expect(warn.textContent).toContain('Above the bundle cap. Confirm this is one batch.');
    var ok = document.querySelector('.kiosk-bundle-cap-ok');
    expect(ok.textContent).toBe('OK, one batch');
    ok.click();
    expect(document.querySelector('.kiosk-bundle-cap-warn')).toBeNull();
    expect(global.confirm).not.toHaveBeenCalled();
    delete global.confirm;
  });
});

describe('opener gating (D-25)', function () {
  test('standalone kiosk registers the hook: opener renders and calls it', function () {
    var core = setup();
    var hook = jest.fn();
    core.init({ showCanningBundleModal: hook });
    core.removeCanningBundle(); // re-renders the (empty) cart
    var btn = document.getElementById('kiosk-canning-bundle-btn');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('Canning bundle');
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('opener is disabled with Bundle added while a bundle exists', function () {
    var core = setup();
    core.init({ showCanningBundleModal: function () {} });
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });
    var btn = document.getElementById('kiosk-canning-bundle-btn');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Bundle added');
  });

  test('bundle allowed alongside a recipe entry (Phase 101 D-05)', function () {
    var core = setup();
    core.init({ showCanningBundleModal: function () {} });
    core._setRecipeEntries([{ entry_id: 'r1', recipe_id: 'R1', recipe_name: 'R1', total_before_discount: 10 }]);
    core.removeCanningBundle();
    expect(document.getElementById('kiosk-canning-bundle-btn')).not.toBeNull();
    expect(core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 }).ok).toBe(true);
  });

  test('a consumer without the hook (admin-embedded) gets no opener', function () {
    jest.resetModules();
    delete global.window.KioskCore;
    document.body.innerHTML = '';
    var core = require('../../js/kiosk-core.js'); // eslint-disable-line global-require -- bare core, no kiosk.js
    injectEl('kiosk-cart-items');
    var cartState = {};
    core.init({ getCart: function () { return cartState; }, setCart: function (v) { cartState = v; } });
    core.removeCanningBundle();
    expect(document.getElementById('kiosk-canning-bundle-btn')).toBeNull();
  });
});

describe('sale payload', function () {
  test('bundle and can lines carry bundle_key / bundle_can and rate 0', async function () {
    var core = setup();
    localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
    injectEl('kiosk-payment-items');
    injectEl('kiosk-payment-amount');
    injectEl('kiosk-terminal-msg');
    injectEl('kiosk-spinner');
    core.addCanningBundle({ bundleKey: 'beer-25', canSize: 473, count: 52 });

    core.proceedToPayment();
    await flushPromises();
    document.getElementById('kgcr-skip-btn').click(); // standard sale: skip the gift-card tender step
    await flushPromises();

    var saleCall = global.fetch.mock.calls.find(function (c) {
      return typeof c[0] === 'string' && c[0].indexOf('/api/kiosk/sale') !== -1;
    });
    expect(saleCall).toBeTruthy();
    var body = JSON.parse(saleCall[1].body);
    expect(body.items[0]).toEqual({
      custom: true,
      bundle_key: 'beer-25',
      description: 'Canning Bundle — Beer 25 L (473 mL)',
      note: '',
      quantity: 1,
      rate: 40,
      taxable: true
    });
    expect(body.items[1]).toMatchObject({ item_id: 'can473', bundle_can: true, quantity: 52, rate: 0 });
    expect(body.client_grand_total).toBe(44.8);
  });
});

describe('picker modal (standalone kiosk)', function () {
  function openPicker() {
    var core = setup();
    core.removeCanningBundle(); // re-render the empty cart so the opener exists
    document.getElementById('kiosk-canning-bundle-btn').click();
    return core;
  }
  function pick(sel) { document.querySelector(sel).click(); }
  function addBtn() { return document.getElementById('kcb-add'); }

  test('kiosk.js registers the hook and the opener builds the dialog once', function () {
    openPicker();
    var overlay = document.getElementById('kiosk-canning-bundle-overlay');
    expect(overlay).not.toBeNull();
    var dlg = overlay.querySelector('[role="dialog"]');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(overlay.querySelector('h3').textContent).toBe('Canning bundle');
    expect(overlay.querySelector('#kcb-close').getAttribute('aria-label')).toBe('Close');
    document.getElementById('kiosk-canning-bundle-btn').click();
    expect(document.querySelectorAll('#kiosk-canning-bundle-overlay').length).toBe(1);
  });

  test('offers the two batch types and sizes, nothing preselected, no wine', function () {
    openPicker();
    var overlay = document.getElementById('kiosk-canning-bundle-overlay');
    var text = overlay.textContent;
    expect(text).toContain('Beer 25 L');
    expect(text).toContain('Cider / sparkling wine 23 L');
    expect(text).toContain('$40.00');
    expect(text).toContain('$35.00');
    expect(text).toContain('+ 12% tax');
    expect(text).toContain('473 mL');
    expect(text).toContain('355 mL');
    expect(text.toLowerCase()).not.toContain('still');
    expect(overlay.querySelectorAll('.kiosk-bundle-opt--active').length).toBe(0);
    expect(addBtn().disabled).toBe(true);
    pick('[data-bundle="beer-25"]');
    expect(addBtn().disabled).toBe(true); // size missing
  });

  test('pre-fills the nominal count and follows size until the operator edits it', function () {
    openPicker();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    expect(document.getElementById('kcb-count').value).toBe('52');
    expect(document.getElementById('kcb-helper').textContent).toBe('Nominal for this batch: 52 cans');
    expect(document.getElementById('kcb-total').textContent).toBe('$40.00 + $4.80 tax');
    pick('[data-size="355"]');
    expect(document.getElementById('kcb-count').value).toBe('70');
    document.getElementById('kcb-inc').click(); // 71, operator edit
    pick('[data-size="473"]');
    expect(document.getElementById('kcb-count').value).toBe('71');
  });

  test('cider total preview is $35.00 + $4.20 tax', function () {
    openPicker();
    pick('[data-bundle="cider-23"]');
    pick('[data-size="355"]');
    expect(document.getElementById('kcb-count').value).toBe('64');
    expect(document.getElementById('kcb-total').textContent).toBe('$35.00 + $4.20 tax');
  });

  test('over-cap needs the tick before Add to cart enables', function () {
    openPicker();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    var countEl = document.getElementById('kcb-count');
    countEl.value = '56';
    countEl.dispatchEvent(new Event('input'));
    var cap = document.getElementById('kcb-cap');
    expect(cap.style.display).not.toBe('none');
    expect(cap.textContent).toContain('Above the bundle cap. Confirm this is one batch.');
    expect(cap.textContent).toContain('Yes, this is one batch');
    expect(addBtn().disabled).toBe(true);
    var ack = document.getElementById('kcb-ack');
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    expect(addBtn().disabled).toBe(false);
    countEl.value = '55';
    countEl.dispatchEvent(new Event('input'));
    expect(cap.style.display).toBe('none');
    expect(addBtn().disabled).toBe(false);
  });

  test('Add to cart adds both lines, closes the modal, re-renders', function () {
    var core = openPicker();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    addBtn().click();
    expect(Object.keys(core._getCart())).toEqual(['bundle-line', 'bundle-can']);
    expect(core._getCart()['bundle-can'].qty).toBe(52);
    expect(document.getElementById('kiosk-canning-bundle-overlay').style.display).toBe('none');
    expect(document.getElementById('kiosk-cart-items').innerHTML).toContain('Canning Bundle');
  });

  test('an over-cap add carries the confirmation so the cart shows no second warning', function () {
    var core = openPicker();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    var countEl = document.getElementById('kcb-count');
    countEl.value = '56';
    countEl.dispatchEvent(new Event('input'));
    var ack = document.getElementById('kcb-ack');
    ack.checked = true;
    ack.dispatchEvent(new Event('change'));
    addBtn().click();
    expect(core._getCart()['bundle-can'].qty).toBe(56);
    expect(document.querySelector('#kiosk-cart-items .kiosk-bundle-cap-warn')).toBeNull();
  });

  test('a missing can item shows the reason inline and leaves the cart alone', function () {
    var core = setup();
    seedCatalog(core, [KIT]);
    core.removeCanningBundle();
    document.getElementById('kiosk-canning-bundle-btn').click();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    addBtn().click();
    expect(document.getElementById('kcb-error').textContent).toBe('Can item not found in the catalog. Refresh products.');
    expect(Object.keys(core._getCart())).toEqual([]);
    expect(document.getElementById('kiosk-canning-bundle-overlay').style.display).toBe('flex');
  });

  test('Go back closes without changing the cart', function () {
    var core = openPicker();
    pick('[data-bundle="beer-25"]');
    pick('[data-size="473"]');
    document.getElementById('kcb-back').click();
    expect(document.getElementById('kiosk-canning-bundle-overlay').style.display).toBe('none');
    expect(Object.keys(core._getCart())).toEqual([]);
  });
});

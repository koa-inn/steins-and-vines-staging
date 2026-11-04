'use strict';

// Phase 97-10 Task 2 (D-03 support): the kiosk recipe sale carries the selected
// customer's email so the batch can hold it. Harness mirrors
// kiosk-recipe-client-totals.test.js.

var fs = require('fs');
var path = require('path');

global.window = global.window || {};
global.navigator = global.navigator || { userAgent: 'test' };
global.console = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
global.fetch = jest.fn();
global.alert = jest.fn();
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

function loadSurface(p) {
  jest.resetModules();
  if (global.window) delete global.window.KioskCore;
  document.body.innerHTML = '';
  var mod = require(p); // intentional dynamic per-surface isolation
  return { mod: mod, core: global.window.KioskCore };
}

function injectEl(id) {
  var el = document.createElement('div');
  el.id = id;
  document.body.appendChild(el);
  return el;
}

function flushPromises() { return new Promise(function (resolve) { setTimeout(resolve, 0); }); }

beforeEach(function () {
  localStorage.clear();
  global.fetch.mockReset();
  global.fetch.mockImplementation(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({}); } });
  });
});

async function runSale(customer) {
  localStorage.setItem(DEVICE_TOKEN_KEY, 'kiosk-token');
  var core = loadSurface('../../js/kiosk.js').core;
  ['kiosk-product-grid', 'kiosk-payment-items', 'kiosk-payment-amount', 'kiosk-terminal-msg', 'kiosk-spinner'].forEach(injectEl);
  core._setCart({
    'recipe-fee-brewing': {
      item: { item_id: 'fee-brewing', name: 'Brewing Fee', rate: 45, tax_percentage: 5, product_type: 'fee' },
      qty: 1
    }
  });
  core._setRecipeContext({ recipe_id: 'RCP-001', sale_type: 'in-store', mill_grain: false, target_volume_l: 20 });
  core._setCustomer(customer);
  core.proceedToPayment();
  await flushPromises();
  var call = global.fetch.mock.calls.find(function (c) {
    return typeof c[0] === 'string' && c[0].indexOf('/api/kiosk/recipe-sale') !== -1;
  });
  return call ? JSON.parse(call[1].body) : null;
}

describe('kiosk recipe sale customer_email (97-10)', function () {
  test('selected customer with email: recipe-sale body carries customer_email', async function () {
    var body = await runSale({ contact_id: 'C-1', name: 'Jane', email: 'jane@example.com' });
    expect(body).toBeTruthy();
    expect(body.customer_email).toBe('jane@example.com');
    expect(body.contact_id).toBe('C-1');
  });

  test('walk-in: customer_email is empty', async function () {
    var body = await runSale(null);
    expect(body.customer_email).toBe('');
  });

  test('customer without email: customer_email is empty', async function () {
    var body = await runSale({ contact_id: 'C-2', name: 'Bob' });
    expect(body.customer_email).toBe('');
  });

  test('the confirm request body forwards the same customer_email', function () {
    // The confirm leg is driven by the terminal poll; pin its body contract in source.
    var src = fs.readFileSync(path.join(__dirname, '../../js/kiosk-core.js'), 'utf8');
    var start = src.indexOf('var confirmBody = {');
    var end = src.indexOf("fetch(mwUrl + '/api/kiosk/recipe-sale/confirm'");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, end)).toContain("customer_email: recipeSaleBody.customer_email || ''");
  });
});

'use strict';

// Regression/parity tests for Phase 82-07 (D-21): the ~10 admin.js inventory/holds/
// supplier-orders/import functions listed below no longer call the direct Google
// Sheets API (sheetsGet/sheetsUpdate/sheetsAppend/colLetter) -- every write now goes
// through the session-authenticated /api/admin/proxy via one of the typed actions
// added in 82-03 (update_inventory_cells, append_inventory_row, add_hold,
// import_kits), each on 82-04's proxy allowlist. Reference transport helpers
// (adminApiGet/adminApiPost) were rewired in 82-06; this plan rewires the LAST
// direct-Sheets callers onto them.
//
// Functions covered: updateKitStockAfterConfirm, updateKitOnHoldAfterRelease,
// openManualHoldModal, saveAllChanges, openAddKitModal, openAddIngredientModal,
// deleteIngredient, syncOnOrder, acceptDelivery, applyImport.

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

describe('admin.js inventory/holds/orders/import flows route through /api/admin/proxy (82-07 D-21)', function () {
  var admin;

  beforeEach(function () {
    jest.resetModules();

    document.body.innerHTML =
      '<div id="admin-signin" style="display:none"></div>' +
      '<div id="admin-denied" style="display:none"></div>' +
      '<div id="admin-dashboard"></div>' +
      '<span id="admin-user-email">staff@example.com</span>' +
      '<button id="admin-signout"></button>' +
      '<div id="admin-toast-container"></div>' +
      '<div id="admin-modal" style="display:none">' +
      '  <h3 id="admin-modal-title"></h3>' +
      '  <div id="admin-modal-body"></div>' +
      '</div>' +
      '<div id="admin-save-bar" style="display:none">' +
      '  <span id="admin-save-count"></span>' +
      '  <button id="admin-save-btn">Save All Changes</button>' +
      '</div>';

    global.window = global.window || {};
    global.navigator = global.navigator || {};
    global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };
    global.confirm = jest.fn(function () { return true; });
    global.fetch = jest.fn(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
    });
    global.localStorage = {
      _data: {},
      getItem: function (k) { return this._data[k] || null; },
      setItem: function (k, v) { this._data[k] = v; },
      removeItem: function (k) { delete this._data[k]; },
      clear: function () { this._data = {}; }
    };
    global.sessionStorage = global.localStorage;
    global.SHEETS_CONFIG = {
      MIDDLEWARE_URL: 'http://mw.test',
      SPREADSHEET_ID: 'test-id',
      CLIENT_ID: 'test-client-id',
      ADMIN_API_URL: '',
      SHEET_NAMES: {
        KITS: 'Kits', INGREDIENTS: 'Ingredients', RESERVATIONS: 'Reservations',
        HOLDS: 'Holds', SCHEDULE: 'Schedule', HOMEPAGE: 'Homepage'
      }
    };

    var _auth = require('../../js/lib/auth');
    global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
    global.gsiInitTokenClient = _auth.gsiInitTokenClient;
    global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

    admin = require('../../js/admin.js');
    admin._setAccessToken(null); // D-06: syncOnOrder must run even with no Google token
    admin._setUserEmail('staff@example.com');
  });

  function lastFetchBody() {
    var call = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
    return JSON.parse(call[1].body);
  }

  function noSheetsUrl() {
    global.fetch.mock.calls.forEach(function (call) {
      expect(String(call[0])).not.toMatch(/sheets\.googleapis\.com/);
      expect(String(call[0])).toBe('http://mw.test/api/admin/proxy');
    });
  }

  test('updateKitStockAfterConfirm issues ONE update_inventory_cells call with stock + on_hold', function () {
    admin._setSheetStateForTest({
      kitsData: [], kitsHeaders: ['sku', 'stock', 'on_hold']
    });
    var kit = { _rowIndex: 5, stock: '10', on_hold: '3' };

    return admin._inventoryForTest.updateKitStockAfterConfirm(kit, 2).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_inventory_cells');
      expect(body.sheet).toBe('Kits');
      expect(body.updates).toEqual([
        { row: 5, field: 'stock', value: 8 },
        { row: 5, field: 'on_hold', value: 1 }
      ]);
      expect(kit.stock).toBe('8');
      expect(kit.on_hold).toBe('1');
      noSheetsUrl();
    });
  });

  test('updateKitOnHoldAfterRelease issues ONE call with only on_hold', function () {
    admin._setSheetStateForTest({
      kitsData: [], kitsHeaders: ['sku', 'stock', 'on_hold']
    });
    var kit = { _rowIndex: 9, stock: '10', on_hold: '4' };

    return admin._inventoryForTest.updateKitOnHoldAfterRelease(kit, 1).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_inventory_cells');
      expect(body.sheet).toBe('Kits');
      expect(body.updates).toEqual([{ row: 9, field: 'on_hold', value: 3 }]);
      noSheetsUrl();
    });
  });

  test('openManualHoldModal submit: add_hold then update_inventory_cells on_hold, then reload', function () {
    var kit = { _rowIndex: 12, sku: 'K-1', brand: 'Acme', name: 'Merlot', on_hold: '1' };
    admin._setSheetStateForTest({
      kitsData: [kit], kitsHeaders: ['sku', 'stock', 'on_hold']
    });

    admin._inventoryForTest.openManualHoldModal(kit);
    document.getElementById('hold-qty').value = '2';
    document.getElementById('hold-notes').value = 'phone';
    document.getElementById('manual-hold-form').dispatchEvent(new Event('submit', { cancelable: true }));

    return flushPromises().then(function () {
      expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
      var firstBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(firstBody.action).toBe('add_hold');
      expect(firstBody.hold_id).toMatch(/^H-\d{8}-M\d{3}$/);
      expect(firstBody.sku).toBe('K-1');
      expect(firstBody.product_name).toBe('Acme Merlot');
      expect(firstBody.qty).toBe(2);
      expect(firstBody.notes).toBe('phone');

      var secondBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(secondBody.action).toBe('update_inventory_cells');
      expect(secondBody.sheet).toBe('Kits');
      expect(secondBody.updates).toEqual([{ row: 12, field: 'on_hold', value: 3 }]);
      noSheetsUrl();
    });
  });

  test('a rejected proxy call on hold placement shows the same error toast text as before', function () {
    global.fetch.mockImplementationOnce(function () {
      return Promise.resolve({ ok: false, status: 400, json: function () { return Promise.resolve({ ok: false, message: 'invalid_hold' }); } });
    });
    var kit = { _rowIndex: 12, sku: 'K-1', brand: 'Acme', name: 'Merlot', on_hold: '1' };
    admin._setSheetStateForTest({
      kitsData: [kit], kitsHeaders: ['sku', 'stock', 'on_hold']
    });

    admin._inventoryForTest.openManualHoldModal(kit);
    document.getElementById('hold-qty').value = '1';
    document.getElementById('manual-hold-form').dispatchEvent(new Event('submit', { cancelable: true }));

    return flushPromises().then(function () {
      var toastMsg = document.querySelector('.admin-toast-msg');
      expect(toastMsg).not.toBeNull();
      expect(toastMsg.textContent).toBe('Failed to place hold: invalid_hold');
    });
  });

  test('saveAllChanges with 2 kit changes + 1 ingredient change issues exactly TWO calls', function () {
    var kit1 = { _rowIndex: 3, stock: '5' };
    var kit2 = { _rowIndex: 4, stock: '6' };
    var ing1 = { _rowIndex: 7, cost: '1.00' };
    admin._setSheetStateForTest({
      kitsData: [kit1, kit2],
      kitsHeaders: ['stock', 'last_updated'],
      ingredientsData: [ing1],
      ingredientsHeaders: ['cost', 'last_updated'],
      pendingChanges: [
        { item: kit1, field: 'stock', value: '9' },
        { item: kit2, field: 'stock', value: '10' },
        { item: ing1, field: 'cost', value: '2.00' }
      ]
    });

    return new Promise(function (resolve) {
      admin._inventoryForTest.saveAllChanges();
      setTimeout(resolve, 10);
    }).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(2);
      var bodies = global.fetch.mock.calls.map(function (c) { return JSON.parse(c[1].body); });
      var kitsBody = bodies.find(function (b) { return b.sheet === 'Kits'; });
      var ingBody = bodies.find(function (b) { return b.sheet === 'Ingredients'; });
      expect(kitsBody.action).toBe('update_inventory_cells');
      // 2 kit stock changes + 2 last_updated writes = 4 update entries
      expect(kitsBody.updates.length).toBe(4);
      expect(ingBody.action).toBe('update_inventory_cells');
      // 1 ingredient cost change + 1 last_updated write = 2 update entries
      expect(ingBody.updates.length).toBe(2);
      noSheetsUrl();
    });
  });

  test('openAddKitModal submit issues append_inventory_row for Kits with a header-ordered row', function () {
    admin._setSheetStateForTest({
      kitsData: [],
      kitsHeaders: ['brand', 'name', 'sku', 'stock', 'on_order', 'on_hold', 'available', 'last_updated']
    });

    admin._inventoryForTest.openAddKitModal();
    document.getElementById('kit-brand').value = 'Acme';
    document.getElementById('kit-name').value = 'Merlot';
    document.getElementById('kit-sku').value = 'K-99';
    document.getElementById('kit-stock').value = '3';
    document.getElementById('kit-on_order').value = '0';
    document.getElementById('add-kit-form').dispatchEvent(new Event('submit', { cancelable: true }));

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('append_inventory_row');
      expect(body.sheet).toBe('Kits');
      expect(body.values[0]).toBe('Acme');
      expect(body.values[1]).toBe('Merlot');
      expect(body.values[2]).toBe('K-99');
      expect(body.values[3]).toBe('3');
      expect(body.values[4]).toBe('0');
      expect(body.values[5]).toBe('0'); // on_hold default
      expect(body.values[6]).toBe(''); // available default (formula in sheet)
      expect(typeof body.values[7]).toBe('string'); // last_updated ISO default
      noSheetsUrl();
    });
  });

  test('openAddIngredientModal submit issues append_inventory_row for Ingredients', function () {
    admin._setSheetStateForTest({
      ingredientsData: [],
      ingredientsHeaders: ['sku', 'type', 'name', 'unit', 'stock_qty', 'reorder_level', 'supplier', 'cost', 'notes', 'last_updated']
    });

    admin._inventoryForTest.openAddIngredientModal();
    document.getElementById('ing-name').value = 'Cascade Hops';
    document.getElementById('add-ing-form').dispatchEvent(new Event('submit', { cancelable: true }));

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('append_inventory_row');
      expect(body.sheet).toBe('Ingredients');
      expect(body.values[2]).toBe('Cascade Hops');
      noSheetsUrl();
    });
  });

  test('deleteIngredient issues ONE update_inventory_cells clearing every header field, then removes it locally', function () {
    var ing = { _rowIndex: 8, name: 'Cascade Hops' };
    admin._setSheetStateForTest({
      ingredientsData: [ing],
      ingredientsHeaders: ['sku', 'type', 'name', 'cost']
    });

    return admin._inventoryForTest.deleteIngredient(ing).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_inventory_cells');
      expect(body.sheet).toBe('Ingredients');
      expect(body.updates).toEqual([
        { row: 8, field: 'sku', value: '' },
        { row: 8, field: 'type', value: '' },
        { row: 8, field: 'name', value: '' },
        { row: 8, field: 'cost', value: '' }
      ]);
      noSheetsUrl();
    });
  });

  test('syncOnOrder issues ONE update_inventory_cells call and runs even when the Google access token is null', function () {
    var kit = { _rowIndex: 6, sku: 'K1', on_order: '0' };
    admin._setSheetStateForTest({
      kitsData: [kit],
      kitsHeaders: ['sku', 'on_order']
    });
    global.localStorage.setItem('sv-admin-order', JSON.stringify([{ sku: 'K1', brand: 'Acme', name: 'Merlot', qty: 5 }]));

    admin._inventoryForTest.syncOnOrder(['K1']);

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_inventory_cells');
      expect(body.sheet).toBe('Kits');
      expect(body.updates).toEqual([{ row: 6, field: 'on_order', value: 5 }]);
      noSheetsUrl();
    });
  });

  test('acceptDelivery with 2 checked items issues ONE update_inventory_cells call for stock/on_order/last_updated', function () {
    document.body.innerHTML += '<input type="checkbox" class="order-item-cb" data-sku="K1" checked>' +
      '<input type="checkbox" class="order-item-cb" data-sku="K2" checked>';
    var kit1 = { sku: 'K1', _rowIndex: 2, stock: '1', on_order: '3' };
    var kit2 = { sku: 'K2', _rowIndex: 3, stock: '2', on_order: '4' };
    admin._setSheetStateForTest({
      kitsData: [kit1, kit2],
      kitsHeaders: ['sku', 'stock', 'on_order', 'last_updated']
    });
    global.localStorage.setItem('sv-admin-order', JSON.stringify([
      { sku: 'K1', brand: 'Acme', name: 'Merlot', qty: 3 },
      { sku: 'K2', brand: 'Acme', name: 'Zin', qty: 4 }
    ]));

    admin._inventoryForTest.acceptDelivery();

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('update_inventory_cells');
      expect(body.sheet).toBe('Kits');
      // 2 kits x (stock + on_order + last_updated) = 6 entries
      expect(body.updates.length).toBe(6);
      var stockUpdates = body.updates.filter(function (u) { return u.field === 'stock'; });
      expect(stockUpdates).toEqual(expect.arrayContaining([
        { row: 2, field: 'stock', value: 4 },
        { row: 3, field: 'stock', value: 6 }
      ]));
      var onOrderUpdates = body.updates.filter(function (u) { return u.field === 'on_order'; });
      expect(onOrderUpdates).toEqual(expect.arrayContaining([
        { row: 2, field: 'on_order', value: 0 },
        { row: 3, field: 'on_order', value: 0 }
      ]));
      noSheetsUrl();
    });
  });

  test('applyImport issues import_kits with values:[kitsHeaders, ...mapped rows]', function () {
    admin._setSheetStateForTest({
      kitsHeaders: ['sku', 'brand', 'name'],
      importPreviewData: {
        headers: ['sku', 'brand', 'name'],
        rows: [{ sku: 'K-1', brand: 'Acme', name: 'Merlot' }]
      }
    });

    admin._inventoryForTest.applyImport();

    return flushPromises().then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = lastFetchBody();
      expect(body.action).toBe('import_kits');
      expect(body.values).toEqual([
        ['sku', 'brand', 'name'],
        ['K-1', 'Acme', 'Merlot']
      ]);
      noSheetsUrl();
    });
  });
});

describe('source-shape: no direct-Sheets calls remain in the 82-07 rewired functions', function () {
  var fs = require('fs');
  var path = require('path');
  var SRC = fs.readFileSync(path.join(__dirname, '../../js/admin.js'), 'utf8');

  function bodyOf(fnName) {
    var start = SRC.indexOf('function ' + fnName + '(');
    expect(start).toBeGreaterThan(-1);
    var next = SRC.indexOf('\n  function ', start + 1);
    return SRC.slice(start, next === -1 ? SRC.length : next);
  }

  [
    'updateKitStockAfterConfirm', 'updateKitOnHoldAfterRelease', 'openManualHoldModal',
    'saveAllChanges', 'openAddKitModal', 'deleteIngredient', 'openAddIngredientModal',
    'syncOnOrder', 'acceptDelivery', 'applyImport'
  ].forEach(function (fnName) {
    test(fnName + ' body contains no sheetsUpdate(/sheetsAppend(/colLetter(', function () {
      var body = bodyOf(fnName);
      expect(body).not.toMatch(/sheetsUpdate\(/);
      expect(body).not.toMatch(/sheetsAppend\(/);
      expect(body).not.toMatch(/colLetter\(/);
    });
  });
});

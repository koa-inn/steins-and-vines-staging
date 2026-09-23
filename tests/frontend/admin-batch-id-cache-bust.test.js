'use strict';

// Regression tests for Phase 82-06 D-09 (guidance 4): admin.js's
// showTransferPrompt omits batch_id on both update_batch_task writes
// (transfer-confirm and skip-transfer), so Apps Script's
// _invalidateBatchCache(payload.batch_id) receives undefined and the
// gb:<batchId> cache entry (300s TTL) is never busted -- stale batch detail
// can be served for up to 5 minutes after completing a transfer task
// (82-RESEARCH.md Pitfall 2, found live during Phase 82 research, not
// previously documented anywhere in .planning/).
//
// Both MIDDLEWARE_URL and ADMIN_API_URL are set on SHEETS_CONFIG so this
// suite is transport-agnostic: pre-Task-2 (RED state) adminApiPost still
// routes through ADMIN_API_URL; post-Task-2 (GREEN, after the proxy
// rewrite) it routes through MIDDLEWARE_URL + '/api/admin/proxy' instead.
// Either way exactly one fetch fires and its JSON body is what these
// assertions check -- the assertions stay green across the Task 2 transport
// swap because they parse the body, not the URL.

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

describe('admin.js showTransferPrompt sends batch_id on every update_batch_task write (82-06 D-09)', function () {
  var admin;

  beforeEach(function () {
    jest.resetModules();

    document.body.innerHTML =
      '<div id="admin-signin"></div>' +
      '<div id="admin-denied" style="display:none"></div>' +
      '<div id="admin-dashboard"></div>' +
      '<span id="admin-user-email">staff@example.com</span>' +
      '<button id="admin-signout"></button>' +
      '<div id="admin-modal" style="display:none">' +
      '  <h3 id="admin-modal-title"></h3>' +
      '  <div id="admin-modal-body"></div>' +
      '</div>';

    global.window = global.window || {};
    global.navigator = global.navigator || {};
    global.google = { accounts: { oauth2: { initTokenClient: jest.fn(function () { return { requestAccessToken: jest.fn() }; }) } } };
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
      ADMIN_API_URL: 'https://script.google.com/test/admin',
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
    admin._setAccessToken('test-access-token');
    admin._setUserEmail('staff@example.com');
  });

  test('clicking #transfer-skip sends batch_id + task_id on update_batch_task', function () {
    admin._showTransferPromptForTest('SV-B-000123', 'BT-000009');

    document.getElementById('transfer-skip').click();

    return flushPromises().then(function () {
      // showTransferPrompt's success handler re-opens the batch detail view
      // (openBatchDetail), which issues further reads -- the update_batch_task
      // write under test is always the FIRST fetch call, regardless of what
      // follows it.
      expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
      var call = global.fetch.mock.calls[0];
      var body = JSON.parse(call[1].body);
      expect(body.action).toBe('update_batch_task');
      expect(body.task_id).toBe('BT-000009');
      expect(body.batch_id).toBe('SV-B-000123');
    });
  });

  test('setting a vessel and clicking #transfer-confirm sends batch_id + transfer_location', function () {
    admin._showTransferPromptForTest('SV-B-000123', 'BT-000009');

    document.getElementById('transfer-vessel').value = 'V-1';
    document.getElementById('transfer-confirm').click();

    return flushPromises().then(function () {
      expect(global.fetch.mock.calls.length).toBeGreaterThanOrEqual(1);
      var call = global.fetch.mock.calls[0];
      var body = JSON.parse(call[1].body);
      expect(body.action).toBe('update_batch_task');
      expect(body.batch_id).toBe('SV-B-000123');
      expect(body.transfer_location.vessel_id).toBe('V-1');
    });
  });
});

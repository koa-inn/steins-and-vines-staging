'use strict';

// Phase 82-08 (DB-01): parity tests for js/batch.js's public batch page.
//
// Task 1 (this file, initial version) characterizes TODAY's transport --
// direct calls to SHEETS_CONFIG.ADMIN_API_URL (Apps Script) -- so the
// request shapes are pinned before Task 2 repoints them onto
// MIDDLEWARE_URL + /api/batch/public/* (D-13). Task 2 updates the
// assertions below to the new contract in the same RED->GREEN commit.
//
// Harness: DOM-fixture + SHEETS_CONFIG stub pattern from
// tests/frontend/admin-session-auth.test.js, global-stub pattern from
// tests/frontend/brewpad-read-retry.test.js.

var BATCH_ID = 'SV-B-000123';
var BATCH_TOKEN = new Array(33).join('a'); // 32 chars, ES5-safe repeat

document.body.innerHTML =
  '<div id="batch-loading" class="batch-loading"><p>Loading batch details...</p></div>' +
  '<div id="batch-error" class="batch-error" style="display:none;"><h2>Batch Not Found</h2><p>This batch link may be invalid or expired.</p></div>' +
  '<div id="batch-content" style="display:none;">' +
  '  <div class="batch-card batch-hero">' +
  '    <div id="batch-status-badge" class="batch-hero-status"></div>' +
  '    <h1 id="batch-title"></h1>' +
  '    <div class="batch-hero-meta">' +
  '      <span id="batch-product"></span>' +
  '      <span id="batch-customer"></span>' +
  '      <span id="batch-start-date"></span>' +
  '    </div>' +
  '    <div class="batch-hero-location">' +
  '      <span>Shelf: <strong id="batch-shelf"></strong></span>' +
  '      <span>Bin: <strong id="batch-bin"></strong></span>' +
  '      <span>Vessel: <strong id="batch-vessel"></strong></span>' +
  '    </div>' +
  '  </div>' +
  '  <div class="batch-card"><h2>Schedule &amp; Tasks</h2><div id="batch-tasks-list" class="batch-tasks-list"></div></div>' +
  '  <div class="batch-card">' +
  '    <h2>Plato Readings</h2>' +
  '    <div id="batch-plato-chart" class="batch-plato-chart"></div>' +
  '    <div id="batch-plato-list" class="batch-plato-list"></div>' +
  '    <div class="batch-plato-add">' +
  '      <input type="date" id="plato-date" class="batch-input">' +
  '      <input type="number" id="plato-value" class="batch-input">' +
  '      <input type="number" id="plato-temp" class="batch-input">' +
  '      <input type="number" id="plato-ph" class="batch-input">' +
  '      <input type="text" id="plato-notes" class="batch-input">' +
  '      <button type="button" class="btn" id="plato-add-row-btn">Add Row</button>' +
  '      <div id="plato-staging-wrap"></div>' +
  '    </div>' +
  '  </div>' +
  '  <div class="batch-card" id="batch-notes-card" style="display:none;"><h2>Notes</h2><p id="batch-notes" class="batch-notes-text"></p></div>' +
  '  <div class="batch-card" id="batch-history-card" style="display:none;"><h2>Location History</h2><div id="batch-vessel-history" class="batch-vessel-history"></div></div>' +
  '</div>' +
  '<div id="batch-toast-container" class="batch-toast-container"></div>';

global.SHEETS_CONFIG = {
  ADMIN_API_URL: 'https://script.google.com/test/admin',
  MIDDLEWARE_URL: 'http://mw.test'
};

global.fetch = jest.fn();

window.history.pushState({}, '', '/batch.html?id=' + BATCH_ID + '&token=' + BATCH_TOKEN);

var bp = require('../../js/batch.js');

function minimalBatchPayload() {
  return {
    ok: true,
    data: {
      batch: {
        batch_id: BATCH_ID,
        status: 'primary',
        product_name: 'Test Wine Kit',
        customer_name: 'Test Customer',
        start_date: '2026-09-01',
        vessel_id: 'V-1',
        shelf_id: 'S-1',
        bin_id: 'B-1',
        notes: ''
      },
      tasks: [],
      plato_readings: [],
      vessel_history: []
    }
  };
}

function mockFetchOnce(body) {
  global.fetch.mockImplementationOnce(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  });
}

describe('batch.js public transport -- characterization of today\'s Apps-Script calls', function () {
  beforeEach(function () {
    global.fetch.mockClear();
    bp._setStateForTest({ batchId: '', batchToken: '', apiUrl: '' });
  });

  test('module.exports test seam is present', function () {
    expect(typeof bp.init).toBe('function');
    expect(typeof bp.loadBatch).toBe('function');
    expect(typeof bp.toggleTask).toBe('function');
    expect(typeof bp.submitPlatoReadings).toBe('function');
    expect(typeof bp.refreshBatchOnce).toBe('function');
  });

  test('init() fetches ADMIN_API_URL with the get_batch_public query string', function () {
    mockFetchOnce(minimalBatchPayload());

    bp.init();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var url = global.fetch.mock.calls[0][0];
    expect(url).toBe(
      'https://script.google.com/test/admin?action=get_batch_public&batch_id=' + BATCH_ID + '&token=' + BATCH_TOKEN
    );

    var state = bp._getStateForTest();
    expect(state.batchId).toBe(BATCH_ID);
    expect(state.batchToken).toBe(BATCH_TOKEN);
  });

  test('toggleTask() POSTs to ADMIN_API_URL as text/plain with the update_batch_task action', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'https://script.google.com/test/admin' });
    mockFetchOnce({ ok: true });
    mockFetchOnce(minimalBatchPayload()); // toggleTask() calls loadBatch() again on success

    bp.toggleTask('BT-000001', true);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('https://script.google.com/test/admin');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('text/plain');
    var body = JSON.parse(call[1].body);
    expect(body.action).toBe('update_batch_task');
    expect(body.batch_token).toBe(BATCH_TOKEN);
    expect(body.batch_id).toBe(BATCH_ID);
    expect(body.task_id).toBe('BT-000001');
    expect(body.updates).toEqual({ completed: true });
  });

  test('submitPlatoReadings() posts bulk_add_plato_readings with the staged rows', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'https://script.google.com/test/admin' });
    var rows = [{ timestamp: '2026-09-10', degrees_plato: 12.5, temperature: 20, ph: 4.2, notes: 'ok' }];
    bp._setStagingRowsForTest(rows);
    mockFetchOnce({ ok: true, results: [{ reading_id: 'PR-1' }] });

    var submitBtn = document.createElement('button');
    bp.submitPlatoReadings(submitBtn);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('https://script.google.com/test/admin');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('text/plain');
    var body = JSON.parse(call[1].body);
    expect(body.action).toBe('bulk_add_plato_readings');
    expect(body.batch_token).toBe(BATCH_TOKEN);
    expect(body.batch_id).toBe(BATCH_ID);
    expect(body.readings).toEqual(rows);
  });

  test('refreshBatchOnce() fetches the same GET URL as loadBatch()', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'https://script.google.com/test/admin' });
    mockFetchOnce(minimalBatchPayload());

    bp.refreshBatchOnce();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var url = global.fetch.mock.calls[0][0];
    expect(url).toBe(
      'https://script.google.com/test/admin?action=get_batch_public&batch_id=' + BATCH_ID + '&token=' + BATCH_TOKEN
    );
  });
});

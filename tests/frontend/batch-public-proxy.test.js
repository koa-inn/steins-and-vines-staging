'use strict';

// Phase 82-08 (DB-01): parity tests for js/batch.js's public batch page.
//
// Task 1 pinned TODAY's Apps-Script transport (ADMIN_API_URL) as a
// characterization suite. Task 2 (this version) flips the assertions to
// the D-13 contract: MIDDLEWARE_URL + /api/batch/public/:id[/tasks|/readings],
// built by 82-05 in a later wave -- these tests mock fetch, so there is no
// runtime dependency on that route existing yet.
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

// No ADMIN_API_URL -- batch.js must no longer read it (D-13/D-23).
global.SHEETS_CONFIG = {
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

function toastCount() {
  return document.getElementById('batch-toast-container').children.length;
}

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

describe('batch.js public transport -- /api/batch/public/* (D-13)', function () {
  beforeEach(function () {
    global.fetch.mockClear();
    global.SHEETS_CONFIG.MIDDLEWARE_URL = 'http://mw.test';
    bp._setStateForTest({ batchId: '', batchToken: '', apiUrl: '' });
  });

  test('module.exports test seam is present', function () {
    expect(typeof bp.init).toBe('function');
    expect(typeof bp.loadBatch).toBe('function');
    expect(typeof bp.toggleTask).toBe('function');
    expect(typeof bp.submitPlatoReadings).toBe('function');
    expect(typeof bp.refreshBatchOnce).toBe('function');
  });

  test('init() with MIDDLEWARE_URL fetches the middleware batch/public route (GET) and renders', function () {
    mockFetchOnce(minimalBatchPayload());

    bp.init();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('http://mw.test/api/batch/public/' + BATCH_ID + '?token=' + BATCH_TOKEN);
    expect(call[1]).toBeUndefined(); // GET, no options body

    var state = bp._getStateForTest();
    expect(state.batchId).toBe(BATCH_ID);
    expect(state.batchToken).toBe(BATCH_TOKEN);
  });

  test('init() with MIDDLEWARE_URL empty shows the Configuration error state and issues no fetch', function () {
    global.SHEETS_CONFIG.MIDDLEWARE_URL = '';

    bp.init();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('batch-error').style.display).toBe('');
    expect(document.getElementById('batch-error').querySelector('p').textContent).toBe('Configuration error');
  });

  test('toggleTask() POSTs JSON to .../tasks with only batch_token/task_id/updates (no action, no batch_id)', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    mockFetchOnce({ ok: true });
    mockFetchOnce(minimalBatchPayload()); // toggleTask() calls loadBatch() again on success

    bp.toggleTask('BT-000001', true);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('http://mw.test/api/batch/public/' + BATCH_ID + '/tasks');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    var body = JSON.parse(call[1].body);
    expect(body).toEqual({ batch_token: BATCH_TOKEN, task_id: 'BT-000001', updates: { completed: true } });
  });

  test('submitPlatoReadings() POSTs JSON to .../readings with only batch_token/readings', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    var rows = [{ timestamp: '2026-09-10', degrees_plato: 12.5, temperature: 20, ph: 4.2, notes: 'ok' }];
    bp._setStagingRowsForTest(rows);
    mockFetchOnce({ ok: true, results: [{ reading_id: 'PR-1' }] });

    var submitBtn = document.createElement('button');
    bp.submitPlatoReadings(submitBtn);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    var call = global.fetch.mock.calls[0];
    expect(call[0]).toBe('http://mw.test/api/batch/public/' + BATCH_ID + '/readings');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['Content-Type']).toBe('application/json');
    var body = JSON.parse(call[1].body);
    expect(body).toEqual({ batch_token: BATCH_TOKEN, readings: rows });
  });

  test('refreshBatchOnce() fetches the same GET URL as init() and does not render on {ok:false}', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });

    // Seed batchData with a successful load first.
    mockFetchOnce(minimalBatchPayload());
    bp.loadBatch();
    return flushPromises().then(function () {
      var seeded = bp._getStateForTest().batchData;
      expect(seeded).not.toBeNull();

      global.fetch.mockClear();
      mockFetchOnce({ ok: false, error: 'rate_limited' });

      var p = bp.refreshBatchOnce();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      var url = global.fetch.mock.calls[0][0];
      expect(url).toBe('http://mw.test/api/batch/public/' + BATCH_ID + '?token=' + BATCH_TOKEN);

      return p.then(function () {
        // On a failure response the poll increments its failure counter and
        // does NOT overwrite batchData -- the render path is untouched.
        expect(bp._getStateForTest().batchData).toBe(seeded);
      });
    });
  });

  test('a 429/502 JSON error response from toggleTask surfaces via the toast path without throwing', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    var before = toastCount();
    mockFetchOnce({ ok: false, error: 'server_error' });

    expect(function () { bp.toggleTask('BT-000001', true); }).not.toThrow();

    return flushPromises().then(function () {
      expect(toastCount()).toBe(before + 1);
    });
  });

  test('a 429/502 JSON error response from submitPlatoReadings surfaces via the toast path without throwing', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    bp._setStagingRowsForTest([{ timestamp: '2026-09-10', degrees_plato: 12 }]);
    var before = toastCount();
    mockFetchOnce({ ok: false, error: 'server_error' });
    var submitBtn = document.createElement('button');

    expect(function () { bp.submitPlatoReadings(submitBtn); }).not.toThrow();

    return flushPromises().then(function () {
      expect(toastCount()).toBe(before + 1);
    });
  });

  test('no request URL anywhere contains script.google.com or ?action=', function () {
    bp._setStateForTest({ batchId: BATCH_ID, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    bp._setStagingRowsForTest([{ timestamp: '2026-09-10', degrees_plato: 12 }]);
    mockFetchOnce(minimalBatchPayload()); // loadBatch (via init)
    mockFetchOnce({ ok: true }); // toggleTask
    mockFetchOnce(minimalBatchPayload()); // toggleTask's follow-up loadBatch
    mockFetchOnce({ ok: true, results: [] }); // submitPlatoReadings
    mockFetchOnce(minimalBatchPayload()); // refreshBatchOnce

    bp.init();
    bp.toggleTask('BT-000001', true);
    bp.submitPlatoReadings(document.createElement('button'));
    bp.refreshBatchOnce();

    var urls = global.fetch.mock.calls.map(function (c) { return c[0]; });
    urls.forEach(function (url) {
      expect(url).not.toMatch(/script\.google\.com/);
      expect(url).not.toMatch(/\?action=/);
    });
  });

  test('batchId characters needing encoding are passed through encodeURIComponent in the path', function () {
    var weirdId = 'SV-B-000123/../etc';
    bp._setStateForTest({ batchId: weirdId, batchToken: BATCH_TOKEN, apiUrl: 'http://mw.test' });
    mockFetchOnce(minimalBatchPayload());

    bp.loadBatch();

    var url = global.fetch.mock.calls[0][0];
    expect(url).toBe('http://mw.test/api/batch/public/' + encodeURIComponent(weirdId) + '?token=' + encodeURIComponent(BATCH_TOKEN));
  });
});

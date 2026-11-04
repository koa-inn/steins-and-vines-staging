'use strict';

// Phase 97-10 Task 1: 'Ready to Bottle (N)' filter chip, live count, shared empty copy (D-13).

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
var _ssData = {};
global.sessionStorage = {
  getItem: function (k) { return _ssData[k] !== undefined ? _ssData[k] : null; },
  setItem: function (k, v) { _ssData[k] = v; },
  removeItem: function (k) { delete _ssData[k]; },
  clear: function () { _ssData = {}; }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }

function batches() {
  return [
    { batch_id: 'A', product_name: 'Alpha', status: 'secondary', zoho_so_number: 'INV-1', source: 'manual' },
    { batch_id: 'B', product_name: 'Bravo', status: 'secondary', zoho_so_number: 'INV-2', source: 'manual' },
    { batch_id: 'C', product_name: 'Charlie', status: 'primary', zoho_so_number: 'INV-3', source: 'manual' }
  ];
}

function mount(summaryList, filter) {
  document.body.innerHTML =
    '<div id="bp-dashboard-inner"></div><div id="bp-panel-dashboard"></div>' +
    '<div id="bp-batch-list-pane"></div><div id="bp-toast-container"></div>';
  var list = batches();
  bp._setStateForTest({
    _allBatchesData: list,
    _batchStatusFilter: filter || 'active',
    _batchesData: [],
    _dashData: { asOf: ASOF, batches: list, staffBatchIds: [] },
    _dashSummary: { readyToBottle: summaryList }
  });
  bp.applyBatchFilter();
  bp._renderBatchListForTest();
}

function chip() { return document.querySelector('.bp-filter-btn[data-status="readyToBottle"]'); }

describe('Ready to Bottle filter chip (97-10)', function () {
  beforeEach(function () {
    window.localStorage.clear();
    window.Chart = function () {};
  });

  test('chip reads Ready to Bottle (2) with no badge span', function () {
    mount([{ batch_id: 'A' }, { batch_id: 'C' }]);
    expect(chip().textContent).toBe('Ready to Bottle (2)');
    expect(chip().querySelector('span')).toBeNull();
  });

  test('empty list reads Ready to Bottle (0)', function () {
    mount([]);
    expect(chip().textContent).toBe('Ready to Bottle (0)');
  });

  test('selecting the filter lists A and C only and equals the v2 widget count', async function () {
    mount([{ batch_id: 'A' }, { batch_id: 'C' }], 'readyToBottle');
    var ids = bp.getStateForTest()._batchesData.map(function (b) { return b.batch_id; });
    expect(ids).toEqual(['A', 'C']);
    expect(chip().textContent).toBe('Ready to Bottle (2)');

    window.history.replaceState(null, '', '/brewpad.html?dash=v2');
    bp._initDashV2FlagForTest();
    bp._renderDashboardForTest();
    await flush();
    var title = document.querySelector('#bp-dash-v2-rtb .bp-widget-title');
    expect(title.textContent).toBe('Ready to bottle (2)');
  });

  test('after the summary refetch returns [C] the list and chip update without a shell rebuild', function () {
    mount([{ batch_id: 'A' }, { batch_id: 'C' }], 'readyToBottle');
    var before = chip();
    bp._setStateForTest({ _dashSummary: { readyToBottle: [{ batch_id: 'C' }] } });
    bp.applyBatchFilter();
    bp._renderBatchListForTest();
    expect(chip()).toBe(before);
    expect(chip().textContent).toBe('Ready to Bottle (1)');
    expect(bp.getStateForTest()._batchesData.map(function (b) { return b.batch_id; })).toEqual(['C']);
  });

  test('empty filter result shows the shared empty copy', function () {
    mount([], 'readyToBottle');
    expect(document.getElementById('bp-batch-results').textContent).toContain('No batches are ready to bottle.');
  });

  test('pending badge behaviour is unchanged', function () {
    document.body.innerHTML = '<div id="bp-batch-list-pane"></div>';
    bp._setStateForTest({
      _allBatchesData: [{ batch_id: 'P1', status: 'pending' }, { batch_id: 'P2', status: 'pending' }],
      _batchStatusFilter: 'active', _batchesData: [], _dashSummary: { readyToBottle: [] }
    });
    bp.applyBatchFilter();
    bp._renderBatchListForTest();
    var pending = document.querySelector('.bp-filter-btn[data-status="pending"]');
    expect(pending.querySelector('span').textContent).toBe('2');
  });
});

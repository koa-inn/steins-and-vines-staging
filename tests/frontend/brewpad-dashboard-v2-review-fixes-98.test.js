'use strict';

// Phase 98 code-review fixes WR-01..WR-03.

var fs = require('fs');
var path = require('path');

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.SHEETS_CONFIG = { MIDDLEWARE_URL: 'http://mw.test' };
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
var UNAVAILABLE = 'Not available yet. Reopen the Dashboard tab to refresh.';

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
async function flushN(n) { for (var i = 0; i < (n || 4); i++) await flush(); }

function d(n) {
  var p = TODAY.split('-');
  var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

function lean(id, type, extra) {
  return Object.assign({
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: YEAR + '-01-05', completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  }, extra || {});
}

var seq = 0;
function task(batch, title, due, extra) {
  seq++;
  return Object.assign({ batch_id: batch, task_id: 'T' + seq, title: title, due_date: due, completed: false, step_number: seq }, extra || {});
}

var waitlistImpl;
var requests;

function resp(body) {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

function installFetch() {
  requests = [];
  global.fetch = jest.fn(function (url, init) {
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
    requests.push({ url: String(url), action: body.action, body: body });
    if (body.action === 'get_waitlist') return waitlistImpl();
    if (body.action === 'get_tasks_upcoming') return resp({ ok: true, data: { tasks: [] } });
    return resp({ ok: true, data: {} });
  });
}

function failedResp() {
  return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false, error: 'down' }); } });
}

function mount(opts) {
  var o = opts || {};
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div><div id="bp-panel-tasks"><div id="bp-tasks-inner"></div></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var list = [lean('W1', 'wine')];
  bp._setStateForTest({
    _allBatchesData: list,
    _dashData: { asOf: ASOF, batches: list, staffBatchIds: [], batchMeta: [], inviteSentIds: [] },
    _dashSummary: {},
    _dashWineSkuLookup: {},
    _dashLoadTime: 1,
    _dashWaitlist: { tok: null, loadTime: null, state: 'loading', count: 0 },
    _dashInviteSent: {},
    _taskFilter: 'incomplete'
  });
  bp._setStateForTest({ _upcomingTasks: o.tasks || [], _upcomingLoaded: true, _upcomingTruncated: !!o.truncated });
}

async function renderV2() {
  window.history.replaceState(null, '', '/brewpad.html?dash=v2');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flushN();
}

function slot() { return document.getElementById('bp-dash-v2-attn'); }
function chip(key) { return slot().querySelector('[data-attn="' + key + '"]'); }
function waitlistCalls() { return requests.filter(function (r) { return r.action === 'get_waitlist'; }).length; }

beforeEach(function () {
  window.localStorage.clear();
  window.Chart = function () {};
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  waitlistImpl = function () { return resp({ ok: true, data: [{ email: 'a@x.ca', status: 'waiting' }] }); };
  installFetch();
});

afterEach(function () { delete window.Chart; });

describe('WR-01: chip-set task filter does not stick', function () {
  test('chip tap lands on Overdue; opening Tasks from the tab bar resets to incomplete', async function () {
    mount({ tasks: [task('W1', 'a', d(-2)), task('W1', 'c', d(0))] });
    await renderV2();
    chip('overdue').click();
    expect(bp.getStateForTest()._taskFilter).toBe('overdue');
    bp._handleTabBarClickForTest('dashboard');
    bp._handleTabBarClickForTest('tasks');
    expect(bp.getStateForTest()._taskFilter).toBe('incomplete');
  });

  test('a Due today chip tap still lands on duetoday', async function () {
    mount({ tasks: [task('W1', 'c', d(0))] });
    await renderV2();
    chip('today').click();
    expect(bp.getStateForTest()._taskFilter).toBe('duetoday');
  });
});

describe('WR-02: truncated task list is signalled', function () {
  test('counts get a + suffix when the task list hit its limit', async function () {
    mount({ tasks: [task('W1', 'a', d(-2)), task('W1', 'c', d(0))], truncated: true });
    await renderV2();
    expect(chip('overdue').querySelector('.bp-attn-count').textContent).toBe('(1+)');
    expect(chip('today').querySelector('.bp-attn-count').textContent).toBe('(1+)');
  });

  test('no + suffix when the list was not truncated', async function () {
    mount({ tasks: [task('W1', 'a', d(-2))] });
    await renderV2();
    expect(chip('overdue').querySelector('.bp-attn-count').textContent).toBe('(1)');
  });
});


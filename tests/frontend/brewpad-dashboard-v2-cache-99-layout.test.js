'use strict';

// Phase 99-04 follow-up: the cached render must lay out like the fresh one (CLS). Layout shift itself
// cannot be asserted in jsdom; this pins the data-side cause (cached tasks treated as unavailable).

var fs = require('fs');
var path = require('path');

global.google = { accounts: { oauth2: { initTokenClient: jest.fn(), revoke: jest.fn() } } };
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

var KEY = 'bp_dash_cache_v1';
var EMAIL = 'staff@example.ca';
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
async function flushN(n) { for (var i = 0; i < (n || 6); i++) await flush(); }

function lean(id, type, extra) {
  return Object.assign({
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: YEAR + '-01-05', completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  }, extra || {});
}

function dash(extra) {
  return Object.assign({ asOf: ASOF, batches: [lean('W1', 'wine')], staffBatchIds: [], batchMeta: [], inviteSentIds: [] }, extra || {});
}

function entry(over) {
  return Object.assign({
    v: 1, day: TODAY, savedAt: Date.now() - 60000, email: EMAIL,
    dashData: dash(), fermSchedules: [], upcomingTasks: []
  }, over || {});
}

function setSession(email) {
  window.localStorage.setItem('sv-brewpad-session', JSON.stringify({
    token: 't', expires_at: Date.now() + 3600000, email: email, login_at: Date.now()
  }));
}

function mount() {
  document.body.innerHTML =
    '<div id="bp-signin"></div><div id="bp-app"></div>' +
    '<div class="bp-dash-switch-row"><p id="bp-dash-asof" class="bp-dash-asof" role="status" aria-live="polite" hidden></p>' +
    '<button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
}

var pending;
var requests;
var failing;

function resp(body) {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

// Admin-proxy reads stay pending until release(action, body) or fail(action).
function installDeferredFetch() {
  pending = {};
  requests = [];
  failing = false;
  global.fetch = jest.fn(function (url, init) {
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
    requests.push(body.action);
    if (failing && /admin-proxy/.test(String(url))) return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false, error: 'down' }); } });
    if (/admin-proxy/.test(String(url)) && /get_dashboard_stats|get_batches|get_vessels|get_ferm_schedules|get_tasks_upcoming|get_batch_dashboard_summary/.test(body.action)) {
      return new Promise(function (res, rej) { pending[body.action] = { res: res, rej: rej }; });
    }
    return resp({ ok: true, data: {} });
  });
}

function release(action, body) { pending[action].res({ ok: true, status: 200, json: function () { return Promise.resolve(body); } }); }
function failAll() {
  Object.keys(pending).forEach(function (k) {
    pending[k].res({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false, error: 'down' }); } });
  });
}
function releaseAll(statsData) {
  release('get_dashboard_stats', { ok: true, data: statsData });
  release('get_batches', { ok: true, data: { batches: [] } });
  release('get_vessels', { ok: true, data: { vessels: [] } });
  release('get_ferm_schedules', { ok: true, data: { schedules: [] } });
  release('get_tasks_upcoming', { ok: true, data: { tasks: [] } });
}

function hint() { return document.getElementById('bp-dash-asof'); }
function inner() { return document.getElementById('bp-dashboard-inner'); }

beforeEach(function () {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/brewpad.html?dash=v2');
  window.Chart = function () {};
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  mount();
  bp._initDashV2FlagForTest();
  bp._setStateForTest({ _dashData: null, _dashSummary: null, _dashLoadTime: 0, _upcomingTasks: [], _upcomingLoaded: false });
  setSession(EMAIL);
  installDeferredFetch();
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});

describe('cached render shows the cached Today tasks and task chips (no "Not available" placeholder)', function () {
  var TASK = { task_id: 'T1', batch_id: 'W1', title: 'Racking', due_date: '2000-01-01', completed: false };

  test('hydrated render lists the overdue task and the Overdue chip', function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry({ upcomingTasks: [TASK] })));
    bp._eagerLoadForTest();
    var tasks = document.getElementById('bp-dash-v2-today-tasks');
    expect(tasks.textContent).not.toMatch(/Not available yet/);
    expect(tasks.textContent).toMatch(/Racking/);
    expect(document.getElementById('bp-dash-v2-attn').textContent).toMatch(/Overdue/);
  });

  test('fresh data without tasks falls back to the unavailable message (flag cleared on fresh)', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry({ upcomingTasks: [TASK] })));
    bp._eagerLoadForTest();
    await flushN();
    release('get_dashboard_stats', { ok: true, data: dash() });
    release('get_batches', { ok: true, data: { batches: [] } });
    release('get_vessels', { ok: true, data: { vessels: [] } });
    release('get_ferm_schedules', { ok: true, data: { schedules: [] } });
    pending['get_tasks_upcoming'].res({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false }); } });
    await flushN();
    expect(document.getElementById('bp-dash-v2-today-tasks').textContent).toMatch(/Not available yet/);
  });
});

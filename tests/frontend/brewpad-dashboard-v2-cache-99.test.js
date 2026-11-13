'use strict';

// Phase 99-04: cached-first dashboard render (D-07, D-08), as-of hint, skeletons, sign-out clear.

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

describe('cached-first hydration', function () {
  test('same-day same-user entry renders #bp-dash-v2 before any network response with the Updating hint', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
    expect(document.getElementById('bp-dash-v2-attn')).not.toBeNull();
    expect(bp.getStateForTest()._dashLoadTime).toBe(0);
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toMatch(/^As of .+ · Updating…$/);
    expect(inner().getAttribute('aria-busy')).not.toBe('true');
  });

  test('fresh data swaps in place (same shell node), hint reads Updated, _dashLoadTime set', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    var shell = document.getElementById('bp-dash-v2');
    await flushN();
    releaseAll(dash({ batches: [lean('W1', 'wine'), lean('B1', 'beer')] }));
    await flushN();
    expect(document.getElementById('bp-dash-v2')).toBe(shell);
    expect(bp.getStateForTest()._dashData.batches.length).toBe(2);
    expect(bp.getStateForTest()._dashLoadTime).toBeGreaterThan(0);
    expect(hint().textContent).toMatch(/^Updated /);
  });

  test('refresh failure keeps the cached render and shows the Couldn\'t refresh hint', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    var shell = document.getElementById('bp-dash-v2');
    await flushN();
    failing = true;
    failAll();
    await flushN(10);
    expect(document.getElementById('bp-dash-v2')).toBe(shell);
    expect(hint().textContent).toMatch(/Couldn't refresh\. Reopen the Dashboard tab to try again\.$/);
  });

  test('successful load writes the cache for today and the signed-in user', async function () {
    bp._eagerLoadForTest();
    await flushN();
    releaseAll(dash());
    await flushN();
    var saved = JSON.parse(window.localStorage.getItem(KEY));
    expect(saved.v).toBe(1);
    expect(saved.day).toBe(TODAY);
    expect(saved.email).toBe(EMAIL);
    expect(saved.dashData.batches.length).toBe(1);
  });

  test('hint text never contains the word stale', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    expect(hint().textContent.toLowerCase()).not.toContain('stale');
  });
});

describe('cache rejection', function () {
  var cases = {
    'yesterday': function () { return JSON.stringify(entry({ day: '2020-01-01' })); },
    'another user': function () { return JSON.stringify(entry({ email: 'other@example.ca' })); },
    'v:2': function () { return JSON.stringify(entry({ v: 2 })); },
    'corrupt JSON': function () { return '{not json'; }
  };
  Object.keys(cases).forEach(function (name) {
    test(name + ' is ignored, removed, and skeletons show with aria-busy', async function () {
      window.localStorage.setItem(KEY, cases[name]());
      bp._eagerLoadForTest();
      expect(document.getElementById('bp-dash-v2')).toBeNull();
      expect(inner().getAttribute('aria-busy')).toBe('true');
      expect(inner().querySelectorAll('.bp-skeleton-block').length).toBeGreaterThan(3);
      expect(hint().hidden).toBe(true);
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });
  });

  test('skeleton shapes: chips, rows, tiles, charts, all aria-hidden; aria-busy cleared on render', async function () {
    bp._eagerLoadForTest();
    var el = inner();
    expect(el.querySelectorAll('.bp-skeleton-block--chip').length).toBe(3);
    expect(el.querySelectorAll('.bp-skeleton-block--row').length).toBe(3);
    expect(el.querySelectorAll('.bp-skeleton-block--tile').length).toBeGreaterThan(0);
    expect(el.querySelectorAll('.bp-skeleton-block--chart').length).toBeGreaterThan(0);
    Array.prototype.forEach.call(el.querySelectorAll('.bp-skeleton-block'), function (b) {
      expect(b.closest('[aria-hidden="true"]')).not.toBeNull();
    });
    await flushN();
    releaseAll(dash());
    await flushN();
    expect(inner().hasAttribute('aria-busy') && inner().getAttribute('aria-busy') === 'true').toBe(false);
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
  });
});

describe('hint element', function () {
  test('brewpad.html has #bp-dash-asof as a polite status region', function () {
    var html = fs.readFileSync(path.join(__dirname, '../../brewpad.html'), 'utf8');
    expect(html).toMatch(/id="bp-dash-asof"[^>]*role="status"/);
    expect(html).toMatch(/id="bp-dash-asof"[^>]*aria-live="polite"/);
  });

  test('textContent is only rewritten on a state transition', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    var node = hint().firstChild;
    bp._renderDashboardForTest();
    expect(hint().firstChild).toBe(node);
  });
});

describe('sign-out clears the cache (T-99-14)', function () {
  test('bpSignOut removes bp_dash_cache_v1', function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._dashCacheForTest.signOut();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  test('_enterLoggedOutState removes bp_dash_cache_v1', function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._dashCacheForTest.loggedOut();
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('storage failures', function () {
  test('setItem throwing does not throw out of the load path', async function () {
    var spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k) {
      if (k === KEY) throw new Error('QuotaExceededError');
    });
    bp._eagerLoadForTest();
    await flushN();
    releaseAll(dash());
    await flushN();
    expect(document.getElementById('bp-dash-v2')).not.toBeNull();
    spy.mockRestore();
  });

  test('read of a missing key returns null', function () {
    expect(bp._dashCacheForTest.read()).toBeNull();
  });
});

describe('side fetches fire once per fresh load', function () {
  test('cached render does not start the cards fetch; the fresh render does, once', async function () {
    window.localStorage.setItem(KEY, JSON.stringify(entry()));
    bp._eagerLoadForTest();
    await flushN();
    var before = requests.filter(function (a) { return a === 'get_waitlist'; }).length;
    expect(before).toBe(0);
    releaseAll(dash());
    await flushN(10);
    var after = requests.filter(function (a) { return a === 'get_waitlist'; }).length;
    expect(after).toBeLessThanOrEqual(1);
  });
});

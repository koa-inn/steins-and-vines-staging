'use strict';

// Phase 98-04: v2 Today "Needs attention" chip row.

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
    if (body.action === 'get_batch') return resp({ ok: true, data: { batch: { customer_email: 'c@example.ca', customer_name: 'C' } } });
    if (/bottling-invite/.test(String(url))) return resp({ success: true, sent_at: '2026-11-05T10:00:00Z' });
    return resp({ ok: true, data: {} });
  });
}

function failedResp() {
  return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false, error: 'down' }); } });
}

function wlRows(n) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ email: 'w' + i + '@x.ca', status: 'waiting' });
  out.push({ email: 'gone@x.ca', status: 'removed' });
  return out;
}

function mount(opts) {
  var o = opts || {};
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var list = o.batches || [lean('W1', 'wine')];
  var dash = o.noDash ? null : Object.assign({
    asOf: ASOF, batches: list, staffBatchIds: [], batchMeta: [], inviteSentIds: []
  }, o.extra || {});
  bp._setStateForTest({
    _allBatchesData: list,
    _dashData: dash,
    _dashSummary: o.summary || {},
    _dashWineSkuLookup: {},
    _dashLoadTime: o.loadTime || 1,
    _dashWaitlist: { tok: null, loadTime: null, state: 'loading', count: 0 },
    _dashInviteSent: {}
  });
  bp._setStateForTest({ _upcomingTasks: o.tasks || [], _upcomingLoaded: o.loaded !== false });
}

function setUrl(hash) { window.history.replaceState(null, '', '/brewpad.html?dash=v2' + (hash || '')); }

async function renderV2(hash) {
  setUrl(hash ? '#' + hash : '');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flushN();
}

function slot() { return document.getElementById('bp-dash-v2-attn'); }
function chips() { return Array.prototype.slice.call(slot().querySelectorAll('.bp-attn button')); }
function keys() { return chips().map(function (c) { return c.getAttribute('data-attn'); }); }
function count(key) { return slot().querySelector('[data-attn="' + key + '"] .bp-attn-count').textContent; }
function waitlistCalls() { return requests.filter(function (r) { return r.action === 'get_waitlist'; }).length; }

function rtb(id, extra) { return Object.assign({ batch_id: id, product_name: 'P' + id, customer_name: 'C' + id, has_email: true, bottling_due: d(1) }, extra || {}); }

beforeEach(function () {
  window.localStorage.clear();
  window.Chart = function () {};
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  waitlistImpl = function () { return resp({ ok: true, data: wlRows(3) }); };
  installFetch();
  mount();
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});

function fullFixture() {
  var batches = [lean('W1', 'wine'), lean('P1', 'beer', { start_date: d(-30) })];
  return {
    batches: batches,
    extra: { batchMeta: [{ batch_id: 'P1', planned_days: 10 }] },
    tasks: [task('W1', 'a', d(-2)), task('W1', 'b', d(-1)), task('W1', 'c', d(0))],
    summary: { readyToBottle: [rtb('R1')] }
  };
}

describe('lead slot', function () {
  test('sits between the section head and the grid, grid children unchanged', async function () {
    await renderV2('');
    var sec = document.querySelector('section[data-dash-sec="today"]');
    var kids = Array.prototype.map.call(sec.children, function (c) { return c.className.split(' ')[0] + '#' + c.id; });
    expect(kids).toEqual(['bp-dash-section-head#', 'bp-dash-lead#bp-dash-v2-attn', 'bp-dash-grid#']);
    var ids = Array.prototype.map.call(sec.querySelectorAll('.bp-dash-grid > div'), function (x) { return x.id; });
    expect(ids).toEqual(['bp-dash-v2-today-tasks', 'bp-dash-v2-rtb', 'bp-dash-v2-packcal']);
  });
});

describe('chip row', function () {
  test('order, labels, counts and tones', async function () {
    mount(fullFixture());
    await renderV2('');
    var row = slot().querySelector('div.bp-attn');
    expect(row.getAttribute('role')).toBe('group');
    expect(row.getAttribute('aria-label')).toBe('Needs attention');
    expect(keys()).toEqual(['overdue', 'today', 'past-schedule', 'invite', 'waitlist']);
    expect(chips().map(function (c) { return c.querySelector('.bp-attn-label').textContent; }))
      .toEqual(['Overdue', 'Due today', 'Past schedule', 'Invite not sent', 'Waitlist waiting']);
    expect(chips().map(function (c) { return c.querySelector('.bp-attn-count').textContent; }))
      .toEqual(['(2)', '(1)', '(1)', '(1)', '(3)']);
    var cls = chips().map(function (c) { return c.classList.contains('bp-attn-chip--danger') ? 'danger' : (c.classList.contains('bp-attn-chip--warn') ? 'warn' : ''); });
    expect(cls).toEqual(['danger', '', 'warn', '', '']);
  });

  test('zero counts hide their chips', async function () {
    var f = fullFixture();
    f.tasks = [task('W1', 'c', d(0))];
    f.summary = { readyToBottle: [] };
    mount(f);
    waitlistImpl = function () { return resp({ ok: true, data: [] }); };
    await renderV2('');
    expect(keys()).toEqual(['today', 'past-schedule']);
  });

  test('staff batch past schedule counts; staff RTB batch is not in the invite count', async function () {
    var f = fullFixture();
    f.extra.staffBatchIds = ['P1', 'R1'];
    mount(f);
    await renderV2('');
    expect(count('past-schedule')).toBe('(1)');
    expect(keys()).not.toContain('invite');
  });

  test('global filter state does not change the counts', async function () {
    mount(fullFixture());
    await renderV2('');
    var base = slot().innerHTML;
    window.history.replaceState(null, '', '/brewpad.html?dash=v2#type=wine&period=ytd&staff=1');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flushN();
    expect(slot().innerHTML).toBe(base);
  });

  test('hostile text never becomes an element', async function () {
    mount(fullFixture());
    await renderV2('');
    expect(slot().querySelectorAll('img, script').length).toBe(0);
    expect(slot().querySelectorAll('[style]').length).toBe(0);
  });
});

describe('all-clear and unavailable safety', function () {
  function clearFixture() {
    return { tasks: [], summary: { readyToBottle: [] } };
  }

  test('all zero and settled: grey all-clear line, no chip row', async function () {
    mount(clearFixture());
    waitlistImpl = function () { return resp({ ok: true, data: [] }); };
    await renderV2('');
    var p = slot().querySelector('p.bp-attn-empty');
    expect(p.textContent).toBe('Nothing needs attention right now.');
    expect(slot().querySelector('.bp-attn')).toBeNull();
  });

  test('waitlist pending: no all-clear line', async function () {
    mount(clearFixture());
    waitlistImpl = function () { return new Promise(function () {}); };
    await renderV2('');
    expect(slot().querySelector('.bp-attn-empty')).toBeNull();
    expect(slot().innerHTML).toBe('');
  });

  test('waitlist failed: no waitlist chip and still no all-clear line', async function () {
    mount(clearFixture());
    waitlistImpl = failedResp;
    await renderV2('');
    expect(bp.getStateForTest()._dashWaitlist.state).toBe('failed');
    expect(slot().querySelector('.bp-attn-empty')).toBeNull();
    expect(slot().innerHTML).toBe('');
  });

  test('no source at all: Not available line, no widget shell', async function () {
    mount({ noDash: true, loaded: false });
    waitlistImpl = failedResp;
    await renderV2('');
    var p = slot().querySelector("p.bp-empty");
    expect(p && p.textContent).toBe(UNAVAILABLE);
    expect(slot().querySelector('.bp-widget')).toBeNull();
  });

  test('dashboard data without inviteSentIds: no invite chip and no crash', async function () {
    var f = fullFixture();
    mount(f);
    var st = bp.getStateForTest();
    var data = Object.assign({}, st._dashData);
    delete data.inviteSentIds;
    bp._setStateForTest({ _dashData: data });
    await renderV2('');
    expect(keys()).not.toContain('invite');
    expect(keys()).toContain('overdue');
  });
});

describe('waitlist fetch', function () {
  test('requested once per dashboard load, again for a new load', async function () {
    mount(fullFixture());
    await renderV2('');
    bp._renderDashboardForTest();
    await flushN();
    bp._renderDashboardForTest();
    await flushN();
    expect(waitlistCalls()).toBe(1);
    bp._setStateForTest({ _dashLoadTime: 2 });
    bp._renderDashboardForTest();
    await flushN();
    expect(waitlistCalls()).toBe(2);
  });

  test('only the integer count is kept in dashboard state', async function () {
    mount(fullFixture());
    await renderV2('');
    var wl = bp.getStateForTest()._dashWaitlist;
    expect(wl.count).toBe(3);
    expect(wl.state).toBe('ok');
    expect(JSON.stringify(wl)).not.toContain('@');
  });
});

describe('invite sent override', function () {
  function twoInvites() {
    var f = fullFixture();
    f.summary = { readyToBottle: [rtb('R1'), rtb('R2')] };
    f.tasks = [];
    return f;
  }

  test('dashboard Send Invite success decrements without a stats refetch', async function () {
    mount(twoInvites());
    bp._initDelegationForTest();
    await renderV2('');
    expect(count('invite')).toBe('(2)');
    var before = requests.filter(function (r) { return r.action === 'get_dashboard_stats'; }).length;
    document.querySelector('#bp-dash-v2-rtb .bp-rtb-invite-btn').click();
    document.getElementById('bp-confirm-sheet-ok').click();
    await flushN(8);
    expect(count('invite')).toBe('(1)');
    expect(requests.filter(function (r) { return r.action === 'get_dashboard_stats'; }).length).toBe(before);
  });

  test('failed send leaves the count unchanged', async function () {
    mount(twoInvites());
    bp._initDelegationForTest();
    await renderV2('');
    var orig = global.fetch;
    global.fetch = jest.fn(function (url, init) {
      if (/bottling-invite/.test(String(url))) return Promise.reject(new Error('boom'));
      return orig(url, init);
    });
    document.querySelector('#bp-dash-v2-rtb .bp-rtb-invite-btn').click();
    document.getElementById('bp-confirm-sheet-ok').click();
    await flushN(8);
    expect(count('invite')).toBe('(2)');
  });

  test('detail-pane Send Invite success decrements the count', async function () {
    mount(twoInvites());
    await renderV2('');
    expect(count('invite')).toBe('(2)');
    bp._renderBatchDetailForTest({ batch: { batch_id: 'R1', status: 'primary', product_name: 'P', customer_name: 'C', customer_email: 'c@example.ca' }, tasks: [], plato_readings: [] });
    document.getElementById('bp-bottling-invite-btn').click();
    document.getElementById('bp-confirm-sheet-ok').click();
    await flushN(8);
    expect(count('invite')).toBe('(1)');
  });
});

describe('task tick refresh', function () {
  test('completing an overdue task and re-rendering decrements Overdue, then removes the chip', async function () {
    var f = fullFixture();
    f.tasks = [task('W1', 'a', d(-2)), task('W1', 'b', d(-1))];
    mount(f);
    await renderV2('');
    expect(count('overdue')).toBe('(2)');
    // Same state change the tick handler makes after a successful save, followed by loadDashboard's re-render.
    f.tasks[0].completed = 'TRUE';
    bp._setStateForTest({ _upcomingTasks: f.tasks });
    bp._renderDashboardForTest();
    await flushN();
    expect(count('overdue')).toBe('(1)');
    f.tasks[1].completed = 'TRUE';
    bp._setStateForTest({ _upcomingTasks: f.tasks });
    bp._renderDashboardForTest();
    await flushN();
    expect(keys()).not.toContain('overdue');
  });
});

describe('chip CSS', function () {
  var css = fs.readFileSync(path.join(__dirname, '../../css/brewpad.css'), 'utf8');
  function rule(sel) {
    var i = css.indexOf(sel + ' {');
    expect(i).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf('}', i) + 1);
  }

  test('chip is a 44px touch target; row wraps', function () {
    expect(rule('.bp-attn-chip')).toContain('min-height: 44px');
    expect(rule('.bp-attn')).toContain('flex-wrap: wrap');
  });

  test('warn uses amber tokens with ink text; danger uses danger tokens', function () {
    var w = rule('.bp-attn-chip--warn');
    expect(w).toContain('var(--batch-warning)');
    expect(w).toContain('var(--batch-warning-bg)');
    expect(w).toContain('color: var(--ink-primary)');
    var dg = rule('.bp-attn-chip--danger');
    expect(dg).toContain('var(--batch-danger)');
    expect(dg).toContain('var(--batch-danger-bg)');
  });

  test('no hex literal in any .bp-attn rule', function () {
    var re = /\.bp-attn[^{]*\{[^}]*\}/g;
    var m = css.match(re) || [];
    expect(m.length).toBeGreaterThan(5);
    m.forEach(function (r) { expect(/#[0-9a-fA-F]{3,6}\b/.test(r)).toBe(false); });
  });
});

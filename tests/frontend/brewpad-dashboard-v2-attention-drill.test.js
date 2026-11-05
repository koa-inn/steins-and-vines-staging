'use strict';

// Phase 98-05: Needs attention tap-throughs and past-plan drill note.

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
function chip(key) { return slot().querySelector('[data-attn="' + key + '"]'); }
function rtb(id, extra) { return Object.assign({ batch_id: id, product_name: 'P' + id, customer_name: 'C' + id, has_email: true, bottling_due: d(1) }, extra || {}); }
function click(key) { chip(key).click(); }
function panelShown(name) { var p = document.getElementById('bp-panel-' + name); return !!p && p.style.display !== 'none'; }
function cardIds() {
  return Array.prototype.map.call(document.querySelectorAll('#bp-batch-results .bp-batch-card, #bp-batch-results tr[data-batch-id]'), function (c) { return c.getAttribute('data-batch-id'); });
}
function banner() { var b = document.querySelector('.bp-drill-banner'); return b ? b.textContent.replace('✕', '') : null; }

function mountFull(o) {
  var opts = o || {};
  document.body.innerHTML =
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches" style="display:none"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-panel-tasks" style="display:none"><div id="bp-tasks-inner"></div></div>' +
    '<div id="bp-panel-waitlist" style="display:none"></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var list = opts.batches;
  bp._setStateForTest({
    _allBatchesData: list,
    _batchesData: list,
    _dashData: { asOf: ASOF, batches: list, staffBatchIds: opts.staff || [], batchMeta: opts.meta || [], inviteSentIds: opts.sent || [] },
    _dashSummary: { readyToBottle: opts.rtb || [] },
    _dashWineSkuLookup: {},
    _dashLoadTime: Date.now(),
    _dashWaitlist: { tok: null, loadTime: null, state: 'loading', count: 0 },
    _dashInviteSent: {},
    _taskFilter: 'incomplete',
    _taskSearch: 'xyz'
  });
  bp._setStateForTest({ _upcomingTasks: opts.tasks || [], _upcomingLoaded: true });
}

function setup(o) {
  mountFull(o);
  bp._initDelegationForTest();
}

beforeEach(function () {
  window.localStorage.clear();
  window.Chart = function () {};
  waitlistImpl = function () { return resp({ ok: true, data: wlRows(3) }); };
  installFetch();
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});

function pastBatches() {
  return [
    lean('A1', 'beer', { start_date: d(-25) }),
    lean('B1', 'beer', { start_date: d(-50) }),
    lean('C1', 'beer', { start_date: d(-35) }),
    lean('D1', 'wine', { start_date: d(-5) })
  ];
}
var PAST_META = [
  { batch_id: 'A1', planned_days: 10 }, { batch_id: 'B1', planned_days: 10 },
  { batch_id: 'C1', planned_days: 15 }, { batch_id: 'D1', planned_days: 10 }
];

describe('task chips', function () {
  test('Overdue and Due today open the Tasks tab with a cleared search and matching row count', async function () {
    var tasks = [task('W1', 'a', d(-2)), task('W1', 'b', d(-1)), task('W1', 'c', d(0)), task('W1', 'e', d(5))];
    setup({ batches: [lean('W1', 'wine')], tasks: tasks });
    // The tab's background refresh must return the same tasks, or the chip would drop to zero.
    var base = global.fetch;
    global.fetch = jest.fn(function (url, init) {
      var b = {};
      try { b = JSON.parse((init && init.body) || '{}'); } catch (e) { b = {}; }
      if (b.action === 'get_tasks_upcoming') return resp({ ok: true, data: { tasks: tasks } });
      return base(url, init);
    });
    await renderV2('');
    var n = Number(chip('overdue').querySelector('.bp-attn-count').textContent.replace(/[()]/g, ''));
    click('overdue');
    var st = bp.getStateForTest();
    expect(st._taskFilter).toBe('overdue');
    expect(panelShown('tasks')).toBe(true);
    expect(document.querySelector('#bp-task-search').value).toBe('');
    expect(document.querySelector('.bp-filter-btn--active').textContent).toBe('Overdue');
    expect(document.querySelectorAll('#bp-tasks-inner .bp-task-row').length).toBe(n);
    expect(n).toBe(2);

    await renderV2('');
    var m = Number(chip('today').querySelector('.bp-attn-count').textContent.replace(/[()]/g, ''));
    click('today');
    expect(bp.getStateForTest()._taskFilter).toBe('duetoday');
    expect(document.querySelector('.bp-filter-btn--active').textContent).toBe('Due today');
    expect(document.querySelectorAll('#bp-tasks-inner .bp-task-row').length).toBe(m);
    expect(m).toBe(1);
  });
});

describe('past schedule drill', function () {
  test('banner, count, order and notes', async function () {
    setup({ batches: pastBatches(), meta: PAST_META });
    await renderV2('');
    click('past-schedule');
    expect(panelShown('batches')).toBe(true);
    expect(bp.getStateForTest()._dashDrill.count).toBe(3);
    expect(banner()).toBe('Showing 3 batches past schedule.');
    expect(cardIds()).toEqual(['B1', 'C1', 'A1']);
    var notes = Array.prototype.map.call(document.querySelectorAll('.bp-batch-card .bp-past-plan'), function (n) { return n.textContent; });
    expect(notes).toEqual(['40 days past plan', '20 days past plan', '15 days past plan']);
  });

  test('singular banner opens the list, not the detail pane', async function () {
    var b = [lean('A1', 'beer', { start_date: d(-25) }), lean('D1', 'wine', { start_date: d(-5) })];
    setup({ batches: b, meta: PAST_META });
    await renderV2('');
    click('past-schedule');
    expect(banner()).toBe('Showing 1 batch past schedule.');
    expect(cardIds()).toEqual(['A1']);
    expect(bp.getStateForTest()._selectedBatchId).toBeFalsy();
    expect(document.querySelector('.bp-past-plan').textContent).toBe('15 days past plan');
  });

  test('table view keeps the order and shows the notes', async function () {
    setup({ batches: pastBatches(), meta: PAST_META });
    await renderV2('');
    var viewBtn = null;
    click('past-schedule');
    viewBtn = document.getElementById('bp-batch-view-toggle');
    viewBtn.click();
    expect(document.querySelector('table.bp-batch-table')).not.toBeNull();
    expect(cardIds()).toEqual(['B1', 'C1', 'A1']);
    var notes = Array.prototype.map.call(document.querySelectorAll('tr[data-batch-id] .bp-past-plan'), function (n) { return n.textContent; });
    expect(notes).toEqual(['40 days past plan', '20 days past plan', '15 days past plan']);
  });

  test('dismiss returns the normal list with no notes', async function () {
    setup({ batches: pastBatches(), meta: PAST_META });
    await renderV2('');
    click('past-schedule');
    document.querySelector('[data-action="clear-dash-drill"]').click();
    expect(document.querySelector('.bp-drill-banner')).toBeNull();
    expect(document.querySelectorAll('.bp-past-plan').length).toBe(0);
  });
});

describe('invite drill', function () {
  test('plural, singular, no notes and no new button', async function () {
    var b = [lean('R1', 'wine'), lean('R2', 'wine')];
    setup({ batches: b, rtb: [rtb('R1'), rtb('R2')] });
    await renderV2('');
    click('invite');
    expect(banner()).toBe('Showing 2 ready-to-bottle batches with no invite sent.');
    expect(cardIds().sort()).toEqual(['R1', 'R2']);
    expect(document.querySelectorAll('.bp-past-plan').length).toBe(0);
    expect(document.querySelectorAll('#bp-batch-results .bp-rtb-invite-btn').length).toBe(0);

    setup({ batches: b, rtb: [rtb('R1')] });
    await renderV2('');
    click('invite');
    expect(banner()).toBe('Showing 1 ready-to-bottle batch with no invite sent.');
    expect(cardIds()).toEqual(['R1']);
  });
});

describe('waitlist chip', function () {
  test('opens Waitlist filtered to Waiting with search cleared and no banner', async function () {
    setup({ batches: [lean('W1', 'wine')] });
    bp._setWaitlistStateForTest({ filter: 'all', search: 'abc' });
    await renderV2('');
    var n = Number(chip('waitlist').querySelector('.bp-attn-count').textContent.replace(/[()]/g, ''));
    click('waitlist');
    expect(panelShown('waitlist')).toBe(true);
    await flushN(6);
    expect(document.querySelector('#bp-panel-waitlist .bp-filter-btn--active').textContent).toBe('Waiting');
    expect(document.getElementById('bp-waitlist-search').value).toBe('');
    expect(document.querySelectorAll('#bp-panel-waitlist tbody tr').length).toBe(n);
    expect(document.querySelector('.bp-drill-banner')).toBeNull();
  });
});

describe('copy guard and CSS', function () {
  test('no banned words in chips, banners, notes or Tasks copy', async function () {
    var b = pastBatches().concat([lean('R1', 'wine')]);
    setup({ batches: b, meta: PAST_META, rtb: [rtb('R1')], tasks: [task('W1', 'a', d(-2)), task('W1', 'c', d(0))] });
    await renderV2('');
    var texts = [slot().textContent];
    click('past-schedule');
    texts.push(document.querySelector('.bp-drill-banner').textContent, document.getElementById('bp-batch-results').textContent);
    bp._clearDashDrillForTest();
    click('invite');
    texts.push(document.querySelector('.bp-drill-banner').textContent);
    bp._clearDashDrillForTest();
    bp._setStateForTest({ _upcomingTasks: [] });
    bp._setStateForTest({ _taskFilter: 'overdue' });
    bp._renderTasksForTest();
    texts.push(document.getElementById('bp-tasks-inner').textContent);
    bp._setStateForTest({ _taskFilter: 'duetoday' });
    bp._renderTasksForTest();
    texts.push(document.getElementById('bp-tasks-inner').textContent);
    texts.push(dashPastPlanNoteText());
    texts.forEach(function (t) { expect(/stale|conflict|unbilled|missing/i.test(t)).toBe(false); });
  });

  function dashPastPlanNoteText() { return '1 day past plan 12 days past plan'; }

  test('.bp-past-plan uses an amber border with secondary ink and no hex', function () {
    var css = fs.readFileSync(path.join(__dirname, '../../css/brewpad.css'), 'utf8');
    var i = css.indexOf('.bp-past-plan {');
    expect(i).toBeGreaterThan(-1);
    var r = css.slice(i, css.indexOf('}', i) + 1);
    expect(r).toContain('border-left: 3px solid var(--batch-warning)');
    expect(r).toContain('color: var(--ink-secondary)');
    expect(/#[0-9a-fA-F]{3,6}\b/.test(r)).toBe(false);
  });
});

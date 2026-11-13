'use strict';

// Phase 94-07: rendered-dashboard regression tests. B1: the cycle-time tile used
// "now minus start" for completed batches (a wall-clock drift that showed ~264 days).
// The tile must now be the median completed span, independent of the current time.

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};
var _ssData = {};
global.sessionStorage = {
  getItem: function (k) { return _ssData[k] !== undefined ? _ssData[k] : null; },
  setItem: function (k, v) { _ssData[k] = v; },
  removeItem: function (k) { delete _ssData[k]; },
  clear: function () { Object.keys(_ssData).forEach(function (k) { delete _ssData[k]; }); }
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

var ASOF = { today: '2026-10-23', year: 2026, tz: 'America/Vancouver' };

function plusDays(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n, 20, 0, 0));
  return d.toISOString();
}

// Raw get_batches style rows (fallback path).
function rawBatch(id, status, type, start, spanDays, extra) {
  var b = {
    batch_id: id,
    status: status,
    batch_type: type,
    start_date: start,
    completed_at: spanDays === null || spanDays === undefined ? '' : plusDays(start, spanDays)
  };
  var k;
  for (k in (extra || {})) { if (Object.prototype.hasOwnProperty.call(extra, k)) b[k] = extra[k]; }
  return b;
}

function baseRaw() {
  return [
    rawBatch('C1', 'complete', 'wine', '2026-02-01', 40),
    rawBatch('C2', 'complete', 'wine', '2026-02-01', 60),
    rawBatch('C3', 'complete', 'beer', '2026-02-01', 64),
    rawBatch('C4', 'complete', 'wine', '2026-02-01', 70),
    rawBatch('C5', 'complete', 'wine', '2026-02-01', null),
    rawBatch('P1', 'primary', 'wine', '2026-03-01', null),
    rawBatch('P2', 'secondary', 'cider', '2026-04-01', null),
    rawBatch('N1', 'pending', 'wine', null, null)
  ];
}

function setup(rawBatches, data) {
  // Phase 99-09: v2 is the default, so these v1 render tests choose Classic explicitly.
  global.localStorage.setItem('bp_dash_v2', '0');
  global.localStorage.setItem('bp_dash_default_v2', '1');
  bp._initDashV2FlagForTest();
  document.body.innerHTML = '<div id="bp-dashboard-inner"></div>';
  bp._setStateForTest({ _allBatchesData: rawBatches, _dashData: data || null, _dashSummary: {}, _dashWineSkuLookup: {} });
}

function leanFromRaw(raw) {
  // Lean rows as the aggregate returns them.
  return raw.map(function (b) {
    return {
      batch_id: b.batch_id,
      status: b.status,
      batch_type: b.batch_type,
      batch_type_source: null,
      start_date: b.start_date,
      completed_day: b.completed_at ? new Date(b.completed_at).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : null,
      completed_at: b.completed_at || null,
      product_sku: b.product_sku || '',
      product_name: b.product_name || '',
      product_subcategory: b.product_subcategory || '',
      product_brand: '',
      product_manufacturer: ''
    };
  });
}

function html() { return document.getElementById('bp-dashboard-inner').innerHTML; }
function text() { return document.getElementById('bp-dashboard-inner').textContent; }
function tile() { return document.querySelector('.bp-stat-card--wide'); }

afterEach(function () {
  jest.useRealTimers();
});

describe('cycle-time tile (B1 regression)', function () {
  test('fallback path (get_batches rows): median of completed spans, not now-minus-start', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var t = tile();
    expect(t).not.toBeNull();
    expect(t.textContent).toContain('Days to complete (median)');
    expect(t.querySelector('.bp-stat-num').textContent).toBe('62');
    expect(t.textContent).toContain('mean 59d');
    expect(t.textContent).toContain('Based on 4 batches, 1 excluded (no completion date)');
    expect(text()).not.toContain('Avg days to complete');
  });

  test('aggregate path: identical numbers months later (no clock drift)', function () {
    var raw = baseRaw();
    var data = { asOf: ASOF, batches: leanFromRaw(raw), summary: {} };
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup([], data);
    bp._renderDashboardForTest();
    var first = tile().textContent;
    jest.setSystemTime(new Date('2027-03-01T18:00:00Z'));
    setup([], data);
    bp._renderDashboardForTest();
    expect(tile().textContent).toBe(first);
    expect(tile().querySelector('.bp-stat-num').textContent).toBe('62');
    expect(first).toContain('mean 59d');
    expect(first).toContain('Based on 4 batches, 1 excluded (no completion date)');
  });

  test('tile semantics: role group, aria-label, classes', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var t = tile();
    expect(t.getAttribute('role')).toBe('group');
    expect(t.getAttribute('aria-label')).toBe('Days to complete');
    expect(t.className).toContain('bp-stat-card');
  });

  test('excluded clause omitted when none are excluded; warn span when some are', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    var raw = baseRaw().filter(function (b) { return b.batch_id !== 'C5'; });
    setup(raw, null);
    bp._renderDashboardForTest();
    expect(tile().textContent).toContain('Based on 4 batches');
    expect(tile().textContent).not.toContain('excluded');
    expect(tile().querySelector('.bp-stat-warn')).toBeNull();

    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var warn = tile().querySelector('.bp-stat-warn');
    expect(warn).not.toBeNull();
    expect(warn.textContent).toContain('1 excluded (no completion date)');
  });

  test('empty state when no completed batch has a completion date', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    var raw = [rawBatch('A', 'primary', 'wine', '2026-03-01', null), rawBatch('B', 'complete', 'wine', '2026-03-02', null)];
    setup(raw, null);
    bp._renderDashboardForTest();
    var t = tile();
    expect(t.querySelector('.bp-stat-num').textContent).toBe('—');
    expect(t.textContent).toContain('No completed batches with a completion date yet');
    expect(t.textContent).not.toContain('mean');
    expect(t.querySelector('.bp-stat-types')).toBeNull();
  });

  test('type row lists only types with data in wine, beer, cider, seltzer, other order', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var row = tile().querySelector('.bp-stat-types');
    expect(row).not.toBeNull();
    // wine spans 40,60,70 -> median 60 ; beer 64
    expect(row.textContent.replace(/\s+/g, ' ')).toBe('Wine 60d · Beer 64d');
    expect(row.querySelector('strong').textContent).toBe('Wine');
  });
});

describe('year-to-date tiles and caption', function () {
  test('fermenting now = primary + secondary; started/completed use the ytd window; caption and titles', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var cards = document.querySelectorAll('.bp-stat-card');
    expect(cards[0].textContent).toContain('2');
    expect(cards[0].textContent).toContain('Fermenting now');
    // started: 5 complete + 2 active (pending excluded) = 7
    expect(cards[1].querySelector('.bp-stat-num').textContent).toBe('7');
    // completed in ytd by completion day: 4 with a completion date
    expect(cards[2].querySelector('.bp-stat-num').textContent).toBe('4');
    expect(cards[1].getAttribute('title')).toBe('Calendar year to date (2026), Vancouver time');
    expect(cards[2].getAttribute('title')).toBe('Calendar year to date (2026), Vancouver time');
    expect(text()).toContain('This year = Jan 1 to today');
  });
});

describe('shared data layer agreement (T-94-30)', function () {
  test('month chart legend and bars sum to getDashboardData monthBuckets; chart says started only', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    setup(baseRaw(), null);
    bp._renderDashboardForTest();
    var rows = bp.toDashRows(baseRaw());
    var dd = bp.getDashboardData(rows, ASOF, {});
    var expectTotal = 0;
    dd.monthBuckets.forEach(function (m) { expectTotal += m.total; });
    var legend = document.querySelectorAll('[data-bp-chart-type]');
    var legendSum = 0;
    Array.prototype.forEach.call(legend, function (el) {
      var m = /\((\d+)\)\s*$/.exec(el.textContent);
      legendSum += parseInt(m[1], 10);
    });
    expect(legendSum).toBe(expectTotal);
    expect(text()).toContain('Started batches only');
  });

  test('wine breakdown total equals the data layer wine total for the period', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    var raw = baseRaw();
    raw.push(rawBatch('W1', 'primary', 'wine', '2026-09-01', null, { product_sku: 'S1' }));
    raw.push(rawBatch('W2', 'complete', 'wine', '2026-08-01', 20, { product_sku: 'S1' }));
    raw.push(rawBatch('W3', 'primary', 'wine', '2026-09-10', null, { product_sku: 'NOPE' }));
    document.body.innerHTML = '<div id="bp-dashboard-inner"></div>';
    bp._setStateForTest({
      _allBatchesData: raw, _dashData: null, _dashSummary: {},
      _dashWineSkuLookup: { S1: { sku: 'S1', subcategory: 'Red' } }
    });
    bp._renderDashboardForTest();
    var want = bp.getDashboardData(bp.toDashRows(raw), ASOF, { window: '6mo', type: 'wine' }).totals.all;
    expect(want).toBeGreaterThan(0);
    expect(text()).toContain('Total: ' + want + ' wine batch');
  });
});

describe('XSS (T-94-29)', function () {
  test('a script tag in a product name never reaches the DOM as markup', function () {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-23T18:00:00Z'));
    var raw = baseRaw();
    raw.push(rawBatch('X1', 'primary', 'wine', '2026-09-01', null, {
      product_sku: 'SX', product_name: '<script>alert(1)</script>'
    }));
    document.body.innerHTML = '<div id="bp-dashboard-inner"></div>';
    bp._setStateForTest({
      _allBatchesData: raw, _dashData: null, _dashSummary: {},
      _dashWineSkuLookup: { SX: { sku: 'SX', subcategory: '<script>alert(2)</script>' } }
    });
    bp._renderDashboardForTest();
    expect(document.querySelector('#bp-dashboard-inner script')).toBeNull();
    expect(html()).toContain('&lt;script&gt;alert(2)');
  });
});

describe('dashboard load via get_dashboard_stats (S1, D-21)', function () {
  function mockFetch(handlers) {
    var calls = [];
    global.fetch = jest.fn(function (url, opts) {
      var body = {};
      try { body = JSON.parse(opts && opts.body); } catch (e) { body = {}; }
      calls.push(body.action);
      var h = handlers[body.action];
      var res = h ? h(body) : { ok: true, data: {} };
      return Promise.resolve({
        ok: res.ok !== false, status: res.ok === false ? 400 : 200,
        json: function () { return Promise.resolve(res); }
      });
    });
    return calls;
  }

  var STATS = {
    ok: true,
    data: {
      asOf: ASOF,
      batches: leanFromRaw(baseRaw()),
      tasks: [],
      latestReadings: [],
      summary: { primaryCount: 1, secondaryCount: 1, completeCount: 5 }
    }
  };

  beforeEach(function () {
    document.body.innerHTML = '<div id="bp-dashboard-inner"></div>';
    bp._setStateForTest({ _allBatchesData: [], _dashData: null, _dashSummary: null, _dashWineSkuLookup: {} });
  });

  test('aggregate ok: exactly one get_dashboard_stats, no summary read, no per-batch get_batch', function () {
    var calls = mockFetch({
      get_dashboard_stats: function () { return STATS; },
      get_tasks_upcoming: function () { return { ok: true, data: { tasks: [] } }; }
    });
    return bp._loadDashboardForTest().then(function () {
      expect(calls.filter(function (a) { return a === 'get_dashboard_stats'; }).length).toBe(1);
      expect(calls).not.toContain('get_batch_dashboard_summary');
      expect(calls).not.toContain('get_batch');
      var st = bp.getStateForTest();
      expect(st._dashData.batches.length).toBe(8);
      expect(st._dashSummary).toEqual(STATS.data.summary);
      expect(tile().querySelector('.bp-stat-num').textContent).toBe('62');
    });
  });

  test('invalid_action falls back to the summary; _dashData stays null; tile from get_batches rows', function () {
    var calls = mockFetch({
      get_dashboard_stats: function () { return { ok: false, error: 'invalid_action' }; },
      get_batch_dashboard_summary: function () { return { ok: true, data: { primaryCount: 2 } }; },
      get_tasks_upcoming: function () { return { ok: true, data: { tasks: [] } }; }
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }).setSystemTime(new Date('2026-10-23T18:00:00Z'));
    bp._setStateForTest({ _allBatchesData: baseRaw() });
    return bp._loadDashboardForTest().then(function () {
      expect(calls).toContain('get_batch_dashboard_summary');
      var st = bp.getStateForTest();
      expect(st._dashData).toBeNull();
      expect(st._dashSummary).toEqual({ primaryCount: 2 });
      expect(tile().querySelector('.bp-stat-num').textContent).toBe('62');
    });
  });

  test('both failing shows the UI-SPEC error copy', function () {
    mockFetch({
      get_dashboard_stats: function () { return { ok: false, error: 'invalid_action' }; },
      get_batch_dashboard_summary: function () { return { ok: false, error: 'boom' }; },
      get_tasks_upcoming: function () { return { ok: true, data: { tasks: [] } }; }
    });
    return bp._loadDashboardForTest().then(function () {
      expect(html()).toContain('<p class="bp-empty">Failed to load dashboard: boom. Reopen the Dashboard tab to try again.</p>');
    });
  });

  test('eagerLoad reads get_dashboard_stats instead of the summary and keeps the other reads', function () {
    var calls = mockFetch({
      get_dashboard_stats: function () { return STATS; },
      get_batches: function () { return { ok: true, data: { batches: [] } }; }
    });
    bp._eagerLoadForTest();
    return new Promise(function (resolve) { setTimeout(resolve, 50); }).then(function () {
      expect(calls).toContain('get_dashboard_stats');
      expect(calls).not.toContain('get_batch_dashboard_summary');
      ['get_batches', 'get_vessels', 'get_ferm_schedules', 'get_tasks_upcoming'].forEach(function (a) {
        expect(calls).toContain(a);
      });
      expect(bp.getStateForTest()._dashData).not.toBeNull();
    });
  });

  test('eagerLoad falls back to the summary when the aggregate is unavailable (sheets mode)', function () {
    var calls = mockFetch({
      get_dashboard_stats: function () { return { ok: false, error: 'invalid_action' }; },
      get_batch_dashboard_summary: function () { return { ok: true, data: { primaryCount: 3 } }; },
      get_batches: function () { return { ok: true, data: { batches: [] } }; }
    });
    bp._eagerLoadForTest();
    return new Promise(function (resolve) { setTimeout(resolve, 50); }).then(function () {
      expect(calls).toContain('get_batch_dashboard_summary');
      var st = bp.getStateForTest();
      expect(st._dashData).toBeNull();
      expect(st._dashSummary).toEqual({ primaryCount: 3 });
    });
  });
});

'use strict';

// Phase 96-04: v2 production section, widget framework and G1 Production over time.

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

function lean(id, type, start, extra) {
  return Object.assign({
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: start, completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  }, extra || {});
}

function rows() {
  return [
    lean('W1', 'wine', YEAR + '-01-05', { product_sku: 'S1', product_subcategory: 'Red' }),
    lean('W2', 'wine', YEAR + '-01-20', { product_sku: 'S2', product_subcategory: 'White', status: 'complete', completed_day: YEAR + '-02-10', completed_at: YEAR + '-02-10T10:00:00Z' }),
    lean('W3', 'wine', YEAR + '-01-25', { product_sku: 'S1', product_subcategory: 'Red', staff_batch: true }),
    lean('B1', 'beer', YEAR + '-01-10', { source: 'manual' }),
    lean('C1', 'cider', YEAR + '-02-03'),
    lean('S1', 'seltzer', YEAR + '-02-04'),
    lean('P1', 'wine', (YEAR - 1) + '-01-10', { product_sku: 'S1', product_subcategory: 'Red' })
  ];
}

function makeFakeChart() {
  function FakeChart(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.destroyed = false;
    this.resizes = 0;
    FakeChart.instances.push(this);
  }
  FakeChart.instances = [];
  FakeChart.prototype.destroy = function () { this.destroyed = true; };
  FakeChart.prototype.resize = function () { this.resizes++; };
  FakeChart.prototype.getElementsAtEventForMode = function () { return []; };
  FakeChart.getChart = function (canvas) {
    for (var i = FakeChart.instances.length - 1; i >= 0; i--) {
      if (FakeChart.instances[i].canvas === canvas && !FakeChart.instances[i].destroyed) return FakeChart.instances[i];
    }
    return null;
  };
  FakeChart.defaults = { font: {} };
  return FakeChart;
}

var Fake;

function live(canvasEl) {
  return Fake.instances.filter(function (i) { return !i.destroyed && (!canvasEl || i.canvas === canvasEl); });
}

function periodChart() {
  var c = document.querySelector('#bp-dash-v2-period canvas');
  return c ? Fake.getChart(c) : null;
}

function wineChart() {
  var c = document.querySelector('#bp-dash-v2-wine canvas');
  return c ? Fake.getChart(c) : null;
}

function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }

function setUrl(hash) {
  window.history.replaceState(null, '', '/brewpad.html?dash=v2' + (hash || ''));
}

async function go(hash) {
  setUrl(hash ? '#' + hash : '');
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await flush();
}

function mount(opts) {
  var o = opts || {};
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var list = rows();
  bp._setStateForTest({
    _allBatchesData: list,
    _dashData: Object.assign({ asOf: ASOF, batches: list, staffBatchIds: o.staffIds || [] }, o.extra || {}),
    _dashSummary: {},
    _dashWineSkuLookup: o.lookup === undefined ? {} : o.lookup
  });
}

async function renderV2(hash) {
  setUrl(hash ? '#' + hash : '');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flush();
}

function model() { return bp.getStateForTest()._dashV2Model; }
function tile(which) { return document.querySelector('[data-dash-drill="' + which + '"]'); }
function drill() { return bp.getStateForTest()._dashDrill; }

beforeEach(function () {
  window.localStorage.clear();
  bp._resetChartJsForTest();
  Fake = makeFakeChart();
  window.Chart = Fake;
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  mount();
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});


describe('completedBuckets', function () {
  function data(group, win) {
    var list = rows();
    // reopened batch with a stale completed_day must never count
    list.push(lean('R1', 'wine', YEAR + '-01-02', { status: 'primary', completed_day: YEAR + '-02-11' }));
    return bp.getDashboardData(list, ASOF, { window: win, group: group, staffIds: {} });
  }
  ['ytd', '90d', 'all'].forEach(function (win) {
    ['month', 'week'].forEach(function (group) {
      test('sums agree with the Completed tile: ' + win + '/' + group, function () {
        var d = data(group, win);
        var cb = d.completedBuckets;
        expect(sum(cb.map(function (b) { return b.total; }))).toBe(d.completed);
        ['wine', 'cider', 'beer', 'seltzer', 'other'].forEach(function (t) {
          expect(sum(cb.map(function (b) { return b.counts[t]; }))).toBe(d.completedTotals.byType[t]);
        });
      });
    });
  });

  test('keys, litres and shape follow periodBuckets', function () {
    var d = data('month', 'ytd');
    var b = d.completedBuckets.filter(function (x) { return x.total > 0; })[0];
    expect(b.key).toBe(YEAR + '-02');
    expect(b.ids.wine).toEqual(['W2']);
    expect(b.all).toEqual(['W2']);
    expect(b.litres.wine).toBe(20);
    expect(b.totalLitres).toBe(20);
    expect(Object.keys(b).sort()).toEqual(Object.keys(d.periodBuckets[0]).sort());
  });

  test('week buckets are keyed on Monday', function () {
    var d = data('week', 'all');
    var b = d.completedBuckets.filter(function (x) { return x.total > 0; })[0];
    expect(new Date(b.key + 'T00:00:00Z').getUTCDay()).toBe(1);
  });

  test('no completed rows gives []; no group gives []', function () {
    var list = [lean('A', 'wine', YEAR + '-01-05')];
    expect(bp.getDashboardData(list, ASOF, { window: 'all', group: 'month' }).completedBuckets).toEqual([]);
    expect(bp.getDashboardData(rows(), ASOF, { window: 'ytd' }).completedBuckets).toEqual([]);
  });

  test('periodBuckets still sum to the Started tile', function () {
    var d = data('month', 'ytd');
    expect(sum(d.periodBuckets.map(function (b) { return b.total; }))).toBe(d.started);
  });
});

describe('section shell', function () {
  test('six headed sections in order with hints and slots', async function () {
    await renderV2('');
    var shell = document.getElementById('bp-dash-v2');
    var kids = Array.prototype.map.call(shell.children, function (c) { return c.id || c.tagName; });
    expect(kids.slice(0, 3)).toEqual(['bp-dash-filters', 'bp-dash-range', 'bp-dash-v2-tiles']);
    var secs = shell.querySelectorAll('section.bp-dash-section');
    expect(Array.prototype.map.call(secs, function (s) { return s.querySelector('h2.bp-dash-section-title').textContent; }))
      .toEqual(['Today', 'Production', 'Floor today', 'Beer & cider', 'Products & sales', 'Data health']);
    expect(Array.prototype.map.call(secs, function (s) { return s.querySelector('.bp-dash-section-hint').textContent; })).toEqual([
      "Right now. The filters above don't apply.",
      'Follows the filters above',
      'Right now, mostly ignores the period filter',
      'Follows the Type and Source filters. Staff batches included.',
      'Follows the filters above; staff batches hidden by default',
      'All batches, ignores the filters'
    ]);
    function slots(i) { return Array.prototype.map.call(secs[i].querySelectorAll('.bp-dash-grid > div'), function (d) { return d.id; }); }
    expect(slots(0)).toEqual(['bp-dash-v2-today-tasks', 'bp-dash-v2-rtb', 'bp-dash-v2-packcal']);
    expect(slots(1)).toEqual(['bp-dash-v2-period', 'bp-dash-v2-pipeline', 'bp-dash-v2-cycle']);
    expect(slots(2)).toEqual(['bp-dash-v2-workload', 'bp-dash-v2-vessels', 'bp-dash-v2-tasks', 'bp-dash-v2-ferment']);
    expect(slots(3)).toEqual(['bp-dash-v2-bc']);
    expect(slots(4)).toEqual(['bp-dash-v2-wine', 'bp-dash-v2-source']);
    expect(slots(5)).toEqual(['bp-dash-v2-health']);
    ['packcal', 'period', 'tasks', 'ferment', 'bc', 'wine', 'source', 'health'].forEach(function (k) {
      expect(document.getElementById('bp-dash-v2-' + k).className).toContain('bp-dash-full');
    });
  });

  test('re-render keeps the filter bar node', async function () {
    await renderV2('');
    var node = document.getElementById('bp-dash-filters');
    await go('type=wine');
    expect(document.getElementById('bp-dash-filters')).toBe(node);
  });

  test('widget scaffold: head, titles, controls, note, body', async function () {
    await renderV2('');
    var w = document.querySelector('#bp-dash-v2-period .bp-widget');
    expect(w.querySelector('.bp-widget-head .bp-widget-titles h3.bp-widget-title')).not.toBeNull();
    expect(w.querySelector('.bp-widget-titles p.bp-widget-sub')).not.toBeNull();
    expect(w.querySelector('.bp-widget-head .bp-widget-controls')).not.toBeNull();
    expect(w.querySelector('.bp-widget-note').hidden).toBe(true);
    expect(w.querySelector('.bp-widget-body')).not.toBeNull();
  });
});

describe('widget framework', function () {
  var F;
  var calls;
  var added;

  function addWidget(extra) {
    var def = Object.assign({
      key: 'tw', slot: 'bp-dash-v2-health', title: 'Test widget', needs: [],
      render: function () {
        calls.push('render');
        F.scaffold('bp-dash-v2-health', 'Test widget');
        var mode = F.opt('tw', 'mode', 'a');
        var view = F.opt('tw', 'view', 'chart');
        F.setControls('bp-dash-v2-health',
          bp.dashSegHtml('tw', 'mode', [['a', 'A'], ['b', 'B'], ['c', 'C']], mode, 'Mode') +
          bp.dashSelectHtml('tw', 'pick', [['x', 'X'], ['y', 'Y']], F.opt('tw', 'pick', 'x'), 'Pick') +
          bp.dashViewToggleHtml('tw', view));
        var one = F.drillAdd('tw', ['B1'], 'Single thing', false);
        var many = F.drillAdd('tw', ['W1', 'W2'], 'Pair thing', false);
        document.querySelector('#bp-dash-v2-health .bp-widget-body').innerHTML =
          '<button type="button" data-dash-row="tw:' + one + '">one</button>' +
          '<button type="button" data-dash-row="tw:' + many + '">many</button>' +
          '<button type="button" data-dash-row="tw:99">bogus</button>' +
          '<button type="button" data-dash-row="nope:0">bogus2</button>' +
          '<span id="tw-state">' + mode + '/' + view + '</span>';
      }
    }, extra || {});
    F.widgets.push(def);
    added = def;
  }

  beforeEach(function () {
    F = bp._dashV2FrameForTest;
    calls = [];
    added = null;
    Object.keys(F.opts).forEach(function (k) { delete F.opts[k]; });
    Object.keys(F.expanded).forEach(function (k) { delete F.expanded[k]; });
  });
  afterEach(function () {
    if (added) F.widgets.splice(F.widgets.indexOf(added), 1);
  });

  function btn(attr) { return document.querySelector('[data-dash-w="' + attr + '"]'); }

  test('option click re-renders only that widget, no hash/storage/filter change, focus returns', async function () {
    addWidget();
    await renderV2('');
    var hash = window.location.hash;
    var st = JSON.stringify(bp.getStateForTest()._dashV2State);
    var periodBody = document.querySelector('#bp-dash-v2-period .bp-widget-body');
    var before = calls.length;
    var lsBefore = JSON.stringify(window.localStorage);
    btn('tw:mode:b').click();
    expect(calls.length).toBe(before + 1);
    expect(document.getElementById('tw-state').textContent).toBe('b/chart');
    expect(window.location.hash).toBe(hash);
    expect(JSON.stringify(bp.getStateForTest()._dashV2State)).toBe(st);
    expect(JSON.stringify(window.localStorage)).toBe(lsBefore);
    expect(document.querySelector('#bp-dash-v2-period .bp-widget-body')).toBe(periodBody);
    expect(document.activeElement).toBe(btn('tw:mode:b'));
    expect(btn('tw:mode:b').getAttribute('aria-checked')).toBe('true');
  });

  test('arrow keys move and select within the radiogroup', async function () {
    addWidget();
    await renderV2('');
    btn('tw:mode:a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(document.getElementById('tw-state').textContent).toBe('b/chart');
    expect(document.activeElement).toBe(btn('tw:mode:b'));
    btn('tw:mode:b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    btn('tw:mode:a').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(document.getElementById('tw-state').textContent).toBe('c/chart');
  });

  test('select change stores the option and keeps focus', async function () {
    addWidget();
    await renderV2('');
    var sel = document.querySelector('[data-dash-wsel="tw:pick"]');
    sel.value = 'y';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(F.opt('tw', 'pick', 'x')).toBe('y');
    expect(document.activeElement).toBe(document.querySelector('[data-dash-wsel="tw:pick"]'));
  });

  test('Chart/Table toggle survives a global filter change', async function () {
    addWidget();
    await renderV2('');
    btn('tw:view:table').click();
    await go('type=wine');
    expect(document.getElementById('tw-state').textContent).toBe('a/table');
  });

  test('row drills: 1 id opens the batch with no banner, 2+ open the banner, bogus ignored', async function () {
    addWidget();
    await renderV2('');
    var rows_ = document.querySelectorAll('[data-dash-row]');
    expect(document.body.innerHTML).not.toContain('"B1"');
    rows_[1].click();
    expect(drill()).not.toBeNull();
    expect(drill().label).toBe('From dashboard: Pair thing · 2 batches');
    expect(Object.keys(drill().ids)).toEqual(['W1', 'W2']);
    bp._clearDashDrillForTest();
    rows_[0].click();
    expect(drill()).toBeNull();
    expect(bp.getStateForTest()._selectedBatchId).toBe('B1');
    bp._clearDashDrillForTest();
    rows_[2].click();
    rows_[3].click();
    expect(drill()).toBeNull();
  });

  test('KPI tile click keeps the banner even for a 1-batch set', async function () {
    await renderV2('type=beer');
    expect(model().cur.ids.started.length).toBe(1);
    tile('started').click();
    expect(drill()).not.toBeNull();
    expect(drill().count).toBe(1);
  });

  test('showall toggles expanded state and aria-expanded', async function () {
    var items = [];
    for (var i = 0; i < 8; i++) items.push({ primary: 'p' + i, right: String(i) });
    addWidget({
      render: function () {
        F.scaffold('bp-dash-v2-health', 'Test widget');
        document.querySelector('#bp-dash-v2-health .bp-widget-body').innerHTML =
          bp.dashListHtml('tw', 'l', items, { limit: 5, expanded: F.expanded['tw:l'] === true, emptyText: 'none' });
      }
    });
    await renderV2('');
    var b = document.querySelector('[data-dash-showall="tw:l"]');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    b.click();
    b = document.querySelector('[data-dash-showall="tw:l"]');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('#bp-dash-v2-health .bp-list-row').length).toBe(8);
  });

  test('missing server array shows the copy; other widgets still render', async function () {
    addWidget({ needs: ['taskRows'] });
    await renderV2('');
    expect(document.querySelector('#bp-dash-v2-health .bp-empty').textContent).toBe('Not available yet. Reopen the Dashboard tab to refresh.');
    expect(calls.length).toBe(0);
    expect(periodChart()).not.toBeNull();
    expect(document.querySelector('#bp-dash-v2-tiles .bp-stat-card')).not.toBeNull();
  });

  test('present server array renders the widget', async function () {
    mount({ extra: { taskRows: [] } });
    addWidget({ needs: ['taskRows'] });
    await renderV2('');
    expect(calls.length).toBeGreaterThan(0);
  });

  test('a throwing widget shows the failure copy and does not block others', async function () {
    addWidget({ render: function () { throw new Error('boom'); } });
    await renderV2('');
    expect(document.querySelector('#bp-dash-v2-health .bp-empty').textContent).toBe('Charts could not load. Reload the page to try again.');
    expect(periodChart()).not.toBeNull();
  });

  test('Chart.js failing to load leaves a table-style widget rendered', async function () {
    addWidget();
    delete window.Chart;
    await renderV2('');
    expect(document.getElementById('tw-state')).not.toBeNull();
    document.head.querySelector('script').onerror();
    await flush();
    expect(document.getElementById('tw-state')).not.toBeNull();
    expect(document.querySelector('#bp-dash-v2-period .bp-empty').textContent).toBe('Charts could not load. Reload the page to try again.');
  });

  test('widgets that ignore Period still render when nothing started in the window', async function () {
    addWidget();
    await renderV2('period=custom&from=' + (YEAR - 1) + '-03-01&to=' + (YEAR - 1) + '-03-02');
    expect(model().cur.started).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('G1 Production over time', function () {
  function btnW(attr) { return document.querySelector('[data-dash-w="' + attr + '"]'); }
  beforeEach(function () {
    var o = bp._dashV2FrameForTest.opts;
    Object.keys(o).forEach(function (k) { delete o[k]; });
  });
  function sumRow(cells) { return sum(cells.map(function (c) { return c.value; })); }

  test('title, default subtitle, controls', async function () {
    await renderV2('');
    var slot = document.getElementById('bp-dash-v2-period');
    expect(slot.querySelector('.bp-widget-title').textContent).toBe('Production over time');
    expect(slot.querySelector('.bp-widget-sub').textContent).toBe('Started batches · YTD · by month');
    expect(btnW('g1:mode:started').getAttribute('aria-checked')).toBe('true');
    expect(btnW('g1:mode:completed')).not.toBeNull();
    expect(btnW('g1:view:chart').getAttribute('aria-checked')).toBe('true');
    expect(slot.querySelector('canvas').getAttribute('aria-label')).toBe('Started batches by month, YTD. Wine 3, Cider 1, Beer 1, Other 1');
  });

  test('Completed mode plots completedBuckets and matches the Completed tile', async function () {
    await renderV2('');
    btnW('g1:mode:completed').click();
    var cfg = periodChart().config;
    var total = sum(cfg.data.datasets.map(function (d) { return sum(d.data); }));
    expect(total).toBe(model().cur.completed);
    expect(String(total)).toBe(tile('completed').querySelector('.bp-stat-num').textContent);
    expect(document.querySelector('#bp-dash-v2-period .bp-widget-sub').textContent).toBe('Completed batches · YTD · by month');
    expect(document.querySelector('#bp-dash-v2-period canvas').getAttribute('aria-label')).toMatch(/^Completed batches by month, YTD\./);
  });

  test('table model cells equal chart dataset values for every bucket/type (modes and measures)', function () {
    ['batches', 'litres'].forEach(function (measure) {
      ['started', 'completed'].forEach(function (mode) {
        var m = bp.buildDashV2Model(rows(), ASOF, Object.assign({}, bp.DASH_FILTER_DEFAULTS || {}, { period: 'ytd', type: 'all', source: 'all', staff: '1', group: 'month', measure: measure }), {}, {});
        var g = bp.buildG1Model(m, mode);
        var n = g.buckets.length;
        expect(g.table.rows.length).toBe(n);
        g.table.rows.forEach(function (row, ri) {
          var bi = n - 1 - ri;
          g.series.forEach(function (s, si) {
            expect(row.cells[si + 1].value).toBe(s.data[bi]);
          });
          var tc = row.cells[row.cells.length - 1];
          expect(tc.value).toBe(g.totals[bi]);
          expect(Math.round(sumRow(row.cells.slice(1, -1)) * 10) / 10).toBe(tc.value);
        });
      });
    });
  });

  test('Started totals equal the Started tile', function () {
    var m = bp.buildDashV2Model(rows(), ASOF, { period: 'ytd', type: 'all', source: 'all', staff: '1', group: 'month', measure: 'batches' }, {}, {});
    var g = bp.buildG1Model(m, 'started');
    expect(sum(g.totals)).toBe(m.cur.started);
  });

  test('table view: columns, newest first, drill cells open detail or banner', async function () {
    await renderV2('');
    btnW('g1:view:table').click();
    var slot = document.getElementById('bp-dash-v2-period');
    expect(slot.querySelector('canvas')).toBeNull();
    var heads = Array.prototype.map.call(slot.querySelectorAll('thead th'), function (h) { return h.textContent; });
    expect(heads).toEqual(['Period', 'Wine', 'Cider', 'Beer', 'Other', 'Total']);
    var firstCols = Array.prototype.map.call(slot.querySelectorAll('tbody tr'), function (tr) { return tr.querySelector('td').textContent; });
    var labels = model().cur.periodBuckets.map(function (b) { return b.label; });
    expect(firstCols).toEqual(labels.slice().reverse());
    // Jan row: Wine 3 -> banner, Beer 1 -> detail
    var janRow = Array.prototype.filter.call(slot.querySelectorAll('tbody tr'), function (tr) { return tr.querySelector('td').textContent === labels[0]; })[0];
    var cells = janRow.querySelectorAll('td');
    cells[1].querySelector('button').click();
    expect(drill().label).toBe('From dashboard: Wine started in ' + labels[0] + ' · 3 batches');
    bp._clearDashDrillForTest();
    cells[3].querySelector('button').click();
    expect(drill()).toBeNull();
    expect(bp.getStateForTest()._selectedBatchId).toBe('B1');
    // zero cells are not buttons
    expect(cells[2].querySelector('button')).toBeNull();
  });

  test('table Other column only under Type All; litres follow Measure', async function () {
    await renderV2('type=wine');
    btnW('g1:view:table').click();
    var heads = Array.prototype.map.call(document.querySelectorAll('#bp-dash-v2-period thead th'), function (h) { return h.textContent; });
    expect(heads).toEqual(['Period', 'Wine', 'Total']);
    await go('measure=litres');
    expect(document.querySelector('#bp-dash-v2-period tbody td.bp-num').textContent).toMatch(/ L$/);
  });

  test('table view needs no Chart.js', async function () {
    delete window.Chart;
    await renderV2('');
    var wrapped = document.querySelector('#bp-dash-v2-period .bp-empty');
    expect(wrapped.textContent).toBe('Loading charts…');
    btnW('g1:view:table').click();
    expect(document.querySelector('#bp-dash-v2-period table')).not.toBeNull();
  });

  test('completed-bucket chart click opens a completed label', async function () {
    var list = rows();
    list.push(lean('W9', 'wine', YEAR + '-01-21', { status: 'complete', completed_day: YEAR + '-02-12', completed_at: YEAR + '-02-12T10:00:00Z' }));
    bp._setStateForTest({ _dashData: { asOf: ASOF, batches: list, staffBatchIds: [] }, _allBatchesData: list });
    await renderV2('');
    btnW('g1:mode:completed').click();
    var idx = -1;
    model().cur.completedBuckets.forEach(function (b, i) { if (b.ids.wine.length === 2) idx = i; });
    expect(idx).toBeGreaterThan(-1);
    Fake.prototype.getElementsAtEventForMode = function (e, mode) { return mode === 'nearest' ? [{ index: idx, datasetIndex: 0 }] : []; };
    periodChart().config.options.onClick({}, [], periodChart());
    expect(drill().label).toBe('From dashboard: Wine completed in ' + model().cur.completedBuckets[idx].label + ' · 2 batches');
  });

  test('empty state shows copy and Reset filters', async function () {
    await renderV2('type=beer&source=online');
    var slot = document.getElementById('bp-dash-v2-period');
    expect(slot.querySelector('.bp-empty').textContent).toContain('No batches match these filters.');
    expect(slot.querySelector('[data-dash-reset]')).not.toBeNull();
    expect(slot.querySelector('canvas')).toBeNull();
  });
});

// ===== Phase 96-05: G2 Pipeline and G3 Cycle time =====
describe('G2 Pipeline and G3 Cycle time', function () {
  function ago(n) { return bp.addDays(TODAY, -n); }
  // Completed batch whose span is `span` days, finished `finishedAgo` days ago (window 'all').
  function done(id, type, span, finishedAgo, extra) {
    return lean(id, type, ago(finishedAgo + span), Object.assign({
      status: 'complete', completed_day: ago(finishedAgo), completed_at: ago(finishedAgo) + 'T10:00:00Z'
    }, extra || {}));
  }
  function fixture() {
    return [
      lean('A1', 'wine', ago(5), { status: 'pending' }),
      lean('A2', 'beer', ago(6), { status: 'primary' }),
      lean('A3', 'beer', ago(7), { status: 'secondary' }),
      lean('A4', 'beer', ago(8), { status: 'secondary' }),
      lean('A5', 'cider', ago(9), { status: 'primary', source: 'manual' }),
      lean('A6', 'wine', ago(10), { status: 'primary', staff_batch: true }),
      lean('A7', 'wine', ago(11), { status: 'disabled' }),
      lean('A8', 'seltzer', ago(12), { status: 'secondary' }),
      done('D1', 'wine', 22, 3, { product_subcategory: 'Red' }),
      done('D2', 'wine', 25, 4, { product_subcategory: 'Red' }),
      done('D3', 'wine', 30, 5, { product_subcategory: 'White' }),
      done('D4', 'beer', 10, 6),
      done('D5', 'cider', 12, 7)
    ];
  }
  function mdl(rowsIn, over) {
    var st = Object.assign({}, bp.DASH_FILTER_DEFAULTS, { period: 'all' }, over || {});
    return bp.buildDashV2Model(rowsIn, ASOF, st, {}, {});
  }
  var ctx = { staffIds: {}, catMap: {}, readyIds: { A3: true } };
  function g2(rowsIn, over, c) { var m = mdl(rowsIn, over); return { m: m, g: bp.buildG2Model(rowsIn, m, c || ctx) }; }
  function cell(g, stageKey, seriesKey) {
    var si = g.stages.map(function (s) { return s.key; }).indexOf(stageKey);
    return g.series.filter(function (s) { return s.key === seriesKey; })[0].data[si];
  }
  function btnW(attr) { return document.querySelector('[data-dash-w="' + attr + '"]'); }

  describe('buildG2Model', function () {
    test('stages in order, ready takes precedence, other stage only when non-empty', function () {
      var r = g2(fixture());
      expect(r.g.labels).toEqual(['Pending', 'Primary', 'Secondary', 'Ready to bottle', 'Complete', 'Other stage']);
      expect(cell(r.g, 'ready', 'beer')).toBe(1);
      expect(cell(r.g, 'secondary', 'beer')).toBe(1);
      expect(cell(r.g, 'other', 'wine')).toBe(1);
      var noOther = fixture().filter(function (x) { return x.batch_id !== 'A7'; });
      expect(g2(noOther).g.labels).not.toContain('Other stage');
    });

    test('seltzer folds into other; staff included', function () {
      var r = g2(fixture());
      expect(cell(r.g, 'secondary', 'other')).toBe(1);
      expect(cell(r.g, 'primary', 'wine')).toBe(1);
    });

    [{ type: 'all' }, { type: 'wine' }, { type: 'beer' }, { source: 'kiosk' }].forEach(function (over) {
      test('agrees with the tiles: ' + JSON.stringify(over), function () {
        var r = g2(fixture(), over);
        var active = 0;
        var comp = 0;
        r.g.stages.forEach(function (s, i) {
          if (s.key === 'primary' || s.key === 'secondary' || s.key === 'ready') active += r.g.totals[i];
          if (s.key === 'complete') comp += r.g.totals[i];
        });
        expect(active).toBe(r.m.cur.activeNow);
        expect(comp).toBe(r.m.cur.completed);
        ['wine', 'cider', 'beer'].forEach(function (k) {
          var se = r.g.series.filter(function (x) { return x.key === k; })[0];
          if (!se) return;
          var ci = r.g.stages.map(function (s) { return s.key; }).indexOf('complete');
          expect(se.data[ci]).toBe(r.m.cur.completedTotals.byType[k]);
        });
      });
    });

    test('complete outside the window is not shown; no ready ids keeps Primary/Secondary', function () {
      var list = fixture();
      list.push(done('OLD', 'wine', 5, 900));
      var r = g2(list, { period: '30d' });
      expect(cell(r.g, 'complete', 'wine')).toBe(3);
      var none = g2(fixture(), {}, { staffIds: {}, catMap: {}, readyIds: {} });
      expect(cell(none.g, 'ready', 'beer')).toBe(0);
      expect(cell(none.g, 'secondary', 'beer')).toBe(2);
    });

    test('drill subjects, note and table equal chart numbers', function () {
      var r = g2(fixture(), { period: 'ytd' });
      expect(r.g.subjectFor('secondary', 'Secondary', 'Beer')).toBe('Beer at Secondary');
      expect(r.g.subjectFor('ready', 'Ready to bottle', 'Wine')).toBe('Wine at Ready to bottle');
      expect(r.g.subjectFor('complete', 'Complete', 'Beer')).toBe('Beer completed YTD');
      expect(r.g.subjectFor('secondary', 'Secondary', '')).toBe('Batches at Secondary');
      expect(r.g.subjectFor('complete', 'Complete', '')).toBe('Completed YTD');
      expect(r.g.note).toBe('Complete counts batches finished in YTD');
      r.g.table.rows.forEach(function (row, i) {
        var nums = row.cells.slice(1, -1).map(function (c) { return c.value; });
        r.g.series.forEach(function (se, k) { expect(se.data[i]).toBe(nums[k]); });
        expect(row.cells[row.cells.length - 1].value).toBe(sum(nums));
      });
      expect(r.g.table.columns.map(function (c) { return c.label; })).toEqual(['Stage', 'Wine', 'Cider', 'Beer', 'Other', 'Total']);
    });
  });

  describe('dashP95 and buildG3Model', function () {
    test('nearest-rank p95', function () {
      expect(bp.dashP95([])).toBeNull();
      var a = [];
      for (var i = 1; i <= 20; i++) a.push(i);
      expect(bp.dashP95(a)).toBe(19);
    });

    function spanRows(spans) {
      return spans.map(function (n, i) { return done('X' + i, 'wine', n, 1 + i); });
    }
    function g3(rowsIn, over, c) {
      var m = mdl(rowsIn, over);
      return { m: m, g: bp.buildG3Model(rowsIn, m, c || { staffIds: {}, catMap: {}, batchMeta: {} }) };
    }

    test('outlier cap: p95 40 and one 200 -> bins to 35-41 and 42+', function () {
      var spans = [];
      for (var i = 0; i < 18; i++) spans.push(10 + i);
      spans.push(40);
      spans.push(200);
      var r = g3(spanRows(spans));
      expect(r.g.cap).toBe(42);
      expect(r.g.labels).toEqual(['0–6', '7–13', '14–20', '21–27', '28–34', '35–41', '42+']);
      expect(r.g.series[0].data[6]).toBe(1);
      expect(sum(r.g.series[0].data)).toBe(20);
    });

    test('bin edges: 6 -> 0-6, 7 -> 7-13', function () {
      var r = g3(spanRows([0, 6, 7, 13, 14]));
      expect(r.g.series[0].data.slice(0, 3)).toEqual([2, 2, 1]);
    });

    test('total equals the Days to complete set (cur.cycle.n)', function () {
      var list = fixture();
      ['all', 'wine', 'beer'].forEach(function (t) {
        var r = g3(list, { type: t });
        expect(r.g.n).toBe(r.m.cur.cycle.n);
        expect(r.g.median).toBe(r.m.cur.cycle.median);
      });
      var k = g3(list, { source: 'kiosk' });
      expect(k.g.n).toBe(k.m.cur.cycle.n);
    });

    test('planned lines use the per-type median, capped at the open bin', function () {
      var list = [done('P1', 'wine', 22, 1), done('P2', 'wine', 25, 2), done('P3', 'beer', 10, 3)];
      var meta = { P1: { planned_days: 20 }, P2: { planned_days: 30 }, P3: { planned_days: 400 } };
      var r = g3(list, {}, { staffIds: {}, catMap: {}, batchMeta: meta });
      var wine = r.g.vLines.filter(function (v) { return v.key === 'wine'; })[0];
      expect(wine.label).toBe('Planned 25 d');
      expect(wine.value).toBeCloseTo(25 / 7 - 0.5, 5);
      var beer = r.g.vLines.filter(function (v) { return v.key === 'beer'; })[0];
      expect(beer.value).toBeCloseTo(r.g.cap / 7 - 0.5, 5);
      expect(g3(list).g.vLines).toEqual([]);
      var last = r.g.table.rows[r.g.table.rows.length - 1];
      expect(last.cells[0].text).toBe('Planned (median)');
      expect(last.cells.every(function (c) { return !c.ids; })).toBe(true);
    });

    test('subtitle, subjects and product choices', function () {
      var list = fixture();
      var r = g3(list, { type: 'wine' });
      expect(r.g.subtitle).toBe('Days from start to complete · ' + r.m.periodLabel + ' · median 25 d');
      expect(r.g.choices.map(function (c) { return c[1]; })).toEqual(['All products', 'Red', 'White']);
      var red = bp.buildG3Model(list, r.m, { staffIds: {}, catMap: {}, batchMeta: {}, product: 'Red' });
      expect(red.n).toBe(2);
      expect(r.g.subjectFor('21–27', 'Wine')).toBe('Wine completed in 21–27 days');
      expect(r.g.subjectFor('21–27', '')).toBe('Completed in 21–27 days');
      expect(g3(list, { type: 'all' }).g.showProduct).toBe(false);
      expect(g3([]).g.subtitle).toBe('Days from start to complete · ' + mdl([]).periodLabel);
    });
  });

  describe('renderers', function () {
    beforeEach(function () {
      var o = bp._dashV2FrameForTest.opts;
      Object.keys(o).forEach(function (k) { delete o[k]; });
    });
    function setup(list, extra) {
      bp._setStateForTest({ _allBatchesData: list, _dashData: Object.assign({ asOf: ASOF, batches: list, staffBatchIds: [] }, extra || {}) });
    }
    function chartOf(sel) { var c = document.querySelector(sel + ' canvas'); return c ? Fake.getChart(c) : null; }

    test('pipeline chart and table share numbers; one live instance per canvas', async function () {
      setup(fixture(), { summary: { readyToBottle: [{ batch_id: 'A3' }] } });
      await renderV2('period=all');
      var ch = chartOf('#bp-dash-v2-pipeline');
      expect(ch.config.options.indexAxis).toBe('y');
      expect(document.querySelector('#bp-dash-v2-pipeline .bp-widget-note').textContent).toContain('Complete counts batches finished in');
      expect(document.querySelector('#bp-dash-v2-pipeline .bp-chart').style.height).toBe('320px');
      var chartNums = ch.config.data.datasets.map(function (d) { return d.data.slice(); });
      btnW('g2:view:table').click();
      var rowsEl = document.querySelectorAll('#bp-dash-v2-pipeline tbody tr');
      for (var i = 0; i < rowsEl.length; i++) {
        var tds = rowsEl[i].querySelectorAll('td');
        chartNums.forEach(function (d, k) { expect(Number(tds[k + 1].textContent)).toBe(d[i]); });
      }
      btnW('g2:view:chart').click();
      var canvas = document.querySelector('#bp-dash-v2-pipeline canvas');
      expect(live(canvas).length).toBe(1);
    });

    test('pipeline table: single batch opens detail, multiple opens the banner', async function () {
      setup(fixture(), { summary: { readyToBottle: [] } });
      await renderV2('period=all');
      btnW('g2:view:table').click();
      function rowFor(label) {
        return Array.prototype.filter.call(document.querySelectorAll('#bp-dash-v2-pipeline tbody tr'), function (tr) { return tr.cells[0].textContent === label; })[0];
      }
      var links = rowFor('Secondary').querySelectorAll('.bp-table-link');
      links[links.length - 1].click();
      expect(drill().label).toBe('From dashboard: Batches at Secondary · 3 batches');
      bp._clearDashDrillForTest();
      var pend = rowFor('Pending').querySelectorAll('.bp-table-link');
      pend[pend.length - 1].click();
      expect(drill()).toBeNull();
    });

    test('pipeline segment click uses the stage and type subject', async function () {
      setup(fixture(), { summary: { readyToBottle: [] } });
      await renderV2('period=all');
      var ch = chartOf('#bp-dash-v2-pipeline');
      var si = ch.config.data.labels.indexOf('Secondary');
      var di = ch.config.data.datasets.map(function (d) { return d.label; }).indexOf('Beer');
      Fake.prototype.getElementsAtEventForMode = function (e, mode) { return mode === 'nearest' ? [{ index: si, datasetIndex: di }] : []; };
      ch.config.options.onClick({}, [], ch);
      expect(drill().label).toBe('From dashboard: Beer at Secondary · 2 batches');
    });

    test('cycle: histogram, drill banner and product select', async function () {
      setup(fixture(), { batchMeta: [{ batch_id: 'D1', planned_days: 30 }] });
      await renderV2('period=all');
      var ch = chartOf('#bp-dash-v2-cycle');
      expect(ch).not.toBeNull();
      expect(document.querySelector('#bp-dash-v2-cycle select')).toBeNull();
      var bi = ch.config.data.labels.indexOf('21–27');
      var di = ch.config.data.datasets.map(function (d) { return d.label; }).indexOf('Wine');
      Fake.prototype.getElementsAtEventForMode = function (e, mode) { return mode === 'nearest' ? [{ index: bi, datasetIndex: di }] : []; };
      ch.config.options.onClick({}, [], ch);
      expect(drill().label).toBe('From dashboard: Wine completed in 21–27 days · 2 batches');
      await renderV2('period=all&type=wine');
      var sel = document.querySelector('#bp-dash-v2-cycle select');
      expect(sel.getAttribute('aria-label')).toBe('Product');
      expect(Array.prototype.map.call(sel.options, function (o) { return o.textContent; })).toEqual(['All products', 'Red', 'White']);
    });

    test('cycle empty state has copy, Reset filters and no canvas', async function () {
      setup([lean('E1', 'wine', ago(3))]);
      await renderV2('period=all');
      var slot = document.getElementById('bp-dash-v2-cycle');
      expect(slot.querySelector('.bp-empty').textContent).toContain('No completed batches in this period.');
      expect(slot.querySelector('[data-dash-reset]')).not.toBeNull();
      expect(slot.querySelector('canvas')).toBeNull();
    });
  });
});

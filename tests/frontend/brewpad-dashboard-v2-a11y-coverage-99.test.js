'use strict';

// Phase 99-06: every v2 widget that draws a chart has a Chart/Table toggle and a table view
// (registry-driven, so a new chart widget without one fails here), plus the packaging calendar table.

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
async function settleAll() { for (var i = 0; i < 6; i++) await flush(); }

function d(n) {
  var p = TODAY.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000).toISOString().slice(0, 10);
}

function lean(id, type, status, extra) {
  return Object.assign({
    batch_id: id, status: status, batch_type: type, batch_type_source: 'recipe',
    start_date: d(-5), completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: 'V-' + id, source: 'kiosk', product_sku: 'SKU1', product_name: 'P-' + id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: 20, tasks_total: 0, tasks_done: 0
  }, extra || {});
}

function batchRows() {
  var out = [];
  var types = ['wine', 'wine', 'beer', 'beer', 'cider', 'cider', 'wine', 'seltzer'];
  for (var i = 0; i < 24; i++) {
    var done = i % 3 === 0;
    var extra = { start_date: d(-60 + i * 2), product_sku: 'SKU' + (i % 4), product_name: 'Product ' + (i % 4) };
    if (done) { extra.completed_day = d(-10 - i); extra.completed_at = d(-10 - i) + 'T18:00:00Z'; }
    out.push(lean('B' + (100 + i), types[i % types.length], done ? 'complete' : 'primary', extra));
  }
  return out;
}

function fullDash(rows) {
  var active = rows.filter(function (r) { return r.status === 'primary'; });
  var taskRows = [];
  active.forEach(function (r, i) {
    taskRows.push({ batch_id: r.batch_id, task_id: 't' + i, title: i % 2 ? 'Filtering' : 'Racking', due_date: d(i % 20 - 5), completed: false, completed_day: null, is_packaging: false, is_transfer: false });
  });
  var readings = [];
  active.filter(function (r) { return r.batch_type === 'beer' || r.batch_type === 'cider'; }).forEach(function (r) {
    readings.push({ batch_id: r.batch_id, reading_day: d(-6), degrees_plato: 12 });
    readings.push({ batch_id: r.batch_id, reading_day: d(-2), degrees_plato: 7 });
  });
  return {
    asOf: ASOF,
    batches: rows,
    staffBatchIds: [],
    taskRows: taskRows,
    readings: readings,
    vessels: [{ vessel_id: 'V1', type: 'Carboy', capacity_liters: 23, archived: false }, { vessel_id: 'V2', type: 'Keg', capacity_liters: 50, archived: false }],
    batchMeta: rows.map(function (r, i) { return { batch_id: r.batch_id, has_invoice_link: i % 2 === 0, og: null, target_fg: null, recipe_name: 'Rec', recipe_style: 'Style' }; }),
    summary: { readyToBottle: [] }
  };
}

function makeFakeChart() {
  function FakeChart(canvas, config) { this.canvas = canvas; this.config = config; }
  FakeChart.prototype.destroy = function () {};
  FakeChart.prototype.resize = function () {};
  FakeChart.prototype.getElementsAtEventForMode = function () { return []; };
  FakeChart.getChart = function () { return null; };
  FakeChart.defaults = { font: {} };
  return FakeChart;
}

var loadSeq = 7000;
function mount(dash, rows) {
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  loadSeq++;
  bp._setStateForTest({
    _allBatchesData: rows,
    _dashLoadTime: loadSeq,
    _dashData: dash,
    _dashSummary: {},
    _dashWineSkuLookup: {},
    _upcomingTasks: [],
    _upcomingLoaded: true
  });
}

async function renderV2() {
  window.history.replaceState(null, '', '/brewpad.html?dash=v2');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await settleAll();
}

function calTask(batch, due, extra) {
  return Object.assign({
    task_id: 'T-' + batch + due, batch_id: batch, due_date: due, completed: false, is_packaging: true,
    customer_name: 'Cust ' + batch, title: 'Bottle'
  }, extra || {});
}

function mockNet(opts) {
  var o = opts || {};
  global.fetch.mockImplementation(function (url, init) {
    var u = String(url);
    if (u.indexOf('/api/admin/packaging-bookings') !== -1) {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(o.bookings || { ok: true, bookings: [] }); } });
    }
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
    if (body.action === 'get_tasks_calendar') {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: { tasks: o.tasks || [] } }); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
  });
}

function resetOpts() {
  Object.keys(bp._dashV2FrameForTest.opts).forEach(function (k) { delete bp._dashV2FrameForTest.opts[k]; });
  Object.keys(bp._dashV2FrameForTest.expanded).forEach(function (k) { delete bp._dashV2FrameForTest.expanded[k]; });
}

beforeEach(function () {
  window.localStorage.clear();
  resetOpts();
  bp._resetChartJsForTest();
  window.Chart = makeFakeChart();
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
  global.fetch.mockImplementation(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
  });
});

function slotOf(def) { return document.getElementById(def.slot); }

function viewToggles(slot) {
  return Array.prototype.slice.call(slot.querySelectorAll('[role="radiogroup"][aria-label="View as"]'));
}

describe('table-view coverage (registry)', function () {
  test('every widget that draws a canvas has a View-as toggle and a table view', async function () {
    var rows = batchRows();
    mount(fullDash(rows), rows);
    await renderV2();
    // Beer & cider only draws a curve once a card's readings curve is opened.
    var open = document.querySelector('#bp-dash-v2-bc [data-bc-curve]');
    expect(open).not.toBeNull();
    open.click();
    var widgets = bp._dashV2FrameForTest.widgets;
    var withCanvas = [];
    widgets.forEach(function (def) {
      var slot = slotOf(def);
      expect(slot).not.toBeNull();
      if (!slot.querySelector('canvas')) return;
      withCanvas.push(def.key);
      expect([def.key, viewToggles(slot).length]).not.toEqual([def.key, 0]);
    });
    // Guard against a vacuous pass: these widgets must have drawn a chart with this fixture.
    ['g1', 'g2', 'g3', 'g4', 'g9', 'g5', 'g7', 'g6', 'g8', 'bc'].forEach(function (k) {
      expect([k, withCanvas.indexOf(k) !== -1]).toEqual([k, true]);
    });

    // Switching each toggle to Table yields a table inside .bp-table-wrap, without a canvas for that view.
    widgets.forEach(function (def) {
      if (withCanvas.indexOf(def.key) === -1) return;
      var n = viewToggles(slotOf(def)).length;
      for (var i = 0; i < n; i++) {
        var btn = viewToggles(slotOf(def))[i].querySelector('[data-dash-w$=":view:table"], [data-bc-view$=":table"]');
        expect([def.key, !!btn]).toEqual([def.key, true]);
        btn.click();
      }
      var wraps = slotOf(def).querySelectorAll('.bp-table-wrap table');
      expect([def.key, wraps.length > 0]).toEqual([def.key, true]);
    });
  });

  test('table views render when Chart.js is unavailable and when it failed to load', async function () {
    var rows = batchRows();
    mount(fullDash(rows), rows);
    delete window.Chart;
    window.localStorage.clear();
    window.history.replaceState(null, '', '/brewpad.html?dash=v2');
    bp._initDashV2FlagForTest();
    // Put every chart widget on Table before the first render.
    ['g2', 'g7', 'g6', 'g8'].forEach(function (k) { bp._dashV2FrameForTest.opts[k + ':view'] = 'table'; });
    ['g1', 'g3', 'g4', 'g9', 'g5'].forEach(function (k) { bp._dashV2FrameForTest.opts[k + ':view'] = 'table'; });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    bp._renderDashboardForTest();
    var script = document.head.querySelector('script');
    if (script && script.onerror) script.onerror();
    await settleAll();
    ['g2', 'g7', 'g6', 'g8'].forEach(function (k) {
      var def = bp._dashV2FrameForTest.widgets.filter(function (w) { return w.key === k; })[0];
      var slot = slotOf(def);
      expect([k, slot.querySelectorAll('.bp-table-wrap table').length > 0]).toEqual([k, true]);
      expect([k, slot.textContent.indexOf('Charts could not load')]).toEqual([k, -1]);
    });
  });

  test('every table wrap is a labelled, focusable region named after its widget', async function () {
    var rows = batchRows();
    mount(fullDash(rows), rows);
    await renderV2();
    var widgets = bp._dashV2FrameForTest.widgets;
    widgets.forEach(function (def) {
      var slot = slotOf(def);
      var btns = slot.querySelectorAll('[data-dash-w$=":view:table"]');
      if (btns.length) btns[0].click();
    });
    var checked = 0;
    widgets.forEach(function (def) {
      var s = slotOf(def);
      Array.prototype.forEach.call(s.querySelectorAll('.bp-table-wrap'), function (w) {
        checked++;
        expect(w.getAttribute('role')).toBe('region');
        expect(w.getAttribute('tabindex')).toBe('0');
        expect(w.getAttribute('aria-label')).toBe(def.title + ' table');
      });
    });
    expect(checked).toBeGreaterThan(5);
  });
});

describe('packaging calendar table (t3)', function () {
  function setup(tasks, bookings) {
    var list = [lean('W1', 'wine', 'primary'), lean('B1', 'beer', 'primary', { source: 'manual' }), lean('C1', 'cider', 'primary')];
    mount({ asOf: ASOF, batches: list, staffBatchIds: [] }, list);
    mockNet({ tasks: tasks, bookings: bookings });
  }
  function slot() { return document.getElementById('bp-dash-v2-packcal'); }

  test('default Calendar; toggle offers Calendar and Table', async function () {
    setup([calTask('W1', d(2))]);
    await renderV2();
    var tg = slot().querySelector('[role="radiogroup"][aria-label="View as"]');
    expect(tg).not.toBeNull();
    var labels = Array.prototype.map.call(tg.querySelectorAll('button'), function (b) { return b.textContent; });
    expect(labels).toEqual(['Calendar', 'Table']);
    expect(slot().querySelector('.bp-cal')).not.toBeNull();
    expect(slot().querySelector('table')).toBeNull();
  });

  test('Table has Date, Batch, Task, Type headers and one row per calendar entry, in order', async function () {
    var tasks = [calTask('W1', d(2)), calTask('B1', d(2))];
    setup(tasks, { ok: true, bookings: [
      { uid: 'a', start: new Date(Date.now() + 86400000 * 3).toISOString(), end: '', day: d(3), kind: 'bottling', batch_id: 'C1', customer_name: 'Cider Person' },
      { uid: 'b', start: new Date(Date.now() + 86400000 * 3).toISOString(), end: '', day: d(3), kind: 'canning', batch_id: null, customer_name: 'Mystery' }
    ] });
    await renderV2();
    var entries = slot().querySelectorAll('li.bp-cal-entry').length;
    slot().querySelector('[data-dash-w="t3:view:table"]').click();
    var heads = Array.prototype.map.call(slot().querySelectorAll('thead th'), function (h) { return h.textContent; });
    expect(heads).toEqual(['Date', 'Batch', 'Task', 'Type']);
    var trs = slot().querySelectorAll('tbody tr');
    expect(trs.length).toBe(entries);
    expect(entries).toBe(4);
    expect(slot().querySelector('.bp-cal')).toBeNull();
    expect(slot().querySelector('caption').textContent).toBeTruthy();
    var firstCells = trs[0].querySelectorAll('td');
    expect(firstCells.length).toBe(4);
    // Words, not codes.
    var typeCol = Array.prototype.map.call(trs, function (tr) { return tr.querySelectorAll('td')[3].textContent; });
    typeCol.forEach(function (t) { expect(t).toMatch(/^(Booking|Task)/); });
    var taskCol = Array.prototype.map.call(trs, function (tr) { return tr.querySelectorAll('td')[2].textContent; });
    expect(taskCol.sort()).toEqual(['Bottling', 'Bottling', 'Canning', 'Canning']);
  });

  test('table view survives Chart.js being absent and is a labelled region', async function () {
    setup([calTask('W1', d(2))]);
    delete window.Chart;
    await renderV2();
    var btn = slot().querySelector('[data-dash-w="t3:view:table"]');
    btn.click();
    var wrap = slot().querySelector('.bp-table-wrap');
    expect(wrap.getAttribute('role')).toBe('region');
    expect(wrap.getAttribute('aria-label')).toBe('Packaging calendar table');
    expect(wrap.getAttribute('tabindex')).toBe('0');
    slot().querySelector('[data-dash-w="t3:view:calendar"]').click();
    expect(slot().querySelector('.bp-cal')).not.toBeNull();
  });

  test('batch and customer text is escaped, never parsed as markup', async function () {
    setup([calTask('W1', d(2), { customer_name: '<script>window.__x=1</script>' })]);
    await renderV2();
    slot().querySelector('[data-dash-w="t3:view:table"]').click();
    expect(slot().querySelector('table script')).toBeNull();
    expect(slot().querySelector('tbody').textContent).toContain('<script>');
    expect(window.__x).toBeUndefined();
  });

  test('empty and unavailable states show no toggle', async function () {
    setup([]);
    await renderV2();
    expect(slot().querySelector('[role="radiogroup"]')).toBeNull();
    expect(slot().textContent).toContain('Nothing booked or due');
  });
});

describe('dashV2PackCalTableModel', function () {
  test('maps calendar days to flat rows', function () {
    var cal = {
      total: 2, note: '', undatedCount: 0,
      days: [
        { day: '2026-11-05', label: 'Thu 5 Nov', entries: [
          { source: 'booking', time: '2:30 pm', customer: 'Wendy', batch_id: 'W1', kind: 'Bottling', status: '' },
          { source: 'task', time: 'All day', customer: '', batch_id: 'B1', kind: 'Canning', status: 'not booked yet' }
        ] }
      ]
    };
    var m = bp.dashV2PackCalTableModel(cal);
    expect(m.headers).toEqual(['Date', 'Batch', 'Task', 'Type']);
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0].cells[0]).toContain('Thu 5 Nov');
    expect(m.rows[0].cells[1]).toContain('W1');
    expect(m.rows[0].cells[2]).toBe('Bottling');
    expect(m.rows[0].cells[3]).toBe('Booking');
    expect(m.rows[1].cells[3]).toContain('not booked yet');
  });
});

describe('Today task checkboxes have an accessible name (axe label rule)', function () {
  test('each checkbox is named after its task; markup is escaped', function () {
    var host = document.createElement('div');
    host.innerHTML = bp.dashTodayTaskRowHtml({ task_id: 'T1', batch_id: 'B1', title: 'Rack <b>wine</b>' }, true) +
      bp.dashTodayTaskRowHtml({ task_id: 'T2', batch_id: 'B2', step_number: 3 }, false);
    var boxes = host.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].getAttribute('aria-label')).toBe('Mark done: Rack <b>wine</b>');
    expect(boxes[1].getAttribute('aria-label')).toBe('Mark done: Step 3');
    expect(host.querySelector('b')).toBeNull();
  });
});

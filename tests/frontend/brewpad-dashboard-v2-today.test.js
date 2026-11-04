'use strict';

// Phase 97-07: v2 six-section layout, Today section (Today's tasks + Ready to bottle).

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

function rows() {
  return [lean('W1', 'wine'), lean('B1', 'beer', { source: 'manual' }), lean('C1', 'cider')];
}

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
    _dashData: Object.assign({ asOf: ASOF, batches: list, staffBatchIds: [] }, o.extra || {}),
    _dashSummary: o.summary || {},
    _dashWineSkuLookup: {}
  });
  bp._setStateForTest({ _upcomingTasks: o.tasks || [], _upcomingLoaded: o.loaded !== false });
}

async function renderV2(hash) {
  setUrl(hash ? '#' + hash : '');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flush();
}

var seq = 0;
function task(batch, title, due, extra) {
  seq++;
  return Object.assign({
    batch_id: batch, task_id: 'T' + seq, title: title, due_date: due, completed: false, step_number: seq
  }, extra || {});
}

beforeEach(function () {
  window.localStorage.clear();
  window.Chart = function () {};
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  mount();
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});

describe('six-section layout', function () {
  test('titles, hints and slots in D-14 order', async function () {
    await renderV2('');
    var secs = document.querySelectorAll('#bp-dash-v2 section.bp-dash-section');
    var titles = Array.prototype.map.call(secs, function (s) { return s.querySelector('h2.bp-dash-section-title').textContent; });
    expect(titles).toEqual(['Today', 'Production', 'Floor today', 'Beer & cider', 'Products & sales', 'Data health']);
    var hints = Array.prototype.map.call(secs, function (s) { return s.querySelector('.bp-dash-section-hint').textContent; });
    expect(hints[0]).toBe("Right now. The filters above don't apply.");
    expect(hints[1]).toBe('Follows the filters above');
    expect(hints[3]).toBe('Follows the Type and Source filters. Staff batches included.');
    function slots(i) { return Array.prototype.map.call(secs[i].querySelectorAll('.bp-dash-grid > div'), function (x) { return x.id; }); }
    expect(slots(0)).toEqual(['bp-dash-v2-today-tasks', 'bp-dash-v2-rtb', 'bp-dash-v2-packcal']);
    expect(slots(3)).toEqual(['bp-dash-v2-bc']);
    expect(document.getElementById('bp-dash-v2-packcal').className).toContain('bp-dash-full');
    expect(document.getElementById('bp-dash-v2-bc').className).toContain('bp-dash-full');
  });

  test('Beer & cider is hidden for Wine only, without rebuilding the shell', async function () {
    await renderV2('');
    var sec = document.querySelector('section[data-dash-sec="bc"]');
    var node = document.getElementById('bp-dash-filters');
    expect(sec.hidden).toBe(false);
    await go('type=wine');
    expect(sec.hidden).toBe(true);
    expect(document.getElementById('bp-dash-filters')).toBe(node);
    await go('type=beer');
    expect(sec.hidden).toBe(false);
    await go('type=wine');
    await go('type=cider');
    expect(sec.hidden).toBe(false);
    await go('type=wine');
    await go('');
    expect(sec.hidden).toBe(false);
  });
});

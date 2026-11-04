'use strict';

// Phase 97-09: Beer & cider cards (pure model + widget bc).

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

function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
async function settleAll() { for (var i = 0; i < 6; i++) await flush(); }

// ---------------------------------------------------------------- pure model

var TODAY_P = '2026-11-03';
var CANNING = { packaged_litres: 25, brew_litres: 28, nominal: { '473': 52, '355': 70 } };

function row(id, type, extra) {
  return Object.assign({
    batch_id: id, status: 'primary', batch_type: type, start_date: '2026-10-25', source: 'manual',
    product_name: 'Prod ' + id, schedule_category: '', target_volume_l: null
  }, extra || {});
}

function build(over) {
  var o = Object.assign({
    rows: [], metaById: {}, cardsById: {}, taskRows: [], readings: [], canning: CANNING,
    state: { type: 'all', source: 'all', staff: '0' }, today: TODAY_P, catMap: {}
  }, over || {});
  return bp.buildBeerCiderCards(o);
}

describe('dashWeekdayDate', function () {
  test('short English date', function () {
    expect(bp.dashWeekdayDate('2026-11-06')).toBe('Fri 6 Nov');
    expect(bp.dashWeekdayDate('2026-11-06T10:00:00Z')).toBe('Fri 6 Nov');
  });
});

describe('buildBeerCiderCards selection', function () {
  var rows = [
    row('C1', 'cider', { start_date: '2026-10-20' }),
    row('B1', 'beer', { start_date: '2026-10-20' }),
    row('B2', 'beer', { start_date: '2026-10-28' }),
    row('B3', 'beer', { start_date: '2026-10-20' }),
    row('W1', 'wine'),
    row('B9', 'beer', { status: 'complete' }),
    row('B8', 'beer', { status: 'secondary', start_date: '2026-10-01' }),
    row('B7', 'beer', { source: 'kiosk', start_date: '2026-09-01' })
  ];

  test('beer first, newest first, ties by batch id descending; only primary/secondary', function () {
    var m = build({ rows: rows });
    expect(m.cards.map(function (c) { return c.batch_id; })).toEqual(['B2', 'B3', 'B1', 'B8', 'B7', 'C1']);
  });

  test('type filter', function () {
    expect(build({ rows: rows, state: { type: 'cider', source: 'all' } }).cards.map(function (c) { return c.batch_id; })).toEqual(['C1']);
    expect(build({ rows: rows, state: { type: 'beer', source: 'all' } }).cards).toHaveLength(5);
  });

  test('source filter', function () {
    var m = build({ rows: rows, state: { type: 'all', source: 'kiosk' } });
    expect(m.cards.map(function (c) { return c.batch_id; })).toEqual(['B7']);
  });

  test('staff batches are included even with the staff toggle off', function () {
    var m = build({ rows: [row('B1', 'beer', { staff_batch: true })], state: { type: 'all', source: 'all', staff: '0' } });
    expect(m.cards).toHaveLength(1);
  });

  test('wine type hides the section', function () {
    expect(build({ rows: rows, state: { type: 'wine', source: 'all' } }).hidden).toBe(true);
  });

  test('empty text per type', function () {
    expect(build({ state: { type: 'beer' } }).emptyText).toBe('No active beer batches');
    expect(build({ state: { type: 'cider' } }).emptyText).toBe('No active cider batches');
    expect(build({ state: { type: 'all' } }).emptyText).toBe('No active beer or cider batches');
    expect(build({ state: { type: 'all' } }).cards).toEqual([]);
  });
});

describe('buildBeerCiderCards facts', function () {
  test('beer facts, header and day line', function () {
    var m = build({
      rows: [row('SV-B-000167', 'beer', { start_date: '2026-10-25' })],
      metaById: { 'SV-B-000167': { recipe_name: 'Czech Lager', recipe_style: 'Czech Lager' } },
      cardsById: { 'SV-B-000167': { abv: 4.8, ibu: 32 } }
    });
    var c = m.cards[0];
    expect(c.title).toBe('SV-B-000167 · Czech Lager');
    expect(c.typeLabel).toBe('Beer');
    expect(c.dayLine).toBe('Day 9 · Primary');
    expect(c.facts).toEqual([
      { label: 'Style', value: 'Czech Lager' }, { label: 'ABV', value: '4.8%' }, { label: 'IBU', value: '32' }
    ]);
  });

  test('missing values are omitted; all empty gives no facts', function () {
    var m = build({ rows: [row('B1', 'beer')], metaById: { B1: { recipe_name: 'X', recipe_style: 'Pils' } }, cardsById: { B1: { abv: 4.8, ibu: null } } });
    expect(m.cards[0].facts.map(function (f) { return f.label; })).toEqual(['Style', 'ABV']);
    expect(build({ rows: [row('B1', 'beer')] }).cards[0].facts).toEqual([]);
  });

  test('cider juice falls back to recipe name then product name; yeast omitted when unknown', function () {
    var a = build({ rows: [row('C1', 'cider')], cardsById: { C1: { juice: 'Apple', yeast: 'Cider yeast', abv: 5.1 } } }).cards[0];
    expect(a.facts).toEqual([
      { label: 'Juice', value: 'Apple' }, { label: 'Yeast', value: 'Cider yeast' }, { label: 'ABV', value: '5.1%' }
    ]);
    var b = build({ rows: [row('C1', 'cider')], metaById: { C1: { recipe_name: 'Dry Cider' } }, cardsById: { C1: {} } }).cards[0];
    expect(b.facts).toEqual([{ label: 'Juice', value: 'Dry Cider' }]);
    var c = build({ rows: [row('C1', 'cider', { product_name: 'House Cider' })] }).cards[0];
    expect(c.facts).toEqual([{ label: 'Juice', value: 'House Cider' }]);
  });
});

describe('buildBeerCiderCards readings', function () {
  test('OG, Latest and Target FG wording', function () {
    var m = build({
      rows: [row('B1', 'beer')],
      metaById: { B1: { og: 12, target_fg: 3.5 } },
      readings: [
        { batch_id: 'B1', reading_at: '2026-10-30T10:00:00Z', degrees_plato: 8 },
        { batch_id: 'B1', reading_at: '2026-11-02T10:00:00Z', degrees_plato: 6.4 }
      ]
    });
    expect(m.cards[0].readings).toEqual({ og: '12.0 °P', latest: '6.4 °P', targetFg: '3.5 °P' });
    expect(m.cards[0].hasReadings).toBe(true);
  });

  test('no readings reads No readings yet, targets still show', function () {
    var c = build({ rows: [row('B1', 'beer')], metaById: { B1: { og: 12, target_fg: 3.5 } } }).cards[0];
    expect(c.readings.latest).toBe('No readings yet');
    expect(c.readings.og).toBe('12.0 °P');
    expect(c.readings.targetFg).toBe('3.5 °P');
    expect(c.hasReadings).toBe(false);
  });
});

describe('buildBeerCiderCards next step', function () {
  function nextFor(tasks) { return build({ rows: [row('B1', 'beer')], taskRows: tasks }).cards[0].next; }

  test('earliest open task, temperature step flagged', function () {
    var n = nextFor([
      { batch_id: 'B1', task_id: 'a', title: 'Rack', due_date: '2026-11-10', completed: false },
      { batch_id: 'B1', task_id: 'b', title: 'Lower to 10°C', due_date: '2026-11-06', completed: false },
      { batch_id: 'B1', task_id: 'c', title: 'Done', due_date: '2026-11-01', completed: true },
      { batch_id: 'B2', task_id: 'd', title: 'Other batch', due_date: '2026-11-01', completed: false }
    ]);
    expect(n).toEqual({ text: 'Lower to 10°C', when: 'due Fri 6 Nov', temp: true, late: false });
  });

  test('undated last, ties keep task order', function () {
    var n = nextFor([
      { batch_id: 'B1', task_id: 'a', title: 'Undated', due_date: null, completed: false },
      { batch_id: 'B1', task_id: 'b', title: 'First', due_date: '2026-11-06', completed: false },
      { batch_id: 'B1', task_id: 'c', title: 'Second', due_date: '2026-11-06', completed: false }
    ]);
    expect(n.text).toBe('First');
  });

  test('due today and past due', function () {
    expect(nextFor([{ batch_id: 'B1', task_id: 'a', title: 'Gravity', due_date: '2026-11-03', completed: false }]))
      .toMatchObject({ when: 'due today', late: false, temp: false });
    expect(nextFor([{ batch_id: 'B1', task_id: 'a', title: 'Gravity', due_date: '2026-11-01', completed: false }]))
      .toMatchObject({ when: 'due Sun 1 Nov', late: true });
  });

  test('no open task', function () {
    expect(nextFor([]).text).toBe('No open tasks');
  });
});

describe('buildBeerCiderCards output', function () {
  test('beer default volume', function () {
    expect(build({ rows: [row('B1', 'beer')] }).cards[0].output).toBe('≈ 25 L packaged · ≈ 52 × 473 mL or 70 × 355 mL');
  });

  test('beer with target volume uses the same proportion, cans round down', function () {
    expect(build({ rows: [row('B1', 'beer', { target_volume_l: 14 })] }).cards[0].output)
      .toBe('≈ 13 L packaged · ≈ 26 × 473 mL or 35 × 355 mL');
    expect(build({ rows: [row('B1', 'beer', { target_volume_l: 20 })] }).cards[0].output)
      .toBe('≈ 18 L packaged · ≈ 37 × 473 mL or 50 × 355 mL');
  });

  test('cider shows litres only; no canning omits output', function () {
    expect(build({ rows: [row('C1', 'cider')] }).cards[0].output).toBe('≈ 25 L packaged');
    expect(build({ rows: [row('C1', 'cider')], canning: null }).cards[0].output).toBe('');
  });
});

describe('buildBeerCiderCards copy guard', function () {
  test('no banned words or null/undefined in any string', function () {
    var m = build({
      rows: [row('B1', 'beer'), row('C1', 'cider')],
      taskRows: [{ batch_id: 'B1', task_id: 'a', title: 'Gravity', due_date: '2026-11-01', completed: false }]
    });
    var s = JSON.stringify(m).toLowerCase();
    ['overdue', 'missing', 'error', 'null', 'undefined'].forEach(function (w) {
      var hit = w === 'null' ? s.replace(/:null/g, '').indexOf('null') : s.indexOf(w);
      expect(hit).toBe(-1);
    });
  });
});

// ---------------------------------------------------------------- widget (DOM)

var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

function dd(n) {
  var p = TODAY.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000).toISOString().slice(0, 10);
}

function lean(id, type, extra) {
  return Object.assign({
    batch_id: id, status: 'primary', batch_type: type, batch_type_source: 'recipe',
    start_date: dd(-9), completed_day: null, completed_at: null, completed_at_source: null,
    vessel_id: null, source: 'kiosk', product_sku: '', product_name: id, product_subcategory: '',
    product_brand: '', product_manufacturer: '', recipe_id: '', schedule_id: '',
    schedule_category: '', target_volume_l: null, tasks_total: 0, tasks_done: 0
  }, extra || {});
}

function makeFakeChart() {
  function FakeChart(canvas, config) {
    this.canvas = canvas;
    this.config = config;
    this.destroyed = false;
    FakeChart.instances.push(this);
  }
  FakeChart.instances = [];
  FakeChart.prototype.destroy = function () { this.destroyed = true; };
  FakeChart.prototype.resize = function () {};
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
var loadSeq = 5000;
var cardCalls;

function setUrl(hash) { window.history.replaceState(null, '', '/brewpad.html?dash=v2' + (hash || '')); }

function mountDash(dash) {
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var d = Object.assign({
    asOf: ASOF, batches: [], staffBatchIds: [], taskRows: [], readings: [], batchMeta: []
  }, dash || {});
  loadSeq++;
  bp._setStateForTest({
    _allBatchesData: d.batches,
    _dashLoadTime: loadSeq,
    _dashData: d,
    _dashSummary: {},
    _dashWineSkuLookup: {},
    _upcomingTasks: [],
    _upcomingLoaded: true
  });
}

async function renderV2(dash, hash) {
  mountDash(dash);
  setUrl(hash ? '#' + hash : '');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flush();
}

function mockCards(opts) {
  var o = opts || {};
  cardCalls = [];
  global.fetch.mockImplementation(function (url, init) {
    var u = String(url);
    if (u.indexOf('/api/admin/dashboard-cards') !== -1) {
      cardCalls.push({ url: u, init: init });
      if (o.reject) return Promise.reject(new Error('down'));
      if (o.pending) {
        return new Promise(function (resolve) {
          o.pending.resolve = function (body) { resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } }); };
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(o.body || { ok: true, cards: [], canning: CANNING }); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
  });
}

function slot() { return document.getElementById('bp-dash-v2-bc'); }

function liveBc() {
  return Fake.instances.filter(function (c) { return !c.destroyed && c.canvas && c.canvas.hasAttribute && c.canvas.hasAttribute('data-bc-canvas'); });
}

function dashFixture() {
  return {
    batches: [lean('B1', 'beer'), lean('C1', 'cider'), lean('W1', 'wine')],
    batchMeta: [
      { batch_id: 'B1', recipe_name: 'Czech Lager', recipe_style: 'Czech Lager', og: 12, target_fg: 3.5, planned_days: 14 },
      { batch_id: 'C1', recipe_name: 'Dry Cider' }
    ],
    taskRows: [
      { batch_id: 'B1', task_id: 't1', title: 'Lower to 10°C', due_date: dd(3), completed: false },
      { batch_id: 'C1', task_id: 't2', title: 'Rack', due_date: dd(5), completed: false }
    ],
    readings: [
      { batch_id: 'B1', reading_at: dd(-5) + 'T10:00:00Z', reading_day: dd(-5), degrees_plato: 9, temperature: 18, ph: 4.5 },
      { batch_id: 'B1', reading_at: dd(-1) + 'T10:00:00Z', reading_day: dd(-1), degrees_plato: 6.4, temperature: 18, ph: 4.4 }
    ]
  };
}

var CARDS_BODY = {
  ok: true,
  cards: [{ batch_id: 'B1', abv: 4.8, ibu: 32 }, { batch_id: 'C1', abv: 5.1, juice: 'Apple', yeast: 'Cider yeast' }],
  canning: CANNING
};

beforeEach(function () {
  window.localStorage.clear();
  var exp = bp._dashV2FrameForTest.expanded;
  Object.keys(exp).forEach(function (k) { delete exp[k]; });
  Fake = makeFakeChart();
  window.Chart = Fake;
  Array.prototype.forEach.call(document.head.querySelectorAll('script'), function (s) { s.parentNode.removeChild(s); });
  mockCards({ body: CARDS_BODY });
});

afterEach(function () {
  bp._clearDashDrillForTest();
  delete window.Chart;
});

describe('Beer & cider widget', function () {
  test('one cards request per load, with credentials; facts fill in after it resolves', async function () {
    var pending = {};
    mockCards({ pending: pending });
    await renderV2(dashFixture());
    await settleAll();
    expect(cardCalls).toHaveLength(1);
    expect(cardCalls[0].init.credentials).toBe('include');
    expect(slot().querySelectorAll('article.bp-bc-card')).toHaveLength(2);
    expect(slot().textContent).not.toContain('Output');
    expect(slot().textContent).not.toContain('4.8%');
    pending.resolve(CARDS_BODY);
    await settleAll();
    expect(cardCalls).toHaveLength(1);
    expect(slot().textContent).toContain('4.8%');
    expect(slot().textContent).toContain('≈ 25 L packaged · ≈ 52 × 473 mL or 70 × 355 mL');
    expect(slot().textContent).toContain('Apple');
  });

  test('fetch failure still renders the cards without facts or error text', async function () {
    mockCards({ reject: true });
    await renderV2(dashFixture());
    await settleAll();
    var s = slot();
    expect(s.querySelectorAll('article.bp-bc-card')).toHaveLength(2);
    expect(s.textContent).toContain('Latest');
    expect(s.textContent).toContain('Next');
    expect(s.textContent.toLowerCase()).not.toContain('error');
    expect(s.textContent).not.toContain('Output');
  });

  test('card markup, temp pill and section note', async function () {
    await renderV2(dashFixture());
    await settleAll();
    var s = slot();
    var beer = s.querySelector('article.bp-bc-card--beer');
    var cider = s.querySelector('article.bp-bc-card--cider');
    expect(beer).not.toBeNull();
    expect(cider).not.toBeNull();
    var head = beer.querySelector('button.bp-bc-head');
    expect(head.getAttribute('data-dash-row')).toMatch(/^bc:\d+$/);
    expect(head.querySelector('.bp-badge').textContent).toBe('Beer');
    expect(cider.querySelector('.bp-badge').textContent).toBe('Cider');
    expect(beer.querySelector('.bp-bc-temp').textContent).toContain('Temp step');
    expect(beer.querySelector('.bp-bc-temp').textContent).toContain('Lower to 10°C');
    expect(cider.querySelector('.bp-bc-temp')).toBeNull();
    expect(s.textContent).toContain('Czech Lager');
    expect(s.textContent.split('Packaged amounts are estimates from the standard batch size.').length).toBe(2);
  });

  test('empty section shows the empty line and no note', async function () {
    var f = dashFixture();
    f.batches = [lean('W1', 'wine')];
    await renderV2(f);
    await settleAll();
    expect(slot().querySelector('.bp-empty').textContent).toBe('No active beer or cider batches');
    expect(slot().textContent).not.toContain('Packaged amounts');
    await renderV2(f, 'type=beer');
    await settleAll();
    expect(slot().querySelector('.bp-empty').textContent).toBe('No active beer batches');
  });

  test('six cards then Show all N', async function () {
    var f = dashFixture();
    f.batches = [];
    for (var i = 0; i < 8; i++) f.batches.push(lean('B' + (10 + i), 'beer'));
    await renderV2(f);
    await settleAll();
    expect(slot().querySelectorAll('article.bp-bc-card')).toHaveLength(6);
    var btn = slot().querySelector('[data-dash-showall="bc:cards"]');
    expect(btn.textContent).toBe('Show all 8');
    btn.click();
    await flush();
    expect(slot().querySelectorAll('article.bp-bc-card')).toHaveLength(8);
  });

  test('wine type hides the section and leaves no bc charts', async function () {
    await renderV2(dashFixture());
    await settleAll();
    slot().querySelector('[data-bc-curve="B1"]').click();
    await flush();
    expect(liveBc()).toHaveLength(1);
    await renderV2(dashFixture(), 'type=wine');
    await settleAll();
    expect(slot().querySelector('article')).toBeNull();
    expect(liveBc()).toHaveLength(0);
  });

  test('XSS: recipe name renders as text', async function () {
    var f = dashFixture();
    f.batchMeta[0].recipe_name = '<img src=x onerror=1>';
    await renderV2(f);
    await settleAll();
    expect(slot().querySelector('img')).toBeNull();
    expect(slot().textContent).toContain('<img src=x onerror=1>');
  });
});

describe('Beer & cider curves', function () {
  test('button only with readings; toggle creates and destroys one chart keyed bc:<id>', async function () {
    await renderV2(dashFixture());
    await settleAll();
    expect(slot().querySelector('[data-bc-curve="C1"]')).toBeNull();
    var btn = slot().querySelector('[data-bc-curve="B1"]');
    expect(btn.textContent).toBe('Show readings curve');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    await flush();
    var live = liveBc();
    expect(live).toHaveLength(1);
    btn = slot().querySelector('[data-bc-curve="B1"]');
    expect(btn.textContent).toBe('Hide readings curve');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(live[0].config.data.datasets.some(function (x) { return x._key === 'expected'; })).toBe(true);
    btn.click();
    await flush();
    expect(liveBc()).toHaveLength(0);
    expect(live[0].destroyed).toBe(true);
  });

  test('a re-render destroys every bc chart before drawing again; Floor chart untouched', async function () {
    var f = dashFixture();
    f.batches.push(lean('B2', 'beer'));
    f.readings.push({ batch_id: 'B2', reading_at: dd(-1) + 'T10:00:00Z', reading_day: dd(-1), degrees_plato: 7 });
    await renderV2(f);
    await settleAll();
    slot().querySelector('[data-bc-curve="B1"]').click();
    await flush();
    slot().querySelector('[data-bc-curve="B2"]').click();
    await flush();
    var first = liveBc();
    expect(first).toHaveLength(2);
    var floor = Fake.instances.filter(function (c) { return !c.destroyed && !c.canvas.hasAttribute('data-bc-canvas'); });
    slot().querySelector('[data-bc-view="B1:table"]').click();
    await flush();
    expect(first[0].destroyed).toBe(true);
    expect(first[1].destroyed).toBe(true);
    expect(liveBc()).toHaveLength(1);
    floor.forEach(function (c) { expect(c.destroyed).toBe(false); });
  });

  test('no expected curve note without OG or target FG', async function () {
    var f = dashFixture();
    f.batchMeta[0] = { batch_id: 'B1', recipe_name: 'Czech Lager' };
    await renderV2(f);
    await settleAll();
    slot().querySelector('[data-bc-curve="B1"]').click();
    await flush();
    expect(slot().textContent).toContain('No expected curve: this recipe has no OG or target FG.');
    expect(liveBc()[0].config.data.datasets.some(function (x) { return x._key === 'expected'; })).toBe(false);
  });

  test('per-card Table view shows the readings table', async function () {
    await renderV2(dashFixture());
    await settleAll();
    slot().querySelector('[data-bc-curve="B1"]').click();
    await flush();
    slot().querySelector('[data-bc-view="B1:table"]').click();
    await flush();
    expect(liveBc()).toHaveLength(0);
    expect(slot().querySelectorAll('table tbody tr')).toHaveLength(2);
  });
});

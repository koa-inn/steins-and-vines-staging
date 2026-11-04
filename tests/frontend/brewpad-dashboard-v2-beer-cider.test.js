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

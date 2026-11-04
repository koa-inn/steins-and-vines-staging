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

describe('dashTodayTaskRows', function () {
  test('splits open tasks into overdue (ascending) and today; excludes done and undated', function () {
    var tr = [
      task('A', 'late2', '2026-11-01'),
      task('A', 'late1', '2026-10-30'),
      task('A', 'now', '2026-11-03'),
      task('A', 'future', '2026-11-04'),
      task('A', 'undated', null),
      task('A', 'done1', '2026-11-03', { completed: true }),
      task('A', 'done2', '2026-10-01', { completed: 'TRUE' }),
      task('A', 'done3', '2026-10-01', { completed: '1' })
    ];
    var r = bp.dashTodayTaskRows(tr, '2026-11-03');
    expect(r.overdue.map(function (t) { return t.title; })).toEqual(['late1', 'late2']);
    expect(r.today.map(function (t) { return t.title; })).toEqual(['now']);
  });
});

describe('Today widgets (v2)', function () {
  test('Vancouver day is used, not UTC (10:30 pm PT on the 3rd is already the 4th in UTC)', async function () {
    var RealDate = Date;
    var fixed = new RealDate('2026-11-04T06:30:00Z').getTime();
    function FakeDate() {
      var a = Array.prototype.slice.call(arguments);
      if (!a.length) return new RealDate(fixed);
      return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = function () { return fixed; };
    FakeDate.UTC = RealDate.UTC;
    FakeDate.parse = RealDate.parse;
    global.Date = FakeDate;
    try {
      mount({
        extra: { asOf: { today: '2026-11-03', year: 2026, tz: 'America/Vancouver' } },
        tasks: [task('W1', 'Rack it', '2026-11-03'), task('W1', 'Tomorrow thing', '2026-11-04')]
      });
      await renderV2('');
      var html = document.getElementById('bp-dash-v2-today-tasks').innerHTML;
      expect(html).toContain('Rack it');
      expect(html).not.toContain('Tomorrow thing');
      expect(html).not.toContain('bp-task-flag--overdue');
    } finally {
      global.Date = RealDate;
    }
  });

  test('t1: overdue first with Overdue flag, then today; 5 rows then Show all', async function () {
    var tr = [];
    for (var i = 0; i < 4; i++) tr.push(task('W1', 'today' + i, d(0)));
    tr.push(task('W1', 'late-a', d(-2)));
    tr.push(task('W1', 'late-b', d(-1)));
    tr.push(task('W1', 'today4', d(0)));
    mount({ tasks: tr });
    await renderV2('');
    var slot = document.getElementById('bp-dash-v2-today-tasks');
    var rows5 = slot.querySelectorAll('.bp-task-row');
    expect(rows5.length).toBe(5);
    expect(rows5[0].className).toContain('bp-task-row--overdue');
    expect(rows5[0].textContent).toContain('Overdue');
    expect(rows5[1].className).toContain('bp-task-row--overdue');
    expect(rows5[2].className).not.toContain('bp-task-row--overdue');
    var btn = slot.querySelector('[data-dash-showall="t1:tasks"]');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('Show all 7');
    btn.click();
    expect(document.querySelectorAll('#bp-dash-v2-today-tasks .bp-task-row').length).toBe(7);
    expect(document.querySelector('#bp-dash-v2-today-tasks [data-dash-showall]').getAttribute('aria-expanded')).toBe('true');
  });

  test('t1 empty and not-loaded copy', async function () {
    mount({ tasks: [] });
    await renderV2('');
    expect(document.getElementById('bp-dash-v2-today-tasks').textContent).toContain('Nothing due today.');
    mount({ tasks: [], loaded: false });
    await renderV2('');
    expect(document.getElementById('bp-dash-v2-today-tasks').textContent)
      .toContain('Not available yet. Reopen the Dashboard tab to refresh.');
  });

  test('classic and v2 render the same row HTML for the same task', async function () {
    var t = task('W1', 'Same row', d(0));
    mount({ tasks: [t] });
    await renderV2('');
    var v2Row = document.querySelector('#bp-dash-v2-today-tasks .bp-task-row');
    expect(v2Row.outerHTML).toBe(bp.dashTodayTaskRowHtml(t, false));
  });

  test('t2: title counts unique batches; Send Invite only with email; 5 then Show all', async function () {
    var rtb = [];
    for (var i = 0; i < 6; i++) {
      rtb.push({ batch_id: 'R' + i, product_name: 'Prod ' + i, customer_name: 'Cust ' + i, vessel_id: 'V' + i,
        shelf_id: '', bottling_due: i === 0 ? d(-1) : (i === 1 ? '' : d(1)), overdue: i === 0, has_email: i === 2 });
    }
    rtb.push(rtb[0]);
    mount({ summary: { readyToBottle: rtb } });
    await renderV2('');
    var slot = document.getElementById('bp-dash-v2-rtb');
    expect(slot.querySelector('.bp-widget-title').textContent).toBe('Ready to bottle (6)');
    expect(slot.querySelectorAll('.bp-task-row').length).toBe(5);
    expect(slot.querySelector('[data-dash-showall="t2:rtb"]').textContent).toBe('Show all 7');
    expect(slot.textContent).toContain('Overdue');
    expect(slot.textContent).toContain('Bottling date TBD');
    expect(slot.querySelectorAll('.bp-rtb-invite-btn').length).toBe(1);
    expect(slot.querySelector('.bp-batch-chip').getAttribute('data-batch-id')).toBe('R0');
  });

  test('t2 empty copy', async function () {
    mount({ summary: { readyToBottle: [] } });
    await renderV2('');
    expect(document.getElementById('bp-dash-v2-rtb').textContent).toContain('No batches are ready to bottle.');
  });

  test('t1 and t2 ignore the global filters', async function () {
    var tr = [task('W1', 'Rack it', d(0)), task('B1', 'Late', d(-1))];
    var rtb = [{ batch_id: 'R1', product_name: 'P', has_email: true, bottling_due: d(1) }];
    mount({ tasks: tr, summary: { readyToBottle: rtb } });
    await renderV2('');
    var base1 = document.getElementById('bp-dash-v2-today-tasks').innerHTML;
    var base2 = document.getElementById('bp-dash-v2-rtb').innerHTML;
    var hashes = ['type=wine', 'type=beer', 'period=ytd', 'period=all', 'source=online', 'staff=1'];
    for (var i = 0; i < hashes.length; i++) {
      await go(hashes[i]);
      expect(document.getElementById('bp-dash-v2-today-tasks').innerHTML).toBe(base1);
      expect(document.getElementById('bp-dash-v2-rtb').innerHTML).toBe(base2);
    }
  });

  test('XSS: hostile task title and product name never become elements', async function () {
    mount({
      tasks: [task('W1', '<img src=x onerror=alert(1)>', d(0))],
      summary: { readyToBottle: [{ batch_id: 'R1', product_name: '<img src=x onerror=alert(2)>', customer_name: '<b>x</b>' }] }
    });
    await renderV2('');
    expect(document.querySelectorAll('#bp-dash-v2-today-tasks img, #bp-dash-v2-rtb img, #bp-dash-v2-rtb b').length).toBe(0);
  });

  test('no inline style attribute in t1/t2 markup', async function () {
    mount({
      tasks: [task('W1', 'A', d(0)), task('W1', 'B', d(-1))],
      summary: { readyToBottle: [{ batch_id: 'R1', product_name: 'P', overdue: true, bottling_due: d(-1), has_email: true }] }
    });
    await renderV2('');
    expect(document.querySelectorAll('#bp-dash-v2-today-tasks [style], #bp-dash-v2-rtb [style]').length).toBe(0);
  });

  test('tick, chip and invite events bubble to #bp-dashboard-inner (existing delegated handlers)', async function () {
    mount({
      tasks: [task('W1', 'Tick me', d(0))],
      summary: { readyToBottle: [{ batch_id: 'R1', product_name: 'P', has_email: true, bottling_due: d(1) }] }
    });
    await renderV2('');
    var inner = document.getElementById('bp-dashboard-inner');
    var seen = [];
    inner.addEventListener('change', function (e) { seen.push(['change', e.target.getAttribute('data-task-id')]); });
    inner.addEventListener('click', function (e) {
      var c = e.target.closest('.bp-batch-chip, .bp-rtb-invite-btn');
      if (c) seen.push(['click', c.className.split(' ')[0]]);
    });
    var cb = document.querySelector('#bp-dash-v2-today-tasks input[type="checkbox"]');
    expect(cb.getAttribute('data-task-id')).toBeTruthy();
    cb.dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('#bp-dash-v2-today-tasks .bp-batch-chip').click();
    document.querySelector('#bp-dash-v2-rtb .bp-rtb-invite-btn').click();
    expect(seen).toEqual([['change', cb.getAttribute('data-task-id')], ['click', 'bp-batch-chip'], ['click', 'bp-rtb-invite-btn']]);
  });
});

'use strict';

// Phase 97-08: packaging calendar (pure model + Today-section widget t3).

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

describe('dash calendar labels', function () {
  var today = '2026-11-03';

  test('day labels', function () {
    expect(bp.dashCalDayLabel('2026-11-03', today)).toBe('Today');
    expect(bp.dashCalDayLabel('2026-11-04', today)).toBe('Tomorrow');
    expect(bp.dashCalDayLabel('2026-11-05', today)).toBe('Thu 5 Nov');
    expect(bp.dashCalDayLabel('2026-11-10', today)).toBe('Tue 10 Nov');
  });

  test('time labels are Vancouver time', function () {
    expect(bp.dashCalTimeLabel('2026-07-03T21:30:00.000Z')).toBe('2:30 pm');
    expect(bp.dashCalTimeLabel('2026-07-06T04:00:00.000Z')).toBe('9:00 pm');
    expect(bp.dashCalTimeLabel('nonsense')).toBe('');
  });
});

describe('buildPackagingCalendar', function () {
  var today = '2026-11-03';
  var typeById = { W1: 'wine', B1: 'beer', C1: 'cider' };

  function pt(batch, due, extra) {
    return Object.assign({
      task_id: 'T-' + batch, batch_id: batch, due_date: due, completed: false, is_packaging: true,
      customer_name: 'Cust ' + batch
    }, extra || {});
  }
  function bk(day, start, batch, extra) {
    return Object.assign({
      uid: 'u-' + day + start, start: start, end: start, day: day, kind: 'bottling',
      batch_id: batch, customer_name: 'Booked ' + (batch || 'nobody')
    }, extra || {});
  }
  var OK = function (bookings) { return { state: 'ok', bookings: bookings }; };

  test('open task without a booking reads not booked yet', function () {
    var m = bp.buildPackagingCalendar([pt('W1', '2026-11-05')], OK([]), typeById, today);
    expect(m.days).toHaveLength(1);
    expect(m.days[0].label).toBe('Thu 5 Nov');
    expect(m.days[0].entries[0]).toMatchObject({ kind: 'Bottling', status: 'not booked yet', time: 'All day', batch_id: 'W1' });
    expect(m.total).toBe(1);
  });

  test('a matched booking replaces the task for that batch across the window', function () {
    var m = bp.buildPackagingCalendar(
      [pt('W1', '2026-11-05')],
      OK([bk('2026-11-06', '2026-11-06T20:00:00.000Z', 'W1')]), typeById, today);
    expect(m.total).toBe(1);
    expect(m.days[0].label).toBe('Fri 6 Nov');
    expect(m.days[0].entries[0]).toMatchObject({ source: 'booking', status: '', batch_id: 'W1' });
  });

  test('beer is Canning; unmatched bookings keep their own kind and have no batch', function () {
    var m = bp.buildPackagingCalendar(
      [pt('B1', '2026-11-04')],
      OK([bk('2026-11-05', '2026-11-05T20:00:00.000Z', null, { kind: 'canning', customer_name: 'Pat' })]),
      typeById, today);
    expect(m.days[0].entries[0]).toMatchObject({ kind: 'Canning', batch_id: 'B1' });
    expect(m.days[1].entries[0]).toMatchObject({ kind: 'Canning', status: 'no batch matched', batch_id: null, customer: 'Pat' });
  });

  test('groups by the server Vancouver day field (9 pm PT stays on the 5th)', function () {
    var m = bp.buildPackagingCalendar([], OK([bk('2026-11-05', '2026-07-06T04:00:00.000Z', 'W1')]), typeById, today);
    expect(m.days[0].label).toBe('Thu 5 Nov');
    expect(m.days[0].entries[0].time).toBe('9:00 pm');
  });

  test('window and filters: before today, after today+13, completed, non packaging, undated', function () {
    var tasks = [
      pt('W1', '2026-11-02'),
      pt('W1', '2026-11-17'),
      pt('B1', '2026-11-04', { completed: true }),
      pt('C1', '2026-11-04', { is_packaging: false }),
      pt('W1', '', { task_id: 'u1' }),
      pt('C1', null, { task_id: 'u2' }),
      pt('C1', '2026-11-16')
    ];
    var m = bp.buildPackagingCalendar(tasks, OK([]), typeById, today);
    expect(m.total).toBe(1);
    expect(m.days[0].label).toBe('Mon 16 Nov');
    expect(m.undatedCount).toBe(2);
  });

  test('order within a day: matched bookings, unmatched bookings, tasks; days ascending', function () {
    var m = bp.buildPackagingCalendar(
      [pt('C1', '2026-11-03'), pt('W1', '2026-11-03'), pt('B1', '2026-11-04')],
      OK([
        bk('2026-11-03', '2026-11-03T22:00:00.000Z', null, { customer_name: 'Stranger' }),
        bk('2026-11-03', '2026-11-03T23:00:00.000Z', 'X1', { customer_name: 'Late' }),
        bk('2026-11-03', '2026-11-03T18:00:00.000Z', 'X2', { customer_name: 'Early' })
      ]), typeById, today);
    expect(m.days.map(function (d) { return d.label; })).toEqual(['Today', 'Tomorrow']);
    expect(m.days[0].entries.map(function (e) { return e.customer || e.batch_id; })).toEqual(['Early', 'Late', 'Stranger', 'Cust C1', 'Cust W1']);
  });

  test('loading and failed bookings never claim not booked yet', function () {
    var tasks = [pt('W1', '2026-11-05')];
    var l = bp.buildPackagingCalendar(tasks, { state: 'loading', bookings: [] }, typeById, today);
    expect(l.days[0].entries[0].status).toBe('');
    expect(l.note).toBe('Checking bookings…');
    var f = bp.buildPackagingCalendar(tasks, { state: 'failed', bookings: [] }, typeById, today);
    expect(f.days[0].entries[0].status).toBe('');
    expect(f.note).toBe('Bookings could not be loaded. Showing BrewPad tasks only.');
    expect(bp.buildPackagingCalendar(tasks, OK([]), typeById, today).note).toBe('');
  });
});

// ---------------------------------------------------------------- widget (DOM)

var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var YEAR = +TODAY.slice(0, 4);
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };

function d(n) {
  var p = TODAY.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * 86400000).toISOString().slice(0, 10);
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

function setUrl(hash) {
  window.history.replaceState(null, '', '/brewpad.html?dash=v2' + (hash || ''));
}

var loadSeq = 1000;
function mount() {
  document.body.innerHTML =
    '<div><button type="button" id="bp-dash-switch" hidden></button></div>' +
    '<div id="bp-dashboard-inner"></div>' +
    '<div id="bp-panel-dashboard"></div>' +
    '<div id="bp-panel-batches"><div id="bp-batch-list-pane"></div></div>' +
    '<div id="bp-batch-detail-pane"></div><div id="bp-toast-container"></div>';
  var list = [lean('W1', 'wine'), lean('B1', 'beer', { source: 'manual' }), lean('C1', 'cider')];
  loadSeq++;
  bp._setStateForTest({
    _allBatchesData: list,
    _dashLoadTime: loadSeq,
    _dashData: { asOf: ASOF, batches: list, staffBatchIds: [] },
    _dashSummary: {},
    _dashWineSkuLookup: {},
    _upcomingTasks: [],
    _upcomingLoaded: true
  });
}

async function renderV2(hash) {
  setUrl(hash ? '#' + hash : '');
  bp._initDashV2FlagForTest();
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  bp._renderDashboardForTest();
  await flush();
}

function calTask(batch, due, extra) {
  return Object.assign({
    task_id: 'T-' + batch + due, batch_id: batch, due_date: due, completed: false, is_packaging: true,
    customer_name: 'Cust ' + batch, title: 'Bottle'
  }, extra || {});
}

function mockNet(opts) {
  var o = opts || {};
  var calls = { tasks: [], bookings: [] };
  var pendingBookings = null;
  global.fetch.mockImplementation(function (url, init) {
    var u = String(url);
    if (u.indexOf('/api/admin/packaging-bookings') !== -1) {
      calls.bookings.push({ url: u, init: init });
      if (o.bookingsPending) {
        return new Promise(function (resolve) { pendingBookings = resolve; });
      }
      if (o.bookingsReject) return Promise.reject(new Error('down'));
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(o.bookings || { ok: true, bookings: [] }); } });
    }
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
    if (body.action === 'get_tasks_calendar') {
      calls.tasks.push(body);
      if (o.tasksFail) return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.resolve({ ok: false, error: 'x' }); } });
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: { tasks: o.tasks || [] } }); } });
    }
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
  });
  calls.resolveBookings = function (body) {
    pendingBookings({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  return calls;
}

function slot() { return document.getElementById('bp-dash-v2-packcal'); }
async function settleAll() { for (var i = 0; i < 6; i++) await flush(); }

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

describe('packaging calendar widget', function () {
  test('one tasks request and one bookings request per load; rerenders reuse them', async function () {
    var net = mockNet({ tasks: [calTask('W1', d(2))] });
    await renderV2('');
    await settleAll();
    expect(net.tasks).toHaveLength(1);
    expect(net.tasks[0].start_date).toBe(TODAY);
    expect(net.tasks[0].end_date).toBe(d(13));
    expect(net.bookings).toHaveLength(1);
    expect(net.bookings[0].init.credentials).toBe('include');
    await go('type=wine');
    await renderV2('');
    await settleAll();
    expect(net.tasks).toHaveLength(1);
    expect(net.bookings).toHaveLength(1);
    bp._setStateForTest({ _dashLoadTime: loadSeq + 500 });
    await renderV2('');
    await settleAll();
    expect(net.tasks).toHaveLength(2);
    expect(net.bookings).toHaveLength(2);
  });

  async function go(hash) {
    setUrl('#' + hash);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
  }

  test('while bookings are pending, tasks show with a checking note', async function () {
    var net = mockNet({ tasks: [calTask('W1', d(2))], bookingsPending: true });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('Checking bookings…');
    expect(slot().querySelectorAll('li.bp-cal-entry')).toHaveLength(1);
    expect(slot().textContent).not.toContain('not booked yet');
    net.resolveBookings({ ok: true, bookings: [] });
    await settleAll();
    expect(slot().textContent).not.toContain('Checking bookings');
    expect(slot().textContent).toContain('not booked yet');
    expect(slot().querySelector('li.bp-cal-entry--unbooked')).not.toBeNull();
  });

  test.each([
    ['ok false', { bookings: { ok: false, reason: 'unavailable' } }],
    ['rejected', { bookingsReject: true }]
  ])('bookings failure (%s) is soft', async function (name, opts) {
    mockNet(Object.assign({ tasks: [calTask('W1', d(2))] }, opts));
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('Bookings could not be loaded. Showing BrewPad tasks only.');
    expect(slot().textContent).not.toContain('not booked yet');
    expect(slot().querySelectorAll('li.bp-cal-entry')).toHaveLength(1);
  });

  // WR-03: a slow Cal.com must not leave "Checking bookings…" up indefinitely.
  test('bookings request gives up after 10 s and shows the soft-fail note', async function () {
    var spy = jest.spyOn(global, 'setTimeout');
    var net = mockNet({ tasks: [calTask('W1', d(2))], bookingsPending: true });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('Checking bookings…');
    var init = net.bookings[0].init;
    if (typeof AbortController !== 'undefined') expect(init.signal).toBeDefined();
    var timer = spy.mock.calls.filter(function (c) { return c[1] === 10000; })[0];
    spy.mockRestore();
    expect(timer).toBeDefined();
    timer[0]();
    await settleAll();
    expect(slot().textContent).not.toContain('Checking bookings');
    expect(slot().textContent).toContain('Bookings could not be loaded. Showing BrewPad tasks only.');
    expect(slot().textContent).not.toContain('not booked yet');
    if (init.signal) expect(init.signal.aborted).toBe(true);
    net.resolveBookings({ ok: true, bookings: [] });
    await settleAll();
    expect(slot().textContent).toContain('Bookings could not be loaded.');
    expect(slot().textContent).not.toContain('not booked yet');
  });

  test('semantic markup, kind chips and drill buttons', async function () {
    var tasks = [calTask('W1', d(2)), calTask('B1', d(2))];
    mockNet({
      tasks: tasks,
      bookings: { ok: true, bookings: [
        { uid: 'a', start: new Date(Date.now() + 86400000 * 3).toISOString(), end: '', day: d(3), kind: 'bottling', batch_id: 'C1', customer_name: 'Cider Person' },
        { uid: 'b', start: new Date(Date.now() + 86400000 * 3).toISOString(), end: '', day: d(3), kind: 'canning', batch_id: null, customer_name: 'Mystery' }
      ] }
    });
    await renderV2('');
    await settleAll();
    var s = slot();
    expect(s.querySelector('.bp-cal > .bp-cal-day > h4.bp-cal-day-head')).not.toBeNull();
    expect(s.querySelector('.bp-cal-day > ul.bp-cal-list > li.bp-cal-entry')).not.toBeNull();
    var chips = Array.prototype.map.call(s.querySelectorAll('.bp-badge'), function (x) { return x.textContent; });
    expect(chips.sort()).toEqual(['Bottling', 'Bottling', 'Canning', 'Canning']);
    var btns = s.querySelectorAll('button.bp-table-link');
    expect(btns.length).toBe(3);
    expect(btns[0].getAttribute('data-dash-row')).toMatch(/^t3:\d+$/);
    var mystery = Array.prototype.filter.call(s.querySelectorAll('li.bp-cal-entry'), function (li) { return li.textContent.indexOf('Mystery') !== -1; })[0];
    expect(mystery.textContent).toContain('no batch matched');
    expect(mystery.querySelector('button')).toBeNull();
    expect(s.querySelector('.bp-widget-title').textContent).toBe('Packaging calendar');
    expect(s.querySelector('.bp-widget-sub').textContent).toBe('Next 14 days · wine and cider bottling, beer canning');
  });

  test('seven entries then Show all N', async function () {
    var tasks = [];
    for (var i = 0; i < 9; i++) tasks.push(calTask('W1', d(i), { task_id: 'k' + i }));
    mockNet({ tasks: tasks });
    await renderV2('');
    await settleAll();
    expect(slot().querySelectorAll('li.bp-cal-entry')).toHaveLength(7);
    var btn = slot().querySelector('[data-dash-showall="t3:cal"]');
    expect(btn.textContent).toBe('Show all 9');
    btn.click();
    await flush();
    expect(slot().querySelectorAll('li.bp-cal-entry')).toHaveLength(9);
  });

  test('empty window and unavailable states', async function () {
    mockNet({ tasks: [] });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('Nothing booked or due in the next 14 days.');
  });

  test('tasks failed and bookings not ok reads not available', async function () {
    mockNet({ tasksFail: true, bookingsReject: true });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('Not available yet. Reopen the Dashboard tab to refresh.');
  });

  test('undated note only when there are undated packaging tasks', async function () {
    mockNet({ tasks: [calTask('W1', d(1)), calTask('C1', '', { task_id: 'u1' }), calTask('B1', null, { task_id: 'u2' })] });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).toContain('2 packaging tasks have no date. See Ready to bottle.');
    mount();
    mockNet({ tasks: [calTask('W1', d(1))] });
    await renderV2('');
    await settleAll();
    expect(slot().textContent).not.toContain('have no date');
  });

  test('filters are ignored and copy stays neutral', async function () {
    mockNet({ tasks: [calTask('W1', d(1)), calTask('B1', d(2))] });
    await renderV2('');
    await settleAll();
    var all = slot().innerHTML;
    await go('type=wine');
    await settleAll();
    expect(slot().innerHTML).toBe(all);
    expect(slot().textContent).not.toMatch(/overdue|missing|conflict|double-booked|error/i);
  });

  test('customer names are escaped', async function () {
    mockNet({
      tasks: [],
      bookings: { ok: true, bookings: [{ uid: 'x', start: new Date().toISOString(), end: '', day: TODAY, kind: 'bottling', batch_id: null, customer_name: '<img src=x onerror=1>' }] }
    });
    await renderV2('');
    await settleAll();
    expect(slot().querySelector('img')).toBeNull();
    expect(slot().textContent).toContain('<img src=x onerror=1>');
  });
});

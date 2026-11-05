'use strict';

// Phase 98-03 (D-06): Overdue / Due today chips on the Tasks tab, Vancouver day.

global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: { tasks: [] } }); } });
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

var TODAY = '2026-11-05';
var seq = 0;
function task(due, extra) {
  seq++;
  return Object.assign({
    batch_id: 'B' + seq, task_id: 'T' + seq, title: 'Task ' + seq,
    due_date: due, completed: false, step_number: seq
  }, extra || {});
}

function mount(tasks, filter) {
  document.body.innerHTML = '<div id="bp-tasks-inner"></div>';
  bp._setStateForTest({
    _dashData: { asOf: { today: TODAY, year: 2026, tz: 'America/Vancouver' }, batches: [], staffBatchIds: [] },
    _upcomingTasks: tasks,
    _upcomingLoaded: true,
    _taskFilter: filter,
    _taskSearch: ''
  });
  bp._renderTasksForTest();
}

function rowCount() { return document.querySelectorAll('.bp-task-row').length; }
function headers() {
  return Array.prototype.map.call(document.querySelectorAll('.bp-task-group-header'), function (h) {
    return h.textContent.replace(/\s*\(\d+\)\s*$/, '');
  });
}

afterEach(function () {
  jest.useRealTimers();
  global.fetch.mockClear();
});

describe('Tasks tab urgency chips', function () {
  test('chip order and filter values', function () {
    mount([task('2026-11-01')], 'incomplete');
    var btns = document.querySelectorAll('.bp-task-filters .bp-filter-btn');
    expect(Array.prototype.map.call(btns, function (b) { return b.textContent; }))
      .toEqual(['To Do', 'Overdue', 'Due today', 'All', 'Transfers', 'Packaging']);
    expect(Array.prototype.map.call(btns, function (b) { return b.getAttribute('data-task-filter'); }))
      .toEqual(['incomplete', 'overdue', 'duetoday', 'all', 'transfer', 'packaging']);
  });

  test('overdue lists open dated-before-today tasks only and marks the chip active', function () {
    mount([
      task('2026-11-01'), task('2026-11-04'), task('2026-11-05'), task('2026-11-09'),
      task(''), task('2026-11-01', { completed: true })
    ], 'overdue');
    expect(rowCount()).toBe(2);
    expect(document.querySelector('.bp-filter-btn--active').getAttribute('data-task-filter')).toBe('overdue');
  });

  test('duetoday lists open tasks due exactly today', function () {
    mount([task('2026-11-04'), task('2026-11-05'), task('2026-11-05T10:00:00Z'), task('2026-11-06'), task(null)], 'duetoday');
    expect(rowCount()).toBe(2);
    expect(headers()).toEqual(['Today']);
  });

  test('counts equal the dashboard partition for a 70+ task fixture', function () {
    var list = [];
    var i;
    for (i = 0; i < 25; i++) list.push(task('2026-10-' + String(1 + (i % 28)).padStart(2, '0')));
    for (i = 0; i < 20; i++) list.push(task(TODAY));
    for (i = 0; i < 15; i++) list.push(task('2026-12-01'));
    for (i = 0; i < 6; i++) list.push(task(''));
    for (i = 0; i < 6; i++) list.push(task(TODAY, { completed: true }));
    for (i = 0; i < 4; i++) list.push(task('2026-10-02', { completed: true }));
    expect(list.length).toBeGreaterThan(70);
    var od = list.filter(function (t) { return !t.completed && t.due_date && t.due_date < TODAY; }).length;
    var dt = list.filter(function (t) { return !t.completed && t.due_date === TODAY; }).length;
    mount(list, 'overdue');
    expect(rowCount()).toBe(od);
    mount(list, 'duetoday');
    expect(rowCount()).toBe(dt);
  });

  test('23:30 Pacific (UTC already next day): due-today task is Today, not Overdue', function () {
    jest.useFakeTimers('modern');
    jest.setSystemTime(new Date('2026-11-06T07:30:00Z'));
    var t = task(TODAY);
    mount([t], 'duetoday');
    expect(rowCount()).toBe(1);
    expect(headers()).toEqual(['Today']);
    mount([t], 'overdue');
    expect(rowCount()).toBe(0);
  });

  test('empty copy', function () {
    mount([], 'overdue');
    expect(document.querySelector('.bp-empty').textContent).toBe('No overdue tasks.');
    mount([], 'duetoday');
    expect(document.querySelector('.bp-empty').textContent).toBe('No tasks due today.');
    mount([], 'incomplete');
    expect(document.querySelector('.bp-empty').textContent).toBe('No upcoming tasks — all caught up!');
  });

  test('loadTasks requests limit 200', async function () {
    mount([], 'incomplete');
    bp._loadTasksForTest();
    var call = global.fetch.mock.calls.filter(function (c) {
      return c[1] && String(c[1].body).indexOf('get_tasks_upcoming') !== -1;
    })[0];
    expect(call).toBeDefined();
    expect(JSON.parse(call[1].body).limit).toBe(200);
  });
});

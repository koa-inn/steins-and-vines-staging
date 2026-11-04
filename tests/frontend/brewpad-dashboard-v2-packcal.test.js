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
    expect(bp.dashCalTimeLabel('2026-11-03T22:30:00.000Z')).toBe('2:30 pm');
    expect(bp.dashCalTimeLabel('2026-11-06T05:00:00.000Z')).toBe('9:00 pm');
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
    var m = bp.buildPackagingCalendar([], OK([bk('2026-11-05', '2026-11-06T05:00:00.000Z', 'W1')]), typeById, today);
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

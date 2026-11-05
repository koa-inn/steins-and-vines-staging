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

// Phase 98-02: pure Needs attention model.
var bp = require('../../js/brewpad');

function base(over) {
  var o = {
    today: '2026-11-05',
    taskCounts: { overdue: 0, today: 0 },
    batches: [],
    batchMeta: [],
    staffIds: {},
    readyToBottle: [],
    inviteSentIds: [],
    localSent: {},
    waitlist: { state: 'ok', count: 0 }
  };
  for (var k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k]; }
  return o;
}
function keys(m) { return m.items.map(function (i) { return i.key; }); }
function find(m, k) { return m.items.filter(function (i) { return i.key === k; })[0]; }

describe('dashPastPlanDays', function () {
  test('grace edge: overrun 14 excluded, 15 included', function () {
    expect(bp.dashPastPlanDays('2026-11-05', '2026-09-01', 50)).toBe(15);
    expect(bp.dashPastPlanDays('2026-11-05', '2026-09-01', 51)).toBeNull();
  });
  test('D-11: bad planned_days never counted', function () {
    [null, undefined, 0, -3, 'x'].forEach(function (pd) {
      expect(bp.dashPastPlanDays('2026-11-05', '2026-01-01', pd)).toBeNull();
    });
  });
  test('missing start date', function () {
    expect(bp.dashPastPlanDays('2026-11-05', '', 5)).toBeNull();
    expect(bp.dashPastPlanDays('2026-11-05', null, 5)).toBeNull();
  });
});

describe('copy helpers', function () {
  test('note singular/plural', function () {
    expect(bp.dashPastPlanNote(1)).toBe('1 day past plan');
    expect(bp.dashPastPlanNote(15)).toBe('15 days past plan');
  });
  test('drill labels', function () {
    expect(bp.dashAttentionDrillLabel('past-schedule', 1)).toBe('Showing 1 batch past schedule.');
    expect(bp.dashAttentionDrillLabel('past-schedule', 6)).toBe('Showing 6 batches past schedule.');
    expect(bp.dashAttentionDrillLabel('invite', 1)).toBe('Showing 1 ready-to-bottle batch with no invite sent.');
    expect(bp.dashAttentionDrillLabel('invite', 3)).toBe('Showing 3 ready-to-bottle batches with no invite sent.');
    expect(bp.dashAttentionDrillLabel('other', 3)).toBe('');
  });
});

describe('buildDashAttentionModel', function () {
  function full() {
    return base({
      taskCounts: { overdue: 2, today: 3 },
      batches: [{ batch_id: 'B1', status: 'primary', start_date: '2026-09-01' }],
      batchMeta: [{ batch_id: 'B1', planned_days: 50 }],
      readyToBottle: [{ batch_id: 'R1', has_email: true }],
      waitlist: { state: 'ok', count: 4 }
    });
  }

  test('order and labels/tones', function () {
    var m = bp.buildDashAttentionModel(full());
    expect(keys(m)).toEqual(['overdue', 'today', 'past-schedule', 'invite', 'waitlist']);
    expect(find(m, 'overdue').label).toBe('Overdue');
    expect(find(m, 'overdue').tone).toBe('danger');
    expect(find(m, 'today').label).toBe('Due today');
    expect(find(m, 'today').tone).toBe('');
    expect(find(m, 'past-schedule').label).toBe('Past schedule');
    expect(find(m, 'past-schedule').tone).toBe('warn');
    expect(find(m, 'invite').label).toBe('Invite not sent');
    expect(find(m, 'waitlist').label).toBe('Waitlist waiting');
    expect(find(m, 'invite').aria).toBe('Ready-to-bottle batches with no invite sent, 1. Opens the Batches list.');
    expect(m.allClear).toBe(false);
  });

  test('zero counts absent', function () {
    var m = bp.buildDashAttentionModel(base({ taskCounts: { overdue: 0, today: 2 } }));
    expect(keys(m)).toEqual(['today']);
  });

  test('past schedule filters and ordering', function () {
    var m = bp.buildDashAttentionModel(base({
      batches: [
        { batch_id: 'A', status: 'primary', start_date: '2026-09-01' },
        { batch_id: 'B', status: 'complete', start_date: '2026-01-01' },
        { batch_id: 'C', status: 'bottled', start_date: '2026-01-01' },
        { batch_id: 'D', status: 'pending', start_date: '2026-01-01' },
        { batch_id: 'S', status: 'secondary', start_date: '2026-08-01' },
        { batch_id: 'N', status: 'primary', start_date: '2026-01-01' }
      ],
      batchMeta: [
        { batch_id: 'A', planned_days: 50 }, { batch_id: 'B', planned_days: 10 },
        { batch_id: 'C', planned_days: 10 }, { batch_id: 'D', planned_days: 10 },
        { batch_id: 'S', planned_days: 20 }
      ],
      staffIds: { S: true }
    }));
    var it = find(m, 'past-schedule');
    expect(it.ids).toEqual(['S', 'A']);
    expect(it.count).toBe(2);
    expect(it.notes.A).toBe(bp.dashPastPlanNote(15));
  });

  test('invite rules', function () {
    var m = bp.buildDashAttentionModel(base({
      readyToBottle: [
        { batch_id: 'R1', has_email: true }, { batch_id: 'R1', has_email: true },
        { batch_id: 'R2', has_email: false }, { batch_id: 'R3', has_email: true },
        { batch_id: 'R4', has_email: true }, { batch_id: 'R5', has_email: true },
        { batch_id: 'R6', has_email: true }
      ],
      staffIds: { R3: true },
      inviteSentIds: ['R4'],
      localSent: { R5: true }
    }));
    expect(find(m, 'invite').ids).toEqual(['R1', 'R6']);
  });

  test('unavailable sources', function () {
    var m = bp.buildDashAttentionModel(base({ inviteSentIds: undefined }));
    expect(find(m, 'invite')).toBeUndefined();
    expect(m.unavailable).toBeGreaterThanOrEqual(1);
    expect(m.allClear).toBe(false);
    m = bp.buildDashAttentionModel(base({ taskCounts: null }));
    expect(find(m, 'overdue')).toBeUndefined();
    expect(m.unavailable).toBeGreaterThanOrEqual(1);
    m = bp.buildDashAttentionModel(base({ batches: null }));
    expect(find(m, 'past-schedule')).toBeUndefined();
    expect(m.unavailable).toBeGreaterThanOrEqual(1);
  });

  test('waitlist states and allClear', function () {
    var m = bp.buildDashAttentionModel(base({ waitlist: { state: 'loading' } }));
    expect(m.pending).toBe(true);
    expect(m.allClear).toBe(false);
    m = bp.buildDashAttentionModel(base({ waitlist: { state: 'failed' } }));
    expect(find(m, 'waitlist')).toBeUndefined();
    expect(m.unavailable).toBeGreaterThanOrEqual(1);
    expect(m.allClear).toBe(false);
    m = bp.buildDashAttentionModel(base({}));
    expect(m.allClear).toBe(true);
    expect(m.pending).toBe(false);
  });

  test('noneAvailable only when all four unavailable', function () {
    var m = bp.buildDashAttentionModel(base({
      taskCounts: null, batches: null, readyToBottle: null, waitlist: { state: 'failed' }
    }));
    expect(m.noneAvailable).toBe(true);
    m = bp.buildDashAttentionModel(base({ taskCounts: null }));
    expect(m.noneAvailable).toBe(false);
  });

  test('banned copy', function () {
    var s = JSON.stringify(bp.buildDashAttentionModel(full())).toLowerCase();
    ['stale', 'conflict', 'unbilled', 'missing'].forEach(function (w) {
      expect(s.indexOf(w)).toBe(-1);
    });
  });
});

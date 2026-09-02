'use strict';

// ---------------------------------------------------------------------------
// Phase 78-03: pure waitlist helper coverage — ordering, queue positions, the
// one-way status cycle, filtering, sync normalization and category
// suppression. These are DOM-free, top-level functions lifted out of the
// brewpad.js IIFE specifically so they can be unit-tested (see
// brewpad-filter-derive.test.js for the harness this file copies verbatim).
// ---------------------------------------------------------------------------

global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

describe('nextWaitlistStatus — D-05 one-way progression', function () {
  test('advances waiting -> contacted', function () {
    expect(bp.nextWaitlistStatus('waiting')).toBe('contacted');
  });

  test('advances contacted -> booked', function () {
    expect(bp.nextWaitlistStatus('contacted')).toBe('booked');
  });

  test('booked has no next status', function () {
    expect(bp.nextWaitlistStatus('booked')).toBeNull();
  });

  test('removed has no next status', function () {
    expect(bp.nextWaitlistStatus('removed')).toBeNull();
  });

  test('an unrecognized status has no next status', function () {
    expect(bp.nextWaitlistStatus('bogus')).toBeNull();
  });

  test('undefined has no next status', function () {
    expect(bp.nextWaitlistStatus(undefined)).toBeNull();
  });

  // Regression test named for the wraparound hazard this deliberately avoids
  // (the batch-status handler this was modeled on DOES wrap via % length —
  // copying that here would silently reopen a booked customer's spot).
  test('REGRESSION: advancing from booked never wraps back to waiting', function () {
    var next = bp.nextWaitlistStatus('booked');
    expect(next).not.toBe('waiting');
    expect(next).toBeNull();
  });
});

describe('sortWaitlistRows — oldest signup first', function () {
  test('orders three shuffled ISO timestamps oldest-first', function () {
    var rows = [
      { id: 'c', signed_up_at: '2026-09-02T10:00:00.000Z' },
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['a', 'b', 'c']);
  });

  test('does not mutate its input array', function () {
    var rows = [
      { id: 'c', signed_up_at: '2026-09-02T10:00:00.000Z' },
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' }
    ];
    var snapshot = JSON.parse(JSON.stringify(rows));
    bp.sortWaitlistRows(rows);
    expect(rows).toEqual(snapshot);
  });

  test('places a row with an empty signed_up_at after every dated row', function () {
    var rows = [
      { id: 'undated', signed_up_at: '' },
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['a', 'b', 'undated']);
  });
});

describe('computeWaitlistQueuePositions — waiting-only rank', function () {
  test('ranks only waiting rows, null elsewhere', function () {
    var rows = [
      { status: 'waiting' },
      { status: 'booked' },
      { status: 'waiting' },
      { status: 'removed' },
      { status: 'waiting' }
    ];
    expect(bp.computeWaitlistQueuePositions(rows)).toEqual([1, null, 2, null, 3]);
  });
});

describe('filterWaitlistRows — status + search', function () {
  var rows = [
    { email: 'alice@example.com', status: 'waiting', mailerlite_synced: true },
    { email: 'bob@example.com', status: 'contacted', mailerlite_synced: false },
    { email: 'carol@example.com', status: 'booked', mailerlite_synced: true },
    { email: 'dave@example.com', status: 'booked', mailerlite_synced: false }
  ];

  test('notSynced returns only unsynced rows across mixed statuses', function () {
    var out = bp.filterWaitlistRows(rows, 'notSynced', '');
    expect(out.map(function (r) { return r.email; })).toEqual(['bob@example.com', 'dave@example.com']);
  });

  test('booked returns only booked rows', function () {
    var out = bp.filterWaitlistRows(rows, 'booked', '');
    expect(out.map(function (r) { return r.email; })).toEqual(['carol@example.com', 'dave@example.com']);
  });

  test('all plus a search string returns only case-insensitive email substring matches', function () {
    var out = bp.filterWaitlistRows(rows, 'all', 'CAROL');
    expect(out.map(function (r) { return r.email; })).toEqual(['carol@example.com']);
  });

  test('an empty search returns everything', function () {
    var out = bp.filterWaitlistRows(rows, 'all', '   ');
    expect(out.length).toBe(4);
  });
});

describe('isWaitlistSynced — truth table', function () {
  test.each([
    [true, true],
    ['TRUE', true],
    ['true', true],
    [1, true],
    ['1', true],
    ['yes', true],
    [false, false],
    ['FALSE', false],
    ['', false],
    [null, false],
    [undefined, false],
    ['no', false],
    [0, false]
  ])('isWaitlistSynced(%p) === %p', function (input, expected) {
    expect(bp.isWaitlistSynced(input)).toBe(expected);
  });
});

describe('shouldShowWaitlistCategoryColumn — D-02 auto-suppression', function () {
  test('returns false for all-beer rows', function () {
    var rows = [{ category: 'beer' }, { category: 'Beer' }, { category: ' beer ' }];
    expect(bp.shouldShowWaitlistCategoryColumn(rows)).toBe(false);
  });

  test('returns false for an empty array', function () {
    expect(bp.shouldShowWaitlistCategoryColumn([])).toBe(false);
  });

  test('returns true for a beer + cider mix', function () {
    var rows = [{ category: 'beer' }, { category: 'cider' }];
    expect(bp.shouldShowWaitlistCategoryColumn(rows)).toBe(true);
  });
});

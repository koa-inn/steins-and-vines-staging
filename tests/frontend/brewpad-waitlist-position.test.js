'use strict';

// ---------------------------------------------------------------------------
// Phase 80-03: position-aware sortWaitlistRows merge-insert (D-10-D-14).
// Covers parseWaitlistPosition + the merge-insert extension to
// sortWaitlistRows. Follows the same DOM-free pure-helper harness used by
// tests/frontend/brewpad-waitlist.test.js (Phase 78-03).
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

describe('parseWaitlistPosition — only a positive integer pins', function () {
  test.each([
    ['2', 2],
    [2, 2],
    [1, 1],
    [null, null],
    ['', null],
    [undefined, null],
    [0, null],
    [-1, null],
    ['abc', null],
    ['2.5', null],
    [2.5, null]
  ])('parseWaitlistPosition(%p) === %p', function (input, expected) {
    expect(bp.parseWaitlistPosition(input)).toBe(expected);
  });
});

describe('sortWaitlistRows — position merge-insert (D-10-D-14)', function () {
  test('with no row carrying a position, behaves exactly as today (chronological, unparseable last, index tiebreak)', function () {
    var rows = [
      { id: 'c', signed_up_at: '2026-09-02T10:00:00.000Z' },
      { id: 'undated', signed_up_at: '' },
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['a', 'b', 'c', 'undated']);
  });

  test('a row with position 1 appears first even when its signed_up_at is the newest', function () {
    var rows = [
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' },
      { id: 'newest-pinned', signed_up_at: '2026-09-02T10:00:00.000Z', position: 1 }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted[0].id).toBe('newest-pinned');
    expect(sorted.map(function (r) { return r.id; })).toEqual(['newest-pinned', 'a', 'b']);
  });

  test('a row with position 2 lands at index 1 with unpinned rows filling the other slots chronologically', function () {
    var rows = [
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' },
      { id: 'c', signed_up_at: '2026-09-02T10:00:00.000Z', position: 2 }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['a', 'c', 'b']);
  });

  test('a position larger than the row count clamps to the end rather than creating a gap or dropping the row', function () {
    var rows = [
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z', position: 99 }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['a', 'b']);
    expect(sorted.length).toBe(2);
  });

  test('two rows pinned to the same position order by ascending original index (stable)', function () {
    var rows = [
      { id: 'x', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'first-at-pos1', signed_up_at: '2026-08-20T12:00:00.000Z', position: 1 },
      { id: 'second-at-pos1', signed_up_at: '2026-08-25T12:00:00.000Z', position: 1 }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['first-at-pos1', 'second-at-pos1', 'x']);
  });

  test('non-positive-integer position values are all treated as unpinned', function () {
    var rows = [
      { id: 'str2', signed_up_at: '2026-08-20T12:00:00.000Z', position: '2' },
      { id: 'num-null', signed_up_at: '2026-08-15T08:00:00.000Z', position: null },
      { id: 'empty', signed_up_at: '2026-08-16T08:00:00.000Z', position: '' },
      { id: 'undef', signed_up_at: '2026-08-17T08:00:00.000Z', position: undefined },
      { id: 'zero', signed_up_at: '2026-08-18T08:00:00.000Z', position: 0 },
      { id: 'negative', signed_up_at: '2026-08-19T08:00:00.000Z', position: -1 },
      { id: 'abc', signed_up_at: '2026-08-21T08:00:00.000Z', position: 'abc' }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    // 'str2' (numeric string) IS a valid pin per parseWaitlistPosition -- pins at index 1.
    // Everything else stays chronological, unpinned.
    expect(sorted.map(function (r) { return r.id; })).toEqual([
      'num-null', 'str2', 'empty', 'undef', 'zero', 'negative', 'abc'
    ]);
  });

  test('clearing a row position returns it to exactly the ordering it had before it was pinned', function () {
    var unpinnedRows = [
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' },
      { id: 'c', signed_up_at: '2026-09-02T10:00:00.000Z' }
    ];
    var before = bp.sortWaitlistRows(unpinnedRows).map(function (r) { return r.id; });

    var pinnedRows = JSON.parse(JSON.stringify(unpinnedRows));
    pinnedRows[2].position = 1;
    var pinnedOrder = bp.sortWaitlistRows(pinnedRows).map(function (r) { return r.id; });
    expect(pinnedOrder).not.toEqual(before);

    var clearedRows = JSON.parse(JSON.stringify(pinnedRows));
    clearedRows[2].position = '';
    var clearedOrder = bp.sortWaitlistRows(clearedRows).map(function (r) { return r.id; });
    expect(clearedOrder).toEqual(before);
  });

  test('no input row object is mutated by the sort', function () {
    var rows = [
      { id: 'a', signed_up_at: '2026-08-15T08:00:00.000Z', position: 1 },
      { id: 'b', signed_up_at: '2026-08-20T12:00:00.000Z' }
    ];
    var snapshot = JSON.parse(JSON.stringify(rows));
    bp.sortWaitlistRows(rows);
    expect(rows).toEqual(snapshot);
  });
});

describe('computeWaitlistQueuePositions — still numbers only waiting rows after a pin merge', function () {
  test('walks whatever order sortWaitlistRows returned, numbering only waiting rows', function () {
    var rows = [
      { id: 'a', status: 'waiting', signed_up_at: '2026-08-15T08:00:00.000Z' },
      { id: 'b', status: 'booked', signed_up_at: '2026-08-20T12:00:00.000Z' },
      { id: 'c', status: 'waiting', signed_up_at: '2026-09-02T10:00:00.000Z', position: 1 }
    ];
    var sorted = bp.sortWaitlistRows(rows);
    expect(sorted.map(function (r) { return r.id; })).toEqual(['c', 'a', 'b']);
    expect(bp.computeWaitlistQueuePositions(sorted)).toEqual([1, 2, null]);
  });
});

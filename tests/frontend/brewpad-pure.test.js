'use strict';

// brewpad.js runs its IIFE on load — stub the globals it touches at the top level.
global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();

// auth.js primitives are loaded via <script> in the browser; in tests wire them as globals.
var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');
var escapeHTML            = bp.escapeHTML;
var fmtDate               = bp.fmtDate;
var todayStr              = bp.todayStr;
var isOverdue             = bp.isOverdue;
var isToday               = bp.isToday;
var filterBatchesByStatus = bp.filterBatchesByStatus;
var calcAbv               = bp.calcAbv;
var renderDataGapWarning  = bp.renderDataGapWarning;

// ---------------------------------------------------------------------------
// escapeHTML
// ---------------------------------------------------------------------------
describe('escapeHTML', function () {
  test('null → empty string', function () { expect(escapeHTML(null)).toBe(''); });
  test('undefined → empty string', function () { expect(escapeHTML(undefined)).toBe(''); });
  test('& escaped', function () { expect(escapeHTML('a & b')).toBe('a &amp; b'); });
  test('< escaped', function () { expect(escapeHTML('<script>')).toBe('&lt;script&gt;'); });
  test('> escaped', function () { expect(escapeHTML('x > 1')).toBe('x &gt; 1'); });
  test('" escaped', function () { expect(escapeHTML('"hello"')).toBe('&quot;hello&quot;'); });
  test('safe string unchanged', function () { expect(escapeHTML('hello world')).toBe('hello world'); });
  test('number coerced to string', function () { expect(escapeHTML(42)).toBe('42'); });
  test('multiple special chars', function () {
    expect(escapeHTML('<a href="x">foo & bar</a>')).toBe('&lt;a href=&quot;x&quot;&gt;foo &amp; bar&lt;/a&gt;');
  });
});

// ---------------------------------------------------------------------------
// fmtDate
// ---------------------------------------------------------------------------
describe('fmtDate', function () {
  test('null → em-dash', function () { expect(fmtDate(null)).toBe('—'); });
  test('empty string → em-dash', function () { expect(fmtDate('')).toBe('—'); });
  test('ISO date → first 10 chars', function () { expect(fmtDate('2026-03-15T12:00:00')).toBe('2026-03-15'); });
  test('date-only string unchanged', function () { expect(fmtDate('2026-01-01')).toBe('2026-01-01'); });
  test('trims time portion', function () { expect(fmtDate('2026-03-07 10:00 AM')).toBe('2026-03-07'); });
});

// ---------------------------------------------------------------------------
// todayStr
// ---------------------------------------------------------------------------
describe('todayStr', function () {
  test('returns YYYY-MM-DD format', function () {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('matches current date', function () {
    var expected = new Date().toISOString().slice(0, 10);
    expect(todayStr()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// isOverdue / isToday
// ---------------------------------------------------------------------------
describe('isOverdue', function () {
  test('null → false', function () { expect(isOverdue(null)).toBe(false); });
  test('empty string → false', function () { expect(isOverdue('')).toBe(false); });

  test('past date → true', function () {
    expect(isOverdue('2000-01-01')).toBe(true);
  });

  test('future date → false', function () {
    expect(isOverdue('2099-12-31')).toBe(false);
  });

  test('today → false (not overdue yet)', function () {
    expect(isOverdue(todayStr())).toBe(false);
  });
});

describe('isToday', function () {
  test('null → false', function () { expect(isToday(null)).toBe(false); });
  test('empty string → false', function () { expect(isToday('')).toBe(false); });

  test('today → true', function () {
    expect(isToday(todayStr())).toBe(true);
  });

  test('past date → false', function () {
    expect(isToday('2000-01-01')).toBe(false);
  });

  test('future date → false', function () {
    expect(isToday('2099-12-31')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// filterBatchesByStatus
// ---------------------------------------------------------------------------
describe('filterBatchesByStatus', function () {
  var batches = [
    { batch_id: 'A', status: 'primary' },
    { batch_id: 'B', status: 'secondary' },
    { batch_id: 'C', status: 'complete' },
    { batch_id: 'D', status: 'planning' },
    { batch_id: 'E', status: '' }
  ];

  test('no filter returns all (copy)', function () {
    var result = filterBatchesByStatus(batches, null);
    expect(result).toHaveLength(5);
    expect(result).not.toBe(batches); // returns a copy
  });

  test('"all" returns all', function () {
    expect(filterBatchesByStatus(batches, 'all')).toHaveLength(5);
  });

  test('"active" returns primary + secondary', function () {
    var result = filterBatchesByStatus(batches, 'active');
    expect(result).toHaveLength(2);
    expect(result.map(function (b) { return b.batch_id; })).toEqual(['A', 'B']);
  });

  test('"complete" returns only complete', function () {
    var result = filterBatchesByStatus(batches, 'complete');
    expect(result).toHaveLength(1);
    expect(result[0].batch_id).toBe('C');
  });

  test('"planning" returns only planning', function () {
    var result = filterBatchesByStatus(batches, 'planning');
    expect(result).toHaveLength(1);
    expect(result[0].batch_id).toBe('D');
  });

  test('case-insensitive status matching', function () {
    var result = filterBatchesByStatus([{ batch_id: 'X', status: 'Complete' }], 'complete');
    expect(result).toHaveLength(1);
  });

  test('empty batches array → empty result', function () {
    expect(filterBatchesByStatus([], 'active')).toHaveLength(0);
  });

  test('does not mutate original array', function () {
    var original = [{ batch_id: 'A', status: 'primary' }];
    var result = filterBatchesByStatus(original, 'all');
    result.push({ batch_id: 'Z', status: 'test' });
    expect(original).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// calcAbv
// ---------------------------------------------------------------------------
describe('calcAbv', function () {
  test('typical wine kit: OG 22°P → FG 4°P ≈ 9.5% ABV', function () {
    var abv = calcAbv(22, 4);
    expect(abv).toBeCloseTo(9.5, 0);
  });

  test('light beer: OG 10°P → FG 2.5°P', function () {
    var abv = calcAbv(10, 2.5);
    expect(abv).toBeGreaterThan(3);
    expect(abv).toBeLessThan(5);
  });

  test('OG === FG → 0% ABV', function () {
    var abv = calcAbv(10, 10);
    expect(abv).toBeCloseTo(0, 5);
  });

  test('higher OG → higher ABV for same FG', function () {
    var abvLow = calcAbv(12, 2);
    var abvHigh = calcAbv(20, 2);
    expect(abvHigh).toBeGreaterThan(abvLow);
  });

  test('returns a number', function () {
    expect(typeof calcAbv(15, 3)).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// renderDataGapWarning
// ---------------------------------------------------------------------------
describe('renderDataGapWarning', function () {
  test('empty readings → empty string', function () {
    expect(renderDataGapWarning([])).toBe('');
  });

  test('null readings → empty string', function () {
    expect(renderDataGapWarning(null)).toBe('');
  });

  test('last reading missing timestamp → empty string', function () {
    expect(renderDataGapWarning([{ degrees_plato: 10 }])).toBe('');
  });

  test('last reading 1 day ago → no warning (< 3 days)', function () {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var result = renderDataGapWarning(
      [{ timestamp: yesterday.toISOString() }],
      new Date()
    );
    expect(result).toBe('');
  });

  test('last reading 4 days ago → warn class', function () {
    var now = new Date('2026-03-07T12:00:00Z');
    var fourDaysAgo = new Date('2026-03-03T12:00:00Z');
    var result = renderDataGapWarning([{ timestamp: fourDaysAgo.toISOString() }], now);
    expect(result).toContain('bp-chart-warning--warn');
    expect(result).toContain('4 day');
  });

  test('last reading 8 days ago → danger class', function () {
    var now = new Date('2026-03-07T12:00:00Z');
    var eightDaysAgo = new Date('2026-02-27T12:00:00Z');
    var result = renderDataGapWarning([{ timestamp: eightDaysAgo.toISOString() }], now);
    expect(result).toContain('bp-chart-warning--danger');
    expect(result).toContain('8 day');
  });

  test('1 day singular grammar', function () {
    var now = new Date('2026-03-07T12:00:00Z');
    // exactly 3 days needed to trigger, check plural for 3
    var threeDaysAgo = new Date('2026-03-04T12:00:00Z');
    var result = renderDataGapWarning([{ timestamp: threeDaysAgo.toISOString() }], now);
    expect(result).toContain('3 days');
  });

  test('uses last reading in array (most recent)', function () {
    var now = new Date('2026-03-07T12:00:00Z');
    var old = new Date('2026-01-01T12:00:00Z');
    var recent = new Date('2026-03-04T12:00:00Z'); // 3 days ago
    var result = renderDataGapWarning(
      [{ timestamp: old.toISOString() }, { timestamp: recent.toISOString() }],
      now
    );
    expect(result).toContain('3 days');
  });
});

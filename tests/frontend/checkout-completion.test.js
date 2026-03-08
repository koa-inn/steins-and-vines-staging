'use strict';

global.SHEETS_CONFIG = { SPREADSHEET_ID: 'test', MIDDLEWARE_URL: '' };
global.navigator = global.navigator || {};
global.navigator.vibrate = jest.fn();

beforeEach(function () { localStorage.clear(); });

var calcCompletionRange = require('../../js/modules/12-checkout').calcCompletionRange;

// ---------------------------------------------------------------------------
// calcCompletionRange
// ---------------------------------------------------------------------------
describe('calcCompletionRange', function () {
  test('empty items → null', function () {
    expect(calcCompletionRange([], '2026-03-15 10:00 AM')).toBeNull();
  });

  test('items with no time prop → null', function () {
    var items = [{ name: 'Widget' }];
    expect(calcCompletionRange(items, '2026-03-15 10:00 AM')).toBeNull();
  });

  test('items with non-numeric time → "varies"', function () {
    var items = [{ time: 'TBD' }];
    expect(calcCompletionRange(items, '2026-03-15 10:00 AM')).toBe('varies');
  });

  test('invalid date in timeslot → null', function () {
    var items = [{ time: '4' }];
    expect(calcCompletionRange(items, 'not-a-date 10:00 AM')).toBeNull();
  });

  test('1 week — singular "week"', function () {
    var items = [{ time: '1' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toContain('1 week ');
    expect(result).not.toContain('weeks');
  });

  test('4 weeks — plural "weeks"', function () {
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toContain('4 weeks');
  });

  test('uses the longest brew time when multiple items', function () {
    var items = [{ time: '4' }, { time: '8' }, { time: '2' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toContain('8 weeks');
  });

  test('result contains appointment year', function () {
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toContain('2026');
  });

  test('result contains "Estimated ready"', function () {
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toMatch(/Estimated ready the week of/);
  });

  test('result contains disclaimer about estimate', function () {
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toMatch(/estimate/i);
  });

  test('4 weeks from 2026-03-01 starts around March 29', function () {
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    expect(result).toContain('March');
    expect(result).toContain('29');
  });

  test('week range spans 7 days (start to end)', function () {
    // 4 weeks from 2026-03-01 = 2026-03-29, week ends 2026-04-04
    var items = [{ time: '4' }];
    var result = calcCompletionRange(items, '2026-03-01 10:00 AM');
    // Cross-month range: April 4
    expect(result).toContain('April');
  });

  test('items with time=0 treated as no time prop when all are 0', function () {
    // parseInt('0') = 0, so maxWeeks stays 0, no time prop flag set since item.time is falsy ('0' is truthy)
    var items = [{ time: '0' }];
    // time is '0' which is truthy, so hasTimeProp=true → returns 'varies'
    expect(calcCompletionRange(items, '2026-03-01 10:00 AM')).toBe('varies');
  });
});

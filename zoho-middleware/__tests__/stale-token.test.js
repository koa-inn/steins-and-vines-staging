'use strict';

var isStale = require('../lib/stale-token').isStale;

describe('stale-token isStale', function () {
  var iso = '2026-10-07T12:00:00.123Z';
  var rowDate = { updated_at: new Date(iso) };
  var rowStr = { updated_at: iso };

  test('missing, empty or unparseable expected is stale', function () {
    expect(isStale(undefined, rowDate)).toBe(true);
    expect(isStale(null, rowDate)).toBe(true);
    expect(isStale('', rowDate)).toBe(true);
    expect(isStale('garbage', rowDate)).toBe(true);
  });

  test('matching token is not stale (Date or string row)', function () {
    expect(isStale(iso, rowDate)).toBe(false);
    expect(isStale(iso, rowStr)).toBe(false);
  });

  test('a 1 ms difference is stale', function () {
    expect(isStale('2026-10-07T12:00:00.124Z', rowDate)).toBe(true);
    expect(isStale('2026-10-07T12:00:00.122Z', rowStr)).toBe(true);
  });
});

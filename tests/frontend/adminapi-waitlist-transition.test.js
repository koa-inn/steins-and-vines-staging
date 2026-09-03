'use strict';

// Server-side enforcement of D-05: waitlist status transitions are ONE-WAY.
//
// The bug (code review CR-01): `updateWaitlistStatus` validated that the incoming status was one
// of the four literals, but never compared it against the row's CURRENT status. The one-way rule
// lived only in `js/brewpad.js`'s `nextWaitlistStatus`/`WAITLIST_STATUS_ORDER`, i.e. client-side.
// Any direct call to the admin proxy — a stale BrewPad tab, a retried write, a hand-rolled
// request — could move a `booked` row back to `waiting`, silently corrupting queue position.
//
// The Phase 78 staging UAT (78-CUTOVER.md leg 7) confirmed the CLIENT refuses the backward tap and
// issues no request at all. That is real coverage of the UI, and it is exactly why this gap
// survived: it proves the button is guarded, not that the record is.
//
// WHAT THIS SUITE CANNOT PROVE: `waitlistTransitionAllowed` is pure and fully exercised here, but
// its CALL SITE inside `updateWaitlistStatus` is asserted by source shape only, because that
// handler needs a live Sheets runtime. The source-shape assertions below check that the guard is
// invoked and that it runs before any setValue.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

function loadPure() {
  var src = rawSource();
  var factory = new Function(
    src + '\nreturn { waitlistTransitionAllowed: (typeof waitlistTransitionAllowed !== "undefined" ? waitlistTransitionAllowed : undefined) };'
  );
  return factory();
}

// Brace-match a named function's source text.
function sliceFunctionSource(src, name) {
  var marker = 'function ' + name + '(';
  var start = src.indexOf(marker);
  if (start === -1) return null;
  var i = src.indexOf('{', start);
  var depth = 0;
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

describe('waitlistTransitionAllowed — D-05 one-way rule, server side', function () {
  var api;

  beforeAll(function () {
    api = loadPure();
  });

  test('exists as a pure top-level function', function () {
    expect(typeof api.waitlistTransitionAllowed).toBe('function');
  });

  test('allows forward moves along waiting → contacted → booked', function () {
    expect(api.waitlistTransitionAllowed('waiting', 'contacted')).toBe(true);
    expect(api.waitlistTransitionAllowed('contacted', 'booked')).toBe(true);
    // Skipping a step forward is still forward.
    expect(api.waitlistTransitionAllowed('waiting', 'booked')).toBe(true);
  });

  // THE REGRESSION.
  test('refuses every backward move', function () {
    expect(api.waitlistTransitionAllowed('booked', 'waiting')).toBe(false);
    expect(api.waitlistTransitionAllowed('booked', 'contacted')).toBe(false);
    expect(api.waitlistTransitionAllowed('contacted', 'waiting')).toBe(false);
  });

  test('allows removal from any active status', function () {
    expect(api.waitlistTransitionAllowed('waiting', 'removed')).toBe(true);
    expect(api.waitlistTransitionAllowed('contacted', 'removed')).toBe(true);
    expect(api.waitlistTransitionAllowed('booked', 'removed')).toBe(true);
  });

  test('refuses to resurrect a removed row into an active status', function () {
    // Reinstating a removed customer is a product decision that has no UI or handler support
    // today (see code review CR-02). Until it does, the server must not accept it.
    expect(api.waitlistTransitionAllowed('removed', 'waiting')).toBe(false);
    expect(api.waitlistTransitionAllowed('removed', 'contacted')).toBe(false);
    expect(api.waitlistTransitionAllowed('removed', 'booked')).toBe(false);
  });

  test('treats a no-op re-set as allowed so a retried write is idempotent', function () {
    expect(api.waitlistTransitionAllowed('waiting', 'waiting')).toBe(true);
    expect(api.waitlistTransitionAllowed('contacted', 'contacted')).toBe(true);
    expect(api.waitlistTransitionAllowed('booked', 'booked')).toBe(true);
    expect(api.waitlistTransitionAllowed('removed', 'removed')).toBe(true);
  });

  test('normalises case and surrounding whitespace on both sides', function () {
    expect(api.waitlistTransitionAllowed(' WAITING ', 'Contacted')).toBe(true);
    expect(api.waitlistTransitionAllowed('BOOKED', ' waiting')).toBe(false);
  });

  test('refuses unknown statuses on either side rather than defaulting to allow', function () {
    expect(api.waitlistTransitionAllowed('waiting', 'nonsense')).toBe(false);
    expect(api.waitlistTransitionAllowed('nonsense', 'booked')).toBe(false);
    expect(api.waitlistTransitionAllowed('', 'booked')).toBe(false);
    expect(api.waitlistTransitionAllowed(null, 'booked')).toBe(false);
    expect(api.waitlistTransitionAllowed('waiting', null)).toBe(false);
    expect(api.waitlistTransitionAllowed(undefined, undefined)).toBe(false);
  });

  test('is pure — reads no Apps Script globals', function () {
    var fnSrc = sliceFunctionSource(rawSource(), 'waitlistTransitionAllowed');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).not.toMatch(/SpreadsheetApp|LockService|CacheService|Session|Utilities|Logger/);
  });
});

describe('updateWaitlistStatus — wiring of the one-way guard (source shape)', function () {
  test('calls waitlistTransitionAllowed and fails closed with invalid_transition', function () {
    var fnSrc = sliceFunctionSource(rawSource(), 'updateWaitlistStatus');
    expect(fnSrc).not.toBeNull();
    expect(fnSrc).toMatch(/waitlistTransitionAllowed\(/);
    expect(fnSrc).toMatch(/'invalid_transition'/);
  });

  test('runs the guard BEFORE any setValue, so a rejected transition writes nothing', function () {
    // Strip comments first: this asserts on the order of executable statements, and a comment
    // mentioning setValue would otherwise be mistaken for the first write.
    var fnSrc = sliceFunctionSource(rawSource(), 'updateWaitlistStatus')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    var guardAt = fnSrc.indexOf('waitlistTransitionAllowed(');
    var firstWriteAt = fnSrc.indexOf('setValue');
    expect(guardAt).toBeGreaterThan(-1);
    expect(firstWriteAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(firstWriteAt);
  });

  test('reads the current status from the looked-up row, not from the caller payload', function () {
    var fnSrc = sliceFunctionSource(rawSource(), 'updateWaitlistStatus');
    // The guard's first argument must derive from the row found on the sheet.
    var call = fnSrc.match(/waitlistTransitionAllowed\(\s*([^,]+),/);
    expect(call).not.toBeNull();
    expect(call[1]).toMatch(/result\.data|existing|current/);
    expect(call[1]).not.toMatch(/payload/);
  });
});

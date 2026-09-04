'use strict';

// Reinstating a removed customer who signs up again (code review CR-02).
//
// The bug: waitlistDedupeDecision matches on email+category regardless of status, so a row whose
// status is `removed` returned action 'existing' and addWaitlistEntry returned {ok:true, id}
// without touching the sheet. The customer saw the normal success confirmation, their row stayed
// `removed`, and staff got no signal at all — the signup was silently ineffective. The comment at
// adminApi.gs claimed the remedy was staff "flipping the existing row back via BrewPad", but
// nextWaitlistStatus('removed') returns null and no such control exists.
//
// Chosen policy: a re-signup on a removed row reinstates it to `waiting` with a refreshed
// signed_up_at, so the customer rejoins at the back of the queue. The response shape is unchanged
// on every path, preserving D-06 non-disclosure.
//
// Note the deliberate asymmetry with waitlistTransitionAllowed, which still refuses
// removed -> waiting: that guard governs STAFF status edits through updateWaitlistStatus, where
// no reinstate affordance exists. Reinstatement is driven only by a customer signup event.
//
// WHAT THIS SUITE CANNOT PROVE: waitlistShouldReinstate is pure and fully covered here, but the
// sheet write inside addWaitlistEntry is asserted by source shape only — that handler needs a live
// Sheets runtime.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

function rawSource() {
  return fs.readFileSync(ADMIN_API_PATH, 'utf8');
}

function loadPure() {
  var src = rawSource();
  var factory = new Function(
    src + '\nreturn {' +
      'waitlistShouldReinstate: (typeof waitlistShouldReinstate !== "undefined" ? waitlistShouldReinstate : undefined),' +
      'waitlistDedupeDecision: (typeof waitlistDedupeDecision !== "undefined" ? waitlistDedupeDecision : undefined)' +
      '};'
  );
  return factory();
}

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

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('waitlistShouldReinstate — pure decision', function () {
  var api;

  beforeAll(function () {
    api = loadPure();
  });

  test('exists as a pure top-level function', function () {
    expect(typeof api.waitlistShouldReinstate).toBe('function');
    var fnSrc = sliceFunctionSource(rawSource(), 'waitlistShouldReinstate');
    expect(fnSrc).not.toMatch(/SpreadsheetApp|LockService|CacheService|Session|Utilities|Logger/);
  });

  test('true for a removed row', function () {
    expect(api.waitlistShouldReinstate({ status: 'removed' })).toBe(true);
  });

  test('normalises case and whitespace', function () {
    expect(api.waitlistShouldReinstate({ status: ' REMOVED ' })).toBe(true);
    expect(api.waitlistShouldReinstate({ status: 'Removed' })).toBe(true);
  });

  test('false for every active status — an active row must not be reset to the back of the queue', function () {
    expect(api.waitlistShouldReinstate({ status: 'waiting' })).toBe(false);
    expect(api.waitlistShouldReinstate({ status: 'contacted' })).toBe(false);
    // A booked customer re-signing up must NOT lose their booking.
    expect(api.waitlistShouldReinstate({ status: 'booked' })).toBe(false);
  });

  test('false for absent/blank/unknown status rather than defaulting to reinstate', function () {
    expect(api.waitlistShouldReinstate({ status: '' })).toBe(false);
    expect(api.waitlistShouldReinstate({})).toBe(false);
    expect(api.waitlistShouldReinstate({ status: 'nonsense' })).toBe(false);
    expect(api.waitlistShouldReinstate(null)).toBe(false);
    expect(api.waitlistShouldReinstate(undefined)).toBe(false);
  });

  test('the dedupe decision still reports a removed row as existing (unchanged contract)', function () {
    var rows = [{ id: 'x', email: 'jane@example.com', category: 'beer', status: 'removed' }];
    var d = api.waitlistDedupeDecision(rows, 'jane@example.com', 'beer');
    expect(d.action).toBe('existing');
    // The reinstate decision is layered on top, not folded into the dedupe action.
    expect(api.waitlistShouldReinstate(d.row)).toBe(true);
  });
});

describe('addWaitlistEntry — reinstate wiring (source shape)', function () {
  var fnSrc;

  beforeAll(function () {
    fnSrc = stripComments(sliceFunctionSource(rawSource(), 'addWaitlistEntry'));
  });

  test('consults waitlistShouldReinstate on the dedupe-hit path', function () {
    expect(fnSrc).toMatch(/waitlistShouldReinstate\(/);
  });

  test('writes both status and signed_up_at when reinstating', function () {
    var at = fnSrc.indexOf('waitlistShouldReinstate(');
    expect(at).toBeGreaterThan(-1);
    var after = fnSrc.slice(at);
    expect(after).toMatch(/'waiting'/);
    expect(after).toMatch(/signed_up_at/);
    expect(after).toMatch(/toISOString\(\)/);
  });

  test('invalidates the sheet cache after a reinstate write', function () {
    expect(fnSrc).toMatch(/invalidateSheetCache\(/);
  });

  // D-06: the response must not reveal whether this was a new row, a plain dedupe hit, or a
  // reinstatement. All three return the same key set.
  test('every return path yields only {ok, id} — no disclosing field', function () {
    var returns = fnSrc.match(/return\s*\{[^}]*\}/g) || [];
    var okReturns = returns.filter(function (r) { return /ok:\s*true/.test(r); });
    expect(okReturns.length).toBeGreaterThan(0);
    okReturns.forEach(function (r) {
      var keys = (r.match(/(\w+)\s*:/g) || []).map(function (k) { return k.replace(/\s*:$/, ''); });
      expect(keys.sort()).toEqual(['id', 'ok']);
      expect(r).not.toMatch(/reinstat|existing|duplicate|already/i);
    });
  });
});

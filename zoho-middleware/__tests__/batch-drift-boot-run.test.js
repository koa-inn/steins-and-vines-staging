'use strict';

/**
 * The 24 h drift interval restarts on every deploy, so during the 2026-10-28..30 rollback week
 * (a deploy each day) it never fired. registerDriftTimer now also schedules one run shortly after
 * boot, so every deploy day gets at least one check.
 */

var drift = require('../lib/batch-drift');

var QUIET = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function reg(mirror, mode, later) {
  return drift.registerDriftTimer({
    sheetMirror: { isMirrorEnabled: function () { return mirror; } },
    batchFlag: { getMode: function () { return mode; } },
    log: QUIET,
    setTimeout: later
  });
}

describe('registerDriftTimer boot run', function () {
  var handles = [];
  afterEach(function () {
    handles.forEach(clearInterval);
    handles = [];
  });

  test('production + postgres schedules one run 10 minutes after boot, unref\'d', function () {
    var unref = jest.fn();
    var later = jest.fn(function () { return { unref: unref }; });
    var h = reg(true, 'postgres', later);
    handles.push(h);
    expect(later).toHaveBeenCalledTimes(1);
    expect(typeof later.mock.calls[0][0]).toBe('function');
    expect(later.mock.calls[0][1]).toBe(10 * 60 * 1000);
    expect(unref).toHaveBeenCalled();
    expect(drift.BOOT_RUN_DELAY_MS).toBe(10 * 60 * 1000);
  });

  test('no boot run off production or when BATCHES_STORE is not postgres', function () {
    var later = jest.fn();
    expect(reg(false, 'postgres', later)).toBeNull();
    expect(reg(true, 'sheets', later)).toBeNull();
    expect(later).not.toHaveBeenCalled();
  });
});

'use strict';

// Phase 99-02: pure helpers for dashboard default flag, cache gate, hint, markers, touch, lazy render.

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

function ptDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

describe('dashV2DefaultFlagFrom', function () {
  var f = function (a, b, c, d) { return bp.dashV2DefaultFlagFrom(a, b, c, d); };
  test('explicit v2 beats everything', function () {
    expect(f('?dash=v2', '', null, null)).toEqual({ on: true, persist: '1', markMigrated: true });
    expect(f('', '#dash=v2&type=wine', '0', '1')).toEqual({ on: true, persist: '1', markMigrated: true });
  });
  test('explicit classic / v1 beat everything', function () {
    var c = { on: false, persist: '0', markMigrated: true };
    expect(f('?dash=classic', '', '1', '1')).toEqual(c);
    expect(f('', '#dash=classic', null, null)).toEqual(c);
    expect(f('?dash=v1', '', null, '1')).toEqual(c);
  });
  test('one-time reset of unmigrated devices', function () {
    var v = { on: true, persist: '1', markMigrated: true };
    expect(f('', '', '0', null)).toEqual(v);
    expect(f('', '', null, null)).toEqual(v);
    expect(f('', '', '0', 'yes')).toEqual(v);
  });
  test('after migration, stored choice is respected', function () {
    expect(f('', '', '0', '1')).toEqual({ on: false, persist: null, markMigrated: false });
    expect(f('', '', '1', '1')).toEqual({ on: true, persist: null, markMigrated: false });
    expect(f('', '', null, '1')).toEqual({ on: true, persist: null, markMigrated: false });
  });
  test('dashV2FlagFrom unchanged', function () {
    expect(bp.dashV2FlagFrom('', '', null)).toEqual({ on: false, persist: null });
  });
});

describe('dashCacheEntry / dashCacheUsable', function () {
  var data = { batches: [] };
  test('entry shape and null guards', function () {
    var e = bp.dashCacheEntry(data, { a: 1 }, [1], 'a@b.c', '2026-11-06', 123);
    expect(e).toEqual({ v: 1, day: '2026-11-06', savedAt: 123, email: 'a@b.c', dashData: data, fermSchedules: { a: 1 }, upcomingTasks: [1] });
    expect(bp.dashCacheEntry(null, null, null, 'a@b.c', 'd', 1)).toBeNull();
    expect(bp.dashCacheEntry('x', null, null, 'a@b.c', 'd', 1)).toBeNull();
    expect(bp.dashCacheEntry(data, null, null, '', 'd', 1)).toBeNull();
  });
  test('usable rules', function () {
    var e = bp.dashCacheEntry(data, null, null, 'a@b.c', '2026-11-06', 1);
    expect(bp.dashCacheUsable(e, '2026-11-06', 'a@b.c')).toBe(e);
    expect(bp.dashCacheUsable(null, '2026-11-06', 'a@b.c')).toBeNull();
    expect(bp.dashCacheUsable(undefined, '2026-11-06', 'a@b.c')).toBeNull();
    expect(bp.dashCacheUsable('str', '2026-11-06', 'a@b.c')).toBeNull();
    expect(bp.dashCacheUsable({ v: 2, day: '2026-11-06', email: 'a@b.c', dashData: {} }, '2026-11-06', 'a@b.c')).toBeNull();
    expect(bp.dashCacheUsable({ v: 1, day: '2026-11-06', email: 'a@b.c' }, '2026-11-06', 'a@b.c')).toBeNull();
    expect(bp.dashCacheUsable(e, '2026-11-07', 'a@b.c')).toBeNull();
  });
  test('same-user strictness', function () {
    var e = bp.dashCacheEntry(data, null, null, 'a@b.c', '2026-11-06', 1);
    expect(bp.dashCacheUsable(e, '2026-11-06', 'x@y.z')).toBeNull();
    expect(bp.dashCacheUsable(e, '2026-11-06', '')).toBeNull();
    expect(bp.dashCacheUsable(e, '2026-11-06')).toBeNull();
    expect(bp.dashCacheUsable({ v: 1, day: '2026-11-06', dashData: {} }, '2026-11-06', 'a@b.c')).toBeNull();
  });
  test('Vancouver day boundary', function () {
    var e = bp.dashCacheEntry(data, null, null, 'a@b.c', '2026-11-06', 1);
    expect(bp.dashCacheUsable(e, ptDay('2026-11-07T06:30:00Z'), 'a@b.c')).toBe(e);
    expect(bp.dashCacheUsable(e, ptDay('2026-11-07T08:30:00Z'), 'a@b.c')).toBeNull();
  });
});

describe('dashAsOfHint', function () {
  var ms = new Date('2026-11-06T23:05:00Z').getTime(); // 3:05 PM PST
  test('copy', function () {
    expect(bp.dashAsOfHint('updating', ms)).toBe('As of 3:05 PM · Updating…');
    expect(bp.dashAsOfHint('fresh', ms)).toBe('Updated 3:05 PM');
    expect(bp.dashAsOfHint('failed', ms)).toBe('As of 3:05 PM · Couldn\'t refresh. Reopen the Dashboard tab to try again.');
  });
  test('empty cases and banned words', function () {
    expect(bp.dashAsOfHint('other', ms)).toBe('');
    expect(bp.dashAsOfHint('fresh', NaN)).toBe('');
    expect(bp.dashAsOfHint('fresh', undefined)).toBe('');
    ['updating', 'fresh', 'failed'].forEach(function (s) {
      expect(/stale|conflict|missing|late/i.test(bp.dashAsOfHint(s, ms))).toBe(false);
    });
  });
});

describe('dashPointStyleFor / dashMarkerGlyph', function () {
  test('known keys', function () {
    expect(bp.dashPointStyleFor('wine', 0)).toEqual({ pointStyle: 'circle', pointRadius: 6, pointHitRadius: 22 });
    expect(bp.dashPointStyleFor('Cider', 0).pointStyle).toBe('triangle');
    expect(bp.dashPointStyleFor('BEER', 0).pointStyle).toBe('rect');
    expect(bp.dashPointStyleFor('other', 0).pointStyle).toBe('rectRot');
  });
  test('index cycle', function () {
    var exp = ['circle', 'triangle', 'rect', 'rectRot', 'cross', 'star', 'circle'];
    exp.forEach(function (s, i) { expect(bp.dashPointStyleFor('zzz', i).pointStyle).toBe(s); });
  });
  test('glyphs', function () {
    expect(bp.dashMarkerGlyph('circle')).toBe('●');
    expect(bp.dashMarkerGlyph('triangle')).toBe('▲');
    expect(bp.dashMarkerGlyph('rect')).toBe('■');
    expect(bp.dashMarkerGlyph('rectRot')).toBe('◆');
    expect(bp.dashMarkerGlyph('cross')).toBe('✚');
    expect(bp.dashMarkerGlyph('star')).toBe('★');
    expect(bp.dashMarkerGlyph('nope')).toBe('■');
  });
});

describe('dashTouchTapAction', function () {
  var a = { datasetIndex: 0, index: 2 };
  test('actions', function () {
    expect(bp.dashTouchTapAction(null, null, false)).toBe('hide');
    expect(bp.dashTouchTapAction(a, null, true)).toBe('hide');
    expect(bp.dashTouchTapAction(null, a, false)).toBe('show');
    expect(bp.dashTouchTapAction({ datasetIndex: 0, index: 2 }, a, true)).toBe('drill');
    expect(bp.dashTouchTapAction({ datasetIndex: 1, index: 2 }, a, true)).toBe('show');
    expect(bp.dashTouchTapAction({ datasetIndex: 0, index: 3 }, a, true)).toBe('show');
    expect(bp.dashTouchTapAction(a, a, false)).toBe('show');
  });
});

describe('dashV2SlotShouldRender', function () {
  test('rules', function () {
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'today', isPhone: true, sectionOpen: false })).toBe(true);
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'wine', isPhone: true, sectionOpen: false })).toBe(false);
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'wine', isPhone: true, sectionOpen: true })).toBe(true);
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'wine', isPhone: false, ioSupported: true, intersected: false })).toBe(false);
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'wine', isPhone: false, ioSupported: true, intersected: true })).toBe(true);
    expect(bp.dashV2SlotShouldRender({ sectionKey: 'wine', isPhone: false, ioSupported: false, intersected: false })).toBe(true);
  });
});

describe('dashSectionCountLabel', function () {
  test('plural', function () {
    expect(bp.dashSectionCountLabel(1)).toBe('1 chart');
    expect(bp.dashSectionCountLabel(0)).toBe('0 charts');
    expect(bp.dashSectionCountLabel(4)).toBe('4 charts');
  });
});

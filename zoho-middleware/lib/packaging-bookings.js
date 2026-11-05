'use strict';

/**
 * Phase 97 packaging calendar: pure matching / windowing / whitelisting (no I/O).
 * Customer emails are used only for matching and are never copied to the output.
 */

var constants = require('./constants');

var TZ = 'America/Vancouver';
var WINDOW_DAYS = 14;
var DEFAULT_PREFIX = 'calcom:packaging-bookings:';

var _counter = 0;
var _gen = String(Date.now());

function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

function vancouverDay(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

function ymdToUtc(ymd) {
  var p = String(ymd).split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function ymdAddDays(ymd, n) {
  return new Date(ymdToUtc(ymd) + n * 86400000).toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((ymdToUtc(a) - ymdToUtc(b)) / 86400000);
}

function packagingWindow(now) {
  var start = vancouverDay(now.toISOString());
  var end = ymdAddDays(start, WINDOW_DAYS - 1);
  return {
    start: start,
    end: end,
    afterStart: ymdAddDays(start, -1) + 'T00:00:00.000Z',
    beforeEnd: ymdAddDays(end, 2) + 'T00:00:00.000Z'
  };
}

/** D-03: email equality, closest open packaging task wins, tie / no date -> null (never guess). */
function matchBatch(email, day, candidates) {
  var e = normEmail(email);
  if (!e) return null;
  var matches = (candidates || []).filter(function (c) {
    return normEmail(c.customer_email) === e || normEmail(c.bottling_invite_email) === e;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].batch_id;
  var dated = matches.filter(function (c) { return !!c.packaging_due; });
  if (dated.length === 0) return null;
  if (dated.length === 1) return dated[0].batch_id;
  var best = null;
  var bestDist = Infinity;
  var tied = false;
  dated.forEach(function (c) {
    var dist = Math.abs(dayDiff(c.packaging_due, day));
    if (dist < bestDist) { best = c; bestDist = dist; tied = false; }
    else if (dist === bestDist) { tied = true; }
  });
  return tied ? null : best.batch_id;
}

function shapeBookings(raw, ids, candidates, window) {
  var out = [];
  (raw || []).forEach(function (b) {
    var status = String((b && b.status) || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected') return;
    var day = vancouverDay(b.start);
    if (!day || day < window.start || day > window.end) return;
    var typeId = Number((b.eventType && b.eventType.id) || b.eventTypeId);
    var att = (b.attendees && b.attendees[0]) || {};
    // WR-04: no uid (it keys Cal.com's public manage page), end or event_type_id: the browser
    // reads only these fields. Dedupe by uid happens in calcom.listBookings, server-side.
    out.push({
      start: b.start,
      day: day,
      kind: typeId === Number(ids.packagingId) ? 'canning' : 'bottling',
      batch_id: matchBatch(att.email, day, candidates),
      customer_name: String(att.name || '').slice(0, 80)
    });
  });
  out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  return out;
}

function cacheKey(start) {
  var prefix = (constants.CACHE_KEYS && constants.CACHE_KEYS.PACKAGING_BOOKINGS_PREFIX) || DEFAULT_PREFIX;
  return prefix + _gen + ':' + start;
}

function invalidate() {
  _counter += 1;
  _gen = String(Date.now()) + '-' + _counter;
}

module.exports = {
  WINDOW_DAYS: WINDOW_DAYS,
  normEmail: normEmail,
  vancouverDay: vancouverDay,
  packagingWindow: packagingWindow,
  matchBatch: matchBatch,
  shapeBookings: shapeBookings,
  cacheKey: cacheKey,
  invalidate: invalidate
};

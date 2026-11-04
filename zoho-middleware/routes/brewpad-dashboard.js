'use strict';

var express = require('express');
var authTiers = require('../lib/authTiers');
var batchStore = require('../lib/batch-store');
var kioskBundles = require('../lib/kiosk-bundles');
var log = require('../lib/logger');
var calcom = require('../lib/calcom');
var cache = require('../lib/cache');
var packagingBookings = require('../lib/packaging-bookings');

var router = express.Router();

// D-09: 25 packaged litres per 28 L brew. D-10: can counts are shared with the kiosk bundle
// (parity-tested there) so the browser never retypes them.
var CANNING = {
  packaged_litres: 25,
  brew_litres: 28,
  nominal: kioskBundles.BUNDLES['beer-25'].nominal
};

/**
 * GET /api/admin/dashboard-cards
 * Staff-only (legacy/session; device rejected). Whitelisted per-active-batch card facts plus the
 * shared canning constants. Postgres read only: no Zoho call.
 */
router.get('/api/admin/dashboard-cards', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    res.set('Cache-Control', 'no-store');
    var p;
    try { p = Promise.resolve(batchStore.dashCards()); } catch (err) { p = Promise.reject(err); }
    p.then(function (rows) {
      return res.json({ ok: true, cards: Array.isArray(rows) ? rows : [], canning: CANNING });
    }).catch(function (err) {
      log.warn('[brewpad-dashboard] cards read failed: ' + (err && err.message));
      return res.status(500).json({ ok: false, error: 'cards_unavailable' });
    });
  });
});

var PACKAGING_CACHE_TTL = 300;

function numEnv(name) {
  var n = Number(process.env[name]);
  return isFinite(n) && n > 0 ? n : null;
}

/**
 * GET /api/admin/packaging-bookings
 * Staff-only. Upcoming Cal.com Bottling / Beer Packaging bookings for today..today+13 (Vancouver),
 * matched to batches by email on the server (D-03). Only whitelisted fields leave; soft-fails with
 * 200 {ok:false, reason} and never caches a failure or a degraded (candidates-failed) result.
 */
router.get('/api/admin/packaging-bookings', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
    res.set('Cache-Control', 'no-store');
    var bottlingId = numEnv('CALCOM_EVENT_TYPE_BOTTLING');
    var packagingId = numEnv('CALCOM_EVENT_TYPE_BEER_PACKAGING');
    var eventTypeIds = [];
    if (bottlingId) eventTypeIds.push(bottlingId);
    if (packagingId) eventTypeIds.push(packagingId);
    if (!process.env.CALCOM_API_KEY || !eventTypeIds.length) {
      return res.json({ ok: false, reason: 'not_configured' });
    }

    var win = packagingBookings.packagingWindow(new Date());
    var key = packagingBookings.cacheKey(win.start);
    var cachedP;
    try { cachedP = Promise.resolve(cache.get(key)).catch(function () { return null; }); } catch (e) { cachedP = Promise.resolve(null); }

    cachedP.then(function (hit) {
      if (hit) return res.json(hit);
      var candidatesFailed = false;
      var candidatesP;
      try { candidatesP = Promise.resolve(batchStore.packagingCandidates()); } catch (e) { candidatesP = Promise.reject(e); }
      candidatesP = candidatesP.then(function (rows) { return rows || []; }, function () {
        candidatesFailed = true;
        return [];
      });
      return Promise.all([
        calcom.listBookings({ eventTypeIds: eventTypeIds, afterStart: win.afterStart, beforeEnd: win.beforeEnd }),
        candidatesP
      ]).then(function (r) {
        var bookings = packagingBookings.shapeBookings(
          r[0].bookings, { bottlingId: bottlingId, packagingId: packagingId }, r[1], win);
        var body = {
          ok: true,
          window: { start: win.start, end: win.end },
          truncated: !!r[0].truncated,
          bookings: bookings
        };
        var matched = bookings.filter(function (b) { return b.batch_id; }).length;
        log.info('[packaging-bookings] ok bookings=' + bookings.length + ' matched=' + matched +
          ' truncated=' + body.truncated);
        if (!candidatesFailed) cache.set(key, body, PACKAGING_CACHE_TTL);
        return res.json(body);
      }, function (err) {
        log.warn('[packaging-bookings] calcom list failed: ' +
          (err && err.response ? 'HTTP ' + err.response.status : (err && err.code) || 'error'));
        return res.json({ ok: false, reason: 'unavailable' });
      });
    }).catch(function () {
      if (!res.headersSent) res.json({ ok: false, reason: 'unavailable' });
    });
  });
});

module.exports = router;

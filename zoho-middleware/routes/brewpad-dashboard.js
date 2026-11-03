'use strict';

var express = require('express');
var authTiers = require('../lib/authTiers');
var batchStore = require('../lib/batch-store');
var kioskBundles = require('../lib/kiosk-bundles');
var log = require('../lib/logger');

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

module.exports = router;

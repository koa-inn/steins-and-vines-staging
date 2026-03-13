var express = require('express');
var crypto = require('crypto');
var axios = require('axios');
var zohoAuth = require('../lib/zohoAuth');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var helcimLib = require('../lib/helcim');
var C = require('../lib/constants');

var OAUTH_STATE_TTL = 600; // 10 minutes

var router = express.Router();

/**
 * GET /auth/zoho
 * Redirects the user to Zoho's OAuth consent screen.
 */
router.get('/auth/zoho', function (req, res) {
  var state = zohoAuth.generateState();
  cache.set(C.CACHE_KEYS.OAUTH_STATE_PREFIX + state, '1', OAUTH_STATE_TTL).catch(function () {});
  res.redirect(zohoAuth.getAuthorizationUrl(state));
});

/**
 * GET /auth/zoho/callback
 * Zoho redirects here with ?code=... after the user grants access.
 */
router.get('/auth/zoho/callback', function (req, res) {
  var code = req.query.code;
  var state = req.query.state;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  if (!state) {
    return res.status(403).json({ error: 'Missing state parameter' });
  }
  var stateKey = C.CACHE_KEYS.OAUTH_STATE_PREFIX + state;
  cache.get(stateKey).then(function (stored) {
    if (!stored) {
      return res.status(403).json({ error: 'Invalid or expired OAuth state' });
    }
    cache.del(stateKey).catch(function () {});
    return zohoAuth.exchangeCode(code)
      .then(function () {
        // In production, redirect to the frontend dashboard instead
        res.json({ ok: true, message: 'Zoho authentication successful' });
      })
      .catch(function (err) {
        log.error('[callback] Token exchange failed: ' + err.message);
        res.status(500).json({ error: 'Authentication failed' });
      });
  }).catch(function (err) {
    log.error('[callback] State validation failed: ' + err.message);
    res.status(500).json({ error: 'Authentication failed' });
  });
});

/**
 * GET /auth/status
 * Quick check: is the server currently authenticated with Zoho?
 */
router.get('/auth/status', function (req, res) {
  res.json({ authenticated: zohoAuth.isAuthenticated() });
});

/**
 * GET /api/payment/config
 * Legacy endpoint — superseded by POST /api/payment/initialize (checkout.js).
 * Returns basic payment status for any older clients that may still call this.
 */
router.get('/api/payment/config', function (req, res) {
  res.json({ enabled: helcimLib.isEnabled(), depositAmount: helcimLib.getDepositAmount() });
});

module.exports = router;

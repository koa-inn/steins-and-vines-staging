var express = require('express');
var crypto = require('crypto');
var axios = require('axios');
var zohoAuth = require('../lib/zohoAuth');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var gpLib = require('../lib/gp');

var OAUTH_STATE_TTL = 600; // 10 minutes

var router = express.Router();

var GP_API_BASE = process.env.GP_ENVIRONMENT === 'production'
  ? 'https://apis.globalpay.com/ucp'
  : 'https://apis.sandbox.globalpay.com/ucp';

/**
 * GET /auth/zoho
 * Redirects the user to Zoho's OAuth consent screen.
 */
router.get('/auth/zoho', function (req, res) {
  var state = zohoAuth.generateState();
  cache.set('zoho:oauth-state:' + state, '1', OAUTH_STATE_TTL).catch(function () {});
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
  var stateKey = 'zoho:oauth-state:' + state;
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
 * Generate a restricted access token for client-side tokenization and return
 * it with the deposit amount. Token expires in 10 minutes.
 * Card data never touches our server — tokenized client-side by @globalpayments/js.
 */
router.get('/api/payment/config', function (req, res) {
  if (!process.env.GP_APP_KEY) {
    return res.json({ enabled: false, depositAmount: gpLib.getDepositAmount() });
  }

  var nonce = String(Date.now());
  var secret = crypto.createHash('sha512').update(nonce + process.env.GP_APP_KEY).digest('hex');

  axios.post(GP_API_BASE + '/accesstoken', {
    app_id: process.env.GP_APP_ID,
    secret: secret,
    grant_type: 'client_credentials',
    nonce: nonce,
    interval_to_expire: '10_MINUTES',
    restricted_token: 'YES',
    permissions: ['PMT_POST_Create_Single']
  }, {
    headers: {
      'Content-Type': 'application/json',
      'X-GP-Version': '2021-03-22'
    },
    timeout: 10000
  })
  .then(function (tokenResp) {
    res.json({
      enabled: true,
      accessToken: tokenResp.data.token,
      env: process.env.GP_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      depositAmount: gpLib.getDepositAmount()
    });
  })
  .catch(function (err) {
    var msg = err.message;
    if (err.response && err.response.data) {
      msg = err.response.data.error_description || err.response.data.message || msg;
    }
    log.error('[payment/config] Access token failed: ' + msg);
    res.status(502).json({ error: 'Payment configuration unavailable', enabled: false });
  });
});

module.exports = router;

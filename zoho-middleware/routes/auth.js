var express = require('express');
var zohoAuth = require('../lib/zohoAuth');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var helcimLib = require('../lib/helcim');
var C = require('../lib/constants');
var googleVerify = require('../lib/googleVerify');
var session = require('../lib/session');
var staffAccess = require('../lib/staff-access');

var OAUTH_STATE_TTL = 600; // 10 minutes
var SESSION_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
  res.json({ enabled: helcimLib.isEnabled(), depositAmount: 0 });
});

/**
 * POST /auth/google
 * Exchanges a Google access token (obtained client-side via the existing GIS
 * flow, js/lib/auth.js — unchanged) for an httpOnly server session cookie.
 *
 * The server independently derives the staff email from the access token via
 * lib/googleVerify.js (T-46-09) — it NEVER reads an email from req.body. Only
 * allowlisted (staffAccess.resolve: STAFF_EMAILS break-glass or staff_access row), Google-verified emails get a session (D-46-07;
 * one flat tier, equal — D-46-08).
 */
router.post('/auth/google', function (req, res) {
  var accessToken = req.body && req.body.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: 'Missing access_token' });
  }

  googleVerify.verifyStaffAccessToken(accessToken)
    .then(function (email) {
      return staffAccess.resolve(email).then(function (decision) {
        if (!decision.allowed) {
          return res.status(403).json({ authorized: false });
        }
        return session.createSession(email).then(function (sid) {
          res.cookie('sv_session', sid, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
            maxAge: SESSION_COOKIE_MAX_AGE_MS,
            path: '/'
          });
          // Also return the session id in the body so cross-site staff surfaces
          // (BrewPad/admin on steinsandvines.ca) can store it and send it as an
          // x-session-token header — the sv_session cookie above is not delivered
          // to this Railway origin cross-site by modern browsers. Same opaque id.
          res.json({ authorized: true, email: email, token: sid });
        });
      });
    })
    .catch(function (err) {
      log.warn('[auth/google] verification failed: ' + err.message);
      res.status(401).json({ authorized: false });
    });
});

/**
 * POST /auth/logout
 * Destroys the caller's server-side session (if any) and clears the cookie.
 *
 * Note: reading req.cookies requires cookie-parser, mounted in 46-03. Guarded
 * here so this route degrades safely (no-op destroy) if called before that
 * middleware is wired up.
 */
router.post('/auth/logout', function (req, res) {
  var sid = req.cookies && req.cookies.sv_session;
  res.clearCookie('sv_session', { path: '/' });
  if (!sid) {
    return res.json({ ok: true });
  }
  session.destroySession(sid).then(function () {
    res.json({ ok: true });
  }).catch(function (err) {
    log.error('[auth/logout] destroySession failed: ' + err.message);
    res.json({ ok: true });
  });
});

module.exports = router;

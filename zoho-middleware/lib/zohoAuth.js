/**
 * Zoho OAuth 2.0 authentication module.
 *
 * Handles the full OAuth flow:
 *   1. Generate authorization URL → user grants access
 *   2. Exchange authorization code for access + refresh tokens
 *   3. Auto-refresh access token before it expires (60 min lifetime)
 *
 * Tokens are held in memory. For production you'd persist the
 * refresh token to a database or encrypted file.
 */

var https = require('https');
var querystring = require('querystring');

// Zoho accounts base URL — varies by data center
var ACCOUNTS_URLS = {
  '.com':    'https://accounts.zoho.com',
  '.eu':     'https://accounts.zoho.eu',
  '.in':     'https://accounts.zoho.in',
  '.com.au': 'https://accounts.zoho.com.au',
  '.ca':     'https://accounts.zohocloud.ca',
  '.jp':     'https://accounts.zoho.jp',
  '.sa':     'https://accounts.zoho.sa'
};

function accountsBase() {
  var domain = process.env.ZOHO_DOMAIN || '.com';
  return ACCOUNTS_URLS[domain] || ('https://accounts.zoho' + domain);
}

// Token state
var tokens = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0 // epoch ms
};

// Refresh ~5 minutes before actual expiry to avoid race conditions
var REFRESH_BUFFER_MS = 5 * 60 * 1000;

var refreshTimer = null;

/**
 * Build the Zoho authorization URL that the user should visit.
 */
function getAuthorizationUrl() {
  var params = querystring.stringify({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoBooks.fullaccess.all',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: 'offline',   // gives us a refresh token
    prompt: 'consent'          // always show consent screen
  });
  return accountsBase() + '/oauth/v2/auth?' + params;
}

/**
 * POST helper for Zoho token endpoints.
 * Uses built-in https — no external HTTP library needed.
 */
function postToken(params) {
  return new Promise(function (resolve, reject) {
    var body = querystring.stringify(params);
    var url = new URL(accountsBase() + '/oauth/v2/token');

    var options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    var req = https.request(options, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        try {
          var data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) {
            reject(new Error(data.error));
          } else {
            resolve(data);
          }
        } catch (e) {
          reject(new Error('Failed to parse Zoho token response'));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Exchange an authorization code for access + refresh tokens.
 * Called once after the user completes the OAuth consent flow.
 */
function exchangeCode(code) {
  return postToken({
    grant_type: 'authorization_code',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    code: code
  }).then(function (data) {
    tokens.accessToken = data.access_token;
    tokens.refreshToken = data.refresh_token;
    tokens.expiresAt = Date.now() + (data.expires_in * 1000);

    scheduleRefresh(data.expires_in);

    console.log('[zoho-auth] Tokens acquired — expires in ' + data.expires_in + 's');
    return tokens;
  });
}

/**
 * Use the stored refresh token to get a fresh access token.
 */
function refreshAccessToken() {
  if (!tokens.refreshToken) {
    return Promise.reject(new Error('No refresh token — complete OAuth flow first'));
  }

  return postToken({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: tokens.refreshToken
  }).then(function (data) {
    tokens.accessToken = data.access_token;
    tokens.expiresAt = Date.now() + (data.expires_in * 1000);

    scheduleRefresh(data.expires_in);

    console.log('[zoho-auth] Access token refreshed — expires in ' + data.expires_in + 's');
    return tokens;
  });
}

/**
 * Schedule the next automatic refresh.
 */
function scheduleRefresh(expiresInSec) {
  if (refreshTimer) clearTimeout(refreshTimer);

  var refreshInMs = (expiresInSec * 1000) - REFRESH_BUFFER_MS;
  if (refreshInMs < 10000) refreshInMs = 10000; // minimum 10s

  refreshTimer = setTimeout(function () {
    refreshAccessToken().catch(function (err) {
      console.error('[zoho-auth] Auto-refresh failed:', err.message);
    });
  }, refreshInMs);
}

/**
 * Get a valid access token, refreshing if needed.
 * Use this before every Zoho API call.
 */
function getAccessToken() {
  if (!tokens.accessToken) {
    return Promise.reject(new Error('Not authenticated — complete OAuth flow first'));
  }

  // If token is still fresh, return it
  if (Date.now() < tokens.expiresAt - REFRESH_BUFFER_MS) {
    return Promise.resolve(tokens.accessToken);
  }

  // Otherwise refresh now
  return refreshAccessToken().then(function () {
    return tokens.accessToken;
  });
}

/**
 * Check whether we currently hold a valid token set.
 */
function isAuthenticated() {
  return !!(tokens.accessToken && tokens.refreshToken);
}

/**
 * Manually set a refresh token (e.g. loaded from persistent storage on startup).
 */
function setRefreshToken(rt) {
  tokens.refreshToken = rt;
}

module.exports = {
  getAuthorizationUrl: getAuthorizationUrl,
  exchangeCode: exchangeCode,
  refreshAccessToken: refreshAccessToken,
  getAccessToken: getAccessToken,
  isAuthenticated: isAuthenticated,
  setRefreshToken: setRefreshToken
};

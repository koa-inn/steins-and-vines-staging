/**
 * Zoho OAuth 2.0 authentication module.
 *
 * Handles the full OAuth flow:
 *   1. Generate authorization URL → user grants access
 *   2. Exchange authorization code for access + refresh tokens
 *   3. Auto-refresh access token before it expires (60 min lifetime)
 *
 * The refresh token is persisted to Redis so it survives server restarts.
 */

var https = require('https');
var querystring = require('querystring');
var crypto = require('crypto');
var cache = require('./cache');
var C = require('./constants');

// ---------------------------------------------------------------------------
// Refresh token encryption (AES-256-GCM)
// ---------------------------------------------------------------------------
// Set REDIS_ENCRYPTION_KEY in .env as a 64-character hex string (32 bytes).
// If the key is absent or malformed the encrypt/decrypt functions are no-ops,
// so the system continues to work without encryption (plaintext fallback).
// The decrypt function also accepts legacy plaintext values that predate this
// change — identified by the absence of ':' separators — so the first deploy
// after enabling the key requires no data migration.

var ENCRYPTION_KEY_ENV = 'REDIS_ENCRYPTION_KEY'; // 32-byte hex string in .env
var ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
  var key = Buffer.from(process.env[ENCRYPTION_KEY_ENV] || '', 'hex');
  if (key.length !== 32) return text; // no-op if key not configured
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  var encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(ciphertext) {
  var key = Buffer.from(process.env[ENCRYPTION_KEY_ENV] || '', 'hex');
  if (key.length !== 32 || !ciphertext.includes(':')) return ciphertext; // passthrough for plaintext legacy
  var parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  var iv = Buffer.from(parts[0], 'hex');
  var tag = Buffer.from(parts[1], 'hex');
  var encrypted = Buffer.from(parts[2], 'hex');
  try {
    var decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
  } catch (e) {
    return null;
  }
}

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

// Shared in-flight refresh promise — coalesces concurrent callers
var _refreshPromise = null;

// Refresh ~5 minutes before actual expiry to avoid race conditions
var REFRESH_BUFFER_MS = 5 * 60 * 1000;

var refreshTimer = null;

/**
 * Build the Zoho authorization URL that the user should visit.
 */
function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

function getAuthorizationUrl(state) {
  var params = querystring.stringify({
    response_type: 'code',
    client_id: process.env.ZOHO_CLIENT_ID,
    scope: 'ZohoBooks.fullaccess.all,ZohoInventory.fullaccess.all,zohobookings.data.CREATE,zohobookings.data.READ',
    redirect_uri: process.env.ZOHO_REDIRECT_URI,
    access_type: 'offline',   // gives us a refresh token
    prompt: 'consent',         // always show consent screen
    state: state || ''
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
var REFRESH_TOKEN_CACHE_KEY = C.CACHE_KEYS.REFRESH_TOKEN;
var REFRESH_TOKEN_TTL = 60 * 60 * 24 * 90; // 90 days

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

    // Persist refresh token to Redis (encrypted at rest when REDIS_ENCRYPTION_KEY is set)
    cache.set(REFRESH_TOKEN_CACHE_KEY, encrypt(data.refresh_token), REFRESH_TOKEN_TTL);

    // Persist access token + expiry to Redis for cross-instance sharing
    var ttl = data.expires_in - 60;
    try {
      cache.set(C.CACHE_KEYS.ACCESS_TOKEN, data.access_token, ttl);
      cache.set(C.CACHE_KEYS.TOKEN_EXPIRY, String(Date.now() + ttl * 1000), ttl);
    } catch (e) {
      // Redis unavailable — in-memory only
    }

    scheduleRefresh(data.expires_in);

    console.log('[zoho-auth] Tokens acquired — expires in ' + data.expires_in + 's');
    return tokens;
  });
}

/**
 * Use the stored refresh token to get a fresh access token.
 * Uses a distributed Redis lock so concurrent Railway instances don't
 * all refresh simultaneously.
 */
function refreshAccessToken() {
  if (!tokens.refreshToken) {
    return Promise.reject(new Error('No refresh token — complete OAuth flow first'));
  }

  // Acquire distributed refresh lock (30s TTL) — falls back to true if Redis is down
  return cache.acquireLock(C.CACHE_KEYS.REFRESH_LOCK, 30).then(function (locked) {
    if (!locked) {
      // Another instance holds the lock — wait 1.5s then retry getAccessToken()
      // which will either find the freshly-written Redis token or retry again
      return new Promise(function (resolve) { setTimeout(resolve, 1500); }).then(function () {
        return getAccessToken();
      });
    }

    return postToken({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: tokens.refreshToken
    }).then(function (data) {
      tokens.accessToken = data.access_token;
      tokens.expiresAt = Date.now() + (data.expires_in * 1000);

      // Persist access token + expiry to Redis so other instances can use it
      var ttl = data.expires_in - 60;
      try {
        cache.set(C.CACHE_KEYS.ACCESS_TOKEN, data.access_token, ttl);
        cache.set(C.CACHE_KEYS.TOKEN_EXPIRY, String(Date.now() + ttl * 1000), ttl);
      } catch (e) {
        // Redis unavailable — in-memory only is fine
      }

      scheduleRefresh(data.expires_in);

      console.log('[zoho-auth] Access token refreshed — expires in ' + data.expires_in + 's');
      return tokens;
    }).finally(function () {
      cache.releaseLock(C.CACHE_KEYS.REFRESH_LOCK).catch(function () {});
    });
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
 * Checks Redis first when in-memory token is absent or stale so that
 * multiple Railway instances can share one freshly-refreshed token.
 * Use this before every Zoho API call.
 */
function getAccessToken() {
  // If in-memory token is still fresh, return it immediately
  if (tokens.accessToken && Date.now() < tokens.expiresAt - REFRESH_BUFFER_MS) {
    return Promise.resolve(tokens.accessToken);
  }

  // Try Redis for a token written by another instance
  return Promise.resolve().then(function () {
    try {
      return cache.get(C.CACHE_KEYS.ACCESS_TOKEN).then(function (redisToken) {
        if (redisToken) {
          return cache.get(C.CACHE_KEYS.TOKEN_EXPIRY).then(function (redisExpiry) {
            var expiry = redisExpiry ? parseInt(redisExpiry, 10) : 0;
            if (expiry && Date.now() < expiry - REFRESH_BUFFER_MS) {
              // Redis token is still fresh — hydrate in-memory state and return
              tokens.accessToken = redisToken;
              tokens.expiresAt = expiry;
              return redisToken;
            }
            return null;
          });
        }
        return null;
      });
    } catch (e) {
      return null;
    }
  }).then(function (cachedToken) {
    if (cachedToken) return cachedToken;

    // No fresh token available — must authenticate or refresh
    if (!tokens.accessToken && !tokens.refreshToken) {
      return Promise.reject(new Error('Not authenticated — complete OAuth flow first'));
    }

    if (!tokens.refreshToken) {
      return Promise.reject(new Error('Not authenticated — complete OAuth flow first'));
    }

    // Refresh now — coalesce concurrent callers to one request
    if (!_refreshPromise) {
      _refreshPromise = refreshAccessToken().then(function () {
        _refreshPromise = null;
        return tokens.accessToken;
      }, function (err) {
        _refreshPromise = null;
        throw err;
      });
    }
    return _refreshPromise;
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

/**
 * Initialize auth by loading the refresh token from Redis.
 * If found, immediately refreshes to get a fresh access token.
 */
function init() {
  return cache.get(REFRESH_TOKEN_CACHE_KEY).then(function (rt) {
    if (rt) {
      console.log('[zoho-auth] Refresh token loaded from Redis — refreshing access token');
      tokens.refreshToken = decrypt(rt);
      return refreshAccessToken().catch(function (err) {
        console.error('[zoho-auth] Auto-refresh on startup failed:', err.message);
      });
    }
    console.log('[zoho-auth] No saved refresh token — visit /auth/zoho to connect');
    return null;
  });
}

module.exports = {
  generateState: generateState,
  getAuthorizationUrl: getAuthorizationUrl,
  exchangeCode: exchangeCode,
  refreshAccessToken: refreshAccessToken,
  getAccessToken: getAccessToken,
  isAuthenticated: isAuthenticated,
  setRefreshToken: setRefreshToken,
  init: init,
  // Exported for testing
  encrypt: encrypt,
  decrypt: decrypt
};

require('dotenv').config();

var express = require('express');
var cors = require('cors');
var axios = require('axios');
var zohoAuth = require('./lib/zohoAuth');
var cache = require('./lib/cache');

var app = express();
var PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

/**
 * GET /auth/zoho
 * Redirects the user to Zoho's OAuth consent screen.
 */
app.get('/auth/zoho', function (req, res) {
  res.redirect(zohoAuth.getAuthorizationUrl());
});

/**
 * GET /auth/zoho/callback
 * Zoho redirects here with ?code=... after the user grants access.
 */
app.get('/auth/zoho/callback', function (req, res) {
  var code = req.query.code;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  zohoAuth.exchangeCode(code)
    .then(function () {
      // In production, redirect to the frontend dashboard instead
      res.json({ ok: true, message: 'Zoho authentication successful' });
    })
    .catch(function (err) {
      console.error('[callback] Token exchange failed:', err.message);
      res.status(500).json({ error: 'Token exchange failed: ' + err.message });
    });
});

/**
 * GET /auth/status
 * Quick check: is the server currently authenticated with Zoho?
 */
app.get('/auth/status', function (req, res) {
  res.json({ authenticated: zohoAuth.isAuthenticated() });
});

// ---------------------------------------------------------------------------
// Auth guard — protects all /api/* routes below
// ---------------------------------------------------------------------------

app.use('/api', function (req, res, next) {
  if (!zohoAuth.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated. Visit /auth/zoho to connect.' });
  }
  next();
});

// ---------------------------------------------------------------------------
// Zoho Books API proxy helpers
// ---------------------------------------------------------------------------

var ZOHO_API_BASE = 'https://www.zohoapis' + (process.env.ZOHO_DOMAIN || '.com') + '/books/v3';

/**
 * Proxy a GET request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    var query = Object.assign({ organization_id: process.env.ZOHO_ORG_ID }, params || {});
    return axios.get(ZOHO_API_BASE + path, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: query
    }).then(function (response) {
      return response.data;
    });
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

var PRODUCTS_CACHE_KEY = 'zoho:products';
var PRODUCTS_CACHE_TTL = 300; // 5 minutes in seconds

/**
 * GET /api/products
 * Returns active items from Zoho Inventory, cached in Redis for 5 minutes.
 */
app.get('/api/products', function (req, res) {
  cache.get(PRODUCTS_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        console.log('[api/products] Cache hit');
        return res.json({ source: 'cache', items: cached });
      }

      console.log('[api/products] Cache miss — fetching from Zoho');
      return zohoGet('/items', { status: 'active' })
        .then(function (data) {
          var items = data.items || [];

          // Store in Redis (fire-and-forget — don't block the response)
          cache.set(PRODUCTS_CACHE_KEY, items, PRODUCTS_CACHE_TTL);

          res.json({ source: 'zoho', items: items });
        });
    })
    .catch(function (err) {
      console.error('[api/products]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/items
 * Fetch inventory items from Zoho Books (uncached, all statuses).
 */
app.get('/api/items', function (req, res) {
  zohoGet('/items')
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      console.error('[api/items]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/contacts
 * Fetch contacts (customers/vendors) from Zoho Books.
 */
app.get('/api/contacts', function (req, res) {
  zohoGet('/contacts')
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      console.error('[api/contacts]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/invoices
 * Fetch invoices from Zoho Books.
 */
app.get('/api/invoices', function (req, res) {
  zohoGet('/invoices')
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      console.error('[api/invoices]', err.message);
      res.status(502).json({ error: err.message });
    });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    authenticated: zohoAuth.isAuthenticated(),
    uptime: process.uptime()
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Connect Redis, then start listening
cache.init().then(function () {
  app.listen(PORT, function () {
    console.log('');
    console.log('  Zoho middleware running on http://localhost:' + PORT);
    console.log('  Health check:   http://localhost:' + PORT + '/health');
    console.log('  Connect Zoho:   http://localhost:' + PORT + '/auth/zoho');
    console.log('');
  });
});

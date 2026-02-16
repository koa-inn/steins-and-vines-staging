require('dotenv').config();

var express = require('express');
var cors = require('cors');
var axios = require('axios');
var crypto = require('crypto');
var zohoAuth = require('./lib/zohoAuth');
var cache = require('./lib/cache');
var gp = require('globalpayments-api');

var ServicesContainer = gp.ServicesContainer;
var GpApiConfig = gp.GpApiConfig;
var CreditCardData = gp.CreditCardData;
var Transaction = gp.Transaction;
var Channel = gp.Channel;
var Environment = gp.Environment;
var ConnectionConfig = gp.ConnectionConfig;
var DeviceService = gp.DeviceService;
var DeviceType = gp.DeviceType;
var ConnectionModes = gp.ConnectionModes;

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

// Health check (used by Railway)
app.get('/health', function (req, res) { res.json({ status: 'ok' }); });

// ---------------------------------------------------------------------------
// Global Payments (GP-API) SDK initialization
// ---------------------------------------------------------------------------

var GP_DEPOSIT_AMOUNT = parseFloat(process.env.GP_DEPOSIT_AMOUNT) || 50.00;

if (process.env.GP_APP_KEY) {
  var gpConfig = new GpApiConfig();
  gpConfig.appId = process.env.GP_APP_ID || '';
  gpConfig.appKey = process.env.GP_APP_KEY;
  gpConfig.channel = Channel.CardNotPresent;
  gpConfig.country = 'CA';
  gpConfig.deviceCurrency = 'CAD';
  gpConfig.environment = process.env.GP_ENVIRONMENT === 'production'
    ? Environment.Production : Environment.Test;
  if (process.env.GP_MERCHANT_ID) {
    gpConfig.merchantId = process.env.GP_MERCHANT_ID;
  }
  ServicesContainer.configureService(gpConfig);
  console.log('  Global Payments SDK configured (deposit: $' + GP_DEPOSIT_AMOUNT.toFixed(2) + ')');
} else {
  console.log('  Global Payments SDK not configured (GP_APP_KEY missing)');
}

// ---------------------------------------------------------------------------
// Global Payments Terminal (card-present via Meet in the Cloud)
// ---------------------------------------------------------------------------

var GP_TERMINAL_ENABLED = process.env.GP_TERMINAL_ENABLED === 'true';
var gpTerminalDevice = null;

if (GP_TERMINAL_ENABLED && process.env.GP_APP_KEY) {
  try {
    var terminalConfig = new ConnectionConfig();
    terminalConfig.deviceType = DeviceType.UPA_DEVICE;
    terminalConfig.connectionMode = ConnectionModes.MEET_IN_THE_CLOUD;

    var terminalGateway = new GpApiConfig();
    terminalGateway.appId = process.env.GP_APP_ID || '';
    terminalGateway.appKey = process.env.GP_APP_KEY;
    terminalGateway.channel = Channel.CardPresent;
    terminalGateway.country = 'CA';
    terminalGateway.deviceCurrency = 'CAD';
    terminalGateway.environment = process.env.GP_ENVIRONMENT === 'production'
      ? Environment.Production : Environment.Test;
    if (process.env.GP_MERCHANT_ID) {
      terminalGateway.merchantId = process.env.GP_MERCHANT_ID;
    }

    terminalConfig.gatewayConfig = terminalGateway;
    gpTerminalDevice = DeviceService.create(terminalConfig, 'terminal');
    console.log('  GP Terminal configured (Meet in the Cloud)');
  } catch (termErr) {
    console.error('  GP Terminal configuration failed:', termErr.message);
    gpTerminalDevice = null;
  }
} else {
  console.log('  GP Terminal not enabled (GP_TERMINAL_ENABLED=' + (process.env.GP_TERMINAL_ENABLED || 'false') + ')');
}

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
// Public API routes (no Zoho auth required)
// ---------------------------------------------------------------------------

var GP_API_BASE = process.env.GP_ENVIRONMENT === 'production'
  ? 'https://apis.globalpay.com/ucp'
  : 'https://apis.sandbox.globalpay.com/ucp';

/**
 * GET /api/payment/config
 * Generate a restricted access token for client-side tokenization and return
 * it with the deposit amount. Token expires in 10 minutes.
 * Card data never touches our server — tokenized client-side by @globalpayments/js.
 */
app.get('/api/payment/config', function (req, res) {
  if (!process.env.GP_APP_KEY) {
    return res.json({ enabled: false, depositAmount: GP_DEPOSIT_AMOUNT });
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
    }
  })
  .then(function (tokenResp) {
    res.json({
      enabled: true,
      accessToken: tokenResp.data.token,
      env: process.env.GP_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
      depositAmount: GP_DEPOSIT_AMOUNT
    });
  })
  .catch(function (err) {
    var msg = err.message;
    if (err.response && err.response.data) {
      msg = err.response.data.error_description || err.response.data.message || msg;
    }
    console.error('[payment/config] Access token failed:', msg);
    res.status(502).json({ error: 'Payment config failed: ' + msg, enabled: false });
  });
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

var API_URLS = {
  '.com':    'https://www.zohoapis.com',
  '.eu':     'https://www.zohoapis.eu',
  '.in':     'https://www.zohoapis.in',
  '.com.au': 'https://www.zohoapis.com.au',
  '.ca':     'https://www.zohoapis.ca',
  '.jp':     'https://www.zohoapis.jp',
  '.sa':     'https://www.zohoapis.sa'
};

var apiDomain = process.env.ZOHO_DOMAIN || '.com';
var ZOHO_API_BASE = (API_URLS[apiDomain] || ('https://www.zohoapis' + apiDomain)) + '/books/v3';
var ZOHO_INVENTORY_BASE = (API_URLS[apiDomain] || ('https://www.zohoapis' + apiDomain)) + '/inventory/v1';

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

/**
 * Proxy a POST request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoPost(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return axios.post(ZOHO_API_BASE + path, body, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }).then(function (response) {
      return response.data;
    });
  });
}

/**
 * Proxy a PUT request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoPut(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return axios.put(ZOHO_API_BASE + path, body, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }).then(function (response) {
      return response.data;
    });
  });
}

/**
 * Proxy a GET request to the Zoho Inventory API.
 */
function inventoryGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    var query = Object.assign({ organization_id: process.env.ZOHO_ORG_ID }, params || {});
    return axios.get(ZOHO_INVENTORY_BASE + path, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: query
    }).then(function (response) {
      return response.data;
    });
  });
}

/**
 * Proxy a PUT request to the Zoho Inventory API.
 */
function inventoryPut(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return axios.put(ZOHO_INVENTORY_BASE + path, body, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: { organization_id: process.env.ZOHO_ORG_ID }
    }).then(function (response) {
      return response.data;
    });
  });
}

// ---------------------------------------------------------------------------
// Zoho Bookings API helpers
// ---------------------------------------------------------------------------

var BOOKINGS_API_BASE = (API_URLS[apiDomain] || ('https://www.zohoapis' + apiDomain)) + '/bookings/v1/json';

/**
 * Proxy a GET request to the Zoho Bookings API.
 * Bookings API does not require organization_id.
 */
function bookingsGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    return axios.get(BOOKINGS_API_BASE + path, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token },
      params: params || {}
    }).then(function (response) {
      return response.data;
    });
  });
}

/**
 * Proxy a POST request to the Zoho Bookings API.
 * Bookings API does not require organization_id.
 */
function bookingsPost(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return axios.post(BOOKINGS_API_BASE + path, body, {
      headers: { Authorization: 'Zoho-oauthtoken ' + token }
    }).then(function (response) {
      return response.data;
    });
  });
}

/**
 * Convert 12-hour time string to 24-hour format.
 * "10:00 AM" → "10:00:00", "2:30 PM" → "14:30:00"
 */
function normalizeTimeTo24h(timeStr) {
  var match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return timeStr; // already 24h or unrecognized
  var h = parseInt(match[1], 10);
  var m = match[2];
  var period = match[3].toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return String(h).padStart(2, '0') + ':' + m + ':00';
}

// ---------------------------------------------------------------------------
// API routes — Bookings
// ---------------------------------------------------------------------------

var AVAILABILITY_CACHE_PREFIX = 'zoho:availability:';
var AVAILABILITY_CACHE_TTL = 300; // 5 minutes

/**
 * GET /api/bookings/services
 * List all services and staff from Zoho Bookings (debug/setup helper).
 */
app.get('/api/bookings/services', function (req, res) {
  Promise.all([
    bookingsGet('/services'),
    bookingsGet('/staffs')
  ])
    .then(function (results) {
      var services = (results[0].response && results[0].response.returnvalue &&
        results[0].response.returnvalue.data) || [];
      var staff = (results[1].response && results[1].response.returnvalue &&
        results[1].response.returnvalue.data) || [];
      res.json({ services: services, staff: staff });
    })
    .catch(function (err) {
      console.error('[api/bookings/services]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/bookings/availability?year=YYYY&month=MM
 * Returns which dates in a month have available slots.
 * Cached in Redis for 5 minutes.
 */
app.get('/api/bookings/availability', function (req, res) {
  var year = req.query.year;
  var month = req.query.month;

  if (!year || !month) {
    return res.status(400).json({ error: 'Missing year or month query parameter' });
  }

  month = String(month).padStart(2, '0');
  var cacheKey = AVAILABILITY_CACHE_PREFIX + year + '-' + month;

  cache.get(cacheKey)
    .then(function (cached) {
      if (cached) {
        console.log('[api/bookings/availability] Cache hit for ' + year + '-' + month);
        return res.json({ source: 'cache', dates: cached });
      }

      console.log('[api/bookings/availability] Cache miss — fetching from Zoho');

      // Calculate all dates in the month
      var daysInMonth = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
      var datePromises = [];

      for (var d = 1; d <= daysInMonth; d++) {
        var dateStr = year + '-' + month + '-' + String(d).padStart(2, '0');
        datePromises.push(
          (function (ds) {
            return bookingsGet('/availableslots', {
              service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
              staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
              selected_date: ds
            }).then(function (data) {
              var slots = (data.response && data.response.returnvalue &&
                data.response.returnvalue.data) || [];
              return { date: ds, available: slots.length > 0, slots_count: slots.length };
            }).catch(function () {
              return { date: ds, available: false, slots_count: 0 };
            });
          })(dateStr)
        );
      }

      return Promise.all(datePromises).then(function (results) {
        var dates = results.filter(function (r) { return r.available; });

        cache.set(cacheKey, dates, AVAILABILITY_CACHE_TTL);

        res.json({ source: 'zoho', dates: dates });
      });
    })
    .catch(function (err) {
      console.error('[api/bookings/availability]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/bookings/slots?date=YYYY-MM-DD
 * Fetch available time slots for a specific date.
 */
app.get('/api/bookings/slots', function (req, res) {
  var date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: 'Missing date query parameter' });
  }

  bookingsGet('/availableslots', {
    service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
    staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
    selected_date: date
  })
    .then(function (data) {
      var slots = (data.response && data.response.returnvalue &&
        data.response.returnvalue.data) || [];
      res.json({ date: date, slots: slots });
    })
    .catch(function (err) {
      console.error('[api/bookings/slots]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * POST /api/bookings
 * Create an appointment in Zoho Bookings.
 *
 * Expected body:
 * {
 *   date: "YYYY-MM-DD",
 *   time: "10:00 AM",
 *   customer: { name: "...", email: "...", phone: "..." },
 *   notes: "optional"
 * }
 */
app.post('/api/bookings', function (req, res) {
  var body = req.body;

  if (!body || !body.date || !body.time) {
    return res.status(400).json({ error: 'Missing date or time' });
  }
  if (!body.customer || !body.customer.name || !body.customer.email) {
    return res.status(400).json({ error: 'Missing customer name or email' });
  }

  var time24 = normalizeTimeTo24h(body.time);

  var bookingPayload = {
    service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
    staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
    from_time: body.date + ' ' + time24,
    customer_details: {
      name: body.customer.name,
      email: body.customer.email,
      phone_number: body.customer.phone || ''
    },
    additional_fields: {
      notes: body.notes || ''
    }
  };

  bookingsPost('/appointment', bookingPayload)
    .then(function (data) {
      var appointment = (data.response && data.response.returnvalue) || {};

      // Invalidate availability cache for this month
      var ym = body.date.substring(0, 7).split('-');
      cache.del(AVAILABILITY_CACHE_PREFIX + ym[0] + '-' + ym[1]);

      res.status(201).json({
        ok: true,
        booking_id: appointment.booking_id || null,
        timeslot: body.date + ' ' + body.time
      });
    })
    .catch(function (err) {
      var message = err.message;
      if (err.response && err.response.data) {
        message = err.response.data.message || err.response.data.error || message;
      }
      console.error('[api/bookings POST]', message);
      res.status(502).json({ error: message });
    });
});

/**
 * POST /api/contacts
 * Find an existing Zoho Books contact by email, or create a new one.
 *
 * Expected body:
 * { name: "...", email: "...", phone: "..." }
 *
 * Returns: { contact_id: "..." }
 */
app.post('/api/contacts', function (req, res) {
  var body = req.body;
  if (!body || !body.email) {
    return res.status(400).json({ error: 'Missing email' });
  }

  // Search for existing contact by email
  zohoGet('/contacts', { email: body.email })
    .then(function (data) {
      var contacts = data.contacts || [];
      if (contacts.length > 0) {
        return res.json({ contact_id: contacts[0].contact_id, created: false });
      }

      // Not found by email — create new contact
      var contactPayload = {
        contact_name: body.name || body.email,
        contact_type: 'customer',
        email: body.email,
        phone: body.phone || ''
      };

      return zohoPost('/contacts', contactPayload)
        .then(function (createData) {
          var contact = createData.contact || {};
          res.status(201).json({ contact_id: contact.contact_id, created: true });
        })
        .catch(function (createErr) {
          // If name already exists, search by name and return that contact
          var msg = '';
          if (createErr.response && createErr.response.data) {
            msg = createErr.response.data.message || '';
          }
          if (msg.indexOf('already exists') !== -1) {
            return zohoGet('/contacts', { contact_name: body.name })
              .then(function (nameData) {
                var nameContacts = nameData.contacts || [];
                if (nameContacts.length > 0) {
                  return res.json({ contact_id: nameContacts[0].contact_id, created: false });
                }
                throw createErr; // couldn't find by name either
              });
          }
          throw createErr;
        });
    })
    .catch(function (err) {
      var message = err.message;
      if (err.response && err.response.data) {
        message = err.response.data.message || err.response.data.error || message;
      }
      console.error('[api/contacts POST]', message);
      res.status(502).json({ error: message });
    });
});

// ---------------------------------------------------------------------------
// API routes — Zoho Books
// ---------------------------------------------------------------------------

var PRODUCTS_CACHE_KEY = 'zoho:products';
var PRODUCTS_CACHE_TTL = 3600; // 1 hour hard TTL
var PRODUCTS_SOFT_TTL = 600;   // 10 minutes — triggers background refresh
var PRODUCTS_CACHE_TS_KEY = 'zoho:products:ts'; // timestamp of last enrichment
var PRODUCT_IMAGE_HASHES_KEY = 'zoho:product-image-hashes'; // image change detection
var _productsRefreshing = false; // prevent concurrent background refreshes

// In-memory set of kit item IDs (populated by GET /api/products).
// Used by /api/ingredients to exclude kits even when Redis is down.
var _kitItemIds = {};

/**
 * GET /api/products
 * Returns active product items from Zoho Inventory, enriched with custom_fields
 * and brand from the detail endpoint. Cached in Redis for 10 minutes.
 *
 * The list endpoint does not return custom_fields, so we fetch each item's
 * detail (5 concurrent) to get type, subcategory, tasting notes, body, oak,
 * sweetness, ABV, etc. Services and Ingredients groups are filtered out.
 */
function refreshProducts() {
  if (_productsRefreshing) {
    console.log('[api/products] Background refresh already in progress, skipping');
    return Promise.resolve();
  }
  _productsRefreshing = true;
  console.log('[api/products] Refreshing product data from Zoho Inventory');

  return fetchAllItems({ status: 'active' })
    .then(function (items) {
      var serialPattern = /\s—\s[A-Z]+-\d+$/;
      items = items.filter(function (item) {
        if (item.product_type === 'service') return false;
        if (serialPattern.test(item.group_name || '')) return false;
        return true;
      });

      console.log('[api/products] Enriching ' + items.length + ' items (parallel batches of 5)');

      var BATCH_SIZE = 5;
      var BATCH_PAUSE = 3500; // ms between batches (~85 req/min)
      var MAX_RETRIES = 2;
      var enriched = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      function fetchDetail(item, retries) {
        return inventoryGet('/items/' + item.item_id)
          .then(function (data) {
            var detail = data.item || {};
            item.custom_fields = detail.custom_fields || [];
            item.brand = detail.brand || '';
            item.image_name = detail.image_name || '';
            return item;
          })
          .catch(function (err) {
            if (err.response && err.response.status === 429 && retries < MAX_RETRIES) {
              var backoff = Math.pow(2, retries + 1) * 1000;
              console.log('[api/products] Rate limited on ' + item.name + ', retrying in ' + backoff + 'ms');
              return delay(backoff).then(function () { return fetchDetail(item, retries + 1); });
            }
            console.error('[api/products] Detail fetch failed for ' + item.name + ':', err.message);
            item.custom_fields = [];
            item.brand = item.brand || '';
            return item;
          });
      }

      // Process items in parallel batches
      var batches = [];
      for (var i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push(items.slice(i, i + BATCH_SIZE));
      }

      var chain = Promise.resolve();
      batches.forEach(function (batch, idx) {
        chain = chain.then(function () {
          return Promise.all(batch.map(function (item) {
            return fetchDetail(item, 0);
          })).then(function (results) {
            results.forEach(function (r) { enriched.push(r); });
            // Pause between batches (skip after last batch)
            if (idx < batches.length - 1) return delay(BATCH_PAUSE);
          });
        });
      });

      return chain.then(function () {
        enriched = enriched.filter(function (item) {
          return (item.custom_fields || []).some(function (cf) {
            return cf.label === 'Type' && cf.value;
          });
        });
        _kitItemIds = {};
        enriched.forEach(function (item) { _kitItemIds[item.item_id] = true; });
        cache.set(PRODUCTS_CACHE_KEY, enriched, PRODUCTS_CACHE_TTL);
        cache.set(PRODUCTS_CACHE_TS_KEY, Date.now(), PRODUCTS_CACHE_TTL);
        console.log('[api/products] Cached ' + enriched.length + ' kit items');

        // --- Image change detection ---
        // Build a map of item_id → image_name from the enriched detail data.
        // The detail endpoint includes image_name when an item has an image.
        var currentImageMap = {};
        enriched.forEach(function (item) {
          if (item.image_name) {
            currentImageMap[item.item_id] = item.image_name;
          }
        });

        // Compare against the previously cached image map (fire-and-forget)
        cache.get(PRODUCT_IMAGE_HASHES_KEY)
          .then(function (previousImageMap) {
            previousImageMap = previousImageMap || {};
            var changed = [];
            var newImages = [];

            Object.keys(currentImageMap).forEach(function (itemId) {
              if (!previousImageMap[itemId]) {
                newImages.push(itemId);
              } else if (previousImageMap[itemId] !== currentImageMap[itemId]) {
                changed.push(itemId);
              }
            });

            if (changed.length > 0 || newImages.length > 0) {
              console.log('[api/products] Image changes detected (' +
                changed.length + ' changed, ' + newImages.length + ' new) ' +
                '— run sync-images to update');
            }

            // Store the new image map in Redis (same TTL as products cache)
            return cache.set(PRODUCT_IMAGE_HASHES_KEY, currentImageMap, PRODUCTS_CACHE_TTL);
          })
          .catch(function (imgErr) {
            console.error('[api/products] Image change detection error:', imgErr.message);
          });

        _productsRefreshing = false;
        return enriched;
      });
    })
    .catch(function (err) {
      _productsRefreshing = false;
      throw err;
    });
}

app.get('/api/products', function (req, res) {
  cache.get(PRODUCTS_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        console.log('[api/products] Cache hit (' + cached.length + ' items)');
        if (!Object.keys(_kitItemIds).length) {
          cached.forEach(function (item) { _kitItemIds[item.item_id] = true; });
        }
        res.json({ source: 'cache', items: cached });

        // Stale-while-revalidate: if cache is older than soft TTL, refresh in background
        cache.get(PRODUCTS_CACHE_TS_KEY).then(function (ts) {
          var age = ts ? (Date.now() - ts) / 1000 : PRODUCTS_SOFT_TTL + 1;
          if (age > PRODUCTS_SOFT_TTL) {
            console.log('[api/products] Cache stale (' + Math.round(age) + 's old), refreshing in background');
            refreshProducts().catch(function (err) {
              console.error('[api/products] Background refresh failed:', err.message);
            });
          }
        });
        return;
      }

      console.log('[api/products] Cache miss — fetching from Zoho Inventory');
      return refreshProducts()
        .then(function (enriched) {
          res.json({ source: 'zoho', items: enriched });
        });
    })
    .catch(function (err) {
      console.error('[api/products]', err.message);
      res.status(502).json({ error: err.message });
    });
});

var SERVICES_CACHE_KEY = 'zoho:services';
var SERVICES_CACHE_TTL = 300; // 5 minutes

/**
 * GET /api/services
 * Returns active service-type items from Zoho Inventory, cached for 5 minutes.
 */
app.get('/api/services', function (req, res) {
  cache.get(SERVICES_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        console.log('[api/services] Cache hit');
        return res.json({ source: 'cache', items: cached });
      }

      console.log('[api/services] Cache miss — fetching from Zoho Inventory');
      return fetchAllItems({ status: 'active' })
        .then(function (allItems) {
          var items = allItems.filter(function (item) {
            return item.product_type === 'service';
          });
          cache.set(SERVICES_CACHE_KEY, items, SERVICES_CACHE_TTL);
          res.json({ source: 'zoho', items: items });
        });
    })
    .catch(function (err) {
      console.error('[api/services]', err.message);
      res.status(502).json({ error: err.message });
    });
});

var INGREDIENTS_CACHE_KEY = 'zoho:ingredients';
var INGREDIENTS_CACHE_TTL = 300; // 5 minutes

/**
 * GET /api/ingredients
 * Returns active goods items that are NOT kits (no Type custom field)
 * and NOT services. These are ingredients, supplies, and equipment.
 * Uses the products cache to identify kit item IDs to exclude.
 */
app.get('/api/ingredients', function (req, res) {
  cache.get(INGREDIENTS_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        console.log('[api/ingredients] Cache hit');
        return res.json({ source: 'cache', items: cached });
      }

      console.log('[api/ingredients] Cache miss — fetching from Zoho Inventory');
      return fetchAllItems({ status: 'active' })
        .then(function (allItems) {
          var items = allItems.filter(function (item) {
            return item.product_type !== 'service' && !_kitItemIds[item.item_id];
          });
          cache.set(INGREDIENTS_CACHE_KEY, items, INGREDIENTS_CACHE_TTL);
          res.json({ source: 'zoho', items: items });
        });
    })
    .catch(function (err) {
      console.error('[api/ingredients]', err.message);
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
 * POST /api/items
 * Create a new item in Zoho Books/Inventory.
 */
app.post('/api/items', function (req, res) {
  zohoPost('/items', req.body)
    .then(function (data) { res.status(201).json(data); })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      console.error('[api/items POST]', msg);
      res.status(err.response && err.response.status || 502).json({ error: msg });
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

/**
 * POST /api/payment/charge
 * Charge a deposit using a single-use token from the client.
 *
 * Expected body:
 * {
 *   token: "single-use-token-from-globalpayments-js",
 *   amount: 50.00,
 *   customer: { name: "...", email: "..." }
 * }
 */
app.post('/api/payment/charge', function (req, res) {
  var body = req.body;

  if (!body || !body.token) {
    return res.status(400).json({ error: 'Missing payment token' });
  }
  if (!process.env.GP_APP_KEY) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  var amount = parseFloat(body.amount) || GP_DEPOSIT_AMOUNT;

  var card = new CreditCardData();
  card.token = body.token;

  card.charge(amount)
    .withCurrency('CAD')
    .withAllowDuplicates(true)
    .execute()
    .then(function (response) {
      if (response.responseCode !== 'SUCCESS' && response.responseCode !== '00') {
        console.error('[payment/charge] Declined:', response.responseCode, response.responseMessage);
        return res.status(402).json({
          error: 'Payment declined: ' + (response.responseMessage || 'Unknown error'),
          code: response.responseCode
        });
      }

      console.log('[payment/charge] Success: txn=' + response.transactionId);
      res.json({
        transaction_id: response.transactionId,
        auth_code: response.authorizationCode || '',
        status: 'approved',
        amount: amount
      });
    })
    .catch(function (err) {
      console.error('[payment/charge] Error:', err.message);
      res.status(502).json({ error: 'Payment processing error: ' + err.message });
    });
});

/**
 * POST /api/payment/void
 * Void a transaction (used when Zoho order creation fails after payment).
 *
 * Expected body: { transaction_id: "..." }
 */
app.post('/api/payment/void', function (req, res) {
  var txnId = req.body && req.body.transaction_id;
  if (!txnId) {
    return res.status(400).json({ error: 'Missing transaction_id' });
  }

  Transaction.fromId(txnId)
    .void()
    .execute()
    .then(function (response) {
      console.log('[payment/void] Voided txn=' + txnId);
      res.json({ ok: true, transaction_id: txnId, status: 'voided' });
    })
    .catch(function (err) {
      console.error('[payment/void] Error:', err.message);
      res.status(502).json({ error: 'Void failed: ' + err.message });
    });
});

/**
 * POST /api/payment/refund
 * Refund a deposit (for cancellations).
 *
 * Expected body: { transaction_id: "...", amount: 50.00 }
 */
app.post('/api/payment/refund', function (req, res) {
  var body = req.body;
  if (!body || !body.transaction_id) {
    return res.status(400).json({ error: 'Missing transaction_id' });
  }

  var amount = parseFloat(body.amount) || GP_DEPOSIT_AMOUNT;

  Transaction.fromId(body.transaction_id)
    .refund(amount)
    .withCurrency('CAD')
    .execute()
    .then(function (response) {
      if (response.responseCode !== '00') {
        return res.status(400).json({
          error: 'Refund declined: ' + (response.responseMessage || 'Unknown error'),
          code: response.responseCode
        });
      }

      console.log('[payment/refund] Refunded txn=' + body.transaction_id + ' amount=' + amount);
      res.json({
        ok: true,
        transaction_id: response.transactionId,
        original_transaction_id: body.transaction_id,
        amount: amount,
        status: 'refunded'
      });
    })
    .catch(function (err) {
      console.error('[payment/refund] Error:', err.message);
      res.status(502).json({ error: 'Refund failed: ' + err.message });
    });
});

/**
 * POST /api/checkout
 * Accepts a cart payload, formats it as a Zoho Books Sales Order, and creates
 * it via the API. Invalidates the products cache so stock counts refresh.
 *
 * If a payment transaction_id is provided (online deposit was charged),
 * deposit/balance custom fields are added and a Zoho Books customer payment
 * is recorded against the sales order.
 *
 * Expected request body:
 * {
 *   customer_id: "zoho_contact_id",
 *   items: [
 *     { item_id: "zoho_item_id", name: "Product Name", quantity: 2, rate: 14.99 }
 *   ],
 *   notes: "optional order notes",
 *   transaction_id: "gp-txn-id (optional)",
 *   deposit_amount: 50.00 (optional)
 * }
 */
app.post('/api/checkout', function (req, res) {
  var body = req.body;

  // --- Validate required fields ---
  if (!body || !body.customer_id) {
    return res.status(400).json({ error: 'Missing customer_id' });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  // --- Calculate order total and deposit ---
  var orderTotal = 0;
  var lineItems = body.items.map(function (item) {
    var qty = Number(item.quantity) || 1;
    var rate = Number(item.rate) || 0;
    var discount = Number(item.discount) || 0;
    var effectiveRate = discount > 0 ? rate * (1 - discount / 100) : rate;
    orderTotal += qty * effectiveRate;
    var li = {
      item_id: item.item_id,
      name: item.name || '',
      quantity: qty,
      rate: rate
    };
    if (discount > 0) li.discount = discount + '%';
    return li;
  });

  var transactionId = body.transaction_id || '';
  var depositAmount = transactionId ? (parseFloat(body.deposit_amount) || 0) : 0;
  var balanceDue = Math.max(0, orderTotal - depositAmount);

  var salesOrder = {
    customer_id: body.customer_id,
    date: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
    line_items: lineItems,
    notes: body.notes || '',
    custom_fields: []
  };

  // Appointment custom fields (only included if configured in .env)
  if (body.appointment_id && process.env.ZOHO_CF_APPOINTMENT_ID) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_APPOINTMENT_ID,
      value: body.appointment_id
    });
  }
  if (body.timeslot && process.env.ZOHO_CF_TIMESLOT) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_TIMESLOT,
      value: body.timeslot
    });
  }
  if (process.env.ZOHO_CF_STATUS) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_STATUS,
      value: body.appointment_id ? 'Pending' : 'Walk-in'
    });
  }

  // Deposit tracking custom fields (only included if configured in .env)
  if (process.env.ZOHO_CF_DEPOSIT) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_DEPOSIT,
      value: String(depositAmount.toFixed(2))
    });
  }
  if (process.env.ZOHO_CF_BALANCE) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_BALANCE,
      value: String(balanceDue.toFixed(2))
    });
  }
  if (transactionId && process.env.ZOHO_CF_TRANSACTION_ID) {
    salesOrder.custom_fields.push({
      api_name: process.env.ZOHO_CF_TRANSACTION_ID,
      value: transactionId
    });
  }

  zohoPost('/salesorders', salesOrder)
    .then(function (data) {
      // Invalidate product cache so stock counts refresh on next fetch
      cache.del(PRODUCTS_CACHE_KEY);

      var soId = data.salesorder ? data.salesorder.salesorder_id : null;
      var soNumber = data.salesorder ? data.salesorder.salesorder_number : null;

      // If an online deposit was charged, record the payment in Zoho Books
      if (transactionId && depositAmount > 0 && soId) {
        return zohoPost('/customerpayments', {
          customer_id: body.customer_id,
          payment_mode: 'creditcard',
          amount: depositAmount,
          date: new Date().toISOString().slice(0, 10),
          reference_number: transactionId,
          notes: 'Online deposit for Sales Order ' + (soNumber || soId)
        })
        .then(function () {
          console.log('[api/checkout] Payment recorded for SO=' + soNumber);
        })
        .catch(function (payErr) {
          // Payment recording failed — log but don't fail the order
          // The deposit custom fields on the SO still have the transaction reference
          console.error('[api/checkout] Payment recording failed (non-fatal):', payErr.message);
        })
        .then(function () {
          res.status(201).json({
            ok: true,
            salesorder_id: soId,
            salesorder_number: soNumber,
            deposit_amount: depositAmount,
            balance_due: balanceDue
          });
        });
      }

      res.status(201).json({
        ok: true,
        salesorder_id: soId,
        salesorder_number: soNumber,
        deposit_amount: depositAmount,
        balance_due: balanceDue
      });
    })
    .catch(function (err) {
      var status = 502;
      var message = err.message;

      // Surface Zoho-specific errors (e.g. "Out of Stock", validation)
      if (err.response && err.response.data) {
        message = err.response.data.message || err.response.data.error || message;
        // 400-level from Zoho → relay as 400 to the client
        if (err.response.status >= 400 && err.response.status < 500) {
          status = 400;
        }
      }

      // If payment was already charged but Zoho failed, void the transaction
      if (transactionId) {
        console.error('[api/checkout] Zoho failed after payment — voiding txn=' + transactionId);
        Transaction.fromId(transactionId)
          .void()
          .execute()
          .then(function () {
            console.log('[api/checkout] Voided txn=' + transactionId);
          })
          .catch(function (voidErr) {
            console.error('[api/checkout] CRITICAL: Void failed for txn=' + transactionId + ':', voidErr.message);
          })
          .then(function () {
            res.status(status).json({
              error: message,
              payment_voided: true,
              voided_transaction_id: transactionId
            });
          });
        return;
      }

      console.error('[api/checkout]', message);
      res.status(status).json({ error: message });
    });
});

// ---------------------------------------------------------------------------
// API routes — Tax Setup (BC FoP rates)
// ---------------------------------------------------------------------------

/**
 * GET /api/inventory/items/:id
 * Fetch a single item from Zoho Inventory (full detail).
 */
app.get('/api/inventory/items/:id', function (req, res) {
  inventoryGet('/items/' + req.params.id)
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      var detail = err.response ? err.response.data : err.message;
      res.status(502).json({ error: detail });
    });
});

/**
 * PUT /api/inventory/items/:id
 * Update a single item in Zoho Inventory.
 */
app.put('/api/inventory/items/:id', function (req, res) {
  inventoryPut('/items/' + req.params.id, req.body)
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      var detail = err.response ? err.response.data : err.message;
      res.status(502).json({ error: detail });
    });
});

/**
 * GET /api/items/:item_id/image
 * Proxy the Zoho Inventory item image endpoint.
 * Returns the raw image binary with the correct Content-Type.
 * Returns 404 if the item has no image.
 */
app.get('/api/items/:item_id/image', function (req, res) {
  zohoAuth.getAccessToken()
    .then(function (token) {
      return axios.get(ZOHO_INVENTORY_BASE + '/items/' + req.params.item_id + '/image', {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        responseType: 'arraybuffer',
        validateStatus: function (status) { return status < 500; }
      });
    })
    .then(function (response) {
      if (response.status === 404 || !response.data || response.data.length === 0) {
        return res.status(404).json({ error: 'No image for this item' });
      }
      // Zoho may return a JSON error body even with 200 — detect by checking
      // if the Content-Type is application/json
      var contentType = response.headers['content-type'] || '';
      if (contentType.indexOf('application/json') !== -1) {
        // Zoho returned a JSON error (e.g. "no image uploaded")
        return res.status(404).json({ error: 'No image for this item' });
      }
      res.set('Content-Type', contentType || 'image/png');
      res.set('Content-Length', response.data.length);
      res.send(Buffer.from(response.data));
    })
    .catch(function (err) {
      console.error('[api/items/image] Error for item ' + req.params.item_id + ':', err.message);
      res.status(502).json({ error: 'Failed to fetch image: ' + err.message });
    });
});

/**
 * GET /api/taxes
 * List all taxes configured in Zoho Books.
 */
app.get('/api/taxes', function (req, res) {
  zohoGet('/settings/taxes')
    .then(function (data) { res.json(data); })
    .catch(function (err) {
      console.error('[api/taxes]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * GET /api/taxes/rules
 * List tax rules and tax exemptions from Zoho Books settings.
 */
app.get('/api/taxes/rules', function (req, res) {
  Promise.all([
    zohoGet('/settings/taxrules').catch(function (e) { return { error: e.response ? e.response.data : e.message }; }),
    zohoGet('/settings/taxexemptions').catch(function (e) { return { error: e.response ? e.response.data : e.message }; }),
    zohoGet('/settings/taxauthorities').catch(function (e) { return { error: e.response ? e.response.data : e.message }; })
  ])
    .then(function (results) {
      res.json({
        tax_rules: results[0],
        tax_exemptions: results[1],
        tax_authorities: results[2]
      });
    })
    .catch(function (err) {
      console.error('[api/taxes/rules]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * POST /api/taxes/rules
 * Try creating a tax rule via the API.
 */
app.post('/api/taxes/rules', function (req, res) {
  zohoPost('/settings/taxrules', req.body)
    .then(function (data) { res.status(201).json(data); })
    .catch(function (err) {
      var detail = err.response ? err.response.data : err.message;
      res.status(502).json({ error: detail });
    });
});

/**
 * POST /api/taxes/setup
 * One-time setup: create BC PST Liquor (10%) and a GST + BC PST Liquor
 * tax group. Skips anything that already exists.
 *
 * Your org already has:
 *   GST 5%, BC PST 7%, BC PST + GST 12% (compound), Zero Rate 0%
 *
 * After this runs you'll have all 4 retail tax profiles:
 *   - Zero Rate (0%)                     → Ingredients
 *   - GST (5%)                           → Facility Services
 *   - BC PST + GST (12% compound)        → Packaging, Hardware
 *   - GST + BC PST Liquor (5% + 10%)     → Finished Commercial Liquor
 */
app.post('/api/taxes/setup', function (req, res) {
  var results = { created: [], skipped: [], errors: [] };

  zohoGet('/settings/taxes')
    .then(function (data) {
      var existing = data.taxes || [];
      var existingByName = {};
      existing.forEach(function (t) { existingByName[t.tax_name] = t; });

      var chain = Promise.resolve();

      // Step 1: Create BC PST Liquor (10%) if missing
      chain = chain.then(function () {
        if (existingByName['BC PST Liquor']) {
          results.skipped.push('BC PST Liquor (already exists: ' + existingByName['BC PST Liquor'].tax_id + ')');
          return;
        }
        // Use same authority as existing BC PST
        var bcAuthority = existingByName['BC PST'] && existingByName['BC PST'].tax_authority_id;
        return zohoPost('/settings/taxes', {
          tax_name: 'BC PST Liquor',
          tax_percentage: 10,
          tax_type: 'tax',
          tax_authority_id: bcAuthority || ''
        }).then(function (resp) {
          var created = resp.tax || {};
          existingByName['BC PST Liquor'] = created;
          results.created.push('BC PST Liquor (10%) → ' + created.tax_id);
        }).catch(function (err) {
          var msg = err.message;
          if (err.response && err.response.data) msg = err.response.data.message || msg;
          results.errors.push('BC PST Liquor: ' + msg);
        });
      });

      // Step 2: Create GST + BC PST Liquor tax group if missing
      chain = chain.then(function () {
        if (existingByName['GST + BC PST Liquor']) {
          results.skipped.push('GST + BC PST Liquor (already exists: ' + existingByName['GST + BC PST Liquor'].tax_id + ')');
          return;
        }
        var gstId = existingByName['GST'] && existingByName['GST'].tax_id;
        var pstLiquorId = existingByName['BC PST Liquor'] && existingByName['BC PST Liquor'].tax_id;
        if (!gstId || !pstLiquorId) {
          results.errors.push('GST + BC PST Liquor: missing prerequisite taxes (GST=' + gstId + ', PST Liquor=' + pstLiquorId + ')');
          return;
        }
        return zohoPost('/settings/taxes', {
          tax_name: 'GST + BC PST Liquor',
          tax_percentage: 15,
          tax_type: 'compound_tax',
          tax_authority_id: existingByName['GST'].tax_authority_id || '',
          taxes: [
            { tax_id: gstId },
            { tax_id: pstLiquorId }
          ]
        }).then(function (resp) {
          var created = resp.tax || {};
          results.created.push('GST + BC PST Liquor (15%) → ' + created.tax_id);
        }).catch(function (err) {
          var msg = err.message;
          if (err.response && err.response.data) msg = err.response.data.message || msg;
          results.errors.push('GST + BC PST Liquor: ' + msg);
        });
      });

      return chain;
    })
    .then(function () {
      res.json({ ok: true, results: results });
    })
    .catch(function (err) {
      console.error('[api/taxes/setup]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * POST /api/taxes/apply
 * Assign tax groups to all active items based on category keyword matching.
 *
 * BC FoP retail tax rules:
 *   - Ingredients (juice, malt, yeast, hops, sugar)     → tax exempt (zero-rated)
 *   - Facility Services (racking, filtering, etc.)       → GST Only
 *   - Packaging (bottles, corks, labels, capsules)       → GST + BC PST
 *   - Hardware (airlocks, siphons, hydrometers)          → GST + BC PST
 *   - Finished Liquor (commercial wine/beer)             → GST + BC PST Liquor
 *
 * Matches on item name, category, or description fields.
 * Returns a dry-run preview unless body contains { apply: true }.
 */
app.post('/api/taxes/apply', function (req, res) {
  var dryRun = !(req.body && req.body.apply === true);

  // Keyword sets for each tax category (matched case-insensitively)
  var CATEGORIES = {
    // Tax rule IDs from Zoho Books UI (Settings → Taxes → Tax Rules)
    // tax_id = direct sales tax shown on item page
    // purchase_tax_id = direct purchase tax shown on item page
    // Capital equipment matched by name pattern (internal use, same tax as packaging/hardware)
    capital_equipment: {
      name_patterns: ['bucket', 'carboy', 'boil kettle', 'fermenter', 'pump', 'filter unit'],
      rule_id: '109900000000033423', // GST + PST - Standard (12%)
      tax_id: '109900000000029101',  // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    ingredients: {
      keywords: ['juice', 'malt', 'yeast', 'hops', 'sugar', 'concentrate', 'grape',
                 'bentonite', 'oak', 'additive', 'nutrient', 'stabilizer', 'ingredient',
                 'kit', 'wine kit', 'beer kit', 'cider kit'],
      rule_id: '109900000000033411', // Zero Rated - Ingredients (0%)
      tax_id: '109900000000014433',  // Zero Rate [0%]
      rule_label: 'Zero Rated - Ingredients (0%)'
    },
    services: {
      keywords: ['\\bservice\\b', '\\bracking\\b', '\\bfiltering\\b', '\\bfiltration\\b',
                 '\\bcarbonation\\b', '\\bguidance\\b', '\\bconsultation\\b',
                 '\\bfee\\b', '\\blabour\\b', '\\blabor\\b'],
      rule_id: '109900000000033417', // GST Only - Services (5%)
      tax_id: '109900000000014425',  // GST [5%]
      rule_label: 'GST Only - Services (5%)'
    },
    packaging: {
      keywords: ['bottle', 'cork', 'label', 'capsule', 'shrink', '\\bcap\\b', 'closure',
                 'carton', '\\bcase\\b', '\\bbox\\b', 'packaging'],
      rule_id: '109900000000033423', // GST + PST - Standard (12%)
      tax_id: '109900000000029101',  // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    hardware: {
      keywords: ['airlock', 'siphon', 'hydrometer', 'thermometer', 'tubing',
                 'spigot', 'bung', 'stopper', 'brush', 'sanitizer', 'cleaner',
                 'equipment', 'hardware', '\\btool\\b', 'accessory'],
      rule_id: '109900000000033423', // GST + PST - Standard (12%)
      tax_id: '109900000000029101',  // BC PST + GST [12%]
      rule_label: 'GST + PST - Standard (12%)'
    },
    liquor: {
      keywords: ['commercial wine', 'commercial beer', 'commercial liquor',
                 'finished wine', 'finished beer', 'ready to drink', 'rtd'],
      rule_id: '109900000000033429', // GST + PST Liquor (15%)
      tax_id: '109900000000033001',  // GST + BC PST Liquor [15%]
      rule_label: 'GST + PST Liquor (15%)'
    }
  };

  /**
   * Test if a keyword (possibly with \b word boundary markers) matches in text.
   */
  function keywordMatch(kw, text) {
    if (kw.indexOf('\\b') !== -1) {
      return new RegExp(kw, 'i').test(text);
    }
    return text.indexOf(kw.toLowerCase()) !== -1;
  }

  inventoryGet('/items', { status: 'active' })
    .then(function (data) {
      var items = data.items || [];

      var assignments = [];

      items.forEach(function (item) {
        var itemName = (item.name || '').toLowerCase();
        var searchText = [
          item.name || '',
          item.category_name || '',
          item.description || '',
          item.group_name || ''
        ].join(' ').toLowerCase();

        var matched = false;

        // Check capital equipment first (matched on item name only, not description)
        var capEquip = CATEGORIES.capital_equipment;
        var isCapEquip = capEquip.name_patterns.some(function (p) {
          return itemName.indexOf(p) !== -1;
        });
        if (isCapEquip) {
          assignments.push({
            item_id: item.item_id,
            item_name: item.name,
            category: 'capital_equipment',
            rule_label: capEquip.rule_label,
            rule_id: capEquip.rule_id,
            tax_id: capEquip.tax_id,
            current_purchase_rule: item.purchase_tax_rule_id || '(none)'
          });
          matched = true;
        }

        // Check remaining categories in priority order (ingredients first — kits are zero-rated)
        if (!matched) {
          var categoryOrder = ['ingredients', 'services', 'liquor', 'packaging', 'hardware'];
          for (var c = 0; c < categoryOrder.length; c++) {
            var catKey = categoryOrder[c];
            var cat = CATEGORIES[catKey];
            var hasMatch = cat.keywords.some(function (kw) {
              return keywordMatch(kw, searchText);
            });

            if (hasMatch) {
              assignments.push({
                item_id: item.item_id,
                item_name: item.name,
                category: catKey,
                rule_label: cat.rule_label,
                rule_id: cat.rule_id,
                tax_id: cat.tax_id,
                current_purchase_rule: item.purchase_tax_rule_id || '(none)'
              });
              matched = true;
              break;
            }
          }
        }

        // Default unmatched items to ingredients (zero-rated)
        if (!matched) {
          var ingredientsCat = CATEGORIES.ingredients;
          assignments.push({
            item_id: item.item_id,
            item_name: item.name,
            category: 'ingredients (default)',
            rule_label: ingredientsCat.rule_label,
            rule_id: ingredientsCat.rule_id,
            tax_id: ingredientsCat.tax_id,
            current_purchase_rule: item.purchase_tax_rule_id || '(none)'
          });
        }
      });

      if (dryRun) {
        return res.json({
          mode: 'dry-run',
          note: 'Send { "apply": true } to execute these changes',
          assignments: assignments,
          summary: {
            total_items: items.length,
            assigned: assignments.length
          }
        });
      }

      // Apply in batches of 25 with 2s between items and 60s between batches
      var BATCH_SIZE = 25;
      var ITEM_DELAY = 2000;
      var BATCH_DELAY = 60000;

      var applied = [];
      var skipped = [];
      var errors = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      // Filter to only items that need updating
      var toUpdate = [];
      assignments.forEach(function (a) {
        if (a.current_purchase_rule === a.rule_id) {
          skipped.push(a.item_name);
        } else {
          toUpdate.push(a);
        }
      });

      // Process one batch of items
      function processBatch(batch) {
        var chain = Promise.resolve();
        batch.forEach(function (a, idx) {
          chain = chain.then(function () {
            // Delay before each item (skip delay for first item in batch)
            return (idx > 0 ? delay(ITEM_DELAY) : Promise.resolve());
          }).then(function () {
            console.log('[taxes/apply] Updating: ' + a.item_name);
            return inventoryPut('/items/' + a.item_id, {
              purchase_tax_rule_id: a.rule_id
            });
          }).then(function () {
            applied.push(a.item_name + ' → ' + a.rule_label);
          }).catch(function (err) {
            var msg = err.message;
            if (err.response && err.response.data) msg = err.response.data.message || msg;
            errors.push(a.item_name + ': ' + msg);
          });
        });
        return chain;
      }

      // Split into batches and process with pauses
      var batches = [];
      for (var b = 0; b < toUpdate.length; b += BATCH_SIZE) {
        batches.push(toUpdate.slice(b, b + BATCH_SIZE));
      }

      var batchChain = Promise.resolve();
      batches.forEach(function (batch, batchIdx) {
        batchChain = batchChain.then(function () {
          console.log('[taxes/apply] Batch ' + (batchIdx + 1) + '/' + batches.length + ' (' + batch.length + ' items)');
          return processBatch(batch);
        }).then(function () {
          // Pause between batches (skip after last batch)
          if (batchIdx < batches.length - 1) {
            console.log('[taxes/apply] Waiting 60s before next batch...');
            return delay(BATCH_DELAY);
          }
        });
      });

      return batchChain.then(function () {
        cache.del(PRODUCTS_CACHE_KEY);

        res.json({
          mode: 'applied',
          applied: applied,
          skipped: skipped.length,
          errors: errors,
          summary: {
            updated: applied.length,
            skipped: skipped.length,
            errors: errors.length
          }
        });
      });
    })
    .catch(function (err) {
      console.error('[api/taxes/apply]', err.message);
      res.status(502).json({ error: err.message });
    });
});

/**
 * POST /api/taxes/test-update
 * Debug route: try updating a single item's tax and return the full Zoho response.
 * Body: { item_id, tax_id }
 */
app.post('/api/taxes/test-update', function (req, res) {
  var itemId = req.body.item_id;
  var taxId = req.body.tax_id;
  var mode = req.body.mode || 'json';
  if (!itemId || !taxId) return res.status(400).json({ error: 'Need item_id and tax_id' });

  var doUpdate;

  if (mode === 'inventory') {
    // Update via Zoho Inventory API
    doUpdate = inventoryPut('/items/' + itemId, { sales_tax_rule_id: taxId });
  } else if (mode === 'sales_rule') {
    // Update via Zoho Books API with sales_tax_rule_id
    doUpdate = zohoPut('/items/' + itemId, { sales_tax_rule_id: taxId });
  } else {
    doUpdate = zohoPut('/items/' + itemId, { tax_id: taxId });
  }

  doUpdate
    .then(function (data) {
      // Extract just the tax fields from response
      var item = data.item || {};
      res.json({
        ok: true,
        mode: mode,
        result: {
          tax_id: item.tax_id,
          tax_name: item.tax_name,
          tax_percentage: item.tax_percentage,
          is_taxable: item.is_taxable,
          tax_exemption_id: item.tax_exemption_id,
          sales_tax_rule_id: item.sales_tax_rule_id
        }
      });
    })
    .catch(function (err) {
      var detail = err.response ? err.response.data : err.message;
      res.status(502).json({ error: detail });
    });
});

// ---------------------------------------------------------------------------
// CSV Helper & Item Migration
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line, handling quoted fields and escaped double-quotes.
 */
function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

// CSV column name → { label, data_type } for Zoho custom fields.
// Zoho Inventory accepts updates by label (no api_name discovery needed).
// data_type is used to format values before sending.
var CUSTOM_FIELD_MAP = {
  type:              { label: 'Type',           data_type: 'dropdown' },
  subcategory:       { label: 'Subcategory',    data_type: 'text' },
  time:              { label: 'Time',           data_type: 'text' },
  tasting_notes:     { label: 'Tasting Notes',  data_type: 'text' },
  favorite:          { label: 'Favorite',       data_type: 'check_box' },
  body:              { label: 'Body',           data_type: 'text' },
  oak:               { label: 'Oak',            data_type: 'text' },
  sweetness:         { label: 'Sweetness',      data_type: 'text' },
  abv:               { label: 'ABV',            data_type: 'decimal' },
  batch_size_liters: { label: 'Batch Size (L)', data_type: 'decimal' }
};

/**
 * Fetch all items from Zoho Inventory, handling pagination.
 */
function fetchAllItems(params) {
  var allItems = [];
  var page = 1;
  var perPage = 200;

  function fetchPage() {
    var query = Object.assign({}, params || {}, { page: page, per_page: perPage });
    return inventoryGet('/items', query).then(function (data) {
      var items = data.items || [];
      allItems = allItems.concat(items);

      if (data.page_context && data.page_context.has_more_page) {
        page++;
        return fetchPage();
      }
      return allItems;
    });
  }

  return fetchPage();
}

/**
 * GET /api/items/inspect
 * Fetch a single item's full detail to discover available custom fields.
 * Query: ?item_id=...  (optional — defaults to first active item)
 */
app.post('/api/items/test-cf', function (req, res) {
  var itemId = req.body.item_id;
  var label = req.body.label;
  var value = req.body.value;
  if (!itemId || !label) return res.status(400).json({ error: 'Need item_id and label' });

  inventoryPut('/items/' + itemId, {
    custom_fields: [{ label: label, value: value }]
  })
    .then(function (data) {
      var item = data.item || {};
      res.json({
        ok: true,
        custom_fields: item.custom_fields,
        custom_field_hash: item.custom_field_hash
      });
    })
    .catch(function (err) {
      var detail = err.response ? err.response.data : err.message;
      res.status(502).json({ error: detail });
    });
});

app.get('/api/items/inspect', function (req, res) {
  var itemIdPromise;

  if (req.query.item_id) {
    itemIdPromise = Promise.resolve(req.query.item_id);
  } else {
    itemIdPromise = inventoryGet('/items', { status: 'active', per_page: 1 })
      .then(function (data) {
        var items = data.items || [];
        if (items.length === 0) throw new Error('No active items found');
        return items[0].item_id;
      });
  }

  itemIdPromise
    .then(function (itemId) {
      return inventoryGet('/items/' + itemId);
    })
    .then(function (data) {
      var item = data.item || {};

      var customFields = (item.custom_fields || []).map(function (cf) {
        return {
          api_name: cf.api_name || cf.customfield_id,
          label: cf.label,
          data_type: cf.data_type,
          value: cf.value
        };
      });

      res.json({
        item_id: item.item_id,
        name: item.name,
        sku: item.sku,
        rate: item.rate,
        standard_fields: {
          name: item.name,
          sku: item.sku,
          rate: item.rate,
          status: item.status,
          group_name: item.group_name,
          category_name: item.category_name
        },
        custom_fields: customFields,
        custom_field_count: customFields.length
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) msg = err.response.data.message || msg;
      console.error('[api/items/inspect]', msg);
      res.status(502).json({ error: msg });
    });
});

/**
 * POST /api/items/migrate
 * Read products CSV, match to Zoho Inventory items by SKU, and update
 * standard + custom fields.
 *
 * Body: { csv_url: "..." OR csv_path: "/local/file.csv", apply: false, match_by: "sku" }
 *
 * Dry run (apply: false) returns proposed changes without updating.
 * Apply (apply: true) updates items with rate limiting (25/batch, 2s between
 * items, 60s between batches).
 */
app.post('/api/items/migrate', function (req, res) {
  var fs = require('fs');
  var body = req.body || {};
  var csvUrl = body.csv_url;
  var csvPath = body.csv_path;
  var applyChanges = body.apply === true;
  var matchBy = body.match_by || 'sku';

  if (!csvUrl && !csvPath) {
    return res.status(400).json({ error: 'Missing csv_url or csv_path' });
  }

  var csvRows, zohoItems;

  // Step 1: Fetch/read CSV
  var csvPromise = csvPath
    ? Promise.resolve({ data: fs.readFileSync(csvPath, 'utf8') })
    : axios.get(csvUrl, { responseType: 'text' });

  csvPromise
    .then(function (csvResp) {
      var lines = csvResp.data.split('\n');
      var headerLine = lines[0];
      if (!headerLine) throw new Error('CSV is empty');

      var headers = parseCSVLine(headerLine.replace(/\r$/, ''));
      headers = headers.map(function (h) {
        return h.trim().toLowerCase().replace(/\s+/g, '_');
      });

      csvRows = [];
      for (var i = 1; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '').trim();
        if (!line) continue;

        var values = parseCSVLine(line);
        var row = {};
        headers.forEach(function (h, idx) {
          row[h] = (values[idx] || '').trim();
        });
        csvRows.push(row);
      }

      // Step 2: Fetch all active Zoho items
      return fetchAllItems({ status: 'active' });
    })
    .then(function (items) {
      zohoItems = items;
      if (items.length === 0) throw new Error('No active items in Zoho Inventory');

      // Build SKU/name lookups
      var skuMap = {};
      var nameMap = {};
      zohoItems.forEach(function (item) {
        if (item.sku) skuMap[item.sku] = item;
        if (item.name) nameMap[item.name.toLowerCase()] = item;
      });

      // Match CSV rows and build update payloads
      var matched = [];
      var unmatched = [];

      csvRows.forEach(function (row) {
        var zohoItem = null;
        if (matchBy === 'sku' && row.sku) {
          zohoItem = skuMap[row.sku];
        }
        if (!zohoItem && row.name) {
          zohoItem = nameMap[row.name.toLowerCase()];
        }

        if (!zohoItem) {
          unmatched.push((row.name || '(no name)') + ' (' + (row.sku || 'no SKU') + ')');
          return;
        }

        var changes = {};
        var customFieldUpdates = [];

        // Standard field: rate from retail_instore
        if (row.retail_instore) {
          var rate = parseFloat(row.retail_instore.replace(/[$,]/g, ''));
          if (!isNaN(rate) && rate > 0) {
            changes.rate = rate;
          }
        }

        // Standard field: brand
        if (row.brand && row.brand !== '') {
          changes.brand = row.brand;
        }

        // Custom fields — use label-based updates (Zoho accepts { label, value })
        Object.keys(CUSTOM_FIELD_MAP).forEach(function (csvCol) {
          if (row[csvCol] === undefined || row[csvCol] === '') return;

          var fieldDef = CUSTOM_FIELD_MAP[csvCol];
          var value = row[csvCol];

          // Format value based on field data type
          if (fieldDef.data_type === 'decimal' || fieldDef.data_type === 'number') {
            value = parseFloat(value.replace(/[$,%]/g, ''));
            if (isNaN(value)) return;
          } else if (fieldDef.data_type === 'check_box') {
            value = value.toUpperCase() === 'TRUE';
          }

          customFieldUpdates.push({
            label: fieldDef.label,
            value: value
          });
          changes[fieldDef.label] = value;
        });

        if (Object.keys(changes).length > 0 || customFieldUpdates.length > 0) {
          matched.push({
            item_id: zohoItem.item_id,
            name: zohoItem.name,
            sku: zohoItem.sku || row.sku,
            changes: changes,
            custom_fields: customFieldUpdates
          });
        }
      });

      // Dry run — return proposed changes
      if (!applyChanges) {
        return res.json({
          mode: 'dry-run',
          note: 'Send { "apply": true } to execute these changes',
          matched: matched.length,
          unmatched: unmatched.length,
          unmatched_items: unmatched,
          updates: matched,
          zoho_items_total: zohoItems.length,
          csv_rows_total: csvRows.length
        });
      }

      // Apply changes with rate limiting
      var BATCH_SIZE = 25;
      var ITEM_DELAY = 2000;
      var BATCH_DELAY = 60000;

      var applied = [];
      var errors = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      function processBatch(batch) {
        var chain = Promise.resolve();
        batch.forEach(function (update, idx) {
          chain = chain.then(function () {
            return (idx > 0 ? delay(ITEM_DELAY) : Promise.resolve());
          }).then(function () {
            console.log('[items/migrate] Updating: ' + update.name + ' (' + update.sku + ')');

            var payload = {};
            if (update.changes.rate !== undefined) {
              payload.rate = update.changes.rate;
            }
            if (update.changes.brand !== undefined) {
              payload.brand = update.changes.brand;
            }
            if (update.custom_fields.length > 0) {
              payload.custom_fields = update.custom_fields;
            }

            return inventoryPut('/items/' + update.item_id, payload);
          }).then(function () {
            applied.push(update.name);
          }).catch(function (err) {
            var msg = err.message;
            if (err.response && err.response.data) msg = err.response.data.message || msg;
            errors.push(update.name + ': ' + msg);
          });
        });
        return chain;
      }

      var batches = [];
      for (var b = 0; b < matched.length; b += BATCH_SIZE) {
        batches.push(matched.slice(b, b + BATCH_SIZE));
      }

      var batchChain = Promise.resolve();
      batches.forEach(function (batch, batchIdx) {
        batchChain = batchChain.then(function () {
          console.log('[items/migrate] Batch ' + (batchIdx + 1) + '/' + batches.length + ' (' + batch.length + ' items)');
          return processBatch(batch);
        }).then(function () {
          if (batchIdx < batches.length - 1) {
            console.log('[items/migrate] Waiting 60s before next batch...');
            return delay(BATCH_DELAY);
          }
        });
      });

      return batchChain.then(function () {
        cache.del(PRODUCTS_CACHE_KEY);

        res.json({
          mode: 'applied',
          applied: applied.length,
          errors: errors,
          summary: {
            updated: applied.length,
            failed: errors.length,
            unmatched: unmatched.length
          }
        });
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) msg = err.response.data.message || msg;
      console.error('[api/items/migrate]', msg);
      res.status(502).json({ error: msg });
    });
});

// ---------------------------------------------------------------------------
// POS Terminal Integration
// ---------------------------------------------------------------------------

/**
 * GET /api/pos/status
 * Check if the POS terminal is enabled and configured.
 */
app.get('/api/pos/status', function (req, res) {
  res.json({
    enabled: GP_TERMINAL_ENABLED && !!gpTerminalDevice,
    terminal_type: GP_TERMINAL_ENABLED ? 'UPA (Meet in the Cloud)' : 'none'
  });
});

/**
 * POST /api/pos/sale
 * Push a sale to the GP terminal via Meet in the Cloud.
 * The terminal displays the amount and waits for card tap/insert/swipe.
 *
 * Expected body:
 * {
 *   amount: 99.99,
 *   salesorder_number: "SO-00123",
 *   items: [{ name: "Product Name", price: "49.99", qty: 2 }],
 *   customer_name: "John Doe"
 * }
 *
 * Returns: { transaction_id, status, auth_code } on success
 */
app.post('/api/pos/sale', function (req, res) {
  if (!GP_TERMINAL_ENABLED || !gpTerminalDevice) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  var body = req.body;
  if (!body || !body.amount) {
    return res.status(400).json({ error: 'Missing amount' });
  }

  var amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  var soNumber = body.salesorder_number || '';

  console.log('[pos/sale] Initiating terminal sale: $' + amount.toFixed(2) + ' SO=' + soNumber);

  gpTerminalDevice.sale(amount)
    .withCurrency('CAD')
    .withInvoiceNumber(soNumber)
    .execute('terminal')
    .then(function (response) {
      if (response.deviceResponseCode === '00' || response.status === 'Success') {
        console.log('[pos/sale] Terminal sale approved: txn=' + response.transactionId);

        // Record the payment in Zoho if we have a customer_id and SO
        var txnId = response.transactionId || '';
        res.json({
          ok: true,
          transaction_id: txnId,
          status: 'approved',
          auth_code: response.authorizationCode || '',
          amount: amount
        });
      } else {
        console.error('[pos/sale] Terminal declined:', response.deviceResponseCode, response.deviceResponseText);
        res.status(402).json({
          error: 'Terminal payment declined: ' + (response.deviceResponseText || 'Unknown'),
          code: response.deviceResponseCode
        });
      }
    })
    .catch(function (err) {
      console.error('[pos/sale] Terminal error:', err.message);
      res.status(502).json({ error: 'Terminal error: ' + err.message });
    });
});

// ---------------------------------------------------------------------------
// Recent Kiosk Orders (for staff order board)
// ---------------------------------------------------------------------------

/**
 * GET /api/orders/recent
 * Returns the last 20 sales orders, sorted by most recent.
 * Used by the admin panel's "Recent Kiosk Orders" section.
 */
app.get('/api/orders/recent', function (req, res) {
  var limit = parseInt(req.query.limit, 10) || 20;

  zohoGet('/salesorders', {
    sort_column: 'created_time',
    sort_order: 'D',
    per_page: limit
  })
    .then(function (data) {
      var orders = (data.salesorders || []).map(function (so) {
        // Extract custom field values
        var customFields = so.custom_fields || [];
        var status = '';
        var timeslot = '';
        var deposit = '';
        var txnId = '';

        customFields.forEach(function (cf) {
          if (cf.api_name === process.env.ZOHO_CF_STATUS) status = cf.value || '';
          if (cf.api_name === process.env.ZOHO_CF_TIMESLOT) timeslot = cf.value || '';
          if (cf.api_name === process.env.ZOHO_CF_DEPOSIT) deposit = cf.value || '';
          if (cf.api_name === process.env.ZOHO_CF_TRANSACTION_ID) txnId = cf.value || '';
        });

        return {
          salesorder_number: so.salesorder_number || '',
          customer_name: so.customer_name || '',
          total: so.total || 0,
          status: status,
          timeslot: timeslot,
          deposit: deposit,
          transaction_id: txnId,
          date: so.date || '',
          items: (so.line_items || []).map(function (li) {
            return {
              name: li.name || li.description || '',
              quantity: li.quantity || 1,
              rate: li.rate || 0
            };
          })
        };
      });

      res.json({ orders: orders });
    })
    .catch(function (err) {
      console.error('[api/orders/recent]', err.message);
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

// Connect Redis, restore Zoho auth, then start listening
cache.init().then(function () {
  return zohoAuth.init();
}).then(function () {
  app.listen(PORT, function () {
    console.log('');
    console.log('  Zoho middleware running on http://localhost:' + PORT);
    console.log('  Health check:   http://localhost:' + PORT + '/health');
    if (!zohoAuth.isAuthenticated()) {
      console.log('  Connect Zoho:   http://localhost:' + PORT + '/auth/zoho');
    } else {
      console.log('  Zoho:           Connected');
    }
    console.log('');
  });
});

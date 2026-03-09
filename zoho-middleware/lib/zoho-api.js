var axios = require('axios');
var zohoAuth = require('./zohoAuth');
var log = require('./logger');

// ---------------------------------------------------------------------------
// Retry helper — wraps an async fn with exponential back-off
// Retries on network errors and 429/5xx; throws immediately on other 4xx
// ---------------------------------------------------------------------------

async function withRetry(fn, opts) {
  var retries = (opts && opts.retries !== undefined) ? opts.retries : 3;
  var baseDelay = (opts && opts.baseDelay) || 300;
  var factor = (opts && opts.factor) || 2;
  var attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      var status = err.status || (err.response && err.response.status);
      // Do not retry 4xx client errors except 429
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt >= retries) throw err;
      var delay = baseDelay * Math.pow(factor, attempt);
      if (status === 429 && err.retryAfter) delay = err.retryAfter * 1000;
      if (status === 429 && err.response && err.response.headers && err.response.headers['retry-after']) {
        delay = parseInt(err.response.headers['retry-after'], 10) * 1000 || delay;
      }
      // M1: Cap retry delay to 30 seconds maximum
      delay = Math.min(delay, 30000);
      await new Promise(function(r) { setTimeout(r, delay); });
      attempt++;
    }
  }
}

// ---------------------------------------------------------------------------
// Zoho API domain configuration
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
var BOOKINGS_API_BASE = (API_URLS[apiDomain] || ('https://www.zohoapis' + apiDomain)) + '/bookings/v1/json';

// ---------------------------------------------------------------------------
// Zoho Books API helpers
// ---------------------------------------------------------------------------

/**
 * Proxy a GET request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    var query = Object.assign({ organization_id: process.env.ZOHO_ORG_ID }, params || {});
    return withRetry(function () {
      return axios.get(ZOHO_API_BASE + path, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: query,
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a POST request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoPost(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.post(ZOHO_API_BASE + path, body, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a PUT request to the Zoho Books API.
 * Automatically attaches the current access token and organization_id.
 */
function zohoPut(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.put(ZOHO_API_BASE + path, body, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a GET request to the Zoho Inventory API.
 */
function inventoryGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    var query = Object.assign({ organization_id: process.env.ZOHO_ORG_ID }, params || {});
    return withRetry(function () {
      return axios.get(ZOHO_INVENTORY_BASE + path, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: query,
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a POST request to the Zoho Inventory API.
 */
function inventoryPost(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.post(ZOHO_INVENTORY_BASE + path, body, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a PUT request to the Zoho Inventory API.
 */
function inventoryPut(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.put(ZOHO_INVENTORY_BASE + path, body, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: { organization_id: process.env.ZOHO_ORG_ID },
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Zoho Bookings API helpers
// ---------------------------------------------------------------------------

/**
 * Proxy a GET request to the Zoho Bookings API.
 * Bookings API does not require organization_id.
 */
function bookingsGet(path, params) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.get(BOOKINGS_API_BASE + path, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        params: params || {},
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

/**
 * Proxy a POST request to the Zoho Bookings API.
 * Bookings API does not require organization_id.
 */
function bookingsPost(path, body) {
  return zohoAuth.getAccessToken().then(function (token) {
    return withRetry(function () {
      return axios.post(BOOKINGS_API_BASE + path, body, {
        headers: { Authorization: 'Zoho-oauthtoken ' + token },
        timeout: 15000
      }).then(function (response) {
        return response.data;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Convert 12-hour time string to 24-hour format.
 * "10:00 AM" -> "10:00:00", "2:30 PM" -> "14:30:00"
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

/**
 * Fetch all items from Zoho Inventory, handling pagination.
 * Stops after MAX_PAGES pages (10,000 items at 200/page) to prevent runaway
 * recursion if Zoho ever returns has_more_page indefinitely.
 */
var MAX_PAGES = 50;

function fetchAllItems(params) {
  var allItems = [];
  var page = 1;
  var perPage = 200;

  function fetchPage() {
    if (page > MAX_PAGES) {
      log.error('[zoho-api] fetchAllItems hit page cap (' + MAX_PAGES + ') — catalog may be larger than expected');
      return Promise.resolve(allItems);
    }
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

module.exports = {
  API_URLS: API_URLS,
  apiDomain: apiDomain,
  ZOHO_API_BASE: ZOHO_API_BASE,
  ZOHO_INVENTORY_BASE: ZOHO_INVENTORY_BASE,
  BOOKINGS_API_BASE: BOOKINGS_API_BASE,
  withRetry: withRetry,
  zohoGet: zohoGet,
  zohoPost: zohoPost,
  zohoPut: zohoPut,
  inventoryGet: inventoryGet,
  inventoryPost: inventoryPost,
  inventoryPut: inventoryPut,
  bookingsGet: bookingsGet,
  bookingsPost: bookingsPost,
  normalizeTimeTo24h: normalizeTimeTo24h,
  fetchAllItems: fetchAllItems
};

'use strict';

/**
 * Steins & Vines Middleware — Shared Constants
 *
 * Canonical Redis key names and other shared identifiers used across
 * route handlers and library modules. Import with:
 *   var C = require('./constants');         // from lib/
 *   var C = require('../lib/constants');    // from routes/
 */

// ---------------------------------------------------------------------------
// Redis cache keys — product catalogs
// ---------------------------------------------------------------------------
var CACHE_KEYS = {
  PRODUCTS:            'zoho:products',
  PRODUCTS_TS:         'zoho:products:ts',       // timestamp of last enrichment
  PRODUCT_IMAGE_HASHES:'zoho:product-image-hashes',
  SERVICES:            'zoho:services',
  INGREDIENTS:         'zoho:ingredients',
  INGREDIENTS_TS:      'zoho:ingredients:ts',
  KIOSK_PRODUCTS:      'zoho:kiosk-products',
  RECENT_ORDERS:       'zoho:recent-orders',

  // Bookings
  BOOKING_SERVICES:    'zoho:booking-services',
  AVAILABILITY_PREFIX: 'zoho:availability:',     // append date string
  SLOTS_PREFIX:        'zoho:slots:',            // append date string

  // Auth
  REFRESH_TOKEN:       'zoho:refresh_token',
  ACCESS_TOKEN:        'zoho:access-token',
  TOKEN_EXPIRY:        'zoho:token-expiry',
  REFRESH_LOCK:        'zoho:refresh-lock',
  OAUTH_STATE_PREFIX:  'zoho:oauth-state:',      // append state param

  // Contact lookup
  CONTACT_PREFIX:      'zoho:contact:email:',    // append lowercased email

  // Idempotency
  CHECKOUT_IDEM_PREFIX: 'checkout:idem:',        // append client key (max 128 chars)
  KIOSK_IDEM_PREFIX:    'kiosk:idem:',           // append client key (max 128 chars)
};

// ---------------------------------------------------------------------------
// Redis key prefixes — inventory ledger (inv:*)
// ---------------------------------------------------------------------------
var LEDGER_KEYS = {
  STOCK_PREFIX:   'inv:stock:',         // append item_id
  VERSION:        'inv:stock:version',
  ADJUSTMENTS:    'inv:adjustments:log',
};

// ---------------------------------------------------------------------------
// Redis key prefixes — rate limiting (rl:*)
// ---------------------------------------------------------------------------
var RATE_LIMIT_PREFIX = 'rl:';  // makeRedisStore() appends <scope>:<ip>

// ---------------------------------------------------------------------------
// Kit category filter values  (mirrors frontend KIT_CATEGORIES)
// ---------------------------------------------------------------------------
var KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

module.exports = {
  CACHE_KEYS:         CACHE_KEYS,
  LEDGER_KEYS:        LEDGER_KEYS,
  RATE_LIMIT_PREFIX:  RATE_LIMIT_PREFIX,
  KIT_CATEGORIES:     KIT_CATEGORIES,
};

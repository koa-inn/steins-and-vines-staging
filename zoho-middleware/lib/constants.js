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
  SERVICES:            'zoho:services:v2',
  INGREDIENTS:         'zoho:ingredients',
  INGREDIENTS_TS:      'zoho:ingredients:ts',
  INGREDIENTS_ALL:     'zoho:ingredients:all',   // full list incl. Internal Only (admin-only)
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

  // Collect payment (Zoho SO → Helcim terminal)
  COLLECT_IDEM_PREFIX:    'collect:idem:',
  COLLECT_PENDING_PREFIX: 'collect:pending:',
  // Fail-closed sentinel for a collect-flow payment that could not be
  // finalized/applied to an invoice after the Helcim charge (71-01).
  COLLECT_RECONCILE_FAILURE_PREFIX: 'collect:reconcile-failure:',

  // Kiosk pending charge — D-13 reconciliation interface (45-07 → consumed by 45-08)
  // Keyed by reference_number; TTL 7 days so the daily reconciliation backstop can find it.
  KIOSK_PENDING_CHARGE_PREFIX: 'kiosk:pending-charge:',

  // Kiosk cancel-safety flag (68-02) — set by /api/pos/cancel, keyed by reference_number.
  // Checked by the Helcim webhook's APPROVED-result handler (the only channel that
  // resolves a terminal result independent of the client, which stops polling the
  // instant cancel is clicked) so a charge that lands after cancel is voided
  // immediately instead of orphaned until the reconcile.js 600s backstop.
  KIOSK_CANCELLED_PREFIX: 'kiosk:cancelled:',

  // Kiosk sales order management
  KIOSK_SALESORDERS:      'kiosk:salesorders',

  // Consignment
  CONSIGNMENT_REPORT_PREFIX: 'consignment:report:',  // append YYYY-MM

  // Kiosk discount presets
  KIOSK_DISCOUNT_PRESETS: 'kiosk:discount-presets',

  // Brewpad batch creation retry queue
  BATCH_RETRY_PREFIX:     'brewpad:pending-batch:',

  // Brewpad Zoho sync retry queue (Phase 7)
  BATCH_SYNC_RETRY_PREFIX: 'brewpad:zoho-sync:',

  // Promo code redemption tracking
  PROMO_REDEEMED_PREFIX:  'promo:firstbatch:redeemed:',  // append lowercased email

  // Recipes (Apps Script sourced, Redis cached)
  RECIPES:             'sv:recipes',
  RECIPES_TS:          'sv:recipes:ts',
  RECIPE_AVAILABILITY: 'sv:recipe-availability',  // append ':' + recipe_id (Phase 52-05 M8)
  FERM_SCHEDULES:      'sv:ferm-schedules',       // fermentation schedule templates (Phase 81-02)

  // Gift cards (Apps Script sourced, Redis cached — Phase 52-05 M8)
  GIFT_CARD_NEXT_NUMBER: 'kiosk:gift-card-next-number',
};

// ---------------------------------------------------------------------------
// Redis lock keys — mutex identifiers (used with cache.acquireLock)
// ---------------------------------------------------------------------------
var LOCK_KEYS = {
  RECIPE_SALE: 'recipe-sale',  // one recipe sale at a time (per D-04)
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
  LOCK_KEYS:          LOCK_KEYS,
  LEDGER_KEYS:        LEDGER_KEYS,
  RATE_LIMIT_PREFIX:  RATE_LIMIT_PREFIX,
  KIT_CATEGORIES:     KIT_CATEGORIES,
};

// ===== Steins & Vines — Shared Constants =====
// Canonical identifiers used across frontend modules.
// Load this script before any page-specific JS (and before utils.js).
//
// For concatenated builds (main.min.js): listed first in the concat:js pipeline.
// For standalone pages (admin, kiosk, brewpad, batch): loaded via <script> tag.

// ---------------------------------------------------------------------------
// Cart storage keys
// ---------------------------------------------------------------------------
var CART_KEYS = {
  FERMENT:             'sv-cart-ferment',
  INGREDIENTS:         'sv-cart-ingredients',
  LEGACY_RESERVATION:  'sv-reservation'  // migration only — do not write new data here
};

// ---------------------------------------------------------------------------
// Product item type values (_item_type / item_type field)
// ---------------------------------------------------------------------------
var ITEM_TYPES = {
  KIT:          'kit',
  INGREDIENT:   'ingredient',
  SERVICE:      'service',
  KIT_PURCHASE: 'kit-purchase'  // kit added directly to ingredient cart for purchase
};

// ---------------------------------------------------------------------------
// Product tab identifiers (data-product-tab attribute values)
// ---------------------------------------------------------------------------
var PRODUCT_TABS = {
  KITS:        'kits',
  INGREDIENTS: 'ingredients',
  SERVICES:    'services'
};

// ---------------------------------------------------------------------------
// Kit category filter values (Zoho category_name substrings)
// Used to distinguish kit products from ingredients/services.
// ---------------------------------------------------------------------------
var KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CART_KEYS:     CART_KEYS,
    ITEM_TYPES:    ITEM_TYPES,
    PRODUCT_TABS:  PRODUCT_TABS,
    KIT_CATEGORIES: KIT_CATEGORIES
  };
}

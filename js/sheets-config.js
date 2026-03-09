/**
 * Google Sheets configuration for Steins & Vines inventory system.
 *
 * Setup instructions:
 * 1. Create a Google Cloud project and enable the Google Sheets API.
 * 2. Create an OAuth 2.0 Client ID (Web application type).
 *    - Add your site origin to Authorized JavaScript origins.
 * 4. Create a Google Spreadsheet with tabs: Kits, Ingredients, Holds, Reservations, Schedule, Config.
 * 5. Publish the Kits tab: File → Share → Publish to web → Kits tab → CSV.
 * 6. Fill in the values below.
 */
var SHEETS_CONFIG = {
  // Google Spreadsheet ID (from the spreadsheet URL)
  SPREADSHEET_ID: '10BzcANc_-dyS-Is_C4He7mMYHfJ2OSJS9V4p7D-1JrM',

  // OAuth 2.0 Client ID for staff sign-in
  CLIENT_ID: '8605205683-tck2da2tpp03vcbr5etauu9q7kompg3q.apps.googleusercontent.com',

  // Published CSV URL for the Kits tab (public, no auth required)
  PUBLISHED_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=0&single=true&output=csv',

  // Published CSV URL for the Ingredients tab (public, no auth required)
  PUBLISHED_INGREDIENTS_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=608476944&single=true&output=csv',

  // Published CSV URL for the Services tab (public, no auth required)
  PUBLISHED_SERVICES_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=223978911&single=true&output=csv',

  // Published CSV URL for the Schedule tab (public, no auth required)
  // Set this after publishing the Schedule tab: File → Share → Publish to web → Schedule tab → CSV
  PUBLISHED_SCHEDULE_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=1949632749&single=true&output=csv',

  // Published CSV URL for the Homepage tab (public, no auth required)
  PUBLISHED_HOMEPAGE_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTRpDadhsKBYPuE3pFCYnmeRiUJO_Z972ISX509taCzL8jmYaWPue5DfR9OfEiJD-OlhsxoC_rDerUW/pub?gid=909487903&single=true&output=csv',

  // Behold Instagram feed ID — update this when the widget changes
  INSTAGRAM_FEED_ID: '0Zd67EUJqg7knUfOBqKn',

  // Public Apps Script endpoint for featured products (Execute as: Me, Anyone access)
  // Separate from ADMIN_API_URL which requires Google account auth
  FEATURED_API_URL: 'https://script.google.com/macros/s/AKfycbwf0YlUssvXZPOIZTcIqVrmy61jocZdV4k_r7R6lpRgaQNBPLp0Ir1OXiWyQsYRLVfmlw/exec?action=get_featured',

  // Static featured SKUs — used as fallback if the Apps Script endpoint is unreachable.
  // Format: [{ sku: 'SKU-001', description: 'Optional promo text' }, ...]
  // Update this alongside saving in the admin panel's Homepage tab.
  FEATURED_SKUS: [],

  // OAuth scope for read/write access to spreadsheets
  SCOPES: 'https://www.googleapis.com/auth/spreadsheets',

  // Sheet/tab names within the spreadsheet
  // Web App URL for anonymous product event tracking (deploy trackEvent.gs as web app)
  // Leave blank to disable tracking; no events are sent until a URL is set.
  TRACK_EVENTS_URL: 'https://script.google.com/macros/s/AKfycbyWsu3oLF_q99IN_Xt-HdJrfLF9rXWxkGvd5HiG33stsrIDfpyMWzLXe-aeRoypM5C8RQ/exec',

  // ADMIN_API_URL is loaded from js/admin-config.js, which is only included
  // on admin/staff pages (admin.html, brewpad.html, kiosk.html, batch.html).
  // Not set here so it is not delivered to all public visitors.

  // Zoho middleware URL (for Bookings + Checkout API)
  MIDDLEWARE_URL: 'https://svmiddleware-production.up.railway.app',

  // Middleware API key — semi-public, protected by CORS origin whitelist on the server.
  // This key matches the API_SECRET_KEY env var on Railway. Both ends must match.
  // To rotate: openssl rand -base64 32 → update Railway API_SECRET_KEY → update this value.
  MW_API_KEY: 'a9QKtDV3DtYSFIdWtfAMg9Ry70bHG55QGhyJa9GD3fM=',

  // Google reCAPTCHA v3 site key (public — safe to expose)
  RECAPTCHA_SITE_KEY: '6LerSH0sAAAAAGKtltFqN5fu2w8opPV5BStdzNDu',

  SHEET_NAMES: {
    KITS: 'Kits',
    INGREDIENTS: 'Ingredients',
    HOLDS: 'Holds',
    RESERVATIONS: 'Reservations',
    SCHEDULE: 'Schedule',
    CONFIG: 'Config',
    SERVICES: 'Services',
    HOMEPAGE: 'Homepage',
    BATCHES: 'Batches',
    FERM_SCHEDULES: 'FermSchedules',
    BATCH_TASKS: 'BatchTasks',
    PLATO_READINGS: 'PlatoReadings',
    VESSEL_HISTORY: 'VesselHistory'
  }
};

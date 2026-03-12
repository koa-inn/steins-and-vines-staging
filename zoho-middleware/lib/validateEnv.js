var log = require('./logger');

// Required vars — missing any causes process.exit(1) at startup.
var REQUIRED = [
  { name: 'ZOHO_CLIENT_ID',     desc: 'Zoho OAuth client ID' },
  { name: 'ZOHO_CLIENT_SECRET', desc: 'Zoho OAuth client secret' },
  { name: 'ZOHO_ORG_ID',        desc: 'Zoho organization ID' },
  { name: 'API_SECRET_KEY',     desc: 'Shared secret for authenticated /api/* endpoints (or MW_API_KEY as alias)' },
];

// Optional vars — missing any logs a warning but startup continues.
var OPTIONAL = [
  { name: 'ZOHO_REFRESH_TOKEN',        desc: 'Zoho refresh token (can be set via /auth/zoho)' },
  { name: 'ZOHO_REDIRECT_URI',         desc: 'Zoho OAuth redirect URI' },
  { name: 'ZOHO_DOMAIN',               desc: 'Zoho domain (default: zohobooks.com)' },
  { name: 'REDIS_URL',                 desc: 'Redis connection URL (default: redis://localhost:6379)' },
  { name: 'PORT',                      desc: 'HTTP server port (default: 3001)' },
  { name: 'NODE_ENV',                  desc: 'Node environment' },
  { name: 'LOG_LEVEL',                 desc: 'Logger level (default: info)' },
  { name: 'SENTRY_DSN',                desc: 'Sentry DSN for error tracking' },
  { name: 'SMTP_HOST',                 desc: 'SMTP server host' },
  { name: 'SMTP_PORT',                 desc: 'SMTP server port' },
  { name: 'SMTP_USER',                 desc: 'SMTP auth username' },
  { name: 'SMTP_PASS',                 desc: 'SMTP auth password' },
  { name: 'CONTACT_TO',               desc: 'Contact form destination email' },
  { name: 'GP_ENVIRONMENT',           desc: 'Global Payments environment (test/production)' },
  { name: 'GP_APP_ID',                desc: 'Global Payments app ID' },
  { name: 'GP_APP_KEY',               desc: 'Global Payments app key' },
  { name: 'GP_MERCHANT_ID',           desc: 'Global Payments merchant ID' },
  { name: 'GP_TERMINAL_ENABLED',      desc: 'Enable GP POS terminal (true/false)' },
  { name: 'GP_DEPOSIT_AMOUNT',        desc: 'GP POS deposit amount' },
  { name: 'RECAPTCHA_SECRET_KEY',     desc: 'Google reCAPTCHA secret (fail-open if missing)' },
  { name: 'INVENTORY_LEDGER_ENABLED', desc: 'Enable Redis inventory ledger (true/false)' },
  { name: 'MAKERS_FEE_ITEM_ID',       desc: 'Zoho item ID for the Maker\'s Fee line item' },
  { name: 'ZOHO_CF_STATUS',           desc: 'Zoho custom field: reservation status' },
  { name: 'ZOHO_CF_TIMESLOT',         desc: 'Zoho custom field: timeslot' },
  { name: 'ZOHO_CF_DEPOSIT',          desc: 'Zoho custom field: deposit amount' },
  { name: 'ZOHO_CF_BALANCE',          desc: 'Zoho custom field: balance due' },
  { name: 'ZOHO_CF_APPOINTMENT_ID',   desc: 'Zoho custom field: appointment ID' },
  { name: 'ZOHO_CF_TRANSACTION_ID',   desc: 'Zoho custom field: transaction ID' },
  { name: 'ZOHO_TAX_STANDARD_ID',     desc: 'Zoho tax ID: standard rate' },
  { name: 'ZOHO_TAX_STANDARD_RULE',   desc: 'Zoho tax rule: standard rate' },
  { name: 'ZOHO_TAX_LIQUOR_ID',       desc: 'Zoho tax ID: liquor rate' },
  { name: 'ZOHO_TAX_LIQUOR_RULE',     desc: 'Zoho tax rule: liquor rate' },
  { name: 'ZOHO_TAX_SERVICES_ID',     desc: 'Zoho tax ID: services rate' },
  { name: 'ZOHO_TAX_SERVICES_RULE',   desc: 'Zoho tax rule: services rate' },
  { name: 'ZOHO_TAX_ZERO_ID',         desc: 'Zoho tax ID: zero rate' },
  { name: 'ZOHO_TAX_ZERO_RULE',       desc: 'Zoho tax rule: zero rate' },
  { name: 'ZOHO_BOOKINGS_SERVICE_ID', desc: 'Zoho Bookings service ID' },
  { name: 'ZOHO_BOOKINGS_STAFF_ID',   desc: 'Zoho Bookings staff ID' },
  { name: 'APPS_SCRIPT_URL',          desc: 'Google Apps Script Web App URL' },
  { name: 'APPS_SCRIPT_SERVER_TOKEN', desc: 'Apps Script server-to-server auth token' },
  { name: 'KIOSK_CONTACT_ID',         desc: 'Zoho contact ID for kiosk walk-in sales' },
  { name: 'KIOSK_TAX_RATE',           desc: 'Tax rate for kiosk sales' },
  { name: 'MW_API_KEY',               desc: 'Alias for API_SECRET_KEY (legacy)' },
];

function validateEnv() {
  var missing = REQUIRED.filter(function (v) {
    // API_SECRET_KEY accepts MW_API_KEY as a legacy alias
    if (v.name === 'API_SECRET_KEY') {
      return !process.env.API_SECRET_KEY && !process.env.MW_API_KEY;
    }
    return !process.env[v.name];
  });

  if (missing.length > 0) {
    missing.forEach(function (v) {
      log.error('[startup] Missing required env var: ' + v.name + ' — ' + v.desc);
    });
    log.error('[startup] ' + missing.length + ' required env var(s) missing. Exiting.');
    process.exit(1);
  }

  var missingOptional = OPTIONAL.filter(function (v) { return !process.env[v.name]; });
  if (missingOptional.length > 0) {
    log.warn('[startup] Optional env vars not set: ' + missingOptional.map(function (v) { return v.name; }).join(', '));
  }
}

module.exports = validateEnv;

var log = require('./logger');

// Required vars — missing any causes process.exit(1) at startup.
var REQUIRED = [
  { name: 'ZOHO_CLIENT_ID',     desc: 'Zoho OAuth client ID' },
  { name: 'ZOHO_CLIENT_SECRET', desc: 'Zoho OAuth client secret' },
  { name: 'ZOHO_ORG_ID',        desc: 'Zoho organization ID' },
  { name: 'API_SECRET_KEY',     desc: 'Shared secret for authenticated /api/* endpoints (or MW_API_KEY as alias)' },
];

// Required in production only (D-06) — missing any causes process.exit(1) when NODE_ENV=production.
// These are the live money-path / security secrets; their absence in prod is a hard misconfiguration.
// Full set = ROADMAP SC#5 (MONITOR-02, phase 33): RECAPTCHA, HELCIM webhook, Cal.com webhook,
// REDIS encryption, Sentry DSN, and live Helcim API token.
var REQUIRED_IN_PROD = [
  { name: 'RECAPTCHA_SECRET_KEY',  desc: 'Google reCAPTCHA secret — required in prod (fail-closed, HARDEN-01)' },
  { name: 'HELCIM_WEBHOOK_SECRET', desc: 'Helcim webhook HMAC secret — required in prod (fail-closed, HARDEN-02)' },
  { name: 'CALCOM_WEBHOOK_SECRET', desc: 'Cal.com webhook HMAC secret — required in prod (fail-closed, HARDEN-02)' },
  { name: 'REDIS_ENCRYPTION_KEY',  desc: 'Redis Zoho refresh-token encryption key — required in prod (#106)' },
  { name: 'SENTRY_DSN',            desc: 'Sentry DSN for error tracking — required in prod (MONITOR-02, ROADMAP SC#5, phase 33)' },
  { name: 'HELCIM_API_TOKEN',      desc: 'Helcim API token for payment processing — required in prod (live Helcim, ROADMAP SC#5, phase 33)' },
  { name: 'STAFF_EMAILS',          desc: 'Comma-separated staff Google email allowlist (D-46-07)' },
  { name: 'KIOSK_DEVICE_TOKEN',    desc: 'Kiosk device token, constant-time compared (D-46-01)' },
  { name: 'SHEETS_CLIENT_ID',      desc: 'Google OAuth client ID for server-side aud check (D-46-05)' },
  { name: 'DATABASE_URL',          desc: 'Postgres connection string (private Railway network) — required in prod (D-01, DB-02)' },
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
  { name: 'RESEND_API_KEY',            desc: 'Resend API key for transactional email (HTTPS; SMTP is blocked on Railway)' },
  { name: 'MAIL_FROM',                 desc: 'From address on a Resend-verified domain (default: hello@steinsandvines.ca)' },
  { name: 'CONTACT_TO',               desc: 'Contact form + staff notification destination email' },
  // NOTE: RECAPTCHA_SECRET_KEY, HELCIM_WEBHOOK_SECRET, CALCOM_WEBHOOK_SECRET, and
  // REDIS_ENCRYPTION_KEY are intentionally NOT listed here — they live in
  // REQUIRED_IN_PROD. Listing them as OPTIONAL too produced a misleading
  // "optional env vars not set" warning in dev/CI where they are legitimately absent.
  { name: 'HELCIM_DEVICE_CODE',       desc: 'Helcim POS terminal device code (leave blank to disable)' },
  { name: 'INVENTORY_LEDGER_ENABLED', desc: 'Enable Redis inventory ledger (true/false)' },
  { name: 'MAKERS_FEE_ITEM_ID',       desc: 'Zoho item ID for the Maker\'s Fee line item' },
  { name: 'MATERIALS_FEE_ITEM_ID',    desc: 'Zoho item ID for the Materials Fee line item' },
  { name: 'ZOHO_CF_STATUS',           desc: 'Zoho custom field: reservation status' },
  { name: 'ZOHO_CF_TIMESLOT',         desc: 'Zoho custom field: timeslot' },
  { name: 'ZOHO_CF_DEPOSIT',          desc: 'Zoho custom field: deposit amount' },
  { name: 'ZOHO_CF_BALANCE',          desc: 'Zoho custom field: balance due' },
  { name: 'ZOHO_CF_APPOINTMENT_ID',   desc: 'Zoho custom field: appointment ID' },
  { name: 'ZOHO_CF_TRANSACTION_ID',   desc: 'Zoho custom field: transaction ID' },
  { name: 'ZOHO_CF_BATCH_STATUS',    desc: 'Zoho custom field API name for batch status on invoices (e.g. cf_batch_status)' },
  { name: 'ZOHO_TAX_STANDARD_ID',     desc: 'Zoho tax ID: standard rate' },
  { name: 'ZOHO_TAX_STANDARD_RULE',   desc: 'Zoho tax rule: standard rate' },
  { name: 'ZOHO_TAX_LIQUOR_ID',       desc: 'Zoho tax ID: liquor rate' },
  { name: 'ZOHO_TAX_LIQUOR_RULE',     desc: 'Zoho tax rule: liquor rate' },
  { name: 'ZOHO_TAX_SERVICES_ID',     desc: 'Zoho tax ID: services rate' },
  { name: 'ZOHO_TAX_SERVICES_RULE',   desc: 'Zoho tax rule: services rate' },
  { name: 'ZOHO_TAX_ZERO_ID',         desc: 'Zoho tax ID: zero rate' },
  { name: 'ZOHO_TAX_ZERO_RULE',       desc: 'Zoho tax rule: zero rate' },
  { name: 'CALCOM_API_KEY',                  desc: 'Cal.com API v2 key (Bearer auth)' },
  { name: 'CALCOM_EVENT_TYPE_FERMENT_KIT',   desc: 'Cal.com numeric event-type id for ferment-in-store' },
  { name: 'CALCOM_EVENT_TYPE_BOTTLING',      desc: 'Cal.com numeric event-type id for bottling' },
  { name: 'CALCOM_EVENT_TYPE_BEER_PACKAGING', desc: 'Cal.com numeric event-type id for Beer Packaging Appointment (6028745)' },
  { name: 'CALCOM_EVENT_TYPE_BEER_WAITLIST', desc: 'Cal.com numeric event-type id for the beer waitlist consult (6955754)' },
  { name: 'APPS_SCRIPT_URL',         desc: 'Google Apps Script Web App URL' },
  { name: 'APPS_SCRIPT_SERVER_TOKEN', desc: 'Apps Script server-to-server auth token' },
  { name: 'KIOSK_CONTACT_ID',         desc: 'Zoho contact ID for kiosk walk-in sales' },
  { name: 'KIOSK_GIFT_CARD_ITEM_ID',  desc: 'Zoho item ID for gift certificate sales (maps to Gift Card Sales income account); gift-card issue/redeem routes fail-closed 503 without it' },
  { name: 'ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID', desc: 'Zoho account_id for the "Gift Cards Sold" clearing account used when posting gift-card portion of a split-tender customerpayment (payment_mode:others); falls back to hardcoded 109900000000873231 if unset' },
  { name: 'KIOSK_TAX_RATE',           desc: 'Tax rate for kiosk sales' },
  { name: 'MW_API_KEY',               desc: 'Alias for API_SECRET_KEY (legacy)' },
  { name: 'KIOSK_PIN',                desc: 'Four-digit PIN for kiosk access verification' },
  { name: 'BEER_SALES_ENABLED',       desc: 'Enable beer recipe sales in kiosk and public browsing (true/false, default: false)' },
  { name: 'MILLING_FEE_ITEM_ID',      desc: 'Zoho item ID for the grain milling fee service item (take-out recipe sales)' },
];

function validateEnv() {
  // ── D-02: Boot assertion — "looks like prod but NODE_ENV !== production" ──
  // RAILWAY_ENVIRONMENT is injected by Railway into every service. If it is set,
  // this process is running on Railway. Refusing to boot when NODE_ENV is not
  // 'production' prevents a silent misconfiguration from re-opening every
  // fail-closed gate added in Plans 01-02. This check MUST NOT be gated on
  // isProd (that would be circular).
  if (process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== 'production') {
    log.error('[startup] RAILWAY_ENVIRONMENT set but NODE_ENV !== production — refusing to boot fail-open (D-02)');
    log.error('[startup] Set NODE_ENV=production explicitly on the Railway middleware service.');
    process.exit(1);
  }

  // ── Existing REQUIRED check (unchanged) ───────────────────────────────────
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

  // ── D-06: REQUIRED_IN_PROD — hard-fail boot on missing prod secrets ───────
  // In production, every money-path / security secret must be set BEFORE
  // deploy. A missing secret breaks the deploy loudly (boot fails) rather than
  // silently rejecting every customer at runtime. The runtime fail-closed gates
  // (D-03/D-04/D-05) remain as defense-in-depth.
  var isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    var missingProd = REQUIRED_IN_PROD.filter(function (v) {
      return !process.env[v.name];
    });
    if (missingProd.length > 0) {
      missingProd.forEach(function (v) {
        log.error('[startup] Missing required prod secret: ' + v.name + ' — ' + v.desc);
      });
      log.error('[startup] ' + missingProd.length + ' required prod secret(s) missing. Exiting. (D-06)');
      process.exit(1);
    }
  }

  var missingOptional = OPTIONAL.filter(function (v) { return !process.env[v.name]; });
  if (missingOptional.length > 0) {
    log.warn('[startup] Optional env vars not set: ' + missingOptional.map(function (v) { return v.name; }).join(', '));
  }

  // Email is "optional" infrastructure but its absence is silent and costly:
  // without a Resend API key, no order confirmation or staff notification ever
  // sends. Call it out specifically so a broken mail setup is obvious in the logs.
  if (!process.env.RESEND_API_KEY) {
    log.warn('[startup] RESEND_API_KEY not set — order confirmation and staff notification emails are DISABLED');
  }
}

module.exports = validateEnv;

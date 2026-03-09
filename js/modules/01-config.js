// ===== Middleware API Key =====

// Loaded from js/sheets-config.js (SHEETS_CONFIG.MW_API_KEY = Railway API_SECRET_KEY).
// Rotate via: openssl rand -base64 32, then update Railway API_SECRET_KEY + sheets-config.js.
var MW_API_KEY = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MW_API_KEY) ? SHEETS_CONFIG.MW_API_KEY : '';

// ===== Payment flag =====
var PAYMENT_DISABLED = false;

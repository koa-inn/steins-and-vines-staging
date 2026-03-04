// ===== Middleware API Key =====

// Semi-public key — protected by CORS origin whitelist on the middleware.
// Rotate via: openssl rand -base64 32, then update Railway MW_API_KEY env var.
var MW_API_KEY = 'a9QKtDV3DtYSFIdWtfAMg9Ry70bHG55QGhyJa9GD3fM=';

// ===== Payment flag =====
// TODO: Set to false once Global Payments card entry is working again.
var PAYMENT_DISABLED = true;

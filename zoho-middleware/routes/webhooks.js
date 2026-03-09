var express = require('express');
var crypto = require('crypto');
var cache = require('../lib/cache');
var log = require('../lib/logger');

var router = express.Router();

// ---------------------------------------------------------------------------
// Cache keys to invalidate when Zoho signals a stock/item change
// ---------------------------------------------------------------------------
var PRODUCT_CACHE_KEYS = [
  'zoho:products',
  'zoho:products:ts',
  'zoho:ingredients',
  'zoho:ingredients:ts',
  'zoho:kiosk-products',
  'zoho:services'
];

// ---------------------------------------------------------------------------
// POST /webhooks/zoho-inventory
//
// Receives item/stock change events from Zoho Inventory and busts Redis cache
// so the next catalog request fetches fresh data.
//
// Authentication: Zoho is configured to send X-Webhook-Secret header.
// Set ZOHO_WEBHOOK_SECRET in Railway env and mirror it in Zoho's webhook config.
// ---------------------------------------------------------------------------
router.post('/webhooks/zoho-inventory', function (req, res) {
  var secret = process.env.ZOHO_WEBHOOK_SECRET;

  // Reject if secret not configured server-side
  if (!secret) {
    log.warn('[webhook] ZOHO_WEBHOOK_SECRET not set — rejecting request');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  // Validate secret sent by Zoho using constant-time comparison (prevents timing attacks)
  var incoming = req.headers['x-webhook-secret'] || '';
  var secretBuf = Buffer.from(secret);
  var incomingBuf = Buffer.from(incoming);
  var valid = incomingBuf.length === secretBuf.length &&
    crypto.timingSafeEqual(incomingBuf, secretBuf);
  if (!valid) {
    log.warn('[webhook] Invalid webhook secret from ' + (req.ip || 'unknown'));
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var body = req.body || {};
  var eventType = body.event_type || 'unknown';
  var itemName = (body.data && body.data.item && body.data.item.name) || '';

  log.info('[webhook] Received Zoho event: ' + eventType + (itemName ? ' (' + itemName + ')' : ''));

  // Bust all product caches in parallel
  Promise.all(PRODUCT_CACHE_KEYS.map(function (key) {
    return cache.del(key).catch(function (err) {
      log.warn('[webhook] Failed to delete cache key ' + key + ': ' + err.message);
    });
  })).then(function () {
    log.info('[webhook] Cache busted for event: ' + eventType);
    res.json({ ok: true, event: eventType });
  }).catch(function (err) {
    log.error('[webhook] Cache bust failed: ' + err.message);
    res.status(500).json({ error: 'Cache invalidation failed' });
  });
});

module.exports = router;

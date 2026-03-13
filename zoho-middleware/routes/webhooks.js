var express = require('express');
var helcimLib = require('../lib/helcim');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
var mailer = require('../lib/mailer');

var router = express.Router();

// TTL for terminal result cache entries (used by kiosk polling fallback)
var TERMINAL_RESULT_TTL = 300; // 5 minutes

/**
 * POST /api/webhooks/helcim
 * Receive and process Helcim webhook events.
 *
 * Helcim sends events for: cardTransaction (purchase/refund/void), terminalCancel.
 * Payload is minimal JSON: { id, type }. Full details fetched via API if needed.
 *
 * Signature verification uses HMAC-SHA256 with HELCIM_WEBHOOK_SECRET.
 * Configured in Helcim Hub > Integrations > Webhooks.
 *
 * Security: raw body is required for signature verification.
 * The express.json() middleware must run AFTER this route captures rawBody,
 * or use express.raw() on this route specifically.
 */
router.post('/api/webhooks/helcim', express.raw({ type: 'application/json' }), function (req, res) {
  var webhookId = req.headers['webhook-id'] || '';
  var timestamp = req.headers['webhook-timestamp'] || '';
  var signature = req.headers['webhook-signature'] || '';
  var rawBody = req.body ? req.body.toString() : '';

  // Verify HMAC-SHA256 signature
  if (!helcimLib.verifyWebhookSignature(webhookId, timestamp, rawBody, signature)) {
    log.warn('[webhook/helcim] Invalid signature — rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  var event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    log.warn('[webhook/helcim] Invalid JSON body');
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Respond 200 immediately — process asynchronously to avoid webhook timeout
  res.status(200).json({ received: true });

  var eventType = event.type || '';
  var eventId = event.id || '';

  log.info('[webhook/helcim] Event received: type=' + eventType + ' id=' + eventId);
  eventLog.logEvent('helcim.webhook_received', { type: eventType, id: eventId });

  if (eventType === 'cardTransaction') {
    handleCardTransaction(event);
  } else if (eventType === 'terminalCancel') {
    handleTerminalCancel(event);
  } else {
    log.info('[webhook/helcim] Unhandled event type: ' + eventType);
  }
});

/**
 * Handle cardTransaction webhook events.
 * These fire for purchases, refunds, and voids on both online and terminal transactions.
 *
 * For terminal purchases: cache the result so kiosk polling picks it up immediately.
 */
function handleCardTransaction(event) {
  var data = event.data || {};
  var transactionId = data.transactionId || event.id || '';
  var status = (data.status || '').toUpperCase();
  var invoiceNumber = data.invoiceNumber || '';
  var cardType = data.cardType || '';
  var transactionType = (data.type || '').toLowerCase(); // 'purchase', 'refund', 'void'

  log.info('[webhook/helcim] cardTransaction: type=' + transactionType +
    ' status=' + status + ' txn=' + transactionId + ' invoice=' + invoiceNumber);

  // Cache the terminal result so pos.js polling fallback resolves immediately
  if (invoiceNumber && (transactionType === 'purchase' || !transactionType)) {
    var cacheKey = 'helcim:terminal:result:' + invoiceNumber;
    cache.set(cacheKey, JSON.stringify({
      status: status,
      transactionId: transactionId,
      approved: status === 'APPROVED',
      cardType: cardType
    }), TERMINAL_RESULT_TTL).catch(function (err) {
      log.warn('[webhook/helcim] Failed to cache terminal result: ' + err.message);
    });
  }

  eventLog.logEvent('helcim.card_transaction', {
    transactionType: transactionType,
    status: status,
    txnId: transactionId,
    invoiceNumber: invoiceNumber
  });
}

/**
 * Handle terminalCancel webhook events.
 * Fires when a customer or cashier cancels a pending terminal transaction.
 * Cache the cancellation so kiosk polling resolves with DECLINED status.
 */
function handleTerminalCancel(event) {
  var data = event.data || {};
  var invoiceNumber = data.invoiceNumber || '';

  log.info('[webhook/helcim] terminalCancel: invoice=' + invoiceNumber);

  if (invoiceNumber) {
    var cacheKey = 'helcim:terminal:result:' + invoiceNumber;
    cache.set(cacheKey, JSON.stringify({
      status: 'DECLINED',
      transactionId: null,
      approved: false,
      cardType: ''
    }), TERMINAL_RESULT_TTL).catch(function (err) {
      log.warn('[webhook/helcim] Failed to cache terminal cancel: ' + err.message);
    });
  }

  eventLog.logEvent('helcim.terminal_cancel', { invoiceNumber: invoiceNumber });
}

module.exports = router;

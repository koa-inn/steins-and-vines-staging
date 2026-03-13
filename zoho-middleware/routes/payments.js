var express = require('express');
var helcimLib = require('../lib/helcim');
var log = require('../lib/logger');

var router = express.Router();

/**
 * POST /api/payment/void
 * Void a transaction (used when Zoho order creation fails after payment).
 *
 * Expected body: { transaction_id: "..." }
 */
router.post('/api/payment/void', function (req, res) {
  var txnId = req.body && req.body.transaction_id;
  if (!txnId || typeof txnId !== 'string' || txnId.length > 64) {
    return res.status(400).json({ error: 'Invalid transaction_id' });
  }
  if (!helcimLib.isEnabled()) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  helcimLib.voidTransaction(txnId)
    .then(function (result) {
      log.info('[payment/void] Voided txn=' + txnId);
      res.json({ ok: true, transaction_id: txnId, status: 'voided' });
    })
    .catch(function (err) {
      log.error('[payment/void] Error: ' + err.message);
      res.status(502).json({ error: 'Transaction void failed' });
    });
});

/**
 * POST /api/payment/refund
 * Refund a deposit (for cancellations).
 *
 * Expected body: { transaction_id: "...", amount: 50.00 }
 */
router.post('/api/payment/refund', function (req, res) {
  var body = req.body;
  if (!body || !body.transaction_id) {
    return res.status(400).json({ error: 'Missing transaction_id' });
  }
  if (typeof body.transaction_id !== 'string' || body.transaction_id.length > 64) {
    return res.status(400).json({ error: 'Invalid transaction_id' });
  }
  if (!helcimLib.isEnabled()) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  var amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > helcimLib.getDepositAmount()) {
    return res.status(400).json({ error: 'Invalid refund amount' });
  }

  helcimLib.refundTransaction(body.transaction_id, amount)
    .then(function (result) {
      log.info('[payment/refund] Refunded txn=' + body.transaction_id + ' amount=' + amount);
      res.json({
        ok: true,
        transaction_id: result.transactionId,
        original_transaction_id: body.transaction_id,
        amount: amount,
        status: 'refunded'
      });
    })
    .catch(function (err) {
      log.error('[payment/refund] Error: ' + err.message);
      res.status(502).json({ error: 'Refund could not be processed' });
    });
});

module.exports = router;

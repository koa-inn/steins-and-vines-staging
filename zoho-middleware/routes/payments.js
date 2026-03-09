var express = require('express');
var gp = require('globalpayments-api');
var gpLib = require('../lib/gp');
var log = require('../lib/logger');

var CreditCardData = gp.CreditCardData;
var Transaction = gp.Transaction;

var router = express.Router();

/**
 * POST /api/payment/charge
 * Charge a deposit using a single-use token from the client.
 *
 * Expected body:
 * {
 *   token: "single-use-token-from-globalpayments-js",
 *   amount: 50.00,
 *   customer: { name: "...", email: "..." }
 * }
 */
router.post('/api/payment/charge', function (req, res) {
  var body = req.body;

  if (!body || !body.token) {
    return res.status(400).json({ error: 'Missing payment token' });
  }
  if (!process.env.GP_APP_KEY) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  // Fix 3: amount is validated server-side; client-supplied amount is only accepted
  // if it exactly matches the canonical deposit configured via GP_DEPOSIT_AMOUNT env var.
  // The canonical amount is computed server-side from gpLib.getDepositAmount() —
  // a client cannot dictate a different charge amount.
  var amount = parseFloat(body.amount);
  if (isNaN(amount) || amount !== gpLib.getDepositAmount()) {
    return res.status(400).json({ error: 'Invalid payment amount' });
  }

  var card = new CreditCardData();
  card.token = body.token;

  card.charge(amount)
    .withCurrency('CAD')
    .withAllowDuplicates(true)
    .execute()
    .then(function (response) {
      if (response.responseCode !== 'SUCCESS' && response.responseCode !== '00') {
        log.warn('[payment/charge] Declined: ' + response.responseCode + ' ' + response.responseMessage);
        return res.status(402).json({
          error: 'Payment declined: ' + (response.responseMessage || 'Unknown error'),
          code: response.responseCode
        });
      }

      log.info('[payment/charge] Success: txn=' + response.transactionId);
      res.json({
        transaction_id: response.transactionId,
        auth_code: response.authorizationCode || '',
        status: 'approved',
        amount: amount
      });
    })
    .catch(function (err) {
      log.error('[payment/charge] Error: ' + err.message);
      res.status(502).json({ error: 'Payment could not be processed' });
    });
});

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

  Transaction.fromId(txnId)
    .void()
    .execute()
    .then(function (response) {
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

  var amount = parseFloat(body.amount);
  if (isNaN(amount) || amount !== gpLib.getDepositAmount()) {
    return res.status(400).json({ error: 'Invalid refund amount' });
  }

  Transaction.fromId(body.transaction_id)
    .refund(amount)
    .withCurrency('CAD')
    .execute()
    .then(function (response) {
      if (response.responseCode !== '00') {
        return res.status(400).json({
          error: 'Refund declined: ' + (response.responseMessage || 'Unknown error'),
          code: response.responseCode
        });
      }

      log.info('[payment/refund] Refunded txn=' + body.transaction_id + ' amount=' + amount);
      res.json({
        ok: true,
        transaction_id: response.transactionId,
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

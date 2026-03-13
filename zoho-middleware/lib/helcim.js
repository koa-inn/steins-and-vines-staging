var axios = require('axios');
var crypto = require('crypto');
var log = require('./logger');

var HELCIM_BASE_URL = 'https://api.helcim.com/v2';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

var HELCIM_API_TOKEN = '';
var HELCIM_DEVICE_CODE = '';
var HELCIM_DEPOSIT_AMOUNT = 50.00;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Helcim integration.
 * Reads credentials from environment. Call once at startup.
 */
function init() {
  HELCIM_API_TOKEN = process.env.HELCIM_API_TOKEN || '';
  HELCIM_DEVICE_CODE = process.env.HELCIM_DEVICE_CODE || '';
  // Supports HELCIM_DEPOSIT_AMOUNT; falls back to legacy GP_DEPOSIT_AMOUNT during migration
  HELCIM_DEPOSIT_AMOUNT = parseFloat(process.env.HELCIM_DEPOSIT_AMOUNT || process.env.GP_DEPOSIT_AMOUNT) || 50.00;

  if (HELCIM_API_TOKEN) {
    log.info('Helcim configured (deposit: $' + HELCIM_DEPOSIT_AMOUNT.toFixed(2) + ')');
  } else {
    log.info('Helcim not configured (HELCIM_API_TOKEN missing)');
  }

  if (HELCIM_DEVICE_CODE) {
    log.info('Helcim Smart Terminal configured (device: ' + HELCIM_DEVICE_CODE + ')');
  } else {
    log.info('Helcim terminal not enabled (HELCIM_DEVICE_CODE not set)');
  }
}

function isEnabled() {
  return !!HELCIM_API_TOKEN;
}

function isTerminalEnabled() {
  return !!HELCIM_API_TOKEN && !!HELCIM_DEVICE_CODE;
}

function getDepositAmount() {
  return HELCIM_DEPOSIT_AMOUNT;
}

function getTerminalDiagnostics() {
  return {
    HELCIM_API_TOKEN_SET: !!HELCIM_API_TOKEN,
    HELCIM_DEVICE_CODE_SET: !!HELCIM_DEVICE_CODE,
    device_initialized: isTerminalEnabled(),
    init_error: null
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a unique 25-character alphanumeric idempotency key.
 * Helcim requires idempotency-key on every charge and terminal request.
 */
function generateIdempotencyKey() {
  // randomBytes(19) → 38 hex chars; slice to 25 satisfies Helcim's requirement
  return crypto.randomBytes(19).toString('hex').substring(0, 25);
}

/**
 * Build standard request headers for the Helcim REST API.
 */
function helcimHeaders(idempotencyKey) {
  var headers = {
    'api-token': HELCIM_API_TOKEN,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (idempotencyKey) {
    // Enforce alphanumeric only, max 25 chars
    headers['idempotency-key'] = String(idempotencyKey)
      .replace(/[^a-zA-Z0-9]/g, '')
      .substring(0, 25);
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Online checkout (HelcimPay.js)
// ---------------------------------------------------------------------------

/**
 * Initialize a HelcimPay.js checkout session.
 * The frontend uses the returned checkoutToken to render the payment iframe.
 * The payment is processed inside the iframe; the result comes back via window.postMessage.
 *
 * POST https://api.helcim.com/v2/helcim-pay/initialize
 *
 * @param {number} amount   - Amount to charge (e.g. 50.00)
 * @param {string} currency - ISO currency code (default 'CAD')
 * @returns {Promise<{ checkoutToken: string }>}
 */
function initializeCheckout(amount, currency) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  return axios.post(HELCIM_BASE_URL + '/helcim-pay/initialize', {
    paymentType: 'purchase',
    amount: amount,
    currency: currency || 'CAD'
  }, {
    headers: helcimHeaders(),
    timeout: 10000
  }).then(function (resp) {
    var data = resp.data || {};
    if (!data.checkoutToken) {
      throw new Error('Helcim initialize did not return checkoutToken');
    }
    return { checkoutToken: data.checkoutToken };
  });
}

// ---------------------------------------------------------------------------
// Void & refund
// ---------------------------------------------------------------------------

/**
 * Void a transaction (same-day / open batch).
 * Use for ghost-charge recovery when Zoho order creation fails after payment.
 *
 * POST https://api.helcim.com/v2/payment/reverse
 *
 * @param {string} transactionId - Helcim transaction ID to void
 * @returns {Promise<{ ok: boolean, transactionId: string }>}
 */
function voidTransaction(transactionId) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  return axios.post(HELCIM_BASE_URL + '/payment/reverse', {
    transactionId: transactionId
  }, {
    headers: helcimHeaders(generateIdempotencyKey()),
    timeout: 10000
  }).then(function (resp) {
    var data = resp.data || {};
    return { ok: true, transactionId: transactionId, status: data.status || 'voided' };
  });
}

/**
 * Refund a transaction (closed batch, supports partial amounts).
 *
 * POST https://api.helcim.com/v2/payment/refund
 *
 * @param {string} transactionId - Helcim transaction ID to refund
 * @param {number} amount        - Amount to refund
 * @returns {Promise<{ ok: boolean, transactionId: string }>}
 */
function refundTransaction(transactionId, amount) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  return axios.post(HELCIM_BASE_URL + '/payment/refund', {
    transactionId: transactionId,
    amount: amount
  }, {
    headers: helcimHeaders(generateIdempotencyKey()),
    timeout: 10000
  }).then(function (resp) {
    var data = resp.data || {};
    return { ok: true, transactionId: transactionId, status: data.status || 'refunded' };
  });
}

// ---------------------------------------------------------------------------
// Smart Terminal (card-present / in-store kiosk)
// ---------------------------------------------------------------------------

/**
 * Push a purchase to the Helcim Smart Terminal.
 * Returns 202 Accepted immediately — the payment result is delivered via webhook.
 * Use pollTerminalResult() to check status if the webhook is delayed.
 *
 * POST https://api.helcim.com/v2/devices/{deviceCode}/payment/purchase
 *
 * @param {number} amount          - Grand total to charge
 * @param {string} invoiceNumber   - Reference number shown on terminal receipt
 * @param {string} [idempotencyKey] - Optional; generated if not supplied
 * @returns {Promise<{ ok: boolean, status: 'pending', idempotencyKey: string }>}
 */
function terminalPurchase(amount, invoiceNumber, idempotencyKey) {
  if (!HELCIM_API_TOKEN || !HELCIM_DEVICE_CODE) {
    return Promise.reject(new Error('Helcim terminal not configured'));
  }
  var idemKey = idempotencyKey || generateIdempotencyKey();
  var payload = {
    currency: 'CAD',
    transactionAmount: amount
  };
  if (invoiceNumber) payload.invoiceNumber = invoiceNumber;

  return axios.post(
    HELCIM_BASE_URL + '/devices/' + encodeURIComponent(HELCIM_DEVICE_CODE) + '/payment/purchase',
    payload,
    {
      headers: helcimHeaders(idemKey),
      timeout: 15000
    }
  ).then(function () {
    return { ok: true, status: 'pending', idempotencyKey: idemKey };
  });
}

/**
 * Poll for a terminal transaction result by invoice/reference number.
 * Fallback for when webhook delivery is delayed.
 * Call on a short interval (e.g. every 5s) up to 90s total.
 *
 * GET https://api.helcim.com/v2/transactions?invoiceNumber={invoiceNumber}
 *
 * @returns {Promise<{ status: string, transactionId: string, approved: boolean, cardType: string }>}
 */
function pollTerminalResult(invoiceNumber) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  // Check webhook cache first — if webhook already delivered the result, skip the API call
  var cache;
  try { cache = require('./cache'); } catch (e) { cache = null; }
  var cacheKey = 'helcim:terminal:result:' + invoiceNumber;
  var cacheCheck = cache
    ? cache.get(cacheKey).then(function (cached) {
        if (cached) {
          try { return JSON.parse(cached); } catch (e) { return null; }
        }
        return null;
      }).catch(function () { return null; })
    : Promise.resolve(null);

  return cacheCheck.then(function (cachedResult) {
    if (cachedResult) {
      log.info('[helcim] pollTerminalResult: webhook cache hit for ' + invoiceNumber);
      return cachedResult;
    }
    return axios.get(HELCIM_BASE_URL + '/transactions', {
      params: { invoiceNumber: invoiceNumber },
      headers: helcimHeaders(),
      timeout: 8000
    }).then(function (resp) {
      var transactions = Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.transactions) || [];
      if (transactions.length === 0) {
        return { status: 'pending', transactionId: null, approved: false, cardType: '' };
      }
      var txn = transactions[0];
      var status = (txn.status || '').toUpperCase();
      return {
        status: status,
        transactionId: txn.transactionId || '',
        approved: status === 'APPROVED',
        cardType: txn.cardType || ''
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/**
 * Verify a Helcim webhook HMAC-SHA256 signature.
 *
 * Payload to sign: webhookId + '.' + timestamp + '.' + rawBody
 * Signed with HELCIM_WEBHOOK_SECRET (verifier token from Helcim Hub).
 * Expected signature is base64-encoded.
 *
 * Fails open if HELCIM_WEBHOOK_SECRET is not configured (dev convenience,
 * matches the reCAPTCHA unconfigured pattern in this codebase).
 *
 * @param {string} webhookId  - From webhook-id header
 * @param {string} timestamp  - From webhook-timestamp header
 * @param {string} rawBody    - Raw request body string
 * @param {string} signature  - From webhook-signature header
 * @returns {boolean}
 */
function verifyWebhookSignature(webhookId, timestamp, rawBody, signature) {
  var secret = process.env.HELCIM_WEBHOOK_SECRET || '';
  if (!secret) {
    log.warn('[helcim] HELCIM_WEBHOOK_SECRET not set — skipping webhook signature verification');
    return true;
  }
  var payload = webhookId + '.' + timestamp + '.' + rawBody;
  var expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature || '')
    );
  } catch (e) {
    return false;
  }
}

module.exports = {
  init: init,
  isEnabled: isEnabled,
  isTerminalEnabled: isTerminalEnabled,
  getDepositAmount: getDepositAmount,
  getTerminalDiagnostics: getTerminalDiagnostics,
  initializeCheckout: initializeCheckout,
  voidTransaction: voidTransaction,
  refundTransaction: refundTransaction,
  terminalPurchase: terminalPurchase,
  pollTerminalResult: pollTerminalResult,
  verifyWebhookSignature: verifyWebhookSignature,
  generateIdempotencyKey: generateIdempotencyKey
};

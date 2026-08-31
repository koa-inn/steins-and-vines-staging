var axios = require('axios');
var crypto = require('crypto');
var log = require('./logger');

var HELCIM_BASE_URL = 'https://api.helcim.com/v2';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

var HELCIM_API_TOKEN = '';
var HELCIM_DEVICE_CODE = '';

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

  if (HELCIM_API_TOKEN) {
    log.info('Helcim configured');
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

/**
 * @deprecated Deposit amount concept removed (Apr 2026). Full order amount is now
 * charged at checkout. Returns 10000 as a safe upper bound for callers that use
 * this as a refund/amount cap (e.g. payments.js refund validation).
 */
function getDepositAmount() {
  return 10000;
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
 * @returns {Promise<{ checkoutToken: string, secretToken: string }>}
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
    return { checkoutToken: data.checkoutToken, secretToken: data.secretToken || '' };
  });
}

// ---------------------------------------------------------------------------
// Void & refund
// ---------------------------------------------------------------------------

/**
 * D-50-02: positive-signal, fail-closed inspection of a Helcim
 * /payment/reverse response body. Deliberately permissive on the positive
 * side (a real reversal must never be misreported as failed) and closed
 * only on genuinely uninformative or negative bodies (an empty body, a
 * request echo, or an explicit decline must never be misreported as a
 * successful void).
 *
 * CONFIRMED iff:
 *   - status (case-insensitive) is one of APPROVED, COMPLETED, REVERSED, VOIDED, OR
 *   - approved === true, OR
 *   - transactionId is present AND type (case-insensitive) is reverse or void
 *
 * @param {object} data - the reverse response body
 * @returns {boolean}
 */
function isReversalConfirmed(data) {
  var body = data || {};
  var status = String(body.status || '').toUpperCase();
  if (status === 'APPROVED' || status === 'COMPLETED' || status === 'REVERSED' || status === 'VOIDED') {
    return true;
  }
  if (body.approved === true) {
    return true;
  }
  var type = String(body.type || '').toLowerCase();
  if (body.transactionId && (type === 'reverse' || type === 'void')) {
    return true;
  }
  return false;
}

/**
 * Void a transaction (same-day / open batch).
 * Use for ghost-charge recovery when Zoho order creation fails after payment.
 *
 * POST https://api.helcim.com/v2/payment/reverse
 *
 * D-50-02: inspects the response body for a positive reversal signal
 * (see isReversalConfirmed) instead of trusting any 2xx. An unconfirmed
 * reversal REJECTS (D-50-02a) rather than resolving { ok: false } so every
 * existing caller's .catch flows into the proven fail-closed machinery
 * (sv:void-failure record + sendVoidFailureAlert + needs_manual_review)
 * with zero caller changes. The rejection message deliberately avoids the
 * substrings 'already'/'reversal'/'reversed'/'voided' (D-50-02b) so it does
 * not collide with lib/reconcile.js isAlreadyVoidedError, which treats
 * those substrings as an already-voided SUCCESS signal.
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
    // D-50-02: unconditional, not debug-gated — closes the knowledge gap on
    // Helcim's real reverse-response shape (undocumented in this repo; no
    // staging middleware to probe it against). No PAN/PII in this body.
    log.info('[helcim] reverse response for txn=' + transactionId + ': ' + JSON.stringify(data));
    if (isReversalConfirmed(data)) {
      return { ok: true, transactionId: transactionId, status: data.status || 'reversed' };
    }
    var err = new Error('Helcim void not confirmed (status=' + (data.status || 'none') + ')');
    err.isUnconfirmedVoid = true;
    err.helcimResponse = data;
    throw err;
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
    // Cache pending invoice by device code so terminalCancel webhook can correlate
    var pendingCache;
    try { pendingCache = require('./cache'); } catch { pendingCache = null; }
    if (pendingCache && invoiceNumber) {
      pendingCache.set('helcim:terminal:pending:' + HELCIM_DEVICE_CODE, invoiceNumber, 300)
        .catch(function () {});
    }
    return { ok: true, status: 'pending', idempotencyKey: idemKey };
  });
}

/**
 * Poll for a terminal transaction result by invoice/reference number.
 * Fallback for when webhook delivery is delayed.
 * Call on a short interval (e.g. every 5s) up to 90s total.
 *
 * GET https://api.helcim.com/v2/card-transactions?invoiceNumber={invoiceNumber}
 *
 * @returns {Promise<{ status: string, transactionId: string, approved: boolean, cardType: string }>}
 */
function pollTerminalResult(invoiceNumber) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  // Check webhook cache first — if webhook already delivered the result, skip the API call
  var cache;
  try { cache = require('./cache'); } catch { cache = null; }
  var cacheKey = 'helcim:terminal:result:' + invoiceNumber;
  var cacheCheck = cache
    ? cache.get(cacheKey).then(function (cached) {
        if (cached) {
          try { return JSON.parse(cached); } catch { return null; }
        }
        return null;
      }).catch(function () { return null; })
    : Promise.resolve(null);

  return cacheCheck.then(function (cachedResult) {
    if (cachedResult) {
      log.info('[helcim] pollTerminalResult: webhook cache hit for ' + invoiceNumber);
      return cachedResult;
    }
    return axios.get(HELCIM_BASE_URL + '/card-transactions', {
      params: { invoiceNumber: invoiceNumber },
      headers: helcimHeaders(),
      timeout: 8000
    }).catch(function (pollErr) {
      var statusCode = pollErr.response ? pollErr.response.status : null;
      if (statusCode === 401 || statusCode === 403) {
        log.warn('[helcim] card-transactions API forbidden (' + statusCode + ') — token likely missing read scope');
      } else {
        log.info('[helcim] pollTerminalResult: API poll failed (' + (statusCode || pollErr.message) + '), waiting for webhook');
      }
      return { data: null };
    }).then(function (resp) {
      var data = resp.data;
      if (!data) {
        return { status: 'pending', transactionId: null, approved: false, cardType: '' };
      }
      var transactions = Array.isArray(data) ? data : (data.transactions || []);
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

/**
 * Fetch a single card transaction by its Helcim transaction ID.
 * Used by the webhook handler as the primary (authoritative) way to resolve
 * invoice + status from a minimal { id, type:'cardTransaction' } webhook event.
 *
 * GET https://api.helcim.com/v2/card-transactions/{id}
 *
 * @param {string} id - Helcim transaction ID (event.id from webhook payload)
 * @returns {Promise<{ status: string, transactionId: string, invoiceNumber: string, cardType: string, amount: number }>}
 */
function getCardTransactionById(id) {
  if (!HELCIM_API_TOKEN) {
    return Promise.reject(new Error('Helcim not configured'));
  }
  return axios.get(HELCIM_BASE_URL + '/card-transactions/' + encodeURIComponent(id), {
    headers: helcimHeaders(),
    timeout: 8000
  }).then(function (resp) {
    var txn = resp.data || {};
    var status = (txn.status || '').toUpperCase();
    return {
      status: status,
      transactionId: txn.transactionId || id,
      invoiceNumber: txn.invoiceNumber || '',
      cardType: txn.cardType || '',
      amount: txn.amount || 0
    };
  }).catch(function (err) {
    // Re-reject so callers can distinguish failure from a successful API response
    return Promise.reject(err);
  });
}

/**
 * Resolve the pending invoice number for the configured terminal device.
 * Returns the invoiceNumber stored in Redis during terminalPurchase(), or null.
 * Used by the webhook handler as a fallback when getCardTransactionById fails.
 *
 * @returns {Promise<string|null>}
 */
function getPendingInvoiceForDevice() {
  if (!HELCIM_DEVICE_CODE) {
    return Promise.resolve(null);
  }
  var cache;
  try { cache = require('./cache'); } catch { cache = null; }
  if (!cache) return Promise.resolve(null);
  return cache.get('helcim:terminal:pending:' + HELCIM_DEVICE_CODE).then(function (val) {
    // cache.get already JSON-parses; if it's a plain string the value is the invoice
    if (val && typeof val === 'string') return val;
    return null;
  }).catch(function () {
    return null;
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
    var isProd = process.env.NODE_ENV === 'production';
    if (isProd) return false; // D-04: fail closed in prod — unsigned event rejected
    log.warn('[helcim] HELCIM_WEBHOOK_SECRET not set — skipping webhook signature verification');
    return true;
  }
  var rawSecret = secret.replace(/^whsec_/, '');
  var payload = webhookId + '.' + timestamp + '.' + rawBody;

  // Try base64-decoded key first (Svix standard), then raw string as fallback
  var keys = [Buffer.from(rawSecret, 'base64'), rawSecret];

  var candidates = (signature || '').split(' ');
  for (var k = 0; k < keys.length; k++) {
    var expected = crypto.createHmac('sha256', keys[k]).update(payload).digest('base64');
    for (var i = 0; i < candidates.length; i++) {
      var sig = candidates[i];
      var commaIdx = sig.indexOf(',');
      if (commaIdx !== -1) sig = sig.substring(commaIdx + 1);
      try {
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
          return true;
        }
      } catch {
        // length mismatch — try next
      }
    }
  }
  log.warn('[helcim] Webhook sig mismatch: tried base64+raw keys, ' +
    candidates.length + ' candidate(s), body_len=' + rawBody.length);
  return false;
}

function cancelTerminal() {
  // 68-02: Helcim has no documented in-flight device-cancel distinct from
  // reverse/void, and no txnId exists yet at cancel time to void against.
  // This is bookkeeping ONLY — the actual cancel-safety net is the
  // KIOSK_CANCELLED_PREFIX flag (routes/pos.js /api/pos/cancel) checked by
  // the Helcim webhook's APPROVED-result handler, which voids via
  // moneyPath.voidWithTimeout if a charge lands after this call. `ok: false`
  // reflects that the DEVICE itself was not remotely stopped — callers must
  // not infer the reader is idle from this response.
  log.info('[helcim] Cancel requested — device is not remotely stoppable; safety net is the server-side cancelled-flag + webhook void, not this call');
  return Promise.resolve({ ok: false, device_cancel_required: true });
}

function getDeviceCode() { return HELCIM_DEVICE_CODE; }

module.exports = {
  init: init,
  isEnabled: isEnabled,
  isTerminalEnabled: isTerminalEnabled,
  getDeviceCode: getDeviceCode,
  getDepositAmount: getDepositAmount,
  getTerminalDiagnostics: getTerminalDiagnostics,
  initializeCheckout: initializeCheckout,
  cancelTerminal: cancelTerminal,
  voidTransaction: voidTransaction,
  refundTransaction: refundTransaction,
  terminalPurchase: terminalPurchase,
  pollTerminalResult: pollTerminalResult,
  getCardTransactionById: getCardTransactionById,
  getPendingInvoiceForDevice: getPendingInvoiceForDevice,
  verifyWebhookSignature: verifyWebhookSignature,
  generateIdempotencyKey: generateIdempotencyKey
};

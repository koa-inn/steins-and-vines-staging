var express = require('express');
var helcimLib = require('../lib/helcim');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
var mailer = require('../lib/mailer');
var ledger = require('../lib/inventory-ledger');
var C = require('../lib/constants');

var zohoGet = zohoApi.zohoGet;
var zohoPost = zohoApi.zohoPost;

var KIOSK_PRODUCTS_CACHE_KEY = C.CACHE_KEYS.KIOSK_PRODUCTS;
var RECENT_ORDERS_CACHE_KEY = C.CACHE_KEYS.RECENT_ORDERS;
var RECENT_ORDERS_CACHE_TTL = 60; // seconds
var IDEMPOTENCY_KEY_TTL = 300; // 5 minutes in seconds

var router = express.Router();

/**
 * POST /api/kiosk/sale
 * Process a complete kiosk (in-store POS) sale.
 *
 * Flow:
 *   1. Validate cart items against Zoho live prices/stock
 *   2. Send payment to GP POS terminal
 *   3. On payment success: create a Zoho Books Invoice (auto-marks as paid)
 *   4. Invalidate kiosk products cache so stock refreshes
 *   5. Return receipt data
 *
 * If invoice creation fails after payment, void the GP transaction.
 *
 * Expected body:
 * {
 *   items: [
 *     { item_id: "zoho_item_id", name: "Product Name", quantity: 2, rate: 14.99 }
 *   ],
 *   tax_total: 3.00,          // ignored — tax is computed server-side (KIOSK_TAX_RATE, default 5%)
 *   reference_number: "KIOSK-001"  // optional reference for the invoice
 * }
 *
 * Note: client-supplied `rate` and `tax_total` are both ignored for all financial
 * calculations. Prices are anchored to the zoho:kiosk-products cache. Any item_id
 * not present in that cache causes an immediate 400 rejection.
 */
router.post('/api/kiosk/sale', function (req, res) {
  if (!helcimLib.isTerminalEnabled()) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  var body = req.body;

  // Idempotency: if client supplies a key, return cached result on retry
  var idempotencyKey = (body && typeof body.idempotency_key === 'string' && body.idempotency_key)
    ? C.CACHE_KEYS.KIOSK_IDEM_PREFIX + body.idempotency_key.slice(0, 128)
    : null;

  if (idempotencyKey) {
    return cache.get(idempotencyKey).then(function (cached) {
      if (cached) {
        log.info('[pos/kiosk/sale] Idempotent replay: ' + idempotencyKey);
        return res.status(201).json(cached);
      }
      processSale(body, idempotencyKey, req, res);
    }).catch(function () {
      processSale(body, idempotencyKey, req, res);
    });
  }

  processSale(body, null, req, res);
});

function processSale(body, idempotencyKey, req, res) {
  // Validate required fields
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (body.items.length > 50) {
    return res.status(400).json({ error: 'Too many items in cart' });
  }

  // Validate each line item (structural validation only — price comes from catalog)
  for (var v = 0; v < body.items.length; v++) {
    var vi = body.items[v];
    if (!vi.item_id || typeof vi.item_id !== 'string' || vi.item_id.length > 64) {
      return res.status(400).json({ error: 'Invalid item_id for item ' + v });
    }
    var vQty = Number(vi.quantity);
    if (!vQty || vQty < 1 || vQty > 100) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + v });
    }
  }

  // Item #1: Anchor prices to the server-side catalog cache.
  // Client-supplied rate values are ignored for all financial calculations.
  cache.get(KIOSK_PRODUCTS_CACHE_KEY).then(function (catalog) {
    // Build item_id → rate lookup from the authoritative catalog
    var catalogMap = {};
    if (Array.isArray(catalog)) {
      catalog.forEach(function (p) {
        if (p && p.item_id) catalogMap[p.item_id] = p.rate;
      });
    }

    // Reject immediately if any requested item is not in the catalog cache.
    // Do not fall back to client-supplied rates — that would defeat the anchoring.
    for (var ci = 0; ci < body.items.length; ci++) {
      var cItem = body.items[ci];
      if (catalogMap[cItem.item_id] === undefined) {
        return res.status(400).json({
          error: 'Item not found in current catalog: ' + cItem.item_id +
            '. Refresh the product list and try again.'
        });
      }
    }

    // Build line items using catalog price, ignoring client-supplied rate
    var subtotal = 0;
    var lineItems = body.items.map(function (item) {
      var qty = Number(item.quantity) || 1;
      var rate = catalogMap[item.item_id]; // authoritative price from catalog
      subtotal += qty * rate;
      return {
        item_id: item.item_id,
        name: item.name || '',
        quantity: qty,
        rate: rate
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;

    // Item #2: Compute tax server-side. Ignore client-supplied tax_total.
    var taxRate = parseFloat(process.env.KIOSK_TAX_RATE) || 0.05;
    var taxTotal = Math.round(subtotal * taxRate * 100) / 100;
    var grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

    processSaleWithPrices(body, idempotencyKey, req, res,
      lineItems, subtotal, taxTotal, grandTotal);
  }).catch(function (cacheErr) {
    log.error('[pos/kiosk/sale] Catalog cache read failed: ' + cacheErr.message);
    res.status(503).json({ error: 'Unable to verify item prices. Please try again.' });
  });
}

function processSaleWithPrices(body, idempotencyKey, req, res,
  lineItems, subtotal, taxTotal, grandTotal) {

  if (grandTotal <= 0) {
    return res.status(400).json({ error: 'Sale total must be greater than zero' });
  }
  if (grandTotal > 10000) {
    return res.status(400).json({ error: 'Sale total exceeds maximum' });
  }

  var refNumber = (body.reference_number && typeof body.reference_number === 'string')
    ? body.reference_number.slice(0, 64)
    : ('KIOSK-' + Date.now());

  log.info('[pos/kiosk/sale] Starting kiosk sale: total=$' + grandTotal.toFixed(2) +
    ' ref=' + refNumber + ' items=' + lineItems.length);

  // Step 1: Send payment to POS terminal
  // Push payment request to Helcim Smart Terminal (202 Accepted immediately).
  // Result is delivered via webhook; poll as fallback with 5s intervals up to 90s.
  var TERMINAL_TIMEOUT_MS = 90000;
  var POLL_INTERVAL_MS = 5000;

  helcimLib.terminalPurchase(grandTotal, refNumber)
    .then(function (pushResult) {
      log.info('[pos/kiosk/sale] Terminal push sent: ref=' + refNumber + ' idem=' + pushResult.idempotencyKey);

      // Poll for result — Helcim terminal responds asynchronously
      var pollStart = Date.now();
      function poll() {
        return helcimLib.pollTerminalResult(refNumber).then(function (result) {
          if (result.approved) {
            return result;
          }
          if (result.status === 'DECLINED') {
            var declineErr = new Error('Payment declined');
            declineErr.isDeclined = true;
            throw declineErr;
          }
          if (Date.now() - pollStart >= TERMINAL_TIMEOUT_MS) {
            throw new Error('Terminal timeout after 90s');
          }
          // Still pending — wait and retry
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(poll()); }, POLL_INTERVAL_MS);
          });
        });
      }

      return poll();
    })
    .then(function (termResponse) {
      if (!termResponse.approved) {
        log.warn('[pos/kiosk/sale] Terminal declined');
        return res.status(402).json({
          error: 'Payment declined',
          code: 'DECLINED'
        });
      }

      var txnId = termResponse.transactionId || '';
      log.info('[pos/kiosk/sale] Terminal approved: txn=' + txnId);

      // Step 2: Create Zoho Books Invoice
      // Use a generic "Walk-in Customer" contact (or create one if configured).
      // The invoice records the sale and auto-decrements inventory on confirm.
      var today = new Date().toISOString().slice(0, 10);

      // Build Zoho invoice — use cash_sale mode so it auto-marks as paid
      var invoicePayload = {
        date: today,
        reference_number: refNumber,
        payment_terms: 0,
        payment_terms_label: 'Due on Receipt',
        line_items: lineItems,
        notes: 'In-store kiosk sale. Terminal txn: ' + txnId,
        custom_fields: []
      };

      // Attach customer contact: always use the server-configured walk-in contact.
      // Never trust a caller-supplied contact_id — that would allow attaching
      // a kiosk invoice to an arbitrary Zoho contact (Item #8).
      var contactId = process.env.KIOSK_CONTACT_ID || '';
      if (contactId) invoicePayload.customer_id = contactId;

      // Attach transaction ID to custom field if configured
      if (txnId && process.env.ZOHO_CF_TRANSACTION_ID) {
        invoicePayload.custom_fields.push({
          api_name: process.env.ZOHO_CF_TRANSACTION_ID,
          value: txnId
        });
      }

      return zohoPost('/invoices', invoicePayload)
        .then(function (invoiceData) {
          var invoice = invoiceData.invoice || {};
          var invoiceId = invoice.invoice_id || '';
          var invoiceNumber = invoice.invoice_number || '';

          log.info('[pos/kiosk/sale] Invoice created: ' + invoiceNumber + ' id=' + invoiceId);

          // Step 3: Mark invoice as sent + record payment so inventory adjusts
          // Zoho auto-decrements stock when an invoice is confirmed.
          // We record a cash payment against it to mark as paid.
          var paymentChain = Promise.resolve();

          if (invoiceId) {
            paymentChain = zohoPost('/invoices/' + invoiceId + '/submit', {})
              .catch(function (submitErr) {
                // Non-fatal — invoice exists, stock will still adjust
                log.warn('[pos/kiosk/sale] Invoice submit failed (non-fatal): ' + submitErr.message);
              })
              .then(function () {
                // Record the payment against the invoice.
                // Item #16: Use creditcard (or debitcard if terminal reports debit)
                // rather than 'cash', since payment was taken via card terminal.
                var cardType = (termResponse.cardType || '').toLowerCase();
                var paymentMode = (cardType.indexOf('debit') !== -1) ? 'debitcard' : 'creditcard';

                return zohoPost('/customerpayments', {
                  payment_mode: paymentMode,
                  amount: grandTotal,
                  date: today,
                  reference_number: txnId || refNumber,
                  invoices: [{ invoice_id: invoiceId, amount_applied: grandTotal }],
                  notes: 'Kiosk POS payment. Terminal txn: ' + txnId
                });
              })
              .then(function () {
                log.info('[pos/kiosk/sale] Payment recorded for invoice ' + invoiceNumber);
              })
              .catch(function (payErr) {
                // Non-fatal — invoice and stock adjustment still happened
                log.error('[pos/kiosk/sale] Payment recording failed (non-fatal): ' + payErr.message);
              });
          }

          return paymentChain.then(function () {
            // Invalidate kiosk product cache so stock counts refresh
            cache.del(KIOSK_PRODUCTS_CACHE_KEY);

            // Fire-and-forget: decrement inventory ledger for sold items
            ledger.decrementStock(lineItems, 'kiosk:' + (invoiceNumber || 'unknown')).catch(function (err) {
              log.error('[pos/kiosk/sale] Inventory ledger decrement failed (non-fatal): ' + err.message);
            });

            var responseBody = {
              ok: true,
              transaction_id: txnId,
              auth_code: termResponse.authorizationCode || '',
              invoice_id: invoiceId,
              invoice_number: invoiceNumber,
              reference_number: refNumber,
              subtotal: subtotal,
              tax_total: taxTotal,
              total: grandTotal,
              date: today
            };

            // Store result before responding so immediate retries hit the cache
            var cacheWrite = idempotencyKey
              ? cache.set(idempotencyKey, responseBody, IDEMPOTENCY_KEY_TTL).catch(function () {})
              : Promise.resolve();

            return cacheWrite.then(function () {
              eventLog.logEvent('kiosk.sale_completed', {
                txnId: txnId,
                itemCount: lineItems.length,
                grandTotal: grandTotal,
                invoiceNumber: invoiceNumber
              });
              res.status(201).json(responseBody);
            });
          });
        })
        .catch(function (invoiceErr) {
          // Zoho invoice failed — void the terminal transaction
          var invoiceMsg = invoiceErr.message;
          if (invoiceErr.response && invoiceErr.response.data) {
            invoiceMsg = invoiceErr.response.data.message || invoiceErr.response.data.error || invoiceMsg;
          }
          log.error('[pos/kiosk/sale] Invoice creation failed after payment — voiding txn=' + txnId + ': ' + invoiceMsg);
          eventLog.logEvent('kiosk.sale_failed_after_charge', {
            txnId: txnId,
            itemCount: lineItems.length,
            grandTotal: grandTotal
          });

          helcimLib.voidTransaction(txnId)
            .then(function () {
              log.info('[pos/kiosk/sale] Voided txn=' + txnId + ' after invoice failure');
            })
            .catch(function (voidErr) {
              log.error('[pos/kiosk/sale] CRITICAL: Void failed for txn=' + txnId + ': ' + voidErr.message);
              // Write a durable Redis record so this survives log rotation.
              var failRecord = {
                txnId: txnId,
                amount: grandTotal,
                timestamp: new Date().toISOString(),
                error: voidErr.message,
                needs_manual_review: true
              };
              cache.set('sv:void-failure:' + Date.now(), failRecord, 60 * 60 * 24 * 30)
                .catch(function (redisErr) {
                  log.error('[pos/kiosk/sale] CRITICAL: Failed to persist void-failure record: ' + redisErr.message);
                });
              mailer.sendVoidFailureAlert({
                txnId: txnId,
                amount: grandTotal,
                error: voidErr.message,
                timestamp: failRecord.timestamp
              }).catch(function (mailErr) {
                log.error('[pos/kiosk/sale] Void failure alert email failed: ' + mailErr.message);
              });
            })
            .then(function () {
              if (res.headersSent) return;
              res.status(502).json({
                error: 'Payment was taken but order could not be recorded. Please contact support.',
                payment_voided: true,
                voided_transaction_id: txnId
              });
            });
        });
    })
    .catch(function (termErr) {
      // Item #17: A timeout means txnId is unavailable — no void attempt possible.
      if (termErr.message === 'Terminal timeout after 90s') {
        log.warn('[pos/kiosk/sale] Terminal timed out after 90s — no txn to void');
        return res.status(504).json({ error: 'Terminal did not respond in time. Please try again.' });
      }
      log.error('[pos/kiosk/sale] Terminal error: ' + termErr.message);
      res.status(502).json({ error: 'Terminal error — please try again' });
    });
}

/**
 * GET /api/pos/status
 * Check if the POS terminal is enabled and configured.
 */
router.get('/api/pos/status', function (req, res) {
  var diag = helcimLib.getTerminalDiagnostics();
  res.json({
    enabled: helcimLib.isTerminalEnabled(),
    terminal_type: helcimLib.isTerminalEnabled() ? 'Helcim Smart Terminal' : 'none',
    diagnostics: diag,
    _v: '20260312-1'
  });
});

/**
 * POST /api/pos/sale
 * Push a sale to the GP terminal via Meet in the Cloud.
 * The terminal displays the amount and waits for card tap/insert/swipe.
 *
 * Expected body:
 * {
 *   amount: 99.99,
 *   salesorder_number: "SO-00123",
 *   items: [{ name: "Product Name", price: "49.99", qty: 2 }],
 *   customer_name: "John Doe"
 * }
 *
 * Returns: { transaction_id, status, auth_code } on success
 */
router.post('/api/pos/sale', function (req, res) {
  if (!helcimLib.isTerminalEnabled()) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  var body = req.body;
  if (!body || !body.amount) {
    return res.status(400).json({ error: 'Missing amount' });
  }

  var amount = parseFloat(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 10000) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  var soNumber = body.salesorder_number || '';

  log.info('[pos/sale] Initiating terminal sale: $' + amount.toFixed(2) + ' SO=' + soNumber);

  var posRefNumber = soNumber || ('POS-' + Date.now());
  var LEGACY_TIMEOUT_MS = 90000;
  var LEGACY_POLL_MS = 5000;

  helcimLib.terminalPurchase(amount, posRefNumber)
    .then(function () {
      var pollStart = Date.now();
      function pollLegacy() {
        return helcimLib.pollTerminalResult(posRefNumber).then(function (result) {
          if (result.approved) return result;
          if (result.status === 'DECLINED') { var e = new Error('declined'); e.isDeclined = true; throw e; }
          if (Date.now() - pollStart >= LEGACY_TIMEOUT_MS) throw new Error('Terminal timeout after 90s');
          return new Promise(function (resolve) { setTimeout(function () { resolve(pollLegacy()); }, LEGACY_POLL_MS); });
        });
      }
      return pollLegacy();
    })
    .then(function (response) {
      if (!response.approved) {
        return res.status(402).json({ error: 'Terminal payment declined', code: 'DECLINED' });
      }
      var txnId = response.transactionId || '';
      log.info('[pos/sale] Terminal sale approved: txn=' + txnId);
      res.json({
        ok: true,
        transaction_id: txnId,
        status: 'approved',
        auth_code: '',
        amount: amount
      });

      // Item #9: Record the sale in Zoho Books as a background operation.
      // Create a one-line invoice then record a customer payment against it.
      // Errors are non-fatal — the Helcim terminal charge has already succeeded.
      var today = new Date().toISOString().slice(0, 10);
      var refNumber = posRefNumber;

        var invoicePayload = {
          date: today,
          reference_number: refNumber,
          payment_terms: 0,
          payment_terms_label: 'Due on Receipt',
          line_items: [{
            // Zoho Books accepts a description-only line item when no item_id is available.
            description: soNumber ? ('POS sale — ' + soNumber) : 'In-store POS sale',
            rate: amount,
            quantity: 1
          }],
          notes: 'Legacy POS sale. Terminal txn: ' + txnId,
          custom_fields: []
        };

        // Attach walk-in customer contact if configured
        var contactId = process.env.KIOSK_CONTACT_ID || '';
        if (contactId) invoicePayload.customer_id = contactId;

        // Attach GP transaction ID to custom field if configured
        if (txnId && process.env.ZOHO_CF_TRANSACTION_ID) {
          invoicePayload.custom_fields.push({
            api_name: process.env.ZOHO_CF_TRANSACTION_ID,
            value: txnId
          });
        }

        zohoPost('/invoices', invoicePayload)
          .then(function (invoiceData) {
            var invoice = invoiceData.invoice || {};
            var invoiceId = invoice.invoice_id || '';
            var invoiceNumber = invoice.invoice_number || '';
            log.info('[pos/sale] Invoice created: ' + invoiceNumber + ' id=' + invoiceId);

            if (!invoiceId) return;

            // Submit invoice then record payment
            return zohoPost('/invoices/' + invoiceId + '/submit', {})
              .catch(function (submitErr) {
                log.warn('[pos/sale] Invoice submit failed (non-fatal): ' + submitErr.message);
              })
              .then(function () {
                // Match kiosk/sale: detect debit vs credit from terminal response
                var cardType = (response.cardType || '').toLowerCase();
                var posPaymentMode = (cardType.indexOf('debit') !== -1) ? 'debitcard' : 'creditcard';
                return zohoPost('/customerpayments', {
                  payment_mode: posPaymentMode,
                  amount: amount,
                  date: today,
                  reference_number: txnId || refNumber,
                  invoices: [{ invoice_id: invoiceId, amount_applied: amount }],
                  notes: 'Legacy POS payment. Terminal txn: ' + txnId
                });
              })
              .then(function () {
                log.info('[pos/sale] Payment recorded for invoice ' + invoiceNumber);
              })
              .catch(function (payErr) {
                log.error('[pos/sale] Payment recording failed (non-fatal): ' + payErr.message);
              });
          })
          .catch(function (invoiceErr) {
            var msg = invoiceErr.message;
            if (invoiceErr.response && invoiceErr.response.data) {
              msg = invoiceErr.response.data.message || invoiceErr.response.data.error || msg;
            }
            log.error('[pos/sale] Zoho invoice creation failed (non-fatal, txn=' + txnId + '): ' + msg);
          });
    })
    .catch(function (err) {
      if (err && err.isDeclined) {
        if (!res.headersSent) res.status(402).json({ error: 'Terminal payment declined' });
        return;
      }
      log.error('[pos/sale] Terminal error: ' + err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Terminal error' });
    });
});

/**
 * GET /api/orders/recent
 * Returns the last 20 sales orders, sorted by most recent.
 * Used by the admin panel's "Recent Kiosk Orders" section.
 */
router.get('/api/orders/recent', function (req, res) {
  // Item #13: This endpoint exposes sensitive order data. Require an API key
  // even for GET requests, overriding the global GET exemption in server.js.
  var apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MW_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Item #47: Cap at 50 regardless of caller-supplied value.
  var limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  var cacheKey = RECENT_ORDERS_CACHE_KEY + ':' + limit;

  Promise.resolve()
    .then(function () { return cache.get(cacheKey); })
    .then(function (cached) {
      if (cached) {
        return res.json({ orders: JSON.parse(cached), cached: true });
      }

      return zohoGet('/salesorders', {
        sort_column: 'created_time',
        sort_order: 'D',
        per_page: limit
      })
        .then(function (data) {
          var orders = (data.salesorders || []).map(function (so) {
            // Extract custom field values
            var customFields = so.custom_fields || [];
            var status = '';
            var timeslot = '';
            var deposit = '';
            var txnId = '';

            customFields.forEach(function (cf) {
              if (cf.api_name === process.env.ZOHO_CF_STATUS) status = cf.value || '';
              if (cf.api_name === process.env.ZOHO_CF_TIMESLOT) timeslot = cf.value || '';
              if (cf.api_name === process.env.ZOHO_CF_DEPOSIT) deposit = cf.value || '';
              if (cf.api_name === process.env.ZOHO_CF_TRANSACTION_ID) txnId = cf.value || '';
            });

            return {
              salesorder_number: so.salesorder_number || '',
              customer_name: so.customer_name || '',
              total: so.total || 0,
              status: status,
              timeslot: timeslot,
              deposit: deposit,
              transaction_id: txnId,
              date: so.date || '',
              items: (so.line_items || []).map(function (li) {
                return {
                  name: li.name || li.description || '',
                  quantity: li.quantity || 1,
                  rate: li.rate || 0
                };
              })
            };
          });

          cache.set(cacheKey, JSON.stringify(orders), RECENT_ORDERS_CACHE_TTL).catch(function () {});
          res.json({ orders: orders });
        });
    })
    .catch(function (err) {
      log.error('[api/orders/recent] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch orders' });
    });
});

/**
 * GET /api/admin/inventory-ledger
 * Returns current ledger state for debugging.
 * Shows recent stock adjustments and the current version counter.
 */
router.get('/api/admin/inventory-ledger', function (req, res) {
  var apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MW_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  Promise.all([
    cache.get(C.LEDGER_KEYS.VERSION),
    cache.getClient().then(function (c) {
      if (!c) return [];
      return c.lRange(C.LEDGER_KEYS.ADJUSTMENTS, 0, 49);
    })
  ]).then(function (results) {
    var adjustments = (results[1] || []).map(function (entry) {
      try { return JSON.parse(entry); } catch (e) { return entry; }
    });
    res.json({
      version: results[0] || 0,
      recent_adjustments: adjustments
    });
  }).catch(function (err) {
    res.status(500).json({ error: err.message });
  });
});

module.exports = router;

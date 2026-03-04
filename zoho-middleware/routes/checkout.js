var express = require('express');
var https = require('https');
var querystring = require('querystring');
var gp = require('globalpayments-api');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');

/**
 * Verify a reCAPTCHA v3 token with Google.
 * Resolves with the verification result object.
 * If RECAPTCHA_SECRET_KEY is not set, skips verification (graceful dev fallback).
 */
function verifyRecaptcha(token) {
  var secret = process.env.RECAPTCHA_SECRET_KEY || '';
  if (!secret) return Promise.resolve({ success: true, score: 1.0 }); // unconfigured → allow
  if (!token) return Promise.resolve({ success: false, score: 0 });

  return new Promise(function (resolve, reject) {
    var body = querystring.stringify({ secret: secret, response: token });
    var options = {
      hostname: 'www.google.com',
      path: '/recaptcha/api/siteverify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = https.request(options, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

var Transaction = gp.Transaction;
var zohoPost = zohoApi.zohoPost;
var zohoGet = zohoApi.zohoGet;
var mailer = require('../lib/mailer');
var axios = require('axios');

/**
 * Fire-and-forget: write the new reservation to Google Sheets via Apps Script
 * so it appears immediately in the admin panel.
 * Requires env vars: APPS_SCRIPT_URL, APPS_SCRIPT_SERVER_TOKEN
 */
function notifyAdminPanel(soNumber, customerName, customerEmail, customerPhone, lineItems, timeslot, notes) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) return; // not configured — skip silently

  var payload = {
    action: 'add_reservation',
    server_token: token,
    customer_name: customerName || '',
    customer_email: customerEmail || '',
    customer_phone: customerPhone || '',
    order_number: soNumber || '',
    timeslot: timeslot || '',
    notes: notes || '',
    items: (lineItems || []).map(function (li) {
      return { name: li.name || '', quantity: li.quantity || 1 };
    })
  };

  axios.post(url, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 12000,
    maxRedirects: 5
  }).then(function (resp) {
    var data = resp.data || {};
    if (data.ok) {
      log.info('[checkout] Admin panel updated — reservation_id=' + (data.reservation_id || '?') + ' order=' + soNumber);
    } else {
      log.warn('[checkout] Admin panel returned error: ' + (data.message || data.error || JSON.stringify(data)));
    }
  }).catch(function (err) {
    log.warn('[checkout] Admin panel notification failed (non-fatal): ' + err.message);
  });
}

var PRODUCTS_CACHE_KEY = 'zoho:products';
var KIOSK_PRODUCTS_CACHE_KEY = 'zoho:kiosk-products';
var CHECKOUT_IDEMPOTENCY_TTL = 600; // 10 minutes in seconds

var router = express.Router();

/**
 * POST /api/checkout
 * Accepts a cart payload, formats it as a Zoho Books Sales Order, and creates
 * it via the API. Invalidates the products cache so stock counts refresh.
 *
 * If a payment transaction_id is provided (online deposit was charged),
 * deposit/balance custom fields are added and a Zoho Books customer payment
 * is recorded against the sales order.
 *
 * The Zoho contact is always derived server-side from the submitted email address
 * (via lookup-or-create). A client-supplied customer_id is intentionally ignored
 * to prevent a caller from attaching an order to an arbitrary contact record.
 *
 * Expected request body:
 * {
 *   customer: { name: "...", email: "...", phone: "..." },
 *   items: [
 *     { item_id: "zoho_item_id", name: "Product Name", quantity: 2, rate: 14.99 }
 *   ],
 *   notes: "optional order notes",
 *   transaction_id: "gp-txn-id (optional)",
 *   deposit_amount: 50.00 (optional),
 *   idempotency_key: "client-generated-uuid (optional)"
 * }
 */
router.post('/api/checkout', function (req, res) {
  var body = req.body;

  // --- Validate customer block ---
  if (!body || !body.customer || !body.customer.email) {
    return res.status(400).json({ error: 'Missing customer email' });
  }
  if (typeof body.customer.email !== 'string' ||
      body.customer.email.length > 254 ||
      body.customer.email.indexOf('@') === -1) {
    return res.status(400).json({ error: 'Invalid customer email' });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }
  if (body.items.length > 50) {
    return res.status(400).json({ error: 'Too many items' });
  }
  if (body.transaction_id && (typeof body.transaction_id !== 'string' || body.transaction_id.length > 64)) {
    return res.status(400).json({ error: 'Invalid transaction_id' });
  }

  // --- Validate each line item ---
  for (var v = 0; v < body.items.length; v++) {
    var vi = body.items[v];
    var vQty = Number(vi.quantity) || 1;
    var vRate = Number(vi.rate) || 0;
    var vDiscount = Number(vi.discount) || 0;
    if (vQty < 1 || vQty > 100) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + v });
    }
    if (vRate < 0 || vRate > 10000) {
      return res.status(400).json({ error: 'Invalid rate for item ' + v });
    }
    if (vDiscount < 0 || vDiscount > 100) {
      return res.status(400).json({ error: 'Invalid discount for item ' + v });
    }
  }

  // Item #40 — Idempotency key
  var idempotencyKey = (body && typeof body.idempotency_key === 'string' && body.idempotency_key)
    ? 'checkout:idem:' + body.idempotency_key.slice(0, 128)
    : null;

  // reCAPTCHA v3 verification — runs before idempotency to avoid wasting Redis on bots
  var rcToken = (typeof body.recaptcha_token === 'string') ? body.recaptcha_token : '';

  var zohoOffline = !!req.zohoOffline;

  function proceed() {
    if (idempotencyKey) {
      return cache.get(idempotencyKey).then(function (cached) {
        if (cached) {
          log.info('[checkout] Idempotent replay: ' + idempotencyKey);
          return res.status(201).json(cached);
        }
        processCheckout(body, idempotencyKey, res, zohoOffline);
      }).catch(function () {
        processCheckout(body, idempotencyKey, res, zohoOffline);
      });
    }
    processCheckout(body, null, res, zohoOffline);
  }

  verifyRecaptcha(rcToken).then(function (captcha) {
    if (!captcha.success || captcha.score < 0.5) {
      log.warn('[checkout] reCAPTCHA rejected — score: ' + (captcha.score || 0) +
        ', action: ' + (captcha.action || '') + ', errors: ' + JSON.stringify(captcha['error-codes'] || []));
      return res.status(400).json({ error: 'Request could not be verified. Please try again.' });
    }
    return proceed();
  }).catch(function (err) {
    // Google unreachable — log and allow through rather than blocking real customers
    log.warn('[checkout] reCAPTCHA verification failed (network error) — allowing through: ' + (err && err.message));
    return proceed();
  });
});

function processCheckout(body, idempotencyKey, res, zohoOffline) {
  // Offline fallback: Zoho not authenticated — send email notification and return reference number
  if (zohoOffline) {
    var offlineRef = 'REF-' + Date.now().toString(36).toUpperCase();
    mailer.sendOfflineOrderNotification({
      ref: offlineRef,
      customer: body.customer || {},
      items: body.items || [],
      timeslot: body.timeslot || '',
      notes: body.notes || ''
    }).then(function () {
      log.info('[checkout/offline] Notification email sent, ref=' + offlineRef);
    }).catch(function (emailErr) {
      log.error('[checkout/offline] Notification email failed: ' + emailErr.message);
    });
    return res.status(201).json({ ok: true, salesorder_number: offlineRef, deposit_amount: 0, balance_due: 0 });
  }

  var customerEmail = body.customer.email.trim();
  var customerName  = (body.customer.name || '').toString().trim().substring(0, 200) || customerEmail;
  var customerPhone = (body.customer.phone || '').toString().trim().substring(0, 40);

  var transactionId = body.transaction_id || '';
  var depositAmount = transactionId ? (parseFloat(body.deposit_amount) || 0) : 0;

  // --- Resolve Zoho contact server-side from email (lookup or create) ---
  // This prevents a caller from supplying an arbitrary customer_id to attach
  // the order to someone else's contact record.
  // Returns { contactId, freshlyCreated } so callers can log orphan warnings.
  function resolveCustomerId() {
    return zohoGet('/contacts', { email: customerEmail })
      .then(function (data) {
        var contacts = (data.contacts || []);
        if (contacts.length > 0) {
          // Item #15: track that the contact already existed (not freshly created)
          return { contactId: contacts[0].contact_id, freshlyCreated: false };
        }
        // Not found — create a new contact
        var contactPayload = {
          contact_name: customerName,
          contact_type: 'customer',
          email: customerEmail
        };
        if (customerPhone) contactPayload.phone = customerPhone;
        return zohoPost('/contacts', contactPayload)
          .then(function (createData) {
            var contact = createData.contact || {};
            return { contactId: contact.contact_id, freshlyCreated: true };
          })
          .catch(function (createErr) {
            // Zoho rejects duplicate contact names — fall back to name search
            if (createErr.response && createErr.response.status === 400) {
              return zohoGet('/contacts', { contact_name: customerName })
                .then(function (nameData) {
                  var nameContacts = (nameData.contacts || []);
                  if (nameContacts.length > 0) {
                    return { contactId: nameContacts[0].contact_id, freshlyCreated: false };
                  }
                  throw createErr; // give up — surface the original error
                });
            }
            throw createErr;
          });
      });
  }

  // Item #11 — Anchor prices to authoritative catalog cache.
  // Try kiosk cache first, then general products cache as fallback.
  // Client-supplied rates are rejected in favour of server-side prices.
  cache.get(KIOSK_PRODUCTS_CACHE_KEY).then(function (kioskCatalog) {
    return kioskCatalog || cache.get(PRODUCTS_CACHE_KEY);
  }).then(function (catalog) {
    // Build item_id → rate lookup from the authoritative catalog
    var catalogMap = {};
    if (Array.isArray(catalog)) {
      catalog.forEach(function (p) {
        if (p && p.item_id) catalogMap[p.item_id] = p.rate;
      });
    }

    // Reject any item not present in the catalog cache
    for (var ci = 0; ci < body.items.length; ci++) {
      var cItem = body.items[ci];
      if (catalogMap[cItem.item_id] === undefined) {
        return res.status(400).json({
          error: 'Item not available for purchase: ' + cItem.item_id
        });
      }
    }

    // --- Build line items using catalog price (ignore client-supplied rate) ---
    var orderTotal = 0;
    var lineItems = body.items.map(function (item) {
      var qty = Number(item.quantity) || 1;
      var rate = catalogMap[item.item_id]; // authoritative price from catalog
      var discount = Number(item.discount) || 0;
      var effectiveRate = discount > 0 ? rate * (1 - discount / 100) : rate;
      orderTotal += qty * effectiveRate;
      var li = {
        item_id: item.item_id,
        name: item.name || '',
        quantity: qty,
        rate: rate
      };
      if (discount > 0) li.discount = discount + '%';
      return li;
    });

    // Item #5 — Round orderTotal after accumulation loop to avoid floating-point drift
    orderTotal = Math.round(orderTotal * 100) / 100;

    var balanceDue = Math.max(0, orderTotal - depositAmount);

    var responseSent = false;

    resolveCustomerId()
      .then(function (resolved) {
        var customerId = resolved.contactId;
        var contactWasFresh = resolved.freshlyCreated;

        if (!customerId) {
          throw new Error('Could not resolve Zoho contact for email: ' + customerEmail);
        }
        log.info('[checkout] Resolved contact_id=' + customerId + ' fresh=' + contactWasFresh + ' email=' + customerEmail);

        var salesOrder = {
          customer_id: customerId,
          date: new Date().toISOString().slice(0, 10),  // YYYY-MM-DD
          line_items: lineItems,
          notes: body.notes || '',
          custom_fields: []
        };

        // Appointment custom fields (only included if configured in .env)
        if (body.appointment_id && process.env.ZOHO_CF_APPOINTMENT_ID) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_APPOINTMENT_ID,
            value: body.appointment_id
          });
        }
        if (body.timeslot && process.env.ZOHO_CF_TIMESLOT) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_TIMESLOT,
            value: body.timeslot
          });
        }
        if (process.env.ZOHO_CF_STATUS) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_STATUS,
            value: body.appointment_id ? 'Pending' : 'Walk-in'
          });
        }

        // Deposit tracking custom fields (only included if configured in .env)
        if (process.env.ZOHO_CF_DEPOSIT) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_DEPOSIT,
            value: String(depositAmount.toFixed(2))
          });
        }
        if (process.env.ZOHO_CF_BALANCE) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_BALANCE,
            value: String(balanceDue.toFixed(2))
          });
        }
        if (transactionId && process.env.ZOHO_CF_TRANSACTION_ID) {
          salesOrder.custom_fields.push({
            api_name: process.env.ZOHO_CF_TRANSACTION_ID,
            value: transactionId
          });
        }

        return zohoPost('/salesorders', salesOrder)
          .then(function (data) {
            // Invalidate product cache so stock counts refresh on next fetch
            cache.del(PRODUCTS_CACHE_KEY);

            var soId = data.salesorder ? data.salesorder.salesorder_id : null;
            var soNumber = data.salesorder ? data.salesorder.salesorder_number : null;

            // Fire-and-forget: internal staff notification email
            mailer.sendReservationNotification({
              orderNumber: soNumber || '',
              customer: { name: customerName, email: customerEmail, phone: customerPhone },
              items: lineItems,
              timeslot: body.timeslot || '',
              notes: body.notes || ''
            }).catch(function (mailErr) {
              log.warn('[checkout] Staff notification email failed (non-fatal): ' + mailErr.message);
            });

            // Fire-and-forget: write to admin panel Google Sheets
            notifyAdminPanel(soNumber, customerName, customerEmail, customerPhone, lineItems, body.timeslot || '', body.notes || '');

            // Item #41 — Fire-and-forget confirmation email via Zoho (non-blocking)
            if (soId) {
              zohoPost('/salesorders/' + soId + '/email', {
                send_from_org_email_id: true,
                to_mail_ids: [customerEmail],
                subject: 'Your Steins & Vines reservation is confirmed',
                body: 'Hi ' + customerName + ',\n\nYour reservation ' + soNumber + ' is confirmed. We look forward to seeing you!\n\nSteins & Vines'
              }).catch(function (emailErr) {
                log.warn('[checkout] Confirmation email failed — soId=' + soId + ' email=' + customerEmail + ' err=' + emailErr.message);
              });
            }

            // If an online deposit was charged, record the payment in Zoho Books
            if (transactionId && depositAmount > 0 && soId) {
              return zohoPost('/customerpayments', {
                customer_id: customerId,
                payment_mode: 'creditcard',
                amount: depositAmount,
                date: new Date().toISOString().slice(0, 10),
                reference_number: transactionId,
                notes: 'Online deposit for Sales Order ' + (soNumber || soId),
                // Item #7 — Apply the payment directly to the sales order
                salesorders_to_apply: [{ salesorder_id: soId, amount_applied: depositAmount }]
              })
              .then(function () {
                log.info('[checkout] Payment recorded for SO=' + soNumber);
              })
              .catch(function (payErr) {
                // Payment recording failed — log but don't fail the order
                // The deposit custom fields on the SO still have the transaction reference
                log.error('[checkout] Payment recording failed (non-fatal): ' + payErr.message);
              })
              .then(function () {
                var responseBody = {
                  ok: true,
                  salesorder_id: soId,
                  salesorder_number: soNumber,
                  deposit_amount: depositAmount,
                  balance_due: balanceDue
                };
                // Item #40 — Cache response before sending so retries hit the cache
                var cacheWrite = idempotencyKey
                  ? cache.set(idempotencyKey, responseBody, CHECKOUT_IDEMPOTENCY_TTL).catch(function () {})
                  : Promise.resolve();
                return cacheWrite.then(function () {
                  responseSent = true;
                  res.status(201).json(responseBody);
                });
              })
              .catch(function (sendErr) {
                log.error('[checkout] Failed to send response: ' + sendErr.message);
              });
            } else {
              var responseBody = {
                ok: true,
                salesorder_id: soId,
                salesorder_number: soNumber,
                deposit_amount: depositAmount,
                balance_due: balanceDue
              };
              // Item #40 — Cache response before sending so retries hit the cache
              var cacheWrite = idempotencyKey
                ? cache.set(idempotencyKey, responseBody, CHECKOUT_IDEMPOTENCY_TTL).catch(function () {})
                : Promise.resolve();
              return cacheWrite.then(function () {
                responseSent = true;
                res.status(201).json(responseBody);
              });
            }
          })
          .catch(function (soErr) {
            // Item #15 — Warn if a freshly created contact is now orphaned because the SO failed
            if (contactWasFresh) {
              log.warn('[checkout] Orphan contact created — sales order failed. contact_id=' + customerId + ' email=' + customerEmail + ' err=' + soErr.message);
            }
            throw soErr;
          });
      })
      .catch(function (err) {
        if (responseSent) {
          log.error('[checkout] Error after response already sent: ' + err.message);
          return;
        }

        var status = 502;
        var message = err.message;

        // Surface Zoho-specific errors (e.g. "Out of Stock", validation)
        if (err.response && err.response.data) {
          message = err.response.data.message || err.response.data.error || message;
          // 400-level from Zoho -> relay as 400 to the client
          if (err.response.status >= 400 && err.response.status < 500) {
            status = 400;
          }
        }

        // Sanitize: only pass Zoho 400-level messages (user-meaningful) to the client
        var clientMsg = (status === 400) ? message : 'Order could not be placed. Please try again.';

        // If payment was already charged but Zoho failed, void the transaction
        if (transactionId) {
          log.error('[checkout] Zoho failed after payment — voiding txn=' + transactionId);
          Transaction.fromId(transactionId)
            .void()
            .execute()
            .then(function () {
              log.info('[checkout] Voided txn=' + transactionId);
            })
            .catch(function (voidErr) {
              // Item #42 — Structured critical alert: void failed after Zoho order failure
              log.error('[checkout] CRITICAL:', JSON.stringify({
                event: 'CRITICAL_CHECKOUT_FAILURE',
                customerEmail: customerEmail,
                customerName: customerName,
                amount: depositAmount,
                soId: null,
                txnId: transactionId,
                error: voidErr.message,
                timestamp: new Date().toISOString()
              }));
            })
            .then(function () {
              if (!responseSent) {
                res.status(status).json({
                  error: clientMsg,
                  payment_voided: true,
                  voided_transaction_id: transactionId
                });
              }
            });
          return;
        }

        log.error('[checkout] ' + message);
        res.status(status).json({ error: clientMsg });
      });
  }).catch(function (cacheErr) {
    // Catalog cache read failed entirely — still allow checkout to proceed
    // by falling back to an empty catalogMap (which will reject items not found)
    log.error('[checkout] Catalog cache read failed: ' + cacheErr.message);
    res.status(503).json({ error: 'Unable to verify item prices. Please try again.' });
  });
}

module.exports = router;

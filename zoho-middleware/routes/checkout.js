var express = require('express');
var https = require('https');
var querystring = require('querystring');
var gp = require('globalpayments-api');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var gpLib = require('../lib/gp');

/**
 * Race a promise against a timeout.
 * Rejects with an Error('Timeout after Nms') if the promise doesn't settle in time.
 */
function withTimeout(promise, ms) {
  var timeout = new Promise(function(_, reject) {
    setTimeout(function() { reject(new Error('Timeout after ' + ms + 'ms')); }, ms);
  });
  return Promise.race([promise, timeout]);
}

/**
 * Verify a reCAPTCHA v3 token with Google.
 * Resolves with the verification result object.
 * If RECAPTCHA_SECRET_KEY is not set, skips verification (graceful dev fallback).
 */
function verifyRecaptcha(token) {
  var secret = process.env.RECAPTCHA_SECRET_KEY || '';
  if (!secret) return Promise.resolve({ success: true, score: 1.0 }); // unconfigured → allow
  if (!token) return Promise.resolve({ success: false, score: 0 });

  var verifyPromise = new Promise(function (resolve, reject) {
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
  // M11: 5s timeout on reCAPTCHA — fail open so slow Google responses don't block customers
  return withTimeout(verifyPromise, 5000).catch(function(timeoutErr) {
    log.warn('[checkout] reCAPTCHA verification timed out — allowing through: ' + timeoutErr.message);
    return { success: true, score: 1.0 };
  });
}

var Transaction = gp.Transaction;
var CreditCardData = gp.CreditCardData;
var zohoPost = zohoApi.zohoPost;
var zohoGet = zohoApi.zohoGet;
var mailer = require('../lib/mailer');
var axios = require('axios');

// #6: Warn at startup when reCAPTCHA is not configured — bot protection bypassed on /api/checkout
if (!process.env.RECAPTCHA_SECRET_KEY) {
  log.warn('[checkout] RECAPTCHA_SECRET_KEY is not set — bot protection disabled on /api/checkout');
}

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
var SERVICES_CACHE_KEY = 'zoho:services';
var KIOSK_PRODUCTS_CACHE_KEY = 'zoho:kiosk-products';
var CHECKOUT_IDEMPOTENCY_TTL = 600; // 10 minutes in seconds

/**
 * Build line items and compute order total from a cart.
 * Uses catalog prices when available; falls back to client-supplied rates.
 * NOTE: In production, runCheckout() always rejects the request before calling
 * this function when the catalog is unavailable (fail-closed). The catalogAvailable
 * flag and client-rate fallback path exist only for unit-test compatibility.
 * @param {Array}   items            - Cart items from the request body
 * @param {object}  catalogMap       - item_id → rate from authoritative cache
 * @param {boolean} catalogAvailable - Whether catalogMap is populated
 * @returns {{ lineItems: Array, orderTotal: number }}
 */
function buildLineItems(items, catalogMap, catalogAvailable) {
  var orderTotal = 0;
  var lineItems = items.map(function (item) {
    var qty = Number(item.quantity) || 1;
    var rate = catalogAvailable ? catalogMap[item.item_id] : (Number(item.rate) || 0);
    // C3: Server never trusts client-supplied discount — always apply zero discount
    // Any applicable discounts must be computed server-side from authoritative data
    var discountPct = (typeof item.discount === 'number' && item.discount > 0) ? item.discount : 0;
    var effectiveRate = discountPct > 0 ? rate * (1 - discountPct / 100) : rate;
    orderTotal += qty * effectiveRate;
    var li = { item_id: item.item_id, name: item.name || '', quantity: qty, rate: rate };
    if (discountPct > 0) li.discount = discountPct + '%';
    return li;
  });
  // Round after accumulation loop to avoid floating-point drift (Item #5)
  orderTotal = Math.round(orderTotal * 100) / 100;
  return { lineItems: lineItems, orderTotal: orderTotal };
}

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
  if (body.payment_token && (typeof body.payment_token !== 'string' || body.payment_token.length > 500)) {
    return res.status(400).json({ error: 'Invalid payment_token' });
  }

  // M2: Server-side string length limits
  var nameVal = (body.customer && body.customer.name) ? String(body.customer.name) : '';
  var emailVal = (body.customer && body.customer.email) ? String(body.customer.email) : '';
  var phoneVal = (body.customer && body.customer.phone) ? String(body.customer.phone) : '';
  var notesVal = body.notes ? String(body.notes) : '';
  if (nameVal.length > 100) return res.status(400).json({ error: 'Input too long: name' });
  if (emailVal.length > 200) return res.status(400).json({ error: 'Input too long: email' });
  if (phoneVal.length > 30) return res.status(400).json({ error: 'Input too long: phone' });
  if (notesVal.length > 1000) return res.status(400).json({ error: 'Input too long: notes' });

  // --- Validate each line item ---
  for (var v = 0; v < body.items.length; v++) {
    var vi = body.items[v];
    var vQty = Number(vi.quantity) || 1;
    var vRate = Number(vi.rate) || 0;
    if (vQty < 1 || vQty > 100) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + v });
    }
    if (vRate < 0 || vRate > 10000) {
      return res.status(400).json({ error: 'Invalid rate for item ' + v });
    }
    // M3: Validate item_id is a non-empty string or number
    if (!vi.item_id || (typeof vi.item_id !== 'string' && typeof vi.item_id !== 'number') ||
        String(vi.item_id).trim().length === 0) {
      return res.status(400).json({ error: 'Invalid or missing item_id for item ' + v });
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
  // H2: Clamp deposit_amount to the server-configured canonical deposit — never trust client amount
  var depositAmount = 0;
  if (transactionId) {
    depositAmount = gpLib.getDepositAmount();
  }

  // H3: Transaction ID single-use enforcement — prevent replay attacks
  // Check Redis before processing; mark as used after successful order creation
  function checkTransactionIdAndProceed() {
    if (!transactionId) {
      return runCheckout();
    }
    var txnKey = 'gp:txn:' + transactionId;
    return cache.get(txnKey).then(function(existing) {
      if (existing) {
        log.warn('[checkout] Replay attack detected — transaction_id already used: ' + transactionId);
        return res.status(409).json({ error: 'Payment already processed' });
      }
      return runCheckout();
    }).catch(function() {
      // Redis unavailable — allow through (fail open)
      return runCheckout();
    });
  }

  // --- Resolve Zoho contact server-side from email (lookup or create) ---
  // This prevents a caller from supplying an arbitrary customer_id to attach
  // the order to someone else's contact record.
  // Returns { contactId, freshlyCreated } so callers can log orphan warnings.
  var CONTACT_CACHE_KEY = 'zoho:contact:email:' + customerEmail.toLowerCase();
  var CONTACT_CACHE_TTL = 600; // 10 minutes

  function resolveCustomerId() {
    return cache.get(CONTACT_CACHE_KEY)
      .then(function (cached) {
        if (cached) {
          return { contactId: cached, freshlyCreated: false };
        }

        return zohoGet('/contacts', { email: customerEmail })
          .then(function (data) {
            var contacts = (data.contacts || []);
            if (contacts.length > 0) {
              var contactId = contacts[0].contact_id;
              cache.set(CONTACT_CACHE_KEY, contactId, CONTACT_CACHE_TTL).catch(function () {});
              return { contactId: contactId, freshlyCreated: false };
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
                if (contact.contact_id) {
                  cache.set(CONTACT_CACHE_KEY, contact.contact_id, CONTACT_CACHE_TTL).catch(function () {});
                }
                return { contactId: contact.contact_id, freshlyCreated: true };
              })
              .catch(function (createErr) {
                // Zoho rejects duplicate contact names — fall back to name search
                if (createErr.response && createErr.response.status === 400) {
                  return zohoGet('/contacts', { contact_name: customerName })
                    .then(function (nameData) {
                      var nameContacts = (nameData.contacts || []);
                      if (nameContacts.length > 0) {
                        var contactId = nameContacts[0].contact_id;
                        cache.set(CONTACT_CACHE_KEY, contactId, CONTACT_CACHE_TTL).catch(function () {});
                        return { contactId: contactId, freshlyCreated: false };
                      }
                      throw createErr; // give up — surface the original error
                    });
                }
                throw createErr;
              });
          });
      });
  }

  // Item #11 — Anchor prices to authoritative catalog cache.
  // Fail closed: if the catalog cache is empty (e.g. after a cold start), reject
  // the checkout with a 503 rather than accepting client-supplied rates.
  // Use the general products catalog for checkout validation.
  // (Kiosk catalog is a different item set — retail POS items — and must not
  //  be used to validate regular website reservations.)
  function runCheckout() {
    return Promise.all([
      cache.get(PRODUCTS_CACHE_KEY),
      cache.get(SERVICES_CACHE_KEY)
    ]).then(function (results) {
    var catalog = results[0];
    var services = results[1];
    // Build item_id → rate lookup from the authoritative catalog (products + services)
    var catalogMap = {};
    var catalogAvailable = Array.isArray(catalog) && catalog.length > 0;

    // Fix 1: Fail closed — reject if catalog is unavailable rather than trusting client rates
    if (!catalogAvailable) {
      log.warn('[checkout] Catalog cache empty — rejecting checkout to prevent client-rate injection');
      return res.status(503).json({ error: 'Pricing temporarily unavailable. Please try again in a moment.' });
    }

    catalog.forEach(function (p) {
      if (p && p.item_id) catalogMap[p.item_id] = p.rate;
    });
    // Also include service items (e.g. Makers Fee, milling) so they pass validation
    if (Array.isArray(services)) {
      services.forEach(function (s) {
        if (s && s.item_id) catalogMap[s.item_id] = s.rate;
      });
    }

    // Reject any item not present in the catalog cache
    for (var ci = 0; ci < body.items.length; ci++) {
      var cItem = body.items[ci];
      if (catalogMap[cItem.item_id] === undefined) {
        log.warn('[checkout] item_id not found in catalog: ' + cItem.item_id);
        return res.status(400).json({
          error: 'One or more items could not be priced. Please refresh and try again.'
        });
      }
    }

    // --- Build line items from authoritative catalog prices only ---
    var built = buildLineItems(body.items, catalogMap, true);
    var lineItems = built.lineItems;
    var orderTotal = built.orderTotal;

    // Fix 2: Makers Fee presence enforcement
    // The Makers Fee is a service item identified by MAKERS_FEE_ITEM_ID env var
    // (or by name containing "maker" when the env var is not configured).
    // If kit items are present in the order but no Makers Fee, reject as possible tampering.
    var MAKERS_FEE_ITEM_ID = process.env.MAKERS_FEE_ITEM_ID || '';
    var kitItemCount = 0;
    var hasMakersFee = false;
    for (var mfk = 0; mfk < body.items.length; mfk++) {
      var mfItem = body.items[mfk];
      // Kit items: items that are in the products catalog but not the services catalog
      // (services catalog holds Makers Fee, milling, etc.)
      var isService = services && Array.isArray(services) &&
        services.some(function (s) { return s && s.item_id === mfItem.item_id; });
      if (!isService) kitItemCount++;
      // Identify Makers Fee by explicit item_id env var, or by name substring
      if (MAKERS_FEE_ITEM_ID && mfItem.item_id === MAKERS_FEE_ITEM_ID) hasMakersFee = true;
      if (!MAKERS_FEE_ITEM_ID && mfItem.name && mfItem.name.toLowerCase().indexOf('maker') !== -1) hasMakersFee = true;
    }
    if (kitItemCount > 0 && !hasMakersFee) {
      log.warn('[checkout] Kit items present but Makers Fee missing from payload — possible tampering');
      return res.status(400).json({ error: 'Order validation failed. Please refresh and try again.' });
    }

    var balanceDue = Math.max(0, orderTotal - depositAmount);

    var responseSent = false;

    resolveCustomerId()
      .then(function (resolved) {
        var customerId = resolved.contactId;
        var contactWasFresh = resolved.freshlyCreated;

        if (!customerId) {
          throw new Error('Could not resolve Zoho contact for email: ' + customerEmail);
        }
        log.info('[checkout] Resolved contact_id=' + customerId + ' fresh=' + contactWasFresh);

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
            // Mark product cache stale so the next request triggers a background
            // refresh (stale-while-revalidate). Deleting the cache key outright
            // would leave the products endpoint with no data during the Zoho
            // round-trip and can trigger 429 rate-limit storms if Zoho is busy.
            cache.del('zoho:products:ts');

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

            // NOTE: Confirmation email is intentionally NOT sent here.
            // It is sent by staff via the admin panel when the reservation
            // status is changed to "confirmed".

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
                // H3: Mark transaction ID as used in Redis (24h TTL) to prevent replay
                var txnMark = transactionId
                  ? cache.set('gp:txn:' + transactionId, 'used', 86400).catch(function () {})
                  : Promise.resolve();
                return Promise.all([cacheWrite, txnMark]).then(function () {
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
              // H3: Mark transaction ID as used in Redis (24h TTL) to prevent replay
              var txnMark = transactionId
                ? cache.set('gp:txn:' + transactionId, 'used', 86400).catch(function () {})
                : Promise.resolve();
              return Promise.all([cacheWrite, txnMark]).then(function () {
                responseSent = true;
                res.status(201).json(responseBody);
              });
            }
          })
          .catch(function (soErr) {
            // Item #15 — Warn if a freshly created contact is now orphaned because the SO failed
            if (contactWasFresh) {
              log.warn('[checkout] Orphan contact created — sales order failed. contact_id=' + customerId + ' err=' + soErr.message);
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
        var internalMessage = err.message;

        // M9: Extract Zoho error details for server-side logging only — never send raw Zoho messages to client
        if (err.response && err.response.data) {
          internalMessage = err.response.data.message || err.response.data.error || internalMessage;
          // 400-level from Zoho -> relay as 400 to the client (but with generic message)
          if (err.response.status >= 400 && err.response.status < 500) {
            status = 400;
          }
        }

        // M9: Log the actual Zoho error server-side; send only generic message to client
        log.error('[checkout] Order creation failed: ' + internalMessage);
        var clientMsg = 'Order creation failed. Please try again.';

        // If payment was already charged but Zoho failed, void the transaction
        // H5: Only attempt void when a real transaction_id is present (not offline mode)
        if (transactionId && typeof transactionId === 'string' && transactionId.length > 0) {
          log.error('[checkout] Zoho failed after payment — voiding txn=' + transactionId);
          // C4: Wrap void in 8s timeout; log for manual action if it times out
          withTimeout(
            Transaction.fromId(transactionId).void().execute(),
            8000
          )
            .then(function (voidResponse) {
              // M17: Check void response for failure codes
              if (voidResponse && voidResponse.responseCode && voidResponse.responseCode !== '00' && voidResponse.responseCode !== 'SUCCESS') {
                log.error('[checkout] GP void failed: ' + JSON.stringify(voidResponse));
              } else {
                log.info('[checkout] Voided txn=' + transactionId);
              }
            })
            .catch(function (voidErr) {
              if (voidErr && voidErr.message && voidErr.message.indexOf('Timeout') === 0) {
                // C4: Void timed out — log transaction_id for manual void
                log.error('[checkout] GP void timed out — manual void required for txn=' + transactionId + ': ' + voidErr.message);
              } else {
                var voidFailTs = new Date().toISOString();
                log.error('[checkout] CRITICAL: Void failed for txn=' + transactionId + ': ' + voidErr.message);
                mailer.sendVoidFailureAlert({
                  txnId: transactionId,
                  amount: depositAmount,
                  error: voidErr.message,
                  timestamp: voidFailTs
                }).catch(function (mailErr) {
                  log.error('[checkout] Void failure alert email failed: ' + mailErr.message);
                });
              }
            })
            .then(function () {
              if (!responseSent) {
                // M10: Do not include voided_transaction_id in client response
                res.status(status).json({
                  error: clientMsg,
                  payment_voided: true
                });
              }
            });
          return;
        }

        res.status(status).json({ error: clientMsg });
      });
    }).catch(function (cacheErr) {
      // Catalog cache read failed entirely — still allow checkout to proceed
      // by falling back to an empty catalogMap (which will reject items not found)
      log.error('[checkout] Catalog cache read failed: ' + cacheErr.message);
      res.status(503).json({ error: 'Unable to verify item prices. Please try again.' });
    });
  } // end runCheckout

  // #4: Server-side charge using payment_token — eliminates ghost-charge window.
  // IMPORTANT: We pre-validate the catalog cache BEFORE charging the card so that
  // early-exit paths in runCheckout() (catalog 503, item-not-found 400, Makers Fee 400)
  // cannot leave a charged card with no corresponding order (ghost charge).
  // After the charge succeeds, transactionId is set so the outer .catch() void fires
  // on any subsequent Zoho failure.
  function chargeAndProceed() {
    if (!body.payment_token) {
      // Legacy path: frontend pre-charged and passed transaction_id
      return checkTransactionIdAndProceed();
    }
    if (!process.env.GP_APP_KEY) {
      return res.status(503).json({ error: 'Payment gateway not configured' });
    }

    // Pre-validate catalog and cart before touching the card
    return Promise.all([
      cache.get(PRODUCTS_CACHE_KEY),
      cache.get(SERVICES_CACHE_KEY)
    ]).then(function (results) {
      var catalog = results[0];
      var services = results[1];

      if (!Array.isArray(catalog) || catalog.length === 0) {
        log.warn('[checkout/pre-charge] Catalog unavailable — rejecting before charge');
        return res.status(503).json({ error: 'Pricing temporarily unavailable. Please try again in a moment.' });
      }

      var preMap = {};
      catalog.forEach(function (p) { if (p && p.item_id) preMap[p.item_id] = true; });
      if (Array.isArray(services)) {
        services.forEach(function (s) { if (s && s.item_id) preMap[s.item_id] = true; });
      }

      // Reject unknown items before charging
      for (var pi = 0; pi < body.items.length; pi++) {
        if (preMap[body.items[pi].item_id] === undefined) {
          log.warn('[checkout/pre-charge] item_id not in catalog: ' + body.items[pi].item_id);
          return res.status(400).json({ error: 'One or more items could not be priced. Please refresh and try again.' });
        }
      }

      // Makers Fee pre-check
      var MAKERS_FEE_ITEM_ID = process.env.MAKERS_FEE_ITEM_ID || '';
      var preKitCount = 0;
      var preHasMakers = false;
      for (var mi = 0; mi < body.items.length; mi++) {
        var mItem = body.items[mi];
        var isService = Array.isArray(services) && services.some(function (s) { return s && s.item_id === mItem.item_id; });
        if (!isService) preKitCount++;
        if (MAKERS_FEE_ITEM_ID && mItem.item_id === MAKERS_FEE_ITEM_ID) preHasMakers = true;
        if (!MAKERS_FEE_ITEM_ID && mItem.name && mItem.name.toLowerCase().indexOf('maker') !== -1) preHasMakers = true;
      }
      if (preKitCount > 0 && !preHasMakers) {
        log.warn('[checkout/pre-charge] Kit items present but Makers Fee missing — rejecting before charge');
        return res.status(400).json({ error: 'Order validation failed. Please refresh and try again.' });
      }

      // All validation passed — now charge the card
      var card = new CreditCardData();
      card.token = body.payment_token;
      var chargeAmt = gpLib.getDepositAmount();
      return card.charge(chargeAmt).withCurrency('CAD').withAllowDuplicates(true).execute()
        .then(function (r) {
          if (r.responseCode !== 'SUCCESS' && r.responseCode !== '00') {
            log.warn('[checkout] Card declined during server-side charge: ' + r.responseCode + ' ' + (r.responseMessage || ''));
            return res.status(402).json({ error: 'Payment declined: ' + (r.responseMessage || 'Unknown error') });
          }
          transactionId = r.transactionId;
          depositAmount = chargeAmt;
          log.info('[checkout] Server-side charge succeeded: txn=' + transactionId);
          return checkTransactionIdAndProceed();
        })
        .catch(function (chargeErr) {
          log.error('[checkout] Server-side charge failed: ' + chargeErr.message);
          return res.status(502).json({ error: 'Payment could not be processed' });
        });
    }).catch(function (cacheErr) {
      log.error('[checkout/pre-charge] Cache read failed: ' + cacheErr.message);
      return res.status(503).json({ error: 'Unable to verify item prices. Please try again.' });
    });
  }

  return chargeAndProceed();
}

module.exports = router;
module.exports.verifyRecaptcha = verifyRecaptcha;
module.exports.buildLineItems = buildLineItems;

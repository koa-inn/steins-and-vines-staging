var express = require('express');
var helcimLib = require('../lib/helcim');
var calcom = require('../lib/calcom');
var packagingBookings = require('../lib/packaging-bookings');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
// Zoho calls for the collect apply now go through
// moneyPath.finalizeSalesOrderInvoiceAndApplyPayment (shared with salesorder-pay).
var C = require('../lib/constants');
var reconcile = require('../lib/reconcile');
var moneyPath = require('../lib/money-path');
var captureExceptionSafe = require('../lib/sentry-capture').captureExceptionSafe;

var router = express.Router();

// TTL for terminal result cache entries (used by kiosk polling fallback)
var TERMINAL_RESULT_TTL = 300; // 5 minutes

/**
 * POST /api/webhooks/terminal
 * Receive and process Helcim webhook events.
 *
 * Helcim sends events for: cardTransaction (purchase/refund/void), terminalCancel.
 * Payload is minimal JSON: { id, type }. Full details fetched via API if needed.
 *
 * Signature verification uses HMAC-SHA256 with HELCIM_WEBHOOK_SECRET.
 * Configured in Helcim Hub > Integrations > Webhooks.
 *
 * Security: raw body is required for signature verification.
 * Captured via express.json({ verify }) callback in server.js (req.rawBody).
 */
router.post(['/api/webhooks/terminal', '/webhooks/terminal'], function (req, res) {
  var webhookId = req.headers['webhook-id'] || '';
  var timestamp = req.headers['webhook-timestamp'] || '';
  var signature = req.headers['webhook-signature'] || '';
  // rawBody captured by express.json verify callback in server.js
  var rawBody = req.rawBody ? req.rawBody.toString() : '';

  // Verify HMAC-SHA256 signature
  if (!helcimLib.verifyWebhookSignature(webhookId, timestamp, rawBody, signature)) {
    log.warn('[webhook/helcim] Invalid signature — rejected (body_len=' + rawBody.length + ')');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Body already parsed by express.json()
  var event = req.body;

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
 * Helcim sends a MINIMAL payload: { id, type:'cardTransaction' }. The event.data
 * fields (status, invoiceNumber, etc.) are NOT included. We resolve the full
 * transaction via the API as the primary path, falling back to the device-pending
 * Redis key if the API is unavailable (e.g. token missing read scope).
 *
 * For terminal purchases: cache helcim:terminal:result:{invoiceNumber} so kiosk
 * polling resolves and the frontend confirmSale fires with the real transactionId.
 *
 * The collect-payment flow (POST /api/pos/collect) is a separate flow that also
 * uses this handler to record a Zoho customerpayment. That recording logic is
 * preserved unchanged — it runs after invoice+status are resolved.
 *
 * IMPORTANT: this handler must NOT record a Zoho payment for the kiosk/sale flow.
 * Kiosk Zoho invoice creation happens in POST /api/kiosk/sale/confirm — triggered
 * by the frontend after the poll resolves. Double-recording must be avoided.
 */
// Helcim transaction types that RETURN money. Their webhooks must never be
// processed as an approved charge (see handleCardTransaction).
var REVERSING_TXN_TYPES = ['reverse', 'refund', 'void'];

function handleCardTransaction(event) {
  var transactionId = event.id || '';

  log.info('[webhook/helcim] cardTransaction: resolving txn=' + transactionId);

  // PRIMARY: fetch full transaction details from the Helcim API
  helcimLib.getCardTransactionById(transactionId).then(function (txnData) {
    var status = (txnData.status || '').toUpperCase();
    var invoiceNumber = txnData.invoiceNumber || '';
    var cardType = txnData.cardType || '';

    log.info('[webhook/helcim] cardTransaction: status=' + status +
      ' txn=' + transactionId + ' invoice=' + invoiceNumber);

    // A reversal/refund webhook resolves to status APPROVED with the ORIGINAL
    // sale's invoiceNumber (verified 2026-10-06). Treating it as a charge would
    // mark the sale approved with the reversal id, book collect/kiosk payments
    // for money that was returned, or try to void the reversal on a cancelled
    // ref. Unknown/missing types fall through unchanged so a real charge is
    // never dropped.
    var txnType = txnData.type || '';
    if (REVERSING_TXN_TYPES.indexOf(txnType) !== -1) {
      log.info('[webhook/helcim] cardTransaction: ignoring ' + txnType + ' txn=' + transactionId +
        ' invoice=' + invoiceNumber + ' (money returned, not a charge)');
      eventLog.logEvent('helcim.card_transaction_ignored', {
        type: txnType, status: status, txnId: transactionId, invoiceNumber: invoiceNumber
      });
      return;
    }

    processCardTransactionResult(transactionId, status, invoiceNumber, cardType);
  }).catch(function (apiErr) {
    // FALLBACK: API unavailable — attempt to correlate via device-pending invoice
    var statusCode = apiErr.response ? apiErr.response.status : null;
    log.warn('[webhook/helcim] cardTransaction: API lookup failed (' +
      (statusCode || apiErr.message) + ') for txn=' + transactionId + ' — trying device-pending fallback');

    helcimLib.getPendingInvoiceForDevice().then(function (pendingInvoice) {
      if (!pendingInvoice) {
        log.warn('[webhook/helcim] cardTransaction: API unavailable and no device-pending invoice — cannot correlate txn=' + transactionId + ', dropping event');
        return;
      }
      // WR-07: Do NOT synthesise APPROVED from an API failure.
      //
      // The original assumption — "Helcim creates a card-transaction record only
      // on an approved auth" — is plausible but unverifiable when the API is down.
      // If it is wrong (declined/voided event hitting this fallback), caching APPROVED
      // would set approved:true in the terminal-result store, resolve the kiosk poll
      // as 'approved', and cause /confirm to create a paid Zoho invoice for an
      // uncaptured payment (phantom revenue).
      //
      // Fix: cache status 'UNCONFIRMED' (approved:false).  The kiosk poll handler
      // returns { status: 'pending' } for any non-APPROVED, non-DECLINED status,
      // so the client keeps polling until POLL_TIMEOUT_MS (45 s) and then shows
      // the manual-confirm fallback button.  Staff can confirm manually if the
      // card was genuinely approved, or cancel if not.
      //
      // The reconcile/API-retry path (webhook retry, 5-min sweep) will establish
      // the real status once the Helcim API is back online.
      //
      // Open question (WR-07 / money decision): if Helcim retries the webhook after
      // the API recovers and calls reconcilePendingCharge for a genuinely-approved
      // txn while staff has not yet manually confirmed (pending record still
      // present, MIN_ORPHAN_AGE elapsed), reconcile may void a valid charge.
      // This is documented in 45-FIX2-SUMMARY.md under "Open Money Question".
      log.warn('[webhook/helcim] cardTransaction: API unavailable — caching UNCONFIRMED' +
        ' for invoice=' + pendingInvoice + '; kiosk poll will keep waiting;' +
        ' reconcile/retry will establish real status once API is available');
      processCardTransactionResult(transactionId, 'UNCONFIRMED', pendingInvoice, '');
    }).catch(function (fbErr) {
      log.warn('[webhook/helcim] cardTransaction: device-pending fallback failed: ' + fbErr.message);
    });
  });
}

/**
 * Process a resolved card transaction result: cache the terminal result and
 * handle the collect-pending flow if applicable.
 *
 * @param {string} transactionId  - Helcim transaction ID
 * @param {string} status         - Uppercase status ('APPROVED', 'DECLINED', etc.)
 * @param {string} invoiceNumber  - Invoice/reference number
 * @param {string} cardType       - Card type string (e.g. 'Visa', 'Debit')
 */
function processCardTransactionResult(transactionId, status, invoiceNumber, cardType) {
  // Cache the terminal result so pos.js polling fallback resolves immediately.
  // NOTE: store a JSON STRING (not a raw object) — cache.set JSON.stringifies and
  // cache.get JSON.parses, and pollTerminalResult JSON.parses the get result a
  // SECOND time. The working terminalCancel path uses this same double-stringify
  // convention; passing a raw object here makes pollTerminalResult's parse throw
  // and silently miss the cache.
  if (invoiceNumber) {
    var cacheKey = 'helcim:terminal:result:' + invoiceNumber;
    cache.set(cacheKey, JSON.stringify({
      status: status,
      transactionId: transactionId,
      approved: status === 'APPROVED',
      cardType: cardType
    }), TERMINAL_RESULT_TTL).catch(function (err) {
      log.warn('[webhook/helcim] Failed to cache terminal result: ' + err.message);
    });

    // Clear the device-pending key now that we've consumed it
    helcimLib.getPendingInvoiceForDevice().then(function (pendingInvoice) {
      if (pendingInvoice && pendingInvoice === invoiceNumber) {
        var deviceCode = helcimLib.getDeviceCode();
        if (deviceCode) {
          cache.del('helcim:terminal:pending:' + deviceCode).catch(function () {});
        }
      }
    }).catch(function () {});
  }

  eventLog.logEvent('helcim.card_transaction', {
    status: status,
    txnId: transactionId,
    invoiceNumber: invoiceNumber
  });

  // Collect-pending lookup: if this transaction was initiated by the collect
  // flow, record payment in Zoho or clean up on decline.
  //
  // 71-01: the APPROVED branch used to book the customerpayment against the
  // sales order directly, which Zoho never reconciles against a bookable
  // invoice (unapplied advance, invoice left draft — see
  // .planning/debug/kiosk-so-collect-draft-unapplied.md). It now finalizes
  // the SO's invoice (convert-or-reuse + submit, via
  // moneyPath.ensureOpenInvoiceForSalesOrder) and applies the payment to
  // that invoice_id via invoices:[...] — matching the verified-correct
  // processSale/pos-recipe shape.
  if (invoiceNumber) {
    var pendingKey = C.CACHE_KEYS.COLLECT_PENDING_PREFIX + invoiceNumber;
    // Hoisted so the catch below (fail-closed reporting) can reach the
    // collect context even though it is parsed inside the .then() closure.
    var collectCtx = null;
    // IN-01: surfaced so the fail-closed sentinel can record the invoice that
    // ensureOpenInvoiceForSalesOrder created/reused (it lives only inside the
    // apply closure otherwise).
    var collectInvoiceId = null;
    cache.get(pendingKey).then(function (raw) {
      if (!raw) return; // Not a collect-flow transaction
      // cache.get() ALREADY returns the parsed value (lib/cache.get JSON.parses
      // internally), and collect.js seeds this key via cache.set(<object>). A
      // second JSON.parse here throws on the object and the catch silently drops
      // EVERY real collect apply (charged-but-unbooked) — caught on staging
      // 2026-08-19. Use the object directly; tolerate a legacy JSON string.
      var ctx;
      if (raw && typeof raw === 'object') {
        ctx = raw;
      } else if (typeof raw === 'string') {
        try { ctx = JSON.parse(raw); } catch { return; }
      } else {
        return;
      }
      collectCtx = ctx;

      if (status === 'APPROVED') {
        // BL-01: guard the apply with a per-transaction lock so an at-least-once
        // Helcim re-delivery (concurrent, OR a delivery after a cleanup failure
        // left the pending key alive) cannot double-book the customerpayment.
        // Mirrors the reconcile.js / voidCancelledApprovedCharge discipline:
        // acquire before any work; on contention skip WITHOUT releasing (the
        // holder owns the lock); release ONLY on the path that acquired it.
        //
        // The key is collect-specific — deliberately NOT the shared
        // 'reconcile:txn:' key the terminal reconcile paths use. For a collect
        // txn the concurrent reconcilePendingCharge(transactionId) call below
        // ALSO tries 'reconcile:txn:' + transactionId; it is a harmless no-op
        // for collect (no KIOSK_PENDING record), but if it won that lock race
        // first, sharing the key would starve THIS apply into skipping and the
        // payment would never be booked. A distinct key still fully serialises
        // re-deliveries of the collect flow — the only path that books this
        // payment — which is all BL-01 requires.
        var collectLockKey = 'reconcile:collect:txn:' + transactionId;
        return cache.acquireLock(collectLockKey, 60).then(function (acquired) {
          if (!acquired) {
            log.info('[webhook/helcim] collect-apply: duplicate delivery for txn=' +
              transactionId + ' — lock held; skipping (not releasing)');
            return; // holder owns it — do NOT release
          }
          // Finalize the SO's invoice + apply the payment via the shared money-
          // path helper — identical booking to /api/kiosk/salesorder-pay so the
          // two can't drift back to the salesorders_to_apply / draft-invoice bug.
          return moneyPath.finalizeSalesOrderInvoiceAndApplyPayment(ctx.salesorder_id, {
            customer_id: ctx.customer_id,
            amount: ctx.amount,
            payment_mode: (cardType && cardType.toLowerCase().indexOf('debit') !== -1) ? 'debitcard' : 'creditcard',
            reference_number: transactionId,
            notes: 'In-store terminal payment. Helcim txn: ' + transactionId
          }).then(function (result) {
            collectInvoiceId = result.invoiceId;
          }).then(function () {
            eventLog.logEvent('collect.payment_recorded', {
              soId: ctx.salesorder_id,
              soNumber: ctx.salesorder_number,
              txnId: transactionId,
              amount: ctx.amount,
              invoiceId: collectInvoiceId
            });
            // WR-01: the payment is booked — the apply is DONE. Deleting the
            // pending key is best-effort cleanup, so swallow its failure in its
            // own continuation. Otherwise a Redis blip on del() would reject the
            // apply chain and masquerade as a "failed after charge" alert (and
            // leave the fail-closed catch firing on a payment that actually
            // succeeded). The BL-01 lock covers the residual re-delivery window
            // if the key outlives this cycle.
            return cache.del(pendingKey).catch(function (delErr) {
              log.warn('[webhook/helcim] collect-apply: pending-key cleanup failed ' +
                '(payment already booked) for txn=' + transactionId + ': ' + delErr.message);
            });
          }).then(function () {
            // BL-01: release ONLY on the acquired path — on success OR failure —
            // then re-throw so a genuine apply failure still reaches the
            // fail-closed catch below. Mirrors reconcile.js:313-318.
            return cache.releaseLock(collectLockKey).catch(function () {});
          }, function (err) {
            return cache.releaseLock(collectLockKey).catch(function () {}).then(function () { throw err; });
          });
        });
      } else if (status === 'DECLINED') {
        eventLog.logEvent('collect.payment_declined', {
          soId: ctx.salesorder_id,
          soNumber: ctx.salesorder_number,
          txnId: transactionId,
          amount: ctx.amount
        });
        // Clean up both pending and idempotency keys so staff can retry
        var idemKey = C.CACHE_KEYS.COLLECT_IDEM_PREFIX + ctx.idempotencyKey;
        return Promise.all([cache.del(pendingKey), cache.del(idemKey)]);
      }
    }).catch(function (err) {
      if (collectCtx && status === 'APPROVED') {
        // Fail-closed: the Helcim charge already succeeded — a finalize/apply
        // failure here must never look like silent success (no draft-left-
        // unapplied, no orphaned charge). Write a reconcile-failure record +
        // staff alert and DO NOT delete the pending key, so the collect
        // context is retained for recovery.
        log.error('[webhook/helcim] CRITICAL: Collect-pending finalize/apply failed after charge — SO=' +
          collectCtx.salesorder_number + ' txn=' + transactionId + ': ' + err.message);
        // IN-01: if the invoice was already created/reused before the failure
        // (i.e. the apply, not the finalize, is what failed), record its id on
        // the sentinel so the manual-review record is actionable.
        var failureCtx = collectInvoiceId
          ? Object.assign({}, collectCtx, { invoice_id: collectInvoiceId })
          : collectCtx;
        reconcile.recordCollectReconcileFailure(failureCtx, transactionId, err).catch(function () {});
        captureExceptionSafe(err, {
          level: 'error',
          tags: { soId: collectCtx.salesorder_id, txnId: transactionId }
        });
        return;
      }
      log.warn('[webhook/helcim] Collect-pending handling failed: ' + err.message);
    });
  }

  // D-13 / 68-02: Reconcile kiosk pending charges (45-08 backstop), UNLESS this
  // ref was flagged cancelled (routes/pos.js /api/pos/cancel) — in which case
  // void immediately via the single void path instead of booking. The webhook
  // is the only channel that resolves an approved terminal result independent
  // of the client (which stops polling the instant cancel is clicked), so this
  // check must live here, not on /api/kiosk/sale/status.
  // Runs after the 200 response (fire-and-forget, preserving respond-200-before-async).
  if (status === 'APPROVED' && invoiceNumber) {
    cache.get(C.CACHE_KEYS.KIOSK_CANCELLED_PREFIX + invoiceNumber)
      .catch(function () { return null; })
      .then(function (cancelledFlag) {
        if (!cancelledFlag) {
          return reconcile.reconcilePendingCharge(transactionId).catch(function (err) {
            log.warn('[webhook/helcim] Kiosk pending charge reconcile error: ' + err.message);
            captureExceptionSafe(err, {
              level: 'error',
              tags: { txnId: transactionId, invoiceNumber: invoiceNumber || null }
            });
          });
        }
        return voidCancelledApprovedCharge(transactionId, invoiceNumber);
      });
  }
}

/**
 * T-68-02-1: void a charge that was APPROVED after the sale was cancelled.
 *
 * Sources the void amount from the existing KIOSK_PENDING_CHARGE_PREFIX record
 * (read as an already-parsed object — the same convention reconcile.js uses —
 * a missing/unreadable record still proceeds to void with amount=0, since the
 * amount is only used for the void's failure-alert payload, never to gate the
 * void itself). Voids ONLY through moneyPath.voidWithTimeout (the single void
 * path, audit H5/L18) and clears both the pending-charge record and the
 * cancelled flag afterward.
 *
 * Guarded by the same 'reconcile:txn:' lock reconcile.js:204 uses, so a Helcim
 * webhook re-delivery of the same APPROVED event cannot double-void (the
 * second delivery finds the lock held, skips, and no-ops rather than firing a
 * spurious void-failure staff alert).
 *
 * @param {string} transactionId - Helcim transaction ID
 * @param {string} invoiceNumber - kiosk reference_number (= invoiceNumber)
 * @returns {Promise<void>}
 */
function voidCancelledApprovedCharge(transactionId, invoiceNumber) {
  var lockKey = 'reconcile:txn:' + transactionId;
  return cache.acquireLock(lockKey, 60).then(function (acquired) {
    if (!acquired) {
      // CR-02: another path (the in-flight void, or a concurrent reconcile)
      // holds the lock. Skip WITHOUT releasing — releasing here would free the
      // lock the holder owns, letting a later Helcim re-delivery re-acquire and
      // issue a second void (spurious CRITICAL void-failure alert). The release
      // is nested inside the acquired branch below, mirroring reconcile.js.
      log.info('[webhook/helcim] cancel-void: duplicate delivery for txn=' + transactionId +
        ' — another path holds the reconcile lock; skipping (not releasing)');
      return;
    }
    return cache.get(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + invoiceNumber)
      .catch(function () { return null; })
      .then(function (pendingCtx) {
        var voidAmount = (pendingCtx && typeof pendingCtx.amount === 'number') ? pendingCtx.amount : 0;
        log.warn('[webhook/helcim] APPROVED result for cancelled ref — voiding: txn=' +
          transactionId + ' invoice=' + invoiceNumber + ' amount=$' + voidAmount);
        return moneyPath.voidWithTimeout(helcimLib, transactionId, voidAmount, {
          eventLog: eventLog,
          reqId: invoiceNumber
        }).then(function (voidResult) {
          // CR-01: voidWithTimeout ALWAYS resolves — success, decline, timeout,
          // or error. Only a CONFIRMED void (ok:true) may delete the recovery
          // records. On any non-ok outcome the charge was NOT reversed, so we
          // MUST retain the KIOSK_PENDING_CHARGE record (reconcile.js's 5-minute
          // sweep is the backstop that will retry it) and persist a
          // void-failure sentinel for manual review — mirroring
          // reconcile.js:274-290. voidWithTimeout has already fired the CRITICAL
          // staff alert (non-timeout error) or logged for manual reconciliation
          // (timeout); we do not double-alert here.
          if (!voidResult || !voidResult.ok) {
            var reason = (voidResult && voidResult.reason) || 'unknown';
            log.error('[webhook/helcim] cancel-void FAILED (' + reason + ') for txn=' +
              transactionId + ' invoice=' + invoiceNumber +
              ' — retaining pending record for the reconcile sweep; flagging for manual review');
            return cache.set('sv:void-failure:' + Date.now(), {
              txn_id: transactionId,
              invoice_number: invoiceNumber,
              amount: voidAmount,
              reference_number: (pendingCtx && pendingCtx.reference_number) || invoiceNumber,
              error: 'cancel-after-push void did not confirm (' + reason + ')',
              needs_manual_review: true,
              created_at: new Date().toISOString()
            }, 60 * 60 * 24 * 30).catch(function () {});
          }
          // Confirmed void — safe to record success and clear the recovery records.
          eventLog.logEvent('kiosk.cancel_after_push_voided', {
            txnId: transactionId,
            invoiceNumber: invoiceNumber,
            amount: voidAmount
          });
          return Promise.all([
            cache.del(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + invoiceNumber).catch(function () {}),
            cache.del(C.CACHE_KEYS.KIOSK_CANCELLED_PREFIX + invoiceNumber).catch(function () {})
          ]);
        });
      })
      .catch(function (err) {
        log.warn('[webhook/helcim] cancel-void error for txn=' + transactionId + ': ' + err.message);
        captureExceptionSafe(err, {
          level: 'error',
          tags: { txnId: transactionId, invoiceNumber: invoiceNumber || null }
        });
      })
      .then(function () {
        // CR-02: release ONLY on the path that acquired the lock.
        return cache.releaseLock(lockKey).catch(function () {});
      });
  });
}

/**
 * Handle terminalCancel webhook events.
 * Fires when a customer or cashier cancels a pending terminal transaction.
 * Cache the cancellation so kiosk polling resolves with CANCELLED status.
 *
 * Helcim sends invoiceNumber as empty string in cancel events, so we look up
 * the pending invoice by device code (cached during terminalPurchase).
 */
function handleTerminalCancel(event) {
  var data = event.data || {};
  var invoiceNumber = data.invoiceNumber || '';
  var deviceCode = data.deviceCode || helcimLib.getDeviceCode() || '';

  log.info('[webhook/helcim] terminalCancel: invoice=' + invoiceNumber + ' device=' + deviceCode);

  var cancelResult = JSON.stringify({
    status: 'CANCELLED',
    transactionId: null,
    approved: false,
    cardType: ''
  });

  function cacheCancel(ref) {
    if (!ref) return;
    var cacheKey = 'helcim:terminal:result:' + ref;
    cache.set(cacheKey, cancelResult, TERMINAL_RESULT_TTL).then(function () {
      log.info('[webhook/helcim] Cached cancel for ref=' + ref);
    }).catch(function (err) {
      log.warn('[webhook/helcim] Failed to cache terminal cancel: ' + err.message);
    });
  }

  if (invoiceNumber) {
    cacheCancel(invoiceNumber);
  } else if (deviceCode) {
    // Look up pending invoice by device code
    cache.get('helcim:terminal:pending:' + deviceCode).then(function (pendingRef) {
      if (pendingRef) {
        cacheCancel(pendingRef);
        cache.del('helcim:terminal:pending:' + deviceCode).catch(function () {});
      } else {
        log.warn('[webhook/helcim] terminalCancel: no pending invoice found for device=' + deviceCode);
      }
    }).catch(function () {});
  }

  eventLog.logEvent('helcim.terminal_cancel', { invoiceNumber: invoiceNumber, deviceCode: deviceCode });
}

/**
 * POST /api/webhooks/calcom
 * Receive and process Cal.com webhook events.
 *
 * Cal.com fires events for: BOOKING_CREATED, BOOKING_CANCELLED, BOOKING_RESCHEDULED.
 * Payload includes triggerEvent + payload (with booking start datetime).
 *
 * Signature verification uses HMAC-SHA256 with CALCOM_WEBHOOK_SECRET.
 * Header: x-cal-signature-256 (single header, hex digest over raw body).
 *
 * Security: raw body is required for signature verification.
 * Captured via express.json({ verify }) callback in server.js (req.rawBody).
 *
 * Guard exemptions (server.js):
 *   - API key: req.path.indexOf('/webhooks/') === 0 -> exempt (line 239)
 *   - Referer: !req.headers.referer -> skip (line 73); Cal.com sends no Referer
 *
 * T-25-07: forged webhook — mitigated by HMAC-SHA256 + 401 on mismatch
 * T-25-08: guard bypass — mitigated by dual-path /webhooks/ exemption
 * T-25-10: slow processing — mitigated by 200-before-async pattern
 */
router.post(['/api/webhooks/calcom', '/webhooks/calcom'], function (req, res) {
  var signature = req.headers['x-cal-signature-256'] || '';
  // rawBody captured by express.json verify callback in server.js
  var rawBody = req.rawBody ? req.rawBody.toString() : '';

  // Verify HMAC-SHA256 signature
  if (!calcom.verifyWebhook(rawBody, signature)) {
    log.warn('[webhook/calcom] Invalid signature — rejected (body_len=' + rawBody.length + ')');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Respond 200 immediately — process asynchronously to avoid webhook timeout
  res.status(200).json({ received: true });

  var body = req.body || {};
  var triggerEvent = body.triggerEvent || '';

  log.info('[webhook/calcom] Event received: triggerEvent=' + triggerEvent);
  eventLog.logEvent('calcom.webhook_received', { triggerEvent: triggerEvent });

  // Phase 97 D-02: next packaging-bookings request refetches. In-process generation bump, no
  // cache.del, so the existing webhook cache expectations hold.
  if (triggerEvent === 'BOOKING_CREATED' || triggerEvent === 'BOOKING_RESCHEDULED' ||
      triggerEvent === 'BOOKING_CANCELLED') {
    packagingBookings.invalidate();
  }

  if (triggerEvent === 'BOOKING_CANCELLED') {
    handleCalcomCancellation(body);
  } else {
    // BOOKING_CREATED, BOOKING_RESCHEDULED: log only — idempotent, no destructive effects
    log.info('[webhook/calcom] Received ' + (triggerEvent || 'unknown') + ' — no side effects');
  }
});

/**
 * Handle BOOKING_CANCELLED webhook events.
 * Invalidates the cached slots and availability for the affected date so freed
 * slots reappear on the next client request.
 *
 * Field path fallbacks (RESEARCH Assumption A2 — confirmed empirically in Plan 04):
 *   1. payload.startTime
 *   2. payload.booking.start
 *   3. payload.start
 * If none yield a parseable ISO date, logs a warning and skips cache deletion.
 *
 * @param {Object} body - Parsed webhook body (req.body)
 */
function handleCalcomCancellation(body) {
  var payload = body.payload || {};

  // Derive the YYYY-MM-DD date string from the booking start — try three field paths
  var rawDate = payload.startTime ||
    (payload.booking && payload.booking.start) ||
    payload.start ||
    '';

  var date = '';
  if (rawDate) {
    // Accepts ISO-8601 strings; slice to 10 chars gives YYYY-MM-DD
    var parsed = new Date(rawDate);
    if (!isNaN(parsed.getTime())) {
      date = rawDate.toString().slice(0, 10);
    }
  }

  if (!date) {
    log.warn('[webhook/calcom] BOOKING_CANCELLED: could not derive date from payload — skipping cache invalidation');
    return;
  }

  var yearMonth = date.substring(0, 7); // YYYY-MM

  cache.del(C.CACHE_KEYS.SLOTS_PREFIX + date).catch(function (err) {
    log.warn('[webhook/calcom] Failed to delete slots cache for ' + date + ': ' + err.message);
  });
  cache.del(C.CACHE_KEYS.AVAILABILITY_PREFIX + yearMonth).catch(function (err) {
    log.warn('[webhook/calcom] Failed to delete availability cache for ' + yearMonth + ': ' + err.message);
  });

  log.info('[webhook/calcom] BOOKING_CANCELLED: invalidated cache for date=' + date + ' month=' + yearMonth);
  eventLog.logEvent('calcom.booking_cancelled', { date: date, month: yearMonth });
}

module.exports = router;

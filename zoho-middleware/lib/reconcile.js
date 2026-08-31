'use strict';

// ---------------------------------------------------------------------------
// lib/reconcile.js — D-13 Helcim↔Zoho orphan-charge reconciliation backstop
//
// Closes the late-approval window that synchronous void-on-failure (45-06/07)
// cannot catch: a terminal may approve a charge AFTER the 90-second polling
// timeout, leaving the customer charged with no matching Zoho order.
//
// Two entry points:
//   reconcilePendingCharge(transactionId, deps)
//     Called by the webhook handler (routes/webhooks.js) when a late Helcim
//     approval arrives for a kiosk/sale or salesorder-pay charge.
//     Has the transactionId → can auto-void or persist sv:void-failure record.
//
//   sweepPendingCharges(deps)
//     Called by setInterval in server.js every 5 minutes as a backstop for
//     failed webhook deliveries.  Reads the helcim:terminal:result cache
//     (set by the webhook handler) to extract the transactionId; if unavailable
//     but the record is old enough, flags for manual review.
//     No-ops cleanly when Redis is disconnected.
//
// Keying convention (from 45-07):
//   Pending cache key: KIOSK_PENDING_CHARGE_PREFIX + invoiceNumber
//   invoiceNumber = the refNumber / soNumber passed to Helcim terminalPurchase
//   (Helcim returns this as txn.invoiceNumber via getCardTransactionById)
//
// "Matching Zoho order" detection:
//   The kiosk/sale/confirm handler writes its idempotency result under
//   KIOSK_IDEM_PREFIX + 'confirm:' + idempotency_key (TTL 10 min).
//   If that key is present → confirm ran → Zoho invoice/payment was recorded.
//   The confirm handler also deletes the pending record on success (45-08 Rule 2).
//   Both signals are checked; presence of either means the charge is settled.
//
// Threat: T-45-08-ORPHAN (Repudiation / Integrity)
// ---------------------------------------------------------------------------

var log      = require('./logger');
var cache    = require('./cache');
var C        = require('./constants');
var eventLog = require('./eventLog');
var zohoApi  = require('./zoho-api');
var zohoGet  = zohoApi.zohoGet;

var PENDING_PREFIX                  = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX;
var TERMINAL_RESULT_PREFIX          = 'helcim:terminal:result:';
var COLLECT_RECONCILE_FAILURE_PREFIX = C.CACHE_KEYS.COLLECT_RECONCILE_FAILURE_PREFIX;
// 30-day TTL for void-failure sentinel records (matches pos.js:1007/1664 convention)
var VOID_FAILURE_TTL = 30 * 24 * 60 * 60;
// 7-day TTL for the pending-charge record when re-written with the
// manual_review_alerted marker (mirrors KIOSK_PENDING_CHARGE_TTL in routes/pos.js).
var PENDING_CHARGE_TTL = 7 * 24 * 60 * 60;
// Minimum pending-record age (seconds) before reconcile treats a charge as a
// potential orphan.
//
// WR-02(a): The original value (120 s) was barely larger than the 90-second
// terminal approval window, leaving no room for the human-in-the-loop confirm
// step.  If staff take more than 120 s to tap "Confirm" after the terminal
// approves (slow batch review, second screen, network hiccup), the sweep would
// void a valid charge and then /confirm would record a Zoho payment against a
// reversed charge.
//
// Raised to 600 s (10 min):
//   - Covers the full 45 s client poll + manual-confirm fallback window
//   - Leaves ample time for staff to complete the confirm step
//   - Terminal-result cache TTL (300 s) expires before the age guard fires, so
//     the sweep transitions to the "manual review" path (not auto-void) for
//     stale APPROVED results — avoiding the false-positive-void race entirely
//   - Genuine orphans (no confirm at all) are still caught after 10 min
var MIN_ORPHAN_AGE_SECONDS = 600;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Zoho-authoritative settled check (D-50-07/D-50-08). Answers "was this
 * charge actually recorded?" by asking Zoho directly, branching on which
 * surface wrote the pending record — see hasMatchingZohoOrder's own doc for
 * the full ladder this implements step 2/3 of.
 *
 * D-50-08: a single invoice-reference lookup does NOT work uniformly.
 * /api/kiosk/salesorder-pay creates its invoice via an EMPTY-body
 * zohoPost('/invoices/fromsalesorder?...') (pos.js) that never sets
 * reference_number to the kiosk payment reference — a fully paid SO-pay
 * charge would legitimately return an empty invoices array, which a naive
 * invoice-only check would misclassify as an orphan and void a paying
 * customer. So: a record carrying ctx.salesorder_id is verified against the
 * SALES ORDER (the durable record of payment — the customerpayment applies
 * to it BEFORE the best-effort invoice leg runs); every other record type
 * (/api/kiosk/sale, /api/kiosk/recipe-sale — both DO set reference_number on
 * their invoice payload) is verified via the invoice reference lookup.
 *
 * @param {Object} ctx  Pending charge context from Redis
 * @returns {Promise<{settled: boolean, proven: boolean}>}
 *   proven=true  → the Zoho answer is authoritative (safe to act on it)
 *   proven=false → the Zoho call was unanswerable; settled is forced true
 *                  (fail CLOSED — never void what could not be verified)
 */
function _zohoAuthoritativeCheck(ctx) {
  if (ctx && ctx.salesorder_id) {
    return zohoGet('/salesorders/' + encodeURIComponent(ctx.salesorder_id)).then(function (data) {
      var so = (data && data.salesorder) || {};
      var balance = parseFloat(so.balance);
      var statusStr = ((so.order_status || so.status || '') + '').toLowerCase();
      var settled = (!isNaN(balance) && balance <= 0.01) || statusStr === 'paid' || statusStr === 'closed';
      return { settled: settled, proven: true };
    }).catch(function (err) {
      log.error('[reconcile] Zoho salesorder lookup failed for SO=' + ctx.salesorder_id +
        ': ' + (err && err.message || err) + ' — treating as settled (fail CLOSED, D-50-07): will NOT void');
      return { settled: true, proven: false };
    });
  }

  var refNum = (ctx && ctx.reference_number) || '';
  return zohoGet('/invoices?reference_number=' + encodeURIComponent(refNum)).then(function (data) {
    var invoices = (data && data.invoices) || [];
    return { settled: invoices.length > 0, proven: true };
  }).catch(function (err) {
    log.error('[reconcile] Zoho invoice lookup failed for reference=' + refNum +
      ': ' + (err && err.message || err) + ' — treating as settled (fail CLOSED, D-50-07): will NOT void');
    return { settled: true, proven: false };
  });
}

/**
 * Return whether the given pending-charge context has a matching, settled
 * Zoho order — the gate that decides whether reconcile voids a charge.
 *
 * D-50-07: a three-step ladder, in order:
 *   1. Cache fast path (cheap, no Zoho call): if the confirm-level
 *      idempotency key written by /api/kiosk/sale(recipe)/confirm on success
 *      (KIOSK_IDEM_PREFIX + 'confirm:' + key) is present, confirm ran and the
 *      Zoho invoice is recorded — settled, proven. A Redis error on THIS
 *      step falls through to step 2 (never straight to "not settled").
 *   2. Zoho authority (D-50-08 branch — see _zohoAuthoritativeCheck):
 *      otherwise, ask Zoho whether the sale was actually recorded.
 *   3. Fail CLOSED on an unanswerable Zoho call: an unprovable answer
 *      resolves settled=true, proven=false — the caller must NOT void and
 *      must NOT clear the pending record, so the next sweep gets another
 *      chance to prove it one way or the other. We void ONLY when we can
 *      positively prove a charge is orphaned; an unprovable case is left
 *      standing, because an incorrect void takes money back from a customer
 *      who legitimately paid — the safe direction is to do nothing, not to
 *      "fail safe" by reversing a card charge we cannot account for.
 *
 * @param {Object} ctx  Pending charge context from Redis
 * @returns {Promise<{settled: boolean, proven: boolean}>}
 */
function hasMatchingZohoOrder(ctx) {
  if (!ctx || !ctx.idempotency_key) {
    // No idempotency_key on the record at all (the salesorder-pay case this
    // early return used to bail out of entirely) → skip straight to the
    // Zoho authority check; there is no cache fast path to try.
    return _zohoAuthoritativeCheck(ctx);
  }

  var confirmIdemKey = C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:' + ctx.idempotency_key;
  return cache.get(confirmIdemKey).then(function (val) {
    if (val) {
      return { settled: true, proven: true };
    }
    return _zohoAuthoritativeCheck(ctx);
  }).catch(function () {
    // Redis error on the cache fast path itself — fall through to the Zoho
    // authority check rather than resolving false (D-50-07 inversion).
    return _zohoAuthoritativeCheck(ctx);
  });
}

/**
 * Return true if the pending record is old enough to be treated as a potential
 * orphan (i.e., outside the normal 90-second terminal approval window).
 *
 * Guards against false-positive voids on normal approvals that arrive to the
 * webhook before the kiosk frontend has finished calling /confirm.
 *
 * @param {Object} ctx  Pending charge context (must have created_at field)
 * @returns {boolean}
 */
function isOldEnough(ctx) {
  if (!ctx || !ctx.created_at) {
    // created_at missing → age unknown → treat as old (safe for orphan detection)
    return true;
  }
  var createdAt = new Date(ctx.created_at).getTime();
  if (isNaN(createdAt)) return true;  // unparseable → treat as old
  var ageSeconds = (Date.now() - createdAt) / 1000;
  return ageSeconds >= MIN_ORPHAN_AGE_SECONDS;
}

/**
 * Return true if the void-transaction error indicates the charge was already
 * reversed/voided before this reconcile attempt ran.
 *
 * This covers the race where two paths (webhook + sweep) both see a pending
 * record and both call voidTransaction.  The second call fails with an
 * "already reversed" / "already voided" error from Helcim.  Rather than
 * treating this as a genuine failure (which would write sv:void-failure and
 * send a staff alert), we treat it as a success — the charge IS voided, we
 * just didn't do it.
 *
 * Helcim returns HTTP 422 with a body containing the word "already" or
 * "reversal" for already-reversed transactions.  We also check the error
 * message text for both forms since the exact wording may vary.
 *
 * @param {Error} err  Error from voidTransaction rejection
 * @returns {boolean}
 */
function isAlreadyVoidedError(err) {
  if (!err) return false;
  // D-50-02b structural guard: an unconfirmed void (lib/helcim.js
  // voidTransaction rejection with isUnconfirmedVoid===true) is definitionally
  // NOT an already-voided success, regardless of what Helcim's raw status
  // string says. The static error wording avoids the collision substrings
  // below, but interpolates Helcim's status verbatim — a real status like
  // 'reversal_pending' or 'already_processed' would otherwise smuggle a
  // collision substring back into err.message and cause reconcile to
  // silently clear the pending sentinel with no sv:void-failure record and
  // no staff alert (see reconcile-unconfirmed-void.test.js).
  if (err.isUnconfirmedVoid === true) return false;
  var msg = (err.message || '').toLowerCase();
  // Check error message text
  if (msg.indexOf('already') !== -1 || msg.indexOf('reversal') !== -1 ||
      msg.indexOf('reversed') !== -1 || msg.indexOf('voided') !== -1) {
    return true;
  }
  // Check HTTP response body (Helcim 422 body)
  if (err.response && err.response.data) {
    var body = '';
    try { body = JSON.stringify(err.response.data).toLowerCase(); } catch { body = ''; }
    if (body.indexOf('already') !== -1 || body.indexOf('reversal') !== -1 ||
        body.indexOf('reversed') !== -1 || body.indexOf('voided') !== -1) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile a single pending kiosk charge keyed by Helcim transaction ID.
 *
 * Flow:
 *   1. Fetch full txn details from Helcim (status + invoiceNumber).
 *   2. Look up KIOSK_PENDING_CHARGE_PREFIX + invoiceNumber in Redis.
 *   3a. No pending record → no-op (not our transaction / already settled).
 *   3b. Pending record exists but too recent → defer (normal flow window).
 *   4a. APPROVED + pending + no Zoho order → void; on void failure persist
 *       sv:void-failure + send staff alert.
 *   4b. APPROVED + pending + Zoho order found → clear pending (settled).
 *   5. Helcim lookup failure → leave record intact for later retry.
 *
 * @param {string} transactionId  Helcim transaction ID from the webhook event
 * @param {Object} [deps]         { helcim, mailer } — injected for testing
 * @returns {Promise<void>}
 */
function reconcilePendingCharge(transactionId, deps) {
  var helcimLib = (deps && deps.helcim)   || require('./helcim');
  var mailer    = (deps && deps.mailer)   || require('./mailer');

  if (!transactionId) return Promise.resolve();

  // WR-02(c): Acquire a short-lived lock before doing anything destructive.
  // Both the webhook handler and the 5-minute sweep can call this function for
  // the same transactionId concurrently.  Without a lock both would reach the
  // voidTransaction step, the second void would fail (already voided), and the
  // void-failure handler would persist a sv:void-failure sentinel and send a
  // false-positive staff alert.
  //
  // The lock is keyed on transactionId (unique per Helcim transaction) with a
  // 60-second TTL — enough to cover the entire void + cleanup cycle.  The lock
  // is always released when reconcile completes (success or failure).
  var lockKey = 'reconcile:txn:' + transactionId;
  return cache.acquireLock(lockKey, 60).then(function (acquired) {
    if (!acquired) {
      log.info('[reconcile] Duplicate reconcile for txn=' + transactionId +
        ' — another path holds the lock; skipping');
      return;
    }

    return helcimLib.getCardTransactionById(transactionId)
    .then(function (txnData) {
      var status        = (txnData.status || '').toUpperCase();
      var invoiceNumber = txnData.invoiceNumber || '';

      log.info('[reconcile] Resolved txn=' + transactionId +
        ' status=' + status + ' invoice=' + invoiceNumber);

      if (status !== 'APPROVED') {
        // Not approved — nothing to reconcile
        return;
      }

      if (!invoiceNumber) {
        log.warn('[reconcile] APPROVED txn=' + transactionId +
          ' has no invoiceNumber — cannot locate pending record');
        return;
      }

      var pendingKey = PENDING_PREFIX + invoiceNumber;

      return cache.get(pendingKey).then(function (ctx) {
        if (!ctx) {
          // No pending record → not a kiosk charge or already settled
          return;
        }

        // Age guard: skip if the record is too recent (normal approval window)
        if (!isOldEnough(ctx)) {
          log.info('[reconcile] Pending record for invoice=' + invoiceNumber +
            ' is too recent — deferring (normal approval window)');
          return;
        }

        return hasMatchingZohoOrder(ctx).then(function (result) {
          if (result.settled && result.proven) {
            // Charge was proven settled (cache fast path or a positive Zoho
            // answer) — clear the pending sentinel.
            log.info('[reconcile] Pending charge settled for invoice=' +
              invoiceNumber + ' txn=' + transactionId + ' — clearing record');
            return cache.del(pendingKey);
          }

          if (result.settled && !result.proven) {
            // D-50-07 fail-CLOSED: the Zoho check was unanswerable. Do NOT
            // void, do NOT clear the pending record — leave it intact so the
            // next sweep gets another chance to prove it one way or the
            // other (mirrors the Helcim-lookup-failure precedent below).
            log.warn('[reconcile] Zoho check unprovable for invoice=' + invoiceNumber +
              ' txn=' + transactionId + ' — leaving pending record intact (fail CLOSED, D-50-07)');
            return;
          }

          // Orphan detected: APPROVED but no Zoho order — void it
          log.warn('[reconcile] ORPHAN CHARGE DETECTED: txn=' + transactionId +
            ' invoice=' + invoiceNumber +
            ' amount=$' + (ctx.amount || 0) + ' — voiding');

          return helcimLib.voidTransaction(transactionId)
            .then(function () {
              log.info('[reconcile] Void succeeded for orphan txn=' + transactionId);
              return cache.del(pendingKey);
            })
            .catch(function (voidErr) {
              // WR-02(c): "already reversed/voided" means another path already
              // voided the charge — treat as success (clear the pending sentinel,
              // no staff alert, no sv:void-failure record).
              if (isAlreadyVoidedError(voidErr)) {
                log.info('[reconcile] txn=' + transactionId +
                  ' already voided by another path — treating as success, clearing pending record');
                return cache.del(pendingKey);
              }

              var voidFailureKey = 'sv:void-failure:' + Date.now();
              var voidFailureRecord = {
                txn_id:           transactionId,
                invoice_number:   invoiceNumber,
                amount:           ctx.amount || 0,
                reference_number: ctx.reference_number || invoiceNumber,
                error:            voidErr.message || 'unknown',
                needs_manual_review: true,
                created_at:       new Date().toISOString()
              };

              log.error('[reconcile] CRITICAL: void failed for orphan txn=' +
                transactionId + ': ' + voidErr.message + ' — flagging for manual review');

              // Persist void-failure sentinel (30-day TTL; matches pos.js:1007/1664)
              cache.set(voidFailureKey, voidFailureRecord, VOID_FAILURE_TTL)
                .catch(function () {});

              // Alert staff
              return mailer.sendVoidFailureAlert({
                txnId:     transactionId,
                amount:    ctx.amount || 0,
                error:     voidErr.message || 'unknown',
                timestamp: new Date().toISOString()
              }).catch(function (mailErr) {
                log.error('[reconcile] sendVoidFailureAlert also failed: ' +
                  mailErr.message);
              });
            });
        });
      });
    })
    .catch(function (lookupErr) {
      // Helcim lookup failed — leave the pending record intact for a later attempt
      log.warn('[reconcile] Helcim lookup failed for txn=' + transactionId +
        ' (' + (lookupErr.message || lookupErr) + ') — leaving pending record intact');
    })
    .then(function () {
      // WR-02(c): Always release the reconcile lock when the cycle completes
      // (void success, already-settled, deferred, already-voided, or lookup failure).
      // Releasing promptly allows the next webhook retry or sweep cycle to re-acquire
      // if needed.  Cache errors on release are silently ignored.
      return cache.releaseLock(lockKey).catch(function () {});
    });
  }); // end cache.acquireLock.then (WR-02(c) serialisation wrapper)
}

/**
 * Sweep all kiosk pending charge records and reconcile each one.
 *
 * Primary use: catch orphan charges when webhook delivery was missed.
 * For each KIOSK_PENDING_CHARGE_PREFIX key:
 *   - If the terminal result cache (helcim:terminal:result:{invoiceNumber})
 *     is still live (300-second TTL set by processCardTransactionResult) AND
 *     the result is APPROVED → extract transactionId → call reconcilePendingCharge.
 *   - If the result cache has expired but the pending record is old enough
 *     (> MIN_ORPHAN_AGE_SECONDS) → flag for manual review (we have no transactionId
 *     to attempt an auto-void; staff will investigate).
 *
 * No-ops cleanly when Redis is disconnected.
 * Bounded: processes records sequentially to avoid Redis burst.
 *
 * @param {Object} [deps]  { helcim, mailer } — injected for testing
 * @returns {Promise<void>}
 */
function sweepPendingCharges(deps) {
  var mailer = (deps && deps.mailer) || require('./mailer');

  if (!cache.isConnected()) {
    log.info('[reconcile/sweep] Redis not connected — skipping sweep');
    return Promise.resolve();
  }

  return cache.getClient().then(function (c) {
    if (!c) return;
    return c.keys(PENDING_PREFIX + '*');
  }).then(function (keys) {
    if (!keys || keys.length === 0) return;

    log.info('[reconcile/sweep] Found ' + keys.length +
      ' pending kiosk charge(s) — checking each');

    var chain = Promise.resolve();
    keys.forEach(function (key) {
      chain = chain.then(function () {
        return cache.get(key).then(function (ctx) {
          if (!ctx || !ctx.reference_number) {
            // Malformed entry — remove it
            return cache.del(key);
          }

          var invoiceNumber  = ctx.reference_number;
          var resultCacheKey = TERMINAL_RESULT_PREFIX + invoiceNumber;

          return cache.get(resultCacheKey).then(function (rawResult) {
            // The terminal result was stored via JSON.stringify({...}) and cache.set
            // JSON.stringifies again → double-stringify.  cache.get parses once,
            // giving back a string.  Parse again to get the object.
            var parsed = null;
            if (rawResult !== null && rawResult !== undefined) {
              try {
                parsed = typeof rawResult === 'string'
                  ? JSON.parse(rawResult)
                  : rawResult;  // defensive: already an object (shouldn't happen)
              } catch {
                parsed = null;
              }
            }

            if (parsed && parsed.transactionId && parsed.approved) {
              // Terminal result cached and APPROVED — reconcile
              log.info('[reconcile/sweep] Terminal result found for invoice=' +
                invoiceNumber + ' txn=' + parsed.transactionId + ' — reconciling');
              return reconcilePendingCharge(parsed.transactionId, deps);
            }

            // No terminal result cached.
            // If the record is old enough, flag for manual review.
            if (!isOldEnough(ctx)) {
              // Too recent — still within normal window, skip
              return;
            }

            // De-dupe repeat alerts.  This sweep runs every 5 minutes and the
            // pending record persists for KIOSK_PENDING_CHARGE_TTL (7 days), so
            // without a marker the same stuck record re-emits a "void failed —
            // manual review" email on every cycle — up to ~2000 emails per
            // record before the TTL expires (observed 2026-07-02).  Once a
            // record has been flagged, skip the sentinel + alert on later sweeps.
            if (ctx.manual_review_alerted) {
              log.info('[reconcile/sweep] pending charge invoice=' + invoiceNumber +
                ' already flagged for manual review — skipping duplicate alert');
              return;
            }

            // Old pending record with no known terminal result → flag for review
            var voidFailureKey = 'sv:void-failure:' + Date.now();
            var flagRecord = {
              reference_number:      ctx.reference_number,
              amount:                ctx.amount || 0,
              salesorder_id:         ctx.salesorder_id || null,
              needs_manual_review:   true,
              reason:                'pending_charge_no_terminal_result',
              original_created_at:   ctx.created_at || null,
              created_at:            new Date().toISOString()
            };

            log.warn('[reconcile/sweep] POTENTIAL ORPHAN (no terminal result): ' +
              'pending charge invoice=' + invoiceNumber +
              ' amount=$' + (ctx.amount || 0) + ' — flagging for manual review');

            cache.set(voidFailureKey, flagRecord, VOID_FAILURE_TTL)
              .catch(function () {});

            // Mark the pending record so subsequent sweeps do not re-alert.
            // created_at is preserved (isOldEnough depends on it); the record is
            // re-set with the original pending-charge TTL so it still self-expires.
            // The sv:void-failure sentinel above remains the durable manual-review
            // artifact; a genuinely late webhook can still auto-void via the
            // reconcilePendingCharge path while the marked record lives.
            var alertedCtx = Object.assign({}, ctx, { manual_review_alerted: true });
            cache.set(key, alertedCtx, PENDING_CHARGE_TTL)
              .catch(function () {});

            return mailer.sendVoidFailureAlert({
              txnId:     invoiceNumber,
              amount:    ctx.amount || 0,
              error:     'pending_charge_no_terminal_result',
              timestamp: new Date().toISOString()
            }).catch(function (mailErr) {
              log.error('[reconcile/sweep] Alert failed: ' + mailErr.message);
            });
          });
        }).catch(function (err) {
          log.warn('[reconcile/sweep] Error processing key=' + key +
            ': ' + (err.message || err));
        });
      });
    });

    return chain;
  }).catch(function (err) {
    log.warn('[reconcile/sweep] Sweep failed: ' + (err.message || err));
  });
}

/**
 * Record a fail-closed sentinel for a collect-flow payment that could not be
 * finalized/applied to an invoice AFTER the Helcim charge already succeeded
 * — 71-01 (kiosk SO-collect reconciliation).
 *
 * Mirrors the sv:void-failure sentinel idiom above (see the void-failure
 * branch in reconcilePendingCharge): a cache-key record with 30-day TTL plus
 * a staff alert, so a human/backstop can recover the charge rather than it
 * being silently stranded (draft invoice, unapplied advance, or a payment
 * that never got booked at all).
 *
 * Reuses mailer.sendVoidFailureAlert (the existing staff-alert convention)
 * rather than introducing a new mailer method — its subject line reads "void
 * failed", which is a known cosmetic mismatch for this non-void failure
 * class; the body's `error` field carries the real (collect-reconcile)
 * failure description.
 *
 * ZERO PII: only txnId/soId/soNumber/invoiceId/amount are logged via
 * eventLog — no customer email/name/phone (see eventLog.js header).
 *
 * @param {Object} ctx            - Collect-pending context (salesorder_id, salesorder_number, customer_id, amount, invoice_id?)
 * @param {string} transactionId  - Helcim transaction ID
 * @param {Error} err             - The error that triggered the fail-closed path
 * @returns {Promise<void>}
 */
function recordCollectReconcileFailure(ctx, transactionId, err) {
  var mailer = require('./mailer');
  var safeCtx = ctx || {};
  var errMessage = (err && err.message) || 'unknown';

  var record = {
    txn_id: transactionId,
    salesorder_id: safeCtx.salesorder_id || null,
    salesorder_number: safeCtx.salesorder_number || null,
    invoice_id: safeCtx.invoice_id || null,
    amount: safeCtx.amount || 0,
    error: errMessage,
    needs_manual_review: true,
    created_at: new Date().toISOString()
  };

  var key = COLLECT_RECONCILE_FAILURE_PREFIX + Date.now();

  log.error('[reconcile] CRITICAL: collect reconcile failed — SO=' +
    (safeCtx.salesorder_number || safeCtx.salesorder_id || 'unknown') +
    ' txn=' + transactionId + ' amount=$' + (safeCtx.amount || 0) +
    ' error=' + errMessage + ' — flagging for manual review');

  eventLog.logEvent('collect.reconcile_failed', {
    soId: safeCtx.salesorder_id || null,
    soNumber: safeCtx.salesorder_number || null,
    txnId: transactionId,
    amount: safeCtx.amount || 0
  });

  return cache.set(key, record, VOID_FAILURE_TTL)
    .catch(function () {})
    .then(function () {
      return mailer.sendVoidFailureAlert({
        txnId: transactionId,
        amount: safeCtx.amount || 0,
        error: 'Collect payment reconcile failed post-charge (SO=' +
          (safeCtx.salesorder_number || safeCtx.salesorder_id || 'unknown') + '): ' + errMessage,
        timestamp: record.created_at
      }).catch(function (mailErr) {
        log.error('[reconcile] Collect reconcile-failure alert email failed: ' + mailErr.message);
      });
    });
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  reconcilePendingCharge:        reconcilePendingCharge,
  sweepPendingCharges:           sweepPendingCharges,
  recordCollectReconcileFailure: recordCollectReconcileFailure,
  // Exported for direct testing of the D-50-02b cross-module guard: an
  // unconfirmed-void error's message must not collide with the substrings
  // this function treats as an already-voided SUCCESS signal (see
  // helcim-void-status.test.js case 9).
  isAlreadyVoidedError:          isAlreadyVoidedError
};

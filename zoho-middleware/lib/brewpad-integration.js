'use strict';

var axios = require('axios');
var log = require('./logger');
var eventLog = require('./eventLog');
var cache = require('./cache');
var C = require('./constants');
var checkoutHelpers = require('./checkout-helpers');
var zohoApi = require('./zoho-api');
var zohoPut = zohoApi.zohoPut;
var zohoGet = zohoApi.zohoGet;

var RETRY_TTL = 86400;   // 24 hours
var MAX_RETRIES = 3;
var RETRY_PREFIX = C.CACHE_KEYS.BATCH_RETRY_PREFIX;

var SYNC_RETRY_TTL = 86400;   // 24 hours
var SYNC_MAX_RETRIES = 3;
var SYNC_RETRY_PREFIX = C.CACHE_KEYS.BATCH_SYNC_RETRY_PREFIX;

/**
 * Split a full customer name into first and last name parts.
 * First word becomes firstname, everything after becomes lastname.
 *
 * @param {string} fullName - e.g. "Jane Doe", "Mary Jane Watson", "Jane"
 * @returns {{first: string, last: string}}
 */
function splitCustomerName(fullName) {
  var trimmed = (fullName || '').trim();
  if (!trimmed) return { first: '', last: '' };

  // Zoho stores contacts surname-first ("Gamba, Remo") and that display name is what
  // the kiosk sends. Splitting on whitespace alone kept the comma AND swapped the
  // fields (batch SV-B-000173 was written with firstname "Gamba,", lastname "Remo").
  if (trimmed.indexOf(',') !== -1) {
    var commaParts = trimmed.split(',');
    return {
      first: commaParts.slice(1).join(',').trim(),
      last: commaParts[0].trim()
    };
  }

  var parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Detect kit items that need batch creation.
 * Per D-02: only sales with a Maker's Fee trigger batch creation.
 * Per D-03: one batch per non-fee kit line item.
 *
 * @param {Array} lineItems - from the sale payload
 * @returns {Array} kit items (excluding all fee items: Maker's Fee + Materials Fee)
 */
function detectKitItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return [];

  var makersFeeItemId = process.env.MAKERS_FEE_ITEM_ID || '';
  var feeItem = checkoutHelpers.findMakersFeeItem(lineItems, makersFeeItemId);
  if (!feeItem) return [];  // No Maker's Fee = not a ferment-in-store sale

  // Also find Materials Fee to exclude it from kit items
  var materialsFeeItemId = process.env.MATERIALS_FEE_ITEM_ID || '';
  var matFeeItem = checkoutHelpers.findMaterialsFeeItem(lineItems, materialsFeeItemId);

  // Return all non-fee items (the actual kits), skipping truly-blank lines.
  return lineItems.filter(function (item) {
    if (item === feeItem || item === matFeeItem) return false;
    // A line with no sku, no item_id AND no name cannot form a real batch — creating
    // one previously errored on import with an empty product (INV-000137). Skip it.
    var hasId = ((item && (item.sku || item.item_id)) || '').toString().trim() !== '';
    var hasName = ((item && item.name) || '').toString().trim() !== '';
    if (!hasId && !hasName) return false;
    return true;
  });
}

// Number of batches to create for a kit line item — one fermentation batch per unit
// (D-03 revised: quantity-aware). Missing/invalid quantity defaults to 1; an absurd
// quantity is clamped as a fat-finger guard.
var MAX_BATCHES_PER_KIT_LINE = 100;
function kitBatchQuantity(item) {
  var q = Math.floor(Number(item && item.quantity));
  if (!isFinite(q) || q < 1) return 1;
  if (q > MAX_BATCHES_PER_KIT_LINE) {
    log.warn('[brewpad] kit line quantity ' + q + ' exceeds cap ' + MAX_BATCHES_PER_KIT_LINE + ' — clamping');
    return MAX_BATCHES_PER_KIT_LINE;
  }
  return q;
}

/**
 * The authoritative kit registry: the SKUs on the "Kits" sheet (97 kits across 8
 * brands, with stock/pricing/batch sizes). The Zoho catalog cannot identify a kit —
 * every item has a blank category and product_type "goods" — so without this we can
 * only guess which lines on a ferment sale actually ferment.
 *
 * Held in module scope and refreshed in the background rather than fetched per sale:
 * createBatchesFromSale is fire-and-forget and must stay synchronous for its callers.
 * null = not loaded (or unavailable) — callers then fall back to the old behaviour.
 */
var _kitSkus = null;
var KIT_SKU_CACHE_KEY = 'brewpad:kit-skus';
var KIT_SKU_TTL = 3600;  // 1 hour

function _getKitSkus() { return _kitSkus; }
function _setKitSkus(set) { _kitSkus = set; }

/**
 * Load the Kits sheet SKUs into module scope. Called at startup and hourly.
 * Never throws — an unavailable registry degrades to the previous heuristic.
 *
 * @returns {Promise<Set|null>} the SKU set, or null when unavailable
 */
function refreshKitSkus() {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) return Promise.resolve(null);

  return axios.get(url, {
    params: { action: 'get_kits', server_token: token },
    timeout: 15000
  }).then(function (resp) {
    var data = resp.data || {};
    if (!data.ok) throw new Error(data.message || data.error || 'get_kits returned ok:false');

    var values = (data.data && data.data.values) || [];
    if (values.length < 2) throw new Error('Kits sheet returned no rows');

    var header = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    var skuCol = header.indexOf('sku');
    if (skuCol === -1) throw new Error('Kits sheet has no sku column');

    var set = new Set();
    for (var i = 1; i < values.length; i++) {
      var sku = String((values[i] || [])[skuCol] || '').trim();
      if (sku) set.add(sku);
    }
    if (set.size === 0) throw new Error('Kits sheet yielded no SKUs');

    _kitSkus = set;
    cache.set(KIT_SKU_CACHE_KEY, Array.from(set), KIT_SKU_TTL).catch(function () {});
    log.info('[brewpad] Kit registry loaded: ' + set.size + ' kit SKU(s)');
    return set;
  }).catch(function (err) {
    // Do NOT clear a previously-good registry on a transient failure.
    log.warn('[brewpad] Kit registry refresh failed (' + err.message +
      ') — kit detection falls back to the fee-cap heuristic');
    return _kitSkus;
  });
}

/**
 * Fermentation slots sold, taken from the Maker's Fee quantity.
 *
 * The catalog carries no marker distinguishing a kit from ordinary merchandise
 * (every item has a blank category and product_type "goods"), so the line items
 * alone cannot say which ones ferment. The Maker's Fee is charged once per
 * fermentation slot, which makes its quantity the authoritative batch count.
 *
 * Every real invoice carries it (verified back to INV-000001, Feb 2026: kit x3, fee x3).
 * A payload that omits it entirely is treated as unknown — see planKitBatches, which
 * then falls back to the pre-existing per-unit behaviour rather than guessing 1.
 *
 * @returns {number} slots sold; 0 when not a ferment-in-store sale; -1 when unknown
 */
function makersFeeSlots(lineItems) {
  var feeItem = checkoutHelpers.findMakersFeeItem(lineItems, process.env.MAKERS_FEE_ITEM_ID || '');
  if (!feeItem) return 0;
  if (feeItem.quantity === undefined || feeItem.quantity === null || feeItem.quantity === '') return -1;
  var q = Math.floor(Number(feeItem.quantity));
  if (!isFinite(q) || q < 1) return -1;  // unusable — fall back rather than under-create
  if (q > MAX_BATCHES_PER_KIT_LINE) {
    log.warn('[brewpad] makers fee quantity ' + q + ' exceeds cap ' + MAX_BATCHES_PER_KIT_LINE + ' — clamping');
    return MAX_BATCHES_PER_KIT_LINE;
  }
  return q;
}

/**
 * Expand a sale into the exact list of batches to create — one entry per batch.
 *
 * The Maker's Fee quantity caps the total, so merchandise on a ferment sale can
 * never inflate the batch count (INV-000067 sold 12 bottles beside one kit and
 * would otherwise have produced 13 batches).
 *
 * When the kit quantities already sum to the slots sold, every candidate line is a
 * real kit and all of them are used. When they exceed it, the sale mixes kits with
 * merchandise and the line data cannot tell them apart — we fill the slots from the
 * most expensive lines first (kits run $140–$230; merchandise is far cheaper) and
 * warn, so a mis-attributed batch is visible. Tagging kits with a Zoho item category
 * would make this exact.
 *
 * @returns {Array} one kit line item per batch to create
 */
function planKitBatches(lineItems) {
  var kits = detectKitItems(lineItems);
  if (kits.length === 0) return [];

  var slots = makersFeeSlots(lineItems);
  if (slots === 0) return [];  // no Maker's Fee = not a ferment-in-store sale

  // Narrow to lines the Kits sheet recognises. This is exact where the price heuristic
  // below could only guess — a $40 cider kit beside a $300 fermenter resolves correctly.
  //
  // Only ever NARROWS: if the registry recognises nothing on a genuine ferment sale
  // (a kit added to Zoho but not yet to the sheet), keep every candidate rather than
  // create zero batches. Silently losing a customer's batch is worse than mislabelling
  // one, and the fee-quantity cap still bounds the count either way.
  if (_kitSkus) {
    var known = kits.filter(function (item) {
      return _kitSkus.has(String(item.sku || '').trim()) ||
             _kitSkus.has(String(item.item_id || '').trim());
    });
    if (known.length > 0) {
      kits = known;
    } else {
      log.warn('[brewpad] Kit registry recognised none of the ' + kits.length +
        ' candidate line(s) on this ferment sale — keeping all of them. Is a new kit ' +
        'missing from the Kits sheet?');
    }
  }

  var totalKitQty = 0;
  kits.forEach(function (item) { totalKitQty += kitBatchQuantity(item); });

  // Fee quantity unusable (legacy payload): keep the pre-existing per-unit behaviour.
  if (slots < 0) slots = totalKitQty;

  var ordered = kits;
  if (totalKitQty !== slots) {
    log.warn('[brewpad] kit quantities (' + totalKitQty + ') do not match makers fee slots (' +
      slots + ') — sale likely mixes kits with merchandise; filling slots by highest unit price');
    // Stable sort: price descending, original line order breaks ties.
    ordered = kits.map(function (item, idx) { return { item: item, idx: idx }; })
      .sort(function (a, b) {
        var rateDiff = (Number(b.item.rate) || 0) - (Number(a.item.rate) || 0);
        return rateDiff !== 0 ? rateDiff : a.idx - b.idx;
      })
      .map(function (entry) { return entry.item; });
  }

  var units = [];
  for (var i = 0; i < ordered.length && units.length < slots; i++) {
    var qty = kitBatchQuantity(ordered[i]);
    for (var n = 0; n < qty && units.length < slots; n++) units.push(ordered[i]);
  }
  return units;
}

// Lazy so sheets-mode module load never pulls in the Postgres stack.
function batchStore() { return require('./batch-store'); }

/**
 * Call Apps Script to create a single batch.
 * Resolves to { ok: true/false } so callers can distinguish success from app-level error.
 *
 * @param {Object}  batchPayload   - { product_sku, product_name, customer_name, customer_id, source, zoho_so_number }
 * @param {boolean} skipRetryQueue - when true, do not auto-queue on failure (used by retry sweep)
 * @returns {Promise<{ok: boolean}>}
 */
function callAppsScriptCreateBatch(batchPayload, skipRetryQueue) {
  function handleData(data) {
    data = data || {};
    if (data.ok) {
      log.info('[brewpad] Batch created: batch_id=' + (data.batch_id || '?') + ' invoice=' + (batchPayload.zoho_so_number || '?'));
      eventLog.logEvent('kiosk.batch_created', {
        invoiceNumber: batchPayload.zoho_so_number || '',
        batchId: data.batch_id || ''
      });
      return { ok: true, batch_id: data.batch_id };
    }
    if (data.error === 'maintenance') {
      // D-04: invoice number only (no customer data); the retry queue below recovers it.
      log.warn('[brewpad] Batch create refused: maintenance invoice=' + (batchPayload.zoho_so_number || '?'));
    } else {
      log.warn('[brewpad] Apps Script returned error: ' + (data.message || data.error || JSON.stringify(data)));
    }
    if (!skipRetryQueue) {
      return queueForRetry(batchPayload, 'apps_script_error: ' + (data.error || 'unknown')).then(function () {
        return { ok: false };
      });
    }
    return { ok: false };
  }

  function viaAppsScript() {
    var url = process.env.APPS_SCRIPT_URL;
    var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) {
      log.warn('[brewpad] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured -- skipping batch creation');
      return Promise.resolve({ ok: false });
    }

    var payload = Object.assign({}, batchPayload, {
      action: 'create_batch',
      server_token: token
    });

    return axios.post(url, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      timeout: 12000,
      maxRedirects: 5
    }).then(function (resp) {
      return handleData(resp.data);
    });
  }

  function onError(err) {
    log.warn('[brewpad] Apps Script call failed (non-fatal): ' + err.message);
    if (!skipRetryQueue) {
      return queueForRetry(batchPayload, 'http_error: ' + err.message).then(function () {
        return { ok: false };
      });
    }
    return { ok: false };
  }

  // Sheets mode: issue the Apps Script call synchronously, exactly as before this seam existed.
  var store = batchStore();
  if (!store.isPostgres() && !store.isFrozen()) return viaAppsScript().catch(onError);

  // Postgres mode (or the freeze) answers here; null defensively falls back to Apps Script.
  return Promise.resolve().then(function () {
    return store.create(batchPayload, { actor: 'kiosk-middleware' });
  }).then(function (r) {
    if (r === null || r === undefined) return viaAppsScript();
    return handleData(r);
  }).catch(onError);
}

/**
 * Store a failed batch creation payload in Redis for later retry.
 * Per D-04: sale still succeeds; batch creation is eventually consistent.
 *
 * @param {Object} payload - the batch creation payload
 * @param {string} reason  - why it failed
 */
function queueForRetry(payload, reason) {
  var key = RETRY_PREFIX + Date.now() + '-' + (payload.zoho_so_number || 'unknown');
  var retryData = {
    payload: payload,
    attempts: 0,
    reason: reason,
    queued_at: new Date().toISOString()
  };

  eventLog.logEvent('kiosk.batch_retry_queued', {
    invoiceNumber: payload.zoho_so_number || '',
    reason: reason
  });

  return cache.set(key, retryData, RETRY_TTL);
}

/**
 * Main entry point: create batches from a completed kiosk sale.
 * Called fire-and-forget from pos.js sale/confirm and salesorder-pay handlers.
 *
 * Per D-02: only fires when Maker's Fee is present.
 * Per D-03: one batch per kit line item.
 * Per D-08: customer info from sale body.
 * Per D-09: no email stored.
 *
 * @param {Array}  lineItems    - sale line items
 * @param {string} invoiceNumber - Zoho invoice/SO number
 * @param {string} customerName  - from body.customer_name
 * @param {string} contactId     - from body.contact_id
 * @param {Object} catalogMap    - product catalog lookup (may be used for SKU enrichment)
 */
function createBatchesFromSale(lineItems, invoiceNumber, customerName, contactId, catalogMap, invoiceId, source, customerEmail) {
  var kitItems = detectKitItems(lineItems);
  if (kitItems.length === 0) return;

  var nameParts = splitCustomerName(customerName);

  // One entry per batch to create, bounded by the Maker's Fee quantity so merchandise
  // on the sale cannot inflate the count.
  var batchUnits = planKitBatches(lineItems);
  if (batchUnits.length === 0) return;

  log.info('[brewpad] Detected ' + kitItems.length + ' kit line(s) / ' + batchUnits.length +
    ' batch(es) for invoice=' + invoiceNumber + ' source=' + (source || 'kiosk'));

  // How many batches this sale expects per (invoice + SKU). The Apps Script dedup
  // guard keys on exactly that pair, so without this it admits the first unit of a
  // kit line and rejects the rest as duplicates — which is how INV-000137 sold three
  // kits and kept one batch. unit_total tells the guard how many are legitimate.
  var unitTotalBySku = {};
  batchUnits.forEach(function (item) {
    var sku = item.sku || item.item_id || '';
    unitTotalBySku[sku] = (unitTotalBySku[sku] || 0) + 1;
  });

  // Creates fire in parallel (as before); a single first-created batch id is captured
  // for the single-batch label.
  var creates = [];
  var firstBatchId = '';
  batchUnits.forEach(function (item) {
    var sku = item.sku || item.item_id || '';
    var batchPayload = {
      product_sku: sku,
      product_name: item.name || '',
      customer_name: customerName || 'Walk-in Customer',
      customer_firstname: nameParts.first || (customerName ? '' : 'Walk-in'),
      customer_lastname: nameParts.last || (customerName ? '' : 'Customer'),
      customer_id: contactId || '',
      source: source || 'kiosk',
      zoho_so_number: invoiceNumber || '',
      unit_total: unitTotalBySku[sku]
    };
    // Online orders carry the customer's order email — store it so staff can later
    // send the Cal.com bottling invite. Kiosk callers omit it (privacy, D-09).
    if (customerEmail) batchPayload.customer_email = customerEmail;

    creates.push(callAppsScriptCreateBatch(batchPayload).then(function (result) {
      if (result && result.ok) {
        if (!firstBatchId && result.batch_id) firstBatchId = result.batch_id;
        return true;
      }
      return false;
    }));
  });

  // Sync the invoice's Zoho batch-status field ONCE, after all creates settle —
  // a count when >1 (avoids per-batch last-write-wins overwrite), else the batch id.
  if (invoiceId) {
    Promise.all(creates).then(function (oks) {
      var okCount = oks.filter(Boolean).length;
      if (okCount > 0) {
        syncBatchToZoho(invoiceId, firstBatchId, 'pending', { count: okCount })
          .catch(function () {}); // fire-and-forget; errors already queued for retry
      }
    });
  }
}

/**
 * Retry sweep: scan Redis for pending batch creation keys and retry them.
 * Called by setInterval in server.js every 5 minutes.
 * Max 3 attempts per item; after that, log error and delete key.
 */
function retryPendingBatches() {
  if (!cache.isConnected()) return Promise.resolve();

  return cache.getClient().then(function (c) {
    if (!c) return;
    return c.keys(RETRY_PREFIX + '*');
  }).then(function (keys) {
    if (!keys || keys.length === 0) return;

    log.info('[brewpad] Retry sweep: found ' + keys.length + ' pending batch(es)');

    var chain = Promise.resolve();
    keys.forEach(function (key) {
      chain = chain.then(function () {
        return cache.get(key).then(function (retryData) {
          if (!retryData || !retryData.payload) {
            return cache.del(key);
          }

          retryData.attempts = (retryData.attempts || 0) + 1;

          if (retryData.attempts > MAX_RETRIES) {
            log.error('[brewpad] Max retries exceeded for key=' + key + ' invoice=' + (retryData.payload.zoho_so_number || '?') + ' -- removing from queue');
            eventLog.logEvent('kiosk.batch_retry_exhausted', {
              invoiceNumber: retryData.payload.zoho_so_number || '',
              attempts: retryData.attempts
            });
            return cache.del(key);
          }

          log.info('[brewpad] Retrying batch creation: attempt ' + retryData.attempts + '/' + MAX_RETRIES + ' key=' + key);

          return callAppsScriptCreateBatch(retryData.payload, true).then(function (result) {
            if (result && result.ok) {
              return cache.del(key);
            }
            // Apps Script returned error -- update attempt count and re-queue
            return cache.set(key, retryData, RETRY_TTL);
          }).catch(function () {
            return cache.set(key, retryData, RETRY_TTL);
          });
        });
      });
    });

    return chain;
  }).catch(function (err) {
    log.error('[brewpad] Retry sweep error: ' + err.message);
  });
}

/**
 * Format the cf_batch_status label server-side from a validated status + batch_id.
 * Shared by syncBatchToZoho and reconcileInvoiceBatchStatus so "the correct label for
 * this state" is computed exactly once — reconcile's idempotency check (skip the write
 * if the current label already equals the correct one) depends on both call sites
 * producing byte-identical strings.
 *
 * When one invoice has multiple live batches (a kit line with quantity > 1, or several
 * kit lines), show a count instead of a single batch id — otherwise each per-batch sync
 * would overwrite the field and only the last id would survive.
 *
 * @param {string} status  - one of ['pending', 'active', 'complete'] (already validated)
 * @param {string} batchId - batch ID (e.g. "SV-B-000123")
 * @param {number} [count] - number of live batches for this invoice; >1 switches to count form
 * @returns {string} e.g. "Active — SV-B-000123" or "Pending — 3 batches"
 */
function formatBatchStatusLabel(status, batchId, count) {
  var capitalized = status.charAt(0).toUpperCase() + status.slice(1);
  return (count && count > 1)
    ? capitalized + ' — ' + count + ' batches'
    : capitalized + ' — ' + batchId;
}

/**
 * Map a BrewPad sheet/batch status to the cf_batch_status vocabulary Zoho expects.
 * Unrecognized/missing statuses default to 'pending' — never silently skip a
 * re-sync just because an unfamiliar label was encountered.
 *
 * @param {string} status - raw batch.status from get_batches (e.g. 'primary', 'secondary')
 * @returns {string} one of ['pending', 'active', 'complete']
 */
function mapBatchStatusForZoho(status) {
  var s = String(status || '').trim().toLowerCase();
  if (s === 'active' || s === 'primary' || s === 'secondary') return 'active';
  if (s === 'complete' || s === 'bottled') return 'complete';
  return 'pending';
}

/**
 * Sync batch status to a Zoho invoice custom field.
 * Constructs the status label server-side from validated enum + batch_id.
 * Per T-07-01: status is validated against enum; label is not caller-supplied.
 * Per D-01: label format is "Active — SV-B-000123".
 *
 * @param {string} soId     - Zoho invoice ID or invoice number
 * @param {string} batchId  - batch ID (e.g. "SV-B-000123")
 * @param {string} status   - one of ['pending', 'active', 'complete']
 * @returns {Promise<{ok: boolean, skipped?: boolean, queued?: boolean}>}
 */
function syncBatchToZoho(soId, batchId, status, opts) {
  var skipQueue = opts && opts.skipQueue;
  var validStatuses = ['pending', 'active', 'complete'];
  if (validStatuses.indexOf(status) === -1) {
    return Promise.reject(new Error('Invalid status "' + status + '" — must be one of: ' + validStatuses.join(', ')));
  }

  var cfName = process.env.ZOHO_CF_BATCH_STATUS;
  if (!cfName) {
    log.warn('[batch/sync-zoho] ZOHO_CF_BATCH_STATUS not configured -- skipping');
    return Promise.resolve({ ok: true, skipped: true });
  }

  // When one invoice produced multiple batches (a kit line with quantity > 1, or
  // several kit lines), show a count instead of a single batch id — otherwise each
  // per-batch sync would overwrite the field and only the last id would survive.
  var count = opts && opts.count;
  var statusLabel = formatBatchStatusLabel(status, batchId, count);

  var payload = {
    custom_fields: [{ api_name: cfName, value: statusLabel }]
  };

  return zohoPut('/invoices/' + soId, payload)
    .then(function () {
      eventLog.logEvent('batch.zoho_sync_ok', { batchId: batchId, soId: soId, status: status });
      return { ok: true };
    })
    .catch(function (err) {
      var msg = err.response && err.response.data
        ? (err.response.data.message || err.response.data.error || err.message)
        : err.message;
      log.error('[batch/sync-zoho] Zoho error syncing batchId=' + batchId + ' soId=' + soId + ': ' + msg);
      if (skipQueue) {
        return { ok: false, error: msg };
      }
      return queueSyncForRetry({ so_id: soId, batch_id: batchId, status: status, count: count }, msg).then(function () {
        return { ok: false, queued: true };
      });
    });
}

/**
 * Store a failed Zoho sync payload in Redis for later retry.
 * Mirrors queueForRetry; uses BATCH_SYNC_RETRY_PREFIX.
 *
 * @param {Object} payload - { so_id, batch_id, status }
 * @param {string} reason  - why it failed
 */
function queueSyncForRetry(payload, reason) {
  var key = SYNC_RETRY_PREFIX + Date.now() + '-' + (payload.batch_id || 'unknown');
  var retryData = {
    payload: payload,
    attempts: 0,
    reason: reason,
    queued_at: new Date().toISOString()
  };

  eventLog.logEvent('batch.zoho_sync_retry_queued', {
    batchId: payload.batch_id || '',
    reason: reason
  });

  return cache.set(key, retryData, SYNC_RETRY_TTL);
}

/**
 * Retry sweep: scan Redis for pending Zoho sync keys and retry them.
 * Called by setInterval in server.js every 5 minutes (alongside retryPendingBatches).
 * Max SYNC_MAX_RETRIES (3) attempts per item; after that, log error and delete key.
 */
function retrySyncQueue() {
  if (!cache.isConnected()) return Promise.resolve();

  return cache.getClient().then(function (c) {
    if (!c) return;
    return c.keys(SYNC_RETRY_PREFIX + '*');
  }).then(function (keys) {
    if (!keys || keys.length === 0) return;

    log.info('[brewpad] Zoho sync retry sweep: found ' + keys.length + ' pending sync(s)');

    var chain = Promise.resolve();
    keys.forEach(function (key) {
      chain = chain.then(function () {
        return cache.get(key).then(function (retryData) {
          if (!retryData || !retryData.payload) {
            return cache.del(key);
          }

          retryData.attempts = (retryData.attempts || 0) + 1;

          if (retryData.attempts > SYNC_MAX_RETRIES) {
            log.error('[brewpad] Max Zoho sync retries exceeded for key=' + key + ' batchId=' + (retryData.payload.batch_id || '?') + ' -- removing from queue');
            eventLog.logEvent('batch.zoho_sync_retry_exhausted', {
              batchId: retryData.payload.batch_id || '',
              attempts: retryData.attempts
            });
            return cache.del(key);
          }

          log.info('[brewpad] Retrying Zoho sync: attempt ' + retryData.attempts + '/' + SYNC_MAX_RETRIES + ' key=' + key);

          return syncBatchToZoho(retryData.payload.so_id, retryData.payload.batch_id, retryData.payload.status, { skipQueue: true, count: retryData.payload.count }).then(function (result) {
            if (result && result.ok) {
              return cache.del(key);
            }
            return cache.set(key, retryData, SYNC_RETRY_TTL);
          }).catch(function () {
            return cache.set(key, retryData, SYNC_RETRY_TTL);
          });
        });
      });
    });

    return chain;
  }).catch(function (err) {
    log.error('[brewpad] Zoho sync retry sweep error: ' + err.message);
  });
}

/**
 * Clear an invoice's cf_batch_status field (value: '').
 * Used when NO live batches remain for the invoice (the INV-000151 bug: the batch was
 * deleted but the invoice still named it).
 *
 * @param {string} invoiceId - Zoho invoice ID
 * @returns {Promise<{ok: boolean, skipped?: boolean, error?: string}>}
 */
function clearInvoiceBatchStatus(invoiceId) {
  var cfName = process.env.ZOHO_CF_BATCH_STATUS;
  if (!cfName) {
    log.warn('[batch/reconcile] ZOHO_CF_BATCH_STATUS not configured -- skipping clear');
    return Promise.resolve({ ok: true, skipped: true });
  }

  var payload = { custom_fields: [{ api_name: cfName, value: '' }] };

  return zohoPut('/invoices/' + invoiceId, payload)
    .then(function () {
      eventLog.logEvent('batch.zoho_status_cleared', { invoiceId: invoiceId });
      return { ok: true };
    })
    .catch(function (err) {
      var msg = err.response && err.response.data
        ? (err.response.data.message || err.response.data.error || err.message)
        : err.message;
      log.error('[batch/reconcile] Zoho error clearing cf_batch_status invoiceId=' + invoiceId + ': ' + msg);
      return { ok: false, error: msg };
    });
}

/**
 * Resolve a human invoice number (e.g. "INV-000151") to its Zoho invoice list-record.
 * The list endpoint already carries cf_batch_status at the top level (pos.js:2526-2529),
 * so no detail fetch is needed here.
 *
 * @param {string} soNumber - already validated to match /^INV-\d+$/ (case-insensitive)
 * @returns {Promise<Object|null>} the matching invoice record, or null if not found
 */
function resolveInvoiceByNumber(soNumber) {
  var wanted = String(soNumber || '').toUpperCase();
  return zohoGet('/invoices', { invoice_number: wanted }).then(function (data) {
    var docs = data.invoices || [];
    for (var i = 0; i < docs.length; i++) {
      if (String(docs[i].invoice_number || '').toUpperCase() === wanted) return docs[i];
    }
    return null;
  });
}

/**
 * Fetch the live batch set from Apps Script (get_batches, server_token) and index it by
 * invoice number — reuses the pos.js:2484-2497 dedup shape. NEVER throws; callers treat
 * a null return as "unknown" and must not act (a false-empty index would wrongly clear
 * every stale-looking invoice).
 *
 * @returns {Promise<Object|null>} { byInvoiceNumber: {invoice_number: [batch,...]}, liveBatchIds: Set<string> }, or null when unavailable
 */
function fetchLiveBatchIndex() {
  function indexOf(batches) {
    var byInvoiceNumber = {};
    var liveBatchIds = new Set();
    batches.forEach(function (b) {
      if (b.batch_id) liveBatchIds.add(String(b.batch_id));
      var num = b.zoho_so_number;
      if (!num) return;
      if (!byInvoiceNumber[num]) byInvoiceNumber[num] = [];
      byInvoiceNumber[num].push(b);
    });
    return { byInvoiceNumber: byInvoiceNumber, liveBatchIds: liveBatchIds };
  }

  function viaAppsScript() {
    var url = process.env.APPS_SCRIPT_URL;
    var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) {
      log.warn('[brewpad] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured -- reconcile cannot read the live batch set');
      return Promise.resolve(null);
    }

    return axios.get(url, {
      params: { action: 'get_batches', server_token: token, status: 'all' },
      timeout: 12000
    }).then(function (resp) {
      var data = resp.data || {};
      if (!data.ok) {
        log.warn('[brewpad] get_batches (reconcile) returned ok:false -- treating live batch set as unavailable');
        return null;
      }
      return indexOf((data.data && data.data.batches) || []);
    });
  }

  function onError(err) {
    log.warn('[brewpad] get_batches (reconcile) call failed: ' + err.message);
    return null;
  }

  var store = batchStore();
  if (!store.isPostgres()) return viaAppsScript().catch(onError);

  return Promise.resolve().then(function () {
    return store.listAll();
  }).then(function (rows) {
    if (rows === null || rows === undefined) return viaAppsScript();
    if (!Array.isArray(rows)) {
      log.warn('[brewpad] batch store listAll (reconcile) returned an unexpected shape -- treating live batch set as unavailable');
      return null;
    }
    return indexOf(rows);
  }).catch(onError);
}

/**
 * Reconcile ONE invoice's cf_batch_status against the live batch set.
 *
 * Core rule (unified — never parses the existing label; counts live batches instead):
 * count batches in liveBatchIndex.byInvoiceNumber for invoice.invoice_number.
 *   0 remaining  -> CLEAR (the INV-000151 bug: the invoice still names a deleted batch)
 *   >=1 remaining -> re-sync to the correct label for the surviving set (a count when
 *                    >1, else the surviving batch id) via syncBatchToZoho
 * Idempotent: a no-op when the invoice's current label already matches the correct one.
 * NEVER writes when opts.dryRun is true — reports what it WOULD do instead, so the
 * cleanup route's dry-run and live-apply share exactly one decision path (no drift).
 *
 * @param {Object} invoice - { invoice_id, invoice_number, cf_batch_status } (current label)
 * @param {Object} liveBatchIndex - result of fetchLiveBatchIndex() (must be non-null)
 * @param {Object} [opts] - { dryRun: boolean }
 * @returns {Promise<{ok: boolean, action: string, old: string, new: string}>}
 *   action is one of 'unchanged' | 'cleared' | 'resynced' | 'would_clear' | 'would_resync' | 'error'
 */
function reconcileInvoiceBatchStatus(invoice, liveBatchIndex, opts) {
  var dryRun = !!(opts && opts.dryRun);
  var currentLabel = (invoice && invoice.cf_batch_status) || '';
  var byInvoiceNumber = (liveBatchIndex && liveBatchIndex.byInvoiceNumber) || {};
  var remaining = byInvoiceNumber[invoice && invoice.invoice_number] || [];

  if (remaining.length === 0) {
    if (!currentLabel) {
      return Promise.resolve({ ok: true, action: 'unchanged', old: currentLabel, new: currentLabel });
    }
    if (dryRun) {
      return Promise.resolve({ ok: true, action: 'would_clear', old: currentLabel, new: '' });
    }
    return clearInvoiceBatchStatus(invoice.invoice_id).then(function (result) {
      return {
        ok: !!(result && result.ok),
        action: (result && result.ok) ? 'cleared' : 'error',
        old: currentLabel,
        new: ''
      };
    });
  }

  var first = remaining[0];
  var mappedStatus = mapBatchStatusForZoho(first.status);
  var expectedLabel = formatBatchStatusLabel(mappedStatus, first.batch_id, remaining.length);

  if (currentLabel === expectedLabel) {
    return Promise.resolve({ ok: true, action: 'unchanged', old: currentLabel, new: currentLabel });
  }

  if (dryRun) {
    return Promise.resolve({ ok: true, action: 'would_resync', old: currentLabel, new: expectedLabel });
  }

  return syncBatchToZoho(invoice.invoice_id, first.batch_id, mappedStatus,
    { count: remaining.length, skipQueue: true }).then(function (result) {
    return {
      ok: !!(result && result.ok),
      action: (result && result.ok) ? 'resynced' : 'error',
      old: currentLabel,
      new: expectedLabel
    };
  });
}

/**
 * Create a single batch from a recipe sale.
 * Separate code path from detectKitItems/createBatchesFromSale per D-10.
 * Creates exactly ONE batch regardless of the number of ingredient line items.
 * Fire-and-forget per D-12 — failure is silent; staff can create batch manually.
 *
 * @param {string} recipeId        - recipe ID (e.g. "RCP-0001")
 * @param {Object} recipeSnapshot  - recipe object at time of sale (name, style, ingredients, etc.)
 * @param {string} invoiceNumber   - Zoho invoice number
 * @param {string} customerName    - full customer name (or empty for walk-in)
 * @param {string} contactId       - Zoho contact ID (or empty for walk-in)
 */
function detectRecipeSale(recipeId, recipeSnapshot, invoiceNumber, customerName, contactId) {
  if (!recipeId) return;
  var nameParts = splitCustomerName(customerName);
  var batchPayload = {
    product_sku:        recipeId,
    product_name:       (recipeSnapshot && recipeSnapshot.name) || recipeId,
    customer_name:      customerName || 'Walk-in Customer',
    customer_firstname: nameParts.first || (customerName ? '' : 'Walk-in'),
    customer_lastname:  nameParts.last  || (customerName ? '' : 'Customer'),
    customer_id:        contactId || '',
    source:             'kiosk_recipe',
    zoho_so_number:     invoiceNumber || '',
    recipe_id:          recipeId,
    recipe_snapshot:    JSON.stringify(recipeSnapshot || {}),
    target_volume_l:    (recipeSnapshot && recipeSnapshot.target_volume_l) || null,
    scale_factor:       (recipeSnapshot && recipeSnapshot.scale_factor) || null
  };
  callAppsScriptCreateBatch(batchPayload).catch(function () {});
}

module.exports = {
  createBatchesFromSale: createBatchesFromSale,
  retryPendingBatches: retryPendingBatches,
  detectKitItems: detectKitItems,
  kitBatchQuantity: kitBatchQuantity,
  makersFeeSlots: makersFeeSlots,
  planKitBatches: planKitBatches,
  refreshKitSkus: refreshKitSkus,
  _getKitSkus: _getKitSkus,
  _setKitSkus: _setKitSkus,
  callAppsScriptCreateBatch: callAppsScriptCreateBatch,
  splitCustomerName: splitCustomerName,
  syncBatchToZoho: syncBatchToZoho,
  formatBatchStatusLabel: formatBatchStatusLabel,
  mapBatchStatusForZoho: mapBatchStatusForZoho,
  clearInvoiceBatchStatus: clearInvoiceBatchStatus,
  resolveInvoiceByNumber: resolveInvoiceByNumber,
  fetchLiveBatchIndex: fetchLiveBatchIndex,
  reconcileInvoiceBatchStatus: reconcileInvoiceBatchStatus,
  queueSyncForRetry: queueSyncForRetry,
  retrySyncQueue: retrySyncQueue,
  detectRecipeSale: detectRecipeSale
};

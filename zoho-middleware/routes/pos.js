var express = require('express');
var axios = require('axios');
var helcimLib = require('../lib/helcim');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
var authTiers = require('../lib/authTiers');
var mailer = require('../lib/mailer');
var ledger = require('../lib/inventory-ledger');
var C = require('../lib/constants');
var brewpadIntegration = require('../lib/brewpad-integration');
var discountMatch = require('../lib/discount-match');
var buildContactPayload = require('../lib/checkout-helpers').buildContactPayload;
var moneyPath = require('../lib/money-path');
var captureExceptionSafe = require('../lib/sentry-capture').captureExceptionSafe;
// 57-04: reuse routes/catalog.js's rebuildKioskCatalog() for the sale-time
// auto-reconcile (bounded one-shot rebuild on a catalog-miss). No require
// cycle — catalog.js never requires pos.js.
var catalogRoutes = require('./catalog');

var zohoGet = zohoApi.zohoGet;
var zohoPost = zohoApi.zohoPost;
var zohoPut = zohoApi.zohoPut;

var KIOSK_PRODUCTS_CACHE_KEY = C.CACHE_KEYS.KIOSK_PRODUCTS;
var RECENT_ORDERS_CACHE_KEY = C.CACHE_KEYS.RECENT_ORDERS;
var RECENT_ORDERS_CACHE_TTL = 60; // seconds
var IDEMPOTENCY_KEY_TTL = 300; // 5 minutes in seconds
// D-13: pending-charge records live 7 days so the reconciliation backstop (45-08) can find them.
var KIOSK_PENDING_CHARGE_TTL = 604800;
// 68-02: cancel-safety flag TTL — covers the client poll window (POLL_TIMEOUT_MS,
// kiosk-core.js, 45s) plus webhook-delivery margin. 10 minutes is comfortably
// longer than any realistic terminal-result delay.
var KIOSK_CANCELLED_TTL = 600;

var crypto = require('crypto');

var _TAX_RULE_PCT = {};
_TAX_RULE_PCT[process.env.ZOHO_TAX_STANDARD_RULE || '109900000000033423'] = 12;
_TAX_RULE_PCT[process.env.ZOHO_TAX_ZERO_RULE     || '109900000000033411'] = 0;
_TAX_RULE_PCT[process.env.ZOHO_TAX_SERVICES_RULE || '109900000000033417'] = 5;
_TAX_RULE_PCT[process.env.ZOHO_TAX_LIQUOR_RULE   || '109900000000033429'] = 15;

var router = express.Router();

// Resolve the 5% GST tax_id needed for taxable custom lines (D-02).
// Resolution order: (1) process.env.KIOSK_GST_TAX_ID; (2) auto-discover from
// KIOSK_PRODUCTS_CACHE_KEY catalog — find an item whose sales_tax_rule_id ===
// ZOHO_TAX_SERVICES_RULE and reuse its tax_id; (3) return null (caller fail-closes).
function resolveGstTaxId(catalogMap) {
  if (process.env.KIOSK_GST_TAX_ID) return process.env.KIOSK_GST_TAX_ID;
  var serviceRule = process.env.ZOHO_TAX_SERVICES_RULE || '109900000000033417';
  var ids = Object.keys(catalogMap || {});
  for (var i = 0; i < ids.length; i++) {
    var item = catalogMap[ids[i]];
    if (item && item.sales_tax_rule_id === serviceRule && item.tax_id) {
      return item.tax_id;
    }
  }
  return null;
}

// Phase 67 review fix (CR-01): allocate a fixed discount across the matched
// lines EXACTLY the way the kiosk client does (kiosk-core.js
// kioskCalcTotals): proportional per-line shares rounded to cents, with the
// LAST matched line absorbing the rounding remainder so the total discount
// equals the preset value to the cent. The previous independent per-line
// Math.round (no remainder correction) let the server's effective discount
// drift from the preset value by several cents, which the pre-charge
// client_grand_total assertion then deterministically false-rejected.
function allocateFixedDiscount(targetLines, matchedSubtotal, fixedAmount) {
  var remaining = fixedAmount;
  targetLines.forEach(function (li, k) {
    var lineTotal = li.quantity * li.rate;
    var share;
    if (k === targetLines.length - 1) {
      share = remaining; // last matched line absorbs the rounding remainder
    } else {
      share = matchedSubtotal > 0 ? Math.round(fixedAmount * (lineTotal / matchedSubtotal) * 100) / 100 : 0;
      remaining = Math.round((remaining - share) * 100) / 100;
    }
    if (share > lineTotal) share = lineTotal; // never drive a line negative
    li.discount = share;
  });
}

// Phase 67 review fix (CR-01): a line's discounted total, using the SAME
// per-line rounding methodology as the kiosk client (kioskCalcTotals):
// percentage discounts are rounded to cents PER LINE (kioskR2(lt * pct/100))
// before subtracting; fixed discounts arrive as already-rounded per-line
// amounts. The previous code subtracted the UNROUNDED percentage
// (lt * (1 - pct/100)) and rounded only the final sum, accumulating ~half a
// cent of client/server drift per line — enough to deterministically trip
// the $0.01 pre-charge assertion on ordinary discounted carts.
function discountedLineTotal(li) {
  var lt = li.quantity * li.rate;
  if (li.discount) {
    if (typeof li.discount === 'string' && li.discount.indexOf('%') !== -1) {
      lt = lt - Math.round(lt * parseFloat(li.discount) / 100 * 100) / 100;
    } else {
      lt = lt - Number(li.discount);
    }
  }
  return Math.max(lt, 0);
}

// Resolve and apply a discount preset to lineItems.
// Returns a promise that resolves to { discountApplied, subtotal } or
// { error, status } if validation fails. Resolves to null if no discount.
//
// scope 'cart' → applies to every line. scope 'type' → applies only to lines
// whose product type (classified server-side via catalogMap) matches the
// preset's applies_to tokens. Legacy 'item' scope is no longer supported.
//
// Phase 67 review fix (CR-01): all discount math here mirrors the kiosk
// client's rounding methodology exactly (see allocateFixedDiscount /
// discountedLineTotal above) so the displayed total and the charged total
// agree to the cent and the pre-charge assertion's $0.01 tolerance stays
// honest.
function resolveDiscount(body, lineItems, subtotal, catalogMap) {
  if (!body.discount || !body.discount.preset_id) return Promise.resolve(null);
  catalogMap = catalogMap || {};

  return cache.get(C.CACHE_KEYS.KIOSK_DISCOUNT_PRESETS).then(function (presets) {
    presets = Array.isArray(presets) ? presets : [];
    var preset = null;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === body.discount.preset_id) { preset = presets[i]; break; }
    }
    if (!preset) return { error: 'Discount preset not found', status: 400 };
    if (!preset.active) return { error: 'Discount preset is inactive', status: 400 };

    var discountApplied = null;

    if (preset.scope === 'cart') {
      if (preset.type === 'percentage') {
        lineItems.forEach(function (li) {
          if (li.custom || li.gift_cert) return; // D-08: custom/gift_cert lines excluded from all discounts
          li.discount = preset.value + '%';
        });
        discountApplied = { preset_id: preset.id, name: preset.name, type: 'percentage', value: preset.value, scope: 'cart' };
      } else {
        // CR-01: cap and allocate over the DISCOUNTABLE subtotal only —
        // custom/gift_cert lines are excluded from both the cap and the
        // proportional denominator, mirroring the client's matchedSubtotal.
        var cartTargets = lineItems.filter(function (li) {
          return !li.custom && !li.gift_cert; // D-08: custom/gift_cert lines excluded from all discounts
        });
        var cartMatchedSubtotal = 0;
        cartTargets.forEach(function (li) { cartMatchedSubtotal += li.quantity * li.rate; });
        cartMatchedSubtotal = Math.round(cartMatchedSubtotal * 100) / 100;
        var fixedAmount = Math.min(preset.value, cartMatchedSubtotal);
        allocateFixedDiscount(cartTargets, cartMatchedSubtotal, fixedAmount);
        discountApplied = { preset_id: preset.id, name: preset.name, type: 'fixed', value: fixedAmount, scope: 'cart' };
      }
    } else if (preset.scope === 'type') {
      // Classify each line via the authoritative catalog and discount only matches.
      var matchedSubtotal = 0;
      var matchFlags = lineItems.map(function (li) {
        if (li.custom || li.gift_cert) return false; // D-08: custom/gift_cert lines excluded from all discounts
        var tokens = discountMatch.classifyCatalogItem(catalogMap[li.item_id]);
        var m = discountMatch.matches(tokens, preset.applies_to);
        if (m) matchedSubtotal += li.quantity * li.rate;
        return m;
      });
      matchedSubtotal = Math.round(matchedSubtotal * 100) / 100;

      if (preset.type === 'percentage') {
        lineItems.forEach(function (li, idx) {
          if (matchFlags[idx]) li.discount = preset.value + '%';
        });
        discountApplied = { preset_id: preset.id, name: preset.name, type: 'percentage', value: preset.value, scope: 'type', applies_to: preset.applies_to };
      } else {
        var fixedType = Math.min(preset.value, matchedSubtotal);
        // CR-01: last-matched-line remainder allocation (mirror the client).
        var typeTargets = lineItems.filter(function (li, idx) { return matchFlags[idx]; });
        allocateFixedDiscount(typeTargets, matchedSubtotal, fixedType);
        discountApplied = { preset_id: preset.id, name: preset.name, type: 'fixed', value: fixedType, scope: 'type', applies_to: preset.applies_to };
      }
    } else {
      return { error: 'Unsupported discount scope — please recreate this preset', status: 400 };
    }

    var newSubtotal = 0;
    lineItems.forEach(function (li) {
      // CR-01: per-line rounded discount methodology (mirrors the client).
      newSubtotal += discountedLineTotal(li);
    });
    return { discountApplied: discountApplied, subtotal: Math.round(newSubtotal * 100) / 100 };
  });
}

// Compute per-line-item tax total, respecting discounts already on lineItems.
//
// Phase 67 (KIOSK-TAX-QUOTE-01): returns a DISCRIMINATED result (mirrors the
// CR-02 gcRealBalanceLookup idiom) instead of a bare number:
//   { taxTotal: <number> }                        — every line resolved
//   { error: '<message naming the item>', itemName } — a CATALOG line has no
//     resolvable tax (no tax_percentage, no matching sales_tax_rule_id, and
//     no tax_id) — this repo's money-path fail-closed doctrine (Phase 52)
//     applies: never guess a tax rate, fail the sale closed and name the
//     item so staff can fix the catalog data.
// A resolved 0% (explicit tax_percentage: 0, a real zero-rate rule, or a
// tax_id-tagged line with no rule match) is NOT an error — only a value that
// is still NaN after both lookups AND has no tax_id is unresolved.
function computeTax(lineItems, catalogMap) {
  var taxTotal = 0;
  var unresolved = null;
  lineItems.forEach(function (li) {
    if (unresolved) return; // short-circuit once an unresolved line is found
    // Gift cert lines are zero-tax (D-03) — item's own EXEMPT setting; no catalog lookup.
    if (li.gift_cert) { return; }
    // Custom lines carry their own tax_percentage (5 or 0) — skip catalog lookup.
    // CR-01: discountedLineTotal applies the client-mirrored per-line
    // discount rounding, so the tax base matches the kiosk's to the cent.
    if (li.custom) {
      taxTotal += discountedLineTotal(li) * ((li.tax_percentage || 0) / 100);
      return;
    }
    var catalogItem = catalogMap[li.item_id];
    var lineTotal = discountedLineTotal(li);
    // NaN-preserving: a missing/undefined tax_percentage stays NaN (distinct
    // from a legitimate explicit 0) so the unresolved check below can fire.
    var pct = parseFloat(catalogItem.tax_percentage);
    if (catalogItem.sales_tax_rule_id && _TAX_RULE_PCT[catalogItem.sales_tax_rule_id] !== undefined) {
      pct = _TAX_RULE_PCT[catalogItem.sales_tax_rule_id];
    } else if (isNaN(pct) && !catalogItem.tax_id) {
      // Unresolved: no catalog tax_percentage, no matching rule, no tax_id
      // to let Zoho resolve it either — fail closed, never guess.
      var itemName = catalogItem.name || li.name || li.sku || li.item_id;
      unresolved = { error: 'Cannot determine tax for "' + itemName + '" — no tax rate configured for this item. Refresh the product list or fix the item in Zoho.', itemName: itemName };
      return;
    }
    // Every remaining path resolves to a real number (incl. tax_id-present
    // NaN, which computes as 0% — unchanged Zoho-side tax_id tagging).
    taxTotal += lineTotal * ((isNaN(pct) ? 0 : pct) / 100);
  });
  if (unresolved) return unresolved;
  return { taxTotal: Math.round(taxTotal * 100) / 100 };
}

function isConsignmentItem(catalogItem) {
  if (!catalogItem) return false;
  if ((catalogItem.cf_type || '').toLowerCase() === 'consignment') return true;
  var fields = catalogItem.custom_fields || [];
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].label === 'Type' && (fields[i].value || '').toLowerCase() === 'consignment') return true;
  }
  return false;
}

function extractConsignmentInfo(catalogItem) {
  if (!isConsignmentItem(catalogItem)) return null;
  var fields = catalogItem.custom_fields || [];
  var artisanName = '';
  var commissionRate = 0;
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].label === 'Artisan Name') artisanName = fields[i].value || '';
    if (fields[i].label === 'Commission Rate') commissionRate = parseFloat(fields[i].value) || 0;
  }
  if (!artisanName || !commissionRate) return null;
  return { artisan_name: artisanName, commission_rate: commissionRate };
}

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
 *   tax_total: 3.00,          // ignored — tax is computed server-side per catalog item
 *   client_grand_total: 89.60,  // OPTIONAL — the kiosk's own displayed grand total
 *   client_tax_total: 9.60,     // OPTIONAL — the kiosk's own displayed tax total
 *                               // (observability only: logged in the WR-05
 *                               // mismatch diagnostics, never asserted)
 *   reference_number: "KIOSK-001"  // optional reference for the invoice
 * }
 *
 * Note: client-supplied `rate` and `tax_total` are both ignored for all financial
 * calculations. Prices are anchored to the zoho:kiosk-products cache. Any item_id
 * not present in that cache causes an immediate 400 rejection.
 *
 * Tax (Phase 67, KIOSK-TAX-QUOTE-01): per-item tax is resolved from the catalog
 * (tax_percentage / sales_tax_rule_id / tax_id) — there is no KIOSK_TAX_RATE
 * default fallback. A catalog item with no resolvable tax fails the sale
 * closed with a 400 naming the item (never a silent guess); a legitimate
 * resolved 0% still sells. See computeTax().
 *
 * Pre-charge assertion (Phase 67, KIOSK-TAX-QUOTE-01): client totals are never
 * TRUSTED for pricing (server-computed totals remain the sole source of
 * financial truth — price anchoring above is unchanged) but `client_grand_total`
 * IS ASSERTED against the server-computed grandTotal before any Helcim charge.
 * Both fields are optional; the assertion is skipped when client_grand_total is
 * absent or not a finite number (back-compat with old cached kiosk JS). On a
 * mismatch beyond $0.01, the sale is rejected 400 with no charge and the
 * idempotency lock is released so a corrected re-ring can retry. See
 * processSaleWithPrices().
 */
router.post('/api/kiosk/sale', function (req, res) {
  var body = req.body;

  // 70-01: tender allow-list — 'terminal' (default) / 'cash' / 'moto'. An
  // unknown value is rejected before any Helcim capability check or booking.
  var tender = (body && typeof body.tender === 'string' && body.tender) ? body.tender : 'terminal';
  if (tender !== 'terminal' && tender !== 'cash' && tender !== 'moto') {
    return res.status(400).json({ error: 'Invalid tender type' });
  }

  // 70-01: the terminal capability guard applies ONLY to the terminal tender —
  // cash (and moto, once built) need no Helcim device configuration at all.
  if (tender === 'terminal' && !helcimLib.isTerminalEnabled()) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  // 70-02: MOTO (phone-order, card-not-present via HelcimPay) only needs the
  // Helcim API token — NOT the physical terminal's device code. isEnabled()
  // (API-token-only) is the correct capability gate here, not
  // isTerminalEnabled() (API token AND device code).
  if (tender === 'moto' && !helcimLib.isEnabled()) {
    return res.status(503).json({ error: 'Card payments not configured' });
  }

  // 68-01: request-start stamp for per-stage timing telemetry (observation
  // only — see emitStageTiming). Captured before the idempotency lock so the
  // lock-acquired stage timing reflects real wall-time from request receipt.
  var stageStart = Date.now();

  // D-12: idempotency_key is required in production (fail-closed-in-prod pattern);
  // falls through to non-atomic flow without a key in non-prod for backward compat.
  var idempotencyKey = (body && typeof body.idempotency_key === 'string' && body.idempotency_key)
    ? C.CACHE_KEYS.KIOSK_IDEM_PREFIX + body.idempotency_key.slice(0, 128)
    : null;

  if (!idempotencyKey && process.env.NODE_ENV === 'production') {
    return res.status(400).json({ error: 'idempotency_key is required' });
  }

  if (idempotencyKey) {
    // D-12: atomic idempotency lock via shared money-path primitive (replaces non-atomic get-then-set)
    return moneyPath.acquireIdempotencyLock(cache, idempotencyKey, IDEMPOTENCY_KEY_TTL)
      .then(function (lockResult) {
        if (lockResult.status === 'replay') {
          log.info('[pos/kiosk/sale] Idempotent replay: ' + idempotencyKey);
          return res.status(201).json(lockResult.cached);
        }
        if (lockResult.status === 'contention' || lockResult.status === 'failclosed') {
          return res.status(409).json({ error: 'Sale already in progress — please wait and check your order before retrying' });
        }
        // status === 'acquired' — proceed
        emitStageTiming('lock_acquired', stageStart);
        processSale(body, idempotencyKey, req, res, stageStart);
      });
  }

  processSale(body, null, req, res, stageStart);
});

// 68-01: emit a per-stage timing event on the existing eventLog channel — the
// exact idiom already used for kiosk.total_mismatch (log.info THEN
// eventLog.logEvent). Observation-only: never called from inside a
// money-moving conditional, never changes control flow. NO PII (eventLog
// zero-PII policy) — stage name + millisecond delta + optional bounded extras.
function emitStageTiming(stage, stageStart, extra) {
  // WR-03: observation-only telemetry must NEVER break the money path. This is
  // invoked on the success path immediately before res.status(202).json(...);
  // if log.info or eventLog.logEvent ever threw, the rejection would prevent the
  // 202 from being sent and hang the client mid-sale. Swallow any throw here,
  // matching the client-side beacons' try/catch contract (kiosk-core.js).
  try {
    var ms = Date.now() - stageStart;
    var payload = { stage: stage, ms_since_start: ms };
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (k) { payload[k] = extra[k]; });
    }
    log.info('[pos/kiosk/sale] stage_timing stage=' + stage + ' ms_since_start=' + ms +
      (extra && extra.cache ? ' cache=' + extra.cache : ''));
    eventLog.logEvent('kiosk.sale_stage_timing', payload);
  } catch {
    // Telemetry failure is non-fatal — do not let it interfere with the sale.
  }
}

// Build an item_id -> catalog entry lookup from a kiosk products catalog array
// (57-04: shared by both the initial catalogMap build and the post-rebuild
// re-check so the two stay in lockstep).
function buildKioskCatalogMap(catalog) {
  var catalogMap = {};
  if (Array.isArray(catalog)) {
    catalog.forEach(function (p) {
      if (p && p.item_id) catalogMap[p.item_id] = p;
    });
  }
  return catalogMap;
}

// Return the item_id of the first non-custom, non-gift_cert cart line whose
// item_id is absent from catalogMap, or null if every line resolves. Custom
// and gift_cert lines bypass the catalog check — their rate is bounded
// server-side, not read from the catalog (57-04).
function findMissingCatalogItem(items, catalogMap) {
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.custom) continue;
    if (item.gift_cert) continue;
    if (catalogMap[item.item_id] === undefined) return item.item_id;
  }
  return null;
}

function processSale(body, idempotencyKey, req, res, stageStart) {
  // D-50-03 (50-03 / H4 / SC#2): mirrors the confirm-path hook above — release
  // the sale idempotency lock on EVERY failure return in processSale AND
  // processSaleWithPrices (same res object, so one hook here covers both).
  // As of plan 50-04 the kiosk client sends a STABLE idempotency key across a
  // double-tap; a keyed request that 400s on a pre-charge validation guard
  // (catalog miss, gift-card lookup 503, etc.) and is then legitimately
  // retried with the SAME key would otherwise hit contention -> 409 and
  // strand the sale. Never release on a path where a terminal charge may
  // have succeeded — statusCode >= 400 satisfies that: the successful
  // terminal-push path responds 202.
  if (idempotencyKey && res && typeof res.on === 'function') {
    res.on('finish', function () {
      if (res.statusCode >= 400 && !(res.locals && res.locals.__keepIdemLock)) {
        cache.releaseLock(idempotencyKey).catch(function () {});
      }
    });
  }
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
    if (vi.custom) {
      // Custom line validation (D-05, T-43-01)
      var vDesc = typeof vi.description === 'string' ? vi.description.trim() : '';
      if (vDesc.length < 1 || vDesc.length > 100) {
        return res.status(400).json({ error: 'Custom line description must be 1-100 characters for item ' + v });
      }
      var vRate = Number(vi.rate);
      if (!isFinite(vRate)) {
        return res.status(400).json({ error: 'Custom line rate must be a number for item ' + v });
      }
      if (Math.abs(vRate) > 10000) {
        return res.status(400).json({ error: 'Custom line rate exceeds maximum allowed magnitude ($10,000) for item ' + v });
      }
      var vQtyC = Number(vi.quantity);
      if (!isFinite(vQtyC) || !Number.isInteger(vQtyC) || vQtyC <= 0 || vQtyC > 100) {
        return res.status(400).json({ error: 'Custom line quantity must be an integer 1-100 for item ' + v });
      }
      continue;
    }
    if (vi.gift_cert) continue; // gift_cert lines have no catalog item_id; validated below
    if (!vi.item_id || typeof vi.item_id !== 'string' || vi.item_id.length > 64) {
      return res.status(400).json({ error: 'Invalid item_id for item ' + v });
    }
    var vQty = Number(vi.quantity);
    if (!isFinite(vQty) || vQty <= 0 || vQty > 100) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + v });
    }
  }

  // Item #1: Anchor prices to the server-side catalog cache.
  // Client-supplied rate values are ignored for all financial calculations.
  cache.get(KIOSK_PRODUCTS_CACHE_KEY).then(function (catalog) {
    // Build item_id → catalog entry lookup from the authoritative catalog
    var catalogMap = buildKioskCatalogMap(catalog);

    // Reject if any requested item is not in the catalog cache — UNLESS a
    // bounded, one-shot auto-reconcile (57-04, T-57-04-01/02) can self-heal
    // it first: the client's catalog may simply be STALE (the item is still
    // CURRENT in Zoho, just missing from our cache) rather than genuinely
    // invalid. Do not fall back to client-supplied rates in either case —
    // that would defeat the anchoring. Custom and gift_cert lines bypass
    // this check entirely — their rate is bounded server-side.
    var missingItemId = findMissingCatalogItem(body.items, catalogMap);
    if (missingItemId !== null) {
      // Bounded to ONE rebuild per sale attempt (T-57-04-02) — reuses the
      // exact same rebuild the manual `?bust=1` refresh triggers.
      return catalogRoutes.rebuildKioskCatalog().then(function (freshCatalog) {
        var rebuiltMap = buildKioskCatalogMap(freshCatalog);
        var stillMissingItemId = findMissingCatalogItem(body.items, rebuiltMap);
        if (stillMissingItemId !== null) {
          // Genuinely invalid/phantom item — absent even after rebuild.
          // Price-anchoring stays intact: still reject, client rate still ignored.
          return res.status(400).json({
            error: 'Item not found in current catalog: ' + stillMissingItemId +
              '. Refresh the product list and try again.'
          });
        }
        log.info('[pos/kiosk/sale] Auto-reconcile: catalog rebuild resolved stale-cache miss for ' + missingItemId);
        emitStageTiming('catalog_read', stageStart, { cache: 'rebuild' });
        return continueSaleWithCatalog(rebuiltMap);
      }, function (rebuildErr) {
        log.error('[pos/kiosk/sale] catalog auto-reconcile rebuild failed: ' +
          (rebuildErr && rebuildErr.message));
        return res.status(400).json({
          error: 'Item not found in current catalog: ' + missingItemId +
            '. Refresh the product list and try again.'
        });
      });
    }

    emitStageTiming('catalog_read', stageStart, { cache: 'hit' });
    return continueSaleWithCatalog(catalogMap);

    function continueSaleWithCatalog(catalogMap) {
      // Fail-closed guard: if any gift_cert line is present, KIOSK_GIFT_CARD_ITEM_ID must be set
      // (T-44-G4 — mirrors the issue route guard).
      if (body.items.some(function (i) { return i.gift_cert === true; }) &&
          !process.env.KIOSK_GIFT_CARD_ITEM_ID) {
        log.warn('[pos/kiosk/sale] gift_cert line rejected — KIOSK_GIFT_CARD_ITEM_ID not configured');
        return res.status(503).json({ error: 'Gift card accounting not configured (KIOSK_GIFT_CARD_ITEM_ID missing)' });
      }

      // Validate gift_cert line fields before building lineItems (cannot return inside .map).
      for (var gcv = 0; gcv < body.items.length; gcv++) {
        var gcItem = body.items[gcv];
        if (!gcItem.gift_cert) continue;
        var gcCertNum = String(gcItem.cert_number || '').trim().toUpperCase();
        if (!/^GC-\d{6}$/.test(gcCertNum)) {
          return res.status(400).json({ error: 'gift_cert cert_number must match GC-NNNNNN format (e.g. GC-000042)' });
        }
        var gcRate = Number(gcItem.rate);
        if (!isFinite(gcRate) || gcRate <= 0 || gcRate > 2000) {
          return res.status(400).json({ error: 'gift_cert rate must be between $0.01 and $2000' });
        }
      }

      // Pre-resolve GST tax_id for any taxable custom lines (D-02 fail-closed).
      // Must happen before the lineItems builder to avoid returning inside .map().
      var needGstTaxId = body.items.some(function (item) {
        return item.custom && item.taxable !== false;
      });
      var gstTaxId = null;
      if (needGstTaxId) {
        gstTaxId = resolveGstTaxId(catalogMap);
        if (!gstTaxId) {
          return res.status(400).json({
            error: 'Cannot tax this custom line: no GST tax rate configured. Mark the line tax-exempt or set KIOSK_GST_TAX_ID.'
          });
        }
      }

      // Build line items using catalog price, ignoring client-supplied rate
      // D-03: Include per-item tax_id from catalog so Zoho computes tax using its rules
      var subtotal = 0;
      var lineItems = body.items.map(function (item) {
        if (item.custom) {
          // Custom line: rate is staff-entered (bounded by validation above)
          var qty = Number(item.quantity) || 1;
          var rate = Number(item.rate);
          subtotal += qty * rate;
          var taxable = item.taxable !== false;
          var desc = String(item.description || '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
          var note = String(item.note || '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
          var fullDesc = note ? (desc + ' — ' + note) : desc;
          var li = {
            custom: true,
            description: fullDesc,
            rate: rate,
            quantity: qty,
            tax_percentage: taxable ? 5 : 0
          };
          if (taxable) {
            li.tax_id = gstTaxId;
          } else if (process.env.ZOHO_TAX_ZERO_ID) {
            // F3 (45-09): exempt custom lines have no backing Zoho item — tag with
            // the explicit Zero Rate tax so Zoho does not default-tax them. Mirrors
            // the confirm path; keeps /sale and the invoice in agreement.
            li.tax_id = process.env.ZOHO_TAX_ZERO_ID;
          }
          return li;
        }
        // Gift cert line (Phase 44-09): server-authoritative item_id, zero-tax (D-03, T-44-G1).
        // Client-supplied item_id is ignored; face value / reload amount validated above.
        if (item.gift_cert) {
          var gcCertNumSale = String(item.cert_number || '').trim().toUpperCase();
          var gcRateSale = Number(item.rate);
          var gcNameSale = item.gift_action === 'reload'
            ? 'Gift Certificate Reload ' + gcCertNumSale
            : 'Gift Certificate ' + gcCertNumSale;
          subtotal += gcRateSale;
          return {
            gift_cert: true,
            gift_action: item.gift_action || 'issue',
            cert_number: gcCertNumSale,
            item_id: process.env.KIOSK_GIFT_CARD_ITEM_ID, // server-authoritative (D-05)
            name: gcNameSale,
            quantity: 1,
            rate: gcRateSale
            // NO tax_id — item carries its own EXEMPT setting (D-03)
          };
        }
        var qty = Number(item.quantity) || 1;
        var catalogItem = catalogMap[item.item_id];
        var rate = catalogItem.rate; // authoritative price from catalog
        subtotal += qty * rate;
        var li = {
          item_id: item.item_id,
          name: item.name || '',
          sku: catalogItem.sku || '',
          quantity: qty,
          rate: rate
        };
        if (catalogItem.tax_id) {
          li.tax_id = catalogItem.tax_id;
        }
        return li;
      });
      subtotal = Math.round(subtotal * 100) / 100;

      // Apply discount (if any) before computing tax and terminal charge
      return resolveDiscount(body, lineItems, subtotal, catalogMap).then(function (discResult) {
        if (discResult && discResult.error) {
          return res.status(discResult.status).json({ error: discResult.error });
        }
        if (discResult) {
          subtotal = discResult.subtotal;
        }

        // Phase 67 (KIOSK-TAX-QUOTE-01): SALE path — no charge has been made
        // yet, so an early 400 is safe here (unlike the confirm path below,
        // which must void rather than bare-400 after a charge).
        var taxResult = computeTax(lineItems, catalogMap);
        if (taxResult.error) {
          return res.status(400).json({ error: taxResult.error });
        }
        var taxTotal = taxResult.taxTotal;
        var grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;

        processSaleWithPrices(body, idempotencyKey, req, res,
          lineItems, subtotal, taxTotal, grandTotal, stageStart);
      });
    }
  }).catch(function (cacheErr) {
    log.error('[pos/kiosk/sale] Catalog cache read failed: ' + cacheErr.message);
    res.status(503).json({ error: 'Unable to verify item prices. Please try again.' });
  });
}

function processSaleWithPrices(body, idempotencyKey, req, res,
  lineItems, subtotal, taxTotal, grandTotal, stageStart) {

  if (grandTotal <= 0) {
    return res.status(400).json({ error: 'Sale total must be greater than zero' });
  }
  if (grandTotal > 10000) {
    return res.status(400).json({ error: 'Sale total exceeds maximum' });
  }

  // --- Phase 67 (KIOSK-TAX-QUOTE-01): pre-charge total assertion ---
  // The kiosk client MAY send its own displayed grand total (client_grand_total).
  // Server-computed grandTotal (catalog-anchored) remains the ONLY source of
  // financial truth — this is a divergence DETECTOR, never a pricing input.
  // Only asserts when the field is present and a finite number (old cached
  // kiosk JS that omits it is unaffected — back-compat by design). On
  // mismatch beyond a cent-rounding tolerance ($0.01), reject BEFORE any
  // gift-card lookup or Helcim terminal charge and release the idempotency
  // lock (WR-03 shape) so a corrected re-ring can retry immediately.
  if (typeof body.client_grand_total === 'number' && isFinite(body.client_grand_total)) {
    if (Math.abs(body.client_grand_total - grandTotal) > 0.01) {
      // Phase 67 review fix (WR-05): record the divergence evidence BEFORE
      // discarding it — a divergence DETECTOR that logs nothing defeats its
      // diagnostic purpose (INV-000160 was only diagnosable because the
      // 57-01 beacon telemetry existed). client_tax_total is read here for
      // diagnostics only — it is never asserted and never prices anything.
      var mismatchDelta = Math.round((body.client_grand_total - grandTotal) * 100) / 100;
      log.error('[pos/kiosk/sale] pre-charge total mismatch: client_grand_total=' + body.client_grand_total +
        ' client_tax_total=' + body.client_tax_total +
        ' server_grand_total=' + grandTotal + ' server_tax_total=' + taxTotal +
        ' delta=' + mismatchDelta + ' items=' + lineItems.length +
        ' ref=' + (typeof body.reference_number === 'string' ? body.reference_number.slice(0, 64) : ''));
      eventLog.logEvent('kiosk.total_mismatch', {
        client_grand_total: body.client_grand_total,
        client_tax_total: (typeof body.client_tax_total === 'number' && isFinite(body.client_tax_total))
          ? body.client_tax_total : null,
        server_grand_total: grandTotal,
        server_tax_total: taxTotal,
        delta: mismatchDelta,
        item_count: lineItems.length,
        reference_number: (typeof body.reference_number === 'string') ? body.reference_number.slice(0, 64) : ''
      });
      if (idempotencyKey) {
        cache.releaseLock(idempotencyKey).catch(function () {});
      }
      return res.status(400).json({ error: 'Totals changed — refresh the product list and re-ring the sale.' });
    }
  }

  emitStageTiming('assertion_done', stageStart);

  // --- Gift card split-tender (Phase 44 / D-12 hardened in 45-07) ---
  // D-05: amount_applied is clamped to grandTotal server-side; client cannot over-apply.
  // D-03/R-03: tax is never recomputed — gift_amount subtracts only from post-tax grandTotal.
  // D-12 (45-07): gcApplied is further clamped to the certificate's REAL server-side balance
  //   via an Apps Script lookup BEFORE the terminal is charged.  Fails open: if the lookup
  //   is unavailable, the client-submitted (grandTotal-clamped) amount is used.
  var gift_amount_submitted = 0;
  var gift_cert_number = '';
  if (body.gift_card && body.gift_card.cert_number) {
    gift_amount_submitted = Math.min(
      Math.max(Number(body.gift_card.amount_applied) || 0, 0),
      grandTotal
    );
    gift_cert_number = String(body.gift_card.cert_number).trim().toUpperCase().slice(0, 20);
  }

  // CR-02 (45): look up real balance before charging the terminal.
  // Returns a discriminated result:
  //   { state: 'ok', balance: N } — cert valid, balance known; clamp applied amount
  //   { state: 'invalid' }        — Apps Script reports ok:false → hard reject (400)
  //   { state: 'unavailable' }    — network/timeout error → 503 in prod, fail-open in non-prod
  //   null                        — no lookup needed (no gift card or Apps Script not configured)
  var _gcAsUrl   = process.env.APPS_SCRIPT_URL;
  var _gcAsToken = process.env.APPS_SCRIPT_SERVER_TOKEN;
  var _gcLookupStart = Date.now(); // 68-01: only meaningful when a lookup actually runs below
  var gcRealBalanceLookup = Promise.resolve(null);
  if (gift_amount_submitted > 0 && gift_cert_number && _gcAsUrl && _gcAsToken) {
    gcRealBalanceLookup = Promise.resolve(
      axios.post(_gcAsUrl, JSON.stringify({
        action:       'lookup_gift_card',
        server_token: _gcAsToken,
        cert_number:  gift_cert_number
      }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
    )
    .then(function (resp) {
      var r = (resp && resp.data) || {};
      if (r.ok === true && r.data && typeof r.data.current_balance === 'number') {
        return { state: 'ok', balance: r.data.current_balance };
      }
      // Apps Script explicitly reported ok:false → cert invalid or not found
      if (r.ok === false) { return { state: 'invalid' }; }
      // ok:true but no balance data (Apps Script misconfigured or returned partial response)
      return { state: 'unavailable' };
    })
    .catch(function (lookupErr) {
      log.warn('[pos/kiosk/sale] gift-card balance lookup failed: ' + (lookupErr && lookupErr.message));
      return { state: 'unavailable' };
    });
  }

  return gcRealBalanceLookup.then(function (gcLookup) {
    // CR-02: discriminated result handling
    if (gcLookup !== null) {
      if (gcLookup.state === 'invalid') {
        return res.status(400).json({ error: 'Gift card not found or has insufficient balance' });
      }
      if (gcLookup.state === 'unavailable') {
        if (process.env.NODE_ENV === 'production') {
          return res.status(503).json({ error: 'Gift card validation temporarily unavailable' });
        }
        // non-prod: fail-open, use submitted amount
        log.warn('[pos/kiosk/sale] gift-card lookup unavailable (non-prod fail-open): cert=' + gift_cert_number);
      }
      // 68-01: only emitted when a real Apps Script lookup ran (up to a
      // 12s timeout) — the up-to-12s gc-lookup is one of the two prime
      // latency suspects alongside the cold-cache catalog rebuild.
      emitStageTiming('gc_lookup_done', stageStart, { gc_lookup_duration_ms: Date.now() - _gcLookupStart });
    }
    var gift_amount = gift_amount_submitted;
    if (gcLookup && gcLookup.state === 'ok' && gift_amount > gcLookup.balance) {
      log.warn('[pos/kiosk/sale] gcApplied clamped to realBalance: submitted=' + gift_amount +
        ' realBalance=' + gcLookup.balance + ' cert=' + gift_cert_number);
      gift_amount = Math.min(gcLookup.balance, grandTotal);
    }

  var terminal_amount = Math.round((grandTotal - gift_amount) * 100) / 100;

  var refNumber = (body.reference_number && typeof body.reference_number === 'string')
    ? body.reference_number.slice(0, 64)
    : ('KIOSK-' + Date.now());

  if (body.tender === 'cash') {
    // 70-01: cash tender — skip the terminal entirely (no Helcim call, no
    // KIOSK_PENDING_CHARGE_PREFIX write — that write lives only inside the
    // terminal_amount > 0 branch below and has nothing to reconcile for cash).
    // Mirrors the gift-card-100%-coverage "skip terminal, respond non-pending"
    // shape below, plus its idempotency cache.set write.
    log.info('[pos/kiosk/sale] Cash tender — skipping terminal. ref=' + refNumber +
      (gift_amount > 0 ? ' gift_card=$' + gift_amount.toFixed(2) : ''));

    var cashResponseBody = {
      pending: false,
      cash: true,
      reference: refNumber
    };

    var cashCacheWrite = idempotencyKey
      ? cache.set(idempotencyKey, cashResponseBody, IDEMPOTENCY_KEY_TTL).catch(function () {})
      : Promise.resolve();

    return cashCacheWrite.then(function () {
      emitStageTiming('response_202', stageStart);
      res.status(202).json(cashResponseBody);
    });
  } else if (body.tender === 'moto') {
    // 70-02: MOTO (phone-order, card-not-present) — initialize a HelcimPay.js
    // hosted-iframe session IN-PROCESS (helcimLib already required above; no
    // extra HTTP hop through routes/payments.js) instead of pushing to the
    // physical terminal.
    //
    // WR-01 (70-review): the actual card capture happens inside the iframe on
    // the client, and booking only occurs on a SEPARATE /confirm round-trip. If
    // the network drops (or the iPad sleeps) between the HelcimPay SUCCESS
    // postMessage and a completed /confirm, the card is charged but no invoice
    // exists and no void fires. "Same browser tab" is not a guarantee against a
    // dropped confirm. So — like the terminal branch — persist a pending-charge
    // record keyed by refNumber. The 45-08 reconcile sweep is tender-agnostic:
    // an un-cleared pending record with no matching terminal-result cache is
    // flagged as a potential orphan for manual review. A successful /confirm
    // clears this record tender-agnostically (by reference_number), so the
    // backstop only fires on a genuinely dropped confirm.
    log.info('[pos/kiosk/sale] MOTO (phone-order) tender — initializing HelcimPay. ref=' + refNumber +
      (gift_amount > 0 ? ' gift_card=$' + gift_amount.toFixed(2) : ''));

    return helcimLib.initializeCheckout(terminal_amount, 'CAD')
      .then(function (checkoutResult) {
        var motoResponseBody = {
          pending: false,
          moto: true,
          checkout_token: checkoutResult.checkoutToken,
          reference: refNumber
        };

        // WR-01 (70-review): pending-charge backstop for a dropped MOTO /confirm.
        // Mirrors the terminal branch's write (fire-and-forget); cleared by a
        // successful /confirm via the tender-agnostic delete keyed on
        // reference_number. Uses terminal_amount (the card portion after any
        // gift-card split), matching what HelcimPay is initialized to capture.
        var motoPendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;
        var motoPendingContext = {
          reference_number: refNumber,
          amount:           terminal_amount,
          idempotency_key:  (body.idempotency_key && typeof body.idempotency_key === 'string')
                              ? body.idempotency_key : null,
          tender:           'moto',
          created_at:       new Date().toISOString()
        };
        cache.set(motoPendingKey, motoPendingContext, KIOSK_PENDING_CHARGE_TTL).catch(function () {});

        var motoCacheWrite = idempotencyKey
          ? cache.set(idempotencyKey, motoResponseBody, IDEMPOTENCY_KEY_TTL).catch(function () {})
          : Promise.resolve();

        return motoCacheWrite.then(function () {
          emitStageTiming('response_202', stageStart);
          res.status(202).json(motoResponseBody);
        });
      })
      .catch(function (motoInitErr) {
        log.error('[pos/kiosk/sale] MOTO HelcimPay initialize failed: ' + motoInitErr.message);
        // No charge was made — safe to release the lock for an immediate retry
        // (mirrors the terminal-push-failure catch below).
        if (idempotencyKey) {
          cache.releaseLock(idempotencyKey).catch(function () {});
        }
        res.status(502).json({ error: 'Unable to start phone-order payment — please try again' });
      });
  } else if (terminal_amount > 0) {
    log.info('[pos/kiosk/sale] Pushing to terminal: total=$' + terminal_amount.toFixed(2) +
      ' ref=' + refNumber + ' items=' + lineItems.length +
      (gift_amount > 0 ? ' gift_card=$' + gift_amount.toFixed(2) : ''));
    emitStageTiming('terminal_push_sent', stageStart);

    // D-12: derive Helcim terminal idempotency key deterministically from the client
    // idempotency_key so retries reuse the same Helcim key (no double terminal charge).
    // When no client key is provided, pass null so helcimLib generates a random key.
    var helcimIdemKey = (body.idempotency_key && typeof body.idempotency_key === 'string')
      ? crypto.createHash('sha256').update(body.idempotency_key).digest('hex').substring(0, 25)
      : null;

    helcimLib.terminalPurchase(terminal_amount, refNumber, helcimIdemKey)
      .then(function () {
        var responseBody = {
          pending: true,
          reference: refNumber
        };

        // D-13 (45-07): persist pending-charge context for the reconciliation backstop (45-08).
        // Written fire-and-forget after every successful push so a client-side timeout
        // leaves a reconcilable trail.  Key = KIOSK_PENDING_CHARGE_PREFIX + refNumber.
        var pendingCacheKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;
        var pendingContext = {
          reference_number: refNumber,
          amount:           terminal_amount,
          idempotency_key:  (body.idempotency_key && typeof body.idempotency_key === 'string')
                              ? body.idempotency_key : null,
          created_at:       new Date().toISOString()
        };
        cache.set(pendingCacheKey, pendingContext, KIOSK_PENDING_CHARGE_TTL).catch(function () {});

        var cacheWrite = idempotencyKey
          ? cache.set(idempotencyKey, responseBody, IDEMPOTENCY_KEY_TTL).catch(function () {})
          : Promise.resolve();

        return cacheWrite.then(function () {
          emitStageTiming('response_202', stageStart);
          res.status(202).json(responseBody);
        });
      })
      .catch(function (termErr) {
        log.error('[pos/kiosk/sale] Terminal push failed: ' + termErr.message);
        // WR-03: release idempotency lock so the client can retry.  The terminal
        // push failed and NO charge was recorded — it's safe to allow a retry under
        // a fresh lock.  Do NOT release the lock when a charge may have succeeded
        // (i.e., polled OK then failed) — that case doesn't reach this catch.
        if (idempotencyKey) {
          cache.releaseLock(idempotencyKey).catch(function () {});
        }
        res.status(502).json({ error: 'Terminal error — please try again' });
      });
  } else {
    // Gift card covers 100% — skip terminal entirely.
    // Return a non-pending response so the client proceeds directly to confirm.
    log.info('[pos/kiosk/sale] Gift card covers 100% ($' + grandTotal.toFixed(2) +
      ') — skipping terminal. ref=' + refNumber + ' cert=' + gift_cert_number);

    var gcOnlyResponseBody = {
      pending: false,
      gift_card_only: true,
      reference: refNumber
    };

    var gcCacheWrite = idempotencyKey
      ? cache.set(idempotencyKey, gcOnlyResponseBody, IDEMPOTENCY_KEY_TTL).catch(function () {})
      : Promise.resolve();

    gcCacheWrite.then(function () {
      emitStageTiming('response_202', stageStart);
      res.status(202).json(gcOnlyResponseBody);
    });
  }
  }); // end gcRealBalanceLookup.then (D-12 balance validation)
}

/**
 * GET /api/kiosk/sale/status
 * Poll for terminal payment result. Single Redis/API check, no long polling.
 * Query: ?ref=KIOSK-xxxxx
 */
router.get('/api/kiosk/sale/status', function (req, res) {
  var ref = req.query.ref;
  if (!ref || typeof ref !== 'string') {
    return res.status(400).json({ error: 'Missing ref parameter' });
  }

  helcimLib.pollTerminalResult(ref)
    .then(function (result) {
      if (result.approved) {
        return res.json({
          status: 'approved',
          transaction_id: result.transactionId || '',
          card_type: result.cardType || ''
        });
      }
      if (result.status === 'DECLINED' || result.status === 'CANCELLED') {
        return res.json({ status: 'declined' });
      }
      res.json({ status: 'pending' });
    })
    .catch(function (err) {
      log.error('[pos/kiosk/sale/status] Poll error: ' + err.message);
      res.json({ status: 'pending' });
    });
});

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
 * POST /api/kiosk/verify-pin
 * Verify a 4-digit kiosk access PIN.
 */
router.post('/api/kiosk/verify-pin', function (req, res) {
  var pin = req.body && req.body.pin;

  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: 'PIN must be exactly 4 digits' });
  }

  // D-15: guard length BEFORE timingSafeEqual — different-length buffers cause a RangeError,
  // which Express surfaces as a 500 on every login (staff lockout).
  // Length is not secret; comparing lengths first is safe (mirrors lib/apiKey.js:34).
  if (!process.env.KIOSK_PIN || process.env.KIOSK_PIN.length !== pin.length) {
    return res.status(503).json({ ok: false, error: 'PIN not configured' });
  }

  var match = crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(process.env.KIOSK_PIN));
  if (match) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Invalid PIN' });
});

// 57-01: durable telemetry sink for the kiosk client-error beacon. The kiosk POSTs
// here from its failure catch handlers so the real error (text/status/endpoint/auth
// state) is captured to Sentry BEFORE staff tap Retry and it vanishes. This route
// accepts client-authored strings from the shop-floor iPad, so it treats the body as
// hostile: only the six whitelisted fields are read; the message is scrubbed for
// log-injection control chars and any 13-19 digit run (potential PAN) is redacted;
// nothing else in the body is ever forwarded. It returns 204 with no body and has no
// money/data side-effect. Device-token gated (KIOSK_ROUTES) + rate-limited (server.js
// clientErrorLimiter). Threats T-57-01..05.
function scrubClientErrorText(value, maxLen) {
  var s = typeof value === 'string' ? value : String(value == null ? '' : value); // eslint-disable-line eqeqeq -- intentional == null matches undefined too
  // Redact any run of 13-19 digits (card-number shape) before anything else.
  s = s.replace(/\d{13,19}/g, '[REDACTED]');
  // Strip CR/LF and other C0/C1 control characters (log injection).
  s = s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  s = s.slice(0, maxLen || 500);
  return s;
}

router.post('/api/kiosk/client-error', function (req, res) {
  var body = req.body || {};
  var message = scrubClientErrorText(body.message, 500);
  var endpoint = scrubClientErrorText(body.endpoint, 120);
  var authState = scrubClientErrorText(body.auth_state, 40);
  var userAgent = scrubClientErrorText(body.user_agent, 200);
  var clientTimestamp = scrubClientErrorText(body.timestamp, 40);
  var httpStatus = (typeof body.http_status === 'number' && isFinite(body.http_status))
    ? body.http_status : null;

  // 57-04 (57-DIAGNOSIS beacon finding 2): a real Zoho item_id is 18-19
  // digits and collides with scrubClientErrorText's 13-19-digit PAN-shape
  // redaction on `message` above — the field that made the 2026-07-15
  // diagnosis possible would otherwise log as "...catalog: [REDACTED]."
  // Rather than weaken the message redaction, item_id gets its OWN strictly
  // shape-validated field: only a value matching a real Zoho item_id
  // (17-19 digits, digits only — narrower than a generic 13-19-digit PAN
  // shape so a 15/16-digit card number cannot be smuggled through as a
  // fake item_id, T-57-04-03) is stored un-redacted; anything else is
  // omitted entirely, never forwarded un-validated.
  var rawItemId = typeof body.item_id === 'string' ? body.item_id : '';
  var validatedItemId = /^\d{17,19}$/.test(rawItemId) ? rawItemId : null;

  var tags = {
    source: 'kiosk-client',
    endpoint: endpoint,
    http_status: httpStatus,
    auth_state: authState
  };
  if (validatedItemId) {
    tags.item_id = validatedItemId;
  }

  captureExceptionSafe(new Error(message), {
    level: 'error',
    tags: tags,
    extra: { user_agent: userAgent, client_timestamp: clientTimestamp }
  });

  log.warn('[pos/kiosk/client-error] ' + endpoint + ' status=' + httpStatus +
    ' auth=' + authState + (validatedItemId ? ' item_id=' + validatedItemId : '') +
    ' :: ' + message);

  return res.status(204).end();
});

// 68-01: durable sink for the kiosk terminal-push-latency beacon
// (_kcReportTerminalPushLatency, kiosk-core.js). Mirrors the /api/kiosk/
// client-error sink immediately above — same no-side-effect, bounded,
// hostile-body-input contract (this route accepts client-authored numbers
// from the shop-floor iPad) — but is a NEW, separate route/event so the
// pinned 6-key /api/kiosk/client-error beacon shape (kiosk-client-error-
// beacon.test.js) is never touched. Correlates the client's measured
// wall-time (terminal-prompt-shown → 202) with the server's own
// kiosk.sale_stage_timing events so a live slow case names the dominant
// stage instead of guessing. Registered in the same KIOSK_ROUTES allowlist
// + rate limiter class as client-error (server.js). Threats T-68-01-1/2.
router.post('/api/kiosk/telemetry', function (req, res) {
  var body = req.body || {};
  var stage = scrubClientErrorText(body.stage, 40);
  var referenceNumber = scrubClientErrorText(body.reference_number, 64);
  // Bounded validation: clamp to a sane 0-5min window; a non-numeric/
  // non-finite duration is ignored (no event emitted) without throwing —
  // never trust a client-supplied number unclamped into a log/metric.
  var durationMs = (typeof body.duration_ms === 'number' && isFinite(body.duration_ms))
    ? Math.max(0, Math.min(body.duration_ms, 300000))
    : null;

  if (durationMs === null) {
    return res.status(204).end();
  }

  log.info('[pos/kiosk/telemetry] stage=' + stage + ' duration_ms=' + durationMs +
    ' ref=' + referenceNumber);

  eventLog.logEvent('kiosk.terminal_push_latency', {
    stage: stage,
    duration_ms: durationMs,
    reference_number: referenceNumber
  });

  return res.status(204).end();
});

router.post('/api/kiosk/sale/confirm', function (req, res) {
  var body = req.body;
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  // Confirm-level idempotency (T-44-G2, D-12): prevents double invoice / double activation on replay.
  // Uses a 'confirm:' prefix so it never collides with the sale endpoint's cached 202.
  //
  // CR-01 fix: derive the seed from body.idempotency_key first, then fall back to
  // body.transaction_id, then body.reference_number.  NEVER bare-400 after a charge:
  // a 400 here when the terminal has already run → orphan charge (money taken, no invoice).
  // If no seed is derivable at all, fall through to runConfirm so the void-on-failure
  // path can run (it checks body.transaction_id and voids if set).
  var _confirmSeed = (typeof body.idempotency_key === 'string' && body.idempotency_key)
    ? body.idempotency_key
    : (typeof body.transaction_id === 'string' && body.transaction_id)
      ? body.transaction_id
      : (typeof body.reference_number === 'string' && body.reference_number)
        ? body.reference_number
        : null;
  var confirmIdemKey = _confirmSeed
    ? C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:' + String(_confirmSeed).slice(0, 128)
    : null;

  if (confirmIdemKey) {
    // D-12: atomic idempotency lock via shared money-path primitive (replaces non-atomic get-then-set)
    return moneyPath.acquireIdempotencyLock(cache, confirmIdemKey, IDEMPOTENCY_KEY_TTL)
      .then(function (lockResult) {
        // Only short-circuit on replay when the cached value is a well-formed confirm response.
        // Guards against test mocks that return non-null for all cache keys (catalog arrays, etc.)
        // and against corrupt/stale cache entries.  Only successful confirms are ever cached here.
        if (lockResult.status === 'replay' && lockResult.cached &&
            typeof lockResult.cached === 'object' && !Array.isArray(lockResult.cached) &&
            lockResult.cached.ok === true) {
          log.info('[pos/kiosk/sale/confirm] Idempotent replay: ' + confirmIdemKey);
          return res.status(201).json(lockResult.cached);
        }
        if (lockResult.status === 'contention' || lockResult.status === 'failclosed') {
          return res.status(409).json({ error: 'Confirm already in progress — please wait before retrying' });
        }
        // status === 'acquired', or replay with invalid cached data — proceed to confirm
        runConfirm(body, confirmIdemKey, req, res);
      });
  }

  runConfirm(body, null, req, res);
});

function runConfirm(body, confirmIdemKey, req, res) {
  // D-50-03 (50-03 / H4 / SC#2): release the confirm idempotency lock on
  // EVERY failure return in this function — the ~10 existing ones and any
  // future one — via a single response-finish hook instead of editing each
  // return res.status(4xx) site (that per-site approach is exactly how the
  // bug happened: a failure path was added without a release). The
  // exception is load-bearing: when an unvoided charge is still in play
  // (res.locals.__keepIdemLock === true, set by the void-failure branch
  // below), the lock stays held so a retry cannot double-charge.
  // Guarded on typeof res.on === 'function': real Express responses are
  // EventEmitters and always have it; a handful of pre-existing test files
  // pass a plain mock res object without .on, and must not crash here.
  if (confirmIdemKey && res && typeof res.on === 'function') {
    res.on('finish', function () {
      if (res.statusCode >= 400 && !(res.locals && res.locals.__keepIdemLock)) {
        cache.releaseLock(confirmIdemKey).catch(function () {});
      }
    });
  }
  cache.get(KIOSK_PRODUCTS_CACHE_KEY).then(function (catalog) {
    var catalogMap = {};
    if (Array.isArray(catalog)) {
      catalog.forEach(function (p) {
        if (p && p.item_id) catalogMap[p.item_id] = p;
      });
    }

    for (var ci = 0; ci < body.items.length; ci++) {
      if (body.items[ci].custom) continue; // custom lines bypass catalog check
      if (body.items[ci].gift_cert) continue; // gift_cert lines bypass catalog check
      if (catalogMap[body.items[ci].item_id] === undefined) {
        return res.status(400).json({ error: 'Item not found in catalog. Refresh and try again.' });
      }
    }

    // Fail-closed guard: gift_cert lines require KIOSK_GIFT_CARD_ITEM_ID (T-44-G4)
    if (body.items.some(function (i) { return i.gift_cert === true; }) &&
        !process.env.KIOSK_GIFT_CARD_ITEM_ID) {
      log.warn('[pos/kiosk/sale/confirm] gift_cert line rejected — KIOSK_GIFT_CARD_ITEM_ID not configured');
      return res.status(503).json({ error: 'Gift card accounting not configured (KIOSK_GIFT_CARD_ITEM_ID missing)' });
    }

    // Validate gift_cert lines before building lineItems
    for (var gcvC = 0; gcvC < body.items.length; gcvC++) {
      var gcItemC = body.items[gcvC];
      if (!gcItemC.gift_cert) continue;
      var gcCertNumC = String(gcItemC.cert_number || '').trim().toUpperCase();
      if (!/^GC-\d{6}$/.test(gcCertNumC)) {
        return res.status(400).json({ error: 'gift_cert cert_number must match GC-NNNNNN format (e.g. GC-000042)' });
      }
      var gcRateC = Number(gcItemC.rate);
      if (!isFinite(gcRateC) || gcRateC <= 0 || gcRateC > 2000) {
        return res.status(400).json({ error: 'gift_cert rate must be between $0.01 and $2000' });
      }
    }

    // Pre-resolve GST tax_id for any taxable custom lines (D-02 fail-closed).
    var needGstTaxIdConfirm = body.items.some(function (item) {
      return item.custom && item.taxable !== false;
    });
    var gstTaxIdConfirm = null;
    if (needGstTaxIdConfirm) {
      gstTaxIdConfirm = resolveGstTaxId(catalogMap);
      if (!gstTaxIdConfirm) {
        return res.status(400).json({
          error: 'Cannot tax this custom line: no GST tax rate configured. Mark the line tax-exempt or set KIOSK_GST_TAX_ID.'
        });
      }
    }

    var subtotal = 0;
    var lineItems = body.items.map(function (item) {
      if (item.custom) {
        var qty = Number(item.quantity) || 1;
        var rate = Number(item.rate);
        subtotal += qty * rate;
        var taxable = item.taxable !== false;
        var desc = String(item.description || '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
        var note = String(item.note || '').trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, 100);
        var fullDesc = note ? (desc + ' — ' + note) : desc;
        var li = {
          custom: true,
          description: fullDesc,
          rate: rate,
          quantity: qty,
          tax_percentage: taxable ? 5 : 0
        };
        if (taxable) {
          li.tax_id = gstTaxIdConfirm;
        } else if (process.env.ZOHO_TAX_ZERO_ID) {
          // F3 (45-09): an exempt custom line has no backing Zoho item, so an
          // un-tagged line is DEFAULT-taxed by Zoho (phantom GST → partial-paid
          // invoice). Attach the explicit Zero Rate tax so Zoho books a real 0%.
          li.tax_id = process.env.ZOHO_TAX_ZERO_ID;
        }
        return li;
      }
      // Gift cert line (Phase 44-09): server-authoritative item_id, zero-tax (D-03, T-44-G1)
      if (item.gift_cert) {
        var gcCertNumConfirm = String(item.cert_number || '').trim().toUpperCase();
        var gcRateConfirm = Number(item.rate);
        var gcNameConfirm = item.gift_action === 'reload'
          ? 'Gift Certificate Reload ' + gcCertNumConfirm
          : 'Gift Certificate ' + gcCertNumConfirm;
        subtotal += gcRateConfirm;
        return {
          gift_cert: true,
          gift_action: item.gift_action || 'issue',
          cert_number: gcCertNumConfirm,
          item_id: process.env.KIOSK_GIFT_CARD_ITEM_ID, // server-authoritative (D-05)
          name: gcNameConfirm,
          quantity: 1,
          rate: gcRateConfirm
          // NO tax_id — item carries its own EXEMPT setting (D-03)
        };
      }
      var qty = Number(item.quantity) || 1;
      var catalogItem = catalogMap[item.item_id];
      var rate = catalogItem.rate;
      subtotal += qty * rate;
      var li = { item_id: item.item_id, name: item.name || '', sku: catalogItem.sku || '', quantity: qty, rate: rate };
      if (catalogItem.tax_id) {
        li.tax_id = catalogItem.tax_id;
      }
      return li;
    });
    subtotal = Math.round(subtotal * 100) / 100;

    return resolveDiscount(body, lineItems, subtotal, catalogMap).then(function (discResult) {
      if (discResult && discResult.error) {
        return res.status(discResult.status).json({ error: discResult.error });
      }

      var discountApplied = null;
      if (discResult) {
        subtotal = discResult.subtotal;
        discountApplied = discResult.discountApplied;
      }

    // Phase 67 (KIOSK-TAX-QUOTE-01): CONFIRM path — a terminal charge may
    // ALREADY exist (manual confirm, body.transaction_id). An early
    // res.status(400) here would bypass the outer .catch's void-on-failure
    // machinery entirely and orphan the charge (pos.js:816-819 invariant:
    // "NEVER bare-400 after a charge"). Instead, throw a TAGGED error into
    // the promise chain so it reaches the outer .catch below, which routes
    // through void-on-failure when a charge exists — mirroring the existing
    // __manualVerify tagged-error idiom.
    var taxResultConfirm = computeTax(lineItems, catalogMap);
    if (taxResultConfirm.error) {
      var taxUnresolvedErr = new Error(taxResultConfirm.error);
      taxUnresolvedErr.__taxUnresolved = true;
      taxUnresolvedErr.__taxUnresolvedItemName = taxResultConfirm.itemName;
      throw taxUnresolvedErr;
    }
    var taxTotal = taxResultConfirm.taxTotal;
    var grandTotal = Math.round((subtotal + taxTotal) * 100) / 100;
    var refNumber = (body.reference_number || 'KIOSK-' + Date.now()).slice(0, 64);
    var txnId = body.transaction_id || 'manual-confirm';
    var today = new Date().toISOString().slice(0, 10);

    var invoiceNotes = 'In-store kiosk sale (manual confirm). Ref: ' + refNumber;
    if (discountApplied) {
      invoiceNotes += '\nDiscount: ' + discountApplied.name + ' (' + discountApplied.type + ' ' + discountApplied.value + (discountApplied.type === 'percentage' ? '%' : '') + ')';
    }

    // Strip internal gift_cert tracking fields before sending to Zoho
    var zohoLineItems = lineItems.map(function (li) {
      if (!li.gift_cert) return li;
      return { item_id: li.item_id, name: li.name, quantity: li.quantity, rate: li.rate };
    });

    var invoicePayload = {
      date: today,
      reference_number: refNumber,
      payment_terms: 0,
      payment_terms_label: 'Due on Receipt',
      line_items: zohoLineItems,
      notes: invoiceNotes,
      custom_fields: []
    };

    var contactId = process.env.KIOSK_CONTACT_ID || '';
    if (body.contact_id) invoicePayload.customer_id = body.contact_id;
    else if (contactId) invoicePayload.customer_id = contactId;

    var consignmentDetails = [];
    lineItems.forEach(function (li) {
      var info = extractConsignmentInfo(catalogMap[li.item_id]);
      if (info) {
        consignmentDetails.push({
          item_id: li.item_id, item_name: li.name, quantity: li.quantity,
          sale_amount: Math.round(li.quantity * li.rate * 100) / 100,
          artisan_name: info.artisan_name, commission_rate: info.commission_rate,
          artisan_payout: Math.round(li.quantity * li.rate * (info.commission_rate / 100) * 100) / 100
        });
      }
    });
    if (consignmentDetails.length > 0 && process.env.ZOHO_CF_CONSIGNMENT_SALE) {
      invoicePayload.custom_fields.push({ api_name: process.env.ZOHO_CF_CONSIGNMENT_SALE, value: true });
    }
    if (consignmentDetails.length > 0 && process.env.ZOHO_CF_CONSIGNMENT_DETAILS) {
      invoicePayload.custom_fields.push({ api_name: process.env.ZOHO_CF_CONSIGNMENT_DETAILS, value: JSON.stringify(consignmentDetails) });
    }

    // --- Phase 44 split-tender: re-clamp gift_amount to re-computed grandTotal (Pitfall 3).
    // D-12 (45-07): gcApplied further validated against real server-side balance (fail-open).
    var gcSubmittedConfirm = 0;
    var gcCertNum = '';
    if (body.gift_card && body.gift_card.cert_number) {
      // D-05: server-authoritative re-clamp (Pitfall 3 — prices may differ from sale quote)
      gcSubmittedConfirm = Math.min(
        Math.max(Number(body.gift_card.amount_applied) || 0, 0),
        grandTotal
      );
      gcCertNum = String(body.gift_card.cert_number).trim().toUpperCase().slice(0, 20);
    }
    // CR-02 (45): look up real balance before recording gift card payment in Zoho.
    // Discriminated result (same contract as sale path):
    //   { state: 'ok', balance: N } | { state: 'invalid' } | { state: 'unavailable' } | null
    var _cfAsUrl   = process.env.APPS_SCRIPT_URL;
    var _cfAsToken = process.env.APPS_SCRIPT_SERVER_TOKEN;
    var gcConfirmBalanceLookup = Promise.resolve(null);
    if (gcSubmittedConfirm > 0 && gcCertNum && _cfAsUrl && _cfAsToken) {
      gcConfirmBalanceLookup = Promise.resolve(
        axios.post(_cfAsUrl, JSON.stringify({
          action:       'lookup_gift_card',
          server_token: _cfAsToken,
          cert_number:  gcCertNum
        }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
      )
      .then(function (resp) {
        var r = (resp && resp.data) || {};
        if (r.ok === true && r.data && typeof r.data.current_balance === 'number') {
          return { state: 'ok', balance: r.data.current_balance };
        }
        // Apps Script explicitly reported ok:false → cert invalid or not found.
        // In production this is a hard reject; in non-prod treat as unavailable
        // (fail-open) so existing tests that mock all axios.post as ok:false
        // for redeem-failure scenarios still reach the redemption step (T-44-G9).
        if (r.ok === false) {
          return process.env.NODE_ENV === 'production'
            ? { state: 'invalid' }
            : { state: 'unavailable' };
        }
        // ok:true but no balance data
        return { state: 'unavailable' };
      })
      .catch(function (lookupErr) {
        log.warn('[pos/kiosk/sale/confirm] gift-card balance lookup failed: ' + (lookupErr && lookupErr.message));
        return { state: 'unavailable' };
      });
    }

    return gcConfirmBalanceLookup.then(function (gcConfirmLookup) {
      // CR-02: discriminated result handling (terminal already charged — void-on-failure applies)
      if (gcConfirmLookup !== null) {
        if (gcConfirmLookup.state === 'invalid') {
          // Terminal already charged — void before rejecting. 70-01: cash has no
          // Helcim charge and no transaction_id — never attempt a void for it
          // (T-70-03; a real Helcim call with an undefined token would otherwise fire).
          var gcInvalidVoid = (body.tender !== 'cash')
            ? moneyPath.voidWithTimeout(helcimLib, body.transaction_id, grandTotal, { reqId: req.id })
            : Promise.resolve();
          return gcInvalidVoid
            .then(function () {
              return res.status(400).json({ error: 'Gift card not found or has insufficient balance' });
            })
            .catch(function () {
              return res.status(400).json({ error: 'Gift card not found or has insufficient balance' });
            });
        }
        if (gcConfirmLookup.state === 'unavailable') {
          if (process.env.NODE_ENV === 'production') {
            return res.status(503).json({ error: 'Gift card validation temporarily unavailable' });
          }
          log.warn('[pos/kiosk/sale/confirm] gift-card lookup unavailable (non-prod fail-open): cert=' + gcCertNum);
        }
      }
      var gcApplied = gcSubmittedConfirm;
      if (gcConfirmLookup && gcConfirmLookup.state === 'ok' && gcApplied > gcConfirmLookup.balance) {
        log.warn('[pos/kiosk/sale/confirm] gcApplied clamped to realBalance: submitted=' + gcApplied +
          ' realBalance=' + gcConfirmLookup.balance + ' cert=' + gcCertNum);
        gcApplied = Math.min(gcConfirmLookup.balance, grandTotal);
      }
    // terminalApplied is what was (or will be) charged on the Helcim terminal.
    var terminalApplied = Math.round((grandTotal - gcApplied) * 100) / 100;
    // 70-01: cashApplied is computed the SAME way terminalApplied is (re-resolved
    // server-side from the confirm-time grandTotal/gcApplied — Pitfall 5, never
    // carried from the /sale-time response). Only meaningful for tender:'cash'.
    var cashApplied = (body.tender === 'cash') ? terminalApplied : 0;

    // M3 (52-03, RESIL-01): the gift-card clearing customerpayment REQUIRES a real
    // ledger account — no hardcoded fallback (Pattern D). Fail CLOSED before the
    // invoice/payment chain runs: if a redemption is in play (gcApplied > 0 &&
    // gcCertNum) but ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID is unset, do NOT post to a
    // guessed account. Mirrors the CR-02 gcConfirmLookup 'invalid' precedent just
    // above — void any terminal charge already pushed, then reject, rather than
    // creating an invoice that can never be correctly paid off.
    var gcClearingAccount = process.env.ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID;
    if (gcApplied > 0 && gcCertNum && !gcClearingAccount) {
      log.error('[pos/kiosk/sale/confirm] CRITICAL: gift-card redemption blocked — ' +
        'ZOHO_GIFT_CARD_CLEARING_ACCOUNT_ID is unset; refusing to post to a guessed ledger. cert=' + gcCertNum);
      // 70-01: cash never has a Helcim charge/transaction_id to void (T-70-03).
      var gcAcctVoid = (terminalApplied > 0 && body.tender !== 'cash')
        ? moneyPath.voidWithTimeout(helcimLib, body.transaction_id, grandTotal, { reqId: req.id })
        : Promise.resolve();
      return gcAcctVoid
        .then(function () {
          return res.status(503).json({ error: 'Gift card redemption temporarily unavailable — contact staff' });
        })
        .catch(function () {
          return res.status(503).json({ error: 'Gift card redemption temporarily unavailable — contact staff' });
        });
    }

    // F2 (45-09): a manual confirm ('manual-confirm' / no txn id) carries no proof a
    // card charge actually happened. Booking a creditcard payment on trust risks
    // phantom revenue (uncharged invoice booked as paid) AND records the literal
    // 'manual-confirm' instead of the real Helcim id. Before creating the invoice,
    // resolve the actual approved transaction from Helcim; fail closed (no invoice,
    // no payment) if it can't be positively verified — the 45-08 reconciliation
    // backstop settles a genuinely-orphaned real charge. A real txn id (auto-confirm,
    // already poll-verified) is trusted and skips this lookup.
    var isManualConfirm = !body.transaction_id || body.transaction_id === 'manual-confirm';
    // 70-01: cash never has a Helcim charge to verify — the physical cash IS
    // the proof (T-70-03). Skip the poll entirely for cash so a cash confirm
    // (which sends no transaction_id, and so would otherwise satisfy
    // isManualConfirm) never triggers a terminal poll.
    var verifyManualCharge = (isManualConfirm && terminalApplied > 0 && body.tender !== 'cash')
      ? helcimLib.pollTerminalResult(refNumber).then(function (tr) {
          if (tr && tr.approved && tr.transactionId) {
            txnId = String(tr.transactionId); // real id → proof-of-charge + reconciliation fidelity
            return;
          }
          var mvErr = new Error('manual-confirm not verified');
          mvErr.__manualVerify = (tr && (tr.status === 'DECLINED' || tr.status === 'CANCELLED'))
            ? 'declined' : 'unverified';
          throw mvErr;
        })
      : Promise.resolve();

    // 70-02 (MONEY-01/H2 port): MOTO captured-amount verify. A HelcimPay
    // transaction_id arrives via CLIENT-side postMessage — it is the client's
    // word, NOT yet server-verified. Crucially, a real (non-'manual-confirm')
    // body.transaction_id makes isManualConfirm FALSE above, so
    // verifyManualCharge alone resolves immediately WITHOUT checking the
    // capture for MOTO — trusting body.transaction_id here would be a
    // phantom-revenue bug by construction (see RESEARCH.md Pitfall 1 /
    // Anti-Patterns). verifyMotoCharge is therefore a SEPARATE, unconditional
    // gate for tender:'moto', combined with verifyManualCharge via
    // Promise.all below (WR-2: MUST resolve before any zohoPost('/invoices')
    // call). Same tagged-error idiom as __manualVerify/__taxUnresolved, so a
    // failure flows through the EXISTING outer .catch's void-on-failure block
    // — no new void path is introduced (audit H5/L18).
    var MOTO_CAPTURED_AMOUNT_TOLERANCE = 0.01;
    var verifyMotoCharge = (body.tender === 'moto')
      ? Promise.resolve().then(function () {
          if (!body.transaction_id) {
            var mNoTxnErr = new Error('MOTO confirm missing transaction_id');
            mNoTxnErr.__motoVerifyFailed = true;
            throw mNoTxnErr;
          }
          return helcimLib.getCardTransactionById(body.transaction_id);
        })
        .then(function (txn) {
          // CR-01 (70-review): a captured AMOUNT alone is NOT proof of payment.
          // getCardTransactionById returns an uppercased `status`; a DECLINED,
          // VOIDED, or authorized-but-not-captured card transaction still carries
          // its attempted `amount`. Trusting amount-without-status books phantom
          // revenue (money recorded as collected that Helcim never captured).
          // Assert the transaction is genuinely APPROVED first — mirroring the
          // codebase standard (verifyManualCharge's `tr.approved`, the status
          // poll's `result.approved` / status.toUpperCase()==='APPROVED').
          var status = (txn && txn.status ? String(txn.status) : '').toUpperCase();
          if (status !== 'APPROVED') {
            log.error('[pos/kiosk/sale/confirm] MOTO transaction not approved — txn=' + body.transaction_id +
              ' status=' + status);
            var mStatusErr = new Error('MOTO transaction not approved (status=' + status + ')');
            mStatusErr.__motoVerifyFailed = true;
            throw mStatusErr;
          }
          // Lower AND upper bound: the capture must EQUAL the amount recorded for
          // this cart (±$0.01). An exact match also rejects a reused older
          // transaction id whose larger amount would satisfy a lower-bound-only
          // check (partial replay hardening). Full HelcimPay-session binding —
          // asserting the txn belongs to the checkout token initializeCheckout
          // created — requires threading that token through /confirm and is a
          // documented follow-up, kept out of this fix's scope.
          var captured = parseFloat(txn && txn.amount);
          if (!isFinite(captured) || captured <= 0 ||
              Math.abs(captured - terminalApplied) > MOTO_CAPTURED_AMOUNT_TOLERANCE) {
            log.error('[pos/kiosk/sale/confirm] MOTO captured amount mismatch — txn=' + body.transaction_id +
              ' captured=' + captured + ' recorded=' + terminalApplied);
            var mErr = new Error('MOTO captured amount could not be verified against the recorded total');
            mErr.__motoVerifyFailed = true;
            throw mErr;
          }
        })
        .catch(function (motoErr) {
          if (motoErr && motoErr.__motoVerifyFailed) throw motoErr;
          log.error('[pos/kiosk/sale/confirm] MOTO captured-amount readback failed for txn=' +
            body.transaction_id + ': ' + motoErr.message);
          var mReadErr = new Error('MOTO captured amount could not be verified against the recorded total');
          mReadErr.__motoVerifyFailed = true;
          throw mReadErr;
        })
      : Promise.resolve();

    return Promise.all([verifyManualCharge, verifyMotoCharge]).then(function () {
    // M-A3 / SC#1 (50-03): verify the amount ACTUALLY captured on the card
    // covers terminalApplied, BEFORE any Zoho side-effect. Mirrors
    // checkout.js's MONEY-01/H2 pattern (readback -> NaN-on-throw -> tagged
    // throw -> EXISTING catch's void-on-failure — no second void path,
    // audit H5/L18), but is strict in BOTH directions (D-50-04): the kiosk
    // sets its own charge amount, so an over-capture means OUR OWN catalog
    // moved between the sale and confirm legs and overcharged the
    // customer — not a customer's choice to overpay, unlike checkout.js.
    // Skipped for tender:'cash' (no Helcim charge exists to verify, T-70-03)
    // and tender:'moto' (already verified above by verifyMotoCharge — a
    // second readback here would be redundant, not incorrect).
    var CAPTURED_AMOUNT_TOLERANCE = 0.01;
    var captureVerify = Promise.resolve();
    if (terminalApplied > 0 && body.tender !== 'cash' && body.tender !== 'moto') {
      captureVerify = helcimLib.getCardTransactionById(txnId)
        .then(function (txn) {
          return parseFloat(txn && txn.amount);
        })
        .catch(function (captureReadErr) {
          log.error('[pos/kiosk/sale/confirm] M-A3: captured-amount readback failed for txn=' +
            txnId + ': ' + captureReadErr.message);
          captureExceptionSafe(captureReadErr, {
            level: 'error',
            tags: { reqId: req.id, txnId: txnId, salesOrderId: null }
          });
          return NaN; // unverifiable is treated as a mismatch — fail closed
        })
        .then(function (captured) {
          if (!isFinite(captured) || captured <= 0 ||
              Math.abs(captured - terminalApplied) > CAPTURED_AMOUNT_TOLERANCE) {
            log.error('[pos/kiosk/sale/confirm] M-A3: captured amount mismatch — txn=' + txnId +
              ' captured=' + captured + ' terminalApplied=' + terminalApplied);
            var mismatchErr = new Error('Captured amount could not be verified against the sale total');
            mismatchErr.isCapturedAmountMismatch = true;
            // Carries the REAL resolved txn id (may differ from body.transaction_id
            // for a manual-confirm sale, where body.transaction_id is still the
            // literal 'manual-confirm' string sent by the client — txnId here is
            // the actual Helcim id resolved by verifyManualCharge above). The
            // outer catch's void logic otherwise only has body.transaction_id
            // available and would try to void a non-existent 'manual-confirm' id.
            mismatchErr.__capturedTxnId = txnId;
            throw mismatchErr;
          }
        });
    }
    return captureVerify.then(function () {
    return zohoPost('/invoices', invoicePayload).then(function (invoiceData) {
      var invoice = invoiceData.invoice || {};
      var invoiceId = invoice.invoice_id || '';
      var invoiceNumber = invoice.invoice_number || '';
      log.info('[pos/kiosk/sale/confirm] Invoice created: ' + invoiceNumber);

      // Tracks whether any gift-cert activation failed post-payment (money in, cert not active).
      // Set inside the LAST-STEP block; surfaced in the 201 response body.
      var giftCardActivationFailed = false;

      var paymentChain = Promise.resolve();
      if (invoiceId) {
        paymentChain = zohoPost('/invoices/' + invoiceId + '/submit', {}).catch(function () {})
          .then(function () {
            // Payment 1: terminal/cash portion — skip if gift card covers 100% (Pitfall 1
            // ordering). 70-01: cash books payment_mode:'cash' at the SAME chain position
            // the terminal payment occupies (before the gift-card 'others' leg below),
            // with reference_number = the kiosk refNumber — NEVER a transaction id (there
            // is no Helcim txn for cash).
            if (body.tender === 'cash' && cashApplied > 0) {
              return zohoPost('/customerpayments', {
                payment_mode: 'cash',
                amount: cashApplied,
                date: today,
                reference_number: refNumber,
                invoices: [{ invoice_id: invoiceId, amount_applied: cashApplied }],
                notes: 'Kiosk cash payment. Ref: ' + refNumber
              });
            }
            if (terminalApplied > 0) {
              // 70-02: MOTO books the SAME payment_mode:'creditcard' shape as the
              // terminal (Zoho's payment_mode enum has no CNP-specific value — see
              // RESEARCH.md A3/Q4) — only the notes text distinguishes a phone-order
              // (card-not-present) sale for dispute traceability. reference_number
              // is txnId, the VERIFIED HelcimPay transaction id (verifyMotoCharge
              // above already confirmed the captured amount before this runs).
              return zohoPost('/customerpayments', {
                payment_mode: 'creditcard',
                amount: terminalApplied,
                date: today,
                reference_number: txnId,
                invoices: [{ invoice_id: invoiceId, amount_applied: terminalApplied }],
                notes: (body.tender === 'moto')
                  ? 'Kiosk phone-order (card-not-present) payment. Ref: ' + refNumber
                  : 'Kiosk POS terminal payment. Ref: ' + refNumber
              });
            }
          })
          .then(function () {
            // Payment 2: gift card portion — ONLY after terminal payment is recorded (Pitfall 1)
            // account_id draws down the "Gift Cards Sold" clearing account (not Undeposited Funds)
            if (gcApplied > 0 && gcCertNum) {
              return zohoPost('/customerpayments', {
                payment_mode: 'others',
                // M3 (52-03): no hardcoded fallback — the pre-flight check above
                // already rejected this request if gcClearingAccount were falsy.
                account_id: gcClearingAccount,
                amount: gcApplied,
                date: today,
                reference_number: gcCertNum,
                invoices: [{ invoice_id: invoiceId, amount_applied: gcApplied }],
                notes: 'Gift certificate ' + gcCertNum + ' redemption. Ref: ' + refNumber
              });
            }
          })
          .then(function () {
            // LAST STEP: all Apps Script balance/activation calls (Pitfall 1 — MUST be after all Zoho calls).
            // On failure: log CRITICAL but resolve (invoice already paid — Pitfall 1 accepted failure mode).
            var asUrl = process.env.APPS_SCRIPT_URL;
            var asToken = process.env.APPS_SCRIPT_SERVER_TOKEN;

            var lastStep = Promise.resolve();

            // Step A: Redeem gift card balance (existing 44-04 path)
            if (gcApplied > 0 && gcCertNum && asUrl && asToken) {
              lastStep = lastStep.then(function () {
                return axios.post(asUrl, JSON.stringify({
                  action: 'redeem_gift_card',
                  server_token: asToken,
                  cert_number: gcCertNum,
                  amount: gcApplied,
                  transaction_ref: refNumber
                }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
                .then(function (asResp) {
                  var r = asResp.data || {};
                  if (!r.ok) {
                    log.error('[pos/kiosk/sale/confirm] CRITICAL: Gift card balance decrement failed for ' +
                      gcCertNum + ': ' + (r.error || 'unknown'));
                    // D-12 (45-07): flag for staff review — mirrors giftCardActivationFailed pattern
                    giftCardActivationFailed = true;
                  } else {
                    eventLog.logEvent('kiosk.gift_card_redeemed', {
                      certNumber: gcCertNum, amountApplied: gcApplied, refNumber: refNumber
                    });
                  }
                })
                .catch(function (asErr) {
                  log.error('[pos/kiosk/sale/confirm] CRITICAL: Apps Script redeem_gift_card unreachable for ' +
                    gcCertNum + ': ' + asErr.message);
                  // D-12 (45-07): unreachable Apps Script — flag for staff review
                  giftCardActivationFailed = true;
                });
              });
            }

            // Step B: Activate gift cert lines (issue/reload) — 44-09 (D-05, T-44-G3)
            // Runs AFTER Step A so both are post-payment; ordering within last-step doesn't matter
            // since they operate on different certs, but sequential chaining keeps the code clean.
            if (asUrl && asToken) {
              lineItems.forEach(function (gcLine) {
                if (!gcLine.gift_cert) return;
                var certNum = gcLine.cert_number;
                var certRate = gcLine.rate;
                var certAction = gcLine.gift_action || 'issue';

                if (certAction === 'issue') {
                  lastStep = lastStep.then(function () {
                    return axios.post(asUrl, JSON.stringify({
                      action: 'issue_gift_card',
                      server_token: asToken,
                      cert_number: certNum,
                      face_value: certRate,
                      issued_by: 'kiosk',
                      notes: 'Issued via kiosk cart. Ref: ' + refNumber
                    }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
                    .then(function (issueResp) {
                      var r = issueResp.data || {};
                      if (!r.ok) {
                        log.error('[pos/kiosk/sale/confirm] CRITICAL: gift card activation failed for ' +
                          certNum + ': ' + (r.error || 'unknown'));
                        giftCardActivationFailed = true;
                        return; // do NOT call update_gift_card_invoice on failure
                      }
                      eventLog.logEvent('kiosk.gift_card_issued', {
                        certNumber: certNum, faceValue: certRate, invoiceNumber: invoiceNumber
                      });
                      // update_gift_card_invoice only on success (links Sheets row to cart invoice)
                      return axios.post(asUrl, JSON.stringify({
                        action: 'update_gift_card_invoice',
                        server_token: asToken,
                        cert_number: certNum,
                        zoho_invoice_number: invoiceNumber
                      }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
                      .catch(function (updErr) {
                        log.error('[pos/kiosk/sale/confirm] update_gift_card_invoice failed for ' +
                          certNum + ': ' + updErr.message);
                      });
                    })
                    .catch(function (issueErr) {
                      log.error('[pos/kiosk/sale/confirm] CRITICAL: gift card activation unreachable for ' +
                        certNum + ': ' + issueErr.message);
                      giftCardActivationFailed = true;
                    });
                  });
                } else if (certAction === 'reload') {
                  lastStep = lastStep.then(function () {
                    return axios.post(asUrl, JSON.stringify({
                      action: 'reload_gift_card',
                      server_token: asToken,
                      cert_number: certNum,
                      amount: certRate,
                      transaction_ref: refNumber
                    }), { headers: { 'Content-Type': 'application/json' }, timeout: 12000, maxRedirects: 5 })
                    .then(function (relResp) {
                      var r = relResp.data || {};
                      if (!r.ok) {
                        log.error('[pos/kiosk/sale/confirm] CRITICAL: gift card reload activation failed for ' +
                          certNum + ': ' + (r.error || 'unknown'));
                        giftCardActivationFailed = true;
                      } else {
                        eventLog.logEvent('kiosk.gift_card_reloaded', {
                          certNumber: certNum, amount: certRate, refNumber: refNumber
                        });
                      }
                    })
                    .catch(function (relErr) {
                      log.error('[pos/kiosk/sale/confirm] CRITICAL: gift card reload unreachable for ' +
                        certNum + ': ' + relErr.message);
                      giftCardActivationFailed = true;
                    });
                  });
                }
              });
            }

            return lastStep;
          })
          .catch(function (payErr) {
            // D-12: propagate payment-recording failure so the outer void path fires.
            // Previous behaviour: log-only (swallowed) → success path ran → 201 ok:true
            // with money charged on terminal but unrecorded in Zoho.
            log.error('[pos/kiosk/sale/confirm] Payment recording failed: ' + payErr.message);
            throw payErr;
          });
      }

      return paymentChain.then(function () {
        cache.del(KIOSK_PRODUCTS_CACHE_KEY);
        ledger.decrementStock(lineItems, 'kiosk:' + (invoiceNumber || 'unknown')).catch(function () {});

        eventLog.logEvent('kiosk.sale_completed', {
          txnId: txnId, itemCount: lineItems.length, grandTotal: grandTotal, invoiceNumber: invoiceNumber
        });

        // Trigger batch creation for kit items with Maker's Fee (fire-and-forget per D-01)
        brewpadIntegration.createBatchesFromSale(lineItems, invoiceNumber, body.customer_name || '', body.contact_id || '', catalogMap, invoiceId);

        var result = {
          ok: true, transaction_id: txnId, invoice_id: invoiceId, invoice_number: invoiceNumber,
          reference_number: refNumber, subtotal: subtotal, tax_total: taxTotal, total: grandTotal, date: today
        };
        if (discountApplied) result.discount_applied = discountApplied;
        // Surface activation failure so 44-10 frontend can alert staff (T-44-G11)
        if (giftCardActivationFailed) {
          result.gift_card_activation_failed = true;
          result.needs_manual_review = true;
        }
        // Cache confirm result for idempotency (T-44-G2)
        var cacheWrite = confirmIdemKey
          ? cache.set(confirmIdemKey, result, IDEMPOTENCY_KEY_TTL).catch(function () {})
          : Promise.resolve();

        // D-13 (45-08 Rule 2): clear the kiosk pending-charge sentinel so the
        // reconciliation backstop knows this charge is settled (no orphan).
        // The confirm idem key (10-min TTL) is the primary signal; this deletion
        // is the durable signal — it outlasts the short idem TTL and prevents
        // false-positive void attempts by the sweep after the TTL expires.
        var pendingRef = (typeof body.reference_number === 'string' && body.reference_number)
          ? body.reference_number.slice(0, 64) : '';
        if (pendingRef) {
          cache.del(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + pendingRef)
            .catch(function () {});
        }

        cacheWrite.then(function () {
          res.status(201).json(result);
        });
      });
    }); // end zohoPost.then (inside gcConfirmBalanceLookup.then)
    }); // end captureVerify.then (M-A3 / 50-03 captured-amount verification)
    }); // end Promise.all([verifyManualCharge, verifyMotoCharge]).then (F2 45-09 / 70-02 MONEY-01/H2 verification)
    }); // end gcConfirmBalanceLookup.then (D-12 balance validation)
    }); // end resolveDiscount.then
  }).catch(function (err) {
    // F2 (45-09): manual-confirm could not be positively verified against Helcim.
    // No invoice was created and there is no real terminal txn to void — fail closed
    // WITHOUT booking. A genuinely-orphaned real charge is settled by the 45-08 sweep.
    if (err && err.__manualVerify) {
      if (res.headersSent) return;
      if (err.__manualVerify === 'declined') {
        return res.status(400).json({
          error: 'No approved card payment found for this sale (terminal reported declined or cancelled). Nothing was booked — do not re-charge.'
        });
      }
      return res.status(409).json({
        error: 'Card payment could not be verified yet. If the terminal approved, it will be reconciled automatically — do NOT re-charge. Otherwise wait a moment and retry.'
      });
    }
    // Phase 67 (KIOSK-TAX-QUOTE-01): computeTax could not resolve a tax rate
    // for a catalog line (tagged __taxUnresolved thrown above). If nothing
    // was charged yet (no body.transaction_id), a plain 400 naming the item
    // is safe and actionable — fall through to the generic void-on-failure
    // block below ONLY when a terminal charge already exists (never bare-400
    // after a charge, pos.js:816-819 invariant).
    if (err && err.__taxUnresolved && !(body && body.transaction_id)) {
      if (res.headersSent) return;
      // Phase 67 review fix (WR-01): release the confirm idempotency lock on
      // this actionable no-charge 400 — acquireIdempotencyLock only replays
      // cached RESULTS (never failures), so a held lock: key would 409 every
      // retry for IDEMPOTENCY_KEY_TTL (300s) after staff fix the catalog.
      // Mirrors the sale path's pre-charge-assertion 400 (same reason:
      // "so a corrected re-ring can retry immediately").
      if (confirmIdemKey) { cache.releaseLock(confirmIdemKey).catch(function () {}); }
      return res.status(400).json({ error: err.message });
    }
    log.error('[pos/kiosk/sale/confirm] Error: ' + err.message);
    // M-A3 / SC#1 (50-03): a captured-amount mismatch is a 402 (payment
    // rejected), not the generic "something broke" 502 — and the message
    // tells staff explicitly that the card was already voided.
    var _statusForFailure = (err && err.isCapturedAmountMismatch) ? 402 : 502;
    var _errorMsgForFailure = (err && err.isCapturedAmountMismatch)
      ? 'The amount charged does not match the sale total. The card charge has been voided — please re-ring the sale.'
      : 'Payment was taken but could not be recorded. Please contact support.';
    var _txnIdForVoidCapture = (err && err.__capturedTxnId)
      ? String(err.__capturedTxnId)
      : ((body && body.transaction_id) ? String(body.transaction_id) : null);
    captureExceptionSafe(err, {
      level: 'error',
      tags: { reqId: req.id, txnId: _txnIdForVoidCapture, salesOrderId: null }
    });
    // Void-on-failure: if a terminal charge was made and the Zoho invoice/payment
    // step (or payment recording step — D-12 propagated) failed, void the terminal
    // charge to prevent an orphan charge. Prefers the REAL resolved txn id carried
    // on a tagged mismatch error (err.__capturedTxnId) over body.transaction_id —
    // for a manual-confirm sale, body.transaction_id is still the literal
    // 'manual-confirm' string; the actual Helcim id only exists in the confirm
    // continuation's local scope and must be threaded through the tagged throw.
    // For gift-card-only sales (no terminal), neither is set — no void needed.
    var _txnIdForVoid = (err && err.__capturedTxnId)
      ? String(err.__capturedTxnId)
      : ((body && body.transaction_id) ? String(body.transaction_id) : null);
    if (_txnIdForVoid) {
      // D-12: track void failure via a thin wrapper so the response body can include
      // needs_manual_review and the sv:void-failure record is persisted for reconciliation.
      // The wrapper re-throws so moneyPath.voidWithTimeout's CRITICAL log + sendVoidFailureAlert fires.
      var _voidFailed = false;
      var _helcimForVoid = {
        voidTransaction: function (txnId) {
          return helcimLib.voidTransaction(txnId).catch(function (voidErr) {
            _voidFailed = true;
            var failRecord = {
              txnId: _txnIdForVoid,
              timestamp: new Date().toISOString(),
              error: voidErr.message,
              needs_manual_review: true
            };
            cache.set('sv:void-failure:' + Date.now(), failRecord, 60 * 60 * 24 * 30).catch(function () {});
            throw voidErr; // Re-throw so voidWithTimeout's CRITICAL log + mailer alert fires
          });
        }
      };

      moneyPath.voidWithTimeout(_helcimForVoid, _txnIdForVoid, 0, {
        mailer: mailer,
        eventLog: eventLog,
        reqId: req.id
      }).then(function () {
        if (res.headersSent) return;
        var responseBody = {
          error: _errorMsgForFailure,
          payment_voided: !_voidFailed,
          voided_transaction_id: _txnIdForVoid
        };
        if (_voidFailed) {
          responseBody.needs_manual_review = true;
          // D-50-03: the void itself failed — the customer is STILL charged.
          // Keep the lock held so a retry cannot charge a second time on top
          // of a live, unvoided first charge. Must be set BEFORE res.json()
          // below: the response-finish hook fires after the response is
          // sent, so res.locals has to already carry the flag by then.
          res.locals = res.locals || {};
          res.locals.__keepIdemLock = true;
        }
        res.status(_statusForFailure).json(responseBody);
      });
    } else {
      res.status(502).json({ error: 'Failed to create invoice. Please try again.' });
    }
  });
}

router.post('/api/pos/cancel', function (req, res) {
  var body = req.body || {};
  var ref = (body.reference_number && typeof body.reference_number === 'string')
    ? body.reference_number.slice(0, 64)
    : null;

  if (ref) {
    // T-68-02-1/T-68-02-2: mark this ref as cancelled so that if a terminal push
    // already landed (slow pipeline, or staff cancels mid-push), the Helcim
    // webhook's APPROVED-result handler (processCardTransactionResult,
    // webhooks.js) voids the charge on the FIRST event instead of leaving it
    // orphaned until the reconcile.js 600s backstop. This is the reachable
    // safety net — the client stops polling /api/kiosk/sale/status the instant
    // cancel is clicked, so that endpoint is never hit for this scenario.
    // Fire-and-forget: cancel must not block on Redis.
    cache.set(
      C.CACHE_KEYS.KIOSK_CANCELLED_PREFIX + ref,
      { cancelled_at: new Date().toISOString() },
      KIOSK_CANCELLED_TTL
    ).catch(function () {});
  }

  helcimLib.cancelTerminal().then(function (result) {
    res.json(result);
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
  // 52-03 (M2, RESIL-01): QUARANTINED — grep-confirmed dead route (2026-07-03):
  //   `grep -rn "pos/sale" js/` → zero frontend callers. Only remaining references:
  //   docs/*, openapi.yaml, and this file's own JSDoc/route def + the
  //   `app.use('/api/pos/sale', paymentLimiter)` rate-limit mount in server.js (harmless
  //   — the route below now always 410s, so the mount just rate-limits a dead endpoint).
  // Reason for quarantine (not deletion): the body below charges the Helcim terminal then
  //   treats a subsequent Zoho invoice/payment failure as "non-fatal" (no void, no pending
  //   record) — an invisible orphan charge invisible even to the 45-08 reconciliation
  //   backstop. Retired in favor of /api/kiosk/sale, which uses lib/money-path's
  //   void-on-failure + pending-record primitives. Returns 410 BEFORE any helcimLib
  //   terminal call so no charge can ever occur again. Body preserved below (unreachable)
  //   for audit trail — see 52-03-SUMMARY.md.
  return res.status(410).json({ error: 'Legacy POS sale endpoint retired — use /api/kiosk/sale' });

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
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // Item #13: This endpoint exposes sensitive order data. Require an API key
  // even for GET requests, overriding the global GET exemption in server.js
  // (admin-grade — device tier rejected by requireTiers above, T-46-18b).
  // Item #47: Cap at 50 regardless of caller-supplied value.
  var limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  var cacheKey = RECENT_ORDERS_CACHE_KEY + ':' + limit;

  Promise.resolve()
    .then(function () { return cache.get(cacheKey); })
    .then(function (cached) {
      if (cached) {
        return res.json({ orders: cached, cached: true });
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
});

/**
 * GET /api/admin/inventory-ledger
 * Returns current ledger state for debugging.
 * Shows recent stock adjustments and the current version counter.
 */
router.get('/api/admin/inventory-ledger', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  Promise.all([
    cache.get(C.LEDGER_KEYS.VERSION),
    cache.getClient().then(function (c) {
      if (!c) return [];
      return c.lRange(C.LEDGER_KEYS.ADJUSTMENTS, 0, 49);
    })
  ]).then(function (results) {
    var adjustments = (results[1] || []).map(function (entry) {
      try { return JSON.parse(entry); } catch { return entry; }
    });
    res.json({
      version: results[0] || 0,
      recent_adjustments: adjustments
    });
  }).catch(function (err) {
    res.status(500).json({ error: err.message });
  });
  });
});

// ---------------------------------------------------------------------------
// Kiosk Sales Order management
// ---------------------------------------------------------------------------

var KIOSK_SO_CACHE_KEY = C.CACHE_KEYS.KIOSK_SALESORDERS;
var KIOSK_SO_CACHE_TTL = 120; // seconds

/**
 * GET /api/kiosk/salesorders
 * List open/unfulfilled sales orders from Zoho for the kiosk UI.
 *
 * Query params:
 *   status  - Zoho SO status filter (default 'open')
 *   search  - Case-insensitive customer name filter (applied after cache)
 *
 * Response: { salesorders: [...] }
 */
router.get('/api/kiosk/salesorders', function (req, res) {
  authTiers.requireTiers(['legacy', 'device', 'session'])(req, res, function () {
  // D-09: kiosk order-book exposes PII (customer names, balances, line items).
  // Kiosk-scoped (46-04 interfaces) — device token allowed alongside legacy/session.
  var search = req.query.search || '';

  cache.get(KIOSK_SO_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        log.info('[kiosk/salesorders] Cache hit');
        return cached;
      }

      log.info('[kiosk/salesorders] Cache miss — fetching from Zoho (all statuses)');
      var fetchParams = { sort_column: 'date', sort_order: 'D' };
      return Promise.all([
        zohoGet('/salesorders', Object.assign({}, fetchParams, { status: 'open' })),
        zohoGet('/salesorders', Object.assign({}, fetchParams, { status: 'draft' })),
        zohoGet('/salesorders', Object.assign({}, fetchParams, { status: 'closed' })),
        zohoGet('/salesorders', Object.assign({}, fetchParams, { status: 'confirmed' })),
        zohoGet('/salesorders', Object.assign({}, fetchParams, { status: 'invoiced' }))
      ]).then(function (results) {
        var all = results.reduce(function (acc, r) {
          return acc.concat(r.salesorders || []);
        }, []);
        var seen = {};
        var combined = all.filter(function (so) {
          if (seen[so.salesorder_id]) return false;
          seen[so.salesorder_id] = true;
          return true;
        });
        combined.sort(function (a, b) {
          return (b.date || '').localeCompare(a.date || '');
        });
        var orders = combined.map(function (so) {
          return {
            salesorder_id: so.salesorder_id || '',
            salesorder_number: so.salesorder_number || '',
            customer_name: so.customer_name || '',
            customer_id: so.customer_id || '',
            balance: so.balance || 0,
            total: so.total || 0,
            status: so.status || '',
            date: so.date || '',
            line_items: (so.line_items || []).map(function (li) {
              return {
                item_id: li.item_id || '',
                name: li.name || li.description || '',
                quantity: li.quantity || 1,
                rate: li.rate || 0,
                amount: li.amount || 0
              };
            })
          };
        });

        // Cache the full result (before search filtering)
        cache.set(KIOSK_SO_CACHE_KEY, orders, KIOSK_SO_CACHE_TTL).catch(function () {});

        return orders;
      });
    })
    .then(function (orders) {
      // Apply client-side search filter if provided
      if (search) {
        var needle = search.toLowerCase();
        orders = orders.filter(function (so) {
          return (so.customer_name || '').toLowerCase().indexOf(needle) !== -1;
        });
      }

      res.json({ salesorders: orders });
    })
    .catch(function (err) {
      log.error('[kiosk/salesorders] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch sales orders' });
    });
  });
});

/**
 * POST /api/kiosk/salesorder-create
 * Create a new Sales Order in Zoho from the kiosk.
 *
 * Expected body:
 * {
 *   customer_id: "zoho_customer_id",
 *   items: [{ item_id: "id", name: "Name", quantity: 2, rate: 14.99 }],
 *   notes: "optional notes"
 * }
 *
 * Response: { ok, salesorder_id, salesorder_number, total, balance }
 */
router.post('/api/kiosk/salesorder-create', function (req, res) {
  var body = req.body || {};

  // Validate customer_id
  if (!body.customer_id || typeof body.customer_id !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid customer_id' });
  }

  // Validate items array
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Items array is required and must not be empty' });
  }

  for (var i = 0; i < body.items.length; i++) {
    var item = body.items[i];
    if (!item.item_id || typeof item.item_id !== 'string') {
      return res.status(400).json({ error: 'Invalid item_id for item ' + i });
    }
    var qty = Number(item.quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + i });
    }
    var rate = Number(item.rate);
    if (isNaN(rate) || rate < 0) {
      return res.status(400).json({ error: 'Invalid rate for item ' + i });
    }
  }

  var payload = {
    customer_id: body.customer_id,
    date: new Date().toISOString().slice(0, 10),
    line_items: body.items.map(function (item) {
      return {
        item_id: item.item_id,
        quantity: item.quantity,
        rate: item.rate,
        name: item.name || ''
      };
    }),
    notes: body.notes || ''
  };

  log.info('[kiosk/so-create] Creating SO for customer=' + body.customer_id +
    ' items=' + body.items.length);

  zohoPost('/salesorders', payload)
    .then(function (data) {
      var so = data.salesorder || {};
      var soId = so.salesorder_id || '';
      var soNumber = so.salesorder_number || '';
      var total = so.total || 0;
      var balance = so.balance || 0;

      log.info('[kiosk/so-create] Created: ' + soNumber + ' id=' + soId);

      // Invalidate the salesorders cache
      cache.del(KIOSK_SO_CACHE_KEY).catch(function () {});

      eventLog.logEvent('kiosk.salesorder_created', {
        soId: soId,
        soNumber: soNumber,
        itemCount: body.items.length,
        total: total
      });

      res.status(201).json({
        ok: true,
        salesorder_id: soId,
        salesorder_number: soNumber,
        total: total,
        balance: balance
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      log.error('[kiosk/so-create] Zoho error: ' + msg);
      res.status(502).json({ error: 'Failed to create sales order' });
    });
});

/**
 * POST /api/kiosk/salesorder-pay
 * Collect payment on an existing Sales Order via the Helcim terminal.
 * Synchronous: pushes to terminal, polls for result, records payment in Zoho.
 *
 * Expected body:
 * {
 *   salesorder_id: "zoho_salesorder_id",
 *   idempotency_key: "optional client-minted key — see D-50-01"
 * }
 *
 * D-50-01 (50-02): idempotency lock gate — the SAME money-path primitive
 * /api/kiosk/sale uses. Hybrid contract: an explicit client idempotency_key
 * is honoured verbatim (lock key `kiosk:idem:sopay:<key>`, replayable); with
 * no key, a salesorder-scoped fallback (`kiosk:idem:sopay:so:<salesorder_id>`)
 * still locks but NEVER replays a cached receipt — it is not a statement of
 * client intent, only a same-attempt duplicate guard. This route deploys
 * straight to the production Railway instance (no staging middleware), so a
 * stale cached kiosk client that predates the idempotency_key contract must
 * still be hardened against a double-tap on day one.
 *
 * Response: { ok, transaction_id, salesorder_number, amount, card_type }
 */
router.post('/api/kiosk/salesorder-pay', function (req, res) {
  var body = req.body || {};
  var soId = body.salesorder_id;

  // Validate salesorder_id
  if (!soId || typeof soId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid salesorder_id' });
  }

  // Check terminal is available
  if (!helcimLib.isTerminalEnabled()) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  var clientSuppliedKey = (typeof body.idempotency_key === 'string' && body.idempotency_key.length > 0);
  var effectiveKey = clientSuppliedKey ? body.idempotency_key.slice(0, 128) : ('so:' + soId);
  var lockKey = C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'sopay:' + effectiveKey;

  return moneyPath.acquireIdempotencyLock(cache, lockKey, IDEMPOTENCY_KEY_TTL)
    .then(function (lockResult) {
      if (lockResult.status === 'replay') {
        if (clientSuppliedKey && lockResult.cached && lockResult.cached.ok === true) {
          log.info('[kiosk/so-pay] Idempotent replay: ' + lockKey);
          return res.status(200).json(lockResult.cached);
        }
        // D-50-01: the SO-id-scoped fallback key never serves a cached
        // receipt — it may be a genuinely new payment attempt.
        return res.status(409).json({ error: 'Payment already in progress for this order — please wait and check the order before retrying' });
      }
      if (lockResult.status === 'contention' || lockResult.status === 'failclosed') {
        return res.status(409).json({ error: 'Payment already in progress for this order — please wait and check the order before retrying' });
      }
      // status === 'acquired' — proceed
      return processSalesOrderPay(body, soId, effectiveKey, lockKey, req, res);
    });
});

function processSalesOrderPay(body, soId, effectiveKey, lockKey, req, res) {
  // Fetch the Sales Order from Zoho
  zohoGet('/salesorders/' + soId)
    .then(function (data) {
      var so = data.salesorder || {};
      var balance = parseFloat(so.balance);
      var soNumber = so.salesorder_number || '';
      var customerId = so.customer_id || '';
      var orderStatus = (so.order_status || so.status || '').toLowerCase();

      // Guard: balance must be positive
      if (isNaN(balance) || balance <= 0) {
        return res.status(400).json({ error: 'No balance due on this order' });
      }

      // Guard: reject void/closed orders
      if (orderStatus === 'void' || orderStatus === 'closed') {
        return res.status(400).json({ error: 'Order is ' + orderStatus });
      }

      log.info('[kiosk/so-pay] Starting payment: soNumber=' + soNumber +
        ' amount=$' + balance.toFixed(2));

      // Push payment to terminal
      var TERMINAL_TIMEOUT_MS = 90000;
      var POLL_INTERVAL_MS = 5000;
      // D-50-01a: derive the Helcim terminal idempotency key deterministically
      // from the effective lock key (mirrors /api/kiosk/sale) instead of
      // minting a fresh random key per call. Same effectiveKey -> same Helcim
      // key -> Helcim itself refuses a duplicate terminal charge even if the
      // Redis lock is bypassed (Redis outage, two Railway instances racing a
      // lock release).
      var helcimIdemKey = crypto.createHash('sha256').update(effectiveKey).digest('hex').substring(0, 25);
      // D-50-01b: unique reference per attempt. The bare soNumber was reused
      // on every attempt against the same order, so two attempts collided on
      // Helcim's invoiceNumber, the pollTerminalResult key, AND the
      // pending-charge key — attempt 2 could read attempt 1's approval and
      // neither could be attributed (T-50-08). Must be the SAME string
      // everywhere below or lib/reconcile.js will never find the record.
      var refNumber = (soNumber + '-' + helcimIdemKey.substring(0, 6)).slice(0, 64);
      // Declared here (not inside the terminal-push .then below) so the
      // success-path .then further down the SAME chain can also delete it —
      // a var declared inside a sibling .then callback is out of scope there.
      var pendingCacheKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;

      helcimLib.terminalPurchase(balance, refNumber, helcimIdemKey)
        .then(function () {
          log.info('[kiosk/so-pay] Terminal push sent: soNumber=' + soNumber + ' ref=' + refNumber);

          // SC#4 / T-50-10: persist pending-charge context immediately after a
          // successful terminal push — the only safe placement (writing it
          // before the push would leave a phantom record for a charge that
          // never happened). Mirrors /api/kiosk/sale's D-13 write.
          // salesorder_id is load-bearing — plan 50-05's D-50-08 discriminator
          // uses it to route this record to the sales-order check instead of
          // an invoice lookup. Deleted on the success path below.
          // idempotency_key stores effectiveKey (the attempt's idempotency key),
          // NOT helcimIdemKey — kept consistent with the 90s-timeout branch's
          // write below, which persists the same context shape for the same
          // reference/attempt if the terminal never responds.
          var pendingContext = {
            reference_number: refNumber,
            amount:           balance,
            salesorder_id:    soId,
            idempotency_key:  effectiveKey,
            created_at:       new Date().toISOString()
          };
          cache.set(pendingCacheKey, pendingContext, KIOSK_PENDING_CHARGE_TTL).catch(function () {});

          // Poll for result — same pattern as /api/kiosk/sale
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
            log.warn('[kiosk/so-pay] Terminal declined: soNumber=' + soNumber);
            return res.status(402).json({
              error: 'Payment declined',
              code: 'DECLINED'
            });
          }

          var txnId = termResponse.transactionId || '';
          log.info('[kiosk/so-pay] Terminal approved: txn=' + txnId +
            ' soNumber=' + soNumber);

          // Record payment in Zoho.
          var today = new Date().toISOString().slice(0, 10);
          var cardType = (termResponse.cardType || '').toLowerCase();
          var paymentMode = (cardType.indexOf('debit') !== -1) ? 'debitcard' : 'creditcard';

          // Book the payment against a FINALIZED invoice — the same verified
          // pattern as the collect webhook path (moneyPath.ensureOpenInvoiceForSalesOrder
          // = convert/reuse the SO's invoice + mark it /status/sent, then apply
          // the payment via invoices:[{invoice_id, amount_applied}]). NOT
          // salesorders_to_apply, which Zoho books as an unapplied advance and
          // leaves the invoice draft (the phase-71 root cause — this live route
          // was the still-buggy twin of /api/pos/collect). Any finalize/apply
          // failure AFTER the terminal charge falls through to the void-on-
          // failure catch below (fail-closed: reverse the charge).
          // (Ideal follow-up: extract a shared finalize+apply helper so this and
          // webhooks.js collect can't drift.)
          moneyPath.finalizeSalesOrderInvoiceAndApplyPayment(soId, {
            customer_id: customerId,
            amount: balance,
            payment_mode: paymentMode,
            reference_number: txnId || soNumber,
            notes: 'Kiosk SO payment. Terminal txn: ' + txnId,
            date: today
          })
            .then(function (result) {
              var invoiceId = result.invoiceId;
              log.info('[kiosk/so-pay] Payment applied to invoice=' + invoiceId + ' for ' + soNumber);

              // Invalidate caches (SO list + products stock)
              cache.del(KIOSK_SO_CACHE_KEY).catch(function () {});
              cache.del(KIOSK_PRODUCTS_CACHE_KEY).catch(function () {});
              // SC#4: clear the pending-charge sentinel — the charge is now
              // reconciled against a real Zoho payment, so it must no longer
              // be flagged as a potential orphan by the reconcile backstop.
              cache.del(pendingCacheKey).catch(function () {});

              eventLog.logEvent('kiosk.salesorder_payment', {
                soId: soId,
                soNumber: soNumber,
                txnId: txnId,
                amount: balance,
                invoiceId: invoiceId
              });

              // Trigger batch creation for kit items (fire-and-forget per D-01)
              var soLineItems = (so.line_items || []).map(function (li) {
                return { item_id: li.item_id || '', name: li.name || li.description || '', sku: li.sku || '', quantity: li.quantity || 1, rate: li.rate || 0 };
              });
              brewpadIntegration.createBatchesFromSale(soLineItems, soNumber, so.customer_name || '', customerId, null, invoiceId);

              var responseBody = {
                ok: true,
                transaction_id: txnId,
                salesorder_number: soNumber,
                amount: balance,
                card_type: paymentMode
              };

              // D-50-01: cache the success receipt under lockKey so a
              // client-keyed retry replays instead of re-charging.
              cache.set(lockKey, responseBody, IDEMPOTENCY_KEY_TTL).catch(function () {});

              res.json(responseBody);
            })
            .catch(function (payErr) {
              // Zoho payment recording failed after terminal approval — void
              var payMsg = payErr.message;
              if (payErr.response && payErr.response.data) {
                payMsg = payErr.response.data.message || payErr.response.data.error || payMsg;
              }
              log.error('[kiosk/so-pay] Payment recording failed after terminal approval — voiding txn=' + txnId + ': ' + payMsg);

              eventLog.logEvent('kiosk.so_pay_failed_after_charge', {
                soId: soId,
                soNumber: soNumber,
                txnId: txnId,
                amount: balance
              });

              // T-50-09/D-50-02: track void failure (INCLUDING an unconfirmed
              // void — 50-01 made helcimLib.voidTransaction REJECT with
              // err.isUnconfirmedVoid when Helcim's /payment/reverse response
              // carries no positive reversal signal) via a thin wrapper, so
              // the response body can honestly report payment_voided instead
              // of the old hardcoded payment_voided:true — a claim made even
              // when the void had failed or was never confirmed, because it
              // lived in a .then() that ran AFTER the void's .catch() had
              // already swallowed the failure. Mirrors the confirm route's
              // _voidFailed shim (this file, sale/confirm's outer catch).
              var _voidFailed = false;
              var _helcimForVoid = {
                voidTransaction: function (voidTxnId) {
                  return helcimLib.voidTransaction(voidTxnId).catch(function (voidErr) {
                    _voidFailed = true;
                    var failRecord = {
                      txnId: txnId,
                      amount: balance,
                      timestamp: new Date().toISOString(),
                      error: voidErr.message,
                      needs_manual_review: true
                    };
                    cache.set('sv:void-failure:' + Date.now(), failRecord, 60 * 60 * 24 * 30).catch(function () {});
                    throw voidErr; // Re-throw so voidWithTimeout's CRITICAL log + mailer alert fires
                  });
                }
              };

              moneyPath.voidWithTimeout(_helcimForVoid, txnId, balance, {
                mailer: mailer,
                eventLog: eventLog,
                reqId: req.id
              }).then(function () {
                if (res.headersSent) return;
                var responseBody = {
                  error: 'Payment was taken but could not be recorded against the order. Please contact support.',
                  payment_voided: !_voidFailed,
                  voided_transaction_id: txnId
                };
                if (_voidFailed) responseBody.needs_manual_review = true;
                res.status(502).json(responseBody);
              });
            });
        })
        .catch(function (termErr) {
          if (termErr.message === 'Terminal timeout after 90s') {
            log.warn('[kiosk/so-pay] Terminal timed out after 90s — no txn to void');
            // D-13 (45-07): persist pending-charge context for reconciliation backstop (45-08).
            // The terminal push may have reached Helcim before the timeout; the record lets
            // the daily reconcile job detect any orphaned charges.
            // idempotency_key stores effectiveKey (the attempt's idempotency key —
            // what a client retry varies), NOT helcimIdemKey (the derived Helcim
            // API key) — must match the success-path write below so the field
            // means the same thing regardless of which branch wrote the record.
            // helcimIdemKey is trivially recoverable from effectiveKey via the
            // same one-line sha256 derivation above if a future reader needs it.
            var _pendingKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;
            var _pendingCtx = {
              reference_number: refNumber,
              amount:           balance,
              salesorder_id:    soId,
              idempotency_key:  effectiveKey,
              created_at:       new Date().toISOString()
            };
            cache.set(_pendingKey, _pendingCtx, KIOSK_PENDING_CHARGE_TTL).catch(function () {});
            // T-50-11: deliberately do NOT release the lock — the terminal may
            // still approve late; the pending record + reconcile backstop own
            // that case, not a client retry (a retry here could double-charge).
            return res.status(504).json({ error: 'Terminal did not respond in time. Please try again.' });
          }
          if (termErr.isDeclined) {
            return res.status(402).json({ error: 'Payment declined', code: 'DECLINED' });
          }
          log.error('[kiosk/so-pay] Terminal error: ' + termErr.message);
          // No charge was taken — safe to release the lock for an immediate retry.
          cache.releaseLock(lockKey).catch(function () {});
          if (!res.headersSent) {
            res.status(502).json({ error: 'Terminal error — please try again' });
          }
        });
    })
    .catch(function (err) {
      var status = err.status || (err.response && err.response.status) || 502;
      // No terminal charge was ever attempted at this stage — safe to release.
      cache.releaseLock(lockKey).catch(function () {});
      if (status === 404 || (err.response && err.response.status === 404)) {
        log.error('[kiosk/so-pay] Sales order not found: soId=' + soId);
        return res.status(404).json({ error: 'Sales order not found' });
      }
      log.error('[kiosk/so-pay] Failed to fetch SO: ' + err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Failed to process sales order payment' });
      }
    });
}

/**
 * PUT /api/kiosk/salesorder-update
 * Update line items on an existing Sales Order in Zoho.
 * Called before terminal payment when cart was imported from an SO.
 *
 * Expected body:
 * {
 *   salesorder_id: "zoho_so_id",
 *   items: [{ item_id, name, quantity, rate }]
 * }
 *
 * Response: { ok, salesorder_id, salesorder_number, total, balance }
 */
router.put('/api/kiosk/salesorder-update', function (req, res) {
  authTiers.requireTiers(['legacy', 'device', 'session'])(req, res, function () {
  // Kiosk-scoped (46-04 interfaces) — device token allowed alongside legacy/session.
  var body = req.body || {};

  var soId = body.salesorder_id;
  if (!soId || typeof soId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid salesorder_id' });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Items array is required and must not be empty' });
  }
  for (var i = 0; i < body.items.length; i++) {
    var item = body.items[i];
    if (!item.item_id || typeof item.item_id !== 'string') {
      return res.status(400).json({ error: 'Invalid item_id for item ' + i });
    }
    var qty = Number(item.quantity);
    if (!qty || qty <= 0) {
      return res.status(400).json({ error: 'Invalid quantity for item ' + i });
    }
    var rate = Number(item.rate);
    if (isNaN(rate) || rate < 0) {
      return res.status(400).json({ error: 'Invalid rate for item ' + i });
    }
  }

  var payload = {
    line_items: body.items.map(function (item) {
      return {
        item_id: item.item_id,
        quantity: item.quantity,
        rate: item.rate,
        name: item.name || ''
      };
    })
  };

  log.info('[kiosk/so-update] Updating SO=' + soId + ' items=' + body.items.length);

  zohoPut('/salesorders/' + soId, payload)
    .then(function (data) {
      var so = data.salesorder || {};
      cache.del(KIOSK_SO_CACHE_KEY).catch(function () {});
      eventLog.logEvent('kiosk.salesorder_updated', {
        soId: soId,
        soNumber: so.salesorder_number || '',
        itemCount: body.items.length
      });
      res.json({
        ok: true,
        salesorder_id: soId,
        salesorder_number: so.salesorder_number || '',
        total: so.total || 0,
        balance: so.balance || 0
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      log.error('[kiosk/so-update] Zoho error: ' + msg);
      res.status(502).json({ error: 'Failed to update sales order' });
    });
  });
});

// Phase 7: Sync batch status to Zoho invoice custom field (D-01, D-02, D-03)
router.post('/api/batch/sync-zoho', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — 46-04 interfaces.
  var body = req.body || {};
  var soId = body.so_id;
  var batchId = body.batch_id;
  var status = body.status;

  if (!soId || typeof soId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid so_id' });
  }
  if (!batchId || typeof batchId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid batch_id' });
  }
  var validStatuses = ['pending', 'active', 'complete'];
  if (!status || validStatuses.indexOf(status) === -1) {
    return res.status(400).json({ error: 'Invalid status — must be one of: ' + validStatuses.join(', ') });
  }

  brewpadIntegration.syncBatchToZoho(soId, batchId, status)
    .then(function (result) {
      res.json(result);
    })
    .catch(function (err) {
      log.error('[batch/sync-zoho] Unexpected error: ' + err.message);
      res.status(500).json({ ok: false, error: 'Internal error' });
    });
  });
});

// Phase 7: Search invoices for batch linking (D-04)
router.get('/api/batch/search-invoices', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped GET (device rejected) — 46-04 interfaces (T-46-18b).
  var search = (req.query.search || '').trim();
  if (!search || search.length < 2) {
    return res.status(400).json({ error: 'Search term must be at least 2 characters' });
  }

  // T-64-01: the list endpoint's `line_items` field is ALWAYS empty (Zoho
  // never populates it on /invoices?search_text=), so matched invoices are
  // detail-fetched below to get real line data — mirroring the search-then-
  // detail pattern at scan-invoices (pos.js:2449). Hard server-side cap
  // (never request-controlled), matching the MAX_PAGES precedent above, so a
  // search never fans out into unbounded ~1/s Zoho calls (Phase-57 WR-02).
  var MAX_DETAIL_FETCH = 10;

  zohoGet('/invoices?search_text=' + encodeURIComponent(search))
    .then(function (data) {
      var matched = (data.invoices || []).slice(0, MAX_DETAIL_FETCH);

      var invoices = [];
      // Sequential chain (NOT Promise.all) to respect the ~1/s Zoho quota.
      var chain = Promise.resolve();
      matched.forEach(function (inv) {
        chain = chain.then(function () {
          return zohoGet('/invoices/' + inv.invoice_id).then(function (detailData) {
            var detail = detailData.invoice || {};
            var lineItems = (detail.line_items || []).map(function (li) {
              return {
                item_id: li.item_id || '',
                name: li.name || li.description || '',
                quantity: li.quantity || 1,
                rate: li.rate || 0,
                amount: li.item_total || li.amount || 0
              };
            });
            invoices.push({
              invoice_id: inv.invoice_id,
              invoice_number: inv.invoice_number,
              customer_name: inv.customer_name,
              customer_id: inv.customer_id || '',
              date: inv.date || '',
              line_items: lineItems
            });
          });
        });
      });

      return chain.then(function () {
        res.json({ invoices: invoices });
      });
    })
    .catch(function (err) {
      log.error('[batch/search-invoices] Zoho error: ' + (err.message || err));
      res.status(502).json({ error: 'Invoice search failed' });
    });
  });
});

// Phase 64/OPS-03: delete-hook — after a batch delete, re-derive ONE invoice's
// cf_batch_status from the live batch set. NEVER trusts a client-supplied status
// value; the label is always recomputed server-side from get_batches (T-64-04/T-64-07).
// POST /api/batch/reconcile-invoice-status
// Body: { zoho_so_number: 'INV-000151' }
router.post('/api/batch/reconcile-invoice-status', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped POST — 46-04 interfaces.
  var body = req.body || {};
  var soNumber = (body.zoho_so_number || '').trim().toUpperCase();
  if (!/^INV-\d+$/.test(soNumber)) {
    return res.status(400).json({ error: 'bad_request', message: 'zoho_so_number must match INV-NNNN format' });
  }

  var cfName = process.env.ZOHO_CF_BATCH_STATUS || 'cf_batch_status';

  Promise.all([
    brewpadIntegration.resolveInvoiceByNumber(soNumber),
    brewpadIntegration.fetchLiveBatchIndex()
  ]).then(function (results) {
    var doc = results[0];
    var liveBatchIndex = results[1];

    if (!doc) {
      return res.status(404).json({ error: 'not_found', message: 'No invoice found with number ' + soNumber });
    }
    if (!liveBatchIndex) {
      // Apps Script unreachable — cannot safely determine the live set; do not write.
      return res.status(502).json({ error: 'batches_unavailable', message: 'Could not read the live batch set' });
    }

    var currentLabel = '';
    (doc.custom_fields || []).forEach(function (cf) {
      if (cf.api_name === cfName) currentLabel = cf.value || '';
    });

    var invoiceForReconcile = {
      invoice_id: doc.invoice_id,
      invoice_number: soNumber,
      cf_batch_status: currentLabel
    };

    return brewpadIntegration.reconcileInvoiceBatchStatus(invoiceForReconcile, liveBatchIndex)
      .then(function (result) {
        eventLog.logEvent('batch.reconcile_invoice_status', {
          invoiceNumber: soNumber,
          action: result.action
        });
        res.json({ ok: !!result.ok, action: result.action, old: result.old, new: result.new });
      });
  }).catch(function (err) {
    log.error('[batch/reconcile-invoice-status] error: ' + (err.message || err));
    res.status(502).json({ error: 'zoho_error', message: 'Failed to reconcile invoice batch status' });
  });
  });
});

// Phase 64/OPS-03: one-time stale-ref cleanup (the INV-000151 class) — pages recent
// invoices, cross-checks each cf_batch_status against the live batch set, and
// clears/re-syncs stale refs. dry_run defaults true (T-64-05); MAX_PAGES is a hard,
// never-request-controlled cap (T-64-05), mirroring scan-invoices (D-01/T-29.3-03).
// POST /api/batch/reconcile-stale-batch-status
// Body: { dry_run: true|false } (default true)
router.post('/api/batch/reconcile-stale-batch-status', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped POST — 46-04 interfaces.
  var body = req.body || {};
  var dryRun = body.dry_run !== false; // default true
  var MAX_PAGES = 4; // hard cap, mirrors scan-invoices (D-01/T-29.3-03) — never request-controlled
  var cfName = process.env.ZOHO_CF_BATCH_STATUS || 'cf_batch_status';

  brewpadIntegration.fetchLiveBatchIndex().then(function (liveBatchIndex) {
    if (!liveBatchIndex) {
      return res.status(502).json({ error: 'batches_unavailable', message: 'Could not read the live batch set' });
    }

    var today = new Date();
    var fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 30);
    var dateStr = fromDate.toISOString().slice(0, 10); // YYYY-MM-DD

    var candidates = [];

    function fetchPage(pg) {
      if (pg > MAX_PAGES) return Promise.resolve();
      return zohoGet('/invoices', {
        sort_column: 'created_time',
        sort_order: 'D',
        date_after: dateStr,
        per_page: 50,
        page: pg
      }).then(function (data) {
        var invoices = data.invoices || [];
        invoices.forEach(function (inv) {
          var label = '';
          (inv.custom_fields || []).forEach(function (cf) {
            if (cf.api_name === cfName) label = cf.value || '';
          });
          if (!label) return; // nothing to reconcile
          candidates.push({
            invoice_id: inv.invoice_id,
            invoice_number: inv.invoice_number,
            cf_batch_status: label
          });
        });

        var hasMore = data.page_context && data.page_context.has_more_page;
        if (hasMore && pg < MAX_PAGES) {
          return fetchPage(pg + 1);
        }
      });
    }

    return fetchPage(1).then(function () {
      // Sequential — same rate-limit discipline as scan-invoices (D-01).
      var report = [];
      var chain = Promise.resolve();
      candidates.forEach(function (inv) {
        chain = chain.then(function () {
          return brewpadIntegration.reconcileInvoiceBatchStatus(inv, liveBatchIndex, { dryRun: dryRun })
            .then(function (result) {
              if (result.action !== 'unchanged') {
                report.push({
                  invoice_number: inv.invoice_number,
                  action: result.action,
                  old: result.old,
                  new: result.new
                });
              }
            });
        });
      });

      return chain.then(function () {
        eventLog.logEvent('batch.reconcile_stale_scan', {
          dryRun: dryRun,
          scanned: candidates.length,
          changed: report.length
        });
        res.json({ dry_run: dryRun, scanned: candidates.length, changes: report });
      });
    });
  }).catch(function (err) {
    log.error('[batch/reconcile-stale-batch-status] error: ' + (err.message || err));
    res.status(502).json({ error: 'zoho_error', message: 'Failed to scan for stale batch status refs' });
  });
  });
});

// Phase 28: Resolve customer details from a Zoho invoice or SO number (D-01..D-16)
router.get('/api/batch/customer-by-number', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped GET (device rejected) — 46-04 interfaces (T-46-18b).
  // CR-01 (plan 29-04): normalize to uppercase so the case-sensitive regexes accept
  // lowercase refs (inv-000123 / so-42) — aligns with the frontend's case-insensitive
  // /^(INV|SO)-\d+$/i gate and the downstream case-insensitive exact-match at line 1409.
  var number = (req.query.number || '').trim().toUpperCase();

  // D-16: validate prefix before any Zoho call
  var isInvoice = /^INV-\d+$/.test(number);
  var isSO      = /^SO-\d+$/.test(number);
  if (!isInvoice && !isSO) {
    return res.status(400).json({ error: 'invalid_number',
      message: 'number must match INV-NNNN or SO-NNNN format' });
  }

  // D-05: route by prefix
  var path        = isInvoice ? '/invoices'         : '/salesorders';
  var filterKey   = isInvoice ? 'invoice_number'    : 'salesorder_number';
  var listKey     = isInvoice ? 'invoices'          : 'salesorders';
  var numberField = isInvoice ? 'invoice_number'    : 'salesorder_number';

  var filterParams = {};
  filterParams[filterKey] = number;

  // Zoho call 1: resolve document by number (D-06 params-object form — NOT string concat)
  zohoGet(path, filterParams)
    .then(function (data) {
      var docs = data[listKey] || [];
      if (docs.length === 0) {
        return res.status(404).json({ error: 'not_found',
          message: 'No document found with number ' + number });
      }

      // D-06 defensive exact-match: iterate docs and select the first whose number
      // equals the requested number case-insensitively (Open Question 3 resolution)
      var doc = null;
      for (var i = 0; i < docs.length; i++) {
        var dn = String(docs[i][numberField] || '');
        if (dn.toLowerCase() === number.toLowerCase()) { doc = docs[i]; break; }
      }
      if (!doc) {
        // Zoho filter matched fuzzily but no exact-number match — treat as not found
        return res.status(404).json({ error: 'not_found',
          message: 'No exact-number match for ' + number });
      }

      var customerId   = doc.customer_id   || '';
      var customerName = doc.customer_name || '';
      var docStatus    = doc.status        || '';

      if (!customerId) {
        // Document resolved but no customer linked — return partial with contact_unavailable
        return res.json({
          customer_name: customerName,
          customer_id: '',
          customer_email: null,
          customer_phone: null,
          document_number: number,
          document_status: docStatus,
          contact_unavailable: true
        });
      }

      // Zoho call 2: contact detail for email/phone (D-07 + D-04)
      return zohoGet('/contacts/' + customerId)
        .then(function (contactData) {
          var contact = contactData.contact || {};
          var persons = contact.contact_persons || [];
          var primary = null;
          for (var j = 0; j < persons.length; j++) {
            if (persons[j].is_primary_contact) { primary = persons[j]; break; }
          }
          if (!primary) { primary = persons[0] || {}; }

          // D-07: top-level contact email, fallback to primary contact_person email
          var email = contact.email || primary.email || null;
          // D-04: phone, fallback to mobile
          var phone = primary.phone || primary.mobile || null;

          return res.json({
            customer_name:   customerName,
            customer_id:     customerId,
            customer_email:  email  || null,
            customer_phone:  phone  || null,
            document_number: number,
            document_status: docStatus
          });
        })
        .catch(function (contactErr) {
          // D-15: contact fetch failed — partial 200 (name/status preserved, email/phone null)
          log.warn('[batch/customer-by-number] Contact fetch failed for ' + customerId
            + ': ' + (contactErr.message || contactErr));
          return res.json({
            customer_name:   customerName,
            customer_id:     customerId,
            customer_email:  null,
            customer_phone:  null,
            document_number: number,
            document_status: docStatus,
            contact_unavailable: true
          });
        });
    })
    .catch(function (err) {
      // D-13: Zoho down/quota/auth failure
      log.error('[batch/customer-by-number] Zoho error: ' + (err.message || err));
      res.status(502).json({ error: 'zoho_error',
        message: 'Failed to retrieve document from Zoho' });
    });
  });
});

// Phase 29.3: Bulk-scan recent Zoho invoices for ferment-in-store sales (Maker's Fee present)
// with no batch yet, and surface them as candidates for batch creation.
// GET /api/batch/scan-invoices
// Optional: ?number=INV-XXXXX => single-invoice mode (D-09)
router.get('/api/batch/scan-invoices', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped GET (device rejected) — 46-04 interfaces (T-46-18b).
  var CF_BATCH_STATUS = process.env.ZOHO_CF_BATCH_STATUS || 'cf_batch_status';
  var MAX_PAGES = 4; // Hard server-side cap (~200 invoices). NEVER read from request (D-01/T-29.3-03).
  var CANDIDATE_STATUSES = { paid: true, sent: true, draft: true }; // void excluded (D-04)

  // --- Single-invoice mode (D-09) ---
  // CR-02 fix: Zoho detail endpoint needs numeric internal ID, not the human-readable number.
  // Use search-then-detail pattern (mirrors /api/batch/customer-by-number at line 1372):
  // 1. Search by invoice_number / salesorder_number to resolve the numeric ID and correct entity type.
  // 2. Detail-fetch using the resolved numeric ID.
  if (req.query.number) {
    var rawNumber = (req.query.number || '').trim().toUpperCase();
    if (!/^(INV|SO)-\d+$/i.test(rawNumber)) {
      return res.status(400).json({ error: 'bad_request', message: 'number must match INV-NNNN or SO-NNNN format' });
    }

    var isInv      = /^INV-/.test(rawNumber);
    var listPath   = isInv ? '/invoices'          : '/salesorders';
    var filterKey  = isInv ? 'invoice_number'     : 'salesorder_number';
    var entityKey  = isInv ? 'invoices'           : 'salesorders';
    var idField    = isInv ? 'invoice_id'         : 'salesorder_id';
    var detailKey  = isInv ? 'invoice'            : 'salesorder';
    var detailPath = isInv ? '/invoices/'         : '/salesorders/';

    var filterParams = {};
    filterParams[filterKey] = rawNumber;

    return zohoGet(listPath, filterParams)
      .then(function (listData) {
        var docs = listData[entityKey] || [];
        var doc = null;
        for (var si = 0; si < docs.length; si++) {
          if (String(docs[si][filterKey] || '').toUpperCase() === rawNumber) { doc = docs[si]; break; }
        }
        if (!doc) {
          return res.json({ candidates: [] });
        }

        return zohoGet(detailPath + doc[idField])
          .then(function (detailData) {
            var inv = detailData[detailKey] || {};
            var lineItems = inv.line_items || [];
            var kitItems = brewpadIntegration.detectKitItems(lineItems);
            if (kitItems.length === 0) {
              return res.json({ candidates: [] });
            }
            return res.json({
              candidates: [{
                invoice_id: doc[idField],
                invoice_number: rawNumber,
                customer_name: inv.customer_name || '',
                customer_id: inv.customer_id || '',
                status: inv.status || '',
                kit_items: kitItems.map(function (k) { return { sku: k.sku || '', name: k.name || '' }; })
              }]
            });
          });
      })
      .catch(function (err) {
        log.warn('[batch/scan-invoices] single-invoice fetch failed for ' + rawNumber + ': ' + err.message);
        return res.status(502).json({ error: 'zoho_error', message: 'Failed to scan invoices from Zoho' });
      });
  }

  // --- Date-window mode ---
  // Step 1: Dedup pre-check (D-10.1) — fetch existing batches from Apps Script
  // CRITICAL: use server_token (not token) — adminApi.gs reads e.parameter.server_token (~line 95)
  // e.parameter.token (~line 402) is Google OAuth-validated and WILL fail for server tokens.
  var existingSoNumbers = {};
  var appsScriptUrl = process.env.APPS_SCRIPT_URL;
  var serverToken = process.env.APPS_SCRIPT_SERVER_TOKEN;

  var dedupPromise;
  if (appsScriptUrl && serverToken) {
    dedupPromise = axios.get(appsScriptUrl, {
      params: { action: 'get_batches', server_token: serverToken, status: 'all' },
      timeout: 12000
    }).then(function (resp) {
      var respData = resp.data || {};
      if (!respData.ok) {
        log.warn('[batch/scan-invoices] get_batches dedup returned ok:false — treating dedup set as empty (D-10.2 is backstop)');
        return;
      }
      var batches = (respData.data && respData.data.batches) || [];
      batches.forEach(function (b) {
        if (b.zoho_so_number) existingSoNumbers[b.zoho_so_number] = true;
      });
    }).catch(function (err) {
      log.warn('[batch/scan-invoices] get_batches dedup failed (non-fatal): ' + err.message + ' — treating dedup set as empty (D-10.2 is backstop)');
    });
  } else {
    dedupPromise = Promise.resolve();
  }

  dedupPromise.then(function () {
    // Step 2: Compute date window (last 30 days)
    var today = new Date();
    var fromDate = new Date(today);
    fromDate.setDate(fromDate.getDate() - 30);
    var dateStr = fromDate.toISOString().slice(0, 10); // YYYY-MM-DD

    // Step 3: Page through Zoho invoices up to MAX_PAGES (hard cap, D-01)
    var allInvoices = [];

    function fetchPage(pg) {
      if (pg > MAX_PAGES) return Promise.resolve();
      return zohoGet('/invoices', {
        sort_column: 'created_time',
        sort_order: 'D',
        date_after: dateStr,
        per_page: 50,
        page: pg
      }).then(function (data) {
        var invoices = data.invoices || [];
        // Filter: candidate statuses only (D-04)
        invoices.forEach(function (inv) {
          if (!CANDIDATE_STATUSES[inv.status]) return; // void excluded
          // cf_batch_status skip (D-02): skip before detail fetch
          var alreadyHasBatch = (inv.custom_fields || []).some(function (cf) {
            return cf.api_name === CF_BATCH_STATUS && cf.value;
          });
          if (alreadyHasBatch) return;
          // Dedup: skip if zoho_so_number already in get_batches result (D-10.1)
          if (existingSoNumbers[inv.invoice_number]) return;
          allInvoices.push(inv);
        });

        var hasMore = data.page_context && data.page_context.has_more_page;
        if (hasMore && pg < MAX_PAGES) {
          return fetchPage(pg + 1);
        }
      });
    }

    return fetchPage(1).then(function () {
      // Step 4: Sequential detail-fetch chain (respect Zoho rate limits — NOT Promise.all)
      var results = [];
      var chain = Promise.resolve();
      allInvoices.forEach(function (inv) {
        chain = chain.then(function () {
          return zohoGet('/invoices/' + inv.invoice_id)
            .then(function (data) {
              var detail = data.invoice || {};
              var lineItems = detail.line_items || [];
              var kitItems = brewpadIntegration.detectKitItems(lineItems);
              if (kitItems.length === 0) return; // No Maker's Fee — not a candidate
              results.push({
                invoice_id: inv.invoice_id,
                invoice_number: inv.invoice_number,
                customer_name: inv.customer_name || '',
                customer_id: inv.customer_id || '',
                status: inv.status,
                kit_items: kitItems.map(function (k) { return { sku: k.sku || '', name: k.name || '' }; })
              });
            })
            .catch(function (err) {
              log.warn('[batch/scan-invoices] detail fetch skipped for ' + inv.invoice_id + ': ' + err.message);
              // Skip candidate — do not abort scan
            });
        });
      });

      return chain.then(function () {
        eventLog.logEvent('batch.scan_invoices', { candidateCount: results.length });
        return res.json({ candidates: results });
      });
    });
  }).catch(function (err) {
    log.error('[batch/scan-invoices] Zoho scan error: ' + err.message);
    return res.status(502).json({ error: 'zoho_error', message: 'Failed to scan invoices from Zoho' });
  });
  });
});

// Phase 29.3: Server-authoritative bulk-create pending batches for confirmed scan candidates.
// POST /api/batch/bulk-create
// Body: { invoice_ids: ['INV-ID-001', ...] } — client supplies ONLY invoice ids (D-06)
router.post('/api/batch/bulk-create', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — 46-04 interfaces.
  var body = req.body || {};
  var invoiceIds = body.invoice_ids;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return res.status(400).json({ error: 'bad_request', message: 'invoice_ids must be a non-empty array' });
  }

  // WR-01 fix: validate each element is a Zoho numeric internal ID (15-20 digits).
  // Rejects path-traversal strings (e.g. '../contacts') and human-readable numbers (INV-000123).
  // Cap at 200 entries to match the scan page-cap (D-01) and prevent quota amplification.
  if (invoiceIds.length > 200) {
    return res.status(400).json({ error: 'bad_request', message: 'invoice_ids must contain 200 or fewer items' });
  }
  var VALID_INVOICE_ID = /^\d{15,20}$/;
  for (var vi = 0; vi < invoiceIds.length; vi++) {
    if (typeof invoiceIds[vi] !== 'string' || !VALID_INVOICE_ID.test(invoiceIds[vi])) {
      return res.status(400).json({ error: 'bad_request',
        message: 'Each invoice_id must be a Zoho numeric ID (15-20 digits)' });
    }
  }

  // Server-authoritative: re-resolve each invoice from Zoho, never trust client batch data (D-06)
  var results = [];
  var chain = Promise.resolve();

  invoiceIds.forEach(function (invoiceId) {
    chain = chain.then(function () {
      return zohoGet('/invoices/' + invoiceId)
        .then(function (data) {
          var inv = data.invoice || {};
          var lineItems = inv.line_items || [];
          var kitItems = brewpadIntegration.detectKitItems(lineItems);

          if (kitItems.length === 0) {
            // No Maker's Fee — cannot create batch
            results.push({ invoice_id: invoiceId, invoice_number: inv.invoice_number || invoiceId, ok: false, error: 'no_kit_items' });
            return;
          }

          var customerName = inv.customer_name || 'Walk-in Customer';
          var customerId = inv.customer_id || '';
          var invoiceNumber = inv.invoice_number || '';
          var nameParts = brewpadIntegration.splitCustomerName(customerName);

          // Fee-slot-capped unit expansion (D-04) — mirrors createBatchesFromSale
          // (lib/brewpad-integration.js:345-410). planKitBatches returns one entry
          // per batch to create, bounded by paid Maker's Fee slots so merchandise
          // on the invoice cannot inflate the count.
          var batchUnits = brewpadIntegration.planKitBatches(lineItems);
          if (batchUnits.length === 0) {
            results.push({ invoice_id: invoiceId, invoice_number: invoiceNumber || invoiceId, ok: false, error: 'no_kit_items' });
            return;
          }

          // How many batches this invoice expects per SKU. The Apps Script dedup
          // guard keys on exactly that pair (zoho_so_number, product_sku), so without
          // this it admits the first unit of a kit line and rejects the rest as
          // duplicates — collapsing a qty-N kit line to a single pending batch
          // (INV-000171, byte-for-byte the already-fixed INV-000137 sale-path bug).
          var unitTotalBySku = {};
          batchUnits.forEach(function (item) {
            var sku = item.sku || item.item_id || '';
            unitTotalBySku[sku] = (unitTotalBySku[sku] || 0) + 1;
          });

          // Per-kit-UNIT creates (D-07, quantity-aware) — sequential within this invoice.
          var kitChain = Promise.resolve();
          var invoiceResults = [];

          batchUnits.forEach(function (item) {
            var sku = item.sku || item.item_id || '';
            var batchPayload = {
              product_sku:        sku,
              product_name:       item.name || '',
              customer_name:      customerName,
              customer_firstname: nameParts.first || '',
              customer_lastname:  nameParts.last  || '',
              customer_id:        customerId,
              source:             'zoho_scan',
              zoho_so_number:     invoiceNumber,
              unit_total:         unitTotalBySku[sku]
              // customer_email omitted — no PII per D-06/T-29.3-06
            };
            kitChain = kitChain.then(function () {
              return brewpadIntegration.callAppsScriptCreateBatch(batchPayload)
                .then(function (result) {
                  // WR-01: the Apps Script guard returns duplicate_so_number when a
                  // (zoho_so_number, product_sku) batch already exists — i.e. this unit
                  // has already converged to its unit_total. That is the desired state,
                  // not a hard failure, so tag it distinctly and keep it out of failCount.
                  var isDuplicate = !!(result && !result.ok && result.error === 'duplicate_so_number');
                  invoiceResults.push({
                    sku: sku,
                    ok: !!(result && result.ok),
                    duplicate: isDuplicate,
                    batch_id: (result && result.batch_id) || undefined,
                    error: (result && !result.ok && result.error) || undefined
                  });
                });
            });
          });

          return kitChain.then(function () {
            // Summarise per-invoice (WR-01). A unit is "satisfied" if it was created
            // (ok) OR already existed (duplicate — benign convergence). The invoice is
            // ok when every unit is satisfied; a genuine failure is a unit that is
            // neither ok nor a duplicate (e.g. Apps Script down, HTTP error).
            var okResults = invoiceResults.filter(function (r) { return r.ok; });
            var satisfied = invoiceResults.filter(function (r) { return r.ok || r.duplicate; });
            var allOk = invoiceResults.length > 0 && satisfied.length === invoiceResults.length;
            var firstError = invoiceResults.find(function (r) { return !r.ok && !r.duplicate; });
            // Converged with nothing newly created (every unit already existed) — flag it
            // so the client can say "already up to date" instead of a spurious failure.
            var allDuplicate = allOk && okResults.length === 0;
            // Sync the invoice's Zoho batch-status field ONCE, with a count when >1
            // (avoids the per-batch last-write-wins overwrite of the single-value field).
            if (inv.invoice_id && okResults.length > 0) {
              brewpadIntegration.syncBatchToZoho(inv.invoice_id, okResults[0].batch_id || '', 'pending', { count: okResults.length })
                .catch(function () {}); // noop — errors queued in brewpad-integration
            }
            results.push({
              invoice_id: invoiceId,
              invoice_number: invoiceNumber,
              ok: allOk,
              duplicate: allDuplicate || undefined,
              batch_id: allOk && invoiceResults[0] ? invoiceResults[0].batch_id : undefined,
              error: firstError ? firstError.error : undefined,
              kit_results: invoiceResults.length > 1 ? invoiceResults : undefined
            });
          });
        })
        .catch(function (err) {
          log.warn('[batch/bulk-create] detail fetch failed for ' + invoiceId + ': ' + err.message);
          results.push({ invoice_id: invoiceId, ok: false, error: 'detail_fetch_failed' });
        });
    });
  });

  chain.then(function () {
    eventLog.logEvent('batch.bulk_create', { total: invoiceIds.length, ok: results.filter(function (r) { return r.ok; }).length });
    return res.json({ results: results });
  }).catch(function (err) {
    log.error('[batch/bulk-create] error: ' + err.message);
    return res.status(502).json({ error: 'zoho_error', message: 'Failed to bulk-create batches' });
  });
  });
});

// Phase 29.1: Search Zoho contacts by name/email/phone for customer type-ahead
router.get('/api/contacts/search', function (req, res) {
  authTiers.requireTiers(['legacy', 'device', 'session'])(req, res, function () {
  // Kiosk-scoped GET (T-46-19) — this route is GET-exempt at the global guard,
  // so it resolves its own tier here (device token allowed alongside legacy/session).
  var term = (req.query.q || '').trim();
  if (!term || term.length < 2) {
    return res.status(400).json({ error: 'Query param q must be at least 2 characters' });
  }

  zohoGet('/contacts', { search_text: term })
    .then(function (data) {
      var raw = data.contacts || [];
      var slim = raw.map(function (c) {
        // Try primary contact_person for email/phone first; fall back to top-level fields
        var persons = c.contact_persons || [];
        var primary = null;
        for (var i = 0; i < persons.length; i++) {
          if (persons[i].is_primary_contact) { primary = persons[i]; break; }
        }
        if (!primary) { primary = persons[0] || {}; }

        var email = c.email || primary.email || '';
        var phone = c.phone || primary.phone || primary.mobile || '';

        return {
          contact_id: c.contact_id || '',
          contact_name: c.contact_name || '',
          email: email,
          phone: phone
        };
      });
      res.json({ contacts: slim });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      // No PII in log (T-29.1-03)
      log.error('[contacts/search] Zoho error: ' + msg);
      res.status(502).json({ error: 'Contact search failed' });
    });
  });
});

// Phase 29.1: Reassign the customer on a batch and propagate to the linked Zoho SO/invoice (D-02/D-03/D-05)
router.post('/api/batch/reassign-customer', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — 46-04 interfaces.
  var body = req.body || {};
  var batchId = body.batch_id;
  var soNumber = body.zoho_so_number || null;   // may be absent (D-03)
  var customer = body.customer || {};
  var expectedVersion = body.expectedVersion;

  if (!batchId) {
    return res.status(400).json({ error: 'Missing batch_id' });
  }
  // WR-05: whitespace-only name must not pass validation (trims to empty downstream)
  var trimmedCustomerName = (customer.name || '').trim();
  if (!trimmedCustomerName && !customer.contact_id) {
    return res.status(400).json({ error: 'Missing customer: provide name or contact_id' });
  }

  // Step 1: Resolve or create the Zoho contact
  // If contact_id provided, use directly; otherwise lookup-or-create (D-02)
  var resolveContact;
  if (customer.contact_id) {
    // Use provided contact_id directly — split name for batch field population
    var name = (customer.name || '').trim();
    var parts = name ? name.split(/\s+/) : [];
    var firstName = parts.length ? parts[0] : name;
    var lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
    resolveContact = Promise.resolve({
      contactId: customer.contact_id,
      customerName: name,
      firstName: firstName,
      lastName: lastName,
      email: customer.email || '',
      phone: customer.phone || ''
    });
  } else {
    var custName = (customer.name || '').trim();
    var custEmail = (customer.email || '').trim();
    var custPhone = (customer.phone || '').trim();
    var cparts = custName ? custName.split(/\s+/) : [];
    var cFirstName = cparts.length ? cparts[0] : custName;
    var cLastName = cparts.length > 1 ? cparts.slice(1).join(' ') : '';

    // Lookup-or-create: search by email first (mirrors checkout.js resolveCustomerId)
    var contactLookup;
    if (custEmail) {
      contactLookup = zohoGet('/contacts', { email: custEmail })
        .then(function (data) {
          var contacts = data.contacts || [];
          if (contacts.length > 0) {
            return contacts[0].contact_id;
          }
          // Not found — create
          var payload = buildContactPayload(custName, custEmail, custPhone);
          return zohoPost('/contacts', payload)
            .then(function (createData) {
              // WR-02: guard against 2xx response with no contact_id (no batch/Zoho write without a real id)
              var newId = (createData.contact || {}).contact_id;
              if (!newId) { throw new Error('Contact created but no contact_id returned'); }
              return newId;
            })
            .catch(function (createErr) {
              // Duplicate name — fall back to name search (mirrors checkout.js)
              if (createErr.response && createErr.response.status === 400) {
                return zohoGet('/contacts', { contact_name: custName })
                  .then(function (nameData) {
                    var nameContacts = nameData.contacts || [];
                    if (nameContacts.length > 0) {
                      return nameContacts[0].contact_id;
                    }
                    throw createErr;
                  });
              }
              throw createErr;
            });
        });
    } else {
      // No email — search by name only
      contactLookup = zohoGet('/contacts', { contact_name: custName })
        .then(function (data) {
          var contacts = data.contacts || [];
          if (contacts.length > 0) {
            return contacts[0].contact_id;
          }
          // Create without email
          var payload = buildContactPayload(custName, custEmail, custPhone);
          return zohoPost('/contacts', payload)
            .then(function (createData) {
              // WR-02: guard against 2xx response with no contact_id (no batch/Zoho write without a real id)
              var newId = (createData.contact || {}).contact_id;
              if (!newId) { throw new Error('Contact created but no contact_id returned'); }
              return newId;
            });
        });
    }

    resolveContact = contactLookup.then(function (contactId) {
      return {
        contactId: contactId,
        customerName: custName,
        firstName: cFirstName,
        lastName: cLastName,
        email: custEmail,
        phone: custPhone
      };
    });
  }

  resolveContact
    .then(function (resolved) {
      var contactId = resolved.contactId;
      var customerName = resolved.customerName;
      var customerFirstName = resolved.firstName;
      var customerLastName = resolved.lastName;
      var customerEmail = resolved.email;
      var customerPhone = resolved.phone;

      // Step 2: Update batch via Apps Script update_batch with optimistic lock (T-29.1-02)
      var appsScriptUrl = process.env.APPS_SCRIPT_URL;
      var appsScriptToken = process.env.APPS_SCRIPT_SERVER_TOKEN;

      var updatePayload = {
        action: 'update_batch',
        server_token: appsScriptToken,
        batch_id: batchId,
        expectedVersion: expectedVersion,
        updates: {
          customer_id: contactId,
          customer_name: customerName,
          customer_firstname: customerFirstName,
          customer_lastname: customerLastName,
          customer_email: customerEmail,
          customer_phone: customerPhone
        }
      };

      return axios.post(appsScriptUrl, JSON.stringify(updatePayload), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000,
        maxRedirects: 5
      }).then(function (resp) {
        var result = resp.data || {};

        // Version conflict — stop before any Zoho push (T-29.1-02)
        if (!result.ok && result.error === 'version_conflict') {
          return res.status(409).json({
            error: 'version_conflict',
            message: result.message || 'Batch was modified by another user. Refresh and try again.'
          });
        }

        var newVersion = (result.data && result.data.last_updated) || null;

        // Step 3: If zoho_so_number present, resolve the SO/INV internal ID and push customer_id (D-03/D-05)
        if (!soNumber) {
          // D-03: batch-only — no Zoho push
          eventLog.logEvent('batch.customer_reassigned', {
            batchId: batchId,
            newCustomerId: contactId,
            newCustomerName: customerName,
            zohoUpdated: false
          });
          return res.json({ ok: true, batch_updated: true, new_version: newVersion });
        }

        // Resolve internal SO/INV id from number (mirrors customer-by-number lookup)
        var soUpperCase = soNumber.toUpperCase();

        // WR-01: validate order ref format BEFORE any Zoho call (mirrors the
        // customer-by-number endpoint's /^(INV|SO)-\d+$/ gate). A malformed value
        // would otherwise waste a Zoho query and fall through to a misleading
        // "document not found" warning. Surface the invalid input as a warning
        // (batch is already updated at this point — D-05 contract).
        if (!/^INV-\d+$/.test(soUpperCase) && !/^SO-\d+$/.test(soUpperCase)) {
          eventLog.logEvent('batch.customer_reassigned', {
            batchId: batchId,
            newCustomerId: contactId,
            newCustomerName: customerName,
            zohoUpdated: false,
            zohoWarning: 'Invalid order reference: ' + soNumber
          });
          return res.json({
            ok: true,
            batch_updated: true,
            zoho_warning: 'Invalid order reference: ' + soNumber,
            new_version: newVersion
          });
        }

        var isInvoice = /^INV-\d+$/.test(soUpperCase);
        var docPath = isInvoice ? '/invoices' : '/salesorders';
        var filterKey = isInvoice ? 'invoice_number' : 'salesorder_number';
        var listKey = isInvoice ? 'invoices' : 'salesorders';
        var idField = isInvoice ? 'invoice_id' : 'salesorder_id';
        var numberField = isInvoice ? 'invoice_number' : 'salesorder_number';

        var filterParams = {};
        filterParams[filterKey] = soUpperCase;

        return zohoGet(docPath, filterParams)
          .then(function (docData) {
            var docs = docData[listKey] || [];
            var doc = null;
            for (var i = 0; i < docs.length; i++) {
              var dn = String(docs[i][numberField] || '');
              if (dn.toLowerCase() === soUpperCase.toLowerCase()) { doc = docs[i]; break; }
            }

            var docId = doc ? doc[idField] : null;
            if (!docId) {
              // Doc not found — batch already updated, warn
              eventLog.logEvent('batch.customer_reassigned', {
                batchId: batchId,
                newCustomerId: contactId,
                newCustomerName: customerName,
                zohoUpdated: false,
                zohoWarning: 'Zoho document ' + soNumber + ' not found'
              });
              return res.json({
                ok: true,
                batch_updated: true,
                zoho_warning: 'Zoho document ' + soNumber + ' not found',
                new_version: newVersion
              });
            }

            // Attempt to update customer_id on the Zoho document
            return zohoPut(docPath + '/' + docId, { customer_id: contactId })
              .then(function () {
                eventLog.logEvent('batch.customer_reassigned', {
                  batchId: batchId,
                  newCustomerId: contactId,
                  newCustomerName: customerName,
                  zohoUpdated: true
                });
                return res.json({
                  ok: true,
                  batch_updated: true,
                  zoho_updated: true,
                  new_version: newVersion
                });
              })
              .catch(function (putErr) {
                // D-05: Zoho rejection — batch change stands, surface as warning (T-29.1-05)
                var putMsg = putErr.message;
                if (putErr.response && putErr.response.data) {
                  putMsg = putErr.response.data.message || putErr.response.data.error || putMsg;
                }
                log.error('[batch/reassign-customer] Zoho PUT failed (D-05): ' + putMsg);
                eventLog.logEvent('batch.customer_reassigned', {
                  batchId: batchId,
                  newCustomerId: contactId,
                  newCustomerName: customerName,
                  zohoUpdated: false,
                  zohoWarning: putMsg
                });
                return res.json({
                  ok: true,
                  batch_updated: true,
                  zoho_warning: putMsg,
                  new_version: newVersion
                });
              });
          });
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      log.error('[batch/reassign-customer] Error: ' + msg);
      res.status(500).json({ ok: false, error: 'Internal error: ' + msg });
    });
  });
});

// ---------------------------------------------------------------------------
// Stamp bottling_invite_sent_at + bottling_invite_email onto the batch record
// via Apps Script update_batch, so staff can see when a customer was last invited
// and avoid double-pinging them. Advisory only: fired fire-and-forget after the
// email is already sent, with no optimistic lock. A failure (or a Batches sheet
// still missing the columns — writes are silently skipped there) is logged but
// never surfaced to the caller. Returns a promise that always resolves.
function stampBottlingInviteSent(batchId, email, sentAt) {
  var appsScriptUrl = process.env.APPS_SCRIPT_URL;
  if (!appsScriptUrl) return Promise.resolve();

  var payload = {
    action: 'update_batch',
    server_token: process.env.APPS_SCRIPT_SERVER_TOKEN,
    batch_id: batchId,
    updates: {
      bottling_invite_sent_at: sentAt,
      bottling_invite_email: email
    }
  };

  // Promise.resolve().then wraps axios.post so a synchronous throw / undefined
  // return (e.g. under a jest mock) is still funnelled into the .catch.
  return Promise.resolve()
    .then(function () {
      return axios.post(appsScriptUrl, JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000,
        maxRedirects: 5
      });
    })
    .then(function (resp) {
      var result = (resp && resp.data) || {};
      if (result.ok === false) {
        log.warn('[batch/bottling-invite] stamp update_batch failed for ' + batchId + ': ' + (result.error || 'unknown'));
      }
    })
    .catch(function (err) {
      log.warn('[batch/bottling-invite] stamp update_batch threw for ' + batchId + ': ' + (err && err.message));
    });
}

// POST /api/batch/bottling-invite
// Send a bottling-appointment invite email to the customer with a pre-filled
// Cal.com booking link. Routes through Resend (not Apps Script MailApp) so it
// works from Railway where outbound SMTP is blocked. After a successful send it
// stamps bottling_invite_sent_at onto the batch (advisory, fire-and-forget).
// Auth: x-api-key header (same as all /api/batch/* siblings).
// ---------------------------------------------------------------------------
router.post('/api/batch/bottling-invite', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — 46-04 interfaces.
  var body = req.body || {};
  var name = (body.name || '').trim();
  var email = (body.email || '').trim();
  var batchId = (body.batchId || '').trim();
  var productName = (body.productName || '').trim();

  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid or missing email' });
  }
  if (!batchId) {
    return res.status(400).json({ error: 'Missing batchId' });
  }

  mailer.sendBottlingInvite({ name: name, email: email, batchId: batchId, productName: productName })
    .then(function () {
      var sentAt = new Date().toISOString();
      eventLog.logEvent('batch.bottling_invite_sent', { batchId: batchId });
      // Fire-and-forget: don't make the email's success wait on (or fail with) the stamp.
      stampBottlingInviteSent(batchId, email, sentAt);
      res.json({ success: true, sent_at: sentAt });
    })
    .catch(function (err) {
      log.error('[batch/bottling-invite] Send failed: ' + err.message);
      res.status(500).json({ error: 'Failed to send bottling invite' });
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 76-02: single allow-listed Apps-Script proxy for BrewPad's batch/
// dashboard/reading/schedule reads AND writes (D-76). Session/legacy tier
// only (device excluded — BrewPad is session-scoped, not kiosk-scoped).
//
// Hardcoded allow-list — NEVER a free-form req.body.action passthrough
// (T-76-02-01). Any action not a key here is rejected 400 invalid_action
// before Apps Script is ever called. create_batch/update_batch_schedule are
// live BrewPad write flows (js/brewpad.js) and MUST stay present.
// ---------------------------------------------------------------------------
var ADMIN_PROXY_ACTIONS = {
  // reads
  get_batch: true,
  get_batches: true,
  get_batch_dashboard_summary: true,
  get_vessels: true,
  get_ferm_schedules: true,
  get_tasks_upcoming: true,
  get_waitlist: true,
  // writes
  create_batch: true,
  update_batch: true,
  update_batch_schedule: true,
  delete_batch: true,
  bulk_add_plato_readings: true,
  bulk_update_batch_tasks: true,
  update_plato_reading: true,
  delete_plato_reading: true,
  create_ferm_schedule: true,
  update_ferm_schedule: true,
  delete_ferm_schedule: true,
  update_waitlist_status: true
};

// Reads must be forwarded to Apps Script as GET (doGet has a generic server_token
// bypass that dispatches every read via handleReadAction). Forwarding a read as
// POST hits doPost's server_token if-chain, which only allow-lists WRITE actions,
// so the read falls through to invalid_action ("Unknown server action: get_...").
// (Phase 76 hotfix — the original proxy POSTed every action.)
var ADMIN_PROXY_READS = {
  get_batch: true,
  get_batches: true,
  get_batch_dashboard_summary: true,
  get_vessels: true,
  get_ferm_schedules: true,
  get_tasks_upcoming: true,
  get_waitlist: true
};

router.post('/api/batch/admin-proxy', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // BrewPad/session-scoped (device rejected) — T-76-02-03.
  var body = req.body || {};
  var action = (body.action || '').toLowerCase();
  if (!ADMIN_PROXY_ACTIONS[action]) {
    return res.status(400).json({ ok: false, error: 'invalid_action' });
  }

  // T-76-02-02: identity is proven solely by requireTiers above — never
  // accept a client-supplied Google token as a fallback identity.
  var payload = Object.assign({}, body, {
    action: action,
    server_token: process.env.APPS_SCRIPT_SERVER_TOKEN
  });
  delete payload.token;

  var upstream = ADMIN_PROXY_READS[action]
    ? axios.get(process.env.APPS_SCRIPT_URL, {
        params: payload,
        timeout: 15000,
        maxRedirects: 5
      })
    : axios.post(process.env.APPS_SCRIPT_URL, JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        maxRedirects: 5
      });

  upstream
    .then(function (resp) {
      res.json(resp.data);
    })
    .catch(function (err) {
      log.error('[batch/admin-proxy] ' + action + ' failed: ' + (err && err.message));
      res.status(502).json({ ok: false, error: 'server_error' });
    });
  });
});

/**
 * GET /api/kiosk/salesorder/:id
 * Fetch a single Sales Order detail from Zoho, including line_items.
 * The list endpoint (/salesorders) does not return line_items.
 */
router.get('/api/kiosk/salesorder/:id', function (req, res) {
  authTiers.requireTiers(['legacy', 'device', 'session'])(req, res, function () {
  // D-09: individual order detail also exposes PII — kiosk-scoped, device token
  // allowed (46-04 interfaces). Inline tier resolution used (rather than server.js
  // PII_GET_ROUTES list) because Express path-pattern matching is required for :id params.
  var soId = req.params.id;
  if (!soId || typeof soId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid salesorder_id' });
  }

  zohoGet('/salesorders/' + soId)
    .then(function (data) {
      var so = data.salesorder || {};
      res.json({
        salesorder_id: so.salesorder_id || '',
        salesorder_number: so.salesorder_number || '',
        customer_name: so.customer_name || '',
        customer_id: so.customer_id || '',
        balance: so.balance || 0,
        total: so.total || 0,
        status: so.status || '',
        date: so.date || '',
        line_items: (so.line_items || []).map(function (li) {
          return {
            item_id: li.item_id || '',
            name: li.name || li.description || '',
            quantity: li.quantity || 1,
            rate: li.rate || 0,
            amount: li.item_total || li.amount || 0
          };
        })
      });
    })
    .catch(function (err) {
      var msg = err.message;
      if (err.response && err.response.data) {
        msg = err.response.data.message || err.response.data.error || msg;
      }
      log.error('[kiosk/so-detail] Zoho error: ' + msg);
      res.status(502).json({ error: 'Failed to fetch sales order' });
    });
  });
});

module.exports = router;
// Exposed for unit testing (pure-ish helpers)
module.exports.resolveDiscount = resolveDiscount;
module.exports.computeTax = computeTax;
module.exports.resolveGstTaxId = resolveGstTaxId;

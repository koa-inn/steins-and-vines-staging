'use strict';

var express = require('express');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var helcimLib = require('../lib/helcim');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
var mailer = require('../lib/mailer');
var C = require('../lib/constants');
var kioskSaleCatalog = require('../lib/kiosk-sale-catalog');
var brewpadIntegration = require('../lib/brewpad-integration');
var scaling = require('../lib/recipe-scaling');
var moneyPath = require('../lib/money-path');
var recipeStore = require('../lib/recipe-store');
var recipeMirror = require('../lib/recipe-mirror');
var sheetMirror = require('../lib/sheet-mirror');
var dualWriteCompare = require('../lib/dual-write-compare');
var sentryCapture = require('../lib/sentry-capture');

var zohoPost = zohoApi.zohoPost;
var zohoPut = zohoApi.zohoPut;

var router = express.Router();

// M12 (D-13 parity): 7-day TTL for the recipe-sale pending-charge record —
// mirrors KIOSK_PENDING_CHARGE_TTL in routes/pos.js.
var KIOSK_PENDING_CHARGE_TTL = 604800;

// Same file routes/catalog.js writes on every ingredients refresh (and reads
// on a cold admin request). zoho:ingredients:all has a 1 h TTL but is only
// warmed at 05:00/13:00 UTC or by an admin page, so without this fallback
// quote, sale and the post-charge confirm 503 for most of the day.
var INGREDIENTS_ALL_FILE_CACHE = path.join(__dirname, '..', 'ingredients-all-cache.json');

/** Read a Zoho custom field off a catalog entry (same rule as routes/recipes.js readCF). */
function snapshotIngredientType(entry, apiName) {
  var cfs = entry && entry.custom_fields;
  if (!Array.isArray(cfs)) return '';
  for (var i = 0; i < cfs.length; i++) {
    if (cfs[i] && cfs[i].api_name === apiName) return cfs[i].value_formatted || cfs[i].value || '';
  }
  return '';
}

/** Copies of the scaled ingredients with cf_type / cf_subcategory from the catalog (originals untouched). */
function typedSnapshotIngredients(list, catalogMap) {
  return (list || []).map(function (ing) {
    var entry = catalogMap[ing.item_id];
    var copy = {};
    Object.keys(ing).forEach(function (k) { copy[k] = ing[k]; });
    copy.cf_type = (entry && (entry.cf_type || snapshotIngredientType(entry, 'cf_type'))) || '';
    copy.cf_subcategory = snapshotIngredientType(entry, 'cf_subcategory');
    return copy;
  });
}

/** Target gravity for the snapshot: finite number, else null. */
function snapshotGravity(v) {
  if (v === undefined || v === null || v === '') return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/** Full ingredient catalog: Redis first, then the file cache; null when neither has an array. */
function getIngredientCatalog() {
  return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
    if (Array.isArray(catalog)) return catalog;
    var fileCatalog = null;
    try {
      fileCatalog = JSON.parse(fs.readFileSync(INGREDIENTS_ALL_FILE_CACHE, 'utf8'));
    } catch {
      fileCatalog = null;
    }
    if (!Array.isArray(fileCatalog)) return null;
    log.warn('[pos-recipe] Ingredient catalog not in Redis; using file cache (' + fileCatalog.length + ' items)');
    return fileCatalog;
  });
}

// ---------------------------------------------------------------------------
// Recipe discount helpers
//
// Recipe sales decompose into a PRODUCT portion (locked_price × scale, or the
// summed scaled ingredient costs) and a fixed FEE portion (service + materials
// in-store; milling take-out). A discount preset targets these via tokens:
//   scope 'cart'  → whole recipe (product + fees)
//   scope 'type'  → 'recipe' token discounts the product portion;
//                   'service' token discounts the fee portion; both → whole.
// The customer charge is always grandTotal − discountAmount (exact). On the
// Zoho invoice the discount is distributed per-line across the targeted lines
// (capped per line) — exact for dynamic recipes; best-effort for locked
// recipes where locked_price already decouples from the catalog line sum.
// ---------------------------------------------------------------------------

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function loadDiscountPreset(presetId) {
  if (!presetId) return Promise.resolve(null);
  return cache.get(C.CACHE_KEYS.KIOSK_DISCOUNT_PRESETS).then(function (presets) {
    presets = Array.isArray(presets) ? presets : [];
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === presetId) return presets[i];
    }
    return null;
  });
}

// Compute the discount amount + discounted total for a recipe sale.
// Returns { error, status } on a bad preset, or
// { discountAmount, total, base, discountApplied }.
function computeRecipeDiscount(preset, grandTotal, feePortion) {
  if (!preset.active) return { error: 'Discount preset is inactive', status: 400 };
  var productPortion = round2(grandTotal - feePortion);
  var base = 0;
  if (preset.scope === 'cart') {
    base = grandTotal;
  } else if (preset.scope === 'type') {
    var at = preset.applies_to || [];
    if (at.indexOf('recipe') !== -1) base += productPortion;
    if (at.indexOf('service') !== -1) base += feePortion;
    base = round2(base);
  } else {
    return { error: 'Unsupported discount scope — please recreate this preset', status: 400 };
  }

  var amount;
  if (preset.type === 'percentage') {
    amount = round2(base * preset.value / 100);
  } else {
    amount = round2(Math.min(preset.value, base));
  }

  return {
    discountAmount: amount,
    total: round2(grandTotal - amount),
    base: base,
    discountApplied: {
      preset_id: preset.id,
      name: preset.name,
      type: preset.type,
      value: preset.value,
      scope: preset.scope,
      applies_to: preset.scope === 'type' ? preset.applies_to : undefined,
      amount: amount
    }
  };
}

// Distribute a recipe discount across invoice line items as per-line li.discount
// (numbers), proportional to each targeted line's total and capped at it.
function distributeRecipeDiscount(lineItems, feeItemIds, preset, discountAmount) {
  if (!discountAmount || discountAmount <= 0) return;
  var targetProduct = preset.scope === 'cart' ||
    (preset.scope === 'type' && (preset.applies_to || []).indexOf('recipe') !== -1);
  var targetService = preset.scope === 'cart' ||
    (preset.scope === 'type' && (preset.applies_to || []).indexOf('service') !== -1);

  var targetedIdx = [];
  var totalTargeted = 0;
  lineItems.forEach(function (li, i) {
    var isFee = feeItemIds.indexOf(li.item_id) !== -1;
    if ((isFee && targetService) || (!isFee && targetProduct)) {
      targetedIdx.push(i);
      totalTargeted += (Number(li.quantity) || 0) * (Number(li.rate) || 0);
    }
  });
  totalTargeted = round2(totalTargeted);
  if (targetedIdx.length === 0 || totalTargeted <= 0) return;

  var remaining = discountAmount;
  targetedIdx.forEach(function (idx, k) {
    var li = lineItems[idx];
    var lt = round2((Number(li.quantity) || 0) * (Number(li.rate) || 0));
    var share;
    if (k === targetedIdx.length - 1) {
      share = remaining; // last line absorbs rounding remainder
    } else {
      share = round2(discountAmount * (lt / totalTargeted));
      remaining = round2(remaining - share);
    }
    if (share > lt) share = lt; // never drive a line negative
    if (share > 0) li.discount = share;
  });
}

// ---------------------------------------------------------------------------
// Recipe invoice lines + fee tax (2026-10-13, owner decision: tax recipe fees
// like kit sales). ONE builder feeds both the quote (what the terminal is
// charged) and the confirm (what Zoho is invoiced), so the taxed lines cannot
// drift between the two legs.
// ---------------------------------------------------------------------------

function recipeFeeItemIds() {
  return [
    process.env.MAKERS_FEE_ITEM_ID,
    process.env.MATERIALS_FEE_ITEM_ID,
    process.env.MILLING_FEE_ITEM_ID
  ].filter(Boolean);
}

// Build the Zoho invoice line items for a scaled recipe. Ingredient lines use
// CONVERTED quantities (SCALE-04, INV-01, D-01/D-02 — the converted number is
// what Zoho decrements: 12 g hop -> 0.012 kg). Returns { lineItems } or
// { unpriceable: '<error>' } (D-02 tiered fail-closed), or
// { millingNotConfigured: true } for a milled take-out with no milling item.
function buildRecipeLineItems(recipe, scaledIngredients, catalogMap, saleType, millGrain) {
  var lineItems = [];
  for (var i = 0; i < scaledIngredients.length; i++) {
    var ing = scaledIngredients[i];
    var catalogEntry = catalogMap[ing.item_id];
    var li;
    if (catalogEntry) {
      var ingResult = scaling.ingredientLineCost(catalogEntry, ing);
      if (!ingResult.ok) return { unpriceable: ingResult.error };
      li = {
        item_id: ing.item_id,
        name: ing.item_name,
        // Zoho stores quantities to 3 decimals (2.3 g = 0.0023 kg is kept as
        // 0.002); line math on the unrounded quantity mispredicts its total.
        quantity: Math.round(ingResult.convertedQty * 1000) / 1000,
        rate: Number(catalogEntry.rate) || 0
      };
      if (catalogEntry.tax_id) {
        li.tax_id = catalogEntry.tax_id;
      }
    } else {
      // Unknown item — not in catalog (T-36-07 tolerated elsewhere); push
      // at face value rather than fail-closed. D-02 guards UNIT
      // mismatches on items we recognize, not unrecognised item_ids.
      li = {
        item_id: ing.item_id,
        name: ing.item_name,
        quantity: Number(ing.quantity) || 0,
        rate: 0
      };
    }
    lineItems.push(li);
  }

  // Fee line items (always added to the invoice for record-keeping)
  if (saleType === 'in-store') {
    if (process.env.MAKERS_FEE_ITEM_ID) {
      lineItems.push({ item_id: process.env.MAKERS_FEE_ITEM_ID, name: 'Brewing Fee', quantity: 1, rate: Number(recipe.service_fee) || 0 });
    }
    if (process.env.MATERIALS_FEE_ITEM_ID) {
      lineItems.push({ item_id: process.env.MATERIALS_FEE_ITEM_ID, name: 'Materials Fee', quantity: 1, rate: Number(recipe.materials_fee) || 0 });
    }
  } else if (saleType === 'take-out' && millGrain) {
    if (!process.env.MILLING_FEE_ITEM_ID) return { millingNotConfigured: true };
    var millingEntry = catalogMap[process.env.MILLING_FEE_ITEM_ID];
    lineItems.push({
      item_id: process.env.MILLING_FEE_ITEM_ID,
      name: 'Milling Fee',
      quantity: 1,
      rate: millingEntry ? (Number(millingEntry.rate) || 0) : 0
    });
  }
  return { lineItems: lineItems };
}

// Zoho computes invoice line totals itself (it kept a -0.02 line the server
// floors to 0 and may round quantity/rate differently), so the invoice total
// can differ from the charge by a few cents. A payment larger than the
// balance is rejected, leaving the sale charged but unpaid. After creating
// the invoice, read the total Zoho returned and re-balance the adjustment
// (an untaxed line) to the charge. Fails closed: a gap too large to be
// rounding, a failed update, or an update that still does not balance
// rejects, and the caller voids the card.
var RECIPE_RECONCILE_MAX_GAP = 1.00;

function reconcileRecipeInvoice(invoiceData, invoicePayload, grandTotal) {
  var invoice = (invoiceData && invoiceData.invoice) || {};
  var zohoTotal = Number(invoice.total);
  if (invoice.total === undefined || invoice.total === null || !isFinite(zohoTotal)) {
    log.warn('[pos-recipe/confirm] Zoho returned no invoice total — cannot reconcile');
    return Promise.resolve(invoiceData);
  }
  var gap = round2(grandTotal - zohoTotal);
  if (Math.abs(gap) < 0.005) return Promise.resolve(invoiceData);
  log.warn('[pos-recipe/confirm] Invoice ' + invoice.invoice_number + ' total ' + zohoTotal +
    ' != charge ' + grandTotal + ' — re-balancing adjustment by ' + gap);
  if (Math.abs(gap) > RECIPE_RECONCILE_MAX_GAP) {
    return Promise.reject(new Error('Invoice total ' + zohoTotal + ' differs from charge ' + grandTotal + ' by more than rounding'));
  }
  var updated = Object.assign({}, invoicePayload, {
    adjustment: round2((Number(invoicePayload.adjustment) || 0) + gap),
    adjustment_description: 'Recipe package price'
  });
  // Re-send the lines exactly as Zoho created them: a line without its
  // tax_id is re-defaulted on update (Materials Fee 12% became GST 5% on
  // INV-000238), which moves the tax and defeats the re-balance.
  if (Array.isArray(invoice.line_items) && invoice.line_items.length) {
    updated.line_items = invoice.line_items.map(function (li) {
      return {
        line_item_id: li.line_item_id,
        item_id: li.item_id,
        name: li.name,
        quantity: li.quantity,
        rate: li.rate,
        discount: li.discount,
        tax_id: li.tax_id
      };
    });
  }
  return zohoPut('/invoices/' + invoice.invoice_id, updated).then(function (putData) {
    var newTotal = Number(putData && putData.invoice && putData.invoice.total);
    if (!isFinite(newTotal) || Math.abs(newTotal - grandTotal) >= 0.005) {
      throw new Error('Invoice total ' + newTotal + ' still differs from charge ' + grandTotal + ' after re-balancing');
    }
    return invoiceData;
  });
}

// Taxable amount of a line as Zoho computes it: the line amount rounded to
// cents, less its (already cent-rounded) discount.
function recipeLineAmount(li) {
  return Math.max(round2(round2((Number(li.quantity) || 0) * (Number(li.rate) || 0)) - (Number(li.discount) || 0)), 0);
}

// Fee items are services, which the ingredient catalog excludes; their Zoho
// tax lives on the kiosk products catalog — the same source kit sales tax the
// Makers Fee from (routes/catalog.js rebuildKioskCatalog on a cache miss).
// Follow-up to 261029-zq1: resolved through lib/kiosk-sale-catalog, so a
// failed rebuild (quota exhausted, outage) falls back to the last-good kiosk
// catalog instead of an empty map. Resolves { map, source, staleAt }.
function getFeeCatalogMap() {
  return kioskSaleCatalog.getKioskCatalogForSale().then(function (resolved) {
    var map = {};
    (Array.isArray(resolved.items) ? resolved.items : []).forEach(function (p) {
      if (p && p.item_id) map[p.item_id] = p;
    });
    if (resolved.source === 'stale') {
      log.warn('[pos-recipe] Kiosk catalog rebuild failed (' +
        (resolved.rebuildError && resolved.rebuildError.message) +
        ') — fee tax from last-good kiosk catalog of ' + (resolved.staleAt || 'unknown'));
    }
    return { map: map, source: resolved.source, staleAt: resolved.staleAt };
  });
}

// Tax for recipe invoice lines, mirroring pos.js computeTax: per-line rate
// from the catalog, grouped by rate, each group rounded on its own (the Zoho
// org's entity_level rounding), never a guessed rate. Fee lines take their
// rate from the kiosk catalog and fail closed when it cannot be resolved;
// ingredient lines resolve as kit lines do (an untaxed tax_id-tagged line is
// 0%). Resolves { taxTotal } or { error } — the fee catalog is only read when
// a fee line actually carries an amount.
function computeRecipeTax(lineItems, catalogMap) {
  var feeIds = recipeFeeItemIds();
  var needsFees = lineItems.some(function (li) {
    return feeIds.indexOf(li.item_id) !== -1 && recipeLineAmount(li) > 0;
  });
  var feeMapPromise = needsFees
    ? getFeeCatalogMap().catch(function () { return { map: {}, source: null }; })
    : Promise.resolve({ map: {}, source: null });
  return feeMapPromise.then(function (feeResolved) {
    var feeMap = feeResolved.map;
    var taxByRate = {};
    for (var i = 0; i < lineItems.length; i++) {
      var li = lineItems[i];
      var amount = recipeLineAmount(li);
      if (amount <= 0) continue;
      var pct;
      if (feeIds.indexOf(li.item_id) !== -1) {
        var fee = feeMap[li.item_id];
        pct = fee ? parseFloat(fee.tax_percentage) : NaN;
        if (isNaN(pct)) {
          return { error: 'Cannot determine tax for "' + li.name + '" — its Zoho item has no tax rate or the product list is unavailable. Refresh the product list and try again.' };
        }
      } else {
        var entry = catalogMap[li.item_id];
        pct = entry ? parseFloat(entry.tax_percentage) : 0;
        if (isNaN(pct)) {
          if (!entry.tax_id) {
            return { error: 'Cannot determine tax for "' + (entry.name || li.name) + '" — no tax rate configured for this item. Refresh the product list or fix the item in Zoho.' };
          }
          pct = 0;
        }
      }
      taxByRate[String(pct)] = (taxByRate[String(pct)] || 0) + amount * (pct / 100);
    }
    var taxTotal = 0;
    Object.keys(taxByRate).forEach(function (k) { taxTotal += round2(taxByRate[k]); });
    var taxOut = { taxTotal: round2(taxTotal) };
    if (feeResolved.source === 'stale') taxOut.catalogSource = 'stale';
    return taxOut;
  });
}

// ---------------------------------------------------------------------------
// computeRecipeQuote — shared helper (35-06, extended 36-03)
// Fetches recipe, validates target_volume_l, reads INGREDIENTS_ALL catalog,
// scales ingredients, checks stock, and computes the authoritative grand total.
// Returns a Promise that resolves to the computed quote object, or rejects with
// an object { status, body } that the caller can forward as an HTTP response.
//
// Params:
//   recipeId           {string}         — recipe ID to fetch from Apps Script
//   rawTarget          {*}              — target_volume_l from request (body or query); undefined/null/'' => default to base
//   saleType           {string}         — 'in-store' | 'take-out'
//   millGrain          {boolean}        — whether to add milling fee (take-out only)
//   modifiedIngredients {Array|undefined} — optional pre-scale modified base list (MOD-02, 36-03);
//                                         when present, prices via computeModifiedRecipeTotal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D-05 dual price compare (Phase 85, production + RECIPES_STORE=dual only)
//
// Every real quote/sale is priced a second time from the recipe read back
// through the sheet path; any difference goes to Sentry via dual-write-compare.
// D-06: the sale ALWAYS charges the Postgres price. This compare is
// observational: fire-and-forget, never awaited, never throws into the route.
// ---------------------------------------------------------------------------

var DUAL_PRICE_SETTLE_MS = 60000;
var SHEET_RECIPE_MEMO_MS = 5000;
var DIRTY_ALERT_MS = 10 * 60 * 1000;
var DIRTY_ALERT_THROTTLE_MS = 60 * 60 * 1000;

var dualPriceStats = { compared: 0, skipped_settle: 0, skipped_dirty: 0, sheet_failed: 0 };
var dirtySince = {};
var dirtyAlertedAt = {};
var sheetRecipeMemo = {};

function _dualPriceStats() {
  return {
    compared: dualPriceStats.compared,
    skipped_settle: dualPriceStats.skipped_settle,
    skipped_dirty: dualPriceStats.skipped_dirty,
    sheet_failed: dualPriceStats.sheet_failed
  };
}

function _resetDualPriceStats() {
  dualPriceStats.compared = 0;
  dualPriceStats.skipped_settle = 0;
  dualPriceStats.skipped_dirty = 0;
  dualPriceStats.sheet_failed = 0;
  dirtySince = {};
  dirtyAlertedAt = {};
  sheetRecipeMemo = {};
}

function skippedTotal() {
  return dualPriceStats.skipped_settle + dualPriceStats.skipped_dirty;
}

function totalsSuffix() {
  return ' compared=' + dualPriceStats.compared + ' skipped=' + skippedTotal() +
    ' sheet_failed=' + dualPriceStats.sheet_failed;
}

function settleOutcome(promise) {
  return Promise.resolve(promise).then(
    function (value) { return { ok: true, value: value }; },
    function (err) { return { ok: false, err: err }; }
  );
}

/** Price projection compared across stores: totals, mode, scale and line item/qty/unit only. */
function projectPrice(outcome) {
  if (!outcome.ok) {
    var e = outcome.err;
    var msg = e && e.body && e.body.error ? e.body.error : ((e && e.message) || String(e));
    return {
      status: (e && e.status) || null, error: msg, pricingMode: null, baseVol: null,
      targetVolumeL: null, scaleFactor: null, grandTotal: null, totalBeforeDiscount: null,
      feePortion: null, discountTotal: null, lines: []
    };
  }
  var r = outcome.value;
  return {
    status: null,
    error: null,
    pricingMode: r.pricingMode,
    baseVol: r.baseVol,
    targetVolumeL: r.targetVolumeL,
    scaleFactor: r.scaleFactor,
    grandTotal: r.grandTotal,
    totalBeforeDiscount: r.totalBeforeDiscount,
    feePortion: r.feePortion,
    discountTotal: r.discount && r.discount.discountAmount !== undefined ? r.discount.discountAmount : null,
    lines: (r.scaledIngredients || []).map(function (l) {
      return { item_id: l.item_id, quantity: l.quantity, unit: l.unit };
    })
  };
}

function cloneJson(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function memoSheetRecipe(recipeId) {
  var now = Date.now();
  var hit = sheetRecipeMemo[recipeId];
  if (hit && now - hit.at < SHEET_RECIPE_MEMO_MS) return hit.promise;
  var p = Promise.resolve().then(function () {
    return recipeStore.getFromSheet(recipeId);
  });
  sheetRecipeMemo[recipeId] = { promise: p, at: now };
  p.catch(function () {
    if (sheetRecipeMemo[recipeId] && sheetRecipeMemo[recipeId].promise === p) delete sheetRecipeMemo[recipeId];
  });
  return p;
}

function clearDirtyState(recipeId) {
  delete dirtySince[recipeId];
  delete dirtyAlertedAt[recipeId];
}

function noteDirtySkip(recipeId) {
  var now = Date.now();
  if (!dirtySince[recipeId]) {
    dirtySince[recipeId] = now;
    return;
  }
  var dirtyMs = now - dirtySince[recipeId];
  if (dirtyMs <= DIRTY_ALERT_MS) return;
  if (dirtyAlertedAt[recipeId] && now - dirtyAlertedAt[recipeId] < DIRTY_ALERT_THROTTLE_MS) return;
  dirtyAlertedAt[recipeId] = now;
  var minutes = Math.round(dirtyMs / 60000);
  sentryCapture.captureExceptionSafe(
    new Error('[dual-price] recipe ' + recipeId + ' dirty > 10 min — D-05 compare skipped'),
    {
      level: 'warning',
      tags: { component: 'recipes-dual-price' },
      extra: { recipe_id: recipeId, dirty_minutes: minutes }
    }
  );
}

/**
 * @param {string} op        'quote' | 'sale'
 * @param {string} recipeId
 * @param {Object} pgData    recipe-store.get result (Postgres, authoritative)
 * @param {Array}  args      [rawTarget, saleType, millGrain, modifiedIngredients, discountReq]
 * @param {Promise|null} pgOutcomePromise  settled Postgres price; null => price a clone of pgData
 */
function scheduleDualPriceCompare(op, recipeId, pgData, args, pgOutcomePromise) {
  try {
    if (recipeStore.getMode() !== 'dual') return;
    var pgClone = pgOutcomePromise ? null : cloneJson(pgData);
    var updatedAt = pgData && pgData.data && pgData.data.recipe ? pgData.data.recipe.updated_at : null;
    sheetMirror.mirrorFireAndForget('recipes.price', function () {
      var updatedMs = updatedAt ? new Date(updatedAt).getTime() : NaN;
      if (!isNaN(updatedMs) && Date.now() - updatedMs < DUAL_PRICE_SETTLE_MS) {
        dualPriceStats.skipped_settle++;
        clearDirtyState(recipeId);
        log.info('[dual-price] skip recipe=' + recipeId + ' op=' + op + ' reason=settle' + totalsSuffix());
        return undefined;
      }
      return recipeMirror.isDirty(recipeId).then(function (dirty) {
        if (dirty) {
          dualPriceStats.skipped_dirty++;
          noteDirtySkip(recipeId);
          log.info('[dual-price] skip recipe=' + recipeId + ' op=' + op + ' reason=dirty' + totalsSuffix());
          return undefined;
        }
        clearDirtyState(recipeId);
        return memoSheetRecipe(recipeId).then(function (sheetData) {
          if (!sheetData || sheetData.ok === false) {
            throw new Error('sheet recipe read failed for ' + recipeId);
          }
          return sheetData;
        }).then(function (sheetData) {
          var sheetOutcomeP = settleOutcome(priceRecipe(cloneJson(sheetData), args[0], args[1], args[2], args[3], args[4]));
          var pgOutcomeP = pgOutcomePromise
            ? settleOutcome(pgOutcomePromise)
            : settleOutcome(priceRecipe(pgClone, args[0], args[1], args[2], args[3], args[4]));
          return Promise.all([sheetOutcomeP, pgOutcomeP]);
        }, function (err) {
          dualPriceStats.sheet_failed++;
          log.warn('[dual-price] sheet read failed recipe=' + recipeId + ' op=' + op + totalsSuffix());
          throw err; // gate reports as a sheet-mirror warning, never a price mismatch
        }).then(function (pair) {
          dualWriteCompare.compareAndReport({
            store: 'recipes',
            operation: op,
            sheets: projectPrice(pair[0]),
            postgres: projectPrice(pair[1]),
            reportValuesFor: ['grandTotal', 'totalBeforeDiscount', 'feePortion', 'discountTotal', 'quantity', 'scaleFactor']
          });
          dualPriceStats.compared++;
          log.info('[dual-price] compared recipe=' + recipeId + ' op=' + op + totalsSuffix());
        });
      });
    });
  } catch (err) {
    log.warn('[dual-price] schedule failed recipe=' + recipeId + ': ' + ((err && err.message) || String(err)));
  }
}

function loadRecipe(recipeId) {
  return recipeStore.get(recipeId);
}

function priceRecipe(data, rawTarget, saleType, millGrain, modifiedIngredients, discountReq) {
  if (!data || !data.ok || !data.data || !data.data.recipe) {
    return Promise.reject({ status: 404, body: { error: 'Recipe not found' } });
  }
  var recipe = data.data.recipe;
  var ingredients = data.data.ingredients || [];

  if (recipe.status !== 'active') {
    return Promise.reject({ status: 400, body: { error: 'Recipe is not active' } });
  }

  // Validate batch_size_l and target_volume_l (D-11)
  var baseVol = Number(recipe.batch_size_l) || 0;
  if (baseVol <= 0) {
    return Promise.reject({ status: 400, body: { error: 'Recipe has no base batch size set. Cannot scale.' } });
  }

  // Default target_volume_l to batch_size_l if absent/blank (=> scale_factor 1.0, backward compat D-05)
  var targetVolumeL = (rawTarget === undefined || rawTarget === null || rawTarget === '')
    ? baseVol
    : Number(rawTarget);

  if (isNaN(targetVolumeL) || targetVolumeL <= 0) {
    return Promise.reject({ status: 400, body: { error: 'target_volume_l must be > 0' } });
  }
  if (targetVolumeL > baseVol * 10) {
    return Promise.reject({ status: 400, body: { error: 'target_volume_l exceeds maximum (10x base)' } });
  }

  var scaleFactor = targetVolumeL / baseVol;
  recipe._scale_factor = scaleFactor;

  // Determine pricing mode for logging/response
  var hasLockedPrice = Number(recipe.locked_price) > 0;
  var pricingMode = recipe.pricing_mode || (hasLockedPrice ? 'locked' : 'dynamic');

  // MOD-02 (36-03): determine which ingredient list to scale for stock check + response
  // When modifiedIngredients is provided, the response ingredient list reflects the modified list;
  // the server fetched originalIngredients (ingredients) are still used for locked-add detection.
  var isModified = Array.isArray(modifiedIngredients);
  var baseIngredients = isModified ? modifiedIngredients : ingredients;

  return getIngredientCatalog().then(function (ingredientCatalog) {
    if (!ingredientCatalog || !Array.isArray(ingredientCatalog)) {
      return Promise.reject({ status: 503, body: { error: 'Ingredient catalog not available — try again shortly' } });
    }

    // Build item_id -> catalog entry lookup
    var catalogMap = {};
    ingredientCatalog.forEach(function (item) {
      if (item && item.item_id) catalogMap[item.item_id] = item;
    });

    // Scale the base ingredient list (modified or original) for stock check + response
    var scaledIngredients = scaling.scaleIngredients(baseIngredients, scaleFactor);

    // D-02 tiered fail-closed (PRE-CHARGE): every catalog-matched line must
    // convert cleanly to its item's unit BEFORE any terminal charge is
    // attempted. This runs regardless of pricing_mode — a LOCKED recipe's
    // grand total never sums ingredient costs, so without this pass a bad
    // unit on a base ingredient would only surface later at the invoice
    // build (post-charge). Mirrors the resolveGstTaxId precedent (pos.js):
    // resolve-or-fail in a separate pass, never inside a downstream .map().
    // Items absent from the catalog are skipped (T-36-07 — unknown items
    // are already tolerated elsewhere; this guards UNIT mismatches only).
    for (var pcI = 0; pcI < scaledIngredients.length; pcI++) {
      var pcEntry = catalogMap[scaledIngredients[pcI].item_id];
      if (pcEntry) {
        var pcCheck = scaling.ingredientLineCost(pcEntry, scaledIngredients[pcI]);
        if (!pcCheck.ok) {
          return Promise.reject({ status: 422, body: { error: pcCheck.error } });
        }
      }
    }

    // Stock check (D-08) — always run on the scaled (potentially modified) list
    var stockCheck = scaling.checkScaledStock(scaledIngredients, catalogMap);

    // Re-price via tested helper (SCALE-03, D-04/D-05/D-07)
    // MOD-02 (36-03): when modified list present, use computeModifiedRecipeTotal (server-authoritative)
    var grandTotal;
    if (isModified) {
      grandTotal = scaling.computeModifiedRecipeTotal(recipe, ingredients, modifiedIngredients, catalogMap, scaleFactor, saleType);
    } else {
      grandTotal = scaling.computeScaledRecipeTotal(recipe, scaledIngredients, catalogMap, saleType);
    }

    // Take-out milling fee — added on top of helper result (helper does not know about milling)
    var millingFeeAdded = 0;
    if (saleType === 'take-out' && millGrain) {
      if (!process.env.MILLING_FEE_ITEM_ID) {
        return Promise.reject({ status: 400, body: { error: 'Milling fee not configured. Contact admin.' } });
      }
      var millingEntry = catalogMap[process.env.MILLING_FEE_ITEM_ID];
      if (millingEntry) {
        millingFeeAdded = Number(millingEntry.rate) || 0;
        grandTotal += millingFeeAdded;
        grandTotal = Math.round(grandTotal * 100) / 100;
      }
    }

    // Fixed fee portion (never scaled): service + materials in-store, milling take-out
    var feePortion = 0;
    if (saleType === 'in-store') {
      feePortion += (Number(recipe.service_fee) || 0) + (Number(recipe.materials_fee) || 0);
    }
    feePortion += millingFeeAdded;
    feePortion = round2(feePortion);

    var totalBeforeDiscount = grandTotal;

    var baseResult = {
      recipe: recipe,
      ingredients: ingredients,
      baseVol: baseVol,
      targetVolumeL: targetVolumeL,
      scaleFactor: scaleFactor,
      pricingMode: pricingMode,
      catalogMap: catalogMap,
      scaledIngredients: scaledIngredients,
      stockCheck: stockCheck,
      grandTotal: grandTotal,
      totalBeforeDiscount: totalBeforeDiscount,
      feePortion: feePortion,
      discount: null,
      isModified: isModified
    };

    // Fee tax (owner decision 2026-10-13): tax the same invoice lines the
    // confirm leg books, after the discount is spread over them. grandTotal
    // stays the pre-tax package total; chargeTotal is what the terminal takes.
    function withRecipeTax(preset, disc) {
      var built = buildRecipeLineItems(recipe, scaledIngredients, catalogMap, saleType, millGrain);
      if (built.unpriceable) return Promise.reject({ status: 422, body: { error: built.unpriceable } });
      if (built.millingNotConfigured) {
        return Promise.reject({ status: 400, body: { error: 'Milling fee not configured. Contact admin.' } });
      }
      if (preset && disc) distributeRecipeDiscount(built.lineItems, recipeFeeItemIds(), preset, disc.discountAmount);
      return computeRecipeTax(built.lineItems, catalogMap).then(function (taxResult) {
        if (taxResult.error) return Promise.reject({ status: 400, body: { error: taxResult.error } });
        baseResult.taxTotal = taxResult.taxTotal;
        baseResult.chargeTotal = round2(baseResult.grandTotal + taxResult.taxTotal);
        return baseResult;
      });
    }

    // Apply discount (if any). Server-authoritative — preset re-read from cache.
    if (discountReq && discountReq.preset_id) {
      return loadDiscountPreset(discountReq.preset_id).then(function (preset) {
        if (!preset) return Promise.reject({ status: 400, body: { error: 'Discount preset not found' } });
        var disc = computeRecipeDiscount(preset, grandTotal, feePortion);
        if (disc.error) return Promise.reject({ status: disc.status, body: { error: disc.error } });
        baseResult.grandTotal = disc.total;
        baseResult.discount = disc;
        return withRecipeTax(preset, disc);
      });
    }

    return withRecipeTax(null, null);
  });
}

function computeRecipeQuote(recipeId, rawTarget, saleType, millGrain, modifiedIngredients, discountReq, compareOp) {
  return loadRecipe(recipeId).then(function (data) {
    var outcome = priceRecipe(data, rawTarget, saleType, millGrain, modifiedIngredients, discountReq);
    // D-06: the sale always uses the Postgres price; this compare is observational only.
    scheduleDualPriceCompare(compareOp || 'quote', recipeId, data,
      [rawTarget, saleType, millGrain, modifiedIngredients, discountReq], outcome);
    return outcome;
  });
}

// ---------------------------------------------------------------------------
// POST /api/kiosk/recipe-sale
// Initiate a recipe sale: validate, compute total, acquire mutex, push to terminal.
// ---------------------------------------------------------------------------

router.post('/api/kiosk/recipe-sale', function (req, res) {
  // Feature gate (D-13, KSK-04): BEER_SALES_ENABLED must be 'true'
  if ((process.env.BEER_SALES_ENABLED || 'false').toLowerCase() !== 'true') {
    return res.status(403).json({ error: 'Recipe sales are not enabled' });
  }

  // Terminal must be configured
  if (!helcimLib.isTerminalEnabled()) {
    return res.status(503).json({ error: 'POS terminal not configured' });
  }

  var body = req.body || {};

  // Input validation
  if (!body.recipe_id || typeof body.recipe_id !== 'string' || !body.recipe_id.trim()) {
    return res.status(400).json({ error: 'Missing recipe_id' });
  }
  if (body.sale_type !== 'in-store' && body.sale_type !== 'take-out') {
    return res.status(400).json({ error: 'sale_type must be in-store or take-out' });
  }
  var millGrain = body.mill_grain === true;
  // MOD-02 (36-03): pass modified_ingredients to pricing helper if provided (array from JSON body)
  var modifiedIngredients = Array.isArray(body.modified_ingredients) ? body.modified_ingredients : undefined;
  var discountReq = (body.discount && body.discount.preset_id) ? body.discount : null;

  // D-50-06 (M12): idempotency gate — a DISTINCT duplicate-charge guard from
  // the RECIPE_SALE inventory mutex below (D-04/INV-02, unchanged). Acquired
  // BEFORE computeRecipeQuote so a duplicate fails fast without burning a
  // Zoho quote call. Required in production (mirrors pos.js:341-349); the
  // kiosk client has always sent this key on this route, so there is no
  // stale-client outage risk (unlike salesorder-pay's D-50-01 fallback).
  var idempotencyKey = (body.idempotency_key && typeof body.idempotency_key === 'string')
    ? C.CACHE_KEYS.KIOSK_IDEM_PREFIX + body.idempotency_key.slice(0, 128)
    : null;

  if (!idempotencyKey && process.env.NODE_ENV === 'production') {
    return res.status(400).json({ error: 'idempotency_key is required' });
  }

  if (idempotencyKey) {
    return moneyPath.acquireIdempotencyLock(cache, idempotencyKey, moneyPath.CHECKOUT_IDEMPOTENCY_TTL)
      .then(function (lockResult) {
        if (lockResult.status === 'replay') {
          log.info('[pos-recipe/recipe-sale] Idempotent replay: ' + idempotencyKey);
          return res.status(202).json(lockResult.cached);
        }
        if (lockResult.status === 'contention' || lockResult.status === 'failclosed') {
          return res.status(409).json({ error: 'Recipe sale already in progress — please wait and check the order before retrying' });
        }
        // status === 'acquired' — proceed
        _runRecipeSale(body, idempotencyKey, millGrain, modifiedIngredients, discountReq, req, res);
      });
  }

  _runRecipeSale(body, null, millGrain, modifiedIngredients, discountReq, req, res);
});

function _runRecipeSale(body, idempotencyKey, millGrain, modifiedIngredients, discountReq, req, res) {
  computeRecipeQuote(body.recipe_id, body.target_volume_l, body.sale_type, millGrain, modifiedIngredients, discountReq, 'sale')
    .then(function (quote) {
      // The terminal is charged the taxed total (fee tax, 2026-10-13).
      var grandTotal = quote.chargeTotal;
      var scaleFactor = quote.scaleFactor;
      var targetVolumeL = quote.targetVolumeL;
      var pricingMode = quote.pricingMode;

      // Stock gate: scaled quantities vs stock_on_hand (D-08)
      if (!quote.stockCheck.ok && !body.override) {
        return res.status(409).json({
          error: 'Insufficient stock for scaled batch',
          conflicts: quote.stockCheck.conflicts
        });
      }

      log.info('[recipe-sale] target_volume_l=' + targetVolumeL + ' base_vol=' + quote.baseVol + ' scale_factor=' + scaleFactor);
      log.info('[recipe-sale] pricing_mode=' + pricingMode + ' (raw=' + quote.recipe.pricing_mode + ') locked_price=' + quote.recipe.locked_price);
      log.info('[recipe-sale] grandTotal=' + grandTotal + ' pricingMode=' + pricingMode);

      // --- Phase 67 review fix (WR-04): recipe quote-vs-charge divergence
      // DETECTOR. The kiosk now sends its displayed totals with recipe sales
      // (same optional field names as /api/kiosk/sale). Unlike the standard
      // sale path this comparison is deliberately LOG-ONLY (never a blocking
      // 400). The server total now includes fee tax (2026-10-13) and the
      // kiosk displays the quote's tax_total, but a kiosk still running
      // cached pre-tax JS would display less — so divergence stays LOUD in
      // logs + the event stream without risking a checkout outage. Client
      // totals are never trusted for pricing.
      if (typeof body.client_grand_total === 'number' && isFinite(body.client_grand_total) &&
          Math.abs(body.client_grand_total - grandTotal) > 0.01) {
        var recipeMismatchDelta = Math.round((body.client_grand_total - grandTotal) * 100) / 100;
        log.error('[pos-recipe/recipe-sale] recipe pre-charge total mismatch (log-only): client_grand_total=' + body.client_grand_total +
          ' client_tax_total=' + body.client_tax_total +
          ' server_grand_total=' + grandTotal +
          ' delta=' + recipeMismatchDelta + ' recipe_id=' + body.recipe_id +
          ' pricing_mode=' + pricingMode + ' scale_factor=' + scaleFactor);
        eventLog.logEvent('kiosk.recipe_total_mismatch', {
          client_grand_total: body.client_grand_total,
          client_tax_total: (typeof body.client_tax_total === 'number' && isFinite(body.client_tax_total))
            ? body.client_tax_total : null,
          server_grand_total: grandTotal,
          delta: recipeMismatchDelta,
          recipe_id: body.recipe_id,
          pricing_mode: pricingMode,
          scale_factor: scaleFactor
        });
      }

      // Acquire Redis mutex before terminal push (D-04, INV-02)
      cache.acquireLock(C.LOCK_KEYS.RECIPE_SALE, 30).then(function (acquired) {
        if (!acquired) {
          return res.status(503).json({ error: 'Another recipe sale in progress — try again in a moment.' });
        }

        // Use the kiosk's reference (mirrors pos.js:803) — /confirm keys the
        // pending-charge sentinel, the invoice reference and the manual-confirm
        // terminal poll on body.reference, which the kiosk sets to this value.
        // A server-minted ref here left the sentinel uncleared and unpollable.
        var refNumber = (body.reference_number && typeof body.reference_number === 'string')
          ? body.reference_number.slice(0, 64)
          : ('RECIPE-' + Date.now());

        // D-50-06a: derive the Helcim terminal idempotency key deterministically
        // from the client idempotency_key (mirrors pos.js:870-872) so Helcim
        // itself refuses a duplicate charge even if the Redis lock is bypassed.
        var helcimIdemKey = (body.idempotency_key && typeof body.idempotency_key === 'string')
          ? crypto.createHash('sha256').update(body.idempotency_key).digest('hex').substring(0, 25)
          : null;

        // Push to terminal
        helcimLib.terminalPurchase(grandTotal, refNumber, helcimIdemKey)
          .then(function () {
            var responseBody = {
              pending: true,
              reference: refNumber,
              recipe_id: body.recipe_id,
              sale_type: body.sale_type,
              mill_grain: millGrain,
              total: grandTotal,
              total_before_tax: quote.grandTotal,
              tax_total: quote.taxTotal,
              total_before_discount: quote.totalBeforeDiscount,
              discount: quote.discount ? quote.discount.discountApplied : null,
              scale_factor: scaleFactor,
              target_volume_l: targetVolumeL
            };

            // M12: pending-charge record so an orphaned recipe charge is
            // reconcilable — mirrors pos.js:881-892 (D-13/SC#4). Fire-and-forget.
            var pendingCacheKey = C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + refNumber;
            var pendingContext = {
              reference_number: refNumber,
              amount: grandTotal,
              idempotency_key: (body.idempotency_key && typeof body.idempotency_key === 'string')
                ? body.idempotency_key : null,
              created_at: new Date().toISOString()
            };
            cache.set(pendingCacheKey, pendingContext, KIOSK_PENDING_CHARGE_TTL).catch(function () {});

            var cacheWrite = idempotencyKey
              ? cache.set(idempotencyKey, responseBody, moneyPath.CHECKOUT_IDEMPOTENCY_TTL).catch(function () {})
              : Promise.resolve();

            cacheWrite.then(function () {
              res.status(202).json(responseBody);
            });
          })
          .catch(function (termErr) {
            log.error('[pos-recipe/recipe-sale] Terminal push failed: ' + termErr.message);
            // Release locks on terminal failure (Pitfall 1) — no charge was
            // taken, so a retry under a fresh idempotency lock is safe.
            cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
            if (idempotencyKey) {
              cache.releaseLock(idempotencyKey).catch(function () {});
            }
            res.status(502).json({ error: 'Terminal error — please try again' });
          });
      }).catch(function (lockErr) {
        log.error('[pos-recipe/recipe-sale] Lock acquisition error: ' + lockErr.message);
        res.status(503).json({ error: 'Service temporarily unavailable — try again in a moment.' });
      });
    })
    .catch(function (err) {
      if (err && err.status) {
        return res.status(err.status).json(err.body);
      }
      log.error('[pos-recipe/recipe-sale] Error: ' + (err && err.message));
      res.status(502).json({ error: 'Failed to fetch recipe. Please try again.' });
    });
}

// ---------------------------------------------------------------------------
// GET /api/kiosk/recipe-quote
// Dry-run quote: compute scale+price+stock with NO terminal charge, lock, or invoice.
// Query params: recipe_id, target_volume_l (optional, defaults to base), sale_type
// ---------------------------------------------------------------------------

router.get('/api/kiosk/recipe-quote', function (req, res) {
  // Feature gate (D-13, KSK-04): mirrors recipe-sale gate
  if ((process.env.BEER_SALES_ENABLED || 'false').toLowerCase() !== 'true') {
    return res.status(403).json({ error: 'Recipe sales are not enabled' });
  }

  var query = req.query || {};
  var recipeId = query.recipe_id;
  var saleType = query.sale_type || 'in-store';

  if (!recipeId || typeof recipeId !== 'string' || !recipeId.trim()) {
    return res.status(400).json({ error: 'Missing recipe_id' });
  }

  // MOD-02 (36-03): parse optional modified_ingredients JSON-encoded array from query string
  // Malformed JSON is silently treated as null (unmodified quote) — no 500 (T-36-09 safe)
  var modifiedIngredients = null;
  if (query.modified_ingredients) {
    try {
      modifiedIngredients = JSON.parse(query.modified_ingredients);
      if (!Array.isArray(modifiedIngredients)) modifiedIngredients = null;
    } catch {
      modifiedIngredients = null;
    }
  }

  var discountReq = query.discount_preset_id ? { preset_id: query.discount_preset_id } : null;

  computeRecipeQuote(recipeId, query.target_volume_l, saleType, false, modifiedIngredients, discountReq)
    .then(function (quote) {
      var catalogMap = quote.catalogMap;

      // Build enriched ingredient list for the response.
      // MOD-02 (36-03): when modified, scaledIngredients reflects the SCALED MODIFIED list.
      // base_quantity is looked up from the modified list (pre-scale), not the original recipe.
      var baseList = modifiedIngredients || quote.ingredients;
      var ingredientList = quote.scaledIngredients.map(function (scaled) {
        // Find the pre-scale quantity from the base list (modified or original)
        var baseEntry = null;
        for (var i = 0; i < baseList.length; i++) {
          if (baseList[i].item_id === scaled.item_id) {
            baseEntry = baseList[i];
            break;
          }
        }
        var baseQty = baseEntry ? (Number(baseEntry.quantity) || 0) : 0;
        var catalogEntry = catalogMap[scaled.item_id];
        var rate = catalogEntry ? (Number(catalogEntry.rate) || 0) : 0;
        var scaledQty = Number(scaled.quantity) || 0;
        // D-01/D-02: line_total is the unit-converted cost (the pre-charge
        // validation pass above already guaranteed every catalog-matched line
        // converts cleanly, so this call cannot ok:false here).
        var lineTotal = catalogEntry ? scaling.ingredientLineCost(catalogEntry, scaled).cost : 0;
        return {
          item_id: scaled.item_id,
          item_name: scaled.item_name,
          unit: scaled.unit,
          base_quantity: baseQty,
          quantity: scaledQty,
          rate: rate,
          line_total: lineTotal
        };
      });

      log.info('[recipe-quote] recipe_id=' + recipeId + ' target_volume_l=' + quote.targetVolumeL + ' scale_factor=' + quote.scaleFactor + ' total=' + quote.grandTotal + ' is_modified=' + quote.isModified);

      res.status(200).json({
        ok: true,
        recipe_id: recipeId,
        base_volume_l: quote.baseVol,
        target_volume_l: quote.targetVolumeL,
        scale_factor: quote.scaleFactor,
        pricing_mode: quote.pricingMode,
        total: quote.grandTotal,
        // Fee tax (2026-10-13): `total` stays the pre-tax package total the
        // kiosk shows as a price; the terminal charges total_with_tax.
        tax_total: quote.taxTotal,
        total_with_tax: quote.chargeTotal,
        total_before_discount: quote.totalBeforeDiscount,
        discount: quote.discount ? quote.discount.discountApplied : null,
        is_modified: quote.isModified,
        ingredients: ingredientList,
        stock: {
          ok: quote.stockCheck.ok,
          conflicts: quote.stockCheck.conflicts
        }
      });
    })
    .catch(function (err) {
      if (err && err.status) {
        return res.status(err.status).json(err.body);
      }
      log.error('[pos-recipe/recipe-quote] Error: ' + (err && err.message));
      res.status(502).json({ error: 'Failed to fetch recipe. Please try again.' });
    });
});

// ---------------------------------------------------------------------------
// POST /api/kiosk/recipe-sale/confirm
// After terminal payment confirmed: re-validate, create invoice, bust caches,
// fire-and-forget batch creation.
// ---------------------------------------------------------------------------

router.post('/api/kiosk/recipe-sale/confirm', function (req, res) {
  // Feature gate (D-13, KSK-04)
  if ((process.env.BEER_SALES_ENABLED || 'false').toLowerCase() !== 'true') {
    return res.status(403).json({ error: 'Recipe sales are not enabled' });
  }

  var body = req.body || {};

  // Helcim transaction ids are integers, and /api/kiosk/sale/status passes them
  // through as JSON numbers to the kiosk's auto-confirm. Normalise to a string so
  // the validation below never bare-400s a real, already-charged sale.
  if (typeof body.transaction_id === 'number' && isFinite(body.transaction_id)) {
    body.transaction_id = String(body.transaction_id);
  }

  // Input validation
  if (!body.recipe_id || typeof body.recipe_id !== 'string' || !body.recipe_id.trim()) {
    return res.status(400).json({ error: 'Missing recipe_id' });
  }
  if (!body.transaction_id || typeof body.transaction_id !== 'string' || !body.transaction_id.trim()) {
    return res.status(400).json({ error: 'Missing transaction_id' });
  }
  if (!body.reference || typeof body.reference !== 'string' || !body.reference.trim()) {
    return res.status(400).json({ error: 'Missing reference' });
  }

  // CR-01 fix: confirm-level idempotency so replays return the cached receipt
  // without creating a second invoice.  Seed derived from body.idempotency_key,
  // falling back to body.transaction_id, then body.reference.  NEVER bare-400:
  // the terminal was already charged; a bare 400 would orphan the charge.
  var _confirmSeed = (typeof body.idempotency_key === 'string' && body.idempotency_key)
    ? body.idempotency_key
    : (typeof body.transaction_id === 'string' && body.transaction_id)
      ? body.transaction_id
      : body.reference;
  var confirmIdemKey = _confirmSeed
    ? C.CACHE_KEYS.KIOSK_IDEM_PREFIX + 'confirm:' + String(_confirmSeed).slice(0, 128)
    : null;

  if (confirmIdemKey) {
    return moneyPath.acquireIdempotencyLock(cache, confirmIdemKey, moneyPath.CHECKOUT_IDEMPOTENCY_TTL)
      .then(function (lockResult) {
        if (lockResult.status === 'replay') {
          log.info('[pos-recipe/recipe-sale/confirm] Idempotent replay: ' + confirmIdemKey);
          return res.status(201).json(lockResult.cached);
        }
        if (lockResult.status === 'contention' || lockResult.status === 'failclosed') {
          return res.status(409).json({ error: 'Confirm already in progress — please wait before retrying' });
        }
        // status === 'acquired' — proceed
        _runRecipeConfirm(body, confirmIdemKey, req, res);
      })
      .catch(function (err) {
        log.error('[pos-recipe/recipe-sale/confirm] Idempotency lock error: ' + err.message);
        _runRecipeConfirm(body, null, req, res); // proceed without lock on unexpected error
      });
  }

  _runRecipeConfirm(body, null, req, res);
});

// T-50-28 (audit H5/L18): shared void-on-failure helper for the recipe
// confirm leg. Routes EVERY confirm-leg void through moneyPath.voidWithTimeout
// via a single _voidFailed-tracking shim (mirrors pos.js:1839-1870 /
// :2615-2646) — BOTH confirm-leg failure branches (unpriceable ingredient
// line, invoice-creation failure) call this ONE helper, so
// helcimLib.voidTransaction appears exactly once in this file (inside the
// shim), never as a raw route-level call outside the primitive. An
// unconfirmed void (50-01: helcimLib.voidTransaction rejects with
// err.isUnconfirmedVoid) now alerts staff via the primitive instead of being
// silently swallowed by a bare .catch.
//
// @param {string} txnId  - Helcim transaction ID to void
// @param {number} amount - order amount for the alert payload (0 when unknown,
//                          matching pos.js's own confirm-outer-catch precedent)
// @param {object} req    - Express request (for req.id passthrough)
// @returns {Promise<{voidFailed: boolean}>}
function _voidRecipeTxnWithTimeout(txnId, amount, req) {
  var voidFailed = false;
  var helcimForVoid = {
    voidTransaction: function (id) {
      return helcimLib.voidTransaction(id).catch(function (voidErr) {
        voidFailed = true;
        var failRecord = {
          txnId: txnId,
          amount: amount,
          timestamp: new Date().toISOString(),
          error: voidErr.message,
          needs_manual_review: true
        };
        cache.set('sv:void-failure:' + Date.now(), failRecord, 60 * 60 * 24 * 30).catch(function () {});
        throw voidErr; // re-throw so voidWithTimeout's CRITICAL log + mailer alert fires
      });
    }
  };
  return moneyPath.voidWithTimeout(helcimForVoid, txnId, amount, {
    mailer: mailer,
    eventLog: eventLog,
    reqId: req && req.id
  }).then(function () {
    return { voidFailed: voidFailed };
  });
}

// F2 parity (mirrors pos.js verifyManualCharge): a manual confirm carries the
// literal 'manual-confirm', not a terminal txn id, so it is the staff's word
// that the card was charged. Resolve the real approved transaction from Helcim
// (by the sale's reference) before anything is booked, and fail closed —
// nothing booked, nothing voided — when it cannot be positively verified. A
// genuinely orphaned real charge is settled by the reconcile sweep, which still
// holds this sale's pending-charge record.
function _runRecipeConfirm(body, confirmIdemKey, req, res) {
  if (body.transaction_id !== 'manual-confirm') {
    return _bookRecipeConfirm(body, confirmIdemKey, req, res);
  }

  function failUnverified(declined) {
    if (confirmIdemKey) cache.releaseLock(confirmIdemKey).catch(function () {});
    cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
    if (res.headersSent) return;
    if (declined) {
      return res.status(400).json({
        error: 'No approved card payment found for this sale (terminal reported declined or cancelled). Nothing was booked — do not re-charge.'
      });
    }
    return res.status(409).json({
      error: 'Card payment could not be verified yet. If the terminal approved, it will be reconciled automatically — do NOT re-charge. Otherwise wait a moment and retry.'
    });
  }

  return helcimLib.pollTerminalResult(String(body.reference).slice(0, 64)).then(function (tr) {
    if (tr && tr.approved && tr.transactionId) {
      log.info('[pos-recipe/confirm] manual-confirm resolved to txn=' + tr.transactionId + ' ref=' + body.reference);
      return _bookRecipeConfirm(Object.assign({}, body, { transaction_id: String(tr.transactionId) }), confirmIdemKey, req, res);
    }
    var declined = !!(tr && (tr.status === 'DECLINED' || tr.status === 'CANCELLED'));
    log.warn('[pos-recipe/confirm] manual-confirm not verified ref=' + body.reference +
      ' status=' + (tr && tr.status));
    return failUnverified(declined);
  }, function (pollErr) {
    log.error('[pos-recipe/confirm] manual-confirm poll failed ref=' + body.reference + ': ' + pollErr.message);
    return failUnverified(false);
  });
}

function _bookRecipeConfirm(body, confirmIdemKey, req, res) {
  var txnId = body.transaction_id;
  var millGrain = body.mill_grain === true;
  // MOD-02 (36-03): parse modified_ingredients from request body (array or null)
  var modifiedConfirm = Array.isArray(body.modified_ingredients) ? body.modified_ingredients : null;
  var discountReq = (body.discount && body.discount.preset_id) ? body.discount : null;

  // Load the discount preset (if any) FIRST so the invoice + charge can apply it
  // synchronously in the recompute block below.
  loadDiscountPreset(discountReq ? discountReq.preset_id : null).then(function (discountPreset) {
    if (discountReq && !discountPreset) {
      return res.status(400).json({ error: 'Discount preset not found' });
    }

  // Re-fetch recipe server-side (never trust client data)
  return loadRecipe(body.recipe_id)
    .then(function (data) {
      // D-06: the charge below always uses the Postgres recipe; the D-05 compare is observational only.
      scheduleDualPriceCompare('sale', body.recipe_id, data,
        [body.target_volume_l, body.sale_type, millGrain, modifiedConfirm || undefined, discountReq], null);
      if (!data || !data.ok || !data.data || !data.data.recipe) {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      var recipe = data.data.recipe;
      var ingredients = data.data.ingredients || [];

      if (recipe.status !== 'active') {
        return res.status(400).json({ error: 'Recipe is not active' });
      }

      // Validate batch_size_l and target_volume_l (D-11) — same contract as quote handler
      var baseVolC = Number(recipe.batch_size_l) || 0;
      if (baseVolC <= 0) {
        return res.status(400).json({ error: 'Recipe has no base batch size set. Cannot scale.' });
      }

      // Default target_volume_l to batch_size_l if absent/blank (=> scale_factor 1.0, D-05 backward compat)
      var rawTargetVolC = body.target_volume_l;
      var targetVolumeLConfirm = (rawTargetVolC === undefined || rawTargetVolC === null || rawTargetVolC === '')
        ? baseVolC
        : Number(rawTargetVolC);

      if (isNaN(targetVolumeLConfirm) || targetVolumeLConfirm <= 0) {
        return res.status(400).json({ error: 'target_volume_l must be > 0' });
      }
      if (targetVolumeLConfirm > baseVolC * 10) {
        return res.status(400).json({ error: 'target_volume_l exceeds maximum (10x base)' });
      }

      var scaleFactorConfirm = targetVolumeLConfirm / baseVolC;
      recipe._scale_factor = scaleFactorConfirm;
      log.info('[pos-recipe/confirm] target_volume_l=' + targetVolumeLConfirm + ' base_vol=' + baseVolC + ' scale_factor=' + scaleFactorConfirm);

      // Re-compute total server-side from full ingredient catalog (includes internal-only items)
      getIngredientCatalog().then(function (ingredientCatalog) {
        if (!ingredientCatalog || !Array.isArray(ingredientCatalog)) {
          return res.status(503).json({ error: 'Ingredient catalog not available — try again shortly' });
        }

        // Build item_id -> catalog entry lookup
        var catalogMap = {};
        ingredientCatalog.forEach(function (item) {
          if (item && item.item_id) catalogMap[item.item_id] = item;
        });

        // MOD-02 (36-03): determine which ingredient list to scale for invoice + stock check
        // When modifiedConfirm is present, scale from the modified base list (same as quote path)
        var baseIngredientsConfirm = modifiedConfirm || ingredients;

        // Re-scale server-side (never trust client quantities — Pitfall 1/D-09)
        var scaledIngredients = scaling.scaleIngredients(baseIngredientsConfirm, scaleFactorConfirm);

        // Build invoice line items — use CONVERTED quantities for Zoho inventory
        // deduction (SCALE-04, INV-01, D-01/D-02). The Zoho invoice payload
        // carries no per-line unit override, so this converted number IS what
        // Zoho decrements (12 g hop -> 0.012 kg, not 12 kg).
        //
        // 73-06 (CR-01): this unpriceable-line detection now runs BEFORE the
        // stock re-check below. checkScaledStock (D-02, 73-06) itself fails
        // closed on a non-convertible line — reordering ensures that case
        // reaches the POST-CHARGE void safety net (payment_voided: true)
        // instead of the plain 409 "Insufficient stock" branch, which would
        // leave an already-charged card un-voided (U4c regression guard).
        var builtLines = buildRecipeLineItems(recipe, scaledIngredients, catalogMap, body.sale_type, millGrain);
        var lineItems = builtLines.lineItems || [];
        var unpriceableLine = builtLines.unpriceable || null; // D-02 tiered fail-closed (POST-CHARGE safety net)

        if (unpriceableLine) {
          // POST-CHARGE defense-in-depth (D-02, tiered fail-closed): the
          // terminal already charged the card by the time /confirm runs — this
          // should never fire if the PRE-CHARGE check in computeRecipeQuote
          // (above, shared by GET recipe-quote + POST recipe-sale) did its job.
          // If it somehow does, never silently mis-charge / mis-decrement
          // stock: void, mirroring the existing invoice-failure void path
          // below (Pitfall 1, T-14-09), rather than a bare 400.
          log.error('[pos-recipe/confirm] Unpriceable ingredient line — voiding txn=' + txnId + ': ' + unpriceableLine);

          eventLog.logEvent('kiosk.recipe_sale_unpriceable_line', {
            txnId: txnId,
            recipeId: body.recipe_id,
            error: unpriceableLine
          });

          return _voidRecipeTxnWithTimeout(txnId, 0, req)
            .then(function (voidResult) {
              cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
              if (!res.headersSent) {
                var responseBody = {
                  error: 'Payment was taken but the sale could not be priced. Payment voided.',
                  payment_voided: !voidResult.voidFailed
                };
                if (voidResult.voidFailed) responseBody.needs_manual_review = true;
                res.status(502).json(responseBody);
              }
            });
        }

        // Belt-and-suspenders stock re-check at confirm time (D-09)
        // Uses scaled MODIFIED quantities (T-36-08 mitigated). Every line here
        // is already confirmed priceable/convertible (unpriceableLine handled
        // above), so a conflict here is a genuine quantity-exceeds-stock case.
        var stockCheckConfirm = scaling.checkScaledStock(scaledIngredients, catalogMap);
        if (!stockCheckConfirm.ok && !body.override) {
          return res.status(409).json({
            error: 'Insufficient stock for scaled batch',
            conflicts: stockCheckConfirm.conflicts
          });
        }

        // Fee lines were added by buildRecipeLineItems (shared with the quote).
        if (builtLines.millingNotConfigured) {
          return res.status(400).json({ error: 'Milling fee not configured. Contact admin.' });
        }

        // Determine authoritative grand total via helper (same formula as quote, SCALE-03)
        // MOD-02 (36-03): when modified list present, use computeModifiedRecipeTotal (server-authoritative)
        // This ensures displayed price (from quote) == charged price (from confirm) for identical inputs
        var grandTotal;
        if (modifiedConfirm) {
          grandTotal = scaling.computeModifiedRecipeTotal(recipe, ingredients, modifiedConfirm, catalogMap, scaleFactorConfirm, body.sale_type);
        } else {
          grandTotal = scaling.computeScaledRecipeTotal(recipe, scaledIngredients, catalogMap, body.sale_type);
        }

        // Take-out milling fee — added on top (helper does not know about milling)
        if (body.sale_type === 'take-out' && millGrain) {
          var millingLineItem = lineItems.find(function (li) { return li.item_id === process.env.MILLING_FEE_ITEM_ID; });
          if (millingLineItem) {
            grandTotal += millingLineItem.rate || 0;
            grandTotal = Math.round(grandTotal * 100) / 100;
          }
        }

        // Apply discount (server-authoritative): reduce the charged total and
        // distribute the discount across the targeted invoice lines (capped).
        var discountNote = '';
        if (discountPreset) {
          var feePortionC = 0;
          if (body.sale_type === 'in-store') {
            feePortionC += (Number(recipe.service_fee) || 0) + (Number(recipe.materials_fee) || 0);
          }
          if (body.sale_type === 'take-out' && millGrain) {
            var millLi = lineItems.find(function (li) { return li.item_id === process.env.MILLING_FEE_ITEM_ID; });
            if (millLi) feePortionC += Number(millLi.rate) || 0;
          }
          feePortionC = round2(feePortionC);

          var discC = computeRecipeDiscount(discountPreset, grandTotal, feePortionC);
          if (discC.error) {
            cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
            return res.status(discC.status).json({ error: discC.error });
          }
          distributeRecipeDiscount(lineItems, recipeFeeItemIds(), discountPreset, discC.discountAmount);
          grandTotal = discC.total;
          discountNote = '\nDiscount: ' + discountPreset.name + ' (-' + discC.discountAmount.toFixed(2) + ')';
          log.info('[pos-recipe/confirm] discount applied: ' + discountPreset.name + ' amount=' + discC.discountAmount + ' new grandTotal=' + grandTotal);
        }

        var today = new Date().toISOString().slice(0, 10);

        var invoicePayload = {
          date: today,
          reference_number: body.reference,
          payment_terms: 0,
          payment_terms_label: 'Due on Receipt',
          line_items: lineItems,
          notes: 'Kiosk recipe sale (' + body.sale_type + '). Recipe: ' + body.recipe_id + '. Ref: ' + body.reference + discountNote,
          custom_fields: [],
          customer_id: body.contact_id || process.env.KIOSK_CONTACT_ID || ''
        };

        // Fee tax (owner decision 2026-10-13, mirrors the quote): from here on
        // grandTotal is the TAXED total — what the terminal charged, what the
        // capture must equal and what the payment books. The invoice carries
        // an adjustment so lines + Zoho tax + adjustment equal it, because a
        // locked package price differs from the sum of its ingredient lines.
        var preTaxTotal = grandTotal;
        return computeRecipeTax(lineItems, catalogMap).then(function (taxResult) {
          if (taxResult.error) {
            // Post-charge: the quote passed this same check, so this only
            // fires if the fee catalog changed between legs. Fail closed.
            log.error('[pos-recipe/confirm] Tax unresolved after charge — voiding txn=' + txnId + ': ' + taxResult.error);
            return _voidRecipeTxnWithTimeout(txnId, 0, req).then(function (voidResult) {
              cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
              if (res.headersSent) return;
              var taxErrBody = {
                error: 'Payment was taken but the sale could not be taxed. Payment voided.',
                payment_voided: !voidResult.voidFailed
              };
              if (voidResult.voidFailed) taxErrBody.needs_manual_review = true;
              res.status(502).json(taxErrBody);
            });
          }
          grandTotal = round2(preTaxTotal + taxResult.taxTotal);
          var lineSum = round2(lineItems.reduce(function (sum, li) { return sum + recipeLineAmount(li); }, 0));
          var adjustment = round2(preTaxTotal - lineSum);
          if (adjustment !== 0) {
            invoicePayload.adjustment = adjustment;
            invoicePayload.adjustment_description = 'Recipe package price';
          }

        // M-A3 parity (mirrors pos.js captureVerify, D-50-04): the amount
        // actually captured must equal the total we are about to book
        // (±$0.01) BEFORE any Zoho side-effect. An unreadable capture is a
        // mismatch — fail closed: void the charge, book nothing. Skipped only
        // when nothing was charged (grandTotal <= 0).
        var captureVerify = grandTotal > 0
          ? helcimLib.getCardTransactionById(txnId).then(function (txn) {
            return parseFloat(txn && txn.amount);
          }, function (readErr) {
            log.error('[pos-recipe/confirm] captured-amount readback failed for txn=' + txnId + ': ' + readErr.message);
            return NaN;
          })
          : Promise.resolve(grandTotal);

        return captureVerify.then(function (captured) {
          if (grandTotal > 0 && (!isFinite(captured) || captured <= 0 || Math.abs(captured - grandTotal) > 0.01)) {
            log.error('[pos-recipe/confirm] captured amount mismatch — txn=' + txnId +
              ' captured=' + captured + ' grandTotal=' + grandTotal + ' — voiding');
            eventLog.logEvent('kiosk.recipe_sale_amount_mismatch', {
              txnId: txnId, recipeId: body.recipe_id, captured: captured, expected: grandTotal
            });
            return _voidRecipeTxnWithTimeout(txnId, grandTotal, req).then(function (voidResult) {
              cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
              if (res.headersSent) return;
              var mismatchBody = {
                error: 'The amount charged does not match the sale total. The card charge has been voided — please re-ring the sale.',
                payment_voided: !voidResult.voidFailed
              };
              if (voidResult.voidFailed) mismatchBody.needs_manual_review = true;
              res.status(402).json(mismatchBody);
            });
          }

        // Create Zoho invoice
        return zohoPost('/invoices', invoicePayload)
          .then(function (created) { return reconcileRecipeInvoice(created, invoicePayload, grandTotal); })
          .then(function (invoiceData) {
            var invoice = invoiceData.invoice || {};
            var invoiceId = invoice.invoice_id || '';
            var invoiceNumber = invoice.invoice_number || '';
            log.info('[pos-recipe/confirm] Invoice created: ' + invoiceNumber);

            // Submit invoice (triggers inventory deduction per INV-01), THEN record the
            // customer payment. Both stay fire-and-forget for the response, but the
            // payment must wait for /submit: fired concurrently it hit a draft invoice
            // and was dropped (D-17, INV-000236). Mirrors the kit path (pos.js ~1717).
            zohoPost('/invoices/' + invoiceId + '/submit', {}).catch(function () {})
              .then(function () {
                return zohoPost('/customerpayments', {
                  payment_mode: 'creditcard',
                  amount: grandTotal,
                  date: today,
                  reference_number: txnId,
                  invoices: [{ invoice_id: invoiceId, amount_applied: grandTotal }],
                  notes: 'Kiosk recipe sale. Ref: ' + body.reference
                });
              })
              .catch(function (payErr) {
                log.error('[pos-recipe/confirm] Payment recording failed: ' + payErr.message);
              });

            // Bust caches (Pitfall 4 — must bust BOTH product and ingredient caches).
            // INGREDIENTS_ALL is busted too because the stock/availability checks
            // read the full catalog (35-05); otherwise post-sale stock goes stale.
            cache.del(C.CACHE_KEYS.KIOSK_PRODUCTS);
            cache.del(C.CACHE_KEYS.INGREDIENTS);
            cache.del(C.CACHE_KEYS.INGREDIENTS_ALL);
            cache.del(C.CACHE_KEYS.RECIPES_TS);

            // Release mutex
            cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});

            // Fire-and-forget batch creation — only for in-store sales (D-09, D-10)
            if (body.sale_type === 'in-store') {
              var snapshot = {
                name: recipe.name,
                style: recipe.style,
                abv: recipe.abv,
                ibu: recipe.ibu,
                batch_size_l: recipe.batch_size_l,
                og: snapshotGravity(recipe.target_og),
                target_fg: snapshotGravity(recipe.target_fg),
                locked_price: recipe.locked_price,
                service_fee: recipe.service_fee,
                materials_fee: recipe.materials_fee,
                target_volume_l: targetVolumeLConfirm,
                scale_factor: scaleFactorConfirm,
                ingredients: typedSnapshotIngredients(scaledIngredients, catalogMap),
                // MOD-02 (36-03): freeze modified list + flag into snapshot
                modified_base_ingredients: modifiedConfirm,
                is_modified: !!(modifiedConfirm && modifiedConfirm.length)
              };
              brewpadIntegration.detectRecipeSale(
                body.recipe_id,
                snapshot,
                invoiceNumber,
                body.customer_name,
                body.contact_id
              );
            }

            // Log event
            var recipeSaleEvent = {
              txnId: txnId,
              recipeId: body.recipe_id,
              saleType: body.sale_type,
              total: grandTotal,
              invoiceNumber: invoiceNumber
            };
            if (taxResult.catalogSource === 'stale') recipeSaleEvent.catalog_source = 'stale';
            eventLog.logEvent('kiosk.recipe_sale_completed', recipeSaleEvent);

            // M12 (mirrors pos.js:1773-1783): clear the pending-charge
            // sentinel so lib/reconcile.js knows this charge is settled
            // (no orphan). body.reference is the SAME string recipe-sale
            // returned as `reference` and used as the KIOSK_PENDING_CHARGE_PREFIX
            // suffix at push time (D-50-08's confirm-leg invoice payload
            // already relies on this same identity at :reference_number: body.reference).
            var pendingRef = (typeof body.reference === 'string' && body.reference)
              ? body.reference.slice(0, 64) : '';
            if (pendingRef) {
              cache.del(C.CACHE_KEYS.KIOSK_PENDING_CHARGE_PREFIX + pendingRef).catch(function () {});
            }

            // Cache confirm result for CR-01 idempotent replays (T-44-G2 parity)
            var recipeResult = {
              ok: true,
              transaction_id: txnId,
              invoice_number: invoiceNumber,
              recipe_id: body.recipe_id,
              sale_type: body.sale_type,
              total: grandTotal
            };
            var cacheWriteRecipe = confirmIdemKey
              ? cache.set(confirmIdemKey, recipeResult, moneyPath.CHECKOUT_IDEMPOTENCY_TTL).catch(function () {})
              : Promise.resolve();
            cacheWriteRecipe.then(function () {
              // Return receipt
              res.status(201).json(recipeResult);
            });
          })
          .catch(function (invoiceErr) {
            // Zoho invoice failed after payment — void the transaction (Pitfall 1, T-14-09)
            var invoiceMsg = invoiceErr.message;
            if (invoiceErr.response && invoiceErr.response.data) {
              invoiceMsg = invoiceErr.response.data.message || invoiceErr.response.data.error || invoiceMsg;
            }
            log.error('[pos-recipe/confirm] Invoice creation failed — voiding txn=' + txnId + ': ' + invoiceMsg);

            eventLog.logEvent('kiosk.recipe_sale_failed_after_charge', {
              txnId: txnId,
              recipeId: body.recipe_id,
              amount: grandTotal
            });

            _voidRecipeTxnWithTimeout(txnId, grandTotal, req)
              .then(function (voidResult) {
                // Release lock after void attempt (success or failure)
                cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
                if (res.headersSent) return;
                var respBody = {
                  error: 'Payment was taken but invoice failed. Payment voided.',
                  payment_voided: !voidResult.voidFailed
                };
                if (voidResult.voidFailed) respBody.needs_manual_review = true;
                res.status(502).json(respBody);
              });
          });
        }); // end captureVerify.then
        }); // end computeRecipeTax.then
      }).catch(function (cacheErr) {
        log.error('[pos-recipe/confirm] Cache error: ' + cacheErr.message);
        cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
        res.status(503).json({ error: 'Ingredient catalog not available — try again shortly' });
      });
    })
    .catch(function (appsErr) {
      log.error('[pos-recipe/confirm] Apps Script error: ' + appsErr.message);
      cache.releaseLock(C.LOCK_KEYS.RECIPE_SALE).catch(function () {});
      res.status(502).json({ error: 'Failed to fetch recipe. Please try again.' });
    });
  }).catch(function (presetErr) {
    log.error('[pos-recipe/confirm] Discount preset load error: ' + presetErr.message);
    if (!res.headersSent) res.status(503).json({ error: 'Discount unavailable — please try again.' });
  });
}

module.exports = router;
// Exposed for unit testing (pure helpers)
module.exports.computeRecipeDiscount = computeRecipeDiscount;
module.exports.distributeRecipeDiscount = distributeRecipeDiscount;
module.exports._dualPriceStats = _dualPriceStats;
module.exports._resetDualPriceStats = _resetDualPriceStats;

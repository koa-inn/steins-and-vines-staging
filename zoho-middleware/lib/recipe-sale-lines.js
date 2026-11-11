'use strict';

// Phase 101: recipe sale pricing/line helpers shared by routes/pos-recipe.js
// (recipe-quote, legacy recipe-sale confirm) and routes/pos.js
// (/api/kiosk/sale, /confirm, /cart-quote). Moved verbatim from pos-recipe.js.

var fs = require('fs');
var path = require('path');
var zohoApi = require('./zoho-api');
var cache = require('./cache');
var log = require('./logger');
var C = require('./constants');
var kioskSaleCatalog = require('./kiosk-sale-catalog');
var scaling = require('./recipe-scaling');
var recipeStore = require('./recipe-store');

var zohoPut = zohoApi.zohoPut;

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
    if (Array.isArray(fileCatalog)) {
      log.warn('[pos-recipe] Ingredient catalog not in Redis; using file cache (' + fileCatalog.length + ' items)');
      return fileCatalog;
    }
    // Cold (after a redeploy, or a recipe sale busted Redis before the file was
    // ever written): rebuild it rather than 503 every recipe price. The refresh
    // is coalesced, so concurrent callers share one Zoho round-trip.
    log.warn('[pos-recipe] Ingredient catalog not in Redis or file cache; refreshing');
    // Lazy require: routes/catalog.js is heavy and route tests mock it.
    return Promise.resolve()
      .then(function () { return require('../routes/catalog').refreshIngredients(); })
      .then(function () { return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL); })
      .then(function (fresh) { return Array.isArray(fresh) ? fresh : null; })
      .catch(function (err) {
        log.error('[pos-recipe] Ingredient catalog refresh failed: ' + (err && err.message));
        return null;
      });
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
  // Custom and canning-bundle lines have no backing item: Zoho echoes them
  // with an empty item_id / name and their text only in `description`, so
  // the description must go back or the line is blanked (or the PUT refused).
  if (Array.isArray(invoice.line_items) && invoice.line_items.length) {
    updated.line_items = invoice.line_items.map(function (li) {
      var out = {
        line_item_id: li.line_item_id,
        quantity: li.quantity,
        rate: li.rate,
        discount: li.discount,
        tax_id: li.tax_id
      };
      if (li.item_id) out.item_id = li.item_id;
      if (li.name) out.name = li.name;
      if (li.description) out.description = li.description;
      return out;
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
function recipeTaxGroups(lineItems, catalogMap) {
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
    var out = { byRate: taxByRate };
    if (feeResolved.source === 'stale') out.catalogSource = 'stale';
    return out;
  });
}

// Rounded tax total: each rate group rounded on its own (entity_level).
function computeRecipeTax(lineItems, catalogMap) {
  return recipeTaxGroups(lineItems, catalogMap).then(function (groups) {
    if (groups.error) return groups;
    var taxByRate = groups.byRate;
    var taxTotal = 0;
    Object.keys(taxByRate).forEach(function (k) { taxTotal += round2(taxByRate[k]); });
    var taxOut = { taxTotal: round2(taxTotal) };
    if (groups.catalogSource === 'stale') taxOut.catalogSource = 'stale';
    return taxOut;
  });
}

function loadRecipe(recipeId) {
  return recipeStore.get(recipeId);
}

function priceRecipe(data, rawTarget, saleType, millGrain, modifiedIngredients, discountReq, preloadedCatalog) {
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

  // preloadedCatalog (Phase 101): mixed carts load the catalog once and pass it
  // to every entry; the no-argument path is unchanged.
  var catalogLoad = Array.isArray(preloadedCatalog) ? Promise.resolve(preloadedCatalog) : getIngredientCatalog();
  return catalogLoad.then(function (ingredientCatalog) {
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

// ---------------------------------------------------------------------------
// Phase 101: mixed-cart recipe helpers. /sale, /confirm and /cart-quote compose
// these so the three routes cannot drift. All pure or catalog-cache only —
// zero Zoho calls.
// ---------------------------------------------------------------------------

var MAX_RECIPE_ENTRIES = 25;

function entryList(priced) {
  return Array.isArray(priced) ? priced : ((priced && priced.entries) || []);
}

/**
 * Validate the client recipes[] array. Copies parameters only — any client
 * price/total field is dropped (T-101-09).
 */
function validateRecipeEntries(recipes) {
  if (!Array.isArray(recipes) || recipes.length < 1) {
    return { status: 400, error: 'recipes must be a non-empty array' };
  }
  if (recipes.length > MAX_RECIPE_ENTRIES) {
    return { status: 400, error: 'Too many recipes in one sale (max ' + MAX_RECIPE_ENTRIES + ')' };
  }
  var entries = [];
  for (var i = 0; i < recipes.length; i++) {
    var r = recipes[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { status: 400, error: 'recipes[' + i + '] must be an object' };
    }
    var id = typeof r.recipe_id === 'string' ? r.recipe_id.trim() : '';
    if (!id || id.length > 64) {
      return { status: 400, error: 'recipes[' + i + '].recipe_id is required (max 64 chars)' };
    }
    if (r.sale_type !== 'in-store' && r.sale_type !== 'take-out') {
      return { status: 400, error: 'recipes[' + i + '].sale_type must be in-store or take-out' };
    }
    var tv = r.target_volume_l;
    if (tv !== undefined && tv !== null && !(typeof tv === 'number' && isFinite(tv) && tv > 0)) {
      return { status: 400, error: 'recipes[' + i + '].target_volume_l must be a number > 0' };
    }
    // The kiosk sends null for an unmodified recipe; treat it the same as absent.
    var mods = r.modified_ingredients === null ? undefined : r.modified_ingredients;
    if (mods !== undefined && !Array.isArray(mods)) {
      return { status: 400, error: 'recipes[' + i + '].modified_ingredients must be an array' };
    }
    entries.push({
      index: i,
      recipe_id: id,
      sale_type: r.sale_type,
      mill_grain: r.mill_grain === true,
      target_volume_l: tv === undefined ? null : tv,
      modified_ingredients: mods
    });
  }
  return { ok: true, entries: entries };
}

/** Labels per entry; duplicate recipe names get ' #1', ' #2' in entry order. */
function recipeEntryLabels(priced) {
  var list = entryList(priced);
  var counts = {};
  list.forEach(function (e) { counts[e.recipe_name] = (counts[e.recipe_name] || 0) + 1; });
  var seen = {};
  return list.map(function (e) {
    if (counts[e.recipe_name] < 2) return e.recipe_name;
    seen[e.recipe_name] = (seen[e.recipe_name] || 0) + 1;
    return e.recipe_name + ' #' + seen[e.recipe_name];
  });
}

/**
 * Price every entry with ONE ingredient-catalog load, discountReq null (the
 * discount is applied per recipe by the caller). Rejects with priceRecipe's
 * { status, body } shape.
 */
function priceRecipeEntries(entries) {
  return getIngredientCatalog().then(function (catalog) {
    if (!Array.isArray(catalog)) {
      return Promise.reject({ status: 503, body: { error: 'Ingredient catalog not available — try again shortly' } });
    }
    var out = [];
    var chain = Promise.resolve();
    entries.forEach(function (entry) {
      chain = chain.then(function () {
        return Promise.resolve(loadRecipe(entry.recipe_id)).then(function (data) {
          // priceRecipe stamps _scale_factor on the recipe object; clone so the
          // same recipe sold twice (D-02) never shares state between entries.
          var clone = data && data.ok ? JSON.parse(JSON.stringify(data)) : data;
          return priceRecipe(clone, entry.target_volume_l, entry.sale_type, entry.mill_grain,
            entry.modified_ingredients, null, catalog);
        }).then(function (res) {
          var built = buildRecipeLineItems(res.recipe, res.scaledIngredients, res.catalogMap, entry.sale_type, entry.mill_grain);
          if (built.unpriceable) return Promise.reject({ status: 422, body: { error: built.unpriceable } });
          if (built.millingNotConfigured) {
            return Promise.reject({ status: 400, body: { error: 'Milling fee not configured. Contact admin.' } });
          }
          out.push({
            index: entry.index,
            recipe_id: entry.recipe_id,
            recipe_name: res.recipe.name,
            sale_type: entry.sale_type,
            mill_grain: entry.mill_grain,
            target_volume_l: res.targetVolumeL,
            pricing_mode: res.pricingMode,
            base_total: res.totalBeforeDiscount,
            fee_portion: res.feePortion,
            lines: built.lineItems,
            scaled_ingredients: res.scaledIngredients,
            recipe: res.recipe,
            catalog_map: res.catalogMap,
            stock_check: res.stockCheck
          });
        });
      });
    });
    return chain.then(function () { return { entries: out }; });
  });
}

/**
 * Sum need per item_id across ALL entries (D-12) and name every short recipe
 * (D-13). A non-convertible unit is a conflict (fail closed).
 */
function checkCombinedStock(priced) {
  var list = entryList(priced);
  var labels = recipeEntryLabels(list);
  var byItem = {};
  var order = [];
  list.forEach(function (e, ei) {
    (e.scaled_ingredients || []).forEach(function (ing) {
      var cat = e.catalog_map[ing.item_id];
      if (!cat) return;
      var acc = byItem[ing.item_id];
      if (!acc) {
        acc = byItem[ing.item_id] = {
          item_id: ing.item_id, item_name: ing.item_name, needed: 0,
          stock: Number(cat.stock_on_hand) || 0, unit: cat.unit, bad: false, entries: []
        };
        order.push(ing.item_id);
      }
      var cost = scaling.ingredientLineCost(cat, ing);
      if (cost.ok) {
        acc.needed += cost.convertedQty;
      } else {
        acc.bad = true;
        acc.needed += Number(ing.quantity) || 0;
        acc.unit = ing.unit;
      }
      if (acc.entries.indexOf(ei) === -1) acc.entries.push(ei);
    });
  });
  var conflicts = [];
  var shortIdx = {};
  order.forEach(function (id) {
    var acc = byItem[id];
    var needed = Math.round(acc.needed * 10000) / 10000;
    if (!acc.bad && needed <= acc.stock) return;
    conflicts.push({
      item_id: acc.item_id,
      item_name: acc.item_name,
      needed: needed,
      stock: acc.stock,
      unit: acc.unit,
      recipes: acc.entries.map(function (ei) { shortIdx[ei] = true; return labels[ei]; })
    });
  });
  var recipesShort = [];
  list.forEach(function (e, ei) {
    if (shortIdx[ei]) recipesShort.push({ index: e.index, recipe_id: e.recipe_id, name: labels[ei] });
  });
  return { ok: conflicts.length === 0, conflicts: conflicts, recipes_short: recipesShort };
}

/** The portion of a recipe computeRecipeDiscount would discount (same targeting rule). */
function recipeDiscountBase(preset, baseTotal, feePortion) {
  if (!preset) return 0;
  if (preset.scope === 'cart') return round2(baseTotal);
  if (preset.scope === 'type') {
    var at = preset.applies_to || [];
    var base = 0;
    if (at.indexOf('recipe') !== -1) base += round2(baseTotal - feePortion);
    if (at.indexOf('service') !== -1) base += feePortion;
    return round2(base);
  }
  return 0;
}

/** Deep-copy the entry's lines, spread `amount` over them, return { lines, pre_tax }. */
function applyRecipeDiscount(pricedEntry, amount, preset) {
  var lines = JSON.parse(JSON.stringify(pricedEntry.lines));
  if (preset && amount > 0) distributeRecipeDiscount(lines, recipeFeeItemIds(), preset, amount);
  return { lines: lines, pre_tax: round2(pricedEntry.base_total - (amount || 0)) };
}

/** Invoice adjustment so lines + adjustment == the pre-tax package price. */
function recipeAdjustment(preTax, lines) {
  var sum = lines.reduce(function (acc, li) { return acc + recipeLineAmount(li); }, 0);
  return round2(preTax - round2(sum));
}

/** 'Recipes: House Pale (in-store, 23 L), Saison (take-out, milled, 23 L)' */
function recipeNotesSummary(priced) {
  var list = entryList(priced);
  var labels = recipeEntryLabels(list);
  return 'Recipes: ' + list.map(function (e, i) {
    var parts = [e.sale_type];
    if (e.sale_type === 'take-out' && e.mill_grain) parts.push('milled');
    parts.push(e.target_volume_l + ' L');
    return labels[i] + ' (' + parts.join(', ') + ')';
  }).join(', ');
}

module.exports = {
  MAX_RECIPE_ENTRIES: MAX_RECIPE_ENTRIES,
  validateRecipeEntries: validateRecipeEntries,
  priceRecipeEntries: priceRecipeEntries,
  checkCombinedStock: checkCombinedStock,
  recipeDiscountBase: recipeDiscountBase,
  applyRecipeDiscount: applyRecipeDiscount,
  recipeAdjustment: recipeAdjustment,
  recipeEntryLabels: recipeEntryLabels,
  recipeNotesSummary: recipeNotesSummary,
  getIngredientCatalog: getIngredientCatalog,
  computeRecipeDiscount: computeRecipeDiscount,
  distributeRecipeDiscount: distributeRecipeDiscount,
  loadDiscountPreset: loadDiscountPreset,
  recipeFeeItemIds: recipeFeeItemIds,
  buildRecipeLineItems: buildRecipeLineItems,
  reconcileRecipeInvoice: reconcileRecipeInvoice,
  recipeLineAmount: recipeLineAmount,
  getFeeCatalogMap: getFeeCatalogMap,
  computeRecipeTax: computeRecipeTax,
  recipeTaxGroups: recipeTaxGroups,
  priceRecipe: priceRecipe,
  loadRecipe: loadRecipe,
  typedSnapshotIngredients: typedSnapshotIngredients,
  snapshotGravity: snapshotGravity,
  round2: round2
};

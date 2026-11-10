'use strict';

var express = require('express');
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

var lines = require('../lib/recipe-sale-lines');
var getIngredientCatalog = lines.getIngredientCatalog;
var computeRecipeDiscount = lines.computeRecipeDiscount;
var distributeRecipeDiscount = lines.distributeRecipeDiscount;
var loadDiscountPreset = lines.loadDiscountPreset;
var recipeFeeItemIds = lines.recipeFeeItemIds;
var buildRecipeLineItems = lines.buildRecipeLineItems;
var reconcileRecipeInvoice = lines.reconcileRecipeInvoice;
var recipeLineAmount = lines.recipeLineAmount;
var getFeeCatalogMap = lines.getFeeCatalogMap;
var computeRecipeTax = lines.computeRecipeTax;
var priceRecipe = lines.priceRecipe;
var loadRecipe = lines.loadRecipe;
var typedSnapshotIngredients = lines.typedSnapshotIngredients;
var snapshotGravity = lines.snapshotGravity;
var round2 = lines.round2;

var router = express.Router();

// M12 (D-13 parity): 7-day TTL for the recipe-sale pending-charge record —
// mirrors KIOSK_PENDING_CHARGE_TTL in routes/pos.js.
var KIOSK_PENDING_CHARGE_TTL = 604800;

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
// POST /api/kiosk/recipe-sale  (RETIRED, Phase 101 D-16/D-18)
// Recipes now ride the merged /api/kiosk/sale route. A stale cached kiosk gets
// a refresh message BEFORE any lock, pricing or terminal call, so no money
// moves. /recipe-sale/confirm below stays alive to book in-flight charges.
// ---------------------------------------------------------------------------

router.post('/api/kiosk/recipe-sale', function (req, res) {
  var body = req.body || {};
  var ref = (typeof body.reference_number === 'string') ? body.reference_number.slice(0, 64) : null;
  log.warn('[pos-recipe/recipe-sale] retired initiate route hit by stale kiosk reference=' + ref);
  return res.status(410).json({ error: 'This kiosk is out of date. Refresh the page and try again.' });
});

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

  // D-18 soak: measure legacy-confirm use (reference + boolean only, no customer data).
  var legacyRef = (typeof body.reference === 'string') ? body.reference.slice(0, 64) : null;
  log.warn('[pos-recipe/recipe-sale/confirm] legacy confirm used reference=' + legacyRef);
  eventLog.logEvent('kiosk.recipe_sale_legacy_confirm', {
    reference_number: legacyRef,
    has_transaction_id: !!body.transaction_id
  });

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
              // 97-10 (D-03): kiosk-supplied customer email, validated; never logged.
              var kioskEmail = '';
              if (typeof body.customer_email === 'string') {
                var trimmedEmail = body.customer_email.trim();
                if (trimmedEmail.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
                  kioskEmail = trimmedEmail;
                }
              }
              if (kioskEmail) {
                brewpadIntegration.detectRecipeSale(
                  body.recipe_id,
                  snapshot,
                  invoiceNumber,
                  body.customer_name,
                  body.contact_id,
                  kioskEmail
                );
              } else {
                brewpadIntegration.detectRecipeSale(
                  body.recipe_id,
                  snapshot,
                  invoiceNumber,
                  body.customer_name,
                  body.contact_id
                );
              }
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

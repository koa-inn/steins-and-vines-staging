'use strict';

var express = require('express');
var fs = require('fs');
var path = require('path');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var C = require('../lib/constants');
var axios = require('axios');
var authTiers = require('../lib/authTiers');
var scaling = require('../lib/recipe-scaling');

var router = express.Router();

// Full ingredient list INCLUDING Internal Only items — same file catalog.js writes on refresh.
// Used as cold-cache fallback for enrichment functions that must see internal-only items.
var INGREDIENTS_ALL_FILE_CACHE = path.join(__dirname, '..', 'ingredients-all-cache.json');

var RECIPES_CACHE_TTL = 600; // 10 minutes (D-09)

// ---------------------------------------------------------------------------
// Helpers — Apps Script communication
// ---------------------------------------------------------------------------

function callAppsScriptPost(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    log.warn('[recipes] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured');
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return axios.post(url, JSON.stringify(Object.assign({}, payload, {
    action: action,
    server_token: token
  })), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    maxRedirects: 5
  }).then(function (resp) {
    return resp.data;
  });
}

// ---------------------------------------------------------------------------
// Helper — Cache invalidation
// ---------------------------------------------------------------------------

function bustRecipeCache(recipeId) {
  var keys = [C.CACHE_KEYS.RECIPES_TS];
  // Bust all status-variant list keys (default pagination)
  ['all', 'draft', 'active', 'inactive'].forEach(function (s) {
    keys.push(C.CACHE_KEYS.RECIPES + ':' + s + ':0:0');
  });
  if (recipeId) {
    keys.push(C.CACHE_KEYS.RECIPES + ':' + recipeId);
  }
  return Promise.all(keys.map(function (k) { return cache.del(k); }));
}

// ---------------------------------------------------------------------------
// Helper — Public recipe read contract (D-05/D-06/D-07)
//
// GET /api/recipes and GET /api/recipes/:id are exempt from the global /api
// guard (server.js lets every GET through), so they must resolve their own
// credential tier. Mirrors catalog.js's isAdminGrade shape but uses
// allowKiosk, NOT allowAdmin — kiosk devices build recipes at the kiosk and
// must keep draft visibility (D-05), unlike the admin-only Internal Only
// ingredients gate.
// ---------------------------------------------------------------------------

var PUBLIC_RECIPE_FIELDS = ['recipe_id', 'name', 'style', 'description'];

// Build-by-allowlist, never delete-from-source (T-74-04): a public recipe is
// assembled as a NEW object copying only PUBLIC_RECIPE_FIELDS, so a future
// field added to the source recipe is absent from the public shape by
// default rather than leaking until someone remembers to blocklist it.
// Pricing is collapsed to a single fee-inclusive `price` so
// locked_price/service_fee/materials_fee/computed_price (margin-derivable)
// can never be recovered from a public response.
function toPublicRecipe(recipe) {
  var src = recipe || {};
  var out = {};
  PUBLIC_RECIPE_FIELDS.forEach(function (field) {
    if (Object.prototype.hasOwnProperty.call(src, field)) {
      out[field] = src[field];
    }
  });
  if (src.pricing_mode === 'locked') {
    var total = Number(src.locked_price || 0) + Number(src.service_fee || 0) + Number(src.materials_fee || 0);
    out.price = Math.round(total * 100) / 100;
  } else if (src.pricing_mode === 'dynamic') {
    out.price = typeof src.computed_price === 'number' ? src.computed_price : null;
    out.price_from = true;
  }
  return out;
}

// Resolves whether the caller may see the staff/full recipe shape (draft
// status + ingredients + cost fields). Async because session lookup is
// async; callers must consume the returned Promise<boolean>. Fails CLOSED
// to the public projection on any resolution error (T-74-06) — never opens
// the staff path on an unexpected rejection.
function isRecipeStaff(req) {
  return authTiers.resolveTier(req).then(function (tier) {
    return authTiers.allowKiosk(tier);
  }).catch(function () {
    return false;
  });
}

// ---------------------------------------------------------------------------
// Helper — Custom-field accessor (mirrors catalog.js L551-556 Millable idiom)
// ---------------------------------------------------------------------------

function readCF(entry, apiName) {
  var cfs = (entry && entry.custom_fields) || [];
  for (var i = 0; i < cfs.length; i++) {
    if (cfs[i] && cfs[i].api_name === apiName) return cfs[i].value_formatted || cfs[i].value || '';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Helper — Always-run additive group enrichment (RDISP-02, D-07, D-08)
// Sets cf_type / cf_subcategory / display_group on each ingredient.
// NOT gated behind pricing_mode — runs for locked AND dynamic recipes.
// ---------------------------------------------------------------------------

function enrichIngredientGroups(ingredients) {
  return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
    if (!catalog || !Array.isArray(catalog)) {
      // Redis cold — fall back to the full-catalog file so internal-only ingredients
      // (e.g. Gypsum Bulk) still receive grouping fields when Redis is unavailable.
      try {
        catalog = JSON.parse(fs.readFileSync(INGREDIENTS_ALL_FILE_CACHE, 'utf8'));
      } catch {
        catalog = null;
      }
      if (!catalog || !Array.isArray(catalog)) return; // D-07: degrade gracefully
    }
    var map = {};
    catalog.forEach(function (item) { if (item && item.item_id) map[item.item_id] = item; });

    (ingredients || []).forEach(function (ing) {
      var entry = map[ing.item_id];
      if (!entry) return; // no match — leave additive fields unset
      // cf_type is top-level on cache entries (catalog.js L851)
      ing.cf_type = entry.cf_type || readCF(entry, 'cf_type') || '';
      // cf_subcategory lives in custom_fields[] (PATTERNS critical finding)
      ing.cf_subcategory = readCF(entry, 'cf_subcategory') || '';
      // display_group — let the client (Plan 01) do label collapse;
      // set to the raw subcategory key or type key as a stable raw signal.
      ing.display_group = ing.cf_subcategory || ing.cf_type || '';
    });
  }).catch(function () {}); // D-07: never throw on enrichment failure
}

function enrichWithComputedPrice(recipe, ingredients) {
  if (!recipe || recipe.pricing_mode !== 'dynamic') return Promise.resolve();
  return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
    if (!catalog || !Array.isArray(catalog)) return;
    var map = {};
    catalog.forEach(function (item) { if (item && item.item_id) map[item.item_id] = item; });
    var total = 0;
    var pricingError = null;
    (ingredients || []).forEach(function (ing) {
      var entry = map[ing.item_id];
      if (!entry || pricingError) return;
      ing.rate = Number(entry.rate) || 0;
      ing.tax_percentage = Number(entry.tax_percentage) || 0;
      ing.tax_id = entry.sales_tax_rule_id || entry.tax_id || '';
      // Unit-aware line cost (D-01/D-02) — replaces the bare qty * rate
      // multiply that ignored unit mismatches (kg item vs g recipe line).
      var lineCost = scaling.ingredientLineCost(entry, ing);
      if (!lineCost.ok) {
        pricingError = lineCost.error;
        return;
      }
      total += lineCost.cost;
    });

    if (pricingError) {
      // Read-path fail-closed (D-02): this is a GET that also returns
      // non-price recipe data, so a bad line marks only the price as
      // errored — never a 4xx/5xx for the whole response.
      recipe.computed_price = null;
      recipe.pricing_error = pricingError;
      return;
    }

    total += Number(recipe.service_fee) || 0;
    total += Number(recipe.materials_fee) || 0;
    recipe.computed_price = Math.round(total * 100) / 100;
    return cache.get(C.CACHE_KEYS.KIOSK_PRODUCTS).then(function (kioskItems) {
      if (!kioskItems || !Array.isArray(kioskItems)) return;
      var feeSkus = { 'BREW-FEE': 'brewing_fee_tax', 'MAT-FEE': 'materials_fee_tax', 'MILLED': 'milling_fee_tax' };
      var millingId = process.env.MILLING_FEE_ITEM_ID;
      for (var i = 0; i < kioskItems.length; i++) {
        var sku = (kioskItems[i].sku || '').toUpperCase();
        if (feeSkus[sku]) {
          recipe[feeSkus[sku]] = Number(kioskItems[i].tax_percentage) || 0;
        }
        if (sku === 'MILLED' || (millingId && (kioskItems[i].item_id === millingId || sku === millingId.toUpperCase()))) {
          recipe.milling_fee_rate = Number(kioskItems[i].rate) || 0;
          recipe.milling_fee_tax = Number(kioskItems[i].tax_percentage) || 0;
        }
      }
    }).catch(function () {});
  }).catch(function () {});
}

function enrichListPrices(recipes) {
  var dynamicRecipes = recipes.filter(function (r) { return r.pricing_mode === 'dynamic'; });
  if (dynamicRecipes.length === 0) return Promise.resolve();

  return Promise.all([
    cache.get(C.CACHE_KEYS.INGREDIENTS_ALL),
    cache.get(C.CACHE_KEYS.KIOSK_PRODUCTS)
  ]).then(function (caches) {
    var catalog = caches[0];
    var kioskItems = caches[1];
    if (!catalog || !Array.isArray(catalog)) {
      // Redis cold — fall back to the full-catalog file so dynamic prices
      // still compute for internal-only ingredients (mirrors GET /api/ingredients'
      // resilience). Without this, computed_price stays unset and the list shows
      // no price for dynamic recipes containing internal items.
      try {
        catalog = JSON.parse(fs.readFileSync(INGREDIENTS_ALL_FILE_CACHE, 'utf8'));
      } catch {
        catalog = null;
      }
      if (!catalog || !Array.isArray(catalog)) return;
    }
    var map = {};
    catalog.forEach(function (item) { if (item && item.item_id) map[item.item_id] = item; });

    var millingId = process.env.MILLING_FEE_ITEM_ID;
    var millingRate = 0;
    if (millingId) {
      if (map[millingId]) {
        millingRate = Number(map[millingId].rate) || 0;
      } else if (kioskItems && Array.isArray(kioskItems)) {
        for (var k = 0; k < kioskItems.length; k++) {
          if (kioskItems[k].item_id === millingId || (kioskItems[k].sku || '').toUpperCase() === millingId.toUpperCase()) { millingRate = Number(kioskItems[k].rate) || 0; break; }
        }
      }
    }

    return Promise.all(dynamicRecipes.map(function (recipe) {
      var detailKey = C.CACHE_KEYS.RECIPES + ':' + recipe.recipe_id;
      return cache.get(detailKey).then(function (detail) {
        if (!detail || !detail.ingredients) {
          return callAppsScriptPost('get_recipe', { recipe_id: recipe.recipe_id }).then(function (data) {
            if (!data || !data.ok || !data.data) return null;
            var result = { recipe: data.data.recipe || data.data, ingredients: data.data.ingredients || [] };
            cache.set(detailKey, result, RECIPES_CACHE_TTL);
            return result;
          }).catch(function () { return null; });
        }
        return detail;
      }).then(function (detail) {
        if (!detail || !detail.ingredients) return;
        var total = 0;
        var pricingError = null;
        detail.ingredients.forEach(function (ing) {
          var entry = map[ing.item_id];
          if (!entry || pricingError) return;
          // Unit-aware line cost (D-01/D-02) — replaces the bare qty * rate
          // multiply that ignored unit mismatches.
          var lineCost = scaling.ingredientLineCost(entry, ing);
          if (!lineCost.ok) {
            pricingError = lineCost.error;
            return;
          }
          total += lineCost.cost;
        });

        if (pricingError) {
          // D-02/D-04: one un-priceable line marks only THIS recipe's price
          // as errored — never aborts the list for the other recipes.
          recipe.computed_price = null;
          recipe.pricing_error = pricingError;
          return;
        }

        total += Number(recipe.service_fee) || 0;
        total += Number(recipe.materials_fee) || 0;
        recipe.computed_price = Math.round(total * 100) / 100;
        if (millingRate > 0) recipe.milling_fee_rate = millingRate;
      }).catch(function () {
        // T-73-04: per-recipe guard — an unexpected error (e.g. Apps Script
        // fetch failure) must never reject the whole Promise.all and abort
        // the list response for every other recipe.
        recipe.computed_price = null;
        recipe.pricing_error = recipe.pricing_error || 'Unable to compute price for this recipe';
      });
    }));
  }).catch(function () {});
}

// ---------------------------------------------------------------------------
// GET /api/recipes — List recipes with optional status filter
// ---------------------------------------------------------------------------

router.get('/api/recipes', function (req, res) {
  return isRecipeStaff(req).then(function (isStaff) {
    // D-06: a non-staff caller's requested status is discarded before it
    // reaches the cache key or the Apps Script payload — a query-string
    // edit (?status=all/draft/...) has no effect for anonymous callers
    // (T-74-03).
    var requestedStatus = req.query.status || 'all';
    var status = isStaff ? requestedStatus : 'active';
    var limit  = parseInt(req.query.limit, 10) || 0;
    var offset = parseInt(req.query.offset, 10) || 0;
    var cacheKey = C.CACHE_KEYS.RECIPES + ':' + status + ':' + limit + ':' + offset;

    // Staff tiers get today's payload byte-for-byte. Non-staff callers get
    // the array re-filtered to status=active server-side (T-74-01) — this
    // is defense-in-depth against a stale/over-broad cached or upstream
    // payload, not merely trusting the resolved `status` above — and each
    // surviving record is projected through the field allowlist (T-74-04).
    function sendRecipeList(source, recipes, total) {
      if (isStaff) {
        return res.json({ source: source, recipes: recipes, total: total });
      }
      var filtered = (recipes || []).filter(function (r) {
        return String((r && r.status) || '').toLowerCase() === 'active';
      });
      var publicRecipes = filtered.map(toPublicRecipe);
      res.json({ source: source, recipes: publicRecipes, total: publicRecipes.length });
    }

    return cache.get(cacheKey).then(function (cached) {
      if (cached && cached.recipes) {
        log.info('[api/recipes] Cache hit status=' + status);
        return enrichListPrices(cached.recipes).then(function () {
          sendRecipeList('cache', cached.recipes, cached.total);
        });
      }
      return callAppsScriptPost('get_recipes', { status: status, limit: limit, offset: offset })
        .then(function (data) {
          if (data && data.ok === false) {
            log.warn('[api/recipes] Apps Script rejected: ' + (data.error || '') + ' ' + (data.message || ''));
            return res.status(502).json({ error: 'Apps Script error: ' + (data.error || 'unknown'), detail: data.message || '' });
          }
          var payload = data.data || {};
          if (payload.recipes && payload.recipes.length > 0) {
            cache.set(cacheKey, payload, RECIPES_CACHE_TTL);
            cache.set(C.CACHE_KEYS.RECIPES_TS, Date.now(), RECIPES_CACHE_TTL);
          }
          var recipeList = payload.recipes || [];
          return enrichListPrices(recipeList).then(function () {
            sendRecipeList('apps-script', recipeList, payload.total || 0);
          });
        });
    }).catch(function (err) {
      log.error('[api/recipes] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch recipes' });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/recipes/:id — Single recipe detail with ingredients
// ---------------------------------------------------------------------------

router.get('/api/recipes/:id', function (req, res) {
  var recipeId = req.params.id;
  var cacheKey = C.CACHE_KEYS.RECIPES + ':' + recipeId;

  return isRecipeStaff(req).then(function (isStaff) {
    // Staff/kiosk tiers keep today's full response (recipe + ingredients)
    // unchanged. Non-staff callers of a non-active recipe get 404 — the
    // same shape as "recipe does not exist" — so an id enumerator cannot
    // distinguish "draft" from "missing" (T-74-02). Active recipes are
    // projected through the field allowlist with the `ingredients` key
    // absent entirely, not an empty array.
    function sendRecipeDetail(result) {
      if (isStaff) {
        return res.json(result);
      }
      var status = String((result.recipe && result.recipe.status) || '').toLowerCase();
      if (status !== 'active') {
        return res.status(404).json({ error: 'Recipe not found' });
      }
      return res.json({ recipe: toPublicRecipe(result.recipe) });
    }

    return cache.get(cacheKey).then(function (cached) {
      if (cached) {
        log.info('[api/recipes/' + recipeId + '] Cache hit');
        return enrichWithComputedPrice(cached.recipe, cached.ingredients).then(function () {
          return enrichIngredientGroups(cached.ingredients);
        }).then(function () {
          // Full result stays cached regardless of caller tier — staff and
          // the kiosk depend on it. Projection happens only at response time.
          cache.set(cacheKey, cached, RECIPES_CACHE_TTL);
          sendRecipeDetail(cached);
        });
      }
      return callAppsScriptPost('get_recipe', { recipe_id: recipeId })
        .then(function (data) {
          if (!data.ok) {
            return res.status(404).json({ error: data.message || 'Recipe not found' });
          }
          var detail = data.data || {};
          var result = { recipe: detail.recipe || detail, ingredients: detail.ingredients || [] };
          return enrichWithComputedPrice(result.recipe, result.ingredients).then(function () {
            return enrichIngredientGroups(result.ingredients);
          }).then(function () {
            cache.set(cacheKey, result, RECIPES_CACHE_TTL);
            sendRecipeDetail(result);
          });
        });
    }).catch(function (err) {
      log.error('[api/recipes/' + recipeId + '] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch recipe' });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /api/recipes/:id/availability — Per-ingredient stock status
// ---------------------------------------------------------------------------

router.get('/api/recipes/:id/availability', function (req, res) {
  // M8 (Phase 52-05): this route calls Apps Script uncached — gate behind a
  // credential (kiosk device tokens included, D-46 tier) so an anon caller
  // cannot repeatedly exhaust Apps Script quota. The global GET exemption in
  // server.js skips this route, so it must resolve its own tier.
  return authTiers.requireTiers(['legacy', 'device', 'session'])(req, res, function () {
    var recipeId = req.params.id;
    var cacheKey = C.CACHE_KEYS.RECIPE_AVAILABILITY + ':' + recipeId;

    return cache.get(cacheKey).then(function (cached) {
      if (cached) {
        return res.json(cached);
      }

      // Step 1: Fetch recipe ingredients from Apps Script (server fetches item_ids, never client — API-02)
      return callAppsScriptPost('get_recipe', { recipe_id: recipeId }).then(function (data) {
        if (!data.ok) {
          return res.status(404).json({ error: data.message || 'Recipe not found' });
        }
        var detail = data.data || {};
        var ingredients = detail.ingredients || [];
        if (!ingredients.length) {
          return res.json({ recipe_id: recipeId, summary: 'all_ok', ingredients: [] });
        }

        // Step 2: Get ingredient stock from the full cached ingredients catalog (includes internal-only items)
        return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
          // If full ingredients cache is cold, return unknown status (Pitfall 5) — NOT cached,
          // so a subsequent request re-checks once the ingredients catalog warms up.
          if (!catalog) {
            var unknownResult = ingredients.map(function (ing) {
              return {
                item_id: ing.item_id,
                item_name: ing.item_name,
                unit: ing.unit,
                quantity_per_batch: ing.quantity || 0,
                stock_on_hand: null,
                batches_possible: null,
                status: 'unknown'
              };
            });
            return res.json({ recipe_id: recipeId, summary: 'unknown', ingredients: unknownResult });
          }

          // Build catalog entry map (unit + stock_on_hand) from cached ingredients.
          // 73-06 (WR-01): retain the full entry — the prior stockMap dropped
          // `unit`, so `needed` was compared/divided in the recipe line's own
          // unit against stock_on_hand in the item's stocking unit with no
          // conversion.
          var entryMap = {};
          (Array.isArray(catalog) ? catalog : []).forEach(function (item) {
            entryMap[String(item.item_id)] = item;
          });

          // Step 3: Compute per-ingredient availability (D-07, D-08), unit-converted (D-01/D-02)
          var result = ingredients.map(function (ing) {
            var entry = entryMap[String(ing.item_id)];
            var stock = entry ? (Number(entry.stock_on_hand) || 0) : 0;

            var needed;
            if (entry) {
              var lineCost = scaling.ingredientLineCost(entry, ing);
              if (lineCost.ok) {
                needed = lineCost.convertedQty;
              } else {
                // Non-convertible unit pair — fail CLOSED (D-02 phase-wide
                // pattern): this endpoint is informational only, so a
                // conservative "unavailable" badge is the safe default
                // rather than dividing raw mismatched units.
                needed = -1;
              }
            } else {
              needed = Number(ing.quantity) || 0;
            }

            var batches = needed < 0 ? 0 : (needed > 0 ? Math.floor(stock / needed) : 999);
            var status = batches === 0 ? 'out' : batches < 3 ? 'low' : 'ok';
            return {
              item_id: ing.item_id,
              item_name: ing.item_name,
              unit: ing.unit,
              quantity_per_batch: ing.quantity || 0,
              stock_on_hand: stock,
              batches_possible: batches,
              status: status
            };
          });

          var anyOut = result.some(function (r) { return r.status === 'out'; });
          var allOk = result.every(function (r) { return r.status === 'ok'; });
          var summary = anyOut ? 'cannot_brew' : allOk ? 'all_ok' : 'some_low';

          var response = { recipe_id: recipeId, summary: summary, ingredients: result };
          cache.set(cacheKey, response, RECIPES_CACHE_TTL);
          res.json(response);
        });
      });
    }).catch(function (err) {
      log.error('[api/recipes/' + recipeId + '/availability] ' + err.message);
      res.status(502).json({ error: 'Unable to check availability' });
    });
  });
});

// ---------------------------------------------------------------------------
// Helper — D-03 save-time unit validation pre-flight
// ---------------------------------------------------------------------------

/**
 * Validate that every incoming recipe ingredient line's unit is convertible
 * to its catalog item's unit (D-01/D-02/D-03), BEFORE any Apps Script write.
 *
 * Reuses the shared scaling.classifyUnit / scaling.ingredientLineCost
 * conversion rules (does not duplicate them) so read-path and write-path
 * unit-compatibility logic can never drift apart.
 *
 * Resolves to `null` when the payload is valid (or cannot be validated —
 * e.g. cold cache with no fallback file, matching the enrichWithComputedPrice/
 * enrichListPrices "degrade gracefully" idiom elsewhere in this file), or to
 * the pinned rejection body `{ error, code: 'unit_mismatch', cause }` on the
 * FIRST non-convertible line found in payload order.
 *
 * @param {Array} ingredients - payload.ingredients from the write request
 * @returns {Promise<null|{error:string, code:string, cause:string}>}
 */
function validateIngredientUnits(ingredients) {
  if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
    return Promise.resolve(null);
  }

  return cache.get(C.CACHE_KEYS.INGREDIENTS_ALL).then(function (catalog) {
    if (!catalog || !Array.isArray(catalog)) {
      // Redis cold — fall back to the full-catalog file (same idiom as
      // enrichWithComputedPrice/enrichListPrices above).
      try {
        catalog = JSON.parse(fs.readFileSync(INGREDIENTS_ALL_FILE_CACHE, 'utf8'));
      } catch {
        catalog = null;
      }
      // Cannot validate without a catalog — degrade gracefully (never block
      // a save on validation infrastructure being unavailable).
      if (!catalog || !Array.isArray(catalog)) return null;
    }

    var map = {};
    catalog.forEach(function (item) { if (item && item.item_id) map[item.item_id] = item; });

    for (var i = 0; i < ingredients.length; i++) {
      var line = ingredients[i];
      var entry = map[line && line.item_id];
      if (!entry) continue; // unknown item — nothing to validate against (matches enrichment idiom)

      var lineCost = scaling.ingredientLineCost(entry, line);
      if (!lineCost.ok) {
        var label = (line && (line.item_name || line.item_id)) ||
          (entry && (entry.name || entry.item_name)) || 'item';
        return {
          error: 'Cannot save recipe: "' + label + '" unit "' + (line && line.unit) +
            '" is not convertible to catalog unit "' + (entry && entry.unit) + '"',
          code: 'unit_mismatch',
          cause: label
        };
      }
    }

    return null;
  }).catch(function () {
    // Never block a save on unexpected validation-infra failure.
    return null;
  });
}

// ---------------------------------------------------------------------------
// POST /api/recipes — Create new recipe
// ---------------------------------------------------------------------------

router.post('/api/recipes', function (req, res) {
  var payload = req.body || {};

  return validateIngredientUnits(payload.ingredients).then(function (rejection) {
    if (rejection) {
      return res.status(422).json(rejection);
    }
    return callAppsScriptPost('create_recipe', payload).then(function (data) {
      if (!data.ok) {
        return res.status(422).json({ error: data.message || data.error || 'Create failed', code: 'save_failed' });
      }
      return bustRecipeCache(null).then(function () {
        res.status(201).json({ ok: true, recipe_id: data.recipe_id || (data.data && data.data.recipe_id) });
      });
    });
  }).catch(function (err) {
    log.error('[api/recipes] POST failed: ' + err.message);
    res.status(502).json({ error: 'Unable to create recipe', code: 'save_failed' });
  });
});

// ---------------------------------------------------------------------------
// PUT /api/recipes/:id — Update recipe (with activation guardrail D-02)
// ---------------------------------------------------------------------------

router.put('/api/recipes/:id', function (req, res) {
  var payload = req.body || {};
  payload.recipe_id = req.params.id;

  // D-02 activation guardrail — enforce server-side (Pitfall 7, T-13-04)
  if (payload.status === 'active') {
    var ingCount = parseInt(payload.ingredient_count, 10) || 0;
    var lockedPrice = parseFloat(payload.locked_price) || 0;
    if (lockedPrice <= 0) {
      return res.status(422).json({
        error: 'Cannot activate recipe: a valid locked price must be set',
        code: 'activation_locked_price'
      });
    }
    if (ingCount < 1) {
      return res.status(422).json({
        error: 'Cannot activate recipe: at least one ingredient must exist',
        code: 'activation_no_ingredients'
      });
    }
  }

  return validateIngredientUnits(payload.ingredients).then(function (rejection) {
    if (rejection) {
      return res.status(422).json(rejection);
    }
    return callAppsScriptPost('update_recipe', payload).then(function (data) {
      if (!data.ok) {
        return res.status(422).json({ error: data.message || data.error || 'Update failed', code: 'save_failed' });
      }
      return bustRecipeCache(req.params.id).then(function () {
        res.json({ ok: true });
      });
    });
  }).catch(function (err) {
    log.error('[api/recipes] PUT ' + req.params.id + ' failed: ' + err.message);
    res.status(502).json({ error: 'Unable to update recipe', code: 'save_failed' });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/recipes/:id — Delete recipe
// ---------------------------------------------------------------------------

router.delete('/api/recipes/:id', function (req, res) {
  var payload = { recipe_id: req.params.id };

  callAppsScriptPost('delete_recipe', payload).then(function (data) {
    if (!data.ok) {
      return res.status(422).json({ error: data.message || data.error || 'Delete failed' });
    }
    return bustRecipeCache(req.params.id).then(function () {
      res.json({ ok: true });
    });
  }).catch(function (err) {
    log.error('[api/recipes] DELETE ' + req.params.id + ' failed: ' + err.message);
    res.status(502).json({ error: 'Unable to delete recipe' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/recipes/bust-cache — Manual cache invalidation for admin use
// ---------------------------------------------------------------------------

router.post('/api/recipes/bust-cache', function (req, res) {
  bustRecipeCache(null).then(function () {
    log.info('[api/recipes] Manual cache bust');
    res.json({ ok: true, message: 'Recipe cache cleared' });
  }).catch(function (err) {
    log.error('[api/recipes] Cache bust failed: ' + err.message);
    res.status(500).json({ error: 'Cache bust failed' });
  });
});

module.exports = router;

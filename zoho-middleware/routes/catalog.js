var express = require('express');
var fs = require('fs');
var path = require('path');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');

var ledger = require('../lib/inventory-ledger');

var inventoryGet = zohoApi.inventoryGet;
var fetchAllItems = zohoApi.fetchAllItems;

// ---------------------------------------------------------------------------
// Shared raw items cache
// ---------------------------------------------------------------------------
// A short-lived (60 s) in-memory cache that coalesces concurrent cold-cache
// requests across services/ingredients/kiosk/snapshot into a single Zoho
// paginated fetch. Without this, a simultaneous cold-cache burst fires 3–4
// full fetchAllItems() calls in parallel, burning Zoho rate-limit quota.
// doRefreshProducts() is intentionally excluded — it runs under a distributed
// lock and does its own filtering; sharing its fetch here could return a
// stale raw list during the enrichment window.

var _rawItemsCache = null;
var _rawItemsCacheAt = 0;
var RAW_ITEMS_TTL_MS = 60 * 1000; // 60 seconds
var _rawItemsPromise = null;
// Timestamp after which it is safe to retry Zoho Inventory list fetches.
// Set to now+90s after a 429 to give Zoho's per-minute quota time to reset.
var _rawItemsCooldownUntil = 0;
var _productsCooldownUntil = 0;

function fetchAllItemsCached() {
  var now = Date.now();
  if (_rawItemsCache && (now - _rawItemsCacheAt) < RAW_ITEMS_TTL_MS) {
    return Promise.resolve(_rawItemsCache);
  }
  if (now < _rawItemsCooldownUntil) {
    var waitSec = Math.ceil((_rawItemsCooldownUntil - now) / 1000);
    return Promise.reject(new Error('Zoho Inventory rate-limited — cooling down (' + waitSec + 's remaining)'));
  }
  if (_rawItemsPromise) return _rawItemsPromise;
  _rawItemsPromise = fetchAllItems({ status: 'active' }).then(function (items) {
    _rawItemsCache = items;
    _rawItemsCacheAt = Date.now();
    _rawItemsPromise = null;
    return items;
  }, function (err) {
    _rawItemsPromise = null;
    if (err.response && err.response.status === 429) {
      var retryAfter = err.response.headers && parseInt(err.response.headers['retry-after'], 10);
      _rawItemsCooldownUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 90000);
      log.warn('[catalog] Inventory list 429 — cooldown until ' + new Date(_rawItemsCooldownUntil).toISOString());
    }
    throw err;
  });
  return _rawItemsPromise;
}

var router = express.Router();

// ---------------------------------------------------------------------------
// Cache constants
// ---------------------------------------------------------------------------

var PRODUCTS_CACHE_KEY = 'zoho:products';
var PRODUCTS_CACHE_TTL = 3600; // 1 hour hard TTL
var PRODUCTS_SOFT_TTL = 600;   // 10 minutes — triggers background refresh
var PRODUCTS_CACHE_TS_KEY = 'zoho:products:ts'; // timestamp of last enrichment
var PRODUCT_IMAGE_HASHES_KEY = 'zoho:product-image-hashes'; // image change detection
var REFRESH_LOCK_KEY = 'products:refresh';
var REFRESH_LOCK_TTL = 120; // 2-min auto-expire if process crashes mid-refresh
// __dirname is routes/ subdirectory, so go up one level to middleware root
var PRODUCTS_FILE_CACHE = path.join(__dirname, '..', 'products-cache.json');
var INGREDIENTS_FILE_CACHE = path.join(__dirname, '..', 'ingredients-cache.json');

var SERVICES_CACHE_KEY = 'zoho:services';
var SERVICES_CACHE_TTL = 1800; // 30 minutes

var INGREDIENTS_CACHE_KEY = 'zoho:ingredients';
var INGREDIENTS_CACHE_TTL = 3600; // 1 hour (match products TTL)
var INGREDIENTS_CACHE_TS_KEY = 'zoho:ingredients:ts';
var INGREDIENTS_SOFT_TTL = 600; // 10 minutes — triggers background refresh

var KIOSK_PRODUCTS_CACHE_KEY = 'zoho:kiosk-products';
var KIOSK_PRODUCTS_CACHE_TTL = 1800; // 30 minutes

// Kit type values that belong on the kits/products page.
// Used by both doRefreshProducts() and GET /api/ingredients.
var KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

// In-memory set of kit item IDs (populated by GET /api/products).
// Used by /api/ingredients to exclude kits even when Redis is down.
var _kitItemIds = {};
var _productsRefreshing = false; // in-process guard (Redis-down fallback)
var _ingredientsRefreshPromise = null; // coalesces concurrent cold-cache requests

// ---------------------------------------------------------------------------
// Product refresh logic
// ---------------------------------------------------------------------------

/**
 * GET /api/products
 * Returns active product items from Zoho Inventory, enriched with custom_fields
 * and brand from the detail endpoint. Cached in Redis for 10 minutes.
 *
 * The list endpoint does not return custom_fields, so we fetch each item's
 * detail (5 concurrent) to get type, subcategory, tasting notes, body, oak,
 * sweetness, ABV, etc. Services and Ingredients groups are filtered out.
 */
function refreshProducts() {
  // Fast in-process guard first (no Redis round-trip needed for single-instance case)
  if (_productsRefreshing) {
    log.info('[api/products] Refresh already in progress, skipping');
    return Promise.resolve();
  }

  // 429 cooldown — don't hammer Zoho immediately after a rate-limit response
  if (Date.now() < _productsCooldownUntil) {
    var waitSec = Math.ceil((_productsCooldownUntil - Date.now()) / 1000);
    log.info('[api/products] 429 cooldown active — skipping refresh (' + waitSec + 's remaining)');
    return Promise.resolve();
  }

  // Redis distributed lock — prevents concurrent refreshes across multiple instances
  return cache.acquireLock(REFRESH_LOCK_KEY, REFRESH_LOCK_TTL)
    .then(function (acquired) {
      if (!acquired) {
        log.info('[api/products] Refresh lock held by another instance, skipping');
        return Promise.resolve();
      }
      _productsRefreshing = true;
      log.info('[api/products] Refreshing product data from Zoho Inventory');
      return doRefreshProducts();
    });
}

function doRefreshProducts() {
  return fetchAllItems({ status: 'active' })
    .then(function (items) {
      var serialPattern = /\s—\s[A-Z]+-\d+$/;
      items = items.filter(function (item) {
        if (item.product_type === 'service') return false;
        if (serialPattern.test(item.group_name || '')) return false;
        return true;
      });

      log.info('[api/products] Enriching ' + items.length + ' items (parallel batches of 5)');

      var BATCH_SIZE = 5;
      var BATCH_PAUSE = 3500; // ms between batches (~85 req/min)
      var MAX_RETRIES = 2;
      var enriched = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      function fetchDetail(item, retries) {
        return inventoryGet('/items/' + item.item_id)
          .then(function (data) {
            var detail = data.item || {};
            item.custom_fields = detail.custom_fields || [];
            item.brand = detail.brand || '';
            item.image_name = detail.image_name || '';
            item.tax_id = detail.tax_id || '';
            item.tax_name = detail.tax_name || '';
            item.tax_percentage = (detail.tax_percentage !== undefined && detail.tax_percentage !== null)
              ? detail.tax_percentage : 0;
            item.vendor_id = detail.vendor_id || '';
            item.vendor_name = detail.vendor_name || '';
            return item;
          })
          .catch(function (err) {
            if (err.response && err.response.status === 429 && retries < MAX_RETRIES) {
              var backoff = Math.pow(2, retries + 1) * 1000;
              log.warn('[api/products] Rate limited on ' + item.name + ', retrying in ' + backoff + 'ms');
              return delay(backoff).then(function () { return fetchDetail(item, retries + 1); });
            }
            log.error('[api/products] Detail fetch failed for ' + item.name + ': ' + err.message);
            item.custom_fields = [];
            item.brand = item.brand || '';
            item.tax_id = item.tax_id || '';
            item.tax_name = item.tax_name || '';
            item.tax_percentage = (item.tax_percentage !== undefined && item.tax_percentage !== null)
              ? item.tax_percentage : 0;
            return item;
          });
      }

      // Process items in parallel batches
      var batches = [];
      for (var i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push(items.slice(i, i + BATCH_SIZE));
      }

      var chain = Promise.resolve();
      batches.forEach(function (batch, idx) {
        chain = chain.then(function () {
          return Promise.all(batch.map(function (item) {
            return fetchDetail(item, 0);
          })).then(function (results) {
            results.forEach(function (r) { enriched.push(r); });
            // Pause between batches (skip after last batch)
            if (idx < batches.length - 1) return delay(BATCH_PAUSE);
          });
        });
      });

      return chain.then(function () {
        // Kit items are identified by their Type CF matching a KIT_CATEGORY exactly.
        // Items with Type = 'Ingredient', 'Equipment', etc. are excluded from kits
        // even if their Category CF references a kit category (e.g. "Beer ingredients").
        enriched = enriched.filter(function (item) {
          var typeCF = (item.custom_fields || []).find(function (cf) {
            return cf.label === 'Type' && cf.value;
          });
          if (!typeCF) return false;
          var typeVal = typeCF.value.toLowerCase();
          if (!KIT_CATEGORIES.some(function (kc) { return typeVal === kc; })) {
            log.info('[api/products] Excluding non-kit item: ' + item.name + ' (type: ' + typeCF.value + ')');
            return false;
          }
          return true;
        });
        _kitItemIds = {};
        enriched.forEach(function (item) { _kitItemIds[item.item_id] = true; });
        // Bust the ingredients cache so it rebuilds without these items in _kitItemIds
        cache.del(INGREDIENTS_CACHE_KEY);
        cache.set(PRODUCTS_CACHE_KEY, enriched, PRODUCTS_CACHE_TTL);
        cache.set(PRODUCTS_CACHE_TS_KEY, Date.now(), PRODUCTS_CACHE_TTL);
        log.info('[api/products] Cached ' + enriched.length + ' kit items');

        // Reconcile inventory ledger with fresh Zoho stock counts
        ledger.reconcile(enriched).catch(function (err) {
          log.error('[api/products] Inventory ledger reconcile failed: ' + err.message);
        });

        // Write file fallback (async, fire-and-forget)
        fs.writeFile(PRODUCTS_FILE_CACHE, JSON.stringify(enriched), function (fileErr) {
          if (fileErr) {
            log.error('[api/products] File fallback write failed: ' + fileErr.message);
          } else {
            log.info('[api/products] Wrote file fallback (' + enriched.length + ' items)');
          }
        });

        // --- Image change detection ---
        // Build a map of item_id -> image_name from the enriched detail data.
        // The detail endpoint includes image_name when an item has an image.
        var currentImageMap = {};
        enriched.forEach(function (item) {
          if (item.image_name) {
            currentImageMap[item.item_id] = item.image_name;
          }
        });

        // Compare against the previously cached image map (fire-and-forget)
        cache.get(PRODUCT_IMAGE_HASHES_KEY)
          .then(function (previousImageMap) {
            previousImageMap = previousImageMap || {};
            var changed = [];
            var newImages = [];

            Object.keys(currentImageMap).forEach(function (itemId) {
              if (!previousImageMap[itemId]) {
                newImages.push(itemId);
              } else if (previousImageMap[itemId] !== currentImageMap[itemId]) {
                changed.push(itemId);
              }
            });

            if (changed.length > 0 || newImages.length > 0) {
              log.info('[api/products] Image changes detected (' +
                changed.length + ' changed, ' + newImages.length + ' new) — run sync-images to update');
            }

            // Store the new image map in Redis (same TTL as products cache)
            return cache.set(PRODUCT_IMAGE_HASHES_KEY, currentImageMap, 86400); // 24 hours — outlasts product cache so diffs are always meaningful
          })
          .catch(function (imgErr) {
            log.error('[api/products] Image change detection error: ' + imgErr.message);
          });

        _productsRefreshing = false;
        cache.releaseLock(REFRESH_LOCK_KEY);
        return enriched;
      });
    })
    .catch(function (err) {
      _productsRefreshing = false;
      cache.releaseLock(REFRESH_LOCK_KEY);
      if (err.response && err.response.status === 429) {
        var retryAfter = err.response.headers && parseInt(err.response.headers['retry-after'], 10);
        _productsCooldownUntil = Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 90000);
        log.warn('[api/products] 429 rate limit — cooldown until ' + new Date(_productsCooldownUntil).toISOString());
      }
      throw err;
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get('/api/products', function (req, res) {
  cache.get(PRODUCTS_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        log.info('[api/products] Cache hit (' + cached.length + ' items)');
        if (!Object.keys(_kitItemIds).length) {
          cached.forEach(function (item) { _kitItemIds[item.item_id] = true; });
        }
        ledger.overlayStock(cached).then(function (overlaid) {
          res.json({ source: 'cache', items: overlaid });
        }).catch(function (err) {
          log.error('[api/products] overlayStock failed: ' + err.message);
          res.json({ source: 'cache', items: cached });
        });

        // Stale-while-revalidate: if cache is older than soft TTL, refresh in background
        cache.get(PRODUCTS_CACHE_TS_KEY).then(function (ts) {
          var age = ts ? (Date.now() - ts) / 1000 : PRODUCTS_SOFT_TTL + 1;
          if (age > PRODUCTS_SOFT_TTL) {
            log.info('[api/products] Cache stale (' + Math.round(age) + 's old), refreshing in background');
            refreshProducts().catch(function (err) {
              log.error('[api/products] Background refresh failed: ' + err.message);
            });
          }
        });
        return;
      }

      // Try file fallback before slow enrichment
      var fileData = null;
      try {
        fileData = JSON.parse(fs.readFileSync(PRODUCTS_FILE_CACHE, 'utf8'));
      } catch (e) {}

      if (fileData && fileData.length > 0) {
        log.info('[api/products] File fallback hit (' + fileData.length + ' items)');
        // Populate in-memory kit IDs
        fileData.forEach(function (item) { _kitItemIds[item.item_id] = true; });
        // Also populate Redis cache from file
        cache.set(PRODUCTS_CACHE_KEY, fileData, PRODUCTS_CACHE_TTL);
        cache.set(PRODUCTS_CACHE_TS_KEY, Date.now(), PRODUCTS_CACHE_TTL);
        ledger.overlayStock(fileData).then(function (overlaid) {
          res.json({ source: 'file-cache', items: overlaid });
        }).catch(function (err) {
          log.error('[api/products] overlayStock failed: ' + err.message);
          res.json({ source: 'file-cache', items: fileData });
        });
        // Trigger background refresh
        refreshProducts().catch(function (err) {
          log.error('[api/products] Background refresh failed: ' + err.message);
        });
        return;
      }

      log.info('[api/products] Cache miss — fetching from Zoho Inventory');
      return refreshProducts()
        .then(function (enriched) {
          if (enriched && enriched.length) {
            return ledger.overlayStock(enriched).then(function (overlaid) {
              res.json({ source: 'zoho', items: overlaid });
            }).catch(function (err) {
              log.error('[api/products] overlayStock failed: ' + err.message);
              res.json({ source: 'zoho', items: enriched });
            });
          }
          // refreshProducts() returned early (cooldown or lock held by another instance).
          // Check if another instance populated the cache in the meantime.
          return cache.get(PRODUCTS_CACHE_KEY).then(function (cached) {
            if (cached && cached.length) {
              return ledger.overlayStock(cached).then(function (overlaid) {
                res.json({ source: 'cache', items: overlaid });
              }).catch(function (err) {
                log.error('[api/products] overlayStock failed: ' + err.message);
                res.json({ source: 'cache', items: cached });
              });
            }
            res.status(502).json({ error: 'Unable to fetch products' });
          });
        });
    })
    .catch(function (err) {
      log.error('[api/products] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch products' });
    });
});

/**
 * GET /api/services
 * Returns active service-type items from Zoho Inventory, cached for 5 minutes.
 */
router.get('/api/services', function (req, res) {
  cache.get(SERVICES_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        log.info('[api/services] Cache hit');
        return res.json({ source: 'cache', items: cached });
      }

      log.info('[api/services] Cache miss — fetching from Zoho Inventory');
      return fetchAllItemsCached()
        .then(function (allItems) {
          var items = allItems.filter(function (item) {
            return item.product_type === 'service';
          });
          // Enrich each service item with detail (tax_percentage, tax_name, tax_id)
          // Services list is small so we fetch all details sequentially
          return items.reduce(function (chain, item) {
            return chain.then(function () {
              return inventoryGet('/items/' + item.item_id)
                .then(function (data) {
                  var detail = data.item || {};
                  item.tax_id = detail.tax_id || '';
                  item.tax_name = detail.tax_name || '';
                  item.tax_percentage = (detail.tax_percentage !== undefined && detail.tax_percentage !== null)
                    ? detail.tax_percentage : 0;
                })
                .catch(function (err) {
                  log.warn('[api/services] Detail fetch failed for ' + item.name + ': ' + err.message);
                  item.tax_percentage = item.tax_percentage != null ? item.tax_percentage : 0;
                  item.tax_name = item.tax_name || '';
                  item.tax_id = item.tax_id || '';
                });
            });
          }, Promise.resolve())
            .then(function () {
              cache.set(SERVICES_CACHE_KEY, items, SERVICES_CACHE_TTL);
              res.json({ source: 'zoho', items: items });
            });
        });
    })
    .catch(function (err) {
      log.error('[api/services] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch services' });
    });
});

/**
 * Fetch, enrich, and cache ingredients from Zoho Inventory.
 * Extracted from the route handler so server.js can call it for pre-warming.
 * Uses promise coalescing (_ingredientsRefreshPromise) so concurrent requests
 * (e.g. startup pre-warm + first user request) share a single Zoho round-trip.
 */
function doRefreshIngredients() {
  if (_ingredientsRefreshPromise) return _ingredientsRefreshPromise;

  _ingredientsRefreshPromise = fetchAllItemsCached()
    .then(function (allItems) {
      // Use cf_type (available from list endpoint, no enrichment needed) to
      // exclude kit items. This avoids a race condition where _kitItemIds is
      // empty during startup while the products pre-warm is still running.
      var items = allItems.filter(function (item) {
        if (item.product_type === 'service') return false;
        if (item.rate <= 0) return false;
        var cfType = (item.cf_type || '').toLowerCase();
        if (cfType && KIT_CATEGORIES.indexOf(cfType) !== -1) return false;
        if (_kitItemIds[item.item_id]) return false; // belt-and-suspenders
        return true;
      });

      log.info('[api/ingredients] Enriching ' + items.length + ' priced items (batches of 10)');

      var BATCH_SIZE = 5;
      var BATCH_PAUSE = 3500; // ms between batches (~85 req/min, matches products)
      var MAX_RETRIES = 2;
      var enriched = [];

      function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

      function fetchDetail(item, retries) {
        return inventoryGet('/items/' + item.item_id)
          .then(function (data) {
            var detail = data.item || {};
            item.custom_fields = detail.custom_fields || [];
            item.brand = detail.brand || '';
            item.tax_id = detail.tax_id || '';
            item.tax_name = detail.tax_name || '';
            item.tax_percentage = (detail.tax_percentage !== undefined && detail.tax_percentage !== null)
              ? detail.tax_percentage : 0;
            return item;
          })
          .catch(function (err) {
            if (err.response && err.response.status === 429 && retries < MAX_RETRIES) {
              var backoff = Math.pow(2, retries + 1) * 1000;
              log.warn('[api/ingredients] Rate limited on ' + item.name + ', retrying in ' + backoff + 'ms');
              return delay(backoff).then(function () { return fetchDetail(item, retries + 1); });
            }
            log.error('[api/ingredients] Detail fetch failed for ' + item.name + ': ' + err.message);
            item.custom_fields = [];
            item.tax_percentage = (item.tax_percentage !== undefined && item.tax_percentage !== null)
              ? item.tax_percentage : 0;
            item.tax_name = item.tax_name || '';
            item.tax_id = item.tax_id || '';
            return item;
          });
      }

      var batches = [];
      for (var i = 0; i < items.length; i += BATCH_SIZE) {
        batches.push(items.slice(i, i + BATCH_SIZE));
      }

      var chain = Promise.resolve();
      batches.forEach(function (batch, idx) {
        chain = chain.then(function () {
          return Promise.all(batch.map(function (item) {
            return fetchDetail(item, 0);
          })).then(function (results) {
            results.forEach(function (r) { enriched.push(r); });
            if (idx < batches.length - 1) return delay(BATCH_PAUSE);
          });
        });
      });

      return chain.then(function () {
        _ingredientsRefreshPromise = null;
        if (enriched.length > 0) {
          cache.set(INGREDIENTS_CACHE_KEY, enriched, INGREDIENTS_CACHE_TTL);
          cache.set(INGREDIENTS_CACHE_TS_KEY, Date.now(), INGREDIENTS_CACHE_TTL);
          // Reconcile inventory ledger with fresh Zoho stock counts
          ledger.reconcile(enriched).catch(function (err) {
            log.error('[api/ingredients] Inventory ledger reconcile failed: ' + err.message);
          });
          // Write file fallback (async, fire-and-forget)
          fs.writeFile(INGREDIENTS_FILE_CACHE, JSON.stringify(enriched), function (fileErr) {
            if (fileErr) {
              log.error('[api/ingredients] File fallback write failed: ' + fileErr.message);
            } else {
              log.info('[api/ingredients] Wrote file fallback (' + enriched.length + ' items)');
            }
          });
        } else {
          log.warn('[api/ingredients] Enrichment returned 0 items — skipping cache to allow retry');
        }
        return enriched;
      });
    })
    .catch(function (err) {
      _ingredientsRefreshPromise = null;
      throw err;
    });

  return _ingredientsRefreshPromise;
}

/**
 * GET /api/ingredients
 * Returns active goods items that are NOT kits (no Type custom field)
 * and NOT services. These are ingredients, supplies, and equipment.
 * Uses the products cache to identify kit item IDs to exclude.
 */
router.get('/api/ingredients', function (req, res) {
  cache.get(INGREDIENTS_CACHE_KEY)
    .then(function (cached) {
      if (cached && cached.length > 0) {
        log.info('[api/ingredients] Cache hit (' + cached.length + ' items)');
        ledger.overlayStock(cached).then(function (overlaid) {
          res.json({ source: 'cache', items: overlaid });
        }).catch(function (err) {
          log.error('[api/ingredients] overlayStock failed: ' + err.message);
          res.json({ source: 'cache', items: cached });
        });

        // Stale-while-revalidate: if cache is older than soft TTL, refresh in background
        cache.get(INGREDIENTS_CACHE_TS_KEY).then(function (ts) {
          var age = ts ? (Date.now() - ts) / 1000 : INGREDIENTS_SOFT_TTL + 1;
          if (age > INGREDIENTS_SOFT_TTL) {
            log.info('[api/ingredients] Cache stale (' + Math.round(age) + 's old), refreshing in background');
            doRefreshIngredients().catch(function (err) {
              log.error('[api/ingredients] Background refresh failed: ' + err.message);
            });
          }
        });
        return;
      }

      // Try file fallback before slow enrichment
      var fileData = null;
      try {
        fileData = JSON.parse(fs.readFileSync(INGREDIENTS_FILE_CACHE, 'utf8'));
      } catch (e) {}

      if (fileData && fileData.length > 0) {
        log.info('[api/ingredients] File fallback hit (' + fileData.length + ' items)');
        cache.set(INGREDIENTS_CACHE_KEY, fileData, INGREDIENTS_CACHE_TTL);
        ledger.overlayStock(fileData).then(function (overlaid) {
          res.json({ source: 'file-cache', items: overlaid });
        }).catch(function (err) {
          log.error('[api/ingredients] overlayStock failed: ' + err.message);
          res.json({ source: 'file-cache', items: fileData });
        });
        // Trigger background refresh
        doRefreshIngredients().catch(function (err) {
          log.error('[api/ingredients] Background refresh failed: ' + err.message);
        });
        return;
      }

      log.info('[api/ingredients] Cache miss — fetching from Zoho Inventory');
      return doRefreshIngredients()
        .then(function (enriched) {
          return ledger.overlayStock(enriched).then(function (overlaid) {
            res.json({ source: 'zoho', items: overlaid });
          }).catch(function (err) {
            log.error('[api/ingredients] overlayStock failed: ' + err.message);
            res.json({ source: 'zoho', items: enriched });
          });
        });
    })
    .catch(function (err) {
      log.error('[api/ingredients] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch products' });
    });
});

/**
 * GET /api/kiosk/products
 * Returns all active sellable items from Zoho Inventory with price, stock,
 * and tax info. Cached for 5 minutes. Intended for the in-store kiosk/POS.
 *
 * Returns items with: item_id, name, sku, rate, stock_on_hand, tax_percentage,
 * tax_name, category_name, image_name, product_type, custom_fields.
 *
 * Pagination: ?page=1&per_page=100 (default 200 per page, max 200)
 * Search: ?search=term (filters name/sku client-side from cache)
 * Category: ?category=wine (filters by category_name)
 */
router.get('/api/kiosk/products', function (req, res) {
  cache.get(KIOSK_PRODUCTS_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        log.info('[api/kiosk/products] Cache hit (' + cached.length + ' items)');
        return ledger.overlayStock(cached).then(function (overlaid) {
          res.json({ source: 'cache', items: overlaid });
        }).catch(function (err) {
          log.error('[api/kiosk/products] overlayStock failed: ' + err.message);
          res.json({ source: 'cache', items: cached });
        });
      }

      log.info('[api/kiosk/products] Cache miss — fetching from Zoho Inventory');

      return fetchAllItemsCached()
        .then(function (allItems) {
          // Use list endpoint data directly — tax_percentage, image_name, stock_on_hand
          // are all included in the Zoho items list response, so no per-item detail
          // calls are needed (which caused rate limiting with large catalogs).
          var sellable = allItems.filter(function (item) {
            return item.product_type !== 'service' && item.rate > 0;
          }).map(function (item) {
            return {
              item_id:       item.item_id,
              name:          item.name,
              sku:           item.sku || '',
              rate:          item.rate,
              stock_on_hand: item.stock_on_hand != null ? item.stock_on_hand : 0,
              category_name: item.category_name || '',
              product_type:  item.product_type || '',
              image_name:    item.image_name || '',
              tax_id:        item.tax_id || '',
              tax_name:      item.tax_name || '',
              tax_percentage: item.tax_percentage != null ? item.tax_percentage : 0,
              custom_fields: item.custom_fields || []
            };
          });

          cache.set(KIOSK_PRODUCTS_CACHE_KEY, sellable, KIOSK_PRODUCTS_CACHE_TTL);
          log.info('[api/kiosk/products] Cached ' + sellable.length + ' sellable items');
          // Reconcile inventory ledger with fresh kiosk catalog
          ledger.reconcile(sellable).catch(function (err) {
            log.error('[api/kiosk/products] Inventory ledger reconcile failed: ' + err.message);
          });
          return ledger.overlayStock(sellable).then(function (overlaid) {
            res.json({ source: 'zoho', items: overlaid });
          }).catch(function (err) {
            log.error('[api/kiosk/products] overlayStock failed: ' + err.message);
            res.json({ source: 'zoho', items: sellable });
          });
        });
    })
    .catch(function (err) {
      var status = (err.response && err.response.status) || 0;
      log.error('[api/kiosk/products] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch kiosk products', detail: err.message, zoho_status: status });
    });
});

/**
 * GET /api/snapshot
 * Returns a pre-shaped JSON snapshot of all three catalogs (products, ingredients,
 * services) suitable for use as a static fallback file. Reads from Redis caches
 * when warm; falls back to a fresh Zoho fetch if any cache is cold. Intended to
 * be called by zoho-middleware/scripts/export-snapshot.js before deploys.
 *
 * Response shape:
 * {
 *   generated_at: <ISO string>,
 *   products:     [ ...shaped kit items   ],
 *   ingredients:  [ ...shaped ing items   ],
 *   services:     [ ...shaped svc items   ]
 * }
 *
 * Each item is shaped identically to what the frontend mappers in modules 07/08/09
 * produce, so the snapshot is a drop-in replacement for live middleware data.
 */
router.get('/api/snapshot', function (req, res) {
  var KIT_CATS = ['wine', 'beer', 'cider', 'seltzer'];
  var state = { products: [], ingredients: [], services: [] };

  function flattenCF(customFields, obj) {
    (customFields || []).forEach(function (cf) {
      var key = (cf.label || '').toLowerCase().replace(/\s+/g, '_');
      if (key && cf.value !== undefined && cf.value !== null) {
        obj[key] = String(cf.value);
      }
    });
  }

  function shapeProduct(z) {
    var obj = {
      name:           z.name || '',
      sku:            z.sku || '',
      item_id:        z.item_id || '',
      brand:          z.brand || '',
      stock:          z.stock_on_hand != null ? String(z.stock_on_hand) : '0',
      description:    z.description || '',
      discount:       z.discount != null ? String(z.discount) : '0',
      _zoho_category: z.category_name || ''
    };
    flattenCF(z.custom_fields, obj);
    if (z.rate != null) {
      var rateNum = parseFloat(z.rate);
      if (!obj.retail_kit)     obj.retail_kit     = '$' + rateNum.toFixed(2);
      if (!obj.retail_instore) obj.retail_instore  = '$' + (rateNum + 50).toFixed(2);
    }
    return obj;
  }

  function shapeIngredient(z) {
    var obj = {
      name:           z.name || '',
      unit:           z.unit || '',
      price_per_unit: z.rate != null ? String(z.rate) : '',
      stock:          z.stock_on_hand != null ? String(z.stock_on_hand) : '0',
      description:    z.description || '',
      sku:            z.sku || '',
      category:       z.category_name || '',
      low_amount:     '',
      high_amount:    '',
      step:           ''
    };
    flattenCF(z.custom_fields, obj);
    return obj;
  }

  function shapeService(z) {
    return {
      name:        z.name || '',
      price:       z.rate != null ? String(z.rate) : '',
      description: z.description || '',
      sku:         z.sku || '',
      stock:       z.stock_on_hand != null ? String(z.stock_on_hand) : '0',
      discount:    z.discount != null ? String(z.discount) : '0'
    };
  }

  function ensureProducts() {
    return cache.get(PRODUCTS_CACHE_KEY).then(function (cached) {
      if (cached && cached.length > 0) {
        return ledger.overlayStock(cached).then(function (overlaid) {
          state.products = overlaid.map(shapeProduct);
        }).catch(function () {
          state.products = cached.map(shapeProduct);
        });
      }
      log.info('[api/snapshot] Products cache cold — triggering refresh');
      return refreshProducts()
        .then(function () { return cache.get(PRODUCTS_CACHE_KEY); })
        .then(function (p) {
          var items = p || [];
          return ledger.overlayStock(items).catch(function () { return items; });
        })
        .then(function (overlaid) { state.products = overlaid.map(shapeProduct); });
    });
  }

  function ensureIngredients() {
    return cache.get(INGREDIENTS_CACHE_KEY).then(function (cached) {
      if (cached && cached.length > 0) {
        return ledger.overlayStock(cached).then(function (overlaid) {
          state.ingredients = overlaid.map(shapeIngredient);
        }).catch(function () {
          state.ingredients = cached.map(shapeIngredient);
        });
      }
      log.info('[api/snapshot] Ingredients cache cold — fetching from Zoho');
      return fetchAllItemsCached().then(function (allItems) {
        var filtered = allItems.filter(function (item) {
          if (item.product_type === 'service') return false;
          if (item.rate <= 0) return false;
          var cfType = (item.cf_type || '').toLowerCase();
          if (cfType && KIT_CATS.indexOf(cfType) !== -1) return false;
          if (_kitItemIds[item.item_id]) return false;
          return true;
        });
        return ledger.overlayStock(filtered).catch(function () { return filtered; });
      }).then(function (overlaid) {
        state.ingredients = overlaid.map(shapeIngredient);
      });
    });
  }

  function ensureServices() {
    return cache.get(SERVICES_CACHE_KEY).then(function (cached) {
      if (cached && cached.length > 0) {
        state.services = cached.map(shapeService);
        return;
      }
      log.info('[api/snapshot] Services cache cold — fetching from Zoho');
      return fetchAllItemsCached().then(function (allItems) {
        var svcItems = allItems.filter(function (item) {
          return item.product_type === 'service';
        });
        state.services = svcItems.map(shapeService);
      });
    });
  }

  // Sequential rather than Promise.all — prevents three concurrent fetchAllItems()
  // calls hammering Zoho when all three caches are cold, which was the root cause
  // of the 429 rate-limit storms. If the products cache is warm the call returns
  // immediately from Redis, adding only microseconds of overhead.
  ensureProducts()
    .then(function () { return ensureIngredients(); })
    .then(function () { return ensureServices(); })
    .then(function () {
      res.json({
        generated_at: new Date().toISOString(),
        products:     state.products,
        ingredients:  state.ingredients,
        services:     state.services
      });
    })
    .catch(function (err) {
      log.error('[api/snapshot] ' + err.message);
      res.status(502).json({ error: 'Snapshot generation failed: ' + err.message });
    });
});

/**
 * POST /api/admin/upload-catalog
 *
 * Accepts a pre-shaped catalog JSON (products / ingredients / services arrays,
 * identical in structure to what /api/snapshot returns) and stores them in
 * Redis, overriding any Zoho-fetched data for 24 hours.
 *
 * Use this from the admin dashboard Export/Sync tab when the Zoho API is
 * down or quota-exhausted — upload a Zoho Inventory item export CSV and the
 * admin panel parses + posts it here without any Zoho API call.
 *
 * Auth: X-API-Key header required (enforced by server.js /api middleware).
 */
router.post('/api/admin/upload-catalog', function (req, res) {
  var products    = req.body.products    || [];
  var ingredients = req.body.ingredients || [];
  var services    = req.body.services    || [];

  if (!Array.isArray(products) || !Array.isArray(ingredients) || !Array.isArray(services)) {
    return res.status(400).json({ ok: false, error: 'Invalid payload: expected arrays for products, ingredients, services' });
  }

  if (products.length === 0 && ingredients.length === 0 && services.length === 0) {
    return res.status(400).json({ ok: false, error: 'Refusing empty catalog upload' });
  }

  var UPLOAD_TTL = 86400; // 24 hours — long enough to survive until Zoho recovers

  Promise.all([
    cache.set(PRODUCTS_CACHE_KEY, products, UPLOAD_TTL),
    cache.set(INGREDIENTS_CACHE_KEY, ingredients, UPLOAD_TTL),
    cache.set(SERVICES_CACHE_KEY, services, UPLOAD_TTL)
  ]).then(function () {
    log.info('[upload-catalog] Catalog overridden from admin CSV upload — ' +
      products.length + ' products, ' +
      ingredients.length + ' ingredients, ' +
      services.length + ' services (TTL=' + UPLOAD_TTL + 's)');
    res.json({ ok: true, products: products.length, ingredients: ingredients.length, services: services.length });
  }).catch(function (err) {
    log.error('[upload-catalog] Redis write failed: ' + err.message);
    res.status(500).json({ ok: false, error: 'Cache write failed: ' + err.message });
  });
});

// Expose refresh functions so server.js can call them for pre-warming
router.refreshProducts = refreshProducts;
router.refreshIngredients = doRefreshIngredients;

module.exports = router;

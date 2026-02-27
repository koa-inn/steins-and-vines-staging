var express = require('express');
var fs = require('fs');
var path = require('path');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');

var inventoryGet = zohoApi.inventoryGet;
var fetchAllItems = zohoApi.fetchAllItems;

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

var SERVICES_CACHE_KEY = 'zoho:services';
var SERVICES_CACHE_TTL = 300; // 5 minutes

var INGREDIENTS_CACHE_KEY = 'zoho:ingredients';
var INGREDIENTS_CACHE_TTL = 300; // 5 minutes

var KIOSK_PRODUCTS_CACHE_KEY = 'zoho:kiosk-products';
var KIOSK_PRODUCTS_CACHE_TTL = 300; // 5 minutes

// Kit type values that belong on the kits/products page.
// Used by both doRefreshProducts() and GET /api/ingredients.
var KIT_CATEGORIES = ['wine', 'beer', 'cider', 'seltzer'];

// In-memory set of kit item IDs (populated by GET /api/products).
// Used by /api/ingredients to exclude kits even when Redis is down.
var _kitItemIds = {};
var _productsRefreshing = false; // in-process guard (Redis-down fallback)

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
            return cache.set(PRODUCT_IMAGE_HASHES_KEY, currentImageMap, PRODUCTS_CACHE_TTL);
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
        res.json({ source: 'cache', items: cached });

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
        res.json({ source: 'file-cache', items: fileData });
        // Trigger background refresh
        refreshProducts().catch(function (err) {
          log.error('[api/products] Background refresh failed: ' + err.message);
        });
        return;
      }

      log.info('[api/products] Cache miss — fetching from Zoho Inventory');
      return refreshProducts()
        .then(function (enriched) {
          res.json({ source: 'zoho', items: enriched });
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
      return fetchAllItems({ status: 'active' })
        .then(function (allItems) {
          var items = allItems.filter(function (item) {
            return item.product_type === 'service';
          });
          cache.set(SERVICES_CACHE_KEY, items, SERVICES_CACHE_TTL);
          res.json({ source: 'zoho', items: items });
        });
    })
    .catch(function (err) {
      log.error('[api/services] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch services' });
    });
});

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
        return res.json({ source: 'cache', items: cached });
      }

      log.info('[api/ingredients] Cache miss — fetching from Zoho Inventory');
      return fetchAllItems({ status: 'active' })
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

          log.info('[api/ingredients] Enriching ' + items.length + ' priced items for custom fields');

          var BATCH_SIZE = 5;
          var BATCH_PAUSE = 2000;
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
            if (enriched.length > 0) {
              cache.set(INGREDIENTS_CACHE_KEY, enriched, INGREDIENTS_CACHE_TTL);
            } else {
              log.warn('[api/ingredients] Enrichment returned 0 items — skipping cache to allow retry');
            }
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
        return res.json({ source: 'cache', items: cached });
      }

      log.info('[api/kiosk/products] Cache miss — fetching from Zoho Inventory');

      return fetchAllItems({ status: 'active' })
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
          res.json({ source: 'zoho', items: sellable });
        });
    })
    .catch(function (err) {
      log.error('[api/kiosk/products] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch kiosk products' });
    });
});

// Expose refreshProducts so server.js can call it for pre-warming
router.refreshProducts = refreshProducts;

module.exports = router;

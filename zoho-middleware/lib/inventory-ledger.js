/**
 * Inventory Ledger — real-time Redis stock layer.
 *
 * Maintains a shadow copy of stock_on_hand values in Redis so that
 * checkouts can decrement inventory immediately (before the next Zoho
 * reconcile cycle) and product listings can reflect the adjusted values.
 *
 * All functions are no-ops when INVENTORY_LEDGER_ENABLED !== 'true',
 * allowing the code to be deployed without activating the feature.
 */

var cache = require('./cache');
var log = require('./logger');
var C = require('./constants');

var STOCK_KEY_PREFIX = C.LEDGER_KEYS.STOCK_PREFIX;
var VERSION_KEY = C.LEDGER_KEYS.VERSION;
var ADJUSTMENTS_KEY = C.LEDGER_KEYS.ADJUSTMENTS;
var STOCK_TTL = 7200;        // 2 hours
var VERSION_TTL = 7200;      // 2 hours
var ADJUSTMENTS_TTL = 86400; // 24 hours
var MAX_LOG_ENTRIES = 1000;

/**
 * Reconcile Redis stock with a fresh list of items from Zoho.
 * Called after every successful Zoho product fetch to keep the ledger current.
 *
 * Uses a two-pipeline approach to avoid a race condition where a sale that
 * occurred during the Zoho fetch gets overwritten:
 *   1. GET all current ledger values
 *   2. For each item: SET only if key is absent, negative, or Zoho's value is lower.
 *      Otherwise EXPIRE to refresh TTL without overwriting a pending-sale decrement.
 *
 * @param {Array<{item_id: string, stock_on_hand: number}>} items
 * @returns {Promise}
 */
function reconcile(items) {
  if (process.env.INVENTORY_LEDGER_ENABLED !== 'true') return Promise.resolve();

  return cache.getClient().then(function (client) {
    if (!client) {
      log.warn('[inventory-ledger] Redis unavailable — skipping reconcile');
      return;
    }

    var toReconcile = items.filter(function (item) {
      return item && item.item_id && typeof item.stock_on_hand === 'number' && !isNaN(item.stock_on_hand);
    });

    if (toReconcile.length === 0) return;

    // Pipeline 1: read current ledger values for all items
    var getPipeline = client.multi();
    toReconcile.forEach(function (item) {
      getPipeline.get(STOCK_KEY_PREFIX + item.item_id);
    });

    return getPipeline.exec().then(function (currentValues) {
      // Pipeline 2: conditionally SET or EXPIRE each item
      var setPipeline = client.multi();
      var count = 0;

      toReconcile.forEach(function (item, i) {
        var current = currentValues[i];
        var zohoVal = item.stock_on_hand;

        if (current === null) {
          // Key absent — seed with Zoho value
          setPipeline.set(STOCK_KEY_PREFIX + item.item_id, String(zohoVal), { EX: STOCK_TTL });
          count++;
        } else {
          var curNum = parseInt(current, 10);
          if (isNaN(curNum) || curNum < 0 || zohoVal < curNum) {
            // Key is corrupted/negative OR Zoho has lower stock (processed other sales) — update
            setPipeline.set(STOCK_KEY_PREFIX + item.item_id, String(zohoVal), { EX: STOCK_TTL });
            count++;
          } else {
            // Zoho >= current: a sale happened during the Zoho fetch and hasn't synced yet.
            // Keep the lower (decremented) value; just refresh the TTL.
            setPipeline.expire(STOCK_KEY_PREFIX + item.item_id, STOCK_TTL);
          }
        }
      });

      setPipeline.incr(VERSION_KEY);
      setPipeline.expire(VERSION_KEY, VERSION_TTL);

      return setPipeline.exec().then(function () {
        log.info('[inventory-ledger] Reconciled ' + count + ' of ' + toReconcile.length + ' items (seeded/updated)');
      });
    });
  }).catch(function (err) {
    log.warn('[inventory-ledger] reconcile error: ' + err.message);
  });
}

/**
 * Decrement stock in Redis immediately after a successful checkout.
 * Fire-and-forget — failures are logged but do not affect the order flow.
 *
 * @param {Array<{item_id: string, quantity: number}>} lineItems
 * @param {string} reason  e.g. "checkout:SO-00001" or "kiosk:INV-00001"
 * @returns {Promise}
 */
function decrementStock(lineItems, reason) {
  if (process.env.INVENTORY_LEDGER_ENABLED !== 'true') return Promise.resolve();

  return cache.getClient().then(function (client) {
    if (!client) {
      log.warn('[inventory-ledger] Redis unavailable — skipping decrementStock');
      return;
    }

    var pipeline = client.multi();
    var now = new Date().toISOString();

    lineItems.forEach(function (line) {
      if (!line || !line.item_id || !line.quantity) return;

      pipeline.decrBy(STOCK_KEY_PREFIX + line.item_id, line.quantity);

      var entry = JSON.stringify({
        item_id: line.item_id,
        delta: -line.quantity,
        reason: reason,
        timestamp: now
      });
      pipeline.lPush(ADJUSTMENTS_KEY, entry);
    });

    // Trim the log and refresh its TTL
    pipeline.lTrim(ADJUSTMENTS_KEY, 0, MAX_LOG_ENTRIES - 1);
    pipeline.expire(ADJUSTMENTS_KEY, ADJUSTMENTS_TTL);

    return pipeline.exec().then(function () {
      log.info('[inventory-ledger] Decremented stock for ' + reason);
    });
  }).catch(function (err) {
    log.warn('[inventory-ledger] decrementStock error: ' + err.message);
  });
}

/**
 * Get the current ledger stock for a single item.
 *
 * @param {string} itemId
 * @returns {Promise<number|null>}  null if not in ledger or Redis unavailable
 */
function getStock(itemId) {
  if (process.env.INVENTORY_LEDGER_ENABLED !== 'true') return Promise.resolve(null);

  return cache.getClient().then(function (client) {
    if (!client) return null;

    return client.get(STOCK_KEY_PREFIX + itemId).then(function (result) {
      if (result === null) return null;
      return parseInt(result, 10);
    });
  }).catch(function (err) {
    log.warn('[inventory-ledger] getStock error: ' + err.message);
    return null;
  });
}

/**
 * Overlay ledger stock values onto an array of product items in-place.
 * Items whose ledger entry is missing keep their catalog stock_on_hand value.
 *
 * @param {Array<{item_id: string, stock_on_hand: number}>} items
 * @returns {Promise<Array>}  the same array, potentially with updated stock_on_hand values
 */
function overlayStock(items) {
  if (process.env.INVENTORY_LEDGER_ENABLED !== 'true') return Promise.resolve(items);
  if (!items || items.length === 0) return Promise.resolve(items);

  return cache.getClient().then(function (client) {
    if (!client) return items;

    var pipeline = client.multi();

    items.forEach(function (item) {
      pipeline.get(STOCK_KEY_PREFIX + item.item_id);
    });

    return pipeline.exec().then(function (results) {
      results.forEach(function (result, i) {
        if (result !== null) {
          items[i].stock_on_hand = Math.max(0, parseInt(result, 10));
        }
      });
      return items;
    });
  }).catch(function (err) {
    log.warn('[inventory-ledger] overlayStock error: ' + err.message);
    return items;
  });
}

module.exports = {
  reconcile: reconcile,
  decrementStock: decrementStock,
  getStock: getStock,
  overlayStock: overlayStock
};

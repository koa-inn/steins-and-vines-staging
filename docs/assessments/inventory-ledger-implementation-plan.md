# Real-Time Inventory Ledger — Implementation Plan

**Date:** 2026-03-09
**Feature:** Middleware-side Redis inventory ledger that tracks stock in real-time across all sale channels (website checkout + kiosk POS), eliminating sync delays between sales and catalog display.

---

## 1. Problem Statement

Currently, stock levels visible to customers are only as fresh as the last Zoho catalog cache refresh (cron at 5am/1pm UTC, plus stale-while-revalidate with 10-minute soft TTL). When a customer buys an item, the stock count displayed to other customers doesn't update until the next cache refresh cycle. Since both online and in-store sales flow through the same middleware, the middleware can track every sale in real-time.

## 2. Architecture Overview

```
                    ┌───────────────────────────────────┐
                    │        Redis                       │
                    │                                    │
                    │  zoho:products     (catalog cache)  │
                    │  zoho:kiosk-products (kiosk cache)  │
                    │  zoho:ingredients  (ingredients)    │
                    │                                    │
                    │  inv:stock:{item_id}  ◄── NEW      │
                    │  inv:stock:version    ◄── NEW      │
                    │  inv:adjustments:log  ◄── NEW      │
                    └───────────┬───────────────────────┘
                                │
              ┌─────────────────┼─────────────────────┐
              │                 │                       │
     ┌────────▼──────┐  ┌──────▼────────┐  ┌──────────▼──────┐
     │ POST checkout  │  │ POST kiosk/   │  │ Cron warm-up     │
     │ (online sales) │  │   sale        │  │ (reconciliation) │
     │                │  │ (in-store)    │  │                  │
     │ Decrement stock│  │ Decrement     │  │ Seed/reconcile   │
     │ after Zoho SO  │  │ stock after   │  │ from Zoho truth  │
     │ creation       │  │ Zoho invoice  │  │                  │
     └────────────────┘  └───────────────┘  └──────────────────┘
              │                 │                       │
              └─────────────────┼───────────────────────┘
                                │
                    ┌───────────▼───────────────────────┐
                    │  GET /api/products                 │
                    │  GET /api/ingredients              │
                    │  GET /api/kiosk/products           │
                    │                                    │
                    │  Overlay ledger stock onto cached  │
                    │  catalog items before responding   │
                    └───────────────────────────────────┘
```

## 3. Design Decisions

### 3.1 Per-Item Stock Keys vs. Single Hash

**Chosen: Per-item Redis keys** (`inv:stock:{item_id}`)

Each item's stock count is stored as an individual Redis key. This allows atomic `DECRBY` operations without read-modify-write races, and individual TTLs per item.

Alternative considered: A single Redis hash (`HSET inv:stock {item_id} {qty}`). Rejected because Redis `HINCRBY` on a hash field is atomic but the entire hash shares one TTL, making selective invalidation harder.

### 3.2 Decrement Timing

**Chosen: Decrement after successful Zoho order creation, before responding to client.**

The stock decrement happens after the Zoho sales order (checkout) or invoice (kiosk) is confirmed. This ensures we only decrement for orders that actually exist in Zoho. If the Zoho call fails, the void-on-failure handler runs but stock is NOT decremented (correctly — no sale occurred).

Alternative considered: Decrement optimistically before Zoho call, re-increment on failure. Rejected because the failure path (void + re-increment) adds complexity and risks phantom stock reductions if the re-increment fails.

### 3.3 Reconciliation Strategy

**Chosen: Full reconciliation on cron warm-up (existing 5am/1pm schedule).**

When the catalog refreshes from Zoho, the ledger is re-seeded with Zoho's authoritative `stock_on_hand` values. This corrects any drift from manual Zoho adjustments (receiving shipments, stock corrections, returns processed directly in Zoho).

The reconciliation uses a version counter (`inv:stock:version`) that increments on each full sync. Stale reads from a previous version are harmless — they'll be overwritten on the next catalog response.

### 3.4 Graceful Degradation

If Redis is down, the system behaves exactly as it does today — catalog endpoints return Zoho-cached data without stock overlays. No stock tracking occurs during Redis outages, and the next reconciliation re-seeds everything.

## 4. Data Model

### Redis Keys

| Key | Type | TTL | Description |
|-----|------|-----|-------------|
| `inv:stock:{item_id}` | String (integer) | 7200s (2 hours) | Current stock count for this item. TTL acts as a safety net — if reconciliation doesn't run, stale counts auto-expire and fall back to catalog values. |
| `inv:stock:version` | String (integer) | 7200s | Monotonically increasing version counter. Incremented on each full Zoho reconciliation. Used to detect stale ledger state. |
| `inv:adjustments:log` | Redis List | 86400s (24h) | Append-only log of stock adjustments for debugging. Each entry: `{item_id, delta, reason, timestamp}`. Capped at 1000 entries via `LTRIM`. |

### Stock Overlay Logic

When a catalog endpoint (products, ingredients, kiosk/products) returns items to the client, each item's `stock_on_hand` is overlaid with the ledger value if one exists:

```
for each item in catalog_response:
    ledger_stock = Redis GET inv:stock:{item.item_id}
    if ledger_stock is not null:
        item.stock_on_hand = max(0, parseInt(ledger_stock))
```

The `max(0, ...)` prevents negative stock display. Negative ledger values can occur if two concurrent sales decrement past zero — the item shows as "Out of Stock" rather than "-1".

## 5. Implementation Steps

### Step 1: Create `lib/inventory-ledger.js` (new file)

This is the core module. It exposes four functions:

```javascript
// lib/inventory-ledger.js

var cache = require('./cache');
var log = require('./logger');

var STOCK_KEY_PREFIX = 'inv:stock:';
var VERSION_KEY = 'inv:stock:version';
var ADJUSTMENTS_KEY = 'inv:adjustments:log';
var STOCK_TTL = 7200;       // 2 hours
var VERSION_TTL = 7200;
var ADJUSTMENTS_TTL = 86400; // 24 hours
var MAX_LOG_ENTRIES = 1000;

/**
 * Seed the ledger from a Zoho catalog fetch.
 * Called during cron warm-up after a successful fetchAllItems().
 * Overwrites all existing stock counts with Zoho's authoritative values.
 *
 * @param {Array} items - Array of Zoho inventory items with item_id and stock_on_hand
 * @returns {Promise}
 */
function reconcile(items) { ... }

/**
 * Decrement stock for items sold in a checkout or kiosk sale.
 * Uses Redis DECRBY for atomic decrement (no read-modify-write race).
 *
 * @param {Array} lineItems - Array of { item_id, quantity }
 * @param {string} reason - e.g. 'checkout:SO-00123' or 'kiosk:INV-00456'
 * @returns {Promise}
 */
function decrementStock(lineItems, reason) { ... }

/**
 * Get the current ledger stock for a single item.
 * Returns null if no ledger entry exists (caller should use catalog value).
 *
 * @param {string} itemId
 * @returns {Promise<number|null>}
 */
function getStock(itemId) { ... }

/**
 * Overlay ledger stock onto an array of catalog items.
 * Mutates items in-place, replacing stock_on_hand with ledger values
 * where available. Items without a ledger entry keep their catalog value.
 *
 * @param {Array} items - Catalog items with item_id and stock_on_hand
 * @returns {Promise<Array>} - Same array, mutated
 */
function overlayStock(items) { ... }
```

**Detailed function implementations:**

#### `reconcile(items)`
```
1. Get Redis client via cache.getClient()
2. If client is null (Redis down), return immediately
3. Build a Redis pipeline:
   a. For each item with a numeric stock_on_hand:
      - SET inv:stock:{item_id} {stock_on_hand} EX 7200
   b. INCR inv:stock:version
   c. EXPIRE inv:stock:version 7200
4. Execute pipeline
5. Log: "[inventory-ledger] Reconciled {N} items, version={V}"
```

#### `decrementStock(lineItems, reason)`
```
1. Get Redis client via cache.getClient()
2. If client is null, log WARN and return (graceful degradation)
3. Build a Redis pipeline:
   a. For each line item:
      - DECRBY inv:stock:{item_id} {quantity}
      - Log adjustment: LPUSH inv:adjustments:log {JSON entry}
   b. LTRIM inv:adjustments:log 0 999 (cap at 1000 entries)
4. Execute pipeline
5. Log: "[inventory-ledger] Decremented stock for {reason}: {item_id}×{qty}, ..."
```

#### `overlayStock(items)`
```
1. If items is empty, return items
2. Get Redis client via cache.getClient()
3. If client is null, return items unchanged (graceful degradation)
4. Build a pipeline of GET inv:stock:{item_id} for each item
5. Execute pipeline
6. For each result:
   a. If result is not null, set item.stock_on_hand = Math.max(0, parseInt(result))
7. Return items
```

**Why pipeline?** A catalog response can contain 50-200+ items. Individual `GET` calls would be 50-200 Redis round-trips. A pipeline batches them into a single round-trip (~1ms total).

### Step 2: Hook into catalog refresh (catalog.js)

Modify `doRefreshProducts()` and `doRefreshIngredients()`:

**In `doRefreshProducts()`, after line 228 (`log.info('[api/products] Cached ' + enriched.length + ' kit items')`):**

```javascript
// Reconcile inventory ledger with fresh Zoho stock counts
var ledger = require('../lib/inventory-ledger');
ledger.reconcile(enriched).catch(function (err) {
  log.error('[api/products] Inventory ledger reconcile failed: ' + err.message);
});
```

**In `doRefreshIngredients()`, after line 471 (`cache.set(INGREDIENTS_CACHE_KEY, enriched, INGREDIENTS_CACHE_TTL)`):**

```javascript
var ledger = require('../lib/inventory-ledger');
ledger.reconcile(enriched).catch(function (err) {
  log.error('[api/ingredients] Inventory ledger reconcile failed: ' + err.message);
});
```

**Also reconcile the kiosk catalog** — in the `GET /api/kiosk/products` handler, after `cache.set(KIOSK_PRODUCTS_CACHE_KEY, sellable, ...)`:

```javascript
var ledger = require('../lib/inventory-ledger');
ledger.reconcile(sellable).catch(function (err) {
  log.error('[api/kiosk/products] Inventory ledger reconcile failed: ' + err.message);
});
```

### Step 3: Hook into catalog reads (catalog.js)

Overlay ledger stock onto cached catalog responses before sending to client.

**In `GET /api/products` handler, before `res.json({ source: 'cache', items: cached })` (line 305):**

```javascript
var ledger = require('../lib/inventory-ledger');
return ledger.overlayStock(cached).then(function (overlaid) {
  res.json({ source: 'cache', items: overlaid });
});
```

Apply the same pattern to:
- `GET /api/products` — cache hit path (line 305)
- `GET /api/products` — file fallback path (line 333)
- `GET /api/products` — fresh Zoho path (line 345)
- `GET /api/ingredients` — cache hit path (line 505)
- `GET /api/ingredients` — file fallback path (line 530)
- `GET /api/ingredients` — fresh Zoho path (line 541)
- `GET /api/kiosk/products` — cache hit path (line 567)
- `GET /api/kiosk/products` — fresh Zoho path (line 598)
- `GET /api/snapshot` — all three shape functions need to pass through overlay

### Step 4: Hook into checkout (checkout.js)

**After successful Zoho sales order creation** (after line 512, `cache.del('zoho:products:ts')`):

```javascript
// Decrement inventory ledger for sold items
var ledger = require('../lib/inventory-ledger');
ledger.decrementStock(lineItems, 'checkout:' + (soNumber || 'unknown')).catch(function (err) {
  log.error('[checkout] Inventory ledger decrement failed (non-fatal): ' + err.message);
});
```

This is fire-and-forget — if the ledger decrement fails, the reconciliation cron will correct it.

### Step 5: Hook into kiosk/sale (pos.js)

**In `POST /api/kiosk/sale`, after successful invoice creation** (after line 268, `cache.del(KIOSK_PRODUCTS_CACHE_KEY)`):

```javascript
var ledger = require('../lib/inventory-ledger');
ledger.decrementStock(lineItems, 'kiosk:' + (invoiceNumber || 'unknown')).catch(function (err) {
  log.error('[pos/kiosk/sale] Inventory ledger decrement failed (non-fatal): ' + err.message);
});
```

**In `POST /api/pos/sale` (legacy POS):** This endpoint uses description-only line items (no `item_id`), so it **cannot** decrement specific inventory items. Leave as-is — the cron reconciliation will catch the stock change from Zoho.

### Step 6: Add admin visibility endpoint

Add to `pos.js` or a new `admin.js` route file:

```javascript
/**
 * GET /api/admin/inventory-ledger
 * Returns the current state of the inventory ledger for debugging.
 * Shows all tracked item IDs, their ledger stock, and recent adjustments.
 */
router.get('/api/admin/inventory-ledger', function (req, res) {
  // Require API key (same pattern as /api/orders/recent)
  var apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (apiKey !== process.env.MW_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var ledger = require('../lib/inventory-ledger');
  // Return version, adjustment log, and optionally specific item lookups
  Promise.all([
    cache.get('inv:stock:version'),
    cache.getClient().then(function (c) {
      if (!c) return [];
      return c.lRange('inv:adjustments:log', 0, 49); // last 50 adjustments
    })
  ]).then(function (results) {
    var adjustments = (results[1] || []).map(function (entry) {
      try { return JSON.parse(entry); } catch (e) { return entry; }
    });
    res.json({
      version: results[0] || 0,
      recent_adjustments: adjustments
    });
  }).catch(function (err) {
    res.status(500).json({ error: err.message });
  });
});
```

### Step 7: Write tests

**Test file: `zoho-middleware/__tests__/inventory-ledger.test.js`**

Test cases:
1. `reconcile()` sets stock keys for all items with `stock_on_hand`
2. `reconcile()` increments version counter
3. `reconcile()` is a no-op when Redis is down (graceful degradation)
4. `decrementStock()` reduces stock atomically
5. `decrementStock()` handles concurrent decrements correctly (no race)
6. `decrementStock()` logs adjustments to the adjustments list
7. `decrementStock()` is a no-op when Redis is down
8. `overlayStock()` replaces `stock_on_hand` with ledger values
9. `overlayStock()` preserves catalog `stock_on_hand` when no ledger entry exists
10. `overlayStock()` floors negative values to 0
11. `overlayStock()` returns items unchanged when Redis is down
12. `getStock()` returns null when no ledger entry exists
13. Full integration: reconcile → decrement → overlay returns correct values

## 6. Files Modified

| File | Change |
|------|--------|
| `zoho-middleware/lib/inventory-ledger.js` | **NEW** — Core ledger module |
| `zoho-middleware/routes/catalog.js` | Add reconcile calls in refresh functions; add overlay calls in GET handlers |
| `zoho-middleware/routes/checkout.js` | Add decrementStock call after successful SO creation |
| `zoho-middleware/routes/pos.js` | Add decrementStock call after successful kiosk invoice creation; add admin endpoint |
| `zoho-middleware/__tests__/inventory-ledger.test.js` | **NEW** — Unit tests |
| `docs/API.md` | Document `GET /api/admin/inventory-ledger` endpoint |
| `docs/ARCHITECTURE.md` | Add inventory ledger to architecture overview |

## 7. Rollout Plan

1. **Deploy with feature flag:** Add `INVENTORY_LEDGER_ENABLED=true` env var. All ledger operations check this flag and no-op when disabled. This allows deploying the code without activating it.
2. **Enable on staging:** Set the flag on staging, verify via `/api/admin/inventory-ledger` that reconciliation runs and stock overlays appear.
3. **Monitor for 24 hours:** Watch logs for `[inventory-ledger]` entries. Verify decrement events appear after checkouts.
4. **Enable on production:** Set the flag on production.
5. **Remove feature flag:** After 1 week of stable operation, remove the flag and make the ledger always-on.

## 8. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Redis pipeline adds latency to catalog responses | Low | Low | Pipelines are ~1ms for 200 items. Monitor P99 latency. |
| Stock goes negative due to concurrent sales | Medium | Low | `max(0, ...)` in overlay. Negative values are self-correcting on reconciliation. |
| Reconciliation doesn't run (cron failure) | Low | Medium | 2-hour TTL on stock keys means stale values auto-expire and fall back to catalog. |
| Stock drift from manual Zoho adjustments | Expected | Low | Next cron reconciliation corrects it. Worst case: 12 hours of drift (5am→5pm gap). Can increase cron frequency. |
| Redis memory increase | Low | Low | ~200 items × 50 bytes ≈ 10KB. Negligible. |

## 9. Future Enhancements

- **Increase cron frequency** to every 30 minutes for tighter reconciliation
- **Low-stock alerts:** When `overlayStock()` sees an item hit a threshold, trigger a notification
- **"Out of Stock" auto-hiding:** Frontend can hide items where `stock_on_hand === 0` instead of showing them as unavailable
- **Stock reservation:** Temporarily hold stock when an item is added to cart (with 15-minute expiry), preventing overselling during long checkout flows

---

*This plan is designed for Claude Code to execute step-by-step. Each step is self-contained with explicit file paths, line numbers, and code snippets.*

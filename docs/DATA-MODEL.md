# Steins & Vines — Data Model & Sync Flow

_Last updated: March 2026. Reflects code state as of v1.4.x._

---

## Section 1: Source of Truth Matrix

| Data | Source of Truth | Read By | Cache TTL | Notes |
|---|---|---|---|---|
| Kit products (wine/beer/cider/seltzer) | Zoho Inventory | Middleware → frontend products page | Redis 1 hr (soft 10 min) + browser localStorage 30 min | Enriched with detail API calls for custom fields |
| Ingredients / supplies | Zoho Inventory | Middleware → frontend products page | Redis 1 hr (soft 10 min) | Filtered: non-kit, non-service, price > 0 |
| Services (Makers Fee, milling) | Zoho Inventory | Middleware → frontend checkout | Redis 30 min | Small list; enriched sequentially |
| Kiosk catalog (POS) | Zoho Inventory | Middleware → kiosk page | Redis 30 min | Flat; no per-item detail calls |
| Stock on hand | Zoho Inventory (seeded) + Redis ledger (adjusted in real time) | Middleware, overlaid on every product response | Redis 2 hrs (ledger keys) | Ledger decrements immediately on sale; Zoho reconciles on next cache refresh |
| Batches | Google Sheets (Batches tab) | Admin panel, batch.html | None (direct Apps Script) | Primary + secondary fermentation lifecycle |
| Fermentation schedules / templates | Google Sheets (FermSchedules tab) | Admin panel | None | Step templates applied when creating a batch |
| Batch tasks | Google Sheets (BatchTasks tab) | Admin panel, batch.html | None | Per-batch task list generated from schedule |
| Plato readings | Google Sheets (PlatoReadings tab) | Admin panel, batch.html | None | Gravity/temp/pH over time; plotted as chart |
| Vessel history | Google Sheets (VesselHistory tab) | Admin panel, batch.html | None | Transfer log: which vessel a batch occupied when |
| Reservations / checkouts | Zoho Books (Sales Orders) | Admin panel (via middleware `/api/salesorders`), confirmation emails | None persistent (soft 30 min for recent-orders list) | Created by `/api/checkout`; mirrored to Sheets via `notifyAdminPanel()` |
| Bookings / timeslots | Zoho Bookings | Frontend reservation flow | Redis 5 min (per date/month) | Availability + slot endpoints cached per date |
| Booking services config | Zoho Bookings | Admin setup helper | Redis 24 hrs | Rarely changes |

---

## Section 2: Zoho Data Objects

### Zoho Item (product — from Inventory)

Fields used in the codebase, sourced from `GET /items` (list) and `GET /items/:id` (detail):

| Field | Type | Source | Notes |
|---|---|---|---|
| `item_id` | string | list | Primary key used throughout |
| `name` | string | list | Display name |
| `sku` | string | list | Used for image filename (`images/products/{sku}.png`) |
| `rate` | number | list | Selling price |
| `stock_on_hand` | number | list | Zoho's last-known stock; overlaid by Redis ledger |
| `category_name` | string | list | Zoho category (e.g. "Wine Kits") |
| `product_type` | string | list | `"goods"` or `"service"`; service items go to `/api/services` |
| `image_name` | string | detail | Internal Zoho image filename; used for change detection |
| `description` | string | list | Product description |
| `discount` | number | list | Discount percentage |
| `brand` | string | detail | Brand/vendor name |
| `custom_fields` | array | detail | See below — not returned by list endpoint |
| `tax_id` | string | detail | Zoho tax rule ID |
| `tax_name` | string | detail | Human-readable tax name |
| `tax_percentage` | number | detail | Numeric tax rate (e.g. `12`) |
| `vendor_id` | string | detail | Vendor ID |
| `vendor_name` | string | detail | Vendor name |
| `cf_type` | string | list | Flattened version of the "Type" custom field — available from the list endpoint without a detail call; used for kit/ingredient classification during startup pre-warm |

**Custom fields (from detail endpoint, accessed as `custom_fields` array):**

The codebase reads custom fields by their `label` value. Confirmed labels used:

| Label | Frontend field | Purpose |
|---|---|---|
| `Type` | `type` | Kit category: wine / beer / cider / seltzer / ingredient / etc. Determines which tab an item appears on |
| `Subcategory` | `subcategory` | Sub-type (e.g. "Pinot Noir", "Lager"). Drives label tint color |
| `Tasting Notes` | `tasting_notes` | Shown on label cards |
| `Favorite` | `favorite` | Featured flag or rating |
| `ABV` | `abv` | Alcohol by volume |
| `Time` | `time` | Fermentation time |
| `Millable` | `millable` | Whether grain can be milled |
| `Retail Kit` | `retail_kit` | Kit-only price string (e.g. `"$119.99"`) |
| `Retail Instore` | `retail_instore` | In-store fermentation price string |

> **Note:** When both `rate` (from Zoho) and `retail_kit`/`retail_instore` (from custom fields) are present, the custom field values take precedence in the snapshot shaper. If custom fields are absent, `rate` is used with a synthetic +$50 in-store uplift.

---

### Zoho Sales Order (reservation/checkout)

Created by `POST /api/checkout` → `POST /salesorders` to Zoho Books.

| Field | Value | Notes |
|---|---|---|
| `customer_id` | resolved from email | Server derives this via contact lookup — client-supplied ID is intentionally ignored |
| `date` | `YYYY-MM-DD` (today) | ISO date at order creation time |
| `line_items` | array of `{ item_id, name, quantity, rate, discount? }` | Prices revalidated server-side from Redis catalog |
| `notes` | string | Customer's order notes |
| `custom_fields` | array | Conditional — only set if env vars configured |

Custom field slots written to Sales Orders (all controlled by env vars):

| Env var | Purpose |
|---|---|
| `ZOHO_CF_STATUS` | Reservation status (`"Pending"` or `"Walk-in"`) |
| `ZOHO_CF_TIMESLOT` | Booked timeslot string |
| `ZOHO_CF_APPOINTMENT_ID` | Zoho Bookings appointment ID |
| `ZOHO_CF_DEPOSIT` | Deposit amount charged (string, 2dp) |
| `ZOHO_CF_BALANCE` | Balance due (string, 2dp) |
| `ZOHO_CF_TRANSACTION_ID` | Global Payments transaction ID |

---

### Zoho Invoice (kiosk/POS sale)

Created by `POST /api/kiosk/sale` → `POST /invoices` to Zoho Books (not Sales Orders). Key difference: invoices are for walk-in sales; Sales Orders are for kit reservations. The kiosk uses `KIOSK_CONTACT_ID` as a static "walk-in" contact.

---

## Section 3: Google Sheets Schema

Batch tracking lives in a Google Sheets workbook accessed via an Apps Script Web App (`APPS_SCRIPT_URL`). The schema is inferred from `js/admin.js` and `js/batch.js`.

### Batches tab

| Column | Type | Notes |
|---|---|---|
| `batch_id` | string | Format: `SV-B-NNNNNN` |
| `product_name` | string | Kit name (may also have `product_sku`) |
| `customer_name` | string | Customer name |
| `start_date` | date | Fermentation start date (YYYY-MM-DD) |
| `status` | string | `primary` / `secondary` / `complete` / `disabled` |
| `vessel_id` | string | Current vessel identifier |
| `shelf_id` | string | Physical shelf location |
| `bin_id` | string | Physical bin/slot within shelf |
| `notes` | string | Free-text notes |
| `public_token` | string | 32-char hex token for QR URL auth |
| `schedule_id` | string | FK to FermSchedules |

### FermSchedules tab

Templates that define the sequence of tasks for a fermentation batch.

| Column | Type | Notes |
|---|---|---|
| `schedule_id` | string | Format: `FS-NNNN` |
| `name` | string | Template display name |
| `category` | string | Kit category (wine/beer/cider/seltzer) |
| `steps` | — | Stored as child rows in this tab or as an embedded structure; each step has: |
| — `step_number` | integer | Sequence number |
| — `day_offset` | integer | Days after start date when task is due (`-1` = packaging, date TBD) |
| — `title` | string | Task title |
| — `description` | string | Optional instructions |
| — `is_packaging` | boolean | Whether this is a packaging/bottling step |
| — `is_transfer` | boolean | Whether this step involves a vessel transfer |

### BatchTasks tab

Per-batch task instances (generated from a FermSchedule when a batch is created).

| Column | Type | Notes |
|---|---|---|
| `task_id` | string | Format: `BT-NNNNNN` |
| `batch_id` | string | FK to Batches |
| `step_number` | integer | Step sequence |
| `title` | string | Task title |
| `description` | string | Instructions |
| `due_date` | date | Calculated from `start_date + day_offset` |
| `completed` | boolean | `TRUE`/`FALSE` (stored as string in Sheets) |
| `completed_at` | date | When the task was completed |
| `is_packaging` | boolean | Packaging flag |
| `is_transfer` | boolean | Transfer flag |

### PlatoReadings tab

Gravity/density measurements over the course of fermentation.

| Column | Type | Notes |
|---|---|---|
| `reading_id` | string | Unique ID |
| `batch_id` | string | FK to Batches |
| `timestamp` | date | Date of reading (YYYY-MM-DD) |
| `degrees_plato` | number | Plato gravity value |
| `temperature` | number | Temperature in °C (optional) |
| `ph` | number | pH value (optional) |
| `notes` | string | Free-text (optional) |

### VesselHistory tab

Audit trail of vessel assignments for a batch.

| Column | Type | Notes |
|---|---|---|
| `batch_id` | string | FK to Batches |
| `vessel_id` | string | Vessel identifier at this point in time |
| `shelf_id` | string | Shelf at time of record |
| `bin_id` | string | Bin at time of record |
| `transfer_date` | date | When the move occurred (inferred from `completed_at` of transfer task) |
| `notes` | string | Optional notes |

> **Schema uncertainty:** The exact column names in the Sheets tabs are inferred from the JS field access patterns (`b.batch_id`, `t.task_id`, etc.) and the Apps Script actions called from the admin. The Apps Script source (`adminApi.gs`) was not read directly. Column names may differ from field names if the Apps Script remaps them.

---

## Section 4: Redis Key Reference

| Key Pattern | Purpose | TTL | Set By | Read By |
|---|---|---|---|---|
| `zoho:products` | Full enriched kit product list (JSON array) | 3600 s (1 hr hard) | `GET /api/products` → `doRefreshProducts()` | `GET /api/products`, `GET /api/snapshot`, `POST /api/checkout` (catalog validation) |
| `zoho:products:ts` | Timestamp of last product enrichment | 3600 s | `doRefreshProducts()` | `GET /api/products` (stale-while-revalidate, soft TTL 600 s) |
| `zoho:product-image-hashes` | Map of `item_id → image_name` for change detection | 86400 s (24 hr) | `doRefreshProducts()` | `doRefreshProducts()` (diff on next refresh) |
| `zoho:ingredients` | Enriched ingredient/supply list | 3600 s (1 hr) | `doRefreshIngredients()` | `GET /api/ingredients`, `GET /api/snapshot` |
| `zoho:ingredients:ts` | Timestamp of last ingredient enrichment | 3600 s | `doRefreshIngredients()` | `GET /api/ingredients` (soft TTL 600 s) |
| `zoho:services` | Service items (Makers Fee, milling, etc.) | 1800 s (30 min) | `GET /api/services` | `GET /api/services`, `GET /api/snapshot`, checkout catalog validation |
| `zoho:kiosk-products` | Flat sellable item list for POS kiosk | 1800 s (30 min) | `GET /api/kiosk/products` | `GET /api/kiosk/products`, `POST /api/kiosk/sale` (catalog lookup) |
| `zoho:availability:YYYY-MM` | Available booking dates for a month | 300 s (5 min) | `GET /api/bookings/availability` | `GET /api/bookings/availability` |
| `zoho:slots:YYYY-MM-DD` | Available time slots for a date | 300 s (5 min) | `GET /api/bookings/slots` | `GET /api/bookings/slots` |
| `zoho:booking-services` | Zoho Bookings service + staff list | 86400 s (24 hr) | `GET /api/bookings/services` | `GET /api/bookings/services` |
| `zoho:recent-orders:<limit>` | Recent kiosk sales orders list | 60 s | `GET /api/admin/recent-orders` | `GET /api/admin/recent-orders` |
| `zoho:oauth-state:<state>` | CSRF token for Zoho OAuth flow | 600 s (10 min) | `GET /auth/zoho` | `GET /auth/zoho/callback` |
| `inv:stock:<item_id>` | Real-time stock count per item | 7200 s (2 hr) | `ledger.reconcile()`, `ledger.decrementStock()` | `ledger.overlayStock()` (applied to all product responses) |
| `inv:stock:version` | Monotonic counter; increments on each reconcile | 7200 s | `ledger.reconcile()` | Admin ledger debug endpoint |
| `inv:adjustments:log` | LIFO list of stock adjustment events (max 1000) | 86400 s (24 hr) | `ledger.decrementStock()` | Admin ledger debug endpoint |
| `lock:products:refresh` | Distributed refresh lock (prevents concurrent Zoho fetches) | 120 s (auto-expires on crash) | `cache.acquireLock()` in `refreshProducts()` | Same; only one instance fetches at a time |
| `checkout:idem:<key>` | Idempotency cache for `/api/checkout` (stores response body) | 600 s (10 min) | `POST /api/checkout` on success | `POST /api/checkout` on retry |
| `kiosk:idem:<key>` | Idempotency cache for `/api/kiosk/sale` | 300 s (5 min) | `POST /api/kiosk/sale` on success | `POST /api/kiosk/sale` on retry |
| `gp:txn:<transaction_id>` | Single-use GP transaction ID (replay-attack prevention) | Set by checkout; TTL not confirmed in read code — key is set after use | `POST /api/checkout` | `POST /api/checkout` (checked before processing) |
| `sv:void-failure:<timestamp>` | Record of failed GP void (for alerting/audit) | 30 days | `POST /api/kiosk/sale` on void failure | Manual inspection / admin |

---

## Section 5: Product Sync Flow

### Normal path (middleware warm, Redis hit)

```
Browser (products.html)
  → fetch(MIDDLEWARE_URL + /api/products)
    → middleware checks Redis: zoho:products
      → Cache HIT → ledger.overlayStock() applies inv:stock:* values
        → returns { source: "cache", items: [...] }
    → Browser maps response fields → renders product cards

    Background (if zoho:products:ts age > 600 s):
      → refreshProducts() acquires lock:products:refresh
        → fetchAllItems({ status: "active" }) from Zoho Inventory
          → per-item detail calls in batches of 5 (~85 req/min)
          → filters by KIT_CATEGORIES custom field "Type"
          → writes zoho:products + zoho:products:ts + products-cache.json
          → ledger.reconcile() seeds/updates inv:stock:* keys
          → image change detection diff → log if images changed
```

### Cold cache path (Redis miss, file fallback exists)

```
Redis: zoho:products → miss
  → reads products-cache.json from middleware filesystem
    → seeds Redis with file contents (TTL 1 hr)
    → ledger.overlayStock() → responds immediately
    → triggers refreshProducts() in background to freshen data
```

### Snapshot fallback path (file cache also cold)

```
Redis miss + no products-cache.json
  → reads content/zoho-snapshot.json (static file committed to repo)
    → parses snapRaw.products array
    → seeds Redis (TTL 1 hr)
    → responds with { source: "snapshot" }
    → triggers refreshProducts() in background

Frontend fallback (middleware completely unreachable):
  Browser fetch(MIDDLEWARE_URL/api/products) → network error or 502
    → fetch('/content/zoho-snapshot.json')  [same committed file, served via GitHub Pages]
      → parses snap.products → renders cards without real-time stock
```

### Browser-level cache layer

The frontend also maintains a `localStorage` cache:
- Key `sv-products-mw` / `sv-products-mw-ts` — raw middleware response
- TTL: 30 minutes (in-browser)
- If fresh: skips the middleware fetch entirely and renders from localStorage
- If stale or absent: fetches from middleware, updates localStorage on success

### Snapshot generation (pre-deploy step)

```
Developer (local):
  node server.js   # middleware running, Zoho authenticated
  node zoho-middleware/scripts/export-snapshot.js
    → GET http://localhost:3001/api/snapshot
      → reads from Redis (warm) or triggers fresh Zoho fetch
      → shapes each item for frontend consumption (flattenCF, shapeProduct, etc.)
    → writes content/zoho-snapshot.json
  git add content/zoho-snapshot.json && git commit
  git push origin main  # deploys snapshot to staging
```

---

## Section 6: Cache Bust Procedure

### Bust the product cache (force immediate Zoho re-fetch)

Call the products endpoint — it will serve from Redis cache if warm, but you can force a background refresh by deleting the timestamp key:

```
# Option A: direct Redis CLI (Railway)
railway run redis-cli DEL zoho:products:ts

# Option B: bust via the taxes route (also deletes zoho:products)
# taxes.js deletes zoho:products when saving tax rules — side effect documented in code

# Option C: POST /api/admin/upload-catalog  (X-API-Key required)
# Upload a fresh CSV from the admin Export/Sync tab — overrides Redis for 24 hrs
```

After busting `zoho:products:ts`, the next request to `GET /api/products` will trigger a background enrichment from Zoho. The response will still use the stale Redis data for that first request.

To force an immediate synchronous refresh (not just background), delete `zoho:products` itself. The next request will block on a full Zoho fetch.

### Bust the ingredients cache

```
railway run redis-cli DEL zoho:ingredients zoho:ingredients:ts
```

`doRefreshProducts()` also automatically deletes `zoho:ingredients` after each product refresh so the kit exclusion list (`_kitItemIds`) is rebuilt correctly.

### Bust the kiosk catalog

```
railway run redis-cli DEL zoho:kiosk-products
```

This is also done automatically after every successful `POST /api/kiosk/sale`.

### Bust booking availability

```
railway run redis-cli DEL "zoho:availability:YYYY-MM" "zoho:slots:YYYY-MM-DD"
```

These are also deleted automatically when a booking is created via `POST /api/bookings`.

### Bust the inventory ledger

```
# Full reset — next product fetch re-seeds from Zoho stock_on_hand values
railway run redis-cli DEL inv:stock:version
railway run redis-cli KEYS "inv:stock:*" | xargs redis-cli DEL
```

---

## Section 7: Stale Data Risks

### High risk: Kit products

**Risk:** Product cache can be up to 1 hour stale (hard TTL). In the soft-TTL window (10–60 min), stale prices are shown but checkout revalidates from Redis — so if the Redis product cache itself is stale, a customer could be charged the wrong price (old rate).

**Mitigation:** The checkout route reads prices from `zoho:products` at order time, not from the client. If Redis is unavailable, checkout fails closed (rejects order) rather than trusting client-supplied prices. The biggest gap is if a price changed in Zoho within the 1-hour Redis TTL window.

### High risk: Stock on hand

**Risk:** The inventory ledger (`inv:stock:*`) decrements immediately on sale and reconciles with Zoho on each product refresh. However:
- If the middleware restarts and Redis is not connected at startup, the ledger is disabled (no-op) and stock is served directly from stale Zoho values.
- If Zoho processes a sale through another channel (e.g., in-person POS system not connected to this codebase), the ledger won't know until the next Zoho reconcile cycle.
- Ledger keys expire after 2 hours if not refreshed; a product refresh must occur within that window to prevent keys expiring silently.

### Medium risk: Ingredients / services

**Risk:** 30–60 minute staleness. If a service price (e.g., Makers Fee) changes in Zoho, existing cached orders will still reflect the old price in the checkout validation for up to 30 minutes.

**Mitigation:** Manually bust `zoho:services` if a critical price change is made.

### Medium risk: Kiosk catalog

**Risk:** 30 minutes stale. A new product added to Zoho won't appear in the kiosk until cache expires or a sale clears the key. An item deleted in Zoho could still appear for up to 30 minutes.

### Low risk: Booking availability

**Risk:** 5 minutes stale. A timeslot booked by someone else might briefly still appear as available. Zoho Bookings enforces the final conflict check on booking creation.

### Low risk: Snapshot staleness

**Risk:** `content/zoho-snapshot.json` is only updated manually via `npm run snapshot` before deploys. If a deploy does not include a fresh snapshot and middleware is unreachable, users see snapshot data that may be significantly outdated (days or weeks).

**Mitigation:** Always run `npm run snapshot` before deploying. The snapshot is the last line of defense — it is intentionally out-of-date-safe since middleware being up is the normal case.

### Low risk: Browser localStorage cache

**Risk:** 30-minute in-browser cache. A customer who loaded products earlier in the day may see stale stock counts or prices even if Redis was busted. Refreshing the page or waiting for TTL expiry clears this.

### No risk: Batch / Sheets data

Google Sheets batch data is fetched live from the Apps Script Web App on every admin panel load. There is no caching layer between the middleware and Sheets for batch data — it is always fresh (subject to Apps Script execution latency, typically under 5 seconds).

---

## Appendix: Required Environment Variables

See `zoho-middleware/lib/validateEnv.js` for the authoritative list. Key Zoho-related vars:

| Variable | Purpose |
|---|---|
| `ZOHO_CLIENT_ID` | OAuth app client ID |
| `ZOHO_CLIENT_SECRET` | OAuth app secret |
| `ZOHO_ORG_ID` | Zoho Books/Inventory organization ID |
| `ZOHO_REFRESH_TOKEN` | Long-lived refresh token (set via `/auth/zoho`) |
| `ZOHO_CF_STATUS` | Custom field API name for reservation status |
| `ZOHO_CF_TIMESLOT` | Custom field API name for timeslot |
| `ZOHO_CF_DEPOSIT` | Custom field API name for deposit amount |
| `ZOHO_CF_BALANCE` | Custom field API name for balance due |
| `ZOHO_CF_APPOINTMENT_ID` | Custom field API name for Zoho Bookings appointment ID |
| `ZOHO_CF_TRANSACTION_ID` | Custom field API name for GP transaction ID |
| `MAKERS_FEE_ITEM_ID` | Zoho item_id of the Maker's Fee service item |
| `APPS_SCRIPT_URL` | Google Apps Script Web App URL (batch/Sheets integration) |
| `APPS_SCRIPT_SERVER_TOKEN` | Server-to-server auth token for Apps Script |
| `INVENTORY_LEDGER_ENABLED` | Set to `"true"` to activate real-time stock ledger |
| `KIOSK_CONTACT_ID` | Zoho contact ID for walk-in kiosk sales |

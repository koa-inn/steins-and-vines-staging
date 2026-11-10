# API Reference — Steins & Vines Middleware

Base URL: `https://api.steinsandvines.ca` (production) / `http://localhost:3001` (local)

## Authentication

Endpoints fall into three authentication tiers:

- **Public** — No auth required (health, auth flow, payment config, contact form, product requests, checkout)
- **API Key** — Requires `X-Api-Key` header matching `API_SECRET_KEY` env var. Used by admin panel and kiosk for all mutating operations (POST, PUT, DELETE) on `/api/*`
- **Zoho** — Requires the middleware to have an active Zoho OAuth session. Most `/api/*` reads fail with 401 if Zoho is not connected. Some POST endpoints (contacts, bookings, checkout) support an offline fallback mode

Additional protections on specific endpoints: CORS origin whitelist, Referer checking, reCAPTCHA v3 (checkout), and per-endpoint Redis-backed rate limiting.

---

## Health & Auth

### `GET /health`
Health check used by Railway.

**Auth:** Public
**Response:**
```json
{ "status": "ok", "authenticated": true, "redis": true, "uptime": 12345.67 }
```

### `GET /auth/zoho`
Redirects to Zoho's OAuth2 consent screen. Visit this URL in a browser to connect the middleware to Zoho.

**Auth:** Public

### `GET /auth/zoho/callback`
OAuth callback — Zoho redirects here with `?code=...&state=...` after granting access. Exchanges the code for access + refresh tokens.

**Auth:** Public

### `GET /auth/status`
Check whether the middleware is currently authenticated with Zoho.

**Auth:** Public
**Response:**
```json
{ "authenticated": true }
```

---

## Payment Configuration

### `GET /api/payment/config`
Generates a restricted GP access token for client-side card tokenization. Token expires in 10 minutes. Card data never touches the server.

**Auth:** Public (CORS-restricted)
**Response:**
```json
{
  "enabled": true,
  "accessToken": "gp_access_token...",
  "env": "sandbox",
  "depositAmount": 50.00
}
```
Returns `{ "enabled": false, "depositAmount": 50.00 }` if GP is not configured.

---

## Catalog (Read-Only)

All catalog endpoints serve cached data. Redis caches are pre-warmed on startup and refreshed on a cron schedule (5 AM and 1 PM UTC daily).

### `GET /api/products`
Returns the full product catalog (fermentation kits, wines, etc.) with pricing, stock, images, and category metadata.

**Auth:** Zoho session required
**Cache:** Redis, refreshed on schedule
**Response:** Array of product objects

### `GET /api/services`
Returns bookable fermentation services.

**Auth:** Zoho session required
**Response:** Array of service objects

### `GET /api/ingredients`
Returns brewing ingredients and supplies catalog.

**Auth:** Zoho session required
**Cache:** Redis, refreshed on schedule
**Response:** Array of ingredient objects

### `GET /api/kiosk/products`
Returns products formatted for the kiosk POS display (simplified structure, prices, stock).

**Auth:** Zoho session required
**Response:** Array of kiosk product objects

### `GET /api/snapshot`
Returns a complete catalog snapshot (all products + ingredients) for offline/backup use.

**Auth:** Zoho session required

### `POST /api/admin/upload-catalog`
Upload a catalog snapshot to replace the current cached catalog.

**Auth:** API Key
**Body:** Catalog snapshot JSON

### `POST /api/admin/cache-clear`
Delete all catalog cache keys (Redis + file cache) and trigger an immediate re-fetch from Zoho. Useful after bulk product edits.

**Auth:** API Key
**Response:**
```json
{ "ok": true, "cleared": ["products", "products_ts", "ingredients", "ingredients_ts", "services"] }
```

---

## Bookings

### `GET /api/bookings/services`
List available booking services from Zoho Bookings.

**Auth:** Zoho session required
**Response:** Array of service objects (cached)

### `GET /api/bookings/availability`
Check date-level availability for a service.

**Auth:** Zoho session required
**Query:** `?service_id=...&staff_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD`
**Response:** Availability data per date

### `GET /api/bookings/slots`
Get available time slots for a specific date.

**Auth:** Zoho session required
**Query:** `?service_id=...&staff_id=...&date=YYYY-MM-DD`
**Response:** Array of available time slots

### `POST /api/bookings`
Create a new booking appointment.

**Auth:** API Key + Zoho (supports offline fallback)
**Body:**
```json
{
  "service_id": "zoho_service_id",
  "staff_id": "zoho_staff_id",
  "customer": { "name": "...", "email": "...", "phone": "..." },
  "from_time": "2026-03-15T10:00:00",
  "to_time": "2026-03-15T11:00:00"
}
```

### `POST /api/contacts`
Create or find a Zoho contact for a customer.

**Auth:** API Key + Zoho (supports offline fallback)
**Body:**
```json
{ "name": "...", "email": "...", "phone": "..." }
```

---

## Checkout

### `POST /api/checkout`
Process a complete customer checkout. This is the critical path — handles reCAPTCHA verification, server-side price anchoring, GP card charge, Zoho Sales Order creation, and void-on-failure.

**Auth:** Public (protected by reCAPTCHA v3 + rate limiting)
**Rate limit:** 10 req/min
**Body:**
```json
{
  "recaptcha_token": "...",
  "idempotency_key": "uuid-v4",
  "customer": { "name": "...", "email": "...", "phone": "..." },
  "items": [
    { "item_id": "zoho_id", "name": "...", "quantity": 1, "rate": 29.99 }
  ],
  "payment_token": "gp_tokenized_card...",
  "appointment_id": "optional_booking_id",
  "timeslot": "optional_timeslot_string"
}
```
**Note:** Client-supplied `rate` values are verified against Zoho live prices. Discrepancies cause rejection.

**Response:**
```json
{ "ok": true, "salesorder_id": "...", "salesorder_number": "SO-00123" }
```

---

## Payments

### `POST /api/payment/initialize`
Initialize a HelcimPay.js checkout session. Returns a `checkoutToken` the frontend passes to the Helcim payment iframe. The payment is processed inside the iframe; the result is returned to the page via `postMessage`.

**Auth:** Public (CORS-restricted)
**Body:**
```json
{ "amount": 50.00, "currency": "CAD" }
```
**Response:**
```json
{ "checkoutToken": "helcim_token...", "depositAmount": 50.00 }
```
Returns `503` if Helcim is not configured.

### `POST /api/payment/void`
Void a previous payment transaction.

**Auth:** API Key
**Body:**
```json
{ "transaction_id": "gp_txn_id" }
```

### `POST /api/payment/refund`
Refund a previous payment transaction.

**Auth:** API Key
**Body:**
```json
{ "transaction_id": "gp_txn_id", "amount": 50.00 }
```

---

## POS / Kiosk

### `POST /api/kiosk/sale`
Process an in-store kiosk sale via GP terminal. Validates items against cached prices, sends payment to the terminal, creates a Zoho Invoice, and returns receipt data. Voids the GP transaction if invoice creation fails.

**Auth:** API Key
**Rate limit:** 10 req/min
**Body:**
```json
{
  "items": [
    { "item_id": "zoho_id", "name": "Product", "quantity": 2, "rate": 14.99 }
  ],
  "reference_number": "KIOSK-001"
}
```
**Note:** Client `rate` and `tax_total` are ignored. Prices anchored server-side.

**Recipes in the cart (Phase 101):** the body may also carry an optional `recipes[]` array (max 25 entries; each entry has `recipe_id`, `sale_type`, `mill_grain`, optional `target_volume_l` and `modified_ingredients`). Rules:
- Requires `BEER_SALES_ENABLED=true`, otherwise `403 {error: 'Recipe sales are not enabled'}`.
- `client_grand_total` is required when `recipes[]` is present.
- A cart may be recipes-only (`items` may be empty). Card tender only for any cart containing a recipe.
- Stock shortfall returns `409` with `conflicts` (products) and `recipes_short` (recipe ingredients); resend with `override: true` to proceed (negative stock is an intentional oversell override).
- Charge limits: minimum $0 exclusive (a $0 cart is rejected) and maximum $10,000.

**`/api/kiosk/sale/confirm`:** re-prices `recipes[]` server-side, books ONE Zoho invoice with the product lines plus the recipe lines and a single summed "Recipe package price" adjustment, then creates batches. If invoice creation fails after the charge, the card transaction is voided.

### `POST /api/kiosk/cart-quote`
Read-only server price for the whole kiosk cart (products + recipes), used by the kiosk to display the authoritative total before checkout. No terminal call, no lock, no Zoho calls (served from the cached catalog).

**Auth:** Kiosk tier
**Body:** same shape as `/api/kiosk/sale` (`items[]`, optional `recipes[]`, optional `discount`).
**Response 200:**
```json
{
  "subtotal": 0, "discount_total": 0, "tax_total": 0, "total": 0,
  "discount": null,
  "recipes": [{ "index": 0, "label": "", "total_before_discount": 0, "discount": 0, "pre_tax": 0, "sale_type": "in-store", "mill_grain": false, "target_volume_l": 20 }],
  "stock": { "ok": true, "conflicts": [], "recipes_short": [] }
}
```
**Errors:** `400` empty/invalid cart, `403` recipes while `BEER_SALES_ENABLED` is off, `503` catalog unavailable, `502` pricing failed.

### `POST /api/kiosk/recipe-sale` (retired)
Returns `410 {error: 'This kiosk is out of date. Refresh the page and try again.'}` since Phase 101. No lock, pricing or terminal call happens. Recipe sales now go through `/api/kiosk/sale`.

### `POST /api/kiosk/recipe-sale/confirm` (legacy, scheduled for deletion)
Kept only so a charge started by a stale cached kiosk before the cutover can still be booked. Every call logs the event `kiosk.recipe_sale_legacy_confirm`. See `.planning/todos/pending/delete-legacy-recipe-sale-confirm.md`.

### `GET /api/kiosk/recipe-quote`
Dry-run recipe quote (unchanged), gated by `BEER_SALES_ENABLED`.

### `POST /api/pos/sale`
Process a POS sale (similar to kiosk but for the admin POS interface).

**Auth:** API Key
**Rate limit:** 10 req/min

### `GET /api/pos/status`
Check POS terminal connectivity and status.

**Auth:** API Key

### `GET /api/orders/recent`
Fetch recent orders from Zoho for the admin dashboard.

**Auth:** `MW_API_KEY` header

### `GET /api/admin/inventory-ledger`
Returns the current in-memory inventory ledger state for debugging — recent stock adjustments and the version counter. Only active when `INVENTORY_LEDGER_ENABLED=true`.

**Auth:** `MW_API_KEY` header

### `GET /api/kiosk/salesorders`
Fetch open Sales Orders from Zoho for display in the kiosk (pay-on-account flow). Results are cached. Supports optional filtering.

**Auth:** API Key
**Query:** `?status=open&search=customer+name`
**Response:** `{ salesorders: [...] }`

### `POST /api/kiosk/salesorder-create`
Create a new Sales Order in Zoho from the kiosk (deferred-payment / pay-on-account). Invalidates the salesorders cache on success.

**Auth:** API Key
**Body:**
```json
{
  "customer_id": "zoho_customer_id",
  "items": [{ "item_id": "id", "name": "Name", "quantity": 2, "rate": 14.99 }],
  "notes": "optional notes"
}
```
**Response:** `{ ok, salesorder_id, salesorder_number, total, balance }`

### `POST /api/kiosk/salesorder-pay`
Collect payment on an existing Sales Order via the Helcim terminal. Pushes to the terminal, polls for the result, then records the payment in Zoho.

**Auth:** API Key
**Body:**
```json
{ "salesorder_id": "zoho_salesorder_id" }
```
**Response:** `{ ok, transaction_id, salesorder_number, amount, card_type }`

---

## Collect (Deluge-triggered terminal payment)

### `POST /api/pos/collect`
Collect payment on an existing Zoho Sales Order via the Helcim Smart Terminal. Intended to be called by a Zoho Inventory Deluge script (server-to-server). Returns `202 Accepted` immediately after the terminal push; the Helcim webhook handler (`POST /api/webhooks/terminal`) processes the result asynchronously.

**Auth:** API Key
**Rate limit:** 10 req/min
**Body:**
```json
{ "salesorder_id": "zoho_salesorder_id" }
```
**Response (202):**
```json
{
  "message": "Payment sent to terminal",
  "salesorder_number": "SO-00123",
  "amount": 149.95,
  "status": "pending"
}
```
Returns `409` if a payment is already in progress for the same order (idempotency check).
Returns `503` if the Helcim terminal is not configured.

---

## Items (Zoho CRUD)

### `GET /api/items`
List items from Zoho Books with optional search/filter.

**Auth:** Zoho session required
**Query:** Supports Zoho query parameters

### `POST /api/items`
Create a new item in Zoho Books.

**Auth:** API Key + Zoho

### `GET /api/inventory/items/:id`
Get a single item from Zoho Inventory by ID.

**Auth:** Zoho session required

### `PUT /api/inventory/items/:id`
Update an item in Zoho Inventory.

**Auth:** API Key + Zoho

### `GET /api/items/:item_id/image`
Proxy an item image from Zoho (avoids CORS issues on the frontend).

**Auth:** Zoho session required

### `GET /api/contacts`
List contacts from Zoho Books.

**Auth:** Zoho session required

### `GET /api/invoices`
List invoices from Zoho Books.

**Auth:** Zoho session required

---

## Purchase Orders

### `GET /api/purchase-orders`
List purchase orders from Zoho.

**Auth:** Zoho session required

### `GET /api/purchase-orders/:id`
Get a single purchase order.

**Auth:** Zoho session required

### `POST /api/purchase-orders`
Create a new purchase order.

**Auth:** API Key + Zoho

### `PUT /api/purchase-orders/:id`
Update an existing purchase order.

**Auth:** API Key + Zoho

### `POST /api/purchase-orders/:id/add-item`
Add a line item to an existing purchase order.

**Auth:** API Key + Zoho

---

## Taxes

### `GET /api/taxes`
List tax rates configured in Zoho.

**Auth:** Zoho session required

### `GET /api/taxes/rules`
Get the current tax classification rules.

**Auth:** Zoho session required

### `POST /api/taxes/rules`
Update tax classification rules.

**Auth:** API Key + Zoho

### `POST /api/taxes/setup`
Run initial tax setup — configures Zoho tax rules for all product categories.

**Auth:** API Key + Zoho

### `POST /api/taxes/apply`
Apply tax classifications to all items based on the rules.

**Auth:** API Key + Zoho

### `POST /api/taxes/test-update`
Test a tax update on a single item without committing.

**Auth:** API Key + Zoho

### `GET /api/items/inspect`
Inspect item tax state and custom fields.

**Auth:** Zoho session required

### `POST /api/items/test-cf`
Test custom field updates on an item.

**Auth:** API Key + Zoho

### `POST /api/items/migrate`
Migrate item custom fields in bulk.

**Auth:** API Key + Zoho

---

## Consignment

### `GET /api/admin/consignment-report`
Returns consignment sales aggregated by artisan for a given month. Reads from invoices in Zoho that have a consignment details custom field (`ZOHO_CF_CONSIGNMENT_DETAILS`) populated with a JSON array of artisan payout data.

**Auth:** `MW_API_KEY` header
**Query:** `?month=YYYY-MM` (defaults to current month)
**Cache:** Redis, 5 minutes
**Response:**
```json
{
  "month": "2026-04",
  "artisans": [
    {
      "artisan_name": "...",
      "commission_rate": 0.3,
      "total_sales": 150.00,
      "total_payout": 105.00,
      "store_commission": 45.00,
      "items_sold": 6,
      "sales": [{ "invoice_number": "INV-001", "date": "...", "item_name": "...", "quantity": 2, "sale_amount": 50.00, "artisan_payout": 35.00 }]
    }
  ],
  "totals": { "total_sales": 150.00, "total_payouts": 105.00, "total_store_commission": 45.00 }
}
```

---

## Kiosk Discounts

Discount presets are stored in Redis and displayed in the kiosk UI for quick discounting at point-of-sale.

### `GET /api/kiosk/discounts`
List all discount presets.

**Auth:** None required (reads from Redis cache)
**Response:** `{ ok: true, discounts: [...] }`

### `POST /api/kiosk/discounts`
Create a new discount preset.

**Auth:** None required
**Body:**
```json
{ "name": "Staff Discount", "type": "percentage", "value": 10, "scope": "cart" }
```
`type`: `"percentage"` or `"fixed"`. `scope`: `"cart"` or `"item"`.

**Response:** `{ ok: true, discount: { id, name, type, value, scope, active, created_at } }`

### `PUT /api/kiosk/discounts/:id`
Update an existing discount preset. All fields are optional (partial update).

**Auth:** None required
**Body:** Any subset of `{ name, type, value, scope, active }`
**Response:** `{ ok: true, discount: { ...updated } }`

### `DELETE /api/kiosk/discounts/:id`
Delete a discount preset.

**Auth:** None required
**Response:** `{ ok: true }`

---

## Promo Codes

### `POST /api/promo/validate`
Validate a promo code and check per-email redemption eligibility. The current active code is `FIRSTBATCH` (20% off). Fails open if Redis is unavailable — a Redis outage will not block legitimate customers.

**Auth:** Public
**Body:**
```json
{ "code": "FIRSTBATCH", "email": "customer@example.com" }
```
**Response (valid):**
```json
{ "ok": true, "discountPct": 20, "code": "FIRSTBATCH" }
```
Returns `400` if the code is invalid, the email is missing, or the code has already been redeemed for that email address.

### `DELETE /api/promo/redemption/:email`
Clear a per-email redemption record so the customer can redeem again. Admin use only.

**Auth:** API Key
**Response:** `{ ok: true, email: "...", message: "Redemption cleared" }`

### `POST /api/promo/seed-kiosk`
Create the `FIRSTBATCH` discount preset in the kiosk preset store so staff can apply it from the kiosk UI. Idempotent — no-op if the preset already exists.

**Auth:** API Key
**Response (created):** `201 { ok: true, message: "FIRSTBATCH preset created", preset: { ... } }`
**Response (exists):** `200 { ok: true, message: "FIRSTBATCH preset already exists", preset: { ... } }`

---

## Webhooks

### `POST /api/webhooks/terminal`
Receive and process Helcim webhook events (`cardTransaction`, `terminalCancel`). Used by the kiosk terminal flow to deliver payment results asynchronously.

**Auth:** Public (signature-verified via HMAC-SHA256 using `HELCIM_WEBHOOK_SECRET`)
**Headers:** `webhook-id`, `webhook-timestamp`, `webhook-signature` (set by Helcim)
**Body:** Raw JSON (Helcim event envelope: `{ id, type }`)

Signature verification uses the raw request body; `express.raw()` is applied on this route specifically. Logs and caches terminal results for kiosk polling. Sends a void alert email on `terminalCancel`.

---

## Product Requests

### `POST /product-requests`
Submit a product request form (public endpoint).

**Auth:** Public
**Rate limit:** 10 req/min
**Body:**
```json
{ "name": "...", "email": "...", "product": "...", "details": "..." }
```

### `GET /product-requests`
List submitted product requests.

**Auth:** API Key

---

## Contact Form

### `POST /api/contact`
Send a contact form message via email.

**Auth:** Public
**Rate limit:** 5 req/min
**Body:**
```json
{ "name": "...", "email": "...", "message": "..." }
```

---

## Rate Limits

| Scope | Limit | Window |
|-------|-------|--------|
| General `/api/*` | 60 req | 1 min |
| Payment endpoints | 10 req | 1 min |
| Product requests | 10 req | 1 min |
| Contact form | 5 req | 1 min |

Rate limiting uses Redis when available. Falls back to per-process in-memory limiting when Redis is down.

## Error Responses

All errors follow a consistent format:
```json
{ "error": "Human-readable error message" }
```

Common HTTP status codes: 400 (validation), 401 (Zoho not authenticated), 403 (forbidden / bad API key), 429 (rate limited), 500 (server error), 502 (upstream API failure), 503 (not configured).

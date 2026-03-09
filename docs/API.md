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

### `POST /api/payment/charge`
Process a card-not-present payment via GP.

**Auth:** API Key
**Rate limit:** 10 req/min
**Body:**
```json
{
  "token": "gp_payment_token",
  "amount": 50.00,
  "currency": "CAD",
  "description": "Deposit for reservation"
}
```

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

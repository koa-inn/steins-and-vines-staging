# Steins & Vines — Full Codebase Review

**Date:** 2026-03-09
**Scope:** Full sweep — middleware, frontend, build, CI
**Reviewer:** Claude (Engineering Plugin)

---

## Overall Assessment

This is a well-architected production system for a small business. The security posture is strong for its scale, with server-side price anchoring, CORS whitelisting, rate limiting, encrypted token storage, idempotency keys, and reCAPTCHA protection. The testing campaign is thorough and methodical. The code is consistently readable with good inline commentary explaining *why* decisions were made.

**Dimension Ratings:**

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Security | B+ | Strong fundamentals; one critical finding (hardcoded API key), a few medium items |
| Performance | A- | Good caching strategy, rate-limit protection, stale-while-revalidate pattern |
| Correctness | A- | Solid edge-case handling, floating-point rounding, good offline fallbacks |
| Maintainability | B | Large files with significant duplication; good test coverage campaign underway |

---

## Critical Findings

### 1. Hardcoded API Key in Client-Side JavaScript

**File:** `js/modules/01-config.js:5`
**Severity:** Critical

```js
var MW_API_KEY = 'a9QKtDV3DtYSFIdWtfAMg9Ry70bHG55QGhyJa9GD3fM=';
```

This API key is shipped to every browser, visible in source, and committed to git history. The inline comment says "protected by CORS origin whitelist on the middleware" — but CORS is enforced by browsers only. Any HTTP client (curl, Postman, a script) can send requests with the correct `X-API-Key` header and bypass CORS entirely. The `requireAllowedReferer` middleware adds a Referer check, but Referer headers are also trivially spoofable from server-side code.

**The middleware does protect its most sensitive routes** — mutating `/api/*` endpoints require this key, and `/api/checkout` is exempt (protected by reCAPTCHA + rate limiting instead). However, any route that checks `MW_API_KEY` (e.g. `GET /api/orders/recent`) can be called by anyone who views source.

**Recommendation:** Treat `MW_API_KEY` as a public identifier, not a secret. For truly sensitive endpoints like `/api/orders/recent` (which exposes customer names, order totals, and transaction IDs), require proper authentication — either a session token from the admin OAuth flow, or move it behind a separate admin-only auth guard. For now, at minimum, rotate the key since the current value is in git history.

---

### 2. `/api/orders/recent` Uses a Different Key (`MW_API_KEY`) Than the Server Guard (`API_SECRET_KEY`)

**File:** `zoho-middleware/routes/pos.js:505-507`

```js
var apiKey = req.headers['x-api-key'] || req.query.api_key;
if (apiKey !== process.env.MW_API_KEY) {
```

The global API key guard in `server.js:198-206` checks `process.env.API_SECRET_KEY`, but this endpoint checks `process.env.MW_API_KEY`. There are two separate secret env vars for the same purpose. If only one is set, the other endpoint's protection is silently disabled.

Additionally, this endpoint accepts the key via `req.query.api_key` (URL query parameter), which means the secret appears in server access logs, browser history, and Referer headers.

**Recommendation:** Standardize on one API key env var. Remove the query parameter option — headers only.

---

## High Findings

### 3. reCAPTCHA "Fail Open" May Be Too Permissive

**File:** `zoho-middleware/routes/checkout.js:55-58`

```js
return withTimeout(verifyPromise, 5000).catch(function(timeoutErr) {
    log.warn('[checkout] reCAPTCHA verification timed out — allowing through');
    return { success: true, score: 1.0 };
});
```

And lines 245-248: Google unreachable → also allowed through.

This is a defensible design choice (don't block real customers when Google is slow), but it means an attacker can block the server's outbound connection to `google.com` and then submit unlimited checkout requests that bypass reCAPTCHA entirely, limited only by the rate limiter (10/min on payment, 60/min on API).

**Recommendation:** Add a counter (in Redis) of consecutive reCAPTCHA failures. If it exceeds a threshold (e.g. 10 in 5 minutes), switch to "fail closed" mode temporarily and return a 503 asking customers to try again.

### 4. Contact Form: No reCAPTCHA, Email Header Injection Possible

**File:** `zoho-middleware/server.js:123-159`

The `/api/contact` endpoint has rate limiting (5/min) but no reCAPTCHA. Additionally, the `name` field is interpolated directly into the email subject:

```js
subject: 'New message from ' + name + ' via steinsandvines.ca',
```

While nodemailer handles header injection for the `subject` field, the `replyTo: email` field accepts user input directly. An attacker could submit `email: "attacker@evil.com\r\nBcc: victim@example.com"` — though modern nodemailer versions sanitize this, it's worth validating the email more strictly or using nodemailer's address object format.

**Recommendation:** Add reCAPTCHA to the contact form (you already have the infrastructure). Use `{ name: name, address: email }` object format for `replyTo`.

### 5. Kiosk POS Response Leaks Voided Transaction ID

**File:** `zoho-middleware/routes/pos.js:323-327`

```js
res.status(502).json({
    error: 'Payment was taken but order could not be recorded.',
    payment_voided: true,
    voided_transaction_id: txnId    // ← exposed to client
});
```

The checkout route (`checkout.js:632`) correctly avoids this (comment `M10`), but the kiosk POS route still leaks the `voided_transaction_id` in the response. Transaction IDs are sensitive — they can be used for replay attacks or to query transaction status.

**Recommendation:** Remove `voided_transaction_id` from the kiosk response, matching the checkout pattern.

### 6. `pos/sale` Records Payment as "cash" Despite Being a Card Terminal Transaction

**File:** `zoho-middleware/routes/pos.js:459`

```js
payment_mode: 'cash',
```

The legacy `POST /api/pos/sale` records the Zoho customer payment as `cash`, but the payment was actually taken via the GP card terminal. The kiosk sale endpoint correctly detects card type (`creditcard` or `debitcard`). This creates inaccurate financial records.

**Recommendation:** Detect card type from the terminal response as the kiosk endpoint does, or at minimum use `'creditcard'` as the default.

---

## Medium Findings

### 7. Health Endpoint Exposes Authentication State

**File:** `zoho-middleware/server.js:92-98`

```js
app.get('/health', function (req, res) {
    res.json({ status: 'ok', authenticated: zohoAuth.isAuthenticated(), uptime: process.uptime() });
});
```

This is unauthenticated and reveals whether the Zoho OAuth flow is active and how long the server has been running. While Railway uses this for health checks, it's also publicly accessible.

**Recommendation:** Keep a minimal `{ status: 'ok' }` for the public endpoint. Expose detailed diagnostics on a separate authenticated admin endpoint.

### 8. POS Status Endpoint Leaks Environment Variable Names

**File:** `zoho-middleware/routes/pos.js:349`

```js
var gpVarsPresent = Object.keys(process.env).filter(function(k) { return k.indexOf('GP_') === 0; });
```

Lists all `GP_*` environment variable names in the response. This helps an attacker understand your payment gateway configuration.

**Recommendation:** Remove `gp_vars_present` from the response, or put it behind admin auth.

### 9. Double Response Risk in Kiosk Sale Idempotency

**File:** `zoho-middleware/routes/pos.js:57-69`

```js
if (idempotencyKey) {
    return cache.get(idempotencyKey).then(function (cached) {
        if (cached) { return res.status(201).json(cached); }
        processSale(body, idempotencyKey, req, res);
    }).catch(function () {
        processSale(body, idempotencyKey, req, res);
    });
}
processSale(body, null, req, res);  // ← also runs when idempotencyKey is set!
```

When `idempotencyKey` is truthy, the `return` on the `cache.get()` promise exits only from the `.then()` callback, not from the outer function. The `processSale(body, null, req, res)` on line 69 **always executes** when `idempotencyKey` is set, because the `if` block does `return cache.get(...)` (returns a promise), but then execution falls through to line 69 before the promise resolves. This will cause a double-response crash (`Error: Can't set headers after they are sent`).

**Recommendation:** Add `return` before the second `processSale` call, or restructure with `else`:

```js
if (idempotencyKey) {
    return cache.get(...).then(...)...;
}
return processSale(body, null, req, res);
```

### 10. Frontend Cart Sidebar Uses `innerHTML` with User-Controlled Data

**File:** `js/modules/11-cart.js:757-758` and `js/modules/11-cart.js:934-935`

```js
priceEl.innerHTML = '<span class="cart-price-original">' + formatCurrency(item.price) + '</span> ' + formatCurrency(price);
```

The `item.price` comes from localStorage (populated from API responses). If the API response were ever compromised (or localStorage manipulated), this creates an XSS vector. The rest of the codebase is careful to use `textContent` — these two lines are the exception.

**Recommendation:** Build these elements with `createElement`/`textContent` like the rest of the code does, or ensure `formatCurrency` strips non-numeric characters (it partially does via the regex, but the original `item.price` is passed directly).

---

## Low Findings

### 11. Large File Duplication

`renderCartSidebar()` and `renderCartDrawer()` in `11-cart.js` are nearly identical (~150 lines each). `renderWeightControl()` and `renderWeightControlCompact()` share about 80% of their logic. This increases the surface area for bugs — fixing something in one requires remembering to fix the other.

**Recommendation:** Extract shared rendering logic into helper functions. This is a good candidate for your Campaign 5 backlog.

### 12. `console.log` Left in Production Code

**File:** `js/modules/11-cart.js:161`

```js
console.log('[Cart] Refreshing ' + wraps.length + ' reserve controls');
```

This fires on every cart change in production. Minor but noisy in customer browsers.

### 13. Floating-Point Edge Case in Weight Controls

**File:** `js/modules/11-cart.js:373-376`

```js
function snapVal(v) {
    var snapped = Math.round(v / stepVal) * stepVal;
```

When `stepVal` is `0.01`, repeated multiply/divide operations can accumulate IEEE 754 drift. The `toFixed(decimals + 2)` on the return partially mitigates this, but a more robust approach would be to work in integer cents/grams internally.

### 14. `cache.get()` Returns Parsed JSON — Double-Parse in Recent Orders

**File:** `zoho-middleware/routes/pos.js:518`

```js
if (cached) {
    return res.json({ orders: JSON.parse(cached), cached: true });
}
```

But `cache.get()` already does `JSON.parse(val)` internally (cache.js:68). So `cached` is already an object/array. The `JSON.parse(cached)` call will fail at runtime because you're trying to parse an already-parsed object. Either this code path has never been hit, or Redis is always cold for this key.

**Recommendation:** Remove the `JSON.parse()` wrapper — `cached` is already deserialized. Also, the `cache.set` on line 561 does `JSON.stringify(orders)` before storing, which means it gets double-stringified. Store `orders` directly.

---

## Positive Observations

These are things done well — worth highlighting:

- **Server-side price anchoring** (checkout.js, pos.js): Never trusts client-supplied prices. The `buildLineItems` function uses catalog prices from the Redis cache, and the kiosk sale endpoint hard-rejects any item not in the catalog. This is textbook e-commerce security.
- **Idempotency keys** on checkout and kiosk sale: Prevents duplicate orders from network retries.
- **Transaction void on failure**: When Zoho order creation fails after a payment was charged, the code automatically voids the transaction. The critical failure path (void also fails) writes a durable Redis record and logs structured alerts.
- **Distributed locking** for token refresh and product cache refresh: Prevents stampedes across Railway instances.
- **Stale-while-revalidate caching** with file fallbacks: Users always get data fast, even when Zoho is slow or rate-limited.
- **Offline fallback mode**: When Zoho is completely down, checkout still works via email notification.
- **Good test coverage campaign**: Methodical approach with clear status tracking and sensible patterns for mocking.
- **Proper `escapeHTML`** used consistently in the frontend, with `textContent` preferred over `innerHTML`.
- **Cache-busting build stamps**: The `npm run build` script updates version hashes on all asset references.
- **Zoho rate-limit resilience**: 429 cooldowns, batch pausing, retry backoff, and promise coalescing throughout the catalog module.

---

## Recommended Priority Order

1. **Rotate and deprecate `MW_API_KEY`** from client-side code (Critical #1)
2. **Fix kiosk idempotency double-response bug** (Medium #9)
3. **Fix `orders/recent` double-parse bug** (Low #14)
4. **Remove `voided_transaction_id` from kiosk response** (High #5)
5. **Fix `pos/sale` payment mode** from 'cash' to card type (High #6)
6. **Add reCAPTCHA to contact form** (High #4)
7. **Strip diagnostic data from public endpoints** (#7, #8)
8. **Address innerHTML XSS in cart sidebar** (Medium #10)
9. **Refactor duplicated cart rendering** (Low #11, backlog)

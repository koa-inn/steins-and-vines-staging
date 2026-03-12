# Security Model — Steins & Vines

This document describes the security architecture of the Steins & Vines website as of March 2026. It covers both the static frontend (GitHub Pages) and the Node/Express middleware hosted on Railway.

---

## Table of Contents

1. [Threat Model](#threat-model)
2. [API Key Architecture](#api-key-architecture)
3. [Authentication](#authentication)
4. [Rate Limiting](#rate-limiting)
5. [Payment Security](#payment-security)
6. [Content Security Policy](#content-security-policy)
7. [Contact Form](#contact-form)
8. [reCAPTCHA](#recaptcha)
9. [Known Intentional Gaps](#known-intentional-gaps)
10. [Incident Response](#incident-response)

---

## Threat Model

### What we protect against

- **Price manipulation**: All prices are anchored server-side to the Zoho Inventory catalog. Client-supplied rates are ignored.
- **Cart tampering**: Items are validated against the authoritative catalog cache before any order is created. Unknown item IDs and missing Makers Fee are rejected.
- **Replay attacks on payments**: GP transaction IDs are marked as used in Redis (24-hour TTL) immediately after a successful order is created. A second submission with the same transaction ID returns HTTP 409.
- **Cross-site request forgery on OAuth**: The Zoho OAuth flow uses a cryptographically random state parameter (16 bytes, `crypto.randomBytes`), stored in Redis with a 10-minute TTL and consumed on use.
- **Hotlinking / unauthorized API callers**: CORS origin whitelist + Referer guard on all `/api/*` routes.
- **Contact form email header injection (CRLF)**: Newlines are stripped from the `name` field before it is embedded in the email subject line.
- **Bot abuse on checkout**: reCAPTCHA v3 score threshold of 0.5. Fail-open when Google is unreachable.
- **Credential brute-force**: Rate limiting on all `/api/*` routes, with stricter limits on payment endpoints.
- **Ghost charges (card charged, order not created)**: Catalog and cart fully validated before the card is charged. Auto-void fires on any Zoho failure after a successful charge.
- **Orphaned Zoho contacts**: Logged as warnings when a freshly-created contact has no corresponding sales order due to a downstream failure.
- **PII leakage via logs**: Customer email addresses are not written to any log line.
- **Token storage eavesdropping**: Zoho refresh tokens are encrypted at rest in Redis using AES-256-GCM when `REDIS_ENCRYPTION_KEY` is configured.

### What we knowingly accept

- **MW_API_KEY is semi-public**: The key lives in `js/sheets-config.js` on GitHub Pages and is visible to anyone who reads the source. CORS + Referer guards are the actual enforcement boundary. See [API Key Architecture](#api-key-architecture).
- **reCAPTCHA fail-open**: If Google's verification endpoint is unreachable or times out (5-second timeout), checkout is allowed through rather than blocked. This is a deliberate UX trade-off.
- **Rate limiting degrades without Redis**: When Redis is unavailable the custom store returns a no-op and rate limiting falls back to express-rate-limit's in-memory MemoryStore, which is per-process only and resets on restart.
- **No WAF or DDoS protection**: There is no Web Application Firewall in front of either GitHub Pages or the Railway middleware. Railway's built-in load balancer is the only upstream layer.
- **Admin pages have no CSP**: `admin.html`, `kiosk.html`, and `brewpad.html` do not have `Content-Security-Policy` meta tags. These pages are staff-only and require Google OAuth sign-in; the risk is accepted in exchange for simpler maintenance.
- **`withAllowDuplicates(true)` on card charges**: The GP charge call sets this flag. This is moot while `PAYMENT_DISABLED = true` on the frontend; it should be reviewed before payments are re-enabled.

---

## API Key Architecture

### How it works

The middleware requires an `x-api-key` HTTP header on all non-GET `/api/*` requests (except `/api/checkout`, which is protected by reCAPTCHA and rate limiting instead). The key is compared server-side against `API_SECRET_KEY` (Railway env var).

The matching key value (`MW_API_KEY`) lives in `js/sheets-config.js`, which is a public JavaScript file served by GitHub Pages. It is loaded by `js/modules/01-config.js` and sent in the `x-api-key` header by the frontend on every mutating request.

### Why this is acceptable

The frontend is a static site on GitHub Pages with no secrets capability. There is no build-time injection, no server-side rendering, and no way to keep a key truly private on the client side. The design accepts this and relies on two server-enforced controls instead:

1. **CORS origin whitelist** (`allowedOrigins` in `server.js`): Only requests from `steinsandvines.ca`, `staging.steinsandvines.ca`, `localhost:3001`, and `localhost:8080` receive a valid CORS response. Browser-based requests from other origins are blocked.

2. **Referer guard** (`requireAllowedReferer` in `server.js`): Applied to all `/api/*` routes (except `/api/checkout`). The referer header must exactly match an allowed origin or start with one followed by `/`. This prevents subdomain-bypass attacks. Note: the Referer header can be spoofed by non-browser tools (curl, Postman, custom scripts) — this is a known limitation.

### What this does NOT protect against

A determined attacker who reads `js/sheets-config.js`, copies the key, and makes direct `curl` requests with a spoofed `Referer` header can call non-checkout endpoints. The practical risk is low because the only meaningful write operations (POST /api/checkout, POST /contacts, POST /bookings) either use reCAPTCHA or create Zoho records that are immediately visible to staff.

### Key rotation procedure

```
openssl rand -base64 32
# 1. Update Railway env var: API_SECRET_KEY = <new value>
# 2. Update js/sheets-config.js: MW_API_KEY: '<new value>'
# 3. git push origin main (staging), test, then git push production main
```

---

## Authentication

### Zoho OAuth 2.0 (server-to-server)

The middleware connects to Zoho using a standard OAuth 2.0 Authorization Code flow. The flow is:

1. An operator visits `/auth/zoho`. The server generates a state value with `crypto.randomBytes(16)` and stores it in Redis with a 10-minute TTL.
2. The user is redirected to Zoho's consent screen.
3. Zoho calls back to `/auth/zoho/callback?code=...&state=...`. The state value is validated against Redis. If the state is missing, expired, or unknown, the request is rejected with HTTP 403.
4. The authorization code is exchanged for an access token (1-hour lifetime) and a refresh token.
5. The refresh token is stored in Redis, optionally encrypted with AES-256-GCM (`REDIS_ENCRYPTION_KEY` env var; 32-byte hex). If the key is not configured, the token is stored in plaintext.
6. Access tokens are refreshed automatically ~5 minutes before expiry. A distributed Redis lock (`zoho:refresh-lock`, 30-second TTL) prevents multiple Railway instances from refreshing simultaneously.

The Zoho access token is held in memory and also written to Redis (`zoho:access-token`) so that multiple Railway instances share the same token without each refreshing independently.

### Google OAuth (admin/kiosk/brewpad access)

Staff sign-in on `admin.html`, `kiosk.html`, and `brewpad.html` uses the Google Identity JavaScript library (client-side OAuth). Authentication happens entirely in the browser against Google. There is no server-side session for admin access; the Google-issued identity token is used directly by Google Sheets API calls.

The admin URL pattern for kiosk is: `steinsandvines.ca/admin.html?tab=kiosk`. After Google OAuth completes, the tab parameter is restored from local state.

### Apps Script server token

Internal server-to-server calls from the middleware to the Google Apps Script admin API use a shared secret (`APPS_SCRIPT_SERVER_TOKEN` env var). This is a static token, not rotated on a schedule.

---

## Rate Limiting

Rate limiting is implemented with `express-rate-limit` v6 backed by a custom Redis store. Keys use prefixes per limiter to avoid cross-contamination.

| Route / group | Window | Limit | Redis prefix |
|---|---|---|---|
| All `/api/*` routes | 60 seconds | 60 requests/IP | `rl:api:` |
| `POST /api/payment/*` | 60 seconds | 10 requests/IP | `rl:payment:` |
| `POST /api/checkout` | 60 seconds | 10 requests/IP | `rl:payment:` |
| `POST /api/pos/sale` | 60 seconds | 10 requests/IP | `rl:payment:` |
| `POST /api/kiosk/sale` | 60 seconds | 10 requests/IP | `rl:payment:` |
| `POST /product-requests` | 60 seconds | 10 requests/IP | `rl:requests:` |
| `POST /api/contact` | 60 seconds | 5 requests/IP | `rl:contact:` |

Standard rate limit headers (`RateLimit-*`) are returned on all limited responses. Legacy `X-RateLimit-*` headers are disabled.

### Degraded mode (Redis unavailable)

When Redis is unreachable, `redisUnavailableSkip()` returns `true`, which tells express-rate-limit to bypass the Redis store and fall back to its default in-memory MemoryStore. This means:

- Rate limiting still applies, but only within a single process.
- On Railway with multiple instances, each instance tracks its own counters independently — an attacker hitting multiple instances would face lower effective limits.
- Limits reset whenever the process restarts.

This is a conscious trade-off to avoid returning HTTP 429 errors to legitimate users during a Redis outage.

---

## Payment Security

Online payments are currently disabled on both staging and production (`PAYMENT_DISABLED = true` in `js/modules/01-config.js`). Global Payments production credentials are not yet active. When re-enabled, the following security controls apply.

### Tokenization flow

1. The frontend calls `GET /api/payment/config` to receive a restricted GP access token (10-minute TTL, `PMT_POST_Create_Single` permission only) and the configured deposit amount.
2. The frontend uses `@globalpayments/js` to tokenize the card client-side. Raw card data never touches the Steins & Vines server.
3. The frontend submits the payment token (`payment_token`) and cart to `POST /api/checkout`.

### Server-side charge and ghost-charge prevention

The middleware performs the following pre-charge validation before touching the card:

1. Catalog cache must be available (fail-closed — rejects with HTTP 503 if cache is empty).
2. Every item in the cart must exist in the catalog cache (unknown items rejected with HTTP 400).
3. Makers Fee must be present if any kit items are in the cart (rejected with HTTP 400).

Only after all three validations pass does the server execute `card.charge(depositAmount)`. The deposit amount is read from `GP_DEPOSIT_AMOUNT` env var — never from the client request.

After a successful charge, if any subsequent Zoho API call fails, the middleware immediately attempts to void the GP transaction.

### Void-on-failure

- On Zoho failure after a successful charge: `Transaction.fromId(transactionId).void().execute()` is called with an 8-second timeout.
- If the void succeeds: HTTP 4xx/5xx is returned to the client with `{ payment_voided: true }`.
- If the void times out: logged as `[checkout] GP void timed out — manual void required for txn=...`.
- If the void itself fails (network error or GP rejects it): `mailer.sendVoidFailureAlert()` fires an email alert to `CONTACT_TO` with the transaction ID and amount (no PII — customer email is not included). The void failure is also logged as CRITICAL.

### Price integrity

All line item prices are sourced from the server-side catalog cache (Zoho Inventory data). Client-supplied `rate` values are ignored for financial calculations in both the checkout and POS/kiosk routes. Discounts must originate server-side; client-supplied discount fields are applied only if greater than zero, but the discount percentage itself comes from the client — this is a known limitation (discount manipulation is possible if a valid item ID is known, though the Makers Fee check provides a partial guard for the primary checkout flow).

### Customer ID resolution

The Zoho contact is always resolved server-side by email address lookup (or create). A client-supplied `customer_id` is intentionally ignored, preventing a caller from attaching an order to an arbitrary contact record.

### No PII in logs

Customer email addresses are not written to any log line in `checkout.js` or `pos.js`. Transaction IDs and amounts appear in logs when needed for debugging but customer identity does not.

---

## Content Security Policy

CSP is implemented as `<meta http-equiv="Content-Security-Policy">` tags in individual HTML files. There are no server-side CSP headers (GitHub Pages does not allow custom response headers).

| Page | CSP present | Notes |
|---|---|---|
| `index.html` | Yes | Allows Behold Instagram widget, GP JS |
| `products.html` | Yes | Standard |
| `ingredients.html` | Yes | Standard (no Sentry connect-src — appears to be an omission) |
| `reservation.html` | Yes | Includes GP sandbox and production iframe/connect domains |
| `contact.html` | Yes | Standard |
| `about.html` | Yes | Standard |
| `404.html` | Yes | Minimal (no Google/middleware sources needed) |
| `admin.html` | No | Staff-only, Google OAuth required |
| `kiosk.html` | No | Staff-only, Google OAuth required |
| `brewpad.html` | No | Staff-only, Google OAuth required |
| `batch.html` | Unknown | Not checked |

### GP iframe domains

`reservation.html` allows iframes from both:
- `https://js.globalpay.com` (production)
- `https://js-cert.globalpay.com` (sandbox)

Both are included in `frame-src` and `connect-src` because the sandbox domain is needed during development/testing even when `GP_ENVIRONMENT=production` on the backend.

### Known CSP weakness

All pages use `'unsafe-inline'` for both `script-src` and `style-src`. This is required because the codebase uses inline `<script>` blocks and inline styles extensively. Migrating to nonce-based or hash-based CSP would require a significant refactor. The `'unsafe-inline'` permission meaningfully weakens XSS protection since injected scripts would not be blocked by CSP alone.

---

## Contact Form

`POST /api/contact` is a public endpoint (no API key required). The following protections are applied:

- **Rate limit**: 5 requests per IP per 60-second window.
- **CRLF injection prevention**: The `name` field has all `\r` and `\n` characters replaced with spaces before being used in the email subject line. This prevents an attacker from injecting additional email headers via the name field.
- **Email validation**: Basic regex check (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) on the submitted email address.
- **Field length enforcement**: Implicit via `.trim()` but no explicit maximum lengths are enforced on the contact form fields (name, email, message). This is a minor gap — a very long message body would be accepted.
- **SMTP transport**: Uses `requireTLS: true` with Gmail SMTP on port 587. The SMTP password is a Gmail App Password stored in Railway env vars.

---

## reCAPTCHA

`POST /api/checkout` is protected by Google reCAPTCHA v3. The site key is public (`RECAPTCHA_SITE_KEY` in `js/sheets-config.js`). The secret key (`RECAPTCHA_SECRET_KEY`) is a Railway env var and is never exposed to the frontend.

### Verification logic

1. The frontend submits a `recaptcha_token` with the checkout payload.
2. The server calls `https://www.google.com/recaptcha/api/siteverify` with a 5-second timeout.
3. Responses with `success: false` or `score < 0.5` are rejected with HTTP 400.

### Fail-open behavior (intentional)

In three cases the server allows checkout to proceed without a passing reCAPTCHA score:

1. `RECAPTCHA_SECRET_KEY` is not configured: verification is skipped entirely. This is intentional for local development. The startup log emits a warning.
2. Google's verification endpoint returns a network error: checkout is allowed through. Logged as a warning.
3. Verification times out (>5 seconds): checkout is allowed through. Logged as a warning.

The rationale is that blocking real customers because Google's API is slow is a worse outcome than occasionally letting a bot through. Bots that do get through still face rate limiting (10/min/IP on `/api/checkout`) and must submit a valid cart with items that exist in the catalog.

---

## Known Intentional Gaps

| Gap | Reason accepted |
|---|---|
| MW_API_KEY visible in client-side JS | GitHub Pages cannot keep secrets; CORS + Referer guard are the enforcement layer |
| No WAF or DDoS protection | Small traffic volume; cost not justified at current scale |
| Rate limiting degrades to per-process when Redis is down | Prefer availability over strict enforcement during Redis outage |
| reCAPTCHA fail-open | Prefer not blocking real customers over blocking bots on Google API failures |
| Admin pages (`admin.html`, `kiosk.html`, `brewpad.html`) have no CSP | Staff-only pages behind Google OAuth; lower priority |
| `'unsafe-inline'` in all page CSPs | Inline scripts and styles throughout codebase; migration not yet done |
| Transaction ID replay check fails open when Redis is down | Redis outage is rare; prefer order completion over potential replay risk |
| Zoho refresh token stored in plaintext if `REDIS_ENCRYPTION_KEY` not set | Encryption is opt-in; plaintext is the legacy default |
| Contact form fields have no maximum length on name/message | Minor; rate limiting is the primary abuse control |
| `withAllowDuplicates(true)` on GP charge | Moot while `PAYMENT_DISABLED = true`; must be reviewed before re-enabling payments |
| No confirmation email sent to customer at checkout | By design — staff send confirmation after reviewing the reservation |
| Zoho contact creation on name collision falls back to name search | Necessary for Zoho's uniqueness constraint; could theoretically match wrong contact if two customers share a name |

---

## Incident Response

### If MW_API_KEY is compromised

1. Generate a new key: `openssl rand -base64 32`
2. Update Railway env var `API_SECRET_KEY` immediately (takes effect on next request; no restart needed).
3. Update `js/sheets-config.js` (`MW_API_KEY` field).
4. Push to staging, verify, then push to production following the normal STAGING FIRST workflow.
5. Review Railway logs for any anomalous POST/PUT/DELETE requests during the exposure window.

### If a card charge fails to void

This produces a CRITICAL log entry and a `sendVoidFailureAlert` email to `CONTACT_TO`. The email contains the GP transaction ID and amount (no customer PII).

Steps:
1. Log into the Global Payments dashboard.
2. Locate the transaction by ID from the alert email.
3. Manually void the transaction.
4. Confirm the customer was not charged (or, if they were, issue a refund).
5. Check Railway logs for `[checkout] CRITICAL: Void failed` to identify all affected transactions.

### If GP void times out

The log entry reads: `[checkout] GP void timed out — manual void required for txn=<id>`. No email alert is sent for timeouts (only for void failures). Action:
1. Manually void in the GP dashboard using the transaction ID from the log.
2. Consider whether the timeout is a symptom of a GP API outage.

### If Zoho OAuth expires or loses its refresh token

Symptoms: all `/api/*` routes return HTTP 401 ("Not authenticated").

Steps:
1. Visit `https://svmiddleware-production.up.railway.app/auth/zoho`.
2. Complete the Zoho consent flow.
3. Verify `/auth/status` returns `{ "authenticated": true }`.
4. The new refresh token is automatically stored in Redis.

### If Redis becomes unavailable

- Product/ingredient/kiosk caches are lost. Next API call triggers a cold Zoho fetch (may be slow).
- Rate limiting falls back to per-process in-memory (less strict).
- OAuth state validation for Zoho callback will fail (state is stored only in Redis). If re-auth is needed during a Redis outage, wait for Redis to recover.
- Idempotency keys for checkout are not enforced (duplicate submissions are possible).
- Zoho refresh token encryption/decryption still works (the key is stored in env, not Redis). However, on a cold start without Redis, the refresh token cannot be loaded and re-auth will be required.

### If Zoho Inventory data is stale or wrong

Products are cached in Redis with scheduled warm-ups at 05:00 and 13:00 UTC. If a price changes in Zoho and the cache has not refreshed:
- Customers will see the old price on the frontend.
- Checkout will use the cached (old) price for order creation.
- To force a refresh: restart the Railway service or call an endpoint that triggers a cache bust (e.g., completing a checkout invalidates `zoho:products:ts`).

---

*Last updated: March 2026. Maintained by the Steins & Vines IT team.*

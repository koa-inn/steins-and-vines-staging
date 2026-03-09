# Steins & Vines — System Design Assessment

**Date:** 2026-03-09
**Scope:** Full-stack architecture review covering frontend (GitHub Pages), Express middleware (Railway), Zoho integration, Global Payments, Redis, and service worker.

---

## 1. Architecture Summary

```
┌─────────────────┐     HTTPS      ┌──────────────────────┐     REST      ┌──────────────┐
│  Static Frontend │ ──────────────▶│  Express Middleware   │ ────────────▶│  Zoho Books / │
│  (GitHub Pages)  │                │  (Railway container)  │              │  Inventory /   │
│  HTML + vanilla  │                │                       │              │  Bookings      │
│  JS (ES5)        │◀──────────────│  Helmet, CORS, rate   │◀────────────│               │
└─────────────────┘     JSON       │  limit, auth guard    │     JSON     └──────────────┘
                                    │                       │
                                    │        ┌─────────┐    │     SDK      ┌──────────────┐
                                    │        │  Redis   │    │ ────────────▶│ Global       │
                                    │        │  (cache, │    │              │ Payments     │
                                    │        │  locks,  │    │              │ (CNP +       │
                                    │        │  rate)   │    │              │  Terminal)   │
                                    │        └─────────┘    │              └──────────────┘
                                    └──────────────────────┘
                                             │
                                       SMTP  │  Sentry
                                             ▼
                                    ┌──────────────┐
                                    │ Gmail / Sentry│
                                    └──────────────┘
```

**Key design decisions already in place (strengths):**

- Server-side price anchoring — checkout validates client prices against Zoho catalog cache, preventing price manipulation.
- Void-on-failure — if GP charge succeeds but Zoho order creation fails, the transaction is automatically voided with an 8-second timeout.
- AES-256-GCM encrypted token storage — Zoho refresh tokens encrypted at rest in Redis.
- Distributed OAuth lock — Redis SETNX prevents concurrent refresh token rotation across Railway instances.
- Graceful Redis degradation — every Redis-dependent feature falls back cleanly when Redis is unavailable.
- Idempotency keys — Redis-backed deduplication prevents double-charges on checkout retries.
- Network-first HTML in the service worker — ensures deploys are always fresh while preserving offline capability.

---

## 2. Weakpoints & Reliability Gaps

### 2.1 Single-Container Risk (HIGH)

**Problem:** Railway runs the middleware as a single container. If it crashes, restarts, or hits a memory limit, all API requests fail until the container recovers. There is no documented horizontal scaling or failover strategy.

**Impact:** A crash during a checkout flow could leave a GP charge completed but the Zoho order uncreated — and the void-on-failure handler may not execute if the process itself dies.

**Recommendations:**
- Configure Railway for at least 2 replicas. The existing Redis-based session/lock architecture already supports multi-instance — this is a configuration change, not a code change.
- Add a Railway health check that hits `/health` and triggers restart on failure.
- Implement a "dangling charge reconciler" — a cron job that queries GP for recent charges and cross-references them against Zoho sales orders, flagging any charge that has no matching order for manual review or automatic void.

### 2.2 Redis Down = Duplicate Charges Possible (HIGH)

**Problem:** When Redis is unavailable, the idempotency guard in checkout.js falls through — `cache.get()` returns null, so the same idempotency key can be processed multiple times. The graceful degradation design correctly keeps the system running, but it sacrifices the one guarantee that matters most: preventing duplicate charges.

**Impact:** A customer who double-clicks "Pay" while Redis is down could be charged twice.

**Recommendations:**
- Add an in-process `Map` as a fallback idempotency store with a 5-minute TTL. This provides single-instance dedup even when Redis is unavailable.
- Log a `WARN`-level alert whenever the Redis fallback path is taken during checkout, so operations knows idempotency protection is degraded.

### 2.3 `withAllowDuplicates(true)` in Payments (HIGH)

**Problem:** The GP charge call in `payments.js` uses `withAllowDuplicates(true)`, which disables GP's own duplicate-transaction detection. Combined with §2.2 above, this removes both layers of duplicate protection.

**Impact:** The payment gateway itself will not reject duplicate charges — the only protection is the Redis idempotency key.

**Recommendations:**
- Remove `withAllowDuplicates(true)`. If it was added to work around a specific GP error, investigate the root cause and find a narrower fix.
- If it must stay, document why and ensure the Redis idempotency layer is hardened per §2.2.

### 2.4 Void Failure is Fire-and-Forget (MEDIUM)

**Problem:** When void-on-failure triggers (GP charge succeeded, Zoho order failed), the void has an 8-second timeout. If the void itself fails (network issue, GP outage), an alert email is sent — but there is no automated retry or reconciliation. The charge remains on the customer's card indefinitely.

**Impact:** Revenue leakage / customer overcharge requiring manual intervention to discover and resolve.

**Recommendations:**
- Write failed void attempts to a Redis "void retry queue" and process them via a cron job every 5 minutes.
- Add a `/api/admin/pending-voids` endpoint so the admin dashboard can surface unresolved charges.

### 2.5 No Circuit Breaker on Zoho API (MEDIUM)

**Problem:** `zoho-api.js` retries failed Zoho requests with exponential backoff (30s cap), which is good. But when Zoho is fully down, every incoming request still attempts the full retry sequence, consuming connections and increasing latency. There is no circuit breaker to short-circuit requests during a known outage.

**Impact:** During a Zoho outage, Railway response times spike and rate limiters may not protect against the cascading slowdown since each request holds a connection for up to 30+ seconds.

**Recommendations:**
- Implement a simple circuit breaker: after N consecutive Zoho failures within T seconds, trip the breaker and return a cached/fallback response immediately for read endpoints, or a "temporarily unavailable" error for writes, for a cooldown period.
- This pairs naturally with the existing 60s catalog cache TTL — read requests can serve stale data during short outages.

### 2.6 Unbounded Zoho Pagination (MEDIUM)

**Problem:** `fetchAllItems` in `zoho-api.js` caps at `MAX_PAGES = 50` (1000 items at 200/page). If the inventory grows beyond 1000 items, the catalog silently truncates.

**Impact:** Products beyond page 50 would never appear on the website, with no error or warning.

**Recommendations:**
- Log a warning when `MAX_PAGES` is reached.
- Increase the cap or remove it and rely on Zoho's `has_more_page` response.
- Add a catalog item count to the `/health` endpoint so monitoring can alert on unexpected drops.

### 2.7 Content Security Policy Gaps (MEDIUM)

**Problem:** The main customer-facing pages have CSP headers, but `kiosk.html`, `batch.html`, and `brewpad.html` do not. These internal tools are still web-accessible and handle payment data (kiosk) or inventory operations (batch).

**Recommendations:**
- Add CSP meta tags to all three internal pages.
- Consider adding `X-Frame-Options: DENY` to prevent clickjacking, especially on kiosk which processes payments.

### 2.8 Google OAuth Token in localStorage (LOW-MEDIUM)

**Problem:** `kiosk.js` stores a Google OAuth token in `localStorage`, which is accessible to any JavaScript running on the same origin. If an XSS vulnerability were exploited, the token could be exfiltrated.

**Recommendations:**
- Move the token to an `HttpOnly` cookie set by the middleware, or store only in memory with a short-lived session.
- If localStorage must be used, encrypt the token with a per-session key.

### 2.9 Service Worker Cache Invalidation (LOW)

**Problem:** The service worker uses a timestamped `CACHE_VERSION` that updates on build. But product images are cached in a separate `IMAGES_CACHE` that is never version-invalidated — it only uses LRU eviction at 200 items. If a product image is updated at the same URL, customers see the old image until it's evicted.

**Recommendations:**
- Include a content hash or version query parameter in product image URLs.
- Alternatively, set a max-age on the images cache and re-validate periodically.

---

## 3. Security Assessment

| Layer | Status | Notes |
|-------|--------|-------|
| HTTPS | ✅ | GitHub Pages + Railway both enforce TLS |
| CORS | ✅ | Origin whitelist with explicit allow list |
| Referer check | ✅ | Double-layer with CORS; checkout exempt (reCAPTCHA instead) |
| API key guard | ✅ | Mutating endpoints require `x-api-key` header |
| Rate limiting | ✅ | Redis-backed with per-prefix isolation; MemoryStore fallback |
| Helmet | ✅ | Default security headers applied |
| reCAPTCHA | ✅ | v3 on checkout with fail-open on timeout |
| Token encryption | ✅ | AES-256-GCM for Zoho refresh token at rest |
| Input validation | ⚠️ | Contact form sanitizes newlines; checkout validates types; but items.js POST has mass assignment risk |
| CSP | ⚠️ | Present on main pages, missing from kiosk/batch/brewpad |
| Secrets management | ⚠️ | MW_API_KEY loaded via `sheets-config.js` (client-side, version-controlled risk) |
| Dependency auditing | ❓ | No `npm audit` step in CI pipeline |

**Key security recommendations:**
1. Add `npm audit --audit-level=high` to the CI pipeline.
2. Sanitize and whitelist fields in `items.js` POST handler to prevent mass assignment.
3. Ensure `sheets-config.js` is in `.gitignore` if it contains secrets (it currently loads the MW_API_KEY for the frontend).
4. Add CSP to all HTML pages.

---

## 4. Scalability Analysis

### Current Scale Assumptions

Based on the rate limiters and codebase patterns, the system is designed for a small-to-medium retail operation — roughly dozens of concurrent users, not thousands. This is appropriate for a local wine/beer/fermentation shop.

### Scaling Bottlenecks (if growth demands it)

| Component | Bottleneck | Mitigation |
|-----------|-----------|------------|
| Railway container | Single instance; vertical scaling only | Enable Railway replicas (code is already multi-instance safe via Redis) |
| Zoho API | 150 req/min rate limit (Books); pagination caps | Aggressive caching (already in place); webhook-driven sync (see §5.1) |
| Redis | Single Redis instance | Railway Redis supports replicas; current usage is light |
| GitHub Pages | CDN-backed; virtually unlimited for static files | Not a bottleneck |
| Global Payments | SDK-based; no documented rate limits for transaction volumes at this scale | Not a near-term concern |

---

## 5. Novel Ideas & Implementations

### 5.1 Webhook-Driven Inventory Sync (HIGH VALUE)

**Current state:** The middleware polls Zoho on a cron schedule (5am/1pm UTC) and caches product data in Redis with a 60s TTL. Between warm-ups, the first request after cache expiry triggers a cold Zoho fetch.

**Proposal:** Register Zoho webhooks for inventory item create/update/delete events. When Zoho fires a webhook, the middleware instantly invalidates and re-fetches only the affected items.

**Benefits:**
- Near-real-time inventory accuracy (critical when items sell out in-store and should disappear from the website immediately).
- Eliminates cache-miss latency spikes for customers.
- Reduces Zoho API calls (only fetch what changed vs. full catalog sweeps).

**Implementation sketch:**
1. Add a `POST /api/webhooks/zoho` endpoint protected by HMAC signature verification (Zoho signs webhook payloads).
2. On item update: invalidate the Redis key for that item and re-fetch it from Zoho.
3. On item delete: remove from Redis cache.
4. Keep the cron warm-up as a safety net for missed webhooks.

### 5.2 Real-Time Order Status via Server-Sent Events (HIGH VALUE)

**Current state:** After checkout, customers see a confirmation page but have no visibility into order fulfillment, pickup readiness, or fermentation progress.

**Proposal:** Add an SSE endpoint (`GET /api/orders/:id/stream`) that pushes status updates to the customer's browser.

**Use cases:**
- "Your order has been received" → "Your fermentation kit is being prepared" → "Ready for pickup"
- Ferment-in-store bookings: "Your batch is fermenting (day 3 of 14)" → "Bottling scheduled" → "Ready for pickup"

**Implementation sketch:**
1. Zoho workflow rules trigger webhooks on sales order status changes.
2. Middleware receives webhook, publishes to a Redis Pub/Sub channel keyed by order ID.
3. SSE endpoint subscribes to the channel and streams updates to the client.
4. Frontend shows a live status tracker on the order confirmation / "My Orders" page.

### 5.3 Predictive Stock Alerts (MEDIUM VALUE)

**Current state:** Stock levels are managed manually in Zoho. No automated alerting when popular items are running low.

**Proposal:** Build a lightweight analytics module that tracks sales velocity per product and predicts when stock will hit zero.

**Implementation sketch:**
1. On each checkout, log `{ item_id, quantity, timestamp }` to a Redis sorted set (or a simple JSON log file).
2. A weekly cron job calculates 7-day and 30-day moving average sales rates per item.
3. Compare current stock (from Zoho) against projected depletion: `days_remaining = current_stock / daily_avg`.
4. If `days_remaining < threshold` (e.g., 7 days), send an alert email to the shop owner.
5. Surface these predictions on the admin dashboard with a "restock recommendations" panel.

### 5.4 Smart Booking Suggestions (MEDIUM VALUE)

**Current state:** Customers pick a date/time for ferment-in-store bookings from a calendar. No guidance on optimal times.

**Proposal:** Analyze historical booking data to suggest times with the best availability and shortest wait times.

**Implementation sketch:**
1. Aggregate past bookings by day-of-week and hour.
2. Build a heatmap of busy vs. quiet times.
3. On the reservation page, display "Best times this week" badges on low-utilization slots.
4. Optionally offer a small incentive (e.g., 5% off) for booking during off-peak hours to smooth demand.

### 5.5 PWA Background Sync for Offline Orders (MEDIUM VALUE)

**Current state:** The service worker provides offline page caching but does not handle offline form submissions. If a customer loses connectivity mid-checkout, the order fails.

**Proposal:** Use the Background Sync API to queue checkout requests when offline and replay them when connectivity returns.

**Implementation sketch:**
1. Register a `sync` event tag (e.g., `checkout-sync`) in the service worker.
2. When the checkout fetch fails due to network, store the request payload in IndexedDB and register a sync.
3. When connectivity returns, the service worker replays the request.
4. Show the customer a "Your order will be submitted when you're back online" message.
5. Idempotency keys ensure the replayed request is safe even if the original partially completed.

### 5.6 Customer Loyalty & Rewards (MEDIUM VALUE)

**Current state:** No loyalty program. Repeat customers get no recognition or incentive.

**Proposal:** Track purchase history via Zoho custom fields on the Contact object and implement a points-based rewards system.

**Implementation sketch:**
1. On each completed checkout, increment a `loyalty_points` custom field on the Zoho contact (`points = subtotal_cents / 100`).
2. Add a `/api/loyalty/:email` endpoint that returns the customer's points balance and available rewards.
3. Frontend shows a "Your Rewards" section on the account/checkout page.
4. Define reward tiers: 100 points = $5 off, 250 points = free yeast packet, 500 points = 10% off a ferment-in-store session.
5. Reward redemption deducts points and applies a discount line item to the Zoho sales order.

### 5.7 Automated Batch Tracking Integration (LOW-MEDIUM VALUE)

**Current state:** `brewpad.html` exists for batch management but operates somewhat independently from the booking and checkout flows.

**Proposal:** Close the loop between bookings, batch tracking, and customer notifications.

**Flow:**
1. Customer books a ferment-in-store session → Zoho booking created.
2. Staff starts the batch in brewpad → batch record linked to the booking ID.
3. Brewpad tracks fermentation milestones (start, primary done, secondary, bottling, ready).
4. Each milestone update triggers a customer notification (email or SSE per §5.2).
5. When the batch is ready, automatically send a pickup reminder with the booking details.

### 5.8 A/B Testing Framework for Catalog Layout (LOW VALUE, HIGH LEARNING)

**Current state:** Product catalog layout is fixed. No mechanism to test whether different layouts, sort orders, or featured product selections affect conversion.

**Proposal:** A lightweight client-side A/B testing framework.

**Implementation sketch:**
1. On page load, assign the visitor to a variant (stored in `sessionStorage`).
2. Variants control: featured product selection, default sort order, card layout (grid vs. list), CTA button text.
3. Log variant assignment + conversion events (add-to-cart, checkout) to a simple analytics endpoint or Google Analytics custom dimensions.
4. Admin dashboard shows conversion rates by variant.

---

## 6. Prioritized Roadmap

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 🔴 P0 | Remove `withAllowDuplicates(true)` or add in-process idempotency fallback | 1-2 hours | Prevents duplicate charges |
| 🔴 P0 | Add in-process idempotency Map for Redis-down scenario | 2-3 hours | Prevents duplicate charges |
| 🟠 P1 | Enable Railway multi-replica + health check | 1 hour (config) | Eliminates single-container SPOF |
| 🟠 P1 | Void retry queue + cron | 4-6 hours | Prevents orphaned charges |
| 🟠 P1 | Add CSP to kiosk/batch/brewpad pages | 1-2 hours | Closes XSS attack surface |
| 🟡 P2 | Circuit breaker on Zoho API | 4-6 hours | Resilience during Zoho outages |
| 🟡 P2 | Webhook-driven inventory sync | 1-2 days | Near-real-time stock accuracy |
| 🟡 P2 | Add `npm audit` to CI | 30 min | Catches vulnerable dependencies |
| 🟢 P3 | Real-time order status (SSE) | 2-3 days | Customer experience improvement |
| 🟢 P3 | Predictive stock alerts | 1-2 days | Operational efficiency |
| 🟢 P3 | Smart booking suggestions | 1-2 days | Demand smoothing |
| 🟢 P3 | PWA background sync | 1-2 days | Offline resilience |
| 🔵 P4 | Customer loyalty system | 3-5 days | Customer retention |
| 🔵 P4 | Batch tracking integration | 2-3 days | Operational cohesion |
| 🔵 P4 | A/B testing framework | 2-3 days | Data-driven optimization |

---

## 7. Trade-Off Analysis

### Static Frontend vs. SSR/SPA Framework

**Current choice:** Static HTML + vanilla ES5 JavaScript on GitHub Pages.

**Pros:** Zero hosting cost, global CDN, no build server, maximum simplicity, fast page loads, SEO-friendly, no framework churn.

**Cons:** No component reuse, manual DOM manipulation, harder to implement complex UI state (like real-time updates), ES5 limits developer ergonomics.

**Verdict:** The right choice for this scale. The vanilla JS approach keeps the team nimble and avoids framework migration pain. Revisit only if the frontend complexity grows significantly (e.g., adding a full customer portal with order history, loyalty dashboard, and real-time tracking).

### Middleware-as-Gateway vs. Direct Zoho API Access

**Current choice:** All Zoho/GP interactions go through the Express middleware.

**Pros:** Centralized auth management, rate limit protection, caching, price anchoring, audit logging, secret isolation.

**Cons:** Single point of failure, added latency hop, operational burden of maintaining the middleware.

**Verdict:** Correct architectural decision. The middleware provides critical security guarantees (price anchoring, void-on-failure) that cannot be implemented client-side. The SPOF concern is addressed by enabling Railway replicas.

### Redis for Everything vs. Specialized Stores

**Current choice:** Redis serves as cache, lock manager, rate limiter, idempotency store, and session store.

**Pros:** Single dependency to manage, Redis excels at all these use cases, operational simplicity.

**Cons:** Redis failure degrades multiple systems simultaneously.

**Verdict:** Appropriate for current scale. The graceful degradation design mitigates the "all eggs in one basket" risk. If scale demands it, the rate limiting could move to Railway's built-in rate limiter, and the idempotency store could use a dedicated Redis instance.

---

*Generated by system-design assessment — Steins & Vines, March 2026*

# Architecture — Steins & Vines

## System Overview

```mermaid
graph TB
    subgraph "Customer Browser"
        FE[Static Frontend<br/>HTML / Vanilla JS / CSS]
        SW[Service Worker<br/>Offline caching]
    end

    subgraph "GitHub Pages"
        GHP_S[Staging<br/>staging.steinsandvines.ca]
        GHP_P[Production<br/>steinsandvines.ca]
    end

    subgraph "Railway"
        MW[Express Middleware<br/>Node.js]
        REDIS[(Redis<br/>Cache / Rate Limit<br/>/ Idempotency)]
    end

    subgraph "Zoho"
        ZB[Zoho Books<br/>Orders, Invoices,<br/>Contacts]
        ZI[Zoho Inventory<br/>Products, Stock]
        ZK[Zoho Bookings<br/>Appointments]
    end

    subgraph "External Services"
        GP[Global Payments<br/>Card-Not-Present<br/>+ Terminal]
        RECAP[Google reCAPTCHA v3]
        SENTRY[Sentry<br/>Error Tracking]
        SMTP[SMTP / Gmail<br/>Email Notifications]
        GAS[Google Apps Script<br/>Event Analytics<br/>+ Sheets Logging]
    end

    FE -->|"Serves static files"| GHP_S
    FE -->|"Serves static files"| GHP_P
    FE -->|"API calls"| MW
    FE -->|"sendBeacon analytics"| GAS
    FE -->|"Client-side tokenization"| GP
    SW -.->|"Cache-first / Network-first"| FE

    MW -->|"OAuth2 + REST"| ZB
    MW -->|"REST"| ZI
    MW -->|"REST"| ZK
    MW -->|"Charge / Void / Refund"| GP
    MW -->|"Verify tokens"| RECAP
    MW -->|"Error reports"| SENTRY
    MW -->|"Order + Void alerts"| SMTP
    MW -->|"Order logging"| GAS
    MW <-->|"Cache / Rate limit"| REDIS
```

## Data Flow: Customer Checkout

This is the most complex flow in the system. It touches nearly every integration.

```mermaid
sequenceDiagram
    participant Browser
    participant GP_JS as GP JS SDK
    participant MW as Middleware
    participant REDIS as Redis
    participant RECAP as reCAPTCHA
    participant GP_API as GP API
    participant ZOHO as Zoho Books

    Browser->>GP_JS: Enter card details
    GP_JS->>GP_API: Tokenize card (client-side)
    GP_API-->>GP_JS: Payment token
    Browser->>MW: POST /api/checkout<br/>(token, items, customer, recaptcha)

    MW->>REDIS: Check idempotency key
    alt Duplicate request
        REDIS-->>MW: Key exists
        MW-->>Browser: 200 (cached response)
    end

    MW->>RECAP: Verify reCAPTCHA token
    RECAP-->>MW: Score

    MW->>ZOHO: Fetch live prices
    Note over MW: Verify client prices<br/>match server prices

    MW->>GP_API: Charge card (server-side)
    GP_API-->>MW: Transaction ID

    MW->>ZOHO: Create Sales Order
    alt Zoho fails
        MW->>GP_API: Void transaction
        MW-->>Browser: 500 error
    end

    MW->>REDIS: Store idempotency key
    MW-->>Browser: 200 { salesorder_id, salesorder_number }
```

## Data Flow: Kiosk POS Sale

```mermaid
sequenceDiagram
    participant Kiosk as Kiosk Browser
    participant MW as Middleware
    participant REDIS as Redis
    participant GP_TERM as GP Terminal
    participant ZOHO as Zoho Books

    Kiosk->>MW: POST /api/kiosk/sale<br/>(items, reference)
    MW->>REDIS: Fetch cached product prices
    Note over MW: Validate items<br/>+ compute server-side tax

    MW->>GP_TERM: Send to terminal
    Note over GP_TERM: Customer taps/inserts card
    GP_TERM-->>MW: Transaction result

    MW->>ZOHO: Create Invoice (auto-paid)
    alt Invoice fails
        MW->>GP_TERM: Void transaction
        MW-->>Kiosk: 500 error
    end

    MW->>REDIS: Invalidate product cache
    MW-->>Kiosk: 200 { receipt data }
```

## Key Architectural Decisions

**Static frontend (no build framework):** The site uses plain HTML and vanilla ES5 JavaScript rather than a framework like React or Vue. This keeps the deployment simple (GitHub Pages), avoids build toolchain complexity, and makes the site fast to load. The trade-off is that frontend modules are concatenated and minified manually via npm scripts.

**Express middleware as an API gateway:** Rather than having the frontend call Zoho and GP APIs directly, all third-party API calls go through the Express middleware. This allows server-side price anchoring (clients can't tamper with prices), credential protection (API keys never reach the browser), and centralized rate limiting, caching, and error handling.

**Server-side price anchoring:** Both the checkout and kiosk flows verify that client-submitted prices match server-fetched Zoho prices. This prevents tampering via browser DevTools or modified API requests.

**Void-on-failure pattern:** If a payment succeeds but the downstream Zoho order creation fails, the middleware automatically voids the GP transaction. This prevents charging customers for orders that don't exist in the business system.

**Dual cart system:** The frontend maintains two separate localStorage carts (`sv-cart-ferment` for fermentation kits, `sv-cart-ingredients` for supplies). This supports the different checkout flows and tax treatments for each product category.

**Redis with graceful degradation:** Redis is used for caching, rate limiting, and idempotency keys, but every Redis-dependent feature degrades gracefully if Redis is unavailable. Rate limiting falls back to per-process memory; catalog requests fall through to Zoho directly.

**Campaign-based testing:** Rather than trying to achieve full test coverage in one pass, testing is organized into campaigns that target specific extractable pure functions. This is documented in TESTING.md with a progress tracker and pattern reference.

## Security Model

| Layer | Mechanism |
|-------|-----------|
| Transport | HTTPS everywhere (GitHub Pages + Railway) |
| CORS | Origin whitelist (production + staging + localhost) |
| Referer | Header check on API-key-protected routes |
| API Key | `X-Api-Key` header on all mutating `/api/*` endpoints |
| reCAPTCHA | v3 verification on public checkout |
| Rate Limiting | Redis-backed per-IP limits (falls back to in-memory) |
| Payment | Client-side tokenization (card data never hits the server) |
| Price Integrity | Server-side price anchoring against Zoho |
| Idempotency | Redis keys prevent duplicate charges |
| OAuth | AES-256-GCM encrypted token storage, auto-refresh via cron |
| Headers | Helmet (CSP, X-Frame-Options, etc. on middleware) |

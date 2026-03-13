# Helcim Migration Plan
_Branch: `feature/helcim-integration` — Started: 2026-03-12_

## Overview

Full replacement of Global Payments (GP) with Helcim across both the **online checkout** (card-not-present) and **in-store kiosk POS** (card-present) systems. The GP contract runs until ~Jan 2027; Helcim's Merchant Buyout Program offers up to $500 CAD in fee credits — exactly covering the GP $500 cancellation penalty, making an early exit financially neutral.

**Current state:** `PAYMENT_DISABLED = true` on both staging and production. GP production credentials never activated. No live payments have ever processed. This is the ideal time to swap processors before re-enabling.

---

## Key API Mappings (GP → Helcim)

| Concern | Global Payments | Helcim |
|---|---|---|
| Frontend library | `https://js.globalpay.com/4.1.11/globalpayments.js` | `https://secure.helcim.app/helcim-pay/services/start.js` |
| Tokenization | GP hosted fields → `_gpToken` | Backend initializes `checkoutToken` → HelcimPay.js iframe → `window.postMessage` |
| Server charge | GP SDK `card.charge().execute()` | `POST https://api.helcim.com/v2/payment/purchase` |
| Void | GP SDK `transaction.void()` | `POST https://api.helcim.com/v2/payment/reverse` |
| Refund | GP SDK refund | `POST https://api.helcim.com/v2/payment/refund` |
| Terminal (POS) | GP `DeviceService` + UPA "Meet in the Cloud" | `POST https://api.helcim.com/v2/devices/{deviceCode}/payment/purchase` |
| Auth | `GP_APP_ID` + `GP_APP_KEY` OAuth flow | `api-token: HELCIM_API_TOKEN` header (simple, no OAuth) |
| Sandbox | `GP_ENVIRONMENT=test` flag in same codebase | Separate Helcim sandbox account (different credentials entirely) |
| Idempotency | Redis-based idempotency keys (custom) | Required `idempotency-key` header (25-char alphanumeric) |
| Webhooks | N/A (GP uses synchronous responses) | HMAC-SHA256 signed webhooks (`cardTransaction`, `terminalCancel`) |

---

## CSP Changes (reservation.html)

**Remove:**
```
frame-src:   https://js.globalpay.com  https://js-cert.globalpay.com
connect-src: https://js.globalpay.com  https://js-cert.globalpay.com  https://apis.globalpay.com  https://apis.sandbox.globalpay.com
```

**Add:**
```
script-src:  https://secure.helcim.app  https://secure.myhelcim.com
frame-src:   https://secure.helcim.app  https://secure.myhelcim.com
connect-src: https://api.helcim.com
```

---

## New Environment Variables

```bash
# Helcim (replaces all GP_* vars)
HELCIM_API_TOKEN=           # From Helcim Hub > Integrations > API Access
HELCIM_WEBHOOK_SECRET=      # From Helcim Hub > Integrations > Webhooks (verifier token)
HELCIM_DEVICE_CODE=         # Smart Terminal device code after pairing (for POS)
HELCIM_TAX_RATE=0.05        # Default 5% (same as current KIOSK_TAX_RATE)

# These GP vars can be removed once migration is complete:
# GP_APP_ID, GP_APP_KEY, GP_MERCHANT_ID, GP_ENVIRONMENT,
# GP_DEPOSIT_AMOUNT, GP_TERMINAL_ENABLED
```

---

## Hardware Note: iPad Kiosk

Helcim's Smart Terminal **cannot pair with iPad** — it pairs only with iPhone (iOS app) or Windows/macOS desktop app. Options for the kiosk:

1. **Buy a Helcim Smart Terminal ($429 CAD)** — standalone touchscreen device, pairs over cloud. Backend pushes sale to it. Best experience.
2. **Use HelcimPay.js directly in iPad browser** — renders a card-entry iframe in Safari; no terminal pairing needed. Works for card-present if customer types card details (less ideal).
3. **iPhone as card reader** — Helcim iPhone app paired to Smart Terminal or Gen 3 Card Reader.

**Recommendation:** Purchase the Helcim Smart Terminal. The backend API integration is a direct drop-in for the current GP "Meet in the Cloud" terminal pattern.

---

## Phased Refactor Plan

---

### Phase 0 — Pre-Work (No Code Changes)
**Goal:** Accounts, credentials, hardware in hand before writing a line.

- [ ] **Contact Helcim** to activate Merchant Buyout Program (`https://www.helcim.com/switch/`) — claim $500 fee credit against GP cancellation penalty
- [ ] **Request Helcim sandbox account** — email `[email protected]` (separate from production, takes 1-2 days)
- [ ] **Create production Helcim account** — online application (~5 min)
- [ ] **Order Helcim Smart Terminal** ($429 CAD) if going with hardware POS
- [ ] **Generate API tokens** in Helcim Hub for both sandbox and production
- [ ] **Set up webhook endpoints** in Helcim Hub (pointing to Railway middleware URL)
- [ ] **Formally initiate GP contract cancellation** (or negotiate penalty-free exit citing service issues)
- [ ] Document Helcim sandbox credentials in Railway staging env vars

**Deliverable:** Sandbox credentials in Railway staging, Smart Terminal hardware ordered.

---

### Phase 1 — Backend: Helcim Library (`zoho-middleware/lib/helcim.js`)
**Replaces:** `zoho-middleware/lib/gp.js`
**Complexity:** Low — mostly credential swap + HTTP calls instead of SDK

**Tasks:**
- [ ] Create `zoho-middleware/lib/helcim.js` with:
  - `init()` — validate `HELCIM_API_TOKEN` present; log warning if missing
  - `isEnabled()` — returns boolean (replaces `gp.isTerminalEnabled()`)
  - `isTerminalEnabled()` — checks `HELCIM_DEVICE_CODE` present
  - `getDepositAmount()` — reads `HELCIM_DEPOSIT_AMOUNT` env var (or keep existing `GP_DEPOSIT_AMOUNT` name to avoid churn)
  - `charge(amount, cardToken, idempotencyKey)` — `POST /v2/payment/purchase`
  - `void(transactionId)` — `POST /v2/payment/reverse`
  - `refund(transactionId, amount)` — `POST /v2/payment/refund`
  - `terminalPurchase(amount, invoiceNumber, idempotencyKey)` — `POST /v2/devices/{HELCIM_DEVICE_CODE}/payment/purchase`
  - `initializeCheckout(amount, currency)` — `POST /v2/helcim-pay/initialize` → returns `checkoutToken`
  - `getTerminalDiagnostics()` — returns `{ enabled, device_code_set, init_error }`
  - `verifyWebhookSignature(webhookId, timestamp, body, signature)` — HMAC-SHA256 verification
- [ ] Update `zoho-middleware/server.js` to call `helcimLib.init()` on startup (replace `gpLib.init()`)
- [ ] Update `.env.example` — add `HELCIM_*` vars, mark `GP_*` vars as deprecated
- [ ] Write unit tests for `helcim.js` in `zoho-middleware/__tests__/helcim.test.js`

**Files touched:** `zoho-middleware/lib/helcim.js` (new), `zoho-middleware/server.js`, `.env.example`

---

### Phase 2 — Backend: Online Checkout Route (`routes/checkout.js`)
**Complexity:** Medium — surgery on `chargeAndProceed()`, same overall structure

**Tasks:**
- [ ] Replace `require('../lib/gp')` with `require('../lib/helcim')`
- [ ] Update `GET /api/payment/config` → rename/replace with `POST /api/payment/initialize`:
  - Accepts `{ amount, currency }` from frontend
  - Calls `helcimLib.initializeCheckout(amount, 'CAD')` → returns `{ checkoutToken }`
  - Frontend uses `checkoutToken` to render HelcimPay.js iframe
- [ ] Update `chargeAndProceed()` (~line 713–794):
  - Input: `body.payment_token` (Helcim `cardToken` from postMessage) instead of GP token
  - Call `helcimLib.charge(chargeAmt, cardToken, idempotencyKey)` instead of GP SDK
  - Map Helcim response: `transactionId` = `r.data.transactionId`; `status` = `r.data.status === 'APPROVED'`
  - Return 402 on decline (same as before)
- [ ] Update void in error handler (~line 649–690):
  - Replace GP void call with `helcimLib.void(transactionId)`
  - `POST /v2/payment/reverse` returns 200 on success
- [ ] Update `processCheckout()` — Zoho custom field `ZOHO_CF_TRANSACTION_ID` stays the same; just populates from Helcim `transactionId`
- [ ] Remove `withAllowDuplicates(true)` concern — no equivalent in Helcim (idempotency key handles this)
- [ ] Update idempotency key to be 25-char alphanumeric (Helcim requirement) — current Redis key can seed it
- [ ] Update `zoho-middleware/__tests__/checkout.test.js` — replace GP mocks with Helcim mocks

**Files touched:** `routes/checkout.js`, `zoho-middleware/__tests__/checkout.test.js`

---

### Phase 3 — Backend: Legacy Payment Routes (`routes/payments.js`)
**Complexity:** Low — thin wrapper endpoints

**Tasks:**
- [ ] Update `POST /api/payment/charge` — replace GP charge with `helcimLib.charge()`
- [ ] Update `POST /api/payment/void` — replace GP void with `helcimLib.void()`
- [ ] Update `POST /api/payment/refund` — replace GP refund with `helcimLib.refund()`
- [ ] Update `GET /api/payment/config` → if keeping, return `{ enabled: helcimLib.isEnabled(), depositAmount }` (no access token needed — frontend initializes checkout server-side instead)
- [ ] Update tests for these routes

**Files touched:** `routes/payments.js`

---

### Phase 4 — Backend: Kiosk POS Route (`routes/pos.js`)
**Complexity:** Medium — terminal flow changes but structure stays the same

**Tasks:**
- [ ] Replace `gpLib` with `helcimLib` throughout
- [ ] Update `isTerminalEnabled()` check — now checks `HELCIM_DEVICE_CODE` present
- [ ] Update `POST /api/kiosk/sale` terminal charge (~line 165–189):
  - Replace GP `terminal.sale(grandTotal).withCurrency().withInvoiceNumber().execute('terminal')`
  - With `helcimLib.terminalPurchase(grandTotal, invoiceNumber, idempotencyKey)`
  - Helcim responds `202 Accepted` immediately — **transaction result comes via webhook** (not synchronous)
  - This is the biggest architectural difference: need to handle async terminal response
  - Options:
    - **Option A (Simple):** Poll `GET /v2/transactions?invoiceNumber={ref}` until approved/declined (5s intervals, 90s timeout)
    - **Option B (Clean):** Webhook handler updates Redis with result; kiosk frontend polls `GET /api/kiosk/sale/status/{idempotencyKey}`
  - **Recommendation:** Option A for Phase 4 (simpler), Option B after webhooks (Phase 5)
- [ ] Update terminal void (~line 307–357) — replace GP void with `helcimLib.void(transactionId)`
- [ ] Update `GET /api/pos/status` — return Helcim diagnostics instead of GP diagnostics
- [ ] Update `POST /api/pos/sale` (legacy endpoint) — same replacements

**Files touched:** `routes/pos.js`

---

### Phase 5 — Backend: Webhook Handler (New Route)
**Complexity:** Medium — new infrastructure

**Tasks:**
- [ ] Create `zoho-middleware/routes/webhooks.js`:
  - `POST /api/webhooks/helcim` — receive Helcim webhook events
  - Verify HMAC-SHA256 signature using `helcimLib.verifyWebhookSignature()`
  - Handle `cardTransaction` events:
    - On `APPROVED` purchase: trigger Zoho invoice + payment recording (for async terminal flow)
    - On void/refund: log event via `eventLog.logEvent()`
  - Handle `terminalCancel` events: update Redis status for polling kiosk
  - Return 200 immediately; process in background
- [ ] Register route in `zoho-middleware/server.js`
- [ ] Add webhook URL to Helcim Hub configuration
- [ ] Write tests for webhook signature verification and event handling
- [ ] Update `openapi.yaml` — add `POST /api/webhooks/helcim` route

**Files touched:** `routes/webhooks.js` (new), `zoho-middleware/server.js`, `openapi.yaml`

---

### Phase 6 — Frontend: reservation.html + CSP
**Complexity:** Low

**Tasks:**
- [ ] Replace GlobalPayments script tag:
  ```html
  <!-- Remove -->
  <script src="https://js.globalpay.com/4.1.11/globalpayments.js"></script>
  <!-- Add -->
  <script src="https://secure.helcim.app/helcim-pay/services/start.js"></script>
  ```
- [ ] Update CSP `http-equiv` meta tag:
  - Remove all `globalpay.com` and `globalpayments.com` domains
  - Add `https://secure.helcim.app`, `https://secure.myhelcim.com` to `script-src` and `frame-src`
  - Add `https://api.helcim.com` to `connect-src`
- [ ] No other changes to `reservation.html` structure

**Files touched:** `reservation.html`

---

### Phase 7 — Frontend: Online Checkout (`js/modules/12-checkout.js`)
**Complexity:** Medium — tokenization flow changes significantly

**Tasks:**
- [ ] Replace GP payment initialization (~line 739–774):
  ```javascript
  // Old: fetch /api/payment/config → GlobalPayments.configure() → GlobalPayments.ui.form()
  // New: POST /api/payment/initialize with { amount } → get checkoutToken
  //      appendHelcimPayIframe(checkoutToken)
  //      window.addEventListener('message', handleHelcimMessage)
  ```
- [ ] Implement `handleHelcimMessage(event)`:
  - Check `event.origin === 'https://secure.helcim.app'`
  - On success: store `event.data.transactionId` as `_helcimToken` (or rename to `_helcimTransactionId`)
  - On error: clear token, show error toast
- [ ] Replace `_gpToken` variable with `_helcimTransactionId` throughout
- [ ] Update token validation before submit (~line 813–820):
  - `_helcimTransactionId` must be non-empty (same guard, different var name)
- [ ] Update POST body to `/api/checkout` (~line 844–855):
  - `payment_token: _helcimTransactionId` (field name stays the same — backend already reads `body.payment_token`)
- [ ] Update payment confirmation notice (~line 896) — logic unchanged, just remove GP-specific language
- [ ] Update `PAYMENT_DISABLED` references — flag stays, same logic
- [ ] Update `js/modules/12b-checkout-payment.js` if it references GP-specific config fields

**Files touched:** `js/modules/12-checkout.js`, `js/modules/12b-checkout-payment.js`

---

### Phase 8 — Frontend: Kiosk POS (`js/kiosk.js`)
**Complexity:** Medium — async terminal response handling

**Tasks:**
- [ ] Update `kioskCheckTerminal()` (~line 579–596):
  - `GET /api/pos/status` response shape changes slightly — update field names if needed
- [ ] Update `kioskProceedToPayment()` (~line 1201–1312):
  - `POST /api/kiosk/sale` response shape may change (202 → 201 after webhook confirms, if using async flow)
  - If using polling Option A: backend handles polling internally, kiosk waits with spinner same as before
  - If using Option B: add client-side polling of `GET /api/kiosk/sale/status/{key}`
- [ ] Update any GP-specific error messages to generic payment error messages
- [ ] Update terminal status indicator labels (remove "UPA Device" / "Meet in the Cloud" references)

**Files touched:** `js/kiosk.js`

---

### Phase 9 — Tests: Full Coverage Pass
**Complexity:** Medium

**Tasks:**
- [ ] `zoho-middleware/__tests__/helcim.test.js` — unit tests for all helcim.js methods (charge, void, refund, terminal, init, verify webhook)
- [ ] `zoho-middleware/__tests__/checkout.test.js` — swap GP mocks for Helcim mocks; all existing test cases should pass
- [ ] `zoho-middleware/__tests__/pos.test.js` — update GP terminal mocks to Helcim terminal mocks
- [ ] `zoho-middleware/__tests__/webhooks.test.js` — new test file for webhook route (signature verification, event dispatch)
- [ ] Frontend tests (`__tests__/`) — update any payment-related frontend tests
- [ ] Run full test suite: `cd zoho-middleware && npm test` (target: 257+ tests pass); `npm test` at root
- [ ] Update CI `.github/workflows/tests.yml` if any env var names change

**Files touched:** `zoho-middleware/__tests__/helcim.test.js` (new), `__tests__/webhooks.test.js` (new), existing test files

---

### Phase 10 — Cleanup & Documentation
**Complexity:** Low

**Tasks:**
- [ ] Delete `zoho-middleware/lib/gp.js` (after all references removed)
- [ ] Remove `GP_*` env vars from `.env.example` (keep commented out with migration note for reference)
- [ ] Remove `globalpayments-api` from `zoho-middleware/package.json` dependencies
- [ ] Update `SECURITY.md` — remove `withAllowDuplicates(true)` note; add Helcim idempotency key pattern
- [ ] Update `docs/DATA-MODEL.md` — update payment flow diagrams
- [ ] Update `openapi.yaml` — all updated routes (remove `/api/payment/config` if replaced, add `/api/payment/initialize`, add webhook route)
- [ ] Update `MEMORY.md` / project memory with new payment architecture

**Files touched:** Various docs, `package.json`, `openapi.yaml`, `SECURITY.md`

---

### Phase 11 — Staging Deployment & Testing
**Complexity:** High (QA effort)

**Tasks:**
- [ ] Set Railway staging env vars: `HELCIM_API_TOKEN`, `HELCIM_WEBHOOK_SECRET`, `HELCIM_DEVICE_CODE` (sandbox values)
- [ ] Set `PAYMENT_DISABLED=false` in `js/modules/01-config.js` for staging only
- [ ] `git push origin main` → deploy to staging
- [ ] Configure Helcim webhook in Helcim Hub to point to `https://svmiddleware-staging.up.railway.app/api/webhooks/helcim`
- [ ] **Online checkout testing on staging:**
  - Complete full checkout with sandbox test card: `4124 9399 9999 9990` (Visa, approved)
  - Test declined card: `4000 0000 0000 1992`
  - Verify Zoho order + payment created correctly
  - Verify void on Zoho failure (mock a Zoho error)
- [ ] **Kiosk POS testing on staging (if terminal available):**
  - Pair Smart Terminal with Helcim sandbox account
  - Complete kiosk sale end-to-end
  - Verify Zoho invoice + inventory decrement
  - Test void path
- [ ] Run full test suite on staging environment
- [ ] Human sign-off on staging before proceeding

---

### Phase 12 — Production Deployment
**Complexity:** Low (after staging validation)

**Tasks:**
- [ ] Formally cancel GP contract (or confirm buyout program activated)
- [ ] Set Railway production env vars: `HELCIM_API_TOKEN`, `HELCIM_WEBHOOK_SECRET`, `HELCIM_DEVICE_CODE` (production values)
- [ ] Set `PAYMENT_DISABLED=false` for production
- [ ] Follow CNAME swap protocol: verify `cat CNAME` = `steinsandvines.ca` before `git push production main`
- [ ] Configure Helcim production webhook to point to `https://svmiddleware-production.up.railway.app/api/webhooks/helcim`
- [ ] Physical Smart Terminal: pair with production Helcim account
- [ ] Monitor first live transactions in Helcim Hub + Railway logs
- [ ] Update GitHub Issues board — close GP-related issues, open any new Helcim tracking issues

---

## Dependency Graph

```
Phase 0 (accounts/hardware)
  └── Phase 1 (helcim.js lib)
        ├── Phase 2 (checkout route)    ←→  Phase 6 (CSP)
        │     └── Phase 7 (checkout frontend)
        ├── Phase 3 (legacy payment routes)
        ├── Phase 4 (kiosk POS route)
        │     └── Phase 8 (kiosk frontend)
        └── Phase 5 (webhooks)
              └── Phase 4 refinement (async terminal)

  All phases → Phase 9 (tests)
  Phase 9 → Phase 10 (cleanup)
  Phase 10 → Phase 11 (staging)
  Phase 11 → Phase 12 (production)
```

**Parallelizable:** Phases 2+3+4+5 can run concurrently once Phase 1 is done. Phases 6+7+8 can run in parallel with backend phases.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Helcim sandbox account takes >2 days | Medium | Medium | Start Phase 1 coding with mocked Helcim client; integrate real credentials when available |
| Smart Terminal iPad incompatibility | Confirmed | High | Order Smart Terminal ($429); or use HelcimPay.js iframe in iPad Safari as fallback |
| Webhook delivery delays cause kiosk UX issues | Medium | High | Implement polling fallback (Option A) as safety net alongside webhook (Option B) |
| GP charges exit penalty before buyout credited | Low | Medium | Confirm buyout credit applied before initiating cancellation |
| Helcim production credentials take time to activate | Medium | Medium | Full test on sandbox; have credentials ready before go-live date |
| Test cards creating real Zoho records on staging | Low | Low | Same risk as today — use dedicated Zoho sandbox org or accept it |

---

## Test Card Numbers (Helcim Sandbox)

| Card | Number | Exp | CVV | Result |
|---|---|---|---|---|
| Visa | `4124 9399 9999 9990` | 01/28 | 100 | Approved |
| Mastercard | `5413 3300 8909 9130` | 01/28 | 100 | Approved |
| Visa (declined) | `4000 0000 0000 1992` | — | — | Declined |

---

## Files Changed Summary

| File | Action | Phase |
|---|---|---|
| `zoho-middleware/lib/helcim.js` | Create | 1 |
| `zoho-middleware/lib/gp.js` | Delete | 10 |
| `zoho-middleware/routes/checkout.js` | Update | 2 |
| `zoho-middleware/routes/payments.js` | Update | 3 |
| `zoho-middleware/routes/pos.js` | Update | 4 |
| `zoho-middleware/routes/webhooks.js` | Create | 5 |
| `zoho-middleware/server.js` | Update | 1, 5 |
| `zoho-middleware/package.json` | Update (remove globalpayments-api) | 10 |
| `.env.example` | Update | 1 |
| `reservation.html` | Update (CSP + script tag) | 6 |
| `js/modules/12-checkout.js` | Update | 7 |
| `js/modules/12b-checkout-payment.js` | Update | 7 |
| `js/kiosk.js` | Update | 8 |
| `js/modules/01-config.js` | Update (PAYMENT_DISABLED) | 11 |
| `zoho-middleware/__tests__/helcim.test.js` | Create | 9 |
| `zoho-middleware/__tests__/webhooks.test.js` | Create | 9 |
| `zoho-middleware/__tests__/checkout.test.js` | Update | 9 |
| `SECURITY.md` | Update | 10 |
| `openapi.yaml` | Update | 10 |
| `docs/DATA-MODEL.md` | Update | 10 |

**Estimated file count:** ~18 files touched, 2 new files created, 1 deleted.

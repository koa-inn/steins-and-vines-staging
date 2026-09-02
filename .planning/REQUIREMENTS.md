# Requirements: Steins & Vines — v4.5 Security & Money-Path Closeout

**Defined:** 2026-07-03
**Core Value:** Customers can discover, select, or co-create fermentation recipes and purchase them as a complete package — with ingredient inventory, pricing, and batch tracking handled automatically by the system.
**Source:** `.planning/reports/AUDIT.md` (2026-07-02 whole-repo audit) §5 remediation plan. **Hardening** milestone — no new user-facing features; every requirement closes a verified audit finding. Additive setup: continues phase numbering from 46; nothing archived or renumbered ≤ 46.

> **Prior milestone (v4.4 Audit Remediation):** completed items — HYGIENE-01 (P38, deferred), DEPLOY-04 (P39), ASSET-01 (P40), CART-01 (P41), GIFTCARD-01 (P44), plus Phases 43/45 — are recorded in `ROADMAP.md` and git history. Its one un-started item, **KIOSK-01** (was Phase 42), rehomes into v4.5 below. **SEC-02** is the carried-over Phase 46.

## v1 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase. Risk-ordered:
containment → correctness → fail-closed sweep → signal.

### Public Exposure

- [x] **SEC-01** (audit **H1**, closed 2026-07-24 — staging verified 2026-07-03, prod verified live 2026-07-24): No internal planning tree or audit document is served publicly from either the staging or production Pages site. `curl https://staging.steinsandvines.ca/.planning/STATE.md` → 404 and `curl <prod>/AUDIT-2026-06-29.md` → 404; both audit docs `git rm --cached` from the served repos + `.gitignore`d; the root `.nojekyll`-vs-`_config.yml exclude` contradiction on staging reconciled (drop `.nojekyll` on staging so the exclude works, or add a `.planning`/audit strip to the staging deploy, matching prod). Sequenced first — ~minutes, independent; it hands out the admin key + a file:line exploit map today.

### Staff Authentication

- [x] **SEC-02** (audit **C1**, the deferred CRITICAL): Staff surfaces (admin, BrewPad, kiosk) authenticate via server-side identity with **no shared secret shipped to the browser**, and the leaked `API_SECRET_KEY` is rotated dead with no surface locked out. *Status:* **✅ COMPLETE 2026-07-08 (Phase 46).** Owner production cutover executed; new 3-tier auth live (device-token kiosk / Google-session admin+BrewPad / legacy key), all three surfaces verified, `API_SECRET_KEY` rotated → leaked key returns 403, no surface locked out, public checkout intact. See `phases/46-…/46-10-SUMMARY.md` + `docs/RUNBOOK.md`. Closed C1, whose blast radius grew via Phase 43/44 (gift-cert void, SSRF, DoS reachable under the public key).

### Kiosk Architecture

- [x] **KIOSK-01** (audit §4 backbone; rehomed from v4.4 #14): The kiosk POS logic exists in a single shared implementation (`js/kiosk-core.js`) consumed by both the standalone kiosk (`kiosk.js`) and the admin-embedded kiosk (`admin.js`), so the cart and payment/checkout paths can no longer diverge. Behaviour-preserving: existing kiosk money-path behaviour (terminal charge, Zoho invoice/payment, void-on-failure, dual-cart) is unchanged and verified by the existing kiosk tests plus an admin-vs-kiosk parity check; the product-type discount is identical on both surfaces. Audit §4 identifies this as the structural backbone that lets the kiosk void-on-failure **synchronously** like `checkout.js` — the prerequisite that makes MONEY-02/03 durable rather than another async backstop patch.

### Money-Path Correctness

- [ ] **MONEY-01** (audit **H2**): Online `/api/checkout` verifies the captured card amount against the recorded/invoiced total before booking payment, and voids + rejects on mismatch. Regression: `initialize(amount: 0.01)` + a full order → charge voided, no paid invoice, 4xx.
- [ ] **MONEY-02** (audit **H3/H4/H5/H8/M12/M13**): Kiosk money-path defect closeout — reconcile TTL vs orphan-age fixed / made Zoho-authoritative (H3); idempotency lock released on every confirm/checkout failure path (H4); `voidTransaction` inspects reversal status instead of trusting any 2xx (H5); `salesorder-pay` gets a lock + delete-pending-on-success + unique ref (H8); sweep clears/marks pending records to end the alert storm (M13); `pos-recipe.js` adopts `money-path` primitives + pending record (M12). Per-defect regression tests each asserting fail-*closed*; a settled paid charge is never voided; a retry after a voided charge re-acquires the lock.
- [ ] **MONEY-03** (audit **H6/H7/M9/M15/M18**): Gift-card ledger integrity — idempotent `reloadGiftCard` + append-only processed-ref ledger (H7); durable `needs_manual_review` on redeem failure **and a test that asserts the flag, not a log line** (H6); Sheets cell sanitizer neutralizing leading `=+-@` (M9); header-mapped `issueGiftCard` appendRow + bounded numerics (M18); negative-taxable custom-line tax parity so a legit discounted sale isn't voided (M15). Regression: duplicate reload → single credit; interleaved redeem retry → single decrement; redeem-failure → `needs_manual_review: true`; `=IMPORTRANGE(...)` in a void reason stored as inert text.

### Resilience

- [x] **RESIL-01** (audit **M1–M8/M20**): Fail-closed sweep of the remaining Redis-degradation and auth/validation corners — one shared closed-on-Redis-error helper applied to promo `FIRSTBATCH` (M1), the rate-limit store mid-op error (M4) and loopback skip (M5); quarantine/delete legacy `/api/pos/sale` (M2); fail-closed hardcoded gift-card `account_id` (M3); `https`-only + host allowlist on the `csv_url` SSRF (M6); auth + cache the unauth Apps-Script-backed GETs (M7, M8); validate numeric `:id` to stop the `%2F` path pivot (M20). A test asserts every money/security guard returns closed when its Redis call throws; promo not repeatable during a simulated outage; `?bust=1` requires the key.

### Observability & CI

- [x] **OBS-01** (audit **M17/L1/L2/L12/L13**): Money-path observability + CI enforcement — `Sentry.captureException` (tagged `txnId`/`reqId`) in every money-path catch (M17); `npm ci` in CI + Railway + a Node `engines`/`.nvmrc` pin (L1, L2); `--max-warnings 0` + an ES5-only lint rule so the gate actually fails (L12); a per-file coverage floor on `pos.js` (L13). A forced money-path error produces a Sentry event; CI fails on a new lint warning and on ES6 syntax; `pos.js` floor set just below measured. Sequenced last — it protects every earlier fix from regressing.

## v2 Requirements

Deferred audit items — tracked (audit §5 "Backlog"), not in this milestone's roadmap. Promote via `/gsd-review-backlog` when capacity allows. Each carries its audit finding id.

### Money-Path (Medium/Low)
- **BL-M10/M11** amount-drift at kiosk confirm — largely subsumed if MONEY-02 rewrites the sale→confirm handoff.
- **BL-M14** collect-flow webhook double-record on redelivery — pairs with webhook replay dedup (L5).
- **BL-M22** dual-cart overcharge — durable manual-review record on void-skip; best done with OBS-01.
- **BL-M16** stale file-cache pricing during a Redis outage.
- **BL-L18** reCAPTCHA-rejection void bypasses the hardened primitive — folds in once H5 lands.
- **BL-L8/L11/L17/L20** refund cap/idempotency; `markTxnUsed` swallows Redis errors; reconcile robustness.

### Security / Privacy (Low)
- **BL-L19** `GET /product-requests` PII guard → `apiKeyGuard.matches`.
- **BL-L5/L6** webhook timestamp/event-id replay dedup; `REDIS_ENCRYPTION_KEY` live check (#106).
- **BL-L7/L9/L10** raw error-detail leakage; promo enumeration oracle; gift-card over-disclosure.

### Health / DX / Drift
- **BL-M19/M21** admin GP diagnostic bug (`/api/pos/status` → `HELCIM_*`); no global Express error handler.
- **BL-L3/L4/L16** dead deps/dirs (`globalpayments-api`, `client/`); doc drift (`README`/`ARCHITECTURE.md`/`CLAUDE.md`).
- **BL-L14/L15** `escapeHTML` dedup across standalone bundles; duplicate diverged page pairs.
- **BL-MAP** `.planning/codebase/` map refresh — stale since ~2026-04-27, line counts off 45–128% (audit §6).

## Out of Scope

| Item | Reason |
|------|--------|
| New tender types / gift-card features | v4.5 is hardening only; new capability is a future milestone |
| Full frontend correctness pass (`admin.js`/`kiosk.js`/`brewpad.js` line-by-line) | Audit sampled these; a dedicated pass is its own milestone (audit Appendix) |
| Framework migration / `window.SV` namespace / `processCheckout()` decomposition | Larger refactors; deferred to a code-structure milestone |
| Major dependency upgrades (express 5, redis 6, jest 30, sharp 0.35) | Modernization, not remediation (audit §3.6) |
| Enable Redis AOF (#96) | Railway dashboard toggle, not a code change |

## Traceability

Phases risk-ordered: containment (SEC) → de-fork backbone → correctness (MONEY) → fail-closed sweep (RESIL) → signal (OBS). Finalized by the roadmapper.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 47 | ✅ Complete (2026-07-24) — staging verified 2026-07-03; prod 404s verified live 2026-07-24 (rode prod-2026071x deploys) |
| SEC-02 | Phase 46 | ✅ Complete (2026-07-08) — cutover done, leaked key rotated dead (403) |
| KIOSK-01 | Phase 48 | ✅ Complete (2026-07-10) — de-fork verified (standalone UAT live), 22/22 threats secured; admin-surface UAT owner-waived w/ automated parity coverage |
| MONEY-01 | Phase 49 | Pending |
| MONEY-02 | Phase 50 | Pending (depends on KIOSK-01) |
| MONEY-03 | Phase 51 | Partial — Phase 51 complete for criteria 1/2/6/7 (atomicity core), live-verified 2026-09-02 on Apps Script Version 51. Criteria 3 (M9), 4 (M18) deferred to a follow-up phase; criterion 5 (M15) moved out entirely. Not closeable until those land. |
| RESIL-01 | Phase 52 | Complete |
| OBS-01 | Phase 53 | Complete |
| ANALYTICS-01 | Phase 55 | Pending (code written, uncommitted — review-and-ship) |
| ANALYTICS-02 | Phase 56 | Pending (GTM/Ads config, mostly non-code) |

**Coverage:**
- v1 requirements: 8 total
- Mapped to phases: 8 (one requirement per phase, no duplicates) ✓
- Unmapped: 0 ✓

---

## v4.6 Requirements (Analytics & Conversion Tracking)

**Defined:** 2026-07-10. **Source:** `Claude-Code-Prompt-Ecommerce-Tracking.md` + `Steins-and-Vines-GA4-Purchase-Tracking-Plan.md` (Google Drive Reports). GA4 `G-WDYSXCM703`, GTM `GTM-NHRCGLC5`, Google Ads `AW-18091171314`. Unlike v4.5 (hardening), this milestone adds measurement — but the site code is analytics-only and must never alter the payment/charge/cart path.

- [ ] **ANALYTICS-01** (Phase 55): The custom cart/checkout pushes GA4-schema `add_to_cart`, `begin_checkout`, and `purchase` events into the `dataLayer`. `purchase` fires only on confirmed Helcim success (single + dual-cart paths), exactly once per order (dedup by `transaction_id`), before cart/idempotency state is cleared; analytics is wrapped so it can never throw into checkout. Shipped from the pre-written uncommitted implementation after review + green gates + a staging GA4 DebugView UAT; no payment/charge/cart logic altered. Includes the `products.html` GTM-snippet fix (live untagged page).
- [ ] **ANALYTICS-02** (Phase 56): The GTM container sends those events to GA4 (3 event tags + triggers + DLV variables) and the flagged container-quality/Ads gaps are closed — Conversion Linker on All Pages, a Google tag for Ads `AW-18091171314`, `purchase` marked a GA4 key event, a 2nd GTM admin, and a conscious Metricool-tag decision at publish respecting the RUNBOOK Stage-3 CSP↔GTM ordering. Mostly human-action in the GTM/GA4 UI.

## v4.7 Requirements (Post-Review Polish & Trust)

**Defined:** 2026-07-15. **Source:** external website review `steinsandvines-website-review-2026-07-14.md` (Google Drive Reports) + owner-reported recurring kiosk sale-blocker (2026-07-14). Ordered by business impact. Three items (cart pre-populate, Open/Closed, overdue-count mismatch) are VERIFY-then-fix — the reviewer was a first-time visitor and each may be session state / correct behaviour / different scopes rather than a bug; a phase must confirm the defect is real before changing code.

- [ ] **REVIEW-01** (Phase 57): A kiosk sale can be started without a manual page refresh, even after the iPad wakes from sleep — the recurring "hit refresh to sell" failure is diagnosed from a REAL captured occurrence (not inferred) and fixed at its actual cause. Precondition: frontend error capture exists so the failure is no longer lost when staff tap Retry. Verified on the live iPad.
- [ ] **REVIEW-02** (Phase 58): Admin Kit Inventory shows no malformed/negative/unrounded prices (the `$-68.949…` class is traced to its source and corrected), and the header Open/Closed indicator provably matches the real posted hours in the correct timezone.
- [ ] **REVIEW-03** (Phase 59): Home/About/Contact have no empty gap above the footer; a first-time visitor's cart is never pre-populated and stays in sync across every page (after confirming whether the observed mystery item was a real bug or session state); the "Our Story" image and mobile framed images reliably render (no blank bordered boxes).
- [ ] **REVIEW-04** (Phase 60): The Kit Inventory table is free of blank/orphan/all-zero rows, the "kits low stock" alert reflects only real kits, and the overdue-task counts across Dashboard/Tasks/Admin either reconcile or are precisely labelled by scope.
- [ ] **REVIEW-05** (Phase 61): First contentful paint is materially faster (font loading no longer render-blocking), meaningful homepage images carry descriptive alt text, and the flagged UI-polish items (Ingredients filter-bar placement, Instagram loading state, testimonials, kiosk token helper text, BrewPad/Admin session decision) are addressed.

## v4.8 Requirements (BrewPad Bookkeeping & Inventory Integrity)

**Defined:** 2026-07-24. **Source:** bookkeeping/batch-linking session feedback log (`/Users/koa/dev/banking/Steins-and-Vines-Bookkeeping/feedback-log.md`), code-verified against pos.js / brewpad.js / recipes.js. Recommended execution order 64 → 62 → 63 → 65 → 66. Cross-repo: OPS-01/02/04 include Google Apps Script work (sheet columns + handlers) tracked inside their phases. **Constraint (owner decision 2026-07-24):** negative Zoho stock is an intentional manual oversell override — no requirement here may clamp negative on-hand or auto-hide storefront items at ≤0.

- [ ] **OPS-01** (Phase 62, feedback #17 PRIORITY): Brewing a BrewPad batch decrements Zoho ingredient stock (stock adjustment or $0 internal-consumption transaction, × scale_factor), idempotent per batch_id, leaving intentional negative-stock overrides untouched — ending the overstated-stock → oversell → refund failure mode (SafLager). Verified against a real batch.
- [ ] **OPS-02** (Phase 63, feedback #4/#8/#11/#13/#14): Unlinkable batches carry a structured `no_invoice_reason`; batch↔invoice matching keys on customer_id with names validated against Zoho contacts; household purchases match via linked-contacts or kit+date fallback. The "unlinked" list shows only genuine failures.
- [ ] **OPS-03** (Phase 64, feedback #3/#7/#10): `search-invoices` returns real line items (detail-fetch); batch delete clears/re-syncs the invoice's stale `cf_batch_status`; the admin GET Google OAuth token moves out of the URL query string. Safe in-repo quick wins — execute first.
- [ ] **OPS-04** (Phase 65, feedback #5/#6/#12/#20): Bulk admin operations pre-flight-check the session token and staff sessions outlive a working day's task (or refresh transparently); a `bulk_update_batches` Apps Script action makes backfills fast; `scan-invoices` gains a configurable/backfill window so pre-30-day batches can auto-link.
- [ ] **OPS-05** (Phase 66, feedback #15/#16): Recipes carry a structured brewing schedule (or BeerXML import fills one automatically) instead of free-text notes; hop item units are normalized so recipe quantities are unambiguous.

---
*Requirements defined: 2026-07-03 (v4.5); 2026-07-10 (v4.6 analytics); 2026-07-15 (v4.7 post-review polish); 2026-07-24 (v4.8 bookkeeping & inventory integrity)*
*Last updated: 2026-07-24 — added v4.8 BrewPad Bookkeeping & Inventory Integrity (OPS-01..05).*

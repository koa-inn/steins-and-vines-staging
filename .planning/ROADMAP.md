# Roadmap: Steins & Vines

## Milestones

- ✅ **v1.0 Kiosk Production Readiness** — Phases 1-4 (shipped 2026-04-28)
- ✅ **v1.1 Brewpad Reliability & Integration** — Phases 5-11 (shipped 2026-05-06)
- ✅ **v2.0 Recipe-Based Products** — Phases 12-19 (shipped 2026-05-27)
- ✅ **v3.0 Catalog Subpages** — Phases 20-24 (shipped 2026-06-03)
- ✅ **v4.0 Booking Migration (Cal.com) + Edge Protection** — Phases 25-26 (completed 2026-06-06)
- ✅ **v4.1 BrewPad Batch Lifecycle & Zoho Sync** — Phases 27-30 (shipped 2026-06-17)
- ✅ **v4.2 Payment Path Hardening & Deploy Safety** — Phases 31-33 (shipped 2026-06-19)
- 🚧 **v4.3 Recipe Builder Refinement** — Phases 34-37 (in progress)
- 🚧 **v4.4 Audit Remediation** — Phases 38-42 (in progress)
- 🚧 **v4.5 Security & Money-Path Closeout** — Phases 46-53 (in progress)
- 🚧 **v4.6 Analytics & Conversion Tracking** — Phases 55-56 (in progress)
- 🚧 **v4.7 Post-Review Polish & Trust** — Phases 57-61 (in progress)
- 📝 **v4.8 BrewPad Bookkeeping & Inventory Integrity** — Phases 62-66 (planned)

## Phases

<details>
<summary>✅ v1.0 Kiosk Production Readiness (Phases 1-4) — SHIPPED 2026-04-28</summary>

- [x] Phase 1: Catalog & Stock Display (3/3 plans)
- [x] Phase 2: Sales Order Integrity (2/2 plans)
- [x] Phase 3: Resilience & Session Stability (1/1 plans)
- [x] Phase 4: Sales Order Management (2/2 plans)

</details>

<details>
<summary>✅ v1.1 Brewpad Reliability & Integration (Phases 5-11) — SHIPPED 2026-05-06</summary>

- [x] Phase 5: Auth Reliability (2/2 plans)
- [x] Phase 6: Kiosk-to-Brewpad Integration (3/3 plans)
- [x] Phase 7: Zoho Audit Trail (3/3 plans)
- [x] Phase 8: First-Batch Promo (6/6 plans)
- [x] Phase 9: Content & SEO Push (3/3 plans)
- [x] Phase 10: Checkout Payment Safety (4/4 plans)
- [x] Phase 11: Producer & Brand Visibility (3/3 plans)

</details>

<details>
<summary>✅ v2.0 Recipe-Based Products (Phases 12-19) — SHIPPED 2026-05-27</summary>

- [x] Phase 12: Recipe Data Foundation (2/2 plans) — completed 2026-05-16
- [x] Phase 13: Middleware API + Admin Recipe Management (4/4 plans) — completed 2026-05-17
- [x] Phase 14: Kiosk Recipe Sales, Inventory, and Batch Creation (5/5 plans) — completed 2026-05-17
- [x] Phase 15: BeerXML Import (2/2 plans) — completed 2026-05-17
- [x] Phase 16: Recipe Management — BrewPad, Kiosk & Batch Integration (3/3 plans) — completed 2026-05-18
- [x] Phase 17: Custom Labels Page (3/3 plans) — completed 2026-05-18
- [x] Phase 18: Custom Labels Iteration (3/3 plans) — completed 2026-05-19
- [x] Phase 19: Hop Inventory Catalog (3/3 plans) — completed 2026-05-19

</details>

### ✅ v3.0 Catalog Subpages (Shipped 2026-06-03)

**Milestone Goal:** Break the monolithic ingredients page into dedicated category subpages with shared template, cross-category navigation, and unified search.

- [x] **Phase 20: Zoho Data Foundation** - Tag all ingredient items with subcategory; refresh snapshot pipeline
- [x] **Phase 21: Shared Template & Build Infrastructure** - Shared JS module, CSS, and build pipeline for all subpages (completed 2026-05-29)
- [x] **Phase 22: Category Subpages & Navigation** - All 5 subpages live with sub-nav and main nav dropdown (completed 2026-05-29)
- [x] **Phase 23: Cross-Category Search** - Search overlay with grouped results and deep-link navigation (completed 2026-05-30)
- [x] **Phase 24: SEO & Staging Deploy** - Per-subpage SEO meta, QA pass, and staging deployment (completed 2026-06-03)

### ✅ v4.1 BrewPad Batch Lifecycle & Zoho Sync (Shipped 2026-06-17)

**Milestone Goal:** Staff can activate pending batches from the admin batch list and pull customer info back from Zoho onto BrewPad — closing the two open gaps in the batch workflow.

- [x] **Phase 27: Pending Batch Visibility & Activation** - Surface pending batches in the admin list/filter and add one-click + guided activation (BATCH-01..03) (3 plans executed 2026-06-07; gap-closure plan 27-04 created to close CR-01 blocker + WR-01 warning) (completed 2026-06-08)
- [x] **Phase 28: Zoho Customer Read-Back Path** - New middleware endpoint to fetch customer details by SO/invoice number, plus Apps Script write-back of refreshed fields (ZSYNC foundation) (completed 2026-06-12)
- [x] **Phase 29: Refresh-from-Zoho Admin UI** - "Refresh from Zoho" button in the batch detail modal that updates customer name/email/contact, gated on `zoho_so_number` (ZSYNC-01..02) (completed 2026-06-12)

### ✅ v4.2 Payment Path Hardening & Deploy Safety (Shipped 2026-06-19)

**Milestone Goal:** Make the money path trustworthy — test the online checkout, close the fail-open security gaps, and stop unsafe/untested code from reaching production. **Audit: 14/14 requirements, 18/18 integration seams, 4/4 flows (DEPLOY-03 cross-phase blocker fixed 2026-06-19). See `milestones/v4.2-MILESTONE-AUDIT.md`.**

- [x] **Phase 31: Money-Path Test Coverage** - Route-level checkout tests, Helcim HMAC tests, honest coverage config (TEST-01..03) (completed 2026-06-17)
- [x] **Phase 32: Fail-Closed Hardening & Access Control** - reCAPTCHA/webhook fail-closed, replay-guard 409, validateEnv update, PII route API-key enforcement, body-shape validation (HARDEN-01..04, PII-01..02) (completed 2026-06-18)
- [x] **Phase 33: Deploy Safety & Monitoring** - Test-gated CI deploys, prod deploy tagging + rollback runbook, snapshot fix, uptime monitoring, secrets verification (DEPLOY-01..03, MONITOR-01..02) (completed 2026-06-18)

### 🚧 v4.3 Recipe Builder Refinement (In Progress)

**Milestone Goal:** Make recipes scalable and adjustable at the point of selection across admin, kiosk, and BrewPad — and make the recipe builder/manager available in BrewPad — without weakening the server-authoritative money path hardened in v4.2.

- [x] **Phase 34: Ingredient Display & Server Enrichment** - Enrich recipe ingredient data server-side with `cf_type`; group ingredients by type in admin, kiosk, and BrewPad views (RDISP-01, RDISP-02, RDISP-03) (completed 2026-06-20)
- [x] **Phase 35: Batch Scaling Engine** - Staff can enter a target batch volume; the system scales ingredient quantities (linear for weight, round-up for pcs), prices scaled recipes server-authoritatively, and captures scaled quantities in the Zoho invoice and frozen `recipe_snapshot` (SCALE-01, SCALE-02, SCALE-03, SCALE-04, SCALE-05) (completed 2026-06-21)
- [x] **Phase 36: Cross-Surface Selection & Recipe Modification** - Batch size control available on all recipe-selection surfaces; staff can add/remove/substitute ingredients for a one-off sale without touching the saved recipe, with optional save-as-new (SEL-01, SEL-02, MOD-01, MOD-02, MOD-03) (completed 2026-06-24)
- [x] **Phase 37: BrewPad Recipe Manager** - Staff can browse, view, create, and edit recipes from within BrewPad, reusing existing recipe CRUD endpoints and activation guardrails (BPR-01, BPR-02) (completed 2026-06-20)

### 🚧 v4.4 Audit Remediation (In Progress)

**Milestone Goal:** Close out the remaining open/partial HIGH-priority items from `PROJECT_ASSESSMENT.md` — gitignore/strip `.planning/`, fix the nightly snapshot publish, optimize facility imagery, fix the duplicate-cart bug, and de-fork the kiosk POS — risk-ordered (low-risk infra first, money-path refactor last) without weakening the v4.2-hardened money path. Continues phase numbering from Phase 38.

- [~] **Phase 38: Repo Hygiene & Deploy-Strip Confirmation** — DEFERRED 2026-06-26 (owner). Investigation: prod already strips `.planning` (safe); staging exposes it (legacy deploy-from-branch); gitignoring would break GSD's git-tracked state (D-01). Low severity (staging noindex; `PROJECT_ASSESSMENT.md` already gitignored → 404). Content-safe fix (switch staging to workflow-based Pages w/ strip) deferred by owner. (HYGIENE-01)
- [x] **Phase 39: Nightly Snapshot Publishes to Prod Fallback** — DONE 2026-06-26 (`303a060`): dropped `[skip ci]` from the PROD snapshot commit so `deploy-production.yml` republishes Pages (was stale); staging keeps it (legacy deploy-from-branch serves directly); prod commit already builds on prod main (FF, CNAME-safe). Verify on next nightly run / manual dispatch. (DEPLOY-04)
- [x] **Phase 40: Facility Image Optimization (webp + srcset)** — DONE 2026-06-26 (`17f9995`): extended optimize-images.js to facility photos; 4 referenced images → webp 800w/1600w + 1600w jpg fallback via `<picture>`; originals removed. Homepage interior 5.7MB→87KB. (ASSET-01)
- [x] **Phase 41: SKU-Keyed Cart Identity** — DONE 2026-06-26 (`b2fdac1`): centralized `getProductKey()` (SKU primary, name|brand fallback) across 11-cart, 06/07/08/15/16/17 + 12-checkout comparisons; same product from catalog + search overlay now merges to one line; +4 regression tests; 928 FE tests green. (CART-01)
- [ ] **Phase 42: Kiosk POS De-Fork (kiosk-core.js)** - shared `js/kiosk-core.js`, behaviour-preserving, parity-tested, discount on both surfaces (KIOSK-01) → rehomed to v4.5 Phase 48 (KIOSK-01)

### 🚧 v4.5 Security & Money-Path Closeout (In Progress)

**Milestone Goal:** Close the deferred CRITICAL and the verified High/Medium security + money-path defects from the 2026-07-02 whole-repo audit (`.planning/reports/AUDIT.md`) — and cure the root cause (the kiosk is a second-class re-implementation of the online-checkout money path) via the KIOSK-01 de-fork plus full synchronous adoption of `lib/money-path.js` primitives across `pos.js`/`pos-recipe.js` — without weakening the gold-standard online checkout. Additive setup: continues phase numbering from Phase 46; nothing archived or renumbered ≤ 46.

- [x] **Phase 46: Auth Re-Architecture** — carried over as v4.5 SEC-02 (existing phase, not re-planned); ✅ COMPLETE 2026-07-08 — owner cutover done, all 3 surfaces verified, `API_SECRET_KEY` rotated → leaked key dead (403). Closes SEC-02.
- [x] **Phase 47: Purge Publicly-Served Internal Docs** - untrack `.planning/`/audit docs from staging+prod, reconcile `.nojekyll` vs `_config.yml` exclude (SEC-01) (completed 2026-07-24 — staging verified 2026-07-03, prod verified live 2026-07-24; see 47/VERIFICATION.md)
- [x] **Phase 48: Kiosk POS De-Fork (kiosk-core.js)** - shared `js/kiosk-core.js`, behaviour-preserving, parity-tested, discount on both surfaces (KIOSK-01) — rehomed from v4.4 Phase 42 (completed 2026-07-10: 5/6 plans + human UAT gate satisfied + 22/22 threats secured)
- [ ] **Phase 49: Online Captured-Amount Verification** - assert captured card amount ≥ recorded/invoiced total before booking; void + reject on mismatch (MONEY-01)
- [ ] **Phase 50: Kiosk Money-Path Defect Closeout** - reconcile TTL/lock-release/void-status/salesorder-pay/sweep fixes, `pos-recipe.js` adopts money-path primitives (MONEY-02)
- [x] **Phase 51: Gift-Card Ledger Integrity** - idempotent reload, durable needs_manual_review, cell sanitizer, header-mapped issueGiftCard, tax parity (MONEY-03) — completed 2026-09-02 for the phase's owner-narrowed scope only (criteria 1/2/6/7, the atomicity core); live-verified on Apps Script Version 51. **MONEY-03 itself is NOT fully closed** — criteria 3 (M9 sanitizer), 4 (M18 bounds-checking) and 5 (M15 tax parity, moved out entirely) remain, see `51-03-SUMMARY.md`.
- [x] **Phase 52: Fail-Closed Sweep** - shared closed-on-Redis-error helper across remaining money/security call-sites (RESIL-01) (completed 2026-07-03)
- [x] **Phase 53: Money-Path Observability & CI Gates** - Sentry on every money-path catch, `npm ci` + Node pin, `--max-warnings 0` + ES5 lint rule, pos.js coverage floor (OBS-01) (completed 2026-07-03)
- [x] **Phase 54: Gift-Card Management on the Kiosk Surface** - lookup + void on the staff-only kiosk page; add `gift-card/void` to the kiosk device-token scope (owner decision D-54-GC, supersedes D-46-02/T-46-07); kiosk-native `kgcm-*` panel in `kiosk-core.js`. Depends on Phase 48; land before the 48 iPad UAT. (completed 2026-07-08)

### 🚧 v4.6 Analytics & Conversion Tracking (In Progress)

**Milestone Goal:** GA4 finally receives ecommerce data from the custom cart/checkout so online revenue and the shopping funnel are measurable, and the flagged GTM/Google-Ads container-quality gaps are closed. Source briefs: `Claude-Code-Prompt-Ecommerce-Tracking.md` (review-and-ship) + `Steins-and-Vines-GA4-Purchase-Tracking-Plan.md` (GTM plan), both in the Google Drive Reports folder. GA4 `G-WDYSXCM703`, GTM `GTM-NHRCGLC5`, Google Ads `AW-18091171314`. Additive: continues phase numbering from Phase 55; nothing renumbered.

- [ ] **Phase 55: GA4 Ecommerce Events (code review + ship)** — review the ALREADY-WRITTEN, uncommitted `dataLayer` ecommerce events (`add_to_cart`, `begin_checkout`, `purchase` — dedup by `transaction_id`, analytics can never throw into checkout) + the `products.html` GTM-snippet fix; re-run gates; commit; ship staging → prod after GA4 DebugView UAT. Do NOT re-implement. (ANALYTICS-01)
- [ ] **Phase 56: GTM Container Quality & Ads Measurement (config, mostly non-code)** — create the 3 GA4 event tags + triggers + DLV variables, add the Conversion Linker tag (All Pages), add the Google tag for Ads `AW-18091171314`, mark `purchase` a GA4 key event, add a 2nd GTM admin, and decide the pending Metricool tag at publish. Coordinated with the RUNBOOK Stage-3 CSP↔GTM ordering. (ANALYTICS-02)

### 🚧 v4.7 Post-Review Polish & Trust (In Progress)

**Milestone Goal:** Close the concrete defects and trust gaps surfaced by the external website review (`steinsandvines-website-review-2026-07-14.md`, Google Drive Reports folder) PLUS the recurring kiosk sale-blocker the owner re-reported 2026-07-14. Ordered by business impact: a revenue-blocking kiosk bug and money/data-integrity issues first, then public-site credibility, then admin data hygiene, then refinement. Additive: continues phase numbering from Phase 56; nothing renumbered. Sequencing note — Phase 57 is a debug cycle (instrument → diagnose → fix → live-verify), not a normal up-front-plannable fix.

- [ ] **Phase 57: Kiosk Sale-Blocking Recovery** — the kiosk still needs a manual refresh before a sale will work (recurred 2026-07-14; fix `7cbf856` was inferred, never reproduced). ROOT BLOCKER: no frontend error capture exists, so the real error vanishes when staff tap Retry. Instrument first (client-error beacon → middleware/Sentry), diagnose the real cause from a captured occurrence, then fix. Verify on the live iPad, not a green suite. Brief: `.planning/todos/pending/kiosk-sale-requires-refresh-recurring.md`. (REVIEW-01)
- [x] **Phase 58: Revenue & Operations Integrity** — (a) malformed negative price `$-68.949…` in admin Kit Inventory — validate the cost/margin math + rounding; (b) verify the header Open/Closed indicator against real posted hours + timezone (a false "Closed" costs walk-ins/calls). Both are verify-then-fix; small blast radius but they gate money and foot traffic. (REVIEW-02)
- [x] **Phase 59: Public-Site Trust Polish** — (a) the empty gap above the footer on Home/About/Contact (reviewer's #1 — "reads as broken"; likely a min-height/empty-container CSS issue); (b) cart shows a mystery item ("Belgian Candi Syrup") for a first-time visitor / inconsistent across pages — VERIFY it's a real pre-populate bug vs session leftover, then fix so a new visitor never sees a pre-filled cart and state stays in sync; (c) missing "Our Story" image + framed images rendering blank on mobile (lazy-load not firing). Public-facing credibility. (REVIEW-03)
- [ ] **Phase 60: Admin Data Hygiene** — (a) ~9 blank-name + ~26 all-zero orphan rows in Kit Inventory clutter the table and inflate the "123 kits low stock" alert; trace to the sync/import creating empty records and clean up; (b) reconcile or precisely label the overdue-count mismatch (Dashboard 24 vs Tasks tab 45 — likely different task scopes). Makes the dashboard alert numbers trustworthy. Internal-only. (REVIEW-04)
- [ ] **Phase 61: Site Refinement** — slow first contentful paint (~4.5s; render-blocking fonts → `font-display: swap` + preload + self-host), alt text on ~9 meaningful homepage images (a11y + image SEO), Ingredients filter-bar overlapping the hero band, blank Instagram tiles until lazy-load, add testimonials/Google-reviews snippet, kiosk device-token helper text, and decide whether BrewPad + Admin should share a sign-in. Polish on an already-solid site. (REVIEW-05)

### 📝 v4.8 BrewPad Bookkeeping & Inventory Integrity (Planned)

**Milestone Goal:** Close the operational-integrity gaps surfaced by the 2026-07 bookkeeping/batch-linking session (feedback log: `/Users/koa/dev/banking/Steins-and-Vines-Bookkeeping/feedback-log.md`): in-house brews finally draw down real Zoho ingredient stock (root cause of the SafLager overstated-stock → oversell → refund), unlinked batches become explainable instead of mysterious, the linking tools show real data, long staff bulk-admin sessions stop silently dropping writes, and recipes carry structured brewing data. Additive: continues phase numbering from Phase 61; nothing renumbered. Recommended execution order: **64 → 62 → 63 → 65 → 66** (safe in-repo correctness wins first, then the money-adjacent drift fix, then data model, tooling, polish). Cross-repo note: Phases 62/63/65 touch the Google Apps Script backend (Batches-sheet columns + `createBatch`/`update_batch` handlers + `allowedFields`) alongside this repo — the Apps Script work is tracked explicitly inside each phase, mirroring the bottling-invite pattern. **Owner decision 2026-07-24: negative Zoho stock is an INTENTIONAL manual oversell override** (sell ahead of receipt) — no phase may clamp/"fix" negative on-hand or auto-hide storefront items at ≤0.

- [ ] **Phase 62: Inventory Consumption Sync** — brewing a BrewPad batch posts a Zoho stock adjustment for the recipe's ingredients × scale_factor (mirroring what a recipe-sale invoice already does), idempotent per batch_id so re-saves never double-decrement; intentional negative stock untouched. Fixes the drift that caused the SafLager oversell → refund (feedback #17, PRIORITY). Cross-repo: Apps Script createBatch + middleware. (OPS-01)
- [ ] **Phase 63: Batch↔Invoice Reconciliation Model** — structured `no_invoice_reason` on batches (pre-Zoho / cash / legacy Global Payments / comped) so the ~40-54 legitimately-unlinkable batches stop reading as failures; matching keys on customer_id with names validated against Zoho contacts; household/linked-contact (or kit+date) fallback for cases like Witwitki-invoice → Webb-batches (feedback #4, #8, #11, #13, #14). Cross-repo: Apps Script + sheet columns. (OPS-02)
- [x] **Phase 64: Linking & Search Correctness** — safe in-repo quick wins, execute first: `search-invoices` detail-fetches so `line_items` are real (list endpoint never returns them — pos.js:2279; pattern exists at pos.js:3112); batch delete clears/re-syncs the invoice's stale `cf_batch_status` (INV-000151 class); `adminApiGet` stops putting the Google OAuth token in the URL query string (adminApiPost body precedent — brewpad.js:1285) (feedback #3, #7, #10). (OPS-03) (completed 2026-07-25)
- [ ] **Phase 65: Staff Tooling Reliability & Backfill** — pre-flight token check before bulk operations + longer-lived/refreshing staff sessions (builds on the shipped x-session-token auth; 4 expiries in one admin day, one silently dropped a batch of writes); `bulk_update_batches` Apps Script action (72 batches took ~6 min at ~4-5s/call); configurable / one-time-backfill `scan-invoices` window so pre-30-day batches can auto-link (feedback #5, #6, #12, #20). (OPS-04)
- [ ] **Phase 66: Recipe Data Quality** — lowest priority: structured brewing-schedule fields (hop timing, mash steps — *fermentation time split out to Phase 81*) extending the Phase 15 BeerXML import instead of cramming into free-text notes; normalize hop item units (pcs/g/kg drift across the same product family, e.g. Citra-100g "pcs" vs Mosaic-100g "g") (feedback #15, #16). (OPS-05)

### 📋 Backlog — captured, not yet scheduled

- **Kiosk manual card entry / MOTO** (owner request, 2026-07-14) — take a card payment when the customer is not present (phone orders). Every kiosk tender path today assumes a card-present tap on the terminal. Full brief: `.planning/todos/pending/kiosk-manual-card-entry-moto.md`.
  - ⚠️ **PCI:** must NOT build a card form in `kiosk-core.js` — collecting a raw PAN drags the kiosk + middleware into PCI-DSS scope. Use the terminal's own manual-entry mode (check this first — likely zero code) or the existing HelcimPay hosted iframe, so the PAN never touches our code.
  - **Depends on Phase 50.** A MOTO path must ADOPT the money-path primitives (idempotency lock, captured-amount verification, single void path), not become a fourth divergent payment flow — which is precisely the "two-tier money path maturity" failure the audit named as its #1 systemic theme.
  - Business: MOTO may need enabling on the Helcim account, costs more per transaction, and **shifts chargeback liability to the merchant** (no EMV protection). Owner decision, not a technical one.

## Phase Details

### Phase 20: Zoho Data Foundation

**Goal**: All ingredient items carry accurate subcategory data so the frontend can filter correctly
**Depends on**: Nothing (first phase of this milestone)
**Requirements**: DATA-01, DATA-02
**Success Criteria** (what must be TRUE):

  1. Every ingredient item in Zoho Inventory has its Subcategory custom field set to one of: Grain, Yeast, Additive, Packaging, Equipment, Hops, or uncategorized
  2. The nightly snapshot JSON file includes the subcategory field for each ingredient item
  3. Client-side filtering by subcategory value returns the correct items on a local test page

**Plans**: 2 plans
Plans:
**Wave 1**

- [x] 20-01-PLAN.md — Create bulk tagging script and coverage verification script

**Wave 2**

- [x] 20-02-PLAN.md — Execute tagging workflow and verify 100% coverage

### Phase 21: Shared Template & Build Infrastructure

**Goal**: A single reusable JS module and CSS file can render any category subpage from a per-page config object, and the build pipeline handles all new files
**Depends on**: Phase 20
**Requirements**: TPL-01, TPL-02, TPL-03, TPL-04, BUILD-01
**Success Criteria** (what must be TRUE):

  1. A test HTML page using `16-catalog-subpage.js` with a minimal config renders a product grid from the ingredients API filtered to a single subcategory
  2. Users can switch between grid and list view on the test page
  3. Out-of-stock items display a visible indicator; a category with no items displays a friendly empty-state message
  4. Each subpage's hero section displays the category name with a distinct accent color
  5. `npm run build` completes without errors and produces stamped, minified output for all new CSS and JS files

**Plans**: 2 plans
Plans:
**Wave 1**

- [x] 21-01-PLAN.md — Create 16-catalog-subpage.js standalone module and catalog-subpage.css stylesheet

**Wave 2**

- [x] 21-02-PLAN.md — Test HTML page, unit tests, and build pipeline integration

### Phase 22: Category Subpages & Navigation

**Goal**: Customers can navigate directly to any ingredient category subpage from anywhere on the site, and all 5 category pages are live
**Depends on**: Phase 21
**Requirements**: CAT-01, CAT-02, CAT-03, CAT-04, CAT-05, NAV-01, NAV-02, NAV-03
**Success Criteria** (what must be TRUE):

  1. Each of the 5 subpages (Grains, Yeast, Additives, Packaging, Equipment) loads and shows only its category's items with correct cart controls
  2. A horizontal sub-nav bar appears on every ingredient page showing: All | Hops | Grains | Yeast | Additives | Packaging | Equipment — and the current page's tab is visually highlighted
  3. The main site Products dropdown includes direct links to each ingredient category subpage
  4. Weight-based products on the Grains page offer quantity entry in kg/g as appropriate

**Plans**: 3 plans
Plans:
**Wave 1**

- [x] 22-01-PLAN.md — Sub-nav CSS styles, dropdown divider style, and build pipeline stamp:pages update

**Wave 2** (parallel)

- [x] 22-02-PLAN.md — Create 5 new category subpages, move hops.html, rebuild ingredients-supplies.html
- [x] 22-03-PLAN.md — Update nav dropdown in 9 existing pages and verify navigation end-to-end

### Phase 23: Cross-Category Search

**Goal**: Customers can search across all ingredient categories from a single entry point and jump directly to any matching item
**Depends on**: Phase 22
**Requirements**: SRCH-01, SRCH-02
**Success Criteria** (what must be TRUE):

  1. Triggering the search icon in the sub-nav opens an overlay with a text input; typing at least 2 characters shows results grouped by category
  2. Clicking a search result navigates to that item's category subpage with the item's detail panel already expanded

**Plans**: 2 plans
**UI hint**: yes
Plans:
**Wave 1**

- [x] 23-01-PLAN.md — Create search overlay module, CSS, and fix data-sku gap

**Wave 2**

- [x] 23-02-PLAN.md — Wire overlay into 7 HTML pages, build pipeline, and unit tests

### Phase 24: SEO & Staging Deploy

**Goal**: Each subpage is discoverable by search engines and the full feature set is verified on staging
**Depends on**: Phase 23
**Requirements**: BUILD-02
**Success Criteria** (what must be TRUE):

  1. Each subpage has a unique title tag, meta description, og:title, og:description, canonical URL, and LocalBusiness JSON-LD
  2. sitemap.xml includes entries for all 5 new subpages
  3. All 5 subpages load correctly on staging.steinsandvines.ca with no console errors

**Plans**: 2 plans
Plans:
**Wave 1**

- [x] 24-01-PLAN.md — Add full SEO head (unique title, description, og:*, twitter:card, LocalBusiness JSON-LD) to all 5 category subpages

**Wave 2**

- [x] 24-02-PLAN.md — Build, stamp, push to staging, and QA-verify all 5 subpages load clean on staging.steinsandvines.ca

### Phase 25: Cal.com Booking Migration

**Goal**: Appointment booking runs on Cal.com Cloud (free tier) behind the unchanged `/api/bookings*` middleware contract, supporting multiple appointment types, with customer/staff confirmation emails delivered by Cal.com over HTTPS
**Depends on**: (new milestone v4.0 — no prior phase dependency)
**Requirements**: BOOK-01, BOOK-02, BOOK-03, BOOK-04, BOOK-05
**Success Criteria** (what must be TRUE):

  1. `GET /api/bookings/services`, `GET /api/bookings/availability`, `GET /api/bookings/slots`, and `POST /api/bookings` return the same response shapes as today, now backed by Cal.com (frontend unchanged)
  2. A completed ferment-in-store checkout creates a real Cal.com booking and the customer receives a Cal.com confirmation email (verified end-to-end on staging)
  3. At least one additional appointment type beyond ferment-in-store is bookable through Cal.com
  4. Zoho Bookings code paths (`bookingsGet`/`bookingsPost`, `ZOHO_BOOKINGS_*` env) are removed or disabled with no dead references; offline-fallback behavior preserved
  5. Middleware test suite covers the new Cal.com adapter (request/response mapping, error + offline-fallback paths) and passes; lint clean

**Plans**: 4 plans (3 waves)

- [x] 25-01-PLAN.md — Free-tier risk gate + Cal.com adapter (lib/calcom.js) + env registration
- [x] 25-02-PLAN.md — Rewrite /api/bookings* handlers onto Cal.com, preserving the contract
- [x] 25-03-PLAN.md — POST /api/webhooks/calcom (signature-verified, cache invalidation)
- [x] 25-04-PLAN.md — Staging booking+email verification, additional event type, Zoho removal

### Phase 27: Pending Batch Visibility & Activation

**Goal**: Staff can see and act on pending batches directly from the admin batch list, promoting them to Primary either instantly or through a guided setup
**Depends on**: Nothing new (builds on existing v1.1 batch tracking; backend `updateBatch` already supports the pending→primary transition and stamps `fermentation_started_at`)
**Requirements**: BATCH-01, BATCH-02, BATCH-03
**Success Criteria** (what must be TRUE):

  1. Pending batches appear in the admin batch list (no longer hidden), and the status filter/dropdown includes a "Pending" option that shows only pending batches
  2. A pending batch row/detail shows an "Activate" action that, in one click, flips the batch to Primary with the fermentation start date set to today
  3. A "Schedule & activate" option lets staff pick a fermentation schedule template, start date, and vessel/location, then promotes the batch to Primary in a single confirmed step
  4. After either activation path, the batch immediately reflects Primary status and the chosen start date in the list and detail views without a manual page reload

**Plans**: 4 plans (3 executed + 1 gap closure)
Plans:
**Wave 1**

- [x] 27-01-PLAN.md — Surface pending batches: widen active filter, Pending dropdown option, distinct badge, pin-to-top (BATCH-01)

**Wave 2**

- [x] 27-02-PLAN.md — One-click Activate (inline + detail modal) with no-schedule confirm, flip to Primary start=today, live refresh (BATCH-02)

**Wave 3**

- [x] 27-03-PLAN.md — Guided Schedule & Activate modal + backend chosen-start-date fix; single-step promote with generated tasks (BATCH-03)

**Gap Closure**

- [x] 27-04-PLAN.md — Close WR-01 (one-click activate start_date=today) + CR-01 (guided step1Done partial-failure routing); rebuild min + tests (BATCH-02, BATCH-03)

**UI hint**: yes

### Phase 27.1: Pending batch deletion — delete pending batches from BrewPad with a confirmation step, removing the row via Apps Script instead of manual Google Sheet edits (INSERTED)

**Goal:** Staff can delete pending (duplicate) batches inline from the admin Batches list and the BrewPad "Needs Scheduling" dashboard rows, each behind a confirmation that names the batch (ID + product + customer), removing the row via the existing Apps Script `delete_batch` action instead of editing the Google Sheet by hand. Frontend-only (backend `deleteBatch()` unchanged); UI-gated to pending rows.
**Requirements**: none (driven by CONTEXT decisions D-01..D-12)
**Depends on:** Phase 27
**Plans:** 2/2 plans complete

Plans:

- [x] 27.1-01-PLAN.md — Inline Delete on admin Batches pending rows (showConfirm + delete_batch + list/dashboard refresh)
- [x] 27.1-02-PLAN.md — Inline Delete on BrewPad "Needs Scheduling" rows (showConfirmSheet danger + delete_batch + dashboard refresh; batch-list cards stay delete-free)

**Cross-cutting constraints:**

- D-08: The confirm copy warns generically that any attached tasks/readings/history will be removed
- D-10: The confirm copy frames deletion as irreversible ("This cannot be undone.") with no nightly-backup/recovery mention
- D-06: Backend deleteBatch() stays unchanged — delete_batch is called with only { batch_id }, no status guard or force flag

### Phase 28: Zoho Customer Read-Back Path

**Goal**: BrewPad can read customer details back from Zoho for a linked sales order/invoice and persist the refreshed fields onto the batch record — the net-new read path behind the refresh feature (today Zoho sync is write-only)
**Depends on**: Nothing new (extends existing `zoho-middleware` Zoho integration and `adminApi.gs`)
**Requirements**: (foundation for ZSYNC-01, ZSYNC-02 — no requirement closes here on its own)
**Success Criteria** (what must be TRUE):

  1. A new middleware endpoint, given a Zoho sales-order/invoice number, returns the linked customer's name, email, and contact details (and a clear not-found/no-link response when the SO cannot be resolved)
  2. The endpoint is covered by middleware unit tests for the success, not-found, and Zoho-error paths and passes with lint clean
  3. Apps Script (`adminApi.gs`) exposes an update path that writes refreshed customer name/email/contact back onto an existing batch record by batch ID, leaving other batch fields untouched
  4. Calling the read endpoint and then the Apps Script update for a known linked batch results in the batch record showing the current Zoho customer details (verified on staging)

**Plans**: 2 plans (2 waves)
Plans:
**Wave 1**

- [x] 28-01-PLAN.md — Middleware GET /api/batch/customer-by-number (invoice/SO → customer name/email/phone) + Jest tests (success, not-found, Zoho-error, partial, validation, auth) + lint clean

**Wave 2**

- [x] 28-02-PLAN.md — Extend adminApi.gs updateBatch allowedFields with customer_email/customer_phone; deploy Apps Script; manual staging read–write loop verification

### Phase 29: Refresh-from-Zoho Admin UI

**Goal**: Staff can refresh a batch's customer info from its linked Zoho sales order/invoice with one click in the batch detail modal, with the action clearly disabled when no link exists
**Depends on**: Phase 28 (requires the middleware read-back endpoint and Apps Script write-back)
**Requirements**: ZSYNC-01, ZSYNC-02
**Success Criteria** (what must be TRUE):

  1. The batch detail modal shows a "Refresh from Zoho" button for batches that carry a `zoho_so_number`
  2. Clicking the button pulls the latest customer name, email, and contact from the linked Zoho SO/invoice and updates the batch's displayed customer info without a full page reload
  3. For a batch with no `zoho_so_number`, the refresh action is clearly unavailable (hidden or disabled with an explanatory state) and never triggers an erroring request
  4. The full feature is verified working on staging.steinsandvines.ca with no console errors on iPad Safari

**Plans**: 6 plans (3 original + 3 gap-closure)

Plans:
**Wave 1**

- [x] 29-01-PLAN.md — BrewPad detail pane: Refresh-from-Zoho button, Email/Phone rows, refresh handler
- [x] 29-02-PLAN.md — Admin Batches modal: Zoho Ref row + Refresh button, Email/Phone rows, refresh handler

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 29-03-PLAN.md — Build, full test+lint gate, staging iPad Safari UAT, REQUIREMENTS traceability

**Gap closure** *(verification found 2 Critical + 3 Warning defects — gaps_found)*

- [x] 29-04-PLAN.md — CR-01: align case contract (middleware case-normalization + frontend 400 handling + tests)
- [x] 29-05-PLAN.md — CR-02/WR-01/WR-03/WR-04: visible name refresh (firstname/lastname split), conflict detection, entity rendering, trim parity
- [x] 29-06-PLAN.md — Rebuild artifacts, full frontend+middleware+lint gate, staging iPad Safari re-verify

**Cross-cutting constraints:**

- D-10, D-11: Refresh outcomes surface as distinct toasts per endpoint state (success / no-change / partial / not-found / zoho-error); voided or deleted documents warn but still apply

**UI hint**: yes

## Phase Details (v4.2)

### Phase 31: Money-Path Test Coverage

**Goal**: The online checkout and Helcim integration are covered by honest, executable tests — so behavior-changing hardening in Phase 32 lands on a safety net, not on faith
**Depends on**: Nothing (first phase of v4.2; builds on existing test infrastructure)
**Requirements**: TEST-01, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):

  1. Running `cd zoho-middleware && npm test` executes route-level tests for `POST /api/checkout` covering: a successful charge→Zoho-order path, void recovery when Zoho fails after charge, void-failure alert emission, and dual-cart shared-charge reversal
  2. The Helcim client and HMAC webhook verification have passing tests covering: valid signature accepted, tampered-body rejected, missing-secret behavior (fails closed, not open), and base64 key decoding correctness
  3. Running `cd zoho-middleware && npm run test:coverage` reports coverage numbers that include `routes/**` files (no route file silently excluded from the report)
  4. Stale exclusions in `jest.config.js` (e.g. `!lib/mailer.js` where mailer is no longer untested) are removed so the coverage number is honest

**Plans**: 4 plans (3 waves)
Plans:
**Wave 1**

- [x] 31-01-PLAN.md — server.js export refactor (importable app, guarded listen) + supertest dev dep + jest.config routes coverage glob (TEST-03 foundation)

**Wave 2** (parallel)

- [x] 31-02-PLAN.md — supertest route tests for POST /api/checkout: success→Zoho order, void recovery, void-failure alert, dual-cart reversal + HARDEN-01/03 test.todo (TEST-01)
- [x] 31-03-PLAN.md — Helcim HMAC tests: verifyWebhookSignature unit (valid/tampered/missing-secret/base64) + POST /api/webhooks/terminal route tests + HARDEN-02 test.todo (TEST-02)

**Wave 3**

- [x] 31-04-PLAN.md — Measure honest coverage; set global threshold below actual + per-file money-path floors (checkout/payments/webhooks/helcim) (TEST-03)

### Phase 32: Fail-Closed Hardening & Access Control

**Goal**: Every security gap on the money path that currently fails open now fails closed — unauthenticated checkout attempts, unsigned webhook events, duplicate charges when Redis is down, and PII exposure via unauthenticated GET routes are all rejected
**Depends on**: Phase 31 (tests must cover the behaviors being changed)
**Requirements**: HARDEN-01, HARDEN-02, HARDEN-03, HARDEN-04, PII-01, PII-02
**Success Criteria** (what must be TRUE):

  1. Sending `POST /api/checkout` in production without a valid reCAPTCHA token (or with `RECAPTCHA_SECRET_KEY` unset) returns a 4xx rejection — the request never reaches the charge step
  2. Sending a Helcim or Cal.com webhook event when the corresponding signing secret env var is absent in production returns 400/403 — no event is accepted or processed
  3. A second `POST /api/checkout` with the same `transactionId` when Redis is unavailable returns 409 — no duplicate Zoho order is created
  4. `GET /api/contacts`, `GET /api/invoices`, `GET /api/items/inspect`, and `GET /api/snapshot` require the `MW_API_KEY` header — a request without it returns 401/403 regardless of Referer
  5. `POST /api/items`, `PUT /api/items`, `POST /api/taxes/apply`, and `POST /api/upload-catalog` reject requests with missing or malformed required body fields before forwarding anything to Zoho

**Plans**: 4 plans (1 wave — all parallel, disjoint files)
Plans:
**Wave 1** (parallel)

- [x] 32-01-PLAN.md — reCAPTCHA fail-closed + transactionId replay-guard 409 (HARDEN-01, HARDEN-03)
- [x] 32-02-PLAN.md — Helcim + Cal.com webhook verifiers fail closed in prod (HARDEN-02)
- [x] 32-03-PLAN.md — validateEnv prod-secret boot check + NODE_ENV/RAILWAY assertion + drop GP_* (HARDEN-04)
- [x] 32-04-PLAN.md — Targeted PII GET-route API-key guard + body-shape whitelist on mutating item/tax routes (PII-01, PII-02)

### Phase 33: Deploy Safety & Monitoring

**Goal**: Production deploys are gated on passing tests, every deploy is traceable and reversible, the nightly snapshot reaches the live site, and critical failures (downtime, missing secrets, service degradation) are caught automatically
**Depends on**: Phase 31 (CI gate needs a test suite to gate on; Phase 32 optional but recommended before finalizing runbook)
**Requirements**: DEPLOY-01, DEPLOY-02, DEPLOY-03, MONITOR-01, MONITOR-02
**Success Criteria** (what must be TRUE):

  1. A push to the production remote that would cause frontend or middleware tests to fail is blocked by CI before the deploy completes — the broken code never reaches the live site
  2. Every production deploy has a corresponding git tag (`prod-YYYYMMDD-N`) and a written runbook entry pairing the git SHA with the Railway deploy ID, so a rollback can be initiated from either end within minutes
  3. The nightly Zoho snapshot job produces an updated `zoho-snapshot.json` that is committed and visible at `steinsandvines.ca/content/zoho-snapshot.json` — the `[skip ci]` / force-push interaction no longer leaves the file stale
  4. An external uptime check polls `GET /health` at least every 5 minutes and sends an alert if the endpoint returns non-200, `authenticated:false`, or `redis:false`
  5. `HELCIM_WEBHOOK_SECRET`, `RECAPTCHA_SECRET_KEY`, and `SENTRY_DSN` are confirmed present in Railway production, and `validateEnv.js` startup check covers the live Helcim/Cal.com/`REDIS_ENCRYPTION_KEY` variables while dead Global Payments vars are removed

**Plans**: 3 plans (2 waves)
Plans:
**Wave 1** (parallel — disjoint files)

- [x] 33-01-PLAN.md — DEPLOY-03 snapshot fix (update-snapshot.yml repo guard + cross-repo push) + MONITOR-02 code (SENTRY_DSN/HELCIM_API_TOKEN -> REQUIRED_IN_PROD + regression test)
- [x] 33-02-PLAN.md — DEPLOY-01/02 gated-deploy.yml (workflow_dispatch test gate, CNAME swap, force-push, /health smoke-check, prod-YYYYMMDD-N tag, runbook append) + docs/RUNBOOK.md

**Wave 2** (human action — depends on 33-01, 33-02)

- [x] 33-03-PLAN.md — MONITOR-01 UptimeRobot /health keyword monitor + deploy secrets (PROD_DEPLOY_TOKEN, RAILWAY_TOKEN) + Railway "Wait for CI" + first gated deploy verification + close Phase 32 secrets UAT (MONITOR-02)

## Phase Details (v4.3)

### Phase 34: Ingredient Display & Server Enrichment

**Goal**: Recipe ingredient data is enriched with `cf_type` in the middleware so every surface (admin, kiosk, BrewPad) receives a consistent type label and can group ingredients identically without per-surface workarounds
**Depends on**: Nothing (first phase of v4.3; reads existing Zoho ingredient data via the catalog cache)
**Requirements**: RDISP-01, RDISP-02, RDISP-03
**Success Criteria** (what must be TRUE):

  1. The middleware endpoint(s) that return recipe ingredients include a `cf_type` field (e.g. Grain, Hops, Yeast, Additive, Packaging) on every ingredient line, derived from the Zoho item data at request time
  2. In the admin recipe detail view, ingredients are displayed in labelled sections by `cf_type` (e.g. a "Grain" section, a "Hops" section) with items within each section in a consistent order
  3. The kiosk recipe ingredient list and the BrewPad recipe ingredient view both show ingredients grouped by `cf_type`, matching the admin grouping (same section labels, same sort order)
  4. Middleware unit tests cover the `cf_type` enrichment logic (field present, fallback for unknown type, order of groups) and the full test suite passes with lint clean

**Plans**: 3 plans (2 waves)
Plans:
**Wave 1** (parallel — disjoint files)

- [x] 34-01-PLAN.md — Promote CATEGORY_DISPLAY_NAMES to js/lib/constants.js + create shared js/lib/recipe-grouping.js helper (D-01..D-07, D-11) + Jest (RDISP-02)
- [x] 34-02-PLAN.md — Server additive enrichment in recipes.js (cf_type/cf_subcategory/display_group, locked+dynamic, cold-cache) + middleware tests (RDISP-02)

**Wave 2**

- [x] 34-03-PLAN.md — Wire grouped rendering into admin/BrewPad/kiosk via shared helper + build + human verify (RDISP-01, RDISP-03)

**UI hint**: yes

### Phase 35: Batch Scaling Engine

**Goal**: Staff can enter a target batch volume in litres at recipe selection time; the system computes the scale factor, adjusts all ingredient quantities (linear for weight, round-up for pcs), prices the scaled recipe server-authoritatively, and captures the scaled quantities and target volume in the Zoho invoice and the frozen `recipe_snapshot`
**Depends on**: Phase 34 (ingredient `cf_type` enrichment is available; unit types needed to distinguish weight vs. pcs for rounding logic)
**Requirements**: SCALE-01, SCALE-02, SCALE-03, SCALE-04, SCALE-05
**Success Criteria** (what must be TRUE):

  1. On a recipe-selection surface (admin), a "Target volume (L)" input is visible after a recipe is chosen; entering a value displays the computed scale factor (e.g. "1.5× base 20 L") before committing
  2. After scaling, a weight-based ingredient (kg/g) shows a linearly scaled quantity (e.g. 5 kg → 7.5 kg at 1.5×) and a pcs ingredient shows a quantity rounded up to the nearest whole unit (e.g. 2.3 pcs → 3 pcs)
  3. `POST /api/kiosk/recipe-sale` (or equivalent) receives the target volume and returns scaled ingredient costs: locked-price recipes scale only the ingredient-cost portion with service/materials fees fixed; dynamic recipes price from scaled ingredient costs — verified by middleware unit tests
  4. The Zoho invoice line items reflect the scaled quantities (not the base recipe quantities), and the `recipe_snapshot` frozen at sale time includes both the `target_volume_l` and the scaled ingredient quantities
  5. Before sale confirmation, a stock-check using the scaled quantities surfaces any ingredient that would be oversold (quantity requested exceeds available stock), and the sale cannot proceed until the conflict is resolved

**Plans**: 4 plans (4 waves)
Plans:
**Wave 0**

- [x] 35-01-PLAN.md — BLOCKING: verify batch_size_l is in the Apps Script get_recipe response (remediate + redeploy if absent) (SCALE-01)

**Wave 1**

- [x] 35-02-PLAN.md — New pure lib/recipe-scaling.js (unit classification, linear/ceil scaling, locked/dynamic repricing, scaled stock check) + recipe-scaling.test.js (SCALE-02, SCALE-03, SCALE-05)

**Wave 2**

- [x] 35-03-PLAN.md — Wire scaling into pos-recipe.js BOTH paths (validation, factor, scaled qty, repricing, stock 409+override, enriched snapshot) + pos-recipe.test.js (SCALE-01, SCALE-03, SCALE-04, SCALE-05)

**Wave 3**

- [x] 35-04-PLAN.md — Admin Kiosk Sale UI: target-volume input + live factor readout + override block (admin.html + admin.js), build, staging UAT flagging the D-06 locked-price increase (SCALE-01, SCALE-05)

### Phase 36: Cross-Surface Selection & Recipe Modification

**Goal**: The batch-size control is available on every recipe-selection surface and persists through the sale/batch flow; staff can also add, remove, or substitute ingredients for a one-off modified sale without altering the saved recipe, with the option to save the modification as a new recipe
**Depends on**: Phase 35 (scaling engine must exist; server pricing for modified ingredient lists extends the same server path)
**Requirements**: SEL-01, SEL-02, MOD-01, MOD-02, MOD-03
**Success Criteria** (what must be TRUE):

  1. The batch-size (target volume) control appears in the admin recipe-sale flow, the kiosk recipe-sale flow, and the BrewPad recipe-attach flow — using the same visual control and validation rules on all three surfaces
  2. A batch size chosen at recipe-selection time is carried through the entire flow — into the cart line items, the Zoho invoice, the `recipe_snapshot`, and the created batch record — without requiring the staff member to re-enter it at any later step
  3. At recipe-selection time, staff can modify the ingredient list (add an item from the ingredient catalog, remove an existing line, or swap one ingredient for another); the saved recipe template is not altered by this action
  4. The modified ingredient list is priced server-authoritatively (same `pos-recipe.js` / `lib/pricing.js` path as a standard sale) and the Zoho invoice and frozen `recipe_snapshot` reflect the actual ingredients sold, not the original template
  5. A staff member can optionally tap "Save as new recipe" after a one-off modification; this creates a new recipe via the existing recipe-create endpoint (`SV-R-…` ID, activation guardrails enforced), leaving the original recipe untouched

**Plans**: 17 plans (14 waves) — 7 original + 5 first-pass gap-closure (36-08..36-12) + 5 second-pass gap-closure (36-13..36-17)
**UI hint**: yes
Plans:
**Wave 1** (parallel — disjoint middleware files)

- [x] 36-01-PLAN.md — Pure computeModifiedRecipeTotal helper (locked-add/remove asymmetry D-07/D-08, dynamic D-09) + worked-example tests (MOD-02)
- [x] 36-02-PLAN.md — SEL-02 carry-through: detectRecipeSale forwards target_volume_l/scale_factor onto the batch payload + Apps Script create_batch redeploy (human-action) (SEL-02)

**Wave 2**

- [x] 36-03-PLAN.md — Wire modified_ingredients into computeRecipeQuote + recipe-quote/recipe-sale/confirm + freeze modified_base_ingredients/is_modified into snapshot (MOD-02)

**Wave 3** (parallel — disjoint surface files)

- [x] 36-04-PLAN.md — Admin: modify panel + server-quote modified price + (Modified) label + save-as-new (MOD-01, MOD-02, MOD-03, SEL-01)
- [x] 36-05-PLAN.md — Kiosk: port Phase 35 control + modify panel (iOS-zoom-safe), no save-as-new (SEL-01, SEL-02, MOD-01, MOD-02)
- [x] 36-06-PLAN.md — BrewPad attach: port control + modify panel + soft stock advisory + scaled+modified snapshot (no charge) + save-as-new (SEL-01, SEL-02, MOD-01, MOD-03)

**Wave 4** (depends on all surfaces)

- [ ] 36-07-PLAN.md — Staging deploy + cross-surface human UAT (locked-remove asymmetry, carry-through, save-as-new) + REQUIREMENTS traceability (SEL-01, SEL-02, MOD-01, MOD-02, MOD-03)

**Gap closure (from 36-HUMAN-UAT.md GAP-1/2/3)**

**Wave 5** (UI-SPEC contract first)

- [x] 36-08-PLAN.md — Extend 36-UI-SPEC.md with the synced ×factor control contract (GAP-3) + polished/reordered modify-panel layout (GAP-2) (SEL-01, MOD-01)

**Wave 6**

- [x] 36-09-PLAN.md — Admin: GAP-1 catalog-load regression test + hook, GAP-3 synced ×factor input, GAP-2 layout polish + edit-at-base pre-population (SEL-01, MOD-01)

**Wave 7**

- [x] 36-10-PLAN.md — Kiosk: port synced ×factor (iOS-zoom-safe) + GAP-2 layout polish, no save-as-new (SEL-01, MOD-01)

**Wave 8**

- [x] 36-11-PLAN.md — BrewPad attach: port synced ×factor (no quote/charge, D-10) + GAP-2 layout polish (SEL-01, MOD-01)

**Wave 9** (re-UAT)

- [x] 36-12-PLAN.md — Staging re-deploy + second human UAT pass confirming GAP-1/2/3 closed across all three surfaces (autonomous: false) (SEL-01, MOD-01)

**Second-pass gap closure (from 36-HUMAN-UAT.md GAP-4/5/6/7 + 36-UI-REVIEW.md)**

**Wave 10** (UI-SPEC contract first)

- [x] 36-13-PLAN.md — Extend 36-UI-SPEC.md: live-price visibility contract (GAP-4, server-authoritative, no _kioskModifyPanelOpen gate), scroll model (GAP-5), and audit polish (GAP-7) (SEL-01, MOD-01, MOD-02)

**Wave 11**

- [x] 36-14-PLAN.md — Admin: GAP-4 ungate quote + prominent server-quote price on every change, GAP-5 scrollable prompt, GAP-6 admin font-size:1rem + bundle/cache verify, GAP-7 polish (SEL-01, MOD-01, MOD-02)

**Wave 12**

- [x] 36-15-PLAN.md — Kiosk: GAP-4 ungate + prominent server-quote price, GAP-5 scrollable prompt, GAP-7 polish + cellar-palette autocomplete + --sp-* tokens, no save-as-new (SEL-01, MOD-01, MOD-02)

**Wave 13**

- [x] 36-16-PLAN.md — BrewPad attach: GAP-5 inject expanded panel into the scrollable detail pane (no quote/charge, D-10), GAP-7 polish (44px Remove, × factor label) (SEL-01, MOD-01)

**Wave 14** (re-UAT)

- [x] 36-17-PLAN.md — Staging re-deploy + third human UAT pass confirming GAP-4/5/6/7 closed + re-confirming still-pending original items #1-#8 (autonomous: false) (SEL-01, SEL-02, MOD-01, MOD-02, MOD-03)

### Phase 37: BrewPad Recipe Manager

**Goal**: Staff can browse, view, create, and edit recipes from within BrewPad — the recipe builder is no longer admin-only — using the existing recipe CRUD endpoints and activation guardrails
**Depends on**: Phase 34 (ingredient grouping is available for consistent display in the BrewPad recipe view; Phases 35/36 not required — BPR is independent of scaling)
**Requirements**: BPR-01, BPR-02
**Success Criteria** (what must be TRUE):

  1. BrewPad has a "Recipes" section (tab or panel) where staff can browse the full recipe catalogue with status indicators (draft / active) and search/filter by name
  2. Selecting a recipe in BrewPad opens a detail view showing all recipe metadata and ingredients grouped by `cf_type` — the same information visible in the admin recipe detail view
  3. Staff can create a new recipe from BrewPad using the same form fields as the admin recipe builder; the recipe is created via the existing `POST /api/recipes` endpoint and appears in the catalogue immediately
  4. Staff can edit an existing recipe from BrewPad; activation guardrails (`locked_price > 0` and at least one ingredient) are enforced before any recipe can be marked active — identical to the admin path

**Plans**: 3 plans (3 waves — all touch js/brewpad.js, so sequential)
Plans:
**Wave 1**

- [x] 37-01-PLAN.md — Recipes tab scaffold + tab wiring + recipe-list browse with status badges + name search (BPR-01)

**Wave 2**

- [x] 37-02-PLAN.md — Recipe detail (grouped ingredients) + editor (field parity, autocomplete, inline activation guardrail, create/edit save) (BPR-01, BPR-02)

**Wave 3**

- [x] 37-03-PLAN.md — Confirm-gated delete + build bundle + full test/lint gate + iPad Safari UAT (BPR-02)

**UI hint**: yes

## Phase Details (v4.4)

### Phase 38: Repo Hygiene & Deploy-Strip Confirmation

**Goal**: Internal planning artifacts are no longer tracked-and-served — `.planning/` is gitignored and absent from the published artifact on both staging and production
**Depends on**: Nothing (first phase of v4.4; lowest-risk, no money path)
**Requirements**: HYGIENE-01
**Success Criteria** (what must be TRUE):

  1. `.planning/` is listed in `.gitignore` and `git ls-files .planning` returns nothing (the directory is untracked via `git rm -r --cached .planning`) — local working copy is preserved
  2. The published GitHub Pages artifact for production does not contain `.planning/` — fetching `steinsandvines.ca/.planning/STATE.md` (or any known planning path) returns 404, not file contents
  3. The published GitHub Pages artifact for staging does not contain `.planning/` — fetching `staging.steinsandvines.ca/.planning/STATE.md` returns 404 (staging is served directly from the repo, so the gitignore/untrack — not a deploy-time strip — is what removes it)
  4. The production deploy's existing `.planning` strip step still runs (defense in depth) and the prod deploy completes green with no regression to CNAME or the live site

**Plans**: TBD

### Phase 39: Nightly Snapshot Publishes to Prod Fallback

**Goal**: The nightly Zoho snapshot actually reaches the live production static fallback and survives the next force-push deploy
**Depends on**: Phase 38 (sequential; both are deploy/infra hygiene, no functional overlap)
**Requirements**: DEPLOY-04
**Success Criteria** (what must be TRUE):

  1. The nightly snapshot commit that updates `zoho-snapshot.json` no longer carries a `[skip ci]` token that suppresses the GitHub Pages publish (or the publish is driven by an explicit `workflow_dispatch`/scheduled deploy trigger that is not skipped)
  2. The snapshot workflow pulls/rebases (or otherwise reconciles) before the production write so a subsequent `git push production main --force` deploy does not erase the freshly published snapshot
  3. After a nightly run (or a manually triggered run), `steinsandvines.ca/content/zoho-snapshot.json` returns a snapshot whose timestamp is from that run — verifiably fresh, not stale
  4. The change preserves the v4.2 CNAME-safe deploy invariant: the prod `main` history and CNAME are intact after the snapshot publish (no 404, no clobbered domain)

**Plans**: TBD

### Phase 40: Facility Image Optimization (webp + srcset)

**Goal**: Facility/about imagery is served as right-sized webp with `srcset` and intrinsic dimensions, removing the multi-MB JPEG payload from the homepage by extending the existing product image pipeline
**Depends on**: Nothing functional (independent of 38/39; sequenced after for risk ordering — build/asset change, no money path)
**Requirements**: ASSET-01
**Success Criteria** (what must be TRUE):

  1. The homepage hero/facility image (`interior.jpg`, currently ~5.7 MB) and the about-page facility/owner photos are emitted as `webp` with a `srcset` of multiple widths, generated by the existing product image pipeline (extended, not a duplicated/parallel script)
  2. On the homepage path, no single facility image transfers more than ~500 KB at the rendered viewport size (verified in the network panel on a standard laptop/iPad viewport)
  3. Each optimized facility/about `<img>` carries intrinsic `width` and `height` attributes (or aspect-ratio) so the image reserves layout space and does not cause cumulative layout shift
  4. A non-webp fallback (`<picture>` source or `jpg` fallback) is present so browsers without webp support still render the image, and `npm run build` regenerates the optimized assets without errors
  5. The homepage and about page render correctly on staging.steinsandvines.ca with the new images and no broken-image or console errors (iPad Safari included)

**Plans**: TBD
**UI hint**: yes

### Phase 41: SKU-Keyed Cart Identity

**Goal**: The same product added from the catalog page and from the search overlay merges into one cart line keyed by SKU — no duplicate lines, correct quantity — across both the ferment and ingredients carts
**Depends on**: Nothing functional (independent; sequenced after the infra/asset work because it touches the public cart, which has frontend tests — riskier than 38-40, lower-risk than 42)
**Requirements**: CART-01
**Success Criteria** (what must be TRUE):

  1. The cart identity key is derived from SKU in both `11-cart.js` and `17-search-overlay.js` (replacing the `name|brand` / `name|` mismatch), with a `name|brand` fallback only when a SKU is genuinely absent
  2. Adding a product from the catalog page and then the same product from the cross-category search overlay produces exactly one cart line whose quantity is the sum of both adds — no duplicate row, correct displayed quantity
  3. The merge-by-SKU behaviour holds independently for the ferment cart and the ingredients cart (a SKU added on each surface routes to and merges within the correct cart per the dual-cart routing)
  4. Existing frontend cart tests pass and new regression tests cover the catalog+overlay same-SKU merge for both carts; `npm test`, `npm run lint`, and `npm run build` are clean
  5. Verified on staging.steinsandvines.ca: adding a product from a category subpage and from the search overlay shows one line with the correct count

**Plans**: TBD
**UI hint**: yes

### Phase 42: Kiosk POS De-Fork (kiosk-core.js)

**Goal**: The kiosk POS logic lives in a single shared `js/kiosk-core.js` consumed by both `kiosk.js` (standalone) and `admin.js` (embedded), so the cart and payment/checkout paths can no longer diverge — a behaviour-preserving refactor that does not weaken the v4.2-hardened money path
**Depends on**: Phase 41 (sequential; both are frontend — keeps the highest-risk money-path refactor last, after the cart-identity work it conceptually relates to has shipped and been verified)
**Requirements**: KIOSK-01
**Success Criteria** (what must be TRUE):

  1. The ~34 duplicated `kiosk*` functions (cart building, `kioskProceedToPayment`, terminal charge, Zoho invoice/payment, void-on-failure, dual-cart) exist in exactly one place, `js/kiosk-core.js`, and both `kiosk.js` and `admin.js` consume that shared module — no second copy of the payment path remains
  2. The money path is unchanged in behaviour: terminal charge → Zoho invoice/payment → void-on-failure → dual-cart shared-charge handling all behave exactly as before, demonstrated by the existing kiosk tests passing without weakening and by a new admin-embedded-vs-standalone parity check that asserts identical request payloads/flow for the same cart
  3. The kiosk product-type discount feature (which currently exists only in `kiosk.js`) is available identically on both the standalone kiosk and the admin-embedded kiosk after the de-fork — resolving the existing drift where `admin.js` lacks it
  4. `npm test`, `npm run lint`, and `npm run build` are clean (concatenated `main.js`/`main.min.js` and `admin.min.js` regenerated), and no behaviour-changing logic was introduced beyond the discount-parity fix
  5. Verified on staging on iPad Safari: a full kiosk sale (including a recipe/product-type discount) completes identically from both the standalone kiosk URL and the admin-embedded kiosk tab, with the terminal/void/dual-cart behaviour intact

**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-4 | v1.0 | 8/8 | Complete | 2026-04-28 |
| 5-11 | v1.1 | 24/24 | Complete | 2026-05-06 |
| 12-19 | v2.0 | 26/26 | Complete | 2026-05-27 |
| 20. Zoho Data Foundation | v3.0 | 2/2 | Complete | 2026-05-28 |
| 21. Shared Template & Build Infrastructure | v3.0 | 2/2 | Complete   | 2026-05-29 |
| 22. Category Subpages & Navigation | v3.0 | 3/3 | Complete   | 2026-05-29 |
| 23. Cross-Category Search | v3.0 | 2/2 | Complete    | 2026-05-30 |
| 24. SEO & Staging Deploy | v3.0 | 2/2 | Complete    | 2026-06-03 |
| 25. Cal.com Booking Migration | v4.0 | 4/4 | Complete   | 2026-06-04 |
| 26. Cloudflare Edge Protection | v4.0 | live-exec | Complete | 2026-06-06 |
| 27. Pending Batch Visibility & Activation | v4.1 | 4/4 | Complete    | 2026-06-11 |
| 28. Zoho Customer Read-Back Path | v4.1 | 2/2 | Complete    | 2026-06-12 |
| 29. Refresh-from-Zoho Admin UI | v4.1 | 6/6 | Complete   | 2026-06-14 |
| 31. Money-Path Test Coverage | v4.2 | 4/4 | Complete    | 2026-06-17 |
| 32. Fail-Closed Hardening & Access Control | v4.2 | 4/4 | Complete    | 2026-06-18 |
| 33. Deploy Safety & Monitoring | v4.2 | 3/3 | Complete    | 2026-06-18 |
| 34. Ingredient Display & Server Enrichment | v4.3 | 3/3 | Complete   | 2026-06-20 |
| 35. Batch Scaling Engine | v4.3 | 6/6 | Complete    | 2026-06-21 |
| 36. Cross-Surface Selection & Recipe Modification | v4.3 | 21/17 | Complete   | 2026-06-25 |
| 37. BrewPad Recipe Manager | v4.3 | 3/3 | Complete    | 2026-06-20 |
| 38. Repo Hygiene & Deploy-Strip Confirmation | v4.4 | 0/? | Not started | - |
| 39. Nightly Snapshot Publishes to Prod Fallback | v4.4 | 0/? | Not started | - |
| 40. Facility Image Optimization (webp + srcset) | v4.4 | 0/? | Not started | - |
| 41. SKU-Keyed Cart Identity | v4.4 | 0/? | Not started | - |
| 42. Kiosk POS De-Fork (kiosk-core.js) → rehomed to v4.5 Phase 48 (KIOSK-01) | v4.4 | 0/? | Not started | - |
| 46. Auth Re-Architecture | v4.5 (carryover, SEC-02) | 10/10 | ✅ Complete — cutover done, all surfaces verified, leaked key rotated dead (403) | 2026-07-08 |
| 47. Purge Publicly-Served Internal Docs | v4.5 | 1/1 | ✅ Closed on staging (verified 2026-07-03); prod audit-doc at next prod deploy | 2026-07-03 |
| 48. Kiosk POS De-Fork (kiosk-core.js) | v4.5 | 5/6 | Complete    | 2026-07-10 |
| 49. Online Captured-Amount Verification | v4.5 | 1/2 | 49-01 done (H2 fix + 13-test regression, suite green); 49-02 live-card UAT pending deploy | - |
| 50. Kiosk Money-Path Defect Closeout | v4.5 | 4/5 | In Progress|  |
| 51. Gift-Card Ledger Integrity | v4.5 | 2/3 | In Progress|  |
| 52. Fail-Closed Sweep | v4.5 | 5/5 | Complete    | 2026-07-03 |
| 53. Money-Path Observability & CI Gates | v4.5 | 6/6 | Complete    | 2026-07-03 |
| 54. Gift-Card Management on the Kiosk Surface | v4.5 | 3/3 | Complete    | 2026-07-08 |

### Phase 29.4: Wine drill-down analytics on BrewPad dashboard — wine-specific category breakdown splitting wine batches by a selectable dimension (subcategory, brand, manufacturer, or kit time e.g. 4-week/5-week). Builds on the Phase 29.3 Batches-by-Month type-breakdown chart. New data source in BrewPad: load product catalog (cheapest: static /content/zoho-snapshot.json — carries sku, subcategory, brand, manufacturer, time per wine kit) and join batch.product_sku -> catalog sku to derive the split attribute (batches store only product_sku/product_name today). Dynamic categories (brand/manufacturer are open sets -> top-N + 'Other' grouping with dynamic colors) + a dimension selector. Frontend-only: js/brewpad.js + tests. Depends on Phase 29.3. (INSERTED)

**Goal:** Staff can split wine batches on the BrewPad dashboard by a selectable dimension (subcategory, brand, manufacturer, or kit time) via a new "Wine Breakdown" card that joins batches to the catalog snapshot.
**Requirements**: none (driven by CONTEXT decisions D-01..D-12)
**Depends on:** Phase 29
**Plans:** 2/2 plans complete

Plans:

- [x] 29.4-01-PLAN.md — Pure helper/data layer: buildSkuLookup, normalizeWineTime, bucketWineDimension, applyTopN + Jest suite
- [x] 29.4-02-PLAN.md — Render/interaction layer: Wine Breakdown card, segmented selector, snapshot lazy-fetch, handlers, build

### Phase 29.3: Pull non-kiosk batch sales into BrewPad — bulk-scan recent Zoho invoices for ferment-in-store sales (Makers Fee present) that have no batch yet and create pending batches; dedupe by zoho_so_number, skip already-batched invoices via cf_batch_status, bounded scan window to respect Zoho rate limits. Touches zoho-middleware scan endpoint + per-invoice detail fetch, apps-script adminApi.gs create_batch dedup, js/brewpad.js Pull-from-Zoho control + confirm + list refresh. (INSERTED)

**Goal:** Staff can pull ferment-in-store sales invoiced directly in Zoho Books into BrewPad as pending batches — a confirm-gated "Pull from Zoho" control bulk-scans a bounded window of recent invoices (Maker's Fee present, no batch yet), plus a single-invoice import path, deduped by zoho_so_number in both the middleware pre-check and an Apps Script idempotency guard.
**Requirements**: none mapped (decisions D-01..D-10 in 29.3-CONTEXT.md)
**Depends on:** Phase 29
**Plans:** 3/3 plans complete

Plans:

- [x] 29.3-01-PLAN.md — Middleware scan + bulk-create endpoints (GET /api/batch/scan-invoices, POST /api/batch/bulk-create) with Jest tests [wave 1]
- [x] 29.3-02-PLAN.md — Apps Script createBatch zoho_so_number idempotency guard (D-10) [wave 1]
- [x] 29.3-03-PLAN.md — BrewPad "Pull from Zoho" control + confirm sheet + single-import + list refresh [wave 2]

### Phase 29.2: BrewPad pending batch activation — one-click Activate and guided Schedule & Activate for pending batches in BrewPad (Needs Scheduling rows + batch detail pane), reusing Phase 27 admin backend; make detail status badge pending-aware so pending batches route through activation instead of silently cycling to Primary. Frontend-only: js/brewpad.js + tests. (INSERTED)

**Goal:** Staff can activate a pending batch from BrewPad — one-click Activate or guided Schedule & Activate — from the Needs Scheduling rows and the batch detail pane, and the detail status badge routes pending batches through activation instead of silently promoting them to Primary.
**Requirements**: none mapped
**Depends on:** Phase 29
**Plans:** 5/5 plans complete

Plans:

- [x] 29.2-01-PLAN.md — Test scaffold + todayPacific() helper + status badge pending guard (bug fix, regression test first)
- [x] 29.2-02-PLAN.md — Needs Scheduling rows: Activate + Schedule & Activate buttons and one-click delegation
- [x] 29.2-03-PLAN.md — Guided Schedule & Activate bottom sheet + detail pane pending action buttons
- [x] 29.2-04-PLAN.md — Gap closure: fix detail-pane Activate re-render (CR-01 blocker, renderBatchDetail data wrapper)
- [x] 29.2-05-PLAN.md — Gap closure: emit last_updated in needsScheduling summary to re-enable optimistic lock (CR-02) + Apps Script redeploy

### Phase 29.1: Batch customer reassignment — change the customer tied to a batch (e.g. WALK-IN placeholder) and propagate the change to the linked Zoho sales order/invoice (INSERTED)

**Goal:** Staff can reassign the customer on a batch from the BrewPad detail pane (search existing Zoho customer or add one inline) and push that change to the linked Zoho SO/invoice; the batch is the source of truth and survives a Zoho rejection with a clear warning.
**Requirements**: none mapped (inserted phase)
**Depends on:** Phase 29
**Plans:** 2/2 plans complete

Plans:

- [x] 29.1-01-PLAN.md — Middleware: contact-search + batch-first reassign endpoint (Zoho push optional, no rollback on Zoho failure)
- [x] 29.1-02-PLAN.md — BrewPad UI: Change Customer control with search/add-new, confirm-gated Zoho push, in-place patch + warning toast

### Phase 26: Cloudflare Edge Protection — COMPLETE (2026-06-06)

**Outcome:** Cloudflare free tier is live in front of production (`steinsandvines.ca`) — proxied with SSL Full, Bot Fight Mode + a rate-limit rule active, email auth (SPF/DKIM/DMARC) hardened, staging kept grey-clouded. Executed live without a formal PLAN; see `26-SUMMARY.md` and `DNS-INVENTORY.md`. Follow-up (deferred): protect the Railway API via `api.steinsandvines.ca` if analytics show bots hitting it.

**Goal:** Cloudflare's free tier sits in front of `steinsandvines.ca` (GitHub Pages) and the Railway middleware API, absorbing/filtering the increasing bot traffic — without breaking the existing GitHub Pages custom-domain setup, `enforce-cname.yml`, Helcim payments, or Cal.com/Zoho integrations.

**Motivation:** Increasing bot traffic hitting the site (and likely the middleware). Cloudflare free tier gives CDN caching, Bot Fight Mode, basic WAF, and rate limiting at no cost.

**Depends on:** Phase 25 (sequential; no hard technical dependency)

**Scope (to refine in discuss):**

  - DNS migration: move `steinsandvines.ca` nameservers to Cloudflare; recreate existing records (Pages A records, staging CNAME, Railway/api, MX/email, any TXT/verification)
  - Proxy (orange-cloud) the apex + www through Cloudflare with SSL mode set correctly for GitHub Pages custom domains (Full, not Flexible — avoid redirect loops)
  - Confirm GitHub Pages custom domain + `enforce-cname.yml` still function behind the proxy
  - Bot Fight Mode (or Super Bot Fight Mode if available on free), basic managed WAF, and a rate-limiting rule
  - Decide whether the Railway `api.` subdomain is proxied too, or stays direct (CORS/Referer guard interactions)
  - Caching rules that don't break dynamic middleware calls or cache-busted assets

**Open questions for discuss-phase:**

  - Who controls the domain registrar / current DNS host? (needed to change nameservers)
  - Is the Railway API on a custom subdomain we can proxy, or the raw `*.up.railway.app`?
  - Acceptable risk window for the DNS cutover (propagation), and staging-first strategy for an infra change that GitHub Pages serves directly?

**Requirements**: TBD (derive in discuss-phase)
**Plans:** 9 plans (5 waves). ⚠ Auth re-architecture (the CRITICAL, D-01..D-05) recommended to split to Phase 46 — see note below.

Plans:

- [ ] TBD (run /gsd-discuss-phase 26, then /gsd-plan-phase 26 to break down)

### Phase 30: Assessment quick wins — small high-impact fixes from PROJECT_ASSESSMENT.md

**Goal:** Ship the curated 21 small high-impact fixes from PROJECT_ASSESSMENT.md (user-facing live bugs, security hardening, dead-weight removal, repo hygiene, config/infra, test cleanup) in risk-batched staging-first deploys, with `.planning/` excluded from the public site (kept in git) and CNAME untracked.
**Requirements**: none mapped (driven by QUICK-WINS items #1-21 + CONTEXT decisions D-01..D-04)
**Depends on:** Phase 29
**Plans:** 4/6 plans executed

Plans:
**Wave 1**

- [x] 30-01-PLAN.md — Dead-weight removal: delete unreferenced assets, dead lib, 9 dead content files, self-destruct sw.js + build refs (#10-14)
- [x] 30-02-PLAN.md — Repo hygiene: deploy-layer `.planning/` exclusion kept-in-git (D-01/#15) + untrack CNAME (#16)

**Wave 2**

- [x] 30-03-PLAN.md — User-facing content/CSS/404 fixes: hero subtitle, nested-URL 404, contrast, empty story paragraph (#1,#3,#5,#6)

**Wave 3**

- [ ] 30-04-PLAN.md — User-facing JS fixes (build): beer waitlist via /api/contact (D-02/#2) + kiosk idle-reset cart leak (#4)

**Wave 4**

- [ ] 30-05-PLAN.md — Security batch (payment-adjacent): escape contact XSS sinks (#7), canonical escapeHTML (#8), proto-pollution guard (#9) + staging-kiosk verify

**Wave 5**

- [x] 30-06-PLAN.md — Config/infra + test cleanup: railway.toml watchPatterns (#19), node-cron 4.2.1 (#20), jest cleanup (#21) + human actions env vars/uptime (#17,#18)

### Phase 43: Kiosk manual custom line item with notes

**Goal:** Let kiosk staff add an ad-hoc invoice line (description + staff-entered price + qty + note) that is not a catalog product, on both kiosk surfaces (standalone `kiosk.js` and admin-embedded `admin.js`, forked per #14), without weakening the v4.2-hardened money path. Server `/api/kiosk/sale` + `/api/kiosk/sale/confirm` gain a custom-line path (no `item_id`, `custom:true`) that trusts the bounded staff price and records the note in the Zoho invoice line description; the terminal charge (server `computeTax`) must equal the Zoho invoice tax for taxable custom lines.
**Requirements**: KIOSK-02 (new owner-requested feature; not from PROJECT_ASSESSMENT.md)
**Depends on:** None (independent of Phase 42 de-fork; both touch the forked kiosk surfaces, sequence to avoid merge churn)
**Plans:** 2/2 plans complete

Plans:

- [x] 43-01-PLAN.md — server custom-line path in routes/pos.js (test-first; bounded price, 5% GST tax_id resolution + fail-closed, note->description, discount-skip)
- [x] 43-02-PLAN.md — "Add custom item" modal + cart wiring on BOTH kiosk.js and admin.js (forked); rebuild bundles + full gate; human-verify

### Phase 44: Kiosk gift card certificate lifecycle

**Goal:** Full gift-card / gift-certificate lifecycle at the kiosk POS — **sell, redeem (as tender), balance lookup, partial redemption, and reload** — on both forked kiosk surfaces (`kiosk.js` + `admin.js`), with correct money-path + accounting semantics. This is a NEW capability, NOT an extension of the Phase 43 custom-line item.
**Requirements**: GIFTCARD-01 (owner-requested; captured 2026-06-27, to be split into sub-requirements at planning)

**Captured scope (from owner, 2026-06-27 — pre-discussion):**

- **Lifecycle:** full — sell, redeem, balance lookup, partial redemption, reload. Likely splits into multiple plans/sub-phases at planning time.
- **Medium:** **paper certificate with a manually-assigned number/code** (no pre-printed barcode stock, no digital/email generation in v1). Staff enter the certificate number at sale and at redemption.
- **Both kiosk surfaces** (forked #14): build in `kiosk.js` AND `admin.js` until the Phase 42 de-fork.

**Critical constraints (MUST hold — these are why this is its own phase):**

- **Tax (BC/Canada):** a gift card/certificate sale is **NOT taxed at sale** (no GST/PST); tax applies to the underlying goods/services at **redemption**. Selling must be zero-tax; redemption applies tax to the real items being bought.
- **Accounting:** a sale is a **liability, not revenue** — must post to an "unredeemed gift card liability" account in Zoho (deferred), recognized as revenue only on redemption. Do NOT post gift-card sales as a normal sales line. (Research the right Zoho mechanism — liability account / gift-card item / store credit — at planning.)
- **Redemption is a tender/payment path**, not a cart line — distinct from how items are added. Must integrate with the v4.2-hardened money path (Helcim terminal for any remaining balance, Zoho payment recording) without weakening it.
- **Balance integrity:** server-authoritative balance tracking (where do balances live — Zoho, Redis, Sheets? decide at planning); partial redemption must atomically decrement; guard against double-spend / replay.

**Depends on:** Phase 43 (sequence after — both touch the forked kiosk surfaces; avoids `kiosk.js`/`admin.js` merge churn). Independent of Phase 42.
**Plans:** 9/10 plans executed

Plans:
**Wave 1** (parallel — owner setup + Apps Script foundation)

- [x] 44-01-PLAN.md — Owner Zoho setup (Gift Card Sales income account + Gift Certificate 0%-tax item + KIOSK_GIFT_CARD_ITEM_ID) + Wave-0 API probes (payment_mode:'others', zero-tax) + validateEnv entry + deferral-journal cadence (GIFTCARD-01)
- [x] 44-02-PLAN.md — Apps Script adminApi.gs: GiftCards sheet + 7 actions (issue/lookup/redeem/reload/void/update-invoice/next-number) with LockService atomicity + last_tx_ref idempotency + manual redeploy (GIFTCARD-01)

**Wave 2** (parallel — disjoint middleware files)

- [x] 44-03-PLAN.md — routes/gift-cards.js: issue + next-number + lookup (fail-closed 503, dup-reject 409, zero-tax sale, void-on-Zoho-failure) + server mount + tests (GIFTCARD-01a/01b)
- [x] 44-04-PLAN.md — pos.js split-tender redemption (reduce terminal by gift_amount, two customerpayments, redeem_gift_card LAST, void-on-failure, tax untouched) + pos-gift-card.test.js (GIFTCARD-01c)

**Wave 3**

- [x] 44-05-PLAN.md — routes/gift-cards.js: reload (increment + sale accounting, fail-closed) + void routes + tests (GIFTCARD-01d/01e)

**Wave 4**

- [x] 44-06-PLAN.md — Issue/Reload "add value" modal on BOTH forked surfaces (kiosk.js inline + admin.js openModal), suggested cert pre-fill, rebuilt bundles (GIFTCARD-01a/01d UI)

**Wave 5**

- [x] 44-07-PLAN.md — Redeem tender (lookup → apply → split terminal) on BOTH surfaces + admin-only lookup/void management view + rebuilt bundles (GIFTCARD-01b/01c/01e UI)

**Wave 6**

- [x] 44-08-PLAN.md — Full gate + staging deploy (frontend + prod middleware) + iPad Safari UAT + REQUIREMENTS traceability (GIFTCARD-01). UAT round 1 found G-44-01 (phantom payment) → fixed by Wave 7 (44-09/44-10) → round 2 visible behavior verified. ⚠ Live terminal-sale checks (real card) DEFERRED by owner 2026-06-29; phase NOT production-promoted until they pass — see 44-08-UAT.md

**Wave 7** (gap closure — G-44-01 from 44-08 UAT: issue/reload recorded a phantom paid invoice with no terminal charge)

- [x] 44-09-PLAN.md — Middleware: pos.js prices a gift_cert cart line (zero-tax via KIOSK_GIFT_CARD_ITEM_ID, D-03) + activates cert on payment SUCCESS (issue_gift_card/reload_gift_card LAST, needs_manual_review on failure, no orphan) + confirm idempotency; decommission phantom-payment /issue+/reload routes (GIFTCARD-01a/01d)
- [x] 44-10-PLAN.md — Frontend (D-08): kiosk.js + admin.js issue/reload modal ADDS a gift_cert cart line (paid via real terminal checkout) instead of POSTing /issue|/reload; reload lookup pre-check; rebuilt bundles (GIFTCARD-01a/01d UI)

**UI hint**: yes

### Phase 45: Security and Money-Path Hardening (audit critical and high) ✅ COMPLETE 2026-07-02 (VERIFIED)

**Goal:** Close the verified CRITICAL and HIGH findings from the 2026-06-29 multi-agent audit (`AUDIT-2026-06-29.md`, 7 leads, 1 critical + 7 high, 0 refuted) — the public-key/auth-model exposure and the kiosk money-path weaknesses — plus safe quick-win containments, **without weakening the v4.2/v4.4-hardened online checkout path** (existing money-path tests must stay green).

**Requirements**: Audit remediation (CRITICAL + HIGH tier). Source: `AUDIT-2026-06-29.md`.
**Depends on:** Phase 44 (done). Coordinate with Phase 42 (Kiosk POS De-Fork, not started) — the shared money-path primitive extraction overlaps the de-fork; plan must decide whether to precede, fold in, or sequence around it.
**Plans:** 9/9 plans executed. **Verification:** 45-VERIFICATION.md — PASSED, 11/11 must-haves (D-01..D-05 absent by owner-approved split to Phase 46). Live-card UAT all 8 steps pass (45-09-SUMMARY.md).

**In scope:**

- **[CRITICAL] Auth-model exposure → MOVED to Phase 46** — admin API key (= Railway `API_SECRET_KEY`) is hardcoded in publicly-served, git-tracked `js/sheets-config.js:65` and loaded on ~13 public pages. Rotate the leaked key and re-architect staff-surface auth to server-side identity (reuse existing Google OAuth) so no shared secret ships to the browser. ⚠ Owner decision: interim containment (network/IP allowlist for the fixed in-store kiosk) vs straight to OAuth. **Split approved (2026-06-29) → see Phase 46.**
- **[HIGH] Unguarded PII GETs** — `/api/kiosk/salesorders` + `/api/kiosk/salesorder/:id` leak customer name/id/totals/line-items with no key check; add to `PII_GET_ROUTES` (quick containment).
- **[HIGH] Fail-open under Redis outage** — rate limiting (PIN brute-force, payment, checkout), distributed locks, and idempotency all silently disable during a Redis outage (the "MemoryStore fallback" comments are wrong). Make security-critical limiters/locks fail-closed or process-local.
- **[HIGH] Kiosk money-path = un-hardened re-impl of checkout.js** (the through-line) — extract `checkout.js` safety primitives (atomic `acquireLock`, error-propagating payment recording, void-on-failure, terminal-timeout reconciliation) into shared helpers used by both paths. Closes: non-atomic sale/confirm idempotency (double-charge/double-invoice), `confirm` swallowing payment-recording failures while returning 201 ok, terminal-timeout orphan charges with no reconciliation, and gift-card split-tender underpay (validate applied amount vs real balance + `needs_manual_review` on redeem failure).
- **[HIGH] CI artifact drift** — no CI step rebuilds/verifies the tracked `.min.js` artifacts GitHub Pages serves; add an artifact-drift check (exclude `Date.now()` cache-stamps).
- **Quick-win containments** — deploy already-committed `#2` (e8b81ce, API-key header-only) + `#10` (7c68f05, PII-log redaction) via `railway up`; `KIOSK_PIN` length-check before `timingSafeEqual` (misconfig → staff lockout); gitignore + remove `dump.rdb`.

**Out of scope** (defer to follow-on phases 46+): the 25 medium / 16 low / info findings — mobile-responsive (iOS auto-zoom inputs, <44px touch targets, safe-area), testing/CI (coverage floors for `pos.js`/`kiosk.js`, `--max-warnings 0` lint gate, ES5 lint rule, money-path E2E), webhook replay/dedup hardening, observability (Sentry on money-path catches), and dependency hygiene (`npm ci`, Node `engines` pin).

**Planned scope (this phase):** Waves 1-5 cover the Redis fail-open, money-path hardening, gift-card split-tender, reconciliation backstop, CI drift, PII guards, and quick-win containments (D-06..D-17). The auth re-architecture (D-01..D-05, the CRITICAL key exposure) is **split to Phase 46 (approved 2026-06-29)** — it contains a net-new device-credential mechanism (an open design decision) plus an owner-coordinated key-rotation cutover (D-04), and bundling it risks degrading the money-path plans' fidelity. Interim containment ships in Wave 1 (PII guards) + the audit's rotate-now option; residual key-validity-until-cutover risk is documented (D-04).

Plans:
**Wave 1** (parallel — disjoint files)

- [x] 45-01-PLAN.md — Quick-win code containments: guard 2 kiosk PII GETs (D-09), KIOSK_PIN length-check (D-15), gitignore dump.rdb (D-15)
- [x] 45-03-PLAN.md — Redis fail-closed policy: drop limiter skip → MemoryStore fallback + in-process acquireLock fallback + fix false comments (D-06/07/08)
- [x] 45-04-PLAN.md — CI artifact-drift check, stamp-normalized (D-10)
- [x] 45-05-PLAN.md — Extract lib/money-path.js from checkout.js + refactor checkout to consume it, no behaviour change (D-11)

**Wave 2**

- [x] 45-02-PLAN.md — Ship Wave-1 containments to prod Railway + verify (D-15) [checkpoint]
- [x] 45-06-PLAN.md — pos.js sale/confirm: atomic required idempotency + deterministic Helcim key + confirm propagates recording failure → void (D-12)

**Wave 3**

- [x] 45-07-PLAN.md — Gift-card split-tender balance validation + needs_manual_review + terminal-timeout pending-charge persist (D-12 + D-13 interface)

**Wave 4**

- [x] 45-08-PLAN.md — Reconciliation backstop: lib/reconcile.js + webhook reconcile + periodic sweep, match on reference_number (D-13)

**Wave 5**

- [x] 45-09-PLAN.md — Bundled live gift-card + money-path UAT on prod (with P44 deferred UAT, D-16) [checkpoint] — COMPLETE 2026-07-02, all 8 steps pass (45-09-SUMMARY.md)

### Phase 54: Gift-Card Management on the Kiosk Surface

**Goal:** Staff can do full gift-card management — balance **lookup** + **void** — directly from the staff-only standalone kiosk page, not only the admin panel. The owner runs everything from the kiosk and never uses the admin-embedded kiosk for sales, so gift-card management must live where the work happens.

**Requirements**: Owner-requested (post-Phase-48). Extends KIOSK-01's "single shared kiosk surface" intent to gift-card management.
**Depends on:** Phase 48 (kiosk de-fork — builds on `js/kiosk-core.js` and the injected `buildAuthOptions()` per-surface auth). Phase 48 is on staging awaiting iPad UAT; **Phase 54 should land before that UAT so both are verified in one iPad session.**

**Two parts:**

1. **Backend** — add `/api/kiosk/gift-card/void` to the `KIOSK_ROUTES` device-token allowlist in `zoho-middleware/lib/authTiers.js` so the kiosk device token may void a certificate. This **consciously SUPERSEDES D-46-02 / T-46-07** (void was session/admin-only). Owner decision **D-54-GC**; residual risk (a leaked device token could void a *status-only* cert — no cash movement, non-empty reason required) explicitly accepted. Flip the two existing `device→403 on gift-card/void` tests (`auth-tiers-guard.test.js` test 3, `pos-auth-tier.test.js` test 3) to expect not-403 + add positive coverage. Device negative-scope coverage stays intact via the existing PII-GET / BrewPad-GET / admin-GET `device→403` tests.
2. **Frontend** — author a **kiosk-native** Gift Card Management panel (lookup + void, `kgcm-*`). The existing modal lives only in `js/admin.js` on admin's `openModal`/`closeModal` (absent on the kiosk page), so build fresh in `js/kiosk-core.js` (shared, via injected `buildAuthOptions()` → `x-device-token` on kiosk / cookie on admin), mirroring the existing `kgcr-` redeem-modal pattern, with markup + an entry button in `kiosk.html`. Rebuild bundles; add a frontend regression test.

**Pre-planning gate:** Run `/gsd:discuss-phase 54` to lock the kiosk modal-container approach + void-confirmation UX before `/gsd:plan-phase 54`.

Plans: 3 plans across 3 waves

- [x] 54-01-PLAN.md — Backend: add /api/kiosk/gift-card/void to KIOSK_ROUTES (D-54-GC) + flip 2 device→403 tests to not-403 + dual-suite gate
- [x] 54-02-PLAN.md — Frontend: kgcm- lookup+void panel in kiosk-core.js + settings-gated entry in kiosk.html/kiosk.js + rebuild bundles
- [x] 54-03-PLAN.md — Frontend regression test: device-token lookup+void path + reason-required void gate

### Phase 67: Kiosk tax quote-charge correctness — pre-charge total assertion, remove silent 5% tax fallbacks, client catalog freshness

**Goal:** Close the kiosk quote≠charge seam (INV-000160): make any divergence between the kiosk-displayed total and the server-charged total LOUD (fail-closed before charging) and remove every silent 5% tax guess. Server anchors all pricing to the catalog and now asserts the client's displayed total against its own before charging; the client stops guessing tax and flags missing-tax items instead; the parked-kiosk stale-catalog exposure is closed with a cart-lifecycle refresh.

**Requirements**: KIOSK-TAX-QUOTE-01 (owner-reported defect; source: `.planning/debug/kiosk-tax-under-quote.md` + owner handoff — not a REQUIREMENTS.md ID)
**Depends on:** Phase 66
**Plans:** 3/3 plans complete

Plans:

- [x] 67-01-PLAN.md — Middleware (wave 1, deploy first): remove computeTax silent 5% guess (fail-closed 400 naming the item) + pre-charge assertion (client_grand_total vs server grandTotal, ±$0.01) + update 2 pinned 5%-fallback tests + new assertion/compound-tax tests
- [x] 67-02-PLAN.md — Frontend (wave 2, deploy after middleware): remove client 5% fallback + flag-and-block missing-tax item by name + reconcile kioskItemTax + send client_grand_total/client_tax_total + cart-lifecycle catalog refresh + rebuild kiosk-core.min.js + frontend tests
- [x] 67-03-PLAN.md — Live verification (wave 3, checkpoint): real compound-tax kiosk sale proves quote == charge == Zoho invoice; assertion rejects a divergent total

### Phase 68: Kiosk terminal-push latency + cancel double-charge safety — instrument the sale pipeline, guard the cancel/orphan window

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 67
**Plans:** 2/3 plans executed

Plans:

- [ ] TBD (run /gsd-plan-phase 68 to break down)

### Phase 69: BrewPad batch-view UX — mark-bottled reflects without refresh (gds cache bust + dashboard refetch) and a Ready-to-Bottle filter on the batch view

**Goal:** Completing the Bottling/Packaging task on a batch removes it from Ready-to-Bottle immediately with no page reload, and the batch view has a first-class "Ready to Bottle (N)" filter matching the dashboard's server-computed set. Client-only (no Apps Script change — the server already busts the `gbds` dashboard cache on every task write).
**Requirements**: None (owner-ticket UX phase; 69-CONTEXT.md decisions are the requirement source). Source tickets: brewpad-bottled-status-stale-ui, brewpad-ready-to-bottle-filter.
**Depends on:** Phase 68
**Plans:** 2/2 plans complete

Plans:

- [x] 69-01-PLAN.md — Mark-bottled freshness: refetch dashboard (loadDashboard) after task writes in all three checkbox handlers
- [x] 69-02-PLAN.md — Ready-to-Bottle filter on the batch view, reusing _dashSummary.readyToBottle as the source of truth

### Phase 70: Kiosk tender types — cash tender (change-due, gift-card split) and phone-order card via HelcimPay hosted iframe (no PAN in our code)

**Goal:** Kiosk staff can take cash and phone-order (card-not-present) payments. Cash books a Zoho `payment_mode:'cash'` sale with a client-side change-due calculator and gift-card split and no terminal; MOTO charges the card only inside Helcim's hosted iframe (PAN never touches our code — PCI SAQ-A) and books only after a server-side captured-amount verification — all reusing the existing hardened kiosk money-path pipeline (idempotency, void-on-failure) without forking it.
**Requirements**: Owner ticket (2026-08-11) — no ROADMAP req IDs; CONTEXT.md locked decisions are the requirement source. Tracked as KIOSK-CASH (`.planning/todos/pending/kiosk-cash-tender.md`) + KIOSK-MOTO (`.planning/todos/pending/kiosk-manual-card-entry-moto.md`, Option B).
**Depends on:** Phase 69
**Plans:** 2/3 plans executed

Plans:

- [x] 70-01-PLAN.md — Cash tender: server `tender:'cash'` branch (skip terminal, book payment_mode:'cash', idempotent, gift+cash split) + kiosk Cash button & change-due UI
- [x] 70-02-PLAN.md — MOTO via HelcimPay: server init + captured-amount verify before booking + kiosk phone-order button/iframe + kiosk.html first CSP
- [ ] 70-03-PLAN.md — Live-verify checkpoint (autonomous:false): real cash sale + real HelcimPay charge (refunded) + CSP live-verified on staging before prod

### Phase 71: Kiosk SO-collect reconciliation — finalize invoice (sent/open) + apply payment to the invoice, not the sales order

**Goal:** A charged kiosk SO collection reconciles in Zoho like `processSale` — the SO's invoice is finalized (sent/open) then paid (balance 0), with the customerpayment applied to the invoice (unused_amount 0), never left as an orphaned advance against the sales order. Post-charge failures fail closed with a recoverable reconcile record. The sibling online SO-deposit path (checkout.js) is fixed the same way.
**Requirements**: Owner money-path ticket (no REQ IDs). Source: `.planning/debug/kiosk-so-collect-draft-unapplied.md` + `71-CONTEXT.md` decisions D1-D4.
**Depends on:** Phase 70
**Status:** ✅ COMPLETE — staging-verified 2026-08-22 (SO-000079 → INV-000180 paid, payment applied unused_amount 0, no duplicate). Production cutover pending (`docs/PROD-DEPLOY-70-71.md`).
**Plans:** 3/3 plans executed

Plans:

- [x] 71-01-PLAN.md — Core fix: webhooks collect APPROVED path convert/reuse+submit+apply-to-invoice, dedup finalize helper, fail-closed reconcile writer, tests
- [x] 71-02-PLAN.md — Dead-code cleanup: remove the unreachable salesorders_to_apply else-branch at checkout.js:693 (dead since f6d6e52dc) + invariant guard + regression lock (NOT a money-path fix)
- [x] 71-03-PLAN.md — Live-verify checkpoint: verified on staging 2026-08-22 via replay helper against the deployed fix — SO-000079 collect booked a single finalized paid invoice (INV-000180, balance 0) with the payment applied (unused_amount 0); owner-approved. See 71-03-SUMMARY.md

### Phase 72: Beer and Cider launch announcement pages (beer.html + cider.html) — booking-flow CTA, nav + homepage feature, placeholder content

**Goal:** Ship two on-brand, one-time launch announcement pages — `beer.html` ("now offering beer") and `cider.html` ("now offering 100% Okanagan Juice Cider") — that mirror existing top-level pages exactly (shared header/nav/footer, `<head>`+CSP+OG boilerplate, `css/` classes, ES5-only, CSP-clean), each announcing availability & dates + price & how-to-order and driving ONE action. Primary CTA wired to the existing ferment-session **booking flow** (`/api/bookings` + Cal.com, reusing the current booking component — no rebuild). Add Beer + Cider to the nav across all pages and feature them on `index.html`; pages cross-link. Frontend-only; no middleware changes expected. Built with **placeholder** price/dates/CTA content (owner fills real values before production promotion) on a feature branch on staging — prod promotion left to the owner.
**Requirements**: Owner product-launch ticket (no REQ IDs). Off-theme for the v4.5 money-path milestone. Source/spec: `.planning/todos/pending/beer-cider-launch-pages.md` (full spec, locked decisions, and the "placeholders to fill before promotion" checklist).
**Depends on:** None (independent frontend work; reuses existing booking endpoints as-is).
**Plans:** 3/3 plans complete

Plans:
**Wave 1**

- [x] 72-01-PLAN.md — Author beer.html + cider.html (about.html shell + index.html primitives, placeholder content, booking CTA, cross-links, head/CSP/OG); register in sitemap.xml + package.json stamp:pages; build/lint/test

**Wave 2**

- [x] 72-02-PLAN.md — Site-wide Beer/Cider nav across all 17 public pages + homepage launch banners + reconcile stale "Beer Is Coming" waitlist banner; rebuild/stamp

**Wave 3**

- [x] 72-03-PLAN.md — Promote-steps runbook + owner human-verify checkpoint (placeholder-fill + banner disposition); feature branch handoff, no prod deploy

### Phase 73: Recipe dynamic pricing unit-conversion correctness — unit-aware ingredient cost helper + pack-granularity, quote=displayed=sale invoice=stock draw-down

**Goal:** Fix the High-priority money-path bug where recipe dynamic pricing multiplies `item.rate × recipe_line.quantity` with NO unit conversion, so a per-kg/per-L bulk item consumed in g/ml is charged ~1000× too high (recipe `SV-R-000004` computes $1,896.98 vs expected ~$88–95). Introduce ONE shared unit-aware `ingredientLineCost(item, line)` helper (mass g↔kg, volume ml↔L, count pcs/ea/pack pass-through; reject non-convertible pairs instead of silently multiplying) and call it from EVERY ingredient-cost sum-site so they can never diverge: recipe `computed_price` (list+detail, `routes/recipes.js`), `GET /api/kiosk/recipe-quote`, and the pos-recipe sale path that builds Zoho invoice lines + draws down stock (`routes/pos-recipe.js`) — same conversion for the stock decrement. Resolve pack-granularity for multi-unit pack items (Whirlfloc 25-tablet pack) and fix the invalid `L` unit on that recipe line. Add unit validation/normalization on recipe save (`apps-script` create/update). Acceptance: `SV-R-000004` ≈ $88–95; kiosk quote == displayed price == actual sale invoice + stock draw-down; recipes can't be saved with an un-convertible unit/rate mismatch. Full diagnosis + evidence in `73-PRICING-BUG-HANDOFF.md`.
**Requirements**: Owner bug report 2026-08-25 (money-path correctness; on-theme for v4.5 money-path milestone). Source: `73-PRICING-BUG-HANDOFF.md` (+ staging `feedback-log.md`).
**Depends on:** Phase 72 (chronological only). Touches `zoho-middleware/` (recipes/pos-recipe routes, `lib/recipe-scaling.js`) + `apps-script/`.
**Plans:** 7/7 plans complete

Plans:
**Wave 1**

- [x] 73-01-PLAN.md — Unit-conversion helper foundation (ingredientLineCost/classifyUnit + in-file sums + imperial audit)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 73-02-PLAN.md — Wire read-path computed_price (recipes.js detail+list) + SV-R-000004 regression
- [x] 73-03-PLAN.md — Wire sale/stock path (pos-recipe.js) — quote==sale==stock draw-down + tiered fail-closed/void

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 73-04-PLAN.md — D-03 save-time unit validation (POST/PUT /api/recipes) + machine-readable code/cause

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 73-05-PLAN.md — D-05 recipe-editor save resilience (draft-preserve, non-2xx detection, retry) + rebuild brewpad.min.js

**Gap closure** *(CR-01/CR-02 from 73-REVIEW.md — same unit-mismatch bug class on stock gates + editor preview; opened 2026-08-25)*

- [x] 73-06-PLAN.md — Unit-aware stock gate: fix checkScaledStock (CR-01) + availability endpoint (WR-01) to convert before comparing to stock_on_hand; fail closed on non-convertible
- [x] 73-07-PLAN.md — Unit-aware BrewPad recipe-editor preview: add bpIngredientLineCost mirror + wire Cost/Retail/Totals sites (CR-02) + rebuild brewpad.min.js

### Phase 74: Beer/Wine catalogue pages under Ferment-in-Store — wine gets its own page, ferment-in-store becomes an informational hub, first public recipe surface (cider deferred)

**Goal:** Build category-scoped catalogue pages for **wine and beer**, and rewrite `products/ferment-in-store.html` into an informational hub. Each category page lists BOTH kits and recipes in two separate blocks (larger set leads; empty blocks are not rendered). `/beer` stays at its existing root URL and KEEPS its launch copy and waitlist — the catalogue is added below it, not in place of its hero. `/wine` is new, also at the root, and takes over the wine catalogue grid; the hub keeps a prominent wine section retaining its "Make Your Own Wine in Squamish" ranking copy, so only one wine catalogue exists and no canonical tag is needed. This is also the first PUBLIC surface for recipes (staff-only in BrewPad until now): public listing is constrained to `status=active`, enforced **at the endpoint** — `GET /api/recipes` currently has no tier guard and serves drafts with computed prices to anyone — and a public card exposes only name/style/price/blurb, never ingredients or cost-derivable data. Card actions vary by category (wine kits keep add-to-cart, beer leads to the waitlist) and filter sets are per-category (wine keeps body/oak/sweetness; beer gets style/abv). A content pass over active recipe descriptions is in scope and gates release.
**Requirements**: Owner direction 2026-08-25, refined by discuss-phase 2026-08-31 (see `74-CONTEXT.md`, decisions D-01..D-13). Beer pricing was deferred to this phase's catalogue on 2026-08-31, which makes the public recipe surface load-bearing rather than optional.
**Depends on:** Phase 72 (beer page) and the 2026-08-31 beer content work. Independent of Phase 73.
**Deferred out of scope:** `/cider` and its launch copy (11 kits in stock, but `cider.html` was deleted 2026-08-27 and launch intent is unconfirmed); ingredient lists on public cards.
**Superseded roadmap items:** "remove the top-level Beer/Cider nav from 72-02" is DONE (2026-08-31, Beer now sits under Products → Ferment in Store). "Rebuild beer.html/cider.html in this layout (replacing the announcement hero)" is REVERSED — beer's hero is kept; cider.html does not exist.
**Open for research:** how many recipes are `active`, and their wine/beer split — this sizes the release-gating content pass and determines whether the wine recipe block is meaningful.
**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 74-01-PLAN.md — Tier-guard GET /api/recipes + /api/recipes/:id: active-only for anonymous callers plus a name/style/price/blurb field allowlist, regression-test-first (D-05/D-06/D-07) [autonomous:false]
- [x] 74-02-PLAN.md — Category-scope loadProducts(categoryFilter), swap the beer card's cart controls for the waitlist CTA, per-category filter sets incl. the net-new ABV field (D-01/D-09/D-12/D-13)
- [x] 74-04-PLAN.md — Author wine.html at the root with CSP + two-block DOM contract, register it in nav/sitemap/stamp:pages, add all four new CSS rules (D-01/D-04/D-09/D-13)

**Wave 2**

- [x] 74-03-PLAN.md — Public recipe block: fetch, recipe card, dynamic block order with kits leading a tie, zero-item suppression, per-block error isolation (D-01/D-02/D-03/D-04/D-05/D-07)
- [x] 74-05-PLAN.md — Rewrite ferment-in-store.html into a neutral hub keeping its wine ranking copy, insert the catalogue into beer.html below its launch copy (D-10/D-11/D-12/D-13) [autonomous:false]

**Wave 3**

- [x] 74-06-PLAN.md — wine/beer page dispatch + fix the shipped unwired beer waitlist form, npm run build, both full suites, D-08 content pass, browser verification (D-01/D-03/D-08/D-09/D-11/D-12) [autonomous:false]

### Phase 75: BrewPad invoice→pending-batch quantity expansion — multi-qty kit lines create N pending batches, not 1

**Goal:** Fix the bug where a Zoho invoice containing quantity > 1 of the same kit produces only ONE pending batch in BrewPad instead of one pending batch per unit. Reported by owner 2026-08-25 with concrete evidence: **INV-000171** (3 × the same kit) surfaced a single pending batch in BrewPad rather than 3. Root cause is in the invoice→pending-batch ingestion/derivation path (line-item quantity is not expanded into per-unit batches; the code likely keys/dedupes pending batches by invoice line or kit SKU without honouring `quantity`). Scope: locate the invoice→pending-batch derivation (BrewPad batch list is fed from Zoho invoices — see the Phase 63 "Batch↔Invoice Reconciliation Model" and Phase 62 inventory-consumption work for the ingestion model), expand multi-qty kit lines into `quantity` distinct pending batches with stable per-unit identity/idempotency (so re-ingestion doesn't duplicate), and add a regression test using an INV-000171-shaped invoice (qty 3 → 3 pending batches). Confirm interaction with any existing batch↔invoice reconciliation/dedup so the fix doesn't create duplicate batches on re-poll.
**Requirements**: Owner bug report 2026-08-25 (BrewPad batch-ops correctness). Evidence: invoice `INV-000171` (3 × one kit → 1 pending batch observed, 3 expected). Needs diagnosis pass at discuss/research time to pin the exact ingestion site.
**Depends on:** Chronological only. Related subsystems: Phase 62 (Inventory Consumption Sync), Phase 63 (Batch↔Invoice Reconciliation Model). Independent of Phase 73/74. Touches `zoho-middleware/` batch/invoice ingestion + `brewpad.js` batch list rendering (exact sites TBD in discuss/research).
**Plans:** 2/2 plans complete

Plans:

- [x] 75-01-PLAN.md — Fix bulk-create: set unit_total + planKitBatches so multi-qty kit lines create N pending batches (D-01/D-02/D-04), regression-test-first
- [x] 75-02-PLAN.md — BrewPad "Unit X of N" per-unit label on multi-unit batch groups (D-03), test-first + bundle rebuild

### Phase 76: BrewPad session-expiry hardening — decouple the durable 7-day sv_session from the ephemeral Google token so a silent-refresh/Apps-Script 401 no longer forces a full re-login

**Goal:** Stop BrewPad from spuriously showing "Session expired" and forcing a full Google re-login while the durable 7-day server session is still valid. Diagnosed during Phase 73 staging verification (2026-08-26). Root cause: BrewPad runs TWO credentials — a durable 7-day `sv_session` (in `localStorage` as `sv_session_token`, sent as `x-session-token`, authorizes the **middleware**: recipes/ingredients) and an ephemeral ~1 hr **Google OAuth access token** kept alive by GIS silent refresh (`brewpad.js:1250`, ~50 min) that authorizes the **Apps-Script "admin API"** (batches/dashboard/readings, posts the Google token in-body, `adminApiGet` `brewpad.js:1388`). When GIS silent refresh fails (third-party-cookie restrictions, embedded/automated contexts) OR an Apps-Script response merely contains the substring "unauthorized"/"not authorized" (`isUnauthorizedError`, `brewpad.js:1376-1378`), `handleUnauthorized()` (`brewpad.js:1344`) calls `clearSession()` which **deletes the still-valid `sv_session_token`** (`brewpad.js:1352,961`) → full re-login, and subsequent middleware calls also 401 ("Could not load recipes"). Scope (regression-test-first per CLAUDE.md #3): (1) don't wipe `sv_session` on a Google-token/Apps-Script 401 — only `clearSession()` when the **middleware** rejects `x-session-token`; for an Apps-Script "unauthorized," attempt a silent Google refresh and keep the app usable via middleware endpoints; (2) tighten `isUnauthorizedError` to an explicit status/flag instead of a loose error-text substring match; (3) graceful GIS-refresh-failure UX — if silent refresh fails but `sv_session` is valid, show a non-blocking "reconnect" affordance, not the full-login modal. Stretch/decision (defer or fold): (4) unify BrewPad onto the single `x-session-token` credential by moving the remaining Apps-Script admin reads behind the middleware. Non-code sibling for owner: review the **Cloudflare Access** session-duration policy for `staging.steinsandvines.ca` (dashboard setting) if staff also re-hit the CF login often.
**Requirements**: STAFF-AUTH (BrewPad session resilience). Source: Phase 73 staging-verification diagnosis 2026-08-26.
**Depends on:** Chronological only. Independent of Phase 73/74/75. Related: Phase 46 (Auth Re-Architecture — introduced the `sv_session`/`x-session-token` model). Touches `js/brewpad.js` (+ `js/brewpad.min.js` rebuild), possibly `js/lib/auth.js`; frontend-only unless fix #4 is folded in (then `zoho-middleware/`). Vanilla ES5; `npm test` + `npm run lint` before commit.
**Plans:** 3 plans across 3 waves

**Status:** Implementation COMPLETE + verified (2026-08-27) — all 3 plans executed, 11/11 must-haves verified, frontend 1151/1151 + middleware 1459/1459 green, lint clean. Verifier found + closed one D-03 gap (residual `clearSession()` in `onTokenResponse` GIS-error path, fix `d79084b3`). Verdict `human_needed`: two live carry-forwards remain — (a) iPad Safari session-survival UAT, (b) staging→prod deploy (Apps-Script already owner-redeployed + live-probed; middleware + frontend not yet pushed). See `76-VERIFICATION.md`.

Plans:
**Wave 1**

- [x] 76-01-PLAN.md — Apps-Script write-allowlist extension (10 actions) + owner redeploy checkpoint + live read-probe (A2) [autonomous:false] ✅ owner-redeployed + live-verified

**Wave 2**

- [x] 76-02-PLAN.md — Middleware /api/batch/admin-proxy (allow-listed server_token proxy) + touchSession sliding-expiry wiring + middleware tests ✅

**Wave 3**

- [x] 76-03-PLAN.md — Frontend single-credential migration: repoint adminApiGet/adminApiPost, global middleware-401 interceptor, DELETE dual-token machinery + regression tests + build/lint/test gate ✅

### Phase 77: Ferment-in-store catalog filter panel UX: scrollable compact filters, reclaim wasted width, mobile-friendly ✅ COMPLETE 2026-08-28

**Goal:** Make the "Filters & Sort" panel on the Ferment-in-Store catalog (`products/ferment-in-store.html`) usable and compact instead of an overwhelming, page-dominating wall of chips. Owner UI report 2026-08-28 (with screenshot): on the Wine catalogue (238 kits → dozens of Brand/Style/Producer chips) the opened panel expands to an enormous inline height you can't scroll independently, while wasting most of the horizontal width.

**Root causes (found during triage, pre-planning):**

- `.catalog-filter-row` is hard-coded `width: 40rem` with `padding-left: 8.5rem`, and `.catalog-collapsible.open` centers rows (`align-items: center`). On wide screens this leaves ~380px empty on each side and forces long chip groups (e.g. 20 Brand chips) to wrap into ~7 stacked rows → the panel becomes very tall. (`css/styles.css:2008-2041`)
- `.catalog-collapsible.open` has **no `max-height` and no `overflow`** — it expands to the full natural height of all filter groups with no self-contained scroll region, pushing the product grid far down. (`css/styles.css:2016`)
- Shared component caveat: the `.catalog-*` panel styles live in `css/styles.css` and are ALSO used by `products.html`; there is a separate `#mobile-catalog-bar` mobile variant (`css/styles.css:6636+`) plus `@media` overrides (`~2897`, `~6818`). The fix MUST verify desktop + mobile on BOTH the ferment-in-store subpage and products.html, and the mobile sticky filter bar. Markup: `products/ferment-in-store.html:180-219`; filter render logic: `js/modules/16-catalog-subpage.js` (+ the shared catalog module that renders `products.html`).

**Scope:** Frontend-only (CSS-led; JS only if the interaction model changes). No middleware. Likely `css/styles.css` (+ `css/catalog-subpage.css`), possibly `js/modules/16-catalog-subpage.js`.

**Design direction — LOCKED (owner, 2026-08-28): "Compact + scrollable (CSS-led)."** Do NOT redesign the interaction model (no collapsible sub-groups, no off-canvas drawer). Two targeted CSS changes: (1) let filter rows fill the full available container width so chips flow into many columns instead of a fixed 640px centered strip (remove/relax `.catalog-filter-row { width: 40rem }` + the centered `align-items` — keep the right-aligned label affordance but stop wasting side space); (2) give `.catalog-collapsible.open` a capped height (~60vh, tune) with `overflow-y: auto` so the panel becomes an internal scroll region instead of expanding to full natural height. Must hold up on desktop + mobile, on BOTH `ferment-in-store.html` and `products.html`, and respect the `#mobile-catalog-bar` sticky variant. Prefer no JS change unless the label/column layout needs it. Verify with the real Wine catalogue (238 kits, the worst case).

**Requirements**: UX-CATALOG-FILTERS (catalog filter panel usability). Source: owner UI report 2026-08-28.
**Depends on:** Phase 76 (none functionally — independent frontend polish)
**Plans:** 1 plan

Plans:

- [x] 77-01-PLAN.md — Cap desktop catalog filter panel at ~60vh w/ internal scroll + reclaim full-width chip rows (CSS-led, styles.css base rules) + build + responsive UAT ✅ 2026-08-28 (UAT approved, deployed staging + prod)

---

### Phase 78: BrewPad waitlist tracking — make the beer waitlist a workable internal list, not just a MailerLite group

**Goal:** Give staff a way to see and work the beer waitlist inside BrewPad. Today `POST /api/waitlist` (`zoho-middleware/server.js:211`) validates the email and hands it to MailerLite (`mailerlite.addSubscriber`, optionally into `MAILERLITE_WAITLIST_GROUP_ID`) — and that is the entire record. Nothing is stored anywhere staff can read, so there is no way to see who is waiting, how long they have waited, or who has already been contacted.

**Why this matters now:** Phase 74 made the waitlist load-bearing. `beer.html` tells customers "Beer batches are booked ahead, and we work through the list in order", and after the Phase 74 UAT revision the waitlist is the ONLY route into the ferment-in-store beer experience — beer kit cards now sell take-home kits, and the waitlist CTA lives on recipe cards. The site promises an ordered queue that no internal tool can actually show.

**Source:** Owner direction 2026-09-01, during Phase 74 staging UAT.

**Scope sketch (confirm at discuss-phase):** BrewPad surface listing waitlist entries with signup timestamp and status; staff can mark an entry contacted/booked/removed; ordering reflects the "we work through the list in order" promise. Needs a durable store — the current flow keeps no record on our side, so where entries live (Apps Script sheet, Zoho, or middleware-side) is the first real design decision. MailerLite stays the marketing sync; it is not the system of record.

**Open questions for discuss-phase:**

- Where do waitlist entries live? MailerLite is not queryable as an ordered work list; Phase 74 research did not cover this.
- Does an existing entry need linking to a customer/batch once they book, or is it a standalone list?
- Is the beer waitlist the only one, or does this generalize (wine, cider, classes)?
- Does removing/booking someone need to write back to the MailerLite group, or only to our store?

**Depends on:** Phase 74 (which wired the form and made the waitlist the sole ferment-in-store route for beer). Independent of the Phase 74 production deploy.
**Requirements**: No REQ-IDs mapped. Traceability runs through the locked CONTEXT.md decisions D-01..D-08, each cited in at least one plan's `must_haves`.
**Plans:** 4/4 plans complete

Plans:

**Wave 1**

- [x] 78-01-PLAN.md — Apps Script: `Waitlist` tab schema, fail-closed bootstrap, pure dedupe decision, and the add/list/update handlers + dispatch (D-01, D-02, D-05, D-06, D-07, D-08)
- [x] 78-02-PLAN.md — Middleware: make the sheet write authoritative in `POST /api/waitlist`, demote MailerLite to fire-and-forget, allow-list the two BrewPad actions on the admin proxy (D-03, D-06, D-07)
- [x] 78-03-PLAN.md — BrewPad: sixth Waitlist tab — ordered queue table, one-way status cycle, Remove, inline notes, sync pill and filters (D-02, D-05, D-07, D-08)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 78-04-PLAN.md — Cutover: owner Apps Script redeploy, D-04 MailerLite timestamp gate + backfill, staging deploy and end-to-end UAT (D-01, D-04, D-05, D-07)

---

### Phase 79: Apps Script recipe-save performance — updateRecipe times out at 15s, renaming a recipe is impossible

**Goal:** Make recipe saves complete well inside the middleware's 15s Apps Script timeout. Today `updateRecipe` in `apps-script/adminApi.gs` performs ~54 Sheets round-trips for a 13-ingredient recipe and reliably exceeds the ceiling, so `PUT /api/recipes/:id` returns 502 and **no recipe can be saved at all** — including a pure rename.

**Evidence (owner-reported 2026-09-01, diagnosed in-browser 2026-09-02):** two independent saves of SV-R-000002 took 15287ms and 15313ms against a `timeout: 15000` (`zoho-middleware/routes/recipes.js:25`), both returning 502. Payload is only 4.7KB / 13 ingredients — size is not the cause.

**Root cause:** N+1 Sheets round-trips. `generateNextId` reads an entire column and is called *inside* the per-ingredient insert loop (13 full column scans); ingredient rows are deleted one at a time via `deleteRow` and re-inserted one at a time via `appendRow`; the recipe row's 12+ fields are written with individual `setValue` calls. Compounding it, `updateRecipe` rewrites the whole ingredient list whenever `payload.ingredients !== undefined` — and `buildRecipePayload` always sends it — so editing only the *name* deletes and recreates every ingredient row.

**Fix direction (ordered by value-per-risk, see the note for detail):**

1. Skip the ingredient rewrite entirely when the incoming ingredients match the stored rows — makes a rename near-free.
2. Hoist `generateNextId` out of the insert loop (compute max once, increment in memory).
3. Batch inserts into a single `setValues()`.
4. Collapse consecutive `deleteRow` calls into `deleteRows(start, count)`.
5. Batch the recipe-row field writes into one read + one `setValues()`.

Target: ~54 round-trips → ~5. Do NOT simply raise the middleware timeout — that hides a fragile write.

**Also in scope (decide at planning):** ingredient IDs churn on every save (`ingredient_id` is sent but discarded and regenerated), so nothing can hold a stable reference to a recipe ingredient.

**Constraint:** `apps-script/adminApi.gs` is vendored here but executes in Google's environment — it cannot be verified locally and **requires an owner redeploy**. Plan for a live probe after deploy rather than test-suite proof.

**Deferred (explicitly NOT this phase):** migrating off Google Sheets to Postgres. Assessed 2026-09-02 and deferred — the timeout is caused by round-trip count, not data volume, and would likely be carried into any new store. Revisit after this phase's measurements. The genuine long-term drivers are the global script lock, absence of transactions, and unindexed scans — not row counts. See `.planning/notes/recipe-save-performance-and-sheets-scaling.md`.

**Requirements**: RECIPE-SAVE-01 (owner-reported blocker 2026-09-01; no formal requirement id existed, so the phase-local id `RECIPE-SAVE-01` stands in). Source: `.planning/notes/recipe-save-performance-and-sheets-scaling.md`.
**Depends on:** none (independent of Phase 74; the two causes that masked this one are already fixed and deployed)
**Plans:** 4/4 plans complete (4 waves, strictly sequential — 79-01 was a diagnosis gate that could stop the phase, and 79-02/79-03 both edit `apps-script/adminApi.gs` so all `.gs` edits landed before the single owner redeploy in 79-04)

**Status:** ✅ COMPLETE — Apps Script redeployed by owner 2026-09-02 (previous version **v49** = rollback target; new version number not captured). **Recipe saves work again.**

- **Diagnosis (79-01):** CONFIRMED from production logs — three verbatim `[api/recipes] PUT SV-R-000002 failed: timeout of 15000ms exceeded` lines, no other error class present.
- **Probe B — the strong evidence:** ingredient ids `RI-000171`..`RI-000183` on SV-R-000002 survived a rename save *plus* several unit-correction saves. Structurally impossible under the old code, which discarded the sent `ingredient_id` and reminted all 13 on every save. D-09 verified.
- **Probe C — the abort gate:** PASSED. A real changed-ingredients save (the owner's unit corrections) persisted; no rollback needed. This also exercised the *changed* branch, complementing the rename-only save's *unchanged* branch.
- **Probe A — qualitative only:** owner reported "quick and clean" against a 15287ms/502 baseline, but **no millisecond figure was captured**. Corroborated (not proven) by zero timeout/error/lock lines in production Railway logs across the save window — the PUT handler logs only on failure, so absence of errors is consistent with success rather than positive proof.
- **Probe D — NOT RUN:** the `ingredients_unchanged` / `ingredients_written` / `row_write_mode` diagnostics were never read from a direct Apps Script POST, so the D-04 skip is **inferred** from id stability and latency rather than directly observed.

See `79-04-SUMMARY.md`. Follow-ups carried forward (not fixed here): `bustRecipeCache()` omits `RECIPE_AVAILABILITY:<id>` (`zoho-middleware/routes/recipes.js:48-58`, TTL 600s — same class as the Phase 69 `gds` gap); and confirm the stale out-of-stock banner on SV-R-000002 has cleared now that its units are corrected.

Plans:

- [x] 79-01-PLAN.md — Confirm the timeout diagnosis from the Railway `[api/recipes] PUT ... failed:` log line before spending the owner's redeploy (D-12); STOP the phase if it contradicts
- [x] 79-02-PLAN.md — Test-first pure helpers for the D-04 ingredient comparison and D-05 hoisted id minting, plus a Jest harness that evaluates the real `adminApi.gs` (also becomes its first syntax gate)
- [x] 79-03-PLAN.md — Rewrite `updateRecipe`: skip-when-unchanged, batched deletes/inserts, batched row write, stable ingredient ids, local lock retune (D-04..D-10, D-15)
- [x] 79-04-PLAN.md — Owner redeploys Apps Script and live-probes: rename returns 200 well under 15s, ingredient ids survive, a real ingredient edit still persists (D-11, D-13)

---

### Phase 80: BrewPad waitlist — work the queue ✅ COMPLETE

**Goal:** Turn the beer waitlist from a list staff *read* into one they *work*. Phase 78 made the `Waitlist` sheet the system of record and gave BrewPad a read-and-advance tab; this phase adds the four things that let staff actually run the queue: link a row to its Zoho customer, link it to the recipe that person is going to brew, contact them from BrewPad, and override the queue order by hand when reality demands it.

**Why this matters now:** Phase 78 shipped the queue but staff still leave BrewPad to do anything with it — look the customer up in Zoho, find their recipe, write an email. And the order is strictly chronological, with no way to move someone up when a batch frees early or they call to reschedule.

**Source:** Owner direction 2026-09-04, immediately after Phase 78 completion.

**Depends on:** Phase 78 (the `Waitlist` tab, its three Apps Script handlers, the admin-proxy allow-list, and the BrewPad tab this extends)

**Requirements**: No REQ-IDs map to this phase. Coverage unit is `80-CONTEXT.md` decisions **D-01 through D-25** (all locked at discuss-phase); every one is referenced by at least one plan.

**Scope sketch (confirm at discuss-phase):**
- **Customer link** — associate a row with a Zoho contact. `/api/contacts/search` already exists (used by POS). Needs an identity rule for signups whose email matches no contact, which Phase 78 deferred explicitly as needing its own decision.
- **Recipe link** — associate a row with the recipe that person will brew. `get_recipes`/`get_recipe` already exist in `adminApi.gs`.
- **Contact action** — a button that reaches the customer from BrewPad. Mechanism (mailto vs a logged/templated send), and whether it auto-advances status to `contacted`, are open.
- **Manual reorder** — staff override of queue position.

**Known constraints (carried from Phase 78):**
1. **The `Waitlist` tab gains columns, and `ensureWaitlistSheet` fails closed on missing ones** (returns `waitlist_unavailable`, never repairs headers). The migration order is load-bearing: **add the columns to the sheet FIRST, then redeploy**. Deploying first takes every signup down with a 503 until the columns land. Old code maps by header name and ignores unknown columns, so adding first is safe.
2. **`apps-script/adminApi.gs` has no CI deploy path**, and one Web App deployment serves staging AND production. The redeploy is a manual owner step and is effectively a production release for that layer. This is why all four features are one phase — one migration, one redeploy.
3. **~~Manual reorder contradicts the customer-facing promise.~~ RESOLVED 2026-09-05 (owner).** The concern was that `beer.html`'s "we work through the list in order" would stop being true once staff could pin. **It stays true, and the copy stays verbatim.** The owner's rule: the queue *is* worked in order, and pinning is not a general-purpose override — it exists only for (a) placing someone who registered interest by word of mouth at their real point in the queue, and (b) moving someone who asks to defer. Neither jumps a customer ahead of someone who signed up first, so the public promise is accurate as written. `signed_up_at` remains the ordering key and the tiebreaker; D-04 is unaffected.
4. **D-06 non-disclosure still binds** — nothing added here may reveal to a customer whether they were already on the list.

**Plans:** 6/6 plans executed — **PHASE COMPLETE 2026-09-05** (verified: `80-VERIFICATION.md`)

Plans:

**Wave 1** (parallel — disjoint files: Apps Script / middleware / frontend)

- [x] 80-01-PLAN.md — Apps Script: 13-column Waitlist schema (D-17), header-driven addWaitlistEntry (fixes the positional-append bug), 6 new optional fields on updateWaitlistStatus with waitlistCellSafe (D-19), recipe-id parse/serialize helpers, IN-01 folded in, WR-02 documented as carried forward, docs/APPS_SCRIPT.md corrected
- [x] 80-02-PLAN.md — Middleware: sendWaitlistContact via Resend (D-04), staff-tier POST /api/waitlist/:id/contact with fail-closed send-then-write (D-07/D-08), POST /api/waitlist/:id/mailerlite-sync (D-24), add_waitlist_entry added to ADMIN_PROXY_ACTIONS only (D-21) with the superseded Phase 78 assertion deliberately flipped
- [x] 80-03-PLAN.md — BrewPad: position-aware sortWaitlistRows merge-insert, pin marker + inline position editor + clear-pin (D-10..D-13), widened table with Customer and Recipes cells and a horizontal-scroll wrapper

**Wave 2**

- [x] 80-04-PLAN.md — BrewPad: per-row Zoho customer link (search or create inline, D-01/D-02) with the D-03a phone-preservation guard, and per-row recipe multi-select with removable chips (D-15/D-16)

**Wave 3**

- [x] 80-05-PLAN.md — BrewPad: Contact column + review sheet with Cal.com booking link and fail-closed inline error (D-05..D-08), manual-add sheet with client-derived D-23 disclosure and MailerLite sync (D-21..D-25)

**Wave 4** (owner cutover — checkpoints)

- [x] 80-06-PLAN.md — 80-CUTOVER.md runsheet, owner approval of the email template / Cal.com event type / three UI-SPEC open items, then the gated columns-first migration (D-18), the single Apps Script redeploy with recorded rollback versions (D-20), probes, staging deploy and UAT

---

### Phase 81: Recipe fermentation timeline — give customers an expected ready date

**Goal:** Every beer recipe carries a structured fermentation time, imported from the BeerXML files we already parse, and that time is surfaced to customers as a plain-language expectation ("ready in about 3 weeks") on the recipe card and the beer page — replacing today's "it depends on the style, we'll tell you at your consult".

**Why this matters now:** The beer page was rewritten 2026-09-05 to remove the fear that brewing costs a full day. The one question it still cannot answer is *when do I get my beer*. Staff answer it by hand at every consult. The data to answer it automatically is already inside the BeerXML files being imported — `parseBeerXML` (`js/admin.js:9307`) reads name, style, ABV, batch size, IBU and colour, and throws the timing fields away.

**Source:** Owner direction 2026-09-05 — "we should have a timeline attached to the recipes, ales will be ~3 weeks and lagers ~5 weeks, can we add that so customers can have an expected timeline?", then "we could have a fermentation time field? that should be importable from beerxml right?"

**Depends on:** Phase 15 (the BeerXML import this extends). No dependency on Phase 80.

**Requirements**: OPS-05 (partial — see the scope split below).

> **⚠ SCOPE SPLIT WITH PHASE 66 — read before planning.** Phase 66 (Recipe Data Quality, OPS-05)
> already claims this ground: its success criterion 1 covers "a structured schedule (hop timing, mash
> steps, **fermentation stages**) OR the BeerXML import maps these into a defined structure". Phase 81
> deliberately carves out **only the fermentation-time slice**, because it has a customer-facing
> driver and Phase 66 is explicitly "lowest priority, do last". **Phase 66 criterion 1 has been
> amended to exclude fermentation time so the two phases do not both claim it.** Hop timing, mash
> steps and hop-unit normalization stay in Phase 66.

**Scope sketch (confirm at discuss-phase):**
- **BeerXML parse** — read `PRIMARY_AGE`, `SECONDARY_AGE`, `TERTIARY_AGE`, `AGE` and `FERMENTATION_STAGES` from the `RECIPE` record. These are **optional** in BeerXML and are frequently left at the exporting software's default, so they must land in the importer's existing review table (the D-09 pattern) for a human glance, never be trusted blind.
- **Storage** — one new column on the `Recipes` sheet. `ensureRecipesPricingModeColumn` (`apps-script/adminApi.gs:3592`) is the safe-append precedent; old code maps by header name and ignores unknown columns.
- **Public exposure** — add to `PUBLIC_RECIPE_FIELDS` (`zoho-middleware/routes/recipes.js:71`). It is build-by-allowlist, so a new field stays invisible publicly until explicitly listed.
- **Display** — recipe card (`buildRecipeCard`) and `beer.html`, phrased as an approximation, not a promise.
- **Admin editing** — the field must be correctable in the recipe editor, since imported values will be wrong sometimes.
- **Backfill** — existing recipes predate the field.

**Open decisions for discuss-phase:**
1. **What does the number mean to a customer** — ready to *package*, or ready to *drink*? The owner's 3-week/5-week figures sound like ready-to-drink, i.e. primary + secondary + conditioning. This determines whether the stored value is a single total or the stages kept separate.
2. **Single value or range**, and **how it renders**. Recommendation: store days as a number, render as an approximation ("about 3 weeks"), never an exact date — fermentation is biological and a precise promise will eventually be wrong.
3. **Fallback when a recipe has no value** — must degrade to today's "we'll give you a timeline at your consult" rather than rendering blank or zero.

**Known constraints:**
1. **The Apps Script layer has no CI deploy path and ONE deployment serves staging AND production.** Adding the column is therefore a production release for that layer. ~~The Phase 80 lesson applies exactly: add the column FIRST, redeploy SECOND.~~ **CORRECTED at research (2026-09-05):** the Phase 80 ordering rule does NOT transfer. It came from `ensureWaitlistSheet`, a fail-closed validator that refuses to run when any of 13 headers is missing. `schedule_id` follows the `ensureRecipesPricingModeColumn` precedent (`apps-script/adminApi.gs:3592`) — self-migrating, header-name-based, already live in production. There is no load-bearing manual pre-redeploy step; deploy once and the column appears on the first save. Also note: staging and production share ONE Google Sheet, so any sheet write made "on staging" is a production write.
2. **Imported timings are not trustworthy on arrival.** A recipe exported from BeerSmith or Brewfather may carry a default `PRIMARY_AGE` nobody edited. The review step is the control, not the import.
3. **This is customer-facing copy about a biological process.** An under-promise is recoverable; an over-promise means a customer turns up for beer that is not ready.

**Superseded scope note:** the "Storage — one new column on the Recipes sheet" sketch above is
**superseded by D-03.** The recipe carries a `schedule_id` pointing at an existing `FermSchedules`
template, and the public figure is DERIVED as the largest `day_offset` among that template's
non-packaging steps. There is no standalone `ferment_days` column on `Recipes`. Do not resurrect
the sketched approach.

**Plans:** 5/9 plans executed

Plans:
**Wave 1** (parallel — disjoint files)

- [x] 81-01-PLAN.md — Apps Script: self-migrating `Recipes.schedule_id` column, persistence in `createRecipe`/`updateRecipe`, and the pre-existing `'gfs'` cache-bust fix in the three FermSchedules CRUD handlers
- [x] 81-02-PLAN.md — Middleware: `CACHE_KEYS.FERM_SCHEDULES`, `fetchFermSchedules` (GET + server_token), `maxNonPackagingOffset`, `enrichFermentDays` on both read paths, and `ferment_days` in `PUBLIC_RECIPE_FIELDS`
- [x] 81-03-PLAN.md — Public: `fermentTimeDisplay` + the second "Ready in" `.price-col` on the recipe card, new CSS, both `beer.html` passages rewritten, CSP confirmed unchanged, bundles rebuilt
- [x] 81-04-PLAN.md — Admin recipe editor: schedule picker, load/save round-trip, D-11 warn-don't-block message, and the `initRecipesTab` lazy-load fix

**Wave 2**

- [x] 81-05-PLAN.md — Admin BeerXML review: `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE` extraction (display-only), meta-line segment, template dropdown with no pre-selection (D-13), D-14 side-by-side compare, and the `confirmBeerXMLImport` carry-through fix

**Wave 3**

- [ ] 81-06-PLAN.md — Admin: D-15 blast-radius note on the template editor, and D-04 pre-selection on `#sa-schedule-select` (the `#batch-schedule-select` leg is recorded as an open finding — that modal has no recipe identity)

**Wave 4** (owner — Apps Script release)

- [ ] 81-07-PLAN.md — Read the live `FermSchedules` inventory, decide the D-10 branch, then redeploy Apps Script with the rollback version recorded and four live probes

**Wave 5** (owner — staging deploy, backfill, release gate)

- [ ] 81-08-PLAN.md — Push to staging, verify the public API contract pre-backfill, create/attach templates and attach schedules to all 3 active recipes, then the unconditional D-10 release gate

**Wave 6** (owner — production cutover)

- [ ] 81-09-PLAN.md — Production middleware + frontend cutover, live verification, and the RUNBOOK/STATE outcome record (OPS-05 stays open — this phase closes the fermentation-time slice only)

---

### Phase 46: Auth Re-Architecture (CRITICAL — split from Phase 45)

**v4.5 carryover:** This phase closes v4.5 **SEC-02** (audit C1) — carried over as-is, not re-planned. ✅ COMPLETE 2026-07-08: owner production cutover (46-10) executed off-hours; kiosk (device token), admin + BrewPad (Google session) all verified; `API_SECRET_KEY` rotated → leaked key dead (403), no surface locked out, public checkout intact. See `46-10-SUMMARY.md` and `docs/RUNBOOK.md` Outcome record; `REQUIREMENTS.md` Traceability.

**Goal:** Eliminate the shared-secret browser auth model. Stop shipping the admin API key in public git-tracked JS, move staff surfaces to server-side identity, and rotate the leaked `API_SECRET_KEY` at cutover — closing the CRITICAL auth-model exposure from `AUDIT-2026-06-29.md` without locking out the in-store kiosk.

**Requirements**: Audit remediation (CRITICAL tier — auth-model exposure). Source: `AUDIT-2026-06-29.md`. Carried over from Phase 45 decisions D-01..D-05.
**Depends on:** Phase 45 (Wave 1 interim containment ships first). Coordinate with Phase 42 (Kiosk POS De-Fork) — admin/kiosk frontend auth gating overlaps the de-fork.
**Status:** Planned — 10 plans across 6 waves (owner sign-off on the device-credential mechanism captured in 46-CONTEXT.md D-46-01).
**Plans:** 9/10 plans executed

**In scope (D-01..D-05):**

- **Kiosk device-provisioned credential** — single managed in-store iPad on store WiFi (D-01); device-bound session/credential entered/stored once on the iPad, no shared secret served to public pages. Exact mechanism (long-lived device token vs first-run provisioning vs client cert) is an **open design decision** for discuss/research — no existing analog.
- **Admin per-user Google OAuth** (D-02) — admin (`admin.html`) is opened off-site (laptop/phone), so it must require real per-user Google login. The reusable Google identity is frontend-only today (`js/lib/auth.js`, GIS); the **server-side Google ID-token verifier + staff allowlist is net-new** (guard registration mirrors `server.js:418-423`). NOTE: `routes/auth.js` is Zoho OAuth, not Google.
- **Remove `MW_API_KEY`** from `js/sheets-config.js:65` (D-03); public pages (index/products/contact/404) carry no admin key; rebuild artifacts (`npm run build`).
- **Rotate `API_SECRET_KEY` at cutover** (D-04) — owner-coordinated; leaked key stays valid until the new auth is live (documented residual risk, owner-accepted).
- **Interim network containment** (D-05) — IP allowlist as a possible stopgap; likely unnecessary if cutover is quick (planner to confirm).

**Out of scope:** the money-path / quick-win / Redis / CI work (stays in Phase 45); the medium/low/info findings (phases 47+).

**Pre-planning gate:** Run `/gsd:discuss-phase 46` to lock the device-credential mechanism before `/gsd:plan-phase 46`.

Plans:
**Wave 1** (parallel — disjoint files)

- [x] 46-01-PLAN.md — Backend credential primitives: lib/deviceToken.js + lib/session.js + validateEnv vars + install google-auth-library/cookie-parser
- [x] 46-05-PLAN.md — Kiosk full migration: remove Google-auth gate, device-token settings prompt + PIN gate, swap headers to x-device-token, /api/contacts/search
- [x] 46-06-PLAN.md — Admin session migration: checkAuthorization → /auth/google, all calls credentials:'include' (incl. embedded kiosk)
- [x] 46-07-PLAN.md — BrewPad session migration: checkAuthorization(onError) → /auth/google, all calls credentials:'include'
- [x] 46-08-PLAN.md — Public bundles keyless + remove MW_API_KEY from sheets-config (12-checkout 6 sites, 16/17 GETs)

**Wave 2**

- [x] 46-02-PLAN.md — lib/googleVerify.js (getTokenInfo + mandatory aud check) + POST /auth/google & /auth/logout

**Wave 3**

- [x] 46-03-PLAN.md — server.js 3-tier guard (legacy/device/session) + lib/authTiers.js + cookie-parser + keyless exemptions + PII session acceptance

**Wave 4**

- [x] 46-04-PLAN.md — In-route credential migration: pos.js 13 checks + consignment/catalog → req.authTier (kiosk survives rotation; void stays admin-grade)

**Wave 5**

- [x] 46-09-PLAN.md — Rebuild all bundles + full frontend/middleware/lint gate + no-key grep proof

**Wave 6** (owner cutover — checkpoints)

- [ ] 46-10-PLAN.md — Dual-accept deploy + iPad provisioning + per-surface verify + API_SECRET_KEY rotation + runbook

## Phase Details (v4.5)

### Phase 47: Purge Publicly-Served Internal Docs

**Goal**: Internal planning/audit artifacts are no longer served publicly on either staging or production — closing the confirmed-live H1 exposure that hands out the admin key and a file:line exploit map
**Depends on**: Nothing (first phase of v4.5; ~minutes, independent containment; sequenced first because it removes an active exploit map)
**Requirements**: SEC-01
**Success Criteria** (what must be TRUE):

  1. `curl https://staging.steinsandvines.ca/.planning/STATE.md` returns 404, not file contents
  2. `curl <prod>/AUDIT-2026-06-29.md` (and the equivalent staging path) returns 404
  3. `AUDIT-2026-06-29.md` and any other root audit docs are `git rm --cached` from the served repos and added to `.gitignore`
  4. The root `.nojekyll`-vs-`_config.yml exclude` contradiction on staging is reconciled — either `.nojekyll` is dropped on staging so the exclude works, or a `.planning`/audit strip is added to the staging deploy matching prod
  5. The existing production `.planning` strip step still runs and continues to remove root audit docs, with no regression to CNAME or the live site

**Plans**: TBD

### Phase 48: Kiosk POS De-Fork (kiosk-core.js)

**Goal**: The kiosk POS logic lives in a single shared `js/kiosk-core.js` consumed by both `kiosk.js` (standalone) and `admin.js` (embedded), so the cart and payment/checkout paths can no longer diverge — the structural backbone that lets the kiosk void-on-failure synchronously like `checkout.js`, and the prerequisite for MONEY-02 (Phase 50) and MONEY-03 (Phase 51)
**Depends on**: Nothing new (rehomed from v4.4 Phase 42; independent of Phase 47)
**Requirements**: KIOSK-01
**Success Criteria** (what must be TRUE):

  1. The ~34 duplicated `kiosk*` functions (cart building, `kioskProceedToPayment`, terminal charge, Zoho invoice/payment, void-on-failure, dual-cart) exist in exactly one place, `js/kiosk-core.js`, and both `kiosk.js` and `admin.js` consume that shared module — no second copy of the payment path remains
  2. The money path is unchanged in behaviour: terminal charge → Zoho invoice/payment → void-on-failure → dual-cart shared-charge handling all behave exactly as before, demonstrated by the existing kiosk tests passing without weakening and by a new admin-embedded-vs-standalone parity check that asserts identical request payloads/flow for the same cart
  3. The kiosk product-type discount feature (which currently exists only in `kiosk.js`) is available identically on both the standalone kiosk and the admin-embedded kiosk after the de-fork
  4. `npm test`, `npm run lint`, and `npm run build` are clean (concatenated `main.js`/`main.min.js` and `admin.min.js` regenerated), and no behaviour-changing logic was introduced beyond the discount-parity fix
  5. Verified on staging on iPad Safari: a full kiosk sale (including a recipe/product-type discount) completes identically from both the standalone kiosk URL and the admin-embedded kiosk tab, with terminal/void/dual-cart behaviour intact

**Plans**: 6 plans (6 waves — sequential; shared-file ownership of kiosk-core.js/kiosk.js/admin.js/HTML forbids parallelism)
**UI hint**: yes
Plans:

**Wave 1**

- [x] 48-01-PLAN.md — kiosk-core.js skeleton + Node-require guard spike (Pitfall 4/A2) + build wiring (terser + stamp + script tags)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 48-02-PLAN.md — kiosk.js migration pt1: cart/catalog/render/totals + 12-fn discount subsystem + module state + init/auth seam into core

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 48-03-PLAN.md — kiosk.js migration pt2: payment/checkout/terminal/confirm (canonical sale-body) + dual-cart/SO logic into core

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 48-04-PLAN.md — admin.js consumes KioskCore + delete dup defs + 2 drift-bug fixes (D-05) + idempotency unify + discount markup port to admin.html

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 48-05-PLAN.md — admin-vs-standalone parity test (SC#2/D-03) + final build/lint/test gate + KIOSK-01 traceability

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 48-06-PLAN.md — staging deploy + iPad Safari full-sale manual checkpoint (SC#5, autonomous: false)

### Phase 49: Online Captured-Amount Verification

**Goal**: `/api/checkout` verifies the captured card amount against the recorded/invoiced total before booking payment, voiding and rejecting on any mismatch — closing audit H2
**Depends on**: Nothing new (extends the existing `lib/money-path.js`/`checkout.js` primitives; independent of Phase 48)
**Requirements**: MONEY-01
**Success Criteria** (what must be TRUE):

  1. After resolving `transactionId` in `/api/checkout`, the handler fetches the Helcim `getCardTransactionById` record and asserts captured amount ≥ recorded/invoiced total before any payment is booked
  2. A mismatch (captured amount below the recorded/invoiced total) triggers `voidWithTimeout` and the request returns a 4xx rejection — no paid Zoho invoice is created
  3. A regression test simulating `initialize(amount: 0.01)` against a full-price order asserts: charge voided, no paid invoice persisted, 4xx response
  4. The existing v4.2-hardened checkout test suite remains green — no regression to the happy-path charge→Zoho-order flow

**Plans**: 2 plans

Plans:

- [x] 49-01-PLAN.md — TDD RED→GREEN: failing H2 regression, then getCardTransactionById captured-amount check (±$0.01) + void-on-mismatch in /api/checkout (autonomous)
- [ ] 49-02-PLAN.md — Live-card UAT: legit order books paid (no false-void) + tamper attempt voided/4xx on staging (checkpoint)

### Phase 50: Kiosk Money-Path Defect Closeout

**Goal**: The kiosk money path closes its remaining correctness defects — reconcile TTL/orphan-age, idempotency lock release on failure, void-status inspection, `salesorder-pay` locking, sweep cleanup, and `pos-recipe.js` primitive adoption — closing audit H3/H4/H5/H8/M12/M13
**Depends on**: Phase 48 (kiosk de-fork must land first so shared money-path primitives have one call site to fix, not two)
**Requirements**: MONEY-02
**Success Criteria** (what must be TRUE):

  1. Reconcile's TTL-vs-orphan-age check is fixed / made Zoho-authoritative (H3) — a regression test asserts a settled paid charge is never voided by reconcile
  2. The idempotency lock is released on every confirm/checkout failure path (H4) — a regression test asserts a retry after a failed attempt re-acquires the lock rather than hanging locked
  3. `voidTransaction` inspects the actual reversal status returned by Helcim rather than trusting any 2xx response (H5) — a regression test covers a 2xx-but-not-reversed response
  4. `salesorder-pay` acquires a lock, deletes its pending record on success, and uses a unique reference (H8) — a duplicate/racing call cannot double-pay
  5. The sweep clears or marks pending records so the alert storm ends (M13), and `pos-recipe.js` adopts the same `money-path` primitives + pending-record pattern already used by `checkout.js`/`pos.js` (M12)

**Plans**: 5 plans (3 waves; 4 carry blocking live-verification checkpoints — the middleware has no staging instance)

**Planning notes (2026-07-13):** Scoped against `.planning/AUDIT-STATUS-2026-07-13.md` (every finding re-verified against current source), not the stale original audit.

- M13 (sweep clears/marks pending records to end the alert storm) was verified **ALREADY FIXED** on 2026-07-02 — `lib/reconcile.js:397-436` `manual_review_alerted` marker, covered by `reconcile.test.js` T6b/T6c. No work planned; SC#5 therefore reduces to M12 (`pos-recipe.js`).
- **M-B1 folded in** (plan 50-04): the client mints a fresh `KIOSK-<Date.now()>` per tap and never disables the money-path buttons, so a double-tap produces two DIFFERENT idempotency keys and the Phase 45 server lock never sees a duplicate. It is the client half of SC#4.
- **Deferred, explicitly NOT planned:** M-D1 (brewpad retry sweeps use blocking `KEYS PREFIX*` with no distributed lock — `lib/brewpad-integration.js:421`, `:557`, `server.js:682-690`). It is a Resilience finding on the brewpad batch path, not the kiosk money path, and does not serve any MONEY-02 success criterion. → backlog / a future RESIL phase.
- **D-50-08 (blocker fix, 2026-07-13 plan-check):** reconcile's Zoho-authoritative settled-check must BRANCH on the record type. `/api/kiosk/salesorder-pay` creates its invoice via `zohoPost('/invoices/fromsalesorder?...', {})` with an EMPTY body (`pos.js:1907`) and never sets `reference_number` — so an invoice-reference lookup returns `{ invoices: [] }` for a fully PAID order and would void a paying customer. Records carrying `salesorder_id` are verified against `GET /salesorders/{id}` (balance/status) instead. An invoice-based lookup can never be authoritative for that surface: SO-pay treats invoice creation as explicitly non-fatal (`pos.js:1919-1924`), so a paid SO may legitimately have no invoice at all.
- **Out of scope** (belong to Phase 51 or are unowned): gift-card ledger integrity (H6/H7/M9/M15/M18 → Phase 51), the unescaped `it.name` XSS (M-C1), iOS auto-zoom / touch targets (M-C2..C7), E2E money-path coverage (M-E1/E2), `railway.toml` (M-E3), webhook replay protection (M-A4/M-A6).

Plans:

**Wave 1**

- [ ] 50-01-PLAN.md — `voidTransaction` inspects the actual reversal status instead of trusting any 2xx (M-A2/H5, SC#3) + blocking live-void checkpoint
- [x] 50-04-PLAN.md — Client: one stable idempotency key per payment attempt + disable-on-click on the sale and SO-pay buttons (M-B1; both kiosk.html and admin.html via the shared `kiosk-core.js`)

**Wave 2**

- [x] 50-02-PLAN.md — `/api/kiosk/salesorder-pay` gets an idempotency lock, a deterministic Helcim key, a unique reference, a pending record and a hardened void (M-A1/H8, SC#4 — the headline double-charge defect)

**Wave 3** (both depend on 50-02; `files_modified` are disjoint — `pos.js` vs `pos-recipe.js`/`reconcile.js` — so they may run in parallel)

- [x] 50-03-PLAN.md — Captured-amount verification at kiosk confirm (M-A3, SC#1) + idempotency lock released on every confirm/sale failure path, retained when a charge is unvoided (H4, SC#2)
- [x] 50-05-PLAN.md — `pos-recipe.js` adopts the money-path primitives + pending record (M12, SC#5); reconcile becomes Zoho-authoritative so a settled paid charge is never voided (H3, SC#1)

**Wave note (2026-07-13 plan-check, iteration 2):** 50-05 was moved from Wave 2 → Wave 3 and now declares `depends_on: ["50-01", "50-02"]`. Its blind-spot-closing regression (cases 12–14) builds the pending record by capturing the REAL `cache.set` argument from a live `/api/kiosk/salesorder-pay` request — but the *unhardened* route writes **no pending-charge record on its success path at all** (`pos.js:1884-1940`). Same-wave plans branch from the same pre-wave commit, and the executor's intra-wave safety net only forces sequencing on overlapping `files_modified` (which these two do not share). So as originally waved, 50-05 could legally have run before 50-02 existed and silently rebuilt the exact hand-mocked-`ctx` blind spot the revision was written to close.

### Phase 51: Gift-Card Ledger Integrity

**Goal**: Gift-card issue/reload/redeem operations are idempotent and ledger-integral — no duplicate credits, no silent redeem failures, no formula-injection or unbounded-numeric corruption of the Sheets-backed ledger — closing audit H6/H7/M9/M15/M18
**Depends on**: Phase 48 (kiosk de-fork lands first; gift-card redemption is a kiosk tender path)
**Requirements**: MONEY-03
**Success Criteria** (what must be TRUE):

  1. `reloadGiftCard` is idempotent via an append-only processed-ref ledger (H7) — a regression test asserts a duplicate reload request produces a single credit, not two
  2. A redeem failure durably sets `needs_manual_review: true` on the gift-card/transaction record (H6) — a regression test asserts the flag itself, not just a log line
  3. Every Sheets write sanitizes leading `=+-@` characters in user-supplied cell values (M9) — a regression test asserts `=IMPORTRANGE(...)` entered as a void reason is stored as inert text, not a formula
  4. `issueGiftCard`'s `appendRow` is header-mapped (not positional) with bounded numeric fields (M18) — malformed/oversized numeric input is rejected or clamped, not written raw
  5. Negative-taxable custom-line tax parity holds (M15) — a regression test asserts a legitimately discounted sale is not voided by a tax mismatch
  6. An interleaved redeem retry decrements the balance exactly once, verified by a regression test
  7. **A redeem or reload interrupted MID-WRITE cannot be replayed for a second balance change** — a regression test must exercise the crash window described below, not only the concurrent-retry case in criterion 6

**SCOPE NARROWED (owner decision, 2026-09-02).** This phase now covers **criteria 1, 2, 6, 7 only** — the atomicity core. `apps-script/adminApi.gs` cannot be tested locally and each change costs a manual owner redeploy with no staging gate, so the diff stays on the live money-path defect.

- **Criterion 3 (M9 — `=+-@` formula-injection sanitization)** → deferred to a follow-up phase.
- **Criterion 4 (M18 — header-mapped `issueGiftCard` + bounded numerics)** → deferred to a follow-up phase.
- **Criterion 5 (M15 — negative-taxable custom-line tax parity)** → **MOVED OUT of Phase 51 entirely.** It shares no code path with the gift-card ledger and was parked here by the audit; it belongs with the kiosk/tax work. Rehome before closing MONEY-03.

**Chosen approach: append-only ledger.** A `GiftCardTransactions` sheet where the `tx_ref` row is written as a **claim before the balance changes**, with the idempotency guard reading the ledger instead of `last_tx_ref`. Also gives the durable `needs_manual_review` record criterion 2 requires — today that flag exists only as a middleware response value and a Redis sentinel, never persisted. See `51-CONTEXT.md` (D-01..D-12).

> ⚠ **CLOSEOUT WARNING — do not mark MONEY-03 fully done when this phase completes.** `.planning/PROJECT.md:21` and `.planning/REQUIREMENTS.md:30,84` still describe MONEY-03 as covering M9, M15 and M18 in full. This phase deliberately covers only criteria 1, 2, 6 and 7. Either narrow those descriptions or track the M9/M18 follow-up and the M15 rehome before MONEY-03 is closed.

---

**ROOT CAUSE LOCATED (2026-09-02, during the Sheets→Postgres research pass).** The audit flagged this class as H6/H7 in 2026-06-29 but never pinned the mechanism. It is now pinned:

`redeemGiftCard` (`apps-script/adminApi.gs:4204`) changes a customer balance across **four independently-committing `setValue()` calls**, with the idempotency key written **LAST**:

```
setValue(newBalance)   <- money leaves here      (~:4246)
setValue(newStatus)
setValue(now)
setValue(txRef)        <- idempotency key lands here  (~:4249)
```

The idempotency guard reads `gc.last_tx_ref` (~:4221). So if the script dies between the first and last write, the balance is already debited while `last_tx_ref` is stale — and a retry with the **same** `transaction_ref` misses the guard and **debits again**.

**This needs no concurrency.** A single interrupted execution is sufficient, which is why criterion 6's "interleaved retry" framing does not cover it — hence new criterion 7.

`reloadGiftCard` (`:4264`) has the **identical** four-write shape with `txRef` last, so the same crash window produces a **duplicate credit**. That is precisely audit H7 / criterion 1.

**Two traps for whoever plans this:**

1. **Reordering is NOT a fix.** Writing `txRef` first converts double-debit into "customer keeps their balance and got the goods" — a different loss, not a fixed one. Only atomicity closes it.
2. **A single batched `setValues()` is NOT a safe shortcut here.** GiftCards column order is `cert_number | face_value | current_balance | status | issued_date | issued_by | zoho_invoice_number | notes | last_updated | last_tx_ref`. The mutated columns (3,4 and 9,10) are **not contiguous**, so one ranged write would also rewrite `issued_date`, `issued_by`, `zoho_invoice_number` and `notes` — and `updateGiftCardInvoice` (`:4358`) writes `zoho_invoice_number` **without taking the lock** (a deliberate 44-02 decision), so a batched redeem could silently clobber a concurrent invoice-number write. Either take the append-only ledger route (criterion 1 — preferred, and it also yields the audit trail) or bring `updateGiftCardInvoice` under the lock first.

Related: `.planning/research/sheets-to-postgres-migration.md` §3 reaches the same conclusion independently and proposes a `gift_card_transactions` ledger with `tx_ref UNIQUE`; `.planning/notes/sheets-to-postgres-data-conversion.md` §3.1 carries the target DDL. **This phase should fix the atomicity on Sheets — it is not gated on any migration.**

**Plans**: 3 plans (3 waves — sequential; every plan touches `apps-script/adminApi.gs`, so shared-file ownership forbids parallelism)

Plans:

**Wave 1**

- [x] 51-01-PLAN.md — pure ledger guard helpers (`giftCardLedgerDecision`, D-12 unsettled-claim rule) with a real Jest suite over the actual `.gs`, plus the idempotent `GiftCardTransactions` bootstrap and claim/settle/flag IO helpers. Money path untouched.

**Wave 2** *(blocked on Wave 1)*

- [x] 51-02-PLAN.md — `redeemGiftCard` and `reloadGiftCard` rewritten to claim-before-mutate and to guard on the ledger instead of `last_tx_ref` (H6 + H7). Four per-cell writes preserved (D-05); 44-02 deliberately left standing.

**Wave 3** *(blocked on Wave 2)*

- [x] 51-03-PLAN.md — stuck-claim runbook in `docs/APPS_SCRIPT.md`, pre-flight gate, then the owner redeploy + live probes in the DANGEROUS direction on a disposable test cert (D-09/D-11). autonomous: false. **Live-verified 2026-09-02:** Apps Script Version 51 ACTIVE (rollback Version 50 recorded); Probes A-E' all PASS — same-ref replay refused, crash-then-retry with a fresh ref refused (criterion 7/D-12), `needs_manual_review` durable in-cell (criterion 2), stuck claim cleared via documented single-cell edit, reload duplicate-credit refused (criterion 1/H7). Step 8 regression sweep (real kiosk sale, lookup, void, invoice-number path) and `TEST-LEDGER-01` cleanup NOT done — see `51-03-SUMMARY.md`.

### Phase 52: Fail-Closed Sweep

**Goal**: Every remaining Redis-degradation and auth/validation gap that currently fails open now fails closed — no security or money-path guard silently permits an unsafe operation when Redis or an upstream service is unavailable
**Depends on**: Nothing new (independent of Phases 48-51; sequenced after money-path correctness per audit risk order)
**Requirements**: RESIL-01
**Success Criteria** (what must be TRUE):

  1. A single shared closed-on-Redis-error helper is applied to the promo `FIRSTBATCH` check (M1), the rate-limit store's mid-op error path (M4), and its loopback skip (M5) — a test asserts each guard returns closed when its Redis call throws
  2. The legacy `/api/pos/sale` route is quarantined or deleted (M2), and the hardcoded gift-card `account_id` fallback fails closed rather than silently using a default (M3)
  3. The `csv_url` fetch is restricted to `https`-only with a host allowlist, closing the SSRF vector (M6)
  4. The unauthenticated Apps-Script-backed GET routes are auth-guarded and cached (M7, M8) — an unauthenticated `?bust=1` request requires the key
  5. Numeric `:id` path parameters are validated, closing the `%2F` path-pivot vector (M20)
  6. A regression test asserts the promo is not repeatable during a simulated Redis outage

**Plans**: 5 plans

- [x] 52-01-PLAN.md — shared closed-on-Redis-error helper (redis-guard) [wave 1]
- [x] 52-02-PLAN.md — apply helper: promo M1 fail-closed + rate-limit M4/M5 fail-closed [wave 2]
- [x] 52-03-PLAN.md — pos.js: quarantine legacy /api/pos/sale (M2) + gift-card account fail-closed (M3) [wave 1]
- [x] 52-04-PLAN.md — items :id validation (M20) + csv_url SSRF allowlist (M6) [wave 1]
- [x] 52-05-PLAN.md — auth+cache: ?bust=1 key (M7) + Apps-Script proxies (M8) [wave 1]

### Phase 53: Money-Path Observability & CI Gates

**Goal**: Every money-path failure emits a tagged Sentry event, and CI enforces the lint/coverage/dependency gates that keep the hardened money path from silently regressing — protecting every fix made in Phases 47-52
**Depends on**: Phases 49, 50, 51, 52 (sequenced last so its Sentry/coverage gates protect every earlier money-path/resilience fix from regressing, per audit rationale)
**Requirements**: OBS-01
**Success Criteria** (what must be TRUE):

  1. Every money-path `catch` block calls `Sentry.captureException` tagged with `txnId`/`reqId` (M17) — a forced money-path error produces a visible Sentry event
  2. CI and Railway both run `npm ci` (not `npm install`), and a Node `engines` field / `.nvmrc` pins the runtime version (L1, L2)
  3. Lint runs with `--max-warnings 0` and an ES5-only lint rule is enforced — CI fails on a new lint warning and on ES6 syntax (L12)
  4. A per-file coverage floor is set on `pos.js`, calibrated just below its measured coverage so it can't silently regress (L13)

**Plans**: 6 plans

Plans:

**Wave 1**

- [x] 53-01-PLAN.md — Sentry beforeSend PII scrub + error-class fingerprint (D-03/D-04) + regression test
- [x] 53-04-PLAN.md — Frontend lint cleanup (125 warnings) + admin.js optional-chaining→ES5 + rebuild (D-05/D-06)
- [x] 53-05-PLAN.md — npm ci + Node 20 pin (lockfiles/engines/.nvmrc/CI) + pos.js coverage floor (D-07/08/09/10)

**Wave 2**

- [x] 53-02-PLAN.md — Sentry captureException at money-path catch sites, tagged reqId/txnId/invoice-SO (D-01/D-02)

**Wave 3**

- [x] 53-03-PLAN.md — Middleware lint cleanup (60 warnings, own commit) (D-05)

**Wave 4**

- [x] 53-06-PLAN.md — Lint gate flip: --max-warnings 0 + ES5 rule (D-05/D-06)

## Phase Details (v4.6)

### Phase 55: GA4 Ecommerce Events (code review + ship)

**Goal**: GA4 (`G-WDYSXCM703`) receives `add_to_cart`, `begin_checkout`, and `purchase` ecommerce events from the custom cart/checkout, so online revenue and the shopping funnel become measurable — shipped from the ALREADY-WRITTEN, uncommitted working-tree implementation without altering any payment/charge/cart logic.
**Depends on**: Nothing (first phase of v4.6; the code already exists uncommitted in the tree)
**Requirements**: ANALYTICS-01
**Success Criteria** (what must be TRUE):

  1. The uncommitted GA4 diff is reviewed for correctness/safety — special attention to `js/modules/12-checkout.js`: `purchase` fires only on confirmed Helcim success (single + dual paths), exactly once per order (dedup by `transaction_id`), before carts/idempotency state are cleared; no payment/charge/cart logic was altered; analytics is wrapped so it can never throw into checkout
  2. Both gate suites pass: `npm test` (frontend, incl. the new `ga4-ecommerce.test.js`) AND `cd zoho-middleware && npm test`; `npm run lint` clean. If any module changed, `npm run build` was re-run so `js/main.js`/`js/main.min.js` + HTML cache stamps are regenerated (never hand-edited)
  3. The work is committed as one logical change and pushed to staging first (`git push origin main` → staging.steinsandvines.ca) — never straight to production
  4. Verified on staging with GTM Preview + GA4 DebugView by running a test order: exactly one `purchase` event with populated `ecommerce` (`transaction_id`, `value`, `currency: "CAD"`, `items`), plus `add_to_cart` and `begin_checkout`; re-triggering the success path for the same order does NOT produce a second `purchase`
  5. `products.html` carries the standard GTM container snippet (it was a live, untagged page per GTM diagnostics); confirm whether this fix is in the current diff or add it
  6. Only after staging approval, promoted to production per the CLAUDE.md deploy flow

**Plans**: 1 plan (review-and-ship of pre-written code)
Plans:

- [ ] 55-01-PLAN.md — Review the uncommitted GA4 diff (focus 12-checkout.js), re-run FE+middleware gates + lint, confirm/add products.html GTM tag, commit as one change, push staging, GA4 DebugView UAT, promote to prod after approval (ANALYTICS-01)

**Note**: The GTM-side wiring (3 GA4 event tags + triggers + DLV variables) is NOT code — it lives in Phase 56. The site events are inert until those tags exist.

### Phase 56: GTM Container Quality & Ads Measurement (config, mostly non-code)

**Goal**: The GTM container (`GTM-NHRCGLC5`) sends the site's ecommerce events to GA4 and the flagged container-quality/Ads-measurement gaps are closed, so `purchase` becomes a populated GA4 key event and Google Ads (`AW-18091171314`) attribution is complete.
**Depends on**: Phase 55 (the site must push the events before the GTM tags have anything to read)
**Requirements**: ANALYTICS-02
**Success Criteria** (what must be TRUE):

  1. Three GA4 Event tags (`add_to_cart`, `begin_checkout`, `purchase`) with matching Custom Event triggers and Data Layer Variables (`ecommerce.value/currency/transaction_id/items`), "Send Ecommerce data" = from Data Layer, tested in GTM Preview against staging before publish
  2. A Conversion Linker tag fires on All Pages (fixes the highest-priority GTM diagnostic)
  3. A Google tag for the Ads destination `AW-18091171314` is present (or the existing Google tag also loads it)
  4. After data flows, `purchase` is marked a GA4 key event; a second GTM account admin is added
  5. The pending Metricool tag is consciously decided at publish, and the container publish respects the RUNBOOK Stage-3 CSP↔GTM ordering (prod CSP live before publishing)

**Plans**: 1 plan (owner console run-sheet — GTM/GA4 UI, not code)
Plans:

- [ ] 56-01-PLAN.md — T1 staging-exclusion FIRST (GA4 internal-traffic filter on staging hostname, keeps DebugView for the UAT) → verify the 3 ecommerce event tags (already live) → Conversion Linker → Ads Google tag AW-18091171314 → Metricool decision + CSP↔GTM publish ordering → publish → mark `purchase` key event + 2nd admin → then close the Phase 55 purchase UAT in DebugView + promote c86b5b3 to prod (ANALYTICS-02)

**Note**: The 3 GA4 ecommerce event tags already appear LIVE (Phase 55 browser check saw a GA4 collect POST `tid=G-WDYSXCM703 en=add_to_cart`). T1's staging exclusion gates the Phase 55 `purchase` UAT — do it before any test order so staging doesn't pollute the prod GA4 property.

## Phase Details (v4.7)

### Phase 57: Kiosk Sale-Blocking Recovery

**Goal**: A kiosk sale can be started without a manual page refresh even after the iPad wakes from sleep — and, critically, the recurring failure is fixed from a REAL captured occurrence rather than inferred a second time. The prerequisite that makes this possible: the kiosk gains durable error capture so a failure is no longer lost the instant staff tap Retry.
**Depends on**: none (independent; most urgent — it blocks selling)
**Requirements**: REVIEW-01
**Success Criteria** (what must be TRUE):

  1. A kiosk-side failure (catalog load, auth, or sale POST) is reported to a durable sink (middleware log / Sentry via a small client-error beacon) with the real error text, HTTP status, endpoint, and auth state — so the exact error is no longer lost when staff tap Retry
  2. The real cause is diagnosed from a captured occurrence (forced on the iPad or observed in the wild), not inferred — the diagnosis is recorded before any fix is written
  3. The confirmed cause is fixed with a regression test written first (RED), and the auto-recovery actually works on the real device (e.g. a stale device-token/session self-heals, or the wake-retry fires) so staff no longer need a manual refresh
  4. Verified on the live iPad against the prod middleware — not merely a green suite (prior fix `7cbf856` passed its tests and still failed in the store)

**Plans**: 5 plans (4 waves — debug cycle: instrument → diagnose → fix (client + server) → live-verify)
Plans:
**Wave 1**

- [x] 57-01-PLAN.md — Client-error capture: ES5 kiosk beacon + device-token-gated, rate-limited, PII-scrubbed POST /api/kiosk/client-error → Sentry; regression tests both sides (REVIEW-01)

**Wave 2** (blocking checkpoint — live iPad)

- [x] 57-02-PLAN.md — Deploy 57-01 to prod, capture a REAL failure occurrence on the live iPad, record the confirmed cause in 57-DIAGNOSIS.md before any fix (REVIEW-01)

**Wave 3** (fix — keyed to 57-02 diagnosis; 57-03 + 57-04 run in parallel, no file overlap)

- [x] 57-03-PLAN.md — CONFIRMED-cause fix (client): stale-catalog self-heal on wake/staleness + pre-checkout phantom guard + beacon the sale server-error branch with a readable item_id (REVIEW-01)
- [x] 57-04-PLAN.md — Server safety net: bounded catalog auto-reconcile on a sale catalog-miss (variant 1) + store a validated item_id un-redacted (REVIEW-01)

**Wave 4** (live verification — blocking checkpoint)

- [ ] 57-05-PLAN.md — Full gate + deploy (frontend staging→prod, middleware prod-only); live-iPad confirm a previously-stale item sells WITHOUT a manual refresh (SC#4) (REVIEW-01)

### Phase 58: Revenue & Operations Integrity

**Goal**: The two review findings that touch money and foot traffic are closed: admin Kit Inventory shows no malformed/negative/unrounded prices, and the header Open/Closed indicator provably reflects real posted hours in the correct timezone.
**Depends on**: none
**Requirements**: REVIEW-02
**Success Criteria** (what must be TRUE):

  1. The `$-68.949…` class of malformed price is traced to its source (cost/margin math or a bad source value) and corrected + rounded; a regression asserts no negative/unrounded price renders
  2. The Open/Closed logic is verified against the real posted hours (Tue 10–4, Wed 10–4, Thu 12–7, Fri 10–4, Sat 10–4, Sun/Mon closed) in the shop's timezone; if wrong, fixed with a test pinning the boundary transitions
  3. Both are confirmed real before code changes (the Open/Closed one may already be correct — the review ran on a genuinely-closed day)

### Phase 59: Public-Site Trust Polish

**Goal**: The public site no longer looks unfinished or untrustworthy to a first-time visitor: no empty gap above the footer, no mystery/pre-populated cart for new visitors, and no blank framed images.
**Depends on**: none
**Requirements**: REVIEW-03
**Success Criteria** (what must be TRUE):

  1. Home/About/Contact have no large empty vertical gap above the footer (traced to the min-height/empty-container cause; a visual spot-check on each page confirms)
  2. Whether the observed cart pre-populate ("Belgian Candi Syrup") is a real bug or session leftover is CONFIRMED first; then a genuinely-fresh visitor never sees a pre-filled cart, and cart state is consistent across every page
  3. The "Our Story" image and the mobile framed images (e.g. "Homebrew Supplies" interior) reliably render — no blank bordered boxes — with the lazy-load / broken-link cause fixed at root

### Phase 60: Admin Data Hygiene

**Goal**: The admin dashboard's alert numbers become trustworthy: the Kit Inventory table is free of blank/orphan rows, the low-stock alert counts only real kits, and the overdue-task counts reconcile or are precisely labelled.
**Depends on**: none
**Requirements**: REVIEW-04
**Success Criteria** (what must be TRUE):

  1. The ~9 blank-name + ~26 all-zero orphan rows in Kit Inventory are traced to their source (likely a sync/import creating empty records) and cleaned up / prevented at the source
  2. The "kits low stock" alert reflects only real kits after the orphan rows are gone (and/or the threshold is reviewed), so the headline number is actionable
  3. The overdue-task counts (Dashboard 24 vs Tasks tab 45 vs Admin 24) either reconcile to one number or are each labelled by their exact scope (batch tasks vs all tasks incl. transfers/packaging)

### Phase 61: Site Refinement

**Goal**: The remaining review polish items are addressed on an already-solid site — faster first paint, accessible images, and the smaller UI/UX nits.
**Depends on**: none (lowest priority; do last)
**Requirements**: REVIEW-05
**Success Criteria** (what must be TRUE):

  1. First contentful paint is materially faster — web fonts no longer render-blocking (`font-display: swap` + preload the primary faces; self-host if needed)
  2. Meaningful homepage images (storefront, interior, product shots) carry descriptive alt text; decorative icons may stay intentionally empty
  3. The smaller items are handled or consciously deferred: Ingredients filter-bar sits in the toolbar not overlapping the hero; Instagram tiles have a lighter loading state; testimonials/Google-reviews snippet considered; kiosk device-token screen gains helper text; a decision is recorded on whether BrewPad + Admin share a sign-in

### Phase 62: Inventory Consumption Sync

**Goal**: Brewing a batch draws down real Zoho ingredient stock, so counts reflect physical reality and in-house/test brews can no longer silently overstate stock and cause oversold orders and refunds (SafLager class).
**Depends on**: none (highest business priority in v4.8; execute after the Phase 64 warm-up)
**Requirements**: OPS-01
**Success Criteria** (what must be TRUE):

  1. Creating a BrewPad batch posts a Zoho stock adjustment (or $0 internal-consumption transaction) for the recipe's ingredients × scale_factor — mirroring what a recipe-sale invoice already does; brew-complete/scale-change reconciles the delta
  2. The adjustment is idempotent per batch_id: re-saving or editing a batch never double-decrements
  3. Intentional negative stock (the manual oversell override, owner decision 2026-07-24) is untouched — the sync only records consumption; it never clamps negatives or hides items at ≤0
  4. Regression tests cover create / re-save / scale-change; verified against a real batch with real Zoho items before close

### Phase 63: Batch↔Invoice Reconciliation Model

**Goal**: Every unlinked batch is explainable — either linked to its invoice or carrying a structured reason why not — and matching survives household purchases, name-format drift, and spelling variance.
**Depends on**: none (cross-repo: Apps Script sheet columns + handlers)
**Requirements**: OPS-02
**Success Criteria** (what must be TRUE):

  1. Batches carry a structured `no_invoice_reason` (pre-Zoho / cash-legacy-GlobalPayments / comped-take-home / other), the known ~40-54 legitimately-unlinkable batches are flagged, and the "unlinked" list shows only genuine linking failures
  2. Batch↔invoice matching keys on customer_id, with display names validated against Zoho contacts — "Russel"/"Russell", "Last, First" vs "First Last", and typo drift no longer break matching
  3. Household purchases are linkable (linked-contacts/household concept, or kit+date fallback) — the Witwitki-invoice → Webb-batches case matches
  4. The free-text explanatory notes workaround appended to ~40 batches is migrated into the structured field

### Phase 64: Linking & Search Correctness

**Goal**: The BrewPad link-order tools show real data and can't strand stale references: invoice search returns actual line items, deleting a batch cleans up the invoice's batch-status field, and the admin GET token stops leaking into URLs. Safest phase — pure in-repo, existing patterns; execute first.
**Depends on**: none
**Requirements**: OPS-03
**Success Criteria** (what must be TRUE):

  1. `/api/batch/search-invoices` returns real line items (detail-fetch per the existing pos.js:3112 sales-order pattern, or the field is consciously dropped and the UI adjusted) — the link-order UI can show/match kit contents
  2. Deleting a batch clears or re-syncs the invoice's `cf_batch_status` (delete-hook or cleanup pass), and existing stale refs (INV-000151 class) are cleaned
  3. `adminApiGet` no longer places the Google OAuth token in the URL query string (moved to POST body or header, matching the adminApiPost precedent) — no token in intermediary/proxy logs
  4. Regression tests for each; linking flows otherwise behave identically

**Plans**: 3 plans (3 waves — sequential; shared-file ordering + one-logical-change-per-commit)
Plans:
**Wave 1**

- [x] 64-01-PLAN.md — search-invoices detail-fetches real line_items (bounded/capped), middleware-only (OPS-03)

**Wave 2**

- [x] 64-02-PLAN.md — Batch-delete reconcile hook + bounded dry-run stale-ref cleanup (INV-000151 class) clears/re-syncs cf_batch_status (OPS-03)

**Wave 3**

- [x] 64-03-PLAN.md — adminApiGet moves the Google OAuth token out of the URL into the POST body (brewpad.js + admin.js) + adminApi.gs doPost read-routing (owner redeploy first) (OPS-03)

### Phase 65: Staff Tooling Reliability & Backfill

**Goal**: Long bulk-admin sessions stop silently dropping writes, bulk operations run at bulk speed, and batches older than the scan window can be linked.
**Depends on**: none (builds on the shipped x-session-token auth; cross-repo: Apps Script bulk action)
**Requirements**: OPS-04
**Success Criteria** (what must be TRUE):

  1. Bulk operations run a pre-flight token check — an expired/expiring session blocks up-front with a re-auth prompt instead of dropping writes mid-run
  2. Staff sessions last materially longer than ~1 hour or refresh transparently — a full admin working session no longer needs 3-4 manual re-logins
  3. A `bulk_update_batches` Apps Script action exists (modeled on bulk_update_batch_tasks) — a 72-batch backfill completes in well under a minute instead of ~6
  4. `scan-invoices` has a configurable window or one-time backfill mode, so pre-30-day batches (the root cause of 126 unlinked) can auto-link

### Phase 66: Recipe Data Quality

**Goal**: Recipes carry structured brewing data instead of free-text cramming, and ingredient units are consistent enough that recipe quantities are unambiguous.
**Depends on**: none (lowest priority in v4.8; do last)
**Requirements**: OPS-05
**Success Criteria** (what must be TRUE):

  1. Recipes support a structured schedule (hop timing, mash steps — scope confirmed at plan time) OR the BeerXML import maps these into a defined structure automatically — no more stuffing into notes. **Fermentation time is NO LONGER in scope here — it moved to Phase 81 (2026-09-05), which has a customer-facing driver. Do not re-claim it.**
  2. Hop item units are normalized or explicitly mapped (the pcs/g/kg drift across the same product family is resolved) so recipe quantity semantics are unambiguous
  3. The hand-imported Hazy Pale Ale (SV-R-000003) round-trips correctly under the new model

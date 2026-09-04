# Steins & Vines — Recipe-Based Products

## What This Is

The Steins & Vines website and in-store system (steinsandvines.ca) serves a Squamish-based ferment-in-store business. Customers browse wine kits, beer recipes, and brewing ingredients online, purchase via kiosk or online checkout (Helcim), and staff manage batch fermentation through BrewPad. This milestone expands the product model from single-SKU wine kits to recipe-based products — collections of individual ingredients with service fees — to support beer and other fermented products.

## Core Value

**Customers can discover, select, or co-create fermentation recipes and purchase them as a complete package — with ingredient inventory, pricing, and batch tracking handled automatically by the system.**

## Current Milestone: v4.5 Security & Money-Path Closeout

**Goal:** Close the deferred CRITICAL and the verified High/Medium security + money-path defects from the 2026-07-02 whole-repo audit (`.planning/reports/AUDIT.md`) — and cure the root cause (the kiosk is a second-class re-implementation of the online-checkout money path) via the KIOSK-01 de-fork plus full synchronous adoption of `lib/money-path.js` primitives across `pos.js`/`pos-recipe.js` — without weakening the gold-standard online checkout.

**Target items (from `.planning/reports/AUDIT.md` §5, risk-ordered):**
- **SEC-01 (H-1, HIGH — confirmed live) Purge publicly-served internal docs** — the `.planning/` tree and `AUDIT-2026-06-29.md` are served publicly on staging (verified HTTP 200), handing out the admin key + a file:line exploit map. `git rm --cached` the audit docs + `.gitignore`; reconcile the root `.nojekyll` vs `_config.yml exclude` on staging; ensure prod strip removes root audit docs. Sequenced first — ~minutes, independent.
- **SEC-02 (H-2) Auth re-architecture** — *existing Phase 46, code-complete/verified, owner cutover pending.* Server-side Google-OAuth identity for staff surfaces; no shared secret in the browser; rotate `API_SECRET_KEY`. Folded in as-is, not re-planned. Closes CRITICAL C1 (whose blast radius grew via Phase 43/44 — gift-cert void, SSRF, DoS under the public key).
- **KIOSK-01 (de-fork) Kiosk POS de-fork → `kiosk-core.js`** — pulled forward from the un-started Phase 42; the structural backbone that lets the kiosk void-on-failure synchronously like checkout. Prereq for the kiosk money-path closeout.
- **MONEY-01 (H-3) Online captured-amount verification** — assert captured card amount ≥ recorded/invoiced total before booking (`checkout.js`); voids + rejects on mismatch.
- **MONEY-02 (H-4) Kiosk money-path defect closeout** — reconcile TTL/authoritative-Zoho check (H3), release idempotency lock on every failure path (H4), `voidTransaction` inspects reversal status (H5), `salesorder-pay` lock + unique ref (H8), sweep clears pending records (M13), `pos-recipe.js` adopts `money-path` primitives (M12).
- **MONEY-03 (H-5) Gift-card ledger integrity** — idempotent `reloadGiftCard` + append-only processed-ref ledger (H7); durable `needs_manual_review` on redeem failure + a test that asserts the flag not the log (H6); cell sanitizer for `=+-@` (M9); header-mapped `issueGiftCard` + bounded numerics (M18); negative-taxable-line tax parity (M15).
- **RESIL-01 (H-6) Fail-closed sweep of remaining call-sites** — one shared closed-on-Redis-error helper applied to promo (M1), rate-limit store mid-op (M4) + loopback (M5); quarantine legacy `/api/pos/sale` (M2); fail-closed gift-card account fallback (M3); allowlist `csv_url` (M6); auth+cache the Apps-Script GETs (M7,M8); validate `:id` (M20).
- **OBS-01 (H-7) Money-path observability + CI gates** — `Sentry.captureException` in every money-path catch (M17); `npm ci` in CI + Railway + Node pin (L1,L2); `--max-warnings 0` + an ES5 lint rule (L12); per-file coverage floor on `pos.js` (L13). Last — protects the earlier fixes from regressing.

**Key constraints:**
- Vanilla ES5 JS, no framework; kiosk/admin are iPad Safari staff tools; staging-first deploy; no staging middleware (staging calls prod middleware).
- The money-path fixes must not weaken the v4.2-hardened online checkout; every fix ships with a regression test that asserts the fail-*closed* behavior.
- De-fork (KIOSK-01) is behaviour-preserving with parity tests, not a redesign.

> **Milestone lineage:** v4.4 Audit Remediation is wound down — its shipped items (Phases 38–41: repo-hygiene/deferred, snapshot publish, facility images, SKU cart key) plus Phases 43–45 (kiosk custom line, gift-card lifecycle, security/money-path hardening) are complete. Its one un-started item, KIOSK-01 (was Phase 42), rehomes into v4.5. Phase 46 (auth re-arch) carries over as v4.5's SEC-02. Additive setup: nothing archived or renumbered below 46; new phases continue at 47.

## Current State: v4.2 Payment Path Hardening & Deploy Safety — SHIPPED 2026-06-19

v4.2 is complete and live in production (Phases 31–33). Delivered: honest, executable test coverage of the money path (route-level `POST /api/checkout` supertests, Helcim client + webhook HMAC tests, `routes/**` coverage with per-file floors); fail-closed hardening (reCAPTCHA rejects unauthenticated checkout before charge, webhooks reject unsigned events, Redis-down replay/idempotency guard returns 409, `validateEnv.js` fixed to live Helcim/Cal.com vars); access control (API-key enforcement on PII GET routes incl. `/api/snapshot`, body-shape validation on item/tax mutations); and deploy safety (test-gated production deploys, `prod-YYYYMMDD-N` tags + rollback runbook, uptime monitoring on `/health`, fail-closed prod secrets). Final audit: 14/14 requirements, 18/18 integration seams, 4/4 flows — the one cross-phase blocker (Phase 32's `/api/snapshot` API-key vs Phase 33's nightly snapshot job) was fixed and verified live on 2026-06-19 (authenticated fetch + CNAME-safe prod cross-push).

**Next milestone:** TBD — candidates from `PROJECT_ASSESSMENT.md` "Future Requirements" (decompose `processCheckout()`, de-fork kiosk POS into `kiosk-core.js`, `window.SV` namespace, static product rendering + JSON-LD, image pipeline, accessible dialogs, docs refresh) and open product issues (About-page placeholder copy, hero value-prop, WCAG contrast). Run `/gsd-new-milestone` to scope.

<details>
<summary>v4.2 milestone goal (for reference)</summary>

**Goal:** Make the money path trustworthy — test the online checkout, close the fail-open security gaps, and stop unsafe/untested code from reaching production.

Source: `PROJECT_ASSESSMENT.md` (Week 1 + Weeks 2–4). Continued phase numbering from Phase 31.

</details>

<details>
<summary>v4.1 BrewPad Batch Lifecycle & Zoho Sync — SHIPPED 2026-06-17</summary>

v4.1 (Phases 27–30 + sub-phases): full pending-batch lifecycle in BrewPad (visibility, one-click + guided activation, deletion), bidirectional Zoho customer sync (read-back endpoint + refresh-from-Zoho button + reassignment with invoice propagation), bulk pull of non-kiosk batch sales, wine drill-down analytics, and assessment quick-wins (dead-code cleanup, repo hygiene, presentation/contrast/404 fixes, kiosk cart-leak fix, XSS hardening). Also: transactional email moved to Resend, beer waitlist migrated to MailerLite, bottling invites via Resend, and `REDIS_ENCRYPTION_KEY` hardening (#106 closed).

</details>

## Requirements

### Validated

- ✓ Dashboard with batch status overview and upcoming tasks — v1.1
- ✓ Batch list with sorting, filtering, and detail view — v1.1
- ✓ Plato reading entry and chart visualization — v1.1
- ✓ Task management with grouping and completion — v1.1
- ✓ Multi-batch measurement entry — v1.1
- ✓ Pending batches visible and activatable from the admin batch list — Phase 27
- ✓ Batch activation — quick flip to Primary plus guided schedule/start/vessel option — Phase 27
- ✓ Fermentation schedule templates — v1.1
- ✓ Batch QR codes and PDF label generation — v1.1
- ✓ Google OAuth staff authentication — v1.1
- ✓ Batch creation with product/customer search — v1.1
- ✓ Auth sessions that persist reliably without silent expiry — v1.1
- ✓ Form state protection — unsaved work survives auth refresh — v1.1
- ✓ No duplicate/stacked login prompts — v1.1
- ✓ Kit sale on kiosk auto-creates a batch in BrewPad — v1.1
- ✓ Batches linked to Zoho sales orders for audit trail — v1.1
- ✓ Batch lifecycle visible from sale through fermentation to completion — v1.1

- ✓ Recipe data model with ingredient lists, quantities, and service fees — v2.0
- ✓ BeerSmith/BeerXML recipe import — v2.0
- ✓ Recipe CRUD for staff (admin interface) — v2.0
- ✓ Kiosk recipe sale with ingredient auto-population — v2.0
- ✓ Ingredient-level inventory deduction on recipe sale — v2.0
- ✓ BrewPad batches linked to recipe and individual ingredients — v2.0
- ✓ Brewing fee structure for beer/fermented products — v2.0
- ✓ Custom labels page with canvas mockup tool — v2.0
- ✓ Hop inventory catalog with radar charts and cart integration — v2.0

- ✓ Catalog subpages — dedicated pages per ingredient category (Grains, Yeast, Additives, Packaging, Equipment) — v3.0
- ✓ Sub-nav bar for category switching across ingredient pages — v3.0
- ✓ Cross-category product search with inline overlay — v3.0
- ✓ Appointment booking on Cal.com Cloud behind unchanged /api/bookings* contract — v4.0
- ✓ Cloudflare edge protection in front of GitHub Pages + Railway middleware — Phase 26
- ✓ Delete pending batches from the UI with confirmation — Phase 27.1
- ✓ Refresh a batch's customer info from its linked Zoho sales order/invoice (ZSYNC-01/02) — Phase 29
- ✓ Reassign the customer on a batch and propagate to the linked Zoho sales order/invoice — Phase 29.1 (v4.1)
- ✓ Activate pending batches from BrewPad — one-click + guided schedule/start, pending-aware status badge — Phase 29.2 (v4.1)
- ✓ Honest, executable test coverage of the money path: route-level checkout supertests, Helcim HMAC webhook tests, honest coverage thresholds with per-file money-path floors (TEST-01/02/03) — Phase 31 (v4.2)
- ✓ Fail-closed hardening: reCAPTCHA rejects unauthenticated checkout before charge, webhooks reject unsigned events, Redis-down replay/idempotency guard returns 409, `validateEnv.js` validates live Helcim/Cal.com vars (HARDEN-01/02/03/04) — Phase 32 (v4.2)
- ✓ Access control: API-key enforcement on PII GET routes (incl. `/api/snapshot`) + body-shape validation on item/tax mutations (PII-01/02) — Phase 32 (v4.2)
- ✓ Deploy safety: test-gated production deploys, `prod-YYYYMMDD-N` tags + rollback runbook, CNAME-safe nightly snapshot to prod (DEPLOY-01/02/03) — Phase 33 (v4.2)
- ✓ Monitoring: uptime monitor on `/health` + required prod secrets fail closed when absent (MONITOR-01/02) — Phase 33 (v4.2)

### Active

- [ ] Pre-made recipes browsable on public site (deferred)
- [ ] Custom recipe request flow for customers (deferred)

### Out of Scope

- New batch management features (refunds, advanced analytics) — future milestone
- Online checkout for recipe products — kiosk-only initially
- Customer-facing recipe builder — customers consult with staff, not self-serve
- Brewpad redesign or new tabs beyond recipe integration
- Automated pricing from supplier costs — manual margin management for now

## Context

- Federal brewing licence pending — system being built ahead of time
- Two one-off brews completed so far, recipes designed in BeerSmith
- Wine kits are single-SKU products from Zoho Inventory; beer recipes are fundamentally different (ingredient collections)
- Ingredients already tracked individually in Zoho Inventory (sold separately in the ingredients tab)
- Current fee structure: $45 Maker's Fee + $5 Materials Fee (wine); beer fee TBD (more involved process)
- Competitive pricing benchmarked against Terminal City Brewing (Vancouver)
- Pricing model uncertain: flat fee vs. variable by recipe complexity — needs research
- BeerSmith exports BeerXML format which is well-documented and importable
- Existing product card system supports wine label, beer label, and default card types
- Google Sheets + Apps Script backend for batch data; Zoho for inventory/sales

## Constraints

- **Tech stack**: Vanilla JS (ES5 + `var`), no framework changes — match existing patterns
- **Auth**: Google OAuth via GSI library for staff interfaces
- **Backend**: Google Apps Script + Sheets for batch/recipe data — Zoho for inventory/sales
- **Deployment**: Changes go to staging first, production only after manual approval
- **iPad-first**: BrewPad and kiosk UIs must work well on iPad Safari
- **Licence timing**: Beer sales cannot go live until federal brewing licence is granted

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Keep Google Sheets as batch backend | Already working, staff familiar, Apps Script API adequate | ✓ Good |
| Bridge kiosk→brewpad via middleware | Kiosk already talks to middleware; middleware can trigger batch creation | ✓ Good |
| Recipes as ingredient collections, not new SKUs | Ingredients already in Zoho; avoids duplicate inventory tracking | ✓ Good |
| BeerSmith as recipe design tool | Industry standard, BeerXML export is well-documented | ✓ Good |
| Kiosk-first for recipe sales | In-store consultation needed for custom recipes; online later | ✓ Good |
| Recipes in Google Sheets, not Zoho composite items | Zoho composite items don't auto-deduct via REST API invoice path | ✓ Good |
| locked_price set by staff, not computed from live rates | Avoids pricing drift from ingredient cost changes | ✓ Good |
| recipe_snapshot frozen at sale time | Immune to future recipe edits; batch always reflects what was sold | ✓ Good |
| Standalone JS modules for subpages (14-labels, 15-hops) | Not in concat:js; loaded independently per page | ✓ Good |
| Fail closed in production (reCAPTCHA, webhook secrets, Redis replay guard, validateEnv) | Money path must reject on missing config/infra, not silently proceed | ✓ Good (v4.2) |
| Test-gated production deploys via `gated-deploy.yml` | Failing frontend/middleware tests block the deploy; CNAME-safe + tagged | ✓ Good (v4.2) |
| Nightly snapshot pushes a snapshot-only commit on production's own `main` | gated-deploy force-pushes prod history; a plain cross-push can't FF and `--force` would clobber CNAME → 404 | ✓ Good (v4.2) |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-04 — Phase 78 (BrewPad waitlist tracking) complete and staging-verified: the beer waitlist is now a real queue rather than a MailerLite group. A `Waitlist` sheet tab is the system of record (D-01), `POST /api/waitlist` makes the sheet write authoritative with MailerLite demoted to fire-and-forget behind a persisted `mailerlite_synced` flag (D-03/D-07), and BrewPad gains a sixth Waitlist tab — ordered queue, one-way status cycle, Remove, inline notes, sync pill, filter/search. Six historical MailerLite subscribers backfilled in true signup order (D-04). Verified 11/11 must-haves; 9/10 staging UAT legs green with every write confirmed server-side. Four defects found and fixed in-phase: `ensureWaitlistSheet` crashed on an existing-but-empty tab (would have thrown on every live signup, not just setup); the beer signup form rendered at contrast ratio 1.00, making both the email input and the success confirmation literally invisible on `beer.html`; and code review's two Criticals — D-05's one-way status rule was client-side only (a direct API call could move a `booked` row back to `waiting`), and a `removed` customer re-signing up got a false success with no sheet change. Both Critical fixes verified against the LIVE deployment by direct API probe — the check the UI-driven UAT structurally could not perform. Middleware/frontend remain staging-only; the production cutover is pending. (Correction: an earlier draft of this footer said it should batch with Phases 73/75/76 — those are already live in production, verified 2026-09-04 against the `production` remote. The genuinely unshipped set is Phases 50 (partial), 51, 74, 78, 79.) One open human item: the Apps Script rollback version numbers were never recorded across either redeploy (`78-HUMAN-UAT.md`). Carried forward — Phases 51 and 79 now have Apps Script changes LIVE IN PRODUCTION (they rode along in both `adminApi.gs` redeploys) while their middleware/frontend halves are unshipped and need their own staging UAT; and `ensureGiftCardLedgerSheet` carries the identical empty-tab crash fixed here, needing its own ticket.*

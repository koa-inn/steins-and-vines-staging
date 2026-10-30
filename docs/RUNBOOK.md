# Production Deploy Runbook — Steins & Vines

## Overview

| Path | Trigger | Who | When to use |
|------|---------|-----|-------------|
| **Blessed** | `gated-deploy.yml` workflow_dispatch button in GitHub Actions | Developer (manual) | Normal production deploys — tests both surfaces, smoke-checks /health, writes record |
| **Break-glass** | `git push production main --force` | Developer (local) | Emergency only — bypasses tests, CNAME guard, tagging, and runbook entry |

Use the blessed path unless something is actively broken and you need to ship a fix without waiting for tests.

> **Install command (D-08):** CI (`tests.yml`) now runs `npm ci` (not `npm install`) in every job.
> Railway's Nixpacks builder auto-detects `npm ci` vs `npm install` based on whether a
> `package-lock.json` is present — now that `zoho-middleware/package-lock.json` is committed
> (Phase 53), Railway's middleware build switched to `npm ci` automatically. No `railway.toml`
> change was needed (it only sets `watchPatterns`). **If a future contributor deletes
> `zoho-middleware/package-lock.json`, Railway silently reverts to `npm install`** — keep the
> lockfile committed and in sync with `package.json`.

---

## Pending Production Promotions — ✅ SHIPPED 2026-07-10 (Stage 3 cutover)

**Production is now at the full v4.5 Stage-3 + v4.6 GA4 cutover** (tag `prod-20260710-2`, blessed
`gated-deploy.yml` run 29127742148). Shipped as one coupled deploy after the iPad UAT (48/54) +
GA4 staging verification passed. Frontend live (kiosk-core, Metricool CSP, GA4 events); middleware
redeployed (uptime reset, redis ✅) with the Phase 54 gift-card/void scope + `pos.js` + brewpad.

| Item | Shipped | Notes |
|------|---------|-------|
| **Phase 48** — kiosk POS de-fork (`kiosk-core.js`) | ✅ | Standalone UAT verified + 22/22 threats secured. |
| **Phase 54** — kiosk gift-card mgmt (device-token `gift-card/void` scope, D-54-GC) | ✅ | Money-path/auth change — **keep eyes on Sentry**. |
| **Kiosk fixes** — Back button, load resilience (`36bf00c`), Clear-customer (`05800a4`) | ✅ | Frontend. |
| **brewpad** — quantity-aware batch creation | ✅ | Middleware. |
| **Metricool CSP allowlist** (15 public pages) | ✅ | Prod CSP live → Metricool no longer CSP-blocked. |
| **GA4 ecommerce events** (v4.6 Phase 55) | ✅ | GA4 delivery pending Realtime confirm on a live prod order. |

> **Fix 1** (`device` tier on `?bust=1`, `54291bc`, tag `prod-20260710-1`) was already on prod via
> the 2026-07-10 break-glass; ancestor of this deploy (no-op here).

### Stage 3 checklist — Metricool (CSP ↔ GTM ordering)

The Metricool tag lives in **GTM (container `GTM-NHRCGLC5`)**, which is shared across staging
AND production. The CSP that allows it is deployed **per-repo**, so it must reach production
**before** the GTM tag is published, or Metricool is CSP-blocked on prod (harmless console
error + no tracking, but avoid it):

- [ ] **Before publishing the GTM tag:** confirm the Metricool CSP change is live on production (`curl -s https://steinsandvines.ca/index.html | grep -c tracker.metricool.com` → `1`). It rides this Stage 3 deploy.
- [ ] Test the GTM Metricool tag in **GTM Preview mode against staging** first (no publish) — no CSP violations in console, Metricool dashboard registers the visit.
- [ ] **Only after prod CSP is live:** Submit/Publish the GTM container so Metricool goes live on production.
- [ ] If Preview shows an **image/pixel** CSP violation, add `https://tracker.metricool.com` to `img-src` on the same 15 pages and redeploy before publishing.
- [ ] Staff surfaces (`kiosk/admin/brewpad/batch`) intentionally have **no** Metricool/CSP — do not add it there.

---

## Deploy History

<!-- gated-deploy.yml inserts each new deploy row directly under the table separator below (newest first). -->

| Date | Git SHA | Railway Deploy ID | Deploy URL | Notes |
|------|---------|-------------------|------------|-------|
| 2026-10-30 | `15221012` | n/a (no middleware change) | manual `git push production 15221012:main` (tag `prod-20261030-4`, fast-forward) | **Copy only**: "about 29 bottles" per batch on the homepage (limited-release banner, How it works, Why) and the limited releases price note; replaces "about 30" / "28–30". Gates: frontend 3301, middleware 3967 (Node 24), lint. Smoke: prod index.html and limited-releases JSON serve the new text. Rollback target `fac670b6` (prod-20261030-3). |
| 2026-10-30 18:20 UTC | `fac670b6` | `6aae93bd-45b7-4344-b9ad-71f6bc6767f1` | manual `git push production fac670b6:main` (tag `prod-20261030-3`) | **Phase 100 LAUNCH**: Limited Releases nav link on 23 pages, homepage feature banner, sitemap entry, noindex removed; `PREORDER_DEPOSITS_ENABLED=true` set on production (deposits OPEN). Owner chose free config checks instead of a real $50 prod deposit (see 100-14-SUMMARY). Smoke: health ok quota 763/1000; initialize empty basket 400. Stop deposits: unset the flag. Rollback target `a7966905` (prod-20261030-2). |
| 2026-10-30 18:13 UTC | `81293db8` | `a7966905-979f-4217-857f-c5d635a23c8b` | manual `git push production 81293db8:main --force` (tag `prod-20261030-2`) | **Phase 100 code to production, deposits OFF** (Plan 14 Task 1 step 2): limited-releases.html deployed unlinked + noindex, `/api/preorder/*` (kill switch `PREORDER_DEPOSITS_ENABLED` unset → initialize 503), deposit-aware kiosk SO card/pay (LIMITED SOs only), money-path finalize advance (LIMITED only), checkout contact helper extraction, refunds §D / terms §9 deposit sections, homepage banner CSS (markup at launch). Force needed because prod ran the cherry-picked quota hotfix (`6087783c`); main carries the same changes as originals. Gates: frontend 3304, middleware 3967, lint, build (no artifact drift). Smoke: `/health` ok quota 775/1000; kiosk/products/ingredients 200; initialize 503 "not open yet"; site pages 200 (bare curl gets Cloudflare 403 — use a browser UA). Rollback target `8779dfb4` (prod-20261030-1). |
| 2026-10-30 17:54 UTC | `6087783c` | `8779dfb4-0cfe-4289-ba41-82e5e6ad9c9b` | manual `git push production 6087783c:main` (tag `prod-20261030-1`, branch `release/prod-20261030-quota`) | **Hotfix — Zoho Inventory quota guard (quick 261029-zq1)** cherry-picked onto `3f761072`: last-good kiosk/website catalogue fallback (`source:'stale'`), 6 h item-detail cache, quota guard from `x-rate-limit-*` headers (code 45 → paused until reset; background refreshes skip below 250), one low/exhausted alert email per env per day, kiosk sales price from last-good when the rebuild fails. Carries NO Phase 100 code (zohoPostOnce/zohoDelete and deposit emails dropped in conflict resolution). Staging runs `ZOHO_SCHEDULED_JOBS=off`. Incident: 2026-10-29 ~17:00 PT the shared 1,000/day Inventory quota ran out and the prod kiosk could not load products until midnight. Local gates: frontend 3209, middleware 3810, lint. Post-deploy: `/health` quota 796/1000, kiosk 542 items 200, products/ingredients 200. Rollback target `c790fb0f`. |
| 2026-10-29 19:22 UTC | `3f761072` | `c790fb0f-e2b0-4140-aa7b-01cc0300eb69` | manual `git push production 3f761072:main` (tag `prod-20261029-1`) | Phase 96: BrewPad v2 dashboard graphs G1–G10 (four sections, per-widget options, Chart/Table, drill-through); get_dashboard_stats adds taskRows, readings, vessels, batchMeta (read-only, no migration). Rollback target `a3cce010`. |
| 2026-10-28 20:07 UTC | `33d10f48` | `a3cce010-575e-4f2f-91fa-3296a88bf130` | manual `git push production 33d10f48:main` (tag `prod-20261028-2`) | Phase 95: BrewPad v2 dashboard (opt-in per device: global filters, Chart.js 4.5.1 self-hosted, click-through drill, trend deltas), staff_batch flag + migration 0008, staff backfill CLI (--exclude, --expect-ids). Rollback target `d8ffd7bd`. |
| 2026-10-28 02:52 UTC | `3f64da2d` | `d8ffd7bd-3149-4ea1-ad18-c9fd5421cfb6` | manual `git push production 3f64da2d:main` (tag `prod-20261028-1`) | Phase 94 review fixes CR-01 (reopen clears completed_at), WR-01..04; body-parser 1.20.9 + qs 6.16.2 security patch |
| 2026-10-27 22:10 UTC | `141901a7` | `896f6942-dff8-4ccc-af7b-42ae658281ce` | manual `git push production 141901a7:main` (tag `prod-20261027-1`) | Phase 94 BrewPad dashboard correctness + batch_type (migration 0007), get_dashboard_stats, backfill CLIs |
| 2026-10-22 23:57 UTC | `2b397c89` | `unknown (TIMEOUT-UNKNOWN)` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/39872485531) | Kiosk catalog speed-up, BrewPad list + task-count fixes, links page tracking/consent/hours, newsletter signup + staff alerts (site + checkout), follow-redirects security patch |
| 2026-10-17 20:09 UTC | `bb879a8c` | `ea61a171-2ba5-4bf2-9c27-e430ade0cbd2` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/39065193738) | Beer page em dashes, By-customer payments rule, Ledger arrow fixes |
| 2026-10-17 19:47 UTC | `d12b4b9b` | `b3fd002a-f9e1-4f72-bbf0-2791866c086e` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/39063576769) | 86-19 release: Phase 86/87 code dormant (sheets), Phases 89/90/92/93 live |
| 2026-10-16 19:46 UTC | `2ce88fb8` | (Railway auto) | manual pinned push (prod commit `ff3239cf`) | Inventory-ledger fix (f060f5a9): Zoho stock increases now reach the kiosk/website. A kiosk-sale hold lasts 10 min; a website-order hold is unchanged. Gate on Node 24: FE 2197, MW 2562. Post-deploy: healthy, store modes GIFT_CARDS_STORE=postgres / RECIPES_STORE=sheets, catalog 529 items, airlock 11 = Zoho. |
| 2026-10-16 17:33 UTC | `b0adb2c9` | (no middleware change, no Railway redeploy) | manual pinned push (prod commit `ee1a2bf1`) | Kiosk display fixes on release/85-13-node24: Recipes mode hides the product list in table view (2c834956), and the locked recipe tile shows the in-store price with fees (72a2562f). Front end only. Gate on Node 24: FE 2197, MW 2555. Live kiosk.html serves stamp mvb8wrze with both fixes. The middleware kept running (uptime ~16.7 h). |
| 2026-10-16 00:31 UTC | `74febd5d` | `7afa6b6e-c08f-49e7-86d8-108b2b39b097` | manual pinned push (prod commit `2539cd02`) | **85-13 code + Node 24 + beer launch**. `release/85-13-node24` = d2c66be9 + cherry-picks: the kiosk recipe money-path chain (6029ed7f, 5404abea, 255c5e13, 4849f473, 60d7b32f, f4272eed, ae191772, c10e8111, 0cfbd181, 030846c4), Node 24 (abc4d42e), kiosk receipt fix, beer page fixes and launch, plus the owner-review page tweaks. The gated workflow was not used because its RUNBOOK step pushes `main`; the CNAME swap was done by hand, the same as the workflow does it. Gate on Node 24: FE 2193, MW 2555. Post-deploy: v24.21.0 / tz 2026c (PDT in Nov); 0003_recipes applied; RECIPES_STORE=sheets, GIFT_CARDS_STORE=dual; beer page live. BEER_SALES_ENABLED re-enabled. Prod recipe test sale INV-000241 was Paid with total == charge ($4.88, txn 56649148) and was then cleaned up. |
| 2026-10-06 22:36 UTC | `bb97c735` | `b6f160c1-1617-4e82-aef0-f976a198b93a` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/37541167223) | Helcim reversal/refund webhooks no longer treated as approved charges (fe6e8eb2); beer page held back |
| 2026-10-06 22:17 UTC | `c229d919` | `6a143c36-0371-494e-afcc-de664c7480e9` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/37539256410) | Money-path fixes: Helcim void/refund v2 fields (c229d919), kiosk per-rate tax rounding (26be3828), manual-confirm void txn id (c961e6bb), Buy Kit kit-only price (7eb2b0f8); beer page held back |
| 2026-10-06 17:51 UTC | `af261d83` | `8db27979-f611-4fe3-a8c5-108f36a5fc48` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/37506054882) | Phase 84 code + Phase 83 gap-closure + gift-cert digit entry (11b5c27b) + proxy-addr 2.0.8 (af261d83); GIFT_CARDS_STORE unset = sheets; beer page held back |
| 2026-10-02 18:51 UTC | `d47dab85` | `f104c500-2ae4-4550-813e-3f3c79825ebc` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/37049773828) | Phase 83 Postgres infrastructure (DB-02): lib/db.js, migrations on deploy, /health database field, store-flag + mirror gate; empty schema |
| 2026-09-30 17:47 UTC | `d581eb89` | unknown — workflow recorded the *previous* deployment `1d502419…` (capture race, fixed in `ff5515e8`); read the real id from Railway → Deployments | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/36753725754) | Phase 82 store-agnostic prerequisites |
| 2026-09-23 18:59 UTC | `b404d061` | `1d502419-0741-4709-8f72-4686627512db` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/35906086255) | zoho-auth refresh-token re-persistence (aaf6112a); beer page stays held back |
| 2026-09-23 18:08 UTC | `6e05a60d` | `5b0fe0d2-64ec-4a5d-854b-5c4781c869ce` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/35900308822) | Cutover batch 2026-09-23: Phase 81 ferment timeline; 74 catalogue pages (wine live, beer page held back unlinked+noindex); 78/80 waitlist; 79 recipe save perf; 73/75/76; 50/51 kiosk money-path; policy pages + checkout acknowledgement + cookie consent + confirmation-email and admin cost fixes; 2026-09-16 pre-cutover fixes |
| 2026-07-21 18:10 UTC | `d3bfc71c` | `0c5e284e-c141-4990-9785-3134ad8ee75b` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29855996465) | Ship bottling-invite send-tracking (0545644c) + resolve high brace-expansion advisory (d3bfc71c) |
| 2026-07-17 17:37 UTC | `6a7b0ddd` | `0737843b-e894-464b-848a-c416423f489b` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29600712385) | fix(auth): x-session-token header for cross-site BrewPad/admin session (customer lookup 403 fix). Backward-compatible; middleware accepts cookie OR header. FE1019/MW1304 green. |
| 2026-07-16 14:03 UTC | `604ca32a` | `8b46e404-0cc8-42aa-baed-c233d7d0ccbf` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29504800191) | Phase 57 kiosk stale-catalog fix: 57-03 client self-heal + pre-checkout phantom guard + sale-error beacon w/ readable item_id; 57-04 server bounded catalog auto-reconcile + un-redacted item_id. Also promotes 58 (admin kit-price guard) + 59 (facility-photo placeholder), staging-verified. Full gate green FE1019/MW1301; code review 0 blocker/2 warning. |
| 2026-07-15 14:27 UTC | `67e6919b` | `f839c433-5a8d-46be-a81b-1b63076a4a67` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29423511940) | Phase 57-01 kiosk client-error capture: new POST /api/kiosk/client-error telemetry endpoint (device-token gated, PII-scrubbed, rate-limited, returns 204, no money/data side-effect) + ES5 kiosk beacon wired into all 4 failure catches. Middleware change → Railway will redeploy. Turns on the error capture the store iPad needs for the Phase 57-02 diagnosis. Verified on staging; FE 1002/62, MW 1291/81 green. |
| 2026-07-14 15:04 UTC | `66d538de` | `5da57cda-791d-4fd3-93a7-645b0f8dfd53` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29343594023) | Daily-ops fixes: kiosk product-name escaping (audit M-C1), iOS auto-zoom on sub-16px POS/admin inputs (M-C2/M-C3), 44px touch targets + terminal-bar safe-area (M-C4/M-C5), BrewPad pinch-zoom restored (M-C7). Frontend only - no middleware changes, money path untouched. Verified on staging. |
| 2026-07-10 22:27 UTC | `43b6c5c5` | `0a7eae08-cc2e-4073-bfe1-baeef75a06cd` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/29127742148) | Stage-3 cutover: Phases 48+54 + kiosk fixes + Metricool CSP + GA4 |
| 2026-07-10 14:24 UTC | `54291bc` | `manual` | break-glass (no Actions run) | **Break-glass hotfix** — Fix 1 only: allow `device` tier on `/api/kiosk/products?bust=1` (`0d9fe73` cherry-picked onto `21b0c428`). Tag `prod-20260710-1`. Deliberately does NOT carry Phases 48/54, Metricool CSP, or the Back button. Gates run locally: middleware 1251 tests, lint, `npm audit --omit=dev` clean. Post-deploy `/health` 200 redis=true; Railway uptime reset confirmed. |
| 2026-07-08 18:02 UTC | `21b0c428` | `f6a45777-13ef-4516-a6a9-50f28c345f8b` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/28964582252) | v4.5 auth cutover Stage 1 — deploy origin/main (phases 46-53), excludes Phase 48 |
| 2026-06-27 20:46 UTC | `3d770f29` | `31585f6d-cd04-4785-9b46-ecf34303a481` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/28301299186) | Promote v4.4: recipe cart-collision undercharge fix + imperial scaling + Phase 43 custom line item + Phases 39/41 |
| 2026-06-26 21:50 UTC | `50465bc6` | `ca24b052-023e-40ad-9c1c-9200d648a0d2` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/28267197386) | Hotfix: kiosk customer-search x-api-key (prod-down) + promote v4.4 discount feature + facility image optimization |
| 2026-06-19 04:22 UTC | `5d6aa93d` | `5081cbbf-5c09-41eb-aba6-649416509705` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/27805206730) | Recipe builder: Refresh from Zoho button (5d6aa93) |
| 2026-06-19 04:11 UTC | `6ce1620f` | `014207ee-c805-4aee-9c9f-b50a79faa7aa` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/27804840892) | Recipe list: dynamic/ingredient-based price display + computed_price cold-cache fallback (6ce1620) |
| 2026-06-19 00:51 UTC | `c9eff325` | `1d3a061c-4386-4ef3-b67c-ad50a22335e9` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/27798555795) | Recipe editor: fix catalog-load race (shifting cost/retail numbers), commit c9eff32 |
| 2026-06-18 23:11 UTC | `9bd98bdc` | `54bc4013-2fd6-48df-b6e7-9b8250a824aa` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/27794924337) | Recipe builder Internal Only items (2c49dec) + high-CVE dep patch (9bd98bd) |
| 2026-06-18 14:11 UTC | `04c09d98` | `0461dc19-d188-48e9-858e-c33d6a996d17` | [Run](https://github.com/koa-inn/steins-and-vines-staging/actions/runs/27765441259) | testing deploy workflow |

---

## Rollback

### GitHub Pages (frontend)

Use `git revert` to produce a new commit that undoes the bad change, then force-push to production.
`--force` is required because production/main may have diverged from staging/main after a force-push.

**Revert one commit:**

```bash
git revert --no-edit HEAD
git push production main --force
```

**Revert multiple commits:**

```bash
git revert --no-edit HEAD~N..HEAD
git push production main --force
```

> **Important:** Ensure `CNAME` contains `steinsandvines.ca` on the local branch before pushing to production. Verify with `cat CNAME` first.

The `deploy-production.yml` workflow on the production repo will rebuild and republish GitHub Pages automatically.

### Railway (middleware)

**Option 1 — Railway Dashboard (recommended):**

1. Go to [Railway dashboard](https://railway.app) → Project `sv-middleware` → `svmiddleware-production` service
2. Click the **Deployments** tab
3. Find the last known-good deployment (match against RUNBOOK deploy history by SHA or date)
4. Click the three-dot menu (…) next to that deployment → **Rollback**
5. Railway restores both the Docker image and environment variables from that deployment

> **Constraint:** Only deployments with `canRollback: true` can be rolled back (Railway retains deployments based on plan retention policy).

**Option 2 — GraphQL API (programmatic):**

```graphql
mutation deploymentRollback($id: String!) {
  deploymentRollback(id: $id) {
    id
    status
  }
}
```

Pass the Railway deploy ID from the Deploy History table above. Requires a project token.

> **Note:** `railway deployment redeploy` only re-runs the CURRENT latest deployment — it is NOT a rollback to a previous version. Use the dashboard or GraphQL mutation to roll back.

#### Postgres (Phase 83)

- **App rollback is safe.** Rolling the middleware back to a pre-Phase-83 deployment (either
  Railway dashboard rollback above, or a code revert) is safe: the old code never reads
  `DATABASE_URL`, and the schema Phase 83 adds is additive-only — nothing pre-83 depends on it.
- **A failed pre-deploy migration aborts the deploy.** `preDeployCommand` (`npm run migrate`,
  repo-root `/railway.toml`) runs `migration-guard.js` then `node-pg-migrate up` in a separate,
  ephemeral container before the new release goes live. A non-zero exit there aborts the deploy
  entirely — Railway keeps the previous release running and does not retry (D-03). **Fix forward**
  with a new migration file; never edit an already-applied one.
- **Destructive changes go through the manual path only.** Any `DROP`/`TRUNCATE`/`RENAME`/
  `ALTER ... TYPE`/`DELETE`/`UPDATE` is rejected by `migration-guard.js` inside a normal
  `node-pg-migrate` migration. Such changes are only made via
  `zoho-middleware/migrations-manual/README.md` (D-04), run by hand, never as part of an automated
  deploy.
- **Database rollback in this phase = delete the Postgres service.** Nothing reads from either
  Postgres database yet — Phase 84 is the first consumer — so there is no in-place DB rollback
  procedure to maintain this phase; if the Postgres service itself needs to be undone, delete it
  (staging or production) and re-provision per the "Railway Postgres (staging + production)" steps
  above.
- **Store rollback from Phase 84 onward = `<STORE>_STORE=sheets`.** Once a store is reading from
  Postgres (Phase 84+), rolling that store back to the Sheet-only path is a config change, not a
  deploy: set that store's `<STORE>_STORE` environment variable to `sheets` (D-05). Not applicable
  yet in Phase 83 — no store reads from Postgres.

**Staging verification (2026-10-02):**

- `/health` on staging: `status: ok`, `authenticated: true`, `redis: true`, `database: true`.
- Pre-deploy migration confirmed: **yes** — pre-deploy logs show `migration-guard: 1 file(s)
  additive-only OK`, then `node-pg-migrate` applying `0001_init`, deploy successful.
- Mirror DISABLED on staging confirmed: **yes** — deploy logs show
  `[sheet-mirror] mirror DISABLED (environment=staging)`, with store modes
  `GIFT_CARDS_STORE: sheets`, `RECIPES_STORE: sheets`.
- Backfill rehearsal (schema `scratch_83_rehearsal`, no `--promote`, connected via the private
  tunnel, not the public proxy):
  | Sheet | Read | Accepted | Rejected | Checks | Exit code |
  |-------|------|----------|----------|--------|-----------|
  | VesselHistory | 401 | 401 | 0 | PASS (25 checks) | 0 |
  | PlatoReadings | 68 | 68 | 0 | PASS (26 checks) | 0 |
  | FermSchedules | 11 | 11 | 0 | PASS (25 checks) | 0 |
  First rehearsal attempt rejected 100% of rows (reason category: spec `header` values did not
  match the real sheet row 1). While diagnosing, also found a live data bug unrelated to the
  rehearsal spec itself: the VesselHistory sheet's header row was missing a `bin_id` column that
  Apps Script had been appending since Feb 2026, shifting data one column right of its headers
  (owner-approved fix: inserted the missing header in the live sheet). After the spec and sheet
  fixes, the second rehearsal run (table above) passed with zero rejects on all three sheets.
  `scratch_83_rehearsal` was dropped (`DROP SCHEMA ... CASCADE`) after the rehearsal — staging
  Postgres holds a full real copy by design (D-11), but no real tables exist yet for these three
  sheets, so nothing was promoted or loaded outside the scratch schema.
- **Go/no-go for Plan 83-09: GO for code.** All DB-02 success criteria (SC1-SC4) are verified live
  on staging; the backfill pipeline is proven end-to-end against real data. One pre-existing,
  unrelated CI failure (`test-e2e`, failing on staging `main` since at least 2026-09-23) should be
  checked against any gated-deploy workflow gate before 83-09, since it is not a Phase 83
  regression but could still block an automated deploy gate that waits on the `Tests` workflow's
  overall conclusion.

**Production cutover (2026-10-02):**

- **Owner approval:** owner replied "approved" in chat on 2026-10-02, confirming the staging
  evidence above and that production `DATABASE_URL` still references the production Postgres
  (reference `${{Postgres-EMVk.DATABASE_URL}}`, set 2026-09-30 — Railway references cannot cross
  environments, so this cannot silently point at staging).
- **Rollback target recorded before dispatch:** Railway deployment id
  `14b8afd4-a673-4b64-a922-ca3f22adfea2` — the ACTIVE `svmiddleware-production` deployment
  immediately prior to this cutover.
- **Backups (D-16):** unchanged — still NOT AVAILABLE (Hobby plan). Remains a Phase 84 blocker;
  this deploy ships only the empty schema (D-17), so no real balances are at risk yet.
- **Dispatch:** `gh` CLI was unauthenticated in this session, so the gated workflow was dispatched
  via the GitHub Actions web UI instead of `gh workflow run` — **Gated Production Deploy #23**,
  run id `37049773828` (see the Deploy History row above), targeting staging `main` at `d47dab8`,
  reason: "Phase 83 Postgres infrastructure (DB-02): lib/db.js, migrations on deploy, /health
  database field, store-flag + mirror gate; empty schema".
- **Workflow result:** `test-middleware` success (including the `test:db` Postgres integration
  suite), `test-frontend` success, `deploy` job success. New production Railway deployment id
  `f104c500-2ae4-4550-813e-3f3c79825ebc`.
- **Production `/health` verified:** `{"status":"ok","authenticated":true,"redis":true,
  "database":true}`, fresh uptime (~78 s at check time). `/api/products` returned 200.
- **Production logs confirmed (Task 3):** pre-deploy logs show
  `migration-guard: 1 file(s) additive-only OK` followed by `node-pg-migrate` applying `0001_init`
  with exit 0; deploy logs show `[sheet-mirror] mirror ENABLED (environment=production)` with
  store modes `GIFT_CARDS_STORE: sheets`, `RECIPES_STORE: sheets` — nothing reads or writes
  Postgres for customer data yet, matching the D-07/phase-boundary expectation.
- **Result:** Phase 83 (DB-02) is now live in both staging and production, each on its own
  Postgres database, with migrations applying on deploy and the Sheet mirror correctly gated per
  environment.

### Apps Script (`adminApi.gs`)

Apps Script is **entirely outside `gated-deploy.yml`**. There is no CI path, no smoke check,
and no staging isolation:

- **One deployment serves staging AND production.** There is no staging Apps Script.
- **Staging and production share one Google Sheet.** Any sheet write made while "testing on
  staging" hits live production data.
- Project: "SV Website", script ID `1uD14PTT2lMWV06FAKcEs6Z_YKsEvnUuk9fOFycu7emiOPyh9jC0KTvUH`.
  Note there are **two** Apps Script projects with this same name — the correct one contains
  `Code.gs`, `trackEvent.gs`, `adminApi.gs`, `backup.gs`.

**Deploy sequence:**

1. Deploy → Manage deployments. **Record the currently active version number** — that is the
   rollback target. Do this every time, even for backward-compatible changes.
2. **Check for editor drift before pasting.** The editor is the live source; if someone edited
   it without committing back, pasting the repo file destroys that work silently. Hash both
   sides and compare — in the editor's devtools console:
   ```js
   const m = monaco.editor.getModels().find(x => String(x.uri).includes('file_3')); // adminApi.gs
   const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.getValue()));
   Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
   ```
   against `git show <last-commit-touching-adminApi.gs>:apps-script/adminApi.gs | shasum -a 256`.
   Only paste when they match (or when the difference is understood).
3. `cat apps-script/adminApi.gs | pbcopy`, click into the editor, `cmd+A`, `cmd+V`, `cmd+S`.
   Wait for "Saved to Drive". Re-hash to confirm the paste landed exactly.
4. Deploy → Manage deployments → pencil (edit) → Version: **New version** → add a description →
   Deploy. **Never "New deployment"** — that mints a second URL and splits traffic.
5. The Web app URL does not change when updating an existing deployment, so no
   `js/admin-config.js` or Railway `APPS_SCRIPT_URL` update is needed.

**Rollback:** Deploy → Manage deployments → pencil → select the recorded previous version →
Deploy. Prefer this to forward-fixing a live deployment.

**Deploy record:**

| Date | Version | Previous (rollback target) | Change |
|------|---------|----------------------------|--------|
| 2026-10-16 | 65 | **64** | **Phase 89 review MD-02**: Recipes ensure-column helpers read headers via recipesHeaderRow (an empty tab no longer throws) and setupRecipeBeerCategoryColumn has a null guard (9e93341b). Pasted adminApi.gs SHA-256 prefix b6abf41ce7cc. Production probes 2026-10-16: get_recipes 13, get_ferm_schedules 12, get_batches 206; public /api/recipes 11 with Ready in on all. |
| 2026-10-15 | 64 | **63** | **Phase 90**: batchSourceTransitionDecision + guarded 'source' in updateBatch allowedFields (manual<->internal only, blank editable, automated sources rejected before any write). Pasted adminApi.gs SHA-256 prefix 0d8ef00e2058. Production probes 2026-10-15: batch list loaded, SV-B-000236 detail opened with tasks and location history, no errors. Phase 89 row already filled (v63). |
| 2026-10-14 | 63 | **62** | **Phase 89**: additive BEER_CATEGORY_KEYS / normalizeBeerCategory, self-migrating beer_category column in createRecipe / updateRecipe / mirrorRecipeState (off-list rejected with invalid_data before any write), editor-run setupRecipeBeerCategoryColumn. Owner ran setupRecipeBeerCategoryColumn (ok). Production probes 2026-10-14: Recipes list loaded 13 recipes; German Pilsner opened; draft "ZZ TEST 89 2026-10-14" create, edit and delete all succeeded and the recipe is gone; no console errors. |
| 2026-10-09 | 62 | **61** | **Phase 87** (87-04/87-18): additive `mirror_batch_state`, `mirror_batch_delete`, `export_batch_tabs` (server_token-gated, not reachable by staff OAuth), `setupBatchMirrorNotices` / `removeBatchMirrorNotices` (run from the editor). Pre-paste editor-drift hash check was skipped (paste done first); post-paste editor hash of `adminApi.gs` matched the repo (`a8b34634…121a98`). Production probes after deploy: `get_batches` ok:true; `export_batch_tabs` ok:true (204 / 1068 / 70 / 427 rows). |
| _pending_ | 61 | **60** | **Phase 86** (planned): additive `mirror_vessel_state`, `mirror_ferm_schedule_state`, `mirror_ferm_schedule_delete` (server_token-gated); staff email recorded in VesselHistory. Fill in date and probe results at deploy time (Ops data → Postgres §3). |
| 2026-10-07 | 60 | **59** | **Phase 85** (85-04): additive `mirror_recipe_state`, `mirror_recipe_delete`, `recipe_batch_ref_count` (server_token-gated). Editor-drift hash check passed before paste; post-paste hash matched repo. `GET /api/recipes` returned 3 active recipes from Apps Script on production and staging after deploy. |
| 2026-09-24 | 58 | **57** | Pre-existing fixes found in the Phase 82 staging walk: public batch cache bound to the token that passed (`0d460a6e` — closes a 5 s any-token read of `get_batch_public`); `propagateFermSchedule` no longer duplicates completed steps / mislabels packaging, and evicts per-batch caches (`ff1436b7`). Live-verified on staging test batch SV-B-000221: bogus + malformed tokens rejected right after a valid view, valid token works right after a bogus one; propagate of an added step produced A(done), B, C, one Packaging, visible immediately. |
| 2026-09-23 | 57 | **56** | **Phase 82** (82-02/82-03): admin proxy `server_token` write entries, inventory/schedule actions, `get_ingredients`/`get_homepage` reads, D-18 lock fixes, per-task cache bust, removed `get_config`/`update_schedule`/`update_kits`. Non-mutating probes 1-7 + 9 passed (`scripts/phase82-appsscript-probes.sh`). Pre-paste editor-drift hash check was skipped. |
| 2026-09-05 14:11 | 56 | **55** | **Phase 81**-01: `schedule_id` column self-migration + `'gfs'` cache-bust on FermSchedules CRUD |
| 2026-09-04 13:42 | 55 | 54 | Phase 80 waitlist schema (pre-existing record, reconstructed from version history) |

> ⚠ **Known config drift (pre-existing, unresolved).** The live deployment is configured
> `Execute as: Me (hello@steinsandvines.ca)` + `Who has access: Anyone`, but `docs/APPS_SCRIPT.md`
> and `adminApi.gs`'s own header both say it MUST be `User accessing the web app` +
> `Anyone with Google Account`. Consequence: `Session.getActiveUser().getEmail()` returns empty,
> so that limb of `checkAuthorization` is dead code in production and a direct browser GET to
> `/exec` returns `unauthorized`. Real authorization rests on the OAuth-token path and the
> server-token bypass, both of which work — so this is not an open endpoint, but the documented
> security model is not the deployed one. Needs its own investigation; do not change it as a
> side-effect of a deploy.

---

## Smoke-check Semantics

The `gated-deploy.yml` workflow polls `https://svmiddleware-production.up.railway.app/health` after each deploy.

| Condition | Behavior |
|-----------|----------|
| HTTP status != 200 | **HARD FAIL** — workflow exits 1, deploy flagged as failed |
| `redis: false` in body | **HARD FAIL** — Redis not connected; exit 1 |
| `authenticated: false` in body | **SOFT WARN** — logged only, deploy proceeds. Zoho OAuth drops on every Railway restart; re-authenticate at `/auth/zoho` |
| HTTP 200 + `redis: true` | **PASS** |

The smoke-check retries up to 5 times with 20-second waits to allow for Railway cold-start.

**Re-authenticate Zoho after deploy:**
```
https://svmiddleware-production.up.railway.app/auth/zoho
```

---

## Human Prerequisites (one-time setup)

Complete these before triggering the first gated deploy.

### PROD_DEPLOY_TOKEN

The gated-deploy workflow needs write access to `koa-inn/steins-and-vines-production`.

- [ ] Go to GitHub → Settings → Developer Settings → Personal access tokens → Fine-grained tokens
- [ ] Set **Resource owner:** `koa-inn`
- [ ] Set **Repository access:** `koa-inn/steins-and-vines-production` only
- [ ] Set **Permissions:** Contents → Read and Write
- [ ] Set **Expiry:** Maximum (1 year). Add a calendar reminder to renew.
- [ ] Copy the token
- [ ] On the staging repo (`koa-inn/steins-and-vines-staging`): Settings → Secrets and variables → Actions → New secret: `PROD_DEPLOY_TOKEN`

> **Pitfall:** Fine-grained PATs expire. A 401 on `update-snapshot.yml` or the gated deploy push step means the token expired — regenerate and update the secret.

### RAILWAY_TOKEN

Used to capture the Railway deploy ID in the runbook entry. If absent, the deploy ID will be `unknown` (non-blocking).

- [ ] Go to [Railway dashboard](https://railway.app) → Project Settings → Service Tokens → Generate
- [ ] Scope: `sv-middleware` service + `production` environment
- [ ] Copy the token
- [ ] On the staging repo: Settings → Secrets and variables → Actions → New secret: `RAILWAY_TOKEN`

### Railway "Wait for CI" (Approach A)

Ensures Railway holds the auto-triggered deploy until this workflow's test checks pass.

- [ ] Railway dashboard → `svmiddleware-production` service → Settings
- [ ] Enable **"Wait for CI"** toggle
- [ ] Verify: push a commit to staging that touches `zoho-middleware/` and confirm Railway shows the deploy in WAITING state until GitHub checks complete

**If "Wait for CI" causes false skips** (Railway marks deploy SKIPPED due to an unrelated failing check suite from CodeCov, Dependabot, etc.):

Switch to Approach B:
1. Dashboard → Service Settings → disable GitHub autodeploy
2. Add this step to the `deploy` job in `gated-deploy.yml` (after the force-push step):
   ```yaml
   - name: Deploy middleware via Railway CLI
     run: railway up --service sv_middleware --ci
     env:
       RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
   ```

### UptimeRobot Keyword Monitor

External uptime monitoring independent of GitHub CI (D-08).

- [ ] Create account at [uptimerobot.com](https://uptimerobot.com) (free, no credit card)
- [ ] Click **Add New Monitor**
- [ ] Monitor Type: **Keyword**
- [ ] Friendly Name: `sv-middleware /health Redis`
- [ ] URL: `https://svmiddleware-production.up.railway.app/health`
- [ ] Keyword: `"redis":true`
- [ ] Keyword Type: **Keyword exists** (alert when `"redis":true` is ABSENT — Redis is down)
- [ ] Monitoring Interval: **5 minutes** (free tier maximum)
- [ ] Alert Contacts: add email for outage notifications
- [ ] Click **Create Monitor**

**Optional second monitor** (informational only — fires on every Railway restart):
- Monitor Type: **Keyword**
- URL: same
- Keyword: `"authenticated":false`
- Keyword Type: **Keyword exists** (alerts when Zoho auth has dropped)
- Treat as a prompt to re-authenticate at `/auth/zoho`, not an urgent outage

### Phase 32 Railway Secrets (close pending UAT)

Verify these are set in the Railway `svmiddleware-production` service before the first gated deploy:

- [ ] `NODE_ENV` = `production`
- [ ] `RECAPTCHA_SECRET_KEY` — Google reCAPTCHA secret (required in prod, fail-closed)
- [ ] `HELCIM_WEBHOOK_SECRET` — Helcim webhook HMAC secret (required in prod, fail-closed)
- [ ] `CALCOM_WEBHOOK_SECRET` — Cal.com webhook HMAC secret (required in prod, fail-closed)
- [ ] `REDIS_ENCRYPTION_KEY` — Zoho refresh-token encryption key (required in prod, #106)
- [ ] `SENTRY_DSN` — Sentry error tracking DSN (required in prod as of Phase 33, MONITOR-02)
- [ ] `HELCIM_API_TOKEN` — Helcim payment API token (required in prod as of Phase 33 — middleware will NOT boot without it)

A healthy post-deploy `/health` response (HTTP 200, `redis:true`) confirms the app booted successfully through `validateEnv.js`, which means all `REQUIRED_IN_PROD` vars are present.

### Railway Postgres (staging + production)

D-01 makes `DATABASE_URL` required in production (staging also runs `NODE_ENV=production`, same as
every other `REQUIRED_IN_PROD` var on this page), and Railway's `preDeployCommand` runs
`node-pg-migrate up` against `DATABASE_URL` on every deploy — so **both Postgres databases must
exist and be linked into their middleware service before any Phase 83 middleware commit is pushed
to either repo**, or the deploy will fail closed.

**Provisioning steps — once per environment (staging, then production):**

- [ ] Railway dashboard → `sv-middleware` project → switch the environment selector to **staging**
- [ ] `+ Create` → `Database` → `PostgreSQL`
- [ ] Name the new service `Postgres` (so the auto-generated reference variable is
      `${{Postgres.DATABASE_URL}}`)
- [ ] In the `svmiddleware-staging` service → Variables tab → `New Variable` → `Add Reference` →
      select the `Postgres` service's `DATABASE_URL` → confirm the variable name landed in
      `svmiddleware-staging` as exactly `DATABASE_URL` (rename it if Railway suggests a different
      default) — this must be the **PRIVATE** URL (host `*.railway.internal`), **not**
      `DATABASE_PUBLIC_URL`
- [ ] If Railway offers to redeploy `svmiddleware-staging` now, you may decline — the current code
      doesn't read `DATABASE_URL` yet, so a redeploy of the current code with an extra unused
      variable is harmless either way, just unnecessary
- [ ] Repeat all of the above for **production**: switch the environment selector to `production`,
      `+ Create` → `Database` → `PostgreSQL` named `Postgres`, link `DATABASE_URL` into
      `svmiddleware-production`'s Variables tab

> **Pitfall:** the variable must be named literally `DATABASE_URL` in the middleware service's
> Variables tab — `zoho-middleware/lib/validateEnv.js` and `zoho-middleware/lib/db.js` both hardcode
> that exact name. A differently-named reference (e.g. `POSTGRES_URL`) leaves `DATABASE_URL` unset
> and the app fails closed in production.

**Environment-name check (D-07)** — the Sheet-mirror hard-off-on-staging gate depends on this:

- [ ] Staging: Railway → `svmiddleware-staging` → Variables → "Railway provided variables" (or the
      environment switcher label) → read and record the exact value of `RAILWAY_ENVIRONMENT_NAME`
- [ ] Production: same for `svmiddleware-production`

> **Pitfall:** service name (`svmiddleware-production`) and environment name
> (`RAILWAY_ENVIRONMENT_NAME`) are different Railway concepts — do not assume they match. The
> Sheet-mirror gate compares against the ENVIRONMENT name, not the service name.

**Config-file check (D-03)** — determines where the `preDeployCommand` migration step must live:

- [ ] For each of `svmiddleware-staging` and `svmiddleware-production`: Settings → "Config-as-code" /
      Railway config file path → record whether it is `/railway.toml` (repo root) or
      `/zoho-middleware/railway.toml`
- [ ] Also record each service's Root Directory setting

**Backups (D-16):**

- [ ] For each Postgres service: open the Backups tab
- [ ] Enable a daily backup schedule if the option is available
- [ ] Record the schedule, retention period, and whether point-in-time recovery (PITR) is offered on
      the current plan (confirmed Hobby as of `82-01-SUMMARY.md`)

> **Pitfall:** if the Backups tab is unavailable on the Hobby plan, record "NOT AVAILABLE" rather
> than leaving it blank — Phase 84 must not load real balances into Postgres until this is resolved
> (upgrade the plan, or stand up a scheduled `pg_dump`). The restore drill itself stays in Phase 88.

**Public proxy (D-10)** — needed by the owner's backfill CLI in a later plan:

- [ ] Confirm each Postgres service exposes a `DATABASE_PUBLIC_URL` (TCP proxy, host
      `*.proxy.rlwy.net`) — the owner will copy this into their own terminal for the backfill
      pipeline later. **Never paste it into chat, a file in the repo, or a commit.**

**Workbook timezone** — used by the backfill to interpret Date cells correctly:

- [ ] Google Sheet "STEINS AND VINES" → File → Settings → Time zone → record the IANA zone (e.g.
      `America/Vancouver`)

#### Provisioning record (fill in on completion)

| Field | Value |
|-------|-------|
| Staging Postgres provisioned (date) | 2026-09-30 |
| Staging DATABASE_URL linked (y/n) | yes — reference `${{Postgres.DATABASE_URL}}` (private URL) |
| Production Postgres provisioned (date) | 2026-09-30 |
| Production DATABASE_URL linked (y/n) | yes — reference `${{Postgres-EMVk.DATABASE_URL}}` (private URL) |
| RAILWAY_ENVIRONMENT_NAME staging | `staging` |
| RAILWAY_ENVIRONMENT_NAME production | `production` |
| Config file path (staging / production) | `/railway.toml` (repo root) for both; neither service has a Root Directory set |
| Backups staging (schedule/retention) | NOT AVAILABLE — Backups tab requires Railway Pro plan (workspace is Hobby) |
| Backups production (schedule/retention) | NOT AVAILABLE — Backups tab requires Railway Pro plan (workspace is Hobby) |
| PITR available (y/n) | no — Pro-plan only |
| Workbook timezone | `America/Vancouver` |
| Recorded by / date | Claude, in owner's Railway session with owner approval — 2026-09-30 |

> Never record any URL, host, port or password in this table — names, dates and yes/no values only.

> **Note — actual Railway names differ from the checklist's assumed names:** Railway
> auto-suffixed the production Postgres service to `Postgres-EMVk` (service names are
> project-unique and staging already claimed `Postgres`), so the production reference is
> `${{Postgres-EMVk.DATABASE_URL}}`, not `${{Postgres.DATABASE_URL}}`. Both middleware services
> are actually named `sv_middleware` in Railway — `svmiddleware-staging` / `svmiddleware-production`
> above are only the `*.up.railway.app` public domains, not the service names. Staging source repo
> is `koa-inn/steins-and-vines-staging@main`; production is `koa-inn/steins-and-vines-production@main`.
> Neither Postgres service exposes `DATABASE_PUBLIC_URL` (no TCP proxy enabled on either). Plan
> 83-08 resolved this: use Railway's private tunnel (`railway connect Postgres --tunnel-only
> --environment <staging|production>`, Railway CLI 5.x+, with an SSH key registered via
> `railway ssh keys add`) — see `zoho-middleware/scripts/backfill/README.md` step 3 for the full
> procedure. `railway run` does **not** work for this: it runs the command on the laptop itself
> against the service's private `*.railway.internal` URL, which a laptop cannot reach. The public
> TCP proxy fallback documented in the README remains available but was never needed for the
> Plan 83-08 rehearsal.

> **Consequences for Phase 83 code:**
> - `PRODUCTION_ENVIRONMENT_NAME` for `lib/sheet-mirror.js` (Plan 83-04) = `production`; it must
>   NOT equal the staging value `staging`.
> - `preDeployCommand` belongs in the repo-root `/railway.toml` (matches Plan 83-03 as written — no
>   file move needed). However, Railway's dashboard flags **"Config as Code is deprecated. Prefer
>   Infrastructure as Code. Existing config files keep working until 2026-12-01."** on both
>   services — before that date, the build/watch/start/`preDeployCommand` settings must move to
>   dashboard settings or Railway IaC, or the migration step will silently stop running on deploy.
>   Flag for Plan 83-03/83-08.
> - Backfill default timezone = `America/Vancouver`, matching Plan 83-06's default — no change
>   needed there.

> **Blocker for Phase 84 (D-16):** Backups and PITR are unavailable on both Postgres databases
> (Hobby plan). Real balances must not be loaded into Postgres until the workspace is upgraded to
> Pro (with backups enabled) or a scheduled `pg_dump` exists. This does not block shipping Phase
> 83's empty database (D-17).
>
> **2026-10-02:** the owner chose a scheduled `pg_dump`: a Railway cron service, production only,
> nightly, age-encrypted, uploaded to Cloudflare R2 with 30-day retention. Code, setup steps and
> the restore drill are in `infra/pg-backup/README.md`. The blocker clears only once that service
> is live in production AND a restore drill against a real backup has passed (tracked as
> 83-HUMAN-UAT test 2).
>
> **2026-10-02 — CLEARED.** `pg-backup` is live in production (cron `0 10 * * *`), first backup
> `production/production-20261002T223253Z.pgcustom.age` uploaded to R2 `sv-pg-backups`, and a
> restore drill of that file into a scratch Postgres 18 matched production row counts.

---

## Gift cards → Postgres (Phase 84)

Owner-run cutover, dual window, flip and rollback procedure for the GiftCards store (DB-03).
No secrets, no balances, no customer names appear below or in any terminal output this section
references — every script in this flow prints cert numbers, field names and counts only.

### 1. Store flag

`GIFT_CARDS_STORE` is a Railway environment variable, set per-environment (staging,
production) on the middleware service — never a runtime/admin toggle. Valid values:
`sheets` | `dual` | `postgres`. Unset means `sheets` (today's behavior, zero-config). Any other
value refuses to boot with a clear error naming the variable (D-06) — the app never starts in
an ambiguous mode. Flipping the value requires a Railway redeploy (~1 min restart), same as
every other store flag on this page.

**Staging has no sheet leg in `dual` mode** — the mirror (`mirror_gift_card_state`) is
production-only (D-07's sheet-mirror hard-off-on-staging gate, re-used unchanged by this
phase). Staging's `dual` therefore only proves the Postgres leg; the dual-window discrepancy
comparison described in §4 only has real meaning in production.

### 2. Staging rehearsal

Run the exact production cutover steps below (§3) against staging's own Postgres database
first, using a full real copy of the live data (Phase 83 D-11) — not synthetic fixtures. This
is a rehearsal only: staging never mirrors to the shared Google Sheet (owner decision,
2026-09-23), so staging's `gift-cards-verify.js` run compares against the SAME shared sheet
that production reads, which will disagree on balances staging itself never wrote — expect
and accept sheet-side mismatches that are purely informational on staging. The goal of the
staging rehearsal is proving the backfill → verify → flip sequence runs clean against a
real-sized dataset, not proving staging's own sheet parity.

### 3. After-hours production cutover (D-15)

Run only when the store is closed and the kiosk is idle. Numbered checklist:

1. Download a fresh `.xlsx` snapshot of the live "STEINS AND VINES" sheet (File → Download →
   Microsoft Excel).
2. Open the owner's private Railway tunnel to production Postgres (see
   `zoho-middleware/scripts/backfill/README.md`).
3. `gift-cards-backfill.js --file=<snapshot> --dry-run` (equals form — `--file <path>` errors "unknown flag") — **zero rejects required.** If any
   row rejects (`needs_manual_review`, an unsettled claim, a malformed cell), resolve it in the
   live sheet first and re-run the dry run; do not proceed with any reject outstanding (D-13,
   unconditional — no `--accept-rejects` escape hatch exists for this CLI).
4. `gift-cards-backfill.js --file=<snapshot> --promote` once the dry run is clean.
5. Set `GIFT_CARDS_STORE=dual` in Railway (production). Wait for the redeploy to finish, then
   confirm `/health` reports `database:true` and `database_required:true`.
6. Download a SECOND, FRESH `.xlsx` (the live sheet may have moved since step 1).
7. `gift-cards-verify.js --file=<fresh snapshot>` must report 0 mismatches before the store
   reopens.
8. **If any mismatch is reported:** set `GIFT_CARDS_STORE=sheets` immediately, investigate the
   named cert(s) + field(s), and do not re-promote into the same tables. Truncate nothing by
   hand — the owner's decision point is whether to restore the target database from the
   Railway/R2 backup or stand up a fresh empty database before redoing steps 3–7. Document
   which path was chosen and why in `84-DUAL-LOG.md`.

### 4. Dual window (D-01/D-02/D-03)

While `GIFT_CARDS_STORE=dual`, Postgres is authoritative for every decision and the sheet leg
re-runs the same operation fire-and-forget as a parity check — never the other way around. A
mismatch between the two raises a Sentry event titled `dual-write giftcards.<op> discrepancy`.

Every discrepancy, whether caught by Sentry or found manually, is logged in `84-DUAL-LOG.md`
and classified **explained** or **bug**:
- A **bug** fix restarts the 7-consecutive-day window from day 1.
- An **explained** discrepancy (e.g. a known timing artifact, a field the sheet leg doesn't
  carry) does not restart the window.

There is no automatic rollback on a discrepancy — the owner decides case by case. The flip bar
(§6) requires **at least 7 consecutive days** with every one of the six ops — issue, redeem,
reload, lookup, void, adjust — observed at least once, with zero unexplained (i.e. still
unclassified or classified-bug-without-a-fix) discrepancies across the whole window.

### 5. Scripted $1 test-card runsheet (D-02)

Real kiosk traffic during the dual window may not exercise every op. This runsheet forces all
six during opening hours on PRODUCTION, using **CASH tender only** so no card refund is ever
needed. Use the kiosk's suggested next cert number — never a `TEST-*` or a hand-picked high
number (an override above the sequence moves the sequence, D-14).

1. **issue** — add a $1 gift certificate to the kiosk cart with the suggested next number, pay
   cash.
2. **lookup** — look the new cert up via Gift Card Management.
3. **redeem** — sell any small item paying $0.50 with the test card.
4. **reload** — sell a $1 reload on the same card, pay cash.
5. **adjust** — Adjust +$0.25 reason "goodwill", then −$0.25 reason "correction" (nets back to
   the pre-adjust balance).
6. **void** — void the card with reason "Phase 84 dual-window test".

Record each op + the time it ran in `84-DUAL-LOG.md`'s op-coverage table, then check Sentry for
any discrepancy on that cert. **Note:** the cash amounts in steps 1/3/4 are real revenue booked
in Zoho — the owner decides whether to reverse those invoices by the normal process; this
runsheet does not do that automatically.

### 6. Flip to postgres (D-04)

**Prerequisite:** the Apps Script deployment containing `mirror_gift_card_state` must be the
ACTIVE deployment. Record its version number and the immediately-prior version (the rollback
target) here before flipping:

| Field | Value |
|-------|-------|
| Apps Script version with `mirror_gift_card_state` ACTIVE at flip time | **65** (Phase 89 MD-02 deploy, 2026-10-16; `mirror_gift_card_state` present since v59) |
| Rollback version (immediately prior) | **64** (Apps Script). A store rollback after the flip is the §8 ledger-replay procedure, not a flag change |
| Flip date/time | **2026-10-16 18:22:14Z**, during opening hours with the kiosk idle (owner decision) |

After hours, once the §4 flip bar is met:

1. Set `GIFT_CARDS_STORE=postgres` in Railway (production).
2. Run `gift-cards-verify.js` against a fresh `.xlsx` — must report 0 mismatches.
3. Confirm one real sale's copy-state row and ledger row appear correctly in the live sheet
   (proves `mirror_gift_card_state` is actually firing, not just configured).

Once flipped, no Phase 51 Apps Script gift-card action (`redeem_gift_card` etc.) runs again —
`mirror_gift_card_state` is the only function still touching the GiftCards/GiftCardTransactions
sheets.

### 7. Rollback dual → sheets

1. Set `GIFT_CARDS_STORE=sheets`.
2. Download a fresh `.xlsx`.
3. Run `gift-cards-verify.js`. A mismatch means the sheet leg missed one or more writes while
   in `dual` mode (the sheet leg is fire-and-forget, so a transient failure is possible).
4. If mismatches are found: run `gift-cards-replay-to-sheet.js` (dry run first, inspect the
   counts, then `--apply`) BEFORE reopening the store.
5. Run `gift-cards-verify.js` again — it must report 0 mismatches before the store reopens.

### 8. Rollback postgres → sheets (ledger replay, D-04)

Used after a `postgres`-mode flip needs to come back to `sheets` with no data loss.

1. Store closed.
2. `gift-cards-replay-to-sheet.js --since <flip time from §6>` dry run first, review the
   payload count, then re-run with `--apply`.
3. `gift-cards-verify.js` must report 0 mismatches.
4. Set `GIFT_CARDS_STORE=sheets`.

The Phase 51 Apps Script logic resumes immediately — mirrored ledger rows were written with
status `settled` and composite `tx_ref`s, so they never block a future claim.

### 9. D-10 deploy gate

With any store at `dual` or `postgres`, the gated-deploy smoke check fails the deploy when
`/health`'s `database` field is not `true` (`/health`'s top-level `status` stays `ok`
regardless — this is a deploy gate, not an uptime alarm). If this happens: check the Railway
Postgres service's own status first; if the outage is more than transient, consider a
temporary rollback to `GIFT_CARDS_STORE=sheets` (§7/§8 as appropriate) while it's investigated.

### 10. D-11 pending records

A post-charge infrastructure failure (Postgres unreachable after a card was already charged)
writes a durable `giftcard:pending:*` key in Railway Redis rather than losing the write. List
them with the Redis CLI key pattern `giftcard:pending:*`. A record with
`manual_review_required:true` means an automatic replay already tried and got a genuine
business rejection (e.g. insufficient balance) — resolve it with a corrective `adjust` (reason
`correction`, note referencing the original `tx_ref`), then delete the key. The automatic
sweep re-attempts every un-flagged pending record every 5 minutes; most clear themselves before
a human ever needs to look.

### 11. Known open items carried from Phase 83

The production cutover above assumes both of the following are already true (84-11 verifies
them, not this plan):
- Railway Postgres backup/restore is confirmed live in production (§ "Railway Postgres
  (staging + production)" above — cleared 2026-10-02).
- The first observed pre-deploy migration-guard-chain log line has been confirmed on a real
  deploy (carried from Phase 83's gap closure).

### 12. Release checklist

- **Staging candidate commit SHA:** `ec518dec` (84-10 Task 1 — root `npm test`/`lint`/`build`
  and middleware `npm test`/`lint`/`migrate:guard`/`test:db` all green on this commit; the
  structural grep invariants below also hold at this SHA). Executed in an isolated worktree —
  the orchestrator's merge commit into `main` is the actual SHA pushed to staging in Task 2.
- **Pushed to staging:** `4e8432df` (2026-10-03, owner-approved; `092b0a4f..4e8432df`).
- Grep invariants confirmed clean at the staging-candidate commit: no direct gift-card Apps
  Script actions outside `lib/gift-card-store.js`
  (`grep -rnE "'(lookup|redeem|issue|reload|void|update)_gift_card(_invoice)?'"
  zoho-middleware/routes` → no matches) and no `adjust_gift_card` references anywhere in
  `apps-script`/`zoho-middleware`/`js` (adjust is HTTP-only, D-07/84-07).

---

## Recipes → Postgres (Phase 85)

Owner-run cutover, dual window, flip and rollback procedure for the Recipes + RecipeIngredients
store (DB-04). Same shape as the Phase 84 section above. No recipe values, no staff emails and
no customer names appear below or in any terminal output this section references: every script
in this flow prints recipe ids, ingredient ids, field names and counts only. Evidence is logged
in `.planning/phases/85-recipes-recipeingredients-postgres/85-DUAL-LOG.md`.

### 0. Ordering gate (D-08)

Production `RECIPES_STORE` stays **unset (sheets)** until `GIFT_CARDS_STORE=postgres` is set on
production. One production dual window runs at a time. Staging may run `dual` any time.
Do not start §5 on production while the Phase 84 window is still open.

### 1. Store flag

`RECIPES_STORE` is a Railway environment variable per environment on the middleware service.
Valid values: `sheets` | `dual` | `postgres`. Unset means `sheets`. Any other value refuses to
boot with an error naming the variable. `dual` and `postgres` make `/health`
`database_required` true. Changing it needs a Railway redeploy (about 1 minute).

### 2. Staging rehearsal

1. Push to staging (`git push origin main`).
2. Redeploy Apps Script (§3).
3. Staging backfill (dry run, then promote) and `recipes-verify.js`.
4. Set `RECIPES_STORE=dual` on staging.

Staging has no sheet leg: the mirror (`mirror_recipe_state` / `mirror_recipe_delete`) and the
D-05 dual-price comparison are production-only. The delete guard `recipe_batch_ref_count` is
read against the shared production workbook even from staging, so a staging delete of a recipe
that a live batch references will deactivate rather than delete. Staging `recipes-verify.js`
compares against the same shared sheet production reads, so expect differences for anything
staging wrote.

#### Staging recipe refresh (re-backfill)

1. Download a snapshot .xlsx from the shared workbook (kept outside the repo).
2. Owner tunnel: `railway connect Postgres --tunnel-only --environment staging`, then
   `read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL`.
3. Tables must be empty: delete from `recipe_ingredients`, then `recipes`. psql is not installed
   locally; use `docker run --rm -it postgres:18-alpine psql "$BACKFILL_DATABASE_URL"` or a
   node+pg one-liner.
4. From `zoho-middleware/`: `recipes-backfill.js --file=<path> --dry-run` (0 rejects), then
   `--promote`, then `recipes-verify.js --file=<path>`.
5. Kill the leftover ssh child of the tunnel.

On staging the scripts run from current `main` (staging has migration 0006 once Phase 89 is
pushed, and needs the sheet `beer_category` header once `main` carries the 89 spec). Never run
`recipes-replay-to-sheet.js --apply` from staging: the sheet is the shared production workbook.
Expected verify noise after staff set categories on staging: `beer_category` mismatches for the
edited recipes (staging writes never reach the sheet).

### 3. Apps Script redeploy

Three new actions: `mirror_recipe_state`, `mirror_recipe_delete`, `recipe_batch_ref_count`.
Follow the Apps Script deploy sequence earlier in this file. Before pasting, record the
currently active version (rollback target, currently 59 per the Phase 84 record). After
deploying, fill in this line:

- **Phase 85 Apps Script versions:** new version `60`, rollback version `59` (deployed 2026-10-07 on
  deployment `AKfycb…DI968g`; pre-paste editor-drift hash matched the pre-Phase-85 repo file, post-paste
  hash `d779448b…` matched `apps-script/adminApi.gs`).

### 4. Owner fix before the production dry run

In the live Recipes tab, SV-R-000001 has its `created_at` and `created_by` cells swapped. Swap
them back by hand before the dry run. The backfill rejects the row otherwise (it never
coerces). A dry run with **0 rejects** is the gate.

If the first dry run rejects other legacy rows (the backfill rejects blank `status` or
`pricing_mode` rather than defaulting them), fix each listed cell in the live sheet (the
reject output names sheet, row, id and field only), re-download and re-run. If the owner would
rather default blank `pricing_mode` to `locked`, that is a code change, not a runbook step.

### 5. After-hours production cutover

> ⚠ **Phase 89 script-source rule (D-14).** Until Phase 89 is promoted to production, run
> `scripts/backfill/recipes-backfill.js`, `recipes-verify.js` and `recipes-replay-to-sheet.js`
> ONLY from a pinned worktree of `d2c66be9`, never from `main`, for the entire 85-13 -> 85-14
> window (cutover, 7-day dual window, flip, any rollback/replay). Why:
>
> - `main`'s spec requires a `beer_category` sheet header (`headerRejects` rejects the whole
>   Recipes sheet otherwise).
> - `main`'s backfill inserts, and verify/replay select, a `beer_category` column that
>   production Postgres does not have until migration 0006 ships with the Phase 89 promotion.
> - The pinned scripts are byte-identical to today's apart from that column (`git diff
>   d2c66be9 HEAD` on the backfill scripts was empty) and tolerate an extra sheet column, so
>   they work whether or not the Apps Script redeploy has already added the header.
>
> Procedure (use Node 24, BC permanent time):
>
> ```bash
> git worktree add ../sv-85-pinned d2c66be9
> cd ../sv-85-pinned/zoho-middleware && nvm use 24 && npm ci
> git -C ../sv-85-pinned rev-parse --short HEAD   # must print d2c66be9; record in 85-DUAL-LOG.md
> ```
>
> Run every recipes script from there. Interaction: after the Phase 89 Apps Script redeploy
> (v63 expected) a mirror write from production adds the `beer_category` header and writes the
> Postgres value (blank before 89 ships), so nobody types categories on the sheet by hand;
> state-copy mirrors overwrite them. This callout is removed in the Phase 89 production
> promotion's release step.

Run from `zoho-middleware/`. The Railway tunnel runs in the owner's own terminal; the database
URL comes from `read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL`, never argv.
Snapshots are File, Download .xlsx, kept outside the repo, equals-form `--file=`.

1. Fresh .xlsx, then
   `node scripts/backfill/recipes-backfill.js --file=<path> --dry-run` (0 rejects required).
   A `beer_category` / `invalid_beer_category` reject means a hand-typed cell (e.g. `IPA`).
   The backfill accepts exact keys only, by design (Phase 89 review MD-01, owner 2026-10-16).
   Fix the cell on the sheet to the key (`pilsner lager pale ipa amber wheat session saison
   stout porter redale brown`, or blank), then download a fresh .xlsx and re-run. BrewPad and
   admin always write exact keys.
2. `node scripts/backfill/recipes-backfill.js --file=<path> --promote` (needs empty tables,
   prompts for the database name, one transaction, seeds both sequences).
3. Set `RECIPES_STORE=dual` on production. Confirm `/health` shows `database_required:true`.
4. Second fresh .xlsx, then
   `node scripts/backfill/recipes-verify.js --file=<path>` must print 0 mismatches.
5. Do the pre-open mirror write: via production admin make a harmless notes edit on a DRAFT recipe
   with at least 2 ingredient rows. Wait 60 s. Confirm the recipe-mirror success log and no
   `recipes-mirror` error. Take a third fresh .xlsx and run `recipes-verify.js` again: 0
   mismatches. Do a read-only ExcelJS cell-type check (types and counts only) that the mirrored
   row's `created_at` / `updated_at` are text like untouched rows and that its ingredient rows
   are complete (no missing or duplicated rows).
6. Any mismatch, failed mirror, timestamp type change or missing/duplicated ingredient row:
   set `RECIPES_STORE=sheets` **before opening**, then investigate.

### 6. Dual window (D-07)

At least 7 days, all ops observed, zero unexplained discrepancies. No auto-rollback.
Run from the pinned d2c66be9 worktree (see §5 callout, D-14).

- Daily Sentry check: `[dual-write] recipes.quote`, `[dual-write] recipes.sale`, component
  `recipes-mirror`, component `recipes-dual-price`. A `recipes-dual-price` warning means a
  recipe stayed dirty for more than 10 minutes: investigate the dirty marker / mirror the same
  day. While it persists that recipe is not being price-compared.
- Daily D-05 coverage count from Railway logs: number of `[dual-price] compared` lines versus
  `[dual-price] skip` lines split by `reason=settle` and `reason=dirty` (or read the latest
  running totals `compared=<N> skipped=<M>`). Record a row in 85-DUAL-LOG.md "D-05 compare
  coverage".
- Every discrepancy goes in 85-DUAL-LOG.md classified `explained` or `bug`. A bug fix restarts
  the 7 days.
- A persistent mirror failure is caught by `recipes-verify.js` and repaired with
  `node scripts/backfill/recipes-replay-to-sheet.js` (dry run) then `--apply`.

### 7. Scripted test-recipe runsheet (D-07)

1. Create a draft recipe "ZZ TEST RECIPE <date>" with one cheap ingredient.
2. Activate it with a locked price.
3. Edit it with an ingredient change.
4. Rename it and time the PUT in browser devtools: under 2 s (ROADMAP SC4).
5. View it on the public recipe list and detail pages.
6. Sell it once on the kiosk at the smallest volume: cash tender if the recipe-sale flow offers
   it, otherwise a card sale reversed with the Phase 84 INV-000229 procedure.
7. Within a minute (production) check the sheet row and ingredient rows updated and there is no
   `[dual-write] recipes` warning.
8. Delete it. A batch-referenced recipe deactivates instead of deleting; record which happened.
9. Clean up the live-books sale exactly as INV-000229 in Phase 84 (void the invoice / delete the
   payment). Staging and production share the Zoho org and the Helcim token.
10. Run `recipes-verify.js` (0 mismatches).

Tick the rows in 85-DUAL-LOG.md "Op-coverage table" as each op is seen.

### 8. Flip to postgres

Run from the pinned d2c66be9 worktree (see §5 callout, D-14).

Owner decision, after hours, once the §6 bar is met. Set `RECIPES_STORE=postgres`, confirm
`/health`, run `recipes-verify.js` again. The mirror to the sheet **remains permanent on
production** in `postgres` mode.

**Production flip record:**
- Flipped 2026-10-17 at 19:17:15Z. The owner chose to do it on window day 2, during opening hours with no recipe activity, after the scripted runsheet covered all ops.
- Post-flip verify returned 13 recipes and 0 mismatches.
- Rollback targets:
  - The Railway deployment `4d45312c` (dual), or set `RECIPES_STORE=sheets` per §10.
  - Apps Script: the current version is v65 per the Phase 89 record, and `mirror_recipe_state` has been present since v60.
  - Don't roll Apps Script back below v60 while the sheet is the mirror.

### 9. Rollback dual → sheets

Run from the pinned d2c66be9 worktree (see §5 callout, D-14).

Set `RECIPES_STORE=sheets`, then run `recipes-verify.js`. On any mismatch run
`node scripts/backfill/recipes-replay-to-sheet.js --apply`, then verify again.

### 10. Rollback postgres → sheets

Run from the pinned d2c66be9 worktree (see §5 callout, D-14).

Same as §9: the sheet is a full state copy kept by the mirror. Replay with
`recipes-replay-to-sheet.js --apply` if verify shows drift.

### 11. D-03 rollout rule

The editor bundle (Plan 85-09) must be live before any environment leaves `sheets`: missing
concurrency tokens are rejected in `dual` / `postgres`.

### 12. Explained differences (known up front)

- A missing recipe detail returns 404 in Postgres modes (Sheets returned 200 with an error
  object).
- Postgres serves current data where Sheets could serve up to 300 s stale.
- Ids are never reused after deleting the highest id.
- SV-R-000001 sorts last after its cell fix.
- Invalid status / NaN numerics now return 422 instead of being stored.
- Invalid ingredients JSON writes nothing (Sheets wrote the row fields first).
- D-05 skips within 60 s of an edit are logged, not compared.
- A failed promote rolls back rows but not `setval`; harmless, re-seeded on the next promote.

**Known limitation, delete TOCTOU:** in `dual` / `postgres` the delete asks Apps Script
`recipe_batch_ref_count` and then deletes in Postgres. A batch created for that recipe in the
seconds between the two steps is not seen, so the recipe is hard-deleted although a batch now
references it (Batches stay on Sheets with no foreign key until Phase 87, which replaces the
count with SQL in the same transaction). Operating rule: do not delete a recipe while a batch
for it is being created. If it happens the batch keeps a dangling `recipe_id` (the mirror also
removed the sheet row): log it in 85-DUAL-LOG.md as explained and, if the recipe is still
needed, recreate it from the most recent .xlsx snapshot or the Railway backup.

### 13. Release checklist

- **Staging candidate commit SHA:** `bd12df33` (85-12 Task 1 green gate; later commits are docs-only). Production SHA to be filled in by Plan 85-13.
- [ ] recipes scripts run from the pinned d2c66be9 worktree (rev-parse recorded in 85-DUAL-LOG.md) until Phase 89 reaches production


---

## Beer category (Phase 89)

### 1. What ships

Recipes gain an optional `beer_category` (one of 12 tint keys, D-02) that colours the recipe card on
beer.html. Migration `0006` adds `recipes.beer_category` as nullable text with no CHECK (D-03);
enforcement is application-level (`normalizeBeerCategory`, off-list values rejected with 400 at the
recipe API and `invalid_data` in Apps Script). Apps Script `createRecipe` / `updateRecipe` /
`mirrorRecipeState` carry the field and self-migrate the sheet column; the editor-run helper
`setupRecipeBeerCategoryColumn` adds the header once. The public `GET /api/recipes` projection
returns `beer_category`, both editors (BrewPad and admin) have a "Beer category" select, and the
card tint is colour only (no visible text, D-08); a blank category keeps the default gold (D-09).

### 2. Staging release

1. Push to staging (`git push origin main`). The Railway pre-deploy applies `0006`.
2. Owner redeploys Apps Script (follow "Apps Script (`adminApi.gs`)" above). The deployment is shared,
   so this goes live in production immediately. Record the NEW and ROLLBACK versions in the deploy
   table (the Phase 89 row). Run `setupRecipeBeerCategoryColumn` once from the editor; it logs
   `beer_category column index: <n>` and is idempotent.
3. No staging re-backfill is required: staging was re-backfilled 2026-10-14 and a new nullable
   column needs no data. If recipes drifted, use Phase 85 §2 "Staging recipe refresh".
4. Staff set the D-06 mapping in staging BrewPad (D-07, no seeding script): ipa = SV-R-000011,
   SV-R-000013; pale = SV-R-000003; pilsner = SV-R-000010, SV-R-000002; lager = SV-R-000006,
   SV-R-000016, SV-R-000008, SV-R-000004; brown = SV-R-000001, SV-R-000007. The 2 non-active
   recipes stay blank. Then visually check https://staging.steinsandvines.ca/beer.html.
5. Expected staging recipes-verify noise: `beer_category` mismatches for the categorised recipes,
   because staging writes never reach the sheet. Never replay from staging.

6. UAT approved 2026-10-15 (staging UAT run 2026-10-14): all 11 categories set via staging BrewPad, API matches the D-06 mapping (mismatches=0), card tints correct on staging beer.html with no category text, clone keeps the category. The staging admin view of SV-R-000003 was not checked (owner accepted).

### 3. Production promotion runsheet (D-13, after 85-13)

Preconditions:
- The 85-13 production cutover is complete.
- The promotion SHA includes migrations 0004 and 0005, or they are already applied in production,
  because node-pg-migrate rejects an out-of-order 0006. 0006 ships only together with 0004/0005.
- The owner chooses the SHA, and staging approval comes first (CLAUDE.md).

Steps:
1. Deploy the promotion.
2. Confirm 0006 is applied (pgmigrations row / deploy log).
3. Confirm anonymous production `/api/recipes?status=active` carries `beer_category`.
4. Staff repeat the D-06 picks in production BrewPad.
5. Check production beer.html colours once the beer page is live.
6. Release step: remove the Phase 85 §5 "Phase 89 script-source rule (D-14)" callout and its
   §6/§8/§9/§10/§13 pointers. From then on run the recipes scripts from main, but only once 0006 is
   applied in production AND the production sheet has the `beer_category` header.
7. Record the promotion SHA here: staging `d12b4b9b` became production `47fcd354`, tag `prod-20261017-1`, Railway `b3fd002a` (2026-10-17). Migration 0006 is applied. The D-14 callout removal is still pending: it waits for the first `recipes-verify.js` run from main, which is scheduled for the 2026-10-18 session.

---

## BrewPad invoice linking, canning bundle and recipe pickers (Phase 90)

### 1. What ships

- BrewPad create-batch sheet: invoice picker plus a "No invoice (internal batch)" checkbox (D-01..D-04).
- Guarded `source` edit manual<->internal in both batch stores (Apps Script `updateBatch` and the Postgres store, D-05). Automated sources are rejected before any write.
- Unlinked filter chip and detail-view candidate review: Link invoice / Not this / Mark internal / Mark as not internal (D-06..D-10, D-24).
- `GET /api/batch/link-candidates` (read-only, staff-session gated) and `create_batch` source coercion to manual/internal.
- Kiosk canning bundle: server-owned $40.00 (beer) / $35.00 (cider, sparkling) plus 12% tax, $0 can line, standalone kiosk only (D-11..D-16, D-22, D-25).
- Custom-labels copy fix (D-18).
- Full-list recipe pickers on BrewPad, kiosk recipe search, and "Start from this recipe" in the BrewPad and admin recipe editors (D-19..D-21, D-23).

### 2. Staging release

- Pushed to staging with `git push origin main` only. The production remote is never touched in this phase.
- The staging push follows the Phase 89 staging push (b34d96ee). The Phase 89 Apps Script row in the deploy table is already filled (v63, rollback v62), so there is no Phase 89 coupling question for the Phase 90 paste.
- Owner Apps Script redeploy: the Phase 90 paste is the NEXT version after v63, and its rollback target is v63. The deployment is shared by staging and production, so it goes live in production immediately. The guard is additive and the production frontend does not send `source` yet. Record the versions in the deploy table above.
- Staging data-safety rules (staging shares the Zoho org and the batch workbook with production):
  - Throwaway batches named "ZZ TEST 90 <date>" only.
  - Never tap Link invoice, Not this or Mark internal on a real batch.
  - Delete the throwaway batches afterwards (delete triggers the invoice-label reconcile) and record the invoice used.
- The Unlinked count on staging is the real production count (shared workbook).
- UAT approved 2026-10-15 (owner; piloted in Chrome on staging). Test customer "test" (CUS-00052), test invoice INV-000228 (a $1 paid kiosk test sale). Throwaway batches SV-B-000238 (invoice linked, source manual), SV-B-000239 (internal, excluded from Unlinked), SV-B-000240 (created without invoice, Mark internal / Mark as not internal round-trip persisted after reload, so the v64 guard is live). All three deleted through BrewPad; `get_batch` returns "Batch not found"; INV-000228 has no batch-status label left (modified 2026-10-15 13:36 by the link, then the reconcile). Unlinked went 57 -> 58 during the test. Read-only review: SV-B-000222 proposed INV-000208 and SV-B-000067 proposed INV-000044 (already linked to SV-B-000066), matching the known answers. New-batch Recipes picker listed 11 active recipes A-Z; BrewPad editor Start from gave "Copy of West Coast IPA" (not saved); custom-labels says about 70 x 355 mL / 52 x 473 mL.
  - Not covered by the UAT (separate sign-ins): attach and waitlist pickers (same shared dropdown code), admin editor Start from, kiosk recipe search, admin kiosk panel having no Canning bundle button. The kiosk checks move into the D-17 session (§3).
  - Minor findings, none blocking: the no-invoice confirm's secondary button says "Cancel" where UI-SPEC says "Keep editing"; filter-chip counts refresh only after a full reload; the BrewPad recipe editor shows "Activate" on active recipes (pre-existing); the staging Cloudflare Access session expires often.

### 3. D-17 staging hardware session

One session on the staging terminal, covering both:

1. Recipe money path: one auto-confirm and one manual-confirm sale.
2. One canning bundle sale with a small can count (e.g. 2) to limit real stock movement in the shared Zoho org. Void or refund afterwards per the usual staging practice, which restores stock.

Pass criteria: the invoice shows "Canning Bundle - ..." at the bundle price with 12% tax (beer 40.00 + 4.80 = 44.80; cider/sparkling 35.00 + 4.20 = 39.20), the can item at the entered quantity and $0.00, and the charged total equals the kiosk total.

Session record (D-17): **passed 2026-10-15** (owner on the staging iPad terminal, test customer "test" CUS-00052). The owner skipped the recipe manual-confirm leg.
- Recipe auto-confirm: INV-000239 (SV-R-000016 Bavarian Style Lager, 95% test discount, Helcim txn 56644488, $4.88). Paid, invoice total equal to the charge, batch SV-B-000238 auto-created.
- Getting there took three kiosk recipe money-path fixes, all found during this session:
  - f4272eed: numeric Helcim transaction id.
  - ae191772: payment raced the invoice submit.
  - c10e8111 and 0cfbd181: the invoice total was a few cents off the charge. Zoho stores quantities to 3dp, and the reconcile PUT has to re-send each line's tax_id.
  - The earlier failed attempts were reversed automatically (txns 56641673, 56642269, 56642753 and 56643687 all have APPROVED reverses). Their draft invoices INV-000236/237/238 were deleted.
- Recipe manual confirm: **skipped by the owner**. One attempt (ref KIOSK-1792106495034, $97.85) returned 409 "could not be verified" with nothing booked. Helcim showed no transaction for that ref (no card was ever approved), so this was the fail-closed path working as designed. The recipe manual-confirm path is therefore still unproven with a real charge.
- Canning bundle: INV-000240 (ref KIOSK-1792106677858, Helcim txn 56645223). The invoice showed "Canning Bundle — Beer 25 L (473 mL)" at $40.00 with BC PST + GST 12% ($4.80), 473 mL can line qty 52 at $0.00, total $44.80, Paid. The charged total equalled the kiosk total. The note reads "manual confirm", so the kit-sale manual-confirm path verified and booked correctly.
- Kiosk receipt screen: the Payment Approved card was cut off at the top on the iPad (tall card overflowing upward out of the scroll area). Fixed in f6e6eff8 (build 34a85698).
- Data fix by the owner during the session: Whirlfloc T Bulk had no sales tax set in Zoho.
- Cleanup: the INV-000239/240 payments and invoices were deleted in Zoho (the can stock is returned), and batch SV-B-000238 was deleted (`get_batch` returns "Batch not found"). The owner refunds or voids txns 56644488 and 56645223 in Helcim.

### 4. Known gaps (follow-ups, not fixed in Phase 90)

- (a) The admin.html batch modal (Batches tab -> "New Batch" button `#create-batch-btn` -> `openCreateBatchModal` in js/admin.js ~:6482, `adminApiPost('create_batch', ...)` ~:6919) is still reachable. It creates manual batches with no invoice field and no internal option, so it can still add unlinked batches. Follow-up: add the same invoice picker and internal checkbox there, or retire the modal (owner decision).
- (b) D-09 same-SKU multi-link: the BrewPad create sheet cannot link one invoice to a second batch of the same product (server `duplicate_so_number`). Staff create without an invoice and link from the batch detail view.
- (c) Candidate lookup inspects at most the 10 in-window invoices nearest the start date (detail-fetch cap). The card section says when more were not checked, and Search all invoices covers the rest.

### 5. Production promotion runsheet (not executed in Phase 90)

Preconditions:
- Staging approval recorded (section 2) and D-17 passed (section 3).
- Owner chooses the SHA. Respect any pinned-SHA rule still in force for Phase 85/89 promotions.
- Promote the kiosk server and bundles together with, or right after, the kiosk recipe money-path promotion (D-17).

Steps:
1. Confirm `ZOHO_TAX_STANDARD_ID` (or the can items' standard tax rule) resolves in production. Check names only, never values.
2. Promote the chosen SHA per the usual production procedure.
3. Staff then run the real backfill review on production BrewPad: Unlinked chip -> each batch -> Link invoice / Not this / Mark internal. SV-B-000230/231/233 are Internal. The known false positives must be rejected with Not this: SV-B-000222 (INV-000208), SV-B-000035/63/64 (INV-000230/INV-000171), SV-B-000067 (INV-000044).
4. The target "Unlinked (0)" is an operational goal for staff after promotion (D-10, one human tap per batch). It is not a Phase 90 completion criterion.

---

## Ops data → Postgres (Phase 86)

Owner-run cutover, dual window, flip and rollback procedure for the Vessels and FermSchedules
stores, the two imported Config keys and the staff sign-in list (DB-05). Same shape as the
Phase 85 section above. No vessel notes, schedule step text, staff emails or secrets appear below
or in any terminal output this section references: every script prints ids, field names and
counts only. Evidence is logged in
`.planning/phases/86-vessels-fermschedules-config-postgres/86-DUAL-LOG.md`.

**Production flip record (2026-10-27):**
- `OPS_DATA_STORE=postgres` and `STAFF_ACCESS_STORE=postgres` set together at 18:11:21Z (deploy
  `fd9fb39e`, live 18:13:39Z), owner override of the 7-day bar after 8 days in dual. Post-flip
  `ops-verify` 233 vessels / 13 schedules, 0 mismatches.
- D-18 closed: Config `staff_emails` value cell blanked; probe `unauthorized` after the cache window.
- `STAFF_EMAILS` already holds one owner (break-glass), so no trim was needed.
- Rollback: `OPS_DATA_STORE=dual` (preferred). `sheets` is refused at boot while `BATCHES_STORE=postgres`
  (roll Phase 87 back first). Apps Script stays on v65.

Two independent flags drive this phase: `OPS_DATA_STORE` (vessels, schedules, config) and
`STAFF_ACCESS_STORE` (the staff sign-in list). Each takes `sheets` | `dual` | `postgres` and each
rolls back on its own (D-19).

### 0. Ordering gate (D-12)

Production `dual` for either flag starts only after production `RECIPES_STORE=postgres` is recorded
in `85-DUAL-LOG.md` ("Flip decision") together with its post-flip verification. One production
dual window runs at a time. Staging may run ahead of that gate.

### 1. Prerequisites

- Docker is running locally (`npm run test:db` in `zoho-middleware/` uses testcontainers).
- Railway tunnel to the target database works (see `zoho-middleware/scripts/backfill/README.md`
  step 3) and the database backups are live (Phase 83).
- A fresh Postgres 16-compatible test pass is recorded for the release candidate (§12).

### 2. Data-hygiene decisions (before the dry run)

Decide and record in `86-DUAL-LOG.md` before the first dry run:

- **FS-0011 "ZZ Test Template":** the owner either deletes it from the sheet or accepts importing it.
- **"[gfs-probe]" suffix on FS-0001's description:** the owner either cleans it or accepts it.
- Default when the owner has no preference: import both as-is and record that decision.

### 3. Apps Script v61 deploy

1. Follow "Apps Script (`adminApi.gs`)" above: record the active version as the rollback target
   (expected: **60**), hash-check the editor for drift, paste `apps-script/adminApi.gs`, save, then
   Deploy → Manage deployments → pencil → **New version** on the existing deployment.
2. Record in `86-DUAL-LOG.md` under "Phase 86 Apps Script versions": new = **61**, rollback = **60**.
3. Probes: production `get_vessels` and `get_ferm_schedules` still return `ok`; an `update_batch`
   through the proxy writes the staff email into VesselHistory.

### 4. Backfill

Precondition: the Vessels tab has a `label` header (§11).

```bash
cd zoho-middleware
read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL
read -s BACKFILL_STAFF_EMAILS && export BACKFILL_STAFF_EMAILS   # the current Railway STAFF_EMAILS value
node scripts/backfill/ops-backfill.js --file="$HOME/sv-backfill/snapshot.xlsx" --owners=<owner1>,<owner2> --dry-run
```

Dry run must show 0 rejects. Then `--promote`, download a fresh .xlsx and run
`node scripts/backfill/ops-verify.js --file="$HOME/sv-backfill/fresh.xlsx"`: it must print
"0 mismatches" (exit 0; exit 4 means mismatches).

### 5. Cutover

1. Confirm the editors bundle that reads the new admin responses is live first.
2. Set `OPS_DATA_STORE=dual` **and** `STAFF_ACCESS_STORE=dual` together (D-09; two flags per D-19).
3. Check `/health` shows `database_required: true` and the startup log has
   "Ops mirror sweep registered".
4. Pre-open mirror write: edit the notes of one harmless vessel, download a fresh snapshot and
   run `ops-verify.js`: 0 mismatches.
5. Every regular staff member signs in once (confirms their sign-in works from the table).

### 6. Dual window

Daily checks: Sentry component `ops-mirror`, `[dual-write] staff-access` log lines, and
`ops:mirror-dirty` Redis markers (a surviving marker means a mirror write is still pending).

**D-11 flip bar:** at least 7 consecutive days where every action below was observed and there
were zero unexplained mismatches: vessel add / edit / archive / status override; schedule
create / edit / delete-or-archive / propagate; staff add / remove. Any bug-classified
discrepancy restarts the window.

**Staff dual verification (the un-mirrored list, D-10)** means: the shadow compare shows no
unexplained disagreements, plus the `ops-verify.js` staff leg (every Railway STAFF_EMAILS member
has a staff_access row), plus one removal with proof that the removed person gets an immediate 403.

During the window add people through the Staff Access screen only, never via Railway STAFF_EMAILS.

### 7. Scripted runsheet (actions not seen in real traffic)

- **Vessel:** add a test vessel with a valid-format id "TST-901", edit it, override its status,
  then archive it.
- **Schedule:** create "ZZ Test Schedule <date>", edit it, propagate it to no batch, archive it,
  then delete it.
- **Staff:** add a test staff account, change its role, then remove it while it is signed in; its
  next request must return 403.

Record each action's first-seen time in the Op-coverage table.

### 8. Flip

1. Set `OPS_DATA_STORE=postgres` and `STAFF_ACCESS_STORE=postgres` after hours, then verify
   (`ops-verify.js` 0 mismatches).
2. **D-18:** blank the Config sheet `staff_emails` VALUE cell and write in the adjacent cell:
   "Retired 2026-xx: staff sign-in is managed in admin → Staff Access (Phase 86). Do not re-add."
3. Wait 5 minutes (Apps Script cache), then probe a direct Apps Script call using a non-owner
   staff Google token: it must return `unauthorized`.
4. Only after the `ops-verify.js` staff leg shows `missing from Postgres 0`, trim Railway
   `STAFF_EMAILS` to the owner break-glass accounts only. Confirm a regular staff member can still
   sign in (via the table) and an owner still can.

### 9. Rollback, per flag independently (D-19)

- **`OPS_DATA_STORE` → `sheets`:** verify first. If the sheet lags, run
  `node scripts/backfill/ops-replay-to-sheet.js` (dry run), then `--apply`. Re-run `ops-verify.js`.
- **`STAFF_ACCESS_STORE` → `sheets`:** reverts sign-in to the env list only. **First** make sure
  Railway `STAFF_EMAILS` contains everyone who must keep access, otherwise they are locked out.
- Apps Script: roll back to version **60** (Deploy → Manage deployments → pencil → previous version).

### 10. Database outage behaviour (D-20)

Fail-closed: when Postgres is unreachable only the `STAFF_EMAILS` break-glass members can sign in
or keep working. Kiosk device traffic is unaffected.

### 11. Explained differences (known up front)

- Vessel status can drift when a Postgres status apply failed: Sentry names the vessel and a
  replay (`ops-replay-to-sheet.js --apply --only=vessels --id=<id>`) fixes it.
- jsonb stores schedule step keys in a different order than the sheet text; verify compares parsed.
- Vessel `location` is trimmed on import.
- **label header REQUIRED (owner decision 2026-10-07):** the owner adds a `label` header in row 1
  of the Vessels tab, in the first empty column right of `notes`. Apps Script reads Vessels by
  header, so no existing column shifts. Add it BEFORE the staging backfill in 86-18 and in any
  case before production dual. `ops-verify.js` prints "Vessels label header: MISSING" and counts
  it as a mismatch (exit 4) until it exists; with it, the mirror, `ops-replay-to-sheet.js` and a
  §9 rollback keep labels in the sheet.
- **Config header row REQUIRED (found in the 86-18 staging rehearsal, 2026-10-08):** the Config tab
  had no header row (row 1 was `staff_emails`), so the backfill rejected it with
  `missing_header`. A `key` | `value` header row was inserted above it in the shared workbook
  on 2026-10-08. This is safe for Apps Script: `checkAuthorization` scans every row for
  `staff_emails` in column A. Confirm the header still exists before the production backfill.
- New vessels do not get Zoho inventory items (Pitfall 11).

### 12. Release checklist

- 85-13 production deploy: PINNED to d2c66be9 (deploy with `git push production d2c66be9:main --force`, never `main`); production/main (ef3be1e3) contains no Phase 86 commit (checked 2026-10-08).
- **Staging candidate commit SHA:** bc353648 (all gates green 2026-10-08; a docs-only commit recording this line sits on top, so push `main` HEAD).
- Production SHA: _to be filled in by the production cutover plan_.
- Apps Script v61 recorded with rollback 60 (§3).


---

## Batches -> Postgres (Phase 87)

Owner-supervised cutover of the four batch tabs (Batches, BatchTasks, PlatoReadings, VesselHistory) to
Postgres, the rollback week and the SQL hand-fix recipe (DB-06). Unlike Phases 84-86 there is **no dual
window**: `BATCHES_STORE` takes `sheets` | `postgres` only (`dual` refuses to boot) and the flip happens
inside one frozen maintenance window. Every script prints ids, field names and counts only, never a
customer name, email, token or note. Evidence goes in
`.planning/phases/87-batches-batchtasks-platoreadings-vesselhistory-postgres/87-CUTOVER-LOG.md`.

**Production cutover record (2026-10-27):**
- Freeze T0 18:13:39Z (set with the Phase 86 flip), promote 214 / 1106 / 72 / 440, verify 0 mismatches,
  parity 0 before and after. Flip T1 18:34:09Z (deploy `90dfb9c1`, live 18:40:18Z). Batch writes were frozen
  about 27 minutes; no sales arrived during the freeze. Record: `87-CUTOVER-LOG.md`.
- Rollback week (§13) runs 2026-10-28 to 2026-11-03. Pre-cutover parity snapshot:
  `~/sv-backfill/pre-cutover-2026-10-27.json` (customer names; keep until retirement, then delete).

Environment variables:

| Variable | Meaning |
|----------|---------|
| `BATCHES_STORE` | `sheets` (default, unset) or `postgres`. `dual` is refused. `postgres` is refused at boot unless `OPS_DATA_STORE` is `dual` or `postgres` (vessels share the batch transaction, D-13). |
| `BATCHES_FREEZE` | Non-empty text = every batch write returns `{ok:false,error:'maintenance'}` in BOTH modes ("Batches are read-only for maintenance until <text>. Please try again then."). Read per call, never cached, no auto-expiry. Reads and the public `batch.html` GET are never frozen. |
| `BATCHES_TIMEZONE` | Optional; default `America/Vancouver`. Used by the drift timer. |

### 0. Preconditions (D-13)

Do not set a window date until every line is true and recorded in the cutover log:

- Production `OPS_DATA_STORE=postgres` is recorded in `86-DUAL-LOG.md` ("Flip decision"). Production
  cutover is gated on the Phase 86 prod flip (Q14/D-13).
- Apps Script **v62** is deployed (rollback **v61**, table above) and its editor-drift hash check passed.
- The staging rehearsal (87-18) is recorded, including measured timings; if it does not fit the 2-hour
  budget comfortably, say so before the date is set (D-03).
- Owner to-do Q1: delete the orphan BatchTasks rows BT-000567..570 in the sheet BEFORE the rehearsal and
  again confirm none remain before the production dry run (orphan children are rejects and block promote).
- Owner to-do Q3: confirm the Apps Script project timezone matches `America/Vancouver`.
- Migration 0005 and the inert Phase 87 code are on production `main` (additive, unused until the flag
  is set, Q10). Record the exact **pinned production SHA** for the window in the cutover log and deploy
  with `git push production <sha>:main --force`, never `main` (same discipline as the Phase 85 and 86
  pins).
- Railway backups are live (Phase 83). Docker is NOT needed for the window.
- The Railway tunnel works (`zoho-middleware/scripts/backfill/README.md` step 3).

### 1. Roles (D-09)

- **Claude** runs the scripted steps, reports each check, and writes the log.
- **Owner** makes the go/no-go call (§7) and does the live smoke that needs Google sign-in (§10).
- Staff are told not to edit BrewPad batches, tasks or readings, or the four sheet tabs, from the freeze
  until the owner announces the window is closed.

### 2. Window timeline (D-02, D-03)

Window: **Sunday evening after close, finished before Monday open.** Budget 120 minutes, leaving room for
one full rollback. Targets are placeholders; 87-18 replaces the right-hand column with measured staging
timings.

| Step | Who | Target (min) | Measured in rehearsal |
|------|-----|--------------|-----------------------|
| 3 Freeze + restart + check | Claude | 5 | 5-9 (Railway redeploy 3.5-5 min; run 1 incl. browser checks 9) |
| 4 Snapshot, dry run, promote | Claude | 20 | 3 (dry run + promote take seconds; rest is the download) |
| 5 Second snapshot + verify | Claude | 10 | 1-2 |
| 6 Parity (after cache expiry) | Claude | 10 | 5 (mostly the 300 s cache wait; the run takes ~20 s) |
| 7 Go/no-go | Owner | 5 | 1 |
| 8 Flip + health + boot lines | Claude | 5 | 2 redeploy + post-flip proxy parity ~5 (see note) |
| 9 D-12 notices | Claude | 3 | not rehearsed (shared workbook; production only) |
| 10 Smoke | Owner + Claude | 20 | |
| 11 Scan invoices | Staff | 10 | |
| Total | | 88 | ~30 for steps 3-8 on staging (run 2, 15:04-15:33) |
| Reserve for rollback (§12) | | 32 | |

Rehearsal notes (87-18, 2026-10-09):

- **Flip needs an explicit redeploy.** `railway variable delete` does not trigger a deploy, and
  `railway variable set --skip-deploys` obviously does not either. Do the one variable change, then run
  `railway redeploy -s sv_middleware -e <env> -y` and confirm the startup log line
  `store modes: {... "BATCHES_STORE":"postgres"}` and that a batch write is no longer refused.
- **A failed build blocks variable-only redeploys.** While the newest deployment is a FAILED build,
  Railway's CLI refuses restart/redeploy, so a freeze cannot be lifted from the CLI. Never push code
  during the window.
- **BrewPad does not show the maintenance text** (generic "Save failed - try again"); `brewpad.js` is
  locked, so tell staff about the window beforehand. Admin shows the maintenance message.
- **Post-flip parity token:** start the terminal command first (it waits on `read -s`), THEN copy the
  token with `copy(localStorage.getItem('sv_session_token'))` in the admin console, then paste. Copying
  the command afterwards overwrites the clipboard and gives a 403.

### 3. Freeze

1. Tell staff the window has started.
2. Railway variable `BATCHES_FREEZE="<HH:MM>"` (the time you expect to finish, shown to users as "until
   <HH:MM>"); the service restarts (about 1 minute). Record the start time in the cutover log.
3. Check that a BrewPad write (for example mark a task done) shows the maintenance message, and that
   `batch.html` still loads for an existing printed token.
4. **Start the invoice list now:** note every Zoho invoice dated from the freeze time. Kiosk and POS sales
   still complete during the freeze; their batch creation is refused with
   `[batch-store] create_batch refused: maintenance invoice=<no>` and goes to the retry queue
   (`kiosk.batch_retry_queued` events). These invoices are re-processed in §11 (D-04).

### 4. Snapshot + backfill

1. In Google Sheets: File -> Download -> .xlsx to `~/sv-backfill/snapshot.xlsx` (outside the repo; the
   scripts refuse an in-repo snapshot).
2. **Eyeball the tails of all four tabs first.** The backfill silently skips rows with a blank primary key,
   even when other cells hold data, so the dry run will not flag them.
3. Open the tunnel and run from `zoho-middleware/`:

```bash
railway connect Postgres --tunnel-only --environment production   # separate terminal
cd zoho-middleware
read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL
node scripts/backfill/batches-backfill.js --file="$HOME/sv-backfill/snapshot.xlsx" --out-dir="$HOME/sv-backfill/out" --dry-run
```

4. The dry run must show **0 rejects** (any reject blocks promote). Exit codes: 0 ok, 1 error, 2 rejects,
   3 a promote invariant failed. Check the counts and the four sequence seeds in the summary file. Flags
   are equals-form only; the database URL is accepted only from `BACKFILL_DATABASE_URL`.
5. Promote: same command with `--promote` instead of `--dry-run`. It prompts for the database name, requires
   all six batch tables empty, inserts in one transaction, seeds the four id sequences with `setval`, runs
   ten invariants (counts, sequences, orphans, unit_seq) and commits only if all pass.
6. Timezone: `--timezone` defaults to `America/Vancouver`.

### 5. Verify

Download a **second fresh** .xlsx (`~/sv-backfill/fresh.xlsx`) after the freeze (no write can have slipped
in) and run:

```bash
node scripts/backfill/batches-verify.js --file="$HOME/sv-backfill/fresh.xlsx"
```

Required: equal counts per table and `0 mismatches` (exit 0; exit 4 = mismatches, 1 = error).

### 6. Parity (dashboard numbers)

Apps Script caches the dashboard and upcoming reads for **300 s**. After the last write (the freeze) let
the cache expire before running, otherwise the sheet side can be up to 5 minutes stale and report a false
difference. The script refuses to run within 15 minutes of local midnight. Export
`APPS_SCRIPT_URL` and `APPS_SCRIPT_SERVER_TOKEN` (same values as Railway) with `read -s`, then:

```bash
node scripts/backfill/batches-parity.js --snapshot-out="$HOME/sv-backfill/pre-cutover-$(date +%F).json"
```

It compares `get_batch_dashboard_summary`, `get_batches` (all), `get_tasks_upcoming` (200) and
`get_tasks_calendar` for this and next month between Apps Script and Postgres. Required: `parity: 0
differences` (exit 0; exit 4 = differences, printed as `<read> <path>` only). The snapshot holds customer
names: it must stay outside the repo and is deleted at day-7 retirement. A no-go here costs nothing.

### 7. Go / no-go (D-06)

The owner decides. **No-go on ANY of:**

- a non-empty reject list from the dry run;
- any row-count mismatch between sheet and Postgres, or any verify mismatch;
- any dashboard parity difference;
- any failed smoke write in §10: create batch, mark task, add reading, vessel transfer.

No-go before §8 means: unset `BATCHES_FREEZE`, leave `BATCHES_STORE` unset, and truncate nothing (the
sheet is still authoritative; Postgres rows are inert). To retry another day, empty the six batch tables
first (a hand SQL step, §16 recipe, logged).

### 8. Flip

1. In ONE Railway variable change: set `BATCHES_STORE=postgres` and remove `BATCHES_FREEZE`. The
   service restarts.
2. `/health` shows `database_required: true`. The startup log contains the ops mirror sweep registration
   lines (the `batch` entity is swept with the others).
3. Production only: the 24-hour drift timer is registered (it is a no-op off production or while
   `BATCHES_STORE` is not `postgres`).

### 9. D-12 notices

In the Apps Script editor run `setupBatchMirrorNotices()`. It writes a "mirror only" note in row 1 and a
warning-only sheet protection (description "Phase 87 batch mirror") on each of the four tabs. It is
idempotent. It inserts no row and changes no dispatch.

### 10. Smoke

Owner (Google sign-in): create a batch (confirm the mirrored sheet row appears), mark a task, add a
reading, do a vessel transfer, open `batch.html` with an **existing printed token**, regenerate the token on
a test batch and confirm the old token stops working and the new one works.

Claude, in parallel:

```bash
read -s BATCH_PARITY_SESSION && export BATCH_PARITY_SESSION     # a staff session token, never argv
export BATCH_PARITY_BASE_URL=https://<production host>
node scripts/backfill/batches-parity.js --against-snapshot="$HOME/sv-backfill/pre-cutover-<date>.json" --via=proxy
```

This replays the saved reads through `/api/admin/proxy` (header `x-session-token`) and diffs against the
Apps Script side of the snapshot. Smoke writes legitimately change the numbers, so run it BEFORE the
write smoke, or expect and explain differences caused by the smoke batch. Also confirm: mirror success
log lines for `batches.mirror`, no Sentry `ops-mirror` events, and `[batch-proxy] create_batch ms=<n>`
log lines (the SC4 median comes from these).

### 11. Scan invoices for the window's invoices (D-04)

Staff run **Scan invoices** in the admin panel so batches are created for sales made during the freeze.
Use the invoice list from §3 as the checklist and the logs as the cross-check:

- `[brewpad] ... maintenance` / `[batch-store] create_batch refused: maintenance invoice=<no>` lines
  list the invoices that were refused;
- `kiosk.batch_retry_queued` events and "Apps Script returned error" warnings list the queued retries.

Dedup on invoice + SKU makes Scan idempotent. Record the result (created / already existed) in the log.

### 12. Rollback inside the window

Triggers: any §7 no-go after the flip, or a failed smoke write.

1. Keep `BATCHES_FREEZE` set (set it again if already removed).
2. Set `BATCHES_STORE` back to `sheets` (or unset it). The sheet was authoritative until the flip, so no
   replay is needed when only smoke writes happened. Delete the smoke batch first, or replay it:
   `node scripts/backfill/batches-replay-to-sheet.js --since=<window start ISO>` then add `--apply`.
3. Run `removeBatchMirrorNotices()` if §9 was done (it removes only the "Phase 87 batch mirror"
   protections).
4. Verify with `batches-verify.js` against a fresh snapshot, then remove the freeze and tell staff.

### 13. Rollback during days 1-7 (D-07)

Real traffic is now in Postgres, so **replay to the sheet first**:

1. Keep or set `BATCHES_FREEZE`.
2. Dry run, then apply, from the window's flip time (or an earlier ISO time):

```bash
node scripts/backfill/batches-replay-to-sheet.js --since=2026-10-12T00:00:00Z          # dry run, no HTTP
node scripts/backfill/batches-replay-to-sheet.js --since=2026-10-12T00:00:00Z --apply  # needs APPS_SCRIPT_URL, APPS_SCRIPT_SERVER_TOKEN
```

It sends `mirror_batch_state` for every batch changed since then (ordered by last_updated), then
`mirror_batch_delete` for tombstones, and stops at the first failure naming the batch id.
3. Verify with a fresh snapshot and `batches-verify.js` (0 mismatches).
4. Run `removeBatchMirrorNotices()` in the Apps Script editor.
5. Set `BATCHES_STORE=sheets` (or unset), remove `BATCHES_FREEZE`.
6. **On any later re-flip**, the Postgres id sequences must be re-seeded to at least max(sheet, Postgres)
   for each prefix, because the sheet issued ids while Postgres was off. Use the §16 tunnel recipe with
   `select setval('batch_id_seq', <n>)` (also `batch_task_id_seq`, `plato_reading_id_seq`,
   `vessel_history_id_seq`), and empty the tables and re-run §4 to §6 rather than flipping on stale rows.
7. Apps Script can be rolled back to v61 only if the mirror is no longer wanted (Deploy -> Manage
   deployments -> pencil -> v61); rolling it back disables `mirror_batch_*`.

### 14. Daily drift check (days 1-7)

In production a timer runs every 24 hours: it calls the read-only `export_batch_tabs`, normalises the
sheet rows and compares all four tabs with Postgres. Success logs `[batches-drift] 0 mismatches`.
Differences log `table id field` lines only (never values) and raise a Sentry event **`batches drift
detected`** (tags `component:batches-drift`, extra `mismatchCount`, `tables`, `headerOk`). A failure
to run raises `batches drift check failed`.

- **The first production run may show false date mismatches** (JSON turns true date cells into ISO strings
  with a `Z`). Read its log lines; if only `start_date` / `due_date` fields differ and the sheet cells are
  true dates, record it as explained and do not roll back.
- Any other mismatch: find the batch id, compare with Postgres, and either fix by §16 then replay that
  batch, or replay the sheet side (a mirror write) if Postgres is right. A stuck mirror shows as a
  surviving `ops:mirror-dirty:batch:` Redis marker.
- Log each day's result in the cutover log "Rollback week" table.

### 15. Day-7 retirement (D-08)

After 7 consecutive days with zero unexplained drift:

1. Record the retirement date in the cutover log. **Rollback to the sheet is then no longer supported.**
2. Delete `~/sv-backfill/` snapshots and the parity snapshot (customer names).
3. Leave the D-12 notices and the mirror in place until Phase 88 decides the mirror's fate.

### 16. Hand data fix (SQL) (D-11)

There is no admin edit UI for batch data. A wrong row is fixed by reviewed SQL, never ad hoc:

```bash
railway connect Postgres --tunnel-only --environment production    # separate terminal
read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL
psql "$BACKFILL_DATABASE_URL"
```

1. **Dry-run SELECT** showing only the affected ids:
   `select batch_id from batches where <condition>;` Write down the count N and get the owner to agree.
2. **UPDATE inside a transaction** with a row-count check:

```sql
begin;
update batches set <column> = <value>, last_updated = now()
 where <same condition> returning batch_id;
-- the returned row count MUST equal N from the dry run
commit;   -- or: rollback;
```

3. If the count is not N, `rollback;` and stop.
4. **Schedule the mirror:** replay just that batch to the sheet
   (`batches-replay-to-sheet.js --since=<just before the fix>` then `--apply`; dry run first and check it lists
   only the expected ids).
5. **Log** the date, the ids, the reason and the statement shape in `87-CUTOVER-LOG.md` under "SQL fixes".

---

## Batch type and completion dates (Phase 94)

Backfills batch type (B3) and missing completion dates (B2), then checks cycle time independently. All three
CLIs live in `zoho-middleware/scripts/backfill/` (see its README). The two backfills are dry-run by default and
write only with `--apply --expect=<reviewed count>`.

### Preconditions

- The Phase 87 production cutover is done (`BATCHES_STORE=postgres`, recorded in `87-CUTOVER-LOG.md`).
- Migration `0006` then `0007` is applied on the target environment.

### How to run (in-container)

`railway connect` from `zoho-middleware/` fails, so run inside the middleware service: `railway ssh`, then
`BACKFILL_DATABASE_URL=$DATABASE_URL node scripts/backfill/<cli>.js ...`. Never put a database URL on the command line.

### Owner-OK rule (D-09, D-16)

No `--apply` is run without the owner's in-session OK on the FULL dry-run list. `--expect=N` must equal the count the
owner reviewed; a mismatch exits 3 and writes nothing.

### Staging (Postgres only)

1. `batch-type-backfill.js` dry run (B3), owner review, then `--apply --expect=N`.
2. `completed-at-backfill.js` dry run (B2), owner review, then `--apply --expect=M`.
3. `batch-cycle-recompute.js`: `null_batch_type` should be 0; compare the median/mean with the dashboard (+/-1 day).

NEVER run `batches-replay-to-sheet` or `batches-verify` on staging: staging never mirrors and the workbook is shared
with production. The replay CLI refuses outside production anyway.

### Production

Same order as staging, plus, after EACH `--apply` (both bump the mirrored `last_updated`):

1. `node scripts/backfill/batches-replay-to-sheet.js --since=<apply start, ISO>` (dry run, check the listed ids), then `--apply`.
2. `batches-verify.js --file=<fresh snapshot>` and require 0 mismatches.

### Logging

Log each production apply (date, command, count, reason) in `87-CUTOVER-LOG.md` under "SQL fixes" (see the SQL-fix rule above).

### Rollback and corrections

Re-runs are idempotent. Correct a single batch's type in the BrewPad detail pane (source becomes `manual`, never
overwritten by a re-run). Estimated completion dates are stamped `completed_at_source = 'backfill-task'`, so they can be
found and revised.

---

## Staff batch flag (Phase 95)

One-time backfill of `batches.staff_batch` for existing staff / family / R&D batches (D-09), so the BrewPad v2 mix
views can hide them. CLI: `zoho-middleware/scripts/backfill/staff-batch-backfill.js` (see its README). Dry-run by
default; writes only with `--apply --expect=<reviewed count> --expect-ids=<reviewed fingerprint>`. Candidates: source `internal` / `research`, or a
customer name containing `McLachlan` or `Inn` as a whole word.

### Preconditions

- Migration `0008` is applied on the target environment, after `0007`.
- The Phase 94 B3/B2 backfills are already applied.

### How to run (in-container)

`railway ssh` into the middleware service, then
`BACKFILL_DATABASE_URL=$DATABASE_URL node scripts/backfill/staff-batch-backfill.js ...`. Never put a database URL on
the command line (the CLI refuses it).

### Owner-OK rule

No `--apply` without the owner's in-session OK on the FULL dry-run list. `--expect=N` must equal the reviewed count and
`--expect-ids=FP` the fingerprint the reviewed dry run printed (`fingerprint: ...`, the first 12 hex of the SHA-256 of
the sorted candidate ids). Either mismatch exits 3 and writes nothing, so a set that changed since the review (one row
flagged by hand, one new match, same count) is refused. `--apply` without `--expect-ids` is refused. False positives
(for example a paying customer who shares a family surname) are dropped with `--exclude=<ids>` on both the dry run and
the apply, so `--expect` and `--expect-ids` describe the rows actually written; an excluded id that is not a candidate
is refused. Do not edit the SQL.

Owner review 2026-10-28 (staging): flag Koa Inn and Paul McLachlan only. Anthony McLachlan, Katie McLachlan and
Wayne (SV-B-000238, source `internal`) are paying customers - exclude their batches.

### Staging (Postgres only)

Dry run, owner OK, `--apply --expect=N --expect-ids=FP`. NEVER run batches-replay-to-sheet or batches-verify on staging: staging never
mirrors and the workbook is shared with production.

### Production

Dry run, owner OK, `--apply --expect=N --expect-ids=FP`, then `batches-verify.js --file=<fresh snapshot>` and require 0 mismatches.
No replay is needed: the write does not bump `last_updated` (D-18), and `staff_batch` is not mirrored to the sheet.
This satisfies D-09's "after replay + verify" ordering.

### Logging

Log each production apply (date, command, count, reason) in `87-CUTOVER-LOG.md` under "SQL fixes".

### Rollback and corrections

Re-runs are idempotent (a second dry run lists 0). Clear a wrongly flagged batch with the Staff batch checkbox in the
BrewPad detail pane. New batches are flagged only on create, for internal / research sources (D-19).

---

## Limited Release deposits (Phase 100)

Customers reserve limited-release kits on `limited-releases.html` with a $50 non-refundable-by-default deposit per kit. Each kit becomes one Zoho Sales Order (SO) with a $50 unapplied customer advance, reference `LIMITED-2026-27`, and the Maker's Fee and Materials Fee already on the SO (D-03). No BrewPad batch is created at deposit time.

1. **Who reserved what.** In Zoho Books, list Sales Orders filtered by reference `LIMITED-2026-27` and group by item. One SO is one kit. Staff also get one email per deposit.
2. **Before each supplier order.** Count the SOs per kit; that is the quantity to order.
3. **Kit arrives.** Receive the bill, then contact each depositor to book a start. Add the 10 SKUs to the BrewPad Kits sheet so batches carry product data (owner ops item).
4. **Brew day.** Take payment with the kiosk Pay button on the SO. The kiosk shows "Deposit applied" and charges only the remainder; it applies the $50 advance to the invoice and creates the batch. The Maker's Fee and Materials Fee are already on the SO and are invoiced at conversion. Do not take payment any other way: the `/api/pos/collect` path is not deposit-aware.
5. **Supplier cannot deliver (D-05).** Refund the $50 per kit in Helcim, delete the deposit payment in Zoho (or refund it from the advance), then void/delete the SO.
6. **Switching before the release month (D-07).** Edit the SO's kit line in Zoho to another limited kit (same reference). The advance stays on the SO.
7. **Forfeit after 60 days (D-06).** Leave the SO open and ask the accountant how to recognise the forfeited advance, case by case.
8. **Alert "ACTION NEEDED: Limited Release deposit failed after charge".** Find the leftovers by the listed ids and the Helcim transaction id in the SO notes. If the email says the void failed, void the charge in Helcim.
9. **Daily check while deposits are open.** Compare Helcim transactions whose invoice number starts with `LR-` against `LIMITED-2026-27` SOs. Redis keys `preorder:pending:<txn>` mark incomplete bookings.
10. **Kill switch.** `PREORDER_DEPOSITS_ENABLED=true` on the middleware service opens reservations; unset it to stop new deposits (in-flight payments are still booked or voided). Staging first; production only after owner sign-off.
11. **Payment dates are UTC.** An evening deposit may be dated the next day. Accountant note.

---

## Phase 46 Auth Cutover (CRITICAL — leaked-key neutralization)

Closes the audit CRITICAL: the storefront previously shipped `MW_API_KEY` in client JS, so the
shared `API_SECRET_KEY` is compromised (its value also persists in git history). Phase 46 replaces
the single shared key with three credential tiers — legacy `x-api-key`, kiosk `x-device-token`,
and Google `sv_session` cookie — all accepted **simultaneously** (dual-accept) until the owner
**rotates `API_SECRET_KEY`**, which is the step that actually kills the leaked key.

**Status:** ✅ COMPLETE — executed 2026-07-08. New 3-tier auth live on prod, all three surfaces verified, `API_SECRET_KEY` rotated, leaked key confirmed dead (403). Audit CRITICAL closed.

> **Deploy topology note (matters for sequencing):** Railway (middleware) and GitHub Pages
> (frontend) both build from the **production** repo, so a prod deploy ships them **together** —
> the new middleware cannot go live without the new frontend. Chosen approach: **coupled deploy,
> off-hours.** Deploy both to prod at once under dual-accept (old `API_SECRET_KEY` retained), when
> the store is closed, then immediately provision the iPad. Only the kiosk is affected, and only
> until its device token is entered; admin/BrewPad/public keep working throughout. There is no
> staging middleware (staging frontend calls prod middleware), so the new auth is truly verifiable
> only on prod post-deploy — dual-accept is the safety net, not staging.

### Secret locations (values are NOT stored in this file)

| Variable | Where the value lives | Notes |
|----------|----------------------|-------|
| `STAFF_EMAILS` | Owner-defined → Railway `svmiddleware-production` → Variables | Comma-separated allowlisted Google emails (D-46-07). **Current value to set: `hello@steinsandvines.ca`** (expand later as staff are added) |
| `KIOSK_DEVICE_TOKEN` | Password manager + Railway → Variables | Generated during cutover prep (`openssl rand -base64 48`) |
| `SHEETS_CLIENT_ID` | Railway → Variables | Public Google OAuth client id `8605205683-tck2da2tpp03vcbr5etauu9q7kompg3q.apps.googleusercontent.com` (not a secret) |
| `API_SECRET_KEY` | Railway → Variables | UNCHANGED until Task 3, then rotated (`openssl rand -base64 32`) |
| `API_SECRET_KEY_PREVIOUS` | Railway → Variables (optional) | Set to the retired key value after rotation for canary logging (Finding #6) |

### Task 1 — Set env vars + coupled prod deploy (dual-accept live)

- [ ] Generate secrets in your OWN terminal (keep them out of chat): `openssl rand -base64 48` → `KIOSK_DEVICE_TOKEN`; hold `openssl rand -base64 32` → new `API_SECRET_KEY` for Task 3
- [ ] Set `STAFF_EMAILS=hello@steinsandvines.ca`, `KIOSK_DEVICE_TOKEN`, `SHEETS_CLIENT_ID` in Railway `svmiddleware-production` → Variables. **Leave `API_SECRET_KEY` at its current (old) value** (dual-accept)
- [ ] Store `KIOSK_DEVICE_TOKEN` in the password manager
- [ ] `git push origin main` — publish to staging + run CI (nothing goes live on prod yet)
- [ ] **When the store is CLOSED**, promote to prod: trigger the `Gated Production Deploy` workflow (workflow_dispatch), or break-glass `git push production main --force`. This publishes new frontend (Pages) **and** new middleware (Railway) together; `API_SECRET_KEY` stays old, so old key + new credentials are all accepted
- [ ] Proceed to Task 2 immediately — the store kiosk is down until its device token is entered

**Verify:**
```bash
# /health authenticated + redis up
curl -s https://svmiddleware-production.up.railway.app/health   # expect 200, authenticated:true, redis:true
# dual-accept: OLD key still accepted. Non-mutating PII-GET probe (200 if accepted, 403 if not).
# <OLD_API_SECRET_KEY> is the current leaked value re-enabled on 2026-07-04.
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "x-api-key: <OLD_API_SECRET_KEY>" \
  'https://svmiddleware-production.up.railway.app/api/contacts?search=zz_verify'   # expect 200
```
Resume signal: **"deployed"**

### Rollback (Stage 1 — if the coupled deploy misbehaves BEFORE Task 3 rotation)

During Task 1–2, `API_SECRET_KEY` is still the current (leaked) value, so rolling the
**code** back to the prior production release restores exactly today's working state
(old `x-api-key` middleware + matching key). The new env vars (`KIOSK_DEVICE_TOKEN`,
`STAFF_EMAILS`, `SHEETS_CLIENT_ID`) are harmless to the old code — leave them set.

- [ ] Redeploy the prior production release **`495630177bbe60b36cffaf6f2bcf6a69425e826e`** (the pre-cutover prod HEAD, "fix(reconcile): stop re-alert flood…"):
  - Preferred: re-run the **Gated Production Deploy** workflow targeting that SHA (handles the `steinsandvines.ca` CNAME commit correctly).
  - Break-glass: `git push production 495630177bbe60b36cffaf6f2bcf6a69425e826e:main --force` — then confirm the prod Pages CNAME is still `steinsandvines.ca` (the gated workflow normally owns this; verify in repo settings after a raw force-push).
- [ ] Railway auto-redeploys the middleware from the rolled-back SHA. Verify sales with the same PII-GET probe above (expect 200 with the leaked key).
- [ ] **Do NOT use this path AFTER Task 3.** Once `API_SECRET_KEY` is rotated, the leaked key is dead — a code rollback would also require reverting `API_SECRET_KEY` to the old value (which re-exposes the leaked key). After rotation, fix forward instead.

### Task 2 — Provision iPad + verify all three surfaces

- [ ] KIOSK (store iPad, staging `kiosk.html`): open the device-token settings prompt, paste `KIOSK_DEVICE_TOKEN`, save → PIN pad appears (no Google sign-in). Ring up a real test sale end-to-end (terminal charge → Zoho invoice). Confirm customer search works (via `/api/contacts/search`).
- [ ] ADMIN (`admin.html`): sign in with an **allowlisted** Google account → dashboard loads; perform an admin-grade action (report / gift-card void view). Sign in with a **non-allowlisted** account → denied.
- [ ] BREWPAD (`brewpad.html`): Google sign-in → authenticated; load a batch list (session-auth) → works.
- [ ] NEGATIVE: from the kiosk device token, confirm an admin-grade route (gift-card void) is **refused 403** (device scope holds).

Resume signal: **"verified"**

### Task 3 — Rotate API_SECRET_KEY + confirm old key dead

- [ ] (Frontend is already live on prod from the Task 1 coupled deploy — no separate promotion needed.)
- [ ] Within ~2–3 business days of go-live (D-46-12), once all surfaces are confirmed on the new credentials: rotate `API_SECRET_KEY` in Railway to the new value from Task 1 (this ends dual-accept and kills the leaked key)
- [ ] (optional) Set `API_SECRET_KEY_PREVIOUS` to the retired value for canary logging

**Verify:**
```bash
# old key now DEAD (same non-mutating probe as Task 1, now expected to 403)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "x-api-key: <OLD_API_SECRET_KEY>" \
  'https://svmiddleware-production.up.railway.app/api/contacts?search=zz_verify'   # expect 403
# no lockout: re-check kiosk sale, an admin action, a BrewPad load
# public prod checkout (ferment reservation → /api/bookings + /api/contacts + /api/payment/initialize) completes with NO 403
```
Resume signal: **"rotated"**

### Outcome record (fill in on completion)

- Go-live (Task 1) date: 2026-07-08 — new frontend + middleware live, dual-accept confirmed, leaked key removed from served `sheets-config.js`
- Surfaces verified (Task 2) date: 2026-07-08 — kiosk (device token → PIN → real terminal sale + customer search), admin (`hello@steinsandvines.ca` Google sign-in), BrewPad (Google session) all confirmed
- `API_SECRET_KEY` rotation date: 2026-07-08 — old leaked key now returns 403; no lockout (public checkout + all surfaces OK). Note: new key was first pasted into `MW_API_KEY` (which `API_SECRET_KEY` overrides), corrected by setting `API_SECRET_KEY` and deleting `MW_API_KEY`.
- Retired-key disposition: leaked key `a9QK…3fM=` neutralized (invalid on prod middleware); it remains in git history but is now dead.
- **Deploy mechanism:** Gated Production Deploy workflow (run 28964582252), origin/main → production repo `caafb19`. `API_SECRET_KEY_PREVIOUS` canary from the plan was NOT implemented in `apiKey.js` — rotation was a hard cutover (no grace window); safe because no frontend still sends `x-api-key`.
- **D-46-13 (interim IP allowlist): SKIPPED** — Phase 45 containment already shipped, cutover is days away, and the store IP may be dynamic. Recorded here per decision; no interim allowlist added.

---

## CNAME Reference

The CNAME file is **tracked in git** (not untracked — see Research note below).

| Repo | CNAME value | When |
|------|-------------|------|
| Staging (`origin`) | `staging.steinsandvines.ca` | Always — staging's CNAME is never changed |
| Production | `steinsandvines.ca` | Set by gated-deploy as part of the force-pushed commit |

**The gated-deploy workflow handles the CNAME swap without ever touching staging:**
1. Validates CNAME is `staging.steinsandvines.ca` before starting (aborts if it is already the production value — backstop against an externally-introduced stuck state)
2. Commits `steinsandvines.ca` on top of the deploy SHA and force-pushes that commit to the **production** repo only
3. Immediately runs `git reset --hard` back to the deploy SHA, so the prod-CNAME commit is never pushed to `origin`/staging. There is no separate "restore" step — staging's CNAME is never modified, eliminating the old mid-swap window.

**Never push `steinsandvines.ca` to the staging repo (`origin`) or `staging.steinsandvines.ca` to the production repo.**

> **`enforce-cname.yml` is BROKEN (403):** The workflow uses `gh api ... -X PUT` to set the Pages domain. This fails with 403 because `GITHUB_TOKEN` lacks the `pages:write` scope for the PUT endpoint on repos using Actions-based deploy. Do NOT rely on `enforce-cname.yml` for CNAME management — the gated-deploy workflow manages it manually.

> **Research note:** CLAUDE.md states "CNAME is in `.gitignore`." This is technically inaccurate — CNAME is listed in `.gitignore` but was committed before that entry and remains tracked. `git ls-files CNAME` returns `CNAME`. Once a file is tracked, `.gitignore` has no effect until `git rm --cached`.

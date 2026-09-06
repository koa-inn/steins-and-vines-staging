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

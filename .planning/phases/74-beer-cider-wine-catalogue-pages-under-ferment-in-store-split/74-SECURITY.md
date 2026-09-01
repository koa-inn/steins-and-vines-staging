# Phase 74 — Security Audit

**Phase:** 74 — Beer/Cider/Wine Catalogue Pages, Ferment-in-Store Split
**Audited:** 2026-09-01
**ASVS Level:** 1
**block_on:** high
**Mode:** `register_authored_at_plan_time` — verifying existing register, not scanning for new threats.
**Threats registered:** 34 (T-74-01 .. T-74-33 + T-74-SC, deduplicated across all 6 plans)
**Threats Closed:** 31/34
**Threats Open:** 3/34 (T-74-31, T-74-32, T-74-33 — all gated behind the same unfinished PAUSED checkpoint)

## Result: OPEN_THREATS

Three threats cannot be closed because the mitigations they depend on (74-06 Task 4 "D-08 content pass" and Task 5 "staging human-verify") have not been executed — 74-06-SUMMARY.md's own front-matter records `status: PAUSED — blocking checkpoint (Task 4 of 5)`. This is not a code defect: the 31 code-level mitigations verified below are real, tested, and (for the recipe-guard chain, T-74-01/02/03/04/06) confirmed live on staging by a direct unauthenticated probe during this audit. The gap is procedural completion, not implementation quality.

---

## Verification Method

For each `mitigate` threat: grepped/read the cited implementation file(s) directly, cross-checked against `git show` diffs of the specific commit that claims to close it (not just current-state greps, to rule out a stale claim), and where a dedicated regression test existed, ran it. For `accept`: confirmed the accepted-risk rationale holds structurally (cache TTL, endpoint scope) and it is now logged below. For `transfer`: confirmed the transferred-to control (authTiers/apiKey timing-safe compare; the pre-existing rate limiter) is unmodified by this phase and actually covers the route in question.

Full middleware and frontend suites were run live during this audit (not merely cited from SUMMARY.md):
- `npm test` (frontend): **91/91 suites, 1229/1229 tests passing**
- `cd zoho-middleware && npm test`: **102/102 suites, 1524/1524 tests passing**
- `npm run lint`: clean

## Live-endpoint check (performed during this audit, not from SUMMARY.md)

```
curl https://svmiddleware-staging.up.railway.app/api/recipes?status=active
→ {"recipes":[{"recipe_id":"SV-R-000002","name":"Czech Lager","style":"Czech Lager","description":"","price":123.6,"price_from":true}]}
```
Staging returns the correct six-field public shape with zero cost/status/ingredient keys — the T-74-01/02/03/04 guard chain is live and working end-to-end on staging, not just unit-tested.

```
curl https://svmiddleware-production.up.railway.app/api/recipes?status=active
→ {"recipes":[{"recipe_id":"SV-R-000002", ... "status":"active","locked_price":130,"service_fee":45,
   "materials_fee":5,"pricing_mode":"dynamic","computed_price":123.6, ...}], "total":10}
```
**Production is still running pre-fix code** and currently leaks `locked_price`/`service_fee`/`materials_fee`/`pricing_mode`/`computed_price`/`status` to any anonymous caller. The merged mitigation has not been deployed to production. This does not reopen T-74-01..04 (the code-level disposition is "mitigate in the implementation," which is verified present and correct in the merged tree, and independently confirmed live-correct on staging) — but it is a live, currently-exploitable information disclosure on the production domain and must be tracked as an operational deployment gap, not filed away as closed-and-forgotten.

---

## Threat Verification — Closed (31/34)

| Threat ID | Category | Disposition | Evidence |
|---|---|---|---|
| T-74-01 | Info Disclosure | mitigate | `zoho-middleware/routes/recipes.js`: `status` resolved to `'active'` for non-staff *before* `cacheKey` is built (`var status = isStaff ? requestedStatus : 'active';` → `cacheKey = ... + status ...`); `sendRecipeList()` re-filters `recipes.filter(r => r.status === 'active')` even on a cache hit. Regression: `recipes-public-guard.test.js` (10 tests, passing). Live-verified on staging (see above). |
| T-74-02 | Info Disclosure | mitigate | `GET /api/recipes/:id` `sendRecipeDetail()`: non-active + non-staff → `res.status(404).json({error:'Recipe not found'})`; active → `{recipe: toPublicRecipe(...)}`, no `ingredients` key emitted (allowlist has no `ingredients` field). |
| T-74-03 | Elevation of Privilege | mitigate | `var requestedStatus = req.query.status || 'all'; var status = isStaff ? requestedStatus : 'active';` — client value discarded before cache key / Apps Script payload construction for non-staff. |
| T-74-04 | Info Disclosure | mitigate | `toPublicRecipe()` builds a **new** object copying only `PUBLIC_RECIPE_FIELDS = ['recipe_id','name','style','description']` plus a derived, collapsed `price`; `locked_price`/`service_fee`/`materials_fee`/`computed_price`/`pricing_mode` never copied. Confirmed absent from live staging response. |
| T-74-05 | Spoofing | transfer | `authTiers.js` untouched by any phase-74 commit (`git log -- zoho-middleware/lib/authTiers.js` last touched 2026-08-27, phase 76-02, unrelated). `apiKeyGuard.matches` (`zoho-middleware/lib/apiKey.js:35`) still uses `crypto.timingSafeEqual` after a length pre-check, unmodified. |
| T-74-06 | Repudiation | mitigate | `isRecipeStaff()`: `authTiers.resolveTier(req).then(...).catch(function(){ return false; })` — fails closed to public on any rejection. |
| T-74-07 | DoS | accept | `RECIPES_CACHE_TTL = 600` (10 min) retained; anonymous traffic collapses onto `sv:recipes:active:0:0`. **Accepted-risk log entry: this file.** |
| T-74-08 | Tampering/XSS | mitigate | `buildWaitlistCtaLink` (js/modules/07-catalog-kits.js:61-77), `sortFilterValues` (:90-129), and the ABV chip path (:1067-1071, :1173-1177) use only `createElement`/`textContent`/`className`. Zero `innerHTML` in any of the three. |
| T-74-09 | Tampering (prototype pollution) | mitigate | `flattenCustomFields` guard (`key === '__proto__' \|\| 'constructor' \|\| 'prototype'`) predates this phase (commit `a7def41f`, phase 30) and is untouched; `matchesKitCategory` only reads `obj.category`/`_zoho_category`/`type`, never assigns. |
| T-74-10 | Info Disclosure | accept | `GET /api/products` confirmed unauthenticated/unscoped by design elsewhere in the codebase; category scoping in `matchesKitCategory` is display-only. **Accepted-risk log entry: this file.** |
| T-74-11 | Elevation of Privilege | mitigate | `buildBeerCard` (js/modules/07-catalog-kits.js:1112-1201) contains zero occurrences of `reserve-wrap`/`reserveWrap`/`kitBuyWrap`; only `buildWaitlistCtaLink()` is appended. Card dispatch (`:1751-1755`) routes any `type` containing `'beer'` to `buildBeerCard`. Regression: `catalog-category-scope.test.js` `'wrapper className does not contain product-reserve-wrap'` (22 tests, passing). |
| T-74-12 | Tampering/XSS | mitigate | `buildRecipeCard` (js/modules/07-catalog-kits.js:165-206): zero `innerHTML`, all nodes via `createElement`/`textContent`. |
| T-74-13 | Info Disclosure | mitigate | `fetchActiveRecipes()`: single literal `fetch(middlewareUrl + '/api/recipes?status=active')`, no headers object. `grep -c 'status=all'` on the module = 0. |
| T-74-14 | Info Disclosure | mitigate | `buildRecipeCard` reads only `recipe_id/name/style/description/price/price_from`. Grep for `ingredients\|locked_price\|service_fee\|materials_fee\|computed_price\|pricing_mode` in the module returns only unrelated comments and an `#ingredients` tab-param string — zero actual field access. |
| T-74-15 | DoS | accept | Retry is user-click-initiated, single-shot; served from the same 10-min Redis cache. **Accepted-risk log entry: this file.** |
| T-74-16 | Spoofing | mitigate | `connect-src` on `wine.html`/`beer.html` already lists both `svmiddleware-production` and `svmiddleware-staging` origins; no CSP edit made by this plan (confirmed under T-74-22). |
| T-74-17 | Tampering | mitigate | `wine.html` vs `beer.html` CSP `<meta>` tag: byte-for-byte identical (diffed programmatically during this audit). |
| T-74-18 | Info Disclosure | mitigate | Same identity check — `connect-src` includes Sentry/GA4/Meta/GTM domains unchanged. |
| T-74-19 | Tampering | mitigate | No third-party origin present on `wine.html` that isn't already on `beer.html`'s identical CSP. |
| T-74-20 | Spoofing | mitigate | 8 files under `products/` use `../wine.html`; nav entry present on all 17 target pages + `wine.html`'s own active link (18 total — documented, reasonable deviation from the plan's "17," see 74-04-SUMMARY.md Deviations; the narrower per-subset assertions the audit re-verified independently all pass). |
| T-74-21 | Repudiation | mitigate | `package.json` `stamp:pages` array has `'wine.html'` first (immediately before `'beer.html'`); `node -e "require('./package.json')"` exits 0. |
| T-74-22 | Tampering | mitigate | `grep -c 'Content-Security-Policy'` = 1 on `beer.html`, `products/ferment-in-store.html`, `index.html`. `git show <74-05 commits> -- beer.html products/ferment-in-store.html index.html \| grep -c Content-Security-Policy` = 0 (no CSP line in either diff). |
| T-74-23 | DoS (self) | mitigate | `products/ferment-in-store.html` carries three `.btn-secondary` routes (`../wine.html`, `../beer.html`, `ingredients-supplies.html`) added in the same atomic commit (`7593b78a`) that removes the old catalogue grid; `index.html` hero CTA repointed to `wine.html` in the same commit. |
| T-74-24 | Repudiation | mitigate | `git show 7593b78a -- products/ferment-in-store.html \| grep '^-' \| grep -c landing-copy` = 0; `#landing-copy`/`#landing-copy-detail` present verbatim in current file. |
| T-74-25 | Tampering | mitigate | `index.html` diff: only `href="products/ferment-in-store.html"` → `href="wine.html"` changed; label `Reserve Your Kit` untouched in the diff. |
| T-74-26 | Info Disclosure | mitigate | `beer.html` contains only `#filter-subcategory` and `#filter-abv`; grep for the eight wine-only row ids (`filter-type/brand/manufacturer/time/body/oak/sweetness/sale`) returns zero hits. |
| T-74-27 | Elevation of Privilege | mitigate | `grep -n 'cart-sidebar\|cart-drawer' products/ferment-in-store.html` = zero hits — both removed. |
| T-74-28 | Tampering | mitigate | `js/main.js` contains `matchesKitCategory`, `buildWaitlistCtaLink`, `sortFilterValues`, `buildRecipeCard`, `orderCatalogBlocks`, `initCategoryCatalogPage` (all present, non-zero grep counts); single commit `ed904253` "build(74-06): rebuild production bundles from js/modules/*" is the only phase-74 touch to `main.js`/`main.min.js`; working tree is clean (no uncommitted hand-edits at audit time). |
| T-74-29 | Info Disclosure | mitigate | `wine.html` and `beer.html` both stamp `main.min.js?v=mtj2ny1x` — identical value, proving `wine.html` was included in the `stamp:pages` run that also stamped `beer.html`. |
| T-74-30 | Spoofing/DoS | transfer | `zoho-middleware/server.js`: `app.post('/api/waitlist', waitlistLimiter, ...)` — `waitlistLimiter` is a Redis-backed `rate-limit` instance, `windowMs: 60000, max: 5`, registered inline on the exact route. `setupBeerWaitlistForm()` (js/modules/12-checkout.js:1689) posts only to this pre-existing endpoint; no new endpoint or auth surface introduced. |
| T-74-SC | Tampering (supply chain) | accept | `git log --all -- package.json package-lock.json zoho-middleware/package.json zoho-middleware/package-lock.json` shows the only phase-74 touch to `package.json` (`8516cf13`) is a `stamp:pages` script-string edit, not a dependency change; `package-lock.json` untouched by any phase-74 commit. **Accepted-risk log entry: this file.** |

## Threat Verification — Open (3/34) — BLOCKER

| Threat ID | Category | Mitigation Expected | Why Still Open |
|---|---|---|---|
| T-74-31 | Info Disclosure (staff recipe copy → public page) | D-08 content-pass checkpoint constrains the drafted description (no ingredient/quantity/supplier/cost); re-probe of the live endpoint after the write | **Not yet performed.** 74-06-SUMMARY.md front-matter: `status: PAUSED — blocking checkpoint (Task 4 of 5)`. Live probe during this audit confirms `SV-R-000002`'s `description` is still an empty string on both staging and production — the copy has been drafted and is awaiting owner approval but has not been written to BrewPad. The mitigation (constrained copy + re-probe) cannot be verified because it has not executed. |
| T-74-32 | Elevation of Privilege (accidental draft→active during content pass) | Active-recipe count recorded before the pass must match after | **Not yet performed** — same paused checkpoint. Pre-pass count (1) is recorded in 74-06-SUMMARY.md; there is no post-pass count to compare against because the pass hasn't happened. |
| T-74-33 | Repudiation (shipping on green tests alone) | Blocking browser-based human-verify checkpoint on staging (Task 5) | **Not yet performed.** `git push origin main` (commit `1346e381`) has happened, putting the code on staging, but the 12-point browser verification described in 74-06-SUMMARY.md's "User Setup Required" has not been run. |

All three share one root cause: 74-06 Task 4 (owner content approval + BrewPad write) is a blocking prerequisite for Task 5 (staging browser verification), and neither has completed. This is a single open work item, not three independent code defects.

## Unregistered Flags

None. 74-04, 74-05, 74-06 each carry an explicit `## Threat Flags` section, all stating "None — falls within this plan's own threat register." 74-01, 74-02, 74-03 carry no `## Threat Flags` section at all (per the known gap called out in the task); their Accomplishments/Issues/Deviations sections were read in full as a substitute check and contain no new trust-boundary-crossing behavior beyond what's already registered — the two "noteworthy" items flagged in 74-02 (beer buy-path removal from `ingredients-supplies.html`'s kits tab too, not just `beer.html`) and 74-03 (multi-group heading fallback on data anomaly) are both DOM/UX consequences of already-registered mitigations (T-74-11, T-74-26), not new attack surface.

One related, owner-authorized, out-of-band fix worth recording for completeness: `content/home.json`'s `promo-banner.cta-href` was repointed from `products/ferment-in-store.html` to `wine.html` (commit `9d388293`, 74-06) — this closes the same class of dead-link self-DoS risk as T-74-23 but for the site-wide promo banner rather than the homepage hero CTA. Not a gap; reinforces an already-registered mitigation's intent.

## Accepted Risks Log

The following threats carry disposition `accept`. Logging here per this audit's own verification requirement (accept dispositions must have an entry in this file to close):

- **T-74-07** — Apps Script quota DoS via the new public `/api/recipes` surface. Accepted: 10-minute Redis cache collapses all anonymous traffic onto a single cache key; public load is expected to *reduce* Apps Script calls relative to pre-phase behavior, not increase them.
- **T-74-10** — Category-filter bypass on `GET /api/products` by calling the endpoint directly with no category param. Accepted: this endpoint is and remains fully public/unscoped by design; kit price/stock/tasting-note data carries no sensitivity comparable to recipe cost data, so server-side category enforcement is deliberately out of scope.
- **T-74-15** — Retry-button hammering of the recipe-fetch middleware. Accepted: user-initiated, single-shot per click, and already served from the same 10-minute cache as T-74-07.
- **T-74-SC** — Supply-chain risk from npm/pip/cargo installs. Accepted: zero new packages introduced anywhere in phase 74 (verified via git history of `package.json`/`package-lock.json` across all six plans' commits).

## Deployment Gap (flagged, not a code-mitigation gap)

Production middleware (`svmiddleware-production.up.railway.app`) has not been redeployed since this phase's `74-01` fix merged. As directly confirmed by this audit's live probe, production's `GET /api/recipes?status=active` currently returns `locked_price`, `service_fee`, `materials_fee`, `pricing_mode`, `computed_price`, and `status` to anonymous callers — the exact information-disclosure shape T-74-01/02/04 were written to close. The code fix is correct, tested, and staging-verified; it is simply not live in production yet. This should be treated as a standing production incident until the middleware is redeployed, tracked separately from this phase's threats-closed count since it is an operational/deployment state, not a gap in the merged implementation.

## Next Steps

1. Resolve the D-08 owner checkpoint (74-06 Task 4): approve/edit the drafted Czech Lager blurb, write it to BrewPad, re-probe the live endpoint for forbidden keys, confirm active-recipe count is still 1.
2. Complete 74-06 Task 5: 12-point browser verification on `staging.steinsandvines.ca`.
3. Once 1-2 close T-74-31/32/33, re-run `/gsd:secure-phase` to confirm 34/34 and produce a `SECURED` result.
4. Independently of phase completion: redeploy `zoho-middleware` to production to close the live information-disclosure gap described above — this is a currently-exploitable issue on the production domain and should not wait on the D-08 content pass.

---

**SECURITY.md:** `.planning/phases/74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split/74-SECURITY.md`

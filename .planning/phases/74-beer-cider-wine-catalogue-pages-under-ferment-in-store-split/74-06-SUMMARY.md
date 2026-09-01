---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 06
subsystem: frontend (JS dispatch + build) / content (BrewPad recipe copy)
tags: [dispatch, waitlist, build, D-08, D-09, D-11, tdd]
status: PAUSED — blocking checkpoint (Task 4 of 5)

# Dependency graph
requires: ["74-01", "74-02", "74-03", "74-04", "74-05"]
provides:
  - "initCategoryCatalogPage(page) — module-scope, exported dispatch for /wine and /beer (D-09)"
  - "beer.html waitlist form wired on its own page for the first time (D-11 bug fix)"
  - "rebuilt js/main.js / js/main.min.js containing every js/modules/* change from this phase"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dispatch branch extracted to a testable module-scope function (matches 74-02/74-03's precedent of hoisting logic out of closures for direct unit-testability)"

key-files:
  created:
    - tests/frontend/init-category-page.test.js
  modified:
    - js/modules/13-init.js
    - js/main.js
    - js/main.min.js
    - css/styles.min.css
    - content/home.json
    - wine.html
    - beer.html
    - index.html
    - admin.html
    - brewpad.html
    - kiosk.html
    - about.html
    - contact.html
    - custom-labels.html
    - ingredients.html
    - products.html
    - products/ferment-in-store.html
    - products/additives.html
    - products/equipment.html
    - products/grains.html
    - products/hops.html
    - products/ingredients-supplies.html
    - products/packaging.html
    - products/yeast.html
    - reservation.html
    - js/admin.js
    - js/admin.min.js

decisions:
  - "Gate cleanup: removed 'ferment-in-store' from the line-331 catalogue-loader condition in js/modules/13-init.js, per plan instruction, since plan 74-05's owner decision (remove-both-and-repoint) removed #product-catalog from the hub entirely — the gate would otherwise run loadProducts()/initProductTabs() against a missing container."
  - "content/home.json promo-banner.cta-href repointed from products/ferment-in-store.html to wine.html — owner-authorized scope addition (not in this plan's declared files_modified), matching index.html's hero-cta anchor target and relative-path convention."
  - "zoho-middleware/node_modules restored via `npm ci` from the existing package-lock.json (fresh worktree, gitignored directory absent) — zero new/different packages, same precedent as 74-01-SUMMARY.md."

metrics:
  duration: "~35 min so far (Tasks 1-3 + authorized addition; paused before Task 4 completes)"
  completed: "in progress — 2026-09-01"
---

# Phase 74 Plan 06: Wire /wine and /beer dispatch, fix beer waitlist bug, rebuild bundles — Summary (PAUSED)

**Extracted a testable `initCategoryCatalogPage(page)` dispatch into `js/modules/13-init.js` (TDD RED→GREEN), wiring `/wine` and `/beer` into `loadProducts(page)` and fixing a live shipped bug — `beer.html`'s waitlist form has never posted to `/api/waitlist` because `setupBeerWaitlistForm()` was only reachable from the homepage branch — then ran the single phase-wide `npm run build` and both full test suites green. Execution is PAUSED at Task 4, a `gate="blocking"` `checkpoint:human-action` for the D-08 content pass, which must not be self-approved.**

## Performance

- **Started:** 2026-09-01
- **Tasks completed:** 3 of 5 (plus one owner-authorized scope addition between Task 3 and Task 4)
- **Task 4 (D-08 content pass):** preparation complete, PAUSED awaiting owner review/BrewPad save
- **Task 5 (human-verify checkpoint):** not started — blocked on Task 4

## Accomplishments

### Task 1 (RED): `tests/frontend/init-category-page.test.js`
- New 6-test regression file targeting a not-yet-existing `initCategoryCatalogPage(page)` export. Against pre-Task-2 code, all 6 tests fail with `initCategoryCatalogPage is not a function` — confirmed as the legitimate RED (the capability, and the dispatch branch it represents, simply did not exist).
- Full suite otherwise green at RED time: 90/91 suites, 1223/1229 tests (only this file's 6 tests failing).

### Task 2 (GREEN): `js/modules/13-init.js`
- Added module-scope `initCategoryCatalogPage(page)`: returns `false` immediately unless `page` is `'wine'` or `'beer'`; otherwise calls `loadProducts(page)`, `initReservationBar()`, `initCartDrawer()`, `initMobileBottomControls()`, `initCatalogViewToggle()` — matching the existing line-331 catalogue gate's behaviour for `products`/`ingredients`/`ingredients-supplies`, but deliberately never `initProductTabs()` or `loadIngredients()` since neither `wine.html` nor `beer.html` carries a tabs switcher.
- For `page === 'beer'` only, also calls `setupBeerWaitlistForm()` — the bug fix. `beer.html` has carried `data-page="beer"` and `#beer-waitlist-form` since 2026-08-31 with no reachable dispatch branch; the form was doing a native submit + full-page reload instead of posting to `/api/waitlist`.
- Called from the existing `DOMContentLoaded` handler immediately after the line-331 gate. The homepage's own `setupBeerWaitlistForm()` call (inside `page === 'home'`) is untouched.
- Exported via `module.exports.initCategoryCatalogPage`.
- **Gate cleanup:** removed `'ferment-in-store'` from the line-331 condition (`page === 'products' || page === 'ingredients' || page === 'ferment-in-store' || page === 'ingredients-supplies'` → drops `'ferment-in-store'`), because plan 74-05's owner decision (`remove-both-and-repoint`) deleted `#product-catalog` from the hub outright; confirmed via `grep -c "product-catalog" products/ferment-in-store.html` returning 0 before editing.
- All 6 Task-1 tests GREEN. Full frontend suite: 91/91 suites, 1229/1229 tests. `npm run lint`: clean.

### Task 3: Rebuild + full gates
- `npm run build` (single rebuild for the whole phase — plans 74-02, 74-03 and this plan all touched `js/modules/*`, deliberately deferred until now).
- Verified `js/main.js` contains `matchesKitCategory` (4), `buildWaitlistCtaLink` (5), `sortFilterValues` (3), `buildRecipeCard` (3), `orderCatalogBlocks` (3), `initCategoryCatalogPage` (3); `js/main.min.js` contains all six minified identifiers at least once.
- `js/main.min.js` mtime (12:40:33) postdates both `js/modules/07-catalog-kits.js` (12:37:15) and `js/modules/13-init.js` (12:40:05).
- `wine.html` and `beer.html` both stamp to `main.min.js?v=mtj2ny1x` — confirms `wine.html` (added to `stamp:pages` by plan 74-04) was included in this run.
- Incidental churn accepted per the task's own instruction: `admin.html`/`kiosk.html`/`brewpad.html`/`index.html` and every `stamp:pages` page get new `?v=` values; `js/admin.js` gets a new `BUILD_TIMESTAMP`; `css/styles.min.css` and `js/admin.min.js` regenerated. No file deletions (`git diff --diff-filter=D` empty).
- Gates on the fully merged tree: `npm test` 91/91 suites, 1229/1229 tests; `npm run lint` clean; `cd zoho-middleware && npm test` 102/102 suites, 1524/1524 tests (after restoring `zoho-middleware/node_modules` via `npm ci` — see Deviations).
- `git status --porcelain js/main.js js/main.min.js` empty after the commit.

### Owner-authorized addition: `content/home.json`
- The site-wide promo banner (`enabled: true`, live "20% off your first batch" offer, rendered on every page via `initPromoBanner()`) still pointed its CTA at `products/ferment-in-store.html`, which plan 74-05 just stripped of its buy grid. Changed `promo-banner.cta-href` only, to `wine.html`, matching `index.html`'s hero CTA target and relative-path convention. No other field touched.

## Task Commits

1. **Task 1 (RED):** `123116a0` — `test(74-06): add failing test for unwired beer waitlist form + missing wine/beer dispatch`
2. **Task 2 (GREEN):** `4c904dad` — `fix(74-06): wire /wine and /beer dispatch, fix unwired beer waitlist form`
3. **Task 3 (build):** `ed904253` — `build(74-06): rebuild production bundles from js/modules/*`
4. **Owner-authorized addition:** `9d388293` — `fix(74-06): repoint promo-banner CTA off the now-catalogue-less hub`

_No plan-metadata commit yet — SUMMARY.md is committed as part of this worktree agent's checkpoint-pause commit (parallel-executor convention; STATE.md/ROADMAP.md are owned by the orchestrator, not this agent). This SUMMARY will be amended and re-committed by the continuation agent once Task 4 and Task 5 complete._

## TDD Gate Compliance

- RED commit present: `123116a0` (`test(74-06): ...`)
- GREEN commit present after RED: `4c904dad` (`fix(74-06): ...`)
- No REFACTOR commit — none needed; the GREEN implementation required no follow-up cleanup.

## Files Created/Modified

- `tests/frontend/init-category-page.test.js` (new, 144 lines) — 6 regression tests for `initCategoryCatalogPage`.
- `js/modules/13-init.js` — added `initCategoryCatalogPage(page)`, wired it into the `DOMContentLoaded` dispatch, exported it, removed `'ferment-in-store'` from the line-331 catalogue gate.
- `js/main.js` / `js/main.min.js` — regenerated from `js/modules/*` (contains this plan's change plus 74-02/74-03's accumulated module changes).
- `css/styles.min.css`, `js/admin.js`, `js/admin.min.js` — regenerated build output (CSS minify + admin `BUILD_TIMESTAMP` stamp).
- `wine.html`, `beer.html`, `index.html`, `admin.html`, `brewpad.html`, `kiosk.html`, `about.html`, `contact.html`, `custom-labels.html`, `ingredients.html`, `products.html`, `products/ferment-in-store.html`, `products/additives.html`, `products/equipment.html`, `products/grains.html`, `products/hops.html`, `products/ingredients-supplies.html`, `products/packaging.html`, `products/yeast.html`, `reservation.html` — `?v=` cache-buster stamps rewritten by `stamp`/`stamp:pages`/`stamp:admin`/`stamp:kiosk`/`stamp:brewpad`/`stamp:index`. No content changes beyond the stamps.
- `content/home.json` — `promo-banner.cta-href` repointed (owner-authorized addition, see above).

## Decisions Made

- Removed `'ferment-in-store'` from the line-331 catalogue gate (see Accomplishments — Task 2).
- `content/home.json` promo-banner CTA repointed to `wine.html` (owner-authorized addition).
- `zoho-middleware/node_modules` restored via `npm ci` — a fresh-worktree environment gap, not a code change; zero new/different packages (matches `74-RESEARCH.md`'s "N/A" package-legitimacy finding); same precedent already recorded in `74-01-SUMMARY.md` for this same phase.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking issue] `zoho-middleware/node_modules` absent in this fresh worktree**
- **Found during:** Task 3, running `cd zoho-middleware && npm test`
- **Issue:** `zoho-middleware/node_modules` is gitignored and was never present in this worktree checkout; `npm test` failed immediately on `Cannot find module '@sentry/node'` (89/102 suites erroring on missing deps, not test failures).
- **Fix:** Ran `npm ci` inside `zoho-middleware/` to restore `node_modules` from the existing `package-lock.json`. This installs exactly the locked dependency set — zero new or different packages — and is standard dev-environment setup, not a Rule 3 package-manager-install exclusion (no new/substituted package). Identical situation and identical fix already recorded in this phase's `74-01-SUMMARY.md`.
- **Files modified:** None (node_modules is gitignored, not tracked).
- **Commit:** N/A (no code change; environment restoration only).

None of the other deviation rules (1/2/4) applied in Tasks 1-3 — both matched their `<action>` specs exactly.

## Known Stubs

None introduced by this plan.

## Threat Flags

None. This plan's edits fall within its own `<threat_model>` register (T-74-28 through T-74-33, T-74-SC): no hand-edited build artifact (both `js/main.js`/`js/main.min.js` regenerated only via `npm run build`, verified to contain the six new identifiers and postdate their sources), `stamp:pages` confirmed to include `wine.html`, the beer waitlist POST target (`/api/waitlist`) is pre-existing and already rate-limited (no new endpoint/auth surface), and Task 4 (not yet resolved) is the D-08 content-leak mitigation itself.

## D-08 Content Pass — Preparation (Task 4, PAUSED)

Live active-recipe audit run 2026-09-01 against production:

```
curl -s "https://svmiddleware-production.up.railway.app/api/recipes?status=active"
```

Returned exactly **ONE** active recipe:

| recipe_id | name | style | current description |
|---|---|---|---|
| SV-R-000002 | Czech Lager | Czech Lager | *(empty string)* |

**Note on the raw response:** the live production endpoint currently returns the full staff record shape (`locked_price`, `service_fee`, `materials_fee`, `pricing_mode`, `status`, `computed_price`, `ingredient_count`, etc.) — this is expected and NOT a regression: plan 74-01's public field-allowlist guard has been merged in this worktree but has not yet been deployed anywhere (staging or production). Task 5's `git push origin main` is the step that will put the guard live on staging; the re-verification of the forbidden-key list happens after that push, not during this preparation step.

**Proposed public blurb for owner review** (constraints: describes taste + who it suits; names no ingredient, quantity, supplier or cost; states no price; no placeholder text; matches the plain, concrete voice of `beer.html`'s "What It Is"/"What's Included" sections):

> **Czech Lager (SV-R-000002):** "A classic Czech-style lager — crisp and golden with a clean malt backbone and a firm, balancing bitterness. A great pick if you like a proper pilsner: refreshing, easy to drink, and not overly hoppy or heavy."

**Awaiting:** owner approval, edit, or replacement of the above blurb. Once approved, the developer signs into BrewPad, opens SV-R-000002 in the recipe editor, sets `recipe-description` to the final text, and saves (busts `bustRecipeCache()` automatically). The continuation agent will re-run the same curl to confirm the active-recipe count is still 1 and the `description` is non-empty, then proceed to Task 5.

**No write was made to BrewPad and no POST was sent to any recipe endpoint** — per the plan's explicit instruction, the copy is an owner decision and the write is a staff action against live production data.

## User Setup Required

- **Task 4 (blocking):** owner must approve/edit the draft blurb above, then a developer with BrewPad access must sign in, open SV-R-000002, set the description, and save.
- **Task 5 (blocking, not yet reached):** after Task 4 resolves, `git push origin main` to staging and a 12-point browser verification on `staging.steinsandvines.ca`.

## Next Phase Readiness

Not applicable — this is the final plan of Phase 74, and it is not yet complete. The continuation agent resumes at Task 4's resume-signal, re-runs the post-save verification curl, records the approved blurb id, then proceeds to Task 5 (push to staging + human browser verification), and only then updates this SUMMARY to its final COMPLETE state.

## Self-Check: PASSED

- FOUND: `tests/frontend/init-category-page.test.js`
- FOUND: `js/modules/13-init.js` (modified)
- FOUND: `js/main.js`, `js/main.min.js` (regenerated)
- FOUND: `content/home.json` (modified)
- FOUND commit: `123116a0` (test — Task 1 RED)
- FOUND commit: `4c904dad` (fix — Task 2 GREEN)
- FOUND commit: `ed904253` (build — Task 3)
- FOUND commit: `9d388293` (fix — owner-authorized addition)

---
*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Plan: 06*
*Status: PAUSED at Task 4 (blocking checkpoint) — 2026-09-01*

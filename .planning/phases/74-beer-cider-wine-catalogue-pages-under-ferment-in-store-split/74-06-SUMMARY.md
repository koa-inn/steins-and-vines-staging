---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 06
subsystem: frontend (JS dispatch + build) / content (BrewPad recipe copy)
tags: [dispatch, waitlist, build, D-08, D-09, D-11, tdd]
status: IN_PROGRESS — Task 4 closed, Task 5 awaiting owner browser verification

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
  duration: "~35 min (Tasks 1-3 + authorized addition) + Task 4 closure by continuation agent; Task 5 browser verification still outstanding"
  completed: "Tasks 1-4 complete 2026-09-01; Task 5 in progress — 2026-09-01"
---

# Phase 74 Plan 06: Wire /wine and /beer dispatch, fix beer waitlist bug, rebuild bundles — Summary

**Extracted a testable `initCategoryCatalogPage(page)` dispatch into `js/modules/13-init.js` (TDD RED→GREEN), wiring `/wine` and `/beer` into `loadProducts(page)` and fixing a live shipped bug — `beer.html`'s waitlist form has never posted to `/api/waitlist` because `setupBeerWaitlistForm()` was only reachable from the homepage branch — then ran the single phase-wide `npm run build` and both full test suites green. Task 4 (D-08 content pass) is now closed: the owner approved and saved the Czech Lager blurb in BrewPad, confirmed live via unauthenticated probe. Task 5 (staging push + 12-point browser verification) has had its staging push completed by the orchestrator; the browser verification itself is returned to the owner as a `human-verify` checkpoint below.**

## Performance

- **Started:** 2026-09-01
- **Tasks completed:** 4 of 5 (Tasks 1-4, plus one owner-authorized scope addition between Task 3 and Task 4)
- **Task 4 (D-08 content pass):** CLOSED — owner approved and saved the blurb, verified live on staging and production
- **Task 5 (human-verify checkpoint):** staging push done (`git push origin main`, commit `1346e381`); 12-point browser checklist prepared and returned to owner, awaiting response

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

## D-08 Content Pass — CLOSED (Task 4)

Owner approved the drafted blurb as-is and saved it in BrewPad against `SV-R-000002`. Verified independently by this continuation agent via direct unauthenticated probe (not taken on faith from the checkpoint-resolution note):

```
curl -s "https://svmiddleware-production.up.railway.app/api/recipes?status=active"
curl -s "https://svmiddleware-staging.up.railway.app/api/recipes?status=active"
```

| Check | Result |
|---|---|
| Active-recipe count, production | `recipes` array length 1 (unchanged from pre-pass count of 1) — **T-74-32 satisfied**, nothing was accidentally switched draft→active |
| `SV-R-000002` `description`, production | 208 characters, verbatim the approved text: "A classic Czech-style lager — crisp and golden with a clean malt backbone and a firm, balancing bitterness. A great pick if you like a proper pilsner: refreshing, easy to drink, and not overly hoppy or heavy." |
| Copy content check | No ingredient, quantity, supplier, cost, or price detail present — matches the D-07/UI-SPEC copywriting contract |
| Staging response shape | `{"recipe_id","name","style","description","price","price_from"}` only — the clean six-field public allowlist, description populated, `total:1` |
| Production response shape | Still includes `status`, `locked_price`, `service_fee`, `materials_fee`, `pricing_mode`, `computed_price`, `ingredient_count` alongside the correct description |

**T-74-31 status — split finding, recorded honestly rather than glossed:**
- The **content-pass half** (D-08: every active recipe has an owner-approved, public-facing description containing no forbidden detail) is **satisfied** — confirmed above on both staging and production.
- The **response-projection half** (the unauthenticated endpoint must emit *only* the public allowlist, with none of `ingredients`/`locked_price`/`service_fee`/`materials_fee`/`computed_price`/`pricing_mode`/`status`) is **satisfied on staging** (74-01's guard is merged and live there) but **NOT satisfied on production**, because production has not been redeployed since 74-01 merged. This is a **deployment gap**, not a defect introduced by this plan or this content pass — the same gap 74-SECURITY.md already flagged independently under "Deployment Gap." T-74-31 cannot be marked fully closed against production until a middleware redeploy happens; that redeploy is outside this plan's and this agent's authority (owner/deploy decision, no push performed by this agent).

Task 4's own acceptance criteria (all copy-side, none deployment-side) are met:
- [x] Every active recipe has a non-empty, public-facing description
- [x] Active-recipe count after the pass equals the count recorded before the pass (1 = 1)
- [x] The approved blurb is recorded here with its recipe id

## D-08 Content Pass — Preparation (Task 4, PAUSED) — historical, superseded by the CLOSED section above

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

## Task 5 — Staging Push + 12-Point Browser Verification

**Staging push status:** already done by the orchestrator (`git push origin main`), staging is at commit `1346e381` plus the later `530d887f` docs-only commit. No push was performed by this agent, and no push to `production` was performed or will be performed by this agent — that remains the owner's explicit call per CLAUDE.md's deployment rules.

**What remains:** the browser verification itself, which requires a human in a real browser (not `curl` — production and staging both sit in front of Cloudflare/App infrastructure that has previously produced misleading CLI-probe conclusions, per STATE.md's recorded anti-pattern). This is returned below as a `human-verify` checkpoint. See the CHECKPOINT REACHED block in this agent's final response for the full 12-point checklist, plus two items carried forward from earlier plans for explicit owner acceptance (beer-kit "Join the Waitlist" going site-wide onto `products/ingredients-supplies.html`'s kits tab, and `.product-grid--compact` applying to both the kit and recipe grids on `/wine` and `/beer`).

## User Setup Required

- **Task 4:** CLOSED — owner already approved and saved the blurb; no further action.
- **Task 5 (blocking, awaiting response):** owner (or a delegate) opens `staging.steinsandvines.ca` in a real browser and works through the 12-point checklist in the CHECKPOINT REACHED block, then replies "approved" or lists the gaps found.

## Next Phase Readiness

This is the final plan of Phase 74. Tasks 1-4 are complete and committed. Task 5's mechanical half (staging push) is done; its human half (browser verification) is outstanding and is the only remaining work in the phase. Once the owner returns "approved" (or a gap list) for Task 5, a final continuation agent should: record the verification outcome in this SUMMARY, flip `status` to `COMPLETE`, and hand off to the orchestrator for the STATE.md/ROADMAP.md/REQUIREMENTS.md updates and phase closure — none of which this agent performs (explicitly out of scope per this agent's instructions).

## Self-Check: PASSED

- FOUND: `tests/frontend/init-category-page.test.js`
- FOUND: `js/modules/13-init.js` (modified)
- FOUND: `js/main.js`, `js/main.min.js` (regenerated)
- FOUND: `content/home.json` (modified)
- FOUND commit: `123116a0` (test — Task 1 RED)
- FOUND commit: `4c904dad` (fix — Task 2 GREEN)
- FOUND commit: `ed904253` (build — Task 3)
- FOUND commit: `9d388293` (fix — owner-authorized addition)
- FOUND: BrewPad-saved description live on staging AND production, verified via independent curl by this continuation agent (208 chars, exact approved text)
- FOUND: active-recipe count unchanged at 1 (pre-pass and post-pass)

---
*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Plan: 06*
*Status: Task 4 CLOSED, Task 5 awaiting owner browser verification — 2026-09-01*

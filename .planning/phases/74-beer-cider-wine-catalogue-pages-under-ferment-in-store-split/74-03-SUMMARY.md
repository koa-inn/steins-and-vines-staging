---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 03
subsystem: ui
tags: [catalog, recipes, dual-block, es5, jest, public-read]

# Dependency graph
requires: ["74-01", "74-02", "74-04"]
provides:
  - "buildRecipeCard(recipe, doc) / recipeDisplayPrice(recipe) — module-scope, testable recipe card builder (D-07)"
  - "fetchActiveRecipes(categoryFilter, middlewareUrl) — public GET /api/recipes?status=active, beer-only routing, always resolves"
  - "renderRecipeBlock(result, showSubCopy, categoryFilter, middlewareUrl, doc) — zero-item suppression (D-04), scoped error/retry"
  - "orderCatalogBlocks(kitCount, recipeCount) — pure D-03 tie-break helper, kits lead on a tie"
  - "Single-paint dual-block commit inside loadProducts: recipePromise starts alongside the kit fetch, both blocks paint together"
affects: [74-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Recipe fetch/render pair kept at module scope (not closure-nested inside loadProducts) with explicit categoryFilter/middlewareUrl parameters, so both are directly unit-testable without invoking the full loadProducts async chain — mirrors 74-02's pattern for buildWaitlistCtaLink/sortFilterValues"
    - "getAvailable() hoisted out of renderCatalog to loadProducts's closure scope so the dual-block ordering join can compute the in-stock kit count with the exact same rule renderCatalog itself uses"
    - "A closure variable (_kitSubCopy) set once inside the async join, read by renderCatalog/renderSection on their next call — avoids threading an extra parameter through the whole applyFilters()->renderCatalog() call chain for a value only known after both fetches settle"

key-files:
  created: []
  modified:
    - js/modules/07-catalog-kits.js
    - tests/frontend/catalog-recipe-block.test.js

key-decisions:
  - "Recipes are routed to /beer only via a fixed _categoryFilter === 'beer' check, never style-keyword inference — recipes carry no category field anywhere in the data (RESEARCH Pitfall 2). If a wine recipe is ever created it will need an explicit category field on the record, not a heuristic added to this module."
  - "A failed recipe fetch is treated as recipeCount === 0 for BOTH the D-03 block-ordering tie-break AND the D-02 kit/recipe sub-copy differentiation boolean — kept as one 'effectiveRecipeCount' value rather than two divergent rules, since an error box is not a second content block worth differentiating against."
  - "fetchActiveRecipes/renderRecipeBlock were designed as parameterized module-scope functions rather than closures nested inside loadProducts (as the plan's prose literally suggested) — this makes them directly unit-testable and was necessary to satisfy the plan's own 'jsdom-backed assertions with a container' test requirements."
  - "Deviation (Rule 2): wired .product-grid--compact onto the kit grid's grid <div> whenever a group has <=3 cards, inside renderSection. Not explicit in 74-03-PLAN.md's task text, but 74-PATTERNS.md (Sec 'product-grid--compact application') explicitly assigns this wiring to renderSection's output, and 74-05-PLAN.md confirms it does not touch js/modules/* — this plan is the only remaining owner of the single-card-grid-stretch fix UI-SPEC Sec2 calls 'the single most visually fragile state in the phase.'"

requirements-completed: [D-01, D-02, D-03, D-04, D-05, D-07]

# Metrics
duration: 35min
completed: 2026-09-01
---

# Phase 74 Plan 03: Public Recipe Block and Dual-Block Catalogue Ordering Summary

**Built the first public surface for recipes anywhere on the site — `buildRecipeCard`/`fetchActiveRecipes`/`renderRecipeBlock` consume plan 74-01's public read contract and render a plain `.product-card` idiom recipe block, ordered against the kit block by an explicit `orderCatalogBlocks(kitCount, recipeCount)` comparison that commits both blocks in a single paint.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-01
- **Tasks:** 3 completed
- **Files modified:** 2 (`js/modules/07-catalog-kits.js`, `tests/frontend/catalog-recipe-block.test.js`)

## Accomplishments

- `buildRecipeCard(recipe, doc)`/`recipeDisplayPrice(recipe)` build a recipe card entirely with `createElement`/`textContent` (zero `innerHTML`), reading only the public payload's six-field allowlist (`recipe_id`/`name`/`style`/`description`/`price`/`price_from`); field order is exactly name -> style -> price -> blurb -> "Join the Waitlist" CTA, per UI-SPEC's LOCKED anatomy.
- `fetchActiveRecipes(categoryFilter, middlewareUrl)` hits the public `GET /api/recipes?status=active` endpoint with no auth header, always resolves (never rejects), and routes recipes to the beer page only — wine's fetch resolves synchronously-empty since recipes carry no category field.
- `renderRecipeBlock(result, showSubCopy, categoryFilter, middlewareUrl, doc)` implements D-04's absolute zero-item suppression (early return, no DOM at all) and a per-block error/retry that never touches `#product-catalog`, scoped entirely to `#recipe-catalog`.
- `orderCatalogBlocks(kitCount, recipeCount)` is a pure, explicit comparison (`kitCount >= recipeCount`) — kits lead the /beer launch's exact 1-kit/1-recipe tie, matching UI-SPEC's LOCKED tie-break.
- Inside `loadProducts`, `recipePromise` starts alongside the kit data fetch (not after it); once both settle, a single join computes counts, reorders `#catalog-blocks` via `insertBefore` only when recipes outrank kits, sets the D-02 kit/recipe sub-copy (only when both blocks render), and paints both blocks before the first `applyFilters()` call — no reflow-on-arrival for either block.
- `renderCatalog` now derives its kit heading from `_categoryFilter` ("Wine Kits"/"Beer Kits"/unchanged "Currently available" for every existing unscoped caller), and `renderSection` suppresses the redundant inner `.product-group-title` heading when a category filter is active with exactly one group (avoids "Wine Kits" immediately followed by "Wine").

## Task Commits

Each task was committed atomically:

1. **Task 1: Recipe card builder and price label (D-07)** — `073d5f22` (feat)
2. **Task 2: Fetch active recipes and render the recipe block with per-block error isolation (D-05)** — `23597d03` (feat)
3. **Task 3: Dual-block ordering, category kit headings, and single-paint commit (D-01/D-02/D-03)** — `318c6cd8` (feat)

_No plan-metadata commit — SUMMARY.md is committed as part of this worktree agent's final commit (parallel-executor convention; STATE.md/ROADMAP.md are owned by the orchestrator, not this agent)._

## Files Created/Modified

- `js/modules/07-catalog-kits.js` — Added module-scope `recipeDisplayPrice`, `buildRecipeCard`, `fetchActiveRecipes`, `renderRecipeBlock`, `orderCatalogBlocks`; hoisted `getAvailable` out of `renderCatalog` to loadProducts's closure scope; `renderCatalog` derives a category-aware kit heading and passes a `_kitSubCopy` closure value through to `renderSection`; `renderSection` gained a trailing `subCopy` param, suppresses its inner group heading on a single-group category page, and applies `.product-grid--compact` per-group at <=3 cards; `loadProducts` starts `recipePromise` alongside its kit data fetch and joins both before the first paint; `module.exports` extended to `recipeDisplayPrice`, `buildRecipeCard`, `fetchActiveRecipes`, `renderRecipeBlock`, `orderCatalogBlocks`.
- `tests/frontend/catalog-recipe-block.test.js` (new, 316 lines) — 61 tests: `recipeDisplayPrice`/`buildRecipeCard` field-allowlist and DOM-shape coverage (Task 1), `fetchActiveRecipes`/`renderRecipeBlock` fetch-routing, zero-item suppression, per-block error isolation, and compact-grid threshold coverage (Task 2), `orderCatalogBlocks` tie-break coverage (Task 3).

## Decisions Made

- Recipes route to `/beer` only via a fixed `categoryFilter === 'beer'` check — never style-keyword inference on `recipe.style` — because the Recipes sheet carries no category column at all (confirmed by 74-RESEARCH.md Pitfall 2, re-verified against 74-01's `PublicRecipe` shape, which has no category field either). This is a **locked design decision**: if a wine (or cider) recipe is ever created, it will need an explicit category field added to the underlying record — a heuristic must not be added to this module to route it.
- `fetchActiveRecipes`/`renderRecipeBlock` were implemented as **parameterized module-scope functions**, not closures nested inside `loadProducts` as the plan's prose literally described ("Inside loadProducts's closure, add..."). This was necessary because the plan's own Task 2 acceptance criteria required direct jsdom-backed unit tests ("a container plus a zero-length recipe list yields innerHTML===''"), which is only possible if the functions are exposed and don't depend on loadProducts's internal closure state. Both now take `categoryFilter`/`middlewareUrl` as explicit parameters instead of reading them from an enclosing scope — matching the existing pattern established by `buildWaitlistCtaLink`/`sortFilterValues` in 74-02.
- A failed recipe fetch is treated as `recipeCount === 0` for both D-03 (block ordering) and D-02 (kit/recipe sub-copy differentiation) — one `effectiveRecipeCount`/`bothBlocksRender` computation drives both, rather than two independently-reasoned rules, since an inline error box isn't a second content block worth visually differentiating against.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Wired `.product-grid--compact` onto the kit grid**
- **Found during:** Task 3
- **Issue:** 74-03-PLAN.md's task text never explicitly instructs wiring `.product-grid--compact` onto the *kit* grid (only the recipe grid, in Task 2). However `74-PATTERNS.md` (section "`.product-grid--compact` application (UI-SPEC Sec2)") explicitly states the modifier must be "applied to the grid `<div>` inside `renderSection`'s output whenever `items.length <= 3`" — i.e. the kit grid, which only this plan's `renderSection` edit touches. `74-05-PLAN.md` (the plan that builds `beer.html`'s markup) explicitly states "Do NOT edit `js/modules/*` in this plan," confirming no other plan in this phase owns this wiring. Without it, UI-SPEC Sec2's "single most visually fragile state in the phase" (a 1-card kit grid stretching to ~900px wide) would ship unfixed on `/beer`'s 1-kit launch state and `/wine`'s Wine Kits block whenever a style group drops to <=3 items.
- **Fix:** In `renderSection`'s grid-view branch, `grid.className` now appends `' product-grid--compact'` whenever `groups[type].length <= 3`, mirroring the identical rule already applied to the recipe grid in `renderRecipeBlock` (Task 2).
- **Files modified:** `js/modules/07-catalog-kits.js`
- **Commit:** `318c6cd8`

None of the other two tasks required deviations — both matched their `<action>` specs exactly, with all acceptance-criteria greps and behaviour assertions verified inline during execution.

## Issues Encountered

None. One noteworthy design consequence worth flagging for the 74-06 checkpoint: because `renderSection`'s inner `.product-group-title` heading is now suppressed whenever a category filter is active AND there is exactly one group (the normal case for `/wine` and `/beer`, both single-type pages), a category page that somehow ends up with more than one distinct `type` value among its in-stock kits (e.g. a future "Cider" item leaking into `/beer`'s scoped fetch via a data error) would silently show the inner group headings again — this is the intended fallback (multi-group behavior is untouched), not a bug, but flagging since it's a behavior change contingent on live data shape.

## User Setup Required

None — no external service configuration required. This is a pure frontend module change; no environment variables, no new dependencies.

## Next Phase Readiness

- `/beer`'s two-block layout (Beer Kits + Beer Recipes, ordered by the launch 1/1 tie with kits leading) is fully wired end-to-end pending plan 74-05's `beer.html` markup insertion (which supplies `#catalog-blocks`/`#recipe-catalog` in the DOM) and plan 74-06's `13-init.js` dispatch + rebuild.
- `/wine` renders "Wine Kits" alone — its recipe fetch resolves `{ok:true, recipes:[]}` synchronously (beer-only routing), so D-04 suppresses the recipe block cleanly with zero heading/wrapper/placeholder, exactly as UI-SPEC Sec 1 requires.
- No build artifacts were touched (`js/main.js`/`js/main.min.js`/`css/styles.css` all untouched, per plan instruction) — the single rebuild is owned by plan 74-06 after all module edits land.
- The `.product-grid--compact` kit-grid wiring (see Deviations) should be specifically re-verified visually at the 74-06 human-verify checkpoint, since it's the one piece of this plan not explicitly spec'd in 74-03-PLAN.md's own task text.

## Self-Check: PASSED

- FOUND: `js/modules/07-catalog-kits.js`
- FOUND: `tests/frontend/catalog-recipe-block.test.js`
- FOUND commit: `073d5f22` (feat — Task 1)
- FOUND commit: `23597d03` (feat — Task 2)
- FOUND commit: `318c6cd8` (feat — Task 3)

---
*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Plan: 03*
*Completed: 2026-09-01*

---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 02
subsystem: ui
tags: [catalog, filters, kits, es5, jest]

# Dependency graph
requires: []
provides:
  - "loadProducts(categoryFilter) — kit array scoped to one KIT_CATEGORIES value, or all when omitted"
  - "matchesKitCategory(obj, categoryFilter) — module-scope, testable category predicate"
  - "buildWaitlistCtaLink(doc) — module-scope waitlist CTA node builder, used by buildBeerCard"
  - "sortFilterValues(field, values, categoryFilter) — module-scope pure sort function for filter chip ordering, including new numeric abv sort"
  - "abv registered as a first-class filterable field (activeFilters/matchesFilters/updateFilterAvailability/applyFilters)"
  - "per-category filter-row call list: beer builds Style+ABV only; wine/unscoped keeps the existing eight rows + sale filter"
affects: [74-03, 74-05, 74-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hoist duplicated inline filter logic to a pure module-scope helper, keep it callable from a closure-nested function (buildFilterRow calls sortFilterValues; both filter call sites call matchesKitCategory)"
    - "New card-action builders take an optional doc param defaulting to the global document, so they're unit-testable with a plain object stand-in instead of full jsdom"

key-files:
  created:
    - tests/frontend/catalog-category-scope.test.js
  modified:
    - js/modules/07-catalog-kits.js

key-decisions:
  - "buildBeerCard's cart-control tail was deleted outright (not hidden with CSS) — no product-reserve-wrap node exists for a DOM edit to re-enable (T-74-11 mitigation)"
  - "buildWaitlistCtaLink's href branches on document.body[data-page=beer] rather than the page URL, so the same builder works both in-page (#waitlist) and from any other surface that still renders a beer kit card (beer.html#waitlist)"
  - "sortFilterValues gates the wine styleOrder on categoryFilter !== 'beer' rather than adding a beer-specific order array — beer styles (IPA/Lager/Stout) fall through to plain alphabetical sort per UI-SPEC's explicit recommendation"

patterns-established:
  - "sortFilterValues(field, values, categoryFilter) is a pure, side-effect-free helper — safe to unit test without any DOM/document stub"

requirements-completed: [D-01, D-09, D-12, D-13]

# Metrics
duration: 7min
completed: 2026-09-01
---

# Phase 74 Plan 02: Category-Aware Kit Catalogue Summary

**`loadProducts(categoryFilter)` scopes the shared kit array to wine or beer, `buildBeerCard()` swaps its Reserve/Buy Kit cart controls for a single "Join the Waitlist" link, and a new `sortFilterValues` helper drives per-category filter rows including a net-new numeric ABV field.**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-09-01T17:51:40Z
- **Completed:** 2026-09-01T17:58:28Z
- **Tasks:** 3 completed
- **Files modified:** 2 (`js/modules/07-catalog-kits.js`, `tests/frontend/catalog-category-scope.test.js`)

## Accomplishments
- `loadProducts(categoryFilter)` now scopes the shared kit array to a single `KIT_CATEGORIES` value via a new module-scope `matchesKitCategory(obj, categoryFilter)` helper; a bare `loadProducts()` call is fully backward-compatible (all four kit categories, as before), so `products.html` and `products/ingredients-supplies.html` need zero changes.
- `buildBeerCard()`'s action tail (Reserve + Buy Kit cart controls) is replaced with a single `buildWaitlistCtaLink()` call, closing D-12: beer kits render exactly one "Join the Waitlist" link and have no reachable cart path anywhere they render, including `products/ingredients-supplies.html`'s kits tab.
- `buildWineCard()`'s tail is byte-for-byte untouched — wine's 238 live kits keep Reserve + Buy Kit exactly as today (verified via a zero-diff grep on `buildWineCard` across the whole plan).
- Filter-row building is now per-category: beer renders Style + ABV only (no Brand/Producer/Time/Body/Oak/Sweetness/Sale); wine and every existing unscoped page keeps its original eight rows plus the sale filter. ABV values sort numerically ascending (tolerating a trailing `%`), and beer's Style values no longer inherit wine's red/white/rosé/fruit/specialty ordering — they fall through to plain alphabetical sort.

## Task Commits

Each task was committed atomically:

1. **Task 1: Category-scope loadProducts via a testable module-scope helper** - `383622db` (feat)
2. **Task 2: Replace the beer card's cart controls with the waitlist CTA (D-12)** - `e7cdafb0` (feat)
3. **Task 3: Per-category filter row sets, including the net-new ABV field (D-13)** - `ed1c687a` (feat)

_No plan-metadata commit — SUMMARY.md is committed as part of this worktree agent's final commit (parallel-executor convention; STATE.md/ROADMAP.md are owned by the orchestrator, not this agent)._

## Files Created/Modified
- `js/modules/07-catalog-kits.js` - Added module-scope `matchesKitCategory`, `buildWaitlistCtaLink`, `sortFilterValues`; `loadProducts` takes an optional `categoryFilter`; `buildBeerCard`'s cart-control tail replaced with the waitlist CTA; `abv` registered as a filterable field end-to-end; filter-row call list branches on category; `module.exports` extended to `flattenCustomFields`, `matchesKitCategory`, `buildWaitlistCtaLink`, `sortFilterValues`.
- `tests/frontend/catalog-category-scope.test.js` (new, 184 lines) - Regression coverage for all three new helpers: category scoping (including `_zoho_category` fallback, empty-category, unknown-filter-value, missing-obj cases), the waitlist CTA node shape (class, text, href branching, no `product-reserve-wrap`), and filter-value sort order for `abv`/`subcategory` (wine vs beer)/`body`/`sweetness`/`time`, plus a non-mutation check.

## Decisions Made
- Wired `abv` into `matchesFilters`, `updateFilterAvailability`, and `applyFilters` following the exact existing per-field pattern (guard clause shape identical to `sweetness`'s), so it's inert everywhere `abv` isn't rendered (wine/hub/ingredients pages) and active once `beer.html` supplies a `#filter-abv` container in plan 74-05.
- Extracted `sortFilterValues` as a fully pure function (no `allProducts`/`_categoryFilter` closure reads) so it and its five branches are directly unit-testable without any DOM stub, matching the plan's explicit "pure function" instruction.

## Deviations from Plan

None - plan executed exactly as written. All three tasks match their `<action>` specs; all acceptance-criteria greps verified inline during execution (see below) before each commit.

## Issues Encountered

None. One noteworthy consequence, already flagged by the plan itself and repeated here for the record: `buildBeerCard` is the only beer kit card builder in this module, so removing its cart-control tail also removes the beer "buy" path from `products/ingredients-supplies.html`'s kits tab, not just `beer.html`. This is the intended, uniform D-12 behavior (no per-page conditional was added) — flagged for the 74-06 human-verify checkpoint as instructed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `loadProducts('wine')` / `loadProducts('beer')` and the per-category filter-row branch are ready for plan 74-05's `wine.html`/`beer.html` markup (which must supply `#filter-subcategory` and `#filter-abv` containers on the beer page for the new ABV row to render).
- `buildWaitlistCtaLink` and `sortFilterValues` are exported and available for plan 74-03's recipe-card work if needed.
- No build artifacts were touched (`js/main.js`/`js/main.min.js` untouched, per plan instruction — the single rebuild is owned by plan 74-06 after all module edits land).
- The beer-kit-loses-its-buy-path-everywhere consequence (see Issues Encountered) needs owner sign-off at the 74-06 checkpoint before this ships past staging.

---
*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Completed: 2026-09-01*

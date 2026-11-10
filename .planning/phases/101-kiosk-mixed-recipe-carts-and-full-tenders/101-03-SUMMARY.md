---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 03
subsystem: middleware
tags: [recipe, pricing, tax, refactor, kiosk]
requires: ["101-01"]
provides:
  - "zoho-middleware/lib/recipe-sale-lines.js: shared recipe pricing/line/tax helpers"
  - "recipeTaxGroups un-rounded per-rate tax collector (entity_level merge with product tax)"
affects: [101-06, 101-07]
key-files:
  created:
    - zoho-middleware/lib/recipe-sale-lines.js
    - zoho-middleware/__tests__/recipe-sale-lines.test.js
  modified:
    - zoho-middleware/routes/pos-recipe.js
key-decisions:
  - "loadDiscountPreset moved too (priceRecipe needs it) and is exported"
  - "recipeTaxGroups also carries catalogSource 'stale' so computeRecipeTax output is unchanged"
requirements-completed: [MIXR-02]
duration: 15min
completed: 2026-11-10
---

# Phase 101 Plan 03: recipe-sale-lines extraction Summary

Recipe pricing, unit conversion, discount, line building, reconcile and tax helpers now live in `lib/recipe-sale-lines.js`; `routes/pos-recipe.js` aliases them so call sites are untouched, and `computeRecipeTax` wraps a new un-rounded `recipeTaxGroups` collector.

## Tasks

1. Verbatim move of helpers (commit cb7c1a16). No existing tests edited; Plan 01 oracle and all recipe tests green.
2. recipeTaxGroups + lib unit tests (commit 456c1a0a): tax groups, per-group rounding equivalence, fail-closed missing-fee error, stale flag, re-export identity.

Verification: middleware 304 suites / 4160 tests, frontend 3479 tests, lint clean.

## Deviations from Plan

None - plan executed as written. Tests use hand-built line items with the Plan 01 fixture catalog rather than oracle cases (the oracle stays pinned via the existing characterization test).

## Known Stubs

None.

## Self-Check: PASSED

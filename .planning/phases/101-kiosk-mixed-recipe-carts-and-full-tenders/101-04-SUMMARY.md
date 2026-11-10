---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 04
subsystem: middleware
tags: [recipe, pricing, stock, discount, kiosk, tdd]
requires: ["101-03"]
provides:
  - "Mixed-cart recipe helpers in lib/recipe-sale-lines.js"
affects: [101-05, 101-06, 101-07]
key-files:
  modified:
    - zoho-middleware/lib/recipe-sale-lines.js
  created:
    - zoho-middleware/__tests__/recipe-sale-lines-mixed.test.js
key-decisions:
  - "priceRecipe gained an optional 7th param preloadedCatalog; no-arg path unchanged"
  - "Recipe data is JSON-cloned per entry because priceRecipe stamps _scale_factor on the recipe object (same recipe twice would share state)"
  - "Combined-stock conflict unit is the catalog item unit (needed is converted to it); non-convertible lines report raw qty + line unit"
requirements-completed: [MIXR-02, MIXR-03, MIXR-05, MIXR-06]
duration: 20min
completed: 2026-11-10
---

# Phase 101 Plan 04: Mixed-cart recipe helpers Summary

Added validateRecipeEntries, priceRecipeEntries, checkCombinedStock, recipeDiscountBase, applyRecipeDiscount, recipeAdjustment, recipeEntryLabels, recipeNotesSummary and MAX_RECIPE_ENTRIES (25) to `lib/recipe-sale-lines.js`. A 38-case parity loop proves a one-recipe cart reproduces the Plan 01 oracle charge, lines, adjustment and tax exactly.

## Task commit

Tasks 1 and 2 were committed together (c8aaa4f7), as the plan's commit rule requires (tests + implementation, never a failing-test commit). 51 new tests; middleware 305 suites / 4211 tests, frontend 3479 tests, lint clean; characterization oracle untouched and green.

## Deviations from Plan

- `priceRecipeEntries(entries)` takes no `kioskCatalogMap` argument: fee-tax resolution stays in `getFeeCatalogMap` (inside priceRecipe's tax step, which runs once per entry against the cached kiosk catalog and is discarded). This is one extra cached resolution per entry, no Zoho calls.
- Oracle parity compares charge, lines, adjustment, tax and payment_amount, not `initiate.total_before_tax`: the oracle records a legacy value of 33.66 for `RCP-LOCKED/take-out/cart-fixed` that is not the pre-tax total (charge 188.55 is consistent with 187.5 + 1.05). Flagged for review, oracle not touched.

## Known Stubs

None.

## Self-Check: PASSED

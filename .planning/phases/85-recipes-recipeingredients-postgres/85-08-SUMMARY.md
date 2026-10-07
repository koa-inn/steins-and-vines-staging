---
phase: 85-recipes-recipeingredients-postgres
plan: 08
subsystem: payments
tags: [postgres, recipes, kiosk, money-path, dual-write, es5]
requires:
  - phase: 85-05
    provides: "recipe-mirror isDirty"
  - phase: 85-06
    provides: "recipe-store get/getFromSheet/getMode"
provides:
  - "pos-recipe.js loadRecipe/priceRecipe seam over recipe-store"
  - "D-05 live dual price compare (scheduleDualPriceCompare) with settle/dirty skip gate, counters, stuck-dirty Sentry alert"
affects: [85-13, 85-14]
key-files:
  modified:
    - zoho-middleware/routes/pos-recipe.js
  created:
    - zoho-middleware/__tests__/pos-recipe-store.test.js
    - zoho-middleware/__tests__/recipe-dual-price.test.js
key-decisions:
  - "Compare is scheduled from settled outcome handlers and never chained onto the route promise (D-06)"
  - "/confirm re-prices a JSON clone of the Postgres data for the compare; the inline charge computation is untouched"
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 08: Kiosk recipe money path on the store seam + D-05 price check Summary

Kiosk quote, sale and post-charge confirm now load recipes through `recipeStore.get`, with the pricing body moved verbatim into `priceRecipe`; in production dual mode every quote/sale is also priced from the sheet copy and any difference goes through `compareAndReport`, while the customer is always charged the Postgres price.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1. loadRecipe/priceRecipe seam + parity tests | eae15b72 | pos-recipe.js refactor, 18-test parity suite |
| 2. D-05/D-06 dual compare + tests | see git log (test commit) | 18-test suite; implementation landed in eae15b72 |

## Verification

- Middleware `npm test`: 159 suites / 2476 tests pass. Root `npm test`: 150 suites / 2152 pass. Middleware lint clean (`--max-warnings 0`).
- `pos-recipe.test.js`, `pos-recipe-money-path.test.js`, `recipe-scaling.js` untouched and green. The unused `axios` require and `callAppsScriptPost` helper were removed from pos-recipe.js (no remaining use); sheets mode makes the same get_recipe call via recipe-store (asserted).

## Log lines (RUNBOOK 85-11 alignment)

`[dual-price] compared recipe=<id> op=<op> compared=N skipped=M sheet_failed=K` and `[dual-price] skip recipe=<id> op=<op> reason=settle|dirty ...`, Sentry component `recipes-dual-price`. These match the RUNBOOK and 85-DUAL-LOG wording; a trailing `sheet_failed=K` was added to the totals (additive, `compared`/`skipped` prefixes exactly as planned).

## Deviations from Plan

- **Task commit split:** the Task 2 scheduling code was written in the same edit of pos-recipe.js as the Task 1 refactor, so commit eae15b72 contains both implementation parts; Task 2's test file is a separate commit. Strict RED-before-GREEN ordering was not preserved for either task's tests (both passed on first run).
- **[Rule 1 - Bug] discountTotal projection:** plan's interface named `discountTotal`; the real discount object exposes `discountAmount`, so the projection reads that.
- Dual compare also runs on `/recipe-sale` (op `sale`) and `/confirm` (op `sale`) as specified; sheet-leg `updated_at` unparsable => settle check is skipped (compare proceeds).
- In the sale and quote paths the compare is scheduled from settled-outcome handlers attached before the route's own handlers (still non-blocking: only async work started).

## Known Stubs

None.

## Threat Flags

None. T-85-44..49 mitigated as planned (parity tests, fire-and-forget compare, production-only gate, settle/dirty gate with counters + stuck-dirty alert, numeric-only reportValuesFor, no sheet fallback in /confirm).

## Self-Check: PASSED

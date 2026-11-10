---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 08
subsystem: kiosk-frontend
tags: [kiosk, admin-pos, cart, recipes]
requires: ["101-07"]
provides:
  - recipe entries list behind getRecipeEntries/setRecipeEntries on kiosk and admin
  - kioskRemoveRecipeEntry / KioskCore.removeRecipeEntry, KioskCore.nextSeq
affects: [101-10, 101-11, 101-12]
tech-stack:
  added: []
  patterns: [env bridge list state, interim legacy adapter]
key-files:
  created:
    - tests/frontend/kiosk-mixed-recipe-cart.test.js
  modified:
    - js/kiosk-core.js
    - js/kiosk.js
    - js/admin.js
    - tests/frontend/kiosk-canning-bundle.test.js
    - tests/frontend/kiosk-recipe-fee-tax.test.js
  deleted:
    - tests/frontend/kiosk-recipe-cart-guard.test.js
key-decisions:
  - "Recipe entry rows are plain interim rows (name, total, remove); grouped block is Plan 12"
  - "kioskCartIsEmpty counts entries so entry-only carts can check out"
  - "added_seq stamped in kioskAddToCart, bundle and consumer custom/gift-card modals via KioskCore.nextSeq (not in render, which mutates cart and broke an equality test)"
requirements-completed: [MIXR-01, MIXR-10]
duration: ~35 min
completed: 2026-11-10
---

# Phase 101 Plan 08: Recipe entries list and guard removal Summary

Recipe state is now a list of entries on both the standalone kiosk and admin POS; adding a recipe pushes an entry and no longer wipes or blocks the cart, and the bbca0f28 recipe-cart guard is gone.

## Commits
- 39ab8bc2: Task 1, entries model + bridge rename behind `_kioskLegacyRecipeContext` adapter
- 5ccfbe80: Task 2, guard removal, entry push, remove-entry, mixed-cart tests

## Deviations from Plan

**1. [Rule 3 - Blocking] kiosk-recipe-fee-tax.test.js env stub** - it passed `getRecipeContext` into `core.init`; renamed to `getRecipeEntries` (one line) so it still exercises the recipe branch. Not in the plan's test list; the parity test needed no change (it had no bridged-name assertions).

**2. [Rule 1] added_seq stamping** - first tried stamping in kioskRenderCart; it mutated the cart and broke kiosk-past-sales-cv-exit equality. Moved to explicit stamps via exported `nextSeq`.

**3. Test order** - mixed-cart test file was written after the implementation in the same task rather than observed failing first.

**4. Existing test edits (D-20, owner-approved):** kiosk-canning-bundle.test.js (recipe_cart rejection and "no opener" cases replaced by "bundle allowed alongside a recipe entry"); guard test file deleted. kiosk-recipe-modify / admin-recipe-modify needed no change.

## Interim state (must be resolved in Plan 10)
- `_kioskLegacyRecipeContext` / `_kioskSetLegacyRecipeContext` still feed checkout, phantom guard, tender panel, and `calcTotals` from the FIRST entry. Entries no longer write `recipe-ing-*`/`recipe-fee-*`/`recipe-total` cart keys, so cart totals currently exclude recipe entries; do not push before Plan 10 (T-101-53).
- Entry carries a private `_ingredients` field for the adapter; delete with it.

## Known Stubs
- Recipe entry rows show name + total only (Plan 12 renders grouped lines/fees).

## Verification
Frontend 255 suites / 3487 tests, middleware (Node 24) 310 suites / 4394 tests, lint and build green at both commits.

## Self-Check: PASSED

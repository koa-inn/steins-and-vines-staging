---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 06
subsystem: middleware
tags: [kiosk, recipe, confirm, money-path, zoho-invoice, void]
requires: ["101-05"]
provides:
  - "POST /api/kiosk/sale/confirm re-prices recipes[] through computeCartPricing"
  - "One Zoho invoice + one payment for recipe-bearing sales, reconciled to the charge"
  - "__recipeInvalid tagged errors: plain 4xx without a charge, void with a transaction_id"
affects: [101-07]
key-files:
  modified:
    - zoho-middleware/routes/pos.js
  created:
    - zoho-middleware/__tests__/pos-confirm-recipes.test.js
key-decisions:
  - "Recipe-bearing confirm uses computeCartPricing for the whole cart; product-only confirm keeps its original resolveDiscount/computeTax path untouched"
  - "Product lines after pricing come from computeCartPricing (already discounted); recipe lines are kept apart so ledger.decrementStock and createBatchesFromSale only ever see non-recipe lines"
  - "Recipe gate/validation errors are computed synchronously and thrown inside the first .then so they reach the outer catch (tagged, never a bare 4xx)"
  - "reconcileRecipeInvoice is awaited before payment; a reject falls into the standard void block"
requirements-completed: [MIXR-03, MIXR-07]
duration: 40min
completed: 2026-11-10
---

# Phase 101 Plan 06: Recipe-bearing /confirm Summary

/api/kiosk/sale/confirm now re-prices recipe carts server-side and books one invoice and one payment, with every recipe failure after a charge routed into the existing void-whole-payment path.

## Commits

- 5c244962 feat: recipe re-pricing in /confirm, `__recipeInvalid` tagging, `kiosk.confirm_stock_short` (no 409 after a charge)
- 92c7d374 feat: one invoice (line order, notes, numeric product discounts, summed adjustment, reconcile)
- f3381564 test: money-path parity per tender (verify, void, replay, sentinel)

## What changed in routes/pos.js

- Route entry accepts recipe-only carts (items[] may be omitted).
- runConfirm: BEER_SALES_ENABLED gate, validateRecipeEntries and recipe fee-item usability become tagged `__recipeInvalid` errors (with `__status`); computeCartPricing failures map tax -> `__taxUnresolved`, others -> `__recipeInvalid`. Outer catch tagged condition extended; without a transaction_id it answers `err.__status || 400` and releases the confirm lock, with one it voids.
- Invoice: non-recipe lines (product `%` discounts converted to numeric amounts), then each recipe's ingredient and fee lines in cart order; one summed adjustment with description 'Recipe package price'; notes carry `recipeNotesSummary`; `reconcileRecipeInvoice` runs after create (gap > $1.00 rejects, voiding the whole payment).
- Task 3 required no pos.js changes: the money path only sees grandTotal, and all tender tests passed unchanged.

## Verification

Middleware 308 suites / 4360 tests (Node 24), frontend 255 suites / 3479 tests, lint clean. New file pos-confirm-recipes.test.js: 71 tests (all 38 ORACLE.confirm cases, mixed/ordering, discounts, reconcile, terminal/manual/MOTO/cash/gift-card parity, void, failed-void lock keep, replay, sentinel). pos-recipe-characterization.test.js green; no existing test modified. One unrelated flaky failure of promo-failclosed.test.js appeared in one parallel full run; it passes alone and in a rerun.

## Deviations from Plan

- The "mixed" ordering test uses a product line, a gift_cert issue line and two recipes; it does not include a wine kit with Maker's fee or a canning bundle (their line builders are unchanged and covered by existing tests; the bundle needs a can-catalog fixture out of scope here).
- Tests and implementation were committed per task once green (CLAUDE.md rule 1); Task 3 was tests only.

## Known Stubs

None. Plan 07 (cart-quote, sentinel extensions) remains.

## Threat Flags

None beyond the plan's threat model.

## Self-Check: PASSED

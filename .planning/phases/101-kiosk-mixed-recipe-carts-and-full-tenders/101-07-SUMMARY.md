---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 07
subsystem: middleware
tags: [kiosk, recipe, brewpad-batches, cart-quote, money-path]
requires: ["101-06", "101-02"]
provides:
  - "Per in-store recipe entry BrewPad batch after confirm (unit_total for repeats)"
  - "POST /api/kiosk/cart-quote: read-only server total identical to /sale"
  - "confirm 201 recipes[] receipt data"
affects: [101-10, 101-11]
key-files:
  modified:
    - zoho-middleware/routes/pos.js
  created:
    - zoho-middleware/__tests__/pos-confirm-recipe-batches.test.js
    - zoho-middleware/__tests__/pos-cart-quote.test.js
key-decisions:
  - "Recipe batch snapshot copied from the legacy confirm; modified_base_ingredients read from the request entry by index"
  - "createBatchesFromSale and ledger.decrementStock keep receiving non-recipe lines only; cf_batch_status label sync untouched (accepted limitation)"
  - "cart-quote discount_total: recipe carts use discountApplied.amount (already product+recipe); product-only uses gross minus discounted subtotal"
  - "Item-line validation factored into validateCartItems, shared by /sale and /cart-quote with identical messages"
requirements-completed: [MIXR-08, MIXR-11]
duration: 35min
completed: 2026-11-10
---

# Phase 101 Plan 07: Recipe batches and cart-quote Summary

After a recipe-bearing confirm the server now creates one BrewPad batch per in-store recipe entry, busts the ingredient caches, returns recipes[] for receipts, and exposes a side-effect-free `/api/kiosk/cart-quote` that prices through the same `computeCartPricing` as `/sale`.

## Commits

- 12226165 feat: confirm post-success batches/caches/receipt, plus the cart-quote route and `validateCartItems` (the route code landed in the same pos.js commit)
- 07e5077e test: cart-quote equality and no-side-effect tests

## Details

- `createRecipeBatchesAfterConfirm`: in-store entries only; repeated recipe_id in-store entries each pass `{unit_total: count}`; take-out creates none; email trimmed and validated (<=254, legacy regex), recipe batches only, never logged; failures logged, never fail the sale.
- Cache busts INGREDIENTS, INGREDIENTS_ALL, RECIPES_TS only when recipes are present.
- `kiosk.sale_completed` gains `has_recipes`, `recipe_count` for recipe sales only.
- cart-quote: 403 gate, 400 validation/empty/unknown item, 200 with `stock.ok:false` on short stock (never 409), 503 when catalog unavailable, 502 on unexpected throw; catalog resolved with `rebuild:false`.

## Verification

Middleware 310 suites / 4394 tests, frontend 255 suites / 3479 tests, lint clean. No existing test modified; characterization oracle green.

## Deviations from Plan

- Both tasks touch routes/pos.js and were developed together, so the first commit contains the cart-quote route code too; its tests are in the second commit.
- New batches test replaces the harness's independent invoice-total echo with the charged total (the echo is not under test and produced NaN on rebalance for an in-store + take-out cart).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model.

## Self-Check: PASSED

---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 05
subsystem: middleware
tags: [kiosk, recipe, pricing, discount, tax, stock, sale]
requires: ["101-04"]
provides:
  - "computeCartPricing(body, catalogMap) shared pricing core in routes/pos.js"
  - "POST /api/kiosk/sale accepts recipes[] on every tender"
affects: [101-06, 101-07]
key-files:
  modified:
    - zoho-middleware/routes/pos.js
  created:
    - zoho-middleware/__tests__/pos-cart-pricing-refactor.test.js
    - zoho-middleware/__tests__/pos-sale-recipes.test.js
key-decisions:
  - "resolveDiscount loads the preset and computes recipe bases itself (5th param recipeUnits carries base_total/fee_portion); it returns recipeAmounts and the preset"
  - "computeCartPricing validates recipes itself (as well as processSale) so Plans 06/07 callers cannot skip validation"
  - "RECIPE_SALE mutex dropped from the merged route; standard idempotency lock plus deterministic Helcim key protects against double charge"
  - "Fee-item usability: Maker+Materials for in-store, Milling for milled take-out must be in the kiosk catalog (rebuild once, then 400)"
requirements-completed: [MIXR-02, MIXR-04, MIXR-05, MIXR-06, MIXR-07, MIXR-09, MIXR-11]
duration: 45min
completed: 2026-11-10
---

# Phase 101 Plan 05: Recipes in /api/kiosk/sale Summary

/api/kiosk/sale now prices recipe components server-side next to products through one `computeCartPricing`, with cart-wide discounts, entity-level merged tax, and combined-stock 409 gating before any tender.

## Commits

- 426141a8 refactor: extract computeCartPricing and taxGroups (behaviour-neutral, product-only)
- 6817825c feat: recipes[] priced in /sale; all 38 Plan 01 oracle cases charge the oracle amount; merged tax, discounts, all tenders
- fdf24f82 feat: BEER_SALES_ENABLED gate, validation, required client_grand_total, fee-catalog usability, 409 + override, has_recipes on mismatch event

## Verification

Middleware 307 suites / 4289 tests (Node 24), frontend 255 suites / 3479 tests, lint clean. No existing test modified; characterization oracle green. New tests: 7 (refactor) + 71 (recipe sale).

## Deviations from Plan

- Tasks 2 and 3 were each committed as tests + implementation together (CLAUDE.md rule: never commit failing tests), as the plan prescribes.
- `taxGroups` is recomputed once for product lines and `computeTax` is called again on the product-only path; negligible cost, keeps the product-only result path identical.
- Two identical recipes charge up to 1 cent different from 2x the single charge because tax is rounded once per merged rate group (intended D-entity-level behaviour); the test asserts the merged value.

## Known Stubs

None. Note: recipe lines are priced and gated here but not yet booked to Zoho or the sentinel; /confirm and /cart-quote wiring is Plans 06/07.

## Threat Flags

None beyond the plan's threat model.

## Self-Check: PASSED

---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
verified: 2026-11-11T00:00:00Z
status: human_needed
score: 11/11 requirements verified in code (Plan 101-15 prod release out of scope)
---

# Phase 101 Verification

**Goal:** mixed recipe + product/custom/gift-card kiosk cart, full tenders, one invoice/one payment via `/api/kiosk/sale` + `/confirm`.

## Evidence (independent of SUMMARY claims)
- Middleware (Node 24): 311 suites / 4374 tests pass. Frontend: 258 suites / 3558 tests pass. Lint clean (0 warnings).
- `zoho-middleware/routes/pos.js`: `/api/kiosk/sale` and `/confirm` accept `recipes[]` (validateRecipeEntries, combined stock 409 with `recipes_short`, per-entry `unit_total` for repeated in-store recipes, BEER_SALES_ENABLED gate, void-on-failure paths); read-only `POST /api/kiosk/cart-quote` at line 494; auth tier registered in `lib/authTiers.js`.
- `zoho-middleware/lib/recipe-sale-lines.js` exists (extracted pricing core).
- `routes/pos-recipe.js:270`: legacy `/recipe-sale` returns 410 before any lock/pricing/charge; `/recipe-sale/confirm` retained. Deletion todo `.planning/todos/pending/delete-legacy-recipe-sale-confirm.md` exists.
- Client: `js/kiosk-core.js` sends `recipes` in the standard sale body (line ~3443), debounced `cart-quote` fetch (line ~3202), quote-only totals for recipe carts. No "check out or clear the cart" / "card terminal only" guard strings remain in `js/` sources.
- Docs: `docs/API.md` documents cart-quote; `docs/RUNBOOK.md` has Phase 101 release order and soak procedure.
- D-17 staging gate PASSED: INV-000267 (airlock + in-store recipe, one invoice, one $100.09 payment == invoice total, stock dropped, batch confirmed by owner). Bug found at the gate (modified_ingredients null) fixed in a8828ab8 with regression test.

## Requirements coverage
MIXR-01..MIXR-11: all declared in plans and in REQUIREMENTS.md (all marked Complete); no orphaned IDs. Code evidence found for each. Observed on real terminal: card tender only (MIXR-01/02/03/08 partially, MIXR-04 card).

## Out of scope
Plan 101-15 (production release, soak clock) not executed; not counted as a gap.

## Human verification required (WARNING, not gaps)
1. Cash, Gift Card (alone and split) and Phone order (MOTO) tenders on a recipe-bearing cart on staging. Only the card-terminal path has a real-sale proof (INV-000267); other tenders are covered by automated tests only.
2. Multi-recipe cart (duplicate recipe) with discount preset and a stock-override sale on staging: confirm batches (`unit_total` labels) and tax/adjustment match the invoice.
3. Admin POS mixed cart behaviour (MIXR-01/10 mention admin POS): visual check that the guard is gone and recipe blocks render grouped.

## Pre-release items (for Plan 15, noted not gaps)
- Ingredient catalog empty after redeploy causes 503 on quotes (gate issue 2); fix to `getIngredientCatalog` is in progress concurrently and must land + be tested before prod release.
- Test invoices INV-000266/267 remain paid in Zoho on staging; reverse manually.
- `docs/DEPLOYMENT.md` lists non-resolving staging host.

## Gaps
None blocking.

---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 09
subsystem: testing
tags: [jest, middleware, kiosk, recipes, money-path]
requires:
  - phase: 101-07
    provides: merged /api/kiosk/sale recipes[] route, cart-quote
provides:
  - No middleware test depends on POST /api/kiosk/recipe-sale (initiate)
  - Replacement /sale coverage for the retired initiate behaviours
affects: [101-13 initiate retirement]
tech-stack:
  added: []
  patterns: ["confirm-leg suites learn the charge from GET /recipe-quote total_with_tax"]
key-files:
  modified:
    - zoho-middleware/__tests__/pos-recipe.test.js
    - zoho-middleware/__tests__/pos-recipe-money-path.test.js
    - zoho-middleware/__tests__/pos-recipe-store.test.js
    - zoho-middleware/__tests__/recipe-dual-price.test.js
    - zoho-middleware/__tests__/pos-recipe-characterization.test.js
    - zoho-middleware/__tests__/pos-sale-recipes.test.js
    - zoho-middleware/__tests__/pos-recipe-captured-amount.test.js
    - zoho-middleware/__tests__/pos-recipe-confirm-verification.test.js
    - zoho-middleware/__tests__/pos-recipe-numeric-txn-id.test.js
    - zoho-middleware/__tests__/pos-recipe-payment-after-submit.test.js
    - zoho-middleware/__tests__/pos-recipe-fee-lastgood.test.js
    - zoho-middleware/__tests__/pos-recipe-fee-tax.test.js
    - zoho-middleware/__tests__/pos-recipe-invoice-reconcile.test.js
    - zoho-middleware/__tests__/pos-recipe-zoho-line-fidelity.test.js
    - zoho-middleware/__tests__/pos-recipe-catalog-fallback.test.js
  deleted:
    - zoho-middleware/__tests__/pos-recipe-sale-reference.test.js
key-decisions:
  - "Initiate-only behaviours were re-created on /api/kiosk/sale inside pos-sale-recipes.test.js rather than re-harnessed in each legacy file"
  - "Idempotency replay on /sale returns the cached body with 201 (existing route behaviour), asserted as such"
requirements-completed: [MIXR-02, MIXR-09]
duration: 40min
completed: 2026-11-10
---

# Phase 101 Plan 09: Re-point legacy initiate tests Summary

Every middleware test that drove POST /api/kiosk/recipe-sale (initiate) is re-pointed, re-created on /api/kiosk/sale, or deleted with a named replacement. The oracle's initiate leg now runs against /api/kiosk/sale with the Plan 01 literals untouched (`git diff` on fixtures/recipe-mixed-carts.js is empty). Full suites: middleware 309 suites / 4366 tests, frontend 255 / 3487, lint clean.

## Commits
- 0ecde1e9: single-reference suites (+ last-good sale cases added to pos-sale-recipes)
- c8a4ef4b: heavy suites, reference/idempotency/validation replacement tests

## Mapping table (behaviour -> action -> covering test)

Covering tests live in `pos-sale-recipes.test.js` (PSR) unless noted.

| File | Test(s) | Action | Covering test |
|------|---------|--------|---------------|
| pos-recipe-characterization | initiate x 76 oracle cases | re-pointed to /api/kiosk/sale, literals unchanged (charge asserted; legacy route's echoed total_before_tax/tax_total now only in pos-cart-quote) | same file, plus PSR oracle block |
| pos-recipe-characterization | initiate stock shortfall 409 | re-pointed to /sale | same file; PSR "combined recipe stock" |
| pos-recipe | 1 gate 403 | deleted | PSR "BEER_SALES_ENABLED unset + recipes -> 403" |
| pos-recipe | 2 terminal-only 503 | deleted (terminal-only gate dropped for recipe sales, D-19) | PSR tender tests (cash/moto/gift) |
| pos-recipe | 3 missing recipe_id 400 | deleted | PSR "missing recipe_id -> 400" |
| pos-recipe | 4 invalid sale_type 400 | deleted | PSR "invalid sale_type -> 400" |
| pos-recipe | 5 mutex lock 503, 7 release mutex on terminal failure | deleted (RECIPE_SALE mutex dropped, A3) | PSR "mutex never taken"; PSR "terminal-push failure releases the idempotency key" |
| pos-recipe | 6 202 pending reference | deleted | PSR "charges, records the pending sentinel..." |
| pos-recipe | WR-04a/b/c log-only client-total mismatch | deleted (mismatch now blocks, D-09) | PSR "client total mismatch -> 400", "without client_grand_total -> 400" |
| pos-recipe | 15, 16 locked / dynamic price | deleted | PSR oracle (RCP-LOCKED, RCP-DYN) |
| pos-recipe | S1 no batch_size_l, S2 volume<=0, S3 >10x | deleted | PSR "recipe pricing validation through /sale" (3 tests) |
| pos-recipe | S4-S7 scaling prices | deleted | PSR oracle scale2x / take-out cases |
| pos-recipe | S8 stock 409, S9 override | deleted | PSR "combined recipe stock" 409 + override |
| pos-recipe | SCALE-05a internal-only ingredient | re-pointed to GET /recipe-quote (total_with_tax 53.85) | same test; PSR reads INGREDIENTS_ALL |
| pos-recipe | Q2 quote == sale | re-pointed: asserts quote total_with_tax 345.35; parity lives in pos-cart-quote.test.js | pos-cart-quote.test.js |
| pos-recipe | M-S1..M-S3 modified_ingredients on initiate | deleted | PSR oracle `modified` cases; pos-cart-quote parity |
| pos-recipe | U4b cross-family unit 422 pre-charge | deleted | PSR "a cross-family ingredient unit -> 422 before any charge" |
| pos-recipe-money-path | 1 duplicate -> one charge | deleted | PSR "idempotency contention returns 409 without charging" + replay test |
| pos-recipe-money-path | 2 idem lock + mutex order | deleted (mutex dropped) | PSR "idempotency lock is taken on the kiosk:idem: key" |
| pos-recipe-money-path | 3 key required in production | deleted | PSR "idempotency_key is required when NODE_ENV=production" |
| pos-recipe-money-path | 4 deterministic Helcim key | deleted | PSR "deterministic Helcim key sha256..." |
| pos-recipe-money-path | 5 pending-charge record | deleted | PSR "pending-charge record carries reference, amount..." |
| pos-recipe-money-path | 6 terminal failure releases locks | deleted | PSR "terminal-push failure releases the idempotency key (502)" |
| pos-recipe-sale-reference | A: kiosk reference + sentinel; RECIPE- fallback | file deleted | PSR reference tests (fallback is now a KIOSK- reference) |
| pos-recipe-store | sale parity sheets vs postgres | deleted | same file quote parity (full body equality incl. total_with_tax) |
| recipe-dual-price | sale route compares with operation sale | deleted | same file "/confirm in dual" (operation sale) |
| pos-recipe-fee-tax | sale charges 247.85 + pending; unresolvable fee tax 400 | deleted | PSR oracle charge; PSR "fee still missing after the rebuild -> 400" |
| pos-recipe-fee-lastgood | sale charged last-good-taxed total; no last-good fails closed | deleted | PSR two new last-good tests; kiosk-sale-catalog-lastgood.test.js |
| pos-recipe-catalog-fallback | recipe-sale Redis-expired fallback | deleted | same file quote + confirm fallback cases; PSR last-good |
| pos-recipe-captured-amount, -confirm-verification, -numeric-txn-id, -payment-after-submit | chargedTotal() setup step | re-pointed to GET /recipe-quote total_with_tax; confirm assertions unchanged | n/a (setup) |
| pos-recipe-invoice-reconcile, -zoho-line-fidelity | unused sale() helper | helper removed | n/a |

## Deviations from Plan

**1. [Rule 2 - Coverage] Added replacement tests to pos-sale-recipes.test.js** (reference/idempotency, deterministic Helcim key, production key requirement, pending-charge fields, pricing validation, last-good fee catalog) plus the two LASTGOOD cache keys in its constants mock, so no money-path assertion was lost by deleting legacy cases (T-101-40). Existing assertions in that file are untouched.

**2. Plan hint not followed:** the plan suggested loading routes/pos.js in each legacy file; instead the legacy-only describes were removed and re-created once on /sale, since legacy files mock a different harness. Only the characterization file got a /sale harness (needed to keep the oracle initiate leg on the merged route).

None of the retired behaviours were weakened beyond the plan's named drops (mutex 503, terminal-only 503, log-only mismatch).

## Known Stubs
None.

## Self-Check: PASSED
- grep `'/api/kiosk/recipe-sale'` across `zoho-middleware/__tests__/*.js` prints nothing.
- Oracle fixture diff empty; commits 0ecde1e9 and c8a4ef4b exist.

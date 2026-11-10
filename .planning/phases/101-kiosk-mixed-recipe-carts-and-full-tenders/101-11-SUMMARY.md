---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 11
subsystem: kiosk-frontend
tags: [kiosk, admin-pos, cart-quote, recipes]
requires: ["101-07", "101-10"]
provides:
  - kioskRequestCartQuote (debounced, sequence-checked) exposed as KioskCore.requestCartQuote
  - shared kioskBuildSaleItems / kioskBuildRecipeWire / kioskBuildDiscountWire helpers
affects: [101-12]
tech-stack:
  added: []
  patterns: [debounce + sequence discard, shared wire builders]
key-files:
  created:
    - tests/frontend/kiosk-cart-quote-client.test.js
  modified:
    - js/kiosk-core.js
key-decisions:
  - "Quote staleness is handled by setting status pending on every cart change and discarding responses whose seq is not latest; checkout gate keys on status (seq check not needed in the gate)"
requirements-completed: [MIXR-11]
duration: ~25 min
completed: 2026-11-10
---

# Phase 101 Plan 11: Client cart-quote Summary

Recipe carts now fetch the server cart-quote on every cart change (250 ms debounce, latest response wins) and Checkout stays blocked unless the quote is ok, on both kiosk and admin POS.

## Commits
- c6886dad: kioskRequestCartQuote, shared wire builders, mutation-path wiring, 20 tests (10 per surface)

## Deviations from Plan

**1. Tasks 1 and 2 committed together.** The checkout gate (proceedToPayment refusing when totals.pending) was already added in Plan 10; Task 2's tests (pending/error/404/changed-cart/ok) passed against it with no new code, so one commit covers both.

**2. Gate keys on status only, not seq.** Plan 10 tests seed quotes via _setCartQuote with arbitrary seq; every cart change re-pends the quote, so a stale ok is impossible without a seq comparison.

**3. js/admin.js** included in the commit (build version stamp). Other HTML cache-bust stamps from the build were not staged.

## Notes
- Mutation paths calling kioskRequestCartQuote: add, setQty, remove, removeRecipeEntry, clear, addRecipeToCart, bundle set/remove/count, discount apply/remove. Imported-SO load (kioskSyncKitFees path) and gift-cert/custom line adds do not call it; they are not recipe-cart paths today, and a stale quote would be caught by the server's client_grand_total assertion.
- Error state has no automatic retry; any cart change re-requests.

## Known Stubs
None.

## Verification
Frontend 257 suites / 3528 tests, middleware (Node 24) 309 suites / 4366 tests, lint and build green.

## Self-Check: PASSED

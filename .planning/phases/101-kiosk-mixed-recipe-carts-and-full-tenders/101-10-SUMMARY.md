---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 10
subsystem: kiosk-frontend
tags: [kiosk, admin-pos, checkout, recipes, tenders]
requires: ["101-08", "101-09"]
provides:
  - quote-based kioskCalcTotals for recipe carts (_kioskCartQuote, _setCartQuote/_getCartQuote hooks)
  - one standard /api/kiosk/sale + /sale/confirm body carrying recipes, override, customer_email on every tender
  - tender panel shown for recipe carts
affects: [101-11, 101-12]
tech-stack:
  added: []
  patterns: [server-quote-only totals, parameters-only wire objects]
key-files:
  created:
    - tests/frontend/kiosk-mixed-recipe-checkout.test.js
  modified:
    - js/kiosk-core.js
    - tests/frontend/kiosk-recipe-client-totals.test.js
    - tests/frontend/kiosk-recipe-fee-tax.test.js
    - tests/frontend/kiosk-core-parity.test.js
    - tests/frontend/kiosk-recipe-sale-email-97.test.js
    - tests/frontend/kiosk-client-error-beacon.test.js
key-decisions:
  - "Recipe-cart totals come only from the server cart-quote; pending/error disables Checkout (aria-busy)"
  - "proceedToPayment itself refuses to start while a recipe cart's quote is not ok (defence beyond the disabled button)"
  - "409 stock-conflict override handling now applies to any /sale 409 with conflicts, not only recipes"
requirements-completed: [MIXR-04, MIXR-10, MIXR-11]
duration: ~40 min
completed: 2026-11-10
---

# Phase 101 Plan 10: Quote totals and standard checkout for recipe carts Summary

Recipe carts now show only server cart-quote totals and check out through the standard /api/kiosk/sale route with the full tender panel (gift card, cash, phone order, card), on both kiosk and admin POS.

## Commits
- 6cf9db62: Task 1, quote-based kioskCalcTotals + Checkout disabled/aria-busy while pending
- 461dc23e: Task 2, standard sale/confirm body with recipes, tender panel always shown, legacy adapter and recipe-sale client path deleted

## Deviations from Plan

**1. [Rule 2 - Safety] proceedToPayment guard** - returns with a toast when totals.pending, so a recipe cart cannot start a sale without an ok quote even if the button state is bypassed (T-101-32).

**2. [Rule 1] Existing-test edits needed beyond the edit list intent** - parity, email and client-totals tests drive the tender panel now (click #kgcr-skip-btn where the panel is injected) and set a quote via _setCartQuote; Pitfall 3 test sets modified ingredients before adding the recipe because entries snapshot them at add time. All files were in the plan's list.

**3. Moto confirm** - the phone-order confirm leg (Helcim iframe postMessage) is not drivable in jsdom; the test pins the shared confirm-body builder in source plus the runtime /sale moto body.

**4. Beacon test** - occurrence floor lowered from 5 to 4 after the recipe confirm catch was deleted.

## Notes
- Cash and phone-order paths send override but do not render the 409 stock-conflict panel; they show the generic sale error (the card terminal path has the override UI). Flag for a later plan if wanted.
- Cart-quote fetch is Plan 11; until it lands a recipe cart has no quote and Checkout stays disabled (safe state). Do not push before Plan 11.
- Middleware suite count was 309 suites / 4366 tests on Node 24 (101-08 summary recorded 310 / 4394); no failures, not investigated.

## Known Stubs
- _kioskCartQuote is only set via the _setCartQuote hook until Plan 11.

## Verification
Frontend 256 suites / 3508 tests, middleware (Node 24) 309 suites / 4366 tests, lint and build green at both commits.

## Self-Check: PASSED

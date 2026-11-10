---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 02
subsystem: middleware
tags: [brewpad, batch-dedup, auth-tiers, kiosk]
requires: []
provides:
  - "detectRecipeSale optional opts.unit_total (D-02)"
  - "/api/kiosk/cart-quote on exact-path KIOSK_ROUTES allowlist (D-19)"
affects: [101-06, 101-07]
key-files:
  created:
    - zoho-middleware/__tests__/brewpad-recipe-unit-total-101.test.js
    - zoho-middleware/__tests__/pos-cart-quote-auth-tier.test.js
  modified:
    - zoho-middleware/lib/brewpad-integration.js
    - zoho-middleware/lib/authTiers.js
key-decisions:
  - "unit_total emitted only when > 1 (floored); payload otherwise byte-identical, so 97-10 email carry-through is unchanged"
  - "cart-quote added as exact path only; no prefix rule; recipe-sale/confirm entries kept"
requirements-completed: [MIXR-08, MIXR-11]
duration: 10min
completed: 2026-11-10
---

# Phase 101 Plan 02: unit_total for repeated recipes + cart-quote auth tier Summary

detectRecipeSale takes an optional 7th `opts` arg whose `unit_total` (> 1) is sent on the batch create payload, so repeated in-store entries of one recipe on one invoice each create a batch; `/api/kiosk/cart-quote` is allowlisted on the kiosk tier alongside `/api/kiosk/sale`.

## Tasks

1. detectRecipeSale opts.unit_total: commit bf526e3f (TDD; RED showed 2 failing, then green). The only existing caller (routes/pos-recipe.js) passes no 7th arg, so behaviour is unchanged.
2. cart-quote allowlist: see git log (feat(101-02) auth tier commit).

Full verification: middleware 303 suites / 4155 tests, frontend 3479 tests, lint all green.

## Deviations from Plan

- Task 2's test asserts tier membership through `isKioskRoute`/`allowKiosk`/`KIOSK_ROUTES` directly rather than a supertest unauthenticated request, since the route handler does not exist until Plan 07 (an unauthenticated request would 404 rather than prove tier behaviour). Exact-path and no-prefix behaviour are asserted.

## Known Stubs

None.

## Self-Check: PASSED

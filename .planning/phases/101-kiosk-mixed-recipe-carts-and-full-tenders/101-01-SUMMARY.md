---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 01
subsystem: testing
tags: [characterization-tests, recipe-pricing, kiosk, jest, oracle]
requires: []
provides:
  - "Shared recipe fixtures (MOCK_INGREDIENTS_CATALOG, MOCK_RECIPES, KIOSK_FEE_CATALOG, DISCOUNT_PRESETS, DISCOUNT_KEYS, FEE_IDS, ORACLE)"
  - "Literal oracle of legacy recipe-only charge and invoice booking (38 cases each)"
affects: [101-02, 101-03, 101-04, 101-05, 101-06]
tech-stack:
  added: []
  patterns: ["characterization oracle with literals captured from current code, then frozen"]
key-files:
  created:
    - zoho-middleware/__tests__/fixtures/recipe-mixed-carts.js
    - zoho-middleware/__tests__/pos-recipe-characterization.test.js
  modified: []
key-decisions:
  - "Oracle literals captured from current code via a temporary capture hook, then the hook was removed so the committed tests only assert"
  - "Confirm tax is derived independently in the test from the posted lines (per-rate group rounding) and cross-checked against the initiate-leg tax and charge"
requirements-completed: [MIXR-02]
duration: 25min
completed: 2026-11-10
---

# Phase 101 Plan 01: Recipe characterization oracle Summary

Frozen, literal oracle of what the legacy recipe route charges (initiate) and books (confirm), covering locked/dynamic x in-store/take-out/take-out+mill x five discount modes plus 2x scale and modified-ingredient cases.

## Tasks

1. Fixtures + initiate-leg oracle: commit 8c320eb6. 38 charge cases (charge, total_before_tax, tax_total) plus a stock-shortfall 409 case.
2. Confirm-leg oracle: commit 3238557d. For the same 38 keys pins invoice line_items (item_id, quantity, rate, discount, tax_id), adjustment and description, derived tax, and customerpayments amount. Asserts no re-balance PUT and no void.

Final: 77 tests in the new file; full middleware suite 301 suites / 4148 tests, frontend 3479 tests, lint all green.

## Deviations from Plan

- Recipes are served through a `../lib/recipe-store` mock (`get`, `getMode`) rather than axios Apps Script responses; it is the seam the route actually uses and allows per-recipe fixtures.
- `npm run lint` only lints `js/`, so it does not cover the new middleware test files.

No production code or existing tests were changed.

## Known Stubs

None.

## Self-Check: PASSED

Both created files exist; commits 8c320eb6 and 3238557d exist.

---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 13
subsystem: kiosk money path
tags: [kiosk, recipes, legacy-retirement, docs]
requires: [101-09, 101-12]
provides:
  - "410 on POST /api/kiosk/recipe-sale"
  - "kiosk.recipe_sale_legacy_confirm soak event"
  - "docs for merged sale route, cart-quote, release order"
affects: [zoho-middleware/routes/pos-recipe.js, docs/API.md, docs/RUNBOOK.md]
key-files:
  created:
    - zoho-middleware/__tests__/pos-recipe-legacy-route-101.test.js
    - .planning/todos/pending/delete-legacy-recipe-sale-confirm.md
  modified:
    - zoho-middleware/routes/pos-recipe.js
    - docs/API.md
    - docs/RUNBOOK.md
decisions:
  - "Legacy initiate returns 410 before any lock/pricing/terminal call; legacy confirm kept and instrumented (D-18)"
metrics:
  completed: 2026-11-10
---

# Phase 101 Plan 13: Legacy recipe route retirement Summary

Legacy `POST /api/kiosk/recipe-sale` now returns 410 with the refresh message and no money movement; `/recipe-sale/confirm` still books in-flight charges and logs `kiosk.recipe_sale_legacy_confirm` (reference + boolean only).

## Tasks

1. Task 1 (5e134744): 410 stub, removed `_runRecipeSale` and the now-unused `crypto` require, legacy confirm event, new test file (5 tests).
2. Task 2 (9508f9f6): API.md (recipes[], cart-quote, 410, legacy confirm), RUNBOOK.md release order and D-17 gate, D-18 deletion todo.

## Verification

Middleware suite 310 suites / 4371 tests green on Node 24; frontend 258 suites / 3558 tests green; lint clean.

## Deviations from Plan

[Rule 3 - cleanup] Removed the unused `crypto` require from pos-recipe.js after `_runRecipeSale` was deleted. Otherwise none.

## Known Stubs

None.

## Self-Check: PASSED

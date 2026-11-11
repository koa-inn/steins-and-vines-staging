---
phase: 101-kiosk-mixed-recipe-carts-and-full-tenders
plan: 14
subsystem: deploy / staging gate
tags: [staging, deploy, d-17, kiosk, recipes]
requires: [101-13]
provides:
  - "Phase 101 live on staging (middleware pushed first)"
  - "D-17 gate passed with owner approval (INV-000267)"
affects: [zoho-middleware/lib/recipe-entries, docs/DEPLOYMENT.md]
key-files:
  created:
    - .planning/phases/101-kiosk-mixed-recipe-carts-and-full-tenders/101-14-STAGING-GATE.md
    - zoho-middleware/__tests__/recipe-entries-null-modified-101.test.js
  modified:
    - zoho-middleware (validateRecipeEntries, commit a8828ab8)
decisions:
  - "Treat recipes[].modified_ingredients null as absent in validateRecipeEntries"
metrics:
  completed: 2026-11-11
requirements-completed: [MIXR-03, MIXR-04, MIXR-08]
---

# Phase 101 Plan 14: Staging deploy and D-17 gate Summary

Phase 101 is on staging (middleware boundary commit fd4813e2 first, then main), and the owner's real terminal sale of a product plus a recipe produced ONE Zoho invoice (INV-000267, $100.09 charge == invoice total) with stock dropped and a BrewPad batch created; owner approved.

## Tasks

1. Task 1: gates (frontend 3558, middleware 4371 on Node 24, lint, build with stamp-only noise restored), pushed `fd4813e2` then main; redeploy evidenced by health uptime reset; evidence in 101-14-STAGING-GATE.md (5730d0f6).
2. Task 2: owner D-17 sale, approved; result recorded (2199d294).

## Deviations from Plan

**1. [Rule 1 - Bug] null modified_ingredients rejected** (a8828ab8, pushed to staging). The kiosk sends `modified_ingredients: null` for unmodified recipes; validation rejected it so every cart-quote returned 400 and the cart showed $0. Fixed, regression test added; suites green (middleware 311/4374, frontend 258/3558, lint clean). Root gap: server tests never sent null, client tests mocked the server.

**2. Weak cart-quote probe.** The unauthenticated probe returned 403, indistinguishable from an unknown route (auth guard precedes routing); redeploy was proven by the uptime reset instead.

## Open items for Plan 15 (prod release)

- **Empty ingredient catalog after redeploy (pre-existing ops issue):** Redis and the file fallback are empty after a middleware restart; with `ZOHO_SCHEDULED_JOBS=off` (staging) cart-quote/recipe-quote 503. Recipe sales also bust the Redis keys. Prod needs a catalog rebuild right after deploy, or preferably a fix so `getIngredientCatalog` refreshes rather than 503s when both are empty.
- INV-000266 and INV-000267 remain "paid" in Zoho (Helcim void does not touch Zoho); reverse them manually.
- BrewPad batch id and Helcim void reference were confirmed by owner but not captured.
- `docs/DEPLOYMENT.md` lists non-resolving `staging-api.steinsandvines.ca`; real host `svmiddleware-staging.up.railway.app`.
- One transient `/api/kiosk/sale` 502 "Terminal error" before INV-000266 (terminal retry, no booking).

## Known Stubs

None.

## Self-Check: PASSED

Gate file, this summary, and commits 5730d0f6, a8828ab8, 2199d294 exist.

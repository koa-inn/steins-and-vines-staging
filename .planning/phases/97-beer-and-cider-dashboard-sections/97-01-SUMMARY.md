---
phase: 97-beer-and-cider-dashboard-sections
plan: 01
subsystem: recipes
tags: [postgres, migration, recipes, apps-script, validation]
requires: []
provides:
  - recipes.target_og / recipes.target_fg (numeric, nullable) via migration 0009
  - recipeRules.normalizeTargetGravity / checkTargetGravityPair / TARGET_GRAVITY_MESSAGE
  - 400 invalid_target_gravity on POST/PUT /api/recipes
  - Apps Script ensureRecipesTargetGravityColumns (lazy, mirror only)
affects: [97-02, 97-05]
key-files:
  created:
    - zoho-middleware/migrations/0009_recipes_target_gravity.sql
    - zoho-middleware/__tests__/recipe-rules-target-gravity.test.js
    - zoho-middleware/__tests__/recipes-target-gravity-route.test.js
    - zoho-middleware/__tests__/db/recipe-pg-target-gravity.test.js
    - tests/frontend/adminapi-recipe-target-gravity.test.js
  modified:
    - zoho-middleware/lib/recipe-rules.js
    - zoho-middleware/lib/recipe-pg.js
    - zoho-middleware/routes/recipes.js
    - zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json
    - apps-script/adminApi.gs
decisions:
  - "No CHECK constraint (allowlist forbids DROP CONSTRAINT); range 2..40 and fg < og enforced in app code"
  - "Apps Script columns added lazily, only when a mirrored recipe carries a value"
  - "No backfill of existing batches (D-06)"
metrics:
  tasks: 3
  completed: 2026-11-03
---

# Phase 97 Plan 01: Recipe Target OG/FG Summary

Recipes now carry optional Target OG and Target FG (degrees Plato, 2 to 40, FG below OG) in Postgres via migration 0009, validated in the route and store, returned as numbers (or '' when NULL), kept out of the public API, and carried by the prod Apps Script mirror through lazily added columns.

## Commits

- aa9e1bb7: migration 0009, rules, recipe-pg, golden fixture
- bea073e1: route validation (checkTargetGravity, 400 invalid_target_gravity)
- a28f45c1: Apps Script ensureRecipesTargetGravityColumns + mirror hook

## Pre-existing test files edited

- `zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json`: added `"target_og": ""` and `"target_fg": ""` after `beer_category` in every recipe object. Owner-approved (plan OWNER-OK-TESTS); the golden changes only because RECIPE_COLUMNS gained two keys. No other existing test was modified.

## Verification

- `npm run migrate:guard`: OK (9 files additive-only).
- New unit tests (4), route tests (7), Apps Script tests pass. Existing recipe route, public-guard, mirror, beer-category and empty-tab tests pass unmodified.
- DB tests (Docker available): recipe-pg-target-gravity passes alone (5/5); recipe-pg-read, create, update, migration suites pass. In a combined 5-suite run the new suite once failed only in `afterAll` (container stop timeout under load, 700s run); the rerun alone passed.
- Lint clean. Frontend `npm test`: 3303 pass; a few unrelated UI tests (brewpad-batch-type-ui, kiosk-past-sales-range*) failed intermittently under load. kiosk ones pass on rerun; `brewpad-batch-type-ui` "change saves via update_batch" fails consistently (expects 1 POST, gets 2). No recipe or Apps Script code touched by that test; logged as deferred, not fixed (out of scope).

## Deviations from Plan

None to the implementation. Note: the route test's store mock needed `getMode` for the public-response case (test-only).

## Deferred Issues

- tests/frontend/brewpad-batch-type-ui.test.js "change saves via update_batch with nested updates" fails (2 POSTs vs 1); unrelated to this plan, likely pre-existing from earlier phase work. Needs confirmation on the base commit.

## Known Stubs

None.

## Notes for follow-up

- Apps Script redeploy is an owner step in plan 97-12.
- Migration 0009 runs on Railway via preDeployCommand.

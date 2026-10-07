---
phase: 85-recipes-recipeingredients-postgres
plan: 04
subsystem: apps-script
tags: [apps-script, recipes, mirror, postgres]
requires: []
provides:
  - mirror_recipe_state, mirror_recipe_delete, recipe_batch_ref_count server_token actions
affects: [85-05, 85-12]
key-files:
  modified: [apps-script/adminApi.gs]
  created: [tests/frontend/adminapi-recipe-mirror.test.js]
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 04: Apps Script recipe mirror actions Summary

Three additive, server_token-gated Apps Script actions: a verbatim, header-addressed recipe + ingredient state copy, an idempotent recipe delete, and a fresh read-only Batches reference count.

## What was done
- `mirrorRecipeState`: validates ids/shape, runs the pricing_mode and schedule_id self-migration helpers, writes the recipe row by header name (append or in-place setValues), removes the recipe's ingredient rows as descending contiguous runs, writes new ingredient rows with one setValues. No sanitizeInput.
- `mirrorRecipeDelete`: idempotent removal of ingredient rows then recipe row.
- `recipeBatchRefCount`: direct uncached Batches read, same string comparison as deleteRecipe, no lock, no writes.
- Dispatch registered inside the server_token block; both mirror actions call `_invalidateRecipeCache`.
- 19 behavioural tests (fake Sheets runtime) covering every behaviour line including the legacy-header case.

## Verification
Root `npm test` (2128 pass), `npm run lint` clean, `zoho-middleware` `npm test` (2291 pass). Diff to adminApi.gs is additions only (no removed lines).

## Commits
- aa16de61: feat(85-04) actions + tests (Tasks 1 and 2 committed together because both touch the same test file; RED was confirmed first with 19 failing tests)

## Deviations from Plan
Tasks 1 and 2 share one commit rather than two (single shared test file). Otherwise none.

## Notes
Not deployed: the Apps Script redeploy is an owner action (85-12). No stubs. No new threat surface beyond the plan's threat model.

## Self-Check: PASSED

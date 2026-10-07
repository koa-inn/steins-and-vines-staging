---
phase: 85-recipes-recipeingredients-postgres
plan: 07
subsystem: api
tags: [postgres, recipes, routes, store-flag, optimistic-lock, es5]
requires:
  - phase: 85-06
    provides: "lib/recipe-store.js facade"
provides:
  - "routes/recipes.js fully routed through recipeStore (list/get/create/update/remove)"
  - "D-03 409 stale_recipe mapping on PUT and DELETE"
  - "Mode-aware caching: sv:recipes list/detail caches bypassed unless RECIPES_STORE=sheets"
affects: [85-08, 85-09]
key-files:
  modified:
    - zoho-middleware/routes/recipes.js
  created:
    - zoho-middleware/__tests__/recipes-store-mode.test.js
key-decisions:
  - "Cache gating is per request via recipeStore.getMode() === 'sheets'; sheets mode keeps the identical cache and axios call order"
  - "expected_updated_at is stripped from the PUT body in every mode; DELETE reads it from ?expected_updated_at"
  - "callAppsScriptPost removed from the route (the facade owns the transport); fetchFermSchedules still uses axios.get"
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 07: Recipe routes through the store facade Summary

Every recipe endpoint now goes through `lib/recipe-store.js`. Sheets mode behaves as before (same Apps Script calls and Redis caching). In dual and postgres the read caches are bypassed and a stale or missing `expected_updated_at` returns the D-03 409 body.

## Tasks

| Task | Commit |
|------|--------|
| 1. Reads through the facade, mode-aware caching | f42f1d85 |
| 2. Writes through the facade, 409 mapping, helper removal | 9e30c6d2 |

## Behaviour

- List, detail, availability and `enrichListPrices` call `recipeStore.list/get`. In postgres modes list and detail skip `cache.get/set` for `sv:recipes` keys, and the list `source` is `'postgres'`.
- `toPublicRecipe`, `enrichFermentDays`, `isRecipeStaff`, `bustRecipeCache` and the bust-cache route are unchanged. Anonymous drafts still return 404, and `ferment_days` is still derived from `schedule_id`.
- PUT: `expected_updated_at` is removed from the payload and passed as `{expectedUpdatedAt}`. DELETE passes `req.query.expected_updated_at`. A store result of `stale_recipe` returns 409 `{error:'This recipe was changed since you opened it — reload to see the latest', code:'stale_recipe'}`.
- `validateIngredientUnits` (422 `unit_mismatch`) and the activation guardrail run before any store write in every mode. Both are tested per mode.
- Store rejections, including `batch_ref_unavailable`, map to the existing 502 messages.

## Verification

- recipes-store-mode: 20 new tests. Existing `recipes.test`, `recipes-public-guard` and `brewpad-recipe` pass unmodified (115 tests across the four suites).
- Middleware `npm test`: 158 suites / 2476 tests. Root `npm test`: 150 suites / 2152 tests. Middleware lint is clean.

## Deviations from Plan

None to the plan's behaviour. Process note: the Task 1 route edit was written before the new test file (tests were not seen failing first), so Task 1 was not a strict RED-first cycle.

## Notes for 85-08 and later

- The postgres-mode mapping of `invalid_data`, `missing_fields` and `missing_id` is 422 `save_failed` on PUT and POST, via the existing `!data.ok` branch (today's route status). It is not the 400 suggested in the 85-06 notes, because the plan said to leave other status codes identical. Say so if you want 400.
- Missing-token rejection lives in recipe-pg (orchestrator decision), and the route just forwards `undefined`.
- Worktree base: HEAD was reset to d307b523 per the startup check. node_modules symlinks were removed before return.

## Known Stubs

None.

## Threat Flags

None. T-85-38..42 mitigated as planned (allow-list projection, draft 404, 409 mapping, guards before write, cache bypass).

## Self-Check: PASSED

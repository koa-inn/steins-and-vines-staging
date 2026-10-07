---
phase: 85-recipes-recipeingredients-postgres
plan: 03
subsystem: database
tags: [postgres, recipes, row-lock, optimistic-concurrency, es5]
requires:
  - phase: 85-01
    provides: "recipe-rules (planIngredientIds, recipeIngredientsUnchanged)"
  - phase: 85-02
    provides: "recipe-pg reads and createRecipe"
provides:
  - "recipe-pg.updateRecipe and deleteRecipe (one transaction each, select ... for update)"
  - "Real-PG suites for update, delete and rename latency"
affects: [85-06]
key-files:
  modified: [zoho-middleware/lib/recipe-pg.js]
  created:
    - zoho-middleware/__tests__/db/recipe-pg-update.test.js
    - zoho-middleware/__tests__/db/recipe-pg-delete.test.js
    - zoho-middleware/__tests__/db/recipes-rename-latency.test.js
key-decisions:
  - "D-03 token compared by epoch-ms against the locked row; missing/empty/unparseable token is stale_recipe"
  - "deleteRecipe throws 'batchRefCount required' unless given a finite non-negative integer (fail closed)"
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 03: recipe update and delete Summary

`updateRecipe` and `deleteRecipe` in `lib/recipe-pg.js` run under a recipes row lock with a D-03 stale-editor check. Update applies the parity-proven D-04 skip and D-09 id rules.

## Tasks

| Task | Commit |
|------|--------|
| 1. updateRecipe (+ deleteRecipe, written in same edit) + update suite | 9929b3ef |
| 2. delete suite + rename latency suite | d1360e1c |

## Verification

- `npm run test:db`: 15 suites, 111 tests passed (new: 16 tests in 3 suites, ran against real Postgres, not skipped).
- `npm test`: 153 suites, 2376 tests passed. `npm run lint`: clean.
- Rename latency (20 renames, 20 ingredients): p50=1.0 ms p95=1.2 ms max=1.6 ms (bound: p95 < 500, max < 2000).

## Deviations from Plan

- **[Process] TDD ordering:** tests were written alongside the implementation and committed together with it (deleteRecipe code landed in the Task 1 commit, its tests in the Task 2 commit); no separate RED commits. All tests passed on first run.
- **Explained differences from Apps Script (consistent with 85-02):** non-finite numerics, status outside draft/active/inactive, non-array ingredients and invalid ingredients JSON return `invalid_data` and write nothing (Sheets wrote row fields first / stored anything). Validation runs before the lock.
- Update semantics kept faithful: `Number(payload.x)` for provided numerics (so `''`/null become 0, as in Apps Script); empty optional strings stored as NULL (read back as ''); `name` stored as given (NOT NULL).
- not_found message matches Apps Script: `Recipe not found: <id>`.

## Known Stubs

None.

## Threat Flags

None. T-85-21..26 mitigated: epoch-ms token after `for update` with two-client concurrency test; own/unclaimed ids only; throwing delete without batchRefCount; injected-failure atomicity test; fixed column allow-list with `$n` placeholders; no network I/O inside the transaction.

## Self-Check: PASSED

Files and commits exist; node_modules symlink removed before return.

---
phase: 85-recipes-recipeingredients-postgres
plan: 01
subsystem: database
tags: [postgres, migration, recipes, apps-script-parity, es5]
requires:
  - phase: 83-postgres-infrastructure
    provides: migration runner, allowlist guard, pg-harness
provides:
  - "0003_recipes.sql: recipes + recipe_ingredients tables, two ID sequences"
  - "lib/recipe-rules.js: sanitizeInput, normalizePricingMode, normalizeRecipeIngredientTuple, recipeIngredientsUnchanged, planIngredientIds"
  - "Parity tests proving the ports match the real adminApi.gs"
affects: [85-02, 85-03, 85-10]
tech-stack:
  added: []
  patterns: ["new Function harness over adminApi.gs with fake SpreadsheetApp/LockService for runtime parity"]
key-files:
  created:
    - zoho-middleware/migrations/0003_recipes.sql
    - zoho-middleware/lib/recipe-rules.js
    - zoho-middleware/__tests__/db/recipes-migration.test.js
    - zoho-middleware/__tests__/recipe-rules-parity.test.js
    - zoho-middleware/__tests__/recipe-d09-runtime-parity.test.js
  modified: []
key-decisions:
  - "Unconstrained numeric for all quantities/prices so 4-dp values (0.0055) never round"
  - "position column + unique (recipe_id, position); no uniqueness on (recipe_id, item_id)"
  - "schedule_id is a plain column, no FK (Phase 86 owns ferm_schedules)"
requirements-completed: [DB-04]
duration: ~25min
completed: 2026-10-07
---

# Phase 85 Plan 01: Recipes schema and Apps Script rule parity Summary

Additive `0003_recipes.sql` (sequence-backed SV-R-/RI- ids, position-ordered ingredients, no item uniqueness) plus `lib/recipe-rules.js`, ES5 ports of the Apps Script recipe rules proven identical to the real `adminApi.gs`, including the Phase 79 D-09 id-honouring planner checked against the real `updateRecipe` run under a fake Sheets runtime.

## Tasks

| Task | Commits |
|------|---------|
| 1. Migration + real-PG test | b4e317db (RED), f1db4ca5 (GREEN) |
| 2. recipe-rules.js + function parity | b1c89b8c (RED), bfd7f336 (GREEN) |
| 3. Runtime parity (six sequences a-f) | 8461498d |

## Verification

- `npm run migrate:guard`: OK (3 files).
- `npm run test:db -- recipes-migration migrations`: ran against real Postgres (Docker was up), 9 + 3 tests passed (not skipped).
- `npx jest recipe-rules-parity recipe-d09-runtime-parity`: 68 passed.
- `cd zoho-middleware && npm test`: 151 suites, 2359 tests passed. `npm run lint`: clean.
- `apps-script/adminApi.gs` untouched. Root `npm test` not run (no root files changed).

## Deviations from Plan

- **[Rule 1 - Bug] Lint:** initial `== null` checks in recipe-rules.js tripped `eqeqeq` (max-warnings 0); replaced with explicit `=== null || === undefined` (same semantics).
- Task 3 had no RED phase: the test exercises code already delivered in Task 2, so it passed on first run (it was verified to genuinely call the real `updateRecipe`).
- Worktree setup: branch was behind the required base, so `git reset --hard 50a60e5e` was performed per the startup instruction. `node_modules` in the worktree are untracked symlinks to the main checkout's (not committed).
- Test-only addition: sequence b includes a fourth id-less row so the minted classification is exercised.

## Known Stubs

None.

## Threat Flags

None. T-85-01..04 mitigated as planned (additive DDL passing the guard, CHECK/FK/unique constraints, sanitizeInput parity, own-unclaimed-id-only planner).

## Self-Check: PASSED

All five created files exist; commits b4e317db, f1db4ca5, b1c89b8c, bfd7f336, 8461498d present.

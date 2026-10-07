---
phase: 85-recipes-recipeingredients-postgres
plan: 02
subsystem: database
tags: [postgres, recipes, apps-script-parity, es5, transactions]
requires:
  - phase: 85-01
    provides: "0003_recipes.sql schema and lib/recipe-rules.js"
provides:
  - "lib/recipe-pg.js: rowToRecipe, rowToIngredient, listRecipes, getRecipe, listRecipeIds, createRecipe"
  - "Synthetic Apps Script response fixture and real-PG shape-parity + create/atomicity suites"
affects: [85-03, 85-10]
tech-stack:
  added: []
  patterns: ["client-injected atomic SQL layer (gift-card-pg style)", "wrapped client.query failure injection for atomicity proof"]
key-files:
  created:
    - zoho-middleware/lib/recipe-pg.js
    - zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json
    - zoho-middleware/__tests__/db/recipe-pg-read.test.js
    - zoho-middleware/__tests__/db/recipe-pg-create.test.js
  modified: []
key-decisions:
  - "Validation (name, ingredients JSON, finite numerics, status set) runs before the first write; failures resolve invalid_data and write nothing (A5)"
  - "Empty optional text is stored as NULL and read back as ''; item_id stays '' (NOT NULL column)"
  - "limit 0 maps to LIMIT NULL (unbounded) so offset-only windows share one query"
requirements-completed: [DB-04]
duration: ~20min
completed: 2026-10-07
---

# Phase 85 Plan 02: recipe-pg reads and atomic create Summary

`lib/recipe-pg.js` serves recipe list/detail from Postgres in byte-identical Apps Script shapes (proved with JSON.stringify against a synthetic fixture) and creates a recipe plus all ingredients in one transaction with sequence-minted IDs.

## Tasks

| Task | Commit |
|------|--------|
| 1. Serializers + reads + fixture + read suite | 9d73ae1d |
| 2. createRecipe + create/atomicity suite (+ lint fix) | see git log (feat(85-02): createRecipe ...) |

## Verification

- `npm run test:db -- recipe-pg`: ran against real Postgres (Docker up, not skipped); 2 suites, 16 tests passed.
- `cd zoho-middleware && npm test`: 151 suites, 2359 tests passed. `npm run lint`: clean.
- Fixture grep for `@|steins`: 0 matches. No `require('pg')` in recipe-pg.js.

## Deviations from Plan

- **[Process] TDD ordering:** tests and implementation for Task 1 were committed together (no separate RED commit); createRecipe was written in the same file draft as the reads, so it first landed in the Task 1 commit and its tests in the Task 2 commit. The RED state was not committed separately.
- **[Rule 1 - Bug] Lint:** `catch (e)` with unused binding failed `--max-warnings 0`; changed to `catch {` (fixed in the Task 2 commit; Task 1 commit alone carries the warning).
- **Explained difference (A5):** non-finite numerics and statuses outside draft/active/inactive are rejected with `invalid_data`; Sheets would have stored NaN or any string. Non-array `ingredients` is also rejected as `invalid_data`.

## Known Stubs

None.

## Threat Flags

None. T-85-16..20 mitigated: `$n` placeholders with constant SQL, sanitizeInput on the same fields as Apps Script, single transaction with injected-failure test, pre-write validation, synthetic fixture.

## Self-Check: PASSED

Created files exist; commits present; worktree node_modules symlink removed before return.

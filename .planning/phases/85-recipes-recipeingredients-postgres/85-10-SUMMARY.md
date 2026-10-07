---
phase: 85-recipes-recipeingredients-postgres
plan: 10
subsystem: database
tags: [postgres, backfill, recipes, xlsx, es5]
requires:
  - phase: 85-01
    provides: "0003_recipes.sql (recipes, recipe_ingredients, two id sequences)"
  - phase: 84
    provides: "gift-cards-backfill.js operating pattern"
provides:
  - "specs/recipes.js: two-table column spec (18 + 6), not registered in specs/index.js"
  - "recipes-backfill.js: buildRecipesBackfillPlan (pure) + runRecipesBackfill CLI"
affects: [85-11, 85-13]
tech-stack:
  added: []
  patterns: ["reject-not-coerce planner with generic reason codes", "one-transaction promote with max-suffix setval and in-transaction invariants"]
key-files:
  created:
    - zoho-middleware/scripts/backfill/specs/recipes.js
    - zoho-middleware/scripts/backfill/recipes-backfill.js
    - zoho-middleware/__tests__/backfill/recipes-spec-headers.test.js
    - zoho-middleware/__tests__/backfill/recipes-backfill-plan.test.js
    - zoho-middleware/__tests__/db/recipes-backfill.test.js
  modified: []
key-decisions:
  - "Reject reasons are generic codes (invalid_timestamp, invalid_number, ...) because normalize.js reasons echo cell values (created_by can be a staff email)"
  - "same_item_rows check compares DB redundant-row count (rows minus distinct items) with the plan for SV-R-000002 rather than hardcoding 3, so synthetic fixtures pass while the real 3-row case is still enforced"
  - "runRecipesBackfill(argv, deps) returns the exit code; deps.planHook is a test-only seam to prove rollback"
requirements-completed: [DB-04]
duration: ~35min
completed: 2026-10-07
---

# Phase 85 Plan 10: Recipes backfill Summary

A dedicated two-table CLI turns the Recipes and RecipeIngredients tabs of an owner-downloaded .xlsx into `recipes` and `recipe_ingredients` with ids unchanged, `position` from sheet row order, no item-level collapsing, rejects instead of coercion, and both id sequences seeded from the max suffix in one transaction.

## Tasks

| Task | Commits |
|------|---------|
| 1. Spec + pure planner | 516ab67e (RED), 3b4b4382 (GREEN) |
| 2. CLI + promote + real-PG test | 11955f08 (RED), e2770173 (GREEN) |

## Verification

- `npm run test:db -- recipes-backfill`: ran against real Postgres (Docker up), 8/8 passed, not skipped.
- `npx jest backfill`: 15 suites, 180 tests passed (existing spec-headers suite unmodified).
- `cd zoho-middleware && npm test`: 153 suites, 2376 tests passed. `npm run lint`: clean.
- Acceptance greps: no "recipes" in specs/index.js; no dedupe/distinct-on/group-by-item_id in the CLI; one `setval` each for both sequences; no `new Pool`; BACKFILL_DATABASE_URL used.
- No backfill was run against any real database or the live sheet. Root `npm test` not run (no root files changed).

## Behaviour notes for 85-11 / 85-13

- Any reject blocks promote (exit 2); there is no --accept-rejects. SV-R-000001's swapped created_at/created_by is rejected as `Recipes / SV-R-000001 / created_at / invalid_timestamp`; the owner must fix the live cells (85-13 checkpoint).
- Per plan, empty `status` or `pricing_mode` is a reject (columns required). If older live recipe rows have a blank pricing_mode they will show up as rejects on the first dry run and need a sheet fix; flagging in case the owner would rather default blanks to `locked`.
- A failed promote rolls back rows but not `setval` (Postgres sequences are non-transactional); harmless since tables stay empty and the next promote re-seeds.
- Exit codes: 0 ok, 1 error, 2 rejects, 3 in-transaction check failed. Reject output lists sheet, row, id, field, reason only.
- Rejects-report filenames have one-second resolution, so two runs in the same second overwrite each other (existing rejects.js behaviour, not changed).

## Deviations from Plan

- Worktree HEAD was behind the required base; `git reset --hard 28e1c3da` was run per the startup instruction.
- Numeric spec columns use scale 6 (the normaliser's decimal-place limit); trailing zeros are then trimmed so stored values match the sheet. Values finer than 6 dp are rejected rather than rounded.
- Test (c) uses a fresh `--out-dir` because reports are named with second-resolution timestamps.

## Known Stubs

None.

## Threat Flags

None. T-85-50..55 mitigated as planned (reject-not-coerce, empty-target preconditions + single transaction + invariants, setval from max with a test minting max+1, ids/counts-only output, env-only DB URL, DB-name prompt).

## Self-Check: PASSED

All five created files exist; commits 516ab67e, 3b4b4382, 11955f08, e2770173 present.

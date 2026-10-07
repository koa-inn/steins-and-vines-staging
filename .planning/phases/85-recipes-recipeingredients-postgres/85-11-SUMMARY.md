---
phase: 85-recipes-recipeingredients-postgres
plan: 11
subsystem: database
tags: [postgres, verify, replay, runbook, recipes, es5]
requires:
  - phase: 85-02
    provides: "recipe-pg listRecipeIds/getRecipe serialisers"
  - phase: 85-05
    provides: "recipe-mirror mirror_recipe_state payload shape"
  - phase: 85-10
    provides: "buildRecipesBackfillPlan sheet-side normalisation"
provides:
  - "recipes-verify.js: compareRecipes (pure) + read-only runVerify CLI"
  - "recipes-replay-to-sheet.js: buildReplayPayloads + dry-run-default runReplay CLI"
  - "RUNBOOK 'Recipes -> Postgres (Phase 85)' section (13 subsections)"
  - "85-DUAL-LOG.md template"
affects: [85-13]
tech-stack:
  added: []
  patterns: ["read-only transaction verify reusing the backfill planner", "sequential idempotent replay stopping at first failure"]
key-files:
  created:
    - zoho-middleware/scripts/backfill/recipes-verify.js
    - zoho-middleware/scripts/backfill/recipes-replay-to-sheet.js
    - zoho-middleware/__tests__/backfill/recipes-verify.test.js
    - zoho-middleware/__tests__/backfill/recipes-replay-to-sheet.test.js
    - .planning/phases/85-recipes-recipeingredients-postgres/85-DUAL-LOG.md
  modified:
    - docs/RUNBOOK.md
    - zoho-middleware/scripts/backfill/README.md
key-decisions:
  - "Verify compares ingredients by ingredient_id (item_id, quantity, unit) and reports order/count against the recipe id; item_name is not compared (denormalised display copy)"
  - "Replay posts a JSON-string body with the same headers/timeout as lib/recipe-mirror.js rather than importing it (that module pulls in cache/sentry); payload is {recipe, ingredients} from recipePg.getRecipe"
requirements-completed: [DB-04]
duration: ~40min
completed: 2026-10-07
---

# Phase 85 Plan 11: Recipes verify, replay and runbook Summary

Read-only Postgres-vs-fresh-.xlsx verify (ids and field names only) and a dry-run-default replay-to-sheet repair/rollback tool, plus the full Phase 85 RUNBOOK procedure and the dual-window log template.

## Tasks

| Task | Commits |
|------|---------|
| 1. verify + replay CLIs with tests | 7ab78129 (RED), 6d0a84fe (GREEN) |
| 2. RUNBOOK section, README, 85-DUAL-LOG.md | d1ea54dd |

## Verification

- `npx jest backfill/recipes`: 4 suites, 36 tests passed.
- `cd zoho-middleware && npm test`: 156 suites, 2413 tests passed; `npm run lint` clean; root `npm run lint` clean.
- Acceptance greps for Task 2 all met (RUNBOOK header 1, TOCTOU, pre-open mirror write, recipes-dual-price, README equals-form examples, DUAL-LOG tables).
- No script was run against a real database, the live sheet or Apps Script; tests use fake pools and mocked axios only. `test:db` not run (no DB-touching code beyond constant reads).

## Notes for 85-13

- RUNBOOK section 3 has a blank "Phase 85 Apps Script versions" line and section 13 a blank staging candidate SHA for the owner / 85-13 to fill.
- RUNBOOK section 4 tells the owner what to do if the first dry run rejects legacy rows with blank status/pricing_mode (fix the cell, or request a code change to default `locked`).
- Plan text mentions "85-08" log lines (`[dual-price] compared|skip`, component `recipes-dual-price`); they are documented in the RUNBOOK but not verified here since 85-08 was not yet merged.

## Deviations from Plan

- Worktree HEAD was behind the required base; `git reset --hard 72b85816` was run per the startup instruction.
- Replay does not import `lib/recipe-mirror.js`; the payload builder is duplicated (3 lines) to avoid loading cache/sentry in a CLI. Shape is asserted in the replay test.
- RED test fixture for the PG row used `''` for empty numerics, which real Postgres never returns (null); fixed in the test fixture in the GREEN commit.

## Known Stubs

None. Blank cells in 85-DUAL-LOG.md and the RUNBOOK SHA/version placeholders are intentional owner-fill fields.

## Threat Flags

None. T-85-56..60 mitigated: read-only transaction (test asserts no write SQL), dry-run default with `--apply` and stop-on-first-failure, ids/fields only (test asserts values absent), runsheet cleanup procedure, ordering gate in RUNBOOK section 0.

## Self-Check: PASSED

All created files exist; commits 7ab78129, 6d0a84fe, d1ea54dd present.

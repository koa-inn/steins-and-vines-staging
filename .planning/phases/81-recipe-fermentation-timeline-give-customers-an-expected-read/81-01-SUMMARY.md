---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 01
subsystem: apps-script
tags: [apps-script, recipes, ferm-schedules, cache, tdd]
dependency-graph:
  requires: []
  provides:
    - "Recipes.schedule_id column (self-migrating, appended lazily on first write)"
    - "createRecipe/updateRecipe persist schedule_id via header lookup"
    - "'gfs' script-cache eviction on FermSchedules create/update/delete"
  affects:
    - "apps-script/adminApi.gs"
tech-stack:
  added: []
  patterns:
    - "Self-migrating sheet column (ensureRecipesPricingModeColumn precedent), copied verbatim for schedule_id"
    - "D-08 ordering: ensure-column BEFORE invalidateSheetCache BEFORE findRowById, to avoid a stale-width batched write"
    - "Single-key CacheService.remove('gfs') instead of the batch-cache-wide _invalidateBatchCache helper"
key-files:
  created:
    - tests/frontend/adminapi-recipe-schedule-column.test.js
  modified:
    - apps-script/adminApi.gs
decisions:
  - "D-03 (phase-level, referenced): schedule_id is the single source of truth for the customer-facing fermentation figure -- no separate ferment_days column on Recipes"
metrics:
  duration: "~4 min (task-commit timestamps)"
  completed: 2026-09-05
---

# Phase 81 Plan 01: Recipes.schedule_id column + FermSchedules cache-bust Summary

Gave the `Recipes` sheet a self-migrating `schedule_id` column persisted by `createRecipe`/
`updateRecipe`, and closed a pre-existing gap where editing a `FermSchedules` template never
busted the Apps Script `'gfs'` read cache.

## What Was Built

**Task 1 — `ensureRecipesScheduleIdColumn` + persistence (TDD, RED→GREEN):**
- `ensureRecipesScheduleIdColumn(sheet)` — a byte-for-byte structural copy of the existing
  `ensureRecipesPricingModeColumn` precedent (`apps-script/adminApi.gs`). Appends `schedule_id`
  at `lastCol + 1` (bold) when absent and returns the new zero-based index; returns the existing
  index and writes nothing when the column is already present. No enum normalizer — `schedule_id`
  is a free string ID, not `pricing_mode`'s `locked|dynamic`.
- `createRecipe`: mirrors the existing `pmCol` block — ensures the column, then writes
  `sanitizeInput(payload.schedule_id || '')` into the newly appended row via header lookup (not
  the positional `appendRow([...])` array, which would land in the wrong cell).
- `updateRecipe`: `ensureRecipesScheduleIdColumn(recipesSheet)` runs immediately after
  `ensureRecipesPricingModeColumn`, both BEFORE `invalidateSheetCache(RECIPES_SHEET_NAME)` (the
  existing D-08 ordering comment was extended, not replaced, naming `schedule_id` so the
  load-bearing reason survives: either ensure-function may widen the header row, and
  `findRowById` below must re-read the new width from a freshly invalidated cache). `'schedule_id'`
  was added to the `stringFields` array, routing it through the existing
  `sanitizeInput` + batched-`setValues`/per-cell-formula-fallback path with zero new branching.
  `sanitizeInput(null)` returns `''`, so a frontend sending `schedule_id: null` correctly clears
  the field.
- New test file `tests/frontend/adminapi-recipe-schedule-column.test.js`: a fake-Sheets-runtime
  harness (`new Function` + injected `SpreadsheetApp`/`Logger`, copying
  `adminapi-waitlist-ensure-sheet.test.js`'s pattern) exercising all 4 `<behavior>` cases from the
  plan: append-when-absent, return-existing-when-present, idempotent-on-repeat-call, and
  no-disturbance to the sibling `pricing_mode` column when both are absent and both ensure-functions
  run in sequence.

**Task 2 — `'gfs'` cache-bust on FermSchedules CRUD (pre-existing bug fix, own commit):**
- `CacheService.getScriptCache().remove('gfs')` added to the success path of `createFermSchedule`,
  `updateFermSchedule` and `deleteFermSchedule`, immediately before each function's
  `return { ok: true, ... }`. Single-key `.remove('gfs')`, not `_invalidateBatchCache` (which
  would also evict `gbl`/`gtu`/`gbds`/`gbi`/`gb:<id>` batch-list keys these three functions have
  no reason to touch). `'gfs'` was already present in `_invalidateBatchCache`'s key list but
  unreachable from schedule CRUD — a staff member's own template edit stayed invisible to the next
  `get_ferm_schedules` read (`handleReadAction`'s `_cachedGet('gfs', 300, ...)`) for up to 300s.
  This phase makes template day-offsets load-bearing for public marketing copy for the first
  time (D-15 ships a staff warning this same phase), so closing the window here — in a file
  already being edited, with a verified analog — is deliberate, not scope creep.
- Extended the same test file with a `describe` block asserting SOURCE SHAPE only for the three
  functions: each function body contains `remove('gfs')` and does NOT contain
  `_invalidateBatchCache`. These three functions call `SpreadsheetApp`/`LockService` throughout and
  cannot be executed in the Jest sandbox — this is the same documented ceiling
  `adminapi-recipe-pure.test.js` records for its own scope. The real gate is the live probe in
  plan 81-07.

## Verification

- `grep -c 'function ensureRecipesScheduleIdColumn' apps-script/adminApi.gs` → 1
- `grep -c "indexOf('schedule_id')" apps-script/adminApi.gs` → 2 (the ensure-function's own check
  plus the pattern documented in the plan)
- `grep -n "'notes', 'schedule_id'"` matches inside `updateRecipe`'s `stringFields` array
- `ensureRecipesScheduleIdColumn(recipesSheet)` appears in both `createRecipe` and `updateRecipe`;
  in `updateRecipe` its line is after `ensureRecipesPricingModeColumn` and before
  `invalidateSheetCache(RECIPES_SHEET_NAME)`
- The literal `schedule_id` does NOT appear inside `createRecipe`'s `appendRow([` array
- `grep -c "remove('gfs')"` → 3
- `grep -c "get_ferm_schedules"` → 4 (unchanged from pre-plan; no new dispatch entry added — no
  Apps Script action surface change, confirmed against `doPost`'s allowlist and `doGet`'s existing
  read-path dispatch, neither of which this plan touched)
- `npx jest tests/frontend/adminapi-recipe-schedule-column.test.js --config jest.config.js` → 7/7
  passing (note below on the standalone-invocation coverage-threshold artifact)
- `npm test` (full frontend suite) → **109 suites / 1650 tests green**
- `npm run lint` → clean
- `git diff --name-only` across both tasks touches only `apps-script/adminApi.gs` and the one new
  test file — no pre-existing test file modified

**Note on the plan's literal single-file `<verify>` command:** running
`npx jest tests/frontend/adminapi-recipe-schedule-column.test.js --config jest.config.js` in
isolation exits 1, not 0 — but this is a pre-existing artifact of `jest.config.js`'s
`collectCoverage: true` + `coverageThreshold: { global: { lines: 5 } }`, which is checked against
a fixed 5-file `collectCoverageFrom` list regardless of which test file actually ran. Reproduced
identically against the pre-existing `adminapi-waitlist-ensure-sheet.test.js` run standalone (also
exits 1) — confirming this is not something this plan's changes caused. The tests themselves report
`Tests: 7 passed, 7 total` in both the standalone and full-suite runs; `npm test` (the project's
actual test-gate command, per `CLAUDE.md` rule 1) exits 0 with all 1650 tests green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Cache-bust comment text collided with its own negative-assertion test**
- **Found during:** Task 2, GREEN step
- **Issue:** The explanatory comment placed above each `CacheService.getScriptCache().remove('gfs')`
  call originally referenced the sibling helper by name ("...not `_invalidateBatchCache` -- that
  call also evicts batch-list keys..."), which made the function body literally contain the
  substring `_invalidateBatchCache` — failing the new test's `not.toEqual(expect.stringContaining
  ('_invalidateBatchCache'))` assertion for a reason unrelated to the actual behavior under test
  (the code correctly calls the single-key `.remove('gfs')`, not the batch-wide helper; only the
  comment's prose mentioned the helper's name).
- **Fix:** Reworded the three comments to describe the batch-cache-wide helper without naming its
  identifier literally (e.g. "the batch-cache-wide helper" instead of `_invalidateBatchCache`),
  preserving the same explanatory content.
- **Files modified:** `apps-script/adminApi.gs` (three comment blocks, no logic change)
- **Commit:** `d85a78a2` (folded into the Task 2 GREEN commit — caught before that commit was made)

Otherwise: plan executed exactly as written.

## Threat Model Coverage

All 6 threats in the plan's STRIDE register were addressed as specified, verified against the
final diff:
- **T-81-01** (Tampering, `schedule_id` value) — `createRecipe` calls `sanitizeInput` directly;
  `updateRecipe` gets it free via the `stringFields` loop's existing `sanitizeInput` call
- **T-81-02** (Tampering, header widen) — append-only at `lastCol + 1`, `indexOf`-guarded,
  idempotent; D-08 ordering preserved and extended
- **T-81-03** (Information disclosure) — no change made to `PUBLIC_RECIPE_FIELDS` or any
  middleware file; `schedule_id` remains staff-only source-side, per this plan's explicit scope
- **T-81-04** (Elevation of privilege) — no new action added to `doPost`'s allowlist or `doGet`;
  `get_ferm_schedules` grep count unchanged (4, pre- and post-plan)
- **T-81-05** (DoS via cache eviction) — accepted per plan; single-key `.remove` used, not the
  batch-wide helper
- **T-81-SC** (package legitimacy) — accepted, N/A; zero packages installed

No new threat surface was introduced beyond what the plan's threat model already covers.

## Known Stubs

None. Both tasks ship complete, tested behavior — no placeholder values or unwired data paths.

## Auth Gates

None encountered.

## Rollback / Deploy Note

Per the plan's `<output>` instruction: this plan changes **source only** and deploys nothing. The
exact rollback target for the eventual Apps Script redeploy (which serves both staging AND
production from one deployment) is captured in plan 81-07, not here.

## Commits

- `4cc62864` — `test(81-01): add failing test for schedule_id column self-migration` (RED)
- `762d6e5b` — `feat(81-01): self-migrating schedule_id column persisted by createRecipe/updateRecipe` (GREEN)
- `269ba499` — `test(81-01): add failing source-shape test for FermSchedules gfs cache-bust` (RED)
- `d85a78a2` — `fix(81-01): bust the 'gfs' schedule cache on create/update/delete of a FermSchedules template` (GREEN)

## TDD Gate Compliance

Both tasks followed RED → GREEN:
- Task 1: `test(...)` commit `4cc62864` precedes `feat(...)` commit `762d6e5b`. Fail-fast rule
  observed — all 4 tests failed with `TypeError: api.ensureRecipesScheduleIdColumn is not a
  function` before implementation, none passed unexpectedly.
- Task 2: `test(...)` commit `269ba499` precedes `fix(...)` commit `d85a78a2`. All 3 new
  source-shape tests failed against the real, unmodified `adminApi.gs` before implementation
  (confirming the pre-existing gap), then passed after the fix.

No REFACTOR-stage commit was needed for either task.

## Self-Check: PASSED

- FOUND: `apps-script/adminApi.gs`
- FOUND: `tests/frontend/adminapi-recipe-schedule-column.test.js`
- FOUND: `.planning/phases/81-recipe-fermentation-timeline-give-customers-an-expected-read/81-01-SUMMARY.md`
- FOUND: `4cc62864`, `762d6e5b`, `269ba499`, `d85a78a2`, `df3c959e` (all commits verified in `git log --oneline --all`)

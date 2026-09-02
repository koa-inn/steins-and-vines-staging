---
phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a
plan: 02
subsystem: infra
tags: [apps-script, jest, pure-functions, tdd, recipe-ingredients]

# Dependency graph
requires:
  - phase: 79-01
    provides: "Confirmed root-cause diagnosis: the 502 on PUT /api/recipes/:id is the axios 15000ms client timeout, unblocking the round-trip-reduction fixes"
provides:
  - "Four pure helper functions in apps-script/adminApi.gs (formatPaddedId, maxIdNumFromColumn, normalizeRecipeIngredientTuple, recipeIngredientsUnchanged) — not yet wired into updateRecipe"
  - "A local Jest harness (tests/frontend/adminapi-recipe-pure.test.js) that loads the real apps-script/adminApi.gs source text and evaluates it, giving npm test a syntax gate for a 4,116-line file with zero prior coverage"
  - "Local test coverage of the D-04 ingredient-comparison logic in both failure directions before any call site uses it"
affects: [79-03, 79-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Testing a vendored .gs file's pure logic via fs.readFileSync + new Function sandbox evaluation, without mocking Apps Script globals — established here for the first time in this repo"

key-files:
  created:
    - tests/frontend/adminapi-recipe-pure.test.js
  modified:
    - apps-script/adminApi.gs

key-decisions:
  - "normalizeRecipeIngredientTuple never case-folds item_id or unit and never treats a non-finite quantity as matching anything — every ambiguity resolves toward 'changed' per the plan's asymmetric-risk framing (a false 'changed' is a harmless wasted rewrite; a false 'unchanged' silently discards a user's edit)"
  - "recipeIngredientsUnchanged is order-sensitive and length-sensitive, and forces false immediately if any tuple on either side carries the '!nonfinite' sentinel — two independently-unparseable quantities must never be treated as an unchanged match"
  - "Quantity keys are rounded to 9 decimal places (Math.round(n * 1e9) / 1e9) to absorb Sheets/JSON float drift (e.g. 0.1 + 0.2) without merging real differences at brewing magnitudes (0.01 vs 0.011 must still differ)"
  - "The four helpers are placed immediately after generateNextId (before its comment block) so all id-minting logic stays co-located, per the plan's <interfaces> placement instruction"
  - "Fixed a bug in my own RED-stage test assertion (not the implementation): NaN and Infinity are themselves non-finite, so they legitimately share the '!nonfinite' sentinel with the string 'abc' — the original assertion wrongly claimed they must differ. Corrected before the GREEN commit."

requirements-completed: [RECIPE-SAVE-01]

# Metrics
duration: ~25min
completed: 2026-09-02
---

# Phase 79 Plan 02: Pure helpers for recipe-ingredient comparison and id minting Summary

**Added four pure, locally-tested helper functions to `apps-script/adminApi.gs` — `formatPaddedId`, `maxIdNumFromColumn`, `normalizeRecipeIngredientTuple`, and `recipeIngredientsUnchanged` — specified with a RED test suite first, covering both directions of the D-04 comparison's asymmetric failure risk before any code calls them.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-02 (approx.)
- **Completed:** 2026-09-02
- **Tasks:** 2 (both `type="auto" tdd="true"`)
- **Files modified:** 2 (`tests/frontend/adminapi-recipe-pure.test.js` created, `apps-script/adminApi.gs` modified)

## Accomplishments

- Wrote a Jest harness that reads `apps-script/adminApi.gs` from disk via `fs.readFileSync` and evaluates the real source with `new Function` — no copy, no mock, no stub of Apps Script globals. A separate `evaluateSourceOnly()` path evaluates just the raw file body (no helper references) so the "adminApi.gs parses and evaluates without throwing" test is a true syntax gate independent of whether the new helpers exist yet.
- Confirmed the file's top-level-statement assumption holds: `grep -n '^[a-zA-Z_$]' apps-script/adminApi.gs | grep -v ':function '` returns only `var` declarations (lines 46-63, 1312) — safe for whole-file `new Function` evaluation.
- Specified all four helpers against literal expected values before implementing them: RED run showed the syntax-gate test passing and each helper describe block failing with `TypeError: api.<name> is not a function`, correctly naming each specific missing helper (`formatPaddedId`, `maxIdNumFromColumn`, `normalizeRecipeIngredientTuple`, `recipeIngredientsUnchanged`).
- Implemented all four helpers, placed immediately after `generateNextId` (line 1263), matching the file's ES5 `var`-only, function-declaration-only style. Diff is purely additive (103 insertions, 0 deletions in `adminApi.gs`).
- `normalizeRecipeIngredientTuple` mirrors the write path's exact coercions (`sanitizeInput`-equivalent trim, `!== undefined ? Number(...) : 0` on quantity) and deliberately does NOT case-fold — 11 tests exercise both the dangerous silent-edit-loss direction (order, length, case, item_id/unit differences, non-finite quantities) and the dead-optimisation direction (string-vs-number coercion, float drift).
- All 38 new tests green; full frontend suite (93 suites / 1305 tests) and full middleware suite (102 suites / 1527 tests) green; `npm run lint` exits 0.

## Task Commits

1. **Task 1: RED — Jest harness that loads the real adminApi.gs and specifies the four helpers** - `84e9dbde` (test)
2. **Task 2: GREEN — implement the four pure helpers in adminApi.gs** - `9e8ffc77` (feat) — also includes the RED-stage test-assertion bugfix described below (same commit, since the fix was to the just-written specification, not to already-merged code)

**Plan metadata:** commit to follow this SUMMARY per the orchestrator's final-commit protocol.

_Note: this plan is `tdd="true"` per task, not a plan-level `type: tdd` gate — RED and GREEN commits exist for both tasks as required._

## Files Created/Modified

- `tests/frontend/adminapi-recipe-pure.test.js` — new Jest suite (38 tests): whole-file syntax gate, `formatPaddedId` (5 tests), `maxIdNumFromColumn` (9 tests), `normalizeRecipeIngredientTuple` (10 tests), `recipeIngredientsUnchanged` (10 tests), and a purity assertion (4 tests) that slices each new function's source and asserts it references no `SpreadsheetApp`/`LockService`/`Session.`/`Utilities.`/`CacheService`.
- `apps-script/adminApi.gs` — added `formatPaddedId`, `maxIdNumFromColumn`, `normalizeRecipeIngredientTuple`, `recipeIngredientsUnchanged` immediately after `generateNextId` (new code at lines 1264-1366 approx.). No existing function modified. Not yet wired into `updateRecipe` — that is 79-03's job.

## Decisions Made

- See `key-decisions` in frontmatter. The most consequential: the comparison's every-ambiguity-resolves-to-"changed" policy (no case folding, order-sensitive, length-checked, non-finite quantities always force a mismatch) — this directly implements the plan's stated asymmetric risk (silent edit loss is strictly worse than a wasted rewrite).
- Placed the new helpers physically adjacent to `generateNextId` rather than at file end, per the plan's explicit `<interfaces>` instruction, so all id-related logic stays discoverable in one place for 79-03's wiring.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed an incorrect assertion in my own Task 1 RED test**
- **Found during:** Task 2 (implementing `normalizeRecipeIngredientTuple` and running the new suite to GREEN)
- **Issue:** The Task 1 test `"a non-numeric quantity ('abc') produces a key that is NEVER equal to any finite-quantity key"` asserted `nonFinite` must differ from the keys produced by `quantity: NaN` and `quantity: Infinity`. But `NaN` and `Infinity` are themselves non-finite, so per the very spec this test was meant to enforce, they correctly collapse to the same `'!nonfinite'` sentinel as `'abc'` — the assertion was self-contradictory with the plan's own design (any non-finite value forces a mismatch via `recipeIngredientsUnchanged`, regardless of whether two non-finite tuples happen to produce the same string).
- **Fix:** Replaced the `NaN`/`Infinity` "must differ" assertions with assertions against genuinely finite quantities (`0`, `5`, `-1`), and added explicit assertions that `NaN` and `Infinity` correctly DO share the sentinel with `'abc'` (documented inline as intentional, not a gap).
- **Files modified:** `tests/frontend/adminapi-recipe-pure.test.js`
- **Verification:** Full suite re-run green after the fix (38/38 passing) alongside the correct `recipeIngredientsUnchanged` implementation, which independently forces `false` whenever any tuple carries the sentinel — so the collision this test now correctly permits can never cause a silent "unchanged" verdict.
- **Committed in:** `9e8ffc77` (same commit as the GREEN implementation, since the bug was discovered while validating GREEN and the test had not yet been treated as a locked external spec — it was authored in Task 1 of this same plan, moments earlier, by the same execution)

---

**Total deviations:** 1 auto-fixed (1 bug, in my own just-written test, not in the plan or in pre-existing code)
**Impact on plan:** No scope creep. The fix corrected a self-authored test bug to match the plan's own stated semantics; it did not change what the plan specified nor touch any pre-existing file.

## Issues Encountered

None beyond the test bugfix documented above.

## User Setup Required

None — this plan makes no `.gs` behavior change reachable from any action handler (the four helpers are added but not called), so no owner redeploy is needed for this plan specifically. The redeploy requirement is deferred to 79-04 per the plan's own scoping (`updateRecipe` behaviour is unchanged in this plan).

## Next Phase Readiness

- 79-03 can now wire `recipeIngredientsUnchanged`, `normalizeRecipeIngredientTuple`, `maxIdNumFromColumn`, and `formatPaddedId` into `updateRecipe`'s ingredient-rewrite and id-minting logic (D-04, D-05, D-09), calling `RecipeIngredients`'s single already-fetched `getDataRange().getValues()` read for all three uses (delete-scan, comparison, max-ID computation) per the pattern map's guidance — no new Sheets read needed.
- `updateRecipe`, `generateNextId`, and `sanitizeInput` are byte-unchanged, confirmed via `git diff` — 79-03 starts from an unmodified baseline for those functions.
- No owner redeploy checkpoint needed yet; 79-04 remains the plan responsible for the single owner redeploy + live probe (D-11).

---
*Phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a*
*Completed: 2026-09-02*

## Self-Check: PASSED

- `tests/frontend/adminapi-recipe-pure.test.js` — FOUND (created, 38 tests, verified passing)
- `apps-script/adminApi.gs` — FOUND (four new functions present, verified via `grep -c` returning 4)
- Commit `84e9dbde` — FOUND in `git log --oneline`
- Commit `9e8ffc77` — FOUND in `git log --oneline`
- `git diff apps-script/adminApi.gs` between commits confirmed purely additive (103 insertions, 0 deletions); `updateRecipe` and `generateNextId` function bodies unchanged
- No secret values appear anywhere in this document

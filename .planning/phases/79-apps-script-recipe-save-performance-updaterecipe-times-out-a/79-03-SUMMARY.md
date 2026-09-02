---
phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a
plan: 03
subsystem: infra
tags: [apps-script, google-sheets, recipe-save, performance, batching]

# Dependency graph
requires:
  - phase: 79-02
    provides: "Four pure helpers (formatPaddedId, maxIdNumFromColumn, normalizeRecipeIngredientTuple, recipeIngredientsUnchanged) in apps-script/adminApi.gs, locally tested and not yet wired into updateRecipe"
provides:
  - "Rewritten updateRecipe in apps-script/adminApi.gs: batched recipe-row write, self-migrating pricing_mode column run before the row read, a 5s local script-lock budget with a fast lock_timeout result, and a batched/change-detecting ingredient block that skips the rewrite entirely when tuples are unchanged"
  - "Stable ingredient_id survival across saves (D-09) -- an incoming id is honoured only when it belongs to this recipe and is unclaimed within the payload"
  - "Response diagnostics (ingredients_unchanged, ingredients_written, ingredient_rows_deleted, row_write_mode) so 79-04's live probe can observe which branch ran"
affects: [79-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-mutate-write-once for a single Sheets row: getRange(row,1,1,width).getValues()[0] -> mutate array in memory -> one ranged setValues(), with a getFormulas()-based fallback to per-cell setValue when a formula sits inside the mutated span"
    - "One getDataRange().getValues() read serving three purposes (delete-scan, change-comparison, max-id computation) instead of a read per purpose"
    - "Skip-write-when-unchanged as a first-class branch in a Sheets write handler, gated on a pure comparison helper rather than reimplemented inline"

key-files:
  created: []
  modified:
    - apps-script/adminApi.gs

key-decisions:
  - "D-10 lock retune is a LOCAL change at updateRecipe's own acquireScriptLock() call site only (5000ms, was 15000ms) -- the other 10 call sites in the file (createBatch, addBatchTask, addPlatoReading, propagateFermSchedule, createRecipe, deleteRecipe, issueGiftCard, redeemGiftCard, reloadGiftCard, voidGiftCard) are untouched, and the acquireScriptLock() helper body itself is byte-unchanged"
  - "The lock acquisition try/catch sits BEFORE the main try/finally and returns early on a thrown lock error, so releaseLock() can never run against a lock that was never acquired"
  - "ensureRecipesPricingModeColumn() now runs unconditionally (not gated on payload.pricing_mode being present) and BEFORE findRowById(), with an explicit invalidateSheetCache() in between, per the D-08 ordering constraint -- this prevents a stale, pre-migration-width header array from producing a short batched write"
  - "D-04's tuple is (item_id, quantity, unit) only -- a payload differing solely in item_name will not refresh the stored item_name. Documented as an accepted, benign consequence (item_name is a display denormalization resolved from the Zoho catalog by item_id), not a bug"
  - "generateNextId() is not called anywhere inside updateRecipe; the hoisted max-id computation and formatPaddedId() replace it for this call path only. generateNextId itself and its other 12 call sites are untouched"
  - "D-09 honours an incoming ingredient_id only if it exists in THIS recipe's stored id set AND has not already been claimed by an earlier row in the same payload -- a foreign or duplicated id is never honoured, a fresh id is minted instead"
  - "Ingredient deletes are collapsed into maximal contiguous runs and issued as deleteRows(start,count) calls in DESCENDING start-row order so earlier runs' row numbers stay valid"
  - "The ingredient insert batch grows the sheet grid with insertRowsAfter() before writing whenever the target range would exceed getMaxRows() -- getRange() beyond the grid height throws, which would otherwise turn this optimisation into a hard save failure on a tightly-sized sheet"
  - "Fixed my own comment wording mid-task: an early draft comment literally contained the substring generateNextId( inside a code comment, which inflated the file-wide grep -c count to 14 instead of the required 13. Reworded to 'the full-column-scan id helper is never invoked' to keep the grep-based acceptance check meaningful"

requirements-completed: [RECIPE-SAVE-01]

# Metrics
duration: ~30min
completed: 2026-09-02
---

# Phase 79 Plan 03: Rewrite updateRecipe for round-trip reduction Summary

**Rewrote `updateRecipe` in `apps-script/adminApi.gs` to cut a 13-ingredient recipe save from roughly 54 Sheets API calls to roughly 6 (unchanged-ingredients path) or 10 (changed path), by batching the recipe-row write, skipping the ingredient rewrite entirely when nothing changed, hoisting id minting out of the insert loop, batching deletes/inserts, and retuning the local script-lock budget — all inert until the owner's one manual Apps Script redeploy in 79-04.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-02 (approx.)
- **Completed:** 2026-09-02T14:45:50Z
- **Tasks:** 2 (both `type="auto"`)
- **Files modified:** 1 (`apps-script/adminApi.gs`)

## Accomplishments

- Replaced `updateRecipe`'s ~14 individual `setValue()` calls on the recipe row (two per-field `forEach` loops, a conditional pricing-mode write, and an unconditional `updated_at` write) with a single ranged read, an in-memory mutation, and a single ranged `setValues()` write — falling back to per-cell writes only when `getFormulas()` detects a live formula inside the mutated span (T-79-03-03).
- Reordered `ensureRecipesPricingModeColumn()` to run unconditionally, before `findRowById()`, with a cache invalidation in between — closing the D-08 stale-width bug where a column appended mid-request would silently clip the batched row write.
- Retuned the local script lock from a 15000ms wait (identical to the middleware's own 15000ms axios ceiling) to 5000ms, wrapped in its own try/catch that returns `{ ok: false, error: 'lock_timeout', message: 'Recipe sheet is busy - another write is in progress. Please retry.' }` on failure — a lock-wait failure is now a fast, distinguishable result instead of a 502 that looks identical to the timeout this phase exists to fix. Scoped to this one call site; the other 10 `acquireScriptLock()` sites in the file are untouched.
- Rewrote the ingredient block to read `RecipeIngredients` exactly once and reuse that single array for the delete-scan, the D-04 change-comparison, and the D-05 max-id computation. When `recipeIngredientsUnchanged()` reports the incoming `(item_id, quantity, unit)` tuples match the stored rows, the block does zero deletes and zero inserts — a pure rename is now near-free.
- When ingredients did change: ids are minted from a single hoisted max (`maxIdNumFromColumn` + `formatPaddedId`, no `generateNextId()` calls inside `updateRecipe`), an incoming `ingredient_id` is preserved when it belongs to this recipe and is unclaimed within the payload (D-09), deletes are collapsed into contiguous `deleteRows(start, count)` runs processed in descending order, and inserts are written in one `setValues()` after growing the grid with `insertRowsAfter()` if the target range would exceed `getMaxRows()` (T-79-03-04).
- The response now returns `ingredients_unchanged`, `ingredients_written`, `ingredient_rows_deleted` and `row_write_mode`, making the branch that ran observable to 79-04's live probe rather than inferred (the middleware drops these fields and returns a bare `{ok:true}`).
- Full frontend suite (93 suites / 1305 tests), full middleware suite (102 suites / 1527 tests), and `npm run lint` all green after both commits.

## Task Commits

1. **Task 1: Batch the recipe-row write (D-08), fix the pricing-mode ordering, retune the lock locally (D-10)** - `1a9378f6` (perf)
2. **Task 2: Skip-when-unchanged, batched deletes/inserts, hoisted id minting, stable ingredient ids (D-04, D-05, D-06, D-07, D-09)** - `2ec965ff` (perf)

**Plan metadata:** commit to follow this SUMMARY per the orchestrator's final-commit protocol.

## Files Created/Modified

- `apps-script/adminApi.gs` — `updateRecipe` (lines 3686-3969) fully rewritten. No other function modified: `generateNextId`, `acquireScriptLock`, `sanitizeInput`, `findRowById`, `createRecipe`, `deleteRecipe` are all byte-unchanged, confirmed via `git diff`.

## Sheets round-trip accounting (by construction, not measured — see Honest statement below)

| Path | Calls | Detail |
|---|---|---|
| **Unchanged-ingredients rename** (was ~54) | **~6-7** | 1 header read (`ensureRecipesPricingModeColumn`) + up to 1 header-cell write on first-ever migration + 1 `findRowById` read + 1 row-values read + 1 row-formulas read + 1 row write + 1 `RecipeIngredients` read for the comparison. Zero deletes, zero inserts. |
| **Changed-ingredients save** (was ~54) | **~9-11** | Same ~6-7 above, plus 1-2 `deleteRows()` calls (usually 1, since a recipe's ingredient rows are contiguous) + 1 `setValues()` insert + occasionally 1 `insertRowsAfter()` grid-growth call. |

## Decisions Made

See `key-decisions` in frontmatter. Most consequential: D-04's tuple is `(item_id, quantity, unit)` only, so an `item_name`-only change won't refresh the stored denormalized name — accepted and documented per the plan, since `item_name` is resolved from the Zoho catalog by `item_id` at read time elsewhere.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] My own draft comment broke the `generateNextId(` grep-count acceptance check**
- **Found during:** Task 2, verification step
- **Issue:** A comment I wrote read `// ... generateNextId() is never called from inside updateRecipe --`, which literally contains the substring `generateNextId(`. This inflated `grep -c "generateNextId(" apps-script/adminApi.gs` to 14 instead of the required 13 (1 definition + 12 remaining call sites, after removing `updateRecipe`'s single call site as intended).
- **Fix:** Reworded the comment to "the full-column-scan id helper is never invoked from inside updateRecipe" — same meaning, no literal `generateNextId(` substring.
- **Files modified:** `apps-script/adminApi.gs`
- **Verification:** `grep -c "generateNextId(" apps-script/adminApi.gs` now returns exactly 13; re-ran full frontend suite, middleware suite, and lint — all still green.
- **Committed in:** `2ec965ff` (part of Task 2's commit — the comment was written and corrected within the same uncommitted working state before that commit landed)

---

**Total deviations:** 1 auto-fixed (self-authored comment wording, not a functional bug)
**Impact on plan:** None. No functional code changed as a result; only comment text was reworded to keep the file-wide `generateNextId(` count check accurate.

## Issues Encountered

None beyond the self-authored comment-wording issue above.

## User Setup Required

None — this plan makes `.gs` behavior changes but does not request or require a redeploy itself. Per D-11/the plan's own scoping, **this edit is completely inert until the owner manually redeploys Apps Script as a new version**, which is 79-04's job, along with the live probe that will observe `ingredients_unchanged` / `ingredients_written` / `ingredient_rows_deleted` / `row_write_mode` on a real (or throwaway) recipe save. Nothing in production or staging behavior changes as a result of this plan alone.

## Honest statement of test coverage

As the plan states up front: **the Sheets round-trip reduction has no automated test and cannot have one** — there is no `SpreadsheetApp` outside Google's runtime, and `zoho-middleware/__tests__/recipes.test.js` mocks `axios.post` entirely, standing in for the whole Apps Script round-trip. What passing `npm test` here actually proves is (a) that 79-02's pure helpers (`recipeIngredientsUnchanged`, `maxIdNumFromColumn`, `formatPaddedId`, `normalizeRecipeIngredientTuple`) still behave correctly, and (b) that `apps-script/adminApi.gs` still parses and evaluates without throwing (the whole-file syntax gate from 79-02's test harness). It does **not** prove `updateRecipe`'s wiring is correct against a real Google Sheet — that rests entirely on 79-04's live probe after the owner's redeploy.

## Next Phase Readiness

- 79-04 can now add the owner-redeploy checkpoint and live probe. The probe should assert: (1) a pure rename returns `ingredients_unchanged: true`, `ingredients_written: 0`, `ingredient_rows_deleted: 0`; (2) a real ingredient quantity edit returns `ingredients_unchanged: false` with `ingredients_written` matching the ingredient count and the recipe's ingredient ids surviving the round-trip; (3) `row_write_mode` is `'batched'` for a Recipes row confirmed formula-free; (4) a lock-contention scenario (if reproducible) returns `lock_timeout` rather than hanging to 15s.
- The exact `lock_timeout` message string for 79-04's probe to match on: `Recipe sheet is busy - another write is in progress. Please retry.`
- `apps-script/adminApi.gs` is the only file this plan touched. `zoho-middleware/routes/recipes.js` (`timeout: 15000` at line 37, confirmed unchanged) and `js/lib/recipe-scaling.js` (Phase 73's fail-closed unit guard) are both untouched, satisfying D-02 and D-14.

---
*Phase: 79-apps-script-recipe-save-performance-updaterecipe-times-out-a*
*Completed: 2026-09-02*

## Self-Check: PASSED

- `apps-script/adminApi.gs` — FOUND, `updateRecipe` rewritten at lines 3686-3969, verified via `grep -n "^function updateRecipe"`.
- Commit `1a9378f6` — FOUND in `git log --oneline`.
- Commit `2ec965ff` — FOUND in `git log --oneline`.
- `grep -c "acquireScriptLock(5000)"` = 1, `grep -c "acquireScriptLock(15000)"` = 8, `grep -c "acquireScriptLock(10000)"` = 2 — all confirmed via grep during execution.
- `grep -c "generateNextId(" apps-script/adminApi.gs` = 13 — confirmed via grep during execution (after the comment-wording fix).
- `grep -n "timeout: 15000" zoho-middleware/routes/recipes.js` still matches at line 37 — confirmed.
- `git diff --name-only` (excluding the orchestrator-owned `.planning/STATE.md`) lists only `apps-script/adminApi.gs` for both commits — confirmed.
- `npm test` (93/93 suites, 1305/1305 tests), `cd zoho-middleware && npm test` (102/102 suites, 1527/1527 tests), and `npm run lint` all green — confirmed after both commits.
- No secret values appear anywhere in this document.

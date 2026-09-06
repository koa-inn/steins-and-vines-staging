---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 06
subsystem: ui
tags: [admin-panel, vanilla-js, es5, forms]

requires:
  - phase: 81-04
    provides: "#recipe-schedule-select, buildScheduleOptionsHtml(selectedId), and recipe.schedule_id round-tripping through the recipe editor"
  - phase: 81-05
    provides: "BeerXML review modal's schedule attachment path, also writing recipe.schedule_id"
provides:
  - "countRecipesUsingSchedule(scheduleId) -> number, counting _recipesState.list entries by schedule_id"
  - "D-15 amber blast-radius note in renderScheduleForm, shown only when editing a template used by >=1 public recipe"
  - "scheduleIdForRecipe(recipeId) -> string, resolving a recipe's linked schedule_id ('' when unset/unmatched)"
  - "D-04 pre-selection of #sa-schedule-select to the activating batch's recipe's own template (default only, fully editable)"
  - "Non-fatal single-recipe fetch fallback in openScheduleActivateModal's pre-open loader when _recipesState.list is still empty"
  - "Documented (code comment + this SUMMARY) finding that #batch-schedule-select cannot be defaulted under D-04 as specified"
affects: []

tech-stack:
  added: []
  patterns:
    - "Complementary counters over the same shape (filter().length on a client-side array) can coexist for different questions without being a duplicate warning -- documented inline where two such counters sit near each other"
    - "Pre-open loader branch (needsScheds/needsVessels) extended with a third non-fatal async leg (withScheduleResolved) that always calls back, so an optional-default fetch can never block the primary action"

key-files:
  created: []
  modified:
    - js/admin.js

key-decisions:
  - "countRecipesUsingSchedule counts _recipesState.list (recipes), a deliberately separate metric from the pre-existing batchesData active-batch counter at js/admin.js's propagate-changes confirm (js/admin.js:~7727 pre-plan) -- same simple filter+length shape, different source array, different question (customer-facing copy vs live batch task propagation); documented inline rather than merged into one counter"
  - "scheduleIdForRecipe returns '' (never undefined/null) for a falsy or unmatched recipe_id, matching the existing convention elsewhere in this file for select-default helpers"
  - "The single-recipe fetch fallback does NOT call loadRecipeList() -- that function has a #recipes-tbody render side effect that would leak Recipes-tab table state into the Batches tab; a scoped GET /api/recipes/:id (already used at 3 other call sites) is used instead, wrapped in a .catch that always calls back so the modal can never fail to open because of it"
  - "batch-schedule-select's blocker is left as a code comment plus this SUMMARY's Finding section rather than silently worked around with a new recipe picker, since UI-SPEC §6 explicitly excludes any new visual element for this leg"

requirements-completed: [OPS-05]

duration: ~20min
completed: 2026-09-06
---

# Phase 81 Plan 06: Blast-radius note + batch-activation schedule pre-selection Summary

**Editing a fermentation schedule template now shows staff an amber count of how many public recipes it feeds (D-15), and activating a batch defaults its schedule dropdown to the recipe's own linked template while staying fully editable (D-04) -- with the create-batch modal's leg of D-04 explicitly documented as not implementable without new UI it's out of scope to add.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-09-06T04:46:36Z
- **Tasks:** 2 completed
- **Files modified:** 1 (js/admin.js)

## Accomplishments
- Added `countRecipesUsingSchedule(scheduleId)`, a zero-network count over the already-loaded `_recipesState.list`, and wired an amber `.availability-banner--low` note into `renderScheduleForm` that appears only when editing a template with >=1 attached recipe (D-09's omit-a-zero convention applied to this admin surface)
- Added `scheduleIdForRecipe(recipeId)` and used it to default `#sa-schedule-select` to the activating batch's recipe's own schedule template in `_buildScheduleActivateModal`, with a non-fatal single-recipe fetch fallback in `openScheduleActivateModal`'s pre-open loader for the case where the Recipes tab hasn't been visited this session
- Confirmed and documented (code comment + Finding below) that the create-batch modal's `#batch-schedule-select` has no recipe identity available to default from, per D-04's second leg

## Task Commits

Each task was committed atomically:

1. **Task 1: Blast-radius note on the fermentation schedule template editor** - `30179a1d` (feat)
2. **Task 2: Pre-select the recipe's schedule when activating a batch, and record the create-batch finding** - `f3f7b631` (feat, amended once in-flight to move the D-04 code comment within the acceptance criterion's 3-line window above the option loop -- see Deviations)

**Plan metadata:** commit pending (this SUMMARY; STATE/ROADMAP not touched per worktree isolation)

## Files Created/Modified
- `js/admin.js` -- `countRecipesUsingSchedule` (new, colocated with `renderScheduleForm`); D-15 note inserted into `renderScheduleForm`'s `html` string between the Category `</select></div>` and the `<h4>Fermentation Steps</h4>` header; `scheduleIdForRecipe` (new, colocated with `_buildScheduleActivateModal`); `openScheduleActivateModal` gained a `withScheduleResolved` non-fatal fetch leg; `_buildScheduleActivateModal` sets `#sa-schedule-select.value` to the resolved default after the modal opens; a D-04 finding comment added above the `#batch-schedule-select` option loop in `buildCreateBatchFormInner`

## Decisions Made
See `key-decisions` in frontmatter above.

## Deviations from Plan

### Reconciliation with a pre-existing control (not a code change, a design note)

**[Orchestrator finding, addressed by design] `js/admin.js`'s save-time propagation confirm already counts "active batches using this template."** Live verification during plan 81-07 surfaced this before I started: on save, `renderScheduleForm`'s submit handler already filters `batchesData` for primary/secondary batches on the same `schedule_id` and shows `showConfirm('Apply template changes to N active batch(es)? ...')`. This is a different question from D-15's (batches vs. public recipes, save-time confirm vs. edit-time informational banner), so `countRecipesUsingSchedule` was implemented as its own function against `_recipesState.list` rather than reusing that batch-counting call site directly. I did reuse its *shape* (`.filter(...).length`) and added an inline comment at both `countRecipesUsingSchedule` and immediately above the existing batch counter cross-referencing each other, so a future reader sees these as two deliberately distinct, complementary counters rather than one overlooked duplicate. No functional change to the existing confirm.

### Auto-fixed Issues

**1. [Rule 1 - Bug, caught by my own acceptance-criteria check] D-04 comment initially placed too far from the option loop**
- **Found during:** Task 2, self-verification against the plan's acceptance criteria
- **Issue:** My first version of the `#batch-schedule-select` finding comment was 7 lines long, putting the literal substring "D-04" 6 lines above the option-loop line -- outside the plan's "within 3 lines above" acceptance criterion. The same first draft also used the literal substring `loadRecipeList()` inside a comment (as prose, not a call), which inflated `grep -c "loadRecipeList()" js/admin.js` from its pre-plan value of 5 to 6, failing that criterion too.
- **Fix:** Shortened the D-04 finding comment to 6 lines with "D-04" on the second-to-last line (2 lines above the option loop), and reworded the `openScheduleActivateModal` comment to describe the full recipe-list loader without spelling out its literal call syntax.
- **Verification:** `grep -c "loadRecipeList()" js/admin.js` = 5 (matches pre-plan); a comment containing "D-04" sits within 3 lines of the `#batch-schedule-select` option loop; `npm run lint` and `npm test` both green after the fix.
- **Files modified:** js/admin.js
- **Committed in:** `f3f7b631` (amended before this SUMMARY was written; the flawed intermediate version was never pushed or visible outside this worktree)

---

**Total deviations:** 1 design-reconciliation (no code change, documented for a future reader), 1 auto-fixed self-caught acceptance-criteria miss.
**Impact on plan:** No change to shipped behavior beyond fixing my own comment placement before it was ever seen. Both existing and new blast-radius signals remain live and distinct.

## Issues Encountered
None beyond the self-caught deviation above.

## User Setup Required
None -- no external service configuration required. No Apps Script changes.

## Finding: D-04 create-batch leg not implementable as specified

**Evidence:** `buildCreateBatchFormInner` (`js/admin.js:6968`) identifies the subject of a new batch exclusively through a Zoho product SKU search (`#batch-product-search` / `#batch-product-sku` / `#batch-product-name`). Its `create_batch` submit payload (`js/admin.js:~7250-7267`, unchanged by this plan) carries `product_sku`, `product_name`, customer fields, `start_date`, `schedule_id`, vessel/shelf/bin, and `notes` -- **no `recipe_id` field at all**. A batch only acquires `recipe_id` later, from the kiosk recipe-sale path (`apps-script/adminApi.gs:2274-2281`, referenced in this plan's `<interfaces>`), not from this modal.

**What was implemented instead:** D-04's pre-selection is implemented on `#sa-schedule-select` only -- the batch-activate modal, which operates on an already-existing `batch` object that does carry `recipe_id` once set. `#batch-schedule-select` in the create-batch modal is unchanged in markup and behavior; a code comment directly above its option loop (`js/admin.js`, in `buildCreateBatchFormInner`) records this finding for any future editor.

**Two options for closing the gap (owner's call, not implemented here):**
1. Associate Zoho products with recipes (e.g. a product-SKU -> recipe_id lookup table or a `recipe_id` custom field on the Zoho item), so the create-batch modal could resolve a default schedule the same way the activate modal now does.
2. Add a recipe picker to the create-batch modal -- new UI, which UI-SPEC.md §6 explicitly excludes for this phase ("pre-selection only, no new visual element").

This leg is **not complete** and is not represented as complete anywhere in this SUMMARY's frontmatter (`provides` lists only the `#sa-schedule-select` leg as delivered).

## Next Phase Readiness
- Both tasks of this plan are self-contained UI/behavior changes to `js/admin.js`; no downstream plan in this phase depends on further work here
- The create-batch leg's blocker (above) is a standing, documented gap for a future phase or owner decision -- not a blocker for Phase 81's own success criteria, which only required D-04's activate-modal leg and the documented finding
- No blockers

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Completed: 2026-09-06*

## Self-Check: PASSED

- FOUND: js/admin.js
- FOUND: .planning/phases/81-recipe-fermentation-timeline-give-customers-an-expected-read/81-06-SUMMARY.md
- FOUND (git log): 30179a1d, f3f7b631

---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 04
subsystem: ui
tags: [admin-panel, vanilla-js, es5, forms]

requires:
  - phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read (plan 01)
    provides: GET /api/recipes returns schedule_id byte-for-byte from the Apps Script payload
provides:
  - "#recipe-schedule-select and #recipe-schedule-warning DOM ids in the recipe editor form"
  - "buildScheduleOptionsHtml(selectedId) helper for beer-first, escaped schedule option markup"
  - "initRecipesTab() no longer leaves fermSchedulesData empty when Recipes is opened before Batches"
  - "D-11 warn-don't-block advisory when an active recipe has no schedule"
affects: [81-05, 81-06]

tech-stack:
  added: []
  patterns:
    - "Rebuild <select> options at populate-time (not page load) when the source array is filled by an async, cross-tab lazy-load"
    - "Sort-not-filter for category-grouped dropdown options — never hide a legitimately reachable blank/other-category row"
    - "Advisory (non-blocking) inline messages live in their own render function, called from populate + change listeners, and are structurally excluded from the real save-blocking gate"

key-files:
  created: []
  modified:
    - admin.html
    - js/admin.js
    - css/admin.css

key-decisions:
  - "schedule_id sent as `value || null` (never undefined) so clearing the picker writes an empty Sheets cell instead of the literal string 'null', and so updateRecipe's stringFields !== undefined gate doesn't silently skip the write"
  - "buildScheduleOptionsHtml sorts beer-category first rather than filtering out non-beer/blank-category templates, since blank category is a normal reachable state on existing FermSchedules rows"
  - "renderScheduleWarning is deliberately NOT added to canActivateRecipe — verified by grepping that function's body for zero 'schedule' occurrences — so D-11 stays advisory and never blocks a save"

requirements-completed: [OPS-05]

duration: ~12min
completed: 2026-09-05
---

# Phase 81 Plan 04: Recipe editor fermentation-schedule picker Summary

**Recipe editor gains a fifth form field — a beer-first, escaped schedule picker that round-trips schedule_id through save/load and shows a non-blocking amber advisory when an active recipe has no schedule, fixing a lazy-load gap that would otherwise have rendered the picker empty.**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-09-05T17:23:26Z
- **Completed:** 2026-09-05T17:29:37Z
- **Tasks:** 3 completed
- **Files modified:** 3 (admin.html, js/admin.js, css/admin.css)

## Accomplishments
- Closed the lazy-load gap where `fermSchedulesData` was never populated if a staff member opened Admin and went straight to Recipes without visiting Batches first
- Added the schedule picker (`#recipe-schedule-select`) to the recipe editor with a beer-first, `escapeHTML`-hardened option list, wired through `populateRecipeForm`/`saveRecipe` so it loads, pre-selects, saves, and clears correctly
- Added a D-11 warn-don't-block advisory (`#recipe-schedule-warning`) that tracks form state live via two `change` listeners, with a one-line amber CSS modifier, while leaving the actual save-blocking gate (`canActivateRecipe`) untouched

## Task Commits

Each task was committed atomically:

1. **Task 1: Guarantee fermSchedulesData is loaded when the Recipes tab opens** - `750ffc8b` (fix)
2. **Task 2: Schedule picker field, option population, and the load/save round-trip** - `2e5bb988` (feat)
3. **Task 3: D-11 warn-don't-block message for an active recipe with no schedule** - `367d6e8f` (feat)

**Plan metadata:** commit pending (this SUMMARY + STATE not touched per worktree isolation)

## Files Created/Modified
- `js/admin.js` - `initRecipesTab()` now also calls `triggerBatchLoad()`; new `buildScheduleOptionsHtml(selectedId)` helper; `populateRecipeForm` rebuilds/pre-selects the picker and calls the new `renderScheduleWarning()`; `saveRecipe`'s `formData` gains `schedule_id`; new `renderScheduleWarning()` function; two new `change` listeners in `initRecipesControls`
- `admin.html` - fifth `.recipes-form-field` in the existing narrow grid: `#recipe-schedule-select` + `#recipe-schedule-warning`
- `css/admin.css` - one new rule, `.recipes-inline-error--warning { color: var(--batch-warning); }`

## Decisions Made
- See `key-decisions` in frontmatter above — all three were already specified by the plan/UI-SPEC and implemented verbatim, not new decisions made during execution.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria for all three tasks verified via the exact `grep -c` / body-scan commands specified in the plan, all passing.

**Note (not a deviation, no action taken):** the plan's top-level `<verification>` block states `grep -c "recipe-schedule-select" admin.html` returns 1, but the actual value is 2 — the `<label for="recipe-schedule-select">` and `<select id="recipe-schedule-select">` each land on their own line, both containing the string once. This is the same pattern every other field in this grid already follows (e.g. `grep -c "recipe-colour" admin.html` is also 2, for its label + input pair) and is normal, accessible HTML. The task-level acceptance criteria used the more precise `grep -c 'id="recipe-schedule-select"' admin.html` (returns 1) and that is the one actually meaningful for uniqueness — it passes. No code change made.

## Issues Encountered
None.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
Plans 81-05 and 81-06 can now consume `#recipe-schedule-select`, `#recipe-schedule-warning`, and `buildScheduleOptionsHtml(selectedId)` as documented in this plan's `<interfaces>` PRODUCED section. No blockers.

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Completed: 2026-09-05*

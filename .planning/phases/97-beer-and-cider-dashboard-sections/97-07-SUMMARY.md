---
phase: 97-beer-and-cider-dashboard-sections
plan: 07
subsystem: ui
tags: [brewpad, dashboard-v2, today-section, ready-to-bottle]
requires:
  - phase: 97-05
    provides: BrewPad recipe Target OG/FG (wave 1, unrelated to this plan's files except js/brewpad.js)
provides:
  - Six-section v2 layout (Today, Production, Floor today, Beer & cider, Products & sales, Data health)
  - Per-section hidden hook (Beer & cider hidden when Type = Wine)
  - Shared Today's tasks / Ready to bottle row builders used by classic and v2
  - v2 widgets t1 (Today's tasks) and t2 (Ready to bottle)
affects: [97-08 (packcal slot), 97-09 (bc slot), 97-10, 97-11]
tech-stack:
  patterns: [persistent shell with refresh-time visibility toggle, shared row builders]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, brewpad.html, tests/frontend/brewpad-dashboard-v2-production.test.js]
  created: [tests/frontend/brewpad-dashboard-v2-today.test.js]
decisions:
  - "Owner approval for existing-test edits recorded (see below)"
metrics:
  completed: 2026-11-04
---

# Phase 97 Plan 07: Today section and six-section v2 layout Summary

v2 dashboard now opens with a Today section (Today's tasks + Ready to bottle, filter-independent, Vancouver day) and lays out the final six sections, with Beer & cider hidden for Type = Wine. Classic and v2 share the same row builders.

## Task 1 decision (checkpoint resolved)

Source: owner in session, relayed by orchestrator (2026-11-04, AskUserQuestion).
- (a) APPROVED: editing the section-order assertions in `tests/frontend/brewpad-dashboard-v2-production.test.js` L195-217 to the six-section order.
- (b) CONFIRMED: 97-01's edit to `zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json` (target_og/target_fg keys) stays.

The only pre-existing test edit in this plan is (a): the test "four headed sections..." renamed "six headed sections...", with titles, hints, slots and the `bp-dash-full` id loop updated. Nothing else in that file changed.

## Commits
- ec08445b: six-section registry, `data-dash-sec`, `applyDashV2SectionVisibility`, production-test update, new today test (layout part)
- 9b4588d4: shared builders (`dashTodayTaskRows`, `dashTodayTaskRowHtml`, `dashReadyToBottleRowHtml`, `readyToBottleList`), widgets t1/t2, CSS classes replacing classic inline styles, rebuilt min assets and brewpad.html stamp, rest of the today tests

## Notes
- Classic keeps `todayStr()` (UTC); v2 uses `_dashData.asOf.today` falling back to `todayPacific()`. Verified with a faked clock (10:30 pm PT on the 3rd).
- Classic overdue rows now use `.bp-task-row--overdue` (+ scoped left border) instead of inline colours; Overdue tasks are now sorted ascending by due date in classic too (shared `dashTodayTaskRows`).
- `_setStateForTest` gained `_upcomingTasks` / `_upcomingLoaded` patch keys (test seam only).
- The v2 shell listeners never stopPropagation, so the delegated tick/chip/invite handlers on `#bp-dashboard-inner` still receive events.

## Deviations from Plan

**1. [Rule 3 - Test limitation] Handler tests assert bubbling, not handler side effects.** `initDelegation()` never runs under Jest (documented in the file), so the test proves checkbox/chip/invite events bubble to `#bp-dashboard-inner` with the expected `data-task-id` / classes, rather than asserting `adminApiPost` is called. No code change needed.

**2. [Rule 3] Worktree base:** HEAD was at the pre-wave commit, reset to the specified base e72a2cb1 per the startup check.

## Verification
- Root `npm test`: 244 suites, 3330 tests pass. `npm run lint` clean. `npm run build` run; unrelated regenerated stamps discarded.
- `cd zoho-middleware && npm test` NOT run: middleware is untouched by this plan and its `node_modules` is not installed in this worktree (97-05 also reported pre-existing middleware failures).

## For the owner (separate issue, not fixed)
Classic `todayStr()` is UTC, so classic "Today's Tasks" runs a day ahead after about 4-5 pm Vancouver (RESEARCH P5).

## Known Stubs
None. The `bp-dash-v2-packcal` and `bp-dash-v2-bc` slots are intentionally empty until 97-08 and 97-09.

## Self-Check: PASSED

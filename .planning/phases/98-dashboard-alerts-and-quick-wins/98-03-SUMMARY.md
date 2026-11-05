---
phase: 98-dashboard-alerts-and-quick-wins
plan: 03
subsystem: brewpad-frontend
tags: [tasks-tab, filters, vancouver-day]
requires: ["98-02"]
provides:
  - "Overdue and Due today permanent chips on the BrewPad Tasks tab (D-06)"
affects: [98-04, 98-06]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, brewpad.html]
  created: [tests/frontend/brewpad-tasks-urgency-filters-98.test.js]
key-decisions:
  - "Tasks tab today = dashV2TodayDate() (Vancouver day), same source as the dashboard"
requirements-completed: [A1]
duration: 10min
completed: 2026-11-05
---

# Phase 98 Plan 03: Tasks-tab urgency chips Summary

Tasks tab filter bar is now To Do, Overdue, Due today, All, Transfers, Packaging; the two new filters use the Vancouver day so their list lengths equal the dashboard overdue/today partition.

## Commit
- `feat(98-03): Overdue and Due today Tasks-tab chips on the Vancouver day (D-06)` (single commit for both tasks; Task 2 is build and verify only)

## Test seams added
`_taskFilter`/`_taskSearch` in `_setStateForTest`, `_taskFilter` in `getStateForTest`, `_renderTasksForTest`, `_loadTasksForTest`. 7 new tests (chip order, predicates, 70+ fixture count equality, 23:30 PT boundary, empty copy, limit 200). Existing today test passes unmodified.

## Behaviour changes beyond D-06
1. Group headers UTC -> Vancouver day. Before: `todayStr()` (UTC), so after about 4-5 pm Pacific a task due today was grouped under Overdue. After: `dashV2TodayDate()`, so it stays under Today. Reason: the Due today filter would otherwise show its rows under an Overdue header. Plan 98-06 UAT should check this after 4 pm PT.
2. `loadTasks` limit 60 -> 200. Before: tapping into the Tasks tab refetched 60 and could shrink the list below the eager-loaded 200. After: same 200 as eager load (owner-approved, RESEARCH Q2).

## Follow-up (not changed)
The 7-day "This Week" boundary (`weekEnd` via `toISOString`) is still UTC. Separate issue.

## Verification
Root `npm test` (3418), middleware `npm test` (4055), `npm run lint` green. Build restamps of unrelated files reverted. The click handler was unchanged; no direct click test was added (handler is wired at init, not reachable via the seams), covered by the data-task-filter attribute check.

## Deviations from Plan
- Test written alongside the implementation rather than a separate confirmed-RED run (single commit as the plan specified).
- Click-to-set-filter test omitted (see above).

## Self-Check: PASSED

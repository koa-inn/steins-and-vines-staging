---
phase: 98-dashboard-alerts-and-quick-wins
plan: 02
subsystem: brewpad-frontend
tags: [dashboard, attention-model, pure-function]
requires: ["98-01"]
provides:
  - "buildDashAttentionModel, dashPastPlanDays, dashPastPlanNote, dashAttentionDrillLabel (exported, pure)"
affects: [98-04, 98-05]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, brewpad.html]
  created: [tests/frontend/brewpad-dashboard-v2-attention-model.test.js]
key-decisions:
  - "Past schedule uses batchMeta.planned_days; D-10 is pending the 98-06 production spike (not recorded as satisfied)"
requirements-completed: [A1, A2, A4, A5]
duration: 10min
completed: 2026-11-05
---

# Phase 98 Plan 02: Needs attention model Summary

Pure ES5 model returning `{items, pending, unavailable, noneAvailable, allClear}` with fixed order overdue, today, past-schedule, invite, waitlist; 13 unit tests cover the 14/15 grace edge, D-11, staff rules, invite dedupe, allClear safety and banned copy.

## Commits
- Tasks 1 and 2 in one commit as the plan specified: `feat(98-02): pure Needs attention model (A1, A2, A4, A5)`

## Verification
Root `npm test` (3411), middleware `npm test` (4055), `npm run lint` green. Build restamps of unrelated files were reverted.

## D-10 status
Pending 98-06 spike (planned_days vs schedule_snapshot max day_offset equivalence is still assumed).

## Deviations from Plan
None.

## Self-Check: PASSED

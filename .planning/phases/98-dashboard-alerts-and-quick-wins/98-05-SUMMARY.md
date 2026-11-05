---
phase: 98-dashboard-alerts-and-quick-wins
plan: 05
subsystem: brewpad-frontend
tags: [dashboard, needs-attention, drill, tap-through]
requires: ["98-04"]
provides:
  - "onDashV2AttnClick: all five Needs attention chips open their destination"
  - "openDashDrill notes/order extension; Past schedule 'N days past plan' row note and sort"
affects: [98-06]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, brewpad.html]
  created: [tests/frontend/brewpad-dashboard-v2-attention-drill.test.js]
key-decisions:
  - "Chip item recomputed via dashV2AttentionModel() at tap time so list length equals the chip count"
  - "Past schedule/Invite open via openDashDrill, never dashV2Go (single id would skip the banner)"
requirements-completed: [A1, A2, A4, A5]
duration: 20min
completed: 2026-11-05
---

# Phase 98 Plan 05: Needs attention tap-throughs Summary

Every Needs attention chip now lands on exactly the items it counted: Overdue / Due today preselect the Tasks chip with search cleared, Past schedule and Invite not sent open the Batches drill with the singular/plural banner, Waitlist opens the Waiting filter with no banner. Past schedule rows carry "N days past plan" and sort most days first (card and table views); nothing shows outside that drill.

## Commit
- Single commit for both tasks (Task 2 is CSS, build and verification): `feat(98-05): Needs attention tap-throughs and past-plan drill note (D-05, D-12)`

## Verification
Root `npm test` (3447), middleware `npm test` (4055), `npm run lint` green. Existing drill and drill-tabbar tests pass unmodified. Unrelated build restamps reverted.

## Deviations from UI-SPEC
1. Invite not sent drill rows get no Send Invite button. UI-SPEC assumed Ready-to-bottle row reuse, but Batches list rows have no such button. Staff tap a card and use the existing detail-pane Send Bottling Invite behind its confirm sheet (no new write surface, D-02/F9).
2. `.bp-past-plan` text is `--ink-secondary` with a 3px `--batch-warning` left border, not amber text (amber on its tint measures 2.58-3.12:1, fails 4.5:1).

## Deviations from Plan
- Test mocks `get_tasks_upcoming` to return the seeded tasks, since switching to the Tasks tab refetches and the default mock would empty the list. Test-only.

## Known Stubs
None.

## Self-Check: PASSED

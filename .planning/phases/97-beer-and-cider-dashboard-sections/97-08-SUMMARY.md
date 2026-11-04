---
phase: 97-beer-and-cider-dashboard-sections
plan: 08
subsystem: ui
tags: [brewpad, dashboard-v2, packaging-calendar, cal-com]
requires:
  - phase: 97-06
    provides: GET /api/admin/packaging-bookings
  - phase: 97-07
    provides: Today section, slot bp-dash-v2-packcal
provides:
  - Pure calendar model (buildPackagingCalendar, dashCalDayLabel, dashCalTimeLabel)
  - Widget t3 "Packaging calendar" with lazy, fail-soft loading
affects: [97-09..97-12]
key-files:
  modified: [js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, brewpad.html]
  created: [tests/frontend/brewpad-dashboard-v2-packcal.test.js]
metrics:
  completed: 2026-11-04
---

# Phase 97 Plan 08: Packaging calendar Summary

The Today section now shows a 14-day packaging calendar grouped by Vancouver day, merging Cal.com bookings with open dated BrewPad packaging tasks, degrading softly when bookings cannot be loaded.

## Commits
- a3504512: pure model and label helpers plus tests
- efa86c48: widget t3, CSS, built assets, brewpad.html stamp, DOM tests

## Behaviour
- Bookings use the server `day` field (Vancouver), so a 9 pm PT booking stays on its own day.
- A task whose batch has a matched booking anywhere in the window is shown once, as the booking.
- Kind: beer is Canning, otherwise Bottling; unmatched bookings use the booking kind.
- While bookings load or fail, task entries carry no "not booked yet" status; the note explains.
- Fetches fire once per dashboard load (keyed on `_dashLoadTime` and the `_dashData` object); stale responses are dropped. The widget ignores the global filters. No emails are requested or rendered; all text goes through escapeHTML.

## Deviations from Plan
**1. [Rule 3] Worktree base:** HEAD was behind the specified base, reset to 4517cbe1 per the startup check. Otherwise the plan was executed as written.

## Verification
- Root `npm test`: 245 suites, 3350 tests pass. `npm run lint` clean. `npm run build` run; unrelated regenerated stamps discarded.
- `cd zoho-middleware && npm test` not run: middleware untouched and its node_modules is not installed in this worktree.
- Existing tests not modified.

## Known Stubs
None.

## Self-Check: PASSED

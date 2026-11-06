---
phase: 98-dashboard-alerts-and-quick-wins
plan: 06
subsystem: rollout
tags: [spike, staging, uat]
requires: ["98-01", "98-05"]
provides:
  - "Read-only past-schedule spike (planned_days vs schedule_snapshot max) with a tested summariser"
  - "D-10 gate PASS on production data; staging deploy; owner UAT approval"
affects: []
key-files:
  created: [zoho-middleware/scripts/spike-past-schedule-98.js, zoho-middleware/__tests__/spike-past-schedule-98.test.js, .planning/phases/98-dashboard-alerts-and-quick-wins/98-ROLLOUT-LOG.md]
  modified: []
key-decisions:
  - "D-10 holds in practice: planned_days == max schedule_snapshot day_offset for every active batch (0 mismatches on prod and staging); no server-side change needed"
requirements-completed: [A1, A2, A4, A5]
duration: 90min
completed: 2026-11-05
---

# Phase 98 Plan 06: Real-data proof and staging UAT Summary

The read-only spike ran in the production container via `railway ssh`. It found 40 active batches, 1 with no schedule, 0 mismatches, and plus14 = 6, which reproduces the owner's 6 of 40, so the D-10 gate passed. Staging gives the same result with plus14 = 8, which matches the staging chip. Phase 98 was pushed to staging only (6b5cc3b7..e0240304), and both the Railway and Pages deploys succeeded. Claude piloted the UAT in desktop Chrome: placement, chips, order, colours, every tap-through, the 390px wrap and the after-4pm Tasks grouping all passed. The owner approved the UAT, including the real iPad.

## Commits
- 062e7fb1 chore(98-06): read-only past-schedule spike + rollout log
- e0240304 docs(98-06): past-schedule spike result (D-10 gate)
- 5955210b / f60dd163 docs(98-06): staging UAT results

## Deviations
- The owner asked Claude to run the spike instead of running it themselves (read-only, via `railway ssh -e production`).
- UAT item 5 (invite count drop after a live Send Invite) was not run, because it sends a real email. Unit tests cover it.

## Follow-ups
- The Tasks "This Week" boundary still uses UTC (from 98-03).
- Production deploy is pending (staging only so far).

## Self-Check: PASSED

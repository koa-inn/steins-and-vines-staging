---
phase: 86-vessels-fermschedules-config-postgres
plan: 04
subsystem: ui
tags: [admin, brewpad, ferm-schedules, optimistic-concurrency, jest]
requires: []
provides:
  - Admin and BrewPad schedule editors send expected_updated_at and handle 409 stale_schedule / schedule_in_use
  - Admin archive_ferm_schedule action and propagate batches_failed Retry
  - BrewPad vessel label in pickers and search
affects: [86-06, 86-13, 86-16]
tech-stack:
  added: []
  patterns: [err.code/err.status on proxy errors, sibling stale-toast helpers]
key-files:
  created:
    - tests/frontend/admin-schedule-stale-archive.test.js
    - tests/frontend/admin-schedule-propagate-retry.test.js
    - tests/frontend/brewpad-schedule-stale-archive.test.js
  modified:
    - js/admin.js
    - js/brewpad.js
    - js/admin.min.js
    - js/brewpad.min.js
key-decisions:
  - "BrewPad adminApiPost did not propagate err.code/err.status despite the plan's interface note; added additively, same as admin handleProxyResponse"
  - "Archive button added to admin cards only; BrewPad reaches archive solely through the schedule_in_use 'Archive instead' toast action"
  - "expected_updated_at is omitted when the schedule has no last_updated (sheets mode), so old servers are unaffected"
requirements-completed: [DB-05]
duration: 25min
completed: 2026-10-07
---

# Phase 86 Plan 04: Schedule editor stale/archive/in-use/propagate-retry Summary

Both schedule editors now send expected_updated_at on update/delete/archive and handle 409 stale_schedule (Reload) and schedule_in_use (Archive instead), admin lists failed propagate batch ids with Retry, and BrewPad vessel pickers show the vessel label.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Admin editor | 13864258 | handleProxyResponse code/status; Archive+Delete cards; propagateSchedule with Retry |
| 2 BrewPad editor + label | 95a1f433 | adminApiPost code/status; deleteSchedule/archiveSchedule; buildVesselLabel/search label |
| 3 Build + gate | 921d232e | Rebuilt min bundles and re-stamped cache versions on HTML pages |

Verification: root `npm test` (153 suites, 2173 tests), `npm run lint`, and `zoho-middleware` `npm test` (161 suites, 2518 tests) all pass. New suites: 10 + 3 + 10 tests. Existing blast-radius, proxy-transport, read-retry and recipe-stale-save suites pass unmodified.

## Deviations from Plan

**1. [Rule 3 - Blocking] BrewPad adminApiPost lacked err.code/err.status**
- The plan said it already propagates them; it threw a plain Error. Added code/status additively (message expression unchanged).
- Commit: 95a1f433

**2. [Rule 3 - Blocking] Test seams**
- Added test-only exports in admin.js (`_setBatchesDataForTest`, `_renderScheduleTemplatesForTest`, `_scheduleFormForTest`, `_propagateScheduleForTest`) and in brewpad.js (delete/archive/fermSchedules/vessels/label/search seams).

**3. TDD note:** tests were written alongside the implementation and passed on first run; a separate RED commit was not made.

Environment: worktree base was reset to d2c66be9 per the branch check; node_modules were symlinked (untracked, not committed). Build also rewrote cache-version query strings on public HTML pages (committed in the build commit); links.html and HANDOFF-infrastructure.md were not touched.

## Known Stubs

None.

## Threat Flags

None. T-86-04-01..04 mitigated: all new toasts use textContent (hostile batch id test), new card markup uses escapeHTML, expected_updated_at is sent, 409 is never retried (tested by call count).

## Self-Check: PASSED

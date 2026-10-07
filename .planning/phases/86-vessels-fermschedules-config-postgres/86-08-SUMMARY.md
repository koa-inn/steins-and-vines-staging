---
phase: 86-vessels-fermschedules-config-postgres
plan: 08
subsystem: apps-script
tags: [apps-script, adminApi, mirror, vessels, ferm-schedules]
requires: ["86-03"]
provides:
  - "mirror_vessel_state, mirror_ferm_schedule_state, mirror_ferm_schedule_delete server_token actions"
  - "ferm_schedule_ref_count (D-15)"
  - "propagate_ferm_schedule batches_failed (D-14)"
affects: [86-11, 86-14, 86-18]
key-files:
  created:
    - tests/frontend/adminapi-ops-mirror.test.js
    - tests/frontend/adminapi-ferm-schedule-ref-count.test.js
    - tests/frontend/adminapi-propagate-batch-failures.test.js
  modified:
    - apps-script/adminApi.gs
requirements-completed: [DB-05]
completed: 2026-10-07
---

# Phase 86 Plan 08: Apps Script v61 part B Summary

Additive adminApi.gs changes completing v61: header-addressed state-copy mirrors for Vessels and FermSchedules (shared `_mirrorUpsertRow`), a fresh-read schedule batch ref count, and per-batch failure reporting in propagate. Nothing deployed; no staff action exists.

## Commit
- 40417a33: all adminApi.gs changes plus the three new test files (one commit, since both tasks edit the same file region set).

## Verification
Root `npm test` (2227 pass), `npm run lint`, `zoho-middleware npm test` (2568 pass). Existing adminapi suites (propagate, recipe-mirror, giftcard-mirror) unmodified and green.

## Removed lines in adminApi.gs (vs phase-86 wave-1 base)
- early-return object in propagate (re-added with `batches_failed: []`)
- `activeBatches.forEach(function (batch) {` (now `var propagateOneBatch = function (batch) {`, wrapped by a try/catch forEach)
- `batches_updated: activeBatches.length,` (now minus failures)
- `tasks_removed: totalRemoved` (trailing comma added for `batches_failed`)

## Deviations from Plan
- Cache eviction (`gfs`, `gbi`, FermSchedules sheet cache) lives inside the mirror functions via `_evictFermScheduleCaches()` rather than in the dispatcher, so it is directly testable. Behaviour is equivalent. The Vessels read path (`get_vessels`) is uncached, so only the in-memory sheet cache is invalidated.
- Text timestamps use `setNumberFormat('@')` on created_at/last_updated cells before the write (mirrorRecipeState has no such handling to copy); guarded by a `typeof` check.
- Tasks 1 and 2 were committed together; tests were written alongside the implementation (RED not separately observed).
- On a failed propagate batch, the aggregate counters are restored to their pre-batch values so counts reflect successful batches only (partial sheet writes for that batch are not rolled back).

## Self-Check: PASSED

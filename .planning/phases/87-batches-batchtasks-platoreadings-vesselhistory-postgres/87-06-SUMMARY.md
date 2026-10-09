---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 06
subsystem: database
tags: [postgres, batches, reads, golden-parity]
requires:
  - phase: 87-02
    provides: migration 0005_batches.sql
  - phase: 87-03
    provides: batch-rules.js and golden fixtures
provides:
  - lib/batch-pg-read.js (all batch reads as parameterised SQL)
  - __tests__/db/helpers/batch-seed.js (synthetic workbook loader for real-PG tests)
affects: [87-07, 87-08, 87-15]
tech-stack:
  added: []
  patterns: [SQL fetch + batch-rules shaping, client-injected module, no caching]
key-files:
  created:
    - zoho-middleware/lib/batch-pg-read.js
    - zoho-middleware/__tests__/db/batch-pg-read.test.js
    - zoho-middleware/__tests__/db/helpers/batch-seed.js
  modified: []
key-decisions:
  - "Reads fetch rows with SQL and delegate all shaping, sorting and bucket math to batch-rules.js, so parity logic lives in one place"
  - "DEFAULT_TIMEZONE ('America/Vancouver', Q3) is exported from batch-pg-read, not batch-rules (batch-rules already defaults to it internally)"
requirements-completed: [DB-06]
duration: 25min
completed: 2026-10-09
---

# Phase 87 Plan 06: Batch Postgres Reads Summary

Every batch read (list, detail, public, dashboard, calendar, upcoming, location conflict, lock, mirror bundle, counts) is now parameterised SQL whose output deep-equals the Apps Script golden outputs on a real Postgres 18.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Seed helper + point reads | 8bed9b5b | list/detail/public/conflict/bundle/lock/counts |
| 2 Dashboard, calendar, upcoming | 8bed9b5b | same commit (both tasks share one file and test) |

## Verification

- `npx jest --config jest.db.config.js __tests__/db/batch-pg-read.test.js`: 61 pass (all golden getBatches, getBatchDetail, public, location-conflict, dashboard, calendar, upcoming entries, plus local-midnight bucketing and an EXPLAIN check that the conflict query uses batches_location_idx).
- Middleware suite 185 suites / 2932 tests pass; root suite 163 suites / 2268 pass; both lints clean.
- `timingSafeEqual` present once; no `require('pg')`.

## Deviations from Plan

- Tasks 1 and 2 were committed together (one file and one test file serve both), so there is no separate RED commit.
- The plan said the default timezone constant is exported from batch-rules; it is not there, and the plan did not list batch-rules as modifiable, so `DEFAULT_TIMEZONE` lives in batch-pg-read.js.
- The upcoming read uses the partial `batch_tasks_open_due_idx` (open tasks of active batches). Dashboard and calendar read all tasks of active batches, because "ready to bottle" and the calendar's undated-packaging rule need completed tasks too, so they cannot use the open-only index.
- `getTasksUpcoming` accepts `{now}` per the interface sketch only nominally; it is unused because upcoming does not depend on the clock.

## Notes for later plans

- `findLocationConflict(client, {vessel_id, shelf_id, bin_id}, excludeBatchId)` compares bin as text, so numeric and string bins match, as in the script.
- Wrong-token and disabled public requests never run the child-table queries.
- Child rows are ordered in SQL by id; batch-rules re-sorts anyway.

## Known Stubs

None.

## Self-Check: PASSED

Files exist: batch-pg-read.js, batch-pg-read.test.js, batch-seed.js. Commit 8bed9b5b present.

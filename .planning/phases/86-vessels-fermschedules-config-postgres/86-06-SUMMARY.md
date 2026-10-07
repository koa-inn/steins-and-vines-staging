---
phase: 86-vessels-fermschedules-config-postgres
plan: 06
subsystem: database
tags: [postgres, ferm-schedules, sequences, optimistic-concurrency]
requires:
  - phase: 86-01
    provides: ferm-schedule-rules, stale-token, 0004_ops_data migration
provides:
  - lib/ferm-schedule-pg.js atomic SQL layer (list/get/create/update/archive/delete/countRecipeReferences)
affects: [86-11, 86-13]
key-files:
  created:
    - zoho-middleware/lib/ferm-schedule-pg.js
    - zoho-middleware/__tests__/db/ferm-schedule-pg-read-create.test.js
    - zoho-middleware/__tests__/db/ferm-schedule-pg-mutate.test.js
key-decisions:
  - "Update does not accept is_active (the .gs updateFermSchedule does not); archive is the only deactivation path"
  - "Steps errors on update are returned before taking the row lock"
requirements-completed: [DB-05]
duration: 15min
completed: 2026-10-07
---

# Phase 86 Plan 06: ferm-schedule-pg Summary

Transactional ferm-schedule layer with sequence-backed FS- ids, D-16 stale guard, and reference-guarded hard delete, proven on real Postgres 18.

## Tasks

1. Serializer, list/get, createSchedule, countRecipeReferences, plus parallel-create proof: c169e920
2. updateSchedule, archiveSchedule, deleteSchedule with tests: committed in the follow-up commit (see git log, `test(86-06)`)

## Deviations from Plan

**1. [Process] Module written in one pass.** update/archive/delete were already in the file at the Task 1 commit; Task 2 commit adds only their test file (and a comment reword so the `max(` acceptance grep returns 0).

**2. [Environment] Worktree base reset.** Worktree started at a509e397; reset to expected base ae737513 per the branch-check step.

No existing tests modified.

## Verification

- `npm run test:db -- ferm-schedule-pg`: 2 suites, 16 tests pass (incl. parallel-create and concurrent-update lock tests)
- `npm test` (middleware): 165 suites, 2568 tests pass; `npm run lint` clean
- Frontend `npm test` not run (no frontend files touched)

## Known Stubs

None.

## Self-Check: PASSED

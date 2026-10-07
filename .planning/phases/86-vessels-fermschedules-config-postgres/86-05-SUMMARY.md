---
phase: 86-vessels-fermschedules-config-postgres
plan: 05
subsystem: database
tags: [postgres, vessels, optimistic-concurrency]
requires: [86-01]
provides:
  - zoho-middleware/lib/vessel-pg.js atomic vessel SQL layer
affects: [86-11, 86-13, 86-15]
tech-stack:
  patterns: [client-injected atomic module, select-for-update stale guard, fixed SET allowlists]
key-files:
  created:
    - zoho-middleware/lib/vessel-pg.js
    - zoho-middleware/__tests__/db/vessel-pg-read-create.test.js
    - zoho-middleware/__tests__/db/vessel-pg-update.test.js
decisions:
  - Blank numeric/text fields store NULL (serialised ''); actor is never defaulted (null when absent)
metrics:
  tasks: 2
  completed: 2026-10-07
requirements: [DB-05]
---

# Phase 86 Plan 05: Vessel Postgres layer Summary

`lib/vessel-pg.js` provides list/get in the Apps Script get_vessels shape, create, allowlisted update with the D-16 stale guard and immutable ids, archive/unarchive with no delete export, idempotent status deltas, and next-free-id.

## Verification
- `npm run test:db -- vessel-pg`: 16 tests passed on real Postgres (Docker)
- `npm run lint` clean; `npm test` (middleware) 2568 passed

## Deviations from Plan

- Worktree base was wrong at start (a509e397); reset to expected base ae737513 per the branch check.
- TDD ordering: the module was written in one pass covering both tasks before the tests, so the Task 1 commit contains the full module and Task 2 commit contains only its test file. No RED commit exists for either task.
- Extra error code `missing_fields` from updateVessel when type is set blank (not listed in the interface; additive).

## Known Stubs
None.

## Self-Check: PASSED
Files and commits 379abfb0, 13d7c3e7 exist.

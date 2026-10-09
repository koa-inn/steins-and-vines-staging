---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 02
subsystem: database
tags: [postgres, migration, feature-flag, batches]
requires:
  - phase: 87-01
    provides: approved 87-DESIGN.md schema and flag rules
provides:
  - migration 0005_batches.sql (six tables, four sequences, cascade FKs)
  - lib/batch-flag.js (BATCHES_STORE mode, boot rules, BATCHES_FREEZE helpers)
affects: [87-03, 87-04, later Phase 87 plans]
tech-stack:
  added: []
  patterns: [flag outside STORE_ENV_NAMES, per-call env freeze switch]
key-files:
  created:
    - zoho-middleware/migrations/0005_batches.sql
    - zoho-middleware/__tests__/db/batches-migration.test.js
    - zoho-middleware/lib/batch-flag.js
    - zoho-middleware/__tests__/batch-store-flag.test.js
  modified:
    - zoho-middleware/server.js
key-decisions:
  - "BATCHES_STORE kept out of STORE_ENV_NAMES (Q15) so store-flag.test.js is untouched"
requirements-completed: [DB-06]
duration: 20min
completed: 2026-10-09
---

# Phase 87 Plan 02: Batches Migration and Flag Summary

Additive migration 0005_batches.sql exactly as approved in 87-DESIGN.md, plus lib/batch-flag.js with BATCHES_STORE boot rules (dual refused, postgres needs OPS_DATA_STORE not sheets) and a per-call BATCHES_FREEZE switch.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Migration + real-PG test | 175bb4d0 | migrate:guard passes; 10 real-PG tests pass; 3 cascade FKs, no backslashes |
| 2 batch-flag + server.js wiring | a7fc70f7 | 14 new unit tests; server.js calls validateBatchesFlag and isDatabaseRequired honours postgres mode |

## Verification

- `npm run migrate:guard` OK (5 files); batches-migration.test.js 10/10 against Docker Postgres.
- Middleware suite 184 suites / 2824 tests pass; root suite 161 suites / 2248 tests pass; both lints clean.
- store-flag.test.js, ops-store-flag.test.js, health-database-required.test.js unmodified and green.

## Deviations from Plan

- The worktree base was not the target commit, so it was reset to 10802be8 per the startup check.
- The acceptance check `git diff 8487c6e7 -- store-flag.test.js` was not run against that SHA (unavailable context); the file is unmodified in my commits.
- The migration header comment avoids the phrase "unique ... step_number" so the grep acceptance check returns 0.

## Known Stubs

None.

## Self-Check: PASSED

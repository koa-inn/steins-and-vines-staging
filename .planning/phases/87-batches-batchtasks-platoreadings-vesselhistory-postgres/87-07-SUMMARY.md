---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 07
subsystem: database
tags: [postgres, batches, create, idempotency, advisory-lock]
requires:
  - phase: 87-06
    provides: batch-pg-read (findLocationConflict), batch-seed
  - phase: 87-03
    provides: batch-rules (dedupDecision, calculateDueDate, manualCreateFingerprint)
provides:
  - lib/batch-pg-create.js createBatch(client, payload, opts) - transactional, idempotent
affects: [87-08, 87-09, 87-15]
tech-stack:
  added: []
  patterns: [caller-owned transaction, advisory locks with fixed order, savepoint around unique-index backstop]
key-files:
  created:
    - zoho-middleware/lib/batch-pg-create.js
    - zoho-middleware/__tests__/db/batch-pg-create.test.js
    - zoho-middleware/__tests__/db/batch-pg-idempotency.test.js
    - zoho-middleware/__tests__/db/batch-create-latency.test.js
  modified: []
key-decisions:
  - "Lock order is always location lock, then invoice|sku or fingerprint lock, so concurrent creates cannot deadlock"
  - "23505 on batches_unit_seq_idx is caught inside a savepoint so the caller's transaction stays usable and the rejection resolves as duplicate_so_number"
requirements-completed: [DB-06]
duration: 40min
completed: 2026-10-09
---

# Phase 87 Plan 07: Postgres createBatch Summary

createBatch writes the batch, tasks, initial VesselHistory row and the vessel In-Use status in the caller's one transaction (vessel-pg.applyStatusChanges and ferm-schedule-pg.getSchedule on the same client), with invoice and manual idempotency enforced by advisory locks.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 createBatch port + 14 real-PG tests | 903a2161 | validation, pending vs scheduled, tasks, history, vessel, conflict, rollback |
| 2 Idempotency + latency tests | 46984db7 | 12 idempotency tests + latency test |

## Verification

- `npm run test:db`: 28 suites / 284 tests pass (includes the three new files).
- Middleware `npm test`: 187 suites / 2958 tests; root `npm test`: 163 suites / 2268 tests; both lints clean.
- Three parallel creates for unit_total 2 yield exactly 2 batches; three parallel identical manual creates yield one.
- 20 sequential scheduled creates with a vessel pass the median < 500 ms / max < 2 s check.

## Deviations from Plan

- Both tasks' implementation went into one file written up front, so Task 1's commit already contains the idempotency code; Task 2's commit adds only its tests, which passed on first run (no separate RED commit for Task 2).
- [Rule 2] Added input validation Apps Script lacked: malformed start_date returns `invalid_start_date`, non-numeric target_volume_l/scale_factor returns `invalid_number` (otherwise Postgres would throw and surface as a 500).
- Invoice-only creates (no SKU) store unit_seq NULL; unit_seq is set only when SKU is present, matching the unique index scope.
- The worktree base differed from the target commit and was reset to 4f30a777 per the startup check.

## Notes for later plans

- Callers must run createBatch inside db.withTransaction and commit even after an `ok:false` (nothing is written on rejection except advisory locks, so rollback is equally fine).
- Result carries `_batchId` and `_vesselApplied` for the Sheets mirror; replay results carry `_vesselApplied: []`.
- The replay window defaults to 120000 ms (Q11); override with opts.replayWindowMs.
- fermentation_started_at is start_date at UTC midnight for scheduled batches (Apps Script stored the raw start_date string).

## Known Stubs

None.

## Self-Check: PASSED

Files exist: batch-pg-create.js and the three test files. Commits 903a2161 and 46984db7 present.

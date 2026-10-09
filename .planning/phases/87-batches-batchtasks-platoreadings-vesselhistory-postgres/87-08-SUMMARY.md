---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 08
subsystem: database
tags: [postgres, batches, transfers, tombstones, schedule-reconcile]
requires:
  - phase: 87-06
    provides: batch-pg-read.js (lockBatch, findLocationConflict)
  - phase: 87-03
    provides: batch-rules.js
provides:
  - lib/batch-pg-update.js (updateBatch, applyLocationChange, deleteBatch, updateBatchSchedule, regenerateToken, isVersionConflict)
affects: [87-09, 87-15]
tech-stack:
  added: []
  patterns: [lock row first, validate everything before first write, single applyStatusChanges call on the same client]
key-files:
  created:
    - zoho-middleware/lib/batch-pg-update.js
    - zoho-middleware/__tests__/db/batch-pg-update.test.js
    - zoho-middleware/__tests__/db/batch-pg-delete-schedule.test.js
  modified: []
key-decisions:
  - "applyLocationChange takes the locked row and a location object and returns {ok, changed, vesselChanges, location}; the caller owns the one applyStatusChanges call (87-09 reuses it for the transfer-task path)"
  - "_vesselApplied is the array of vessel ids whose status actually changed (applyStatusChanges().applied)"
  - "Location conflicts are serialised with pg_advisory_xact_lock(hashtext('batch-location:'||vessel)) (Q7); no unique index"
requirements-completed: [DB-06]
duration: 35min
completed: 2026-10-09
---

# Phase 87 Plan 08: Batch update, transfer, delete, schedule, token Summary

Batch edits, vessel transfers, cascading deletes with tombstones, schedule reconcile and token rotation are now single-transaction Postgres operations that keep Apps Script semantics.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 updateBatch + applyLocationChange | 559ea609 | 21 real-PG tests |
| 2 deleteBatch, updateBatchSchedule, regenerateToken | c4f28cdc | implementation was written with Task 1 (one module); this commit adds the 13 tests |

## Verification

- `npm run test:db`: 27 suites / 290 tests pass (includes the 34 new tests).
- Root `npm test`: 163 suites / 2268 pass. Middleware `npm test`: 187 suites / 2958 pass. Root and middleware lint clean.
- `grep -c isStale` = 0; `applyStatusChanges(client` present; deleteBatch body has no hand-written child deletes.

## Deviations from Plan

**1. [Rule 2 - Correctness] deleteBatch also clears batch_create_dedup rows for the batch.** A manual-create retry inside the 2-minute window would otherwise return `idempotent_replay` pointing at a deleted batch. One extra statement, same transaction.

**2. [Rule 3 - Process] Task 1 and 2 implementation landed together.** The module is one file; Task 2's commit contains the tests only, so there is no separate RED commit for Task 2.

**3. Interface choices beyond the sketch.** `invalid_input` is used for a bad `recipe_snapshot` (plan) where the script said `invalid_snapshot`. Malformed schedule snapshots return `invalid_data` (script code); non-array or steps without numeric `step_number`/`day_offset` also return `invalid_data` (the columns are NOT NULL). Bad `start_date` / timestamp fields return `invalid_input` instead of storing junk.

## Notes for later plans

- Faithful-to-script smell, not fixed: when a status change and a vessel move arrive together, the status flip uses the OLD vessel id (script behaviour). E.g. complete -> primary with a vessel move leaves the old vessel In-Use. Worth a decision before cutover.
- The Q9 `warnings` array (transfer-task conflict) belongs to 87-09, which calls `applyLocationChange` and surfaces `location_conflict` as a warning while still completing the task.
- Date-only strings destined for `fermentation_started_at` are parsed as UTC midnight (`new Date('YYYY-MM-DD')`); the current `start_date` (local-midnight Date) is formatted with local getters first, so the same day yields the same stamp.
- Existing pre-87-08 smell: `batch-pg-read.loadChildren` runs three queries with `Promise.all` on one client, which triggers a pg deprecation warning (removed in pg 9). Not touched.
- `updateBatchSchedule` follows the script on duplicate step numbers (the later row is the one updated; all duplicates of a vanished open step are removed).

## Known Stubs

None.

## Self-Check: PASSED

Files exist: batch-pg-update.js, batch-pg-update.test.js, batch-pg-delete-schedule.test.js. Commits 559ea609 and c4f28cdc present. STATE.md and ROADMAP.md untouched.

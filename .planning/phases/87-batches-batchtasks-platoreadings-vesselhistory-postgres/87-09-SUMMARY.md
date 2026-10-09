---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 09
subsystem: database
tags: [postgres, batches, tasks, plato-readings, propagate, row-lock]
requires:
  - phase: 87-06
    provides: batch-pg-read.js (lockBatch)
  - phase: 87-08
    provides: batch-pg-update.js (applyLocationChange)
provides:
  - lib/batch-pg-tasks.js (updateBatchTask, bulkUpdateBatchTasks, addBatchTask, addPlatoReading, bulkAddPlatoReadings, updatePlatoReading, deletePlatoReading, propagateSchedule)
affects: [87-15]
tech-stack:
  added: []
  patterns: [lock batch row first, one applyStatusChanges per call, savepoint per batch, publicBatchId option for the token route]
key-files:
  created:
    - zoho-middleware/lib/batch-pg-tasks.js
    - zoho-middleware/__tests__/db/batch-pg-tasks.test.js
    - zoho-middleware/__tests__/db/batch-pg-readings-propagate.test.js
  modified: []
key-decisions:
  - "opts.publicBatchId marks the public route: forces actor batch-url, refuses packaging completion and any task/reading of another batch with unauthorized (Q8)"
  - "Transfer completion with a location conflict completes the task and returns warnings ['location_conflict: <message>'] (Q9)"
  - "bulkUpdateBatchTasks pre-locks all involved batches in sorted order, then runs items sequentially; per-item results drop underscore-prefixed internal fields"
  - "propagateSchedule failures return {batch_id, error:'propagate_failed'} only; no DB text"
requirements-completed: [DB-06]
duration: 40min
completed: 2026-10-09
---

# Phase 87 Plan 09: Tasks, readings, propagate Summary

Shop-floor writes (task completion with packaging/transfer side effects, bulk, add task, Plato readings CRUD, schedule propagation) run in Postgres with the batch row locked per mutation and vessel status flips in the same transaction.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Task completion, bulk, add, public rules | 5764bef9 | module + 21 real-PG tests (incl. 2 concurrency) |
| 2 Readings + propagateSchedule | 59d6797d | implementation landed with Task 1 (one module); this commit adds 14 tests |

## Verification

- `npm run test:db`: 32 suites / 353 tests pass. Middleware `npm test`: 188 suites / 2966 pass. Root `npm test`: 163 / 2268 pass. Both lints clean.
- One 120 s container-start timeout on the first run of the readings suite; rerun passed.

## Deviations from Plan

**1. [Process] Task 1 and 2 implementation in one commit.** Same pattern as 87-08; Task 2 commit holds tests only (no separate RED commit).

**2. [Plan wording] Concurrency test reshaped.** The plan describes two concurrent completions of the last two non-packaging tasks with packaging already done. In the Apps Script (and this port) the batch completes only when the packaging task is completed, so that scenario can never complete a batch. The tests instead cover the real race: one client completes the last regular task (uncommitted) while another completes packaging (must wait on the lock, then see the task done and complete the batch), plus a double packaging completion that completes the batch exactly once (completed_at keeps the first timestamp).

**3. [Rule 2] Extra validation.** addBatchTask rejects non-integer/out-of-range day_offset and malformed due_date with `invalid_input`; propagateSchedule rejects steps without int step_number/day_offset with `invalid_data` (columns are integer, so otherwise a PG error). Public reading add/update/delete also enforce batch ownership (add: payload batch_id must equal the token's batch).

**4. Test vessel ids** use `XX-101` style (vessels check constraint) rather than `V-..`.

## Notes for later plans (87-15 routes)

- Route must pass `{publicBatchId: <token batch>}` for the token route and the validated batch id; the module forces `batch-url` as actor.
- Results carry `_batchId` / `_batchIds` / `_vesselApplied` for cache busting and mirror; strip before responding. `warnings` is additive on update_batch_task only.
- Faithful-to-script smell, not fixed: un-completing a packaging task always sets status primary/secondary even if the batch was not complete.
- Existing smell (87-06): `batch-pg-read.loadChildren` uses Promise.all on one client.

## Known Stubs

None.

## Self-Check: PASSED

Files exist; commit 5764bef9 and the readings/propagate test commit present. STATE.md and ROADMAP.md untouched.

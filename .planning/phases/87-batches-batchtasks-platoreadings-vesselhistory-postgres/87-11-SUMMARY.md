---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 11
subsystem: middleware
tags: [postgres, batches, facade, freeze, ops-mirror, public-token]
requires:
  - phase: 87-02
    provides: batch-flag.js
  - phase: 87-07
    provides: batch-pg-create
  - phase: 87-09
    provides: batch-pg-tasks
  - phase: 87-10
    provides: ops-mirror batch entity
provides:
  - lib/batch-store.js single issuer facade (28 exports incl. WRITE_OPS)
affects: [87-12, 87-13, 87-15]
key-files:
  created:
    - zoho-middleware/lib/batch-store.js
    - zoho-middleware/__tests__/batch-store.test.js
    - zoho-middleware/__tests__/batch-public-store.test.js
key-decisions:
  - "Freeze check runs before the mode check so sheets mode also returns the maintenance envelope for writes"
  - "Public POST token check locks the batch row in the same transaction (lockBatch + timingSafeEqual), no caching"
requirements-completed: [DB-06]
completed: 2026-10-09
---
# Phase 87 Plan 11: Batch Store Facade Summary

lib/batch-store.js dispatches every batch op on BATCHES_STORE (null in sheets mode), applies the BATCHES_FREEZE maintenance envelope to all 14 WRITE ops in both modes, runs one transaction per op over the batch-pg-* modules, schedules `batch` and `vessel` mirrors after commit and strips underscore keys.

## Tasks
| Task | Commit | Notes |
|------|--------|-------|
| 1 Facade core | see git log (feat(87-11)) | 18 tests |
| 2 Public ops | same commit | 7 tests; both tasks share one file, so one commit |

## Verification
- Middleware `npm test` 192 suites / 3016 tests; `npm run test:db` 32 suites / 353 tests; root `npm test` 163 / 2268; both lints clean.

## Deviations from Plan
- Tasks 1 and 2 landed in a single commit (one source file; precedent from 87-08/09).
- Public token id regex is `SV-B-[0-9]{6,}` (matches batch-pg-read) rather than the script's exactly six digits.

## Notes for later plans
- Callers must treat `null` as "fall through to Apps Script" and `{ok:false,error:'maintenance'}` as a final answer; rejections map to 502.
- Token route passes batch id and token from the URL/body: `publicUpdateTask(id, token, {task_id, updates})`, `publicAddReadings(id, token, readings)`.
- `batchInit` returns `{ok:true,data:{batches,schedules:{schedules},summary}}`; schedules come from ferm-schedule-store in a second transaction.
- `listAll` returns a bare array of list rows (or null in sheets mode).
- Create under freeze logs `[batch-store] create_batch refused: maintenance invoice=<no>` (invoice only).

## Known Stubs
None.

## Self-Check: PASSED

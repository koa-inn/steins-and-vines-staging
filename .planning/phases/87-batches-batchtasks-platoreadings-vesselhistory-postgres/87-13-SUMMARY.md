---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 13
subsystem: middleware
tags: [postgres, batches, kiosk, freeze, reference-counts]
requires:
  - phase: 87-11
    provides: lib/batch-store.js facade
provides:
  - non-route batch callers (sale create hook, live index, ref counts, propagate) routed through batch-store
affects: [87-15, 87-17]
key-files:
  modified:
    - zoho-middleware/lib/brewpad-integration.js
    - zoho-middleware/lib/recipe-store.js
    - zoho-middleware/lib/ferm-schedule-store.js
  created:
    - zoho-middleware/__tests__/batch-callers-postgres.test.js
key-decisions:
  - "brewpad-integration gates on batchStore.isPostgres()/isFrozen() synchronously so sheets mode issues axios.post in the same tick (existing tests assert this); ref-count and propagate seams fall through on a null facade result"
requirements-completed: [DB-06]
completed: 2026-10-09
---
# Phase 87 Plan 13: Direct Batch Callers Summary

Sale batch creation, the reconcile live-batch index, both batch reference counts and schedule propagate now use lib/batch-store.js in postgres mode; sheets mode behaves exactly as before.

## Tasks
| Task | Commit | Notes |
|------|--------|-------|
| 1 brewpad create + live index | 24698e87 | freeze logs invoice only, goes through the existing retry queue |
| 2 ref counts + propagate | 163f5138 | fail closed with batch_ref_unavailable; batches_failed always an array |

## Verification
Middleware npm test 195 suites / 3062 tests; test:db 32 / 353; root npm test 163 / 2268; both lints clean. No existing test modified.

## Deviations from Plan
- [Rule 1] First draft chained through the facade promise even in sheets mode, which delayed axios.post by microtasks and broke fire-and-forget assertions in brewpad-integration and brewpad-batch-slots tests. Fixed by a synchronous isPostgres/isFrozen gate in brewpad-integration.
- The single new test file covers both tasks and was committed with Task 1.

## Known Stubs
None.

## Self-Check: PASSED

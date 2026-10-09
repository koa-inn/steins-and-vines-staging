---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 10
subsystem: middleware
tags: [ops-mirror, batches, sheet-mirror, postgres]
requires: [87-04, 87-06]
provides: [batch entity in ops-mirror worker]
affects: [zoho-middleware/lib/ops-mirror.js]
key-files:
  modified: [zoho-middleware/lib/ops-mirror.js]
  created: [zoho-middleware/__tests__/ops-mirror-batch.test.js]
decisions:
  - "Kept the existing buildMirrorRequest(entity, row, id) argument order (the plan text said (entity, id, row)) so vessel/fermsched callers and ops-mirror.test.js are untouched"
metrics:
  completed: 2026-10-09
  tasks: 1
  files: 2
requirements: [DB-06]
---

# Phase 87 Plan 10: Batch entity in ops-mirror Summary

ops-mirror now has a `batch` entity (prefix `ops:mirror-dirty:batch:`, label `batches.mirror`) that reads the latest bundle via `getBatchBundle` at send time and posts `mirror_batch_state` (batch, tasks, readings, history), or `mirror_batch_delete` when the batch is gone.

## Tasks

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | batch entity in ops-mirror (TDD) | 6d9870d2 |

## Changes
- `ENTITIES.batch`, a batch branch in `buildMirrorRequest`, and a batch branch in `readLatest` (lazy `require('./batch-pg-read')`).
- Serial chain, Redis marker, backoff and sweep are reused unchanged; the production-only gate stays in `sheet-mirror.mirrorFireAndForget`.
- New test file covers config, request building, off-prod no-op, marker lifecycle, delete, retry and Sentry tags (component/entity/id only), and sweep key parsing.

## Verification
Root `npm test` (2268), middleware `npm test` (2966), `npm run test:db` (256), and `npm run lint` all pass. `ops-mirror.test.js` is unmodified and green.

## Deviations from Plan
Only the argument-order note above. Otherwise the plan was executed as written. At start, the worktree was reset to the expected base 4f30a777, as the startup check instructed.

## Known Stubs
None.

## Self-Check: PASSED

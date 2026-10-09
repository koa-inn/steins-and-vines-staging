---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 04
subsystem: apps-script
tags: [apps-script, mirror, postgres, batches]
requires: ["87-01"]
provides:
  - "Apps Script v62 actions mirror_batch_state, mirror_batch_delete, export_batch_tabs"
  - "setupBatchMirrorNotices / removeBatchMirrorNotices editor functions"
affects: [87-11, 87-15, 87-18]
key-files:
  modified: [apps-script/adminApi.gs]
  created: [tests/frontend/adminapi-batch-mirror.test.js]
requirements-completed: [DB-06]
completed: 2026-10-09
---

# Phase 87 Plan 04: Apps Script v62 batch mirror Summary

Additive Apps Script v62: per-batch bundle mirror (write and delete), a read-only four-tab export for the daily drift check, and D-12 notice setup/teardown. Not deployed (87-18 does that).

## What was built
- `mirrorBatchState`: validates ids (SV-B-, BT-, PR-, VH-), takes the 15s script lock, upserts the Batches row by header name (case-insensitive, so `target_volume_l` fills `target_volume_L`), upserts children by id forcing `batch_id` to the bundle's batch, deletes the batch's child rows whose ids were not supplied (bottom-up, batch_id equality only). Omitted child arrays are not reconciled. Values are written verbatim. Caches evicted in `finally` (`_invalidateBatchCache` plus all four sheet caches).
- `mirrorBatchDelete`: deletes children then the batch row; unknown id returns `{ok:true, deleted:0}`.
- `exportBatchTabs`: header-keyed arrays per tab plus a `headers` map; blank-id rows skipped.
- All three dispatched only inside the `server_token` branch of `doPost` (next to `mirror_vessel_state`); not in `handleReadAction`, so staff OAuth cannot reach the export.
- `setupBatchMirrorNotices` / `removeBatchMirrorNotices`: row-1 note "mirror only ..." plus one warning-only sheet protection per tab described "Phase 87 batch mirror"; idempotent; removal touches only that description. No row inserted, no dispatch entry.

## Verification
18 new tests pass; existing adminapi-ops-mirror and phase82-dispatch tests unmodified and green. Root `npm test` (2266) and `zoho-middleware` `npm test` (2809) pass; `npm run lint` clean.

## Deviations from Plan
- Tasks 1 and 2 were committed together (one commit, 11f66e48) because both edit the same two files and the notice helpers share the test harness. Otherwise as written.
- The "Version" comment bump to v62 was skipped: the file carries no version marker.
- Protection is sheet-level (`sheet.protect()`) rather than a data-range protection so appended rows are covered.

## Known Stubs
None.

## Threat Flags
None beyond the plan's threat model (T-87-04-01..05 mitigated: token-gated dispatch, batch_id-equality deletes, lock in finally).

## Self-Check: PASSED

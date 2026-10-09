---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 14
subsystem: database
tags: [postgres, backfill, verify, replay, rollback, apps-script-mirror]
requires:
  - phase: 87-05
    provides: batch backfill specs and plan builder (row normalisation)
  - phase: 87-06
    provides: batch-pg-read getBatchBundle
  - phase: 87-10
    provides: ops-mirror batch entity (buildMirrorRequest)
provides:
  - lib/batch-compare.js pure four-table comparator (compareBatchTables, normalizeSheetTables, summarize), reusable by the 87-15 drift check
  - batches-verify CLI (read-only, exit 4 on any mismatch)
  - batches-replay-to-sheet CLI (rollback step one)
affects: [87-15 drift check, 87 window and rollback runbook]
tech-stack:
  added: []
  patterns: [dependency-injected CLI ({pool, axios, log, env}), value-free id/field/count output]
key-files:
  created:
    - zoho-middleware/lib/batch-compare.js
    - zoho-middleware/scripts/backfill/batches-verify.js
    - zoho-middleware/scripts/backfill/batches-replay-to-sheet.js
    - zoho-middleware/__tests__/backfill/batches-verify.test.js
    - zoho-middleware/__tests__/backfill/batches-replay-to-sheet.test.js
  modified: []
key-decisions:
  - "Sheet rows are normalised by buildBatchesBackfillPlan so verify and backfill cannot disagree; rows it refuses surface as '<table> <id> sheet_<reason>' mismatches (no values)"
  - "Header check is exact and ordered against the pinned spec headers; unit_seq is Postgres-only and never compared"
  - "Replay classifies a tombstone whose batch exists again as state; an id both updated and tombstoned is sent once; state requests go first, then deletes"
patterns-established:
  - "Comparator returns {mismatches, counts, orphans, headerOk}; summarize() renders lines and the ok flag"
requirements-completed: [DB-06]
duration: ~25min
completed: 2026-10-09
---

# Phase 87 Plan 14: Batch verify and replay tools Summary

**Shared pure four-table comparator plus a read-only verify CLI (exit 4 on mismatch) and a dry-run-default replay-to-sheet CLI that makes rollback lossless.**

## Accomplishments
- `lib/batch-compare.js`: per-field comparison (booleans normalised, blank equals NULL, dates date-only, timestamps by epoch ms, numbers by value, bin_id as text), per-table counts, orphan counts for either side, pinned header-row check. No I/O.
- `batches-verify.js`: one `begin transaction read only`, sequential constant-SQL reads, prints `<table> <id> <field>` lines and counts only. Exits 0 / 1 / 4. Postgres URL in argv and in-repo snapshot paths refused; DB from `BACKFILL_DATABASE_URL` only.
- `batches-replay-to-sheet.js`: `--since` required (ISO validated), dry run default, `--apply` sends `mirror_batch_state` (ordered by last_updated) then `mirror_batch_delete` for tombstones, bodies built only by `opsMirror.buildMirrorRequest('batch', ...)`, stops at first `{ok:false}` naming the batch id. Closes with the "run batches-verify" reminder.

## Task Commits
1. Task 1 (comparator + verify CLI, TDD): afe73198
2. Task 2 (replay CLI, TDD): 827947ab

## Verification
Run in the worktree: root `npm test` (163 suites, 2268 tests), `zoho-middleware` `npm test` (190 suites, 2991 tests), `npm run test:db` (30 suites, 318 tests), root and middleware `npm run lint` all pass. No tool was run against staging or production; all tests use fixtures and fake pools.

## Deviations from Plan
None. The plan's Task 1 test list was implemented as written, plus extra cases (timestamp epoch-ms, sheet-only row, Postgres-side orphans, refused sheet row).

## Notes
- The Q12 production-only 24 h drift timer is NOT in this plan; this plan supplies the comparator (`lib/batch-compare.js`) it needs. The 87-15 timer must also call `normalizeSheetTables` on the `export_batch_tabs` output.
- The worktree started on a stale base (d7735bb6) and was reset to the specified base 61aa86d9 as the startup check allows (clean tree, nothing lost).
- Root `npm run lint` only covers `js/`; the new middleware files are linted by `cd zoho-middleware && npm run lint` (passes).

## Known Stubs
None.

## Threat Flags
None. T-87-14-01..04 mitigations are implemented and tested (value-free output, dry-run default, read-only tx, URL refused in argv).

## Self-Check: PASSED

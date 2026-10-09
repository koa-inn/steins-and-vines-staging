---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 03
subsystem: database
tags: [postgres, apps-script, golden-fixtures, pure-rules, batches]
requires:
  - phase: 87-01
    provides: approved design (87-DESIGN.md)
provides:
  - Synthetic batch workbook (invented data) covering every response-shaping rule
  - golden.json holding the REAL adminApi.gs outputs over that workbook (64 entries)
  - lib/batch-rules.js pure rules reproducing every golden entry
affects: [87-06, 87-07, 87-08, 87-15]
tech-stack:
  added: []
  patterns: [golden capture from real Apps Script source via new Function harness, pure ES5 rules module]
key-files:
  created:
    - zoho-middleware/lib/batch-rules.js
    - zoho-middleware/__tests__/batch-rules.test.js
    - zoho-middleware/__tests__/fixtures/batches/synthetic-workbook.js
    - zoho-middleware/__tests__/fixtures/batches/golden.json
    - tests/frontend/adminapi-batch-golden.test.js
  modified: []
key-decisions:
  - "Builders take PG-shaped rows (DDL names, date as local-midnight Date or YYYY-MM-DD, numeric as string) and serialize internally"
  - "dedupDecision accepts either full Batches rows or pre-matched id strings"
  - "Reading timestamp is validated as a real calendar date (stricter than the script's shape-only regex), per the plan's behaviour spec"
requirements-completed: [DB-06]
duration: 40min
completed: 2026-10-09
---

# Phase 87 Plan 03: Batch golden fixtures and pure batch rules Summary

The Apps Script batch read behaviour is frozen into 64 golden entries, and `lib/batch-rules.js` reproduces every one from Postgres-shaped rows.

## Accomplishments

- Synthetic workbook with 13 batches (all five statuses, two pending, one with a vessel), 21 tasks (undated packaging on a ready and a not-ready batch, undated non-packaging, duplicate step number, completed transfer), 4 readings, 5 history rows (including a same-day pair), batches spread over 7 months, and an invoice+SKU pair for dedup. Emails use example.com only.
- Root test `tests/frontend/adminapi-batch-golden.test.js` runs the real `adminApi.gs` functions (getBatches, getBatchDetail, handleGetBatchPublic, getTasksCalendar, getTasksUpcoming, getBatchDashboardSummary, checkLocationConflict, batchDedupDecision) under a fixed clock (2026-10-11T19:30Z) and timezone (America/Vancouver, pinned via `process.env.TZ`, restored in afterAll). `UPDATE_BATCH_GOLDEN=1` rewrites golden.json; otherwise it fails on drift. `adminApi.gs` is untouched.
- `batch-rules.js`: serializers (NULL to '', booleans, numeric `bin_id`, `target_volume_l` back to `target_volume_L`, date and timestamp forms), list/detail/public/calendar/upcoming/dashboard builders, dedup decision with the exact duplicate_so_number text, DST-safe due-date math, status/vessel transition helpers, reading validators, manual-create fingerprint. 108 tests pass.

## Task Commits

1. Task 1 (synthetic workbook, golden capture): `68b47966`
2. Task 2 (batch-rules and tests): `d20716b9`

## Deviations from Plan

None to code scope. Interface choices worth knowing for 87-06 onward:

- `buildDashboardSummary(rows, {now, timezone})` takes `rows = {batches, tasks}`.
- `buildBatchDetail(batchId, batchRow, tasks, readings, history)` and `buildPublicView(batchId, token, batchRow, ...)` (extra export) take the batch row separately so a missing row yields the script's not-found object.
- Extra exports beyond the plan list: `ddlColumn`, `sanitizeInput` (re-export of recipe-rules), `findLocationConflict`, `vesselChangesForStatus`, `vesselChangesForLocation`, `statusAfterTransfer`, `validateReadingUpdate`, `taskCountsByBatch`, `buildPublicView`.
- Plan acceptance mentions `git diff --exit-code 8487c6e7 -- apps-script/adminApi.gs`; that commit is not in this worktree's history, so I confirmed instead that no `.gs` file changed in either commit.

## Issues / Notes for later plans

- node-pg returns `date` columns as local-midnight `Date`; `dateOnly` reads local getters. The PG read layer should either keep node-pg's default or select dates as text, but must not apply a UTC conversion.
- Child rows are re-sorted by id inside the builders, so SQL ordering does not affect output ties (task ids order equals sheet row order).
- Public view format check uses `SV-B-[0-9]{6,}` per 87-DESIGN (script used exactly 6 digits; identical for current ids).
- Sheet smell (not touched): the script's per-request `_sheetCache` is module global, which is why the harness loads a fresh script instance per call.

## Verification

- `npx jest tests/frontend/adminapi-batch-golden.test.js`: pass
- `cd zoho-middleware && npx jest __tests__/batch-rules.test.js`: 108 pass
- Full suites: root 162 suites / 2250 tests pass; middleware 184 suites / 2917 tests pass
- Lint: root and middleware 0 warnings
- `grep` for pg/axios/db requires in batch-rules.js: 0
- STATE.md and ROADMAP.md not modified (orchestrator-owned)

## Self-Check: PASSED

Files exist: batch-rules.js, batch-rules.test.js, synthetic-workbook.js, golden.json, adminapi-batch-golden.test.js. Commits 68b47966 and d20716b9 present.

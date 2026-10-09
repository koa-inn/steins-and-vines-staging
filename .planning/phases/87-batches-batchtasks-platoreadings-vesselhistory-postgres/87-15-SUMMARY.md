---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 15
subsystem: database
tags: [postgres, parity, drift-check, sentry, cutover-gate]
requires:
  - phase: 87-04
    provides: Apps Script export_batch_tabs
  - phase: 87-06
    provides: lib/batch-pg-read dashboard, list, upcoming and calendar reads
  - phase: 87-14
    provides: lib/batch-compare.js (normalizeSheetTables, compareBatchTables, summarize)
provides:
  - batches-parity CLI (pre-flip dashboard go/no-go, pre-cutover snapshot, post-flip proxy mode)
  - lib/batch-drift.js (runDriftCheck, registerDriftTimer) wired into server.js
affects: [87 window runbook, 87 rollback week]
tech-stack:
  added: []
  patterns: [dependency-injected CLI, never-throw timer job, value-free path and count output]
key-files:
  created:
    - zoho-middleware/scripts/backfill/batches-parity.js
    - zoho-middleware/__tests__/backfill/batches-parity.test.js
    - zoho-middleware/lib/batch-drift.js
    - zoho-middleware/__tests__/batch-drift.test.js
  modified:
    - zoho-middleware/server.js
key-decisions:
  - "Drift check uses the timer option (Q12 approved): 24 h setInterval, unref'd, registered only when sheetMirror.isMirrorEnabled() and BATCHES_STORE=postgres"
  - "Parity compares null and absent as different (a key on one side only is a difference); only access_token is ignored"
patterns-established:
  - "Parity snapshot is {taken_at, now, timezone, calls, reads}; post-flip mode replays snapshot.calls so the call list is never re-derived"
requirements-completed: [DB-06]
duration: ~35min
completed: 2026-10-09
---

# Phase 87 Plan 15: Parity gate and daily drift check Summary

**Pre-flip dashboard parity CLI (exit 4 on any path difference, snapshot saved outside the repo) plus a production-only 24 h Postgres-vs-sheet drift timer reporting to Sentry.**

## Accomplishments
- `batches-parity.js`: fetches get_batch_dashboard_summary, get_batches (all), get_tasks_upcoming (200) and get_tasks_calendar for the current and next month from Apps Script, and the same reads from Postgres in one read-only transaction with one injected `now` and timezone. `diffParity` returns `{action, path}` only (for example `get_batch_dashboard_summary data.readyToBottle[2].bottling_due`); never a value. Exit 0 / 1 / 4.
- Guards: `--snapshot-out` required and refused inside the repo (`assertSnapshotSafePath`); Postgres URL in argv refused; refuses to run within 15 minutes of local midnight in the timezone; session token only from `BATCH_PARITY_SESSION`.
- `--against-snapshot=<file> --via=proxy`: replays the snapshot's call list through the admin proxy and diffs against the saved Apps Script side.
- `batch-drift.js`: `runDriftCheck` posts `export_batch_tabs`, converts it to read-xlsx row shape, runs `normalizeSheetTables` and `compareBatchTables`, logs `[batches-drift] 0 mismatches` or table/id/field lines, and raises Sentry `batches drift detected` (tags `component:batches-drift`, extra `mismatchCount`, `tables`, `headerOk`). Any Apps Script or Postgres error reports `batches drift check failed` and resolves; nothing throws.
- `server.js`: one added line after the ops-mirror sweep, `require('./lib/batch-drift').registerDriftTimer()`. No-op off production or with BATCHES_STORE not postgres.

## Task Commits
1. Task 1 (batches-parity, TDD): fa63e955
2. Task 2 (batch-drift + server.js, TDD): 8ea04c12

## Verification
Root `npm test` (163 suites, 2268 tests), root lint, `zoho-middleware` `npm test` (192 suites, 3018 tests), middleware lint, `npm run test:db` (32 suites, 353 tests) all pass. Nothing was run against staging or production; all tests use fixtures, mocks and fake pools.

## Deviations from Plan

**1. [Rule 1 - Plan/code mismatch] export_batch_tabs is a POST, not a GET**
- The plan's interface block says GET; in `apps-script/adminApi.gs` the action sits in doPost's server_token chain (it is not in doGet). The drift check POSTs `{action, server_token}` (same as batches-replay-to-sheet).

**2. [Rule 1 - Plan/code mismatch] post-flip proxy is /api/admin/proxy, not /api/batch/admin-proxy**
- `/api/batch/admin-proxy` does not allow `get_tasks_calendar`; `/api/admin/proxy` allows all four reads and accepts the `x-session-token` header. `--via=proxy` therefore targets `<BATCH_PARITY_BASE_URL>/api/admin/proxy`.

**3. Calendar and upcoming reads take no injectable "now"**
- `getTasksUpcoming(client, limit)` and `getTasksCalendar(client, start, end)` do not accept `now`; only the dashboard does. The calendar month range is derived from the injected now in the timezone. Apps Script itself always uses its own clock, hence the midnight guard.

## Notes for the window
- Apps Script caches `get_batch_dashboard_summary` and `get_tasks_upcoming` for 300 s (`_cachedGet`). If the cache was not flushed after the last write, the sheet side can be up to 5 minutes stale and report a false difference; freeze writes and let the cache expire (or flush) before running.
- Drift check: JSON turns real date cells into ISO-with-Z strings, so a date-typed column held as a true Date cell (rather than text) could produce a false `start_date` or `due_date` mismatch on the first production run. Watch the first run's log lines before trusting it.
- Drift timeout/timezone: `BATCHES_TIMEZONE` env optional, default America/Vancouver.

## Known Stubs
None.

## Threat Flags
None. T-87-15-01..04 mitigations implemented and tested (repo-path refusal, value-free output, never-throw unref'd production-only timer, session via env only).

## Self-Check: PASSED

---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 20
subsystem: ops
tags: [production, rollback-week, drift, retirement]
requires: [87-19]
provides: [rollback-week record, retirement decision, drift-check bug finding]
affects: [88]
key-files:
  created: []
  modified:
    - docs/RUNBOOK.md
    - .planning/phases/87-batches-batchtasks-platoreadings-vesselhistory-postgres/87-CUTOVER-LOG.md
duration: rollback week 2026-10-28 → 2026-11-03
completed: 2026-11-03
---

# Phase 87 Plan 20: Rollback Week and Retirement Summary

Rollback to the sheet was **retired on 2026-11-03**. Postgres is now the only batch record, and the sheet
stays as a production mirror with notices.

The evidence for retiring is a manual `batches-verify` against a fresh owner snapshot on day 7. It
showed headers matching, counts 218 / 1125 / 72 / 446 equal, 0 orphans and **0 mismatches**. The daily
drift check did not provide the week's evidence.

## Tasks

| Task | Result |
|------|--------|
| 1. Days 1–7 drift record | Recorded on 11-03 from Railway logs and deployment history. Days 1–3 had no run, because each deploy restarts the 24 h timer. Days 4–6 were false positives from a drift-check bug. Day 7 was a manual verify with 0 mismatches. |
| 2. Day-7 retirement | Owner chose "verify now, then retire". RUNBOOK §12–§13 are marked retired and §14 carries a bug warning. §16 (SQL fixes) is unchanged. |

## Deviations

- **The drift check never really verified anything.** `export_batch_tabs` sends true date cells as ISO
  timestamps, and `normalizeDateOnly` rejects them. As a result, 216 of 218 batches and every child row
  were dropped, then reported as `missing_in_sheet`, and Sentry raised `batches drift detected` daily.
  The check discards `rejects`, so the cause was invisible. A read-only export pull on 11-03 confirmed the
  sheet holds every row. RUNBOOK §14 had predicted false date mismatches, but they appeared as missing
  rows rather than field differences.
- **The timer only ran once production stayed up for 24 hours**, from 10-30 onwards. The setInterval
  restarts on every deploy.

## Follow-ups

1. Done 2026-11-03 (`prod-20261103-1`): drift check parses ISO timestamps to an America/Vancouver
   date, logs reject counts by reason, and also runs 10 min after each boot. First prod run 21:07Z:
   0 mismatches.
2. Done 2026-11-03 (owner OK): every `~/sv-backfill/` workbook snapshot, the staging parity snapshot and
   the `out-*` folders were deleted. The small dry-run and reject logs are kept as an audit trail.
3. Still open from 87-19: Task 3 (first real sale creates its batch; record the `create_batch` median)
   and AS1 `setupBatchMirrorNotices()` confirmation.

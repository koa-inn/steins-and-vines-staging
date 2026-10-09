---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 16
subsystem: docs
tags: [runbook, cutover, rollback, data-model]
requires: [87-05, 87-12, 87-13, 87-14, 87-15]
provides: [batches cutover runbook, SQL hand-fix recipe, cutover log skeleton]
affects: [87-17, 87-18, 87-19, 87-20]
key-files:
  created:
    - .planning/phases/87-batches-batchtasks-platoreadings-vesselhistory-postgres/87-CUTOVER-LOG.md
  modified:
    - docs/RUNBOOK.md
    - docs/DATA-MODEL.md
    - .planning/ROADMAP.md
requirements-completed: [DB-06]
duration: 25min
completed: 2026-10-09
---

# Phase 87 Plan 16: Cutover Runbook and Docs Summary

RUNBOOK section "Batches -> Postgres (Phase 87)" with window, no-go list, replay-first rollback, drift check and D-11 SQL-fix recipe, plus corrected 33/14/9/8 batch data model, a cutover log skeleton and the Phase 88 Waitlist scope note.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 RUNBOOK section, v62 deploy row | e42c99be | sections 0-16, env var table |
| 2 DATA-MODEL, CUTOVER-LOG, ROADMAP | 5db32fe6 | |

## Documented against the real code (not the plan's predictions)

- Flags are equals-form; DB URL only via `BACKFILL_DATABASE_URL`; exit codes backfill 0/1/2/3, verify and parity 0/1/4, replay 0/1.
- Parity: 300 s Apps Script cache wait, 15-minute midnight refusal, `--snapshot-out`, post-flip `--against-snapshot --via=proxy` against `/api/admin/proxy` with `BATCH_PARITY_SESSION` and `BATCH_PARITY_BASE_URL`.
- Backfill skips blank-primary-key rows silently, so the runbook tells the operator to eyeball sheet tails first.
- Drift timer: production only, 24 h, `[batches-drift] 0 mismatches`, Sentry `batches drift detected`; first run may show false date mismatches.
- Owner to-dos Q1 (delete BT-000567..570) and Q3 (Apps Script timezone) and the Phase 86 prod flip gate (Q14/D-13) are in section 0.

## Deviations from Plan

- **[Rule 1 - Plan/code mismatch]** The plan's step order put the post-flip proxy parity after smoke writes; the runbook notes smoke writes change the numbers, so it runs before write smoke.
- DATA-MODEL.md is CRLF; the edit preserves CRLF.
- Section 13 step 6 (sequence re-seed) uses `setval` through the section 16 tunnel recipe; no script exists for it.

## Verification

- All RUNBOOK greps pass; `rollback v61` present; 0 `postgres://` strings (unchanged); `transfer_date` count 0 in DATA-MODEL.
- `npm test` 163 suites / 2268 tests and `cd zoho-middleware && npm test` 197 suites / 3101 tests pass. No code changed; nothing run against staging or production.

## Known Stubs

None. Measured-timing columns and the cutover log are intentionally blank until 87-18.

## Self-Check: PASSED

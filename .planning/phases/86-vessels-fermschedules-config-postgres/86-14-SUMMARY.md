---
phase: 86-vessels-fermschedules-config-postgres
plan: 14
subsystem: database
tags: [postgres, backfill, verify, replay, runbook, apps-script]
requires:
  - phase: 86-08
  - phase: 86-09
  - phase: 86-11
provides:
  - ops-verify read-only comparator CLI
  - ops-replay-to-sheet rollback/repair CLI
  - RUNBOOK section "Ops data → Postgres (Phase 86)"
  - 86-DUAL-LOG.md evidence log
affects: [86-18, 86-20]
tech-stack:
  added: []
  patterns: [pure exported comparator + CLI behind require.main, read-only transaction, masked output]
key-files:
  created:
    - zoho-middleware/scripts/backfill/ops-verify.js
    - zoho-middleware/scripts/backfill/ops-replay-to-sheet.js
    - zoho-middleware/__tests__/backfill/ops-verify.test.js
    - zoho-middleware/__tests__/backfill/ops-replay-to-sheet.test.js
    - .planning/phases/86-vessels-fermschedules-config-postgres/86-DUAL-LOG.md
  modified:
    - zoho-middleware/scripts/backfill/README.md
    - docs/RUNBOOK.md
    - docs/APPS_SCRIPT.md
key-decisions:
  - "ops-verify exit code 4 for mismatches (per plan), 1 for errors"
  - "ops-replay-to-sheet --only=schedules --id=X for a schedule gone from Postgres sends mirror_ferm_schedule_delete (uses buildMirrorRequest third id argument)"
requirements-completed: [DB-05]
duration: 25min
completed: 2026-10-07
---

# Phase 86 Plan 14: Ops verify, replay and runbook Summary

Read-only `ops-verify` (Postgres vs fresh workbook snapshot, including the `label` header gate, Config secret-row check and staff leg) and `ops-replay-to-sheet` (dry-run default, payloads from `ops-mirror.buildMirrorRequest`, no staff path), plus the Phase 86 RUNBOOK section, corrected `server_token` docs and the dual-window log.

## Tasks

1. **Task 1: CLIs and tests** - `6c69beb2`. 23 unit tests across both suites; full middleware suite (174 suites, 2698 tests) and lint pass.
2. **Task 2: Docs and dual log** - `103ce539`. RUNBOOK section (12 subsections, deploy-table placeholder for v61 / rollback 60), APPS_SCRIPT.md corrected, 86-DUAL-LOG.md with 12 op-coverage rows.

## Deviations from Plan

- The CLIs were written before their tests rather than tests-first; the tests were then run against them and all pass. No separate RED commit exists.
- The Config tab secret-row mismatch uses id `(redacted)` so the key text is never printed.
- Replay failure exits 1 (EXIT.ERROR) as the plan states; `--only` / `--id` flags were added for targeted repair.

## Known Stubs

None. The RUNBOOK release-checklist SHAs and DUAL-LOG tables are intentional placeholders filled by later plans (86-18, 86-20).

## Self-Check: PASSED

All created files exist; commits `6c69beb2` and `103ce539` exist. Worktree `node_modules` symlinks left untracked.

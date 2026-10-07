---
phase: 86-vessels-fermschedules-config-postgres
plan: 01
subsystem: database
tags: [postgres, migration, store-flag, ferm-schedules, vessels]
requires: []
provides:
  - "migration 0004_ops_data.sql (vessels, ferm_schedules, config, staff_access, staff_access_audit)"
  - "OPS_DATA_STORE and STAFF_ACCESS_STORE store flags"
  - "lib/stale-token.js isStale"
  - "lib/ferm-schedule-rules.js parseSteps/validateSteps/sanitizeScheduleText"
affects: [86-05, 86-06, 86-09]
key-files:
  created:
    - zoho-middleware/migrations/0004_ops_data.sql
    - zoho-middleware/__tests__/db/ops-migration.test.js
    - zoho-middleware/lib/stale-token.js
    - zoho-middleware/lib/ferm-schedule-rules.js
    - zoho-middleware/__tests__/ops-store-flag.test.js
    - zoho-middleware/__tests__/stale-token.test.js
    - zoho-middleware/__tests__/ferm-schedule-rules-parity.test.js
  modified:
    - zoho-middleware/lib/store-flag.js
    - zoho-middleware/__tests__/store-flag.test.js
key-decisions:
  - "The migrate:guard parser accepted the !~ operator in the config CHECK, so no fallback was needed; the secret-key guard lives in the DB."
  - "Port of validateSteps follows the .gs code (some packaging step), not its 'Exactly one' message."
duration: ~25min
completed: 2026-10-07
---

# Phase 86 Plan 01: Ops data foundations Summary

Additive migration 0004 (five tables, FS- id sequence, jsonb steps array check, secret-key-rejecting config CHECK), two new store flags, a shared stale-token helper, and a steps validator parity-tested against the real createFermSchedule.

## Tasks

| Task | Commit |
|------|--------|
| 1 Migration 0004 + real-PG test | 4772150d |
| 2 Store flags + stale-token | 1277b348 |
| 3 ferm-schedule-rules + parity | dc8d73f0 |

## Verification
- migrate:guard OK (4 files); test:db ops-migration + migrations: 13 passed on real Postgres (Docker ran, not skipped).
- Middleware suite 2533 passed; root suite 2152 passed; middleware lint clean.

## Deviations from Plan

**1. [Rule 3 - Blocking] Updated existing store-flag.test.js**
- Two assertions hardcoded the old two-flag list (STORE_ENV_NAMES equality and the validateStoreFlags all-unset result). The mandated STORE_ENV_NAMES change necessarily breaks them, which conflicts with the plan's acceptance line that store-flag.test.js stays unchanged. Minimal edit: added the two new names to those expected values. Commit 1277b348.

**2. [Process] Worktree base reset**
- Worktree started at a509e397; reset to d2c66be9 as the worktree check instructs. Worktree lacked node_modules; symlinked both from the main checkout (untracked, not committed).

**3. [Process] TDD ordering**
- Task 1 test and migration were committed together (test written first, but one commit); RED was not committed separately.

## Known Stubs
None.

## Self-Check: PASSED
All created files exist; commits 4772150d, 1277b348, dc8d73f0 present.

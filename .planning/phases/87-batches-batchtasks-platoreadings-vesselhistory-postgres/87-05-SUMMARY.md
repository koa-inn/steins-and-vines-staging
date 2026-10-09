---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 05
subsystem: database
tags: [postgres, backfill, batches, xlsx, migration]
requires:
  - phase: 87-02
    provides: migration 0005_batches.sql (tables, sequences, FKs)
provides:
  - Four final backfill specs pinned to the real 33/14/9/8 sheet headers
  - batches-backfill.js CLI with pure plan builder and one-transaction promote
affects: [87-verify, 87-cutover window]
tech-stack:
  added: []
  patterns: [dedicated multi-table backfill CLI copied from ops-backfill.js, reject-never-coerce with value-free reject records]
key-files:
  created:
    - zoho-middleware/scripts/backfill/batches-backfill.js
    - zoho-middleware/scripts/backfill/specs/batches.js
    - zoho-middleware/scripts/backfill/specs/batch-tasks.js
    - zoho-middleware/scripts/backfill/specs/plato-readings-final.js
    - zoho-middleware/scripts/backfill/specs/vessel-history-final.js
    - zoho-middleware/__tests__/backfill/batches-spec-headers.test.js
    - zoho-middleware/__tests__/backfill/batches-backfill-plan.test.js
    - zoho-middleware/__tests__/db/batches-backfill.test.js
  modified: []
key-decisions:
  - "Status is matched exactly against the five DDL values (no case folding); anything else is invalid_status"
  - "Promote adds a schedule_reference precondition (batches.schedule_id must exist in ferm_schedules) so a missing schedule exits 3 before any write instead of a mid-transaction FK error"
  - "Dedicated spec column types (nullable_text, date, integer, number, boolean) handled in the CLI; normalize.js untouched because its numeric type forces a scale and has no date type"
requirements-completed: [DB-06]
duration: 45min
completed: 2026-10-09
---

# Phase 87 Plan 05: Batches backfill Summary

A snapshot workbook becomes batches, batch_tasks, plato_readings and vessel_history in one checked transaction, with existing ids kept and all four sequences seeded; any dirty row produces a value-free reject and blocks promote.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Specs, header pin, pure plan builder | 10a66bde | 26 unit tests; promote/CLI code landed in the same module file |
| 2 Promote, seeding, invariants, CLI tests | 4bc52673 | 9 real-PG tests against Docker Postgres |

## Behaviour delivered

- Plan builder: parents first, orphan children rejected (`orphan_parent`), duplicate ids/tokens rejected (later occurrence), status allow-list, token `^[0-9a-f]{32}$`, integer/number/date/timestamp validation, blank-primary-key rows skipped, duplicate `(batch_id, step_number)` pairs kept, `unit_seq` per (invoice, sku) by created_at then batch_id.
- Header checks: missing and unexpected headers rejected; header text is echoed only when identifier-like and row 1 is not data, otherwise `<redacted header>`.
- Promote: DB-name prompt (injectable), existence and emptiness checks on all six tables outside the transaction, schedule-reference check, BEGIN, 500-row parameterised inserts, four literal `setval` calls, ten in-transaction invariants (counts, sequences, orphans, unit_seq), COMMIT or ROLLBACK, client released exactly once.
- CLI: equals-form flags, Postgres URL in argv refused, DB URL only from `BACKFILL_DATABASE_URL`, in-repo snapshot refused, rejects file per sheet plus a counts/seeds summary file (mode 0600, outside the repo). Exit 0/1/2/3.

## Verification

- `npx jest __tests__/backfill/batches-*`: 26 pass. `npx jest --config jest.db.config.js __tests__/db/batches-backfill.test.js`: 9 pass.
- Full middleware suite 187 suites / 2958 tests; root suite 163 suites / 2268 tests; both lints clean.
- Acceptance greps: 4 literal `setval('...')` calls, 0 `require('pg')`, `REDACTED_HEADER` present.
- No backfill was run against staging, production or any sheet; only Docker Postgres and synthetic fixtures.

## Deviations from Plan

- **[Rule 3 - Blocking]** Worktree base differed from the target commit; reset to f953f708 per the startup check. `npm ci` run in root and `zoho-middleware` because node_modules was absent.
- The acceptance check `git diff --exit-code 8487c6e7 -- ...spec-headers.test.js specs/index.js` references a commit not in this history; instead confirmed neither file appears in `git diff f953f708..HEAD`.
- Task 1 and Task 2 code were written together (promote and CLI live in the same module), so the first commit contains the whole module and the second adds the real-PG tests. Tests were not strictly written before implementation.
- Added the `schedule_reference` precondition (see key-decisions); not in the plan but prevents a mid-transaction FK failure at the window.

## Notes for later plans

- A blank-primary-key row is skipped even if other cells hold data (follows 87-DESIGN literally). If the real tail rows turn out to carry data, the dry-run will not flag them.
- The promote's concurrent `Promise.all` queries on one client emit a pg deprecation warning (same as ops-backfill.js); harmless today, would need serialising before pg 9.
- node-pg returns `date` columns as local-midnight Dates; the DB test reads local getters.

## Known Stubs

None.

## Self-Check: PASSED

All eight created files exist; commit 10a66bde present; the real-PG test file is committed in the follow-up commit.

---
phase: 86-vessels-fermschedules-config-postgres
plan: 09
subsystem: database
tags: [postgres, backfill, vessels, ferm-schedules, config, staff-access]
requires: ["86-01"]
provides:
  - "zoho-middleware/scripts/backfill/ops-backfill.js (buildOpsBackfillPlan, runOpsBackfill)"
  - "specs/vessels.js, specs/config.js, specs/ops-ferm-schedules.js"
affects: [86-14]
key-files:
  created:
    - zoho-middleware/scripts/backfill/ops-backfill.js
    - zoho-middleware/scripts/backfill/specs/vessels.js
    - zoho-middleware/scripts/backfill/specs/config.js
    - zoho-middleware/scripts/backfill/specs/ops-ferm-schedules.js
    - zoho-middleware/__tests__/backfill/ops-backfill-plan.test.js
    - zoho-middleware/__tests__/backfill/ops-spec-headers.test.js
    - zoho-middleware/__tests__/db/ops-backfill.test.js
key-decisions:
  - "Staff seeded from BACKFILL_STAFF_EMAILS (Railway list) plus required --owners; Config staff_emails extras are counted and skipped (recorded in file header as a deviation from 86-RESEARCH Pattern 8)."
  - "Non-empty target exits 3 (CHECKS_FAILED) before BEGIN, per the plan behavior; a missing table exits 1."
  - "Secret-looking Config keys are rejected with id null so even the key text is not echoed."
  - "vessels.updated_at (NOT NULL, no default) is stamped with the promote-time timestamp since the sheet has no such column."
duration: ~30min
completed: 2026-10-07
---

# Phase 86 Plan 09: Ops backfill Summary

Dedicated four-table CLI that turns a workbook snapshot into vessels, ferm_schedules, config and staff_access in one transaction, rejecting instead of coercing, validating every steps blob with ferm-schedule-rules, and seeding ferm_schedule_id_seq (max FS suffix) and vessel_position_seq (vessel count).

## Tasks

| Task | Commit |
|------|--------|
| 1 Specs + pure planner + pinned headers | dd4d3d3a |
| 2 CLI promote, sequence seeding, invariants (real PG) | 1f640f70 |

## Verification
- `jest ops-backfill-plan ops-spec-headers spec-headers`: 40 passed (existing spec-headers unmodified).
- `npm run test:db -- ops-backfill` on real Postgres (Docker ran): 9 passed. Covers promote, FS-0012 next id, vessel position 6, non-empty refusal, rollback on owner-count and count-mismatch, env/flag guards.
- Middleware `npm test`: 167 suites / 2598 tests passed; `npm run lint` clean.
- Acceptance greps: one setval for each sequence, zero `process.env.DATABASE_URL`, validateSteps present.

## Deviations from Plan

**1. [Process] Worktree base reset**
- Worktree started at a509e397; reset to ae737513 per the worktree check. node_modules symlinked from the main checkout (untracked, not committed).

**2. [Rule 2 - Missing] vessels.updated_at at promote**
- The migration makes vessels.updated_at NOT NULL with no default and the sheet has none, so promote stamps it with the run timestamp. Not in the plan's row shape.

**3. [Process] TDD ordering**
- Task 1 tests and implementation were committed together (tests written first, RED not committed separately).

No existing tests were modified.

## Notes
- The DB test shows a pg deprecation warning from parallel queries on one client in the precondition checks (same pattern as recipes-backfill.js); harmless today.
- Never run against staging/production from this plan; only a local Testcontainers DB was used.

## Known Stubs
None.

## Self-Check: PASSED

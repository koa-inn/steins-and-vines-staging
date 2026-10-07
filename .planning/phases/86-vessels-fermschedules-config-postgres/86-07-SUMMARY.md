---
phase: 86-vessels-fermschedules-config-postgres
plan: 07
subsystem: auth
tags: [postgres, staff-access, break-glass, audit]
requires:
  - phase: 86-01
    provides: staff_access and staff_access_audit tables (migration 0004)
provides:
  - lib/staff-access.js resolve/breakGlassEmails/clearCache/hashEmail/getMode
  - lib/staff-access-pg.js audited owner-safe mutations
affects: [86-12]
tech-stack:
  patterns: [lazy requires, for-update owner-set lock, fail-closed PG leg]
key-files:
  created:
    - zoho-middleware/lib/staff-access.js
    - zoho-middleware/lib/staff-access-pg.js
    - zoho-middleware/__tests__/staff-access.test.js
    - zoho-middleware/__tests__/db/staff-access-pg.test.js
key-decisions:
  - "Effective owners = PG owner rows plus rowless break-glass emails, locked with one ordered select for update"
  - "Degraded results (env member while PG down) are never cached; only allowed, non-degraded decisions are"
requirements-completed: [DB-05]
duration: 25min
completed: 2026-10-07
---

# Phase 86 Plan 07: Staff allowlist core Summary

Per-request staff authorisation (env break-glass, fail-closed Postgres leg, 5 s positive cache, dual shadow report) plus audited, owner-safe staff mutations in one transaction. Nothing is wired to live traffic (86-12).

## Tasks
1. staff-access-pg.js plus real-Postgres tests (14 pass, incl. concurrent mutual removal and audit atomicity): c5e7a8bf
2. staff-access.js plus unit tests (20 pass); full middleware suite (166 suites, 2588 tests) and lint pass: 578a431d

## Deviations from Plan
- Worktree HEAD started at a509e397; reset to expected base ae737513 per the branch check.
- TDD RED commits were not made separately; tests and implementation were committed together per task. Tests were written first but not committed failing.
- compareAndReport was not used (plan said only if the signature fits without emails); the shadow report is a hashed log.warn, rate-limited to once per hour per email.
- Added a hashed `resolve error` warn in the outer catch (needed to satisfy the no-unused-vars lint rule).

## Known Stubs
None.

## Threat Flags
None.

## Self-Check: PASSED

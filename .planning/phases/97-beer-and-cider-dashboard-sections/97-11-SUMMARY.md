---
phase: 97-beer-and-cider-dashboard-sections
plan: 11
subsystem: release
tags: [staging, migration, rollout, leak-check]
requires:
  - phase: 97-01
    provides: migration 0009_recipes_target_gravity
  - phase: 97-10
    provides: last code plan merged
provides:
  - "Phase 97 code live on staging (origin main c0fef5ee); production untouched"
  - "97-ROLLOUT-LOG.md: code gate, pre-existing test edits, staging push decision, staging deploy, leak check"
affects: [97-12]
key-files:
  created:
    - .planning/phases/97-beer-and-cider-dashboard-sections/97-ROLLOUT-LOG.md
  modified:
    - zoho-middleware/__tests__/db/batches-type-migration.test.js
    - zoho-middleware/__tests__/db/batches-staff-migration.test.js
    - tests/frontend/brewpad-dashboard-v2-packcal.test.js
    - .planning/todos/done/brewpad-dashboard-v2-restore-tasks-and-ready-to-bottle.md
    - .planning/todos/done/brewpad-ready-to-bottle-filter.md
key-decisions:
  - "Owner approved shifting the two DB migration tests' rollback counts by one for 0009 (commit ad2dd531)"
  - "Owner approved the staging push 2026-11-04"
  - "CI npm audit failure (minimatch/glob) is pre-existing and tracked separately, not fixed here"
requirements-completed: [D-01, D-02, D-06, TODO-restore-tasks-rtb, TODO-rtb-filter]
metrics:
  tasks: 3
  completed: 2026-11-04
---

# Phase 97 Plan 11: Code gate and staging deploy Summary

Phase 97 is on staging and production is unchanged.

## Gate
- Frontend: 248 suites, 3391 tests. Middleware (Node 24): 298 suites, 4048 tests. DB: 55 suites, 455 tests. Lint and migrate:guard clean. No CSP change (HTML diffs are cache-bust stamps only).

## Staging
- origin main 8a2184d6 -> c0fef5ee. Pages run 41901696887 success; Railway deployment f5204c4e SUCCESS.
- Migration 0009 applied in preDeploy; target_og / target_fg present as nullable numeric.
- /health ok, authenticated, database true.
- Leak check PASS: dashboard-cards (39 cards) and packaging-bookings (ok, 0 bookings) contain no at-sign, no customer_ key, no recipe_snapshot.

## Deviations
- DB migration tests counted rollbacks from the latest migration; 0009 broke them. Fixed with owner approval.
- Packaging-calendar test made timezone-independent (July instants).
- Tests workflow fails on a pre-existing middleware npm audit advisory.

## Todos
- Closed: restore-tasks-and-ready-to-bottle (97-07), ready-to-bottle-filter (97-10).
- Still pending: calcom-beer-packaging-appointment (closes in 97-12).

---
phase: 86-vessels-fermschedules-config-postgres
plan: 15
subsystem: middleware-api
tags: [vessels, express, postgres, ops-mirror]
requires: [86-12, 86-13]
provides:
  - Vessels editor API (GET/POST/PUT, next-id, archive/unarchive; no DELETE)
  - 5-minute ops mirror sweep registered in server.js
affects: [86-10 admin Vessels tab]
key-files:
  created:
    - zoho-middleware/routes/vessels.js
    - zoho-middleware/__tests__/vessels-routes.test.js
    - zoho-middleware/__tests__/ops-mirror-sweep-registration.test.js
  modified:
    - zoho-middleware/server.js
decisions:
  - "Business error codes from vessel-pg other than stale/exists/in_use/not_found/immutable map to 422 invalid_vessel"
  - "Status override values Empty/In-Use pass straight through; vessel-pg ALLOWED_STATUSES already matches adminApi.gs setVesselStatus, so no reconciliation was needed"
metrics:
  tasks: 2
  completed: 2026-10-07
requirements: [DB-05]
---

# Phase 86 Plan 15: Vessels API and ops mirror sweep Summary

Staff-only Vessels editor API (legacy + session tiers, inline requireTiers on every route including GET, no DELETE route) with sheets-mode 503, stale/in-use/exists 409, immutable/invalid 422, generic 502, and real staff attribution; server.js mounts it and sweeps the ops mirror every 5 minutes.

## Commits
- d36593ef: routes/vessels.js and tests (25 tests)
- 060d5c76: server.js mount, opsMirror.sweep timer, source-level registration test

## Verification
- Middleware: 178 suites / 2756 tests pass, lint clean. Root: 161 suites / 2248 tests pass.

## Deviations from Plan
None in behavior. Worktree base was a509e397, not the expected base, so it was reset to 314f0d17 per the startup check. node_modules were symlinked and left untracked.

## Notes
- The store already lowercases nothing and validates statuses Empty/In-Use, matching 86-10's override values.
- PUT strips expected_updated_at from the payload before calling the store.
- No existing tests were modified.

## Known Stubs
None.

## Self-Check: PASSED

---
phase: 86-vessels-fermschedules-config-postgres
plan: 03
subsystem: apps-script
tags: [apps-script, adminApi, attribution, vessels, ferm-schedules]
requires: []
provides:
  - "_actingUser attribution on the server_token path"
  - "vessel_status_changes response seam (collect_vessel_status / vessel_sheet_write)"
  - "createBatch trusted schedule_steps_json"
affects: [86-16, 86-18]
tech-stack:
  added: []
  patterns: ["request-scoped module var reset at top of doPost"]
key-files:
  created:
    - tests/frontend/adminapi-acting-user.test.js
    - tests/frontend/adminapi-vessel-status-log.test.js
    - tests/frontend/adminapi-create-batch-trusted-steps.test.js
  modified:
    - apps-script/adminApi.gs
key-decisions:
  - "invalid schedule_steps_json is only enforced for non-pending batches (pending batches carry no schedule)"
requirements-completed: [DB-05]
duration: 25min
completed: 2026-10-07
---

# Phase 86 Plan 03: Apps Script v61 part A Summary

Additive adminApi.gs changes: validated `acting_user` attribution, a request-scoped vessel status delta log with a `vessel_sheet_write` gate, and trusted `schedule_steps_json` for createBatch. Nothing deployed.

## Commits
- abcec56e: acting_user attribution (16 `actor || 'middleware'` sites plus create_batch `kiosk-middleware`)
- a0af518a: `_vesselStatusLog` / `_vesselStatusOptions`, setVesselStatus logging and write gate, `_jsonResponse` attaches `vessel_status_changes`
- 3ef39190: createBatch trusted steps; staff-OAuth dispatch deletes the field

## Verification
Root `npm test` (2190 pass), `npm run lint`, `zoho-middleware npm test` (2518 pass). Existing adminapi suites unmodified and green.

## Deviations from Plan
- Task 3 implementation was written before its test (the test was added immediately after and passes); RED was not separately observed for Task 3. Tasks 1 and 2 had observed RED.
- Pending batches ignore `schedule_steps_json` (validation only when a schedule is used).

## Notes
- Tests model Apps Script with a fake runtime; staging rehearsal 86-18 is the real gate.
- Worktree `node_modules` symlinks are untracked and not committed.

## Self-Check: PASSED

---
phase: 86-vessels-fermschedules-config-postgres
plan: 16
subsystem: middleware
tags: [postgres, proxy, vessels, ferm-schedules, recipes]
requires: ["86-02", "86-13"]
provides:
  - lib/ops-proxy overlay (intercept, decorateForward, afterUpstream, mapSheetsAction)
  - archive_ferm_schedule action on both proxy allowlists
affects: [zoho-middleware/routes/pos.js, zoho-middleware/routes/recipes.js]
key-files:
  created:
    - zoho-middleware/lib/ops-proxy.js
    - zoho-middleware/__tests__/ops-proxy.test.js
    - zoho-middleware/__tests__/ops-proxy-routes.test.js
    - zoho-middleware/__tests__/recipes-ferm-schedules-store.test.js
  modified:
    - zoho-middleware/routes/pos.js
    - zoho-middleware/routes/recipes.js
decisions:
  - "Overlay is a strict no-op in sheets mode; stores required lazily"
  - "Vessel-status apply failures log vessel ids and never fail the client response"
metrics:
  tasks: 3
  completed: 2026-10-07
---

# Phase 86 Plan 16: Proxy overlay for vessels and ferm schedules Summary

In dual/postgres, both admin proxies, the public batch routes and the recipes schedule lookup now read and write vessels and fermentation schedules through the Postgres stores. Sheets mode behaves as before.

## What was built

- `lib/ops-proxy.js`
  - `intercept` answers `get_vessels` and `get_ferm_schedules` from the stores.
  - It routes the create, update, delete, archive and propagate schedule actions to the ferm-schedule store.
  - Stale schedule and in-use schedule results return 409. A store failure returns 502 `server_error`.
  - For `create_batch` with a `schedule_id`, it injects `schedule_steps_json` from Postgres. An unknown schedule returns `not_found` without calling Apps Script.
  - `decorateForward` sets `collect_vessel_status` on forwarded writes. It sets `vessel_sheet_write` only when the payload carries `server_token`.
  - `afterUpstream` applies `vessel_status_changes` to Postgres and strips the key from the response. For `get_batch_init` it replaces the schedules with the Postgres list.
  - `mapSheetsAction` turns `archive_ferm_schedule` into `delete_ferm_schedule` in sheets mode.
- `routes/pos.js`: `archive_ferm_schedule` is on both allowlists, the overlay hook runs in both proxies after `hardenProxyPayload`, and `forwardToAppsScript` calls `decorateForward` and `afterUpstream`.
- `routes/recipes.js`: `fetchFermSchedules` reads the store with `includeArchived: true` in dual/postgres. It does not touch the Redis cache there, and a store error returns `[]` with a warning.

## Verification

The full middleware suite passes (179 suites, 2755 tests) and lint is clean. No existing tests were modified. The root frontend `npm test` was not run, since no frontend files changed.

## Deviations from Plan

- The worktree HEAD started at a509e397, not the expected base. I reset it to 314f0d17 as the base check requires.
- I left the cosmetic comment placement noted in 86-02 untouched. It was optional.

## Known Stubs

None.

## Self-Check: PASSED

Commits 1f3ae6f2, 4a6704d0 and 1b6e7883 exist, and the created files are present.

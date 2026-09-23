---
phase: 82-store-agnostic-prerequisites
plan: 04
subsystem: api
tags: [express, axios, session-auth, proxy, allowlist]

# Dependency graph
requires:
  - phase: 76-brewpad-store-agnostic
    provides: authTiers.requireTiers(['legacy','session']) session-tier gate; the /api/batch/admin-proxy reference implementation this plan clones
provides:
  - "POST /api/admin/proxy — session-gated, 39-action allowlisted Apps-Script proxy for js/admin.js"
  - "forwardToAppsScript(action, payload, isRead, logTag, res) — shared GET/POST-vs-axios + 502-collapse helper used by both admin proxies"
affects: [82-05, 82-06, 82-07, 82-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared forwarding helper extracted from a hardcoded-allowlist proxy route, reused by a sibling route with its own independent allowlist"

key-files:
  created:
    - zoho-middleware/__tests__/admin-proxy.test.js
  modified:
    - zoho-middleware/routes/pos.js

key-decisions:
  - "forwardToAppsScript takes (action, payload, isRead, logTag, res) and returns the upstream promise — both proxy routes call it identically after their own independent 400 invalid_action gate; the helper makes no allowlist decision itself"
  - "ADMIN_PANEL_PROXY_READS/_ACTIONS named distinctly from BrewPad's ADMIN_PROXY_READS/_ACTIONS to avoid collision in the same file (D-05)"

patterns-established:
  - "Two sibling Apps-Script proxies, one shared forwarding helper, independent hardcoded allowlists — the pattern later admin-panel-facing proxies (82-06/82-07) should call rather than duplicate"

requirements-completed: [DB-01]

# Metrics
duration: 15min
completed: 2026-09-23
---

# Phase 82 Plan 04: Admin-Panel Proxy Summary

**Added session-gated `POST /api/admin/proxy` (39-action hardcoded allowlist) sharing one extracted `forwardToAppsScript` helper with BrewPad's existing `/api/batch/admin-proxy`, with zero behavioural change to the BrewPad route.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-09-23T20:19:18Z
- **Completed:** 2026-09-23T20:31:39Z
- **Tasks:** 1
- **Files modified:** 2 (1 created, 1 modified)

## Accomplishments
- `POST /api/admin/proxy` forwards exactly the 15 contracted read actions via `axios.get` and 24 write actions via `axios.post`, gated by `authTiers.requireTiers(['legacy','session'])`, with client `token` stripped and `server_token` injected from `APPS_SCRIPT_SERVER_TOKEN`
- `forwardToAppsScript(action, payload, isRead, logTag, res)` extracted from `/api/batch/admin-proxy`'s inline branch and reused by both routes; `/api/batch/admin-proxy`'s own allowlist, auth wrapper, and token-strip logic are untouched
- 59 new table-driven parity/contract tests (15 reads + 24 writes + case-insensitivity + 12 excluded-action + auth-gate + 502-collapse + passthrough + server_token-override + contract-shape assertions)

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1 (RED): add failing tests for /api/admin/proxy** - `3ffede72` (test)
2. **Task 1 (GREEN): add POST /api/admin/proxy with shared forwarding helper** - `8c58a85a` (feat)

_No REFACTOR commit needed — the extraction itself was the GREEN step; batch-admin-proxy.test.js required zero changes and passes unmodified._

## Files Created/Modified
- `zoho-middleware/__tests__/admin-proxy.test.js` - New table-driven test suite (59 tests) for `/api/admin/proxy`, harness cloned verbatim from `batch-admin-proxy.test.js`
- `zoho-middleware/routes/pos.js` - Added `forwardToAppsScript` helper; refactored `/api/batch/admin-proxy` to call it; added `ADMIN_PANEL_PROXY_READS`/`ADMIN_PANEL_PROXY_ACTIONS` and `POST /api/admin/proxy`

## Decisions Made
- Followed the plan's exact 15-read/24-write action list verbatim from `<interfaces>` (no additions or omissions)
- Kept `/api/batch/admin-proxy`'s own allowlist objects (`ADMIN_PROXY_ACTIONS`/`ADMIN_PROXY_READS`) completely untouched — only its route body now delegates to the shared helper

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. `zoho-middleware/` and root `node_modules` were absent in this fresh worktree (`npm ci` run in both before testing — not a plan deviation, just environment setup implied by "always cd first" in CLAUDE.md).

## User Setup Required

None - no external service configuration required. This route is not yet called by any browser code (that wiring is 82-06/82-07); it is dead code from the browser's perspective until then, reachable only by tests.

## Next Phase Readiness

`/api/admin/proxy` and `forwardToAppsScript` are live and fully tested, ready for 82-06/82-07 to point `js/admin.js`'s `adminApiGet`/`adminApiPost` at this route. No blockers.

- Full middleware suite: 112 suites / 1687 tests passed
- Root frontend suite: 130 suites / 1854 tests passed
- Root `npm run lint`: clean (no errors)
- `git diff --stat zoho-middleware/__tests__/batch-admin-proxy.test.js`: empty (unmodified, all 12 of its tests still pass)

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*

## Self-Check: PASSED

- FOUND: zoho-middleware/__tests__/admin-proxy.test.js
- FOUND: zoho-middleware/routes/pos.js
- FOUND: .planning/phases/82-store-agnostic-prerequisites/82-04-SUMMARY.md
- FOUND commit: 3ffede72
- FOUND commit: 8c58a85a

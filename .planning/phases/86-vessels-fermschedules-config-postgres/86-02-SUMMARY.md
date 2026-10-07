---
phase: 86-vessels-fermschedules-config-postgres
plan: 02
subsystem: middleware
tags: [admin-proxy, attribution, security]
requires: []
provides:
  - hardenProxyPayload(payload, req) in zoho-middleware/routes/pos.js (extended by 86-16)
affects: [86-03, 86-16]
key-files:
  created:
    - zoho-middleware/__tests__/admin-proxy-attribution.test.js
  modified:
    - zoho-middleware/routes/pos.js
requirements: [DB-05]
metrics:
  tasks: 2
  files: 2
  completed: 2026-10-07
---

# Phase 86 Plan 02: Admin proxy staff attribution Summary

Both admin proxies (`/api/admin/proxy`, `/api/batch/admin-proxy`) now forward the session staff email as `acting_user` and strip client-supplied `acting_user`, `collect_vessel_status`, `vessel_sheet_write` and `schedule_steps_json` after the body merge.

## What was done
- Task 1 (RED): new regression test, 6 cases x 2 proxies = 12 tests. All 12 failed before the fix (acting_user absent, spoofed fields passed through). Not committed alone, per CLAUDE.md.
- Task 2 (GREEN): `SERVER_ONLY_PROXY_FIELDS` + `hardenProxyPayload` added above `ADMIN_PROXY_ACTIONS`, called after `delete payload.token` in both handlers. Legacy x-api-key writes carry no acting_user. Single commit a0688988 with test and fix.

## Verification
- admin-proxy-attribution, admin-proxy, batch-admin-proxy, waitlist-admin-proxy: 87 passed
- Full middleware suite: 162 suites / 2530 tests passed; middleware lint clean
- No existing test edited

## Deviations from Plan
- Worktree was based on an older commit; reset to d2c66be9 per the branch check (expected).
- Worktree lacked node_modules; symlinked the main checkout's `zoho-middleware/node_modules` (untracked, not committed).
- Minor: the helper sits between the Phase 76-02 allowlist comment block and `ADMIN_PROXY_ACTIONS`, slightly detaching that comment. Cosmetic; can be tidied in 86-16.

## Known Stubs
None.

## Self-Check: PASSED
Commit a0688988 present; test file and pos.js changes committed.

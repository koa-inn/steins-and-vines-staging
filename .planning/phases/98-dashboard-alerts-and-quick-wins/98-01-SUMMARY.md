---
phase: 98-dashboard-alerts-and-quick-wins
plan: 01
subsystem: zoho-middleware
tags: [postgres, dashboard, get_dashboard_stats]
requires: []
provides:
  - "get_dashboard_stats top-level inviteSentIds (ids only)"
affects: [98 frontend Invite not sent count]
key-files:
  modified:
    - zoho-middleware/lib/batch-pg-read.js
    - zoho-middleware/__tests__/db/batch-pg-dashboard-stats-96.test.js
  created:
    - zoho-middleware/__tests__/db/batch-pg-invite-sent-98.test.js
key-decisions:
  - "inviteSentIds is ids only (no email/timestamp), ordered by length(batch_id), batch_id"
requirements-completed: [A4]
duration: 10min
completed: 2026-11-05
---

# Phase 98 Plan 01: inviteSentIds on get_dashboard_stats Summary

Additive ids-only `inviteSentIds` array in the Postgres dashboard stats payload (one extra query on the same client, no Zoho call).

## Tasks
1. Task 1 and 2 (single commit e788ccfd): new real-Postgres test (RED confirmed first), `DASH_STATS_INVITED_SQL` + chain link + payload key, owner-approved one-name edit to the stats-96 key-list assertion.

## Verification
`npm run test:db` (56 suites), middleware `npm test` (4055), root `npm test` (3398), `npm run lint` all green. summary.readyToBottle, batch-rules.js and parity fixtures untouched.

## Deviations from Plan
None. Tasks 1 and 2 were committed together as the plan's single specified commit.

## Self-Check: PASSED

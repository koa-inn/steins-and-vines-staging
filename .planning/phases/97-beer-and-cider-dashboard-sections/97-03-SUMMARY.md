---
phase: 97-beer-and-cider-dashboard-sections
plan: 03
subsystem: middleware
tags: [calcom, bookings, beer-packaging]
requires: []
provides:
  - calcom.listBookings (read-only, paginated, capped)
  - CAL_VERSIONS.bookingsList 2026-05-01
  - beer-packaging booking selector (fail-closed)
affects: [97-12]
tech-stack:
  added: []
  patterns: [capped cursor pagination via withRetry]
key-files:
  created:
    - zoho-middleware/__tests__/calcom-list-bookings.test.js
    - zoho-middleware/__tests__/bookings-beer-packaging.test.js
  modified:
    - zoho-middleware/lib/calcom.js
    - zoho-middleware/lib/validateEnv.js
    - zoho-middleware/routes/bookings.js
    - zoho-middleware/scripts/calcom-smoke.sh
key-decisions:
  - "Beer packaging selector fails closed with 503 when env unset"
duration: ~25m
completed: 2026-11-03
---

# Phase 97 Plan 03: Cal.com listBookings + Beer Packaging Summary

Read-only Cal.com `listBookings` (version 2026-05-01, 5-page x 100 cap) plus the Beer Packaging event type (6028745) wired into env validation, the services list and a fail-closed `beer-packaging` booking selector.

## Tasks
1. listBookings + smoke-script read-only check: dcb45771
2. Beer packaging wiring: see git log (`feat(97-03): wire Beer Packaging Cal.com event type`)

## Verification
Full middleware suite (289 suites, 3985 tests) and lint green. Existing calcom, bookings and validateEnv tests unmodified and passing.

## Deviations from Plan
- `bash -n scripts/calcom-smoke.sh` was not run (sandbox refused the invocation); the added block is a simple if/curl/echo. Worth a syntax check in 97-12.
- Ran `npm ci` in zoho-middleware (worktree lacked node_modules).
- RED phase was not run separately before implementation of Task 1/2 (tests and code written in sequence; tests pass).

## Owner steps (97-12)
Set CALCOM_EVENT_TYPE_BEER_PACKAGING=6028745 and CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754 on Railway; verify live GET /v2/bookings with 2026-05-01 (assumption A1).

## Known Stubs
None.

## Self-Check: PASSED

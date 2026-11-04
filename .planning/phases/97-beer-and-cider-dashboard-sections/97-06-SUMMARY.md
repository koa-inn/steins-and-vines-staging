---
phase: 97-beer-and-cider-dashboard-sections
plan: 06
subsystem: middleware
tags: [calcom, packaging, postgres, cache, webhook]
requires: [97-03, 97-04]
provides:
  - GET /api/admin/packaging-bookings (staff-only, matched, whitelisted, soft-fail)
  - lib/packaging-bookings.js pure matcher
  - batch-store packagingCandidates / batch-pg-read getPackagingMatchCandidates
affects: [97-08]
key-files:
  created:
    - zoho-middleware/lib/packaging-bookings.js
    - zoho-middleware/__tests__/packaging-bookings.test.js
    - zoho-middleware/__tests__/packaging-bookings-route.test.js
    - zoho-middleware/__tests__/packaging-bookings-webhook.test.js
    - zoho-middleware/__tests__/db/batch-pg-packaging-candidates.test.js
  modified:
    - zoho-middleware/lib/constants.js
    - zoho-middleware/lib/batch-pg-read.js
    - zoho-middleware/lib/batch-store.js
    - zoho-middleware/routes/brewpad-dashboard.js
    - zoho-middleware/routes/webhooks.js
decisions:
  - Cache invalidation via in-process generation in the cache key, not cache.del, so existing webhook tests stay unmodified
  - Candidate-read failure returns unmatched bookings but is never cached
metrics:
  tasks: 3
  completed: 2026-11-04
requirements: [D-02, D-03, D-04, SC4]
---

# Phase 97 Plan 06: Packaging bookings server half Summary

Staff route returning the next 14 Vancouver days of Cal.com Bottling and Beer Packaging bookings, matched to batches by email server-side (closest open packaging task wins, ties or undated give null), cached 300 s on success only and invalidated by Cal.com booking webhooks.

## Commits
- 022b8e0f: matcher module, constants prefix, unit tests
- bf0b1319: candidates SQL, store function, route, route tests, DB test
- (task 3 commit): webhook invalidation and tests

## Deviations from Plan
- Worktree base was behind the expected wave-1 base; reset to e72a2cb1 per the startup check.
- Lint: optional catch binding (`catch {`) used in the route to satisfy no-unused-vars (already used in lib/cache.js).
- Added a defensive `.catch` on the route chain so any unexpected error returns `{ok:false, reason:'unavailable'}`.

## Verification
- Middleware suite: 297 suites / 4039 tests pass under Node 24; root suite 243 / 3317 pass; both lints clean.
- calcom-webhook.test.js and webhook-wr07.test.js pass unmodified.
- DB test batch-pg-packaging-candidates is skipped locally (Docker not running); it runs on CI.

## Known Stubs
None.

## Self-Check: PASSED

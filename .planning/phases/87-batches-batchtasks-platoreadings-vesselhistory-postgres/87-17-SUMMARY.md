---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 17
subsystem: security
tags: [asvs, security-review, single-issuer, owner-signoff]
requires: [87-05, 87-12, 87-13, 87-14, 87-15, 87-16]
provides: [87-SECURITY.md, batch-single-issuer static test]
affects: [87-18, 87-19, 87-20]
key-files:
  created:
    - .planning/phases/87-batches-batchtasks-platoreadings-vesselhistory-postgres/87-SECURITY.md
    - zoho-middleware/__tests__/batch-single-issuer.test.js
requirements-completed: []
duration: n/a
completed: 2026-10-09
---

# Phase 87 Plan 17: ASVS L1 Review and Owner Sign-off Summary

Static single-issuer invariant test for batch creation, a full ASVS L1 review with threat-register verification for Phase 87, and owner approval of all accepted risks with no changes.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Single-issuer static test and full gate | 4ec4b336 | |
| 2 ASVS L1 review, threat verification | 710195c8 | 87-SECURITY.md |
| 3 Owner sign-off (checkpoint) | 85cd0adb | Owner (koa-inn), 2026-10-09, approved with no changes |

## Gate results (one tree)

| Gate | Result |
|------|--------|
| root `npm test` | 163 suites, 2268 tests pass |
| root `npm run lint` | clean |
| middleware `npm test` | 198 suites, 3111 tests pass |
| middleware `npm run lint` | clean |
| `npm run migrate:guard` | 5 files additive-only OK |
| `npm run test:db` | 32 suites, 353 tests pass |
| batch-focused jest (9 suites incl. single-issuer) | 126 pass |
| `test:db -- batch-pg` | 7 suites, 157 pass |
| client files vs 3010e237 | byte-identical |

## Owner decision

Owner approved on 2026-10-09: accepts risks A1-A7 and info notes A8-A9 as written, plus the public-path hardening (beyond-Q8 reading ownership checks, the 6+ digit batch-id regex and the new validation). No changes. T-87-17-03 is Verified.

## Notes

- `npm run build` re-stamps `js/admin.js`, `js/admin.min.js` and about 24 HTML files (BUILD_TIMESTAMP / cache-bust). Phase 87 changes no `js/` source, so no rebuild is needed for this phase. The byte-identical client-file check must run before any build. The build output was reverted during this plan.
- The single-issuer test uses "same top-level function" rather than "preceded by" because of `brewpad-integration.js`.
- A stray `create_batch` literal added to `lib/vessel-store.js` made the test fail (proving it bites); reverted.

## Deviations from Plan

None.

## Deferred

- DB-06 is NOT marked complete: the production cutover is still pending (plans 87-18 to 87-20).

## Self-Check: PASSED

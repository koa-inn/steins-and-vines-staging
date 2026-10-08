---
phase: 86-vessels-fermschedules-config-postgres
plan: 17
subsystem: security
tags: [security, asvs, staff-access, vessels, csrf]
requires: ["86-02", "86-03", "86-04", "86-08", "86-10", "86-12", "86-14", "86-15", "86-16"]
provides:
  - 86-SECURITY.md ASVS L1 review with threat verification and owner sign-off
  - Header-token CSRF check on session-tier vessel writes
affects: [zoho-middleware/routes/vessels.js]
key-files:
  created:
    - .planning/phases/86-vessels-fermschedules-config-postgres/86-SECURITY.md
    - zoho-middleware/__tests__/vessels-routes-csrf.test.js
  modified:
    - zoho-middleware/routes/vessels.js
decisions:
  - "Owner chose to fix the vessel cookie-only write path (review item 5) before signing instead of accepting it"
  - "Accepted risks 1-4 (5 s allowlist cache, server_token in GET reads, formula injection, schedule delete/reference window)"
  - "D-18 Config staff_emails mitigation stays scheduled for the 86-20 production flip"
metrics:
  tasks: 2
  completed: 2026-10-08
---

# Phase 86 Plan 17: ASVS L1 security review and owner sign-off Summary

The ASVS L1 review of the allowlist change path and the new vessel and schedule APIs is written, evidenced and signed off by the owner. One finding was fixed before sign-off.

## What was done

- **Task 1 (`35d31792`):** `86-SECURITY.md` covers V2, V3, V4, V5, V7, V8 and V13, with file:line evidence for each.
  - All 112 `T-86-*` threat ids are verified: 83 closed, 8 accepted as Low, 20 scheduled for 86-18 to 86-20.
  - 7 jest suites passed (125 tests) and `test:db staff-access-pg` passed 14 of 14.
  - All six grep gates passed.
- **Owner-requested fix (`756abe31`):**
  - **Finding:** review item 5 was that vessel POST, PUT, archive and unarchive accepted a session proven only by the `SameSite=None` cookie.
  - **Fix:** `routes/vessels.js` `sessionWriteBlocked()` now applies the same check Staff Access uses. It requires the `x-session-token` header, a header that matches any cookie, and an allowlisted Origin when one is sent.
  - **Unchanged:** legacy `x-api-key` writes and GET reads. The admin client already sends the header on every middleware request.
  - **Test:** `vessels-routes-csrf.test.js` has 21 tests. 12 failed before the fix, and all pass after it.
- **Task 2:** the owner approved on 2026-10-08. The name and date are recorded in the "Owner sign-off" block.

## Verification

- Middleware: 182 suites, 2804 tests pass. Lint is clean.
- Root: 161 suites, 2248 tests pass. Lint is clean.
- The existing `vessels-routes.test.js` passes unmodified.

## Deviations

- The fix was made inline by the orchestrator after the owner's instruction, not as a separate gap-closure plan. It is a one-file route guard with a regression-first test.

## Open items carried forward

- **D-18:** blank the Config `staff_emails` cell, wait 5 minutes, probe, then trim `STAFF_EMAILS`. This happens at the 86-20 flip. The Apps Script limb is removed in Phase 88.
- **Config tab check:** the owner should confirm the live Config tab has no `server_token` row. The reviewer could not read the sheet.

## Self-Check: PASSED

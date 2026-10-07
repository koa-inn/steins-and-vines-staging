---
phase: 86-vessels-fermschedules-config-postgres
plan: 12
subsystem: auth
tags: [staff-access, auth, express, postgres, csrf, break-glass]
requires:
  - phase: 86-07
    provides: lib/staff-access.js resolve, lib/staff-access-pg.js mutations
provides:
  - Per-request allowlist revalidation in authTiers.resolveTier (immediate revocation)
  - /auth/google gated by staffAccess.resolve
  - Owner-only audited Staff Access API (/api/staff-access, /me)
  - lib/allowed-origins.js shared origin allowlist
affects: [86-10 admin tab consumer, 86-17 security review]
key-files:
  created:
    - zoho-middleware/routes/staff-access.js
    - zoho-middleware/lib/allowed-origins.js
    - zoho-middleware/__tests__/auth-tiers-revocation.test.js
    - zoho-middleware/__tests__/auth-google-staff-access.test.js
    - zoho-middleware/__tests__/staff-access-routes.test.js
  modified:
    - zoho-middleware/lib/authTiers.js
    - zoho-middleware/routes/auth.js
    - zoho-middleware/server.js
key-decisions:
  - "Sheets mode keeps the exact prior resolveTier path (no resolve call); only non-sheets modes revalidate"
  - "Definitive denial destroys the session; degraded (DB down) denial does not"
  - "Staff Access routes require x-session-token header (cookie-only rejected), matching cookie if both sent"
  - "Denied-audit rows written only for refused mutations, not refused GETs"
requirements-completed: [DB-05]
duration: 25min
completed: 2026-10-07
---

# Phase 86 Plan 12: Staff Access auth wiring and owner API Summary

Allowlist now governs sign-in and every session request (immediate revocation, break-glass survives DB outage), and owners manage it through a header-token-only, origin-checked, transactional, audited API.

## Tasks
1. Per-request revalidation and /auth/google via staffAccess.resolve - 1a961836
2. routes/staff-access.js, lib/allowed-origins.js, server.js mount - 03b0d2d3

## Verification
Middleware suite 171 suites / 2662 tests pass; root suite 161 / 2248 pass; middleware lint clean. auth-tiers-guard, auth-google-route, pos-auth-tier, catalog-bust-auth unmodified and green.

## Deviations from Plan
None in behaviour. Notes:
- Worktree base was a509e397 rather than the expected 665681fb; reset to the expected base per the startup check.
- The session/header/Origin guard also runs on GET /me (owner check does not), so /me is header-token-only too. The 86-10 admin tab sends x-session-token, so this is compatible; flagging for the 86-17 review.
- The plan asked that `resolveTier` never trust payload roles: done; `req.staffRole` is set only from resolve.

## Known Stubs
None.

## Threat Flags
None beyond the plan's threat model.

## Self-Check: PASSED

---
phase: 86-vessels-fermschedules-config-postgres
plan: 10
subsystem: ui
tags: [admin, vessels, staff-access, jest, escapeHTML]
requires: ["86-04"]
provides:
  - Admin Vessels tab (list, add with next-id, edit, status override, archive/unarchive, stale_vessel handling)
  - Owner-only Staff Access tab (list, add, change role, remove, audit, break-glass read-only)
  - Vessel label in admin pickers and search
affects: [86-15, 86-12]
tech-stack:
  added: []
  patterns: [lazy tab load via initTabNavigation wrapper, sibling stale-toast helper, vesselsMwFetch status-preserving fetch]
key-files:
  created:
    - tests/frontend/admin-vessels-tab.test.js
    - tests/frontend/admin-staff-access-tab.test.js
  modified:
    - admin.html
    - js/admin.js
    - js/admin.min.js
key-decisions:
  - "Vessel status override values are 'Empty' / 'In-Use' (match setVesselStatus in adminApi.gs)"
  - "Show archived checkbox defaults off; archived rows carry an Archived marker and Unarchive action when shown"
  - "Staff Access visibility check runs from showDashboard (covers fresh sign-in and session restore)"
requirements-completed: [DB-05]
duration: 40min
completed: 2026-10-07
---

# Phase 86 Plan 10: Admin Vessels and Staff Access tabs Summary

Admin gains a Vessels tab (add/edit/archive with expected_updated_at and stale reload, no delete) and an owner-only Staff Access tab, both lazy-loaded and escapeHTML-safe, plus vessel labels in admin pickers.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 Vessels tab + picker label | c135727f | admin.html tabs/panels, admin.js code (also contains Staff Access code), 14 tests |
| 2 Staff Access tab | 110ff2a7 | 7 tests; implementation shipped in c135727f because both tabs share one file and lazy-load wrapper |
| 3 Build + gate | 0a70e4f9, 69f1af33 | Rebuilt admin.min.js and re-stamped HTML cache versions |

Verification: root `npm test` (158 suites, 2232 tests), `npm run lint` (0 warnings), `zoho-middleware` `npm test` (165 suites, 2568 tests) all pass. No Content-Security-Policy change in admin.html.

## Deviations from Plan

**1. [Rule 2 - Security] Escaped label/location/id in the admin vessel picker dropdown**
- `showVesselOptions` interpolated `buildVesselLabel` and `v.location` into innerHTML unescaped; now that label is user-editable it would be stored XSS. Now escaped (covered by test).

**2. [Rule 1 - Lint] Loose `== null` warnings** in the new code replaced by relying on escapeHTML null handling (lint runs with max-warnings 0).

**3. Test seams** added to admin.js exports (`_initVesselsTabForTest`, `_initTabNavigationForTest`, `_checkStaffAccessVisibilityForTest`, `_initStaffAccessTabForTest`, `_buildVesselLabelForTest`, `_showVesselOptionsForTest`, `_setVesselsDataForTest`, `_vesselsTabState`).

**4. Commit split:** Tasks 1 and 2 touch the same admin.js region, so Staff Access code landed in the Task 1 commit with its tests in Task 2. TDD RED commits were not made separately.

Environment: worktree base was reset to ae737513 per the branch check; node_modules symlinked (untracked). Existing tests unmodified. links.html and HANDOFF-infrastructure.md untouched.

## Known Stubs

None.

## Threat Flags

None. T-86-10-01 mitigated (escapeHTML everywhere, onerror payload tests for vessel label, picker and audit), -02 server-enforced (UI hide cosmetic), -03 expected_updated_at + stale toast, -04 no delete control, -05 CSP untouched.

## Self-Check: PASSED

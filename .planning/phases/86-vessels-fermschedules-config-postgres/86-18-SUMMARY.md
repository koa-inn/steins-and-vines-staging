---
phase: 86-vessels-fermschedules-config-postgres
plan: 18
subsystem: release
tags: [staging, rehearsal, backfill, uat, apps-script]
requires: ["86-01", "86-02", "86-03", "86-04", "86-05", "86-06", "86-07", "86-08", "86-09", "86-10", "86-11", "86-12", "86-13", "86-14", "86-15", "86-16", "86-17"]
provides:
  - Staging in dual for vessels, ferm_schedules, config and staff_access
  - Apps Script v61 live (rollback 60)
  - Owner-approved staging UAT
affects: [zoho-middleware/lib/ops-proxy.js, docs/RUNBOOK.md, 86-DUAL-LOG.md, 85-DUAL-LOG.md]
key-files:
  modified:
    - zoho-middleware/lib/ops-proxy.js
    - zoho-middleware/__tests__/ops-proxy.test.js
    - zoho-middleware/__tests__/ops-proxy-routes.test.js
    - docs/RUNBOOK.md
    - .planning/phases/86-vessels-fermschedules-config-postgres/86-DUAL-LOG.md
    - .planning/phases/85-recipes-recipeingredients-postgres/85-DUAL-LOG.md
decisions:
  - "85-13 production deploy pinned to d2c66be9 (`git push production d2c66be9:main --force`, never main)"
  - "Data hygiene: FS-0011 and the FS-0001 [gfs-probe] text are imported as-is"
  - "Config tab gets a key | value header row (it had none). Safe because Apps Script scans every row"
  - "Second-account Staff Access UAT skipped by owner; covered by tests"
metrics:
  tasks: 3
  completed: 2026-10-08
---

# Phase 86 Plan 18: Staging rehearsal Summary

Staging runs vessels, ferm schedules, config and the staff allowlist in dual mode. The backfill is verified and the owner approved the UAT. One dual-mode bug was found and fixed during the UAT.

## What was done

- **Task 1:**
  - 85-13 is pinned to `d2c66be9`. `production/main` has no Phase 86 commit.
  - All gates are green: root 2248 tests, middleware 2804 tests, `test:db` 176 tests, `migrate:guard`, lint and build.
  - Invariants (a)–(d) hold. The only edited existing test file is the owner-approved `store-flag.test.js` change.
  - The staging candidate is `b5aad084`.
- **Task 2:**
  - `b5aad084` was pushed and staging middleware restarted healthy.
  - Apps Script v61 was deployed by the owner, with v60 as rollback.
  - Data-hygiene items are imported as-is.
  - The Vessels `label` header was added in L1, and a Config `key | value` header row was added.
  - Backfill: 232 vessels, 11 schedules, 2 config keys and 2 staff (1 owner), with 0 rejects.
  - `ops-verify` passed with 0 mismatches and the label header present.
  - `OPS_DATA_STORE` and `STAFF_ACCESS_STORE` were set to dual together.
- **Task 3:** Claude ran the UAT in Chrome as the owner.
  - Steps 1, 2, 3, 5 and 6 pass, plus the owner side of step 4. Results are in `86-DUAL-LOG.md`.
  - The owner skipped the second-account Staff Access part; the tests cover it.

## Deviations / issues found

- **Bug (from 86-16), fixed in `e6da5880`:**
  - **Cause:** in dual or postgres mode, the `get_batch_init` overlay set `data.schedules` to a bare array. Apps Script returns `{schedules:[...]}`, so the admin Schedule Templates list rendered empty.
  - **Tests:** both existing tests had modelled the wrong shape. Their assertions were corrected with owner approval and failed before the fix.
  - **Verification:** after the fix, staging showed all 11 template cards.
- **Planning gap:** the backfill assumed the Config tab had a header row, but it didn't. A header row was inserted and RUNBOOK §11 now notes the requirement.
- **Bug logged (todo):** `ops-backfill` echoes unexpected header text in its rejects, which printed staff emails during a failed run. This must be fixed before the 86-19 production backfill: `.planning/todos/pending/backfill-rejects-echo-header-emails.md`.
- **Undeletable archived schedules:** an archived schedule can't be deleted from the admin, because the delete needs its version token and archived schedules aren't listed. Test schedule FS-0013 stays archived on staging.
- **Editor-drift check skipped:** the owner skipped it before pasting v61.

## Leftover staging test data

TST-001 (Empty, labelled "UAT test carboy") and FS-0013 (archived).

## Self-Check: PASSED

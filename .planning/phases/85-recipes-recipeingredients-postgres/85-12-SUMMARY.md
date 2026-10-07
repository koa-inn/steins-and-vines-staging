---
phase: 85-recipes-recipeingredients-postgres
plan: 12
subsystem: database
tags: [postgres, staging, rehearsal, uat, recipes]
requires:
  - phase: 85-01..85-11
    provides: "schema, recipe-pg, mirror, store facade, routes, kiosk seam, editors, backfill/verify/replay"
provides:
  - "Staging running RECIPES_STORE=dual on the real-copy backfill (10 recipes / 117 ingredients)"
  - "Apps Script version 60 live (rollback 59) with the three Phase 85 actions"
  - "Owner-approved staging UAT recorded in 85-DUAL-LOG.md"
affects: [85-13]
key-files:
  created:
    - .planning/phases/85-recipes-recipeingredients-postgres/85-12-SUMMARY.md
  modified:
    - docs/RUNBOOK.md
    - .planning/phases/85-recipes-recipeingredients-postgres/85-DUAL-LOG.md
key-decisions:
  - "BrewPad D-03 check run in desktop Chrome instead of the iPad (owner-approved): the stale-save logic is browser-independent; the iPad Safari cookie path stays with the Phase 76 check"
  - "Step 2b (admin kiosk quick-edit) recorded NOT RUNNABLE: admin's quick-edit prompt is only reachable via a test hook (pre-existing); 85-09 logic covered by unit tests"
requirements-completed: []
duration: ~3h (incl. owner actions)
completed: 2026-10-07
---

# Phase 85 Plan 12: Staging rehearsal Summary

Staging proved the full Phase 85 flow end to end; the owner approved on 2026-10-07.

## Task 1: automated gate
Frontend 2152/2152, middleware 2512/2512, `test:db` 111/111, both linters clean, `migrate:guard`
additive-only, single recipe-action issuer (`lib/recipe-store.js`), `adminApi.gs` diff additive-only.
Build stamps committed (`bd12df33`), staging candidate SHA recorded in the RUNBOOK.

## Task 2: staging cutover
- Push `57a44b84` to staging; Pages deploy finished before dual (T-85-63 ordering).
- Apps Script v60 (rollback v59) on deployment `…DI968g`; editor-drift hash matched before paste,
  post-paste hash matched the repo file; `GET /api/recipes` 200 on prod and staging afterwards.
- Owner fixed SV-R-000001; dry run 0 rejects; promote 10 recipes / 117 ingredients, sequences 13 / 184;
  verify 0 mismatches.
- `RECIPES_STORE=dual` on staging (Railway CLI); startup log shows both stores in dual and the mirror
  sweep registered. Staging `/api/recipes` serves `source: postgres`, field-identical to production.

## Task 3: staging UAT (driven in Chrome, owner sign-ins)
| Step | Result |
|------|--------|
| 1 admin two-tab D-03 | PASS |
| 2 BrewPad D-03 (desktop Chrome) | PASS |
| 2b admin kiosk quick-edit | NOT RUNNABLE (pre-existing) |
| 3 runsheet; rename PUT | PASS, 332 ms |
| 4 public beer page | PASS |
| 5 kiosk quotes vs production | PASS, 8/8 identical |
| 6 delete | PASS (hard delete) |

## Deviations
- A first Apps Script paste attempt by Claude was blocked by the permission classifier; the owner
  pasted and deployed v60.
- BrewPad check ran on desktop Chrome, not the iPad (owner-approved).

## Issues found (outside Phase 85)
- Production kiosk recipe quotes returned 503 "Ingredient catalog not available": the
  `zoho:ingredients:all` cache was empty and `routes/pos-recipe.js` has no file-cache fallback.
  The owner asked for this to be fixed before 85-13.
- Admin Kiosk Sale, Recipes grid sticks on "Loading recipes..." after the data loads.
- Admin kiosk quick-edit is unreachable from the real UI.

## Self-Check: PASSED

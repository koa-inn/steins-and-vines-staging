---
phase: 85-recipes-recipeingredients-postgres
plan: 06
subsystem: database
tags: [postgres, recipes, facade, store-flag, es5]
requires:
  - phase: 85-03
    provides: "recipe-pg update/delete"
  - phase: 85-05
    provides: "recipe-mirror schedule"
provides:
  - "lib/recipe-store.js facade: getMode, isConfigured, list, get, getFromSheet, create, update, remove, hasBatchReferences"
affects: [85-07, 85-08]
key-files:
  created:
    - zoho-middleware/lib/recipe-store.js
    - zoho-middleware/__tests__/recipe-store.test.js
key-decisions:
  - "Sheets mode is an exact copy of routes/recipes.js callAppsScriptPost; update never forwards expectedUpdatedAt (D-04)"
  - "Delete in dual/postgres asks Apps Script recipe_batch_ref_count first (all environments) and fails closed with err.code batch_ref_unavailable"
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 06: recipe-store facade Summary

`lib/recipe-store.js` is the single seam for recipe reads and writes. RECIPES_STORE resolves per call: sheets keeps today's Apps Script calls (same URL, body, headers, 15 s timeout), while dual and postgres run recipe-pg inside `db.withTransaction`, return Apps Script envelope shapes, and schedule the D-01 mirror after commit.

## Tasks

| Task | Commit |
|------|--------|
| 1. Reads + sheets transport | 769e19ea |
| 2. Writes, mirror scheduling, fail-closed delete | e587a51e |

## Verification

- recipe-store suite: 27 tests pass. Middleware `npm test`: 155 suites / 2421 tests. Root `npm test`: 150 suites / 2152 tests. Middleware lint clean.

## Notes for 85-07 / 85-08 (route integration)

- Postgres validation failures are returned as `{ok:false, error, message}` with `error` in `invalid_data`, `missing_fields`, `missing_id`, `not_found`, `stale_recipe`; they are NOT thrown. Routes must map `invalid_data`/`missing_fields`/`missing_id` to 400, `not_found` to 404, `stale_recipe` to 409. Only infrastructure failures reject (route should answer 502); `hasBatchReferences` rejections carry `err.code === 'batch_ref_unavailable'`.
- `get()` in postgres mode returns `{ok:false, error:'not_found'}` at top level; in sheets mode the Apps Script body is untouched (including its `{ok:true, data:{ok:false}}` quirk).

## Deviations from Plan

None - plan executed as written. The module file was committed in two steps (task 1 omitted the mirror require until task 2 used it, to keep lint clean).

## Known Stubs

None.

## Threat Flags

None. T-85-33..37 mitigated: fail-closed batch ref check, no sheet fallback, identical sheets transport (tested), schedule wrapped in try/catch, underscore keys stripped.

## Self-Check: PASSED

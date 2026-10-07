---
phase: 85-recipes-recipeingredients-postgres
plan: 05
subsystem: middleware
tags: [recipes, sheet-mirror, redis, retry, sentry]
requires:
  - phase: 85-02
    provides: "recipePg.getRecipe"
  - phase: 85-04
    provides: "mirror_recipe_state / mirror_recipe_delete Apps Script actions"
provides:
  - "lib/recipe-mirror.js: schedule, isDirty, mirrorLatest, sweep, DIRTY_PREFIX, RETRY_DELAYS_MS"
affects: [85-06, 85-08, 85-11]
key-files:
  created: [zoho-middleware/lib/recipe-mirror.js, zoho-middleware/__tests__/recipe-mirror.test.js]
  modified: [zoho-middleware/server.js]
requirements-completed: [DB-04]
completed: 2026-10-07
---

# Phase 85 Plan 05: Recipe sheet mirror worker Summary

Production-only, durable, ordered background worker that copies the current Postgres state of a recipe to the sheet (state copy or delete), with Redis dirty markers, 2s/10s/60s/5min backoff, Sentry on persistent failure and a 5-minute sweep.

## Tasks

| Task | Commit |
|------|--------|
| 1. recipe-mirror.js worker + unit suite | a20e25ec |
| 2. sweep() tests + server.js 5-minute registration | 1a1b24e6 |

## Design notes
- All work (marker write + send) is inside `sheetMirror.mirrorFireAndForget('recipes.mirror', ...)`; no environment checks in the module.
- Per-recipe serial promise chain; state is read from Postgres at send time; marker cleared only if its token is unchanged.
- Retry loop: initial attempt + 4 delayed retries, timers unref()'d; then one Sentry error (`component: recipes-mirror`, `recipe_id`). Marker stays for the sweep and recipes-verify.
- sweep(): no-op when mirror disabled or Redis disconnected, skips recipes with a running chain, Sentry alerts throttled to 1/recipe/hour.
- Logs and Sentry tags carry recipe_id only.

## Verification
13 + 5 tests in recipe-mirror suite pass (18 total). Middleware `npm test`: 154 suites / 2394 tests pass; `npm run lint` clean. Root `npm test`: 150 suites / 2152 tests pass.

## Deviations from Plan
None. TDD note: tests and implementation for Task 1 were committed together (no separate RED commit).

## Known Stubs
None.

## Threat Flags
None. T-85-27..32 mitigated as specified.

## Self-Check: PASSED
node_modules symlinks removed before return.

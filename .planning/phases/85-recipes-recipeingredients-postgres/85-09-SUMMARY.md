---
phase: 85-recipes-recipeingredients-postgres
plan: 09
subsystem: frontend
tags: [recipes, optimistic-concurrency, D-03, admin, brewpad, kiosk]
requires: [85-07 server contract (409 stale_recipe)]
provides: [expected_updated_at on every recipe PUT/DELETE caller, Reload UX on stale_recipe]
affects: [js/admin.js, js/brewpad.js, js/admin.min.js, js/brewpad.min.js]
key-files:
  modified: [js/admin.js, js/brewpad.js, js/admin.min.js, js/brewpad.min.js]
  created: [tests/frontend/admin-recipe-stale-save.test.js, tests/frontend/brewpad-recipe-stale-save.test.js]
decisions:
  - Kiosk quick-edit refreshes its token via GET /api/recipes/:id after each save (PUT still returns only {ok:true})
  - Build churn (HTML cache stamps, admin.js BUILD_TIMESTAMP) was reverted; only the two min artifacts were committed
requirements: [DB-04]
metrics:
  tasks: 3
  completed: 2026-10-07
---

# Phase 85 Plan 09: Browser half of D-03 Summary

Admin editor, admin kiosk quick-edit and BrewPad now send `expected_updated_at` (PUT body / DELETE query) for existing recipes and turn a 409 `stale_recipe` into the D-03 message with a Reload action; 409 is never auto-retried.

## What changed
- `js/admin.js`: `showToast` gained additive `actionLabel`/`onAction`; `saveRecipe`/`deleteRecipe` send the token and use shared helpers (`recipeStatusPreservingJson`, `throwIfStaleRecipe`, `showStaleRecipeToast`); new `kioskRefreshRecipeFromDetail`; `kioskSaveRecipeQuickEdit` takes the form-open token (4th arg), refreshes it after success, handles stale with Reload. Test hooks exported additively.
- `js/brewpad.js`: token set in `saveRecipe` before `submitRecipeSave` (so Retry reuses it); stale branch placed after `saveRecipeDraftNow()`; `deleteRecipe` appends token and handles stale; `deleteRecipe` exported for tests. Transient set unchanged.
- Caller audit: PUT/DELETE recipe callers are exactly admin saveRecipe, deleteRecipe, kioskSaveRecipeQuickEdit and brewpad submitRecipeSave, deleteRecipe; no others found.

## Commits
- 5476d79a feat(85-09): admin editor + kiosk quick-edit
- 6de56c38 feat(85-09): BrewPad editor
- e40914c3 build(85-09): rebuild admin.min.js and brewpad.min.js

## Verification
Root `npm test` 2133/2133, middleware `npm test` 2291/2291, `npm run lint` clean. New suites: 15 admin + 8 BrewPad tests; existing suites unmodified and passing.

## Deviations from Plan
- [Rule 3 - scope] `npm run build` re-stamps ~25 HTML pages and admin.js BUILD_TIMESTAMP. Per the parallel-executor instruction, that churn was reverted and only `admin.min.js`/`brewpad.min.js` committed. Consequence: admin.min.js carries the build's BUILD_TIMESTAMP while admin.js source retains the old one, and HTML cache-version query strings were not bumped. A normal build+commit at deploy time (85-12) will re-stamp these.
- RED-first ordering was not strictly followed (implementation written before tests were run); tests were written to the behaviors and pass.

## Known Stubs
None.

## Self-Check: PASSED

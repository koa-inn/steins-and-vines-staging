---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 02
subsystem: api
tags: [express, redis, apps-script, recipes, ferment-schedule]

# Dependency graph
requires:
  - phase: 81-01
    provides: "Recipes rows carry schedule_id (staff callers already receive it byte-for-byte)"
provides:
  - "CACHE_KEYS.FERM_SCHEDULES ('sv:ferm-schedules'), 300s TTL"
  - "maxNonPackagingOffset(schedule) -> number|null — pure, order-independent, exported from routes/recipes.js"
  - "fetchFermSchedules() -> Promise<Array> — cache-first GET to Apps Script get_ferm_schedules, never rejects"
  - "enrichFermentDays(recipes) — sets recipe.ferment_days only when a positive integer is derivable"
  - "PUBLIC_RECIPE_FIELDS gains 'ferment_days' as the only new public field this phase"
affects: [81-05, 81-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "axios.get (not callAppsScriptPost) for Apps Script actions absent from doPost's server-token allowlist"
    - "Promise.all composition of two independent enrichment functions before projection/response"

key-files:
  created: []
  modified:
    - zoho-middleware/lib/constants.js
    - zoho-middleware/routes/recipes.js
    - zoho-middleware/__tests__/recipes.test.js
    - zoho-middleware/__tests__/recipes-public-guard.test.js

key-decisions:
  - "ferment_days assigned only when the derived offset is a number strictly > 0 — D-09 requires an unusable value be indistinguishable from 'no schedule', never null/0"
  - "get_ferm_schedules dispatched via axios.get against doGet's bypass, NOT callAppsScriptPost — it is absent from doPost's hardcoded server-token allowlist"
  - "Worst-case combined staleness is 600s (Apps Script 'gfs' 300s TTL + middleware FERM_SCHEDULES 300s TTL)"

patterns-established:
  - "Test fixtures that flow through a mutating enrichment function (enrichFermentDays writes recipe.ferment_days in place) must be per-test factories, not shared object literals — a shared fixture leaks mutations across tests in the same describe block"

requirements-completed: [OPS-05]

# Metrics
duration: ~35min
completed: 2026-09-05
---

# Phase 81 Plan 02: Fermentation timeline derivation (D-16 server-side) Summary

**Server-side ferment_days derivation (max non-packaging day_offset from a recipe's fermentation schedule template), exposed as the one new public integer on GET /api/recipes and GET /api/recipes/:id, with schedule_id/step detail never crossing the public boundary.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-05T17:00:00Z (approx)
- **Completed:** 2026-09-05T17:36:00Z
- **Tasks:** 2 completed
- **Files modified:** 4

## Accomplishments
- `maxNonPackagingOffset(schedule)` — pure, order-independent reduction of a schedule template's `steps_parsed` to the max non-packaging `day_offset`, exported for direct test coverage
- `fetchFermSchedules()` — cache-first (`sv:ferm-schedules`, 300s TTL) GET to Apps Script's `get_ferm_schedules` action, never rejects (degrades to `[]` on any failure)
- `enrichFermentDays(recipes)` wired into all four existing enrichment call sites (list cache-hit, list Apps-Script-fetch, detail cache-hit, detail Apps-Script-fetch) via `Promise.all` alongside the existing price enrichment
- `PUBLIC_RECIPE_FIELDS` gains exactly one entry, `ferment_days` — the only new field this phase adds to the public boundary; `schedule_id` and all step data (`steps`, `steps_parsed`, `title`, `is_transfer`) stay server-side only, enforced by a new negative-sweep test assertion

## Task Commits

Each task followed RED → GREEN (TDD):

1. **Task 1: Cache key, schedules fetch, and the maxNonPackagingOffset derivation**
   - `5aab752d` test(81-02): add failing tests for maxNonPackagingOffset and fetchFermSchedules
   - `3ab87181` feat(81-02): add FERM_SCHEDULES cache key and maxNonPackagingOffset derivation
2. **Task 2: Wire ferment_days into both read paths and the public allowlist**
   - `6e56fd1e` test(81-02): add failing tests for ferment_days wiring and public allowlist
   - `195b930a` feat(81-02): wire ferment_days into both recipe read paths and public allowlist

**Plan metadata:** (this commit, following SUMMARY)

_Both tasks were `tdd="true"` — each RED commit was verified failing against the pre-implementation code (via a saved diff + `git checkout --` + `git apply`, since `git stash` is prohibited in worktree mode) before its GREEN commit was made._

## Files Created/Modified
- `zoho-middleware/lib/constants.js` — added `CACHE_KEYS.FERM_SCHEDULES = 'sv:ferm-schedules'`
- `zoho-middleware/routes/recipes.js` — added `maxNonPackagingOffset`, `fetchFermSchedules`, `enrichFermentDays`; wired the latter into 4 call sites; extended `PUBLIC_RECIPE_FIELDS`
- `zoho-middleware/__tests__/recipes.test.js` — added `maxNonPackagingOffset` (6 tests), `fetchFermSchedules` (6 tests), and staff-path + schedules-fetch-failure (2 tests) describe blocks; harness now also returns the required `routes/recipes` module for direct function access
- `zoho-middleware/__tests__/recipes-public-guard.test.js` — added a sibling `describe` block (7 tests) covering the anonymous-caller ferment_days contract, including a negative-key sweep

## Decisions Made
- **D-09 zero-tolerance for placeholder values:** `enrichFermentDays` only ever assigns `recipe.ferment_days` when the derived offset is `typeof === 'number' && > 0`. A `0` or negative offset (possible if a template's only non-packaging step is day 0, or has a backdated negative offset) is treated identically to "no schedule" — verified by a dedicated test using both a zero-offset and a negative-offset schedule fixture.
- **axios.get, not callAppsScriptPost, for `get_ferm_schedules`:** confirmed against `apps-script/adminApi.gs`'s `doPost` allowlist (unchanged, no Apps Script edits made this plan) that the action is only dispatched via `doGet`'s server-token bypass.
- **Worst-case staleness figure (for plan 81-06's D-15 copy):** Apps Script `'gfs'` `_cachedGet` TTL (300s, `apps-script/adminApi.gs:186`) + middleware `FERM_SCHEDULES` TTL (300s, this plan) = **600 seconds (10 minutes)** combined worst case before a schedule change is reflected on the public card.

## Deviations from Plan

None — plan executed exactly as written. One test-authoring pitfall was caught and fixed in-flight (not a deviation from the plan's *code*, but worth recording): `enrichFermentDays` mutates its input recipe objects in place (`recipe.ferment_days = offset`), so early drafts of the new tests used shared object-literal fixtures across multiple tests/describe blocks — a mutation from an earlier test (e.g. the staff-path test asserting `ferment_days: 21`) leaked into a later test in the same block (the schedules-fetch-failure test, which expects the key absent) because both referenced the same JS object. Fixed by converting every recipe fixture that participates in a `ferment_days` assertion into a per-call factory function (`freshRecipeScheduled()`, etc.) instead of a shared `var`. Caught during the Task 2 RED→GREEN verification, before either test or feat commit — no bad state was ever committed.

## Issues Encountered
- Neither the root nor `zoho-middleware` `node_modules` existed in this fresh worktree checkout; ran `npm ci` in both before any test could execute. Not a plan deviation — standard worktree setup, not tracked as a deviation per Rule 3's package-install exclusion (this was an existing, lockfile-pinned install, not a new/unverified package).

## User Setup Required
None — no external service configuration required. Zero Apps Script changes (verified: `apps-script/adminApi.gs` untouched by this plan's commits).

## Next Phase Readiness
- Plan 81-05 (browser-side BeerXML review) can now duplicate `maxNonPackagingOffset`'s exact "exclude packaging, take the max, order-independent" rule in `js/admin.js` — the middleware copy is commented pointing at that future duplication and the reason it's deliberate.
- Plan 81-06 (D-15 customer-facing copy) has its precise worst-case staleness figure: **600 seconds (10 minutes)**.
- `GET /api/recipes` and `GET /api/recipes/:id` now return `ferment_days` to anonymous callers whenever a recipe's linked schedule yields a positive non-packaging max offset; no frontend consumes it yet (that's plan 81-03/81-04's scope per the phase's pattern map).
- No blockers.

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Completed: 2026-09-05*

## Self-Check: PASSED

- FOUND: zoho-middleware/lib/constants.js
- FOUND: zoho-middleware/routes/recipes.js
- FOUND: zoho-middleware/__tests__/recipes.test.js
- FOUND: zoho-middleware/__tests__/recipes-public-guard.test.js
- FOUND: .planning/phases/81-recipe-fermentation-timeline-give-customers-an-expected-read/81-02-SUMMARY.md
- FOUND commit: 5aab752d (test(81-02): add failing tests for maxNonPackagingOffset and fetchFermSchedules)
- FOUND commit: 3ab87181 (feat(81-02): add FERM_SCHEDULES cache key and maxNonPackagingOffset derivation)
- FOUND commit: 6e56fd1e (test(81-02): add failing tests for ferment_days wiring and public allowlist)
- FOUND commit: 195b930a (feat(81-02): wire ferment_days into both recipe read paths and public allowlist)

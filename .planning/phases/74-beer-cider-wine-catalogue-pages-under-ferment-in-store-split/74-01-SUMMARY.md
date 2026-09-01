---
phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split
plan: 01
subsystem: api
tags: [express, jest, recipes, authTiers, information-disclosure, access-control]

# Dependency graph
requires: []
provides:
  - "Tier-aware public read contract on GET /api/recipes and GET /api/recipes/:id"
  - "toPublicRecipe() field-allowlist projection (recipe_id, name, style, description, price, price_from)"
  - "isRecipeStaff() — authTiers.resolveTier + allowKiosk, fail-closed-to-public helper"
  - "recipes-public-guard.test.js — dedicated regression coverage for the anonymous read contract"
affects: [74-02, 74-03, 74-04, 74-05, 74-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional-auth GET route: resolve tier via authTiers.resolveTier + allowKiosk (never requireTiers, which rejects on missing credential); cache the FULL result regardless of caller, project to the public shape only at response time"
    - "Field allowlist via build-new object (Object.prototype.hasOwnProperty.call + explicit copy), never delete-from-source"
    - "Enumeration-safe 404: non-active resource for a non-staff caller returns the same 404 shape as 'missing', never 401/403"

key-files:
  created:
    - zoho-middleware/__tests__/recipes-public-guard.test.js
  modified:
    - zoho-middleware/routes/recipes.js
    - zoho-middleware/__tests__/recipes.test.js

key-decisions:
  - "Task 1 checkpoint resolved by developer: scaffold-headers — added x-api-key credential scaffolding to the 18 pre-existing recipes.test.js call sites that exercise the staff/full-detail path, with zero assertion changes, rather than leaving the suite red or rewriting test intent."
  - "Used authTiers.allowKiosk(tier), not allowAdmin(tier), for the staff gate — kiosk devices build recipes at point-of-sale and must keep draft visibility (D-05), unlike the admin-only Internal Only ingredients precedent this pattern was copied from."
  - "GET /api/recipes/:id caches the FULL recipe+ingredients result unconditionally (staff and kiosk depend on it) and only projects to the public shape at response time, rather than caching two shapes per id."

requirements-completed: [D-05, D-06, D-07]

# Metrics
duration: 45min
completed: 2026-09-01
---

# Phase 74 Plan 01: Public recipe read contract Summary

**Closed a live information-disclosure defect on `GET /api/recipes`/`GET /api/recipes/:id` — anonymous callers now get an active-only, cost-field-stripped projection instead of every draft recipe's full ingredient/pricing detail.**

## Performance

- **Duration:** ~45 min (this continuation session, resuming after the Task 1 decision checkpoint)
- **Completed:** 2026-09-01T18:06:09Z
- **Tasks:** 3 (1 decision checkpoint, resolved by developer before this session; 2 auto tasks executed here)
- **Files modified:** 3 (1 created, 2 modified)

## Accomplishments

- `GET /api/recipes?status=all` from an anonymous caller now silently forces `status=active` before the cache key or Apps Script payload is ever built — a query-string edit has no effect (D-06, T-74-03).
- The returned recipe array is re-filtered to `status === 'active'` server-side even on a cache hit — defense-in-depth against a stale/over-broad cached or upstream payload (T-74-01).
- `GET /api/recipes/:id` for a non-active recipe now returns `404 {error:'Recipe not found'}` to a non-staff caller — indistinguishable from a missing recipe, so an id enumerator cannot fingerprint drafts (D-06, T-74-02).
- Every anonymous response record is projected through a positive field allowlist (`toPublicRecipe`) built by copying only `recipe_id`/`name`/`style`/`description`, plus a single fee-inclusive `price` — `ingredients`, `locked_price`, `service_fee`, `materials_fee`, `computed_price`, `pricing_mode`, `notes`, `status`, and all other cost/margin-derivable fields are structurally absent, not merely omitted by convention (D-07, T-74-04).
- Staff and kiosk tiers (`legacy`/`device`/`session` via `authTiers.allowKiosk`) see today's response byte-for-byte, with no regression to BrewPad's recipe builder or the kiosk (D-05).
- New dedicated regression file `recipes-public-guard.test.js` (10 tests) proves the anonymous contract; the pre-existing `recipes.test.js` (36 tests, now 36 with scaffolding) continues to prove the staff/full-detail path with zero assertion changes.

## Task Commits

1. **Task 1: Authorize staff-credential scaffolding on the pre-existing recipes test file** — checkpoint:decision, resolved by the developer (`scaffold-headers`) before this session started. No commit (decision only).
2. **Task 2: RED — regression tests for the public status guard and field allowlist** — `8fdf954c` (test)
3. **Task 3: GREEN — tier-aware status guard and field allowlist on both recipe read routes** — `c9b33f73` (fix)

**Plan metadata:** (this commit, docs — see final commit below)

## Files Created/Modified

- `zoho-middleware/__tests__/recipes-public-guard.test.js` — new file, 10 tests covering D-05 (staff no-regression), D-06 (status guard, list + detail, cache-hit defense-in-depth), D-07 (field allowlist, price collapse, null-price handling)
- `zoho-middleware/routes/recipes.js` — added `PUBLIC_RECIPE_FIELDS`, `toPublicRecipe(recipe)`, `isRecipeStaff(req)`; wrapped `GET /api/recipes` and `GET /api/recipes/:id` handler bodies in `isRecipeStaff(req).then(...)`; `GET /api/recipes/:id/availability` and all POST/PUT/DELETE routes untouched
- `zoho-middleware/__tests__/recipes.test.js` — added `x-api-key: TEST_API_KEY` header + `API_SECRET_KEY` env set/restore to the 18 pre-existing call sites across 5 `describe` blocks (`GET /api/recipes`, `GET /api/recipes/:id`, `GET /api/recipes/:id ingredient group enrichment`, `SCALE-05 ext`, `Phase 73-02`) that exercise the staff/full-detail path; zero `expect(...)` lines added, edited, or removed

## Decisions Made

- **Task 1 checkpoint — `scaffold-headers` (developer-selected, pre-session):** authorized adding `x-api-key` header scaffolding to the 18 pre-existing `recipes.test.js` call sites, with the hard constraint that zero assertions may change. Verified before every commit via `git diff zoho-middleware/__tests__/recipes.test.js | grep -c "^[-+].*expect("` returning 0.
- **`allowKiosk`, not `allowAdmin`:** the staff gate on both GET routes uses `authTiers.allowKiosk(tier)` (true for legacy/device/session) rather than the admin-only `allowAdmin` used by the `catalog.js` Internal-Only-ingredients precedent this pattern was copied from — kiosk devices need draft visibility to build/sell recipes.
- **Full-result caching preserved:** `GET /api/recipes/:id`'s cache continues to store the complete `{recipe, ingredients}` object regardless of caller tier; the field-allowlist projection happens only at response time, so staff/kiosk cache-hit behaviour is byte-identical to before this plan.

## Deviations from Plan

None — plan executed exactly as written, including the pre-authorized test-scaffolding exception from the Task 1 checkpoint.

**One environment-setup step required but not in the plan text:** `zoho-middleware/node_modules` was absent in this fresh worktree (gitignored, never committed). Ran `npm ci` inside `zoho-middleware/` to restore it from the existing `package-lock.json` before any test could execute — this installs zero new/different packages (matches `74-RESEARCH.md`'s "N/A" package-legitimacy audit finding) and is standard dev-environment setup, not a Rule 3 package-manager-install exclusion (no new package was added or substituted).

## Issues Encountered

None beyond the node_modules restoration above.

## User Setup Required

None — no external service configuration required. This is a pure middleware code change; no new environment variables were introduced (`API_SECRET_KEY`/`MW_API_KEY`/`KIOSK_DEVICE_TOKEN` were already required in production per `authTiers.js`/`validateEnv.js`).

## Next Phase Readiness

`GET /api/recipes?status=active` (no auth header) is now safe for plan 74-03's public `/wine` and `/beer` recipe-block fetches to call directly, per this plan's `<interfaces>` contract:
- List: `{ source, recipes: PublicRecipe[], total }` where `PublicRecipe` carries only `recipe_id`/`name`/`style`/`description`/`price`/`price_from`.
- Detail: `{ recipe: PublicRecipe }` with no `ingredients` key.

No blockers for downstream plans in this phase.

## Self-Check: PASSED

- FOUND: `zoho-middleware/__tests__/recipes-public-guard.test.js`
- FOUND: `zoho-middleware/routes/recipes.js`
- FOUND: `.planning/phases/74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split/74-01-SUMMARY.md`
- FOUND commit: `8fdf954c` (test — RED)
- FOUND commit: `c9b33f73` (fix — GREEN)
- FOUND commit: `fbbf9b21` (docs — this summary)

---
*Phase: 74-beer-cider-wine-catalogue-pages-under-ferment-in-store-split*
*Plan: 01*
*Completed: 2026-09-01*

# Phase 97 Rollout Log

Record of the Phase 97 staging rollout (plan 97-11).
Ids, counts and reason codes only; no customer names, contact details or tokens.

## Code gate

Run 2026-11-04 on Node 24.21.0 (the CI and production runtime), main at `5780c0ad` plus the one test fix below. Phase start commit `8a2184d6`.

| Suite | Result |
|-------|--------|
| Frontend `npm test` | first run 247 / 248 suites (2 tests failed); after fix 248 suites / 3391 tests passed |
| Frontend `npm run lint` | clean |
| `npm run build` | artifacts current: the only diffs were BUILD_TIMESTAMP and ?v= cache-bust stamps (html, js/admin.js, js/admin.min.js); js/main.js, js/main.min.js, js/brewpad.min.js, js/kiosk-core.min.js and css/*.min.css unchanged. Stamps discarded |
| Middleware `npm test` | 298 suites / 4048 tests passed |
| Middleware `npm run lint` | clean |
| Middleware `npm run migrate:guard` | guard and allowlist: 9 files additive-only OK |
| Middleware `npm run test:db` (Docker running) | run 1: 55 suites, 2 failed (53 passed), 453 / 455 tests passed. Failing suites rerun alone: same 2 fail, so not load flake |

### Fix made at the gate (Phase 97 test, not pre-existing)

`tests/frontend/brewpad-dashboard-v2-packcal.test.js` (added by 97-08) asserted Vancouver time labels using November timestamps and PST expectations (22:30Z = 2:30 pm). On Node 24 with tzdata 2026c (BC permanent UTC-7) that reads 3:30 pm, so 2 tests failed in CI-equivalent runs. The three timestamps now use July instants, where both tzdata generations agree (PDT). Passes on Node 20.20 and Node 24.21. No behavior change.

### Open gate failure: two existing DB migration tests

Both fail deterministically because Phase 97 added migration 0009, which changes what "down N" rolls back:

- `zoho-middleware/__tests__/db/batches-type-migration.test.js` L79 `migrate('down', 2)` now rolls back 0009 and 0008, leaving the 0007 columns in place (expected 0 rows, got 3). Needs `down 3`.
- `zoho-middleware/__tests__/db/batches-staff-migration.test.js` L71 `migrate('down', 1)` now rolls back only 0009 (expected 0 rows, got 1). Needs `down 2`.

These are existing tests; CLAUDE.md rule 10 forbids editing them without owner approval, and that approval is not yet recorded. The new migration 0009 test suite passes. Status: awaiting owner decision.

## Pre-existing test edits

1. `zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json` (97-01): added `target_og` and `target_fg` keys to every recipe object, because RECIPE_COLUMNS gained two keys. Owner-approved (plan OWNER-OK-TESTS; re-confirmed 2026-11-04 in session).
2. `tests/frontend/brewpad-dashboard-v2-production.test.js` L195-217 (97-07): the section-shell test "four headed sections..." renamed "six headed sections...", with titles, hints, slots and the `bp-dash-full` id loop updated to the six-section order. Owner-approved 2026-11-04 in session.

No other existing test was modified. Pending approval (see above): the two DB migration tests.

## Folded todos

- `brewpad-dashboard-v2-restore-tasks-and-ready-to-bottle` moved to done (resolved by 97-07).
- `brewpad-ready-to-bottle-filter` moved to done (resolved by 97-10).
- `calcom-beer-packaging-appointment` stays pending until 97-12.

## CSP check

`git diff 8a2184d6..HEAD -- '*.html'` touches brewpad.html and kiosk.html only; the number of lines mentioning content-security-policy is 0. No third-party domain added (Cal.com is server-side). No CSP change needed.

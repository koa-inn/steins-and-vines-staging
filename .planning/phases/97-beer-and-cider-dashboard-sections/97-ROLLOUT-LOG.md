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

These are existing tests; CLAUDE.md rule 10 forbids editing them without owner approval. Status: RESOLVED 2026-11-04. Owner approved the edit in session (orchestrator relay); both rollback counts were bumped in a separate commit, and the rerun of `npm run test:db` passed: 55 / 55 suites, 455 / 455 tests (Node 24.21, Docker).

## Pre-existing test edits

1. `zoho-middleware/__tests__/fixtures/recipes-sheet-shape.json` (97-01): added `target_og` and `target_fg` keys to every recipe object, because RECIPE_COLUMNS gained two keys. Owner-approved (plan OWNER-OK-TESTS; re-confirmed 2026-11-04 in session).
2. `tests/frontend/brewpad-dashboard-v2-production.test.js` L195-217 (97-07): the section-shell test "four headed sections..." renamed "six headed sections...", with titles, hints, slots and the `bp-dash-full` id loop updated to the six-section order. Owner-approved 2026-11-04 in session.

3. `zoho-middleware/__tests__/db/batches-type-migration.test.js` (`down 2` -> `down 3`) and `zoho-middleware/__tests__/db/batches-staff-migration.test.js` (`down 1` -> `down 2`): rollback counts coupled to the latest migration, shifted by 0009. Owner-approved 2026-11-04 in session.

No other existing test was modified.

## Staging push decision

Owner answered **push** on 2026-11-04 in session (orchestrator relay), after the DB gate went green.

## Folded todos

- `brewpad-dashboard-v2-restore-tasks-and-ready-to-bottle` moved to done (resolved by 97-07).
- `brewpad-ready-to-bottle-filter` moved to done (resolved by 97-10).
- `calcom-beer-packaging-appointment` stays pending until 97-12.

## CSP check

`git diff 8a2184d6..HEAD -- '*.html'` touches brewpad.html and kiosk.html only; the number of lines mentioning content-security-policy is 0. No third-party domain added (Cal.com is server-side). No CSP change needed.

## Staging deploy

Date: 2026-11-04. Production untouched (production/main still 53484bdf).

| Item | Result |
|------|--------|
| SHA pushed to origin main | c0fef5ee (from 8a2184d6) |
| GitHub Pages staging run | 41901696887 — success |
| Tests workflow run | 41901696843 — failed only on middleware `npm audit` (minimatch/glob, 1 high); pre-existing, also failed at 8a2184d6; tracked separately |
| Railway staging deployment | f5204c4e-c42e-45dc-b57c-87d98b4ba4ff — SUCCESS |
| Migration 0009_recipes_target_gravity | applied by preDeploy migrate; guard + allowlist 9 files OK |
| information_schema (recipes) | target_og numeric nullable YES; target_fg numeric nullable YES |
| GET /health | status ok, authenticated true, database true, database_required true |

### Payload leak check (owner signed in, brewpad.html?dash=v2)

| Route | HTTP | at-sign count | customer_ key | recipe_snapshot | Counts |
|-------|------|-----------|---------------|-----------------|--------|
| /api/admin/dashboard-cards | 200 | 0 | no | no | ok true, 39 cards, 3 canning constants |
| /api/admin/packaging-bookings | 200 | 0 | no | no | ok true, 0 bookings, truncated false |

Result: PASS.

## Owner steps

Done by the owner in-session, 2026-11-04. Claude made read-only checks only.

| Step | Result |
|------|--------|
| Staging Railway env | CALCOM_EVENT_TYPE_BEER_PACKAGING 6028745 added; CALCOM_EVENT_TYPE_BEER_WAITLIST 6955754 already set. Deployment 7e4520e5-2ce4-4e28-b1bc-660b1e416783 SUCCESS |
| Production Railway env | CALCOM_EVENT_TYPE_BEER_PACKAGING 6028745 added (stored with a leading space; Number() parses it, harmless, tidy optional); WAITLIST already set. Deployment 540dd4ae-1476-4a67-8fb3-06835adce23d SUCCESS (restart of current build, no code change) |
| Production /health after restart | 2026-11-04T21:22:45Z: status ok, authenticated true, database true, redis true |
| Production /api/bookings/services | 3 services on two consecutive calls, beer consult type listed |
| Apps Script adminApi.gs | redeployed by owner as a new version of the existing web-app deployment; new version 66, previous (rollback) 65 |
| Live Cal.com list (staging, header 2026-05-01) | '[packaging-bookings] ok bookings=0 matched=0 truncated=false' at 21:11Z (before BEER_PACKAGING was set); first uncached call took about 17 s |

## Staging UAT

Claude-piloted in the owner's signed-in Chrome tab, 2026-11-04 (read-only except where noted). Owner items still open are marked OWNER.

| # | Item | Result |
|---|------|--------|
| 1 | Section order + Today hint | PASS: Today, Production, Floor today, Beer & cider, Products & sales, Data health; hint text exact |
| 2 | Today's tasks / Ready to bottle | PASS for display: 12 tasks, all overdue rows first with "Overdue"; Ready to bottle (8) with Send Invite where an email exists. Tick-to-save not exercised (writes staging data): OWNER |
| 3 | Packaging calendar | PASS for load: "Nothing booked or due in the next 14 days", no error note; '[packaging-bookings] ok bookings=0 matched=0 truncated=false'. Day grouping not observable with no entries (covered by jsdom tests) |
| 4 | Type filter | PASS: Wine hides Beer & cider, Today unchanged; Beer shows beer cards only |
| 5 | Beer & cider cards | PASS: SV-B-000229 shows Style/ABV/IBU, latest °P, Temp step pill "due today", 25 L and can counts; cider SV-B-000234 shows Juice/Yeast/ABV and "late" on a past step; readings curve opens and closes |
| 6 | Recipe Target OG/FG | PASS for validation: OG 50 rejected with the 2..40 message. Save-and-persist (12/3) not exercised (writes a staging recipe): OWNER |
| 7 | Ready to Bottle (N) chip | PASS: Batches chip reads Ready to Bottle (8), same as the dashboard widget |
| 8 | iPad portrait | SKIPPED (optional) |
| 9 | Booking match | PASS 2026-11-05 20:17Z: test Beer Packaging booking (kind canning) linked to SV-B-000250; log "[packaging-bookings] ok bookings=1 matched=1". First attempt correctly returned no batch: the email was shared by 4 active batches with no packaging date (D-03 never-guess). Test booking cancelled by owner 2026-11-05 (confirmed) |

Owner follow-up 2026-11-05: item 2 tick-to-save PASS; item 6 Target OG 12 / FG 3 save and reopen PASS (owner-reported).

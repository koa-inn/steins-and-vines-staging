---
phase: 97-beer-and-cider-dashboard-sections
verified: 2026-11-05T21:00:00Z
status: passed
score: 4/4 roadmap success criteria verified (plus 12/12 plan must-have groups spot-checked)
overrides_applied: 0
gaps: []
human_verification: []
---

# Phase 97: Beer and cider dashboard sections - Verification Report

**Phase Goal:** Beer and cider have their own dashboard sections and batch cards, and staff can see the next two weeks of bottling and canning.
**Scope:** Staging only. The production code release is deliberately out of scope. Production received only the Cal.com env var plus a restart, and /health there showed authenticated:true.
**Re-verification:** No, initial verification.

## Requirements traceability

REQUIREMENTS.md does not list Phase 97 IDs. ROADMAP says "Requirements: TBD. Handoff Phase D". Traceability therefore uses the plans' `requirements:` frontmatter against the 97-CONTEXT.md decisions (D-01..D-16, SC1..SC4, TODO-*). All IDs claimed by plans 97-01..12 resolve to a CONTEXT decision or roadmap SC. No orphaned IDs were found.

## Observable Truths (roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC1 | Beer card shows style, ABV, IBU, OG vs target FG with latest reading, and the current step including temperature steps | VERIFIED | `js/brewpad.js` has pure card builders (~L477, 'No readings yet' L610) and render (~L9410-9494, "Temp step" pill L9454). The widget `bc` is registered at L8300 and the section at L8601. `/api/admin/dashboard-cards` exists in `routes/brewpad-dashboard.js`. Staging UAT 5: SV-B-000229 showed all of these with a Temp step pill. |
| SC2 | Packaging output in cans and litres (25 L per 28 L brew) | VERIFIED | Canning constants are served from `lib/kiosk-bundles.js` through the cards route, so the browser does not retype them. UAT 5 showed 25 L and can counts. Covered by `brewpad-dashboard-v2-beer-cider.test.js`. |
| SC3 | Cider section shows juice or recipe, yeast and the readings curve | VERIFIED | The cards route picks juice and yeast by type from the snapshot. UAT 5: cider SV-B-000234 showed Juice, Yeast and ABV, and the curve opened and closed. The G8 builder is reused (L8113). |
| SC4 | 2-week packaging calendar lists bottling for wine/cider and canning for beer | VERIFIED | `lib/calcom.js` `listBookings` with `CAL_VERSIONS.bookingsList = '2026-05-01'`. `lib/packaging-bookings.js` plus the `/api/admin/packaging-bookings` route. A webhook cache bump is in `routes/webhooks.js`. The frontend 'Packaging calendar' widget `t3` is at L8296 and L9354. The live Cal.com match was proven on staging (SV-B-000250, kind canning, matched=1). The empty-state and fail-soft paths were seen in UAT 3. Day grouping is covered by jsdom tests only, because the live window was empty. |

**Score:** 4/4

## Plan-level must-haves (spot checks)

| Area | Status | Evidence |
|------|--------|----------|
| D-06 target_og/target_fg: migration 0009, store, validation (400 invalid_target_gravity), editor inputs, snapshot copy | VERIFIED | `migrations/0009_recipes_target_gravity.sql`. `lib/recipe-pg.js` has the keys and normalisation. Pair validation is in `routes/recipes.js`. The kiosk snapshot (`pos-recipe.js`) writes `og` and `target_fg`. The editor has `#bp-recipe-target-og` and `-fg` inputs. The staging columns were confirmed via information_schema. Owner confirmed a 12/3 save and reopen. |
| Apps Script mirror (97-12) | VERIFIED | `ensureRecipesTargetGravityColumns` is in `apps-script/adminApi.gs`. It was deployed as version 66 with rollback 65, per the rollout log. |
| Folded todo: Beer Packaging Cal.com type | VERIFIED | The env var is registered in `validateEnv.js`. `routes/bookings.js` has an `ids` entry and a `beer-packaging` selector that fails closed with 503. It is set on staging and production. Production /health is authenticated:true. |
| D-13..D-16 Today section, six-section order, filters ignored, Wine hides Beer & cider | VERIFIED | Section config at L8601. UAT 1 and 4 passed. |
| TODO ready-to-bottle filter | VERIFIED | `readyToBottleList()` at L9160 is the single source for the filter (L9166, chip L9916) and the widget. UAT 7: the chip shows (8), matching the widget. |
| D-03 email match, never guess | VERIFIED | Live UAT 9: the first attempt correctly gave "no batch" with 4 ambiguous batches. The second matched SV-B-000250. |
| Privacy: no email, customer_*, or recipe_snapshot in responses | VERIFIED | The rollout log leak check on staging showed at-sign count 0 for both routes. |
| Build artifacts current | VERIFIED | The rollout log shows the build produced no artifact diffs. Frontend `tests/` suites pass. |

## Behavioral spot-checks (re-run now)

| Check | Result |
|-------|--------|
| `npx jest tests/frontend/brewpad-dashboard-v2*` | PASS: 19 suites, 396 tests |
| Middleware suite via Node 24 (the filter matched every test path, so it was the full suite) | PASS: 298 suites, 4048 tests |
| Recorded gate (97-11): DB suite 55/455, lint clean, migrate:guard OK | Recorded in the rollout log. Not re-run, as instructed. |

## Anti-patterns

Searched `js/brewpad.js` for TBD/FIXME/XXX. The matches are all pre-existing domain text ("Bottling date TBD", INV-XXXXXX placeholders), not debt markers. No blockers.

## Notes (non-blocking)

- Three existing tests were edited with explicit owner approval, all logged in the rollout log: the recipes fixture, the section-shell test, and the two migration down-counts. This was compliant with CLAUDE.md rule 10.
- The GitHub Tests workflow fails only on the pre-existing middleware `npm audit` (minimatch/glob). It is tracked separately and is not caused by Phase 97.
- The production env var BEER_PACKAGING is stored with a leading space. `Number()` parses it, so this is harmless. Tidying is optional.
- UAT 8 (iPad portrait) was skipped as optional. Phase 99 owns responsiveness.
- Production code release is pending by design, so the phase goal is achieved on staging only.
- 97-REVIEW.md is being written by another agent and was not consulted.

## Human verification

None outstanding. The owner items (tick-to-save, recipe save/reopen) were confirmed on 2026-11-05.

## Gaps Summary

No gaps. All four success criteria and the plan must-haves are backed by code, tests and live staging evidence.

_Verified: 2026-11-05_
_Verifier: Claude (gsd-verifier)_

---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 10
subsystem: ui
tags: [admin-panel, vanilla-js, es5, gap-closure]

requires:
  - phase: 81-06
    provides: "countRecipesUsingSchedule(scheduleId) and the D-15 blast-radius note in renderScheduleForm"
provides:
  - "ensureRecipeListForBlastRadius(cb) -- guaranteed, idempotent _recipesState.list load before the schedule template edit modal renders"
  - "openEditScheduleModal routed through the guarantee so the D-15 note renders on the direct Batches -> Schedule Templates path, not only after visiting Recipes first"
affects: [81-09]

tech-stack:
  added: []
  patterns:
    - "Choke-point load guarantee (fetch-then-callback, always-callback-on-catch) placed immediately before the render that needs the data, rather than a tab-visit pre-warm that would still race the click"

key-files:
  created:
    - tests/frontend/admin-schedule-blast-radius.test.js
  modified:
    - js/admin.js

key-decisions:
  - "Load site chosen was openEditScheduleModal itself (the choke point), not a Batches-tab or sub-tab pre-warm -- a pre-warm makes the warning usually right, which is a race and untestable; the choke point makes it unconditionally right, at the cost of one round-trip on the first edit-modal open of a session"
  - "Status resolution in ensureRecipeListForBlastRadius mirrors loadRecipeList exactly (#recipes-status-filter value if the element exists and is non-empty, else 'all') so both navigation paths count the same population"
  - "_recipesState.list is assigned only if still empty on fetch success, so a Recipes-tab load that resolves in the meantime is never stomped"

requirements-completed: [OPS-05]

duration: ~15min (Tasks 1-2 only; Task 3 outstanding)
completed: 2026-09-06
---

# Phase 81 Plan 10: GAP-01 blast-radius note load-order fix Summary (Tasks 1-2 of 3)

**`ensureRecipeListForBlastRadius(cb)` guarantees `_recipesState.list` can answer the D-15 recipe count before the schedule template edit modal renders, closing the load-order gap where the "Used by N public recipes" warning silently failed to appear on the direct Batches → Schedule Templates path.**

**This plan is NOT complete.** Tasks 1 and 2 (the regression test and the fix) are done, committed, and verified. Task 3 is a `checkpoint:human-verify` staging re-verification that requires a rebuilt `admin.min.js` deployed to `staging.steinsandvines.ca` and a live browser session — outside this execution's scope. See "Task 3 — Outstanding" below.

## Performance

- **Tasks 1-2 duration:** ~15 min (commit timestamps: 07:19 plan checkout → 07:34 Task 2 commit)
- **Completed (Tasks 1-2):** 2026-09-06
- **Tasks:** 2 of 3 completed
- **Files modified:** 2 (js/admin.js, tests/frontend/admin-schedule-blast-radius.test.js)

## Accomplishments

- Reproduced GAP-01 with a 5-test jsdom regression suite exercising the real `openEditScheduleModal` → `renderScheduleForm` path against a real DOM fixture; 2 of the 5 tests failed before the fix, for the correct reason (missing note text, not a TypeError or DOM error)
- Implemented `ensureRecipeListForBlastRadius(cb)`, colocated with `countRecipesUsingSchedule`, exactly to the plan's 5-behaviour contract: synchronous no-op when the list is already populated, `cb()` immediately if middleware isn't configured, otherwise a scoped `/api/recipes?status=...` fetch (same status resolution as `loadRecipeList`) that only assigns `_recipesState.list` if still empty, with `cb()` guaranteed on both success and `.catch`
- Routed `openEditScheduleModal` through the guarantee (`renderScheduleForm(sched)` now runs inside the callback); `openCreateScheduleModal` is untouched, as specified

## Task Commits

1. **Task 1: Reproduce GAP-01 with a failing jsdom regression test** — `b732b235` (test)
2. **Task 2: Guarantee the recipe list is loaded before the template edit modal renders** — `cc5637b3` (fix)

**Plan metadata:** commit pending (this SUMMARY; STATE/ROADMAP not touched per worktree isolation — orchestrator owns those)

## Files Created/Modified

- `tests/frontend/admin-schedule-blast-radius.test.js` (new) — 5 jsdom tests: the GAP-01 regression (`Recipes tab never opened`), singular/plural, zero-attached template, idempotence (no fetch when list already loaded), and non-fatal fetch-failure behavior
- `js/admin.js` — `ensureRecipeListForBlastRadius(cb)` (new, placed immediately after `countRecipesUsingSchedule`); `openEditScheduleModal` now calls `ensureRecipeListForBlastRadius(function () { renderScheduleForm(sched); })`; `openEditScheduleModal` added to the existing test-export block (Task 1, test seam only)

## Observed Task 1 RED Output

Before Task 2's fix, the two regression tests failed with the exact expected-wrong-reason failure (not a TypeError, not a missing-DOM error):

```
✕ REGRESSION — Recipes tab never opened: the note still renders the count on the direct Batches -> Schedule Templates path (15 ms)
✕ Singular — a template used by exactly one recipe reads "1 public recipe" with no trailing s (4 ms)
✓ Zero-attached template renders no note (4 ms)
✓ Idempotence — a list already populated (Recipes tab visited first) issues no fetch (3 ms)
✓ Non-fatal — the modal still opens when the recipe fetch fails (3 ms)

● REGRESSION — Recipes tab never opened...
  expect(received).toContain(expected) // indexOf
  Expected substring: "Used by 2 public recipes"
  Received string:    "Template NameDescriptionCategory...Update Template"
    at toContain (tests/frontend/admin-schedule-blast-radius.test.js:157:32)

● Singular — a template used by exactly one recipe...
  expect(received).toContain(expected) // indexOf
  Expected substring: "Used by 1 public recipe"
  Received string:    "Template NameDescriptionCategory...Update Template"
    at toContain (tests/frontend/admin-schedule-blast-radius.test.js:168:32)

Tests: 2 failed, 3 passed, 5 total
```

After Task 2: all 5 pass (`Tests: 5 passed, 5 total`).

## Load-Site Tradeoff As Implemented

Matches the plan's chosen approach exactly: the load guarantee sits in `openEditScheduleModal` (the sole caller of `renderScheduleForm` that renders the D-15 note), not on a Batches-tab visit or the Schedule Templates sub-tab handler. Both rejected alternatives were races against the click; this is the choke point, so the warning is unconditionally correct rather than usually correct. Cost accepted: the first template-edit modal open of a session waits one round-trip (~200-500ms, no spinner) — identical to the tradeoff 81-06 already took for `openScheduleActivateModal`.

## T-81-10-02 Observation (pre-existing, out of scope, not fixed here)

Per the plan's threat register: `renderScheduleForm`'s `existing.name` / `existing.description` interpolation (`js/admin.js:7677-7678`, unchanged by this plan) is unescaped HTML built with string concatenation. This is pre-existing, staff-authored input (not attacker-facing), not introduced or widened by this plan's change, and explicitly marked "do not touch" in the plan's scope. Recorded here per the plan's `<output>` instruction; no code change made.

## Decisions Made

See `key-decisions` in frontmatter above — all three were specified by the plan's `<the_fix>` contract and implemented verbatim, not new decisions made during execution.

## Deviations from Plan

### Environment restoration (not a code deviation)

**zoho-middleware/node_modules was absent in this worktree.** Worktrees do not include gitignored `node_modules`; the main repo checkout already had `zoho-middleware/node_modules` installed (498 packages) but this worktree did not. Ran `npm ci` inside `zoho-middleware` — confirmed byte-identical `package-lock.json` (md5 match against the main repo) before doing so, so this restores the exact locked dependency tree already vetted and installed elsewhere in this project, not a new or different package. No `package.json` or `package-lock.json` change; nothing committed from this (node_modules is gitignored). This was required to run the middleware test gate CLAUDE.md mandates before every commit.

No other deviations. Both code tasks executed exactly as written in the plan's `<the_fix>` contract.

## Verification Evidence

```
npx jest tests/frontend/admin-schedule-blast-radius.test.js   # 5 passed, 5 total
npm test                                                      # 1683/1683 passing (110 suites) -- baseline 1678 + 5 new
cd zoho-middleware && npm test                                # 1603/1603 passing (107 suites) -- unchanged from baseline
npm run lint                                                  # clean
cd zoho-middleware && npm run lint                             # clean
```

Invariants confirmed:
```
grep -v '^\s*//' js/admin.js | grep -c "ensureRecipeListForBlastRadius"   # 2
grep -c "loadRecipeList()"    js/admin.js                                 # 5 (unchanged)
grep -c "renderRecipeList()"  js/admin.js                                 # 3 (unchanged)
grep -c "availability-banner--low" js/admin.js                            # 2 (unchanged)
git status --porcelain js/admin.min.js                                    # no output
git diff --stat HEAD~1                                                    # js/admin.js only (Task 2 commit)
```

## Issues Encountered

None beyond the node_modules environment restoration noted above.

## User Setup Required

None for Tasks 1-2 — no external service configuration required.

## Task 3 — Outstanding (blocking checkpoint, not executed)

**Task 3: Re-verify the D-15 note on staging via the original failure path** (`type="checkpoint:human-verify" gate="blocking"`) was explicitly out of scope for this execution per the orchestrator's instructions and requires:

1. The orchestrator to run `npm run build` (regenerating `js/admin.min.js`) and `git push origin main` to staging — this execution deliberately did NOT run `npm run build` or stage `js/admin.min.js`, per the plan's instruction that the orchestrator owns that rebuild.
2. A human to open a fresh private browser window, log in to Admin on `staging.steinsandvines.ca`, and re-run the exact 81-08 reproduction in reverse (8 steps: direct Batches → Schedule Templates → edit FS-0010 → expect "Used by 2 public recipes...", then FS-0008 singular, then New Template no note, then a zero-attached template no note, then confirm amber styling and that Update Template still saves).

**This plan is not marked complete.** GAP-01 remains open until Task 3's staging verification passes. Plan 81-09 (production cutover) remains blocked until then.

## Next Phase Readiness

- Tasks 1-2 are self-contained; no downstream plan depends on further code changes here
- Task 3 blocks plan 81-09 (production cutover) — orchestrator must rebuild + deploy to staging, then pilot the Task 3 checkpoint
- No other blockers

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Tasks 1-2 completed: 2026-09-06 — Task 3 outstanding*

## Self-Check: PASSED

- FOUND: js/admin.js
- FOUND: tests/frontend/admin-schedule-blast-radius.test.js
- FOUND: .planning/phases/81-recipe-fermentation-timeline-give-customers-an-expected-read/81-10-SUMMARY.md
- FOUND (git log): b732b235, cc5637b3

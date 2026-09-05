---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 05
subsystem: ui
tags: [admin-panel, vanilla-js, es5, beerxml, forms]

# Dependency graph
requires:
  - phase: 81-02
    provides: "maxNonPackagingOffset(schedule) -> number|null (Node original) in zoho-middleware/routes/recipes.js, plus the pre-written cross-reference comment anticipating this plan's browser copy"
  - phase: 81-04
    provides: "#recipe-schedule-select, #recipe-schedule-warning DOM ids and buildScheduleOptionsHtml(selectedId) helper in the recipe editor form"
provides:
  - "parsed.ferment_days_beerxml : number -- display-only BeerXML fermentation-vessel timing total, omitted entirely when the file made no claim"
  - "Browser copy of maxNonPackagingOffset(schedule) in js/admin.js, cross-referencing the Node original"
  - "#beerxml-schedule-select / #beerxml-schedule-compare in the BeerXML review modal (D-12/D-13/D-14)"
  - "confirmBeerXMLImport carries the chosen schedule_id into populateRecipeForm, closing a verified silent-discard defect"
affects: [81-06]

tech-stack:
  added: []
  patterns:
    - "Read a modal <select>'s value into a local variable BEFORE calling closeModal() -- closeModal may tear down the modal body, after which the element is gone"
    - "Duplicate a pure derivation function across two runtimes (Node + browser) rather than share a module, with a mandatory cross-reference comment on BOTH copies naming the other's file:line"

key-files:
  created: []
  modified:
    - js/admin.js
    - css/admin.css
    - tests/frontend/admin-beerxml.test.js

key-decisions:
  - "ferment_days_beerxml assigned only when PRIMARY_AGE+SECONDARY_AGE+TERTIARY_AGE sums to a value > 0 -- a zero total is indistinguishable from no claim (matches parseBeerXML's own || 0 + presence-guard convention for abv/batch_size_l)"
  - "AGE is never read -- per the BeerXML 1.0 spec it is post-bottling conditioning time, out of scope per D-01 since it happens after our handoff and is unverifiable"
  - "buildScheduleOptionsHtml('') called with an always-empty selectedId in the review modal -- D-13 hard requirement that nothing is pre-selected, no matter how close a template's offset is to the file's claim; its own leading 'None' option is stripped in favor of 'No schedule (add later)' wording"
  - "D-14 comparison line uses textContent (never innerHTML) and no warning-colour CSS tokens -- a human reads both numbers and decides, the UI must not pre-judge"
  - "confirmBeerXMLImport reads #beerxml-schedule-select.value into a local var BEFORE closeModal() -- ordering is load-bearing since closeModal may tear the modal DOM down first"
  - "Added minimal test-only exports (showBeerXMLReviewModal, confirmBeerXMLImport, _setFermSchedulesDataForTest) rather than exporting every touched helper -- jest-environment-jsdom does not allow overriding the global document, so these functions' real DOM side effects are verified against genuine jsdom elements built by a shared resetAdminDomFixture() helper"

patterns-established:
  - "resetAdminDomFixture() -- a real-jsdom DOM fixture (not a document.getElementById mock) for admin-panel tests that exercise openModal/populateRecipeForm-style functions; the file's existing top-of-file document mock is inert under jest-environment-jsdom (confirmed by direct probe: document.constructor.name === 'Document') and was already unused by every pre-existing test in this file"

requirements-completed: [OPS-05]

# Metrics
duration: ~35min
completed: 2026-09-05
---

# Phase 81 Plan 05: BeerXML review modal fermentation timeline (D-12/D-13/D-14) Summary

**BeerXML import review now states the file's own fermentation-vessel timing claim, lets staff attach a schedule template with both numbers shown side-by-side in neutral text (never pre-selected), and carries that choice through Confirm Import into the recipe editor's picker -- closing a verified silent-discard defect where the dropdown was previously decorative.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 completed
- **Files modified:** 3 (js/admin.js, css/admin.css, tests/frontend/admin-beerxml.test.js)

## Accomplishments
- `parseBeerXML` sums `PRIMARY_AGE`/`SECONDARY_AGE`/`TERTIARY_AGE` into `parsed.ferment_days_beerxml` (display-only, present only when > 0); `AGE` is never read (D-01: post-packaging conditioning is out of our handoff)
- Review modal's meta-line gains a `BeerXML: N days ferment` segment following the existing join idiom, omitted entirely when the file made no claim
- Browser copy of `maxNonPackagingOffset(schedule)` added to `js/admin.js:9377`, cross-referencing the Node original at `zoho-middleware/routes/recipes.js:174` (that file's comment already pointed here, pre-written by plan 81-02 in anticipation of this plan)
- Review modal gains a recipe-level schedule dropdown (`#beerxml-schedule-select`) above the ingredient table, reusing plan 81-04's `buildScheduleOptionsHtml('')` with nothing pre-selected (D-13), plus a neutral D-14 comparison line (`#beerxml-schedule-compare`, `textContent` only, `--ink-secondary`, no warning tokens)
- `confirmBeerXMLImport` now reads the modal's schedule choice before `closeModal()` tears the modal DOM down, and carries `schedule_id: chosenScheduleId || ''` into `populateRecipeForm` -- without this, Task 2's dropdown was a verified no-op: staff choices were silently discarded on Confirm Import with no error

## Task Commits

Task 1 was `tdd="true"` (RED -> GREEN); Tasks 2 and 3 were standard `auto` commits:

1. **Task 1: Extract BeerXML fermentation timing as a display-only total**
   - `2771738d` test(81-05): add failing test for BeerXML fermentation timing extraction (verified RED: 6/8 new cases failed against pre-implementation admin.js)
   - `2e5fd32b` feat(81-05): extract BeerXML fermentation timing as a display-only total
2. **Task 2: Template dropdown in the review modal with the D-14 side-by-side comparison**
   - `b808c44d` feat(81-05): template dropdown in the BeerXML review modal with D-14 comparison
3. **Task 3: Carry the chosen template through Confirm Import into the recipe form**
   - `a25fa261` fix(81-05): carry the chosen fermentation schedule through Confirm Import

**Plan metadata:** (this commit, following SUMMARY)

## Files Created/Modified
- `js/admin.js` -- `parseBeerXML` gains the `ferment_days_beerxml` derivation; `showBeerXMLReviewModal` gains the meta-line segment, the schedule dropdown + D-14 change listener, and a browser copy of `maxNonPackagingOffset`; `confirmBeerXMLImport` reads the modal's schedule choice before `closeModal()` and carries it through; module.exports gains three test-only hooks (`showBeerXMLReviewModal`, `confirmBeerXMLImport`, `_setFermSchedulesDataForTest`)
- `css/admin.css` -- one new rule, `.beerxml-schedule-compare` (font-size 13px, `--ink-secondary`, `margin-top: var(--sp-1)`; no warning tokens, no border, no background)
- `tests/frontend/admin-beerxml.test.js` -- new `describe` blocks for `parseBeerXML` fermentation timing (6 cases), the review modal's meta-line segment (2 cases), and the Confirm Import carry-through (3 cases); a shared `resetAdminDomFixture()` helper for tests that exercise DOM-touching admin.js functions

## Decisions Made
See `key-decisions` in frontmatter above. The most consequential one for future editors: **the pre-existing `global.document = {...}` mock at the top of this test file is inert under `jest-environment-jsdom`** -- direct probing during Task 1 confirmed `document.constructor.name === 'Document'` (the real jsdom Document, not the custom mock object) even immediately after the assignment runs. Every pre-existing test in this file happened to avoid exercising that gap because `parseBeerXML`/`autoMatchIngredients` never touch `document`. This plan's new tests are the first in the file to call DOM-touching functions (`showBeerXMLReviewModal`, `confirmBeerXMLImport`), so they use a real-jsdom fixture (`resetAdminDomFixture()`) instead of relying on the dead mock. The mock itself was left untouched (out of scope, pre-existing, affects only this one file) -- flagged here for whoever next writes a DOM-touching test in this file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Ran `npm ci` in zoho-middleware for this fresh worktree checkout**
- **Found during:** Task 2 verification (`npm test` inside `zoho-middleware`)
- **Issue:** Neither this worktree's `zoho-middleware/node_modules` nor its root `node_modules` existed; the root suite passed anyway because Node's module resolution walked up through the worktree's parent directories and found the main repo checkout's root `node_modules`, but `zoho-middleware` has its own separate dependency tree (per CLAUDE.md) that isn't reachable that way
- **Fix:** Ran `npm ci` inside `zoho-middleware` (lockfile-pinned install, not a new/unverified package -- excluded from Rule 3's package-install carve-out per the same reasoning documented in plan 81-02's SUMMARY)
- **Verification:** `cd zoho-middleware && npm test` -- 107/107 suites, 1603/1603 tests, all green
- **Not committed:** `node_modules/` is gitignored; no commit needed

**2. [Rule 3 - Blocking] Discovered and worked around a pre-existing dead DOM mock in the test file**
- **Found during:** Task 1, first attempt at the meta-line test (`showBeerXMLReviewModal` crashed with `TypeError: Cannot set properties of null`)
- **Issue:** The file's top-of-file `global.document = {...}` mock does not take effect under this project's `jest-environment-jsdom` config -- confirmed by direct probe (`document.constructor.name === 'Document'`, the real jsdom singleton). Every function this plan's new tests exercise (`showBeerXMLReviewModal`, `confirmBeerXMLImport` -> `openRecipeDetail` -> `populateRecipeForm` -> `renderScheduleWarning`/`renderIngredientRows`) touches real DOM ids that don't exist in an empty jsdom document
- **Fix:** Added `resetAdminDomFixture()`, a real-jsdom fixture providing exactly the ids these code paths read/write (modal scaffold, recipe-editor form fields, recipes-list/detail view containers). Did NOT attempt to "fix" the existing dead mock at the top of the file -- that's pre-existing, affects no other test in the suite today, and touching it is out of this plan's scope (documented instead, see Decisions Made above)
- **Files modified:** tests/frontend/admin-beerxml.test.js
- **Verification:** All 32 tests in the file pass against real jsdom elements
- **Committed in:** `2771738d` (Task 1 RED commit) / `a25fa261` (Task 3, reusing the same fixture)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking, both test-infrastructure, zero production-code scope creep)
**Impact on plan:** No change to shipped behavior or acceptance criteria. Both fixes were necessary to make the plan's own required tests executable at all.

## Issues Encountered
None beyond the two deviations above (both were blocking issues resolved in-flight, documented as deviations rather than left open).

## User Setup Required
None -- no external service configuration required. Zero Apps Script changes (this plan's only edit outside `js/`/`css/`/`tests/` would have been a comment update in `zoho-middleware/routes/recipes.js`, and that comment was already correct from plan 81-02, so no edit was needed there).

## Next Phase Readiness
- Plan 81-06 (D-15 customer-facing copy) is unaffected by this plan -- this plan is entirely staff-side (admin BeerXML import), no public-facing surface touched
- Both `maxNonPackagingOffset` copies are now in place and cross-referenced: Node original at `zoho-middleware/routes/recipes.js:174`, browser copy at `js/admin.js:9377` -- any future editor changing the "exclude packaging, take the max" rule must update both
- No blockers

---
*Phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read*
*Completed: 2026-09-05*

## Self-Check: PASSED

- FOUND: js/admin.js
- FOUND: css/admin.css
- FOUND: tests/frontend/admin-beerxml.test.js
- FOUND: .planning/phases/81-recipe-fermentation-timeline-give-customers-an-expected-read/81-05-SUMMARY.md
- FOUND commit: 2771738d (test(81-05): add failing test for BeerXML fermentation timing extraction)
- FOUND commit: 2e5fd32b (feat(81-05): extract BeerXML fermentation timing as a display-only total)
- FOUND commit: b808c44d (feat(81-05): template dropdown in the BeerXML review modal with D-14 comparison)
- FOUND commit: a25fa261 (fix(81-05): carry the chosen fermentation schedule through Confirm Import)

---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 04
subsystem: ui
tags: [brewpad, waitlist, es5, jsdom, customer-link, recipe-attach, contacts, reuse-not-rebuild]

# Dependency graph
requires:
  - phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c (plan 80-03)
    provides: widened renderWaitlist() with Customer/Recipes cells (contains-style
      test assertions deliberately pinned for this plan to extend), findWaitlistRow,
      parseWaitlistRecipeIds, adminApiPost('update_waitlist_status', ...)
provides:
  - Per-row customer-link panel — search-or-create-inline a Zoho contact without
    leaving the row, verbatim reuse of the reassign panel markup/CSS and
    fetchReassignSearch's fetch shape, re-id'd bp-waitlist-link-{id}-* per row
  - D-02 write-through (id, zoho_contact_id, customer_name, conditional
    customer_phone) with the D-03a phone-preservation guard
  - Per-row recipe multi-select attach — own-lazy-fetch catalog independent of
    the Recipes tab/_recipesState, multi-select with the picker staying open,
    catalog-resolved chip names with a per-chip remove control
affects: [80-05, 80-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-row namespaced panel ids (bp-waitlist-{feature}-{id}-*) so two
       simultaneously-open row panels can never collide"
    - "Own-lazy-fetch catalog cache scoped to the calling feature (never reuses
       another tab's state var) — same shape as the existing Batches-tab attach
       dropdown, adapted from single-select-with-resolve to
       multi-select-display-only"

key-files:
  created:
    - tests/frontend/brewpad-waitlist-customer-link.test.js
    - tests/frontend/brewpad-waitlist-recipes.test.js
  modified:
    - js/brewpad.js
    - css/brewpad.css
    - js/brewpad.min.js
    - css/brewpad.min.css
    - brewpad.html (cache-buster query string bump, side effect of npm run build)

key-decisions:
  - "Split each tdd=\"true\" task into its own RED (test-only) commit followed
     by a GREEN (implementation) commit, verified by reverting js/brewpad.js and
     css/brewpad.css to HEAD, confirming both new test files failed for the
     right reason (missing test seams), then re-applying the implementation and
     confirming all tests passed."
  - "customer-link search issues a 400ms-debounced GET, matching the reused
     fetchReassignSearch's own timing, not a shorter/no debounce."
  - "Recipe picker's own catalog cache (_waitlistRecipeCatalog) is pushed to
     locally on a successful attach (not re-fetched), so the freshly-attached
     chip's name resolves immediately without waiting on a second network
     round-trip."

patterns-established:
  - "Cell-becomes-editor transform (established in 80-03's notes/position
     editors) now covers a full search-and-write sub-flow, not just a simple
     text field"

requirements-completed: [D-01, D-02, D-03, D-03a, D-15, D-16]

# Metrics
duration: ~50min
completed: 2026-09-04
---

# Phase 80 Plan 04: BrewPad Waitlist — Link Customers and Recipes Summary

**Per-row customer-link panel (search-or-create a Zoho contact, D-02/D-03a write-through) and per-row recipe multi-select attach with removable chips (D-15/D-16), both reused verbatim from existing BrewPad flows and wired directly into the Waitlist row.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-09-04
- **Tasks:** 2 (both `tdd="true"`: RED commit then GREEN commit each)
- **Files modified:** 7 (2 new test files, js/brewpad.js, css/brewpad.css, js/brewpad.min.js, css/brewpad.min.css, brewpad.html)

## Accomplishments
- A waitlist row's Customer cell grows a "Link customer"/"Change" trigger that
  transforms the cell in place into a search panel (verbatim reuse of the
  reassign panel markup/CSS, `js/brewpad.js:5556-5572` and `css/brewpad.css:1977-2021`,
  re-id'd `bp-waitlist-link-{id}-*` so two rows can never collide).
- Search hits `GET /api/contacts/search?q=` (reusing `fetchReassignSearch`'s
  exact fetch shape); "+ Add new customer" reveals an inline create form that
  POSTs the existing `{name, first_name, last_name, email, phone}` shape to
  `/api/contacts`.
- One `adminApiPost('update_waitlist_status', ...)` write carries `id`,
  `zoho_contact_id`, `customer_name` and — only when the row's current
  `customer_phone` is empty — `customer_phone` (D-03a: a hand-typed phone from
  a manual add, plan 80-05, is never clobbered by a later contact link).
- The Recipes cell grows a "+ Attach recipe" trigger opening its own
  lazy-fetch picker (`GET /api/recipes?status=active`, its own cache, never
  `_recipesState.list` and never `initRecipesTab()`) — works on a session that
  never opened the Recipes tab.
- Selecting a recipe appends its id and writes the pipe-joined `recipe_ids` in
  one call, keeping the picker open for a second selection (D-15); an
  already-attached recipe is skipped with no duplicate and no write.
- Each attached chip shows the catalog-resolved recipe NAME (falls back to the
  raw id until resolved) with a `×` carrying `aria-label="Remove {name}"`;
  tapping it writes the remaining ids immediately, no confirm sheet, preserving
  survivor order.
- D-16 held throughout: no code path in either flow fetches a per-recipe detail
  endpoint, checks stock, or touches batch/pricing state — verified by grep
  gates on the diff, not just by review.
- `beer.html`, `tests/frontend/brewpad-waitlist-render.test.js`,
  `brewpad-customer-reassign.test.js`, `brewpad-recipe-attach-modify.test.js`,
  `brewpad-recipes.test.js` and `checkout-waitlist.test.js` all untouched
  (verified via `git diff --numstat`); minified artifacts rebuilt via
  `npm run build`.

## Task Commits

Each task was committed atomically as RED then GREEN:

1. **Task 1: per-row customer-link panel (search, create inline, write-through)** (tdd) —
   `13dcb6b4` (test, RED — 14 tests fail: link/search/write-through seams don't exist) →
   `db68ac34` (feat, GREEN — 14/14 pass)
2. **Task 2: per-row recipe multi-select attach with removable chips** (tdd) —
   `015491cc` (test, RED — 16 tests fail: attach/remove/catalog seams don't exist) →
   `d2b705f0` (feat, GREEN — 16/16 pass; includes the `npm run build` artifacts)

_Verification for both RED commits: `js/brewpad.js`/`css/brewpad.css` were reverted
to HEAD (433782b5) before each test commit and the new suite run to confirm every
test failed for the expected reason (missing seam function), not an unrelated
error — then the implementation was re-applied and the suite re-run to confirm
GREEN before committing._

## Files Created/Modified
- `js/brewpad.js` — customer-link trigger + `openWaitlistLinkPanel`/
  `fetchWaitlistLinkSearch`/`linkWaitlistCustomer`/`saveWaitlistNewCustomer`;
  recipe-attach trigger/chips + `waitlistResolveRecipeName`/
  `openWaitlistRecipeAttachPanel`/`renderWaitlistRecipeAttachPanel`/
  `attachWaitlistRecipe`/`removeWaitlistRecipe`; delegated click handlers for
  both flows; module.exports test seams
- `css/brewpad.css` — one additive rule giving the Customer/Recipes `<td>`s
  (2nd/3rd columns) room to host the reused search/picker panels
- `tests/frontend/brewpad-waitlist-customer-link.test.js` — open/search/create-inline/
  write-through/D-03a/cancel coverage (14 tests, including a T-80-22 XSS-escaping test)
- `tests/frontend/brewpad-waitlist-recipes.test.js` — cold-session catalog/filter/
  attach/duplicate-skip/remove/status-availability/D-16 coverage (16 tests,
  including a T-80-22 XSS-escaping test)
- `js/brewpad.min.js`, `css/brewpad.min.css` — rebuilt via `npm run build`
- `brewpad.html` — cache-buster query string for `brewpad.min.js`/`.css` bumped
  (necessary consequence of rebuilding those two artifacts; reverted every other
  file the shared build script touches — see Issues Encountered, same pattern
  as 80-03)

## Decisions Made
- **RED/GREEN split per task, not per plan:** each `tdd="true"` task got its
  own test-then-implementation commit pair rather than one combined pair for
  the whole plan, matching the plan's own task boundaries (Task 2's `<action>`
  explicitly ends with `npm run build`, Task 1's does not — a natural seam).
- **Search debounce kept at 400ms**, matching the reused `fetchReassignSearch`
  wiring exactly, rather than shortening it for the new call site.
- **Recipe catalog cache is written to locally on a successful attach** (not
  re-fetched), so a freshly-attached chip's name resolves without an extra
  round-trip and without ever touching `_recipesState`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `fetchWaitlistLinkSearch` didn't return its fetch promise**
- **Found during:** Task 1, first test run (`_fetchWaitlistLinkSearchForTest(...).then` threw `Cannot read properties of undefined`)
- **Issue:** The function's `fetch(...)` call was missing a `return`, so the
  promise chain wasn't propagated to callers awaiting it.
- **Fix:** Added `return` before the `fetch(...)` call.
- **Files modified:** `js/brewpad.js`
- **Verification:** `brewpad-waitlist-customer-link.test.js` "zero results renders..." test passes.
- **Committed in:** `db68ac34` (Task 1 GREEN commit)

**2. [Rule 1 - Bug] Test fixture object reused (and mutated) across test cases**
- **Found during:** Task 2, first test run — `_attachWaitlistRecipeForTest` returned
  `undefined` in a later test because an earlier test's success handler had
  already mutated the shared `ROW.recipe_ids` in place.
- **Issue:** The recipes test file's `ROW` fixture was a single shared object;
  `attachWaitlistRecipe`/`removeWaitlistRecipe` mutate `row.recipe_ids` in
  place (mirroring the real `_waitlistRows` entry a live session would
  mutate), so state leaked across tests sharing the same object reference.
- **Fix:** Converted the fixture to a `freshRow(overrides)` factory returning a
  new object per call; every test now uses its own row instance.
- **Files modified:** `tests/frontend/brewpad-waitlist-recipes.test.js`
- **Verification:** All 16 tests pass independently and in any order.
- **Committed in:** `015491cc` (Task 2 RED commit, since the fix landed in the test file itself)

**3. [Rule 2 - Missing critical functionality] Threat-register-mandated XSS test was absent**
- **Found during:** pre-summary threat-surface review — `T-80-22` in the plan's
  threat model requires "a test asserts a `<script>`-bearing contact name
  renders escaped," which neither test file originally covered for the new
  search-result / chip rendering paths (80-03's equivalent test only covers
  the pre-existing Customer cell, not this plan's new markup).
- **Fix:** Added one XSS-escaping test per new render path — a
  `<script>`-bearing `contact_name` in a search result (customer-link file)
  and a `<script>`-bearing catalog recipe `name` in a chip (recipes file) —
  both asserting no `<script>` element renders and the raw text is present
  only as escaped text content.
- **Files modified:** `tests/frontend/brewpad-waitlist-customer-link.test.js`,
  `tests/frontend/brewpad-waitlist-recipes.test.js`
- **Verification:** Both new tests pass against the existing `escapeHTML`
  usage (no production code change was needed — the mitigation was already in
  place, only the coverage was missing).
- **Committed in:** `13dcb6b4` / `015491cc` (each task's RED commit, since they
  are test-only additions)

---

**Total deviations:** 3 auto-fixed (2 Rule 1, 1 Rule 2)
**Impact on plan:** All three were necessary for correctness (1, 2) or explicit
threat-model coverage (3). No scope creep — none touch a file outside this
plan's `files_modified`.

## Issues Encountered

- **Acceptance-criteria grep quirk:** the plan's Task 2 acceptance criterion
  `grep -c "Recipe attached" js/brewpad.js` expects `1`, but the file already
  contained one pre-existing, unrelated usage of the identical toast string at
  `js/brewpad.js:5114` (the Batches-tab recipe-attach flow, from an earlier
  phase) before this plan touched anything. The UI-SPEC's Copywriting Contract
  locks `"Recipe attached"` as this plan's exact required toast text too, so
  the count is unavoidably `2`, not `1` — not a defect in this plan's code.
  Confirmed via `git show HEAD:js/brewpad.js | grep -n "Recipe attached"`
  before any of this plan's edits landed. Left both toasts as their
  spec-mandated exact text rather than inventing a divergent string to satisfy
  a literal grep count.
- **`npm run build` regenerates cache-buster query strings and timestamps
  across every public page and `js/admin.js`/`.min.js`**, not just BrewPad's
  artifacts — same out-of-scope side effect 80-03 documented. Reverted every
  touched file outside this plan's `files_modified` via `git checkout --`,
  keeping only `brewpad.html`'s cache-buster bump.
- **`zoho-middleware/node_modules` was absent** in this worktree (same as
  80-03); restored via `npm ci` from the existing, unmodified
  `package-lock.json` (environment setup, not a package-legitimacy decision —
  excluded from the Rule 3 install-exclusion). One middleware test
  (`helcim-webhook.test.js` "tampered body -> 403") failed once immediately
  after the fresh install, then passed cleanly on two subsequent full-suite
  runs (1562/1562 both times); logged in `deferred-items.md` as an apparent
  one-off flake, not a defect introduced by this plan (`git diff --stat
  zoho-middleware/` is empty throughout).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

Both reuse-not-rebuild capabilities this phase's objective named (link a
customer, attach recipes) are live in the Waitlist row, on top of 80-03's
structural work. Plans 80-05/80-06 (contact action, manual add) can now build
their own triggers into the same row without needing to touch the Customer or
Recipes cells' rendering logic — this plan owns both, and neither introduces a
new interaction pattern (both are cell-becomes-editor, matching the notes/pin
editors already established). No blockers.

---
*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Completed: 2026-09-04*

## Self-Check: PASSED

- All 7 files_modified plus deferred-items.md and this SUMMARY confirmed present on disk.
- All 4 task commits (13dcb6b4, db68ac34, 015491cc, d2b705f0) confirmed present in git log.

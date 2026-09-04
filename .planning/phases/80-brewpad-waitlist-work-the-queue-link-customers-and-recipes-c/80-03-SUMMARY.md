---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 03
subsystem: ui
tags: [brewpad, waitlist, es5, jsdom, queue-ordering, drag-free-reorder]

# Dependency graph
requires:
  - phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
    provides: sortWaitlistRows/computeWaitlistQueuePositions/filterWaitlistRows, the
      #bp-panel-waitlist table shell, showToast/showConfirmSheet, adminApiPost
provides:
  - Position-aware sortWaitlistRows merge-insert (pinned rows splice at a clamped
    1-based rank; unpinned rows keep the exact existing chronological comparator)
  - Widened renderWaitlist: .bp-waitlist-table-wrap horizontal-scroll wrapper,
    D-02 Customer cell (name — email — phone), D-15/D-16 Recipes chip cell
  - Pin marker + one-tap clear-pin + inline position editor with client-side
    validation, wired through the existing update_waitlist_status admin-proxy action
  - parseWaitlistPosition / parseWaitlistRecipeIds pure helpers (exported for test/reuse)
affects: [80-04, 80-05, 80-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Render-time merge-insert for queue overrides (never rewrites unrelated rows)"
    - "Test-only IIFE-scope seams (renderWaitlist, _setWaitlistStateForTest,
       _openWaitlistPositionEditForTest, _saveWaitlistPositionForTest,
       _clearWaitlistPinForTest) since initDelegation's DOMContentLoaded listener
       never fires under Jest"

key-files:
  created:
    - tests/frontend/brewpad-waitlist-position.test.js
    - tests/frontend/brewpad-waitlist-render.test.js
  modified:
    - js/brewpad.js
    - css/brewpad.css
    - js/brewpad.min.js
    - css/brewpad.min.css
    - brewpad.html (cache-buster query string bump, side effect of npm run build)

key-decisions:
  - "Fixed a same-position stability bug in RESEARCH.md's own reference splice
     algorithm (Rule 1): sequential out.splice(idx,0,row) at an identical clamped
     index landed later-sorted pinned rows BEFORE earlier ones. Added a lastIdx
     guard so ties resolve by ascending original index, matching the plan's own
     acceptance criterion."
  - "Customer/Recipes cell tests use contains-style assertions only (toContain /
     element counts), per the plan's explicit instruction that 80-04 injects
     further markup into the same two cells next wave."
  - "Pin/clear-pin write payload is exactly {action, id, position} -- no
     signed_up_at, no other row ever touched -- verified by both a grep gate and
     a payload-equality test."

patterns-established:
  - "Queue-order override via render-time merge-insert, not a stored renumbering scheme"

requirements-completed: [D-02, D-10, D-11, D-12, D-13, D-14, D-15, D-16]

# Metrics
duration: ~25min
completed: 2026-09-04
---

# Phase 80 Plan 03: BrewPad Waitlist — Queue Structure Summary

**Position-aware sortWaitlistRows merge-insert plus a widened renderWaitlist (Customer/Recipes cells, horizontal-scroll wrapper, pin marker + inline position editor) — the structural frontend half plans 80-04/80-05 build interactive triggers into.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-09-04
- **Tasks:** 3 (Task 1 was `tdd="true"`: RED commit then GREEN commit)
- **Files modified:** 7 (2 new test files, js/brewpad.js, css/brewpad.css, js/brewpad.min.js, css/brewpad.min.css, brewpad.html)

## Accomplishments
- `sortWaitlistRows` now merges pinned rows into their target 1-based rank while
  unpinned rows keep today's exact chronological ordering byte-for-byte; clearing a
  pin is a perfect round trip (D-10–D-14).
- `renderWaitlist` grows from 7 to up to 9 columns behind a new
  `.bp-waitlist-table-wrap` horizontal-scroll wrapper (`min-width:960px`, scoped so
  no other table is affected) instead of shrinking any cell.
- Customer cell renders the D-02 `"{name} — {email} — {phone}"` format for linked
  rows (phone segment and its separator both omitted when empty) and the bare email
  for unlinked rows, unchanged from today.
- Recipes cell renders one `.bp-batch-chip-inline` chip per attached recipe id (via
  a new `parseWaitlistRecipeIds` pipe-delimited parser) or `"No recipes attached"`.
- A pinned row is visibly marked (`📌 {position}` on `waiting` rows, `📌 —`
  elsewhere) with a one-tap clear-pin control and an inline numeric position editor
  that validates client-side before ever issuing a request; every pin/unpin write is
  a single-cell `{action, id, position}` write on exactly one row, verified by a
  payload-equality test.
- `beer.html` untouched (D-14); minified artifacts rebuilt via `npm run build`.

## Task Commits

Each task was committed atomically:

1. **Task 1: position-aware sortWaitlistRows merge-insert** (tdd) —
   `6b6a5a52` (test, RED) → `3dcf7ecf` (feat, GREEN)
2. **Task 2: widened renderWaitlist — scroll wrapper, Customer cell, Recipes cell** —
   `6c8a12c2` (feat)
3. **Task 3: pin marker, inline position editor, clear-pin, and build** —
   `80916400` (feat)

_Note: Task 1 is `tdd="true"` — the test commit intentionally fails before the
implementation commit (verified: 17/20 assertions failed pre-GREEN, all 20 pass
post-GREEN)._

## Files Created/Modified
- `js/brewpad.js` — `parseWaitlistPosition`, `parseWaitlistRecipeIds`, extended
  `sortWaitlistRows`, widened `renderWaitlist` (Customer/Recipes/pin cells),
  `openWaitlistPositionEdit`/`saveWaitlistPosition`/`clearWaitlistPin`, delegated
  click handlers, module.exports test seams
- `css/brewpad.css` — `.bp-waitlist-table-wrap`, `.bp-waitlist-no-recipes`,
  `.bp-waitlist-pin-marker`, `.bp-waitlist-pos-error`
- `tests/frontend/brewpad-waitlist-position.test.js` — merge-insert coverage (20 tests)
- `tests/frontend/brewpad-waitlist-render.test.js` — table structure, Customer cell,
  Recipes cell, pin/position-editor coverage (18 tests)
- `js/brewpad.min.js`, `css/brewpad.min.css` — rebuilt via `npm run build`
- `brewpad.html` — cache-buster query string for `brewpad.min.js`/`.css` bumped
  (necessary consequence of rebuilding those two artifacts; reverted every other
  file the shared build script touches — see Deviations)

## Decisions Made
- **Position semantics:** a positive integer in `row.position` = target 1-based
  rank; everything else (0, negative, non-integer, `null`/`undefined`/`''`, non-numeric
  strings) is unpinned. A numeric-string position (`'2'`) DOES pin, per the plan's
  explicit behavior spec.
- **Pin marker text is the row's own stored `position` value**, not the row's
  computed queue rank — matches the UI-SPEC copy table (`📌 {position}`) and gives
  staff the exact number they typed.
- **Pin control renders on every row regardless of status** (UI-SPEC Phase-Specific
  Decision 5, as directed) — non-`waiting` rows show `📌 —` / `—` since
  `computeWaitlistQueuePositions` never numbers them.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a same-position stability bug in the RESEARCH.md reference splice algorithm**
- **Found during:** Task 1 (position-aware sortWaitlistRows merge-insert)
- **Issue:** `80-RESEARCH.md`'s own example code (`pinned.forEach` sequentially
  `out.splice(idx, 0, p.row)`) reverses the order of two rows pinned to the identical
  clamped target index — the second insertion lands *before* the first, violating
  the plan's own explicit behavior spec ("Two rows pinned to the same position order
  by ascending original index (stable)").
- **Fix:** Added a `lastIdx` guard: if a pinned row's clamped target index would
  collide with (or fall behind) the previous insertion, place it immediately after
  instead. Normal, non-colliding cases are unaffected.
- **Files modified:** `js/brewpad.js`
- **Verification:** `tests/frontend/brewpad-waitlist-position.test.js` — "two rows
  pinned to the same position order by ascending original index (stable)" — passes.
- **Committed in:** `3dcf7ecf` (part of Task 1's GREEN commit)

**2. [Rule 3 - Blocking] `zoho-middleware` had no installed `node_modules` in this worktree**
- **Found during:** Task 3's full-suite verification step
- **Issue:** `cd zoho-middleware && npm test` failed with `Cannot find module
  '@sentry/node'` — `node_modules` was entirely absent (0 packages).
- **Fix:** Ran `npm ci` from the existing, unmodified `package-lock.json` — restores
  the exact locked dependency set, introduces nothing new. This is environment setup,
  not a package-legitimacy decision (excluded from the Rule 3 install-exclusion,
  which concerns *adding/changing* a dependency, not restoring an already-locked one).
- **Files modified:** none (gitignored `zoho-middleware/node_modules/`)
- **Verification:** `cd zoho-middleware && npm test` — 104/104 suites, 1541/1541
  tests green afterward.
- **Committed in:** n/a (not a tracked change)

---

**Total deviations:** 2 auto-fixed (1 Rule 1, 1 Rule 3)
**Impact on plan:** Both were necessary for correctness/environment health. No scope
creep — the Rule 1 fix keeps `sortWaitlistRows`'s own stated contract; the Rule 3 fix
only restores a locked dependency set already declared in `package.json`.

## Issues Encountered

`npm run build` regenerates cache-buster query strings and timestamps across **every**
public page and `js/admin.js`/`js/admin.min.js`, not just BrewPad's artifacts — an
out-of-scope side effect of the shared build script. Reverted every touched file
outside this plan's `files_modified` (`about.html`, `admin.html`, `beer.html`,
`contact.html`, `custom-labels.html`, `index.html`, `ingredients.html`, `js/admin.js`,
`js/admin.min.js`, `kiosk.html`, `products.html`, all `products/*.html`,
`reservation.html`, `wine.html`) via `git checkout --`, keeping only `brewpad.html`'s
cache-buster bump (load-bearing: without it, a staff iPad could serve a stale cached
`brewpad.min.js`/`.css` after this deploy).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

The Waitlist tab is fully functional on its own at this commit (per the plan's
objective): staff can see the widened table, pin/clear/reorder rows, and the
Customer/Recipes cells render correctly — all with no dependency on plans 80-04/80-05.
Those two plans inject further interactive markup into the same Customer and Recipes
cells (link-customer/attach-recipe triggers, a remove-chip control, catalog-resolved
recipe names) and must NOT edit `tests/frontend/brewpad-waitlist-render.test.js`'s
`Customer cell`/`Recipes cell` describe blocks to compensate — those blocks are
deliberately contains-style for exactly this reason. No blockers.

---
*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Completed: 2026-09-04*

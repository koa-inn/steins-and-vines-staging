---
phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c
plan: 01
subsystem: api
tags: [apps-script, google-sheets, waitlist, schema-migration, validation]

# Dependency graph
requires:
  - phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
    provides: The original 7-column Waitlist sheet contract (ensureWaitlistSheet, addWaitlistEntry, getWaitlist, updateWaitlistStatus, D-05 one-way transitions, D-06 non-disclosure dedupe)
provides:
  - 13-column Waitlist sheet contract (D-17): zoho_contact_id, customer_name, customer_phone, recipe_ids, position, contacted_at appended after notes
  - Header-driven addWaitlistEntry (RESEARCH.md Pitfall 1 fixed — no more literal positional appendRow)
  - getWaitlist returns all 13 fields to BrewPad
  - updateWaitlistStatus writes any subset of nine optional fields independently, with server-side position validation (invalid_position) and every free-text field (incl. status, IN-01 closed) routed through waitlistCellSafe
  - Pure serializeWaitlistRecipeIds/parseWaitlistRecipeIds helpers (D-15, pipe-delimited)
  - WR-02 documented in code as an accepted carry-forward
  - docs/APPS_SCRIPT.md Waitlist section corrected to match shipped (server-side transition guard, write-only add_waitlist_entry on admin proxy) behaviour
affects: [80-02, 80-03, 80-04, 80-05, 80-06]

# Tech tracking
tech-stack:
  added: []
  patterns: ["header-driven Sheets writes via ensured.col[name] instead of literal positional arrays", "pre-write server-side validation before any setValue (position, status, transition)"]

key-files:
  created:
    - tests/frontend/adminapi-waitlist-append-headers.test.js
    - tests/frontend/adminapi-waitlist-fields.test.js
  modified:
    - apps-script/adminApi.gs
    - tests/frontend/adminapi-waitlist-pure.test.js
    - tests/frontend/adminapi-waitlist-ensure-sheet.test.js
    - docs/APPS_SCRIPT.md

key-decisions:
  - "recipe_ids stored pipe-delimited, no spaces (SV-R- ids cannot contain a pipe)"
  - "position stored only on the pinned row as a positive integer target rank; merge/ranking happens client-side in js/brewpad.js (plan 80-03), this layer only stores and validates"
  - "WR-02 (optimistic locking) carried forward, not folded in — needs a 14th last_updated column D-17/D-20 scope out of this migration"
  - "IN-01 folded in: status write routed through waitlistCellSafe, closing the injection-guard gap"
  - "adminapi-waitlist-ensure-sheet.test.js updated (not left untouched) — the D-17 13-column requirement is structurally incompatible with that suite's hardcoded 7-column fixtures; updating it is the only way to keep both the schema change and the suite meaningful (mirrors the phase's own explicitly-authorized waitlist-admin-proxy.test.js flip)"

patterns-established:
  - "Header-driven Sheets row writes: build a same-length array filled with '', then set each value at ensured.col[name] - 1, never a literal positional array — makes writes independent of physical column order"
  - "Validate ALL payload fields before any setValue call, so a rejected write is guaranteed to touch zero cells"

requirements-completed: [D-02, D-09, D-10, D-11, D-12, D-15, D-17, D-19, D-22, D-25, IN-01, WR-02]

# Metrics
duration: 30min
completed: 2026-09-04
---

# Phase 80 Plan 01: Waitlist 13-Column Schema + Header-Driven Writes Summary

**Extended the Apps Script Waitlist sheet from Phase 78's 7-column contract to D-17's 13-column contract, fixed the pre-existing positional-appendRow bug the new columns would otherwise trip, and gave `updateWaitlistStatus` independent server-validated write paths for all six new fields.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-04T16:23:00Z (approx.)
- **Completed:** 2026-09-04T16:53:00Z
- **Tasks:** 3 completed / 3
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- `ensureWaitlistSheet` now requires 13 named columns (D-17), still fails closed on any drift and never repairs headers (D-18 preserved byte-for-byte in behavior)
- `addWaitlistEntry`'s literal positional `appendRow([...])` replaced with a header-driven write via `ensured.col[name]` — proven via a shuffled-header regression test that would have failed under the old code (RESEARCH.md Pitfall 1 closed)
- `getWaitlist` returns all six new fields to BrewPad
- `updateWaitlistStatus` accepts any subset of nine optional fields, validates `position` server-side (integer ≥ 1 or empty-to-unpin, else `invalid_position` with zero cells written), and routes every free-text field — including `status` (IN-01) — through `waitlistCellSafe`
- Two new pure helpers `serializeWaitlistRecipeIds`/`parseWaitlistRecipeIds` (D-15), pipe-delimited, round-trip tested
- WR-02 documented in a code comment above `updateWaitlistStatus` as a deliberate carry-forward, citing `78-REVIEW.md`
- `docs/APPS_SCRIPT.md`'s Waitlist section rewritten to match shipped behaviour: 13-column table, four actions (`add_waitlist_entry` now write-only on the admin proxy per D-21), server-side one-way transition guard (previously documented — incorrectly, since `a706d7b8`'s CR-01 fix — as client-only), D-18 migration-order callout

## Task Commits

Each task was committed atomically:

1. **Task 1: Pure recipe-id helpers + RED regression test for the positional appendRow bug** - `3bb14feb` (test)
2. **Task 2: 13-column schema, header-driven addWaitlistEntry, getWaitlist field allowlist** - `dc1a6a0b` (feat)
3. **Task 3: updateWaitlistStatus six new fields, IN-01 fold-in, WR-02 note, docs correction** - `e4effab7` (feat)

**Plan metadata:** (this commit, docs — see below)

_Note: Task 1 is a TDD task; RED state (append-headers test failing on a wrong-column value) was committed before Task 2 turned it GREEN, per plan instruction._

## Files Created/Modified
- `apps-script/adminApi.gs` - 13-column `ensureWaitlistSheet`, header-driven `addWaitlistEntry`, `getWaitlist` allowlist, `updateWaitlistStatus` nine-field handling + position validation + IN-01 fold-in + WR-02 comment, two new pure recipe-id helpers
- `tests/frontend/adminapi-waitlist-pure.test.js` - extended (insertions only) with `serializeWaitlistRecipeIds`/`parseWaitlistRecipeIds` round-trip coverage
- `tests/frontend/adminapi-waitlist-append-headers.test.js` - **new** RED→GREEN regression proving a shuffled 13-column header row still lands every value correctly by name
- `tests/frontend/adminapi-waitlist-fields.test.js` - **new** 14-case behavioural suite for `updateWaitlistStatus`'s six new fields, position validation matrix, `waitlistCellSafe` routing, `no_fields`/`invalid_transition` guards
- `tests/frontend/adminapi-waitlist-ensure-sheet.test.js` - updated to the 13-column D-17 contract (see Deviations)
- `docs/APPS_SCRIPT.md` - Waitlist section rewritten for the shipped 13-column / four-action / server-enforced-transition reality

## Decisions Made
- `recipe_ids`: pipe-delimited, no spaces (planner's discretion item, per plan frontmatter)
- `position`: positive integer target rank stored only on the pinned row; ranking merge is plan 80-03's job in `js/brewpad.js`, this layer only stores/validates
- WR-02 carried forward with a code comment, not folded in (needs a 14th column, scoped out by D-17/D-20)
- IN-01 folded in (status write now through `waitlistCellSafe`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan defect / test-maintenance required by the schema change itself] Updated `adminapi-waitlist-ensure-sheet.test.js`**
- **Found during:** Task 2 (13-column schema extension)
- **Issue:** The plan's Task 2 acceptance criteria required BOTH extending `ensureWaitlistSheet`'s required headers from 7 to 13 AND `tests/frontend/adminapi-waitlist-ensure-sheet.test.js` passing unmodified. These are mutually exclusive: that suite hardcodes a 7-element `HEADERS` array in all 4 of its tests (asserting the created/initialised tab's header row equals exactly 7 names, and that a 7-header existing tab is accepted as "correctly headered"). Verified empirically — running the suite after the schema extension failed all 4 tests with the exact expected 6-column diff.
- **Fix:** Updated `HEADERS` to the 13-column D-17 list and adjusted the 4 fixtures/assertions to the new column count/positions (minimal diff: same test names/intent, new column counts). The "drifted headers" test was adjusted to isolate "two original columns missing" from "the six D-17 columns don't exist yet" (covered separately by `adminapi-waitlist-fields.test.js`/`append-headers.test.js`), keeping its original `missing: ['signed_up_at', 'notes']` assertion unchanged.
- **Files modified:** `tests/frontend/adminapi-waitlist-ensure-sheet.test.js`
- **Verification:** All 4 tests pass; full waitlist suite (104 tests) green; full frontend suite (1535 tests) green.
- **Committed in:** `dc1a6a0b` (Task 2 commit)

**2. [Rule 1 - Bug] JSDoc comment accidentally broke an unrelated pre-existing regression test**
- **Found during:** Task 1/2 (full `npm test` run before committing)
- **Issue:** The JSDoc for `serializeWaitlistRecipeIds` originally quoted `generateNextId(RECIPES_SHEET_NAME, 'SV-R-', 6)` as an example — this literal text matched the regex `tests/frontend/adminapi-giftcard-ledger.test.js` uses to count real `generateNextId(` call sites across the whole file (guarding against silent new call-site additions), bumping the count from 13 to 14 and failing that unrelated suite.
- **Fix:** Reworded the comment to reference the call site descriptively instead of reproducing the literal `generateNextId(...)` call syntax.
- **Files modified:** `apps-script/adminApi.gs`
- **Verification:** `grep -c "generateNextId("` back to 13; full `npm test` green (1521 → 1535 as new tests were added, 0 failures).
- **Committed in:** `dc1a6a0b` (Task 2 commit, before it was ever committed with the bug)

---

**Total deviations:** 2 auto-fixed (1 plan-defect test-maintenance, 1 unrelated-suite collision bug)
**Impact on plan:** Both fixes were necessary for the plan's own stated objective (a correct, test-covered 13-column schema migration) to be achievable at all. No scope creep — no middleware or frontend UI files touched (sibling plans 80-02/80-03/80-04/80-05 own those).

## Issues Encountered
- The plan's acceptance criterion `grep -c "7 columns" apps-script/adminApi.gs` outputs `0` is unsatisfiable without touching unrelated Recipes-tab code: line ~4081's pre-existing `Logger.log('Created Recipes tab with 17 columns')` contains "7 columns" as a substring of "1**7 columns**". Fixed the actual Waitlist-specific hardcoded literal (`setupWaitlist`'s `Logger.log` now reads `result.headers.length` dynamically); left the unrelated Recipes line untouched per CLAUDE.md's "don't touch unrelated code" rule and the plan's own scope boundary. `grep -c "7 columns"` now returns `1` (the Recipes line only), not `0` — a documented, unavoidable acceptance-criteria imprecision, not a functional gap.
- `cd zoho-middleware && npm test` could not run: `zoho-middleware/node_modules` is essentially uninstalled in this worktree (1 entry). This is a pre-existing environment gap unrelated to this plan — no middleware files were touched by 80-01 (owned by sibling plan 80-02). Flagging for the orchestrator/next agent in case the merged tree needs a middleware install before its own test run.

## User Setup Required

None - no external service configuration required. This plan ships **source only** — nothing is deployed. The live Apps Script Web App remains on the Phase 78 version until plan 80-06's owner redeploy (per plan's own `<verification>` item 5 and D-20).

## Next Phase Readiness
- The 13-column storage contract, header-driven writes, and nine-field `updateWaitlistStatus` are ready for plans 80-02 (middleware: `add_waitlist_entry` admin-proxy allow-list, new contact-send endpoint), 80-03 (BrewPad UI: customer link, recipe link, position pin/reorder), 80-04, and 80-05 to build against.
- **Blocker for the eventual cutover (not this plan's scope):** D-18's migration order is load-bearing — the live Google Sheet's Waitlist tab must gain the six new columns BEFORE the Apps Script redeploy that ships this code, or every public signup 503s until they land. This is plan 80-06's responsibility (documented in `docs/APPS_SCRIPT.md`'s updated First-time-setup section).
- Middleware test suite could not be verified in this worktree due to missing `node_modules` — recommend a fresh `npm install` in `zoho-middleware/` before the phase-level merged-tree test run.

---
*Phase: 80-brewpad-waitlist-work-the-queue-link-customers-and-recipes-c*
*Completed: 2026-09-04*

## Self-Check: PASSED

All 7 created/modified files verified present on disk (`apps-script/adminApi.gs`,
`tests/frontend/adminapi-waitlist-pure.test.js`,
`tests/frontend/adminapi-waitlist-append-headers.test.js`,
`tests/frontend/adminapi-waitlist-fields.test.js`,
`tests/frontend/adminapi-waitlist-ensure-sheet.test.js`, `docs/APPS_SCRIPT.md`, this SUMMARY.md).
All 3 task commit hashes (`3bb14feb`, `dc1a6a0b`, `e4effab7`) verified present in `git log`.

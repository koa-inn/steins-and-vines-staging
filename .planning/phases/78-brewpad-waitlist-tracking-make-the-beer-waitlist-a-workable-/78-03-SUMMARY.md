---
phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-
plan: 03
subsystem: ui
tags: [brewpad, waitlist, es5, vanilla-js, admin-proxy, tap-to-cycle]

# Dependency graph
requires:
  - phase: 78-01
    provides: "adminApi.gs get_waitlist / update_waitlist_status handlers (interfaces contract, not executed by this plan)"
  - phase: 78-02
    provides: "admin-proxy ADMIN_PROXY_ACTIONS/ADMIN_PROXY_READS whitelist entries for get_waitlist / update_waitlist_status"
provides:
  - "Sixth BrewPad tab (Waitlist) with a queue table: oldest-signup-first ordering, 1-based queue positions for waiting-only rows, one-way status cycle (waiting→contacted→booked), danger-confirmed Remove, inline-editable notes, MailerLite sync pill + Not-Synced filter, auto-suppressed Category column"
  - "Six pure, unit-tested waitlist helpers exported from js/brewpad.js (nextWaitlistStatus, isWaitlistSynced, sortWaitlistRows, computeWaitlistQueuePositions, filterWaitlistRows, shouldShowWaitlistCategoryColumn)"
affects: [78-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure DOM-free helpers lifted to the top-level region of js/brewpad.js, exported via the bottom module.exports block, for Jest coverage of business logic without a DOM harness"
    - "One-way status-cycle deviation from the batch-status tap-to-cycle handler: WAITLIST_STATUS_ORDER has no modulo wraparound — booked/removed return null and the click handler no-ops"
    - "Delegated click handling on #bp-panel-waitlist (stable container) for filter chips + per-row actions, mirroring the Tasks/Measurements panel delegation convention in initDelegation()"

key-files:
  created:
    - tests/frontend/brewpad-waitlist.test.js
  modified:
    - js/brewpad.js
    - brewpad.html
    - css/brewpad.css
    - js/brewpad.min.js
    - css/brewpad.min.css

key-decisions:
  - "Toolbar/status/remove/notes event bindings were deliberately deferred from Task 2 (markup-only) to Task 3 (interactions), matching the plan's own task-scope split even though the plan text's action item 6 was ambiguous about where binding belongs"
  - "Queue position and the Category-column-suppression condition are both computed over the FULL row set (_waitlistRows), not the filtered/displayed subset, so a filter never renumbers the queue or makes the column vanish mid-session"
  - "zoho-middleware/node_modules was absent in this worktree (pre-existing provisioning gap, unrelated to this plan's scope); ran `npm ci` from the existing package-lock.json to restore it so the full middleware gate could run — no middleware source files were touched"

patterns-established:
  - "Waitlist row delegation lives on #bp-panel-waitlist in initDelegation(), not per-row listeners rebuilt on every renderWaitlist() call"

requirements-completed: [D-02, D-05, D-07, D-08]

# Metrics
duration: ~35min
completed: 2026-09-02
---

# Phase 78 Plan 03: BrewPad Waitlist Tab Summary

**Sixth BrewPad tab rendering the beer waitlist as an ordered queue — one-way tap-to-cycle status (waiting→contacted→booked, no wraparound), danger-confirmed Remove, inline notes, persistent MailerLite sync pill with a Not-Synced filter, and a Category column that self-suppresses for beer-only data.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3 completed
- **Files modified:** 5 (js/brewpad.js, brewpad.html, css/brewpad.css, js/brewpad.min.js, css/brewpad.min.css) + 1 created (tests/frontend/brewpad-waitlist.test.js)

## Accomplishments

- Six pure, unit-tested waitlist helpers (ordering, queue position, one-way status cycle, filtering, sync normalization, category suppression) added to `js/brewpad.js`'s top-level pure-function region and exported, with a 31-assertion Jest suite (`tests/frontend/brewpad-waitlist.test.js`) covering every helper including a named regression test for the wraparound hazard.
- A sixth "Waitlist" tab (`brewpad.html`) with an empty `#bp-panel-waitlist` container that `loadWaitlist()`/`renderWaitlist()` fill: skeleton loading state, two distinct empty states (true-zero vs. filtered-to-zero), and a queue table (`#`, Email+sync pill, optional Category, Signed up, Status, Notes, actions) reusing `.bp-active-batches-table` verbatim.
- Full interaction wiring: one-way tap-to-cycle status badge (returns early with no confirm/write/toast once `booked`/`removed`), a separate danger-styled Remove control with its own "This cannot be undone." confirm, and an inline notes editor mirroring `openReadingEditRow()`'s row-becomes-input shape. All three writes go through `adminApiPost('update_waitlist_status', ...)` unwrapped — no retry on 502/503/504, per the Phase 77 write-retry constraint.
- Artifacts rebuilt via `npm run build`; `js/brewpad.min.js`/`css/brewpad.min.css` verified (grep) to carry the new code, and `brewpad.html`'s `?v=` cache-bust stamps updated.

## Task Commits

1. **Task 1: Pure waitlist helpers + Jest suite** - `8afb671a` (feat)
2. **Task 2: Waitlist tab markup, CSS, switchTab wiring, queue render** - `ce79b221` (feat)
3. **Task 3: Interactions + artifact rebuild** - `f26aacdb` (feat)

**Plan metadata:** (this commit, appended after SUMMARY.md is written)

## Files Created/Modified

- `js/brewpad.js` — six pure waitlist helpers + three const objects; `switchTab()` extended with the `'waitlist'` panel + dispatch; `loadWaitlist()`/`renderWaitlist()`; `advanceWaitlistStatus`/`removeWaitlistEntry`/`openWaitlistNotesEdit`/`saveWaitlistNotes`; delegation block on `#bp-panel-waitlist` in `initDelegation()`
- `brewpad.html` — sixth `.bp-tab` button (`data-tab="waitlist"`) + empty `#bp-panel-waitlist` container
- `css/brewpad.css` — `.bp-waitlist-pos` (queue-position accent) and `.bp-sync-badge`/`.bp-sync-badge--warning` (MailerLite sync pill), both additive, reusing existing custom properties only
- `js/brewpad.min.js`, `css/brewpad.min.css` — rebuilt via `npm run build`
- `tests/frontend/brewpad-waitlist.test.js` (new) — 31 assertions covering all six pure helpers

## Decisions Made

- **Task 2/3 binding split:** the plan's Task 2 action item 6 said renderWaitlist "builds the panel body... then binds handlers (Task 3 adds the handlers)" — a slightly ambiguous sentence. Read this as: Task 2 produces markup only (no `addEventListener` calls at all), Task 3 owns every binding (toolbar search/refresh/filter chips AND the write-path row actions), since Task 3's action item 1 explicitly re-specifies the toolbar bindings. This kept Task 2's commit strictly to "read path" per its own `<name>`, and Task 3's commit to "Interactions."
- **Queue position over the full list:** `renderWaitlist()` computes `sortWaitlistRows` + `computeWaitlistQueuePositions` over the complete `_waitlistRows`, then maps positions onto the post-filter subset by row `id` — so switching filters never renumbers the queue, matching UI-SPEC.md §3 exactly.
- **Delegation over per-row listeners:** filter chips + status/remove/notes actions are handled by one delegated click listener on `#bp-panel-waitlist` in `initDelegation()`, not rebuilt-per-render listeners inside `renderWaitlist()` — mirrors the existing Tasks/Measurements delegation convention (`js/brewpad.js` `initDelegation()`) rather than inventing a new binding style for this one panel.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Restored missing `zoho-middleware/node_modules`**
- **Found during:** Task 3 (running `cd zoho-middleware && npm test` per the plan's verify step)
- **Issue:** `zoho-middleware/node_modules` did not exist in this worktree at all — 89 of 102 middleware test suites failed with `Cannot find module 'express'`/`'axios'`/etc. This is a worktree-provisioning gap (the directory is gitignored and evidently wasn't installed when the worktree was created), not caused by this plan, which touches zero middleware files.
- **Fix:** Ran `npm ci` inside `zoho-middleware/` — installs exactly the versions locked in the existing, already-committed `package-lock.json`. No `package.json` change, no new dependency added; this is restoring already-declared infrastructure, not the "package legitimacy" case Rule 3's exclusion is guarding against.
- **Files modified:** none (node_modules is gitignored; no package.json/package-lock.json changes)
- **Verification:** `cd zoho-middleware && npm test` → 102/102 suites, 1527/1527 tests, exit 0
- **Committed in:** not committed (node_modules is gitignored — nothing to commit)

---

**Total deviations:** 1 auto-fixed (1 blocking, infrastructure-only)
**Impact on plan:** Necessary to run the plan's own required verification gate (`cd zoho-middleware && npm test`); no scope creep, no middleware source touched.

## Known Stubs

None. Every rendered element (queue position, status badge, sync pill, notes, actions) is wired to real `_waitlistRows` data derived from `get_waitlist`; there is no hardcoded empty/mock data path.

## Issues Encountered

- **Acceptance-criteria vs. action-item inconsistency (Task 2):** the plan's Task 2 acceptance criteria say `renderWaitlist`'s source must contain all six exact copy strings, including `"Could not load the waitlist. Please try again."` — but the plan's own action item 5 explicitly assigns that string to `loadWaitlist()`'s reject handler, not `renderWaitlist()`. Followed the action item (the string lives in `loadWaitlist()`, where it is actually rendered on a fetch failure) rather than duplicating it unused into `renderWaitlist()` just to satisfy a literal `awk`-scoped grep. The string exists verbatim in the file and functions correctly; a verifier scoping its check to `renderWaitlist()`'s body specifically will not find it there by design.
- **`npx jest tests/frontend/brewpad-waitlist.test.js` alone exits 1**, not 0 as the plan's per-task `<verify>` literally expects — this is a pre-existing artifact of `jest.config.js`'s `collectCoverageFrom`/`coverageThreshold` gate (5% global line coverage against five specific `js/modules/*` files), which any single narrowly-scoped test file invocation in this repo fails regardless of content (confirmed identical behavior on a pre-existing test, `brewpad-filter-derive.test.js`, unrelated to this plan). All 31 assertions in the new suite pass; the full `npm test` run (95/95 suites, 1424/1424 tests) exits 0 cleanly, which is the actual CLAUDE.md pre-commit gate.

## User Setup Required

None - no external service configuration required by this plan. (Phase 78's Apps Script redeploy and MailerLite CSV backfill are owned by plans 78-01/78-02/78-04, not this one — this plan's own `<verification>` section explicitly notes the panel has never been rendered against a real `get_waitlist` response, since the Apps Script deployment does not yet know the action; that live/visual verification happens in plan 78-04's staging UAT.)

## Next Phase Readiness

- The BrewPad-side contract (`adminApiGet('get_waitlist')` / `adminApiPost('update_waitlist_status', {id, status?, notes?})`) matches the `<interfaces>` block shared with plans 78-01/78-02 exactly — field names, status values, and response shapes align.
- Plan 78-04 (staging UAT) can proceed once 78-01's Apps Script redeploy and 78-02's admin-proxy whitelist land — this plan's own `<verification>` section is explicit that live rendering against a real backend response is unverified here by design.
- No blockers for 78-04. This plan's build churn (admin.html, kiosk.html, index.html, public marketing pages, `js/admin.js`/`.min.js` — cache-bust stamps and unrelated minified bundles from the whole-project `npm run build`) was left uncommitted in the working tree per the plan's `files_modified_note`; a later plan or the orchestrator's own build step will regenerate it cleanly rather than this plan committing unrelated churn.

## Self-Check: PASSED

- FOUND: js/brewpad.js, brewpad.html, css/brewpad.css, tests/frontend/brewpad-waitlist.test.js, js/brewpad.min.js, css/brewpad.min.css, .planning/phases/78-.../78-03-SUMMARY.md
- FOUND: commits 8afb671a, ce79b221, f26aacdb, c1d07cb8 in `git log --oneline --all`

---
*Phase: 78-brewpad-waitlist-tracking-make-the-beer-waitlist-a-workable-*
*Completed: 2026-09-02*

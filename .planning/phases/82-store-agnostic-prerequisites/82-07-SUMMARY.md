---
phase: 82-store-agnostic-prerequisites
plan: 07
subsystem: api
tags: [frontend, admin-panel, google-sheets, apps-script, proxy, jest, es5]

# Dependency graph
requires:
  - phase: 82-store-agnostic-prerequisites
    provides: "82-03's 6 typed write actions + get_ingredients/get_homepage reads on
      adminApi.gs's server_token dispatch; 82-04's /api/admin/proxy 39-action
      allowlist; 82-06's adminApiGet/adminApiPost proxy transport (reads-retry,
      writes-once, 401-only-logout) and the note that sheetsGet/sheetsUpdate/
      sheetsAppend/colLetter still had live callers this plan was scoped to finish"
provides:
  - "Every remaining direct-Google-Sheets-API call site in js/admin.js rewired onto
    /api/admin/proxy: update_inventory_cells, append_inventory_row, add_hold,
    import_kits, append_schedule_slots, update_schedule_slots, get_homepage"
  - "sheetsGet/sheetsUpdate/sheetsAppend and the now-orphaned colLetter helper
    deleted outright (zero remaining callers)"
  - "admin.html no longer loads js/admin-config.js (ADMIN_API_URL has no consumer
    left in admin.js); kiosk.html/brewpad.html keep loading it"
  - "js/admin.js contains zero 'sheets.googleapis.com' data-call URLs -- the Google
    OAuth token is used only at login (D-06)"
affects: [82-09-rollout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "inventoryCellsUpdate(sheetKey, updates) / scheduleSlotsUpdate(updates) --
      thin wrappers around adminApiPost that no-op to Promise.resolve() when the
      updates array is empty, so a saveAllChanges-style caller can unconditionally
      call the helper for both sheets and still issue exactly one real fetch per
      sheet that actually changed"
    - "Server-authoritative skip handling: toggleSlot/bulkUpdateDay/
      resetDayToDefault/resetMonthToDefaults all read result.skipped from
      update_schedule_slots and only flip local slot.status for rows NOT in that
      list -- the client no longer decides booked-slot protection, it just obeys
      the server's decision (T-82-03-04)"

key-files:
  created:
    - tests/frontend/admin-inventory-proxy.test.js
    - tests/frontend/admin-schedule-homepage-proxy.test.js
  modified:
    - js/admin.js
    - js/admin.min.js
    - admin.html
    - kiosk.html
    - brewpad.html
    - index.html

key-decisions:
  - "Dropped the client-side scheduleHeaders.indexOf('status') existence guards
    (including the resetMonthToDefaults 'Cannot find status column' toast) from
    all four rewired scheduling write functions -- these guards existed only to
    resolve a column letter for the direct-Sheets range address; the typed
    update_schedule_slots action resolves the status column server-side, so the
    guard was dead code post-rewire (would have failed ESLint's no-unused-vars
    gate had it been kept). No behavior a user can trigger changes: scheduleData
    always carries a 'status' key from parseSheetData regardless of headers."
  - "openManualHoldModal's add_hold payload sends qty as a number (parseInt result,
    already numeric) and hold_id in the exact /^H-\\d{8}-M\\d{3}$/ shape
    buildManualHoldRow's validator (82-03) requires -- no format change was needed,
    the existing holdId construction already produced a compliant value."

requirements-completed: [DB-01]

# Metrics
duration: ~45min
completed: 2026-09-23
---

# Phase 82 Plan 07: admin.js Direct-Sheets-API Rewire (Final Cutover) Summary

**Every remaining js/admin.js function that called the Google Sheets API directly (holds, kit/ingredient inventory, supplier-order sync, CSV import, scheduling, homepage) now writes/reads through `/api/admin/proxy`'s typed actions; `sheetsGet`/`sheetsUpdate`/`sheetsAppend`/`colLetter` are deleted and `admin-config.js` no longer loads on `admin.html`.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3 completed (Task 1 TDD: RED `658b1788` → GREEN `5dd74172`; Task 2 TDD: RED `b536a083` → GREEN `db39380d`; Task 3: single commit `74fad5bb`)
- **Files modified:** 6 (2 created, 4 modified in-scope; `js/admin.min.js` rebuilt)

## Accomplishments

- **Task 1 (D-21):** `updateKitStockAfterConfirm`, `updateKitOnHoldAfterRelease`, `openManualHoldModal`, `saveAllChanges`, `openAddKitModal`, `openAddIngredientModal`, `deleteIngredient`, `syncOnOrder`, `acceptDelivery`, and `applyImport` all now write through the new `inventoryCellsUpdate(sheetKey, updates)` helper (`update_inventory_cells`) or a direct `adminApiPost` call (`add_hold`, `append_inventory_row`, `import_kits`). Each user action issues exactly one proxy write per sheet touched — `saveAllChanges` with kit + ingredient edits issues at most two calls (one per sheet), never a per-cell loop. `syncOnOrder` no longer gates on the Google `accessToken` (D-06) — it runs purely off the session-authenticated proxy.
- **Task 2 (D-21):** `generateSlotsForMonth`, `toggleSlot`, `bulkUpdateDay`, `resetDayToDefault`, and `resetMonthToDefaults` route through the new `scheduleSlotsUpdate(updates)` helper (`update_schedule_slots`) or `adminApiPost('append_schedule_slots', ...)`. All four status-write functions now read `result.skipped` from the server response and only flip local slot state for rows the server actually wrote — a row the server found already `booked` (re-checked under its own lock, per 82-03) stays untouched client-side too, closing the loop on T-82-03-04's booked-slot protection. `loadHomepageData` calls `adminApiGet('get_homepage')` and slices each returned row to `[0..5)` to preserve the old `!A:E` column-range restriction, with identical downstream parsing.
- **Task 3 (D-16, D-17, D-23):** `sheetsGet`/`sheetsUpdate`/`sheetsAppend` (zero remaining callers, grep-confirmed) and the now-orphaned `colLetter` helper (zero remaining callers after Tasks 1–2) are deleted outright. `admin.html`'s `<script src="js/admin-config.js" defer>` tag is removed — `ADMIN_API_URL`, its only export, has no consumer left in `admin.js` — while `js/admin-config.js` itself stays untouched and still loads on `kiosk.html`/`brewpad.html`. `js/admin.js` and `js/admin.min.js` now contain zero `sheets.googleapis.com` references; the only Google-domain string left is the GIS OAuth scope at login. `npm run build` regenerated `js/admin.min.js`; `kiosk.html`/`brewpad.html`/`index.html` carry only the shared build pipeline's cache-bust stamp bump (all three plus `admin.html` are declared in this plan's `files_modified`). Every other page the build touches (19 marketing/catalogue pages) was reverted via `git checkout --` twice — once after `npm run build`, once after `scripts/check-artifact-drift.sh`'s own internal rebuild — matching 82-06's established precedent.

## Task Commits

Each task was committed atomically (TDD: test commit then feat commit):

1. **Task 1 (RED): add failing tests for inventory/holds/orders/import proxy rewire** — `658b1788` (test)
2. **Task 1 (GREEN): rewire holds/inventory/supplier-orders/import onto the proxy (D-21)** — `5dd74172` (feat)
3. **Task 2 (RED): add failing tests for scheduling/homepage proxy rewire** — `b536a083` (test)
4. **Task 2 (GREEN): rewire Scheduling flows and the Homepage load onto the proxy (D-21)** — `db39380d` (feat)
5. **Task 3: delete Sheets helpers, drop admin-config.js from admin.html (D-16, D-17, D-23)** — `74fad5bb` (feat)

**Plan metadata:** this SUMMARY, committed separately per this plan's instructions (orchestrator owns STATE.md/ROADMAP.md).

## Files Created/Modified

- `js/admin.js` — Added `inventoryCellsUpdate`/`scheduleSlotsUpdate` proxy-write helpers; rewired the 10 inventory/holds/orders/import functions and the 6 scheduling/homepage functions listed above onto typed `/api/admin/proxy` actions; deleted `sheetsGet`/`sheetsUpdate`/`sheetsAppend`/`colLetter`; module exports gained `_inventoryForTest`, `_scheduleForTest`, `_getHomepageConfigForTest`, and `_setSheetStateForTest` (test seams, no behavior change).
- `js/admin.min.js` — rebuilt via `npm run build` (zero `sheets.googleapis.com` references; contains `/api/admin/proxy`).
- `admin.html` — `<script src="js/admin-config.js" defer>` removed; cache-bust stamps bumped (build side effect).
- `kiosk.html` / `brewpad.html` / `index.html` — cache-bust stamps bumped (build side effect; unchanged functionally).
- `tests/frontend/admin-inventory-proxy.test.js` (new) — 21 tests: 12 flow/parity tests covering all 10 rewired inventory/holds/orders/import functions (one-call-per-sheet assertions, header-ordered append rows, booked-slot-adjacent error-toast parity, `accessToken === null` for `syncOnOrder`) plus a 10-function source-shape sweep asserting no `sheetsUpdate(`/`sheetsAppend(`/`colLetter(` remains in any rewired function body.
- `tests/frontend/admin-schedule-homepage-proxy.test.js` (new) — 14 tests: 8 flow/parity tests (including the skipped-row non-mutation case and full homepage-parsing parity) plus a 6-function source-shape sweep.

## Decisions Made

See frontmatter `key-decisions` — both are implementation-detail judgment calls (dead-code guard removal; confirming an existing value already matched a new validator's format) that change no user-visible behavior or acceptance criterion.

## Deviations from Plan

None — plan executed exactly as written. Both `<action>` steps' worked payload shapes (numeric `value` fields, exact `add_hold` field names, `result.skipped` handling) matched the implementation with no adjustment needed.

## Milestone Gap (D-21, flagged per plan instruction — not new, restated from 82-03-SUMMARY.md)

Ingredients, the Schedule sheet, and the Homepage sheet now sit fully behind `/api/admin/proxy` but have no destination in Phases 83–88's Postgres migration scope (Schedule/Homepage are explicitly staying Sheets-backed per the v4.9 milestone's owner decision; Ingredients has no assigned migration phase). This is a milestone-level gap for the owner to resolve in a future phase — this plan's job was only to remove the browser's direct Sheets/Apps-Script dependency, which is now done for 100% of `admin.js`.

## Issues Encountered

- `zoho-middleware/node_modules` was absent in this fresh worktree — ran `npm ci` in `zoho-middleware/` before running its test suite, per CLAUDE.md's "always cd first" rule (environment setup, not a plan deviation).
- `npm run build` and `scripts/check-artifact-drift.sh` (which runs its own internal `npm run build`) both re-stamp ~19 marketing/catalogue pages outside this plan's declared scope — reverted via `git checkout --` after each run, matching 82-06's established precedent.
- The worktree's HEAD was initially on a stale/diverged commit (`46f11b31`, unrelated milestone-tracking history) rather than the expected phase-82 base (`965ba351`); corrected via `git reset --hard 965ba3515a10723bd6c75e0479859973fc8c7a03` per this executor's own startup safety check before any plan work began.

## User Setup Required

None — no external service configuration required. This plan only repoints `admin.js`'s remaining direct-Sheets call sites at Apps Script actions and a middleware route already deployed by 82-03/82-04; the Apps Script redeploy that makes the server-side halves of 82-03 live, and the staging/production rollout of this browser change, are both sequenced in 82-09 (D-19).

## Next Phase Readiness

- `js/admin.js` has zero remaining direct Google Sheets API or unauthenticated Apps-Script data paths — every admin-panel data read/write (kits, ingredients, holds, reservations, schedule, homepage, batches, recipes) now flows through the session-authenticated `/api/admin/proxy`. DB-01's "no browser code talks to Apps Script or the Google Sheets API for data" criterion for `js/admin.js` is complete.
- Full frontend suite: 138 suites / 2026 tests green (includes this plan's 35 new tests). Full middleware suite: 114 suites / 1705 tests green (unchanged — this plan touches no middleware files). Root lint clean (`--max-warnings 0`). `scripts/check-artifact-drift.sh` PASSED (no drift between source and built artifacts).
- Ready for 82-09 (Apps Script redeploy of 82-03's actions + staging/production rollout of the full 82-x wave, including this plan's browser-side cutover). No blockers.

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*

## Self-Check: PASSED

- FOUND: js/admin.js
- FOUND: js/admin.min.js
- FOUND: admin.html
- FOUND: kiosk.html
- FOUND: brewpad.html
- FOUND: index.html
- FOUND: tests/frontend/admin-inventory-proxy.test.js
- FOUND: tests/frontend/admin-schedule-homepage-proxy.test.js
- FOUND commit: 658b1788 (test, RED, Task 1)
- FOUND commit: 5dd74172 (feat, GREEN, Task 1)
- FOUND commit: b536a083 (test, RED, Task 2)
- FOUND commit: db39380d (feat, GREEN, Task 2)
- FOUND commit: 74fad5bb (feat, Task 3)

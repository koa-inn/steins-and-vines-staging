---
phase: 82-store-agnostic-prerequisites
plan: 03
subsystem: api
tags: [apps-script, google-sheets, locking, admin-panel, inventory, scheduling]

# Dependency graph
requires:
  - phase: 82-store-agnostic-prerequisites
    provides: "82-02's lock fixes + D-11 doPost server_token dispatch pattern; 82-04's /api/admin/proxy allowlist already containing get_ingredients + the 6 new write action names"
provides:
  - "get_ingredients read action (getIngredients(), getDisplayValues() shape matching parseSheetData(..., 'ingredients'))"
  - "get_homepage display-value parity (getHomepage() switched getValues() -> getDisplayValues())"
  - "6 typed, allowlisted, locked write actions: update_inventory_cells, append_inventory_row, import_kits, add_hold, append_schedule_slots, update_schedule_slots — each behind server_token only, never the staff switch"
  - "7 pure validator/planner helpers backing the 6 write actions, independently unit-tested"
  - "Deletion of the 3 true zero-caller actions: get_config, update_schedule, update_kits (case + function)"
affects: [82-07-admin-js-rewire, 82-09-rollout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure validator extracted per typed write action (resolveInventorySheetName / validateInventoryCellUpdates / validateAppendRow / validateKitsImport / buildManualHoldRow / validateScheduleSlotRows / planScheduleSlotUpdates), each unit-tested via the loadAdminApi() new-Function factory — same technique as 82-02's batchDedupDecision/_uniqueBatchIds"
    - "Impure wrapper shape: resolve/fix sheet -> acquireScriptLock(15000) -> validate via pure helper -> sanitizeInput every string -> write -> release lock in finally — applied identically across all 6 new write actions"
    - "Source-shape assertions via sliceFunctionSource(src, name) + serverTokenSubBlock()/staffSwitchBlock() slicing, copied verbatim from adminapi-phase82-dispatch.test.js, since SpreadsheetApp/LockService/CacheService cannot be stubbed"

key-files:
  created:
    - tests/frontend/adminapi-phase82-inventory-actions.test.js
  modified:
    - apps-script/adminApi.gs

key-decisions: []

requirements-completed: [DB-01]

# Metrics
duration: ~25min
completed: 2026-09-23
---

# Phase 82 Plan 03: Apps Script typed inventory/schedule actions + dead-action deletion Summary

**Added `get_ingredients` plus six typed, locked, header-name-addressed write actions (update_inventory_cells, append_inventory_row, import_kits, add_hold, append_schedule_slots, update_schedule_slots) to `adminApi.gs`'s `server_token` dispatch, backed by seven independently pure-tested validators, and deleted the three actions a repo-wide grep confirmed have zero live callers (`get_config`, `update_schedule`, `update_kits`) — `get_homepage` is kept and switched to display-value parity since it gains a real caller in 82-07.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 completed (both TDD: RED then GREEN)
- **Files modified:** 1 source file (`apps-script/adminApi.gs`), 1 new test file

## Accomplishments

- `INGREDIENTS_SHEET_NAME` constant + `getIngredients()` (mirrors `getKits()`, `getDisplayValues()` shape) registered as `case 'get_ingredients'` in `handleReadAction` — the browser's direct Google Sheets API Ingredients read (D-15) now has a middleware-proxied equivalent, already on 82-04's `ADMIN_PANEL_PROXY_READS` allowlist.
- `getHomepage()` switched from `getValues()` to `getDisplayValues()` (D-21) for display-string parity with the direct-Sheets-API read it replaces once 82-07 wires `admin.js`'s `loadHomepageData` caller onto it. Pre-change grep confirmed the only current references to `get_homepage`/`getHomepage` are the definition itself and 82-04's already-shipped allowlist/test — no live caller exists yet to break.
- Seven pure, independently unit-tested helpers back the six new write actions: `resolveInventorySheetName`, `validateInventoryCellUpdates`, `validateAppendRow`, `validateKitsImport`, `buildManualHoldRow`, `validateScheduleSlotRows`, `planScheduleSlotUpdates`. None references `SpreadsheetApp`/`LockService`/`CacheService`/`PropertiesService` (purity-asserted in the test suite).
- Six impure wrapper functions (`updateInventoryCells`, `appendInventoryRow`, `importKits`, `addManualHold`, `appendScheduleSlots`, `updateScheduleSlots`) each: resolve/fix their target sheet, acquire `acquireScriptLock(15000)`, call their pure validator before any write, sanitize every string value with `sanitizeInput`, write, and release the lock in a `finally`. Wired into `doPost`'s `server_token` branch only — never the staff switch (T-82-03-07), so no browser caller can reach them directly ahead of the D-19 cutover.
- `updateScheduleSlots` re-reads each requested row's current status under the lock before deciding to write; any row already `'booked'` is skipped rather than overwritten (T-82-03-04), and `'booked'` itself is never accepted as a target status.
- Deleted `get_config`/`getConfig()`, `update_schedule`/`updateSchedule()`, and `update_kits`/`updateKits()` (case + function each) after a repo-wide grep confirmed zero remaining callers — see the exact grep output under Deviations/Decisions below. `get_homepage` and `check_auth` are explicitly retained; `check_auth` now carries the D-16/D-19 comment noting it stays until the old browser `admin.js` path is fully cut over.

## Task Commits

Each task was committed atomically (TDD: test commit then feat commit):

1. **Task 1: Pure validators + get_ingredients/get_homepage reads (D-15, D-21)** — `ce1eeaa9` (test, RED) → `08d4d22f` (feat, GREEN)
2. **Task 2: Wire 6 write actions into doPost + delete 3 dead actions** — `3d33c43d` (test, RED) → `5c249c29` (feat, GREEN)

**Plan metadata:** commit pending (this SUMMARY, made by the orchestrator after all wave agents complete — per this plan's instructions this executor does not touch STATE.md/ROADMAP.md).

## Files Created/Modified

- `apps-script/adminApi.gs` — `INGREDIENTS_SHEET_NAME` constant; `getIngredients()` (new); `getHomepage()` (`getValues()` → `getDisplayValues()`); 7 new pure helpers (`resolveInventorySheetName`, `validateInventoryCellUpdates`, `validateAppendRow`, `validateKitsImport`, `buildManualHoldRow`, `validateScheduleSlotRows`, `planScheduleSlotUpdates`); 6 new impure write wrappers (`updateInventoryCells`, `appendInventoryRow`, `importKits`, `addManualHold`, `appendScheduleSlots`, `updateScheduleSlots`); `doPost`'s `server_token` branch gains 6 new `if (action === '...')` entries; `handleReadAction` gains `case 'get_ingredients'`; deleted `case 'get_config'` + `getConfig()`, staff-switch `case 'update_schedule'` + `updateSchedule()`, staff-switch `case 'update_kits'` + `updateKits()`; `check_auth` case gains a retention comment.
- `tests/frontend/adminapi-phase82-inventory-actions.test.js` (new) — 111 tests: whole-file eval gate, `INGREDIENTS_SHEET_NAME` + `get_ingredients`/`get_homepage` source-shape, 7 pure-helper behavior contracts (from the plan's exact `<behavior>` examples), purity assertions, `doPost` server_token dispatch of the 6 write actions (never in the staff switch), each wrapper's lock-acquire/release + validate-before-write source shape, and the 3 deletions + `check_auth`/`get_homepage`/`CONFIG_SHEET_NAME` retention.

## Decisions Made

None beyond what the plan/CONTEXT already specified — D-15, D-21, and D-02-as-amended-by-D-21 were followed as written. One implementation-only choice (Claude's Discretion, not owner-facing): `validateAppendRow(headers, values)`'s parameter order was resolved as `(headers, values)` rather than the plan action text's literal `validateAppendRow(values, headers)` naming, because only that order makes the plan's own worked example (`validateAppendRow(['a','b','c'], ['x','y']) → ok`) consistent with its adjacent rule (`values longer than headers → invalid_values`) — with `values=['a','b','c']` (len 3) and `headers=['x','y']` (len 2), the rule and the "→ ok" example would directly contradict each other under the literal `(values, headers)` reading. Implemented and named consistently as `(headers, values)` throughout both the helper and its caller (`appendInventoryRow`); every other helper's parameter order was unambiguous and implemented as literally specified.

## Deviations from Plan

None — plan executed exactly as written, aside from the one parameter-order judgment call above (documented as a Decision, not a deviation, since it resolves an internal inconsistency in the plan's own worked example rather than changing scope, behavior, or any acceptance criterion).

### Pre-deletion grep evidence (Task 2, D-02 as amended by D-21)

```
$ grep -rn "get_config\|getConfig\|update_schedule\|updateSchedule\|update_kits\|updateKits" js/ zoho-middleware/ apps-script/ tests/ *.html
zoho-middleware/__tests__/admin-proxy.test.js:12://   (4) every excluded action (check_auth, get_config, update_kits,
zoho-middleware/__tests__/admin-proxy.test.js:174:  'add_hold', 'append_schedule_slots', 'update_schedule_slots'
zoho-middleware/__tests__/admin-proxy.test.js:178:  'check_auth', 'get_config', 'update_schedule', 'update_kits',
zoho-middleware/routes/pos.js:4149:  update_schedule_slots: true
apps-script/adminApi.gs:168:    case 'get_config':
apps-script/adminApi.gs:169:      return { ok: true, data: getConfig() };
apps-script/adminApi.gs:430:      case 'update_schedule':
apps-script/adminApi.gs:431:        return _jsonResponse(updateSchedule(payload));
apps-script/adminApi.gs:436:      case 'update_kits':
apps-script/adminApi.gs:437:        return _jsonResponse(updateKits(payload));
apps-script/adminApi.gs:785:function getConfig() {
apps-script/adminApi.gs:1175:function updateSchedule(payload) {
apps-script/adminApi.gs:1250:function updateKits(payload) {
```

Every hit outside `adminApi.gs`'s own definitions is either 82-04's `admin-proxy.test.js` **documenting these three as EXCLUDED (not allowlisted)** — proof of absence of a caller, not presence of one — or an unrelated substring match (`update_schedule_slots`, a *different*, newly-added action name that happens to contain the substring `update_schedule`). No live caller found for `get_config`, `update_schedule`, or `update_kits` anywhere in `js/`, `zoho-middleware/`, `tests/`, or any HTML page. Safe to delete per D-02's own instruction to re-grep before each deletion.

### ROADMAP correction (per plan's explicit instruction)

ROADMAP criterion 2's "7 zero-caller actions" is corrected: D-02 said 4; D-21 keeps `get_homepage` (it gains a caller in 82-07) → **3 deleted** (`get_config`, `update_schedule`, `update_kits`). `update_kits`/`update_schedule` are superseded functionally by `update_inventory_cells` / `append_schedule_slots` / `update_schedule_slots`.

## Milestone Gap (D-21, flagged per plan instruction)

Ingredients/Schedule/Homepage have no destination in Phases 83–88's Postgres migration plan — `get_ingredients`, the Schedule sheet, and the Homepage sheet stay Sheets-backed indefinitely behind this proxy, with no phase currently scoped to migrate them. This is a milestone-level gap for the owner to resolve in a future phase, not something this plan resolves. A code comment above `getIngredients()` in `adminApi.gs` records the same note.

## 82-04 Proxy Allowlist Coverage (per this plan's own routing instruction)

The plan's routing note asked this executor to check whether the new typed actions need adding to 82-04's `/api/admin/proxy` allowlist. They do NOT need any change: 82-04's `zoho-middleware/__tests__/admin-proxy.test.js` (merged at this plan's base commit) already lists `get_ingredients` in its 15-action `READS` array and all 6 new write actions (`update_inventory_cells`, `append_inventory_row`, `import_kits`, `add_hold`, `append_schedule_slots`, `update_schedule_slots`) in its 24-action `WRITES` array — 82-04 was planned with foreknowledge of this plan's exact action list. `zoho-middleware/routes/pos.js` was NOT touched by this plan (confirmed by `git status` throughout both tasks), avoiding any collision with 82-05's concurrent edits to that same file.

## Issues Encountered

`zoho-middleware/node_modules` was absent in this fresh worktree (pre-existing environment gap, unrelated to any file this plan touches). Ran `npm ci` in `zoho-middleware/` so `cd zoho-middleware && npm test` could run per CLAUDE.md's before-commit rule. Result: 112 suites / 1687 tests, all green, unchanged from the 82-04 baseline (no middleware files were modified by this plan).

## User Setup Required

None — no external service configuration required. The Apps Script redeploy that takes these changes live is sequenced in a later plan (82-09) alongside the rest of Phase 82's rollout (D-19).

## Next Phase Readiness

- `apps-script/adminApi.gs` now exposes `get_ingredients` plus the 6 typed, locked write actions 82-07 needs to rewire `admin.js`'s ~15 direct-Sheets-API call sites onto `/api/admin/proxy`, and has lost exactly the 3 genuinely dead actions (`get_config`, `update_schedule`, `update_kits`) — still safe to redeploy ahead of the browser cutover since nothing with a live caller was removed.
- 111 new/updated tests pass (`adminapi-phase82-inventory-actions.test.js`: 111; `adminapi-phase82-dispatch.test.js` and `adminapi-phase82-locks.test.js` re-verified unaffected). Full frontend suite: 134 suites / 1975 tests green. Full middleware suite: 112 suites / 1687 tests green (unchanged). Root lint clean.
- Ready for 82-07 (admin.js rewire onto `/api/admin/proxy`) and 82-09 (Apps Script redeploy + rollout). No blockers.

---
*Phase: 82-store-agnostic-prerequisites*
*Completed: 2026-09-23*

## Self-Check: PASSED

- FOUND: apps-script/adminApi.gs
- FOUND: tests/frontend/adminapi-phase82-inventory-actions.test.js
- FOUND: .planning/phases/82-store-agnostic-prerequisites/82-03-SUMMARY.md
- FOUND commit: ce1eeaa9 (test, RED, Task 1)
- FOUND commit: 08d4d22f (feat, GREEN, Task 1)
- FOUND commit: 3d33c43d (test, RED, Task 2)
- FOUND commit: 5c249c29 (feat, GREEN, Task 2)

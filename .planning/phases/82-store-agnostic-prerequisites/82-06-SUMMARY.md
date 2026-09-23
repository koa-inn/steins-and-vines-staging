---
phase: 82-store-agnostic-prerequisites
plan: 06
subsystem: api
tags: [frontend, admin-panel, middleware-seam, jest, es5, brewpad-pattern, retry, session-auth]

# Dependency graph
requires:
  - phase: 82-store-agnostic-prerequisites
    provides: "82-04's POST /api/admin/proxy (session-gated, 39-action allowlist,
      forwardToAppsScript helper) and 82-03's get_ingredients read action +
      6 typed write actions already on that allowlist"
provides:
  - "js/admin.js's adminApiGet/adminApiPost routed exclusively through
    MIDDLEWARE_URL + /api/admin/proxy -- zero remaining ADMIN_API_URL branches
    or direct-Sheets fallbacks in loadAllData, loadReservationsPage,
    initFilterListeners, renderReservationsTab, confirmHold, releaseHold,
    setReservationStatus, checkReservationStatus, saveHomepageToSheets"
  - "Reads retry twice on transient 502/503/504 or a network rejection; writes
    are sent exactly once (not even a network rejection is retried) -- D-08,
    stricter than js/brewpad.js's Phase 76-03 write behavior"
  - "401-only logout: isUnauthorizedError/handleUnauthorized (body-substring
    detection) deleted outright; enterLoggedOutState() fires only on a real
    middleware res.status === 401 via handleProxyResponse"
  - "batch_id present on every batch-mutating adminApiPost call site except
    the calendar-view multi-batch bulk save (deliberately deferred to 82-02's
    server-side per-task cache bust, documented inline)"
  - "Ingredients loaded via adminApiGet('get_ingredients') in the same
    Promise.all as kits/holds/schedule/dashboard-summary -- no more direct
    Google Sheets API call from the browser for this data"
  - "sheetsBatchUpdate deleted (confirmed zero callers); check_auth pre-check
    removed from sheetsUpdate/sheetsAppend (not on the proxy allowlist)"
affects: [82-07-admin-js-rewire, 82-09-rollout]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "fetchWithRetry(url, options, retries, retryStatuses) cloned from
       js/brewpad.js Phase 76-03 -- reads pass [502,503,504] + retries:2,
       writes pass retries:0 (no retryStatuses at all, stricter than brewpad.js)"
    - "handleProxyResponse(r) single response-shape handler: real 401 ->
       enterLoggedOutState() + throw; otherwise parse JSON and throw on
       !r.ok || !data.ok, mirrors js/brewpad.js's _handleMiddlewareResponse
       role but inlined into the two call sites rather than a global fetch
       interceptor (admin.js's fetch-wrapper IIFE only injects the session
       header, it does not intercept responses)"
    - "Re-entrancy guard var renamed _handlingUnauthorized -> _enteringLoggedOut
       to match the renamed enterLoggedOutState() function"

key-files:
  created:
    - tests/frontend/admin-batch-id-cache-bust.test.js
    - tests/frontend/admin-proxy-transport.test.js
  modified:
    - js/admin.js
    - js/admin.min.js
    - admin.html
    - kiosk.html
    - brewpad.html
    - index.html
    - tests/frontend/admin-api-get-token.test.js

key-decisions:
  - "Reused the pre-existing getMwUrl() helper (js/admin.js:~3285, already used
     by the Zoho PO/customer-refresh code) instead of adding a second
     near-duplicate mwUrl() as the plan's reference implementation literally
     showed -- both do the exact same SHEETS_CONFIG.MIDDLEWARE_URL lookup, and
     the plan's own CONTEXT/PATTERNS docs explicitly left this as Claude's
     Discretion (\"either add a small mwUrl() helper ... or inline
     SHEETS_CONFIG.MIDDLEWARE_URL; both are consistent with existing admin.js
     style\"). getMwUrl() is a function declaration, hoisted within the IIFE,
     so calling it from adminApiGet/adminApiPost (defined earlier in the file)
     works with no reordering."
  - "Removed the now-dead statusCol/holdRow-style guard variables left behind
     by each deleted fallback branch (e.g. setReservationStatus's
     'Cannot find status column' pre-check, confirmHold/releaseHold's
     holdRow) rather than leaving them as unused locals -- required for
     ESLint's --max-warnings 0 gate, and each guard existed only to support
     the deleted colLetter()-addressed fallback write."
  - "doUpcomingSave's per-task batch_id is added conditionally
     (if (t.batch_id) payload.batch_id = t.batch_id) rather than
     unconditionally, since t.batch_id is already populated from
     get_tasks_upcoming's row shape (data-batch-id attribute) for every real
     task -- the conditional is defensive, not a behavior gap."

requirements-completed: [DB-01]

# Metrics
duration: ~20min
completed: 2026-09-23
---

# Phase 82 Plan 06: Admin proxy transport + batch_id cache-bust + fallback deletion Summary

**js/admin.js's adminApiGet/adminApiPost now talk exclusively to the session-authenticated `/api/admin/proxy` with reads-retry/writes-once/401-only-logout semantics; every `ADMIN_API_URL` branch and direct-Sheets fallback is deleted; Ingredients loads through the proxy; two silent batch-cache-staleness bugs (missing `batch_id` on transfer-task writes) are fixed with regression tests.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3 completed (Task 1 TDD: RED→GREEN; Task 2 TDD: RED→GREEN; Task 3: single commit)
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- **D-09 (batch_id cache-bust, Task 1):** `showTransferPrompt`'s transfer-confirm and skip-transfer `update_batch_task` payloads now carry `batch_id` — Apps Script's `_invalidateBatchCache(payload.batch_id)` was previously receiving `undefined` on these two call sites, leaving the `gb:<batchId>` cache entry (300s TTL) never busted after completing a transfer task (a genuine, previously-undocumented bug found during Phase 82 research). Also added `batch_id` to `openBatchDetail`'s per-batch bulk task save and `doUpcomingSave`'s per-task saves. The calendar-view multi-batch bulk save is deliberately left without a single `batch_id` — 82-02 already closed that staleness class server-side via per-task `_uniqueBatchIds` busting — with an inline comment pointing to that fix instead of re-solving it here.
- **D-05/D-06/D-08 (proxy transport, Task 2):** `adminApiGet`/`adminApiPost` keep their exact call signatures (55 call sites untouched) but now POST JSON to `MIDDLEWARE_URL + '/api/admin/proxy'` with `credentials:'include'` — no Google access token is sent on any data call. Reads retry twice on transient 502/503/504 or a network rejection (mirrors `js/brewpad.js`'s Phase 76-03 pattern); writes are sent exactly once — not even a network rejection is retried, which is intentionally **stricter** than `js/brewpad.js` (a dropped connection can follow a write Apps Script already applied).
- **D-07 (401-only logout, Task 2):** `isUnauthorizedError`/`handleUnauthorized` (the body-substring `"unauthorized"` detection path) are deleted outright. `handleProxyResponse` now fires `enterLoggedOutState()` (renamed from `handleUnauthorized`, same body, re-entrancy guard renamed `_enteringLoggedOut`) **only** on a real `res.status === 401`; a body-level `{ok:false, message:'unauthorized'}` from an upstream Apps-Script response now rejects the call without touching the sign-in screen or clearing the session.
- **D-22 (test amendment, Task 2):** Amended only the second `runAdminApiGetTokenSuite({...})` argument (the `admin.js` settings block) in `tests/frontend/admin-api-get-token.test.js` to the new D-06/D-07 contract, mirroring Phase 76-03's identical amendment to the `brewpad.js` block. Verified via `git diff` that the change touches only lines inside that one object literal — the shared suite body and the `brewpad.js` settings object are byte-identical to before.
- **D-15/D-16 (fallback deletion, Task 3):** `loadAllData`'s `if (SHEETS_CONFIG.ADMIN_API_URL) { ... } else { <direct Sheets fallback> }` wrapper is gone — the single `Promise.all` now always loads kits/reservations/holds/schedule/dashboard-summary via the proxy plus a new `adminApiGet('get_ingredients')` sixth read (Apps Script side already shipped in 82-03; already on 82-04's proxy allowlist). Every other `if (SHEETS_CONFIG.ADMIN_API_URL)`-gated branch is unwrapped and its fallback deleted: `loadReservationsPage`, `initFilterListeners`, `renderReservationsTab`, `confirmHold`, `releaseHold`, `setReservationStatus`, `checkReservationStatus`, `saveHomepageToSheets`. `finishDataLoad`'s batch-dashboard-summary wrapper now calls `loadBatchDashboardSummary()` unconditionally.
- **D-16 orphan cleanup:** `sheetsBatchUpdate` deleted outright (grep-confirmed zero callers anywhere in `js/` or `tests/` both before and after this plan's edits). The `check_auth` pre-check is removed from `sheetsUpdate`/`sheetsAppend` (that action is not on the `/api/admin/proxy` allowlist and would now 400) — after this change `admin.js` calls no such pre-check action anywhere. `sheetsGet`/`sheetsUpdate`/`sheetsAppend` and `colLetter` are intentionally kept (still have live callers in the ~15 direct-Sheets-API functions 82-07 rewires); `saveHomepageToSheets` keeps its name (only its `else` direct-Sheets branch was deleted, per plan step 6 — it remains the live Homepage save-button handler).
- **D-23 (rebuild):** `npm run build` regenerated `js/admin.min.js` (verified it now contains `/api/admin/proxy`) and, as an unavoidable side effect of the shared build pipeline, re-stamped the cache-bust query strings on `admin.html`/`kiosk.html`/`brewpad.html`/`index.html`. Every other page `npm run stamp:pages` touches was reverted via `git checkout --` twice (once after `npm run build`, once after `scripts/check-artifact-drift.sh` ran its own internal build) since they carry zero functional change and are outside this plan's declared `files_modified`.

## Batch_id audit (Task 1, per plan instruction)

`grep -n "adminApiPost('\(update_batch\|update_batch_task\|add_batch_task\|bulk_add_plato_readings\|update_plato_reading\|delete_plato_reading\|delete_batch\|update_batch_schedule\|regenerate_batch_token\|bulk_update_batch_tasks\)'" js/admin.js` — every site inspected:

| Line (post-fix) | Action | batch_id present? |
|---|---|---|
| `update_batch` (5 sites: activate-list-btn, activate-detail-btn, save-location, save-notes, zoho-refresh, status-change, schedule-activate step 1) | `update_batch` | Yes (all) |
| `delete_batch` (2 sites) | `delete_batch` | Yes (all) |
| `regenerate_batch_token` | `regenerate_batch_token` | Yes |
| `update_batch_task` (transfer-confirm) | `update_batch_task` | **Yes — fixed this plan** |
| `update_batch_task` (skip-transfer) | `update_batch_task` | **Yes — fixed this plan** |
| `add_batch_task` | `add_batch_task` | Yes |
| `bulk_update_batch_tasks` (per-batch, openBatchDetail) | `bulk_update_batch_tasks` | **Yes — fixed this plan** |
| `delete_plato_reading` | `delete_plato_reading` | Yes |
| `bulk_add_plato_readings` | `bulk_add_plato_readings` | Yes |
| `update_plato_reading` | `update_plato_reading` | Yes |
| `update_batch_schedule` | `update_batch_schedule` | Yes |
| `update_batch_task` (doUpcomingSave, per task) | `update_batch_task` | **Yes (conditional on t.batch_id) — fixed this plan** |
| `bulk_update_batch_tasks` (calendar view, multi-batch) | `bulk_update_batch_tasks` | **No, by design** — spans multiple batches; 82-02 fixed this server-side via per-task `_uniqueBatchIds` busting; inline comment added pointing to that fix. |

## Task Commits

Each task was committed atomically (TDD: RED then GREEN):

1. **Task 1 (RED): add failing tests for missing batch_id** — `8bf049fb` (test)
2. **Task 1 (GREEN): add batch_id to every batch-mutating task write (D-09)** — `38b5e4f2` (feat)
3. **Task 2 (RED): add failing tests for the proxy transport rewrite + D-22 amendment** — `9aaafcc9` (test)
4. **Task 2 (GREEN): route admin.js data calls through /api/admin/proxy (D-05..D-08)** — `d98912ec` (feat)
5. **Task 3: delete every ADMIN_API_URL fallback, load Ingredients via the proxy, rebuild (D-15, D-16, D-23)** — `2d9d9f1b` (feat)

**Plan metadata:** this SUMMARY, committed separately per this plan's instructions (orchestrator owns STATE.md/ROADMAP.md).

## Files Created/Modified

- `js/admin.js` — `fetchWithRetry` rewritten with `retryStatuses` param; `isUnauthorizedError`/`handleUnauthorized` deleted, replaced by `enterLoggedOutState()` + `handleProxyResponse()`; `adminApiGet`/`adminApiPost` repointed to `/api/admin/proxy`; `sheetsBatchUpdate` deleted; `check_auth` pre-check removed from `sheetsUpdate`/`sheetsAppend`; `loadAllData`/`loadReservationsPage`/`initFilterListeners`/`renderReservationsTab`/`confirmHold`/`releaseHold`/`setReservationStatus`/`checkReservationStatus`/`saveHomepageToSheets`/`finishDataLoad` fallback branches deleted; `batch_id` added to `showTransferPrompt`, `bindTaskHandlers`'s bulk save, and `doUpcomingSave`; module.exports seam gains `_showTransferPromptForTest` and `_adminApiPostForTest`.
- `js/admin.min.js` — rebuilt via `npm run build` (contains `/api/admin/proxy`).
- `admin.html` / `kiosk.html` / `brewpad.html` / `index.html` — cache-bust query-string version bumps (build side effect, declared in this plan's `files_modified`).
- `tests/frontend/admin-batch-id-cache-bust.test.js` (new) — 2 regression tests for the transfer-confirm/skip-transfer `batch_id` fix, driven via the new `_showTransferPromptForTest` seam.
- `tests/frontend/admin-proxy-transport.test.js` (new) — 14 tests covering transport (URL/method/credentials/body shape for both helpers), reads-retry (502 retry-then-resolve, 503 exhaustion, network-rejection retry), writes-once (502 and network rejection both reject after exactly one call), 401-only logout (body-level unauthorized vs. real 401), the "no longer rejects when ADMIN_API_URL absent" contract, and two source-shape assertions (no `isUnauthorizedError`/`handleUnauthorized` string anywhere; `adminApiGet`/`adminApiPost` retry-opt-in shape).
- `tests/frontend/admin-api-get-token.test.js` — D-22 amendment: only the second `runAdminApiGetTokenSuite({...})` argument (admin.js settings) changed to the new target contract; verified via `git diff` that no other line moved.

## Decisions Made

- Reused the pre-existing `getMwUrl()` helper instead of adding a second near-duplicate `mwUrl()` (see frontmatter `key-decisions` for full rationale — sanctioned by the plan's own "Claude's Discretion" note).
- Removed now-dead guard variables (`holdRow` in `confirmHold`/`releaseHold`, the `statusCol`/"Cannot find status column" pre-check in `setReservationStatus`, the `filterVal` variable in `renderReservationsTab`) left behind by each deleted fallback branch — required for ESLint's `--max-warnings 0` gate and correct as dead-code removal (Rule 1).
- `doUpcomingSave`'s `batch_id` addition is conditional (`if (t.batch_id) payload.batch_id = t.batch_id`) since `t.batch_id` is already populated from `get_tasks_upcoming`'s row shape for every real task — documented as defensive, not a behavior gap.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test authoring bug: unhandled-rejection false failures in the new proxy-transport suite**
- **Found during:** Task 2 GREEN verification
- **Issue:** Several new tests in `admin-proxy-transport.test.js` created the rejecting promise, awaited `jest.advanceTimersByTimeAsync(...)`, and only THEN attached a `.then(resolve, reject)` handler — by the time the handler attached, the promise had already rejected with no listener, which Jest/Node reports as an unhandled rejection and fails the test even though the underlying implementation was correct.
- **Fix:** Reordered each affected test to attach the `.then(resolve, reject)` handler synchronously, immediately after creating the promise, before awaiting the timer advance.
- **Files modified:** `tests/frontend/admin-proxy-transport.test.js`
- **Verification:** All 14 tests in the suite pass; re-ran the full frontend suite (136/136) and lint (clean) afterward.
- **Committed in:** `d98912ec` (part of the Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (test-authoring bug, no production code impact)
**Impact on plan:** No scope change — this was a test-file correction discovered while verifying the plan's own new test suite, not a change to any acceptance criterion.

## Issues Encountered

- `zoho-middleware/node_modules` was absent in this fresh worktree — ran `npm ci` in `zoho-middleware/` before the first middleware test run, per CLAUDE.md's "always cd first" rule (not a plan deviation, environment setup only).
- `npm run build` and `scripts/check-artifact-drift.sh` (which runs its own internal `npm run build`) both re-stamp ~19 marketing/catalogue pages outside this plan's scope (`stamp:pages`) — reverted via `git checkout --` after each run, matching the pattern already established by 82-08's SUMMARY.

## User Setup Required

None — no external service configuration required. This plan's target (`/api/admin/proxy`) was already deployed by 82-04, and the `get_ingredients` read + 6 typed write actions this plan's Task 3 partially exercises were already deployed by 82-03/82-04. The Apps Script redeploy that makes any of this phase's server-side changes live is sequenced in 82-09 alongside the rest of Phase 82's rollout (D-19) — this plan only repoints the browser's transport, with fetch mocked in tests, so there is no runtime dependency to wire up here.

## Next Phase Readiness

- `js/admin.js`'s generic API helpers (`adminApiGet`/`adminApiPost`) talk only to `/api/admin/proxy` with Phase-76-derived retry/401 semantics; every `ADMIN_API_URL` branch and fallback the CONTEXT/PATTERNS docs identified for this plan's scope is gone; Ingredients loads through the proxy; every currently-known batch-cache-staleness bug this plan could fix without a server-side change is fixed and regression-tested.
- `sheetsGet`/`sheetsUpdate`/`sheetsAppend` and `colLetter` remain live (with real callers in the ~15 direct-Sheets-API functions D-21 scoped to 82-07) — 82-07 is the plan that finishes deleting them.
- Full frontend suite: 136 suites / 1991 tests green (includes this plan's own 16 new tests). Full middleware suite: 114 suites / 1705 tests green (unchanged — this plan touches no middleware files). Root lint clean. `scripts/check-artifact-drift.sh` PASSED (no drift between source and built artifacts).
- Ready for 82-07 (the remaining ~15 direct-Sheets-API admin.js functions: kit stock/on_hold updates, manual hold modal, Kit Inventory/Ingredients saves, Supplier Orders sync, Scheduling slot writes, `applyImport`, `loadHomepageData`) and 82-09 (Apps Script redeploy + staging/prod rollout). No blockers.

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
- FOUND: tests/frontend/admin-batch-id-cache-bust.test.js
- FOUND: tests/frontend/admin-proxy-transport.test.js
- FOUND: tests/frontend/admin-api-get-token.test.js
- FOUND commit: 8bf049fb (test, RED, Task 1)
- FOUND commit: 38b5e4f2 (feat, GREEN, Task 1)
- FOUND commit: 9aaafcc9 (test, RED, Task 2)
- FOUND commit: d98912ec (feat, GREEN, Task 2)
- FOUND commit: 2d9d9f1b (feat, Task 3)

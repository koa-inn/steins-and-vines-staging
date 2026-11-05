---
phase: 97-beer-and-cider-dashboard-sections
fixed_at: 2026-11-05T21:30:00Z
review_path: .planning/phases/97-beer-and-cider-dashboard-sections/97-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
partial: 1
status: partial
---

# Phase 97: Code Review Fix Report

**Fixed at:** 2026-11-05T21:30:00Z
**Source review:** .planning/phases/97-beer-and-cider-dashboard-sections/97-REVIEW.md
**Iteration:** 1
**Scope:** CR-01 and WR-01 to WR-07 (owner-approved 2026-11-05). IN-01 to IN-06 were out of scope.

**Summary:**
- Findings in scope: 8
- Fully fixed: 7
- Partly fixed: 1 (WR-07). The verify/backfill part was stopped because it would change a pre-existing test.
- Skipped: 0

Each fix has a regression test that was written first and seen to fail. The tests are new cases in Phase 97's own test files. No test from before 8a2184d6 was modified.

Final gate, run in the review-fix worktree:
- root `npm test`: 248 suites / 3398 tests passed
- root `npm run lint`: clean
- middleware `nvm exec 24 npm test`: 298 suites / 4055 tests passed
- middleware `npm run lint`: clean
- `npm run test:db` for `recipe-pg-target-gravity` and `recipe-pg-update`: 16/16 passed

`js/brewpad.min.js` was rebuilt and committed with each JS change. Changes that were only stamps (HTML `?v=` and `admin.js` BUILD_TIMESTAMP) were discarded.

## Needs confirmation on staging (orchestrator / owner)

1. **CR-01, Cal.com `status`:** `listBookings` now makes **two calls per page in parallel**, `status=upcoming` and `status=past`, and merges them by `uid`. I could not confirm that the 2026-05-01 list endpoint accepts a comma list for `status`, so the code does not rely on it. To confirm on staging:
   - after a booking from earlier today has ended, the calendar still shows it and the batch's task does not read "not booked yet";
   - `/api/admin/packaging-bookings` logs `ok bookings=N` with no 4xx from Cal.com for `status=past`.

   By Cal.com's own filter rules, `upcoming` already includes unconfirmed (pending) bookings for non-recurring events, so `unconfirmed` was not added. Worth a check if an event type ever requires confirmation.
2. **WR-07, Apps Script:** `apps-script/adminApi.gs` changed and **needs another owner redeploy**. Until then, sheets/rollback-mode recipe saves still drop target OG/FG.
3. **WR-05, visual check:** matched calendar rows now take the customer name from the batch. If none of the lists loaded on the dashboard (calendar tasks, the Batches-tab list, Ready to bottle) has that batch, the row shows only the batch id.

## Fixed Issues

### CR-01: Bookings from earlier today disappear, so their batch shows "not booked yet"

**Files modified:** `zoho-middleware/lib/calcom.js`, `zoho-middleware/__tests__/calcom-list-bookings.test.js`, `zoho-middleware/__tests__/packaging-bookings.test.js`
**Commit:** 4d567cb4
**Applied fix:** `listBookings` fetches `status=upcoming` and `status=past` as separate parallel calls, one status per call, each paginated as before. It merges them, dedupes by `uid` (or `id`) on the server, and reports `truncated` if either list hit the cap. `shapeBookings` still drops cancelled and rejected bookings. Regression tests:
- a booking whose `end` is earlier today is still listed;
- a booking returned by both calls appears once;
- `shapeBookings` keeps an ended booking on the first day of the window.

The frontend model already suppresses "not booked yet" once a matched booking is present (existing packcal test), so no frontend change was needed.

### WR-01: When the candidate query fails, the route still answers `ok:true` with every booking unmatched

**Files modified:** `zoho-middleware/routes/brewpad-dashboard.js`, `zoho-middleware/__tests__/packaging-bookings-route.test.js`
**Commit:** 6f65db8d
**Applied fix:** when `packagingCandidates()` rejects, the route returns `{ok:false, reason:'unavailable'}`, is not cached, and logs a warning with the error code only. The browser then shows the existing "Bookings could not be loaded" note and leaves out the status labels.

### WR-02: The target-gravity pair rule (FG below OG) can be bypassed with a partial update

**Files modified:** `zoho-middleware/lib/recipe-pg.js`, `zoho-middleware/__tests__/db/recipe-pg-target-gravity.test.js`
**Commit:** a09b52e3
**Applied fix:** after `updateRecipe` takes the row lock, it lays the payload's target keys over the stored values (pg numeric is a string, so it is converted; NULL becomes '') and runs `checkTargetGravityPair` on the result. Partial updates that would leave FG ≥ OG are rejected with `invalid_data` and write nothing. The route-level check is unchanged; it still catches the case where both keys are sent. Sheets/rollback mode is not covered: Apps Script has no pair check.

### WR-03: Cal.com list latency is unbounded on both server and client

**Files modified:** `zoho-middleware/lib/calcom.js`, `js/brewpad.js`, `js/brewpad.min.js`, `zoho-middleware/__tests__/calcom-list-bookings.test.js`, `tests/frontend/brewpad-dashboard-v2-packcal.test.js`
**Commit:** 26583efe
**Applied fix:**
- **Server:** each list request has a 5 s timeout and `withRetry(..., { retries: 1 })`, replacing 15 s with 3 retries. The two status calls run in parallel, so a page waits about 10.3 s at worst.
- **Client:** after 10 s (`DASH_CAL_BOOKINGS_TIMEOUT_MS`) the bookings fetch is aborted with `AbortController` where available, and the request settles as `failed`, which shows the existing soft-fail note. A late answer is ignored.
- The server still caches a slow success, so the next dashboard load is fast.
- 10 s rather than the review's 8 s, so a single timed-out attempt plus a quick retry (about 5.5 to 7 s) still lands.
- The optional short negative cache was not added.

### WR-04: The Cal.com booking `uid` is sent to the browser and cached in Redis, but nothing uses it

**Files modified:** `zoho-middleware/lib/packaging-bookings.js`, `zoho-middleware/__tests__/packaging-bookings.test.js`
**Commit:** 20469ed2
**Applied fix:** I searched `js/brewpad.js` first: it reads only `start`, `day`, `kind`, `batch_id` and `customer_name`. `shapeBookings` no longer sends `uid`, `end` or `event_type_id`. Dedupe by uid stays on the server, in `calcom.listBookings`.

### WR-05: `customer_name` is attendee free text

**Files modified:** `zoho-middleware/lib/packaging-bookings.js`, `js/brewpad.js`, `js/brewpad.min.js`, `zoho-middleware/__tests__/packaging-bookings.test.js`, `tests/frontend/brewpad-dashboard-v2-packcal.test.js`
**Commit:** a7246634
**Applied fix (owner's choice):**
- **Server:** `customer_name` is sent only when `batch_id` is null; matched bookings send `''`. Any name containing '@' is blanked, matched or not. Names are trimmed and capped at 80 characters.
- **Frontend:** `buildPackagingCalendar` takes an optional `nameById` map. A matched booking's customer comes from that map first, then from the batch's calendar tasks (`getCustomerDisplayName`). The booking text is never used for matched rows. The widget fills `nameById` from `_allBatchesData` and the Ready to bottle summaries.
- One Phase 97 test expectation changed: in the "order within a day" test, matched rows with no known batch customer now fall back to the batch id.

### WR-06: `/api/bookings/services` fails entirely if the Beer Packaging lookup fails

**Files modified:** `zoho-middleware/routes/bookings.js`, `zoho-middleware/__tests__/bookings-beer-packaging.test.js`
**Commit:** 6c1693c0
**Applied fix:** if the `CALCOM_EVENT_TYPE_BEER_PACKAGING` lookup is rejected, the route drops that one entry and logs a warning with the HTTP status or error code only, never the message or body. The degraded payload is not cached, so the list recovers by itself. A failure for any other id still returns 502 as before; a test pins this.

### WR-07: Recipe verify and backfill ignore `target_og` / `target_fg`, and the Apps Script write path doesn't carry them (PARTIAL)

**Files modified:** `apps-script/adminApi.gs`, `zoho-middleware/lib/recipe-pg.js` (header comment), `tests/frontend/adminapi-recipe-target-gravity.test.js`
**Commit:** f117790d
**Applied fix:**
- Apps Script `createRecipe` and `updateRecipe` call `ensureRecipesTargetGravityColumns` when the payload has a non-blank target value. In `updateRecipe` this happens before the header read and cache invalidation, which is the same stale-header ordering the other ensures use. Values are written by header, and a blank clears the cell when the column exists. With no values, the sheet header is untouched (lazy, like `mirrorRecipeState`).
- The recipe-pg header comment now says outputs match Apps Script only once the sheet has the columns.
- **Apps Script needs another owner redeploy.**

**Not done, stopped by the pre-existing-test rule:** adding `target_og`/`target_fg` to `scripts/backfill/specs/recipes.js` and to `recipes-verify.js` `RECIPE_FIELDS`/`NUMERIC_FIELDS`.
- `__tests__/backfill/recipes-spec-headers.test.js` (pre-existing, last changed 2026-10-14) pins the spec to exactly the 19 live-sheet headers ("Recipes spec has the 19 real headers"), so this change needs that test updated.
- Verify builds its sheet side from that spec through `buildRecipesBackfillPlan`. Adding the fields to verify alone would flag every recipe that has a target value as a mismatch, so the spec and verify have to change together.
- Also, the spec marks every listed header as needed, so a backfill would reject (`missing_header`) a live sheet that doesn't have the lazy columns yet. The spec change should wait until the sheet has them, or the owner should decide how to handle a missing optional header.
- **The owner needs to approve updating the pinned-header test (and decide on the missing-header handling) before this part can be done.**

---

_Fixed: 2026-11-05T21:30:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_

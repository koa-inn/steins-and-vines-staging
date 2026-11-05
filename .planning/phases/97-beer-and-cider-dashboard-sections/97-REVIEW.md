---
phase: 97-beer-and-cider-dashboard-sections
reviewed: 2026-11-05T20:27:06Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - apps-script/adminApi.gs
  - css/brewpad.css
  - js/brewpad.js
  - js/kiosk-core.js
  - zoho-middleware/lib/batch-pg-read.js
  - zoho-middleware/lib/batch-store.js
  - zoho-middleware/lib/brewpad-integration.js
  - zoho-middleware/lib/calcom.js
  - zoho-middleware/lib/constants.js
  - zoho-middleware/lib/packaging-bookings.js
  - zoho-middleware/lib/recipe-pg.js
  - zoho-middleware/lib/recipe-rules.js
  - zoho-middleware/lib/validateEnv.js
  - zoho-middleware/migrations/0009_recipes_target_gravity.sql
  - zoho-middleware/routes/bookings.js
  - zoho-middleware/routes/brewpad-dashboard.js
  - zoho-middleware/routes/pos-recipe.js
  - zoho-middleware/routes/recipes.js
  - zoho-middleware/routes/webhooks.js
  - zoho-middleware/scripts/calcom-smoke.sh
  - zoho-middleware/server.js
  - CLAUDE.md
  - .planning/phases/97-beer-and-cider-dashboard-sections/97-CONTEXT.md
  - .planning/phases/97-beer-and-cider-dashboard-sections/97-UI-SPEC.md
findings:
  critical: 1
  warning: 7
  info: 6
  total: 14
status: issues_found
---

# Phase 97: Code Review Report

**Reviewed:** 2026-11-05T20:27:06Z
**Depth:** standard (Phase 97 diff `8a2184d6..HEAD`)
**Files Reviewed:** 21 source files, plus 3 context docs
**Status:** issues_found

## Summary

I reviewed the Phase 97 diff: the packaging calendar (Cal.com list, server-side email matching, the v2 widget), Beer & cider cards, the shared Today's tasks and Ready to bottle rows, target OG/FG on recipes (migration 0009, recipe-pg, routes, Apps Script mirror), kiosk `customer_email` carry-through, and the Beer Packaging event-type wiring.

**What checks out:**
- **No PII leaks found.** Emails are compared only inside `matchBatch`. The response, the Redis cache and the logs carry counts only, never emails. `/api/admin/dashboard-cards` sends no `customer_*` keys and no `recipe_snapshot`. `pos-recipe.js` validates `customer_email` and never logs it; it is not stored in the pending-charge or idempotency records.
- **The leading space in `CALCOM_EVENT_TYPE_BEER_PACKAGING` is handled.** Every read path converts with `Number()`, which ignores surrounding whitespace: `numEnv` (brewpad-dashboard.js:43), `bookings.js:162` and `:350`, `listBookings` `.map(Number)`, and `shapeBookings` `Number(ids.packagingId)`.
- **`customer_name` was intended.** It is in the 97-06 whitelist (T-97-18), and the UI-SPEC calendar row uses it ("{customer} · {batch id}", and "{customer or booking name}" for unmatched bookings). Residual risks are in WR-05.
- **The ~17 s first uncached request has a visible likely cause.** `listBookings` uses a 15 s axios timeout inside `withRetry`, which retries timeouts. One slow Cal.com attempt that times out at 15 s, then a 300 ms backoff and a fast retry, adds up to about 17 s. The candidate query (one correlated subquery per active batch) and the enrichment are cheap by comparison. Pagination is serial but only matters above 100 bookings. See WR-03.

**What's wrong:**
- **CR-01 (BLOCKER):** the `status: 'upcoming'` filter drops bookings that already ended today. The calendar then calls those batches "not booked yet" every afternoon of a packaging day.
- **Smaller issues:** a degraded response that looks like success, a gap in the target-gravity pair check, a needless failure point on the public services endpoint, and the recipe verify/backfill not knowing about the new columns.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Bookings from earlier today disappear, so their batch shows "not booked yet"

**File:** `zoho-middleware/lib/calcom.js:140` (consumed by `zoho-middleware/lib/packaging-bookings.js:74-96` and `js/brewpad.js:409-455`)
**Issue:** `listBookings` asks Cal.com for `status: 'upcoming'`. Cal.com's `upcoming` only returns bookings that have not ended yet. The window starts at today 00:00 Vancouver (`afterStart`), but a booking from 10:00 drops out of the response once it ends. Here is what happens:
1. The booking no longer reaches `shapeBookings`, so `booked[batch_id]` is never set (`brewpad.js:430`).
2. That batch's open packaging task due today then renders with `status: 'not booked yet'` (`brewpad.js:454`), because the bookings state is `ok`.

This hits every packaging day after the first appointment ends (cache TTL is 5 min) and lasts until staff tick the task. It contradicts UI-SPEC "never claim not booked yet" and could lead staff to chase a customer who already came in.

A secondary point I could not confirm against these event types: `upcoming` also omits `unconfirmed` bookings (event types that require confirmation).
**Fix:** Ask for every non-cancelled status in the window, and keep the existing cancelled/rejected filter in `shapeBookings`. Check the comma-list form in the 97-12 smoke, since the docs list `status` as an array:
```js
var params = {
  status: 'upcoming,past,unconfirmed',   // window bounds come from afterStart/beforeEnd
  eventTypeIds: ids.join(','),
  afterStart: opts.afterStart,
  beforeEnd: opts.beforeEnd,
  sortStart: 'asc',
  limit: 100
};
```
Add a regression test: a booking whose `end` is earlier today must still be listed and must suppress the task's "not booked yet".

## Warnings

### WR-01: When the candidate query fails, the route still answers `ok:true` with every booking unmatched

**File:** `zoho-middleware/routes/brewpad-dashboard.js:73-96`
**Issue:** If `batchStore.packagingCandidates()` rejects, the code sets `candidatesFailed = true` and matches against `[]`. The response is still `{ok:true, bookings:[…all batch_id:null]}`; only the caching is skipped. The browser treats this as `state: 'ok'`:
- every booking reads "no batch matched";
- every dated packaging task in the window reads "not booked yet", because no booking marks its batch.

This is the same false claim the UI-SPEC forbids when bookings can't be checked.
**Fix:** Return a soft failure (`res.json({ ok: false, reason: 'unavailable' })`) when `candidatesFailed`. Or add `matched: false` to the body and have `buildPackagingCalendar` treat it like `failed` for the task status.

### WR-02: The target-gravity pair rule (FG below OG) can be bypassed with a partial update

**File:** `zoho-middleware/lib/recipe-pg.js:344-357`, `zoho-middleware/routes/recipes.js:751-767`
**Issue:** The `fg < og` check only runs when both `target_og` and `target_fg` are in the payload. A PUT with only `target_fg: 20` on a recipe whose stored `target_og` is 10 passes and stores FG ≥ OG. Batches created from that recipe copy it into `recipe_snapshot`, and the G8 expected curve then goes up. The BrewPad editor always sends both fields, but the server check is the stated source of truth (migration 0009 says so).
**Fix:** In `updateRecipe`, when only one key is present, fill the other from the current row (it is already locked in the update transaction). Then run `checkTargetGravityPair(merged.og, merged.fg)`. Do the same in `checkTargetGravity`, or leave it to recipe-pg and remove the half-check from the route.

### WR-03: Cal.com list latency is unbounded on both server and client (likely cause of the ~17 s)

**File:** `zoho-middleware/lib/calcom.js:148-152`, `js/brewpad.js:9322`
**Issue:** Each page is `withRetry` (3 retries, timeouts retried) around a 15 s timeout. That is about 62 s worst case per page, up to 5 serial pages. The browser `fetch` has no timeout or abort, so "Checking bookings…" can sit for over a minute and the failure note never appears. The observed 17 s matches one timed-out attempt plus a quick retry. The 5-minute cache only helps after the first success, and failures are never cached, so a slow Cal.com is felt on every dashboard load.
**Fix:**
- Give the list call its own tight budget: `timeout: 5000` and `withRetry(fn, { retries: 1 })`.
- Abort on the client after about 8 s and settle `failed`:
```js
var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
var timer = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : null;
fetch(url, { credentials: 'include', signal: ctl ? ctl.signal : undefined })
  .then(...).catch(function () { settle({ bookingsState: 'failed' }); })
  .then(function () { if (timer) clearTimeout(timer); });
```
- Optionally cache a short (30–60 s) negative result, so a Cal.com outage doesn't cost 15 s+ per load.

### WR-04: The Cal.com booking `uid` is sent to the browser and cached in Redis, but nothing uses it

**File:** `zoho-middleware/lib/packaging-bookings.js:84-88`
**Issue:** The whitelist sends `uid`, `end` and `event_type_id`, but `buildPackagingCalendar` reads only `day`, `start`, `batch_id`, `kind` and `customer_name`. A Cal.com booking uid is the key for its public `/booking/{uid}` manage page, where the booking can be cancelled or rescheduled. I have not re-checked this against current Cal.com behaviour. Staff auth limits exposure, but sending a bearer-like value nobody needs goes against the phase's minimal-whitelist threat model (T-97-18).
**Fix:** Drop `uid` (and `end` / `event_type_id` unless a consumer is added) from `shapeBookings`. If something needs a stable dedupe key, send a hash.

### WR-05: `customer_name` is attendee free text, so the "no '@'" rule is only checked in tests

**File:** `zoho-middleware/lib/packaging-bookings.js:91`
**Issue:** `customer_name` is intended (97-06 whitelist, UI-SPEC unmatched label), so it is not a whitelist violation. But it is whatever the attendee typed into Cal.com's name field, capped at 80 characters. Customers do sometimes type their email there, and then an email reaches the staff browser and Redis. The only check against '@' is a test on fixtures. For matched bookings the name isn't needed either, since the batch already carries the customer.
**Fix:**
- Send `customer_name` only when `batch_id` is null. Matched rows can use the batch's own customer name, as tasks already do via `getCustomerDisplayName`.
- Blank or mask values that contain an email:
```js
var nm = String(att.name || '').trim();
if (/@/.test(nm)) nm = '';
customer_name: batchId ? '' : nm.slice(0, 80)
```

### WR-06: `/api/bookings/services` now fails entirely if the Beer Packaging lookup fails

**File:** `zoho-middleware/routes/bookings.js:148-176`
**Issue:** The new fourth id goes through `Promise.all`. If `listEventType(BEER_PACKAGING)` fails (wrong id, deleted or hidden event type, a 404 from Cal.com), the whole public services endpoint returns 502. That takes down:
- the ferment-kit and bottling listings;
- the BrewPad waitlist contact flow (`WAITLIST_BOOKING_SLUG` lookup, brewpad.js:15057), which then fails closed.

The packaging calendar reads the id from env, not from this list, so including it here adds risk with no calendar benefit.
**Fix:** Use `Promise.allSettled` and drop rejected entries (log the id index, not the body). Or leave BEER_PACKAGING out of the public services list until a public consumer exists.

### WR-07: Recipe verify and backfill ignore `target_og` / `target_fg`, and the Apps Script write path doesn't carry them

**File:** `zoho-middleware/lib/recipe-pg.js:24-35` (cross-file: `zoho-middleware/scripts/backfill/recipes-verify.js:34-41`, `scripts/backfill/specs/recipes.js:30-55`, `apps-script/adminApi.gs:4283-4300`)
**Issue:**
- `RECIPE_COLUMNS` grew to 21 keys, but `recipes-verify.js` `RECIPE_FIELDS` / `NUMERIC_FIELDS` and the backfill spec still list 19. Drift between Postgres and the sheet mirror on the new fields goes unnoticed, and a re-backfill from the sheet would silently null them.
- Apps Script only adds the columns lazily inside `mirrorRecipeState`. Its own `createRecipe` / `updateRecipe` (sheets/rollback mode) never call `ensureRecipesTargetGravityColumns`, so values entered during a rollback are dropped.
- The recipe-pg header comment still claims the output is byte-identical to Apps Script `get_recipes`. That stops being true until the sheet has the columns.

**Fix:**
- Add `target_og` / `target_fg` to `RECIPE_FIELDS`, `NUMERIC_FIELDS` and `specs/recipes.js` (`num('target_og', false)`, `num('target_fg', false)`).
- Call `ensureRecipesTargetGravityColumns` from Apps Script `createRecipe` / `updateRecipe` when a value is present.
- Correct the header comment.

## Info

### IN-01: A function declaration inside a `for` loop

**File:** `js/brewpad.js:551`
**Issue:** `function add(label, value) {…}` is declared inside the loop body of `buildBeerCiderCards`. It works in current Safari and Chrome (block-level function semantics), but it is not valid ES5 strict code and goes against the file's ES5 convention (the `no-inner-declarations` pattern).
**Fix:** Hoist it as `var add = function (fl, label, value) {…}` outside the loop, or inline the pushes.

### IN-02: The juice/yeast pick takes the first matching ingredient by type

**File:** `zoho-middleware/lib/batch-pg-read.js:337-347`
**Issue:** The first ingredient whose type contains "yeast" wins. If a "Yeast Nutrient" or "Yeast Energizer" subcategory is listed before the actual yeast, the card shows the nutrient. `batch_size_l` is parsed and sent but no client uses it.
**Fix:** Prefer an exact `cf_subcategory` match (e.g. `/^yeast$/i`) before the substring match. Drop `batch_size_l` from the response if it stays unused.

### IN-03: The `truncated` flag is ignored by the client

**File:** `js/brewpad.js:9322-9328`
**Issue:** When the 500-booking cap is reached, missing bookings make their tasks read "not booked yet". This is unlikely at current volume.
**Fix:** If `body.truncated`, treat task status as unknown (omit the label) and show a short note.

### IN-04: Cache invalidation only reaches the current process

**File:** `zoho-middleware/lib/packaging-bookings.js:14-15, 98-106`
**Issue:** `_gen` lives in process memory, so a webhook only invalidates on the replica that received it. That is fine on the single Railway instance today. With replicas, the others would serve stale bookings for up to the 5-minute TTL.
**Fix:** Store the generation in Redis (`INCR calcom:packaging-bookings:gen`) if the service is ever scaled out.

### IN-05: Classic (frozen v1) dashboard rows changed from inline styles to CSS classes

**File:** `js/brewpad.js:9188-9228`, `css/brewpad.css:943-958`
**Issue:** Moving classic Today's tasks and Ready to bottle onto the shared row builders also changes their look:
- overdue rows use `--batch-danger-bg` plus a 3px danger left border;
- the chip's `border-color` is dropped;
- the existing `.bp-task-row--overdue` rule now applies to classic rows too.

The difference is small and was intentional (D-13 reuse), but v1 is described as frozen. Classic also still uses `todayStr()` (UTC), while v2 uses the Vancouver day. That is pre-existing, but after about 4–5 pm PT the two dashboards now disagree on which tasks are "today".
**Fix:** Confirm the visual change with the owner. Consider switching classic to `todayPacific()` in a separate commit.

### IN-06: The smoke script puts the Cal.com API key on the curl command line

**File:** `zoho-middleware/scripts/calcom-smoke.sh:53-57`
**Issue:** `-H "Authorization: Bearer $CAL_KEY"` exposes the key in `ps` output on shared machines. This is low risk on the owner's laptop.
**Fix:** Pass the header through a config on stdin: `curl -K - <<< "header = \"Authorization: Bearer $CAL_KEY\""`.

---

_Reviewed: 2026-11-05T20:27:06Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

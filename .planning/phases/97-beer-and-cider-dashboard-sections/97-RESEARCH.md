# Phase 97: Beer and cider dashboard sections - Research

**Researched:** 2026-11-03
**Domain:** BrewPad v2 dashboard (vanilla ES5 + Chart.js), Express/Postgres middleware, Cal.com API v2
**Confidence:** MEDIUM-HIGH (code facts verified by grep/Read; Cal.com list-bookings version header and rate limit need one live smoke)

## Summary

Almost everything the phase needs already exists in the repo. The aggregate (`get_dashboard_stats`) already returns open task rows (with `is_packaging`, `due_date`, `title`), all Plato readings, and `batchMeta` (parsed from `recipe_snapshot`). The G8 chart already draws an OG to target FG line when `batchMeta.og` / `target_fg` are set. The classic Today's tasks and Ready to bottle markup is delegated from `#bp-dashboard-inner`, so the same class names work inside the v2 DOM with no new handlers. New server work is small: one migration (0009), recipe validation and snapshot fields, richer `batchMeta`, and one staff-authenticated Cal.com bookings route.

Four findings change the plan versus CONTEXT/UI-SPEC assumptions:

1. **The Ready to Bottle Batches-tab filter already exists** (`js/brewpad.js` L9131 `{val:'readyToBottle'}`, `readyToBottleRows()` L8882, commit 0e0bfa18, Phase 69). The todo is stale. The folded work shrinks to: relabel to `Ready to Bottle (N)`, route widget and filter through one shared function, add tests. It is not a new filter.
2. **Three snapshot builders, not two.** The kiosk recipe sale builder (`routes/pos-recipe.js` ~L1488) omits `ibu`, `batch_size_l`, and ingredient `cf_type`/`cf_subcategory`. Beer batches come from the kiosk, so D-07 (IBU) and D-12 (juice/yeast by type) fail for them unless that builder is fixed and/or the server enriches at read time.
3. **Classic `todayStr()` is UTC** (`new Date().toISOString().slice(0,10)`, L67). After about 4-5 pm Vancouver, classic "Today's Tasks" are one day ahead. The shared extracted function must use `asOf.today` / `todayPacific()`. The classic tests that pin this must stay unmodified (CLAUDE.md rule 10), so extract the markup builder as a pure function taking `today` as a parameter, with classic passing its current value.
4. **Customer email lives on `batches.customer_email`** (`0005_batches.sql`; also `bottling_invite_email`). Aggregate rows deliberately exclude `customer_*`. Matching must run server-side so no email reaches the browser.

**Primary recommendation:** Build server-side first (migration 0009, snapshot and `batchMeta` fields, bookings route with matching), then frontend widgets reusing classic markup and the G8 model, with the Ready to Bottle filter as a small relabel plan.

## User Constraints (from CONTEXT.md)

### Locked Decisions
D-01 to D-16 are locked in `97-CONTEXT.md` (not repeated here; planner must read them). Summary of ones that drive research: D-02 both sources (Cal.com bookings plus undated-excluded packaging tasks), D-03 auto-match by customer email, no manual link; D-06 Target OG/FG become recipe fields copied into `recipe_snapshot`, no backfill without dry run and owner OK; D-09/D-10 estimated output, both can sizes; D-12 juice/yeast from snapshot ingredients by `cf_type`/`cf_subcategory`, fallback to recipe/product name; D-13 to D-15 Today section at top, ignores filters; D-16 Beer & cider section after Floor today, hidden when Type = Wine.

### Claude's Discretion
Card visual details, temp-step highlight, calendar styling; Cal.com cache TTL and exact email-match rule; recipe OG/FG field names and Postgres/Apps Script carrying; can rounding.

### Deferred Ideas (OUT OF SCOPE)
Recording actual packaged output; card in batch detail pane; renaming Cal.com slug `canning-appointment`; Cal.com duration ladder; Phase 98 alerts; Phase 99 responsiveness.

## Project Constraints (from CLAUDE.md)

- ES5 vanilla JS; edit `js/brewpad.js` sources only, never `*.min.js`/`main.js`; run `npm run build` after JS changes (brewpad.html loads `js/brewpad.min.js`).
- Regression test first for bug fixes; one logical change per commit; do not modify existing tests.
- Before commit: `npm test`, `cd zoho-middleware && npm test` (Node 24: `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH`), `npm run lint`.
- Shared utility changes (`zoho-middleware/lib/*.js`, `js/lib/*.js`) require the full suite on both sides.
- Staging first; no prod push without approval. Railway env var changes need owner in-session.
- No new third-party browser domains, so no CSP change (Cal.com is server-side only).
- Logs carry ids and counts only (no emails, names).
- Classify by `cf_type`/SKU/`batch_type`, never by name. See pitfall P4 for the temp-step exception.
- No Zoho Inventory calls added (1,000/day quota shared staging and prod).
- User global CLAUDE.md mandates gemini; memory says it is broken. Not used.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Target OG/FG storage | Database (recipes) | API (validation) | Recipe store is Postgres (Phase 85) |
| Snapshot copy at batch create | API (pos-recipe) and Browser (attach) | Database | Two live writers of `recipe_snapshot` |
| Card facts (abv, ibu, og, fg, juice, yeast, batch_size_l) | API (`parseDashSnapshot` / `getDashboardStats`) | Browser render | Raw snapshot must not be sent whole; whitelist |
| Booking list, email match | API (new route + `lib/calcom.js`) | Redis cache | Needs `customer_email`; key server-side; PII stays server-side |
| Calendar merge/dedupe (booking vs task) | Browser | API | Tasks arrive from the existing aggregate/calendar call; bookings async |
| Today's tasks / Ready to bottle | Browser (shared render) | API (`buildDashboardSummary`) | Predicate already server-computed |
| Can counts | API (`kiosk-bundles.js` BUNDLES) | Browser | brewpad.html does not load kiosk-core.js; send constants in the aggregate |
| Readings curve | Browser (Chart.js via `chart()`) | API | Reuse G8 model |

## Standard Stack

No new libraries. Everything is in-repo. [VERIFIED: codebase grep]

| Component | Where | Use |
|-----------|-------|-----|
| axios + `zohoApi.withRetry` | `zoho-middleware/lib/calcom.js` | New `listBookings` follows `getSlots` pattern |
| `lib/cache.js` (Redis, `get/set/del`) | middleware | Bookings cache |
| `authTiers.requireTiers(['legacy','session'])` | `routes/consignment.js:26` pattern | Staff auth for new route |
| node-pg-migrate + allowlist guard | `migrations/`, `scripts/migration-allowlist.js` | Migration 0009 |
| Chart.js 4.5.1 via `chart()` | `js/brewpad.js` | Cards' curves |
| Jest (jsdom frontend; middleware own config) | `tests/frontend`, `zoho-middleware/__tests__` | Tests |

## Package Legitimacy Audit

No external packages are installed in this phase. slopcheck not applicable. **Packages removed: none. Flagged: none.**

## Architecture Patterns

### Data flow

```
Recipe editor (target_og/target_fg) --PUT/POST /api/recipes--> recipe-rules validate --> recipes (PG, migration 0009)
                                                                      |-> recipe-mirror --> Apps Script (prod only; see Open Q2)
Batch create/attach --(3 snapshot builders)--> batches.recipe_snapshot {abv, ibu, batch_size_l, og, target_fg, ingredients[cf_type...]}
get_dashboard_stats (60 s memo) --> batchMeta[{og,target_fg,abv,ibu,batch_size_l,juice,yeast}] + taskRows + readings + canning constants
Browser: _dashData + _upcomingTasks + get_tasks_calendar ---> Today widgets, Beer&cider cards
Browser --GET /api/admin/packaging-bookings--> [Redis 5 min] --> calcom.listBookings(eventTypeIds, window)
          --> server matches attendee email to active batches (customer_email / bottling_invite_email) --> {bookings:[{uid,start,eventTypeId,kind,batch_id|null,customer_name}]}
Browser merges: booking wins over undated-excluded task for same batch_id; unmatched bookings labelled "no batch matched"
```

### Where things are (answers to planner questions)

**Customer email (D-03).** `batches.customer_email text not null default ''` plus `bottling_invite_email` (address the bottling invite went to; the Cal.com link was sent there, so it is the likelier booking email). Match on either, lower-cased and trimmed. [VERIFIED: 0005_batches.sql, batch-pg-update.js:96] `ACTIVE_BATCHES_SQL` is `select *` on primary/secondary and is what the route should use (server only). Several active batches for one customer: choose the batch whose open packaging task `due_date` is closest to the booking day; tie or no dated task means `batch_id: null` ("no batch matched"); never guess (matches UI-SPEC).

**Cal.com integration today.** `lib/calcom.js` has `listEventType`, `getSlots`, `createBooking`, `verifyWebhook`; Bearer `CALCOM_API_KEY`; version map `{eventTypes:'2024-06-14', slots:'2024-09-04', bookings:'2026-02-25'}` pinned by `__tests__/calcom.test.js`. Env vars in `validateEnv.js`: `CALCOM_API_KEY`, `CALCOM_EVENT_TYPE_FERMENT_KIT`, `CALCOM_EVENT_TYPE_BOTTLING`, `CALCOM_WEBHOOK_SECRET`. `CALCOM_EVENT_TYPE_BEER_WAITLIST` is used in `routes/bookings.js:151` but is NOT in `validateEnv.js`. `CALCOM_EVENT_TYPE_BEER_PACKAGING` (6028745) and `BEER_WAITLIST` (6955754) are unset on Railway: owner must set both on staging and prod. Calendar degrades to tasks-only until then (fail soft, which the design already covers). [VERIFIED: codebase]

**List bookings API.** `GET https://api.cal.com/v2/bookings` with `status=upcoming`, `eventTypeIds=<csv>`, `afterStart`, `beforeEnd`, `sortStart=asc`, `limit` 1-100 (default 50), cursor pagination via `pagination.nextCursor`/`hasMore`. Booking fields: `id, uid, start, end, duration, status (accepted|pending|cancelled|...), eventType{id,slug}, attendees[{name,email,timeZone}]`. [CITED: cal.com/docs/api-reference/v2/bookings/get-all-bookings] The doc page states `cal-api-version: 2026-05-01` for this endpoint, while the repo pins `2026-02-25` for bookings (confirmed against docs on 2026-06-04). [ASSUMED] that 2026-02-25 still accepts GET; add `listBookings` with its own `CAL_VERSIONS.bookingsList` constant and verify with one read-only live call against staging before relying on it (extend `scripts/calcom-smoke.sh`). Filter out `status` cancelled/rejected client-side as well. Use `status=upcoming` plus `afterStart`/`beforeEnd` for the 14-day window; 14 days of one small shop fits in one page, but loop on `hasMore` with a cap (for example 5 pages).
Rate limit: a third-party mirror says 120 req/min for API keys. [LOW, unconfirmed; official docs not found] Irrelevant at one call per 5 min cache fill. Cache key `calcom:packaging-bookings:<start>:<end>`, TTL 300 s, `cache.set`; add invalidation on webhook `BOOKING_CREATED/RESCHEDULED/CANCELLED` in `routes/webhooks.js` (`handleCalcomCancellation` already runs for cancel only; extend it to delete this key, since the webhook is signed and cheap). Never cache failures; on failure return `{ok:false}` HTTP 200 or 502 and let the client show the soft-fail note.

**Route.** New `GET /api/admin/packaging-bookings?start=YYYY-MM-DD&end=YYYY-MM-DD`, `authTiers.requireTiers(['legacy','session'])` (admin-grade; device rejected). Browser calls with `credentials:'include'` as other BrewPad calls do via `mwUrl()`. Validate dates with a regexp and cap the span to 31 days. Return no attendee email. Event-type ids come from env (`BOTTLING`, `BEER_PACKAGING`); `kind` per id: BEER_PACKAGING means canning, else bottling. Pick by id (never name). Also the D-folded wiring: add `BEER_PACKAGING` to the `ids` array and `body.service === 'beer-packaging'` selector in `routes/bookings.js` (~L149, ~L340) with fail-closed no-match guard by slug, default unchanged; register in `validateEnv.js` (also add `BEER_WAITLIST`).

**Recipes (D-06).** Migration numbering: existing 0001 to 0008; next is **`0009_recipes_target_gravity.sql`**: `alter table recipes add column target_og numeric; add column target_fg numeric;` with comments; plain nullable, no CHECK (precedent 0006: allowlist forbids DROP CONSTRAINT); Down drops both. Numeric columns are unconstrained by convention. Enforce 2 to 40 degrees Plato (the range `snapshotPlato` already uses) in `lib/recipe-rules.js`, with an `invalid_data` rejection like beer_category. Touch points mirroring `beer_category`: `recipe-pg.js` (`RECIPE_COLUMNS`, `NUMERIC_RECIPE_COLUMNS`, `INSERT_RECIPE_SQL`, `UPDATE_NUMERIC_FIELDS`, create/update), `routes/recipes.js` validation (L734 pattern; keep out of `PUBLIC_RECIPE_FIELDS`), `brewpad.html` (~L190 field block, only beer and cider recipes), `js/brewpad.js` L5878 (populate) and L6626 (collect), `apps-script/adminApi.gs` `mirrorRecipeState` (L4808) writes by header, so unknown headers are silently dropped. Recipe-sheet columns need an `ensureRecipesTargetGravityColumns` self-migration like `ensureRecipesBeerCategoryColumn` (needs an Apps Script redeploy; prod mirror only). Response shape comment says "19 recipe keys"; adding two makes 21 and several parity tests (`recipe-rules-parity`, `recipe-mirror`, `adminapi-recipe-mirror`) will need updated expectations for new keys (new tests, do not edit old ones; if an old test pins the 19-key set it must be superseded deliberately and the owner told).

**Snapshot builders (must all copy target OG/FG).**
1. `js/brewpad.js` `buildBpAttachSnapshot` (~L4556): has `abv`, `ibu`, `batch_size_l`, ingredients with `cf_type`, `cf_subcategory`. Add `og: snap.target_og`, `target_fg: snap.target_fg`.
2. `routes/pos-recipe.js` ~L1488 (kiosk confirm): has `name, style, abv`, no `ibu`, no `batch_size_l`, ingredients are scaled catalog lines without `cf_type`. Add `ibu`, `batch_size_l`, `og`, `target_fg`, and enrich ingredient types (reuse `enrichIngredientGroups` logic in `routes/recipes.js` L112, which reads the Redis `INGREDIENTS_ALL` cache with file fallback and no Zoho call) or derive juice/yeast at read time.
3. `lib/brewpad-integration.js` `detectRecipeSale` (L854) just stringifies what it is given.
Keys: keep the existing contract `parseDashSnapshot` reads (`og`, `target_fg`, fallback `fg`); store `og` = recipe `target_og`. Recipe-level values are frozen at batch creation, so existing batches (SV-B-000167, SV-B-000229) stay blank per D-06.

**`batchMeta` additions.** `parseDashSnapshot` (`batch-pg-read.js` ~L299) currently returns `{recipe_name, recipe_style, og, target_fg}`. Add `abv`, `ibu`, `batch_size_l` (numeric or null) and, for beer and cider only, `juice` and `yeast` strings (short, `snapshotString`-capped). Extend the existing tests (`batch-store-dash-stats-96.test.js` style) with new tests; keep it tolerant (never throws). Derivation: yeast = first ingredient whose `cf_subcategory` matches `yeast` (case-insensitive; repo fixtures use `'Yeast'`); juice = first ingredient with `cf_type`/`cf_subcategory` matching juice/apple. [ASSUMED: no `Juice` subcategory value is present in repo fixtures; confirm actual Zoho values for the ~6 cider recipes (Open Q1)]. Fallback: recipe name then `product_name`. Also add `canning` constants to the aggregate payload from `kiosk-bundles.BUNDLES['beer-25'].nominal` (and `['cider-23']` if wanted) so the browser reads one source: brewpad.html does not load `kiosk-core.js`, whose copy is a display mirror pinned by `kiosk-canning-bundle-parity.test.js`.

**Output estimate.** litres = `target_volume_l * 25 / 28`, else 25 L (existing `batchLitres` uses 28 L started and 25 L completed, `js/brewpad.js` ~L541; do not reuse it for this line since D-09 is "25 per 28"). Cans = `Math.floor(nominal[size] * litres / 25)` for 473 and 355 (nominal 52 and 70 for a standard 25 L). Always prefixed with `≈`.

**Tasks, temperature steps, packaging.** `batch_tasks` columns: `task_id, batch_id, step_number, title, description, day_offset, due_date, is_packaging, is_transfer, completed, completed_at, ...`. There is **no temperature flag**; `dashTaskKind` (L1432) uses `is_packaging`/`is_transfer` first, then title regex for `temp`. See pitfall P4. The card "Next" line comes from `_dashData.taskRows` (open tasks of primary/secondary batches: `batch_id, task_id, title, due_date, completed, is_packaging, is_transfer`); pick the earliest by `due_date` (undated last), ties by `task_id` order. No server change needed.

**Classic code to extract (D-13).** `renderDashboard()` L8341 returns early to v2. Ready to Bottle list: L8730 to ~L8770 from `d.readyToBottle` (server `buildDashboardSummary`, `lib/batch-rules.js` L835 to 865; predicate: active batch with an incomplete packaging task and (all non-packaging tasks done OR packaging due date <= today); sorted by due). Today's tasks L8765 to ~L8805 from `_upcomingTasks` (`get_tasks_upcoming`, limit 100, dated ascending so overdue and today lead). Handlers are delegated on `#bp-dashboard-inner` (L15168 click, change for task checkbox, `.bp-rtb-invite-btn`, batch chip), and the v2 shell lives inside it, so extracted markup using the same classes works without new wiring. Verify `onDashV2Click` does not swallow these (test). The classic Ready-to-bottle toggle (`.bp-rtb-toggle`) is replaced by an always-open widget per UI-SPEC. Inline red/green styles move to CSS classes `.bp-task-row--overdue` / `--today` (check these exist in `css/brewpad.css`; UI-SPEC assumes they do). Classic tests touching this: `brewpad-bottled-refetch`, `brewpad-dashboard-v2-agreement`, `-production`, `brewpad-filter-derive`, `brewpad-pure`, `brewpad-unlinked-filter`. Re-run all unmodified after extraction.

**Ready to Bottle filter.** Exists with a badge count; `readyToBottleRows()` L8882 intersects `_allBatchesData` with `_dashSummary.readyToBottle`; refresh after bottling at L8974 to 8979 and L9047 (`brewpad-bottled-refetch.test.js`). Plan: label `Ready to Bottle (N)` (like the Unlinked chip, L~9150), widget count and filter count both from one function (note the widget uses the full summary list, the filter intersects with loaded batches: define the shared function to take the list and state the intended rule so the two counts cannot disagree; UI-SPEC wants equality). Empty copy `No batches are ready to bottle.`

**Registry and layout.** `DASH_V2_SECTIONS` (L8287) is a static array of `{title, hint, slots:[[slotId, full?]]}`; `DASH_V2_WIDGETS` (L7957) are `{key, slot, title, chart, needs, render}` run through `runDashV2Widget` (L8011), isolated per widget. Add a `Today` section first and `Beer & cider` after `Floor today`, with section visibility hooks (Beer & cider hidden when `type === 'wine'`; the sections renderer currently has no per-section visibility, so add one). `needs` supports `taskRows`, `readings`, `batchMeta`. Today widgets must use unfiltered data (Floor widgets already do for physical state; follow `dashV2ProdCtx()`).

**G8 reuse.** `buildG8Model(rows, readings, metaById, model, ctx)` (L2768) produces series/stats/note for a selected batch (`ctx.batch`), and `renderDashV2Ferment` (L7828) is bound to one slot id and one chart key (`_dashV2Charts.ferment`, `destroyDashV2Slot('ferment')`). For per-card curves, add a card-scoped render function that calls `buildG8Model` with `ctx.batch = id` and `state.type` forced to the batch's type, and stores charts under keys `bc:<batch_id>`; destroy on collapse and on section re-render (extend `destroyDashV2Charts`). The model already returns the "No expected curve" note and the OG/Latest/Target FG/Attenuation/ABV strip. Do not call it with the global filter state (it returns `wrongType` for Wine and applies source/staff filters); build a synthetic `model.state` with `type:'all', source:'all'` and no staff exclusion.

**Classification.** Use `effectiveBatchType(row, catMap)` (via `dashClassifyRows`) which reads server `batch_type` (Phase 94; values wine|beer|cider|seltzer|other) with schedule-category fallback. Cards: `type in {beer,cider}` and status primary/secondary ("active"); staff batches included; Type filter applies, Source filter applies (UI-SPEC), staff toggle does not.

**Timezone.** Calendar days are Vancouver days. Use `asOf.today` from the aggregate for "today"; day-of-booking = `new Date(start).toLocaleDateString('en-CA', {timeZone:'America/Vancouver'})`; time label via `toLocaleTimeString('en-CA', {timeZone:'America/Vancouver', hour:'numeric', minute:'2-digit'})` (lower-case `pm` per UI-SPEC). Do the `afterStart`/`beforeEnd` conversion of Vancouver day edges to UTC carefully (DST); tests must cover a 9 pm PT booking that is next day in UTC. Existing helpers: `dayNumber`, `addDays` (pure, L~340), `todayPacific`.

### Anti-Patterns to Avoid
- Sending raw `recipe_snapshot` or any `customer_*` to the browser.
- A second copy of the Ready to bottle predicate, or of can counts.
- Using `todayStr()` (UTC) in new code.
- Calling Zoho from the dashboard path (quota). The bookings route and the aggregate must make no Zoho Inventory/Books call. Note `dashStats` already calls `kioskProductIndex()` which reads cache; do not add uncached lookups.
- One global Chart.js key for per-card charts (leaks and cross-card destroy).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Fermentation curve | new chart code | `buildG8Model` + `chart()` | Expected line, table view, a11y already done |
| Today's tasks / Ready to bottle rows | second markup | extract classic into shared pure fn | D-13; tests exist; delegated handlers work |
| Ready-to-bottle membership | client re-derivation | server `summary.readyToBottle` | Single source of truth |
| Can counts | retyped numbers | `kiosk-bundles.BUNDLES` via aggregate | Parity-tested |
| Task kind detection | new regexes | `dashTaskKind` | Already used by G7 |
| Cal.com HTTP | raw axios in route | `lib/calcom.js` + `withRetry` | Header/version/timeout conventions |
| Day math | `Date` arithmetic with local tz | `dayNumber`/`addDays` | DST-proof |
| Email compare | ad hoc | one `normEmail()` (trim + lower) | Used on both sides of the match |

## Common Pitfalls

### P1: Stale prod recipe sheet / mirror drops new columns
Mirror writes by header; without the Apps Script self-migration the OG/FG values never reach the sheet. Postgres is authoritative, so this is not data loss, but a mirror verify tool may flag it. Check `verify`/compare scripts before shipping; list Apps Script redeploy as an owner step.

### P2: Migration order on prod
Prod must already have 0007 and 0008 (it is flipped to postgres per STATE/memory; confirm). 0009 is additive and allowlist-safe (add column only). Run `npm run migrate:guard` in tests/CI.

### P3: Kiosk-created snapshots lack type info and IBU
See Summary item 2. Add a test that the kiosk builder output has `ibu`, `batch_size_l`, `og`, `target_fg`.

### P4: Temp-step detection is name-based
No schema field exists. The project rule "never by name" targets batch classification; `dashTaskKind` already ships title-regex detection and is covered by tests. Recommend reusing it and flagging in the plan that a temp flag on ferm-schedule steps would be the structural fix (deferred). [ASSUMED acceptable to owner; Open Q3]

### P5: Classic `todayStr()` is UTC
Evening Vancouver users see tomorrow's tasks as "today" and a due-today task as overdue. Fix in the shared function by passing `today`; add a regression test (write first, per CLAUDE.md rule 3), classic caller unchanged unless owner wants it fixed too (changing classic output could break pinned tests, so keep classic's value).

### P6: `get_tasks_calendar` returns completed tasks and ready-undated packaging tasks
Filter `completed !== true`, drop undated for the calendar (D-05) but count them for the "N packaging tasks have no date" note. Customer names are present; batch type is not, so look up `batch_type` in `_dashData.batches`.

### P7: Dedupe booking vs task
Dedupe by `batch_id`: a dated open packaging task whose batch has a matched booking within the window is hidden. If bookings failed to load, omit the "not booked yet" status (UI-SPEC).

### P8: v2 section registry assumes four static sections
Per-section hide, new slot ids, and `dashV2SectionsHtml` all need updating; existing section-order tests (`brewpad-dashboard-v2-shell`, `-widgets`) assert the old order. Do not edit them: add new tests, and tell the owner the old order assertions are superseded by D-14 (CLAUDE.md rule 10 conflict: flag before touching).

### P9: `DASH_STATS_BATCH_META_SQL` scans all batches
It parses every `recipe_snapshot` per load (60 s memo). Adding fields is cheap, but keep strings short and do not add ingredient arrays to the payload.

### P10: Webhook cache invalidation
Without it, a new booking can take up to the TTL to appear. 5 min TTL plus webhook delete is enough.

## Code Examples

`lib/calcom.js` (pattern per existing `getSlots`):
```javascript
// listBookings: GET /v2/bookings (read-only; server-side only)
function listBookings(opts) {
  return zohoApi.withRetry(function () {
    return axios.get(BASE + '/bookings', {
      headers: makeHeaders(CAL_VERSIONS.bookingsList), // verify header value live (see Cal.com section)
      timeout: 15000,
      params: { status: 'upcoming', eventTypeIds: opts.eventTypeIds.join(','),
        afterStart: opts.afterStart, beforeEnd: opts.beforeEnd, sortStart: 'asc',
        limit: 100, cursor: opts.cursor }
    }).then(function (r) { return r.data; });
  });
}
```
Migration (precedent `0006_recipes_beer_category.sql`):
```sql
-- Up Migration
alter table recipes add column target_og numeric;
alter table recipes add column target_fg numeric;
-- Down Migration
alter table recipes drop column target_fg;
alter table recipes drop column target_og;
```
Source: repo precedent [VERIFIED: migrations/0006].

## State of the Art

| Old | Current | Impact |
|-----|---------|--------|
| Classic dashboard sections | v2 widget registry | New work goes in `DASH_V2_*`, classic frozen |
| Sheets/Apps Script batches | Postgres batch store (flag `postgres`) | Phase works against PG only; no Apps Script batch code |
| Recipe sheet | Postgres recipes + prod-only sheet mirror | Add columns in PG; sheet follows via mirror |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Cal.com `GET /v2/bookings` accepts `cal-api-version: 2026-02-25` (docs page says 2026-05-01) | Cal.com | List call 400s; use 2026-05-01 after live smoke |
| A2 | Cal.com API-key rate limit about 120/min (third-party mirror) | Cal.com | None at this call volume |
| A3 | No `Juice` cf_subcategory exists; juice may be tagged differently in Zoho | Cider | Juice line falls back to recipe/product name |
| A4 | Reusing title-regex `dashTaskKind` for temp steps is acceptable | Tasks | Owner may want a structural flag |
| A5 | Prod has migrations 0007 and 0008 applied | Migration | 0009 deploy blocked by order check |
| A6 | `.bp-task-row--overdue`/`--today` CSS classes exist | Layout | Add them in `css/brewpad.css` |
| A7 | Booking attendee email is usually `customer_email` or `bottling_invite_email` | Matching | More "no batch matched" labels (safe failure) |

## Open Questions

1. **Cider ingredient types in Zoho.** What `cf_type`/`cf_subcategory` do juice and cider yeast carry? Check the ~6 cider recipe snapshots on staging (read-only) or `INGREDIENTS_ALL` cache. Recommendation: implement tolerant matching (`yeast` substring; juice via `juice` or `apple`/`fruit` type) and fallback to names.
2. **Recipe mirror verify.** Does any Phase 85 verify/compare tool assert recipe column parity with the sheet? If yes, add the Apps Script `ensure...` and redeploy as an owner step; otherwise ship PG-only and let the mirror catch up.
3. **Temp-step flag.** Accept title-based `temp` kind for now?
4. **Cal.com env vars on Railway.** Owner must set `CALCOM_EVENT_TYPE_BEER_PACKAGING=6028745` and `CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754` on staging and prod in-session. Calendar shows bottling only (and the soft-fail note, if the key is missing) until then.
5. **Backfill of the two existing beer batches' OG/FG** (D-06): dry run plus owner OK; out of plan scope unless asked.
6. **Cards and Source filter.** UI-SPEC says cards follow Source; D-16 says only Type. UI-SPEC resolves to follow Source (staff stays included). Planner should keep the UI-SPEC rule.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 24 (nvm) | middleware tests | yes | v24.21.0 (also 20.17, 20.20) | none, required |
| Redis | cache | tests mock `lib/cache`; prod Railway | n/a | in-process fallbacks exist |
| Cal.com API + key | list bookings | prod/staging only, not callable here | n/a | fail soft, tasks only |
| Postgres | migration tests | `jest.db.config.js` uses postgres:16 (prod is PG 18; known mismatch) | n/a | n/a |

**Missing with no fallback:** none for code work. Live Cal.com smoke needs owner/staging.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Frontend | Jest + jsdom, `tests/frontend/*.test.js` (pattern: require `../../js/brewpad`, `bp` exports, see `brewpad-dashboard-v2-floor.test.js`) |
| Middleware | Jest, `zoho-middleware/__tests__/`; DB tests via `jest.db.config.js` |
| Quick run | `npx jest tests/frontend/<file>` ; `cd zoho-middleware && npx jest __tests__/<file>` |
| Full suite | `npm test` ; `cd zoho-middleware && npm test` ; `npm run lint` |

### Phase Requirements to Test Map
| ID | Behavior | Type | Command | Exists |
|----|----------|------|---------|--------|
| SC1 | Beer card facts, Next line, temp pill, `No readings yet` | frontend unit | `npx jest tests/frontend/brewpad-dashboard-v2-beer-cider.test.js` | Wave 0 |
| SC2 | Output estimate 25/28, cans floor, both sizes from aggregate constants | frontend + middleware | same + `batch-store-dash-stats-97.test.js` | Wave 0 |
| SC3 | Cider juice/yeast fallback; curve reuse; chart destroy | frontend | beer-cider test | Wave 0 |
| SC4 | Calendar grouping, Vancouver boundaries, dedupe, unmatched, soft-fail | frontend | `brewpad-dashboard-v2-today.test.js` | Wave 0 |
| D-02/03 | `listBookings`, route auth, email match, multi-batch rule, no email leaked, cache | middleware | `calcom-list-bookings.test.js`, `packaging-bookings-route.test.js` | Wave 0 |
| D-06 | Recipe validation 2 to 40, columns, snapshot copy in all 3 builders | middleware + frontend | `recipe-target-gravity.test.js`, `pos-recipe-snapshot-gravity.test.js` | Wave 0 |
| D-13 to D-15 | Shared rows identical to classic, Overdue first, filters ignored, section order, wine hides section | frontend | `brewpad-dashboard-v2-today.test.js` | Wave 0 |
| Filter | `Ready to Bottle (N)` equals widget; drops after bottled | frontend | extend via new file | Wave 0 |
| Migration | 0009 passes guard and allowlist | middleware | `npm run migrate:guard` | exists |
| Copy | banned-word guard on new strings | frontend | in new tests | Wave 0 |

### Sampling Rate
Per commit: touched test files plus lint. Per wave: both full suites. Phase gate: both green, `npm run build` regenerated.

### Wave 0 Gaps
All Wave 0 files above are new. No framework install needed.

## Security Domain

| ASVS | Applies | Control |
|------|---------|---------|
| V2/V3 Auth/Session | yes | `authTiers.requireTiers(['legacy','session'])` on the new route (device token rejected) |
| V4 Access control | yes | Staff-only; response omits attendee emails and customer PII beyond display name |
| V5 Input validation | yes | Regex-validate `start`/`end`, cap span; numeric range validation for OG/FG; all SQL parameterised |
| V6 Crypto | no | No new crypto; Cal.com key stays server-side |
| V8 Data protection / logging | yes | Logs carry counts and batch ids only |

| Threat | STRIDE | Mitigation |
|--------|--------|------------|
| PII (emails) leaked to browser | Information disclosure | Server-side match, whitelist response |
| Unauthenticated bookings listing | Spoofing/Info disclosure | Auth wrapper plus test for 401 |
| XSS via attendee name or recipe juice/yeast strings | Tampering | `escapeHTML` on every interpolation; cap string length |
| Cal.com outage causing dashboard failure | DoS | Fail soft, separate async fetch, timeout 15 s |
| SQL injection | Tampering | `$n` placeholders only |

## Sources

### Primary (HIGH)
- Repo code and migrations read directly: `lib/calcom.js`, `routes/bookings.js`, `routes/webhooks.js`, `lib/batch-pg-read.js`, `lib/batch-store.js`, `lib/batch-rules.js`, `lib/recipe-pg.js`, `lib/kiosk-bundles.js`, `routes/pos-recipe.js`, `lib/brewpad-integration.js`, `apps-script/adminApi.gs`, `js/brewpad.js`, `migrations/0003 to 0008`.
### Secondary (MEDIUM)
- https://cal.com/docs/api-reference/v2/bookings/get-all-bookings (fetched via summarising tool; verify header value live)
### Tertiary (LOW)
- https://www.mintlify.com/calcom/cal.com/api/rate-limits (third-party mirror; rate limit)

## Metadata

**Confidence:** Standard stack HIGH (all in-repo); architecture HIGH; Cal.com list call MEDIUM (version header unverified live); cider type values LOW.
**Research date:** 2026-11-03. **Valid until:** 2026-11-17 (fast-moving codebase; line numbers drift).

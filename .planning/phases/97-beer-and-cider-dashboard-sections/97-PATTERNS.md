# Phase 97: Beer and cider dashboard sections - Pattern Map

**Mapped:** 2026-11-03
**Files analyzed:** 22 new/modified
**Analogs found:** 22 / 22 (3 are partial; see bottom)

Line numbers are from the repo on 2026-11-03 and drift fast. Re-grep the function name before editing. Never edit `js/main.js`, `js/brewpad.min.js` or other build artifacts; run `npm run build` after JS changes.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `zoho-middleware/migrations/0009_recipes_target_gravity.sql` | migration | batch | `migrations/0006_recipes_beer_category.sql` | exact |
| `zoho-middleware/lib/recipe-rules.js` (2..40 Plato check) | utility | transform | `normalizeBeerCategory` in same file | role-match |
| `zoho-middleware/lib/recipe-pg.js` (cols, insert, update) | service | CRUD | `beer_category` touch points in same file | exact |
| `zoho-middleware/routes/recipes.js` (validation) | route | request-response | `beer_category` block ~L734 | exact |
| `apps-script/adminApi.gs` (`ensureRecipesTargetGravityColumns`) | service | CRUD | `ensureRecipesBeerCategoryColumn` L4272 | exact |
| `zoho-middleware/lib/calcom.js` (`listBookings`) | service | request-response | `getSlots` / `listEventType` in same file | exact |
| `zoho-middleware/routes/packaging-bookings.js` (new route; or add to `routes/bookings.js`) | route | request-response | `routes/consignment.js` admin report route | role-match |
| `zoho-middleware/routes/bookings.js` (BEER_PACKAGING ids + selector) | route | request-response | `BEER_WAITLIST` + `bottling` selector in same file | exact |
| `zoho-middleware/lib/validateEnv.js` | config | n/a | CALCOM lines ~L63-65 | exact |
| `zoho-middleware/routes/webhooks.js` (invalidate bookings cache) | route | event-driven | `handleCalcomCancellation` L575 | exact |
| `zoho-middleware/lib/batch-pg-read.js` (`parseDashSnapshot` + fields) | service | transform | itself, L299 | exact |
| `zoho-middleware/lib/batch-store.js` (canning constants in aggregate) | service | request-response | `getDashboardStats` wiring | role-match |
| `zoho-middleware/routes/pos-recipe.js` (kiosk snapshot ~L1488) | route | CRUD | the snapshot literal itself; `enrichIngredientGroups` in `routes/recipes.js` L112 | role-match |
| `js/brewpad.js` `buildBpAttachSnapshot` (~L4556) | utility | transform | itself | exact |
| `js/brewpad.js` recipe editor populate/collect (~L5878, ~L6626) + `brewpad.html` (~L190) | component | CRUD | `bp-recipe-beer-category` | exact |
| `js/brewpad.js` Today section widgets (tasks, RTB, calendar) | component | request-response | classic `renderDashboard` blocks L8730-8805 + `DASH_V2_WIDGETS` | role-match |
| `js/brewpad.js` Beer & cider section cards | component | transform | `renderDashV2Ferment` L7828 + `buildG8Model` L2768 | role-match |
| `js/brewpad.js` `DASH_V2_SECTIONS` / `dashV2SectionsHtml` | config | n/a | itself L8287 | exact |
| `js/brewpad.js` Ready to Bottle filter relabel | component | request-response | `Unlinked (N)` label L9215 | exact |
| `css/brewpad.css` (.bp-task-row--overdue etc.) | config | n/a | existing `.bp-dash-*` rules | role-match |
| New middleware tests | test | n/a | `__tests__/calcom.test.js`, `consignment.test.js`, `batch-store-dash-stats-96.test.js` | exact |
| New frontend tests | test | n/a | `tests/frontend/brewpad-dashboard-v2-floor.test.js` | exact |

## Pattern Assignments

### `migrations/0009_recipes_target_gravity.sql` (migration, batch)

**Analog:** `zoho-middleware/migrations/0006_recipes_beer_category.sql` (whole file). Additive, nullable, no CHECK (allowlist forbids DROP CONSTRAINT), header comment, `-- Up Migration` / `-- Down Migration`:
```sql
-- Up Migration
alter table recipes add column beer_category text;
comment on column recipes.beer_category is 'Optional beer tint key; app-level enum, see lib/recipe-rules.js ...';

-- Down Migration
alter table recipes drop column beer_category;
```
Use `numeric` for `target_og` and `target_fg`; Down drops both. Run `npm run migrate:guard`.

### `lib/recipe-pg.js`, `lib/recipe-rules.js`, `routes/recipes.js` (target OG/FG)

**Analog:** the `beer_category` touch points. Grep `beer_category` in each:
- `recipe-pg.js` L16 header comment ("19 recipe keys", becomes 21), L27 key list, L66 `INSERT_RECIPE_SQL` column list, L93 message const, L236 create normalise, L330-333 update `addSet`:
```javascript
if (payload.beer_category !== undefined) {
  var nextBeerCategory = recipeRules.normalizeBeerCategory(payload.beer_category);
  ...
  addSet('beer_category', emptyToNull(nextBeerCategory));
```
  Numeric fields go in `RECIPE_COLUMNS`, `NUMERIC_RECIPE_COLUMNS`, `UPDATE_NUMERIC_FIELDS` (so pg numerics return as JS numbers, not strings).
- `routes/recipes.js` L734-747: validation helper returns `null` or `{ ..., code: 'invalid_beer_category' }` and rewrites `payload.beer_category`. Copy for `invalid_target_gravity` (2..40 Plato, blank allowed). Keep the new fields OUT of `PUBLIC_RECIPE_FIELDS` (L58).
- Tests to mirror: `__tests__/recipe-rules-beer-category.test.js`, `recipe-rules-beer-category-parity.test.js`, `recipe-rules-parity.test.js`. Do not edit the old ones; if a 19-key assertion breaks, flag it to the owner (CLAUDE.md rule 10).

### `apps-script/adminApi.gs` (self-migrating column)

**Analog:** `ensureRecipesBeerCategoryColumn` (L4272-4283):
```javascript
function ensureRecipesBeerCategoryColumn(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = recipesHeaderRow(sheet, lastCol);
  var idx = headers.indexOf('beer_category');
  if (idx === -1) {
    sheet.getRange(1, lastCol + 1).setValue('beer_category').setFontWeight('bold');
    return lastCol; // zero-based index of the newly added column
  }
  return idx;
}
```
Call sites to copy: L4346, L4448, L4835 (`mirrorRecipeState`), L5270. Prod mirror only; redeploy is an owner step.

### `lib/calcom.js` `listBookings` (service, request-response)

**Analog:** `getSlots` / `listEventType` in `zoho-middleware/lib/calcom.js`. Header block with `CAL_VERSIONS` L18-22, `makeHeaders` L31, then:
```javascript
function listEventType(id) {
  return zohoApi.withRetry(function () {
    return axios.get(BASE + '/event-types/' + id, {
      headers: makeHeaders(CAL_VERSIONS.eventTypes),
      timeout: 15000
    }).then(function (response) { return response.data; });
  });
}
```
Add `bookingsList` to `CAL_VERSIONS` (do not change `bookings`, it is pinned by `calcom.test.js`). Params `status:'upcoming', eventTypeIds (csv), afterStart, beforeEnd, sortStart:'asc', limit:100, cursor`. Loop on `pagination.hasMore` with a cap.

**Test analog:** `__tests__/calcom.test.js` L1-40: `jest.mock('axios')`, `jest.mock('../lib/zoho-api', ...withRetry passthrough)`, `jest.resetModules()` in `beforeEach`, `process.env.CALCOM_API_KEY` set/deleted. Assert header and params on `axios.get.mock.calls`.

### New staff route for packaging bookings

**Analog:** `zoho-middleware/routes/consignment.js` L15-60 (admin-grade auth wrapper, query validation, cache-first, `log.info` with counts):
```javascript
router.get('/api/admin/consignment-report', function (req, res) {
  authTiers.requireTiers(['legacy', 'session'])(req, res, function () {
  // Admin-grade (device rejected, T-46-03b) — 46-04 interfaces.
  var month = req.query.month || ...;
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Invalid month format (expected YYYY-MM)' });
  }
  ...
  cache.get(cacheKey).then(function (cached) { if (cached) { return res.json(cached); } ...
```
Mount in `server.js` next to `app.use('/', require('./routes/consignment'));` (L872). Regex-validate `start`/`end` (`^\d{4}-\d{2}-\d{2}$`), cap span 31 days, one `normEmail()` (trim+lower) used for both sides of the match, whitelist response (`uid,start,eventTypeId,kind,batch_id|null,customer_name`), never return emails. Load active batches server-side (primary/secondary) for `customer_email` / `bottling_invite_email`. Cache `cache.set` 300 s only on success; on Cal.com failure respond soft (`{ ok:false }`) and do not cache.

**Test analog:** `__tests__/consignment.test.js` L1-40: mocks `../lib/cache` (`get/set/del/isConnected`), `../lib/logger`, and a fake `express.Router` that registers handlers in `_routeRegistry`, then `findHandler('get', path)`. Add a 401 test for the device tier and a "no email in body" test.

### `routes/bookings.js` + `lib/validateEnv.js` (BEER_PACKAGING wiring)

**Analog (same file):** ids array L145-152 and selector L340-344:
```javascript
var ids = [
  process.env.CALCOM_EVENT_TYPE_FERMENT_KIT,
  process.env.CALCOM_EVENT_TYPE_BOTTLING,
  process.env.CALCOM_EVENT_TYPE_BEER_WAITLIST
].filter(function (id) { return id && String(id).trim() !== ''; });
...
if (body.service === 'bottling' && process.env.CALCOM_EVENT_TYPE_BOTTLING && String(process.env.CALCOM_EVENT_TYPE_BOTTLING).trim() !== '') {
  resolvedEventTypeId = Number(process.env.CALCOM_EVENT_TYPE_BOTTLING);
} else {
  resolvedEventTypeId = Number(process.env.CALCOM_EVENT_TYPE_FERMENT_KIT);
}
```
Add `BEER_PACKAGING` to `ids`; add a `beer-packaging` branch; the default branch must stay unchanged. Fail-closed slug guard per the todo (note BEER_WAITLIST is selected by slug 'beer-consult' in BrewPad, grep that for the guard shape). `validateEnv.js` L63-65 entries are `{ name, desc }`; add `CALCOM_EVENT_TYPE_BEER_PACKAGING` and the missing `CALCOM_EVENT_TYPE_BEER_WAITLIST`. Tests extend `__tests__/bookings.test.js` via a new file (do not edit existing).

### `routes/webhooks.js` (invalidate bookings cache)

**Analog:** `handleCalcomCancellation` L575-600, which does `cache.del(C.CACHE_KEYS.SLOTS_PREFIX + date).catch(function (err) {...})`. Add a `cache.del` for the packaging-bookings key prefix. Note the handler returns early when no date can be derived; place the bookings invalidation so it still runs for CREATED/RESCHEDULED (caller at L555 is cancel only, so check the dispatcher near L534-560). Test: `__tests__/calcom-webhook.test.js` style.

### `lib/batch-pg-read.js` `parseDashSnapshot` (transform)

**Analog (same function, L299-312):**
```javascript
function parseDashSnapshot(text) {
  var out = { recipe_name: '', recipe_style: '', og: null, target_fg: null };
  var snap;
  try { snap = JSON.parse(text); } catch { return out; }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return out;
  out.recipe_name = snapshotString(snap.name);
  ...
  out.og = snapshotPlato(snap.og);
  out.target_fg = snapshotPlato(snap.target_fg !== undefined && snap.target_fg !== null ? snap.target_fg : snap.fg);
```
Add `abv`, `ibu`, `batch_size_l` (use `numOrNull`), plus `juice`/`yeast` via `snapshotString` from `snap.ingredients` (tolerant, never throws). Do not send the ingredient array. Test analog: `__tests__/batch-store-dash-stats-96.test.js` L1-40 (mocks `../lib/db`, `../lib/batch-pg-read`, `../lib/batch-type-hints`; fixture `batchMeta` at L37). New file `batch-store-dash-stats-97.test.js`. Canning constants: read `kiosk-bundles.BUNDLES['beer-25'].nominal` (`lib/kiosk-bundles.js` L20-40, frozen object `{473:52, 355:70}`), do not copy the numbers into the browser.

### `routes/pos-recipe.js` kiosk snapshot (~L1488)

**Analog:** the existing literal, which is the gap:
```javascript
var snapshot = {
  name: recipe.name, style: recipe.style, abv: recipe.abv,
  locked_price: ..., target_volume_l: targetVolumeLConfirm, scale_factor: scaleFactorConfirm,
  ingredients: scaledIngredients,
  modified_base_ingredients: modifiedConfirm,
  is_modified: !!(modifiedConfirm && modifiedConfirm.length)
};
brewpadIntegration.detectRecipeSale(body.recipe_id, snapshot, invoiceNumber, body.customer_name, body.contact_id);
```
Add `ibu`, `batch_size_l`, `og: recipe.target_og`, `target_fg: recipe.target_fg`. For ingredient `cf_type`/`cf_subcategory`, reuse `enrichIngredientGroups` (`routes/recipes.js` L112, reads Redis `INGREDIENTS_ALL` with file fallback, no Zoho call). Mirrors the browser builder (below) key names. Test analog: `pos-recipe-store.test.js` / `pos-recipe-confirm-verification.test.js` for how `detectRecipeSale` is spied.

### `js/brewpad.js` `buildBpAttachSnapshot` (~L4556)

**Analog:** itself. Add alongside `abv`/`ibu`:
```javascript
abv: snap.abv || 0, ibu: snap.ibu || 0, batch_size_l: snap.batch_size_l || null,
// add: og: snap.target_og, target_fg: snap.target_fg
```
Ingredients already carry `cf_type`, `cf_subcategory` (mappedBase).

### Recipe editor fields

**Analog:** `bp-recipe-beer-category`. Populate L5878 `if (get('bp-recipe-beer-category')) get('bp-recipe-beer-category').value = r.beer_category || '';` collect L6626 `beer_category: get('bp-recipe-beer-category') ? get('bp-recipe-beer-category').value : '',` and L3504, L4744, L6313 carry it elsewhere (grep them for any list that must also carry target_og/target_fg). Field block in `brewpad.html` ~L190; show only for beer and cider recipes.

### Today section: Today's tasks + Ready to bottle (extract classic markup)

**Analog:** classic `renderDashboard()` blocks, `js/brewpad.js` L8730-8805. Extract into a pure `buildTodayTasksHtml(tasks, today)` and `buildReadyToBottleHtml(list)`; classic passes `todayStr()`, v2 passes `asOf.today`. Key excerpts:
```javascript
var overdueTasks = _upcomingTasks.filter(function (t) {
  var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
  return !done && t.due_date && String(t.due_date).slice(0, 10) < todayDateStr;
});
...
html += '<div class="bp-task-row" data-task-id="' + escapeHTML(t.task_id) + '">';
html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"></label>';
html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '">' ...
```
RTB rows: `bp-rtb-invite-btn` with `data-batch-id`, `data-customer`, `data-product` (delegated on `#bp-dashboard-inner`, so no new wiring). Replace inline red/green `style=` with CSS classes. Drop the `.bp-rtb-toggle` collapse (UI-SPEC: always open). Hazard: classic `todayStr()` is UTC (L67 area); `todayPacific()` at L72 is the correct helper. The classic tests (`brewpad-bottled-refetch`, `brewpad-dashboard-v2-agreement`, `-production`, `brewpad-filter-derive`, `brewpad-pure`, `brewpad-unlinked-filter`) must stay unmodified and green.

### Widget registration (Today widgets, Beer & cider cards)

**Analog:** `DASH_V2_WIDGETS` L7957 and `runDashV2Widget` L8011:
```javascript
{
  key: 'g8', slot: 'bp-dash-v2-ferment', title: DASH_V2_FERMENT_TITLE, chart: 'ferment', needs: ['readings'],
  render: function (model, cs) { renderDashV2Ferment(model, cs); }
},
```
`needs` accepts `taskRows`, `readings`, `batchMeta`, `vessels`; a missing array shows "Not available yet" through `dashV2Msg`; a throw is caught per widget. New keys (for example `t1` tasks, `t2` RTB, `t3` calendar, `bc` cards).

**Sections:** `DASH_V2_SECTIONS` L8287 and `dashV2SectionsHtml` L8294 (slots are `[id, full?]`):
```javascript
{ title: 'Floor today', hint: 'Right now, mostly ignores the period filter', slots: [['bp-dash-v2-workload'], ['bp-dash-v2-vessels'], ['bp-dash-v2-tasks', true], ['bp-dash-v2-ferment', true]] },
```
Insert `Today` first (after tiles), `Beer & cider` after `Floor today`. The renderer has no per-section visibility; add an optional `hidden(model)` hook (Wine type hides Beer & cider). Existing order assertions in `brewpad-dashboard-v2-shell` and `-widgets` tests will break by design (D-14): do not edit; flag to the owner.

### Beer & cider cards (G8 reuse)

**Analog:** `renderDashV2Ferment` L7828-7870. Key reusable parts:
```javascript
var ctx = dashV2ProdCtx();
var metaById = {};
var bm = _dashData.batchMeta || [];
for (var i = 0; i < bm.length; i++) { if (bm[i]) metaById[bm[i].batch_id] = bm[i]; }
var g = buildG8Model(ctx.rows, _dashData.readings, metaById, model, {
  batch: String(dashV2Opt('g8', 'batch', 'all')), staffIds: ctx.staffIds, catMap: ctx.catMap
});
...
destroyDashV2Slot('ferment');
```
For per-card curves call `buildG8Model` with `ctx.batch = id` and a synthetic `model.state` (`type:'all', source:'all'`, no staff exclusion), chart keys `bc:<batch_id>`, and extend `destroyDashV2Charts` (L6849) / `destroyDashV2Slot` (L7175) to destroy them. Task "Next" line: pick from `_dashData.taskRows` earliest `due_date` (undated last), tag with `dashTaskKind` (L1432, returns `'temp'` for "Lower to 10ºC"). Output estimate: `target_volume_l * 25 / 28` (else 25 L), `Math.floor(nominal[size] * litres / 25)`, always prefixed with the approx sign. Escape every interpolation with `escapeHTML`. "No readings yet" is the established empty wording (G8 `noreadings`).

**Test analog:** `tests/frontend/brewpad-dashboard-v2-floor.test.js` L1-45: stub `global.google`, `global.fetch`, `sessionStorage`, require `js/lib/auth` globals, `var bp = require('../../js/brewpad')`; `TODAY` via `toLocaleDateString('en-CA', {timeZone:'America/Vancouver'})`, `ASOF`, helper `d(n)` (UTC day arithmetic), and `lean(id, type, status, extra)` row factory. New files `brewpad-dashboard-v2-today.test.js`, `-beer-cider.test.js`.

### Calendar entries (merge bookings and tasks)

No exact analog. Closest for task side: `get_tasks_calendar` / `buildCalendar` (`lib/batch-rules.js` ~L630) for dated packaging tasks. Day math: use `dayNumber` / `addDays` and `asOf.today`; booking day by `toLocaleDateString('en-CA', {timeZone:'America/Vancouver'})` (test a 9 pm PT booking that is next day in UTC). Dedupe by `batch_id` (booking wins). Omit "not booked yet" if the bookings call failed.

### Ready to Bottle filter relabel

**Analog:** `js/brewpad.js` L9215-9220, live count labels set in the filter-bar refresh:
```javascript
if (btn.getAttribute('data-status') === 'unlinked') {
  btn.textContent = 'Unlinked (' + filterBatchesByUnlinked(_allBatchesData).length + ')';
}
```
Add `readyToBottle` branch with `'Ready to Bottle (' + readyToBottleRows().length + ')'`. Filter definition at L9131 (`{val:'readyToBottle'}`); predicate `filterBatchesByReadyToBottle` L248 and `readyToBottleRows` L8882. Define the widget count and filter count from one function (note: widget uses the full summary list, filter intersects loaded batches). Refetch after bottling at L8974-8979 and L9047 is pinned by `brewpad-bottled-refetch.test.js`.

## Shared Patterns

### Staff auth
**Source:** `routes/consignment.js` L26. `authTiers.requireTiers(['legacy','session'])(req, res, function () {...})`. Apply to the new bookings route. Device tier is rejected.

### Cache
**Source:** `lib/cache.js` (`get/set/del`, promise-returning), used in `routes/consignment.js`. Cache successes only; fail soft.

### Logging and PII
Logs carry ids and counts only (no emails, names). `log.info('[tag] ...')` form as in consignment and webhooks.

### Escaping
`escapeHTML` on every interpolation in `js/brewpad.js` (attendee names, juice/yeast strings). Cap strings via `snapshotString` server-side.

### Dates
America/Vancouver calendar days. Use `asOf.today` / `todayPacific()`, never `todayStr()` (UTC) in new code.

### No Zoho Inventory calls
The aggregate and bookings route must add none (shared 1,000/day quota).

### ES5 only in `js/brewpad.js` (var, function, no arrow functions). Middleware is ES5 style too (`var`, `function`) apart from `catch {` in `batch-pg-read.js`.

## No Analog Found / Partial

| File | Role | Data Flow | Reason |
|---|---|---|---|
| Calendar day-grouped list (Today widget) | component | transform | No existing day-grouped list; only `buildCalendar` data and the classic "Next 7 Days" bar chart (~L8806) |
| Bookings-to-batch email matcher | service | transform | No existing Cal.com-to-batch join; build with `batches.customer_email` / `bottling_invite_email` (`0005_batches.sql`) and one `normEmail()` |
| Per-section visibility in `dashV2SectionsHtml` | component | n/a | Registry is static; needs a new hook |

## Metadata

**Analog search scope:** `zoho-middleware/{lib,routes,migrations,__tests__}`, `js/brewpad.js`, `apps-script/adminApi.gs`, `tests/frontend`.
**Files scanned:** about 25 targeted reads/greps (gemini CLI not used; broken).
**Pattern extraction date:** 2026-11-03

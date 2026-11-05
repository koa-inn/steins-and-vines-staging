# Phase 98: Dashboard alerts and quick wins - Pattern Map

**Mapped:** 2026-11-05
**Files analyzed:** 7 (2 new test files, 5 modified)
**Analogs found:** 7 / 7

Line numbers verified against the working tree on 2026-11-05. They drift as Phase 97 follow-ups land, so re-grep the symbol names before editing.

Owner decision (2026-11-05): the server-side `inviteSentIds` key on `get_dashboard_stats` is APPROVED, including the one-name edit to the existing key-list assertion at `zoho-middleware/__tests__/db/batch-pg-dashboard-stats-96.test.js:192`. This is the only existing test that may be edited, and only that one array literal.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `zoho-middleware/lib/batch-pg-read.js` (add `DASH_STATS_INVITED_SQL` + `inviteSentIds`) | service (SQL read) | request-response | same file, `DASH_STATS_STAFF_SQL` / `staffBatchIds` (L94-95, L399-401, L435) | exact |
| `zoho-middleware/__tests__/db/batch-pg-dashboard-stats-96.test.js` (edit one array, L191-193) | test | request-response | itself | exact |
| `zoho-middleware/__tests__/db/batch-pg-invite-sent-98.test.js` (new) | test (real PG) | request-response | `batch-pg-staff-read-create.test.js` L96-106 plus the `batch-pg-dashboard-stats-96.test.js` harness | exact |
| `js/brewpad.js` pure `buildDashAttentionModel` + `dashPastPlanDays` (top level, exported) | utility (pure model) | transform | `buildG10Model` (L2971) and `planned_days` handling (L3155-3158) | role-match |
| `js/brewpad.js` attention widget `t0`, lead slot, click handler, waitlist fetch, drill extension, Tasks filters | component (IIFE render and handlers) | request-response + event-driven | `renderDashV2TodayTasks`/`renderDashV2Rtb`, `ensureDashCalData`, `openDashDrill`, `taskFilterOpts` | exact (per piece) |
| `css/brewpad.css` (`.bp-attn*`, `.bp-past-plan`) | config (styles) | n/a | `.bp-drill-banner` (L557-579), `.bp-filter-btn` (L614-632), `.bp-status-badge--warning` (L425) | role-match |
| `tests/frontend/brewpad-dashboard-v2-attention.test.js` (new) | test (jsdom) | request-response | `tests/frontend/brewpad-dashboard-v2-today.test.js` | exact |

## Pattern Assignments

### `zoho-middleware/lib/batch-pg-read.js` (service, request-response): `inviteSentIds`

**Analog:** the same file's `staffBatchIds` path. Copy it line for line: a one-column SQL constant, one `client.query` link in the sequential `.then` chain, one `out.*` assignment, one key in the `ok({...})` payload.

**SQL constant** (L92-95). Add the new constant directly below it, same ids-only posture:
```javascript
// Phase 95 (D-08): ids only, never customer columns. Kept out of DASH_STATS_BATCHES_SQL so the
// per-row lean key set is unchanged.
var DASH_STATS_STAFF_SQL =
  'select batch_id from batches where staff_batch = true order by length(batch_id), batch_id';
```
New, mirroring it:
```javascript
// Phase 98 (A4): ids only (no email, no timestamp). Drives the "Invite not sent" count client-side.
var DASH_STATS_INVITED_SQL =
  'select batch_id from batches where bottling_invite_sent_at is not null order by length(batch_id), batch_id';
```

**Chain link** (L399-402). Insert the invited query between staff and taskRows. Do not reorder other links:
```javascript
    return client.query(DASH_STATS_STAFF_SQL);
  }).then(function (res) {
    out.staffBatchIds = res.rows.map(function (r) { return r.batch_id; });
    return client.query(DASH_STATS_TASK_ROWS_SQL, [tz]);   // becomes: return client.query(DASH_STATS_INVITED_SQL);
  }).then(function (res) {
```
After the edit:
```javascript
    out.staffBatchIds = res.rows.map(function (r) { return r.batch_id; });
    return client.query(DASH_STATS_INVITED_SQL);
  }).then(function (res) {
    out.inviteSentIds = res.rows.map(function (r) { return r.batch_id; });
    return client.query(DASH_STATS_TASK_ROWS_SQL, [tz]);
  }).then(function (res) {
```

**Payload** (L430-441). Add one line next to `staffBatchIds: out.staffBatchIds,`:
```javascript
      staffBatchIds: out.staffBatchIds,
      inviteSentIds: out.inviteSentIds,
```

Do NOT add anything to `summary.readyToBottle` items (`batch-rules.js:843-853`); `__tests__/fixtures/batches/golden.json` and `__tests__/backfill/batches-parity.test.js` pin that shape against Apps Script. The stats memo is 60 s and is cleared on a successful write (`batch-store.js`), so a stamp invalidates it.

---

### `zoho-middleware/__tests__/db/batch-pg-dashboard-stats-96.test.js` (EDIT, owner-approved)

**Analog:** itself, L191-193. The only permitted change is inserting `'inviteSentIds'` in sorted position (the array is compared after `.sort()`, so alphabetical order is required). `inviteSentIds` sorts after `'batches'` and before `'latestReadings'`:
```javascript
    expect(Object.keys(res.data).sort()).toEqual([
      'asOf', 'batchMeta', 'batches', 'inviteSentIds', 'latestReadings', 'readings', 'staffBatchIds', 'summary', 'taskRows', 'tasks', 'vessels'
    ]);
```
Make no other change to this file. The blob-leak assertion (L184-189) covers taskRows, readings, vessels and batchMeta only, so it is unaffected. Also grep `zoho-middleware/__tests__` for any other exact key-list assertion on `getDashboardStats` data before finishing (`grep -rn "staffBatchIds" zoho-middleware/__tests__`); only this one was found in research.

---

### `zoho-middleware/__tests__/db/batch-pg-invite-sent-98.test.js` (new, real-Postgres test)

**Analog:** `batch-pg-staff-read-create.test.js` L96-106 for the assertion shape, and `batch-pg-dashboard-stats-96.test.js` L1-69 for the harness and `insertBatch` helper.

**Harness and imports** (stats-96 L7-47):
```javascript
var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('batch-pg-dashboard-stats-96', function () {
  var container; var pool; var read; var harness;
  var NOW = new Date('2026-10-23T06:30:00.000Z');

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    read = require('../../lib/batch-pg-read');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });
  function client() { return harness.client(); }
```

**Core assertion** (staff-read-create L96-101), adapted. Stamp via `update batches set bottling_invite_sent_at = now() where batch_id = $1` on two of three inserted batches, then:
```javascript
    var res = await read.getDashboardStats(client(), { now: NOW });
    expect(res.data.inviteSentIds).toEqual([idA, idC]);   // ids only, ordered by length then id, null excluded
    // leanness: ids are strings only, no timestamp or email leaks
    res.data.inviteSentIds.forEach(function (v) { expect(typeof v).toBe('string'); });
```
Use the `insertBatch(n, fields)` helper from stats-96 L49-61 (copy it into the new file; helpers are file-local there). Run via `cd zoho-middleware && npm run test:db`. CI uses postgres:16 and prod runs 18; the query is plain SQL so both are fine.

---

### `js/brewpad.js`: pure model `buildDashAttentionModel` and `dashPastPlanDays` (utility, transform)

**Analog:** `buildG10Model` (L2971) is top-level (outside the IIFE), takes `(rows, metaById, ctx)`, is exported at the bottom (`buildG10Model: buildG10Model,` L17310 inside the `module.exports = Object.assign(...)` block at L17227). Place the new pure functions next to it and export them the same way. Do not reference IIFE state from them; pass everything in `inp`.

**Signature shape and ctx handling** (L2971-2977):
```javascript
function buildG10Model(rows, metaById, ctx) {
  var c = ctx || {};
  var meta = metaById || {};
  var today = c.today;
  var cls = dashClassifyRows(rows, { scheduleCategoryById: c.catMap, staffIds: c.staffIds });
```

**planned_days sanitising to copy** (L3155-3158). This is how Phase 96 already reads `planned_days`; reuse the same null and `<= 0` handling for D-11 (no schedule means excluded):
```javascript
    var pd = m2.planned_days === null || m2.planned_days === undefined ? null : Number(m2.planned_days);
    if (pd !== null && (isNaN(pd) || pd <= 0)) pd = null;
```
Also see L2119 for the other consumer: `var pd = Number((meta[filtered[i].item.row.batch_id] || {}).planned_days);`.

**Whole-day arithmetic:** use the existing top-level `dayNumber(ymd)` (L365) and `addDays`; never subtract `Date` objects.

**Predicate** (from RESEARCH, derived from D-09..D-11):
```javascript
function dashPastPlanDays(today, startDate, plannedDays) {
  var pd = Number(plannedDays);
  if (!(pd > 0) || !startDate || String(startDate).length < 10) return null;   // D-11
  var over = dayNumber(today) - dayNumber(startDate) - pd;                      // days past plan
  return over > 14 ? over : null;                                               // D-09 grace
}
```

**Staff flag** (do not apply to overdue, due-today, past-schedule; apply only to invite): `isStaffRow(row, staffIds)` at L804. `staffIds` is a `{id: true}` map built in `refreshDashV2` (L7336-7339):
```javascript
    var staffIds = {};
    var ids = (_dashData && _dashData.staffBatchIds) || [];
    for (var i = 0; i < ids.length; i++) staffIds[ids[i]] = true;
```
Build the invite set the same way from `_dashData.inviteSentIds`, and treat a non-array `inviteSentIds` as "unavailable" (omit the Invite chip, bump `unavailable`).

**Task partition: reuse, never re-implement** (L9190-9204):
```javascript
  function dashTodayTaskRows(tasks, today) {
    var list = tasks || [];
    var overdue = list.filter(function (t) {
      return !dashTaskIsDone(t) && t.due_date && String(t.due_date).slice(0, 10) < today;
    });
    ...
    return { overdue: overdue, today: due };
  }
```
This lives inside the IIFE, so the IIFE render code calls it and passes `tasks` counts into the model, or the model receives the already-partitioned `{overdue, today}` lengths. Either way the chip count must come from this function so chip, Today's tasks widget and Tasks-tab filter agree.

**Ready to bottle dedupe** (renderDashV2Rtb L9291-9297; the count must dedupe by `batch_id` like the widget):
```javascript
    var list = readyToBottleList();
    var seen = {};
    var n = 0;
    list.forEach(function (it) {
      var k = it.batch_id || '';
      if (!seen[k]) { seen[k] = true; n++; }
    });
```
Items carry `has_email` (see `dashReadyToBottleRowHtml` L9237). Invite count = deduped RTB items with `has_email === true`, not staff, not in `inviteSentIds`, not in the session map `_dashInviteSent`.

---

### `js/brewpad.js`: attention widget `t0` + lead slot + render (component, request-response)

**Analog 1: widget registry entry.** Copy a `t*` entry from `DASH_V2_WIDGETS` (L8301-8312):
```javascript
    {
      key: 't2', slot: 'bp-dash-v2-rtb', title: 'Ready to bottle', chart: '', needs: [],
      render: function () { renderDashV2Rtb(); }
    },
```
New: `{ key: 't0', slot: 'bp-dash-v2-attn', title: 'Needs attention', chart: '', needs: [], render: function () { renderDashV2Attention(); } }`. Register it first in the array; it is rendered by `renderDashV2AllWidgets` (L8346) and refreshed by `rerenderDashV2Widget('t0')` (L8350).

**Caution on `runDashV2Widget` (L8332-8344).** Its fallback (`dashV2Msg`) builds a `.bp-widget` shell. The attention row has no widget shell (UI-SPEC), so `renderDashV2Attention` must handle its own unavailable case with `<p class="bp-empty">Not available yet. Reopen the Dashboard tab to refresh.</p>` and never throw (wrap its own body in try/catch and write the `.bp-empty` line on failure).

**Analog 2: the lead slot, outside `.bp-dash-grid`.** `DASH_V2_SECTIONS` today (L8611) and `dashV2SectionsHtml` (L8622-8634):
```javascript
    { key: 'today', title: 'Today', hint: "Right now. The filters above don't apply.", slots: [['bp-dash-v2-today-tasks'], ['bp-dash-v2-rtb'], ['bp-dash-v2-packcal', true]] },
...
      html += '<section class="bp-dash-section" data-dash-sec="' + sec.key + '"><div class="bp-dash-section-head"><h2 class="bp-dash-section-title">' + escapeHTML(sec.title) +
        '</h2><p class="bp-dash-section-hint">' + escapeHTML(sec.hint) + '</p></div><div class="bp-dash-grid">';
```
Add an optional `lead: 'bp-dash-v2-attn'` property on the `today` entry (do NOT add it to `slots`: `tests/frontend/brewpad-dashboard-v2-today.test.js` pins `.bp-dash-grid > div` ids exactly). In `dashV2SectionsHtml`, emit `<div id="' + sec.lead + '"></div>` between the `.bp-dash-section-head` close and the `<div class="bp-dash-grid">` open when `sec.lead` is set. Keep the hint text unchanged.

**Analog 3: row-list render with `.bp-empty` message and the "Not available" guard** (`renderDashV2TodayTasks` L9269-9287):
```javascript
    if (!_upcomingLoaded) {
      dashV2Msg(slotId, 't1', title, 'Not available yet. Reopen the Dashboard tab to refresh.');
      return;
    }
    var parts = dashTodayTaskRows(_upcomingTasks, dashV2TodayDate());
```
Use `_upcomingLoaded` as the "tasks available" input, `dashV2TodayDate()` (L9245) as `today`:
```javascript
  function dashV2TodayDate() {
    return (_dashData && _dashData.asOf && _dashData.asOf.today) || todayPacific();
  }
```

**Chip markup** (UI-SPEC and RESEARCH):
```javascript
'<button type="button" class="bp-attn-chip' + toneCls + '" data-attn="' + key + '" aria-label="' + escapeHTML(aria) + '">' +
  '<span class="bp-attn-label">' + escapeHTML(label) + '</span> ' +
  '<span class="bp-attn-count">(' + n + ')</span><span class="bp-attn-go" aria-hidden="true">›</span></button>'
```
Wrap in `<div class="bp-attn" role="group" aria-label="Needs attention">`. All-clear: `<p class="bp-attn-empty">Nothing needs attention right now.</p>`, only when every input is settled and available (never while the waitlist is `loading`, never when any input failed).

**Analog 4: click delegation.** `onDashV2Click` (L8430) is an if-chain of `t.closest(...)` branches. Add before the generic branches (e.g. directly after the `[data-dash-drill]` line, L8449):
```javascript
    if ((el = t.closest('[data-dash-drill]'))) { onDashV2TileClick(el); return; }
    if ((el = t.closest('[data-attn]'))) { onDashV2AttnClick(el); return; }
```
Recompute the id set from the model at tap time so the banner N equals the current count.

**Analog 5: lazy once-per-load fetch with token guard** (`ensureDashCalData` L9315-9334). Copy this for `ensureDashWaitlist`; call it from the `t0` render exactly as the packcal render calls `ensureDashCalData(today)`:
```javascript
  function ensureDashCalData(today) {
    if (!_dashData || !isDashV2()) return;
    if (_dashCal.tok && _dashCal.loadTime === _dashLoadTime && _dashCal.data === _dashData) return;
    var tok = {};
    _dashCal = { tok: tok, loadTime: _dashLoadTime, data: _dashData, tasks: null, tasksFailed: false, bookingsState: 'loading', bookings: [] };
    function settle(patch) {
      if (_dashCal.tok !== tok) return;
      Object.keys(patch).forEach(function (k) { _dashCal[k] = patch[k]; });
      if (isDashV2()) rerenderDashV2Widget('t3');
    }
    try {
      adminApiGet('get_tasks_calendar', { ... }).then(function (r) { settle(...); }, function () { settle(...); });
    } catch (e) { ... }
```
State var declaration goes next to `_dashCal` at L4224: `var _dashCal = { tok: null, loadTime: null, data: null, ... };`. New: `var _dashWaitlist = { tok: null, loadTime: null, state: 'loading', count: 0 };` and `var _dashInviteSent = {};`. Settle uses `rerenderDashV2Widget('t0')`. Count with `filterWaitlistRows(rows, 'waiting', '').length` (L4071), the same predicate the tab uses.

**Analog 6: session invite override.** The widget Send Invite handler (L15939-15957) only toasts on success. Add `_dashInviteSent[ibid] = true; if (isDashV2()) rerenderDashV2Widget('t0');` inside the success `.then`:
```javascript
            sendBottlingInviteForBatch({ name: iname, batchId: ibid, productName: rtbInvite.getAttribute('data-product') || '' })
              .then(function () { showToast('Bottling invite sent', 'success'); })
```
Do the same in the detail-pane handler (`sendBottlingInviteForBatch` call near L12403-12430). Do not add any new send path or button (F9). Do not call `loadDashboard()` straight after: the server stamp is fire-and-forget (`routes/pos.js:4361-4362`) and may not be visible yet.

---

### `js/brewpad.js`: tap-through, drill extension, Tasks filters (event-driven)

**Drill: `openDashDrill`** (L9675-9687). Extend with optional `spec.notes` (id to string) and `spec.order` (id array); keep `.ids/.count/.label` unchanged for existing consumers:
```javascript
  function openDashDrill(spec) {
    var ids = (spec && spec.ids) || [];
    var map = {};
    for (var i = 0; i < ids.length; i++) map[ids[i]] = true;
    _dashDrill = { ids: map, count: ids.length, label: String((spec && spec.label) || '') };
    _batchStatusFilter = 'all';
    _batchSearch = '';
    _batchProductFilter = '';
    _batchesLoaded = false;
    var searchEl = document.getElementById('bp-batch-search');
    if (searchEl) searchEl.value = '';
    switchTab('batches');
  }
```
Add `notes: (spec && spec.notes) || null, order: (spec && spec.order) || null` to the `_dashDrill` literal. Update the state-declaration comment at L4158 (`{ ids, count, label }`). Banner label rendering stays `escapeHTML(_dashDrill.label)` (L10002), so build labels as plain text.

**Drill row note and order:** in `renderBatchList` (card branch ~L10062-10110, table branch ~L10040-10060), when `_dashDrill && _dashDrill.notes && _dashDrill.notes[b.batch_id]` append `<div class="bp-past-plan">` + `escapeHTML(note)` + `</div>`; when `_dashDrill.order`, sort `filtered` by index in `order` before rendering (and before the table-view sort). Drill heading context is at L10014-10016.

**Do NOT use `dashV2Go`** for the batch chips (single id opens the detail pane and skips the banner, around L7466-7470). Call `openDashDrill` directly. Banner copy (UI-SPEC): `Showing {N} batches past schedule.` / `Showing 1 batch past schedule.` and `Showing {N} ready-to-bottle batches with no invite sent.` / `Showing 1 ready-to-bottle batch with no invite sent.`

**Tasks-tab filters.** `taskFilterOpts` (L14117-14127):
```javascript
    html += '<div class="bp-task-filters">';
    var taskFilterOpts = [
      { val: 'incomplete', label: 'To Do' },
      { val: 'all', label: 'All' },
      { val: 'transfer', label: 'Transfers' },
      { val: 'packaging', label: 'Packaging' }
    ];
    taskFilterOpts.forEach(function (f) {
      var active = _taskFilter === f.val ? ' bp-filter-btn--active' : '';
      html += '<button type="button" class="bp-filter-btn' + active + '" data-task-filter="' + f.val + '">' + f.label + '</button>';
    });
```
New order: To Do, Overdue (`overdue`), Due today (`duetoday`), All, Transfers, Packaging. Filter branches go with the existing `_taskFilter` branches (~L14070-14076); use `dashV2TodayDate()`, never `todayStr()` (UTC), and require a due date (existing grouping at L14106 puts undated tasks in "Overdue", which the new filters must not):
```javascript
var today = dashV2TodayDate();
if (_taskFilter === 'overdue')  return !done && due && due < today;
if (_taskFilter === 'duetoday') return !done && due && due === today;
```
Empty copy for the two filters only, replacing L14132 `No upcoming tasks — all caught up!`: `No overdue tasks.` / `No tasks due today.`

**Click handler** stays as is (L16372-16378); it already writes `_taskFilter = filterBtn.getAttribute('data-task-filter'); renderTasks();`, so the new values work with no handler change:
```javascript
      tasksInner.addEventListener('click', function (e) {
        var filterBtn = e.target.closest('.bp-filter-btn[data-task-filter]');
        if (filterBtn) {
          _taskFilter = filterBtn.getAttribute('data-task-filter');
          renderTasks();
          return;
        }
```
The dashboard chip tap-through sets `_taskFilter` directly then `switchTab('tasks')`.

**Waitlist preset.** `_waitlistFilter` (L4195, `var _waitlistFilter = 'all';`) is read by `renderWaitlist` (L14489: `filterWaitlistRows(..., _waitlistFilter, _waitlistSearch)`). `loadWaitlist` (L14468-14480) needs no change. The chip handler sets `_waitlistFilter = 'waiting'; switchTab('waitlist');`. No banner.

**Test seams to add (new keys only; existing keys stay).** `_setStateForTest` (L17195-17210) uses the `if ('key' in patch)` pattern. Add `_dashWaitlist`, `_dashInviteSent`, `_taskFilter`, `_waitlistFilter`, plus getters for the last two in `_getStateForTest` (L17189-17192 returns `_dashDrill`, `_selectedBatchId`, etc.):
```javascript
        if ('_dashData' in patch) _dashData = patch._dashData;
        if ('_upcomingTasks' in patch) _upcomingTasks = patch._upcomingTasks;
        if ('_upcomingLoaded' in patch) _upcomingLoaded = patch._upcomingLoaded;
```

---

### `css/brewpad.css` (styles)

Append the new block near the Phase 95 drill block (after L580) or at the end of the Phase 97 dashboard block. Tokens only, no hex literals, no new variables.

**Chip base: copy `.bp-filter-btn`** (L614-627) for font, height, transition and tap highlight, with `--r-md` radius per UI-SPEC:
```css
.bp-filter-btn {
  padding: 8px 14px;
  font-size: 0.8rem;
  font-weight: 700;
  font-family: var(--font-body);
  border: 1px solid var(--ledger-emphasis);
  border-radius: 14px;
  background: var(--cellar-raised);
  color: var(--ink-secondary);
  cursor: pointer;
  min-height: 44px;
  transition: background-color 0.15s, color 0.15s, border-color 0.15s;
  -webkit-tap-highlight-color: rgba(0,0,0,0);
}
```
**Focus ring: copy** `.bp-drill-banner-close:focus-visible { outline: 2px solid var(--ledger-focus); outline-offset: 2px; }` (L579).

**Tint pairs:** `--batch-warning` / `--batch-warning-bg` (L55-56) and `--batch-danger` / `--batch-danger-bg`; existing usage `.bp-status-badge--warning { background: var(--batch-warning-bg); color: var(--batch-warning); }` (L425) and `.bp-attention--warning { background: var(--batch-warning-bg); border-left: 3px solid var(--batch-warning); }` (L492).

**Contrast decision (RESEARCH Pitfall 5, computed): amber text on its tint fails 4.5:1 (2.58 to 3.12).** For `.bp-attn-chip--warn` keep the amber border and tint (`border-color: var(--batch-warning); background: var(--batch-warning-bg)`) but set `color: var(--ink-primary)`. For `.bp-past-plan` use `color: var(--ink-secondary)` with `border-left: 3px solid var(--batch-warning)` (pattern from L492), not amber text. Red chip (`--batch-danger` on `--batch-danger-bg`) passes. This is the fallback the approved UI-SPEC explicitly allows.

**Reduced motion:** existing block at L386 `@media (prefers-reduced-motion: reduce)`; add `.bp-attn-chip { transition: none; }` inside a new reduced-motion rule (or chips simply declare no `transition`). `.bp-attn-count { font-variant-numeric: tabular-nums; }`. Chip row: `.bp-attn { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }`.

---

### `tests/frontend/brewpad-dashboard-v2-attention.test.js` (new, jsdom)

**Analog:** `tests/frontend/brewpad-dashboard-v2-today.test.js`. Copy its preamble (L1-104) verbatim: globals (`global.google`, `global.fetch`, `global.sessionStorage`), auth shims, `require('../../js/brewpad')`, then `TODAY`/`YEAR`/`ASOF`, `flush`, `d(n)`, `lean`, `mount`, `renderV2`, `task`, `beforeEach`, `afterEach`.

**Preamble to copy** (L5-26):
```javascript
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
...
var bp = require('../../js/brewpad');
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };
```
**Mount and state seeding** (L60-84): `mount(opts)` seeds `_allBatchesData`, `_dashData` (`Object.assign({ asOf: ASOF, batches: list, staffBatchIds: [] }, o.extra || {})`), `_dashSummary`, then `_upcomingTasks`/`_upcomingLoaded`; `renderV2` sets the URL, calls `bp._initDashV2FlagForTest()`, dispatches `hashchange`, `bp._renderDashboardForTest()`, `await flush()`. For this phase pass `extra: { batchMeta: [...], inviteSentIds: [...] }` and `summary: { readyToBottle: [...] }`.
**Cleanup** (L101-104): `bp._clearDashDrillForTest(); delete window.Chart;`.

New test file only; do not edit `brewpad-dashboard-v2-today.test.js` (rule 10). Required cases are listed in 98-RESEARCH.md "Validation Architecture" and UI-SPEC "Implementation Notes". Add a pure-model section that requires `bp.buildDashAttentionModel` and `bp.dashPastPlanDays` directly (grace edge: over = 14 excluded, 15 included; no schedule excluded; singular string helper). Use the `fetch` mock for `get_waitlist` (it answers through `adminApiGet`).

---

## Shared Patterns

### Staff-batch handling
**Source:** `js/brewpad.js` L804 (`isStaffRow`) and L7336-7339 (staffIds map from `_dashData.staffBatchIds`)
**Apply to:** the invite count only (D-15). Overdue, due today, past schedule and waitlist include staff batches (D-07).

### Escape all dynamic strings
**Source:** `escapeHTML` used on every interpolation (e.g. L10002 banner label, L9207-9218 row builders)
**Apply to:** chip labels, aria-labels, drill labels, row notes, ids in `data-*` attributes.

### Additive, ids-only server reads
**Source:** `DASH_STATS_STAFF_SQL` comment at `batch-pg-read.js:92-93` ("ids only, never customer columns")
**Apply to:** `inviteSentIds`. No emails, no timestamps.

### Neutral copy and banned words
**Source:** UI-SPEC Copywriting Contract
**Apply to:** all new copy. No "stale", "conflict", "unbilled", "missing", or "late" as a chip label; red only for `Overdue`. Guard with a test over rendered DOM text, banner and note strings (code comments may say "stale").

### No Zoho calls
**Apply to:** everything. All new data is Postgres (stats key) or Apps Script (`get_waitlist`). The shared 1,000 calls/day Zoho Inventory quota must not be touched.

### Build artifacts
Edit `js/brewpad.js` and `css/brewpad.css` only, then `npm run build`. Never hand-edit `js/brewpad.min.js`, `css/brewpad.min.css`, `js/main.js`.

## No Analog Found

None. Every piece has an in-repo analog. Two pieces are small additions without an exact precedent, both covered by composite patterns above:

| Piece | Reason |
|-------|--------|
| Lead slot above `.bp-dash-grid` (`lead` property on a section) | No section has a lead slot today; extend `dashV2SectionsHtml` minimally. Must not alter `slots` because an existing test pins them. |
| Drill `notes` and `order` fields | `_dashDrill` has only `ids/count/label` today; extend additively, existing consumers read only those three. |

## Metadata

**Analog search scope:** `js/brewpad.js`, `css/brewpad.css`, `zoho-middleware/lib/batch-pg-read.js`, `zoho-middleware/__tests__/db/`, `tests/frontend/`
**Files scanned:** 8 read (targeted ranges), plus grep across `js/brewpad.js`, `css/brewpad.css`, middleware tests
**Pattern extraction date:** 2026-11-05

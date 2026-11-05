# Phase 98: Dashboard alerts and quick wins - Research

**Researched:** 2026-11-05
**Domain:** BrewPad v2 dashboard (vanilla ES5 in `js/brewpad.js`, `css/brewpad.css`) plus a small additive read in `zoho-middleware`
**Confidence:** HIGH on code locations and data flow (read directly from source). MEDIUM on the `planned_days` vs `schedule_snapshot` equivalence and on production task counts (not verifiable here).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** The owner approved **A1, A2, A4 and A5** on 2026-11-05 and **struck A3**. Tick §7 in `.planning/research/brewpad-dashboard-v2.md` with this amendment. (Already done: line 246 and the 2026-11-05 note at line 255. Verified, nothing left to tick.)
- **D-02:** **A4 is a count plus a filter, not a new list.** "Invite not sent (N)" opens the batch list filtered to those batches. Ready to bottle rows keep their existing Send Invite button (Phase 97). Sending stays a tap on that button behind the existing confirm sheet. **Nothing is emailed automatically** (F9).
- **D-03:** Counts shown, each **only when above zero**: 1. Overdue tasks 2. Due today 3. Past schedule (A2) 4. Invite not sent (A4) 5. Waitlist waiting (A5, D-13)
- **D-04:** Placement: a row of **count chips at the top of the Today section**, above Today's tasks. Like the rest of Today, it **ignores the global filter bar** (Phase 97 D-15).
- **D-05:** Tapping a count opens a **filtered list**: Task counts open the **Tasks tab** filtered to those tasks. Batch counts (past schedule, invite not sent) open the **Batches list** filtered to exactly those batches, using the Phase 95 click-through with its dismissible banner (D-14 there, `_dashDrill`). The waitlist chip opens the **Waitlist tab** filtered to Waiting.
- **D-06:** Add permanent **"Overdue" and "Due today" filter chips to the Tasks tab**, next to To Do / All / Transfers / Packaging. Tapping a count selects the matching chip, and staff can also use the chips directly. "Today" is the Vancouver day, as in Phase 97's Today section.
- **D-07:** **Staff and family batches are included** in Needs attention counts. They are real floor work, the same as production views and Today. The one exception is invite-not-sent (D-15).
- **D-08:** When every count is zero, show one neutral grey line: **"Nothing needs attention right now."**
- **D-09:** A batch is **past schedule** when it is active (primary or secondary) and `today - start_date > planned length + 14 days`. Production on 2026-11-05 had 6 of 40 such batches. The grace counts were: any overrun 12, +7 days 8, +14 days 6, flat 90 days 6.
- **D-10:** Planned length = the **largest `day_offset` in the batch's own `schedule_snapshot`**. It follows the schedule the batch actually got, not the category default. Production schedules run 27-56 days.
- **D-11:** Batches with **no schedule are left out** of the stale rule (1 on production). There is no flat 90-day fallback.
- **D-12:** **Neutral wording:** the chip reads **"Past schedule (N)"** in **amber, not red**. Red stays reserved for overdue tasks. In the filtered batch list each row shows **"N days past plan"**. Never use "stale" in copy.
- **D-13:** The chip shows the **Waiting** count only ("Waitlist waiting (N)"). It opens the Waitlist tab with the status filter set to `waiting`. It lives in the Needs attention row and follows D-03's above-zero rule.
- **D-14:** A batch counts for invite-not-sent when **all three** hold: it is in Ready to bottle (the same `readyToBottleList()` the widget and Batches chip use); it has a customer email; `bottling_invite_sent_at` is empty. It leaves the count once an invite is sent. Batches with no email can't be invited and are not counted.
- **D-15:** **Staff and family batches are excluded** from invite-not-sent. They don't need a customer booking invite. This is the only Needs attention count that excludes them.

### Claude's Discretion
- Chip order within the row (D-03's order is a sensible default), chip styling, and exact copy for the Tasks-tab chips. Copy must stay neutral, as in Phases 96 and 97.
- Whether counts are computed client-side from already-loaded data or added to the Phase 94 dashboard stats. This must not add N+1 calls or extra Zoho quota use.

### Deferred Ideas (OUT OF SCOPE)
- **A3 vessel conflict alert:** struck. Revisit only if vessel sharing stops being allowed.
- **Over-capacity alert** (a vessel type fully occupied): offered as an A3 replacement and not chosen.
- **Todo housekeeping (not this phase):** `.planning/todos/pending/recipe-og-target-fg-capture.md` appears resolved by Phase 97. Close it separately.
- Reviewed, not folded: `brewpad-bottled-status-stale-ui.md`; attribution/kiosk/gift-card/Helcim todos are unrelated.
- Out of scope: v1/classic dashboard (frozen), responsiveness/performance/default-v2 (Phase 99), any automatic emailing (F9), new write paths.
</user_constraints>

<phase_requirements>
## Phase Requirements

No formal REQ IDs are mapped (TBD). Scope is handoff items A1, A2, A4, A5 (A3 struck).

| ID | Description | Research Support |
|----|-------------|------------------|
| A1 | Needs attention counts by type, each linking to a filtered list | Counts from `_upcomingTasks` via the existing `dashTodayTaskRows` (js/brewpad.js:9183); new Tasks-tab `overdue`/`duetoday` filters (14070-14075, 14118-14123, 16373-16377) |
| A2 | Past-schedule alert, per-batch planned length + 14 d | `_dashData.batches` (status, start_date) + `_dashData.batchMeta[].planned_days` (already shipped in Phase 96; zoho-middleware/lib/batch-pg-read.js:125-127, 424) |
| A4 | Ready to bottle, invite not sent, count + filter | `readyToBottleList()` (9174) + `has_email`; invite-sent ids need one additive stats key (see Data Sources) |
| A5 | Waitlist waiting count, links to Waitlist tab | `get_waitlist` fetch (14472) + `filterWaitlistRows(rows,'waiting','')` (4071); preset `_waitlistFilter` (4195) |
</phase_requirements>

## Summary

Everything the row needs is already in memory on a v2 dashboard load except two inputs. Overdue and due-today come from `_upcomingTasks` (the same array Today's tasks renders). Past schedule comes from `_dashData.batches` plus `_dashData.batchMeta[].planned_days`, which Phase 96 already ships. Ready to bottle comes from `readyToBottleList()`, whose items carry `has_email`. The staff flag comes from `_dashData.staffBatchIds`. The two missing inputs are (a) which ready-to-bottle batches have already been invited, because `bottling_invite_sent_at` is not in the dashboard stats or the summary payload, and (b) the waitlist, which is only fetched when the Waitlist tab opens.

All of this is Postgres or Apps Script traffic. Nothing in Phase 98 touches Zoho Inventory, so the 1,000 calls/day shared quota is not at risk. The one hazard is accidentally adding a Zoho-backed call; do not.

The tap-through machinery exists: `openDashDrill` (9675) takes an exact id set plus a banner label, and the Tasks and Waitlist filters are plain module variables. The new work is (1) a pure attention model plus a render function mounted outside `.bp-dash-grid` (an existing test pins the grid children), (2) two Tasks-tab filter values and a Vancouver-day predicate (the Tasks tab currently uses the UTC day), (3) a per-row note and sort order for the Past-schedule drill, (4) a waitlist count fetch, and (5) one additive middleware key `inviteSentIds`.

**Primary recommendation:** Compute all five counts client-side in one pure, exported `buildDashAttentionModel()`. Add one ids-only `inviteSentIds` array to `get_dashboard_stats` (additive, no extra call). Fetch `get_waitlist` lazily once per dashboard load. Mount a new `t0` widget in a lead slot above `.bp-dash-grid` in the Today section. Do not use `dashV2Go` for the batch chips, because it opens the detail pane for a single id instead of showing the banner.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Overdue / due today counts | Browser (pure model over `_upcomingTasks`) | API (`get_tasks_upcoming`) | Must equal Today's tasks and the Tasks tab list, which read the same array |
| Past-schedule rule | Browser (pure model) | API (`batchMeta.planned_days`, already served) | Inputs already loaded; rule is display logic |
| Invite-not-sent flag | API (new `inviteSentIds` in stats) | Browser (session override after a send) | The stamp lives in Postgres; the client can't know it otherwise. Send stamp is fire-and-forget (race) |
| Waitlist waiting count | Browser (reuse `filterWaitlistRows`) | API (`get_waitlist` via admin proxy to Apps Script) | Same predicate as the tab guarantees chip == list |
| Tap-through navigation | Browser | none | `_taskFilter`, `_waitlistFilter`, `_dashDrill` are IIFE module state |
| Row note "N days past plan" | Browser | none | Pure display; stored on the drill spec at tap time |

## Standard Stack

No new libraries, no new CSP domains, no new packages.

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Vanilla ES5 in `js/brewpad.js` | n/a | All frontend logic | Project rule: ES5 only, ESLint `--max-warnings 0` (`package.json` lint script) |
| Jest + jsdom | existing (`npm test`) | Frontend unit tests | Existing pattern in `tests/frontend/brewpad-dashboard-v2-*.test.js` |
| zoho-middleware `lib/batch-pg-read.js` | existing | Adds the `inviteSentIds` query | Same pattern as `staffBatchIds` (DASH_STATS_STAFF_SQL, line 94-95) |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed in this phase. slopcheck not needed.

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
eagerLoad / loadDashboard (js/brewpad.js:6937, 7031)
   get_dashboard_stats ──> _dashData {batches, batchMeta, staffBatchIds, summary.readyToBottle,
   get_tasks_upcoming  ──> _upcomingTasks                         + NEW inviteSentIds}
   get_batches(all)    ──> _allBatchesData   (used by the drill, not by the counts)
        │
        ▼
renderDashboardV2 -> refreshDashV2 (7326) -> renderDashV2AllWidgets (8346)
        │                                      │
        │                          NEW widget t0 (lead slot above .bp-dash-grid)
        │                                      │
        │   ensureDashWaitlist() (NEW, once per _dashLoadTime, settles -> rerenderDashV2Widget('t0'))
        │   get_waitlist ──> _dashWaitlist {state, count}
        ▼
buildDashAttentionModel(inputs) [pure, top level, exported]
        │  items: overdue | today | past-schedule | invite | waitlist  (count > 0 only)
        ▼
renderDashV2Attention -> div.bp-attn > button.bp-attn-chip[data-attn]
        │ click (onDashV2Click delegation, 8430)
        ├─ overdue / today ──> _taskFilter = 'overdue'|'duetoday'; switchTab('tasks')
        ├─ past-schedule ────> openDashDrill({ids, label, notes, order})   (NOT dashV2Go)
        ├─ invite ───────────> openDashDrill({ids, label})
        └─ waitlist ─────────> _waitlistFilter = 'waiting'; switchTab('waitlist')
Send Invite (widget 15939 / detail pane 12406) ──success──> _dashInviteSent[id]=true; rerender t0
Task tick (change handler 16125) ──> loadDashboard() ──> full v2 re-render (t0 refreshes)
```

### Where things live (file:line evidence)

| Need | Location |
|------|----------|
| Today section definition | `DASH_V2_SECTIONS`, js/brewpad.js:8610-8612 (`slots: [['bp-dash-v2-today-tasks'],['bp-dash-v2-rtb'],['bp-dash-v2-packcal', true]]`) |
| Section HTML builder | `dashV2SectionsHtml()`, 8622-8633: head div, then `.bp-dash-grid` of slot divs |
| Widget registry / runner | `DASH_V2_WIDGETS` (~8290-8321), `runDashV2Widget` 8333-8343, `rerenderDashV2Widget` 8350 |
| Today's tasks render | `renderDashV2TodayTasks` 9269-9286 (guard: `_upcomingLoaded`, else "Not available yet. Reopen the Dashboard tab to refresh.") |
| Vancouver "today" | `dashV2TodayDate()` 9245-9247 = `_dashData.asOf.today` or `todayPacific()` (72-75) |
| Overdue/today partition | `dashTodayTaskRows(tasks, today)` 9183-9200 (open tasks, dated, `<` / `===` today) |
| Ready to bottle list | `readyToBottleList()` 9174-9177; items `{batch_id, product_name, customer_name, vessel_id, shelf_id, status, bottling_due, overdue, has_email}` (zoho-middleware/lib/batch-rules.js:843-853) |
| RTB widget dedupes by batch_id | `renderDashV2Rtb` 9290-9298 (the count must dedupe the same way) |
| Staff flag | `isStaffRow(row, staffIds)` 805-807; `staffIds` built from `_dashData.staffBatchIds` in `refreshDashV2` 7336-7339 |
| Drill | `openDashDrill(spec)` 9675-9687 (sets `_batchStatusFilter='all'`, clears search/product, `switchTab('batches')`); filter `drillFilterRows` 9655-9658; banner render 10001-10005 (label is `escapeHTML`ed); clear paths 7457, 9692-9709, 15926 |
| Drill rows render | card view 10062-10110, table view 10040-10060 (`sortedFiltered`), both inside `renderBatchList` |
| Tasks tab | `renderTasks` 14056+ (filter at 14070-14076, `taskFilterOpts` 14118-14123, empty copy 14130-14132); click handler 16373-16378 (`_taskFilter = data-task-filter; renderTasks()`) |
| Waitlist tab | `loadWaitlist` 14468-14479, `renderWaitlist` 14481+, `_waitlistFilter` 4195, filter click 16421-16426 |
| Send Invite (widget) | handler 15939-15960 (calls `sendBottlingInviteForBatch` 5059); (detail pane) 12403-12430 |
| Classic Needs Attention (frozen) | 9007-9017, uses `d.overdueTasks` / `d.tasksDueToday` |
| Test seams | `_setStateForTest` 17195-17210 (`_upcomingTasks`, `_dashData`, `_dashSummary`, `_allBatchesData`), `_renderDashboardForTest` 17154, `_getStateForTest` (returns `_dashDrill`), `_clearDashDrillForTest`, `_switchTabForTest` 17103, `_setWaitlistStateForTest` 17112 |
| Pure helpers | `dayNumber(ymd)` (whole-day index, DST-proof) 364-367, `addDays` 370 |
| CSS tokens | `--batch-warning(-bg)` 55-56, `--batch-danger(-bg)` 57-58; `.bp-drill-banner` 557-579; `.bp-filter-btn` 614-632 (already `min-height: 44px`); `.bp-task-filters` 1681 |

### Data sources per count (the client-vs-server recommendation)

| Count | Source | Extra call? |
|-------|--------|-------------|
| Overdue (red) | `dashTodayTaskRows(_upcomingTasks, dashV2TodayDate()).overdue.length` | none |
| Due today | `...today.length` | none |
| Past schedule | `_dashData.batches` rows with `status` in primary/secondary and a valid `start_date`; `planned_days` from `_dashData.batchMeta`; `dayNumber(today) - dayNumber(start_date) > planned_days + 14`. Excluded when `planned_days` is null or <= 0 (D-11) | none |
| Invite not sent | `readyToBottleList()` deduped by batch_id, `has_email === true`, id not in `staffBatchIds`, id not in `_dashData.inviteSentIds`, not in the session map `_dashInviteSent` | none (new key on the existing stats call) |
| Waitlist waiting | `filterWaitlistRows(rows, 'waiting', '').length` over `get_waitlist` | 1 lazy call (Apps Script, not Zoho) |

**Why client-side, not server counts:** `summary.overdueTasks` / `tasksDueToday` exist (batch-rules.js:764-767) but are uncapped server numbers; the Tasks tab and Today's tasks list read `_upcomingTasks`. Using the server number would let the chip disagree with the list it opens (UI-SPEC requires equality). Use the list-derived number and assert in a test that it equals the Tasks-tab filtered count.

**Why `planned_days` and not parsing `schedule_snapshot`:** `batchMeta.planned_days` is `max(day_offset)` over the batch's own `batch_tasks` (batch-pg-read.js:125-127), and tasks are generated from the snapshot steps at create/regenerate (batch-pg-create.js:140, batch-pg-tasks.js:505-519). It is already on the client (Phase 96 G10 uses it, js/brewpad.js:2119, 3155) and `get_batches` rows carry `schedule_snapshot` only as a JSON string that may be absent after `_allBatchesData = []` clears. [ASSUMED: the two are identical for production batches; a manually added or edited task could push `max(day_offset)` above the snapshot max. Check once on staging by comparing the count to D-09's "6 of 40".]

**Why a server key for invite-sent:** `bottling_invite_sent_at` is on the batches table and in `get_batches`/`get_batch` rows, but not in `get_dashboard_stats`, `summary.readyToBottle` (batch-rules.js:843-853), or `DASHBOARD_BATCHES_SQL` (batch-pg-read.js:64-67). `_allBatchesData` does contain it but is lazily loaded and set to `[]` at many write sites (5431, 5859, 10521, 11860, 12389, 13633, 16024), so a count built on it would silently drop. Add `inviteSentIds` (ids only, like `staffBatchIds`): `select batch_id from batches where bottling_invite_sent_at is not null order by length(batch_id), batch_id`. Do not add a field to `summary.readyToBottle` items: `__tests__/fixtures/batches/golden.json` and `__tests__/backfill/batches-parity.test.js` pin that payload shape against Apps Script. The stats memo is 60 s and cleared on any successful write (batch-store.js:149-168), so a stamp invalidates it. The client must treat a missing `inviteSentIds` array as "unavailable" and omit the Invite chip (safe if frontend deploys before middleware; staging first anyway).

### Recommended Project Structure
```
js/brewpad.js                      # top-level pure model + exports; IIFE render/handlers
css/brewpad.css                    # .bp-attn* and .bp-past-plan (append near the Phase 97 block)
zoho-middleware/lib/batch-pg-read.js   # DASH_STATS_INVITED_SQL + inviteSentIds
tests/frontend/brewpad-dashboard-v2-attention.test.js  # new file (do not edit old tests)
zoho-middleware/__tests__/db/batch-pg-invite-sent-98.test.js  # new DB test
```

### Pattern 1: pure model, exported, then a thin render
Mirror `buildG10Model` (top-level, exported in `module.exports` at ~17310).
```javascript
// Source: repo pattern (buildG10Model, js/brewpad.js:17310 export block)
function buildDashAttentionModel(inp) {
  // inp: { today, tasks, tasksLoaded, batches, batchMeta, staffIds, readyToBottle,
  //        inviteSentIds (array|undefined), localSent (map), waitlist: {state, count} }
  var items = [];           // {key, label, count, ids?, notes?, tone}
  var unavailable = 0;      // inputs that could not be determined
  // ... one predicate per count; push only when count > 0
  return { items: items, unavailable: unavailable, allClear: items.length === 0 && unavailable === 0 };
}
```

### Pattern 2: a lead slot above the grid (do not add to `slots`)
`tests/frontend/brewpad-dashboard-v2-today.test.js` asserts `.bp-dash-grid > div` ids equal exactly `['bp-dash-v2-today-tasks','bp-dash-v2-rtb','bp-dash-v2-packcal']`. Adding the slot to `slots` breaks that existing test, and CLAUDE.md rule 10 forbids editing it. Add an optional `lead: 'bp-dash-v2-attn'` property on the Today section and emit `<div id="bp-dash-v2-attn"></div>` between `.bp-dash-section-head` and `.bp-dash-grid` in `dashV2SectionsHtml`. Register widget `{ key: 't0', slot: 'bp-dash-v2-attn', needs: [] }` with a self-contained render (own try/catch). Note `runDashV2Widget` falls back to `dashV2Msg`, which builds a `.bp-widget` shell; the attention render must handle its own "Not available" case with `<p class="bp-empty">` so it never wraps in a widget shell.

### Pattern 3: chip click via the existing delegation
Add a branch in `onDashV2Click` (8430) before the generic ones: `if ((el = t.closest('[data-attn]'))) { onDashV2AttnClick(el); return; }`. Recompute the id set at tap time from the same model (so the banner N equals the current count).

### Pattern 4: drill extensions
Extend `openDashDrill(spec)` to accept optional `spec.notes` (id -> string) and `spec.order` (id array). Store on `_dashDrill`. In `renderBatchList` card and table branches, when `_dashDrill && _dashDrill.notes && _dashDrill.notes[b.batch_id]`, append `<div class="bp-past-plan">...</div>`; when `_dashDrill.order`, sort `filtered` by it (and bypass the table-view `sortedFiltered` sort for that case, or sort by `order` before it). The note must not appear outside a drill (D-12/UI-SPEC). Do not change `_dashDrill` consumers that only read `.ids`/`.label`.

### Anti-Patterns to Avoid
- **Using `dashV2Go` for the batch chips:** with exactly one id it calls `openDashBatch` and skips the banner (js/brewpad.js:7466-7470). UI-SPEC wants "Showing 1 batch past schedule." Call `openDashDrill` directly.
- **Using `todayStr()` for the new Tasks filters:** it is `new Date().toISOString().slice(0,10)` (line 67-69), the UTC day. After about 4-5 pm Pacific it is already tomorrow. Use `dashV2TodayDate()` / `todayPacific()`.
- **Changing the classic Needs Attention block (9007)** or its tests.
- **Adding a field to `summary.readyToBottle`** (parity-pinned, see above).
- **Reading `_allBatchesData` for counts** (cleared at many write sites).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Whole-day arithmetic | `Date` subtraction | `dayNumber(a) - dayNumber(b)` (364) | DST-proof, UTC-based, already tested |
| Vancouver today | Intl code | `dashV2TodayDate()` | Same boundary as Today (D-06) |
| Overdue / due-today partition | a second filter | `dashTodayTaskRows` (9183) | Chip, Today's tasks widget and Tasks filter agree by construction |
| Waiting predicate | `status === 'waiting'` inline | `filterWaitlistRows(rows,'waiting','')` | Same predicate as the tab |
| Ready to bottle set | recompute from tasks | `readyToBottleList()` | D-14 requires the same source |
| Banner / dismiss | new banner | `openDashDrill` + `data-action="clear-dash-drill"` | Dismiss resets `_batchStatusFilter` to `active` already (9700-9709) |
| Email sending | any new send path | existing confirm sheet + `sendBottlingInviteForBatch` | F9: nothing auto-sent; no new write paths |

## Runtime State Inventory

Not a rename or migration phase. Omitted.

## Common Pitfalls

### Pitfall 1: Slot placement breaks an existing test
**What goes wrong:** Adding the attention slot to `DASH_V2_SECTIONS[today].slots` fails `brewpad-dashboard-v2-today.test.js` ("titles, hints and slots in D-14 order").
**How to avoid:** lead slot outside `.bp-dash-grid` (Pattern 2). Hint text stays `"Right now. The filters above don't apply."` (UI-SPEC says do not repeat it).
**Warning signs:** that test fails.

### Pitfall 2: Invite count does not decrement after Send Invite
**What goes wrong:** The widget Send Invite handler (15939-15960) only toasts; it does not update client state or refresh the dashboard. Separately, the server stamp is fire-and-forget and runs concurrently with the response (zoho-middleware/routes/pos.js:4361-4362), so an immediate `loadDashboard()` can read the pre-stamp row.
**How to avoid:** on send success (both the widget handler and the detail-pane handler at 12423) set `_dashInviteSent[batchId] = true` and call `rerenderDashV2Widget('t0')` if v2 is active. The server catches up on the next refresh. Test: after a simulated send, the chip count drops by one without any fetch.

### Pitfall 3: Tasks-tab day boundary and grouping
**What goes wrong:** `renderTasks` uses `todayStr()` (UTC) for its groups (14058) and puts undated tasks in the "Overdue" group (`!due || due < today`, 14111). A new filter that reuses those groups would disagree with the dashboard chip late in the evening PT and would include undated tasks.
**How to avoid:** the new `overdue` / `duetoday` filter branches (add at 14072-14075) must use the Vancouver day and require a due date. Recommend switching the `today` variable in `renderTasks` to `dashV2TodayDate()` (a latent UTC bug fix, small) so group headers match the filter; no existing test covers `renderTasks` (grep of tests/frontend and tests/e2e found none), so it is unpinned. Surface this to the owner as a design smell, not a silent change.

### Pitfall 4: `_upcomingTasks` is a capped list loaded with three different limits
**What goes wrong:** eagerLoad uses `limit: 200` (6937+), `loadDashboard` uses 100 (7031), `loadTasks` uses 60 (14034). Each overwrites `_upcomingTasks`. The list is sorted by due date ascending (batch-rules.js:700-706), so overdue and today come first and are only truncated if overdue plus today exceeds the limit.
**How to avoid:** Recommend raising `loadTasks` to 200 to match eager load so tapping a chip cannot shrink the list under it. Planner test: counts equal filtered list length for a fixture of 70+ open tasks. Open question 2 covers the production headroom.

### Pitfall 5: Amber text fails contrast
**What goes wrong:** Computed contrast of `--batch-warning` (#b87a1a) on its 8% tint: 3.12:1 on `--cellar-raised`, 2.93:1 on `--cellar-surface`, 2.58:1 on `--cellar-canvas`. All fail 4.5:1 for 14px text, and also for the 12px `N days past plan` note. Red (`--batch-danger`) on its tint passes (4.56-5.52:1). [VERIFIED: computed with WCAG relative-luminance formula in this session]
**How to avoid:** use the UI-SPEC's own fallback: chip text `--ink-primary`, keep amber border and tint. For the row note use `--ink-secondary` (#6b5442) with an amber left border or dot, not amber text. Add a CSS assertion test for the chosen tokens.

### Pitfall 6: UI-SPEC says the invite drill rows show "Send Invite"; they do not
**What goes wrong:** The only `Send Invite` list button is the dashboard Ready-to-bottle row (js/brewpad.js:9238). The Batches list cards/rows (10040-10110) have none; the batch detail pane has "Send Bottling Invite" (12406 area).
**How to avoid:** Plan the invite drill as: banner plus normal batch cards; tap a card to open detail and use its existing invite button. Do not add a new button (no new write paths). Raise to the owner in discuss/plan-check if a list-row button is wanted (open question 3).

### Pitfall 7: Waitlist loading versus the all-clear line
**What goes wrong:** the waitlist count arrives after the rest. Rendering "Nothing needs attention right now." first, then a waitlist chip, is a false all-clear flash (UI-SPEC forbids a false all-clear when data failed).
**How to avoid:** `_dashWaitlist.state` in `loading|ok|failed`. Show the all-clear line only when every input is settled successfully. While loading render nothing for that chip and no all-clear; on failure omit the chip and also suppress the all-clear (open question 4 for the owner's preferred copy).

### Pitfall 8: Done tasks and stale ticks
Today's rows tick through the dashboard `change` handler (16125) which ends with `loadDashboard()` then a full v2 re-render, so counts refresh after the save. The optimistic checkbox state is set before the save and `_upcomingTasks[i].completed` is updated only on success (16152-16156); a re-render between those two moments would still count the task. Acceptable; do not add extra optimistic mutation.

### Pitfall 9: Banned copy
UI-SPEC bans "stale" anywhere in copy, plus "conflict", "unbilled", "missing", and "late" as a chip label. Code comments may contain "stale" (the codebase already does) but add a guard test over the rendered DOM text and the drill banner and note strings, not the source.

### Pitfall 10: Build artifacts
Edit only `js/brewpad.js` and `css/brewpad.css`; run `npm run build` (stamps `brewpad.html` cache version, regenerates `js/brewpad.min.js` and `css/brewpad.min.css`). Never hand-edit min files or `js/main.js`. `brewpad.html` references the min files (lines 16 and 27); the stamp rewrites the version.

### Pitfall 11: Existing server test pins the stats key set
`zoho-middleware/__tests__/db/batch-pg-dashboard-stats-96.test.js:192` asserts the exact top-level key list of `getDashboardStats` data (`asOf, batchMeta, batches, latestReadings, readings, staffBatchIds, summary, taskRows, tasks, vessels`). Adding `inviteSentIds` requires adding that one name to the list. CLAUDE.md rule 10 says do not modify existing tests unless asked, so the plan must call this out as a required, intentional contract change and get explicit owner acknowledgement (or fall back to a client-only approach, see Open Question 1). Middleware changes also need `cd zoho-middleware && npm test` and, for the DB tests, `npm run test:db` against a Postgres (CI uses postgres:16 while prod/staging run 18; memory note railway-postgres-is-v18).

### Pitfall 12: Staff handling inconsistency
All counts include staff batches except invite (D-07, D-15). Overdue and due today are task-based and include staff-batch tasks automatically. Past schedule must not apply `isStaffRow`. Invite must exclude by `staffBatchIds` (and `row.staff_batch === true` if a row is available).

## Code Examples

### Past-schedule predicate (pure)
```javascript
// Source: derived from D-09..D-11 and existing helpers dayNumber (js/brewpad.js:364)
function dashPastPlanDays(today, startDate, plannedDays) {
  var pd = Number(plannedDays);
  if (!(pd > 0) || !startDate || String(startDate).length < 10) return null;   // D-11: no schedule
  var over = dayNumber(today) - dayNumber(startDate) - pd;                      // days past plan
  return over > 14 ? over : null;                                               // D-09 grace
}
```
The chip counts batches where this is non-null; the row note shows `over` ("N days past plan" is overrun beyond plan, not beyond plan + 14, per UI-SPEC). Sort the drill by `over` descending. Singular: `over === 1`? Note over is always >= 15 here, so the "1 day past plan" form can never occur from the 14-day grace rule; still unit-test the string helper for 1 (UI-SPEC lists it) but do not expect it in an integration path.

### Tasks-tab filter branches
```javascript
// Source: extends js/brewpad.js:14070-14075
var today = dashV2TodayDate();   // Vancouver, replaces todayStr() for these branches
if (_taskFilter === 'overdue')  return !done && due && due < today;
if (_taskFilter === 'duetoday') return !done && due && due === today;
// where due = t.due_date ? String(t.due_date).slice(0,10) : ''
```
Add to `taskFilterOpts` in the UI-SPEC order: To Do, Overdue, Due today, All, Transfers, Packaging. Empty copy: `No overdue tasks.` / `No tasks due today.` (replace the generic "No upcoming tasks — all caught up!" for these two filters only, at 14130).

### Tap-through for tasks and waitlist
```javascript
// Source: pattern from js/brewpad.js:16373-16377 and 5900 switchTab
_taskFilter = (key === 'overdue') ? 'overdue' : 'duetoday';
switchTab('tasks');            // loadTasks renders cached rows immediately then refreshes
// then scroll the tab panel to top; keep _taskFilter afterwards (UI-SPEC: not reset)

_waitlistFilter = 'waiting';
switchTab('waitlist');         // loadWaitlist -> renderWaitlist honours _waitlistFilter
```
`loadWaitlist` writes the skeleton then renders; no change needed because `renderWaitlist` already reads `_waitlistFilter` (14489). No banner.

### Waitlist count fetch (lazy, mirrors ensureDashCalData 9304)
```javascript
// Source: pattern of ensureDashCalData (js/brewpad.js:9304-9323)
function ensureDashWaitlist() {
  if (!isDashV2() || _dashWaitlist.loadTime === _dashLoadTime) return;
  var tok = {};
  _dashWaitlist = { tok: tok, loadTime: _dashLoadTime, state: 'loading', count: 0 };
  adminApiGet('get_waitlist').then(function (res) {
    if (_dashWaitlist.tok !== tok) return;
    _dashWaitlist.count = filterWaitlistRows((res && res.data) || [], 'waiting', '').length;
    _dashWaitlist.state = 'ok';
    if (isDashV2()) rerenderDashV2Widget('t0');
  }, function () {
    if (_dashWaitlist.tok !== tok) return;
    _dashWaitlist.state = 'failed';
    if (isDashV2()) rerenderDashV2Widget('t0');
  });
}
```
Call it from the `t0` render (like `ensureDashCalData(today)` is called from the packcal render). The 5-minute auto-refresh (`startDashAutoRefresh`, 7059) triggers `loadDashboard`, which updates `_dashLoadTime` and so refreshes the count; no extra timer. get_waitlist goes to Apps Script (routes/pos.js:4723, 15 s timeout); it is slow but async and not Zoho.

### Chip markup (UI-SPEC)
```javascript
// Source: 98-UI-SPEC.md "Needs attention row"
'<button type="button" class="bp-attn-chip' + toneCls + '" data-attn="' + key + '" aria-label="' + escapeHTML(aria) + '">' +
  '<span class="bp-attn-label">' + escapeHTML(label) + '</span> ' +
  '<span class="bp-attn-count">(' + n + ')</span><span class="bp-attn-go" aria-hidden="true">›</span></button>'
```
Keys: `overdue`, `today`, `past-schedule`, `invite`, `waitlist`. CSS: `min-height: 44px`, no hex literals, tokens only, `@media (prefers-reduced-motion)` no transition.

### Server addition
```javascript
// Source: pattern of DASH_STATS_STAFF_SQL, zoho-middleware/lib/batch-pg-read.js:94-95 and 399-402
var DASH_STATS_INVITED_SQL =
  "select batch_id from batches where bottling_invite_sent_at is not null " +
  'order by length(batch_id), batch_id';
// in getDashboardStats chain: ... .then(res => { out.inviteSentIds = res.rows.map(r => r.batch_id); ... })
// and add `inviteSentIds: out.inviteSentIds` to the ok({...}) payload
```
It is one more query on the same sequential client in one request. Zero Zoho.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Classic dashboard "Needs Attention" from stats API (9007) | v2 attention row computed from loaded lists | Phase 98 | Classic stays frozen |
| Flat 90-day stale rule (F6) | Per-batch planned length + 14 d | D-09..D-11 | 6 of 40 vs 6 flat; fewer false alarms on 56-day schedules |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `batchMeta.planned_days` (max task day_offset) equals the max `day_offset` in `schedule_snapshot` for production batches | Data sources | Past-schedule count differs from D-09's 6; verify on staging, otherwise parse the snapshot server-side |
| A2 | Production open-task volume keeps overdue plus due-today comfortably under the 60/100/200 list caps | Pitfall 4 | Chip count could exceed the tab list; mitigated by raising `loadTasks` limit |
| A3 | Staging/production serve `get_dashboard_stats` from Postgres (so `inviteSentIds` is available); Sheets mode answers `invalid_action` and falls back to summary only | Data sources | In Sheets mode `_dashData` is null and v2 shows its existing "not available" path; the Invite chip is simply omitted |
| A4 | The owner is content with the invite drill showing normal batch cards (no list-row Send Invite button) | Pitfall 6 | Plan rework if a row button is wanted |

## Open Questions

1. **Server key vs client-only for invite-sent**
   - Known: adding `inviteSentIds` is the robust path but requires one existing-test key-list edit (`batch-pg-dashboard-stats-96.test.js:192`) and a middleware deploy.
   - Unclear: whether the owner accepts that one-line test change.
   - Recommendation: do the server key and state the test edit explicitly in the plan. Fallback if refused: derive from `_allBatchesData` rows (they carry `bottling_invite_sent_at`) and call `loadBatches()` when empty, omitting the chip until loaded. Weaker, but needs no middleware change.

2. **Production headroom of the task caps** — unknown number of open overdue tasks; recommend raising `loadTasks` to `limit: 200`.

3. **Send Invite on the invite drill rows** — see Pitfall 6; recommend detail-pane button only.

4. **Waitlist failure copy** — recommend: on failure omit the chip and suppress the all-clear line, with no new copy.

5. **Past-schedule note singular** — with a 14-day grace the overrun is at least 15, so "1 day past plan" can never display. Keep the helper pluralising correctly for tests; no action.

## Environment Availability

Step 2.6: SKIPPED for external tools. Code and config changes only. Existing local tools in use: Node (Jest, ESLint, terser, cleancss via `npm run build`). Middleware DB tests (`npm run test:db`) need a local Postgres; availability not probed. If absent, the new DB test cannot run locally and relies on CI, per the repo's existing practice.

## Validation Architecture

Skipped: `.planning/config.json` has `workflow.nyquist_validation: false`. Test guidance for the planner anyway:

- Frontend: new file `tests/frontend/brewpad-dashboard-v2-attention.test.js`, modelled on `brewpad-dashboard-v2-today.test.js` (mount helpers `mount`, `renderV2`, `task`, `lean`). Run: `npx jest --config jest.config.js tests/frontend/brewpad-dashboard-v2-attention.test.js`, then full `npm test`.
- Required cases (from UI-SPEC): chip order and zero hiding; exact all-clear copy; failed or loading data never shows the all-clear; red versus amber classes; each tap-through (tab switch, preselected filter, banner text incl. singular); chip count equals destination list length; staff included except invite; Vancouver late-evening boundary (stub the clock so UTC is already the next day); past-schedule rule incl. missing schedule and grace edge (over = 14 excluded, 15 included); `N days past plan` wording; chip updates after a task tick and after an invite send; banned-word guard; `min-height: 44px` present in `css/brewpad.css`; amber token choice.
- Wave 0 gaps: no seams for `renderTasks`, `_taskFilter`, `_waitlistFilter` getters, or `_dashWaitlist`/`_dashInviteSent` in `_setStateForTest`. Add test-only exports in `js/brewpad.js` (new keys only; existing seams stay). No existing test touches `renderTasks`.
- Middleware: new DB test for `inviteSentIds` (ids only, ordered, excludes null), run via `cd zoho-middleware && npm run test:db`; unit `cd zoho-middleware && npm test`. Both suites plus `npm run lint` before any commit (CLAUDE.md rules 1-2).
- E2E (Playwright) covers public pages only; no BrewPad e2e exists. Do not add one.
- Staging check (manual): on `staging.steinsandvines.ca/brewpad.html?dash=v2`, confirm the 6-of-40 figure, five-chip wrap on iPad portrait, and the amber chip legibility.

## Security Domain

`security_enforcement` is not set to false in config, so this section applies.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2/V3 Authentication, Session | no (unchanged; BrewPad session + admin proxy) | existing |
| V4 Access Control | yes (new read key) | `get_dashboard_stats` already tier-gated in `ADMIN_PROXY_ACTIONS` (routes/pos.js:4445-4492); the new key rides the same route |
| V5 Input Validation / output encoding | yes | `escapeHTML` on every dynamic string (labels, notes, banner text via existing `escapeHTML(_dashDrill.label)` at 10002). Ids go into `data-*` attributes only through `escapeHTML` |
| V6 Cryptography | no | n/a |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS via batch id / label in drill banner or note | Tampering | `escapeHTML`; build notes as text, not markup |
| PII exposure in new stats key | Information disclosure | `inviteSentIds` is ids only (same posture as `staffBatchIds`, comment at batch-pg-read.js:92-93 "ids only, never customer columns"); do not return emails. The waitlist fetch returns emails to the browser already (existing tab); the dashboard keeps only the count |
| Accidental auto-send | Elevation / abuse | No new write path; sending only via the existing confirm sheet (F9) |
| CSP | n/a | No new domains; no CSP edit (rule 12 not triggered) |

## Project Constraints (from CLAUDE.md)

- ES5 frontend only; edit `js/brewpad.js` and `css/brewpad.css`, never `js/main.js`, `js/main.min.js`, `js/brewpad.min.js`, `css/brewpad.min.css`. Run `npm run build` after JS or CSS changes.
- Before each commit: `npm test`, `cd zoho-middleware && npm test`, `npm run lint`; never commit failing tests.
- Do NOT modify existing tests unless explicitly asked (affects Pitfall 1 and Pitfall 11). Add new test files instead.
- Read existing code/tests and grep usages before modifying; after touching shared utilities run both full suites.
- One logical change per commit; bug fixes need a regression test first.
- No `.env` or credentials committed; every public HTML page keeps its CSP (no change here).
- Deploy: staging first (`git push origin main`), never straight to production. The middleware change needs a Railway deploy on each environment.
- v1/classic dashboard frozen; `?dash=v2` gating unchanged; all new UI lives behind v2.
- The `gemini` CLI is broken (memory note); research used grep and Read only.
- Memory notes relevant: Zoho Inventory daily quota is shared (no Zoho calls added); Postgres on Railway is v18 while tests use postgres:16.

## Sources

### Primary (HIGH confidence)
- Source code read this session: `js/brewpad.js` (cited lines), `css/brewpad.css`, `zoho-middleware/lib/batch-pg-read.js`, `lib/batch-rules.js`, `lib/batch-store.js`, `routes/pos.js`, existing `tests/frontend/brewpad-dashboard-v2-today.test.js`
- `.planning/phases/98-dashboard-alerts-and-quick-wins/98-CONTEXT.md`, `98-UI-SPEC.md`
- `.planning/research/brewpad-dashboard-v2.md` (§7 already ticked)
- WCAG contrast computed locally with the standard relative-luminance formula

### Secondary / Tertiary
- None. No external docs were needed; the phase uses no libraries.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new dependencies.
- Architecture: HIGH, every integration point read in source with line numbers.
- Pitfalls: HIGH for the code-evidenced ones (1-4, 6, 11); MEDIUM for 2 and 7, which depend on owner preference.

**Research date:** 2026-11-05
**Valid until:** 2026-12-05 (line numbers drift as Phase 97 follow-ups land; re-grep symbols, not numbers)

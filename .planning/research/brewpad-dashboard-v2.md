# HANDOFF — BrewPad Dashboard v2 (for Claude Code + GSD)

> **Roadmap note (added 2026-10-17):** this document is the source for milestone **v5.0 BrewPad Dashboard v2** (Phases 94–99 in `.planning/ROADMAP.md`).
> - **§7 Approval was not ticked when this was filed**, so nothing below is approved to build yet. Each phase's discuss-phase must record which §7 items the owner approves.
> - `HANDOFF-data-onboarding.md` (cited under "Read first") is not in the repo.
> - The rest of this file is the owner's handoff as received.

**Prepared:** 2026-10-17 · **Status:** PROPOSED — awaiting owner approval
**Owner:** Koa Inn · **Repo:** `/Users/koa/dev/steins-and-vines-website/`
**Read first:** `HANDOFF-infrastructure.md` (stack, build, deploy) and `HANDOFF-data-onboarding.md` (data gotchas).

> **Rule for Claude Code:** implement only the items ticked `[x]` in §7 Approval. Unticked items are out of scope.
> Any write to production data (backfills, batch edits) needs the owner's explicit OK in the session, even if the code item is approved.

---

## 1. Goal

Overhaul the BrewPad dashboard (`brewpad.html` → `js/brewpad.min.js` source) so that it:
1. has **more graphs with real options** (filters, period, grouping, click-through),
2. is **responsive and fast** on the shop tablet, phone and desktop,
3. **tracks beer and cider as first-class types**, not as "Other",
4. shows the numbers correctly. Some current figures are wrong (§3).

---

## 2. What the dashboard does today (observed live, 17 Oct 2026)

**KPI tiles:**
- Primary 13
- Secondary 26
- Complete 165
- Fermenting now 39
- Started this year 204
- Completed this year 165
- Avg days to complete **173**

**Batches by month:**
- Hand-built div bars, no chart library (`window.Chart` undefined, 0 canvases).
- Fixed 6-month window (May–Oct).
- Legend reads Wine (110) / Cider (4) / Other (6).

**Wine breakdown:**
- Horizontal bars by Subcategory / Brand / Manufacturer / Time.
- Period chips: 30d / 90d / 6m / 12m / All.
- Shows a total of 122 wine batches.

**Other sections:**
- Needs attention: overdue tasks and tasks due today.
- Collapsible "Needs scheduling (2)" and "Ready to bottle (10)".
- Today's tasks list.
- A Next 7 days strip.

**Shortcomings:**
- No beer or cider breakdown.
- No interactivity: no tooltips, nothing clickable through to batches.
- Every chart is wine-centric.
- The month chart can't change period.
- No volume (litres) view.
- No capacity view.
- No readings or fermentation curves.

**Data available** via the middleware admin proxy (`/api/batch/admin-proxy`):
- `get_batches`: 206 batches, 34 fields each, including `status`, `start_date`, `completed_at`, `vessel_id`, `shelf_id`, `bin_id`, `source`, `zoho_so_number`, `recipe_id`, `recipe_snapshot` (style, abv, ibu, batch_size_l, ingredients with `cf_type`/`cf_subcategory`), `schedule_snapshot` (steps with `day_offset`, `is_transfer`, `is_packaging`), `tasks_total`, `tasks_done` and `bottling_invite_sent_at`.
- `get_batch`: adds `tasks[]` (with `due_date`, `completed_at`, `completed_by`), `plato_readings[]` (`degrees_plato`, `temperature`, `ph`, `timestamp`, `recorded_by`) and `vessel_history[]`.
- **There is no bulk endpoint for tasks or readings.** The dashboard would need one `get_batch` call per batch (N+1), so see item S1.

---

## 3. Data findings that change the design

| # | Finding | Evidence | Implication |
|---|---|---|---|
| F1 | **"Avg days to complete: 173" is wrong.** The real mean is **63 days** (median 64, p10 38, p90 85, range 21–141) across 125 completed batches that have `completed_at`. 173 ≈ the average of *today − start_date* over all completed batches, so the calc appears to measure to *now* rather than to completion. | Computed from `get_batches` | Bug fix (B1). |
| F2 | **40 of 165 completed batches have no `completed_at`.** All were started Jan–Mar 2026 (legacy/import era). | Same | Exclude them from cycle-time stats. Optionally backfill (B2, needs owner OK). |
| F3 | **There is no batch type field.** Type is inferred. Today's classification lumps beer into "Other". The current split is roughly 198 wine, 6 cider, 2 beer (SV-B-000167 and SV-B-000229, Czech Lager). | Name and `recipe_snapshot` | Add an explicit `batch_type` (B3). Beer volume is small now but go-live is coming (`HANDOFF-beer-golive.md`). |
| F4 | **Inconsistent totals.** The month chart shows 120 batches, the wine breakdown says 122, and "started this year" is 204. Each widget filters differently. | Live page | Use one shared filter state and one shared classifier (D1). |
| F5 | **Vessel double-booking.** PCB-009, PFB-012, PCB-066 and PCB-016 are each assigned to **two active batches**. 3 active batches have no vessel. | Active batches only | Add capacity and conflict views (G6). These are probably data-entry errors worth fixing in the batch records. |
| F6 | **6 active batches are older than 90 days**, e.g. SV-B-000005. | `start_date` | "Stale batch" alert (A2). |
| F7 | **Readings are barely used.** There are 4 Plato readings across all 41 active batches. 1 has a temperature and none has a pH. | `get_batch` on all active | Fermentation curves would be empty today. Pair the chart with a "readings due" prompt (G8). |
| F8 | **Task timeliness looks poor or is logged late.** Of 114 completed tasks on active batches, 81 have `completed_at` after `due_date`. | `get_batch` tasks | Show on-time rate, but **confirm with staff** whether this is real lateness or after-the-fact ticking before treating it as a KPI. |
| F9 | **Bottling invites are never sent.** `bottling_invite_sent_at` is empty on all 206 batches. | `get_batches` | Add a "Ready to bottle, invite not sent" tile (A4). |
| F10 | **Billing linkage has gaps.** 57 of 206 batches have no `zoho_so_number`. 82 have a blank `source`. | `get_batches` | Data-health card (G10). Per the data onboarding rules, a missing link ≠ unbilled. |

---

## 4. Proposed changes

### Phase A — Correctness and foundations (do first)

- **B1. Fix avg cycle time.** Use `completed_at − start_date` and only for batches with `completed_at`. Show mean and median, and the count of batches excluded.
- **B2. (Optional, data write) Backfill `completed_at`** for the 40 legacy completed batches.
  - Source: the latest task `completed_at` on the batch, else `last_updated`.
  - Ship it as a dry-run script that prints the proposed values.
  - Only run it for real after owner approval, using `update_batch` with **nested `updates:{}`**.
- **B3. `batch_type` field (`wine` | `beer` | `cider` | `other`).**
  - Derive it once, in this order: recipe `style` → product `cf_type` from Zoho (by SKU/item_id, never by name) → name fallback.
  - Store it on the batch.
  - Set it on create in the kiosk, online and manual paths.
  - Backfill existing rows (data write → owner OK).
- **D1. Single dashboard data layer.**
  - One `getDashboardData(filters)` that every widget reads from.
  - One classifier.
  - One date-window helper.
  - Every total is consistent by construction.
- **S1. Server-side aggregate endpoint.**
  - Add `get_dashboard_stats`, or bulk `get_tasks`/`get_readings`, to the admin proxy (Apps Script + middleware).
  - Cache it ~60s.
  - This avoids N+1 `get_batch` calls and the heavy snapshot fields.
  - Return lean rows: id, type, status, dates, vessel, source, product, subcategory, volume, task due/complete dates, latest reading.

### Phase B — Global filters and chart engine

- **D2. Global filter bar** (sticky on scroll, collapses to a sheet on phones):
  - **Type:** All · Wine · Beer · Cider
  - **Period:** 30d · 90d · 6m · 12m · YTD · All · custom range
  - **Group by:** week · month
  - **Measure:** batches · litres. Volume is 23 L for wine and cider, 28 L brewed / 25 L packaged for beer; use `target_volume_L` if it's set.
  - **Source:** kiosk · online · manual · zoho_scan · research
  - **Toggle:** include staff, R&D and family batches (default off for sales views)
  - Filter state is kept in the URL hash, so views can be shared and bookmarked, and in localStorage.
- **D3. Chart library.**
  - Adopt **Chart.js 4** (lightweight, responsive, touch tooltips, good mobile behaviour), loaded from jsDelivr or bundled into the build.
  - Apache ECharts is an alternative if the heatmaps in G5 and G6 matter more than bundle size.
  - Brand palette tokens: wine = burgundy, cider = gold, beer = amber or green.
  - Wrap it in a small `chart()` helper so widgets stay ~20 lines each.
- **D4. Click-through.** Every bar, segment and KPI tile opens the Batches tab pre-filtered to those batches.
- **D5. Trend deltas.** KPI tiles show change vs the previous equivalent period (▲/▼).

### Phase C — New and upgraded graphs

| ID | Graph | Options |
|---|---|---|
| G1 | **Production over time**: stacked bars wine/beer/cider. Replaces "Batches by month". | period, group-by, measure (count/litres), type |
| G2 | **Pipeline**: pending → primary → secondary → ready to bottle → complete, per type | type |
| G3 | **Cycle time**: distribution (box or histogram) of start→complete per type and per kit line, with the planned schedule length overlaid | type, period, subcategory/brand |
| G4 | **Product breakdown**, generalised from today's Wine breakdown. Wine: subcategory/brand/manufacturer. Beer: style/recipe. Cider: recipe. Plus a top-10 products leaderboard. | type, dimension, period |
| G5 | **Workload forecast**: tasks due per day for the next 14/30 days, stacked by task kind (rack, filter, bottle/package, temperature step, dry hop) | horizon, type |
| G6 | **Vessel capacity and conflicts**: occupied vs available by vessel class (PCB, PFB, LPD) over time, with a list of double-booked or unassigned batches | class |
| G7 | **Task health**: overdue ageing buckets (1–3 d, 4–7 d, 8+ d), on-time rate trend, completions by staff (`completed_by`) | period, staff |
| G8 | **Fermentation curves**: °P over time per active batch against the expected curve, with attenuation and ABV estimate from OG/FG. This matters most for beer and cider. Includes a "readings due" list. | batch, type |
| G9 | **Sales source mix**: kiosk / online / manual over time | period |
| G10 | **Data health card**: active batches with no vessel, duplicate vessels, missing `completed_at`, missing `zoho_so_number`, blank `source`, stale >90 d | — |

### Phase D — Beer and cider specifics

- **Beer batch card and dashboard section:**
  - Style, ABV and IBU from `recipe_snapshot`.
  - OG/target FG against the latest reading.
  - Current schedule step, including temperature steps such as "Lower to 10 ºC" for lagers.
  - Packaging output: cans and litres packaged, with 25 L packaged per 28 L brew.
- **Cider section:** juice/recipe, yeast and the readings curve.
- **Packaging calendar:** bottling (wine/cider) and canning (beer) appointments for the next 2 weeks.
  - Coordinate with `HANDOFF-canning-copy-and-bundle.md` and `HANDOFF-kiosk-canning-bundle.md`. Don't duplicate their scope.

### Phase E — Alerts and quick wins

- **A1.** "Needs attention" gains counts by type and links to filtered task lists.
- **A2.** Stale batch alert for active batches more than N days past their planned schedule length. This beats a flat 90-day threshold.
- **A3.** Vessel conflict alert (from G6).
- **A4.** "Ready to bottle — invite not sent", with a one-tap link to the existing invite flow. **No automatic emailing.**
- **A5.** Waitlist count tile, linking to the Waitlist tab.

### Phase F — Responsiveness and performance

- **Layout:**
  - Mobile-first CSS grid: 1 column on phones, 2 on tablet, 3–4 on desktop.
  - Charts resize with their container.
  - Touch-friendly tooltips.
  - No horizontal scroll at 360 px.
- **Loading:**
  - Skeleton loaders.
  - Render cached data immediately (sessionStorage), then refresh in the background.
  - Charts below the fold load lazily.
- **Target:** dashboard interactive in **< 1.5 s on the shop tablet** on a warm cache, and < 3 s cold.
- **Accessibility:**
  - Colour is never the only signal; use patterns or labels as well.
  - Visible focus states.
  - Every chart has a table fallback ("view as table").

---

## 5. Constraints and gotchas

- **Stack:**
  - The site is static (`brewpad.html` + `js/brewpad.min.js`). Edit the **source** files and rebuild per `HANDOFF-infrastructure.md`. Don't hand-edit the minified bundle.
  - The middleware is Express on Railway.
  - BrewPad data is Google Sheets via Apps Script.
- **`update_batch` nests its fields:** `{action:'update_batch', batch_id, updates:{...}}`. Top-level fields return `{ok:true}` and **change nothing**.
- **Middleware caching:** the ingredient catalog is cached 1 h. Use `POST /api/admin/cache-clear` after changing Zoho items.
- **Classify by `cf_type` or SKU/item_id, never by product name.** Near-identical names are common.
- **Staff batches:** family/staff batches (McLachlan, Inn) and `source: research` are not sales. Exclude them from sales views by default, and keep them in production and capacity views.
- **No customer emails, no deletions, and no production data writes without the owner's OK in-session.** Backfill scripts must support `--dry-run`.

---

## 6. Suggested GSD flow

GSD's command prefix depends on the installed version: `/gsd:…` or `/gsd-…`. Run `/gsd:help` to check.

1. `/gsd:map-codebase --focus brewpad`. Skip this if `.planning/codebase/` already exists and is current.
2. Start the milestone:
   - If `.planning/PROJECT.md` exists: `/gsd:new-milestone "BrewPad Dashboard v2"`.
   - Otherwise: `/gsd:new-project`.
   - Feed it this file.
3. One GSD phase per approved section of §4, in order:
   - A Correctness → B Filters/engine → C Graphs → D Beer/cider → E Alerts → F Responsive/perf.
   - Phase A must land first; everything else depends on D1, B3 and S1.
4. For each phase, run `/gsd:discuss-phase N` → `/gsd:plan-phase N` → `/gsd:execute-phase N` → `/gsd:verify-work N`.
5. Ship behind a `?dash=v2` flag until the owner signs off, then make it the default.

**Acceptance for the milestone:**

- Cycle-time KPI is within ±1 day of an independent recompute from `get_batches`.
- Type totals across all widgets agree for any filter combination.
- Beer and cider appear as their own series everywhere wine does.
- Lighthouse mobile performance is ≥ 85 on `brewpad.html`.
- No horizontal scroll at 360 px.
- Every chart has click-through and a table view.
- No production data changed except backfills the owner approved.

---

## 7. Approval (owner ticks; Claude Code implements only `[x]`)

- [x] **B1** Fix avg cycle time
- [x] **B2** Backfill `completed_at` for 40 legacy batches (data write)
- [x] **B3** Explicit `batch_type` field + backfill (data write)
- [x] **D1** Single dashboard data layer
- [x] **S1** Server-side `get_dashboard_stats` / bulk endpoints
- [x] **D2** Global filter bar
- [x] **D3** Chart.js (self-hosted)
- [x] **D4** Click-through to filtered batch list
- [x] **D5** Trend deltas on KPI tiles
- [x] **G1** Production over time (count/litres)
- [x] **G2** Pipeline
- [x] **G3** Cycle time distribution
- [x] **G4** Product breakdown for all types + leaderboard
- [x] **G5** Workload forecast
- [x] **G6** Vessel capacity and conflicts
- [x] **G7** Task health (on-time rate pending staff check, F8)
- [x] **G8** Fermentation curves + readings due
- [x] **G9** Sales source mix
- [x] **G10** Data health card
- [x] **Phase D** Beer and cider sections + packaging calendar
- [ ] **A1–A5** Alerts and quick wins (strike any not wanted)
- [ ] **Phase F** Responsive and performance pass

**Owner notes:**

- 2026-10-23: Phase 94 items B1, B2, B3, D1 and S1 approved. Plan now; build after the Phase 87 batches→Postgres production cutover, so B3 and S1 target the Postgres batch store only. B2/B3 production writes still need an in-session OK after a `--dry-run`. Other items are decided at their own phase's discuss step.
- 2026-10-28: Phase 95 items D2, D3 (Chart.js 4, self-hosted in js/vendor), D4 and D5 approved. The redesign ships behind `?dash=v2`, remembered per device, and v1 is frozen. It adds an explicit staff/family/R&D batch flag with a reviewed candidate backfill (internal/research + McLachlan, Inn). See `95-CONTEXT.md`.
- 2026-10-28: Phase 96 items G1–G10 approved. Amendments: G7 shows no on-time rate and no completions by staff (D-02, D-03); G6 shows "Shared vessels" as allowed, not as conflicts (D-04); G8 has no "readings due" list, only a neutral "No readings yet" list (D-08, D-09); G10 does not list shared vessels and calls a missing SO "no invoice link", never unbilled (D-14). See `96-CONTEXT.md`.
- 2026-11-03: Phase 97 Phase D approved in full (beer card/section, cider section, 2-week packaging calendar). Folded: restore Today's tasks + Ready to bottle on v2, wire the Beer Packaging Cal.com type, Ready to Bottle filter on Batches. See `97-CONTEXT.md`.

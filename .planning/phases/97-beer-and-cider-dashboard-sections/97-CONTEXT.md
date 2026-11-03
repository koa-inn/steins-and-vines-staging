# Phase 97: Beer and cider dashboard sections - Context

**Gathered:** 2026-11-03
**Status:** Ready for planning

<domain>
## Phase Boundary

On the BrewPad v2 dashboard (`?dash=v2`), beer and cider get their own section of batch cards. A new
**Today** section at the top brings back the classic Today's tasks and Ready to bottle lists, beside a
2-week packaging calendar: wine and cider bottling, beer canning. The calendar shows real Cal.com
bookings and BrewPad packaging tasks. Folded in: the Beer Packaging Cal.com event type gets wired into
the middleware, and the Batches tab gets a Ready to Bottle filter.

Out of scope: v1 (frozen); Phase 98's alerts (Needs attention counts, stale batches, invite-not-sent,
waitlist tile); Phase 99's responsiveness and performance pass; recording actual packaged output.

</domain>

<decisions>
## Implementation Decisions

### Approval
- **D-01:** The owner approved **all of handoff Phase D** on 2026-11-03: the beer card and section, the
  cider section, and the packaging calendar. It is ticked in §7 of `.planning/research/brewpad-dashboard-v2.md`.
  A1–A5 and Phase F stay unticked and out of scope.

### Packaging calendar
- **D-02:** The calendar shows entries from **both sources**:
  - **Cal.com bookings** are confirmed appointments: wine/cider Bottling Appointment and Beer Packaging
    Appointment (event type `6028745`).
  - **BrewPad packaging tasks** (`is_packaging`) that have a due date in the window but **no matching
    booking** show as "not booked yet".
  This needs a new **list bookings** call in `lib/calcom.js`; today it can only create bookings and read
  slots. That call uses the Cal.com API, not the Zoho Inventory quota. Cache it and fail soft: if Cal.com
  is down, show the tasks with a short note, never an error page.
- **D-03:** A booking links to its batch by **auto-matching the booking's customer email** to an active
  batch's customer. A booking with no match still shows, labelled **"no batch matched"**. There is no
  manual-link write path. Research should confirm where the batch's customer email lives and what happens
  when one customer has several active batches.
- **D-04:** The format is a **list grouped by day**: Today, Tomorrow, then "Wed 5 Nov" and so on. Each
  entry shows time (for bookings), customer, batch, and the kind: bottling for wine and cider, canning
  (packaging) for beer. It covers 14 days from today, in America/Vancouver calendar days.
- **D-05:** Packaging tasks with **no date** stay **off the calendar**. The restored Ready to bottle list
  covers them.

### Beer card
- **D-06:** **Target OG and target FG become new fields on beer recipes** in the recipe editor. They are
  copied into `recipe_snapshot` when a batch is created. This also fills the Phase 96 G8 expected
  OG→FG curve, which today always shows "No expected curve". The two existing beer batches stay blank
  unless their snapshot is updated deliberately. No backfill writes without a dry run and the owner's
  in-session OK.
- **D-07:** The card shows style, ABV and IBU from `recipe_snapshot`; OG and target FG against the latest
  Plato reading; and the **next open task with its due date**, e.g. "Next: Lower to 10°C · due Thu 6 Nov".
  Temperature steps are highlighted. It uses the batch's real tasks, not a step worked out from day count.
- **D-08:** With no Plato reading, the reading line says **"No readings yet"**. The wording is neutral,
  as in Phase 96 D-09. Targets still show when known.

### Packaging output
- **D-09:** Output is **estimated only**: litres packaged = 25 L per 28 L brew, or the proportion of
  `target_volume_l` when set. It is shown as litres and approximate cans. Nothing new is entered or stored.
- **D-10:** Show **both can sizes**, e.g. "≈ 52 × 473 mL or 70 × 355 mL". The kiosk canning bundle sale
  isn't linked to the batch, so the chosen size isn't known.

### Cider
- **D-11:** Cider uses the **same card** as beer, with cider lines:
  - juice and yeast instead of IBU;
  - readings line and next step as for beer.
  The readings curve reuses the Phase 96 G8 fermentation chart rather than a new chart.
- **D-12:** Juice and yeast come **from the recipe ingredients in `recipe_snapshot`**, picked by type
  (`cf_type` / `cf_subcategory`). When missing, fall back to the recipe or product name. No new cider fields.

### Layout and restored lists
- **D-13:** Restore **Today's tasks** (overdue first, marked Overdue, then due today) and **Ready to
  bottle** from the classic dashboard. **Needs attention is not restored as it is**; Phase 98 A1 upgrades it.
  Reuse the classic rendering and its tests rather than writing a second version.
- **D-14:** A new **Today** section sits **at the top, under the KPI tiles**, holding Today's tasks,
  Ready to bottle and the 2-week packaging calendar. Production moves down one. This deliberately
  **amends Phase 96 D-11/D-12** ("Production first").
- **D-15:** The Today section **ignores the global filter bar** (period, type, source, staff). It always
  shows everything currently due, with a small note saying the filters don't apply.
- **D-16:** A new **Beer & cider** section comes after Floor today, with one card per active beer or cider
  batch. When there are none, show one short line ("No active beer batches" / "No active cider batches").
  Hide the section when Type = Wine. Cards follow the type filter; they are production views, so staff
  batches are included (Phase 95 D-10).

### Folded Todos
- **Restore Pending tasks + Ready to bottle on v2** (`.planning/todos/pending/brewpad-dashboard-v2-restore-tasks-and-ready-to-bottle.md`):
  the owner's 2026-10-29 note after Phase 96 went live. It is answered by D-13 to D-15: Today's tasks only,
  placed at the top, filters ignored.
- **Wire the Beer Packaging Cal.com type** (`.planning/todos/pending/calcom-beer-packaging-appointment.md`):
  register `CALCOM_EVENT_TYPE_BEER_PACKAGING=6028745` in `lib/validateEnv.js` and add it to the
  `routes/bookings.js` `ids` array and the `body.service` selector, following the
  `CALCOM_EVENT_TYPE_BEER_WAITLIST` pattern. Pick by slug with a fail-closed no-match guard, and keep the
  default backward compatible. The calendar (D-02) needs it. Setting the variable on staging and production
  Railway needs the owner in-session. `CALCOM_EVENT_TYPE_BEER_WAITLIST=6955754` is also still unset on
  production, so set both at once.
- **Ready to Bottle filter on the Batches tab** (`.planning/todos/pending/brewpad-ready-to-bottle-filter.md`):
  a "Ready to Bottle (N)" option in the batch-view filter bar. It uses the **same predicate** as the
  restored Ready to bottle list, from one source of truth, and a batch drops out as soon as it's marked
  bottled. It's a separate batch-list change; plan it as its own small plan.

### Claude's Discretion
- Card visual details, how temperature steps are highlighted, and the calendar entry styling. Run
  `/gsd-ui-phase 97` before planning; it is recommended since this is a UI-heavy phase.
- The Cal.com list-bookings cache TTL, and the exact email-matching rule (case-insensitive, trimmed).
- Field names for the recipe target OG/FG and how the Postgres recipes table and the Apps Script mirror
  carry them. Follow the Phase 85 recipe store conventions and migration numbering.
- How many cans to round to (whole cans, rounded down).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone spec
- `.planning/research/brewpad-dashboard-v2.md` — §4 Phase D (scope), §5 constraints (nested `updates:{}`,
  classify by `cf_type`/SKU, staff batches, no writes without the owner's OK), §7 approvals.
- `.planning/ROADMAP.md` — Phase 97 goal and draft success criteria.

### Prior phase decisions (locked)
- `.planning/phases/94-dashboard-correctness-and-data-foundations/94-CONTEXT.md` — batch_type, data layer
  D-20, aggregate endpoint D-21, Postgres batch store only.
- `.planning/phases/95-global-filters-and-chart-engine/95-CONTEXT.md` — filter bar, litres defaults (beer
  28/25 L), Chart.js helper, colours, click-through, staff flag.
- `.planning/phases/96-new-and-upgraded-dashboard-graphs/96-CONTEXT.md` — section layout (amended by D-14),
  G8 fermentation (D-08..D-10), "No readings yet" wording, task kinds.

### Folded todos
- `.planning/todos/pending/brewpad-dashboard-v2-restore-tasks-and-ready-to-bottle.md`
- `.planning/todos/pending/calcom-beer-packaging-appointment.md` — Cal.com event type state and wiring steps.
- `.planning/todos/pending/brewpad-ready-to-bottle-filter.md`

### Related handoffs (coordinate, don't duplicate)
- `HANDOFF-canning-copy-and-bundle.md` — can SKUs and counts per batch (25 L beer ≈ 52 × 473 mL / 70 × 355 mL).
- `HANDOFF-kiosk-canning-bundle.md` — kiosk canning bundle (sale-side; not linked to batches).
- `HANDOFF-beer-golive.md` — beer programme state and recipe defects.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `js/brewpad.js`: the v2 dashboard is defined by `DASH_V2_SECTIONS` (~L8287) and the `DASH_V2_WIDGETS`
  registry (~L7957). Each widget is `{key, slot, title, chart, needs, render}` and runs through
  `runDashV2Widget` (~L8011). New sections and widgets go here.
- `buildG8Model` (~L2768) and `renderDashV2Ferment` (~L7828): the Chart.js readings curve with a per-batch
  selector, a table view and an OG/Latest/FG/attenuation/ABV strip. Reuse it for the cider and beer curves.
- `parseDashSnapshot` (~L299) already reads `og` / `target_fg` into `batchMeta`. Today they're always null,
  so D-06 only has to populate them, plus abv/ibu/batch_size_l, which aren't sent yet.
- `dashTaskKind` (~L1432) already tags temperature steps ("Lower to 10ºC", "Crash to 0ºC") as `temp`.
- Classic dashboard `renderDashboard()` (~L8341, which returns early to `renderDashboardV2()`): Ready to
  bottle (~L8730, `_dashSummary.readyToBottle`) and Today's Tasks (~L8777) are the code to reuse.
- Batch list cards `renderBatchList` (~L9346, `.bp-batch-card`) and the filter bar: the integration point
  for the Ready to Bottle filter.
- `KIOSK_CANNING_BUNDLES` (`js/kiosk-core.js` ~L2259) and `zoho-middleware/lib/kiosk-bundles.js` hold the
  can counts. Share the numbers, don't duplicate them.

### Established Patterns
- The server aggregate is `get_dashboard_stats`: `lib/batch-proxy.js:42` → `batch-store.js:161` →
  `batch-pg-read.js:317`, cached about 60 s, Postgres only. It returns batches, taskRows (with
  is_packaging, due_date), readings, vessels and batchMeta.
- `get_tasks_calendar` (`lib/batch-rules.js:630` `buildCalendar`) already takes a date range and includes
  packaging tasks. It's a candidate source for the "not booked yet" entries.
- Cal.com: `lib/calcom.js` (listEventType, getSlots, createBooking, verifyWebhook) and `routes/bookings.js`
  (event-type ids ~L149, service selector ~L319–340). Bookings aren't stored anywhere; the webhook
  (`routes/webhooks.js:534`) only clears the cache.
- Recipe snapshot builders: `js/brewpad.js` ~L4556 and `zoho-middleware/lib/brewpad-integration.js` ~L867.
  Both must copy the new target OG/FG. The `recipes` table is in `migrations/0003_recipes.sql`, with
  beer_category added in 0006.
- The kiosk catalogue uses the shared 1,000-call/day Zoho Inventory quota. This phase should add no
  Zoho Inventory calls.

### Integration Points
- New dashboard sections in `DASH_V2_SECTIONS`, with Today first after the KPI tiles.
- A new middleware route (or proxy action) for upcoming Cal.com bookings, staff-authenticated like other
  BrewPad admin calls.
- Recipe editor fields plus the Postgres recipes column and mirror.

</code_context>

<specifics>
## Specific Ideas

- Production data on 2026-10-27: 2 beer batches (SV-B-000167, SV-B-000229; Czech Lager) and about 6 ciders,
  against 206 wines. Empty states matter more than full ones.
- Example step line: "Next: Lower to 10°C · due Thu 6 Nov".
- Example output line: "≈ 25 L packaged · ≈ 52 × 473 mL or 70 × 355 mL".
- Calendar wording: "not booked yet" for a task with no booking; "no batch matched" for a booking with no batch.

</specifics>

<deferred>
## Deferred Ideas

- Recording actual packaged cans or litres at the packaging step (rejected in favour of estimates, D-09).
- Showing the beer/cider card in the batch detail pane as well as the dashboard. Not discussed; candidate
  for later.
- Renaming the Cal.com slug `canning-appointment` to `beer-packaging`, and renaming the wine "Bottling
  Appointment" customer-side. Owner decisions from the Cal.com todo, not part of this phase.
- The Cal.com duration ladder question (60/90/120/150 meaning) from the Cal.com todo stays open with the owner.

</deferred>

---

*Phase: 97-beer-and-cider-dashboard-sections*
*Context gathered: 2026-11-03*

# Phase 98: Dashboard alerts and quick wins - Context

**Gathered:** 2026-11-05
**Status:** Ready for planning

<domain>
## Phase Boundary

The v2 BrewPad dashboard surfaces what staff need to act on, in one **Needs attention** row:
- overdue tasks and tasks due today (A1)
- batches past their planned schedule (A2)
- ready-to-bottle batches whose invite hasn't been sent (A4)
- people waiting on the waitlist (A5)

Each count taps through to a filtered list.

**A3 (vessel conflict alert) is struck.** Shared vessels are allowed (Phase 96 D-04), and the Vessels widget
already lists shared vessels and active batches with no vessel neutrally.

Out of scope:
- v1 / classic dashboard (frozen, Phase 95 D-03)
- responsiveness, performance and making v2 the default (Phase 99)
- any automatic emailing (F9)
- new write paths

</domain>

<decisions>
## Implementation Decisions

### Which alerts (handoff §7 A1–A5)
- **D-01:** The owner approved **A1, A2, A4 and A5** on 2026-11-05 and **struck A3**. Tick §7 in
  `.planning/research/brewpad-dashboard-v2.md` with this amendment.
- **D-02:** **A4 is a count plus a filter, not a new list.** "Invite not sent (N)" opens the batch list filtered to
  those batches. Ready to bottle rows keep their existing Send Invite button (Phase 97). Sending stays a tap on that
  button behind the existing confirm sheet. **Nothing is emailed automatically** (F9).

### Needs attention row (A1)
- **D-03:** Counts shown, each **only when above zero**:
  1. Overdue tasks
  2. Due today
  3. Past schedule (A2)
  4. Invite not sent (A4)
  5. Waitlist waiting (A5, D-13)
- **D-04:** Placement: a row of **count chips at the top of the Today section**, above Today's tasks. Like
  the rest of Today, it **ignores the global filter bar** (Phase 97 D-15).
- **D-05:** Tapping a count opens a **filtered list**:
  - Task counts open the **Tasks tab** filtered to those tasks.
  - Batch counts (past schedule, invite not sent) open the **Batches list** filtered to exactly those batches.
    They use the Phase 95 click-through with its dismissible banner (D-14 there, `_dashDrill`).
  - The waitlist chip opens the **Waitlist tab** filtered to Waiting.
- **D-06:** Add permanent **"Overdue" and "Due today" filter chips to the Tasks tab**, next to To Do / All /
  Transfers / Packaging. Tapping a count selects the matching chip, and staff can also use the chips directly.
  "Today" is the Vancouver day, as in Phase 97's Today section.
- **D-07:** **Staff and family batches are included** in Needs attention counts. They are real floor work, the
  same as production views and Today. The one exception is invite-not-sent (D-15).
- **D-08:** When every count is zero, show one neutral grey line: **"Nothing needs attention right now."**

### Past schedule / stale batches (A2)
- **D-09:** A batch is **past schedule** when it is active (primary or secondary) and
  `today − start_date > planned length + 14 days`. Production on 2026-11-05 had 6 of 40 such batches. The
  grace counts were: any overrun 12, +7 days 8, +14 days 6, flat 90 days 6.
- **D-10:** Planned length = the **largest `day_offset` in the batch's own `schedule_snapshot`**. It follows the
  schedule the batch actually got, not the category default. Production schedules run 27–56 days.
- **D-11:** Batches with **no schedule are left out** of the stale rule (1 on production). There is no flat
  90-day fallback.
- **D-12:** **Neutral wording:** the chip reads **"Past schedule (N)"** in **amber, not red**. Red stays
  reserved for overdue tasks. In the filtered batch list each row shows **"N days past plan"**. Never use
  "stale" in copy.

### Waitlist (A5)
- **D-13:** The chip shows the **Waiting** count only ("Waitlist waiting (N)"). It opens the Waitlist tab with the
  status filter set to `waiting`. It lives in the Needs attention row and follows D-03's above-zero rule.

### Invite not sent (A4)
- **D-14:** A batch counts when **all three** hold:
  - it is in Ready to bottle (the same `readyToBottleList()` the widget and Batches chip use);
  - it has a customer email;
  - `bottling_invite_sent_at` is empty.

  It leaves the count once an invite is sent. Batches with no email can't be invited and are not counted.
- **D-15:** **Staff and family batches are excluded** from invite-not-sent. They don't need a customer booking
  invite. This is the only Needs attention count that excludes them.

### Claude's Discretion
- Chip order within the row (D-03's order is a sensible default), chip styling, and exact copy for the Tasks-tab
  chips. Copy must stay neutral, as in Phases 96 and 97.
- Whether counts are computed client-side from already-loaded data or added to the Phase 94 dashboard stats.
  This must not add N+1 calls or extra Zoho quota use.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Dashboard v2 source of truth
- `.planning/research/brewpad-dashboard-v2.md`
  - §4 Phase E (A1–A5)
  - §3 F6 and F9 (stale batches, invites never sent)
  - §5 constraints
  - §7 approvals and owner notes (tick A1, A2, A4, A5; A3 struck)

### Prior phase decisions this phase builds on
- `.planning/phases/97-beer-and-cider-dashboard-sections/97-CONTEXT.md`
  - D-13: Needs attention deferred to A1
  - D-14 and D-15: Today section placement; it ignores the filters
  - Ready to bottle and Send Invite
- `.planning/phases/97-beer-and-cider-dashboard-sections/97-UI-SPEC.md` — Today section layout, row builders,
  neutral copy rules
- `.planning/phases/96-new-and-upgraded-dashboard-graphs/96-CONTEXT.md` — D-04 shared vessels allowed (why A3 is
  struck), D-11 sections, neutral wording
- `.planning/phases/95-global-filters-and-chart-engine/95-CONTEXT.md` — D-14 click-through and banner, staff-batch
  rules, v1 frozen
- `.planning/phases/94-dashboard-correctness-and-data-foundations/94-CONTEXT.md` — S1 dashboard stats endpoint
  (no N+1)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `readyToBottleList()` / `readyToBottleRows()` (`js/brewpad.js` ~L9174): the single source for Ready to bottle.
  The widget and the Batches chip already use it. Reuse it for D-14.
- `_dashDrill` click-through (`js/brewpad.js` ~L4158, banner ~L9863): opens the Batches list on an exact id set
  with a dismissible banner. Use it for D-05 batch counts.
- Tasks tab filter chips: `taskFilterOpts` (~L14118) and the `_taskFilter` handler (~L16373). Extend these for D-06.
- Waitlist: `filterWaitlistRows(rows, statusFilter, …)` (~L4071), with statuses waiting, contacted, booked,
  removed and notSynced.
- Classic Needs Attention (~L9007), with `overdueTasks` / `tasksDueToday` from the stats API. It is frozen, so
  don't change it. It is only a reference for the counts.
- Staff flag: `row.staff_batch === true`, or the staff-id map (~L806).
- Send Invite flow: an existing confirm sheet, and it stamps `bottling_invite_sent_at` (~L12406, ~L15945).

### Established Patterns
- ES5 frontend; edit `js/brewpad.js`, then rebuild `js/brewpad.min.js`. Never hand-edit min files.
- Vancouver-day boundaries for "today" (Phase 97 Today helpers `dashV2TodayDate`).
- Neutral copy: no "conflict", "stale" or "unbilled", and red only for overdue.

### Integration Points
- The Today section in `renderDashboardV2()` (~L8648). The Needs attention row goes at its top.
- Tasks tab render (~L14118) gets two new filter values. Waitlist tab load/render (~L14468) needs a preset filter
  entry point.

</code_context>

<specifics>
## Specific Ideas

- Chip labels: "Overdue (N)", "Due today (N)", "Past schedule (N)", "Invite not sent (N)", "Waitlist waiting (N)".
- Filtered batch list row for past-schedule batches: "N days past plan".
- Production snapshot 2026-11-05: 40 active batches, plan length 27–56 days (median 45), 6 past plan + 14 days.

</specifics>

<deferred>
## Deferred Ideas

- **A3 vessel conflict alert:** struck. Revisit only if vessel sharing stops being allowed.
- **Over-capacity alert** (a vessel type fully occupied): it was offered as an A3 replacement and not chosen.
- **Todo housekeeping (not this phase):** `.planning/todos/pending/recipe-og-target-fg-capture.md` appears resolved
  by Phase 97 (D-06, plans 97-01 and 97-05). Close it separately.

### Reviewed Todos (not folded)
- `brewpad-bottled-status-stale-ui.md` (bottled status not reflected until refresh): related to batch views but
  its own bug fix. Not folded.
- The other keyword matches (attribution, kiosk, gift cards, Helcim) are unrelated to this phase.

</deferred>

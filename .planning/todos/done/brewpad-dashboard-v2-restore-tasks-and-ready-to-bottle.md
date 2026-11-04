---
title: BrewPad Dashboard v2 — bring back the Pending Tasks and Ready to Bottle sections on the main page
status: pending
created: 2026-10-29
source: owner note 2026-10-29, after Phase 96 went live on prod (prod-20261029-1) — "i like it but want to return in the pending tasks and ready to bottle sections on the main page in addition to the new stuff"
area: brewpad / dashboard v2
priority: medium
---

## What

The owner likes the new v2 dashboard (Phases 94–96) but misses two sections from the classic
dashboard. Add them back to the v2 main page, **as well as** the new widgets. Don't replace any
of the new widgets.

1. **Pending tasks.** In the classic dashboard this is the "Today's Tasks" section: overdue
   tasks first, marked Overdue, then tasks due today.
2. **Ready to Bottle.** The collapsible list of active batches with an open bottling task that's
   due, showing "Overdue — date" or "Due date".

## Where it is today

- `js/brewpad.js` `renderDashboard()` (~line 8341) returns early to `renderDashboardV2()` when v2
  is on, so none of the classic sections render in v2.
- Classic sections in the same function: "Needs Attention" (~8678), Ready to Bottle collapsible
  (~8730, uses `_dashSummary.readyToBottle`), Today's Tasks (~8777).
- v2 already has a G2 "Ready to bottle" *count/pipeline* widget (~line 1688). That's a chart, not
  the actionable list the owner wants back.

## Open questions for the owner

- Does "pending tasks" mean only Today's Tasks (overdue + due today), or the "Needs Attention"
  block too?
- Placement: above the v2 widgets (actionable items first) or below them?
- Should the global v2 filter bar (date range / type) filter these lists, or should they always
  show everything that's currently due?

## Notes

- Reuse the classic rendering and its tests rather than writing a second implementation.
- Related: `brewpad-ready-to-bottle-filter.md` (a Ready-to-Bottle filter on the batch view).

## Resolution (Phase 97, 2026-11)

Resolved by plan 97-07 (Tasks and Ready to Bottle restored in the Today section of the v2 dashboard).

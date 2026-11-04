---
title: BrewPad — dedicated "Ready to Bottle" filter on the batch view (not just the dashboard section)
status: pending
created: 2026-08-11
source: owner ticket (2026-08-11) — "dedicated ready to bottle section filter on batch view (not just secondary)"
area: brewpad / batch views
priority: medium
---

## What

The batch view's filters are status-based (primary/secondary/…), but "ready to bottle" is a
cross-cutting condition (active batch with an open, due bottling schedule — see the dashboard's
collapsible "Ready to Bottle" list, `js/brewpad.js` ~3210, fed by `d.readyToBottle`). The owner
wants that same condition as a first-class filter on the batch list — filtering to "secondary"
is only a proxy and misses/over-includes.

## Fix shape

- Add a "Ready to Bottle" option to the batch-view filter bar that applies the SAME predicate
  the dashboard summary uses (reuse the server's `readyToBottle` membership or replicate its
  exact rule client-side from `_allBatchesData` — prefer one source of truth; if the rule lives
  only in Apps Script, expose it as a flag on each batch in the list payload).
- Show the count in the filter chip like the dashboard section does ("Ready to Bottle (N)").
- Keep it in sync with the bottled-marking fix (see [[brewpad-bottled-status-stale-ui]]) so a
  batch drops out of the filter the moment it's marked bottled.

## Effort

Small-to-medium frontend change + possibly one Apps Script list-payload field. Natural to bundle
with brewpad-bottled-status-stale-ui in a single BrewPad-UX phase.

## Resolution (Phase 97, 2026-11)

Resolved by plan 97-10 (Ready to Bottle (N) filter label from the shared source).

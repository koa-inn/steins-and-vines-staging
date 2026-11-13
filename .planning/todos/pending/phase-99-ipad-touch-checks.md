---
title: Phase 99 deferred iPad touch checks (dashboard v2)
status: pending
created: 2026-11-13
source: .planning/phases/99-dashboard-responsiveness-and-performance/99-ROLLOUT-LOG.md
area: brewpad dashboard
priority: low
---

## What

The owner deferred the Phase 99 iPad sign-off on 2026-11-13 (BrewPad is mainly used on a laptop). These were
only tested in jsdom / desktop Chrome and still need one pass on the shop iPad (Safari):

1. Tap a chart point: tooltip with "View batches ›", no navigation. Tap the same point again: filtered Batches
   list opens. Tap empty space: tooltip hides. Bar charts also need two taps to drill.
2. Finger-scroll the page with the finger on a chart: the page scrolls (`touch-action: pan-y`).
3. Right after sign-in, open a batch and print its QR code and a label: the print window opens, with no
   popup-blocked message (the print libraries now load on idle; `openBatchQR` loads qrcode before `window.open`
   if the preload has not finished, which Safari may treat as a non-user-initiated popup).
4. The all-batches ferment chart (up to 20 series with markers) is readable.
5. With no `?dash`, the iPad opens the new dashboard; "Classic dashboard" switches back and is remembered.

If any fail, "Classic dashboard" is the fallback for staff until fixed.

## Also seen in the staging pilot (app shell, likely older than Phase 99)

- Bottom tab bar needs 385 px: Waitlist tab partly cut off at 360 px, off-screen at 320 px.
- Header at phone widths: signed-in email overlaps the "BREWPAD" label.
- At 320 px one chart in the fermentation area (`.bp-g6-chart`) is clipped by about 15 px.
- Desktop: KPI tiles are two per row while the grids below are three per row.
- One focusable element in the phone filter block sits about 6800 px down the page in tab order.

---
title: Remove v1 (classic) BrewPad dashboard code
area: brewpad / dashboard
created: 2026-11-06
source: Phase 99 D-04
---

Once v2 has been the default for a while (Phase 99) and the owner says so, remove the v1 dashboard code. That covers `renderDashboard` and the v1-only helpers, the "Classic dashboard" fallback link, and the `bp_dash_v2` flag plumbing.

This is owner-triggered and has no date. Before removing anything, confirm that no staff device still relies on Classic.

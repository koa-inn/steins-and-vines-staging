# Phase 99: Dashboard responsiveness and performance - Context

**Gathered:** 2026-11-06
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase makes the BrewPad v2 dashboard fast, responsive and accessible, then makes it the default (handoff §4 Phase F).

It covers four things:
- **Layout:** a mobile-first grid and touch-friendly charts.
- **Loading:** skeletons, a cached-first render and lazy charts.
- **Accessibility:** table views, non-colour signals, focus states and contrast.
- **Default switch:** removing the `?dash=v2` opt-in so v2 is the default, with a Classic fallback.

Out of scope:
- New widgets, new data or server endpoints beyond what speed needs.
- Removing the v1 code (see D-04).
- Any change to the v1 dashboard beyond the fallback link. v1 is frozen (Phase 95 D-03).

</domain>

<decisions>
## Implementation Decisions

### Switching to v2 as default
- **D-01:** v2 becomes the default dashboard, and a "Classic dashboard" link stays as a fallback. The existing toggle (`js/brewpad.js` ~7279, "Back to classic dashboard") is kept and relabelled as needed. v1 keeps working unchanged.
- **D-02:** Sign-off works as in Phases 96–98. Claude pilots staging UAT, the owner approves on the shop iPad, and the default flip ships in this phase's release. No separate trial period.
- **D-03:** The flip moves every device to v2 **once**, including devices that had stored `bp_dash_v2 = '0'`. After that, a device that clicks Classic is remembered as before. Use a one-time migration marker (for example a new localStorage key or version) so the reset happens only once per device.
- **D-04:** v1 code removal is **not** in this phase. Add a backlog todo, "Remove v1 dashboard code", which the owner triggers when ready. There is no date.

### Speed targets and measuring
- **D-05:** The pass/fail gate is **Lighthouse lab numbers only**: Lighthouse mobile performance ≥ 85 on `brewpad.html` with v2 on. The handoff targets (interactive in under 1.5 s warm, under 3 s cold) are read from the same Lighthouse runs, not timed by hand on the iPad.
- **D-06:** Lighthouse runs against a **local build served with recorded dashboard data**. The run must be repeatable and kept in the repo as a script or check. It does not run against staging, because Cloudflare Access and the staff login get in the way.
  - It needs a way to bypass or mock auth and the admin-proxy responses locally, and that path must never ship enabled in production.
  - It does not measure real Railway latency. That is an accepted limit.
- **D-07:** **Stale-first rendering is allowed.** Show the last dashboard data immediately with a small "as of HH:MM" or "updating…" hint, then swap in fresh data from the background refresh. This includes the Needs attention row.
- **D-08:** Cached data shows first **only if it is from today, Vancouver time** (reuse `dashV2TodayDate()`). Otherwise show skeleton placeholders until fresh data arrives.

### Phone and desktop layout
- **D-09:** The phone (one-column) order is **action first**: Needs attention → Today's tasks → Ready to bottle → KPI tiles → chart sections. The filter bar stays collapsed behind the existing "Filters" button at narrow widths.
- **D-10:** On phones, chart sections are **collapsed by default** to tappable headers. A section's charts are not loaded or rendered until it is opened, which also serves lazy loading. Tablet and desktop stay expanded, and their below-the-fold charts load lazily as they approach the viewport.
- **D-11:** The grid is **1 column on phone, 2 on tablet and 3 on wide desktop (from about 1200 px)**. Wide charts span the full row; these include production over time and the packaging calendar. There is no 4-column layout. The existing `.bp-dash-grid` is 1 column, then 2 from 768 px; extend it.
- **D-12:** No horizontal scroll at 360 px. This comes from the roadmap success criteria and is unchanged.
- **D-13:** Touch tooltips: **tapping a point shows its tooltip, and tapping away hides it.** On touch, the click-through to the filtered batch list moves to a control in the tooltip or a second tap on the same point, so a stray tap never navigates away. Mouse behaviour on desktop is unchanged.

### Accessibility pass
- **D-14:** This is a **targeted pass with an automated check**, not a full WCAG audit. It covers:
  - Every v2 chart has a table view. Audit coverage, including the Phase 97 beer and cider charts and the packaging calendar.
  - Colour is never the only signal.
  - Focus states are visible on every interactive v2 control.
  - Text contrast is at least 4.5:1.
  - An automated axe or Lighthouse accessibility check runs on the v2 dashboard as part of the D-06 local run.
- **D-15:** Non-colour series signals use **distinct point markers** on line charts (circle, triangle, square, and so on, one per type). Stacked bars keep a labelled legend, and their values appear in the tooltip and table. No hatched patterns.

### Claude's Discretion
- **Recorded data:** the D-06 dashboard data fixture is **anonymized** before it is committed. Customer names, emails and phone numbers are replaced; batch ids, dates and counts are kept. Claude recorded this as a privacy default; the owner did not choose it.
- **Loading speed:** Claude chooses the technical levers. Examples: deferring or lazy-loading `js/vendor/jspdf.umd.min.js` (~366 KB) and `qrcode.min.js`, which brewpad.html currently loads synchronously on every visit; script `defer`; splitting the bundle; skeleton design.
- **Hint wording:** the exact copy and placement of the "as of" or "updating…" hint, and of the collapsed-section headers.
- **Cache key:** the cache key, format and storage (sessionStorage vs localStorage) for the cached-first render, as long as D-08 holds.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Dashboard v2 source of truth
- `.planning/research/brewpad-dashboard-v2.md`:
  - §4 "Phase F — Responsiveness and performance" is the spec.
  - §5 lists the constraints. Edit the source files and rebuild, never the minified bundle. No production data writes.
  - §6 gives the milestone acceptance criteria: Lighthouse ≥ 85, no horizontal scroll at 360 px, every chart has click-through and a table view.
- `.planning/ROADMAP.md` "Phase 99" lists the success criteria.

### Prior phase decisions that bind this phase
- `.planning/phases/95-global-filters-and-chart-engine/95-CONTEXT.md`:
  - D-02 and D-03 cover the `?dash=v2` per-device flag and frozen v1.
  - It also covers the Chart.js self-hosted, lazy-loaded decision and its CSP note.
- `.planning/phases/96-new-and-upgraded-dashboard-graphs/96-CONTEXT.md` D-13: the per-widget Chart / Table toggle.
- `.planning/phases/97-beer-and-cider-dashboard-sections/97-CONTEXT.md`: the beer and cider sections and the packaging calendar. Check their table views.
- `.planning/phases/98-dashboard-alerts-and-quick-wins/98-CONTEXT.md` and `98-UI-SPEC.md`: the Needs attention row, its chip contrast and 44 px tap targets.

### Project rules
- `CLAUDE.md`:
  - Never edit `js/*.min.js`.
  - Run `npm run build` after JS changes.
  - Run both test suites and lint before every commit.
  - Every public page has a CSP. brewpad.html has no CSP meta (Phase 95 note), so confirm that before adding any external resource.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `dashV2FlagFrom(search, hash, storedFlag)` (`js/brewpad.js:1420`) and the `bp_dash_v2` localStorage handling (~7240–7284): the D-01/D-03 default flip goes here.
- `dashViewToggleHtml(widget, view)` (`js/brewpad.js:1776`) and `dashSegHtml`: the existing Chart / Table toggle. Reuse it for any chart that lacks one.
- `loadChartJs()` (`js/brewpad.js:3340`) and `chart(canvas, cfg)` (`js/brewpad.js:3366`): Chart.js is already lazy-loaded. Lazy and collapsed sections should call through these, and touch tooltip and point-style options belong in `chart()`'s shared config.
- `renderDashboardV2()` (~`js/brewpad.js:8780`) and `loadDashboard()` (~7161): the render and load entry points for skeletons and the cached-first render.
- `dashV2TodayDate()`: the Vancouver "today" for the D-08 same-day check.
- `js/brewpad.js` already uses sessionStorage snapshots (~4771, the batch detail `saver`), a pattern for the cached-first render.

### Established Patterns
- Pure, exported ES5 helpers with jsdom tests (`tests/frontend/brewpad-dashboard-v2-*.test.js`). The `npm run build` restamp noise must be reverted before commit.
- `.bp-dash-grid` (`css/brewpad.css:3112`, 2 columns at `min-width: 768px` at :3208) is the grid to extend to 3 columns.
- `get_dashboard_stats` goes through the admin-proxy seam with a cache of about 60 s.

### Integration Points
- `brewpad.html` `<head>` loads `qrcode.min.js` and `jspdf.umd.min.js` synchronously (lines 24–25). This is the main cold-load cost after `brewpad.min.js` (~415 KB).
- The D-06 local Lighthouse harness needs a mock for the admin-proxy calls (`adminApiGet` / `adminApiPost`) and the auth gate. Playwright (`tests/e2e/`) is already a dev dependency and can serve and drive the page.

</code_context>

<specifics>
## Specific Ideas

- The phone order mirrors how staff use the iPad: what to act on first, numbers second, charts last.
- The "as of" hint should be small and calm, not a warning.

</specifics>

<deferred>
## Deferred Ideas

- **Remove v1 dashboard code:** a backlog todo, triggered by the owner after the v2 default has settled (D-04).
- **Timed iPad performance check:** real-device timing was considered, and the owner chose Lighthouse lab only. Revisit only if staff report slowness.

</deferred>

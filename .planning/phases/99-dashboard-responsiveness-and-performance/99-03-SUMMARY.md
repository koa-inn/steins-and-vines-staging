---
phase: 99-dashboard-responsiveness-and-performance
plan: 03
subsystem: ui
tags: [brewpad, dashboard, lazy-loading, intersection-observer, collapsible-sections, es5]
requires: ["99-02"]
provides:
  - "qrcode and jsPDF off the head path: idle preload plus on-demand loadScriptOnce fallback"
  - "Phone (<768px) collapsible chart sections with 44px toggles, rendered on first open"
  - "D-09 phone DOM order: Today, KPI tiles, chart sections"
  - "IntersectionObserver lazy chart rendering at >= 768px with render-all fallback"
affects: [99-04, 99-05, 99-06, 99-07, 99-08]
tech-stack:
  added: []
  patterns: ["single lazy gate in runDashV2Widget via dashV2SlotShouldRender; skipped widgets marked dirty and flushed when the gate opens"]
key-files:
  created: [tests/frontend/brewpad-dashboard-v2-lazy-99.test.js]
  modified: [brewpad.html, js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, .planning/phases/99-dashboard-responsiveness-and-performance/99-PERF-LOG.md]
key-decisions:
  - "Today section gets no body wrapper (a locked test asserts head, lead, grid as direct children); it never collapses so none is needed"
  - "Phone toggle is a button inside an h2 so heading navigation survives"
  - "IO callback renders via renderDashV2Defs (not bare rerenderDashV2Widget) so Chart.js is loaded when the first chart slot intersects"
  - "Skeleton goes inside the normal .bp-widget card (real title visible) via dashV2Widget scaffolding"
requirements-completed: [PERF-03, RESP-01]
duration: long
completed: 2026-11-12
---

# Phase 99 Plan 03: Lazy print tools, collapsible phone sections, lazy charts Summary

jsPDF and qrcode no longer block the head, phone chart sections collapse and render on open in action-first DOM order, and tablet/desktop chart slots render as they near the viewport.

## Commits
- 5bebb103 perf(99-03): print tools off the head path (idle preload, on-demand loader)
- cb839714 perf(99-03): collapsible phone sections, lazy section render, action-first phone order (D-09, D-10)
- 1e9fb20a perf(99-03): IntersectionObserver lazy chart rendering at >= 768px (D-10)

## Tests (Node 24)
Frontend 265 suites / 3651 tests green, lint clean. New file has 20 tests. Middleware: 315 suites passed; the one failing suite is the orchestrator's untracked `zoho-middleware/__tests__/batch-proxy-calendar-allowlist.test.js` (not mine, not committed; no middleware file touched).

## Perf measurement
Lighthouse returned NO_FCP in every run, including on phase-start commit c9263b15 in a throwaway worktree, so it is environmental and not caused by this plan. No Lighthouse numbers for this plan. Measured: axe serious+critical 2/2/2 rules (color-contrast 6/9/8 nodes desktop/tablet/phone, label 5 each); phone color-contrast rose from 5 to 8 nodes, probably the new 12px `.bp-dash-section-count` text; expanded phone 5/5 as baseline. scrollWidth 360/360 and 320/320 (no overflow). 0 external requests. Row appended to 99-PERF-LOG.md. Re-measure when Lighthouse paints again.

## Deviations from Plan
1. [Rule 1/locked test] Today section has no `.bp-dash-section-body` wrapper because `brewpad-dashboard-v2-attention.test.js` requires head/lead/grid as its direct children. Today never collapses, so behaviour is unchanged.
2. [Rule 1 - Bug, caught in my own tests] First skeleton placeholder replaced the widget scaffold and broke `dashV2Msg`; fixed by placing the skeleton inside the scaffolded `.bp-widget-body`.
3. Extra test seams beyond the two named: `_resetPrintToolsForTest`, `_openBatchQRForTest`, `_generateBatchLabelPDFForTest`, `_resetDashV2LazyForTest`.
4. `preloadPrintTools()` is called near the top of `showApp()` (after the app is made visible), not the very end; it only schedules idle work.
5. IO intersection renders via `renderDashV2Defs` rather than `rerenderDashV2Widget`, so Chart.js loads when needed.
6. Perf row has no Lighthouse numbers (environmental NO_FCP, above).

## Owner UAT item (RESEARCH A1)
`openBatchQR` with qrcode not yet loaded loads it first, then calls `window.open`; on iPad Safari that may lose the user gesture and the popup could be blocked. It only happens if the idle preload has not finished. Please test QR open on the iPad shortly after sign-in.

## Notes for plans 99-04..99-07
- Lazy gate: `runDashV2Widget` skips widgets via `dashV2DefShouldRender`; skipped keys sit in `_dashV2Dirty`. Anything that renders widgets from cache (99-04) should go through `renderDashV2Defs`/`runDashV2Widget`, not call `def.render` directly.
- Chart.js loads only when a gated-in widget needs it, so cached-first render of Today alone loads no Chart.js.
- Phone mode is `(max-width: 767px)` (separate from the 600px filter query); tests mocking matchMedia need a '767' query to simulate it.
- `_dashV2Seen`/`_dashV2Dirty` reset when the shell is rebuilt.
- Contrast: phone color-contrast nodes rose 5 to 8; the a11y plan should check `.bp-dash-section-count` first.
- brewpad.html has no CSP meta; dynamic same-origin script injection needed no CSP change.
- Fixture `get_tasks_calendar` allow-list gap left alone as instructed.

## Smells noticed (not touched)
- `dashV2Msg` assumes the slot was scaffolded and throws on a bare slot.
- Two separate phone breakpoints (600px filters, 767px sections) in one module.

## Known Stubs
None.

## Self-Check: PASSED
Commits 5bebb103, cb839714, 1e9fb20a exist; test file and 99-PERF-LOG.md row present; no harness seam in js/, css/, brewpad.html.

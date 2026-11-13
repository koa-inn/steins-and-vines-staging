---
phase: 99-dashboard-responsiveness-and-performance
plan: 05
subsystem: ui
tags: [brewpad, dashboard, chart, a11y, touch, es5]
requires: ["99-02", "99-04"]
provides:
  - "Opt-in cfg.markers on chart(): per-type point styles, 6px markers, 22px hit radius"
  - "Legend glyphs matching markers (top-level dashV2LegendHtml with item.marker)"
  - "Touch HTML tooltip (.bp-chart-tip) with View batches action; second tap on the same point drills"
  - "Shared aria-describedby canvas hint"
affects: [99-06, 99-07, 99-08, 99-09]
key-files:
  created: [tests/frontend/brewpad-dashboard-v2-chart-a11y-99.test.js]
  modified: [js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, brewpad.html]
key-decisions:
  - "Canvas hint via aria-describedby (not appended to aria-label) because three locked tests assert aria-label exactly"
  - "Touch detected from evt.native.pointerType OR the last pointerdown type recorded on the canvas (some browsers deliver click without pointerType)"
requirements-completed: [A11Y-01, A11Y-02, D-13, D-15]
completed: 2026-11-13
---

# Phase 99 Plan 05: Line-chart markers and safe touch tooltips Summary

Line charts now carry non-colour point markers (circle/triangle/square/diamond by type) with matching legend glyphs, and on touch a tap shows an HTML tooltip with a "View batches ›" button instead of navigating; desktop mouse behaviour is unchanged.

## Commits
- 5580a1e4 `feat(99-05): point markers and safe touch tooltips on v2 charts (D-13, D-15)` (js/brewpad.js, css/brewpad.css, min artifacts, brewpad.html stamp, new test file)
- c4752a59 `docs(99-05): record perf row`

## Tests (Node 24)
Frontend 268 suites / 3693 tests, middleware 316 / 4394, lint clean. New file: 21 tests. No existing test edited. Tests were written in the same pass as the code (not committed RED first).

## Counts
- `type: 'line'` call sites: 1 (`dashG8ChartConfig`, shared by the Floor-today ferment widget and every Beer & cider batch curve); `markers: true`: 1. Both curve builders go through that one config.

## Deviations from Plan
1. **aria-describedby instead of aria-label suffix** (planned deviation, as the plan said): shared hidden `#bp-chart-desc` "Switch to Table for the full data." (`.bp-visually-hidden` reused).
2. **[Rule 3] Legend builder moved to top level**: `dashV2LegendHtml` was inside the dashboard IIFE; hoisted (unchanged behaviour for plain items) and exported so it can be tested. New exports: `dashV2LegendHtml`, `dashTypeMarker`.
3. **G8 series no longer set pointRadius 3/4**: explicit radius would win over the 6px marker. G8 series now carry `markerStyle` (from the batch type; seltzer = cross so it never matches wine). `expected` series keeps pointRadius 0 (no marker, dashed legend swatch).
4. **chart() now always sets options.onClick** (so charts without cfg.onClick can show a values-only touch tip); mouse path does nothing without cfg.onClick, and the pointer cursor is still only set when cfg.onClick exists.
5. `.bp-chart { overflow:hidden }` from the plan was NOT added: it would clip the tip. Tip is positioned inside `.bp-chart` (already position:relative).
6. Status-text audit (UI-SPEC section 3): reviewed Needs Attention, task flags, pills, deltas; every red/amber/green state already carries a word ("overdue", "due today", "Overdue —", "Part paid"). No gap found, nothing changed.

## Perf row (99-PERF-LOG.md)
`| 2026-11-13 | 5580a1e4 | 99-05 | 0.94 | 0.90 | 2761 | 1520 | 2761 | 0 | 0.071 | 2 / 2 / 2 rules (color-contrast 6/9/7, label 5); expanded phone 5/5 | 360 / 320 | warm perf 1.00, warm CLS 0 ... |`
Warm CLS read 0 this run (0.025 previously); cold CLS 0.071 is known run-to-run noise.

## Notes for plans 99-06..99-09
- Owner should try on the iPad: tap a point on a ferment curve (tooltip shows, no navigation), tap the same point again or "View batches ›" (navigates), tap empty chart / elsewhere / Esc (hides), and confirm vertical page scroll over a chart still works. Also check the legend glyphs match the chart markers, and that markers are not too cluttered on the all-batches ferment chart (up to 20 series).
- Not verified on a real touch device: the touch path relies on Chart.js `click` events; the pointerdown-type fallback is covered in jsdom only.
- Bar and stacked-bar charts get the touch tip too (values, plus the button when cfg.onClick exists); on touch their first tap no longer drills.
- The tip is a `.bp-chart` child; a re-render that replaces the container removes it. `chart()` closes any tip on the same canvas.
- Smell (not touched): classic dashboard still uses inline `style="color:#888"` and emoji-free but unthemed colours (~L9700).

## Known Stubs
None.

## Threat Flags
None. T-99-19/20/21 mitigated (textContent only; escapeHTML on legend colour; second tap or button required).

## Self-Check: PASSED

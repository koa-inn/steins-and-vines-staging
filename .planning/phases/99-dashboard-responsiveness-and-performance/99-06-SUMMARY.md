---
phase: 99-dashboard-responsiveness-and-performance
plan: 06
subsystem: ui
tags: [a11y, axe, contrast, focus, grid, table-view, brewpad]
requires: [99-03, 99-05]
provides:
  - Packaging calendar Calendar/Table view and dashV2PackCalTableModel
  - role=region labelled tables on every v2 widget
  - 3-column grid from 1200px
  - axe serious+critical = 0 at desktop, tablet, phone, phone-expanded
affects: [99-07, 99-08, 99-09]
tech-stack:
  patterns: [registry-driven coverage test, CSS-reading test with a rule splitter]
key-files:
  created:
    - tests/frontend/brewpad-dashboard-v2-a11y-coverage-99.test.js
    - tests/frontend/brewpad-dashboard-v2-css-99.test.js
  modified:
    - js/brewpad.js
    - js/brewpad.min.js
    - css/brewpad.css
    - css/brewpad.min.css
    - brewpad.html
    - .planning/phases/99-dashboard-responsiveness-and-performance/99-PERF-LOG.md
requirements-completed: [A11Y-01, RESP-01, D-11, D-12, D-14]
duration: about 1 h
completed: 2026-11-13
---

# Phase 99 Plan 06: Table coverage, 3-column grid, focus, contrast and axe fixes

The v2 dashboard now has a table view for every chart plus the packaging calendar, a 3-column grid from 1200 px, `--stain` focus rings everywhere, 4.5:1 text, and axe serious+critical is 0 at all four measured widths (Lighthouse a11y 0.90 to 1.00).

## Commits

| Commit | What |
|--------|------|
| 26bd1c67 | test: failing coverage tests (RED) |
| a8e0fcab | feat: t3 Calendar/Table, `dashV2PackCalTableModel`, labelled table regions |
| 543c8a19 | test: failing CSS tests (RED) |
| 87014761 | feat: grid, focus, contrast, axe fixes, Today checkbox names |
| (final) | docs: SUMMARY + PERF-LOG row |

## Axe failures found and fixed

Found with a throwaway Playwright+axe script (scratchpad, not in the repo) on the harness at commit 5580a1e4.

| Rule | Selector | Before | Fix |
|------|----------|--------|-----|
| color-contrast | `.bp-tab-label` x5 (bottom tab bar, every width) | #9a8672 on #faf8f2 = 3.28 | `.bp-tab` colour `--ink-tertiary` to `--ink-secondary` (6.65) |
| color-contrast | `.bp-shell-brand > span` "BrewPad" (desktop, tablet) | 3.28 | `--ink-secondary` |
| color-contrast | `button.bp-batch-chip--overdue` (tablet 3, phone 2) | #4a6f8a on #e5dedc = 4.02 | Real bug: the base `.bp-batch-chip` rule (later in the file) overrode `--overdue`, so the chip never turned red. Selector raised to `.bp-batch-chip.bp-batch-chip--overdue`, so it now uses `--batch-danger` (#a83232) as designed |
| label | `input[type=checkbox][data-task-id]` x5 in Today's tasks (every width) | no accessible name | `aria-label="Mark done: <task title>"` in `dashTodayTaskRowHtml` (escaped) |

The suspected `.bp-dash-section-count` was NOT failing: it already uses `--ink-secondary`. The phone rise from 5 to 8 nodes in 99-03 was the overdue chips, not the count.

Left over: none (0 / 0 / 0 / 0). Not hidden from axe by any means.

## Visible colour changes the owner should know about

- Bottom tab labels (inactive tabs): #9a8672 (light tan) to #6b5442 (darker brown). Active tab stays green.
- "BrewPad" label in the top shell: #9a8672 to #6b5442.
- Overdue batch chips in Today's tasks: were blue (#4a6f8a on tan) because of the CSS override bug; now red (#a83232) on the light red tint, as the overdue styling intended.
- Empty-state text (`.bp-empty`, `.bp-empty-state`, `.bp-recipe-ing-empty`), table row chevrons, list chevrons, "zero" counts in Data health, link-tile chevrons: `--ink-tertiary` to `--ink-secondary` (slightly darker).
- Keyboard focus rings on every dashboard control: 35% faint maroon to solid `--stain` (#370e13). Input focus border likewise.
- Wide screens (>= 1200 px): dashboard is 3 columns with a 24 px gap and the panel cap is lifted to 1440 px (see deviations). At 1280 px each column is about 395 px.

## Deviations from Plan

1. **[Rule 3] Panel width cap.** `.bp-panel-inner` is `max-width: 900px`, which would make 3 columns about 273 px each. Added `#bp-dashboard-inner:has(#bp-dash-v2) { max-width: 1440px; padding: 24px; }` inside the 1200 px media block, so the Batches/Tasks tabs and the v1 dashboard are unchanged. Requires `:has()` (Safari 15.4+, current Chrome). Older browsers keep the 900 px / 3-column layout (narrow but usable). The `.bp-dash-switch-row` above the grid is still 900 px wide (cosmetic misalignment on wide screens).
2. **`.bp-chart` overflow.** Used `min-width: 0; max-width: 100%` instead of `overflow: hidden`, because 99-05's absolutely positioned touch tooltip lives inside `.bp-chart` and would be clipped. Grid children get `min-width: 0`.
3. **RED commits are failing on purpose** (26bd1c67, 543c8a19), per the orchestrator's tests-first instruction; project rule "never commit failing tests" applies to the feat commits, which are green.
4. **Calendar toggle labels** are `Calendar` / `Table` (the calendar is not a chart), default Calendar. Table columns: Date (label plus time for timed bookings), Batch (customer · batch id, drill button), Task (Bottling / Canning), Type (Booking or Task, plus ", not booked yet" / ", no batch matched").
5. **Table region labels** are set in a post-render pass (`dashV2MarkTableRegions`, called from `runDashV2Widget`) rather than in `dashTableHtml`, so the foundations test and the helper signature are untouched.
6. Tokens `--ink-muted` had no v2 text uses, so nothing to change there. The table coverage the plan expected to fail (t3 only) matched: the 9 chart widgets plus bc already had toggles and tables.
7. Tap targets and `:focus-visible` outline-offsets were already compliant; only `touch-action: manipulation` was added (one grouped rule) and pinned by the CSS test.

## Verification (Node 24)

- Frontend `npm test`: 270 suites, 3727 tests green. Middleware `npm test` (run once before the first commit, no middleware file touched): 316 suites, 4394 tests green. `npm run lint` clean.
- 34 new tests: 10 in the coverage file (registry, t3, model, checkbox names) and 24 CSS tests. No existing test edited.
- Harness: see 99-PERF-LOG.md row 99-06: cold perf 0.95, a11y 1.00, TBT 0, cold CLS 0.025, warm perf 1.00, warm CLS 0.025, axe 0/0/0/0, scrollWidth 360/320 exactly, 0 external requests.

## Known Stubs

None.

## Deferred / smells (not fixed, out of scope)

- Two more checkboxes without accessible names, off the dashboard: Tasks tab rows (`js/brewpad.js` near `bp-task-group`) and the batch-detail task list (`renderDetailTasks`). Same one-line fix (`aria-label`).
- `--ink-tertiary` is still used as text colour on non-dashboard selectors (`.bp-section-header`, `.bp-pill--muted`, `.bp-pipeline-label`, several recipe/ingredient labels). Not flagged by axe on the dashboard view, but 3.28:1 on `--cellar-raised`; consider darkening the token itself once the rest of the app is audited.
- `.bp-stat-row` is declared twice (grid at ~L3213, flex at ~L3194 region); the later rule wins, the earlier is dead.
- `.bp-dash-switch-row` stays 900 px wide at >= 1200 px.

## For plans 99-07..99-09

- Coverage test `brewpad-dashboard-v2-a11y-coverage-99.test.js` iterates `bp._dashV2FrameForTest.widgets`; any new chart widget must expose a View-as toggle and table or it fails. bc only draws a canvas after a curve is opened.
- Any new `:focus-visible` rule must use `--stain`, any v2 text colour must avoid `--ink-tertiary`/`--ink-muted` (CSS test enforces both).
- 3 columns need `:has()`; the slot order (full-width flags in `DASH_V2_SECTIONS`) was not reworked, so Today and Floor rows can leave an empty third cell.
- Harness numbers to beat/hold: cold perf 0.95 (0.89-0.95 spread), warm CLS 0.025.

## Self-Check: PASSED

Commits 26bd1c67, a8e0fcab, 543c8a19, 87014761 exist; both new test files, SUMMARY and PERF-LOG row present; `grep -rn "__harness\|bp_perf\|tests/perf" js/ css/ brewpad.html` empty.

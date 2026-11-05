---
phase: 98
slug: dashboard-alerts-and-quick-wins
status: approved
reviewed_at: 2026-11-05
shadcn_initialized: false
preset: none
created: 2026-11-05
---

# Phase 98 — UI Design Contract

> Scope: a **Needs attention** chip row at the top of the Today section, two new Tasks-tab filter chips (`Overdue`, `Due today`), a preset entry point on the Waitlist tab, and a "N days past plan" row note in the drill-filtered Batches list. BrewPad v2 dashboard (`?dash=v2`; brewpad.html, js/brewpad.js ES5, css/brewpad.css). Extends approved `97-UI-SPEC.md` (which extends 96, 95, 94). Anything not restated is inherited unchanged: tokens, spacing, typography, `.bp-widget*`, `.bp-dash-section*`, `.bp-empty`, drill banner (`.bp-drill-banner`), `.bp-filter-btn`, banned words. Edit sources only, never `*.min.*` (run `npm run build`). v1/classic is frozen. Primary device: shop iPad Safari PWA (touch); phone <= 600px.

Sources: D-01..D-15 in 98-CONTEXT.md are locked. Items marked (default) are researcher choices inside "Claude's Discretion".

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (static HTML, vanilla ES5; no components.json) |
| Preset | not applicable |
| Component library | none (hand-rolled `bp-*` classes in css/brewpad.css) |
| Icon library | none (text glyphs only: `›`) |
| Font | `--font-body`, unchanged |

---

## Spacing Scale

Inherited, multiples of 4 only.

| Token | Value | Usage in this phase |
|-------|-------|---------------------|
| xs | 4px | Gap between chip label and count inside a chip |
| sm | 8px | Gap between chips (row and column gap); row to hint spacing |
| md | 16px | Chip horizontal padding; gap between the chip row and Today's widgets |
| lg | 24px | Unchanged section spacing |
| xl-3xl | 32/48/64px | Not used |

Exceptions: chips `min-height: 44px` (touch). Tasks-tab chips inherit the existing `.bp-filter-btn` / `.bp-task-filters` sizing (6px gap, already shipped); they are only raised to a 44px min-height if the existing buttons already are, otherwise left identical to siblings (no new exception).

Focal point: the Needs attention row, directly under the Today heading and hint, above Today's tasks. The overdue chip is first so it is the first thing staff see.

---

## Typography

No new size or weight. Weights 400 and 700 only.

| Role | Size | Weight | Line Height | Phase 98 use |
|------|------|--------|-------------|--------------|
| Body | 14px | 400 | 1.4 | Chip label, empty line |
| Label | 12px | 400 / 700 | 1.4 | `N days past plan` row note |
| Heading | 16px | 700 | 1.2 | `Today` heading (unchanged) |
| Chip count | 14px | 700 | 1.4 | The `(N)` count in a chip, tabular-nums |

Display size is not used. The row has no `.bp-stat-num` (accent is reserved for it elsewhere).

---

## Color

Unchanged from Phase 96/97. Warm light theme; no new tokens.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--cellar-canvas` #e8e2ca | Page background |
| Secondary (30%) | `--cellar-raised` #faf8f2 / `--cellar-surface` #f5f1e6 | Chip fill (neutral chips), list rows |
| Accent (10%) | `--stain` #370e13 | Unchanged reserved list below |
| Destructive | `--batch-danger` #a83232 (bg `--batch-danger-bg`) | Overdue chip only (D-12) |

Accent reserved for (unchanged, nothing added): (1) `.bp-stat-num`; (2) selected segment fill in widget-header controls and filter bar; (3) phone "Filters" badge. Not for Needs attention chips. The selected Tasks-tab chip uses the existing `.bp-filter-btn--active` treatment.

### Chip colour rules (D-12, default mapping)

| Chip | Treatment |
|------|-----------|
| `Overdue (N)` | `--batch-danger-bg` fill, `--batch-danger` text and 1px border. The only red in this phase |
| `Due today (N)` | Neutral: `--cellar-raised` fill, 1px `--ledger-line` border, `--ink-primary` text |
| `Past schedule (N)` | Amber: `--batch-warning-bg` fill, `--batch-warning` text and 1px border (never red) |
| `Invite not sent (N)` | Neutral (same as Due today) |
| `Waitlist waiting (N)` | Neutral (same as Due today) |

Colour is never the only signal: every chip carries its text label. Chip text on tinted fills uses the existing `.bp-status-badge--danger` / `--warning` colour pairs (already in use, so contrast is unchanged); the planner confirms 4.5:1 for 14px text, and if `--batch-warning` on its tint is below that, switches the chip text to `--ink-primary` and keeps the amber border and tint.

The `N days past plan` row note in the Batches list is 12px `--batch-warning` (700 on the number only is not used; whole note 400), paired with the words, never red.

---

## Needs attention row (D-03, D-04, D-08)

Position: first element inside the `Today` section, under the heading and hint, above the `Today's tasks` / `Ready to bottle` widgets. Not a widget: no `.bp-widget` shell, no title, no Chart/Table toggle, no `Show all`. It ignores the global filter bar (Phase 97 D-15); the existing Today hint already says so and is not repeated.

Anatomy:

```
div.bp-attn                        role="group" aria-label="Needs attention"
                                   display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px
  button.bp-attn-chip[.bp-attn-chip--danger|--warn]   one per non-zero count
    span.bp-attn-label             "Overdue"
    span.bp-attn-count             "(3)"  14px/700 tabular-nums
    span.bp-attn-go (aria-hidden)  "›"    only on chips (all are actionable)
  p.bp-attn-empty                  only when all counts are zero
```

Chip: `min-height: 44px`, padding `8px 16px`, `--r-md` radius (pill radius not used, default), `font-size: 14px`, `data-attn` attribute with key: `overdue`, `today`, `past-schedule`, `invite`, `waitlist`. Focus ring 2px `--ledger-focus`, offset 2px. Tap state: `--cellar-surface` darken, no animation.

Rules:

- Each chip renders only when its count > 0 (D-03). Order fixed: Overdue, Due today, Past schedule, Invite not sent, Waitlist waiting.
- The chips wrap to a second line on phone; they never scroll horizontally.
- All five counts zero: render one neutral grey line `Nothing needs attention right now.` (14px body, `--ink-secondary`, no icon, no green tick, no border) in place of the row (D-08).
- Accessible name: `{label}, {N}` plus context, e.g. `Overdue tasks, 3. Opens the Tasks tab.` (`aria-label` on the chip; visible text stays short).
- Counts update in place when data refreshes (task ticked in Today's tasks, invite sent). A tick in Today's tasks re-renders the row so the Overdue/Due today counts decrement immediately. The row has no `aria-live` (avoids chatter); counts are read on focus.
- Loading and failure follow the Today section (same all-or-nothing dashboard load, no spinner of its own). If a count's server input is unavailable: that chip is omitted, and if nothing at all is available show the existing `Not available yet. Reopen the Dashboard tab to refresh.` as an `.bp-empty` line. Never show `0` or a false `Nothing needs attention right now.` when data failed to load (default).
- Computation: client-side from already-loaded data or the Phase 94 stats; no extra calls (Claude's Discretion in CONTEXT). Staff/family batches included in all counts except `Invite not sent` (D-07, D-15).

### Tap-through behaviour (D-05, D-06)

| Chip | Destination | Behaviour |
|------|-------------|-----------|
| `Overdue (N)` | Tasks tab | Switches tab, selects the `Overdue` chip |
| `Due today (N)` | Tasks tab | Switches tab, selects the `Due today` chip |
| `Past schedule (N)` | Batches list | `_dashDrill` exact-id set with the dismissible banner |
| `Invite not sent (N)` | Batches list | `_dashDrill` exact-id set with the dismissible banner |
| `Waitlist waiting (N)` | Waitlist tab | Switches tab, status filter set to Waiting |

The drill banner (inherited anatomy, dismiss `✕` 44px) uses this copy, with N = count at tap time:

| Drill | Banner text |
|-------|-------------|
| Past schedule | `Showing {N} batches past schedule.` (one: `Showing 1 batch past schedule.`) |
| Invite not sent | `Showing {N} ready-to-bottle batches with no invite sent.` (one: `Showing 1 ready-to-bottle batch with no invite sent.`) |

Dismissing the banner clears the exact-id filter and returns the list to the normal view (existing behaviour). Back from the tab returns to the dashboard with scroll position preserved where existing drill does so.

---

## Tasks tab: Overdue and Due today chips (D-06)

- Two new options in the existing `taskFilterOpts` bar, same `.bp-filter-btn` control and `.bp-filter-btn--active` selected state. Order: `To Do`, `Overdue`, `Due today`, `All`, `Transfers`, `Packaging` (default; urgency chips next to the default "To Do" view).
- Labels: `Overdue` and `Due today`. No counts on the Tasks-tab chips (default; keeps the bar consistent with its siblings, which have none). The counts live on the dashboard chips.
- `Overdue` = incomplete tasks with a due date before the Vancouver today. `Due today` = incomplete tasks due on the Vancouver today. Same day boundary as Phase 97 Today (`dashV2TodayDate`), same exclusions as the Needs attention counts, so the tab list count equals the chip count (planner: test that they match, incl. late-evening PT).
- Rows are the existing task rows, grouped as today. The filter does not change the group headers beyond hiding empty groups (existing behaviour).
- Empty results (neutral, `.bp-empty`): `Overdue` → `No overdue tasks.`; `Due today` → `No tasks due today.`
- A tap-through from the dashboard preselects the chip and scrolls the tab to the top. Leaving and re-entering the Tasks tab keeps the last selected chip (existing `_taskFilter` persistence behaviour); not reset.

---

## Waitlist preset (D-13)

- The Waitlist tab opens with its existing status filter set to `Waiting`, using the existing control and label; no new controls. The count in the dashboard chip equals the number of rows shown under that filter (planner: same predicate, `filterWaitlistRows(rows, 'waiting', …)`).
- No banner. The user can change the status filter freely afterwards.
- If the Waitlist tab has no `Waiting` rows (race since the count was taken): the existing empty state for that filter is shown unchanged.

---

## Batches list: past-plan note (D-12)

- In a `Past schedule` drill, each batch row gets one extra line under the existing row content: `{N} days past plan` (one: `1 day past plan`), 12px, `--batch-warning`, `font-variant-numeric: tabular-nums`. N = `today − start_date − planned length` in whole Vancouver days, where planned length is the largest `day_offset` in the batch's own `schedule_snapshot` (D-10). It is the overrun beyond the plan, not beyond the plan plus grace (default; matches the wording "past plan").
- Rows in the `Invite not sent` drill show no extra line (the existing Ready to bottle row content, including the `Send Invite` button, is used unchanged).
- Row sort within the `Past schedule` drill: most days past plan first (default); in the `Invite not sent` drill, the existing Ready to bottle order.
- The note appears only in the drill view, not in the normal Batches list.

---

## Accessibility and touch

- Chips and Tasks-tab filter buttons are real `<button type="button">`; keyboard Enter/Space activates. Focus ring 2px `--ledger-focus`.
- All chips >= 44px tall. Chip row reflows, no horizontal scroll at 320px.
- Chip state is text plus colour; red and amber are never the sole signal.
- Selected Tasks-tab chip exposes `aria-pressed="true"` if existing siblings do; otherwise matches siblings exactly.
- `prefers-reduced-motion`: no transition on chip tap or on count change.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | None new. Chips are navigation, not actions. `Send Invite` is the existing Phase 97 button and its confirm sheet, unchanged. Nothing is emailed automatically (F9) |
| Chip labels | `Overdue (N)`, `Due today (N)`, `Past schedule (N)`, `Invite not sent (N)`, `Waitlist waiting (N)` |
| Row group accessible name | `Needs attention` (not visible as a heading) |
| Empty state (heading) | `Nothing needs attention right now.` |
| Empty state (body) | None. No next step is needed |
| Tasks-tab chips | `Overdue`, `Due today` |
| Tasks-tab empty | `No overdue tasks.` / `No tasks due today.` |
| Drill banners | `Showing {N} batches past schedule.` / `Showing {N} ready-to-bottle batches with no invite sent.` (singular forms in the Needs attention section) |
| Row note | `{N} days past plan` / `1 day past plan` |
| Error state | `Not available yet. Reopen the Dashboard tab to refresh.` (inherited; shown only when counts can't be determined) |
| Destructive confirmation | None. No new destructive or write actions. The invite send keeps its existing confirm sheet |
| Banned words (inherited, extended) | "stale" anywhere in copy, "conflict", "unbilled", "missing", "late" as a chip label; red only for `Overdue (N)`. Guard test over all new copy |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable (no shadcn) |
| third-party | none | not applicable |
| npm vendor file | none | No new libraries, plugins, or CSP domains. No change to CSP |

---

## Implementation Notes for Planner

- Mount the row at the top of the Today section in `renderDashboardV2()` (~L8648); it is not a `runDashV2Widget` widget. Declare it as filter-independent (uses the unfiltered dataset like the rest of Today).
- New CSS: `.bp-attn`, `.bp-attn-chip`, `.bp-attn-chip--danger`, `.bp-attn-chip--warn`, `.bp-attn-empty`, `.bp-attn-count`, `.bp-past-plan` (row note) in css/brewpad.css; reuse existing tokens (`--batch-danger*`, `--batch-warning*`, `--cellar-*`, `--ledger-*`). No hex literals; no new variables.
- One predicate per count, shared with its destination list: Overdue/Due today for chip and Tasks-tab filter; `readyToBottleList()` + email + `bottling_invite_sent_at` empty + not staff for invite; waitlist `filterWaitlistRows(..., 'waiting')`.
- Extend `taskFilterOpts` (~L14118) and the `_taskFilter` handler (~L16373) with `overdue` and `duetoday` values. Add a preset entry point for the Waitlist tab (~L14468).
- Classic Needs Attention (~L9007) is frozen; do not touch it or its tests.
- Tests (jsdom): chip order and zero-hiding; all-zero line exact copy; failed-data case does not show the all-clear line; amber vs red class per chip; tap-through for each chip (tab switch, preselected filter, drill banner); counts equal destination list lengths; staff/family inclusion and invite-not-sent exclusion; Vancouver-day boundary (late evening PT); Past schedule rule (largest `day_offset`, +14 grace, no-schedule excluded) and `N days past plan` wording incl. singular; chip updates after a task tick and after an invite send; banned-word guard (no "stale"); 44px min-height rule present in CSS.
- Open (non-blocking): confirm the amber text contrast on the chip tint; confirm on the iPad that five chips wrap sensibly in portrait.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: FLAG (legacy 6px gap on .bp-task-filters kept; non-blocking)
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-11-05 (gsd-ui-checker; 5 PASS, 1 FLAG). Planner: add a contrast check for --batch-warning text on --batch-warning-bg, and test the 14-day grace vs the "N days past plan" note.

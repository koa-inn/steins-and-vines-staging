---
phase: 99
slug: dashboard-responsiveness-and-performance
status: approved
reviewed_at: 2026-11-06
shadcn_initialized: false
preset: none
created: 2026-11-06
---

# Phase 99 — UI Design Contract

> Scope: responsive grid, collapsible phone sections, cached-first loading and skeletons, touch tooltips, accessibility pass (table views, non-colour markers, focus ring, contrast) and the v2-as-default switch with a Classic fallback. BrewPad v2 dashboard (brewpad.html, js/brewpad.js ES5, css/brewpad.css). Extends approved 98-UI-SPEC.md (which extends 97, 96, 95, 94). Anything not restated is inherited unchanged: tokens, spacing, typography, `.bp-widget*`, `.bp-dash-section*`, `.bp-seg`, `.bp-table*`, `.bp-empty`, `.bp-skeleton-block`, `.bp-drill-banner`, banned words. Edit sources only, never `*.min.*` (run `npm run build`). v1/classic is frozen except the fallback link. No new widgets or data.

Sources: D-01..D-15 in 99-CONTEXT.md are locked. Items marked (default) are researcher choices inside "Claude's Discretion".

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (static HTML, vanilla ES5; no components.json) |
| Preset | not applicable |
| Component library | none (hand-rolled `bp-*` classes in css/brewpad.css) |
| Icon library | none (text glyphs only: `›  ▲ ▼ ✕ ▸ ▾`) |
| Chart library | Chart.js 4, self-hosted, lazy-loaded (unchanged) |
| Font | `--font-body`, unchanged |

No new colour tokens. No new libraries, CSP domains or external resources.

---

## Spacing Scale

Inherited, multiples of 4 only.

| Token | Value | Usage in this phase |
|-------|-------|---------------------|
| xs | 4px | Gap between section chevron and title; marker/legend gap |
| sm | 8px | Skeleton line gap; "as of" hint to heading gap |
| md | 16px | Grid gap at every breakpoint; page side padding on phone and tablet; collapsed section header padding |
| lg | 24px | Gap between dashboard sections; grid gap and page side padding at >= 1200px |
| xl-3xl | 32/48/64px | Not used |

Exceptions: all touch targets `min-height: 44px`. Chart heights inherit Phase 95/96 (240px tablet and wide, 200px phone). Table cell padding `8px 12px` (inherited 12px exception).

### Breakpoints and grid (D-11, D-12)

`.bp-dash-grid` is extended, not replaced. Min-width, mobile-first:

| Range | Columns | Grid gap | Page side padding | Notes |
|-------|---------|----------|-------------------|-------|
| 0–767px (phone) | 1 | 16px | 16px | Sections collapsed (below). Filter bar collapsed behind `Filters` (inherited, <= 600px) |
| 768–1199px (tablet; iPad portrait and landscape) | 2 (`repeat(2, minmax(0, 1fr))`, existing at css:3208) | 16px | 16px | Sections expanded |
| >= 1200px (wide desktop) | 3 (`repeat(3, minmax(0, 1fr))`) | 24px | 24px | Sections expanded. No 4-column layout |

- Wide widgets span the full row at every width: `grid-column: 1 / -1`. Wide list (default): production over time (G1), packaging calendar (Phase 97), Products block. All other widgets take one cell.
- Every grid child has `min-width: 0` and charts sit in `.bp-chart` with `overflow: hidden`, so a canvas or table never forces horizontal page scroll. Tables scroll inside their own `.bp-table-wrap` only.
- The KPI tile row keeps its existing rule (`.bp-stat-row` 5 columns from 768px). Below 768px, tiles form 2 columns with the wide cycle-time tile spanning both (default; matches current phone behaviour, verify no overflow at 360px).
- Acceptance: at a 360px viewport `document.documentElement.scrollWidth <= 360`. Also check 320px with no horizontal scroll (default stricter check, matches Phase 98).
- Focal point: on phone the Needs attention row (first screen); on tablet and wide the KPI tile row stays primary, as in Phase 95.

---

## Typography

No new size or weight. Weights 400 and 700 only.

| Role | Size | Weight | Line Height | Phase 99 use |
|------|------|--------|-------------|--------------|
| Body | 14px | 400 | 1.4 | Table cells, collapsed section summary, skeleton-error text |
| Label | 12px | 400 / 700 | 1.4 | "As of" hint, tooltip text, axis ticks, legend |
| Heading | 16px | 700 | 1.2 | Collapsed section header title (same as the open section heading) |
| Display | 1.7rem (~27px) | 700 | 1.1 | `.bp-stat-num` unchanged |

Form controls stay 16px (iOS zoom). Chart ticks never below 12px.

---

## Color

Unchanged from Phase 98. Warm light theme.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--cellar-canvas` #e8e2ca | Page background |
| Secondary (30%) | `--cellar-raised` #faf8f2 / `--cellar-surface` #f5f1e6 | Widgets, section headers, skeleton blocks |
| Accent (10%) | `--stain` #370e13 | Unchanged list below, plus focus ring |
| Destructive | `--batch-danger` #a83232 | Not used by this phase (no destructive actions) |

Accent reserved for: (1) `.bp-stat-num`; (2) selected segment fill in widget-header controls and filter bar (includes the Chart/Table toggle); (3) phone `Filters` badge; (4) **new: the keyboard/touch focus outline colour** (below). Nothing else: not skeleton blocks, not section chevrons, not the "as of" hint.

### Contrast (D-14)

- All text >= 4.5:1 against its actual background; the automated axe/Lighthouse check is the gate. Known candidates to verify and fix by darkening, never by shrinking: `--ink-tertiary` #9a8672 (about 3:1 on #faf8f2) and `--ink-muted` used for any 12px/14px text on `.bp-dash-*` surfaces, `--batch-warning` on its tint (carried from Phase 98). Fix = switch the failing text to `--ink-secondary`; chart series (graphics, 3:1) are not text and are not changed.
- Chart series colours stay (>= 3:1 for graphics). `--chart-other` (`--ink-tertiary`, about 3:1) stays acceptable as a graphic only; any text label of that series uses `--ink-secondary`.
- Skeleton blocks are decorative (`aria-hidden`), exempt from contrast.

---

## Focus, touch and motion (D-14)

- **Focus ring (all v2 interactive controls):** `:focus-visible { outline: 2px solid var(--stain); outline-offset: 2px; }`. This replaces the current faint `--ledger-focus` (rgba 0.35 on cream, below 3:1) on v2 controls only: `.bp-seg-btn`, `.bp-attn-chip`, `.bp-stat-card--link`, `.bp-link-btn`, `.bp-filter-btn`, section header buttons, legend buttons, tooltip action button, table rows that are clickable, selects, date inputs, drill banner dismiss. Ring never clipped: containers with `overflow: hidden` use `outline-offset: -2px` (inset) on their focusable children. Do not use `outline: none` anywhere in v2 without this replacement.
- **Tap targets:** 44px minimum height and width for every interactive v2 control, including legend buttons, section headers, the table-view toggle segments and the tooltip action button. Spacing between adjacent targets >= 8px.
- **Touch:** v2 containers set `touch-action: manipulation` on controls (removes the 300ms delay). Charts keep `touch-action: pan-y` so vertical page scroll is never trapped by a canvas.
- **Motion:** skeleton shimmer, section expand/collapse and any chart animation are disabled under `prefers-reduced-motion` (existing `.bp-skeleton-block` rule at css:386 already does this for the shimmer). Section expand has no height animation (default; instant show/hide is the least jank on iPad).

---

## Surfaces

### 1. Phone order and collapsible sections (D-09, D-10)

Order at < 768px, top to bottom: Needs attention row → Today's tasks → Ready to bottle → KPI tiles → chart sections (in their existing order). On >= 768px the existing Today / KPI / chart ordering is unchanged. The order is a CSS/DOM concern at phone width only (default: use `order` on the section containers so the DOM, and tab/reading order, stays one sequence on tablet and wide; on phone the visual order equals DOM order because the DOM is rebuilt in this order at that width).

Section header (existing `.bp-dash-section` heading becomes a button at < 768px only):

```
button.bp-dash-section-toggle   type="button"  aria-expanded="false|true"  aria-controls="{sectionBodyId}"
                                min-height:44px; width:100%; padding:8px 16px; text-align:left
  span.bp-dash-section-chevron  "▸" collapsed / "▾" expanded (aria-hidden), 4px gap
  span.bp-dash-section-title    Heading role (16px/700)
  span.bp-dash-section-count    optional 12px --ink-secondary, e.g. "4 charts" (default: shown only when collapsed)
div#{sectionBodyId}             hidden when collapsed
```

- Collapsed by default on phone for chart sections only (not Today, not KPI tiles). Today and KPI tiles are always open on phone.
- Background `--cellar-raised`, border 1px `--ledger-line`, radius `--r-lg`, 16px gap between collapsed headers.
- Opening a section loads Chart.js if needed (`loadChartJs()`), then renders its charts once; closing keeps the rendered charts (no destroy) so reopening is instant (default). Each open section's charts render with the loading state below until ready.
- Open/closed state is in memory per page load; it resets to collapsed on reload (default; no persistence needed).
- Keyboard: Enter/Space toggle; focus stays on the header; no auto-scroll on open. On open, `aria-expanded="true"` and the body is revealed in DOM order right after the header.
- At >= 768px the header is a plain heading (no button, no chevron) and bodies are always shown. If the viewport grows past 768px (rotation), every section is shown expanded; shrinking returns each to its previous phone state.
- Tablet and wide: below-the-fold charts load lazily as they near the viewport (IntersectionObserver with `rootMargin: 200px`; fall back to rendering all immediately where it is unavailable). Until a chart renders, its slot shows the chart skeleton below at the final height to avoid layout shift.

### 2. "View as table" (D-14; reuses the Phase 96 control)

Every v2 chart widget has the existing Chart / Table toggle (`dashViewToggleHtml`, `.bp-seg`, `role="radiogroup" aria-label="View as"`, buttons `Chart` and `Table`). This phase does not redesign it. It audits and closes coverage gaps, including the Phase 97 beer and cider charts and the packaging calendar.

- Placement, labels, styling, accent fill, keyboard (arrow keys move, Space/Enter select) and table anatomy (`.bp-table-wrap`, sticky header, hidden `<caption>`, numeric columns right-aligned) are exactly as in 96-UI-SPEC. Do not invent a second toggle style.
- Any chart that lacks a toggle gets one in the widget header controls row, labels `Chart` / `Table`, default `Chart`. The packaging calendar's Table view is a plain list/table with columns `Date` | `Batch` | `Task` | `Type` (default; one row per scheduled item, same set and order as the calendar, `Type` spelled out as words).
- On phone the controls row drops under the title (inherited); toggle segments stay 44px high and the control never exceeds the card width.
- Switching to Table moves no focus; the toggle keeps focus. The Table region is `role="region"` with `aria-label="{widget title} table"` and `tabindex="0"` when it scrolls, so it is keyboard-scrollable.
- Table view needs no Chart.js: it must render when Chart.js failed to load, and on phone it is available inside an opened section without loading Chart.js (default: if the widget view is Table, skip `loadChartJs()` for that widget).
- Each canvas keeps `role="img"` and its `aria-label` summary (Phase 95); add the sentence `Switch to Table for the full data.` to the end of every summary (default).
- Automated coverage test: iterate the v2 widget registry and assert each has a toggle and a table renderer.

### 3. Non-colour signals (D-15)

- **Line charts:** each series gets a distinct point style, fixed per series type (not per position), 6px radius (hit radius 22px for touch): Wine = `circle`, Cider = `triangle`, Beer = `rect`, Other = `rectRot`. Categorical series (`--chart-cat-1..6`) use, in order: `circle`, `triangle`, `rect`, `rectRot`, `cross`, `star`. Lines 2px; markers shown on every data point (not only on hover) when a series has <= 24 points, else markers only at tooltip focus. Marker fill = series colour, 1px `--cellar-raised` border.
- **Legend:** the HTML legend swatch mirrors the marker (a 12px glyph of the same shape in the series colour) next to the name, so legend and chart agree. Bar and stacked-bar legends keep the 12x12 square swatch with the label; no hatched patterns.
- **Stacked bars:** keep the 2px `--cellar-raised` separator, the named legend, tooltip values and the Table view as the non-colour path.
- **Deltas and chips:** unchanged (glyph, sign and words already carry meaning). `Overdue (N)` and amber chips keep their text labels.
- **Status text:** any state shown with red/amber/green anywhere in v2 also carries a word or glyph (audit item, executor fixes any gap found).

### 4. Touch tooltips and click-through (D-13)

- **Touch (pointer type touch):** tapping a point or bar shows its tooltip and does not navigate. Tapping elsewhere (outside the chart, or on empty chart area) hides it. Tooltip `mode: 'index'`, `intersect: false` (inherited) so a finger anywhere in a column works.
- **Navigation on touch:** the tooltip includes an action row `View batches ›` as a real `<button>` styled as a tooltip link (min 44px tall, 12px/700, `--cellar-raised` text underlined) which performs the existing click-through to the filtered Batches list. A second tap on the same point also navigates (default: so staff can double-tap through; the first tap shows the tooltip, the second on the same point within the open tooltip drills).
- The tooltip is an external/HTML tooltip on touch so the button is focusable and tappable (Chart.js canvas tooltips cannot take pointer events). Desktop mouse keeps the canvas tooltip and single-click drill, unchanged.
- Tooltip never extends past the viewport (clamp to 8px from edges). Keyboard users get the data via the Table view; the canvas itself is not a focus stop (`role="img"`), so there is no keyboard-only gap.
- Esc hides a visible tooltip.

### 5. Loading, skeletons and cached-first render (D-07, D-08)

State machine for the dashboard:

| State | Presentation |
|-------|--------------|
| First load, no usable cache | Skeletons for the Needs attention row, Today widgets, KPI tiles and each chart slot. No spinner. `aria-busy="true"` on the dashboard container |
| Cached data from today (Vancouver), refresh in flight | Render cached data immediately (including Needs attention) with the hint `As of {h:mm AM/PM} · Updating…` |
| Refresh succeeded | Swap in fresh data in place (no scroll jump, no layout shift); hint becomes `Updated {h:mm AM/PM}` and stays, 12px `--ink-secondary` |
| Cache not from today | Treated as no cache: skeletons only |
| Refresh failed, cache from today shown | Keep cached data; hint `As of {time} · Couldn't refresh. Reopen the Dashboard tab to try again.` Never red, never an alert box |
| Refresh failed, nothing cached | Existing Phase 94 error: `Failed to load dashboard: {message}. Reopen the Dashboard tab to try again.` |

- **Hint:** a single 12px `--ink-secondary` line placed top right of the dashboard header row, level with the `Classic dashboard` link on tablet and wide; on phone it sits on its own line directly under the Needs attention row heading area, left-aligned, 8px above the first row (default). It uses `role="status"` with `aria-live="polite"` but announces only on the transitions `Updating…` → `Updated` and on failure, not on every re-render. Small and calm: no icon, no colour change, no animation (the `…` is static text).
- **No banned wording:** the word "stale" never appears in UI copy (inherited).
- **Skeleton design (default):** reuse `.bp-skeleton-block` (css:378) as grey rounded blocks in `--cellar-surface`. Shapes match the final layout to prevent layout shift: Needs attention = 3 chip-shaped blocks 44px high, 96px wide, 8px gap; KPI tile = tile-sized block with one 27px-high number block and one 12px line; chart slot = block at the final chart height (240px tablet/wide, 200px phone) inside the normal `.bp-widget` card with its real title already shown; Today list = 3 rows 44px high. Skeleton blocks are `aria-hidden="true"`. Cumulative layout shift target: 0 on the swap (Lighthouse CLS < 0.1).
- **Chart.js not yet ready:** the chart slot keeps its skeleton (replaces the Phase 95 `Loading charts…` text where the skeleton is visible; the text remains the accessible fallback via a visually hidden `Loading chart…` label, default). Chart.js load failure copy unchanged: `Charts could not load. Reload the page to try again.`
- **Heavy scripts:** `qrcode.min.js` and `jspdf.umd.min.js` are removed from the blocking `<head>` path (lazy-load or `defer` at first use). No visible UI change; any button that needs them shows its existing behaviour after a brief load. If a lazy script fails to load, show the toast `Could not load the PDF tools. Check your connection and try again.` (default, only where those tools are triggered).

### 6. v2 as default and Classic fallback (D-01, D-02, D-03)

- v2 is the default. `?dash=v2` is no longer required and the flag is no longer advertised in the UI.
- **Toggle labels:** in v2 the existing top-right link button reads `Classic dashboard` (was `Back to classic dashboard`). In classic it reads `Try new dashboard` (unchanged). Both are `.bp-link-btn`, 44px, `--ink-secondary`, same position as Phase 95.
- **One-time migration (D-03):** a one-time marker (e.g. localStorage `bp_dash_default_v2 = '1'`, name is the executor's choice) forces v2 once per device, including devices with stored `bp_dash_v2 = '0'`. After the marker exists, a device that chooses Classic is remembered as before. No banner, dialog or toast announces the switch (default: the page just opens in v2). The shop iPad sees the new default on next open.
- Explicit URL `?dash=classic` or `#dash=classic` (default) opens Classic for that visit and records the device preference; `?dash=v2` still works and sets the preference to v2.
- No "what's new" message. The Classic link is the only discoverable path back.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | None new. This phase adds no actions. Controls reused: `Chart` / `Table` toggle, `Filters`, `Classic dashboard`, `Try new dashboard` |
| Classic link (in v2) | `Classic dashboard` |
| New-dashboard link (in classic) | `Try new dashboard` |
| Collapsed section header | `{Section title}` plus optional count `{N} charts` (one: `1 chart`); chevron `▸` / `▾`, `aria-expanded` conveys state |
| Section toggle accessible name | `{Section title}, {N} charts. Expand` / `Collapse` via `aria-expanded` (no extra visible text) |
| Cached + refreshing hint | `As of {h:mm AM/PM} · Updating…` |
| Fresh hint | `Updated {h:mm AM/PM}` |
| Refresh failed hint | `As of {h:mm AM/PM} · Couldn't refresh. Reopen the Dashboard tab to try again.` |
| Touch tooltip action | `View batches ›` |
| Canvas aria-label suffix | `Switch to Table for the full data.` |
| Table region aria-label | `{Widget title} table` |
| Chart skeleton accessible label | `Loading chart…` (visually hidden) |
| Empty state heading | Inherited: `No batches match these filters.` (charts); `Nothing needs attention right now.` (Needs attention). Body/next step: `Reset filters` link (inherited) |
| Error state | Inherited: `Failed to load dashboard: {message}. Reopen the Dashboard tab to try again.` and `Charts could not load. Reload the page to try again.` |
| Lazy script failure | `Could not load the PDF tools. Check your connection and try again.` |
| Destructive confirmation | None. No destructive or write actions in this phase. Switching between Classic and v2 is reversible and needs no confirmation |
| Banned words (inherited) | "stale", "conflict", "unbilled", "missing", "late" as a label. Guard test over all new copy |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable (no shadcn) |
| third-party | none | not applicable |
| npm vendor file | none new | No new libraries or CSP domains. brewpad.html has no CSP meta (confirmed Phase 95); the planner re-confirms before touching any `<script>` tag. Lighthouse/axe tooling is a dev dependency only and never shipped. The local-harness auth/proxy mock must not be enabled in production builds (D-06) |

---

## Implementation Notes for Planner

- Grid: extend css:3112 and css:3208; add a `@media (min-width: 1200px)` rule for 3 columns, `grid-column: 1 / -1` for wide widgets; keep `min-width: 0` on children.
- Phone section collapse: wrap chart-section bodies in `renderDashboardV2()` (~L8780); render charts only on first open (D-10). Reuse `loadChartJs()` (L3340) and `chart()` (L3366); put point-style and touch-tooltip options in `chart()`'s shared config.
- Cached-first: use `dashV2TodayDate()` for the D-08 same-day check; cache key/storage is Claude's Discretion (sessionStorage mirrors the existing snapshot pattern, but localStorage survives iPad PWA restarts, so recommend localStorage with the date in the stored value). Do not cache anything containing more than the aggregate the page already shows, and clear it on sign-out.
- Default flip: edit `dashV2FlagFrom` (L1420) and the `bp_dash_v2` handling (~L7240–7284); relabel L7279.
- Local Lighthouse harness (D-06): a repeatable script; anonymized fixture; mock `adminApiGet`/`adminApiPost` and the auth gate behind a flag that cannot be on in a production build. Record the runs for the axe check too (D-14).
- Tests (jsdom, `tests/frontend/brewpad-dashboard-v2-*.test.js`): flag default and one-time migration (`'0'` stored then marker set; second visit respects Classic); cache shown only when from today Vancouver (late-evening PT boundary); hint copy per state and no "stale"; point-style mapping per series; every widget has a toggle and a table renderer; touch tooltip show/hide and no navigation on first tap; section `aria-expanded` toggling and lazy render once; 44px min-height and `:focus-visible` rule present in CSS for each listed control; no horizontal overflow rule (`scrollWidth`) at 360px via the iframe harness; banned-word guard.
- Verification on device: iPad Safari for focus ring visibility with a keyboard, tooltip tap behaviour, section collapse in portrait; the phone-width iframe harness for 360/390px.
- Open (non-blocking): confirm which `--ink-*` text pairs actually fail 4.5:1 once axe runs; confirm the exact wide-widget list against the final widget registry; confirm 3-column layout at 1200px does not make G8/G3 curves too narrow (fall back to span 2 if a chart is under about 320px wide).

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

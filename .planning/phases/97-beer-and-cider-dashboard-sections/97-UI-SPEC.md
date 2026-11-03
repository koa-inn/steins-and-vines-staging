---
phase: 97
slug: beer-and-cider-dashboard-sections
status: draft
shadcn_initialized: false
preset: none
created: 2026-11-03
---

# Phase 97 — UI Design Contract

> Scope: a new **Today** section, a new **Beer & cider** section (batch cards), and a Ready to Bottle filter on the Batches tab. BrewPad v2 dashboard (`?dash=v2`; brewpad.html, js/brewpad.js ES5, css/brewpad.css). Extends the approved `96-UI-SPEC.md` (which extends 95 and 94). Anything not restated here is inherited unchanged: tokens, spacing, typography, widget shell (`.bp-widget`, `.bp-widget-head`, `.bp-seg`, `.bp-select`, `.bp-empty`), `.bp-dash-section*`, `.bp-dash-grid`, drill banner, list row anatomy, `Show all {N}` rule, banned words. Edit sources only, never `*.min.*` (run `npm run build`). v1 is frozen. Primary device: shop iPad Safari PWA (touch); phone <= 600px.

Sources: D-01..D-16 in 97-CONTEXT.md are locked. Items marked (default) are researcher choices inside "Claude's Discretion". This phase **amends Phase 96 D-11/D-12 section order** (D-14).

---

## Design System

| Property | Value |
|----------|-------|
| Tool | none (static HTML, vanilla ES5; no React, no components.json) |
| Preset | not applicable |
| Component library | none (hand-rolled `bp-*` classes in css/brewpad.css) |
| Icon library | none (text glyphs only: `▲ ▼ ✕ › ✓ ▾`) |
| Chart library | Chart.js 4.5.1 via `chart()` only; no new plugins, no new CSP domain. Cider/beer curve reuses the G8 renderer (`buildG8Model`, `renderDashV2Ferment`) |
| Font | `--font-body`, unchanged |

---

## Spacing Scale

Inherited, multiples of 4 only.

| Token | Value | Usage in this phase |
|-------|-------|---------------------|
| xs | 4px | Gap between glyph and text; gap between chips on a card |
| sm | 8px | Card inner row gap; calendar entry vertical gap; note spacing |
| md | 16px | Card padding; gap between cards; gap between Today widgets |
| lg | 24px | Gap between sections; space above a section heading |
| xl-3xl | 32/48/64px | Not used |

Exceptions: touch targets `min-height: 44px` (task checkbox label, batch chip row, calendar entries that open a batch, `Show all`, card header button). Calendar day group headers are not interactive and are 12px type with 8px padding.

---

## Typography

No new size or weight. Weights 400 and 700 only.

| Role | Size | Weight | Line Height | Phase 97 use |
|------|------|--------|-------------|--------------|
| Body | 14px | 400 | 1.4 | Card lines, task titles, calendar entry text |
| Label | 12px | 400 (700 for day group headers and card line labels) | 1.4 | Notes, chips, "not booked yet", "no batch matched", filter note |
| Heading | 16px | 700 | 1.2 | Section headings (`Today`, `Beer & cider`) |
| Widget title | 14px | 700 | 1.2 | Widget titles; batch card title (batch id + product) |
| Display | 1.7rem | 700 | 1.1 | `.bp-stat-num` only (unchanged; not used on cards) |

Numbers on cards and in the calendar use `font-variant-numeric: tabular-nums`.

---

## Color

Unchanged from Phase 96. Warm light theme.

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--cellar-canvas` #e8e2ca | Page background |
| Secondary (30%) | `--cellar-raised` #faf8f2 / `--cellar-surface` #f5f1e6 | Cards, widget bodies, calendar day headers, list rows |
| Accent (10%) | `--stain` #370e13 | Reserved list below |
| Destructive | `--batch-danger` #a83232 | Only the existing classic Overdue treatment in Today's tasks (below). Nowhere else in this phase |

Accent reserved for (unchanged, nothing added): (1) `.bp-stat-num`; (2) selected segment fill in widget-header controls and filter bar; (3) phone "Filters" badge. Not for card titles, temperature highlights, calendar entries or counts.

New tokens: **none**. Reused:

- Type tag on a card: 4px left border in `--chart-beer` / `--chart-cider` (the only use of type colour on the card; type name is also written as text).
- **Temperature step highlight** (default): the "Next:" line gets a `--cellar-surface` pill background with 1px `--ledger-line` border and a text prefix `Temp step` (12px/700, `--ink-primary`), so it is never colour-only and uses no hue. Non-temperature next steps have no pill.
- Calendar kind tags are neutral text chips (`.bp-badge` neutral: `--ledger-soft` bg, `--ink-secondary` text): `Bottling` or `Canning`. No hue per kind.
- "not booked yet" is a 12px `--ink-secondary` italic-free text with a dashed 1px `--ledger-line` left border on the entry (dashed = unconfirmed). "no batch matched" is 12px `--ink-secondary` text, no border change. Neither is red or amber.
- Today's tasks keep the **classic** Overdue (`.bp-task-row--overdue`) and due-today (`.bp-task-row--today`) row styling and `Overdue` marker, because D-13 reuses the classic rendering and its tests. Colour is paired with the word `Overdue`.

---

## Page layout (D-14, D-16)

Order under the sticky filter bar: KPI tiles, then six headed sections (amends 96):

| # | Section heading (`<h2>`) | Contents | Hint (12px `--ink-secondary`) |
|---|--------------------------|----------|-------------------------------|
| 1 | `Today` | Today's tasks and Ready to bottle (side by side), then Packaging calendar (full) | `Right now. The filters above don't apply.` |
| 2 | `Production` | unchanged (G1, G2, G3) | unchanged |
| 3 | `Floor today` | unchanged (G5, G6, G7, G8) | unchanged |
| 4 | `Beer & cider` | one card per active beer or cider batch | `Follows the Type and Source filters. Staff batches included.` |
| 5 | `Products & sales` | unchanged | unchanged |
| 6 | `Data health` | unchanged | unchanged |

Loading: sections 1 and 4 render from the same all-or-nothing dashboard load as the rest (no extra spinner), except the calendar's Cal.com data (see Calendar states).

Section 4 is placed immediately after `Floor today` (D-16), so final order is: Today, Production, Floor today, Beer & cider, Products & sales, Data health.

Hint text note (D-15): Today ignores the global filter bar entirely. The hint above is the "small note"; no per-widget note repeats it. The Section 4 hint is constant (always shown).

Section 4 is **hidden entirely when Type = Wine**. When Type = Beer, only beer cards; Cider, only cider; All, both (beer first, then cider, each group newest start first).

Grid: Today uses `.bp-dash-grid` (2 columns >= 768px, 1 column below; calendar spans both). Beer & cider cards use a card grid: `display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))` (default; 2-3 cards across on iPad landscape, 1 on iPad portrait and phone). Cards are not equal-height-stretched (`align-items: start`).

---

## Today section

### Today's tasks (D-13)

- Widget title `Today's tasks`, sub `Overdue first, then due today`. Reuses the classic `renderDashboard()` Today's Tasks markup and handlers (`.bp-task-row`, `.bp-task-check`, `.bp-batch-chip`, `.bp-task-title`, `.bp-task-customer`, `.bp-task-meta`) extracted into a shared function so classic and v2 call one source (no second copy).
- Order: overdue tasks first, each row marked with the word `Overdue` (12px/700) before the title; then due today. Tick checkbox, chip tap opening the batch detail, and existing save-state styling are inherited from classic. No new write path is introduced; the tick uses the existing task-complete call.
- Rows 44px min. Shows 5 rows then `Show all {N}` (`aria-expanded`).
- The hard-coded inline colours in the classic markup (`#ffebee`, `#f44336`, `#c62828`) move to the existing `.bp-task-row--overdue` class when extracted (default; same look, no inline styles in the shared function).
- Empty: `Nothing due today.`
- Needs attention is **not** restored (Phase 98).

### Ready to bottle (D-13)

- Widget title `Ready to bottle`, sub `Ready now, not yet bottled`. Reuses classic Ready to bottle rows (chip, product, customer, location, and the existing `Send Invite` button with its current behaviour). The same predicate (`_dashSummary.readyToBottle`) feeds the Batches-tab filter (below); one function, one source of truth.
- Header shows the count in parentheses: `Ready to bottle (4)`. Shows 5 rows then `Show all {N}`. The classic collapsible toggle is replaced by an always-open widget (default; a collapsed list at the top of the page hides the most actionable content).
- Empty: `No batches are ready to bottle.`

### Packaging calendar (D-02..D-05)

Widget title `Packaging calendar`, sub `Next 14 days · wine and cider bottling, beer canning`. Full width. No Chart/Table toggle (it is already a list). No drill banner; entries open the batch detail.

Anatomy (list grouped by day, Vancouver calendar days, today through today + 13):

```
.bp-cal
  .bp-cal-day                       one per day that has entries; days with none are omitted
    h4.bp-cal-day-head              12px/700 --ink-secondary, padding 8px 0, 1px --ledger-line bottom rule
                                    "Today" · "Tomorrow" · "Wed 5 Nov"
    ul.bp-cal-list
      li.bp-cal-entry               min-height 44px, padding 8px 12px, border-bottom 1px --ledger-line
```

Entry content (one row, wraps to two lines on phone):

| Piece | Booking (Cal.com) | Task with no booking |
|-------|-------------------|----------------------|
| Time | `2:30 pm` 14px/700 tabular, fixed 64px column (Vancouver time) | `All day` 12px `--ink-secondary` in the same column |
| Main | `{customer} · {batch id}` 14px (batch id is the tap target; customer first) | `{customer} · {batch id}` |
| Kind tag | neutral chip `Bottling` (wine, cider) or `Canning` (beer) | same |
| Status | none (confirmed is the default) | 12px `not booked yet`, dashed left border on the entry |
| Unmatched | `{customer or booking name}` + 12px `no batch matched`; no tap target | not applicable |

- Kind is derived from the batch type (wine/cider -> Bottling, beer -> Canning); an unmatched booking takes the kind from its event type (Beer Packaging -> Canning, else Bottling).
- Order within a day: timed bookings by time, then unmatched bookings, then untimed tasks; ties by batch id.
- Dated BrewPad packaging tasks with a matching booking are shown once, as the booking. Undated packaging tasks never appear (D-05); the copy line below the list says so only when at least one exists: `{N} packaging tasks have no date. See Ready to bottle.` (12px note).
- Matching rule (default): case-insensitive, trimmed email equality between booking attendee email and the batch customer email; one customer with several active batches matches the one whose packaging task is due closest to the booking date, else shows `no batch matched`. It never guesses. Planner/researcher confirms where the email lives (D-03).
- A matched entry's main row is a `<button class="bp-table-link">` (44px) opening the batch detail directly, no banner. Focus ring 2px `--ledger-focus`.
- Show 7 entries then `Show all {N}` (`aria-expanded`); the count includes entries on all days.

Calendar states:

| State | Presentation |
|-------|--------------|
| Loading Cal.com (tasks already available) | Tasks render immediately; a 12px note `Checking bookings…` above the list, replaced when done. Never blocks the rest of the section |
| Cal.com down or slow (fail soft, D-02) | Tasks still shown; 12px note `Bookings could not be loaded. Showing BrewPad tasks only.` Entries then all read `not booked yet` **only if** they genuinely have no booking; while bookings are unknown, the status label is omitted (default: never claim "not booked yet" when bookings could not be checked) |
| Nothing in 14 days | `.bp-empty` `Nothing booked or due in the next 14 days.` |
| Server data missing | `.bp-empty` `Not available yet. Reopen the Dashboard tab to refresh.` |

---

## Beer & cider section (D-06..D-12, D-16)

Section heading `Beer & cider`. One card per active beer or cider batch.

Empty (one line, `.bp-empty`, per type shown): Type = Beer `No active beer batches`; Type = Cider `No active cider batches`; Type = All with neither `No active beer or cider batches`; with only one kind present under All, show cards and no empty line for the other (default). The two lines in CONTEXT are used exactly.

### Card anatomy (`.bp-bc-card`)

Card: `--cellar-raised`, 1px `--ledger-line` border, `--r-md` radius, 16px padding, 4px left border in the type colour (see Color), 8px gap between rows.

```
.bp-bc-card
  .bp-bc-head          button (44px) opens the batch detail; flex, wrap, gap 4px 8px
    span.bp-bc-title   14px/700  "SV-B-000167 · Czech Lager"
    span.bp-badge      neutral chip: "Beer" or "Cider" (type spelled out)
    span.bp-bc-day     12px --ink-secondary  "Day 9" (days since start) · stage name ("Primary")
  .bp-bc-line          Style/Juice-yeast line
  .bp-bc-line          Readings line
  .bp-bc-next          Next step line
  .bp-bc-out           Packaging estimate line
  .bp-bc-curve         Fermentation curve (optional, below)
```

Lines (label 12px/700 `--ink-secondary` at left in a 72px column, value 14px; label above value on phone):

| Line | Beer | Cider |
|------|------|-------|
| Facts | `Style` Czech Lager · `ABV` 4.8% · `IBU` 32 | `Juice` Apple · `Yeast` Cider yeast · `ABV` 5.1% |
| Readings | `OG` 12.0 °P · `Latest` 6.4 °P · `Target FG` 3.5 °P | same |
| Next | `Next` Lower to 10°C · due Thu 6 Nov | same |
| Output | `Output` ≈ 25 L packaged · ≈ 52 × 473 mL or 70 × 355 mL | cider: `Output` ≈ 25 L packaged (no can sizes; cider is bottled) (default) |

Rules:

- A fact with no value is omitted from the line (never `null`, `undefined`, `–` on the card). If the whole facts line is empty, omit the row. Cider juice/yeast fall back to the recipe or product name per D-12; if still nothing, omit.
- **Readings (D-08):** with no Plato reading the Latest slot reads `No readings yet`; OG and Target FG still show when known. Neutral wording, no "due", "overdue", "missing". Plato values `{n.n} °P`.
- **Next (D-07):** from the batch's real open tasks: earliest open task by due date. Format `{title} · due {Ddd D Mon}`; due today `due today`; past due date `due {Ddd D Mon}` with the word `late` appended in 12px `--ink-secondary` (no red; Overdue colour belongs to Today's tasks only). Temperature steps (`dashTaskKind` = `temp`) show in the highlight pill described in Color. No open tasks: `No open tasks`. Never derived from day count.
- **Output (D-09, D-10):** estimate only. Litres = 25 L per 28 L brew, or the same proportion of `target_volume_l` when set. Cans: whole cans, rounded down (default), both sizes always shown, counts from the shared bundle constants (`KIOSK_CANNING_BUNDLES` / `kiosk-bundles.js`), never retyped. Always preceded by `≈`. A short 12px note appears once at the bottom of the section (not per card): `Packaged amounts are estimates from the standard batch size.` Hidden when no cards.
- Card header button and all chips: 44px tap targets; focus ring 2px `--ledger-focus`.

### Fermentation curve on the card (D-11)

- Collapsed by default behind a 44px text button `Show readings curve` / `Hide readings curve` (`aria-expanded`), so a page of cards stays short on iPad (default). Expanded body is the G8 single-batch view for that batch: Chart/Table toggle, 220px tall on phone and 240px on tablet (a deliberate step down from the full G8 280px), dashed expected line only when OG and target FG exist, otherwise the G8 note `No expected curve: this recipe has no OG or target FG.`
- When the batch has no readings the button is omitted (the Readings line already says `No readings yet`).
- At most one curve per card; multiple expanded cards are allowed, each a separate Chart.js instance, destroyed when collapsed or when the section re-renders (planner: no leaked charts).
- The G8 `Fermentation` widget in Floor today is unchanged.

### Sort and cap

Beer first then cider; within a type, newest start first. Show 6 cards then `Show all {N}` (`aria-expanded`). Expected volume is small (about 2 beer and 6 cider on prod), so this is only a guard.

---

## Batches tab: Ready to Bottle filter

- One new option in the existing batch-view filter bar (same chip/segment control as the other options, 44px, same selected-fill rules): label `Ready to Bottle (N)`, N from the same predicate as the Ready to bottle widget. Position: after the existing status options, before any type options (default).
- N updates when a batch is marked bottled; the batch drops out of the list immediately and N decrements.
- Empty result under this filter: `No batches are ready to bottle.` (same copy as the widget).
- Interacts with search and other filters exactly as the existing options do. No banner, no hash change beyond what the existing options already do.

---

## Accessibility and touch

- All interactive elements >= 44px: task checkbox label, chips, card header button, `Show readings curve`, calendar entry buttons, `Show all`.
- Calendar is semantic: `h4` day headings and `ul/li`; each entry's accessible name reads in order `{time or All day}, {customer}, {batch id}, {Bottling|Canning}, {not booked yet | no batch matched}`. Status is text, not only the dashed border.
- Card readings and next-step lines are plain text (screen readers read them in order); the curve is a `role="img"` chart with the Table view as the accessible alternative (inherited from G8).
- Temp step highlight carries the text `Temp step`; booking status carries text; type carries text plus border colour.
- Today's tasks checkbox keeps its existing accessible label and keyboard behaviour.
- `prefers-reduced-motion`: no animation on expand/collapse; Chart.js animation off.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | None new. New actions are secondary: `Show all {N}`, `Show readings curve` / `Hide readings curve`. `Send Invite` is the existing classic button, unchanged |
| Section headings | `Today`, `Beer & cider` (others unchanged) |
| Section hints | Today: `Right now. The filters above don't apply.` Beer & cider: `Follows the Type and Source filters. Staff batches included.` |
| Widget titles | `Today's tasks`, `Ready to bottle`, `Packaging calendar` |
| Calendar day heads | `Today`, `Tomorrow`, then `Wed 5 Nov` |
| Calendar labels | kind `Bottling` / `Canning`; `not booked yet`; `no batch matched`; `All day` |
| Card labels | `Style`, `Juice`, `Yeast`, `ABV`, `IBU`, `OG`, `Latest`, `Target FG`, `Next`, `Output`, `Temp step` |
| Empty states | Today's tasks: `Nothing due today.`; Ready to bottle (widget and Batches filter): `No batches are ready to bottle.`; Calendar: `Nothing booked or due in the next 14 days.`; Beer: `No active beer batches`; Cider: `No active cider batches`; both absent under All: `No active beer or cider batches`; no readings: `No readings yet`; no open tasks: `No open tasks` |
| Error / soft-fail states | Bookings: `Bookings could not be loaded. Showing BrewPad tasks only.`; loading: `Checking bookings…`; missing server data: `Not available yet. Reopen the Dashboard tab to refresh.`; dashboard-wide failure and chart failure inherited from 95/96 |
| Notes | `{N} packaging tasks have no date. See Ready to bottle.`; `Packaged amounts are estimates from the standard batch size.`; `No expected curve: this recipe has no OG or target FG.` |
| Example lines | `Next: Lower to 10°C · due Thu 6 Nov`; `≈ 25 L packaged · ≈ 52 × 473 mL or 70 × 355 mL` |
| Banned words (inherited) | "due", "overdue" or "missing" for readings; "conflict", "double-booked", "unbilled", "error" on neutral lists. `Overdue` is allowed only on Today's tasks rows (classic) and never on cards or the calendar |
| Destructive confirmation | None. No new destructive actions. The task tick is the existing classic write; no confirmation, as in classic. Recipe editor Target OG / Target FG fields are plain optional numeric inputs (label `Target OG`, `Target FG`, helper `Optional. Used for the expected curve on the dashboard.`, 16px to avoid iOS zoom, 44px high, same style as sibling recipe fields, beer and cider recipes only) |

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none | not applicable (no shadcn) |
| third-party | none | not applicable |
| npm vendor file | Chart.js 4.5.1 (already vendored; no change) | No new libraries, plugins or CSP domains. Cal.com calls are server-side (middleware), so no browser CSP change |

---

## Implementation Notes for Planner

- Register the new sections in `DASH_V2_SECTIONS` (~L8287): insert `Today` first after KPI tiles and `Beer & cider` after `Floor today`. Widgets are `{key, slot, title, chart, needs, render}` through `runDashV2Widget`; Today widgets declare that they ignore filters (use the unfiltered dataset, as Floor today widgets already do for physical state).
- Extract classic Today's Tasks and Ready to bottle markup (~L8730, ~L8777) into shared render functions called by both classic and v2; keep the classic tests green and unmodified.
- One predicate for Ready to bottle: used by the widget, its count, and the Batches filter.
- Card data needs batchMeta additions: abv, ibu, batch_size_l (D-06 note), OG and target FG; the aggregate must send them. Missing fields degrade per card (omit lines), not the whole section.
- Cal.com list bookings: server-side, cached, fail soft, staff-authenticated; no Zoho Inventory calls.
- Tests (jsdom): section order with and without Type=Wine; Today ignores filters; classic and v2 task rows render identically; Overdue first; calendar day grouping and Vancouver day boundaries (incl. late-evening PT booking that is next day in UTC); booking+task dedupe; no-date tasks excluded with the note; `not booked yet` omitted when bookings failed; unmatched label; kind mapping; card omits empty facts; `No readings yet` neutral wording; next step uses real tasks and temp pill text; can counts come from shared constants and round down; empty lines exact; chart instances destroyed on collapse; Ready to Bottle filter count equals widget count and drops after bottling; banned-word guard over new copy.
- Open (non-blocking): confirm on the iPad that cards at minmax(320px) read well in portrait; confirm where the batch customer email lives for matching (D-03).

---

## Checker Sign-Off

- [ ] Dimension 1 Copywriting: PASS
- [ ] Dimension 2 Visuals: PASS
- [ ] Dimension 3 Color: PASS
- [ ] Dimension 4 Typography: PASS
- [ ] Dimension 5 Spacing: PASS
- [ ] Dimension 6 Registry Safety: PASS

**Approval:** pending

# Phase 99 Rollout Log

## Staging deploy (2026-11-13)

- Staging sha: `d9693731` (`git push origin main`), build stamp `mwfe41v5` confirmed in the served page.
- Deploy Staging workflow: success. Staging middleware restarted (includes a12d8d05, the
  `get_tasks_calendar` allow-list fix); ingredient catalog warmed afterwards.
- Production: untouched by this plan (`280eae3e`, tag `prod-20261111-1`).
- CI "Tests" workflow: failure, on the middleware lint step only (7 unused-variable warnings in
  `zoho-middleware/routes/pos-recipe.js` and `scripts/spike-past-schedule-98.js`). Pre-existing: the same
  step has failed on every push since at least 2026-11-11. Not caused by Phase 99; raised with the owner.

## Pilot UAT (Claude, owner's signed-in Chrome, staging `?dash=v2`)

Phone widths were checked in same-origin iframes (390 / 360 / 320 px) injected into the staging page.

| # | Item | Result | Note |
|---|------|--------|------|
| 1 | 390 px order and collapsed sections (D-09, D-10) | PASS | Order: filters, Today (Needs attention chips, Today's tasks, Ready to bottle, packaging calendar), KPI tiles, then collapsed sections with 44 px toggles. 0 canvases while collapsed; opening the sections rendered 10 charts. |
| 2 | 360 / 320 px: no horizontal scroll with every section open (D-12) | PASS | scrollWidth equals innerWidth at 390, 360 and 320. Two notes below (320 px chart clip, tab bar). |
| 3 | Desktop >= 1200 px: 3 columns (D-11) | PASS | Grids compute to 3 x 448 px inside a 1440 px panel at a 1920 px window. |
| 4 | Same-day reload paints cached data with the hint (D-07, D-08) | PASS | "As of 1:02 PM · Updating…" with 10 task rows at 0.47 s, then "Updated 1:02 PM" at 0.75 s. Cache entry present in localStorage. |
| 5 | Chart / Table toggle on every chart; calendar Table view (D-14) | PASS (calendar toggle not exercised) | All 11 canvases sit in a widget with a Chart/Table toggle. The packaging calendar was empty ("Nothing booked or due in the next 14 days"), so its Calendar/Table switch was not shown and could not be exercised on staging data. |
| 6 | Keyboard focus ring uses --stain (D-14) | PASS | Tabbed control shows `:focus-visible` with `outline: solid 2px rgb(55, 14, 19)` (= #370e13). Sampled on the filter bar, not every control. |
| 7 | Line-chart markers and legend glyphs (D-15) | PASS | Fermentation line chart: triangle and rect point styles, radius 6; legend shows the matching glyphs. |
| 8 | Batch QR and label PDF open after idle preload (A1) | PARTIAL | Both libraries are loaded shortly after sign-in (`qrcode` and `jspdf` present). The print window itself was not opened by Claude (a print dialog blocks browser automation); left for the owner's iPad check. |
| 9 | No qrcode / jspdf request before first paint | PASS | First paint at 0.06 s; both scripts requested at 0.47 s. |
| 10 | 390 px tab order follows the visual order (WCAG 2.4.3) | PASS with a note | Focusable groups in DOM order: filters, Today, KPI tiles, then the section toggles and their contents. One focusable inside the filter block is positioned far down the page (about 6800 px) before focus returns to the top; not identified, worth a look. |

Also confirmed: charts render lazily on desktop (3 canvases before scrolling, 11 after scrolling the panel), and
`get_tasks_calendar` through `/api/batch/admin-proxy` now returns 200 with 23 tasks (it returned
`invalid_action` in the 2026-11-12 capture).

### Findings (not failures of the plan's criteria)

- **320 px: one chart is clipped.** A chart in the Fermentation / Beer & cider area (`.bp-g6-chart`) extends
  to 333 px in a 318 px viewport. It is clipped by its container, so there is no page scroll, but about 15 px of
  the chart is cut off. Fine at 360 and 390 px.
- **Bottom tab bar at narrow widths.** The six tabs are 385 px wide in total. At 360 px the Waitlist tab is partly
  cut off; at 320 px it is entirely off-screen. This is the app shell, not the v2 dashboard, and is very likely
  older than Phase 99.
- **App header at phone widths.** The signed-in email overlaps the "BREWPAD" label. App shell, likely older than
  Phase 99.
- **KPI tiles at desktop.** The tiles are two per row while the grids below are three per row, so the third
  tile sits alone on its own row.

## Owner sign-off

2026-11-13, owner: **approved, tests ok**.

- v2 is approved to become the default dashboard.
- Permission given to update the 13 existing tests that assume the classic dashboard is the default
  (`brewpad-dashboard-v2-shell.test.js` x3, `brewpad-dashboard-render.test.js` x10), per CLAUDE.md rule 10.
- **iPad testing deferred by the owner** ("brewpad is mainly accessed via laptop"). Not verified on a real touch
  device: two-tap chart tooltips (D-13), finger-scrolling over a chart, and Safari's popup blocker when printing a
  QR code or label right after sign-in (A1). Tracked in `.planning/todos/pending/phase-99-ipad-touch-checks.md`.
  The same waiver was made for Phase 96.

## Default flip on staging (2026-11-13)

- Staging sha: `a65c9897` (feature commit `4ea08134`, `git push origin main`); deploy-staging succeeded.
- v2 is now the default: empty storage or a stored opt-out without the migration marker opens v2 once and sets
  `bp_dash_default_v2`; "Classic dashboard" switches back and is remembered; `?dash=classic` / `?dash=v1` open Classic.
- Harness after the change: PASS (cold perf 0.89, warm 1.00, axe 0, no overflow).
- Production: unchanged (`280eae3e`). Release needs separate owner approval.

## Default flip confirmed

2026-11-13, owner: **approved** (checked on staging on a laptop; iPad check deferred, see the todo
`.planning/todos/pending/phase-99-ipad-touch-checks.md`). The owner did not report separately on the QR / label
print window, so pilot item 8 stays partly checked.

Production promotion follows the normal release process and needs the owner's go-ahead.

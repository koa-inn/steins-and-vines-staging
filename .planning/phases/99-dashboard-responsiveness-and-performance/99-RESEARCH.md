# Phase 99: Dashboard responsiveness and performance - Research

**Researched:** 2026-11-06
**Domain:** Vanilla ES5 dashboard (js/brewpad.js, css/brewpad.css, brewpad.html), responsive grid, lazy loading, a11y, Lighthouse harness
**Confidence:** HIGH on code baseline (read from the tree); MEDIUM on Lighthouse harness details (tool versions verified, harness not yet run)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** v2 becomes the default dashboard, and a "Classic dashboard" link stays as a fallback. The existing toggle (`js/brewpad.js` ~7279, "Back to classic dashboard") is kept and relabelled as needed. v1 keeps working unchanged.
- **D-02:** Sign-off works as in Phases 96-98. Claude pilots staging UAT, the owner approves on the shop iPad, and the default flip ships in this phase's release. No separate trial period.
- **D-03:** The flip moves every device to v2 **once**, including devices that had stored `bp_dash_v2 = '0'`. After that, a device that clicks Classic is remembered as before. Use a one-time migration marker (for example a new localStorage key or version) so the reset happens only once per device.
- **D-04:** v1 code removal is **not** in this phase. Add a backlog todo, "Remove v1 dashboard code", which the owner triggers when ready. There is no date.
- **D-05:** The pass/fail gate is **Lighthouse lab numbers only**: Lighthouse mobile performance >= 85 on `brewpad.html` with v2 on. The handoff targets (interactive in under 1.5 s warm, under 3 s cold) are read from the same Lighthouse runs, not timed by hand on the iPad.
- **D-06:** Lighthouse runs against a **local build served with recorded dashboard data**. The run must be repeatable and kept in the repo as a script or check. It does not run against staging, because Cloudflare Access and the staff login get in the way.
  - It needs a way to bypass or mock auth and the admin-proxy responses locally, and that path must never ship enabled in production.
  - It does not measure real Railway latency. That is an accepted limit.
- **D-07:** **Stale-first rendering is allowed.** Show the last dashboard data immediately with a small "as of HH:MM" or "updating..." hint, then swap in fresh data from the background refresh. This includes the Needs attention row.
- **D-08:** Cached data shows first **only if it is from today, Vancouver time** (reuse `dashV2TodayDate()`). Otherwise show skeleton placeholders until fresh data arrives.
- **D-09:** The phone (one-column) order is **action first**: Needs attention -> Today's tasks -> Ready to bottle -> KPI tiles -> chart sections. The filter bar stays collapsed behind the existing "Filters" button at narrow widths.
- **D-10:** On phones, chart sections are **collapsed by default** to tappable headers. A section's charts are not loaded or rendered until it is opened, which also serves lazy loading. Tablet and desktop stay expanded, and their below-the-fold charts load lazily as they approach the viewport.
- **D-11:** The grid is **1 column on phone, 2 on tablet and 3 on wide desktop (from about 1200 px)**. Wide charts span the full row; these include production over time and the packaging calendar. There is no 4-column layout. The existing `.bp-dash-grid` is 1 column, then 2 from 768 px; extend it.
- **D-12:** No horizontal scroll at 360 px.
- **D-13:** Touch tooltips: **tapping a point shows its tooltip, and tapping away hides it.** On touch, the click-through to the filtered batch list moves to a control in the tooltip or a second tap on the same point, so a stray tap never navigates away. Mouse behaviour on desktop is unchanged.
- **D-14:** Targeted a11y pass with an automated check, not a full WCAG audit: every v2 chart has a table view (audit incl. Phase 97 beer/cider charts and packaging calendar); colour never the only signal; visible focus states on every interactive v2 control; text contrast >= 4.5:1; an automated axe or Lighthouse accessibility check runs on the v2 dashboard as part of the D-06 local run.
- **D-15:** Non-colour series signals use **distinct point markers** on line charts (circle, triangle, square, etc., one per type). Stacked bars keep a labelled legend, and their values appear in the tooltip and table. No hatched patterns.

### Claude's Discretion
- **Recorded data:** the D-06 fixture is **anonymized** before it is committed (customer names, emails, phone numbers replaced; batch ids, dates, counts kept).
- **Loading speed:** Claude chooses the technical levers (deferring/lazy-loading `jspdf.umd.min.js` ~366 KB and `qrcode.min.js`, script `defer`, bundle split, skeleton design).
- **Hint wording:** exact copy and placement of the "as of"/"updating..." hint and of collapsed-section headers.
- **Cache key:** key, format and storage (sessionStorage vs localStorage) for the cached-first render, as long as D-08 holds.

### Deferred Ideas (OUT OF SCOPE)
- **Remove v1 dashboard code:** backlog todo, owner-triggered (D-04). The todo file already exists: `.planning/todos/pending/remove-v1-dashboard-code.md`.
- **Timed iPad performance check:** Lighthouse lab only. Revisit only if staff report slowness.
</user_constraints>

<phase_requirements>
## Phase Requirements

Requirement IDs are "TBD" in ROADMAP. The planner should mint Phase 99 IDs from the roadmap success criteria and CONTEXT decisions.

| Proposed ID | Description | Research Support |
|-------------|-------------|------------------|
| RESP-01 | 1/2/3-column mobile-first grid, no horizontal scroll at 360 px (D-09..D-12) | "Grid and layout baseline", Pattern 1, Pitfall 1, 2 |
| PERF-01 | Lighthouse mobile perf >= 85 on brewpad.html with v2; TTI figures read from the same runs (D-05) | "Payload baseline", "Lighthouse harness" |
| PERF-02 | Cached-first render + skeletons, same-day Vancouver only (D-07, D-08) | Pattern 3 |
| PERF-03 | Lazy charts: collapsed phone sections, IntersectionObserver on larger widths, heavy scripts off the head path (D-10, Discretion) | Patterns 2, 4 |
| A11Y-01 | Table view on every chart; non-colour markers; visible focus; 4.5:1 text (D-14, D-15) | "A11y baseline", Patterns 5, 6 |
| A11Y-02 | Touch tooltip tap / tap-away / action button (D-13) | Pattern 7 |
| DFLT-01 | v2 default, one-time migration, Classic fallback, v1 removal todo (D-01..D-04) | Pattern 8 |
</phase_requirements>

## Summary

The dashboard is a single IIFE in `js/brewpad.js` (17,656 lines, bundled to `brewpad.min.js`). v2 is built by `renderDashboardV2()`, which creates a shell once (filter bar, tiles slot, six `<section data-dash-sec>` blocks, each holding a `.bp-dash-grid` of slot divs) and then calls `refreshDashV2()` -> `renderDashV2Widgets()`, which renders **all 15 registry widgets (`DASH_V2_WIDGETS`) eagerly** as soon as data exists. Chart.js (208 KB, 70 KB gz) is already lazy via `loadChartJs()`, but is loaded the moment the first v2 render runs, and every chart is built at once. Most of Phase 99 is therefore: (a) gating widget rendering by section open state / viewport, (b) a same-day cache in front of `eagerLoad()`, (c) CSS grid additions, (d) fixing the a11y gaps listed below, and (e) the default flip, all inside existing seams.

The biggest cold-load costs are not the dashboard code itself. `brewpad.html` blocks on 12 synchronous `<script>` tags, including `jspdf.umd.min.js` (366 KB, 116 KB gz) and `qrcode.min.js` (20 KB), which are used only in two label/print functions (`js/brewpad.js` 12721-12790). Moving those two off the head path is the cheapest large win (about 123 KB gz, plus parse time). `brewpad.min.js` is 415 KB (111 KB gz) and is the next cost. Boot also fires five parallel admin-proxy calls (`eagerLoad`, L7058) and the packaging calendar adds up to two more (`get_tasks_calendar`, `get_waitlist`).

The Lighthouse harness (D-06) can be built **without any production-shipped mock**: seed `localStorage` with a session, and use Playwright `page.route` to fulfil `POST /api/batch/admin-proxy` from an anonymized fixture, and to block Google fonts/GSI. Nothing in `js/` needs a test flag, which satisfies "must never ship enabled in production" by construction. Serve the repo root with a static server (the page needs `js/`, `css/`, `images/`, `/content/zoho-snapshot.json`). One real constraint: the current `lighthouse` 13.6.0 requires Node >= 22.19, and the local machine runs Node 20.20.2 (project engine is 24.x; Node 24.21.0 is available in nvm). Use Node 24 for the harness.

**Primary recommendation:** Build in this order: (1) Lighthouse+axe harness and baseline run first, so every later change is measured; (2) move jsPDF/qrcode off the head path; (3) section/viewport-gated widget rendering; (4) cached-first + skeletons; (5) grid CSS, markers, touch tooltip, focus/contrast fixes; (6) default flip last, after staging UAT.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Responsive grid, collapsible sections, order | Browser (CSS + ES5 render) | none | Pure presentation in css/brewpad.css and renderDashboardV2 |
| Cached-first render, same-day check | Browser (localStorage) | none | No server change allowed (out of scope: new endpoints) |
| Lazy chart / script loading | Browser | CDN/Static (GitHub Pages) | `loadChartJs`, `<script defer>` / dynamic load of vendor files |
| Touch tooltip, point styles | Browser (Chart.js config in `chart()`) | none | Shared `chart()` config |
| Table views, focus, contrast | Browser (HTML/CSS) | none | Existing `dashTableHtml`, `.bp-seg` |
| Default flip + migration | Browser (localStorage) | none | `dashV2FlagFrom` / `initDashV2Flag` |
| Dashboard data (`get_dashboard_stats`) | API / Backend (middleware admin-proxy) | Database (Postgres) | Unchanged; ~60 s server cache |
| Lighthouse/axe harness | Dev tooling (Playwright + Chrome) | none | Dev dependency only, never shipped |

## Standard Stack

### Core (already in the repo, no change)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Chart.js | 4.x, self-hosted `js/vendor/chart.umd.min.js` (208,522 B; 70,523 B gz) | All v2 charts | Phase 95 D-02; lazy via `loadChartJs()` [VERIFIED: file sizes measured; js/vendor/README.md] |
| @playwright/test | ^1.58.2 (already a devDependency) | Serve/drive page, route-mock admin-proxy | Already used by `tests/e2e` [VERIFIED: package.json] |
| Jest + jsdom | existing | Unit tests for pure helpers | Existing `tests/frontend/brewpad-dashboard-v2-*.test.js` pattern |

### Supporting (new, dev-only)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lighthouse | 12.8.2 (works on Node >=18.16) or 13.6.0 (needs Node >=22.19) | Mobile perf + a11y score, CI-style script | The D-05/D-06 gate. Run under Node 24 (project engine). [VERIFIED: npm view engines] |
| chrome-launcher | 1.2.3 | Launch local Google Chrome (installed at /Applications/Google Chrome.app) for Lighthouse | Programmatic Lighthouse run |
| @axe-core/playwright | 4.14.0 (axe-core 4.14.0) | Axe scan of the rendered v2 dashboard in the same Playwright session | D-14 automated check |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Lighthouse Node API + chrome-launcher | `lighthouse` CLI with `--chrome-flags` against a Playwright-launched Chrome via `--port` | CLI is simpler to document; but the page needs route-mocking, which only works inside the Playwright context. Recommended: launch Chromium with `--remote-debugging-port` from Playwright, route-mock on its context, and point Lighthouse at that port (`lighthouse(url, {port})`). Planner to prototype in Wave 1 (see Open Question 1). |
| Playwright route mocking | A tiny Node mock server standing in for the middleware | Needs `SHEETS_CONFIG.MIDDLEWARE_URL` override, i.e. a code/test seam. Route mocking avoids any shipped seam. |

**Installation (dev only; the plan must edit package.json deliberately):**
```bash
npm install --save-dev lighthouse@12.8.2 @axe-core/playwright chrome-launcher
```
Note: `slopcheck install` runs the real `npm install` (it has no dry-run/`--json`). During this research it installed into the project and was reverted with `git checkout package.json package-lock.json && npm prune`. The working tree is clean of it.

**Version verification:** `npm view lighthouse version` = 13.6.0 (engines node >=22.19); 12.8.2 engines node >=18.16; `@axe-core/playwright` 4.14.0; `chrome-launcher` 1.2.3. [VERIFIED: npm registry, 2026-11-06]

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| lighthouse | npm | many yrs | very high | github.com/GoogleChrome/lighthouse | [OK] | Approved |
| @axe-core/playwright | npm | several yrs | high | github.com/dequelabs/axe-core-npm | [OK] | Approved |
| chrome-launcher | npm | many yrs | high | GoogleChrome org | [OK] | Approved |

Age/download figures are from general knowledge, not queried: tagged [ASSUMED] for those columns only. slopcheck returned [OK] for all three; no postinstall scripts (`npm view <pkg> scripts.postinstall` empty for all three).
**Removed:** none. **Flagged [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
Page load (brewpad.html)
  |
  |-- head: constants/utils/auth/... (sync) ; [jspdf, qrcode: REMOVE from head] ; gsi async ; brewpad.min.js
  v
initGoogleAuth -> loadSession (localStorage 'sv-brewpad-session') -> checkAuthorization -> showApp -> eagerLoad
  |
  |-- NEW: cached-first branch
  |     readDashCache() -> same-day (Vancouver) ? hydrate _dashData/_dashSummary/_upcomingTasks... -> renderDashboard() + hint "As of ... Updating..."
  |                     -> else skeletons (aria-busy)
  |
  |-- 5x adminApiGet (parallel): get_dashboard_stats, get_batches, get_vessels, get_ferm_schedules, get_tasks_upcoming
  v
  fresh data -> writeDashCache() -> renderDashboard() -> isDashV2()? renderDashboardV2()
                                                           |
                                          shell built once (filters, tiles, 6 sections)
                                                           |
                       refreshDashV2 -> buildDashV2Model -> renderDashV2Widgets
                                                           |
                  +----------- gate per widget ------------+
                  | phone (<768): section open?  -> no: skip (header only)
                  |                              -> yes: loadChartJs() then render that section's widgets once
                  | tablet/wide: IntersectionObserver(rootMargin 200px) -> render slot on approach; skeleton at final height until then
                  | Table view widgets: render without Chart.js
                  +----------------------------------------+
  chart(canvas,cfg) -> Chart.js (pointStyle per series, touch tooltip external HTML, onClick drill rules)
```

### Recommended Project Structure (existing; no new modules in the IIFE)
```
js/brewpad.js            # edit: top-level pure helpers (exported at ~17584) + IIFE render code
css/brewpad.css          # edit: grid, sections, skeletons, focus, contrast
brewpad.html             # edit: script tags (remove jspdf/qrcode from head)
tests/frontend/brewpad-dashboard-v2-*.test.js   # new files for Phase 99 (do not edit existing tests, CLAUDE.md rule 10)
tests/perf/ (or scripts/perf/)  # NEW: lighthouse+axe runner, anonymized fixture, README
```
Never edit `js/brewpad.min.js` / `css/*.min.css`; run `npm run build` after changes and revert restamp noise before commit (Phase pattern).

### Pattern 1: Grid extension (D-11, D-12)
**What:** Extend `.bp-dash-grid` (css:3112; 2-col at css:3208 `@media (min-width: 768px)`); add:
```css
@media (min-width: 1200px) {
  .bp-dash-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
}
.bp-dash-grid > * { min-width: 0; }
```
`.bp-dash-full { grid-column: 1 / -1 }` already exists (css:3115) and the section builder already tags full-width slots with it (`DASH_V2_SECTIONS` slots `[id, true]`). Current full list: today.packcal; production.period; floor.tasks, floor.ferment; bc; products.wine, products.source; health. [VERIFIED: js/brewpad.js 8738-8750]. This differs from the UI-SPEC wide list (G1, packcal, Products): at 3 columns, G4/G9 products and G7/G8 are already full-width, so only G2/G3/G5/G6 occupy single cells. **Planner: keep the existing flags unless a visual check at 1200 px says otherwise; do not rework them.** Existing `.bp-g4 { grid-template-columns: 3fr 2fr }` at 768 px lives inside a full-width slot, unaffected.
**Phone KPI rule:** `.bp-stat-row` is a *flex row inside tiles* (`.bp-stat-row > * { flex: 1 1 calc(50% - 8px) }` at max-width 600); the tile grid is `.bp-stat-grid`. Verify tiles at 360 px with the harness rather than assuming; UI-SPEC wording about `.bp-stat-row` 5 columns refers to an existing 768 px rule at css:3195.

### Pattern 2: Section collapse + render-on-open (D-09, D-10)
Today `dashV2SectionsHtml()` (L8752) emits `<section class="bp-dash-section"><div class="bp-dash-section-head"><h2>...`. Plan:
- Use CSS `order` inside a flex-column wrapper at <768 px only (keeps one DOM order on tablet). The Needs attention row is the `lead` slot of the `today` section (`bp-dash-v2-attn`), and the tiles slot `bp-dash-v2-tiles` sits above all sections in the shell, so phone order requires either `order` on a flex/grid shell or moving the tiles node. Recommended: make `#bp-dash-v2` `display:flex; flex-direction:column` below 768 px and give `today` section `order:0`, tiles `order:1`, remaining sections `order:2`. The `today` section must therefore *not* contain chart sections. Today's section includes the packaging calendar (a list, not Chart.js); keep it always open.
- Convert the section heading to a button only at <768 px. Because the matchMedia swap already exists for filters (`dashV2IsPhone`, `bindDashV2ModeListener`, 600 px), **reuse that listener pattern but with a 768 px query** (the filter bar breakpoint is 600 px; the sections breakpoint is 768 px; keep them separate).
- Gate: `runDashV2Widget(def, model, chartState)` is the single choke point (L8470). Add a predicate `dashV2SlotShouldRender(def)` (section open on phone, or already intersecting on larger widths) before `def.render`. Widgets in a closed section show a header only; on first open call `rerenderDashV2Widget(key)` for that section's keys (this function already exists, L8483).
- Reduced-motion: no height animation (UI-SPEC).

### Pattern 3: Cached-first (D-07, D-08)
Seam: `eagerLoad()` (L7058) and `loadDashboard()` (L7161); `_dashData`, `_dashSummary`, `_allBatchesData`, `_vesselsData`, `_fermSchedules`, `_upcomingTasks` are module globals read by `refreshDashV2`. **What the dashboard needs for first paint is what `refreshDashV2` reads**: `_dashData` (the `get_dashboard_stats` aggregate, includes `batches`, `asOf`, `staffBatchIds`, `taskRows`, `vessels`, `readings`, `batchMeta`, `inviteSentIds`) plus `_fermSchedules` and `_upcomingTasks` (Today, attention). `_allBatchesData` (full `get_batches`) is only a fallback when `_dashData` is null, so it does not need caching.
- Store: `{ v: 1, day: dashV2TodayDate(), savedAt: <ms>, dashData, fermSchedules, upcomingTasks }`. Recommended storage: **localStorage** (survives iPad PWA/Safari restarts; sessionStorage is dropped when the tab/PWA is killed). Size risk: `get_dashboard_stats` includes `readings` and `taskRows`; measure the JSON size from the fixture (localStorage cap ~5 MB per origin, and it already holds session/filters/drafts). If it exceeds ~1 MB, cache only the keys the first paint needs, or fall back to sessionStorage. Wrap `setItem` in try/catch (quota, private mode), as the file already does for `bp_dash_v2`.
- Same-day check: compare stored `day` to `dashV2TodayDate()` (L9377, Vancouver). Test the late-evening PT boundary (UTC date != Vancouver date).
- **Privacy/security:** cache only what the page already shows; this includes customer-adjacent data inside batch rows (names/emails may appear in `get_batches`, not necessarily in the aggregate). Do not cache `_allBatchesData`. **Clear on sign-out** (`bpSignOut` L4745 and `_enterLoggedOutState`) and when the signed-in email differs from the cached one (store `email`).
- The existing v2 `refreshDashV2` short-circuits to `showDashV2NoData` when `_dashData` and `_allBatchesData` are both empty; hydrating `_dashData` from cache makes that path unnecessary on the warm path.
- Hint: new element (e.g. `#bp-dash-asof`, `role="status" aria-live="polite"`) in the shell header row next to `#bp-dash-switch`. Update text only on the state transitions in UI-SPEC section 5. Do not use the word "stale".
- Skeleton states: existing `.bp-skeleton-block` is 56 px tall, shimmer animation, already reduced-motion safe (css:378-390). `eagerLoad` currently injects two generic skeleton blocks into `#bp-dashboard-inner` only when `#bp-dash-v2` does not exist. Phase 99 replaces them with layout-matching skeletons (set explicit heights to avoid CLS).

### Pattern 4: Heavy scripts off the head (Discretion)
`generateBatchLabelPDF` (L12737) checks `typeof window.jspdf === 'undefined'` and `qrcode` at L12721/12784. Add a `loadScriptOnce(src)` helper modelled on `loadChartJs()` (promise cached, remove node on error) and call it at the top of those two functions, then continue. Fallback toast copy is fixed in UI-SPEC. Because `generateBatchLabelPDF` currently runs synchronously from a click and uses `window.open` for the print path (L12721-12730), **the lazy load happens before `window.open` would be blocked as a popup only if the open is inside the user gesture**; check each call site: loading asynchronously before `window.open` risks Safari popup-blocking. Mitigation: for the print path open the window first, or preload both scripts on first user interaction/idle (`requestIdleCallback`/`setTimeout`) rather than on click. Recommended: **idle-preload after first dashboard paint** (so clicks still find them) plus the on-demand loader as a fallback. [ASSUMED: popup-blocking behaviour on iPad Safari; verify on device]
Also: `js/lib/*` and `sheets-config.js`/`admin-config.js` are synchronous too (about 22 KB total, small). Adding `defer` to the main bundle `brewpad.min.js` is **risky** (other scripts and inline init order; the file runs init at load). Do not defer the bundle unless tests/UAT prove the init ordering; keep it as an optional, measured experiment.
Fonts: `fonts.googleapis.com` stylesheet is render-blocking on every load (preconnect exists). Lighthouse will flag it; in the harness it is route-blocked (see harness), so it will not show. Optional lever: `font-display=swap` is already in the URL (`display=swap`).

### Pattern 5: Table view coverage (D-14)
Registry audit (read from code): widgets with the `dashViewToggleHtml` Chart/Table toggle: g1, g2, g3, g4, g9, g5, g7, g6, g8 (L7650-8304). `bc` (Beer & cider) has its own per-curve Chart/Table toggle (`data-bc-view`, L9760-9773) using `dashTableHtml('bc', ...)`. **Gaps to verify by test:** `g10` Data health (L8335 `dashV2SetControls(slotId, '')` - no toggle; it may not be a chart at all, check whether it renders a canvas) and `t3` Packaging calendar (a list calendar, no toggle; UI-SPEC says add a table with Date | Batch | Task | Type). `t0/t1/t2` are lists, not charts. The coverage test should iterate `DASH_V2_WIDGETS` (exported at ~L17442 `widgets: DASH_V2_WIDGETS`) and classify each as chart / list. Existing helper `dashTableHtml` and `dashV2TableModel` are the table renderers to reuse.

### Pattern 6: Point markers (D-15)
`chart()` line series currently copy `pointRadius`, `borderWidth` etc. from `series[i]` (L3412-3421). Add `ds.pointStyle`, `ds.pointRadius` (6), `ds.pointHitRadius` (22), `ds.pointBackgroundColor`, `ds.pointBorderColor` for `cfg.type === 'line'` via a pure exported helper `dashPointStyleFor(seriesKey, index)` (key map: wine circle, cider triangle, beer rect, other rectRot; categorical fallback by index: circle, triangle, rect, rectRot, cross, star). Chart.js 4 supports these `pointStyle` values [CITED: chartjs.org/docs/latest/configuration/elements.html#point-styles, from training knowledge; confirm in Context7 during planning]. Only 2 call sites currently build line charts of note (G1 production over time, G8 ferment curves at ~L3247). The HTML legend swatch must mirror the glyph (legend built in the widget code, find `bp-chart-legend` usages).

### Pattern 7: Touch tooltip (D-13)
Chart.js external tooltips are the documented way to render an HTML tooltip; `options.plugins.tooltip.enabled=false` plus `external: function(context){...}` [CITED: chartjs.org/docs/latest/configuration/tooltip.html#external-custom-tooltips, training knowledge; confirm in Context7]. Branch on `evt.native.pointerType === 'touch'` (or `matchMedia('(pointer: coarse)')`). The existing `onClick` (L3600) always navigates on a hit; on touch it must instead (first tap) show the tooltip and (second tap on the same point, or the tooltip button) call `cfg.onClick(payload)`. Keep mouse path byte-for-byte. Charts already set `canvas.style.cursor='pointer'`; add `touch-action: pan-y` to `.bp-chart canvas`. Tooltip must be reachable (button is a focusable `<button>`); clamp to viewport with 8 px margins. Because hover-tooltips on iOS Safari fire on touchstart, test on the real iPad (owner UAT) as well as jsdom unit tests of the pure decision function (`dashTouchTapAction(prevPoint, nextPoint, tooltipOpen)` -> 'show'|'drill'|'hide').

### Pattern 8: Default flip + migration (D-01..D-03)
Current code: `dashV2FlagFrom(search, hash, storedFlag)` (L1420, **pure, exported L17584**, locked tests exist: `brewpad-dashboard-v2-shell.test.js` likely). `initDashV2Flag` (L7240) reads `bp_dash_v2`; `setDashV2` writes it. Existing behaviour: `dash=v2` (query or hash) -> on, persist '1'; `dash=v1` (query) -> off, persist '0'; else stored === '1'.
**Do not change the existing 3-argument contract** (Do not modify existing tests; CLAUDE.md rule 10). Add a new pure function with a 4th argument or a new name, e.g. `dashV2DefaultFlagFrom(search, hash, storedFlag, migrated)`:
- `dash=v2` -> on, persist '1' (and mark migrated).
- `dash=classic` or `dash=v1` -> off, persist '0' (UI-SPEC says add `classic`; keep `v1` working).
- else if `!migrated` -> on, persist '1', set marker (this is the one-time reset of `'0'` devices).
- else stored === '0' ? off : on (default on when the key is absent).
`initDashV2Flag` passes `localStorage.getItem('bp_dash_default_v2')` and sets it after the first run. Note `initDashV2Flag` runs at IIFE boot (L7283 region) **before** sign-in; keep it synchronous. The toggle label (L7279) becomes `Classic dashboard`. `stripDashFromUrl` already cleans `dash` params. `serializeDashFilters` always emits `dash=v2` as the first hash key (L1407): keep; it is harmless and not advertised.
Also grep other `bp_dash_v2` / `dash=v2` references in docs/tests before flipping: only brewpad.js uses it (grep over js/ found no other users; tests reference `dashV2FlagFrom`).

### Anti-Patterns to Avoid
- Editing `js/brewpad.min.js`, `css/*.min.css` or `js/main.js`; they are build outputs.
- Destroying/recreating the shell on refresh (breaks scroll position, focus, layout stability). Update in place, as the existing `refreshDashV2` does.
- Rendering the hint on every re-render with `aria-live` (noisy); announce transitions only.
- Putting the lighthouse/auth mock in shipped JS. Use `page.route` + seeded localStorage.
- Relying on desktop Chrome resizing for phone width (cannot shrink below ~600 px; use 390 px same-origin iframe on staging per project memory, rAF throttled inside; Lighthouse harness uses its own mobile emulation).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Perf scoring | Custom timing script | Lighthouse (programmatic) | D-05 gate is defined as Lighthouse |
| Contrast / ARIA audit | Manual colour maths in tests | axe-core via @axe-core/playwright (`color-contrast`, `aria-*`, `button-name`) | D-14 gate; avoids ad hoc checks (one ad hoc ratio check for tokens is fine as a fast unit test) |
| Viewport-lazy rendering | Scroll listeners | `IntersectionObserver` with feature-detect fallback to render-all | UI-SPEC; supported on iPad Safari 12.1+ [ASSUMED] |
| Script lazy-loading | Fresh implementation per script | One `loadScriptOnce` modelled on `loadChartJs()` | Same retry/error semantics |
| Chart HTML tooltips | Own hit testing | Chart.js `external` tooltip + `getElementsAtEventForMode` | Already used for click hits |

## Runtime State Inventory

This is not a rename phase, but the default flip and cache add durable client state:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Per-device localStorage: `bp_dash_v2` ('0'/'1'), `bp_dash_filters`, `sv-brewpad-session`, `sv_session_token`. NEW: migration marker + dashboard cache | Code edit for the marker; migration is the marker logic itself (D-03). Cache cleared on sign-out |
| Live service config | None; no server/Apps Script change | None - verified: scope forbids new endpoints |
| OS-registered state | None | None |
| Secrets/env vars | None | None |
| Build artifacts | `js/brewpad.min.js`, `css/brewpad.min.css`, `?v=` stamps in brewpad.html | `npm run build`, revert restamp noise |

## Common Pitfalls

### Pitfall 1: Global focus rule vs control-specific faint rules
**What goes wrong:** css:100 already defines `*:focus-visible { outline: 2px solid var(--stain); outline-offset: 2px; }` (16:1 on cream). But at least 8 v2 control rules override it with `var(--ledger-focus)` = rgba(55,14,19,0.35), roughly 2.5:1 on #faf8f2 (computed), below the 3:1 non-text minimum: `.bp-drill-banner-close` (579), `.bp-stat-card--link` (604), `.bp-dash-chip` (3105), `.bp-table-link` (3131), `button.bp-list-row` (3137), `.bp-accordion-head` (3145), `.bp-bc-head` (3175), `.bp-text-btn` (3205), `.bp-attn-chip` (3254); plus `border-color: var(--ledger-focus)` on inputs (2360, 2388).
**How to avoid:** Change those declarations to `var(--stain)` (a one-token edit each) instead of adding new rules; add a CSS-reading test asserting no v2 `:focus-visible` rule uses `--ledger-focus` and none uses `outline: none`. Check `.bp-seg-btn`, `.bp-filter-btn`, `select`, `input[type=date]` and legend buttons: grep found no dedicated rule, so they inherit the global rule (fine) unless an ancestor has `overflow:hidden` (use inset offset).

### Pitfall 2: 360 px overflow from canvases and tables
**What goes wrong:** Chart.js `responsive` canvases and wide tables push `scrollWidth` past 360 px.
**How to avoid:** `min-width:0` on grid children; `.bp-chart { overflow:hidden }`; tables inside `.bp-table-wrap { overflow-x:auto }`. Assert `document.documentElement.scrollWidth <= viewport` in the harness at 360 and 320 px (Lighthouse emulates mobile at 412 px, so add a separate Playwright check at 360 using `page.setViewportSize` - real Chromium inside Playwright CAN be sized to 360, unlike a headed desktop window; the project memory's 600 px limit applies to the browser window, not Playwright viewports).

### Pitfall 3: Lazy rendering vs data readiness vs seq guards
`renderDashV2Widgets` uses `_dashV2Seq` to discard stale async Chart.js loads (L8492+). Lazy/section-gated rendering must take part in the same sequence guard, else a late-opened section renders against a replaced model. Also `rerenderDashV2Widget` reads `_dashV2Model` (current), which is the correct source; filters changing while a section is closed must mark it dirty so first open renders with the *current* filters.

### Pitfall 4: Chart.js loads only when needed, but `chartState` 'pending' text
Phase 95 shows `Loading charts...` text while Chart.js loads. Table-view widgets must not wait for it (UI-SPEC). `runDashV2Widget` passes `chartState`; check each `renderDashV2*` honours `view==='table'` before consulting `chartState`.

### Pitfall 5: Cache hydration races the 5-minute auto-refresh and `_dashLoadTime`
`eagerLoad` sets `_dashLoadTime`; tab-switch logic compares `now - _dashLoadTime > CACHE_TTL_LONG` (L6045). When hydrating from cache, **do not set `_dashLoadTime`** (or the dashboard will treat cached data as fresh and skip the real refresh).

### Pitfall 6: Lighthouse measures a different thing than the iPad
The mocked admin-proxy is instant, so Lighthouse mostly measures bundle parse/execute and render work. That is acceptable (D-06) but means TTI numbers are optimistic; record this in the harness README. Keep fixture size realistic (rows count similar to prod) or the score is meaningless. Use Lighthouse's default mobile throttling (simulated 4x CPU slowdown, slow 4G) and run >= 3 times, take the median (variance is large).

### Pitfall 7: Google GSI, fonts and network in the harness
`https://accounts.google.com/gsi/client` and Google Fonts are third-party loads that vary run to run. Route-fulfil them with empty/stub responses (GSI stub must define `window.google.accounts.oauth2.initTokenClient`, since `gsiInitTokenClient` in js/lib/auth.js calls it and `checkAuthorization` is the auth path; verify the real flow: seeded `sv-brewpad-session` with `expires_at` far in the future takes the "fast path" -> `checkAuthorization` -> hits `admin-proxy` or another middleware endpoint; route-mock that too). Read `checkAuthorization` (js/brewpad.js, near L4560-4680) before writing the stub; this was not fully read in this research. **Planner: Wave 1 task = reconnaissance of the exact auth request(s) and GSI stub shape.** The score should be reported both with fonts blocked (deterministic) and optionally noted separately.

### Pitfall 8: `build` restamp noise and tests that read the bundle
CLAUDE.md: run `npm run build`; revert restamp noise before commit. Run both Jest suites and lint before every commit.

## Code Examples

### Same-day cache gate (pure, testable)
```javascript
// Pure; ES5. Returns the cached payload only if it is from today (Vancouver) and for this user.
function dashCacheUsable(entry, todayYmd, email) {
  if (!entry || entry.v !== 1) return null;
  if (entry.day !== todayYmd) return null;            // D-08
  if (entry.email && email && entry.email !== email) return null;
  return entry;
}
```

### Playwright mock for the harness (no production seam)
```javascript
// Source: Playwright API (page.route / context.addInitScript) [CITED: playwright.dev/docs/network]
await context.addInitScript(function (session) {
  localStorage.setItem('sv-brewpad-session', JSON.stringify(session));
  localStorage.setItem('sv_session_token', 'harness');
}, { email: 'harness@example.test', token: 'x', expires_at: Date.now() + 8 * 3600 * 1000, login_at: Date.now() });
await context.route('**/api/batch/admin-proxy', function (route) {
  var body = JSON.parse(route.request().postData() || '{}');
  var data = fixture[body.action];
  route.fulfill({ status: data ? 200 : 404, contentType: 'application/json',
    body: JSON.stringify(data || { ok: false, error: 'no fixture for ' + body.action }) });
});
await context.route(/accounts\.google\.com|fonts\.(googleapis|gstatic)\.com/, function (r) { r.abort(); });
```
Fixture format: each `adminApiGet` result is `{ ok: true, data: ... }` (see `dashAggregateFromStats(r)` reading `r.data`). Needed actions: `get_dashboard_stats`, `get_batches`, `get_vessels`, `get_ferm_schedules`, `get_tasks_upcoming`, `get_tasks_calendar`, `get_waitlist`; plus the auth check. Record by running the real page on staging signed in and capturing responses (owner session), then anonymize (names/emails/phones), keep ids/dates/counts.

### Lighthouse against the Playwright-launched Chrome
```javascript
// Source: Lighthouse Node API [CITED: github.com/GoogleChrome/lighthouse/blob/main/docs/readme.md#using-programmatically; confirm in Context7]
const lh = await import('lighthouse');           // ESM in v12/13
const result = await lh.default(url, { port, output: 'json', onlyCategories: ['performance', 'accessibility'], formFactor: 'mobile', screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } });
// gate: result.lhr.categories.performance.score >= 0.85 ; log result.lhr.audits.interactive.numericValue
```
Note: repo is CommonJS (`require` used in playwright.config.js); use dynamic `import()` or an `.mjs` script.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Lighthouse "Time to Interactive" as headline | TTI was removed from the Lighthouse performance score (v10, 2023) but the `interactive` audit still reports a value | Lighthouse 10 [ASSUMED: training knowledge] | The handoff "interactive < 1.5 s / 3 s" can still be read from `audits.interactive` / TBT / LCP; score is driven by LCP, TBT, CLS, FCP, Speed Index |
| `mousemove` hover tooltips | Pointer events; Chart.js `external` tooltips | Chart.js 3+/4 | Touch needs explicit handling |

**Deprecated/outdated:** none relevant.

## Baseline (measured 2026-11-06 from the working tree)

| Item | Value |
|------|-------|
| brewpad.html head scripts (blocking) | 12 `<script src>`: constants, utils, auth, recipe-grouping, recipe-picker, sheets-config, admin-config, **qrcode.min.js (20,433 B / 7,329 gz)**, **jspdf.umd.min.js (365,730 B / 115,595 gz)**, gsi (async), brewpad.min.js. Plus Google Fonts CSS (render-blocking) |
| brewpad.min.js | 414,832 B / 110,944 B gz (source brewpad.js 812,612 B) |
| brewpad.min.css | 71,184 B / 12,299 B gz |
| Chart.js (lazy) | 208,522 B / 70,523 B gz, loaded on first v2 render |
| Small libs (sync) | constants 1.5, utils 0.5, auth 1.2, recipe-grouping 2.7, recipe-picker 0.9, sheets-config 2.2, admin-config 0.5 KB gz (about 9.6 KB gz) |
| Critical-path JS gz at cold load today | about 111 + 116 + 7 + 10 = about 244 KB gz before Chart.js; after moving jsPDF/qrcode about 121 KB gz; Chart.js adds 70 KB gz when charts render |
| API calls at boot | 5 parallel (`get_dashboard_stats`, `get_batches`, `get_vessels`, `get_ferm_schedules`, `get_tasks_upcoming`) via POST `/api/batch/admin-proxy` + packaging calendar adds `get_tasks_calendar`, `get_waitlist` + `/content/zoho-snapshot.json` for the v1 Wine Breakdown (v1 only) + auth check |
| Breakpoints in brewpad.css | 480, 560, 600 (filters, widget controls, stat-row), 720, 768 (grid 2-col, section head flex, g4 split), 900/orientation (shell) |
| Auto-refresh | 5 min `setInterval` -> `loadDashboard()` (aggregate + upcoming) |
| Flag read | `dashV2FlagFrom` L1420; `initDashV2Flag` L7239; `setDashV2` L7281; label L7279 |
| Existing reduced-motion | skeleton shimmer, accordion; `chart()` uses `animation:false` when `reduced` |
| Existing tests | 23 files `tests/frontend/brewpad-dashboard-v2-*.test.js`; no Lighthouse/axe anywhere; no `tests/perf` |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Loading jsPDF/QR asynchronously on click could trip iPad Safari popup blocking for `window.open`; idle-preload mitigates | Pattern 4 | Print/label button breaks on iPad; verify on device |
| A2 | `IntersectionObserver` available on the shop iPad Safari (fallback to render-all exists) | Don't Hand-Roll | Low; fallback specified |
| A3 | Chart.js 4 `pointStyle` values and `external` tooltip API as described | Patterns 6, 7 | Medium; confirm with Context7 (`ctx7`) before implementing |
| A4 | Lighthouse 10+ removed TTI from the score but keeps the `interactive` audit | State of the Art | Low; handoff numbers read from LH output anyway |
| A5 | localStorage can hold the `get_dashboard_stats` payload (size unmeasured; no real fixture yet) | Pattern 3 | If >~1 MB, trim cache or use sessionStorage |
| A6 | Download/age figures for lighthouse, axe, chrome-launcher | Legitimacy audit | None (slopcheck [OK]) |
| A7 | Route-mocking plus seeded localStorage session is sufficient to pass `checkAuthorization` (auth path not fully read) | Pitfall 7 | Harness needs a GSI/auth stub; Wave 1 reconnaissance |

## Open Questions (RESOLVED)

1. **Can Lighthouse attach to the Playwright-launched Chromium (so `page.route` mocks apply)?**
   - Known: Lighthouse accepts a `port` of a running Chrome with remote debugging; Playwright can launch Chromium with `--remote-debugging-port`. Lighthouse opens its own tab/session and may **not** inherit the Playwright context's routes if it navigates in a new target.
   - Unclear: whether context-level `route` interception applies to Lighthouse's navigation. 
   - Recommendation: Wave 1 prototype. Fallback that is certain to work: a small local Node static+mock server (serves the repo and answers `POST /api/batch/admin-proxy` itself) and set the middleware base URL via the harness page's `SHEETS_CONFIG.MIDDLEWARE_URL`. That requires replacing `js/sheets-config.js` content at serve time (the mock server can rewrite that one response; still no shipped seam). Prefer the mock-server approach if the port-attach prototype fails.
   - **RESOLVED (99-01 Task 1):** local mock server (serve-time rewrite of sheets-config.js + injected seed), not Playwright port-attach.
2. **Exact auth request(s) and GSI behaviour for the seeded session** (A7) - read `checkAuthorization`/`gsiInitTokenClient` first.
   - **RESOLVED (99-01 Task 1):** auth-path recon is the first step of the harness task; boot requests are listed in tests/perf/README.md.
3. **Fixture capture:** the owner's signed-in staging session is needed to record real responses (Cloudflare Access on staging). Alternatively synthesize a fixture from the middleware's DB test seeds; real shape is safer. Needs owner involvement or a documented synthetic generator.
   - **RESOLVED (99-01 Tasks 2-3):** owner-assisted read-only staging capture, or a synthetic fixture if the owner declines; anonymized before commit.
4. **Which of `g10`/`t3` need a Table view** - g10 may be a list; confirm in Wave 1 via the registry test (Pattern 5).
   - **RESOLVED (99-06 Task 1):** registry coverage test classifies each widget; t3 gets a Table view, g10 gets one only if it draws a canvas.
5. **Is Lighthouse >= 85 reachable?** Unknown until the baseline run; the heavy-script move plus lazy charts are the expected levers. If it stays below 85 because of the 415 KB bundle, a bundle split is a larger task that the planner should size after the baseline.
   - **RESOLVED (99-07):** final gate run; if < 85 the owner chooses gap-closure plan (e.g. bundle split) or accept, recorded in 99-PERF-LOG.md.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | harness, build | yes | 20.20.2 default; 24.21.0 and 20.17.0 in nvm; project engines 24.x | Use Node 24 for Lighthouse 13, or Lighthouse 12.8.2 on Node 20 |
| Google Chrome | Lighthouse | yes | /Applications/Google Chrome.app (version not queried) | Playwright Chromium |
| Playwright | harness | yes (devDep ^1.58.2) | - | - |
| lighthouse / axe / chrome-launcher | harness | no (not installed; install attempt reverted) | 13.6.0 / 4.14.0 / 1.2.3 on registry | - |
| ctx7 / Context7 | API doc confirmation | not checked | - | WebFetch official docs |
| gemini CLI | - | broken (project memory) | - | grep + Read (used) |

**Missing with no fallback:** none. CI for the harness is out of scope; it is a local repeatable script (D-06).

## Security Domain

`security_enforcement` is enabled in config; the phase is client-side only.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | partly | Harness must not weaken the real auth gate: seeded session lives only in test-time `addInitScript`; no shipped bypass |
| V3 Session Management | yes | Dashboard cache cleared on sign-out/session end and keyed to the user's email |
| V4 Access Control | no | No server changes |
| V5 Input Validation | yes | Cache JSON parsed in try/catch with version/shape check; hint/section copy built with `escapeHTML`; tooltip HTML via `textContent`, not string concat of data |
| V6 Cryptography | no | None |
| V8 Data Protection | yes | Anonymized fixture committed (no names/emails/phones); cache holds only what the dashboard already displays |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS via data in new HTML tooltip/table | Tampering | `escapeHTML` / `textContent` (existing helper) |
| Customer PII persisted in localStorage after logout | Info disclosure | Clear cache in sign-out and `_enterLoggedOutState`; same-user check; same-day expiry |
| Auth/mocking path left enabled in prod | Elevation | No seam in shipped JS; harness lives under tests/ or scripts/ only |
| Committed fixture contains real customer data | Info disclosure | Anonymization script + a test that greps the fixture for `@` patterns and phone-like strings |
| CSP | - | brewpad.html has **no CSP meta** (grep confirmed: none); no new external domains are introduced; self-hosted scripts only. Re-grep before touching any `<script>` tag |

## Project Constraints (from CLAUDE.md)

- Frontend is ES5 (no arrow functions, let/const, template literals) - applies to everything added to `js/brewpad.js`.
- Never edit `js/main.js`, `js/*.min.js`; edit `js/modules/` or the source file and run `npm run build`. (brewpad.js is its own source; its `.min.js` is the artifact.)
- Before every commit: `npm test`, `cd zoho-middleware && npm test`, `npm run lint`.
- Bug fix -> regression test first; one logical change per commit.
- Read existing code and tests first; grep usages before modifying any function; after changing shared utilities run the full suites.
- **Do NOT modify existing tests** unless explicitly asked: add new test files for Phase 99; do not change the `dashV2FlagFrom` contract.
- CSP: every public HTML page has one, but brewpad.html has none (Phase 95 note, re-verified); adding an external resource would need explicit thought. No new external resources this phase.
- ALL changes go to staging first; production push needs staging approval. Global instructions: gemini CLI is broken, use grep + Read.

## Sources

### Primary (HIGH confidence, read from the repo 2026-11-06)
- `brewpad.html` L17-27 (scripts), `js/brewpad.js` L1420, 3340-3500, 3600-3625, 4377-4560, 4675-4760, 4864-4915, 7058-7300, 7425-7520, 8385-8500, 8738-8900, 9652-9680, 9760-9773, 12721-12790, 17442, 17584; `css/brewpad.css` L100, 378-390, 3105-3260; `playwright.config.js`; `package.json`; `.planning/config.json` (nyquist_validation false; security_enforcement true)
- npm registry: lighthouse 13.6.0 / 12.8.2 engines; @axe-core/playwright 4.14.0; chrome-launcher 1.2.3
- Contrast computed from tokens in css/brewpad.css (#9a8672 on #faf8f2 = 3.28:1; #7a6654 on #f5f1e6 = 4.83:1; #7a6654 on #e8e2ca = 4.19:1 FAILS; #6b5442 passes everywhere)

### Secondary / Tertiary (not fetched this session)
- Chart.js `pointStyle` and external tooltip docs, Lighthouse programmatic API docs, Playwright network docs: cited from training knowledge, tagged [ASSUMED]/[CITED] above; confirm via Context7 during planning.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH for in-repo pieces; MEDIUM for harness tooling (versions verified, integration untested)
- Architecture: HIGH (code read); the exact auth stub for the harness is the main gap (A7)
- Pitfalls: HIGH for items 1-5 (derived from the code); MEDIUM for harness pitfalls

Contrast finding to carry to planning: `--ink-muted` (#7a6654) fails 4.5:1 on `--cellar-canvas` (4.19) and passes on raised/surface; `--ink-tertiary` fails everywhere for text. Switch failing text to `--ink-secondary` (6.65/6.26/5.44), as UI-SPEC says; let axe confirm which ones are real.

**Nyquist validation:** disabled in config (`workflow.nyquist_validation: false`), so no Validation Architecture section. Test approach is in "Implementation Notes" of 99-UI-SPEC.md (jsdom tests for pure helpers, CSS-reading tests, harness run for Lighthouse/axe/360 px).

**Research date:** 2026-11-06
**Valid until:** about 14 days (the dashboard code moves quickly: line numbers drift; re-grep symbol names)

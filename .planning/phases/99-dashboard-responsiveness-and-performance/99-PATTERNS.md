# Phase 99: Dashboard responsiveness and performance - Pattern Map

**Mapped:** 2026-11-06
**Files analyzed:** 14 new/modified
**Analogs found:** 12 / 14 (2 have no in-repo analog: Lighthouse harness, fixture anonymizer)

Line numbers are from the tree on 2026-11-06 and drift fast; re-grep the symbol names. `js/brewpad.js` is its own source (edit it, then `npm run build`; never edit `js/brewpad.min.js` or `css/*.min.css`). All frontend code is ES5 (no arrows, let/const, template literals). Existing tests must not be modified (CLAUDE.md rule 10): add new test files.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `js/brewpad.js` pure helpers (`dashV2DefaultFlagFrom`, `dashCacheUsable`, `dashPointStyleFor`, `dashTouchTapAction`, `dashV2SlotShouldRender`) | utility | transform | `dashV2FlagFrom` (L1420), `dashViewToggleHtml` (L1776) | exact |
| `js/brewpad.js` `initDashV2Flag` / `setDashV2` / `syncDashSwitch` (default flip) | provider (flag) | request-response (localStorage) | itself (L7238-7292) | exact |
| `js/brewpad.js` `eagerLoad` + cache read/write + clear on sign-out | service | CRUD (localStorage) | `eagerLoad` (L7058), batch-detail `saver` sessionStorage (L4771-4785) | role-match |
| `js/brewpad.js` section collapse + gated widget render | component | event-driven | `onDashV2Accordion` (L8374), `runDashV2Widget` (L8462), `dashV2SectionsHtml` (L8753) | role-match |
| `js/brewpad.js` `chart()` point styles + touch tooltip | component | event-driven | `chart()` (L3366-3425, L3598-3625) | exact |
| `js/brewpad.js` `loadScriptOnce` (jsPDF/qrcode) | utility | file-I/O (script load) | `loadChartJs()` (L3340) | exact |
| `js/brewpad.js` packaging calendar table view (t3), g10 audit | component | transform | `dashTableHtml` (L1780), bc per-curve toggle | role-match |
| `css/brewpad.css` grid, sections, skeletons, focus, contrast | config (styles) | n/a | `.bp-dash-grid` block (L3112, L3208), skeleton (L378) | exact |
| `brewpad.html` script tags | config | n/a | itself (L17-27) | exact |
| `tests/frontend/brewpad-dashboard-v2-*-99.test.js` (new, jsdom) | test | request-response | `brewpad-dashboard-v2-attention.test.js`, `-shell.test.js` | exact |
| CSS-reading test (focus rules, grid) | test | file-I/O | `brewpad-dashboard-v2-attention.test.js` L364 | exact |
| `tests/perf/` (or `scripts/perf/`) Lighthouse + axe runner | utility (dev tool) | request-response | `playwright.config.js`, `tests/e2e/*.spec.js` | partial |
| anonymized dashboard fixture + anonymizer + PII-grep test | utility / test | batch/transform | none | none |
| `.planning/todos/pending/remove-v1-dashboard-code.md` | docs | n/a | already exists (D-04) | exact |

## Pattern Assignments

### Pure helpers in `js/brewpad.js` (utility, transform)

**Analog:** `dashV2FlagFrom`, `js/brewpad.js` 1420-1425. Top-level (outside the IIFE), pure, exported from the bottom `module.exports` block (L17514+, e.g. `dashV2FlagFrom: dashV2FlagFrom,` at L17584).
```javascript
function dashV2FlagFrom(search, hash, storedFlag) {
  var q = String(search || '');
  if (/[?&]dash=v2(&|$)/.test(q) || parseDashHash(hash).dash === 'v2') return { on: true, persist: '1' };
  if (/[?&]dash=v1(&|$)/.test(q)) return { on: false, persist: '0' };
  return { on: storedFlag === '1', persist: null };
}
```
**Do not change this 3-arg contract**; locked tests at `tests/frontend/brewpad-dashboard-v2-filters.test.js:132-136` assert it (`('', '', null)` -> `{on:false}`). Add a NEW function (e.g. `dashV2DefaultFlagFrom(search, hash, storedFlag, migrated)`) per RESEARCH Pattern 8 and export it next to line 17584. For `dashCacheUsable(entry, todayYmd, email)` copy the RESEARCH "Same-day cache gate" example. For other pure helpers follow `dashViewToggleHtml` (L1776) style: small, string/plain-object in and out, no DOM.

---

### `initDashV2Flag` / `setDashV2` / `syncDashSwitch` (default flip, D-01..D-03)

**Analog:** itself, `js/brewpad.js` 7238-7292 (inside the IIFE).
```javascript
function initDashV2Flag() {
  var stored = null;
  try { stored = localStorage.getItem('bp_dash_v2'); } catch (e) { stored = null; }
  var f = dashV2FlagFrom(location.search, location.hash, stored);
  _dashV2On = f.on === true;
  if (f.persist !== null) {
    try { localStorage.setItem('bp_dash_v2', f.persist); } catch (e2) { /* private mode */ }
  }
  _dashV2State = readDashFiltersFromEnv();
}
...
btn.textContent = isDashV2() ? 'Back to classic dashboard' : 'Try new dashboard';   // syncDashSwitch, L7279
```
Change: read the new marker key (e.g. `bp_dash_default_v2`) alongside `bp_dash_v2`, call the new pure function, and set the marker in a try/catch after first run. Keep it synchronous (runs at IIFE boot, before sign-in). Relabel to `Classic dashboard` per UI-SPEC. `stripDashFromUrl` (L7252) already removes `dash` params. `_initDashV2FlagForTest` is the existing seam tests use.

---

### Cached-first render in `eagerLoad` / `loadDashboard` (service, localStorage CRUD)

**Analog 1:** `eagerLoad`, L7058-7090 (the seam; five parallel `settle(adminApiGet(...))` calls, then assigns `_dashData`, `_dashSummary`, `_dashLoadTime`). Skeleton injection today:
```javascript
var dashInner = document.getElementById('bp-dashboard-inner');
if (dashInner && !document.getElementById('bp-dash-v2')) dashInner.innerHTML = '<div class="bp-skeleton-block"></div><div class="bp-skeleton-block" style="height:120px;margin-top:12px;"></div>';
```
Replace with layout-matching skeletons with explicit heights (CLS). Hydrate `_dashData`, `_fermSchedules`, `_upcomingTasks` from cache before this, call `renderDashboard()`, and **do not set `_dashLoadTime`** (RESEARCH Pitfall 5).

**Analog 2 (storage try/catch pattern):** `js/brewpad.js` 4771-4785 sessionStorage `saver`:
```javascript
try {
  var data = saver.save();
  if (data) { sessionStorage.setItem(saver.key, JSON.stringify(data)); }
} catch (e) {}
...
var raw = sessionStorage.getItem(saver.key);
```
Wrap all cache get/set in try/catch, JSON.parse guarded, shape-check `v === 1`. Same-day check uses Vancouver date: note `dashV2TodayDate()` (L9377) is `(_dashData && _dashData.asOf && _dashData.asOf.today) || todayPacific()`; for the cache gate compare against `todayPacific()` directly, because `_dashData` is not loaded yet at hydration time.

**Clear on sign-out (security):** add a cache-clear call in `bpSignOut` (L4752, after `clearSession();`) and `_enterLoggedOutState` (L4797, after `clearSession();`). Store `email` in the entry and reject on mismatch.

---

### Section collapse + gated widget rendering (component, event-driven)

**Analog:** `runDashV2Widget`, L8462-8474 (single choke point) and `rerenderDashV2Widget`, L8480.
```javascript
function runDashV2Widget(def, model, chartState) {
  if (!document.getElementById(def.slot)) return;
  dashV2DrillReset(def.key);
  try {
    if (dashV2WidgetMissing(def)) { dashV2Msg(...); return; }
    def.render(model, chartState);
  } catch (e) { dashV2Msg(def.slot, def.chart || def.key, def.title, DASH_V2_FAILED); }
}
function rerenderDashV2Widget(w) {
  var model = _dashV2Model;
  if (!model) return;
  for (var i = 0; i < DASH_V2_WIDGETS.length; i++) {
    if (DASH_V2_WIDGETS[i].key === w) { runDashV2Widget(DASH_V2_WIDGETS[i], model, window.Chart ? 'ready' : _dashV2ChartState); return; }
  }
}
```
Insert the `dashV2SlotShouldRender(def)` predicate before `def.render`. Mark skipped widgets dirty so first open renders against the current `_dashV2Model`. Keep `_dashV2Seq` guard in `renderDashV2Widgets` (L8488-8508) so late loads do not render against a replaced model:
```javascript
var seq = ++_dashV2Seq;
if (window.Chart) { _dashV2ChartState = 'ready'; renderDashV2AllWidgets(model, 'ready'); return; }
_dashV2ChartState = 'pending';
renderDashV2AllWidgets(model, 'pending');
loadChartJs().then(function () {
  if (seq !== _dashV2Seq || !isDashV2()) return;
  ...
```
Table-view widgets must not wait on `chartState`.

**Section header markup:** `dashV2SectionsHtml`, L8753-8767 (emits `<section class="bp-dash-section" data-dash-sec=...><div class="bp-dash-section-head"><h2 class="bp-dash-section-title">`). Convert head to a `<button aria-expanded>` only below 768 px. `DASH_V2_SECTIONS` (L8741) and its `[slotId, full]` flags are the source of grid span; keep existing flags (RESEARCH Pattern 1). Keep `today` section always open.

**Toggle/click wiring analog:** `onDashV2Accordion` (L8374-8387) and the delegated handler dispatch at L8586 (`if ((el = t.closest('[data-dash-acc]'))) { onDashV2Accordion(el); return; }`). Add `data-dash-sec-toggle` handling in the same `onDashV2Click` chain; persist expand state in `_dashV2Expanded`, and restore focus after rerender (`again.focus()`).

**Media-query listener analog:** `bindDashV2ModeListener`, L7306-7316 (bound once; `addEventListener` with `addListener` fallback for old iPad Safari):
```javascript
var mq = window.matchMedia('(max-width: 600px)');
if (mq.addEventListener) mq.addEventListener('change', onDashV2ModeChange);
else if (mq.addListener) mq.addListener(onDashV2ModeChange);
```
Copy with a separate `(max-width: 767px)` query for sections (filters stay at 600). Phone-order shell: `renderDashboardV2` builds `#bp-dash-v2` with filters, range, `#bp-dash-v2-tiles`, then sections (L8780-8800); apply CSS `order` rather than moving nodes.

**IntersectionObserver:** no existing use in repo (grep before writing); feature-detect and fall back to render-all.

---

### `chart()` point styles and touch tooltip (component, event-driven)

**Analog:** `chart()` in `js/brewpad.js` L3366. Line series options are copied per-series here (L3412-3421):
```javascript
if (cfg.type === 'line') {
  ds.borderColor = series[i].colour;
  ds.borderWidth = 2;
  if (series[i].borderDash) ds.borderDash = series[i].borderDash;
  if (series[i].pointRadius !== undefined) ds.pointRadius = series[i].pointRadius;
  ...
}
```
Add `pointStyle` / `pointHitRadius` / point colours here from the pure `dashPointStyleFor(key, index)`; mirror the glyph in the HTML legend (find `bp-chart-legend` usages). Existing locked tests expect current dataset shapes: make additions opt-in or additive.

**Click-through to modify (L3598-3625):**
```javascript
if (typeof cfg.onClick === 'function') {
  options.onClick = function (evt, elements, chartInst) {
    var inst = chartInst || Chart.getChart(canvas);
    ...
    var hit = inst.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
    if (hit && hit.length) { ... cfg.onClick(payload); return; }
    var col = inst.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
    ...
  };
  canvas.style.cursor = 'pointer';
}
```
On `evt.native.pointerType === 'touch'` (or `(pointer: coarse)`), route through pure `dashTouchTapAction(prev, next, tooltipOpen)` -> `'show'|'drill'|'hide'`; mouse path unchanged. Tooltip button built with `textContent`, not string concat of data. Add `touch-action: pan-y` to `.bp-chart canvas` in CSS. Chart.js `external` tooltip API is [ASSUMED]; confirm in docs before coding.

---

### `loadScriptOnce` for jsPDF / qrcode (utility, file-I/O)

**Analog:** `loadChartJs()`, L3340-3364 (copy shape: cached promise, `onerror` resets and removes node).
```javascript
function loadChartJs() {
  if (typeof window !== 'undefined' && window.Chart) return Promise.resolve(window.Chart);
  if (_chartJsPromise) return _chartJsPromise;
  _chartJsPromise = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = CHART_JS_SRC; s.async = true;
    s.onload = function () { ... resolve(window.Chart) ... };
    s.onerror = function () { _chartJsPromise = null; if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('Chart.js failed to load')); };
    document.head.appendChild(s);
  });
  return _chartJsPromise;
}
```
**Call sites to guard:** `openBatchQR` (L12721: `if (typeof qrcode === 'undefined') { showToast('QR library not loaded', 'error'); return; }` then `window.open('', '_blank')`) and `generateBatchLabelPDF` (L12737: `if (typeof window.jspdf === 'undefined') { showToast('PDF library not loaded', 'error'); return; }`, plus `qrcode` use at ~L12784). `openBatchQR` calls `window.open` synchronously: an async load first risks Safari popup blocking (RESEARCH A1). Recommended: idle-preload after first dashboard paint, loader as fallback. Then remove the two tags from `brewpad.html`.

---

### `brewpad.html` (config)

**Analog:** itself, L17-27 (head scripts; sync order matters):
```html
<script src="js/vendor/qrcode.min.js"></script>
<script src="js/vendor/jspdf.umd.min.js"></script>
<script src="https://accounts.google.com/gsi/client" async></script>
<script src="js/brewpad.min.js?v=mw494mhp"></script>
```
Remove the qrcode/jspdf lines only. Do not add `defer` to `brewpad.min.js` without proof (init order). No CSP meta exists here; add no new external origins. `?v=` stamps are restamp noise from `npm run build`: revert before commit.

---

### `css/brewpad.css` (styles)

**Grid analog:** `.bp-dash-grid` L3112 and the 768 px media block ~L3208:
```css
.bp-dash-grid { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
.bp-dash-full { grid-column: 1 / -1; }
@media (min-width: 768px) {
  .bp-dash-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bp-dash-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .bp-g4 { grid-template-columns: 3fr 2fr; }
}
```
Add a `@media (min-width: 1200px)` 3-column rule after it, plus `.bp-dash-grid > * { min-width: 0; }`, `.bp-chart { overflow: hidden }`. `.bp-table-wrap` already has `overflow: auto` (L3126).

**Skeleton analog:** L378-390 (`.bp-skeleton-block` 56 px, `bpSkeleton` shimmer, reduced-motion override sets `animation: none; background: var(--cellar-surface)`). Add variants with explicit heights; keep the reduced-motion rule.

**Focus fix:** global rule at L100 `*:focus-visible { outline: 2px solid var(--stain); outline-offset: 2px; }`. These override it with the faint token `--ledger-focus` (L32, rgba 0.35) and need `var(--stain)` instead: L579, 604, 3105, 3131, 3137 (offset -2px, keep), 3145, 3175, 3205, 3255; plus input `border-color: var(--ledger-focus)` at L2360, L2388. Example current line:
```css
.bp-text-btn:focus-visible { outline: 2px solid var(--ledger-focus); outline-offset: 2px; }
```
**Contrast:** switch failing text tokens (`--ink-muted` on `--cellar-canvas` 4.19, `--ink-tertiary`) to `--ink-secondary` per UI-SPEC; let axe confirm. Tokens only, no hex literals (98-PATTERNS CSS rule). Chip/tint contrast decisions from Phase 98 (`.bp-attn-chip--warn` uses `--ink-primary` text) stand.

---

### New jsdom tests `tests/frontend/brewpad-dashboard-v2-*-99.test.js`

**Analog:** `tests/frontend/brewpad-dashboard-v2-shell.test.js` L1-40 and `-attention.test.js` L1-30. Copy preamble verbatim:
```javascript
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn(function () {
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: {} }); } });
});
var _ssData = {};
global.sessionStorage = { getItem: ..., setItem: ..., removeItem: ..., clear: ... };
var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;
var bp = require('../../js/brewpad');
var TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
var ASOF = { today: TODAY, year: YEAR, tz: 'America/Vancouver' };
function flush() { return new Promise(function (r) { setTimeout(r, 0); }); }
```
Real jsdom `window.localStorage` is used directly (shell test L8: `function ls(k)`). Seeding and render seams: `bp._initDashV2FlagForTest()`, `bp._renderDashboardForTest()`, `bp._clearDashDrillForTest()`, `bp._dashV2FrameForTest` (`widgets`, `opts`, `expanded`, `drillAdd`, exported ~L17440). Cleanup: `bp._clearDashDrillForTest(); delete window.Chart;`.

**Coverage test:** iterate `bp._dashV2FrameForTest.widgets` (`DASH_V2_WIDGETS`) and classify chart vs list (t0/t1/t2 lists; g1-g9 have `dashViewToggleHtml`; bc has `data-bc-view`; verify g10 and t3).

**CSS-reading test analog:** `brewpad-dashboard-v2-attention.test.js` L364: `var css = fs.readFileSync(path.join(__dirname, '../../css/brewpad.css'), 'utf8');` Use it to assert no v2 `:focus-visible` rule uses `--ledger-focus` or `outline: none`, and the 1200 px grid rule exists.

**Flag tests:** new file; model on `brewpad-dashboard-v2-filters.test.js` L132-136 (`expect(bp.dashV2FlagFrom('?dash=v2','',null)).toEqual({ on: true, persist: '1' })`) for the new function including one-time-migration cases. Add a late-evening PT boundary case for the same-day cache gate.

---

### `tests/perf/` Lighthouse + axe runner (dev tool)

**Partial analog:** `playwright.config.js` (CommonJS; `baseURL` defaults to staging, so the harness must not use `testDir: ./tests/e2e` defaults or the staging baseURL) and `tests/e2e/*.spec.js`. Repo is CommonJS: use an `.mjs` script or dynamic `import('lighthouse')`. Use the RESEARCH snippets (route mock for `**/api/batch/admin-proxy`, `addInitScript` seeded `sv-brewpad-session`, route-abort GSI and Google fonts). Fixture shape is `{ ok: true, data: ... }` per action. Wave 1 recon: read `checkAuthorization` (~L4560-4680) and `gsiInitTokenClient` in `js/lib/auth.js`; confirm Lighthouse can attach to the Playwright Chromium via `--remote-debugging-port` (RESEARCH Open Question 1), else use a local Node static+mock server. No test flag in shipped JS. Run under Node 24 for lighthouse 13, or pin lighthouse 12.8.2. Add devDependencies deliberately (`lighthouse`, `@axe-core/playwright`, `chrome-launcher`). 360 px overflow check: Playwright `page.setViewportSize` and assert `document.documentElement.scrollWidth <= 360`.

## Shared Patterns

### Escape all dynamic strings
**Source:** `escapeHTML` usage throughout, e.g. `dashV2SectionsHtml` L8757 `escapeHTML(sec.title)` and `dashTableHtml` L1780+.
**Apply to:** section headers, hint text, tooltip, new t3 table. Tooltip DOM: `textContent`.

### localStorage/sessionStorage in try/catch
**Source:** `initDashV2Flag` L7240-7246, `setDashV2` L7283 (`/* private mode */`).
**Apply to:** flag marker, dashboard cache.

### Delegated click handling
**Source:** `onDashV2Click` chain (L8585+) bound on `#bp-dash-v2` shell in `renderDashboardV2` (`shell.addEventListener('click', onDashV2Click)` etc., L8788-8791).
**Apply to:** section toggles, tooltip action button, hint. Update in place; never rebuild the shell on refresh.

### Table view via `dashTableHtml` and `dashViewToggleHtml`
**Source:** L1776-1800; model builders `dashV2TableModel`.
**Apply to:** t3 packaging calendar (Date | Batch | Task | Type), any chart missing a toggle.

### Build artifacts
**Apply to:** every JS/CSS task. Edit `js/brewpad.js` / `css/brewpad.css` / `brewpad.html`, run `npm run build`, revert `?v=` restamp noise, run `npm test`, `cd zoho-middleware && npm test`, `npm run lint` before commit.

### Neutral copy
**Source:** 98-PATTERNS "Neutral copy and banned words" and 99-UI-SPEC Copywriting Contract. Do not use the word "stale" in the as-of hint.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `tests/perf/*` Lighthouse + axe runner | dev tool | request-response | No Lighthouse/axe/perf code exists in repo; use RESEARCH snippets |
| anonymized fixture + anonymizer script + PII-grep test | utility/test | batch/transform | No recorded-fixture precedent; capture needs owner staging session or synthetic generator (RESEARCH Open Question 3) |
| IntersectionObserver viewport gating | component | event-driven | No existing observer in `js/brewpad.js`; feature-detect with render-all fallback |
| Chart.js `external` tooltip | component | event-driven | `chart()` uses built-in tooltips only; confirm API from Chart.js docs |

## Metadata

**Analog search scope:** `js/brewpad.js`, `css/brewpad.css`, `brewpad.html`, `tests/frontend/brewpad-dashboard-v2-*`, `playwright.config.js`, prior PATTERNS 94-98
**Files scanned:** about 12 read or grepped
**Pattern extraction date:** 2026-11-06

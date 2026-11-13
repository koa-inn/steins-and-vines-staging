# Phase 99 Perf Log

Local harness (`npm run perf`, Node 24, Lighthouse mobile simulated throttling, mock server on 127.0.0.1,
anonymized staging capture of 2026-11-12). Lab numbers, no Railway latency, fonts blocked (see tests/perf/README.md).

| Date | Commit | Plan | LH mobile perf (median of 3 cold) | a11y | Interactive cold (ms) | Interactive warm (ms) | LCP (ms) | TBT (ms) | CLS | axe serious+critical (desktop / tablet / phone) | scrollWidth @360 / @320 | Notes |
|------|--------|------|-----|-----|-----|-----|-----|-----|-----|-----|-----|-----|
| 2026-11-12 | ec2ad073 (phase start) | baseline | 0.60 | 0.91 | 14258 | 7804 | 14258 | 52 | 0.045 | 2 / 2 / 2 rules (color-contrast 6/9/5 nodes, label 5 nodes each) | 360 / 320 (no overflow) | warm perf 0.76; desktop perf 0.84; FCP 5856 ms; 0 fixture misses; 0 external requests |
| 2026-11-12 | ae992c99 (current tree, harness added) | 99-01 | 0.60 | 0.91 | 14114 | 7805 | 14114 | 54 | 0.045 | 2 / 2 / 2 rules (color-contrast 6/9/5 nodes, label 5 nodes each) | 360 / 320 (no overflow) | warm perf 0.75; desktop perf 0.86; FCP 5857 ms; identical to baseline within run noise (no JS/CSS change in this plan) |
| 2026-11-13 | a12d8d05 | 99-03 | 0.66 | 0.90 | 9012 | 6005 | 9012 | 0 | 0 | 2 / 2 / 2 rules (color-contrast 6/9/8 nodes, label 5 nodes each); expanded phone 2 rules (5/5) | 360 / 320 (no overflow) | FCP 3904 ms (baseline 5856). Warm perf 0.78, desktop perf 0.91. Measured by the orchestrator the next morning: the executor's runs returned NO_FCP because the Mac's display was asleep (headless Chrome does not paint then); with the display awake the same tree measures normally. Phone contrast nodes rose 5 -> 8 (new section-count text on collapsed toggles) — for 99-06. |
| 2026-11-13 | 4d5a0b40 | 99-04 | 0.66 | 0.90 | 9231 | 6019 | 9231 | 0 | 0.025 | 2 / 2 / 2 rules (color-contrast 6/9/7 nodes, label 5 nodes each); expanded phone 2 rules (5/5) | 360 / 320 (no overflow) | FCP 3904 ms (cold, unchanged). Warm perf 0.78, warm FCP 1117 ms, warm interactive/LCP 6019 (unchanged vs 99-03 6005); desktop perf 0.99. Cache confirmed written (455,664 bytes in localStorage) and hydrated in a Playwright probe, so the warm gain is not visible in Lighthouse: LCP/interactive is set by something other than the first dashboard paint (see SUMMARY). Cold CLS 0.025 (was 0). |

**Gap to target:** 85 - 60 = 25 points of mobile performance (target >= 0.85, cold median).

Baseline is at 0.60, so it is NOT below 60 but sits right on the line: a bundle split may be needed
(brewpad.min.js is 417 KB, plus jspdf 366 KB and qrcode 20 KB loaded synchronously in head). If the
per-plan work (99-04 cache, deferral) cannot close the gap, a bundle split is a decision to raise at
99-07, not something to add silently.

## Observations for later plans

- Cold mobile is dominated by the render-blocking head: FCP 5.9 s, then LCP = interactive = 14.1 s
  (dashboard content lands only after bundle parse plus the five eager admin-proxy calls). TBT is only
  ~54 ms and CLS 0.045, so main-thread blocking is not the issue; load order and payload are.
- Synchronous head scripts: js/vendor/jspdf.umd.min.js (366 KB), js/vendor/qrcode.min.js (20 KB), js/brewpad.min.js (417 KB), plus css/brewpad.min.css (71 KB).
- Warm run (HTTP cache primed) is 0.76 / 7.8 s interactive: the remaining 7.8 s is the data fetch +
  render chain, which is what the 99-04 dashboard cache targets.
- CLS 0.045 appears in 2 of 3 cold runs (one run 0.002) and in the warm run: a late layout shift in the
  dashboard render.
- axe serious+critical (all three widths): `label` (5 nodes, form controls without labels) and
  `color-contrast` (6 desktop, 9 tablet, 5 phone nodes). These are the 99-0x accessibility targets.
- No horizontal overflow at 360 or 320 px.
- The captured `get_tasks_calendar` response on staging is `{"ok":false,"error":"invalid_action"}`
  (staging's Apps Script does not know that action). It is kept in the fixture as captured, so the
  calendar section renders empty in the harness (0 `.bp-cal-entry`). Observation for a later look; no js/ change made.
- The fixture keeps the capture date (`asOf.today` 2026-11-12) rather than the harness `__TODAY__`
  placeholder, so the YTD charts stay stable between runs; the "vs earlier period" tiles show "No earlier data to compare".

## Payload size (RESEARCH A5, for 99-04 cache storage choice)
| 2026-11-13 | ec2ad073 (phase start), gzip harness | baseline (re-measured) | 0.85 | 0.91 | 3932 | 1802 | 3870 | 62 | 0.047 | 2 / 2 / 2 rules (color-contrast 6/9/5, label 5) | 360 / 320 (no overflow) | FCP 2409 ms; warm perf 1.00; cold runs 0.85 / 0.85 / 0.94. Harness now serves gzip like the live site (see note below); rows above this one are NOT comparable. |
| 2026-11-13 | f8038e40 + gzip harness | 99-04 (re-measured) | 0.95 | 0.90 | 2720 | 1519 | 2720 | 0 | 0.025 | 2 / 2 / 2 rules (color-contrast 6/9/7, label 5); expanded phone 5/5 | 360 / 320 (no overflow) | FCP 1808 ms; cold runs 0.95 / 0.89 / 0.95; desktop 1.00. **Warm perf 0.83 with CLS 0.36**: the cached-first render shifts layout when the refresh lands — to fix before the 99-07 gate. |
| 2026-11-13 | 56478864 | 99-04 follow-up (CLS) | 0.89 | 0.90 | 3471 | 1518 | 3471 | 0 | 0.071 | 2 / 2 / 2 rules (color-contrast 7/9/6 nodes approx, label 5); expanded phone 2 rules | 360 / 320 (no overflow) | FCP 1810 ms. **Warm perf 1.00, warm CLS 0.025** (was 0.83 / 0.36): the cached render now shows the cached Today tasks and Overdue/Due today chips instead of 'Not available yet'. Remaining warm shift = Waitlist chip row appearing after the refresh (52 px). Cold CLS 0.071 this run (0.025 in the previous run; run-to-run noise); cold perf 0.89 sits in the known 0.85-0.95 spread. |
| 2026-11-13 | 5580a1e4 | 99-05 | 0.94 | 0.90 | 2761 | 1520 | 2761 | 0 | 0.071 | 2 / 2 / 2 rules (color-contrast 6/9/7 nodes, label 5); expanded phone 2 rules (5/5) | 360 / 320 (no overflow) | FCP 1810 ms; desktop perf 1.00. Warm perf 1.00, warm CLS 0 in latest.json lighthouse.warm (warm FCP 967 ms, warm interactive/LCP 1520). Chart markers and touch tooltip add no measurable cost (charts are lazy). Cold CLS 0.071 is the known run-to-run noise (0.025-0.071). |
| 2026-11-13 | 87014761 | 99-06 | 0.95 | 1.00 | 2716 | 1519 | 2716 | 0 | 0.025 | 0 / 0 / 0 rules; expanded phone 0 rules (was 2 rules: color-contrast 6/9/7/5 nodes, label 5) | 360 / 320 (no overflow) | FCP 1958 ms; desktop perf 1.00, desktop a11y 1.00. Lighthouse a11y 0.90 -> 1.00. Warm perf 1.00, warm CLS 0.025 (latest.json lighthouse.warm; warm FCP 966 ms, warm interactive/LCP 1519). Cold perf 0.95 is within the 0.89-0.95 spread. Grid/focus/contrast CSS and table-view JS add no measurable cost. |

- `get_dashboard_stats.data`: **398,966 bytes** (about 390 KiB) as compact JSON in the anonymized fixture
  (398,978 bytes raw; anonymization changes it by 12 bytes). That is under the typical 5 MB localStorage
  quota but large for sessionStorage-per-tab duplication; it is the single biggest eager payload.
- `get_batches.data`: 343,984 bytes (about 336 KiB), also fetched eagerly.
- Fixture on disk: `tests/perf/fixture/dashboard-fixture.json` is about 1.3 MB pretty-printed.

## Fixture integrity

The fixture is anonymized by `tests/perf/anonymize.js` (allowlist-first) and guarded by
`tests/frontend/perf-fixture-anonymized-99.test.js`. Rendering check on the fixture: `#bp-dash-v2`
renders tiles, Production over time, Products, and Source mix with data; 0 fixture misses.

## Harness correction (2026-11-13): gzip

The first version of `tests/perf/server.mjs` served every response uncompressed. The live site never does:
GitHub Pages gzips static assets (`brewpad.min.js` 425 KB raw, about 114 KB on the wire) and Railway's edge
gzips middleware JSON (checked on `/api/products` and `/api/ingredients`, both `content-encoding: gzip`).
Under Lighthouse's simulated slow 4G, uncompressed transfer made every download-bound metric several times
too slow, so the 2026-11-12 rows (0.60 / 0.66) understate the real score. The server now gzips text
responses when the client accepts it. Like-for-like, the phase-start code measures **0.85** and the tree
after 99-04 measures **0.95**. The D-05 target (>= 0.85) should be read against the corrected rows.
The baseline also varies run to run (0.85 to 0.94) because Lighthouse sometimes picks an early element as LCP.

---
phase: 99-dashboard-responsiveness-and-performance
plan: 04
subsystem: brewpad-dashboard
tags: [perf, cache, skeleton, a11y, localStorage]
requires: [99-02, 99-03]
provides: [cached-first dashboard render, as-of hint, layout-matching skeletons]
affects: [brewpad.html, js/brewpad.js, css/brewpad.css]
key-files:
  modified: [brewpad.html, js/brewpad.js, js/brewpad.min.js, css/brewpad.css, css/brewpad.min.css, .planning/phases/99-dashboard-responsiveness-and-performance/99-PERF-LOG.md]
  created: [tests/frontend/brewpad-dashboard-v2-cache-99.test.js]
decisions:
  - "Storage: localStorage key bp_dash_cache_v1 (survives iPad PWA restarts). Payload 398,966 B (455,664 B stringified with schedules/tasks), well under quota, so the full _dashData is stored, not a subset. Quota/any storage error is swallowed and the key removed."
  - "Cache email gate uses userEmail with fallback to loadSession().email (userEmail is not set yet on a reload before the token client runs)."
  - "Added _dashHydrating flag: waitlist, packaging-calendar and cards side fetches skip while the cached render is on screen, so they fire once, on the fresh render (or after a failed refresh)."
metrics:
  completed: 2026-11-13
---

# Phase 99 Plan 04: Cached-first dashboard render Summary

Same-day, same-user v2 dashboard now paints from `bp_dash_cache_v1` before the five admin-proxy calls return, shows
"As of h:mm AM/PM · Updating…", swaps fresh data in place, and falls back to layout-matching `aria-busy` skeletons.

## What was built
- `readDashCache / writeDashCache / clearDashCache`, `setDashAsOf`, `dashFreshApplied`, `dashRefreshFailed`, `dashV2SkeletonHtml` in js/brewpad.js.
- eagerLoad: `dashCacheUsable(readDashCache(), todayPacific(), email)`; hydrates `_dashData/_fermSchedules/_upcomingTasks`, never touches `_dashLoadTime`; unusable entries are removed.
- loadDashboard: writes the cache and sets "Updated" on success; keeps the v2 shell and shows the "Couldn't refresh" hint on failure when something is on screen (old error text path kept otherwise).
- clearDashCache() after clearSession() in bpSignOut and _enterLoggedOutState (T-99-14).
- `#bp-dash-asof` (role=status, aria-live=polite) in brewpad.html; hint set via textContent only; hidden in classic.
- CSS: flex switch row, `.bp-dash-asof` (var(--ink-secondary)), phone: own line left-aligned; skeleton modifiers chip 44x96, row 44, tile 64, chart 200/240.
- 17 new tests (hydrate, in-place swap, failure hint, day/user/v2/corrupt rejection, sign-out clear, setItem throwing, skeleton shapes, hint element).

## Commits
- 4d5a0b40 perf(99-04): cached-first dashboard render with as-of hint and skeletons (D-07, D-08)

## Verification (Node 24)
Frontend 266 suites / 3668 tests pass; middleware 316 suites / 4394 pass; lint clean. No existing test edited.

## Perf (see 99-PERF-LOG.md)
Cold 0.66 / a11y 0.90 / interactive 9231 ms / FCP 3904; warm perf 0.78, interactive 6019 ms (99-03: 9012 / 6005).
Warm Lighthouse did NOT improve even though the cache is written (455 KB) and hydrates (Playwright probe). Warm FCP is 1117 ms,
so first paint is already early; interactive/LCP at ~6 s is set by something else (likely Chart.js load / chart render or the
network-quiet wait for the 5 still-running calls). Plans 99-05+ should find the LCP element before assuming the cache moves it.

## Deviations
None to the plan. The build restamped ~30 unrelated pages and js/admin.*; all were clean before the build and were restored (stamp-only).

## Known smells / notes
- Cold CLS reads 0.025 in 1 of 3 runs (99-03 had 0); skeleton heights are estimates (tile 64 px) and may differ from real tile height; worth tuning in 99-06.
- Cached render skips the waitlist/calendar/cards fetches until fresh data lands, so the Needs-attention waitlist count appears after refresh.
- Each load writes ~450 KB JSON to localStorage (sync); fine on iPad, but JSON.stringify cost on the main thread is unmeasured.
- Classic dashboard (v1) is not cached; cache writes only occur when v2 is on.

## Self-Check: PASSED

## Follow-up (2026-11-13): warm-load layout shift

Warm Lighthouse reported CLS 0.36 (perf 0.83). Measured with a throwaway Playwright layout-shift observer (412x823):
two shifts of the whole `.bp-dash-grid` (0.334 + 0.025). Cause: the cache stores `upcomingTasks` and `eagerLoad` hydrated
`_upcomingTasks`, but `_upcomingLoaded` stayed false, so the cached render showed "Today's tasks: Not available yet" (192 px)
and no Overdue / Due today chips; the refresh then grew the attention block (44 -> 148 px) and the tasks widget (192 -> 737 px).
The hint element and skeletons were not involved.

Fix (js/brewpad.js only, commit 56478864): `_dashTasksHydrated` flag plus `dashTasksAvailable()` used by
`renderDashV2TodayTasks` and `dashV2AttentionModel`; cleared in `dashFreshApplied`. `_upcomingLoaded` is deliberately left
false so other tabs still refetch. No cache-format change. Tests: tests/frontend/brewpad-dashboard-v2-cache-99-layout.test.js
(layout shift itself is not assertable in jsdom; the tests pin the data-side cause).

Result: warm CLS 0.025, warm perf 1.00. Remaining shift: the Waitlist chip appears after refresh (the waitlist fetch is skipped
while hydrating), adding one 52 px chip row; left alone because it is under the 0.05 target.

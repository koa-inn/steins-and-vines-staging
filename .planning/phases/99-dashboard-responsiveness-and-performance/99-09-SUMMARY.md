---
phase: 99-dashboard-responsiveness-and-performance
plan: 09
subsystem: brewpad-dashboard
tags: [default-flip, migration, feature-flag]
requirements-completed: [DFLT-01]
key-files:
  created:
    - tests/frontend/brewpad-dashboard-v2-default-99.test.js
  modified:
    - js/brewpad.js
    - js/brewpad.min.js
    - brewpad.html
    - tests/frontend/brewpad-dashboard-v2-shell.test.js
    - tests/frontend/brewpad-dashboard-render.test.js
    - tests/perf/seed.js
key-decisions:
  - "v2 is the default; a device that had opted out is moved to v2 once (marker bp_dash_default_v2), after which its choice is remembered"
  - "Switch label is 'Classic dashboard' in v2 and 'Try new dashboard' in classic; no banner or toast"
completed: 2026-11-13
---

# Phase 99 Plan 09: v2 default flip Summary

**v2 is the default BrewPad dashboard on staging (`4ea08134`), with a one-time per-device move to v2 and a
remembered "Classic dashboard" fallback; the owner confirmed it on 2026-11-13.**

## Commits

- `0ce90169` test (RED): `brewpad-dashboard-v2-default-99.test.js` (7 failed, 2 passed before the change)
- `4ea08134` feat: `initDashV2Flag` uses `dashV2DefaultFlagFrom(search, hash, stored, migrated)`, writes the
  `bp_dash_default_v2` marker, strips `?dash=classic` from the URL, relabels the switch; rebuilt bundle
- `a65c9897` docs: 99-09 row in 99-PERF-LOG.md
- `4ecb413d` docs: staging deploy recorded in 99-ROLLOUT-LOG.md

## Behaviour

- Empty storage and no URL flag: v2 renders; `bp_dash_v2 = '1'` and `bp_dash_default_v2 = '1'` are stored.
- Stored `bp_dash_v2 = '0'` with no marker: v2 renders once and the marker is set. Choosing Classic afterwards is
  remembered across reloads.
- `?dash=classic`, `#dash=classic`, `?dash=v1`: Classic. `?dash=v2`: v2.
- Throwing localStorage: v2 renders without throwing.
- The flag is initialised at boot before the cached-first decision, so a default-v2 device gets the cached render
  on its first load and a Classic device never gets a v2 cached render (both covered by tests).

## Existing tests edited (owner permission "tests ok", 2026-11-13)

- `tests/frontend/brewpad-dashboard-render.test.js`: three lines added to the shared `setup()` helper to choose
  Classic explicitly (`bp_dash_v2='0'`, `bp_dash_default_v2='1'`, `_initDashV2FlagForTest()`). Covers 10 tests:
  cycle-time tile (B1 regression) x6, shared data layer agreement (T-94-30) x2, XSS (T-94-29) x1, year-to-date
  tiles and caption x1. No assertion changed.
- `tests/frontend/brewpad-dashboard-v2-shell.test.js`:
  - "flag off renders v1 and the switch offers the new dashboard": seeds the same two flags.
  - "switch button toggles v2 and back…": seeds the same two flags; expected label 'Back to classic dashboard'
    changed to 'Classic dashboard'.
  - "throwing localStorage does not crash and defaults to v1" renamed "…defaults to v2"; first expectation changed
    from `toBeNull` to `not.toBeNull`.

No other existing test file needed a change. The locked `dashV2FlagFrom` filters test passes unmodified.

## Verification

- Node 24: frontend 271 suites / 3736 tests, middleware 316 suites / 4394 tests, lint clean.
- Harness after the change: PASS (cold perf 0.89, warm 1.00, axe 0 at all four widths, no overflow at 360 / 320).
- Staging deploy succeeded at `a65c9897`. Owner confirmed the flip on a laptop on 2026-11-13 ("approved").

## Deviations

- Task 1's push was done by the orchestrator after reviewing the test diff, not by the executor.
- The plan's Task 2 asks for confirmation on the shop iPad. The owner confirmed on a laptop and deferred the iPad
  (todo `phase-99-ipad-touch-checks.md`, item 5).
- `?dash=v1` also strips the URL now, because `stripDashFromUrl` is shared. Harmless.

## Not done here

- v1 render code is untouched (D-04); removal stays in `.planning/todos/pending/remove-v1-dashboard-code.md`.
- Production release: not part of this plan.

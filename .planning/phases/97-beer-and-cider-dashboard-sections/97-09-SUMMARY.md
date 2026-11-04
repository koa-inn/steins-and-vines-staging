---
phase: 97-beer-and-cider-dashboard-sections
plan: 09
subsystem: ui
tags: [brewpad, dashboard-v2, chartjs, beer, cider]
requires:
  - phase: 97-04
    provides: GET /api/admin/dashboard-cards (card facts, canning constants)
  - phase: 97-07
    provides: bp-dash-v2-bc slot in the Beer & cider section
  - phase: 97-08
    provides: DASH_DAY_NAMES / month names, dashCalDayLabel
provides:
  - buildBeerCiderCards (pure card model)
  - widget bc with per-card readings curve
affects: [97-10, 97-11]
key-files:
  modified:
    - js/brewpad.js
    - js/brewpad.min.js
    - css/brewpad.css
    - css/brewpad.min.css
    - brewpad.html
    - tests/frontend/brewpad-dashboard-v2-beer-cider.test.js
decisions:
  - "D-16 amended by approved UI-SPEC: cards follow the Type and Source filters; staff batches still included"
  - "Temperature steps detected by task title via dashTaskKind (OWNER-TEMP-STEP)"
metrics:
  completed: 2026-11-04
---

# Phase 97 Plan 09: Beer & cider cards Summary

One card per active beer or cider batch on ?dash=v2 with recipe facts, Plato readings against targets, the real next step (temp steps in a pill), an estimated packaged output from the server's canning constants, and a collapsible per-batch readings curve reusing the G8 model.

## Commits
- 8e2e7771 feat(97-09): beer and cider card model (D-07..D-12, D-16)
- b81f4b7d feat(97-09): Beer & cider cards with readings curve on v2 (SC1-SC3, D-16)

## What was built
- `buildBeerCiderCards` (pure): selection (primary/secondary, beer then cider, newest first), facts, readings wording ("No readings yet"), next step with temp flag, output math using only the passed-in canning constants (cans floor), empty text per Type, hidden for Wine.
- Widget `bc`: `ensureDashCardsData` fetches `/api/admin/dashboard-cards` once per dashboard load (credentials include); cards render before it resolves and fill in after; failure drops facts/output silently.
- Per-card curve: `Show/Hide readings curve` (aria-expanded), Chart/Table toggle, Chart.js instance at `_dashV2Charts['bc:<id>']`, `destroyDashV2ChartsByPrefix('bc:')` on every section render. `dashG8ChartConfig(g)` extracted from `renderDashV2Ferment` (behaviour unchanged; Floor tests unmodified and green).
- 6-card cap with `Show all N`, section estimate note, XSS-safe via escapeHTML.
- CSS `.bp-bc-*` using existing tokens only.

## UI-SPEC amendment of D-16 (approved, not a deviation)
D-16 fixed only the Type behaviour; the approved UI-SPEC adds that the cards follow the Source filter too, with staff batches still included.

## Deviations from Plan

**1. [Rule 3 - Blocking] Helper name clash: `dashShortDate`**
- A different `dashShortDate` ('Nov 6', used by period labels) already exists at top level; the plan's new function of the same name caused a redeclaration SyntaxError.
- Fix: new helper named `dashWeekdayDate` ('Fri 6 Nov'); `dashCalDayLabel` uses it. Exported via the test seam as `dashWeekdayDate`.

**2. Test fixture weekdays**: the plan's examples ("Thu 6 Nov", "Sat 1 Nov") do not match the 2026 calendar; tests use the real weekdays (Fri 6 Nov, Sun 1 Nov).

## Verification
- Root `npm test`: 246 suites / 3381 tests pass; `npm run lint` clean; build run.
- Middleware `npm test`: 296/297 suites pass. `__tests__/vancouver-timezone.test.js` fails (2 tests); pre-existing and unrelated (no middleware files touched; see Node tzdata / Postgres tz memory notes).
- Only plan files (plus brewpad.html cache-bust stamp) committed; other regenerated stamps discarded.

## Notes for the owner
Temperature steps are detected by task title (OWNER-TEMP-STEP); a structural flag on schedule steps would be the long-term fix (deferred).

## Known Stubs
None.

## Self-Check: PASSED

---
phase: 99-dashboard-responsiveness-and-performance
verified: 2026-11-13T00:00:00Z
status: human_needed
score: 13/13 must-haves verified
overrides_applied: 0
gaps: []
human_verification:
  - test: "iPad touch checks (D-02 device check, D-13 real touch)"
    expected: "Two-tap chart tooltip, finger scrolling over a chart not trapped, Safari popup blocker allows QR/label print right after sign-in"
    why_human: "Real touch device behaviour. WAIVED/DEFERRED by owner 2026-11-13; tracked in .planning/todos/pending/phase-99-ipad-touch-checks.md. Not a gap."
  - test: "Packaging calendar Calendar/Table switch with real data"
    expected: "Switch appears and Table shows Date | Batch | Task | Type"
    why_human: "Staging calendar was empty during pilot UAT; covered by jsdom registry test only"
  - test: "320 px chart clip (.bp-g6-chart, 333 px in 318 px viewport) and the stray focusable ~6800 px down at 390 px"
    expected: "Chart fits; tab order has no hidden stop"
    why_human: "Minor findings from pilot UAT, outside the pass criteria (no page scroll); owner may accept or schedule"
---

# Phase 99: Dashboard responsiveness and performance - Verification Report

**Phase Goal:** The v2 dashboard is fast and usable on the shop tablet, phones and desktop, and accessible; once that holds, it becomes the default view.
**Status:** human_needed (all automated truths verified; only owner-waived device checks and minor notes remain)
**Re-verification:** No, initial verification.

## Goal Achievement

### Observable Truths (ROADMAP success criteria and plan must-haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: mobile-first grid 1 / 2 / 3 columns, no horizontal scroll at 360 px | VERIFIED | css/brewpad.css:3241 `@media (min-width:1200px)` sets `.bp-dash-grid` to 3 columns; 2 columns from 768 existing; css-99 test passes. Harness: scrollWidth equals viewport at 360 and 320 in every logged run; staging pilot UAT items 2 and 3 PASS. |
| 2 | SC2: Lighthouse mobile >= 85 | VERIFIED | 99-PERF-LOG Gate: PASS on 91d05a9e (median 0.89 lower run; 0.95 other), re-run 4ea08134: 0.89. Corrected gzip baseline 0.85. Earlier 0.60/0.66 rows noted as non-comparable. |
| 2b | Interactive < 1.5 s warm / < 3 s cold (informational under D-05) | VERIFIED as informational | Warm 1519 ms (marginally over), cold 2716-3467 ms (mixed). D-05 makes the Lighthouse score the sole gate; recorded honestly in the log. |
| 3 | SC3: every chart has a table view; colour not sole signal; visible focus | VERIFIED | a11y-coverage-99 registry test (passes); `dashV2PackCalTableModel` at js/brewpad.js:492; `dashPointStyleFor` at :1485; axe serious+critical 0/0/0 plus phone-expanded, Lighthouse a11y 1.00; no `--ledger-focus` in `:focus-visible` (css-99 test). |
| 4 | SC4: v2 default after owner sign-off with Classic fallback | VERIFIED | `dashV2DefaultFlagFrom` (:1446) migrates once via `bp_dash_default_v2` (:7608-7615); `initDashV2Flag` wired (:7604); switch labels "Classic dashboard" / "Try new dashboard" (:7654). Owner: "approved, tests ok" and laptop confirmation 2026-11-13. Note: roadmap text says "flag removed"; CONTEXT D-01/D-03 deliberately retain `?dash=` parameters and a Classic fallback, so this is the decided interpretation. |
| 5 | 99-01 harness repeatable, local, no shipped mock, anonymized fixture, baseline recorded | VERIFIED | tests/perf/{server.mjs,run.mjs,anonymize.js,seed.js,gsi-stub.js,fixture/}; `npm run perf` in package.json; grep of brewpad.html, js/brewpad.js, css for harness flags/mocks returns nothing; perf-fixture-anonymized-99 test passes; baseline ec2ad073 rows present. |
| 6 | 99-02 pure helpers exist, exported, tested | VERIFIED | functions at js/brewpad.js:1446-1525; helpers-99 test passes. |
| 7 | 99-03 jsPDF/qrcode off head, lazy sections, IO gating | VERIFIED | brewpad.html head has no jspdf/qrcode script; `loadScriptOnce` (:13349), `preloadPrintTools` (:13366), `dashV2SlotShouldRender(` gate (:8850), IntersectionObserver (:8867-8875); lazy-99 test passes; UAT 0 canvases while collapsed, 9 / 0 external pre-paint requests. |
| 8 | 99-04 cached-first render, same-day/same-user, cleared on sign-out | VERIFIED | `DASH_CACHE_KEY` :4597; `dashCacheUsable(` at :7394; `clearDashCache()` at :5028 and :5073; `#bp-dash-asof` in brewpad.html:65; cache-99 tests pass; UAT item 4 PASS ("As of ... Updating..." then "Updated"). |
| 9 | 99-05 markers, touch tooltip, mouse unchanged | VERIFIED (code and jsdom) | `dashTouchTapAction(` used at :3820; chart-a11y-99 test passes. Real touch deferred (see human items). |
| 10 | 99-06 tables, grid, focus, contrast, 44 px | VERIFIED | css-99 and a11y-coverage-99 tests pass; axe 0, Lighthouse a11y 1.00. |
| 11 | 99-07 gate run on final tree | VERIFIED | Two full runs logged, lower used, explicit "Gate: PASS". |
| 12 | 99-08 staging only, pilot UAT, owner sign-off and test-edit permission | VERIFIED | 99-ROLLOUT-LOG: staging sha d9693731, 10-row UAT, sign-off "approved, tests ok", 13 test edits permitted. Production untouched (280eae3e). |
| 13 | 99-09 default flip, one-time migration, Classic remembered, v1 todo | VERIFIED | default-99 test passes; initDashV2Flag as above; `.planning/todos/pending/remove-v1-dashboard-code.md` exists. |

**Score:** 13/13 truths verified.

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| RESP-01 | SATISFIED | Truths 1, 7 (phone order verified in UAT item 1) |
| PERF-01 | SATISFIED | Truths 2, 5 |
| PERF-02 | SATISFIED | Truth 8 |
| PERF-03 | SATISFIED | Truth 7 |
| A11Y-01 | SATISFIED | Truths 3, 10 (calendar Table view code-tested only) |
| A11Y-02 | SATISFIED in code; real touch waived | Truth 9 |
| DFLT-01 | SATISFIED | Truths 4, 13 (iPad sign-off replaced by owner laptop approval, waived) |

No orphaned requirements. Housekeeping: REQUIREMENTS.md still shows these as unchecked `[ ]`, and ROADMAP plan checkboxes for 99 are unticked; the orchestrator should update them. 99-09-SUMMARY.md was absent at verification time (being written).

### Behavioral Spot-Checks

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Frontend suite | `npm test` (Node 24) | 271 suites, 3736 tests passed | PASS |
| Lint | `npm run lint` | clean, 0 warnings | PASS |
| Perf harness | not run per instructions; relied on PERF-LOG rows, which are corroborated by committed code | n/a | SKIP |

### Anti-Patterns Found

No TBD/FIXME/XXX in tests/perf. No harness flags in shipped files. Info: pre-existing middleware lint CI failure (unused vars in zoho-middleware/routes/pos-recipe.js), not caused by this phase. Out-of-phase a12d8d05 noted and excluded.

### Human Verification Required

1. iPad touch checks (D-13, D-02 device check, popup blocker for print): WAIVED/DEFERRED by owner, tracked in todo; not a gap.
2. Packaging calendar Table switch with non-empty data on staging (only unit-tested).
3. Minor UAT notes: 320 px `.bp-g6-chart` clipped about 15 px (no page scroll); one stray focusable far down the page at 390 px; KPI tiles two per row beside three-column grids on desktop. App-shell tab-bar and header overlap are pre-Phase-99.

### Gaps Summary

No blocking gaps. Phase goal is achieved on staging per the harness gate and owner approval. Warm interactive of 1519 ms narrowly misses the informational 1.5 s handoff target (non-gating by D-05). Production release is out of scope and awaits separate approval.

---

_Verified: 2026-11-13_
_Verifier: Claude (gsd-verifier)_

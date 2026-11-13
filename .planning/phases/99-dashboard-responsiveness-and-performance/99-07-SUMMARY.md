---
phase: 99-dashboard-responsiveness-and-performance
plan: 07
subsystem: brewpad-dashboard
tags: [performance, accessibility, gate]
requirements-completed: [PERF-01, PERF-02, PERF-03, A11Y-01, A11Y-02, RESP-01]
key-files:
  modified:
    - .planning/phases/99-dashboard-responsiveness-and-performance/99-PERF-LOG.md
completed: 2026-11-13
---

# Phase 99 Plan 07: D-05 gate Summary

**Gate: PASS.** Lighthouse mobile performance 0.89 (lower of two runs; the other was 0.95) against 0.85, axe
serious+critical 0 at every width, no horizontal scroll at 360 / 320 px. Measured at `91d05a9e`.

## What was done

- Task 1: `npm run build` produced only cache-stamp churn (the brewpad artifacts were already current), which
  was discarded. `npm run perf` was run twice under Node 24 with the display awake; both exited 0. Two gate rows
  and the `Gate: PASS` line are in 99-PERF-LOG.md.
- Task 2 (owner decision on a failed gate): skipped, the gate passed.

Run inline by the orchestrator (two measurements and a log entry; no code change).

## Numbers

| | Baseline (gzip harness) | Final (lower run) | Final (other run) |
|---|---|---|---|
| LH mobile performance | 0.85 | 0.89 | 0.95 |
| Accessibility score | 0.91 | 1.00 | 1.00 |
| Interactive cold | 3932 ms | 3467 ms | 2716 ms |
| Interactive warm | 1802 ms | 1519 ms | 1520 ms |
| axe serious+critical rules | 2 at every width | 0 | 0 |

Handoff targets: warm < 1500 ms missed by about 20 ms; cold < 3000 ms met in one run of two. Both are lab
numbers with no middleware latency.

## Deviations and things to know

- The harness was corrected on 2026-11-13 to serve gzip like the live site (commit 7e47cd33). The 2026-11-12
  rows (0.60, 0.66) are not comparable; the corrected phase-start baseline is 0.85. The gate was judged on the
  corrected harness.
- Lighthouse needs the Mac's display awake (headless Chrome does not paint otherwise); see tests/perf/README.md.
- Cold performance varies 0.87 to 0.95 between runs because the LCP element Lighthouse picks varies.

## Next

99-08: staging deploy, pilot UAT and owner iPad sign-off.

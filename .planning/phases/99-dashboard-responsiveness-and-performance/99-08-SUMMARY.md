---
phase: 99-dashboard-responsiveness-and-performance
plan: 08
subsystem: brewpad-dashboard
tags: [staging, uat, sign-off]
requirements-completed: [D-02]
key-files:
  created:
    - .planning/phases/99-dashboard-responsiveness-and-performance/99-ROLLOUT-LOG.md
    - .planning/todos/pending/phase-99-ipad-touch-checks.md
completed: 2026-11-13
---

# Phase 99 Plan 08: staging deploy, pilot UAT and owner sign-off Summary

**Phase 99 is on staging (`d9693731`, stamp `mwfe41v5`); the pilot UAT passed 9 of 10 items with one partly
checked; the owner replied "approved, tests ok" on 2026-11-13 and deferred the iPad checks.**

## What was done

- Task 1: pushed to staging, deploy-staging succeeded, staging middleware restarted and the ingredient catalog was
  warmed. Ten pilot items checked in the owner's signed-in Chrome (phone widths in same-origin iframes); results
  are in 99-ROLLOUT-LOG.md. Item 8 (QR / label print window) is partial: the libraries load after sign-in, but
  the print window was not opened by automation.
- Task 2: owner sign-off recorded. v2 approved as the default; permission given to update the 13 v1-default
  tests; iPad testing deferred by the owner and tracked as a todo.

Run inline by the orchestrator (deploy, browser checks and a log; no code change).

## Deviations

- D-02 asked for an iPad sign-off. The owner waived the device check (laptop is the main device). Touch
  behaviour (D-13) and the Safari popup path (A1) are unverified on a real device.
- The calendar Calendar/Table switch (99-06) could not be exercised: staging had nothing in the 14-day window.
- CI "Tests" is red on the middleware lint step (pre-existing since at least 2026-11-11, unused variables in
  `routes/pos-recipe.js`); not caused by this phase.

## Findings passed to the todo

320 px chart clip, bottom tab bar width at 360 / 320 px, header overlap at phone widths, tile row layout on
desktop, one stray focusable in the phone filter block.

## Next

99-09: make v2 the default with the one-time migration and the remembered Classic fallback.

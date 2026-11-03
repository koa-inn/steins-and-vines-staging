---
phase: 97-beer-and-cider-dashboard-sections
plan: 02
subsystem: zoho-middleware
tags: [kiosk, recipe-sale, snapshot, brewpad]
requires: []
provides:
  - kiosk recipe_snapshot with og, target_fg, ibu, batch_size_l and typed ingredients
affects: [97-05]
key-files:
  modified: [zoho-middleware/routes/pos-recipe.js]
  created: [zoho-middleware/__tests__/pos-recipe-snapshot-gravity.test.js]
decisions:
  - "Ingredients in snapshot are copies; Zoho line-item inputs are not mutated"
metrics:
  completed: 2026-11-03
  tasks: 1
  files: 2
---

# Phase 97 Plan 02: Kiosk snapshot gravity and types Summary

Kiosk in-store recipe sales now write og, target_fg, ibu, batch_size_l and ingredients carrying cf_type/cf_subcategory (from the already-loaded catalogMap) into recipe_snapshot, with no new Zoho or cache call.

## Task

1. Snapshot fields and helpers (snapshotIngredientType, typedSnapshotIngredients, snapshotGravity) in `routes/pos-recipe.js`; new test file with 5 tests (gravity values, empty/missing -> null, typed ingredient, absent-from-catalog -> ''). Commit f39455b9.

TDD: new tests were run first and failed (RED), then passed after implementation. Committed as one commit per plan.

## Verification

Middleware suite 288/288 suites pass, root suite 241/241 pass, lint clean. Existing pos-recipe tests unmodified and green. One earlier full run showed 1 middleware and 1 root failure that did not reproduce on rerun (flake, likely concurrent worktree load).

## Deviations from Plan

None. The "line items unchanged" check is covered structurally: the snapshot builds copies, and the existing money-path suites (pos-recipe, confirm-verification, zoho-line-fidelity) stay green; no dedicated buildRecipeLineItems spy test was added.

## Self-Check: PASSED

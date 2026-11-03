---
phase: 97-beer-and-cider-dashboard-sections
plan: 05
subsystem: brewpad-recipes
tags: [brewpad, recipes, target-gravity, snapshot]
requires: [97-01]
provides: [BrewPad Target OG/FG editor inputs, og/target_fg in attach snapshot]
affects: [brewpad.html, js/brewpad.js, js/brewpad.min.js]
key-files:
  created: [tests/frontend/brewpad-recipe-target-gravity.test.js]
  modified: [brewpad.html, js/brewpad.js, js/brewpad.min.js]
decisions:
  - "Inputs show on every recipe; no non-name beer/cider signal exists (no name-based gate added)"
metrics:
  completed: 2026-11-03
---

# Phase 97 Plan 05: BrewPad Target OG/FG Summary

Target OG / Target FG (°P) inputs in the BrewPad recipe editor, saved with the recipe and copied as `og` / `target_fg` into the recipe_snapshot when BrewPad attaches a recipe to a batch (null when blank).

## Commits
- 36dfa6d7: inputs, populate/read/payload/clone wiring, snapshot copy, new test file (tasks 1 and 2 source were committed together because they share one file edit)
- 423d75b2: rebuilt js/brewpad.min.js and stamped brewpad.html

## Carry sites for target_og / target_fg (js/brewpad.js)
- `populateRecipeForm`: fills inputs (finite number else '')
- `readRecipeFormData`: number or '' (never 0/NaN)
- `buildRecipePayload` (save POST/PUT body): added keys; without this the values would never reach the server
- `bpCloneRecipePayload`: copies (it copies abv/ibu)
- `buildBpAttachSnapshot`: `og`, `target_fg`
- `bpSaveAsNewRecipe`: NOT changed (it does not copy abv/ibu either)
- admin.html editor unchanged (recipe-pg leaves omitted keys untouched)

## Deviations
- Helper text reuses `.bp-dash-section-hint` (plus a `bp-field-help` hook class); no new CSS added. `.bp-input` already supplies sizing.
- Server error path was not modified; not re-read in depth beyond the plan's statement.

## Verification
- New test file and existing recipe tests (141 tests across 5 suites) pass unmodified; lint clean.
- Root `npm test`: one failure in `brewpad-batch-type-ui.test.js` on the first full run; passes in isolation on rerun (flaky, unrelated to these changes).
- `zoho-middleware npm test`: 3 suites / 4 tests failing; middleware was not touched by this plan, so these are pre-existing or environment-related (not investigated).

## Open questions for the owner
Target OG/FG show on every recipe because no recipe field marks beer or cider (no recipe type column; blank beer_category is a valid beer; cider ingredient types are unconfirmed; classifying by name is against project rules). Is that OK, or should we add an explicit recipe type field in a later phase so the inputs show only on beer and cider recipes?

## Self-Check: PASSED

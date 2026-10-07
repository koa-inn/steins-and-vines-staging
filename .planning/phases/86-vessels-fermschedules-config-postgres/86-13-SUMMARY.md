---
phase: 86-vessels-fermschedules-config-postgres
plan: 13
subsystem: zoho-middleware
tags: [postgres, facade, vessels, ferm-schedules, ops-mirror]
requires: [86-05, 86-06, 86-08, 86-11]
provides:
  - zoho-middleware/lib/vessel-store.js
  - zoho-middleware/lib/ferm-schedule-store.js
affects: [86-15, 86-16]
tech-stack:
  patterns: [recipe-store facade shape, fail-closed reference counts]
key-files:
  created:
    - zoho-middleware/lib/vessel-store.js
    - zoho-middleware/lib/ferm-schedule-store.js
    - zoho-middleware/__tests__/vessel-store.test.js
    - zoho-middleware/__tests__/ferm-schedule-store.test.js
decisions:
  - "Facades are PG-only; sheets mode rejects err.code 'sheets_mode' (D-19)"
  - "remove() resolves the batch count first, then the recipe count, sequentially, so an unavailable batch count opens no transaction"
requirements: [DB-05]
metrics:
  tasks: 2
  files: 4
completed: 2026-10-07
---

# Phase 86 Plan 13: Vessel and Ferm Schedule Store Facades Summary

Two thin, tested facades (`vessel-store`, `ferm-schedule-store`) turn route intent into transactional Postgres work plus ops-mirror scheduling, with Apps Script seams for batch reference counts and propagate.

## Commits
- 4e9a0aa7: vessel-store facade + tests
- 8947a9d1: ferm-schedule-store facade + tests

## What was built
- vessel-store: list/get/create/update/archive/unarchive/applyStatusChanges/nextVesselNumber. Actor defaults to 'middleware'; successful writes call `opsMirror.schedule('vessel', id)` (once per applied id for status deltas); underscore keys stripped; stale and other business rejections pass through unmirrored; PG failures reject (no sheet fallback).
- ferm-schedule-store: list/get/create/update/archive/remove/propagate/getStepsJson/hasBatchReferences/countRecipeReferences. `remove` fails closed with `batch_ref_unavailable` / `recipe_ref_unavailable`; recipe count uses PG when RECIPES_STORE is not sheets, else counts `recipeStore.list({})` rows. `propagate` ignores client steps, sends PG steps and the real actor to `propagate_ferm_schedule`, and normalises `batches_failed` to an array. `getStepsJson` returns the PG steps string or a not_found envelope.

## Deviations from Plan
None in behavior. Minor: the plan said "Promise.all" style counts was not mandated; counts are sequenced (batch, then recipe) to guarantee no transaction opens when the batch count fails. Tests: 30 new, full middleware suite 174 suites / 2705 tests pass; lint clean.

## Known gap
`remove()` resolves the batch (Apps Script) and recipe reference counts BEFORE opening the delete transaction, so a batch or recipe that starts referencing the schedule in that window is not seen (check-then-act; batches live in the sheet until Phase 87, so no cross-store lock exists). Impact is bounded: the snapshot on the batch keeps its steps, and Archive is the recommended action for any schedule that was ever used. Flag for Phase 87 (batches to Postgres), where the batch reference check can move inside the same transaction.

## Known Stubs
None.

## Self-Check: PASSED
Files and commits 4e9a0aa7, 8947a9d1 verified present.

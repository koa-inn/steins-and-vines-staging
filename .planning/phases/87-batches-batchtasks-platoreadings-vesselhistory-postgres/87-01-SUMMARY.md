---
phase: 87-batches-batchtasks-platoreadings-vesselhistory-postgres
plan: 01
subsystem: database
tags: [postgres, design-gate, batches, migration]
requires:
  - phase: 83
    provides: Postgres infra and migration guards
provides:
  - Owner-approved Phase 87 design (87-DESIGN.md) covering schema, indexes, callers, freeze, idempotency, mirror, tooling and cutover runbook outline
affects: [87-02, 87-03, 87-04, 87-05, 87-06, 87-07, 87-08, 87-09, 87-10, 87-11, 87-12, 87-13, 87-14, 87-15, 87-16, 87-17, 87-18, 87-19, 87-20]
tech-stack:
  added: []
  patterns: [design-gate-before-implementation]
key-files:
  created:
    - .planning/phases/87-batches-batchtasks-platoreadings-vesselhistory-postgres/87-DESIGN.md
    - .planning/todos/pending/reassign-customer-new-version-null.md
  modified: []
key-decisions:
  - "Owner approved all of Q1-Q20 as recommended on 2026-10-09, no changes"
  - "Draft 0005 DDL was pinned against both migration guards in a scratch dir; result recorded in design section 2"
  - "BATCHES_STORE flag lives outside STORE_ENV_NAMES via batch-flag.js"
  - "Production window date set only after the Phase 86 production flip"
requirements-completed: [DB-06]
duration: n/a
completed: 2026-10-09
---

# Phase 87 Plan 01: Design Gate Summary

Owner-approved Phase 87 design doc (schema 0005_batches.sql, index-to-query map, caller seams, freeze, idempotency, mirror, cutover runbook outline) with all 20 owner questions answered as recommended.

## Tasks

| Task | Name | Commit |
|------|------|--------|
| 1 | Pin migration-guard acceptance of draft 0005 DDL | none (scratch only; result in design section 2) |
| 2 | Write 87-DESIGN.md | f9253fd1 |
| 3 | Owner design approval (checkpoint) | 01a13879 |

## Open owner action items

- Q1: delete orphan task rows BT-000567..570 from the sheet before the staging rehearsal.
- Q3: confirm Apps Script project timezone (assumed America/Vancouver).
- Q14: set the production window date only after the Phase 86 production flip.
- Q18: reassign-customer `new_version` null bug tracked in `.planning/todos/pending/reassign-customer-new-version-null.md`.

## Deviations from Plan

None. The plan executed as written; the todo file for Q18 was added per the approval instructions.

## Known Stubs

None (documentation only).

## Self-Check: PASSED

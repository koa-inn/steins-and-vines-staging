---
phase: 82-store-agnostic-prerequisites
plan: 09
subsystem: deploy
tags: [apps-script, staging, deploy]
requires: [82-02, 82-03, 82-04, 82-05, 82-06, 82-07, 82-08]
provides: [apps-script-v57, staging-deploy]
affects: [82-10]
key-files:
  created: [scripts/phase82-appsscript-probes.sh, .planning/phases/82-store-agnostic-prerequisites/82-09-SUMMARY.md]
  modified: [docs/RUNBOOK.md]
status: in-progress
---

# Phase 82 Plan 09: Apps Script + Staging Deploy Summary

## Task 1 — Apps Script redeploy (D-19 step 1) — DONE

- Deployed **version 57** on 2026-09-23 via Manage deployments → edit → New version (same Web app URL). **Rollback target: 56.** Recorded in `docs/RUNBOOK.md` deploy record.
- Pasted file: `apps-script/adminApi.gs` at SHA-256 `d65bb8131189a06e1daae67d80008862b0527708fe2eb9d03104d544661364b9` (4 commits since v56: 1ef690cd, f620636e, 08d4d22f, 5c249c29).
- **Deviation:** the pre-paste editor-drift hash check (expected `6584237b…b74d8`, the repo file at v56) and the post-paste re-hash were skipped by the owner. Risk: any uncommitted editor-only edit made after v56 (2026-09-05) was overwritten. Mitigation available: compare v56 in Project History against the repo file.

### Non-mutating probes (`scripts/phase82-appsscript-probes.sh`)

| # | Probe | Expected | Observed | Pass |
|---|-------|----------|----------|------|
| 1 | GET `get_ingredients` | ok, Ingredients header row | ok:true, header `sku, hide, favorite, name…`, all strings | ✓ |
| 2 | GET `get_homepage` | ok, string values | ok:true, header `Type, Date, Title, Text`, all strings | ✓ |
| 3 | GET `get_config` | invalid_action | `invalid_action` — "Unknown action: get_config" | ✓ |
| 4 | POST `update_hold` (fake id) | not "Unknown server action" | `not_found` — Hold not found | ✓ |
| 5 | POST `update_inventory_cells` sheet=Holds | invalid_sheet | `invalid_sheet` | ✓ |
| 6 | POST `update_schedule_slots` [] | invalid_updates | `invalid_updates` | ✓ |
| 7 | POST `update_kits` | invalid_action | `invalid_action` — "Unknown server action: update_kits" | ✓ |
| 8 | POST `create_batch` duplicate SO | duplicate_so_number | not run (optional; no SKU/SO supplied) | — |
| 9 | Current production admin panel loads | loads + reads | owner confirmed loads fine on v57 | ✓ |

Probe-harness note: first two runs failed on harness input (literal `…` placeholders, then a clipboard holding more than the token value) — not deploy faults. Script hardened (whitespace strip, URL-encoding, error message output).

### Follow-up

- **Rotate the Apps Script server token** after the 82-10 production cutover — the value was typed in plain text into the Claude session on 2026-09-23. Update Script Properties (`SERVER_WRITE_TOKEN`, `SERVER_TOKEN` if set) and Railway `APPS_SCRIPT_SERVER_TOKEN` on both staging and production services.

## Task 2 — Staging push (D-19 step 2) — PENDING

## Task 3 — Staging walk — PENDING

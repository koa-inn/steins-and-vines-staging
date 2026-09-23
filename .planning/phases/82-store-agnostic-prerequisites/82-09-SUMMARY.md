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

## Task 2 — Staging push (D-19 step 2) — DONE

- Pre-push gate (2026-09-23): frontend 138 suites / 2026 tests ✓, middleware 114 suites / 1705 tests ✓, lint clean ✓. `links.html` (unrelated owner edit) left uncommitted.
- `git push origin main` → `46f11b31..abd4485e` (owner-approved). Production remote untouched.
- Staging middleware restarted on the new build ~80 s after push: `{"status":"ok","authenticated":true,"redis":true}`.

| Smoke check | Expected | Observed | Pass |
|-------------|----------|----------|------|
| POST `/api/admin/proxy`, no credential | 401/403, never 200 | HTTP 403 `Forbidden` | ✓ |
| GET `/api/batch/public/SV-B-000000?token=0…0` | 200 with ok:false from Apps Script | HTTP 200 `{ok:false, error:"not_found"}` (Apps Script checks batch existence before token — route live and forwarding) | ✓ |
| POST `/api/batch/public/SV-B-000000/tasks`, no API key | not 403 (guard exemption), ok:false invalid_token | HTTP 200 `{ok:false, error:"invalid_token"}` | ✓ |

- Static-site deploy could not be verified from the CLI (staging.steinsandvines.ca returns 403 to curl; `gh` unauthenticated) — verified in the browser as step 0 of the walk.

## Task 3 — Staging walk — IN PROGRESS (Claude-driven via Chrome, 2026-09-23; owner signed in)

### Staging walk

| Step | Result | Notes |
|------|--------|-------|
| 0 New code live / no direct Google calls | ✓ | Data calls observed only to `/api/admin/proxy`; none to script.google.com / sheets.googleapis.com |
| 1 Dashboard loads | ✓ | Kits, reservations, holds, ingredients, summary chips, batch tracker. Batch list ~12 s to load |
| 2 Reservations & Holds | partial | Manual hold on test kit ✓ (on_hold 0→1). Hold confirm/release + reservation status: **not exercised** (owner choice) — manual holds never render in this tab (pre-existing), only real customer reservations exist |
| 3 Kit Inventory | ✓ | Added TEST-82 (`append_inventory_row`); edited stock 0→3, Save All sent 1 change |
| 4 Ingredients | ✓ add | TEST-82-ING added; delete left to owner (Claude does not delete) |
| 5 Supplier Orders | partial | Add TEST-82 to order → on_order synced 0→1 ✓. Accept Delivery **not exercised** (native confirm(); live order holds ~12 real kits) |
| 6 Scheduling | not exercisable | Pre-existing bug: calendar never shows slots (dates arrive as ISO timestamps, UI compares `YYYY-MM-DD`); sheet has no slots after 2026-04-30. `update_schedule_slots` covered by probe 6 |
| 7 Export/Sync | not exercised | per checklist |
| 8 Homepage | ✓ | Loads featured + social; save-unchanged re-read confirms all 4 rows intact (incl. instafeed) |
| 9 Batches | partial | Created SV-B-000218 (4 tasks) ✓; completed transfer task (without transfer) → reopened detail shows it completed immediately ✓ (D-09 cache-bust). Batch **list** row still showed 0/4 until list reload (minor). Remaining 9.x (tick+Save Tasks, calendar two-batch save, add task, plato add/edit/delete, regenerate token, ferm schedule propagate) — owner |
| 10 Idle >10 min | pending | owner |
| 11 Public batch page | pending | owner (SV-B-000218 QR URL) |
| 12 BrewPad smoke | pending | owner |

No 429s or console errors observed.

### Findings (not Phase 82 regressions unless marked)

- **Phase 82 behaviour change:** admin-created batches are now attributed `kiosk-middleware` in VesselHistory/`created_by` (admin writes reach Apps Script via server_token, which hard-codes that actor). Audit trail loses the staff email. Consider passing the session email through the proxy.
- Scheduling calendar date-format bug (above) — pre-existing, schedule feature appears unused since April.
- Kit Inventory shows 8 blank rows (sheet rows with only formula/empty values); inflates "kits low stock".
- Manual holds are invisible in the admin UI (the stale Feb-6 hold).
- Admin page reload logs the user out when GIS silent refresh exceeds 5 s.
- Transfer dialog: shelf maxlength 1 / bin maxlength 2 silently truncate input; an unsaved task tick is dropped when the transfer dialog opens.

### Test records to clean up (owner)

- Kits: row **TEST-82** "ZZ Test Kit - Phase 82" (stock 3, on_hold 1, on_order 1)
- Holds: 1 manual hold on TEST-82, note "Phase 82 staging test - safe to delete"
- Ingredients: **TEST-82-ING** (use the admin Delete button — also exercises the delete path)
- Supplier order list: TEST-82 line (Remove)
- Batches: **SV-B-000218** "ZZ Test Customer" + its 4 BatchTasks + VesselHistory rows
- Homepage: rewritten with identical content (no cleanup)

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
status: complete
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

## Task 3 — Staging walk — APPROVED by owner 2026-09-24 (Claude-driven via Chrome, 2026-09-23/24; owner signed in)

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
| 9 Batches | ✓ (propagate: pre-existing defects) | Session 1: created SV-B-000218 ✓; transfer-task completion shows immediately on reopen ✓ (D-09). Session 2 (2026-09-23, Claude): tick + Save Tasks ✓ ("1 task updated", detail re-read shows done); add task ✓; plato add ✓ / inline edit 12.5→11.8 ✓ / delete ✓ (native confirm() auto-accepted once via a one-shot `window.confirm` override, restored after); regenerate URL ✓ (new token serves the batch, old token rejected); calendar two-batch save (SV-B-000218 + SV-B-000221, same due day) ✓ — both batch details show the new state immediately; ferm-schedule edit + propagate on a throwaway template (confirm said "1 active batch") ran, but see findings: stale detail up to 300 s and wrong task set. All writes observed only on `/api/admin/proxy` (200). Batch **list** progress still lags until list reload (minor, as before) |
| 10 Idle >10 min | ✓ | Admin tab untouched 11 min, then reopened a batch detail → server read succeeded, no forced re-login |
| 11 Public batch page | ✓ (auto-refresh not observable) | Opened the regenerated QR URL (normal tab, not private — automation limit): view loads ✓, ticked non-packaging task "Filtering" → "Task completed" ✓, submitted plato 10.2 → "1 reading recorded" ✓; page re-fetched after the task toggle. 60 s auto-refresh: not observable from automation (`document.hidden=true`; `batch.js:403` skips when hidden) — **owner verified on a visible screen 2026-09-24: admin task tick appeared on the public page within ~60 s ✓** |
| 12 BrewPad smoke | ✓ | Owner signed in; dashboard loads (needs-attention, needs-scheduling, ready-to-bottle); opened SV-B-000218 → detail matches admin (4/5 tasks, TEST/82, lifecycle) via `/api/batch/admin-proxy` 200. Only console error: GIS popup blocked at sign-in (non-blocking). "Wine Breakdown: unable to load catalog data" — see findings (staging Cloudflare Access, not Phase 82) |
No 429s or console errors observed.

### Findings (not Phase 82 regressions unless marked)

- **Phase 82 behaviour change (owner 2026-09-24: follow-up, not a 82-10 blocker → `.planning/todos/pending/admin-write-attribution-kiosk-middleware.md`):** admin-created batches are now attributed `kiosk-middleware` in VesselHistory/`created_by` (admin writes reach Apps Script via server_token, which hard-codes that actor). Audit trail loses the staff email. Consider passing the session email through the proxy.
- Scheduling calendar date-format bug (above) — pre-existing, schedule feature appears unused since April.
- Kit Inventory shows 8 blank rows (sheet rows with only formula/empty values); inflates "kits low stock".
- Manual holds are invisible in the admin UI (the stale Feb-6 hold).
- Admin page reload logs the user out when GIS silent refresh exceeds 5 s.
- Transfer dialog: shelf maxlength 1 / bin maxlength 2 silently truncate input; an unsaved task tick is dropped when the transfer dialog opens.
- **SECURITY (pre-existing since 526f907b, Feb 2026; live on prod — shared Apps Script):** `doGet` `get_batch_public` caches its *result* under `gbp:<batch_id>` for 5 s, keyed without the token, and the token check runs inside the cached fetch. Verified on SV-B-000218: within 5 s of a valid view, a bogus 32-hex token and a malformed token both returned `ok:true` with customer name/tasks/readings. Batch IDs are sequential. Also the inverse: a cached `invalid_token` result makes the *valid* token fail for 5 s (seen right after regenerate). Fix: validate token before the cache, or key the cache on batch_id+token. Writes validate separately (unaffected).
- **Propagate (pre-existing, 4468e429 / 61f48035, Feb 2026) — affects real batches whenever staff edit+propagate a template:** (a) `propagate_ferm_schedule` never calls `_invalidateBatchCache` on either dispatch path (`adminApi.gs:409` server_token, `:521` OAuth), so affected batch details stay stale up to 300 s — the D-09 guarantee does not cover propagate; (b) `propagateFermSchedule` matches by `step_number` over *pending* tasks only, so every completed step is re-appended as an open duplicate (SV-B-000221 got a second "ZZ Step A"); (c) inserting a step shifts step numbers, so the existing packaging task was rewritten in place into the new step but kept `is_packaging=TRUE` ("ZZ Step B" shown with PACKAGING), and a fresh packaging task was appended. Toast "1 updated, 2 added" matches.
- **Fixed 2026-09-24 (outside Phase 82 scope, owner-requested):** public-cache token binding `0d460a6e`; propagate matching + cache eviction `ff1436b7`. Deployed as Apps Script v58 (rollback v57) 2026-09-24 and live-verified on staging (see RUNBOOK deploy record).
- Staging-only: once the Cloudflare Access session on `staging.steinsandvines.ca` lapses, every same-origin fetch (e.g. `/content/zoho-snapshot.json`, even `/js/*.js`) returns an `opaqueredirect` → "Failed to fetch", so BrewPad's Wine Breakdown shows "Unable to load catalog data". Middleware calls (Railway origin) are unaffected; production has no Access gate.
- Task `completed_at` is stamped in UTC: ticking at ~17:00 PT on 09-23 shows "Done 2026-09-24".
- New-batch bin input clamps to 36 on blur (`admin.js:6597`, by design) — typing 83 silently becomes 36.

### Test records to clean up (owner)

- Kits: row **TEST-82** "ZZ Test Kit - Phase 82" (stock 3, on_hold 1, on_order 1)
- Holds: 1 manual hold on TEST-82, note "Phase 82 staging test - safe to delete"
- Ingredients: **TEST-82-ING** (use the admin Delete button — also exercises the delete path)
- Supplier order list: TEST-82 line (Remove)
- Batches: **SV-B-000218** "ZZ Test Customer" + its BatchTasks (now 5, incl. "ZZ Phase 82 test task") + 1 plato reading (10.2, "ZZ public page test") + VesselHistory rows
- Batches: **SV-B-000221** "ZZ Test Customer 2" (shelf T / bin 36) + its BatchTasks (incl. propagate duplicates) + VesselHistory rows
- v58 validation (2026-09-24): owner had already removed SV-B-000218/000221; new **SV-B-000221** "ZZ Test Customer 3" (shelf Z / bin 35, 4 tasks) created for the v58 check — delete it
- Schedule template: **ZZ Test Template Phase 82** (Schedule Templates → Delete) — delete after SV-B-000221 so no active batch references it
- Homepage: rewritten with identical content (no cleanup)

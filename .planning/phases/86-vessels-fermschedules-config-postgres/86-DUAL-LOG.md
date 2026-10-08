# Phase 86 — Ops Data Dual-Window Log

Owner-maintained log for the `OPS_DATA_STORE=dual` and `STAFF_ACCESS_STORE=dual` window
(D-09/D-10/D-11/D-12/D-18/D-19). See `docs/RUNBOOK.md` § "Ops data → Postgres (Phase 86)" for the
procedure this log supports. No secrets, no names, no emails, no vessel notes: ids, field names and
classifications only.

## Header

| Field | Value |
|-------|-------|
| Environment | production |
| `OPS_DATA_STORE=dual` set at | |
| `STAFF_ACCESS_STORE=dual` set at | |
| Window day 1 date | |
| Current window start (resets to day 1 on any bug-classified discrepancy) | |

## Production prerequisites (D-12)

| Check | Evidence | Date |
|-------|----------|------|
| Production `RECIPES_STORE=postgres` recorded in 85-DUAL-LOG.md "Flip decision" | | |
| Phase 85 post-flip verification complete | | |
| Data-hygiene decisions (FS-0011 "ZZ Test Template", "[gfs-probe]" on FS-0001): delete/clean or accept | Owner: import both as-is (accept) | 2026-10-08 |
| Vessels `label` header present (`ops-verify.js` prints "Vessels label header: present") | label header added to Vessels L1; staging verify printed "present" | 2026-10-08 |

## Phase 86 Apps Script versions

| Field | Value |
|-------|-------|
| New version | 61 |
| Rollback version | 60 |
| Deployed on | 2026-10-08 (owner; editor-drift check skipped, owner judged no editor edits since v60) |
| Probes (get_vessels, get_ferm_schedules, update_batch via proxy shows staff email in VesselHistory) | |

## Staging rehearsal

| Date | Step | Result |
|------|------|--------|
| 2026-10-08 | staging candidate SHA | `b5aad084` pushed to origin/main; staging middleware restarted healthy (database:true) |
| 2026-10-08 | backfill dry run (0 rejects) | 232 vessels, 11 schedules, 2 config keys, 2 staff (1 owner); 0 rejects. Two earlier runs were blocked: Config tab had no header row (key/value header added), and owner/staff env input was missing |
| 2026-10-08 | promote + `ops-verify.js` 0 mismatches | Promoted 232/11/2/2, sequences 11/232. Verify on a fresh snapshot: label header present, 0 mismatches, staff missing-from-PG 0, PG-only 1 (owner passed via --owners) |
| 2026-10-08 | dual on, pre-open mirror write verified | OPS_DATA_STORE=dual + STAFF_ACCESS_STORE=dual set together on staging; /health ok, database_required:true; /api/vessels and /api/staff-access/me 401 anonymous. Mirror write N/A on staging (staging never mirrors) |

### Staging UAT (86-18 Task 3, 2026-10-08, owner-approved; run in Chrome by Claude as hello@ owner/break-glass)

| Step | Result |
|------|--------|
| 1 Vessels tab | PASS: TST-001 added via next-id prefill; edit; stale save showed the D-16 message + Reload; status override In-Use; archive refused while In-Use; Empty then archive hides it (status Disabled/Retired, BrewPad picker filters it); unarchive OK; no Delete button |
| 2 Batch flow | PASS: test batch SV-B-000236 in TST-001 flipped it to In-Use; deleting the batch set it back to Empty. Staging never writes the Vessels sheet |
| 3 Schedules | PASS: FS-0012 got the next sequence id; stale edit showed the message; a batch created with the PG-only schedule; propagate updated 1, failed []; delete blocked "0 recipe(s) and 1 batch(es)"; deleted after the batch was removed; archive (FS-0013) hides it from admin and BrewPad lists |
| 3 bug found | **FIXED `e6da5880`:** in dual, the get_batch_init overlay returned `data.schedules` as a bare array, so the admin Schedule Templates list rendered empty. Fixed to `{schedules:[...]}`, re-verified on staging (11 cards) |
| 4 Staff Access | PASS (owner side): tab visible; list 2 staff + 1 break-glass-only; self-remove -> 409 cannot_remove_self. Second-account add/role/remove-403 **skipped by owner, covered by tests** (staff-access-routes, auth-tiers-revocation) |
| 5 Attribution | PASS: batch created_by and VesselHistory transferred_by = staff email, not kiosk-middleware |
| 6 Recipes | PASS: public /api/recipes still shows ferment_days 21 for FS-0010 recipes |

Leftover staging test data: TST-001 (Empty, label "UAT test carboy") and FS-0013 (archived). SV-B-000236 and FS-0012 were deleted.

## Production cutover

| Date | Step | Result |
|------|------|--------|
| | backfill dry run (0 rejects) | |
| | promote + `ops-verify.js` 0 mismatches | |
| | both flags set to dual together; `/health` `database_required` true | |
| | startup log "Ops mirror sweep registered" | |
| | pre-open mirror write + fresh-snapshot verify | |
| | every regular staff member signed in once | |

## Op coverage

One row per D-11 action. "First seen at" is the first time the action ran (real traffic or the
RUNBOOK §7 scripted runsheet) during the CURRENT window. "Sentry clean?" is yes only if zero
unexplained discrepancies were raised for that action during the current window.

| Action | First seen at | Real or scripted | Sentry clean? |
|--------|----------------|-------------------|----------------|
| vessel add | staging 2026-10-08 (not window) | staging | yes |
| vessel edit | staging 2026-10-08 (not window) | staging | yes |
| vessel archive | staging 2026-10-08 (not window) | staging | yes |
| vessel status override | staging 2026-10-08 (not window) | staging | yes |
| batch-flow vessel status delta | staging 2026-10-08 (not window) | staging | yes |
| schedule create | staging 2026-10-08 (not window) | staging | yes |
| schedule edit | staging 2026-10-08 (not window) | staging | yes |
| schedule delete-or-archive | staging 2026-10-08 (not window) | staging | yes |
| schedule propagate | staging 2026-10-08 (not window) | staging | yes |
| staff add | | | |
| staff remove | | | |
| staff role change | | | |

## Discrepancy table

One row per Sentry `[dual-write]` event, `ops-mirror` error or manually found `ops-verify.js`
mismatch. Every row must be classified before the flip bar can be met.

| Date | Entity | Id | Field | Classification (explained/bug) | Fix commit |
|------|--------|----|-------|----------------------------------|------------|
| | | | | | |

## Staff decisions

Shadow-compare outcomes for the un-mirrored staff list (D-10). Counts only, never emails.

| Date | Shadow disagreements (count) | Explanation |
|------|-------------------------------|-------------|
| | | |

## Window days

| Day | Date | Sentry `ops-mirror` clean? | `ops:mirror-dirty` markers | `ops-verify.js` result | Notes |
|-----|------|-----------------------------|-----------------------------|--------------------------|-------|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |

## Explained differences (known up front)

Copy of RUNBOOK §11.

- Vessel status drift when a Postgres status apply failed (Sentry names the vessel; replay fixes it).
- jsonb key order in schedule steps (verify compares parsed).
- Vessel location is trimmed on import.
- New vessels do not get Zoho inventory items (Pitfall 11).

## Flip decision

Filled in once the flip bar (at least 7 consecutive days, every Op-coverage action observed, zero
unexplained discrepancies) is met and the owner decides to flip to `postgres`.

| Field | Value |
|-------|-------|
| Owner | |
| Date | |
| Decision | |

## Post-flip verification

| Check | Result | Date |
|-------|--------|------|
| Both flags `postgres`; `ops-verify.js` 0 mismatches | | |
| D-18: Config `staff_emails` value cell blanked with retirement note | | |
| Direct Apps Script call with a non-owner staff token returns unauthorized (after 5 minutes) | | |
| `ops-verify.js` staff leg: missing from Postgres 0 | | |
| Railway `STAFF_EMAILS` trimmed to owner break-glass only (date) | | |
| Regular staff member and an owner can still sign in | | |

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
| Data-hygiene decisions (FS-0011 "ZZ Test Template", "[gfs-probe]" on FS-0001): delete/clean or accept | | |
| Vessels `label` header present (`ops-verify.js` prints "Vessels label header: present") | | |

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
| | backfill dry run (0 rejects) | |
| | promote + `ops-verify.js` 0 mismatches | |
| | dual on, pre-open mirror write verified | |

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
| vessel add | | | |
| vessel edit | | | |
| vessel archive | | | |
| vessel status override | | | |
| batch-flow vessel status delta | | | |
| schedule create | | | |
| schedule edit | | | |
| schedule delete-or-archive | | | |
| schedule propagate | | | |
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

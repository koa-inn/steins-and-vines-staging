---
phase: 81-recipe-fermentation-timeline-give-customers-an-expected-read
plan: 07
status: complete
completed: 2026-09-05
tasks_completed: 2
tasks_total: 2
autonomous: false
requirements: [OPS-05]
---

# 81-07 Summary — FermSchedules inventory + Apps Script deploy

Both tasks were `checkpoint:human-action` with `gate="blocking"`. Executed interactively
with the owner driving sign-in and authorising the deploy; browser steps piloted via Chrome.

## Task 1 — Live FermSchedules inventory, D-10 branch decision

**Outcome: Branch A.** Both required templates already exist; plan 81-08 attaches, creates nothing.

| schedule_id | name | category | max_non_packaging_offset | customer sees |
|-------------|------|----------|--------------------------|---------------|
| FS-0010 | Basic Ale (No Dry Hop) | beer | 21 | about 3 weeks |
| FS-0008 | Standard Lager | (blank) | 35 | about 5 weeks |

Both match the owner's stated figures (ales ~3 weeks, lagers ~5 weeks) exactly under
`fermentTimeDisplay`'s `Math.round(days / 7)`. No discrepancy to escalate. Full 10-template
inventory, per-recipe mapping and step detail in `81-SCHEDULES-INVENTORY.md`.

**How it was read.** The plan's `curl` route was unusable — the server token is deliberately
absent from this working copy. A signed-in browser GET to `/exec` also failed
(`"Could not determine user email"`), which led to the deployment-config finding below. The
data was instead read through the live admin panel, which performs the OAuth handshake and
calls `adminApiGet('get_ferm_schedules')`; values were extracted from the `.schedule-card`
DOM that `renderScheduleList` builds directly from the API payload. The derivation used is
byte-identical to the shipped `maxNonPackagingOffset` predicate
(`is_packaging !== true && typeof day_offset === 'number'`).

All three active recipes confirmed live: `SV-R-000011`, `SV-R-000003`, `SV-R-000002`. Every
other recipe is `draft`.

## Task 2 — Apps Script deploy + four probes

| | |
|---|---|
| **Rollback target** | **Version 55**, Sep 4 2026 1:42 PM |
| Deployed | **Version 56**, Sep 5 2026 2:11 PM |
| Deployment ID / URL | unchanged — no `admin-config.js` or Railway env update needed |

**Pre-paste drift check.** Before overwriting the editor, its `adminApi.gs` was hashed in
place via the Monaco model: `625ea2ef…`, an exact match for `cd731469` (the last pre-phase-81
commit touching the file). No uncommitted editor-only edits existed, so the paste destroyed
nothing. Post-paste the editor hashed to `6584237b…`, matching phase-81 `HEAD` exactly. This
check was not in the plan; it is now written into `docs/RUNBOOK.md` as standing procedure.

### Probe results — 4/4 pass

| Probe | Result | Evidence |
|-------|--------|----------|
| (a) `get_recipes` | **ok** | Prod middleware `/api/recipes` returned `"source":"apps-script"` — a live cache-miss call through to v56, all 3 active recipes |
| (b) `get_ferm_schedules` | **ok:true** | HTTP 200 captured off the wire, all 10 templates |
| (c) self-migration | **PASS** | No-op save on Czech Lager created `schedule_id` at column **R**, last in the row, `pricing_mode` unshifted at Q, values empty `''` |
| (d) `'gfs'` eviction | **PASS** | Write→read in ~1s against a freshly-reset 300s TTL returned the new value, not the cached one |

Probes (c) and (d) are the real gate: the unit tests exercise a *fake* Sheets runtime, so
this is the first evidence either behaviour works against the real API. Both do.

## Deviations

1. **Inventory read via the admin panel, not `curl`.** Credential unavailable locally; the
   browser `/exec` route is blocked by the config drift below. Same data, same derivation.
2. **Probe (d) re-targeted from `FS-0001` to `FS-0010`.** `FS-0001` has 1 active batch and
   its save dialog offers only Confirm/Cancel — no way to save without propagating to a live
   customer batch's tasks. Running a cache test at that cost was not justified, so it was
   cancelled with nothing saved and re-run on `FS-0010` (0 active batches). Probe intent
   fully preserved; blast radius nil.
3. **`docs/RUNBOOK.md` gained a whole Apps Script section.** The plan cited it for "the Apps
   Script deploy sequence and rollback procedure" — the file had **no** Apps Script coverage
   at all. Added the deploy/rollback sequence, the drift-check step, the two-projects-same-name
   trap, and a deploy record table.

## Findings raised, deliberately not fixed

**1. Deployment config contradicts the documentation (pre-existing).** Live is
`Execute as: Me (hello@steinsandvines.ca)` + `Who has access: Anyone`; both
`docs/APPS_SCRIPT.md` and `adminApi.gs`'s own header say it MUST be
`User accessing the web app` + `Anyone with Google Account` (marked CRITICAL). Consequence:
`Session.getActiveUser().getEmail()` returns empty, making that limb of `checkAuthorization`
**dead code in production**. Not an open endpoint — real authorization rests on the
OAuth-token path and the server-token bypass, both working — but the documented security
model is not the deployed one, and any future read path relying on `Session`-derived identity
alone would be unauthenticated. Untouched: it is a production auth boundary, outside this
plan's scope, and changing it could break the admin panel. Needs its own investigation.

**2. 81-06 is an enhancement, not a greenfield build.** A D-15-style blast-radius warning
already ships: "Apply template changes to 1 active batch? Completed tasks will not be
changed." 81-06's executor should read the existing implementation first rather than adding
a competing dialog.

**3. Two Apps Script projects are both named "SV Website".** The correct one (script ID
`1uD14…jC0KTvUH`) contains `Code.gs`, `trackEvent.gs`, `adminApi.gs`, `backup.gs`. Recorded
in the RUNBOOK.

## Key files

- `.planning/phases/81-.../81-SCHEDULES-INVENTORY.md` — inventory, branch decision, deploy
  record, drift check, all four probe results
- `docs/RUNBOOK.md` — new Apps Script deploy/rollback section + deploy record

## Self-Check: PASSED

- Task 1 acceptance: file exists (136+ lines), per-schedule table with all four required
  columns, literal `Branch A` decision, all three recipe IDs mapped, `grep -c "server_token="`
  returns 0, sanity-check against ~21d/~35d recorded.
- Task 2 automated verify: `grep -qi 'rollback' 81-SCHEDULES-INVENTORY.md && grep -q 'Phase 81' docs/RUNBOOK.md` → PASS.
- must_haves: FermSchedules contents are a recorded fact with raw data attached; deployment
  live with the previous version written down; `get_recipes` and `get_ferm_schedules` both
  verified `ok` post-deploy; 81-08 knows it is executing Branch A.
- No STATE.md / ROADMAP.md edits (orchestrator-owned).

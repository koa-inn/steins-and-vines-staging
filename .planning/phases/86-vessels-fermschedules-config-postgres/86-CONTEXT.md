# Phase 86: Vessels + FermSchedules + Config → Postgres - Context

**Gathered:** 2026-10-07
**Status:** Ready for planning

<domain>
## Phase Boundary

DB-05. The three hand-edited-only sheets (Vessels, FermSchedules, Config) get real Postgres tables
AND the admin screens that make hand-editing unnecessary:
- `vessels`, `ferm_schedules` (`steps jsonb`, real booleans, `FS-` IDs) and the staff allowlist
  (from Config) exist and are backfilled with every existing row parsing (every `steps` blob validated).
- A Vessels admin screen (add / edit / archive); BrewPad and admin dropdowns read from it;
  `setVesselStatus` goes through the store flag.
- A Staff Access screen manages the auth allowlist; `server_token` lives only in Railway env vars
  (and Apps Script Script Properties on the receiving side), never in sheet data; ASVS L1 security
  review signs off the allowlist change path.
- Ferm-schedule create / update / delete / propagate are transactional with sequence-backed IDs
  (the lock-free ID collision is gone); dual, then flip.

Same migration shape as Phases 84/85: store flag `sheets → dual → postgres`, production keeps a
fire-and-forget sheet mirror, staging never mirrors, backfill/verify/replay tooling, staging
rehearsal before production.

</domain>

<decisions>
## Implementation Decisions

### Staff Access screen
- **D-01:** The live staff sign-in list moves to a Postgres staff table edited by the screen.
  `STAFF_EMAILS` stays in Railway as a **short owner-only break-glass list that can always sign in**,
  so a bad edit or a database problem can never lock everyone out.
- **D-02:** Only **owner accounts** can see the Staff Access screen and change the list. Regular staff
  cannot grant access to themselves or others.
- **D-03:** Safeguards enforced server-side (not just in the UI):
  - an owner cannot remove their own row;
  - the last remaining owner cannot be removed;
  - removing someone **invalidates their open admin/BrewPad sessions immediately** (not at expiry);
  - every add/remove/role change is written to an **audit log** (who, whom, what, when).
- **D-04:** The `staff_emails` row in the Config sheet is **retired**: stop relying on it, leave a note
  in the sheet; the dead Apps Script `checkAuthorization` staff-email limb is removed in Phase 88's
  Apps Script cleanup (not here).

### Vessels screen
- **D-05:** New **Vessels tab in admin** (next to Scheduling / Ingredients). BrewPad keeps reading
  vessels for its dropdowns but gets no editor.
- **D-06:** Editable fields: **name/label, shelf + bin location, type/capacity, and a manual status
  override** (status is normally set automatically by batches; the override is for corrections).
- **D-07:** Retiring a vessel = **archive only, no hard delete**. Archived vessels disappear from
  dropdowns but stay in history; past batches keep pointing at them.
- **D-08:** A vessel's **ID is permanent** once created. Staff change the name/label instead; batches
  and VesselHistory never break.

### Rollout and dual windows
- **D-09:** **One production dual window for all three tables**, switched to dual and flipped together.
- **D-10:** The **staff list is never mirrored** to the shared Google Sheet (security: it is the sign-in
  allowlist). Vessels and ferm schedules mirror like other migrated tables. The planner defines what
  "dual" verification means for the un-mirrored staff list.
- **D-11:** Flip bar same as 84/85: **≥7 consecutive days in dual**, every action observed at least once
  (vessel add / edit / archive / status override, schedule create / edit / delete-or-archive / propagate,
  staff add / remove), **zero unexplained mismatches**.
- **D-12:** **No overlap** with the recipes window: Phase 86's production dual starts only after
  production `RECIPES_STORE=postgres` (one production dual window at a time, same rule as 85's D-08).
  Code, backfill tooling and the staging rehearsal can proceed earlier.

### Ferm schedules behaviour
- **D-13:** Existing schedule IDs are kept (`FS-` format already in use); new IDs come from a sequence.
- **D-14:** If a schedule saves but propagating it to some batches fails (batch tasks stay in the sheet
  until Phase 87), the **schedule change stands** and staff see **which batches did not update, with a
  Retry**. Nothing is silently half-done; no rollback of the schedule.
- **D-15:** Deleting a schedule that recipes or batches still reference is **blocked**; staff are offered
  **archive** instead (hidden from pickers, kept for existing recipes/batches). Unreferenced schedules
  may still be deleted.
- **D-16:** Vessels and ferm schedules get the same **"changed since you opened it" stale-save
  protection** as recipes (85 D-03) in Postgres modes; `sheets` mode behaviour is unchanged.

### Post-research decisions (2026-10-07, answers to 86-RESEARCH.md open questions)
- **D-17:** D-06's "shelf + bin location" means the existing single free-text vessel `location` field
  (trimmed on save/backfill). No new shelf/bin columns on vessels.
- **D-18:** At the production flip, the Config sheet `staff_emails` cell is **blanked** and a note left
  beside it, so a person removed in Staff Access cannot keep direct Apps Script write access via the
  `checkAuthorization` sheet limb. The code removal of that limb stays in Phase 88.
- **D-19:** **Two store flags**: `OPS_DATA_STORE` (vessels + ferm schedules, mirrored in prod) and
  `STAFF_ACCESS_STORE` (staff allowlist, never mirrored). They are still switched to dual and flipped
  together per D-09, but can be rolled back independently.
- **D-20:** If Postgres is unreachable, regular (non-owner) staff **fail closed**: only the
  `STAFF_EMAILS` break-glass owners can sign in / keep working until the database is back. No grace cache.

### Claude's Discretion
- Handling of test data found by research (`FS-0011` test template, `[gfs-probe]` text): backfill as-is
  unless a cleaner approach is clearly safe; surface it in the rehearsal plan.
- When to trim Railway `STAFF_EMAILS` to owners only (research recommends: after the flip, once every
  regular staff member is confirmed present in the new table).
- Table/column design, ID sequences, migration file naming (`0004_*`), store-facade module layout,
  mirror payload shape, and whether vessels/schedules share one store module or get one each.
- Exact UI layout of the two new admin tabs, following existing admin tab patterns.
- Owner/staff role representation (column vs separate table) as long as D-02/D-03 hold.

### Folded Todos
- **Restore staff attribution on admin writes** (`.planning/todos/pending/admin-write-attribution-kiosk-middleware.md`,
  created 2026-09-24). Since Phase 82 every admin write through `POST /api/admin/proxy` is recorded as
  `kiosk-middleware` / `middleware` instead of the staff member. Fix as the todo describes: the proxy
  forwards the session's staff email as a dedicated field (never from `req.body`); Apps Script's
  `server_token` branch uses it as the actor, falling back to `'middleware'`; regression tests for both;
  Apps Script redeploy recorded in the RUNBOOK deploy table. Covers the new Vessels / Staff / schedule
  writes and existing proxied admin writes (batches, vessel moves, tasks). New Postgres-side writes in
  this phase record the real staff email directly.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone and requirement
- `.planning/ROADMAP.md` — Phase 86 goal and success criteria
- `.planning/REQUIREMENTS.md` — DB-05
- `.planning/research/sheets-to-postgres-migration.md` §4 Stage 4, §6 ("Genuinely has no app equivalent": Vessels CRUD, Staff Access screen), conversion traps

### Pattern to copy (Phases 84/85)
- `.planning/phases/85-recipes-recipeingredients-postgres/85-CONTEXT.md` — dual/mirror/stale-save/flip-bar decisions this phase reuses
- `.planning/phases/85-recipes-recipeingredients-postgres/85-12-SUMMARY.md` — staging rehearsal shape and UAT gotchas
- `zoho-middleware/lib/recipe-store.js`, `lib/recipe-pg.js`, `lib/recipe-mirror.js`, `lib/recipe-rules.js` — store facade, atomic SQL layer, mirror worker, rule ports
- `zoho-middleware/scripts/backfill/` (`recipes-backfill.js`, `recipes-verify.js`, `recipes-replay-to-sheet.js`, `README.md`) — backfill / verify / replay tooling
- `zoho-middleware/lib/gift-card-pg.js`, `migrations/0002_*`, `migrations/0003_recipes.sql`, `scripts/migration-allowlist.js` — migration conventions and guards
- `docs/RUNBOOK.md` — Apps Script deploy sequence + deploy record; Phase 84/85 cutover sections

### Auth and security
- `zoho-middleware/routes/auth.js` — Google sign-in, `STAFF_EMAILS` allowlist (D-46-07), sessions
- `zoho-middleware/lib/authTiers.js` — kiosk / session / legacy tiers
- `zoho-middleware/lib/validateEnv.js` — `STAFF_EMAILS`, `APPS_SCRIPT_SERVER_TOKEN`
- `docs/APPS_SCRIPT.md` — Config sheet (staff whitelist, server token) description; note it is partly stale (the server token is read from Script Properties `SERVER_WRITE_TOKEN` / `SERVER_TOKEN`)

### Current sheet-side code
- `apps-script/adminApi.gs` — `getVessels` / `setVesselStatus` (~L2455), ferm-schedule CRUD + `propagateFermSchedule`, `checkAuthorization` + `staff_emails` (~L582–690), `server_token` dispatch in `doPost` (~L262)
- `js/admin.js` — Scheduling tab (ferm-schedule CRUD UI), admin tab patterns
- `js/brewpad.js` — `get_vessels` dropdown consumers (~L3398)
- `docs/DATA-MODEL.md` — FermSchedules and VesselHistory tabs

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- Phase 85 store/pg/mirror/rules modules and backfill/verify/replay CLIs: same structure for vessels + schedules.
- 85-09 browser stale-save handling (`stale_recipe` toast with Reload) in `js/admin.js`: reuse for D-16.
- `routes/auth.js` session store: needed for D-03 immediate session invalidation on staff removal.

### Established Patterns
- Store flag per table (`GIFT_CARDS_STORE`, `RECIPES_STORE`); one flag can cover all three tables here (D-09).
- Production-only fire-and-forget sheet mirror via `lib/sheet-mirror.js`; staging never mirrors.
- Additive-only migrations enforced by `migrate:guard` + parser allowlist.

### Integration Points
- `/api/admin/proxy` for admin writes; the attribution fix (folded todo) lands here.
- Vessel status is written by batch flows (`setVesselStatus`) while Batches remain in the sheet until Phase 87: the store must keep that path working in every mode.
- Ferm-schedule propagate writes batch tasks in the sheet (Phase 87 moves them), hence D-14.

</code_context>

<specifics>
## Specific Ideas

- Break-glass owner list in `STAFF_EMAILS` must work even when Postgres is down.
- Owner-only Staff Access screen; regular staff never see it.

</specifics>

<deferred>
## Deferred Ideas

- Removing the dead Apps Script `checkAuthorization` staff-email limb and the Config `staff_emails` row: Phase 88 Apps Script cleanup.
- Vessel editor in BrewPad: not now (admin only).

### Reviewed Todos (not folded)
- BrewPad adminApiPost retry-once, gated-deploy main-only, gift-card ledger empty-tab bootstrap, kiosk customer auto-clear, card-reader push lag, Kits negative price row, beer waitlist form note, BrewPad bottled refresh, Ready-to-Bottle filter, staging GTM pollution: matched on keywords only, unrelated to this phase.

</deferred>

---

*Phase: 86-vessels-fermschedules-config-postgres*
*Context gathered: 2026-10-07*

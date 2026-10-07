# Phase 86: Vessels + FermSchedules + Config → Postgres - Research

**Researched:** 2026-10-07
**Domain:** Sheets→Postgres store migration (Express middleware + Google Apps Script + ES5 admin/BrewPad editors) plus a new security-sensitive owner-only staff allowlist
**Confidence:** HIGH on code paths, data shapes and reuse (direct reads, file:line, real prod snapshot inspected); MEDIUM on the Apps Script ↔ Postgres vessel-status seam and the session-revocation design (new designs, reasoned from code); see Assumptions Log and Open Questions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Staff Access screen**
- **D-01:** The live staff sign-in list moves to a Postgres staff table edited by the screen. `STAFF_EMAILS` stays in Railway as a **short owner-only break-glass list that can always sign in**, so a bad edit or a database problem can never lock everyone out.
- **D-02:** Only **owner accounts** can see the Staff Access screen and change the list. Regular staff cannot grant access to themselves or others.
- **D-03:** Safeguards enforced server-side (not just in the UI): an owner cannot remove their own row; the last remaining owner cannot be removed; removing someone **invalidates their open admin/BrewPad sessions immediately** (not at expiry); every add/remove/role change is written to an **audit log** (who, whom, what, when).
- **D-04:** The `staff_emails` row in the Config sheet is **retired**: stop relying on it, leave a note in the sheet; the dead Apps Script `checkAuthorization` staff-email limb is removed in Phase 88's Apps Script cleanup (not here).

**Vessels screen**
- **D-05:** New **Vessels tab in admin** (next to Scheduling / Ingredients). BrewPad keeps reading vessels for its dropdowns but gets no editor.
- **D-06:** Editable fields: **name/label, shelf + bin location, type/capacity, and a manual status override** (status is normally set automatically by batches; the override is for corrections).
- **D-07:** Retiring a vessel = **archive only, no hard delete**. Archived vessels disappear from dropdowns but stay in history; past batches keep pointing at them.
- **D-08:** A vessel's **ID is permanent** once created. Staff change the name/label instead; batches and VesselHistory never break.

**Rollout and dual windows**
- **D-09:** **One production dual window for all three tables**, switched to dual and flipped together.
- **D-10:** The **staff list is never mirrored** to the shared Google Sheet (security: it is the sign-in allowlist). Vessels and ferm schedules mirror like other migrated tables. The planner defines what "dual" verification means for the un-mirrored staff list.
- **D-11:** Flip bar same as 84/85: **≥7 consecutive days in dual**, every action observed at least once (vessel add / edit / archive / status override, schedule create / edit / delete-or-archive / propagate, staff add / remove), **zero unexplained mismatches**.
- **D-12:** **No overlap** with the recipes window: Phase 86's production dual starts only after production `RECIPES_STORE=postgres` (one production dual window at a time, same rule as 85's D-08). Code, backfill tooling and the staging rehearsal can proceed earlier.

**Ferm schedules behaviour**
- **D-13:** Existing schedule IDs are kept (`FS-` format already in use); new IDs come from a sequence.
- **D-14:** If a schedule saves but propagating it to some batches fails (batch tasks stay in the sheet until Phase 87), the **schedule change stands** and staff see **which batches did not update, with a Retry**. Nothing is silently half-done; no rollback of the schedule.
- **D-15:** Deleting a schedule that recipes or batches still reference is **blocked**; staff are offered **archive** instead (hidden from pickers, kept for existing recipes/batches). Unreferenced schedules may still be deleted.
- **D-16:** Vessels and ferm schedules get the same **"changed since you opened it" stale-save protection** as recipes (85 D-03) in Postgres modes; `sheets` mode behaviour is unchanged.

### Claude's Discretion
Table/column design, ID sequences, migration file naming (`0004_*`), store-facade module layout, mirror payload shape, and whether vessels/schedules share one store module or get one each. Exact UI layout of the two new admin tabs, following existing admin tab patterns. Owner/staff role representation (column vs separate table) as long as D-02/D-03 hold.

### Folded Todo
**Restore staff attribution on admin writes** (`.planning/todos/pending/admin-write-attribution-kiosk-middleware.md`). Since Phase 82 every admin write through `POST /api/admin/proxy` is recorded as `kiosk-middleware` / `middleware`. Fix: the proxy forwards the session's staff email as a dedicated field (never from `req.body`); Apps Script's `server_token` branch uses it as the actor, falling back to `'middleware'`; regression tests for both; Apps Script redeploy recorded in the RUNBOOK deploy table. New Postgres-side writes in this phase record the real staff email directly.

### Deferred Ideas (OUT OF SCOPE)
- Removing the dead Apps Script `checkAuthorization` staff-email limb and the Config `staff_emails` row: Phase 88.
- Vessel editor in BrewPad: not now (admin only).
- Reviewed, not folded: BrewPad adminApiPost retry-once, gated-deploy main-only, gift-card ledger empty-tab bootstrap, kiosk customer auto-clear, card-reader push lag, Kits negative price row, beer waitlist form note, BrewPad bottled refresh, Ready-to-Bottle filter, staging GTM pollution.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-05 | Vessels, FermSchedules, Config in Postgres with a Vessels admin screen and a Staff Access screen; `server_token` in Railway env only; security review on the allowlist path; schedule IDs sequence-backed | Schema (Pattern 1), store facades (Pattern 2), vessel-status seam (Pattern 4), ferm-schedule port + propagate (Pattern 5), staff allowlist + sessions (Pattern 6), mirror (Pattern 7), backfill/verify (Pattern 8), admin UI patterns (Pattern 9), attribution fix (Pattern 10), Security Domain |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Frontend is static ES5 (`js/admin.js`, `js/brewpad.js`: no arrow functions / `let` / `const` / template literals). Middleware code in this repo is also ES5-style (`var`, `function`).
- Before every commit: root `npm test` AND `cd zoho-middleware && npm test`, plus `npm run lint` (middleware lint is `--max-warnings 0` over `routes/ lib/ scripts/ server.js`). Never commit failing tests.
- **Do NOT modify existing tests** (rule 10). `sheets` mode (flag unset) must leave `routes/pos.js` proxies, `routes/recipes.js`, and Apps Script action behaviour byte-identical for the existing suites (`admin-proxy.test.js`, `batch-admin-proxy.test.js`, `adminapi-propagate-ferm-schedule.test.js`, `adminapi-phase82-dispatch.test.js`, `admin-schedule-blast-radius.test.js`, `recipes.test.js`). All new coverage goes in NEW test files.
- Bug-fix rule (regression test first) applies to the attribution fix and anything found while building.
- Never edit `js/main.js` / `js/main.min.js`. After editing `js/admin.js` / `js/brewpad.js` run `npm run build` so `*.min.js` regenerate (artifact-drift CI).
- After changing shared utilities (`zoho-middleware/lib/*.js`, notably `authTiers.js`, `session.js`, `store-flag.js`) run the FULL suites for both frontend and middleware.
- Security: no `.env`/credentials committed; **no new third-party domain is introduced, so CSP is untouched** (the new tabs call the existing middleware origin).
- Deployment: staging first; the Apps Script deployment is **shared by staging and production** (no isolation) — every new action must be additive.
- Global rule: `gemini` CLI is broken — this research used grep + Read.

## Summary

Phase 86 is the Phase 85 migration shape applied three more times, plus one genuinely new thing: an owner-only, audited, session-revoking staff allowlist. The mechanical parts map cleanly (facade → atomic PG module → production-only state-copy mirror → backfill/verify/replay CLIs → RUNBOOK + DUAL-LOG). Real production data (snapshot `~/sv-backfill/prod-after.xlsx`, 2026-10-06) is small and clean: **232 vessels, 11 ferm schedules (all `steps` parse, each has exactly one packaging step), 3 Config rows**. No rejects are expected except data-hygiene decisions listed below.

The hard parts are seams, not SQL. (1) **`setVesselStatus` is called only from inside Apps Script batch flows** (`createBatch`, `updateBatch`, `deleteBatch`, `updateBatchTask` transfer, packaging completion/undo) while Batches stay in the sheet until Phase 87 — so "goes through the store flag" needs a mechanism for Apps Script to report vessel-status changes back to the middleware (recommended: Apps Script collects `{vessel_id,status}` deltas per request and returns them in the response; the middleware applies them to Postgres in the one shared forwarding helper). (2) **Apps Script `createBatch` reads the schedule's steps from the FermSchedules sheet** and `get_batch_init` embeds schedules, and `routes/recipes.js` fetches schedules straight from Apps Script — all three must be redirected to the store or staging/production will disagree. (3) **Sessions are keyed by opaque sid only** (`lib/session.js`), so "invalidate on removal" is best met by re-validating the allowlist on every session request in `authTiers.resolveTier` rather than building an email→sid index. (4) The Apps Script OAuth `checkAuthorization` limb still honours the **Config `staff_emails`** sheet row; leaving it populated means a removed staff member can still call Apps Script directly with their own Google token — this is a block-on-high finding for the ASVS review unless the sheet value is blanked at cutover (needs owner sign-off; see Open Questions).

Two findings correct the CONTEXT/docs: the production Config sheet **does not contain `server_token`** (keys are only `staff_emails`, `hold_expiry_hours`, `google_calendar_id`; the doc text in `docs/APPS_SCRIPT.md` is stale) so SC3 for the secret is a verify-and-document task; and **vessels have no shelf/bin columns** (shelf_id/bin_id live on batches; the vessel row has a free-text `location`), so D-06's "shelf + bin location" needs a one-line interpretation (Open Question 1).

**Primary recommendation:** Build `0004_ops_data.sql` (vessels, ferm_schedules, config, staff_access, staff_access_audit) behind two store flags (`OPS_DATA_STORE` for vessels+schedules+config, `STAFF_ACCESS_STORE` for the allowlist, both switched together per D-09), reuse the 85 facade/mirror/backfill shapes, serve `get_vessels`/`get_ferm_schedules`/`get_batch_init` schedules from Postgres via an overlay inside the two existing proxies, return vessel-status deltas from Apps Script, re-check the allowlist per request, and ship Apps Script v61 as one additive deploy that also carries the `acting_user` attribution fix.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Vessel/schedule/staff persistence, ID minting | Database (Postgres) | API (`*-pg.js`) | One transaction per mutation; sequence-backed `FS-` ids |
| Mode dispatch + Apps-Script-shaped responses | API (`lib/*-store.js`) | — | Same facade pattern as `recipe-store.js` |
| Staff authorisation decision (allow? owner?) | API (`lib/staff-access.js` used by `authTiers` + `/auth/google`) | Database | Must be server-side per request; break-glass env needs no DB |
| Owner-only route guard + safeguards (self/last-owner) | API (`routes/staff-access.js`, PG tx) | Browser (hide tab) | UI hiding is cosmetic; D-03 enforced in the transaction |
| Session revocation on removal | API (per-request re-check in `resolveTier`) | Redis (sessions unchanged) | No email→sid index exists; stateless re-validation is robust to Redis loss |
| Vessel status changes from batch flows | Apps Script (originates) | API (applies to PG) | Batches stay in the sheet until Phase 87 |
| Schedule steps used by `createBatch` | API (injects steps) | Apps Script (consumes) | Don't depend on mirror lag or the shared workbook on staging |
| Propagate to batch tasks | Apps Script | API (loads steps from PG, relays result) | Tasks live in the sheet until Phase 87 (D-14) |
| Sheet mirror (vessels, schedules) | API worker (prod only) | Apps Script (`mirror_*` actions) | Postgres authoritative; Apps Script only writes cells |
| Stale-save UX | Browser (admin.js, brewpad.js) | API 409 | Server enforces; editors show reload toast |
| Config/secrets | Railway env | Apps Script Script Properties (receiver copy) | Never in a table or sheet |

## Standard Stack

No new packages. Everything is already installed and pinned (verified in Phase 85 research and unchanged): `pg` 8.23.1 via `lib/db.js` only, `node-pg-migrate` 9.0.0, `exceljs` 4.4.0 (devDependency, backfill CLIs only), `@testcontainers/postgresql` 11.14.0 (`postgres:18-alpine` harness), Jest ^29.7.0. [CITED: `.planning/phases/85-recipes-recipeingredients-postgres/85-RESEARCH.md` Standard Stack; `zoho-middleware/package.json`]

### Reused in-repo modules
| Module | Purpose | Use |
|--------|---------|-----|
| `lib/store-flag.js` | `resolveStoreMode(name)`; `STORE_ENV_NAMES` | append `OPS_DATA_STORE`, `STAFF_ACCESS_STORE` (one line); `server.js:174 isDatabaseRequired()` already iterates the list |
| `lib/sheet-mirror.js` | `mirrorFireAndForget`, `isMirrorEnabled()` | wrap every sheet leg; also drives the "suppress sheet write on non-prod" flag (Pattern 4) |
| `lib/dual-write-compare.js` | `compareAndReport` | staff dual shadow compare (emails hashed, never raw) |
| `lib/recipe-mirror.js` | per-id chain + Redis dirty marker + 5-min sweep | copy shape into `lib/ops-mirror.js` (entity-keyed) |
| `lib/recipe-store.js` / `recipe-pg.js` | facade/PG split, `strip()`, stale check under `for update` | copy shape for `vessel-*`, `ferm-schedule-*` |
| `scripts/backfill/{read-xlsx,normalize,rejects,backfill}.js`, `specs/ferm-schedules.js` | backfill plumbing; **a FermSchedules rehearsal spec already exists** (header `is_active`→`active`, `last_updated`→`updated_at`, pad 4, jsonb, boolean) | new `ops-backfill.js` CLI; reuse that column list (rename `active` to match final DDL) |
| `scripts/migration-allowlist.js` | additive-only guard; allowed: `CreateStmt`, `IndexStmt`, `CreateSeqStmt`, CHECK/FK/UNIQUE, `nextval lpad lower upper btrim length jsonb_typeof now gen_random_uuid`; **no backslashes in regexes**, no triggers/functions/AlterSeq/`select` | `0004` must pass `npm run migrate:guard` |

**Version verification:** no registry lookup needed (no new dependency). Package Legitimacy Audit: no new external packages recommended; slopcheck not run; nothing to gate.

## Architecture Patterns

### System Architecture Diagram

```
 admin.js (Vessels tab, Staff Access tab, Schedule templates)   BrewPad (dropdowns, schedule editor)
        │ x-session-token header                                     │
        ▼                                                            ▼
 ┌──────────────────────────── zoho-middleware ─────────────────────────────────────────────┐
 │ /api guard (server.js): non-GET => resolveTier ; GET => route MUST call requireTiers     │
 │ authTiers.resolveTier: sid -> session{email} -> lib/staff-access.resolve(email)          │
 │      resolve: env STAFF_EMAILS (break-glass owner, no DB) ─ else PG staff_access ─ else deny│
 │ routes/staff-access.js  (session tier ONLY, owner only, header-token only) ─► PG tx + audit│
 │ routes/vessels.js       (session tier)  CRUD + archive + status override ─► vessel store   │
 │ routes/pos.js proxies   get_vessels / get_ferm_schedules / get_batch_init(schedules)        │
 │       overlay ─► store; create/update/delete/archive/propagate_ferm_schedule ─► store       │
 │       every forwarded write: + acting_user, + collect flags; response.vessel_status_changes │
 │       ─► vessel store.applyStatusChanges                                                    │
 │ lib/vessel-store.js / ferm-schedule-store.js   mode: sheets | dual | postgres               │
 │       sheets  ─► Apps Script exactly as today                                               │
 │       dual/postgres ─► *-pg.js (one tx) ──► [prod only] ops-mirror worker (state copy)      │
 └───────────┬───────────────────────────────────────────────┬──────────────────────────────┘
             ▼                                               ▼ mirror_vessel_state, mirror_ferm_schedule_state/_delete,
   Postgres: vessels, ferm_schedules, config,                  ferm_schedule_ref_count, propagate_ferm_schedule (steps from PG)
   staff_access, staff_access_audit                          Apps Script adminApi.gs v61 (shared staging+prod)
   Owner Mac CLIs (Railway tunnel): ops-backfill → ops-verify (fresh .xlsx) → ops-replay-to-sheet
```

### Recommended Project Structure
```
zoho-middleware/
├── migrations/0004_ops_data.sql
├── lib/vessel-pg.js, vessel-store.js
├── lib/ferm-schedule-pg.js, ferm-schedule-store.js, ferm-schedule-rules.js   # steps validator shared with backfill
├── lib/ops-mirror.js                      # entity-keyed (vessel|ferm_schedule) mirror-latest worker + sweep
├── lib/staff-access.js, staff-access-pg.js   # resolve(email), owner ops, audit
├── routes/vessels.js, routes/staff-access.js
├── scripts/backfill/ops-backfill.js, ops-verify.js, ops-replay-to-sheet.js, specs/vessels.js, specs/config.js
└── __tests__/ (new files only) + __tests__/db/ (real-PG)
apps-script/adminApi.gs                    # v61, additive
js/admin.js (+ admin.html tabs), js/brewpad.js (stale token/code for schedule editor)
docs/RUNBOOK.md                            # "Ops data → Postgres (Phase 86)" + deploy record row
```

### Pattern 1: Schema `0004_ops_data.sql` (derived from the real sheet shapes)

Real headers [VERIFIED: prod-after.xlsx]: **Vessels** `vessel_id,type,material,capacity_liters,status,bottom_diameter_cm,top_diameter_cm,depth_cm,location,brand,notes` (232 rows; 28 physical columns but only 11 headed); **FermSchedules** `schedule_id,name,description,category,steps,is_active,created_at,created_by,last_updated` (11 rows); **Config** two columns key/value (3 rows).

```sql
-- Up Migration  (no backslashes, no functions/triggers; sequences seeded at backfill via setval)
create sequence ferm_schedule_id_seq start 1 minvalue 1;
create sequence vessel_position_seq start 1 minvalue 1;

create table vessels (
  vessel_id text primary key check (vessel_id ~ '^[A-Z]{2,6}-[0-9]{3,}$'),
  position bigint not null default nextval('vessel_position_seq'),   -- preserves sheet order (grouped by type)
  type text not null,
  material text,
  capacity_liters numeric,
  status text not null default 'Empty' check (status in ('Empty', 'In-Use')),
  archived boolean not null default false,
  bottom_diameter_cm numeric, top_diameter_cm numeric, depth_cm numeric,
  location text, brand text, notes text,
  created_at timestamptz,            -- NULL for backfilled rows: the sheet has no created_at, do not invent one
  created_by text,
  updated_at timestamptz not null,   -- app-written, ms precision (D-16 token)
  updated_by text,
  unique (position)
);

create table ferm_schedules (
  schedule_id text primary key
    default ('FS-' || lpad(nextval('ferm_schedule_id_seq')::text, 4, '0'))
    check (schedule_id ~ '^FS-[0-9]{4,}$'),
  name text not null, description text, category text,
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  is_active boolean not null default true,
  created_at timestamptz not null, created_by text,
  updated_at timestamptz not null
);

create table config (                       -- non-secret key/value only
  key text primary key check (key ~ '^[a-z0-9_]+$' and key !~ 'token|secret|password|key'),
  value text not null,
  updated_at timestamptz not null default now(), updated_by text
);

create table staff_access (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$'),
  role text not null check (role in ('owner', 'staff')),
  added_by text not null, added_at timestamptz not null default now(),
  updated_by text, updated_at timestamptz not null default now()
);

create table staff_access_audit (            -- append-only; app never updates/deletes
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_email text not null, target_email text not null,
  action text not null check (action in ('add', 'remove', 'role_change', 'denied')),
  role_before text, role_after text, note text
);
create index staff_access_audit_time_idx on staff_access_audit (occurred_at desc);
-- Down Migration  (drops in reverse)
```
Design notes: `archived` is a **separate boolean** so `setVesselStatus(…, 'Empty')` from a batch can never un-retire a vessel. The sheet's third status value `Disabled/Retired` (1 row: PFB-046, notes "Thrown out") backfills to `archived=true, status='Empty'`; the serializer emits `status:'Disabled/Retired'` for archived rows so **existing dropdown filters (`!status || available || empty`) already hide them with zero JS change**, and old batches' `_vesselsMap` lookups still resolve because `get_vessels` keeps returning archived rows (plus an explicit `archived:true`). Unconstrained `numeric` (diameters like `28.4`, `4.75`) read back with `Number()`; NULL serialises as `''` (Sheets returns `''`). Pin the `~`/`!~` operators against the allowlist in `migrate:guard` early (A_Expr is allowed; confirm `!~` parses). [VERIFIED: allowlist source; ASSUMED the `!~` operator passes — test it first]

### Pattern 2: Facades return Apps Script shapes (copy 85 Pattern 2)
- `get_vessels` → `{ok:true,data:{vessels:[{vessel_id,type,material,capacity_liters,status,bottom_diameter_cm,top_diameter_cm,depth_cm,location,brand,notes}, …]}}` in `position` order, numbers as JS numbers, empty as `''`. Plus extra keys `archived`, `updated_at` (extra keys are safe: consumers read named fields).
- `get_ferm_schedules` → `{ok:true,data:{schedules:[…]}}`, **active only** (today's filter), each `{schedule_id,name,description,category,steps:<JSON string>,is_active:true,created_at,created_by,last_updated,steps_parsed:[…]}`. Emit `steps` as `JSON.stringify(array)` **and** `steps_parsed`; jsonb reorders object keys, so verify/compare steps **parsed**, never string-equal. An internal `includeArchived` read is needed by `enrichFermentDays` (D-15: archived schedules stay valid for existing recipes).
- Write result envelopes identical to Apps Script: `{ok:true,schedule_id}`, `{ok:true,message}`, `{ok:false,error,message}`; new stale/in-use errors map to HTTP 409 with `code` (`stale_vessel`, `stale_schedule`, `schedule_in_use`).
- `sheets` mode: the facade calls Apps Script exactly as the proxies do today (`axios.get` for reads, `axios.post` for writes) so `admin-proxy.test.js` stays green unmodified.

### Pattern 3: Where the interception lives (do not extend the proxy allowlists for CRUD)
`routes/pos.js` has two hardcoded proxies (`/api/batch/admin-proxy` L4091, `/api/admin/proxy` L4164) sharing `forwardToAppsScript` (L4026). Existing UIs call actions by name, so **keep action names** and intercept inside the shared helper path:
1. **Read overlay** (modes ≠ sheets): `get_vessels`, `get_ferm_schedules` answered from Postgres without calling Apps Script; `get_batch_init` forwarded, then `data.schedules` replaced with the PG schedule list (admin.js L5293 uses it).
2. **Write interception**: `create_/update_/delete_ferm_schedule`, `propagate_ferm_schedule` go to the store; new `archive_ferm_schedule` action added to **both** allowlists (in `sheets` mode it forwards as `delete_ferm_schedule`, which is today's soft-deactivate). Existing allowlist tests use local arrays and an `EXCLUDED` list that does not include new names, so adding an action does not break them (re-check the arrays when writing).
3. **Vessel CRUD** (new, no sheet equivalent) as **dedicated routes** `routes/vessels.js`: `GET /api/vessels` (includes archived + `updated_at`), `POST /api/vessels`, `PUT /api/vessels/:id` (fields + status override + `expected_updated_at`), `POST /api/vessels/:id/archive`, `/unarchive`. In `sheets` mode these return 503 `vessels_editor_requires_postgres` and the tab shows an explanatory empty state (no sheet-side CRUD is worth building).
4. **Vessel ID creation**: staff supply `PREFIX-NNN` (validated by the CHECK regex, PK-unique); provide a helper that returns the next free number per existing prefix (prefixes today: MT, BK, CON, PCB, PBCS, PFB, COR, LPD, LFB; 3-digit pad everywhere). Not sequence-backed (IDs are meaningful labels and are also the Zoho item SKUs, see Pitfall 11).
5. **GET routes are skipped by the global `/api` guard** (`server.js:~443 if (req.method === 'GET') return next()`): every new GET route (`/api/vessels`, `/api/staff-access*`) MUST call `authTiers.requireTiers(['session'])` inline, or it is public. This is the single easiest way to ship an auth hole here.

### Pattern 4: `setVesselStatus` through the store flag (the riskiest seam)

Facts [VERIFIED: adminApi.gs]: `setVesselStatus` (L2476) is called only in `createBatch` (L2747, In-Use), `updateBatch` (L2838-2839 location change; L2900-2902 status change), `deleteBatch` (L2951), `updateBatchTask` transfer branch (L3155), `handlePackagingCompletion` (L3327), `handlePackagingUncompletion` (L3357). Reachable via `/api/admin/proxy`, `/api/batch/admin-proxy`, **and the public batch routes** (`/api/batch/public/:id/tasks`, pos.js L4216, customer completes a transfer task). Apps Script cannot reach Postgres.

**Recommended design (additive Apps Script change, v61):**
- Apps Script keeps a request-scoped `_vesselStatusLog = []` (reset at top of `doPost`); `setVesselStatus` pushes `{vessel_id,status}` then proceeds. A single choke point (`_jsonResponse`) attaches `vessel_status_changes` to the response object **only when non-empty** (existing response shapes unchanged otherwise).
- The middleware's shared forwarder sets, **server-side after merging the client body**, `collect_vessel_status:true` and `vessel_sheet_write: sheetMirror.isMirrorEnabled()`; Apps Script skips its own cell write when `vessel_sheet_write === false` (protects the production workbook from staging batch tests — a pre-existing hazard once vessels are PG-authoritative on staging). On production the existing sheet write stays (free redundancy for the permanent mirror).
- After the upstream returns, `vesselStore.applyStatusChanges(changes)` updates `vessels.status` (skip silently for unknown ids, same as the sheet no-op; Sentry warning on PG failure; idempotent "set" semantics so a replay is harmless). Apply **before** responding so the client's next `get_vessels` sees it.
- Apply to every forwarded write (do not enumerate vessel-affecting actions; `bulk_update_batch_tasks` and future paths are covered automatically). Mode `sheets`: do nothing, unchanged.
- Residual risk: Apps Script succeeded but the PG apply failed → drift. Mitigations: Sentry error with vessel id, `ops-verify` flags it, `ops-replay` can re-assert. Accepted; document in the DUAL-LOG "explained differences" template.
- **Status drift is real today** (7 of 232 vessels disagree with active batches in the snapshot: e.g. PCB-009 Empty but In-Use per batches). Verify compares PG to the backfill snapshot / sheet mirror, never to a batch-derived expectation.

### Pattern 5: Ferm schedules — port, propagate, create-batch dependency
- **Create** (`createFermSchedule` L3555): require `name` and `steps`; steps array ≥2; **at least one** `is_packaging === true` (code uses `some`, message says "Exactly one" — port the code, note the discrepancy; all 11 live rows have exactly 1); `sanitizeInput` (port from `lib/recipe-sanitize.js`, already parity-tested in 85) on name/description/category; `created_by` = real staff email (`req.staffEmail`, folded todo); ID from sequence default; `is_active=true`. **Update** (L3607): touch only provided fields; `steps` JSON-parsed; always bump `updated_at`; `select … for update` + `expected_updated_at` compare (strict: missing token ⇒ 409 `stale_schedule`, as 85 resolved). **Archive** = `is_active=false`. **Delete** = hard delete only when unreferenced.
- **Reference check (D-15):** recipes via `recipes.schedule_id` (PG when `RECIPES_STORE≠sheets`, else Apps Script `get_recipes`), batches via a new read-only Apps Script action `ferm_schedule_ref_count` `{schedule_id}` → `{ok,count}` counting **all** batches (any status) with that `schedule_id` (live: FS-0001..0006 and FS-0008 are referenced; recipes reference FS-0008 and FS-0010). Call it **before** opening the PG tx (no row lock across HTTP). Apps Script unreachable ⇒ delete fails closed (502), archive still works. Reuse the exact `recipe_batch_ref_count` seam style (`hasBatchReferences`) so Phase 87 swaps in SQL.
- **Propagate (D-14):** new middleware handler loads steps **from Postgres by id** (ignore client `steps`), calls Apps Script `propagate_ferm_schedule` with a `server_token` payload, and returns `{ok, batches_updated, tasks_*, batches_failed:[{batch_id,error}]}`. `propagateFermSchedule` (L3660) currently has one `try/finally` so a throw aborts the whole run into a generic `server_error`; v61 adds a per-batch `try/catch` that records failures and continues (additive: `adminapi-propagate-ferm-schedule.test.js` must stay green). The schedule save is already committed (separate call, as today's UI does), so "schedule stands, show failures, Retry" = the UI re-POSTs propagate (idempotent: tasks are matched by `step_number`/packaging flag). A failure *inside* one batch can leave that batch partially updated (sheet writes are not atomic); retry converges.
- **`createBatch` needs the steps (L2581, L2618):** it does `findRowById(FERM_SCHEDULES_SHEET_NAME, schedule_id)` and snapshots `schedResult.data.steps`. Once schedules are PG-authoritative, the sheet copy is a prod-only mirror (stale on staging, lagging on prod). Recommended: in the forwarder, for `create_batch` with a `schedule_id` and mode ≠ sheets, resolve the schedule from PG (404-shaped `{ok:false,error:'not_found',message:'Schedule not found: …'}` if absent) and add `schedule_steps_json`; v61 `createBatch` prefers it **only on the `server_token` path** (strip any such field on the staff-OAuth path). Without this, staging rehearsal of "create schedule → create batch" fails.
- **Other schedule consumers to redirect:** `routes/recipes.js fetchFermSchedules` (L176-205, direct `axios.get` to Apps Script, Redis `FERM_SCHEDULES` 300 s) → store read with `includeArchived:true`, cache bypassed/busted in PG modes; BrewPad `get_ferm_schedules` (brewpad.js L3399, L9456) and its schedule editor (L9750, L10084) via the proxy overlay; admin.js template UI (L7265, L7484, L7507). `js/admin.js` currently does save-then-propagate as two client calls and shows `showConfirm`; keep that flow, add failure list + Retry.
- Apps Script cache keys to evict in the mirror action: `'gfs'`, `'gbi'` (get_batch_init embeds schedules, which the existing CRUD functions do **not** evict — a pre-existing gap) plus `invalidateSheetCache(FERM_SCHEDULES_SHEET_NAME)`.

### Pattern 6: Staff allowlist, owner-only change path, session revocation

**Resolution function** `staffAccess.resolve(email) → {allowed, role, source}`:
1. Normalise `email.trim().toLowerCase()`. If in env `STAFF_EMAILS` ⇒ `{allowed:true, role:'owner', source:'env'}` **without touching the DB** (break-glass; works with Postgres down — D-01).
2. Else if `STAFF_ACCESS_STORE ≠ sheets`: `select role from staff_access where email=$1` (short timeout). Row ⇒ allowed with that role.
3. Else ⇒ denied. **PG error ⇒ fail closed** (deny + Sentry), only break-glass owners remain; kiosk device-token traffic is unaffected. (Alternative — bounded last-known-good grace — is an owner decision; default recommendation is fail closed. See Open Question 5.)
4. In-process cache of positive results ≤5 s (single Railway instance per project norm), **cleared on every staff mutation** ⇒ revocation is immediate on the instance that performed it; owner-route checks always bypass the cache.

**Wiring (all minimal and lazily required so existing tests with mocked `session` keep passing):**
- `routes/auth.js POST /auth/google` (L94): replace the inline `process.env.STAFF_EMAILS` check with `staffAccess.resolve(email)`; in `sheets` mode `resolve` reduces to today's env-only behaviour.
- `lib/authTiers.js resolveTier` (L124-137): after `session.getSession(sid)` returns a payload, call `staffAccess.resolve(payload.email)`; not allowed ⇒ fall through to `null` (403). Set `req.staffEmail` and `req.staffRole`. This **is** the D-03 "invalidate immediately": every request re-validates, so a removed user's still-valid sid stops working on the next request. Also `session.destroySession` is not needed, but on removal the route may best-effort delete known sids if an index is ever added (not recommended: Redis loss would silently disable revocation).
- `server.js:459` fail-closed check still keys on `process.env.STAFF_EMAILS`; keep `STAFF_EMAILS` in `validateEnv` REQUIRED_IN_PROD (break-glass must exist).
- Role is **never trusted from the session payload**; it is re-derived per request (demotion also immediate).

**Staff Access routes** (`routes/staff-access.js`): `GET /api/staff-access/me` (any session: `{email, role, break_glass}` — drives tab visibility), `GET /api/staff-access` (owner), `POST` add, `PUT /:email` role change, `DELETE /:email`. Guards, in order: `requireTiers(['session'])` (**not** legacy `x-api-key`, which is "full admin everywhere" in `authTiers` and has no identity) → require the credential arrived via the **`x-session-token` header, not the cookie** (a custom header cannot be sent cross-site without CORS preflight ⇒ CSRF-immune; admin.js already attaches it on every middleware fetch, L6-31) → `staffAccess.resolve` role must be `owner` (env break-glass counts) → Origin check as defence-in-depth (if `Origin` present it must be in the existing `allowedOrigins` list; mirror `requireAllowedReferer`) → mutation in **one PG transaction** that also writes the audit row (audit failure aborts the change):
- self-removal/self-demotion rejected (`actor === target`);
- `select … from staff_access where role='owner' for update` then reject if the post-change **effective owner set** (PG owner rows ∪ env break-glass) minus the target would be empty (serialises two owners removing each other);
- email validated/normalised (lowercase, CHECK regex); role ∈ {owner, staff}; break-glass emails are shown read-only and cannot be removed/demoted through the UI;
- denied attempts (non-owner hitting a mutation) write an audit row `action='denied'` and a rate-limited warning (no email in Sentry; log a short hash).

**Dual verification for the un-mirrored staff list (D-10/D-11, planner-defined):** (a) `STAFF_ACCESS_STORE=dual` = PG ∪ env authoritative for decisions, plus a shadow decision against env-only; any "env says allowed, PG says denied" for a **non-removed** user is a bug (missing row); "PG allowed, env denied" is expected after adds (explained via audit rows). (b) `ops-verify` staff leg compares PG emails to the Config snapshot (set equality, masked output) and asserts no `server_token` key exists in the Config tab. (c) Flip checklist: every staff member signed in at least once in dual, one add, one role change, one removal with immediate-403 proof, audit rows present, zero unexplained disagreements. (d) After the flip the owner trims Railway `STAFF_EMAILS` to owners only — do this **last**, after verifying every regular staff member exists in `staff_access`.

**Config sheet `staff_emails` (security, needs owner sign-off):** `checkAuthorization` (adminApi.gs L582-690) still accepts any Google OAuth token whose email is in the sheet row, on `doPost`'s staff switch (L460-560, all write actions) and `doGet`. The deployment is documented as `Execute as: Me / Anyone` (RUNBOOK "Known config drift"), so `Session.getActiveUser()` is dead but the **token/tokeninfo path is live**. D-04 leaves the dead limb until Phase 88, but a staff member removed in the new screen who is still in the sheet keeps direct write access to Apps Script. Recommended Phase 86 control that stays inside D-04 ("stop relying on it, leave a note"): at the production flip the owner **blanks the `staff_emails` value cell and puts the note in the adjacent cell**; the 5-minute Apps Script cache (`staff_emails` key) means it takes effect in ≤5 min. Verified no first-party caller uses the OAuth path any more: admin.js/brewpad.js use the proxies (`delete payload.token`), batch.js uses batch tokens. Add it to the ASVS review as a required mitigation, with a RUNBOOK step and a probe (direct Apps Script call with a staff token returns `unauthorized`).

### Pattern 7: Mirror (vessels + ferm schedules only; never staff)
Copy `lib/recipe-mirror.js` into `lib/ops-mirror.js` with an entity prefix on the Redis marker (`ops:mirror-dirty:vessel:<id>`, `ops:mirror-dirty:fermsched:<id>`), per-entity-id promise chain, read-latest-from-PG at send time, backoff 2 s/10 s/60 s/5 min, Sentry error after exhaustion, 5-minute sweep registered beside `server.js` L923, all inside `sheetMirror.mirrorFireAndForget` (staging: no marker, no call). New Apps Script actions in the `server_token` branch (next to `mirror_recipe_state`, ~L329): `mirror_vessel_state` (header-addressed upsert by `vessel_id`; write archived as status `Disabled/Retired`; preserve unknown extra columns), `mirror_ferm_schedule_state` (upsert by `schedule_id`; write `is_active` as a real boolean, `steps` as `JSON.stringify`), `mirror_ferm_schedule_delete`, `ferm_schedule_ref_count`. Values written verbatim (already sanitised on the PG write; do not re-sanitise). Mirror payload for a vessel is the full row, so a status delta applied via Pattern 4 mirrors with the same worker. `ops-replay-to-sheet.js` (dry-run default, `--apply`) is required for dual→sheets rollback.

### Pattern 8: Backfill / verify / replay (copy 84/85; dedicated CLI, not the generic spec path)
- `ops-backfill.js` reads Vessels, FermSchedules, Config from **one** snapshot; pin all three header rows in a new spec-headers test file (do not edit the existing `spec-headers.test.js`). Rules: vessel ids trimmed, `^[A-Z]{2,6}-[0-9]{3,}$`, duplicate ids rejected (none live), position = 1-based sheet row order; `location` trimmed (live: `"Mobile, Wine Racking "` has a trailing space — verify compares trimmed); `Disabled/Retired` ⇒ `archived=true,status='Empty'`; any other status value rejected; FermSchedules: `normalizeBoolean` (real booleans live; also accept `'TRUE'/'FALSE'`; blank ⇒ reject, because Apps Script treats blank as active and we must not guess), `steps` via shared `ferm-schedule-rules.js` (array, ≥2, ≥1 packaging, step_number/day_offset numeric, title string, booleans) — "every `steps` blob validated"; `schedule_id` `^FS-[0-9]{4,}$` (the existing spec's `pad:4` regex is exactly 4 digits — loosen for `{4,}`); Config: **hard-reject any key matching token|secret|password|key** (and refuse to import `staff_emails`); import `hold_expiry_hours`, `google_calendar_id` only; staff rows: from the Config `staff_emails` value plus an explicit `--owners=a@x,b@y` flag (required, ≥1; no guessing who is an owner), output masked.
- Promote in one transaction with empty-target preconditions, then `setval('ferm_schedule_id_seq', max FS suffix)` (11 today ⇒ next `FS-0012`) and `setval('vessel_position_seq', count)`, in-transaction invariants (counts, owner count ≥1, sequences ≥ max), DB-name prompt, `BACKFILL_DATABASE_URL` only, output = ids/field names/counts (emails masked).
- `ops-verify.js` (read-only tx vs fresh `.xlsx`): vessels per-field (numerics by `Number`, `''≡NULL`, trimmed text, archived↔`Disabled/Retired`), schedules per-field with `steps` compared **parsed**, Config keys, staff set-equality (masked). `ops-replay-to-sheet.js` as Pattern 7.
- Owner data-hygiene decisions **before the dry run** (not auto-fixed): `FS-0011` "ZZ Test Template Phase 82 … safe to delete" (created by `middleware`, referenced by nothing) and the `[gfs-probe]` suffix in FS-0001's description; stray tabs `vessels to export` (233 rows) and `rjs` are ignored (spec binds to the exact sheet name).

### Pattern 9: Admin UI patterns to follow (no UI-SPEC; concrete references)
- **Tab registration:** `admin.html` L122-135 button `<button class="admin-tab-btn" data-tab="vessels">` + panel `<div class="admin-tab-panel" id="tab-vessels">` (panel id is `'tab-' + data-tab`). `initTabNavigation` (admin.js L1184) toggles `.active`. Lazy-load by **wrapping `initTabNavigation`** exactly like the Recipes tab (L8278-8337: `var _x = initTabNavigation; initTabNavigation = function(){ _x(); … btn.addEventListener('click', trigger…Load) }`, one-shot `_loaded/_loading` flags, `initRecipesTab()`-style init).
- **List/table:** `<div class="admin-panel-header"><h2>…</h2><div class="admin-panel-actions">…buttons (.btn, .btn-secondary)…</div></div><div class="admin-table-wrap"><table class="admin-table" id="…">` (see Recipes L446-476; filter row `.admin-filter-row` + `select.admin-select`). Build rows with `escapeHTML` (L5020) — the schedule cards at L7230 interpolate raw values; do not copy that.
- **Modal/form:** `openModal(title, bodyHTML)` / `closeModal()` (L1214/1222; `#admin-modal`); confirm with `showConfirm(message, onConfirm, onCancel)` (L193); inputs use `.admin-inline-input`.
- **Toasts:** `showToast(message, type, opts)` (L132) with `opts.actionLabel/onAction` (used for Reload/Retry), `opts.undo`, `opts.duration`.
- **Stale-save (85-09):** `recipeStatusPreservingJson`, `throwIfStaleRecipe` (sets `err.code='stale_recipe'`), `showStaleRecipeToast(err, onReload)` at admin.js L9077-9101; callers branch on `err.code`. Reuse by generalising into new `*_vessel`/`*_schedule` variants (do not edit the recipe ones). **Gap:** schedule/vessel-via-proxy calls use `handleProxyResponse` (L698-708) which throws `new Error(message)` and **drops `code`/HTTP status**; add `err.code = data.code; err.status = r.status` there (purely additive) so 409s reach the toast. BrewPad `adminApiPost` already propagates `err.status/err.code` (85-09 note).
- **Staff Access tab:** hidden by default; shown after `GET /api/staff-access/me` returns `role:'owner'`. Table: email, role, added by/when, "break-glass (Railway)" read-only chip; actions Add / Change role / Remove with `showConfirm`; server errors (`cannot_remove_self`, `last_owner`) shown via `showToast(…,'error')`.
- **Schedule UI changes:** "Delete this schedule template?" becomes Archive (primary) and Delete (enabled only when the server says unreferenced; a 409 `schedule_in_use` toast offers Archive via `actionLabel`); propagate result renders `batches_failed` with a Retry action.
- Build step: after editing `js/admin.js`/`js/brewpad.js` run `npm run build`. Frontend tests live in `tests/frontend/` (jsdom, `admin-schedule-blast-radius.test.js` shows the IIFE stub harness) — new files only.

### Pattern 10: Attribution fix (folded todo)
- Middleware: in **both** proxies (and the public forwarders do not need it) build the payload as `Object.assign({}, body, {action, server_token})`, then `delete payload.acting_user`, then `if (req.staffEmail) payload.acting_user = req.staffEmail`. `req.staffEmail` is set only for the session tier (`authTiers.js:132`), so `legacy` ⇒ none ⇒ Apps Script falls back to `'middleware'`. Never read it from `req.body`.
- Apps Script `doPost` `server_token` branch (L264-~455): compute `var actor = _actingUser(payload)` once (string, trimmed, ≤254 chars, matches a basic email shape, else `''`) and replace the `'middleware'` literals on the staff-parity actions (`update_batch` L~361, `update_batch_schedule`, `delete_batch`, `bulk_*`, `add_batch_task`, `update_batch_task` → `completed_by`, `create_ferm_schedule`, `update_ferm_schedule`, `propagate_ferm_schedule`, reservations/holds) with `actor || 'middleware'`; `create_batch` keeps `'kiosk-middleware'` when no actor (kiosk path has no session). 17 literal sites counted in L262-430.
- Tests (new files): middleware proxy test (session email injected; client-supplied `acting_user` ignored; legacy ⇒ absent); Apps Script dispatch test in the `adminapi-phase82-dispatch` style (actor passed through, sanitised, fallback). RUNBOOK deploy-table row for v61 (rollback **60**). New PG writes in this phase (`vessels.updated_by`, `ferm_schedules.created_by`, audit `actor_email`) take `req.staffEmail` directly.

### Anti-Patterns to Avoid
- Trusting a role/email from the session payload, a cookie-only owner mutation, or a legacy `x-api-key` on Staff Access routes.
- An unguarded new GET route (global guard skips GET).
- Re-running Apps Script CRUD as the dual sheet leg (85 D-01 rejected it); mirror is state copy only.
- Mirroring the staff list or putting any `*token*`/`*secret*` key in `config`.
- Hard-deleting vessels or letting `setVesselStatus` clear `archived`.
- Editing `adminApi.gs` existing function behaviour beyond the additive items listed; editing existing tests; editing `js/main*.js`.
- Embedding emails in Sentry/log lines (use masked/hash).
- Generalising the recipe mirror into a framework; copy the shape (one entity-keyed module is acceptable because the two entities have identical semantics).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Env flag + boot refusal | New reader | `store-flag.resolveStoreMode` + `STORE_ENV_NAMES` | Already drives `/health database_required` |
| Prod-only sheet leg | `if (env…)` | `sheet-mirror.mirrorFireAndForget` / `isMirrorEnabled()` | Exact-match gate, not overridable |
| Discrepancy reporting | Custom diff | `compareAndReport` | Handles ''/null, TRUE/FALSE, dates; PII-safe |
| Transactions | Own `pg` use | `db.withTransaction` | Only module allowed to import `pg` |
| Locking the owner set | App-level mutex | `select … for update` on owner rows in the same tx | Correct under concurrency |
| ID minting | `max()+1` / lock | column default on `ferm_schedule_id_seq` | Removes the lock-free collision (SC4) |
| Session revocation index | email→sid Redis set | per-request `resolve()` in `resolveTier` | Survives Redis loss; no index to drift |
| Sanitising stored strings | New sanitiser | ES5 port `lib/recipe-sanitize.js` (parity-tested vs `.gs`) | Behavioural identity with Sheets path |
| Backfill plumbing | New reader/normalisers | `read-xlsx`, `normalize`, `rejects`, `backfill` helpers, existing `ferm-schedules` spec | Rejects instead of coerces |
| CSRF protection | Token scheme | require `x-session-token` header + Origin check | Already attached by admin.js/brewpad.js |

**Key insight:** fidelity (response shapes, defaults, sanitisation, ordering, soft-vs-hard delete semantics) and the three cross-system seams (vessel status, schedule steps for `createBatch`, allowlist) are the work; any "improvement" in the PG path surfaces as a false discrepancy.

## Runtime State Inventory (store migration + secrets relocation)

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Sheets `Vessels` (232 rows), `FermSchedules` (11), `Config` (3: `staff_emails`, `hold_expiry_hours`, `google_calendar_id`) in the shared workbook; Redis `FERM_SCHEDULES` cache (recipes.js, 300 s); Apps Script CacheService `gfs`, `gbi`, `staff_emails` (300 s) | Backfill (data migration); Redis/GAS caches die by TTL; mirror action evicts `gfs`/`gbi` |
| Live service config | Apps Script deployment `…DI968g` at **v60** (shared staging+prod); Config sheet `staff_emails` still honoured by dead-but-live OAuth limb | v61 redeploy (additive); owner blanks `staff_emails` value at flip (Pattern 6) |
| OS-registered state | None | None — new Railway env vars only |
| Secrets/env vars | `STAFF_EMAILS` (Railway; becomes break-glass owners), `APPS_SCRIPT_SERVER_TOKEN` (Railway) ↔ Script Property `SERVER_WRITE_TOKEN`/`SERVER_TOKEN`; **no `server_token` row exists in the Config sheet** [VERIFIED: snapshot keys] | New flags `OPS_DATA_STORE`, `STAFF_ACCESS_STORE`; docs fix (APPS_SCRIPT.md L36, L45, L69, L393 claim the token is in the Config sheet); backfill hard-rejects secret-like keys |
| Build artifacts | `js/admin.min.js`, `js/brewpad.min.js` | `npm run build` and commit |

## Common Pitfalls

### Pitfall 1: Existing dropdown filters and "archived"
`get_vessels` consumers build `_vesselsMap` from the full list for old batches' labels (brewpad.js L3419, admin.js) and filter pickers by status. If archived vessels are dropped from the response, historic batch rows lose their vessel label. Return them, with status `Disabled/Retired`.

### Pitfall 2: Vessel status vs batches is already inconsistent
7 mismatches in the live snapshot. Do not "fix" at backfill; do not derive expected status in verify.

### Pitfall 3: `get_batch_init` embeds schedules
admin.js loads batches+schedules together (L5293). Overlaying only `get_ferm_schedules` leaves admin showing stale mirror schedules on staging.

### Pitfall 4: GAS caches
`createFermSchedule/update/delete` evict only `'gfs'`, not `'gbi'`. The mirror action must evict both plus the sheet cache; `findRowById` uses the per-request `_sheetCache`.

### Pitfall 5: jsonb key order
`steps` round-trips through jsonb with reordered keys; `schedule_snapshot` on batches is a separate raw copy and unaffected. Compare parsed.

### Pitfall 6: Sequence format vs pad
Backfill regex from the 83 spec is `FS-\d{4}` exactly; sequence format `lpad(…,4,'0')` yields `FS-10000` after 9999 — the CHECK/regex must allow `{4,}`.

### Pitfall 7: Delete semantic change
Today's `delete_ferm_schedule` is a soft deactivate with the label "Delete". New: delete is hard + guarded; archive is the soft one. Update UI copy; in `sheets` mode the `archive_ferm_schedule` action maps to the old soft behaviour.

### Pitfall 8: Archived schedule and `enrichFermentDays`
Recipes referencing an archived schedule must still show `ferment_days` (D-15). Today (soft delete) they silently lose it. Read with `includeArchived:true`.

### Pitfall 9: `Object.assign({}, body, …)` spoofing
Both proxies merge the client body into the payload. `acting_user`, `collect_vessel_status`, `vessel_sheet_write`, `schedule_steps_json` must be set/deleted **after** the merge, server-side only.

### Pitfall 10: Revocation timing and caches
A positive-result cache in `staff-access.resolve` must be cleared on every mutation, and owner-route authorisation must bypass it. If the service ever runs >1 instance the ≤5 s bound applies to the other instance (documented acceptance).

### Pitfall 11: Vessels are also Zoho items
`scripts/import-vessels.js` created one Zoho inventory item per vessel (SKU = vessel id). New vessels added via the screen do not get an item. Out of scope; note in RUNBOOK/UAT so staff are not surprised.

### Pitfall 12: Staging is not isolated for Apps Script
Staging dual with batch flows still writes the production workbook through Apps Script. `vessel_sheet_write:false` on non-production prevents vessel-cell writes; batch/task writes remain a pre-existing staging hazard (use test batches, clean up).

### Pitfall 13: `server_token` in GET query strings
`forwardToAppsScript` sends reads as `axios.get(params: payload)` including `server_token` in the URL query (Google-side logging exposure). Pre-existing; list it in the security review as accepted/low and do not widen it (new Apps Script actions in this phase are POST).

### Pitfall 14: Docker not running locally
`docker info` fails on the dev machine (same as 85). `npm run test:db` self-skips locally, fails on CI without Docker; start Docker Desktop before executing real-PG tasks.

### Pitfall 15: Test-harness mocks
Existing route tests mock `constants`, `cache`, `logger`. New libs must not read missing constants at module load; require `store-flag`/`db` lazily or tolerate mocks (85 precedent). `authTiers` tests mock `session`; `staff-access` must degrade to env-only when `STAFF_ACCESS_STORE` is unset so those pass unmodified.

## Code Examples

### Effective-owner guard inside the removal transaction
```javascript
// Source: pattern per 85 recipe-pg stale check (for update) + D-03; adapt
db.withTransaction(function (client) {
  return client.query("select email, role from staff_access where role = 'owner' for update").then(function (res) {
    var owners = res.rows.map(function (r) { return r.email; });
    var envOwners = staffAccess.breakGlassEmails();
    var effective = owners.concat(envOwners).filter(function (e, i, a) { return a.indexOf(e) === i && e !== target; });
    if (actor === target) return { ok: false, error: 'cannot_remove_self' };
    if (effective.length === 0) return { ok: false, error: 'last_owner' };
    return client.query('delete from staff_access where email = $1', [target]).then(function () {
      return client.query(
        "insert into staff_access_audit (actor_email, target_email, action, role_before) values ($1, $2, 'remove', $3)",
        [actor, target, targetRole]);
    }).then(function () { return { ok: true }; });
  });
});
```

### Per-request revalidation in `resolveTier`
```javascript
// Source: lib/authTiers.js L124-137 (extend, keep fall-through to null)
var payload = await session.getSession(sid);
if (payload) {
  var decision = await staffAccess.resolve(payload.email);   // env break-glass first, then PG; fail closed
  if (decision.allowed) {
    req.staffEmail = payload.email; req.staffRole = decision.role;
    session.touchSession(sid).catch(function () {});
    return 'session';
  }
}
```

### Server-side payload hardening after the body merge
```javascript
var payload = Object.assign({}, body, { action: action, server_token: process.env.APPS_SCRIPT_SERVER_TOKEN });
delete payload.token; delete payload.acting_user; delete payload.schedule_steps_json;
delete payload.collect_vessel_status; delete payload.vessel_sheet_write;
if (req.staffEmail) payload.acting_user = req.staffEmail;
```

## State of the Art

| Old | Current | When | Impact |
|-----|---------|------|--------|
| Allowlist = env var read once at login | PG table + per-request revalidation + env break-glass | This phase | Immediate revocation; auditable changes |
| Sheet-side `max()+1`, unlocked schedule IDs | `FS-` sequence default | This phase | Collision gone |
| Hand-edited Vessels/Config sheets | Admin screens + tables | This phase | Hand-editing unnecessary |
| Docs say server token lives in Config | Railway env ↔ Script Property only (no sheet row) | already true in prod data | Fix docs; add hard-reject guard in backfill |

**Deprecated/outdated:** `docs/APPS_SCRIPT.md` Config/server_token statements; the Phase 83 rehearsal spec's `pad:4` exact-4-digit regex for production use; `docs/DATA-MODEL.md` FermSchedules ("steps stored as child rows") — real storage is one JSON string cell.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | D-06 "shelf + bin location" maps to the vessel's free-text `location` field (and optionally the other descriptive columns); shelf_id/bin_id stay batch attributes (they are batch columns; vessels sheet has none) | Summary, Pattern 3 | If owner wants per-vessel default shelf/bin, add columns (not in sheet ⇒ mirror/verify skip them) |
| A2 | Two flags (`OPS_DATA_STORE`, `STAFF_ACCESS_STORE`) set together at cutover satisfy D-09; separate flag gives the staff list an independent safe rollback | Summary | If owner insists on literally one flag, collapse to one (loses independent rollback) |
| A3 | Vessels editor is Postgres-modes only; `sheets` mode shows an empty state | Pattern 3 | If sheets-mode editing is needed, build sheet CRUD (not recommended) |
| A4 | PG outage ⇒ fail closed for non-break-glass staff (admin/BrewPad), kiosk unaffected | Pattern 6 | Staff locked out of admin during a DB outage; alternative is a bounded last-known-good grace |
| A5 | Blanking the sheet `staff_emails` value at flip is an acceptable reading of D-04 ("stop relying on it, leave a note") and is required to close the direct-Apps-Script bypass | Pattern 6 | If owner declines, the ASVS review must record a documented residual risk (High) until Phase 88 |
| A6 | Vessel-status deltas returned in the Apps Script response + applied by the forwarder is the right seam (vs Apps Script→middleware callback) | Pattern 4 | Callback design needs an inbound secret + Railway dependency from Apps Script; deltas keep trust one-directional |
| A7 | `createBatch` should receive schedule steps from the middleware (`schedule_steps_json`, server_token path only) | Pattern 5 | Without it, staging rehearsal fails and prod depends on mirror lag |
| A8 | Import `hold_expiry_hours` and `google_calendar_id` into `config` although no code reads them (grep: zero consumers) | Pattern 1/8 | Harmless; owner may prefer to drop them (SC1 says `config` exists) |
| A9 | Missing `expected_updated_at` in dual/postgres is rejected 409 (as 85 resolved), so both editors ship the token before any flag change | Pattern 5/9 | Stale bundle could bypass D-16 if lenient |
| A10 | `!~ 'token|secret|password|key'` CHECK parses under the PG16-grammar allowlist | Pattern 1 | If rejected, drop the CHECK and keep the backfill/app-level guard |
| A11 | Archive of an `In-Use` vessel should be blocked (409) until it is emptied or overridden | Pattern 2 | Staff could archive a vessel with a live batch |
| A12 | Hard-delete a staff row (not soft-delete); audit table keeps history | Pattern 6 | Re-adding after removal has no tombstone (audit has the history) |

## Open Questions

1. **D-06 "shelf + bin" vs reality.** What we know: vessel rows carry `location` (values: Brew House, Storage, Mobile Beer/Wine Racking, blank), not shelf/bin; shelf/bin are per-batch. Recommendation: edit `location` (+ type/material/capacity/dimensions/brand/notes/status override); confirm with owner at plan time. Not blocking.
2. **Blank the Config `staff_emails` value at the production flip?** Recommendation: yes (Pattern 6); needs explicit owner OK because D-04 says "leave a note".
3. **One flag vs two (A2).** Recommend two.
4. **FS-0011 test template and `[gfs-probe]` description** — owner deletes/cleans before the dry run (or accepts importing them).
5. **PG-down behaviour for regular staff (A4).** Recommend fail closed; owner may choose a bounded grace.
6. **When to trim Railway `STAFF_EMAILS` to owners-only** — recommend after flip + verification that every regular staff member is in `staff_access`; the Staff Access screen cannot be the only recovery path.
7. **Timeline.** Production dual for this phase starts only after prod `RECIPES_STORE=postgres` (85-13 prod cutover is "deploy-only tonight", then a ≥7-day window), so prod cutover is at the earliest mid/late October; build + staging rehearsal can proceed now.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all | yes | v20.20.2 | — |
| Docker daemon | `npm run test:db` | no (client 28.0.2; `docker info` fails) | — | start Docker Desktop; local tests self-skip, CI fails without |
| Railway CLI | tunnel for backfill/verify | yes | 5.62.1 | — |
| Railway Postgres staging+prod | dual/postgres | yes (per 83/84/85 records) | PG 18.6 (allowlist parser is PG16 grammar — keep plain DDL) | — |
| Apps Script editor access (owner) | v61 deploy | yes, manual | v60 current (rollback target for v61 = 60) | — |
| Prod snapshot | fixtures/rehearsal | yes `~/sv-backfill/prod-after.xlsx` (2026-10-06; re-download at cutover) | — | re-download |
| `gemini` CLI | — | broken; not used | — | grep + Read |

## Security Domain

> `security_enforcement: true`, ASVS L1, block on high.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Google token verified server-side (`googleVerify`, aud + email_verified); allowlist decision via `staff-access.resolve`; never trust client email |
| V3 Session Management | yes | Opaque 256-bit sids (unchanged); **per-request allowlist revalidation** gives immediate invalidation on removal/demotion; logout unchanged |
| V4 Access Control | yes | Staff Access: session tier only + owner role re-derived server-side + header-token-only + safeguards in tx; every new GET route has inline `requireTiers`; legacy/device tiers rejected |
| V5 Input Validation | yes | `$n` placeholders; ID/email CHECKs; shared steps validator; `sanitizeInput` port; JSON size limit existing |
| V6 Cryptography | no new | no new crypto; secrets stay in Railway env |
| V7 Error/Logging | yes | audit table (who/whom/what/when) written in the same tx; denied attempts audited; masked emails in logs/Sentry |
| V8 Data Protection | yes | `config` rejects secret-like keys; staff list never mirrored to the shared sheet; backfill output masked |
| V13 API / Web Services | yes | Origin check on owner mutations; CORS allowlist unchanged; rate limits via existing `/api` limiter |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Regular staff self-promotes via the screen or by calling the route | Elevation | Owner role checked server-side per request; non-owner mutation ⇒ 403 + audit `denied` |
| Removed staff keeps access via still-valid session | Elevation | `resolveTier` revalidates allowlist every request |
| Removed staff keeps access via Apps Script OAuth limb + sheet row | Elevation | Blank sheet `staff_emails` at flip (Pattern 6) + probe; remove limb in Phase 88 |
| CSRF on owner mutations (cookie SameSite=None in prod) | Tampering | Require `x-session-token` header (not cookie) + Origin allowlist |
| Last/only owner or self lock-out | DoS | Self-removal blocked; effective-owner check under `for update`; env break-glass always works |
| Two owners remove each other concurrently | DoS/Tampering | Serialised by `for update` on owner rows |
| Legacy `x-api-key` reaches Staff Access | Elevation | Route requires session tier, rejects legacy/device |
| Unguarded new GET route exposes staff list/vessels | Info disclosure | Inline `requireTiers` on every GET; test asserts 401/403 unauthenticated |
| Client spoofs `acting_user` / flags / `schedule_steps_json` | Spoofing/Tampering | Set after merge, deleted from client body; Apps Script trusts only the server_token path |
| Secret stored as data (`server_token` in Config) | Info disclosure | No row in prod (verified); backfill and CHECK reject secret-like keys; docs corrected |
| Audit tampering | Repudiation | Append-only by convention; app has no update/delete path; same-tx insert |
| SQL injection / stored XSS in names | Tampering | Parameterised queries; sanitise port; `escapeHTML` on render |
| Formula injection into sheet via mirror (`=…`) | Tampering | Pre-existing in Apps Script writers; mirror must not widen; flag for later hardening |
| `server_token` in GET query for reads | Info disclosure | Pre-existing, low; new actions POST-only |

**Review sign-off input for the ASVS L1 review:** this section + Pattern 6 + the Apps Script limb finding; expected high-severity items to close before sign-off: OAuth-limb bypass (A5), owner-only enforcement tests, revocation test, audit-in-tx test.

## Testing notes (nyquist validation disabled in config; informational)

- Real-PG (`npm run test:db`, new files): migration applies + `migrate:guard`; schedule create concurrency (two parallel creates ⇒ distinct ids); update stale ⇒ rolled back; delete blocked/allowed; vessel archive/unarchive, status delta idempotence; staff add/remove/role change, self-removal, last-owner, concurrent mutual removal, audit rows atomic with change; backfill promote + setval; verify.
- Unit (mocked): store facades by mode (sheets byte-identical), forwarder hardening + overlay + delta apply, `resolve()` (env, PG, PG-error fail-closed, cache clear), `resolveTier` revocation, routes auth matrix (anonymous / device / legacy / staff / owner × GET/POST), mirror worker, `ferm-schedule-rules` against all 11 live `steps`.
- Root jsdom (new files): Vessels tab, Staff Access visibility, stale toast for vessels/schedules, propagate failure list + Retry, archive-instead-of-delete.
- Apps Script (`new Function` harness / fake Sheets runtime, root): `acting_user` pass-through, `vessel_status_changes` collection, `vessel_sheet_write:false`, new mirror actions, per-batch propagate failure, `createBatch` trusted steps.
- Anonymised fixtures only; never commit the xlsx.

## Sources

### Primary (HIGH confidence — direct reads this session)
- `.planning/phases/86-…/86-CONTEXT.md`, `86-DISCUSSION-LOG.md`; `.planning/phases/85-…/85-RESEARCH.md`; `.planning/research/sheets-to-postgres-migration.md` §4 Stage 4, §6; `.planning/notes/sheets-to-postgres-data-conversion.md` §2 traps, §3.4; todo `admin-write-attribution-kiosk-middleware.md`; `.planning/config.json`
- `apps-script/adminApi.gs`: `doGet` L90-130, `handleReadAction` L175-230, `doPost` server_token branch L262-455 and staff switch L460-560, `checkAuthorization` L582-690, `getFermSchedules` L2155, `getVessels`/`setVesselStatus` L2454-2498, `createBatch` L2565-2750 (schedule use L2581/L2618), batch vessel calls L2797-2955, `updateBatchTask` L3125-3160, packaging L3310-3357, ferm-schedule CRUD + propagate L3555-3830, `_invalidateBatchCache` L3913
- `zoho-middleware/routes/auth.js`, `lib/session.js`, `lib/authTiers.js`, `lib/googleVerify.js`, `lib/validateEnv.js`, `lib/store-flag.js`, `lib/sheet-mirror.js`, `lib/dual-write-compare.js`, `lib/recipe-store.js`, `lib/recipe-mirror.js`, `lib/brewpad-integration.js` L235-300, `routes/pos.js` L3985-4240, `routes/recipes.js` L160-205, `server.js` L60-135, L390-520, L870-930, `migrations/0002`, `0003`, `scripts/migration-allowlist.js`, `scripts/backfill/{README.md,normalize.js,specs/ferm-schedules.js,specs/index.js}`, `__tests__/admin-proxy.test.js`, `__tests__/auth-tiers-guard.test.js`
- `js/admin.js` (toast L132, confirm L193, auth wrapper L6-31, proxy helpers L698-745, tab nav L1184, modal L1214, vessels L6485-6570, schedules L7230-7560, Recipes tab L8270-8345, stale helpers L9077-9101), `js/brewpad.js` (vessel use L3398, L6902-6935; schedule editor L9456, L9750, L10084), `admin.html` L122-135, L446-476, `docs/RUNBOOK.md` L255-275, `docs/DATA-MODEL.md` L120-145, `docs/APPS_SCRIPT.md`
- **Production snapshot `~/sv-backfill/prod-after.xlsx` (2026-10-06)**: Vessels (232 rows: types, materials, statuses Empty 208 / In-Use 23 / Disabled/Retired 1, id patterns, trailing-space location, no dup ids, no orphan refs from Batches/VesselHistory, 7 status-vs-batch mismatches), FermSchedules (11 rows, all steps parse, one packaging step each, real booleans, ISO-string timestamps, test row FS-0011), Config (3 keys; no `server_token`), schedule references from Recipes/Batches — read via exceljs; Config values were not printed

### Secondary (MEDIUM)
- Phase 85 summaries as recorded in memory/STATE (85-12 staging rehearsal results, Apps Script v60)

### Tertiary (LOW)
- Behaviour of `!~` in the PG16-grammar allowlist (A10) and single-instance Railway assumption for the ≤5 s cache bound — not verified this session

## Metadata

**Confidence breakdown:**
- Standard stack / reuse: HIGH — no new packages; modules read directly
- Architecture (store/mirror/backfill): HIGH — direct analogue of Phase 85
- Vessel-status seam, schedule-steps injection, session revocation: MEDIUM — new designs from code reading; flagged as A4/A6/A7
- Pitfalls/data shapes: HIGH — verified against real snapshot and source
- Security: MEDIUM-HIGH — threat surface read from code; sign-off belongs to the ASVS review

**Research date:** 2026-10-07
**Valid until:** ~2026-11-06 for code references (re-grep `routes/pos.js` proxy line numbers and `adminApi.gs` offsets if either changes before execution; re-take the snapshot at cutover — vessel statuses and schedule rows will have moved).

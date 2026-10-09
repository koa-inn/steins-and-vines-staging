# Phase 87: Batches + BatchTasks + PlatoReadings + VesselHistory → Postgres - Research

**Researched:** 2026-10-09
**Domain:** Sheets→Postgres store migration (Express middleware + Apps Script + unchanged ES5 BrewPad/admin/batch.html clients), single maintenance-window cutover
**Confidence:** HIGH on Apps Script semantics, caller inventory, data shape (direct reads with line refs, real prod snapshot `~/sv-backfill/prod-after.xlsx` of 2026-10-06 profiled); MEDIUM on freeze/idempotency/mirror/drift-check designs (new designs reasoned from the 84/85/86 code); see Assumptions Log and Open Questions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Design gate**
- **D-01:** The **first plan (87-01) writes `87-DESIGN.md`**: schema, FKs/cascade, indexes mapped to each dashboard/calendar/upcoming/conflict query, the public batch-token read/write path, Zoho reconcile hooks, the mirror shape, and the cutover runbook outline (window, steps, verification, rollback). It ends at a **blocking human checkpoint**; no implementation plan runs until the owner approves it (success criterion 1).

**Cutover window & live sales**
- **D-02:** Production cutover runs **Sunday evening after close**, completed before Monday open.
- **D-03:** Runbook budgets a **2-hour window** (snapshot → backfill → verify counts + dashboard parity → flip → smoke), leaving room for one rollback inside it. The staging rehearsal measures the real duration; if it doesn't comfortably fit, the runbook must say so before the date is set.
- **D-04:** **Sales keep flowing during the window.** Kiosk/online payment and the Zoho invoice proceed normally; batch creation that can't be written during the freeze fails/skips and is **logged**. After cutover, staff run BrewPad's existing **Scan invoices** (`/api/batch/scan-invoices`) to create the missing batches. No new queue/replay code. The runbook includes this scan as a post-window step with the list of invoices taken during the window.
- **D-05:** During the window, BrewPad / admin batch screens / `batch.html` are **read-only**: reads keep working; batch writes return a clear server-side "maintenance until HH:MM" error that existing client error handling already displays. Server-side only, no `brewpad.js` change.

**Go/no-go & rollback**
- **D-06:** **Strict no-go bar inside the window**: any one of these forces rollback to the sheet: a non-empty rejects file, any per-table row-count mismatch, any dashboard number differing from the pre-cutover snapshot, or any failed smoke write (create batch, mark task, add reading, vessel transfer).
- **D-07:** Rollback to the sheet stays a **supported, rehearsed option for one full week** after go-live. After 7 clean days Postgres is the sole record and rollback is retired.
- **D-08:** During that week, a **daily verify run** (Postgres vs mirrored sheet, all four tables) alerts on drift, and **any rollback first runs replay-to-sheet** so no Postgres-era write is lost. Reuse the 84/85/86 verify + replay tooling pattern.
- **D-09:** The window is run by **owner + Claude**: Claude runs the scripted steps and reports each check; the **owner makes the go/no-go call** and does the live BrewPad/kiosk smoke (Google sign-in).

**Sheet after cutover & data fixes**
- **D-10:** **All four tables keep a production fire-and-forget sheet mirror** indefinitely (milestone decision; also required for D-07/D-08). Staging never mirrors.
- **D-11:** Hand data fixes (INV-000171-style backfills) go through **Claude running a reviewed SQL fix**: dry-run SELECT, then the UPDATE in a transaction, logged. The phase adds a short RUNBOOK recipe for this. No new admin edit UI.
- **D-12:** Each of the four mirrored tabs gets a **"mirror only: edits are ignored/overwritten" notice plus protected ranges** (warn on edit), the same pattern 86 used for Config.

**Scope edges & ordering**
- **D-13:** **Production cutover waits for Phase 86's production flip** (`OPS_DATA_STORE=postgres`), so batch create/transfer and vessel status are written in one transaction and the one-production-window-at-a-time rule holds. Design, code, tooling and the staging rehearsal may proceed now.
- **D-14:** The public `batch.html` path stays **identical**: same URLs, same existing tokens (printed QR codes keep working), same read + task-update + add-reading abilities. Tokens must remain retrievable (admin/BrewPad re-display them for QR printing), so they cannot be one-way hashed.
- **D-15:** `create_batch` gets **server-side idempotency** in Postgres (DB constraint / idempotency key, porting and strengthening the sheet dedup guard) so a BrewPad network-retry or a re-sent kiosk hook never produces two batches. No `brewpad.js` change.

### Claude's Discretion
- Table/column design, ID sequences seeded past existing max, migration naming (`0005_*`), store facade layout (one batch store vs per-table), mirror payload shape.
- How the "maintenance" freeze is switched (store-flag value, env var, or Redis key): pick what rolls back fastest.
- How to place the D-12 sheet notice without breaking header-row parsing in backfill/mirror/verify (e.g. a note on the header cell instead of an inserted row).
- Whether dashboard-parity comparison is a script diffing `get_batch_dashboard_summary` / calendar / upcoming JSON before vs after, and what the pre-cutover snapshot captures.
- Handling of test/probe rows found by research in the four tabs: backfill as-is unless clearly safe to drop; surface in the rehearsal plan.
- Cache invalidation for Postgres-backed batch reads (the existing Apps Script `_cachedGet` / `gds` key gaps should not be reproduced).

### Deferred Ideas (OUT OF SCOPE)
- **Waitlist sheet → Postgres:** not assigned to any 82–88 phase but rides the same admin proxy. Owner decision: add it to **Phase 88 scope** (or its own small phase). Update ROADMAP Phase 88 accordingly.
- **Admin batch-edit / correction UI** or a read-only SQL console: not now.
- **Making the public batch page read-only:** not proposed.
- Reviewed todos not folded: `brewpad-bottled-status-stale-ui`, `brewpad-ready-to-bottle-filter` (need `brewpad.js` changes, Phase 69); `brewpad-writes-retry-once` (client change; D-15 covers the riskiest retried write); `admin-write-attribution-kiosk-middleware` (already folded into Phase 86; Postgres batch writes record the real staff email directly).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DB-06 | Batches, BatchTasks, PlatoReadings, VesselHistory in Postgres via an approved design pass and a rehearsed maintenance-window cutover; `js/brewpad.js` unchanged (admin-proxy swap); public batch view and kiosk-sale batch creation intact; dashboard numbers match the pre-cutover snapshot | Behaviour catalogue (§Apps Script semantics), schema (Pattern 1), action/shape inventory (Pattern 2), caller seams (Pattern 3), freeze + flag (Pattern 4), idempotency (Pattern 5), mirror (Pattern 8), backfill/verify/replay/parity (Pattern 9), runbook outline (Pattern 10), Validation Architecture |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Frontend is static ES5; **`js/brewpad.js` must not change in this phase** (no `npm run build` artifacts expected for it). Middleware code in this repo is ES5-style (`var`, `function`, promise chains; `async` is used in `*-pg.js` files, e.g. `vessel-pg.js applyStatusChanges`).
- Before every commit: root `npm test` AND `cd zoho-middleware && npm test`, plus `npm run lint` (middleware lint is `--max-warnings 0` over `routes/ lib/ scripts/ server.js`). Baselines at 86-18: root 2248, middleware 2804, `test:db` 176 (all green).
- **Do NOT modify existing tests** (rule 10). `sheets` mode (flag unset) must leave all existing suites green untouched: `batch-admin-proxy.test.js`, `admin-proxy.test.js`, `ops-proxy*.test.js`, `batch-public.test.js`, `batch-scan-invoices.test.js`, `batch-reassign-customer.test.js`, `batch-reconcile-status.test.js`, `batch-bottling-invite.test.js`, `brewpad-integration.test.js`. All new coverage goes in NEW test files. The one precedent exception: 86 appended to `store-flag.test.js` with explicit owner approval, so adding `BATCHES_STORE` to `STORE_ENV_NAMES` needs the same approval.
- Bug-fix rule (regression test first) applies to anything found while building.
- Never edit `js/main.js` / `js/main.min.js`. No `js/*.js` file needs to change in this phase.
- Shared utilities (`zoho-middleware/lib/*.js`, notably `store-flag.js`, `db.js`, `authTiers.js`) changed => run FULL suites for both frontend and middleware.
- Security: no `.env`/credentials committed. **No new third-party domain is introduced; CSP is untouched.**
- Deployment: staging first (`git push origin main`); production only after staging approval, with the pinned-SHA discipline from 85-13/86 (see Pitfall 12). The Apps Script deployment is **shared by staging and production**, so every Apps Script change must be additive.
- Global rule: `gemini` CLI is broken; this research used grep + Read + a throwaway exceljs profiling script in `/tmp`.

## Summary

Phase 87 is the Phase 85/86 migration shape applied to the four shop-floor tables, with three differences that drive the design: **(1) no dual window**, so correctness has to be proven by rehearsal, a pre-flip dashboard parity gate, and a replay-first rollback; **(2) the data model is genuinely relational** (batch → tasks / readings / history, with cascade, location-conflict reads and invoice-keyed idempotency); **(3) the write paths are spread across more callers than the 17 proxy actions**: the middleware calls Apps Script **directly** (not through the proxies) from at least nine sites, so an `opsProxy`-style intercept alone is not enough. A batch store facade must be the single issuer for all of them (mirroring the "single recipe-action issuer" invariant of Phase 85).

The real production data is small and mostly clean (snapshot 2026-10-06: **202 batches, 1036 tasks, 69 readings, 413 history rows**; 960 rows reported for Batches only because of 758 formatted-but-empty trailing rows that the reader must skip). Research found **three things that would trip the strict D-06 bar if not decided up front**: (a) **4 orphan BatchTasks rows** (`BT-000567..570` reference deleted batch `SV-B-000108`), which a cascade FK will reject, so the rejects file is non-empty unless the owner deletes them from the sheet first; (b) **68 duplicate `(batch_id, step_number)` task pairs** across 25 old completed batches (`SV-B-000002..027`), so a UNIQUE constraint on that pair is impossible and none should be added; (c) the **Batches sheet header is `target_volume_L` (capital L)** while Apps Script writes `target_volume_l` by exact `indexOf`, so those two fields have never been persisted (0 rows populated); the port must decide whether to "fix" that. The DATA-MODEL.md column lists are stale (VesselHistory is `history_id, batch_id, vessel_id, shelf_id, bin_id, transferred_at, transferred_by, notes`; the sheets have 33 / 14 / 9 / 8 columns).

**Primary recommendation:** Build one migration `0005_batches.sql` (4 tables + 4 sequences + tombstone table), one `lib/batch-store.js` facade (flag `BATCHES_STORE` = `sheets|postgres`, dual refused) over `lib/batch-pg.js` (atomic SQL, vessel status applied through `vessel-pg.applyStatusChanges` **inside the same transaction client**), re-point every direct Apps Script batch caller to the facade, freeze writes with an env var read by the facade/proxies (one Railway variable edit + restart, same cost as the flag flip), mirror per-batch bundles via new `mirror_batch_state` / `mirror_batch_delete` Apps Script actions (v62, additive), and gate the flip on a `batches-parity.js` script that diffs the sheet-side and Postgres-side read responses **before** the flag moves.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Batch / task / reading / history persistence, ID minting, cascade | Database (Postgres) | API (`batch-pg.js`) | One transaction per mutation; sequences replace `generateNextId` max+1; FKs replace the 3-sheet delete loop |
| Apps-Script-shaped request/response fidelity | API (`lib/batch-store.js` + serializers) | — | Clients (brewpad.js, admin.js, batch.js) are unchanged; envelope `{ok,data}` for reads, raw object for writes |
| Vessel status on create/transfer/complete/delete | API (same PG transaction as the batch write) | Database (`vessels`) | D-13: `vessel-pg.applyStatusChanges(client, …)` already takes a client; replaces the Apps Script delta seam from 86 |
| create_batch idempotency (D-15) | Database (constraint + advisory lock) | API (maps violation to `duplicate_so_number` / replay) | Must survive retries and parallel creates; callers depend on the `duplicate_so_number` error string |
| Maintenance freeze (D-05) | API (guard in facade + the 3 public routes) | Railway env | Server-side only; reads untouched; client error handling already shows `message` |
| Public token read/write | API (`/api/batch/public/*` → store) | Database | Apps Script was the validator; the store becomes the sole validator (timing-safe token compare, task-belongs-to-batch check) |
| Zoho `cf_batch_status` reconcile reads | API (`brewpad-integration.fetchLiveBatchIndex`, `scan-invoices`) | Database | Switch from `axios.get(get_batches)` to the facade; Zoho write side unchanged |
| Recipe / schedule reference counts | API → SQL (`select count(*)`) | Database | Replaces the Phase 85/86 `hasBatchReferences` Apps Script seams (explicitly marked "Phase 87 swaps in SQL") |
| Propagate ferm schedule to batch tasks | API (`batch-pg.propagateSchedule`) | Database | `propagate_ferm_schedule` mutates BatchTasks, so it must move with the tables |
| Sheet mirror (4 tabs) | API worker (prod only) | Apps Script (`mirror_batch_*`, v62) | Postgres authoritative; Apps Script only writes cells |
| Daily drift check (D-08) | API timer (prod only) + Apps Script read export | Sentry | Reuse mirror-sweep registration pattern |

## Standard Stack

No new packages. Everything is already installed and pinned (Phase 85/86 research, unchanged): `pg` ^8.23.1 via `lib/db.js` only, `node-pg-migrate` ^9.0.0, `exceljs` 4.4.0 (devDependency, backfill CLIs only), `@testcontainers/postgresql` 11.14.0 (`postgres:18-alpine` harness at `__tests__/db/helpers/pg-harness.js:88`), Jest ^29.7.0. [VERIFIED: zoho-middleware/package.json; pg-harness.js]

### Reused in-repo modules
| Module | Purpose | Use in Phase 87 |
|--------|---------|-----------------|
| `lib/store-flag.js` | `resolveStoreMode`, `STORE_ENV_NAMES` | append `'BATCHES_STORE'` (one line); `validateStoreFlags` already enforces DATABASE_URL for dual/postgres. Add a facade-level guard that refuses `dual` (D-… no dual) and refuses `postgres` unless `OPS_DATA_STORE=postgres` (D-13) |
| `lib/vessel-pg.js` `applyStatusChanges(client, changes, opts)` (L289) | atomic vessel status | call with the batch transaction's `client`; afterwards schedule vessel mirror for `result.applied` (as `vessel-store.applyStatusChanges` does) |
| `lib/ferm-schedule-pg.js` `getSchedule(client,id)` / `ferm-schedule-store.getStepsJson` | schedule steps for create_batch | read steps **inside** the batch transaction (no HTTP hop) |
| `lib/recipe-rules.js sanitizeInput` (L17, parity-tested vs `.gs`) | `sanitizeInput` port | use for every field the Apps Script path sanitises (list in Pattern 2) |
| `lib/db.js withTransaction(fn)` | BEGIN/COMMIT/ROLLBACK, pool max 5 | one call per mutation; `client.query('select pg_advisory_xact_lock(...)')` for idempotency |
| `lib/ops-mirror.js` | entity-keyed mirror worker (vessel, fermsched) | add entity `batch` (prefix `ops:mirror-dirty:batch:`), same chain/marker/sweep/backoff; sweep is already registered at `server.js:~934` |
| `lib/sheet-mirror.js` | prod-only gate | wrap every sheet leg (`mirrorFireAndForget`) |
| `scripts/backfill/{read-xlsx,normalize,rejects,backfill}.js`, `ops-backfill.js` shape | plan/promote CLI | copy to `batches-backfill.js` (pure `buildBatchesBackfillPlan`, one-transaction promote with empty-target preconditions) |
| `scripts/backfill/ops-verify.js`, `ops-replay-to-sheet.js` | verify + replay shapes | copy to `batches-verify.js`, `batches-replay-to-sheet.js` |
| `scripts/backfill/specs/{plato-readings,vessel-history}.js` | Phase 83 rehearsal specs | **do not reuse as-is**: `numeric(5,2)` plato/temperature, `numeric(4,2)` ph, `moved_at` naming; they were rehearsal targets, not the final DDL. Reuse the header lists only |
| `lib/stale-token.js isStale` | strict D-16 token | **NOT applicable**: `update_batch` uses a lenient `expectedVersion` (server newer than client => conflict); port that, do not substitute `isStale` |
| `scripts/migration-allowlist.js` | additive-only guard | `0005` must pass `npm run migrate:guard`; see Pitfall 7 for the constructs to pin in Wave 0 |

**Installation:** none. **Version verification:** no registry lookup required (no new dependency). **Package Legitimacy Audit:** no external packages are recommended; slopcheck not run; nothing to gate.

## Architecture Patterns

### System Architecture Diagram

```
 BrewPad (brewpad.js UNCHANGED)      admin.js (UNCHANGED)        batch.html/js/batch.js (UNCHANGED)     kiosk / online checkout
   POST /api/batch/admin-proxy         POST /api/admin/proxy        GET/POST /api/batch/public/:id[/tasks|/readings]   pos.js:1838,2694  checkout.js:682  pos-recipe.js:1219
          │ (21 allow-listed actions)        │ (34 actions)                │ token in query/body, rate-limited        brewpad-integration.createBatchesFromSale / detectRecipeSale
          ▼                                   ▼                             ▼                                           │ + bulk-create (pos.js:3525) + retry sweep
 ┌────────────────────────────────── zoho-middleware ───────────────────────────────────────────────────────────────────┴───────────────────────┐
 │ hardenProxyPayload (acting_user)  ─►  batchProxy.intercept(action,payload,req,res)   [NEW, before opsProxy.intercept]                       │
 │     BATCHES_STORE=sheets  → return false (today's Apps Script forward, byte-identical)                                                          │
 │     BATCHES_STORE=postgres→ freeze guard (writes only) → lib/batch-store.js ─► Apps-Script-shaped envelope                                    │
 │                                                                                                                                                │
 │ Direct callers re-pointed to the facade (sheets mode keeps the exact axios call):                                                              │
 │   createBatch  ◄ brewpad-integration.callAppsScriptCreateBatch (sale hook, retry sweep, bulk-create)                                           │
 │   listAll      ◄ brewpad-integration.fetchLiveBatchIndex ; pos.js scan-invoices dedup                                                          │
 │   updateBatch  ◄ pos.js reassign-customer (expectedVersion) ; stampBottlingInviteSent                                                          │
 │   refCounts    ◄ recipe-store.hasBatchReferences ; ferm-schedule-store.hasBatchReferences ; ferm-schedule-store.propagate                      │
 │                                                                                                                                                │
 │ lib/batch-store.js (mode, freeze, strip, mirror schedule) ─► lib/batch-pg.js (one tx per mutation)                                              │
 │        ├─ vessel-pg.applyStatusChanges(client,…)   same tx (D-13)                                                                              │
 │        ├─ ferm-schedule-pg.getSchedule(client,…)   same tx (create_batch steps)                                                                │
 │        └─ post-commit: ops-mirror.schedule('batch', id) [+ 'vessel', id for applied]  ─► prod only, fire-and-forget                           │
 └───────────────┬──────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────┘
                 ▼                                                              ▼  mirror_batch_state / mirror_batch_delete / export_batch_tabs
   Postgres: batches, batch_tasks, plato_readings,                      Apps Script adminApi.gs v62 (shared staging+prod, additive)
   vessel_history, batch_tombstones (+4 sequences)                       Owner-Mac CLIs (Railway tunnel): batches-backfill → batches-verify →
   FK: tasks/readings/history → batches ON DELETE CASCADE                batches-parity (pre-flip) → batches-replay-to-sheet (rollback)
```

### Recommended Project Structure
```
zoho-middleware/
├── migrations/0005_batches.sql
├── lib/batch-pg.js            # atomic SQL: list/detail/public/dashboard/calendar/upcoming/create/update/delete/schedule/tasks/readings/token/propagate/refcounts
├── lib/batch-store.js         # facade: mode, freeze guard, sheets-mode passthrough helpers, mirror scheduling, strip()
├── lib/batch-rules.js         # pure: serializers (NULL->'', bool, bin_id number), dedup decision, status/vessel transition table, sanitizers
├── lib/batch-proxy.js         # intercept(action,…) for both proxies (sibling of ops-proxy.js)
├── lib/ops-mirror.js          # + entity 'batch' (edit, not new)
├── scripts/backfill/batches-backfill.js, batches-verify.js, batches-parity.js, batches-replay-to-sheet.js, specs/batches.js, specs/batch-tasks.js, specs/plato-readings-final.js, specs/vessel-history-final.js
└── __tests__/ (new files only) + __tests__/db/ (real-PG)
apps-script/adminApi.gs        # v62 additive: mirror_batch_state, mirror_batch_delete, export_batch_tabs, sheet notice/protection setup fn
docs/RUNBOOK.md                # "Batches → Postgres (Phase 87)" + deploy-table row + SQL-fix recipe
```

### Apps Script behaviour catalogue (the port must be identical)

Line refs are `apps-script/adminApi.gs` (current file; CONTEXT's ~L numbers have drifted by ~+60).

| Function (line) | Exact semantics to port |
|---|---|
| `generateNextId` (1657) | `max(numeric suffix)+1`, zero-padded 6. **Reuses a deleted highest ID.** Postgres sequences never reuse; accepted improvement (document). |
| `checkLocationConflict` (1802) | returns first batch whose status lower() in (`primary`,`secondary`) AND `String(vessel_id)==`, `String(shelf_id||'')==`, `String(bin_id||'')==`; skips `excludeBatchId`; returns `''` when `vessel_id` empty. **Pending/complete/disabled batches never conflict.** |
| `getBatches(limit,offset,status)` (1934) | `status` ''/`all` => all; `active` => primary/secondary/**pending**; else equals (case-insens). `total`=all rows, `filtered`=after filter. Adds `tasks_total`, `tasks_done` (count of tasks with completed TRUE). Sort `created_at` desc (string compare; blank last). `limit>0` slice else `offset>0` slice. Strips `access_token`; truncates `start_date` to 10 chars. Returns `{batches,total,filtered}`; envelope `{ok:true,data:…}`. |
| `getBatchDetail` (1992) | `{error:'batch_id required'}` / `{error:'Batch not found: X'}` as **data** (envelope still `ok:true`). Batch row **includes `access_token`** (QR re-display), `start_date` date-only, `schedule_snapshot_parsed` if parseable. Tasks sorted by `Number(step_number)||0`, `due_date` date-only, `completed_at` first 10 chars. Readings sorted `timestamp` asc, `timestamp` first 10 chars. History sorted `transferred_at` **desc**, first 10 chars. Returns `{batch,tasks,plato_readings,vessel_history}`. |
| `handleGetBatchPublic` (2114) | validates `^SV-B-\d{6}$` and `^[0-9a-f]{32}$` (`invalid_token`), `not_found`, token mismatch `invalid_token`, status `disabled` => `batch_disabled`. Strips `customer_email`, `reservation_id`, `access_token`. **Does not strip** `customer_phone`, `notes`, `recipe_snapshot` (parity; flag in Security). Returns `{ok:true,data:{batch,tasks,plato_readings,vessel_history}}`. Apps Script caches 5 s per token (`_getBatchPublicCached`) – not needed in PG. |
| `getTasksCalendar(start,end)` (2198) | `{tasks:[]}` if either date missing. Only tasks of **primary/secondary** batches. A task with a due date is included iff `start<=due<=end`; undated packaging task included only if its batch is "ready" (every non-packaging task completed); undated non-packaging excluded. Row shape: `task_id,batch_id,product_name,customer_name,customer_firstname,customer_lastname,vessel_id,shelf_id,title,due_date,completed(bool),is_packaging(bool),is_transfer(bool)`. |
| `getTasksUpcoming(limit)` (2265) | active batches, **incomplete** tasks only; shape adds `bin_id`, `description`; sort dated ascending, TBD (undated) last (JS sort is stable: ties keep sheet order => order by `due_date nulls last, task_id`); `slice(0,limit)`; proxy default `limit||50`. |
| `getBatchDashboardSummary` (2314) | counts by status (`primaryCount, secondaryCount, completeCount, disabledCount, pendingCount`); for **active-batch** tasks not done: `overdueTasks` (due<today), `tasksDueToday`, `tasksDueThisWeek` (today<=due<=today+7d); `readyToBottle[]` = active batch with an incomplete packaging task AND (all non-packaging done OR packaging due<=today); `bottling_due` = earliest incomplete packaging due; `overdue`; `has_email`; sorted by due (TBD='9999-12-31'), tiebreak `batch_id`; `readyForPackaging`=length; `needsScheduling[]` = pending batches newest `created_at` first; `batchesByMonth` = last 6 calendar months by `start_date` substring(0,7) with `label` 'MMM'. "today"/month keys use **`Session.getScriptTimeZone()`** (Open Question 3). `_isTrue` accepts true/'true'/1/'yes'. |
| `getVessels` (2482), `setVesselStatus` (2508) | Phase 86 owns vessels; batch flows only call `setVesselStatus(id,'In-Use'|'Empty')`; unknown vessel no-ops. |
| `batchDedupDecision` (2566) | with `zoho_so_number`+`product_sku`: `allowed=floor(unit_total)` (default 1, min 1); count existing rows with same trimmed invoice+sku; `count>=allowed` => `{ok:false,error:'duplicate_so_number',message:'SO/invoice X + SKU Y already has N of M batch(es): ids'}`. With invoice but no SKU: any existing row for the invoice => `duplicate_so_number`. No invoice => no guard. |
| `createBatch` (2604) | requires (`product_sku` or `recipe_id`) and (`customer_name` or `customer_firstname`) else `missing_fields`; composes `customer_name` from first/last; **pending** if no `schedule_id` OR no `start_date`; non-pending requires schedule (else `not_found`; steps come from `schedule_steps_json` when injected, else the schedule row) ; `location_conflict` check if `vessel_id`; under lock: dedup (if invoice), new id, 32-hex `access_token` (uuid without dashes), `created_by`=actor (kiosk path `kiosk-middleware`), `last_updated=created_at=now`; `customer_email` blanked when `source==='kiosk'`; `fermentation_started_at` = pending ? '' : `start_date||now`; `source` default `manual`; `schedule_snapshot` = the steps JSON string (raw, un-sanitised); recipe_snapshot raw. Non-pending: one task per step (`step_number||i+1`, `day_offset`, `due_date=calculateDueDate(start_date, day_offset)` blank when `day_offset<0`, flags, `completed` false), **initial VesselHistory row only if any of vessel/shelf/bin present** (`transferred_at=now`, notes `'Initial placement'`), vessel -> `In-Use` if `vessel_id`. Response `{ok,batch_id,access_token,tasks_created[,status:'pending'][,warnings]}`. **Pending batches with a vessel do not mark it In-Use and write no history.** |
| `updateBatch` (2817) | `missing_id`, `not_found`; `expectedVersion` => conflict only if `server.last_updated > expectedVersion` (ms compare) => `version_conflict`; location change (any of vessel/shelf/bin differs as strings) => conflict check (exclude self) => insert VesselHistory with the **old** location, `transferred_at=now`, `transferred_by=userEmail`, notes=`sanitize(updates.transfer_notes)`; if vessel id changed: old -> `Empty`, new -> `In-Use` (**regardless of batch status**); `status` must be in primary/secondary/complete/disabled (**`pending` is not a valid target**) else `invalid_status`; whitelisted fields only (list at L2902: status, vessel_id, shelf_id, bin_id, notes, zoho_so_number, customer_id, customer_name, product_name, customer_firstname, customer_lastname, fermentation_started_at, completed_at, recipe_id, start_date, customer_email, customer_phone, bottling_invite_sent_at, bottling_invite_email) each written as `sanitizeInput(String(v))`; `recipe_snapshot` must be valid JSON, written raw; status transition active<->inactive flips the **current** vessel (`wasActive && !isActive` => Empty; `!wasActive && isActive` => In-Use); pending -> any sets `fermentation_started_at` = updates.fermentation_started_at > updates.start_date > current.start_date > now; always bumps `last_updated`. Returns `{ok,message:'Batch updated',newVersion:now}`. **The check order means a failed status validation can leave the history row and vessel statuses already changed** (non-atomic in Sheets; make it atomic in PG – strictly safer, not observable by clients). |
| `deleteBatch` (2984) | `not_found`; releases `vessel_id` -> Empty (regardless of status); deletes children from BatchTasks, PlatoReadings, VesselHistory, then the batch; `{ok,message:'Batch X deleted'}`. |
| `updateBatchSchedule` (3033) | requires `batch_id` + `schedule_snapshot`; lenient `expectedVersion` (`version_conflict`, message differs from updateBatch); sets `schedule_snapshot=JSON.stringify(steps)`; sets `schedule_id` when provided; reconcile tasks **by step_number**: existing => update title/description/day_offset/due_date/last_updated (does NOT touch flags or `completed`); missing => insert new task; removes **non-completed** tasks whose step is not in the new snapshot. Returns `{ok,tasks_updated,tasks_created,tasks_removed}`. Note a missing `day_offset` in a step yields due `''`/NaN behaviour; validate. |
| `updateBatchTask` (3151) | `missing_id`/`not_found`. `updates.completed` truthy: `completed=true`, `completed_at=now`, `completed_by=actor`; **packaging** => `handlePackagingCompletion`; **transfer** => if `transfer_location` given: internal `updateBatch(vessel/shelf/bin)` **ignoring its result** (a location conflict is silently dropped while the task still completes), else if the batch has a vessel: set it `Empty` (batch keeps `vessel_id`); then **primary -> secondary** auto-advance. Falsy => un-complete (clear fields) and if packaging => `handlePackagingUncompletion`. `updates.notes` => sanitised. Always bumps task `last_updated`. Returns `{ok,message:'Task updated',batch_id}`. |
| `bulkUpdateBatchTasks` (3264) | 1..50 tasks (`invalid_input`/`too_many`); sequential `updateBatchTask`; returns `{ok:true,results:[…per-task…],affected_batch_ids}`; per-task failures are `ok:false` entries, not an overall failure. |
| `addBatchTask` (3287) | requires `batch_id`,`title`; `not_found`; step = max+1; `day_offset` default -1; `due_date` from payload or computed when `day_offset>=0 && start_date`; `is_packaging` always false; `is_transfer` from payload. Returns `{ok,task_id,message:'Task added'}`. |
| `handlePackagingCompletion` (3346) | only if **every non-packaging task of the batch is completed**: batch -> `complete`, `completed_at=timestamp`, `last_updated`, vessel -> Empty. If not all done, nothing happens (task still ends completed). Skips if already complete. |
| `handlePackagingUncompletion` (3380) | status -> `secondary` if any transfer task is completed else `primary`; vessel -> In-Use. **Does not clear `completed_at`.** |
| `addPlatoReading` (3412) | `missing_id`; `degrees_plato` parseFloat, `>40` or NaN => `invalid_value`; at least one of plato/temperature/ph (`invalid_input`); `timestamp` must be `YYYY-MM-DD` if given else `now` (full ISO); ph 0..14; temperature numeric. Row: `reading_id (PR-), batch_id, timestamp, degrees_plato, notes(sanitised), recorded_by, created_at, temperature, ph`. **No check that the batch exists** (PG FK now rejects: new `not_found`-style error needed). Returns `{ok,reading_id}`. |
| `bulkAddPlatoReadings` (3468) | 1..20 readings; per-reading results array; `{ok:true,results}`. |
| `updatePlatoReading` / `deletePlatoReading` (3489/3550) | by `reading_id`; same validators; only plato/timestamp/temperature/ph/notes; `not_found`; delete returns `{ok,reading_id}`. |
| `handleBatchTokenPost` (3565) | public: format check, `invalid_token` if batch missing or token mismatch; allowed actions: `update_batch_task` (**packaging completion blocked: `unauthorized`**; actor `'batch-url'`), `add_plato_reading`, `bulk_add_plato_readings`, `delete_plato_reading` (reading must belong to the batch); else `unauthorized_action`. **It never verifies the task belongs to the token's batch** (a valid token can mutate any task id) and does not check `disabled` for writes. |
| `regenerateBatchToken` (3895) | new uuid-hex token, sets `last_regenerated_at` + `last_updated`, evicts `gbp:` cache; `{ok,access_token}`. |
| `propagateFermSchedule` (3709) | for every **primary/secondary** batch with the schedule_id: match existing tasks (completed wins; packaging matched by flag; regular by step_number), completed => untouched, pending => update in place (incl. `step_number`), missing => insert, unmatched **pending** => delete; per-batch isolation, returns `{ok,batches_updated,tasks_updated,tasks_created,tasks_removed,batches_failed}`; schedule_snapshot on batches is **not** updated. Called today via `ferm-schedule-store.propagate` -> Apps Script; must move to PG. |
| `_invalidateBatchCache` (3992) | keys `gbl gtu gbds gbi gfs gb:<id> gbp:<id>`. Note `get_tasks_calendar` and `get_vessels` are uncached; **`gds` (dashboard summary) is not evicted by any batch write** – the Postgres path has no cache, so none of these gaps are reproduced. |

### Pattern 1: Schema `0005_batches.sql` (derived from real headers)

Real headers [VERIFIED: prod-after.xlsx]:
- **Batches (33):** `batch_id,status,product_sku,product_name,customer_id,customer_name,customer_email,start_date,schedule_id,schedule_snapshot,vessel_id,shelf_id,bin_id,notes,access_token,reservation_id,created_at,created_by,last_updated,last_regenerated_at,source,zoho_so_number,fermentation_started_at,completed_at,customer_firstname,customer_lastname,recipe_id,customer_phone,target_volume_L,scale_factor,recipe_snapshot,bottling_invite_sent_at,bottling_invite_email`
- **BatchTasks (14):** `task_id,batch_id,step_number,title,description,day_offset,due_date,is_packaging,is_transfer,completed,completed_at,completed_by,notes,last_updated`
- **PlatoReadings (9):** `reading_id,batch_id,timestamp,degrees_plato,notes,recorded_by,created_at,temperature,ph`
- **VesselHistory (8):** `history_id,batch_id,vessel_id,shelf_id,bin_id,transferred_at,transferred_by,notes`

Cell types observed (drive column types): `start_date`, task `due_date`, reading `timestamp`: sheet **Date** cells; `fermentation_started_at`: mixed Date (115) and ISO string; `created_at`/`last_updated`/`completed_at`/task `completed_at`/history `transferred_at`: ISO **strings**; `shelf_id` string (A–F), **`bin_id` number (1–36)**, booleans real booleans; `ph` entirely blank, `temperature` 12/69.

```sql
-- Up Migration  (no backslashes in regexes, no functions/triggers, no AlterSeq/select; seeds via setval at backfill)
create sequence batch_id_seq start 1 minvalue 1;
create sequence batch_task_id_seq start 1 minvalue 1;
create sequence plato_reading_id_seq start 1 minvalue 1;
create sequence vessel_history_id_seq start 1 minvalue 1;

create table batches (
  batch_id text primary key
    default ('SV-B-' || lpad(nextval('batch_id_seq')::text, 6, '0'))
    check (batch_id ~ '^SV-B-[0-9]{6,}$'),
  status text not null check (status in ('pending','primary','secondary','complete','disabled')),
  product_sku text not null default '',  product_name text not null default '',
  customer_id text not null default '',  customer_name text not null default '',
  customer_firstname text not null default '', customer_lastname text not null default '',
  customer_email text not null default '', customer_phone text not null default '',
  start_date date,
  schedule_id text references ferm_schedules (schedule_id),    -- NULL for '' ; 2 live non-pending rows are blank, 0 orphans [VERIFIED]
  schedule_snapshot text not null default '',                  -- raw string exactly as stored (not jsonb: sheet text, key order must round-trip)
  vessel_id text not null default '', shelf_id text not null default '', bin_id text not null default '',
  notes text not null default '',
  access_token text not null check (access_token ~ '^[0-9a-f]{32}$'),
  reservation_id text not null default '',
  created_at timestamptz not null, created_by text not null default '',
  last_updated timestamptz not null,                           -- app-written at ms precision; the update_batch expectedVersion token
  last_regenerated_at timestamptz,
  source text not null default 'manual', zoho_so_number text not null default '',
  fermentation_started_at timestamptz, completed_at timestamptz,
  recipe_id text not null default '', recipe_snapshot text not null default '',
  target_volume_l numeric, scale_factor numeric,               -- see Open Question 6
  bottling_invite_sent_at timestamptz, bottling_invite_email text not null default '',
  unit_seq integer                                             -- idempotency, Pattern 5; NULL when no invoice+sku
);
create unique index batches_access_token_idx on batches (access_token);
create index batches_status_created_idx on batches (status, created_at desc);   -- list/active filter + newest-first
create index batches_location_idx on batches (vessel_id, shelf_id, bin_id) where status in ('primary','secondary');  -- conflict check
create index batches_invoice_idx on batches (zoho_so_number, product_sku) where zoho_so_number <> '';  -- scan dedup / reconcile / dedup guard
create index batches_schedule_idx on batches (schedule_id) where schedule_id is not null;  -- ferm_schedule_ref_count / propagate
create index batches_recipe_idx on batches (recipe_id) where recipe_id <> '';   -- recipe_batch_ref_count
create unique index batches_unit_seq_idx on batches (zoho_so_number, product_sku, unit_seq) where unit_seq is not null;

create table batch_tasks (
  task_id text primary key default ('BT-' || lpad(nextval('batch_task_id_seq')::text, 6, '0')) check (task_id ~ '^BT-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  step_number integer not null, title text not null default '', description text not null default '',
  day_offset integer not null, due_date date,
  is_packaging boolean not null default false, is_transfer boolean not null default false,
  completed boolean not null default false, completed_at timestamptz, completed_by text not null default '',
  notes text not null default '', last_updated timestamptz not null
);   -- NO unique (batch_id, step_number): 68 historical duplicate pairs [VERIFIED]
create index batch_tasks_batch_idx on batch_tasks (batch_id, step_number, task_id);
create index batch_tasks_open_due_idx on batch_tasks (due_date) where completed = false;   -- upcoming / overdue / this-week

create table plato_readings (
  reading_id text primary key default ('PR-' || lpad(nextval('plato_reading_id_seq')::text, 6, '0')) check (reading_id ~ '^PR-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  reading_at timestamptz not null,           -- sheet column 'timestamp'; serializer emits first 10 chars of the ISO string
  degrees_plato numeric,                     -- unconstrained numeric (no rounding); NULL <-> ''
  notes text not null default '', recorded_by text not null default '', created_at timestamptz not null,
  temperature numeric, ph numeric
);
create index plato_readings_batch_idx on plato_readings (batch_id, reading_at);

create table vessel_history (
  history_id text primary key default ('VH-' || lpad(nextval('vessel_history_id_seq')::text, 6, '0')) check (history_id ~ '^VH-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  vessel_id text not null default '', shelf_id text not null default '', bin_id text not null default '',
  transferred_at timestamptz not null, transferred_by text not null default '', notes text not null default ''
);
create index vessel_history_batch_idx on vessel_history (batch_id, transferred_at desc);

create table batch_tombstones (            -- deletes during the rollback week; feeds mirror delete + replay (rollback cannot otherwise know what was deleted)
  batch_id text primary key, deleted_at timestamptz not null, deleted_by text not null default ''
);
-- Down Migration  (reverse order)
```

Design notes:
- Text columns are `not null default ''` to mirror Sheets semantics (`''` not NULL) so the serializer is trivial; true date/time/number columns are NULL when blank and the serializer emits `''`. [ASSUMED-design]
- `bin_id` is stored `text` (labels in the sheet are numeric-looking but the Phase 83 spec also treats them as text). **The sheet returns it as a JSON number**, so the serializer must emit `Number(bin)` when it matches `^\d+$` to keep `bin_id` types identical for brewpad.js / admin.js (Open Question 4).
- FKs: children -> batches `ON DELETE CASCADE` (required by success criterion 1). `batches.schedule_id -> ferm_schedules` is a **new strictness** (RESTRICT); data is clean, but `update_batch_schedule` currently accepts any `schedule_id`; the facade must pre-validate and return a clean error (design-gate decision, Open Question 5). No FK on `vessel_id` in the recommendation (sheet accepted any text; 0 orphans today; verify reports orphans).
- `access_token` is stored plaintext (D-14: must be re-displayable). Unique index doubles as lookup safety.
- `schedule_snapshot` / `recipe_snapshot` stay `text` (they are raw copies; `getBatchDetail` re-parses; jsonb would reorder keys — Phase 86 Pitfall 5).
- Location conflict is a **pre-check under lock + non-unique partial index**, not a UNIQUE index, to stay behaviour-identical (the sheet lets `update_batch {status:'primary'}` reactivate a completed batch into an occupied location without a check; a UNIQUE partial index would newly reject it). Offer the strict variant to the owner (Open Question 7).
- `sheetmeta`: no `position` column needed; list order is `created_at desc`, ties `batch_id asc`.

### Pattern 2: Admin-proxy inventory and request/response shapes

CONTEXT says "17 actions". The BrewPad allowlist (`routes/pos.js` `ADMIN_PROXY_ACTIONS`, ≈L4062) has **21 entries** (7 reads, 14 writes): the 12 **batch-domain** actions below plus `get_vessels`, 4 ferm-schedule CRUD, 2 waitlist. The admin allowlist (`ADMIN_PANEL_PROXY_ACTIONS`, ≈L4145) adds 5 more batch-domain actions: `get_batch_init`, `get_tasks_calendar`, `update_batch_task`, `add_batch_task`, `regenerate_batch_token` (+ `propagate_ferm_schedule`, which writes BatchTasks). **12 + 5 = 17 batch-data actions** is the reconciliation of the CONTEXT number. [VERIFIED: pos.js]

| Action | Proxies | Request (after `Object.assign(body,{action,server_token})`, `delete token`, `hardenProxyPayload`) | Success response |
|---|---|---|---|
| `get_batches` | both (GET to Apps Script) | `{status?, limit?, offset?}` (BrewPad: `status:'all'`/`'active'`) | `{ok:true,data:{batches[],total,filtered}}` |
| `get_batch` | both | `{batch_id}` | `{ok:true,data:{batch,tasks,plato_readings,vessel_history}}` (or `data:{error}`) |
| `get_batch_dashboard_summary` | both | — | `{ok:true,data:<summary>}` |
| `get_tasks_upcoming` | both | `{limit?}` (BrewPad 60/100/200; default 50) | `{ok:true,data:{tasks[]}}` |
| `get_tasks_calendar` | admin | `{start_date,end_date}` | `{ok:true,data:{tasks[]}}` |
| `get_batch_init` | admin | `{status?,limit?,offset?}` | `{ok:true,data:{batches:{…},schedules:{schedules:[…]},summary}}` (schedules overlay already served from PG by `ops-proxy.afterUpstream`) |
| `create_batch` | both | see createBatch row; extra fields `schedule_steps_json` set server-side by `ops-proxy.intercept` today (becomes unnecessary: steps read in-tx) | `{ok,batch_id,access_token,tasks_created[,status,warnings]}` / `{ok:false,error,message}` |
| `update_batch` | both | `{batch_id,updates{…},expectedVersion?}` | `{ok,message,newVersion}` |
| `update_batch_schedule` | both | `{batch_id,schedule_snapshot,schedule_id?,expectedVersion?}` | `{ok,tasks_updated,tasks_created,tasks_removed}` |
| `delete_batch` | both | `{batch_id}` | `{ok,message}` |
| `update_batch_task` | admin (+ public route) | `{task_id,batch_id?,updates{completed?,notes?},transfer_location?{vessel_id,shelf_id,bin_id}}` | `{ok,message,batch_id}` |
| `bulk_update_batch_tasks` | both | `{batch_id?,tasks[≤50]}` | `{ok,results[],affected_batch_ids}` |
| `add_batch_task` | admin | `{batch_id,title,description?,day_offset?,due_date?,is_transfer?,notes?}` | `{ok,task_id,message}` |
| `bulk_add_plato_readings` | both (+ public) | `{batch_id,readings[≤20]{timestamp?,degrees_plato?,temperature?,ph?,notes?}}` | `{ok,results[{ok,reading_id}|{ok:false,…}]}` |
| `update_plato_reading` / `delete_plato_reading` | both | `{reading_id,updates{…}}` / `{reading_id}` | `{ok,reading_id}` |
| `regenerate_batch_token` | admin | `{batch_id}` | `{ok,access_token}` |
| `propagate_ferm_schedule` | admin | handled by `ferm-schedule-store.propagate` | `{ok,batches_updated,tasks_*,batches_failed[]}` |
| `get_batch_public` (route) | `GET /api/batch/public/:id?token=` | `{batch_id,token}` | `{ok:true,data:{…}}` / `{ok:false,error:'invalid_token'|'not_found'|'batch_disabled'}` |
| public writes (routes) | `POST …/tasks`, `POST …/readings` | `{batch_token,task_id,updates}` / `{batch_token,readings}` (route builds an explicit field whitelist) | as above |

Error transport: app-level failures are HTTP 200 `{ok:false,error,message}`; transport failures collapse to 502 `{ok:false,error:'server_error'}`. Clients (`adminApiPost`, `handleProxyResponse`) read `data.message || data.error`, so the freeze error only needs `ok:false` + `message`.

### Pattern 3: Every caller that must move to the facade (grep-complete)

| # | Site | Today | After (postgres) | Existing test that must stay green in sheets mode |
|---|---|---|---|---|
| 1 | `pos.js` `/api/batch/admin-proxy`, `/api/admin/proxy` | allowlist -> `opsProxy.intercept` -> `forwardToAppsScript` | `batchProxy.intercept` first | `batch-admin-proxy.test.js`, `admin-proxy*.test.js`, `ops-proxy*.test.js` |
| 2 | `pos.js` `GET /api/batch/public/:id`, `POST …/tasks`, `POST …/readings` (≈L4243–4274) | `forwardToAppsScript` with whitelisted fields | `batchStore.getPublic / publicUpdateTask / publicAddReadings` | `batch-public.test.js`, `batch-public-guard.test.js` |
| 3 | `brewpad-integration.callAppsScriptCreateBatch` (L260) | direct `axios.post` `create_batch`, server_token | `batchStore.create(payload,{actor:'kiosk-middleware'})`; keeps `queueForRetry` on `{ok:false}`; callers: `createBatchesFromSale` (L345), `detectRecipeSale` (L806), retry sweep (L449), `pos.js` bulk-create (≈L3525) | `brewpad-integration.test.js`, `brewpad-recipe.test.js`, `batch-scan-invoices.test.js` |
| 4 | `brewpad-integration.fetchLiveBatchIndex` (L696) | direct `axios.get get_batches status=all` | `batchStore.listAll()` returning the same `{byInvoiceNumber, liveBatchIds}` | `batch-reconcile-status.test.js` |
| 5 | `pos.js` scan-invoices dedup (≈L3337) | direct `axios.get get_batches` | `batchStore.listAll()` | `batch-scan-invoices.test.js` |
| 6 | `pos.js` reassign-customer (≈L3753) | direct `axios.post update_batch` with `expectedVersion`; reads `result.data.last_updated` (**pre-existing bug: Apps Script returns `newVersion`, so `new_version` is always null**) | `batchStore.update({batch_id,expectedVersion,updates})`; 409 on `version_conflict` | `batch-reassign-customer.test.js` |
| 7 | `pos.js stampBottlingInviteSent` (≈L3925) | direct `axios.post update_batch` (advisory) | `batchStore.update(...)` (freeze: log + swallow, it is advisory) | `batch-bottling-invite.test.js` |
| 8 | `recipe-store.hasBatchReferences` (L156) | Apps Script `recipe_batch_ref_count` | `select count(*) from batches where recipe_id=$1` | recipe-store tests |
| 9 | `ferm-schedule-store.hasBatchReferences` (≈L160) | Apps Script `ferm_schedule_ref_count` | `select count(*) from batches where schedule_id=$1` | ferm-schedule-store tests |
| 10 | `ferm-schedule-store.propagate` (≈L229) | Apps Script `propagate_ferm_schedule` | `batchPg.propagateSchedule(client, id, steps)` (same loop, one tx per batch, `batches_failed` preserved) | `adminapi-propagate-ferm-schedule.test.js` (Apps Script side stays) |
| 11 | `ops-proxy.intercept` `create_batch` branch (L82) and `decorateForward`/`afterUpstream` vessel-status seam | steps injected + status deltas applied | unreachable for batch actions once `BATCHES_STORE=postgres` (leave code; add a test that it is not hit) | `ops-proxy*.test.js` |

`createBatchesFromSale` is called from `pos.js:1838`, `pos.js:2694`, `checkout.js:682`; `detectRecipeSale` from `pos-recipe.js:1219`. All four are fire-and-forget; none needs to change if the facade sits behind `callAppsScriptCreateBatch`.

### Pattern 4: Store flag, freeze, and OPS_DATA_STORE interaction

- **Flag:** `BATCHES_STORE` in `STORE_ENV_NAMES`. Modes used: `sheets` (default) and `postgres`. `dual` must refuse to boot (no dual-write by design) with a message naming the variable (the generic validator accepts it, so the guard lives in `batch-store` module init or `server.js` next to `validateStoreFlags`). `postgres` additionally requires `OPS_DATA_STORE=postgres` (D-13) so vessels are PG-authoritative; refuse to boot otherwise. [Design; Phase 83 D-05/D-06 "deploy-time env var, no runtime toggle"]
- **Does `OPS_DATA_STORE` gate anything batch code must respect?** Yes, three seams: (1) `ops-proxy.pgActive()` is `OPS_DATA_STORE != sheets`; with batches in PG the vessel-delta seam (`collect_vessel_status` / `afterUpstream`) is bypassed for batch actions; (2) `create_batch`'s schedule steps come from `ferm-schedule-store.getStepsJson` today; in the batch tx read `ferm-schedule-pg.getSchedule(client,…)` instead; (3) `vessel_sheet_write` / mirror suppression on non-prod already flows through `sheet-mirror.isMirrorEnabled()`; the batch mirror uses the same gate.
- **Freeze (D-05): recommend two env vars read per request** (no new module needed): `BATCHES_FREEZE` = the human text for the error, e.g. `9:00 PM PT` (non-empty => batch **writes** blocked in either store mode), checked at the top of `batchProxy.intercept` (write actions only), the three public routes' write handlers, and `batchStore.create/update`. Reasoning for env over Redis/Postgres row: (a) the flag flip itself already costs a Railway variable edit + ~1 min restart (store-flag.js header), so the freeze never adds a second kind of operation; (b) the flip step can set `BATCHES_STORE=postgres` and unset `BATCHES_FREEZE` in one variable batch => one restart, minimal exposure; rollback is the mirror image (one edit: `BATCHES_STORE=sheets`, `BATCHES_FREEZE` unset after verify); (c) a Redis key would add an outage mode (fail-open = silent split-brain, fail-closed = a Redis blip blocks all batch writes forever); (d) do **not** use a timestamp that auto-expires: an overrunning window would silently re-open sheet writes after the snapshot. Response: HTTP 503 `{ok:false,error:'maintenance',message:'Batches are read-only for maintenance until '+text+'. Please try again then.'}` (BrewPad write retry in `fetchWithRetry` only retries network rejections, not 503; reads are never frozen). `batch.js` shows `data.message` regardless of status. For store-level callers (`create`) return `{ok:false,error:'maintenance'}` so `queueForRetry` / the log line fire (D-04: log, no new queue).
- **Rollback speed:** flag edit + restart (~1 min); since the freeze blocks writes until verified, rollback inside the window needs **no replay** (PG has had no writes beyond the smoke test; delete the smoke batch first or accept replay of it). Post-window rollback = replay first (D-08), then flag edit.

### Pattern 5: create_batch idempotency (D-15)

What exists today: the only key is `(zoho_so_number, product_sku)` with `unit_total` as the allowed count (`batchDedupDecision`, L2566), serialised by `acquireScriptLock`. The callers send `unit_total` per SKU (computed from `planKitBatches`) and fire the creates **in parallel** (`createBatchesFromSale`) or sequentially (bulk-create), with **no per-unit index**. `bulk-create` depends on the exact error string `duplicate_so_number` to treat already-satisfied units as converged (`pos.js` ≈L3537). Manual BrewPad creates (no invoice) have **no guard at all**, and `adminApiPost` retries once on network rejection (`brewpad.js:1765`/`fetchWithRetry` L1711), so a dropped response can create a duplicate manual batch.

Recommended design:
1. **Invoice-linked creates:** inside the create transaction take `pg_advisory_xact_lock(hashtext(zoho_so_number || '|' || product_sku))`, count matching rows, apply the identical `allowed=max(1,floor(unit_total))` rule and return the same `duplicate_so_number` object; assign `unit_seq = count+1`. The partial unique index `(zoho_so_number, product_sku, unit_seq)` is the **DB backstop** (a second writer that somehow bypasses the lock gets a unique violation, mapped to `duplicate_so_number`). Backfill assigns `unit_seq` by `row_number() over (partition by invoice, sku order by created_at, batch_id)` for rows with both fields. Counts today: 123 invoice+sku groups, 16 with >1 unit [VERIFIED].
2. **Manual creates (no invoice):** short-window replay protection keyed on a server-computed fingerprint: `sha256(actor | product_sku | recipe_id | customer_name | start_date | schedule_id | vessel_id | shelf_id | bin_id | notes)`. Recommended storage: a tiny table `batch_create_dedup (fingerprint text primary key, batch_id text, created_at timestamptz)` (add to 0005) with `insert … on conflict (fingerprint) do update set … where batch_create_dedup.created_at < now() - interval '2 minutes' returning`; a conflict inside the window returns the **existing** `{ok:true,batch_id,access_token,tasks_created,idempotent_replay:true}` (extra key is safe) so the retried client sees success. Needs owner confirmation of the window length and of "same payload within 2 min is a replay" (a staff member legitimately creating two identical batches within 2 minutes is the false-positive; location conflict already blocks identical vessel+shelf+bin). [ASSUMED-design]
3. Retried kiosk hook: step 1 covers it (retry queue replays the same payload, `unit_total` and invoice+sku unchanged).

### Pattern 6: Transactions with vessels and cascade

- `batch-pg.createBatch(client, payload, opts)`: (1) validate; (2) `ferm-schedule-pg.getSchedule(client, schedule_id)` for steps (404 `not_found` envelope identical to today); (3) advisory lock(s): dedup lock if invoice; **location lock** `pg_advisory_xact_lock(hashtext('loc|'||vessel||'|'||shelf||'|'||bin))` before the conflict SELECT so two simultaneous creates for the same slot serialise; (4) conflict SELECT with the exact `checkLocationConflict` predicate (status lower in primary/secondary; compare strings; `''` treated equal); (5) insert batch (default id from sequence, `access_token = crypto.randomBytes(16).toString('hex')`), tasks (compute `due_date` in JS from the date-only string: add `day_offset` days, blank when `<0`), initial history row (non-pending only, when any location field), then `vessel-pg.applyStatusChanges(client,[{vessel_id,status:'In-Use'}])` when non-pending and `vessel_id`; (6) return the Apps Script-shaped object; the store schedules mirror(s) after commit.
- `update`/`task`/`delete` similarly: `select … from batches where batch_id=$1 for update` first (serialises concurrent task toggles so the "all non-packaging done" decision in `handlePackagingCompletion` cannot race), collect `vessel changes` into one list and apply with the same `client`.
- **Unknown vessel id** (`applyStatusChanges` returns it in `unknown`) is silently ignored, exactly like the sheet.
- **Deleting a batch**: `insert into batch_tombstones … on conflict do update`, apply vessel `Empty`, `delete from batches where batch_id=$1` (FK cascade removes children). One statement replaces the 3-sheet loop.
- **Cascade vs mirror**: the mirror reads the *current* PG state per batch; a missing row => `mirror_batch_delete` (same null-row convention as `ops-mirror` for schedules).

### Pattern 7: Public token path

- `GET /api/batch/public/:id?token=`: format regexes identical to Apps Script (reject early with `invalid_token`); `select * from batches where batch_id=$1`; compare tokens with `crypto.timingSafeEqual` on equal-length buffers (Apps Script used `!==`); `disabled` => `batch_disabled`; strip `customer_email`, `reservation_id`, `access_token`; same four-part payload.
- `POST …/tasks`: whitelist unchanged; validations: token (as above), packaging completion blocked (`unauthorized`), actor `batch-url`. **Recommended deliberate hardening (flag to owner, Open Question 8):** also require `task.batch_id === batch_id` (Apps Script lets a valid token touch any task). It is the only behaviour change proposed for this path and cannot affect a legitimate page (batch.js only sends its own batch's task ids).
- `POST …/readings`: `bulk_add_plato_readings` with `recorded_by='batch-url'`; same limits (≤20) and validators; new: batch must exist (it does, token validated).
- Existing rate limiter `batchPublicLimiter` (`server.js:727`) and the guard bypass for `/batch/public/` (`server.js:396,451`) stay untouched.
- Tokens: stored plaintext, regenerate = new random 16 bytes hex, `last_regenerated_at` set, old token dead immediately (no cache in PG).

### Pattern 8: Sheet mirror for four tables (D-10, D-12)

- **Entity `batch`, id = `batch_id`**, added to `ops-mirror.js` (`ENTITIES.batch = {prefix: KEY_ROOT+'batch:', label:'batches.mirror'}`; `readLatest` reads the batch row **and** its tasks, readings, history in one read-only tx; `buildMirrorRequest` => `{action:'mirror_batch_state', batch, tasks, readings, history}` or, for a missing row, `{action:'mirror_batch_delete', batch_id}`). One Apps Script call per touched batch keeps the cost at one 1–3 s round trip per write and preserves per-id ordering and the Redis dirty marker + 5-minute sweep + backoff (2 s/10 s/60 s/5 min) already in place.
- **Apps Script v62 (additive, `server_token` branch next to `mirror_vessel_state`, ≈L365):** `mirror_batch_state` (under `acquireScriptLock`): upsert the Batches row by `batch_id` writing **by header name** (case-insensitive match so `target_volume_L` is honoured); for BatchTasks/PlatoReadings/VesselHistory upsert each supplied row by its id and **delete rows with that `batch_id` whose id is no longer supplied** (covers `update_batch_schedule` removals, `propagate`, reading deletes); `mirror_batch_delete` removes the batch and its child rows; both evict the batch caches (`_invalidateBatchCache(batch_id)` **plus** `gbds/gtu/gbl/gbi`) so a rollback to sheets never serves stale `gb:`/`gbl` data (the Phase 76 "gb: cache stays stale" lesson). Values are written verbatim (already sanitised on the PG write); dates as `YYYY-MM-DD` strings (Sheets parses them to Date like `appendRow` does), booleans as booleans, timestamps as ISO strings, `bin_id` as number.
- **Triggers for mirror scheduling:** every successful facade write schedules `('batch', batch_id)`; `bulk_update_batch_tasks` schedules each affected id; `propagate` schedules each updated batch; vessel changes also schedule `('vessel', id)` for `result.applied`. Deletes schedule `('batch', id)` after commit (row missing => delete action).
- **D-12 notice without breaking parsers:** use a **cell note + warning-only protected range on the header row/data range**, set once by a new `setupBatchMirrorNotices()` function run from the Apps Script editor (like the other `setup*` helpers), because backfill/verify/mirror all key on row-1 header text and an inserted row would shift data (the Config tab already burned the rehearsal on a missing header row; Phase 86 RUNBOOK §11). Verify must assert row 1 still equals the pinned header list.
- **Replay (rollback):** `batches-replay-to-sheet.js` (dry-run default, `--apply`, `--since=<iso>`): for each batch with `last_updated >= since` send `mirror_batch_state`; for each `batch_tombstones.deleted_at >= since` send `mirror_batch_delete`; finish with a cache-flush call; then `batches-verify.js`.
- **Daily drift check (D-08):** new read action `export_batch_tabs` (GET, server_token; returns the 4 tabs as arrays keyed by header, ≈0.8 MB at today's size) and a production-only 24 h timer registered beside the mirror sweep (`server.js:~934`) that diffs against PG with the same comparer as `batches-verify.js` and raises Sentry (tags `component:batches-drift`) on any mismatch. The owner-run xlsx verify remains the rehearsal/cutover tool. Alternative if the owner prefers zero new runtime code: a scheduled owner/Claude run of the CLI (manual daily for 7 days). [ASSUMED-design]

### Pattern 9: Backfill / verify / parity / replay tooling

- **`batches-backfill.js`** copies `ops-backfill.js`: one workbook snapshot -> four tables in ONE transaction, parents first (`batches`, then `batch_tasks`, `plato_readings`, `vessel_history`), empty-target preconditions on all five tables, DB-name prompt, `BACKFILL_DATABASE_URL` only, `--timezone=America/Vancouver` default (xlsx date cells are wall-clock), `--dry-run`/`--promote`, exit codes 0/1/2(rejects)/3(check failed). Header lists pinned in a NEW spec-headers test (do not edit `spec-headers.test.js`). Skip rows whose primary key cell is blank (Batches/BatchTasks have 758 / 0 formatted-empty tail rows respectively; `rowCount` lies). Reject (never coerce): bad ID formats, duplicate IDs, unknown `status`, orphan child rows, non-hex token, non-numeric plato/day_offset/step_number, bad timestamps; `access_token` duplicates. Reject records carry sheet, row, id, field, generic reason only (no cell values; the 86-18 header-echo bug fix `d7735bb6` applies: do not echo unexpected header text).
- After insert: `setval('batch_id_seq', max SV-B suffix)` (=229 today), `batch_task_id_seq` (=1047), `plato_reading_id_seq` (=71), `vessel_history_id_seq` (=415), in-transaction invariants (per-table counts equal accepted counts, sequences >= max, no child without parent, every `unit_seq` assigned).
- **Expected counts from the 2026-10-06 snapshot** (re-check on the fresh snapshot): batches 202, tasks 1036 (4 orphans => 1032 unless the owner deletes them), readings 69, history 413. Status mix: complete 163, secondary 18, primary 16, pending 5 [VERIFIED].
- **`batches-verify.js`** (read-only tx vs a fresh .xlsx): per-table row counts, per-field compare (booleans normalised, `''≡NULL`, dates by date-only, timestamps by epoch ms, numerics by `Number`, `bin_id` as text), child->parent integrity, header-row pin, row-1 notice check, vessel-id orphan report (informational). Exit 4 on mismatch like `ops-verify`.
- **`batches-parity.js` (the D-06 dashboard gate; runs BEFORE the flag moves):** with writes frozen, call the sheet side (`GET APPS_SCRIPT_URL?action=get_batch_dashboard_summary|get_batches&status=all|get_tasks_upcoming&limit=200|get_tasks_calendar&start_date=…&end_date=…` with the server token) and the Postgres side (call `batch-pg` read functions through the tunnel pool with the same "now"), and deep-diff the JSON (canonical key order, ignoring only `access_token`-bearing fields that are intentionally absent from lists). Save the sheet-side JSON as the **pre-cutover snapshot** file (outside the repo; contains customer names). Comparing before the flip means a mismatch needs no rollback at all, only "don't flip". Post-flip, the same script runs against the proxy for a final confirmation.
- **Fresh-workbook rehearsal mechanics (85-12 / 86-18):** File -> Download -> .xlsx of the live workbook into `~/sv-backfill/` (outside repo; the CLI refuses repo paths), staging DB reached via `railway connect Postgres --tunnel-only --environment staging`; migrations applied by the staging deploy; `BACKFILL_DATABASE_URL` via `read -s`. Staging and production share one workbook and one Apps Script deployment, so a staging rehearsal must never write the live sheet: staging has `sheet-mirror` disabled (RAILWAY_ENVIRONMENT_NAME !== 'production'), and once staging runs `BATCHES_STORE=postgres` its batch writes no longer reach Apps Script at all (a safety gain over today). Existing local files: `snapshot-staging-1.xlsx`, `snapshot-staging-verify-1.xlsx`, `prod-after.xlsx` (2026-10-06) are **stale snapshots** — download a fresh one for each rehearsal.

### Pattern 10: Cutover runbook outline (for 87-DESIGN.md / RUNBOOK)

Times are targets to be **measured in the staging rehearsal** [ASSUMED until rehearsed].
1. T-7d: Apps Script v62 deployed (rollback 61), editor-drift hash check; staging rehearsal done; owner removes the 4 orphan task rows; hygiene decisions recorded.
2. T-0 (Sunday after close): tell staff not to edit the four tabs; set `BATCHES_FREEZE="<HH:MM>"` (restart ~1 min). Record start time and the Zoho invoice numbers sold from now on (list for the post-window Scan invoices).
3. Download fresh workbook; `batches-backfill --dry-run` (**0 rejects**, counts printed); `--promote`.
4. Download a second fresh workbook; `batches-verify` (**0 mismatches**, row counts per table equal).
5. `batches-parity` (**0 differences** vs pre-cutover snapshot) — no-go here costs nothing.
6. Flip: set `BATCHES_STORE=postgres`, unset `BATCHES_FREEZE` (one variable batch, one restart); check `/health database_required:true`, boot log lines for mirror sweep.
7. Smoke (owner does Google sign-in): create batch (then check its mirrored sheet row, prod only), mark task, add reading, vessel transfer, open `batch.html` with an existing printed token, regenerate-token round trip on a test batch. Post-flip parity run.
8. Staff run Scan invoices for the window's invoices (D-04).
9. Rollback inside the window: restore `BATCHES_STORE=sheets` (+ keep the freeze until verify), no replay needed if only the smoke batch was written; after the window: replay first (D-08).
10. Day 1–7: daily drift check + manual runsheet of actions; day 7 retire rollback (record in DUAL-LOG-equivalent `87-CUTOVER-LOG.md`).

### Anti-Patterns to Avoid
- Putting the intercept only in the two proxies (misses nine direct callers; see Pattern 3).
- A UNIQUE `(batch_id, step_number)` constraint (68 live duplicates), or a UNIQUE partial index on location (behaviour change).
- Using `isStale` for `update_batch` (different, lenient contract).
- Storing `schedule_snapshot` as jsonb (key reorder) or `bin_id` as a JSON string in responses (type change).
- Auto-expiring freeze timestamps; Redis-only freeze.
- Re-running Apps Script batch logic as the mirror leg (state copy only, per 85 D-01).
- Editing existing tests; touching `js/brewpad.js`, `js/admin.js`, `js/batch.js`.
- Emitting `access_token` from list endpoints; logging customer names/emails in reject files or Sentry.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ID minting | `max()+1` or app lock | column default on sequences, seeded via `setval` at backfill | removes the lock-free collision; allowed by the guard (`nextval lpad`) |
| Cascade delete | 3-table delete loop | `ON DELETE CASCADE` | atomic, one statement |
| Vessel status in the same tx | second tx / HTTP delta seam | `vessel-pg.applyStatusChanges(client, …)` | already client-based |
| Boot refusal / env flag | new reader | `store-flag.resolveStoreMode` + `STORE_ENV_NAMES` | drives `/health database_required` |
| Prod-only sheet leg | `if (env…)` | `sheet-mirror.mirrorFireAndForget` | exact-match gate, not overridable |
| Mirror ordering/retry/sweep | new worker | extend `ops-mirror.js` entity table | chain + marker + sweep proven in 86 |
| Backfill plumbing | new reader/normalisers | `read-xlsx`, `normalize`, `rejects`, `backfill` helpers, `ops-backfill` shape | rejects instead of coerces; masked output |
| Constant-time token compare | `===` | `crypto.timingSafeEqual` | public endpoint |
| Date arithmetic for due dates | hand-rolled month math | build `Date` from y/m/d parts and `setDate(+offset)` exactly like `calculateDueDate` (L1819) or SQL `date + integer` | same result as the script; test across DST/month ends |
| Sanitising stored strings | new regexes | `recipe-rules.sanitizeInput` | parity-tested vs `.gs` |

**Key insight:** fidelity is the work: response shapes (NULL -> `''`, booleans, `bin_id` number, date-only truncations, sort orders), the status/vessel transition table, and the three cross-system seams (direct callers, schedule steps, reference counts). Any "improvement" in the PG path appears as a false parity mismatch.

## Runtime State Inventory (store migration)

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | Sheets `Batches` (202 rows + 758 empty formatted tail), `BatchTasks` (1036), `PlatoReadings` (69), `VesselHistory` (413) in the shared workbook; Redis retry keys `brewpad:pending-batch:*` (24 h TTL, `MAX_RETRIES=3`) and `brewpad:zoho-sync:*`; Apps Script CacheService keys `gbl gtu gbds gbi gfs gb:<id> gbp:<id>` (≤300 s) | Backfill (data migration). Retry keys: items queued before the flip create into PG afterwards (idempotent); items queued during the freeze exhaust within ~15 min and are recovered by Scan invoices (D-04). GAS caches: mirror actions evict; replay ends with a flush |
| Live service config | Apps Script deployment `…DI968g` at v61 (shared staging+prod) needs v62; Config sheet `staff_emails` blank after 86 D-18 closes the OAuth write path; Zoho custom field `cf_batch_status` on invoices (derived from batches, unchanged format) | v62 deploy (additive); confirm 86 D-18 is done before the window |
| OS-registered state | None (Railway env only; no schedulers). Apps Script time-driven triggers: `backup.gs` exists; none write the four tabs (grep of `BATCHES_SHEET_NAME` etc. shows only adminApi.gs functions + recipe/schedule ref counts) | None; re-check trigger list in the Apps Script UI at v62 deploy |
| Secrets/env vars | `APPS_SCRIPT_SERVER_TOKEN`, `DATABASE_URL`, `BACKFILL_DATABASE_URL`; **new** `BATCHES_STORE`, `BATCHES_FREEZE` | Add to Railway runbook; no secret in tables |
| Build artifacts | none (no frontend change); migration `0005` applied by Railway pre-deploy `npm run migrate` | `migrate:guard` in CI; see Pitfall 12 for release-train pinning |

## Common Pitfalls

### Pitfall 1: Strict D-06 bar vs real data (orphans, duplicates, the `target_volume_L` header)
**What goes wrong:** the first promote rejects 4 orphan tasks; or a UNIQUE constraint rejects 68 rows; or `target_volume_l` is silently lost.
**Why:** `BT-000567..570` -> deleted `SV-B-000108`; duplicate task generations in `SV-B-000002..027`; header `target_volume_L` vs code `target_volume_l`.
**How to avoid:** owner deletes the 4 orphan rows from the sheet before rehearsal (record in the cutover log); keep rejecting orphans in code; no unique constraint on step; decide Open Question 6.
**Warning signs:** rehearsal exit code 2; verify count mismatch of 4 on BatchTasks.

### Pitfall 2: Direct Apps Script callers missed
A proxy-only swap leaves kiosk sales, scan-invoices, reassign-customer, bottling-invite stamp, reconcile and the Phase 85/86 reference-count seams writing/reading the **sheet** after the flip (split brain). Mitigation: grep gate in the plan (`rg "create_batch|update_batch|get_batches|recipe_batch_ref_count|ferm_schedule_ref_count|propagate_ferm_schedule" zoho-middleware/{routes,lib}` must show only the facade, the sheets-mode branch, and the proxies) plus a test that fails if a second issuer appears (the Phase 85 "single recipe-action issuer" invariant).

### Pitfall 3: Response-fidelity drift (the false-mismatch generator)
NULL vs `''`, boolean vs `'TRUE'`, `bin_id` number, `start_date`/`due_date` truncation, readings `timestamp`/history `transferred_at` first-10-chars, sort orders (batches `created_at` desc; tasks by step; readings asc; history **desc**), `tasks_total/done`, `access_token` stripped in lists but present in detail. Mitigation: pure serializers in `batch-rules.js` with golden fixtures captured from the Apps Script functions' outputs on the snapshot, plus `batches-parity.js`.

### Pitfall 4: Timezone of "today" and month buckets
`getBatchDashboardSummary` uses `Session.getScriptTimeZone()`; PG/Node must use the same zone. Backfill `--timezone` default is `America/Vancouver`. Confirm the script project's timezone (Open Question 3) before trusting `overdueTasks`/`tasksDueToday`/`batchesByMonth` parity. Run parity at a time of day away from midnight.

### Pitfall 5: The freeze must also cover public writes and advisory writers
`batch.html` writes go through the three public routes, not the proxies; `stampBottlingInviteSent` and `reassign-customer` are direct. Each needs the guard (stamp: log and swallow). Also: nobody must hand-edit the four tabs from freeze until D-12 protection is in place; verify's second fresh snapshot catches edits made during backfill.

### Pitfall 6: Retry queue interplay during the freeze
`callAppsScriptCreateBatch` queues `{ok:false}` results; 3 attempts at the 5-minute sweep exhaust in ~15 minutes, then the item is deleted (`brewpad.js`-independent). That is acceptable under D-04 only because Scan invoices recovers them; make the freeze return `error:'maintenance'` so logs distinguish it, and list the window's invoices from the `kiosk.batch_retry_queued` event log + the `[brewpad] Apps Script returned error` warnings for the runbook step 8.

### Pitfall 7: Migration allowlist constructs
`0005` uses `CHECK … ~`, partial indexes (`WHERE …`), FKs with `ON DELETE CASCADE`, `date`/`timestamptz`/`numeric` types, sequences with `nextval`/`lpad` defaults. The Phase 86 file already proves `~`, `!~`, FK-less tables and sequences pass. **Unverified:** partial `CREATE [UNIQUE] INDEX … WHERE` with `<> ''`/`IS NOT NULL`/`IN (…)` and `ON DELETE CASCADE` through `scripts/migration-allowlist.js` (`NODES` has `NullTest`, `BoolExpr`, `A_Expr`, `Constraint`). Pin both in Wave 0 by running `npm run migrate:guard` on a draft before building on them; if a construct is rejected, drop the partial predicate (indexes still work) rather than weakening the guard. libpg-query is PG16-grammar while prod is PG18 (memory: railway-postgres-is-v18); the harness is already `postgres:18-alpine`.

### Pitfall 8: Sheet-era IDs that are reused vs sequences that are not
Sheets reuse a deleted highest ID; sequences never do. After a rollback-and-reflip, sequences continue from the seed, not from the sheet max: re-run `setval` to `max(sheet, pg)` in the re-flip runbook step.

### Pitfall 9: Non-atomic Apps Script flows made atomic
`updateBatch` can write history/vessel statuses before rejecting `invalid_status`; `updateBatchTask` ignores a failed internal `updateBatch`. Porting "atomically" changes failure modes (strictly safer). Decide per case (Open Question 9): faithful (transfer location conflict silently dropped while the task completes) is surprising; recommended = keep the task completion but return a `warnings` array (additive key) so staff see the failure.

### Pitfall 10: Public-token cross-batch task write
Pre-existing hole (see Pattern 7). Fix in the port; add a regression test.

### Pitfall 11: `last_updated`/token precision
Write `last_updated` from a JS `Date` (ms) and emit `toISOString()`; never `default now()` (microseconds break `expectedVersion` equality semantics and parity). Compare `server > client` using ms epoch as the script does.

### Pitfall 12: Release-train pinning
Phase 86's production work is pinned (`git push production d2c66be9:main --force`, never `main`); `main` already carries migration 0004 and 86 code. Phase 87 code and `0005` will ride on `main` too: with both flags unset the sheets path is byte-identical, so shipping 87 code to production before the window is safe **only if** the pre-deploy `npm run migrate` of `0005` is acceptable early (it is additive and unused until the flag). Decide explicitly (Open Question 10); keep the production SHA for the window recorded in the runbook.

### Pitfall 13: Docker / test:db
`docker` client present on the dev machine (Docker Engine 28.0.2); daemon state not confirmed during research. `npm run test:db` self-skips locally without Docker and fails on CI without it; start Docker Desktop before executing real-PG tasks (same as 85/86).

### Pitfall 14: Existing-test mocks
Route tests mock `constants`, `cache`, `logger`. New libs must require `store-flag`/`db`/`ops-mirror` lazily and not read missing constants at module load (85/86 precedent); sheets-mode branches must call `axios` with the exact args the existing tests assert.

## Code Examples

### Idempotent invoice-linked create (sketch; port of `batchDedupDecision`)
```javascript
// Source: apps-script/adminApi.gs batchDedupDecision L2566 + Phase 87 design
function dedupDecision(existingIds, payload) {
  if (!payload.zoho_so_number) return null;
  var allowed = Math.floor(Number(payload.unit_total));
  if (!isFinite(allowed) || allowed < 1) allowed = 1;
  if (payload.product_sku) {
    if (existingIds.length >= allowed) {
      return { ok: false, error: 'duplicate_so_number',
        message: 'SO/invoice ' + payload.zoho_so_number + ' + SKU ' + payload.product_sku +
          ' already has ' + existingIds.length + ' of ' + allowed + ' batch(es): ' + existingIds.join(', ') };
    }
    return null;
  }
  // invoice-only fallback (no SKU): any existing batch for the invoice is a duplicate
  return null; // caller supplies invoice-wide ids in that branch
}
// in the tx: await client.query('select pg_advisory_xact_lock(hashtext($1))', [so + '|' + sku]);
//            rows = select batch_id from batches where trim(zoho_so_number)=$1 and trim(product_sku)=$2
//            unit_seq = rows.length + 1  (unique partial index is the backstop -> map 23505 to duplicate_so_number)
```

### Vessel status in the batch transaction
```javascript
// Source: lib/vessel-pg.js applyStatusChanges(client, changes, opts) L289; lib/db.js withTransaction
db.withTransaction(function (client) {
  return batchPg.updateBatch(client, payload, { actor: actor, now: new Date() }); // collects vesselChanges internally
}).then(function (raw) {
  (raw._vesselApplied || []).forEach(function (id) { opsMirror.schedule('vessel', id); });
  if (raw.ok) opsMirror.schedule('batch', payload.batch_id);
  return strip(raw);
});
```

### Freeze guard
```javascript
// Source: Phase 87 design (read env per request; no timer)
var WRITE_ACTIONS = { create_batch:1, update_batch:1, update_batch_schedule:1, delete_batch:1,
  update_batch_task:1, bulk_update_batch_tasks:1, add_batch_task:1, bulk_add_plato_readings:1,
  update_plato_reading:1, delete_plato_reading:1, regenerate_batch_token:1 };
function freezeMessage() {
  var until = process.env.BATCHES_FREEZE;
  return until ? 'Batches are read-only for maintenance until ' + until + '. Please try again then.' : '';
}
// proxy: if (WRITE_ACTIONS[action] && freezeMessage()) return res.status(503).json({ ok:false, error:'maintenance', message: freezeMessage() });
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Apps Script `_cachedGet` batch caches with partial eviction | no cache on PG reads | this phase | removes `gds`/`gb:` staleness gaps |
| `generateNextId` max+1 under script lock | sequences | this phase | no reuse; no lock |
| Vessel status via Apps Script delta seam (86) | same-transaction `applyStatusChanges(client)` | this phase | atomic batch+vessel |
| Reference counts via Apps Script seams (85/86) | SQL `count(*)` | this phase | seams explicitly marked "Phase 87 swaps in SQL" |

**Deprecated/outdated:** `docs/DATA-MODEL.md` §3 batch columns (wrong names/counts; `transfer_date` vs `transferred_at`; tasks `completed_at` etc.) — correct it in this phase's docs task. `send_bottling_invite` (Apps Script MailApp) is superseded and out of scope.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Apps Script project timezone equals `America/Vancouver` (used for "today"/month buckets and date-cell wall-clock) | Pitfall 4, Pattern 9 | dashboard parity differs near midnight; backfill dates shift by a day |
| A2 | Env-var freeze (`BATCHES_FREEZE`) is the right switch (vs Redis key) | Pattern 4 | window procedure needs one more restart; low |
| A3 | A 2-minute fingerprint window is acceptable replay protection for manual creates | Pattern 5 | false-positive blocks a deliberate identical re-create; or false-negative on slow retries |
| A4 | Daily drift check as a prod-only timer + new `export_batch_tabs` Apps Script action (vs manual CLI) | Pattern 8 | extra Apps Script/runtime surface; owner may prefer manual |
| A5 | Window time estimates (~30 min typical) | Pattern 10 | the 2 h budget may be tight; the rehearsal must measure |
| A6 | Text-with-default-'' columns plus nullable date/number columns reproduce Sheets semantics exactly | Pattern 1 | serializer mismatches show up in parity |
| A7 | `numeric` unconstrained for plato/temperature/ph is right (Phase 83 spec used `numeric(5,2)`/`(4,2)`) | Pattern 1 | rounding if constrained; values today fit either |
| A8 | Pending batches with a vessel not marking it In-Use is intended behaviour to preserve | catalogue | if a bug, owner may want it fixed (deviation) |
| A9 | `target_volume_L` header mismatch means the two fields were never persisted (0/960 populated) | Pitfall 1 | if populated elsewhere (e.g. recipe_snapshot only) no data loss either way |
| A10 | Docker daemon available locally for `test:db` | Pitfall 13 | real-PG tasks blocked until started |
| A11 | Apps Script v61 is the current deployed version (86-18) so v62 is next | Pattern 8 | version numbering in RUNBOOK |

## Open Questions (RESOLVED: deferred to 87-DESIGN.md Owner Decisions Q1–Q20, owner-approved at the 87-01 checkpoint)

1. **Orphan tasks `BT-000567..570`** (-> deleted `SV-B-000108`): recommend the owner deletes them from the sheet before the rehearsal. Alternative: backfill with an explicit documented "known exclusions" list (weakens the zero-rejects bar).
2. **Historical duplicate task sets (68 pairs, 25 completed batches):** import as-is (recommended, no unique constraint) vs clean in the sheet first. Either way `get_batch` output for those batches must match.
3. **Apps Script timezone** (`Session.getScriptTimeZone()`): confirm via the project settings or a probe action; the parity gate and backfill depend on it.
4. **`bin_id` JSON type:** emit number when numeric (recommended, identical to sheet) vs string.
5. **FKs beyond cascade:** `batches.schedule_id -> ferm_schedules` (recommended, RESTRICT, nullable) and `vessel_id` FK (not recommended: sheet accepted free text). Confirm.
6. **`target_volume_l` / `scale_factor`:** store and populate going forward (a silent fix) or reproduce the "never stored" behaviour? Recommended: store (columns exist), mirror writes to the existing `target_volume_L` header case-insensitively.
7. **Location conflict strictness:** parity (pre-check under lock) vs UNIQUE partial index that also blocks reactivating a completed batch into an occupied slot.
8. **Public task-belongs-to-batch check** (recommended hardening) — the only deliberate behaviour change on the public path.
9. **Transfer completion with a location conflict:** silent drop (today) vs additive `warnings` (recommended).
10. **Release train:** may `0005` and the inert 87 code reach production `main` before the window (while 86 prod steps are pinned to `d2c66be9`)?
11. **Manual-create idempotency window and fingerprint** (Pattern 5.2): approve or choose "invoice-linked only".
12. **Drift check:** automatic timer (recommended) vs manual daily CLI.
13. **Probe/test rows:** only one test-ish batch found (`SV-B-000062` "Jazz", complete); import as-is. Two batches have blank `product_sku` (`SV-B-000167`, `SV-B-000229`) — `product_sku` is `not null default ''`, so they import; confirm no rule requires non-empty.
14. **Sequence of the production window vs Phase 86:** 86's flip needs ≥7 dual days after the 85 flip (D-11/D-12 chain), so the earliest production window is several weeks out; plan the staging rehearsal and docs now, schedule the date only after the 86 flip is recorded.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | all CLIs/tests | yes | v20.20.2 | — |
| Docker (client) | `npm run test:db` (testcontainers `postgres:18-alpine`) | client yes, daemon unverified | 28.0.2 | start Docker Desktop; CI runs `test:db` |
| Railway CLI | tunnel for rehearsal/cutover | yes | 5.62.1 (needs ≥5.x) | public TCP proxy fallback (README) |
| exceljs | backfill/verify | yes (devDependency) | 4.4.0 | — |
| Postgres (staging/prod) | rehearsal/cutover | yes (Railway, v18.6) | 18.6 | — |
| Fresh workbook snapshots | rehearsal | stale files only (`prod-after.xlsx` 2026-10-06, `snapshot-staging-*.xlsx`) | — | owner downloads fresh .xlsx per rehearsal |
| Apps Script editor access | v62 deploy | owner (shared deployment `…DI968g`) | v61 live | — |

**Missing with no fallback:** none. **Missing with fallback:** Docker daemon (start it).

## Validation Architecture

> `workflow.nyquist_validation` not set to false in config (key absent => enabled).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Jest ^29.7.0 (middleware `jest.config.js`; real-PG via `jest.db.config.js` + `@testcontainers/postgresql` `postgres:18-alpine`) |
| Config file | `zoho-middleware/jest.config.js`, `zoho-middleware/jest.db.config.js` |
| Quick run command | `cd zoho-middleware && npx jest __tests__/batch-store*.test.js __tests__/batch-proxy*.test.js __tests__/backfill/batches-*.test.js` |
| Full suite command | `npm test && cd zoho-middleware && npm test && npm run test:db && npm run migrate:guard && cd .. && npm run lint && (cd zoho-middleware && npm run lint)` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DB-06 | migration 0005 passes guard; FK cascade deletes children; sequences; unique indexes | real-PG | `cd zoho-middleware && npx jest --config jest.db.config.js __tests__/db/batches-migration.test.js` | Wave 0 |
| DB-06 | createBatch: pending vs scheduled, tasks/history/vessel In-Use in one tx, rollback on failure | real-PG | `…jest.db.config.js __tests__/db/batch-pg-create.test.js` | Wave 0 |
| DB-06 | dedup/unit_total/duplicate_so_number; concurrent creates (parallel x3) yield exactly unit_total rows; replay protection | real-PG | `…__tests__/db/batch-pg-idempotency.test.js` | Wave 0 |
| DB-06 | updateBatch transfer/history/vessel statuses/expectedVersion/invalid_status atomicity | real-PG | `…__tests__/db/batch-pg-update.test.js` | Wave 0 |
| DB-06 | task update, packaging completion/uncompletion, transfer auto-advance, bulk, add task | real-PG | `…__tests__/db/batch-pg-tasks.test.js` | Wave 0 |
| DB-06 | readings validators/CRUD; deleteBatch cascade + tombstone + vessel release | real-PG | `…__tests__/db/batch-pg-readings-delete.test.js` | Wave 0 |
| DB-06 | dashboard/calendar/upcoming/list/detail/public serializers equal golden fixtures; location conflict query | unit + real-PG | `npx jest __tests__/batch-rules.test.js` and `…__tests__/db/batch-pg-read.test.js` | Wave 0 |
| DB-06 | create_batch median latency < 2 s (SC4 automated leg; prod stopwatch is a runbook step) | real-PG | `…__tests__/db/batch-create-latency.test.js` (pattern of `recipes-rename-latency.test.js`) | Wave 0 |
| DB-06 | proxy intercept: sheets mode forwards unchanged (existing suites untouched); postgres mode serves all 17 actions; freeze 503 on writes only, reads pass | unit (supertest) | `npx jest __tests__/batch-proxy-routes.test.js` | Wave 0 |
| DB-06 | public routes: token compare, disabled, packaging block, cross-batch task rejected, freeze | unit | `npx jest __tests__/batch-public-store.test.js` | Wave 0 |
| DB-06 | single-issuer invariant: no direct Apps Script batch action outside facade/sheets branch | static test | `npx jest __tests__/batch-single-issuer.test.js` | Wave 0 |
| DB-06 | direct callers (create via sale hook, scan dedup, reconcile index, reassign-customer, bottling stamp, ref counts, propagate) use facade in postgres mode, axios in sheets mode | unit | `npx jest __tests__/batch-callers-postgres.test.js` | Wave 0 |
| DB-06 | store-flag: `BATCHES_STORE=dual` refuses boot; `postgres` requires `OPS_DATA_STORE=postgres` | unit | `npx jest __tests__/batch-store-flag.test.js` | Wave 0 |
| DB-06 | backfill plan: rejects orphans/dups/bad formats; counts; sequences seeded; empty-target preconditions; header pin | unit + real-PG | `npx jest __tests__/backfill/batches-backfill-plan.test.js __tests__/backfill/batches-spec-headers.test.js`; `…__tests__/db/batches-backfill.test.js` | Wave 0 |
| DB-06 | verify/replay/parity comparers (no cell values in output) | unit | `npx jest __tests__/backfill/batches-verify.test.js batches-replay-to-sheet.test.js batches-parity.test.js` | Wave 0 |
| DB-06 | mirror: entity batch bundle, delete on missing row, no-op off prod, marker/sweep | unit | `npx jest __tests__/ops-mirror-batch.test.js` | Wave 0 |
| DB-06 | Apps Script v62 actions (mirror_batch_*, export_batch_tabs) additive; existing dispatch tests green | frontend jest | `npm test -- adminapi` (root, `tests/frontend/adminapi-*.test.js`, NEW file for v62) | Wave 0 |
| DB-06 | brewpad.js unchanged | static | `git diff --exit-code origin/main -- js/brewpad.js js/brewpad.min.js` (plan gate) | n/a |

### Sampling Rate
- **Per task commit:** the quick command for the touched module + `npm run lint` in the touched package.
- **Per wave merge:** full middleware `npm test`, `npm run test:db`, `npm run migrate:guard`, root `npm test`.
- **Phase gate:** full suite green; staging rehearsal evidence (0 rejects, counts, 0 mismatches, 0 parity differences, SC4 timing) recorded before `/gsd:verify-work`.

### Wave 0 Gaps
- [ ] all new test files listed above (none exist); golden fixtures captured from Apps Script outputs on a fresh snapshot (`__tests__/fixtures/batches/…`, no real customer names: scrub)
- [ ] `0005` draft run through `npm run migrate:guard` (pins partial index / ON DELETE CASCADE acceptance)
- [ ] `store-flag.test.js` list update (needs owner approval per rule 10)
- [ ] Docker daemon running for `test:db`

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (public token) | 32-hex random token (`crypto.randomBytes(16)`), `timingSafeEqual`, format pre-check, existing per-IP limiter |
| V3 Session Management | no change | proxies keep `requireTiers(['legacy','session'])` |
| V4 Access Control | yes | public routes: explicit field whitelist (never `Object.assign(body)`), task must belong to token's batch, packaging completion staff-only, disabled batch hidden; no list endpoint returns `access_token`; GET routes must not bypass tiers |
| V5 Input Validation | yes | parameterised SQL only (no string-built SQL; fixed column allow-lists for dynamic SET, as `vessel-pg.js`), regex ID/token formats, numeric ranges (plato<=40, ph 0..14), array caps (50 tasks / 20 readings), `sanitizeInput` on stored text, JSON validity for snapshots |
| V6 Cryptography | yes | token generation via `crypto.randomBytes`; no hand-rolled crypto; tokens must stay plaintext (D-14) |
| V7 Logging/Errors | yes | reject files and Sentry carry ids/field names only (no names/emails); freeze error leaks nothing; 502 collapse preserved |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via batch fields | Tampering | `$n` parameters; column allow-lists |
| Token brute force / enumeration on `batch.html` | Spoofing | 128-bit token, rate limiter, uniform `invalid_token` for missing batch vs wrong token where Apps Script did (note it returned `not_found` for missing batch on the GET path; keep for parity or unify, Open Question) |
| Cross-batch task tampering with a valid token | Tampering/EoP | enforce `task.batch_id = batch_id` |
| Public response PII | Info disclosure | strip email/reservation/token (parity); `customer_phone`, `notes`, `recipe_snapshot` currently leak to token holders (pre-existing; owner decision whether to strip — would change batch.html data) |
| Write during freeze via an unguarded path | Tampering | guard on every facade write + the 3 public write routes; static test for single issuer |
| Split-brain after flip (caller still hits Apps Script) | Integrity | single-issuer invariant + grep gate + post-flip parity |
| Stored XSS in notes/titles | Tampering | `sanitizeInput` port (clients already `escapeHTML`) |
| PII in backfill artifacts | Info disclosure | outputs outside repo; masked/ID-only logging (86 `d7735bb6` lesson) |
| Staff OAuth direct Apps Script writes after cutover | Integrity | rely on 86 D-18 blanking of `staff_emails`; confirm probe before the window |

## Sources

### Primary (HIGH confidence)
- `apps-script/adminApi.gs` (direct reads; lines cited above): batch functions L1657–3920, doGet/handleReadAction L66–245, doPost L251–560, propagate L3709, caches L3954–4000
- `zoho-middleware/routes/pos.js` (proxies and allowlists ≈L4026–4275, scan-invoices ≈L3258, bulk-create ≈L3436, reassign-customer ≈L3753, stamp ≈L3925, reconcile ≈L3007), `lib/brewpad-integration.js` (L240–500, L680–830), `lib/ops-proxy.js`, `lib/ops-mirror.js`, `lib/sheet-mirror.js`, `lib/store-flag.js`, `lib/vessel-store.js`, `lib/vessel-pg.js` (L289), `lib/db.js`, `lib/recipe-store.js` (L156), `lib/ferm-schedule-store.js`, `migrations/0004_ops_data.sql`, `scripts/backfill/*` (README, ops-backfill/verify/replay, specs), `scripts/migration-allowlist.js`, `__tests__/db/helpers/pg-harness.js`
- `js/brewpad.js` L1711–1790 (fetchWithRetry/adminApiGet/adminApiPost), `js/admin.js` L698 (handleProxyResponse), `js/batch.js` (response handling)
- Phase docs: `87-CONTEXT.md`, `86-RESEARCH.md`, `86-18-SUMMARY.md`, `85-12-SUMMARY.md`, `docs/RUNBOOK.md` Phase 86 section (L866–1011)
- Production snapshot `~/sv-backfill/prod-after.xlsx` (2026-10-06) profiled with a throwaway exceljs script (counts, types, orphans, duplicates, ID maxima); no customer values were printed or recorded here

### Secondary (MEDIUM confidence)
- Project memory entries (Phase 83 infra, Phase 86 status, BrewPad proxy retry/cache, kiosk slow-approval) used for sequencing and known gotchas

### Tertiary (LOW confidence)
- Window timing estimates and the drift-check/idempotency-window designs (flagged [ASSUMED])

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, no new packages; all reused modules read directly
- Architecture: HIGH for tables/behaviours/callers; MEDIUM for freeze, idempotency window, mirror bundle and drift-check designs
- Pitfalls: HIGH, each backed by a file reference or a snapshot measurement

**Research date:** 2026-10-09
**Valid until:** ~2026-11-08 (30 days; re-profile a fresh snapshot before the rehearsal because counts/orphans change daily)

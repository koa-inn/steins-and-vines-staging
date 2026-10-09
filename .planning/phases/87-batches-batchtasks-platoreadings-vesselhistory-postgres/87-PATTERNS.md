# Phase 87: Batches + BatchTasks + PlatoReadings + VesselHistory -> Postgres - Pattern Map

**Mapped:** 2026-10-09
**Files analyzed:** 41 new/modified files
**Analogs found:** 38 / 41 (no analog: maintenance-freeze guard, invoice-keyed idempotency with advisory lock + unit_seq, multi-table mirror bundle with child-row reconcile; `batches-parity.js` is only a partial analog)

All paths relative to `/Users/koa/dev/steins-and-vines-website`. Middleware is ES5-style (`var`, `function`, promise chains; `async` allowed inside `*-pg.js`). Line numbers were read 2026-10-09; re-grep `routes/pos.js` and `apps-script/adminApi.gs` before executing.

**This map builds on `86-PATTERNS.md`. For migration header comments, backfill CLI skeleton, verify/replay CLIs, real-PG harness, RUNBOOK and DUAL-LOG shape, copy the Phase 86 file for the same role (they now exist and are the direct analogs). This file records (a) the exact Phase 86 analog per Phase 87 file, (b) excerpts verified at current line numbers, (c) the pieces that are new in 87.**

Hard rules shaping every assignment (CONTEXT/RESEARCH, CLAUDE.md):
- `js/brewpad.js`, `js/admin.js`, `js/batch.js` unchanged. No `npm run build`. Plan gate: `git diff --exit-code origin/main -- js/brewpad.js js/brewpad.min.js`.
- `BATCHES_STORE` unset (= sheets) must leave existing suites green and untouched: `batch-admin-proxy`, `admin-proxy`, `ops-proxy*`, `batch-public`, `batch-public-guard`, `batch-scan-invoices`, `batch-reassign-customer`, `batch-reconcile-status`, `batch-bottling-invite`, `brewpad-integration`. All coverage in NEW test files. Appending `'BATCHES_STORE'` to `store-flag.js` needs owner approval only if an existing test file is edited (86 put its coverage in new `ops-store-flag.test.js`; do the same, `batch-store-flag.test.js`).
- No dual mode (D-04 area): `BATCHES_STORE=dual` must refuse to boot; `postgres` requires `OPS_DATA_STORE=postgres` (D-13).
- Apps Script deployment is shared staging+prod: v62 changes are additive only.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `.planning/phases/87-.../87-DESIGN.md` (NEW, plan 87-01, blocking checkpoint) | docs | n/a | 86-RESEARCH.md Patterns 1/4/10 + RESEARCH 87 Patterns 1-10 | role-match |
| `zoho-middleware/migrations/0005_batches.sql` (NEW) | migration | batch (DDL) | `migrations/0004_ops_data.sql` | exact |
| `zoho-middleware/lib/store-flag.js` (MOD, 1 line) | config | request-response | itself L31 | exact |
| `zoho-middleware/lib/batch-pg.js` (NEW) | service (atomic SQL) | CRUD (transactional) | `lib/vessel-pg.js` (+ `recipe-pg.js` lock/stale idioms) | exact (shape), larger |
| `zoho-middleware/lib/batch-rules.js` (NEW) | utility | transform (serializers, dedup decision, transition table) | `lib/ferm-schedule-rules.js` / `lib/recipe-rules.js` | role-match |
| `zoho-middleware/lib/batch-store.js` (NEW) | service (facade) | CRUD + mode dispatch + freeze | `lib/vessel-store.js` (+ `recipe-store.js` sheets-mode passthrough) | exact (shape) |
| `zoho-middleware/lib/batch-proxy.js` (NEW) | middleware (proxy intercept) | request-response | `lib/ops-proxy.js` | exact |
| `zoho-middleware/lib/ops-mirror.js` (MOD, add `batch` entity) | service (worker) | event-driven (coalescing retry) | itself (entity table L33-36, `buildMirrorRequest` L74, `readLatest` L132) | exact |
| `zoho-middleware/routes/pos.js` (MOD: proxies L4110/L4192, public routes L4243-4273, scan-invoices L3336, reassign L3757, stamp L3924) | route | request-response | itself | exact |
| `zoho-middleware/lib/brewpad-integration.js` (MOD: `callAppsScriptCreateBatch` L260, `fetchLiveBatchIndex` L696) | service | request-response | itself | exact |
| `zoho-middleware/lib/recipe-store.js` (MOD `hasBatchReferences` L156) | service | request-response | itself; 86's `ferm-schedule-store.js` L161 | exact |
| `zoho-middleware/lib/ferm-schedule-store.js` (MOD `hasBatchReferences` L161, `propagate` L225) | service | request-response | itself (both marked "Phase 87 swaps in SQL") | exact |
| `zoho-middleware/server.js` (MOD: boot refusal for `dual`/`postgres` w/o OPS; optional drift timer next to L930) | config/bootstrap | event-driven | itself L14, L921-934 | exact |
| `zoho-middleware/scripts/backfill/batches-backfill.js` (NEW) | script (CLI) | batch (xlsx -> DB, 4 tables, parents first) | `scripts/backfill/ops-backfill.js` | exact |
| `zoho-middleware/scripts/backfill/batches-verify.js` (NEW) | script (CLI) | batch (read-only compare) | `scripts/backfill/ops-verify.js` | exact |
| `zoho-middleware/scripts/backfill/batches-replay-to-sheet.js` (NEW) | script (CLI) | batch -> HTTP | `scripts/backfill/ops-replay-to-sheet.js` | exact |
| `zoho-middleware/scripts/backfill/batches-parity.js` (NEW) | script (CLI) | batch (HTTP read vs PG read, deep diff) | `ops-verify.js` comparator + `ops-replay-to-sheet.js` HTTP/CLI plumbing | partial |
| `zoho-middleware/scripts/backfill/specs/batches.js`, `batch-tasks.js`, `plato-readings-final.js`, `vessel-history-final.js` (NEW) | config (spec) | batch | `specs/vessels.js`, `specs/ops-ferm-schedules.js`; old `specs/vessel-history.js` / `specs/plato-readings.js` (headers only) | exact |
| `apps-script/adminApi.gs` v62 (MOD, additive): `mirror_batch_state`, `mirror_batch_delete`, `export_batch_tabs`, `setupBatchMirrorNotices()` | controller | request-response / file-I/O | `mirrorVesselState` L4856, dispatch L365-376, `_invalidateBatchCache` L3992 | exact |
| `docs/RUNBOOK.md` "Batches -> Postgres (Phase 87)" + deploy row + SQL-fix recipe | docs | n/a | RUNBOOK Phase 86 section (L866-1011) | exact |
| `docs/DATA-MODEL.md` (MOD, stale batch columns ~L109-190) | docs | n/a | itself | exact |
| `.planning/phases/87-.../87-CUTOVER-LOG.md` (NEW) | docs | n/a | `86-DUAL-LOG.md` | exact |
| Real-PG tests (NEW, `__tests__/db/`): `batches-migration`, `batch-pg-create`, `batch-pg-idempotency`, `batch-pg-update`, `batch-pg-tasks`, `batch-pg-readings-delete`, `batch-pg-read`, `batch-create-latency`, `batches-backfill` | test | CRUD | `ops-migration.test.js`, `vessel-pg-update.test.js`, `vessel-pg-read-create.test.js`, `ops-backfill.test.js`, `recipes-rename-latency.test.js` | exact |
| Unit tests (NEW): `batch-store`, `batch-proxy-routes`, `batch-public-store`, `batch-single-issuer`, `batch-callers-postgres`, `batch-store-flag`, `batch-rules`, `ops-mirror-batch` | test | request-response | `vessel-store.test.js`, `ops-proxy-routes.test.js`, `ops-store-flag.test.js`, `ops-mirror.test.js` | exact |
| Backfill unit tests (NEW, `__tests__/backfill/`): `batches-backfill-plan`, `batches-spec-headers`, `batches-verify`, `batches-replay-to-sheet`, `batches-parity` | test | batch | `ops-backfill-plan.test.js`, `ops-spec-headers.test.js`, `ops-verify.test.js`, `ops-replay-to-sheet.test.js`, `ops-backfill-header-redaction.test.js` | exact |
| Frontend test (NEW): `tests/frontend/adminapi-batch-mirror.test.js` | test | jsdom / fake Sheets | `tests/frontend/adminapi-ops-mirror.test.js` | exact |

## Pattern Assignments

### `zoho-middleware/migrations/0005_batches.sql` (migration, DDL)

**Analog:** `zoho-middleware/migrations/0004_ops_data.sql` (102 lines). Copy the header-comment convention (additive only; never edit once applied; sequence seeds via `setval` at backfill because `AlterSeqStmt`/bare `SELECT` are rejected by the guard; app-written timestamps have no default).

**Id-default idiom** (0004 L49-51), reuse verbatim for `batches` / `batch_tasks` / `plato_readings` / `vessel_history` with `SV-B-` / `BT-` / `PR-` / `VH-` (pad 6, CHECK `{6,}`):
```sql
schedule_id text primary key
  default ('FS-' || lpad(nextval('ferm_schedule_id_seq')::text, 4, '0'))
  check (schedule_id ~ '^FS-[0-9]{4,}$'),
```
**Sequences + Down Migration** (0004 L22-23, L95-102): `create sequence ... start 1 minvalue 1;` first; Down drops children, parents, then sequences in reverse order.
**Timestamps** (0004 L16-17, L59): `last_updated timestamptz not null`, no default (it is the `expectedVersion` token; ms precision; RESEARCH Pitfall 11).
**Numerics** (0004 L19): unconstrained `numeric` for plato / temperature / ph / target_volume_l / scale_factor.
**FK + index idioms:** 0004 L93 `create index ferm_schedules_active_idx on ferm_schedules (is_active);`. The FK `references batches (batch_id) on delete cascade`, partial `create [unique] index ... where ...`, and `batches.schedule_id references ferm_schedules` have NO precedent in 0001-0004 (0004 has no FKs). Allowlist `scripts/migration-allowlist.js`: `IndexStmt` and `Constraint` are allowed (L87, NODES L133-142); `NullTest`, `BoolExpr`, `A_Expr`, `List` allowed; `FUNCS` L147-150 includes `nextval, lpad, now, lower, upper, btrim, length, jsonb_typeof` only (no `hashtext`, no `sha256`; those belong in app SQL, not DDL). Wave 0 task: run `npm run migrate:guard` on the draft FIRST to pin partial-index and `ON DELETE CASCADE` acceptance (RESEARCH Pitfall 7); fallback = drop the partial predicate, never weaken the guard.
**Full recommended DDL:** 87-RESEARCH.md Pattern 1 (plus `batch_tombstones` and `batch_create_dedup`, Pattern 5.2). Do NOT add `unique (batch_id, step_number)` (68 live duplicates) or a UNIQUE location index.
**Test:** `__tests__/db/ops-migration.test.js` shape (L9-30: `describeDb`, `startPostgres`, `applyMigrations`, raw `pg.Pool`, `rollbackEachTest`) for `batches-migration.test.js`; add FK-cascade and sequence-default assertions.

---

### `zoho-middleware/lib/store-flag.js` (MOD, one line)

**Analog:** itself L31:
```javascript
var STORE_ENV_NAMES = ['GIFT_CARDS_STORE', 'RECIPES_STORE', 'OPS_DATA_STORE', 'STAFF_ACCESS_STORE'];
```
Append `'BATCHES_STORE'`. `server.js` L14 `var storeModes = storeFlag.validateStoreFlags();` then enforces `DATABASE_URL` for dual/postgres (L73-84). The `dual` refusal and the `OPS_DATA_STORE=postgres` prerequisite are NOT in this file: put them in a small exported `validateBatchesFlag()` in `batch-store.js` called from `server.js` next to L14 (log.error + `process.exit(1)`, same style as `resolveStoreMode` L44-48). Shared utility: run FULL root + middleware suites afterwards (CLAUDE.md rule 7). Coverage in a new `batch-store-flag.test.js` modeled on `__tests__/ops-store-flag.test.js` L1-50 (mock logger + db, `jest.resetModules()`, `jest.spyOn(process, 'exit')`).

---

### `zoho-middleware/lib/batch-pg.js` (atomic SQL, transactional CRUD)

**Analog:** `zoho-middleware/lib/vessel-pg.js` (325 lines). Same contract, same style; recipe-pg for `for update` + stale idioms.

**Module contract** (vessel-pg.js L3-20): never requires `pg`; every function receives `client` from `db.withTransaction`; `$n` placeholders only, SQL in module-level constants, dynamic SET only from fixed allow-lists; business rejections RESOLVE `{ok:false, error, message}`; infra errors propagate so the tx rolls back; underscore keys (`_vesselApplied`, `_batchId`) are for the facade and stripped there.

**Imports** (L22-23):
```javascript
var recipeRules = require('./recipe-rules');   // sanitizeInput (parity-tested vs .gs)
var staleToken = require('./stale-token');
```
Do NOT use `staleToken.isStale` for `update_batch`: Apps Script semantics are lenient (`server.last_updated > expectedVersion` => `version_conflict`, RESEARCH catalogue + Anti-Patterns). Write a local `isVersionConflict(expectedVersion, row)` comparing epoch ms.

**SQL-constant + lock idiom** (L45-51):
```javascript
var SELECT_COLUMNS = 'vessel_id, label, type, ... updated_at';
var LIST_SQL = 'select ' + SELECT_COLUMNS + ' from vessels order by position asc';
var GET_SQL = 'select ' + SELECT_COLUMNS + ' from vessels where vessel_id = $1';
var LOCK_SQL = 'select ' + SELECT_COLUMNS + ' from vessels where vessel_id = $1 for update';
```
Every batch mutation starts with `select ... from batches where batch_id = $1 for update` (serialises concurrent task toggles so "all non-packaging done" cannot race; RESEARCH Pattern 6).

**Serializer: sheet key order, NULL -> '', numerics through Number, timestamps to ISO** (L77-97):
```javascript
function rowToVessel(row) {
  var out = {};
  for (var i = 0; i < VESSEL_SHEET_COLUMNS.length; i++) {
    var col = VESSEL_SHEET_COLUMNS[i];
    var v = row[col];
    if (col === 'status' && row.archived) { out[col] = ARCHIVED_STATUS; }
    else if (v === null || v === undefined) { out[col] = ''; }
    else if (NUMERIC_COLUMNS[col]) { out[col] = Number(v); }
    else { out[col] = v; }
  }
  out.updated_at = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return out;
}
```
Batch variants (live in `batch-rules.js`, called here): `bin_id` emits `Number(bin)` when `^\d+$` (sheet returns a JSON number; RESEARCH Open Q4); `start_date`/`due_date` as `YYYY-MM-DD`; readings `timestamp`, history `transferred_at`, task `completed_at` truncated to first 10 chars in `get_batch` output; `last_updated` ISO; lists strip `access_token`, detail keeps it; public strips `customer_email`, `reservation_id`, `access_token` only.

**Vessel status in the SAME tx (D-13)** - `applyStatusChanges(client, changes, opts)` (vessel-pg L289-312):
```javascript
async function applyStatusChanges(client, changes, opts) {
  ...
  var result = { applied: [], unchanged: [], unknown: [], invalid: [] };
  for (var i = 0; i < changes.length; i++) {
    ...
    var upd = await client.query(STATUS_DELTA_SQL, [id, c.status, now, actor]);
    if (upd.rowCount > 0) { result.applied.push(id); continue; }
    ...
```
In `batch-pg`: `var vesselPg = require('./vessel-pg');` then `await vesselPg.applyStatusChanges(client, changes, { actor: opts.actor, now: opts.now })` inside create/update/task/delete; return `_vesselApplied: result.applied`. Unknown vessel ids are ignored (parity). Idempotent "set", skips unknown, never touches `archived`.

**Schedule steps in-tx** (create_batch): `require('./ferm-schedule-pg').getSchedule(client, id)` returns a row with `steps_parsed` (see `ferm-schedule-store.getStepsJson` L118-125: `JSON.stringify(row.steps_parsed)`); not-found envelope `{ok:false, error:'not_found', message:'Schedule not found: ' + id}` identical to ops-proxy L85.

**Reference counts / propagate** (replace the Apps Script seams): `countByRecipe(client, id)` = `select count(*)::int from batches where recipe_id = $1`; `countBySchedule`; `propagateSchedule(client, scheduleId, steps)` port of `propagateFermSchedule` (adminApi.gs L3709): per-batch isolation, returns `{ok, batches_updated, tasks_updated, tasks_created, tasks_removed, batches_failed}`.

**Delete/cascade**: `insert into batch_tombstones ... on conflict (batch_id) do update`, vessel -> Empty via `applyStatusChanges`, `delete from batches where batch_id = $1` (FK cascade replaces the 3-sheet loop).

**New with no analog (RESEARCH Pattern 5/6):** `pg_advisory_xact_lock(hashtext(zoho_so_number || '|' || product_sku))` + count + `unit_seq = count+1` dedup returning the exact `duplicate_so_number` object (`message` text must match; `bulk-create` in pos.js treats it as converged), `loc|vessel|shelf|bin` advisory lock before the conflict SELECT, `batch_create_dedup` fingerprint for manual creates, 23505 -> `duplicate_so_number`. Port `checkLocationConflict` (adminApi.gs ~L1802), `batchDedupDecision` (L2566), `generateNextId` becomes sequence default.

**Tests:** `__tests__/db/vessel-pg-update.test.js` L9-60 harness (own `startPostgres`/`applyMigrations`, `jest.resetModules()`, `db.createPool`, `pgHarness.rollbackEachTest(function(){return pool;})`, `harness.client()` + a `seed(client, ...)` insert helper). Concurrency tests (parallel x3 creates yield exactly `unit_total` rows) must use dedicated pool clients, not the rollback client.

---

### `zoho-middleware/lib/batch-rules.js` (utility, transform)

**Analog:** `lib/ferm-schedule-rules.js` / `lib/recipe-rules.js` (pure ES5, parity-tested against the `.gs` via the `new Function` harness, `tests/frontend/adminapi-recipe-pure.test.js` L28-45). Contents (pure, no I/O): row serializers, `dedupDecision(existingIds, payload)` (RESEARCH "Code Examples"), status/vessel transition table (`active = primary|secondary`; `pending` not a valid `update_batch` target), `calculateDueDate(start_date, day_offset)` (blank when `<0`; build from y/m/d parts like adminApi.gs L1819, test across DST/month ends), dashboard bucket logic given an injected `now`/timezone (Pitfall 4), validators for plato (<=40), ph (0..14), temperature. Sanitising: import `recipe-rules.sanitizeInput`, do not write a new one. Golden fixtures captured from Apps Script outputs (scrubbed of customer names) in `__tests__/fixtures/batches/`.

---

### `zoho-middleware/lib/batch-store.js` (facade, mode dispatch + freeze)

**Analog:** `zoho-middleware/lib/vessel-store.js` (140 lines) for structure; `lib/recipe-store.js` L28-62 for `callAppsScript` + `isConfigured`, and for the per-op "sheets short-circuit first" skeleton.

**Imports/header** (vessel-store L15-19). Do NOT require `./constants` (route tests mock it partially):
```javascript
var storeFlag = require('./store-flag');
var db = require('./db');
var vesselPg = require('./vessel-pg');
var opsMirror = require('./ops-mirror');
var log = require('./logger');
```
**Mode** (L21-23): `storeFlag.resolveStoreMode('BATCHES_STORE')`.
**runPg / strip / scheduleMirror** (L35-55) copy verbatim; `scheduleMirror(id)` calls `opsMirror.schedule('batch', id)` in try/catch with `log.warn`.
**finish** (L57-60) extended for batches: `if (raw && raw.ok && raw._batchId) scheduleMirror(raw._batchId); (raw._vesselApplied || []).forEach(function (id) { opsMirror.schedule('vessel', id); }); return strip(raw);`
**writeOpts** (L62-69): `actor: opts.actor || 'middleware'`, `now: new Date()` (ms Date, Pitfall 11). Callers pass the real `req.staffEmail`; kiosk create passes `'kiosk-middleware'`; public routes pass `'batch-url'`.

**Difference from vessel-store (important):** vessel-store REJECTS with `err.code = 'sheets_mode'` in sheets mode (L26-32), because its callers choose the Apps Script path themselves. Batch callers (kiosk hook, scan-invoices, reconcile, reassign, stamp, ref counts) must keep working unchanged in sheets mode, so `batch-store` follows the `recipe-store` model instead: in sheets mode each exported op either (a) returns `null`/`{handled:false}` so the caller falls through to its existing untouched `axios` code, or (b) re-issues the exact original axios call. Pick (a) for pos.js/brewpad-integration sites so existing tests' axios assertions stay byte-identical (RESEARCH Pitfall 14). Single-issuer invariant: after this phase `rg "create_batch|update_batch|get_batches|recipe_batch_ref_count|ferm_schedule_ref_count|propagate_ferm_schedule" zoho-middleware/{routes,lib}` may show only the facade, the sheets branches, and the allowlists; `batch-single-issuer.test.js` enforces it (Phase 85 "single recipe-action issuer" precedent).

**Freeze guard (new, no analog):** read `process.env.BATCHES_FREEZE` per request (RESEARCH Pattern 4 "Freeze guard" example). Applies to every facade write in BOTH store modes, returning `{ok:false, error:'maintenance', message:'Batches are read-only for maintenance until <HH:MM>. Please try again then.'}`; proxies/public routes translate to HTTP 503 with the same body; `stampBottlingInviteSent` logs and swallows; `create` returns `{ok:false,error:'maintenance'}` so `queueForRetry`/log fire (D-04, no new queue). Reads never frozen.

**Return shapes** (RESEARCH Pattern 2): reads `{ok:true,data:...}`; `get_batch` not-found is `{ok:true,data:{error:'Batch not found: X'}}` (error as DATA); writes are raw objects (`{ok,batch_id,access_token,tasks_created}` etc.). Exports flat like vessel-store L130-140.

---

### `zoho-middleware/lib/batch-proxy.js` (proxy intercept, request-response)

**Analog:** `zoho-middleware/lib/ops-proxy.js` (152 lines). Same hook signature and "return true when this module owns the response" contract.

**Signature and gating** (ops-proxy L66-73):
```javascript
function intercept(action, payload, req, res, logTag, forward) {
  if (!pgActive()) return false;
  var actor = (req && req.staffEmail) || 'middleware';
  var opts = { actor: actor, expectedUpdatedAt: payload.expected_updated_at };
```
For batch-proxy gate on `BATCHES_STORE === 'postgres'`; `sheets` returns `false` (today's Apps Script forward, byte-identical). Freeze check on write actions first (RESEARCH "Freeze guard" `WRITE_ACTIONS` map, HTTP 503 `{ok:false,error:'maintenance',message}`).

**Dispatch + response + failure** (ops-proxy L76-102 and L44-64): build `work` promise from a lookup table (`get_batches`, `get_batch`, `get_batch_dashboard_summary`, `get_tasks_upcoming`, `get_tasks_calendar`, `get_batch_init`, `create_batch`, `update_batch`, `update_batch_schedule`, `delete_batch`, `update_batch_task`, `bulk_update_batch_tasks`, `add_batch_task`, `bulk_add_plato_readings`, `update_plato_reading`, `delete_plato_reading`, `regenerate_batch_token`; `propagate_ferm_schedule` already routes through `ferm-schedule-store.propagate`). Then:
```javascript
work.then(function (result) { sendEnvelope(res, action, logTag, result); })
    .catch(function (err) { sendFailure(res, action, logTag, err); });
return true;
```
`sendFailure` (L61-64): `log.error('[' + logTag + '] ' + action + ' (store) failed: ' + msg(err)); res.status(502).json({ ok: false, error: 'server_error' });` Business rejections are HTTP 200 `{ok:false,error,message}` (clients read `data.message || data.error`); only infra failure is 502.

**Interplay with `ops-proxy`:** `get_batch_init` must be assembled from `batchStore` reads plus `scheduleStore().list()` with the `{schedules:{schedules:[...]}}` shape (ops-proxy L136-141). Wire `batchProxy.intercept` BEFORE `opsProxy.intercept` in both proxies (pos.js L4131 and L4212):
```javascript
action = opsProxy.mapSheetsAction(action);
payload.action = action;
var isReadFlag = !!ADMIN_PROXY_READS[action];
if (batchProxy.intercept(action, payload, req, res, 'batch/admin-proxy')) return;   // NEW
if (opsProxy.intercept(action, payload, req, res, 'batch/admin-proxy', function () { ... })) return;
```
Once batches are in PG, ops-proxy's `create_batch` branch (L82-92) and `decorateForward`/`afterUpstream` vessel seam are unreachable for batch actions: leave the code, add a test proving it is not hit (RESEARCH Pattern 3 row 11).

**Test:** `__tests__/ops-proxy-routes.test.js` L1-40 harness (jest.mock express capturing handlers incl. put/delete, `axios`, logger, eventLog, cache; real `authTiers`, mocked `lib/session`) for `batch-proxy-routes.test.js`; sheets-mode cases assert the exact axios call sequence from `batch-admin-proxy.test.js` (read-only reference).

---

### `zoho-middleware/lib/ops-mirror.js` (MOD, add `batch` entity)

**Analog:** itself. Edit, not new module. Changes at known lines:

- **Entity table** (L32-36): add `batch: { prefix: KEY_ROOT + 'batch:', label: 'batches.mirror' }`.
- **`buildMirrorRequest`** (L74-82): add the `batch` branch. Row is a bundle `{batch, tasks, readings, history}` (one Apps Script round trip per touched batch); `null` row => `{ action: 'mirror_batch_delete', batch_id: id }` (same null-row convention as schedules, L80):
```javascript
if (entity === 'batch') {
  if (!row) return { action: 'mirror_batch_delete', batch_id: id };
  return { action: 'mirror_batch_state', batch: row.batch, tasks: row.tasks, readings: row.readings, history: row.history };
}
```
- **`readLatest`** (L132-138): add a third branch calling a new `batchPg.getBatchBundle(client, id)` in the same read-only `db.withTransaction`. `require('./batch-pg')` at top is fine (ops-mirror already requires vessel-pg and ferm-schedule-pg at L27-28); keep `ops-mirror.test.js` green (it mocks those two with `jest.mock('../lib/vessel-pg', ...)`; the NEW `ops-mirror-batch.test.js` mocks `batch-pg`; an existing test that loads ops-mirror without mocking batch-pg is fine as long as `batch-pg` has no side effects at load).
- `schedule()` (L183-204), `runWithRetry` (L155-177), `parseKey`/`sweep` (L206-259) are entity-generic already; `parseKey` splits on the first `:` after `KEY_ROOT` so `batch:SV-B-000123` parses correctly. Sweep is already registered at `server.js:~930`; no new timer.
- Sentry tags `{component:'ops-mirror', entity, id}` only; never customer names/emails.

**Retry/ordering invariants preserved:** one serial chain per `entity:id` (L84-92), read-latest-at-send, `RETRY_DELAYS_MS = [2000, 10000, 60000, 300000]`, 30-day Redis marker (L37-38), production-only via `sheetMirror.mirrorFireAndForget` (L186). Staging never mirrors.

---

### `zoho-middleware/routes/pos.js` (MOD)

**Analog:** itself. Seams (current lines):

1. **Proxies** L4110-4137 (`/api/batch/admin-proxy`) and L4192-4218 (`/api/admin/proxy`): insert `batchProxy.intercept(...)` as shown above. Allowlists unchanged (`ADMIN_PROXY_ACTIONS` L4062, `ADMIN_PANEL_PROXY_ACTIONS` L4164). `hardenProxyPayload` (L4054-4060) already strips server-only fields and sets `acting_user` from `req.staffEmail`; the batch store reads `payload.acting_user` as the actor.
2. **Public routes** L4243-4273: today `forwardToAppsScript(payload.action, payload, ...)` with an explicit field whitelist (L4244-4248, L4254-4260, L4266-4271). Keep the whitelist construction verbatim; in postgres mode call `batchStore.getPublic / publicUpdateTask / publicAddReadings` instead. Copy the sheets-mode forward unchanged (existing `batch-public.test.js`, `batch-public-guard.test.js`). Add freeze check on the two POST routes (503 JSON with `message`). Batch page client reads `data.message` regardless of status. Rate limiter (`server.js:727`) and guard bypass for `/batch/public/` (`server.js:396,451`) stay untouched. New behaviour in the port only: token compare via `crypto.timingSafeEqual` on equal-length buffers, `^SV-B-\d{6}$` and `^[0-9a-f]{32}$` pre-checks (`invalid_token`), `batch_disabled`, packaging completion blocked (`unauthorized`), actor `'batch-url'`, plus the recommended `task.batch_id === batch_id` hardening (RESEARCH Open Q8; regression test required).
3. **scan-invoices dedup** L3334-3351: replace the `axios.get(... get_batches ...)` block with `batchStore.listAll()` ONLY when `BATCHES_STORE=postgres`; keep the exact existing block for sheets mode. Same `existingSoNumbers[b.zoho_so_number] = true` indexing and the same "treat as empty on failure" `log.warn` fallbacks.
4. **reassign-customer** L3757-3776: `update_batch` with `expectedVersion`; in postgres mode `batchStore.update({batch_id, expectedVersion, updates})`; keep the `version_conflict` -> 409 branch (L3780-3784). Note the pre-existing bug (RESEARCH Pattern 3 #6): Apps Script returns `newVersion`, code reads `last_updated`.
5. **stampBottlingInviteSent** L3920-3950: advisory; in postgres mode route through `batchStore.update(...)`; freeze => log + swallow, always resolves.
6. **bulk-create** (~L3525-3540): depends on the exact `duplicate_so_number` error string to treat already-satisfied units as converged; the PG path must return the identical string.

**Forwarder** `forwardToAppsScript` L4012-4036 stays as is for non-batch actions.

---

### `zoho-middleware/lib/brewpad-integration.js` (MOD)

**Analog:** itself.

- `callAppsScriptCreateBatch(batchPayload, skipRetryQueue)` L260-304: keep the whole function shape (result handling, `eventLog.logEvent('kiosk.batch_created', ...)`, `queueForRetry` on `{ok:false}` unless `skipRetryQueue`). In postgres mode replace only the `axios.post(...)` with `batchStore.create(batchPayload, { actor: 'kiosk-middleware' })` and feed its result into the same `data.ok` branch (L279-294). The `if (!url || !token)` early-return (L263-266) must not block PG mode. Callers (unchanged): `createBatchesFromSale` L345/L390, retry sweep L449 (`callAppsScriptCreateBatch(retryData.payload, true)`), `detectRecipeSale` L823; plus `pos.js` bulk-create. Under freeze, `{ok:false,error:'maintenance'}` takes the `queueForRetry` branch; retry items exhaust in ~15 min and Scan invoices recovers them (D-04; RESEARCH Pitfall 6).
- `fetchLiveBatchIndex()` L696-728: postgres mode swaps the `axios.get` for `batchStore.listAll()` returning the same `{ byInvoiceNumber, liveBatchIds }` (index-building body L713-723 reused). Keep "NEVER throws; null means unknown" (L689-694).
- `cf_batch_status` Zoho writes (L469-800) unchanged.

---

### `zoho-middleware/lib/recipe-store.js` and `lib/ferm-schedule-store.js` (MOD, ref-count + propagate seams)

**Analogs:** themselves. Both are explicitly marked "Seam: Phase 87 replaces the body with SQL".

`recipe-store.js` L156-170 `hasBatchReferences(recipeId)` currently:
```javascript
return callAppsScript('recipe_batch_ref_count', { recipe_id: recipeId }).then(function (body) {
  if (!body || body.ok !== true || typeof body.count !== 'number' || !isFinite(body.count)) {
    throw unavailable('unexpected response');
  }
  return body.count;
}, function (err) { throw unavailable((err && err.message) || String(err)); });
```
Postgres branch: `if (batchStore.getMode() === 'postgres') return runPg(function (client) { return batchPg.countByRecipe(client, recipeId); })` with the same `err.code = 'batch_ref_unavailable'` rejection on failure (delete fails closed). Same for `ferm-schedule-store.hasBatchReferences` L161-170 (`countBySchedule`) and `propagate` L225-246 (replace the `callAppsScript('propagate_ferm_schedule', ...)` with `batchPg.propagateSchedule`; keep `batches_failed: []` default, L240-243; keep `getSchedule` first and `not_found` envelope L233-234). Require `batch-store` lazily inside the function (Pitfall 14). Existing `recipe-store`/`ferm-schedule-store` tests must stay green with the flag unset.

---

### `zoho-middleware/scripts/backfill/batches-backfill.js` (CLI)

**Analog:** `scripts/backfill/ops-backfill.js` (755 lines). Copy the file shape end to end; follow 86-PATTERNS "ops-backfill.js" substitutions. Excerpts verified at current lines:

**Header/imports/exits** (L55-77) with `specs` swapped for the four batch specs; keep `readXlsx`, `normalizeRow`, `rejectsLib`, `backfillCli.EXIT`, `assertSnapshotSafePath`, `checkHeaders`, `DEFAULT_TIMEZONE = 'America/Vancouver'`, `POSTGRES_URL_RE`, `INSERT_BATCH_SIZE = 500`.

**Pure plan builder** exported separately, CLI behind `require.main === module` (L737). Reject records carry sheet, row, id, field, generic reason only (`makeReject` L114-116); never a cell value. `maskEmail` L118-123 for any human email output (not needed here beyond customer_email: do not print).

**Header check with redaction** (L145-164 `checkSheetHeaders`): missing required header => reject; unexpected header => reject, with `SAFE_HEADER_RE`/`REDACTED_HEADER` so row-1 data is never echoed (commit `d7735bb6` lesson). `spec.optionalHeaders` lets the sheet carry `target_volume_L` (capital L) while DDL is `target_volume_l` (RESEARCH Pitfall 1 / Open Q6).

**Per-row plan with reject-never-coerce** (L174-229 `planVessels`): `rawId`, `normalizeSheetRow`, `seen` map for `duplicate_id`, id-regex check, push `makeReject(...)` and skip. Batch-specific rules: skip rows whose primary-key cell is blank (758 formatted-empty tail rows on Batches; `rowCount` lies); reject unknown `status`, bad ID formats, duplicate IDs, orphan child rows (tasks/readings/history referencing a missing batch: 4 live orphans `BT-000567..570` -> owner deletes them first), non-hex token, duplicate tokens, non-numeric plato/day_offset/step_number, bad timestamps; assign `unit_seq` by `row_number() over (partition by invoice, sku order by created_at, batch_id)` for rows with both fields; parents first (`batches`, then `batch_tasks`, `plato_readings`, `vessel_history`).

**Promote** (L406-568): `buildInsertSql` (L406-418, fixed table/column literals, only VALUES use `$n`), `insertBatched` (L420-431, 500 per statement), `runOpsPromoteChecks` (L441-459, names the failed check only), `runPromote` (L482-568): DB-name prompt, `to_regclass` + emptiness preconditions OUTSIDE the tx for ALL target tables (`TARGET_TABLES` L472 -> the 4 batch tables + `batch_tombstones`/`batch_create_dedup`), then one `BEGIN` ... inserts ... `setval` ... invariant checks ... `COMMIT`/`ROLLBACK`; client released exactly once; exit `CHECKS_FAILED` for non-empty target or failed invariant, `ERROR` otherwise. Seeds (L526-534 pattern): `setval('batch_id_seq', maxSV-B)` (=229 today), `batch_task_id_seq` (1047), `plato_reading_id_seq` (71), `vessel_history_id_seq` (415), each only when seed > 0. Invariants: per-table counts equal accepted counts, sequences >= max, no child without parent, every `unit_seq` assigned.

**CLI flags** (L572-575): equals-form only, `--file`, `--out-dir`, `--timezone`, `--dry-run | --promote`; no `--owners`; Postgres URL in argv refused; DB from `BACKFILL_DATABASE_URL` only; pool `db.createPool(url, {max:2})`. Exit codes: 0 ok, 1 error, 2 rejects present (blocks promote), 3 check failed (D-06: non-empty rejects file = no-go).

**Tests:** `__tests__/backfill/ops-backfill-plan.test.js`, `ops-backfill-header-redaction.test.js`, `ops-spec-headers.test.js` (pin the real 33/14/9/8 headers in a NEW `batches-spec-headers.test.js`; never edit `spec-headers.test.js`), real-PG `__tests__/db/ops-backfill.test.js` L1-60 (ExcelJS throwaway workbook in `os.tmpdir()`, synthetic data only).

---

### `zoho-middleware/scripts/backfill/specs/batches.js`, `batch-tasks.js`, `plato-readings-final.js`, `vessel-history-final.js` (spec)

**Analogs:** `specs/vessels.js`, `specs/ops-ferm-schedules.js` (86 final specs); `specs/vessel-history.js` and `specs/plato-readings.js` are Phase 83 REHEARSAL specs: reuse their header lists only (RESEARCH: `numeric(5,2)`, `moved_at` naming are not the final DDL). Spec shape from `specs/vessel-history.js` L15-31:
```javascript
module.exports = {
  sheet: 'VesselHistory',
  table: 'vessel_history',
  primaryKey: 'vh_id',
  columns: [
    { name: 'vh_id', header: 'history_id', type: 'id', required: true, pgType: 'text' },
    { name: 'batch_id', header: 'batch_id', type: 'id', required: true, pgType: 'text', prefix: 'SV-B', pad: 6 },
    { name: 'bin_id', header: 'bin_id', type: 'text', required: false, pgType: 'text' },
    { name: 'moved_at', header: 'transferred_at', type: 'timestamptz', required: true, pgType: 'timestamptz' },
```
Final names equal DDL names (`history_id`, `transferred_at`, `transferred_by`, `notes`; `reading_at` <- header `timestamp`). `header` = real row-1 text (Batches 33: `batch_id,...,bottling_invite_email`, BatchTasks 14, PlatoReadings 9, VesselHistory 8, listed in RESEARCH Pattern 1). Do not register in `specs/index.js` (dedicated multi-table CLI, 86 precedent). Cell types: dates are Date cells (`start_date`, task `due_date`, reading `timestamp`), `bin_id` is a number cell (normalise to text), booleans are real booleans.

---

### `zoho-middleware/scripts/backfill/batches-verify.js` (CLI, read-only compare)

**Analog:** `scripts/backfill/ops-verify.js` (369 lines). Copy: `begin transaction read only` + constant SQL + commit (L250 `fetchPg`), pure exported comparator `compareOps` (L187) split into per-entity compare functions (L107-175), `index(list, idField)` (L98), comparison helpers (L54-96: `isEmpty`, `text`, `sameText`, `sameNumber`, `asBool`, `canonical`), `parseArgs` rejecting Postgres URLs, `assertSnapshotSafePath`, `EXIT = { OK: 0, ERROR: 1, MISMATCH: 4 }` (L48).

Rules to keep (L7-23 header): numbers by value, `''` equals NULL, text trimmed, booleans normalised, output is `"<entity> <id> <field>"` lines and counts only, never a cell value. Batch additions: dates compared date-only, timestamps by epoch ms, `bin_id` as text, per-table row counts, child->parent integrity, header-row pin plus row-1 notice check (Apps Script writes the D-12 notice as a cell NOTE, not an inserted row), vessel-id orphan report (informational), assert Batches header is still exactly the pinned list. Also the exported comparer is reused by the optional 24 h drift timer (RESEARCH Pattern 8, open question 12).

---

### `zoho-middleware/scripts/backfill/batches-replay-to-sheet.js` (CLI)

**Analog:** `scripts/backfill/ops-replay-to-sheet.js` (203 lines). Copy verbatim structure: `parseArgs` (L35-59: Postgres URL refused, equals-form flags, `--apply`), `fetchPgState` (L61-75: one read-only tx), `buildReplayRequests` (L81-104: bodies come ONLY from `opsMirror.buildMirrorRequest` so replay == live mirror payload), `postSequentially` (L106-126: `axios.post(url, JSON.stringify(Object.assign({}, item.body, { server_token: token })), { headers, timeout: 30000, maxRedirects: 5 })`, stop at first `{ok:false}`), `runOpsReplay` (L131-163), `main()` (L165-192). Deps injected `{pool, axios, log, env}`; dry-run default; exit 0/1.

Batch differences: `--since=<iso>` (batches with `last_updated >= since` => `mirror_batch_state` bundles; `batch_tombstones.deleted_at >= since` => `mirror_batch_delete`); finish with a cache-flush call; then run `batches-verify`. Required first step of any rollback after the window (D-08). Output ids and counts only.

---

### `zoho-middleware/scripts/backfill/batches-parity.js` (CLI, D-06 dashboard gate) - partial analog

**Analogs (partial):** `ops-verify.js` for the pure comparator + CLI scaffold, `ops-replay-to-sheet.js` L106-126 for the HTTP leg. No existing deep-diff-of-two-read-APIs tool. Runs BEFORE the flag moves, frozen writes: sheet side = `GET APPS_SCRIPT_URL?action=get_batch_dashboard_summary | get_batches&status=all | get_tasks_upcoming&limit=200 | get_tasks_calendar&start_date=&end_date=` with `server_token` (mirror of `fetchLiveBatchIndex` call, `brewpad-integration.js` L704-707: `axios.get(url, { params: { action, server_token: token, ... }, timeout: 12000 })`); Postgres side = `batch-pg` read functions through the tunnel pool with the SAME injected "now" and timezone. Save sheet JSON as the pre-cutover snapshot OUTSIDE the repo (`assertSnapshotSafePath`-style guard; contains customer names). Canonical key order, ignore only fields intentionally absent from lists (`access_token`). Exit 4 on any difference (D-06: any dashboard number differing = no-go). Output: key paths and counts, never values.

---

### `apps-script/adminApi.gs` v62 (MOD, additive)

**Analog:** `mirrorVesselState` L4856-4875 and dispatch L365-376.

**Dispatch** (L365-376), add inside the same `server_token` branch:
```javascript
if (action === 'mirror_vessel_state') {
  return _jsonResponse(mirrorVesselState(payload));
}
```
-> `mirror_batch_state`, `mirror_batch_delete` (writes, POST), `export_batch_tabs` (GET read via `handleReadAction`, returns the 4 tabs as arrays keyed by header, ~0.8 MB). 

**Function body** (L4856-4875): validate payload and id regex first (`{ok:false,error:'missing_fields'|'invalid_id'}`), `acquireScriptLock(15000)` (defined L1483) with `finally { lock.releaseLock(); }`, header-addressed writes via the existing helper `_mirrorUpsertRow(sheetName, idField, idValue, obj, [])`, `invalidateSheetCache(sheetName)`. For batches: upsert the Batches row by `batch_id` (header match case-insensitive so `target_volume_L` is honoured); for BatchTasks/PlatoReadings/VesselHistory upsert each supplied row by id AND delete rows with that `batch_id` whose id is not supplied (covers `update_batch_schedule` removals, propagate, reading deletes); `mirror_batch_delete` removes batch plus children. Values verbatim (never re-sanitise); dates as `YYYY-MM-DD` strings, booleans as booleans, timestamps ISO strings, `bin_id` number. Eviction: `_invalidateBatchCache(batch_id)` (L3992-4000: removes `gbl gtu gbds gbi gfs gb:<id> gbp:<id>`) PLUS `invalidateSheetCache` for all four tabs, so a rollback to sheets never serves stale `gb:`/`gbl` (Phase 76 lesson; the schedule mirror's `_evictFermScheduleCaches` L4880-4883 is the model).

**D-12 notice:** new editor-run `setupBatchMirrorNotices()`: cell NOTE on header cells + warning-only protected range, never an inserted row (backfill/verify/mirror all key on row-1 header text).

**Tests:** `tests/frontend/adminapi-ops-mirror.test.js` harness (fake-Sheets `makeFakeSheet(headerRow)`, fake lock, `new Function` injection) in a NEW `adminapi-batch-mirror.test.js`; existing dispatch tests stay green. Record deploy + rollback version (61) in the RUNBOOK deploy table.

---

### `zoho-middleware/server.js` (MOD)

**Analog:** itself. L14 `var storeModes = storeFlag.validateStoreFlags();` -> add the batches-flag refusal beside it. L54 `var opsMirror = require('./lib/ops-mirror');`; sweep already registered at L929-934 (copy this block verbatim ONLY if the owner picks the automatic drift check, as `setInterval(..., 24 * 60 * 60 * 1000)` gated on `sheetMirror.isMirrorEnabled()`):
```javascript
setInterval(function () {
  opsMirror.sweep().catch(function (err) {
    log.error('[ops-mirror] sweep failed: ' + err.message);
  });
}, 5 * 60 * 1000);
```

---

### `docs/RUNBOOK.md` and `87-CUTOVER-LOG.md`

**Analog:** RUNBOOK Phase 86 section (L866-1011; deploy-table row with Apps Script version + rollback version, cutover steps, rollback). Outline for the new section is RESEARCH Pattern 10 (10 steps: T-7d v62 deploy + rehearsal + orphan cleanup; T-0 freeze via `BATCHES_FREEZE`; fresh workbook -> `--dry-run` (0 rejects) -> `--promote`; second fresh workbook -> verify (0 mismatches); parity (0 differences); flip = set `BATCHES_STORE=postgres` + unset `BATCHES_FREEZE` in ONE variable batch; owner smoke; Scan invoices for the window's invoices; rollback rules; day 1-7 drift check). Add the D-11 SQL-fix recipe (dry-run SELECT, UPDATE in a transaction, logged). Production deploy uses the pinned-SHA discipline from 85-13/86 (Pitfall 12); never `main` while 86 prod steps are pinned to `d2c66be9`.

---

## Shared Patterns

### Postgres access - single gateway
**Source:** `zoho-middleware/lib/db.js` (`query, withTransaction, isConfigured, createPool, close`).
**Apply to:** every new lib, route and CLI. Nothing else may `require('pg')` or `new Pool()`. `withTransaction` pool max 5: one call per mutation.

### Store-mode resolution
**Source:** `lib/store-flag.js` `resolveStoreMode(name)` (L40-52; invalid value logs and `process.exit(1)`).
**Apply to:** `batch-store.js`, `batch-proxy.js`, boot validation. Read the mode per call (not at module load) so tests can flip env with `jest.resetModules()`.

### Sheet-mirror production gate
**Source:** `lib/sheet-mirror.js` `mirrorFireAndForget(label, fn)`, `isMirrorEnabled()`.
**Apply to:** the `batch` entity in `ops-mirror.js` only. Never re-implement the production check; staging never mirrors (and, with `BATCHES_STORE=postgres`, staging batch writes no longer reach Apps Script at all).

### Business rejection vs infra failure
**Source:** `lib/vessel-pg.js` header L10-13 + `lib/vessel-store.js` header L4-10; `lib/ops-proxy.js` L44-64.
**Apply to:** batch-pg / batch-store / batch-proxy / public routes. Business failures resolve `{ok:false,error,message}` and go out as HTTP 200 (409 only where an existing contract demands it, e.g. reassign-customer `version_conflict`); only infra failures reject and map to `502 {ok:false,error:'server_error'}` with the cause logged server-side and never echoed. Writes are never retried through the proxy.

### Lazy requires in route-reachable libs
**Source:** `lib/ops-proxy.js` L16-17 (`function vesselStore() { return require('./vessel-store'); }`), RESEARCH Pitfall 14.
**Apply to:** anything `pos.js`, `brewpad-integration.js`, `recipe-store.js`, `ferm-schedule-store.js` newly pull in (`batch-store`, `batch-proxy`). Route tests mock `constants`, `cache`, `logger`; do not read missing constants at module load.

### Privacy in logs, rejects, Sentry
**Source:** `scripts/backfill/ops-backfill.js` `makeReject` L114-116, `SAFE_HEADER_RE`/`REDACTED_HEADER` L108-112; `lib/ops-mirror.js` Sentry tags L173, L252.
**Apply to:** all CLIs and mirror/drift code. Output ids, field names, counts only; no customer names/emails, no echoed header text that could be data.

### Auth on proxies and public routes
**Source:** `routes/pos.js` L4111 `authTiers.requireTiers(['legacy', 'session'])(req, res, function () {...})` for the two proxies; public routes have NO authTiers wrapper (token-validated, exempt via `server.js` path prefix `/batch/public/`).
**Apply to:** keep as is. In postgres mode the store becomes the sole token validator (it was Apps Script's).

### Test protection
CLAUDE.md rule 10 and RESEARCH Project Constraints: no edits to existing tests; unset-flag behaviour byte-identical. Real-PG tests via `npm run test:db` (Docker Desktop must be running; self-skips locally).

### Build and verification gates
`cd zoho-middleware && npm test`, root `npm test`, `npm run lint` (middleware `--max-warnings 0` over `routes/ lib/ scripts/ server.js`), `npm run migrate:guard`, `npm run test:db`, and the `js/brewpad.js` unchanged gate. Baselines at 86-18: root 2248, middleware 2804, `test:db` 176.

## No Analog Found

| File / Concern | Role | Data Flow | Reason |
|----------------|------|-----------|--------|
| Maintenance freeze (`BATCHES_FREEZE` env, 503 on writes, read pass-through, covers proxies + 3 public routes + facade writes + advisory stamp) | middleware guard | request-response | Nothing like it exists; use RESEARCH Pattern 4 and the "Freeze guard" example. Deliberately env not Redis, no auto-expiry |
| Invoice-keyed idempotent create (advisory lock + `unit_seq` + partial unique index + manual-create fingerprint table) | service (SQL) | CRUD | Closest is `batchDedupDecision` (adminApi.gs L2566) under `acquireScriptLock`; PG advisory-lock design is new (RESEARCH Pattern 5, Assumption A3) |
| Multi-table per-batch mirror bundle with child-row reconcile (delete rows no longer supplied) | worker + Apps Script | event-driven | 85/86 mirrors copy a single row; the `batch` bundle and `mirror_batch_delete` are new (RESEARCH Pattern 8) |
| `batches-parity.js` before-flip dashboard diff | script (CLI) | batch | Only partial analogs for comparator + HTTP leg |
| FK `ON DELETE CASCADE`, partial unique/non-unique indexes, `batches.schedule_id` FK in DDL | migration | DDL | 0001-0004 contain none; allowlist acceptance must be pinned by running `migrate:guard` on the draft (Wave 0) |
| Daily drift timer + `export_batch_tabs` read action | timer + Apps Script read | event-driven | Optional (owner decision, Open Question 12); sweep timer block in `server.js` is the registration model |
| D-12 header cell notes + warning protected ranges | Apps Script setup fn | file-I/O | Phase 86 applied this to Config via a setup function (RUNBOOK 86 sec. 11); no code to copy verbatim, follow that RUNBOOK recipe |

## Metadata

**Analog search scope:** `zoho-middleware/lib/`, `zoho-middleware/routes/pos.js`, `zoho-middleware/migrations/`, `zoho-middleware/scripts/backfill/` (incl. `specs/`), `zoho-middleware/__tests__/` (root, `db/`, `backfill/`), `zoho-middleware/server.js`, `apps-script/adminApi.gs`, `.planning/phases/86-*/86-PATTERNS.md`, 87-CONTEXT.md, 87-RESEARCH.md
**Files read (full or targeted):** `lib/vessel-store.js` (full), `lib/ops-mirror.js` (full), `lib/ops-proxy.js` (full), `lib/store-flag.js` (25-94), `lib/vessel-pg.js` (1-110, 270-325), `lib/ferm-schedule-store.js` (100-260), `lib/recipe-store.js` (28-180), `lib/brewpad-integration.js` (255-305, 686-740), `migrations/0004_ops_data.sql` (full), `routes/pos.js` (3330-3355, 3745-3790, 3918-3950, 4008-4285), `scripts/backfill/ops-backfill.js` (1-235, 400-580), `scripts/backfill/ops-verify.js` (1-80 + function index), `scripts/backfill/ops-replay-to-sheet.js` (full), `scripts/backfill/specs/vessel-history.js` (full), `scripts/migration-allowlist.js` (80-150), `apps-script/adminApi.gs` (360-380, 3992-4000, 4856-4890), `server.js` (920-936), `__tests__/db/vessel-pg-update.test.js`, `ops-backfill.test.js`, `ops-migration.test.js`, `ops-mirror.test.js`, `ops-store-flag.test.js`, `ops-proxy-routes.test.js` (headers/harness)
**Files scanned (listings/greps):** ~90
**Pattern extraction date:** 2026-10-09

# Phase 87 Design: Batches, BatchTasks, PlatoReadings, VesselHistory to Postgres

Status: APPROVED 2026-10-09

Requirement: DB-06. Gate: D-01 (no implementation plan 87-02 onward runs until this is approved).
Sources: 87-CONTEXT.md (D-01..D-15), 87-RESEARCH.md (Patterns 1-10, Pitfalls 1-14), 87-PATTERNS.md.
Data policy: this document carries IDs, counts and field names only. No customer names, emails or token values.

## 1. Scope and non-goals

In scope: the four shop-floor tables (Batches, BatchTasks, PlatoReadings, VesselHistory) become Postgres
tables, cut over in one rehearsed Sunday maintenance window (no dual-write window). Every consumer keeps
its current contract: the two admin proxies (17 batch-data actions), the three public `batch.html`
routes, the kiosk/online sale hook, scan-invoices, reassign-customer, the bottling-invite stamp,
the Zoho `cf_batch_status` reconcile, and the recipe/schedule reference-count and propagate seams.

Non-goals:
- Waitlist sheet to Postgres: deferred to Phase 88 (ROADMAP Phase 88 to be updated).
- No change to `js/brewpad.js`, `js/admin.js`, `js/batch.js` (static gate: `git diff --exit-code origin/main -- js/brewpad.js js/brewpad.min.js`).
- No new batch-edit UI; hand fixes use the D-11 SQL recipe.
- No dual mode. No change to the public batch page behaviour (one optional hardening, Q8).
- No CSP change (no new third-party domain).

## 2. Schema (0005_batches.sql)

Final DDL, validated by both guards in a scratch directory (evidence below). Never edit once applied.

```sql
-- Up Migration
create sequence batch_id_seq start 1 minvalue 1;
create sequence batch_task_id_seq start 1 minvalue 1;
create sequence plato_reading_id_seq start 1 minvalue 1;
create sequence vessel_history_id_seq start 1 minvalue 1;

create table batches (
  batch_id text primary key
    default ('SV-B-' || lpad(nextval('batch_id_seq')::text, 6, '0'))
    check (batch_id ~ '^SV-B-[0-9]{6,}$'),
  status text not null check (status in ('pending', 'primary', 'secondary', 'complete', 'disabled')),
  product_sku text not null default '',
  product_name text not null default '',
  customer_id text not null default '',
  customer_name text not null default '',
  customer_firstname text not null default '',
  customer_lastname text not null default '',
  customer_email text not null default '',
  customer_phone text not null default '',
  start_date date,
  schedule_id text references ferm_schedules (schedule_id),
  schedule_snapshot text not null default '',
  vessel_id text not null default '',
  shelf_id text not null default '',
  bin_id text not null default '',
  notes text not null default '',
  access_token text not null check (access_token ~ '^[0-9a-f]{32}$'),
  reservation_id text not null default '',
  created_at timestamptz not null,
  created_by text not null default '',
  last_updated timestamptz not null,
  last_regenerated_at timestamptz,
  source text not null default 'manual',
  zoho_so_number text not null default '',
  fermentation_started_at timestamptz,
  completed_at timestamptz,
  recipe_id text not null default '',
  recipe_snapshot text not null default '',
  target_volume_l numeric,
  scale_factor numeric,
  bottling_invite_sent_at timestamptz,
  bottling_invite_email text not null default '',
  unit_seq integer
);
create unique index batches_access_token_idx on batches (access_token);
create index batches_status_created_idx on batches (status, created_at desc);
create index batches_location_idx on batches (vessel_id, shelf_id, bin_id) where status in ('primary', 'secondary');
create index batches_invoice_idx on batches (zoho_so_number, product_sku) where zoho_so_number <> '';
create index batches_schedule_idx on batches (schedule_id) where schedule_id is not null;
create index batches_recipe_idx on batches (recipe_id) where recipe_id <> '';
create unique index batches_unit_seq_idx on batches (zoho_so_number, product_sku, unit_seq) where unit_seq is not null;

create table batch_tasks (
  task_id text primary key
    default ('BT-' || lpad(nextval('batch_task_id_seq')::text, 6, '0'))
    check (task_id ~ '^BT-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  step_number integer not null,
  title text not null default '',
  description text not null default '',
  day_offset integer not null,
  due_date date,
  is_packaging boolean not null default false,
  is_transfer boolean not null default false,
  completed boolean not null default false,
  completed_at timestamptz,
  completed_by text not null default '',
  notes text not null default '',
  last_updated timestamptz not null
);
create index batch_tasks_batch_idx on batch_tasks (batch_id, step_number, task_id);
create index batch_tasks_open_due_idx on batch_tasks (due_date) where completed = false;

create table plato_readings (
  reading_id text primary key
    default ('PR-' || lpad(nextval('plato_reading_id_seq')::text, 6, '0'))
    check (reading_id ~ '^PR-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  reading_at timestamptz not null,
  degrees_plato numeric,
  notes text not null default '',
  recorded_by text not null default '',
  created_at timestamptz not null,
  temperature numeric,
  ph numeric
);
create index plato_readings_batch_idx on plato_readings (batch_id, reading_at);

create table vessel_history (
  history_id text primary key
    default ('VH-' || lpad(nextval('vessel_history_id_seq')::text, 6, '0'))
    check (history_id ~ '^VH-[0-9]{6,}$'),
  batch_id text not null references batches (batch_id) on delete cascade,
  vessel_id text not null default '',
  shelf_id text not null default '',
  bin_id text not null default '',
  transferred_at timestamptz not null,
  transferred_by text not null default '',
  notes text not null default ''
);
create index vessel_history_batch_idx on vessel_history (batch_id, transferred_at desc);

create table batch_tombstones (
  batch_id text primary key,
  deleted_at timestamptz not null,
  deleted_by text not null default ''
);

create table batch_create_dedup (
  fingerprint text primary key,
  batch_id text not null,
  created_at timestamptz not null
);

-- Down Migration (reverse order: dedup, tombstones, history, readings, tasks, batches, then the four sequences)
```

Rules baked into the schema:
- NULL vs '' rule: text columns are `not null default ''` (Sheets semantics, trivial serializer); date, timestamp and numeric columns are NULL when blank and the serializer emits `''`.
- `last_updated` and task `last_updated` have no default; they are written from a JS Date (ms precision) and emitted with `toISOString()` (Pitfall 11). It is the `update_batch` expectedVersion token (lenient: conflict only when server value is newer than the client value).
- `schedule_snapshot` and `recipe_snapshot` stay `text` (raw copy; jsonb would reorder keys).
- `bin_id` is stored as text; the serializer emits a JSON number when the value matches `^[0-9]+$` (Q4).
- `access_token` is plaintext (D-14: re-displayable for QR printing), unique-indexed.
- FKs: tasks, readings and history reference `batches (batch_id) ON DELETE CASCADE` (replaces the 3-sheet delete loop, ROADMAP SC1). `batches.schedule_id` references `ferm_schedules` (RESTRICT, nullable, Q5). No FK on `vessel_id` (sheet accepted free text; verify reports orphans informationally). The facade pre-validates `schedule_id` and returns a clean `not_found` rather than surfacing an FK error.
- No unique `(batch_id, step_number)` (68 historical duplicate pairs) and no unique location index (Q7).
- Sequences: seeded with `setval` at backfill (never in the migration, the allowlist rejects it). Values as of the 2026-10-06 snapshot: batch 229, task 1047, reading 71, history 415; re-measured at each rehearsal. Sequences never reuse a deleted highest ID (the sheet's max+1 did); this is an accepted improvement. After a rollback and re-flip, re-run `setval` to max(sheet, pg) (Pitfall 8).
- `unit_seq`: NULL unless the batch has both invoice number and SKU; backfill assigns `row_number() over (partition by invoice, sku order by created_at, batch_id)`.

### Guard evidence (Task 1 dry run, 2026-10-09)

The draft above was copied with 0001..0004 into a scratch directory under /tmp (not in the repo) and run through both CLIs:

| Guard | Command | Exit | Result |
|-------|---------|------|--------|
| migration-guard | `node scripts/migration-guard.js <scratch>` | 0 | "5 file(s) additive-only OK" |
| migration-allowlist | `node scripts/migration-allowlist.js <scratch>` | 0 | "5 file(s) additive-only OK" |

Accepted on the first attempt, no fallback needed: partial UNIQUE index (`where unit_seq is not null`), partial non-unique indexes (`where status in (...)`, `<> ''`, `is not null`, `completed = false`), `ON DELETE CASCADE`, FK to `ferm_schedules`, regex CHECKs written with `[0-9]`, `nextval`/`lpad` defaults, `timestamptz`/`date`/`numeric` types, composite and `desc` index keys. `ls zoho-middleware/migrations` still lists exactly 0001..0004; the guard files are untouched. Caveat: libpg-query parses the PG16 grammar while production runs PG 18.6 (memory: railway-postgres-is-v18); the real-PG test harness is `postgres:18-alpine`, which covers the runtime side.

## 3. Index-to-query map

| Index | Query it serves |
|-------|-----------------|
| `batches` PK `batch_id` | detail, update, delete, public read, child FK checks |
| `batches_status_created_idx (status, created_at desc)` | `get_batches` newest-first list and `active` filter (primary/secondary/pending), dashboard status counts, `needsScheduling` (pending newest first), dashboard/calendar/upcoming active-batch set |
| `batches_location_idx (vessel_id, shelf_id, bin_id) where status in ('primary','secondary')` | `checkLocationConflict` (create, update, transfer completion); non-unique by design (Q7) |
| `batches_invoice_idx (zoho_so_number, product_sku) where zoho_so_number <> ''` | create_batch dedup guard, scan-invoices dedup, `fetchLiveBatchIndex` / cf_batch_status reconcile index |
| `batches_unit_seq_idx` (unique, partial) | D-15 backstop: a second writer that bypasses the advisory lock hits 23505, mapped to `duplicate_so_number` |
| `batches_schedule_idx (schedule_id) where not null` | `ferm_schedule_ref_count`, `propagate_ferm_schedule` batch selection |
| `batches_recipe_idx (recipe_id) where <> ''` | `recipe_batch_ref_count` |
| `batches_access_token_idx` (unique) | public token integrity and uniqueness (lookup is by `batch_id`, token compared in constant time) |
| `batch_tasks_batch_idx (batch_id, step_number, task_id)` | detail children ordering (by step number), schedule reconcile by step, packaging-completion "all non-packaging done" check, tasks_total/tasks_done counts, calendar/upcoming joins |
| `batch_tasks_open_due_idx (due_date) where completed = false` | upcoming (dated ascending, TBD last), overdue, due-today, due-this-week, ready-to-bottle |
| `plato_readings_batch_idx (batch_id, reading_at)` | detail readings ascending; public readings |
| `vessel_history_batch_idx (batch_id, transferred_at desc)` | detail history (newest first) |
| `batch_tombstones` PK, `batch_create_dedup` PK | mirror delete / replay-since; manual-create replay window (Section 11) |

Calendar: dated tasks of primary/secondary batches filtered by `due_date between start and end` use the open-due index plus the batch status filter; the undated-packaging "ready" rule is evaluated per batch from `batch_tasks_batch_idx`.

## 4. Module layout (Claude's discretion, split so plans can run in parallel)

All in `zoho-middleware/lib/` unless noted; ES5-style with `var`/promise chains except `*-pg.js` where `async` is already precedent.
- `batch-flag.js`: mode (`sheets|postgres`) and freeze reader (Section 10, 12).
- `batch-rules.js`: pure functions: serializers (NULL to '', booleans, `bin_id` number, date-only truncations, sort orders), dedup decision, due-date math, status and vessel transition table, validators (plato <= 40, ph 0..14, caps 50/20), dashboard bucket math with the script timezone.
- `batch-pg-read.js`: list, detail, public, dashboard, calendar, upcoming, ref counts, list-all index.
- `batch-pg-create.js`: createBatch with locks, dedup, unit_seq, tasks, history, vessel in-tx.
- `batch-pg-update.js`: updateBatch, updateBatchSchedule, deleteBatch, regenerateToken, propagateSchedule.
- `batch-pg-tasks.js`: updateBatchTask, bulkUpdate, addBatchTask, packaging completion/uncompletion, readings CRUD.
- `batch-store.js`: the facade and single issuer: mode, freeze guard, sheets-mode passthrough helpers (exact current axios calls), mirror scheduling, strip of `access_token` in lists.
- `batch-proxy.js`: `intercept(action, payload, req, res)` for both proxies, called before `opsProxy.intercept`.
- `ops-mirror.js`: edit, add entity `batch`.
- `batch-compare.js`: shared sheet-vs-PG comparator (used by verify and drift).
- `batch-drift.js`: production-only timer (Section 14).
- `scripts/backfill/`: `batches-backfill.js`, `batches-verify.js`, `batches-parity.js`, `batches-replay-to-sheet.js`, specs.
- `apps-script/adminApi.gs`: v62 additive actions.

## 5. Action inventory

17 batch-data proxy actions = 12 on the BrewPad allowlist + 5 admin-only. (BrewPad's allowlist has 21 entries; the other 9 are vessels, ferm-schedule CRUD and waitlist, not batch data.)

BrewPad and admin (12): `get_batches`, `get_batch`, `get_batch_dashboard_summary`, `get_tasks_upcoming`, `create_batch`, `update_batch`, `update_batch_schedule`, `delete_batch`, `bulk_update_batch_tasks`, `bulk_add_plato_readings`, `update_plato_reading`, `delete_plato_reading`.
Admin only (5): `get_batch_init`, `get_tasks_calendar`, `update_batch_task`, `add_batch_task`, `regenerate_batch_token`. (`propagate_ferm_schedule` also writes BatchTasks and moves through `ferm-schedule-store`, see Section 6.)

| Action | Request | Success response |
|--------|---------|------------------|
| get_batches | status?, limit?, offset? | `{ok:true,data:{batches,total,filtered}}` |
| get_batch | batch_id | `{ok:true,data:{batch,tasks,plato_readings,vessel_history}}` or `data:{error}` |
| get_batch_dashboard_summary | none | `{ok:true,data:summary}` |
| get_tasks_upcoming | limit? (default 50) | `{ok:true,data:{tasks}}` |
| get_tasks_calendar | start_date, end_date | `{ok:true,data:{tasks}}` |
| get_batch_init | status?, limit?, offset? | `{ok:true,data:{batches,schedules,summary}}` |
| create_batch | see createBatch | `{ok,batch_id,access_token,tasks_created[,status,warnings]}` or `{ok:false,error,message}` |
| update_batch | batch_id, updates, expectedVersion? | `{ok,message,newVersion}` |
| update_batch_schedule | batch_id, schedule_snapshot, schedule_id?, expectedVersion? | `{ok,tasks_updated,tasks_created,tasks_removed}` |
| delete_batch | batch_id | `{ok,message}` |
| update_batch_task | task_id, batch_id?, updates, transfer_location? | `{ok,message,batch_id}` |
| bulk_update_batch_tasks | batch_id?, tasks (1..50) | `{ok,results,affected_batch_ids}` |
| add_batch_task | batch_id, title, ... | `{ok,task_id,message}` |
| bulk_add_plato_readings | batch_id, readings (1..20) | `{ok,results}` |
| update_plato_reading / delete_plato_reading | reading_id, updates / reading_id | `{ok,reading_id}` |
| regenerate_batch_token | batch_id | `{ok,access_token}` |

Transport: app-level failures are HTTP 200 `{ok:false,error,message}`; transport failures collapse to 502 `{ok:false,error:'server_error'}`. Reads are enveloped `{ok:true,data}`; writes return the raw object.

Apps Script behaviour catalogue the port must reproduce (RESEARCH "Apps Script behaviour catalogue" is the normative list; the load-bearing rules):
- getBatches: `active` = primary/secondary/pending; created_at desc; `tasks_total`/`tasks_done`; `access_token` stripped; `start_date` 10 chars.
- getBatchDetail: includes `access_token`; tasks by step number; readings ascending; history descending.
- createBatch: missing_fields rule; pending when no schedule or no start date; non-pending requires schedule; location_conflict check; one task per step; initial history row only when any location field is present; vessel to In-Use when non-pending and vessel_id; pending batches with a vessel do not mark it In-Use (Q19); kiosk source blanks `customer_email`.
- updateBatch: lenient expectedVersion; location change writes a history row with the old location and flips old vessel Empty / new In-Use; valid targets primary/secondary/complete/disabled (`pending` not valid); whitelisted fields sanitized; active/inactive transitions flip the current vessel.
- deleteBatch: releases the vessel, removes children (now FK cascade).
- updateBatchTask / packaging completion and uncompletion / transfer auto-advance primary to secondary / bulk / add task / readings validators / token regeneration / propagate: as catalogued.
- Atomicity improvement: the Sheets flows were non-atomic (e.g. history written before `invalid_status` rejection); Postgres makes each mutation one transaction. Clients cannot observe this except as strictly safer behaviour.

## 6. Caller seams (single-issuer invariant)

A proxy-only swap would leave nine direct callers writing the sheet (split brain). `batch-store.js` is the single issuer of every batch Apps Script action; sheets mode keeps the exact current axios call.

| # | Site | After (postgres) |
|---|------|------------------|
| 1 | `routes/pos.js` `/api/batch/admin-proxy` and `/api/admin/proxy` | `batchProxy.intercept` before `opsProxy.intercept` |
| 2 | `routes/pos.js` public GET `/api/batch/public/:id`, POST `.../tasks`, POST `.../readings` | `batchStore.getPublic / publicUpdateTask / publicAddReadings` |
| 3 | `brewpad-integration.callAppsScriptCreateBatch` (sale hook, retry sweep, bulk-create) | `batchStore.create(payload,{actor:'kiosk-middleware'})`; keeps queueForRetry on `{ok:false}` |
| 4 | `brewpad-integration.fetchLiveBatchIndex` | `batchStore.listAll()` |
| 5 | `routes/pos.js` scan-invoices dedup | `batchStore.listAll()` |
| 6 | `routes/pos.js` reassign-customer | `batchStore.update({batch_id,expectedVersion,updates})`; 409 on `version_conflict` |
| 7 | `routes/pos.js` `stampBottlingInviteSent` | `batchStore.update(...)`; frozen: log and swallow (advisory) |
| 8 | `recipe-store.hasBatchReferences` | `select count(*) from batches where recipe_id = $1` |
| 9 | `ferm-schedule-store.hasBatchReferences` | `select count(*) from batches where schedule_id = $1` |
| 10 | `ferm-schedule-store.propagate` | `batchPg.propagateSchedule` (one tx per batch, `batches_failed` preserved) |
| 11 | `ops-proxy.intercept` create_batch branch and vessel-delta seam | unreachable for batch actions once postgres; left in place, test proves it is not hit |

`createBatchesFromSale` (kiosk x2, online checkout, `detectRecipeSale`) needs no change when the facade sits behind `callAppsScriptCreateBatch`.
Static test: a grep-style test fails if any Apps Script batch action name appears outside the facade, its sheets branch, and the proxies (Phase 85 "single recipe-action issuer" precedent). Existing suites for these callers must stay green untouched in sheets mode (rule 10).

## 7. Transactions and vessels

- One `db.withTransaction` per mutation. Row lock order: `select ... from batches where batch_id = $1 for update` first (serialises concurrent task toggles so the "all non-packaging done" decision cannot race), then advisory locks (dedup lock, location lock) in a fixed order. Create takes the dedup lock then the location lock.
- Vessel status via `vessel-pg.applyStatusChanges(client, changes, opts)` on the same client (D-13); afterwards the store schedules vessel mirror for `result.applied`. Unknown vessel ids are ignored as the sheet did.
- Schedule steps are read in-transaction via `ferm-schedule-pg.getSchedule(client, id)` (no HTTP hop).
- Delete: insert into `batch_tombstones` (upsert), apply vessel Empty, delete the batch row; FK cascade removes children.
- Due dates: built from y/m/d parts plus `day_offset` days (blank when offset < 0), tested across month ends and DST.
- `last_updated` from a JS Date, never `now()`.

## 8. Public token path (D-14)

Same URLs, same existing tokens (printed QR codes keep working), same read, task-update and add-reading abilities.
- GET: format pre-check (`^SV-B-[0-9]{6,}$` batch id and `^[0-9a-f]{32}$` token) returns `invalid_token`; lookup by `batch_id`; missing batch returns `not_found` (parity, Q16); token compared with `crypto.timingSafeEqual` on equal-length buffers; `disabled` returns `batch_disabled`; strips `customer_email`, `reservation_id`, `access_token`; keeps `customer_phone`, `notes`, `recipe_snapshot` (parity, Q17). No cache needed (the 5 s script cache is dropped).
- POST tasks: route keeps its explicit field whitelist; packaging completion blocked (`unauthorized`); actor `batch-url`; recommended hardening: task must belong to the token's batch (Q8, regression test first).
- POST readings: `bulk_add_plato_readings`, `recorded_by = 'batch-url'`, limit 20, same validators; delete-reading must belong to the batch.
- Existing limiter (`batchPublicLimiter`) and the guard bypass for `/batch/public/` stay untouched.
- Tokens: `crypto.randomBytes(16).toString('hex')`; regenerate sets `last_regenerated_at`, the old token dies immediately (no cache).

## 9. Zoho cf_batch_status hooks

`fetchLiveBatchIndex` and scan-invoices read through `batchStore.listAll()` and return the identical `{byInvoiceNumber, liveBatchIds}` shape. The Zoho write side (label derivation, reconcile, sync) is unchanged. Reconcile reads see Postgres after the flip. `batch-reconcile-status.test.js` and `batch-scan-invoices.test.js` stay green in sheets mode.

## 10. Maintenance freeze (D-05)

- Switch: env var `BATCHES_FREEZE` holding the human "until" text (for example `9:00 PM PT`). Non-empty means batch writes are blocked in either store mode. Read per request (no timer, no auto-expiry: an overrunning window must never silently re-open sheet writes after the snapshot).
- Chosen over a Redis key (a Redis outage would create fail-open split-brain or fail-closed lockout) and over a store-flag value (it must work in `sheets` mode before the flip). The flip is one Railway variable batch (`BATCHES_STORE=postgres`, unset `BATCHES_FREEZE`), one restart; rollback is the mirror image.
- Response on both proxies: HTTP 503 `{ok:false,error:'maintenance',message:'Batches are read-only for maintenance until <text>. Please try again then.'}`. Clients read `message`, so the existing error display works with no client change.
- Guarded paths: write actions on both proxies (create_batch, update_batch, update_batch_schedule, delete_batch, update_batch_task, bulk_update_batch_tasks, add_batch_task, bulk_add_plato_readings, update_plato_reading, delete_plato_reading, regenerate_batch_token); the write handlers of the public task and reading routes; `batchStore.create/update` for the direct callers. Reads are never frozen.
- Kiosk create returns `{ok:false,error:'maintenance'}` so the failure is logged and queued; the queue exhausts in about 15 minutes and Scan invoices recovers the batches (D-04, no new queue code). The bottling-invite stamp logs and swallows.
- The runbook lists the window's invoices from the `kiosk.batch_retry_queued` event log and the "Apps Script returned error" warnings.

## 11. Idempotency (D-15)

- Invoice-linked creates: inside the create transaction, `pg_advisory_xact_lock(hashtext(zoho_so_number || '|' || product_sku))`; count existing rows for the trimmed invoice and SKU; `allowed = max(1, floor(unit_total))`; at or over the limit return the exact existing object `{ok:false,error:'duplicate_so_number',message:'SO/invoice X + SKU Y already has N of M batch(es): ids'}` (bulk-create depends on the string). Otherwise `unit_seq = count + 1`. The partial unique index `(zoho_so_number, product_sku, unit_seq)` is the DB backstop; 23505 maps to `duplicate_so_number`. Invoice without SKU: any existing row for the invoice is a duplicate (parity). No invoice: no invoice guard.
- Manual creates (no invoice): fingerprint `sha256(actor | product_sku | recipe_id | customer_name | start_date | schedule_id | vessel_id | shelf_id | bin_id | notes)` in `batch_create_dedup`; insert on conflict updates only when the old row is older than the window (default 2 minutes, Q11); a hit inside the window returns the existing `{ok:true,batch_id,access_token,tasks_created,idempotent_replay:true}` so a retried client sees success. D-15 requires BrewPad network-retry protection, which is a manual-create path, so "invoice-only" is not offered as an option.
- Retried kiosk hook: covered by the invoice-linked rule (same invoice, SKU, `unit_total`).
- Tests: parallel x3 creates yield exactly `unit_total` rows; replay returns the same batch.

## 12. Flag: BATCHES_STORE

- `lib/batch-flag.js` reads `BATCHES_STORE` (`sheets` default, `postgres`) using `storeFlag.resolveStoreMode` and `storeFlag.validateStoreFlags(['BATCHES_STORE'])` with an explicit list. It does NOT touch `STORE_ENV_NAMES`, because `__tests__/store-flag.test.js` asserts that array with `toEqual` (L51, L92) and editing an existing test violates rule 10 (Q15).
- `dual` refuses to boot (no dual-write by design) with a message naming the variable.
- `postgres` refuses to boot unless `OPS_DATA_STORE` is `dual` or `postgres` (vessels PG-authoritative, matching `ops-proxy.pgActive()`).
- `server.js` `isDatabaseRequired()` also returns true when `BATCHES_STORE=postgres`, so `/health` reports `database_required:true`.
- Production additionally requires `OPS_DATA_STORE=postgres` as a procedural gate (D-13): the production window is not scheduled until the Phase 86 flip is recorded.
- Modules require `store-flag`, `db`, `ops-mirror` lazily (route tests mock constants/cache/logger; Pitfall 14).

## 13. Mirror (D-10, D-12)

- Production only, fire-and-forget via `sheet-mirror.mirrorFireAndForget`; staging never mirrors. Staging and production share one workbook and one Apps Script deployment, so every Apps Script change is additive and a staging rehearsal uses a fresh downloaded workbook, never the live sheet.
- Entity `batch` in `ops-mirror.js`: `readLatest` reads the batch plus tasks, readings and history in one read-only transaction; payload `mirror_batch_state` with a per-batch bundle `{batch, tasks, readings, history}`, or `mirror_batch_delete {batch_id}` for a missing row. Reuses the Redis dirty marker, 5-minute sweep and 2 s / 10 s / 60 s / 5 min backoff. Triggers: every successful facade write; bulk updates schedule each affected id; propagate schedules each updated batch; vessel changes also schedule vessel mirror; deletes schedule the batch after commit.
- Apps Script v62 (additive; rollback target v61): `mirror_batch_state` (under the script lock; upsert the Batches row by `batch_id`, writing by header name case-insensitively so `target_volume_L` is honoured, Q6; upsert each child by its id and delete rows of that `batch_id` whose id is no longer supplied), `mirror_batch_delete`, and `export_batch_tabs` (read, for the drift check). Both mirror actions evict the batch caches (`_invalidateBatchCache` plus the list, upcoming, dashboard and index keys) so a rollback never serves stale cache. Values are written verbatim; dates as `YYYY-MM-DD`, booleans as booleans, timestamps as ISO strings, `bin_id` as number.
- D-12 notices: header-cell notes plus warning-only protected ranges via `setupBatchMirrorNotices()` (run from the Apps Script editor in the window right after the flip, Q20), with `removeBatchMirrorNotices()` for rollback. No inserted row, because backfill, mirror and verify key on row 1 header text (the Config tab burned a rehearsal on this); verify asserts row 1 equals the pinned header list.

## 14. Tooling

- `batches-backfill.js` (dry-run / promote): one workbook snapshot into four tables in ONE transaction, parents first; empty-target preconditions on all tables; DB-name prompt; `BACKFILL_DATABASE_URL` only; `--timezone=America/Vancouver` default; skips rows with a blank primary key (758 formatted-empty Batches tail rows); rejects (never coerces) bad IDs, duplicate IDs, unknown status, orphan children, non-hex or duplicate tokens, non-numeric plato/day_offset/step_number, bad timestamps. Reject records carry sheet, row, id, field and a generic reason only (no cell values; the 86 header-echo fix `d7735bb6` applies). Exit codes 0/1/2 (rejects)/3 (check failed). Sets sequences with `setval`, runs in-transaction invariants. D-06 bar: 0 rejects.
- `batches-verify.js` (read-only vs a fresh .xlsx): per-table counts, per-field compare (booleans normalised, ''=NULL, date-only dates, epoch-ms timestamps, `Number` numerics, `bin_id` as text), child-to-parent integrity, header-row pin, vessel-id orphan report (informational). Exit 4 on mismatch.
- `batches-parity.js` (D-06 dashboard gate, runs BEFORE the flag moves, with writes frozen): fetches sheet-side `get_batch_dashboard_summary`, `get_batches` (all), `get_tasks_upcoming` (limit 200) and `get_tasks_calendar` and compares with the Postgres-side read functions using the same "now"; deep-diffs canonical JSON. The sheet-side JSON is saved as the pre-cutover snapshot OUTSIDE the repo (contains customer names; D-06). A mismatch means "do not flip", costing no rollback. The same script re-runs post-flip against the proxy. Run away from midnight (timezone, Q3).
- `batches-replay-to-sheet.js` (dry-run default, `--apply`, `--since=<iso>`): sends `mirror_batch_state` for batches with `last_updated >= since` and `mirror_batch_delete` for tombstones since then; ends with a cache flush; then verify. Any rollback runs this first (D-08).
- Daily drift check (D-08): production-only 24 h timer beside the mirror sweep, calling `export_batch_tabs` and diffing with `batch-compare.js`; Sentry tag `component:batches-drift`; ids and field names only (Q12). The xlsx verify remains the rehearsal and cutover tool.
- D-11 SQL-fix recipe: RUNBOOK section: dry-run SELECT, UPDATE inside a transaction, logged, with the mirror scheduled afterwards. No admin edit UI.

## 15. Cutover runbook outline (D-02, D-03, D-04, D-06, D-07, D-08, D-09)

Window: Sunday evening after close (D-02), 2-hour budget (D-03) with one rollback possible inside it. Per-step durations are targets to be measured in the staging rehearsal; if the rehearsal does not fit comfortably, the runbook says so before the date is set. Production date is set only after the Phase 86 flip is recorded (D-13, Q14).

Who: Claude runs the scripted steps and reports each check; owner makes the go/no-go call and does the live BrewPad/kiosk smoke (Google sign-in) (D-09).

Steps (RESEARCH Pattern 10):
1. T-7d: Apps Script v62 deployed (rollback v61) with editor-drift check; staging rehearsal complete; owner has removed the 4 orphan task rows; hygiene decisions recorded.
2. T-0: tell staff not to edit the four tabs; set `BATCHES_FREEZE="<HH:MM>"` (restart about 1 min); record start time and start listing invoices sold from now (for Scan invoices).
3. Download fresh workbook; `batches-backfill --dry-run` (0 rejects, counts printed), then `--promote`.
4. Download a second fresh workbook; `batches-verify` (0 mismatches, equal counts per table).
5. `batches-parity` (0 differences vs the pre-cutover snapshot); a no-go here costs nothing.
6. Flip: set `BATCHES_STORE=postgres` and unset `BATCHES_FREEZE` in one variable batch; check `/health` `database_required:true` and the mirror sweep boot log lines; apply `setupBatchMirrorNotices()`.
7. Smoke (owner): create batch (confirm mirrored sheet row), mark task, add reading, vessel transfer, open `batch.html` with an existing printed token, regenerate-token round trip on a test batch; post-flip parity run.
8. Staff run Scan invoices for the window's invoices (D-04).
9. Rollback inside the window: `BATCHES_STORE=sheets`, keep the freeze until verified; no replay needed if only smoke writes happened (delete the smoke batch first or replay it).
10. Day 1-7: daily drift check (D-08) and a manual runsheet; rollback stays supported for 7 days (D-07), always replay-first then flag; day 7 clean retires rollback, recorded in `87-CUTOVER-LOG.md`.

Strict no-go list (D-06): a non-empty rejects file; any per-table row-count mismatch; any dashboard number differing from the pre-cutover snapshot; any failed smoke write (create batch, mark task, add reading, vessel transfer). Any one forces rollback to the sheet.

Release train (Q10): production is pinned for Phase 86 work (`d2c66be9:main`); `0005` and inert 87 code ride `main`, and with both flags unset the sheets path is byte-identical.

## 16. Security notes (ASVS L1)

- V2/V6: 128-bit random token via `crypto.randomBytes`; `timingSafeEqual`; format pre-check; existing per-IP limiter; tokens plaintext by D-14 design.
- V4: explicit field whitelist on public routes (never `Object.assign(body)`); packaging completion staff-only; task-belongs-to-batch (Q8); disabled batch hidden on read; no list endpoint returns `access_token`; proxies keep `requireTiers`.
- V5: parameterised SQL only, fixed column allow-lists for dynamic SET (as `vessel-pg.js`), regex ID/token formats, numeric ranges, array caps (50/20), `sanitizeInput` (via `recipe-rules`) on stored text, JSON validity on snapshots.
- V7: reject files, logs and Sentry carry ids and field names only; the freeze error leaks nothing; the 502 collapse is preserved.
- Public response PII: parity strips email, reservation id, token; `customer_phone`, `notes`, `recipe_snapshot` still reach token holders (Q17).
- Freeze coverage: every write path including public routes (single-issuer static test).
- Staff OAuth direct Apps Script writes after cutover: rely on Phase 86 D-18 blanking `staff_emails`; confirm with a probe before the window.
- Backfill artifacts and the pre-cutover snapshot stay outside the repo.

## Owner Decisions

Owner approved all of Q1-Q20 as recommended on 2026-10-09. Every recommendation is what plans 87-02 onward implement.

| ID | Question | Recommendation | Owner choice |
|----|----------|----------------|--------------|
| Q1 | Orphan tasks BT-000567..570 (reference deleted batch SV-B-000108) will be rejected by the cascade FK | Owner deletes the four rows from the sheet before the rehearsal; keep rejecting orphans in code so the zero-rejects bar holds | Approved as recommended |
| Q2 | 68 duplicate (batch_id, step_number) task pairs across old completed batches SV-B-000002..027 | Import as-is; add no unique constraint; `get_batch` output for those batches must match | Approved as recommended |
| Q3 | Apps Script project timezone drives "today", due-this-week and month buckets | Owner confirms in Apps Script project settings; assumed America/Vancouver; run parity away from midnight | Approved as recommended |
| Q4 | `bin_id` JSON type | Emit a JSON number when the value is numeric (identical to the sheet), store as text | Approved as recommended |
| Q5 | Extra FKs | `schedule_id` references ferm_schedules, RESTRICT, nullable; no FK on `vessel_id` | Approved as recommended |
| Q6 | `target_volume_l` / `scale_factor` were never persisted (sheet header is `target_volume_L`, code wrote `target_volume_l`) | Persist going forward; mirror writes the existing `target_volume_L` header case-insensitively | Approved as recommended |
| Q7 | Location conflict strictness | Parity: pre-check under advisory lock with a non-unique partial index; no unique index (a unique index would newly block reactivating a completed batch into an occupied slot) | Approved as recommended |
| Q8 | Public task update never checks the task belongs to the token's batch | Add the check (only deliberate behaviour change on the public path; cannot affect the real page); regression test first | Approved as recommended |
| Q9 | Transfer-task completion whose location move hits a conflict silently drops the move today | Keep completing the task and return an additive `warnings` array so staff see the failure | Approved as recommended |
| Q10 | May 0005 and inert Phase 87 code reach production `main` before the window (Phase 86 prod steps are pinned to d2c66be9) | Yes: additive, unused until the flag; record the exact production SHA for the window in the runbook | Approved as recommended |
| Q11 | Manual-create replay window length (D-15 requires manual protection, so "invoice-only" is not offered) | Default 2 minutes on the fingerprint; same payload inside 2 minutes returns the existing batch with `idempotent_replay:true` | Approved as recommended |
| Q12 | Drift check mechanism | Production-only 24 h timer using `export_batch_tabs` plus Sentry; alternative is a manual daily CLI run for 7 days | Approved as recommended |
| Q13 | Probe-like rows: SV-B-000062 (test-looking, complete), blank-SKU SV-B-000167 and SV-B-000229 | Import as-is; `product_sku` allows empty; no rule requires non-empty | Approved as recommended |
| Q14 | Production window date | Set only after the Phase 86 production flip is recorded (D-13); staging rehearsal and docs proceed now | Approved as recommended |
| Q15 | Where `BATCHES_STORE` lives | Outside `STORE_ENV_NAMES` via `batch-flag.js` so the existing store-flag test stays untouched; alternative is an owner-approved two-line edit of `store-flag.test.js` | Approved as recommended |
| Q16 | Public GET for a missing batch | Keep `not_found` (parity) rather than unifying to `invalid_token` | Approved as recommended |
| Q17 | Public response still includes `customer_phone`, `notes`, `recipe_snapshot` | Keep (parity per D-14, no batch.html change); strip only if the owner decides separately | Approved as recommended |
| Q18 | Pre-existing reassign-customer bug: `new_version` is always null (reads `last_updated`, script returns `newVersion`) | Do not fix here; raise as a separate todo | Approved as recommended |
| Q19 | Pending batches with a vessel do not mark it In-Use and write no history | Keep that behaviour (parity) | Approved as recommended |
| Q20 | When to apply D-12 sheet notices | Apply `setupBatchMirrorNotices()` in the window right after the flip; `removeBatchMirrorNotices()` is the rollback step | Approved as recommended |

### Locked decisions coverage

| Decision | Met by (section) | Implemented in plan |
|----------|------------------|---------------------|
| D-01 design gate | Whole document; blocking checkpoint | 87-01 |
| D-02 Sunday evening window | Section 15 | runbook plans (rehearsal, cutover) |
| D-03 2-hour budget, measured | Section 15 | rehearsal plan |
| D-04 sales flow, log, Scan invoices | Sections 10, 15 | freeze plan, runbook |
| D-05 read-only freeze, server-side | Section 10 | freeze/flag plan |
| D-06 strict no-go bar | Sections 14, 15 | backfill, verify, parity plans |
| D-07 rollback for one week | Sections 14, 15 | replay plan, runbook |
| D-08 daily verify and replay-first rollback | Section 14 | drift and replay plans |
| D-09 owner plus Claude run | Section 15 | runbook |
| D-10 production mirror, staging never | Section 13 | mirror plan |
| D-11 reviewed SQL fix recipe | Section 14 | docs/RUNBOOK plan |
| D-12 notices and protected ranges | Section 13 | Apps Script v62 plan |
| D-13 wait for Phase 86 flip, one tx with vessels | Sections 7, 12, 15 | store/pg plans, runbook |
| D-14 public path identical, tokens retrievable | Section 8 | public route plan |
| D-15 server-side create idempotency | Section 11 | create plan |

Exact plan numbers for each row are confirmed against the 87-02..87-20 plan files when the owner approves.

## Approval notes

Owner approved all recommendations (Q1-Q20) on 2026-10-09 with no changes. No downstream plan (87-02 onward) needs revision.

Open owner action items:

- Q1: owner deletes orphan task rows BT-000567..570 from the sheet before the staging rehearsal.
- Q3: owner confirms the Apps Script project timezone (assumed America/Vancouver).
- Q14: the production window date is set only after the Phase 86 production flip is recorded.
- Q18: reassign-customer `new_version` null bug is tracked as a separate todo (`.planning/todos/pending/reassign-customer-new-version-null.md`).

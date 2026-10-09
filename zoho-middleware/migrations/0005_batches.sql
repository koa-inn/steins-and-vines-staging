-- 0005_batches.sql — Phase 87 (DB-06): batches, batch_tasks, plato_readings, vessel_history,
-- batch_tombstones, batch_create_dedup.
-- Additive only (D-04, Phase 83): nothing here drops, renames, or rewrites earlier objects.
-- Never edit this file once it has been applied to any environment — add a new migration instead.
--
-- The four ID sequences seed at 1 here; the real seed values (above the highest backfilled
-- SV-B-/BT-/PR-/VH- id) are set at backfill time via setval — AlterSeqStmt and bare SELECT are
-- rejected by the migration-allowlist guard, so seeding can never live here.
--
-- last_updated / created_at and similar app-written timestamps have NO default: they are written
-- from a JS Date (ms precision); batches.last_updated is the update_batch expectedVersion token.
-- Text columns are not null default '' (Sheets semantics); date/timestamp/numeric are NULL when blank.
-- Child tables reference batches with ON DELETE CASCADE (replaces the 3-sheet delete loop).
-- There is deliberately no step-number uniqueness (historical duplicate pairs) and
-- no unique location index. Regexes use [0-9], never backslashes (migration-allowlist guard).
-- Numeric columns are unconstrained (no precision/scale) so values are never rounded.

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

-- Down Migration
drop table batch_create_dedup;
drop table batch_tombstones;
drop table vessel_history;
drop table plato_readings;
drop table batch_tasks;
drop table batches;
drop sequence vessel_history_id_seq;
drop sequence plato_reading_id_seq;
drop sequence batch_task_id_seq;
drop sequence batch_id_seq;

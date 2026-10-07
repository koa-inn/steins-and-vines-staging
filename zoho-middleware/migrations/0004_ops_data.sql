-- 0004_ops_data.sql — Phase 86 (DB-05): vessels, ferm_schedules, config, staff_access, staff_access_audit.
-- Additive only (D-04, Phase 83): nothing here drops, renames, or rewrites earlier objects.
-- Never edit this file once it has been applied to any environment — add a new migration instead.
--
-- ferm_schedule_id_seq and vessel_position_seq seed at 1 here; the real seed values (above the
-- highest backfilled FS-NNNN and vessel position) are set at backfill time via setval — AlterSeqStmt
-- and bare SELECT are rejected by the migration-allowlist guard, so seeding can never live here.
--
-- The staff_access and staff_access_audit tables are never mirrored to the sheet (D-10).
-- config holds non-secret keys only (SC3): the CHECK rejects any key containing
-- token, secret, password or key, so server_token can never be a DB row.
--
-- vessels.archived is a separate boolean from status (D-07, archive only). The sheet has no
-- label column today; the owner adds a 'label' header to the Vessels tab before dual (decision 2026-10-07).
-- There are deliberately NO shelf/bin columns (D-17): location is a single free-text column.
-- updated_at on vessels/ferm_schedules has NO default: it is app-written at ms precision and is
-- the D-16 optimistic-concurrency token.
--
-- Numeric columns are unconstrained (no precision/scale) so values are never rounded.

-- Up Migration
create sequence ferm_schedule_id_seq start 1 minvalue 1;
create sequence vessel_position_seq start 1 minvalue 1;

create table vessels (
  vessel_id text primary key
    check (vessel_id ~ '^[A-Z]{2,6}-[0-9]{3,}$'),
  position bigint not null default nextval('vessel_position_seq'),
  label text,
  type text not null,
  material text,
  capacity_liters numeric,
  status text not null default 'Empty' check (status in ('Empty', 'In-Use')),
  archived boolean not null default false,
  bottom_diameter_cm numeric,
  top_diameter_cm numeric,
  depth_cm numeric,
  location text,
  brand text,
  notes text,
  created_at timestamptz,
  created_by text,
  updated_at timestamptz not null,
  updated_by text,
  unique (position)
);

create table ferm_schedules (
  schedule_id text primary key
    default ('FS-' || lpad(nextval('ferm_schedule_id_seq')::text, 4, '0'))
    check (schedule_id ~ '^FS-[0-9]{4,}$'),
  name text not null,
  description text,
  category text,
  steps jsonb not null check (jsonb_typeof(steps) = 'array'),
  is_active boolean not null default true,
  created_at timestamptz not null,
  created_by text,
  updated_at timestamptz not null,
  updated_by text
);

create table config (
  key text primary key
    check (key ~ '^[a-z0-9_]+$' and key !~ '(token|secret|password|key)'),
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create table staff_access (
  email text primary key
    check (email = lower(btrim(email)) and email ~ '^[^@ ]+@[^@ ]+[.][^@ ]+$'),
  role text not null check (role in ('owner', 'staff')),
  added_by text not null,
  added_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table staff_access_audit (
  id bigserial primary key,
  occurred_at timestamptz not null default now(),
  actor_email text not null,
  target_email text not null,
  action text not null check (action in ('add', 'remove', 'role_change', 'denied')),
  role_before text,
  role_after text,
  note text
);

create index staff_access_audit_time_idx on staff_access_audit (occurred_at desc);
create index ferm_schedules_active_idx on ferm_schedules (is_active);

-- Down Migration
drop table staff_access_audit;
drop table staff_access;
drop table config;
drop table ferm_schedules;
drop table vessels;
drop sequence vessel_position_seq;
drop sequence ferm_schedule_id_seq;

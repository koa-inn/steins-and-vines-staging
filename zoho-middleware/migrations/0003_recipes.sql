-- 0003_recipes.sql — Phase 85 (DB-04): recipes + recipe_ingredients schema.
-- Additive only (D-04, Phase 83): nothing here drops, renames, or rewrites 0001/0002 objects.
-- Never edit this file once it has been applied to any environment — add a new migration instead.
--
-- recipe_id_seq and recipe_ingredient_id_seq seed at 1 here; the real seed values (above the
-- highest backfilled SV-R-NNNNNN / RI-NNNNNN) are set at backfill time via setval — AlterSeqStmt
-- and bare SELECT are rejected by the migration-allowlist guard, so seeding can never live here.
--
-- schedule_id is a plain text column with NO foreign key: Phase 86 owns ferm_schedules.
--
-- There is deliberately NO uniqueness on the (recipe_id, item_id) pair: production recipe SV-R-000002 carries
-- three rows of the same item. ingredient_id is the sole ingredient key; position preserves
-- sheet-row order (ingredient ids are not monotonic in sheet order).
--
-- Numeric columns are unconstrained (no precision/scale): quantities carry up to 4 dp
-- (e.g. 0.0055) and must never be rounded.

-- Up Migration
create sequence recipe_id_seq start 1 minvalue 1;
create sequence recipe_ingredient_id_seq start 1 minvalue 1;

create table recipes (
  recipe_id text primary key
    default ('SV-R-' || lpad(nextval('recipe_id_seq')::text, 6, '0'))
    check (recipe_id ~ '^SV-R-[0-9]{6,}$'),
  name text not null,
  style text,
  description text,
  status text not null check (status in ('draft', 'active', 'inactive')),
  locked_price numeric,
  service_fee numeric,
  materials_fee numeric,
  batch_size_l numeric,
  abv numeric,
  ibu numeric,
  colour_srm numeric,
  notes text,
  created_at timestamptz not null,
  created_by text,
  updated_at timestamptz not null,
  pricing_mode text not null default 'locked' check (pricing_mode in ('locked', 'dynamic')),
  schedule_id text
);

create table recipe_ingredients (
  ingredient_id text primary key
    default ('RI-' || lpad(nextval('recipe_ingredient_id_seq')::text, 6, '0'))
    check (ingredient_id ~ '^RI-[0-9]{6,}$'),
  recipe_id text not null references recipes (recipe_id) on delete cascade,
  position integer not null,
  item_id text not null,
  item_name text,
  quantity numeric not null default 0,
  unit text,
  unique (recipe_id, position)
);

create index recipe_ingredients_recipe_idx on recipe_ingredients (recipe_id, position);
create index recipes_status_created_idx on recipes (status, created_at desc);

-- Down Migration
drop table recipe_ingredients;
drop table recipes;
drop sequence recipe_ingredient_id_seq;
drop sequence recipe_id_seq;

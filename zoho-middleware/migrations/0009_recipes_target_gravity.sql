-- 0009_recipes_target_gravity.sql — Phase 97 D-06: optional target_og / target_fg on recipes.
-- Additive only (83 D-04). Plain nullable numeric, NO CHECK constraint (the deploy allowlist forbids
-- DROP CONSTRAINT, precedent 0006): the 2..40 range and fg < og rule live in lib/recipe-rules.js.
-- No data step (D-06): no backfill without a dry run and owner OK.
-- Never edit this file once applied — add a new migration instead.

-- Up Migration
alter table recipes add column target_og numeric;
alter table recipes add column target_fg numeric;
comment on column recipes.target_og is 'Optional recipe target original gravity, degrees Plato 2..40; app-level check in lib/recipe-rules.js';
comment on column recipes.target_fg is 'Optional recipe target final gravity, degrees Plato 2..40; app-level check in lib/recipe-rules.js';

-- Down Migration
alter table recipes drop column target_fg;
alter table recipes drop column target_og;

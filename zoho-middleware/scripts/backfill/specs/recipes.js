/**
 * Recipes + RecipeIngredients sheet -> recipes / recipe_ingredients column specs.
 * Phase 85 Plan 10 (DB-04).
 *
 * Deliberately NOT registered in specs/index.js (Phase 84 Pitfall 3): this is a two-table job
 * (the ingredient `position` is derived from sheet row order, and every ingredient must
 * reference a backfilled recipe), so the only route in is the dedicated
 * `recipes-backfill.js` CLI, which reuses these specs for header checks and normalizeRow.
 *
 * Headers are mapped by NAME (never by column order): on the live sheet pricing_mode and
 * schedule_id were appended last. Numeric columns carry no fixed scale in Postgres
 * (quantities hold up to 4 dp, e.g. 0.0055); scale 6 here only bounds what the normaliser
 * will accept without rounding - anything finer is rejected, never rounded (D-12).
 * `position` is not a sheet column - the planner derives it.
 */
'use strict';

function num(name, required) {
  return { name: name, header: name, type: 'numeric', required: !!required, pgType: 'numeric', scale: 6 };
}

function txt(name, required) {
  return { name: name, header: name, type: 'text', required: !!required, pgType: 'text' };
}

function ts(name, required) {
  return { name: name, header: name, type: 'timestamptz', required: !!required, pgType: 'timestamptz' };
}

module.exports = {
  recipes: {
    sheet: 'Recipes',
    table: 'recipes',
    primaryKey: 'recipe_id',
    columns: [
      { name: 'recipe_id', header: 'recipe_id', type: 'id', required: true, pgType: 'text', prefix: 'SV-R', pad: 6 },
      txt('name', true),
      txt('style', false),
      txt('description', false),
      txt('status', true),
      num('locked_price', false),
      num('service_fee', false),
      num('materials_fee', false),
      num('batch_size_l', false),
      num('abv', false),
      num('ibu', false),
      num('colour_srm', false),
      txt('notes', false),
      ts('created_at', true),
      txt('created_by', false),
      ts('updated_at', true),
      txt('pricing_mode', true),
      txt('schedule_id', false)
    ]
  },
  ingredients: {
    sheet: 'RecipeIngredients',
    table: 'recipe_ingredients',
    primaryKey: 'ingredient_id',
    columns: [
      { name: 'ingredient_id', header: 'ingredient_id', type: 'id', required: true, pgType: 'text', prefix: 'RI', pad: 6 },
      { name: 'recipe_id', header: 'recipe_id', type: 'id', required: true, pgType: 'text', prefix: 'SV-R', pad: 6 },
      txt('item_id', true),
      txt('item_name', false),
      num('quantity', true),
      txt('unit', false)
    ]
  }
};

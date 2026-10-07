'use strict';

/**
 * Pins the recipes backfill specs to the REAL row-1 headers of the live Recipes and
 * RecipeIngredients tabs (Phase 85 Plan 10). Mirrors spec-headers.test.js, kept in a separate
 * file so that suite stays unmodified. If the sheet changes, update BOTH this list and the spec.
 */

var recipeSpecs = require('../../scripts/backfill/specs/recipes');
var specIndex = require('../../scripts/backfill/specs');
var backfillCli = require('../../scripts/backfill/backfill');

var REAL_RECIPES_HEADERS = [
  'recipe_id', 'name', 'style', 'description', 'status', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at',
  'created_by', 'updated_at', 'pricing_mode', 'schedule_id'
];

var REAL_INGREDIENT_HEADERS = ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'];

function headersOf(spec) {
  return spec.columns.map(function (c) { return c.header; });
}

describe('recipes backfill specs match the real sheet row 1', function () {
  test('Recipes spec has the 18 real headers', function () {
    expect(headersOf(recipeSpecs.recipes)).toEqual(REAL_RECIPES_HEADERS);
    expect(recipeSpecs.recipes.sheet).toBe('Recipes');
    expect(recipeSpecs.recipes.table).toBe('recipes');
  });

  test('RecipeIngredients spec has the 6 real headers', function () {
    expect(headersOf(recipeSpecs.ingredients)).toEqual(REAL_INGREDIENT_HEADERS);
    expect(recipeSpecs.ingredients.sheet).toBe('RecipeIngredients');
    expect(recipeSpecs.ingredients.table).toBe('recipe_ingredients');
  });

  test('a sheet with pricing_mode/schedule_id appended last (different order) still maps by name', function () {
    var shuffled = REAL_RECIPES_HEADERS.slice().reverse();
    var check = backfillCli.checkHeaders(recipeSpecs.recipes, shuffled);
    expect(check.missing).toEqual([]);
    expect(check.unmapped).toEqual([]);
  });

  test('the specs are NOT registered in specs/index.js (two-table job, Phase 84 Pitfall 3)', function () {
    var names = specIndex.listSpecs();
    expect(names).not.toContain('Recipes');
    expect(names).not.toContain('RecipeIngredients');
    expect(function () { specIndex.getSpec('Recipes'); }).toThrow();
  });
});

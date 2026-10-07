'use strict';

/**
 * Pure planner tests for buildRecipesBackfillPlan - Phase 85 Plan 10 Task 1 (DB-04).
 * Synthetic data only. Fixtures use readSheet()-shaped rows ({rowNumber, values}).
 */

var recipesBackfill = require('../../scripts/backfill/recipes-backfill');
var buildPlan = recipesBackfill.buildRecipesBackfillPlan;
var recipeSpecs = require('../../scripts/backfill/specs/recipes');

var TZ = 'America/Vancouver';
var RECIPE_HEADERS = recipeSpecs.recipes.columns.map(function (c) { return c.header; });
var INGREDIENT_HEADERS = recipeSpecs.ingredients.columns.map(function (c) { return c.header; });

function recipeRow(rowNumber, overrides) {
  var base = {
    recipe_id: 'SV-R-000001',
    name: 'Test Pale',
    style: 'Pale Ale',
    description: '',
    status: 'active',
    locked_price: 100,
    service_fee: '',
    materials_fee: '',
    batch_size_l: 23,
    abv: 5.2,
    ibu: 30,
    colour_srm: 8,
    notes: '',
    created_at: '2026-01-15T08:00:00Z',
    created_by: 'staff-one@example.test',
    updated_at: '2026-01-16T08:00:00Z',
    pricing_mode: 'locked',
    schedule_id: ''
  };
  Object.assign(base, overrides || {});
  return { rowNumber: rowNumber, values: base };
}

function ingRow(rowNumber, overrides) {
  var base = {
    ingredient_id: 'RI-000001',
    recipe_id: 'SV-R-000001',
    item_id: 'ITEM-A',
    item_name: 'Pale Malt',
    quantity: 5,
    unit: 'kg'
  };
  Object.assign(base, overrides || {});
  return { rowNumber: rowNumber, values: base };
}

function plan(recipeRows, ingredientRows, extra) {
  return buildPlan(Object.assign({
    recipeRows: recipeRows,
    ingredientRows: ingredientRows,
    recipeHeaders: RECIPE_HEADERS,
    ingredientHeaders: INGREDIENT_HEADERS,
    timezone: TZ
  }, extra || {}));
}

function rejectFor(result, id, field) {
  return result.rejects.filter(function (r) { return r.id === id && r.field === field; });
}

describe('buildRecipesBackfillPlan', function () {
  test('clean fixture: ids unchanged, counts, no rejects', function () {
    var result = plan(
      [recipeRow(2), recipeRow(3, { recipe_id: 'SV-R-000002', name: 'Stout' })],
      [ingRow(2), ingRow(3, { ingredient_id: 'RI-000002', recipe_id: 'SV-R-000002' })]
    );
    expect(result.rejects).toEqual([]);
    expect(result.recipes.map(function (r) { return r.recipe_id; })).toEqual(['SV-R-000001', 'SV-R-000002']);
    expect(result.ingredients.map(function (r) { return r.ingredient_id; })).toEqual(['RI-000001', 'RI-000002']);
    expect(result.counts.recipes).toBe(2);
    expect(result.counts.ingredients).toBe(2);
    expect(result.counts.perRecipe).toEqual({ 'SV-R-000001': 1, 'SV-R-000002': 1 });
    expect(Object.keys(result.recipes[0]).length).toBe(18);
  });

  test('header order differing from canonical is irrelevant (mapped by name)', function () {
    var reversed = RECIPE_HEADERS.slice().reverse();
    var result = plan([recipeRow(2)], [ingRow(2)], { recipeHeaders: reversed });
    expect(result.rejects).toEqual([]);
    expect(result.recipes[0].pricing_mode).toBe('locked');
  });

  test('three ingredient rows of one item_id are all kept with positions 1,2,3 in sheet order', function () {
    var result = plan(
      [recipeRow(2, { recipe_id: 'SV-R-000002' })],
      [
        ingRow(2, { ingredient_id: 'RI-000010', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 1 }),
        ingRow(3, { ingredient_id: 'RI-000011', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 2 }),
        ingRow(4, { ingredient_id: 'RI-000012', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 3 })
      ]
    );
    expect(result.rejects).toEqual([]);
    expect(result.ingredients.map(function (i) { return [i.ingredient_id, i.position, i.item_id, i.quantity]; })).toEqual([
      ['RI-000010', 1, 'SAME', '1'],
      ['RI-000011', 2, 'SAME', '2'],
      ['RI-000012', 3, 'SAME', '3']
    ]);
  });

  test('positions follow sheet row order even when ingredient ids are not monotonic', function () {
    var result = plan(
      [recipeRow(2), recipeRow(3, { recipe_id: 'SV-R-000002' })],
      [
        ingRow(2, { ingredient_id: 'RI-000150', recipe_id: 'SV-R-000001' }),
        ingRow(3, { ingredient_id: 'RI-000200', recipe_id: 'SV-R-000002' }),
        ingRow(4, { ingredient_id: 'RI-000033', recipe_id: 'SV-R-000001', item_id: 'ITEM-B' })
      ]
    );
    var byId = {};
    result.ingredients.forEach(function (i) { byId[i.ingredient_id] = i; });
    expect(byId['RI-000150'].position).toBe(1);
    expect(byId['RI-000033'].position).toBe(2);
    expect(byId['RI-000200'].position).toBe(1);
  });

  test('swapped created_at/created_by (SV-R-000001 defect) is rejected, not coerced or swapped', function () {
    var result = plan(
      [recipeRow(2, { created_at: 'middleware', created_by: '2026-01-15T08:00:00Z' })],
      []
    );
    expect(result.recipes).toEqual([]);
    expect(result.rejects).toContainEqual({
      sheet: 'Recipes', row: 2, id: 'SV-R-000001', field: 'created_at', reason: 'invalid_timestamp'
    });
  });

  test('status, pricing_mode, numeric, id and duplicate rejects each name id + field', function () {
    var result = plan(
      [
        recipeRow(2, { recipe_id: 'SV-R-000001', status: '' }),
        recipeRow(3, { recipe_id: 'SV-R-000002', status: 'archived' }),
        recipeRow(4, { recipe_id: 'SV-R-000003', pricing_mode: '' }),
        recipeRow(5, { recipe_id: 'SV-R-000004', pricing_mode: 'other' }),
        recipeRow(6, { recipe_id: 'SV-R-000005', abv: 'abc' }),
        recipeRow(7, { recipe_id: 'SV-R-000006' }),
        recipeRow(8, { recipe_id: 'SV-R-000006' }),
        recipeRow(9, { recipe_id: 'SV-R-12' })
      ],
      []
    );
    expect(rejectFor(result, 'SV-R-000001', 'status').length).toBe(1);
    expect(rejectFor(result, 'SV-R-000002', 'status')[0].reason).toBe('invalid_status');
    expect(rejectFor(result, 'SV-R-000003', 'pricing_mode').length).toBe(1);
    expect(rejectFor(result, 'SV-R-000004', 'pricing_mode')[0].reason).toBe('invalid_pricing_mode');
    expect(rejectFor(result, 'SV-R-000005', 'abv')[0].reason).toBe('invalid_number');
    expect(rejectFor(result, 'SV-R-000006', 'recipe_id')).toEqual([
      { sheet: 'Recipes', row: 8, id: 'SV-R-000006', field: 'recipe_id', reason: 'duplicate_id' }
    ]);
    expect(rejectFor(result, 'SV-R-12', 'recipe_id')[0].reason).toBe('invalid_id');
    expect(result.recipes.map(function (r) { return r.recipe_id; })).toEqual(['SV-R-000006']);
  });

  test('ingredient rejects: duplicate id, orphan recipe, bad quantity, bad id', function () {
    var result = plan(
      [recipeRow(2)],
      [
        ingRow(2, { ingredient_id: 'RI-000001' }),
        ingRow(3, { ingredient_id: 'RI-000001' }),
        ingRow(4, { ingredient_id: 'RI-000002', recipe_id: 'SV-R-000099' }),
        ingRow(5, { ingredient_id: 'RI-000003', quantity: 'lots' }),
        ingRow(6, { ingredient_id: 'RI-3' })
      ]
    );
    expect(rejectFor(result, 'RI-000001', 'ingredient_id')).toEqual([
      { sheet: 'RecipeIngredients', row: 3, id: 'RI-000001', field: 'ingredient_id', reason: 'duplicate_id' }
    ]);
    expect(rejectFor(result, 'RI-000002', 'recipe_id')[0].reason).toBe('orphan_recipe');
    expect(rejectFor(result, 'RI-000003', 'quantity')[0].reason).toBe('invalid_number');
    expect(rejectFor(result, 'RI-3', 'ingredient_id')[0].reason).toBe('invalid_id');
    expect(result.ingredients.length).toBe(1);
  });

  test('a missing header is rejected', function () {
    var headers = RECIPE_HEADERS.filter(function (h) { return h !== 'pricing_mode'; });
    var result = plan([recipeRow(2)], [], { recipeHeaders: headers });
    expect(result.rejects).toContainEqual({
      sheet: 'Recipes', row: null, id: null, field: 'pricing_mode', reason: 'missing_header'
    });
    expect(result.recipes).toEqual([]);
  });

  test('empty optional cells become NULL, not rejects', function () {
    var result = plan(
      [recipeRow(2, { notes: '', schedule_id: '', locked_price: '', style: null })],
      [ingRow(2, { item_name: '', unit: '' })]
    );
    expect(result.rejects).toEqual([]);
    expect(result.recipes[0].notes).toBeNull();
    expect(result.recipes[0].schedule_id).toBeNull();
    expect(result.recipes[0].locked_price).toBeNull();
    expect(result.recipes[0].style).toBeNull();
    expect(result.ingredients[0].item_name).toBeNull();
    expect(result.ingredients[0].unit).toBeNull();
  });

  test('4 dp quantities survive unrounded and trailing zeros are trimmed', function () {
    var result = plan([recipeRow(2, { locked_price: 100 })], [ingRow(2, { quantity: 0.0055 })]);
    expect(result.rejects).toEqual([]);
    expect(result.ingredients[0].quantity).toBe('0.0055');
    expect(result.recipes[0].locked_price).toBe('100');
  });

  test('sequence seeds are the max numeric suffix (gaps allowed)', function () {
    var ids = [1, 2, 3, 4, 6, 7];
    var recipes = ids.map(function (n, i) {
      return recipeRow(i + 2, { recipe_id: 'SV-R-00000' + n });
    });
    var ings = ids.map(function (n, i) {
      return ingRow(i + 2, { ingredient_id: 'RI-00000' + n, recipe_id: 'SV-R-00000' + n });
    });
    var result = plan(recipes, ings);
    expect(result.rejects).toEqual([]);
    expect(result.recipeSeqSeed).toBe(7);
    expect(result.ingredientSeqSeed).toBe(7);
  });

  test('empty sheets give zero seeds', function () {
    var result = plan([], []);
    expect(result.recipeSeqSeed).toBe(0);
    expect(result.ingredientSeqSeed).toBe(0);
  });

  test('serialised rejects never contain created_by or raw cell values', function () {
    var result = plan(
      [
        recipeRow(2, { created_at: 'middleware', created_by: 'owner-secret@example.test' }),
        recipeRow(3, { recipe_id: 'SV-R-000002', status: 'weird-status-value', abv: 'not-a-number-xyz' })
      ],
      [ingRow(2, { recipe_id: 'SV-R-000002', quantity: 'qty-junk-value' })]
    );
    var text = JSON.stringify(result.rejects);
    expect(result.rejects.length).toBeGreaterThan(0);
    expect(text).not.toContain('owner-secret@example.test');
    expect(text).not.toContain('middleware');
    expect(text).not.toContain('weird-status-value');
    expect(text).not.toContain('not-a-number-xyz');
    expect(text).not.toContain('qty-junk-value');
  });
});

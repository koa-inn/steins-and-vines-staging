'use strict';

// Regression (Phase 101 staging gate, 2026-11-11): the kiosk sends
// modified_ingredients: null for an unmodified recipe entry, and the server
// rejected it with 400, so every cart-quote failed and recipe carts showed $0.
var lines = require('../lib/recipe-sale-lines');

describe('validateRecipeEntries — modified_ingredients null', function () {
  test('null is accepted and treated as unmodified', function () {
    var result = lines.validateRecipeEntries([
      { recipe_id: 'SV-R-000016', sale_type: 'in-store', mill_grain: false, target_volume_l: 28, modified_ingredients: null }
    ]);
    expect(result.ok).toBe(true);
    expect(result.entries[0].modified_ingredients).toBeUndefined();
  });

  test('a non-array, non-null value is still rejected', function () {
    var result = lines.validateRecipeEntries([
      { recipe_id: 'R', sale_type: 'in-store', modified_ingredients: 'x' }
    ]);
    expect(result.status).toBe(400);
  });

  test('an array is passed through unchanged', function () {
    var mods = [{ item_id: 'I1', quantity: 2 }];
    var result = lines.validateRecipeEntries([
      { recipe_id: 'R', sale_type: 'take-out', modified_ingredients: mods }
    ]);
    expect(result.ok).toBe(true);
    expect(result.entries[0].modified_ingredients).toBe(mods);
  });
});

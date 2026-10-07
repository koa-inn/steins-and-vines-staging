'use strict';

/**
 * Runtime parity: the REAL adminApi.gs updateRecipe (run under a fake Sheets runtime) vs
 * lib/recipe-rules.js planIngredientIds / recipeIngredientsUnchanged — Phase 85 Plan 01
 * (DB-04, ROADMAP SC3, Phase 79 D-04 + D-09).
 *
 * For each scripted save sequence the same seeded RecipeIngredients state is used. We assert:
 *  - the .gs skips the ingredient rewrite  <=>  recipeIngredientsUnchanged(...) === true
 *  - the honoured/minted classification of every resulting row (and row order) is identical.
 * Minted id VALUES intentionally differ (sheet max+1 vs Postgres sequence) and are not compared.
 *
 * Stubbed platform globals (the only ones updateRecipe touches): SpreadsheetApp
 * (getActiveSpreadsheet/getSheetByName) and LockService (getScriptLock -> waitLock/releaseLock).
 * Everything else (findRowById, sanitizeInput, invalidateSheetCache, maxIdNumFromColumn,
 * formatPaddedId, ensureRecipes*Column ...) is the real code from adminApi.gs, which is
 * evaluated unmodified. The fake sheet records every write call.
 */

var fs = require('fs');
var path = require('path');
var rules = require('../lib/recipe-rules');

var GS_SRC = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8'); // adminApi.gs

var RECIPE_HEADERS = ['recipe_id', 'name', 'style', 'description', 'status', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at', 'created_by',
  'updated_at', 'pricing_mode', 'schedule_id'];
var ING_HEADERS = ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'];

function makeFakeSheet(name, headers, rows) {
  var data = [headers.slice()].concat(rows.map(function (r) { return r.slice(); }));
  var writes = [];

  function pad(r) {
    while (data[r - 1] === undefined) data.push([]);
    return data[r - 1];
  }

  function range(r, c, nr, nc) {
    nr = nr || 1;
    nc = nc || 1;
    return {
      getValues: function () {
        var out = [];
        for (var i = 0; i < nr; i++) {
          var row = [];
          for (var j = 0; j < nc; j++) {
            var v = (data[r - 1 + i] || [])[c - 1 + j];
            row.push(v === undefined ? '' : v);
          }
          out.push(row);
        }
        return out;
      },
      getFormulas: function () {
        var out = [];
        for (var i = 0; i < nr; i++) {
          var row = [];
          for (var j = 0; j < nc; j++) row.push('');
          out.push(row);
        }
        return out;
      },
      setValues: function (vals) {
        writes.push('setValues');
        for (var i = 0; i < vals.length; i++) {
          var row = pad(r + i);
          for (var j = 0; j < vals[i].length; j++) row[c - 1 + j] = vals[i][j];
        }
        return this;
      },
      setValue: function (v) {
        writes.push('setValue');
        pad(r)[c - 1] = v;
        return this;
      },
      setFontWeight: function () { return this; }
    };
  }

  return {
    name: name,
    writes: writes,
    data: data,
    getLastRow: function () { return data.length; },
    getLastColumn: function () { return data[0].length; },
    getMaxRows: function () { return data.length + 1000; },
    insertRowsAfter: function () { writes.push('insertRowsAfter'); },
    getRange: range,
    getDataRange: function () {
      return {
        getValues: function () {
          return data.map(function (r) {
            var copy = r.slice();
            while (copy.length < data[0].length) copy.push('');
            return copy;
          });
        }
      };
    },
    deleteRows: function (start, count) {
      writes.push('deleteRows');
      data.splice(start - 1, count);
    },
    appendRow: function (row) {
      writes.push('appendRow');
      data.push(row);
    }
  };
}

function seedRecipeRow(id) {
  var row = RECIPE_HEADERS.map(function () { return ''; });
  row[0] = id;
  row[1] = 'Recipe ' + id;
  row[4] = 'active';
  row[16] = 'locked';
  return row;
}

// SV-R-000002: three rows of the SAME item (real-data shape); SV-R-000003: a second recipe.
function seedIngredientRows() {
  return [
    ['RI-000001', 'SV-R-000002', 'ITEM-A', 'Malt', 1, 'kg'],
    ['RI-000002', 'SV-R-000002', 'ITEM-A', 'Malt', 2, 'kg'],
    ['RI-000003', 'SV-R-000002', 'ITEM-A', 'Malt', 3, 'kg'],
    ['RI-000004', 'SV-R-000003', 'ITEM-B', 'Hops', 5, 'g'],
    ['RI-000005', 'SV-R-000003', 'ITEM-C', 'Yeast', 1, 'pcs']
  ];
}

var TARGET = 'SV-R-000002';
var STORED_IDS = ['RI-000001', 'RI-000002', 'RI-000003'];

function ing(id, itemId, name, qty, unit) {
  return { ingredient_id: id, item_id: itemId, item_name: name, quantity: qty, unit: unit };
}

function runRealUpdateRecipe(ingredients) {
  var recipesSheet = makeFakeSheet('Recipes', RECIPE_HEADERS, [seedRecipeRow(TARGET), seedRecipeRow('SV-R-000003')]);
  var ingSheet = makeFakeSheet('RecipeIngredients', ING_HEADERS, seedIngredientRows());
  var sheets = { Recipes: recipesSheet, RecipeIngredients: ingSheet };

  var SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return { getSheetByName: function (n) { return sheets[n] || null; } };
    }
  };
  var LockService = {
    getScriptLock: function () {
      return { waitLock: function () {}, releaseLock: function () {} };
    }
  };

  var updateRecipe = new Function(
    'SpreadsheetApp', 'LockService',
    GS_SRC + '\nreturn updateRecipe;'
  )(SpreadsheetApp, LockService);

  var result = updateRecipe({ recipe_id: TARGET, ingredients: ingredients }, 'middleware');
  expect(result.ok).toBe(true);

  var rows = ingSheet.data.slice(1).filter(function (r) { return r[1] === TARGET; });
  var classification = rows.map(function (r) {
    return STORED_IDS.indexOf(r[0]) !== -1 ? r[0] : 'minted';
  });
  return {
    written: ingSheet.writes.length > 0,
    classification: classification,
    result: result,
    otherRecipeRows: ingSheet.data.slice(1).filter(function (r) { return r[1] === 'SV-R-000003'; }).length
  };
}

function runPort(ingredients) {
  var incoming = ingredients.map(function (r) {
    return {
      ingredient_id: r.ingredient_id,
      item_id: rules.sanitizeInput(r.item_id || ''),
      item_name: rules.sanitizeInput(r.item_name || ''),
      quantity: r.quantity !== undefined ? Number(r.quantity) : 0,
      unit: rules.sanitizeInput(r.unit || '')
    };
  });
  var incomingKeys = incoming.map(function (r) {
    return rules.normalizeRecipeIngredientTuple(r.item_id, r.quantity, r.unit);
  });
  var storedKeys = seedIngredientRows()
    .filter(function (r) { return r[1] === TARGET; })
    .map(function (r) { return rules.normalizeRecipeIngredientTuple(r[2], r[4], r[5]); });

  var unchanged = rules.recipeIngredientsUnchanged(incomingKeys, storedKeys);
  var plan = rules.planIngredientIds(incoming, STORED_IDS);
  return {
    unchanged: unchanged,
    classification: plan.map(function (p) { return p.ingredient_id === null ? 'minted' : p.ingredient_id; })
  };
}

describe('updateRecipe (real adminApi.gs) vs recipe-rules runtime parity', function () {
  it('a) re-saving identical ingredients performs no ingredient write (D-04)', function () {
    var payload = [
      ing('RI-000001', 'ITEM-A', 'Malt', 1, 'kg'),
      ing('RI-000002', 'ITEM-A', 'Malt', 2, 'kg'),
      ing('RI-000003', 'ITEM-A', 'Malt', 3, 'kg')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(false);
    expect(port.unchanged).toBe(true);
    expect(gs.result.ingredients_unchanged).toBe(true);
  });

  it('b) quantity change on row 2 rewrites; honoured/minted vector matches', function () {
    var payload = [
      ing('RI-000001', 'ITEM-A', 'Malt', 1, 'kg'),
      ing('RI-000002', 'ITEM-A', 'Malt', 9, 'kg'),
      ing('RI-000003', 'ITEM-A', 'Malt', 3, 'kg'),
      ing(undefined, 'ITEM-D', 'Extra', 1, 'g')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(true);
    expect(port.unchanged).toBe(false);
    expect(gs.classification).toEqual(['RI-000001', 'RI-000002', 'RI-000003', 'minted']);
    expect(port.classification).toEqual(gs.classification);
    expect(gs.otherRecipeRows).toBe(2);
  });

  it('c) a foreign recipe ingredient_id is never honoured', function () {
    var payload = [
      ing('RI-000001', 'ITEM-A', 'Malt', 1, 'kg'),
      ing('RI-000004', 'ITEM-A', 'Malt', 2, 'kg'),
      ing('RI-000003', 'ITEM-A', 'Malt', 4, 'kg')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(true);
    expect(gs.classification).toEqual(['RI-000001', 'minted', 'RI-000003']);
    expect(port.classification).toEqual(gs.classification);
  });

  it('d) one own id repeated twice: first honoured, second minted', function () {
    var payload = [
      ing('RI-000001', 'ITEM-A', 'Malt', 1, 'kg'),
      ing('RI-000001', 'ITEM-A', 'Malt', 2, 'kg'),
      ing('RI-000003', 'ITEM-A', 'Malt', 5, 'kg')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(true);
    expect(gs.classification).toEqual(['RI-000001', 'minted', 'RI-000003']);
    expect(port.classification).toEqual(gs.classification);
  });

  it('e) reversed row order is treated as changed', function () {
    var payload = [
      ing('RI-000003', 'ITEM-A', 'Malt', 3, 'kg'),
      ing('RI-000002', 'ITEM-A', 'Malt', 2, 'kg'),
      ing('RI-000001', 'ITEM-A', 'Malt', 1, 'kg')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(true);
    expect(port.unchanged).toBe(false);
    expect(gs.classification).toEqual(['RI-000003', 'RI-000002', 'RI-000001']);
    expect(port.classification).toEqual(gs.classification);
  });

  it('f) item_name-only change skips the rewrite (documented D-04 consequence)', function () {
    var payload = [
      ing('RI-000001', 'ITEM-A', 'Renamed malt', 1, 'kg'),
      ing('RI-000002', 'ITEM-A', 'Renamed malt', 2, 'kg'),
      ing('RI-000003', 'ITEM-A', 'Renamed malt', 3, 'kg')
    ];
    var gs = runRealUpdateRecipe(payload);
    var port = runPort(payload);
    expect(gs.written).toBe(false);
    expect(port.unchanged).toBe(true);
  });
});

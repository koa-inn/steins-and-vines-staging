'use strict';

// Phase 97 Plan 01 (D-06): the prod-only Apps Script mirror carries target_og / target_fg,
// adding the header columns lazily (only when a mirrored recipe has a value).

var fs = require('fs');
var path = require('path');

var GS_SRC = fs.readFileSync(path.join(__dirname, '../../apps-script/adminApi.gs'), 'utf8');

var HEADERS19 = ['recipe_id', 'name', 'style', 'description', 'status', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at', 'created_by',
  'updated_at', 'pricing_mode', 'schedule_id', 'beer_category'];
var ING_HEADERS = ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'];

function makeFakeSheet(headers) {
  var data = [headers.slice()];
  var log = { bold: [] };

  function pad(r) {
    while (data[r - 1] === undefined) data.push([]);
    return data[r - 1];
  }

  function range(r, c, nr, nc) {
    nr = nr || 1;
    nc = nc || 1;
    var rng = {
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
      setValues: function (vals) {
        for (var i = 0; i < vals.length; i++) {
          var row = pad(r + i);
          for (var j = 0; j < vals[i].length; j++) row[c - 1 + j] = vals[i][j];
        }
        return rng;
      },
      setValue: function (v) { pad(r)[c - 1] = v; return rng; },
      setFontWeight: function (w) { log.bold.push({ row: r, col: c, weight: w }); return rng; }
    };
    return rng;
  }

  return {
    data: data,
    log: log,
    getLastRow: function () { return data.length; },
    getLastColumn: function () {
      return data.reduce(function (m, row) { return Math.max(m, row.length); }, 0);
    },
    getMaxRows: function () { return data.length + 1000; },
    getRange: range,
    getDataRange: function () {
      var w = data.reduce(function (m, row) { return Math.max(m, row.length); }, 0);
      return {
        getValues: function () {
          return data.map(function (r) {
            var copy = r.slice();
            while (copy.length < w) copy.push('');
            return copy;
          });
        }
      };
    },
    appendRow: function (row) { data.push(row.slice()); },
    deleteRows: function (start, count) { data.splice(start - 1, count); }
  };
}

function setup(headers) {
  var sheets = { Recipes: makeFakeSheet(headers), RecipeIngredients: makeFakeSheet(ING_HEADERS) };
  var SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return { getSheetByName: function (n) { return sheets[n] || null; } };
    }
  };
  var LockService = {
    getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
  };
  var Logger = { log: function () {} };
  var api = new Function(
    'SpreadsheetApp', 'LockService', 'Logger',
    GS_SRC + '\nreturn {' +
      'mirrorRecipeState: mirrorRecipeState,' +
      'ensureRecipesTargetGravityColumns: (typeof ensureRecipesTargetGravityColumns !== "undefined" ? ensureRecipesTargetGravityColumns : undefined)' +
    '};'
  )(SpreadsheetApp, LockService, Logger);
  return { api: api, recipes: sheets.Recipes };
}

function recipe(extra) {
  var r = { recipe_id: 'SV-R-000010', name: 'N', status: 'active' };
  Object.keys(extra || {}).forEach(function (k) { r[k] = extra[k]; });
  return r;
}

function cell(sheet, rowIdx, header) {
  return sheet.data[rowIdx][sheet.data[0].indexOf(header)];
}

describe('ensureRecipesTargetGravityColumns', function () {
  test('appends target_og then target_fg bold and returns indexes; second call is a no-op', function () {
    var t = setup(HEADERS19);
    var idx = t.api.ensureRecipesTargetGravityColumns(t.recipes);
    expect(idx).toEqual({ og: 19, fg: 20 });
    expect(t.recipes.data[0].slice(-2)).toEqual(['target_og', 'target_fg']);
    expect(t.recipes.log.bold).toEqual([
      { row: 1, col: 20, weight: 'bold' },
      { row: 1, col: 21, weight: 'bold' }
    ]);
    var again = t.api.ensureRecipesTargetGravityColumns(t.recipes);
    expect(again).toEqual({ og: 19, fg: 20 });
    expect(t.recipes.data[0].length).toBe(21);
    expect(t.recipes.log.bold.length).toBe(2);
  });
});

describe('mirrorRecipeState - target gravity', function () {
  test('values add the columns and are written by header', function () {
    var t = setup(HEADERS19);
    var res = t.api.mirrorRecipeState({ recipe: recipe({ target_og: 12, target_fg: 3.5 }), ingredients: [] });
    expect(res.ok).toBe(true);
    expect(t.recipes.data[0].slice(-3)).toEqual(['beer_category', 'target_og', 'target_fg']);
    expect(cell(t.recipes, 1, 'target_og')).toBe(12);
    expect(cell(t.recipes, 1, 'target_fg')).toBe(3.5);
  });

  test('recipes without values leave the header untouched', function () {
    var t = setup(HEADERS19);
    t.api.mirrorRecipeState({ recipe: recipe(), ingredients: [] });
    expect(t.recipes.data[0].length).toBe(19);
    t.api.mirrorRecipeState({ recipe: recipe({ target_og: '', target_fg: '' }), ingredients: [] });
    expect(t.recipes.data[0].length).toBe(19);
  });

  test('existing columns in any position are written by header name', function () {
    var headers = HEADERS19.slice(0, 5).concat(['target_fg', 'target_og']).concat(HEADERS19.slice(5));
    var t = setup(headers);
    t.api.mirrorRecipeState({ recipe: recipe({ target_og: 11, target_fg: 2.5 }), ingredients: [] });
    expect(t.recipes.data[0].length).toBe(21);
    expect(cell(t.recipes, 1, 'target_og')).toBe(11);
    expect(cell(t.recipes, 1, 'target_fg')).toBe(2.5);
  });
});

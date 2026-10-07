'use strict';

// Behavioural coverage for the Phase 85 Apps Script actions: mirror_recipe_state,
// mirror_recipe_delete (D-01 state copy) and recipe_batch_ref_count (read-only).
// Uses a fake Sheets runtime (modelled on adminapi-giftcard-mirror.test.js) extended with
// getDataRange().getValues(), getRange(...).setValues(), deleteRows(start, count) and a write log.
// This models the Apps Script APIs; the live redeploy + probe (85-12) is the real gate.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

// Deliberately NOT the canonical order, and without pricing_mode / schedule_id by default.
var RECIPE_HEADERS_SHUFFLED = [
  'recipe_id', 'status', 'name', 'style', 'description', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at',
  'created_by', 'updated_at'
];
var RECIPE_HEADERS_FULL = RECIPE_HEADERS_SHUFFLED.concat(['pricing_mode', 'schedule_id']);
var ING_HEADERS = ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'];

function makeFakeSheet(headerRow) {
  var grid = headerRow ? [headerRow.slice()] : [];
  var writes = [];

  var sheet = {
    _grid: grid,
    _writes: writes,
    getLastColumn: function () {
      return grid.reduce(function (max, row) { return Math.max(max, row.length); }, 0);
    },
    getLastRow: function () { return grid.length; },
    appendRow: function (values) {
      writes.push({ op: 'appendRow' });
      grid.push(values.slice());
    },
    getDataRange: function () {
      return {
        getValues: function () {
          var w = sheet.getLastColumn();
          return grid.map(function (r) {
            var out = r.slice();
            while (out.length < w) out.push('');
            return out;
          });
        }
      };
    },
    getRange: function (row, col, numRows, numCols) {
      if (numRows === undefined) {
        var cell = {
          setValue: function (value) {
            writes.push({ op: 'setValue' });
            if (!grid[row - 1]) grid[row - 1] = [];
            grid[row - 1][col - 1] = value;
            return cell;
          },
          setFontWeight: function () { return cell; },
          getValue: function () { return (grid[row - 1] || [])[col - 1]; }
        };
        return cell;
      }
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var src = grid[row - 1 + r] || [];
            var line = [];
            for (var c = 0; c < numCols; c++) {
              line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setValues: function (vals) {
          writes.push({ op: 'setValues', row: row, rows: vals.length });
          for (var r = 0; r < vals.length; r++) {
            if (!grid[row - 1 + r]) grid[row - 1 + r] = [];
            for (var c = 0; c < vals[r].length; c++) grid[row - 1 + r][col - 1 + c] = vals[r][c];
          }
        },
        setFontWeight: function () { return this; }
      };
    },
    deleteRows: function (start, count) {
      writes.push({ op: 'deleteRows', start: start, count: count });
      grid.splice(start - 1, count);
    },
    deleteRow: function (r) {
      writes.push({ op: 'deleteRow', row: r });
      grid.splice(r - 1, 1);
    }
  };
  return sheet;
}

function makeFakeSpreadsheetApp(sheetsByName) {
  return {
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) {
          return Object.prototype.hasOwnProperty.call(sheetsByName, name) ? sheetsByName[name] : null;
        }
      };
    }
  };
}

function loadAdminApi(sheets) {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var lockCalls = { n: 0 };
  var lockService = {
    getScriptLock: function () {
      lockCalls.n++;
      return { waitLock: function () {}, releaseLock: function () {} };
    }
  };
  var factory = new Function(
    'SpreadsheetApp', 'Logger', 'LockService',
    src + '\nreturn {' +
      'mirrorRecipeState: (typeof mirrorRecipeState !== "undefined" ? mirrorRecipeState : undefined),' +
      'mirrorRecipeDelete: (typeof mirrorRecipeDelete !== "undefined" ? mirrorRecipeDelete : undefined),' +
      'recipeBatchRefCount: (typeof recipeBatchRefCount !== "undefined" ? recipeBatchRefCount : undefined)' +
      '};'
  );
  var api = factory(makeFakeSpreadsheetApp(sheets), { log: function () {} }, lockService);
  api._lockCalls = lockCalls;
  return api;
}

function recipeObj(id, overrides) {
  var r = {
    recipe_id: id, name: 'Pale Ale', style: 'APA', description: 'Hoppy', status: 'active',
    locked_price: 120, service_fee: 45, materials_fee: 5, batch_size_l: 23, abv: 5.2, ibu: 35,
    colour_srm: 6, notes: 'n', created_at: '2026-01-01T00:00:00.000Z', created_by: 'middleware',
    updated_at: '2026-02-01T00:00:00.000Z', pricing_mode: 'dynamic', schedule_id: 'SCH-1'
  };
  Object.keys(overrides || {}).forEach(function (k) { r[k] = overrides[k]; });
  return r;
}

function ingObj(n, recipeId, itemId) {
  return {
    ingredient_id: 'RI-' + ('000000' + n).slice(-6), recipe_id: recipeId, item_id: itemId || 'ITEM-1',
    item_name: 'Malt', quantity: n, unit: 'kg'
  };
}

function recipeRowFor(headers, rec) {
  return headers.map(function (h) { return rec[h] === undefined ? '' : rec[h]; });
}

function ingRowFor(ing) {
  return ING_HEADERS.map(function (h) { return ing[h]; });
}

function setup(recipeHeaders) {
  var recipes = makeFakeSheet(recipeHeaders || RECIPE_HEADERS_FULL.slice());
  var ings = makeFakeSheet(ING_HEADERS.slice());
  var batches = makeFakeSheet(['batch_id', 'recipe_id', 'status']);
  var api = loadAdminApi({ Recipes: recipes, RecipeIngredients: ings, Batches: batches });
  return { api: api, recipes: recipes, ings: ings, batches: batches };
}

function rawSource() { return fs.readFileSync(ADMIN_API_PATH, 'utf8'); }

describe('mirrorRecipeState - unknown recipe (insert)', function () {
  test('places all 18 values by header name and appends ingredients in order', function () {
    var t = setup(RECIPE_HEADERS_FULL.slice());
    var ingredients = [ingObj(1, 'SV-R-000010'), ingObj(2, 'SV-R-000010', 'ITEM-2')];
    var res = t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010'), ingredients: ingredients });
    expect(res).toEqual({ ok: true, row_action: 'inserted', ingredient_rows: 2 });
    expect(t.recipes._grid[1]).toEqual(recipeRowFor(RECIPE_HEADERS_FULL, recipeObj('SV-R-000010')));
    expect(t.recipes._grid[1][RECIPE_HEADERS_FULL.indexOf('status')]).toBe('active');
    expect(t.ings._grid.slice(1)).toEqual(ingredients.map(ingRowFor));
  });
});

describe('mirrorRecipeState - known recipe (update)', function () {
  test('overwrites every cell, replaces own ingredient rows (non-contiguous), keeps others in order', function () {
    var t = setup(RECIPE_HEADERS_FULL.slice());
    var old = recipeObj('SV-R-000010', { name: 'OLD', locked_price: 1 });
    t.recipes._grid.push(recipeRowFor(RECIPE_HEADERS_FULL, old));
    t.recipes._grid.push(recipeRowFor(RECIPE_HEADERS_FULL, recipeObj('SV-R-000011', { name: 'Other' })));
    var otherA = ingObj(50, 'SV-R-000011');
    var otherB = ingObj(51, 'SV-R-000011');
    t.ings._grid.push(ingRowFor(ingObj(1, 'SV-R-000010')));
    t.ings._grid.push(ingRowFor(otherA));
    t.ings._grid.push(ingRowFor(ingObj(2, 'SV-R-000010')));
    t.ings._grid.push(ingRowFor(otherB));
    t.ings._grid.push(ingRowFor(ingObj(3, 'SV-R-000010')));

    var fresh = recipeObj('SV-R-000010', { name: 'NEW', locked_price: 99 });
    var newIngs = [ingObj(7, 'SV-R-000010'), ingObj(8, 'SV-R-000010')];
    var res = t.api.mirrorRecipeState({ recipe: fresh, ingredients: newIngs });

    expect(res).toEqual({ ok: true, row_action: 'updated', ingredient_rows: 2 });
    expect(t.recipes._grid[1]).toEqual(recipeRowFor(RECIPE_HEADERS_FULL, fresh));
    expect(t.recipes._grid[2][RECIPE_HEADERS_FULL.indexOf('name')]).toBe('Other');
    expect(t.ings._grid.slice(1)).toEqual([otherA, otherB].concat(newIngs).map(ingRowFor));
    var dels = t.ings._writes.filter(function (w) { return w.op === 'deleteRows'; });
    for (var i = 1; i < dels.length; i++) expect(dels[i].start).toBeLessThan(dels[i - 1].start);
    expect(t.ings._writes.filter(function (w) { return w.op === 'setValues'; }).length).toBe(1);
  });

  test('uses header-name addressing even when header order differs from canonical', function () {
    var shuffled = ['status', 'recipe_id', 'name'].concat(RECIPE_HEADERS_FULL.filter(function (h) {
      return ['status', 'recipe_id', 'name'].indexOf(h) === -1;
    }));
    var t = setup(shuffled);
    t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010'), ingredients: [] });
    expect(t.recipes._grid[1][0]).toBe('active');
    expect(t.recipes._grid[1][1]).toBe('SV-R-000010');
    expect(t.recipes._grid[1][2]).toBe('Pale Ale');
  });
});

describe('mirrorRecipeState - duplicates, idempotence, legacy header', function () {
  test('three ingredient rows sharing an item_id round-trip with their own ids', function () {
    var t = setup();
    var ings = [ingObj(1, 'SV-R-000002', 'SAME'), ingObj(2, 'SV-R-000002', 'SAME'), ingObj(3, 'SV-R-000002', 'SAME')];
    t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000002'), ingredients: ings });
    expect(t.ings._grid.slice(1).map(function (r) { return r[0]; })).toEqual(['RI-000001', 'RI-000002', 'RI-000003']);
    expect(t.ings._grid.slice(1).every(function (r) { return r[2] === 'SAME'; })).toBe(true);
  });

  test('same payload twice gives identical sheet state', function () {
    var t = setup();
    var payload = { recipe: recipeObj('SV-R-000010'), ingredients: [ingObj(1, 'SV-R-000010'), ingObj(2, 'SV-R-000010')] };
    t.api.mirrorRecipeState(payload);
    var r1 = JSON.stringify(t.recipes._grid);
    var i1 = JSON.stringify(t.ings._grid);
    var res2 = t.api.mirrorRecipeState(payload);
    expect(res2.row_action).toBe('updated');
    expect(JSON.stringify(t.recipes._grid)).toBe(r1);
    expect(JSON.stringify(t.ings._grid)).toBe(i1);
  });

  test('legacy header without pricing_mode/schedule_id gains them in order and keeps the values', function () {
    var t = setup(RECIPE_HEADERS_SHUFFLED.slice());
    t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010'), ingredients: [] });
    var header = t.recipes._grid[0];
    expect(header.slice(-2)).toEqual(['pricing_mode', 'schedule_id']);
    expect(header.length).toBe(18);
    expect(t.recipes._grid[1][header.indexOf('pricing_mode')]).toBe('dynamic');
    expect(t.recipes._grid[1][header.indexOf('schedule_id')]).toBe('SCH-1');
  });

  test('text is stored verbatim with no re-sanitisation', function () {
    var t = setup();
    t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010', { name: '<scr<script>ipt>' }), ingredients: [] });
    expect(t.recipes._grid[1][RECIPE_HEADERS_FULL.indexOf('name')]).toBe('<scr<script>ipt>');
  });
});

describe('mirrorRecipeState - validation', function () {
  function expectNoWrites(t) {
    expect(t.recipes._writes.length).toBe(0);
    expect(t.ings._writes.length).toBe(0);
  }

  test('missing recipe or non-array ingredients -> missing_fields', function () {
    var t = setup();
    expect(t.api.mirrorRecipeState({ ingredients: [] })).toEqual({ ok: false, error: 'missing_fields' });
    expect(t.api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010'), ingredients: 'x' }))
      .toEqual({ ok: false, error: 'missing_fields' });
    expectNoWrites(t);
  });

  test('bad ids or foreign ingredient recipe_id -> invalid_id, no writes', function () {
    var t = setup();
    expect(t.api.mirrorRecipeState({ recipe: recipeObj('bad'), ingredients: [] }).error).toBe('invalid_id');
    expect(t.api.mirrorRecipeState({
      recipe: recipeObj('SV-R-000010'), ingredients: [{ ingredient_id: 'nope', recipe_id: 'SV-R-000010' }]
    }).error).toBe('invalid_id');
    expect(t.api.mirrorRecipeState({
      recipe: recipeObj('SV-R-000010'), ingredients: [ingObj(1, 'SV-R-000099')]
    }).error).toBe('invalid_id');
    expectNoWrites(t);
  });

  test('missing sheet -> sheet_not_found', function () {
    var api = loadAdminApi({});
    expect(api.mirrorRecipeState({ recipe: recipeObj('SV-R-000010'), ingredients: [] }))
      .toEqual({ ok: false, error: 'sheet_not_found' });
  });
});

describe('mirrorRecipeDelete', function () {
  test('removes ingredient rows then recipe row; second call is an idempotent no-op', function () {
    var t = setup();
    t.recipes._grid.push(recipeRowFor(RECIPE_HEADERS_FULL, recipeObj('SV-R-000010')));
    t.recipes._grid.push(recipeRowFor(RECIPE_HEADERS_FULL, recipeObj('SV-R-000011')));
    t.ings._grid.push(ingRowFor(ingObj(1, 'SV-R-000010')));
    t.ings._grid.push(ingRowFor(ingObj(2, 'SV-R-000011')));
    t.ings._grid.push(ingRowFor(ingObj(3, 'SV-R-000010')));

    expect(t.api.mirrorRecipeDelete({ recipe_id: 'SV-R-000010' }))
      .toEqual({ ok: true, recipe_removed: true, ingredient_rows_removed: 2 });
    expect(t.recipes._grid.length).toBe(2);
    expect(t.recipes._grid[1][0]).toBe('SV-R-000011');
    expect(t.ings._grid.length).toBe(2);
    expect(t.api.mirrorRecipeDelete({ recipe_id: 'SV-R-000010' }))
      .toEqual({ ok: true, recipe_removed: false, ingredient_rows_removed: 0 });
  });

  test('invalid id and missing sheet', function () {
    expect(setup().api.mirrorRecipeDelete({ recipe_id: 'x' })).toEqual({ ok: false, error: 'invalid_id' });
    expect(loadAdminApi({}).mirrorRecipeDelete({ recipe_id: 'SV-R-000010' }))
      .toEqual({ ok: false, error: 'sheet_not_found' });
  });
});

describe('server_token dispatch registration', function () {
  var src = rawSource();
  var tokenBlock = src.slice(src.indexOf('if (payload.server_token) {'));

  ['mirror_recipe_state', 'mirror_recipe_delete', 'recipe_batch_ref_count'].forEach(function (name) {
    test(name + ' is registered exactly once inside the server_token block', function () {
      var needle = "action === '" + name + "'";
      expect(src.split(needle).length - 1).toBe(1);
      expect(tokenBlock.indexOf(needle)).toBeGreaterThan(-1);
    });
  });

  test('both mirror dispatches evict the recipe cache and respond via _jsonResponse', function () {
    ['mirror_recipe_state', 'mirror_recipe_delete'].forEach(function (name) {
      var start = src.indexOf("action === '" + name + "'");
      var body = src.slice(start, src.indexOf('\n      }\n', start));
      expect(body).toMatch(/_invalidateRecipeCache\(/);
      expect(body).toMatch(/_jsonResponse\(/);
    });
  });
});

describe('recipeBatchRefCount', function () {
  function withBatches() {
    var t = setup();
    t.batches._grid.push(['B1', 'SV-R-000004', 'open']);
    t.batches._grid.push(['B2', 'SV-R-000006', 'open']);
    t.batches._grid.push(['B3', 'SV-R-000004', 'closed']);
    return t;
  }

  test('counts matching batch rows per recipe', function () {
    var t = withBatches();
    expect(t.api.recipeBatchRefCount({ recipe_id: 'SV-R-000004' })).toEqual({ ok: true, count: 2 });
    expect(t.api.recipeBatchRefCount({ recipe_id: 'SV-R-000006' })).toEqual({ ok: true, count: 1 });
    expect(t.api.recipeBatchRefCount({ recipe_id: 'SV-R-000007' })).toEqual({ ok: true, count: 0 });
  });

  test('is read-only and takes no lock', function () {
    var t = withBatches();
    t.api.recipeBatchRefCount({ recipe_id: 'SV-R-000004' });
    expect(t.batches._writes.length).toBe(0);
    expect(t.api._lockCalls.n).toBe(0);
  });

  test('invalid id and missing Batches sheet', function () {
    expect(withBatches().api.recipeBatchRefCount({ recipe_id: 'nope' })).toEqual({ ok: false, error: 'invalid_id' });
    expect(loadAdminApi({}).recipeBatchRefCount({ recipe_id: 'SV-R-000004' }))
      .toEqual({ ok: false, error: 'sheet_not_found' });
  });
});

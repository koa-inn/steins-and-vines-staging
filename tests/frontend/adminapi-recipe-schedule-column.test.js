'use strict';

// Behavioural regression coverage for ensureRecipesScheduleIdColumn's self-migration
// (Phase 81, plan 81-01, Task 1 — D-03: recipes carry a schedule_id pointing at a
// FermSchedules template).
//
// This mirrors tests/frontend/adminapi-waitlist-ensure-sheet.test.js's fake-Sheets-runtime
// harness: apps-script/adminApi.gs is read with fs.readFileSync and evaluated via `new
// Function` with a fake SpreadsheetApp/Logger injected as parameters, shadowing the Apps
// Script globals of the same name. This lets the migration branches actually execute and be
// observed instead of only asserted by source shape.
//
// WHAT THIS SUITE STILL CANNOT PROVE: the fake is a model of the Sheets API, not the real
// thing. The live probe in plan 81-07 remains the real gate.

var fs = require('fs');
var path = require('path');

var ADMIN_API_PATH = path.join(__dirname, '../../apps-script/adminApi.gs');

// --- Fake Sheets runtime -------------------------------------------------------------------

function makeFakeSheet(headerRow) {
  var grid = headerRow ? [headerRow.slice()] : [];
  var calls = { setValue: [], setFontWeight: [] };

  return {
    _grid: grid,
    _calls: calls,

    getLastColumn: function () {
      return grid.reduce(function (max, row) {
        return Math.max(max, row.length);
      }, 0);
    },

    // Mirrors the two call shapes this migration idiom uses:
    //   getRange(row, col)                 -> single cell (header write)
    //   getRange(row, col, numRows, numCols) -> block read (header row read)
    getRange: function (row, col, numRows, numCols) {
      var isBlock = numRows !== undefined && numCols !== undefined;
      if (!isBlock) {
        var cell = {
          setValue: function (v) {
            calls.setValue.push({ row: row, col: col, value: v });
            if (!grid[row - 1]) grid[row - 1] = [];
            grid[row - 1][col - 1] = v;
            return cell;
          },
          setFontWeight: function (weight) {
            calls.setFontWeight.push({ row: row, col: col, weight: weight });
            return cell;
          }
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
        }
      };
    }
  };
}

function loadRecipeScheduleColumnFns() {
  var src = fs.readFileSync(ADMIN_API_PATH, 'utf8');
  var logged = [];
  var logger = { log: function (msg) { logged.push(String(msg)); } };
  // SpreadsheetApp/CacheService are declared as parameters here so they shadow the Apps
  // Script globals adminApi.gs references as free variables; neither is called by the
  // functions under test in this suite, but adminApi.gs's file-level scope must not throw
  // on evaluation.
  var factory = new Function(
    'SpreadsheetApp',
    'CacheService',
    'Logger',
    src + '\nreturn {' +
      'ensureRecipesScheduleIdColumn: (typeof ensureRecipesScheduleIdColumn !== "undefined" ? ensureRecipesScheduleIdColumn : undefined),' +
      'ensureRecipesPricingModeColumn: (typeof ensureRecipesPricingModeColumn !== "undefined" ? ensureRecipesPricingModeColumn : undefined)' +
      '};'
  );
  var api = factory(undefined, undefined, logger);
  api._logged = logged;
  return api;
}

// --- Tests ---------------------------------------------------------------------------------

describe('ensureRecipesScheduleIdColumn — self-migrating Recipes column (D-03, behavioural, fake Sheets runtime)', function () {
  test('appends schedule_id at lastCol+1, bold, and returns the zero-based index when absent', function () {
    var api = loadRecipeScheduleColumnFns();
    expect(typeof api.ensureRecipesScheduleIdColumn).toBe('function');

    var sheet = makeFakeSheet(['recipe_id', 'name', 'style']);
    var idx = api.ensureRecipesScheduleIdColumn(sheet);

    expect(idx).toBe(3); // zero-based index of the newly appended column (lastCol was 3)
    expect(sheet._grid[0]).toEqual(['recipe_id', 'name', 'style', 'schedule_id']);
    expect(sheet._calls.setFontWeight.length).toBe(1);
    expect(sheet._calls.setFontWeight[0].weight).toBe('bold');
  });

  test('returns the existing zero-based index and writes nothing when schedule_id is already present', function () {
    var api = loadRecipeScheduleColumnFns();
    var sheet = makeFakeSheet(['recipe_id', 'name', 'schedule_id', 'style']);

    var idx = api.ensureRecipesScheduleIdColumn(sheet);

    expect(idx).toBe(2);
    expect(sheet._calls.setValue).toEqual([]);
    expect(sheet._calls.setFontWeight).toEqual([]);
  });

  test('calling it twice in a row leaves exactly one schedule_id header cell', function () {
    var api = loadRecipeScheduleColumnFns();
    var sheet = makeFakeSheet(['recipe_id', 'name']);

    var first = api.ensureRecipesScheduleIdColumn(sheet);
    var second = api.ensureRecipesScheduleIdColumn(sheet);

    expect(first).toBe(second);
    var count = sheet._grid[0].filter(function (h) { return h === 'schedule_id'; }).length;
    expect(count).toBe(1);
  });

  test('does not disturb the pricing_mode column when both are absent and both ensure-functions run', function () {
    var api = loadRecipeScheduleColumnFns();
    expect(typeof api.ensureRecipesPricingModeColumn).toBe('function');

    var sheet = makeFakeSheet(['recipe_id', 'name']);

    var pmIdx = api.ensureRecipesPricingModeColumn(sheet);
    var schedIdx = api.ensureRecipesScheduleIdColumn(sheet);

    expect(sheet._grid[0]).toEqual(['recipe_id', 'name', 'pricing_mode', 'schedule_id']);
    expect(pmIdx).toBe(2);
    expect(schedIdx).toBe(3);
    expect(sheet._grid[0][pmIdx]).toBe('pricing_mode');
    expect(sheet._grid[0][schedIdx]).toBe('schedule_id');
  });
});

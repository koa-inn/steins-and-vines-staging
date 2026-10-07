'use strict';

/**
 * Tests for scripts/backfill/recipes-verify.js - Phase 85 Plan 11 (DB-04, D-01/D-02).
 * Synthetic data only. compareRecipes is pure; runVerify uses a fake pool and a real .xlsx.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var ExcelJS = require('exceljs');

var recipesVerify = require('../../scripts/backfill/recipes-verify');
var compareRecipes = recipesVerify.compareRecipes;
var runVerify = recipesVerify.runVerify;
var parseArgs = recipesVerify.parseArgs;
var EXIT = recipesVerify.EXIT;
var recipeSpecs = require('../../scripts/backfill/specs/recipes');

var RECIPE_HEADERS = recipeSpecs.recipes.columns.map(function (c) { return c.header; });
var INGREDIENT_HEADERS = recipeSpecs.ingredients.columns.map(function (c) { return c.header; });

function pgRecipe(overrides, ingredients) {
  return {
    recipe: Object.assign({
      recipe_id: 'SV-R-000001', name: 'Test Pale', style: 'Pale Ale', description: '', status: 'active',
      locked_price: 100, service_fee: '', materials_fee: '', batch_size_l: 23, abv: 5, ibu: 30,
      colour_srm: 8, notes: '', created_at: '2026-01-15T08:00:00.000Z', created_by: 'staff',
      updated_at: '2026-01-16T08:00:00.000Z', pricing_mode: 'locked', schedule_id: ''
    }, overrides || {}),
    ingredients: ingredients || [
      { ingredient_id: 'RI-000001', recipe_id: 'SV-R-000001', item_id: 'A', item_name: 'Malt', quantity: 5, unit: 'kg' },
      { ingredient_id: 'RI-000002', recipe_id: 'SV-R-000001', item_id: 'B', item_name: 'Hops', quantity: 1, unit: 'kg' }
    ]
  };
}

function sheetPlan(recipeOverrides, ingredients) {
  var recipe = Object.assign({
    recipe_id: 'SV-R-000001', name: 'Test Pale', style: 'Pale Ale', description: null, status: 'active',
    locked_price: '100', service_fee: null, materials_fee: null, batch_size_l: '23', abv: '5.0', ibu: '30',
    colour_srm: '8', notes: null, created_at: '2026-01-15T08:00:00Z', created_by: 'staff',
    updated_at: '2026-01-16T08:00:00Z', pricing_mode: 'locked', schedule_id: null
  }, recipeOverrides || {});
  return {
    recipes: [recipe],
    ingredients: ingredients || [
      { ingredient_id: 'RI-000001', recipe_id: 'SV-R-000001', position: 1, item_id: 'A', item_name: 'Malt', quantity: '5', unit: 'kg' },
      { ingredient_id: 'RI-000002', recipe_id: 'SV-R-000001', position: 2, item_id: 'B', item_name: 'Hops', quantity: '1', unit: 'kg' }
    ],
    rejects: []
  };
}

describe('compareRecipes', function () {
  it('returns [] for identical data across numeric/timestamp/empty representations', function () {
    expect(compareRecipes({ pgRecipes: [pgRecipe()], sheetPlan: sheetPlan() })).toEqual([]);
  });

  it('treats the same instant in a different string form as equal', function () {
    var plan = sheetPlan({ updated_at: '2026-01-16T00:00:00-08:00' });
    expect(compareRecipes({ pgRecipes: [pgRecipe()], sheetPlan: plan })).toEqual([]);
  });

  it('reports a name difference as {id, field}', function () {
    var out = compareRecipes({ pgRecipes: [pgRecipe({ name: 'Other' })], sheetPlan: sheetPlan() });
    expect(out).toEqual([{ id: 'SV-R-000001', field: 'name' }]);
  });

  it('reports a numeric difference', function () {
    var out = compareRecipes({ pgRecipes: [pgRecipe({ abv: 5.5 })], sheetPlan: sheetPlan() });
    expect(out).toEqual([{ id: 'SV-R-000001', field: 'abv' }]);
  });

  it('reports an ingredient quantity difference against the ingredient id', function () {
    var pg = pgRecipe();
    pg.ingredients[1].quantity = 2;
    expect(compareRecipes({ pgRecipes: [pg], sheetPlan: sheetPlan() })).toEqual([{ id: 'RI-000002', field: 'quantity' }]);
  });

  it('reports swapped ingredient order against the recipe id', function () {
    var pg = pgRecipe();
    pg.ingredients.reverse();
    expect(compareRecipes({ pgRecipes: [pg], sheetPlan: sheetPlan() }))
      .toEqual([{ id: 'SV-R-000001', field: 'ingredient_order' }]);
  });

  it('reports ingredient count differences', function () {
    var pg = pgRecipe();
    pg.ingredients.pop();
    expect(compareRecipes({ pgRecipes: [pg], sheetPlan: sheetPlan() }))
      .toEqual([{ id: 'SV-R-000001', field: 'ingredient_count' }]);
  });

  it('reports recipes missing on either side', function () {
    expect(compareRecipes({ pgRecipes: [], sheetPlan: sheetPlan() }))
      .toEqual([{ id: 'SV-R-000001', field: 'missing_in_postgres' }]);
    expect(compareRecipes({ pgRecipes: [pgRecipe()], sheetPlan: { recipes: [], ingredients: [], rejects: [] } }))
      .toEqual([{ id: 'SV-R-000001', field: 'missing_in_sheet' }]);
  });
});

describe('parseArgs', function () {
  it('rejects connection strings on argv and unknown flags', function () {
    expect(function () { parseArgs(['postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { parseArgs(['--bogus=1']); }).toThrow(/unknown flag/);
  });
  it('parses --file', function () {
    expect(parseArgs(['--file=./s.xlsx']).file).toBe('./s.xlsx');
  });
});

describe('runVerify', function () {
  var tmpDir;
  beforeEach(function () { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-rcp-verify-')); });
  afterEach(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeSnapshot(recipeName) {
    var filePath = path.join(tmpDir, 'live.xlsx');
    var wb = new ExcelJS.Workbook();
    var rs = wb.addWorksheet('Recipes');
    rs.addRow(RECIPE_HEADERS);
    rs.addRow([
      'SV-R-000001', recipeName, 'Pale Ale', '', 'active', 100, '', '', 23, 5, 30, 8, '',
      '2026-01-15T08:00:00Z', 'staff', '2026-01-16T08:00:00Z', 'locked', ''
    ]);
    var is = wb.addWorksheet('RecipeIngredients');
    is.addRow(INGREDIENT_HEADERS);
    is.addRow(['RI-000001', 'SV-R-000001', 'A', 'Malt', 5, 'kg']);
    return wb.xlsx.writeFile(filePath).then(function () { return filePath; });
  }

  function fakePool(pgName) {
    var queries = [];
    var rec = pgRecipe({ name: pgName }).recipe;
    var client = {
      query: jest.fn(function (sql) {
        queries.push(sql);
        if (/^begin transaction read only$/.test(sql) || /^commit$/.test(sql) || /^rollback$/.test(sql)) {
          return Promise.resolve({ rows: [] });
        }
        if (/select recipe_id from recipes order by recipe_id/.test(sql)) {
          return Promise.resolve({ rows: [{ recipe_id: 'SV-R-000001' }] });
        }
        if (/from recipe_ingredients/.test(sql)) {
          return Promise.resolve({ rows: [
            { ingredient_id: 'RI-000001', recipe_id: 'SV-R-000001', item_id: 'A', item_name: 'Malt', quantity: '5.0000', unit: 'kg' }
          ] });
        }
        if (/from recipes where recipe_id/.test(sql)) {
          return Promise.resolve({ rows: [Object.assign({}, rec, {
            created_at: new Date(rec.created_at), updated_at: new Date(rec.updated_at), abv: '5.0'
          })] });
        }
        return Promise.reject(new Error('unexpected query in test: ' + sql));
      }),
      release: jest.fn()
    };
    return { queries: queries, client: client, connect: jest.fn(function () { return Promise.resolve(client); }) };
  }

  function captureLog() {
    var lines = [];
    var log = function (m) { lines.push(String(m)); };
    log.lines = lines;
    return log;
  }

  it('reports a clean verify and only issues read-only SQL', async function () {
    var file = await writeSnapshot('Test Pale');
    var log = captureLog();
    var pool = fakePool('Test Pale');
    var result = await runVerify({ file: file }, { pool: pool, log: log });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(log.lines).toContain('Verified 1 recipes: 0 mismatches');
    expect(pool.queries[0]).toBe('begin transaction read only');
    pool.queries.forEach(function (sql) {
      expect(sql).not.toMatch(/^\s*(insert|update|delete|truncate|drop|alter|create)\b/i);
    });
    expect(pool.client.release).toHaveBeenCalled();
  });

  it('prints id + field only on a mismatch, never the values', async function () {
    var file = await writeSnapshot('Distinctive Sheet Name');
    var log = captureLog();
    var result = await runVerify({ file: file }, { pool: fakePool('Distinctive Postgres Name'), log: log });
    expect(result.exitCode).toBe(EXIT.CHECKS_FAILED);
    var out = log.lines.join('\n');
    expect(out).toMatch(/MISMATCH id=SV-R-000001 field=name/);
    expect(out).not.toMatch(/Distinctive/);
  });

  it('errors when the snapshot is missing', async function () {
    var log = captureLog();
    var result = await runVerify({ file: path.join(tmpDir, 'nope.xlsx') }, { pool: fakePool('x'), log: log });
    expect(result.exitCode).toBe(EXIT.ERROR);
  });
});

'use strict';

/**
 * Real-Postgres end-to-end tests for the Recipes backfill CLI - Phase 85 Plan 10 Task 2
 * (DB-04, ROADMAP SC1). Runs ONLY via `npm run test:db` (jest.db.config.js), gated by
 * describeDb(). Synthetic data only; builds a throwaway .xlsx with ExcelJS in os.tmpdir().
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var ExcelJS = require('exceljs');

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var recipesBackfill = require('../../scripts/backfill/recipes-backfill');
var recipeSpecs = require('../../scripts/backfill/specs/recipes');

var EXIT = recipesBackfill.EXIT;
var RECIPE_HEADERS = recipeSpecs.recipes.columns.map(function (c) { return c.header; });
var INGREDIENT_HEADERS = recipeSpecs.ingredients.columns.map(function (c) { return c.header; });

function recipeRow(overrides) {
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
  return Object.assign(base, overrides || {});
}

function ingRow(overrides) {
  var base = {
    ingredient_id: 'RI-000001',
    recipe_id: 'SV-R-000001',
    item_id: 'ITEM-A',
    item_name: 'Pale Malt',
    quantity: 5,
    unit: 'kg'
  };
  return Object.assign(base, overrides || {});
}

function buildFixtureXlsx(recipes, ingredients) {
  var workbook = new ExcelJS.Workbook();
  var rs = workbook.addWorksheet('Recipes');
  rs.addRow(RECIPE_HEADERS);
  recipes.forEach(function (r) {
    rs.addRow(RECIPE_HEADERS.map(function (h) { return r[h] !== undefined ? r[h] : ''; }));
  });
  var is = workbook.addWorksheet('RecipeIngredients');
  is.addRow(INGREDIENT_HEADERS);
  ingredients.forEach(function (r) {
    is.addRow(INGREDIENT_HEADERS.map(function (h) { return r[h] !== undefined ? r[h] : ''; }));
  });
  var filePath = path.join(
    os.tmpdir(),
    'recipes-backfill-fixture-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.xlsx'
  );
  return workbook.xlsx.writeFile(filePath).then(function () { return filePath; });
}

// Clean fixture: SV-R-000002 has three same-item rows; ids have gaps (max recipe 4, max ingredient 150);
// ingredient id order is not monotonic in sheet order.
function cleanRecipes() {
  return [
    recipeRow({ recipe_id: 'SV-R-000001' }),
    recipeRow({ recipe_id: 'SV-R-000002', name: 'Stout', status: 'draft', pricing_mode: 'dynamic' }),
    recipeRow({ recipe_id: 'SV-R-000004', name: 'Cider', status: 'inactive', notes: 'a note' })
  ];
}

function cleanIngredients() {
  return [
    ingRow({ ingredient_id: 'RI-000150', recipe_id: 'SV-R-000001', item_id: 'ITEM-A', quantity: 0.0055 }),
    ingRow({ ingredient_id: 'RI-000010', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 1 }),
    ingRow({ ingredient_id: 'RI-000033', recipe_id: 'SV-R-000001', item_id: 'ITEM-B', quantity: 2 }),
    ingRow({ ingredient_id: 'RI-000011', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 2 }),
    ingRow({ ingredient_id: 'RI-000012', recipe_id: 'SV-R-000002', item_id: 'SAME', quantity: 3 }),
    ingRow({ ingredient_id: 'RI-000100', recipe_id: 'SV-R-000004', item_id: 'ITEM-C', quantity: 7 })
  ];
}

function captureLog() {
  var lines = [];
  var log = function (msg) { lines.push(String(msg)); };
  log.lines = lines;
  return log;
}

function okPrompt() {
  return function () { return Promise.resolve(); };
}

describeDb('Recipes backfill CLI (real Postgres, ROADMAP SC1)', function () {
  var container;
  var connectionString;
  var db;
  var pool;
  var outDir;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;

    var migrateResult = applyMigrations(connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }

    jest.resetModules();
    db = require('../../lib/db');
    pool = db.createPool(connectionString);
    process.env.BACKFILL_DATABASE_URL = connectionString;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-recipes-backfill-out-'));
  }, 120000);

  afterAll(async function () {
    delete process.env.BACKFILL_DATABASE_URL;
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  afterEach(async function () {
    var client = await pool.connect();
    try {
      await client.query('delete from recipe_ingredients');
      await client.query('delete from recipes');
      await client.query("select setval('recipe_id_seq', 1, false)");
      await client.query("select setval('recipe_ingredient_id_seq', 1, false)");
    } finally {
      client.release();
    }
  });

  async function countRows(table) {
    var r = await pool.query('select count(*)::int as count from ' + table);
    return r.rows[0].count;
  }

  // Wraps the shared pool so tests can assert connect/release behaviour.
  function spyPool() {
    var spy = { connects: 0, releases: 0 };
    spy.connect = function () {
      spy.connects++;
      return pool.connect().then(function (client) {
        var realRelease = client.release.bind(client);
        client.release = function () { spy.releases++; return realRelease(); };
        return client;
      });
    };
    return spy;
  }

  function args(file, extra) {
    return ['--file=' + file, '--out-dir=' + outDir, '--timezone=America/Vancouver'].concat(extra || []);
  }

  it('(a) --dry-run on a clean workbook: OK, counts printed, nothing written, no connect', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var log = captureLog();
    var spy = spyPool();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--dry-run']), { pool: spy, log: log });

    expect(code).toBe(EXIT.OK);
    var out = log.lines.join('\n');
    expect(out).toContain('3 recipes');
    expect(out).toContain('6 ingredients');
    expect(out).toContain('0 rejects');
    expect(spy.connects).toBe(0);
    expect(await countRows('recipes')).toBe(0);
    expect(await countRows('recipe_ingredients')).toBe(0);
  });

  it('(b) --promote into empty tables: parent-first insert, sequences seeded, SV-R-000002 intact', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var log = captureLog();
    var spy = spyPool();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: spy, log: log, promptTypeDatabaseName: okPrompt()
    });

    expect(code).toBe(EXIT.OK);
    expect(spy.connects).toBe(1);
    expect(spy.releases).toBe(1);
    expect(await countRows('recipes')).toBe(3);
    expect(await countRows('recipe_ingredients')).toBe(6);

    var same = await pool.query(
      "select ingredient_id, position, item_id from recipe_ingredients where recipe_id = 'SV-R-000002' order by position"
    );
    expect(same.rows).toEqual([
      { ingredient_id: 'RI-000010', position: 1, item_id: 'SAME' },
      { ingredient_id: 'RI-000011', position: 2, item_id: 'SAME' },
      { ingredient_id: 'RI-000012', position: 3, item_id: 'SAME' }
    ]);

    var order = await pool.query(
      "select ingredient_id, position, quantity from recipe_ingredients where recipe_id = 'SV-R-000001' order by position"
    );
    expect(order.rows.map(function (r) { return r.ingredient_id; })).toEqual(['RI-000150', 'RI-000033']);
    expect(order.rows[0].quantity).toBe('0.0055');

    var stout = await pool.query("select pricing_mode, status, created_at from recipes where recipe_id = 'SV-R-000002'");
    expect(stout.rows[0].pricing_mode).toBe('dynamic');
    expect(stout.rows[0].status).toBe('draft');
    expect(new Date(stout.rows[0].created_at).toISOString()).toBe('2026-01-15T08:00:00.000Z');

    // Sequences seeded from the max suffix (4 and 150): next default insert mints max+1.
    var minted = await pool.query(
      "insert into recipes (name, status, created_at, updated_at) values ('Minted', 'draft', now(), now()) returning recipe_id"
    );
    expect(minted.rows[0].recipe_id).toBe('SV-R-000005');
    var mintedIng = await pool.query(
      "insert into recipe_ingredients (recipe_id, position, item_id) values ('SV-R-000005', 1, 'X') returning ingredient_id"
    );
    expect(mintedIng.rows[0].ingredient_id).toBe('RI-000151');
  });

  it('(c) any reject blocks: dry-run exits REJECTS_BLOCK with a rejects file, promote refuses before connecting', async function () {
    var recipes = cleanRecipes();
    recipes[0] = recipeRow({
      recipe_id: 'SV-R-000001', created_at: 'middleware', created_by: '2026-01-15T08:00:00Z'
    });
    var file = await buildFixtureXlsx(recipes, cleanIngredients());
    var spy = spyPool();
    var log = captureLog();
    var before = fs.readdirSync(outDir).length;

    var dry = await recipesBackfill.runRecipesBackfill(args(file, ['--dry-run']), { pool: spy, log: log });
    expect(dry).toBe(EXIT.REJECTS_BLOCK);
    expect(fs.readdirSync(outDir).length).toBeGreaterThan(before);

    var promote = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: spy, log: log, promptTypeDatabaseName: okPrompt()
    });
    expect(promote).toBe(EXIT.REJECTS_BLOCK);
    expect(spy.connects).toBe(0);
    expect(await countRows('recipes')).toBe(0);

    var printed = log.lines.join('\n');
    expect(printed).not.toContain('middleware');
    expect(printed).not.toContain('staff-one@example.test');
  });

  it('(d) refuses when a target table is non-empty, before BEGIN', async function () {
    await pool.query(
      "insert into recipes (recipe_id, name, status, created_at, updated_at) values ('SV-R-000009', 'Existing', 'draft', now(), now())"
    );
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var spy = spyPool();
    var log = captureLog();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: spy, log: log, promptTypeDatabaseName: okPrompt()
    });

    expect(code).toBe(EXIT.ERROR);
    expect(log.lines.join('\n')).toContain('not empty');
    expect(spy.connects).toBe(1);
    expect(spy.releases).toBe(1);
    expect(await countRows('recipes')).toBe(1);
    expect(await countRows('recipe_ingredients')).toBe(0);
  });

  it('(e) an invariant failure rolls everything back and names only the failed check', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var spy = spyPool();
    var log = captureLog();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: spy,
      log: log,
      promptTypeDatabaseName: okPrompt(),
      planHook: function (plan) { plan.counts.recipes += 1; }
    });

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(log.lines.join('\n')).toContain('recipe_count');
    expect(spy.releases).toBe(1);
    expect(await countRows('recipes')).toBe(0);
    expect(await countRows('recipe_ingredients')).toBe(0);
  });

  it('(f) a per-recipe ingredient count mismatch also fails and rolls back', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var log = captureLog();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: pool,
      log: log,
      promptTypeDatabaseName: okPrompt(),
      planHook: function (plan) { plan.counts.perRecipe['SV-R-000002'] = 2; }
    });

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(log.lines.join('\n')).toContain('per_recipe_ingredient_count');
    expect(await countRows('recipes')).toBe(0);
  });

  it('(g) a database-name prompt mismatch aborts before BEGIN', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var spy = spyPool();
    var log = captureLog();

    var code = await recipesBackfill.runRecipesBackfill(args(file, ['--promote']), {
      pool: spy,
      log: log,
      promptTypeDatabaseName: function () { return Promise.reject(new Error('database name confirmation did not match')); }
    });

    expect(code).toBe(EXIT.ERROR);
    expect(spy.releases).toBe(1);
    expect(await countRows('recipes')).toBe(0);
  });

  it('(h) a database URL on the command line is rejected; only BACKFILL_DATABASE_URL is accepted', async function () {
    var file = await buildFixtureXlsx(cleanRecipes(), cleanIngredients());
    var log = captureLog();
    var spy = spyPool();

    var code = await recipesBackfill.runRecipesBackfill(
      args(file, ['--database-url=postgres://u:p@localhost/db']),
      { pool: spy, log: log }
    );

    expect(code).toBe(EXIT.ERROR);
    expect(log.lines.join('\n')).toContain('BACKFILL_DATABASE_URL');
    expect(spy.connects).toBe(0);
    expect(function () { recipesBackfill.parseArgs(['postgres://u:p@localhost/db']); }).toThrow(/BACKFILL_DATABASE_URL/);
  });
});

'use strict';

/**
 * Real-Postgres shape-parity tests for lib/recipe-pg.js reads — Phase 85 Plan 02 (DB-04, ROADMAP SC2).
 * Runs only via `npm run test:db` (skipped locally without Docker, never on CI).
 */

var fixture = require('../fixtures/recipes-sheet-shape.json');
var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describeDb('recipe-pg reads (shape parity with Apps Script)', function () {
  var container;
  var pool;
  var recipePg;
  var harness;

  function nul(v) {
    return v === '' ? null : v;
  }

  async function insertRecipe(client, r) {
    await client.query(
      'insert into recipes (recipe_id, name, style, description, status, locked_price, service_fee, ' +
        'materials_fee, batch_size_l, abv, ibu, colour_srm, notes, created_at, created_by, updated_at, ' +
        'pricing_mode, schedule_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
      [
        r.recipe_id, r.name, nul(r.style), nul(r.description), r.status, nul(r.locked_price),
        nul(r.service_fee), nul(r.materials_fee), nul(r.batch_size_l), nul(r.abv), nul(r.ibu),
        nul(r.colour_srm), nul(r.notes), r.created_at, nul(r.created_by), r.updated_at,
        r.pricing_mode, nul(r.schedule_id)
      ]
    );
  }

  async function insertIngredients(client, list) {
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      await client.query(
        'insert into recipe_ingredients (ingredient_id, recipe_id, position, item_id, item_name, quantity, unit) ' +
          'values ($1,$2,$3,$4,$5,$6,$7)',
        [g.ingredient_id, g.recipe_id, i + 1, g.item_id, nul(g.item_name), g.quantity, nul(g.unit)]
      );
    }
  }

  async function seed(client) {
    var ids = Object.keys(fixture.details);
    for (var i = 0; i < ids.length; i++) {
      await insertRecipe(client, fixture.details[ids[i]].recipe);
    }
    for (var j = 0; j < ids.length; j++) {
      await insertIngredients(client, fixture.details[ids[j]].ingredients);
    }
  }

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    recipePg = require('../../lib/recipe-pg');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () {
    return pool;
  });

  it('getRecipe is byte-identical to the Apps Script detail fixture for every recipe', async function () {
    var client = harness.client();
    await seed(client);
    var ids = Object.keys(fixture.details);
    for (var i = 0; i < ids.length; i++) {
      var got = await recipePg.getRecipe(client, ids[i]);
      expect(JSON.stringify(got)).toBe(JSON.stringify(fixture.details[ids[i]]));
    }
  });

  it('listRecipes(all, 0, 0) is byte-identical to the Apps Script list fixture', async function () {
    var client = harness.client();
    await seed(client);
    var got = await recipePg.listRecipes(client, { status: 'all', limit: 0, offset: 0 });
    expect(JSON.stringify(got)).toBe(JSON.stringify(fixture.list));
  });

  it('numerics are numbers, timestamps are ISO-ms strings, NULLs are empty strings', async function () {
    var client = harness.client();
    await seed(client);
    var d = await recipePg.getRecipe(client, 'SV-R-000003');
    expect(d.recipe.locked_price).toBe('');
    expect(d.recipe.notes).toBe('');
    expect(d.recipe.schedule_id).toBe('');
    expect(typeof d.recipe.service_fee).toBe('number');
    expect(d.recipe.created_at).toMatch(ISO_MS);
    expect(d.recipe.updated_at).toMatch(ISO_MS);
    var s = await recipePg.getRecipe(client, 'SV-R-000002');
    expect(s.ingredients[0].quantity).toBe(0.0055);
    expect(typeof s.ingredients[0].quantity).toBe('number');
    expect(Object.keys(s.ingredients[0])).toEqual(
      ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit']
    );
  });

  it('returns ingredients in position order even when ingredient_id order differs', async function () {
    var client = harness.client();
    await seed(client);
    var s = await recipePg.getRecipe(client, 'SV-R-000002');
    expect(s.ingredients.map(function (g) { return g.ingredient_id; })).toEqual(
      ['RI-000150', 'RI-000033', 'RI-000034']
    );
  });

  it('status filter is case-insensitive; total stays unfiltered', async function () {
    var client = harness.client();
    await seed(client);
    var r = await recipePg.listRecipes(client, { status: 'ACTIVE', limit: 0, offset: 0 });
    expect(r.total).toBe(3);
    expect(r.filtered).toBe(2);
    expect(r.recipes.map(function (x) { return x.recipe_id; })).toEqual(['SV-R-000001', 'SV-R-000002']);
  });

  it('paginates: limit 1 offset 1 is the second newest; limit 0 offset 1 skips the newest', async function () {
    var client = harness.client();
    await seed(client);
    var a = await recipePg.listRecipes(client, { status: 'all', limit: 1, offset: 1 });
    expect(a.recipes.map(function (x) { return x.recipe_id; })).toEqual(['SV-R-000001']);
    var b = await recipePg.listRecipes(client, { status: '', limit: 0, offset: 1 });
    expect(b.recipes.map(function (x) { return x.recipe_id; })).toEqual(['SV-R-000001', 'SV-R-000002']);
    expect(b.filtered).toBe(3);
  });

  it('getRecipe of a missing id resolves null; listRecipeIds is ordered', async function () {
    var client = harness.client();
    await seed(client);
    expect(await recipePg.getRecipe(client, 'SV-R-999999')).toBeNull();
    expect(await recipePg.listRecipeIds(client)).toEqual(['SV-R-000001', 'SV-R-000002', 'SV-R-000003']);
  });
});

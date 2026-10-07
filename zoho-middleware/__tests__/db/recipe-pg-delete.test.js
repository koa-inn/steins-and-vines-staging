'use strict';

/**
 * Real-Postgres deleteRecipe semantics — Phase 85 Plan 03 (DB-04, D-03).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('recipe-pg deleteRecipe', function () {
  var container;
  var pool;
  var recipePg;
  var harness;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed: ' + migrateResult.stderr);
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

  async function make(client) {
    var res = await recipePg.createRecipe(client, {
      name: 'D', status: 'active', ingredients: [{ item_id: 'A', quantity: 1 }, { item_id: 'B', quantity: 2 }]
    }, { now: new Date('2026-01-01T00:00:00.000Z') });
    var d = await recipePg.getRecipe(client, res.recipe_id);
    return { id: res.recipe_id, token: d.recipe.updated_at };
  }

  it('soft-deactivates when batches reference it', async function () {
    var client = harness.client();
    var r = await make(client);
    var now = new Date('2026-06-06T06:06:06.666Z');
    var res = await recipePg.deleteRecipe(client, r.id, { expectedUpdatedAt: r.token, batchRefCount: 2, now: now });
    expect(res).toEqual({ ok: true, deactivated: true, message: 'Recipe deactivated (has batch references)', _recipeId: r.id });
    var d = await recipePg.getRecipe(client, r.id);
    expect(d.recipe.status).toBe('inactive');
    expect(d.recipe.updated_at).toBe('2026-06-06T06:06:06.666Z');
    expect(d.ingredients).toHaveLength(2);
  });

  it('hard-deletes recipe and ingredients when unreferenced', async function () {
    var client = harness.client();
    var r = await make(client);
    var res = await recipePg.deleteRecipe(client, r.id, { expectedUpdatedAt: r.token, batchRefCount: 0 });
    expect(res).toEqual({ ok: true, deleted: true, message: 'Recipe deleted', _recipeId: r.id });
    expect(await recipePg.getRecipe(client, r.id)).toBeNull();
    var c = await client.query('select count(*)::int as n from recipe_ingredients where recipe_id = $1', [r.id]);
    expect(c.rows[0].n).toBe(0);
  });

  it('stale or missing token changes nothing', async function () {
    var client = harness.client();
    var r = await make(client);
    var tokens = [undefined, '', 'garbage', '2020-01-01T00:00:00.000Z'];
    for (var i = 0; i < tokens.length; i++) {
      var res = await recipePg.deleteRecipe(client, r.id, { expectedUpdatedAt: tokens[i], batchRefCount: 0 });
      expect(res.error).toBe('stale_recipe');
    }
    var d = await recipePg.getRecipe(client, r.id);
    expect(d.recipe.status).toBe('active');
    expect(d.ingredients).toHaveLength(2);
  });

  it('not_found and missing_id', async function () {
    var client = harness.client();
    expect((await recipePg.deleteRecipe(client, 'SV-R-999999', { expectedUpdatedAt: 'x', batchRefCount: 0 })).error).toBe('not_found');
    expect((await recipePg.deleteRecipe(client, '', { batchRefCount: 0 })).error).toBe('missing_id');
  });

  it('throws (fails closed) when batchRefCount is not a non-negative integer', async function () {
    var client = harness.client();
    var r = await make(client);
    var bad = [undefined, null, NaN, -1, 1.5, '0'];
    for (var i = 0; i < bad.length; i++) {
      await expect(recipePg.deleteRecipe(client, r.id, { expectedUpdatedAt: r.token, batchRefCount: bad[i] }))
        .rejects.toThrow('batchRefCount required');
    }
    expect(await recipePg.getRecipe(client, r.id)).not.toBeNull();
  });
});

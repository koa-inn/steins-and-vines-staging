'use strict';

/**
 * SC4 automated leg: a rename with unchanged ingredients is fast on Postgres.
 * The production stopwatch lives in 85-14. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('recipe rename latency', function () {
  var container;
  var pool;
  var recipePg;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    recipePg = require('../../lib/recipe-pg');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  it('20 renames of a 20-ingredient recipe: p95 < 500 ms, max < 2000 ms', async function () {
    var ingredients = [];
    for (var i = 0; i < 20; i++) {
      ingredients.push({ item_id: 'ITEM' + i, item_name: 'Item ' + i, quantity: i + 1, unit: 'kg' });
    }
    var client = await pool.connect();
    var times = [];
    try {
      await client.query('begin');
      var created = await recipePg.createRecipe(client, { name: 'Lat', ingredients: ingredients }, {});
      await client.query('commit');
      var id = created.recipe_id;
      for (var n = 0; n < 20; n++) {
        var token = (await recipePg.getRecipe(client, id)).recipe.updated_at;
        var t0 = process.hrtime.bigint();
        await client.query('begin');
        var res = await recipePg.updateRecipe(client, { recipe_id: id, name: 'Name ' + n, ingredients: ingredients },
          { expectedUpdatedAt: token, now: new Date(Date.now() + n + 1) });
        await client.query('commit');
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(res.ok).toBe(true);
        expect(res._ingredientsRewritten).toBe(false);
      }
    } finally {
      client.release();
    }
    times.sort(function (a, b) { return a - b; });
    var p50 = times[Math.floor(times.length * 0.5)];
    var p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)];
    var max = times[times.length - 1];
    console.log('rename latency ms: p50=' + p50.toFixed(1) + ' p95=' + p95.toFixed(1) + ' max=' + max.toFixed(1));
    expect(p95).toBeLessThan(500);
    expect(max).toBeLessThan(2000);
  });
});

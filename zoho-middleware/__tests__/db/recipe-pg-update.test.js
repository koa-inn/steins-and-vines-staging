'use strict';

/**
 * Real-Postgres updateRecipe semantics — Phase 85 Plan 03 (DB-04, SC2/SC3, D-03/D-04/D-09).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('recipe-pg updateRecipe', function () {
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

  async function make(client, ingredients, extra) {
    var res = await recipePg.createRecipe(client, Object.assign({
      name: 'Orig', style: 'IPA', notes: 'n', locked_price: 100, ingredients: ingredients || []
    }, extra || {}), { now: new Date('2026-01-01T00:00:00.000Z') });
    var d = await recipePg.getRecipe(client, res.recipe_id);
    return { id: res.recipe_id, token: d.recipe.updated_at };
  }

  async function snapshot(client, id) {
    var r = await client.query('select * from recipes where recipe_id = $1', [id]);
    var i = await client.query('select * from recipe_ingredients where recipe_id = $1 order by position', [id]);
    return JSON.stringify([r.rows, i.rows]);
  }

  it('accepts the exact token and advances updated_at to opts.now', async function () {
    var client = harness.client();
    var r = await make(client);
    var now = new Date('2026-02-02T02:02:02.222Z');
    var res = await recipePg.updateRecipe(client, { recipe_id: r.id, name: 'New' }, { expectedUpdatedAt: r.token, now: now });
    expect(res).toEqual({ ok: true, _recipeId: r.id, _ingredientsRewritten: false });
    var d = await recipePg.getRecipe(client, r.id);
    expect(d.recipe.name).toBe('New');
    expect(d.recipe.updated_at).toBe('2026-02-02T02:02:02.222Z');
  });

  it('rejects off-by-one-ms, missing, empty and garbage tokens without writing', async function () {
    var client = harness.client();
    var r = await make(client, [{ item_id: 'A', quantity: 1, unit: 'kg' }]);
    var before = await snapshot(client, r.id);
    var tokens = [new Date(new Date(r.token).getTime() + 1).toISOString(), undefined, '', 'garbage'];
    for (var i = 0; i < tokens.length; i++) {
      var res = await recipePg.updateRecipe(client,
        { recipe_id: r.id, name: 'X', ingredients: [{ item_id: 'Z', quantity: 9 }] }, { expectedUpdatedAt: tokens[i] });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('stale_recipe');
    }
    expect(await snapshot(client, r.id)).toBe(before);
  });

  it('returns not_found and missing_id', async function () {
    var client = harness.client();
    expect((await recipePg.updateRecipe(client, { recipe_id: 'SV-R-999999' }, { expectedUpdatedAt: 'x' })).error).toBe('not_found');
    expect((await recipePg.updateRecipe(client, {}, {})).error).toBe('missing_id');
  });

  it('touches only provided fields; schedule_id null clears; ignores ingredient_count', async function () {
    var client = harness.client();
    var r = await make(client, [], { schedule_id: 'FS1' });
    await recipePg.updateRecipe(client,
      { recipe_id: r.id, name: 'N2', schedule_id: null, ingredient_count: 5, expected_updated_at: 'zzz' },
      { expectedUpdatedAt: r.token });
    var d = (await recipePg.getRecipe(client, r.id)).recipe;
    expect(d.name).toBe('N2');
    expect(d.style).toBe('IPA');
    expect(d.notes).toBe('n');
    expect(d.locked_price).toBe(100);
    expect(d.schedule_id).toBe('');
    var row = await client.query('select schedule_id from recipes where recipe_id = $1', [r.id]);
    expect(row.rows[0].schedule_id).toBeNull();
  });

  it('rejects invalid status / numerics / ingredients JSON writing nothing', async function () {
    var client = harness.client();
    var r = await make(client, [{ item_id: 'A', quantity: 1 }]);
    var before = await snapshot(client, r.id);
    var bad = [{ status: 'archived' }, { abv: 'abc' }, { ingredients: '{nope' }, { ingredients: [{ item_id: 'A', quantity: 'x' }] }];
    for (var i = 0; i < bad.length; i++) {
      var res = await recipePg.updateRecipe(client, Object.assign({ recipe_id: r.id, name: 'Changed' }, bad[i]), { expectedUpdatedAt: r.token });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('invalid_data');
    }
    expect(await snapshot(client, r.id)).toBe(before);
  });

  it('D-04: unchanged ingredients (and item_name-only change) leave rows untouched', async function () {
    var client = harness.client();
    var r = await make(client, [
      { item_id: 'A', item_name: 'a', quantity: 1, unit: 'kg' },
      { item_id: 'B', item_name: 'b', quantity: 2, unit: 'g' }
    ]);
    var sys = 'select ctid::text as c, xmin::text as x from recipe_ingredients where recipe_id = $1 order by position';
    var before = (await client.query(sys, [r.id])).rows;
    var res = await recipePg.updateRecipe(client, {
      recipe_id: r.id, name: 'R',
      ingredients: [
        { item_id: 'A', item_name: 'a', quantity: 1, unit: 'kg' },
        { item_id: 'B', item_name: 'b', quantity: 2, unit: 'g' }
      ]
    }, { expectedUpdatedAt: r.token });
    expect(res._ingredientsRewritten).toBe(false);
    expect((await client.query(sys, [r.id])).rows).toEqual(before);

    var d1 = await recipePg.getRecipe(client, r.id);
    var res2 = await recipePg.updateRecipe(client, {
      recipe_id: r.id,
      ingredients: [
        { item_id: 'A', item_name: 'RENAMED', quantity: 1, unit: 'kg' },
        { item_id: 'B', item_name: 'b', quantity: 2, unit: 'g' }
      ]
    }, { expectedUpdatedAt: d1.recipe.updated_at, now: new Date('2026-03-03T00:00:00.000Z') });
    expect(res2._ingredientsRewritten).toBe(false);
    expect((await client.query(sys, [r.id])).rows).toEqual(before);
    expect((await recipePg.getRecipe(client, r.id)).ingredients[0].item_name).toBe('a');
  });

  it('D-09: keeps own ids, mints for foreign / duplicate ids, positions follow payload order', async function () {
    var client = harness.client();
    var other = await make(client, [{ item_id: 'X', quantity: 1 }]);
    var otherIng = (await recipePg.getRecipe(client, other.id)).ingredients[0];
    var r = await make(client, [{ item_id: 'A', quantity: 1 }, { item_id: 'B', quantity: 1 }]);
    var own = (await recipePg.getRecipe(client, r.id)).ingredients;
    var res = await recipePg.updateRecipe(client, {
      recipe_id: r.id,
      ingredients: [
        { ingredient_id: own[1].ingredient_id, item_id: 'B', quantity: 5 },
        { ingredient_id: otherIng.ingredient_id, item_id: 'C', quantity: 1 },
        { ingredient_id: own[1].ingredient_id, item_id: 'D', quantity: 1 },
        { item_id: 'E', quantity: 1 }
      ]
    }, { expectedUpdatedAt: r.token });
    expect(res._ingredientsRewritten).toBe(true);
    var after = (await recipePg.getRecipe(client, r.id)).ingredients;
    expect(after.map(function (x) { return x.item_id; })).toEqual(['B', 'C', 'D', 'E']);
    expect(after[0].ingredient_id).toBe(own[1].ingredient_id);
    var ids = after.map(function (x) { return x.ingredient_id; });
    expect(ids.indexOf(otherIng.ingredient_id)).toBe(-1);
    expect(new Set(ids).size).toBe(4);
    var foreign = (await recipePg.getRecipe(client, other.id)).ingredients;
    expect(foreign).toHaveLength(1);
    expect(foreign[0].ingredient_id).toBe(otherIng.ingredient_id);
    var pos = await client.query('select position from recipe_ingredients where recipe_id = $1 order by position', [r.id]);
    expect(pos.rows.map(function (x) { return x.position; })).toEqual([1, 2, 3, 4]);
  });

  it('SV-R-000002 shape: three rows of one item survive unchanged and reordering saves', async function () {
    var client = harness.client();
    var three = [
      { item_id: 'M', quantity: 1, unit: 'kg' },
      { item_id: 'M', quantity: 2, unit: 'kg' },
      { item_id: 'M', quantity: 3, unit: 'kg' }
    ];
    var r = await make(client, three);
    var res = await recipePg.updateRecipe(client, { recipe_id: r.id, ingredients: three }, { expectedUpdatedAt: r.token });
    expect(res._ingredientsRewritten).toBe(false);
    var d = await recipePg.getRecipe(client, r.id);
    var order = [2, 0, 1];
    var reordered = order.map(function (idx) {
      return Object.assign({}, three[idx], { ingredient_id: d.ingredients[idx].ingredient_id });
    });
    var res2 = await recipePg.updateRecipe(client, { recipe_id: r.id, ingredients: reordered },
      { expectedUpdatedAt: d.recipe.updated_at, now: new Date('2026-04-04T00:00:00.000Z') });
    expect(res2._ingredientsRewritten).toBe(true);
    var after = (await recipePg.getRecipe(client, r.id)).ingredients;
    expect(after.map(function (x) { return x.quantity; })).toEqual([3, 1, 2]);
    expect(after.map(function (x) { return x.ingredient_id; })).toEqual(order.map(function (idx) {
      return d.ingredients[idx].ingredient_id;
    }));
  });

  it('is atomic: failing ingredient insert rolls back field changes and the delete', async function () {
    var seed = await pool.connect();
    var r;
    try {
      await seed.query('begin');
      r = await make(seed, [{ item_id: 'A', quantity: 1 }]);
      await seed.query('commit');
    } finally {
      seed.release();
    }
    var raw = await pool.connect();
    try {
      await raw.query('begin');
      var calls = 0;
      var wrapped = {
        query: function (sql, params) {
          if (/insert into recipe_ingredients/.test(sql)) {
            calls++;
            if (calls === 2) return Promise.reject(new Error('injected failure'));
          }
          return raw.query(sql, params);
        }
      };
      var failure = null;
      try {
        await recipePg.updateRecipe(wrapped, {
          recipe_id: r.id, name: 'Changed', ingredients: [{ item_id: 'B', quantity: 1 }, { item_id: 'C', quantity: 2 }]
        }, { expectedUpdatedAt: r.token });
      } catch (err) {
        failure = err;
      }
      expect(failure && failure.message).toBe('injected failure');
      await raw.query('rollback');
    } finally {
      raw.release();
    }
    var d = await recipePg.getRecipe(pool, r.id);
    expect(d.recipe.name).toBe('Orig');
    expect(d.ingredients.map(function (x) { return x.item_id; })).toEqual(['A']);
    await pool.query('delete from recipes where recipe_id = $1', [r.id]);
  });

  it('concurrency: second writer with the same token waits on the lock then gets stale_recipe', async function () {
    var seed = await pool.connect();
    var r;
    try {
      await seed.query('begin');
      r = await make(seed, []);
      await seed.query('commit');
    } finally {
      seed.release();
    }
    var a = await pool.connect();
    var b = await pool.connect();
    try {
      await a.query('begin');
      await b.query('begin');
      var first = await recipePg.updateRecipe(a, { recipe_id: r.id, name: 'A' },
        { expectedUpdatedAt: r.token, now: new Date('2026-05-05T00:00:00.000Z') });
      expect(first.ok).toBe(true);
      var secondP = recipePg.updateRecipe(b, { recipe_id: r.id, name: 'B' },
        { expectedUpdatedAt: r.token, now: new Date('2026-05-06T00:00:00.000Z') });
      var settled = false;
      secondP.then(function () { settled = true; });
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      expect(settled).toBe(false);
      await a.query('commit');
      var second = await secondP;
      expect(second.error).toBe('stale_recipe');
      await b.query('rollback');
    } finally {
      a.release();
      b.release();
    }
    expect((await recipePg.getRecipe(pool, r.id)).recipe.name).toBe('A');
    await pool.query('delete from recipes where recipe_id = $1', [r.id]);
  });
});

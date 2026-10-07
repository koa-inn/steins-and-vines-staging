'use strict';

/**
 * Real-Postgres create semantics + atomicity for lib/recipe-pg.js — Phase 85 Plan 02 (DB-04, SC1/SC2).
 * Runs only via `npm run test:db` (skipped locally without Docker, never on CI).
 *
 * Assumption A5 (explained difference): Sheets would have stored NaN or any status string; Postgres
 * rejects them up front with invalid_data and writes nothing.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describeDb('recipe-pg createRecipe', function () {
  var container;
  var pool;
  var recipePg;
  var harness;

  async function counts(client) {
    var r = await client.query('select count(*)::int as n from recipes');
    var i = await client.query('select count(*)::int as n from recipe_ingredients');
    return { recipes: r.rows[0].n, ingredients: i.rows[0].n };
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

  it('minimal payload gets Apps Script defaults', async function () {
    var client = harness.client();
    var res = await recipePg.createRecipe(client, { name: 'Test' }, {});
    expect(res.ok).toBe(true);
    expect(res.recipe_id).toMatch(/^SV-R-\d{6}$/);
    expect(res.ingredients_created).toBe(0);
    var d = await recipePg.getRecipe(client, res.recipe_id);
    expect(d.recipe.status).toBe('draft');
    expect(d.recipe.service_fee).toBe(45);
    expect(d.recipe.materials_fee).toBe(5);
    expect(d.recipe.pricing_mode).toBe('locked');
    expect(d.recipe.locked_price).toBe('');
    expect(d.recipe.abv).toBe('');
    expect(d.recipe.schedule_id).toBe('');
    expect(d.recipe.created_by).toBe('middleware');
    expect(d.recipe.created_at).toMatch(ISO_MS);
    expect(d.recipe.created_at).toBe(d.recipe.updated_at);
  });

  it('uses the supplied actor and now', async function () {
    var client = harness.client();
    var res = await recipePg.createRecipe(client, { name: 'T' }, {
      actor: 'staff-x', now: new Date('2026-05-05T05:05:05.123Z')
    });
    var d = await recipePg.getRecipe(client, res.recipe_id);
    expect(d.recipe.created_by).toBe('staff-x');
    expect(d.recipe.created_at).toBe('2026-05-05T05:05:05.123Z');
  });

  it('sanitises text fields and ingredient strings, but not status', async function () {
    var client = harness.client();
    var res = await recipePg.createRecipe(client, {
      name: 'N<script>x()</script>ame',
      style: '<iframe src=a>S',
      description: 'javascript:D',
      notes: 'a <style>b</style>c',
      schedule_id: 'FS<script>1</script>',
      status: 'active',
      ingredients: [{ item_id: 'I<script>q</script>1', item_name: 'x onclick="y"z', unit: '<embed>kg', quantity: 2 }]
    }, {});
    var d = await recipePg.getRecipe(client, res.recipe_id);
    expect(d.recipe.name).toBe('Name');
    expect(d.recipe.style).toBe('S');
    expect(d.recipe.description).toBe('D');
    expect(d.recipe.notes).toBe('a c');
    expect(d.recipe.schedule_id).toBe('FS');
    expect(d.recipe.status).toBe('active');
    expect(d.ingredients[0].item_id).toBe('I1');
    expect(d.ingredients[0].item_name).toBe('xz');
    expect(d.ingredients[0].unit).toBe('kg');
  });

  it('keeps dynamic pricing_mode and coerces anything else to locked', async function () {
    var client = harness.client();
    var a = await recipePg.createRecipe(client, { name: 'A', pricing_mode: 'dynamic' }, {});
    var b = await recipePg.createRecipe(client, { name: 'B', pricing_mode: 'weird' }, {});
    expect((await recipePg.getRecipe(client, a.recipe_id)).recipe.pricing_mode).toBe('dynamic');
    expect((await recipePg.getRecipe(client, b.recipe_id)).recipe.pricing_mode).toBe('locked');
  });

  it('mints fresh RI- ids ignoring payload ingredient_id, positions 1..n, quantity default 0', async function () {
    var client = harness.client();
    var res = await recipePg.createRecipe(client, {
      name: 'Dup',
      ingredients: [
        { ingredient_id: 'RI-000999', item_id: 'A', item_name: 'a', quantity: 1.5, unit: 'kg' },
        { ingredient_id: 'RI-000998', item_id: 'A', item_name: 'a', unit: 'kg' },
        { item_id: 'B', item_name: 'b', quantity: 0.0055, unit: 'g' }
      ]
    }, {});
    expect(res.ingredients_created).toBe(3);
    var d = await recipePg.getRecipe(client, res.recipe_id);
    var ids = d.ingredients.map(function (g) { return g.ingredient_id; });
    ids.forEach(function (id) { expect(id).toMatch(/^RI-\d{6}$/); });
    expect(ids).not.toContain('RI-000999');
    expect(ids).not.toContain('RI-000998');
    expect(d.ingredients.map(function (g) { return g.quantity; })).toEqual([1.5, 0, 0.0055]);
    var pos = await client.query(
      'select position from recipe_ingredients where recipe_id = $1 order by position', [res.recipe_id]
    );
    expect(pos.rows.map(function (r) { return r.position; })).toEqual([1, 2, 3]);
  });

  it('parses ingredients given as a JSON string', async function () {
    var client = harness.client();
    var res = await recipePg.createRecipe(client, {
      name: 'J', ingredients: JSON.stringify([{ item_id: 'A', quantity: 2 }])
    }, {});
    expect(res.ingredients_created).toBe(1);
  });

  it('rejects invalid JSON and missing name, writing nothing', async function () {
    var client = harness.client();
    var before = await counts(client);
    var bad = await recipePg.createRecipe(client, { name: 'X', ingredients: '{not json' }, {});
    expect(bad).toEqual({ ok: false, error: 'invalid_data', message: 'Invalid ingredients JSON' });
    var noName = await recipePg.createRecipe(client, { style: 'S' }, {});
    expect(noName).toEqual({ ok: false, error: 'missing_fields', message: 'name is required' });
    expect(await counts(client)).toEqual(before);
  });

  it('rejects non-finite numerics and out-of-set status, writing nothing', async function () {
    var client = harness.client();
    var before = await counts(client);
    var a = await recipePg.createRecipe(client, { name: 'X', abv: 'abc' }, {});
    var b = await recipePg.createRecipe(client, { name: 'X', ingredients: [{ item_id: 'A', quantity: 'x' }] }, {});
    var c = await recipePg.createRecipe(client, { name: 'X', status: 'archived' }, {});
    [a, b, c].forEach(function (r) {
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid_data');
    });
    expect(await counts(client)).toEqual(before);
  });

  it('is atomic: a failing 2nd ingredient insert rolls back the recipe and the 1st ingredient', async function () {
    var raw = await pool.connect();
    var before = await counts(pool);
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
        await recipePg.createRecipe(wrapped, {
          name: 'Atomic',
          ingredients: [{ item_id: 'A', quantity: 1 }, { item_id: 'B', quantity: 2 }]
        }, {});
      } catch (err) {
        failure = err;
      }
      expect(failure).not.toBeNull();
      expect(failure.message).toBe('injected failure');
      await raw.query('rollback');
    } finally {
      raw.release();
    }
    expect(await counts(pool)).toEqual(before);
  });
});

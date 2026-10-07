'use strict';

/**
 * Real-Postgres schema invariants for migrations/0003_recipes.sql — Phase 85 Plan 01 (DB-04, ROADMAP SC1).
 *
 * Runs ONLY via `npm run test:db`, gated by describeDb() (skipped locally without Docker).
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('0003_recipes migration (ROADMAP SC1)', function () {
  var container;
  var pool;
  var harness;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }
    var pg = require('pg');
    pool = new pg.Pool({ connectionString: started.connectionString });
  }, 120000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  // Runs fn inside a savepoint so a failed statement does not abort the test transaction.
  async function expectFails(c, fn, pattern) {
    await c.query('savepoint sp');
    var failed = false;
    try {
      await fn();
    } catch (e) {
      failed = true;
      if (pattern) expect(e.message).toMatch(pattern);
    }
    await c.query('rollback to savepoint sp');
    expect(failed).toBe(true);
  }

  function insertRecipe(client, id, extra) {
    var cols = ['name', 'status', 'created_at', 'updated_at'];
    var vals = ["'Test'", "'draft'", 'now()', 'now()'];
    if (id) { cols.unshift('recipe_id'); vals.unshift("'" + id + "'"); }
    if (extra) { cols.push(extra.col); vals.push(extra.val); }
    return client.query('insert into recipes (' + cols.join(', ') + ') values (' + vals.join(', ') + ') returning *');
  }

  function insertIng(client, recipeId, position, id, qty) {
    var cols = ['recipe_id', 'position', 'item_id'];
    var vals = ["'" + recipeId + "'", String(position), "'ITEM-1'"];
    if (id) { cols.unshift('ingredient_id'); vals.unshift("'" + id + "'"); }
    if (qty !== undefined) { cols.push('quantity'); vals.push(qty); }
    return client.query('insert into recipe_ingredients (' + cols.join(', ') + ') values (' + vals.join(', ') + ') returning *');
  }

  it('creates both tables and both sequences', async function () {
    var c = harness.client();
    var t = await c.query("select table_name from information_schema.tables where table_name in ('recipes','recipe_ingredients')");
    expect(t.rows.length).toBe(2);
    var s = await c.query("select sequence_name from information_schema.sequences where sequence_name in ('recipe_id_seq','recipe_ingredient_id_seq')");
    expect(s.rows.length).toBe(2);
  });

  it('mints SV-R- and RI- ids from sequences', async function () {
    var c = harness.client();
    var r = await insertRecipe(c, null);
    expect(r.rows[0].recipe_id).toMatch(/^SV-R-\d{6}$/);
    var i = await insertIng(c, r.rows[0].recipe_id, 1, null);
    expect(i.rows[0].ingredient_id).toMatch(/^RI-\d{6}$/);
  });

  it('accepts explicit ids (backfill path)', async function () {
    var c = harness.client();
    var r = await insertRecipe(c, 'SV-R-000002');
    expect(r.rows[0].recipe_id).toBe('SV-R-000002');
    var i = await insertIng(c, 'SV-R-000002', 1, 'RI-000033');
    expect(i.rows[0].ingredient_id).toBe('RI-000033');
  });

  it('rejects malformed ids by CHECK', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertRecipe(c, 'SV-R-12'); });
    await expectFails(c, function () { return insertRecipe(c, 'X-1'); });
    await insertRecipe(c, 'SV-R-000010');
    await expectFails(c, function () { return insertIng(c, 'SV-R-000010', 1, 'RI-1'); });
  });

  it('allows three same-item rows on one recipe (no unique recipe_id,item_id)', async function () {
    var c = harness.client();
    await insertRecipe(c, 'SV-R-000002');
    await insertIng(c, 'SV-R-000002', 1, null);
    await insertIng(c, 'SV-R-000002', 2, null);
    await insertIng(c, 'SV-R-000002', 3, null);
    var n = await c.query("select count(*)::int as n from recipe_ingredients where recipe_id = 'SV-R-000002' and item_id = 'ITEM-1'");
    expect(n.rows[0].n).toBe(3);
  });

  it('rejects duplicate (recipe_id, position)', async function () {
    var c = harness.client();
    await insertRecipe(c, 'SV-R-000003');
    await insertIng(c, 'SV-R-000003', 1, null);
    await expectFails(c, function () { return insertIng(c, 'SV-R-000003', 1, null); }, /unique|duplicate/i);
  });

  it('enforces FK and cascades delete', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertIng(c, 'SV-R-999999', 1, null); }, /foreign key/i);
    await insertRecipe(c, 'SV-R-000004');
    await insertIng(c, 'SV-R-000004', 1, null);
    await c.query("delete from recipes where recipe_id = 'SV-R-000004'");
    var n = await c.query("select count(*)::int as n from recipe_ingredients where recipe_id = 'SV-R-000004'");
    expect(n.rows[0].n).toBe(0);
  });

  it('constrains status and pricing_mode', async function () {
    var c = harness.client();
    await expectFails(c, function () {
      return c.query("insert into recipes (name, status, created_at, updated_at) values ('x','archived',now(),now())");
    });
    var r = await insertRecipe(c, null);
    expect(r.rows[0].pricing_mode).toBe('locked');
    await expectFails(c, function () { return insertRecipe(c, null, { col: 'pricing_mode', val: "'other'" }); });
  });

  it('round-trips 4-dp quantity without rounding', async function () {
    var c = harness.client();
    await insertRecipe(c, 'SV-R-000005');
    var i = await insertIng(c, 'SV-R-000005', 1, null, '0.0055');
    expect(String(i.rows[0].quantity)).toBe('0.0055');
  });
});

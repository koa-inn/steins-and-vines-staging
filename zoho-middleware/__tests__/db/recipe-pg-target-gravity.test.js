'use strict';

/**
 * Real-Postgres target_og / target_fg semantics for lib/recipe-pg.js — Phase 97 Plan 01 (D-06).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('recipe-pg target gravity', function () {
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

  async function make(client, extra) {
    var res = await recipePg.createRecipe(client, Object.assign({ name: 'Orig', notes: 'n' }, extra || {}),
      { now: new Date('2026-01-01T00:00:00.000Z') });
    var d = res.ok ? await recipePg.getRecipe(client, res.recipe_id) : null;
    return { id: res.recipe_id, token: d && d.recipe.updated_at, res: res };
  }

  async function counts(client) {
    var r = await client.query('select count(*)::int as n from recipes');
    return r.rows[0].n;
  }

  it('migration 0009 adds nullable numeric target_og and target_fg', async function () {
    var client = harness.client();
    var r = await client.query(
      "select column_name, data_type, is_nullable from information_schema.columns " +
      "where table_name = 'recipes' and column_name in ('target_og','target_fg') order by column_name");
    expect(r.rows).toEqual([
      { column_name: 'target_fg', data_type: 'numeric', is_nullable: 'YES' },
      { column_name: 'target_og', data_type: 'numeric', is_nullable: 'YES' }
    ]);
  });

  it('create stores values and read returns numbers', async function () {
    var client = harness.client();
    var m = await make(client, { target_og: 12.0, target_fg: 3.5 });
    expect(m.res.ok).toBe(true);
    var rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe(12);
    expect(rec.target_fg).toBe(3.5);
  });

  it('create without the keys reads back empty strings', async function () {
    var client = harness.client();
    var m = await make(client);
    var rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe('');
    expect(rec.target_fg).toBe('');
  });

  it('update clears, sets and leaves untouched', async function () {
    var client = harness.client();
    var m = await make(client, { target_og: 12, target_fg: 3 });
    var res = await recipePg.updateRecipe(client, { recipe_id: m.id, notes: 'x' }, { expectedUpdatedAt: m.token });
    expect(res.ok).toBe(true);
    var rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe(12);
    res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_og: 13 }, { expectedUpdatedAt: rec.updated_at });
    expect(res.ok).toBe(true);
    rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe(13);
    res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_og: '' }, { expectedUpdatedAt: rec.updated_at });
    expect(res.ok).toBe(true);
    rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe('');
    expect(rec.target_fg).toBe(3);
  });

  // WR-02: the fg < og rule must hold against the stored value when only one key is sent.
  it('partial update is checked against the stored partner value', async function () {
    var client = harness.client();
    var m = await make(client, { target_og: 10, target_fg: 3 });
    var res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_fg: 20 }, { expectedUpdatedAt: m.token });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_data');
    var rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_fg).toBe(3);

    res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_og: 2.5 }, { expectedUpdatedAt: rec.updated_at });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_data');
    rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_og).toBe(10);

    res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_fg: 4 }, { expectedUpdatedAt: rec.updated_at });
    expect(res.ok).toBe(true);
    rec = (await recipePg.getRecipe(client, m.id)).recipe;
    expect(rec.target_fg).toBe(4);
  });

  it('rejects out-of-range values and writes nothing', async function () {
    var client = harness.client();
    var before = await counts(client);
    var res = await recipePg.createRecipe(client, { name: 'X', target_og: 41 }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_data');
    expect(await counts(client)).toBe(before);

    var m = await make(client, { target_og: 12 });
    res = await recipePg.updateRecipe(client, { recipe_id: m.id, target_og: 41 }, { expectedUpdatedAt: m.token });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_data');
    expect((await recipePg.getRecipe(client, m.id)).recipe.target_og).toBe(12);
  });
});

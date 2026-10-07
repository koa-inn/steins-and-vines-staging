'use strict';

/**
 * Real-Postgres update / archive / delete semantics for lib/ferm-schedule-pg.js —
 * Phase 86 Plan 06 (DB-05, SC4; D-15 reference-guarded delete, D-16 stale guard).
 * Runs only via `npm run test:db` (skipped locally without Docker).
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var STEPS = [
  { step_number: 1, title: 'Pitch', day_offset: 0, is_packaging: false },
  { step_number: 2, title: 'Package', day_offset: 14, is_packaging: true }
];
var T0 = new Date('2026-05-05T05:05:05.123Z');
var T1 = new Date('2026-05-06T06:06:06.456Z');

describeDb('ferm-schedule-pg update / archive / delete', function () {
  var container;
  var pool;
  var pg;
  var harness;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    pg = require('../../lib/ferm-schedule-pg');
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
    var res = await pg.createSchedule(client, {
      name: 'Base', description: 'd', category: 'Beer', steps: STEPS
    }, { actor: 'creator@x.ca', now: T0 });
    return { id: res.schedule_id, token: T0.toISOString() };
  }

  it('update changes only provided fields and bumps updated_at', async function () {
    var client = harness.client();
    var s = await make(client);
    var res = await pg.updateSchedule(client, s.id, { name: 'Renamed' },
      { actor: 'editor@x.ca', now: T1, expectedUpdatedAt: s.token });
    expect(res.ok).toBe(true);
    expect(res._scheduleId).toBe(s.id);
    var got = await pg.getSchedule(client, s.id);
    expect(got.name).toBe('Renamed');
    expect(got.category).toBe('Beer');
    expect(got.steps_parsed).toEqual(STEPS);
    expect(got.last_updated).toBe(T1.toISOString());
    var row = (await client.query('select updated_by, created_by from ferm_schedules where schedule_id = $1', [s.id])).rows[0];
    expect(row.updated_by).toBe('editor@x.ca');
    expect(row.created_by).toBe('creator@x.ca');
  });

  it('update validates and stores steps given as a JSON string', async function () {
    var client = harness.client();
    var s = await make(client);
    var next = [STEPS[0], { step_number: 2, title: 'Dry hop', day_offset: 5 }, { step_number: 3, title: 'Pkg', day_offset: 9, is_packaging: true }];
    var res = await pg.updateSchedule(client, s.id, { steps: JSON.stringify(next) },
      { now: T1, expectedUpdatedAt: s.token });
    expect(res.ok).toBe(true);
    expect((await pg.getSchedule(client, s.id)).steps_parsed).toEqual(next);
  });

  it('update with invalid steps returns the steps error and changes nothing', async function () {
    var client = harness.client();
    var s = await make(client);
    var res = await pg.updateSchedule(client, s.id, { name: 'X', steps: [STEPS[0]] },
      { now: T1, expectedUpdatedAt: s.token });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('too_few_steps');
    var got = await pg.getSchedule(client, s.id);
    expect(got.name).toBe('Base');
    expect(got.last_updated).toBe(T0.toISOString());
  });

  it('missing or mismatched token -> stale_schedule, no write; unknown id -> not_found', async function () {
    var client = harness.client();
    var s = await make(client);
    var none = await pg.updateSchedule(client, s.id, { name: 'X' }, { now: T1 });
    expect(none.error).toBe('stale_schedule');
    var wrong = await pg.updateSchedule(client, s.id, { name: 'X' }, { now: T1, expectedUpdatedAt: T1.toISOString() });
    expect(wrong.error).toBe('stale_schedule');
    expect((await pg.getSchedule(client, s.id)).name).toBe('Base');
    var nf = await pg.updateSchedule(client, 'FS-9999', { name: 'X' }, { expectedUpdatedAt: s.token });
    expect(nf.error).toBe('not_found');
  });

  it('concurrency: second writer with the same token waits on the lock then gets stale_schedule', async function () {
    var seed = await pool.connect();
    var s;
    try {
      await seed.query('begin');
      s = await make(seed);
      await seed.query('commit');
    } finally {
      seed.release();
    }
    var a = await pool.connect();
    var b = await pool.connect();
    try {
      await a.query('begin');
      await b.query('begin');
      var first = await pg.updateSchedule(a, s.id, { name: 'A' }, { expectedUpdatedAt: s.token, now: T1 });
      expect(first.ok).toBe(true);
      var secondP = pg.updateSchedule(b, s.id, { name: 'B' },
        { expectedUpdatedAt: s.token, now: new Date('2026-05-07T00:00:00.000Z') });
      var settled = false;
      secondP.then(function () { settled = true; });
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      expect(settled).toBe(false);
      await a.query('commit');
      var second = await secondP;
      expect(second.error).toBe('stale_schedule');
      await b.query('rollback');
    } finally {
      a.release();
      b.release();
    }
    var final = await pool.query('select name from ferm_schedules where schedule_id = $1', [s.id]);
    expect(final.rows[0].name).toBe('A');
    await pool.query('delete from ferm_schedules where schedule_id = $1', [s.id]);
  });

  it('archive sets is_active=false: hidden from list, still readable', async function () {
    var client = harness.client();
    var s = await make(client);
    var res = await pg.archiveSchedule(client, s.id, { actor: 'a@x.ca', now: T1, expectedUpdatedAt: s.token });
    expect(res.ok).toBe(true);
    var ids = (await pg.listSchedules(client)).map(function (x) { return x.schedule_id; });
    expect(ids).not.toContain(s.id);
    var got = await pg.getSchedule(client, s.id);
    expect(got.is_active).toBe(false);
    expect(got.last_updated).toBe(T1.toISOString());
    expect((await pg.archiveSchedule(client, s.id, { expectedUpdatedAt: s.token })).error).toBe('stale_schedule');
    expect((await pg.archiveSchedule(client, 'FS-9999', { expectedUpdatedAt: s.token })).error).toBe('not_found');
  });

  it('delete with references -> schedule_in_use naming both counts, row unchanged', async function () {
    var client = harness.client();
    var s = await make(client);
    var r1 = await pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: 1, batchRefCount: 0 });
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('schedule_in_use');
    expect(r1.recipe_refs).toBe(1);
    expect(r1.batch_refs).toBe(0);
    var r2 = await pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: 0, batchRefCount: 2 });
    expect(r2.error).toBe('schedule_in_use');
    expect(r2.message).toBe('This schedule is used by 0 recipe(s) and 2 batch(es). Archive it instead.');
    expect(await pg.getSchedule(client, s.id)).not.toBeNull();
  });

  it('delete with 0/0 and correct token removes the row; stale token does not', async function () {
    var client = harness.client();
    var s = await make(client);
    var stale = await pg.deleteSchedule(client, s.id, { expectedUpdatedAt: T1.toISOString(), recipeRefCount: 0, batchRefCount: 0 });
    expect(stale.error).toBe('stale_schedule');
    expect(await pg.getSchedule(client, s.id)).not.toBeNull();
    var res = await pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: 0, batchRefCount: 0 });
    expect(res.ok).toBe(true);
    expect(res._deleted).toBe(true);
    expect(await pg.getSchedule(client, s.id)).toBeNull();
    var nf = await pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: 0, batchRefCount: 0 });
    expect(nf.error).toBe('not_found');
  });

  it('delete without both counts throws', async function () {
    var client = harness.client();
    var s = await make(client);
    await expect(pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token })).rejects.toThrow('recipeRefCount and batchRefCount required');
    await expect(pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: 0 })).rejects.toThrow();
    await expect(pg.deleteSchedule(client, s.id, { expectedUpdatedAt: s.token, recipeRefCount: -1, batchRefCount: 0 })).rejects.toThrow();
  });
});

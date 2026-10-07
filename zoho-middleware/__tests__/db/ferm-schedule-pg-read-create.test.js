'use strict';

/**
 * Real-Postgres read + create semantics for lib/ferm-schedule-pg.js — Phase 86 Plan 06 (DB-05, SC4).
 * Runs only via `npm run test:db` (skipped locally without Docker).
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

var STEPS = [
  { step_number: 1, title: 'Pitch', day_offset: 0, is_packaging: false },
  { step_number: 2, title: 'Package', day_offset: 14, is_packaging: true }
];

describeDb('ferm-schedule-pg read + create', function () {
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

  it('mints the next sequence id after setval', async function () {
    var client = harness.client();
    await client.query("select setval('ferm_schedule_id_seq', 11)");
    var res = await pg.createSchedule(client, { name: 'Ale', steps: STEPS }, { actor: 'a@x.ca' });
    expect(res.ok).toBe(true);
    expect(res.schedule_id).toBe('FS-0012');
    expect(res._scheduleId).toBe('FS-0012');
  });

  it('rejects invalid input without writing', async function () {
    var client = harness.client();
    expect((await pg.createSchedule(client, { steps: STEPS }, {})).error).toBe('missing_fields');
    expect((await pg.createSchedule(client, { name: 'x' }, {})).error).toBe('missing_fields');
    expect((await pg.createSchedule(client, { name: 'x', steps: [STEPS[0]] }, {})).error).toBe('too_few_steps');
    var noPkg = [STEPS[0], { step_number: 2, title: 'B', day_offset: 3 }];
    expect((await pg.createSchedule(client, { name: 'x', steps: noPkg }, {})).error).toBe('no_packaging_step');
    expect((await pg.createSchedule(client, { name: 'x', steps: { a: 1 } }, {})).error).toBe('invalid_steps');
    var n = await client.query('select count(*)::int as n from ferm_schedules');
    expect(n.rows[0].n).toBe(0);
  });

  it('sanitises text and records the actor', async function () {
    var client = harness.client();
    var res = await pg.createSchedule(client, {
      name: '<script>x</script>Ale', description: 'javascript:d', category: 'Beer', steps: STEPS
    }, { actor: 'staff@x.ca', now: new Date('2026-05-05T05:05:05.123Z') });
    var s = await pg.getSchedule(client, res.schedule_id);
    expect(s.name).toBe('Ale');
    expect(s.name).not.toMatch(/script/);
    expect(s.created_by).toBe('staff@x.ca');
    expect(s.is_active).toBe(true);
    var row = (await client.query('select updated_by from ferm_schedules where schedule_id = $1', [res.schedule_id])).rows[0];
    expect(row.updated_by).toBe('staff@x.ca');
    expect(s.created_at).toBe('2026-05-05T05:05:05.123Z');
    expect(s.last_updated).toBe('2026-05-05T05:05:05.123Z');
  });

  it('reads in the Apps Script shape; steps round-trip', async function () {
    var client = harness.client();
    var res = await pg.createSchedule(client, { name: 'Lager', steps: JSON.stringify(STEPS) }, { actor: 'a@x.ca' });
    var s = await pg.getSchedule(client, res.schedule_id);
    expect(Object.keys(s)).toEqual([
      'schedule_id', 'name', 'description', 'category', 'steps', 'is_active',
      'created_at', 'created_by', 'last_updated', 'steps_parsed'
    ]);
    expect(typeof s.steps).toBe('string');
    expect(JSON.parse(s.steps)).toEqual(STEPS);
    expect(s.steps_parsed).toEqual(STEPS);
    expect(s.description).toBe('');
    expect(s.created_at).toMatch(ISO_MS);
    expect(s.last_updated).toMatch(ISO_MS);
    expect(await pg.getSchedule(client, 'FS-9999')).toBeNull();
  });

  it('listSchedules excludes archived unless includeArchived', async function () {
    var client = harness.client();
    var a = await pg.createSchedule(client, { name: 'A', steps: STEPS }, {});
    var b = await pg.createSchedule(client, { name: 'B', steps: STEPS }, {});
    await client.query('update ferm_schedules set is_active = false where schedule_id = $1', [b.schedule_id]);
    var active = (await pg.listSchedules(client)).map(function (s) { return s.schedule_id; });
    expect(active).toContain(a.schedule_id);
    expect(active).not.toContain(b.schedule_id);
    var all = (await pg.listSchedules(client, { includeArchived: true })).map(function (s) { return s.schedule_id; });
    expect(all).toContain(b.schedule_id);
  });

  it('countRecipeReferences counts recipes pointing at the schedule', async function () {
    var client = harness.client();
    var a = await pg.createSchedule(client, { name: 'A', steps: STEPS }, {});
    expect(await pg.countRecipeReferences(client, a.schedule_id)).toBe(0);
  });

  it('concurrency: parallel creates on separate clients get distinct sequence ids', async function () {
    var a = await pool.connect();
    var b = await pool.connect();
    var ids = [];
    try {
      await a.query('begin');
      await b.query('begin');
      var results = await Promise.all([
        pg.createSchedule(a, { name: 'P1', steps: STEPS }, {}),
        pg.createSchedule(b, { name: 'P2', steps: STEPS }, {})
      ]);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
      ids = [results[0].schedule_id, results[1].schedule_id];
      expect(ids[0]).not.toBe(ids[1]);
      await a.query('commit');
      await b.query('commit');
    } finally {
      a.release();
      b.release();
    }
    await pool.query('delete from ferm_schedules where schedule_id = any($1)', [ids]);
  });
});

'use strict';

/**
 * Real-Postgres Plato readings + propagateSchedule — Phase 87 Plan 09 (DB-06, D-14).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var T0 = new Date('2026-10-01T10:00:00.000Z');
var NOW = new Date('2026-10-09T18:00:00.000Z');
var OPTS = { actor: 'staff@example.com', now: NOW };

describeDb('batch-pg-tasks: readings and propagate', function () {
  var container;
  var pool;
  var tasks;
  var harness;
  var seq = 0;

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    tasks = require('../../lib/batch-pg-tasks');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () {
    return pool;
  });

  function client() { return harness.client(); }

  async function addSchedule(id) {
    await client().query(
      'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) ' +
      'values ($1, $2, $3::jsonb, $4, $4)',
      [id, 'Sched ' + id, '[]', T0]
    );
  }

  async function addBatch(o) {
    o = o || {};
    seq += 1;
    var id = 'SV-B-6' + String(seq).padStart(5, '0');
    await client().query(
      'insert into batches (batch_id, status, schedule_id, start_date, access_token, created_at, last_updated, ' +
      'schedule_snapshot) values ($1, $2, $3, $4, $5, $6, $6, $7)',
      [id, o.status || 'primary', o.schedule_id || null, '2026-10-01', String(seq).padStart(32, 'e'), T0,
        o.snapshot || '']
    );
    return id;
  }

  async function addTask(batchId, step, o) {
    o = o || {};
    var res = await client().query(
      'insert into batch_tasks (batch_id, step_number, title, day_offset, is_packaging, is_transfer, ' +
      'completed, completed_at, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning task_id',
      [batchId, step, o.title || ('Old ' + step), o.day_offset === undefined ? 1 : o.day_offset,
        !!o.is_packaging, !!o.is_transfer, !!o.completed, o.completed ? T0 : null, T0]
    );
    return res.rows[0].task_id;
  }

  async function tasksOf(batchId) {
    return (await client().query(
      "select task_id, step_number, title, day_offset, to_char(due_date, 'YYYY-MM-DD') as due, " +
      'is_packaging, completed from batch_tasks where batch_id = $1 order by step_number, task_id',
      [batchId]
    )).rows;
  }

  async function readings(batchId) {
    return (await client().query(
      'select * from plato_readings where batch_id = $1 order by reading_id', [batchId]
    )).rows;
  }

  describe('addPlatoReading', function () {
    it('stores a dated reading with PR- id and recorded_by', async function () {
      var b = await addBatch();
      var res = await tasks.addPlatoReading(client(), {
        batch_id: b, degrees_plato: 12.5, timestamp: '2026-10-05', notes: 'n'
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.reading_id).toMatch(/^PR-\d{6}$/);
      var r = (await readings(b))[0];
      expect(Number(r.degrees_plato)).toBe(12.5);
      expect(r.reading_at.toISOString()).toBe('2026-10-05T00:00:00.000Z');
      expect(r.recorded_by).toBe('staff@example.com');
      expect(r.created_at.getTime()).toBe(NOW.getTime());
    });

    it('defaults the reading time to now when no timestamp is given', async function () {
      var b = await addBatch();
      await tasks.addPlatoReading(client(), { batch_id: b, ph: 4.2 }, OPTS);
      expect((await readings(b))[0].reading_at.getTime()).toBe(NOW.getTime());
    });

    it('validates input', async function () {
      var b = await addBatch();
      expect((await tasks.addPlatoReading(client(), {}, OPTS)).error).toBe('missing_id');
      expect((await tasks.addPlatoReading(client(), { batch_id: b, degrees_plato: 'x' }, OPTS)).error)
        .toBe('invalid_value');
      expect((await tasks.addPlatoReading(client(), { batch_id: b, degrees_plato: 41 }, OPTS)).error)
        .toBe('invalid_value');
      expect((await tasks.addPlatoReading(client(), { batch_id: b, ph: 14.5 }, OPTS)).error)
        .toBe('invalid_value');
      expect((await tasks.addPlatoReading(client(), { batch_id: b, temperature: 'hot', ph: 4 }, OPTS)).error)
        .toBe('invalid_value');
      expect((await tasks.addPlatoReading(client(), { batch_id: b }, OPTS)).error).toBe('invalid_input');
      expect((await tasks.addPlatoReading(client(), {
        batch_id: b, degrees_plato: 5, timestamp: '10/05/2026'
      }, OPTS)).error).toBe('invalid_value');
      expect(await readings(b)).toHaveLength(0);
    });

    it('returns not_found for a missing batch instead of an FK error', async function () {
      var res = await tasks.addPlatoReading(client(), { batch_id: 'SV-B-999999', degrees_plato: 5 }, OPTS);
      expect(res.error).toBe('not_found');
    });

    it('public path refuses another batch and records batch-url', async function () {
      var mine = await addBatch();
      var theirs = await addBatch();
      var denied = await tasks.addPlatoReading(client(), { batch_id: theirs, degrees_plato: 5 },
        { now: NOW, publicBatchId: mine });
      expect(denied.error).toBe('unauthorized');
      await tasks.addPlatoReading(client(), { batch_id: mine, degrees_plato: 5 },
        { now: NOW, publicBatchId: mine });
      expect((await readings(mine))[0].recorded_by).toBe('batch-url');
    });
  });

  describe('bulkAddPlatoReadings', function () {
    it('guards the array and caps at 20', async function () {
      var b = await addBatch();
      expect((await tasks.bulkAddPlatoReadings(client(), {}, OPTS)).error).toBe('missing_id');
      expect((await tasks.bulkAddPlatoReadings(client(), { batch_id: b }, OPTS)).error).toBe('invalid_input');
      var big = [];
      for (var i = 0; i < 21; i++) big.push({ degrees_plato: 5 });
      expect((await tasks.bulkAddPlatoReadings(client(), { batch_id: b, readings: big }, OPTS)).error)
        .toBe('too_many');
    });

    it('returns per-item results', async function () {
      var b = await addBatch();
      var res = await tasks.bulkAddPlatoReadings(client(), {
        batch_id: b, readings: [{ degrees_plato: 10 }, { degrees_plato: 99 }, { ph: 4 }]
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.results.map(function (r) { return r.ok; })).toEqual([true, false, true]);
      expect(await readings(b)).toHaveLength(2);
    });
  });

  describe('updatePlatoReading / deletePlatoReading', function () {
    async function oneReading(b) {
      var res = await tasks.addPlatoReading(client(), {
        batch_id: b, degrees_plato: 10, temperature: 20, ph: 4, notes: 'a'
      }, OPTS);
      return res.reading_id;
    }

    it('touches only the whitelisted fields', async function () {
      var b = await addBatch();
      var id = await oneReading(b);
      var res = await tasks.updatePlatoReading(client(), {
        reading_id: id,
        updates: { degrees_plato: 8, ph: '', notes: 'b', timestamp: '2026-10-06', batch_id: 'SV-B-000001', recorded_by: 'evil' }
      }, OPTS);
      expect(res.ok).toBe(true);
      var r = (await readings(b))[0];
      expect(Number(r.degrees_plato)).toBe(8);
      expect(r.ph).toBeNull();
      expect(Number(r.temperature)).toBe(20);
      expect(r.notes).toBe('b');
      expect(r.reading_at.toISOString()).toBe('2026-10-06T00:00:00.000Z');
      expect(r.batch_id).toBe(b);
      expect(r.recorded_by).toBe('staff@example.com');
    });

    it('unknown reading is not_found; bad value is rejected', async function () {
      expect((await tasks.updatePlatoReading(client(), { reading_id: 'PR-999999', updates: {} }, OPTS)).error)
        .toBe('not_found');
      var b = await addBatch();
      var id = await oneReading(b);
      expect((await tasks.updatePlatoReading(client(), { reading_id: id, updates: { ph: 20 } }, OPTS)).error)
        .toBe('invalid_value');
    });

    it('delete removes the row; another batch token is unauthorized', async function () {
      var mine = await addBatch();
      var theirs = await addBatch();
      var id = await oneReading(theirs);
      var denied = await tasks.deletePlatoReading(client(), { reading_id: id }, { now: NOW, publicBatchId: mine });
      expect(denied.error).toBe('unauthorized');
      expect(await readings(theirs)).toHaveLength(1);
      expect((await tasks.deletePlatoReading(client(), { reading_id: id }, OPTS)).ok).toBe(true);
      expect(await readings(theirs)).toHaveLength(0);
      expect((await tasks.deletePlatoReading(client(), { reading_id: id }, OPTS)).error).toBe('not_found');
    });
  });

  describe('propagateSchedule', function () {
    var STEPS = [
      { step_number: 1, title: 'Pitch', description: 'd', day_offset: 0 },
      { step_number: 2, title: 'Rack', day_offset: 7, is_transfer: true },
      { step_number: 3, title: 'New step', day_offset: 10 },
      { step_number: 4, title: 'Bottle', day_offset: 14, is_packaging: true }
    ];

    it('guards its input', async function () {
      expect((await tasks.propagateSchedule(client(), '', STEPS, OPTS)).error).toBe('missing_fields');
      expect((await tasks.propagateSchedule(client(), 'FS-0001', '{bad', OPTS)).error).toBe('invalid_data');
      expect((await tasks.propagateSchedule(client(), 'FS-0001', [{ title: 'x' }], OPTS)).error)
        .toBe('invalid_data');
    });

    it('returns zero counts when no active batch uses the schedule', async function () {
      await addSchedule('FS-0099');
      var res = await tasks.propagateSchedule(client(), 'FS-0099', STEPS, OPTS);
      expect(res).toMatchObject({
        ok: true, batches_updated: 0, tasks_updated: 0, tasks_created: 0, tasks_removed: 0, batches_failed: []
      });
    });

    it('updates, inserts and removes per the Apps Script rules; skips complete batches', async function () {
      await addSchedule('FS-0001');
      var batches = [];
      for (var i = 0; i < 3; i++) batches.push(await addBatch({ schedule_id: 'FS-0001', snapshot: 'SNAP' }));
      var done = await addBatch({ schedule_id: 'FS-0001', status: 'complete' });
      var doneTask = await addTask(done, 1, { title: 'Untouched' });

      // Batch 0: step 1 done (history), step 2 pending (updated), packaging pending at old number 9,
      // step 8 pending but not in template (removed). Step 3 is missing (inserted).
      var done1 = await addTask(batches[0], 1, { title: 'Done pitch', completed: true });
      var step2 = await addTask(batches[0], 2, { title: 'Old rack' });
      var pack = await addTask(batches[0], 9, { title: 'Old pack', is_packaging: true });
      var stale = await addTask(batches[0], 8, { title: 'Stale' });
      await addTask(batches[1], 1);
      await addTask(batches[2], 4, { title: 'P', is_packaging: true, completed: true });

      var res = await tasks.propagateSchedule(client(), 'FS-0001', STEPS, OPTS);
      expect(res.ok).toBe(true);
      expect(res.batches_updated).toBe(3);
      expect(res.batches_failed).toEqual([]);
      expect(res._batchIds).toEqual(batches);

      var t0 = await tasksOf(batches[0]);
      var byId = {};
      t0.forEach(function (t) { byId[t.task_id] = t; });
      expect(byId[done1].title).toBe('Done pitch');
      expect(byId[step2]).toMatchObject({ title: 'Rack', day_offset: 7, due: '2026-10-08', step_number: 2 });
      expect(byId[pack]).toMatchObject({ title: 'Bottle', step_number: 4, due: '2026-10-15', is_packaging: true });
      expect(byId[stale]).toBeUndefined();
      expect(t0.some(function (t) { return t.title === 'New step' && !t.completed; })).toBe(true);

      // Batch 2: only a completed packaging task: completed untouched, other 3 steps inserted
      var t2 = await tasksOf(batches[2]);
      expect(t2.filter(function (t) { return t.is_packaging; })).toHaveLength(1);
      expect(t2.filter(function (t) { return t.is_packaging; })[0].title).toBe('P');

      expect((await tasksOf(done))[0]).toMatchObject({ task_id: doneTask, title: 'Untouched' });

      // b0: updated 2 (step 2, packaging), created 1, removed 1; b1: updated 1, created 3;
      // b2: created 3 (completed packaging matched, left alone).
      var total = 0;
      for (var k = 0; k < batches.length; k++) total += (await tasksOf(batches[k])).length;
      expect(total).toBe(12);
      expect(res.tasks_removed).toBe(1);
      expect(res.tasks_updated).toBe(3);
      expect(res.tasks_created).toBe(7);

      var snaps = (await client().query(
        'select schedule_snapshot from batches where batch_id = any($1)', [batches]
      )).rows;
      snaps.forEach(function (s) { expect(s.schedule_snapshot).toBe('SNAP'); });
    });

    it('isolates a failing batch with a savepoint and reports only its id', async function () {
      await addSchedule('FS-0002');
      var good = await addBatch({ schedule_id: 'FS-0002' });
      var bad = await addBatch({ schedule_id: 'FS-0002' });
      var good2 = await addBatch({ schedule_id: 'FS-0002' });
      await client().query(
        'create function boom() returns trigger language plpgsql as $f$ begin ' +
        "if new.batch_id = '" + bad + "' then raise exception 'secret db detail'; end if; return new; end $f$"
      );
      await client().query(
        'create trigger boom_trg before insert on batch_tasks for each row execute function boom()'
      );

      var res = await tasks.propagateSchedule(client(), 'FS-0002', STEPS, OPTS);
      expect(res.ok).toBe(true);
      expect(res.batches_updated).toBe(2);
      expect(res.batches_failed).toEqual([{ batch_id: bad, error: 'propagate_failed' }]);
      expect(JSON.stringify(res)).not.toMatch(/secret/);
      expect(res.tasks_created).toBe(8);
      expect(await tasksOf(good)).toHaveLength(4);
      expect(await tasksOf(good2)).toHaveLength(4);
      expect(await tasksOf(bad)).toHaveLength(0);
    });
  });
});

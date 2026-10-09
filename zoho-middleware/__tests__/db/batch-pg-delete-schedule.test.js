'use strict';

/**
 * Real-Postgres deleteBatch / updateBatchSchedule / regenerateToken — Phase 87 Plan 08
 * (DB-06, D-01 cascade, D-08 tombstones, D-14 token). Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var T0 = new Date('2026-10-01T10:00:00.000Z');
var NOW = new Date('2026-10-09T18:00:00.000Z');
var OPTS = { actor: 'staff@example.com', now: NOW };

describeDb('batch-pg-update: delete, schedule, token', function () {
  var container;
  var pool;
  var upd;
  var read;
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
    upd = require('../../lib/batch-pg-update');
    read = require('../../lib/batch-pg-read');
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
  function q(sql, params) { return client().query(sql, params); }

  async function addBatch(o) {
    o = o || {};
    seq += 1;
    var id = o.batch_id || ('SV-B-8' + String(seq).padStart(5, '0'));
    var token = o.token || String(seq).padStart(32, 'b');
    await q(
      'insert into batches (batch_id, status, vessel_id, start_date, schedule_id, access_token, ' +
      'created_at, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $7)',
      [id, o.status || 'primary', o.vessel_id || '', o.start_date === undefined ? '2026-10-05' : o.start_date,
        o.schedule_id || null, token, o.last_updated || T0]
    );
    return id;
  }

  async function addTask(batchId, step, extra) {
    extra = extra || {};
    var res = await q(
      'insert into batch_tasks (batch_id, step_number, title, description, day_offset, completed, ' +
      'completed_by, notes, is_packaging, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning task_id',
      [batchId, step, extra.title || ('Step ' + step), 'old', extra.day_offset === undefined ? step : extra.day_offset,
        !!extra.completed, extra.completed ? 'someone@example.com' : '', extra.notes || '', !!extra.is_packaging, T0]
    );
    return res.rows[0].task_id;
  }

  async function tasks(batchId) {
    return (await q('select * from batch_tasks where batch_id = $1 order by step_number, task_id', [batchId])).rows;
  }

  async function addSchedule(id) {
    await q(
      'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $4)',
      [id, 'Sched ' + id, '[]', T0]
    );
  }

  describe('deleteBatch', function () {
    it('releases the vessel, tombstones, and cascades to all children; others untouched', async function () {
      await q('insert into vessels (vessel_id, type, status, archived, updated_at) values ($1, $2, $3, false, $4)',
        ['DEL-001', 'Carboy', 'In-Use', T0]);
      var id = await addBatch({ vessel_id: 'DEL-001' });
      var keep = await addBatch({});
      await addTask(id, 1);
      await addTask(keep, 1);
      await q('insert into plato_readings (batch_id, reading_at, created_at) values ($1, $2, $2)', [id, T0]);
      await q('insert into vessel_history (batch_id, transferred_at) values ($1, $2)', [id, T0]);

      var res = await upd.deleteBatch(client(), { batch_id: id }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.message).toBe('Batch ' + id + ' deleted');
      expect(res._batchId).toBe(id);

      expect((await q('select 1 from batches where batch_id = $1', [id])).rows).toHaveLength(0);
      expect((await q('select 1 from batch_tasks where batch_id = $1', [id])).rows).toHaveLength(0);
      expect((await q('select 1 from plato_readings where batch_id = $1', [id])).rows).toHaveLength(0);
      expect((await q('select 1 from vessel_history where batch_id = $1', [id])).rows).toHaveLength(0);
      expect((await q('select status from vessels where vessel_id = $1', ['DEL-001'])).rows[0].status).toBe('Empty');

      var tomb = (await q('select * from batch_tombstones where batch_id = $1', [id])).rows[0];
      expect(tomb.deleted_by).toBe('staff@example.com');
      expect(tomb.deleted_at.getTime()).toBe(NOW.getTime());

      expect((await q('select 1 from batches where batch_id = $1', [keep])).rows).toHaveLength(1);
      expect((await q('select 1 from batch_tasks where batch_id = $1', [keep])).rows).toHaveLength(1);
    });

    it('unknown and missing ids', async function () {
      expect((await upd.deleteBatch(client(), { batch_id: 'SV-B-999998' }, OPTS)).error).toBe('not_found');
      expect((await upd.deleteBatch(client(), {}, OPTS)).error).toBe('missing_id');
    });

    it('delete, re-create the same id, delete again (tombstone upsert) does not fail', async function () {
      var id = await addBatch({ batch_id: 'SV-B-800500' });
      expect((await upd.deleteBatch(client(), { batch_id: id }, OPTS)).ok).toBe(true);
      await addBatch({ batch_id: 'SV-B-800500' });
      var later = { actor: 'other@example.com', now: new Date(NOW.getTime() + 60000) };
      expect((await upd.deleteBatch(client(), { batch_id: id }, later)).ok).toBe(true);
      var tomb = (await q('select * from batch_tombstones where batch_id = $1', [id])).rows;
      expect(tomb).toHaveLength(1);
      expect(tomb[0].deleted_by).toBe('other@example.com');
    });

    it('does not use hand-written child deletes (the cascade does it)', function () {
      var src = require('fs').readFileSync(require('path').join(__dirname, '../../lib/batch-pg-update.js'), 'utf8');
      var body = src.slice(src.indexOf('async function deleteBatch'), src.indexOf('// ─── updateBatchSchedule'));
      expect(body).not.toMatch(/delete from (batch_tasks|plato_readings|vessel_history)/i);
    });
  });

  describe('updateBatchSchedule', function () {
    it('requires batch_id and snapshot', async function () {
      expect((await upd.updateBatchSchedule(client(), { schedule_snapshot: '[]' }, OPTS)).error).toBe('missing_fields');
      expect((await upd.updateBatchSchedule(client(), { batch_id: 'SV-B-800001' }, OPTS)).error).toBe('missing_fields');
      expect((await upd.updateBatchSchedule(client(), { batch_id: 'SV-B-999997', schedule_snapshot: '[]' }, OPTS)).error).toBe('not_found');
    });

    it('stale expectedVersion conflicts and writes nothing', async function () {
      var id = await addBatch({});
      var t = await addTask(id, 1);
      var res = await upd.updateBatchSchedule(client(), {
        batch_id: id,
        schedule_snapshot: JSON.stringify([{ step_number: 1, title: 'New', day_offset: 2 }]),
        expectedVersion: new Date(T0.getTime() - 1000).toISOString()
      }, OPTS);
      expect(res.error).toBe('version_conflict');
      expect((await tasks(id))[0].title).toBe('Step 1');
      expect(t).toMatch(/^BT-/);
    });

    it('reconciles by step_number: update in place, insert new, remove open vanished, keep completed', async function () {
      var id = await addBatch({ start_date: '2026-10-05' });
      var t1 = await addTask(id, 1, { completed: true, notes: 'done', is_packaging: true, day_offset: 0 });
      await addTask(id, 2);
      await addTask(id, 3);
      await addTask(id, 4, { completed: true });
      var snapshot = [
        { step_number: 1, title: 'Pitch <script>x</script>', description: 'd1', day_offset: 1 },
        { step_number: 5, title: 'Package', description: 'd5', day_offset: 10, is_packaging: true }
      ];
      var res = await upd.updateBatchSchedule(client(), {
        batch_id: id, schedule_snapshot: JSON.stringify(snapshot)
      }, OPTS);
      expect(res).toEqual({ ok: true, tasks_updated: 1, tasks_created: 1, tasks_removed: 2, _batchId: id });

      var rows = await tasks(id);
      expect(rows.map(function (r) { return r.step_number; })).toEqual([1, 4, 5]);

      var one = rows[0];
      expect(one.task_id).toBe(t1);
      expect(one.title).not.toMatch(/script/i);
      expect(one.description).toBe('d1');
      expect(one.day_offset).toBe(1);
      expect(one.completed).toBe(true);
      expect(one.notes).toBe('done');
      expect(one.is_packaging).toBe(true);
      expect(one.last_updated.getTime()).toBe(NOW.getTime());
      var due = one.due_date;
      expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([2026, 10, 6]);

      expect(rows[1].completed).toBe(true);

      var added = rows[2];
      expect(added.task_id).toMatch(/^BT-[0-9]{6,}$/);
      expect(added.completed).toBe(false);
      expect(added.is_packaging).toBe(true);
      expect(added.is_transfer).toBe(false);
      expect(added.due_date.getDate()).toBe(15);

      var batch = (await q('select schedule_snapshot, last_updated from batches where batch_id = $1', [id])).rows[0];
      expect(batch.schedule_snapshot).toBe(JSON.stringify(snapshot));
      expect(batch.last_updated.getTime()).toBe(NOW.getTime());
    });

    it('accepts an already-parsed snapshot and stores it as JSON text', async function () {
      var id = await addBatch({});
      var steps = [{ step_number: 1, title: 'A', day_offset: 0 }];
      var res = await upd.updateBatchSchedule(client(), { batch_id: id, schedule_snapshot: steps }, OPTS);
      expect(res.ok).toBe(true);
      expect((await q('select schedule_snapshot from batches where batch_id = $1', [id])).rows[0].schedule_snapshot)
        .toBe(JSON.stringify(steps));
    });

    it('a negative day_offset leaves the due date null (packaging placeholder)', async function () {
      var id = await addBatch({});
      await upd.updateBatchSchedule(client(), {
        batch_id: id, schedule_snapshot: JSON.stringify([{ step_number: 1, title: 'P', day_offset: -1, is_packaging: true }])
      }, OPTS);
      expect((await tasks(id))[0].due_date).toBeNull();
    });

    it('persists a known schedule_id; an unknown one is not_found and nothing is written', async function () {
      await addSchedule('FS-009001');
      var id = await addBatch({});
      var ok = await upd.updateBatchSchedule(client(), {
        batch_id: id, schedule_id: 'FS-009001', schedule_snapshot: '[]'
      }, OPTS);
      expect(ok.ok).toBe(true);
      expect((await q('select schedule_id from batches where batch_id = $1', [id])).rows[0].schedule_id).toBe('FS-009001');

      await addTask(id, 1);
      var bad = await upd.updateBatchSchedule(client(), {
        batch_id: id, schedule_id: 'FS-009999',
        schedule_snapshot: JSON.stringify([{ step_number: 1, title: 'Changed', day_offset: 0 }])
      }, OPTS);
      expect(bad.ok).toBe(false);
      expect(bad.error).toBe('not_found');
      expect((await tasks(id))[0].title).toBe('Step 1');
      expect((await q('select schedule_id from batches where batch_id = $1', [id])).rows[0].schedule_id).toBe('FS-009001');
    });

    it('rejects malformed snapshots', async function () {
      var id = await addBatch({});
      expect((await upd.updateBatchSchedule(client(), { batch_id: id, schedule_snapshot: '{oops' }, OPTS)).error).toBe('invalid_data');
      expect((await upd.updateBatchSchedule(client(), { batch_id: id, schedule_snapshot: '{"a":1}' }, OPTS)).error).toBe('invalid_data');
    });
  });

  describe('regenerateToken', function () {
    it('issues a new 32-hex token, stamps times, and the old token stops validating', async function () {
      var oldToken = 'c'.repeat(32);
      var id = await addBatch({ batch_id: 'SV-B-800700', token: oldToken });
      expect((await read.getBatchPublic(client(), id, oldToken)).ok).toBe(true);

      var res = await upd.regenerateToken(client(), { batch_id: id }, OPTS);
      expect(res.ok).toBe(true);
      expect(res._batchId).toBe(id);
      expect(res.access_token).toMatch(/^[0-9a-f]{32}$/);
      expect(res.access_token).not.toBe(oldToken);

      var row = (await q('select * from batches where batch_id = $1', [id])).rows[0];
      expect(row.access_token).toBe(res.access_token);
      expect(row.last_regenerated_at.getTime()).toBe(NOW.getTime());
      expect(row.last_updated.getTime()).toBe(NOW.getTime());

      expect((await read.getBatchPublic(client(), id, oldToken)).ok).toBe(false);
      expect((await read.getBatchPublic(client(), id, res.access_token)).ok).toBe(true);
    });

    it('missing and unknown ids', async function () {
      expect((await upd.regenerateToken(client(), {}, OPTS)).error).toBe('missing_id');
      expect((await upd.regenerateToken(client(), { batch_id: 'SV-B-999996' }, OPTS)).error).toBe('not_found');
    });
  });
});

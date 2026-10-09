'use strict';

/**
 * Real-Postgres task completion / bulk / add / public rules — Phase 87 Plan 09 (DB-06, D-13,
 * 87-DESIGN Q8, Q9). Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var T0 = new Date('2026-10-01T10:00:00.000Z');
var NOW = new Date('2026-10-09T18:00:00.000Z');
var OPTS = { actor: 'staff@example.com', now: NOW };

describeDb('batch-pg-tasks: tasks', function () {
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

  async function addVessel(id, status) {
    await client().query(
      'insert into vessels (vessel_id, type, status, archived, updated_at) values ($1, $2, $3, false, $4)',
      [id, 'Carboy', status || 'Empty', T0]
    );
  }

  async function addBatch(o) {
    o = o || {};
    seq += 1;
    var id = 'SV-B-8' + String(seq).padStart(5, '0');
    await client().query(
      'insert into batches (batch_id, status, vessel_id, shelf_id, bin_id, start_date, access_token, ' +
      'created_at, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $8)',
      [id, o.status || 'primary', o.vessel_id || '', o.shelf_id || '', o.bin_id || '',
        o.start_date === undefined ? '2026-10-01' : o.start_date, String(seq).padStart(32, 'b'), T0]
    );
    return id;
  }

  async function addTask(batchId, step, o) {
    o = o || {};
    var res = await client().query(
      'insert into batch_tasks (batch_id, step_number, title, day_offset, due_date, is_packaging, ' +
      'is_transfer, completed, completed_at, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ' +
      'returning task_id',
      [batchId, step, o.title || ('Step ' + step), 1, null, !!o.is_packaging, !!o.is_transfer,
        !!o.completed, o.completed ? T0 : null, T0]
    );
    return res.rows[0].task_id;
  }

  async function batchRow(id) {
    return (await client().query('select * from batches where batch_id = $1', [id])).rows[0];
  }
  async function taskRow(id) {
    return (await client().query('select * from batch_tasks where task_id = $1', [id])).rows[0];
  }
  async function vstatus(id) {
    return (await client().query('select status from vessels where vessel_id = $1', [id])).rows[0].status;
  }
  async function history(id) {
    return (await client().query('select * from vessel_history where batch_id = $1', [id])).rows;
  }

  describe('updateBatchTask: basics', function () {
    it('guards missing_id and not_found', async function () {
      expect((await tasks.updateBatchTask(client(), {}, OPTS)).error).toBe('missing_id');
      expect((await tasks.updateBatchTask(client(), { task_id: 'BT-999999' }, OPTS)).error).toBe('not_found');
    });

    it('completes a normal task with actor and time, then un-completes', async function () {
      var b = await addBatch();
      var t = await addTask(b, 1);
      var res = await tasks.updateBatchTask(client(), { task_id: t, updates: { completed: true } }, OPTS);
      expect(res).toMatchObject({ ok: true, message: 'Task updated', batch_id: b, _batchId: b });
      var row = await taskRow(t);
      expect(row.completed).toBe(true);
      expect(row.completed_at.getTime()).toBe(NOW.getTime());
      expect(row.completed_by).toBe('staff@example.com');
      expect((await batchRow(b)).last_updated.getTime()).toBe(T0.getTime());

      await tasks.updateBatchTask(client(), { task_id: t, updates: { completed: false } }, OPTS);
      row = await taskRow(t);
      expect(row.completed).toBe(false);
      expect(row.completed_at).toBeNull();
      expect(row.completed_by).toBe('');
    });

    it('updates sanitised notes without touching completion', async function () {
      var b = await addBatch();
      var t = await addTask(b, 1);
      await tasks.updateBatchTask(client(), { task_id: t, updates: { notes: 'ok <script>x</script>' } }, OPTS);
      var row = await taskRow(t);
      expect(row.notes).not.toMatch(/script/i);
      expect(row.completed).toBe(false);
    });
  });

  describe('packaging', function () {
    it('keeps the batch active while another non-packaging task is open', async function () {
      await addVessel('VP-101', 'In-Use');
      var b = await addBatch({ vessel_id: 'VP-101' });
      await addTask(b, 1);
      var p = await addTask(b, 2, { is_packaging: true });
      await tasks.updateBatchTask(client(), { task_id: p, updates: { completed: true } }, OPTS);
      expect((await taskRow(p)).completed).toBe(true);
      expect((await batchRow(b)).status).toBe('primary');
      expect(await vstatus('VP-101')).toBe('In-Use');
    });

    it('completes the batch and empties the vessel when all others are done', async function () {
      await addVessel('VP-102', 'In-Use');
      var b = await addBatch({ vessel_id: 'VP-102' });
      await addTask(b, 1, { completed: true });
      var p = await addTask(b, 2, { is_packaging: true });
      var res = await tasks.updateBatchTask(client(), { task_id: p, updates: { completed: true } }, OPTS);
      expect(res._vesselApplied).toEqual(['VP-102']);
      var row = await batchRow(b);
      expect(row.status).toBe('complete');
      expect(row.completed_at.getTime()).toBe(NOW.getTime());
      expect(row.last_updated.getTime()).toBe(NOW.getTime());
      expect(await vstatus('VP-102')).toBe('Empty');
    });

    it('un-completing packaging restores secondary and In-Use when a transfer was done', async function () {
      await addVessel('VP-103', 'Empty');
      var b = await addBatch({ vessel_id: 'VP-103', status: 'complete' });
      await addTask(b, 1, { is_transfer: true, completed: true });
      var p = await addTask(b, 2, { is_packaging: true, completed: true });
      await client().query('update batches set completed_at = $2 where batch_id = $1', [b, T0]);
      await tasks.updateBatchTask(client(), { task_id: p, updates: { completed: false } }, OPTS);
      var row = await batchRow(b);
      expect(row.status).toBe('secondary');
      expect(row.completed_at.getTime()).toBe(T0.getTime());
      expect(await vstatus('VP-103')).toBe('In-Use');
    });

    it('un-completing packaging with no transfer done restores primary', async function () {
      var b = await addBatch({ status: 'complete' });
      var p = await addTask(b, 1, { is_packaging: true, completed: true });
      await tasks.updateBatchTask(client(), { task_id: p, updates: { completed: false } }, OPTS);
      expect((await batchRow(b)).status).toBe('primary');
    });
  });

  describe('transfer', function () {
    it('moves to a free slot, writes history, swaps vessels and advances to secondary', async function () {
      await addVessel('VT-101', 'In-Use');
      await addVessel('VT-102', 'Empty');
      var b = await addBatch({ vessel_id: 'VT-101', shelf_id: 'S1', bin_id: '1' });
      var t = await addTask(b, 1, { is_transfer: true });
      var res = await tasks.updateBatchTask(client(), {
        task_id: t, updates: { completed: true },
        transfer_location: { vessel_id: 'VT-102', shelf_id: 'S2', bin_id: 3 }
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.warnings).toBeUndefined();
      var row = await batchRow(b);
      expect(row).toMatchObject({ vessel_id: 'VT-102', shelf_id: 'S2', bin_id: '3', status: 'secondary' });
      var h = await history(b);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ vessel_id: 'VT-101', shelf_id: 'S1', bin_id: '1' });
      expect(await vstatus('VT-101')).toBe('Empty');
      expect(await vstatus('VT-102')).toBe('In-Use');
    });

    it('completes the task with a warnings array when the target slot is occupied', async function () {
      await addVessel('VT-103', 'In-Use');
      await addVessel('VT-104', 'In-Use');
      var other = await addBatch({ vessel_id: 'VT-104', shelf_id: 'S9', bin_id: '9' });
      var b = await addBatch({ vessel_id: 'VT-103' });
      var t = await addTask(b, 1, { is_transfer: true });
      var res = await tasks.updateBatchTask(client(), {
        task_id: t, updates: { completed: true },
        transfer_location: { vessel_id: 'VT-104', shelf_id: 'S9', bin_id: 9 }
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toMatch(/^location_conflict: /);
      expect(res.warnings[0]).toContain(other);
      expect((await taskRow(t)).completed).toBe(true);
      var row = await batchRow(b);
      expect(row.vessel_id).toBe('VT-103');
      expect(row.status).toBe('secondary');
      expect(await history(b)).toHaveLength(0);
      expect(await vstatus('VT-103')).toBe('In-Use');
    });

    it('without a location empties the current vessel, keeps vessel_id, advances primary', async function () {
      await addVessel('VT-105', 'In-Use');
      var b = await addBatch({ vessel_id: 'VT-105' });
      var t = await addTask(b, 1, { is_transfer: true });
      await tasks.updateBatchTask(client(), { task_id: t, updates: { completed: true } }, OPTS);
      var row = await batchRow(b);
      expect(row.vessel_id).toBe('VT-105');
      expect(row.status).toBe('secondary');
      expect(await vstatus('VT-105')).toBe('Empty');
    });
  });

  describe('bulkUpdateBatchTasks', function () {
    it('rejects empty and oversized arrays', async function () {
      expect((await tasks.bulkUpdateBatchTasks(client(), {}, OPTS)).error).toBe('invalid_input');
      expect((await tasks.bulkUpdateBatchTasks(client(), { tasks: [] }, OPTS)).error).toBe('invalid_input');
      var big = [];
      for (var i = 0; i < 51; i++) big.push({ task_id: 'BT-000001', updates: { notes: 'x' } });
      expect((await tasks.bulkUpdateBatchTasks(client(), { tasks: big }, OPTS)).error).toBe('too_many');
    });

    it('returns per-item results for a mix of valid and unknown tasks', async function () {
      var b1 = await addBatch();
      var b2 = await addBatch();
      var t1 = await addTask(b1, 1);
      var t2 = await addTask(b2, 1);
      var res = await tasks.bulkUpdateBatchTasks(client(), {
        tasks: [
          { task_id: t1, updates: { completed: true } },
          { task_id: 'BT-999998', updates: { completed: true } },
          { task_id: t2, updates: { notes: 'n' } }
        ]
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.results.map(function (r) { return r.ok; })).toEqual([true, false, true]);
      expect(res.results[1].error).toBe('not_found');
      expect(res.results[0]._batchId).toBeUndefined();
      expect(res.affected_batch_ids).toEqual([b1, b2]);
      expect(res._batchIds).toEqual([b1, b2]);
      expect((await taskRow(t1)).completed).toBe(true);
    });
  });

  describe('addBatchTask', function () {
    it('requires batch_id and title, and a real batch', async function () {
      expect((await tasks.addBatchTask(client(), { batch_id: 'x' }, OPTS)).error).toBe('missing_fields');
      expect((await tasks.addBatchTask(client(), { batch_id: 'SV-B-999999', title: 't' }, OPTS)).error)
        .toBe('not_found');
    });

    it('uses step max+1, day_offset -1 (no due date) and is_packaging false', async function () {
      var b = await addBatch();
      await addTask(b, 4);
      var res = await tasks.addBatchTask(client(), { batch_id: b, title: 'Extra', is_packaging: true }, OPTS);
      expect(res).toMatchObject({ ok: true, message: 'Task added', _batchId: b });
      var row = await taskRow(res.task_id);
      expect(row.step_number).toBe(5);
      expect(row.day_offset).toBe(-1);
      expect(row.due_date).toBeNull();
      expect(row.is_packaging).toBe(false);
      expect(row.completed).toBe(false);
    });

    it('computes the due date from the batch start date for a non-negative offset', async function () {
      var b = await addBatch({ start_date: '2026-10-01' });
      var res = await tasks.addBatchTask(client(), { batch_id: b, title: 'Later', day_offset: 3 }, OPTS);
      var row = (await client().query(
        "select to_char(due_date, 'YYYY-MM-DD') as d, step_number from batch_tasks where task_id = $1",
        [res.task_id]
      )).rows[0];
      expect(row.d).toBe('2026-10-04');
      expect(row.step_number).toBe(1);
    });
  });

  describe('public path (Q8, D-14)', function () {
    it('refuses packaging completion with unauthorized and writes nothing', async function () {
      var b = await addBatch();
      var p = await addTask(b, 1, { is_packaging: true });
      var res = await tasks.updateBatchTask(client(), {
        task_id: p, updates: { completed: true }
      }, { actor: 'x', now: NOW, publicBatchId: b });
      expect(res.error).toBe('unauthorized');
      expect((await taskRow(p)).completed).toBe(false);
    });

    it('refuses a task that belongs to another batch (regression: Q8)', async function () {
      var mine = await addBatch();
      var theirs = await addBatch();
      var t = await addTask(theirs, 1);
      var res = await tasks.updateBatchTask(client(), {
        task_id: t, updates: { completed: true }
      }, { actor: 'x', now: NOW, publicBatchId: mine });
      expect(res.error).toBe('unauthorized');
      expect(res.message).not.toMatch(/not found/i);
      expect((await taskRow(t)).completed).toBe(false);
    });

    it('allows its own task and records actor batch-url', async function () {
      var b = await addBatch();
      var t = await addTask(b, 1);
      var res = await tasks.updateBatchTask(client(), {
        task_id: t, updates: { completed: true }
      }, { actor: 'ignored', now: NOW, publicBatchId: b });
      expect(res.ok).toBe(true);
      expect((await taskRow(t)).completed_by).toBe('batch-url');
    });

    it('can still un-complete packaging-free tasks and edit notes', async function () {
      var b = await addBatch();
      var t = await addTask(b, 1, { completed: true });
      var res = await tasks.updateBatchTask(client(), {
        task_id: t, updates: { completed: false, notes: 'redo' }
      }, { now: NOW, publicBatchId: b });
      expect(res.ok).toBe(true);
      expect((await taskRow(t)).notes).toBe('redo');
    });
  });
});

describeDb('batch-pg-tasks: concurrency', function () {
  var container;
  var pool;
  var tasks;

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

  it('serialises completions so the packaging decision sees the last open task', async function () {
    await pool.query(
      'insert into vessels (vessel_id, type, status, archived, updated_at) values ($1, $2, $3, false, $4)',
      ['VC-101', 'Carboy', 'In-Use', T0]
    );
    await pool.query(
      'insert into batches (batch_id, status, vessel_id, access_token, created_at, last_updated) ' +
      "values ('SV-B-700001', 'primary', 'VC-101', $1, $2, $2)",
      ['c'.repeat(32), T0]
    );
    var rows = [];
    var specs = [[1, false], [2, true]];
    for (var i = 0; i < specs.length; i++) {
      var r = await pool.query(
        'insert into batch_tasks (batch_id, step_number, title, day_offset, is_packaging, completed, ' +
        'last_updated) values ($1, $2, $3, 1, $4, false, $5) returning task_id',
        ['SV-B-700001', specs[i][0], 'S' + i, specs[i][1], T0]
      );
      rows.push(r.rows[0].task_id);
    }

    var c1 = await pool.connect();
    var c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      // c1 completes the last open regular task but has not committed yet.
      var r1 = await tasks.updateBatchTask(c1, { task_id: rows[0], updates: { completed: true } }, OPTS);
      expect(r1.ok).toBe(true);
      // c2 completes packaging; it must wait for c1's lock, then see the task as done.
      var p2 = tasks.updateBatchTask(c2, { task_id: rows[1], updates: { completed: true } }, OPTS);
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      await c1.query('COMMIT');
      var r2 = await p2;
      expect(r2.ok).toBe(true);
      expect(r2._vesselApplied).toEqual(['VC-101']);
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
    }

    var batch = (await pool.query("select * from batches where batch_id = 'SV-B-700001'")).rows[0];
    expect(batch.status).toBe('complete');
    expect(batch.completed_at).not.toBeNull();
    var v = (await pool.query("select status from vessels where vessel_id = 'VC-101'")).rows[0];
    expect(v.status).toBe('Empty');
  });

  it('a double packaging completion completes the batch exactly once', async function () {
    await pool.query(
      'insert into batches (batch_id, status, vessel_id, access_token, created_at, last_updated) ' +
      "values ('SV-B-700002', 'primary', '', $1, $2, $2)",
      ['d'.repeat(32), T0]
    );
    var r = await pool.query(
      'insert into batch_tasks (batch_id, step_number, title, day_offset, is_packaging, completed, ' +
      "last_updated) values ('SV-B-700002', 1, 'Pack', 1, true, false, $1) returning task_id",
      [T0]
    );
    var tid = r.rows[0].task_id;
    var first = new Date('2026-10-09T18:00:00.000Z');
    var second = new Date('2026-10-09T18:05:00.000Z');
    var c1 = await pool.connect();
    var c2 = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await tasks.updateBatchTask(c1, { task_id: tid, updates: { completed: true } }, { actor: 'a', now: first });
      var p2 = tasks.updateBatchTask(c2, { task_id: tid, updates: { completed: true } }, { actor: 'b', now: second });
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      await c1.query('COMMIT');
      expect((await p2).ok).toBe(true);
      await c2.query('COMMIT');
    } finally {
      c1.release();
      c2.release();
    }
    var batch = (await pool.query("select * from batches where batch_id = 'SV-B-700002'")).rows[0];
    expect(batch.status).toBe('complete');
    expect(batch.completed_at.getTime()).toBe(first.getTime());
  });
});

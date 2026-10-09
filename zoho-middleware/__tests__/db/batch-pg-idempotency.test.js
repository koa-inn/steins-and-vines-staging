'use strict';

/**
 * Real-Postgres createBatch idempotency — Phase 87 Plan 07 (DB-06, D-15).
 * Uses committed data and separate pool clients so the advisory locks really contend.
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var STEPS = [
  { step_number: 1, title: 'A', description: '', day_offset: 0 },
  { step_number: 2, title: 'B', description: '', day_offset: 5 }
];

describeDb('batch-pg-idempotency', function () {
  var container;
  var pool;
  var create;
  var NOW = new Date('2026-10-09T18:00:00.000Z');

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    create = require('../../lib/batch-pg-create');
    pool = db.createPool(started.connectionString);
    await pool.query(
      'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $4)',
      ['FS-0001', 'Two step', JSON.stringify(STEPS), NOW]
    );
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  afterEach(async function () {
    await pool.query('truncate batches, batch_create_dedup cascade');
  });

  // One committed transaction per call, on its own pool client.
  async function tx(payload, o) {
    var c = await pool.connect();
    try {
      await c.query('begin');
      var r = await create.createBatch(c, payload, Object.assign({ actor: 'staff@example.com', now: NOW }, o || {}));
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }
  function inv(extra) {
    return Object.assign({
      product_sku: 'K1', customer_name: 'Ann', zoho_so_number: 'INV-1', unit_total: 2
    }, extra || {});
  }
  async function rows() {
    return (await pool.query('select batch_id, unit_seq, access_token from batches order by batch_id')).rows;
  }

  describe('invoice-linked', function () {
    it('allows unit_total creates then rejects with the exact message', async function () {
      var a = await tx(inv());
      var b = await tx(inv());
      expect(a.ok && b.ok).toBe(true);
      expect((await rows()).map(function (r) { return r.unit_seq; })).toEqual([1, 2]);
      var c = await tx(inv());
      expect(c).toEqual({
        ok: false,
        error: 'duplicate_so_number',
        message: 'SO/invoice INV-1 + SKU K1 already has 2 of 2 batch(es): ' + a.batch_id + ', ' + b.batch_id
      });
      expect(await rows()).toHaveLength(2);
    });

    it('treats missing, zero and non-numeric unit_total as 1', async function () {
      var cases = [undefined, 0, 'abc'];
      for (var i = 0; i < cases.length; i++) {
        await pool.query('truncate batches cascade');
        var p = inv({ unit_total: cases[i] });
        expect((await tx(p)).ok).toBe(true);
        expect((await tx(p)).error).toBe('duplicate_so_number');
      }
    });

    it('keeps a different SKU independent', async function () {
      expect((await tx(inv({ unit_total: 1 }))).ok).toBe(true);
      expect((await tx(inv({ unit_total: 1, product_sku: 'K2' }))).ok).toBe(true);
    });

    it('invoice without sku: an existing batch for the invoice is a duplicate', async function () {
      var first = await tx({ recipe_id: 'RCP-0001', customer_name: 'Ann', zoho_so_number: 'INV-9' });
      expect(first.ok).toBe(true);
      var second = await tx({ recipe_id: 'RCP-0001', customer_name: 'Ann', zoho_so_number: 'INV-9' });
      expect(second).toEqual({
        ok: false,
        error: 'duplicate_so_number',
        message: 'A batch for SO/invoice INV-9 already exists: ' + first.batch_id
      });
    });

    it('three parallel creates for unit_total 2 yield exactly 2 batches', async function () {
      var results = await Promise.all([tx(inv()), tx(inv()), tx(inv())]);
      expect(results.filter(function (r) { return r.ok; })).toHaveLength(2);
      var dups = results.filter(function (r) { return !r.ok; });
      expect(dups).toHaveLength(1);
      expect(dups[0].error).toBe('duplicate_so_number');
      expect((await rows()).map(function (r) { return r.unit_seq; }).sort()).toEqual([1, 2]);
    });

    it('maps a unit_seq unique violation to duplicate_so_number', async function () {
      // Bypassing the lock: the unique index itself rejects a colliding unit_seq.
      var insertSql = "insert into batches (status, customer_name, product_sku, zoho_so_number, unit_seq, access_token, created_at, last_updated) values ('pending', 'x', 'K1', 'INV-1', 2, $1, now(), now())";
      await pool.query(insertSql, ['a'.repeat(32)]);
      await expect(pool.query(insertSql, ['b'.repeat(32)])).rejects.toMatchObject({ code: '23505' });

      // One existing row (unit_seq 2) and room for 3: the next unit_seq is count + 1 = 2.
      var r = await tx(inv({ unit_total: 3 }));
      expect(r.ok).toBe(false);
      expect(r.error).toBe('duplicate_so_number');
      expect(await rows()).toHaveLength(1);
    });
  });

  describe('manual', function () {
    function manual(extra) {
      return Object.assign({
        product_sku: 'K1', customer_name: 'Ann', schedule_id: 'FS-0001', start_date: '2026-10-10', notes: 'n1'
      }, extra || {});
    }

    it('replays the same actor and payload inside the window', async function () {
      var a = await tx(manual());
      var b = await tx(manual(), { now: new Date(NOW.getTime() + 30000) });
      expect(b.ok).toBe(true);
      expect(b.idempotent_replay).toBe(true);
      expect(b.batch_id).toBe(a.batch_id);
      expect(b.access_token).toBe(a.access_token);
      expect(b.tasks_created).toBe(2);
      expect(await rows()).toHaveLength(1);
    });

    it('creates a new batch outside the window', async function () {
      var a = await tx(manual());
      var b = await tx(manual(), { now: new Date(NOW.getTime() + 121000) });
      expect(b.idempotent_replay).toBeUndefined();
      expect(b.batch_id).not.toBe(a.batch_id);
      expect(await rows()).toHaveLength(2);
      var d = await pool.query('select batch_id from batch_create_dedup');
      expect(d.rows).toEqual([{ batch_id: b.batch_id }]);
    });

    it('honours a custom replay window', async function () {
      await tx(manual());
      var b = await tx(manual(), { now: new Date(NOW.getTime() + 5000), replayWindowMs: 1000 });
      expect(b.idempotent_replay).toBeUndefined();
    });

    it('creates a new batch for a different actor or payload', async function () {
      var a = await tx(manual());
      var b = await tx(manual(), { actor: 'other@example.com' });
      var c = await tx(manual({ notes: 'n2' }));
      expect(new Set([a.batch_id, b.batch_id, c.batch_id]).size).toBe(3);
    });

    it('replays a pending batch with its status', async function () {
      var a = await tx({ product_sku: 'K1', customer_name: 'Ann' });
      var b = await tx({ product_sku: 'K1', customer_name: 'Ann' });
      expect(b.idempotent_replay).toBe(true);
      expect(b.status).toBe('pending');
      expect(b.batch_id).toBe(a.batch_id);
    });

    it('parallel identical manual creates yield one batch', async function () {
      var results = await Promise.all([tx(manual()), tx(manual()), tx(manual())]);
      expect(new Set(results.map(function (r) { return r.batch_id; })).size).toBe(1);
      expect(await rows()).toHaveLength(1);
    });

    it('creates anew if the replayed batch was deleted', async function () {
      var a = await tx(manual());
      await pool.query('delete from batches where batch_id = $1', [a.batch_id]);
      var b = await tx(manual());
      expect(b.idempotent_replay).toBeUndefined();
      expect(b.batch_id).not.toBe(a.batch_id);
    });
  });
});

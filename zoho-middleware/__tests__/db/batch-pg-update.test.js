'use strict';

/**
 * Real-Postgres updateBatch / applyLocationChange — Phase 87 Plan 08 (DB-06, D-13).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var T0 = new Date('2026-10-01T10:00:00.000Z');
var NOW = new Date('2026-10-09T18:00:00.000Z');
var OPTS = { actor: 'staff@example.com', now: NOW };

describeDb('batch-pg-update: updateBatch', function () {
  var container;
  var pool;
  var upd;
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
    seq += 1;
    var id = o.batch_id || ('SV-B-9' + String(seq).padStart(5, '0'));
    var token = String(seq).padStart(32, 'a');
    await client().query(
      'insert into batches (batch_id, status, vessel_id, shelf_id, bin_id, start_date, access_token, ' +
      'created_at, last_updated, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $8, $9)',
      [id, o.status || 'primary', o.vessel_id || '', o.shelf_id || '', o.bin_id || '',
        o.start_date === undefined ? null : o.start_date, token, o.last_updated || T0, o.notes || '']
    );
    return id;
  }

  async function row(id) {
    return (await client().query('select * from batches where batch_id = $1', [id])).rows[0];
  }
  async function history(id) {
    return (await client().query(
      'select * from vessel_history where batch_id = $1 order by history_id', [id]
    )).rows;
  }
  async function vstatus(id) {
    return (await client().query('select status from vessels where vessel_id = $1', [id])).rows[0].status;
  }

  describe('guards and versioning', function () {
    it('missing_id and not_found', async function () {
      expect((await upd.updateBatch(client(), {}, OPTS)).error).toBe('missing_id');
      expect((await upd.updateBatch(client(), { batch_id: 'SV-B-999999' }, OPTS)).error).toBe('not_found');
    });

    it('older expectedVersion conflicts; equal or newer proceeds', async function () {
      var id = await addBatch({});
      var older = await upd.updateBatch(client(), {
        batch_id: id, updates: { notes: 'x' }, expectedVersion: new Date(T0.getTime() - 1000).toISOString()
      }, OPTS);
      expect(older.error).toBe('version_conflict');
      expect((await row(id)).notes).toBe('');

      var equal = await upd.updateBatch(client(), {
        batch_id: id, updates: { notes: 'x' }, expectedVersion: T0.toISOString()
      }, OPTS);
      expect(equal.ok).toBe(true);
      var newer = await upd.updateBatch(client(), {
        batch_id: id, updates: { notes: 'y' }, expectedVersion: new Date(NOW.getTime() + 5000).toISOString()
      }, OPTS);
      expect(newer.ok).toBe(true);
    });

    it('newVersion equals the stored last_updated epoch ms', async function () {
      var id = await addBatch({});
      var res = await upd.updateBatch(client(), { batch_id: id, updates: { notes: 'n' } }, OPTS);
      expect(res.ok).toBe(true);
      expect(res.message).toBe('Batch updated');
      expect(res._batchId).toBe(id);
      expect(res.newVersion).toBe((await row(id)).last_updated.getTime());
      expect(res.newVersion).toBe(NOW.getTime());
    });

    it('does not use stale-token isStale', function () {
      var src = require('fs').readFileSync(require('path').join(__dirname, '../../lib/batch-pg-update.js'), 'utf8');
      expect(src.indexOf('isStale')).toBe(-1);
    });
  });

  describe('field handling', function () {
    it('ignores non-whitelisted fields (access_token, created_by)', async function () {
      var id = await addBatch({});
      var before = await row(id);
      var res = await upd.updateBatch(client(), {
        batch_id: id,
        updates: { access_token: 'f'.repeat(32), created_by: 'evil', source: 'x', notes: 'ok' }
      }, OPTS);
      expect(res.ok).toBe(true);
      var after = await row(id);
      expect(after.access_token).toBe(before.access_token);
      expect(after.created_by).toBe(before.created_by);
      expect(after.source).toBe(before.source);
      expect(after.notes).toBe('ok');
    });

    it('sanitises text fields', async function () {
      var id = await addBatch({});
      await upd.updateBatch(client(), { batch_id: id, updates: { notes: 'hi <script>alert(1)</script>there' } }, OPTS);
      expect((await row(id)).notes).not.toMatch(/script/i);
    });

    it('rejects a non-JSON recipe_snapshot and stores valid JSON raw', async function () {
      var id = await addBatch({});
      var bad = await upd.updateBatch(client(), { batch_id: id, updates: { recipe_snapshot: 'not json' } }, OPTS);
      expect(bad.error).toBe('invalid_input');
      expect((await row(id)).recipe_snapshot).toBe('');
      var snap = '{"a":"<b>x</b>"}';
      var good = await upd.updateBatch(client(), { batch_id: id, updates: { recipe_snapshot: snap } }, OPTS);
      expect(good.ok).toBe(true);
      expect((await row(id)).recipe_snapshot).toBe(snap);
    });

    it('rejects an unparseable start_date without writing', async function () {
      var id = await addBatch({});
      var res = await upd.updateBatch(client(), { batch_id: id, updates: { start_date: 'banana', notes: 'z' } }, OPTS);
      expect(res.error).toBe('invalid_input');
      expect((await row(id)).notes).toBe('');
    });
  });

  describe('transfers (D-13)', function () {
    it('moves to a free slot: history has the OLD location, vessels flip in one tx', async function () {
      await addVessel('PCB-001', 'In-Use');
      await addVessel('PCB-002', 'Empty');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-001', shelf_id: 'A', bin_id: '3' });
      var res = await upd.updateBatch(client(), {
        batch_id: id,
        updates: { vessel_id: 'PCB-002', shelf_id: 'B', bin_id: 4 },
        transfer_notes: 'moved <script>x</script>it'
      }, OPTS);
      expect(res.ok).toBe(true);
      var h = await history(id);
      expect(h).toHaveLength(1);
      expect(h[0].vessel_id).toBe('PCB-001');
      expect(h[0].shelf_id).toBe('A');
      expect(h[0].bin_id).toBe('3');
      expect(h[0].transferred_by).toBe('staff@example.com');
      expect(h[0].transferred_at.getTime()).toBe(NOW.getTime());
      expect(h[0].notes).not.toMatch(/script/i);
      var b = await row(id);
      expect([b.vessel_id, b.shelf_id, b.bin_id]).toEqual(['PCB-002', 'B', '4']);
      expect(await vstatus('PCB-001')).toBe('Empty');
      expect(await vstatus('PCB-002')).toBe('In-Use');
    });

    it('flips vessels also when the batch status is complete (parity)', async function () {
      await addVessel('PCB-003', 'Empty');
      await addVessel('PCB-004', 'Empty');
      var id = await addBatch({ status: 'complete', vessel_id: 'PCB-003', shelf_id: 'A', bin_id: '1' });
      var res = await upd.updateBatch(client(), { batch_id: id, updates: { vessel_id: 'PCB-004' } }, OPTS);
      expect(res.ok).toBe(true);
      expect(await vstatus('PCB-004')).toBe('In-Use');
    });

    it('location_conflict leaves no history row and no vessel change', async function () {
      await addVessel('PCB-005', 'In-Use');
      await addVessel('PCB-006', 'In-Use');
      var other = await addBatch({ status: 'primary', vessel_id: 'PCB-006', shelf_id: 'A', bin_id: '1' });
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-005', shelf_id: 'A', bin_id: '1' });
      var res = await upd.updateBatch(client(), {
        batch_id: id, updates: { vessel_id: 'PCB-006', notes: 'should not stick' }
      }, OPTS);
      expect(res.ok).toBe(false);
      expect(res.error).toBe('location_conflict');
      expect(res.message).toContain(other);
      expect(await history(id)).toHaveLength(0);
      expect(await vstatus('PCB-005')).toBe('In-Use');
      var b = await row(id);
      expect(b.vessel_id).toBe('PCB-005');
      expect(b.notes).toBe('');
    });

    it('an unchanged location writes no history', async function () {
      await addVessel('PCB-007', 'In-Use');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-007', shelf_id: 'A', bin_id: '1' });
      var res = await upd.updateBatch(client(), {
        batch_id: id, updates: { vessel_id: 'PCB-007', shelf_id: 'A', bin_id: 1 }
      }, OPTS);
      expect(res.ok).toBe(true);
      expect(await history(id)).toHaveLength(0);
    });

    it('applyLocationChange reports the flips and conflicts without touching vessels', async function () {
      await addVessel('PCB-008', 'In-Use');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-008', shelf_id: 'A', bin_id: '1' });
      var current = await row(id);
      var ok = await upd.applyLocationChange(client(), current, { vessel_id: 'PCB-009', shelf_id: 'A', bin_id: '1', notes: 'n' }, OPTS);
      expect(ok.ok).toBe(true);
      expect(ok.vesselChanges).toEqual([
        { vessel_id: 'PCB-008', status: 'Empty' },
        { vessel_id: 'PCB-009', status: 'In-Use' }
      ]);
      expect(await vstatus('PCB-008')).toBe('In-Use');
      expect(await history(id)).toHaveLength(1);
    });
  });

  describe('status changes', function () {
    it('pending is not a valid target: no history, no vessel change, even with a location change', async function () {
      await addVessel('PCB-010', 'In-Use');
      await addVessel('PCB-011', 'Empty');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-010', shelf_id: 'A', bin_id: '1' });
      var res = await upd.updateBatch(client(), {
        batch_id: id, updates: { status: 'pending', vessel_id: 'PCB-011' }
      }, OPTS);
      expect(res.error).toBe('invalid_status');
      expect(await history(id)).toHaveLength(0);
      expect(await vstatus('PCB-010')).toBe('In-Use');
      expect(await vstatus('PCB-011')).toBe('Empty');
      expect((await row(id)).status).toBe('primary');
    });

    it('primary -> complete frees the vessel, complete -> primary occupies it', async function () {
      await addVessel('PCB-012', 'In-Use');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-012', shelf_id: 'A', bin_id: '1' });
      await upd.updateBatch(client(), { batch_id: id, updates: { status: 'Complete' } }, OPTS);
      expect((await row(id)).status).toBe('complete');
      expect(await vstatus('PCB-012')).toBe('Empty');
      await upd.updateBatch(client(), { batch_id: id, updates: { status: 'primary' } }, OPTS);
      expect(await vstatus('PCB-012')).toBe('In-Use');
    });

    it('primary -> secondary leaves the vessel alone', async function () {
      await addVessel('PCB-013', 'In-Use');
      var id = await addBatch({ status: 'primary', vessel_id: 'PCB-013' });
      await upd.updateBatch(client(), { batch_id: id, updates: { status: 'secondary' } }, OPTS);
      expect(await vstatus('PCB-013')).toBe('In-Use');
    });

    it('a pending batch with a vessel does not mark it In-Use until activated (Q19)', async function () {
      await addVessel('PCB-014', 'Empty');
      var id = await addBatch({ status: 'pending', vessel_id: 'PCB-014', start_date: '2026-10-05' });
      expect(await vstatus('PCB-014')).toBe('Empty');
      await upd.updateBatch(client(), { batch_id: id, updates: { status: 'primary' } }, OPTS);
      expect(await vstatus('PCB-014')).toBe('In-Use');
    });

    describe('pending -> active fermentation_started_at precedence', function () {
      it('uses updates.fermentation_started_at first', async function () {
        var id = await addBatch({ status: 'pending', start_date: '2026-10-05' });
        await upd.updateBatch(client(), { batch_id: id, updates: {
          status: 'primary', fermentation_started_at: '2026-10-02T12:00:00.000Z', start_date: '2026-10-03'
        } }, OPTS);
        expect((await row(id)).fermentation_started_at.toISOString()).toBe('2026-10-02T12:00:00.000Z');
      });

      it('then updates.start_date', async function () {
        var id = await addBatch({ status: 'pending', start_date: '2026-10-05' });
        await upd.updateBatch(client(), { batch_id: id, updates: { status: 'primary', start_date: '2026-10-03' } }, OPTS);
        expect((await row(id)).fermentation_started_at.toISOString().slice(0, 10)).toBe('2026-10-03');
      });

      it('then the current start_date', async function () {
        var id = await addBatch({ status: 'pending', start_date: '2026-10-05' });
        await upd.updateBatch(client(), { batch_id: id, updates: { status: 'primary' } }, OPTS);
        expect((await row(id)).fermentation_started_at.toISOString().slice(0, 10)).toBe('2026-10-05');
      });

      it('else now', async function () {
        var id = await addBatch({ status: 'pending' });
        await upd.updateBatch(client(), { batch_id: id, updates: { status: 'primary' } }, OPTS);
        expect((await row(id)).fermentation_started_at.getTime()).toBe(NOW.getTime());
      });
    });
  });
});

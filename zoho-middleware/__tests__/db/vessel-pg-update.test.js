'use strict';

/**
 * Real-Postgres vessel update / archive / status deltas — Phase 86 Plan 05
 * (DB-05, D-06/D-07/D-08/D-16). Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('vessel-pg update / archive / status', function () {
  var container;
  var pool;
  var vesselPg;
  var harness;
  var T0 = new Date('2026-01-01T00:00:00.000Z');
  var TOKEN = '2026-01-01T00:00:00.000Z';

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    vesselPg = require('../../lib/vessel-pg');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () {
    return pool;
  });

  function seed(client, id, status, archived) {
    return client.query(
      'insert into vessels (vessel_id, type, status, archived, updated_at) values ($1, $2, $3, $4, $5)',
      [id, 'Carboy', status || 'Empty', !!archived, T0]
    );
  }

  it('updates only provided allowlisted fields and bumps updated_at / updated_by', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    var now = new Date('2026-02-02T02:02:02.222Z');
    var res = await vesselPg.updateVessel(client, 'PCB-009',
      { label: 'Big one', location: ' Shelf ', capacity_liters: '23', archived: true, position: 99 },
      { actor: 'staff@x.co', now: now, expectedUpdatedAt: TOKEN });
    expect(res.ok).toBe(true);
    expect(res._vesselId).toBe('PCB-009');
    expect(res.vessel.label).toBe('Big one');
    expect(res.vessel.location).toBe('Shelf');
    expect(res.vessel.capacity_liters).toBe(23);
    expect(res.vessel.type).toBe('Carboy');
    expect(res.vessel.updated_at).toBe('2026-02-02T02:02:02.222Z');
    expect(res.vessel.archived).toBe(false);
    var row = (await client.query('select updated_by, position from vessels where vessel_id = $1', ['PCB-009'])).rows[0];
    expect(row.updated_by).toBe('staff@x.co');
    expect(Number(row.position)).not.toBe(99);
  });

  it('rejects missing or mismatched token with stale_vessel and does not write', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    var tokens = [undefined, '', 'garbage', '2026-01-01T00:00:00.001Z'];
    for (var i = 0; i < tokens.length; i++) {
      var res = await vesselPg.updateVessel(client, 'PCB-009', { label: 'X' }, { expectedUpdatedAt: tokens[i] });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('stale_vessel');
    }
    expect((await vesselPg.getVessel(client, 'PCB-009')).label).toBe('');
  });

  it('returns not_found, vessel_id_immutable, invalid_status, invalid_number', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    expect((await vesselPg.updateVessel(client, 'NOPE-001', { label: 'x' }, { expectedUpdatedAt: TOKEN })).error).toBe('not_found');
    expect((await vesselPg.updateVessel(client, 'PCB-009', { vessel_id: 'PCB-999' }, { expectedUpdatedAt: TOKEN })).error).toBe('vessel_id_immutable');
    expect((await vesselPg.updateVessel(client, 'PCB-009', { status: 'Disabled/Retired' }, { expectedUpdatedAt: TOKEN })).error).toBe('invalid_status');
    expect((await vesselPg.updateVessel(client, 'PCB-009', { depth_cm: 'abc' }, { expectedUpdatedAt: TOKEN })).error).toBe('invalid_number');
  });

  it('accepts a manual In-Use status override', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    var res = await vesselPg.updateVessel(client, 'PCB-009', { status: 'In-Use' }, { expectedUpdatedAt: TOKEN });
    expect(res.ok).toBe(true);
    expect(res.vessel.status).toBe('In-Use');
  });

  it('concurrency: second writer with the same token waits on the lock then gets stale_vessel', async function () {
    var s = await pool.connect();
    try {
      await s.query('begin');
      await seed(s, 'CNC-001');
      await s.query('commit');
    } finally {
      s.release();
    }
    var a = await pool.connect();
    var b = await pool.connect();
    try {
      await a.query('begin');
      await b.query('begin');
      var first = await vesselPg.updateVessel(a, 'CNC-001', { label: 'A' },
        { expectedUpdatedAt: TOKEN, now: new Date('2026-05-05T00:00:00.000Z') });
      expect(first.ok).toBe(true);
      var secondP = vesselPg.updateVessel(b, 'CNC-001', { label: 'B' },
        { expectedUpdatedAt: TOKEN, now: new Date('2026-05-06T00:00:00.000Z') });
      var settled = false;
      secondP.then(function () { settled = true; });
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      expect(settled).toBe(false);
      await a.query('commit');
      var second = await secondP;
      expect(second.error).toBe('stale_vessel');
      await b.query('rollback');
    } finally {
      a.release();
      b.release();
    }
    expect((await vesselPg.getVessel(pool, 'CNC-001')).label).toBe('A');
    await pool.query('delete from vessels where vessel_id = $1', ['CNC-001']);
  });

  it('archive keeps status, serialises Disabled/Retired; unarchive reverses', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    var res = await vesselPg.archiveVessel(client, 'PCB-009',
      { expectedUpdatedAt: TOKEN, now: new Date('2026-02-02T00:00:00.000Z'), actor: 'a@b.co' });
    expect(res.ok).toBe(true);
    expect(res.vessel.archived).toBe(true);
    expect(res.vessel.status).toBe('Disabled/Retired');
    var raw = (await client.query('select status, archived from vessels where vessel_id = $1', ['PCB-009'])).rows[0];
    expect(raw.status).toBe('Empty');
    var un = await vesselPg.unarchiveVessel(client, 'PCB-009', { expectedUpdatedAt: '2026-02-02T00:00:00.000Z' });
    expect(un.ok).toBe(true);
    expect(un.vessel.archived).toBe(false);
    expect(un.vessel.status).toBe('Empty');
  });

  it('archive is blocked while In-Use and respects the stale token', async function () {
    var client = harness.client();
    await seed(client, 'PCB-010', 'In-Use');
    expect((await vesselPg.archiveVessel(client, 'PCB-010', { expectedUpdatedAt: TOKEN })).error).toBe('vessel_in_use');
    expect((await vesselPg.archiveVessel(client, 'PCB-010', {})).error).toBe('stale_vessel');
    expect((await vesselPg.archiveVessel(client, 'NOPE-001', { expectedUpdatedAt: TOKEN })).error).toBe('not_found');
  });

  it('exports no delete function (D-07)', function () {
    expect(Object.keys(vesselPg).filter(function (k) { return /delete/i.test(k); })).toEqual([]);
  });

  it('applyStatusChanges is idempotent and classifies known / unknown / invalid', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    await seed(client, 'PCB-010');
    var changes = [
      { vessel_id: 'PCB-009', status: 'In-Use' },
      { vessel_id: 'NOPE-001', status: 'Empty' },
      { vessel_id: 'PCB-010', status: 'Weird' }
    ];
    var now = new Date('2026-03-03T00:00:00.000Z');
    var r1 = await vesselPg.applyStatusChanges(client, changes, { actor: 'a@b.co', now: now });
    expect(r1).toEqual({ applied: ['PCB-009'], unchanged: [], unknown: ['NOPE-001'], invalid: ['PCB-010'] });
    var after1 = await vesselPg.getVessel(client, 'PCB-009');
    expect(after1.status).toBe('In-Use');
    expect(after1.updated_at).toBe('2026-03-03T00:00:00.000Z');

    var r2 = await vesselPg.applyStatusChanges(client, changes, { actor: 'a@b.co', now: new Date('2026-04-04T00:00:00.000Z') });
    expect(r2.applied).toEqual([]);
    expect(r2.unchanged).toEqual(['PCB-009']);
    expect((await vesselPg.getVessel(client, 'PCB-009')).updated_at).toBe('2026-03-03T00:00:00.000Z');
  });

  it('applyStatusChanges changes status on an archived vessel but leaves archived true', async function () {
    var client = harness.client();
    await seed(client, 'PCB-011', 'Empty', true);
    var r = await vesselPg.applyStatusChanges(client, [{ vessel_id: 'PCB-011', status: 'In-Use' }], {});
    expect(r.applied).toEqual(['PCB-011']);
    var raw = (await client.query('select status, archived from vessels where vessel_id = $1', ['PCB-011'])).rows[0];
    expect(raw.status).toBe('In-Use');
    expect(raw.archived).toBe(true);
  });
});

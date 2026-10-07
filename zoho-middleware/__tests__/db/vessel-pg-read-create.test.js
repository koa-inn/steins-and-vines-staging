'use strict';

/**
 * Real-Postgres vessel read + create — Phase 86 Plan 05 (DB-05, SC2, D-07/D-17).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('vessel-pg read + create', function () {
  var container;
  var pool;
  var vesselPg;
  var harness;
  var T0 = new Date('2026-01-01T00:00:00.000Z');

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

  function seed(client, id, extra) {
    var v = Object.assign({ type: 'Carboy', status: 'Empty', archived: false }, extra || {});
    return client.query(
      'insert into vessels (vessel_id, type, capacity_liters, status, archived, bottom_diameter_cm, updated_at) ' +
      'values ($1, $2, $3, $4, $5, $6, $7)',
      [id, v.type, v.capacity === undefined ? null : v.capacity, v.status, v.archived,
        v.bottom === undefined ? null : v.bottom, T0]
    );
  }

  it('lists all rows in position order in the Apps Script shape', async function () {
    var client = harness.client();
    await seed(client, 'PCB-001', { capacity: '28.4', bottom: '30.5' });
    await seed(client, 'PCB-002', { archived: true, status: 'In-Use' });
    await seed(client, 'PCB-003');
    var list = await vesselPg.listVessels(client);
    expect(list.map(function (v) { return v.vessel_id; })).toEqual(['PCB-001', 'PCB-002', 'PCB-003']);
    expect(Object.keys(list[0])).toEqual(vesselPg.VESSEL_SHEET_COLUMNS.concat(['label', 'archived', 'updated_at', 'position']));
    expect(list[0].capacity_liters).toBe(28.4);
    expect(list[0].bottom_diameter_cm).toBe(30.5);
    expect(list[0].top_diameter_cm).toBe('');
    expect(list[0].location).toBe('');
    expect(list[0].updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof list[0].position).toBe('number');
    expect(list[1].archived).toBe(true);
    expect(list[1].status).toBe('Disabled/Retired');
    expect(list[2].archived).toBe(false);
    expect(list[2].status).toBe('Empty');
  });

  it('getVessel returns null for an unknown id', async function () {
    var client = harness.client();
    expect(await vesselPg.getVessel(client, 'NOPE-001')).toBeNull();
  });

  it('createVessel stores trimmed location, real actor, Empty status, sequence position', async function () {
    var client = harness.client();
    var now = new Date('2026-03-03T03:03:03.333Z');
    var res = await vesselPg.createVessel(client,
      { vessel_id: 'PCB-050', type: 'Carboy', capacity_liters: '23', location: ' Storage ' },
      { actor: 'owner@x.co', now: now });
    expect(res.ok).toBe(true);
    expect(res.vessel_id).toBe('PCB-050');
    expect(res._vesselId).toBe('PCB-050');
    expect(res.vessel.location).toBe('Storage');
    expect(res.vessel.capacity_liters).toBe(23);
    expect(res.vessel.status).toBe('Empty');
    expect(res.vessel.updated_at).toBe('2026-03-03T03:03:03.333Z');
    var row = (await client.query('select * from vessels where vessel_id = $1', ['PCB-050'])).rows[0];
    expect(row.created_by).toBe('owner@x.co');
    expect(row.updated_by).toBe('owner@x.co');
    expect(Number(row.position)).toBeGreaterThan(0);
  });

  it('rejects duplicates and bad input', async function () {
    var client = harness.client();
    await seed(client, 'PCB-001');
    var cases = [
      [{ vessel_id: 'PCB-001', type: 'Carboy' }, 'vessel_exists'],
      [{ vessel_id: 'pcb-50', type: 'Carboy' }, 'invalid_vessel_id'],
      [{ vessel_id: 'PCB-051' }, 'missing_fields'],
      [{ vessel_id: 'PCB-051', type: 'Carboy', status: 'Broken' }, 'invalid_status'],
      [{ vessel_id: 'PCB-051', type: 'Carboy', capacity_liters: 'abc' }, 'invalid_number']
    ];
    for (var i = 0; i < cases.length; i++) {
      var res = await vesselPg.createVessel(client, cases[i][0], { actor: 'a@b.co' });
      expect(res.ok).toBe(false);
      expect(res.error).toBe(cases[i][1]);
    }
    expect(await vesselPg.getVessel(client, 'PCB-051')).toBeNull();
  });

  it('sanitises text fields', async function () {
    var client = harness.client();
    var res = await vesselPg.createVessel(client,
      { vessel_id: 'PCB-060', type: '<script>x</script>Tank' }, { actor: 'a@b.co' });
    expect(res.ok).toBe(true);
    expect(res.vessel.type).toBe('Tank');
  });

  it('nextVesselNumber returns max suffix + 1, 3-digit padded', async function () {
    var client = harness.client();
    await seed(client, 'PCB-009');
    await seed(client, 'PCB-012');
    expect(await vesselPg.nextVesselNumber(client, 'PCB')).toBe('PCB-013');
    expect(await vesselPg.nextVesselNumber(client, 'NEW')).toBe('NEW-001');
    await expect(vesselPg.nextVesselNumber(client, 'pcb')).rejects.toThrow();
  });
});

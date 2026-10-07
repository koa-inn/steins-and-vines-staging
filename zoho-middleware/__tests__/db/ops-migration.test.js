'use strict';

/**
 * Real-Postgres schema invariants for migrations/0004_ops_data.sql — Phase 86 Plan 01 (DB-05, ROADMAP SC1).
 *
 * Runs ONLY via `npm run test:db`, gated by describeDb() (skipped locally without Docker).
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('0004_ops_data migration (ROADMAP SC1)', function () {
  var container;
  var pool;
  var harness;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    var migrateResult = applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }
    var pg = require('pg');
    pool = new pg.Pool({ connectionString: started.connectionString });
  }, 120000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  // Runs fn inside a savepoint so a failed statement does not abort the test transaction.
  async function expectFails(c, fn, pattern) {
    await c.query('savepoint sp');
    var failed = false;
    try {
      await fn();
    } catch (e) {
      failed = true;
      if (pattern) expect(e.message).toMatch(pattern);
    }
    await c.query('rollback to savepoint sp');
    expect(failed).toBe(true);
  }

  function insertSchedule(c, id, steps) {
    var cols = ['name', 'steps', 'created_at', 'updated_at'];
    var vals = ["'Test'", "'" + (steps || '[]') + "'::jsonb", 'now()', 'now()'];
    if (id) { cols.unshift('schedule_id'); vals.unshift("'" + id + "'"); }
    return c.query('insert into ferm_schedules (' + cols.join(', ') + ') values (' + vals.join(', ') + ') returning *');
  }

  function insertVessel(c, id, extra) {
    var cols = ['vessel_id', 'type', 'updated_at'];
    var vals = ["'" + id + "'", "'Carboy'", 'now()'];
    if (extra) { cols.push(extra.col); vals.push(extra.val); }
    return c.query('insert into vessels (' + cols.join(', ') + ') values (' + vals.join(', ') + ') returning *');
  }

  it('creates the five tables and both sequences', async function () {
    var c = harness.client();
    var t = await c.query("select table_name from information_schema.tables where table_name in ('vessels','ferm_schedules','config','staff_access','staff_access_audit')");
    expect(t.rows.length).toBe(5);
    var s = await c.query("select sequence_name from information_schema.sequences where sequence_name in ('ferm_schedule_id_seq','vessel_position_seq')");
    expect(s.rows.length).toBe(2);
  });

  it('mints FS- ids from the sequence and accepts explicit ids', async function () {
    var c = harness.client();
    await c.query("select setval('ferm_schedule_id_seq', 1, false)");
    var r = await insertSchedule(c, null);
    expect(r.rows[0].schedule_id).toBe('FS-0001');
    var e = await insertSchedule(c, 'FS-0011');
    expect(e.rows[0].schedule_id).toBe('FS-0011');
    var big = await insertSchedule(c, 'FS-10000');
    expect(big.rows[0].schedule_id).toBe('FS-10000');
  });

  it('rejects malformed schedule ids', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertSchedule(c, 'FS-12'); });
    await expectFails(c, function () { return insertSchedule(c, 'X-0001'); });
  });

  it('requires steps to be a jsonb array and is_active a real boolean', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertSchedule(c, 'FS-0020', '{}'); });
    var r = await insertSchedule(c, 'FS-0021', '[]');
    expect(r.rows[0].is_active).toBe(true);
    await expectFails(c, function () {
      return c.query("insert into ferm_schedules (name, steps, is_active, created_at, updated_at) values ('x','[]'::jsonb,null,now(),now())");
    });
  });

  it('constrains vessel ids and status; archived is a separate boolean', async function () {
    var c = harness.client();
    await insertVessel(c, 'PCB-009');
    await insertVessel(c, 'PBCS-101');
    await expectFails(c, function () { return insertVessel(c, 'pcb-9'); });
    await expectFails(c, function () { return insertVessel(c, 'PCB-09'); });
    await expectFails(c, function () { return insertVessel(c, 'TOOLONGX-001'); });
    await expectFails(c, function () { return insertVessel(c, 'PCB-010', { col: 'status', val: "'Disabled/Retired'" }); });
    var r = await insertVessel(c, 'PCB-011');
    expect(r.rows[0].archived).toBe(false);
    expect(r.rows[0].status).toBe('Empty');
    expect(r.rows[0].location).toBeNull();
    expect(r.rows[0].label).toBeNull();
  });

  it('auto-assigns a unique vessel position and has no shelf/bin columns', async function () {
    var c = harness.client();
    var a = await insertVessel(c, 'PCB-001');
    var b = await insertVessel(c, 'PCB-002');
    expect(Number(b.rows[0].position)).toBeGreaterThan(Number(a.rows[0].position));
    await expectFails(c, function () { return insertVessel(c, 'PCB-003', { col: 'position', val: String(a.rows[0].position) }); }, /unique|duplicate/i);
    var cols = await c.query("select column_name from information_schema.columns where table_name = 'vessels' and (column_name ilike '%shelf%' or column_name ilike '%bin%')");
    expect(cols.rows.length).toBe(0);
  });

  it('round-trips capacity 28.4', async function () {
    var c = harness.client();
    var r = await insertVessel(c, 'PCB-004', { col: 'capacity_liters', val: '28.4' });
    expect(String(r.rows[0].capacity_liters)).toBe('28.4');
  });

  it('config rejects secret-like and malformed keys', async function () {
    var c = harness.client();
    await c.query("insert into config (key, value) values ('hold_expiry_hours', '24')");
    var bad = ['server_token', 'api_key', 'secret_x', 'admin_password', 'Bad-Key'];
    for (var j = 0; j < bad.length; j++) {
      await expectFails(c, function () { return c.query('insert into config (key, value) values ($1, $2)', [bad[j], 'v']); });
    }
  });

  it('staff_access enforces normalised email and role', async function () {
    var c = harness.client();
    await c.query("insert into staff_access (email, role, added_by) values ('a@b.co', 'owner', 'x@y.co')");
    await expectFails(c, function () { return c.query("insert into staff_access (email, role, added_by) values ('A@B.co', 'owner', 'x')"); });
    await expectFails(c, function () { return c.query("insert into staff_access (email, role, added_by) values (' a@b.co', 'owner', 'x')"); });
    await expectFails(c, function () { return c.query("insert into staff_access (email, role, added_by) values ('c@d.co', 'admin', 'x')"); });
  });

  it('staff_access_audit constrains action and defaults occurred_at', async function () {
    var c = harness.client();
    var actions = ['add', 'remove', 'role_change', 'denied'];
    for (var i = 0; i < actions.length; i++) {
      var r = await c.query("insert into staff_access_audit (actor_email, target_email, action) values ('a@b.co','c@d.co',$1) returning *", [actions[i]]);
      expect(r.rows[0].occurred_at).toBeTruthy();
    }
    await expectFails(c, function () { return c.query("insert into staff_access_audit (actor_email, target_email, action) values ('a@b.co','c@d.co','edit')"); });
    var t = await c.query("select data_type from information_schema.columns where table_name='staff_access_audit' and column_name='id'");
    expect(t.rows[0].data_type).toBe('bigint');
  });
});

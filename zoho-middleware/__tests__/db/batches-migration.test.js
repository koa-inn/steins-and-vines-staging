'use strict';

/**
 * Real-Postgres schema invariants for migrations/0005_batches.sql — Phase 87 Plan 02 (DB-06, ROADMAP SC1).
 *
 * Runs ONLY via `npm run test:db`, gated by describeDb() (skipped locally without Docker).
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

describeDb('0005_batches migration (ROADMAP SC1)', function () {
  var container;
  var pool;
  var harness;
  var token = 0;

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

  function nextToken() {
    token += 1;
    var hex = token.toString(16);
    return new Array(33 - hex.length).join('0') + hex;
  }

  // extra: map of column -> literal SQL value (overrides defaults)
  function insertBatch(c, extra) {
    var cols = { status: "'pending'", access_token: "'" + nextToken() + "'", created_at: 'now()', last_updated: 'now()' };
    Object.keys(extra || {}).forEach(function (k) { cols[k] = extra[k]; });
    var keys = Object.keys(cols);
    return c.query('insert into batches (' + keys.join(', ') + ') values (' + keys.map(function (k) { return cols[k]; }).join(', ') + ') returning *');
  }

  function insertTask(c, batchId, step) {
    return c.query("insert into batch_tasks (batch_id, step_number, day_offset, last_updated) values ('" + batchId + "', " + (step || 1) + ', 0, now()) returning *');
  }

  it('creates the six tables and four sequences', async function () {
    var c = harness.client();
    var t = await c.query("select table_name from information_schema.tables where table_name in ('batches','batch_tasks','plato_readings','vessel_history','batch_tombstones','batch_create_dedup')");
    expect(t.rows.length).toBe(6);
    var s = await c.query("select sequence_name from information_schema.sequences where sequence_name in ('batch_id_seq','batch_task_id_seq','plato_reading_id_seq','vessel_history_id_seq')");
    expect(s.rows.length).toBe(4);
  });

  it('generates sequence-backed ids and accepts explicit ids', async function () {
    var c = harness.client();
    var b = await insertBatch(c);
    expect(b.rows[0].batch_id).toMatch(/^SV-B-[0-9]{6}$/);
    var e = await insertBatch(c, { batch_id: "'SV-B-000229'" });
    expect(e.rows[0].batch_id).toBe('SV-B-000229');
    var t = await insertTask(c, b.rows[0].batch_id);
    expect(t.rows[0].task_id).toMatch(/^BT-[0-9]{6}$/);
    var r = await c.query("insert into plato_readings (batch_id, reading_at, created_at) values ('" + b.rows[0].batch_id + "', now(), now()) returning *");
    expect(r.rows[0].reading_id).toMatch(/^PR-[0-9]{6}$/);
    var h = await c.query("insert into vessel_history (batch_id, transferred_at) values ('" + b.rows[0].batch_id + "', now()) returning *");
    expect(h.rows[0].history_id).toMatch(/^VH-[0-9]{6}$/);
  });

  it('rejects malformed batch ids, statuses and tokens', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertBatch(c, { batch_id: "'SV-B-12'" }); }, /check/i);
    await expectFails(c, function () { return insertBatch(c, { status: "'active'" }); }, /check/i);
    await expectFails(c, function () { return insertBatch(c, { access_token: "'XYZ'" }); }, /check/i);
  });

  it('rejects a duplicate access_token', async function () {
    var c = harness.client();
    var tok = nextToken();
    await insertBatch(c, { access_token: "'" + tok + "'" });
    await expectFails(c, function () { return insertBatch(c, { access_token: "'" + tok + "'" }); }, /duplicate|unique/i);
  });

  it('cascades batch deletion to tasks, readings and history', async function () {
    var c = harness.client();
    var b = (await insertBatch(c)).rows[0].batch_id;
    await insertTask(c, b, 1);
    await c.query("insert into plato_readings (batch_id, reading_at, created_at) values ('" + b + "', now(), now())");
    await c.query("insert into vessel_history (batch_id, transferred_at) values ('" + b + "', now())");
    await c.query("delete from batches where batch_id = '" + b + "'");
    var tables = ['batch_tasks', 'plato_readings', 'vessel_history'];
    for (var i = 0; i < tables.length; i++) {
      var r = await c.query('select count(*)::int as n from ' + tables[i] + " where batch_id = '" + b + "'");
      expect(r.rows[0].n).toBe(0);
    }
  });

  it('rejects a task for a missing batch (FK)', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertTask(c, 'SV-B-999999'); }, /foreign key/i);
  });

  it('allows duplicate (batch_id, step_number) tasks', async function () {
    var c = harness.client();
    var b = (await insertBatch(c)).rows[0].batch_id;
    await insertTask(c, b, 3);
    await insertTask(c, b, 3);
    var r = await c.query("select count(*)::int as n from batch_tasks where batch_id = '" + b + "'");
    expect(r.rows[0].n).toBe(2);
  });

  it('enforces unit_seq uniqueness per invoice+sku only when unit_seq is set', async function () {
    var c = harness.client();
    var inv = { zoho_so_number: "'INV-1'", product_sku: "'SKU-A'", unit_seq: '1' };
    await insertBatch(c, inv);
    await expectFails(c, function () { return insertBatch(c, inv); }, /duplicate|unique/i);
    await insertBatch(c, { zoho_so_number: "'INV-2'", product_sku: "'SKU-A'" });
    await insertBatch(c, { zoho_so_number: "'INV-2'", product_sku: "'SKU-A'" });
  });

  it('enforces the schedule_id FK and allows NULL', async function () {
    var c = harness.client();
    await expectFails(c, function () { return insertBatch(c, { schedule_id: "'FS-9999'" }); }, /foreign key/i);
    var b = await insertBatch(c);
    expect(b.rows[0].schedule_id).toBeNull();
  });

  it('down migration drops 0005 objects and leaves 0004 intact', async function () {
    var fs = require('fs');
    var path = require('path');
    var sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '0005_batches.sql'), 'utf8');
    var down = sql.split('-- Down Migration')[1];
    var c = harness.client();
    await c.query(down);
    var gone = await c.query("select count(*)::int as n from information_schema.tables where table_name in ('batches','batch_tasks','plato_readings','vessel_history','batch_tombstones','batch_create_dedup')");
    expect(gone.rows[0].n).toBe(0);
    var seq = await c.query("select count(*)::int as n from information_schema.sequences where sequence_name in ('batch_id_seq','batch_task_id_seq','plato_reading_id_seq','vessel_history_id_seq')");
    expect(seq.rows[0].n).toBe(0);
    var kept = await c.query("select count(*)::int as n from information_schema.tables where table_name in ('vessels','ferm_schedules','config','staff_access','staff_access_audit')");
    expect(kept.rows[0].n).toBe(5);
  });
});

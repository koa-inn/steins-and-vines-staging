'use strict';

/**
 * SC4 automated leg: createBatch is fast on Postgres. The production stopwatch lives in a
 * later cutover plan. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('batch create latency', function () {
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
    var steps = [];
    for (var i = 0; i < 6; i++) steps.push({ step_number: i + 1, title: 'S' + i, description: '', day_offset: i * 3 });
    await pool.query(
      'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $4)',
      ['FS-0001', 'Six step', JSON.stringify(steps), NOW]
    );
    await pool.query("insert into vessels (vessel_id, type, status, updated_at) values ('FV-001', 'Fermenter', 'Empty', $1)", [NOW]);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  it('20 sequential scheduled creates with a vessel: median < 500 ms, max < 2000 ms', async function () {
    var client = await pool.connect();
    var times = [];
    try {
      for (var n = 0; n < 20; n++) {
        var t0 = process.hrtime.bigint();
        await client.query('begin');
        var res = await create.createBatch(client, {
          product_sku: 'SKU-' + n, customer_name: 'Ann', schedule_id: 'FS-0001', start_date: '2026-10-10',
          vessel_id: 'FV-001', shelf_id: 'S1', bin_id: String(n)
        }, { actor: 'staff@example.com', now: NOW });
        await client.query('commit');
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        expect(res.ok).toBe(true);
        expect(res.tasks_created).toBe(6);
      }
    } finally {
      client.release();
    }
    times.sort(function (a, b) { return a - b; });
    expect(times[10]).toBeLessThan(500);
    expect(times[19]).toBeLessThan(2000);
  });
});

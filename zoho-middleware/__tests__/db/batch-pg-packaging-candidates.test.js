'use strict';

/**
 * Real-Postgres getPackagingMatchCandidates — Phase 97 Plan 06. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('batch-pg-packaging-candidates', function () {
  var container;
  var pool;
  var read;
  var harness;

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    read = require('../../lib/batch-pg-read');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });

  function client() { return harness.client(); }

  function tok(n) {
    var s = String(n);
    while (s.length < 32) s = 'a' + s;
    return s;
  }

  async function insertBatch(n, status, email, inviteEmail) {
    var id = 'SV-B-' + String(n).padStart(6, '0');
    await client().query(
      'insert into batches (batch_id, status, start_date, batch_type, batch_type_source, customer_email, ' +
      'bottling_invite_email, zoho_so_number, access_token, created_at, last_updated, vessel_id, source) ' +
      "values ($1,$2,'2026-10-01','wine','name',$3,$4,'',$5, now(), now(), 'V1', 'kiosk')",
      [id, status, email, inviteEmail, tok(n)]);
    return id;
  }

  async function addTask(id, step, due, packaging, completed) {
    await client().query(
      'insert into batch_tasks (batch_id, step_number, day_offset, due_date, is_packaging, completed, last_updated) ' +
      'values ($1, $2, 1, $3, $4, $5, now())', [id, step, due, packaging, completed]);
  }

  it('returns active batches with earliest open packaging due date', async function () {
    var a = await insertBatch(1, 'primary', 'ann@x.com', 'bob@x.com');
    var b = await insertBatch(2, 'secondary', 'cy@x.com', '');
    await insertBatch(3, 'pending', 'p@x.com', '');
    await insertBatch(4, 'complete', 'c@x.com', '');
    await addTask(a, 1, '2026-11-20', true, false);
    await addTask(a, 2, '2026-11-10', true, false);
    await addTask(a, 3, '2026-11-01', true, true);
    await addTask(a, 4, '2026-11-02', false, false);
    await addTask(b, 1, null, true, false);
    var rows = await read.getPackagingMatchCandidates(client());
    expect(rows).toEqual([
      { batch_id: 'SV-B-000001', customer_email: 'ann@x.com', bottling_invite_email: 'bob@x.com', packaging_due: '2026-11-10' },
      { batch_id: 'SV-B-000002', customer_email: 'cy@x.com', bottling_invite_email: '', packaging_due: null }
    ]);
  });
});

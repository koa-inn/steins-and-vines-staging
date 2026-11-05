'use strict';

/**
 * Real-Postgres getDashboardStats inviteSentIds — Phase 98 Plan 01 (A4, D-14). Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('batch-pg-invite-sent-98', function () {
  var container;
  var pool;
  var read;
  var harness;
  var NOW = new Date('2026-10-23T06:30:00.000Z');

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

  async function insertBatch(n) {
    var id = 'SV-B-' + String(n).padStart(6, '0');
    await client().query(
      'insert into batches (batch_id, status, start_date, batch_type, batch_type_source, customer_name, notes, ' +
      'recipe_snapshot, zoho_so_number, access_token, created_at, last_updated, vessel_id, source) ' +
      "values ($1,'primary','2026-10-01','wine','name','Secret Person','private','','',$2, now(), now(), 'V1', 'kiosk')",
      [id, tok(n)]);
    return id;
  }

  async function stamp(id) {
    await client().query('update batches set bottling_invite_sent_at = now() where batch_id = $1', [id]);
  }

  test('returns ids of stamped batches only, ordered', async function () {
    var a = await insertBatch(1);
    await insertBatch(2);
    var c = await insertBatch(3);
    await stamp(c);
    await stamp(a);
    var res = await read.getDashboardStats(client(), { now: NOW });
    expect(res.data.inviteSentIds).toEqual([a, c]);
  });

  test('empty array when none stamped', async function () {
    await insertBatch(1);
    var res = await read.getDashboardStats(client(), { now: NOW });
    expect(res.data.inviteSentIds).toEqual([]);
  });

  test('ids only: strings, no email or timestamp', async function () {
    var a = await insertBatch(1);
    await stamp(a);
    var res = await read.getDashboardStats(client(), { now: NOW });
    res.data.inviteSentIds.forEach(function (x) { expect(typeof x).toBe('string'); });
    var blob = JSON.stringify(res.data.inviteSentIds);
    expect(blob).not.toContain('@');
    expect(blob).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

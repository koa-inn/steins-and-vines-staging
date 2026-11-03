'use strict';

/**
 * Real-Postgres getDashboardCardFacts — Phase 97 Plan 04. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('batch-pg-card-facts', function () {
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

  async function insertBatch(n, status, snapshot) {
    var id = 'SV-B-' + String(n).padStart(6, '0');
    await client().query(
      'insert into batches (batch_id, status, start_date, batch_type, batch_type_source, customer_name, notes, ' +
      'recipe_snapshot, zoho_so_number, access_token, created_at, last_updated, vessel_id, source) ' +
      "values ($1,$2,'2026-10-01','wine','name','secret@person.example','private',$3,'',$4, now(), now(), 'V1', 'kiosk')",
      [id, status, snapshot, tok(n)]);
    return id;
  }

  it('returns one whitelisted row per primary/secondary batch only', async function () {
    var snap = JSON.stringify({ abv: 4.8, ibu: 20, batch_size_l: 28, ingredients: [
      { item_name: 'Apple Juice', cf_type: 'Juice' }, { item_name: 'M02', cf_type: 'Yeast' }] });
    await insertBatch(1, 'pending', snap);
    await insertBatch(2, 'primary', snap);
    await insertBatch(3, 'secondary', '');
    await insertBatch(4, 'complete', snap);
    await insertBatch(5, 'disabled', snap);
    var rows = await read.getDashboardCardFacts(client());
    expect(rows.map(function (r) { return r.batch_id; })).toEqual(['SV-B-000002', 'SV-B-000003']);
    expect(rows[0]).toEqual({ batch_id: 'SV-B-000002', abv: 4.8, ibu: 20, batch_size_l: 28, juice: 'Apple Juice', yeast: 'M02' });
    rows.forEach(function (r) {
      expect(Object.keys(r).sort()).toEqual(['abv', 'batch_id', 'batch_size_l', 'ibu', 'juice', 'yeast']);
    });
    var json = JSON.stringify(rows);
    expect(json).not.toContain('secret@person.example');
    expect(json).not.toContain('recipe_snapshot');
  });
});

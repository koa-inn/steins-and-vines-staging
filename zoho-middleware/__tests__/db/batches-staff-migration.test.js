'use strict';

/**
 * Real-Postgres check of migration 0008 — Phase 95 Plan 01.
 * batches.staff_batch is boolean not null default false. Runs only via `npm run test:db`.
 */

var path = require('path');
var childProcess = require('child_process');
var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('migration 0008 batches staff_batch', function () {
  var container;
  var pool;
  var connectionString;

  function colQuery() {
    return pool.query(
      "select column_name, data_type, is_nullable, column_default from information_schema.columns " +
      "where table_name = 'batches' and column_name = 'staff_batch'");
  }

  function migrate(direction, count) {
    var bin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'node-pg-migrate');
    var dir = path.join(__dirname, '..', '..', 'migrations');
    var args = [direction];
    if (count) args.push(String(count));
    args.push('-m', dir);
    return childProcess.spawnSync(bin, args, {
      env: Object.assign({}, process.env, { DATABASE_URL: connectionString }),
      encoding: 'utf8'
    });
  }

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    connectionString = started.connectionString;
    var migrateResult = pgHarness.applyMigrations(connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    pool = db.createPool(connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  it('adds a not-null boolean defaulting to false', async function () {
    var res = await colQuery();
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].data_type).toBe('boolean');
    expect(res.rows[0].is_nullable).toBe('NO');
    expect(res.rows[0].column_default).toBe('false');
  });

  it('reads false on a minimal insert', async function () {
    var ins = await pool.query(
      "insert into batches (status, access_token, created_at, last_updated) " +
      "values ('pending', repeat('a', 32), now(), now()) returning staff_batch");
    expect(ins.rows[0].staff_batch).toBe(false);
    await pool.query('delete from batches');
  });

  it('rolls back and re-applies cleanly', async function () {
    var down = migrate('down', 2); // 0009 (Phase 97) then 0008
    expect(down.status).toBe(0);
    expect((await colQuery()).rows.length).toBe(0);
    var up = migrate('up');
    expect(up.status).toBe(0);
    expect((await colQuery()).rows.length).toBe(1);
  }, 60000);
});

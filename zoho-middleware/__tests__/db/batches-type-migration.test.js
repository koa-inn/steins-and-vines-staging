'use strict';

/**
 * Real-Postgres check of migration 0007 — Phase 94 Plan 01.
 * batches.batch_type / batch_type_source / completed_at_source are plain nullable text columns.
 * Runs only via `npm run test:db`.
 */

var path = require('path');
var childProcess = require('child_process');
var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var COLS = ['batch_type', 'batch_type_source', 'completed_at_source'];

describeDb('migration 0007 batches type columns', function () {
  var container;
  var pool;
  var connectionString;

  function colQuery() {
    return pool.query(
      "select column_name, data_type, is_nullable from information_schema.columns " +
      "where table_name = 'batches' and column_name = any($1) order by column_name", [COLS]);
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
    var started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;
    var migrateResult = applyMigrations(connectionString);
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

  it('adds three nullable text columns', async function () {
    var res = await colQuery();
    expect(res.rows).toEqual([
      { column_name: 'batch_type', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'batch_type_source', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'completed_at_source', data_type: 'text', is_nullable: 'YES' }
    ]);
  });

  it('leaves the columns NULL on a minimal insert', async function () {
    var ins = await pool.query(
      "insert into batches (status, access_token, created_at, last_updated) " +
      "values ('pending', repeat('a', 32), now(), now()) " +
      "returning batch_type, batch_type_source, completed_at_source");
    expect(ins.rows[0]).toEqual({ batch_type: null, batch_type_source: null, completed_at_source: null });
    await pool.query('delete from batches');
  });

  it('rolls back and re-applies cleanly', async function () {
    // Roll back 0009 (recipes target gravity, Phase 97), 0008 (staff_batch, Phase 95) and then 0007; this test is coupled to the latest migration.
    var down = migrate('down', 3);
    expect(down.status).toBe(0);
    expect((await colQuery()).rows.length).toBe(0);
    var up = migrate('up');
    expect(up.status).toBe(0);
    expect((await colQuery()).rows.length).toBe(3);
  }, 60000);
});

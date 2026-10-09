'use strict';

/**
 * Real-Postgres end-to-end tests for the batches backfill CLI - Phase 87 Plan 05 (DB-06,
 * ROADMAP SC3). Runs ONLY via `npm run test:db`, gated by describeDb().
 * Synthetic data only; builds a throwaway .xlsx with ExcelJS in os.tmpdir().
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var ExcelJS = require('exceljs');

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var backfill = require('../../scripts/backfill/batches-backfill');
var EXIT = backfill.EXIT;

var BATCH_HEADERS = require('../../scripts/backfill/specs/batches').columns.map(function (c) { return c.header; });
var TASK_HEADERS = require('../../scripts/backfill/specs/batch-tasks').columns.map(function (c) { return c.header; });
var READING_HEADERS = require('../../scripts/backfill/specs/plato-readings-final').columns.map(function (c) { return c.header; });
var HISTORY_HEADERS = require('../../scripts/backfill/specs/vessel-history-final').columns.map(function (c) { return c.header; });

function pad6(n) { return ('000000' + n).slice(-6); }
function tok(n) { return ('00000000000000000000000000000000' + n).slice(-32).replace(/0/g, 'a'); }

function batch(n, overrides) {
  return Object.assign({
    batch_id: 'SV-B-' + pad6(n), status: 'primary', product_sku: 'K1', product_name: 'Pale Ale',
    customer_name: 'Test Person', start_date: new Date(Date.UTC(2026, 0, 5)), access_token: tok(n),
    created_at: '2026-01-01T10:00:00Z', last_updated: '2026-01-02T10:00:00Z', source: 'manual', bin_id: 7
  }, overrides || {});
}

function task(n, batchId, overrides) {
  return Object.assign({
    task_id: 'BT-' + pad6(n), batch_id: batchId, step_number: n, title: 'Step', day_offset: 0,
    due_date: new Date(Date.UTC(2026, 0, 6)), is_packaging: false, is_transfer: false, completed: true,
    last_updated: '2026-01-03T10:00:00Z'
  }, overrides || {});
}

function reading(n, batchId) {
  return {
    reading_id: 'PR-' + pad6(n), batch_id: batchId, timestamp: new Date(Date.UTC(2026, 0, 7, 9, 30)),
    degrees_plato: 12.5, created_at: '2026-01-07T17:30:00Z', temperature: 18.25
  };
}

function hist(n, batchId) {
  return { history_id: 'VH-' + pad6(n), batch_id: batchId, vessel_id: 'FV-001', bin_id: 7, transferred_at: '2026-01-05T10:00:00Z' };
}

function addSheet(workbook, name, headers, rows) {
  var ws = workbook.addWorksheet(name);
  ws.addRow(headers);
  rows.forEach(function (r) {
    ws.addRow(headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; }));
  });
}

function cleanData() {
  return {
    batches: [
      batch(1, { schedule_id: 'FS-0001', zoho_so_number: 'INV-1', created_at: '2026-01-02T10:00:00Z' }),
      batch(2, { zoho_so_number: 'INV-1', created_at: '2026-01-01T10:00:00Z' }),
      batch(229, { status: 'complete' }),
      {} // formatted-but-empty tail row
    ],
    tasks: [task(1, 'SV-B-000001'), task(2, 'SV-B-000001'), task(1047, 'SV-B-000229')],
    readings: [reading(71, 'SV-B-000001')],
    history: [hist(415, 'SV-B-000002')]
  };
}

function buildFixtureXlsx(data) {
  var workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'Batches', BATCH_HEADERS, data.batches);
  addSheet(workbook, 'BatchTasks', TASK_HEADERS, data.tasks);
  addSheet(workbook, 'PlatoReadings', READING_HEADERS, data.readings);
  addSheet(workbook, 'VesselHistory', HISTORY_HEADERS, data.history);
  var filePath = path.join(
    os.tmpdir(), 'batches-backfill-fixture-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.xlsx'
  );
  return workbook.xlsx.writeFile(filePath).then(function () { return filePath; });
}

function captureLog() {
  var lines = [];
  var log = function (msg) { lines.push(String(msg)); };
  log.lines = lines;
  return log;
}

function okPrompt() {
  return function () { return Promise.resolve(); };
}

describeDb('Batches backfill CLI (real Postgres, ROADMAP SC3)', function () {
  var container;
  var connectionString;
  var db;
  var pool;
  var outDir;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;

    var migrateResult = applyMigrations(connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr);
    }

    jest.resetModules();
    db = require('../../lib/db');
    pool = db.createPool(connectionString);
    process.env.BACKFILL_DATABASE_URL = connectionString;
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-batches-backfill-out-'));
  }, 120000);

  afterAll(async function () {
    delete process.env.BACKFILL_DATABASE_URL;
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  beforeEach(async function () {
    await pool.query(
      "insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) " +
      "values ('FS-0001', 'Pale', '[]', now(), now())"
    );
  });

  afterEach(async function () {
    await pool.query('delete from batch_create_dedup');
    await pool.query('delete from batch_tombstones');
    await pool.query('delete from batches'); // cascades to the child tables
    await pool.query('delete from ferm_schedules');
    await pool.query("select setval('batch_id_seq', 1, false)");
    await pool.query("select setval('batch_task_id_seq', 1, false)");
    await pool.query("select setval('plato_reading_id_seq', 1, false)");
    await pool.query("select setval('vessel_history_id_seq', 1, false)");
  });

  async function countRows(table) {
    var r = await pool.query('select count(*)::int as count from ' + table);
    return r.rows[0].count;
  }

  function spyPool() {
    var spy = { connects: 0, releases: 0 };
    spy.connect = function () {
      spy.connects++;
      return pool.connect().then(function (client) {
        var realRelease = client.release.bind(client);
        client.release = function () { spy.releases++; return realRelease(); };
        return client;
      });
    };
    return spy;
  }

  function args(file, extra) {
    return ['--file=' + file, '--out-dir=' + outDir, '--timezone=America/Vancouver'].concat(extra || []);
  }

  it('--dry-run on a clean workbook: exit 0, empty rejects, counts printed, no DB connection', async function () {
    var file = await buildFixtureXlsx(cleanData());
    var spy = spyPool();
    var log = captureLog();
    var dryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-batches-dry-'));

    var code = await backfill.runBatchesBackfill(
      ['--file=' + file, '--out-dir=' + dryDir, '--dry-run'], { pool: spy, log: log }
    );

    expect(code).toBe(EXIT.OK);
    var out = log.lines.join('\n');
    expect(out).toContain('3 batches, 3 tasks, 1 readings, 1 history rows');
    expect(out).toContain('0 rejects');
    expect(spy.connects).toBe(0);
    expect(await countRows('batches')).toBe(0);

    var files = fs.readdirSync(dryDir);
    expect(files.filter(function (f) { return f.indexOf('rejects-') === 0; })).toHaveLength(4);
    expect(files.filter(function (f) { return f.indexOf('batches-summary-') === 0; })).toHaveLength(1);
    files.filter(function (f) { return f.indexOf('rejects-') === 0; }).forEach(function (f) {
      expect(JSON.parse(fs.readFileSync(path.join(dryDir, f), 'utf8')).count).toBe(0);
    });
  });

  it('--dry-run with a reject exits 2 and writes the reject without any cell value', async function () {
    var data = cleanData();
    data.tasks.push(task(567, 'SV-B-000108', { title: 'CONFIDENTIAL TITLE' }));
    var file = await buildFixtureXlsx(data);
    var log = captureLog();
    var dryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-batches-rej-'));

    var code = await backfill.runBatchesBackfill(['--file=' + file, '--out-dir=' + dryDir, '--dry-run'], { log: log });

    expect(code).toBe(EXIT.REJECTS_BLOCK);
    var name = fs.readdirSync(dryDir).filter(function (f) { return f.indexOf('rejects-BatchTasks-') === 0; })[0];
    var report = JSON.parse(fs.readFileSync(path.join(dryDir, name), 'utf8'));
    expect(report.count).toBe(1);
    expect(report.rejects[0]).toEqual({
      sheet: 'BatchTasks', row: 5, id: 'BT-000567', field: 'batch_id', reason: 'orphan_parent'
    });
    expect(log.lines.join('\n')).not.toContain('CONFIDENTIAL');
  });

  it('--promote into empty tables: counts match, sequences seeded, FKs live', async function () {
    var file = await buildFixtureXlsx(cleanData());
    var spy = spyPool();
    var log = captureLog();

    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: spy, log: log, promptTypeDatabaseName: okPrompt()
    });

    expect(code).toBe(EXIT.OK);
    expect(spy.connects).toBe(1);
    expect(spy.releases).toBe(1);
    expect(await countRows('batches')).toBe(3);
    expect(await countRows('batch_tasks')).toBe(3);
    expect(await countRows('plato_readings')).toBe(1);
    expect(await countRows('vessel_history')).toBe(1);

    var b = await pool.query(
      "select batch_id, start_date, bin_id, unit_seq, schedule_id, created_at, access_token from batches order by batch_id"
    );
    expect(b.rows.map(function (r) { return r.unit_seq; })).toEqual([2, 1, null]);
    expect(b.rows[0].bin_id).toBe('7');
    expect(b.rows[0].schedule_id).toBe('FS-0001');
    // node-pg returns date columns as local-midnight Date objects: read local getters
    expect(b.rows[0].start_date.getFullYear()).toBe(2026);
    expect(b.rows[0].start_date.getMonth()).toBe(0);
    expect(b.rows[0].start_date.getDate()).toBe(5);
    expect(b.rows[0].created_at.toISOString()).toBe('2026-01-02T10:00:00.000Z');

    var r = await pool.query('select reading_at, degrees_plato, ph from plato_readings');
    expect(r.rows[0].reading_at.toISOString()).toBe('2026-01-07T17:30:00.000Z');
    expect(r.rows[0].degrees_plato).toBe('12.5');
    expect(r.rows[0].ph).toBeNull();

    var nextBatch = await pool.query("select nextval('batch_id_seq') as v");
    var nextTask = await pool.query("select nextval('batch_task_id_seq') as v");
    var nextReading = await pool.query("select nextval('plato_reading_id_seq') as v");
    var nextHistory = await pool.query("select nextval('vessel_history_id_seq') as v");
    expect([nextBatch.rows[0].v, nextTask.rows[0].v, nextReading.rows[0].v, nextHistory.rows[0].v].map(Number))
      .toEqual([230, 1048, 72, 416]);
  });

  it('after promote a new insert gets the next SV-B id and deleting a batch cascades', async function () {
    var file = await buildFixtureXlsx(cleanData());
    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: pool, log: captureLog(), promptTypeDatabaseName: okPrompt()
    });
    expect(code).toBe(EXIT.OK);

    var minted = await pool.query(
      "insert into batches (status, access_token, created_at, last_updated) " +
      "values ('pending', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', now(), now()) returning batch_id"
    );
    expect(minted.rows[0].batch_id).toBe('SV-B-000230');

    await pool.query("delete from batches where batch_id = 'SV-B-000001'");
    expect(await countRows('batch_tasks')).toBe(1);
    expect(await countRows('plato_readings')).toBe(0);
  });

  it('refuses a non-empty target (tombstones, then batches): exit 3, nothing written', async function () {
    var file = await buildFixtureXlsx(cleanData());
    await pool.query("insert into batch_tombstones (batch_id, deleted_at) values ('SV-B-000999', now())");
    var log = captureLog();

    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: pool, log: log, promptTypeDatabaseName: okPrompt()
    });

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(log.lines.join('\n')).toContain('target_not_empty');
    expect(await countRows('batches')).toBe(0);
    await pool.query('delete from batch_tombstones');

    await pool.query(
      "insert into batches (status, access_token, created_at, last_updated) " +
      "values ('pending', 'cccccccccccccccccccccccccccccccc', now(), now())"
    );
    var code2 = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: pool, log: captureLog(), promptTypeDatabaseName: okPrompt()
    });
    expect(code2).toBe(EXIT.CHECKS_FAILED);
    expect(await countRows('batches')).toBe(1);
    expect(await countRows('batch_tasks')).toBe(0);
  });

  it('refuses a batch that references a schedule missing from ferm_schedules: exit 3, nothing written', async function () {
    var data = cleanData();
    data.batches[0].schedule_id = 'FS-0099';
    var file = await buildFixtureXlsx(data);
    var log = captureLog();

    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: pool, log: log, promptTypeDatabaseName: okPrompt()
    });

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(log.lines.join('\n')).toContain('schedule_reference');
    expect(await countRows('batches')).toBe(0);
  });

  it('an invariant failure rolls everything back, exits 3 and names the check only', async function () {
    var file = await buildFixtureXlsx(cleanData());
    var spy = spyPool();
    var log = captureLog();

    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: spy,
      log: log,
      promptTypeDatabaseName: okPrompt(),
      runChecks: function () { return Promise.resolve({ ok: false, failedCheck: 'forced_check' }); }
    });

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(log.lines.join('\n')).toContain('Checks: FAIL - forced_check');
    expect(spy.releases).toBe(1);
    expect(await countRows('batches')).toBe(0);
    expect(await countRows('batch_tasks')).toBe(0);
    expect(await countRows('plato_readings')).toBe(0);
    expect(await countRows('vessel_history')).toBe(0);
  });

  it('a mismatching database-name prompt aborts with exit 1 and writes nothing', async function () {
    var file = await buildFixtureXlsx(cleanData());
    var code = await backfill.runBatchesBackfill(args(file, ['--promote']), {
      pool: pool,
      log: captureLog(),
      promptTypeDatabaseName: function () { return Promise.reject(new Error('mismatch')); }
    });
    expect(code).toBe(EXIT.ERROR);
    expect(await countRows('batches')).toBe(0);
  });

  it('refuses a Postgres URL in argv and a snapshot path inside the repo', async function () {
    var log = captureLog();
    var code = await backfill.runBatchesBackfill(['--file=x.xlsx', connectionString, '--promote'], { log: log });
    expect(code).toBe(EXIT.ERROR);
    expect(log.lines.join('\n')).toContain('BACKFILL_DATABASE_URL');
    expect(log.lines.join('\n')).not.toContain(connectionString);

    var inRepo = path.join(__dirname, 'snapshot.xlsx');
    var log2 = captureLog();
    var code2 = await backfill.runBatchesBackfill(['--file=' + inRepo, '--dry-run'], { log: log2 });
    expect(code2).toBe(EXIT.ERROR);
  });
});

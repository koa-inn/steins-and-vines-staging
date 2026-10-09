'use strict';

/**
 * Real-Postgres tests for the backfill pipeline's scratch-schema loader, checks,
 * promote gate and status — Phase 83 Plan 07 (DB-02 SC4).
 *
 * Runs ONLY via `npm run test:db` (jest.db.config.js), gated by describeDb()'s D-14 rule:
 * skipped locally without Docker, never skipped on CI.
 *
 * Task 2 extends this same file with backfill.js's CLI-level runBackfill() end-to-end
 * cases (xlsx-generated fixtures, exit codes, promote gate) — see the second describeDb
 * block below.
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var ExcelJS = require('exceljs');

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;
var startPostgres = pgHarness.startPostgres;
var applyMigrations = pgHarness.applyMigrations;

var load = require('../../scripts/backfill/load');
var normalizeRow = require('../../scripts/backfill/normalize').normalizeRow;
var platoReadingsSpec = require('../../scripts/backfill/specs/plato-readings');
var fermSchedulesSpec = require('../../scripts/backfill/specs/ferm-schedules');
var backfill = require('../../scripts/backfill/backfill');

var TIMEZONE = 'America/Vancouver';

// 0005 (Phase 87) migrates real batch tables, including public.plato_readings and an FK from
// batches onto ferm_schedules. These Phase 83 tests treat both as test-created promote
// targets, so drop the 0005 tables right after migrating to keep that premise true.
var DROP_PHASE87_TABLES =
  'drop table if exists public.vessel_history, public.plato_readings, public.batch_tasks, public.batches';

// Writes a throwaway .xlsx into os.tmpdir() (no Sheets API, matching D-09) with a
// PlatoReadings sheet built from raw (pre-normalisation) row objects keyed by header.
function buildPlatoReadingsXlsx(rows) {
  var workbook = new ExcelJS.Workbook();
  var worksheet = workbook.addWorksheet('PlatoReadings');
  var headers = platoReadingsSpec.columns.map(function (c) {
    return c.header;
  });
  worksheet.addRow(headers);
  rows.forEach(function (row) {
    worksheet.addRow(
      headers.map(function (h) {
        return row[h] !== undefined ? row[h] : '';
      })
    );
  });
  var filePath = path.join(
    os.tmpdir(),
    'backfill-fixture-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.xlsx'
  );
  return workbook.xlsx.writeFile(filePath).then(function () {
    return filePath;
  });
}

function captureLog() {
  var lines = [];
  var log = function (msg) {
    lines.push(String(msg));
  };
  log.lines = lines;
  return log;
}

// Builds a normalised row object from raw fixture values via the real normalizeRow
// pipeline (no .xlsx needed for this task — Task 2 adds the real-file round trip).
function normalize(spec, rawValuesByHeader) {
  var result = normalizeRow(spec, rawValuesByHeader, { timezone: TIMEZONE });
  if (!result.ok) {
    throw new Error('fixture failed to normalise: ' + JSON.stringify(result.reasons));
  }
  return result.values;
}

function platoRow(overrides) {
  var base = {
    reading_id: 'PR-000001',
    batch_id: 'SV-B-000001',
    timestamp: '2026-01-15T08:00:00Z',
    degrees_plato: '12.50',
    notes: '',
    recorded_by: 'staff',
    created_at: '2026-01-15T08:05:00Z',
    temperature: '',
    ph: ''
  };
  Object.assign(base, overrides || {});
  return normalize(platoReadingsSpec, base);
}

function fermRow(overrides) {
  var base = {
    schedule_id: 'FS-0001',
    name: 'Ale Primary',
    description: '',
    category: 'ale',
    steps: '[{"day":1,"action":"pitch"}]',
    is_active: 'TRUE',
    created_at: '2026-01-01T00:00:00Z',
    created_by: 'staff',
    last_updated: '2026-01-01T00:00:00Z'
  };
  Object.assign(base, overrides || {});
  return normalize(fermSchedulesSpec, base);
}

describeDb('backfill pipeline against real Postgres', function () {
  var container;
  var connectionString;
  var db;
  var pool;
  var client;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;

    var migrateResult = applyMigrations(connectionString);
    if (migrateResult.code !== 0) {
      throw new Error(
        'applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr
      );
    }

    jest.resetModules();
    db = require('../../lib/db');
    pool = db.createPool(connectionString);
    client = await pool.connect();
    await client.query(DROP_PHASE87_TABLES);
  }, 120000);

  afterAll(async function () {
    if (client) client.release();
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  afterEach(async function () {
    // Tests each manage their own schema/table lifecycle via loadScratch's
    // drop+create-on-every-load, but clean up scratch schemas and any test-created
    // public tables between tests so "no stray table" assertions hold.
    await client.query("drop schema if exists scratch_test cascade");
    await client.query('drop table if exists public.plato_readings');
    await client.query('drop table if exists public.ferm_schedules');
  });

  describe('assertScratchSchema', function () {
    it('throws on non-scratch-prefixed or unsafe names', function () {
      ['public', 'pg_catalog', 'scratch', 'scratch_x;drop', 'Scratch_1'].forEach(function (bad) {
        expect(function () {
          load.assertScratchSchema(bad);
        }).toThrow();
      });
    });

    it('accepts valid scratch_* names', function () {
      expect(load.assertScratchSchema('scratch_83')).toBe('scratch_83');
      expect(load.assertScratchSchema('scratch_rehearsal_1')).toBe('scratch_rehearsal_1');
    });
  });

  describe('loadScratch', function () {
    it('loads normalised PlatoReadings rows with typed columns; a second load REPLACES them', async function () {
      var rows = [
        platoRow({ reading_id: 'PR-000001' }),
        platoRow({ reading_id: 'PR-000002' }),
        platoRow({ reading_id: 'PR-000003' })
      ];

      var result = await load.loadScratch(client, {
        schema: 'scratch_test',
        spec: platoReadingsSpec,
        rows: rows
      });
      expect(result.inserted).toBe(3);

      var countCheck = await client.query('select count(*)::int as count from scratch_test.plato_readings');
      expect(countCheck.rows[0].count).toBe(3);

      var typeCheck = await client.query(
        "select data_type from information_schema.columns where table_schema='scratch_test' and table_name='plato_readings' and column_name='plato'"
      );
      expect(typeCheck.rows[0].data_type).toBe('numeric');
      var tsTypeCheck = await client.query(
        "select data_type from information_schema.columns where table_schema='scratch_test' and table_name='plato_readings' and column_name='timestamp'"
      );
      expect(tsTypeCheck.rows[0].data_type).toBe('timestamp with time zone');

      // Second load replaces, does not append.
      var secondRows = [platoRow({ reading_id: 'PR-000099' })];
      var secondResult = await load.loadScratch(client, {
        schema: 'scratch_test',
        spec: platoReadingsSpec,
        rows: secondRows
      });
      expect(secondResult.inserted).toBe(1);

      var afterSecond = await client.query('select count(*)::int as count from scratch_test.plato_readings');
      expect(afterSecond.rows[0].count).toBe(1);
    });

    it('loads FermSchedules rows with steps as jsonb (array) and active as boolean', async function () {
      var rows = [fermRow({ schedule_id: 'FS-0001' })];

      await load.loadScratch(client, {
        schema: 'scratch_test',
        spec: fermSchedulesSpec,
        rows: rows
      });

      var check = await client.query(
        "select jsonb_typeof(steps) as steps_type, active, pg_typeof(active)::text as active_type from scratch_test.ferm_schedules"
      );
      expect(check.rows[0].steps_type).toBe('array');
      expect(check.rows[0].active).toBe(true);
      expect(check.rows[0].active_type).toBe('boolean');
    });
  });

  describe('runChecks', function () {
    it('returns ok:true after a clean load', async function () {
      var rows = [
        platoRow({ reading_id: 'PR-000001', degrees_plato: '12.50' }),
        platoRow({ reading_id: 'PR-000002', degrees_plato: '11.00' })
      ];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      var result = await load.runChecks(client, {
        schema: 'scratch_test',
        spec: platoReadingsSpec,
        rows: rows
      });
      expect(result.ok).toBe(true);
    });

    it('returns ok:false naming the column and check after a tampered value', async function () {
      var rows = [platoRow({ reading_id: 'PR-000001', degrees_plato: '12.50' })];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      await client.query("update scratch_test.plato_readings set plato = '99.00' where reading_id = 'PR-000001'");

      var result = await load.runChecks(client, {
        schema: 'scratch_test',
        spec: platoReadingsSpec,
        rows: rows
      });
      expect(result.ok).toBe(false);
      var badResults = result.results.filter(function (r) {
        return !r.ok;
      });
      expect(badResults.length).toBeGreaterThan(0);
      expect(badResults.some(function (r) { return r.column === 'plato'; })).toBe(true);
    });
  });

  describe('text min/max collation', function () {
    it('agrees between JS default sort and Postgres COLLATE "C" for mixed-case values', async function () {
      var rows = [
        fermRow({ schedule_id: 'FS-0001', name: 'apple' }),
        fermRow({ schedule_id: 'FS-0002', name: 'Banana' }),
        fermRow({ schedule_id: 'FS-0003', name: 'cherry' })
      ];
      await load.loadScratch(client, { schema: 'scratch_test', spec: fermSchedulesSpec, rows: rows });

      var result = await load.runChecks(client, { schema: 'scratch_test', spec: fermSchedulesSpec, rows: rows });
      expect(result.ok).toBe(true);
    });
  });

  describe('promote', function () {
    it('throws when the target table does not exist', async function () {
      var rows = [platoRow({ reading_id: 'PR-000001' })];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      await expect(
        load.promote(client, { schema: 'scratch_test', spec: platoReadingsSpec, targetSchema: 'public' })
      ).rejects.toThrow('target table public.plato_readings does not exist');
    });

    it('promotes into an empty test-created public table; refuses a non-empty target with no rows added', async function () {
      var rows = [
        platoRow({ reading_id: 'PR-000001' }),
        platoRow({ reading_id: 'PR-000002' })
      ];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      await client.query(
        'create table public.plato_readings (' +
          'reading_id text primary key, batch_id text, "timestamp" timestamptz, ' +
          'plato numeric(5,2), notes text, recorded_by text, created_at timestamptz, ' +
          'temperature numeric(5,2), ph numeric(4,2))'
      );

      var result = await load.promote(client, {
        schema: 'scratch_test',
        spec: platoReadingsSpec,
        targetSchema: 'public'
      });
      expect(result.promoted).toBe(2);

      var countCheck = await client.query('select count(*)::int as count from public.plato_readings');
      expect(countCheck.rows[0].count).toBe(2);

      // Now non-empty — a second promote must refuse, no rows added.
      await expect(
        load.promote(client, { schema: 'scratch_test', spec: platoReadingsSpec, targetSchema: 'public' })
      ).rejects.toThrow('not empty');

      var countAfter = await client.query('select count(*)::int as count from public.plato_readings');
      expect(countAfter.rows[0].count).toBe(2);
    });
  });

  describe('dbStatus', function () {
    it('reports migrations, appMeta and scratch schemas on a freshly migrated container', async function () {
      var rows = [platoRow({ reading_id: 'PR-000001' })];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      var status = await load.dbStatus(client);
      expect(status.migrations).toContain('0001_init');
      expect(status.appMeta.schema_initialized_by).toBeDefined();
      expect(status.scratchSchemas).toContain('scratch_test');
    });
  });

  describe('table hygiene', function () {
    // Allowed set is derived from the committed migrations so each new additive migration
    // (Phase 84+) doesn't need a matching edit here; pgmigrations is the runner's own table.
    function migrationTables() {
      var dir = path.join(__dirname, '..', '..', 'migrations');
      var re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
      var found = ['pgmigrations'];
      fs.readdirSync(dir)
        .filter(function (f) {
          return /\.sql$/.test(f);
        })
        .forEach(function (f) {
          var sql = fs.readFileSync(path.join(dir, f), 'utf8');
          var m;
          while ((m = re.exec(sql)) !== null) found.push(m[1].toLowerCase());
        });
      return found;
    }

    it('no table other than the test-created target exists in public except migration-created tables and pgmigrations', async function () {
      var rows = [platoRow({ reading_id: 'PR-000001' })];
      await load.loadScratch(client, { schema: 'scratch_test', spec: platoReadingsSpec, rows: rows });

      var tables = await client.query(
        "select table_name from information_schema.tables where table_schema='public' order by table_name"
      );
      var names = tables.rows.map(function (r) {
        return r.table_name;
      });
      var allowed = migrationTables();
      expect(allowed).toContain('app_meta');
      names.forEach(function (n) {
        expect(allowed.indexOf(n)).not.toBe(-1);
      });
    });
  });
});

describeDb('backfill CLI end-to-end (runBackfill)', function () {
  var container;
  var connectionString;
  var db;
  var pool;

  beforeAll(async function () {
    var started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;

    var migrateResult = applyMigrations(connectionString);
    if (migrateResult.code !== 0) {
      throw new Error(
        'applyMigrations failed (code ' + migrateResult.code + '): ' + migrateResult.stderr
      );
    }

    jest.resetModules();
    db = require('../../lib/db');
    pool = db.createPool(connectionString);
    process.env.BACKFILL_DATABASE_URL = connectionString;
    await pool.query(DROP_PHASE87_TABLES);
  }, 120000);

  afterAll(async function () {
    delete process.env.BACKFILL_DATABASE_URL;
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  afterEach(async function () {
    var cleanupClient = await pool.connect();
    try {
      await cleanupClient.query('drop schema if exists scratch_backfill cascade');
      await cleanupClient.query('drop table if exists public.plato_readings');
    } finally {
      cleanupClient.release();
    }
  });

  // One fixture used by every end-to-end test: 4 rows, one with an unparseable
  // timestamp (rejected) and one with a '' optional temperature (accepted, becomes null).
  function buildFixture() {
    var rows = [
      {
        reading_id: 'PR-000001',
        batch_id: 'SV-B-000001',
        timestamp: '2026-01-15T08:00:00Z',
        degrees_plato: 12.5,
        notes: 'fixture-note-alpha',
        recorded_by: 'staff',
        created_at: '2026-01-15T08:05:00Z',
        temperature: 18.5,
        ph: 4.2
      },
      {
        reading_id: 'PR-000002',
        batch_id: 'SV-B-000001',
        timestamp: '2026-01-16T08:00:00Z',
        degrees_plato: 11.0,
        notes: 'fixture-note-beta',
        recorded_by: 'staff',
        created_at: '2026-01-16T08:05:00Z',
        temperature: '',
        ph: 4.1
      },
      {
        reading_id: 'PR-000003',
        batch_id: 'SV-B-000001',
        timestamp: '2026-01-17T08:00:00Z',
        degrees_plato: 10.5,
        notes: 'fixture-note-gamma',
        recorded_by: 'staff',
        created_at: '2026-01-17T08:05:00Z',
        temperature: 17.0,
        ph: ''
      },
      {
        reading_id: 'PR-000004',
        batch_id: 'SV-B-000001',
        timestamp: 'not-a-real-date',
        degrees_plato: 9.0,
        notes: 'fixture-note-delta',
        recorded_by: 'staff',
        created_at: '2026-01-18T08:05:00Z',
        temperature: 16.0,
        ph: 4.0
      }
    ];
    return buildPlatoReadingsXlsx(rows);
  }

  function createEmptyPublicTarget(pool) {
    return pool.connect().then(function (setupClient) {
      return setupClient
        .query(
          'create table public.plato_readings (' +
            'reading_id text primary key, batch_id text, "timestamp" timestamptz, ' +
            'plato numeric(5,2), notes text, recorded_by text, created_at timestamptz, ' +
            'temperature numeric(5,2), ph numeric(4,2))'
        )
        .then(function () {
          setupClient.release();
        });
    });
  }

  it('runs end-to-end without --promote: exitCode 0, scratch has 3 rows, rejects file has count 1', async function () {
    var filePath = await buildFixture();
    var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-backfill-out-'));
    var log = captureLog();

    try {
      var result = await backfill.runBackfill(
        {
          file: filePath,
          sheet: 'PlatoReadings',
          schema: 'scratch_backfill',
          timezone: TIMEZONE,
          outDir: outDir,
          promote: false,
          acceptRejects: false,
          status: false,
          dryRun: false,
          yes: true
        },
        { pool: pool, log: log }
      );

      expect(result.exitCode).toBe(backfill.EXIT.OK);
      expect(result.counts).toEqual({ read: 4, accepted: 3, rejected: 1 });
      expect(result.rejectsPath.indexOf(outDir)).toBe(0);

      var rejectsReport = JSON.parse(fs.readFileSync(result.rejectsPath, 'utf8'));
      expect(rejectsReport.count).toBe(1);

      var checkClient = await pool.connect();
      try {
        var countCheck = await checkClient.query(
          'select count(*)::int as count from scratch_backfill.plato_readings'
        );
        expect(countCheck.rows[0].count).toBe(3);
      } finally {
        checkClient.release();
      }

      log.lines.forEach(function (line) {
        expect(line).not.toMatch(/fixture-note-/);
      });
    } finally {
      fs.unlinkSync(filePath);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('promote:true without --accept-rejects -> exitCode 2 (REJECTS_BLOCK), target untouched', async function () {
    var filePath = await buildFixture();
    var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-backfill-out-'));
    var log = captureLog();

    await createEmptyPublicTarget(pool);

    try {
      var result = await backfill.runBackfill(
        {
          file: filePath,
          sheet: 'PlatoReadings',
          schema: 'scratch_backfill',
          timezone: TIMEZONE,
          outDir: outDir,
          promote: true,
          acceptRejects: false,
          status: false,
          dryRun: false,
          yes: true
        },
        { pool: pool, log: log }
      );

      expect(result.exitCode).toBe(backfill.EXIT.REJECTS_BLOCK);

      var checkClient = await pool.connect();
      try {
        var countCheck = await checkClient.query('select count(*)::int as count from public.plato_readings');
        expect(countCheck.rows[0].count).toBe(0);
      } finally {
        checkClient.release();
      }
    } finally {
      fs.unlinkSync(filePath);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('promote:true + --accept-rejects + empty target -> exitCode 0, target has 3 rows', async function () {
    var filePath = await buildFixture();
    var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-backfill-out-'));
    var log = captureLog();

    await createEmptyPublicTarget(pool);

    try {
      var result = await backfill.runBackfill(
        {
          file: filePath,
          sheet: 'PlatoReadings',
          schema: 'scratch_backfill',
          timezone: TIMEZONE,
          outDir: outDir,
          promote: true,
          acceptRejects: true,
          status: false,
          dryRun: false,
          yes: true
        },
        { pool: pool, log: log }
      );

      expect(result.exitCode).toBe(backfill.EXIT.OK);

      var checkClient = await pool.connect();
      try {
        var countCheck = await checkClient.query('select count(*)::int as count from public.plato_readings');
        expect(countCheck.rows[0].count).toBe(3);
      } finally {
        checkClient.release();
      }
    } finally {
      fs.unlinkSync(filePath);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('dryRun:true never calls pool.connect(); still writes the rejects report and prints counts', async function () {
    var filePath = await buildFixture();
    var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-backfill-out-'));
    var log = captureLog();
    var throwingPool = {
      connect: function () {
        throw new Error('pool.connect() must never be called in --dry-run');
      }
    };

    try {
      var result = await backfill.runBackfill(
        {
          file: filePath,
          sheet: 'PlatoReadings',
          schema: 'scratch_backfill',
          timezone: TIMEZONE,
          outDir: outDir,
          promote: false,
          acceptRejects: false,
          status: false,
          dryRun: true,
          yes: true
        },
        { pool: throwingPool, log: log }
      );

      expect(result.exitCode).toBe(backfill.EXIT.OK);
      expect(result.counts).toEqual({ read: 4, accepted: 3, rejected: 1 });
      expect(fs.existsSync(result.rejectsPath)).toBe(true);
      expect(
        log.lines.some(function (l) {
          return /Read 4, accepted 3, rejected 1/.test(l);
        })
      ).toBe(true);
    } finally {
      fs.unlinkSync(filePath);
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('status:true prints migrations and scratch schemas, exitCode 0', async function () {
    var log = captureLog();
    var result = await backfill.runBackfill({ status: true }, { pool: pool, log: log });

    expect(result.exitCode).toBe(backfill.EXIT.OK);
    expect(
      log.lines.some(function (l) {
        return /Migrations: .*0001_init/.test(l);
      })
    ).toBe(true);
  });
});

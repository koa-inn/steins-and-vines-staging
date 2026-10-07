'use strict';

/**
 * Real-Postgres end-to-end tests for the ops backfill CLI - Phase 86 Plan 09 Task 2
 * (DB-05, ROADMAP SC1). Runs ONLY via `npm run test:db`, gated by describeDb().
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

var opsBackfill = require('../../scripts/backfill/ops-backfill');
var EXIT = opsBackfill.EXIT;

var VESSEL_HEADERS = [
  'vessel_id', 'type', 'material', 'capacity_liters', 'status', 'bottom_diameter_cm',
  'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'
];
var SCHEDULE_HEADERS = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at',
  'created_by', 'last_updated'
];
var CONFIG_HEADERS = ['key', 'value'];

var GOOD_STEPS = JSON.stringify([
  { step_number: 1, day_offset: 0, title: 'Pitch' },
  { step_number: 2, day_offset: 14, title: 'Package', is_packaging: true }
]);

function vessel(overrides) {
  return Object.assign({
    vessel_id: 'FV-001', type: 'Fermenter', material: 'Steel', capacity_liters: 60, status: 'Empty',
    bottom_diameter_cm: 30, top_diameter_cm: 40, depth_cm: 70, location: 'Cellar', brand: '', notes: ''
  }, overrides || {});
}

function schedule(overrides) {
  return Object.assign({
    schedule_id: 'FS-0001', name: 'Pale', description: '', category: 'Beer', steps: GOOD_STEPS,
    is_active: true, created_at: '2026-01-15T08:00:00Z', created_by: 'maker@example.test',
    last_updated: '2026-01-16T08:00:00Z'
  }, overrides || {});
}

function cleanVessels() {
  return [
    vessel({ vessel_id: 'FV-001' }),
    vessel({ vessel_id: 'FV-002', status: 'In-Use' }),
    vessel({ vessel_id: 'BR-010', status: 'Disabled/Retired' }),
    vessel({ vessel_id: 'FV-003', location: 'Mobile, Wine Racking ' }),
    vessel({ vessel_id: 'FV-004', capacity_liters: '' })
  ];
}

function cleanSchedules() {
  return [
    schedule({ schedule_id: 'FS-0001' }),
    schedule({ schedule_id: 'FS-0002', is_active: 'FALSE' }),
    schedule({ schedule_id: 'FS-0011' })
  ];
}

function cleanConfig() {
  return [
    { key: 'hold_expiry_hours', value: '48' },
    { key: 'google_calendar_id', value: 'cal@group.calendar.example.test' },
    { key: 'staff_emails', value: 'a@x.co,b@y.co,c@z.co' }
  ];
}

function addSheet(workbook, name, headers, rows) {
  var ws = workbook.addWorksheet(name);
  ws.addRow(headers);
  rows.forEach(function (r) {
    ws.addRow(headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; }));
  });
}

function buildFixtureXlsx(vessels, schedules, config) {
  var workbook = new ExcelJS.Workbook();
  addSheet(workbook, 'Vessels', VESSEL_HEADERS, vessels);
  addSheet(workbook, 'FermSchedules', SCHEDULE_HEADERS, schedules);
  addSheet(workbook, 'Config', CONFIG_HEADERS, config);
  var filePath = path.join(
    os.tmpdir(), 'ops-backfill-fixture-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.xlsx'
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

var STAFF_ENV = 'A@x.co, b@y.co';

describeDb('Ops backfill CLI (real Postgres, ROADMAP SC1)', function () {
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
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ops-backfill-out-'));
  }, 120000);

  afterAll(async function () {
    delete process.env.BACKFILL_DATABASE_URL;
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  afterEach(async function () {
    var client = await pool.connect();
    try {
      await client.query('delete from staff_access');
      await client.query('delete from config');
      await client.query('delete from ferm_schedules');
      await client.query('delete from vessels');
      await client.query("select setval('ferm_schedule_id_seq', 1, false)");
      await client.query("select setval('vessel_position_seq', 1, false)");
    } finally {
      client.release();
    }
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
    return ['--file=' + file, '--owners=a@x.co', '--out-dir=' + outDir, '--timezone=America/Vancouver'].concat(extra || []);
  }

  function deps(extra) {
    return Object.assign({ env: { BACKFILL_STAFF_EMAILS: STAFF_ENV }, log: captureLog() }, extra || {});
  }

  it('--dry-run on a clean workbook: OK, counts printed, nothing written, no connect', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({ pool: spy });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--dry-run']), d);

    expect(code).toBe(EXIT.OK);
    var out = d.log.lines.join('\n');
    expect(out).toContain('5 vessels');
    expect(out).toContain('3 schedules');
    expect(out).toContain('0 rejects');
    expect(out).toContain('1 Config staff_emails entries not in the Railway list');
    expect(spy.connects).toBe(0);
    expect(await countRows('vessels')).toBe(0);
  });

  it('--promote into empty tables: counts match, sequences seeded, nextval defaults continue', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({ pool: spy, promptTypeDatabaseName: okPrompt() });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.OK);
    expect(spy.connects).toBe(1);
    expect(spy.releases).toBe(1);
    expect(await countRows('vessels')).toBe(5);
    expect(await countRows('ferm_schedules')).toBe(3);
    expect(await countRows('config')).toBe(2);

    var vessels = await pool.query('select vessel_id, position, status, archived, location from vessels order by position');
    expect(vessels.rows.map(function (v) { return v.vessel_id; })).toEqual(['FV-001', 'FV-002', 'BR-010', 'FV-003', 'FV-004']);
    expect(vessels.rows.map(function (v) { return Number(v.position); })).toEqual([1, 2, 3, 4, 5]);
    expect(vessels.rows[2]).toMatchObject({ archived: true, status: 'Empty' });
    expect(vessels.rows[3].location).toBe('Mobile, Wine Racking');

    var steps = await pool.query("select steps, is_active from ferm_schedules where schedule_id = 'FS-0002'");
    expect(Array.isArray(steps.rows[0].steps)).toBe(true);
    expect(steps.rows[0].is_active).toBe(false);

    var staff = await pool.query('select email, role, added_by from staff_access order by email');
    expect(staff.rows).toEqual([
      { email: 'a@x.co', role: 'owner', added_by: 'backfill' },
      { email: 'b@y.co', role: 'staff', added_by: 'backfill' }
    ]);

    var cfgKeys = await pool.query('select key from config order by key');
    expect(cfgKeys.rows.map(function (r) { return r.key; })).toEqual(['google_calendar_id', 'hold_expiry_hours']);

    var minted = await pool.query(
      "insert into ferm_schedules (name, steps, created_at, updated_at) values ('N', '[]', now(), now()) returning schedule_id"
    );
    expect(minted.rows[0].schedule_id).toBe('FS-0012');
    var mintedVessel = await pool.query(
      "insert into vessels (vessel_id, type, updated_at) values ('FV-099', 'Fermenter', now()) returning position"
    );
    expect(Number(mintedVessel.rows[0].position)).toBe(6);

    var out = d.log.lines.join('\n');
    expect(out).not.toContain('a@x.co');
    expect(out).not.toContain('b@y.co');
    expect(out).not.toContain('c@z.co');
  });

  it('any reject blocks: exit 2, rejects file written, promote does not connect', async function () {
    var vessels = cleanVessels();
    vessels[0] = vessel({ vessel_id: 'pcb-1' });
    var file = await buildFixtureXlsx(vessels, cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var rejectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ops-rejects-'));
    var d = deps({ pool: spy, promptTypeDatabaseName: okPrompt() });

    var dry = await opsBackfill.runOpsBackfill(['--file=' + file, '--owners=a@x.co', '--out-dir=' + rejectsDir, '--dry-run'], d);
    expect(dry).toBe(EXIT.REJECTS_BLOCK);
    var written = fs.readdirSync(rejectsDir).filter(function (f) { return f.indexOf('rejects-Vessels-') === 0; });
    expect(written.length).toBe(1);
    var report = JSON.parse(fs.readFileSync(path.join(rejectsDir, written[0]), 'utf8'));
    expect(report.count).toBe(1);

    var promote = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);
    expect(promote).toBe(EXIT.REJECTS_BLOCK);
    expect(spy.connects).toBe(0);
    expect(await countRows('vessels')).toBe(0);
  });

  it('refuses a non-empty target before BEGIN (exit 3), nothing else written', async function () {
    await pool.query("insert into config (key, value) values ('hold_expiry_hours', '1')");
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({ pool: spy, promptTypeDatabaseName: okPrompt() });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(d.log.lines.join('\n')).toContain('not empty');
    expect(spy.releases).toBe(1);
    expect(await countRows('vessels')).toBe(0);
    expect(await countRows('config')).toBe(1);
  });

  it('an owner-count invariant failure rolls everything back and names only the check', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({
      pool: spy,
      promptTypeDatabaseName: okPrompt(),
      planHook: function (plan) { plan.staff.forEach(function (s) { s.role = 'staff'; }); }
    });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(d.log.lines.join('\n')).toContain('owner_count');
    expect(spy.releases).toBe(1);
    expect(await countRows('vessels')).toBe(0);
    expect(await countRows('ferm_schedules')).toBe(0);
    expect(await countRows('staff_access')).toBe(0);
  });

  it('a count mismatch rolls back too', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var d = deps({
      pool: pool,
      promptTypeDatabaseName: okPrompt(),
      planHook: function (plan) { plan.counts.vessels += 1; }
    });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.CHECKS_FAILED);
    expect(d.log.lines.join('\n')).toContain('vessel_count');
    expect(await countRows('vessels')).toBe(0);
  });

  it('missing BACKFILL_STAFF_EMAILS on --promote exits 1 naming the variable', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({ pool: spy, env: {} });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.ERROR);
    expect(d.log.lines.join('\n')).toContain('BACKFILL_STAFF_EMAILS');
    expect(spy.connects).toBe(0);
  });

  it('missing --owners exits 1; a database URL in argv is refused', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var d1 = deps();
    expect(await opsBackfill.runOpsBackfill(['--file=' + file, '--dry-run'], d1)).toBe(EXIT.ERROR);
    expect(d1.log.lines.join('\n')).toContain('--owners');

    var d2 = deps();
    var code = await opsBackfill.runOpsBackfill(args(file, ['postgres://u:p@h/db']), d2);
    expect(code).toBe(EXIT.ERROR);
    expect(d2.log.lines.join('\n')).not.toContain('u:p@h');
  });

  it('a database-name prompt mismatch aborts before BEGIN', async function () {
    var file = await buildFixtureXlsx(cleanVessels(), cleanSchedules(), cleanConfig());
    var spy = spyPool();
    var d = deps({
      pool: spy,
      promptTypeDatabaseName: function () { return Promise.reject(new Error('database name confirmation did not match')); }
    });

    var code = await opsBackfill.runOpsBackfill(args(file, ['--promote']), d);

    expect(code).toBe(EXIT.ERROR);
    expect(spy.releases).toBe(1);
    expect(await countRows('vessels')).toBe(0);
  });
});

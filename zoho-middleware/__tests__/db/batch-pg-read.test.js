'use strict';

/**
 * Real-Postgres batch reads — Phase 87 Plan 06 (DB-06, D-01, D-06, D-14).
 * Every read is checked against the Apps Script golden outputs (87-03) over the synthetic
 * workbook. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var batchSeed = require('./helpers/batch-seed');
var golden = require('../fixtures/batches/golden.json');
var describeDb = pgHarness.describeDb;

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function tokenFor(n) {
  var s = String(n);
  while (s.length < 32) s = 'a' + s;
  return s;
}

describeDb('batch-pg-read', function () {
  var container;
  var pool;
  var read;
  var rules;
  var harness;
  var clock = { now: batchSeed.workbook.now, timezone: batchSeed.workbook.timezone };

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    read = require('../../lib/batch-pg-read');
    rules = require('../../lib/batch-rules');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () {
    return pool;
  });

  beforeEach(function () {
    return batchSeed.seed(harness.client());
  });

  function client() { return harness.client(); }

  describe('listBatches / listAllForIndex', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('getBatches:') === 0; }).forEach(function (key) {
      it(key, async function () {
        var p = key.split(':');
        var res = await read.listBatches(client(), { limit: Number(p[1]), offset: Number(p[2]), status: p[3] });
        expect(res.ok).toBe(true);
        expect(plain(res.data)).toEqual(golden[key]);
      });
    });

    it('never exposes access_token in a list row', async function () {
      var res = await read.listBatches(client(), { status: 'all' });
      res.data.batches.forEach(function (b) { expect(b).not.toHaveProperty('access_token'); });
    });

    it('listAllForIndex returns every batch in list shape', async function () {
      var all = await read.listAllForIndex(client());
      expect(plain(all)).toEqual(golden['getBatches:0:0:all'].batches);
      expect(all[0]).toHaveProperty('zoho_so_number');
      expect(all[0]).toHaveProperty('product_sku');
    });
  });

  describe('getBatchDetail', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('getBatchDetail:') === 0; }).forEach(function (key) {
      it(key, async function () {
        var id = key.slice('getBatchDetail:'.length);
        var res = await read.getBatchDetail(client(), id);
        expect(res.ok).toBe(true);
        expect(plain(res.data)).toEqual(golden[key]);
      });
    });

    it('reports an unknown id', async function () {
      var res = await read.getBatchDetail(client(), 'SV-B-999999');
      expect(res).toEqual({ ok: true, data: { error: 'Batch not found: SV-B-999999' } });
    });

    it('keeps access_token on the admin detail', async function () {
      var res = await read.getBatchDetail(client(), 'SV-B-000001');
      expect(res.data.batch.access_token).toBe(tokenFor(1));
    });
  });

  describe('getBatchPublic', function () {
    var CASES = {
      'valid': ['SV-B-000001', tokenFor(1)],
      'valid-duplicate-steps': ['SV-B-000002', tokenFor(2)],
      'valid-pending': ['SV-B-000005', tokenFor(5)],
      'wrong-token': ['SV-B-000001', tokenFor(2)],
      'malformed-token': ['SV-B-000001', 'abc123'],
      'malformed-batch-id': ['SV-B-1', tokenFor(1)],
      'missing-token': ['SV-B-000001', ''],
      'disabled': ['SV-B-000009', tokenFor(9)],
      'unknown-batch': ['SV-B-000099', tokenFor(1)]
    };
    Object.keys(CASES).forEach(function (name) {
      it(name, async function () {
        var res = await read.getBatchPublic(client(), CASES[name][0], CASES[name][1]);
        expect(plain(res)).toEqual(golden['handleGetBatchPublic:' + name]);
      });
    });

    it('strips customer_email, reservation_id and access_token', async function () {
      var res = await read.getBatchPublic(client(), 'SV-B-000001', tokenFor(1));
      expect(res.data.batch).not.toHaveProperty('customer_email');
      expect(res.data.batch).not.toHaveProperty('reservation_id');
      expect(res.data.batch).not.toHaveProperty('access_token');
    });

    it('rejects an uppercase-hex token without querying a match', async function () {
      var res = await read.getBatchPublic(client(), 'SV-B-000001', tokenFor(1).toUpperCase());
      expect(res.ok).toBe(false);
      expect(res.error).toBe('invalid_token');
    });
  });

  describe('findLocationConflict', function () {
    Object.keys(golden).filter(function (k) { return k.indexOf('checkLocationConflict:') === 0; }).forEach(function (key) {
      it(key, async function () {
        var i = golden[key].input;
        var res = await read.findLocationConflict(client(),
          { vessel_id: i.vessel_id, shelf_id: i.shelf_id, bin_id: i.bin_id }, i.exclude);
        expect(res).toBe(golden[key].result);
      });
    });

    it('is a literal partial-index predicate match and runs against the index', async function () {
      expect(read.LOCATION_CONFLICT_SQL).toContain("status in ('primary', 'secondary')");
      await client().query('set local enable_seqscan = off');
      var plan = await client().query('explain ' + read.LOCATION_CONFLICT_SQL, ['PCB-001', 'A', '1', '']);
      var text = plan.rows.map(function (r) { return r['QUERY PLAN']; }).join('\n');
      expect(text).toContain('batches_location_idx');
    });
  });

  describe('getBatchBundle', function () {
    it('returns sheet-keyed rows for the mirror', async function () {
      var bundle = await read.getBatchBundle(client(), 'SV-B-000001');
      var detail = golden['getBatchDetail:SV-B-000001'];
      expect(bundle.batch.batch_id).toBe('SV-B-000001');
      expect(bundle.batch.access_token).toBe(tokenFor(1));
      expect(bundle.batch.target_volume_L).toBe(23);
      expect(bundle.tasks.map(function (t) { return t.task_id; })).toEqual(['BT-000001', 'BT-000002', 'BT-000003']);
      expect(Object.keys(bundle.tasks[0])).toEqual(rules.TASK_COLUMNS);
      expect(Object.keys(bundle.readings[0])).toEqual(rules.READING_COLUMNS);
      expect(Object.keys(bundle.history[0])).toEqual(rules.HISTORY_COLUMNS);
      expect(bundle.readings).toHaveLength(detail.plato_readings.length);
      expect(bundle.history).toHaveLength(detail.vessel_history.length);
      expect(Object.keys(bundle.batch)).toEqual(rules.BATCH_COLUMNS);
    });

    it('returns null for an unknown batch', async function () {
      expect(await read.getBatchBundle(client(), 'SV-B-999999')).toBeNull();
    });
  });

  describe('lockBatch / counts', function () {
    it('locks an existing row and returns null for a missing one', async function () {
      var row = await read.lockBatch(client(), 'SV-B-000001');
      expect(row.batch_id).toBe('SV-B-000001');
      expect(await read.lockBatch(client(), 'SV-B-999999')).toBeNull();
    });

    it('counts batches by recipe and schedule as integers', async function () {
      expect(await read.countByRecipe(client(), 'RCP-000001')).toBe(1);
      expect(await read.countByRecipe(client(), 'RCP-999999')).toBe(0);
      expect(await read.countBySchedule(client(), 'FS-000001')).toBe(10);
      expect(await read.countBySchedule(client(), 'FS-000099')).toBe(0);
    });
  });

  describe('dashboard / calendar / upcoming', function () {
    it('getDashboardSummary equals the golden', async function () {
      var res = await read.getDashboardSummary(client(), clock);
      expect(res.ok).toBe(true);
      expect(plain(res.data)).toEqual(golden.getBatchDashboardSummary);
    });

    ['month', 'week', 'wide'].forEach(function (name) {
      var RANGES = {
        month: ['2026-10-01', '2026-10-31'],
        week: ['2026-10-11', '2026-10-17'],
        wide: ['2026-01-01', '2026-12-31']
      };
      it('getTasksCalendar ' + name, async function () {
        var res = await read.getTasksCalendar(client(), RANGES[name][0], RANGES[name][1]);
        expect(plain(res.data)).toEqual(golden['getTasksCalendar:' + name]);
      });
    });

    it('getTasksCalendar with a missing bound returns no tasks', async function () {
      expect(await read.getTasksCalendar(client(), '2026-10-01', '')).toEqual({ ok: true, data: { tasks: [] } });
      expect(await read.getTasksCalendar(client(), '', '2026-10-31')).toEqual({ ok: true, data: { tasks: [] } });
    });

    it('getTasksUpcoming 50, 2 and default', async function () {
      var r50 = await read.getTasksUpcoming(client(), 50);
      var r2 = await read.getTasksUpcoming(client(), 2);
      var rDefault = await read.getTasksUpcoming(client());
      expect(plain(r50.data)).toEqual(golden['getTasksUpcoming:50']);
      expect(plain(r2.data)).toEqual(golden['getTasksUpcoming:2']);
      expect(plain(rDefault.data)).toEqual(golden['getTasksUpcoming:50']);
    });

    describe('local-midnight bucketing', function () {
      // 2026-10-12T00:00 America/Vancouver (PDT, UTC-7) = 07:00Z
      var BEFORE = '2026-10-12T06:30:00.000Z';
      var AFTER = '2026-10-12T07:30:00.000Z';

      async function expected(now) {
        var batches = (await client().query('select * from batches')).rows;
        var tasks = (await client().query('select * from batch_tasks')).rows;
        return plain(rules.buildDashboardSummary({ batches: batches, tasks: tasks },
          { now: now, timezone: 'America/Vancouver' }));
      }

      it('30 minutes before local midnight is still the previous day', async function () {
        var res = await read.getDashboardSummary(client(), { now: BEFORE, timezone: 'America/Vancouver' });
        expect(plain(res.data)).toEqual(await expected(BEFORE));
        expect(res.data.tasksDueToday).toBe(2);
      });

      it('30 minutes after local midnight is the next day', async function () {
        var res = await read.getDashboardSummary(client(), { now: AFTER, timezone: 'America/Vancouver' });
        expect(plain(res.data)).toEqual(await expected(AFTER));
        expect(res.data.tasksDueToday).toBe(1);
        expect(res.data.overdueTasks).toBeGreaterThan(
          (await read.getDashboardSummary(client(), { now: BEFORE, timezone: 'America/Vancouver' })).data.overdueTasks
        );
      });
    });
  });
});

'use strict';

/**
 * Tests for scripts/backfill/batches-parity.js - Phase 87 Plan 15.
 * Fixtures, mocked batch-pg-read, fake pool and fake axios: no database, sheet or network.
 */

var os = require('os');
var path = require('path');
var fs = require('fs');

jest.mock('../../lib/batch-pg-read');

var pgRead = require('../../lib/batch-pg-read');
var parity = require('../../scripts/backfill/batches-parity');

var NOON = '2026-10-14T19:00:00.000Z'; // noon in America/Vancouver
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-test-'));

function dashboard(over) {
  return {
    ok: true,
    data: Object.assign({
      readyToBottle: [
        { batch_id: 'SV-B-000001', bottling_due: '2026-10-20' },
        { batch_id: 'SV-B-000002', bottling_due: '2026-10-21' },
        { batch_id: 'SV-B-000003', bottling_due: '2026-10-22' }
      ],
      counts: { primary: 2, secondary: 1 }
    }, over || {})
  };
}

var BATCHES = { ok: true, data: { batches: [{ batch_id: 'SV-B-000001', access_token: 'aaa' }], total: 1, filtered: 1 } };
var UPCOMING = { ok: true, data: { tasks: [{ task_id: 'BT-000001', due_date: '2026-10-15' }] } };
var CAL = { ok: true, data: { tasks: [] } };

function fakePool() {
  var client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  return { client: client, connect: jest.fn().mockResolvedValue(client) };
}

function fakeAxios(overrides) {
  var map = Object.assign({
    get_batch_dashboard_summary: dashboard(),
    get_batches: BATCHES,
    get_tasks_upcoming: UPCOMING,
    get_tasks_calendar: CAL
  }, overrides || {});
  return {
    get: jest.fn(function (url, cfg) { return Promise.resolve({ data: map[cfg.params.action] }); }),
    post: jest.fn(function (url, body) { return Promise.resolve({ data: map[body.action] }); })
  };
}

function setPg(dash) {
  pgRead.getDashboardSummary.mockResolvedValue(dash || dashboard());
  pgRead.listBatches.mockResolvedValue(BATCHES);
  pgRead.getTasksUpcoming.mockResolvedValue(UPCOMING);
  pgRead.getTasksCalendar.mockResolvedValue(CAL);
}

var ENV = { APPS_SCRIPT_URL: 'https://script.example.invalid/exec', APPS_SCRIPT_SERVER_TOKEN: 'srv' };

function run(opts, deps) {
  var lines = [];
  return parity.runBatchesParity(opts, Object.assign({
    pool: fakePool(),
    axios: fakeAxios(),
    env: ENV,
    log: function (l) { lines.push(l); }
  }, deps || {})).then(function (r) { r.lines = lines; return r; });
}

beforeEach(function () {
  jest.resetAllMocks();
  setPg();
});

describe('diffParity', function () {
  test('identical sides produce no differences, key order is irrelevant', function () {
    var a = { x: { ok: true, data: { a: 1, b: [1, 2] } } };
    var b = { x: { data: { b: [1, 2], a: 1 }, ok: true } };
    expect(parity.diffParity(a, b)).toEqual([]);
  });

  test('reports a path, never a value', function () {
    var d = parity.diffParity({ k: { data: { list: [{ n: 'secret-a' }] } } }, { k: { data: { list: [{ n: 'secret-b' }] } } });
    expect(d).toEqual([{ action: 'k', path: 'data.list[0].n' }]);
  });

  test('ignores access_token on either side but reports a key present on one side only', function () {
    var d = parity.diffParity(
      { k: { data: { access_token: 'a', v: null } } },
      { k: { data: { access_token: 'b' } } }
    );
    expect(d).toEqual([{ action: 'k', path: 'data.v' }]);
    expect(parity.diffParity({ k: { access_token: 'a' } }, { k: {} })).toEqual([]);
  });

  test('array length and missing keys are differences', function () {
    var d = parity.diffParity({ k: { data: { l: [1, 2], only: 1 } } }, { k: { data: { l: [1] } } });
    var paths = d.map(function (x) { return x.path; }).sort();
    expect(paths).toEqual(['data.l.length', 'data.only']);
  });
});

describe('buildCalls', function () {
  test('covers the current and next month, including a December rollover', function () {
    var calls = parity.buildCalls(new Date(NOON), 'America/Vancouver');
    var cal = calls.filter(function (c) { return c.action === 'get_tasks_calendar'; });
    expect(cal.map(function (c) { return c.params.start_date + '..' + c.params.end_date; }))
      .toEqual(['2026-10-01..2026-10-31', '2026-11-01..2026-11-30']);
    var dec = parity.buildCalls(new Date('2026-12-10T20:00:00Z'), 'America/Vancouver')
      .filter(function (c) { return c.action === 'get_tasks_calendar'; });
    expect(dec[1].params.start_date).toBe('2027-01-01');
  });
});

describe('runBatchesParity', function () {
  test('equal responses: exit 0 and the snapshot is written', async function () {
    var out = path.join(TMP, 'snap-equal.json');
    var r = await run({ snapshotOut: out, now: NOON });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('parity: 0 differences');
    var snap = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(snap.calls).toHaveLength(5);
    expect(snap.reads.get_batches).toEqual(BATCHES);
  });

  test('one differing dashboard entry: prints the path only and exits 4', async function () {
    var changed = dashboard();
    changed.data.readyToBottle[2].bottling_due = '2099-01-01';
    setPg(changed);
    var r = await run({ snapshotOut: path.join(TMP, 'snap-diff.json'), now: NOON });
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContain('get_batch_dashboard_summary data.readyToBottle[2].bottling_due');
    expect(r.lines.join('\n')).not.toContain('2099-01-01');
  });

  test('uses the same injected now and timezone for Postgres', async function () {
    await run({ snapshotOut: path.join(TMP, 'snap-now.json'), now: NOON, timezone: 'America/Vancouver' });
    var arg = pgRead.getDashboardSummary.mock.calls[0][1];
    expect(arg.now.toISOString()).toBe(NOON);
    expect(arg.timezone).toBe('America/Vancouver');
  });

  test('refuses a snapshot path inside the repo', async function () {
    var inRepo = path.resolve(__dirname, '../../../batches-parity-snapshot.json');
    var r = await run({ snapshotOut: inRepo, now: NOON });
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(inRepo)).toBe(false);
  });

  test('requires --snapshot-out', async function () {
    var r = await run({ now: NOON });
    expect(r.exitCode).toBe(1);
  });

  test('refuses to run within 15 minutes of local midnight', async function () {
    var r = await run({ snapshotOut: path.join(TMP, 'snap-mid.json'), now: '2026-10-15T07:05:00.000Z' }); // 00:05 PDT
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toContain('midnight');
    expect(parity.nearMidnight(new Date('2026-10-15T06:50:00.000Z'), 'America/Vancouver')).toBe(true);
    expect(parity.nearMidnight(new Date(NOON), 'America/Vancouver')).toBe(false);
  });

  test('a Postgres URL in argv is refused', function () {
    expect(function () { parity.parseArgs(['--x=postgres://u:p@h/db']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { parity.parseArgs(['--bogus']); }).toThrow(/unknown flag/);
  });

  test('Apps Script returning ok:false is an error, not a diff', async function () {
    var axios = fakeAxios({ get_batches: { ok: false } });
    var r = await run({ snapshotOut: path.join(TMP, 'snap-err.json'), now: NOON }, { axios: axios });
    expect(r.exitCode).toBe(1);
  });
});

describe('--against-snapshot --via=proxy', function () {
  var snapFile = path.join(TMP, 'snap-proxy.json');

  beforeEach(async function () {
    await run({ snapshotOut: snapFile, now: NOON });
  });

  var PROXY_ENV = Object.assign({}, ENV, { BATCH_PARITY_BASE_URL: 'https://mw.example.invalid', BATCH_PARITY_SESSION: 'sess-1' });

  test('matching proxy responses: exit 0, session sent as header only', async function () {
    var axios = fakeAxios();
    var r = await run({ againstSnapshot: snapFile, via: 'proxy' }, { axios: axios, env: PROXY_ENV });
    expect(r.exitCode).toBe(0);
    expect(axios.post).toHaveBeenCalledTimes(5);
    var call = axios.post.mock.calls[0];
    expect(call[0]).toBe('https://mw.example.invalid/api/admin/proxy');
    expect(call[2].headers['x-session-token']).toBe('sess-1');
    expect(JSON.stringify(call[1])).not.toContain('sess-1');
  });

  test('a changed proxy response exits 4', async function () {
    var changed = dashboard();
    changed.data.counts.primary = 99;
    var r = await run({ againstSnapshot: snapFile, via: 'proxy' },
      { axios: fakeAxios({ get_batch_dashboard_summary: changed }), env: PROXY_ENV });
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContain('get_batch_dashboard_summary data.counts.primary');
  });

  test('missing session env is an error', async function () {
    var r = await run({ againstSnapshot: snapFile, via: 'proxy' }, { env: ENV });
    expect(r.exitCode).toBe(1);
  });

  test('--against-snapshot without --via=proxy is an error', async function () {
    var r = await run({ againstSnapshot: snapFile }, { env: PROXY_ENV });
    expect(r.exitCode).toBe(1);
  });
});

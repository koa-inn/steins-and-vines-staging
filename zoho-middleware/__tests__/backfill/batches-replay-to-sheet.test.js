'use strict';

/**
 * Tests for scripts/backfill/batches-replay-to-sheet.js - Phase 87 Plan 14 (DB-06, D-07/D-08).
 * Fake pool + mocked axios and bundle reader: no real database or HTTP call is ever made.
 */

jest.mock('axios');

var axios = require('axios');
var opsMirror = require('../../lib/ops-mirror');
var batchPgRead = require('../../lib/batch-pg-read');
var replay = require('../../scripts/backfill/batches-replay-to-sheet');

var SINCE = '2026-10-12T00:00:00Z';
var ENV = { APPS_SCRIPT_URL: 'https://script.example/exec', APPS_SCRIPT_SERVER_TOKEN: 'tok' };

function bundleFor(id) {
  return {
    batch: { batch_id: id, customer_email: 'ann@example.invalid' },
    tasks: [{ task_id: 'BT-000001', batch_id: id }],
    readings: [],
    history: []
  };
}

// state: ids with last_updated >= since; tombstones: ids with deleted_at >= since;
// existing: ids currently present in batches.
function fakePool(state, tombstones, existing) {
  var queries = [];
  var params = [];
  var client = {
    query: jest.fn(function (sql, p) {
      queries.push(sql);
      params.push(p);
      if (/^(begin transaction read only|commit|rollback)$/.test(sql)) return Promise.resolve({ rows: [] });
      if (/from batch_tombstones/.test(sql)) {
        return Promise.resolve({ rows: tombstones.map(function (id) { return { batch_id: id }; }) });
      }
      if (/where batch_id = any/.test(sql)) {
        return Promise.resolve({ rows: (p[0] || []).filter(function (id) { return existing.indexOf(id) !== -1; })
          .map(function (id) { return { batch_id: id }; }) });
      }
      if (/from batches where last_updated/.test(sql)) {
        return Promise.resolve({ rows: state.map(function (id) { return { batch_id: id }; }) });
      }
      return Promise.reject(new Error('unexpected query: ' + sql));
    }),
    release: jest.fn()
  };
  return { queries: queries, params: params, connect: jest.fn(function () { return Promise.resolve(client); }) };
}

describe('parseArgs', function () {
  it('requires --since and rejects an invalid ISO value', function () {
    expect(function () { replay.parseArgs([]); }).toThrow(/--since/);
    expect(function () { replay.parseArgs(['--since=yesterday']); }).toThrow(/ISO/);
    expect(function () { replay.parseArgs(['--since=2026-13-45T00:00:00Z']); }).toThrow(/ISO/);
  });

  it('defaults to dry run and accepts --apply', function () {
    var o = replay.parseArgs(['--since=' + SINCE]);
    expect(o.apply).toBe(false);
    expect(o.since.toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(replay.parseArgs(['--since=' + SINCE, '--apply']).apply).toBe(true);
  });

  it('refuses Postgres URLs and unknown flags', function () {
    expect(function () { replay.parseArgs(['--x=postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { replay.parseArgs(['--since=' + SINCE, '--force']); }).toThrow(/unknown flag/);
  });
});

describe('runBatchesReplay', function () {
  beforeEach(function () {
    axios.post.mockReset();
    jest.spyOn(batchPgRead, 'getBatchBundle').mockImplementation(function (client, id) {
      return Promise.resolve(id === 'SV-B-000099' ? null : bundleFor(id));
    });
  });

  afterEach(function () {
    jest.restoreAllMocks();
  });

  it('dry run lists counts, makes no HTTP call and uses a read-only transaction', async function () {
    var pool = fakePool(['SV-B-000001', 'SV-B-000002'], ['SV-B-000099'], []);
    var lines = [];
    var opts = replay.parseArgs(['--since=' + SINCE]);
    var out = await replay.runBatchesReplay(opts, { pool: pool, axios: axios, log: function (l) { lines.push(l); }, env: ENV });
    expect(out).toEqual({ exitCode: 0, sent: 0, total: 3, state: 2, deletes: 1 });
    expect(axios.post).not.toHaveBeenCalled();
    expect(pool.queries[0]).toBe('begin transaction read only');
    expect(lines[0]).toBe('Built 3 replay request(s): 2 state, 1 delete');
  });

  it('--apply posts state (ordered) then delete, each body equal to buildMirrorRequest plus server_token', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var pool = fakePool(['SV-B-000002', 'SV-B-000001'], ['SV-B-000099'], []);
    var lines = [];
    var out = await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']),
      { pool: pool, axios: axios, log: function (l) { lines.push(l); }, env: ENV });
    expect(out.exitCode).toBe(0);
    expect(out.sent).toBe(3);
    expect(axios.post).toHaveBeenCalledTimes(3);
    var bodies = axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
    expect(bodies[0]).toEqual(Object.assign({}, opsMirror.buildMirrorRequest('batch', bundleFor('SV-B-000002'), 'SV-B-000002'), { server_token: 'tok' }));
    expect(bodies[1].action).toBe('mirror_batch_state');
    expect(bodies[1].batch.batch_id).toBe('SV-B-000001');
    expect(bodies[2]).toEqual({ action: 'mirror_batch_delete', batch_id: 'SV-B-000099', server_token: 'tok' });
    expect(lines).toContain('Next: run batches-verify against a fresh snapshot');
  });

  it('a tombstoned id that was re-created later is sent as state, not delete', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var pool = fakePool([], ['SV-B-000005'], ['SV-B-000005']);
    var out = await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']),
      { pool: pool, axios: axios, log: function () {}, env: ENV });
    expect(out).toMatchObject({ exitCode: 0, state: 1, deletes: 0 });
    var body = JSON.parse(axios.post.mock.calls[0][1]);
    expect(body.action).toBe('mirror_batch_state');
    expect(body.batch.batch_id).toBe('SV-B-000005');
  });

  it('does not send the same id twice when it is both updated and tombstoned', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var pool = fakePool(['SV-B-000005'], ['SV-B-000005'], ['SV-B-000005']);
    var out = await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']),
      { pool: pool, axios: axios, log: function () {}, env: ENV });
    expect(out.total).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('stops at the first {ok:false}, exits 1 and names the batch id', async function () {
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { ok: false, error: 'locked' } });
    var lines = [];
    var out = await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']), {
      pool: fakePool(['SV-B-000001', 'SV-B-000002', 'SV-B-000003'], [], []),
      axios: axios, log: function (l) { lines.push(l); }, env: ENV
    });
    expect(out.exitCode).toBe(1);
    expect(out.sent).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lines).toContain('Replay stopped - batch SV-B-000002 error=locked');
  });

  it('output carries ids and counts only, never batch contents', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var lines = [];
    await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']), {
      pool: fakePool(['SV-B-000001'], ['SV-B-000099'], []),
      axios: axios, log: function (l) { lines.push(l); }, env: ENV
    });
    expect(lines.join('\n')).not.toMatch(/ann@example|tok\b|script\.example/);
  });

  it('--apply without Apps Script env sends nothing and exits 1', async function () {
    var out = await replay.runBatchesReplay(replay.parseArgs(['--since=' + SINCE, '--apply']),
      { pool: fakePool(['SV-B-000001'], [], []), axios: axios, log: function () {}, env: {} });
    expect(out.exitCode).toBe(1);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

'use strict';

/**
 * Tests for scripts/backfill/ops-replay-to-sheet.js - Phase 86 Plan 14 (DB-05, D-10).
 * Fake pool + mocked axios: no real database or HTTP call is ever made.
 */

jest.mock('axios');

var axios = require('axios');
var opsMirror = require('../../lib/ops-mirror');
var vesselPg = require('../../lib/vessel-pg');
var fermSchedulePg = require('../../lib/ferm-schedule-pg');
var replay = require('../../scripts/backfill/ops-replay-to-sheet');

function vesselRow(id, position) {
  return {
    vessel_id: id, position: position, label: null, type: 'Fermenter', material: 'Steel',
    capacity_liters: '23', status: 'Empty', archived: false, bottom_diameter_cm: null,
    top_diameter_cm: null, depth_cm: null, location: null, brand: null, notes: null,
    updated_at: new Date(0)
  };
}

function scheduleRow(id) {
  return {
    schedule_id: id, name: 'Ale', description: null, category: 'Ale',
    steps: [{ day_offset: 0, action: 'Pitch' }], is_active: true, created_at: new Date(0),
    created_by: 'a@x.ca', updated_at: new Date(0)
  };
}

function fakePool() {
  var queries = [];
  var client = {
    query: jest.fn(function (sql) {
      queries.push(sql);
      if (/^(begin transaction read only|commit|rollback)$/.test(sql)) return Promise.resolve({ rows: [] });
      if (/from vessels/.test(sql)) return Promise.resolve({ rows: [vesselRow('FV-001', 1), vesselRow('FV-002', 2)] });
      if (/from ferm_schedules/.test(sql)) return Promise.resolve({ rows: [scheduleRow('FS-0001')] });
      return Promise.reject(new Error('unexpected query: ' + sql));
    }),
    release: jest.fn()
  };
  return { queries: queries, connect: jest.fn(function () { return Promise.resolve(client); }) };
}

var ENV = { APPS_SCRIPT_URL: 'https://script.example/exec', APPS_SCRIPT_SERVER_TOKEN: 'tok' };

describe('parseArgs', function () {
  it('defaults to dry run and accepts --apply, --only, --id', function () {
    expect(replay.parseArgs([]).apply).toBe(false);
    var o = replay.parseArgs(['--apply', '--only=schedules', '--id=FS-0001']);
    expect(o).toEqual({ apply: true, only: 'schedules', id: 'FS-0001' });
  });

  it('refuses URLs, unknown flags and --id without --only', function () {
    expect(function () { replay.parseArgs(['--x=postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { replay.parseArgs(['--staff']); }).toThrow(/unknown flag/);
    expect(function () { replay.parseArgs(['--only=bogus']); }).toThrow(/--only/);
    expect(function () { replay.parseArgs(['--id=FS-0001']); }).toThrow(/--only/);
  });
});

describe('runOpsReplay', function () {
  beforeEach(function () {
    axios.post.mockReset();
  });

  it('dry run reads Postgres in a read-only transaction and posts nothing', async function () {
    var pool = fakePool();
    var out = await replay.runOpsReplay({ apply: false }, { pool: pool, axios: axios, log: function () {}, env: ENV });
    expect(out).toEqual({ exitCode: 0, sent: 0, total: 3 });
    expect(axios.post).not.toHaveBeenCalled();
    expect(pool.queries[0]).toBe('begin transaction read only');
  });

  it('--apply posts one request per row with exactly the buildMirrorRequest payloads', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var out = await replay.runOpsReplay({ apply: true }, { pool: fakePool(), axios: axios, log: function () {}, env: ENV });
    expect(out).toEqual({ exitCode: 0, sent: 3, total: 3 });
    var bodies = axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
    expect(bodies.map(function (b) { return b.action; })).toEqual([
      'mirror_vessel_state', 'mirror_vessel_state', 'mirror_ferm_schedule_state'
    ]);
    bodies.forEach(function (b) {
      expect(b.server_token).toBe('tok');
      delete b.server_token;
    });
    var client = await fakePool().connect();
    var vessels = await vesselPg.listVessels(client);
    var schedules = await fermSchedulePg.listSchedules(client, { includeArchived: true });
    var expected = [
      opsMirror.buildMirrorRequest('vessel', vessels[0], 'FV-001'),
      opsMirror.buildMirrorRequest('vessel', vessels[1], 'FV-002'),
      opsMirror.buildMirrorRequest('fermsched', schedules[0], 'FS-0001')
    ];
    expect(bodies).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('stops at the first ok:false with exit 1', async function () {
    axios.post
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { ok: false, error: 'boom' } });
    var lines = [];
    var out = await replay.runOpsReplay({ apply: true }, {
      pool: fakePool(), axios: axios, log: function (l) { lines.push(l); }, env: ENV
    });
    expect(out.exitCode).toBe(1);
    expect(out.sent).toBe(1);
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lines.join('\n')).toMatch(/vessel FV-002 error=boom/);
  });

  it('never makes a staff request', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    await replay.runOpsReplay({ apply: true }, { pool: fakePool(), axios: axios, log: function () {}, env: ENV });
    axios.post.mock.calls.forEach(function (c) {
      expect(JSON.parse(c[1]).action).toMatch(/^mirror_(vessel_state|ferm_schedule_state|ferm_schedule_delete)$/);
    });
  });

  it('--apply without Apps Script env fails with exit 1 and posts nothing', async function () {
    var out = await replay.runOpsReplay({ apply: true }, { pool: fakePool(), axios: axios, log: function () {}, env: {} });
    expect(out.exitCode).toBe(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('--only=schedules --id for a schedule gone from Postgres sends the delete body', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var out = await replay.runOpsReplay({ apply: true, only: 'schedules', id: 'FS-0099' }, {
      pool: fakePool(), axios: axios, log: function () {}, env: ENV
    });
    expect(out.sent).toBe(1);
    var body = JSON.parse(axios.post.mock.calls[0][1]);
    expect(body.action).toBe('mirror_ferm_schedule_delete');
    expect(body.schedule_id).toBe('FS-0099');
  });
});

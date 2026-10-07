'use strict';

jest.mock('../lib/db', function () {
  return {
    withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }),
    isConfigured: jest.fn(function () { return true; })
  };
});
jest.mock('../lib/vessel-pg', function () {
  return {
    listVessels: jest.fn(),
    getVessel: jest.fn(),
    createVessel: jest.fn(),
    updateVessel: jest.fn(),
    archiveVessel: jest.fn(),
    unarchiveVessel: jest.fn(),
    applyStatusChanges: jest.fn(),
    nextVesselNumber: jest.fn()
  };
});
jest.mock('../lib/ops-mirror', function () {
  return { schedule: jest.fn() };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

var db = require('../lib/db');
var vesselPg = require('../lib/vessel-pg');
var opsMirror = require('../lib/ops-mirror');
var store = require('../lib/vessel-store');

beforeEach(function () {
  jest.clearAllMocks();
  process.env.OPS_DATA_STORE = 'postgres';
  db.withTransaction.mockImplementation(function (fn) { return fn({ fake: true }); });
  opsMirror.schedule.mockReset();
});

afterEach(function () { delete process.env.OPS_DATA_STORE; });

describe('sheets mode', function () {
  test('every operation rejects sheets_mode and never touches vessel-pg', async function () {
    delete process.env.OPS_DATA_STORE;
    var calls = [
      function () { return store.list(); },
      function () { return store.get('PCB-001'); },
      function () { return store.create({}, {}); },
      function () { return store.update('PCB-001', {}, {}); },
      function () { return store.archive('PCB-001', {}); },
      function () { return store.unarchive('PCB-001', {}); },
      function () { return store.applyStatusChanges([], {}); },
      function () { return store.nextVesselNumber('PCB'); }
    ];
    for (var i = 0; i < calls.length; i++) {
      await expect(calls[i]()).rejects.toMatchObject({ code: 'sheets_mode' });
    }
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(vesselPg.listVessels).not.toHaveBeenCalled();
  });
});

describe('reads', function () {
  test('list wraps vessels in the Apps Script envelope', async function () {
    vesselPg.listVessels.mockResolvedValue([{ vessel_id: 'PCB-001' }]);
    await expect(store.list()).resolves.toEqual({ ok: true, data: { vessels: [{ vessel_id: 'PCB-001' }] } });
  });

  test('DB rejection rejects (no sheet fallback)', async function () {
    db.withTransaction.mockRejectedValue(new Error('pg down'));
    await expect(store.list()).rejects.toThrow('pg down');
  });
});

describe('writes', function () {
  test('update schedules mirror once and strips underscore keys, actor passed', async function () {
    vesselPg.updateVessel.mockResolvedValue({ ok: true, vessel: { vessel_id: 'PCB-001' }, _vesselId: 'PCB-001' });
    var out = await store.update('PCB-001', { notes: 'x' }, { actor: 'a@b.ca', expectedUpdatedAt: 't' });
    expect(out).toEqual({ ok: true, vessel: { vessel_id: 'PCB-001' } });
    expect(opsMirror.schedule).toHaveBeenCalledTimes(1);
    expect(opsMirror.schedule).toHaveBeenCalledWith('vessel', 'PCB-001');
    var passed = vesselPg.updateVessel.mock.calls[0][3];
    expect(passed.actor).toBe('a@b.ca');
    expect(passed.expectedUpdatedAt).toBe('t');
  });

  test('actor defaults to middleware', async function () {
    vesselPg.createVessel.mockResolvedValue({ ok: true, _vesselId: 'PCB-002' });
    await store.create({}, undefined);
    expect(vesselPg.createVessel.mock.calls[0][2].actor).toBe('middleware');
  });

  test('stale envelope passes through with no mirror', async function () {
    var stale = { ok: false, error: 'stale_vessel', message: 'm' };
    vesselPg.updateVessel.mockResolvedValue(stale);
    await expect(store.update('PCB-001', {}, {})).resolves.toEqual(stale);
    expect(opsMirror.schedule).not.toHaveBeenCalled();
  });

  test('archive and unarchive schedule the mirror', async function () {
    vesselPg.archiveVessel.mockResolvedValue({ ok: true, _vesselId: 'PCB-003' });
    vesselPg.unarchiveVessel.mockResolvedValue({ ok: true, _vesselId: 'PCB-004' });
    await store.archive('PCB-003', {});
    await store.unarchive('PCB-004', {});
    expect(opsMirror.schedule).toHaveBeenCalledWith('vessel', 'PCB-003');
    expect(opsMirror.schedule).toHaveBeenCalledWith('vessel', 'PCB-004');
  });

  test('a throwing mirror schedule does not fail the save', async function () {
    vesselPg.createVessel.mockResolvedValue({ ok: true, _vesselId: 'PCB-005' });
    opsMirror.schedule.mockImplementation(function () { throw new Error('boom'); });
    await expect(store.create({}, {})).resolves.toEqual({ ok: true });
  });
});

describe('applyStatusChanges', function () {
  test('passes actor and mirrors applied ids only', async function () {
    vesselPg.applyStatusChanges.mockResolvedValue({
      applied: ['A-001', 'A-002'], unchanged: ['A-003'], unknown: [], invalid: []
    });
    var out = await store.applyStatusChanges([{ vessel_id: 'A-001', status: 'In-Use' }], { actor: 'x@y.ca' });
    expect(out.applied).toEqual(['A-001', 'A-002']);
    expect(vesselPg.applyStatusChanges.mock.calls[0][2].actor).toBe('x@y.ca');
    expect(opsMirror.schedule).toHaveBeenCalledTimes(2);
    expect(opsMirror.schedule).not.toHaveBeenCalledWith('vessel', 'A-003');
  });

  test('non-array input is a no-op without a DB call', async function () {
    await expect(store.applyStatusChanges('nope', {})).resolves.toEqual({
      applied: [], unchanged: [], unknown: [], invalid: []
    });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

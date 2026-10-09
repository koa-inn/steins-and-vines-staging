'use strict';

jest.mock('../lib/db', function () {
  return { withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }) };
});
jest.mock('../lib/batch-pg-read', function () {
  return { getBatchPublic: jest.fn(), lockBatch: jest.fn() };
});
jest.mock('../lib/batch-pg-tasks', function () {
  return { updateBatchTask: jest.fn(), bulkAddPlatoReadings: jest.fn() };
});
jest.mock('../lib/ops-mirror', function () { return { schedule: jest.fn() }; });
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

var db = require('../lib/db');
var read = require('../lib/batch-pg-read');
var tasks = require('../lib/batch-pg-tasks');
var opsMirror = require('../lib/ops-mirror');
var store = require('../lib/batch-store');

var ID = 'SV-B-000123';
var TOKEN = 'a'.repeat(32);
var CLIENT = { fake: true };

beforeEach(function () {
  jest.resetAllMocks();
  db.withTransaction.mockImplementation(function (fn) { return fn(CLIENT); });
  process.env.OPS_DATA_STORE = 'postgres';
  process.env.BATCHES_STORE = 'postgres';
  delete process.env.BATCHES_FREEZE;
  read.lockBatch.mockResolvedValue({ batch_id: ID, access_token: TOKEN });
});

afterEach(function () {
  delete process.env.OPS_DATA_STORE;
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
});

describe('getPublic', function () {
  it('returns the public view from the read module', function () {
    var view = { ok: true, data: { batch: {}, tasks: [], plato_readings: [], vessel_history: [] } };
    read.getBatchPublic.mockResolvedValue(view);
    return store.getPublic(ID, TOKEN).then(function (r) {
      expect(r).toBe(view);
      expect(read.getBatchPublic).toHaveBeenCalledWith(CLIENT, ID, TOKEN);
    });
  });

  it('is not frozen', function () {
    process.env.BATCHES_FREEZE = 'Sunday';
    read.getBatchPublic.mockResolvedValue({ ok: true });
    return store.getPublic(ID, TOKEN).then(function (r) { expect(r.ok).toBe(true); });
  });
});

describe('publicUpdateTask', function () {
  it('rejects a wrong token, malformed ids and missing batches as invalid_token', function () {
    return store.publicUpdateTask(ID, 'b'.repeat(32), { task_id: 'T1', updates: { completed: true } })
      .then(function (r) {
        expect(r.error).toBe('invalid_token');
        return store.publicUpdateTask('bad', TOKEN, { task_id: 'T1' });
      }).then(function (r) {
        expect(r.error).toBe('invalid_token');
        return store.publicUpdateTask(ID, 'short', { task_id: 'T1' });
      }).then(function (r) {
        expect(r.error).toBe('invalid_token');
        read.lockBatch.mockResolvedValue(null);
        return store.publicUpdateTask(ID, TOKEN, { task_id: 'T1' });
      }).then(function (r) {
        expect(r.error).toBe('invalid_token');
        expect(tasks.updateBatchTask).not.toHaveBeenCalled();
        expect(opsMirror.schedule).not.toHaveBeenCalled();
      });
  });

  it('passes only completed and notes, actor batch-url and publicBatchId', function () {
    tasks.updateBatchTask.mockResolvedValue({ ok: true, _batchId: ID });
    return store.publicUpdateTask(ID, TOKEN, {
      task_id: 'T1',
      updates: { completed: true, notes: 'n', status: 'complete', vessel_id: 'V1', title: 'x' }
    }).then(function (r) {
      expect(r).toEqual({ ok: true });
      var call = tasks.updateBatchTask.mock.calls[0];
      expect(call[1]).toEqual({ task_id: 'T1', updates: { completed: true, notes: 'n' } });
      expect(call[2].actor).toBe('batch-url');
      expect(call[2].publicBatchId).toBe(ID);
      expect(opsMirror.schedule).toHaveBeenCalledWith('batch', ID);
    });
  });

  it('surfaces module rejections (packaging, cross-batch) as unauthorized without mirroring', function () {
    tasks.updateBatchTask.mockResolvedValue({ ok: false, error: 'unauthorized' });
    return store.publicUpdateTask(ID, TOKEN, { task_id: 'T9', updates: { completed: true } })
      .then(function (r) {
        expect(r.error).toBe('unauthorized');
        expect(opsMirror.schedule).not.toHaveBeenCalled();
      });
  });

  it('resolves maintenance under freeze and null in sheets mode', function () {
    process.env.BATCHES_FREEZE = 'Sunday';
    return store.publicUpdateTask(ID, TOKEN, {}).then(function (r) {
      expect(r.error).toBe('maintenance');
      delete process.env.BATCHES_FREEZE;
      delete process.env.BATCHES_STORE;
      return Promise.all([
        store.getPublic(ID, TOKEN), store.publicUpdateTask(ID, TOKEN, {}),
        store.publicAddReadings(ID, TOKEN, [])
      ]);
    }).then(function (rs) {
      expect(rs).toEqual([null, null, null]);
      expect(db.withTransaction).not.toHaveBeenCalled();
    });
  });
});

describe('publicAddReadings', function () {
  it('records readings as batch-url scoped to the token batch', function () {
    tasks.bulkAddPlatoReadings.mockResolvedValue({ ok: true, results: [{ ok: true }], _batchId: ID });
    var readings = [{ degrees_plato: 10 }];
    return store.publicAddReadings(ID, TOKEN, readings).then(function (r) {
      expect(r).toEqual({ ok: true, results: [{ ok: true }] });
      var call = tasks.bulkAddPlatoReadings.mock.calls[0];
      expect(call[1]).toEqual({ batch_id: ID, readings: readings });
      expect(call[2].actor).toBe('batch-url');
      expect(call[2].publicBatchId).toBe(ID);
      expect(opsMirror.schedule).toHaveBeenCalledWith('batch', ID);
    });
  });

  it('passes through too_many and rejects a bad token', function () {
    tasks.bulkAddPlatoReadings.mockResolvedValue({ ok: false, error: 'too_many' });
    return store.publicAddReadings(ID, TOKEN, new Array(21).fill({})).then(function (r) {
      expect(r.error).toBe('too_many');
      return store.publicAddReadings(ID, 'c'.repeat(32), [{}]);
    }).then(function (r) {
      expect(r.error).toBe('invalid_token');
      expect(tasks.bulkAddPlatoReadings).toHaveBeenCalledTimes(1);
    });
  });

  it('resolves maintenance under freeze', function () {
    process.env.BATCHES_FREEZE = 'Sunday';
    return store.publicAddReadings(ID, TOKEN, [{}]).then(function (r) {
      expect(r.error).toBe('maintenance');
    });
  });
});

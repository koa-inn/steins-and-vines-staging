'use strict';

jest.mock('../lib/db', function () {
  return { withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }) };
});
jest.mock('../lib/batch-pg-read', function () {
  return {
    listBatches: jest.fn(), listAllForIndex: jest.fn(), getBatchDetail: jest.fn(),
    getBatchPublic: jest.fn(), getDashboardSummary: jest.fn(), getTasksCalendar: jest.fn(),
    getTasksUpcoming: jest.fn(), lockBatch: jest.fn(), countByRecipe: jest.fn(),
    countBySchedule: jest.fn()
  };
});
jest.mock('../lib/batch-pg-create', function () { return { createBatch: jest.fn() }; });
jest.mock('../lib/batch-pg-update', function () {
  return {
    updateBatch: jest.fn(), updateBatchSchedule: jest.fn(), deleteBatch: jest.fn(),
    regenerateToken: jest.fn()
  };
});
jest.mock('../lib/batch-pg-tasks', function () {
  return {
    updateBatchTask: jest.fn(), bulkUpdateBatchTasks: jest.fn(), addBatchTask: jest.fn(),
    bulkAddPlatoReadings: jest.fn(), updatePlatoReading: jest.fn(), deletePlatoReading: jest.fn(),
    propagateSchedule: jest.fn()
  };
});
jest.mock('../lib/ferm-schedule-store', function () { return { list: jest.fn() }; });
jest.mock('../lib/ops-mirror', function () { return { schedule: jest.fn() }; });
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

var db = require('../lib/db');
var read = require('../lib/batch-pg-read');
var create = require('../lib/batch-pg-create');
var upd = require('../lib/batch-pg-update');
var tasks = require('../lib/batch-pg-tasks');
var schedStore = require('../lib/ferm-schedule-store');
var opsMirror = require('../lib/ops-mirror');
var log = require('../lib/logger');
var store = require('../lib/batch-store');

var CLIENT = { fake: true };

beforeEach(function () {
  jest.resetAllMocks();
  db.withTransaction.mockImplementation(function (fn) { return fn(CLIENT); });
  process.env.OPS_DATA_STORE = 'postgres';
  process.env.BATCHES_STORE = 'postgres';
  delete process.env.BATCHES_FREEZE;
});

afterEach(function () {
  delete process.env.OPS_DATA_STORE;
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
});

function callAll() {
  return [
    store.list({}), store.detail({ batch_id: 'SV-B-000001' }), store.dashboard(),
    store.calendar({}), store.upcoming({}), store.batchInit({}), store.listAll(),
    store.countByRecipe('R'), store.countBySchedule('S'),
    store.create({}), store.update({}), store.updateSchedule({}), store.remove({}),
    store.updateTask({}), store.bulkUpdateTasks({}), store.addTask({}), store.bulkAddReadings({}),
    store.updateReading({}), store.deleteReading({}), store.regenerateToken({}),
    store.getPublic('a', 'b'), store.publicUpdateTask('a', 'b', {}),
    store.publicAddReadings('a', 'b', []), store.propagate('S', [])
  ];
}

describe('sheets mode', function () {
  beforeEach(function () { delete process.env.BATCHES_STORE; });

  it('resolves null for every op and touches no pg module or db', function () {
    return Promise.all(callAll()).then(function (results) {
      results.forEach(function (r) { expect(r).toBeNull(); });
      expect(db.withTransaction).not.toHaveBeenCalled();
      expect(opsMirror.schedule).not.toHaveBeenCalled();
    });
  });

  it('with BATCHES_FREEZE writes resolve the maintenance envelope, reads stay null', function () {
    process.env.BATCHES_FREEZE = 'Sunday 6pm';
    return Promise.all([store.create({}), store.update({}), store.list({}), store.detail({})])
      .then(function (r) {
        expect(r[0]).toEqual({
          ok: false, error: 'maintenance',
          message: 'Batches are read-only for maintenance until Sunday 6pm. Please try again then.'
        });
        expect(r[1].error).toBe('maintenance');
        expect(r[2]).toBeNull();
        expect(r[3]).toBeNull();
      });
  });
});

describe('postgres mode freeze', function () {
  beforeEach(function () { process.env.BATCHES_FREEZE = 'Sunday'; });

  it('every WRITE op resolves maintenance without opening a transaction', function () {
    var writes = {
      create: [{}], update: [{}], updateSchedule: [{}], remove: [{}], updateTask: [{}],
      bulkUpdateTasks: [{}], addTask: [{}], bulkAddReadings: [{}], updateReading: [{}],
      deleteReading: [{}], regenerateToken: [{}], publicUpdateTask: ['a', 'b', {}],
      publicAddReadings: ['a', 'b', []], propagate: ['S', []]
    };
    expect(Object.keys(writes).sort()).toEqual(store.WRITE_OPS.slice().sort());
    return Promise.all(Object.keys(writes).map(function (op) {
      return store[op].apply(null, writes[op]);
    })).then(function (results) {
      results.forEach(function (r) { expect(r.error).toBe('maintenance'); });
      expect(db.withTransaction).not.toHaveBeenCalled();
    });
  });

  it('reads run normally', function () {
    read.getBatchDetail.mockResolvedValue({ ok: true, data: { batch: {} } });
    return store.detail({ batch_id: 'SV-B-000001' }).then(function (r) {
      expect(r.ok).toBe(true);
      expect(read.getBatchDetail).toHaveBeenCalledWith(CLIENT, 'SV-B-000001');
    });
  });

  it('create under freeze logs maintenance with the invoice number only', function () {
    return store.create({ zoho_so_number: 'INV-000123', customer_email: 'a@b.c', customer_name: 'Zed' })
      .then(function () {
        var msg = log.warn.mock.calls.map(function (c) { return c[0]; }).join('\n');
        expect(msg).toContain('[batch-store] create_batch refused: maintenance');
        expect(msg).toContain('INV-000123');
        expect(msg).not.toContain('a@b.c');
        expect(msg).not.toContain('Zed');
      });
  });
});

describe('postgres reads', function () {
  it('dispatches list/dashboard/calendar/upcoming/counts/listAll', function () {
    read.listBatches.mockResolvedValue({ ok: true, data: { batches: [] } });
    read.getDashboardSummary.mockResolvedValue({ ok: true, data: {} });
    read.getTasksCalendar.mockResolvedValue({ ok: true, data: { tasks: [] } });
    read.getTasksUpcoming.mockResolvedValue({ ok: true, data: { tasks: [] } });
    read.listAllForIndex.mockResolvedValue([{ batch_id: 'A' }]);
    read.countByRecipe.mockResolvedValue(2);
    read.countBySchedule.mockResolvedValue(3);
    return Promise.all([
      store.list({ status: 'active', limit: 5, offset: 1 }),
      store.dashboard(),
      store.calendar({ start_date: '2026-01-01', end_date: '2026-01-31' }),
      store.upcoming({ limit: '7' }),
      store.upcoming({}),
      store.listAll(),
      store.countByRecipe('R1'),
      store.countBySchedule('S1')
    ]).then(function (r) {
      expect(read.listBatches).toHaveBeenCalledWith(CLIENT, { status: 'active', limit: 5, offset: 1 });
      expect(read.getDashboardSummary.mock.calls[0][1].now).toBeInstanceOf(Date);
      expect(read.getTasksCalendar).toHaveBeenCalledWith(CLIENT, '2026-01-01', '2026-01-31');
      expect(read.getTasksUpcoming).toHaveBeenCalledWith(CLIENT, 7);
      expect(read.getTasksUpcoming).toHaveBeenCalledWith(CLIENT, 50);
      expect(r[5]).toEqual([{ batch_id: 'A' }]);
      expect(r[6]).toBe(2);
      expect(r[7]).toBe(3);
      expect(opsMirror.schedule).not.toHaveBeenCalled();
    });
  });

  it('batchInit assembles batches, schedules and summary', function () {
    read.listBatches.mockResolvedValue({ ok: true, data: { batches: [{ batch_id: 'A' }], total: 1 } });
    read.getDashboardSummary.mockResolvedValue({ ok: true, data: { active: 1 } });
    schedStore.list.mockResolvedValue({ ok: true, data: { schedules: [{ schedule_id: 'S' }] } });
    return store.batchInit({}).then(function (r) {
      expect(r).toEqual({
        ok: true,
        data: {
          batches: { batches: [{ batch_id: 'A' }], total: 1 },
          schedules: { schedules: [{ schedule_id: 'S' }] },
          summary: { active: 1 }
        }
      });
    });
  });
});

describe('postgres writes', function () {
  it('update schedules batch once and each applied vessel, strips underscore keys', function () {
    upd.updateBatch.mockResolvedValue({
      ok: true, message: 'x', _batchId: 'SV-B-000001', _vesselApplied: ['V1', 'V2']
    });
    return store.update({ batch_id: 'SV-B-000001', updates: {} }, { actor: 'me' }).then(function (r) {
      expect(r).toEqual({ ok: true, message: 'x' });
      expect(opsMirror.schedule.mock.calls).toEqual([
        ['batch', 'SV-B-000001'], ['vessel', 'V1'], ['vessel', 'V2']
      ]);
      expect(upd.updateBatch.mock.calls[0][2].actor).toBe('me');
      expect(db.withTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it('bulkUpdateTasks and propagate schedule every touched batch', function () {
    tasks.bulkUpdateBatchTasks.mockResolvedValue({ ok: true, _batchIds: ['A', 'B'] });
    tasks.propagateSchedule.mockResolvedValue({ ok: true, _batchIds: ['C', 'D'], batches_updated: 2 });
    return store.bulkUpdateTasks({ tasks: [] }).then(function (r) {
      expect(r).toEqual({ ok: true });
      return store.propagate('S1', [{ step_number: 1 }]);
    }).then(function (r) {
      expect(r).toEqual({ ok: true, batches_updated: 2 });
      expect(opsMirror.schedule.mock.calls).toEqual([
        ['batch', 'A'], ['batch', 'B'], ['batch', 'C'], ['batch', 'D']
      ]);
      expect(tasks.propagateSchedule.mock.calls[0][1]).toBe('S1');
    });
  });

  it('remove schedules the deleted id', function () {
    upd.deleteBatch.mockResolvedValue({ ok: true, _batchId: 'A', _vesselApplied: [] });
    return store.remove({ batch_id: 'A' }).then(function () {
      expect(opsMirror.schedule).toHaveBeenCalledWith('batch', 'A');
    });
  });

  it('routes each write op to its pg function', function () {
    var fns = [upd.updateBatchSchedule, upd.regenerateToken, tasks.updateBatchTask,
      tasks.addBatchTask, tasks.bulkAddPlatoReadings, tasks.updatePlatoReading,
      tasks.deletePlatoReading];
    fns.forEach(function (m) { m.mockResolvedValue({ ok: true }); });
    return Promise.all([
      store.updateSchedule({}), store.regenerateToken({}), store.updateTask({}), store.addTask({}),
      store.bulkAddReadings({}), store.updateReading({}), store.deleteReading({})
    ]).then(function () {
      fns.forEach(function (m) { expect(m).toHaveBeenCalledTimes(1); });
    });
  });

  it('business rejection schedules no mirror', function () {
    upd.updateBatch.mockResolvedValue({ ok: false, error: 'not_found', _batchId: 'A' });
    return store.update({ batch_id: 'A' }).then(function (r) {
      expect(r).toEqual({ ok: false, error: 'not_found' });
      expect(opsMirror.schedule).not.toHaveBeenCalled();
    });
  });

  it('db rejection rejects the facade (no fallback)', function () {
    db.withTransaction.mockRejectedValue(new Error('pg down'));
    return expect(store.update({ batch_id: 'A' })).rejects.toThrow('pg down');
  });

  it('a throwing mirror schedule is logged and the result still returned', function () {
    upd.updateBatch.mockResolvedValue({ ok: true, _batchId: 'A' });
    opsMirror.schedule.mockImplementation(function () { throw new Error('redis'); });
    return store.update({ batch_id: 'A' }).then(function (r) {
      expect(r).toEqual({ ok: true });
      expect(log.warn).toHaveBeenCalled();
    });
  });

  it('actor precedence: opts.actor > acting_user > middleware; fresh now per call', function () {
    upd.updateBatch.mockResolvedValue({ ok: true });
    return store.update({ acting_user: 'bob' }).then(function () {
      return store.update({ acting_user: 'bob' }, { actor: 'opt' });
    }).then(function () {
      return store.update({});
    }).then(function () {
      var c = upd.updateBatch.mock.calls;
      expect(c[0][2].actor).toBe('bob');
      expect(c[1][2].actor).toBe('opt');
      expect(c[2][2].actor).toBe('middleware');
      expect(c[0][2].now).toBeInstanceOf(Date);
      expect(c[0][2].now).not.toBe(c[1][2].now);
    });
  });

  it('create passes payload, actor and replay window to createBatch', function () {
    create.createBatch.mockResolvedValue({ ok: true, batch_id: 'A', _batchId: 'A', _vesselApplied: ['V'] });
    return store.create({ product_sku: 'X' }, { actor: 'kiosk', replayWindowMs: 5 }).then(function (r) {
      expect(r).toEqual({ ok: true, batch_id: 'A' });
      var args = create.createBatch.mock.calls[0];
      expect(args[1]).toEqual({ product_sku: 'X' });
      expect(args[2].actor).toBe('kiosk');
      expect(args[2].replayWindowMs).toBe(5);
      expect(opsMirror.schedule.mock.calls).toEqual([['batch', 'A'], ['vessel', 'V']]);
    });
  });
});

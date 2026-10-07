'use strict';

jest.mock('axios');
jest.mock('../lib/db', function () {
  return {
    withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }),
    isConfigured: jest.fn(function () { return true; })
  };
});
jest.mock('../lib/ferm-schedule-pg', function () {
  return {
    listSchedules: jest.fn(),
    getSchedule: jest.fn(),
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
    archiveSchedule: jest.fn(),
    deleteSchedule: jest.fn(),
    countRecipeReferences: jest.fn()
  };
});
jest.mock('../lib/recipe-store', function () {
  return { list: jest.fn() };
});
jest.mock('../lib/ops-mirror', function () {
  return { schedule: jest.fn() };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

var axios = require('axios');
var db = require('../lib/db');
var pg = require('../lib/ferm-schedule-pg');
var recipeStore = require('../lib/recipe-store');
var opsMirror = require('../lib/ops-mirror');
var store = require('../lib/ferm-schedule-store');

function body(call) { return JSON.parse(axios.post.mock.calls[call][1]); }

beforeEach(function () {
  jest.clearAllMocks();
  axios.post.mockReset();
  opsMirror.schedule.mockReset();
  process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  process.env.OPS_DATA_STORE = 'postgres';
  process.env.RECIPES_STORE = 'postgres';
  db.withTransaction.mockImplementation(function (fn) { return fn({ fake: true }); });
});

afterEach(function () {
  delete process.env.OPS_DATA_STORE;
  delete process.env.RECIPES_STORE;
});

describe('sheets mode', function () {
  test('every export rejects sheets_mode', async function () {
    delete process.env.OPS_DATA_STORE;
    var calls = [
      function () { return store.list({}); },
      function () { return store.get('FS-0001'); },
      function () { return store.create({}, {}); },
      function () { return store.update({ schedule_id: 'FS-0001' }, {}); },
      function () { return store.archive({ schedule_id: 'FS-0001' }, {}); },
      function () { return store.remove({ schedule_id: 'FS-0001' }, {}); },
      function () { return store.propagate({ schedule_id: 'FS-0001' }, {}); },
      function () { return store.getStepsJson('FS-0001'); },
      function () { return store.hasBatchReferences('FS-0001'); },
      function () { return store.countRecipeReferences('FS-0001'); }
    ];
    for (var i = 0; i < calls.length; i++) {
      await expect(calls[i]()).rejects.toMatchObject({ code: 'sheets_mode' });
    }
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('reads', function () {
  test('list wraps schedules and forwards includeArchived', async function () {
    pg.listSchedules.mockResolvedValue([{ schedule_id: 'FS-0001' }]);
    var out = await store.list({ includeArchived: true });
    expect(out).toEqual({ ok: true, data: { schedules: [{ schedule_id: 'FS-0001' }] } });
    expect(pg.listSchedules.mock.calls[0][1]).toEqual({ includeArchived: true });
  });

  test('PG failure rejects (no sheet fallback)', async function () {
    db.withTransaction.mockRejectedValue(new Error('pg down'));
    await expect(store.list({})).rejects.toThrow('pg down');
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('create / update / archive', function () {
  test('create schedules mirror, strips underscore keys, passes actor', async function () {
    pg.createSchedule.mockResolvedValue({ ok: true, schedule_id: 'FS-0012', _scheduleId: 'FS-0012' });
    var out = await store.create({ name: 'n' }, { actor: 'a@b.ca' });
    expect(out).toEqual({ ok: true, schedule_id: 'FS-0012' });
    expect(opsMirror.schedule).toHaveBeenCalledWith('fermsched', 'FS-0012');
    expect(pg.createSchedule.mock.calls[0][2].actor).toBe('a@b.ca');
  });

  test('update uses payload.schedule_id and expectedUpdatedAt', async function () {
    pg.updateSchedule.mockResolvedValue({ ok: true, _scheduleId: 'FS-0003' });
    await store.update({ schedule_id: 'FS-0003', name: 'x' }, { actor: 'a', expectedUpdatedAt: 't' });
    expect(pg.updateSchedule.mock.calls[0][1]).toBe('FS-0003');
    expect(pg.updateSchedule.mock.calls[0][3].expectedUpdatedAt).toBe('t');
    expect(opsMirror.schedule).toHaveBeenCalledWith('fermsched', 'FS-0003');
  });

  test('stale envelope passes through without mirror', async function () {
    var stale = { ok: false, error: 'stale_schedule', message: 'm' };
    pg.updateSchedule.mockResolvedValue(stale);
    await expect(store.update({ schedule_id: 'FS-0003' }, {})).resolves.toEqual(stale);
    expect(opsMirror.schedule).not.toHaveBeenCalled();
  });

  test('archive needs no reference count call', async function () {
    pg.archiveSchedule.mockResolvedValue({ ok: true, _scheduleId: 'FS-0004' });
    await store.archive({ schedule_id: 'FS-0004' }, { actor: 'a' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(pg.countRecipeReferences).not.toHaveBeenCalled();
    expect(opsMirror.schedule).toHaveBeenCalledWith('fermsched', 'FS-0004');
  });
});

describe('remove', function () {
  test('passes both counts to deleteSchedule; in-use envelope, no mirror', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, count: 2 } });
    pg.countRecipeReferences.mockResolvedValue(1);
    var inUse = { ok: false, error: 'schedule_in_use', recipe_refs: 1, batch_refs: 2, message: 'm' };
    pg.deleteSchedule.mockResolvedValue(inUse);
    var out = await store.remove({ schedule_id: 'FS-0001' }, { actor: 'a' });
    expect(out).toEqual(inUse);
    expect(body(0).action).toBe('ferm_schedule_ref_count');
    expect(body(0).schedule_id).toBe('FS-0001');
    expect(body(0).server_token).toBe('tok');
    var o = pg.deleteSchedule.mock.calls[0][2];
    expect(o.batchRefCount).toBe(2);
    expect(o.recipeRefCount).toBe(1);
    expect(opsMirror.schedule).not.toHaveBeenCalled();
  });

  test('counts are resolved in separate transactions before the delete transaction', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, count: 0 } });
    pg.countRecipeReferences.mockResolvedValue(0);
    pg.deleteSchedule.mockResolvedValue({ ok: true, _scheduleId: 'FS-0001', _deleted: true });
    await store.remove({ schedule_id: 'FS-0001' }, {});
    expect(db.withTransaction).toHaveBeenCalledTimes(2);
    expect(pg.countRecipeReferences.mock.invocationCallOrder[0])
      .toBeLessThan(pg.deleteSchedule.mock.invocationCallOrder[0]);
  });

  test('batch ref count transport failure fails closed with no transaction', async function () {
    axios.post.mockRejectedValue(new Error('timeout'));
    await expect(store.remove({ schedule_id: 'FS-0001' }, {}))
      .rejects.toMatchObject({ code: 'batch_ref_unavailable' });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(pg.deleteSchedule).not.toHaveBeenCalled();
  });

  test('batch ref count ok:false or bad shape fails closed', async function () {
    axios.post.mockResolvedValue({ data: { ok: false } });
    await expect(store.hasBatchReferences('FS-0001')).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
    axios.post.mockResolvedValue({ data: { ok: true, count: 1.5 } });
    await expect(store.hasBatchReferences('FS-0001')).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
    axios.post.mockResolvedValue({ data: { ok: true, count: -1 } });
    await expect(store.hasBatchReferences('FS-0001')).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
  });

  test('recipe count failure fails closed', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, count: 0 } });
    pg.countRecipeReferences.mockRejectedValue(new Error('pg'));
    await expect(store.remove({ schedule_id: 'FS-0001' }, {}))
      .rejects.toMatchObject({ code: 'recipe_ref_unavailable' });
    expect(pg.deleteSchedule).not.toHaveBeenCalled();
  });

  test('RECIPES_STORE=sheets counts recipeStore.list rows', async function () {
    process.env.RECIPES_STORE = 'sheets';
    axios.post.mockResolvedValue({ data: { ok: true, count: 0 } });
    recipeStore.list.mockResolvedValue({ ok: true, data: { recipes: [
      { schedule_id: 'FS-0001' }, { schedule_id: 'FS-0002' }, { schedule_id: 'FS-0001' }
    ] } });
    pg.deleteSchedule.mockResolvedValue({ ok: false, error: 'schedule_in_use' });
    await store.remove({ schedule_id: 'FS-0001' }, {});
    expect(pg.countRecipeReferences).not.toHaveBeenCalled();
    expect(pg.deleteSchedule.mock.calls[0][2].recipeRefCount).toBe(2);
  });

  test('sheet recipe list failure or bad shape fails closed', async function () {
    process.env.RECIPES_STORE = 'sheets';
    recipeStore.list.mockResolvedValue({ ok: false });
    await expect(store.countRecipeReferences('FS-0001')).rejects.toMatchObject({ code: 'recipe_ref_unavailable' });
    recipeStore.list.mockRejectedValue(new Error('x'));
    await expect(store.countRecipeReferences('FS-0001')).rejects.toMatchObject({ code: 'recipe_ref_unavailable' });
  });

  test('success schedules the fermsched mirror (delete)', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, count: 0 } });
    pg.countRecipeReferences.mockResolvedValue(0);
    pg.deleteSchedule.mockResolvedValue({ ok: true, message: 'Schedule deleted', _scheduleId: 'FS-0001', _deleted: true });
    var out = await store.remove({ schedule_id: 'FS-0001' }, {});
    expect(out).toEqual({ ok: true, message: 'Schedule deleted' });
    expect(opsMirror.schedule).toHaveBeenCalledWith('fermsched', 'FS-0001');
  });
});

describe('propagate', function () {
  test('ignores client steps, sends PG steps, actor and token; normalises batches_failed', async function () {
    pg.getSchedule.mockResolvedValue({ schedule_id: 'FS-0001', steps_parsed: [{ a: 1 }] });
    axios.post.mockResolvedValue({ data: { ok: true, batches_updated: 3 } });
    var out = await store.propagate({ schedule_id: 'FS-0001', steps: 'EVIL' }, { actor: 'a@b.ca' });
    var b = body(0);
    expect(b.action).toBe('propagate_ferm_schedule');
    expect(b.steps).toBe(JSON.stringify([{ a: 1 }]));
    expect(b.schedule_id).toBe('FS-0001');
    expect(b.acting_user).toBe('a@b.ca');
    expect(b.server_token).toBe('tok');
    expect(out.batches_failed).toEqual([]);
    expect(out.batches_updated).toBe(3);
  });

  test('keeps an existing batches_failed array', async function () {
    pg.getSchedule.mockResolvedValue({ steps_parsed: [] });
    axios.post.mockResolvedValue({ data: { ok: true, batches_failed: ['B1'] } });
    var out = await store.propagate({ schedule_id: 'FS-0001' }, { actor: 'a' });
    expect(out.batches_failed).toEqual(['B1']);
  });

  test('unknown schedule -> not_found and no Apps Script call', async function () {
    pg.getSchedule.mockResolvedValue(null);
    var out = await store.propagate({ schedule_id: 'FS-0099' }, { actor: 'a' });
    expect(out).toMatchObject({ ok: false, error: 'not_found' });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('getStepsJson', function () {
  test('returns the PG steps as a JSON string', async function () {
    pg.getSchedule.mockResolvedValue({ schedule_id: 'FS-0012', steps_parsed: [{ day: 1 }] });
    await expect(store.getStepsJson('FS-0012')).resolves.toEqual({ ok: true, steps_json: '[{"day":1}]' });
  });

  test('unknown -> not_found with message', async function () {
    pg.getSchedule.mockResolvedValue(null);
    await expect(store.getStepsJson('FS-0099')).resolves.toEqual({
      ok: false, error: 'not_found', message: 'Schedule not found: FS-0099'
    });
  });
});

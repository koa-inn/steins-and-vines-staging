'use strict';

// Phase 87-13: every non-route direct batch caller goes through lib/batch-store.js.
// The facade is mocked here (its own behaviour is covered by batch-store.test.js):
// null = sheets mode (fall through to Apps Script), object = postgres/freeze answer.

jest.mock('axios', function () {
  var axiosMock = jest.fn();
  axiosMock.get = jest.fn();
  axiosMock.post = jest.fn();
  return axiosMock;
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    isConnected: jest.fn().mockReturnValue(true)
  };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
});
jest.mock('../lib/batch-store', function () {
  return {
    isPostgres: jest.fn(),
    isFrozen: jest.fn(),
    create: jest.fn(),
    listAll: jest.fn(),
    countByRecipe: jest.fn(),
    countBySchedule: jest.fn(),
    propagate: jest.fn()
  };
});
jest.mock('../lib/db', function () {
  return {
    withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }),
    isConfigured: jest.fn(function () { return true; })
  };
});
jest.mock('../lib/recipe-pg', function () {
  return {
    listRecipes: jest.fn(), getRecipe: jest.fn(), createRecipe: jest.fn(),
    updateRecipe: jest.fn(), deleteRecipe: jest.fn()
  };
});
jest.mock('../lib/recipe-mirror', function () { return { schedule: jest.fn() }; });
jest.mock('../lib/ferm-schedule-pg', function () {
  return {
    listSchedules: jest.fn(), getSchedule: jest.fn(), createSchedule: jest.fn(),
    updateSchedule: jest.fn(), archiveSchedule: jest.fn(), deleteSchedule: jest.fn(),
    countRecipeReferences: jest.fn()
  };
});
jest.mock('../lib/ops-mirror', function () { return { schedule: jest.fn() }; });

var axios = require('axios');
var log = require('../lib/logger');
var eventLog = require('../lib/eventLog');
var batchStore = require('../lib/batch-store');
var brewpad = require('../lib/brewpad-integration');
var recipeStore = require('../lib/recipe-store');
var fermStore = require('../lib/ferm-schedule-store');
var fermPg = require('../lib/ferm-schedule-pg');

var PAYLOAD = { product_sku: 'K1', product_name: 'Kit', zoho_so_number: 'INV-000200', source: 'kiosk' };

beforeEach(function () {
  jest.clearAllMocks();
  Object.keys(batchStore).forEach(function (k) { batchStore[k].mockReset(); });
  axios.post.mockReset();
  axios.get.mockReset();
  process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  process.env.RECIPES_STORE = 'postgres';
  process.env.OPS_DATA_STORE = 'postgres';
});

describe('callAppsScriptCreateBatch', function () {
  test('sheets mode (facade null) issues exactly the Apps Script create_batch post', async function () {
    batchStore.isPostgres.mockReturnValue(false);
    batchStore.isFrozen.mockReturnValue(false);
    axios.post.mockResolvedValue({ data: { ok: true, batch_id: 'SV-B-000001' } });
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD);
    expect(res).toEqual({ ok: true, batch_id: 'SV-B-000001' });
    expect(batchStore.create).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    var sent = JSON.parse(axios.post.mock.calls[0][1]);
    expect(sent.action).toBe('create_batch');
    expect(sent.zoho_so_number).toBe('INV-000200');
  });

  test('postgres mode creates via the facade with no axios and no Apps Script env', async function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    batchStore.isPostgres.mockReturnValue(true);
    batchStore.create.mockResolvedValue({ ok: true, batch_id: 'SV-B-000002' });
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD);
    expect(res).toEqual({ ok: true, batch_id: 'SV-B-000002' });
    expect(batchStore.create).toHaveBeenCalledWith(PAYLOAD, { actor: 'kiosk-middleware' });
    expect(axios.post).not.toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledWith('kiosk.batch_created', {
      invoiceNumber: 'INV-000200', batchId: 'SV-B-000002'
    });
  });

  test('postgres duplicate_so_number takes the existing error path (queued, ok:false)', async function () {
    batchStore.isPostgres.mockReturnValue(true);
    batchStore.create.mockResolvedValue({ ok: false, error: 'duplicate_so_number', message: 'dup' });
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD);
    expect(res).toEqual({ ok: false });
    expect(eventLog.logEvent).toHaveBeenCalledWith('kiosk.batch_retry_queued', expect.objectContaining({
      reason: 'apps_script_error: duplicate_so_number'
    }));
  });

  test('freeze: maintenance envelope is logged with the invoice and queued for retry', async function () {
    batchStore.isFrozen.mockReturnValue(true);
    batchStore.create.mockResolvedValue({ ok: false, error: 'maintenance', message: 'down' });
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD);
    expect(res).toEqual({ ok: false });
    var warned = log.warn.mock.calls.map(function (c) { return c[0]; }).join('\n');
    expect(warned).toMatch(/maintenance/);
    expect(warned).toMatch(/INV-000200/);
    expect(eventLog.logEvent).toHaveBeenCalledWith('kiosk.batch_retry_queued', expect.objectContaining({
      invoiceNumber: 'INV-000200', reason: 'apps_script_error: maintenance'
    }));
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('freeze with skipRetryQueue does not queue', async function () {
    batchStore.isFrozen.mockReturnValue(true);
    batchStore.create.mockResolvedValue({ ok: false, error: 'maintenance' });
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD, true);
    expect(res).toEqual({ ok: false });
    expect(eventLog.logEvent).not.toHaveBeenCalledWith('kiosk.batch_retry_queued', expect.anything());
  });

  test('facade rejection never throws: queued as http_error', async function () {
    batchStore.isPostgres.mockReturnValue(true);
    batchStore.create.mockRejectedValue(new Error('pg down'));
    var res = await brewpad.callAppsScriptCreateBatch(PAYLOAD);
    expect(res).toEqual({ ok: false });
    expect(eventLog.logEvent).toHaveBeenCalledWith('kiosk.batch_retry_queued', expect.objectContaining({
      reason: 'http_error: pg down'
    }));
  });
});

describe('fetchLiveBatchIndex', function () {
  test('sheets mode (facade null) keeps the Apps Script get_batches call', async function () {
    batchStore.isPostgres.mockReturnValue(false);
    axios.get.mockResolvedValue({ data: { ok: true, data: { batches: [{ batch_id: 'SV-B-000001', zoho_so_number: 'INV-1' }] } } });
    var idx = await brewpad.fetchLiveBatchIndex();
    expect(batchStore.listAll).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(idx.liveBatchIds.has('SV-B-000001')).toBe(true);
    expect(idx.byInvoiceNumber['INV-1']).toHaveLength(1);
  });

  test('postgres mode builds the same index from listAll with no axios', async function () {
    delete process.env.APPS_SCRIPT_URL;
    batchStore.isPostgres.mockReturnValue(true);
    batchStore.listAll.mockResolvedValue([
      { batch_id: 'SV-B-000001', zoho_so_number: 'INV-1' },
      { batch_id: 'SV-B-000002', zoho_so_number: 'INV-1' },
      { batch_id: 'SV-B-000003', zoho_so_number: '' }
    ]);
    var idx = await brewpad.fetchLiveBatchIndex();
    expect(axios.get).not.toHaveBeenCalled();
    expect(Array.from(idx.liveBatchIds).sort()).toEqual(['SV-B-000001', 'SV-B-000002', 'SV-B-000003']);
    expect(idx.byInvoiceNumber['INV-1']).toHaveLength(2);
    expect(Object.keys(idx.byInvoiceNumber)).toEqual(['INV-1']);
  });

  test('listAll rejection resolves null (never throws)', async function () {
    batchStore.isPostgres.mockReturnValue(true);
    batchStore.listAll.mockRejectedValue(new Error('pg down'));
    await expect(brewpad.fetchLiveBatchIndex()).resolves.toBeNull();
  });
});

describe('recipe-store.hasBatchReferences', function () {
  test('postgres mode resolves the SQL count with no Apps Script call', async function () {
    batchStore.countByRecipe.mockResolvedValue(3);
    await expect(recipeStore.hasBatchReferences('R-1')).resolves.toBe(3);
    expect(batchStore.countByRecipe).toHaveBeenCalledWith('R-1');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('facade rejection fails closed with batch_ref_unavailable', async function () {
    batchStore.countByRecipe.mockRejectedValue(new Error('pg down'));
    await expect(recipeStore.hasBatchReferences('R-1')).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sheets mode (null) still asks Apps Script', async function () {
    batchStore.countByRecipe.mockResolvedValue(null);
    axios.post.mockResolvedValue({ data: { ok: true, count: 2 } });
    await expect(recipeStore.hasBatchReferences('R-1')).resolves.toBe(2);
    expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('recipe_batch_ref_count');
  });
});

describe('ferm-schedule-store batch seams', function () {
  test('hasBatchReferences postgres mode uses countBySchedule', async function () {
    batchStore.countBySchedule.mockResolvedValue(0);
    await expect(fermStore.hasBatchReferences('FS-1')).resolves.toBe(0);
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('hasBatchReferences fails closed on facade rejection', async function () {
    batchStore.countBySchedule.mockRejectedValue(new Error('pg down'));
    await expect(fermStore.hasBatchReferences('FS-1')).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
  });

  test('hasBatchReferences sheets mode (null) asks Apps Script', async function () {
    batchStore.countBySchedule.mockResolvedValue(null);
    axios.post.mockResolvedValue({ data: { ok: true, count: 1 } });
    await expect(fermStore.hasBatchReferences('FS-1')).resolves.toBe(1);
    expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('ferm_schedule_ref_count');
  });

  test('propagate postgres mode calls batchStore.propagate and defaults batches_failed', async function () {
    fermPg.getSchedule.mockResolvedValue({ steps_parsed: [{ step_number: 1, day_offset: 0 }] });
    batchStore.propagate.mockResolvedValue({ ok: true, batches_updated: 2 });
    var res = await fermStore.propagate({ schedule_id: 'FS-1' }, { actor: 'a@b.ca' });
    expect(batchStore.propagate).toHaveBeenCalledWith('FS-1', [{ step_number: 1, day_offset: 0 }], { actor: 'a@b.ca' });
    expect(res).toEqual({ ok: true, batches_updated: 2, batches_failed: [] });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('propagate unknown schedule is not_found with no facade call', async function () {
    fermPg.getSchedule.mockResolvedValue(null);
    var res = await fermStore.propagate({ schedule_id: 'FS-9' });
    expect(res.error).toBe('not_found');
    expect(batchStore.propagate).not.toHaveBeenCalled();
  });

  test('propagate under the freeze returns the maintenance envelope', async function () {
    fermPg.getSchedule.mockResolvedValue({ steps_parsed: [] });
    batchStore.propagate.mockResolvedValue({ ok: false, error: 'maintenance', message: 'down' });
    var res = await fermStore.propagate({ schedule_id: 'FS-1' });
    expect(res).toMatchObject({ ok: false, error: 'maintenance', batches_failed: [] });
  });

  test('propagate sheets mode (null) keeps propagate_ferm_schedule', async function () {
    fermPg.getSchedule.mockResolvedValue({ steps_parsed: [{ step_number: 1, day_offset: 0 }] });
    batchStore.propagate.mockResolvedValue(null);
    axios.post.mockResolvedValue({ data: { ok: true } });
    var res = await fermStore.propagate({ schedule_id: 'FS-1' });
    expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('propagate_ferm_schedule');
    expect(res.batches_failed).toEqual([]);
  });
});

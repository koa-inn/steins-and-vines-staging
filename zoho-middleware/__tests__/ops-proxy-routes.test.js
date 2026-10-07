'use strict';

// Phase 86-16 Task 2: overlay hooks in the pos.js admin/BrewPad proxies and forwarder.
// authTiers is real; lib/session is mocked (same approach as batch-admin-proxy.test.js).

var mockRouteHandlers = {};

jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (path, handler) { mockRouteHandlers['GET:' + path] = handler; }),
    post:   jest.fn(function (path, handler) { mockRouteHandlers['POST:' + path] = handler; }),
    put:    jest.fn(function (path, handler) { mockRouteHandlers['PUT:' + path] = handler; }),
    delete: jest.fn(function (path, handler) { mockRouteHandlers['DELETE:' + path] = handler; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

jest.mock('../lib/eventLog', function () {
  return { logEvent: jest.fn() };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    isConnected: jest.fn().mockReturnValue(false)
  };
});

jest.mock('../lib/mailer', function () { return { sendBottlingInvite: jest.fn().mockResolvedValue() }; });
jest.mock('../lib/inventory-ledger', function () { return { decrementStock: jest.fn().mockResolvedValue() }; });
jest.mock('../lib/brewpad-integration', function () {
  return {
    detectKitItems: jest.fn(),
    kitBatchQuantity: jest.fn(),
    callAppsScriptCreateBatch: jest.fn(),
    splitCustomerName: jest.fn(),
    syncBatchToZoho: jest.fn().mockResolvedValue({ ok: true }),
    createBatchesFromSale: jest.fn(),
    retryPendingBatches: jest.fn().mockResolvedValue(),
    detectRecipeSale: jest.fn(),
    queueSyncForRetry: jest.fn().mockResolvedValue(),
    retrySyncQueue: jest.fn().mockResolvedValue(),
    resolveInvoiceByNumber: jest.fn(),
    fetchLiveBatchIndex: jest.fn()
  };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() };
});
jest.mock('../lib/helcim', function () {
  return {
    isTerminalEnabled: jest.fn().mockReturnValue(false),
    terminalPurchase: jest.fn().mockResolvedValue({ ok: true }),
    pollTerminalResult: jest.fn().mockResolvedValue({ status: 'APPROVED' }),
    generateIdempotencyKey: jest.fn().mockReturnValue('test-idem-key'),
    voidTransaction: jest.fn().mockResolvedValue({ ok: true })
  };
});
jest.mock('../lib/session', function () {
  return {
    createSession: jest.fn().mockResolvedValue('mock-sid'),
    getSession: jest.fn().mockResolvedValue(null),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn().mockResolvedValue(null)
  };
});

var mockVesselStore = { getMode: jest.fn(), list: jest.fn(), applyStatusChanges: jest.fn() };
var mockSchedStore = { list: jest.fn(), getStepsJson: jest.fn() };
jest.mock('../lib/vessel-store', function () { return mockVesselStore; });
jest.mock('../lib/ferm-schedule-store', function () { return mockSchedStore; });

var session = require('../lib/session');
require('../routes/pos');
var axios = require('axios');

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + path];
    if (!handler) return reject(new Error('No handler for ' + method + ':' + path));
    var res = {
      _status: 200, _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
}

function sessionReq(body) {
  return { headers: { 'x-session-token': 'valid-sid' }, body: body, params: {}, query: {} };
}

beforeEach(function () {
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  session.getSession.mockReset();
  session.getSession.mockResolvedValue({ email: 'staff@x.ca' });
  axios.post.mockReset();
  axios.get.mockReset();
  mockVesselStore.getMode.mockReset().mockReturnValue('postgres');
  mockVesselStore.list.mockReset().mockResolvedValue({ ok: true, data: { vessels: [{ vessel_id: 'FV-1' }] } });
  mockVesselStore.applyStatusChanges.mockReset().mockResolvedValue({ applied: ['FV-1'] });
  mockSchedStore.list.mockReset().mockResolvedValue({ ok: true, data: { schedules: [{ schedule_id: 'FS-1' }] } });
  mockSchedStore.getStepsJson.mockReset().mockResolvedValue({ ok: true, steps_json: '[{"a":1}]' });
});

describe('ops-proxy overlay through the pos.js proxies (86-16)', function () {
  test('sheets: archive_ferm_schedule forwards as delete_ferm_schedule', function () {
    mockVesselStore.getMode.mockReturnValue('sheets');
    axios.post.mockResolvedValue({ data: { ok: true } });
    return callHandler('POST', '/api/admin/proxy', sessionReq({ action: 'archive_ferm_schedule', schedule_id: 'FS-1' })).then(function (res) {
      expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('delete_ferm_schedule');
      expect(res._body).toEqual({ ok: true });
    });
  });

  test('sheets: write payload has no collect/sheet-write fields', function () {
    mockVesselStore.getMode.mockReturnValue('sheets');
    axios.post.mockResolvedValue({ data: { ok: true } });
    return callHandler('POST', '/api/admin/proxy', sessionReq({ action: 'update_batch', batch_id: 'B1' })).then(function () {
      var sent = JSON.parse(axios.post.mock.calls[0][1]);
      expect(sent.collect_vessel_status).toBeUndefined();
      expect(sent.vessel_sheet_write).toBeUndefined();
    });
  });

  test('postgres: BrewPad get_vessels and get_ferm_schedules never call axios', function () {
    return callHandler('POST', '/api/batch/admin-proxy', sessionReq({ action: 'get_vessels' })).then(function (res) {
      expect(res._body.data.vessels).toHaveLength(1);
      return callHandler('POST', '/api/batch/admin-proxy', sessionReq({ action: 'get_ferm_schedules' }));
    }).then(function (res) {
      expect(res._body.data.schedules).toHaveLength(1);
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('postgres: session write collects status, applies changes, strips key', function () {
    axios.post.mockResolvedValue({ data: { ok: true, vessel_status_changes: [{ vessel_id: 'FV-1', status: 'in_use' }] } });
    return callHandler('POST', '/api/admin/proxy', sessionReq({ action: 'update_batch', batch_id: 'B1' })).then(function (res) {
      var sent = JSON.parse(axios.post.mock.calls[0][1]);
      expect(sent.collect_vessel_status).toBe(true);
      expect(sent.vessel_sheet_write).toBe(false);
      expect(mockVesselStore.applyStatusChanges).toHaveBeenCalledWith(
        [{ vessel_id: 'FV-1', status: 'in_use' }], { actor: 'staff@x.ca' });
      expect(res._body).toEqual({ ok: true });
    });
  });

  test('postgres: public batch write collects status without vessel_sheet_write', function () {
    axios.post.mockResolvedValue({ data: { ok: true, vessel_status_changes: [{ vessel_id: 'FV-2', status: 'available' }] } });
    return callHandler('POST', '/api/batch/public/:id/tasks', {
      params: { id: 'SV-B-000201' }, body: { batch_token: 't', task_id: 'T1', updates: {} }
    }).then(function (res) {
      var sent = JSON.parse(axios.post.mock.calls[0][1]);
      expect(sent.collect_vessel_status).toBe(true);
      expect('vessel_sheet_write' in sent).toBe(false);
      expect(mockVesselStore.applyStatusChanges.mock.calls[0][1]).toEqual({ actor: 'middleware' });
      expect(res._body).toEqual({ ok: true });
    });
  });

  test('postgres: get_batch_init schedules replaced', function () {
    axios.get.mockResolvedValue({ data: { ok: true, data: { schedules: [{ schedule_id: 'OLD' }] } } });
    return callHandler('POST', '/api/admin/proxy', sessionReq({ action: 'get_batch_init' })).then(function (res) {
      expect(res._body.data.schedules).toEqual([{ schedule_id: 'FS-1' }]);
    });
  });

  test('postgres: create_batch with schedule_id carries steps from PG', function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    return callHandler('POST', '/api/admin/proxy', sessionReq({
      action: 'create_batch', schedule_id: 'FS-1', schedule_steps_json: 'evil'
    })).then(function () {
      expect(JSON.parse(axios.post.mock.calls[0][1]).schedule_steps_json).toBe('[{"a":1}]');
    });
  });

  test('upstream failure still collapses to 502', function () {
    axios.post.mockRejectedValue(new Error('boom'));
    return callHandler('POST', '/api/admin/proxy', sessionReq({ action: 'update_batch' })).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });
});

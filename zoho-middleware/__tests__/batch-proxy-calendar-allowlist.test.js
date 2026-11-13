'use strict';

// Regression (found 2026-11-12 during Phase 99): the v2 dashboard packaging calendar (Phase 97)
// calls get_tasks_calendar through /api/batch/admin-proxy, but only /api/admin/proxy allow-listed
// it, so BrewPad always got 400 invalid_action and the calendar never showed its tasks.
// Same harness as batch-dash-stats-route.test.js (authTiers real, session mocked, batch-store mocked).

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

jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
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
    detectKitItems: jest.fn(), kitBatchQuantity: jest.fn(), callAppsScriptCreateBatch: jest.fn(),
    splitCustomerName: jest.fn(), syncBatchToZoho: jest.fn().mockResolvedValue({ ok: true }),
    createBatchesFromSale: jest.fn(), retryPendingBatches: jest.fn().mockResolvedValue(),
    detectRecipeSale: jest.fn(), queueSyncForRetry: jest.fn().mockResolvedValue(),
    retrySyncQueue: jest.fn().mockResolvedValue(), resolveInvoiceByNumber: jest.fn(),
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

var mockBatchStore = { calendar: jest.fn() };
jest.mock('../lib/batch-store', function () { return mockBatchStore; });

var session = require('../lib/session');
var axios = require('axios');
require('../routes/pos');

function callHandler(path, body, headers) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers['POST:' + path];
    if (!handler) return reject(new Error('No handler for ' + path));
    var res = {
      _status: 200, _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    var req = { headers: headers || { 'x-session-token': 'valid-sid' }, body: body, params: {}, query: {} };
    try { handler(req, res); } catch (e) { reject(e); }
  });
}

var CAL = { ok: true, data: { tasks: [{ task_id: 'T-1', batch_id: 'SV-B-000001', due_date: '2026-07-06' }] } };
var REQ = { action: 'get_tasks_calendar', start_date: '2026-07-06', end_date: '2026-07-19' };

beforeEach(function () {
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  delete process.env.BATCHES_STORE;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  session.getSession.mockReset().mockResolvedValue({ email: 'staff@x.ca' });
  axios.post.mockReset().mockResolvedValue({ data: { ok: false, error: 'invalid_action' } });
  axios.get.mockReset().mockResolvedValue({ data: { ok: true, data: { tasks: [] } } });
  mockVesselStore.getMode.mockReset().mockReturnValue('sheets');
  mockBatchStore.calendar.mockReset().mockResolvedValue(CAL);
});

afterEach(function () {
  delete process.env.BATCHES_STORE;
});

describe('get_tasks_calendar through /api/batch/admin-proxy (BrewPad packaging calendar)', function () {
  test('postgres + session tier: served by the store with the date range, Apps Script untouched', async function () {
    process.env.BATCHES_STORE = 'postgres';
    var res = await callHandler('/api/batch/admin-proxy', REQ);
    expect(res._status).toBe(200);
    expect(res._body).toEqual(CAL);
    expect(mockBatchStore.calendar).toHaveBeenCalledTimes(1);
    expect(mockBatchStore.calendar.mock.calls[0][0]).toMatchObject({ start_date: '2026-07-06', end_date: '2026-07-19' });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sheets mode: forwarded to Apps Script as a GET (a read), never a POST', async function () {
    var res = await callHandler('/api/batch/admin-proxy', REQ);
    expect(res._status).toBe(200);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
    expect(mockBatchStore.calendar).not.toHaveBeenCalled();
  });

  test('no auth is rejected and the store is not called', async function () {
    process.env.BATCHES_STORE = 'postgres';
    session.getSession.mockResolvedValue(null);
    var res = await callHandler('/api/batch/admin-proxy', REQ, {});
    expect(res._status).toBeGreaterThanOrEqual(401);
    expect(mockBatchStore.calendar).not.toHaveBeenCalled();
  });

  test('an unknown action is still rejected (allow-list, not a passthrough)', async function () {
    var res = await callHandler('/api/batch/admin-proxy', { action: 'get_everything' });
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ ok: false, error: 'invalid_action' });
  });
});

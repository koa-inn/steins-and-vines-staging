'use strict';

// Phase 87-12 Task 1: batch overlay in both pos.js admin proxies (DB-06, D-05, D-14).
// authTiers is real; lib/session is mocked (same harness as ops-proxy-routes.test.js).
// lib/batch-flag is real and driven by env; lib/batch-store is mocked.

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

var OPS = [
  'list', 'detail', 'dashboard', 'upcoming', 'calendar', 'batchInit', 'create', 'update',
  'updateSchedule', 'remove', 'updateTask', 'bulkUpdateTasks', 'addTask', 'bulkAddReadings',
  'updateReading', 'deleteReading', 'regenerateToken'
];
var mockBatchStore = {};
OPS.forEach(function (op) { mockBatchStore[op] = jest.fn(); });
jest.mock('../lib/batch-store', function () { return mockBatchStore; });

var session = require('../lib/session');
var log = require('../lib/logger');
var axios = require('axios');
var batchProxy = require('../lib/batch-proxy');
require('../routes/pos');

var ACTION_OPS = batchProxy.ACTION_TO_OP;
var PROXIES = ['/api/batch/admin-proxy', '/api/admin/proxy'];
// Batch actions only the admin-panel proxy allow-lists.
var PANEL_ONLY = ['get_tasks_calendar', 'get_batch_init', 'update_batch_task', 'add_batch_task', 'regenerate_batch_token'];

function allowed(path, action) {
  if (path === '/api/admin/proxy') return true;
  return PANEL_ONLY.indexOf(action) === -1;
}

function callHandler(path, body) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers['POST:' + path];
    if (!handler) return reject(new Error('No handler for ' + path));
    var res = {
      _status: 200, _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    var req = { headers: { 'x-session-token': 'valid-sid' }, body: body, params: {}, query: {} };
    try { handler(req, res); } catch (e) { reject(e); }
  });
}

beforeEach(function () {
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  session.getSession.mockReset().mockResolvedValue({ email: 'staff@x.ca' });
  axios.post.mockReset().mockResolvedValue({ data: { ok: true, via: 'apps-script' } });
  axios.get.mockReset().mockResolvedValue({ data: { ok: true, via: 'apps-script' } });
  mockVesselStore.getMode.mockReset().mockReturnValue('sheets');
  mockSchedStore.list.mockReset().mockResolvedValue({ ok: true, data: { schedules: [] } });
  mockSchedStore.getStepsJson.mockReset();
  OPS.forEach(function (op) { mockBatchStore[op].mockReset().mockResolvedValue({ ok: true, data: { op: op } }); });
  Object.keys(log).forEach(function (k) { log[k].mockClear(); });
});

afterEach(function () {
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
});

describe('batch-proxy ACTION_TO_OP', function () {
  test('maps exactly the 17 batch-data actions', function () {
    expect(Object.keys(ACTION_OPS)).toHaveLength(17);
    expect(batchProxy.intercept('get_vessels', {}, {}, {}, 't')).toBe(false);
    expect(batchProxy.intercept('get_waitlist', {}, {}, {}, 't')).toBe(false);
    expect(batchProxy.intercept('propagate_ferm_schedule', {}, {}, {}, 't')).toBe(false);
  });
});

PROXIES.forEach(function (path) {
  describe(path, function () {
    var actions = Object.keys(ACTION_OPS).filter(function (a) { return allowed(path, a); });

    test('sheets mode: every batch action forwards to Apps Script, facade untouched', function () {
      var chain = Promise.resolve();
      actions.forEach(function (action) {
        chain = chain.then(function () {
          axios.get.mockClear();
          axios.post.mockClear();
          return callHandler(path, { action: action, batch_id: 'SV-B-000001' }).then(function (res) {
            expect(res._body).toEqual({ ok: true, via: 'apps-script' });
            expect(axios.get.mock.calls.length + axios.post.mock.calls.length).toBe(1);
          });
        });
      });
      return chain.then(function () {
        OPS.forEach(function (op) { expect(mockBatchStore[op]).not.toHaveBeenCalled(); });
      });
    });

    test('postgres mode: every batch action is served by the facade, never Apps Script', function () {
      process.env.BATCHES_STORE = 'postgres';
      var chain = Promise.resolve();
      actions.forEach(function (action) {
        chain = chain.then(function () {
          return callHandler(path, { action: action, batch_id: 'SV-B-000001' }).then(function (res) {
            expect(res._status).toBe(200);
            expect(res._body).toEqual({ ok: true, data: { op: ACTION_OPS[action] } });
            expect(mockBatchStore[ACTION_OPS[action]]).toHaveBeenCalledTimes(1);
          });
        });
      });
      return chain.then(function () {
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
      });
    });

    test('postgres mode: opsProxy is not reached for batch actions', function () {
      process.env.BATCHES_STORE = 'postgres';
      mockVesselStore.getMode.mockReturnValue('postgres');
      return callHandler(path, { action: 'create_batch', schedule_id: 'FS-1' }).then(function () {
        expect(mockSchedStore.getStepsJson).not.toHaveBeenCalled();
        expect(mockBatchStore.create).toHaveBeenCalledTimes(1);
      });
    });

    test('postgres mode: business {ok:false} stays HTTP 200', function () {
      process.env.BATCHES_STORE = 'postgres';
      mockBatchStore.update.mockResolvedValue({ ok: false, error: 'version_conflict', message: 'm' });
      return callHandler(path, { action: 'update_batch', batch_id: 'SV-B-000001' }).then(function (res) {
        expect(res._status).toBe(200);
        expect(res._body).toEqual({ ok: false, error: 'version_conflict', message: 'm' });
      });
    });

    test('postgres mode: facade rejection -> 502 server_error with no detail', function () {
      process.env.BATCHES_STORE = 'postgres';
      mockBatchStore.detail.mockRejectedValue(new Error('secret pg detail'));
      return callHandler(path, { action: 'get_batch', batch_id: 'SV-B-000001' }).then(function (res) {
        expect(res._status).toBe(502);
        expect(res._body).toEqual({ ok: false, error: 'server_error' });
        expect(JSON.stringify(res._body)).not.toContain('secret');
        expect(log.error).toHaveBeenCalled();
      });
    });

    test('actor is the session email, never a body-supplied value', function () {
      process.env.BATCHES_STORE = 'postgres';
      return callHandler(path, { action: 'update_batch', batch_id: 'SV-B-000001', acting_user: 'evil@x.ca' }).then(function () {
        var args = mockBatchStore.update.mock.calls[0];
        expect(args[1].actor).toBe('staff@x.ca');
        expect(args[0].acting_user).toBe('staff@x.ca');
      });
    });

    ['sheets', 'postgres'].forEach(function (mode) {
      test('freeze (' + mode + '): writes -> 503 maintenance, reads still served', function () {
        if (mode === 'postgres') process.env.BATCHES_STORE = 'postgres';
        process.env.BATCHES_FREEZE = 'Saturday 4 PM';
        var writes = actions.filter(function (a) { return batchProxy.WRITE_ACTIONS[a]; });
        var chain = Promise.resolve();
        writes.forEach(function (action) {
          chain = chain.then(function () {
            return callHandler(path, { action: action, batch_id: 'SV-B-000001' }).then(function (res) {
              expect(res._status).toBe(503);
              expect(res._body).toEqual({
                ok: false,
                error: 'maintenance',
                message: 'Batches are read-only for maintenance until Saturday 4 PM. Please try again then.'
              });
            });
          });
        });
        return chain.then(function () {
          expect(axios.post).not.toHaveBeenCalled();
          OPS.forEach(function (op) { expect(mockBatchStore[op]).not.toHaveBeenCalled(); });
          return callHandler(path, { action: 'get_batches' });
        }).then(function (res) {
          expect(res._status).toBe(200);
          if (mode === 'postgres') {
            expect(mockBatchStore.list).toHaveBeenCalledTimes(1);
          } else {
            expect(axios.get).toHaveBeenCalledTimes(1);
          }
        });
      });
    });

    test('create_batch logs its duration', function () {
      process.env.BATCHES_STORE = 'postgres';
      return callHandler(path, { action: 'create_batch', zoho_so_number: 'INV-1' }).then(function () {
        var msgs = log.info.mock.calls.map(function (c) { return c[0]; });
        expect(msgs.some(function (m) { return /^\[batch-proxy\] create_batch ms=\d+$/.test(m); })).toBe(true);
      });
    });

    test('actions outside the batch map are not intercepted (get_vessels forwards)', function () {
      process.env.BATCHES_STORE = 'postgres';
      return callHandler(path, { action: 'get_vessels' }).then(function (res) {
        expect(res._body).toEqual({ ok: true, via: 'apps-script' });
        OPS.forEach(function (op) { expect(mockBatchStore[op]).not.toHaveBeenCalled(); });
      });
    });
  });
});

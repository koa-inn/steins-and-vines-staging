'use strict';

// Phase 78-02: BrewPad's two waitlist actions on the existing hardened
// /api/batch/admin-proxy. Asserts the two-whitelist gate (RESEARCH.md
// Pitfall 1 — the most likely integration bug in this phase):
//   - get_waitlist is in BOTH ADMIN_PROXY_ACTIONS and ADMIN_PROXY_READS,
//     so it is forwarded to Apps Script as a GET.
//   - update_waitlist_status is in ADMIN_PROXY_ACTIONS only, so it is
//     forwarded as a POST.
//   - add_waitlist_entry is in NEITHER — staff never create waitlist rows
//     from BrewPad; signups arrive only through the public POST /api/waitlist
//     endpoint via the middleware's own server_token call.
//
// Mirrors __tests__/batch-admin-proxy.test.js's mock-express-router +
// mock-axios harness. lib/authTiers / lib/apiKey / lib/deviceToken are NOT
// mocked so the real tier gate runs end-to-end; lib/session IS mocked
// (mock-mirrors-real-contract) purely to avoid a real Redis dial.

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

var session = require('../lib/session');

require('../routes/pos');

var axios = require('axios');

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var key = method + ':' + path;
    var handler = mockRouteHandlers[key];
    if (!handler) return reject(new Error('No handler registered for ' + key));
    var res = {
      _status: 200,
      _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json:   jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    try {
      var maybe = handler(req || {}, res);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(reject);
    } catch (e) { reject(e); }
  });
}

var OLD_API_SECRET_KEY, OLD_MW_API_KEY, OLD_DEVICE_TOKEN;

beforeEach(function () {
  OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
  OLD_MW_API_KEY = process.env.MW_API_KEY;
  OLD_DEVICE_TOKEN = process.env.KIOSK_DEVICE_TOKEN;
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = 'test-device-token';
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  session.getSession.mockReset();
  session.getSession.mockResolvedValue(null);
  axios.post.mockReset();
  axios.get.mockReset();
});

afterEach(function () {
  process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  process.env.MW_API_KEY = OLD_MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = OLD_DEVICE_TOKEN;
});

var SESSION_HEADERS = { 'x-session-token': 'valid-sid' };
var DEVICE_HEADERS = { 'x-device-token': 'test-device-token' };

describe('POST /api/batch/admin-proxy — waitlist actions (Phase 78-02)', function () {

  test('get_waitlist with a valid session forwards via axios.GET, strips client token', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.get.mockResolvedValue({ data: { ok: true, data: [] } });

    var req = { headers: SESSION_HEADERS, body: { action: 'get_waitlist', token: 'client-google-token' } };
    return callHandler('POST', '/api/batch/admin-proxy', req).then(function (res) {
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.post).not.toHaveBeenCalled();
      var cfg = axios.get.mock.calls[0][1];
      expect(cfg.params.action).toBe('get_waitlist');
      expect(cfg.params.server_token).toBe(process.env.APPS_SCRIPT_SERVER_TOKEN);
      expect(cfg.params.token).toBeUndefined();
      expect(res._status).not.toBe(400);
      expect(res._status).not.toBe(401);
    });
  });

  test('update_waitlist_status with a valid session forwards via axios.POST, server_token in body', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.post.mockResolvedValue({ data: { ok: true, id: 'w-1', status: 'contacted' } });

    var req = {
      headers: SESSION_HEADERS,
      body: { action: 'update_waitlist_status', id: 'w-1', status: 'contacted', token: 'client-google-token' }
    };
    return callHandler('POST', '/api/batch/admin-proxy', req).then(function (res) {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.action).toBe('update_waitlist_status');
      expect(payload.server_token).toBe(process.env.APPS_SCRIPT_SERVER_TOKEN);
      expect(payload.token).toBeUndefined();
      expect(res._status).not.toBe(400);
    });
  });

  test('add_waitlist_entry is rejected 400 invalid_action — never reachable from BrewPad', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });

    var req = { headers: SESSION_HEADERS, body: { action: 'add_waitlist_entry', email: 'x@example.com' } };
    return callHandler('POST', '/api/batch/admin-proxy', req).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ ok: false, error: 'invalid_action' });
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('get_waitlist with NO credential -> 401, Apps Script never called', function () {
    var req = { headers: {}, body: { action: 'get_waitlist' } };
    return callHandler('POST', '/api/batch/admin-proxy', req).then(function (res) {
      expect(res._status).toBe(401);
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('get_waitlist with a device-token-only credential is rejected (session/legacy only)', function () {
    var req = { headers: DEVICE_HEADERS, body: { action: 'get_waitlist' } };
    return callHandler('POST', '/api/batch/admin-proxy', req).then(function (res) {
      expect([401, 403]).toContain(res._status);
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

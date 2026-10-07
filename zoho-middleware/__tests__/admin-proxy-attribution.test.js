'use strict';

// Phase 86-02: regression test for the Phase 82 attribution loss. Both admin
// proxies must forward the session staff email as acting_user and strip every
// server-only field a client could smuggle in via the body merge (Pitfall 9).
// Harness mirrors admin-proxy.test.js.

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

// lib/session — mock-mirrors-real-contract: getSession(sid) -> Promise<{email}|null>.
// authTiers.resolveTier itself is real; only its session-store dependency is
// stubbed (matches __tests__/batch-admin-proxy.test.js's approach).
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


var OLD_ENV = {};
var ENV_KEYS = ['API_SECRET_KEY', 'MW_API_KEY', 'KIOSK_DEVICE_TOKEN', 'APPS_SCRIPT_URL', 'APPS_SCRIPT_SERVER_TOKEN'];

beforeEach(function () {
  ENV_KEYS.forEach(function (k) { OLD_ENV[k] = process.env[k]; });
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = 'test-device-token';
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  session.getSession.mockReset();
  axios.post.mockReset();
  axios.get.mockReset();
  axios.post.mockResolvedValue({ data: { ok: true } });
  axios.get.mockResolvedValue({ data: { ok: true } });
});

afterEach(function () {
  ENV_KEYS.forEach(function (k) {
    if (OLD_ENV[k] === undefined) delete process.env[k]; else process.env[k] = OLD_ENV[k];
  });
});

var SESSION_HEADERS = { 'x-session-token': 'valid-sid' };
var STAFF = 'staff@example.com';
var SERVER_ONLY = { collect_vessel_status: true, vessel_sheet_write: true, schedule_steps_json: '[{"day":1}]' };

function useSession() {
  session.getSession.mockResolvedValue({ email: STAFF });
}

function useLegacy() {
  process.env.API_SECRET_KEY = 'legacy-secret';
  session.getSession.mockResolvedValue(null);
  return { 'x-api-key': 'legacy-secret' };
}

function forwardedPost() {
  expect(axios.post).toHaveBeenCalledTimes(1);
  return JSON.parse(axios.post.mock.calls[0][1]);
}

['/api/admin/proxy', '/api/batch/admin-proxy'].forEach(function (path) {
  describe('POST ' + path + ' - acting_user attribution (Phase 86-02)', function () {
    it('session write forwards the session staff email as acting_user', function () {
      useSession();
      return callHandler('POST', path, { headers: SESSION_HEADERS, body: { action: 'update_batch', batch_id: 'B1' } })
        .then(function () {
          expect(forwardedPost().acting_user).toBe(STAFF);
        });
    });

    it('client-supplied acting_user is overwritten by the session email', function () {
      useSession();
      return callHandler('POST', path, { headers: SESSION_HEADERS, body: { action: 'update_batch', acting_user: 'evil@x.com' } })
        .then(function () {
          expect(forwardedPost().acting_user).toBe(STAFF);
        });
    });

    it('legacy x-api-key write carries no acting_user even if the body supplies one', function () {
      var headers = useLegacy();
      return callHandler('POST', path, { headers: headers, body: { action: 'update_batch', acting_user: 'evil@x.com' } })
        .then(function () {
          expect(forwardedPost()).not.toHaveProperty('acting_user');
        });
    });

    it('strips client-supplied collect_vessel_status / vessel_sheet_write / schedule_steps_json', function () {
      useSession();
      var b = Object.assign({ action: 'update_batch' }, SERVER_ONLY);
      return callHandler('POST', path, { headers: SESSION_HEADERS, body: b }).then(function () {
        var p = forwardedPost();
        expect(p).not.toHaveProperty('collect_vessel_status');
        expect(p).not.toHaveProperty('vessel_sheet_write');
        expect(p).not.toHaveProperty('schedule_steps_json');
      });
    });

    it('read actions carry no client-supplied server-only field', function () {
      useSession();
      var b = Object.assign({ action: 'get_batches', acting_user: 'evil@x.com' }, SERVER_ONLY);
      return callHandler('POST', path, { headers: SESSION_HEADERS, body: b }).then(function () {
        expect(axios.get).toHaveBeenCalledTimes(1);
        var params = axios.get.mock.calls[0][1].params;
        expect(params).not.toHaveProperty('collect_vessel_status');
        expect(params).not.toHaveProperty('vessel_sheet_write');
        expect(params).not.toHaveProperty('schedule_steps_json');
        expect(params.acting_user).toBe(STAFF);
      });
    });

    it('legacy read has no acting_user', function () {
      var headers = useLegacy();
      return callHandler('POST', path, { headers: headers, body: { action: 'get_batches', acting_user: 'evil@x.com' } })
        .then(function () {
          expect(axios.get.mock.calls[0][1].params).not.toHaveProperty('acting_user');
        });
    });
  });
});

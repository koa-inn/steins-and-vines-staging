'use strict';

// Phase 82-05 (D-12/D-13/D-14): the three token-authenticated public batch
// routes js/batch.js (82-08) calls instead of talking to Apps Script
// directly. Asserts:
//   (1) GET forwards exactly {action:'get_batch_public', batch_id, token}
//       via axios.GET (query params) — no server_token, no extra keys;
//   (2) POST tasks forwards exactly {action:'update_batch_task', batch_id
//       (from the ROUTE, never the body), batch_token, task_id, updates}
//       via axios.POST;
//   (3) POST readings forwards exactly {action:'bulk_add_plato_readings',
//       batch_id (from the route), batch_token, readings} via axios.POST;
//   (4) a malformed token is still forwarded as-is — the middleware never
//       validates the token itself (D-13; Apps Script is the validator) —
//       and the upstream {ok:false,error:'invalid_token'} body passes
//       through with HTTP 200;
//   (5) an axios rejection on any of the three routes collapses to 502
//       {ok:false,error:'server_error'};
//   (6) none of the three handlers ever invoke authTiers — they must be
//       callable with a bare req that carries no headers at all.
//
// Harness cloned verbatim from __tests__/batch-admin-proxy.test.js (mock
// express router capture, mock axios, logger/cache/session/etc mocks).

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

// lib/session — mock-mirrors-real-contract, unused by these routes (they
// never call authTiers) but required so requiring routes/pos.js doesn't
// dial a real Redis client via other routes' session lookups.
jest.mock('../lib/session', function () {
  return {
    createSession: jest.fn().mockResolvedValue('mock-sid'),
    getSession: jest.fn().mockResolvedValue(null),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn().mockResolvedValue(null)
  };
});

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

var OLD_APPS_SCRIPT_URL, OLD_APPS_SCRIPT_SERVER_TOKEN;

beforeEach(function () {
  OLD_APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
  OLD_APPS_SCRIPT_SERVER_TOKEN = process.env.APPS_SCRIPT_SERVER_TOKEN;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  axios.post.mockReset();
  axios.get.mockReset();
});

afterEach(function () {
  process.env.APPS_SCRIPT_URL = OLD_APPS_SCRIPT_URL;
  process.env.APPS_SCRIPT_SERVER_TOKEN = OLD_APPS_SCRIPT_SERVER_TOKEN;
});

var TOKEN_32HEX = new Array(33).join('a'); // 'a' * 32

describe('GET /api/batch/public/:id — forwards get_batch_public (Phase 82-05, D-13)', function () {
  test('forwards exactly {action, batch_id, token} — no server_token, no extra keys, axios.post never called', function () {
    axios.get.mockResolvedValue({ data: { ok: true, batch: {} } });

    var req = {
      params: { id: 'SV-B-000123' },
      query: { token: TOKEN_32HEX, action: 'update_batch', server_token: 'x' }
    };
    return callHandler('GET', '/api/batch/public/:id', req).then(function () {
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(axios.post).not.toHaveBeenCalled();
      var forwardedUrl = axios.get.mock.calls[0][0];
      expect(forwardedUrl).toBe(process.env.APPS_SCRIPT_URL);
      var params = axios.get.mock.calls[0][1].params;
      expect(params).toEqual({
        action: 'get_batch_public',
        batch_id: 'SV-B-000123',
        token: TOKEN_32HEX
      });
    });
  });

  test('malformed token is still forwarded — upstream invalid_token body passes through as HTTP 200', function () {
    axios.get.mockResolvedValue({ data: { ok: false, error: 'invalid_token' } });

    var req = { params: { id: 'SV-B-000123' }, query: { token: 'nothex' } };
    return callHandler('GET', '/api/batch/public/:id', req).then(function (res) {
      var params = axios.get.mock.calls[0][1].params;
      expect(params.token).toBe('nothex');
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: false, error: 'invalid_token' });
    });
  });

  test('axios rejection -> 502 {ok:false,error:"server_error"}', function () {
    axios.get.mockRejectedValue(new Error('ECONNRESET'));

    var req = { params: { id: 'SV-B-000123' }, query: { token: TOKEN_32HEX } };
    return callHandler('GET', '/api/batch/public/:id', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });

  test('callable with a bare req carrying no headers at all (no authTiers gate)', function () {
    axios.get.mockResolvedValue({ data: { ok: true } });
    var req = { params: { id: 'SV-B-000123' }, query: { token: TOKEN_32HEX } };
    delete req.headers;
    return callHandler('GET', '/api/batch/public/:id', req).then(function (res) {
      expect(res._status).not.toBe(401);
      expect(res._status).not.toBe(403);
    });
  });
});

describe('POST /api/batch/public/:id/tasks — forwards update_batch_task (Phase 82-05, D-13)', function () {
  test('forwards exactly {action, batch_id (route), batch_token, task_id, updates} — client action/server_token/body-batch_id ignored', function () {
    axios.post.mockResolvedValue({ data: { ok: true } });

    var req = {
      params: { id: 'SV-B-000123' },
      body: {
        batch_token: 't',
        task_id: 'BT-000001',
        updates: { completed: true },
        action: 'delete_batch',
        server_token: 'x',
        batch_id: 'SV-B-999999'
      }
    };
    return callHandler('POST', '/api/batch/public/:id/tasks', req).then(function () {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
      var callArgs = axios.post.mock.calls[0];
      expect(callArgs[0]).toBe(process.env.APPS_SCRIPT_URL);
      var payload = JSON.parse(callArgs[1]);
      expect(payload).toEqual({
        action: 'update_batch_task',
        batch_id: 'SV-B-000123',
        batch_token: 't',
        task_id: 'BT-000001',
        updates: { completed: true }
      });
    });
  });

  test('malformed batch_token is still forwarded — upstream invalid_token body passes through as HTTP 200', function () {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'invalid_token' } });

    var req = {
      params: { id: 'SV-B-000123' },
      body: { batch_token: 'nothex', task_id: 'BT-000001', updates: {} }
    };
    return callHandler('POST', '/api/batch/public/:id/tasks', req).then(function (res) {
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.batch_token).toBe('nothex');
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: false, error: 'invalid_token' });
    });
  });

  test('axios rejection -> 502 {ok:false,error:"server_error"}', function () {
    axios.post.mockRejectedValue(new Error('ECONNRESET'));

    var req = {
      params: { id: 'SV-B-000123' },
      body: { batch_token: 't', task_id: 'BT-000001', updates: {} }
    };
    return callHandler('POST', '/api/batch/public/:id/tasks', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });

  test('callable with a bare req carrying no headers at all (no authTiers gate)', function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var req = { params: { id: 'SV-B-000123' }, body: { batch_token: 't', task_id: 'BT-000001', updates: {} } };
    delete req.headers;
    return callHandler('POST', '/api/batch/public/:id/tasks', req).then(function (res) {
      expect(res._status).not.toBe(401);
      expect(res._status).not.toBe(403);
    });
  });
});

describe('POST /api/batch/public/:id/readings — forwards bulk_add_plato_readings (Phase 82-05, D-13)', function () {
  test('forwards exactly {action, batch_id (route), batch_token, readings} — extra client fields dropped', function () {
    axios.post.mockResolvedValue({ data: { ok: true } });

    var req = {
      params: { id: 'SV-B-000123' },
      body: { batch_token: 't', readings: [{ degrees_plato: 12 }], extra: 1 }
    };
    return callHandler('POST', '/api/batch/public/:id/readings', req).then(function () {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload).toEqual({
        action: 'bulk_add_plato_readings',
        batch_id: 'SV-B-000123',
        batch_token: 't',
        readings: [{ degrees_plato: 12 }]
      });
    });
  });

  test('malformed batch_token is still forwarded — upstream invalid_token body passes through as HTTP 200', function () {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'invalid_token' } });

    var req = {
      params: { id: 'SV-B-000123' },
      body: { batch_token: 'nothex', readings: [] }
    };
    return callHandler('POST', '/api/batch/public/:id/readings', req).then(function (res) {
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.batch_token).toBe('nothex');
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: false, error: 'invalid_token' });
    });
  });

  test('axios rejection -> 502 {ok:false,error:"server_error"}', function () {
    axios.post.mockRejectedValue(new Error('ECONNRESET'));

    var req = {
      params: { id: 'SV-B-000123' },
      body: { batch_token: 't', readings: [] }
    };
    return callHandler('POST', '/api/batch/public/:id/readings', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });

  test('callable with a bare req carrying no headers at all (no authTiers gate)', function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var req = { params: { id: 'SV-B-000123' }, body: { batch_token: 't', readings: [] } };
    delete req.headers;
    return callHandler('POST', '/api/batch/public/:id/readings', req).then(function (res) {
      expect(res._status).not.toBe(401);
      expect(res._status).not.toBe(403);
    });
  });
});

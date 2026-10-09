'use strict';

// Phase 87-12 Task 2: public batch routes, scan-invoices dedup, reassign-customer and the
// bottling-invite stamp on the batch-store facade (DB-06, D-05, D-14).
// lib/batch-flag is real (env driven); lib/batch-store is mocked.

jest.mock('../lib/helcim', function () { return {
  isTerminalEnabled: jest.fn().mockReturnValue(false),
  terminalPurchase: jest.fn().mockResolvedValue({ ok: true }),
  pollTerminalResult: jest.fn().mockResolvedValue({ status: 'APPROVED' }),
  generateIdempotencyKey: jest.fn().mockReturnValue('k'),
  voidTransaction: jest.fn().mockResolvedValue({ ok: true })
}; });
jest.mock('../lib/zoho-api', function () { return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPut: jest.fn() }; });
jest.mock('../lib/cache', function () { return {
  get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1), isConnected: jest.fn().mockReturnValue(true)
}; });
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/logger', function () { return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }; });
jest.mock('../lib/mailer', function () { return {
  sendVoidFailureAlert: jest.fn().mockResolvedValue(),
  sendBottlingInvite: jest.fn().mockResolvedValue({ id: 'e1' })
}; });
jest.mock('../lib/inventory-ledger', function () { return { decrementStock: jest.fn().mockResolvedValue() }; });
jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });
jest.mock('../lib/brewpad-integration', function () { return {
  createBatch: jest.fn(), retryQueuedBatches: jest.fn().mockResolvedValue(),
  detectKitItems: jest.fn().mockReturnValue([{ sku: 'K', name: 'Kit' }])
}; });

var mockBatchStore = {
  getPublic: jest.fn(), publicUpdateTask: jest.fn(), publicAddReadings: jest.fn(),
  listAll: jest.fn(), update: jest.fn()
};
jest.mock('../lib/batch-store', function () { return mockBatchStore; });

var _routes = { get: [], post: [] };
jest.mock('express', function () {
  var router = {
    get: jest.fn(function (p, h) { _routes.get.push({ path: p, handler: h }); }),
    post: jest.fn(function (p, h) { _routes.post.push({ path: p, handler: h }); }),
    put: jest.fn(), delete: jest.fn()
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

var axios = require('axios');
var log = require('../lib/logger');
var zohoApi = require('../lib/zoho-api');
require('../routes/pos');

function findHandler(method, path) {
  var list = _routes[method];
  for (var i = 0; i < list.length; i++) if (list[i].path === path) return list[i].handler;
  throw new Error('no handler ' + method + ' ' + path);
}

function makeRes() {
  var res = { _status: 200, _json: null };
  res.status = jest.fn(function (c) { res._status = c; return res; });
  res.json = jest.fn(function (d) { res._json = d; return res; });
  return res;
}

function flush() { return new Promise(function (r) { setTimeout(r, 20); }); }

var FREEZE_BODY = {
  ok: false, error: 'maintenance',
  message: 'Batches are read-only for maintenance until Sat. Please try again then.'
};
var ID = 'SV-B-000123';
var TOKEN = 'a'.repeat(32);

beforeEach(function () {
  jest.clearAllMocks();
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
  delete process.env.API_SECRET_KEY;
  process.env.MW_API_KEY = 'test-api-key';
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'srv';
  axios.get.mockResolvedValue({ data: { ok: true, via: 'apps-script' } });
  axios.post.mockResolvedValue({ data: { ok: true, via: 'apps-script' } });
  mockBatchStore.getPublic.mockResolvedValue({ ok: true, data: { batch: { batch_id: ID } } });
  mockBatchStore.publicUpdateTask.mockResolvedValue({ ok: true });
  mockBatchStore.publicAddReadings.mockResolvedValue({ ok: true, added: 1 });
  mockBatchStore.listAll.mockResolvedValue([{ zoho_so_number: 'INV-1' }]);
  mockBatchStore.update.mockResolvedValue({ ok: true, data: { last_updated: 'v2' } });
});

afterEach(function () {
  delete process.env.BATCHES_STORE;
  delete process.env.BATCHES_FREEZE;
});

describe('public batch routes', function () {
  test('sheets mode: GET forwards to Apps Script unchanged', function () {
    var res = makeRes();
    findHandler('get', '/api/batch/public/:id')({ params: { id: ID }, query: { token: TOKEN } }, res);
    return flush().then(function () {
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(mockBatchStore.getPublic).not.toHaveBeenCalled();
      expect(res._json).toEqual({ ok: true, via: 'apps-script' });
    });
  });

  test('postgres: GET is served by getPublic, no axios', function () {
    process.env.BATCHES_STORE = 'postgres';
    var res = makeRes();
    findHandler('get', '/api/batch/public/:id')({ params: { id: ID }, query: { token: TOKEN } }, res);
    return flush().then(function () {
      expect(mockBatchStore.getPublic).toHaveBeenCalledWith(ID, TOKEN);
      expect(axios.get).not.toHaveBeenCalled();
      expect(res._json).toEqual({ ok: true, data: { batch: { batch_id: ID } } });
    });
  });

  test('postgres: GET still works while frozen (reads are never frozen)', function () {
    process.env.BATCHES_STORE = 'postgres';
    process.env.BATCHES_FREEZE = 'Sat';
    var res = makeRes();
    findHandler('get', '/api/batch/public/:id')({ params: { id: ID }, query: { token: TOKEN } }, res);
    return flush().then(function () {
      expect(res._status).toBe(200);
      expect(mockBatchStore.getPublic).toHaveBeenCalled();
    });
  });

  test('postgres: POST tasks uses publicUpdateTask with whitelisted fields only', function () {
    process.env.BATCHES_STORE = 'postgres';
    var res = makeRes();
    findHandler('post', '/api/batch/public/:id/tasks')({
      params: { id: ID },
      body: { batch_token: TOKEN, task_id: 'T1', updates: { completed: true }, action: 'delete_batch', batch_id: 'SV-B-999999' }
    }, res);
    return flush().then(function () {
      expect(mockBatchStore.publicUpdateTask).toHaveBeenCalledWith(ID, TOKEN,
        { task_id: 'T1', updates: { completed: true } });
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._json).toEqual({ ok: true });
    });
  });

  test('postgres: POST readings uses publicAddReadings', function () {
    process.env.BATCHES_STORE = 'postgres';
    var res = makeRes();
    var readings = [{ plato: 12.5 }];
    findHandler('post', '/api/batch/public/:id/readings')({
      params: { id: ID }, body: { batch_token: TOKEN, readings: readings }
    }, res);
    return flush().then(function () {
      expect(mockBatchStore.publicAddReadings).toHaveBeenCalledWith(ID, TOKEN, readings);
      expect(res._json).toEqual({ ok: true, added: 1 });
    });
  });

  test('postgres: store rejection -> 502 server_error', function () {
    process.env.BATCHES_STORE = 'postgres';
    mockBatchStore.publicAddReadings.mockRejectedValue(new Error('pg down'));
    var res = makeRes();
    findHandler('post', '/api/batch/public/:id/readings')({
      params: { id: ID }, body: { batch_token: TOKEN, readings: [] }
    }, res);
    return flush().then(function () {
      expect(res._status).toBe(502);
      expect(res._json).toEqual({ ok: false, error: 'server_error' });
    });
  });

  ['sheets', 'postgres'].forEach(function (mode) {
    test('freeze (' + mode + '): both public POSTs -> 503 maintenance, nothing forwarded', function () {
      if (mode === 'postgres') process.env.BATCHES_STORE = 'postgres';
      process.env.BATCHES_FREEZE = 'Sat';
      var r1 = makeRes();
      var r2 = makeRes();
      findHandler('post', '/api/batch/public/:id/tasks')({ params: { id: ID }, body: { batch_token: TOKEN, task_id: 'T', updates: {} } }, r1);
      findHandler('post', '/api/batch/public/:id/readings')({ params: { id: ID }, body: { batch_token: TOKEN, readings: [] } }, r2);
      return flush().then(function () {
        expect(r1._status).toBe(503);
        expect(r1._json).toEqual(FREEZE_BODY);
        expect(r2._status).toBe(503);
        expect(r2._json).toEqual(FREEZE_BODY);
        expect(axios.post).not.toHaveBeenCalled();
        expect(mockBatchStore.publicUpdateTask).not.toHaveBeenCalled();
        expect(mockBatchStore.publicAddReadings).not.toHaveBeenCalled();
      });
    });
  });
});

describe('scan-invoices dedup', function () {
  function run() {
    var res = makeRes();
    findHandler('get', '/api/batch/scan-invoices')({ query: {}, body: {}, headers: { 'x-api-key': 'test-api-key' } }, res);
    return flush().then(function () { return res; });
  }

  beforeEach(function () {
    zohoApi.zohoGet.mockImplementation(function (path) {
      if (path === '/invoices') {
        return Promise.resolve({ invoices: [
          { invoice_id: 'I1', invoice_number: 'INV-1', status: 'paid' },
          { invoice_id: 'I2', invoice_number: 'INV-2', status: 'paid' }
        ] });
      }
      return Promise.resolve({ invoice: { line_items: [], customer_name: 'C' } });
    });
  });

  test('sheets: dedup index comes from Apps Script get_batches', function () {
    axios.get.mockResolvedValue({ data: { ok: true, data: { batches: [{ zoho_so_number: 'INV-1' }] } } });
    return run().then(function () {
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(mockBatchStore.listAll).not.toHaveBeenCalled();
    });
  });

  test('postgres: dedup index comes from listAll, INV-1 is skipped, no axios', function () {
    process.env.BATCHES_STORE = 'postgres';
    return run().then(function () {
      expect(mockBatchStore.listAll).toHaveBeenCalledTimes(1);
      expect(axios.get).not.toHaveBeenCalled();
      var details = zohoApi.zohoGet.mock.calls.map(function (c) { return c[0]; });
      expect(details).not.toContain('/invoices/I1');
      expect(details).toContain('/invoices/I2');
    });
  });

  test('postgres: listAll rejection warns and treats the dedup set as empty', function () {
    process.env.BATCHES_STORE = 'postgres';
    mockBatchStore.listAll.mockRejectedValue(new Error('pg down'));
    return run().then(function (res) {
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('dedup failed (non-fatal)'));
      var details = zohoApi.zohoGet.mock.calls.map(function (c) { return c[0]; });
      expect(details).toContain('/invoices/I1');
      expect(res._status).toBe(200);
    });
  });
});

describe('reassign-customer', function () {
  var body = { batch_id: ID, expectedVersion: 'v1', customer: { name: 'Jane Doe', contact_id: 'C1', email: 'j@x.ca' } };

  function run(extra) {
    var res = makeRes();
    findHandler('post', '/api/batch/reassign-customer')({
      body: Object.assign({}, body, extra || {}),
      query: {}, headers: { 'x-api-key': 'test-api-key' }
    }, res);
    return flush().then(function () { return res; });
  }

  test('postgres: update via the facade with expectedVersion, response built as before', function () {
    process.env.BATCHES_STORE = 'postgres';
    return run().then(function (res) {
      expect(axios.post).not.toHaveBeenCalled();
      var args = mockBatchStore.update.mock.calls[0];
      expect(args[0].batch_id).toBe(ID);
      expect(args[0].expectedVersion).toBe('v1');
      expect(args[0].updates.customer_id).toBe('C1');
      expect(res._json).toEqual({ ok: true, batch_updated: true, new_version: 'v2' });
    });
  });

  test('postgres: version_conflict -> 409', function () {
    process.env.BATCHES_STORE = 'postgres';
    mockBatchStore.update.mockResolvedValue({ ok: false, error: 'version_conflict', message: 'stale' });
    return run().then(function (res) {
      expect(res._status).toBe(409);
      expect(res._json).toEqual({ error: 'version_conflict', message: 'stale' });
    });
  });

  test('freeze: 503 maintenance before any Zoho or store work', function () {
    process.env.BATCHES_STORE = 'postgres';
    process.env.BATCHES_FREEZE = 'Sat';
    return run().then(function (res) {
      expect(res._status).toBe(503);
      expect(res._json).toEqual(FREEZE_BODY);
      expect(mockBatchStore.update).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('sheets: still posts update_batch to Apps Script', function () {
    return run().then(function () {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('update_batch');
      expect(mockBatchStore.update).not.toHaveBeenCalled();
    });
  });
});

describe('bottling-invite stamp', function () {
  function run() {
    var res = makeRes();
    findHandler('post', '/api/batch/bottling-invite')({
      body: { email: 'j@x.ca', name: 'J', batchId: ID, productName: 'P' },
      query: {}, headers: { 'x-api-key': 'test-api-key' }
    }, res);
    return flush().then(function () { return res; });
  }

  test('postgres: stamps via batchStore.update, no axios', function () {
    process.env.BATCHES_STORE = 'postgres';
    return run().then(function (res) {
      expect(res._json.success).toBe(true);
      expect(axios.post).not.toHaveBeenCalled();
      var args = mockBatchStore.update.mock.calls[0];
      expect(args[0].batch_id).toBe(ID);
      expect(args[0].updates.bottling_invite_email).toBe('j@x.ca');
      expect(args[0].updates.bottling_invite_sent_at).toBe(res._json.sent_at);
      expect(args[0].expectedVersion).toBeUndefined();
    });
  });

  test('freeze: maintenance is logged and swallowed, the invite still succeeds', function () {
    process.env.BATCHES_STORE = 'postgres';
    process.env.BATCHES_FREEZE = 'Sat';
    mockBatchStore.update.mockResolvedValue(FREEZE_BODY);
    return run().then(function (res) {
      expect(res._json.success).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('stamp update_batch failed'));
    });
  });

  test('sheets: stamp still goes to Apps Script', function () {
    return run().then(function () {
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(mockBatchStore.update).not.toHaveBeenCalled();
    });
  });
});

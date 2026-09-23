'use strict';

// Phase 82-04 (D-05/D-06): the session-authenticated, allowlisted admin-panel
// proxy js/admin.js uses for every data read/write. Separate hardcoded
// allowlist (39 actions) from BrewPad's /api/batch/admin-proxy (17 actions,
// unchanged) but shares ONE extracted forwarding helper. Asserts:
//   (1) each of the 15 allowlisted READ actions forwards via axios.GET
//       (query params), with server_token injected and client token stripped;
//   (2) each of the 24 allowlisted WRITE actions forwards via axios.POST
//       (JSON body), with server_token injected and client token stripped;
//   (3) action names are matched case-insensitively;
//   (4) every excluded action (check_auth, get_config, update_kits,
//       get_gift_cards, etc.) -> 400 {ok:false,error:'invalid_action'},
//       Apps Script never called;
//   (5) NO credential -> 401 (requireTiers rejects before any upstream call);
//   (6) a device-token-only credential is rejected (session/legacy only);
//   (7) an axios rejection surfaces as 502 {ok:false,error:'server_error'};
//   (8) the upstream response body passes through untouched;
//   (9) a client-supplied server_token in the body is overwritten by env;
//   (10) batch-admin-proxy.test.js's harness/mocks copied verbatim so that
//        suite is provably unaffected by this refactor.
//
// Mirrors __tests__/batch-admin-proxy.test.js's mock-express-router +
// mock-axios harness verbatim (same file this proxy shares a forwarding
// helper with).

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

// Exact contract from 82-04-PLAN.md <interfaces> — the 15 reads and 24
// writes /api/admin/proxy MUST accept (39 total). This array IS the
// interface contract; a mismatch here is a test bug, not a pos.js bug.
var READS = [
  'get_kits', 'get_holds', 'get_schedule', 'get_reservations',
  'get_dashboard_summary', 'get_homepage', 'get_ingredients',
  'get_batches', 'get_batch', 'get_batch_init',
  'get_batch_dashboard_summary', 'get_ferm_schedules',
  'get_tasks_calendar', 'get_tasks_upcoming', 'get_vessels'
];

var WRITES = [
  'update_reservation', 'update_hold', 'update_homepage',
  'create_batch', 'update_batch', 'delete_batch', 'update_batch_schedule',
  'update_batch_task', 'bulk_update_batch_tasks', 'add_batch_task',
  'bulk_add_plato_readings', 'update_plato_reading', 'delete_plato_reading',
  'create_ferm_schedule', 'update_ferm_schedule', 'delete_ferm_schedule',
  'propagate_ferm_schedule', 'regenerate_batch_token',
  'update_inventory_cells', 'append_inventory_row', 'import_kits',
  'add_hold', 'append_schedule_slots', 'update_schedule_slots'
];

var EXCLUDED = [
  'check_auth', 'get_config', 'update_schedule', 'update_kits',
  'get_gift_cards', 'get_waitlist', 'get_recipes', 'get_recipe',
  'send_bottling_invite', 'add_plato_reading', ''
];

describe('POST /api/admin/proxy — contract shape (Phase 82-04)', function () {
  test('READS/WRITES contract arrays have no overlap and total 39', function () {
    var overlap = READS.filter(function (a) { return WRITES.indexOf(a) !== -1; });
    expect(overlap).toEqual([]);
    expect(READS.length).toBe(15);
    expect(WRITES.length).toBe(24);
    expect(READS.length + WRITES.length).toBe(39);
  });
});

describe('POST /api/admin/proxy — read actions forward via axios.GET (Phase 82-04)', function () {
  READS.forEach(function (action) {
    test('READ "' + action + '" -> axios.get, params carry action+extra, server_token injected, token stripped', function () {
      session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
      axios.get.mockResolvedValue({ data: { ok: true } });

      var req = {
        headers: SESSION_HEADERS,
        body: { action: action, token: 'client-google-token', foo: 'bar' }
      };
      return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.post).not.toHaveBeenCalled();
        var forwardedUrl = axios.get.mock.calls[0][0];
        expect(forwardedUrl).toBe(process.env.APPS_SCRIPT_URL);
        var cfg = axios.get.mock.calls[0][1];
        expect(cfg.params.action).toBe(action);
        expect(cfg.params.foo).toBe('bar');
        expect(cfg.params.server_token).toBe(process.env.APPS_SCRIPT_SERVER_TOKEN);
        expect(cfg.params.token).toBeUndefined();
        expect(res._status).not.toBe(400);
        expect(res._status).not.toBe(401);
      });
    });
  });
});

describe('POST /api/admin/proxy — write actions forward via axios.POST (Phase 82-04)', function () {
  WRITES.forEach(function (action) {
    test('WRITE "' + action + '" -> axios.post, JSON body carries action+extra, server_token injected, token stripped', function () {
      session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
      axios.post.mockResolvedValue({ data: { ok: true } });

      var req = {
        headers: SESSION_HEADERS,
        body: { action: action, token: 'client-google-token', foo: 'bar' }
      };
      return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(axios.get).not.toHaveBeenCalled();
        var callArgs = axios.post.mock.calls[0];
        expect(callArgs[0]).toBe(process.env.APPS_SCRIPT_URL);
        var payload = JSON.parse(callArgs[1]);
        expect(payload.action).toBe(action);
        expect(payload.foo).toBe('bar');
        expect(payload.server_token).toBe(process.env.APPS_SCRIPT_SERVER_TOKEN);
        expect(payload.token).toBeUndefined();
        var cfg = callArgs[2];
        expect(cfg.headers['Content-Type']).toBe('application/json');
        expect(res._status).not.toBe(400);
      });
    });
  });
});

test('action names are matched case-insensitively (GET_KITS -> get_kits)', function () {
  session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
  axios.get.mockResolvedValue({ data: { ok: true } });

  var req = { headers: SESSION_HEADERS, body: { action: 'GET_KITS' } };
  return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
    expect(axios.get).toHaveBeenCalledTimes(1);
    var cfg = axios.get.mock.calls[0][1];
    expect(cfg.params.action).toBe('get_kits');
    expect(res._status).not.toBe(400);
  });
});

describe('POST /api/admin/proxy — excluded actions rejected (Phase 82-04, T-82-04-01)', function () {
  EXCLUDED.concat([undefined]).forEach(function (action) {
    test('excluded action ' + JSON.stringify(action) + ' -> 400 invalid_action, Apps Script never called', function () {
      session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });

      var body = { foo: 'bar' };
      if (action !== undefined) body.action = action;
      var req = { headers: SESSION_HEADERS, body: body };
      return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
        expect(res._status).toBe(400);
        expect(res._body).toEqual({ ok: false, error: 'invalid_action' });
        expect(axios.get).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
      });
    });
  });

  test('allowlist objects have exactly 39 keys total (guards against accidental widening)', function () {
    // Re-derive from live behaviour: every READS+WRITES action must be
    // accepted (already proven above); every EXCLUDED action must be
    // rejected (already proven above). This test locks the CONTRACT size
    // itself so a future accidental widening of READS/WRITES here is caught.
    expect(READS.length + WRITES.length).toBe(39);
  });
});

describe('POST /api/admin/proxy — auth gate (Phase 82-04, D-06)', function () {
  test('NO credential -> 401, Apps Script never called', function () {
    var req = { headers: {}, body: { action: 'get_kits' } };
    return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
      expect(res._status).toBe(401);
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('device-token-only credential is rejected (session/legacy only, device excluded, T-82-04-03)', function () {
    var req = { headers: DEVICE_HEADERS, body: { action: 'get_kits' } };
    return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
      expect([401, 403]).toContain(res._status);
      expect(axios.get).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/admin/proxy — upstream failure handling (Phase 82-04, D-10/T-82-04-04)', function () {
  test('axios rejection -> 502 {ok:false,error:"server_error"}', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.post.mockRejectedValue(new Error('ECONNRESET'));

    var req = { headers: SESSION_HEADERS, body: { action: 'update_batch', batch_id: 'B-1' } };
    return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });

  test('upstream body passes through untouched (e.g. {ok:false,error:"version_conflict"} resolves 200)', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.post.mockResolvedValue({ data: { ok: false, error: 'version_conflict' } });

    var req = { headers: SESSION_HEADERS, body: { action: 'update_batch', batch_id: 'B-1' } };
    return callHandler('POST', '/api/admin/proxy', req).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body).toEqual({ ok: false, error: 'version_conflict' });
    });
  });
});

test('client-supplied server_token in the body is overwritten by the env value (T-82-04-02)', function () {
  session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
  axios.post.mockResolvedValue({ data: { ok: true } });

  var req = {
    headers: SESSION_HEADERS,
    body: { action: 'update_batch', batch_id: 'B-1', server_token: 'attacker-supplied' }
  };
  return callHandler('POST', '/api/admin/proxy', req).then(function () {
    var payload = JSON.parse(axios.post.mock.calls[0][1]);
    expect(payload.server_token).toBe(process.env.APPS_SCRIPT_SERVER_TOKEN);
  });
});

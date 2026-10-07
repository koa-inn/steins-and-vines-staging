'use strict';

// Phase 86 Plan 15 - Vessels editor API (routes/vessels.js).
// express Router captured; lib/vessel-store and lib/authTiers mocked.

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

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

// Mirrors authTiers.requireTiers semantics via the request's headers.
jest.mock('../lib/authTiers', function () {
  return {
    requireTiers: function (allowed) {
      return function (req, res, next) {
        var h = req.headers || {};
        if (!h['x-api-key'] && !h['x-device-token'] && !h['x-session-token']) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        var tier = h['x-api-key'] ? 'legacy' : (h['x-device-token'] ? 'device' : 'session');
        req.authTier = tier;
        if (allowed.indexOf(tier) === -1) return res.status(403).json({ error: 'Forbidden' });
        return next();
      };
    }
  };
});

var mockStore = {};
jest.mock('../lib/vessel-store', function () {
  return mockStore;
});

var log = require('../lib/logger');

function resetStore(mode) {
  mockStore.getMode = jest.fn().mockReturnValue(mode || 'dual');
  mockStore.list = jest.fn();
  mockStore.create = jest.fn();
  mockStore.update = jest.fn();
  mockStore.archive = jest.fn();
  mockStore.unarchive = jest.fn();
  mockStore.nextVesselNumber = jest.fn();
}

function makeRes() {
  var res = { statusCode: 200, body: undefined };
  res.status = function (c) { res.statusCode = c; return res; };
  res.json = function (b) { res.body = b; return res; };
  return res;
}

function call(key, req) {
  var res = makeRes();
  req.headers = req.headers || { 'x-session-token': 't' };
  req.params = req.params || {};
  req.query = req.query || {};
  req.body = req.body || {};
  var handler = mockRouteHandlers[key];
  if (!handler) return Promise.resolve(null);
  return Promise.resolve(handler(req, res)).then(function () {
    // allow trailing promise chains inside handlers to settle
    return new Promise(function (r) { setImmediate(r); });
  }).then(function () { return res; });
}

var STALE_MSG = 'This vessel was changed since you opened it — reload to see the latest';

beforeAll(function () {
  require('../routes/vessels');
});

beforeEach(function () {
  resetStore('dual');
  log.error.mockClear();
});

describe('auth matrix', function () {
  test('anonymous GET -> 401', async function () {
    var res = await call('GET:/api/vessels', { headers: {} });
    expect(res.statusCode).toBe(401);
    expect(mockStore.list).not.toHaveBeenCalled();
  });

  test('device token -> 403', async function () {
    var res = await call('GET:/api/vessels', { headers: { 'x-device-token': 'd' } });
    expect(res.statusCode).toBe(403);
    expect(mockStore.list).not.toHaveBeenCalled();
  });

  test('staff session -> 200 with vessels', async function () {
    mockStore.list.mockResolvedValue({ ok: true, data: { vessels: [{ vessel_id: 'PCB-001' }] } });
    var res = await call('GET:/api/vessels', {});
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, vessels: [{ vessel_id: 'PCB-001' }] });
  });

  test('every route rejects anonymous callers', async function () {
    var keys = ['GET:/api/vessels', 'GET:/api/vessels/next-id', 'POST:/api/vessels',
      'PUT:/api/vessels/:id', 'POST:/api/vessels/:id/archive', 'POST:/api/vessels/:id/unarchive'];
    for (var i = 0; i < keys.length; i++) {
      var res = await call(keys[i], { headers: {}, params: { id: 'PCB-001' } });
      expect(res.statusCode).toBe(401);
    }
  });

  test('no DELETE route', function () {
    expect(mockRouteHandlers['DELETE:/api/vessels/:id']).toBeUndefined();
    var res = Object.keys(mockRouteHandlers).filter(function (k) { return k.indexOf('DELETE:') === 0; });
    expect(res).toEqual([]);
  });
});

describe('sheets mode', function () {
  test('every route returns 503 and never touches the store', async function () {
    resetStore('sheets');
    var keys = ['GET:/api/vessels', 'GET:/api/vessels/next-id', 'POST:/api/vessels',
      'PUT:/api/vessels/:id', 'POST:/api/vessels/:id/archive', 'POST:/api/vessels/:id/unarchive'];
    for (var i = 0; i < keys.length; i++) {
      var res = await call(keys[i], { params: { id: 'PCB-001' }, query: { prefix: 'PCB' } });
      expect(res.statusCode).toBe(503);
      expect(res.body.code).toBe('vessels_editor_requires_postgres');
    }
    expect(mockStore.list).not.toHaveBeenCalled();
    expect(mockStore.create).not.toHaveBeenCalled();
    expect(mockStore.update).not.toHaveBeenCalled();
    expect(mockStore.archive).not.toHaveBeenCalled();
    expect(mockStore.unarchive).not.toHaveBeenCalled();
  });
});

describe('POST /api/vessels', function () {
  test('valid -> 201', async function () {
    mockStore.create.mockResolvedValue({ ok: true, vessel: { vessel_id: 'PCB-013' } });
    var res = await call('POST:/api/vessels', {
      body: { vessel_id: 'PCB-013', type: 'Carboy' },
      staffEmail: 'a@b.ca'
    });
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ ok: true, vessel: { vessel_id: 'PCB-013' } });
    expect(mockStore.create.mock.calls[0][1]).toEqual({ actor: 'a@b.ca' });
  });

  test('vessel_exists -> 409', async function () {
    mockStore.create.mockResolvedValue({ ok: false, error: 'vessel_exists', message: 'Vessel already exists: PCB-013' });
    var res = await call('POST:/api/vessels', { body: { vessel_id: 'PCB-013', type: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('vessel_exists');
  });

  test('invalid id pcb-1 -> 422 without calling the store', async function () {
    var res = await call('POST:/api/vessels', { body: { vessel_id: 'pcb-1', type: 'x' } });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('invalid_vessel');
    expect(mockStore.create).not.toHaveBeenCalled();
  });

  test('store business error -> 422 invalid_vessel', async function () {
    mockStore.create.mockResolvedValue({ ok: false, error: 'missing_fields', message: 'type is required' });
    var res = await call('POST:/api/vessels', { body: { vessel_id: 'PCB-013' } });
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ error: 'type is required', code: 'invalid_vessel' });
  });

  test('legacy tier -> actor middleware', async function () {
    mockStore.create.mockResolvedValue({ ok: true, vessel: {} });
    await call('POST:/api/vessels', { headers: { 'x-api-key': 'k' }, body: { vessel_id: 'PCB-013', type: 'x' } });
    expect(mockStore.create.mock.calls[0][1]).toEqual({ actor: 'middleware' });
  });

  test('store rejection -> 502 generic body, message only logged', async function () {
    mockStore.create.mockRejectedValue(new Error('secret db detail'));
    var res = await call('POST:/api/vessels', { body: { vessel_id: 'PCB-013', type: 'x' } });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Unable to save vessel', code: 'save_failed' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(log.error.mock.calls[0][0]).toContain('secret db detail');
  });
});

describe('PUT /api/vessels/:id', function () {
  test('passes actor and expectedUpdatedAt, strips the token from the payload', async function () {
    mockStore.update.mockResolvedValue({ ok: true, vessel: { vessel_id: 'PCB-001' } });
    var res = await call('PUT:/api/vessels/:id', {
      params: { id: 'PCB-001' },
      body: { label: 'x', expected_updated_at: '2026-01-01T00:00:00.000Z' },
      staffEmail: 'a@b.ca'
    });
    expect(res.statusCode).toBe(200);
    expect(mockStore.update.mock.calls[0][0]).toBe('PCB-001');
    expect(mockStore.update.mock.calls[0][1].expected_updated_at).toBeUndefined();
    expect(mockStore.update.mock.calls[0][2]).toEqual({
      actor: 'a@b.ca', expectedUpdatedAt: '2026-01-01T00:00:00.000Z'
    });
  });

  test('accepts the Empty / In-Use status override values (passed through)', async function () {
    mockStore.update.mockResolvedValue({ ok: true, vessel: {} });
    await call('PUT:/api/vessels/:id', { params: { id: 'PCB-001' }, body: { status: 'In-Use' } });
    expect(mockStore.update.mock.calls[0][1].status).toBe('In-Use');
  });

  test('stale_vessel -> 409 with D-16 message', async function () {
    mockStore.update.mockResolvedValue({ ok: false, error: 'stale_vessel', message: 'x' });
    var res = await call('PUT:/api/vessels/:id', { params: { id: 'PCB-001' }, body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: STALE_MSG, code: 'stale_vessel' });
  });

  test('vessel_id_immutable -> 422', async function () {
    mockStore.update.mockResolvedValue({ ok: false, error: 'vessel_id_immutable', message: 'A vessel id cannot be changed' });
    var res = await call('PUT:/api/vessels/:id', { params: { id: 'PCB-001' }, body: { vessel_id: 'PCB-002' } });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('vessel_id_immutable');
  });

  test('not_found -> 404', async function () {
    mockStore.update.mockResolvedValue({ ok: false, error: 'not_found', message: 'Vessel not found: PCB-099' });
    var res = await call('PUT:/api/vessels/:id', { params: { id: 'PCB-099' }, body: {} });
    expect(res.statusCode).toBe(404);
  });

  test('invalid :id -> 422 without calling the store', async function () {
    var res = await call('PUT:/api/vessels/:id', { params: { id: 'bad' }, body: {} });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('invalid_vessel');
    expect(mockStore.update).not.toHaveBeenCalled();
  });

  test('store rejection -> 502', async function () {
    mockStore.update.mockRejectedValue(new Error('boom'));
    var res = await call('PUT:/api/vessels/:id', { params: { id: 'PCB-001' }, body: {} });
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: 'Unable to save vessel', code: 'save_failed' });
  });
});

describe('archive / unarchive', function () {
  test('archive In-Use -> 409 vessel_in_use', async function () {
    mockStore.archive.mockResolvedValue({ ok: false, error: 'vessel_in_use', message: 'This vessel is in use' });
    var res = await call('POST:/api/vessels/:id/archive', { params: { id: 'PCB-001' }, body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('vessel_in_use');
  });

  test('archive stale -> 409 stale_vessel', async function () {
    mockStore.archive.mockResolvedValue({ ok: false, error: 'stale_vessel', message: 'x' });
    var res = await call('POST:/api/vessels/:id/archive', { params: { id: 'PCB-001' }, body: {} });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('stale_vessel');
  });

  test('archive passes expectedUpdatedAt and actor', async function () {
    mockStore.archive.mockResolvedValue({ ok: true, vessel: {} });
    await call('POST:/api/vessels/:id/archive', {
      params: { id: 'PCB-001' }, body: { expected_updated_at: 'T' }, staffEmail: 'a@b.ca'
    });
    expect(mockStore.archive).toHaveBeenCalledWith('PCB-001', { actor: 'a@b.ca', expectedUpdatedAt: 'T' });
  });

  test('unarchive ok -> 200', async function () {
    mockStore.unarchive.mockResolvedValue({ ok: true, vessel: { vessel_id: 'PCB-001' } });
    var res = await call('POST:/api/vessels/:id/unarchive', { params: { id: 'PCB-001' }, body: {} });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, vessel: { vessel_id: 'PCB-001' } });
  });
});

describe('GET /api/vessels/next-id', function () {
  test('PCB -> next id', async function () {
    mockStore.nextVesselNumber.mockResolvedValue('PCB-013');
    var res = await call('GET:/api/vessels/next-id', { query: { prefix: 'PCB' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, vessel_id: 'PCB-013' });
  });

  test('lowercase prefix -> 422', async function () {
    var res = await call('GET:/api/vessels/next-id', { query: { prefix: 'pcb' } });
    expect(res.statusCode).toBe(422);
    expect(mockStore.nextVesselNumber).not.toHaveBeenCalled();
  });
});

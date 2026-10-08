'use strict';

// Phase 86 security review (86-SECURITY.md, accepted-risk #5 -> fixed): vessel mutations must not
// accept a session proven only by the SameSite=None sv_session cookie. Session-tier writes need the
// x-session-token header (matching any cookie) and an allowlisted Origin when one is sent, the same
// header-token check routes/staff-access.js applies. Legacy x-api-key writes are unaffected.

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

// Mirrors real authTiers: a session is accepted from the sv_session cookie OR the header.
jest.mock('../lib/authTiers', function () {
  return {
    requireTiers: function (allowed) {
      return function (req, res, next) {
        var h = req.headers || {};
        var hasSession = !!(req.cookies && req.cookies.sv_session) || !!h['x-session-token'];
        if (!h['x-api-key'] && !h['x-device-token'] && !hasSession) {
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

jest.mock('../lib/allowed-origins', function () {
  return {
    isAllowedOrigin: function (o) { return o === 'https://steinsandvines.ca'; }
  };
});

var mockStore = {};
jest.mock('../lib/vessel-store', function () {
  return mockStore;
});

function resetStore() {
  var ok = jest.fn().mockResolvedValue({ ok: true, vessel: { vessel_id: 'PCB-050' } });
  mockStore.getMode = jest.fn().mockReturnValue('dual');
  mockStore.list = jest.fn().mockResolvedValue({ data: { vessels: [] } });
  mockStore.create = ok;
  mockStore.update = ok;
  mockStore.archive = ok;
  mockStore.unarchive = ok;
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
  req.headers = req.headers || {};
  req.cookies = req.cookies || {};
  req.params = req.params || { id: 'PCB-050' };
  req.query = req.query || {};
  req.body = req.body || { vessel_id: 'PCB-050', type: 'Carboy' };
  return Promise.resolve(mockRouteHandlers[key](req, res)).then(function () {
    return new Promise(function (r) { setImmediate(r); });
  }).then(function () { return res; });
}

var MUTATIONS = [
  'POST:/api/vessels',
  'PUT:/api/vessels/:id',
  'POST:/api/vessels/:id/archive',
  'POST:/api/vessels/:id/unarchive'
];

beforeAll(function () {
  require('../routes/vessels');
});

beforeEach(resetStore);

describe('vessel mutations: session must be proven by the x-session-token header', function () {
  MUTATIONS.forEach(function (key) {
    test(key + ' cookie-only session -> 403 header_token_required, store untouched', async function () {
      var res = await call(key, { cookies: { sv_session: 'sid-1' } });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('header_token_required');
      expect(mockStore.create).not.toHaveBeenCalled();
    });

    test(key + ' header that does not match the cookie -> 403', async function () {
      var res = await call(key, {
        cookies: { sv_session: 'sid-1' },
        headers: { 'x-session-token': 'sid-2' }
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('header_token_required');
    });

    test(key + ' disallowed Origin -> 403 origin_not_allowed', async function () {
      var res = await call(key, {
        headers: { 'x-session-token': 'sid-1', origin: 'https://evil.example' }
      });
      expect(res.statusCode).toBe(403);
      expect(res.body.code).toBe('origin_not_allowed');
    });

    test(key + ' header + matching cookie + allowed Origin -> succeeds', async function () {
      var res = await call(key, {
        cookies: { sv_session: 'sid-1' },
        headers: { 'x-session-token': 'sid-1', origin: 'https://steinsandvines.ca' }
      });
      expect([200, 201]).toContain(res.statusCode);
    });

    test(key + ' legacy x-api-key is unaffected', async function () {
      var res = await call(key, { headers: { 'x-api-key': 'k' } });
      expect([200, 201]).toContain(res.statusCode);
    });
  });

  test('GET /api/vessels (read) still works with a cookie-only session', async function () {
    var res = await call('GET:/api/vessels', { cookies: { sv_session: 'sid-1' } });
    expect(res.statusCode).toBe(200);
  });
});

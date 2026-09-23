'use strict';

// Phase 82-05 (D-13/D-14): confirms the public batch routes are reachable
// with NO staff credential and independent of Zoho auth, while every other
// guarded surface keeps its existing behaviour (guard exemption is scoped to
// exactly the '/batch/public/' prefix), and that batchPublicLimiter throttles
// per IP. Asserts:
//   (1) a keyless POST to /api/batch/public/:id/tasks with no Referer is NOT
//       403 — it reaches the route (axios mocked, so it resolves the mocked
//       upstream body);
//   (2) POST /api/admin/proxy with no credential is STILL rejected — the
//       guard exemption is scoped to '/batch/public/' only;
//   (3) an existing keyed /api/batch/* POST (sync-zoho) with no credential
//       is STILL 403;
//   (4) with zohoAuth.isAuthenticated() mocked false, GET
//       /api/batch/public/:id is NOT 401 (Zoho guard exempt) while an
//       existing route (/api/orders/recent) IS still 401;
//   (5) exceeding batchPublicLimiter's max from one IP within the window
//       trips 429 on /api/batch/public/*, without affecting other /api
//       paths' own buckets.
//
// Mirrors __tests__/auth-tiers-guard.test.js's mock roster + supertest full-
// app-require harness, with axios.get added (the public GET route calls it)
// and mockable per test.

// ---------------------------------------------------------------------------
// Mocks — must be declared before the app require. Mirrors auth-tiers-guard.test.js.
// ---------------------------------------------------------------------------
jest.mock('../lib/zohoAuth', function () {
  return { init: jest.fn().mockResolvedValue(), isAuthenticated: jest.fn().mockReturnValue(true) };
});
jest.mock('../lib/validateEnv', function () { return jest.fn(); });
jest.mock('../lib/checkRedis', function () { return jest.fn().mockResolvedValue(); });
jest.mock('../lib/checkMailer', function () { return jest.fn(); });
jest.mock('../lib/brewpad-integration', function () {
  return { syncBatch: jest.fn(), init: jest.fn(), createBatchesFromSale: jest.fn(), syncBatchToZoho: jest.fn().mockResolvedValue({ ok: true }) };
});
jest.mock('node-cron', function () { return { schedule: jest.fn() }; });
jest.mock('@sentry/node', function () {
  return { init: jest.fn(), setupExpressErrorHandler: jest.fn(), captureException: jest.fn() };
});
jest.mock('../lib/mailerlite', function () {
  return { isConfigured: jest.fn().mockReturnValue(false), addSubscriber: jest.fn().mockResolvedValue() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/inventory-ledger', function () { return { decrementStock: jest.fn().mockResolvedValue() }; });
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(false),
    init: jest.fn().mockResolvedValue(),
    getClient: jest.fn().mockResolvedValue(null)
  };
});
jest.mock('../lib/zoho-api', function () {
  return {
    zohoPost: jest.fn().mockResolvedValue({}),
    zohoGet: jest.fn().mockResolvedValue({ salesorders: [] }),
    zohoPut: jest.fn().mockResolvedValue({}),
    inventoryGet: jest.fn().mockResolvedValue({}),
    inventoryPut: jest.fn().mockResolvedValue({}),
    ZOHO_INVENTORY_BASE: 'https://inventory.zoho.com/api/v1'
  };
});
jest.mock('axios', function () {
  return {
    post: jest.fn().mockResolvedValue({ data: { ok: true } }),
    get: jest.fn().mockResolvedValue({ data: { ok: true } })
  };
});

// lib/session — mock-mirrors-real-contract (unused by the public routes, but
// required so requiring the full app doesn't dial a real Redis client via
// other routes' session lookups).
jest.mock('../lib/session', function () {
  return {
    createSession: jest.fn().mockResolvedValue('mock-sid'),
    getSession: jest.fn().mockResolvedValue(null),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn().mockResolvedValue(null)
  };
});

// lib/deviceToken — mock-mirrors-real-contract, same as auth-tiers-guard.test.js.
jest.mock('../lib/deviceToken', function () {
  return {
    getKey: function () { return process.env.KIOSK_DEVICE_TOKEN || ''; },
    matches: function (sent) {
      var key = process.env.KIOSK_DEVICE_TOKEN || '';
      return !!key && typeof sent === 'string' && sent === key;
    }
  };
});

// Set env before requiring the app so the guard captures credentials.
process.env.API_SECRET_KEY = 'integration-secret';
process.env.MW_API_KEY = 'integration-secret';
process.env.KIOSK_DEVICE_TOKEN = 'integration-device-token';
process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';

var request = require('supertest');
var app = require('../server');
var zohoAuth = require('../lib/zohoAuth');
var axios = require('axios');

afterEach(function () {
  zohoAuth.isAuthenticated.mockReturnValue(true);
});

describe('Public batch routes — reachable without a staff credential (Phase 82-05, D-13/D-14)', function () {
  test('(1) keyless POST /api/batch/public/:id/tasks with no Referer/credential — NOT 403', function () {
    return request(app)
      .post('/api/batch/public/SV-B-000001/tasks')
      .send({ batch_token: 't', task_id: 'BT-000001', updates: { completed: true } })
      .then(function (res) {
        expect(res.status).not.toBe(403);
      });
  });

  test('(2) POST /api/admin/proxy with no credential — STILL rejected (exemption scoped to /batch/public/ only)', function () {
    return request(app)
      .post('/api/admin/proxy')
      .send({ action: 'get_kits' })
      .then(function (res) {
        expect([401, 403]).toContain(res.status);
      });
  });

  test('(3) an existing keyed /api/batch/* POST (sync-zoho) with no credential — STILL 403', function () {
    return request(app)
      .post('/api/batch/sync-zoho')
      .send({ so_id: 'SO-1', batch_id: 'SV-B-000001', status: 'active' })
      .then(function (res) {
        expect(res.status).toBe(403);
      });
  });

  test('(4a) Zoho unauthenticated: GET /api/batch/public/:id — NOT 401 (Zoho guard exempt)', function () {
    zohoAuth.isAuthenticated.mockReturnValue(false);
    return request(app)
      .get('/api/batch/public/SV-B-000001')
      .query({ token: new Array(33).join('a') })
      .then(function (res) {
        expect(res.status).not.toBe(401);
      });
  });

  test('(4b) Zoho unauthenticated: an existing route (/api/orders/recent) — STILL 401', function () {
    zohoAuth.isAuthenticated.mockReturnValue(false);
    return request(app)
      .get('/api/orders/recent')
      .set('x-api-key', 'integration-secret')
      .then(function (res) {
        expect(res.status).toBe(401);
      });
  });
});

describe('batchPublicLimiter — per-IP throttle on /api/batch/public/* (Phase 82-05, D-14)', function () {
  test('(5) exceeding the limiter max from one IP trips 429 on /api/batch/public/*; another /api path is unaffected', async function () {
    var ip = '10.9.0.1';
    var res;
    for (var i = 0; i < 30; i++) {
      res = await request(app)
        .get('/api/batch/public/SV-B-000001')
        .query({ token: new Array(33).join('a') })
        .set('X-Forwarded-For', ip);
      expect(res.status).not.toBe(429);
    }
    var blocked = await request(app)
      .get('/api/batch/public/SV-B-000001')
      .query({ token: new Array(33).join('a') })
      .set('X-Forwarded-For', ip);
    expect(blocked.status).toBe(429);

    // A different /api path from the SAME IP is unaffected by the
    // batch-public bucket — it has its own apiLimiter counter.
    var other = await request(app)
      .get('/api/orders/recent')
      .set('X-Forwarded-For', ip)
      .set('x-api-key', 'integration-secret');
    expect(other.status).not.toBe(429);
  });
});

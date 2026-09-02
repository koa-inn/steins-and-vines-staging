'use strict';

// -----------------------------------------------------------------------------
// Phase 78-02: POST /api/waitlist — D-03/D-06/D-07 endpoint contract.
//
// D-03: the Waitlist sheet row is authoritative and blocking; a MailerLite
// outage/misconfiguration must NOT turn a customer away (still 200), and the
// endpoint must fail closed (503) only when the sheet write itself fails.
// D-06: a first-time signup and a dedupe-hit signup get an IDENTICAL response
// — the endpoint must never disclose whether an address was already listed.
// D-07: on MailerLite success a best-effort update_waitlist_status write sets
// mailerlite_synced true, so drift is a persisted cell, not a log line.
//
// Server-boot mock harness mirrors __tests__/api-key-guard.test.js /
// __tests__/checkout-captured-amount.test.js (server.js pulls in every route
// file at require time, so their dependencies must be mocked for a clean boot).
// -----------------------------------------------------------------------------

jest.mock('../lib/zohoAuth', function () {
  return { init: jest.fn().mockResolvedValue(), isAuthenticated: jest.fn().mockReturnValue(true) };
});
jest.mock('../lib/validateEnv', function () { return jest.fn(); });
jest.mock('../lib/checkRedis', function () { return jest.fn().mockResolvedValue(); });
jest.mock('../lib/checkMailer', function () { return jest.fn(); });
jest.mock('../lib/brewpad-integration', function () {
  return { syncBatch: jest.fn(), init: jest.fn(), createBatchesFromSale: jest.fn() };
});
jest.mock('node-cron', function () { return { schedule: jest.fn() }; });
jest.mock('@sentry/node', function () {
  return { init: jest.fn(), setupExpressErrorHandler: jest.fn(), captureException: jest.fn() };
});
jest.mock('../lib/mailerlite', function () {
  return { isConfigured: jest.fn().mockReturnValue(true), addSubscriber: jest.fn().mockResolvedValue({}) };
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
  return { post: jest.fn(), get: jest.fn() };
});

process.env.APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';

var request = require('supertest');
var app = require('../server');

// server.js calls dotenv.config() on require, which may repopulate
// RESEND_API_KEY from a local (gitignored) .env. Neutralize it AFTER the
// require so lib/mailer's real sendWaitlistNotification (unmocked — it is
// fire-and-forget and its own outcome is asserted nowhere in this file)
// deterministically rejects without attempting a real network call.
process.env.RESEND_API_KEY = '';

var axios = require('axios');
var mailerlite = require('../lib/mailerlite');

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Default Apps Script mock: add_waitlist_entry succeeds with a fresh id;
// update_waitlist_status (the D-07 sync-flag write) succeeds too.
function mockAppsScript(overrides) {
  overrides = overrides || {};
  axios.post.mockImplementation(function (url, body) {
    var parsed = JSON.parse(body);
    if (parsed.action === 'add_waitlist_entry') {
      return overrides.addWaitlistEntry
        ? overrides.addWaitlistEntry(parsed)
        : Promise.resolve({ data: { ok: true, id: 'u-1' } });
    }
    if (parsed.action === 'update_waitlist_status') {
      return overrides.updateWaitlistStatus
        ? overrides.updateWaitlistStatus(parsed)
        : Promise.resolve({ data: { ok: true, id: parsed.id, status: 'waiting' } });
    }
    return Promise.resolve({ data: { ok: true } });
  });
}

function postCallsFor(action) {
  return axios.post.mock.calls.filter(function (c) {
    try { return JSON.parse(c[1]).action === action; } catch (e) { return false; }
  });
}

beforeEach(function () {
  jest.clearAllMocks();
  mailerlite.isConfigured.mockReturnValue(true);
  mailerlite.addSubscriber.mockResolvedValue({});
  mockAppsScript();
});

describe('POST /api/waitlist — D-03 sheet-authoritative, MailerLite best-effort', function () {

  test('T1: happy path — sheet write succeeds, MailerLite succeeds -> 200 {success:true}', function () {
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup@example.com' })
      .then(function (res) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        var calls = postCallsFor('add_waitlist_entry');
        expect(calls.length).toBe(1);
        var body = JSON.parse(calls[0][1]);
        expect(body.action).toBe('add_waitlist_entry');
        expect(body.email).toBe('signup@example.com');
        expect(body.category).toBe('beer');
      });
  });

  test('T2: D-03 core — MailerLite unconfigured still returns 200, addSubscriber never called', function () {
    mailerlite.isConfigured.mockReturnValue(false);
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup2@example.com' })
      .then(function (res) {
        expect(res.status).not.toBe(503);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(mailerlite.addSubscriber).not.toHaveBeenCalled();
      });
  });

  test('T3: MailerLite addSubscriber rejects — still 200, no mailerlite_synced write', function () {
    mailerlite.addSubscriber.mockRejectedValue(new Error('MailerLite down'));
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup3@example.com' })
      .then(function (res) {
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        return flushPromises();
      })
      .then(function () {
        var syncCalls = postCallsFor('update_waitlist_status').filter(function (c) {
          return JSON.parse(c[1]).mailerlite_synced === true;
        });
        expect(syncCalls.length).toBe(0);
      });
  });

  test('T4: fail-closed — sheet write resolves {ok:false} -> 503, MailerLite never called', function () {
    mockAppsScript({
      addWaitlistEntry: function () { return Promise.resolve({ data: { ok: false, error: 'waitlist_unavailable' } }); }
    });
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup4@example.com' })
      .then(function (res) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'Waitlist is temporarily unavailable' });
        expect(mailerlite.addSubscriber).not.toHaveBeenCalled();
      });
  });

  test('T5: fail-closed on transport — axios.post rejects -> 503, exactly one add_waitlist_entry call (no retry)', function () {
    mockAppsScript({
      addWaitlistEntry: function () { return Promise.reject(new Error('ECONNRESET')); }
    });
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup5@example.com' })
      .then(function (res) {
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: 'Waitlist is temporarily unavailable' });
        expect(postCallsFor('add_waitlist_entry').length).toBe(1);
      });
  });

  test('T6: D-07 — MailerLite success fires a best-effort update_waitlist_status with mailerlite_synced:true', function () {
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup6@example.com' })
      .then(function (res) {
        expect(res.status).toBe(200);
        return flushPromises();
      })
      .then(function () {
        var syncCalls = postCallsFor('update_waitlist_status');
        expect(syncCalls.length).toBe(1);
        var body = JSON.parse(syncCalls[0][1]);
        expect(body.id).toBe('u-1');
        expect(body.mailerlite_synced).toBe(true);
      });
  });

  test('T7: invalid email -> 400, Apps Script never called', function () {
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'not-an-email' })
      .then(function (res) {
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Valid email is required' });
        expect(axios.post).not.toHaveBeenCalled();
      });
  });

  test('T8: client-supplied category is ignored — server always hardcodes "beer"', function () {
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'signup8@example.com', category: 'wine' })
      .then(function (res) {
        expect(res.status).toBe(200);
        var calls = postCallsFor('add_waitlist_entry');
        var body = JSON.parse(calls[0][1]);
        expect(body.category).toBe('beer');
      });
  });

  test('T9: D-06 non-disclosure — a fresh-row response and a dedupe-hit response are byte-identical', function () {
    mockAppsScript({
      addWaitlistEntry: function () { return Promise.resolve({ data: { ok: true, id: 'dupe-1' } }); }
    });
    return request(app)
      .post('/api/waitlist')
      .send({ email: 'repeat@example.com' })
      .then(function (firstRes) {
        return request(app)
          .post('/api/waitlist')
          .send({ email: 'repeat@example.com' })
          .then(function (secondRes) {
            expect(secondRes.status).toBe(firstRes.status);
            expect(secondRes.body).toEqual(firstRes.body);
          });
      });
  });
});

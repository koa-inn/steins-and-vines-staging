'use strict';

// -----------------------------------------------------------------------------
// Phase 80-02: POST /api/waitlist/:id/contact and
// POST /api/waitlist/:id/mailerlite-sync — the server-orchestrated send-then-
// write sequencing (D-04-D-09) and the MailerLite fire-and-forget leg (D-24).
//
// Mirrors waitlist-admin-proxy.test.js's mock-express-router + mock-axios
// harness (same file under test, routes/pos.js).
// -----------------------------------------------------------------------------

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

jest.mock('../lib/mailer', function () {
  return {
    sendBottlingInvite: jest.fn().mockResolvedValue(),
    sendWaitlistContact: jest.fn().mockResolvedValue()
  };
});
jest.mock('../lib/mailerlite', function () {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    addSubscriber: jest.fn().mockResolvedValue({})
  };
});
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
var mailer = require('../lib/mailer');
var mailerlite = require('../lib/mailerlite');

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
      headersSent: false,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json:   jest.fn(function (b) { res._body = b; res.headersSent = true; resolve(res); return res; })
    };
    try {
      var maybe = handler(req || {}, res);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(reject);
    } catch (e) { reject(e); }
  });
}

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

var OLD_API_SECRET_KEY, OLD_MW_API_KEY, OLD_DEVICE_TOKEN, OLD_MLGROUP, OLD_MLKEY;

beforeEach(function () {
  OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
  OLD_MW_API_KEY = process.env.MW_API_KEY;
  OLD_DEVICE_TOKEN = process.env.KIOSK_DEVICE_TOKEN;
  OLD_MLGROUP = process.env.MAILERLITE_WAITLIST_GROUP_ID;
  OLD_MLKEY = process.env.MAILERLITE_API_KEY;
  delete process.env.API_SECRET_KEY;
  delete process.env.MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = 'test-device-token';
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-server-token';
  delete process.env.MAILERLITE_WAITLIST_GROUP_ID;
  session.getSession.mockReset();
  session.getSession.mockResolvedValue(null);
  axios.post.mockReset();
  axios.get.mockReset();
  mailer.sendWaitlistContact.mockReset();
  mailer.sendWaitlistContact.mockResolvedValue();
  mailerlite.isConfigured.mockReset();
  mailerlite.isConfigured.mockReturnValue(true);
  mailerlite.addSubscriber.mockReset();
  mailerlite.addSubscriber.mockResolvedValue({});
});

afterEach(function () {
  process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  process.env.MW_API_KEY = OLD_MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = OLD_DEVICE_TOKEN;
  process.env.MAILERLITE_WAITLIST_GROUP_ID = OLD_MLGROUP;
  process.env.MAILERLITE_API_KEY = OLD_MLKEY;
});

var SESSION_HEADERS = { 'x-session-token': 'valid-sid' };
var DEVICE_HEADERS = { 'x-device-token': 'test-device-token' };

var VALID_CONTACT_BODY = {
  to: 'jane@example.com',
  subject: 'Your spot is ready',
  body: 'Hi Jane, book here.',
  bookingUrl: 'https://cal.com/steins-and-vines-tw8csc/ferment-kit'
};

describe('POST /api/waitlist/:id/contact (Phase 80-02, D-04-D-09)', function () {
  test('no credential -> 401, calls neither mailer nor axios', function () {
    var req = { headers: {}, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(res._status).toBe(401);
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('device tier -> 401, staff-only (device explicitly excluded)', function () {
    var req = { headers: DEVICE_HEADERS, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect([401, 403]).toContain(res._status);
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('session tier, valid body: sends first, THEN writes status — call order asserted', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    var callOrder = [];
    mailer.sendWaitlistContact.mockImplementation(function () {
      callOrder.push('send');
      return Promise.resolve();
    });
    axios.post.mockImplementation(function () {
      callOrder.push('write');
      return Promise.resolve({ data: { ok: true } });
    });

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(mailer.sendWaitlistContact).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['send', 'write']);

      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.action).toBe('update_waitlist_status');
      expect(payload.status).toBe('contacted');
      expect(payload.id).toBe('w-1');
      expect(typeof payload.contacted_at).toBe('string');
      expect(isNaN(Date.parse(payload.contacted_at))).toBe(false);

      expect(res._status).not.toBe(400);
      expect(res._body.ok).toBe(true);
    });
  });

  test('sendWaitlistContact REJECTS: axios.post never called, 502 contact_failed, no status write', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    mailer.sendWaitlistContact.mockRejectedValue(new Error('Resend down'));

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'contact_failed' });
    });
  });

  test('send resolves but Apps Script write rejects: 502 contact_write_failed', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    mailer.sendWaitlistContact.mockResolvedValue();
    axios.post.mockRejectedValue(new Error('network error'));

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body.ok).toBe(false);
      expect(res._body.error).toBe('contact_write_failed');
    });
  });

  test('Apps Script answers ok:false invalid_transition: 502, distinguished from a send failure', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    mailer.sendWaitlistContact.mockResolvedValue();
    axios.post.mockResolvedValue({ data: { ok: false, error: 'invalid_transition' } });

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: VALID_CONTACT_BODY };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body.ok).toBe(false);
      expect(res._body.error).toBe('contact_write_failed');
      expect(res._body.upstream).toBe('invalid_transition');
    });
  });

  test('missing to/subject/body/bookingUrl -> 400 before any send', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { to: 'jane@example.com' } };
    return callHandler('POST', '/api/waitlist/:id/contact', req).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ ok: false, error: 'invalid_request' });
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/waitlist/:id/mailerlite-sync (Phase 80-02, D-24)', function () {
  test('no credential -> 401', function () {
    var req = { headers: {}, params: { id: 'w-1' }, body: { email: 'jane@example.com' } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._status).toBe(401);
      expect(mailerlite.addSubscriber).not.toHaveBeenCalled();
    });
  });

  test('session tier: calls addSubscriber once, on resolve writes mailerlite_synced true', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.post.mockResolvedValue({ data: { ok: true } });

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { email: 'jane@example.com' } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._status).not.toBe(401);
      expect(res._body).toEqual({ ok: true });
      expect(mailerlite.addSubscriber).toHaveBeenCalledTimes(1);
      return flushPromises();
    }).then(function () {
      expect(axios.post).toHaveBeenCalledTimes(1);
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.action).toBe('update_waitlist_status');
      expect(payload.mailerlite_synced).toBe(true);
      expect(payload.id).toBe('w-1');
    });
  });

  test('addSubscriber rejects: still returns 200 {ok:true}, never writes the sync flag', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    mailerlite.addSubscriber.mockRejectedValue(new Error('MailerLite down'));

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { email: 'jane@example.com' } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._body).toEqual({ ok: true });
      return flushPromises();
    }).then(function () {
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  // WR-03 regression. email was passed straight to mailerlite.addSubscriber with no
  // format check. Because the route is fire-and-forget and always answers {ok:true}
  // (D-24), every malformed-input failure was silent to caller and operator alike --
  // an empty email produced a MailerLite API error that was caught, logged and
  // discarded, indistinguishable from success at the HTTP layer. D-24's
  // fire-and-forget contract covers the MailerLite OUTCOME, not malformed input.
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['no @', 'not-an-email'],
    ['no domain dot', 'jane@example'],
    ['spaces inside', 'ja ne@example.com']
  ])('WR-03: %s email -> 400 invalid_request, addSubscriber never called', function (_label, badEmail) {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { email: badEmail } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body).toEqual({ ok: false, error: 'invalid_request' });
      expect(mailerlite.addSubscriber).not.toHaveBeenCalled();
      return flushPromises();
    }).then(function () {
      // Critically: no mailerlite_synced flag stamped onto the row either.
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  test('WR-03: a valid email is trimmed before being handed to MailerLite', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    axios.post.mockResolvedValue({ data: { ok: true } });

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { email: '  jane@example.com  ' } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._body).toEqual({ ok: true });
      expect(mailerlite.addSubscriber).toHaveBeenCalledTimes(1);
      expect(mailerlite.addSubscriber.mock.calls[0][0]).toBe('jane@example.com');
    });
  });

  test('MAILERLITE_API_KEY unset (isConfigured false): 200 {ok:true}, neither addSubscriber nor axios called', function () {
    session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
    mailerlite.isConfigured.mockReturnValue(false);

    var req = { headers: SESSION_HEADERS, params: { id: 'w-1' }, body: { email: 'jane@example.com' } };
    return callHandler('POST', '/api/waitlist/:id/mailerlite-sync', req).then(function (res) {
      expect(res._body).toEqual({ ok: true });
      expect(mailerlite.addSubscriber).not.toHaveBeenCalled();
      return flushPromises();
    }).then(function () {
      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});

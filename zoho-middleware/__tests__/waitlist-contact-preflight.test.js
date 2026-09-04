'use strict';

// -----------------------------------------------------------------------------
// CR-03 regression: POST /api/waitlist/:id/contact must read the waitlist row
// BEFORE it sends anything.
//
// Before this fix the route's only pre-send check was field presence. It never
// fetched the row, so at send time it did not know whether the row existed,
// what its email was, or whether it could legally advance to 'contacted'. The
// recipient was taken verbatim from req.body.to, and the dedicated
// invalid_transition branch could only be reached AFTER the email had already
// gone out.
//
// D-08 ordering is preserved and re-asserted here: the eligibility read is a
// new PRE-send gate, it does not reorder send-then-write.
//
// Harness mirrors waitlist-staff-routes.test.js (same file under test,
// routes/pos.js) — kept in a separate file so that suite's existing
// expectations stay untouched.
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

var OLD_API_SECRET_KEY, OLD_MW_API_KEY, OLD_DEVICE_TOKEN;

// Returns the {ok:true, data:[...]} envelope doGet's get_waitlist case produces.
function waitlistResponse(rows) {
  return { data: { ok: true, data: rows } };
}

function row(overrides) {
  var base = {
    id: 'w-1',
    email: 'jane@example.com',
    category: 'beer',
    status: 'waiting',
    signed_up_at: '2026-09-01T00:00:00.000Z',
    customer_name: 'Jane Doe'
  };
  if (overrides) {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) base[k] = overrides[k];
    }
  }
  return base;
}

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
  session.getSession.mockResolvedValue({ email: 'staff@steinsandvines.ca' });
  axios.post.mockReset();
  axios.post.mockResolvedValue({ data: { ok: true } });
  axios.get.mockReset();
  axios.get.mockResolvedValue(waitlistResponse([row()]));
  mailer.sendWaitlistContact.mockReset();
  mailer.sendWaitlistContact.mockResolvedValue();
});

afterEach(function () {
  process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  process.env.MW_API_KEY = OLD_MW_API_KEY;
  process.env.KIOSK_DEVICE_TOKEN = OLD_DEVICE_TOKEN;
});

var SESSION_HEADERS = { 'x-session-token': 'valid-sid' };

var VALID_CONTACT_BODY = {
  to: 'jane@example.com',
  subject: 'Your spot is ready',
  body: 'Hi Jane, book here.',
  bookingUrl: 'https://cal.com/steins-and-vines-tw8csc/ferment-kit'
};

function contactReq(id, bodyOverrides) {
  var body = {};
  for (var k in VALID_CONTACT_BODY) {
    if (Object.prototype.hasOwnProperty.call(VALID_CONTACT_BODY, k)) body[k] = VALID_CONTACT_BODY[k];
  }
  if (bodyOverrides) {
    for (var j in bodyOverrides) {
      if (Object.prototype.hasOwnProperty.call(bodyOverrides, j)) body[j] = bodyOverrides[j];
    }
  }
  return { headers: SESSION_HEADERS, params: { id: id }, body: body };
}

describe('POST /api/waitlist/:id/contact — CR-03 pre-send eligibility gate', function () {
  test('a booked row is refused with 409 invalid_transition and NOTHING is sent', function () {
    axios.get.mockResolvedValue(waitlistResponse([row({ status: 'booked' })]));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._status).toBe(409);
      expect(res._body).toEqual({ ok: false, error: 'invalid_transition' });
    });
  });

  test('a removed row is refused with 409 and NOTHING is sent (the two-staff race)', function () {
    // Staff A removed the customer; Staff B's stale tab still shows Contact enabled.
    axios.get.mockResolvedValue(waitlistResponse([row({ status: 'removed' })]));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._status).toBe(409);
      expect(res._body).toEqual({ ok: false, error: 'invalid_transition' });
    });
  });

  test('an unknown id is refused with 404 and NOTHING is sent', function () {
    axios.get.mockResolvedValue(waitlistResponse([row({ id: 'w-other' })]));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._status).toBe(404);
      expect(res._body).toEqual({ ok: false, error: 'not_found' });
    });
  });

  test('the recipient is the ROW email, never the client-supplied `to`', function () {
    axios.get.mockResolvedValue(waitlistResponse([row({ email: 'real-customer@example.com' })]));

    return callHandler(
      'POST', '/api/waitlist/:id/contact', contactReq('w-1', { to: 'attacker@evil.example' })
    ).then(function () {
      expect(mailer.sendWaitlistContact).toHaveBeenCalledTimes(1);
      var arg = mailer.sendWaitlistContact.mock.calls[0][0];
      expect(arg.to).toBe('real-customer@example.com');
      expect(arg.to).not.toBe('attacker@evil.example');
    });
  });

  test('a row with no usable email is refused with 409 and NOTHING is sent', function () {
    axios.get.mockResolvedValue(waitlistResponse([row({ email: '' })]));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(res._status).toBe(409);
    });
  });

  test('the eligibility read happens BEFORE the send, and the send still precedes the write (D-08)', function () {
    var order = [];
    axios.get.mockImplementation(function () {
      order.push('read');
      return Promise.resolve(waitlistResponse([row()]));
    });
    mailer.sendWaitlistContact.mockImplementation(function () {
      order.push('send');
      return Promise.resolve();
    });
    axios.post.mockImplementation(function () {
      order.push('write');
      return Promise.resolve({ data: { ok: true } });
    });

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(order).toEqual(['read', 'send', 'write']);
      expect(res._body.ok).toBe(true);
    });
  });

  test('a waiting row still sends and advances — the gate does not block the happy path', function () {
    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1);
      var payload = JSON.parse(axios.post.mock.calls[0][1]);
      expect(payload.action).toBe('update_waitlist_status');
      expect(payload.status).toBe('contacted');
      expect(res._body.ok).toBe(true);
    });
  });

  test('a contacted row may be re-contacted (contacted -> contacted is an allowed transition)', function () {
    axios.get.mockResolvedValue(waitlistResponse([row({ status: 'contacted' })]));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).toHaveBeenCalledTimes(1);
      expect(res._body.ok).toBe(true);
    });
  });

  test('when the eligibility read itself fails the route fails CLOSED — no send', function () {
    axios.get.mockRejectedValue(new Error('Apps Script unreachable'));

    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function (res) {
      expect(mailer.sendWaitlistContact).not.toHaveBeenCalled();
      expect(axios.post).not.toHaveBeenCalled();
      expect(res._status).toBe(502);
      expect(res._body.ok).toBe(false);
    });
  });

  test('the eligibility read uses get_waitlist with the server token, not a client token', function () {
    return callHandler('POST', '/api/waitlist/:id/contact', contactReq('w-1')).then(function () {
      expect(axios.get).toHaveBeenCalledTimes(1);
      var cfg = axios.get.mock.calls[0][1];
      expect(cfg.params.action).toBe('get_waitlist');
      expect(cfg.params.server_token).toBe('test-server-token');
    });
  });
});

'use strict';

// ---------------------------------------------------------------------------
// Mocks — must be declared before require()
// ---------------------------------------------------------------------------
jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn().mockResolvedValue(1)
  };
});

jest.mock('../lib/logger', function () {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
});

var express = require('express');
var cache = require('../lib/cache');
var log = require('../lib/logger');

// Load the route (registers handler via router.post)
require('../routes/webhooks');

// Grab the registered handler: router.post('/webhooks/zoho-inventory', handler)
var router = express.Router();
var handler = router.post.mock.calls[0][1];

// The handler fires Promise.all().then() without returning the promise.
// We need to flush all pending microtasks after calling the handler.
function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
var VALID_SECRET = 'test-secret-abc';
var CACHE_KEYS = [
  'zoho:products',
  'zoho:products:ts',
  'zoho:ingredients',
  'zoho:ingredients:ts',
  'zoho:kiosk-products',
  'zoho:services'
];

function makeReq(opts) {
  opts = opts || {};
  return {
    headers: opts.headers || {},
    body: opts.body || {},
    ip: opts.ip || '127.0.0.1'
  };
}

function makeRes() {
  var res = {
    _status: 200,
    _body: null,
    status: function (code) { res._status = code; return res; },
    json: function (body) { res._body = body; return res; }
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /webhooks/zoho-inventory', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    cache.del.mockResolvedValue(1);
    process.env.ZOHO_WEBHOOK_SECRET = VALID_SECRET;
  });

  afterEach(function () {
    delete process.env.ZOHO_WEBHOOK_SECRET;
  });

  // -------------------------------------------------------------------------
  // 503 — secret not configured server-side
  // -------------------------------------------------------------------------
  test('returns 503 when ZOHO_WEBHOOK_SECRET env var is not set', async function () {
    delete process.env.ZOHO_WEBHOOK_SECRET;
    var req = makeReq({ headers: { 'x-webhook-secret': 'anything' } });
    var res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(503);
    expect(res._body).toEqual({ error: 'Webhook not configured' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ZOHO_WEBHOOK_SECRET not set'));
    expect(cache.del).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 401 — wrong secret
  // -------------------------------------------------------------------------
  test('returns 401 when x-webhook-secret header is wrong', async function () {
    var req = makeReq({ headers: { 'x-webhook-secret': 'wrong-secret' } });
    var res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid webhook secret'));
    expect(cache.del).not.toHaveBeenCalled();
  });

  test('returns 401 when x-webhook-secret header is missing', async function () {
    var req = makeReq({ headers: {} });
    var res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: 'Unauthorized' });
    expect(cache.del).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 200 — valid secret, cache bust succeeds
  // -------------------------------------------------------------------------
  test('returns 200 and busts all 6 cache keys on valid request', async function () {
    var req = makeReq({
      headers: { 'x-webhook-secret': VALID_SECRET },
      body: { event_type: 'item_updated', data: { item: { name: 'Merlot Kit' } } }
    });
    var res = makeRes();

    handler(req, res);
    await flush();

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, event: 'item_updated' });
    expect(cache.del).toHaveBeenCalledTimes(CACHE_KEYS.length);
    CACHE_KEYS.forEach(function (key) {
      expect(cache.del).toHaveBeenCalledWith(key);
    });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Cache busted'));
  });

  test('includes event type and item name in log on valid request', async function () {
    var req = makeReq({
      headers: { 'x-webhook-secret': VALID_SECRET },
      body: { event_type: 'stock_updated', data: { item: { name: 'Cabernet Sauvignon' } } }
    });
    var res = makeRes();

    handler(req, res);
    await flush();

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('stock_updated')
    );
  });

  test('uses "unknown" as event type when body has no event_type', async function () {
    var req = makeReq({
      headers: { 'x-webhook-secret': VALID_SECRET },
      body: {}
    });
    var res = makeRes();

    handler(req, res);
    await flush();

    expect(res._body).toEqual({ ok: true, event: 'unknown' });
  });

  test('succeeds even when body is absent', async function () {
    var req = { headers: { 'x-webhook-secret': VALID_SECRET }, ip: '127.0.0.1' };
    var res = makeRes();

    handler(req, res);
    await flush();

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, event: 'unknown' });
  });

  // -------------------------------------------------------------------------
  // Individual cache.del failures are swallowed (warning logged, 200 returned)
  // -------------------------------------------------------------------------
  test('logs warning but still returns 200 when a cache.del call rejects', async function () {
    cache.del.mockRejectedValue(new Error('Redis down'));
    var req = makeReq({
      headers: { 'x-webhook-secret': VALID_SECRET },
      body: { event_type: 'item_deleted' }
    });
    var res = makeRes();

    handler(req, res);
    await flush();

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ ok: true, event: 'item_deleted' });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to delete cache key'));
  });

  // -------------------------------------------------------------------------
  // Timing-safe comparison — different-length secret must be rejected
  // -------------------------------------------------------------------------
  test('rejects a secret that is a prefix of the real secret', async function () {
    var req = makeReq({
      headers: { 'x-webhook-secret': VALID_SECRET.slice(0, -1) }
    });
    var res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(401);
  });

  test('rejects an empty string secret even when env secret is set', async function () {
    var req = makeReq({ headers: { 'x-webhook-secret': '' } });
    var res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(401);
  });
});

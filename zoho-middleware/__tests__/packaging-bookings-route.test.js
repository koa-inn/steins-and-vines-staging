'use strict';

jest.mock('../lib/logger', function () { return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; });
jest.mock('../lib/batch-store', function () { return { dashCards: jest.fn(), packagingCandidates: jest.fn() }; });
jest.mock('../lib/cache', function () { return { get: jest.fn(), set: jest.fn() }; });
jest.mock('../lib/calcom', function () { return { listBookings: jest.fn() }; });

var log = require('../lib/logger');
var batchStore = require('../lib/batch-store');
var cache = require('../lib/cache');
var calcom = require('../lib/calcom');

var _routes = [];

jest.mock('express', function () {
  var router = {
    get: jest.fn(function (path, handler) { _routes.push({ path: path, handler: handler }); })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});

require('../routes/brewpad-dashboard');

var handler = _routes.filter(function (r) { return r.path === '/api/admin/packaging-bookings'; })[0].handler;

function makeRes() {
  var res = { _status: 200, _json: null, _done: null };
  res._p = new Promise(function (resolve) { res._done = resolve; });
  res.status = jest.fn(function (c) { res._status = c; res._done(); return res; });
  res.json = jest.fn(function (d) { res._json = d; res._done(); return res; });
  res.set = jest.fn(function () { return res; });
  return res;
}

function staffReq() { return { body: {}, query: {}, headers: { 'x-api-key': 'test-key' } }; }

function soon(hours) { return new Date(Date.now() + hours * 3600000).toISOString(); }

function fixture() {
  return {
    bookings: [{
      id: 1, uid: 'u1', start: soon(30), end: soon(31), status: 'accepted',
      eventType: { id: 5904690, slug: 'bottling' },
      attendees: [{ name: 'Ann', email: 'ann@x.com', timeZone: 'America/Vancouver' }]
    }],
    truncated: false
  };
}

beforeEach(function () {
  jest.clearAllMocks();
  process.env.MW_API_KEY = 'test-key';
  process.env.KIOSK_DEVICE_TOKEN = 'test-device-token';
  process.env.CALCOM_API_KEY = 'cal-key';
  process.env.CALCOM_EVENT_TYPE_BOTTLING = '5904690';
  process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING = '6028745';
  cache.get.mockResolvedValue(null);
  cache.set.mockResolvedValue();
  calcom.listBookings.mockResolvedValue(fixture());
  batchStore.packagingCandidates.mockResolvedValue([
    { batch_id: 'SV-B-000001', customer_email: 'ANN@x.com', bottling_invite_email: '', packaging_due: null }
  ]);
});

afterEach(function () {
  delete process.env.MW_API_KEY;
  delete process.env.KIOSK_DEVICE_TOKEN;
  delete process.env.CALCOM_API_KEY;
  delete process.env.CALCOM_EVENT_TYPE_BOTTLING;
  delete process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING;
});

describe('GET /api/admin/packaging-bookings', function () {
  it('returns matched bookings and caches with TTL 300', async function () {
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(calcom.listBookings).toHaveBeenCalledTimes(1);
    var args = calcom.listBookings.mock.calls[0][0];
    expect(args.eventTypeIds).toEqual([5904690, 6028745]);
    expect(args.afterStart).toMatch(/T00:00:00\.000Z$/);
    expect(args.beforeEnd).toMatch(/T00:00:00\.000Z$/);
    expect(res._json.ok).toBe(true);
    expect(res._json.truncated).toBe(false);
    expect(res._json.window.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res._json.bookings).toHaveLength(1);
    expect(res._json.bookings[0].batch_id).toBe('SV-B-000001');
    expect(res._json.bookings[0].kind).toBe('bottling');
    expect(JSON.stringify(res._json)).not.toContain('@');
    expect(cache.set).toHaveBeenCalledWith(expect.any(String), res._json, 300);
  });

  it('serves a cache hit without calling Cal.com', async function () {
    var cached = { ok: true, window: { start: 'a', end: 'b' }, truncated: false, bookings: [] };
    cache.get.mockResolvedValue(cached);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json).toEqual(cached);
    expect(calcom.listBookings).not.toHaveBeenCalled();
  });

  it('queries only the configured event type', async function () {
    delete process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING;
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(calcom.listBookings.mock.calls[0][0].eventTypeIds).toEqual([5904690]);
  });

  it('reports not_configured without calling Cal.com or caching', async function () {
    delete process.env.CALCOM_EVENT_TYPE_BOTTLING;
    delete process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING;
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json).toEqual({ ok: false, reason: 'not_configured' });

    delete process.env.CALCOM_API_KEY;
    process.env.CALCOM_EVENT_TYPE_BOTTLING = '5904690';
    var res2 = makeRes();
    handler(staffReq(), res2);
    await res2._p;
    expect(res2._json).toEqual({ ok: false, reason: 'not_configured' });
    expect(calcom.listBookings).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('soft-fails when Cal.com rejects, without caching or logging PII', async function () {
    var err = new Error('boom ann@x.com');
    err.response = { status: 503 };
    calcom.listBookings.mockRejectedValue(err);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json).toEqual({ ok: false, reason: 'unavailable' });
    expect(cache.set).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    log.warn.mock.calls.forEach(function (c) { expect(String(c[0])).not.toContain('@'); });
  });

  // WR-01: an unmatched list would make every task read "not booked yet", so a failed candidate
  // query soft-fails like a Cal.com failure instead of answering ok:true.
  it('soft-fails without caching when candidates fail', async function () {
    batchStore.packagingCandidates.mockRejectedValue(new Error('db down'));
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json).toEqual({ ok: false, reason: 'unavailable' });
    expect(cache.set).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('rejects the device tier', async function () {
    var req = { body: {}, query: {}, headers: { authorization: 'Bearer test-device-token' } };
    var res = makeRes();
    handler(req, res);
    await res._p;
    expect(res._status).toBeGreaterThanOrEqual(400);
    expect(calcom.listBookings).not.toHaveBeenCalled();
  });
});

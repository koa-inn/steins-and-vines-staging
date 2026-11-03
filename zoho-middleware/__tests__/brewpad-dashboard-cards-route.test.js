'use strict';

jest.mock('../lib/logger', function () { return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; });
jest.mock('../lib/batch-store', function () { return { dashCards: jest.fn() }; });

var log = require('../lib/logger');
var batchStore = require('../lib/batch-store');
var kioskBundles = require('../lib/kiosk-bundles');

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

var handler = _routes.filter(function (r) { return r.path === '/api/admin/dashboard-cards'; })[0].handler;

function makeRes() {
  var res = { _status: 200, _json: null, _done: null };
  res._p = new Promise(function (resolve) { res._done = resolve; });
  res.status = jest.fn(function (c) { res._status = c; return res; });
  res.json = jest.fn(function (d) { res._json = d; res._done(); return res; });
  res.set = jest.fn(function () { return res; });
  return res;
}

function staffReq() { return { body: {}, query: {}, headers: { 'x-api-key': 'test-key' } }; }

beforeEach(function () {
  jest.clearAllMocks();
  process.env.MW_API_KEY = 'test-key';
  process.env.KIOSK_DEVICE_TOKEN = 'test-device-token';
});

afterEach(function () {
  delete process.env.MW_API_KEY;
  delete process.env.KIOSK_DEVICE_TOKEN;
});

describe('GET /api/admin/dashboard-cards', function () {
  it('returns cards and canning constants for staff', async function () {
    var rows = [{ batch_id: 'SV-B-000001', abv: 4.8, ibu: 20, batch_size_l: 28, juice: 'Apple', yeast: 'M02' }];
    batchStore.dashCards.mockResolvedValue(rows);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json.ok).toBe(true);
    expect(res._json.cards).toEqual(rows);
    expect(res._json.canning.packaged_litres).toBe(25);
    expect(res._json.canning.brew_litres).toBe(28);
    expect(res._json.canning.nominal).toEqual({ 473: 52, 355: 70 });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('shares the kiosk bundle nominal rather than retyping it', async function () {
    batchStore.dashCards.mockResolvedValue([]);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json.canning.nominal).toEqual(kioskBundles.BUNDLES['beer-25'].nominal);
  });

  it('rejects a device-token request without calling the store', async function () {
    var res = makeRes();
    handler({ body: {}, query: {}, headers: { 'x-device-token': 'test-device-token' } }, res);
    await res._p;
    expect(res._status).toBe(403);
    expect(batchStore.dashCards).not.toHaveBeenCalled();
  });

  it('returns empty cards when the store is not postgres', async function () {
    batchStore.dashCards.mockResolvedValue(null);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._json.ok).toBe(true);
    expect(res._json.cards).toEqual([]);
    expect(res._json.canning.packaged_litres).toBe(25);
  });

  it('returns 500 cards_unavailable on a read failure without leaking row data', async function () {
    batchStore.dashCards.mockRejectedValue(new Error('boom'));
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    expect(res._status).toBe(500);
    expect(res._json).toEqual({ ok: false, error: 'cards_unavailable' });
    expect(log.warn).toHaveBeenCalledWith('[brewpad-dashboard] cards read failed: boom');
  });

  it('never returns an email-looking string or recipe_snapshot from raw rows via the pure parser', async function () {
    var read = require('../lib/batch-pg-read');
    var snap = JSON.stringify({ abv: 5, customer_email: 'a@b.example', notes: 'x@y.example', ingredients: [{ item_name: 'Juice', cf_type: 'Juice' }] });
    var facts = Object.assign({ batch_id: 'SV-B-000001' }, read.parseCardFacts(snap));
    batchStore.dashCards.mockResolvedValue([facts]);
    var res = makeRes();
    handler(staffReq(), res);
    await res._p;
    var json = JSON.stringify(res._json);
    expect(json).not.toContain('@');
    expect(json).not.toContain('recipe_snapshot');
  });
});

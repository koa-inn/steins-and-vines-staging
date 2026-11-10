'use strict';

// Phase 101 D-16/D-18: the legacy recipe initiate route is retired (410) and
// the legacy confirm stays alive but instrumented for the soak.

var mockRouteHandlers = {};

jest.mock('express', function () {
  var router = {
    get:    jest.fn(function (p, h) { mockRouteHandlers['GET:' + p] = h; }),
    post:   jest.fn(function (p, h) { mockRouteHandlers['POST:' + p] = h; }),
    put:    jest.fn(function (p, h) { mockRouteHandlers['PUT:' + p] = h; }),
    delete: jest.fn(function (p, h) { mockRouteHandlers['DELETE:' + p] = h; })
  };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });
jest.mock('../routes/catalog', function () {
  return { rebuildKioskCatalog: jest.fn().mockResolvedValue([]) };
});
jest.mock('../lib/helcim', function () {
  return {
    getCardTransactionById: jest.fn().mockResolvedValue(null),
    isTerminalEnabled: jest.fn().mockReturnValue(true),
    terminalPurchase: jest.fn().mockResolvedValue({}),
    voidTransaction: jest.fn().mockResolvedValue({})
  };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn().mockResolvedValue({}), zohoPut: jest.fn() };
});
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue()
  };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/mailer', function () {
  return { sendVoidFailureAlert: jest.fn().mockResolvedValue() };
});
jest.mock('../lib/brewpad-integration', function () {
  return { detectRecipeSale: jest.fn(), createBatchesFromSale: jest.fn() };
});

function load() {
  mockRouteHandlers = {};
  jest.resetModules();
  require('../routes/pos-recipe');
  return {
    cache: require('../lib/cache'),
    helcim: require('../lib/helcim'),
    eventLog: require('../lib/eventLog'),
    axios: require('axios')
  };
}

function mockRes() {
  var res = { statusCode: 200, body: null };
  res.status = function (c) { res.statusCode = c; return res; };
  res.json = function (b) { res.body = b; return res; };
  return res;
}

describe('legacy POST /api/kiosk/recipe-sale (retired)', function () {
  var saved;
  beforeEach(function () { saved = process.env.BEER_SALES_ENABLED; });
  afterEach(function () {
    if (saved === undefined) { delete process.env.BEER_SALES_ENABLED; } else { process.env.BEER_SALES_ENABLED = saved; }
  });

  ['true', 'false'].forEach(function (flag) {
    it('returns 410 with no lock, Helcim or pricing call (BEER_SALES_ENABLED=' + flag + ')', function () {
      process.env.BEER_SALES_ENABLED = flag;
      var m = load();
      var res = mockRes();
      mockRouteHandlers['POST:/api/kiosk/recipe-sale'](
        { body: { recipe_id: 'RCP-001', sale_type: 'in-store', idempotency_key: 'k1', reference_number: 'R1' } }, res);
      expect(res.statusCode).toBe(410);
      expect(res.body).toEqual({ error: 'This kiosk is out of date. Refresh the page and try again.' });
      expect(m.cache.acquireLock).not.toHaveBeenCalled();
      expect(m.cache.set).not.toHaveBeenCalled();
      expect(m.helcim.terminalPurchase).not.toHaveBeenCalled();
      expect(m.axios.get).not.toHaveBeenCalled();
      expect(m.axios.post).not.toHaveBeenCalled();
    });
  });

  it('returns 410 for an empty body', function () {
    process.env.BEER_SALES_ENABLED = 'true';
    load();
    var res = mockRes();
    mockRouteHandlers['POST:/api/kiosk/recipe-sale']({ body: {} }, res);
    expect(res.statusCode).toBe(410);
  });
});

describe('legacy POST /api/kiosk/recipe-sale/confirm', function () {
  var saved;
  beforeEach(function () { saved = process.env.BEER_SALES_ENABLED; process.env.BEER_SALES_ENABLED = 'true'; });
  afterEach(function () {
    if (saved === undefined) { delete process.env.BEER_SALES_ENABLED; } else { process.env.BEER_SALES_ENABLED = saved; }
  });

  it('logs kiosk.recipe_sale_legacy_confirm once with reference + boolean only', function () {
    var m = load();
    var res = mockRes();
    mockRouteHandlers['POST:/api/kiosk/recipe-sale/confirm'](
      { body: { recipe_id: 'RCP-001', transaction_id: 12345, reference: 'REF-1', customer_email: 'a@b.c' } }, res);
    var calls = m.eventLog.logEvent.mock.calls.filter(function (c) { return c[0] === 'kiosk.recipe_sale_legacy_confirm'; });
    expect(calls.length).toBe(1);
    expect(calls[0][1]).toEqual({ reference_number: 'REF-1', has_transaction_id: true });
  });
});

describe('GET /api/kiosk/recipe-quote', function () {
  it('is still gated by BEER_SALES_ENABLED', function () {
    var saved = process.env.BEER_SALES_ENABLED;
    process.env.BEER_SALES_ENABLED = 'false';
    load();
    var res = mockRes();
    mockRouteHandlers['GET:/api/kiosk/recipe-quote']({ query: { recipe_id: 'x' } }, res);
    expect(res.statusCode).toBe(403);
    if (saved === undefined) { delete process.env.BEER_SALES_ENABLED; } else { process.env.BEER_SALES_ENABLED = saved; }
  });
});

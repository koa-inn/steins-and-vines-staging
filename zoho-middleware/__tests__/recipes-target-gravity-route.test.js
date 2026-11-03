'use strict';

// Phase 97 D-06: target_og / target_fg validation at the recipe write API.

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

jest.mock('../lib/cache', function () {
  return { get: jest.fn(), set: jest.fn(), del: jest.fn() };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

jest.mock('../lib/constants', function () {
  return {
    CACHE_KEYS: {
      RECIPES: 'sv:recipes',
      RECIPES_TS: 'sv:recipes:ts',
      INGREDIENTS: 'zoho:ingredients',
      INGREDIENTS_ALL: 'zoho:ingredients:all',
      RECIPE_AVAILABILITY: 'sv:recipe-availability',
      FERM_SCHEDULES: 'sv:ferm-schedules'
    }
  };
});

jest.mock('../lib/recipe-store', function () {
  return {
    create: jest.fn(function () { return Promise.resolve({ ok: true, recipe_id: 'SV-R-000099' }); }),
    update: jest.fn(function () { return Promise.resolve({ ok: true }); }),
    getMode: jest.fn(function () { return 'sheets'; })
  };
});

function load() {
  mockRouteHandlers = {};
  jest.resetModules();
  require('../routes/recipes');
  return {
    store: require('../lib/recipe-store'),
    cache: require('../lib/cache')
  };
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var handler = mockRouteHandlers[method + ':' + path];
    if (!handler) return reject(new Error('No handler for ' + method + ':' + path));
    var res = {
      _status: 200,
      _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json: jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    try { handler(req, res); } catch (e) { reject(e); }
  });
}

describe('target gravity route validation (D-06)', function () {
  var mocks;

  beforeEach(function () {
    process.env.API_SECRET_KEY = 'test-target-gravity-key';
    mocks = load();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
  });

  test('POST passes numeric target_og and target_fg to the store', function () {
    return callHandler('POST', '/api/recipes', { body: { name: 'X', target_og: 12, target_fg: 3 } }).then(function (res) {
      expect(res._status).toBe(201);
      var p = mocks.store.create.mock.calls[0][0];
      expect(p.target_og).toBe(12);
      expect(p.target_fg).toBe(3);
    });
  });

  test('POST rewrites a numeric string to a number', function () {
    return callHandler('POST', '/api/recipes', { body: { name: 'X', target_og: '12.5' } }).then(function () {
      expect(mocks.store.create.mock.calls[0][0].target_og).toBe(12.5);
    });
  });

  test('POST rejects target_og 1 with 400 invalid_target_gravity', function () {
    return callHandler('POST', '/api/recipes', { body: { name: 'X', target_og: 1 } }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.code).toBe('invalid_target_gravity');
      expect(mocks.store.create).not.toHaveBeenCalled();
    });
  });

  test('POST rejects target_fg at or above target_og', function () {
    return callHandler('POST', '/api/recipes', { body: { name: 'X', target_og: 10, target_fg: 11 } }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.code).toBe('invalid_target_gravity');
      expect(mocks.store.create).not.toHaveBeenCalled();
    });
  });

  test("PUT forwards '' to clear a value", function () {
    return callHandler('PUT', '/api/recipes/:id', { params: { id: 'SV-R-000011' }, body: { target_fg: '' } }).then(function () {
      expect(mocks.store.update).toHaveBeenCalled();
      expect(mocks.store.update.mock.calls[0][0].target_fg).toBe('');
    });
  });

  test('PUT rejects target_fg 50', function () {
    return callHandler('PUT', '/api/recipes/:id', { params: { id: 'SV-R-000011' }, body: { target_fg: 50 } }).then(function (res) {
      expect(res._status).toBe(400);
      expect(res._body.code).toBe('invalid_target_gravity');
      expect(mocks.store.update).not.toHaveBeenCalled();
    });
  });

  test('public recipe response never carries target gravity', function () {
    var recipe = {
      recipe_id: 'SV-R-TG-1', name: 'Pils', style: 'Lager', description: 'd', ferment_days: 14,
      status: 'active', pricing_mode: 'locked', locked_price: 10, service_fee: 5, materials_fee: 2,
      target_og: 12, target_fg: 3, ingredients: []
    };
    mocks.cache.get.mockResolvedValue({ recipes: [recipe], total: 1 });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: {} }).then(function (res) {
      var r = res._body.recipes[0];
      expect(r).not.toHaveProperty('target_og');
      expect(r).not.toHaveProperty('target_fg');
    });
  });
});

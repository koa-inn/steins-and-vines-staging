'use strict';

// ---------------------------------------------------------------------------
// Phase 85 Plan 07 - store-mode dispatch for routes/recipes.js.
// sheets mode: real facade, mocked axios (parity with recipes.test.js).
// dual/postgres: lib/recipe-store mocked entirely.
// ---------------------------------------------------------------------------

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

var STALE_BODY = {
  error: 'This recipe was changed since you opened it — reload to see the latest',
  code: 'stale_recipe'
};

function mockStore(mode, overrides) {
  var store = Object.assign({
    getMode: jest.fn().mockReturnValue(mode),
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn()
  }, overrides || {});
  jest.doMock('../lib/recipe-store', function () { return store; });
  return store;
}

function load(opts) {
  opts = opts || {};
  mockRouteHandlers = {};
  jest.resetModules();
  jest.doMock('../lib/authTiers', function () {
    return {
      resolveTier: jest.fn().mockResolvedValue(opts.staff ? 'session' : 'anonymous'),
      allowKiosk: jest.fn().mockReturnValue(!!opts.staff),
      requireTiers: function () { return function (req, res, next) { return next(); }; }
    };
  });
  var out = {
    axios: require('axios'),
    cache: require('../lib/cache')
  };
  require('../routes/recipes');
  return out;
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
    var p = handler(Object.assign({ query: {}, params: {}, body: {}, headers: {} }, req || {}), res);
    if (p && p.catch) p.catch(reject);
  });
}

describe('recipes routes - read endpoints by store mode (85-07 task 1)', function () {
  beforeEach(function () {
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
    delete process.env.RECIPES_STORE;
  });

  afterEach(function () {
    delete process.env.APPS_SCRIPT_URL;
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    jest.dontMock('../lib/recipe-store');
  });

  describe('sheets mode (real facade)', function () {
    it('list reads cache first, calls Apps Script get_recipes, then caches', function () {
      var m = load({ staff: true });
      m.cache.get.mockResolvedValue(null);
      m.axios.post.mockResolvedValue({ data: { ok: true, data: { recipes: [{ recipe_id: 'R1', status: 'active' }], total: 1 } } });
      return callHandler('GET', '/api/recipes').then(function (res) {
        expect(m.cache.get).toHaveBeenCalledWith('sv:recipes:all:0:0');
        var body = JSON.parse(m.axios.post.mock.calls[0][1]);
        expect(body.action).toBe('get_recipes');
        expect(m.cache.set).toHaveBeenCalledWith('sv:recipes:all:0:0', expect.any(Object), 600);
        expect(res._body.source).toBe('apps-script');
      });
    });

    it('detail uses Apps Script get_recipe and caches', function () {
      var m = load({ staff: true });
      m.cache.get.mockResolvedValue(null);
      m.axios.post.mockResolvedValue({ data: { ok: true, data: { recipe: { recipe_id: 'R1' }, ingredients: [] } } });
      return callHandler('GET', '/api/recipes/:id', { params: { id: 'R1' } }).then(function (res) {
        expect(JSON.parse(m.axios.post.mock.calls[0][1]).action).toBe('get_recipe');
        expect(m.cache.set).toHaveBeenCalledWith('sv:recipes:R1', expect.any(Object), 600);
        expect(res._body.recipe.recipe_id).toBe('R1');
      });
    });
  });

  ['dual', 'postgres'].forEach(function (mode) {
    describe(mode + ' mode (mocked store)', function () {
      function recipesCacheCalls(fn) {
        return fn.mock.calls.filter(function (c) { return String(c[0]).indexOf('sv:recipes') === 0; });
      }

      it('staff list returns source postgres and never touches sv:recipes cache', function () {
        mockStore(mode, {
          list: jest.fn().mockResolvedValue({ ok: true, data: { recipes: [{ recipe_id: 'R1', status: 'draft' }], total: 7 } })
        });
        var m = load({ staff: true });
        m.cache.get.mockResolvedValue(null);
        return callHandler('GET', '/api/recipes').then(function (res) {
          expect(res._body).toEqual({ source: 'postgres', recipes: [{ recipe_id: 'R1', status: 'draft' }], total: 7 });
          expect(recipesCacheCalls(m.cache.get)).toHaveLength(0);
          expect(recipesCacheCalls(m.cache.set)).toHaveLength(0);
        });
      });

      it('anonymous list is active-only, projected, with ferment_days from schedule', function () {
        var store = mockStore(mode, {
          list: jest.fn().mockResolvedValue({ ok: true, data: { recipes: [
            { recipe_id: 'R1', name: 'IPA', status: 'active', schedule_id: 'S1', locked_price: 50, secret: 'x', pricing_mode: 'locked' },
            { recipe_id: 'R2', name: 'Draft', status: 'draft' }
          ], total: 2 } })
        });
        var m = load({ staff: false });
        m.cache.get.mockResolvedValue(null);
        m.axios.get.mockResolvedValue({ data: { ok: true, data: { schedules: [
          { schedule_id: 'S1', steps_parsed: [{ day_offset: 14 }, { day_offset: 20, is_packaging: true }] }
        ] } } });
        return callHandler('GET', '/api/recipes', { query: { status: 'all' } }).then(function (res) {
          expect(store.list).toHaveBeenCalledWith({ status: 'active', limit: 0, offset: 0 });
          expect(res._body.total).toBe(1);
          expect(res._body.recipes).toHaveLength(1);
          expect(res._body.recipes[0].ferment_days).toBe(14);
          expect(res._body.recipes[0].secret).toBeUndefined();
          expect(res._body.recipes[0].price).toBe(50);
        });
      });

      it('anonymous detail of a draft is 404, of an active recipe is projected without ingredients', function () {
        var store = mockStore(mode);
        var m = load({ staff: false });
        m.cache.get.mockResolvedValue(null);
        store.get.mockResolvedValueOnce({ ok: true, data: { recipe: { recipe_id: 'R2', status: 'draft' }, ingredients: [] } });
        return callHandler('GET', '/api/recipes/:id', { params: { id: 'R2' } }).then(function (res) {
          expect(res._status).toBe(404);
          expect(res._body).toEqual({ error: 'Recipe not found' });
          store.get.mockResolvedValueOnce({ ok: true, data: { recipe: { recipe_id: 'R1', name: 'IPA', status: 'active', cost: 9 }, ingredients: [{ item_id: 'i' }] } });
          return callHandler('GET', '/api/recipes/:id', { params: { id: 'R1' } });
        }).then(function (res) {
          expect(res._body.recipe.name).toBe('IPA');
          expect(res._body.recipe.cost).toBeUndefined();
          expect(res._body.ingredients).toBeUndefined();
          expect(recipesCacheCalls(m.cache.get)).toHaveLength(0);
          expect(recipesCacheCalls(m.cache.set)).toHaveLength(0);
        });
      });

      it('staff detail of a missing recipe is 404', function () {
        mockStore(mode, { get: jest.fn().mockResolvedValue({ ok: false, error: 'not_found', message: 'Recipe not found' }) });
        load({ staff: true }).cache.get.mockResolvedValue(null);
        return callHandler('GET', '/api/recipes/:id', { params: { id: 'NOPE' } }).then(function (res) {
          expect(res._status).toBe(404);
          expect(res._body).toEqual({ error: 'Recipe not found' });
        });
      });

      it('dynamic price in list obtains ingredients via recipeStore.get without detail cache', function () {
        var store = mockStore(mode, {
          list: jest.fn().mockResolvedValue({ ok: true, data: { recipes: [{ recipe_id: 'R1', status: 'active', pricing_mode: 'dynamic', service_fee: 0, materials_fee: 0 }], total: 1 } }),
          get: jest.fn().mockResolvedValue({ ok: true, data: { recipe: { recipe_id: 'R1' }, ingredients: [{ item_id: 'I1', quantity: 2, unit: 'kg' }] } })
        });
        var m = load({ staff: true });
        m.cache.get.mockImplementation(function (key) {
          if (key === 'zoho:ingredients:all') return Promise.resolve([{ item_id: 'I1', rate: 5, unit: 'kg' }]);
          return Promise.resolve(null);
        });
        return callHandler('GET', '/api/recipes').then(function (res) {
          expect(store.get).toHaveBeenCalledWith('R1');
          expect(m.axios.post).not.toHaveBeenCalled();
          expect(res._body.recipes[0].computed_price).toBe(10);
          expect(recipesCacheCalls(m.cache.get)).toHaveLength(0);
          expect(recipesCacheCalls(m.cache.set)).toHaveLength(0);
        });
      });

      it('availability reads ingredients via recipeStore.get and caches availability', function () {
        var store = mockStore(mode, {
          get: jest.fn().mockResolvedValue({ ok: true, data: { recipe: { recipe_id: 'R1' }, ingredients: [{ item_id: 'I1', quantity: 2, unit: 'kg' }] } })
        });
        var m = load({ staff: true });
        m.cache.get.mockImplementation(function (key) {
          if (key === 'zoho:ingredients:all') return Promise.resolve([{ item_id: 'I1', unit: 'kg', stock_on_hand: 10 }]);
          return Promise.resolve(null);
        });
        return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'R1' } }).then(function (res) {
          expect(store.get).toHaveBeenCalledWith('R1');
          expect(res._body.summary).toBe('all_ok');
          expect(m.cache.set).toHaveBeenCalledWith('sv:recipe-availability:R1', expect.any(Object), 600);
        });
      });

      it('store rejection maps to 502 with today\'s messages', function () {
        mockStore(mode, {
          list: jest.fn().mockRejectedValue(new Error('db down')),
          get: jest.fn().mockRejectedValue(new Error('db down'))
        });
        load({ staff: true }).cache.get.mockResolvedValue(null);
        return callHandler('GET', '/api/recipes').then(function (res) {
          expect(res._status).toBe(502);
          expect(res._body).toEqual({ error: 'Unable to fetch recipes' });
          return callHandler('GET', '/api/recipes/:id', { params: { id: 'R1' } });
        }).then(function (res) {
          expect(res._status).toBe(502);
          expect(res._body).toEqual({ error: 'Unable to fetch recipe' });
        });
      });
    });
  });
});

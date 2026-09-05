'use strict';

// ---------------------------------------------------------------------------
// Express mock — captures route handlers keyed by method:path
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAndLoadRecipes() {
  mockRouteHandlers = {};
  jest.resetModules();
  var recipesRoute = require('../routes/recipes');
  return {
    axios: require('axios'),
    cache: require('../lib/cache'),
    recipes: recipesRoute
  };
}

function callHandler(method, path, req) {
  return new Promise(function (resolve, reject) {
    var key = method + ':' + path;
    var handler = mockRouteHandlers[key];
    if (!handler) return reject(new Error('No handler registered for ' + key));
    var res = {
      _status: 200,
      _body: null,
      status: jest.fn(function (s) { res._status = s; return res; }),
      json:   jest.fn(function (b) { res._body = b; resolve(res); return res; })
    };
    try { handler(req || {}, res); } catch (e) { reject(e); }
  });
}

// ---------------------------------------------------------------------------
// Tests
//
// 74-01: GET /api/recipes and GET /api/recipes/:id gained a tier-aware
// status guard + public field allowlist (D-05/D-06/D-07) — a caller with no
// credential is now treated as anonymous/public. The tests below exercise
// the pre-existing staff/full-detail path (drafts, computed_price,
// ingredients), so each of their requests now carries an x-api-key
// credential (TEST_API_KEY, set/restored per describe block below) to keep
// exercising that same staff path. Zero assertions changed — the new public
// (anonymous) contract has its own dedicated coverage in
// recipes-public-guard.test.js.
// ---------------------------------------------------------------------------

var TEST_API_KEY = 'test-api-key';

describe('GET /api/recipes', function () {
  var mocks;
  var OLD_API_SECRET_KEY;
  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  test('returns cached data on cache hit', function () {
    var cached = { recipes: [{ recipe_id: 'SV-R-000001', name: 'Pale Ale' }], total: 1 };
    mocks.cache.get.mockResolvedValue(cached);
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._body.source).toBe('cache');
      expect(res._body.recipes).toEqual(cached.recipes);
      expect(res._body.total).toBe(1);
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('fetches from Apps Script on cache miss and caches result', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [{ recipe_id: 'SV-R-000001' }], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._body.source).toBe('apps-script');
      expect(res._body.recipes).toHaveLength(1);
      expect(mocks.cache.set).toHaveBeenCalled();
    });
  });

  test('returns 502 on Apps Script error', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockRejectedValue(new Error('timeout'));
    return callHandler('GET', '/api/recipes', { query: {}, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(502);
      expect(res._body.error).toBe('Unable to fetch recipes');
    });
  });
});

describe('GET /api/recipes/:id', function () {
  var mocks;
  var OLD_API_SECRET_KEY;
  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  test('returns cached recipe detail on hit', function () {
    var cached = { recipe: { recipe_id: 'SV-R-000001', name: 'Pale Ale' }, ingredients: [] };
    mocks.cache.get.mockResolvedValue(cached);
    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._body.recipe.recipe_id).toBe('SV-R-000001');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('fetches and caches on miss', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipe: { recipe_id: 'SV-R-000001' }, ingredients: [{ item_id: '123' }] } }
    });
    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._body.recipe.recipe_id).toBe('SV-R-000001');
      expect(res._body.ingredients).toHaveLength(1);
      expect(mocks.cache.set).toHaveBeenCalled();
    });
  });

  test('returns 404 when Apps Script returns ok:false', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: false, message: 'Recipe not found' }
    });
    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-999999' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(404);
      expect(res._body.error).toBe('Recipe not found');
    });
  });
});

// M8 (Phase 52-05): this route now requires a credential tier (previously
// unauth — the DoS vector this plan closes). Mirrors the D-09 precedent
// (commit 313b91a) — existing success-path requests gain an x-api-key
// header (no assertion changed); a new 401-without-key test is added.
describe('GET /api/recipes/:id/availability', function () {
  var mocks;
  var OLD_API_SECRET_KEY;

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = 'test-api-key';
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  // M8 auth guard (Phase 52-05)
  test('returns 401 without x-api-key header, Apps Script never called', function () {
    mocks.cache.get.mockResolvedValue(null);
    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-000001' }, headers: {} }).then(function (res) {
      expect(res._status).toBe(401);
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('returns per-ingredient status with stock data from ingredients cache', function () {
    // Apps Script returns recipe with ingredients
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-000001' },
          ingredients: [
            { item_id: '100', item_name: 'Pale Malt', unit: 'kg', quantity: 4.5 },
            { item_id: '200', item_name: 'Cascade Hops', unit: 'g', quantity: 50 }
          ]
        }
      }
    });
    // Ingredients cache has stock data (source reads INGREDIENTS_ALL for full catalog)
    // 73-06 (WR-01): fixtures now carry `unit` — production catalog entries
    // always include it; same-unit comparison is unchanged.
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([
          { item_id: '100', stock_on_hand: 45, unit: 'kg' },
          { item_id: '200', stock_on_hand: 100, unit: 'g' }
        ]);
      }
      if (key === 'zoho:ingredients') {
        return Promise.resolve([
          { item_id: '100', stock_on_hand: 45, unit: 'kg' },
          { item_id: '200', stock_on_hand: 100, unit: 'g' }
        ]);
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      expect(res._body.recipe_id).toBe('SV-R-000001');
      expect(res._body.summary).toBe('some_low');
      expect(res._body.ingredients).toHaveLength(2);
      // Pale Malt: 45/4.5 = 10 batches -> ok
      expect(res._body.ingredients[0].batches_possible).toBe(10);
      expect(res._body.ingredients[0].status).toBe('ok');
      // Cascade Hops: 100/50 = 2 batches -> low (< 3)
      expect(res._body.ingredients[1].batches_possible).toBe(2);
      expect(res._body.ingredients[1].status).toBe('low');
    });
  });

  test('returns status unknown when ingredients cache is cold', function () {
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-000001' },
          ingredients: [
            { item_id: '100', item_name: 'Pale Malt', unit: 'kg', quantity: 4.5 }
          ]
        }
      }
    });
    // Ingredients cache is cold (null)
    mocks.cache.get.mockResolvedValue(null);

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      expect(res._body.summary).toBe('unknown');
      expect(res._body.ingredients[0].status).toBe('unknown');
      expect(res._body.ingredients[0].stock_on_hand).toBeNull();
      expect(res._body.ingredients[0].batches_possible).toBeNull();
    });
  });

  // Regression: SCALE-05 — internal-only ingredient (absent from purchasable INGREDIENTS
  // catalog, present only in INGREDIENTS_ALL) must report real stock so availability
  // is not falsely degraded to cannot_brew.
  test('SCALE-05 regression: internal-only ingredient (only in INGREDIENTS_ALL) reports real stock and all_ok', function () {
    var INTERNAL_ITEM_ID = '109900000000028635'; // Gypsum (Bulk) — internal-only
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-GYPSUM' },
          ingredients: [
            { item_id: INTERNAL_ITEM_ID, item_name: 'Gypsum (Calcium Sulfate) (Bulk)', unit: 'kg', quantity: 1 }
          ]
        }
      }
    });
    // INGREDIENTS (purchasable only) does NOT include the internal item — stock gate reads 0
    // INGREDIENTS_ALL (full catalog) DOES include it with real stock
    // 73-06 (WR-01): fixture now carries `unit` (matches production catalog shape).
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([
          { item_id: INTERNAL_ITEM_ID, stock_on_hand: 20.83, unit: 'kg' }
        ]);
      }
      // 'zoho:ingredients' returns list WITHOUT the internal item
      if (key === 'zoho:ingredients') {
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-GYPSUM' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      expect(res._body.summary).toBe('all_ok');
      var gypsumResult = res._body.ingredients[0];
      // Real stock must be visible (not 0)
      expect(gypsumResult.stock_on_hand).toBeGreaterThan(0);
      // 20.83 / 1 = 20 batches → status 'ok'
      expect(gypsumResult.status).toBe('ok');
    });
  });

  // ---------------------------------------------------------------------------
  // 73-06 (WR-01): availability must convert the recipe-line quantity into the
  // catalog item's stocking unit before computing batches_possible — the
  // stockMap previously dropped `unit`, dividing a raw unconverted quantity.
  // ---------------------------------------------------------------------------

  test('WR-01: mixed-unit availability converts before computing batches_possible (per-kg item, 500g line -> 2 batches, low)', function () {
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-MIXED' },
          ingredients: [
            { item_id: '300', item_name: 'Bulk Malt', unit: 'g', quantity: 500 }
          ]
        }
      }
    });
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') {
        // Buggy pre-fix comparison: floor(1 / 500) = 0 -> 'out'.
        // Correct: converted needed = 0.5kg -> floor(1 / 0.5) = 2 -> 'low'.
        return Promise.resolve([
          { item_id: '300', stock_on_hand: 1, unit: 'kg' }
        ]);
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-MIXED' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      var result = res._body.ingredients[0];
      expect(result.batches_possible).toBe(2);
      expect(result.status).toBe('low');
      expect(res._body.summary).toBe('some_low');
    });
  });

  test('WR-01: non-convertible unit fails CLOSED (pcs item, g line) — reported unavailable, not a raw unconverted division', function () {
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-BADUNIT' },
          ingredients: [
            { item_id: '400', item_name: 'Whirlfloc Tablets', unit: 'g', quantity: 10 }
          ]
        }
      }
    });
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([
          { item_id: '400', stock_on_hand: 500, unit: 'pcs' }
        ]);
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-BADUNIT' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      var result = res._body.ingredients[0];
      expect(result.batches_possible).toBe(0);
      expect(result.status).toBe('out');
      expect(res._body.summary).toBe('cannot_brew');
    });
  });

  test('WR-01: matching-unit availability still computes as before (regression)', function () {
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-SAMEUNIT' },
          ingredients: [
            { item_id: '500', item_name: 'Pale Malt', unit: 'kg', quantity: 5 }
          ]
        }
      }
    });
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([
          { item_id: '500', stock_on_hand: 50, unit: 'kg' }
        ]);
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id/availability', { params: { id: 'SV-R-SAMEUNIT' }, headers: { 'x-api-key': 'test-api-key' } }).then(function (res) {
      var result = res._body.ingredients[0];
      expect(result.batches_possible).toBe(10);
      expect(result.status).toBe('ok');
      expect(res._body.summary).toBe('all_ok');
    });
  });
});

describe('POST /api/recipes', function () {
  var mocks;
  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  test('creates recipe and busts cache', function () {
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, recipe_id: 'SV-R-000002' }
    });
    return callHandler('POST', '/api/recipes', { body: { name: 'IPA', style: 'American IPA' } }).then(function (res) {
      expect(res._status).toBe(201);
      expect(res._body.ok).toBe(true);
      expect(res._body.recipe_id).toBe('SV-R-000002');
      // Cache bust: RECIPES_TS + 4 status variants = 5 calls
      expect(mocks.cache.del).toHaveBeenCalled();
    });
  });

  test('returns 422 on create failure', function () {
    mocks.axios.post.mockResolvedValue({
      data: { ok: false, message: 'Name is required' }
    });
    return callHandler('POST', '/api/recipes', { body: {} }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toBe('Name is required');
    });
  });
});

describe('PUT /api/recipes/:id', function () {
  var mocks;
  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  test('updates recipe and busts cache including per-recipe key', function () {
    mocks.axios.post.mockResolvedValue({
      data: { ok: true }
    });
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: { name: 'Updated IPA', status: 'draft' }
    }).then(function (res) {
      expect(res._body.ok).toBe(true);
      // Should bust per-recipe key
      expect(mocks.cache.del).toHaveBeenCalledWith('sv:recipes:SV-R-000001');
    });
  });

  test('rejects activation without locked_price', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: { status: 'active', locked_price: 0, ingredient_count: 3 }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Cannot activate recipe');
      // D-05c: pinned code on the activation-locked-price guardrail
      expect(res._body.code).toBe('activation_locked_price');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('rejects activation without ingredients', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: { status: 'active', locked_price: 50, ingredient_count: 0 }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Cannot activate recipe');
      // D-05c: pinned code on the activation-no-ingredients guardrail
      expect(res._body.code).toBe('activation_no_ingredients');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Regression: the guard fires on `status === 'active'`, not on "is being
  // activated", so it re-runs on EVERY edit of an already-active recipe. A
  // dynamic-priced recipe prices from computed_price and legitimately has
  // locked_price 0 — which made renaming an active dynamic recipe impossible.
  // -------------------------------------------------------------------------

  test('allows editing an ACTIVE DYNAMIC recipe that has no locked_price', function () {
    mocks.axios.post.mockResolvedValue({ data: { ok: true } });
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000002' },
      body: {
        name: 'Czech Lager (renamed)',
        status: 'active',
        pricing_mode: 'dynamic',
        locked_price: 0,
        ingredient_count: 5
      }
    }).then(function (res) {
      expect(res._status).not.toBe(422);
      expect(res._body.code).not.toBe('activation_locked_price');
      expect(res._body.ok).toBe(true);
    });
  });

  test('still requires ingredients on an active dynamic recipe — price derives from them', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000002' },
      body: {
        status: 'active',
        pricing_mode: 'dynamic',
        locked_price: 0,
        ingredient_count: 0
      }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.code).toBe('activation_no_ingredients');
    });
  });

  test('still requires locked_price when pricing_mode is locked', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: {
        status: 'active',
        pricing_mode: 'locked',
        locked_price: 0,
        ingredient_count: 3
      }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.code).toBe('activation_locked_price');
    });
  });
});

// ---------------------------------------------------------------------------
// D-03: save-time unit validation pre-flight (POST/PUT) + D-05c code/cause
// ---------------------------------------------------------------------------

describe('D-03 save-time unit validation pre-flight', function () {
  var mocks;

  // Catalog fixture WITH unit fields — mirrors the Phase 73-02 SV-R-000004
  // fixture idiom (line 740). WHIRL is the Whirlfloc D-01 count-unit item.
  var CATALOG_D03 = [
    { item_id: 'MALT',  item_name: 'Gambrinus Pilsner Malt', unit: 'kg',  rate: 2.75 },
    { item_id: 'WHIRL', item_name: 'Whirlfloc Tablets',      unit: 'pcs', rate: 0.32 },
    { item_id: 'YEAST', item_name: 'Fermentis SafLager W-34/70', unit: 'pcs', rate: 10 }
  ];

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients:all') return Promise.resolve(CATALOG_D03);
      return Promise.resolve(null);
    });
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  test('PUT: mis-typed unit token on a per-kg item ("grams" instead of "g") is rejected 422 with unit_mismatch code + no Apps Script call', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: {
        status: 'draft',
        ingredients: [
          { item_id: 'MALT', item_name: 'Gambrinus Pilsner Malt', unit: 'grams', quantity: 4100 }
        ]
      }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Gambrinus Pilsner Malt');
      expect(res._body.code).toBe('unit_mismatch');
      expect(res._body.cause).toBe('Gambrinus Pilsner Malt');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('PUT: Whirlfloc (pcs) line saved with unit "L" is rejected 422 with unit_mismatch code (D-01)', function () {
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: {
        status: 'draft',
        ingredients: [
          { item_id: 'WHIRL', item_name: 'Whirlfloc Tablets', unit: 'L', quantity: 1 }
        ]
      }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Whirlfloc Tablets');
      expect(res._body.code).toBe('unit_mismatch');
      expect(res._body.cause).toBe('Whirlfloc Tablets');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('POST: un-convertible ingredient line is rejected 422 with unit_mismatch code + no Apps Script call', function () {
    return callHandler('POST', '/api/recipes', {
      body: {
        name: 'Test Ale',
        ingredients: [
          { item_id: 'WHIRL', item_name: 'Whirlfloc Tablets', unit: 'L', quantity: 1 }
        ]
      }
    }).then(function (res) {
      expect(res._status).toBe(422);
      expect(res._body.error).toContain('Whirlfloc Tablets');
      expect(res._body.code).toBe('unit_mismatch');
      expect(res._body.cause).toBe('Whirlfloc Tablets');
      expect(mocks.axios.post).not.toHaveBeenCalled();
    });
  });

  test('PUT: convertible payload passes the pre-flight and reaches callAppsScriptPost (happy path)', function () {
    mocks.axios.post.mockResolvedValue({ data: { ok: true } });
    return callHandler('PUT', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: {
        status: 'draft',
        ingredients: [
          { item_id: 'MALT', item_name: 'Gambrinus Pilsner Malt', unit: 'g', quantity: 4100 },
          { item_id: 'WHIRL', item_name: 'Whirlfloc Tablets', unit: 'pcs', quantity: 1 },
          { item_id: 'YEAST', item_name: 'Fermentis SafLager W-34/70', unit: 'pcs', quantity: 2 }
        ]
      }
    }).then(function (res) {
      expect(mocks.axios.post).toHaveBeenCalled();
      expect(res._body.ok).toBe(true);
    });
  });

  test('POST: convertible payload passes the pre-flight and reaches callAppsScriptPost (happy path)', function () {
    mocks.axios.post.mockResolvedValue({ data: { ok: true, recipe_id: 'SV-R-000099' } });
    return callHandler('POST', '/api/recipes', {
      body: {
        name: 'Test Ale',
        ingredients: [
          { item_id: 'MALT', item_name: 'Gambrinus Pilsner Malt', unit: 'kg', quantity: 4.1 }
        ]
      }
    }).then(function (res) {
      expect(mocks.axios.post).toHaveBeenCalled();
      expect(res._status).toBe(201);
      expect(res._body.ok).toBe(true);
    });
  });
});

describe('DELETE /api/recipes/:id', function () {
  var mocks;
  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  test('deletes recipe and busts cache', function () {
    mocks.axios.post.mockResolvedValue({
      data: { ok: true }
    });
    return callHandler('DELETE', '/api/recipes/:id', {
      params: { id: 'SV-R-000001' },
      body: {}
    }).then(function (res) {
      expect(res._body.ok).toBe(true);
      expect(mocks.cache.del).toHaveBeenCalledWith('sv:recipes:SV-R-000001');
    });
  });
});

// ---------------------------------------------------------------------------
// Ingredient group enrichment (RDISP-02, D-07, D-08)
// ---------------------------------------------------------------------------

describe('GET /api/recipes/:id ingredient group enrichment', function () {
  var mocks;

  // Catalog entry with cf_type top-level and cf_subcategory in custom_fields[]
  var warmCatalog = [
    {
      item_id: 'ING-001',
      rate: 2.5,
      cf_type: 'Grain',
      custom_fields: [
        { api_name: 'cf_subcategory', value_formatted: 'Base Malt', value: 'base_malt' }
      ]
    }
  ];

  var OLD_API_SECRET_KEY;

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  test('warm catalog: each ingredient gains cf_type, cf_subcategory, display_group on cache hit', function () {
    var cached = {
      recipe: { recipe_id: 'SV-R-000001', pricing_mode: 'locked', locked_price: 50 },
      ingredients: [
        { item_id: 'ING-001', item_name: 'Pale Malt', quantity: 4.5 }
      ]
    };
    // First call: recipe cache hit; second call: ingredients catalog
    mocks.cache.get
      .mockResolvedValueOnce(cached)          // recipe cache
      .mockResolvedValueOnce(warmCatalog);    // ingredients cache

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      var ing = res._body.ingredients[0];
      expect(ing.cf_type).toBe('Grain');
      expect(ing.cf_subcategory).toBe('Base Malt');
      expect(typeof ing.display_group).toBe('string');
    });
  });

  test('warm catalog: cf_subcategory is read from entry.custom_fields[] not top-level', function () {
    // Entry has NO top-level cf_subcategory — it must come from custom_fields
    var catalogEntry = {
      item_id: 'ING-002',
      rate: 1.0,
      cf_type: 'Hops',
      cf_subcategory: undefined, // NOT top-level
      custom_fields: [
        { api_name: 'cf_subcategory', value_formatted: 'Pellet Hops', value: 'pellet_hops' }
      ]
    };
    var cached = {
      recipe: { recipe_id: 'SV-R-000002', pricing_mode: 'locked', locked_price: 30 },
      ingredients: [{ item_id: 'ING-002', item_name: 'Cascade', quantity: 50 }]
    };
    mocks.cache.get
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce([catalogEntry]);

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000002' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      var ing = res._body.ingredients[0];
      expect(ing.cf_subcategory).toBe('Pellet Hops');
    });
  });

  test('additive-only: ingredient array length and pre-existing fields are unchanged (D-08)', function () {
    var cached = {
      recipe: { recipe_id: 'SV-R-000001', pricing_mode: 'locked', locked_price: 50 },
      ingredients: [
        { item_id: 'ING-001', item_name: 'Pale Malt', quantity: 4.5, rate: 1.5, tax_id: 'TAX-001' }
      ]
    };
    mocks.cache.get
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce(warmCatalog);

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._body.ingredients).toHaveLength(1);
      var ing = res._body.ingredients[0];
      expect(ing.item_id).toBe('ING-001');
      expect(ing.quantity).toBe(4.5);
      // Additive fields added
      expect(ing.cf_type).toBe('Grain');
      expect(ing.cf_subcategory).toBe('Base Malt');
    });
  });

  test('cold cache: ingredients returned unchanged with no error (D-07)', function () {
    var cached = {
      recipe: { recipe_id: 'SV-R-000001', pricing_mode: 'locked', locked_price: 50 },
      ingredients: [
        { item_id: 'ING-001', item_name: 'Pale Malt', quantity: 4.5 }
      ]
    };
    // Simulate cold cache: recipe cache hit but ingredients cache cold
    // Mock fs.readFileSync to throw (no file fallback)
    jest.mock('fs', function () {
      return { readFileSync: jest.fn(function () { throw new Error('ENOENT'); }) };
    });
    mocks.cache.get
      .mockResolvedValueOnce(cached)  // recipe cache hit
      .mockResolvedValueOnce(null);   // ingredients cache cold

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      // Must still return ingredients array — no error
      expect(res._status).toBe(200);
      expect(res._body.ingredients).toHaveLength(1);
      expect(res._body.ingredients[0].item_id).toBe('ING-001');
      // Additive fields absent/empty when cold
      var ing = res._body.ingredients[0];
      expect(ing.cf_type == null || ing.cf_type === '').toBe(true);
    });
  });

  test('locked-price recipe still receives cf_type/cf_subcategory (not gated behind dynamic)', function () {
    var cached = {
      recipe: { recipe_id: 'SV-R-000003', pricing_mode: 'locked', locked_price: 45 },
      ingredients: [
        { item_id: 'ING-001', item_name: 'Pale Malt', quantity: 4.5 }
      ]
    };
    mocks.cache.get
      .mockResolvedValueOnce(cached)
      .mockResolvedValueOnce(warmCatalog);

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000003' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      // pricing_mode is 'locked' so enrichWithComputedPrice early-returns,
      // but enrichIngredientGroups must still run
      var ing = res._body.ingredients[0];
      expect(ing.cf_type).toBe('Grain');
      expect(ing.cf_subcategory).toBe('Base Malt');
    });
  });

  test('warm catalog (fresh fetch): each ingredient gains cf_type/cf_subcategory on cache miss', function () {
    // No cache hit — Apps Script fetch
    mocks.cache.get
      .mockResolvedValueOnce(null)         // recipe cache miss
      .mockResolvedValueOnce(warmCatalog); // ingredients catalog warm

    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipe: { recipe_id: 'SV-R-000001', pricing_mode: 'locked', locked_price: 50 },
          ingredients: [{ item_id: 'ING-001', item_name: 'Pale Malt', quantity: 4.5 }]
        }
      }
    });

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000001' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      var ing = res._body.ingredients[0];
      expect(ing.cf_type).toBe('Grain');
      expect(ing.cf_subcategory).toBe('Base Malt');
    });
  });
});

// ---------------------------------------------------------------------------
// SCALE-05 extension: enrichment functions must read INGREDIENTS_ALL so that
// internal-only recipe ingredients (not in purchasable INGREDIENTS catalog)
// receive correct grouping fields and contribute to computed pricing.
// RED: these tests FAIL before the enrichment source is changed.
// ---------------------------------------------------------------------------

describe('SCALE-05 ext — enrichment reads INGREDIENTS_ALL for internal-only ingredients', function () {
  var mocks;

  // Shared internal-only ingredient fixture (not in purchasable INGREDIENTS)
  var INTERNAL_ID = 'ING-INTERNAL-001';
  var internalCatalogEntry = {
    item_id: INTERNAL_ID,
    unit: 'pcs',
    rate: 1.50,
    cf_type: 'Additive',
    custom_fields: [
      { api_name: 'cf_subcategory', value_formatted: 'Water Chemistry', value: 'water_chemistry' }
    ]
  };

  // Key-based cache mock: INGREDIENTS returns empty (purchasable only, excludes internal);
  // INGREDIENTS_ALL returns the full catalog with the internal item.
  function keyedCacheMock(recipeOrListCachedValue, kioskValue) {
    mocks.cache.get.mockImplementation(function (key) {
      // Recipe cache hit (keyed by recipe id)
      if (recipeOrListCachedValue !== undefined && key === 'sv:recipes:SV-R-INTERNAL') {
        return Promise.resolve(recipeOrListCachedValue);
      }
      // Purchasable-only catalog — does NOT include INTERNAL_ID
      if (key === 'zoho:ingredients') {
        return Promise.resolve([]);
      }
      // Full catalog INCLUDING internal items
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([internalCatalogEntry]);
      }
      // Kiosk products (for milling fee lookup inside enrichWithComputedPrice)
      if (key === 'zoho:kiosk-products') {
        return Promise.resolve(kioskValue || []);
      }
      return Promise.resolve(null);
    });
  }

  var OLD_API_SECRET_KEY;

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  // --- Test 1: enrichIngredientGroups reads INGREDIENTS_ALL ---
  test('enrichIngredientGroups: internal-only ingredient gets cf_type/cf_subcategory/display_group from INGREDIENTS_ALL', function () {
    var cachedDetail = {
      recipe: { recipe_id: 'SV-R-INTERNAL', pricing_mode: 'locked', locked_price: 25 },
      ingredients: [
        { item_id: INTERNAL_ID, item_name: 'Calcium Sulfate (Bulk)', quantity: 0.005 }
      ]
    };
    // Recipe cache hit; catalog reads are key-dispatched
    keyedCacheMock(cachedDetail, []);

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-INTERNAL' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var ing = res._body.ingredients[0];
      // Enrichment must have resolved cf_type from INGREDIENTS_ALL
      expect(ing.cf_type).toBe('Additive');
      expect(ing.cf_subcategory).toBe('Water Chemistry');
      expect(ing.display_group).toBeTruthy();
    });
  });

  // --- Test 2: enrichWithComputedPrice reads INGREDIENTS_ALL ---
  test('enrichWithComputedPrice: internal-only ingredient rate contributes to computed_price for dynamic recipe', function () {
    // Dynamic recipe — ingredient is internal-only (rate 1.50/unit)
    var cachedDetail = {
      recipe: { recipe_id: 'SV-R-INTERNAL', pricing_mode: 'dynamic', service_fee: 10 },
      ingredients: [
        { item_id: INTERNAL_ID, item_name: 'Calcium Sulfate (Bulk)', unit: 'pcs', quantity: 2 }
      ]
    };
    keyedCacheMock(cachedDetail, []);

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-INTERNAL' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      // computed_price = (2 * 1.50) + service_fee 10 = 13.00
      // Before fix: INGREDIENTS is empty → rate=0 → computed_price = 10.00 → test fails
      expect(res._body.recipe.computed_price).toBe(13.00);
    });
  });

  // --- Test 3: enrichListPrices reads INGREDIENTS_ALL ---
  test('enrichListPrices: dynamic recipe list price includes internal-only ingredient rate from INGREDIENTS_ALL', function () {
    // Recipe list cache miss — fetches from Apps Script
    var recipeInList = {
      recipe_id: 'SV-R-INTERNAL',
      pricing_mode: 'dynamic',
      service_fee: 5,
      materials_fee: 0
    };
    // Apps Script returns the recipe list then detail on second call
    mocks.axios.post.mockImplementation(function (url, body) {
      var parsed = typeof body === 'string' ? JSON.parse(body) : body;
      if (parsed.action === 'get_recipes') {
        return Promise.resolve({ data: { ok: true, data: { recipes: [recipeInList], total: 1 } } });
      }
      // get_recipe detail call from enrichListPrices (recipe detail cache miss)
      if (parsed.action === 'get_recipe') {
        return Promise.resolve({
          data: {
            ok: true,
            data: {
              recipe: recipeInList,
              ingredients: [{ item_id: INTERNAL_ID, item_name: 'Calcium Sulfate (Bulk)', unit: 'pcs', quantity: 4 }]
            }
          }
        });
      }
      return Promise.resolve({ data: { ok: false, message: 'unexpected' } });
    });

    // List cache miss, recipe detail cache also miss; catalog key-dispatched
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'zoho:ingredients') {
        return Promise.resolve([]);
      }
      if (key === 'zoho:ingredients:all') {
        return Promise.resolve([internalCatalogEntry]); // rate: 1.50
      }
      if (key === 'zoho:kiosk-products') {
        return Promise.resolve([]);
      }
      return Promise.resolve(null); // list and detail cache both cold
    });

    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var recipe = res._body.recipes[0];
      // computed_price = (4 * 1.50) + service_fee 5 = 11.00
      // Before fix: INGREDIENTS is empty → rate=0 → computed_price = 5.00 → test fails
      expect(recipe.computed_price).toBe(11.00);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 73-02: unit-aware computed_price (D-01/D-02/D-04) — read-path
// SV-R-000004 money regression + fail-closed behavior on both sum-sites.
// RED: these tests FAIL before enrichWithComputedPrice/enrichListPrices are
// wired to scaling.ingredientLineCost (current code does bare qty * rate).
// ---------------------------------------------------------------------------

describe('Phase 73-02: unit-aware computed_price (detail + list read-paths)', function () {
  var mocks;

  // Fixture-driven only (D-04) — mirrors the 73-PRICING-BUG-HANDOFF.md evidence
  // table for SV-R-000004 in its CORRECTED state (Whirlfloc line unit fixed to
  // 'pcs' at ~$0.32/tablet per D-01 owner data action). No live recipe is edited.
  var CATALOG_SVR4 = [
    { item_id: 'MAG-B',   item_name: 'Magnum Bulk',                     unit: 'kg',  rate: 54 },
    { item_id: 'MIT-B',   item_name: 'GR Hallertau Mittelfruh Bulk',    unit: 'kg',  rate: 72 },
    { item_id: 'CACL',    item_name: 'Calcium Chloride Bulk',           unit: 'kg',  rate: 15 },
    { item_id: 'GYP',     item_name: 'Gypsum (Calcium Sulfate) Bulk',   unit: 'kg',  rate: 10 },
    { item_id: 'WHIRL',   item_name: 'Whirlfloc Tablets',               unit: 'pcs', rate: 0.32 },
    { item_id: 'MALT',    item_name: 'Gambrinus Pilsner Malt',          unit: 'kg',  rate: 2.75 },
    { item_id: 'CORN',    item_name: 'OiO Flaked Corn',                 unit: 'kg',  rate: 3 },
    { item_id: 'YEAST',   item_name: 'Fermentis SafLager W-34/70',      unit: 'pcs', rate: 10 },
    { item_id: 'LACTIC',  item_name: 'Lactic Acid 88%',                 unit: 'L',   rate: 25 }
  ];

  var INGREDIENTS_SVR4 = [
    { item_id: 'MAG-B',  item_name: 'Magnum Bulk',                  unit: 'g',   quantity: 12 },
    { item_id: 'MIT-B',  item_name: 'GR Hallertau Mittelfruh Bulk', unit: 'g',   quantity: 15 },
    { item_id: 'CACL',   item_name: 'Calcium Chloride Bulk',        unit: 'g',   quantity: 3 },
    { item_id: 'GYP',    item_name: 'Gypsum (Calcium Sulfate) Bulk', unit: 'g',  quantity: 3 },
    { item_id: 'WHIRL',  item_name: 'Whirlfloc Tablets',            unit: 'pcs', quantity: 1 },
    { item_id: 'MALT',   item_name: 'Gambrinus Pilsner Malt',       unit: 'kg',  quantity: 4.1 },
    { item_id: 'CORN',   item_name: 'OiO Flaked Corn',              unit: 'kg',  quantity: 1.4 },
    { item_id: 'YEAST',  item_name: 'Fermentis SafLager W-34/70',   unit: 'pcs', quantity: 2 },
    { item_id: 'LACTIC', item_name: 'Lactic Acid 88%',              unit: 'L',   quantity: 0.02 }
  ];

  var OLD_API_SECRET_KEY;

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  test('D-04: SV-R-000004 corrected fixture recomputes to ~$88-95, not $1,896.98', function () {
    var cachedDetail = {
      recipe: { recipe_id: 'SV-R-000004', pricing_mode: 'dynamic', service_fee: 45, materials_fee: 5 },
      ingredients: INGREDIENTS_SVR4.map(function (i) { return Object.assign({}, i); })
    };
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'sv:recipes:SV-R-000004') return Promise.resolve(cachedDetail);
      if (key === 'zoho:ingredients:all') return Promise.resolve(CATALOG_SVR4);
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-000004' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var price = res._body.recipe.computed_price;
      expect(price).toBeGreaterThanOrEqual(88);
      expect(price).toBeLessThanOrEqual(95);
      expect(price).not.toBeCloseTo(1896.98, 1);
    });
  });

  test('D-02 read-path fail-closed (detail): cross-family line marks computed_price null + names the line, no 5xx', function () {
    var badCatalog = [
      { item_id: 'BAD-ITEM', item_name: 'Mystery Additive', unit: 'pcs', rate: 5 }
    ];
    var cachedDetail = {
      recipe: { recipe_id: 'SV-R-BAD', pricing_mode: 'dynamic', service_fee: 10, materials_fee: 0 },
      ingredients: [
        { item_id: 'BAD-ITEM', item_name: 'Mystery Additive', unit: 'g', quantity: 5 }
      ]
    };
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'sv:recipes:SV-R-BAD') return Promise.resolve(cachedDetail);
      if (key === 'zoho:ingredients:all') return Promise.resolve(badCatalog);
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes/:id', { params: { id: 'SV-R-BAD' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.recipe.computed_price).toBeNull();
      expect(typeof res._body.recipe.pricing_error).toBe('string');
      expect(res._body.recipe.pricing_error).toContain('Mystery Additive');
    });
  });

  test('D-02 list resilience: one bad recipe among many still resolves with the good recipe priced', function () {
    var combinedCatalog = [
      { item_id: 'GOOD-ITEM', item_name: 'Good Malt', unit: 'kg', rate: 3 },
      { item_id: 'BAD-ITEM', item_name: 'Bad Additive', unit: 'pcs', rate: 5 }
    ];
    var goodRecipe = { recipe_id: 'SV-R-GOOD', pricing_mode: 'dynamic', service_fee: 5, materials_fee: 0 };
    var badRecipe = { recipe_id: 'SV-R-BADLIST', pricing_mode: 'dynamic', service_fee: 5, materials_fee: 0 };
    var cachedList = { recipes: [goodRecipe, badRecipe], total: 2 };

    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'sv:recipes:all:0:0') return Promise.resolve(cachedList);
      if (key === 'zoho:ingredients:all') return Promise.resolve(combinedCatalog);
      if (key === 'sv:recipes:SV-R-GOOD') {
        return Promise.resolve({
          recipe: goodRecipe,
          ingredients: [{ item_id: 'GOOD-ITEM', item_name: 'Good Malt', unit: 'kg', quantity: 2 }]
        });
      }
      if (key === 'sv:recipes:SV-R-BADLIST') {
        return Promise.resolve({
          recipe: badRecipe,
          ingredients: [{ item_id: 'BAD-ITEM', item_name: 'Bad Additive', unit: 'g', quantity: 5 }]
        });
      }
      return Promise.resolve(null);
    });

    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var good = res._body.recipes.find(function (r) { return r.recipe_id === 'SV-R-GOOD'; });
      var bad = res._body.recipes.find(function (r) { return r.recipe_id === 'SV-R-BADLIST'; });
      expect(typeof good.computed_price).toBe('number');
      expect(good.computed_price).toBe(11); // (2 * 3) + service_fee 5
      expect(bad.computed_price).toBeNull();
      expect(typeof bad.pricing_error).toBe('string');
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 81-02 Task 1: maxNonPackagingOffset — pure derivation
// ---------------------------------------------------------------------------

describe('maxNonPackagingOffset', function () {
  var recipes;
  beforeEach(function () {
    recipes = resetAndLoadRecipes().recipes;
  });

  test('returns the max day_offset among non-packaging steps', function () {
    var schedule = { steps_parsed: [{ day_offset: 0 }, { day_offset: 21 }, { is_packaging: true }] };
    expect(recipes.maxNonPackagingOffset(schedule)).toBe(21);
  });

  test('steps stored out of order still yield the maximum', function () {
    var schedule = { steps_parsed: [{ day_offset: 21 }, { day_offset: 3 }, { day_offset: 14 }] };
    expect(recipes.maxNonPackagingOffset(schedule)).toBe(21);
  });

  test('the packaging step is excluded even when it carries the largest day_offset', function () {
    var schedule = { steps_parsed: [{ day_offset: 21 }, { day_offset: 99, is_packaging: true }] };
    expect(recipes.maxNonPackagingOffset(schedule)).toBe(21);
  });

  test('a schedule whose only step is the packaging step returns null', function () {
    var schedule = { steps_parsed: [{ day_offset: 99, is_packaging: true }] };
    expect(recipes.maxNonPackagingOffset(schedule)).toBeNull();
  });

  test('null, undefined, {} and { steps_parsed: [] } all return null without throwing', function () {
    expect(recipes.maxNonPackagingOffset(null)).toBeNull();
    expect(recipes.maxNonPackagingOffset(undefined)).toBeNull();
    expect(recipes.maxNonPackagingOffset({})).toBeNull();
    expect(recipes.maxNonPackagingOffset({ steps_parsed: [] })).toBeNull();
  });

  test('a step whose day_offset is a string, null or missing is skipped, not coerced', function () {
    var schedule = {
      steps_parsed: [
        { day_offset: '21' },
        { day_offset: null },
        { day_offset: undefined },
        { day_offset: 7 }
      ]
    };
    expect(recipes.maxNonPackagingOffset(schedule)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Phase 81-02 Task 1: fetchFermSchedules — cache + Apps Script GET
// ---------------------------------------------------------------------------

describe('fetchFermSchedules', function () {
  var mocks;
  var OLD_APPS_SCRIPT_URL, OLD_APPS_SCRIPT_SERVER_TOKEN;

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    OLD_APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
    OLD_APPS_SCRIPT_SERVER_TOKEN = process.env.APPS_SCRIPT_SERVER_TOKEN;
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
  });

  afterEach(function () {
    process.env.APPS_SCRIPT_URL = OLD_APPS_SCRIPT_URL;
    process.env.APPS_SCRIPT_SERVER_TOKEN = OLD_APPS_SCRIPT_SERVER_TOKEN;
  });

  test('returns the cached array without calling axios when the cache key is populated', function () {
    var cachedSchedules = [{ schedule_id: 'FS-1' }];
    mocks.cache.get.mockResolvedValue(cachedSchedules);
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual(cachedSchedules);
      expect(mocks.axios.get).not.toHaveBeenCalled();
    });
  });

  test('calls axios.get with action get_ferm_schedules and server_token, and caches the result', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.cache.set.mockResolvedValue(true);
    var schedules = [{ schedule_id: 'FS-1', steps_parsed: [{ day_offset: 21 }] }];
    mocks.axios.get.mockResolvedValue({ data: { ok: true, data: { schedules: schedules } } });
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual(schedules);
      expect(mocks.axios.get).toHaveBeenCalledTimes(1);
      var callArgs = mocks.axios.get.mock.calls[0];
      expect(callArgs[1].params.action).toBe('get_ferm_schedules');
      expect(callArgs[1].params.server_token).toBe('test-token');
      expect(mocks.cache.set).toHaveBeenCalledWith('sv:ferm-schedules', schedules, 300);
    });
  });

  test('resolves to [] when axios rejects', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.get.mockRejectedValue(new Error('network down'));
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual([]);
    });
  });

  test('resolves to [] when the response is ok:false', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.get.mockResolvedValue({ data: { ok: false, error: 'boom' } });
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual([]);
    });
  });

  test('resolves to [] when APPS_SCRIPT_URL is unset', function () {
    delete process.env.APPS_SCRIPT_URL;
    mocks.cache.get.mockResolvedValue(null);
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual([]);
      expect(mocks.axios.get).not.toHaveBeenCalled();
    });
  });

  test('resolves to [] when APPS_SCRIPT_SERVER_TOKEN is unset', function () {
    delete process.env.APPS_SCRIPT_SERVER_TOKEN;
    mocks.cache.get.mockResolvedValue(null);
    return mocks.recipes.fetchFermSchedules().then(function (result) {
      expect(result).toEqual([]);
      expect(mocks.axios.get).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 81-02 Task 2 (D-16): ferment_days — staff path + schedules-fetch
// failure. The anonymous-caller contract has its own dedicated coverage in
// recipes-public-guard.test.js; these two cases specifically exercise the
// staff (byte-for-byte) branch and the D-09/T-81-10 degrade-gracefully path.
// ---------------------------------------------------------------------------

describe('D-16 ferment_days: staff path + schedules-fetch failure (Phase 81-02)', function () {
  var mocks;
  var OLD_API_SECRET_KEY;

  var SCHEDULE_WITH_OFFSET = {
    schedule_id: 'SV-FS-000021',
    steps_parsed: [
      { day_offset: 0 },
      { day_offset: 21 },
      { day_offset: 999, is_packaging: true }
    ]
  };

  // Factory, NOT a shared object literal: enrichFermentDays mutates the
  // recipe in place (recipe.ferment_days = offset), so a single shared
  // fixture would leak a mutation from one test into the next.
  function freshStaffRecipeScheduled() {
    return {
      recipe_id: 'SV-R-FERM-STAFF-1',
      name: 'Staff Fermentation Test IPA',
      style: 'IPA',
      status: 'draft',
      pricing_mode: 'locked',
      locked_price: 40,
      schedule_id: 'SV-FS-000021',
      ingredients: []
    };
  }

  beforeEach(function () {
    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    process.env.API_SECRET_KEY = TEST_API_KEY;
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
  });

  test('staff list: still receives schedule_id byte-for-byte and also gains ferment_days', function () {
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'sv:ferm-schedules') return Promise.resolve([SCHEDULE_WITH_OFFSET]);
      return Promise.resolve(null);
    });
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshStaffRecipeScheduled()], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'draft' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var r = res._body.recipes[0];
      expect(r.schedule_id).toBe('SV-FS-000021');
      expect(r.ferment_days).toBe(21);
    });
  });

  test('schedules fetch failure: list route still returns 200 with recipes and no ferment_days keys', function () {
    mocks.cache.get.mockResolvedValue(null); // both the recipe-list key and sv:ferm-schedules miss
    mocks.axios.get.mockRejectedValue(new Error('Apps Script unreachable'));
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshStaffRecipeScheduled()], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'draft' }, headers: { 'x-api-key': TEST_API_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var r = res._body.recipes[0];
      expect(r).not.toHaveProperty('ferment_days');
    });
  });
});

'use strict';

// ---------------------------------------------------------------------------
// D-05/D-06/D-07 regression coverage — the public recipe read contract.
//
// Today (pre-fix) both GET /api/recipes and GET /api/recipes/:id are
// unauthenticated AND ungated: an anonymous caller can pass ?status=all and
// receive every recipe (drafts included) with cost-derivable fields
// (computed_price, locked_price, service_fee, materials_fee, ingredients).
// This file proves that defect against the CURRENT handlers (RED) and will
// stay green once routes/recipes.js gains the tier-aware status guard +
// field allowlist (GREEN, Task 3).
//
// Harness copied verbatim from recipes.test.js: same express/axios/cache/
// logger/constants jest.mock block, same resetAndLoadRecipes()/callHandler()
// helpers. Deliberately does NOT mock ../lib/authTiers — the real tier
// resolution (apiKeyGuard.matches / deviceToken.matches) is what is under
// test here, mirroring catalog-bust-auth.test.js's approach.
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
// Helpers (identical shape to recipes.test.js)
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
// Fixtures
// ---------------------------------------------------------------------------

var TEST_KEY = 'test-recipes-public-guard-key';
var TEST_DEVICE_TOKEN = 'test-recipes-public-guard-device-token';

var DYNAMIC_ACTIVE = {
  recipe_id: 'SV-R-PGUARD-DYN',
  name: 'Hazy IPA',
  style: 'IPA',
  description: 'A juicy hazy IPA.',
  status: 'active',
  pricing_mode: 'dynamic',
  computed_price: 42.50,
  batch_size_l: 20,
  ibu: 55,
  ingredients: [{ item_id: 'X' }]
};

var DYNAMIC_ACTIVE_NULL_PRICE = {
  recipe_id: 'SV-R-PGUARD-DYN-NULL',
  name: 'Test Saison',
  style: 'Saison',
  description: '',
  status: 'active',
  pricing_mode: 'dynamic',
  computed_price: null,
  ingredients: []
};

var LOCKED_ACTIVE = {
  recipe_id: 'SV-R-PGUARD-LOCKED',
  name: 'Classic Lager',
  style: 'Lager',
  description: 'Crisp and clean.',
  status: 'active',
  pricing_mode: 'locked',
  locked_price: 30,
  service_fee: 15,
  materials_fee: 5.25,
  ingredients: [{ item_id: 'Y' }]
};

var DRAFT = {
  recipe_id: 'SV-R-PGUARD-DRAFT',
  name: 'Experimental Sour',
  style: 'Sour',
  description: 'In development.',
  status: 'draft',
  pricing_mode: 'locked',
  locked_price: 20,
  computed_price: 999,
  notes: 'do not publish',
  created_by: 'staff@example.com',
  ingredients: [{ item_id: 'Z' }]
};

var ALLOWED_PUBLIC_FIELDS = ['recipe_id', 'name', 'style', 'description', 'price', 'price_from'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Public recipe read contract (D-05/D-06/D-07)', function () {
  var mocks;
  var OLD_API_SECRET_KEY, OLD_MW_API_KEY, OLD_KIOSK_DEVICE_TOKEN;
  var OLD_APPS_SCRIPT_URL, OLD_APPS_SCRIPT_SERVER_TOKEN;

  beforeEach(function () {
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    OLD_MW_API_KEY = process.env.MW_API_KEY;
    OLD_KIOSK_DEVICE_TOKEN = process.env.KIOSK_DEVICE_TOKEN;
    OLD_APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
    OLD_APPS_SCRIPT_SERVER_TOKEN = process.env.APPS_SCRIPT_SERVER_TOKEN;

    process.env.API_SECRET_KEY = TEST_KEY;
    delete process.env.MW_API_KEY;
    process.env.KIOSK_DEVICE_TOKEN = TEST_DEVICE_TOKEN;
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';

    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
    process.env.MW_API_KEY = OLD_MW_API_KEY;
    process.env.KIOSK_DEVICE_TOKEN = OLD_KIOSK_DEVICE_TOKEN;
    process.env.APPS_SCRIPT_URL = OLD_APPS_SCRIPT_URL;
    process.env.APPS_SCRIPT_SERVER_TOKEN = OLD_APPS_SCRIPT_SERVER_TOKEN;
  });

  // -------------------------------------------------------------------------
  // D-06 list, anonymous
  // -------------------------------------------------------------------------

  test('D-06 list: anonymous ?status=all is forced to active in the Apps Script request; no draft in response', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DYNAMIC_ACTIVE, LOCKED_ACTIVE], total: 2 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      expect(res._status).toBe(200);
      var sentBody = JSON.parse(mocks.axios.post.mock.calls[0][1]);
      expect(sentBody.status).toBe('active');
      var draftPresent = res._body.recipes.some(function (r) { return r.recipe_id === DRAFT.recipe_id; });
      expect(draftPresent).toBe(false);
      var anyDraftStatus = res._body.recipes.some(function (r) { return r.status === 'draft'; });
      expect(anyDraftStatus).toBe(false);
    });
  });

  test('D-06 list defense-in-depth: cache-hit payload containing a draft is still filtered for anonymous callers', function () {
    mocks.cache.get.mockResolvedValue({ recipes: [DYNAMIC_ACTIVE, LOCKED_ACTIVE, DRAFT], total: 3 });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      expect(res._status).toBe(200);
      var draftPresent = res._body.recipes.some(function (r) { return r.recipe_id === DRAFT.recipe_id; });
      expect(draftPresent).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // D-07 field allowlist, anonymous
  // -------------------------------------------------------------------------

  test('D-07 field allowlist: every anonymous list record only carries allowlisted keys', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DYNAMIC_ACTIVE, LOCKED_ACTIVE], total: 2 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      res._body.recipes.forEach(function (r) {
        Object.keys(r).forEach(function (k) {
          expect(ALLOWED_PUBLIC_FIELDS.indexOf(k)).not.toBe(-1);
        });
        expect(r.locked_price).toBeUndefined();
        expect(r.service_fee).toBeUndefined();
        expect(r.materials_fee).toBeUndefined();
        expect(r.computed_price).toBeUndefined();
        expect(r.pricing_mode).toBeUndefined();
        expect(r.notes).toBeUndefined();
        expect(r.status).toBeUndefined();
        expect(r.batch_size_l).toBeUndefined();
        expect(r.ibu).toBeUndefined();
        expect(r.ingredients).toBeUndefined();
      });
    });
  });

  test('D-07 price collapse: dynamic price mirrors computed_price with price_from; locked price sums fee components with no price_from key', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DYNAMIC_ACTIVE, LOCKED_ACTIVE], total: 2 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      var dyn = res._body.recipes.find(function (r) { return r.recipe_id === DYNAMIC_ACTIVE.recipe_id; });
      var locked = res._body.recipes.find(function (r) { return r.recipe_id === LOCKED_ACTIVE.recipe_id; });
      expect(dyn.price).toBe(DYNAMIC_ACTIVE.computed_price);
      expect(dyn.price_from).toBe(true);
      var expectedLockedPrice = Math.round(
        (LOCKED_ACTIVE.locked_price + LOCKED_ACTIVE.service_fee + LOCKED_ACTIVE.materials_fee) * 100
      ) / 100;
      expect(locked.price).toBe(expectedLockedPrice);
      expect(locked).not.toHaveProperty('price_from');
    });
  });

  test('D-07: dynamic recipe with null computed_price yields price: null (not 0, not omitted)', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DYNAMIC_ACTIVE_NULL_PRICE], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      var r = res._body.recipes[0];
      expect(r).toHaveProperty('price');
      expect(r.price).toBeNull();
      expect(r.price_from).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // D-06 detail, anonymous
  // -------------------------------------------------------------------------

  test('D-06 detail: anonymous request for a draft recipe returns 404, indistinguishable from missing', function () {
    mocks.cache.get.mockResolvedValue({ recipe: DRAFT, ingredients: DRAFT.ingredients });
    return callHandler('GET', '/api/recipes/:id', { params: { id: DRAFT.recipe_id }, headers: {} }).then(function (res) {
      expect(res._status).toBe(404);
      expect(res._body.error).toBe('Recipe not found');
      expect(res._body.recipe).toBeUndefined();
      expect(res._body.ingredients).toBeUndefined();
    });
  });

  test('D-06 detail: anonymous request for an active recipe returns the allowlisted projection with no ingredients key', function () {
    mocks.cache.get.mockResolvedValue({ recipe: LOCKED_ACTIVE, ingredients: LOCKED_ACTIVE.ingredients });
    return callHandler('GET', '/api/recipes/:id', { params: { id: LOCKED_ACTIVE.recipe_id }, headers: {} }).then(function (res) {
      expect(res._status).toBe(200);
      Object.keys(res._body.recipe).forEach(function (k) {
        expect(ALLOWED_PUBLIC_FIELDS.indexOf(k)).not.toBe(-1);
      });
      expect(res._body).not.toHaveProperty('ingredients');
    });
  });

  // -------------------------------------------------------------------------
  // D-05 staff, no regression
  // -------------------------------------------------------------------------

  test('D-05 staff: legacy x-api-key credential still receives status=draft with full pricing intact', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DRAFT], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'draft' }, headers: { 'x-api-key': TEST_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      var sentBody = JSON.parse(mocks.axios.post.mock.calls[0][1]);
      expect(sentBody.status).toBe('draft');
      var draft = res._body.recipes.find(function (r) { return r.recipe_id === DRAFT.recipe_id; });
      expect(draft).toBeDefined();
      expect(draft.computed_price).toBe(DRAFT.computed_price);
      expect(draft.locked_price).toBe(DRAFT.locked_price);
    });
  });

  test('D-05 staff: device-token credential (kiosk) still receives status=draft — pins allowKiosk, not allowAdmin', function () {
    mocks.cache.get.mockResolvedValue(null);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [DRAFT], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'draft' }, headers: { 'x-device-token': TEST_DEVICE_TOKEN } }).then(function (res) {
      expect(res._status).toBe(200);
      var draft = res._body.recipes.find(function (r) { return r.recipe_id === DRAFT.recipe_id; });
      expect(draft).toBeDefined();
    });
  });

  test('D-05 staff: legacy x-api-key credential still receives full ingredient detail for a draft recipe', function () {
    mocks.cache.get.mockResolvedValue({ recipe: DRAFT, ingredients: DRAFT.ingredients });
    return callHandler('GET', '/api/recipes/:id', { params: { id: DRAFT.recipe_id }, headers: { 'x-api-key': TEST_KEY } }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.ingredients).toBeDefined();
      expect(res._body.ingredients.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 81-02 Task 2 (D-16): ferment_days — anonymous-caller contract
//
// A NEW field crosses the public boundary for the first time this phase.
// This block asserts it is present exactly when derivable and absent (not
// null, not 0) in every non-derivable case, and that no internal schedule
// detail (schedule_id, steps, steps_parsed, is_transfer) ever leaks past
// the allowlist (T-81-06).
// ---------------------------------------------------------------------------

describe('D-16 ferment_days: anonymous-caller contract (Phase 81-02)', function () {
  var mocks;
  var OLD_API_SECRET_KEY, OLD_APPS_SCRIPT_URL, OLD_APPS_SCRIPT_SERVER_TOKEN;

  var SCHEDULE_WITH_OFFSET = {
    schedule_id: 'SV-FS-000021',
    steps_parsed: [
      { step_number: 1, day_offset: 0, title: 'Pitch', is_transfer: false },
      { step_number: 2, day_offset: 21, title: 'Dry hop', is_transfer: true },
      { step_number: 3, day_offset: 999, title: 'Package', is_packaging: true }
    ]
  };
  var SCHEDULE_ZERO_OFFSET = {
    schedule_id: 'SV-FS-ZERO',
    steps_parsed: [
      { step_number: 1, day_offset: 0, title: 'Pitch' },
      { step_number: 2, day_offset: 999, title: 'Package', is_packaging: true }
    ]
  };
  var SCHEDULE_NEGATIVE_OFFSET = {
    schedule_id: 'SV-FS-NEG',
    steps_parsed: [
      { step_number: 1, day_offset: -3, title: 'Backdated step' }
    ]
  };
  var FERM_SCHEDULES_FIXTURE = [SCHEDULE_WITH_OFFSET, SCHEDULE_ZERO_OFFSET, SCHEDULE_NEGATIVE_OFFSET];

  // Factories, NOT shared object literals: enrichFermentDays mutates the
  // recipe in place (recipe.ferment_days = offset), so a single shared
  // fixture reused across tests (or within one test's multi-recipe array)
  // would leak a mutation forward. Each call site gets its own fresh object.
  function freshRecipeScheduled() {
    return {
      recipe_id: 'SV-R-PGUARD-FERM-1',
      name: 'Fermentation Test IPA',
      style: 'IPA',
      description: 'Has a schedule.',
      status: 'active',
      pricing_mode: 'dynamic',
      computed_price: 20,
      schedule_id: 'SV-FS-000021',
      ingredients: []
    };
  }
  function freshRecipeNoSchedule() {
    return {
      recipe_id: 'SV-R-PGUARD-FERM-2',
      name: 'No Schedule Kit',
      style: 'Kit',
      description: '',
      status: 'active',
      pricing_mode: 'locked',
      locked_price: 40,
      service_fee: 5,
      materials_fee: 5,
      schedule_id: '',
      ingredients: []
    };
  }
  function freshRecipeUnknownSchedule() {
    return {
      recipe_id: 'SV-R-PGUARD-FERM-3',
      name: 'Unknown Schedule Kit',
      style: 'Kit',
      description: '',
      status: 'active',
      pricing_mode: 'locked',
      locked_price: 30,
      service_fee: 0,
      materials_fee: 0,
      schedule_id: 'SV-FS-MISSING',
      ingredients: []
    };
  }
  function freshRecipeZeroOffset() {
    return {
      recipe_id: 'SV-R-PGUARD-FERM-4',
      name: 'Zero Offset Kit',
      style: 'Kit',
      description: '',
      status: 'active',
      pricing_mode: 'locked',
      locked_price: 25,
      service_fee: 0,
      materials_fee: 0,
      schedule_id: 'SV-FS-ZERO',
      ingredients: []
    };
  }
  function freshRecipeNegativeOffset() {
    return {
      recipe_id: 'SV-R-PGUARD-FERM-5',
      name: 'Negative Offset Kit',
      style: 'Kit',
      description: '',
      status: 'active',
      pricing_mode: 'locked',
      locked_price: 15,
      service_fee: 0,
      materials_fee: 0,
      schedule_id: 'SV-FS-NEG',
      ingredients: []
    };
  }

  beforeEach(function () {
    OLD_API_SECRET_KEY = process.env.API_SECRET_KEY;
    OLD_APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
    OLD_APPS_SCRIPT_SERVER_TOKEN = process.env.APPS_SCRIPT_SERVER_TOKEN;
    process.env.API_SECRET_KEY = TEST_KEY;
    process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'test-token';

    mocks = resetAndLoadRecipes();
    mocks.cache.set.mockResolvedValue(true);
    mocks.cache.del.mockResolvedValue(true);
  });

  afterEach(function () {
    process.env.API_SECRET_KEY = OLD_API_SECRET_KEY;
    process.env.APPS_SCRIPT_URL = OLD_APPS_SCRIPT_URL;
    process.env.APPS_SCRIPT_SERVER_TOKEN = OLD_APPS_SCRIPT_SERVER_TOKEN;
  });

  // cache.get is a single shared mock across every Redis key this route
  // touches (the recipe-list key AND sv:ferm-schedules) — branch by key so
  // the recipe-list lookup misses (forcing the Apps Script path) while the
  // schedules lookup hits with the fixture.
  function mockRecipesCacheMissFermSchedulesHit(schedules) {
    mocks.cache.get.mockImplementation(function (key) {
      if (key === 'sv:ferm-schedules') return Promise.resolve(schedules);
      return Promise.resolve(null);
    });
  }

  test('ferment_days present when derivable: max non-packaging offset 21', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshRecipeScheduled()], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: {} }).then(function (res) {
      expect(res._body.recipes[0].ferment_days).toBe(21);
    });
  });

  test("key entirely absent when schedule_id is '' (not null, not 0)", function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshRecipeNoSchedule()], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: {} }).then(function (res) {
      expect(res._body.recipes[0]).not.toHaveProperty('ferment_days');
    });
  });

  test('key entirely absent when schedule_id matches no schedule', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshRecipeUnknownSchedule()], total: 1 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: {} }).then(function (res) {
      expect(res._body.recipes[0]).not.toHaveProperty('ferment_days');
    });
  });

  test('key entirely absent when the schedule yields a 0 or negative offset', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipes: [freshRecipeZeroOffset(), freshRecipeNegativeOffset()], total: 2 } }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'active' }, headers: {} }).then(function (res) {
      res._body.recipes.forEach(function (r) {
        expect(r).not.toHaveProperty('ferment_days');
      });
    });
  });

  test('negative sweep: anonymous response never contains schedule_id, steps, steps_parsed or is_transfer', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    mocks.axios.post.mockResolvedValue({
      data: {
        ok: true,
        data: {
          recipes: [
            freshRecipeScheduled(),
            freshRecipeNoSchedule(),
            freshRecipeUnknownSchedule(),
            freshRecipeZeroOffset(),
            freshRecipeNegativeOffset()
          ],
          total: 5
        }
      }
    });
    return callHandler('GET', '/api/recipes', { query: { status: 'all' }, headers: {} }).then(function (res) {
      var serialized = JSON.stringify(res._body);
      ['schedule_id', 'steps_parsed', '"steps"', 'is_transfer'].forEach(function (forbidden) {
        expect(serialized.indexOf(forbidden)).toBe(-1);
      });
    });
  });

  test('anonymous detail: the same derivation/omission rules apply to a single recipe', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    var recipe = freshRecipeScheduled();
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipe: recipe, ingredients: [] } }
    });
    return callHandler('GET', '/api/recipes/:id', { params: { id: recipe.recipe_id }, headers: {} }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.recipe.ferment_days).toBe(21);
      expect(res._body.recipe).not.toHaveProperty('schedule_id');
    });
  });

  test('anonymous detail: no ferment_days key when the recipe has no schedule_id', function () {
    mockRecipesCacheMissFermSchedulesHit(FERM_SCHEDULES_FIXTURE);
    var recipe = freshRecipeNoSchedule();
    mocks.axios.post.mockResolvedValue({
      data: { ok: true, data: { recipe: recipe, ingredients: [] } }
    });
    return callHandler('GET', '/api/recipes/:id', { params: { id: recipe.recipe_id }, headers: {} }).then(function (res) {
      expect(res._status).toBe(200);
      expect(res._body.recipe).not.toHaveProperty('ferment_days');
    });
  });
});

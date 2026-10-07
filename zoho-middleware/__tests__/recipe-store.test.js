'use strict';

jest.mock('axios');
jest.mock('../lib/db', function () {
  return {
    withTransaction: jest.fn(function (fn) { return fn({ fake: true }); }),
    isConfigured: jest.fn(function () { return true; })
  };
});
jest.mock('../lib/recipe-pg', function () {
  return {
    listRecipes: jest.fn(),
    getRecipe: jest.fn(),
    createRecipe: jest.fn(),
    updateRecipe: jest.fn(),
    deleteRecipe: jest.fn()
  };
});
jest.mock('../lib/recipe-mirror', function () {
  return { schedule: jest.fn() };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});

var axios = require('axios');
var db = require('../lib/db');
var recipePg = require('../lib/recipe-pg');
var recipeMirror = require('../lib/recipe-mirror');
var store = require('../lib/recipe-store');

var URL = 'https://script.example/exec';
var OPTS = { headers: { 'Content-Type': 'application/json' }, timeout: 15000, maxRedirects: 5 };

beforeEach(function () {
  jest.clearAllMocks();
  axios.post.mockReset();
  recipeMirror.schedule.mockReset();
  process.env.APPS_SCRIPT_URL = URL;
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  delete process.env.RECIPES_STORE;
  db.withTransaction.mockImplementation(function (fn) { return fn({ fake: true }); });
});

afterEach(function () { delete process.env.RECIPES_STORE; });

describe('getMode / isConfigured', function () {
  test('reflects env changes between calls', function () {
    expect(store.getMode()).toBe('sheets');
    process.env.RECIPES_STORE = 'dual';
    expect(store.getMode()).toBe('dual');
    process.env.RECIPES_STORE = 'postgres';
    expect(store.getMode()).toBe('postgres');
  });

  test('sheets needs Apps Script env, others need db', function () {
    expect(store.isConfigured()).toBe(true);
    delete process.env.APPS_SCRIPT_URL;
    expect(store.isConfigured()).toBe(false);
    process.env.RECIPES_STORE = 'postgres';
    expect(store.isConfigured()).toBe(true);
    db.isConfigured.mockReturnValueOnce(false);
    expect(store.isConfigured()).toBe(false);
  });
});

describe('reads', function () {
  test('sheets list issues the exact Apps Script call', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, data: { recipes: [] } } });
    var out = await store.list({ status: 'all', limit: 0, offset: 0 });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      URL,
      JSON.stringify({ status: 'all', limit: 0, offset: 0, action: 'get_recipes', server_token: 'tok' }),
      OPTS
    );
    expect(out).toEqual({ ok: true, data: { recipes: [] } });
  });

  test('sheets get issues get_recipe and returns the body untouched', async function () {
    var body = { ok: true, data: { ok: false, error: 'x' } };
    axios.post.mockResolvedValue({ data: body });
    var out = await store.get('R1');
    expect(axios.post).toHaveBeenCalledWith(
      URL, JSON.stringify({ recipe_id: 'R1', action: 'get_recipe', server_token: 'tok' }), OPTS);
    expect(out).toBe(body);
  });

  test('sheets rejects when Apps Script is not configured', async function () {
    delete process.env.APPS_SCRIPT_URL;
    await expect(store.list({})).rejects.toThrow('Apps Script not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  ['dual', 'postgres'].forEach(function (mode) {
    describe(mode, function () {
      beforeEach(function () { process.env.RECIPES_STORE = mode; });

      test('list wraps recipe-pg data, no axios', async function () {
        recipePg.listRecipes.mockResolvedValue({ recipes: [{ recipe_id: 'a' }], total: 1, filtered: 1 });
        var out = await store.list({ status: 'all', limit: 5, offset: 0 });
        expect(out).toEqual({ ok: true, data: { recipes: [{ recipe_id: 'a' }], total: 1, filtered: 1 } });
        expect(recipePg.listRecipes).toHaveBeenCalledWith({ fake: true }, { status: 'all', limit: 5, offset: 0 });
        expect(axios.post).not.toHaveBeenCalled();
      });

      test('get returns envelope and not_found', async function () {
        recipePg.getRecipe.mockResolvedValueOnce({ recipe: { recipe_id: 'a' }, ingredients: [1] });
        expect(await store.get('a')).toEqual({ ok: true, data: { recipe: { recipe_id: 'a' }, ingredients: [1] } });
        recipePg.getRecipe.mockResolvedValueOnce(null);
        expect(await store.get('zz')).toEqual({ ok: false, error: 'not_found', message: 'Recipe not found' });
        expect(axios.post).not.toHaveBeenCalled();
      });

      test('db failure propagates with no sheet fallback', async function () {
        db.withTransaction.mockRejectedValue(new Error('db down'));
        await expect(store.list({})).rejects.toThrow('db down');
        await expect(store.get('a')).rejects.toThrow('db down');
        expect(axios.post).not.toHaveBeenCalled();
      });

      test('getFromSheet still hits Apps Script get_recipe', async function () {
        axios.post.mockResolvedValue({ data: { ok: true } });
        await store.getFromSheet('R9');
        expect(axios.post).toHaveBeenCalledWith(
          URL, JSON.stringify({ recipe_id: 'R9', action: 'get_recipe', server_token: 'tok' }), OPTS);
      });
    });
  });
});

describe('writes', function () {
  test('sheets create/update/remove forward payload exactly; no mirror, no ref count', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    await store.create({ name: 'A' });
    await store.update({ recipe_id: 'R1', name: 'B' }, { expectedUpdatedAt: 'T' });
    await store.remove('R1', { expectedUpdatedAt: 'T' });
    var bodies = axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
    expect(bodies[0]).toEqual({ name: 'A', action: 'create_recipe', server_token: 'tok' });
    expect(bodies[1]).toEqual({ recipe_id: 'R1', name: 'B', action: 'update_recipe', server_token: 'tok' });
    expect(bodies[2]).toEqual({ recipe_id: 'R1', action: 'delete_recipe', server_token: 'tok' });
    expect(bodies.length).toBe(3);
    expect(recipeMirror.schedule).not.toHaveBeenCalled();
    expect(recipePg.createRecipe).not.toHaveBeenCalled();
  });

  ['dual', 'postgres'].forEach(function (mode) {
    describe(mode, function () {
      beforeEach(function () { process.env.RECIPES_STORE = mode; });

      test('create strips internals and schedules mirror after the transaction', async function () {
        var order = [];
        db.withTransaction.mockImplementation(function (fn) {
          return Promise.resolve(fn({ fake: true })).then(function (r) { order.push('tx'); return r; });
        });
        recipeMirror.schedule.mockImplementation(function () { order.push('schedule'); });
        recipePg.createRecipe.mockResolvedValue({ ok: true, recipe_id: 'R1', ingredients_created: 2, _recipeId: 'R1' });
        var out = await store.create({ name: 'A' });
        expect(out).toEqual({ ok: true, recipe_id: 'R1', ingredients_created: 2 });
        expect(recipePg.createRecipe.mock.calls[0][2].actor).toBe('middleware');
        expect(recipePg.createRecipe.mock.calls[0][2].now).toBeInstanceOf(Date);
        expect(recipeMirror.schedule).toHaveBeenCalledWith('R1');
        expect(order).toEqual(['tx', 'schedule']);
      });

      test('create invalid_data passes through with no mirror', async function () {
        recipePg.createRecipe.mockResolvedValue({ ok: false, error: 'invalid_data', message: 'bad' });
        expect(await store.create({ name: 'A' })).toEqual({ ok: false, error: 'invalid_data', message: 'bad' });
        expect(recipeMirror.schedule).not.toHaveBeenCalled();
      });

      test('update passes expectedUpdatedAt; stale does not schedule', async function () {
        recipePg.updateRecipe.mockResolvedValueOnce({ ok: true, _recipeId: 'R1', _ingredientsRewritten: false });
        expect(await store.update({ recipe_id: 'R1' }, { expectedUpdatedAt: 'T' })).toEqual({ ok: true });
        expect(recipePg.updateRecipe.mock.calls[0][2].expectedUpdatedAt).toBe('T');
        expect(recipeMirror.schedule).toHaveBeenCalledWith('R1');
        recipeMirror.schedule.mockClear();
        recipePg.updateRecipe.mockResolvedValueOnce({ ok: false, error: 'stale_recipe', message: 'm' });
        expect((await store.update({ recipe_id: 'R1' }, { expectedUpdatedAt: 'old' })).error).toBe('stale_recipe');
        expect(recipeMirror.schedule).not.toHaveBeenCalled();
      });

      test('remove checks batch refs before the transaction and schedules', async function () {
        axios.post.mockResolvedValue({ data: { ok: true, count: 2 } });
        recipePg.deleteRecipe.mockResolvedValue({ ok: true, deactivated: true, message: 'x', _recipeId: 'R1' });
        var out = await store.remove('R1', { expectedUpdatedAt: 'T' });
        expect(out).toEqual({ ok: true, deactivated: true, message: 'x' });
        expect(JSON.parse(axios.post.mock.calls[0][1]).action).toBe('recipe_batch_ref_count');
        var o = recipePg.deleteRecipe.mock.calls[0][2];
        expect(o.batchRefCount).toBe(2);
        expect(o.expectedUpdatedAt).toBe('T');
        expect(recipeMirror.schedule).toHaveBeenCalledWith('R1');
      });

      test('remove fails closed when Apps Script is unavailable or malformed', async function () {
        var bad = [
          function () { axios.post.mockRejectedValue(new Error('net')); },
          function () { axios.post.mockResolvedValue({ data: { ok: false } }); },
          function () { axios.post.mockResolvedValue({ data: { ok: true, count: 'x' } }); }
        ];
        for (var i = 0; i < bad.length; i++) {
          bad[i]();
          await expect(store.remove('R1', {})).rejects.toMatchObject({ code: 'batch_ref_unavailable' });
        }
        expect(recipePg.deleteRecipe).not.toHaveBeenCalled();
        expect(db.withTransaction).not.toHaveBeenCalled();
      });

      test('mirror throwing never fails a saved write', async function () {
        recipeMirror.schedule.mockImplementation(function () { throw new Error('boom'); });
        recipePg.createRecipe.mockResolvedValue({ ok: true, recipe_id: 'R1', _recipeId: 'R1' });
        expect(await store.create({ name: 'A' })).toEqual({ ok: true, recipe_id: 'R1' });
      });
    });
  });

  test('hasBatchReferences returns the count', async function () {
    axios.post.mockResolvedValue({ data: { ok: true, count: 0 } });
    expect(await store.hasBatchReferences('R1')).toBe(0);
  });
});

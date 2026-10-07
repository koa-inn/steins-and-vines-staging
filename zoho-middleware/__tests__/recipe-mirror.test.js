'use strict';

// ---------------------------------------------------------------------------
// Tests for lib/recipe-mirror.js — Phase 85 Plan 05 (DB-04, D-01/D-02).
//
// Mocked: sheet-mirror (production gate), cache (in-memory store), db,
// recipe-pg, axios, sentry-capture, logger. Backoff uses jest fake timers.
// ---------------------------------------------------------------------------

var mockMirror = { enabled: true };
var mockStore = {};

jest.mock('axios');

jest.mock('../lib/sheet-mirror', function () {
  return {
    isMirrorEnabled: jest.fn(function () { return mockMirror.enabled; }),
    mirrorFireAndForget: jest.fn(function (label, fn) {
      if (!mockMirror.enabled) return undefined;
      try {
        var r = fn();
        if (r && typeof r.then === 'function') r.catch(function () {});
      } catch (e) { /* swallowed like the real gate */ }
      return undefined;
    })
  };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(function (key) {
      return Promise.resolve(Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : null);
    }),
    set: jest.fn(function (key, value) { mockStore[key] = value; return Promise.resolve(); }),
    del: jest.fn(function (key) { delete mockStore[key]; return Promise.resolve(); }),
    isConnected: jest.fn(function () { return true; }),
    getClient: jest.fn(function () {
      return Promise.resolve({
        keys: jest.fn(function (pattern) {
          var prefix = pattern.replace('*', '');
          return Promise.resolve(Object.keys(mockStore).filter(function (k) { return k.indexOf(prefix) === 0; }));
        })
      });
    })
  };
});

jest.mock('../lib/db', function () {
  return {
    withTransaction: jest.fn(function (fn) { return fn({}); })
  };
});

jest.mock('../lib/recipe-pg', function () {
  return { getRecipe: jest.fn() };
});

jest.mock('../lib/sentry-capture', function () {
  return { captureExceptionSafe: jest.fn() };
});

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var axios = require('axios');
var cache = require('../lib/cache');
var recipePg = require('../lib/recipe-pg');
var sentryCapture = require('../lib/sentry-capture');
var log = require('../lib/logger');
var recipeMirror = require('../lib/recipe-mirror');

var ID = 'SV-R-000004';
var KEY = 'recipe:mirror-dirty:' + ID;

function stateFor(name) {
  return { recipe: { recipe_id: ID, name: name }, ingredients: [{ ingredient_id: 'I1', recipe_id: ID }] };
}

function flush() {
  return jest.advanceTimersByTimeAsync(0);
}

function sentBodies() {
  return axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
}

beforeEach(function () {
  jest.useFakeTimers();
  mockMirror.enabled = true;
  Object.keys(mockStore).forEach(function (k) { delete mockStore[k]; });
  jest.clearAllMocks();
  process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  recipePg.getRecipe.mockResolvedValue(stateFor('A'));
  axios.post.mockResolvedValue({ data: { ok: true } });
});

afterEach(function () {
  jest.useRealTimers();
});

describe('schedule — production gate', function () {
  it('sets no marker and makes no axios call when the mirror is disabled', async function () {
    mockMirror.enabled = false;
    expect(recipeMirror.schedule(ID)).toBeUndefined();
    await flush();
    expect(cache.set).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('sets the marker (30-day TTL) and posts mirror_recipe_state when enabled', async function () {
    var seenMarker;
    axios.post.mockImplementation(function () {
      seenMarker = mockStore[KEY];
      return Promise.resolve({ data: { ok: true } });
    });
    recipeMirror.schedule(ID);
    await flush();
    expect(cache.set).toHaveBeenCalledWith(KEY, expect.objectContaining({ token: expect.any(String), set_at: expect.any(String) }), 30 * 24 * 60 * 60);
    expect(seenMarker).toBeDefined();
    var bodies = sentBodies();
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]).sort()).toEqual(['action', 'ingredients', 'recipe', 'server_token']);
    expect(bodies[0].action).toBe('mirror_recipe_state');
    expect(bodies[0].recipe.recipe_id).toBe(ID);
    expect(bodies[0].ingredients).toHaveLength(1);
    expect(mockStore[KEY]).toBeUndefined(); // cleared on success
  });
});

describe('read-latest-at-send and delete', function () {
  it('sends the state present at send time, not at schedule time', async function () {
    recipePg.getRecipe.mockResolvedValue(stateFor('OLD'));
    // change the stub between schedule() and the actual (asynchronous) read
    recipeMirror.schedule(ID);
    recipePg.getRecipe.mockResolvedValue(stateFor('NEW'));
    await flush();
    expect(sentBodies()[0].recipe.name).toBe('NEW');
  });

  it('posts mirror_recipe_delete {recipe_id} when the recipe is gone', async function () {
    recipePg.getRecipe.mockResolvedValue(null);
    recipeMirror.schedule(ID);
    await flush();
    var bodies = sentBodies();
    expect(Object.keys(bodies[0]).sort()).toEqual(['action', 'recipe_id', 'server_token']);
    expect(bodies[0].action).toBe('mirror_recipe_delete');
    expect(bodies[0].recipe_id).toBe(ID);
  });
});

describe('ordering and marker token', function () {
  it('keeps the marker when a newer schedule() re-set it mid-send, then sends again', async function () {
    var release;
    var first = true;
    axios.post.mockImplementation(function () {
      if (first) {
        first = false;
        return new Promise(function (resolve) { release = function () { resolve({ data: { ok: true } }); }; });
      }
      return Promise.resolve({ data: { ok: true } });
    });
    recipeMirror.schedule(ID);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(1);
    recipePg.getRecipe.mockResolvedValue(stateFor('B'));
    recipeMirror.schedule(ID); // re-sets marker with a new token
    await flush();
    release();
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(sentBodies()[1].recipe.name).toBe('B');
    expect(mockStore[KEY]).toBeUndefined(); // newest send cleared the newest token
  });

  it('never runs two sends for one recipe concurrently; final send carries latest state', async function () {
    var inflight = 0;
    var maxInflight = 0;
    var releases = [];
    axios.post.mockImplementation(function () {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise(function (resolve) {
        releases.push(function () { inflight--; resolve({ data: { ok: true } }); });
      });
    });
    recipeMirror.schedule(ID);
    recipeMirror.schedule(ID);
    await flush();
    recipePg.getRecipe.mockResolvedValue(stateFor('LATEST'));
    expect(releases).toHaveLength(1);
    releases[0]();
    await flush();
    expect(releases).toHaveLength(2);
    releases[1]();
    await flush();
    expect(maxInflight).toBe(1);
    var bodies = sentBodies();
    expect(bodies[bodies.length - 1].recipe.name).toBe('LATEST');
  });
});

describe('failure, retry and alerting', function () {
  it('retries after 2 s, 10 s, 60 s, 5 min then raises one Sentry error; marker remains', async function () {
    axios.post.mockRejectedValue(new Error('boom'));
    recipeMirror.schedule(ID);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1999);
    expect(axios.post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(axios.post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10000);
    expect(axios.post).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60000);
    expect(axios.post).toHaveBeenCalledTimes(4);
    expect(sentryCapture.captureExceptionSafe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(300000);
    expect(axios.post).toHaveBeenCalledTimes(5);
    expect(sentryCapture.captureExceptionSafe).toHaveBeenCalledTimes(1);
    expect(sentryCapture.captureExceptionSafe).toHaveBeenCalledWith(
      expect.any(Error),
      { level: 'error', tags: { component: 'recipes-mirror', recipe_id: ID } }
    );
    expect(mockStore[KEY]).toBeDefined();
    await jest.advanceTimersByTimeAsync(600000);
    expect(axios.post).toHaveBeenCalledTimes(5);
  });

  it('treats an Apps Script {ok:false} response as a failure', async function () {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'nope' } });
    recipeMirror.schedule(ID);
    await flush();
    expect(mockStore[KEY]).toBeDefined();
    await expect(recipeMirror.mirrorLatest(ID)).rejects.toThrow(/nope/);
  });

  it('schedule never throws and returns undefined when cache.set rejects or getRecipe throws', async function () {
    cache.set.mockRejectedValueOnce(new Error('redis down'));
    recipePg.getRecipe.mockRejectedValue(new Error('pg down'));
    var result;
    expect(function () { result = recipeMirror.schedule(ID); }).not.toThrow();
    expect(result).toBeUndefined();
    await flush();
  });

  it('logs recipe_id only (no recipe content) on failure', async function () {
    recipePg.getRecipe.mockResolvedValue({ recipe: { recipe_id: ID, name: 'SECRET-NAME', created_by: 'x@y.z' }, ingredients: [] });
    axios.post.mockRejectedValue(new Error('boom'));
    recipeMirror.schedule(ID);
    await jest.advanceTimersByTimeAsync(400000);
    var logged = JSON.stringify(log.warn.mock.calls.concat(log.error.mock.calls));
    expect(logged).toContain(ID);
    expect(logged).not.toContain('SECRET-NAME');
    expect(logged).not.toContain('x@y.z');
  });
});

describe('isDirty', function () {
  it('is true when the marker exists, false when absent', async function () {
    mockStore[KEY] = { token: 't' };
    expect(await recipeMirror.isDirty(ID)).toBe(true);
    delete mockStore[KEY];
    expect(await recipeMirror.isDirty(ID)).toBe(false);
  });

  it('is false when cache.get rejects', async function () {
    cache.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await recipeMirror.isDirty(ID)).toBe(false);
  });
});

describe('timers', function () {
  it('unrefs the backoff timer', async function () {
    var spy = jest.spyOn(global, 'setTimeout');
    axios.post.mockRejectedValue(new Error('boom'));
    recipeMirror.schedule(ID);
    await flush();
    var results = spy.mock.results.map(function (r) { return r.value; });
    var retryTimers = spy.mock.calls
      .map(function (c, i) { return { delay: c[1], timer: results[i] }; })
      .filter(function (t) { return t.delay === 2000; });
    expect(retryTimers.length).toBeGreaterThan(0);
    retryTimers.forEach(function (t) {
      expect(typeof t.timer.hasRef).toBe('function');
      expect(t.timer.hasRef()).toBe(false);
    });
    spy.mockRestore();
  });
});

'use strict';

/**
 * Tests for scripts/backfill/recipes-replay-to-sheet.js - Phase 85 Plan 11 (DB-04, D-02).
 * Fake pool + mocked axios: no real database or HTTP call is ever made.
 */

jest.mock('axios');

var axios = require('axios');
var replay = require('../../scripts/backfill/recipes-replay-to-sheet');
var buildReplayPayloads = replay.buildReplayPayloads;
var runReplay = replay.runReplay;
var parseArgs = replay.parseArgs;
var EXIT = replay.EXIT;

function state(id) {
  return {
    recipe: { recipe_id: id, name: 'N' },
    ingredients: [{ ingredient_id: 'RI-1', recipe_id: id, item_id: 'A', item_name: 'a', quantity: 1, unit: 'kg' }]
  };
}

function fakePool(ids) {
  var queries = [];
  var client = {
    query: jest.fn(function (sql, params) {
      queries.push(sql);
      if (/^begin transaction read only$/.test(sql) || /^commit$/.test(sql) || /^rollback$/.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/select recipe_id from recipes order by recipe_id/.test(sql)) {
        return Promise.resolve({ rows: ids.map(function (i) { return { recipe_id: i }; }) });
      }
      if (/from recipe_ingredients/.test(sql)) {
        return Promise.resolve({ rows: [{ ingredient_id: 'RI-1', recipe_id: params[0], item_id: 'A', item_name: 'a', quantity: '1', unit: 'kg' }] });
      }
      if (/from recipes where recipe_id/.test(sql)) {
        return Promise.resolve({ rows: [{ recipe_id: params[0], name: 'N', status: 'active', created_at: new Date(0), updated_at: new Date(0) }] });
      }
      return Promise.reject(new Error('unexpected query: ' + sql));
    }),
    release: jest.fn()
  };
  return { queries: queries, client: client, connect: jest.fn(function () { return Promise.resolve(client); }) };
}

describe('buildReplayPayloads', function () {
  it('emits one {recipe, ingredients} payload per recipe in id order', function () {
    var out = buildReplayPayloads([state('SV-R-000002'), state('SV-R-000001')]);
    expect(out.map(function (p) { return p.recipe_id; })).toEqual(['SV-R-000001', 'SV-R-000002']);
    expect(Object.keys(out[0].payload)).toEqual(['recipe', 'ingredients']);
    expect(out[0].payload.ingredients).toHaveLength(1);
  });
});

describe('parseArgs', function () {
  it('defaults to dry run, accepts --apply, refuses URLs and unknown flags', function () {
    expect(parseArgs([]).apply).toBe(false);
    expect(parseArgs(['--apply']).apply).toBe(true);
    expect(function () { parseArgs(['postgres://u:p@h/d']); }).toThrow(/BACKFILL_DATABASE_URL/);
    expect(function () { parseArgs(['--x']); }).toThrow(/unknown flag/);
  });
});

describe('runReplay', function () {
  var saved;
  beforeEach(function () {
    saved = { u: process.env.APPS_SCRIPT_URL, t: process.env.APPS_SCRIPT_SERVER_TOKEN };
    process.env.APPS_SCRIPT_URL = 'https://script.example.test/exec';
    process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
    axios.post.mockReset();
  });
  afterEach(function () {
    if (saved.u === undefined) delete process.env.APPS_SCRIPT_URL; else process.env.APPS_SCRIPT_URL = saved.u;
    if (saved.t === undefined) delete process.env.APPS_SCRIPT_SERVER_TOKEN; else process.env.APPS_SCRIPT_SERVER_TOKEN = saved.t;
  });

  it('dry run makes no HTTP call', async function () {
    var lines = [];
    var r = await runReplay({ apply: false }, { pool: fakePool(['SV-R-000001', 'SV-R-000002']), axios: axios, log: function (m) { lines.push(m); } });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(axios.post).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/2 recipe/);
  });

  it('--apply posts mirror_recipe_state per recipe with the token', async function () {
    axios.post.mockResolvedValue({ data: { ok: true } });
    var r = await runReplay({ apply: true }, { pool: fakePool(['SV-R-000001', 'SV-R-000002']), axios: axios, log: function () {} });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(axios.post).toHaveBeenCalledTimes(2);
    var body = JSON.parse(axios.post.mock.calls[0][1]);
    expect(body.action).toBe('mirror_recipe_state');
    expect(body.server_token).toBe('tok');
    expect(body.recipe.recipe_id).toBe('SV-R-000001');
    expect(body.ingredients[0].quantity).toBe(1);
  });

  it('stops at the first {ok:false} and names the recipe', async function () {
    axios.post.mockResolvedValueOnce({ data: { ok: false, error: 'boom' } });
    var lines = [];
    var r = await runReplay({ apply: true }, { pool: fakePool(['SV-R-000001', 'SV-R-000002']), axios: axios, log: function (m) { lines.push(m); } });
    expect(r.exitCode).not.toBe(EXIT.OK);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/SV-R-000001/);
  });

  it('errors without Apps Script env when --apply', async function () {
    delete process.env.APPS_SCRIPT_URL;
    var r = await runReplay({ apply: true }, { pool: fakePool(['SV-R-000001']), axios: axios, log: function () {} });
    expect(r.exitCode).toBe(EXIT.ERROR);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

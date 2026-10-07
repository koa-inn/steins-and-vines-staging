'use strict';

/**
 * Phase 85 recipe store facade. Copy of the gift-card-store SHAPE, not its dual
 * semantics: the dual sheet leg is a state copy (recipe-mirror) plus a live price
 * compare in pos-recipe (D-05), never an Apps Script re-run. Postgres is
 * authoritative in dual and postgres; never falls back to a sheet read.
 *
 * Modes (RECIPES_STORE, resolved per call):
 *   sheets   - exact Apps Script axios.post the routes performed before Phase 85
 *              (D-04 last-save-wins; resp.data returned untouched)
 *   dual     - Postgres authoritative, successful writes schedule the D-01 mirror
 *   postgres - same as dual
 *
 * Envelope shapes match Apps Script so route changes are one-line swaps. Postgres
 * validation failures come back as {ok:false, error:'invalid_data'|'missing_fields'|
 * 'missing_id'|'not_found'|'stale_recipe', message} - callers map these to 4xx/409,
 * they are never thrown. Only infrastructure failures reject.
 *
 * Deliberately does NOT require ./constants (the route tests mock it partially).
 */

var axios = require('axios');
var storeFlag = require('./store-flag');
var db = require('./db');
var recipePg = require('./recipe-pg');
var recipeMirror = require('./recipe-mirror');
var log = require('./logger');

// ─── mode / config ───────────────────────────────────────────────────────

function getMode() {
  return storeFlag.resolveStoreMode('RECIPES_STORE');
}

function isConfigured() {
  if (getMode() === 'sheets') {
    return !!(process.env.APPS_SCRIPT_URL && process.env.APPS_SCRIPT_SERVER_TOKEN);
  }
  return db.isConfigured();
}

// ─── Apps Script transport (copy of routes/recipes.js callAppsScriptPost) ─

function callAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    log.warn('[recipes] APPS_SCRIPT_URL or APPS_SCRIPT_SERVER_TOKEN not configured');
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return axios.post(url, JSON.stringify(Object.assign({}, payload, {
    action: action,
    server_token: token
  })), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    maxRedirects: 5
  }).then(function (resp) {
    return resp.data;
  });
}

// ─── Postgres transport ───────────────────────────────────────────────────

function runPg(fn) {
  return db.withTransaction(fn);
}

/** Removes underscore-prefixed internals (_recipeId, ...) recipe-pg attaches to write results. */
function strip(result) {
  if (!result || typeof result !== 'object') return result;
  var out = {};
  Object.keys(result).forEach(function (key) {
    if (key.charAt(0) !== '_') out[key] = result[key];
  });
  return out;
}

// ─── reads ────────────────────────────────────────────────────────────────

function list(opts) {
  opts = opts || {};
  if (getMode() === 'sheets') {
    return callAppsScript('get_recipes', {
      status: opts.status,
      limit: opts.limit,
      offset: opts.offset
    });
  }
  return runPg(function (client) {
    return recipePg.listRecipes(client, opts);
  }).then(function (data) {
    return { ok: true, data: data };
  });
}

function get(recipeId) {
  if (getMode() === 'sheets') {
    return callAppsScript('get_recipe', { recipe_id: recipeId });
  }
  return runPg(function (client) {
    return recipePg.getRecipe(client, recipeId);
  }).then(function (found) {
    if (!found) return { ok: false, error: 'not_found', message: 'Recipe not found' };
    return { ok: true, data: { recipe: found.recipe, ingredients: found.ingredients } };
  });
}

/** Always the Apps Script get_recipe path, any mode (D-05 price comparison input). */
function getFromSheet(recipeId) {
  return callAppsScript('get_recipe', { recipe_id: recipeId });
}

// ─── writes ───────────────────────────────────────────────────────────────

/** D-01: schedule the state-copy mirror after a committed save. Never fails the save. */
function scheduleMirror(raw) {
  if (!raw || !raw.ok) return;
  try {
    recipeMirror.schedule(raw._recipeId);
  } catch (err) {
    log.warn('[recipes] mirror schedule failed recipe=' + raw._recipeId + ': ' +
      ((err && err.message) || String(err)));
  }
}

function finish(raw) {
  scheduleMirror(raw);
  return strip(raw);
}

function create(payload) {
  if (getMode() === 'sheets') return callAppsScript('create_recipe', payload);
  return runPg(function (client) {
    return recipePg.createRecipe(client, payload, { actor: 'middleware', now: new Date() });
  }).then(finish);
}

function update(payload, opts) {
  if (getMode() === 'sheets') return callAppsScript('update_recipe', payload);
  opts = opts || {};
  return runPg(function (client) {
    return recipePg.updateRecipe(client, payload, {
      expectedUpdatedAt: opts.expectedUpdatedAt,
      now: new Date()
    });
  }).then(finish);
}

/**
 * Batch reference count from Apps Script (also on staging; read-only). Seam: Phase 87
 * replaces the body with SQL. Rejects with err.code 'batch_ref_unavailable' on any
 * transport or shape failure so delete fails closed.
 */
function hasBatchReferences(recipeId) {
  function unavailable(reason) {
    var err = new Error('Batch reference check unavailable: ' + reason);
    err.code = 'batch_ref_unavailable';
    return err;
  }
  return callAppsScript('recipe_batch_ref_count', { recipe_id: recipeId }).then(function (body) {
    if (!body || body.ok !== true || typeof body.count !== 'number' || !isFinite(body.count)) {
      throw unavailable('unexpected response');
    }
    return body.count;
  }, function (err) {
    throw unavailable((err && err.message) || String(err));
  });
}

function remove(recipeId, opts) {
  if (getMode() === 'sheets') return callAppsScript('delete_recipe', { recipe_id: recipeId });
  opts = opts || {};
  return hasBatchReferences(recipeId).then(function (count) {
    return runPg(function (client) {
      return recipePg.deleteRecipe(client, recipeId, {
        expectedUpdatedAt: opts.expectedUpdatedAt,
        batchRefCount: count,
        now: new Date()
      });
    });
  }).then(finish);
}

module.exports = {
  getMode: getMode,
  isConfigured: isConfigured,
  list: list,
  get: get,
  getFromSheet: getFromSheet,
  create: create,
  update: update,
  remove: remove,
  hasBatchReferences: hasBatchReferences
};

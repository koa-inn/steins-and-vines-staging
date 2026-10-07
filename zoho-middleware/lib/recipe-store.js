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

module.exports = {
  getMode: getMode,
  isConfigured: isConfigured,
  list: list,
  get: get,
  getFromSheet: getFromSheet
};

// Internal helpers shared with the write half (Task 2).
module.exports._internal = {
  callAppsScript: callAppsScript,
  runPg: runPg,
  strip: strip
};

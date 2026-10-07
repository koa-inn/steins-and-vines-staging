'use strict';

/**
 * Recipe sheet mirror worker — Phase 85 (DB-04, D-01/D-02).
 *
 * After a Postgres recipe save, copies the CURRENT Postgres state of the
 * recipe (read at send time) onto the production Google Sheet via the
 * mirror_recipe_state / mirror_recipe_delete Apps Script actions.
 *
 *  - Production-only: all work runs inside sheetMirror.mirrorFireAndForget
 *    (Phase 83 D-07), so staging sets no marker and makes no Apps Script call.
 *  - Never on the request path, never fails a save: schedule() returns
 *    undefined and never throws.
 *  - Ordered: one serial promise chain per recipe + read-latest-at-send.
 *  - Durable: a per-recipe Redis dirty marker survives redeploys; a
 *    5-minute sweep re-drives every surviving marker.
 *  - Retries with backoff (2 s, 10 s, 60 s, 5 min), then Sentry error.
 *
 * Logs and Sentry tags carry the recipe id only (no names / created_by).
 */

var axios = require('axios');
var log = require('./logger');
var cache = require('./cache');
var db = require('./db');
var recipePg = require('./recipe-pg');
var sheetMirror = require('./sheet-mirror');
var sentryCapture = require('./sentry-capture');

var DIRTY_PREFIX = 'recipe:mirror-dirty:';
var RETRY_DELAYS_MS = [2000, 10000, 60000, 300000];
var MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
var APPS_SCRIPT_TIMEOUT_MS = 30000;
var SWEEP_ALERT_INTERVAL_MS = 60 * 60 * 1000;

// Per-recipe tail-promise chain: sends for one recipe never run concurrently.
var recipeTails = {};
// Last Sentry alert time per recipe for sweep-driven failures.
var lastSweepAlert = {};

function markerKey(recipeId) {
  return DIRTY_PREFIX + recipeId;
}

function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function chainForRecipe(recipeId, fn) {
  var prevTail = recipeTails[recipeId] || Promise.resolve();
  var tail = prevTail.then(fn, fn);
  recipeTails[recipeId] = tail;
  function cleanup() { if (recipeTails[recipeId] === tail) delete recipeTails[recipeId]; }
  tail.then(cleanup, cleanup);
  return tail;
}

function postAppsScript(action, payload) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return Promise.resolve(
    axios.post(url, JSON.stringify(Object.assign({}, payload, {
      action: action,
      server_token: token
    })), {
      headers: { 'Content-Type': 'application/json' },
      timeout: APPS_SCRIPT_TIMEOUT_MS,
      maxRedirects: 5
    })
  ).then(function (resp) {
    var data = resp && resp.data;
    if (!data || data.ok !== true) {
      throw new Error('Apps Script ' + action + ' failed: ' +
        ((data && (data.error || data.message)) || 'ok !== true'));
    }
    return data;
  });
}

function readMarkerToken(recipeId) {
  return Promise.resolve().then(function () {
    return cache.get(markerKey(recipeId));
  }).then(function (m) {
    return m && m.token ? m.token : null;
  }, function () { return null; });
}

function clearMarkerIfUnchanged(recipeId, token) {
  if (!token) return Promise.resolve();
  return readMarkerToken(recipeId).then(function (current) {
    if (current === token) return cache.del(markerKey(recipeId));
    return undefined;
  }).catch(function () {});
}

/**
 * Copy the current Postgres state of a recipe onto the sheet. Rejects on failure.
 * @returns {Promise<{action: string, result: Object}>}
 */
function mirrorLatest(recipeId) {
  return readMarkerToken(recipeId).then(function (token) {
    return db.withTransaction(function (client) {
      return recipePg.getRecipe(client, recipeId);
    }).then(function (state) {
      var send;
      var action;
      if (!state) {
        action = 'delete';
        send = postAppsScript('mirror_recipe_delete', { recipe_id: recipeId });
      } else {
        action = 'state';
        send = postAppsScript('mirror_recipe_state', {
          recipe: state.recipe,
          ingredients: state.ingredients
        });
      }
      return send.then(function (result) {
        return clearMarkerIfUnchanged(recipeId, token).then(function () {
          return { action: action, result: result };
        });
      });
    });
  });
}

function runWithRetry(recipeId, attempt) {
  return chainForRecipe(recipeId, function () {
    return mirrorLatest(recipeId);
  }).then(function () {
    return undefined;
  }, function (err) {
    var message = (err && err.message) || String(err);
    if (attempt < RETRY_DELAYS_MS.length) {
      log.warn('[recipes-mirror] send failed recipe=' + recipeId + ' attempt=' + (attempt + 1) +
        ' — retrying in ' + RETRY_DELAYS_MS[attempt] + 'ms: ' + message);
      unrefTimer(setTimeout(function () {
        runWithRetry(recipeId, attempt + 1);
      }, RETRY_DELAYS_MS[attempt]));
      return undefined;
    }
    log.error('[recipes-mirror] persistent failure recipe=' + recipeId);
    sentryCapture.captureExceptionSafe(err instanceof Error ? err : new Error(message), {
      level: 'error',
      tags: { component: 'recipes-mirror', recipe_id: recipeId }
    });
    return undefined;
  });
}

/**
 * Mark the recipe dirty and mirror its latest state in the background.
 * Never throws; returns undefined. No-op off production.
 */
function schedule(recipeId) {
  try {
    sheetMirror.mirrorFireAndForget('recipes.mirror', function () {
      var marker = {
        token: Date.now() + '-' + Math.random().toString(36).slice(2),
        set_at: new Date().toISOString()
      };
      return Promise.resolve()
        .then(function () { return cache.set(markerKey(recipeId), marker, MARKER_TTL_SECONDS); })
        .catch(function (err) {
          log.warn('[recipes-mirror] marker write failed recipe=' + recipeId + ': ' +
            ((err && err.message) || String(err)));
        })
        .then(function () { return runWithRetry(recipeId, 0); });
    });
  } catch (err) {
    log.warn('[recipes-mirror] schedule failed recipe=' + recipeId + ': ' +
      ((err && err.message) || String(err)));
  }
  return undefined;
}

/** @returns {Promise<boolean>} true when a dirty marker exists; false on any error */
function isDirty(recipeId) {
  return Promise.resolve().then(function () {
    return cache.get(markerKey(recipeId));
  }).then(function (m) {
    return !!m;
  }, function () { return false; });
}

/**
 * Re-drive every surviving dirty marker (one attempt each, no backoff chain).
 * @returns {Promise<{scanned: number, retried: number}>}
 */
function sweep() {
  var empty = { scanned: 0, retried: 0 };
  if (!sheetMirror.isMirrorEnabled() || !cache.isConnected()) {
    return Promise.resolve(empty);
  }
  return cache.getClient().then(function (c) {
    if (!c) return null;
    return c.keys(DIRTY_PREFIX + '*');
  }).then(function (keys) {
    if (!keys || keys.length === 0) return empty;
    var retried = 0;
    var pending = [];
    keys.forEach(function (key) {
      var recipeId = String(key).slice(DIRTY_PREFIX.length);
      if (!recipeId || recipeTails[recipeId]) return; // chain already running
      retried++;
      pending.push(chainForRecipe(recipeId, function () {
        return mirrorLatest(recipeId);
      }).then(function () {
        delete lastSweepAlert[recipeId];
      }, function (err) {
        var message = (err && err.message) || String(err);
        log.warn('[recipes-mirror] sweep send failed recipe=' + recipeId + ': ' + message);
        var now = Date.now();
        if (!lastSweepAlert[recipeId] || now - lastSweepAlert[recipeId] >= SWEEP_ALERT_INTERVAL_MS) {
          lastSweepAlert[recipeId] = now;
          sentryCapture.captureExceptionSafe(err instanceof Error ? err : new Error(message), {
            level: 'error',
            tags: { component: 'recipes-mirror', recipe_id: recipeId }
          });
        }
      }));
    });
    return Promise.all(pending).then(function () {
      return { scanned: keys.length, retried: retried };
    });
  });
}

module.exports = {
  schedule: schedule,
  isDirty: isDirty,
  mirrorLatest: mirrorLatest,
  sweep: sweep,
  DIRTY_PREFIX: DIRTY_PREFIX,
  RETRY_DELAYS_MS: RETRY_DELAYS_MS
};

'use strict';

/**
 * Vessel / fermentation-schedule sheet mirror worker — Phase 86 (DB-05, D-10).
 *
 * State copy only — never re-runs Apps Script CRUD (85 D-01); staff list
 * deliberately absent (86 D-10).
 *
 * Copy of the Phase 85 recipe mirror with an entity dimension
 * (vessel | fermsched). After a Postgres change, copies the CURRENT row
 * (read at send time) onto the production sheet via mirror_vessel_state /
 * mirror_ferm_schedule_state / mirror_ferm_schedule_delete.
 *
 *  - Production-only: all work runs inside sheetMirror.mirrorFireAndForget.
 *  - Never blocks or fails a save.
 *  - Ordered: one serial promise chain per entity+id, read-latest-at-send.
 *  - Durable: per-entity-id Redis marker + 5-minute sweep.
 *  - Retries 2 s / 10 s / 60 s / 5 min, then Sentry.
 *
 * Logs and Sentry tags carry entity + id only.
 */

var axios = require('axios');
var log = require('./logger');
var cache = require('./cache');
var db = require('./db');
var vesselPg = require('./vessel-pg');
var fermSchedulePg = require('./ferm-schedule-pg');
var sheetMirror = require('./sheet-mirror');
var sentryCapture = require('./sentry-capture');

var KEY_ROOT = 'ops:mirror-dirty:';
var ENTITIES = {
  vessel: { prefix: KEY_ROOT + 'vessel:', label: 'vessels.mirror' },
  fermsched: { prefix: KEY_ROOT + 'fermsched:', label: 'fermsched.mirror' },
  batch: { prefix: KEY_ROOT + 'batch:', label: 'batches.mirror' }
};
var RETRY_DELAYS_MS = [2000, 10000, 60000, 300000];
var MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
var APPS_SCRIPT_TIMEOUT_MS = 30000;
var SWEEP_ALERT_INTERVAL_MS = 60 * 60 * 1000;

var VESSEL_FIELDS = ['vessel_id', 'label', 'type', 'material', 'capacity_liters', 'status', 'archived',
  'bottom_diameter_cm', 'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'];
var SCHEDULE_FIELDS = ['schedule_id', 'name', 'description', 'category', 'steps', 'is_active',
  'created_at', 'created_by', 'last_updated'];

var tails = {};
var lastSweepAlert = {};

function assertEntity(entity) {
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, entity)) {
    throw new Error('unknown mirror entity');
  }
}

function chainKey(entity, id) { return entity + ':' + id; }
function markerKey(entity, id) { return ENTITIES[entity].prefix + id; }

function unrefTimer(t) {
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

function pick(row, fields) {
  var out = {};
  fields.forEach(function (f) { out[f] = row[f]; });
  return out;
}

/**
 * Build the Apps Script request body (without server_token) for an entity row.
 * A null schedule row means the schedule is gone; a null vessel row is an error.
 */
function buildMirrorRequest(entity, row, id) {
  assertEntity(entity);
  if (entity === 'vessel') {
    if (!row) throw new Error('vessel not found for mirror');
    return { action: 'mirror_vessel_state', vessel: pick(row, VESSEL_FIELDS) };
  }
  if (entity === 'batch') {
    if (!row) return { action: 'mirror_batch_delete', batch_id: id };
    return {
      action: 'mirror_batch_state',
      batch: row.batch,
      tasks: row.tasks,
      readings: row.readings,
      history: row.history
    };
  }
  if (!row) return { action: 'mirror_ferm_schedule_delete', schedule_id: id };
  return { action: 'mirror_ferm_schedule_state', schedule: pick(row, SCHEDULE_FIELDS) };
}

function chainFor(entity, id, fn) {
  var k = chainKey(entity, id);
  var prevTail = tails[k] || Promise.resolve();
  var tail = prevTail.then(fn, fn);
  tails[k] = tail;
  function cleanup() { if (tails[k] === tail) delete tails[k]; }
  tail.then(cleanup, cleanup);
  return tail;
}

function postAppsScript(body) {
  var url = process.env.APPS_SCRIPT_URL;
  var token = process.env.APPS_SCRIPT_SERVER_TOKEN;
  if (!url || !token) {
    return Promise.reject(new Error('Apps Script not configured'));
  }
  return Promise.resolve(
    axios.post(url, JSON.stringify(Object.assign({}, body, { server_token: token })), {
      headers: { 'Content-Type': 'application/json' },
      timeout: APPS_SCRIPT_TIMEOUT_MS,
      maxRedirects: 5
    })
  ).then(function (resp) {
    var data = resp && resp.data;
    if (!data || data.ok !== true) {
      throw new Error('Apps Script ' + body.action + ' failed: ' +
        ((data && (data.error || data.message)) || 'ok !== true'));
    }
    return data;
  });
}

function readMarkerToken(entity, id) {
  return Promise.resolve().then(function () {
    return cache.get(markerKey(entity, id));
  }).then(function (m) {
    return m && m.token ? m.token : null;
  }, function () { return null; });
}

function clearMarkerIfUnchanged(entity, id, token) {
  if (!token) return Promise.resolve();
  return readMarkerToken(entity, id).then(function (current) {
    if (current === token) return cache.del(markerKey(entity, id));
    return undefined;
  }).catch(function () {});
}

function readLatest(entity, id) {
  return db.withTransaction(function (client) {
    if (entity === 'batch') return require('./batch-pg-read').getBatchBundle(client, id);
    return entity === 'vessel'
      ? vesselPg.getVessel(client, id)
      : fermSchedulePg.getSchedule(client, id);
  });
}

/** Copy the current Postgres state of an entity onto the sheet. Rejects on failure. */
function mirrorLatest(entity, id) {
  assertEntity(entity);
  return readMarkerToken(entity, id).then(function (token) {
    return readLatest(entity, id).then(function (row) {
      var body = buildMirrorRequest(entity, row, id);
      return postAppsScript(body).then(function (result) {
        return clearMarkerIfUnchanged(entity, id, token).then(function () {
          return { action: body.action, result: result };
        });
      });
    });
  });
}

function runWithRetry(entity, id, attempt) {
  return chainFor(entity, id, function () {
    return mirrorLatest(entity, id);
  }).then(function () {
    return undefined;
  }, function (err) {
    var message = (err && err.message) || String(err);
    if (attempt < RETRY_DELAYS_MS.length) {
      log.warn('[ops-mirror] send failed entity=' + entity + ' id=' + id + ' attempt=' + (attempt + 1) +
        ' — retrying in ' + RETRY_DELAYS_MS[attempt] + 'ms: ' + message);
      unrefTimer(setTimeout(function () {
        runWithRetry(entity, id, attempt + 1);
      }, RETRY_DELAYS_MS[attempt]));
      return undefined;
    }
    log.error('[ops-mirror] persistent failure entity=' + entity + ' id=' + id);
    sentryCapture.captureExceptionSafe(err instanceof Error ? err : new Error(message), {
      level: 'error',
      tags: { component: 'ops-mirror', entity: entity, id: id }
    });
    return undefined;
  });
}

/**
 * Mark the entity dirty and mirror its latest state in the background.
 * Throws synchronously only for an unknown entity. No-op off production.
 */
function schedule(entity, id) {
  assertEntity(entity);
  try {
    sheetMirror.mirrorFireAndForget(ENTITIES[entity].label, function () {
      var marker = {
        token: Date.now() + '-' + Math.random().toString(36).slice(2),
        set_at: new Date().toISOString()
      };
      return Promise.resolve()
        .then(function () { return cache.set(markerKey(entity, id), marker, MARKER_TTL_SECONDS); })
        .catch(function (err) {
          log.warn('[ops-mirror] marker write failed entity=' + entity + ' id=' + id + ': ' +
            ((err && err.message) || String(err)));
        })
        .then(function () { return runWithRetry(entity, id, 0); });
    });
  } catch (err) {
    log.warn('[ops-mirror] schedule failed entity=' + entity + ' id=' + id + ': ' +
      ((err && err.message) || String(err)));
  }
  return undefined;
}

function parseKey(key) {
  var rest = String(key).slice(KEY_ROOT.length);
  var idx = rest.indexOf(':');
  if (idx < 1) return null;
  var entity = rest.slice(0, idx);
  var id = rest.slice(idx + 1);
  if (!Object.prototype.hasOwnProperty.call(ENTITIES, entity) || !id) return null;
  return { entity: entity, id: id };
}

/**
 * Re-drive every surviving dirty marker (one attempt each, no backoff chain).
 * @returns {Promise<{redriven: number}>}
 */
function sweep() {
  var empty = { redriven: 0 };
  if (!sheetMirror.isMirrorEnabled() || !cache.isConnected()) {
    return Promise.resolve(empty);
  }
  return cache.getClient().then(function (c) {
    if (!c) return null;
    return c.keys(KEY_ROOT + '*');
  }).then(function (keys) {
    if (!keys || keys.length === 0) return empty;
    var redriven = 0;
    var pending = [];
    keys.forEach(function (key) {
      var parsed = parseKey(key);
      if (!parsed) return;
      var entity = parsed.entity;
      var id = parsed.id;
      var ck = chainKey(entity, id);
      if (tails[ck]) return; // chain already running
      redriven++;
      pending.push(chainFor(entity, id, function () {
        return mirrorLatest(entity, id);
      }).then(function () {
        delete lastSweepAlert[ck];
      }, function (err) {
        var message = (err && err.message) || String(err);
        log.warn('[ops-mirror] sweep send failed entity=' + entity + ' id=' + id + ': ' + message);
        var now = Date.now();
        if (!lastSweepAlert[ck] || now - lastSweepAlert[ck] >= SWEEP_ALERT_INTERVAL_MS) {
          lastSweepAlert[ck] = now;
          sentryCapture.captureExceptionSafe(err instanceof Error ? err : new Error(message), {
            level: 'error',
            tags: { component: 'ops-mirror', entity: entity, id: id }
          });
        }
      }));
    });
    return Promise.all(pending).then(function () { return { redriven: redriven }; });
  });
}

module.exports = {
  schedule: schedule,
  sweep: sweep,
  mirrorLatest: mirrorLatest,
  buildMirrorRequest: buildMirrorRequest,
  ENTITIES: ENTITIES,
  RETRY_DELAYS_MS: RETRY_DELAYS_MS
};

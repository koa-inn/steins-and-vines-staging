'use strict';

/**
 * Phase 86-16 admin/BrewPad proxy overlay (DB-05, D-14, D-15, D-16).
 *
 * Hooks into routes/pos.js proxies and forwardToAppsScript so vessels and fermentation
 * schedules are served from Postgres when OPS_DATA_STORE is dual/postgres. In sheets mode
 * everything here is a no-op (except mapSheetsAction), so today's behaviour is unchanged.
 *
 * Stores are required lazily inside functions so loading pos.js in existing tests (which mock
 * constants/cache/logger) is unaffected.
 */

var log = require('./logger');

function vesselStore() { return require('./vessel-store'); }
function scheduleStore() { return require('./ferm-schedule-store'); }

function mode() {
  return vesselStore().getMode();
}

function pgActive() {
  return mode() !== 'sheets';
}

var SCHEDULE_WRITES = {
  create_ferm_schedule: 'create',
  update_ferm_schedule: 'update',
  delete_ferm_schedule: 'remove',
  archive_ferm_schedule: 'archive',
  propagate_ferm_schedule: 'propagate'
};

function msg(err) {
  return (err && err.message) || String(err);
}

function mapSheetsAction(action) {
  if (action === 'archive_ferm_schedule' && !pgActive()) return 'delete_ferm_schedule';
  return action;
}

function sendEnvelope(res, action, logTag, result) {
  if (result && result.ok === false) {
    if (result.error === 'stale_schedule') {
      return res.status(409).json({
        ok: false, error: 'stale_schedule', code: 'stale_schedule', message: result.message
      });
    }
    if (result.error === 'schedule_in_use') {
      return res.status(409).json({
        ok: false, error: 'schedule_in_use', code: 'schedule_in_use', message: result.message,
        recipe_refs: result.recipe_refs, batch_refs: result.batch_refs
      });
    }
  }
  return res.json(result);
}

function sendFailure(res, action, logTag, err) {
  log.error('[' + logTag + '] ' + action + ' (store) failed: ' + msg(err));
  res.status(502).json({ ok: false, error: 'server_error' });
}

/**
 * @returns {boolean} true when this module owns the response (synchronously decided).
 */
function intercept(action, payload, req, res, logTag, forward) {
  if (!pgActive()) return false;

  var actor = (req && req.staffEmail) || 'middleware';
  var opts = { actor: actor, expectedUpdatedAt: payload.expected_updated_at };
  var work = null;

  if (action === 'get_vessels') {
    work = vesselStore().list();
  } else if (action === 'get_ferm_schedules') {
    work = scheduleStore().list();
  } else if (SCHEDULE_WRITES[action]) {
    work = scheduleStore()[SCHEDULE_WRITES[action]](payload, opts);
  } else if (action === 'create_batch' && payload.schedule_id) {
    scheduleStore().getStepsJson(payload.schedule_id).then(function (r) {
      if (!r || r.ok !== true) {
        return res.json(r || { ok: false, error: 'not_found', message: 'Schedule not found: ' + payload.schedule_id });
      }
      payload.schedule_steps_json = r.steps_json;
      forward();
    }).catch(function (err) {
      sendFailure(res, action, logTag, err);
    });
    return true;
  } else {
    return false;
  }

  work.then(function (result) {
    sendEnvelope(res, action, logTag, result);
  }).catch(function (err) {
    sendFailure(res, action, logTag, err);
  });
  return true;
}

function decorateForward(payload, isRead) {
  if (isRead || !pgActive()) return payload;
  payload.collect_vessel_status = true;
  if (payload.server_token) {
    payload.vessel_sheet_write = require('./sheet-mirror').isMirrorEnabled();
  }
  return payload;
}

function afterUpstream(data, payload) {
  if (!pgActive() || !data || typeof data !== 'object') return Promise.resolve(data);

  var changes = data.vessel_status_changes;
  delete data.vessel_status_changes;

  var applying = Promise.resolve();
  if (Array.isArray(changes) && changes.length) {
    applying = vesselStore().applyStatusChanges(changes, {
      actor: (payload && payload.acting_user) || 'middleware'
    }).catch(function (err) {
      var ids = changes.map(function (c) { return c && c.vessel_id; }).join(',');
      log.error('[ops-proxy] vessel status apply failed vessels=' + ids + ': ' + msg(err));
      try {
        require('./sentry-capture').captureExceptionSafe(err, {
          tags: { area: 'ops-proxy', step: 'apply_vessel_status' }
        });
      } catch { /* telemetry never blocks */ }
    });
  }

  return applying.then(function () {
    if (payload && payload.action === 'get_batch_init' && data.data && typeof data.data === 'object') {
      return scheduleStore().list().then(function (r) {
        data.data.schedules = (r && r.data && r.data.schedules) || [];
        return data;
      });
    }
    return data;
  });
}

module.exports = {
  intercept: intercept,
  decorateForward: decorateForward,
  afterUpstream: afterUpstream,
  mapSheetsAction: mapSheetsAction
};

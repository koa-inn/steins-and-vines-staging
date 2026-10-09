'use strict';

/**
 * Phase 87-12 batch overlay for the admin/BrewPad proxies (DB-06, D-05, D-14).
 *
 * Hooks into routes/pos.js (/api/batch/admin-proxy and /api/admin/proxy), ahead of
 * ops-proxy.intercept. In sheets mode it is a no-op except for the maintenance freeze, which
 * answers every batch write with HTTP 503 in either mode. In postgres mode the 17 batch-data
 * actions are served by lib/batch-store with Apps Script-identical envelopes, so
 * js/brewpad.js, js/admin.js and js/batch.js need no change.
 *
 * Failures collapse to 502 {ok:false,error:'server_error'} with no detail (T-87-12-04); the
 * message is logged server-side only. Writes are never retried here.
 */

var log = require('./logger');

function batchStore() { return require('./batch-store'); }
function batchFlag() { return require('./batch-flag'); }

var ACTION_TO_OP = {
  get_batches: 'list',
  get_batch: 'detail',
  get_batch_dashboard_summary: 'dashboard',
  get_tasks_upcoming: 'upcoming',
  get_tasks_calendar: 'calendar',
  get_batch_init: 'batchInit',
  create_batch: 'create',
  update_batch: 'update',
  update_batch_schedule: 'updateSchedule',
  delete_batch: 'remove',
  update_batch_task: 'updateTask',
  bulk_update_batch_tasks: 'bulkUpdateTasks',
  add_batch_task: 'addTask',
  bulk_add_plato_readings: 'bulkAddReadings',
  update_plato_reading: 'updateReading',
  delete_plato_reading: 'deleteReading',
  regenerate_batch_token: 'regenerateToken'
};

var WRITE_ACTIONS = {
  create_batch: true,
  update_batch: true,
  update_batch_schedule: true,
  delete_batch: true,
  update_batch_task: true,
  bulk_update_batch_tasks: true,
  add_batch_task: true,
  bulk_add_plato_readings: true,
  update_plato_reading: true,
  delete_plato_reading: true,
  regenerate_batch_token: true
};

function msg(err) {
  return (err && err.message) || String(err);
}

/**
 * @returns {boolean} true when this module owns the response (decided synchronously).
 */
function intercept(action, payload, req, res, logTag) {
  var opName = ACTION_TO_OP[action];
  if (!opName) return false;

  var flag = batchFlag();
  if (WRITE_ACTIONS[action] && flag.isFrozen()) {
    if (action === 'create_batch') {
      log.warn('[batch-proxy] create_batch refused: maintenance' +
        (payload && payload.zoho_so_number ? ' invoice=' + String(payload.zoho_so_number) : ''));
    }
    res.status(503).json(flag.maintenanceEnvelope());
    return true;
  }
  if (flag.getMode() !== 'postgres') return false;

  // Actor comes from the authenticated session only (hardenProxyPayload set acting_user from it).
  var actor = (req && req.staffEmail) || (payload && payload.acting_user) || 'middleware';
  var started = Date.now();

  var work;
  try {
    work = batchStore()[opName](payload, { actor: actor });
  } catch (err) {
    work = Promise.reject(err);
  }

  Promise.resolve(work).then(function (result) {
    if (action === 'create_batch') {
      log.info('[batch-proxy] create_batch ms=' + (Date.now() - started));
    }
    if (result === null || result === undefined) {
      throw new Error('batch store returned no result');
    }
    res.json(result);
  }).catch(function (err) {
    log.error('[' + logTag + '] ' + action + ' (store) failed: ' + msg(err));
    res.status(502).json({ ok: false, error: 'server_error' });
  });
  return true;
}

module.exports = {
  intercept: intercept,
  WRITE_ACTIONS: WRITE_ACTIONS,
  ACTION_TO_OP: ACTION_TO_OP
};

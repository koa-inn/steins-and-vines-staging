'use strict';

/**
 * Postgres shop-floor writes — Phase 87 Plan 09 (DB-06, D-13, D-14; 87-DESIGN Q8, Q9).
 *
 * Task completion (with packaging / transfer side effects), bulk task update, add task, Plato
 * reading CRUD and schedule propagation. Port of updateBatchTask, bulkUpdateBatchTasks,
 * addBatchTask, handlePackagingCompletion/Uncompletion, addPlatoReading and friends,
 * propagateFermSchedule in apps-script/adminApi.gs.
 *
 * This module never requires 'pg' and never creates a pool: every function receives the
 * transaction `client`. Every mutation locks the owning batch row first (select ... for update),
 * so the "all non-packaging tasks done" decision cannot race. Business rejections RESOLVE
 * {ok:false, error, message} having written nothing. Queries on one client are serialised
 * (never Promise.all on a single client).
 *
 * Vessel status flips are collected per call and applied once through
 * vessel-pg.applyStatusChanges on the SAME client (D-13).
 *
 * opts = {actor, now, publicBatchId}. publicBatchId is set ONLY by the public route: the actor is
 * then forced to 'batch-url', packaging completion is refused and the task/reading must belong
 * to that batch (Q8). SQL uses $n placeholders only; dynamic SET clauses use fixed column names.
 *
 * node-pg returns `date` columns as local-midnight Date objects (formatted with local getters).
 */

var batchRules = require('./batch-rules');
var batchRead = require('./batch-pg-read');
var batchUpdate = require('./batch-pg-update');
var vesselPg = require('./vessel-pg');
var recipeRules = require('./recipe-rules');

var INT_MAX = 2147483647;

// ─── SQL (module-level constants only) ─────────────────────────────────────

var TASK_BY_ID_SQL = 'select * from batch_tasks where task_id = $1';
var TASKS_BY_BATCH_SQL =
  'select * from batch_tasks where batch_id = $1 order by length(task_id), task_id';
var TASK_BATCH_IDS_SQL =
  'select distinct batch_id from batch_tasks where task_id = any($1::text[]) order by batch_id';
var TASK_COMPLETE_SQL =
  'update batch_tasks set completed = true, completed_at = $2, completed_by = $3, last_updated = $2 ' +
  'where task_id = $1';
var TASK_UNCOMPLETE_SQL =
  "update batch_tasks set completed = false, completed_at = null, completed_by = '', last_updated = $2 " +
  'where task_id = $1';
var TASK_NOTES_SQL = 'update batch_tasks set notes = $2, last_updated = $3 where task_id = $1';
var TASK_TOUCH_SQL = 'update batch_tasks set last_updated = $2 where task_id = $1';
var TASK_INSERT_SQL =
  'insert into batch_tasks (batch_id, step_number, title, description, day_offset, due_date, ' +
  'is_packaging, is_transfer, completed, notes, last_updated) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10) returning task_id';
var TASK_MAX_STEP_SQL = 'select coalesce(max(step_number), 0) as max_step from batch_tasks where batch_id = $1';
var TASK_PROPAGATE_UPDATE_SQL =
  'update batch_tasks set title = $2, description = $3, day_offset = $4, due_date = $5, ' +
  'step_number = $6, last_updated = $7 where task_id = $1';
var TASK_PROPAGATE_INSERT_SQL =
  'insert into batch_tasks (batch_id, step_number, title, description, day_offset, due_date, ' +
  'is_packaging, is_transfer, completed, last_updated) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)';
var TASKS_REMOVE_SQL = 'delete from batch_tasks where task_id = any($1::text[])';

var BATCH_EXISTS_SQL = 'select 1 from batches where batch_id = $1 for key share';
var READING_INSERT_SQL =
  'insert into plato_readings (batch_id, reading_at, degrees_plato, notes, recorded_by, created_at, ' +
  'temperature, ph) values ($1, $2, $3, $4, $5, $6, $7, $8) returning reading_id';
var READING_BY_ID_SQL = 'select reading_id, batch_id from plato_readings where reading_id = $1';
var READING_DELETE_SQL = 'delete from plato_readings where reading_id = $1';

var ACTIVE_BATCHES_SQL =
  "select batch_id from batches where schedule_id = $1 and status in ('primary', 'secondary') " +
  'order by batch_id';

// ─── Helpers ───────────────────────────────────────────────────────────────

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

function nowOf(opts) {
  return (opts && opts.now) || new Date();
}

function publicIdOf(opts) {
  return opts && opts.publicBatchId ? String(opts.publicBatchId) : '';
}

function actorOf(opts) {
  if (publicIdOf(opts)) return 'batch-url';
  return (opts && opts.actor) || '';
}

function clean(value) {
  return recipeRules.sanitizeInput(String(value));
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function dateOnly(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  return String(v).slice(0, 10);
}

function isCalendarDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10);
  var d = parseInt(m[3], 10);
  var t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function isInt32(n) {
  return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && Math.abs(n) <= INT_MAX;
}

/** Strips the underscore-prefixed internal fields from a per-item bulk result. */
function publicResult(res) {
  var out = {};
  Object.keys(res).forEach(function (k) {
    if (k.charAt(0) !== '_') out[k] = res[k];
  });
  return out;
}

function dueParam(due) {
  return due === '' || due === null || due === undefined ? null : due;
}

// ─── updateBatchTask ───────────────────────────────────────────────────────

/**
 * Applies a patch (fixed column names from this module only) to the batch row and returns the
 * merged row. Always bumps last_updated.
 */
async function patchBatch(client, row, patch, now) {
  var cols = Object.keys(patch);
  var params = [String(row.batch_id)];
  var sets = cols.map(function (c) {
    params.push(patch[c]);
    return c + ' = $' + params.length;
  });
  params.push(now);
  sets.push('last_updated = $' + params.length);
  await client.query('update batches set ' + sets.join(', ') + ' where batch_id = $1', params);
  var merged = Object.assign({}, row, patch);
  merged.last_updated = now;
  return merged;
}

/** handlePackagingCompletion: completes the batch when every non-packaging task is done. */
async function onPackagingCompleted(client, row, now, vesselChanges) {
  var tasks = (await client.query(TASKS_BY_BATCH_SQL, [row.batch_id])).rows;
  for (var i = 0; i < tasks.length; i++) {
    if (!tasks[i].is_packaging && !tasks[i].completed) return row;
  }
  if (String(row.status).toLowerCase() === 'complete') return row;
  var next = await patchBatch(client, row, { status: 'complete', completed_at: now }, now);
  if (row.vessel_id) vesselChanges.push({ vessel_id: String(row.vessel_id), status: 'Empty' });
  return next;
}

/** handlePackagingUncompletion: revert to secondary (a transfer was done) or primary. */
async function onPackagingUncompleted(client, row, now, vesselChanges) {
  var tasks = (await client.query(TASKS_BY_BATCH_SQL, [row.batch_id])).rows;
  var hasCompletedTransfer = tasks.some(function (t) { return t.is_transfer && t.completed; });
  var next = await patchBatch(
    client, row, { status: hasCompletedTransfer ? 'secondary' : 'primary' }, now
  );
  if (row.vessel_id) vesselChanges.push({ vessel_id: String(row.vessel_id), status: 'In-Use' });
  return next;
}

/** Transfer completion: move (or release the vessel), then primary -> secondary. */
async function onTransferCompleted(client, row, transferLocation, opts, now, vesselChanges, warnings) {
  var patch = {};
  if (transferLocation) {
    var loc = await batchUpdate.applyLocationChange(client, row, {
      vessel_id: transferLocation.vessel_id || '',
      shelf_id: transferLocation.shelf_id || '',
      bin_id: transferLocation.bin_id === undefined || transferLocation.bin_id === null
        ? '' : transferLocation.bin_id
    }, opts);
    if (!loc.ok) {
      // Q9: the task still completes; staff are told the move did not happen.
      warnings.push(loc.error + ': ' + loc.message);
    } else if (loc.changed) {
      patch.vessel_id = loc.location.vessel_id;
      patch.shelf_id = loc.location.shelf_id;
      patch.bin_id = loc.location.bin_id;
      loc.vesselChanges.forEach(function (c) { vesselChanges.push(c); });
    }
  } else if (row.vessel_id) {
    vesselChanges.push({ vessel_id: String(row.vessel_id), status: 'Empty' });
  }

  if (batchRules.statusAfterTransfer(row.status) !== row.status) {
    patch.status = batchRules.statusAfterTransfer(row.status);
  }
  if (Object.keys(patch).length === 0) return row;
  return patchBatch(client, row, patch, now);
}

async function updateBatchTask(client, args, opts) {
  args = args || {};
  if (!args.task_id) return fail('missing_id', 'task_id is required');

  var taskId = String(args.task_id);
  var updates = args.updates || {};
  var now = nowOf(opts);
  var publicId = publicIdOf(opts);

  var probe = (await client.query(TASK_BY_ID_SQL, [taskId])).rows[0];
  if (!probe) return fail('not_found', 'Task not found: ' + taskId);

  // Q8 / D-14: a batch token may only touch its own batch's tasks, and never complete packaging.
  if (publicId) {
    if (String(probe.batch_id) !== publicId) {
      return fail('unauthorized', 'Task does not belong to this batch');
    }
    if (updates.completed && probe.is_packaging) {
      return fail('unauthorized', 'Packaging tasks can only be completed by staff');
    }
  }

  var row = await batchRead.lockBatch(client, probe.batch_id);
  if (!row) return fail('not_found', 'Task not found: ' + taskId);
  // Re-read under the lock: a propagate or delete may have changed it since the probe.
  var task = (await client.query(TASK_BY_ID_SQL, [taskId])).rows[0];
  if (!task || String(task.batch_id) !== String(row.batch_id)) {
    return fail('not_found', 'Task not found: ' + taskId);
  }

  var vesselChanges = [];
  var warnings = [];

  if (updates.completed !== undefined) {
    if (updates.completed) {
      await client.query(TASK_COMPLETE_SQL, [taskId, now, actorOf(opts)]);
      if (task.is_packaging) {
        row = await onPackagingCompleted(client, row, now, vesselChanges);
      }
      if (task.is_transfer) {
        row = await onTransferCompleted(
          client, row, args.transfer_location, opts, now, vesselChanges, warnings
        );
      }
    } else {
      await client.query(TASK_UNCOMPLETE_SQL, [taskId, now]);
      if (task.is_packaging) {
        row = await onPackagingUncompleted(client, row, now, vesselChanges);
      }
    }
  }

  if (updates.notes !== undefined) {
    await client.query(TASK_NOTES_SQL, [taskId, clean(updates.notes), now]);
  } else if (updates.completed === undefined) {
    await client.query(TASK_TOUCH_SQL, [taskId, now]);
  }

  var applied = await vesselPg.applyStatusChanges(client, vesselChanges, opts);

  var out = {
    ok: true,
    message: 'Task updated',
    batch_id: String(row.batch_id),
    _batchId: String(row.batch_id),
    _vesselApplied: applied.applied
  };
  if (warnings.length) out.warnings = warnings;
  return out;
}

// ─── bulkUpdateBatchTasks ──────────────────────────────────────────────────

async function bulkUpdateBatchTasks(client, args, opts) {
  args = args || {};
  var tasks = args.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return fail('invalid_input', 'tasks array is required');
  }
  if (tasks.length > 50) return fail('too_many', 'Maximum 50 tasks per request');

  // Lock every involved batch in a stable order first so two bulk calls cannot deadlock.
  var ids = [];
  tasks.forEach(function (t) {
    if (t && t.task_id) ids.push(String(t.task_id));
  });
  if (ids.length) {
    var owners = (await client.query(TASK_BATCH_IDS_SQL, [ids])).rows;
    for (var o = 0; o < owners.length; o++) {
      await batchRead.lockBatch(client, owners[o].batch_id);
    }
  }

  var results = [];
  var affected = [];
  var vesselIds = [];
  for (var i = 0; i < tasks.length; i++) {
    var res = await updateBatchTask(client, tasks[i], opts);
    results.push(publicResult(res));
    if (res.ok) {
      if (res._batchId && affected.indexOf(res._batchId) === -1) affected.push(res._batchId);
      res._vesselApplied.forEach(function (v) {
        if (vesselIds.indexOf(v) === -1) vesselIds.push(v);
      });
    }
  }
  return {
    ok: true,
    results: results,
    affected_batch_ids: affected,
    _batchIds: affected.slice(),
    _vesselApplied: vesselIds
  };
}

// ─── addBatchTask ──────────────────────────────────────────────────────────

async function addBatchTask(client, payload, opts) {
  payload = payload || {};
  if (!payload.batch_id || !payload.title) {
    return fail('missing_fields', 'batch_id and title are required');
  }

  var dayOffset = payload.day_offset !== undefined ? Number(payload.day_offset) : -1;
  if (!isInt32(dayOffset)) return fail('invalid_input', 'day_offset must be a whole number');
  var due = payload.due_date ? String(payload.due_date) : '';
  if (due && !isCalendarDate(due)) return fail('invalid_input', 'due_date must be YYYY-MM-DD');

  var row = await batchRead.lockBatch(client, payload.batch_id);
  if (!row) return fail('not_found', 'Batch not found: ' + payload.batch_id);

  var max = (await client.query(TASK_MAX_STEP_SQL, [row.batch_id])).rows[0].max_step;
  var startDate = dateOnly(row.start_date);
  if (!due && dayOffset >= 0 && startDate) {
    due = batchRules.calculateDueDate(startDate, dayOffset);
  }

  var res = await client.query(TASK_INSERT_SQL, [
    String(row.batch_id),
    Number(max) + 1,
    clean(payload.title),
    clean(payload.description || ''),
    dayOffset,
    dueParam(due),
    false,
    !!payload.is_transfer,
    clean(payload.notes || ''),
    nowOf(opts)
  ]);
  return {
    ok: true,
    task_id: res.rows[0].task_id,
    message: 'Task added',
    _batchId: String(row.batch_id)
  };
}

// ─── Plato readings ────────────────────────────────────────────────────────

async function addPlatoReading(client, payload, opts) {
  payload = payload || {};
  if (!payload.batch_id) return fail('missing_id', 'batch_id is required');

  var v = batchRules.validateReading(payload);
  if (!v.ok) return v;

  var batchId = String(payload.batch_id);
  var publicId = publicIdOf(opts);
  if (publicId && batchId !== publicId) {
    return fail('unauthorized', 'Reading does not belong to this batch');
  }

  var exists = await client.query(BATCH_EXISTS_SQL, [batchId]);
  if (exists.rows.length === 0) return fail('not_found', 'Batch not found: ' + batchId);

  var now = nowOf(opts);
  var readingAt = v.timestamp ? new Date(v.timestamp) : now;
  var res = await client.query(READING_INSERT_SQL, [
    batchId,
    readingAt,
    v.degrees_plato,
    clean(payload.notes || ''),
    actorOf(opts),
    now,
    v.temperature,
    v.ph
  ]);
  return { ok: true, reading_id: res.rows[0].reading_id, _batchId: batchId };
}

async function bulkAddPlatoReadings(client, payload, opts) {
  payload = payload || {};
  if (!payload.batch_id) return fail('missing_id', 'batch_id is required');
  if (!Array.isArray(payload.readings) || payload.readings.length === 0) {
    return fail('invalid_input', 'readings array is required');
  }
  if (payload.readings.length > 20) return fail('too_many', 'Maximum 20 readings per request');

  var results = [];
  for (var i = 0; i < payload.readings.length; i++) {
    var item = Object.assign({}, payload.readings[i], { batch_id: payload.batch_id });
    results.push(publicResult(await addPlatoReading(client, item, opts)));
  }
  return { ok: true, results: results, _batchId: String(payload.batch_id) };
}

async function updatePlatoReading(client, payload, opts) {
  payload = payload || {};
  if (!payload.reading_id) return fail('missing_id', 'reading_id is required');
  var updates = payload.updates || {};
  var readingId = String(payload.reading_id);

  var found = (await client.query(READING_BY_ID_SQL, [readingId])).rows[0];
  if (!found) return fail('not_found', 'Reading not found: ' + readingId);

  var publicId = publicIdOf(opts);
  if (publicId && String(found.batch_id) !== publicId) {
    return fail('unauthorized', 'Reading does not belong to this batch');
  }

  var v = batchRules.validateReadingUpdate(updates);
  if (!v.ok) return v;

  var sets = [];
  var params = [readingId];
  function addSet(col, value) {
    params.push(value);
    sets.push(col + ' = $' + params.length);
  }
  if (updates.degrees_plato !== undefined) addSet('degrees_plato', parseFloat(updates.degrees_plato));
  if (updates.timestamp !== undefined && updates.timestamp !== '') {
    addSet('reading_at', new Date(updates.timestamp));
  }
  if (updates.temperature !== undefined) {
    addSet('temperature', updates.temperature === '' ? null : parseFloat(updates.temperature));
  }
  if (updates.ph !== undefined) {
    addSet('ph', updates.ph === '' ? null : parseFloat(updates.ph));
  }
  if (updates.notes !== undefined) addSet('notes', clean(updates.notes || ''));

  if (sets.length) {
    await client.query('update plato_readings set ' + sets.join(', ') + ' where reading_id = $1', params);
  }
  return { ok: true, reading_id: readingId, _batchId: String(found.batch_id) };
}

async function deletePlatoReading(client, payload, opts) {
  payload = payload || {};
  if (!payload.reading_id) return fail('missing_id', 'reading_id is required');
  var readingId = String(payload.reading_id);

  var found = (await client.query(READING_BY_ID_SQL, [readingId])).rows[0];
  if (!found) return fail('not_found', 'Reading not found: ' + readingId);

  var publicId = publicIdOf(opts);
  if (publicId && String(found.batch_id) !== publicId) {
    return fail('unauthorized', 'Reading does not belong to this batch');
  }

  await client.query(READING_DELETE_SQL, [readingId]);
  return { ok: true, reading_id: readingId, _batchId: String(found.batch_id) };
}

// ─── propagateSchedule ─────────────────────────────────────────────────────

/** Rewrites one locked batch's tasks to match the template. Returns the counts. */
async function propagateOneBatch(client, row, steps, now) {
  var startDate = dateOnly(row.start_date);
  var tasks = (await client.query(TASKS_BY_BATCH_SQL, [row.batch_id])).rows;
  var counts = { updated: 0, created: 0, removed: 0 };

  // Completed tasks win over pending duplicates; packaging matches by flag, not step number.
  var regularByStep = {};
  var packagingTask = null;
  tasks.forEach(function (t) {
    if (t.is_packaging) {
      if (!packagingTask || (t.completed && !packagingTask.completed)) packagingTask = t;
      return;
    }
    var key = String(t.step_number);
    if (!regularByStep[key] || (t.completed && !regularByStep[key].completed)) regularByStep[key] = t;
  });

  var matched = {};
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var existing = step.is_packaging ? packagingTask : regularByStep[String(step.step_number)];
    if (existing) matched[String(existing.task_id)] = true;

    var due = dueParam(batchRules.calculateDueDate(startDate, step.day_offset));
    if (existing && existing.completed) {
      continue; // history, never rewritten
    }
    if (existing) {
      await client.query(TASK_PROPAGATE_UPDATE_SQL, [
        existing.task_id, clean(step.title || ''), clean(step.description || ''),
        parseInt(step.day_offset, 10), due, parseInt(step.step_number, 10), now
      ]);
      counts.updated++;
    } else {
      await client.query(TASK_PROPAGATE_INSERT_SQL, [
        String(row.batch_id), parseInt(step.step_number, 10),
        clean(step.title || ''), clean(step.description || ''),
        parseInt(step.day_offset, 10), due, !!step.is_packaging, !!step.is_transfer, now
      ]);
      counts.created++;
    }
  }

  var removeIds = tasks.filter(function (t) {
    return !t.completed && !matched[String(t.task_id)];
  }).map(function (t) { return t.task_id; });
  if (removeIds.length) {
    await client.query(TASKS_REMOVE_SQL, [removeIds]);
    counts.removed = removeIds.length;
  }
  return counts;
}

async function propagateSchedule(client, scheduleId, steps, opts) {
  if (!scheduleId || !steps) return fail('missing_fields', 'schedule_id and steps are required');
  if (typeof steps === 'string') {
    try {
      steps = JSON.parse(steps);
    } catch {
      return fail('invalid_data', 'Invalid steps JSON');
    }
  }
  if (!Array.isArray(steps)) return fail('invalid_data', 'steps must be an array');
  for (var s = 0; s < steps.length; s++) {
    var st = steps[s];
    if (!st || typeof st !== 'object' ||
        !isInt32(Number(st.step_number)) || !isInt32(Number(st.day_offset))) {
      return fail('invalid_data', 'Each step needs a numeric step_number and day_offset');
    }
  }

  var now = nowOf(opts);
  var result = {
    ok: true,
    batches_updated: 0,
    tasks_updated: 0,
    tasks_created: 0,
    tasks_removed: 0,
    batches_failed: [],
    _batchIds: []
  };

  var active = (await client.query(ACTIVE_BATCHES_SQL, [String(scheduleId)])).rows;
  if (active.length === 0) {
    result.message = 'No active batches use this template';
    return result;
  }

  for (var i = 0; i < active.length; i++) {
    var batchId = String(active[i].batch_id);
    await client.query('SAVEPOINT propagate_batch');
    try {
      var row = await batchRead.lockBatch(client, batchId);
      var stillActive = row && String(row.schedule_id) === String(scheduleId) &&
        batchRules.isActiveStatus(row.status);
      if (stillActive) {
        var counts = await propagateOneBatch(client, row, steps, now);
        result.tasks_updated += counts.updated;
        result.tasks_created += counts.created;
        result.tasks_removed += counts.removed;
        result.batches_updated++;
        result._batchIds.push(batchId);
      }
      await client.query('RELEASE SAVEPOINT propagate_batch');
    } catch {
      // Counts reflect successful batches only; no DB error text leaves this module.
      await client.query('ROLLBACK TO SAVEPOINT propagate_batch');
      await client.query('RELEASE SAVEPOINT propagate_batch');
      result.batches_failed.push({ batch_id: batchId, error: 'propagate_failed' });
    }
  }
  return result;
}

module.exports = {
  updateBatchTask: updateBatchTask,
  bulkUpdateBatchTasks: bulkUpdateBatchTasks,
  addBatchTask: addBatchTask,
  addPlatoReading: addPlatoReading,
  bulkAddPlatoReadings: bulkAddPlatoReadings,
  updatePlatoReading: updatePlatoReading,
  deletePlatoReading: deletePlatoReading,
  propagateSchedule: propagateSchedule
};

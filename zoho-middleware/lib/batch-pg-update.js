'use strict';

/**
 * Postgres batch update / transfer / delete / schedule / token — Phase 87 Plan 08
 * (DB-06, D-01, D-08, D-13, D-14; 87-DESIGN Q5, Q7, Q9, Q19).
 *
 * This module never requires 'pg' and never creates a pool: every function receives the
 * transaction `client`. Each operation locks the batch row first (select ... for update), runs
 * every validation and conflict check BEFORE the first write, then writes. Business rejections
 * RESOLVE {ok:false, error, message} and leave nothing behind, so a facade that commits on
 * resolve is still atomic (strictly safer than the sheet, RESEARCH Pitfall 9). Infrastructure
 * errors propagate so the transaction rolls back.
 *
 * Vessel status flips go through vessel-pg.applyStatusChanges on the SAME client, so a batch
 * transfer and its vessel status change commit together (D-13).
 *
 * SQL uses $n placeholders only; the dynamic SET clause is built from the fixed FIELD_KINDS
 * allow-list, never from payload keys (T-87-08-01, T-87-08-02).
 *
 * node-pg returns `date` columns as local-midnight Date objects, so they are formatted with
 * local getters here (no UTC conversion).
 */

var crypto = require('crypto');
var batchRules = require('./batch-rules');
var batchRead = require('./batch-pg-read');
var vesselPg = require('./vessel-pg');
var recipeRules = require('./recipe-rules');

// ─── SQL (module-level constants only) ─────────────────────────────────────

// Location writes are serialised per vessel so two concurrent moves cannot both pass the
// conflict pre-check (Q7: pre-check under an advisory lock, no unique index).
var LOCATION_LOCK_SQL = 'select pg_advisory_xact_lock(hashtext($1))';

var HISTORY_INSERT_SQL =
  'insert into vessel_history (batch_id, vessel_id, shelf_id, bin_id, transferred_at, transferred_by, notes) ' +
  'values ($1, $2, $3, $4, $5, $6, $7)';

var TOMBSTONE_SQL =
  'insert into batch_tombstones (batch_id, deleted_at, deleted_by) values ($1, $2, $3) ' +
  'on conflict (batch_id) do update set deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by';
var DEDUP_CLEAR_SQL = 'delete from batch_create_dedup where batch_id = $1';
var BATCH_DELETE_SQL = 'delete from batches where batch_id = $1';

var SCHEDULE_EXISTS_SQL = 'select 1 from ferm_schedules where schedule_id = $1';
var TASKS_FOR_BATCH_SQL =
  'select task_id, step_number, completed from batch_tasks where batch_id = $1 ' +
  'order by length(task_id), task_id';
var TASK_UPDATE_SQL =
  'update batch_tasks set title = $2, description = $3, day_offset = $4, due_date = $5, last_updated = $6 ' +
  'where task_id = $1';
var TASK_INSERT_SQL =
  'insert into batch_tasks (batch_id, step_number, title, description, day_offset, due_date, ' +
  'is_packaging, is_transfer, completed, last_updated) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)';
var TASKS_REMOVE_SQL = 'delete from batch_tasks where task_id = any($1::text[])';
var BATCH_SCHEDULE_SQL =
  'update batches set schedule_snapshot = $2, schedule_id = coalesce($3, schedule_id), last_updated = $4 ' +
  'where batch_id = $1';

var TOKEN_SQL =
  'update batches set access_token = $2, last_regenerated_at = $3, last_updated = $3 where batch_id = $1';

// Fixed allow-list of updatable columns (T-87-08-01): field -> value kind. access_token,
// created_by, source and friends are deliberately absent.
var FIELD_KINDS = {
  status: 'status',
  vessel_id: 'text',
  shelf_id: 'text',
  bin_id: 'text',
  notes: 'text',
  zoho_so_number: 'text',
  customer_id: 'text',
  customer_name: 'text',
  product_name: 'text',
  customer_firstname: 'text',
  customer_lastname: 'text',
  fermentation_started_at: 'timestamp',
  completed_at: 'timestamp',
  recipe_id: 'text',
  start_date: 'date',
  customer_email: 'text',
  customer_phone: 'text',
  bottling_invite_sent_at: 'timestamp',
  bottling_invite_email: 'text'
};
var FIELD_ORDER = Object.keys(FIELD_KINDS);
var LOCATION_FIELDS = ['vessel_id', 'shelf_id', 'bin_id'];

// ─── Helpers ───────────────────────────────────────────────────────────────

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** node-pg `date` (local-midnight Date) or string to YYYY-MM-DD; '' when blank. */
function dateOnly(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  return String(v).slice(0, 10);
}

function isCalendarDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return false;
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10);
  var d = parseInt(m[3], 10);
  var t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function clean(value) {
  return recipeRules.sanitizeInput(String(value));
}

/**
 * Lenient optimistic lock (parity): a conflict only when the server last_updated is strictly
 * newer than the client's expectedVersion. Compared as epoch ms; an absent or unparseable
 * expectedVersion never conflicts. Deliberately not the stale-token helper (exact-match).
 */
function isVersionConflict(expectedVersion, row) {
  if (!expectedVersion || !row || !row.last_updated) return false;
  var raw = expectedVersion;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) raw = Number(raw.trim());
  var clientTime = new Date(raw).getTime();
  if (isNaN(clientTime)) return false;
  var serverTime = new Date(row.last_updated).getTime();
  return serverTime > clientTime;
}

function nowOf(opts) {
  return (opts && opts.now) || new Date();
}

function actorOf(opts) {
  return (opts && opts.actor) || '';
}

/** Date from a date-only or timestamp string; null when it does not parse. */
function parseStamp(s) {
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Location change ───────────────────────────────────────────────────────

/**
 * Applies a vessel/shelf/bin change to an already locked batch row: conflict pre-check under a
 * per-vessel advisory lock (excluding the batch itself), then one vessel_history row carrying the
 * OLD location. Returns the vessel status flips for the caller to apply (it owns the single
 * applyStatusChanges call). Writes nothing when the check fails.
 *
 * `loc` fields that are undefined keep the row's value. Returns
 * {ok:true, changed:false, vesselChanges:[]} when nothing moves.
 */
async function applyLocationChange(client, row, loc, opts) {
  loc = loc || {};
  var next = {};
  var changed = false;
  LOCATION_FIELDS.forEach(function (f) {
    var current = row[f] === null || row[f] === undefined ? '' : String(row[f]);
    if (loc[f] === undefined) {
      next[f] = current;
    } else {
      next[f] = String(loc[f]);
      if (next[f] !== current) changed = true;
    }
  });
  if (!changed) return { ok: true, changed: false, vesselChanges: [], location: next };

  if (next.vessel_id) {
    await client.query(LOCATION_LOCK_SQL, ['batch-location:' + next.vessel_id]);
    var conflict = await batchRead.findLocationConflict(client, next, row.batch_id);
    if (conflict) {
      return fail('location_conflict', 'Location already in use by batch ' + conflict);
    }
  }

  await client.query(HISTORY_INSERT_SQL, [
    row.batch_id,
    String(row.vessel_id || ''),
    String(row.shelf_id || ''),
    String(row.bin_id || ''),
    nowOf(opts),
    actorOf(opts),
    clean(loc.notes || '')
  ]);

  return {
    ok: true,
    changed: true,
    vesselChanges: batchRules.vesselChangesForLocation(row.vessel_id, next.vessel_id),
    location: next
  };
}

// ─── updateBatch ───────────────────────────────────────────────────────────

/** Validates and converts the whitelisted updates. Returns {ok, values} or a failure. */
function prepareFieldValues(updates) {
  var values = {};
  for (var i = 0; i < FIELD_ORDER.length; i++) {
    var f = FIELD_ORDER[i];
    if (updates[f] === undefined) continue;
    var kind = FIELD_KINDS[f];
    if (kind === 'status') {
      var v = batchRules.validateUpdateStatus(updates.status);
      if (!v.ok) return v;
      values.status = v.status;
    } else if (kind === 'text') {
      values[f] = clean(updates[f]);
    } else if (kind === 'date') {
      var ds = clean(updates[f]).trim();
      if (ds === '') {
        values[f] = null;
      } else if (!isCalendarDate(ds)) {
        return fail('invalid_input', f + ' is not a valid date');
      } else {
        values[f] = ds.slice(0, 10);
      }
    } else {
      var ts = clean(updates[f]).trim();
      if (ts === '') {
        values[f] = null;
      } else {
        var d = parseStamp(ts);
        if (!d) return fail('invalid_input', f + ' is not a valid timestamp');
        values[f] = d;
      }
    }
  }
  return { ok: true, values: values };
}

/** pending -> active: fermentation_started_at precedence (script parity). */
function fermentationStamp(updates, row, now) {
  var src = null;
  if (updates.fermentation_started_at) src = clean(updates.fermentation_started_at);
  else if (updates.start_date) src = clean(updates.start_date);
  else if (row.start_date) src = dateOnly(row.start_date);
  if (src) {
    var d = parseStamp(src);
    if (d) return d;
  }
  return now;
}

async function updateBatch(client, args, opts) {
  args = args || {};
  var batchId = args.batch_id;
  if (!batchId) return fail('missing_id', 'batch_id is required');

  var updates = args.updates || {};
  var now = nowOf(opts);

  var row = await batchRead.lockBatch(client, batchId);
  if (!row) return fail('not_found', 'Batch not found: ' + batchId);

  if (isVersionConflict(args.expectedVersion, row)) {
    return fail('version_conflict', 'Batch was modified by another user. Refresh and try again.');
  }

  // Everything that can reject is checked before the first write.
  var prepared = prepareFieldValues(updates);
  if (!prepared.ok) return prepared;
  var values = prepared.values;

  var snapshot;
  if (updates.recipe_snapshot !== undefined) {
    snapshot = String(updates.recipe_snapshot);
    try {
      JSON.parse(snapshot);
    } catch {
      return fail('invalid_input', 'recipe_snapshot is not valid JSON');
    }
  }

  var transferNotes = args.transfer_notes !== undefined ? args.transfer_notes : updates.transfer_notes;
  var vesselChanges = [];
  var loc = await applyLocationChange(client, row, {
    vessel_id: updates.vessel_id,
    shelf_id: updates.shelf_id,
    bin_id: updates.bin_id,
    notes: transferNotes
  }, opts);
  if (!loc.ok) return loc;
  vesselChanges = vesselChanges.concat(loc.vesselChanges);

  var oldStatus = String(row.status || '').toLowerCase();
  if (values.status !== undefined) {
    vesselChanges = vesselChanges.concat(
      batchRules.vesselChangesForStatus(oldStatus, values.status, row.vessel_id)
    );
    if (oldStatus === 'pending') {
      values.fermentation_started_at = fermentationStamp(updates, row, now);
    }
  }

  var sets = [];
  var params = [String(row.batch_id)];
  function addSet(col, value) {
    params.push(value);
    sets.push(col + ' = $' + params.length);
  }
  FIELD_ORDER.concat(['recipe_snapshot']).forEach(function (f) {
    if (f === 'recipe_snapshot') {
      if (snapshot !== undefined) addSet('recipe_snapshot', snapshot);
    } else if (values[f] !== undefined) {
      addSet(f, values[f]);
    }
  });
  addSet('last_updated', now);
  await client.query('update batches set ' + sets.join(', ') + ' where batch_id = $1', params);

  var applied = await vesselPg.applyStatusChanges(client, vesselChanges, opts);

  return {
    ok: true,
    message: 'Batch updated',
    newVersion: now.getTime(),
    _batchId: String(row.batch_id),
    _vesselApplied: applied.applied
  };
}

// ─── deleteBatch ───────────────────────────────────────────────────────────

async function deleteBatch(client, args, opts) {
  args = args || {};
  if (!args.batch_id) return fail('missing_id', 'batch_id is required');

  var row = await batchRead.lockBatch(client, args.batch_id);
  if (!row) return fail('not_found', 'Batch not found: ' + args.batch_id);

  var id = String(row.batch_id);
  var now = nowOf(opts);
  // D-08: the tombstone lets mirror replay know about the delete.
  await client.query(TOMBSTONE_SQL, [id, now, actorOf(opts)]);
  // A retried manual create must not resolve to a batch that no longer exists.
  await client.query(DEDUP_CLEAR_SQL, [id]);
  // ON DELETE CASCADE removes tasks, readings and history (D-01).
  await client.query(BATCH_DELETE_SQL, [id]);

  var applied = [];
  if (row.vessel_id) {
    var res = await vesselPg.applyStatusChanges(client, [{ vessel_id: String(row.vessel_id), status: 'Empty' }], opts);
    applied = res.applied;
  }

  return { ok: true, message: 'Batch ' + id + ' deleted', _batchId: id, _vesselApplied: applied };
}

// ─── updateBatchSchedule ───────────────────────────────────────────────────

async function updateBatchSchedule(client, args, opts) {
  args = args || {};
  if (!args.batch_id || !args.schedule_snapshot) {
    return fail('missing_fields', 'batch_id and schedule_snapshot are required');
  }

  var row = await batchRead.lockBatch(client, args.batch_id);
  if (!row) return fail('not_found', 'Batch not found');

  if (isVersionConflict(args.expectedVersion, row)) {
    return fail('version_conflict', 'Batch was modified. Refresh and try again.');
  }

  var steps;
  try {
    steps = typeof args.schedule_snapshot === 'string'
      ? JSON.parse(args.schedule_snapshot)
      : args.schedule_snapshot;
  } catch {
    return fail('invalid_data', 'Invalid schedule_snapshot JSON');
  }
  if (!Array.isArray(steps)) return fail('invalid_data', 'schedule_snapshot must be an array of steps');
  for (var i = 0; i < steps.length; i++) {
    var st = steps[i];
    if (!st || typeof st !== 'object' ||
        !isFinite(parseInt(st.step_number, 10)) || !isFinite(parseInt(st.day_offset, 10))) {
      return fail('invalid_data', 'Each step needs a numeric step_number and day_offset');
    }
  }

  // Q5: a schedule that does not exist is a clean not_found, never an FK error.
  var scheduleId = args.schedule_id ? String(args.schedule_id) : null;
  if (scheduleId) {
    var exists = await client.query(SCHEDULE_EXISTS_SQL, [scheduleId]);
    if (exists.rows.length === 0) return fail('not_found', 'Schedule not found: ' + scheduleId);
  }

  var now = nowOf(opts);
  var id = String(row.batch_id);
  var startDate = dateOnly(row.start_date);

  await client.query(BATCH_SCHEDULE_SQL, [id, JSON.stringify(steps), scheduleId, now]);

  var existing = (await client.query(TASKS_FOR_BATCH_SQL, [id])).rows;
  // Later rows win on a duplicate step number (script parity: existingByStep overwrite).
  var byStep = {};
  existing.forEach(function (t) { byStep[String(t.step_number)] = t; });

  var seen = {};
  var updated = 0;
  var created = 0;
  for (var k = 0; k < steps.length; k++) {
    var step = steps[k];
    var stepNum = parseInt(step.step_number, 10);
    seen[String(stepNum)] = true;
    var offset = parseInt(step.day_offset, 10);
    var due = batchRules.calculateDueDate(startDate, offset);
    var dueParam = due === '' ? null : due;
    var title = clean(step.title || '');
    var description = clean(step.description || '');
    var match = byStep[String(stepNum)];
    if (match) {
      await client.query(TASK_UPDATE_SQL, [match.task_id, title, description, offset, dueParam, now]);
      updated++;
    } else {
      await client.query(TASK_INSERT_SQL, [
        id, stepNum, title, description, offset, dueParam,
        !!step.is_packaging, !!step.is_transfer, now
      ]);
      created++;
    }
  }

  // Remove only non-completed tasks whose step vanished from the snapshot.
  var removeIds = existing.filter(function (t) {
    return !seen[String(t.step_number)] && !t.completed;
  }).map(function (t) { return t.task_id; });
  if (removeIds.length) await client.query(TASKS_REMOVE_SQL, [removeIds]);

  return {
    ok: true,
    tasks_updated: updated,
    tasks_created: created,
    tasks_removed: removeIds.length,
    _batchId: id
  };
}

// ─── regenerateToken ───────────────────────────────────────────────────────

async function regenerateToken(client, args, opts) {
  args = args || {};
  if (!args.batch_id) return fail('missing_id', 'batch_id is required');

  var row = await batchRead.lockBatch(client, args.batch_id);
  if (!row) return fail('not_found', 'Batch not found');

  var token = crypto.randomBytes(16).toString('hex');
  var id = String(row.batch_id);
  // No cache in PG: the old token stops working with this single update (T-87-08-05).
  await client.query(TOKEN_SQL, [id, token, nowOf(opts)]);
  return { ok: true, access_token: token, _batchId: id };
}

module.exports = {
  updateBatch: updateBatch,
  applyLocationChange: applyLocationChange,
  deleteBatch: deleteBatch,
  updateBatchSchedule: updateBatchSchedule,
  regenerateToken: regenerateToken,
  isVersionConflict: isVersionConflict
};

'use strict';

/**
 * Postgres createBatch — Phase 87 Plan 07 (DB-06, D-13, D-15).
 *
 * Port of adminApi.gs createBatch. The caller owns the transaction (db.withTransaction); this
 * module only receives `client`, so the batch, its tasks, the initial VesselHistory row and the
 * vessel In-Use status are written atomically on the same client (vessel-pg.applyStatusChanges)
 * and the schedule is read on that client too (ferm-schedule-pg.getSchedule).
 *
 * Business rejections RESOLVE {ok:false, error, message}; infrastructure errors propagate (and
 * roll the caller's transaction back). After a business rejection nothing has been written.
 *
 * Idempotency (D-15):
 *   - invoice-linked: advisory lock on invoice|sku, count of existing rows, dedupDecision,
 *     unit_seq = count + 1; the unique index batches_unit_seq_idx is the backstop (23505 maps
 *     to duplicate_so_number).
 *   - manual: advisory lock on the actor+payload fingerprint; a hit in batch_create_dedup
 *     inside the replay window returns the existing batch with idempotent_replay:true.
 *
 * Lock order is always location lock, then invoice/fingerprint lock, so concurrent creates
 * cannot deadlock each other.
 */

var crypto = require('crypto');
var batchRules = require('./batch-rules');
var batchRead = require('./batch-pg-read');
var vesselPg = require('./vessel-pg');
var schedulePg = require('./ferm-schedule-pg');
var sanitizeInput = require('./recipe-rules').sanitizeInput;

// 87-DESIGN Q11 (approved): two minutes.
var DEFAULT_REPLAY_WINDOW_MS = 120000;

var LOCK_SQL = 'select pg_advisory_xact_lock(hashtext($1))';

var INVOICE_SKU_SQL =
  'select batch_id from batches where btrim(zoho_so_number) = $1 and btrim(product_sku) = $2 ' +
  'order by unit_seq nulls last, created_at, batch_id';
var INVOICE_ONLY_SQL =
  'select batch_id from batches where btrim(zoho_so_number) = $1 ' +
  'order by unit_seq nulls last, created_at, batch_id';

var DEDUP_LOOKUP_SQL =
  'select d.batch_id, b.access_token, b.status from batch_create_dedup d ' +
  'join batches b on b.batch_id = d.batch_id ' +
  'where d.fingerprint = $1 and d.created_at > $2';
var DEDUP_UPSERT_SQL =
  'insert into batch_create_dedup (fingerprint, batch_id, created_at) values ($1, $2, $3) ' +
  'on conflict (fingerprint) do update set batch_id = excluded.batch_id, created_at = excluded.created_at';
var TASK_COUNT_SQL = 'select count(*) as n from batch_tasks where batch_id = $1';

var INSERT_BATCH_SQL =
  'insert into batches (status, product_sku, product_name, customer_id, customer_name, ' +
  'customer_firstname, customer_lastname, customer_email, start_date, schedule_id, ' +
  'schedule_snapshot, vessel_id, shelf_id, bin_id, notes, access_token, reservation_id, ' +
  'created_at, created_by, last_updated, source, zoho_so_number, fermentation_started_at, ' +
  'recipe_id, recipe_snapshot, target_volume_l, scale_factor, unit_seq) values ' +
  '($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, ' +
  '$21, $22, $23, $24, $25, $26, $27, $28) returning batch_id';

var INSERT_TASK_SQL =
  'insert into batch_tasks (batch_id, step_number, title, description, day_offset, due_date, ' +
  'is_packaging, is_transfer, completed, last_updated) values ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)';

var INSERT_HISTORY_SQL =
  'insert into vessel_history (batch_id, vessel_id, shelf_id, bin_id, transferred_at, ' +
  'transferred_by, notes) values ($1, $2, $3, $4, $5, $6, $7)';

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  return new Date();
}

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

function numOrNull(v) {
  if (isBlank(v)) return null;
  var n = Number(v);
  return isFinite(n) ? String(v).trim() : undefined; // undefined = invalid
}

function dateOnlyStr(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

function lock(client, key) {
  return client.query(LOCK_SQL, [key]);
}

function ids(res) {
  return res.rows.map(function (r) { return r.batch_id; });
}

function duplicateEnvelope(existingIds, payload) {
  var decision = batchRules.dedupDecision(existingIds, payload);
  if (decision) return decision;
  // Reached only from the 23505 backstop: a concurrent writer took the unit slot.
  var allowed = Math.floor(Number(payload.unit_total));
  if (!isFinite(allowed) || allowed < 1) allowed = 1;
  return fail('duplicate_so_number',
    'SO/invoice ' + payload.zoho_so_number + ' + SKU ' + payload.product_sku +
    ' already has ' + existingIds.length + ' of ' + allowed + ' batch(es): ' + existingIds.join(', '));
}

function replayResult(client, row) {
  return client.query(TASK_COUNT_SQL, [row.batch_id]).then(function (res) {
    var out = {
      ok: true,
      batch_id: row.batch_id,
      access_token: row.access_token,
      tasks_created: Number(res.rows[0].n)
    };
    if (row.status === 'pending') out.status = 'pending';
    out.idempotent_replay = true;
    out._batchId = row.batch_id;
    out._vesselApplied = [];
    return out;
  });
}

async function insertChildren(client, batchId, steps, p, startDate, actor, now) {
  var created = 0;
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {};
    var offset = Number(step.day_offset);
    if (!isFinite(offset)) offset = 0;
    var due = batchRules.calculateDueDate(startDate, offset);
    await client.query(INSERT_TASK_SQL, [
      batchId,
      step.step_number || (i + 1),
      sanitizeInput(step.title || ''),
      sanitizeInput(step.description || ''),
      Math.trunc(offset),
      due === '' ? null : due,
      step.is_packaging ? true : false,
      step.is_transfer ? true : false,
      now
    ]);
    created++;
  }
  if (p.vessel_id || p.shelf_id || p.bin_id) {
    await client.query(INSERT_HISTORY_SQL, [
      batchId, sanitizeInput(p.vessel_id || ''), sanitizeInput(p.shelf_id || ''),
      sanitizeInput(p.bin_id || ''), now, str(actor), 'Initial placement'
    ]);
  }
  return created;
}

async function createBatch(client, payload, opts) {
  var p = Object.assign({}, payload || {});
  opts = opts || {};
  var actor = str(opts.actor);
  var now = toDate(opts.now);
  var windowMs = typeof opts.replayWindowMs === 'number' ? opts.replayWindowMs : DEFAULT_REPLAY_WINDOW_MS;

  var isPending = !p.schedule_id || !p.start_date;
  if ((!p.product_sku && !p.recipe_id) || (!p.customer_name && !p.customer_firstname)) {
    return fail('missing_fields', 'product_sku (or recipe_id) and customer name are required');
  }
  if (!p.customer_name && p.customer_firstname) {
    p.customer_name = (p.customer_firstname + ' ' + (p.customer_lastname || '')).trim();
  }

  var startDate = p.start_date ? dateOnlyStr(p.start_date) : '';
  if (p.start_date && !startDate) {
    return fail('invalid_start_date', 'start_date must be YYYY-MM-DD');
  }
  var targetVolume = numOrNull(p.target_volume_l);
  var scaleFactor = numOrNull(p.scale_factor);
  if (targetVolume === undefined || scaleFactor === undefined) {
    return fail('invalid_number', 'target_volume_l and scale_factor must be numbers');
  }

  // Schedule: read from Postgres in this transaction; any client-sent steps are ignored.
  var steps = [];
  var snapshot = '';
  if (!isPending) {
    var schedule = await schedulePg.getSchedule(client, String(p.schedule_id));
    if (!schedule) return fail('not_found', 'Schedule not found: ' + p.schedule_id);
    snapshot = schedule.steps || '[]';
    steps = Array.isArray(schedule.steps_parsed) ? schedule.steps_parsed : [];
  }

  // Location lock first, then the conflict check (both before any write).
  if (p.vessel_id) {
    await lock(client, 'loc|' + str(p.vessel_id) + '|' + str(p.shelf_id) + '|' + str(p.bin_id));
    var conflict = await batchRead.findLocationConflict(client,
      { vessel_id: p.vessel_id, shelf_id: p.shelf_id, bin_id: p.bin_id }, '');
    if (conflict) return fail('location_conflict', 'Location already in use by batch ' + conflict);
  }

  var invoice = p.zoho_so_number ? String(p.zoho_so_number).trim() : '';
  var sku = p.product_sku ? String(p.product_sku).trim() : '';
  var unitSeq = null;
  var fingerprint = '';

  if (p.zoho_so_number) {
    await lock(client, invoice + '|' + sku);
    var existing = await client.query(sku ? INVOICE_SKU_SQL : INVOICE_ONLY_SQL,
      sku ? [invoice, sku] : [invoice]);
    var existingIds = ids(existing);
    var dedup = batchRules.dedupDecision(existingIds, p);
    if (dedup) return dedup;
    if (sku) unitSeq = existingIds.length + 1;
  } else {
    fingerprint = batchRules.manualCreateFingerprint(actor, p);
    await lock(client, 'fp|' + fingerprint);
    var hit = await client.query(DEDUP_LOOKUP_SQL, [fingerprint, new Date(now.getTime() - windowMs)]);
    if (hit.rows.length > 0) return replayResult(client, hit.rows[0]);
  }

  var token = crypto.randomBytes(16).toString('hex');
  var fermStarted = isPending ? null : (startDate ? new Date(startDate + 'T00:00:00.000Z') : now);
  var snapshotRecipe = p.recipe_snapshot === undefined || p.recipe_snapshot === null ? '' :
    (typeof p.recipe_snapshot === 'string' ? p.recipe_snapshot : JSON.stringify(p.recipe_snapshot));

  var values = [
    isPending ? 'pending' : 'primary',
    sanitizeInput(p.product_sku),
    sanitizeInput(p.product_name || ''),
    sanitizeInput(p.customer_id || ''),
    sanitizeInput(p.customer_name),
    sanitizeInput(p.customer_firstname || ''),
    sanitizeInput(p.customer_lastname || ''),
    sanitizeInput(p.source === 'kiosk' ? '' : (p.customer_email || '')),
    startDate || null,
    p.schedule_id ? String(p.schedule_id) : null,
    snapshot,
    sanitizeInput(p.vessel_id || ''),
    sanitizeInput(p.shelf_id || ''),
    sanitizeInput(p.bin_id || ''),
    sanitizeInput(p.notes || ''),
    token,
    sanitizeInput(p.reservation_id || ''),
    now,
    actor,
    now,
    sanitizeInput(p.source || 'manual'),
    sanitizeInput(p.zoho_so_number || ''),
    fermStarted,
    sanitizeInput(p.recipe_id || ''),
    snapshotRecipe,
    targetVolume,
    scaleFactor,
    unitSeq
  ];

  // Savepoint so a unit_seq collision can be reported as a business rejection without
  // aborting the caller's transaction.
  await client.query('savepoint batch_create_insert');
  var batchId;
  try {
    var ins = await client.query(INSERT_BATCH_SQL, values);
    batchId = ins.rows[0].batch_id;
    await client.query('release savepoint batch_create_insert');
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'batches_unit_seq_idx') {
      await client.query('rollback to savepoint batch_create_insert');
      var again = await client.query(INVOICE_SKU_SQL, [invoice, sku]);
      return duplicateEnvelope(ids(again), p);
    }
    throw err;
  }

  var tasksCreated = 0;
  var vesselApplied = [];
  if (!isPending) {
    tasksCreated = await insertChildren(client, batchId, steps, p, startDate, actor, now);
    if (p.vessel_id) {
      var applied = await vesselPg.applyStatusChanges(client,
        [{ vessel_id: sanitizeInput(p.vessel_id), status: 'In-Use' }], { actor: actor, now: now });
      vesselApplied = applied.applied || [];
    }
  }

  if (fingerprint) await client.query(DEDUP_UPSERT_SQL, [fingerprint, batchId, now]);

  var out = { ok: true, batch_id: batchId, access_token: token, tasks_created: tasksCreated };
  if (isPending) out.status = 'pending';
  out._batchId = batchId;
  out._vesselApplied = vesselApplied;
  return out;
}

module.exports = {
  createBatch: createBatch,
  DEFAULT_REPLAY_WINDOW_MS: DEFAULT_REPLAY_WINDOW_MS
};

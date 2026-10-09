'use strict';

/**
 * Batch rules: pure ES5 ports of the Apps Script batch shaping and decision logic in
 * apps-script/adminApi.gs. Phase 87 Plan 03 (DB-06).
 *
 * Behavioural identity with adminApi.gs is the requirement, not improvement. Parity is proven
 * by __tests__/batch-rules.test.js against __tests__/fixtures/batches/golden.json, which holds
 * the output of the REAL adminApi.gs functions run over a synthetic workbook
 * (tests/frontend/adminapi-batch-golden.test.js). If a golden case cannot be matched, the golden
 * is right: fix the rule, never the fixture.
 *
 * Inputs are Postgres-shaped rows (DDL column names; `date` columns as a local-midnight Date as
 * node-pg returns them or as 'YYYY-MM-DD'; timestamptz as Date or ISO string; numeric as number
 * or string). Outputs are the sheet-shaped objects the clients already consume.
 *
 * Pure module: requires only ./recipe-rules and node crypto. No I/O, no logging.
 */

var crypto = require('crypto');
var recipeRules = require('./recipe-rules');

// ─── Column lists (sheet header order; DDL name derived by ddlColumn) ───────

var BATCH_COLUMNS = [
  'batch_id', 'status', 'product_sku', 'product_name', 'customer_id', 'customer_name',
  'customer_email', 'start_date', 'schedule_id', 'schedule_snapshot', 'vessel_id', 'shelf_id',
  'bin_id', 'notes', 'access_token', 'reservation_id', 'created_at', 'created_by',
  'last_updated', 'last_regenerated_at', 'source', 'zoho_so_number', 'fermentation_started_at',
  'completed_at', 'customer_firstname', 'customer_lastname', 'recipe_id', 'customer_phone',
  'target_volume_L', 'scale_factor', 'recipe_snapshot', 'bottling_invite_sent_at',
  'bottling_invite_email'
];

var TASK_COLUMNS = [
  'task_id', 'batch_id', 'step_number', 'title', 'description', 'day_offset', 'due_date',
  'is_packaging', 'is_transfer', 'completed', 'completed_at', 'completed_by', 'notes',
  'last_updated'
];

var READING_COLUMNS = [
  'reading_id', 'batch_id', 'timestamp', 'degrees_plato', 'notes', 'recorded_by', 'created_at',
  'temperature', 'ph'
];

var HISTORY_COLUMNS = [
  'history_id', 'batch_id', 'vessel_id', 'shelf_id', 'bin_id', 'transferred_at',
  'transferred_by', 'notes'
];

/** Sheet header key -> DDL column name (lower case; the sheet's `timestamp` is `reading_at`). */
function ddlColumn(key) {
  return key === 'timestamp' ? 'reading_at' : String(key).toLowerCase();
}

// ─── Value helpers ─────────────────────────────────────────────────────────

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** `date` column -> 'YYYY-MM-DD' ('' when blank). A Date is read with local getters (node-pg). */
function dateOnly(v) {
  if (isBlank(v)) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  }
  var s = String(v).substring(0, 10);
  // Sheets empty-date artifacts (toDateOnly in adminApi.gs)
  if (s === '1899-12-30' || s === '1899-12-31') return '';
  return s;
}

/** timestamptz -> full ISO string ('' when blank). */
function isoStamp(v) {
  if (isBlank(v)) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
}

/** numeric -> Number ('' when blank). */
function num(v) {
  if (isBlank(v)) return '';
  return Number(v);
}

function text(v) {
  return isBlank(v) ? '' : v;
}

/** bin_id is stored as text and emitted as a JSON number when numeric (87-DESIGN Q4). */
function binOut(v) {
  if (isBlank(v)) return '';
  var s = String(v);
  return /^[0-9]+$/.test(s) ? Number(s) : s;
}

/** First 10 chars of a stringified value, '' when blank (detail/public truncations). */
function day10(v) {
  return isBlank(v) ? '' : String(v).substring(0, 10);
}

function isTrue(v) {
  var x = String(v).trim().toLowerCase();
  return x === 'true' || x === '1' || x === 'yes';
}

function lower(v) {
  return String(v || '').toLowerCase();
}

function idNumber(id) {
  var m = /(\d+)$/.exec(String(id || ''));
  return m ? parseInt(m[1], 10) : 0;
}

/** Stable id order (numeric suffix, then string) so sheet row order is reproduced. */
function byIdField(field) {
  return function (a, b) {
    var d = idNumber(a[field]) - idNumber(b[field]);
    if (d !== 0) return d;
    var x = String(a[field] || '');
    var y = String(b[field] || '');
    return x < y ? -1 : (x > y ? 1 : 0);
  };
}

function sortedById(rows, field) {
  return (rows || []).slice().sort(byIdField(field));
}

function copy(obj) {
  var out = {};
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

// ─── Row serializers (PG row -> sheet-shaped object) ───────────────────────

var BATCH_TS = { created_at: 1, last_updated: 1, last_regenerated_at: 1, fermentation_started_at: 1,
  completed_at: 1, bottling_invite_sent_at: 1 };

function serializeBatch(row) {
  var out = {};
  for (var i = 0; i < BATCH_COLUMNS.length; i++) {
    var key = BATCH_COLUMNS[i];
    var v = row[ddlColumn(key)];
    if (key === 'start_date') out[key] = dateOnly(v);
    else if (BATCH_TS[key]) out[key] = isoStamp(v);
    else if (key === 'target_volume_L' || key === 'scale_factor') out[key] = num(v);
    else if (key === 'bin_id') out[key] = binOut(v);
    else out[key] = text(v);
  }
  return out;
}

function serializeTask(row) {
  var out = {};
  for (var i = 0; i < TASK_COLUMNS.length; i++) {
    var key = TASK_COLUMNS[i];
    var v = row[key];
    if (key === 'step_number' || key === 'day_offset') out[key] = num(v);
    else if (key === 'due_date') out[key] = dateOnly(v);
    else if (key === 'completed_at' || key === 'last_updated') out[key] = isoStamp(v);
    else if (key === 'is_packaging' || key === 'is_transfer' || key === 'completed') out[key] = !!v;
    else out[key] = text(v);
  }
  return out;
}

function serializeReading(row) {
  var out = {};
  for (var i = 0; i < READING_COLUMNS.length; i++) {
    var key = READING_COLUMNS[i];
    var v = row[ddlColumn(key)];
    if (key === 'timestamp' || key === 'created_at') out[key] = isoStamp(v);
    else if (key === 'degrees_plato' || key === 'temperature' || key === 'ph') out[key] = num(v);
    else out[key] = text(v);
  }
  return out;
}

function serializeHistory(row) {
  var out = {};
  for (var i = 0; i < HISTORY_COLUMNS.length; i++) {
    var key = HISTORY_COLUMNS[i];
    var v = row[key];
    if (key === 'transferred_at') out[key] = isoStamp(v);
    else if (key === 'bin_id') out[key] = binOut(v);
    else out[key] = text(v);
  }
  return out;
}

/** List rows never expose the access token (getBatches deletes it). */
function stripForList(batch) {
  var out = copy(batch);
  delete out.access_token;
  return out;
}

/** Public view strips customer_email, reservation_id, access_token only (D-14 parity, Q17). */
function stripForPublic(batch) {
  var out = copy(batch);
  delete out.customer_email;
  delete out.reservation_id;
  delete out.access_token;
  return out;
}

// ─── Status, vessel and location rules ─────────────────────────────────────

function isActiveStatus(status) {
  var s = lower(status);
  return s === 'primary' || s === 'secondary';
}

var UPDATE_STATUSES = ['primary', 'secondary', 'complete', 'disabled'];

function validateUpdateStatus(status) {
  var s = String(status).toLowerCase();
  if (UPDATE_STATUSES.indexOf(s) === -1) {
    return {
      ok: false,
      error: 'invalid_status',
      message: 'Invalid status: ' + status + '. Must be one of: ' + UPDATE_STATUSES.join(', ')
    };
  }
  return { ok: true, status: s };
}

/** Vessel flips when a batch changes status (updateBatch): leaving active frees, entering occupies. */
function vesselChangesForStatus(oldStatus, newStatus, vesselId) {
  var vessel = String(vesselId || '');
  if (!vessel) return [];
  var wasActive = isActiveStatus(oldStatus);
  var isActive = isActiveStatus(newStatus);
  if (wasActive && !isActive) return [{ vessel_id: vessel, status: 'Empty' }];
  if (!wasActive && isActive) return [{ vessel_id: vessel, status: 'In-Use' }];
  return [];
}

/** Vessel flips when a batch moves vessel (updateBatch): old to Empty, new to In-Use. */
function vesselChangesForLocation(oldVessel, newVessel) {
  var from = String(oldVessel || '');
  var to = String(newVessel || '');
  var out = [];
  if (from === to) return out;
  if (from) out.push({ vessel_id: from, status: 'Empty' });
  if (to) out.push({ vessel_id: to, status: 'In-Use' });
  return out;
}

/** Completing a transfer task advances a primary batch to secondary. */
function statusAfterTransfer(status) {
  return lower(status) === 'primary' ? 'secondary' : status;
}

/**
 * Port of checkLocationConflict: the first primary/secondary batch (other than excludeBatchId)
 * occupying vessel+shelf+bin, or ''. Rows are PG rows in batch order.
 */
function findLocationConflict(batchRows, vesselId, shelfId, binId, excludeBatchId) {
  if (!vesselId) return '';
  var rows = sortedById(batchRows, 'batch_id');
  for (var i = 0; i < rows.length; i++) {
    var b = rows[i];
    if (excludeBatchId && String(b.batch_id) === String(excludeBatchId)) continue;
    if (!isActiveStatus(b.status)) continue;
    if (String(b.vessel_id || '') === String(vesselId) &&
        String(b.shelf_id || '') === String(shelfId || '') &&
        String(b.bin_id || '') === String(binId || '')) {
      return String(b.batch_id);
    }
  }
  return '';
}

// ─── Dedup (D-15) ──────────────────────────────────────────────────────────

/**
 * Port of batchDedupDecision. `existing` is either the full Batches rows (objects with batch_id,
 * zoho_so_number, product_sku; filtered here exactly as the script does) or the ids of rows a SQL
 * count already matched (strings). Returns null when the create is allowed, or the exact
 * duplicate_so_number object (bulk-create depends on the message text).
 */
function dedupDecision(existing, payload) {
  var rows = existing || [];
  var invoice = payload.zoho_so_number ? String(payload.zoho_so_number).trim() : '';
  var sku = payload.product_sku ? String(payload.product_sku).trim() : '';
  var i;

  if (payload.zoho_so_number && payload.product_sku) {
    var allowedUnits = Math.floor(Number(payload.unit_total));
    if (!isFinite(allowedUnits) || allowedUnits < 1) allowedUnits = 1; // legacy callers

    var matching = [];
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (typeof r === 'string') {
        matching.push(r);
      } else if (String(r.zoho_so_number || '').trim() === invoice &&
                 String(r.product_sku || '').trim() === sku) {
        matching.push(r.batch_id);
      }
    }
    if (matching.length >= allowedUnits) {
      return {
        ok: false,
        error: 'duplicate_so_number',
        message: 'SO/invoice ' + payload.zoho_so_number + ' + SKU ' + payload.product_sku +
                 ' already has ' + matching.length + ' of ' + allowedUnits +
                 ' batch(es): ' + matching.join(', ')
      };
    }
  } else if (payload.zoho_so_number && !payload.product_sku) {
    for (i = 0; i < rows.length; i++) {
      var q = rows[i];
      if (typeof q === 'string') {
        return {
          ok: false,
          error: 'duplicate_so_number',
          message: 'A batch for SO/invoice ' + payload.zoho_so_number + ' already exists: ' + q
        };
      }
      if (String(q.zoho_so_number || '').trim() === invoice) {
        return {
          ok: false,
          error: 'duplicate_so_number',
          message: 'A batch for SO/invoice ' + payload.zoho_so_number + ' already exists: ' + q.batch_id
        };
      }
    }
  }
  return null;
}

var FINGERPRINT_FIELDS = ['product_sku', 'recipe_id', 'customer_name', 'start_date', 'schedule_id',
  'vessel_id', 'shelf_id', 'bin_id', 'notes'];

/**
 * sha256 hex over actor|product_sku|recipe_id|customer_name|start_date|schedule_id|vessel_id|
 * shelf_id|bin_id|notes (87-DESIGN Section 11). Missing fields count as ''.
 */
function manualCreateFingerprint(actor, payload) {
  var p = payload || {};
  var parts = [actor === null || actor === undefined ? '' : String(actor)];
  for (var i = 0; i < FINGERPRINT_FIELDS.length; i++) {
    var v = p[FINGERPRINT_FIELDS[i]];
    parts.push(v === null || v === undefined ? '' : String(v));
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ─── Due date ──────────────────────────────────────────────────────────────

/**
 * Port of calculateDueDate: start date plus day_offset days as 'YYYY-MM-DD'; '' for a negative
 * offset (TBD packaging). Built from y/m/d parts in UTC so a DST change cannot shift the day.
 */
function calculateDueDate(startDateStr, dayOffset) {
  var offset = Number(dayOffset);
  if (dayOffset < 0) return '';
  if (!isFinite(offset)) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startDateStr || ''));
  if (!m) return '';
  var t = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10) + offset);
  var d = new Date(t);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

// ─── Reading validators ────────────────────────────────────────────────────

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

/** A real calendar date in YYYY-MM-DD form (the script only checked the shape). */
function isCalendarDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return false;
  var y = parseInt(m[1], 10);
  var mo = parseInt(m[2], 10);
  var d = parseInt(m[3], 10);
  var t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function parsedOrBlank(v) {
  return (v !== undefined && v !== null && v !== '') ? parseFloat(v) : '';
}

/** Port of the addPlatoReading validators (same order, same messages). */
function validateReading(payload) {
  var p = payload || {};
  var plato = parsedOrBlank(p.degrees_plato);
  if (plato !== '' && (isNaN(plato) || plato > 40)) {
    return fail('invalid_value', 'degrees_plato must be 40 or less');
  }
  var temperature = parsedOrBlank(p.temperature);
  var ph = parsedOrBlank(p.ph);
  if (plato === '' && temperature === '' && ph === '') {
    return fail('invalid_input', 'At least one of degrees_plato, temperature, or ph is required');
  }
  if (p.timestamp && !isCalendarDate(p.timestamp)) {
    return fail('invalid_value', 'timestamp must be YYYY-MM-DD format');
  }
  if (temperature !== '' && isNaN(temperature)) {
    return fail('invalid_value', 'temperature must be a number');
  }
  if (ph !== '' && (isNaN(ph) || ph < 0 || ph > 14)) {
    return fail('invalid_value', 'ph must be a number between 0 and 14');
  }
  return {
    ok: true,
    degrees_plato: plato === '' ? null : plato,
    temperature: temperature === '' ? null : temperature,
    ph: ph === '' ? null : ph,
    timestamp: p.timestamp ? String(p.timestamp) : ''
  };
}

/** Port of the updatePlatoReading validators. */
function validateReadingUpdate(updates) {
  var u = updates || {};
  if (u.degrees_plato !== undefined) {
    var plato = parseFloat(u.degrees_plato);
    if (isNaN(plato) || plato > 40) return fail('invalid_value', 'degrees_plato must be 40 or less');
  }
  if (u.timestamp !== undefined && u.timestamp !== '' && !isCalendarDate(u.timestamp)) {
    return fail('invalid_value', 'timestamp must be YYYY-MM-DD format');
  }
  if (u.temperature !== undefined && u.temperature !== '') {
    if (isNaN(parseFloat(u.temperature))) return fail('invalid_value', 'temperature must be a number');
  }
  if (u.ph !== undefined && u.ph !== '') {
    var ph = parseFloat(u.ph);
    if (isNaN(ph) || ph < 0 || ph > 14) return fail('invalid_value', 'ph must be a number between 0 and 14');
  }
  return { ok: true };
}

// ─── Read builders ─────────────────────────────────────────────────────────

/** { batch_id: {total, done} } from BatchTasks rows. */
function taskCountsByBatch(taskRows) {
  var counts = {};
  (taskRows || []).forEach(function (t) {
    var bid = String(t.batch_id);
    if (!counts[bid]) counts[bid] = { total: 0, done: 0 };
    counts[bid].total++;
    if (t.completed === true || String(t.completed).toUpperCase() === 'TRUE') counts[bid].done++;
  });
  return counts;
}

/**
 * Port of getBatches. `batchRows` = all Batches rows; opts: { status, limit, offset, total }.
 * `total` defaults to the number of rows given (the script reports the unfiltered count).
 */
function buildBatchList(batchRows, taskCounts, opts) {
  var o = opts || {};
  var limit = Number(o.limit) || 0;
  var offset = Number(o.offset) || 0;
  var status = o.status;
  var counts = taskCounts || {};

  var batches = sortedById(batchRows, 'batch_id').map(serializeBatch);
  var total = o.total !== undefined && o.total !== null ? o.total : batches.length;

  if (status && status !== 'all') {
    if (status === 'active') {
      batches = batches.filter(function (b) {
        var s = lower(b.status);
        return s === 'primary' || s === 'secondary' || s === 'pending';
      });
    } else {
      batches = batches.filter(function (b) { return lower(b.status) === String(status).toLowerCase(); });
    }
  }
  var filtered = batches.length;

  batches.forEach(function (b) {
    var c = counts[String(b.batch_id)] || { total: 0, done: 0 };
    b.tasks_total = c.total;
    b.tasks_done = c.done;
  });

  batches.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  if (limit > 0) batches = batches.slice(offset, offset + limit);
  else if (offset > 0) batches = batches.slice(offset);

  return { batches: batches.map(stripForList), total: total, filtered: filtered };
}

function parseSnapshot(batch) {
  if (batch.schedule_snapshot && typeof batch.schedule_snapshot === 'string') {
    var parsed;
    try { parsed = JSON.parse(batch.schedule_snapshot); } catch (err) { return err && undefined; } // leave unparsed
    batch.schedule_snapshot_parsed = parsed;
  }
}

function detailChildren(taskRows, readingRows, historyRows) {
  var tasks = sortedById(taskRows, 'task_id').map(serializeTask);
  tasks.forEach(function (t) {
    if (t.completed_at) t.completed_at = day10(t.completed_at);
  });
  tasks.sort(function (a, b) { return (Number(a.step_number) || 0) - (Number(b.step_number) || 0); });

  var readings = sortedById(readingRows, 'reading_id').map(serializeReading);
  readings.forEach(function (r) {
    if (r.timestamp) r.timestamp = day10(r.timestamp);
  });
  readings.sort(function (a, b) { return String(a.timestamp || '').localeCompare(String(b.timestamp || '')); });

  var history = sortedById(historyRows, 'history_id').map(serializeHistory);
  history.forEach(function (h) {
    if (h.transferred_at) h.transferred_at = day10(h.transferred_at);
  });
  history.sort(function (a, b) { return String(b.transferred_at || '').localeCompare(String(a.transferred_at || '')); });

  return { tasks: tasks, plato_readings: readings, vessel_history: history };
}

/** Port of getBatchDetail. A missing batchRow yields the script's not-found object. */
function buildBatchDetail(batchId, batchRow, taskRows, readingRows, historyRows) {
  if (!batchId) return { error: 'batch_id required' };
  if (!batchRow) return { error: 'Batch not found: ' + batchId };

  var batch = serializeBatch(batchRow);
  parseSnapshot(batch);
  var kids = detailChildren(taskRows, readingRows, historyRows);
  return { batch: batch, tasks: kids.tasks, plato_readings: kids.plato_readings, vessel_history: kids.vessel_history };
}

/** Constant-time string equality on equal-length strings (false on length mismatch). */
function safeEqual(a, b) {
  var x = Buffer.from(String(a));
  var y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Port of handleGetBatchPublic (87-DESIGN Section 8): format pre-check, not_found, constant-time
 * token compare, disabled check, then the detail shape minus customer_email/reservation_id/token.
 */
function buildPublicView(batchId, token, batchRow, taskRows, readingRows, historyRows) {
  if (!batchId || !token) {
    return { ok: false, error: 'invalid_token', message: 'batch_id and token are required' };
  }
  if (!/^SV-B-[0-9]{6,}$/.test(batchId) || !/^[0-9a-f]{32}$/.test(token)) {
    return { ok: false, error: 'invalid_token', message: 'Invalid batch ID or token format' };
  }
  if (!batchRow) {
    return { ok: false, error: 'not_found', message: 'Batch not found' };
  }
  if (!safeEqual(batchRow.access_token, token)) {
    return { ok: false, error: 'invalid_token', message: 'Invalid access token' };
  }
  if (lower(batchRow.status) === 'disabled') {
    return { ok: false, error: 'batch_disabled', message: 'This batch is no longer active' };
  }

  var batch = stripForPublic(serializeBatch(batchRow));
  parseSnapshot(batch);
  var kids = detailChildren(taskRows, readingRows, historyRows);
  return {
    ok: true,
    data: { batch: batch, tasks: kids.tasks, plato_readings: kids.plato_readings, vessel_history: kids.vessel_history }
  };
}

function activeBatchMap(batchRows) {
  var map = {};
  (batchRows || []).forEach(function (b) {
    if (isActiveStatus(b.status)) map[String(b.batch_id)] = serializeBatch(b);
  });
  return map;
}

/** Port of getTasksCalendar. */
function buildCalendar(taskRows, batchRows, startDate, endDate) {
  if (!startDate || !endDate) return { tasks: [] };

  var tasks = sortedById(taskRows, 'task_id').map(serializeTask);
  var batchMap = activeBatchMap(batchRows);

  var groups = {};
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!batchMap[bid]) return;
    if (!groups[bid]) groups[bid] = { allDone: true };
    if (!t.is_packaging && !t.completed) groups[bid].allDone = false;
  });

  var result = [];
  tasks.forEach(function (t) {
    var batch = batchMap[String(t.batch_id)];
    if (!batch) return;

    var dueDate = t.due_date;
    if (dueDate && (dueDate < startDate || dueDate > endDate)) return;
    if (!dueDate && t.is_packaging) {
      if (!groups[String(t.batch_id)] || !groups[String(t.batch_id)].allDone) return;
    }
    if (!dueDate && !t.is_packaging) return;

    result.push({
      task_id: t.task_id,
      batch_id: t.batch_id,
      product_name: batch.product_name || '',
      customer_name: batch.customer_name || '',
      customer_firstname: batch.customer_firstname || '',
      customer_lastname: batch.customer_lastname || '',
      vessel_id: batch.vessel_id || '',
      shelf_id: batch.shelf_id || '',
      title: t.title || '',
      due_date: dueDate,
      completed: t.completed,
      is_packaging: t.is_packaging,
      is_transfer: t.is_transfer
    });
  });
  return { tasks: result };
}

/** Port of getTasksUpcoming (dated ascending, undated last, ties by task_id). */
function buildUpcoming(taskRows, batchRows, limit) {
  var tasks = sortedById(taskRows, 'task_id').map(serializeTask);
  var batchMap = activeBatchMap(batchRows);

  var result = [];
  tasks.forEach(function (t) {
    var batch = batchMap[String(t.batch_id)];
    if (!batch) return;
    if (t.completed) return;
    result.push({
      task_id: t.task_id,
      batch_id: t.batch_id,
      product_name: batch.product_name || '',
      customer_name: batch.customer_name || '',
      customer_firstname: batch.customer_firstname || '',
      customer_lastname: batch.customer_lastname || '',
      vessel_id: batch.vessel_id || '',
      shelf_id: batch.shelf_id || '',
      bin_id: batch.bin_id || '',
      title: t.title || '',
      description: t.description || '',
      due_date: t.due_date,
      is_packaging: t.is_packaging,
      is_transfer: t.is_transfer
    });
  });

  result.sort(function (a, b) {
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  });

  return { tasks: result.slice(0, limit) };
}

// ─── Dashboard ─────────────────────────────────────────────────────────────

var MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zoneParts(date, timezone) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  var out = {};
  parts.forEach(function (p) { out[p.type] = p.value; });
  return out;
}

function formatDay(date, timezone) {
  var p = zoneParts(date, timezone);
  return p.year + '-' + p.month + '-' + p.day;
}

function toDate(now) {
  if (now instanceof Date) return now;
  if (now === undefined || now === null) return new Date();
  return new Date(now);
}

/**
 * Port of getBatchDashboardSummary. rows = { batches, tasks } (PG rows); opts = { now, timezone }.
 * `today`, the 7 day window and the month keys are computed in the injected timezone
 * (the Apps Script project zone, 87-DESIGN Q3). The week end keeps the script's
 * now + 7*24h arithmetic.
 */
function buildDashboardSummary(rows, opts) {
  var o = opts || {};
  var timezone = o.timezone || 'America/Vancouver';
  var nowDate = toDate(o.now);
  var today = formatDay(nowDate, timezone);
  var weekEnd = formatDay(new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1000), timezone);

  var batches = sortedById((rows && rows.batches) || [], 'batch_id').map(serializeBatch);
  var tasks = sortedById((rows && rows.tasks) || [], 'task_id').map(serializeTask);

  var summary = {
    primaryCount: 0,
    secondaryCount: 0,
    completeCount: 0,
    disabledCount: 0,
    overdueTasks: 0,
    tasksDueToday: 0,
    tasksDueThisWeek: 0,
    readyForPackaging: 0,
    pendingCount: 0
  };

  var activeBatchIds = {};
  var batchMeta = {};
  var needsScheduling = [];
  batches.forEach(function (b) {
    var bid = String(b.batch_id);
    var s = lower(b.status);
    var displayName = String(b.customer_name || ((b.customer_firstname || '') + ' ' + (b.customer_lastname || ''))).trim();
    if (s === 'primary' || s === 'secondary') {
      if (s === 'primary') summary.primaryCount++; else summary.secondaryCount++;
      activeBatchIds[bid] = true;
      batchMeta[bid] = {
        batch_id: bid,
        status: s,
        product_name: b.product_name || '',
        customer_name: displayName,
        customer_email: String(b.customer_email || '').trim(),
        vessel_id: b.vessel_id || '',
        shelf_id: b.shelf_id || ''
      };
    } else if (s === 'complete') {
      summary.completeCount++;
    } else if (s === 'disabled') {
      summary.disabledCount++;
    } else if (s === 'pending') {
      summary.pendingCount++;
      needsScheduling.push({
        batch_id: bid,
        product_name: b.product_name || '',
        customer_name: displayName,
        source: b.source || '',
        zoho_so_number: b.zoho_so_number || '',
        created_at: b.created_at || '',
        last_updated: b.last_updated || ''
      });
    }
  });

  var pkgByBatch = {};
  var pkgOrder = [];
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!activeBatchIds[bid]) return;

    var done = isTrue(t.completed);
    var isPkg = isTrue(t.is_packaging);
    var dueDate = String(t.due_date || '').trim();
    if (dueDate.length > 10) dueDate = dueDate.substring(0, 10);

    if (!done) {
      if (dueDate && dueDate < today) summary.overdueTasks++;
      if (dueDate === today) summary.tasksDueToday++;
      if (dueDate && dueDate >= today && dueDate <= weekEnd) summary.tasksDueThisWeek++;
    }

    if (!pkgByBatch[bid]) {
      pkgByBatch[bid] = { hasIncPkg: false, allNonPkgDone: true, pkgDue: '' };
      pkgOrder.push(bid);
    }
    if (isPkg) {
      if (!done) {
        pkgByBatch[bid].hasIncPkg = true;
        if (dueDate && (!pkgByBatch[bid].pkgDue || dueDate < pkgByBatch[bid].pkgDue)) {
          pkgByBatch[bid].pkgDue = dueDate;
        }
      }
    } else if (!done) {
      pkgByBatch[bid].allNonPkgDone = false;
    }
  });

  var readyToBottle = [];
  pkgOrder.forEach(function (bid) {
    var st = pkgByBatch[bid];
    var meta = batchMeta[bid];
    if (!meta || !st.hasIncPkg) return;
    var due = st.pkgDue;
    var dueReached = !!due && due <= today;
    if (st.allNonPkgDone || dueReached) {
      readyToBottle.push({
        batch_id: meta.batch_id,
        product_name: meta.product_name,
        customer_name: meta.customer_name,
        vessel_id: meta.vessel_id,
        shelf_id: meta.shelf_id,
        status: meta.status,
        bottling_due: due || '',
        overdue: !!due && due < today,
        has_email: !!meta.customer_email
      });
    }
  });

  readyToBottle.sort(function (a, b) {
    var ad = a.bottling_due || '9999-12-31';
    var bd = b.bottling_due || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.batch_id).localeCompare(String(b.batch_id));
  });

  summary.readyForPackaging = readyToBottle.length;
  summary.readyToBottle = readyToBottle;

  needsScheduling.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  summary.needsScheduling = needsScheduling;

  var nowParts = zoneParts(nowDate, timezone);
  var nowYear = parseInt(nowParts.year, 10);
  var nowMonth = parseInt(nowParts.month, 10) - 1;
  var monthKeys = [];
  var monthCounts = {};
  for (var mi = 5; mi >= 0; mi--) {
    var idx = nowYear * 12 + nowMonth - mi;
    var y = Math.floor(idx / 12);
    var m = idx - y * 12;
    var key = y + '-' + pad2(m + 1);
    monthKeys.push({ month: key, label: MONTH_LABELS[m] });
    monthCounts[key] = 0;
  }
  batches.forEach(function (b) {
    var sd = String(b.start_date || '').trim();
    if (sd.length >= 7) {
      var k = sd.substring(0, 7);
      if (Object.prototype.hasOwnProperty.call(monthCounts, k)) monthCounts[k]++;
    }
  });
  summary.batchesByMonth = monthKeys.map(function (mk) {
    return { month: mk.month, label: mk.label, count: monthCounts[mk.month] };
  });

  return summary;
}

module.exports = {
  BATCH_COLUMNS: BATCH_COLUMNS,
  TASK_COLUMNS: TASK_COLUMNS,
  READING_COLUMNS: READING_COLUMNS,
  HISTORY_COLUMNS: HISTORY_COLUMNS,
  ddlColumn: ddlColumn,
  sanitizeInput: recipeRules.sanitizeInput,
  serializeBatch: serializeBatch,
  serializeTask: serializeTask,
  serializeReading: serializeReading,
  serializeHistory: serializeHistory,
  stripForList: stripForList,
  stripForPublic: stripForPublic,
  dedupDecision: dedupDecision,
  calculateDueDate: calculateDueDate,
  isActiveStatus: isActiveStatus,
  validateUpdateStatus: validateUpdateStatus,
  vesselChangesForStatus: vesselChangesForStatus,
  vesselChangesForLocation: vesselChangesForLocation,
  statusAfterTransfer: statusAfterTransfer,
  findLocationConflict: findLocationConflict,
  validateReading: validateReading,
  validateReadingUpdate: validateReadingUpdate,
  taskCountsByBatch: taskCountsByBatch,
  buildDashboardSummary: buildDashboardSummary,
  buildCalendar: buildCalendar,
  buildUpcoming: buildUpcoming,
  buildBatchList: buildBatchList,
  buildBatchDetail: buildBatchDetail,
  buildPublicView: buildPublicView,
  manualCreateFingerprint: manualCreateFingerprint
};

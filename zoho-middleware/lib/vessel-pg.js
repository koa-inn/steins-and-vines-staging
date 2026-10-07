'use strict';

/**
 * Atomic Postgres vessel operations — Phase 86 Plan 05 (DB-05, ROADMAP SC2, D-06/D-07/D-08/D-16/D-17).
 *
 * This module never requires 'pg' and never creates a pool — every function receives the
 * transaction `client` from the caller (lib/db.js's withTransaction()). Pure atomic layer; the
 * facade composes it.
 *
 * All SQL uses $n placeholders only (ASVS V5). SQL text lives in module-level constants and the
 * dynamic SET clause is built from fixed allow-lists, never from payload keys. Business rejections
 * resolve `{ok:false, error, message}`; infrastructure errors propagate so the transaction rolls
 * back. Underscore-prefixed result keys (_vesselId) are for the facade/mirror and are stripped there.
 *
 * Reads match the Apps Script get_vessels shape: sheet keys in sheet order, numbers as JS numbers,
 * NULL as '', plus label / archived / updated_at / position. Archived rows serialise with status
 * 'Disabled/Retired' so existing dropdown filters hide them while old batches still resolve them.
 *
 * There is deliberately NO delete function (D-07): vessels are archived, never removed.
 */

var recipeRules = require('./recipe-rules');
var staleToken = require('./stale-token');

// Sheet column order = JSON key order.
var VESSEL_SHEET_COLUMNS = [
  'vessel_id', 'type', 'material', 'capacity_liters', 'status',
  'bottom_diameter_cm', 'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes'
];

var NUMERIC_COLUMNS = {
  capacity_liters: true, bottom_diameter_cm: true, top_diameter_cm: true, depth_cm: true
};

var ARCHIVED_STATUS = 'Disabled/Retired';
var ALLOWED_STATUSES = ['Empty', 'In-Use'];
var VESSEL_ID_RE = /^[A-Z]{2,6}-[0-9]{3,}$/;
var PREFIX_RE = /^[A-Z]{2,6}$/;

var STALE_MESSAGE = 'This vessel was changed since you opened it — reload to see the latest';
var IN_USE_MESSAGE = 'This vessel is in use — empty it or override its status first';

// ─── SQL (module-level constants only) ─────────────────────────────────────

var SELECT_COLUMNS =
  'vessel_id, label, type, material, capacity_liters, status, archived, bottom_diameter_cm, ' +
  'top_diameter_cm, depth_cm, location, brand, notes, position, updated_at';

var LIST_SQL = 'select ' + SELECT_COLUMNS + ' from vessels order by position asc';
var GET_SQL = 'select ' + SELECT_COLUMNS + ' from vessels where vessel_id = $1';
var LOCK_SQL = 'select ' + SELECT_COLUMNS + ' from vessels where vessel_id = $1 for update';

var INSERT_SQL =
  'insert into vessels (vessel_id, label, type, material, capacity_liters, status, ' +
  'bottom_diameter_cm, top_diameter_cm, depth_cm, location, brand, notes, ' +
  'created_at, created_by, updated_at, updated_by) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $13, $14) ' +
  'on conflict (vessel_id) do nothing returning vessel_id';

var ARCHIVE_SQL =
  'update vessels set archived = $2, updated_at = $3, updated_by = $4 where vessel_id = $1';

var STATUS_DELTA_SQL =
  'update vessels set status = $2, updated_at = $3, updated_by = $4 ' +
  'where vessel_id = $1 and status is distinct from $2';

var EXISTS_SQL = 'select 1 from vessels where vessel_id = $1';

var IDS_BY_PREFIX_SQL = 'select vessel_id from vessels where vessel_id like $1';

// Fixed column allow-lists for the dynamic SET clause (never built from payload keys).
var UPDATE_TEXT_FIELDS = ['label', 'type', 'material', 'location', 'brand', 'notes', 'status'];
var UPDATE_NUMERIC_FIELDS = ['capacity_liters', 'bottom_diameter_cm', 'top_diameter_cm', 'depth_cm'];

// ─── Serializer ────────────────────────────────────────────────────────────

function rowToVessel(row) {
  var out = {};
  for (var i = 0; i < VESSEL_SHEET_COLUMNS.length; i++) {
    var col = VESSEL_SHEET_COLUMNS[i];
    var v = row[col];
    if (col === 'status' && row.archived) {
      out[col] = ARCHIVED_STATUS;
    } else if (v === null || v === undefined) {
      out[col] = '';
    } else if (NUMERIC_COLUMNS[col]) {
      out[col] = Number(v);
    } else {
      out[col] = v;
    }
  }
  out.label = row.label === null || row.label === undefined ? '' : row.label;
  out.archived = !!row.archived;
  out.updated_at = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  out.position = Number(row.position);
  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

/** Sanitise a text field; blank becomes null (stored NULL, serialised ''). */
function textIn(value, trim) {
  if (isBlank(value)) return null;
  var s = recipeRules.sanitizeInput(value);
  if (trim) s = s.trim();
  return s === '' ? null : s;
}

/** Returns {ok:true, value:number|null} or {ok:false}. Blank is NULL; NaN/Infinity rejected. */
function numIn(value) {
  if (isBlank(value)) return { ok: true, value: null };
  var n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (!isFinite(n) || (typeof value === 'string' && value.trim() === '')) return { ok: false };
  return { ok: true, value: n };
}

function staleResult() {
  return fail('stale_vessel', STALE_MESSAGE);
}

// ─── Reads ─────────────────────────────────────────────────────────────────

async function listVessels(client) {
  var res = await client.query(LIST_SQL);
  return res.rows.map(rowToVessel);
}

async function getVessel(client, vesselId) {
  var res = await client.query(GET_SQL, [vesselId]);
  return res.rows.length === 0 ? null : rowToVessel(res.rows[0]);
}

// ─── Create ────────────────────────────────────────────────────────────────

async function createVessel(client, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var actor = opts.actor || null;
  var now = opts.now || new Date();

  if (isBlank(payload.vessel_id)) return fail('missing_fields', 'vessel_id is required');
  var vesselId = String(payload.vessel_id).trim();
  if (!VESSEL_ID_RE.test(vesselId)) {
    return fail('invalid_vessel_id', 'vessel_id must look like PREFIX-NNN (e.g. PCB-050)');
  }
  var type = textIn(payload.type, true);
  if (type === null) return fail('missing_fields', 'type is required');

  var status = isBlank(payload.status) ? 'Empty' : String(payload.status);
  if (ALLOWED_STATUSES.indexOf(status) === -1) {
    return fail('invalid_status', 'status must be Empty or In-Use');
  }

  var nums = {};
  for (var i = 0; i < UPDATE_NUMERIC_FIELDS.length; i++) {
    var f = UPDATE_NUMERIC_FIELDS[i];
    var parsed = numIn(payload[f]);
    if (!parsed.ok) return fail('invalid_number', f + ' is not a valid number');
    nums[f] = parsed.value;
  }

  var ins = await client.query(INSERT_SQL, [
    vesselId,
    textIn(payload.label, true),
    type,
    textIn(payload.material, true),
    nums.capacity_liters,
    status,
    nums.bottom_diameter_cm,
    nums.top_diameter_cm,
    nums.depth_cm,
    textIn(payload.location, true),
    textIn(payload.brand, true),
    textIn(payload.notes, false),
    now,
    actor
  ]);
  if (ins.rowCount === 0) return fail('vessel_exists', 'Vessel already exists: ' + vesselId);

  var vessel = await getVessel(client, vesselId);
  return { ok: true, vessel_id: vesselId, vessel: vessel, _vesselId: vesselId };
}

async function nextVesselNumber(client, prefix) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) {
    throw new Error('Invalid vessel prefix: ' + prefix);
  }
  var res = await client.query(IDS_BY_PREFIX_SQL, [prefix + '-%']);
  var max = 0;
  for (var i = 0; i < res.rows.length; i++) {
    var m = /^[A-Z]{2,6}-([0-9]+)$/.exec(res.rows[i].vessel_id);
    if (m && res.rows[i].vessel_id.slice(0, prefix.length + 1) === prefix + '-') {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  var next = String(max + 1);
  while (next.length < 3) next = '0' + next;
  return prefix + '-' + next;
}

// ─── Update / archive ──────────────────────────────────────────────────────

async function updateVessel(client, vesselId, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var actor = opts.actor || null;
  var now = opts.now || new Date();

  // D-08: the id is permanent. An identical echo is tolerated; any difference is rejected.
  if (payload.vessel_id !== undefined && String(payload.vessel_id).trim() !== vesselId) {
    return fail('vessel_id_immutable', 'A vessel id cannot be changed');
  }

  // Validate everything before the lock or any write.
  var sets = [];
  var params = [vesselId];
  function addSet(col, value) {
    params.push(value);
    sets.push(col + ' = $' + params.length);
  }

  var i;
  for (i = 0; i < UPDATE_TEXT_FIELDS.length; i++) {
    var tf = UPDATE_TEXT_FIELDS[i];
    if (payload[tf] === undefined) continue;
    if (tf === 'status') {
      var st = String(payload.status);
      if (ALLOWED_STATUSES.indexOf(st) === -1) {
        return fail('invalid_status', 'status must be Empty or In-Use (use archive to retire a vessel)');
      }
      addSet('status', st);
    } else if (tf === 'type') {
      var ty = textIn(payload.type, true);
      if (ty === null) return fail('missing_fields', 'type cannot be blank');
      addSet('type', ty);
    } else {
      addSet(tf, textIn(payload[tf], tf !== 'notes'));
    }
  }
  for (i = 0; i < UPDATE_NUMERIC_FIELDS.length; i++) {
    var nf = UPDATE_NUMERIC_FIELDS[i];
    if (payload[nf] === undefined) continue;
    var parsed = numIn(payload[nf]);
    if (!parsed.ok) return fail('invalid_number', nf + ' is not a valid number');
    addSet(nf, parsed.value);
  }

  var locked = await client.query(LOCK_SQL, [vesselId]);
  if (locked.rows.length === 0) return fail('not_found', 'Vessel not found: ' + vesselId);
  if (staleToken.isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  addSet('updated_at', now);
  addSet('updated_by', actor);
  await client.query('update vessels set ' + sets.join(', ') + ' where vessel_id = $1', params);

  return { ok: true, vessel: await getVessel(client, vesselId), _vesselId: vesselId };
}

async function setArchived(client, vesselId, archived, opts) {
  opts = opts || {};
  var locked = await client.query(LOCK_SQL, [vesselId]);
  if (locked.rows.length === 0) return fail('not_found', 'Vessel not found: ' + vesselId);
  if (staleToken.isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();
  if (archived && locked.rows[0].status === 'In-Use') return fail('vessel_in_use', IN_USE_MESSAGE);

  await client.query(ARCHIVE_SQL, [vesselId, archived, opts.now || new Date(), opts.actor || null]);
  return { ok: true, vessel: await getVessel(client, vesselId), _vesselId: vesselId };
}

function archiveVessel(client, vesselId, opts) {
  return setArchived(client, vesselId, true, opts);
}

function unarchiveVessel(client, vesselId, opts) {
  return setArchived(client, vesselId, false, opts);
}

// ─── Status deltas (Apps Script seam) ──────────────────────────────────────

async function applyStatusChanges(client, changes, opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var actor = opts.actor || null;
  var result = { applied: [], unchanged: [], unknown: [], invalid: [] };
  if (!Array.isArray(changes)) return result;

  for (var i = 0; i < changes.length; i++) {
    var c = changes[i] || {};
    var id = c.vessel_id;
    if (ALLOWED_STATUSES.indexOf(c.status) === -1) {
      result.invalid.push(id);
      continue;
    }
    var upd = await client.query(STATUS_DELTA_SQL, [id, c.status, now, actor]);
    if (upd.rowCount > 0) {
      result.applied.push(id);
      continue;
    }
    var exists = await client.query(EXISTS_SQL, [id]);
    (exists.rows.length > 0 ? result.unchanged : result.unknown).push(id);
  }
  return result;
}

module.exports = {
  VESSEL_SHEET_COLUMNS: VESSEL_SHEET_COLUMNS,
  rowToVessel: rowToVessel,
  listVessels: listVessels,
  getVessel: getVessel,
  createVessel: createVessel,
  updateVessel: updateVessel,
  archiveVessel: archiveVessel,
  unarchiveVessel: unarchiveVessel,
  applyStatusChanges: applyStatusChanges,
  nextVesselNumber: nextVesselNumber
};

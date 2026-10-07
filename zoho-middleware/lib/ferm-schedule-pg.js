'use strict';

/**
 * Atomic Postgres fermentation-schedule operations — Phase 86 Plan 06 (DB-05, ROADMAP SC4).
 *
 * Same module contract as lib/recipe-pg.js: every function receives the transaction `client`
 * from db.withTransaction(); $n placeholders only; business rejections resolve
 * `{ok:false, error, message}`; infrastructure errors propagate so the transaction rolls back.
 * Underscore-prefixed result keys (e.g. `_scheduleId`) are for the facade and stripped there.
 *
 * IDs come from ferm_schedule_id_seq via the column default (D-13) — the lock-free
 * max()+1 collision of the Sheets implementation cannot happen here.
 *
 * Read shape matches Apps Script get_ferm_schedules: sheet key order, `steps` as a JSON string,
 * `steps_parsed` as the array, is_active boolean, ISO-ms timestamps, '' for empty text cells.
 */

var rules = require('./ferm-schedule-rules');
var isStale = require('./stale-token').isStale;

var SCHEDULE_COLUMNS = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active',
  'created_at', 'created_by', 'updated_at', 'updated_by'
];

var STALE_MESSAGE = 'This schedule was changed since you opened it — reload to see the latest';

var SELECT_SQL = 'select ' + SCHEDULE_COLUMNS.join(', ') + ' from ferm_schedules ';

var LIST_SQL = SELECT_SQL +
  'where ($1::boolean or is_active) order by length(schedule_id), schedule_id';

var GET_SQL = SELECT_SQL + 'where schedule_id = $1';

var LOCK_SQL = SELECT_SQL + 'where schedule_id = $1 for update';

var INSERT_SQL =
  'insert into ferm_schedules (name, description, category, steps, is_active, created_at, created_by, ' +
  'updated_at, updated_by) values ($1, $2, $3, $4::jsonb, true, $5, $6, $5, $6) returning schedule_id';

var ARCHIVE_SQL =
  'update ferm_schedules set is_active = false, updated_at = $2, updated_by = $3 where schedule_id = $1';

var DELETE_SQL = 'delete from ferm_schedules where schedule_id = $1';

var COUNT_RECIPES_SQL = 'select count(*)::int as n from recipes where schedule_id = $1';

var UPDATE_TEXT_FIELDS = ['name', 'description', 'category'];

function emptyToNull(v) {
  return v === '' || v === undefined || v === null ? null : v;
}

function iso(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** Sheet-shaped schedule object from a ferm_schedules row. */
function rowToSchedule(row) {
  var steps = row.steps;
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps); } catch { /* leave as-is */ }
  }
  return {
    schedule_id: row.schedule_id,
    name: row.name,
    description: row.description === null || row.description === undefined ? '' : row.description,
    category: row.category === null || row.category === undefined ? '' : row.category,
    steps: JSON.stringify(steps),
    is_active: row.is_active === true,
    created_at: row.created_at ? iso(row.created_at) : '',
    created_by: row.created_by === null || row.created_by === undefined ? '' : row.created_by,
    last_updated: iso(row.updated_at),
    steps_parsed: steps
  };
}

async function listSchedules(client, opts) {
  opts = opts || {};
  var res = await client.query(LIST_SQL, [opts.includeArchived === true]);
  return res.rows.map(rowToSchedule);
}

async function getSchedule(client, id) {
  var res = await client.query(GET_SQL, [id]);
  return res.rows.length === 0 ? null : rowToSchedule(res.rows[0]);
}

/** Validates raw steps input; returns {ok:true, steps} or the rules error object. */
function checkSteps(raw) {
  var parsed = rules.parseSteps(raw);
  if (!parsed.ok) return parsed;
  var valid = rules.validateSteps(parsed.steps);
  if (!valid.ok) return valid;
  return { ok: true, steps: parsed.steps };
}

async function createSchedule(client, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var now = opts.now || new Date();
  var actor = opts.actor || 'middleware';

  if (!payload.name || !payload.steps) {
    return { ok: false, error: 'missing_fields', message: 'name and steps are required' };
  }
  var checked = checkSteps(payload.steps);
  if (!checked.ok) return checked;

  var res = await client.query(INSERT_SQL, [
    rules.sanitizeScheduleText(payload.name),
    emptyToNull(rules.sanitizeScheduleText(payload.description || '')),
    emptyToNull(rules.sanitizeScheduleText(payload.category || '')),
    JSON.stringify(checked.steps),
    now,
    actor
  ]);
  var id = res.rows[0].schedule_id;
  return { ok: true, schedule_id: id, _scheduleId: id };
}

function notFound(id) {
  return { ok: false, error: 'not_found', message: 'Schedule not found: ' + id };
}

function staleResult() {
  return { ok: false, error: 'stale_schedule', message: STALE_MESSAGE };
}

async function updateSchedule(client, id, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var now = opts.now || new Date();
  var actor = opts.actor || 'middleware';
  if (!id) return { ok: false, error: 'missing_id', message: 'schedule_id is required' };

  var sets = [];
  var params = [id];
  function addSet(col, value) {
    params.push(value);
    sets.push(col + ' = $' + params.length);
  }

  for (var i = 0; i < UPDATE_TEXT_FIELDS.length; i++) {
    var f = UPDATE_TEXT_FIELDS[i];
    if (payload[f] === undefined) continue;
    var v = rules.sanitizeScheduleText(payload[f]);
    addSet(f, f === 'name' ? v : emptyToNull(v));
  }
  if (payload.steps !== undefined) {
    var checked = checkSteps(payload.steps);
    if (!checked.ok) return checked;
    params.push(JSON.stringify(checked.steps));
    sets.push('steps = $' + params.length + '::jsonb');
  }

  var locked = await client.query(LOCK_SQL, [id]);
  if (locked.rows.length === 0) return notFound(id);
  if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  addSet('updated_at', now);
  addSet('updated_by', actor);
  await client.query('update ferm_schedules set ' + sets.join(', ') + ' where schedule_id = $1', params);
  return { ok: true, message: 'Schedule updated', _scheduleId: id };
}

async function archiveSchedule(client, id, opts) {
  opts = opts || {};
  var now = opts.now || new Date();
  var actor = opts.actor || 'middleware';
  if (!id) return { ok: false, error: 'missing_id', message: 'schedule_id is required' };

  var locked = await client.query(LOCK_SQL, [id]);
  if (locked.rows.length === 0) return notFound(id);
  if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  await client.query(ARCHIVE_SQL, [id, now, actor]);
  return { ok: true, message: 'Schedule deactivated', _scheduleId: id };
}

function validCount(n) {
  return typeof n === 'number' && isFinite(n) && n >= 0 && Math.floor(n) === n;
}

async function deleteSchedule(client, id, opts) {
  opts = opts || {};
  if (!validCount(opts.recipeRefCount) || !validCount(opts.batchRefCount)) {
    throw new Error('recipeRefCount and batchRefCount required');
  }
  if (!id) return { ok: false, error: 'missing_id', message: 'schedule_id is required' };

  var locked = await client.query(LOCK_SQL, [id]);
  if (locked.rows.length === 0) return notFound(id);
  if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  if (opts.recipeRefCount > 0 || opts.batchRefCount > 0) {
    return {
      ok: false,
      error: 'schedule_in_use',
      message: 'This schedule is used by ' + opts.recipeRefCount + ' recipe(s) and ' +
        opts.batchRefCount + ' batch(es). Archive it instead.',
      recipe_refs: opts.recipeRefCount,
      batch_refs: opts.batchRefCount
    };
  }
  await client.query(DELETE_SQL, [id]);
  return { ok: true, message: 'Schedule deleted', _scheduleId: id, _deleted: true };
}

async function countRecipeReferences(client, id) {
  var res = await client.query(COUNT_RECIPES_SQL, [id]);
  return res.rows[0].n;
}

module.exports = {
  SCHEDULE_COLUMNS: SCHEDULE_COLUMNS,
  rowToSchedule: rowToSchedule,
  listSchedules: listSchedules,
  getSchedule: getSchedule,
  createSchedule: createSchedule,
  updateSchedule: updateSchedule,
  archiveSchedule: archiveSchedule,
  deleteSchedule: deleteSchedule,
  countRecipeReferences: countRecipeReferences
};

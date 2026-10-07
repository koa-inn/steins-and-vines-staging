'use strict';

/**
 * Audited, owner-safe staff_access mutations — Phase 86 Plan 07 (DB-05, D-02, D-03).
 *
 * Module contract (same as recipe-pg.js): every function takes a pg client that is ALREADY inside
 * a transaction (db.withTransaction) as its first argument. This module never imports pg, never
 * reads the environment and never opens or commits a transaction — the break-glass list is passed
 * in by the caller (staffAccess.breakGlassEmails()).
 *
 * Business rejections RESOLVE { ok: false, error, message }. Unexpected SQL errors (including a
 * failed audit insert) THROW so the surrounding transaction rolls back: the staff change and its
 * audit row either both land or neither does (D-03). There is deliberately no function here that
 * updates or deletes audit rows.
 *
 * Effective owners = PG rows with role 'owner' UNION break-glass emails that have NO staff_access
 * row (an env-only member resolves as owner, D-02), minus the target. The set is computed under
 * `select ... for update` over every owner row plus every break-glass row, so two concurrent
 * owner removals serialise and the second one sees the first one's result.
 */

var EMAIL_RE = /^[^@ ]+@[^@ ]+[.][^@ ]+$/;
var ROLES = ['owner', 'staff'];
var MAX_AUDIT_LIMIT = 200;
var DEFAULT_AUDIT_LIMIT = 50;

var MSG = {
  self_remove: "You can't remove yourself",
  self_role: "You can't change your own role",
  last_owner: 'At least one owner must remain',
  break_glass: 'This person is on the Railway break-glass list — remove them there first'
};

function norm(email) {
  if (email === null || email === undefined) return null;
  return String(email).trim().toLowerCase();
}

function validEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email);
}

function bgList(breakGlass) {
  var out = [];
  (breakGlass || []).forEach(function (e) {
    var n = norm(e);
    if (n) out.push(n);
  });
  return out;
}

function fail(error, message) {
  return { ok: false, error: error, message: message };
}

/**
 * Locks every owner row and every break-glass row (ordered, so concurrent callers lock in the
 * same order) and returns { rows: Map email -> role }.
 */
function lockOwnerSet(client, breakGlass) {
  return client.query(
    "select email, role from staff_access where role = 'owner' or email = any($1) order by email for update",
    [breakGlass]
  ).then(function (res) {
    var rows = {};
    res.rows.forEach(function (r) { rows[r.email] = r.role; });
    return rows;
  });
}

function countOtherEffectiveOwners(rows, breakGlass, target) {
  var owners = {};
  Object.keys(rows).forEach(function (email) {
    if (rows[email] === 'owner') owners[email] = true;
  });
  breakGlass.forEach(function (email) {
    if (!Object.prototype.hasOwnProperty.call(rows, email)) owners[email] = true;
  });
  delete owners[target];
  return Object.keys(owners).length;
}

function audit(client, entry) {
  return client.query(
    'insert into staff_access_audit (actor_email, target_email, action, role_before, role_after, note) ' +
    'values ($1, $2, $3, $4, $5, $6)',
    [entry.actor, entry.target, entry.action, entry.roleBefore || null, entry.roleAfter || null, entry.note || null]
  );
}

function listStaff(client) {
  return client.query(
    "select email, role, added_by, added_at, updated_by, updated_at from staff_access " +
    "order by (role = 'owner') desc, email"
  ).then(function (res) { return res.rows; });
}

function getRole(client, email) {
  return client.query('select role from staff_access where email = $1', [norm(email)]).then(function (res) {
    return res.rows.length ? res.rows[0].role : null;
  });
}

function addStaff(client, params) {
  var actor = norm(params.actor);
  var target = norm(params.target);
  var role = params.role;
  if (!validEmail(target)) return Promise.resolve(fail('invalid_email', 'Enter a valid email address'));
  if (ROLES.indexOf(role) === -1) return Promise.resolve(fail('invalid_role', 'Role must be owner or staff'));

  return client.query(
    'insert into staff_access (email, role, added_by) values ($1, $2, $3) ' +
    'on conflict (email) do nothing returning email',
    [target, role, actor]
  ).then(function (res) {
    if (res.rows.length === 0) return fail('staff_exists', 'That person already has access');
    return audit(client, { actor: actor, target: target, action: 'add', roleAfter: role }).then(function () {
      return { ok: true };
    });
  });
}

function changeRole(client, params) {
  var actor = norm(params.actor);
  var target = norm(params.target);
  var role = params.role;
  var breakGlass = bgList(params.breakGlass);
  if (ROLES.indexOf(role) === -1) return Promise.resolve(fail('invalid_role', 'Role must be owner or staff'));
  if (actor !== null && actor === target) return Promise.resolve(fail('cannot_change_own_role', MSG.self_role));
  if (breakGlass.indexOf(target) !== -1) return Promise.resolve(fail('break_glass_member', MSG.break_glass));
  if (!validEmail(target)) return Promise.resolve(fail('not_found', 'Staff member not found'));

  return lockOwnerSet(client, breakGlass).then(function (rows) {
    return client.query('select role from staff_access where email = $1 for update', [target]).then(function (res) {
      if (res.rows.length === 0) return fail('not_found', 'Staff member not found');
      var before = res.rows[0].role;
      if (before === 'owner' && role !== 'owner' && countOtherEffectiveOwners(rows, breakGlass, target) < 1) {
        return fail('last_owner', MSG.last_owner);
      }
      return client.query(
        'update staff_access set role = $2, updated_by = $3, updated_at = now() where email = $1',
        [target, role, actor]
      ).then(function () {
        return audit(client, {
          actor: actor, target: target, action: 'role_change', roleBefore: before, roleAfter: role
        });
      }).then(function () {
        return { ok: true };
      });
    });
  });
}

function removeStaff(client, params) {
  var actor = norm(params.actor);
  var target = norm(params.target);
  var breakGlass = bgList(params.breakGlass);
  if (actor !== null && actor === target) return Promise.resolve(fail('cannot_remove_self', MSG.self_remove));
  if (breakGlass.indexOf(target) !== -1) return Promise.resolve(fail('break_glass_member', MSG.break_glass));
  if (!validEmail(target)) return Promise.resolve(fail('not_found', 'Staff member not found'));

  return lockOwnerSet(client, breakGlass).then(function (rows) {
    return client.query('select role from staff_access where email = $1 for update', [target]).then(function (res) {
      if (res.rows.length === 0) return fail('not_found', 'Staff member not found');
      var before = res.rows[0].role;
      if (before === 'owner' && countOtherEffectiveOwners(rows, breakGlass, target) < 1) {
        return fail('last_owner', MSG.last_owner);
      }
      return client.query('delete from staff_access where email = $1', [target]).then(function () {
        return audit(client, { actor: actor, target: target, action: 'remove', roleBefore: before });
      }).then(function () {
        return { ok: true, role_before: before };
      });
    });
  });
}

function recordDenied(client, params) {
  return audit(client, {
    actor: norm(params.actor),
    target: norm(params.target),
    action: 'denied',
    note: params.note
  });
}

function listAudit(client, params) {
  var limit = parseInt(params && params.limit, 10);
  if (!(limit > 0)) limit = DEFAULT_AUDIT_LIMIT;
  if (limit > MAX_AUDIT_LIMIT) limit = MAX_AUDIT_LIMIT;
  return client.query(
    'select id, occurred_at, actor_email, target_email, action, role_before, role_after, note ' +
    'from staff_access_audit order by occurred_at desc, id desc limit $1',
    [limit]
  ).then(function (res) { return res.rows; });
}

module.exports = {
  listStaff: listStaff,
  getRole: getRole,
  addStaff: addStaff,
  changeRole: changeRole,
  removeStaff: removeStaff,
  recordDenied: recordDenied,
  listAudit: listAudit
};

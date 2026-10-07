'use strict';

/**
 * Shared D-16 optimistic-concurrency compare (Phase 86), used by vessel-pg and ferm-schedule-pg.
 * Copied from lib/recipe-pg.js isStale (not exported there).
 *
 * Stale when the expected token is missing/empty/unparseable or differs (epoch ms)
 * from the locked row's updated_at. Strict by design (Phase 85 A9).
 *
 * @param {*} expected - client-supplied updated_at token
 * @param {{updated_at: (Date|string)}} row
 * @returns {boolean}
 */
function isStale(expected, row) {
  if (expected === undefined || expected === null || expected === '') return true;
  var t = new Date(expected).getTime();
  if (isNaN(t)) return true;
  var stored = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
  return t !== stored;
}

module.exports = { isStale: isStale };

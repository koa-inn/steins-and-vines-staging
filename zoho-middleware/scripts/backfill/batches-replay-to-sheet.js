'use strict';

/**
 * Batches replay-to-sheet - Phase 87 Plan 14 (DB-06, D-07/D-08 rollback support).
 *
 * The required FIRST step of any post-window rollback: pushes the CURRENT Postgres state of every
 * batch changed since --since onto the live sheet via the Apps Script mirror_batch_state /
 * mirror_batch_delete actions, using exactly lib/ops-mirror.buildMirrorRequest so a replay and a
 * live mirror produce identical payloads. Each action is idempotent per batch, so a re-run after a
 * partial failure is safe.
 *
 *   - mirror_batch_state for every batch with last_updated >= since (ordered by last_updated);
 *   - mirror_batch_delete for every tombstone with deleted_at >= since whose batch no longer
 *     exists. A tombstoned id that was re-created later is sent as state, not delete.
 *
 * Dry run by default; --apply is required to send anything. Reads Postgres only (read-only
 * transactions); never writes to Postgres. Stops at the first {ok:false}. Output is ids and counts
 * only. Env only: BACKFILL_DATABASE_URL, APPS_SCRIPT_URL, APPS_SCRIPT_SERVER_TOKEN.
 *
 *   node scripts/backfill/batches-replay-to-sheet.js --since=2026-10-12T00:00:00Z           # dry run
 *   node scripts/backfill/batches-replay-to-sheet.js --since=2026-10-12T00:00:00Z --apply
 *
 * Exit codes: 0 ok, 1 error or replay stopped on a failure.
 */

var backfillCli = require('./backfill');
var opsMirror = require('../../lib/ops-mirror');
var batchPgRead = require('../../lib/batch-pg-read');

var EXIT = backfillCli.EXIT;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var APPS_SCRIPT_TIMEOUT_MS = 30000;
var ISO_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Constant SQL - the only input is the bound $1 / $2.
var STATE_IDS_SQL =
  'select batch_id from batches where last_updated >= $1 order by last_updated, batch_id';
var TOMBSTONE_IDS_SQL =
  'select batch_id from batch_tombstones where deleted_at >= $1 order by deleted_at, batch_id';
var EXISTING_IDS_SQL = 'select batch_id from batches where batch_id = any($1::text[])';

function parseArgs(argv) {
  var opts = { apply: false, since: null };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eq = arg.indexOf('=');
    var flag = eq === -1 ? arg : arg.slice(0, eq);
    var value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === '--apply' && value === undefined) {
      opts.apply = true;
    } else if (flag === '--since' && value !== undefined) {
      if (!ISO_RE.test(value) || isNaN(new Date(value).getTime())) {
        throw new Error('--since must be an ISO timestamp, e.g. 2026-10-12T00:00:00Z');
      }
      opts.since = new Date(value);
    } else {
      throw new Error('unknown flag "' + flag + '" - valid flags: --since=<iso>, --apply');
    }
  });
  if (!opts.since) throw new Error('--since=<iso> is required (usage: --since=2026-10-12T00:00:00Z [--apply])');
  return opts;
}

function ids(result) {
  return result.rows.map(function (r) { return r.batch_id; });
}

/**
 * Candidate ids in one read-only transaction. Returns {stateIds, deleteIds}: state first in
 * last_updated order; a tombstone whose batch exists again is a state id, otherwise a delete id.
 */
async function fetchCandidates(pool, since) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var state = ids(await client.query(STATE_IDS_SQL, [since]));
    var tombstones = ids(await client.query(TOMBSTONE_IDS_SQL, [since]));
    var existing = {};
    if (tombstones.length) {
      ids(await client.query(EXISTING_IDS_SQL, [tombstones])).forEach(function (id) { existing[id] = true; });
    }
    await client.query('commit');

    var seen = {};
    var stateIds = [];
    var deleteIds = [];
    state.forEach(function (id) {
      if (!seen[id]) { seen[id] = true; stateIds.push(id); }
    });
    tombstones.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      if (existing[id]) stateIds.push(id);
      else deleteIds.push(id);
    });
    return { stateIds: stateIds, deleteIds: deleteIds };
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

// One read-only transaction per batch, read at send time so the payload is current.
async function readBundle(pool, batchId) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var bundle = await batchPgRead.getBatchBundle(client, batchId);
    await client.query('commit');
    return bundle;
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

/** Request body for one id: state when the batch exists now, delete when it does not. */
async function buildRequest(pool, batchId) {
  var bundle = await readBundle(pool, batchId);
  return opsMirror.buildMirrorRequest('batch', bundle, batchId);
}

async function post(body, url, token, axios) {
  var res = await axios.post(url, JSON.stringify(Object.assign({}, body, { server_token: token })), {
    headers: { 'Content-Type': 'application/json' },
    timeout: APPS_SCRIPT_TIMEOUT_MS,
    maxRedirects: 5
  });
  var data = res && res.data;
  if (!data || data.ok !== true) return (data && (data.error || data.message)) || 'unknown_error';
  return null;
}

/**
 * runBatchesReplay(opts, deps) -> Promise<{exitCode, sent, total, state, deletes}>.
 * deps: {pool, axios, log, env}.
 */
async function runBatchesReplay(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  var env = deps.env || process.env;
  var counts = { state: 0, deletes: 0 };
  try {
    var cand = await fetchCandidates(deps.pool, opts.since);
    var order = cand.stateIds.concat(cand.deleteIds);
    counts = { state: cand.stateIds.length, deletes: cand.deleteIds.length };
    log('Built ' + order.length + ' replay request(s): ' + counts.state + ' state, ' + counts.deletes + ' delete');

    if (!opts.apply) {
      log('Dry run - no HTTP calls made. Pass --apply to send.');
      return { exitCode: EXIT.OK, sent: 0, total: order.length, state: counts.state, deletes: counts.deletes };
    }

    var url = env.APPS_SCRIPT_URL;
    var token = env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) {
      log('Error: APPS_SCRIPT_URL and APPS_SCRIPT_SERVER_TOKEN must be set to --apply');
      return { exitCode: EXIT.ERROR, sent: 0, total: order.length, state: counts.state, deletes: counts.deletes };
    }

    var sent = 0;
    for (var i = 0; i < order.length; i++) {
      var batchId = order[i];
      var error = null;
      try {
        var body = await buildRequest(deps.pool, batchId);
        error = await post(body, url, token, deps.axios);
      } catch (err) {
        error = err.message;
      }
      if (error) {
        log('Replay stopped - batch ' + batchId + ' error=' + error);
        return { exitCode: EXIT.ERROR, sent: sent, total: order.length, state: counts.state, deletes: counts.deletes };
      }
      sent++;
    }
    log('Replayed ' + sent + '/' + order.length + ' request(s)');
    log('Next: run batches-verify against a fresh snapshot');
    return { exitCode: EXIT.OK, sent: sent, total: order.length, state: counts.state, deletes: counts.deletes };
  } catch (err) {
    log('Error: ' + err.message);
    return { exitCode: EXIT.ERROR, sent: 0, total: 0, state: counts.state, deletes: counts.deletes };
  }
}

function main() {
  var db = require('../../lib/db');
  var opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(EXIT.ERROR);
    return;
  }
  if (!process.env.BACKFILL_DATABASE_URL) {
    console.error('Error: BACKFILL_DATABASE_URL must be set');
    process.exit(EXIT.ERROR);
    return;
  }

  var pool = db.createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 });
  var axios = require('axios');
  runBatchesReplay(opts, { pool: pool, axios: axios, log: console.log })
    .then(function (result) {
      return pool.end().then(function () { return result; });
    })
    .then(function (result) { process.exit(result.exitCode); })
    .catch(function (err) {
      console.error('Fatal: ' + err.message);
      pool.end().catch(function () {}).then(function () { process.exit(EXIT.ERROR); });
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  runBatchesReplay: runBatchesReplay,
  parseArgs: parseArgs,
  EXIT: EXIT
};

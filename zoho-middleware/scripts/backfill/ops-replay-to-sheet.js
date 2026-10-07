'use strict';

/**
 * Ops replay-to-sheet - Phase 86 Plan 14 (DB-05, D-10 rollback support for D-19).
 *
 * Pushes the CURRENT Postgres state of every vessel and ferm schedule onto the live sheet via
 * the Apps Script mirror_* actions, using exactly lib/ops-mirror.buildMirrorRequest so a replay
 * and a live mirror produce identical payloads. Each action is idempotent per row, so a re-run
 * after a partial failure is safe.
 *
 * Only vessels and schedules are replayed. The sign-in list is never mirrored to the sheet (D-10).
 *
 * Dry run by default; --apply is required to send anything. Reads Postgres in one read-only
 * transaction; never writes to Postgres. Stops at the first {ok:false}. Output is ids and counts
 * only. Env only: BACKFILL_DATABASE_URL, APPS_SCRIPT_URL, APPS_SCRIPT_SERVER_TOKEN.
 *
 *   node scripts/backfill/ops-replay-to-sheet.js                       # dry run
 *   node scripts/backfill/ops-replay-to-sheet.js --apply
 *   node scripts/backfill/ops-replay-to-sheet.js --apply --only=schedules --id=FS-0004
 *
 * --id=X for a schedule that no longer exists in Postgres sends mirror_ferm_schedule_delete
 * (removes the stale sheet row). Exit codes: 0 ok, 1 error or replay stopped on a failure.
 */

var backfillCli = require('./backfill');
var opsMirror = require('../../lib/ops-mirror');
var vesselPg = require('../../lib/vessel-pg');
var fermSchedulePg = require('../../lib/ferm-schedule-pg');

var EXIT = backfillCli.EXIT;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var APPS_SCRIPT_TIMEOUT_MS = 30000;
var ONLY_VALUES = { vessels: true, schedules: true };

function parseArgs(argv) {
  var opts = { apply: false, only: null, id: null };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eq = arg.indexOf('=');
    var flag = eq === -1 ? arg : arg.slice(0, eq);
    var value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === '--apply' && value === undefined) {
      opts.apply = true;
    } else if (flag === '--only' && value !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(ONLY_VALUES, value)) {
        throw new Error('--only must be vessels or schedules');
      }
      opts.only = value;
    } else if (flag === '--id' && value) {
      opts.id = value;
    } else {
      throw new Error('unknown flag "' + flag + '" - valid flags: --apply, --only=vessels|schedules, --id=X');
    }
  });
  if (opts.id && !opts.only) throw new Error('--id requires --only');
  return opts;
}

async function fetchPgState(pool) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var vessels = await vesselPg.listVessels(client);
    var schedules = await fermSchedulePg.listSchedules(client, { includeArchived: true });
    await client.query('commit');
    return { vessels: vessels, schedules: schedules };
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * buildReplayRequests(state, opts) -> [{entity, id, body}] (vessels first, then schedules,
 * each in Postgres order). Bodies come from ops-mirror.buildMirrorRequest only.
 */
function buildReplayRequests(state, opts) {
  opts = opts || {};
  var out = [];
  var wantVessels = !opts.only || opts.only === 'vessels';
  var wantSchedules = !opts.only || opts.only === 'schedules';

  if (wantVessels) {
    var vessels = (state.vessels || []).filter(function (v) { return !opts.id || v.vessel_id === opts.id; });
    if (opts.id && vessels.length === 0) throw new Error('vessel not found in Postgres');
    vessels.forEach(function (v) {
      out.push({ entity: 'vessel', id: v.vessel_id, body: opsMirror.buildMirrorRequest('vessel', v, v.vessel_id) });
    });
  }
  if (wantSchedules) {
    var schedules = (state.schedules || []).filter(function (s) { return !opts.id || s.schedule_id === opts.id; });
    schedules.forEach(function (s) {
      out.push({ entity: 'fermsched', id: s.schedule_id, body: opsMirror.buildMirrorRequest('fermsched', s, s.schedule_id) });
    });
    if (opts.id && schedules.length === 0) {
      out.push({ entity: 'fermsched', id: opts.id, body: opsMirror.buildMirrorRequest('fermsched', null, opts.id) });
    }
  }
  return out;
}

async function postSequentially(requests, url, token, axios) {
  var sent = 0;
  for (var i = 0; i < requests.length; i++) {
    var item = requests[i];
    var error = null;
    try {
      var res = await axios.post(url, JSON.stringify(Object.assign({}, item.body, { server_token: token })), {
        headers: { 'Content-Type': 'application/json' },
        timeout: APPS_SCRIPT_TIMEOUT_MS,
        maxRedirects: 5
      });
      var data = res && res.data;
      if (!data || data.ok !== true) error = (data && (data.error || data.message)) || 'unknown_error';
    } catch (err) {
      error = err.message;
    }
    if (error) return { sent: sent, failure: { entity: item.entity, id: item.id, error: error } };
    sent++;
  }
  return { sent: sent, failure: null };
}

/**
 * runOpsReplay(opts, deps) -> Promise<{exitCode, sent, total}>. deps: {pool, axios, log, env}.
 */
async function runOpsReplay(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  var env = deps.env || process.env;
  try {
    var state = await fetchPgState(deps.pool);
    var requests = buildReplayRequests(state, opts);
    log('Built ' + requests.length + ' replay request(s)');

    if (!opts.apply) {
      log('Dry run - no HTTP calls made. Pass --apply to send.');
      return { exitCode: EXIT.OK, sent: 0, total: requests.length };
    }

    var url = env.APPS_SCRIPT_URL;
    var token = env.APPS_SCRIPT_SERVER_TOKEN;
    if (!url || !token) {
      log('Error: APPS_SCRIPT_URL and APPS_SCRIPT_SERVER_TOKEN must be set to --apply');
      return { exitCode: EXIT.ERROR, sent: 0, total: requests.length };
    }

    var result = await postSequentially(requests, url, token, deps.axios);
    if (result.failure) {
      log('Replay stopped - ' + result.failure.entity + ' ' + result.failure.id + ' error=' + result.failure.error);
      return { exitCode: EXIT.ERROR, sent: result.sent, total: requests.length };
    }
    log('Replayed ' + result.sent + '/' + requests.length + ' request(s)');
    return { exitCode: EXIT.OK, sent: result.sent, total: requests.length };
  } catch (err) {
    log('Error: ' + err.message);
    return { exitCode: EXIT.ERROR, sent: 0, total: 0 };
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
  runOpsReplay(opts, { pool: pool, axios: axios, log: console.log })
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
  buildReplayRequests: buildReplayRequests,
  runOpsReplay: runOpsReplay,
  parseArgs: parseArgs,
  EXIT: EXIT
};

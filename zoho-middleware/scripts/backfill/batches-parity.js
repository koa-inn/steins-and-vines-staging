'use strict';

/**
 * Batches parity - Phase 87 Plan 15 (DB-06, ROADMAP SC3, D-06).
 *
 * Pre-flip go/no-go for the dashboard numbers. Fetches the four reads BrewPad and the admin panel
 * render (get_batch_dashboard_summary, get_batches status=all, get_tasks_upcoming limit=200,
 * get_tasks_calendar for the current and next month) from Apps Script and the same reads from
 * Postgres (lib/batch-pg-read, one read-only transaction, same "now" and timezone), deep-diffs
 * them and exits 4 on ANY difference ("any dashboard number differing = no-go").
 *
 * The Apps Script side is saved as the pre-cutover snapshot (--snapshot-out), which holds
 * customer names and therefore must live OUTSIDE the repo (assertSnapshotSafePath).
 *
 * Post-flip confirmation: --against-snapshot=<file> --via=proxy re-runs the same reads through
 * the admin panel proxy (POST <BATCH_PARITY_BASE_URL>/api/admin/proxy) and diffs against the
 * saved snapshot. The staff session token comes from env BATCH_PARITY_SESSION, never argv.
 *
 * Output is "<read> <path>" lines and counts only - never a value. The database comes ONLY from
 * BACKFILL_DATABASE_URL, never argv. Apps Script from APPS_SCRIPT_URL / APPS_SCRIPT_SERVER_TOKEN.
 *
 *   node scripts/backfill/batches-parity.js --snapshot-out=/path/outside/repo.json
 *        [--now=<iso>] [--timezone=America/Vancouver]
 *   node scripts/backfill/batches-parity.js --against-snapshot=/path/snap.json --via=proxy
 * Exit codes: 0 ok ("parity: 0 differences"), 1 error, 4 differences found.
 */

var fs = require('fs');

var backfillCli = require('./backfill');

var EXIT = { OK: 0, ERROR: 1, MISMATCH: 4 };
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var DEFAULT_TIMEZONE = 'America/Vancouver';
var MIDNIGHT_GUARD_MINUTES = 15;
var HTTP_TIMEOUT_MS = 30000;
// Keys absent from one side by design. Everything else must match.
var IGNORED_KEYS = { access_token: true };
var UPCOMING_LIMIT = 200;

function parseArgs(argv) {
  var opts = {
    snapshotOut: undefined,
    againstSnapshot: undefined,
    via: undefined,
    now: undefined,
    timezone: DEFAULT_TIMEZONE
  };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eq = arg.indexOf('=');
    var flag = eq === -1 ? arg : arg.slice(0, eq);
    var value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === '--snapshot-out') opts.snapshotOut = value;
    else if (flag === '--against-snapshot') opts.againstSnapshot = value;
    else if (flag === '--via') opts.via = value;
    else if (flag === '--now') opts.now = value;
    else if (flag === '--timezone') opts.timezone = value || DEFAULT_TIMEZONE;
    else {
      throw new Error('unknown flag "' + flag +
        '" - valid flags: --snapshot-out, --against-snapshot, --via, --now, --timezone');
    }
  });
  return opts;
}

// ─── Time helpers (timezone-aware, no dependencies) ─────────────────────────

function zonedParts(date, timezone) {
  var fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  var parts = {};
  fmt.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function monthRange(year, month) {
  var last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based -> day 0 of next
  return {
    key: year + '-' + pad2(month),
    start: year + '-' + pad2(month) + '-01',
    end: year + '-' + pad2(month) + '-' + pad2(last)
  };
}

/** True when `date` is within MIDNIGHT_GUARD_MINUTES of local midnight in `timezone`. */
function nearMidnight(date, timezone) {
  var m = zonedParts(date, timezone).minutes;
  return m < MIDNIGHT_GUARD_MINUTES || m >= 24 * 60 - MIDNIGHT_GUARD_MINUTES;
}

/** The list of reads this run compares: [{key, action, params}]. */
function buildCalls(now, timezone) {
  var p = zonedParts(now, timezone);
  var nextYear = p.month === 12 ? p.year + 1 : p.year;
  var nextMonth = p.month === 12 ? 1 : p.month + 1;
  var calls = [
    { key: 'get_batch_dashboard_summary', action: 'get_batch_dashboard_summary', params: {} },
    { key: 'get_batches', action: 'get_batches', params: { status: 'all' } },
    { key: 'get_tasks_upcoming', action: 'get_tasks_upcoming', params: { limit: UPCOMING_LIMIT } }
  ];
  [monthRange(p.year, p.month), monthRange(nextYear, nextMonth)].forEach(function (r) {
    calls.push({
      key: 'get_tasks_calendar:' + r.key,
      action: 'get_tasks_calendar',
      params: { start_date: r.start, end_date: r.end }
    });
  });
  return calls;
}

// ─── Pure comparison ────────────────────────────────────────────────────────

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function walk(a, b, path, out) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(path + '.length');
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) walk(a[i], b[i], path + '[' + i + ']', out);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    var keys = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) {
      if (!IGNORED_KEYS[k]) keys[k] = true;
    });
    Object.keys(keys).sort().forEach(function (k) {
      var childPath = path ? path + '.' + k : k;
      var inA = Object.prototype.hasOwnProperty.call(a, k);
      var inB = Object.prototype.hasOwnProperty.call(b, k);
      if (inA && inB) walk(a[k], b[k], childPath, out);
      else out.push(childPath);
    });
    return;
  }
  // Leaves (and type mismatches). null and undefined are the same "no value".
  var left = a === undefined ? null : a;
  var right = b === undefined ? null : b;
  if (left !== right) out.push(path || '(root)');
}

/**
 * diffParity(sheetSide, pgSide) -> [{action, path}]
 * Both sides are {<call key>: <response>}. Paths only - never a value. Key order is irrelevant;
 * array order is not (the lists are ordered by contract). `access_token` is ignored.
 */
function diffParity(sheetSide, pgSide) {
  var diffs = [];
  var keys = {};
  Object.keys(sheetSide || {}).concat(Object.keys(pgSide || {})).forEach(function (k) { keys[k] = true; });
  Object.keys(keys).forEach(function (key) {
    var inSheet = Object.prototype.hasOwnProperty.call(sheetSide || {}, key);
    var inPg = Object.prototype.hasOwnProperty.call(pgSide || {}, key);
    if (!inSheet || !inPg) {
      diffs.push({ action: key, path: '(missing_on_' + (inSheet ? 'postgres' : 'sheet') + ')' });
      return;
    }
    var paths = [];
    walk(sheetSide[key], pgSide[key], '', paths);
    paths.forEach(function (p) { diffs.push({ action: key, path: p }); });
  });
  return diffs;
}

// ─── Fetchers ───────────────────────────────────────────────────────────────

function appsScriptEnv(env) {
  if (!env.APPS_SCRIPT_URL || !env.APPS_SCRIPT_SERVER_TOKEN) {
    throw new Error('APPS_SCRIPT_URL and APPS_SCRIPT_SERVER_TOKEN must be set');
  }
  return { url: env.APPS_SCRIPT_URL, token: env.APPS_SCRIPT_SERVER_TOKEN };
}

async function fetchSheetSide(calls, axios, env) {
  var cfg = appsScriptEnv(env);
  var out = {};
  for (var i = 0; i < calls.length; i++) {
    var params = Object.assign({ action: calls[i].action, server_token: cfg.token }, calls[i].params);
    var res = await axios.get(cfg.url, { params: params, timeout: HTTP_TIMEOUT_MS, maxRedirects: 5 });
    if (!res || !res.data || res.data.ok !== true) throw new Error(calls[i].key + ' failed on Apps Script');
    out[calls[i].key] = res.data;
  }
  return out;
}

async function fetchProxySide(calls, axios, env) {
  var base = env.BATCH_PARITY_BASE_URL;
  var session = env.BATCH_PARITY_SESSION;
  if (!base || !session) throw new Error('BATCH_PARITY_BASE_URL and BATCH_PARITY_SESSION must be set');
  var out = {};
  for (var i = 0; i < calls.length; i++) {
    var body = Object.assign({ action: calls[i].action }, calls[i].params);
    var res = await axios.post(String(base).replace(/\/+$/, '') + '/api/admin/proxy', body, {
      headers: { 'x-session-token': session, 'Content-Type': 'application/json' },
      timeout: HTTP_TIMEOUT_MS
    });
    if (!res || !res.data || res.data.ok !== true) throw new Error(calls[i].key + ' failed via proxy');
    out[calls[i].key] = res.data;
  }
  return out;
}

// Sequential queries in one read-only transaction.
async function fetchPgSide(calls, pool, now, timezone) {
  var pgRead = require('../../lib/batch-pg-read');
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var out = {};
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      var res;
      if (c.action === 'get_batch_dashboard_summary') {
        res = await pgRead.getDashboardSummary(client, { now: now, timezone: timezone });
      } else if (c.action === 'get_batches') {
        res = await pgRead.listBatches(client, { status: c.params.status });
      } else if (c.action === 'get_tasks_upcoming') {
        res = await pgRead.getTasksUpcoming(client, c.params.limit);
      } else {
        res = await pgRead.getTasksCalendar(client, c.params.start_date, c.params.end_date);
      }
      out[c.key] = res;
    }
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

function report(log, diffs, callCount) {
  diffs.forEach(function (d) { log(d.action + ' ' + d.path); });
  log('parity: ' + diffs.length + ' differences (' + callCount + ' reads compared)');
  return diffs.length === 0 ? EXIT.OK : EXIT.MISMATCH;
}

/**
 * runBatchesParity(opts, deps) -> Promise<{exitCode, diffs}>.
 * deps: {pool, axios, log, env, nowFn, writeFile}.
 */
async function runBatchesParity(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  var env = deps.env || process.env;
  var axios = deps.axios || require('axios');
  var nowFn = deps.nowFn || function () { return new Date(); };
  var writeFile = deps.writeFile || function (p, data) { fs.writeFileSync(p, data, { mode: 0o600 }); };

  try {
    var timezone = opts.timezone || DEFAULT_TIMEZONE;

    if (opts.againstSnapshot) {
      if (opts.via !== 'proxy') throw new Error('--against-snapshot requires --via=proxy');
      assertSnapshotSafePath(opts.againstSnapshot);
      var snap = JSON.parse(fs.readFileSync(opts.againstSnapshot, 'utf8'));
      if (!snap || !Array.isArray(snap.calls) || !snap.reads) throw new Error('snapshot is not a parity snapshot');
      var proxySide = await fetchProxySide(snap.calls, axios, env);
      var proxyDiffs = diffParity(snap.reads, proxySide);
      return { exitCode: report(log, proxyDiffs, snap.calls.length), diffs: proxyDiffs };
    }

    if (opts.via) throw new Error('--via is only valid with --against-snapshot');
    if (!opts.snapshotOut) throw new Error('--snapshot-out is required (the pre-cutover snapshot)');
    assertSnapshotSafePath(opts.snapshotOut);

    var now = opts.now ? new Date(opts.now) : nowFn();
    if (isNaN(now.getTime())) throw new Error('--now is not a valid ISO timestamp');
    if (nearMidnight(now, timezone)) {
      throw new Error('within ' + MIDNIGHT_GUARD_MINUTES + ' minutes of local midnight (' + timezone +
        ') - the two sides could disagree on "today"; rerun away from midnight');
    }

    var calls = buildCalls(now, timezone);
    var sheetSide = await fetchSheetSide(calls, axios, env);
    var pgSide = await fetchPgSide(calls, deps.pool, now, timezone);

    writeFile(opts.snapshotOut, JSON.stringify({
      taken_at: nowFn().toISOString(),
      now: now.toISOString(),
      timezone: timezone,
      calls: calls,
      reads: sheetSide
    }));
    log('Snapshot saved to ' + opts.snapshotOut);

    var diffs = diffParity(sheetSide, pgSide);
    return { exitCode: report(log, diffs, calls.length), diffs: diffs };
  } catch (err) {
    log('Error: ' + err.message);
    return { exitCode: EXIT.ERROR, diffs: null };
  }
}

function main() {
  var opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('Error: ' + err.message);
    process.exit(EXIT.ERROR);
    return;
  }

  var needsDb = !opts.againstSnapshot;
  if (needsDb && !process.env.BACKFILL_DATABASE_URL) {
    console.error('Error: BACKFILL_DATABASE_URL must be set');
    process.exit(EXIT.ERROR);
    return;
  }

  var pool = needsDb
    ? require('../../lib/db').createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 })
    : null;
  runBatchesParity(opts, { pool: pool, log: console.log })
    .then(function (result) {
      return (pool ? pool.end() : Promise.resolve()).then(function () { return result; });
    })
    .then(function (result) { process.exit(result.exitCode); })
    .catch(function (err) {
      console.error('Fatal: ' + err.message);
      process.exit(EXIT.ERROR);
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  diffParity: diffParity,
  buildCalls: buildCalls,
  nearMidnight: nearMidnight,
  runBatchesParity: runBatchesParity,
  parseArgs: parseArgs,
  EXIT: EXIT
};

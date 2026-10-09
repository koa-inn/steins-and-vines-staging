'use strict';

/**
 * Batches verify - Phase 87 Plan 14 (DB-06, ROADMAP SC3, D-06).
 *
 * Read-only owner-run comparison of Postgres (batches, batch_tasks, plato_readings,
 * vessel_history) against a FRESH .xlsx download of the live workbook: per-table row counts,
 * per-field values, child->parent integrity and the pinned header rows. Any mismatch is a no-go.
 *
 * Never mutates anything: one `begin transaction read only` with constant SQL, then commit.
 * Output is "<table> <id> <field>" lines and counts only - never a cell value. The database comes
 * ONLY from BACKFILL_DATABASE_URL, never argv. All comparison rules live in lib/batch-compare.js.
 *
 *   node scripts/backfill/batches-verify.js --file=/path/to/fresh.xlsx [--timezone=America/Vancouver]
 * Exit codes: 0 ok ("0 mismatches"), 1 error, 4 mismatches found.
 */

var fs = require('fs');

var readXlsx = require('./read-xlsx');
var backfillCli = require('./backfill');
var batchCompare = require('../../lib/batch-compare');

var EXIT = { OK: 0, ERROR: 1, MISMATCH: 4 };
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var DEFAULT_TIMEZONE = 'America/Vancouver';

// Constant SQL - nothing here is built from input.
var PG_SQL = {
  batches: 'select * from batches order by length(batch_id), batch_id',
  batch_tasks: 'select * from batch_tasks order by length(task_id), task_id',
  plato_readings: 'select * from plato_readings order by length(reading_id), reading_id',
  vessel_history: 'select * from vessel_history order by length(history_id), history_id'
};

function parseArgs(argv) {
  var opts = { file: undefined, timezone: DEFAULT_TIMEZONE };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eq = arg.indexOf('=');
    var flag = eq === -1 ? arg : arg.slice(0, eq);
    var value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === '--file') opts.file = value;
    else if (flag === '--timezone') opts.timezone = value || DEFAULT_TIMEZONE;
    else throw new Error('unknown flag "' + flag + '" - valid flags: --file, --timezone');
  });
  return opts;
}

// Sequential queries on one client (no concurrent queries on a single pg client).
async function fetchPg(pool) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var out = {};
    var names = Object.keys(PG_SQL);
    for (var i = 0; i < names.length; i++) {
      out[names[i]] = (await client.query(PG_SQL[names[i]])).rows;
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

/**
 * runBatchesVerify(opts, deps) -> Promise<{exitCode, result}>. deps: {pool, log}.
 */
async function runBatchesVerify(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;

  try {
    assertSnapshotSafePath(opts.file);
    if (!opts.file || !fs.existsSync(opts.file)) throw new Error('snapshot not found');

    var workbook = {};
    for (var i = 0; i < batchCompare.TABLES.length; i++) {
      var sheetName = batchCompare.TABLES[i].sheet;
      workbook[sheetName] = await readXlsx.readSheet(opts.file, sheetName);
    }

    var pg = await fetchPg(deps.pool);
    var sheetTables = batchCompare.normalizeSheetTables(workbook, { timezone: opts.timezone || DEFAULT_TIMEZONE });
    var result = batchCompare.compareBatchTables(pg, sheetTables);
    var summary = batchCompare.summarize(result);

    summary.lines.forEach(function (line) { log(line); });
    return { exitCode: summary.ok ? EXIT.OK : EXIT.MISMATCH, result: result };
  } catch (err) {
    log('Error: ' + err.message);
    return { exitCode: EXIT.ERROR, result: null };
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
  if (!opts.file) {
    console.error('Error: --file is required');
    process.exit(EXIT.ERROR);
    return;
  }
  if (!process.env.BACKFILL_DATABASE_URL) {
    console.error('Error: BACKFILL_DATABASE_URL must be set');
    process.exit(EXIT.ERROR);
    return;
  }

  var pool = db.createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 });
  runBatchesVerify(opts, { pool: pool, log: console.log })
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
  runBatchesVerify: runBatchesVerify,
  parseArgs: parseArgs,
  EXIT: EXIT
};

'use strict';

/**
 * Ops verify - Phase 86 Plan 14 (DB-05, D-09/D-10/D-11 agreement proof).
 *
 * A read-only owner-run comparison between Postgres (vessels, ferm_schedules, config,
 * staff_access) and a FRESH .xlsx download of the live workbook. Run before every store-mode
 * flip, after the dual-window pre-open mirror write, and after any replay.
 *
 * Never mutates anything: one `begin transaction read only` with constant SQL, then commit.
 *
 * Rules (all field by field):
 *   - numbers compare by value ('23.0' equals 23); '' equals NULL; text is trimmed;
 *   - an archived vessel is expected as sheet status 'Disabled/Retired';
 *   - steps compare parsed (key order is irrelevant); is_active accepts boolean or 'TRUE'/'FALSE';
 *   - the expected vessel status is NEVER derived from batches (Pitfall 2);
 *   - the Config tab must hold no token/secret/password/key row (SC3), and the two imported
 *     keys (hold_expiry_hours, google_calendar_id) must match;
 *   - the Vessels tab must carry a 'label' header (owner decision 2026-10-07);
 *   - staff leg: every BACKFILL_STAFF_EMAILS member needs a staff_access row (missing = mismatch);
 *     Postgres-only members are reported as a count (people added through the screen).
 *
 * Output is "<entity> <id> <field>" lines and counts only - never a cell value or an email.
 * The database comes ONLY from BACKFILL_DATABASE_URL, never argv.
 *
 *   node scripts/backfill/ops-verify.js --file=/path/to/fresh.xlsx
 * Exit codes: 0 ok ("0 mismatches"), 1 error, 4 mismatches found.
 */

var fs = require('fs');

var readXlsx = require('./read-xlsx');
var backfillCli = require('./backfill');
var vesselPg = require('../../lib/vessel-pg');
var fermSchedulePg = require('../../lib/ferm-schedule-pg');

var EXIT = { OK: 0, ERROR: 1, MISMATCH: 4 };
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;

var ARCHIVED_STATUS = 'Disabled/Retired';
var SECRET_KEY_RE = /token|secret|password|key/i;
var CONFIG_KEYS = ['hold_expiry_hours', 'google_calendar_id'];
var VESSEL_TEXT_FIELDS = ['type', 'material', 'status', 'location', 'brand', 'notes', 'label'];
var VESSEL_NUM_FIELDS = ['capacity_liters', 'bottom_diameter_cm', 'top_diameter_cm', 'depth_cm'];
var SCHEDULE_TEXT_FIELDS = ['name', 'description', 'category', 'created_by'];

// Constant SQL - nothing here is built from input.
var CONFIG_SQL = 'select key, value from config order by key';
var STAFF_SQL = 'select email from staff_access order by email';

// ─── Pure comparison ────────────────────────────────────────────────────────

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function text(v) {
  return isEmpty(v) ? '' : String(v).trim();
}

function sameText(a, b) {
  return text(a) === text(b);
}

function sameNumber(a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  return Number(a) === Number(b);
}

function asBool(v) {
  if (typeof v === 'boolean') return v;
  return String(v).trim().toLowerCase() === 'true';
}

function parseSteps(v) {
  if (Array.isArray(v)) return v;
  if (isEmpty(v)) return null;
  try {
    var parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Canonical JSON with sorted keys, so key order never counts as a difference.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (k) {
      return JSON.stringify(k) + ':' + canonical(value[k]);
    }).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function index(list, idField) {
  var by = {};
  (list || []).forEach(function (r) {
    var id = text(r[idField]);
    if (id) by[id] = r;
  });
  return by;
}

function compareVessels(pgVessels, sheetVessels, labelHeaderPresent, out) {
  var sheetById = index(sheetVessels, 'vessel_id');
  var seen = {};
  (pgVessels || []).forEach(function (pg) {
    var id = pg.vessel_id;
    seen[id] = true;
    var sh = sheetById[id];
    if (!sh) {
      out.push({ entity: 'vessel', id: id, field: 'missing_in_sheet' });
      return;
    }
    VESSEL_TEXT_FIELDS.forEach(function (field) {
      if (field === 'label' && !labelHeaderPresent) return;
      var expected = pg[field];
      if (field === 'status') expected = pg.archived ? ARCHIVED_STATUS : pg.status;
      if (!sameText(expected, sh[field])) out.push({ entity: 'vessel', id: id, field: field });
    });
    VESSEL_NUM_FIELDS.forEach(function (field) {
      if (!sameNumber(pg[field], sh[field])) out.push({ entity: 'vessel', id: id, field: field });
    });
  });
  (sheetVessels || []).forEach(function (sh) {
    var id = text(sh.vessel_id);
    if (id && !seen[id]) out.push({ entity: 'vessel', id: id, field: 'missing_in_postgres' });
  });
}

function compareSchedules(pgSchedules, sheetSchedules, out) {
  var sheetById = index(sheetSchedules, 'schedule_id');
  var seen = {};
  (pgSchedules || []).forEach(function (pg) {
    var id = pg.schedule_id;
    seen[id] = true;
    var sh = sheetById[id];
    if (!sh) {
      out.push({ entity: 'fermsched', id: id, field: 'missing_in_sheet' });
      return;
    }
    SCHEDULE_TEXT_FIELDS.forEach(function (field) {
      if (!sameText(pg[field], sh[field])) out.push({ entity: 'fermsched', id: id, field: field });
    });
    if (asBool(pg.is_active) !== asBool(sh.is_active)) {
      out.push({ entity: 'fermsched', id: id, field: 'is_active' });
    }
    var pgSteps = pg.steps_parsed !== undefined ? pg.steps_parsed : parseSteps(pg.steps);
    var shSteps = parseSteps(sh.steps);
    if (shSteps === null || canonical(pgSteps) !== canonical(shSteps)) {
      out.push({ entity: 'fermsched', id: id, field: 'steps' });
    }
  });
  (sheetSchedules || []).forEach(function (sh) {
    var id = text(sh.schedule_id);
    if (id && !seen[id]) out.push({ entity: 'fermsched', id: id, field: 'missing_in_postgres' });
  });
}

function compareConfig(pgConfig, sheetConfig, out) {
  var pgByKey = {};
  (pgConfig || []).forEach(function (r) { pgByKey[r.key] = r.value; });
  var shByKey = {};
  (sheetConfig || []).forEach(function (r) { shByKey[text(r.key)] = r.value; });
  CONFIG_KEYS.forEach(function (key) {
    var inPg = Object.prototype.hasOwnProperty.call(pgByKey, key);
    var inSheet = Object.prototype.hasOwnProperty.call(shByKey, key);
    if (inPg && !inSheet) out.push({ entity: 'config', id: key, field: 'missing_in_sheet' });
    else if (!inPg && inSheet) out.push({ entity: 'config', id: key, field: 'missing_in_postgres' });
    else if (inPg && !sameText(pgByKey[key], shByKey[key])) out.push({ entity: 'config', id: key, field: 'value' });
  });
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/**
 * compareOps({pg:{vessels, schedules, config, staffEmails}, sheet:{vessels, vesselHeaders,
 * schedules, configRows}, envStaff}) -> {mismatches, staff, secretKeysInConfig, labelHeaderPresent}
 *
 * sheet.* lists hold plain header-keyed objects. envStaff null/undefined skips the staff leg.
 */
function compareOps(input) {
  var pg = input.pg || {};
  var sheet = input.sheet || {};
  var out = [];

  var headers = (sheet.vesselHeaders || []).map(function (h) { return String(h).trim(); });
  var labelHeaderPresent = headers.indexOf('label') !== -1;
  if (!labelHeaderPresent) out.push({ entity: 'vessel', id: '(sheet)', field: 'label_header_missing' });

  compareVessels(pg.vessels, sheet.vessels, labelHeaderPresent, out);
  compareSchedules(pg.schedules, sheet.schedules, out);
  compareConfig(pg.config, sheet.configRows, out);

  // SC3: nothing token-like may live in the Config tab. The key text is never echoed.
  var secretKeysInConfig = 0;
  (sheet.configRows || []).forEach(function (r) {
    if (SECRET_KEY_RE.test(text(r.key))) secretKeysInConfig++;
  });
  for (var i = 0; i < secretKeysInConfig; i++) {
    out.push({ entity: 'config', id: '(redacted)', field: 'secret_key_in_config' });
  }

  var staff = { missingFromPg: 0, pgOnly: 0, skipped: !Array.isArray(input.envStaff) };
  if (!staff.skipped) {
    var pgSet = {};
    (pg.staffEmails || []).forEach(function (e) { pgSet[normEmail(e)] = true; });
    var envSet = {};
    input.envStaff.forEach(function (e) { if (normEmail(e)) envSet[normEmail(e)] = true; });
    Object.keys(envSet).forEach(function (e) {
      if (!pgSet[e]) {
        staff.missingFromPg++;
        out.push({ entity: 'staff', id: '(env member)', field: 'missing_in_postgres' });
      }
    });
    Object.keys(pgSet).forEach(function (e) { if (!envSet[e]) staff.pgOnly++; });
  }

  return {
    mismatches: out,
    staff: staff,
    secretKeysInConfig: secretKeysInConfig,
    labelHeaderPresent: labelHeaderPresent
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  var opts = { file: undefined };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eq = arg.indexOf('=');
    var flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag !== '--file') {
      throw new Error('unknown flag "' + flag + '" - valid flags: --file');
    }
    opts.file = eq === -1 ? undefined : arg.slice(eq + 1);
  });
  return opts;
}

async function fetchPg(pool) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var vessels = await vesselPg.listVessels(client);
    var schedules = await fermSchedulePg.listSchedules(client, { includeArchived: true });
    var config = (await client.query(CONFIG_SQL)).rows;
    var staff = (await client.query(STAFF_SQL)).rows;
    await client.query('commit');
    return {
      vessels: vessels,
      schedules: schedules,
      config: config,
      staffEmails: staff.map(function (r) { return r.email; })
    };
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

function values(sheet) {
  return (sheet.rows || []).map(function (r) { return r.values || r; });
}

/**
 * runOpsVerify(opts, deps) -> Promise<{exitCode, result}>. deps: {pool, log, env}.
 */
async function runOpsVerify(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  var env = deps.env || process.env;

  try {
    assertSnapshotSafePath(opts.file);
    if (!opts.file || !fs.existsSync(opts.file)) throw new Error('snapshot not found');

    var sheets = await Promise.all([
      readXlsx.readSheet(opts.file, 'Vessels'),
      readXlsx.readSheet(opts.file, 'FermSchedules'),
      readXlsx.readSheet(opts.file, 'Config')
    ]);
    var envStaff = null;
    if (env.BACKFILL_STAFF_EMAILS) {
      envStaff = String(env.BACKFILL_STAFF_EMAILS).split(',').map(normEmail).filter(Boolean);
    } else {
      log('Notice: BACKFILL_STAFF_EMAILS not set - staff leg skipped');
    }

    var pg = await fetchPg(deps.pool);
    var result = compareOps({
      pg: pg,
      sheet: {
        vessels: values(sheets[0]),
        vesselHeaders: sheets[0].headers,
        schedules: values(sheets[1]),
        configRows: values(sheets[2])
      },
      envStaff: envStaff
    });

    log('Vessels label header: ' + (result.labelHeaderPresent ? 'present' : 'MISSING'));
    result.mismatches.forEach(function (m) { log(m.entity + ' ' + m.id + ' ' + m.field); });
    if (!result.staff.skipped) {
      log('Staff: missing from Postgres ' + result.staff.missingFromPg + ', Postgres-only ' + result.staff.pgOnly);
    }
    log('Compared ' + pg.vessels.length + ' vessels, ' + pg.schedules.length + ' schedules: ' +
      result.mismatches.length + ' mismatches');
    return { exitCode: result.mismatches.length === 0 ? EXIT.OK : EXIT.MISMATCH, result: result };
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
  runOpsVerify(opts, { pool: pool, log: console.log })
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
  compareOps: compareOps,
  runOpsVerify: runOpsVerify,
  parseArgs: parseArgs,
  EXIT: EXIT
};

'use strict';

/**
 * Batches backfill - Phase 87 Plan 05 (DB-06, ROADMAP SC3).
 *
 * Dedicated four-table orchestration (same shape as ops-backfill.js): one workbook snapshot
 * becomes batches, batch_tasks, plato_readings and vessel_history in ONE transaction, parents
 * first. Existing SV-B-/BT-/PR-/VH- ids are kept and the four id sequences are seeded with setval
 * to the highest existing suffix.
 *
 * buildBatchesBackfillPlan is PURE (no I/O). It REJECTS, never coerces: bad id formats,
 * duplicate ids, unknown status, orphan child rows, non-hex or duplicate access tokens,
 * non-numeric plato/day_offset/step_number, bad timestamps/dates, missing or unexpected headers.
 * Reject records carry sheet, row number, id, field name and a generic reason code only - never
 * a cell value or echoed header text (D-06: a non-empty rejects file is a no-go).
 *
 * Rows whose primary-key cell is blank are skipped, not rejected (the Batches sheet carries
 * hundreds of formatted-but-empty tail rows). Duplicate (batch_id, step_number) task pairs are
 * imported as-is (87-DESIGN Q2). unit_seq is assigned per (zoho_so_number, product_sku) by
 * created_at then batch_id for rows that have both fields, so the unique backstop index holds.
 *
 * Usage - run from zoho-middleware/; the snapshot is the owner's File -> Download .xlsx, kept
 * OUTSIDE the repo; credentials come from BACKFILL_DATABASE_URL only (never argv):
 *
 *   node scripts/backfill/batches-backfill.js --file=<snapshot.xlsx> --dry-run
 *   node scripts/backfill/batches-backfill.js --file=<snapshot.xlsx> --promote
 *
 * Flags are equals-form only: --file, --out-dir, --timezone (default America/Vancouver),
 * --dry-run, --promote. Exit codes: 0 ok, 1 error, 2 rejects (blocks promote), 3 promote check
 * failed. Promote needs EMPTY batches/batch_tasks/plato_readings/vessel_history/batch_tombstones/
 * batch_create_dedup, prompts for the database name and runs in one transaction.
 */

var fs = require('fs');
var path = require('path');
var readline = require('readline');

var db = require('../../lib/db');
var readXlsx = require('./read-xlsx');
var normalizeTimestamp = require('./normalize').normalizeTimestamp;
var rejectsLib = require('./rejects');
var backfillCli = require('./backfill');
var batchSpec = require('./specs/batches');
var taskSpec = require('./specs/batch-tasks');
var readingSpec = require('./specs/plato-readings-final');
var historySpec = require('./specs/vessel-history-final');

var EXIT = backfillCli.EXIT;
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var checkHeaders = backfillCli.checkHeaders;

var DEFAULT_TIMEZONE = 'America/Vancouver';
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var INSERT_BATCH_SIZE = 500;
var STATUSES = ['pending', 'primary', 'secondary', 'complete', 'disabled'];
var TOKEN_RE = /^[0-9a-f]{32}$/;
var NUMBER_RE = /^-?[0-9]+([.][0-9]+)?$/;
var INTEGER_RE = /^-?[0-9]+$/;
var DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

var ID_RES = {
  batch_id: /^SV-B-[0-9]{6,}$/,
  task_id: /^BT-[0-9]{6,}$/,
  reading_id: /^PR-[0-9]{6,}$/,
  history_id: /^VH-[0-9]{6,}$/
};

var SAFE_HEADER_RE = /^[A-Za-z][A-Za-z0-9_ ]{0,39}$/;
var REDACTED_HEADER = '<redacted header>';

var REASON_BY_TYPE = {
  id: 'invalid_id',
  text: 'invalid_text',
  nullable_text: 'invalid_text',
  date: 'invalid_date',
  timestamptz: 'invalid_timestamp',
  number: 'invalid_number',
  integer: 'invalid_number',
  boolean: 'invalid_boolean'
};

function colNames(spec) {
  return spec.columns.map(function (c) { return c.name; });
}

// ─── Small pure helpers ──────────────────────────────────────────────────

function makeReject(sheet, row, id, field, reason) {
  return { sheet: sheet, row: row, id: id, field: field, reason: reason };
}

function isBlank(raw) {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');
}

function rawId(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function validDateParts(y, m, d) {
  var t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// Returns { ok, value }. A Date cell is read as wall-clock (exceljs gives UTC components).
function normalizeDateOnly(raw) {
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return { ok: false };
    return { ok: true, value: raw.getUTCFullYear() + '-' + pad2(raw.getUTCMonth() + 1) + '-' + pad2(raw.getUTCDate()) };
  }
  if (typeof raw === 'string') {
    var m = DATE_RE.exec(raw.trim());
    if (m && validDateParts(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10))) {
      return { ok: true, value: raw.trim() };
    }
  }
  return { ok: false };
}

function normalizeBool(raw) {
  if (raw === true || raw === false) return { ok: true, value: raw };
  if (raw === 'TRUE') return { ok: true, value: true };
  if (raw === 'FALSE') return { ok: true, value: false };
  return { ok: false };
}

// Unconstrained numeric kept as text so nothing is ever rounded.
function normalizeNumberText(raw) {
  if (typeof raw === 'number') {
    if (!isFinite(raw)) return { ok: false };
    var s = String(raw);
    return /e/i.test(s) ? { ok: false } : { ok: true, value: s };
  }
  if (typeof raw === 'string' && NUMBER_RE.test(raw.trim())) return { ok: true, value: raw.trim() };
  return { ok: false };
}

function normalizeIntegerValue(raw) {
  if (typeof raw === 'number') {
    return isFinite(raw) && Math.floor(raw) === raw && Math.abs(raw) <= 2147483647
      ? { ok: true, value: raw }
      : { ok: false };
  }
  if (typeof raw === 'string' && INTEGER_RE.test(raw.trim())) {
    var n = parseInt(raw.trim(), 10);
    return isFinite(n) && Math.abs(n) <= 2147483647 ? { ok: true, value: n } : { ok: false };
  }
  return { ok: false };
}

function normalizeTextValue(raw) {
  if (typeof raw === 'string') return { ok: true, value: raw.trim() };
  if (typeof raw === 'number' && isFinite(raw)) return { ok: true, value: String(raw) };
  return { ok: false };
}

/**
 * Normalises one sheet row against a spec. Pushes generic rejects and returns null when any
 * column fails; returns the column-name keyed values otherwise.
 */
function normalizeSheetRow(spec, row, timezone, id, rejects) {
  var values = {};
  var failed = false;
  function fail(col, reason) {
    failed = true;
    rejects.push(makeReject(spec.sheet, row.rowNumber, id, col.name, reason));
  }

  spec.columns.forEach(function (col) {
    var raw = row.values[col.header];
    var result;

    if (isBlank(raw)) {
      if (col.required) {
        fail(col, 'required');
        return;
      }
      if (col.type === 'text') values[col.name] = '';
      else if (col.type === 'boolean') values[col.name] = false;
      else values[col.name] = null;
      return;
    }

    switch (col.type) {
      case 'id':
        result = typeof raw === 'string' && ID_RES[col.name] && ID_RES[col.name].test(raw.trim())
          ? { ok: true, value: raw.trim() }
          : { ok: false };
        break;
      case 'text':
      case 'nullable_text':
        result = normalizeTextValue(raw);
        break;
      case 'date':
        result = normalizeDateOnly(raw);
        break;
      case 'timestamptz':
        result = normalizeTimestamp(raw, { timezone: timezone });
        break;
      case 'number':
        result = normalizeNumberText(raw);
        break;
      case 'integer':
        result = normalizeIntegerValue(raw);
        break;
      case 'boolean':
        result = normalizeBool(raw);
        break;
      default:
        result = { ok: false };
    }
    if (!result.ok) {
      fail(col, REASON_BY_TYPE[col.type] || 'invalid_value');
      return;
    }
    values[col.name] = result.value;
  });
  return failed ? null : values;
}

// Header drift: every spec header must be present; any other header is a reject. Only plain
// identifier-like header names are echoed, and none when row 1 looks like data.
function checkSheetHeaders(spec, headers, rejects) {
  var check = checkHeaders(spec, headers || []);
  check.missing.forEach(function (h) {
    rejects.push(makeReject(spec.sheet, null, null, h, 'missing_header'));
  });
  var rowOneIsData = check.missing.length > 0;
  check.unmapped.forEach(function (h) {
    var safe = !rowOneIsData && SAFE_HEADER_RE.test(String(h));
    rejects.push(makeReject(spec.sheet, null, null, safe ? h : REDACTED_HEADER, 'unexpected_header'));
  });
  return check.missing.length === 0 && check.unmapped.length === 0;
}

function idSuffix(id) {
  return parseInt(id.slice(id.lastIndexOf('-') + 1), 10);
}

function maxSuffix(rows, field) {
  var max = 0;
  rows.forEach(function (r) {
    var n = idSuffix(r[field]);
    if (n > max) max = n;
  });
  return max;
}

// ─── Plan sections ───────────────────────────────────────────────────────

function assignUnitSeq(batches) {
  var groups = {};
  batches.forEach(function (b) {
    if (b.zoho_so_number !== '' && b.product_sku !== '') {
      var key = b.zoho_so_number + '\u0000' + b.product_sku;
      (groups[key] = groups[key] || []).push(b);
    }
  });
  Object.keys(groups).forEach(function (key) {
    groups[key].sort(function (a, b) {
      var d = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (d !== 0) return d;
      if (a.batch_id < b.batch_id) return -1;
      return a.batch_id > b.batch_id ? 1 : 0;
    });
    groups[key].forEach(function (b, i) { b.unit_seq = i + 1; });
  });
}

function planBatches(sheet, timezone, rejects) {
  var out = [];
  var seen = {};
  var seenToken = {};
  if (!checkSheetHeaders(batchSpec, sheet.headers, rejects)) return out;

  (sheet.rows || []).forEach(function (row) {
    if (isBlank(row.values.batch_id)) return; // formatted-but-empty tail row
    var id = rawId(row.values.batch_id);
    var before = rejects.length;
    var values = normalizeSheetRow(batchSpec, row, timezone, id, rejects);
    if (values) {
      if (seen[values.batch_id]) {
        rejects.push(makeReject('Batches', row.rowNumber, id, 'batch_id', 'duplicate_id'));
      }
      if (STATUSES.indexOf(values.status) === -1) {
        rejects.push(makeReject('Batches', row.rowNumber, id, 'status', 'invalid_status'));
      }
      if (!TOKEN_RE.test(values.access_token)) {
        rejects.push(makeReject('Batches', row.rowNumber, id, 'access_token', 'invalid_token'));
      } else if (seenToken[values.access_token]) {
        rejects.push(makeReject('Batches', row.rowNumber, id, 'access_token', 'duplicate_token'));
      }
    }
    if (!values || rejects.length > before) return;
    seen[values.batch_id] = true;
    seenToken[values.access_token] = true;
    values.unit_seq = null;
    out.push(values);
  });

  assignUnitSeq(out);
  return out;
}

function planChildren(spec, idField, sheet, timezone, batchIds, rejects) {
  var out = [];
  var seen = {};
  if (!checkSheetHeaders(spec, sheet.headers, rejects)) return out;
  var idHeader = spec.columns[0].header;

  (sheet.rows || []).forEach(function (row) {
    if (isBlank(row.values[idHeader])) return;
    var id = rawId(row.values[idHeader]);
    var before = rejects.length;
    var values = normalizeSheetRow(spec, row, timezone, id, rejects);
    if (values) {
      if (seen[values[idField]]) {
        rejects.push(makeReject(spec.sheet, row.rowNumber, id, idField, 'duplicate_id'));
      }
      if (!batchIds[values.batch_id]) {
        rejects.push(makeReject(spec.sheet, row.rowNumber, id, 'batch_id', 'orphan_parent'));
      }
    }
    if (!values || rejects.length > before) return;
    seen[values[idField]] = true;
    out.push(values);
  });
  return out;
}

/**
 * buildBatchesBackfillPlan(workbookRows, {timezone})
 * workbookRows: { Batches, BatchTasks, PlatoReadings, VesselHistory }, each { headers, rows }
 * (readSheet shape). Pure - no I/O. Returns
 * { tables: {batches, batch_tasks, plato_readings, vessel_history}, rejects, counts, seeds }.
 */
function buildBatchesBackfillPlan(workbookRows, opts) {
  opts = opts || {};
  var timezone = opts.timezone || DEFAULT_TIMEZONE;
  var sheets = workbookRows || {};
  var empty = function () { return { headers: [], rows: [] }; };
  var rejects = [];

  var batches = planBatches(sheets.Batches || empty(), timezone, rejects);
  var batchIds = {};
  batches.forEach(function (b) { batchIds[b.batch_id] = true; });

  var tasks = planChildren(taskSpec, 'task_id', sheets.BatchTasks || empty(), timezone, batchIds, rejects);
  var readings = planChildren(readingSpec, 'reading_id', sheets.PlatoReadings || empty(), timezone, batchIds, rejects);
  var history = planChildren(historySpec, 'history_id', sheets.VesselHistory || empty(), timezone, batchIds, rejects);

  return {
    tables: { batches: batches, batch_tasks: tasks, plato_readings: readings, vessel_history: history },
    rejects: rejects,
    counts: {
      batches: batches.length, batch_tasks: tasks.length,
      plato_readings: readings.length, vessel_history: history.length
    },
    seeds: {
      batch_id_seq: maxSuffix(batches, 'batch_id'),
      batch_task_id_seq: maxSuffix(tasks, 'task_id'),
      plato_reading_id_seq: maxSuffix(readings, 'reading_id'),
      vessel_history_id_seq: maxSuffix(history, 'history_id')
    }
  };
}

// ─── Promote: batched parameterised inserts, in one transaction ──────────

/** Table/column names are fixed literals owned by this module; only VALUES use $n (ASVS V5). */
function buildInsertSql(table, columns, batch) {
  var params = [];
  var groups = batch.map(function (row) {
    var placeholders = columns.map(function (col) {
      var v = row[col];
      if (v === undefined) v = null;
      params.push(v);
      return '$' + params.length;
    });
    return '(' + placeholders.join(', ') + ')';
  });
  return { sql: 'insert into ' + table + ' (' + columns.join(', ') + ') values ' + groups.join(', '), params: params };
}

function insertBatched(client, table, columns, rows) {
  var chunks = [];
  for (var i = 0; i < rows.length; i += INSERT_BATCH_SIZE) chunks.push(rows.slice(i, i + INSERT_BATCH_SIZE));
  return chunks.reduce(function (chain, chunk) {
    return chain.then(function () {
      var built = buildInsertSql(table, columns, chunk);
      return client.query(built.sql, built.params);
    });
  }, Promise.resolve());
}

function scalar(client, sql) {
  return client.query(sql).then(function (r) { return r.rows[0].v; });
}

/**
 * In-transaction invariant checks, after every insert and all setval calls, BEFORE commit.
 * Names the failed check only - never row contents.
 */
function runBatchPromoteChecks(client, plan) {
  var orphanSql =
    'select ((select count(*) from batch_tasks t where not exists (select 1 from batches b where b.batch_id = t.batch_id))' +
    ' + (select count(*) from plato_readings r where not exists (select 1 from batches b where b.batch_id = r.batch_id))' +
    ' + (select count(*) from vessel_history h where not exists (select 1 from batches b where b.batch_id = h.batch_id)))::int as v';
  var checks = [
    ['batch_count', 'select count(*)::int as v from batches', function (v) { return v === plan.counts.batches; }],
    ['batch_task_count', 'select count(*)::int as v from batch_tasks', function (v) { return v === plan.counts.batch_tasks; }],
    ['plato_reading_count', 'select count(*)::int as v from plato_readings', function (v) { return v === plan.counts.plato_readings; }],
    ['vessel_history_count', 'select count(*)::int as v from vessel_history', function (v) { return v === plan.counts.vessel_history; }],
    ['batch_sequence', 'select last_value::bigint as v from batch_id_seq', function (v) { return Number(v) >= plan.seeds.batch_id_seq; }],
    ['batch_task_sequence', 'select last_value::bigint as v from batch_task_id_seq', function (v) { return Number(v) >= plan.seeds.batch_task_id_seq; }],
    ['plato_reading_sequence', 'select last_value::bigint as v from plato_reading_id_seq', function (v) { return Number(v) >= plan.seeds.plato_reading_id_seq; }],
    ['vessel_history_sequence', 'select last_value::bigint as v from vessel_history_id_seq', function (v) { return Number(v) >= plan.seeds.vessel_history_id_seq; }],
    ['orphan_children', orphanSql, function (v) { return v === 0; }],
    ['unit_seq_assigned',
      "select count(*)::int as v from batches where zoho_so_number <> '' and product_sku <> '' and unit_seq is null",
      function (v) { return v === 0; }]
  ];
  return checks.reduce(function (chain, c) {
    return chain.then(function (failed) {
      if (failed) return failed;
      return scalar(client, c[1]).then(function (v) { return c[2](v) ? null : { ok: false, failedCheck: c[0] }; });
    });
  }, Promise.resolve(null)).then(function (failed) { return failed || { ok: true }; });
}

function defaultPromptTypeDatabaseName(expectedName) {
  return new Promise(function (resolve, reject) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Type the database name (' + expectedName + ') to continue: ', function (answer) {
      rl.close();
      if (answer.trim() === expectedName) resolve();
      else reject(new Error('database name confirmation did not match - aborting, nothing written'));
    });
  });
}

var TARGET_TABLES = ['batches', 'batch_tasks', 'plato_readings', 'vessel_history', 'batch_tombstones', 'batch_create_dedup'];
// Fixed literal sequence names (never interpolated); the seed value is a bound parameter.
var SEQUENCE_SEED_SQL = {
  batch_id_seq: "select setval('batch_id_seq', $1)",
  batch_task_id_seq: "select setval('batch_task_id_seq', $1)",
  plato_reading_id_seq: "select setval('plato_reading_id_seq', $1)",
  vessel_history_id_seq: "select setval('vessel_history_id_seq', $1)"
};

function seedSequences(client, plan) {
  return Object.keys(SEQUENCE_SEED_SQL).reduce(function (chain, seq) {
    return chain.then(function () {
      if (plan.seeds[seq] > 0) return client.query(SEQUENCE_SEED_SQL[seq], [plan.seeds[seq]]);
      return undefined;
    });
  }, Promise.resolve());
}

/**
 * runPromote(client, plan, deps, log) -> Promise<exit code>
 * DB-name prompt, existence + emptiness + schedule-reference preconditions OUTSIDE the
 * transaction, then one transaction (parents first, setval x4, invariants). A non-empty target
 * or a failed invariant exits CHECKS_FAILED; any other failure exits ERROR. The client is
 * released exactly once. deps.promptTypeDatabaseName and deps.runChecks are injectable seams.
 * setval is not transactional: after a failed promote the sequences may sit at the seed values;
 * harmless because the tables are empty and the next promote re-seeds.
 */
function runPromote(client, plan, deps, log) {
  var promptFn = (deps && deps.promptTypeDatabaseName) || defaultPromptTypeDatabaseName;
  var checker = (deps && deps.runChecks) || runBatchPromoteChecks;
  var inTransaction = false;
  var blocked = false;

  return client
    .query('select current_database() as database')
    .then(function (r) {
      var databaseName = r.rows[0].database;
      log('Target: ' + db.redactConnectionString(process.env.BACKFILL_DATABASE_URL || '') + ' database=' + databaseName);
      return promptFn(databaseName);
    })
    .then(function () {
      return Promise.all(TARGET_TABLES.map(function (t) {
        return client.query("select to_regclass('public." + t + "') as reg");
      }));
    })
    .then(function (regs) {
      regs.forEach(function (r, i) {
        if (!r.rows[0].reg) throw new Error('target table public.' + TARGET_TABLES[i] + ' does not exist');
      });
      return Promise.all(TARGET_TABLES.map(function (t) {
        return client.query('select count(*)::int as count from ' + t);
      }));
    })
    .then(function (counts) {
      counts.forEach(function (r, i) {
        if (r.rows[0].count > 0) {
          blocked = true;
          log('Checks: FAIL - target_not_empty: public.' + TARGET_TABLES[i]);
        }
      });
      if (blocked) return null;
      return client.query('select schedule_id from ferm_schedules').then(function (res) {
        var known = {};
        res.rows.forEach(function (row) { known[row.schedule_id] = true; });
        var missing = 0;
        plan.tables.batches.forEach(function (b) {
          if (b.schedule_id !== null && !known[b.schedule_id]) missing++;
        });
        if (missing > 0) {
          blocked = true;
          log('Checks: FAIL - schedule_reference: ' + missing + ' batches reference a schedule not in ferm_schedules');
        }
        return null;
      });
    })
    .then(function () {
      if (blocked) return null;
      return client.query('BEGIN').then(function () {
        inTransaction = true;
        var t = plan.tables;
        return insertBatched(client, 'batches', colNames(batchSpec).concat(['unit_seq']), t.batches)
          .then(function () { return insertBatched(client, 'batch_tasks', colNames(taskSpec), t.batch_tasks); })
          .then(function () { return insertBatched(client, 'plato_readings', colNames(readingSpec), t.plato_readings); })
          .then(function () { return insertBatched(client, 'vessel_history', colNames(historySpec), t.vessel_history); })
          .then(function () { return seedSequences(client, plan); })
          .then(function () { return checker(client, plan); });
      });
    })
    .then(function (checkResult) {
      if (blocked) {
        client.release();
        return EXIT.CHECKS_FAILED;
      }
      if (!checkResult.ok) {
        log('Checks: FAIL - ' + checkResult.failedCheck);
        return client.query('ROLLBACK').then(function () {
          client.release();
          return EXIT.CHECKS_FAILED;
        });
      }
      return client.query('COMMIT').then(function () {
        log(
          'Promoted ' + plan.counts.batches + ' batches, ' + plan.counts.batch_tasks + ' tasks, ' +
            plan.counts.plato_readings + ' readings, ' + plan.counts.vessel_history + ' history rows; sequences at ' +
            plan.seeds.batch_id_seq + ' / ' + plan.seeds.batch_task_id_seq + ' / ' +
            plan.seeds.plato_reading_id_seq + ' / ' + plan.seeds.vessel_history_id_seq
        );
        client.release();
        return EXIT.OK;
      });
    })
    .catch(function (err) {
      log('Error: ' + err.message);
      var rollback = inTransaction ? client.query('ROLLBACK') : Promise.resolve();
      return rollback.then(
        function () { client.release(); return EXIT.ERROR; },
        function () { client.release(); return EXIT.ERROR; }
      );
    });
}

// ─── CLI ───────────────────────────────────────────────────────────────────

var VALID_FLAGS = ['--file', '--out-dir', '--timezone', '--dry-run', '--promote'];
var BOOLEAN_FLAGS = { '--dry-run': 'dryRun', '--promote': 'promote' };
var VALUE_FLAGS = { '--file': 'file', '--out-dir': 'outDir', '--timezone': 'timezone' };

/**
 * Equals-form flags only. A Postgres URL anywhere in argv is refused (credentials belong in
 * BACKFILL_DATABASE_URL, never shell history). No --accept-rejects: any reject blocks.
 */
function parseArgs(argv) {
  var opts = {
    file: undefined, outDir: rejectsLib.DEFAULT_OUT_DIR, timezone: DEFAULT_TIMEZONE, dryRun: false, promote: false
  };
  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error('pass the database via BACKFILL_DATABASE_URL, never on the command line');
    }
    var eqIdx = arg.indexOf('=');
    var flag = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    var value = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    if (VALID_FLAGS.indexOf(flag) === -1) {
      throw new Error('unknown flag "' + flag + '" - valid flags: ' + VALID_FLAGS.join(', '));
    }
    if (BOOLEAN_FLAGS[flag]) {
      opts[BOOLEAN_FLAGS[flag]] = true;
      return;
    }
    opts[VALUE_FLAGS[flag]] = value;
  });
  return opts;
}

function writeSummary(outDir, sourceFile, plan) {
  var now = new Date();
  var stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]+Z$/, 'Z');
  var outPath = path.join(outDir, 'batches-summary-' + stamp + '.json');
  rejectsLib.assertSafePath(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  var body = {
    sourceFile: path.basename(sourceFile || ''),
    generatedAt: now.toISOString(),
    counts: plan.counts,
    seeds: plan.seeds,
    rejectCount: plan.rejects.length
  };
  fs.writeFileSync(outPath, JSON.stringify(body, null, 2), { mode: 0o600 });
  return path.resolve(outPath);
}

/**
 * runBatchesBackfill(argv, deps) -> Promise<exit code>
 * deps: { pool, log, promptTypeDatabaseName, runChecks, planHook }. When deps.pool is absent and
 * a promote is requested, a pool is created from BACKFILL_DATABASE_URL (the only accepted
 * source). deps.planHook(plan) is a TEST-ONLY seam applied just before promote. Output is
 * counts, ids and field names only.
 */
function runBatchesBackfill(argv, deps) {
  deps = deps || {};
  var log = deps.log || console.log;

  var opts;
  try {
    opts = parseArgs(argv || []);
  } catch (err) {
    log('Error: ' + err.message);
    return Promise.resolve(EXIT.ERROR);
  }
  if (!opts.file) {
    log('Error: --file is required');
    return Promise.resolve(EXIT.ERROR);
  }
  if (opts.dryRun && opts.promote) {
    log('Error: pass either --dry-run or --promote, not both');
    return Promise.resolve(EXIT.ERROR);
  }
  try {
    assertSnapshotSafePath(opts.file);
  } catch (err) {
    log('Error: ' + err.message);
    return Promise.resolve(EXIT.ERROR);
  }
  if (!fs.existsSync(opts.file)) {
    log('Error: snapshot not found: ' + opts.file);
    return Promise.resolve(EXIT.ERROR);
  }

  var timezone = opts.timezone || DEFAULT_TIMEZONE;
  var sheetNames = [batchSpec.sheet, taskSpec.sheet, readingSpec.sheet, historySpec.sheet];

  log('[1/5] Read snapshot');
  return Promise.all(sheetNames.map(function (n) { return readXlsx.readSheet(opts.file, n); }))
    .then(function (read) {
      var workbook = {};
      sheetNames.forEach(function (n, i) { workbook[n] = read[i]; });

      log('[2/5] Build plan');
      var plan = buildBatchesBackfillPlan(workbook, { timezone: timezone });

      log('[3/5] Rejects report');
      return Promise.all(sheetNames.map(function (n) {
        return rejectsLib.writeRejectsReport({
          sheet: n, sourceFile: opts.file, outDir: opts.outDir,
          rejects: plan.rejects.filter(function (r) { return r.sheet === n; })
        });
      })).then(function (paths) {
        paths.push(writeSummary(opts.outDir, opts.file, plan));
        log('Read: ' + sheetNames.map(function (n) { return workbook[n].rows.length + ' ' + n + ' rows'; }).join(', '));
        log(
          'Plan: ' + plan.counts.batches + ' batches, ' + plan.counts.batch_tasks + ' tasks, ' +
            plan.counts.plato_readings + ' readings, ' + plan.counts.vessel_history + ' history rows'
        );
        log(
          'Seeds: batch_id_seq ' + plan.seeds.batch_id_seq + ', batch_task_id_seq ' + plan.seeds.batch_task_id_seq +
            ', plato_reading_id_seq ' + plan.seeds.plato_reading_id_seq +
            ', vessel_history_id_seq ' + plan.seeds.vessel_history_id_seq
        );
        log(plan.rejects.length + ' rejects');
        plan.rejects.forEach(function (r) {
          log('  reject: ' + r.sheet + ' row ' + r.row + ' id ' + r.id + ' field ' + r.field + ' (' + r.reason + ')');
        });
        log('Output files: ' + paths.join(', '));

        if (plan.rejects.length > 0) {
          log('[4/5] Rejects present - promotion blocked. Resolve in the sheet and re-run.');
          return EXIT.REJECTS_BLOCK;
        }
        if (opts.dryRun) {
          log('[4/5] Promote - skipped (--dry-run)');
          log('[5/5] Promote - skipped (--dry-run)');
          return EXIT.OK;
        }
        if (!opts.promote) {
          log('[4/5] Promote - skipped - pass --promote');
          return EXIT.OK;
        }

        if (typeof deps.planHook === 'function') deps.planHook(plan);

        var pool = deps.pool;
        var ownPool = false;
        if (!pool) {
          if (!process.env.BACKFILL_DATABASE_URL) {
            log('Error: BACKFILL_DATABASE_URL must be set to promote');
            return EXIT.ERROR;
          }
          pool = db.createPool(process.env.BACKFILL_DATABASE_URL, { max: 2 });
          ownPool = true;
        }

        log('[5/5] Promote');
        return pool
          .connect()
          .then(function (client) { return runPromote(client, plan, deps, log); })
          .then(
            function (code) { return ownPool ? pool.end().then(function () { return code; }) : code; },
            function (err) {
              log('Error: ' + err.message);
              return ownPool ? pool.end().then(function () { return EXIT.ERROR; }) : EXIT.ERROR;
            }
          );
      });
    })
    .catch(function (err) {
      log('Error: ' + err.message);
      return EXIT.ERROR;
    });
}

if (require.main === module) {
  runBatchesBackfill(process.argv.slice(2), { log: console.log }).then(
    function (code) { process.exit(code); },
    function (err) {
      console.error('Fatal: ' + err.message);
      process.exit(EXIT.ERROR);
    }
  );
}

module.exports = {
  buildBatchesBackfillPlan: buildBatchesBackfillPlan,
  runBatchesBackfill: runBatchesBackfill,
  runBatchPromoteChecks: runBatchPromoteChecks,
  runPromote: runPromote,
  parseArgs: parseArgs,
  EXIT: EXIT,
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE
};

'use strict';

/**
 * Ops backfill - Phase 86 Plan 09 (DB-05, ROADMAP SC1).
 *
 * Dedicated four-table orchestration (same shape as recipes-backfill.js, not the generic
 * single-table backfill.js path): one workbook snapshot becomes vessels, ferm_schedules,
 * config and staff_access in ONE transaction.
 *
 * buildOpsBackfillPlan is PURE (no I/O). It:
 *   - keeps every vessel_id and schedule_id unchanged (D-13: existing FS- ids are kept);
 *   - derives vessels.position from sheet row order;
 *   - maps status Disabled/Retired to archived=true with status 'Empty' (D-07); any other
 *     unknown status, duplicate id or malformed id is a reject;
 *   - trims vessel location (D-17); reads the optional owner-added Vessels 'label' header
 *     (header-addressed, '' -> NULL); it is the only extra Vessels header accepted. Whether the
 *     header is present is enforced by ops-verify (86-14), not here;
 *   - validates every FermSchedules steps blob with lib/ferm-schedule-rules (parseSteps +
 *     validateSteps); a bad blob is a reject, never imported;
 *   - hard-rejects Config keys matching token|secret|password|key and imports ONLY
 *     hold_expiry_hours and google_calendar_id (SC3). staff_emails is not a config row (D-04);
 *   - REJECTS (never coerces) any bad row. Reject records carry sheet, row number, id, field
 *     name and a generic reason code only - never a cell value or an email.
 *
 * Staff source (deviation from 86-RESEARCH Pattern 8): staff_access is seeded from the current
 * Railway sign-in list (BACKFILL_STAFF_EMAILS, the STAFF_EMAILS value) plus the required
 * --owners flag - NOT from the Config staff_emails cell. Config-only emails are reported as a
 * count and skipped, because importing them would widen middleware sign-in beyond today's list
 * (D-01, D-10). Owners are never guessed. Emails are masked in any human output.
 *
 * Usage - run from zoho-middleware/; the snapshot is the owner's File -> Download .xlsx, kept
 * OUTSIDE the repo:
 *   node scripts/backfill/ops-backfill.js --file=/path/snapshot.xlsx --owners=a@x,b@y --dry-run
 *   read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL     # never on argv
 *   read -s BACKFILL_STAFF_EMAILS && export BACKFILL_STAFF_EMAILS     # Railway STAFF_EMAILS value
 *   node scripts/backfill/ops-backfill.js --file=/path/snapshot.xlsx --owners=a@x,b@y --promote
 * Flags (equals-form only): --file=PATH, --owners=a,b (required), --out-dir=PATH,
 * --timezone=ZONE, --dry-run | --promote. Exit codes: 0 ok, 1 error, 2 rejects present
 * (blocks promote), 3 promote check failed (precondition or in-transaction invariant).
 * Promote needs EMPTY vessels/ferm_schedules/config/staff_access, prompts for the database
 * name, runs in one transaction and seeds ferm_schedule_id_seq (max FS suffix) and
 * vessel_position_seq (vessel count).
 */

var fs = require('fs');
var readline = require('readline');

var db = require('../../lib/db');
var readXlsx = require('./read-xlsx');
var normalizeRow = require('./normalize').normalizeRow;
var rejectsLib = require('./rejects');
var backfillCli = require('./backfill');
var scheduleRules = require('../../lib/ferm-schedule-rules');
var vesselSpec = require('./specs/vessels');
var scheduleSpec = require('./specs/ops-ferm-schedules');
var configSpec = require('./specs/config');

var EXIT = backfillCli.EXIT;
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var checkHeaders = backfillCli.checkHeaders;

var DEFAULT_TIMEZONE = 'America/Vancouver';
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var INSERT_BATCH_SIZE = 500;
var VESSEL_ID_RE = /^[A-Z]{2,6}-[0-9]{3,}$/;
var SCHEDULE_ID_RE = /^FS-([0-9]{4,})$/;
var EMAIL_RE = /^[^@ ]+@[^@ ]+[.][^@ ]+$/;
var SECRET_KEY_RE = /token|secret|password|key/i;
var ARCHIVE_STATUSES = ['Disabled', 'Retired', 'Disabled/Retired'];
var LIVE_STATUSES = ['Empty', 'In-Use'];
var IMPORTED_CONFIG_KEYS = ['hold_expiry_hours', 'google_calendar_id'];

var VESSEL_COLUMNS = [
  'vessel_id', 'position', 'label', 'type', 'material', 'capacity_liters', 'status', 'archived',
  'bottom_diameter_cm', 'top_diameter_cm', 'depth_cm', 'location', 'brand', 'notes', 'updated_at'
];
var SCHEDULE_COLUMNS = [
  'schedule_id', 'name', 'description', 'category', 'steps', 'is_active', 'created_at',
  'created_by', 'updated_at'
];
var CONFIG_COLUMNS = ['key', 'value', 'updated_by'];
var STAFF_COLUMNS = ['email', 'role', 'added_by'];

// ─── Small pure helpers ──────────────────────────────────────────────────

var REASON_BY_TYPE = {
  timestamptz: 'invalid_timestamp',
  numeric: 'invalid_number',
  id: 'invalid_id',
  text: 'invalid_text',
  jsonb: 'invalid_json',
  boolean: 'invalid_boolean'
};

function columnType(spec, name) {
  for (var i = 0; i < spec.columns.length; i++) {
    if (spec.columns[i].name === name) return spec.columns[i].type;
  }
  return null;
}

function trimNumeric(value) {
  if (typeof value !== 'string' || value.indexOf('.') === -1) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

function rawId(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

var SAFE_HEADER_RE = /^[A-Za-z][A-Za-z0-9_ ]{0,39}$/;
var REDACTED_HEADER = '<redacted header>';

function makeReject(sheet, row, id, field, reason) {
  return { sheet: sheet, row: row, id: id, field: field, reason: reason };
}

function maskEmail(email) {
  var s = String(email || '');
  var at = s.indexOf('@');
  if (at < 1) return '***';
  return s.charAt(0) + '***@' + s.slice(at + 1);
}

function normalizeSheetRow(spec, row, timezone, idField, rejects) {
  var id = rawId(row.values[idField]);
  var result = normalizeRow(spec, row.values, { timezone: timezone });
  if (!result.ok) {
    result.reasons.forEach(function (r) {
      var reason = r.reason === 'required' ? 'required' : (REASON_BY_TYPE[columnType(spec, r.column)] || 'invalid_value');
      rejects.push(makeReject(spec.sheet, row.rowNumber, id, r.column, reason));
    });
    return null;
  }
  spec.columns.forEach(function (col) {
    if (col.type === 'numeric' && result.values[col.name] !== null) {
      result.values[col.name] = trimNumeric(result.values[col.name]);
    }
  });
  return result.values;
}

// Header drift: every spec header must be present; any header outside the spec (and outside
// the spec's optionalHeaders) is a reject. Returns { ok, hasOptional: {name: bool} }.
function checkSheetHeaders(spec, headers, rejects) {
  var check = checkHeaders(spec, headers || []);
  var optional = spec.optionalHeaders || [];
  var hasOptional = {};
  optional.forEach(function (h) { hasOptional[h] = (headers || []).indexOf(h) !== -1; });

  check.missing.forEach(function (h) {
    rejects.push(makeReject(spec.sheet, null, null, h, 'missing_header'));
  });
  var unexpected = check.unmapped.filter(function (h) { return optional.indexOf(h) === -1; });
  // A missing required header means row 1 is probably data (e.g. a headerless Config tab whose
  // first row is staff_emails | <emails>), so none of its text is echoed. Otherwise only plain
  // identifier-like header names are named; anything else could be data and is redacted.
  var rowOneIsData = check.missing.length > 0;
  unexpected.forEach(function (h) {
    var safe = !rowOneIsData && SAFE_HEADER_RE.test(String(h));
    rejects.push(makeReject(spec.sheet, null, null, safe ? h : REDACTED_HEADER, 'unexpected_header'));
  });
  return { ok: check.missing.length === 0 && unexpected.length === 0, hasOptional: hasOptional };
}

function splitEmails(value) {
  if (Array.isArray(value)) return value.map(function (v) { return String(v).trim().toLowerCase(); }).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value.split(',').map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
}

// ─── Plan sections ───────────────────────────────────────────────────────

function planVessels(sheet, timezone, rejects) {
  var vessels = [];
  var seen = {};
  var headerCheck = checkSheetHeaders(vesselSpec, sheet.headers, rejects);
  if (!headerCheck.ok) return vessels;
  var hasLabel = headerCheck.hasOptional.label;

  (sheet.rows || []).forEach(function (row) {
    var before = rejects.length;
    var id = rawId(row.values.vessel_id);
    var values = normalizeSheetRow(vesselSpec, row, timezone, 'vessel_id', rejects);
    var label = null;

    if (values) {
      if (!VESSEL_ID_RE.test(values.vessel_id)) {
        rejects.push(makeReject(vesselSpec.sheet, row.rowNumber, id, 'vessel_id', 'invalid_id'));
      } else if (seen[values.vessel_id]) {
        rejects.push(makeReject(vesselSpec.sheet, row.rowNumber, id, 'vessel_id', 'duplicate_id'));
      }
      if (ARCHIVE_STATUSES.indexOf(values.status) === -1 && LIVE_STATUSES.indexOf(values.status) === -1) {
        rejects.push(makeReject(vesselSpec.sheet, row.rowNumber, id, 'status', 'invalid_status'));
      }
      if (hasLabel) {
        var rawLabel = row.values.label;
        if (typeof rawLabel === 'string') {
          label = rawLabel.trim() === '' ? null : rawLabel.trim();
        } else if (typeof rawLabel === 'number' && isFinite(rawLabel)) {
          label = String(rawLabel);
        } else if (rawLabel !== null && rawLabel !== undefined) {
          rejects.push(makeReject(vesselSpec.sheet, row.rowNumber, id, 'label', 'invalid_text'));
        }
      }
    }

    if (!values || rejects.length > before) return;
    seen[values.vessel_id] = true;
    var archived = ARCHIVE_STATUSES.indexOf(values.status) !== -1;
    vessels.push({
      vessel_id: values.vessel_id,
      position: vessels.length + 1,
      label: label,
      type: values.type,
      material: values.material,
      capacity_liters: values.capacity_liters,
      status: archived ? 'Empty' : values.status,
      archived: archived,
      bottom_diameter_cm: values.bottom_diameter_cm,
      top_diameter_cm: values.top_diameter_cm,
      depth_cm: values.depth_cm,
      location: values.location,
      brand: values.brand,
      notes: values.notes
    });
  });
  return vessels;
}

function planSchedules(sheet, timezone, rejects) {
  var schedules = [];
  var seen = {};
  if (!checkSheetHeaders(scheduleSpec, sheet.headers, rejects).ok) return schedules;

  (sheet.rows || []).forEach(function (row) {
    var before = rejects.length;
    var id = rawId(row.values.schedule_id);
    var values = normalizeSheetRow(scheduleSpec, row, timezone, 'schedule_id', rejects);

    if (values) {
      if (!SCHEDULE_ID_RE.test(values.schedule_id)) {
        rejects.push(makeReject(scheduleSpec.sheet, row.rowNumber, id, 'schedule_id', 'invalid_id'));
      } else if (seen[values.schedule_id]) {
        rejects.push(makeReject(scheduleSpec.sheet, row.rowNumber, id, 'schedule_id', 'duplicate_id'));
      }
      var parsed = scheduleRules.parseSteps(values.steps);
      var verdict = parsed.ok ? scheduleRules.validateSteps(parsed.steps) : parsed;
      if (!verdict.ok) {
        rejects.push(makeReject(scheduleSpec.sheet, row.rowNumber, id, 'steps', verdict.error));
      } else {
        values.steps = parsed.steps;
      }
    }

    if (!values || rejects.length > before) return;
    seen[values.schedule_id] = true;
    schedules.push({
      schedule_id: values.schedule_id,
      name: values.name,
      description: values.description,
      category: values.category,
      steps: values.steps,
      is_active: values.is_active,
      created_at: values.created_at,
      created_by: values.created_by,
      updated_at: values.updated_at
    });
  });
  return schedules;
}

function planConfig(sheet, timezone, rejects) {
  var config = [];
  var seen = {};
  var configStaffEmails = [];
  var skipped = 0;
  if (!checkSheetHeaders(configSpec, sheet.headers, rejects).ok) {
    return { config: config, configStaffEmails: configStaffEmails, skipped: skipped };
  }

  (sheet.rows || []).forEach(function (row) {
    var before = rejects.length;
    var values = normalizeSheetRow(configSpec, row, timezone, 'key', rejects);
    if (!values) return;

    // Secret-looking keys are rejected with no id (the key text is not echoed) and no value.
    if (SECRET_KEY_RE.test(values.key)) {
      rejects.push(makeReject(configSpec.sheet, row.rowNumber, null, 'key', 'secret_key_forbidden'));
      return;
    }
    if (values.key === 'staff_emails') {
      configStaffEmails = configStaffEmails.concat(splitEmails(values.value || ''));
      return;
    }
    if (IMPORTED_CONFIG_KEYS.indexOf(values.key) === -1) {
      skipped++;
      return;
    }
    if (values.value === null || values.value === undefined) {
      rejects.push(makeReject(configSpec.sheet, row.rowNumber, values.key, 'value', 'required'));
    }
    if (seen[values.key]) {
      rejects.push(makeReject(configSpec.sheet, row.rowNumber, values.key, 'key', 'duplicate_id'));
    }
    if (rejects.length > before) return;
    seen[values.key] = true;
    config.push({ key: values.key, value: values.value });
  });
  return { config: config, configStaffEmails: configStaffEmails, skipped: skipped };
}

function planStaff(owners, staffEmails, rejects) {
  var ownerList = splitEmails(owners);
  var railway = splitEmails(staffEmails);
  var roleByEmail = {};
  var invalid = false;

  ownerList.concat(railway).forEach(function (email) {
    if (!EMAIL_RE.test(email)) {
      if (!invalid) rejects.push(makeReject('staff', null, null, 'email', 'invalid_email'));
      invalid = true;
      return;
    }
    if (roleByEmail[email] === undefined) {
      roleByEmail[email] = 'staff';
    }
  });
  ownerList.forEach(function (email) {
    if (roleByEmail[email] !== undefined) roleByEmail[email] = 'owner';
  });

  // Railway-list order first (owners not in the list follow), as read from the env var.
  var ordered = railway.filter(function (e) { return roleByEmail[e] !== undefined; })
    .concat(ownerList.filter(function (e) { return roleByEmail[e] !== undefined; }));
  var dedup = {};
  var staff = [];
  ordered.forEach(function (email) {
    if (dedup[email]) return;
    dedup[email] = true;
    staff.push({ email: email, role: roleByEmail[email] });
  });
  return staff;
}

function maxScheduleSuffix(schedules) {
  var max = 0;
  schedules.forEach(function (s) {
    var m = SCHEDULE_ID_RE.exec(s.schedule_id);
    if (m && parseInt(m[1], 10) > max) max = parseInt(m[1], 10);
  });
  return max;
}

/**
 * buildOpsBackfillPlan({workbookSheets, owners, staffEmails, timezone})
 *
 * workbookSheets: { Vessels, FermSchedules, Config } each { headers, rows } (readSheet shape).
 * owners: array or comma string; staffEmails: comma string or array (Railway STAFF_EMAILS).
 * Pure - no I/O. A missing owners list returns { error: 'owners_required' } with empty sets.
 */
function buildOpsBackfillPlan(input) {
  var timezone = input.timezone || DEFAULT_TIMEZONE;
  var sheets = input.workbookSheets || {};
  var rejects = [];
  var empty = function () { return { headers: [], rows: [] }; };

  var plan = {
    vessels: [], schedules: [], config: [], staff: [], rejects: rejects,
    seeds: { fermScheduleMax: 0, vesselCount: 0 },
    notImportedConfigStaffCount: 0,
    skippedConfigCount: 0
  };

  if (splitEmails(input.owners).length === 0) {
    plan.error = 'owners_required';
    return plan;
  }

  plan.vessels = planVessels(sheets.Vessels || empty(), timezone, rejects);
  plan.schedules = planSchedules(sheets.FermSchedules || empty(), timezone, rejects);
  var cfg = planConfig(sheets.Config || empty(), timezone, rejects);
  plan.config = cfg.config;
  plan.skippedConfigCount = cfg.skipped;
  plan.staff = planStaff(input.owners, input.staffEmails, rejects);

  var staffSet = {};
  plan.staff.forEach(function (s) { staffSet[s.email] = true; });
  var extra = {};
  cfg.configStaffEmails.forEach(function (e) { if (!staffSet[e]) extra[e] = true; });
  plan.notImportedConfigStaffCount = Object.keys(extra).length;

  plan.seeds = { fermScheduleMax: maxScheduleSuffix(plan.schedules), vesselCount: plan.vessels.length };
  plan.counts = {
    vessels: plan.vessels.length,
    schedules: plan.schedules.length,
    config: plan.config.length,
    staff: plan.staff.length
  };
  return plan;
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
  var batches = [];
  for (var i = 0; i < rows.length; i += INSERT_BATCH_SIZE) batches.push(rows.slice(i, i + INSERT_BATCH_SIZE));
  return batches.reduce(function (chain, batch) {
    return chain.then(function () {
      var built = buildInsertSql(table, columns, batch);
      // steps is a JS array: pg would serialise it as a PG array literal, so send JSON text.
      built.params = built.params.map(function (p) { return Array.isArray(p) ? JSON.stringify(p) : p; });
      return client.query(built.sql, built.params);
    });
  }, Promise.resolve());
}

function scalar(client, sql) {
  return client.query(sql).then(function (r) { return r.rows[0].v; });
}

/**
 * In-transaction invariant checks, after every insert and both setval calls, BEFORE commit.
 * Names the failed check only - never row contents.
 */
function runOpsPromoteChecks(client, plan) {
  var checks = [
    ['vessel_count', "select count(*)::int as v from vessels", function (v) { return v === plan.counts.vessels; }],
    ['schedule_count', "select count(*)::int as v from ferm_schedules", function (v) { return v === plan.counts.schedules; }],
    ['config_count', "select count(*)::int as v from config", function (v) { return v === plan.counts.config; }],
    ['staff_count', "select count(*)::int as v from staff_access", function (v) { return v === plan.counts.staff; }],
    ['owner_count', "select count(*)::int as v from staff_access where role = 'owner'", function (v) { return v >= 1; }],
    ['schedule_sequence', "select last_value::bigint as v from ferm_schedule_id_seq",
      function (v) { return Number(v) >= plan.seeds.fermScheduleMax; }],
    ['vessel_sequence', "select last_value::bigint as v from vessel_position_seq",
      function (v) { return Number(v) >= plan.seeds.vesselCount; }]
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

var TARGET_TABLES = ['vessels', 'ferm_schedules', 'config', 'staff_access'];

/**
 * runPromote(client, plan, deps, log) -> Promise<exit code>
 * DB-name prompt, existence + emptiness preconditions OUTSIDE the transaction, then one
 * transaction (vessels, schedules, config, staff, setval x2, invariants). A non-empty target
 * or a failed invariant exits CHECKS_FAILED; any other failure exits ERROR. The client is
 * released exactly once. setval is not transactional: after a failed promote the sequences may
 * sit at the seed values; harmless because the tables are empty and the next promote re-seeds.
 */
function runPromote(client, plan, deps, log) {
  var promptFn = (deps && deps.promptTypeDatabaseName) || defaultPromptTypeDatabaseName;
  var inTransaction = false;
  var nonEmpty = false;
  var now = new Date().toISOString();

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
          nonEmpty = true;
          log('Checks: FAIL - target table public.' + TARGET_TABLES[i] + ' is not empty');
        }
      });
      if (nonEmpty) return null;
      return client.query('BEGIN').then(function () {
        inTransaction = true;
        var vessels = plan.vessels.map(function (v) { return Object.assign({}, v, { updated_at: now }); });
        var config = plan.config.map(function (c) { return { key: c.key, value: c.value, updated_by: 'backfill' }; });
        var staff = plan.staff.map(function (s) { return { email: s.email, role: s.role, added_by: 'backfill' }; });
        return insertBatched(client, 'vessels', VESSEL_COLUMNS, vessels)
          .then(function () { return insertBatched(client, 'ferm_schedules', SCHEDULE_COLUMNS, plan.schedules); })
          .then(function () { return insertBatched(client, 'config', CONFIG_COLUMNS, config); })
          .then(function () { return insertBatched(client, 'staff_access', STAFF_COLUMNS, staff); })
          .then(function () {
            if (plan.seeds.fermScheduleMax > 0) {
              return client.query("select setval('ferm_schedule_id_seq', $1)", [plan.seeds.fermScheduleMax]);
            }
          })
          .then(function () {
            if (plan.seeds.vesselCount > 0) {
              return client.query("select setval('vessel_position_seq', $1)", [plan.seeds.vesselCount]);
            }
          })
          .then(function () { return runOpsPromoteChecks(client, plan); });
      });
    })
    .then(function (checkResult) {
      if (nonEmpty) {
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
          'Promoted ' + plan.counts.vessels + ' vessels, ' + plan.counts.schedules + ' schedules, ' +
            plan.counts.config + ' config keys, ' + plan.counts.staff + ' staff; sequences at ' +
            plan.seeds.fermScheduleMax + ' / ' + plan.seeds.vesselCount
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

var VALID_FLAGS = ['--file', '--owners', '--out-dir', '--timezone', '--dry-run', '--promote'];
var BOOLEAN_FLAGS = { '--dry-run': 'dryRun', '--promote': 'promote' };
var VALUE_FLAGS = { '--file': 'file', '--owners': 'owners', '--out-dir': 'outDir', '--timezone': 'timezone' };

/**
 * Equals-form flags only. A Postgres URL anywhere in argv is refused (credentials belong in
 * BACKFILL_DATABASE_URL, never shell history). No --accept-rejects: any reject blocks.
 */
function parseArgs(argv) {
  var opts = {
    file: undefined, owners: undefined, outDir: rejectsLib.DEFAULT_OUT_DIR,
    timezone: DEFAULT_TIMEZONE, dryRun: false, promote: false
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

/**
 * runOpsBackfill(argv, deps) -> Promise<exit code>
 * deps: { pool, log, promptTypeDatabaseName, planHook, env }. When deps.pool is absent and a
 * promote is requested, a pool is created from BACKFILL_DATABASE_URL (the only accepted source).
 * deps.planHook(plan) is a TEST-ONLY seam applied just before promote. deps.env overrides
 * process.env for BACKFILL_STAFF_EMAILS. Output is counts, ids, field names, masked emails only.
 */
function runOpsBackfill(argv, deps) {
  deps = deps || {};
  var log = deps.log || console.log;
  var env = deps.env || process.env;

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
  if (splitEmails(opts.owners).length === 0) {
    log('Error: --owners is required (at least one owner email; owners are never guessed)');
    return Promise.resolve(EXIT.ERROR);
  }
  if (opts.promote && !env.BACKFILL_STAFF_EMAILS) {
    log('Error: BACKFILL_STAFF_EMAILS must be set to promote (the Railway STAFF_EMAILS value)');
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
  var sheetNames = [vesselSpec.sheet, scheduleSpec.sheet, configSpec.sheet];

  log('[1/5] Read snapshot');
  return Promise.all(sheetNames.map(function (n) { return readXlsx.readSheet(opts.file, n); }))
    .then(function (read) {
      var workbookSheets = {};
      sheetNames.forEach(function (n, i) { workbookSheets[n] = read[i]; });

      log('[2/5] Build plan');
      var plan = buildOpsBackfillPlan({
        workbookSheets: workbookSheets,
        owners: opts.owners,
        staffEmails: env.BACKFILL_STAFF_EMAILS || '',
        timezone: timezone
      });
      if (plan.error) {
        log('Error: ' + plan.error);
        return EXIT.ERROR;
      }

      log('[3/5] Rejects report');
      return Promise.all(sheetNames.map(function (n) {
        return rejectsLib.writeRejectsReport({
          sheet: n, sourceFile: opts.file, outDir: opts.outDir,
          rejects: plan.rejects.filter(function (r) { return r.sheet === n; })
        });
      })).then(function (paths) {
        log('Read: ' + sheetNames.map(function (n) { return workbookSheets[n].rows.length + ' ' + n + ' rows'; }).join(', '));
        log(
          'Plan: ' + plan.vessels.length + ' vessels, ' + plan.schedules.length + ' schedules, ' +
            plan.config.length + ' config keys, ' + plan.staff.length + ' staff (' +
            plan.staff.filter(function (s) { return s.role === 'owner'; }).length + ' owners)'
        );
        log('Seeds: ferm_schedule_id_seq ' + plan.seeds.fermScheduleMax + ', vessel_position_seq ' + plan.seeds.vesselCount);
        log(
          'Config: ' + plan.skippedConfigCount + ' non-imported keys skipped; ' +
            plan.notImportedConfigStaffCount + ' Config staff_emails entries not in the Railway list (not imported)'
        );
        log(plan.rejects.length + ' rejects');
        plan.rejects.forEach(function (r) {
          log('  reject: ' + r.sheet + ' row ' + r.row + ' id ' + r.id + ' field ' + r.field + ' (' + r.reason + ')');
        });
        log('Rejects files: ' + paths.join(', '));

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
  runOpsBackfill(process.argv.slice(2), { log: console.log }).then(
    function (code) { process.exit(code); },
    function (err) {
      console.error('Fatal: ' + err.message);
      process.exit(EXIT.ERROR);
    }
  );
}

module.exports = {
  buildOpsBackfillPlan: buildOpsBackfillPlan,
  runOpsBackfill: runOpsBackfill,
  runOpsPromoteChecks: runOpsPromoteChecks,
  parseArgs: parseArgs,
  maskEmail: maskEmail,
  EXIT: EXIT,
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE
};

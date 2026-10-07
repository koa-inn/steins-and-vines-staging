'use strict';

/**
 * Recipes backfill - Phase 85 Plan 10 (DB-04, ROADMAP SC1).
 *
 * Dedicated two-table orchestration for the Recipes + RecipeIngredients sheets (same shape
 * as gift-cards-backfill.js, not the generic single-table backfill.js path).
 *
 * This file exports a PURE planner (buildRecipesBackfillPlan) with no I/O. It:
 *   - keeps every recipe_id and ingredient_id unchanged;
 *   - derives `position` from sheet row order within each recipe;
 *   - never collapses ingredient rows on (recipe_id, item_id) - production recipe SV-R-000002
 *     legitimately carries three rows of one item;
 *   - REJECTS (never coerces) any bad row. Reject records carry sheet, row number, id, field
 *     name and a generic reason code only - never a cell value (created_by can hold a staff
 *     email; D-13).
 *
 * Values are copied verbatim from the sheet (they were sanitised when first written) - nothing
 * is re-sanitised here.
 *
 * Recipes (Phase 85) usage - run from zoho-middleware/; the snapshot is the owner's
 * File -> Download .xlsx, kept OUTSIDE the repo:
 *   node scripts/backfill/recipes-backfill.js --file=/path/to/snapshot.xlsx --dry-run
 *   read -s BACKFILL_DATABASE_URL && export BACKFILL_DATABASE_URL     # never on argv
 *   node scripts/backfill/recipes-backfill.js --file=/path/to/snapshot.xlsx --promote
 * Flags (equals-form only): --file=PATH (required), --out-dir=PATH, --timezone=ZONE,
 * --dry-run | --promote. Exit codes: 0 ok, 1 error, 2 rejects present (blocks promote),
 * 3 in-transaction check failed (rolled back). Promote needs EMPTY recipes/recipe_ingredients,
 * prompts for the database name, runs in one transaction and seeds recipe_id_seq and
 * recipe_ingredient_id_seq from the max id suffix. Output is ids/field names/counts only.
 */

var fs = require('fs');
var readline = require('readline');

var db = require('../../lib/db');
var readXlsx = require('./read-xlsx');
var normalizeLib = require('./normalize');
var normalizeRow = normalizeLib.normalizeRow;
var rejectsLib = require('./rejects');
var backfillCli = require('./backfill');
var specs = require('./specs/recipes');

var EXIT = backfillCli.EXIT;
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;
var checkHeaders = backfillCli.checkHeaders;

var DEFAULT_TIMEZONE = 'America/Vancouver';
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;
var INSERT_BATCH_SIZE = 500;
var VALID_STATUSES = ['draft', 'active', 'inactive'];
var VALID_PRICING_MODES = ['locked', 'dynamic'];
var RECIPE_SUFFIX_RE = /^SV-R-([0-9]{6})$/;
var INGREDIENT_SUFFIX_RE = /^RI-([0-9]{6})$/;

var RECIPE_INSERT_COLUMNS = specs.recipes.columns.map(function (c) { return c.name; });
var INGREDIENT_INSERT_COLUMNS = [
  'ingredient_id', 'recipe_id', 'position', 'item_id', 'item_name', 'quantity', 'unit'
];

// ─── Small pure helpers ──────────────────────────────────────────────────

// Generic reason codes only (names, never cell values - normalize.js reasons can echo the
// offending value, so they are deliberately discarded here).
var REASON_BY_TYPE = {
  timestamptz: 'invalid_timestamp',
  numeric: 'invalid_number',
  id: 'invalid_id',
  text: 'invalid_text'
};

function columnType(spec, name) {
  for (var i = 0; i < spec.columns.length; i++) {
    if (spec.columns[i].name === name) return spec.columns[i].type;
  }
  return null;
}

// "5.500000" -> "5.5", "100.000000" -> "100". Numeric columns are unconstrained in Postgres,
// so trimming loses nothing; it just keeps stored text identical to what the sheet showed.
function trimNumeric(value) {
  if (typeof value !== 'string' || value.indexOf('.') === -1) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

function rawId(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function makeReject(sheet, row, id, field, reason) {
  return { sheet: sheet, row: row, id: id, field: field, reason: reason };
}

function normalizeSheetRow(spec, sheetName, row, timezone, idField, rejects) {
  var id = rawId(row.values[idField]);
  var result = normalizeRow(spec, row.values, { timezone: timezone });
  if (!result.ok) {
    result.reasons.forEach(function (r) {
      var reason = r.reason === 'required' ? 'required' : (REASON_BY_TYPE[columnType(spec, r.column)] || 'invalid_value');
      rejects.push(makeReject(sheetName, row.rowNumber, id, r.column, reason));
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

function maxSuffix(rows, key, re) {
  var max = 0;
  rows.forEach(function (row) {
    var m = re.exec(row[key]);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  });
  return max;
}

// ─── Plan assembly ─────────────────────────────────────────────────────────

function headerRejects(spec, sheetName, headers, rejects) {
  var check = checkHeaders(spec, headers || []);
  check.missing.forEach(function (h) {
    rejects.push(makeReject(sheetName, null, null, h, 'missing_header'));
  });
  return check.missing.length === 0;
}

/**
 * buildRecipesBackfillPlan({recipeRows, ingredientRows, recipeHeaders, ingredientHeaders, timezone})
 *
 * recipeRows/ingredientRows are read-xlsx.js readSheet() rows: [{rowNumber, values}].
 * Pure - no I/O.
 */
function buildRecipesBackfillPlan(input) {
  var timezone = input.timezone || DEFAULT_TIMEZONE;
  var recipeRows = input.recipeRows || [];
  var ingredientRows = input.ingredientRows || [];
  var rejects = [];

  var recipesHeadersOk = headerRejects(specs.recipes, specs.recipes.sheet, input.recipeHeaders, rejects);
  var ingredientHeadersOk = headerRejects(
    specs.ingredients, specs.ingredients.sheet, input.ingredientHeaders, rejects
  );

  var recipes = [];
  var recipeIdSet = {};

  if (recipesHeadersOk) {
    recipeRows.forEach(function (row) {
      var rowRejectsBefore = rejects.length;
      var values = normalizeSheetRow(specs.recipes, specs.recipes.sheet, row, timezone, 'recipe_id', rejects);
      var id = rawId(row.values.recipe_id);

      if (values) {
        if (VALID_STATUSES.indexOf(values.status) === -1) {
          rejects.push(makeReject(specs.recipes.sheet, row.rowNumber, id, 'status', 'invalid_status'));
        }
        if (VALID_PRICING_MODES.indexOf(values.pricing_mode) === -1) {
          rejects.push(makeReject(specs.recipes.sheet, row.rowNumber, id, 'pricing_mode', 'invalid_pricing_mode'));
        }
        if (recipeIdSet[values.recipe_id]) {
          rejects.push(makeReject(specs.recipes.sheet, row.rowNumber, id, 'recipe_id', 'duplicate_id'));
        }
      }

      if (!values || rejects.length > rowRejectsBefore) return;
      recipeIdSet[values.recipe_id] = true;
      recipes.push(values);
    });
  }

  var ingredients = [];
  var ingredientIdSet = {};
  var perRecipe = {};

  if (ingredientHeadersOk) {
    ingredientRows.forEach(function (row) {
      var rowRejectsBefore = rejects.length;
      var values = normalizeSheetRow(
        specs.ingredients, specs.ingredients.sheet, row, timezone, 'ingredient_id', rejects
      );
      var id = rawId(row.values.ingredient_id);

      if (values) {
        if (ingredientIdSet[values.ingredient_id]) {
          rejects.push(makeReject(specs.ingredients.sheet, row.rowNumber, id, 'ingredient_id', 'duplicate_id'));
        }
        if (!recipeIdSet[values.recipe_id]) {
          rejects.push(makeReject(specs.ingredients.sheet, row.rowNumber, id, 'recipe_id', 'orphan_recipe'));
        }
      }

      if (!values || rejects.length > rowRejectsBefore) return;

      ingredientIdSet[values.ingredient_id] = true;
      perRecipe[values.recipe_id] = (perRecipe[values.recipe_id] || 0) + 1;
      ingredients.push({
        ingredient_id: values.ingredient_id,
        recipe_id: values.recipe_id,
        position: perRecipe[values.recipe_id],
        item_id: values.item_id,
        item_name: values.item_name,
        quantity: values.quantity,
        unit: values.unit
      });
    });
  }

  return {
    recipes: recipes,
    ingredients: ingredients,
    rejects: rejects,
    counts: { recipes: recipes.length, ingredients: ingredients.length, perRecipe: perRecipe },
    recipeSeqSeed: maxSuffix(recipes, 'recipe_id', RECIPE_SUFFIX_RE),
    ingredientSeqSeed: maxSuffix(ingredients, 'ingredient_id', INGREDIENT_SUFFIX_RE)
  };
}

// ─── Promote: batched parameterised inserts, in one transaction ──────────

/**
 * Table/column names are fixed string literals owned by this module (never derived from sheet
 * data or argv); only VALUES go through $n placeholders (ASVS V5).
 */
function buildInsertSql(table, columns, batch) {
  var params = [];
  var valueGroups = batch.map(function (row) {
    var placeholders = columns.map(function (col) {
      var v = row[col];
      if (v === undefined) v = null;
      params.push(v);
      return '$' + params.length;
    });
    return '(' + placeholders.join(', ') + ')';
  });
  var sql = 'insert into ' + table + ' (' + columns.join(', ') + ') values ' + valueGroups.join(', ');
  return { sql: sql, params: params };
}

function insertBatched(client, table, columns, rows) {
  var batches = [];
  for (var i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    batches.push(rows.slice(i, i + INSERT_BATCH_SIZE));
  }
  return batches.reduce(function (chain, batch) {
    return chain.then(function () {
      var built = buildInsertSql(table, columns, batch);
      return client.query(built.sql, built.params);
    });
  }, Promise.resolve());
}

// Redundant rows = rows minus distinct items, per recipe, computed from the plan.
function planRedundantItemRows(plan, recipeId) {
  var seen = {};
  var total = 0;
  var distinct = 0;
  plan.ingredients.forEach(function (i) {
    if (i.recipe_id !== recipeId) return;
    total++;
    if (!seen[i.item_id]) {
      seen[i.item_id] = true;
      distinct++;
    }
  });
  return total - distinct;
}

function samePerRecipeCounts(rows, expected) {
  var actual = {};
  rows.forEach(function (r) { actual[r.recipe_id] = r.n; });
  var actualKeys = Object.keys(actual);
  var expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every(function (k) { return actual[k] === expected[k]; });
}

/**
 * In-transaction invariant checks, run AFTER every insert and both setval calls, BEFORE commit.
 * Names the failed check only - never row contents (D-13).
 */
function runRecipesPromoteChecks(client, plan) {
  var fail = function (name) { return { ok: false, failedCheck: name }; };

  return client.query('select count(*)::int as count from recipes').then(function (r) {
    if (r.rows[0].count !== plan.counts.recipes) return fail('recipe_count');

    return client.query('select count(*)::int as count from recipe_ingredients').then(function (r2) {
      if (r2.rows[0].count !== plan.counts.ingredients) return fail('ingredient_count');

      return client
        .query('select recipe_id, count(*)::int as n from recipe_ingredients group by recipe_id')
        .then(function (r3) {
          if (!samePerRecipeCounts(r3.rows, plan.counts.perRecipe)) return fail('per_recipe_ingredient_count');

          var hasKeyRecipe = plan.recipes.some(function (rec) { return rec.recipe_id === 'SV-R-000002'; });
          var sameItemCheck = hasKeyRecipe
            ? client
                .query(
                  'select (count(*) - count(distinct item_id))::int as redundant ' +
                    "from recipe_ingredients where recipe_id = 'SV-R-000002'"
                )
                .then(function (r4) {
                  return r4.rows[0].redundant === planRedundantItemRows(plan, 'SV-R-000002')
                    ? null
                    : fail('same_item_rows');
                })
            : Promise.resolve(null);

          return sameItemCheck.then(function (failed) {
            if (failed) return failed;

            return client.query('select last_value::bigint as v from recipe_id_seq').then(function (r5) {
              if (Number(r5.rows[0].v) < plan.recipeSeqSeed) return fail('recipe_sequence');

              return client
                .query('select last_value::bigint as v from recipe_ingredient_id_seq')
                .then(function (r6) {
                  if (Number(r6.rows[0].v) < plan.ingredientSeqSeed) return fail('ingredient_sequence');
                  return { ok: true };
                });
            });
          });
        });
    });
  });
}

function defaultPromptTypeDatabaseName(expectedName) {
  return new Promise(function (resolve, reject) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Type the database name (' + expectedName + ') to continue: ', function (answer) {
      rl.close();
      if (answer.trim() === expectedName) {
        resolve();
      } else {
        reject(new Error('database name confirmation did not match - aborting, nothing written'));
      }
    });
  });
}

/**
 * runPromote(client, plan, deps, log) -> Promise<exit code>
 *
 * DB-name prompt, then existence + emptiness preconditions OUTSIDE the transaction (so a
 * precondition failure never touches either table), then one transaction: recipes, then
 * recipe_ingredients, then both setval calls (only when the seed > 0), then the invariant
 * checks. Any failed check rolls back (CHECKS_FAILED); any other failure rolls back (ERROR).
 * The client is released exactly once.
 *
 * Note: setval is never rolled back by Postgres. After a failed promote the sequences may sit
 * at the seed values; harmless because the tables are empty and the next promote re-seeds.
 */
function runPromote(client, plan, deps, log) {
  var promptFn = (deps && deps.promptTypeDatabaseName) || defaultPromptTypeDatabaseName;
  var inTransaction = false;

  return client
    .query('select current_database() as database')
    .then(function (r) {
      var databaseName = r.rows[0].database;
      log(
        'Target: ' +
          db.redactConnectionString(process.env.BACKFILL_DATABASE_URL || '') +
          ' database=' +
          databaseName
      );
      return promptFn(databaseName);
    })
    .then(function () {
      return Promise.all([
        client.query("select to_regclass('public.recipes') as reg"),
        client.query("select to_regclass('public.recipe_ingredients') as reg")
      ]);
    })
    .then(function (reg) {
      if (!reg[0].rows[0].reg) throw new Error('target table public.recipes does not exist');
      if (!reg[1].rows[0].reg) throw new Error('target table public.recipe_ingredients does not exist');
      return Promise.all([
        client.query('select count(*)::int as count from recipes'),
        client.query('select count(*)::int as count from recipe_ingredients')
      ]);
    })
    .then(function (counts) {
      if (counts[0].rows[0].count > 0) throw new Error('target table public.recipes is not empty');
      if (counts[1].rows[0].count > 0) throw new Error('target table public.recipe_ingredients is not empty');
      return client.query('BEGIN');
    })
    .then(function () {
      inTransaction = true;
      return insertBatched(client, 'recipes', RECIPE_INSERT_COLUMNS, plan.recipes);
    })
    .then(function () {
      return insertBatched(client, 'recipe_ingredients', INGREDIENT_INSERT_COLUMNS, plan.ingredients);
    })
    .then(function () {
      if (plan.recipeSeqSeed > 0) {
        return client.query("select setval('recipe_id_seq', $1)", [plan.recipeSeqSeed]);
      }
    })
    .then(function () {
      if (plan.ingredientSeqSeed > 0) {
        return client.query("select setval('recipe_ingredient_id_seq', $1)", [plan.ingredientSeqSeed]);
      }
    })
    .then(function () {
      return runRecipesPromoteChecks(client, plan);
    })
    .then(function (checkResult) {
      if (!checkResult.ok) {
        log('Checks: FAIL - ' + checkResult.failedCheck);
        return client.query('ROLLBACK').then(function () {
          client.release();
          return EXIT.CHECKS_FAILED;
        });
      }
      return client.query('COMMIT').then(function () {
        log(
          'Promoted ' + plan.counts.recipes + ' recipes, ' + plan.counts.ingredients +
            ' ingredients; sequences at ' + plan.recipeSeqSeed + ' / ' + plan.ingredientSeqSeed
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
 * parseArgs(argv) -> { file, outDir, timezone, dryRun, promote }
 * Equals-form flags only. A Postgres URL anywhere in argv is refused (credentials belong in
 * BACKFILL_DATABASE_URL, never shell history). No --accept-rejects: any reject blocks (D-13).
 */
function parseArgs(argv) {
  var opts = {
    file: undefined,
    outDir: rejectsLib.DEFAULT_OUT_DIR,
    timezone: DEFAULT_TIMEZONE,
    dryRun: false,
    promote: false
  };

  argv.forEach(function (arg) {
    if (POSTGRES_URL_RE.test(arg)) {
      throw new Error(
        'pass the database via BACKFILL_DATABASE_URL, never on the command line (got "' + arg + '")'
      );
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
 * runRecipesBackfill(argv, deps) -> Promise<exit code>
 *
 * deps: { pool, log, promptTypeDatabaseName, planHook }. When deps.pool is absent and a promote
 * is requested, a pool is created from BACKFILL_DATABASE_URL (the only accepted source) and
 * ended afterwards. deps.planHook(plan) is a TEST-ONLY seam applied to the plan just before
 * promote (used to tamper counts and prove the in-transaction checks roll back).
 * Output is counts, paths and check names only (D-13).
 */
function runRecipesBackfill(argv, deps) {
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

  log('[1/5] Read snapshot');
  return Promise.all([
    readXlsx.readSheet(opts.file, specs.recipes.sheet),
    readXlsx.readSheet(opts.file, specs.ingredients.sheet)
  ])
    .then(function (sheets) {
      var recipeSheet = sheets[0];
      var ingredientSheet = sheets[1];

      log('[2/5] Build plan');
      var plan = buildRecipesBackfillPlan({
        recipeRows: recipeSheet.rows,
        ingredientRows: ingredientSheet.rows,
        recipeHeaders: recipeSheet.headers,
        ingredientHeaders: ingredientSheet.headers,
        timezone: timezone
      });

      log('[3/5] Rejects report');
      var recipeRejects = plan.rejects.filter(function (r) { return r.sheet === specs.recipes.sheet; });
      var ingredientRejects = plan.rejects.filter(function (r) { return r.sheet === specs.ingredients.sheet; });

      return Promise.all([
        rejectsLib.writeRejectsReport({
          sheet: specs.recipes.sheet, sourceFile: opts.file, rejects: recipeRejects, outDir: opts.outDir
        }),
        rejectsLib.writeRejectsReport({
          sheet: specs.ingredients.sheet, sourceFile: opts.file, rejects: ingredientRejects, outDir: opts.outDir
        })
      ]).then(function (paths) {
        log(
          'Read: ' + recipeSheet.rows.length + ' recipe rows, ' + ingredientSheet.rows.length + ' ingredient rows'
        );
        log('Plan: ' + plan.counts.recipes + ' recipes, ' + plan.counts.ingredients + ' ingredients');
        log('Seq seeds: recipe ' + plan.recipeSeqSeed + ', ingredient ' + plan.ingredientSeqSeed);
        log(plan.rejects.length + ' rejects');
        plan.rejects.forEach(function (r) {
          log('  reject: ' + r.sheet + ' row ' + r.row + ' id ' + r.id + ' field ' + r.field + ' (' + r.reason + ')');
        });
        log('Rejects files: ' + paths[0] + ', ' + paths[1]);

        if (plan.rejects.length > 0) {
          log('[4/5] Rejects present - promotion blocked (D-13). Resolve in the sheet and re-run.');
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
          .then(function (client) {
            return runPromote(client, plan, deps, log);
          })
          .then(
            function (code) {
              return ownPool ? pool.end().then(function () { return code; }) : code;
            },
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
  runRecipesBackfill(process.argv.slice(2), { log: console.log }).then(
    function (code) { process.exit(code); },
    function (err) {
      console.error('Fatal: ' + err.message);
      process.exit(EXIT.ERROR);
    }
  );
}

module.exports = {
  buildRecipesBackfillPlan: buildRecipesBackfillPlan,
  runRecipesBackfill: runRecipesBackfill,
  runRecipesPromoteChecks: runRecipesPromoteChecks,
  parseArgs: parseArgs,
  EXIT: EXIT,
  RECIPE_INSERT_COLUMNS: RECIPE_INSERT_COLUMNS,
  INGREDIENT_INSERT_COLUMNS: INGREDIENT_INSERT_COLUMNS,
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE
};

'use strict';

/**
 * Recipes verify - Phase 85 Plan 11 (DB-04, D-01 agreement proof / D-02 catch-all).
 *
 * A read-only owner-run comparison between Postgres (recipes + recipe_ingredients) and a FRESH
 * .xlsx download of the live Recipes / RecipeIngredients sheets. Run before every store-mode
 * flip, after the dual-window pre-open mirror write, and after any replay.
 *
 * Never mutates anything: one `begin transaction read only`, reads via recipe-pg
 * (listRecipeIds + getRecipe, the same serialiser the app uses), then commit. The sheet side
 * reuses buildRecipesBackfillPlan so verify and the backfill can never drift on normalisation.
 *
 * Output is ids, field names and counts only - never a cell value (created_by can hold a
 * staff email). The database comes ONLY from BACKFILL_DATABASE_URL, never argv.
 *
 *   node scripts/backfill/recipes-verify.js --file=/path/to/fresh.xlsx
 * Exit codes: 0 ok, 1 error, 3 mismatches found.
 */

var fs = require('fs');

var readXlsx = require('./read-xlsx');
var backfillCli = require('./backfill');
var recipesBackfill = require('./recipes-backfill');
var recipePg = require('../../lib/recipe-pg');

var EXIT = backfillCli.EXIT;
var assertSnapshotSafePath = backfillCli.assertSnapshotSafePath;

var DEFAULT_TIMEZONE = recipesBackfill.DEFAULT_TIMEZONE;
var POSTGRES_URL_RE = /postgres(ql)?:\/\//;

var RECIPE_FIELDS = [
  'recipe_id', 'name', 'style', 'description', 'status', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at', 'created_by',
  'updated_at', 'pricing_mode', 'schedule_id'
];
var NUMERIC_FIELDS = {
  locked_price: true, service_fee: true, materials_fee: true, batch_size_l: true,
  abv: true, ibu: true, colour_srm: true
};
var TIMESTAMP_FIELDS = { created_at: true, updated_at: true };
var INGREDIENT_FIELDS = ['item_id', 'quantity', 'unit'];

// ─── Pure comparison ────────────────────────────────────────────────────────

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

function sameValue(field, a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  if (TIMESTAMP_FIELDS[field]) {
    var ta = new Date(a).getTime();
    var tb = new Date(b).getTime();
    return ta === tb;
  }
  if (NUMERIC_FIELDS[field] || field === 'quantity') return Number(a) === Number(b);
  return String(a) === String(b);
}

function groupIngredients(list) {
  var byRecipe = {};
  (list || []).forEach(function (ing) {
    (byRecipe[ing.recipe_id] = byRecipe[ing.recipe_id] || []).push(ing);
  });
  return byRecipe;
}

function compareIngredients(recipeId, pgList, sheetList, out) {
  if (pgList.length !== sheetList.length) {
    out.push({ id: recipeId, field: 'ingredient_count' });
    return;
  }
  var sheetById = {};
  sheetList.forEach(function (i) { sheetById[i.ingredient_id] = i; });
  var pgById = {};
  pgList.forEach(function (i) { pgById[i.ingredient_id] = i; });

  var idsDiffer = false;
  pgList.forEach(function (i) {
    if (!sheetById[i.ingredient_id]) {
      out.push({ id: i.ingredient_id, field: 'missing_in_sheet' });
      idsDiffer = true;
    }
  });
  sheetList.forEach(function (i) {
    if (!pgById[i.ingredient_id]) {
      out.push({ id: i.ingredient_id, field: 'missing_in_postgres' });
      idsDiffer = true;
    }
  });
  if (idsDiffer) return;

  var orderDiffers = pgList.some(function (i, idx) { return i.ingredient_id !== sheetList[idx].ingredient_id; });
  if (orderDiffers) out.push({ id: recipeId, field: 'ingredient_order' });

  pgList.forEach(function (pgIng) {
    var sheetIng = sheetById[pgIng.ingredient_id];
    INGREDIENT_FIELDS.forEach(function (field) {
      if (!sameValue(field, pgIng[field], sheetIng[field])) {
        out.push({ id: pgIng.ingredient_id, field: field });
      }
    });
  });
}

/**
 * compareRecipes({pgRecipes, sheetPlan}) -> [{id, field}]
 *
 * pgRecipes: [{recipe, ingredients}] as recipePg.getRecipe returns. sheetPlan: the output of
 * buildRecipesBackfillPlan. Reports ids and field names only.
 */
function compareRecipes(input) {
  var pgRecipes = input.pgRecipes || [];
  var sheetPlan = input.sheetPlan || { recipes: [], ingredients: [] };
  var out = [];

  var sheetById = {};
  sheetPlan.recipes.forEach(function (r) { sheetById[r.recipe_id] = r; });
  var sheetIngByRecipe = groupIngredients(sheetPlan.ingredients);
  var seen = {};

  pgRecipes.forEach(function (pg) {
    var id = pg.recipe.recipe_id;
    seen[id] = true;
    var sheetRecipe = sheetById[id];
    if (!sheetRecipe) {
      out.push({ id: id, field: 'missing_in_sheet' });
      return;
    }
    RECIPE_FIELDS.forEach(function (field) {
      if (!sameValue(field, pg.recipe[field], sheetRecipe[field])) out.push({ id: id, field: field });
    });
    compareIngredients(id, pg.ingredients || [], sheetIngByRecipe[id] || [], out);
  });

  sheetPlan.recipes.forEach(function (r) {
    if (!seen[r.recipe_id]) out.push({ id: r.recipe_id, field: 'missing_in_postgres' });
  });

  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

var VALID_FLAGS = ['--file', '--timezone'];
var VALUE_FLAGS = { '--file': 'file', '--timezone': 'timezone' };

function parseArgs(argv) {
  var opts = { file: undefined, timezone: DEFAULT_TIMEZONE };
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
    opts[VALUE_FLAGS[flag]] = value;
  });
  return opts;
}

async function fetchPgRecipes(pool) {
  var client = await pool.connect();
  try {
    await client.query('begin transaction read only');
    var ids = await recipePg.listRecipeIds(client);
    var states = [];
    for (var i = 0; i < ids.length; i++) {
      var state = await recipePg.getRecipe(client, ids[i]);
      if (state) states.push(state);
    }
    await client.query('commit');
    return states;
  } catch (err) {
    await client.query('rollback').catch(function () {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * runVerify(opts, deps) -> Promise<{exitCode, result}>. deps: {pool, log}.
 */
async function runVerify(opts, deps) {
  deps = deps || {};
  var log = deps.log || console.log;

  try {
    assertSnapshotSafePath(opts.file);
    if (!opts.file || !fs.existsSync(opts.file)) throw new Error('snapshot not found');

    var sheets = await Promise.all([
      readXlsx.readSheet(opts.file, 'Recipes'),
      readXlsx.readSheet(opts.file, 'RecipeIngredients')
    ]);
    var plan = recipesBackfill.buildRecipesBackfillPlan({
      recipeRows: sheets[0].rows,
      ingredientRows: sheets[1].rows,
      recipeHeaders: sheets[0].headers,
      ingredientHeaders: sheets[1].headers,
      timezone: opts.timezone || DEFAULT_TIMEZONE
    });
    if (plan.rejects.length > 0) {
      log('Warning: ' + plan.rejects.length + ' sheet row(s) failed normalisation and were excluded ' +
        'from this comparison - resolve in the sheet and re-run for a complete verify');
    }

    var pgRecipes = await fetchPgRecipes(deps.pool);
    var mismatches = compareRecipes({ pgRecipes: pgRecipes, sheetPlan: plan });
    var result = { ok: mismatches.length === 0, compared: pgRecipes.length, mismatches: mismatches };

    if (result.ok) {
      log('Verified ' + result.compared + ' recipes: 0 mismatches');
      return { exitCode: EXIT.OK, result: result };
    }
    mismatches.forEach(function (m) { log('MISMATCH id=' + m.id + ' field=' + m.field); });
    log('Verified ' + result.compared + ' recipes: ' + mismatches.length + ' mismatch(es)');
    return { exitCode: EXIT.CHECKS_FAILED, result: result };
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
  runVerify(opts, { pool: pool, log: console.log })
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
  compareRecipes: compareRecipes,
  runVerify: runVerify,
  parseArgs: parseArgs,
  EXIT: EXIT
};

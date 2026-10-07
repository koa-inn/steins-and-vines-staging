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
 */

var normalizeLib = require('./normalize');
var normalizeRow = normalizeLib.normalizeRow;
var backfillCli = require('./backfill');
var specs = require('./specs/recipes');

var checkHeaders = backfillCli.checkHeaders;

var DEFAULT_TIMEZONE = 'America/Vancouver';
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

module.exports = {
  buildRecipesBackfillPlan: buildRecipesBackfillPlan,
  RECIPE_INSERT_COLUMNS: RECIPE_INSERT_COLUMNS,
  INGREDIENT_INSERT_COLUMNS: INGREDIENT_INSERT_COLUMNS,
  DEFAULT_TIMEZONE: DEFAULT_TIMEZONE
};

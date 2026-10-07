'use strict';

/**
 * Atomic Postgres recipe operations — Phase 85 Plan 02 (DB-04, ROADMAP SC1/SC2).
 *
 * This module never requires 'pg' and never creates a pool — every function receives the
 * transaction `client` from the caller (lib/db.js's withTransaction()). It is the pure atomic
 * layer; the facade composes it.
 *
 * All SQL uses $n placeholders only (ASVS V5) — never string-built queries. SQL text is held in
 * module-level constants. Business rejections resolve `{ok:false, error, message}`; infrastructure
 * errors are NOT caught so they reject and db.withTransaction rolls the whole transaction back.
 * Underscore-prefixed result keys (e.g. `_recipeId`) are for the facade and are stripped there.
 *
 * Response shapes are byte-identical (JSON.stringify) to Apps Script get_recipes / get_recipe:
 * 18 recipe keys in sheet column order, '' for empty cells, JS numbers (pg returns numeric as
 * strings — Pitfall 1), ISO-ms timestamp strings (pg returns Date objects), ingredients in
 * position (sheet-row) order with no position key.
 */

var recipeRules = require('./recipe-rules');

// Sheet column order = JSON key order.
var RECIPE_COLUMNS = [
  'recipe_id', 'name', 'style', 'description', 'status', 'locked_price', 'service_fee',
  'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm', 'notes', 'created_at', 'created_by',
  'updated_at', 'pricing_mode', 'schedule_id'
];
var INGREDIENT_COLUMNS = ['ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'];

var NUMERIC_RECIPE_COLUMNS = {
  locked_price: true, service_fee: true, materials_fee: true, batch_size_l: true,
  abv: true, ibu: true, colour_srm: true
};
var TIMESTAMP_RECIPE_COLUMNS = { created_at: true, updated_at: true };

var ALLOWED_STATUSES = ['draft', 'active', 'inactive'];

// ─── SQL (module-level constants only — never string-built) ────────────────

var RECIPE_SELECT = 'select ' + RECIPE_COLUMNS.join(', ') + ' from recipes ';

var LIST_SQL =
  'select ' + RECIPE_COLUMNS.join(', ') + ', ' +
  '(select count(*)::int from recipe_ingredients i where i.recipe_id = recipes.recipe_id) as ingredient_count ' +
  'from recipes ' +
  'where ($1::text is null or lower(status) = lower($1::text)) ' +
  'order by created_at desc, recipe_id asc ' +
  'limit $2::bigint offset $3::bigint';

var COUNT_ALL_SQL = 'select count(*)::int as n from recipes';

var COUNT_FILTERED_SQL =
  'select count(*)::int as n from recipes where ($1::text is null or lower(status) = lower($1::text))';

var GET_RECIPE_SQL = RECIPE_SELECT + 'where recipe_id = $1';

var GET_INGREDIENTS_SQL =
  'select ' + INGREDIENT_COLUMNS.join(', ') + ' from recipe_ingredients ' +
  'where recipe_id = $1 order by position asc';

var LIST_IDS_SQL = 'select recipe_id from recipes order by recipe_id';

var INSERT_RECIPE_SQL =
  'insert into recipes (name, style, description, status, locked_price, service_fee, materials_fee, ' +
  'batch_size_l, abv, ibu, colour_srm, notes, created_at, created_by, updated_at, pricing_mode, schedule_id) ' +
  'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $13, $15, $16) returning recipe_id';

var INSERT_INGREDIENT_SQL =
  'insert into recipe_ingredients (recipe_id, position, item_id, item_name, quantity, unit) ' +
  'values ($1, $2, $3, $4, $5, $6)';

var LOCK_RECIPE_SQL = RECIPE_SELECT + 'where recipe_id = $1 for update';

var STORED_INGREDIENTS_SQL =
  'select ingredient_id, item_id, quantity, unit from recipe_ingredients ' +
  'where recipe_id = $1 order by position asc';

var DELETE_INGREDIENTS_SQL = 'delete from recipe_ingredients where recipe_id = $1';

var INSERT_INGREDIENT_WITH_ID_SQL =
  'insert into recipe_ingredients (ingredient_id, recipe_id, position, item_id, item_name, quantity, unit) ' +
  'values ($1, $2, $3, $4, $5, $6, $7)';

var DEACTIVATE_RECIPE_SQL = "update recipes set status = 'inactive', updated_at = $2 where recipe_id = $1";

var DELETE_RECIPE_SQL = 'delete from recipes where recipe_id = $1';

// Fixed column allow-lists for the dynamic SET clause (never built from payload keys).
var UPDATE_STRING_FIELDS = ['name', 'style', 'description', 'status', 'notes', 'schedule_id'];
var UPDATE_NUMERIC_FIELDS = ['locked_price', 'service_fee', 'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm'];

var STALE_MESSAGE = 'This recipe was changed since you opened it \u2014 reload to see the latest';

// ─── Serializers ───────────────────────────────────────────────────────────

function textOut(value) {
  return value === null || value === undefined ? '' : value;
}

function rowToRecipe(row) {
  var out = {};
  for (var i = 0; i < RECIPE_COLUMNS.length; i++) {
    var col = RECIPE_COLUMNS[i];
    var v = row[col];
    if (v === null || v === undefined) {
      out[col] = '';
    } else if (NUMERIC_RECIPE_COLUMNS[col]) {
      out[col] = Number(v);
    } else if (TIMESTAMP_RECIPE_COLUMNS[col]) {
      out[col] = v instanceof Date ? v.toISOString() : String(v);
    } else {
      out[col] = v;
    }
  }
  return out;
}

function rowToIngredient(row) {
  var out = {};
  for (var i = 0; i < INGREDIENT_COLUMNS.length; i++) {
    var col = INGREDIENT_COLUMNS[i];
    out[col] = col === 'quantity' ? Number(row[col]) : textOut(row[col]);
  }
  return out;
}

// ─── Reads ─────────────────────────────────────────────────────────────────

function statusParam(status) {
  if (status === undefined || status === null || status === '' || status === 'all') return null;
  return String(status);
}

async function listRecipes(client, opts) {
  opts = opts || {};
  var status = statusParam(opts.status);
  var limit = Number(opts.limit) > 0 ? Math.floor(Number(opts.limit)) : 0;
  var offset = Number(opts.offset) > 0 ? Math.floor(Number(opts.offset)) : 0;

  // limit 0 means "no limit" (offset-only window): LIMIT NULL is unbounded in Postgres.
  var page = await client.query(LIST_SQL, [status, limit > 0 ? limit : null, offset]);
  var totalRes = await client.query(COUNT_ALL_SQL);
  var filteredRes = await client.query(COUNT_FILTERED_SQL, [status]);

  var recipes = page.rows.map(function (row) {
    var r = rowToRecipe(row);
    r.ingredient_count = Number(row.ingredient_count);
    return r;
  });
  return { recipes: recipes, total: totalRes.rows[0].n, filtered: filteredRes.rows[0].n };
}

async function getRecipe(client, recipeId) {
  var res = await client.query(GET_RECIPE_SQL, [recipeId]);
  if (res.rows.length === 0) return null;
  var ing = await client.query(GET_INGREDIENTS_SQL, [recipeId]);
  return { recipe: rowToRecipe(res.rows[0]), ingredients: ing.rows.map(rowToIngredient) };
}

async function listRecipeIds(client) {
  var res = await client.query(LIST_IDS_SQL);
  return res.rows.map(function (r) { return r.recipe_id; });
}

// ─── Create ────────────────────────────────────────────────────────────────

function emptyToNull(value) {
  return value === '' || value === undefined || value === null ? null : value;
}

/** Apps Script: `payload.x !== undefined ? Number(payload.x) : fallback`. NaN is rejected upstream. */
function numOrFallback(value, fallback) {
  return value !== undefined ? Number(value) : fallback;
}

function invalid(message) {
  return { ok: false, error: 'invalid_data', message: message };
}

async function createRecipe(client, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var actor = opts.actor || 'middleware';
  var now = opts.now || new Date();

  if (!payload.name) {
    return { ok: false, error: 'missing_fields', message: 'name is required' };
  }

  var ingredients;
  if (payload.ingredients !== undefined) {
    try {
      ingredients = typeof payload.ingredients === 'string' ? JSON.parse(payload.ingredients) : payload.ingredients;
    } catch {
      return invalid('Invalid ingredients JSON');
    }
  }
  if (ingredients !== undefined && ingredients !== null && !Array.isArray(ingredients)) {
    return invalid('ingredients must be an array');
  }
  ingredients = ingredients || [];

  var status = payload.status || 'draft';
  if (ALLOWED_STATUSES.indexOf(status) === -1) {
    return invalid('status must be draft, active or inactive');
  }

  var serviceFee = numOrFallback(payload.service_fee, 45);
  var materialsFee = numOrFallback(payload.materials_fee, 5);
  var lockedPrice = numOrFallback(payload.locked_price, null);
  var batchSize = numOrFallback(payload.batch_size_l, null);
  var abv = numOrFallback(payload.abv, null);
  var ibu = numOrFallback(payload.ibu, null);
  var colour = numOrFallback(payload.colour_srm, null);
  var nums = [serviceFee, materialsFee, lockedPrice, batchSize, abv, ibu, colour];
  for (var n = 0; n < nums.length; n++) {
    if (nums[n] !== null && !isFinite(nums[n])) return invalid('Numeric field is not a finite number');
  }

  var prepared = [];
  for (var i = 0; i < ingredients.length; i++) {
    var ing = ingredients[i] || {};
    var qty = ing.quantity !== undefined ? Number(ing.quantity) : 0;
    if (!isFinite(qty)) return invalid('Ingredient ' + (i + 1) + ': quantity is not a finite number');
    prepared.push({
      item_id: recipeRules.sanitizeInput(ing.item_id || ''),
      item_name: emptyToNull(recipeRules.sanitizeInput(ing.item_name || '')),
      quantity: qty,
      unit: emptyToNull(recipeRules.sanitizeInput(ing.unit || ''))
    });
  }

  var ins = await client.query(INSERT_RECIPE_SQL, [
    recipeRules.sanitizeInput(payload.name),
    emptyToNull(recipeRules.sanitizeInput(payload.style || '')),
    emptyToNull(recipeRules.sanitizeInput(payload.description || '')),
    status,
    lockedPrice,
    serviceFee,
    materialsFee,
    batchSize,
    abv,
    ibu,
    colour,
    emptyToNull(recipeRules.sanitizeInput(payload.notes || '')),
    now,
    actor,
    recipeRules.normalizePricingMode(payload.pricing_mode),
    emptyToNull(recipeRules.sanitizeInput(payload.schedule_id || ''))
  ]);
  var recipeId = ins.rows[0].recipe_id;

  for (var k = 0; k < prepared.length; k++) {
    var p = prepared[k];
    await client.query(INSERT_INGREDIENT_SQL, [recipeId, k + 1, p.item_id, p.item_name, p.quantity, p.unit]);
  }

  return { ok: true, recipe_id: recipeId, ingredients_created: prepared.length, _recipeId: recipeId };
}

// ─── Update / delete ───────────────────────────────────────────────────────

/** D-03: stale when the token is missing/unparseable or differs (epoch-ms) from the locked row. */
function isStale(expected, row) {
  if (expected === undefined || expected === null || expected === '') return true;
  var t = new Date(expected).getTime();
  if (isNaN(t)) return true;
  var stored = row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime();
  return t !== stored;
}

function staleResult() {
  return { ok: false, error: 'stale_recipe', message: STALE_MESSAGE };
}

async function updateRecipe(client, payload, opts) {
  payload = payload || {};
  opts = opts || {};
  var now = opts.now || new Date();
  var recipeId = payload.recipe_id;
  if (!recipeId) return { ok: false, error: 'missing_id', message: 'recipe_id is required' };

  // Validate everything before the lock or any write (Sheets wrote row fields first; improvement).
  var incomingRaw;
  if (payload.ingredients !== undefined) {
    try {
      incomingRaw = typeof payload.ingredients === 'string' ? JSON.parse(payload.ingredients) : payload.ingredients;
    } catch {
      return invalid('Invalid ingredients JSON');
    }
    if (!Array.isArray(incomingRaw)) return invalid('ingredients must be an array');
  }

  var sets = [];
  var params = [recipeId];
  var i;
  function addSet(col, value) {
    params.push(value);
    sets.push(col + ' = $' + params.length);
  }

  for (i = 0; i < UPDATE_STRING_FIELDS.length; i++) {
    var sf = UPDATE_STRING_FIELDS[i];
    if (payload[sf] === undefined) continue;
    var sv = recipeRules.sanitizeInput(payload[sf]);
    if (sf === 'status') {
      if (ALLOWED_STATUSES.indexOf(sv) === -1) return invalid('status must be draft, active or inactive');
      addSet(sf, sv);
    } else if (sf === 'name') {
      addSet(sf, sv);
    } else {
      addSet(sf, emptyToNull(sv));
    }
  }
  for (i = 0; i < UPDATE_NUMERIC_FIELDS.length; i++) {
    var nf = UPDATE_NUMERIC_FIELDS[i];
    if (payload[nf] === undefined) continue;
    var nv = Number(payload[nf]);
    if (!isFinite(nv)) return invalid('Numeric field is not a finite number');
    addSet(nf, nv);
  }
  if (payload.pricing_mode !== undefined) addSet('pricing_mode', recipeRules.normalizePricingMode(payload.pricing_mode));

  var incoming;
  if (incomingRaw !== undefined) {
    incoming = [];
    for (i = 0; i < incomingRaw.length; i++) {
      var ing = incomingRaw[i] || {};
      var qty = ing.quantity !== undefined ? Number(ing.quantity) : 0;
      if (!isFinite(qty)) return invalid('Ingredient ' + (i + 1) + ': quantity is not a finite number');
      incoming.push({
        ingredient_id: String(ing.ingredient_id || '').trim(),
        item_id: recipeRules.sanitizeInput(ing.item_id || ''),
        item_name: emptyToNull(recipeRules.sanitizeInput(ing.item_name || '')),
        quantity: qty,
        unit: emptyToNull(recipeRules.sanitizeInput(ing.unit || ''))
      });
    }
  }

  var locked = await client.query(LOCK_RECIPE_SQL, [recipeId]);
  if (locked.rows.length === 0) return { ok: false, error: 'not_found', message: 'Recipe not found: ' + recipeId };
  if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  addSet('updated_at', now);
  await client.query('update recipes set ' + sets.join(', ') + ' where recipe_id = $1', params);

  var rewritten = false;
  if (incoming !== undefined) {
    var stored = await client.query(STORED_INGREDIENTS_SQL, [recipeId]);
    var storedTuples = stored.rows.map(function (r) {
      return recipeRules.normalizeRecipeIngredientTuple(r.item_id, Number(r.quantity), r.unit);
    });
    var incomingTuples = incoming.map(function (r) {
      return recipeRules.normalizeRecipeIngredientTuple(r.item_id, r.quantity, r.unit);
    });
    if (!recipeRules.recipeIngredientsUnchanged(incomingTuples, storedTuples)) {
      var plan = recipeRules.planIngredientIds(incoming, stored.rows.map(function (r) { return r.ingredient_id; }));
      await client.query(DELETE_INGREDIENTS_SQL, [recipeId]);
      for (var k = 0; k < plan.length; k++) {
        var p = plan[k];
        if (p.ingredient_id) {
          await client.query(INSERT_INGREDIENT_WITH_ID_SQL,
            [p.ingredient_id, recipeId, p.position, p.item_id, p.item_name, p.quantity, p.unit]);
        } else {
          await client.query(INSERT_INGREDIENT_SQL,
            [recipeId, p.position, p.item_id, p.item_name, p.quantity, p.unit]);
        }
      }
      rewritten = true;
    }
  }

  return { ok: true, _recipeId: recipeId, _ingredientsRewritten: rewritten };
}

async function deleteRecipe(client, recipeId, opts) {
  opts = opts || {};
  if (!recipeId) return { ok: false, error: 'missing_id', message: 'recipe_id is required' };
  var refs = opts.batchRefCount;
  if (typeof refs !== 'number' || !isFinite(refs) || refs < 0 || Math.floor(refs) !== refs) {
    throw new Error('batchRefCount required');
  }
  var now = opts.now || new Date();

  var locked = await client.query(LOCK_RECIPE_SQL, [recipeId]);
  if (locked.rows.length === 0) return { ok: false, error: 'not_found', message: 'Recipe not found: ' + recipeId };
  if (isStale(opts.expectedUpdatedAt, locked.rows[0])) return staleResult();

  if (refs > 0) {
    await client.query(DEACTIVATE_RECIPE_SQL, [recipeId, now]);
    return { ok: true, deactivated: true, message: 'Recipe deactivated (has batch references)', _recipeId: recipeId };
  }
  await client.query(DELETE_RECIPE_SQL, [recipeId]);
  return { ok: true, deleted: true, message: 'Recipe deleted', _recipeId: recipeId };
}

module.exports = {
  RECIPE_COLUMNS: RECIPE_COLUMNS,
  INGREDIENT_COLUMNS: INGREDIENT_COLUMNS,
  rowToRecipe: rowToRecipe,
  rowToIngredient: rowToIngredient,
  listRecipes: listRecipes,
  getRecipe: getRecipe,
  listRecipeIds: listRecipeIds,
  createRecipe: createRecipe,
  updateRecipe: updateRecipe,
  deleteRecipe: deleteRecipe
};

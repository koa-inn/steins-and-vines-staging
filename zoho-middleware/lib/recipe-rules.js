'use strict';

/**
 * Recipe rules — ES5 ports of the Apps Script recipe logic in apps-script/adminApi.gs.
 * Phase 85 Plan 01 (DB-04, ROADMAP SC3; Phase 79 D-04 / D-09).
 *
 * Behavioural identity with adminApi.gs is the requirement, not improvement. Every function
 * below is a line-for-line port (same regexes, same order of operations, same handling of
 * non-strings). Parity is proven by __tests__/recipe-rules-parity.test.js (function level,
 * against the real .gs source) and __tests__/recipe-d09-runtime-parity.test.js (the real
 * updateRecipe run under a fake Sheets runtime).
 *
 * Pure module: no requires, no I/O.
 */

/** Port of sanitizeInput (adminApi.gs). */
function sanitizeInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return String(input);

  var sanitized = input;

  // Remove script tags and their contents (case-insensitive, handles attributes)
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove individual script tags that might be unclosed
  sanitized = sanitized.replace(/<\/?script[^>]*>/gi, '');

  // Remove event handlers (onclick, onerror, onload, etc.)
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*[^\s>]+/gi, '');

  // Remove javascript: and data: URLs
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, '');

  // Remove iframe, object, embed tags
  sanitized = sanitized.replace(/<\/?iframe[^>]*>/gi, '');
  sanitized = sanitized.replace(/<\/?object[^>]*>/gi, '');
  sanitized = sanitized.replace(/<\/?embed[^>]*>/gi, '');

  // Remove style tags
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  sanitized = sanitized.replace(/<\/?style[^>]*>/gi, '');

  return sanitized;
}

/** Port of normalizePricingMode (adminApi.gs). */
function normalizePricingMode(value) {
  return value === 'dynamic' ? 'dynamic' : 'locked';
}

// D-02/D-03 (Phase 89): app-level enum, no DB CHECK; keep in sync with apps-script/adminApi.gs,
// js/lib/constants.js BEER_CATEGORIES and css/styles.css .tint-* (drift test:
// tests/frontend/beer-category-key-drift.test.js)
var BEER_CATEGORY_KEYS = [
  'pilsner', 'lager', 'pale', 'ipa', 'amber', 'wheat',
  'session', 'saison', 'stout', 'porter', 'redale', 'brown'
];

/**
 * Normalise a beer category (D-03/D-04/D-05).
 * Returns the canonical key, '' (valid blank) or null (invalid, caller rejects).
 * Orchestrator resolution 2 / research A1: non-strings and non-blank input that strips to
 * nothing are rejected, not blanked.
 */
function normalizeBeerCategory(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return '';
  var key = value.toLowerCase().replace(/[^a-z]/g, '');
  return BEER_CATEGORY_KEYS.indexOf(key) === -1 ? null : key;
}

var TARGET_GRAVITY_MESSAGE = 'Target OG and Target FG must be between 2 and 40 °P, and Target FG must be below Target OG';

/**
 * Normalise a target gravity in degrees Plato (Phase 97 D-06).
 * Returns '' (valid blank), a finite number within 2..40, or null (invalid, caller rejects).
 */
function normalizeTargetGravity(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.trim() === '') return '';
  } else if (typeof value !== 'number') {
    return null;
  }
  var n = Number(value);
  if (!isFinite(n) || n < 2 || n > 40) return null;
  return n;
}

/** True unless both values are numbers and fg >= og. */
function checkTargetGravityPair(og, fg) {
  if (typeof og === 'number' && typeof fg === 'number') return fg < og;
  return true;
}

/** Port of normalizeRecipeIngredientTuple (adminApi.gs) — Phase 79 D-04 comparison key. */
function normalizeRecipeIngredientTuple(itemId, quantity, unit) {
  var itemKey = String(itemId === null || itemId === undefined ? '' : itemId).trim();
  var unitKey = String(unit === null || unit === undefined ? '' : unit).trim();

  var rawQty = (quantity === undefined || quantity === null || quantity === '') ? 0 : quantity;
  var n = Number(rawQty);
  var qtyKey;
  if (!isFinite(n)) {
    qtyKey = '!nonfinite';
  } else {
    qtyKey = String(Math.round(n * 1e9) / 1e9);
  }

  return itemKey + ' ' + qtyKey + ' ' + unitKey;
}

/** Port of recipeIngredientsUnchanged (adminApi.gs) — order- and length-sensitive compare. */
function recipeIngredientsUnchanged(incomingTuples, storedTuples) {
  var a = incomingTuples || [];
  var b = storedTuples || [];

  if (a.length !== b.length) return false;

  for (var i = 0; i < a.length; i++) {
    if (a[i].indexOf('!nonfinite') !== -1 || b[i].indexOf('!nonfinite') !== -1) return false;
  }

  for (var j = 0; j < a.length; j++) {
    if (a[j] !== b[j]) return false;
  }

  return true;
}

/**
 * Phase 79 D-09 ingredient-id planner (extracted from the inline block in updateRecipe).
 *
 * Honour an incoming ingredient_id ONLY if it already belongs to THIS recipe's stored rows and
 * has not already been claimed by an earlier row in the same payload; otherwise return null,
 * meaning "mint from recipe_ingredient_id_seq" (the column default).
 *
 * @param {Array<{ingredient_id, item_id, item_name, quantity, unit}>} incoming - already sanitised
 * @param {Array<string>} storedIds - this recipe's stored ingredient_id strings
 * @returns {Array<{ingredient_id: (string|null), position: number, item_id, item_name, quantity, unit}>}
 */
function planIngredientIds(incoming, storedIds) {
  var list = incoming || [];
  var storedIdSet = {};
  var s = storedIds || [];
  for (var si = 0; si < s.length; si++) {
    var storedId = String(s[si] === null || s[si] === undefined ? '' : s[si]).trim();
    if (storedId) storedIdSet[storedId] = true;
  }

  var claimedIds = {};
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var incomingId = String(item.ingredient_id || '').trim();
    var finalId = null;
    if (incomingId && storedIdSet[incomingId] && !claimedIds[incomingId]) {
      finalId = incomingId;
      claimedIds[incomingId] = true;
    }
    out.push({
      ingredient_id: finalId,
      position: i + 1,
      item_id: item.item_id,
      item_name: item.item_name,
      quantity: item.quantity,
      unit: item.unit
    });
  }
  return out;
}

module.exports = {
  sanitizeInput: sanitizeInput,
  normalizePricingMode: normalizePricingMode,
  BEER_CATEGORY_KEYS: BEER_CATEGORY_KEYS,
  normalizeBeerCategory: normalizeBeerCategory,
  TARGET_GRAVITY_MESSAGE: TARGET_GRAVITY_MESSAGE,
  normalizeTargetGravity: normalizeTargetGravity,
  checkTargetGravityPair: checkTargetGravityPair,
  normalizeRecipeIngredientTuple: normalizeRecipeIngredientTuple,
  recipeIngredientsUnchanged: recipeIngredientsUnchanged,
  planIngredientIds: planIngredientIds
};

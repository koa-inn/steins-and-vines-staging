'use strict';

/**
 * Fermentation-schedule steps validator shared by the Postgres layer and the backfill (Phase 86).
 *
 * Behavioural identity with apps-script/adminApi.gs createFermSchedule is the requirement; the
 * per-step shape checks are stricter than the .gs and exist because steps become jsonb.
 * Parity-tested by __tests__/ferm-schedule-rules-parity.test.js.
 *
 * Note: the .gs error message says "Exactly one step must be a packaging step", but its code
 * uses steps.some(is_packaging === true), so two packaging steps are accepted. The port follows
 * the code, not the message.
 */

var recipeRules = require('./recipe-rules');

function invalid(message) {
  return { ok: false, error: 'invalid_steps', message: message };
}

/**
 * @param {*} value - an array, or a JSON string of an array
 * @returns {{ok:true, steps:Array}|{ok:false, error:string, message:string}}
 */
function parseSteps(value) {
  var steps = value;
  if (typeof value === 'string') {
    try {
      steps = JSON.parse(value);
    } catch (err) {
      return invalid('Invalid steps JSON: ' + err.message);
    }
  }
  if (!Array.isArray(steps)) return invalid('steps must be an array');
  return { ok: true, steps: steps };
}

function isNumeric(v) {
  if (typeof v === 'number') return isFinite(v);
  if (typeof v === 'string' && v.trim() !== '') return isFinite(Number(v));
  return false;
}

/**
 * @param {Array} steps
 * @returns {{ok:true}|{ok:false, error:string, message:string}}
 */
function validateSteps(steps) {
  if (!Array.isArray(steps)) return invalid('steps must be an array');
  if (steps.length < 2) {
    return { ok: false, error: 'too_few_steps', message: 'At least 2 steps required' };
  }
  for (var i = 0; i < steps.length; i++) {
    var s = steps[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return invalid('Step ' + (i + 1) + ' must be an object');
    if (!isNumeric(s.step_number)) return invalid('Step ' + (i + 1) + ' step_number must be numeric');
    if (!isNumeric(s.day_offset)) return invalid('Step ' + (i + 1) + ' day_offset must be numeric');
    if (typeof s.title !== 'string') return invalid('Step ' + (i + 1) + ' title must be a string');
  }
  var hasPackaging = steps.some(function (s) { return s && s.is_packaging === true; });
  if (!hasPackaging) {
    return { ok: false, error: 'no_packaging_step', message: 'Exactly one step must be a packaging step' };
  }
  return { ok: true };
}

function sanitizeScheduleText(value) {
  return recipeRules.sanitizeInput(value);
}

module.exports = {
  parseSteps: parseSteps,
  validateSteps: validateSteps,
  sanitizeScheduleText: sanitizeScheduleText
};

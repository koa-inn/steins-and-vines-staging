'use strict';

/**
 * Per-store data-source flag — Phase 83 (DB-02, D-05, D-06).
 *
 * Each store (GiftCards, Recipes, ...) is independently switched between the
 * legacy Sheets/Apps-Script path and Postgres via a Railway env var named
 * `<STORE>_STORE` (e.g. GIFT_CARDS_STORE). Flipping a store = edit the
 * Railway variable, then Railway restarts the service (~1 min). There is
 * deliberately NO runtime/admin toggle (D-05) — the switch always goes
 * through a deploy-time env var, so an invalid value fails the boot, not
 * the first request.
 *
 * Unset = 'sheets' (today's behavior, zero-config). Any other value must be
 * exactly 'sheets', 'dual', or 'postgres' — anything else refuses to boot
 * with a clear message naming the offending variable (D-06). Values are
 * REJECTED, never coerced/trimmed/lowercased — 'Dual', ' dual', 'postgresql'
 * are all invalid, not silently corrected.
 *
 * Later phases append their own store to STORE_ENV_NAMES (one line each) as
 * each store is migrated — this file itself never needs a structural change.
 */

var log = require('./logger');
var db = require('./db');

var VALID_MODES = ['sheets', 'dual', 'postgres'];

// Later phases append their store's env var name here as each store adopts
// this flag (Phase 84: GIFT_CARDS_STORE, Phase 87ish: RECIPES_STORE, ...).
var STORE_ENV_NAMES = ['GIFT_CARDS_STORE', 'RECIPES_STORE', 'OPS_DATA_STORE', 'STAFF_ACCESS_STORE'];

/**
 * Resolve a single store's mode from its Railway env var.
 * Unset/'' -> 'sheets'. Invalid value -> log.error + process.exit(1) (D-06).
 *
 * @param {string} envName - e.g. 'GIFT_CARDS_STORE'
 * @returns {string} 'sheets' | 'dual' | 'postgres'
 */
function resolveStoreMode(envName) {
  var raw = process.env[envName];
  if (!raw) return 'sheets';

  if (VALID_MODES.indexOf(raw) === -1) {
    log.error('[store-flag] Invalid ' + envName + '=' + JSON.stringify(raw) +
      ' — must be one of: ' + VALID_MODES.join(', ') + ' (unset = sheets). Refusing to boot (D-06).');
    process.exit(1);
    return undefined;
  }

  return raw;
}

/**
 * Resolve every configured store's mode and enforce that any store in
 * 'dual'/'postgres' mode has a working DATABASE_URL — otherwise refuse to
 * boot, naming both the store variable and DATABASE_URL (D-06).
 *
 * Called once at startup (server.js, alongside validateEnv()), not
 * per-request — an invalid value must fail the boot, not the first sale.
 *
 * @param {string[]} [envNames] - defaults to STORE_ENV_NAMES
 * @returns {Object<string,string>} map of envName -> resolved mode
 */
function validateStoreFlags(envNames) {
  envNames = envNames || STORE_ENV_NAMES;

  var result = {};
  envNames.forEach(function (name) {
    result[name] = resolveStoreMode(name);
  });

  var needsDb = envNames.filter(function (name) {
    return result[name] === 'dual' || result[name] === 'postgres';
  });

  if (needsDb.length > 0 && !db.isConfigured()) {
    needsDb.forEach(function (name) {
      log.error('[store-flag] ' + name + '=' + result[name] +
        ' requires DATABASE_URL to be set — refusing to boot (D-06).');
    });
    log.error('[store-flag] ' + needsDb.length + ' store(s) need DATABASE_URL. Exiting.');
    process.exit(1);
  }

  return result;
}

module.exports = {
  resolveStoreMode: resolveStoreMode,
  validateStoreFlags: validateStoreFlags,
  STORE_ENV_NAMES: STORE_ENV_NAMES,
  VALID_MODES: VALID_MODES
};

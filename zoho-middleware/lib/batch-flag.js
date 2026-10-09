'use strict';

/**
 * BATCHES_STORE mode and BATCHES_FREEZE switch — Phase 87 (DB-06, D-05, D-13).
 *
 * BATCHES_STORE is deliberately NOT in store-flag.STORE_ENV_NAMES (the existing
 * store-flag test asserts that array with toEqual); it reuses the same resolver.
 *
 *  - unset = 'sheets'; 'postgres' = Postgres authoritative.
 *  - 'dual' refuses to boot: there is no dual-write window for batches (87-DESIGN s12).
 *  - 'postgres' refuses to boot unless OPS_DATA_STORE is dual/postgres, because
 *    vessel updates share one transaction with batch writes (D-13).
 *
 * BATCHES_FREEZE holds the human "until" text. Non-empty = batch writes frozen.
 * Read per call, never cached, no auto-expiry (D-05).
 */

var storeFlag = require('./store-flag');
var log = require('./logger');

var BATCHES_ENV = 'BATCHES_STORE';
var OPS_ENV = 'OPS_DATA_STORE';

function getMode() {
  return storeFlag.resolveStoreMode(BATCHES_ENV);
}

function validateBatchesFlag() {
  var modes = storeFlag.validateStoreFlags([BATCHES_ENV]);
  var mode = modes[BATCHES_ENV];

  if (mode === 'dual') {
    log.error('[batch-flag] ' + BATCHES_ENV + '=dual: dual is not supported for batches' +
      ' (no dual-write window). Use sheets or postgres. Refusing to boot.');
    process.exit(1);
    return mode;
  }

  if (mode === 'postgres') {
    var opsMode = storeFlag.resolveStoreMode(OPS_ENV);
    if (opsMode === 'sheets') {
      log.error('[batch-flag] ' + BATCHES_ENV + '=postgres requires ' + OPS_ENV +
        '=dual or postgres (vessels must be Postgres-authoritative, D-13). Refusing to boot.');
      process.exit(1);
    }
  }

  return mode;
}

function freezeText() {
  var raw = process.env.BATCHES_FREEZE;
  return typeof raw === 'string' ? raw.trim() : '';
}

function isFrozen() {
  return freezeText() !== '';
}

function freezeMessage() {
  return 'Batches are read-only for maintenance until ' + freezeText() + '. Please try again then.';
}

function maintenanceEnvelope() {
  return { ok: false, error: 'maintenance', message: freezeMessage() };
}

module.exports = {
  BATCHES_ENV: BATCHES_ENV,
  getMode: getMode,
  validateBatchesFlag: validateBatchesFlag,
  isFrozen: isFrozen,
  freezeMessage: freezeMessage,
  maintenanceEnvelope: maintenanceEnvelope
};

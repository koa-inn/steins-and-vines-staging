'use strict';

// Phase 87 Plan 02 (DB-06, D-05, D-13): BATCHES_STORE flag, boot rules and BATCHES_FREEZE switch.

var mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../lib/logger', function () { return mockLog; });

var mockIsConfigured = jest.fn();
jest.mock('../lib/db', function () {
  return { isConfigured: function () { return mockIsConfigured(); } };
});

describe('batch-flag', function () {
  var batchFlag;
  var storeFlag;
  var SAVED_ENV;
  var NAMES = ['BATCHES_STORE', 'BATCHES_FREEZE', 'OPS_DATA_STORE'];

  beforeEach(function () {
    SAVED_ENV = Object.assign({}, process.env);
    jest.resetModules();
    NAMES.forEach(function (n) { delete process.env[n]; });
    jest.spyOn(process, 'exit').mockImplementation(function () {});
    mockLog.error.mockClear();
    mockIsConfigured.mockReset();
    mockIsConfigured.mockReturnValue(true);
    storeFlag = require('../lib/store-flag');
    batchFlag = require('../lib/batch-flag');
  });

  afterEach(function () {
    jest.restoreAllMocks();
    Object.keys(process.env).forEach(function (k) {
      if (!(k in SAVED_ENV)) delete process.env[k];
    });
    Object.keys(SAVED_ENV).forEach(function (k) { process.env[k] = SAVED_ENV[k]; });
  });

  function errorText() {
    return mockLog.error.mock.calls.map(function (c) { return c[0]; }).join('\n');
  }

  test('BATCHES_ENV is BATCHES_STORE', function () {
    expect(batchFlag.BATCHES_ENV).toBe('BATCHES_STORE');
  });

  test('unset -> sheets', function () {
    expect(batchFlag.getMode()).toBe('sheets');
  });

  test('postgres -> postgres', function () {
    process.env.BATCHES_STORE = 'postgres';
    expect(batchFlag.getMode()).toBe('postgres');
  });

  test('invalid value -> exit(1)', function () {
    process.env.BATCHES_STORE = 'Postgres';
    batchFlag.getMode();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  test('validate: unset passes without exit', function () {
    expect(batchFlag.validateBatchesFlag()).toBe('sheets');
    expect(process.exit).not.toHaveBeenCalled();
  });

  test('validate: dual refuses to boot', function () {
    process.env.BATCHES_STORE = 'dual';
    batchFlag.validateBatchesFlag();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toContain('BATCHES_STORE');
    expect(errorText()).toContain('dual is not supported');
  });

  test('validate: postgres with OPS_DATA_STORE unset refuses to boot', function () {
    process.env.BATCHES_STORE = 'postgres';
    batchFlag.validateBatchesFlag();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toContain('OPS_DATA_STORE');
  });

  test('validate: postgres with OPS_DATA_STORE=sheets refuses to boot', function () {
    process.env.BATCHES_STORE = 'postgres';
    process.env.OPS_DATA_STORE = 'sheets';
    batchFlag.validateBatchesFlag();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toContain('OPS_DATA_STORE');
  });

  ['dual', 'postgres'].forEach(function (ops) {
    test('validate: postgres with OPS_DATA_STORE=' + ops + ' boots', function () {
      process.env.BATCHES_STORE = 'postgres';
      process.env.OPS_DATA_STORE = ops;
      expect(batchFlag.validateBatchesFlag()).toBe('postgres');
      expect(process.exit).not.toHaveBeenCalled();
    });
  });

  test('validate: postgres without DATABASE_URL refuses to boot', function () {
    process.env.BATCHES_STORE = 'postgres';
    process.env.OPS_DATA_STORE = 'postgres';
    mockIsConfigured.mockReturnValue(false);
    batchFlag.validateBatchesFlag();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(errorText()).toContain('BATCHES_STORE');
    expect(errorText()).toContain('DATABASE_URL');
  });

  test('isFrozen: false when unset or whitespace', function () {
    expect(batchFlag.isFrozen()).toBe(false);
    process.env.BATCHES_FREEZE = '   ';
    expect(batchFlag.isFrozen()).toBe(false);
  });

  test('isFrozen: true when set, re-read on every call', function () {
    process.env.BATCHES_FREEZE = '9:00 PM PT';
    expect(batchFlag.isFrozen()).toBe(true);
    delete process.env.BATCHES_FREEZE;
    expect(batchFlag.isFrozen()).toBe(false);
    process.env.BATCHES_FREEZE = '10:00 PM PT';
    expect(batchFlag.isFrozen()).toBe(true);
  });

  test('freezeMessage and maintenanceEnvelope', function () {
    process.env.BATCHES_FREEZE = '9:00 PM PT';
    var msg = 'Batches are read-only for maintenance until 9:00 PM PT. Please try again then.';
    expect(batchFlag.freezeMessage()).toBe(msg);
    expect(batchFlag.maintenanceEnvelope()).toEqual({ ok: false, error: 'maintenance', message: msg });
    process.env.BATCHES_FREEZE = '11:00 PM PT';
    expect(batchFlag.freezeMessage()).toContain('until 11:00 PM PT.');
  });

  test('STORE_ENV_NAMES does not contain BATCHES_STORE', function () {
    expect(storeFlag.STORE_ENV_NAMES).not.toContain('BATCHES_STORE');
  });
});

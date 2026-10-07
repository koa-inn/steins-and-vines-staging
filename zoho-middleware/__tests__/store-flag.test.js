'use strict';

// Tests for lib/store-flag.js — Phase 83 Plan 04 Task 1 (D-05, D-06).
//
// Harness mirrors validateEnv.test.js's env snapshot/restore + process.exit
// spy pattern. ../lib/logger and ../lib/db are mocked so tests can assert on
// log content and control isConfigured() without touching real modules.

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var mockIsConfigured = jest.fn();
jest.mock('../lib/db', function () {
  return { isConfigured: function () { return mockIsConfigured(); } };
});

describe('store-flag', function () {
  var storeFlag;
  var log;
  var SAVED_ENV;

  beforeEach(function () {
    SAVED_ENV = Object.assign({}, process.env);
    jest.resetModules();

    delete process.env.GIFT_CARDS_STORE;
    delete process.env.RECIPES_STORE;

    jest.spyOn(process, 'exit').mockImplementation(function () {});

    mockIsConfigured.mockReset();
    mockIsConfigured.mockReturnValue(true);

    storeFlag = require('../lib/store-flag');
    log = require('../lib/logger');
  });

  afterEach(function () {
    jest.restoreAllMocks();
    Object.keys(process.env).forEach(function (k) {
      if (!(k in SAVED_ENV)) delete process.env[k];
    });
    Object.keys(SAVED_ENV).forEach(function (k) {
      process.env[k] = SAVED_ENV[k];
    });
  });

  test('exports VALID_MODES and STORE_ENV_NAMES', function () {
    expect(storeFlag.VALID_MODES).toEqual(['sheets', 'dual', 'postgres']);
    expect(storeFlag.STORE_ENV_NAMES).toEqual(['GIFT_CARDS_STORE', 'RECIPES_STORE', 'OPS_DATA_STORE', 'STAFF_ACCESS_STORE']);
  });

  describe('resolveStoreMode', function () {
    test('unset -> sheets, no exit', function () {
      expect(storeFlag.resolveStoreMode('GIFT_CARDS_STORE')).toBe('sheets');
      expect(process.exit).not.toHaveBeenCalled();
    });

    test("'' -> sheets, no exit", function () {
      process.env.GIFT_CARDS_STORE = '';
      expect(storeFlag.resolveStoreMode('GIFT_CARDS_STORE')).toBe('sheets');
      expect(process.exit).not.toHaveBeenCalled();
    });

    ['sheets', 'dual', 'postgres'].forEach(function (mode) {
      test("'" + mode + "' -> " + mode + ', no exit', function () {
        process.env.GIFT_CARDS_STORE = mode;
        expect(storeFlag.resolveStoreMode('GIFT_CARDS_STORE')).toBe(mode);
        expect(process.exit).not.toHaveBeenCalled();
      });
    });

    ['Dual', 'postgresql', 'sheet', ' dual'].forEach(function (invalid) {
      test('invalid value ' + JSON.stringify(invalid) + ' -> exit(1), no coercion', function () {
        process.env.GIFT_CARDS_STORE = invalid;
        storeFlag.resolveStoreMode('GIFT_CARDS_STORE');
        expect(process.exit).toHaveBeenCalledWith(1);
        expect(log.error).toHaveBeenCalled();
        var msg = log.error.mock.calls[0][0];
        expect(msg).toEqual(expect.stringContaining('GIFT_CARDS_STORE'));
        expect(msg).toEqual(expect.stringContaining('sheets'));
        expect(msg).toEqual(expect.stringContaining('dual'));
        expect(msg).toEqual(expect.stringContaining('postgres'));
      });
    });
  });

  describe('validateStoreFlags', function () {
    test('with all unset -> returns sheets defaults for both stores, no exit', function () {
      var result = storeFlag.validateStoreFlags();
      expect(result).toEqual({ GIFT_CARDS_STORE: 'sheets', RECIPES_STORE: 'sheets', OPS_DATA_STORE: 'sheets', STAFF_ACCESS_STORE: 'sheets' });
      expect(process.exit).not.toHaveBeenCalled();
    });

    test('GIFT_CARDS_STORE=dual with DATABASE_URL unset -> exit(1) naming both variables', function () {
      process.env.GIFT_CARDS_STORE = 'dual';
      mockIsConfigured.mockReturnValue(false);

      storeFlag.validateStoreFlags(['GIFT_CARDS_STORE']);

      expect(process.exit).toHaveBeenCalledWith(1);
      var namesBoth = log.error.mock.calls.some(function (args) {
        return args[0].indexOf('GIFT_CARDS_STORE') !== -1 && args[0].indexOf('DATABASE_URL') !== -1;
      });
      expect(namesBoth).toBe(true);
    });

    test('GIFT_CARDS_STORE=postgres with DATABASE_URL configured -> no exit', function () {
      process.env.GIFT_CARDS_STORE = 'postgres';
      mockIsConfigured.mockReturnValue(true);

      var result = storeFlag.validateStoreFlags(['GIFT_CARDS_STORE']);

      expect(process.exit).not.toHaveBeenCalled();
      expect(result).toEqual({ GIFT_CARDS_STORE: 'postgres' });
    });

    test('mixed stores: one sheets (default), one dual -> only the dual store requires DATABASE_URL', function () {
      process.env.RECIPES_STORE = 'dual';
      mockIsConfigured.mockReturnValue(true);

      var result = storeFlag.validateStoreFlags(['GIFT_CARDS_STORE', 'RECIPES_STORE']);

      expect(process.exit).not.toHaveBeenCalled();
      expect(result).toEqual({ GIFT_CARDS_STORE: 'sheets', RECIPES_STORE: 'dual' });
    });
  });
});

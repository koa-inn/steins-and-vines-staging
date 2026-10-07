'use strict';

// Phase 86 Plan 01 (D-19): OPS_DATA_STORE and STAFF_ACCESS_STORE are first-class store flags.

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var mockIsConfigured = jest.fn();
jest.mock('../lib/db', function () {
  return { isConfigured: function () { return mockIsConfigured(); } };
});

describe('ops store flags', function () {
  var storeFlag;
  var SAVED_ENV;
  var NAMES = ['OPS_DATA_STORE', 'STAFF_ACCESS_STORE'];

  beforeEach(function () {
    SAVED_ENV = Object.assign({}, process.env);
    jest.resetModules();
    NAMES.forEach(function (n) { delete process.env[n]; });
    jest.spyOn(process, 'exit').mockImplementation(function () {});
    mockIsConfigured.mockReset();
    mockIsConfigured.mockReturnValue(true);
    storeFlag = require('../lib/store-flag');
  });

  afterEach(function () {
    jest.restoreAllMocks();
    Object.keys(process.env).forEach(function (k) {
      if (!(k in SAVED_ENV)) delete process.env[k];
    });
    Object.keys(SAVED_ENV).forEach(function (k) { process.env[k] = SAVED_ENV[k]; });
  });

  NAMES.forEach(function (name) {
    test(name + ' is in STORE_ENV_NAMES', function () {
      expect(storeFlag.STORE_ENV_NAMES).toContain(name);
    });

    test(name + ' unset -> sheets', function () {
      expect(storeFlag.resolveStoreMode(name)).toBe('sheets');
    });

    ['dual', 'postgres'].forEach(function (mode) {
      test(name + '=' + mode + ' resolves', function () {
        process.env[name] = mode;
        expect(storeFlag.resolveStoreMode(name)).toBe(mode);
        expect(process.exit).not.toHaveBeenCalled();
      });
    });

    test(name + ' invalid value -> exit(1)', function () {
      process.env[name] = 'Dual';
      storeFlag.resolveStoreMode(name);
      expect(process.exit).toHaveBeenCalledWith(1);
    });

    test(name + '=dual without DATABASE_URL -> exit(1) at validateStoreFlags', function () {
      process.env[name] = 'dual';
      mockIsConfigured.mockReturnValue(false);
      storeFlag.validateStoreFlags();
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});

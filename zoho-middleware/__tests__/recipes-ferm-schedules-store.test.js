'use strict';

// Phase 86-16 Task 3: fetchFermSchedules reads the store in dual/postgres.

jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('axios', function () { return { get: jest.fn(), post: jest.fn() }; });
jest.mock('../lib/cache', function () { return { get: jest.fn(), set: jest.fn(), del: jest.fn() }; });
jest.mock('../lib/logger', function () { return { info: jest.fn(), warn: jest.fn(), error: jest.fn() }; });
jest.mock('../lib/constants', function () {
  return { CACHE_KEYS: { RECIPES: 'r', RECIPES_TS: 'rt', INGREDIENTS: 'i', INGREDIENTS_ALL: 'ia',
    RECIPE_AVAILABILITY: 'ra', FERM_SCHEDULES: 'sv:ferm-schedules' } };
});

var mockStore = { getMode: jest.fn(), list: jest.fn() };
jest.mock('../lib/ferm-schedule-store', function () { return mockStore; });

var router = require('../routes/recipes');
var axios = require('axios');
var cache = require('../lib/cache');
var log = require('../lib/logger');

beforeEach(function () {
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/test';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  axios.get.mockReset();
  cache.get.mockReset().mockResolvedValue(null);
  cache.set.mockReset();
  log.warn.mockReset();
  mockStore.getMode.mockReset();
  mockStore.list.mockReset();
});

describe('fetchFermSchedules by mockStore mode', function () {
  test('sheets: cache + axios as today', function () {
    mockStore.getMode.mockReturnValue('sheets');
    axios.get.mockResolvedValue({ data: { ok: true, data: { schedules: [{ schedule_id: 'S1' }] } } });
    return router.fetchFermSchedules().then(function (s) {
      expect(s).toEqual([{ schedule_id: 'S1' }]);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalled();
      expect(mockStore.list).not.toHaveBeenCalled();
    });
  });

  test('postgres: mockStore list with archived, no cache, no axios', function () {
    mockStore.getMode.mockReturnValue('postgres');
    mockStore.list.mockResolvedValue({ ok: true, data: { schedules: [{ schedule_id: 'S2', is_archived: true }] } });
    return router.fetchFermSchedules().then(function (s) {
      expect(s).toEqual([{ schedule_id: 'S2', is_archived: true }]);
      expect(mockStore.list).toHaveBeenCalledWith({ includeArchived: true });
      expect(axios.get).not.toHaveBeenCalled();
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });
  });

  test('mockStore rejection -> [] and warn', function () {
    mockStore.getMode.mockReturnValue('dual');
    mockStore.list.mockRejectedValue(new Error('pg down'));
    return router.fetchFermSchedules().then(function (s) {
      expect(s).toEqual([]);
      expect(log.warn).toHaveBeenCalled();
    });
  });
});

'use strict';

// Regression (Phase 101 staging gate, 2026-11-11): after a redeploy the full
// ingredient catalog was in neither Redis nor the file fallback, and every
// recipe sale busts the Redis key. getIngredientCatalog returned null, so
// recipe-quote / cart-quote / sale answered 503 ("Price unavailable") until
// someone hit /api/ingredients. It must rebuild the catalog itself instead.

jest.mock('../lib/cache', function () {
  return { get: jest.fn(), set: jest.fn(), del: jest.fn() };
});
jest.mock('../routes/catalog', function () {
  return { refreshIngredients: jest.fn() };
});

var fs = require('fs');
var cache = require('../lib/cache');
var catalogRoutes = require('../routes/catalog');
var lines = require('../lib/recipe-sale-lines');

var CATALOG = [{ item_id: 'I1', rate: 2 }, { item_id: 'I2', rate: 3 }];

describe('getIngredientCatalog — cold cache', function () {
  var realRead = fs.readFileSync;

  beforeEach(function () {
    cache.get.mockReset();
    catalogRoutes.refreshIngredients.mockReset();
    jest.spyOn(fs, 'readFileSync').mockImplementation(function (p, enc) {
      if (String(p).indexOf('ingredients-all-cache.json') !== -1) throw new Error('ENOENT');
      return realRead.call(fs, p, enc);
    });
  });
  afterEach(function () { fs.readFileSync.mockRestore(); });

  test('Redis hit returns the cached catalog without a refresh', function () {
    cache.get.mockResolvedValue(CATALOG);
    return lines.getIngredientCatalog().then(function (cat) {
      expect(cat).toBe(CATALOG);
      expect(catalogRoutes.refreshIngredients).not.toHaveBeenCalled();
    });
  });

  test('Redis and file both empty → refreshes, then returns the rebuilt catalog', function () {
    cache.get.mockResolvedValueOnce(null).mockResolvedValueOnce(CATALOG);
    catalogRoutes.refreshIngredients.mockResolvedValue([]);
    return lines.getIngredientCatalog().then(function (cat) {
      expect(catalogRoutes.refreshIngredients).toHaveBeenCalledTimes(1);
      expect(cat).toBe(CATALOG);
    });
  });

  test('refresh failure still resolves null (caller answers 503), never throws', function () {
    cache.get.mockResolvedValue(null);
    catalogRoutes.refreshIngredients.mockRejectedValue(new Error('zoho down'));
    return lines.getIngredientCatalog().then(function (cat) {
      expect(cat).toBeNull();
    });
  });
});

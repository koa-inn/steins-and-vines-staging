'use strict';

// Per-kit "Sold out" flag. A sold-out kit blocks new deposits but must keep
// pricing and redeeming for customers who already paid a deposit.

jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
});
jest.mock('../lib/zoho-api', function () {
  return { zohoGet: jest.fn(), zohoPost: jest.fn(), zohoPostOnce: jest.fn(), zohoDelete: jest.fn() };
});
jest.mock('../lib/cache', function () {
  return { get: jest.fn(), set: jest.fn().mockResolvedValue('OK') };
});

var fs = require('fs');
var path = require('path');
var lr = require('../lib/limited-releases');
var dep = require('../lib/limited-releases-deposit');
var zoho = require('../lib/zoho-api');
var cache = require('../lib/cache');

var ARIA = '109900000001719012';
var EMBER = '109900000001719001';
var CONNEXION_RED = '109900000001719056';

describe('sold-out flag', function () {
  test('Aria is sold out; every other kit is not', function () {
    Object.keys(lr.ALLOWLIST).forEach(function (id) {
      expect(lr.ALLOWLIST[id].sold_out).toBe(id === ARIA);
    });
  });

  test('validateBasket rejects a basket with Aria and names the kit', function () {
    var r = lr.validateBasket([{ item_id: ARIA, qty: 1 }]);
    expect(r).toEqual({ ok: false, error: 'Aria is sold out' });
  });

  test('validateBasket rejects Aria mixed with available kits', function () {
    var r = lr.validateBasket([{ item_id: EMBER, qty: 1 }, { item_id: ARIA, qty: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Aria is sold out');
  });

  test('a basket of other kits still passes', function () {
    var r = lr.validateBasket([{ item_id: EMBER, qty: 2 }, { item_id: CONNEXION_RED, qty: 1 }]);
    expect(r).toEqual({
      ok: true,
      lines: [{ item_id: EMBER, qty: 2 }, { item_id: CONNEXION_RED, qty: 1 }],
      totalKits: 3
    });
  });

  test('sold_out matches between the frontend JSON and ALLOWLIST (missing = false)', function () {
    var p = process.env.LIMITED_RELEASES_JSON ||
      path.join(__dirname, '..', '..', 'content', 'limited-releases-2026-27.json');
    var data = JSON.parse(fs.readFileSync(p, 'utf8'));
    data.kits.forEach(function (k) {
      var e = lr.ALLOWLIST[k.zoho_item_id];
      expect({ id: k.zoho_item_id, sold_out: e.sold_out === true })
        .toEqual({ id: k.zoho_item_id, sold_out: k.sold_out === true });
    });
  });
});

describe('existing Aria deposits keep working', function () {
  beforeEach(function () {
    jest.resetAllMocks();
    cache.set.mockResolvedValue('OK');
  });

  test('getKitRate still resolves for Aria', async function () {
    cache.get.mockResolvedValue(null);
    zoho.zohoGet.mockResolvedValue({ item: { status: 'active', rate: 230 } });
    expect(await dep.getKitRate(ARIA)).toBe(230);
    expect(zoho.zohoGet).toHaveBeenCalledWith('/items/' + ARIA);
  });

  test('expandUnits still expands Aria lines', function () {
    var units = lr.expandUnits([{ item_id: ARIA, qty: 1 }]);
    expect(units).toHaveLength(1);
    expect(units[0].name).toBe('Aria');
  });
});

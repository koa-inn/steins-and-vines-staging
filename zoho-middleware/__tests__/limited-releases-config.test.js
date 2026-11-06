'use strict';

var fs = require('fs');
var path = require('path');
var lr = require('../lib/limited-releases');

var A = '109900000001719001';
var B = '109900000001719056';

describe('limited-releases config', function () {
  test('constants', function () {
    expect(lr.DEPOSIT_PER_KIT).toBe(50);
    expect(lr.MAX_QTY_PER_LINE).toBe(10);
    expect(lr.MAX_KITS_PER_ORDER).toBe(10);
    expect(lr.CAMPAIGN_REFERENCE).toBe('LIMITED-2026-27');
    expect(Object.keys(lr.ALLOWLIST).length).toBe(10);
  });

  test('drift check against the frontend JSON (test-only read)', function () {
    var p = process.env.LIMITED_RELEASES_JSON ||
      path.join(__dirname, '..', '..', 'content', 'limited-releases-2026-27.json');
    var data = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(data.kits.length).toBe(10);
    data.kits.forEach(function (k) {
      var e = lr.ALLOWLIST[k.zoho_item_id];
      expect(e).toBeDefined();
      expect(e.sku).toBe(k.sku);
      expect(e.release).toBe(k.release);
      expect(e.release_label).toBe(k.release_label);
      expect(e.collection).toBe(k.collection);
    });
  });
});

describe('validateBasket', function () {
  test('valid basket', function () {
    expect(lr.validateBasket([{ item_id: A, qty: 2 }])).toEqual({
      ok: true, lines: [{ item_id: A, qty: 2 }], totalKits: 2
    });
  });

  test('unknown item', function () {
    var r = lr.validateBasket([{ item_id: '123', qty: 1 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Unknown kit');
  });

  test('prototype keys rejected', function () {
    ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].forEach(function (id) {
      expect(lr.validateBasket([{ item_id: id, qty: 1 }]).ok).toBe(false);
    });
  });

  test.each([0, 11, 1.5, '2', -1, null, undefined, NaN])('bad qty %p', function (q) {
    expect(lr.validateBasket([{ item_id: A, qty: q }]).ok).toBe(false);
  });

  test('empty and non-array baskets', function () {
    [[], null, undefined, 'x', {}, 5].forEach(function (b) {
      var r = lr.validateBasket(b);
      expect(r.ok).toBe(false);
      expect(r.error).toBe('Choose at least one kit');
    });
  });

  test('non-object lines rejected', function () {
    expect(lr.validateBasket([null]).ok).toBe(false);
    expect(lr.validateBasket(['x']).ok).toBe(false);
    expect(lr.validateBasket([[A, 1]]).ok).toBe(false);
  });

  test('duplicate item lines rejected', function () {
    expect(lr.validateBasket([{ item_id: A, qty: 1 }, { item_id: A, qty: 1 }]).ok).toBe(false);
  });

  test('more than 10 lines rejected', function () {
    var ids = Object.keys(lr.ALLOWLIST);
    var lines = ids.map(function (id) { return { item_id: id, qty: 1 }; });
    // Clear sold-out flags so all 10 kits can fill the 10-line boundary.
    var soldOut = ids.filter(function (id) { return lr.ALLOWLIST[id].sold_out; });
    soldOut.forEach(function (id) { lr.ALLOWLIST[id].sold_out = false; });
    try {
      expect(lr.validateBasket(lines).ok).toBe(true); // exactly 10 lines / 10 kits
    } finally {
      soldOut.forEach(function (id) { lr.ALLOWLIST[id].sold_out = true; });
    }
    lines.push({ item_id: A, qty: 1 });
    expect(lr.validateBasket(lines).ok).toBe(false);
  });

  test('D-18: 11 kits across lines rejected with exact copy', function () {
    var r = lr.validateBasket([{ item_id: A, qty: 6 }, { item_id: B, qty: 5 }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Up to 10 kits per order. Call us for more: (604) 567-4565');
  });

  test('10 kits across lines allowed', function () {
    var r = lr.validateBasket([{ item_id: A, qty: 5 }, { item_id: B, qty: 5 }]);
    expect(r.ok).toBe(true);
    expect(r.totalKits).toBe(10);
  });

  test('per-item cap hook', function () {
    expect(lr.ALLOWLIST[A].cap).toBeUndefined();
    expect(lr.validateBasket([{ item_id: A, qty: 2 }]).ok).toBe(true);
    lr.ALLOWLIST[A].cap = 1;
    try {
      expect(lr.validateBasket([{ item_id: A, qty: 2 }]).ok).toBe(false);
      expect(lr.validateBasket([{ item_id: A, qty: 1 }]).ok).toBe(true);
    } finally {
      lr.ALLOWLIST[A].cap = undefined;
    }
  });
});

describe('computeDeposit / expandUnits', function () {
  test('deposit', function () {
    expect(lr.computeDeposit(3)).toBe(150);
    expect(lr.computeDepositCents(3)).toBe(15000);
  });

  test('expandUnits yields one unit per kit in input order', function () {
    var units = lr.expandUnits([{ item_id: A, qty: 2 }, { item_id: B, qty: 1 }]);
    expect(units.length).toBe(3);
    expect(units.map(function (u) { return u.item_id; })).toEqual([A, A, B]);
    expect(units[0]).toEqual({
      item_id: A,
      sku: lr.ALLOWLIST[A].sku,
      name: lr.ALLOWLIST[A].name,
      release: lr.ALLOWLIST[A].release,
      release_label: lr.ALLOWLIST[A].release_label,
      collection: lr.ALLOWLIST[A].collection,
      unitIndex: 1,
      unitCount: 2
    });
    expect(units[1].unitIndex).toBe(2);
    expect(units[2].unitIndex).toBe(1);
    expect(units[2].unitCount).toBe(1);
  });
});

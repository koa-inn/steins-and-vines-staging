'use strict';

// Phase 101 D-02 (Pitfall 2): detectRecipeSale accepts opts.unit_total so repeated
// in-store entries of one recipe on one invoice each create a batch (dedup allows
// unit_total copies per zoho_so_number + product_sku). Omitted / <= 1 is unchanged.

jest.mock('axios', function () {
  return { get: jest.fn(), post: jest.fn() };
});
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    isConnected: jest.fn().mockReturnValue(false)
  };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });

process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';

var axios = require('axios');
var brewpad = require('../lib/brewpad-integration');

var SNAP = { name: 'Pale Ale', target_volume_l: 23, scale_factor: 1 };

function sent() {
  return axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
}

function flush() {
  return new Promise(function (resolve) { setTimeout(resolve, 10); });
}

describe('detectRecipeSale opts.unit_total (Phase 101 D-02)', function () {
  beforeEach(function () {
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { ok: true, batch_id: 'B-1' } });
  });

  test('unit_total 2 is carried on the create payload', function () {
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-1', 'Ann', 'c1', 'a@b.co', { unit_total: 2 });
    return flush().then(function () {
      var p = sent();
      expect(p).toHaveLength(1);
      expect(p[0].unit_total).toBe(2);
      expect(p[0].product_sku).toBe('RCP-1');
    });
  });

  test('two entries of the same recipe each create with unit_total 2', function () {
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-1', 'Ann', 'c1', 'a@b.co', { unit_total: 2 });
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-1', 'Ann', 'c1', 'a@b.co', { unit_total: 2 });
    return flush().then(function () {
      var p = sent();
      expect(p).toHaveLength(2);
      expect(p[0].unit_total).toBe(2);
      expect(p[1].unit_total).toBe(2);
    });
  });

  test('no opts: no unit_total key, customer_email still present', function () {
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-1', 'Ann', 'c1', 'a@b.co');
    return flush().then(function () {
      var p = sent()[0];
      expect(Object.prototype.hasOwnProperty.call(p, 'unit_total')).toBe(false);
      expect(p.customer_email).toBe('a@b.co');
    });
  });

  test('opts unit_total 1 (or invalid): no unit_total key', function () {
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-1', 'Ann', 'c1', '', { unit_total: 1 });
    brewpad.detectRecipeSale('RCP-1', SNAP, 'INV-2', 'Ann', 'c1', '', { unit_total: 'x' });
    return flush().then(function () {
      sent().forEach(function (p) {
        expect(Object.prototype.hasOwnProperty.call(p, 'unit_total')).toBe(false);
      });
    });
  });
});

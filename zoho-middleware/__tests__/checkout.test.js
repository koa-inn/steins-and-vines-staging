'use strict';

var EventEmitter = require('events');

// ---------------------------------------------------------------------------
// Mocks — must be declared before require()
// ---------------------------------------------------------------------------
jest.mock('https');
jest.mock('express', () => {
  var router = { get: jest.fn(), post: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('../lib/helcim', () => ({
  isEnabled: jest.fn().mockReturnValue(true),
  getDepositAmount: jest.fn().mockReturnValue(50),
  voidTransaction: jest.fn().mockResolvedValue({ ok: true, transactionId: 'txn-mock' }),
  getTerminalDiagnostics: jest.fn().mockReturnValue({})
}));
jest.mock('../lib/zoho-api', () => ({
  zohoPost: jest.fn(), zohoGet: jest.fn()
}));
jest.mock('../lib/cache', () => ({
  get: jest.fn(), set: jest.fn(), del: jest.fn()
}));
jest.mock('../lib/mailer', () => ({
  sendReservationNotification: jest.fn().mockResolvedValue(),
  sendOfflineOrderNotification: jest.fn().mockResolvedValue()
}));
jest.mock('axios', () => ({ post: jest.fn().mockResolvedValue({ data: { ok: true } }) }));
jest.mock('querystring', () => require.requireActual
  ? require.requireActual('querystring')
  : jest.requireActual('querystring'));

var https = require('https');
var checkout = require('../routes/checkout');
var verifyRecaptcha = checkout.verifyRecaptcha;
var buildLineItems = checkout.buildLineItems;

// ---------------------------------------------------------------------------
// HTTPS mock helpers (same pattern as zohoAuth tests)
// ---------------------------------------------------------------------------
function mockHttpsSuccess(responseBody) {
  var res = new EventEmitter();
  var req = new EventEmitter();
  req.write = jest.fn();
  req.end = jest.fn(function () {
    var calls = https.request.mock.calls;
    var cb = calls[calls.length - 1][1];
    cb(res);
    res.emit('data', Buffer.from(JSON.stringify(responseBody)));
    res.emit('end');
  });
  https.request.mockReturnValue(req);
}

function mockHttpsNetworkError(err) {
  var req = new EventEmitter();
  req.write = jest.fn();
  req.end = jest.fn(function () { req.emit('error', err); });
  https.request.mockReturnValue(req);
}

function mockHttpsBadJson() {
  var res = new EventEmitter();
  var req = new EventEmitter();
  req.write = jest.fn();
  req.end = jest.fn(function () {
    var calls = https.request.mock.calls;
    var cb = calls[calls.length - 1][1];
    cb(res);
    res.emit('data', Buffer.from('not-valid-json!!!'));
    res.emit('end');
  });
  https.request.mockReturnValue(req);
}

// ---------------------------------------------------------------------------
// verifyRecaptcha
// ---------------------------------------------------------------------------
describe('verifyRecaptcha', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RECAPTCHA_SECRET_KEY;
  });

  test('no secret key configured → success with score 1.0 (allow all)', async () => {
    var result = await verifyRecaptcha('any-token');
    expect(result).toEqual({ success: true, score: 1.0 });
    expect(https.request).not.toHaveBeenCalled();
  });

  test('secret key set but no token → failure with score 0', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    var result = await verifyRecaptcha('');
    expect(result).toEqual({ success: false, score: 0 });
    expect(https.request).not.toHaveBeenCalled();
  });

  test('secret key set, null token → failure with score 0', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    var result = await verifyRecaptcha(null);
    expect(result).toEqual({ success: false, score: 0 });
  });

  test('valid token → calls Google and returns parsed result', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsSuccess({ success: true, score: 0.9, action: 'checkout' });
    var result = await verifyRecaptcha('tok-abc');
    expect(result).toEqual({ success: true, score: 0.9, action: 'checkout' });
  });

  test('calls correct Google endpoint', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsSuccess({ success: true, score: 0.8 });
    await verifyRecaptcha('tok-xyz');
    expect(https.request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'www.google.com',
        path: '/recaptcha/api/siteverify',
        method: 'POST'
      }),
      expect.any(Function)
    );
  });

  test('low score returned as-is (caller decides threshold)', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsSuccess({ success: true, score: 0.1 });
    var result = await verifyRecaptcha('tok-low');
    expect(result.score).toBe(0.1);
    expect(result.success).toBe(true);
  });

  test('Google returns failure with error-codes', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsSuccess({ success: false, 'error-codes': ['invalid-input-response'] });
    var result = await verifyRecaptcha('bad-tok');
    expect(result.success).toBe(false);
    expect(result['error-codes']).toContain('invalid-input-response');
  });

  test('network error → fails open (success)', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsNetworkError(new Error('ECONNREFUSED'));
    var result = await verifyRecaptcha('tok');
    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
  });

  test('invalid JSON response → fails open (success)', async () => {
    process.env.RECAPTCHA_SECRET_KEY = 'secret123';
    mockHttpsBadJson();
    var result = await verifyRecaptcha('tok');
    expect(result.success).toBe(true);
    expect(result.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// buildLineItems
// ---------------------------------------------------------------------------
describe('buildLineItems', () => {
  test('uses catalog price when catalog is available', () => {
    var catalogMap = { 'item1': 10.00 };
    var items = [{ item_id: 'item1', name: 'Wine Kit', quantity: 2, rate: 999 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.lineItems[0].rate).toBe(10.00);
    expect(result.orderTotal).toBe(20.00);
  });

  test('uses client-supplied rate when catalog unavailable', () => {
    var items = [{ item_id: 'item1', name: 'Wine Kit', quantity: 2, rate: 14.99 }];
    var result = buildLineItems(items, {}, false);
    expect(result.lineItems[0].rate).toBe(14.99);
    expect(result.orderTotal).toBe(29.98);
  });

  test('applies percentage discount to effective rate', () => {
    var catalogMap = { 'item1': 100 };
    var items = [{ item_id: 'item1', name: 'Kit', quantity: 1, rate: 100, discount: 10 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.lineItems[0].discount).toBe('10%');
    expect(result.orderTotal).toBe(90);
  });

  test('discount field absent when discount is 0', () => {
    var catalogMap = { 'item1': 50 };
    var items = [{ item_id: 'item1', name: 'Kit', quantity: 1, rate: 50, discount: 0 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.lineItems[0].discount).toBeUndefined();
  });

  test('discount field absent when discount not provided', () => {
    var catalogMap = { 'item1': 50 };
    var items = [{ item_id: 'item1', name: 'Kit', quantity: 1, rate: 50 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.lineItems[0].discount).toBeUndefined();
  });

  test('multiple items accumulate into orderTotal', () => {
    var catalogMap = { 'a': 10, 'b': 20 };
    var items = [
      { item_id: 'a', name: 'A', quantity: 2, rate: 0 },
      { item_id: 'b', name: 'B', quantity: 1, rate: 0 }
    ];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.orderTotal).toBe(40.00);
  });

  test('orderTotal rounded to 2 decimal places', () => {
    // 3 × 0.1 = 0.30000000000000004 in floating point — must round to 0.30
    var items = [{ item_id: 'x', name: 'X', quantity: 3, rate: 0.1 }];
    var result = buildLineItems(items, {}, false);
    expect(result.orderTotal).toBe(0.30);
  });

  test('invalid quantity coerced to 1', () => {
    var items = [{ item_id: 'x', name: 'X', quantity: 0, rate: 10 }];
    var result = buildLineItems(items, {}, false);
    expect(result.lineItems[0].quantity).toBe(1);
    expect(result.orderTotal).toBe(10);
  });

  test('invalid rate coerced to 0 when catalog unavailable', () => {
    var items = [{ item_id: 'x', name: 'X', quantity: 1, rate: 'bad' }];
    var result = buildLineItems(items, {}, false);
    expect(result.lineItems[0].rate).toBe(0);
    expect(result.orderTotal).toBe(0);
  });

  test('preserves item_id and name on each line item', () => {
    var catalogMap = { 'sku-99': 25 };
    var items = [{ item_id: 'sku-99', name: 'Pinot Noir Kit', quantity: 1, rate: 0 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.lineItems[0].item_id).toBe('sku-99');
    expect(result.lineItems[0].name).toBe('Pinot Noir Kit');
  });

  test('empty name falls back to empty string', () => {
    var items = [{ item_id: 'x', quantity: 1, rate: 5 }];
    var result = buildLineItems(items, {}, false);
    expect(result.lineItems[0].name).toBe('');
  });

  test('empty cart returns zero total', () => {
    var result = buildLineItems([], {}, true);
    expect(result.lineItems).toHaveLength(0);
    expect(result.orderTotal).toBe(0);
  });

  test('25% discount on $80 item = $60', () => {
    var catalogMap = { 'k': 80 };
    var items = [{ item_id: 'k', name: 'Kit', quantity: 1, rate: 80, discount: 25 }];
    var result = buildLineItems(items, catalogMap, true);
    expect(result.orderTotal).toBe(60);
  });
});

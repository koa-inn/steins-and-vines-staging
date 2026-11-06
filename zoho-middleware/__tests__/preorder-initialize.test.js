'use strict';

// Phase 100 Plan 06 -- POST /api/preorder/initialize + server plumbing.

jest.mock('../lib/zohoAuth', function () {
  return { init: jest.fn().mockResolvedValue(), isAuthenticated: jest.fn().mockReturnValue(true) };
});
jest.mock('../lib/validateEnv', function () { return jest.fn(); });
jest.mock('../lib/checkRedis', function () { return jest.fn().mockResolvedValue(); });
jest.mock('../lib/checkMailer', function () { return jest.fn(); });
jest.mock('../lib/brewpad-integration', function () {
  return { syncBatch: jest.fn(), init: jest.fn(), createBatchesFromSale: jest.fn() };
});
jest.mock('node-cron', function () { return { schedule: jest.fn() }; });
jest.mock('@sentry/node', function () {
  return { init: jest.fn(), setupExpressErrorHandler: jest.fn(), captureException: jest.fn() };
});
jest.mock('../lib/mailerlite', function () {
  return { isConfigured: jest.fn().mockReturnValue(false), addSubscriber: jest.fn().mockResolvedValue() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/inventory-ledger', function () {
  return { decrementStock: jest.fn().mockResolvedValue() };
});
jest.mock('../lib/helcim', function () {
  return {
    isEnabled: jest.fn().mockReturnValue(true),
    initializeCheckout: jest.fn(),
    getDepositAmount: jest.fn().mockReturnValue(10000),
    voidTransaction: jest.fn().mockResolvedValue({ ok: true }),
    getTerminalDiagnostics: jest.fn().mockReturnValue({}),
    getDeviceCode: jest.fn().mockReturnValue(''),
    init: jest.fn(),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    getCardTransactionById: jest.fn()
  };
});
jest.mock('../lib/zoho-api', function () { return { zohoPost: jest.fn(), zohoGet: jest.fn() }; });
jest.mock('../lib/cache', function () {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    acquireLock: jest.fn().mockResolvedValue(true),
    isConnected: jest.fn().mockReturnValue(false),
    init: jest.fn().mockResolvedValue(),
    getClient: jest.fn().mockResolvedValue(null)
  };
});
jest.mock('../lib/mailer', function () {
  return {
    sendReservationNotification: jest.fn().mockResolvedValue(),
    sendOfflineOrderNotification: jest.fn().mockResolvedValue(),
    sendVoidFailureAlert: jest.fn().mockResolvedValue(),
    sendCustomerConfirmation: jest.fn().mockResolvedValue(),
    sendPreorderCleanupAlert: jest.fn().mockResolvedValue()
  };
});
jest.mock('axios', function () { return { post: jest.fn().mockResolvedValue({ data: { ok: true } }) }; });

process.env.API_SECRET_KEY = 'test-key';

var request = require('supertest');
var app = require('../server');
process.env.RECAPTCHA_SECRET_KEY = '';

var helcimLib = require('../lib/helcim');
var cache = require('../lib/cache');
var zohoAuth = require('../lib/zohoAuth');

var EMBER = '109900000001719001';
var REFERER = 'https://staging.steinsandvines.ca/limited-releases';

function post(path, body) {
  return request(app).post(path).set('Referer', REFERER).send(body);
}

describe('POST /api/preorder/initialize', function () {
  var savedFlag;
  beforeEach(function () {
    jest.clearAllMocks();
    savedFlag = process.env.PREORDER_DEPOSITS_ENABLED;
    process.env.PREORDER_DEPOSITS_ENABLED = 'true';
    process.env.RECAPTCHA_SECRET_KEY = '';
    cache.set.mockResolvedValue('OK');
    zohoAuth.isAuthenticated.mockReturnValue(true);
    helcimLib.initializeCheckout.mockResolvedValue({ checkoutToken: 'ct-1', secretToken: 'st-1' });
  });
  afterEach(function () {
    if (savedFlag === undefined) delete process.env.PREORDER_DEPOSITS_ENABLED;
    else process.env.PREORDER_DEPOSITS_ENABLED = savedFlag;
  });

  test('503 when the kill switch is unset or not exactly "true"', async function () {
    delete process.env.PREORDER_DEPOSITS_ENABLED;
    var res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 2 }] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Limited release reservations are not open yet.');
    process.env.PREORDER_DEPOSITS_ENABLED = 'false';
    res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 2 }] });
    expect(res.status).toBe(503);
    expect(helcimLib.initializeCheckout).not.toHaveBeenCalled();
  });

  test('valid basket binds a nonce, stores it for 1h and returns the contract', async function () {
    var res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 2 }] });
    expect(res.status).toBe(200);
    expect(helcimLib.initializeCheckout).toHaveBeenCalledWith(100, 'CAD',
      { invoiceNumber: expect.stringMatching(/^LR-[0-9a-f]{16}$/) });
    var nonce = helcimLib.initializeCheckout.mock.calls[0][2].invoiceNumber;
    expect(cache.set).toHaveBeenCalledWith('preorder:nonce:' + nonce,
      expect.objectContaining({ amount: 100, lines: [{ item_id: EMBER, qty: 2 }] }), 3600);
    expect(res.body).toEqual({
      checkoutToken: 'ct-1', secretToken: 'st-1', invoice_number: nonce, deposit_total: 100, kit_count: 2
    });
  });

  test('invalid baskets are 400 and never reach Helcim', async function () {
    var res = await post('/api/preorder/initialize', { items: [{ item_id: 'nope', qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown kit');
    res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 11 }] });
    expect(res.status).toBe(400);
    expect(helcimLib.initializeCheckout).not.toHaveBeenCalled();
  });

  test('a sold-out kit is 400 with its name and never reaches Helcim', async function () {
    var res = await post('/api/preorder/initialize', { items: [{ item_id: '109900000001719012', qty: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Aria is sold out');
    expect(helcimLib.initializeCheckout).not.toHaveBeenCalled();
  });

  test('reCAPTCHA failure is 400 (production, no secret fails closed)', async function () {
    var prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      var res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 1 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Request could not be verified. Please try again.');
      expect(helcimLib.initializeCheckout).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test('Helcim failure is 502 and no nonce is stored', async function () {
    helcimLib.initializeCheckout.mockRejectedValue(new Error('boom'));
    var res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 1 }] });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Payment initialization failed' });
    expect(cache.set).not.toHaveBeenCalled();
  });

  test('nonce store failure is 503', async function () {
    cache.set.mockRejectedValue(new Error('redis down'));
    var res = await post('/api/preorder/initialize', { items: [{ item_id: EMBER, qty: 1 }] });
    expect(res.status).toBe(503);
  });
});

describe('preorder server plumbing', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    delete process.env.PREORDER_DEPOSITS_ENABLED;
    zohoAuth.isAuthenticated.mockReturnValue(true);
  });

  test('keyless: initialize with no API key and an allowed Referer is not 401/403', async function () {
    var res = await post('/api/preorder/initialize', { items: [] });
    expect([401, 403]).not.toContain(res.status);
    expect(res.status).toBe(503);
  });

  test('an unrelated keyed POST without a key is still rejected', async function () {
    var res = await post('/api/pos/sale', {});
    expect([401, 403]).toContain(res.status);
  });

  test('disallowed Referer is rejected by the existing guard', async function () {
    var res = await request(app).post('/api/preorder/initialize')
      .set('Referer', 'https://evil.example.com/').send({ items: [] });
    expect(res.status).toBe(403);
  });

  test('Zoho offline: deposit reaches the route (not the generic 401)', async function () {
    zohoAuth.isAuthenticated.mockReturnValue(false);
    var res = await post('/api/preorder/deposit', {});
    expect(res.status).toBe(400);
    expect(res.body.voided).toBe(false);
    var init = await post('/api/preorder/initialize', { items: [] });
    expect(init.status).toBe(401);
  });

  test('paymentLimiter is mounted on /api/preorder', function () {
    var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    expect(src).toContain("app.use('/api/preorder', paymentLimiter)");
  });
});

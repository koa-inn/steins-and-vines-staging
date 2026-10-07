'use strict';

// Phase 86-12 (D-01, D-20): POST /auth/google governed by staffAccess.resolve.
// Mock roster mirrors auth-google-route.test.js.

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
jest.mock('../lib/inventory-ledger', function () { return { decrementStock: jest.fn().mockResolvedValue() }; });
jest.mock('../lib/zoho-api', function () {
  return {
    zohoPost: jest.fn().mockResolvedValue({}),
    zohoGet: jest.fn().mockResolvedValue({ salesorders: [] }),
    zohoPut: jest.fn().mockResolvedValue({}),
    inventoryGet: jest.fn().mockResolvedValue({}),
    inventoryPut: jest.fn().mockResolvedValue({}),
    ZOHO_INVENTORY_BASE: 'https://inventory.zoho.com/api/v1'
  };
});
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
    sendCustomerConfirmation: jest.fn().mockResolvedValue()
  };
});
jest.mock('axios', function () { return { post: jest.fn().mockResolvedValue({ data: { ok: true } }) }; });

var mockVerifyStaffAccessToken = jest.fn();
jest.mock('../lib/googleVerify', function () {
  return { verifyStaffAccessToken: mockVerifyStaffAccessToken };
});

var mockCreateSession = jest.fn();
jest.mock('../lib/session', function () {
  return {
    createSession: mockCreateSession,
    getSession: jest.fn(),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn()
  };
});

var mockMode = 'sheets';
var mockQuery = jest.fn();
jest.mock('../lib/store-flag', function () {
  return {
    resolveStoreMode: function () { return mockMode; },
    validateStoreFlags: function () { return {}; }
  };
});
jest.mock('../lib/db', function () {
  return {
    query: function () { return mockQuery.apply(null, arguments); },
    isConfigured: function () { return true; }
  };
});

process.env.API_SECRET_KEY = 'test-secret-key';
process.env.STAFF_EMAILS = 'env@steinsandvines.ca';

var request = require('supertest');
var app = require('../server');
var staffAccess = require('../lib/staff-access');

function signIn(email) {
  mockVerifyStaffAccessToken.mockResolvedValue(email);
  return request(app).post('/auth/google').send({ access_token: 'tok' });
}

describe('POST /auth/google with staff allowlist', function () {
  beforeEach(function () {
    jest.clearAllMocks();
    staffAccess.clearCache();
    mockMode = 'sheets';
    mockCreateSession.mockResolvedValue('abcd'.repeat(16));
  });

  test('sheets mode: env member -> 200 with unchanged body', async function () {
    var res = await signIn('env@steinsandvines.ca');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authorized: true, email: 'env@steinsandvines.ca', token: 'abcd'.repeat(16) });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('sheets mode: non-member -> 403', async function () {
    var res = await signIn('other@example.com');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ authorized: false });
  });

  test('postgres mode: staff row but not in STAFF_EMAILS -> 200', async function () {
    mockMode = 'postgres';
    mockQuery.mockResolvedValue({ rows: [{ role: 'staff' }] });
    var res = await signIn('row@example.com');
    expect(res.status).toBe(200);
    expect(mockCreateSession).toHaveBeenCalledWith('row@example.com');
  });

  test('postgres mode: in neither -> 403', async function () {
    mockMode = 'postgres';
    mockQuery.mockResolvedValue({ rows: [] });
    var res = await signIn('nobody@example.com');
    expect(res.status).toBe(403);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test('postgres mode: db down + non-env -> 403', async function () {
    mockMode = 'postgres';
    mockQuery.mockRejectedValue(new Error('down'));
    var res = await signIn('row@example.com');
    expect(res.status).toBe(403);
  });

  test('postgres mode: db down + env member -> 200', async function () {
    mockMode = 'postgres';
    mockQuery.mockRejectedValue(new Error('down'));
    var res = await signIn('env@steinsandvines.ca');
    expect(res.status).toBe(200);
  });
});

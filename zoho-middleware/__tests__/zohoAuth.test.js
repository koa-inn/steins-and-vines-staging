'use strict';

const { EventEmitter } = require('events');

// Mock cache before any module loads
jest.mock('../lib/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  acquireLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(undefined)
}));

// Mock https — factory runs fresh after each resetModules
jest.mock('https', () => ({
  request: jest.fn()
}));

var KEY_ENV = 'REDIS_ENCRYPTION_KEY';
var VALID_KEY = 'aa'.repeat(32); // 64 hex chars = 32 bytes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up https.request to simulate a successful Zoho token response.
 * Uses synchronous EventEmitter so no fake timers are needed for the I/O.
 */
function mockHttpsSuccess(https, responseData) {
  https.request.mockImplementation(function (opts, callback) {
    var req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(function () {
      var res = new EventEmitter();
      callback(res);  // registers data/end listeners inside postToken
      res.emit('data', Buffer.from(JSON.stringify(responseData)));
      res.emit('end');
    });
    return req;
  });
}

/**
 * Set up https.request to simulate a network-level error.
 */
function mockHttpsNetworkError(https, err) {
  https.request.mockImplementation(function () {
    var req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(function () {
      req.emit('error', err);
    });
    return req;
  });
}

// ---------------------------------------------------------------------------
// encrypt / decrypt — with key configured
// ---------------------------------------------------------------------------

describe('encrypt / decrypt — with key configured', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    process.env[KEY_ENV] = VALID_KEY;
    zohoAuth = require('../lib/zohoAuth');
  });

  afterAll(() => {
    delete process.env[KEY_ENV];
  });

  test('roundtrip: decrypt(encrypt(text)) === original plaintext', () => {
    var plaintext = 'my-secret-refresh-token';
    var ciphertext = zohoAuth.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(zohoAuth.decrypt(ciphertext)).toBe(plaintext);
  });

  test('encrypt produces iv:tag:hex format (3 colon-separated parts)', () => {
    var parts = zohoAuth.encrypt('test').split(':');
    expect(parts).toHaveLength(3);
  });

  test('each encrypt call produces a different ciphertext (random IV)', () => {
    var a = zohoAuth.encrypt('same text');
    var b = zohoAuth.encrypt('same text');
    expect(a).not.toBe(b);
  });

  test('roundtrip works for empty string', () => {
    var ct = zohoAuth.encrypt('');
    expect(zohoAuth.decrypt(ct)).toBe('');
  });

  test('roundtrip works for long tokens', () => {
    var token = 'x'.repeat(500);
    expect(zohoAuth.decrypt(zohoAuth.encrypt(token))).toBe(token);
  });

  test('decrypt returns null for corrupted auth tag', () => {
    var ct = zohoAuth.encrypt('data');
    var parts = ct.split(':');
    var flipped = (parts[1][0] === '0') ? 'f' : '0';
    parts[1] = flipped + flipped + parts[1].slice(2);
    var corrupted = parts.join(':');
    expect(zohoAuth.decrypt(corrupted)).toBeNull();
  });

  test('decrypt returns ciphertext unchanged if no colons (plaintext legacy)', () => {
    var legacy = 'my-old-unencrypted-token';
    expect(zohoAuth.decrypt(legacy)).toBe(legacy);
  });

  test('decrypt returns ciphertext if split gives wrong number of parts', () => {
    var twoColons = 'a:b';
    expect(zohoAuth.decrypt(twoColons)).toBe(twoColons);
  });
});

// ---------------------------------------------------------------------------
// encrypt / decrypt — without key configured
// ---------------------------------------------------------------------------

describe('encrypt / decrypt — without key configured', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    zohoAuth = require('../lib/zohoAuth');
  });

  test('encrypt is a no-op (returns plaintext unchanged)', () => {
    expect(zohoAuth.encrypt('my-token')).toBe('my-token');
  });

  test('decrypt is a passthrough (returns input unchanged)', () => {
    expect(zohoAuth.decrypt('some-value')).toBe('some-value');
    expect(zohoAuth.decrypt('a:b:c')).toBe('a:b:c');
  });
});

// ---------------------------------------------------------------------------
// accountsBase (tested via getAuthorizationUrl)
// ---------------------------------------------------------------------------

describe('accountsBase — .com default', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    delete process.env.ZOHO_DOMAIN;
    process.env.ZOHO_CLIENT_ID = 'client-1';
    process.env.ZOHO_REDIRECT_URI = 'https://example.com/cb';
    zohoAuth = require('../lib/zohoAuth');
  });

  test('uses accounts.zoho.com when ZOHO_DOMAIN not set', () => {
    expect(zohoAuth.getAuthorizationUrl()).toContain('accounts.zoho.com');
  });

  test('getAuthorizationUrl includes all required OAuth params', () => {
    var url = zohoAuth.getAuthorizationUrl();
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=client-1');
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    expect(url).toContain('/oauth/v2/auth');
  });
});

describe('accountsBase — .ca domain', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.ca';
    process.env.ZOHO_CLIENT_ID = 'client-ca';
    process.env.ZOHO_REDIRECT_URI = 'https://example.com/cb';
    zohoAuth = require('../lib/zohoAuth');
  });

  afterAll(() => { delete process.env.ZOHO_DOMAIN; });

  test('uses accounts.zohocloud.ca for .ca domain', () => {
    expect(zohoAuth.getAuthorizationUrl()).toContain('accounts.zohocloud.ca');
  });
});

describe('accountsBase — .eu domain', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.eu';
    process.env.ZOHO_CLIENT_ID = 'client-eu';
    process.env.ZOHO_REDIRECT_URI = 'https://example.com/cb';
    zohoAuth = require('../lib/zohoAuth');
  });

  afterAll(() => { delete process.env.ZOHO_DOMAIN; });

  test('uses accounts.zoho.eu for .eu domain', () => {
    expect(zohoAuth.getAuthorizationUrl()).toContain('accounts.zoho.eu');
  });
});

describe('accountsBase — unknown domain fallback', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.xyz';
    process.env.ZOHO_CLIENT_ID = 'client-xyz';
    process.env.ZOHO_REDIRECT_URI = 'https://example.com/cb';
    zohoAuth = require('../lib/zohoAuth');
  });

  afterAll(() => { delete process.env.ZOHO_DOMAIN; });

  test('builds dynamic URL for unknown domain', () => {
    expect(zohoAuth.getAuthorizationUrl()).toContain('accounts.zoho.xyz');
  });
});

// ---------------------------------------------------------------------------
// postToken / exchangeCode
// ---------------------------------------------------------------------------

describe('exchangeCode', () => {
  var zohoAuth, https, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    process.env.ZOHO_REDIRECT_URI = 'https://example.com/cb';
    https = require('https');
    cache = require('../lib/cache');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('resolves with tokens object on success', async () => {
    mockHttpsSuccess(https, { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });

    var result = await zohoAuth.exchangeCode('auth-code-123');

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('new-refresh');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  test('persists refresh token to cache', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });

    await zohoAuth.exchangeCode('code');

    expect(cache.set).toHaveBeenCalledWith('zoho:refresh_token', expect.any(String), expect.any(Number));
  });

  test('also persists access token and expiry to cache', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });

    await zohoAuth.exchangeCode('code');

    var keys = cache.set.mock.calls.map(function (c) { return c[0]; });
    expect(keys).toContain('zoho:access-token');
    expect(keys).toContain('zoho:token-expiry');
  });

  test('rejects when Zoho response contains error field', async () => {
    mockHttpsSuccess(https, { error: 'invalid_code' });

    await expect(zohoAuth.exchangeCode('bad-code')).rejects.toThrow('invalid_code');
  });

  test('rejects when response is not valid JSON', async () => {
    https.request.mockImplementation(function (opts, callback) {
      var req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(function () {
        var res = new EventEmitter();
        callback(res);
        res.emit('data', Buffer.from('not-json{{'));
        res.emit('end');
      });
      return req;
    });

    await expect(zohoAuth.exchangeCode('code')).rejects.toThrow('Failed to parse');
  });

  test('rejects on network-level error', async () => {
    mockHttpsNetworkError(https, new Error('ECONNREFUSED'));

    await expect(zohoAuth.exchangeCode('code')).rejects.toThrow('ECONNREFUSED');
  });

  test('https.request is called with POST to /oauth/v2/token', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });

    await zohoAuth.exchangeCode('my-code');

    var opts = https.request.mock.calls[0][0];
    expect(opts.method).toBe('POST');
    expect(opts.hostname).toContain('zoho.com');
    expect(opts.path).toContain('/oauth/v2/token');
  });

  test('schedules auto-refresh timer after success', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });

    await zohoAuth.exchangeCode('code');

    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  var zohoAuth, https, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    https = require('https');
    cache = require('../lib/cache');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('rejects immediately when no refresh token is set', async () => {
    await expect(zohoAuth.refreshAccessToken()).rejects.toThrow('No refresh token');
  });

  test('refreshes token when lock is acquired', async () => {
    zohoAuth.setRefreshToken('my-refresh');
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsSuccess(https, { access_token: 'refreshed', expires_in: 3600 });

    var result = await zohoAuth.refreshAccessToken();

    expect(result.accessToken).toBe('refreshed');
    expect(cache.releaseLock).toHaveBeenCalled();
  });

  test('when lock is NOT acquired, waits 1.5s then calls getAccessToken', async () => {
    // Advance time to expire any in-memory token left by the previous test
    jest.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    zohoAuth.setRefreshToken('my-refresh');
    cache.acquireLock.mockResolvedValue(false);
    // When getAccessToken runs after the wait, it will find a fresh Redis token
    var futureExpiry = Date.now() + 20 * 60 * 1000;
    cache.get.mockImplementation(function (key) {
      if (key === 'zoho:access-token') return Promise.resolve('from-redis');
      if (key === 'zoho:token-expiry') return Promise.resolve(String(futureExpiry));
      return Promise.resolve(null);
    });

    var promise = zohoAuth.refreshAccessToken();
    await jest.advanceTimersByTimeAsync(1500);
    var result = await promise;

    expect(result).toBe('from-redis');
  });

  test('releases lock even when postToken fails', async () => {
    zohoAuth.setRefreshToken('my-refresh');
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsSuccess(https, { error: 'token_expired' });

    await expect(zohoAuth.refreshAccessToken()).rejects.toThrow('token_expired');
    expect(cache.releaseLock).toHaveBeenCalled();
  });

  test('updates access token and expiry in cache after refresh', async () => {
    zohoAuth.setRefreshToken('my-refresh');
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsSuccess(https, { access_token: 'new-tok', expires_in: 3600 });

    await zohoAuth.refreshAccessToken();

    var keys = cache.set.mock.calls.map(function (c) { return c[0]; });
    expect(keys).toContain('zoho:access-token');
    expect(keys).toContain('zoho:token-expiry');
  });
});

// ---------------------------------------------------------------------------
// getAccessToken
// ---------------------------------------------------------------------------

describe('getAccessToken — unauthenticated', () => {
  var zohoAuth, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    cache = require('../lib/cache');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    cache.get.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('rejects when no tokens exist', async () => {
    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Not authenticated');
  });

  test('falls through to reject when Redis token is stale and no refresh token', async () => {
    var pastExpiry = Date.now() - 1000;
    cache.get.mockImplementation(function (key) {
      if (key === 'zoho:access-token') return Promise.resolve('old-tok');
      if (key === 'zoho:token-expiry') return Promise.resolve(String(pastExpiry));
      return Promise.resolve(null);
    });

    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Not authenticated');
  });

  test('rejects when Redis token is absent', async () => {
    cache.get.mockResolvedValue(null);

    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Not authenticated');
  });

  test('returns Redis token when in-memory stale but Redis is fresh', async () => {
    var futureExpiry = Date.now() + 20 * 60 * 1000;
    cache.get.mockImplementation(function (key) {
      if (key === 'zoho:access-token') return Promise.resolve('redis-tok');
      if (key === 'zoho:token-expiry') return Promise.resolve(String(futureExpiry));
      return Promise.resolve(null);
    });

    var token = await zohoAuth.getAccessToken();

    expect(token).toBe('redis-tok');
  });

  test('falls through gracefully when cache.get throws synchronously', async () => {
    // Line 278: the try/catch around cache.get — if it throws (not rejects), return null
    // Advance time to expire any in-memory token hydrated by the previous test
    jest.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    cache.get.mockImplementation(function () { throw new Error('Redis down'); });

    // tokens.accessToken may be stale (non-null), tokens.refreshToken = null
    // cache.get throws → catch returns null → hits line 289 "not authenticated"
    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Not authenticated');
  });

  test('rejects with second "not authenticated" when accessToken is stale but refreshToken absent', async () => {
    // Hydrate tokens.accessToken via a Redis hit first
    var nearFuture = Date.now() + 20 * 60 * 1000;
    cache.get.mockImplementation(function (key) {
      if (key === 'zoho:access-token') return Promise.resolve('stale-tok');
      if (key === 'zoho:token-expiry') return Promise.resolve(String(nearFuture));
      return Promise.resolve(null);
    });
    await zohoAuth.getAccessToken();  // hydrates tokens.accessToken = 'stale-tok'

    // Now make the token appear expired and Redis return nothing
    jest.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    cache.get.mockResolvedValue(null);

    // tokens.accessToken is non-null but stale; tokens.refreshToken is null
    // → hits line 289: second "not authenticated" check
    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Not authenticated');
  });
});

describe('getAccessToken — with fresh in-memory token', () => {
  var zohoAuth, https, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    cache = require('../lib/cache');
    https = require('https');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns in-memory token directly when fresh (no Redis lookup)', async () => {
    mockHttpsSuccess(https, { access_token: 'fresh-tok', refresh_token: 'ref', expires_in: 3600 });
    await zohoAuth.exchangeCode('code');
    jest.clearAllMocks();

    var token = await zohoAuth.getAccessToken();

    expect(token).toBe('fresh-tok');
    expect(cache.get).not.toHaveBeenCalled();
  });

  test('coalesces concurrent refresh calls to a single request', async () => {
    // Advance time so any in-memory token from the previous test is stale
    jest.setSystemTime(Date.now() + 4 * 60 * 60 * 1000);
    // Set up state: in-memory token is stale, refresh token exists
    zohoAuth.setRefreshToken('my-refresh');
    cache.get.mockResolvedValue(null);

    var callCount = 0;
    https.request.mockImplementation(function (opts, callback) {
      callCount++;
      var req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(function () {
        var res = new EventEmitter();
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify({ access_token: 'coalesced', expires_in: 3600 })));
        res.emit('end');
      });
      return req;
    });
    cache.acquireLock.mockResolvedValue(true);

    // Two concurrent calls — should coalesce to one https request
    var [t1, t2] = await Promise.all([zohoAuth.getAccessToken(), zohoAuth.getAccessToken()]);

    expect(t1).toBe('coalesced');
    expect(t2).toBe('coalesced');
    expect(callCount).toBe(1);
  });

  test('_refreshPromise error handler clears promise and re-throws', async () => {
    // Lines 298-299: when refreshAccessToken fails inside _refreshPromise
    jest.setSystemTime(Date.now() + 8 * 60 * 60 * 1000); // expire any cached token
    zohoAuth.setRefreshToken('my-refresh');
    cache.get.mockResolvedValue(null);
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsNetworkError(https, new Error('Refresh network error'));

    await expect(zohoAuth.getAccessToken()).rejects.toThrow('Refresh network error');
  });
});

// ---------------------------------------------------------------------------
// isAuthenticated
// ---------------------------------------------------------------------------

describe('isAuthenticated', () => {
  var zohoAuth, https;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    https = require('https');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns false on fresh module (no tokens)', () => {
    expect(zohoAuth.isAuthenticated()).toBe(false);
  });

  test('returns true after exchangeCode succeeds', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    await zohoAuth.exchangeCode('code');
    expect(zohoAuth.isAuthenticated()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setRefreshToken
// ---------------------------------------------------------------------------

describe('setRefreshToken', () => {
  var zohoAuth, https, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    https = require('https');
    cache = require('../lib/cache');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('stored refresh token is used by refreshAccessToken', async () => {
    zohoAuth.setRefreshToken('stored-rt');
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsSuccess(https, { access_token: 'from-stored-rt', expires_in: 3600 });

    var result = await zohoAuth.refreshAccessToken();

    expect(result.accessToken).toBe('from-stored-rt');
  });
});

// ---------------------------------------------------------------------------
// scheduleRefresh (via exchangeCode side-effect)
// ---------------------------------------------------------------------------

describe('scheduleRefresh', () => {
  var zohoAuth, https, cache;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    https = require('https');
    cache = require('../lib/cache');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('registers a setTimeout after exchangeCode', async () => {
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600 });
    await zohoAuth.exchangeCode('code');
    expect(jest.getTimerCount()).toBeGreaterThan(0);
  });

  test('enforces minimum 10s delay for very short-lived tokens', async () => {
    // expires_in=6 → (6000 - 300000) < 0 → clipped to 10000ms
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 6 });
    var consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await zohoAuth.exchangeCode('code');
    // Clear the https call from exchangeCode itself; now verify timer hasn't fired yet
    https.request.mockClear();
    await jest.advanceTimersByTimeAsync(9999);
    // Refresh timer fires at 10000ms minimum — 9999ms should not have triggered it
    expect(https.request).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  test('logs error when auto-refresh timer fires and refresh fails (lines 241-242)', async () => {
    // Schedule timer at minimum 10s (expires_in=6)
    mockHttpsSuccess(https, { access_token: 'tok', refresh_token: 'ref', expires_in: 6 });
    var logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await zohoAuth.exchangeCode('code');
    logSpy.mockRestore();

    // Now set up postToken to fail when the auto-refresh timer fires
    cache.acquireLock.mockResolvedValue(true);
    mockHttpsNetworkError(https, new Error('auto-refresh-failed'));
    var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Fire the timer (fires at 10000ms)
    await jest.advanceTimersByTimeAsync(10001);

    expect(errSpy).toHaveBeenCalledWith(
      '[zoho-auth] Auto-refresh failed:',
      'auto-refresh-failed'
    );
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe('init', () => {
  var zohoAuth, cache, https;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    process.env.ZOHO_DOMAIN = '.com';
    process.env.ZOHO_CLIENT_ID = 'cid';
    process.env.ZOHO_CLIENT_SECRET = 'csec';
    cache = require('../lib/cache');
    https = require('https');
    zohoAuth = require('../lib/zohoAuth');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns null and logs message when no saved refresh token', async () => {
    cache.get.mockResolvedValue(null);
    var logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    var result = await zohoAuth.init();

    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No saved refresh token'));
    logSpy.mockRestore();
  });

  test('loads token from Redis, decrypts, and refreshes', async () => {
    cache.get.mockResolvedValue('saved-refresh-token');
    mockHttpsSuccess(https, { access_token: 'init-tok', expires_in: 3600 });
    var logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await zohoAuth.init();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Refresh token loaded from Redis'));
    logSpy.mockRestore();
  });

  test('handles startup refresh failure gracefully (logs error, does not throw)', async () => {
    cache.get.mockResolvedValue('bad-token');
    mockHttpsSuccess(https, { error: 'invalid_token' });
    var errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    var logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(zohoAuth.init()).resolves.not.toThrow();

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Auto-refresh on startup failed'),
      expect.any(String)
    );
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

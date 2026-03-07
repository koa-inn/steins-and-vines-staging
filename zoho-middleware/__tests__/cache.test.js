'use strict';

jest.mock('redis', () => ({
  createClient: jest.fn()
}));

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

describe('cache', () => {
  var cache;
  var mockClient;

  beforeEach(() => {
    jest.resetModules();

    mockClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn()
    };

    var redisMock = require('redis');
    redisMock.createClient.mockReturnValue(mockClient);

    cache = require('../lib/cache');
  });

  describe('when disconnected (default state)', () => {
    test('isConnected() returns false', () => {
      expect(cache.isConnected()).toBe(false);
    });

    test('get() returns null without calling redis', async () => {
      var result = await cache.get('mykey');
      expect(result).toBeNull();
      expect(mockClient.get).not.toHaveBeenCalled();
    });

    test('set() resolves without calling redis', async () => {
      await expect(cache.set('key', 'val', 60)).resolves.toBeUndefined();
      expect(mockClient.set).not.toHaveBeenCalled();
    });

    test('del() resolves without calling redis', async () => {
      await expect(cache.del('key')).resolves.toBeUndefined();
      expect(mockClient.del).not.toHaveBeenCalled();
    });

    test('acquireLock() returns true (fallback when disconnected)', async () => {
      var result = await cache.acquireLock('lock-key', 30);
      expect(result).toBe(true);
    });

    test('releaseLock() resolves without calling redis', async () => {
      await expect(cache.releaseLock('lock-key')).resolves.toBeUndefined();
    });
  });

  describe('when connected (after init)', () => {
    beforeEach(async () => {
      await cache.init();
    });

    test('isConnected() returns true', () => {
      expect(cache.isConnected()).toBe(true);
    });

    test('get() returns parsed JSON on cache hit', async () => {
      mockClient.get.mockResolvedValue(JSON.stringify({ a: 1 }));
      var result = await cache.get('key');
      expect(result).toEqual({ a: 1 });
      expect(mockClient.get).toHaveBeenCalledWith('key');
    });

    test('get() returns null on cache miss', async () => {
      mockClient.get.mockResolvedValue(null);
      expect(await cache.get('key')).toBeNull();
    });

    test('get() returns null for invalid JSON', async () => {
      mockClient.get.mockResolvedValue('not-valid-json{');
      expect(await cache.get('key')).toBeNull();
    });

    test('get() returns string values that were stored as strings', async () => {
      mockClient.get.mockResolvedValue(JSON.stringify('hello'));
      var result = await cache.get('key');
      expect(result).toBe('hello');
    });

    test('set() calls redis with JSON-encoded value and TTL', async () => {
      await cache.set('mykey', { x: 1 }, 300);
      expect(mockClient.set).toHaveBeenCalledWith('mykey', JSON.stringify({ x: 1 }), { EX: 300 });
    });

    test('set() works with primitive values', async () => {
      await cache.set('str', 'hello', 60);
      expect(mockClient.set).toHaveBeenCalledWith('str', JSON.stringify('hello'), { EX: 60 });
    });

    test('del() calls redis del with the key', async () => {
      await cache.del('mykey');
      expect(mockClient.del).toHaveBeenCalledWith('mykey');
    });

    test('acquireLock() returns true when redis SET NX succeeds', async () => {
      mockClient.set.mockResolvedValue('OK');
      var result = await cache.acquireLock('mylock', 30);
      expect(result).toBe(true);
      expect(mockClient.set).toHaveBeenCalledWith('lock:mylock', '1', { NX: true, EX: 30 });
    });

    test('acquireLock() returns false when lock already held', async () => {
      mockClient.set.mockResolvedValue(null);  // null = NX not acquired
      var result = await cache.acquireLock('mylock', 30);
      expect(result).toBe(false);
    });
  });

  describe('graceful failure on redis errors', () => {
    beforeEach(async () => {
      await cache.init();
    });

    test('get() returns null on redis error', async () => {
      mockClient.get.mockRejectedValue(new Error('Connection reset'));
      var result = await cache.get('key');
      expect(result).toBeNull();
    });

    test('set() resolves (does not throw) on redis error', async () => {
      mockClient.set.mockRejectedValue(new Error('Connection lost'));
      await expect(cache.set('key', 'val', 60)).resolves.not.toThrow();
    });

    test('del() resolves (does not throw) on redis error', async () => {
      mockClient.del.mockRejectedValue(new Error('Broken'));
      await expect(cache.del('key')).resolves.not.toThrow();
    });
  });
});

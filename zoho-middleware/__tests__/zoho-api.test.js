'use strict';

jest.mock('../lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../lib/zohoAuth', () => ({
  getAccessToken: jest.fn().mockResolvedValue('mock-token')
}));

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn()
}));

const { withRetry } = require('../lib/zoho-api');

describe('withRetry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns result on first success', async () => {
    var fn = jest.fn().mockResolvedValue('data');
    var result = await withRetry(fn, { retries: 3, baseDelay: 300 });
    expect(result).toBe('data');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on 429 and eventually succeeds', async () => {
    var attempt = 0;
    var fn = jest.fn().mockImplementation(function () {
      attempt++;
      if (attempt < 3) {
        var err = new Error('Rate limited');
        err.response = { status: 429, headers: {} };
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    });

    var promise = withRetry(fn, { retries: 3, baseDelay: 100, factor: 2 });
    await jest.advanceTimersByTimeAsync(100);  // first retry delay
    await jest.advanceTimersByTimeAsync(200);  // second retry delay

    var result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('retries on 5xx and eventually succeeds', async () => {
    var attempt = 0;
    var fn = jest.fn().mockImplementation(function () {
      attempt++;
      if (attempt < 2) {
        var err = new Error('Service unavailable');
        err.response = { status: 503, headers: {} };
        return Promise.reject(err);
      }
      return Promise.resolve('recovered');
    });

    var promise = withRetry(fn, { retries: 2, baseDelay: 100 });
    await jest.advanceTimersByTimeAsync(100);

    var result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('retries on network errors (no response)', async () => {
    var attempt = 0;
    var fn = jest.fn().mockImplementation(function () {
      attempt++;
      if (attempt < 2) {
        return Promise.reject(new Error('Network Error'));
      }
      return Promise.resolve('back');
    });

    var promise = withRetry(fn, { retries: 2, baseDelay: 100 });
    await jest.advanceTimersByTimeAsync(100);

    var result = await promise;
    expect(result).toBe('back');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('throws immediately on 400 without retrying', async () => {
    var fn = jest.fn().mockImplementation(function () {
      var err = new Error('Bad request');
      err.response = { status: 400, headers: {} };
      return Promise.reject(err);
    });

    await expect(withRetry(fn, { retries: 3, baseDelay: 100 })).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws immediately on 401', async () => {
    var fn = jest.fn().mockImplementation(function () {
      var err = new Error('Unauthorized');
      err.response = { status: 401, headers: {} };
      return Promise.reject(err);
    });

    await expect(withRetry(fn, { retries: 3, baseDelay: 100 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('throws after exhausting retries', async () => {
    var fn = jest.fn().mockImplementation(function () {
      var err = new Error('Server error');
      err.response = { status: 503, headers: {} };
      return Promise.reject(err);
    });

    var promise = withRetry(fn, { retries: 2, baseDelay: 100, factor: 2 });
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection warning
    var assertion = expect(promise).rejects.toThrow('Server error');
    await jest.advanceTimersByTimeAsync(100);   // delay after attempt 0
    await jest.advanceTimersByTimeAsync(200);   // delay after attempt 1
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);  // initial + 2 retries
  });

  test('respects retry-after header on 429', async () => {
    var attempt = 0;
    var fn = jest.fn().mockImplementation(function () {
      attempt++;
      if (attempt < 2) {
        var err = new Error('Rate limited');
        err.response = { status: 429, headers: { 'retry-after': '5' } };
        return Promise.reject(err);
      }
      return Promise.resolve('ok');
    });

    var promise = withRetry(fn, { retries: 1, baseDelay: 100 });

    // Should wait 5000ms (from retry-after: 5), not the 100ms base delay
    await jest.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);  // not retried yet

    await jest.advanceTimersByTimeAsync(2);  // push past 5000ms

    var result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test('applies exponential backoff: delay doubles each attempt', async () => {
    var fn = jest.fn().mockImplementation(function () {
      var err = new Error('fail');
      err.response = { status: 503, headers: {} };
      return Promise.reject(err);
    });

    var promise = withRetry(fn, { retries: 2, baseDelay: 100, factor: 2 });
    var assertion = expect(promise).rejects.toThrow('fail');

    // Advance past all delays to let it exhaust retries
    await jest.advanceTimersByTimeAsync(100);   // delay 1: 100*2^0 = 100
    await jest.advanceTimersByTimeAsync(200);   // delay 2: 100*2^1 = 200

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('uses default options (retries=3, baseDelay=300, factor=2)', async () => {
    var fn = jest.fn().mockImplementation(function () {
      var err = new Error('Fail');
      err.response = { status: 503, headers: {} };
      return Promise.reject(err);
    });

    var promise = withRetry(fn);  // no opts
    var assertion = expect(promise).rejects.toThrow('Fail');
    await jest.advanceTimersByTimeAsync(300);    // attempt 0 → 300ms delay
    await jest.advanceTimersByTimeAsync(600);    // attempt 1 → 600ms delay
    await jest.advanceTimersByTimeAsync(1200);   // attempt 2 → 1200ms delay
    await assertion;
    expect(fn).toHaveBeenCalledTimes(4);  // initial + 3 retries
  });
});

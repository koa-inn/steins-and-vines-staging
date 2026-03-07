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

const {
  withRetry, zohoGet, zohoPost, zohoPut,
  inventoryGet, inventoryPost, inventoryPut,
  bookingsGet, bookingsPost,
  normalizeTimeTo24h, fetchAllItems,
  ZOHO_API_BASE, ZOHO_INVENTORY_BASE, BOOKINGS_API_BASE
} = require('../lib/zoho-api');

const zohoAuth = require('../lib/zohoAuth');
const axios = require('axios');
const log = require('../lib/logger');

beforeEach(() => {
  jest.clearAllMocks();
  zohoAuth.getAccessToken.mockResolvedValue('mock-token');
  process.env.ZOHO_ORG_ID = 'org-123';
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zoho Books API helpers
// ---------------------------------------------------------------------------

describe('Zoho Books API helpers', () => {
  test('zohoGet fetches from ZOHO_API_BASE with token + org_id', async () => {
    axios.get.mockResolvedValue({ data: { invoices: [] } });

    var result = await zohoGet('/invoices', { status: 'active' });

    expect(zohoAuth.getAccessToken).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      ZOHO_API_BASE + '/invoices',
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: expect.objectContaining({ organization_id: 'org-123', status: 'active' }),
        timeout: 15000
      })
    );
    expect(result).toEqual({ invoices: [] });
  });

  test('zohoGet merges extra params with org_id', async () => {
    axios.get.mockResolvedValue({ data: {} });
    await zohoGet('/contacts', { search_text: 'Alice' });
    var params = axios.get.mock.calls[0][1].params;
    expect(params.organization_id).toBe('org-123');
    expect(params.search_text).toBe('Alice');
  });

  test('zohoGet works with no extra params', async () => {
    axios.get.mockResolvedValue({ data: { items: [] } });
    await zohoGet('/items');
    var params = axios.get.mock.calls[0][1].params;
    expect(params.organization_id).toBe('org-123');
  });

  test('zohoPost sends body to ZOHO_API_BASE with token + org_id', async () => {
    axios.post.mockResolvedValue({ data: { invoice: { id: 'inv-1' } } });
    var body = { customer_id: 'cust-1', line_items: [] };

    var result = await zohoPost('/invoices', body);

    expect(axios.post).toHaveBeenCalledWith(
      ZOHO_API_BASE + '/invoices',
      body,
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: { organization_id: 'org-123' },
        timeout: 15000
      })
    );
    expect(result).toEqual({ invoice: { id: 'inv-1' } });
  });

  test('zohoPost calls getAccessToken', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await zohoPost('/invoices', {});
    expect(zohoAuth.getAccessToken).toHaveBeenCalledTimes(1);
  });

  test('zohoPut sends body to ZOHO_API_BASE', async () => {
    axios.put.mockResolvedValue({ data: { updated: true } });
    var body = { status: 'sent' };

    var result = await zohoPut('/invoices/inv-1', body);

    expect(axios.put).toHaveBeenCalledWith(
      ZOHO_API_BASE + '/invoices/inv-1',
      body,
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: { organization_id: 'org-123' },
        timeout: 15000
      })
    );
    expect(result).toEqual({ updated: true });
  });

  test('zohoPut calls getAccessToken', async () => {
    axios.put.mockResolvedValue({ data: {} });
    await zohoPut('/invoices/abc', {});
    expect(zohoAuth.getAccessToken).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Zoho Inventory API helpers
// ---------------------------------------------------------------------------

describe('Zoho Inventory API helpers', () => {
  test('inventoryGet fetches from ZOHO_INVENTORY_BASE with org_id', async () => {
    axios.get.mockResolvedValue({ data: { items: [{ id: 'item-1' }] } });

    var result = await inventoryGet('/items', { category: 'kit' });

    expect(axios.get).toHaveBeenCalledWith(
      ZOHO_INVENTORY_BASE + '/items',
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: expect.objectContaining({ organization_id: 'org-123', category: 'kit' }),
        timeout: 15000
      })
    );
    expect(result).toEqual({ items: [{ id: 'item-1' }] });
  });

  test('inventoryGet works with no extra params', async () => {
    axios.get.mockResolvedValue({ data: {} });
    await inventoryGet('/items');
    var params = axios.get.mock.calls[0][1].params;
    expect(params.organization_id).toBe('org-123');
  });

  test('inventoryPost sends to ZOHO_INVENTORY_BASE', async () => {
    axios.post.mockResolvedValue({ data: { item: { id: 'new-1' } } });
    var body = { name: 'test-item', rate: 29.99 };

    var result = await inventoryPost('/items', body);

    expect(axios.post).toHaveBeenCalledWith(
      ZOHO_INVENTORY_BASE + '/items',
      body,
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: { organization_id: 'org-123' },
        timeout: 15000
      })
    );
    expect(result).toEqual({ item: { id: 'new-1' } });
  });

  test('inventoryPut sends to ZOHO_INVENTORY_BASE', async () => {
    axios.put.mockResolvedValue({ data: { item: { status: 'active' } } });
    var body = { status: 'active' };

    var result = await inventoryPut('/items/item-1', body);

    expect(axios.put).toHaveBeenCalledWith(
      ZOHO_INVENTORY_BASE + '/items/item-1',
      body,
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        params: { organization_id: 'org-123' },
        timeout: 15000
      })
    );
    expect(result).toEqual({ item: { status: 'active' } });
  });
});

// ---------------------------------------------------------------------------
// Zoho Bookings API helpers
// ---------------------------------------------------------------------------

describe('Zoho Bookings API helpers', () => {
  test('bookingsGet fetches from BOOKINGS_API_BASE without org_id', async () => {
    axios.get.mockResolvedValue({ data: { appointments: [] } });

    var result = await bookingsGet('/appointments', { date: '2024-01-01' });

    var callArgs = axios.get.mock.calls[0];
    expect(callArgs[0]).toBe(BOOKINGS_API_BASE + '/appointments');
    expect(callArgs[1].headers).toEqual({ Authorization: 'Zoho-oauthtoken mock-token' });
    expect(callArgs[1].params).toEqual({ date: '2024-01-01' });
    expect(callArgs[1].params).not.toHaveProperty('organization_id');
    expect(result).toEqual({ appointments: [] });
  });

  test('bookingsGet uses empty object when no params passed', async () => {
    axios.get.mockResolvedValue({ data: {} });
    await bookingsGet('/services');
    var callArgs = axios.get.mock.calls[0];
    expect(callArgs[1].params).toEqual({});
  });

  test('bookingsGet calls getAccessToken', async () => {
    axios.get.mockResolvedValue({ data: {} });
    await bookingsGet('/appointments');
    expect(zohoAuth.getAccessToken).toHaveBeenCalledTimes(1);
  });

  test('bookingsPost sends to BOOKINGS_API_BASE without org_id', async () => {
    axios.post.mockResolvedValue({ data: { booking_id: 'bk-1' } });
    var body = { service_id: 'svc-1', customer_name: 'Alice' };

    var result = await bookingsPost('/appointments', body);

    expect(axios.post).toHaveBeenCalledWith(
      BOOKINGS_API_BASE + '/appointments',
      body,
      expect.objectContaining({
        headers: { Authorization: 'Zoho-oauthtoken mock-token' },
        timeout: 15000
      })
    );
    var callArgs = axios.post.mock.calls[0];
    expect(callArgs[2]).not.toHaveProperty('params');
    expect(result).toEqual({ booking_id: 'bk-1' });
  });

  test('bookingsPost calls getAccessToken', async () => {
    axios.post.mockResolvedValue({ data: {} });
    await bookingsPost('/appointments', {});
    expect(zohoAuth.getAccessToken).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeTimeTo24h
// ---------------------------------------------------------------------------

describe('normalizeTimeTo24h', () => {
  test('converts AM time correctly', () => {
    expect(normalizeTimeTo24h('10:00 AM')).toBe('10:00:00');
  });

  test('converts PM time correctly', () => {
    expect(normalizeTimeTo24h('2:30 PM')).toBe('14:30:00');
  });

  test('12:00 PM stays as 12 (noon)', () => {
    expect(normalizeTimeTo24h('12:00 PM')).toBe('12:00:00');
  });

  test('12:00 AM becomes 00 (midnight)', () => {
    expect(normalizeTimeTo24h('12:00 AM')).toBe('00:00:00');
  });

  test('pads single-digit hours with leading zero', () => {
    expect(normalizeTimeTo24h('9:15 AM')).toBe('09:15:00');
  });

  test('handles lowercase am/pm', () => {
    expect(normalizeTimeTo24h('3:45 pm')).toBe('15:45:00');
  });

  test('handles 11:59 PM', () => {
    expect(normalizeTimeTo24h('11:59 PM')).toBe('23:59:00');
  });

  test('passthrough for already-24h format', () => {
    expect(normalizeTimeTo24h('14:30:00')).toBe('14:30:00');
  });

  test('passthrough for unrecognized format', () => {
    expect(normalizeTimeTo24h('not-a-time')).toBe('not-a-time');
  });

  test('passthrough for empty string', () => {
    expect(normalizeTimeTo24h('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// fetchAllItems
// ---------------------------------------------------------------------------

describe('fetchAllItems', () => {
  test('returns items from a single page (no has_more_page)', async () => {
    axios.get.mockResolvedValue({
      data: {
        items: [{ id: 'item-1' }, { id: 'item-2' }],
        page_context: { has_more_page: false }
      }
    });

    var result = await fetchAllItems({ filter: 'active' });

    expect(result).toEqual([{ id: 'item-1' }, { id: 'item-2' }]);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('passes params + page + per_page to first request', async () => {
    axios.get.mockResolvedValue({
      data: { items: [], page_context: { has_more_page: false } }
    });

    await fetchAllItems({ category_id: 'cat-1' });

    var params = axios.get.mock.calls[0][1].params;
    expect(params.category_id).toBe('cat-1');
    expect(params.page).toBe(1);
    expect(params.per_page).toBe(200);
  });

  test('fetches multiple pages and concatenates all items', async () => {
    var callCount = 0;
    axios.get.mockImplementation(function () {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          data: { items: [{ id: 'p1-a' }, { id: 'p1-b' }], page_context: { has_more_page: true } }
        });
      }
      return Promise.resolve({
        data: { items: [{ id: 'p2-a' }], page_context: { has_more_page: false } }
      });
    });

    var result = await fetchAllItems({});

    expect(result).toEqual([{ id: 'p1-a' }, { id: 'p1-b' }, { id: 'p2-a' }]);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('increments page number on each subsequent fetch', async () => {
    var callCount = 0;
    axios.get.mockImplementation(function () {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          data: { items: [{ id: 'x' + callCount }], page_context: { has_more_page: true } }
        });
      }
      return Promise.resolve({
        data: { items: [{ id: 'x3' }], page_context: { has_more_page: false } }
      });
    });

    await fetchAllItems({});

    expect(axios.get.mock.calls[0][1].params.page).toBe(1);
    expect(axios.get.mock.calls[1][1].params.page).toBe(2);
    expect(axios.get.mock.calls[2][1].params.page).toBe(3);
  });

  test('handles missing items array gracefully', async () => {
    axios.get.mockResolvedValue({
      data: { page_context: { has_more_page: false } }
    });

    var result = await fetchAllItems();

    expect(result).toEqual([]);
  });

  test('handles missing page_context (no more pages)', async () => {
    axios.get.mockResolvedValue({ data: { items: [{ id: 'a' }] } });

    var result = await fetchAllItems({});

    expect(result).toEqual([{ id: 'a' }]);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('stops at MAX_PAGES (50) and logs error', async () => {
    // Always returns has_more_page: true — should stop at cap
    axios.get.mockResolvedValue({
      data: { items: [{ id: 'x' }], page_context: { has_more_page: true } }
    });

    var result = await fetchAllItems({});

    // Pages 1-50 fetched (50 calls), then page 51 triggers the cap
    expect(axios.get).toHaveBeenCalledTimes(50);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('page cap')
    );
    expect(result).toHaveLength(50); // 1 item per page × 50 pages
  }, 15000); // allow up to 15s for 50 async iterations
});

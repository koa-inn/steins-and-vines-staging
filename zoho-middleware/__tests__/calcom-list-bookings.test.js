'use strict';

jest.mock('axios');
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../lib/zoho-api', () => ({
  withRetry: jest.fn(function (fn) { return fn(); })
}));

describe('calcom.listBookings', () => {
  var calcom;
  var axios;
  var OPTS = {
    eventTypeIds: [5904690, 6028745],
    afterStart: '2026-11-02T00:00:00.000Z',
    beforeEnd: '2026-11-19T00:00:00.000Z'
  };

  beforeEach(() => {
    jest.resetModules();
    jest.mock('axios');
    jest.mock('../lib/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
    }));
    jest.mock('../lib/zoho-api', () => ({
      withRetry: jest.fn(function (fn) { return fn(); })
    }));
    process.env.CALCOM_API_KEY = 'cal_test_key_123';
    calcom = require('../lib/calcom');
    axios = require('axios');
  });

  afterEach(() => {
    delete process.env.CALCOM_API_KEY;
    jest.clearAllMocks();
  });

  test('version constants', () => {
    expect(calcom.CAL_VERSIONS.bookingsList).toBe('2026-05-01');
    expect(calcom.CAL_VERSIONS.bookings).toBe('2026-02-25');
  });

  test('first page request shape', () => {
    axios.get.mockResolvedValue({ data: { data: [{ id: 1 }], pagination: { hasMore: false, nextCursor: null } } });
    return calcom.listBookings(OPTS).then(function (res) {
      expect(axios.get).toHaveBeenCalledTimes(1);
      var call = axios.get.mock.calls[0];
      expect(call[0]).toBe('https://api.cal.com/v2/bookings');
      expect(call[1].headers['cal-api-version']).toBe('2026-05-01');
      expect(call[1].headers.Authorization).toBe('Bearer cal_test_key_123');
      expect(call[1].timeout).toBe(15000);
      expect(call[1].params).toEqual({
        status: 'upcoming',
        eventTypeIds: '5904690,6028745',
        afterStart: OPTS.afterStart,
        beforeEnd: OPTS.beforeEnd,
        sortStart: 'asc',
        limit: 100
      });
      expect(res).toEqual({ bookings: [{ id: 1 }], truncated: false });
    });
  });

  test('follows cursor pagination', () => {
    axios.get
      .mockResolvedValueOnce({ data: { data: ['a'], pagination: { hasMore: true, nextCursor: 'c2' } } })
      .mockResolvedValueOnce({ data: { data: ['b'], pagination: { hasMore: false, nextCursor: null } } });
    return calcom.listBookings(OPTS).then(function (res) {
      expect(res).toEqual({ bookings: ['a', 'b'], truncated: false });
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(axios.get.mock.calls[1][1].params.cursor).toBe('c2');
    });
  });

  test('caps at 5 pages and reports truncated', () => {
    axios.get.mockResolvedValue({ data: { data: ['x'], pagination: { hasMore: true, nextCursor: 'next' } } });
    return calcom.listBookings(OPTS).then(function (res) {
      expect(axios.get).toHaveBeenCalledTimes(5);
      expect(res.truncated).toBe(true);
      expect(res.bookings).toHaveLength(5);
    });
  });

  test('empty eventTypeIds makes no call', () => {
    return calcom.listBookings({ eventTypeIds: [] }).then(function (res) {
      expect(res).toEqual({ bookings: [], truncated: false });
      expect(axios.get).not.toHaveBeenCalled();
    });
  });

  test('rejects when axios rejects', () => {
    axios.get.mockRejectedValue(new Error('boom'));
    return expect(calcom.listBookings(OPTS)).rejects.toThrow('boom');
  });

  test('non-array data treated as empty', () => {
    axios.get.mockResolvedValue({ data: { data: { nope: 1 }, pagination: { hasMore: false } } });
    return calcom.listBookings(OPTS).then(function (res) {
      expect(res).toEqual({ bookings: [], truncated: false });
    });
  });
});

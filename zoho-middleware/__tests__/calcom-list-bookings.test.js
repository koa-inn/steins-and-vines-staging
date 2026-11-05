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

  // CR-01: Cal.com 'upcoming' drops bookings that already ended, so the list asks for 'upcoming' and
  // 'past' in separate calls (one status per call; the comma-list form is not relied on) and merges.
  function byStatus(map) {
    return function (url, cfg) {
      var st = cfg.params.status;
      var v = map[st];
      if (typeof v === 'function') return v(cfg);
      return Promise.resolve(v || { data: { data: [], pagination: { hasMore: false, nextCursor: null } } });
    };
  }

  function page(data, next) {
    return { data: { data: data, pagination: { hasMore: !!next, nextCursor: next || null } } };
  }

  test('request shape: one call per status (upcoming, past)', () => {
    axios.get.mockImplementation(byStatus({ upcoming: page([{ uid: 'u1' }]) }));
    return calcom.listBookings(OPTS).then(function (res) {
      expect(axios.get).toHaveBeenCalledTimes(2);
      var statuses = axios.get.mock.calls.map(function (c) { return c[1].params.status; }).sort();
      expect(statuses).toEqual(['past', 'upcoming']);
      axios.get.mock.calls.forEach(function (call) {
        expect(call[0]).toBe('https://api.cal.com/v2/bookings');
        expect(call[1].headers['cal-api-version']).toBe('2026-05-01');
        expect(call[1].headers.Authorization).toBe('Bearer cal_test_key_123');
        var params = Object.assign({}, call[1].params);
        delete params.status;
        expect(params).toEqual({
          eventTypeIds: '5904690,6028745',
          afterStart: OPTS.afterStart,
          beforeEnd: OPTS.beforeEnd,
          sortStart: 'asc',
          limit: 100
        });
      });
      expect(res).toEqual({ bookings: [{ uid: 'u1' }], truncated: false });
    });
  });

  test('CR-01: a booking that already ended today is still listed', () => {
    var ended = { uid: 'morning', start: '2026-11-05T18:00:00Z', end: '2026-11-05T19:00:00Z', status: 'accepted' };
    var later = { uid: 'afternoon', start: '2026-11-05T23:00:00Z', end: '2026-11-06T00:00:00Z', status: 'accepted' };
    axios.get.mockImplementation(byStatus({ upcoming: page([later]), past: page([ended]) }));
    return calcom.listBookings(OPTS).then(function (res) {
      var uids = res.bookings.map(function (b) { return b.uid; }).sort();
      expect(uids).toEqual(['afternoon', 'morning']);
    });
  });

  test('dedupes a booking returned by both status calls', () => {
    var b = { uid: 'dup', start: '2026-11-05T18:00:00Z', status: 'accepted' };
    axios.get.mockImplementation(byStatus({ upcoming: page([b]), past: page([Object.assign({}, b)]) }));
    return calcom.listBookings(OPTS).then(function (res) {
      expect(res.bookings).toHaveLength(1);
    });
  });

  test('follows cursor pagination per status', () => {
    var n = 0;
    axios.get.mockImplementation(byStatus({
      upcoming: function (cfg) {
        n += 1;
        return Promise.resolve(cfg.params.cursor === 'c2' ? page([{ uid: 'b' }]) : page([{ uid: 'a' }], 'c2'));
      }
    }));
    return calcom.listBookings(OPTS).then(function (res) {
      expect(res.bookings.map(function (b) { return b.uid; })).toEqual(['a', 'b']);
      expect(res.truncated).toBe(false);
      expect(n).toBe(2);
    });
  });

  test('caps at 5 pages per status and reports truncated', () => {
    var k = 0;
    axios.get.mockImplementation(byStatus({
      upcoming: function () { k += 1; return Promise.resolve(page([{ uid: 'x' + k }], 'next')); }
    }));
    return calcom.listBookings(OPTS).then(function (res) {
      expect(k).toBe(5);
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

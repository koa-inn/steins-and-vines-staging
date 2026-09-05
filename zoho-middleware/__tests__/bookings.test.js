'use strict';

jest.mock('express', () => {
  var router = { get: jest.fn(), post: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('../lib/zoho-api', () => ({
  zohoGet: jest.fn(),
  zohoPost: jest.fn(),
  normalizeTimeTo24h: jest.fn()
}));
jest.mock('../lib/cache', () => ({
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1)
}));
jest.mock('../lib/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../lib/constants', () => ({
  CACHE_KEYS: {
    AVAILABILITY_PREFIX: 'test:avail:',
    BOOKING_SERVICES: 'test:booking-services',
    SLOTS_PREFIX: 'test:slots:'
  }
}));
jest.mock('../lib/calcom', () => ({
  listEventType: jest.fn(),
  getSlots: jest.fn(),
  createBooking: jest.fn(),
  verifyWebhook: jest.fn()
}));

describe('bookings routes — cache handling', () => {
  var cache, router, handlers;

  beforeEach(() => {
    jest.resetModules();
    cache = require('../lib/cache');
    require('../routes/bookings');
    router = require('express').Router();
    handlers = {};
    router.get.mock.calls.forEach(function (call) {
      handlers[call[0]] = call[call.length - 1];
    });
  });

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  test('/api/bookings/services returns cached data without double-parsing', async () => {
    var payload = { services: [{ id: 1 }], staff: [{ id: 2 }] };
    cache.get.mockResolvedValue(payload);

    var res = mockRes();
    await handlers['/api/bookings/services']({}, res);

    expect(res.json).toHaveBeenCalledWith(payload);
    expect(res.json.mock.calls[0][0]).toEqual(payload);
    expect(typeof res.json.mock.calls[0][0]).toBe('object');
  });

  // Regression: the two tests above mock cache.get with an ALREADY-PARSED object, so they
  // prove the read path is fine GIVEN a good cache value -- they never exercise what
  // cache.set actually wrote. The bug lived in that seam: the handler pre-stringified its
  // payload while lib/cache.set stringifies again internally, so Redis held a JSON string
  // of a JSON string. cache.get's single JSON.parse then yielded a STRING, and res.json()
  // served double-encoded JSON. Browsers doing `(await r.json()).services` got undefined.
  // Found live on staging 2026-09-05: it broke BrewPad's waitlist contact sheet, which
  // failed closed with "Could not prepare the booking link".
  function roundTripThroughRedis(setValue) {
    // Mirrors lib/cache: set() does JSON.stringify(value), get() does one JSON.parse.
    return JSON.parse(JSON.stringify(setValue));
  }

  test('/api/bookings/services survives a cache round-trip — no double encoding', async () => {
    var calcom = require('../lib/calcom');
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '111';
    calcom.listEventType.mockResolvedValue({
      data: { id: 111, title: 'Ferment Kit', slug: 'ferment-kit', lengthInMinutes: 15, bookingUrl: 'https://cal.com/x/ferment-kit' }
    });
    cache.get.mockResolvedValue(null);

    // First pass: cache miss, handler computes the payload and writes it.
    var res1 = mockRes();
    await handlers['/api/bookings/services']({}, res1);
    expect(cache.set).toHaveBeenCalled();

    // Second pass: serve exactly what Redis would hand back for that write.
    var stored = cache.set.mock.calls[cache.set.mock.calls.length - 1][1];
    cache.get.mockResolvedValue(roundTripThroughRedis(stored));

    var res2 = mockRes();
    await handlers['/api/bookings/services']({}, res2);

    var served = res2.json.mock.calls[0][0];
    expect(typeof served).toBe('object');
    expect(Array.isArray(served.services)).toBe(true);
    expect(served.services[0].slug).toBe('ferment-kit');
    delete process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
  });

  test('/api/bookings/services ignores a poisoned (string) cache entry rather than serving it', async () => {
    // Self-healing: entries written by the buggy code sit in Redis for a 24h TTL. A
    // non-object cache hit must be treated as a miss, not forwarded to res.json().
    var calcom = require('../lib/calcom');
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '111';
    calcom.listEventType.mockResolvedValue({
      data: { id: 111, title: 'Ferment Kit', slug: 'ferment-kit', lengthInMinutes: 15, bookingUrl: 'https://cal.com/x/ferment-kit' }
    });
    cache.get.mockResolvedValue('{"services":[{"slug":"ferment-kit"}],"staff":[]}');

    var res = mockRes();
    await handlers['/api/bookings/services']({}, res);

    var served = res.json.mock.calls[0][0];
    expect(typeof served).toBe('object');
    expect(Array.isArray(served.services)).toBe(true);
    delete process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
  });

  test('/api/bookings/slots returns cached data without double-parsing', async () => {
    var payload = { date: '2026-04-18', slots: [{ time: '10:00' }] };
    cache.get.mockResolvedValue(payload);

    var res = mockRes();
    var req = { query: { date: '2026-04-18' } };
    await handlers['/api/bookings/slots'](req, res);

    expect(res.json).toHaveBeenCalledWith(payload);
    expect(typeof res.json.mock.calls[0][0]).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// Cal.com integration regression tests — legacy response shapes
// (TDD RED: written before Task 2 rewrite; go green after implementation)
// ---------------------------------------------------------------------------

describe('bookings routes — Cal.com legacy shapes', () => {
  var calcom, cache, zohoApi, router, getHandlers, postHandlers;

  beforeEach(() => {
    jest.resetModules();
    calcom = require('../lib/calcom');
    cache = require('../lib/cache');
    zohoApi = require('../lib/zoho-api');
    // Reset all mocks
    jest.clearAllMocks();
    cache.get.mockResolvedValue(null); // default: cache miss
    cache.set.mockResolvedValue('OK');
    cache.del.mockResolvedValue(1);

    require('../routes/bookings');
    router = require('express').Router();
    getHandlers = {};
    postHandlers = {};
    router.get.mock.calls.forEach(function (call) {
      getHandlers[call[0]] = call[call.length - 1];
    });
    router.post.mock.calls.forEach(function (call) {
      postHandlers[call[0]] = call[call.length - 1];
    });
  });

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  // -------------------------------------------------------------------------
  // services: listEventType → { services:[...], staff:[] }
  // -------------------------------------------------------------------------

  test('GET /api/bookings/services — emits legacy { services, staff } shape from Cal.com event types', async () => {
    var fermentEventType = {
      status: 'success',
      data: {
        id: 101,
        title: 'Ferment in Store',
        slug: 'ferment-in-store',
        lengthInMinutes: 60,
        description: 'Book a ferment session',
        price: 0,
        currency: 'CAD',
        bookingUrl: 'https://cal.com/steins-and-vines/ferment-in-store'
      }
    };
    calcom.listEventType.mockResolvedValue(fermentEventType);

    // Provide env vars so handler calls listEventType
    var origFermentKit = process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '101';
    var res = mockRes();
    await getHandlers['/api/bookings/services']({ env: {} }, res);
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = origFermentKit;

    expect(res.json).toHaveBeenCalled();
    var payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload.services)).toBe(true);
    expect(payload.services.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.staff)).toBe(true);
    // Should contain the event type data
    expect(payload.services[0]).toMatchObject({ id: 101, title: 'Ferment in Store' });
  });

  // -------------------------------------------------------------------------
  // availability: getSlots (month range) → { source:'calcom', dates:[{date, available, slots_count}] }
  // -------------------------------------------------------------------------

  test('GET /api/bookings/availability — emits { source, dates:[{date,available,slots_count}] } from Cal.com', async () => {
    calcom.getSlots.mockResolvedValue({
      status: 'success',
      data: {
        '2026-06-05': [
          { start: '2026-06-05T09:00:00.000-07:00' },
          { start: '2026-06-05T10:00:00.000-07:00' }
        ],
        '2026-06-06': [
          { start: '2026-06-06T09:00:00.000-07:00' }
        ]
      }
    });

    var res = mockRes();
    var req = { query: { year: '2026', month: '6' } };
    await getHandlers['/api/bookings/availability'](req, res);

    expect(res.json).toHaveBeenCalled();
    var payload = res.json.mock.calls[0][0];
    expect(payload.source).toBe('calcom');
    expect(Array.isArray(payload.dates)).toBe(true);

    var june5 = payload.dates.find(function (d) { return d.date === '2026-06-05'; });
    expect(june5).toBeDefined();
    expect(june5.available).toBe(true);
    expect(june5.slots_count).toBe(2);

    var june6 = payload.dates.find(function (d) { return d.date === '2026-06-06'; });
    expect(june6).toBeDefined();
    expect(june6.available).toBe(true);
    expect(june6.slots_count).toBe(1);
  });

  test('GET /api/bookings/availability — only emits days with slots > 0', async () => {
    calcom.getSlots.mockResolvedValue({
      status: 'success',
      data: {
        '2026-06-05': [{ start: '2026-06-05T09:00:00.000-07:00' }],
        '2026-06-07': [] // empty — should be excluded
      }
    });

    var res = mockRes();
    var req = { query: { year: '2026', month: '6' } };
    await getHandlers['/api/bookings/availability'](req, res);

    var payload = res.json.mock.calls[0][0];
    expect(payload.dates.length).toBe(1);
    expect(payload.dates[0].date).toBe('2026-06-05');
  });

  test('GET /api/bookings/availability — returns 400 when year or month missing', async () => {
    var res = mockRes();
    await getHandlers['/api/bookings/availability']({ query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('GET /api/bookings/availability — returns 502 when Cal.com adapter rejects', async () => {
    calcom.getSlots.mockRejectedValue(new Error('Cal.com unreachable'));

    var res = mockRes();
    var req = { query: { year: '2026', month: '6' } };
    await getHandlers['/api/bookings/availability'](req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // slots: getSlots (single day) → { date, slots:[{time:"10:00 AM"}] }
  // -------------------------------------------------------------------------

  test('GET /api/bookings/slots — emits 12-hour AM/PM slot times', async () => {
    calcom.getSlots.mockResolvedValue({
      status: 'success',
      data: {
        '2026-06-05': [
          { start: '2026-06-05T09:00:00.000-07:00' },
          { start: '2026-06-05T10:00:00.000-07:00' }
        ]
      }
    });

    var res = mockRes();
    var req = { query: { date: '2026-06-05' } };
    await getHandlers['/api/bookings/slots'](req, res);

    expect(res.json).toHaveBeenCalled();
    var payload = res.json.mock.calls[0][0];
    expect(payload.date).toBe('2026-06-05');
    expect(Array.isArray(payload.slots)).toBe(true);
    expect(payload.slots.length).toBe(2);

    // Each slot must have a time property matching the 12-hour AM/PM regex
    payload.slots.forEach(function (slot) {
      expect(slot).toHaveProperty('time');
      expect(slot.time).toMatch(/(\d+):(\d+)\s*(AM|PM)/i);
    });
  });

  test('GET /api/bookings/slots — returns 502 when Cal.com adapter rejects', async () => {
    calcom.getSlots.mockRejectedValue(new Error('Cal.com unreachable'));

    var res = mockRes();
    var req = { query: { date: '2026-06-05' } };
    await getHandlers['/api/bookings/slots'](req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toHaveProperty('error');
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — happy path
  // -------------------------------------------------------------------------

  test('POST /api/bookings — happy path: maps Cal.com uid -> booking_id; 201 { ok, booking_id, timeslot }', async () => {
    zohoApi.normalizeTimeTo24h.mockReturnValue('10:00:00');
    calcom.createBooking.mockResolvedValue({
      status: 'success',
      data: {
        id: 42,
        uid: 'booking_uid_123',
        status: 'accepted',
        start: '2026-06-05T17:00:00Z',
        end: '2026-06-05T18:00:00Z'
      }
    });

    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-05',
        time: '10:00 AM',
        customer: {
          name: 'Anne MacDougall',
          email: 'anne@example.com',
          phone: '604-555-0123'
        },
        notes: 'Cabernet kit'
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    var payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.booking_id).toBe('booking_uid_123');
    expect(payload.timeslot).toBe('2026-06-05 10:00 AM');
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — offline fallback (req.zohoOffline)
  // -------------------------------------------------------------------------

  test('POST /api/bookings — offline fallback: returns 201 PENDING- without calling createBooking', async () => {
    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-05',
        time: '10:00 AM',
        customer: {
          name: 'Anne MacDougall',
          email: 'anne@example.com'
        }
      },
      zohoOffline: true
    };
    await postHandlers['/api/bookings'](req, res);

    expect(calcom.createBooking).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    var payload = res.json.mock.calls[0][0];
    expect(payload.ok).toBe(true);
    expect(payload.booking_id).toMatch(/^PENDING-/);
    expect(payload.timeslot).toBe('2026-06-05 10:00 AM');
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — validation guards (existing, must be preserved)
  // -------------------------------------------------------------------------

  test('POST /api/bookings — returns 400 on invalid date format', async () => {
    var res = mockRes();
    var req = {
      body: {
        date: 'not-a-date',
        time: '10:00 AM',
        customer: { name: 'Test User', email: 'test@example.com' }
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('POST /api/bookings — returns 400 when customer email missing', async () => {
    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-05',
        time: '10:00 AM',
        customer: { name: 'Test User' }
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('POST /api/bookings — returns 400 when date missing', async () => {
    var res = mockRes();
    var req = {
      body: {
        time: '10:00 AM',
        customer: { name: 'Test User', email: 'test@example.com' }
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — upstream failure -> 502
  // -------------------------------------------------------------------------

  test('POST /api/bookings — returns 502 when Cal.com adapter rejects', async () => {
    zohoApi.normalizeTimeTo24h.mockReturnValue('10:00:00');
    calcom.createBooking.mockRejectedValue(new Error('Cal.com unreachable'));

    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-05',
        time: '10:00 AM',
        customer: {
          name: 'Anne MacDougall',
          email: 'anne@example.com'
        }
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json.mock.calls[0][0]).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// Task 1 (plan 25-04): event-type selector — services returns both types,
// POST defaults to ferment-kit, POST with selector books bottling.
// ---------------------------------------------------------------------------

describe('bookings routes — event-type selector (25-04 Task 1)', () => {
  var calcom, cache, zohoApi, router, getHandlers, postHandlers;

  beforeEach(() => {
    jest.resetModules();
    calcom = require('../lib/calcom');
    cache = require('../lib/cache');
    zohoApi = require('../lib/zoho-api');
    jest.clearAllMocks();
    cache.get.mockResolvedValue(null);
    cache.set.mockResolvedValue('OK');
    cache.del.mockResolvedValue(1);

    require('../routes/bookings');
    router = require('express').Router();
    getHandlers = {};
    postHandlers = {};
    router.get.mock.calls.forEach(function (call) {
      getHandlers[call[0]] = call[call.length - 1];
    });
    router.post.mock.calls.forEach(function (call) {
      postHandlers[call[0]] = call[call.length - 1];
    });
  });

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  // -------------------------------------------------------------------------
  // services: returns both event types when both env ids are set
  // -------------------------------------------------------------------------

  test('GET /api/bookings/services — returns both event types when CALCOM_EVENT_TYPE_FERMENT_KIT and CALCOM_EVENT_TYPE_BOTTLING are set', async () => {
    var fermentType = { status: 'success', data: { id: 101, title: 'Ferment in Store', slug: 'ferment-in-store', lengthInMinutes: 60, description: '', price: 0, currency: 'CAD', bookingUrl: '' } };
    var bottlingType = { status: 'success', data: { id: 202, title: 'Bottling Day', slug: 'bottling-day', lengthInMinutes: 90, description: '', price: 0, currency: 'CAD', bookingUrl: '' } };

    // listEventType is called once per id in order; mock returns both
    calcom.listEventType
      .mockResolvedValueOnce(fermentType)
      .mockResolvedValueOnce(bottlingType);

    var origFermentKit = process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
    var origBottling = process.env.CALCOM_EVENT_TYPE_BOTTLING;
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '101';
    process.env.CALCOM_EVENT_TYPE_BOTTLING = '202';

    var res = mockRes();
    await getHandlers['/api/bookings/services']({}, res);

    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = origFermentKit;
    process.env.CALCOM_EVENT_TYPE_BOTTLING = origBottling;

    expect(calcom.listEventType).toHaveBeenCalledTimes(2);
    var payload = res.json.mock.calls[0][0];
    expect(Array.isArray(payload.services)).toBe(true);
    expect(payload.services.length).toBe(2);
    expect(payload.services[0]).toMatchObject({ id: 101, title: 'Ferment in Store' });
    expect(payload.services[1]).toMatchObject({ id: 202, title: 'Bottling Day' });
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — no selector defaults to ferment-kit event type
  // -------------------------------------------------------------------------

  test('POST /api/bookings — no service selector: createBooking called with ferment-kit eventTypeId', async () => {
    zohoApi.normalizeTimeTo24h.mockReturnValue('10:00:00');
    calcom.createBooking.mockResolvedValue({
      status: 'success',
      data: { id: 1, uid: 'uid_ferment_default', status: 'accepted', start: '2026-06-10T17:00:00Z', end: '2026-06-10T18:00:00Z' }
    });

    var origFermentKit = process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
    var origBottling = process.env.CALCOM_EVENT_TYPE_BOTTLING;
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '101';
    process.env.CALCOM_EVENT_TYPE_BOTTLING = '202';

    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-10',
        time: '10:00 AM',
        customer: { name: 'Test User', email: 'test@example.com' }
        // no service field — backward-compatible default
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = origFermentKit;
    process.env.CALCOM_EVENT_TYPE_BOTTLING = origBottling;

    expect(calcom.createBooking).toHaveBeenCalledTimes(1);
    var calledWith = calcom.createBooking.mock.calls[0][0];
    expect(calledWith.eventTypeId).toBe(101);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — selector 'bottling' books the bottling event type
  // -------------------------------------------------------------------------

  test("POST /api/bookings — service selector 'bottling': createBooking called with bottling eventTypeId", async () => {
    zohoApi.normalizeTimeTo24h.mockReturnValue('14:00:00');
    calcom.createBooking.mockResolvedValue({
      status: 'success',
      data: { id: 2, uid: 'uid_bottling_123', status: 'accepted', start: '2026-06-11T21:00:00Z', end: '2026-06-11T22:30:00Z' }
    });

    var origFermentKit = process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
    var origBottling = process.env.CALCOM_EVENT_TYPE_BOTTLING;
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '101';
    process.env.CALCOM_EVENT_TYPE_BOTTLING = '202';

    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-11',
        time: '2:00 PM',
        customer: { name: 'Test Bottler', email: 'bottler@example.com' },
        service: 'bottling'
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = origFermentKit;
    process.env.CALCOM_EVENT_TYPE_BOTTLING = origBottling;

    expect(calcom.createBooking).toHaveBeenCalledTimes(1);
    var calledWith = calcom.createBooking.mock.calls[0][0];
    expect(calledWith.eventTypeId).toBe(202);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json.mock.calls[0][0].ok).toBe(true);
    expect(res.json.mock.calls[0][0].booking_id).toBe('uid_bottling_123');
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — selector 'bottling' falls back to ferment-kit when
  // CALCOM_EVENT_TYPE_BOTTLING env id is unset
  // -------------------------------------------------------------------------

  test("POST /api/bookings — service selector 'bottling' with unset bottling env id: falls back to ferment-kit", async () => {
    zohoApi.normalizeTimeTo24h.mockReturnValue('10:00:00');
    calcom.createBooking.mockResolvedValue({
      status: 'success',
      data: { id: 3, uid: 'uid_fallback_ferment', status: 'accepted', start: '2026-06-12T17:00:00Z', end: '2026-06-12T18:00:00Z' }
    });

    var origFermentKit = process.env.CALCOM_EVENT_TYPE_FERMENT_KIT;
    var origBottling = process.env.CALCOM_EVENT_TYPE_BOTTLING;
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '101';
    delete process.env.CALCOM_EVENT_TYPE_BOTTLING; // unset

    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-12',
        time: '10:00 AM',
        customer: { name: 'Test User', email: 'test@example.com' },
        service: 'bottling'
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = origFermentKit;
    if (origBottling !== undefined) { process.env.CALCOM_EVENT_TYPE_BOTTLING = origBottling; }

    expect(calcom.createBooking).toHaveBeenCalledTimes(1);
    var calledWith = calcom.createBooking.mock.calls[0][0];
    // Should fall back to ferment-kit id (101)
    expect(calledWith.eventTypeId).toBe(101);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // -------------------------------------------------------------------------
  // POST /api/bookings — invalid selector rejected with 400
  // -------------------------------------------------------------------------

  test('POST /api/bookings — invalid service selector (too long) rejected with 400', async () => {
    var res = mockRes();
    var req = {
      body: {
        date: '2026-06-10',
        time: '10:00 AM',
        customer: { name: 'Test User', email: 'test@example.com' },
        service: 'a'.repeat(33)
      },
      zohoOffline: false
    };
    await postHandlers['/api/bookings'](req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0]).toHaveProperty('error');
    expect(calcom.createBooking).not.toHaveBeenCalled();
  });
});

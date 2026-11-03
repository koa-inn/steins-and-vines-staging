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

describe('bookings routes — beer packaging event type', () => {
  var cache, calcom, getHandlers, postHandlers;
  var ENV_KEYS = [
    'CALCOM_EVENT_TYPE_FERMENT_KIT', 'CALCOM_EVENT_TYPE_BOTTLING',
    'CALCOM_EVENT_TYPE_BEER_WAITLIST', 'CALCOM_EVENT_TYPE_BEER_PACKAGING'
  ];

  beforeEach(() => {
    jest.resetModules();
    ENV_KEYS.forEach(function (k) { delete process.env[k]; });
    cache = require('../lib/cache');
    calcom = require('../lib/calcom');
    require('../routes/bookings');
    var router = require('express').Router();
    getHandlers = {};
    postHandlers = {};
    router.get.mock.calls.forEach(function (c) { getHandlers[c[0]] = c[c.length - 1]; });
    router.post.mock.calls.forEach(function (c) { postHandlers[c[0]] = c[c.length - 1]; });
    cache.get.mockResolvedValue(null);
    calcom.listEventType.mockResolvedValue({ data: { id: 1, title: 't', slug: 's' } });
    calcom.createBooking.mockResolvedValue({ data: { uid: 'u1' } });
    require('../lib/zoho-api').normalizeTimeTo24h.mockReturnValue('10:00:00');
  });

  afterEach(() => {
    ENV_KEYS.forEach(function (k) { delete process.env[k]; });
    jest.clearAllMocks();
  });

  function mockRes() {
    var res = { json: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  function postReq(service) {
    var body = {
      date: '2026-11-10',
      time: '10:00 AM',
      customer: { name: 'A B', email: 'a@example.com' }
    };
    if (service !== undefined) body.service = service;
    return { body: body, zohoOffline: false };
  }

  function setAllEnv() {
    process.env.CALCOM_EVENT_TYPE_FERMENT_KIT = '111';
    process.env.CALCOM_EVENT_TYPE_BOTTLING = '222';
    process.env.CALCOM_EVENT_TYPE_BEER_WAITLIST = '333';
  }

  test('services lists four event types including 6028745 when set', async () => {
    setAllEnv();
    process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING = '6028745';
    await getHandlers['/api/bookings/services']({}, mockRes());
    var ids = calcom.listEventType.mock.calls.map(function (c) { return c[0]; });
    expect(ids).toEqual([111, 222, 333, 6028745]);
  });

  test('services lists three event types when BEER_PACKAGING unset', async () => {
    setAllEnv();
    await getHandlers['/api/bookings/services']({}, mockRes());
    expect(calcom.listEventType).toHaveBeenCalledTimes(3);
  });

  test('beer-packaging selector books 6028745', async () => {
    setAllEnv();
    process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING = '6028745';
    var res = mockRes();
    await postHandlers['/api/bookings'](postReq('beer-packaging'), res);
    expect(calcom.createBooking.mock.calls[0][0].eventTypeId).toBe(6028745);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('beer-packaging with env unset fails closed 503', async () => {
    setAllEnv();
    var res = mockRes();
    await postHandlers['/api/bookings'](postReq('beer-packaging'), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'Beer packaging booking is not configured' });
    expect(calcom.createBooking).not.toHaveBeenCalled();
  });

  test('beer-packaging with blank env fails closed 503', async () => {
    setAllEnv();
    process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING = '  ';
    var res = mockRes();
    await postHandlers['/api/bookings'](postReq('beer-packaging'), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(calcom.createBooking).not.toHaveBeenCalled();
  });

  test('bottling, absent and other selectors keep existing behaviour', async () => {
    setAllEnv();
    process.env.CALCOM_EVENT_TYPE_BEER_PACKAGING = '6028745';
    await postHandlers['/api/bookings'](postReq('bottling'), mockRes());
    await postHandlers['/api/bookings'](postReq(), mockRes());
    await postHandlers['/api/bookings'](postReq('other'), mockRes());
    var ids = calcom.createBooking.mock.calls.map(function (c) { return c[0].eventTypeId; });
    expect(ids).toEqual([222, 111, 111]);
  });
});

'use strict';

jest.mock('express', function () {
  var router = { get: jest.fn(), post: jest.fn() };
  var express = function () {};
  express.Router = function () { return router; };
  return express;
});
jest.mock('../lib/calcom', function () { return { verifyWebhook: jest.fn() }; });
jest.mock('../lib/cache', function () {
  return { get: jest.fn(), set: jest.fn().mockResolvedValue('OK'), del: jest.fn().mockResolvedValue(1) };
});
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});
jest.mock('../lib/eventLog', function () { return { logEvent: jest.fn() }; });
jest.mock('../lib/packaging-bookings', function () { return { invalidate: jest.fn() }; });

function mockRes() {
  var res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(trigger) {
  return {
    headers: { 'x-cal-signature-256': 'sig' },
    rawBody: Buffer.from('{"triggerEvent":"' + trigger + '"}'),
    body: { triggerEvent: trigger, payload: {} }
  };
}

describe('Cal.com webhook invalidates packaging-bookings', function () {
  var calcom, packagingBookings, handler;

  beforeEach(function () {
    jest.resetModules();
    calcom = require('../lib/calcom');
    packagingBookings = require('../lib/packaging-bookings');
    var router = require('express').Router();
    router.post.mockClear();
    require('../routes/webhooks');
    var call = router.post.mock.calls.filter(function (c) {
      return Array.isArray(c[0]) && c[0].indexOf('/api/webhooks/calcom') !== -1;
    })[0];
    handler = call[call.length - 1];
  });

  ['BOOKING_CREATED', 'BOOKING_RESCHEDULED', 'BOOKING_CANCELLED'].forEach(function (t) {
    it(t + ' calls invalidate once', function () {
      calcom.verifyWebhook.mockReturnValue(true);
      handler(makeReq(t), mockRes());
      expect(packagingBookings.invalidate).toHaveBeenCalledTimes(1);
    });
  });

  it('invalid signature does not invalidate', function () {
    calcom.verifyWebhook.mockReturnValue(false);
    var res = mockRes();
    handler(makeReq('BOOKING_CREATED'), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(packagingBookings.invalidate).not.toHaveBeenCalled();
  });

  it('other events do not invalidate', function () {
    calcom.verifyWebhook.mockReturnValue(true);
    handler(makeReq('MEETING_ENDED'), mockRes());
    expect(packagingBookings.invalidate).not.toHaveBeenCalled();
  });
});

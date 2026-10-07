'use strict';

// Phase 86-12 (D-03, D-20): per-request allowlist revalidation in resolveTier.

var mode;
var queryMock;
var sessionMock;
var authTiers;
var staffAccess;

function load() {
  jest.resetModules();
  queryMock = jest.fn();
  sessionMock = {
    getSession: jest.fn(),
    destroySession: jest.fn().mockResolvedValue(),
    touchSession: jest.fn().mockResolvedValue()
  };
  jest.doMock('../lib/db', function () { return { query: queryMock }; });
  jest.doMock('../lib/store-flag', function () {
    return { resolveStoreMode: function () { return mode; } };
  });
  jest.doMock('../lib/session', function () { return sessionMock; });
  jest.doMock('../lib/logger', function () {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  });
  staffAccess = require('../lib/staff-access');
  authTiers = require('../lib/authTiers');
}

function req() {
  return { headers: { 'x-session-token': 'sid-1' }, cookies: {} };
}

beforeEach(function () {
  mode = 'sheets';
  process.env.STAFF_EMAILS = 'boss@brew.co';
  load();
});

afterEach(function () {
  delete process.env.STAFF_EMAILS;
});

describe('sheets mode (unchanged behaviour)', function () {
  it('accepts any valid session, even for an email outside STAFF_EMAILS, without resolve', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'not-listed@x.co' });
    var spy = jest.spyOn(staffAccess, 'resolve');
    var r = req();
    expect(await authTiers.resolveTier(r)).toBe('session');
    expect(r.staffEmail).toBe('not-listed@x.co');
    expect(spy).not.toHaveBeenCalled();
    expect(sessionMock.destroySession).not.toHaveBeenCalled();
  });
});

describe('postgres mode', function () {
  beforeEach(function () { mode = 'postgres'; });

  it('allows a staff row and exposes the role', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'a@x.co' });
    queryMock.mockResolvedValue({ rows: [{ role: 'staff' }] });
    var r = req();
    expect(await authTiers.resolveTier(r)).toBe('session');
    expect(r.staffEmail).toBe('a@x.co');
    expect(r.staffRole).toBe('staff');
  });

  it('denies and destroys the session when the person was removed', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'a@x.co' });
    queryMock.mockResolvedValue({ rows: [] });
    expect(await authTiers.resolveTier(req())).toBeNull();
    expect(sessionMock.destroySession).toHaveBeenCalledTimes(1);
    expect(sessionMock.destroySession).toHaveBeenCalledWith('sid-1');

    // Later request with the same (now destroyed) sid
    sessionMock.getSession.mockResolvedValue(null);
    expect(await authTiers.resolveTier(req())).toBeNull();
  });

  it('does NOT destroy the session when the denial is degraded (db down)', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'a@x.co' });
    queryMock.mockRejectedValue(new Error('connection refused'));
    expect(await authTiers.resolveTier(req())).toBeNull();
    expect(sessionMock.destroySession).not.toHaveBeenCalled();
  });

  it('picks up a demotion on the next request', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'a@x.co' });
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    var r1 = req();
    await authTiers.resolveTier(r1);
    expect(r1.staffRole).toBe('owner');

    staffAccess.clearCache();
    queryMock.mockResolvedValueOnce({ rows: [{ role: 'staff' }] });
    var r2 = req();
    await authTiers.resolveTier(r2);
    expect(r2.staffRole).toBe('staff');
  });

  it('keeps a break-glass member working with the database down', async function () {
    sessionMock.getSession.mockResolvedValue({ email: 'boss@brew.co' });
    queryMock.mockRejectedValue(new Error('connection refused'));
    var r = req();
    expect(await authTiers.resolveTier(r)).toBe('session');
    expect(r.staffRole).toBe('owner');
    expect(sessionMock.destroySession).not.toHaveBeenCalled();
  });
});

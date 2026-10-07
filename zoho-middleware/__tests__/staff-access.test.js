'use strict';

var mode = 'sheets';
var queryMock;
var warnMock;

function load() {
  jest.resetModules();
  queryMock = jest.fn();
  warnMock = jest.fn();
  jest.doMock('../lib/db', function () { return { query: queryMock }; });
  jest.doMock('../lib/store-flag', function () {
    return { resolveStoreMode: function () { return mode; } };
  });
  jest.doMock('../lib/logger', function () {
    return { info: jest.fn(), warn: warnMock, error: jest.fn(), debug: jest.fn() };
  });
  return require('../lib/staff-access');
}

var sa;

beforeEach(function () {
  mode = 'sheets';
  process.env.STAFF_EMAILS = ' Boss@Brew.co , other@brew.co ,, ';
  sa = load();
});

afterEach(function () {
  delete process.env.STAFF_EMAILS;
  jest.restoreAllMocks();
});

describe('breakGlassEmails / hashEmail', function () {
  it('parses STAFF_EMAILS lower-cased, trimmed, without empties', function () {
    expect(sa.breakGlassEmails()).toEqual(['boss@brew.co', 'other@brew.co']);
  });

  it('hashEmail is 10 hex chars and case/space insensitive', function () {
    expect(sa.hashEmail('Boss@Brew.co')).toMatch(/^[0-9a-f]{10}$/);
    expect(sa.hashEmail(' BOSS@brew.co ')).toBe(sa.hashEmail('boss@brew.co'));
  });
});

describe('sheets mode', function () {
  it('allows an env member as owner without touching the database', async function () {
    var r = await sa.resolve('BOSS@brew.co');
    expect(r).toEqual({ allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: false });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('denies a non-member without touching the database', async function () {
    var r = await sa.resolve('stranger@x.co');
    expect(r.allowed).toBe(false);
    expect(r.role).toBeNull();
    expect(r.source).toBe('none');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('postgres mode', function () {
  beforeEach(function () { mode = 'postgres'; });

  it('env member with a staff row resolves as staff from pg', async function () {
    queryMock.mockResolvedValue({ rows: [{ role: 'staff' }] });
    var r = await sa.resolve('boss@brew.co');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('staff');
    expect(r.source).toBe('pg');
  });

  it('env member with no row resolves as owner from env', async function () {
    queryMock.mockResolvedValue({ rows: [] });
    var r = await sa.resolve('boss@brew.co');
    expect(r).toEqual({ allowed: true, role: 'owner', source: 'env', breakGlass: true, degraded: false });
  });

  it('env member is allowed (degraded) when the database errors', async function () {
    queryMock.mockRejectedValue(new Error('down'));
    var r = await sa.resolve('boss@brew.co');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('owner');
    expect(r.degraded).toBe(true);
  });

  it('non-env email with an owner row is allowed', async function () {
    queryMock.mockResolvedValue({ rows: [{ role: 'owner' }] });
    var r = await sa.resolve('new@x.co');
    expect(r.allowed).toBe(true);
    expect(r.role).toBe('owner');
    expect(r.source).toBe('pg');
    expect(queryMock).toHaveBeenCalledWith('select role from staff_access where email = $1', ['new@x.co']);
  });

  it('non-env email with no row is denied', async function () {
    queryMock.mockResolvedValue({ rows: [] });
    var r = await sa.resolve('new@x.co');
    expect(r.allowed).toBe(false);
  });

  it('non-env email is denied (fail closed) on a database error, logging only the hash', async function () {
    queryMock.mockRejectedValue(new Error('down'));
    var r = await sa.resolve('Private@x.co');
    expect(r.allowed).toBe(false);
    expect(r.degraded).toBe(true);
    var msgs = warnMock.mock.calls.map(function (c) { return String(c[0]); });
    expect(msgs.some(function (m) { return /h=[0-9a-f]{10}$/.test(m); })).toBe(true);
    expect(msgs.join(' ').toLowerCase()).not.toContain('private@x.co');
  });

  it('never reports a shadow disagreement', async function () {
    queryMock.mockResolvedValue({ rows: [] });
    await sa.resolve('boss@brew.co');
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('cache', function () {
  beforeEach(function () {
    mode = 'postgres';
    queryMock.mockResolvedValue({ rows: [{ role: 'staff' }] });
  });

  it('two resolves within 5 s hit the database once', async function () {
    await sa.resolve('new@x.co');
    await sa.resolve('NEW@x.co');
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('expires after 5 s', async function () {
    var now = 1000000;
    jest.spyOn(Date, 'now').mockImplementation(function () { return now; });
    await sa.resolve('new@x.co');
    now += 5001;
    await sa.resolve('new@x.co');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('bypassCache reads and writes nothing', async function () {
    await sa.resolve('new@x.co', { bypassCache: true });
    await sa.resolve('new@x.co', { bypassCache: true });
    expect(queryMock).toHaveBeenCalledTimes(2);
    await sa.resolve('new@x.co');
    expect(queryMock).toHaveBeenCalledTimes(3);
  });

  it('clearCache forces a fresh lookup', async function () {
    await sa.resolve('new@x.co');
    sa.clearCache();
    await sa.resolve('new@x.co');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a denied result', async function () {
    queryMock.mockResolvedValue({ rows: [] });
    await sa.resolve('new@x.co');
    await sa.resolve('new@x.co');
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('dual mode shadow compare', function () {
  beforeEach(function () {
    mode = 'dual';
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('reports an env-allowed email with no row once, by hash, rate limited', async function () {
    var now = 5000000;
    jest.spyOn(Date, 'now').mockImplementation(function () { return now; });
    await sa.resolve('boss@brew.co', { bypassCache: true });
    await sa.resolve('boss@brew.co', { bypassCache: true });
    var reports = warnMock.mock.calls.filter(function (c) { return /staff-access env-only decision differs/.test(c[0]); });
    expect(reports).toHaveLength(1);
    expect(reports[0][0]).toContain('h=' + sa.hashEmail('boss@brew.co'));
    expect(reports[0][0]).not.toContain('boss@brew.co');
    now += 3600001;
    await sa.resolve('boss@brew.co', { bypassCache: true });
    var again = warnMock.mock.calls.filter(function (c) { return /staff-access env-only decision differs/.test(c[0]); });
    expect(again).toHaveLength(2);
  });

  it('does not report when the env member has a row', async function () {
    queryMock.mockResolvedValue({ rows: [{ role: 'owner' }] });
    await sa.resolve('boss@brew.co');
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('never rejects', function () {
  it('denies a non-env email when store-flag throws', async function () {
    jest.resetModules();
    jest.doMock('../lib/logger', function () {
      return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    });
    jest.doMock('../lib/store-flag', function () {
      return { resolveStoreMode: function () { throw new Error('boom'); } };
    });
    var s = require('../lib/staff-access');
    var r = await s.resolve('stranger@x.co');
    expect(r.allowed).toBe(false);
    expect(r.degraded).toBe(true);
  });

  it('allows an env member (degraded) when store-flag throws', async function () {
    jest.resetModules();
    jest.doMock('../lib/logger', function () {
      return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    });
    jest.doMock('../lib/store-flag', function () {
      return { resolveStoreMode: function () { throw new Error('boom'); } };
    });
    var s = require('../lib/staff-access');
    var r = await s.resolve('boss@brew.co');
    expect(r.allowed).toBe(true);
    expect(r.degraded).toBe(true);
  });
});

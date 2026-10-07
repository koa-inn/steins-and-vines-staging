'use strict';

// Phase 86-12 (D-02, D-03): auth matrix and behaviour of routes/staff-access.js.
// Real authTiers / staff-access / allowed-origins; session, db, store-flag and
// staff-access-pg are mocked. Mounted on a minimal express app.

var mode;
var roles; // email -> role (what the database holds)
var dbDown;
var sessions; // sid -> email
var pg;
var dbMock;
var clearSpy;
var app;

function load() {
  jest.resetModules();
  var express = require('express');
  var cookieParser = require('cookie-parser');

  pg = {
    listStaff: jest.fn().mockResolvedValue([
      { email: 'boss@brew.co', role: 'owner', added_by: null, added_at: 't1', updated_by: null, updated_at: null }
    ]),
    listAudit: jest.fn().mockResolvedValue([{ id: 1, action: 'add' }]),
    addStaff: jest.fn().mockResolvedValue({ ok: true }),
    changeRole: jest.fn().mockResolvedValue({ ok: true }),
    removeStaff: jest.fn().mockResolvedValue({ ok: true }),
    recordDenied: jest.fn().mockResolvedValue()
  };
  dbMock = {
    query: jest.fn(function (text, params) {
      if (dbDown) return Promise.reject(new Error('db down secret-detail'));
      var role = roles[params[0]];
      return Promise.resolve({ rows: role ? [{ role: role }] : [] });
    }),
    withTransaction: jest.fn(function (fn) {
      if (dbDown) return Promise.reject(new Error('db down secret-detail'));
      return fn({ tx: true });
    })
  };
  jest.doMock('../lib/db', function () { return dbMock; });
  jest.doMock('../lib/store-flag', function () {
    return { resolveStoreMode: function () { return mode; } };
  });
  jest.doMock('../lib/staff-access-pg', function () { return pg; });
  jest.doMock('../lib/logger', function () {
    return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  });
  jest.doMock('../lib/session', function () {
    return {
      getSession: jest.fn(function (sid) {
        return Promise.resolve(sessions[sid] ? { email: sessions[sid] } : null);
      }),
      destroySession: jest.fn().mockResolvedValue(),
      touchSession: jest.fn().mockResolvedValue()
    };
  });
  jest.doMock('../lib/deviceToken', function () {
    return { matches: function (t) { return t === 'device-tok'; } };
  });
  jest.doMock('../lib/apiKey', function () {
    return { matches: function (k) { return k === 'legacy-key'; }, getKey: function () { return 'legacy-key'; } };
  });

  var staffAccess = require('../lib/staff-access');
  clearSpy = jest.spyOn(staffAccess, 'clearCache');

  app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', require('../routes/staff-access'));
}

var request = require('supertest');

beforeEach(function () {
  mode = 'postgres';
  dbDown = false;
  process.env.STAFF_EMAILS = 'boss@brew.co';
  roles = { 'boss@brew.co': 'owner', 'owner2@brew.co': 'owner', 'staff@brew.co': 'staff' };
  sessions = { 'sid-owner': 'owner2@brew.co', 'sid-staff': 'staff@brew.co', 'sid-boss': 'boss@brew.co' };
  load();
});

afterEach(function () {
  delete process.env.STAFF_EMAILS;
});

describe('auth matrix (GET list and POST add)', function () {
  var cases = [
    ['GET', 'get'],
    ['POST', 'post']
  ];

  cases.forEach(function (c) {
    var method = c[1];
    var label = c[0] + ' /api/staff-access';

    function call() {
      var r = request(app)[method]('/api/staff-access');
      return method === 'post' ? r.send({ email: 'new@x.co', role: 'staff' }) : r;
    }

    test(label + ' anonymous -> 401', async function () {
      expect((await call()).status).toBe(401);
    });

    test(label + ' device token -> 403', async function () {
      expect((await call().set('x-device-token', 'device-tok')).status).toBe(403);
    });

    test(label + ' legacy x-api-key only -> 403 session_required', async function () {
      var res = await call().set('x-api-key', 'legacy-key');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('session_required');
    });

    test(label + ' staff session via header -> 403 owner_required', async function () {
      var res = await call().set('x-session-token', 'sid-staff');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('owner_required');
      if (method === 'post') {
        expect(pg.recordDenied).toHaveBeenCalledTimes(1);
        expect(pg.recordDenied.mock.calls[0][1]).toMatchObject({ actor: 'staff@brew.co', target: 'new@x.co' });
        expect(pg.addStaff).not.toHaveBeenCalled();
      } else {
        expect(pg.recordDenied).not.toHaveBeenCalled();
      }
    });

    test(label + ' owner via cookie only -> 403 header_token_required', async function () {
      var res = await call().set('Cookie', 'sv_session=sid-owner');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('header_token_required');
    });

    test(label + ' owner header with a different cookie sid -> 403 header_token_required', async function () {
      var res = await call().set('x-session-token', 'sid-owner').set('Cookie', 'sv_session=sid-staff');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('header_token_required');
    });

    test(label + ' owner via header -> success', async function () {
      var res = await call().set('x-session-token', 'sid-owner');
      expect(res.status).toBe(method === 'post' ? 201 : 200);
    });
  });
});

describe('Origin check', function () {
  test('disallowed origin -> 403 origin_not_allowed', async function () {
    var res = await request(app).get('/api/staff-access')
      .set('x-session-token', 'sid-owner').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('origin_not_allowed');
  });

  test('allowed origin proceeds', async function () {
    var res = await request(app).get('/api/staff-access')
      .set('x-session-token', 'sid-owner').set('Origin', 'https://staging.steinsandvines.ca');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/staff-access/me', function () {
  test('anonymous -> 401', async function () {
    expect((await request(app).get('/api/staff-access/me')).status).toBe(401);
  });

  test('staff session -> role staff', async function () {
    var res = await request(app).get('/api/staff-access/me').set('x-session-token', 'sid-staff');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: 'staff@brew.co', role: 'staff', break_glass: false, store: 'postgres' });
  });

  test('break-glass member flagged', async function () {
    var res = await request(app).get('/api/staff-access/me').set('x-session-token', 'sid-boss');
    expect(res.body.break_glass).toBe(true);
  });

  test('works in sheets mode', async function () {
    mode = 'sheets';
    var res = await request(app).get('/api/staff-access/me').set('x-session-token', 'sid-boss');
    expect(res.status).toBe(200);
    expect(res.body.store).toBe('sheets');
    expect(res.body.role).toBe('owner');
  });
});

describe('list response', function () {
  test('merges break-glass flags and env-only members', async function () {
    process.env.STAFF_EMAILS = 'boss@brew.co,envonly@brew.co';
    var res = await request(app).get('/api/staff-access').set('x-session-token', 'sid-owner');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.staff).toEqual([
      { email: 'boss@brew.co', role: 'owner', added_by: null, added_at: 't1', break_glass: true }
    ]);
    expect(res.body.break_glass_only).toEqual(['envonly@brew.co']);
    expect(res.body.audit).toEqual([{ id: 1, action: 'add' }]);
  });
});

describe('mutations', function () {
  test('POST normalises the email, uses the actor, clears the cache', async function () {
    var res = await request(app).post('/api/staff-access')
      .set('x-session-token', 'sid-owner').send({ email: 'New@X.co', role: 'staff' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    var args = pg.addStaff.mock.calls[0][1];
    expect(args).toMatchObject({ actor: 'owner2@brew.co', target: 'new@x.co', role: 'staff' });
    expect(args.breakGlass).toEqual(['boss@brew.co']);
    expect(clearSpy).toHaveBeenCalled();
  });

  test('PUT changes a role', async function () {
    var res = await request(app).put('/api/staff-access/Staff@Brew.co')
      .set('x-session-token', 'sid-owner').send({ role: 'owner' });
    expect(res.status).toBe(200);
    expect(pg.changeRole.mock.calls[0][1]).toMatchObject({ target: 'staff@brew.co', role: 'owner' });
  });

  test('DELETE removes', async function () {
    var res = await request(app).delete('/api/staff-access/staff@brew.co').set('x-session-token', 'sid-owner');
    expect(res.status).toBe(200);
    expect(pg.removeStaff.mock.calls[0][1]).toMatchObject({ actor: 'owner2@brew.co', target: 'staff@brew.co' });
  });

  [
    ['cannot_remove_self', 409],
    ['last_owner', 409],
    ['break_glass_member', 409],
    ['not_found', 404]
  ].forEach(function (c) {
    test('DELETE business error ' + c[0] + ' -> ' + c[1], async function () {
      pg.removeStaff.mockResolvedValue({ ok: false, error: c[0], message: 'msg' });
      var res = await request(app).delete('/api/staff-access/x@brew.co').set('x-session-token', 'sid-owner');
      expect(res.status).toBe(c[1]);
      expect(res.body.code).toBe(c[0]);
      expect(clearSpy).not.toHaveBeenCalled();
    });
  });

  test('POST invalid email -> 422, staff_exists -> 409', async function () {
    pg.addStaff.mockResolvedValueOnce({ ok: false, error: 'invalid_email', message: 'm' });
    var r1 = await request(app).post('/api/staff-access')
      .set('x-session-token', 'sid-owner').send({ email: 'bad', role: 'staff' });
    expect(r1.status).toBe(422);
    pg.addStaff.mockResolvedValueOnce({ ok: false, error: 'staff_exists', message: 'm' });
    var r2 = await request(app).post('/api/staff-access')
      .set('x-session-token', 'sid-owner').send({ email: 'a@b.co', role: 'staff' });
    expect(r2.status).toBe(409);
  });

  test('owner role is re-derived from the database, bypassing the cache', async function () {
    // Warm the cache with an owner decision, then demote in the database.
    await request(app).get('/api/staff-access').set('x-session-token', 'sid-owner');
    roles['owner2@brew.co'] = 'staff';
    var res = await request(app).delete('/api/staff-access/staff@brew.co').set('x-session-token', 'sid-owner');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_required');
  });

  test('transaction failure -> generic 503 without the error message', async function () {
    pg.removeStaff.mockRejectedValue(new Error('relation secret-detail does not exist'));
    var res = await request(app).delete('/api/staff-access/x@brew.co').set('x-session-token', 'sid-owner');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('staff_access_unavailable');
    expect(JSON.stringify(res.body)).not.toMatch(/secret-detail/);
  });
});

describe('sheets mode', function () {
  test('list and mutations -> 503 staff_access_requires_postgres', async function () {
    mode = 'sheets';
    sessions['sid-boss'] = 'boss@brew.co';
    var calls = [
      request(app).get('/api/staff-access'),
      request(app).post('/api/staff-access').send({ email: 'a@b.co', role: 'staff' }),
      request(app).put('/api/staff-access/a@b.co').send({ role: 'owner' }),
      request(app).delete('/api/staff-access/a@b.co')
    ];
    for (var i = 0; i < calls.length; i++) {
      var res = await calls[i].set('x-session-token', 'sid-boss');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('staff_access_requires_postgres');
    }
  });
});

'use strict';

// Phase 86-16 Task 1: lib/ops-proxy overlay.

var mockVessel, mockSched, mockMirror, mockLog;

function load(mode) {
  jest.resetModules();
  mockVessel = {
    getMode: jest.fn().mockReturnValue(mode),
    list: jest.fn().mockResolvedValue({ ok: true, data: { vessels: [{ vessel_id: 'FV-1' }] } }),
    applyStatusChanges: jest.fn().mockResolvedValue({ applied: ['FV-1'] })
  };
  mockSched = {
    list: jest.fn().mockResolvedValue({ ok: true, data: { schedules: [{ schedule_id: 'FS-0012' }] } }),
    create: jest.fn(), update: jest.fn(), remove: jest.fn(), archive: jest.fn(), propagate: jest.fn(),
    getStepsJson: jest.fn()
  };
  mockMirror = { isMirrorEnabled: jest.fn().mockReturnValue(false) };
  mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  jest.doMock('../lib/vessel-store', function () { return mockVessel; });
  jest.doMock('../lib/ferm-schedule-store', function () { return mockSched; });
  jest.doMock('../lib/sheet-mirror', function () { return mockMirror; });
  jest.doMock('../lib/logger', function () { return mockLog; });
  jest.doMock('../lib/sentry-capture', function () { return { captureExceptionSafe: jest.fn() }; });
  return require('../lib/ops-proxy');
}

function mkRes() {
  var done;
  var p = new Promise(function (r) { done = r; });
  var res = {
    _status: 200, _body: null, done: p,
    status: jest.fn(function (s) { res._status = s; return res; }),
    json: jest.fn(function (b) { res._body = b; done(res); return res; })
  };
  return res;
}

describe('ops-proxy sheets mode', function () {
  var op;
  beforeEach(function () { op = load('sheets'); });

  test('intercept is false for every action and touches no store', function () {
    ['get_vessels', 'get_ferm_schedules', 'create_ferm_schedule', 'archive_ferm_schedule', 'create_batch']
      .forEach(function (a) {
        expect(op.intercept(a, { schedule_id: 'FS-1' }, {}, mkRes(), 't', jest.fn())).toBe(false);
      });
    expect(mockVessel.list).not.toHaveBeenCalled();
    expect(mockSched.list).not.toHaveBeenCalled();
  });

  test('decorateForward and afterUpstream leave things unchanged', function () {
    var p = { server_token: 't' };
    op.decorateForward(p, false);
    expect(p).toEqual({ server_token: 't' });
    var d = { ok: true, vessel_status_changes: [1] };
    return op.afterUpstream(d, { action: 'get_batch_init' }).then(function (out) {
      expect(out).toEqual({ ok: true, vessel_status_changes: [1] });
      expect(mockVessel.applyStatusChanges).not.toHaveBeenCalled();
    });
  });

  test('mapSheetsAction maps archive to delete', function () {
    expect(op.mapSheetsAction('archive_ferm_schedule')).toBe('delete_ferm_schedule');
    expect(op.mapSheetsAction('get_batch')).toBe('get_batch');
  });
});

describe('ops-proxy postgres mode', function () {
  var op;
  beforeEach(function () { op = load('postgres'); });

  test('mapSheetsAction keeps archive', function () {
    expect(op.mapSheetsAction('archive_ferm_schedule')).toBe('archive_ferm_schedule');
  });

  test('get_vessels answered from store', function () {
    var res = mkRes();
    expect(op.intercept('get_vessels', {}, {}, res, 't', jest.fn())).toBe(true);
    return res.done.then(function () {
      expect(res._body).toEqual({ ok: true, data: { vessels: [{ vessel_id: 'FV-1' }] } });
    });
  });

  test('stale update -> 409 stale_schedule; actor and expected_updated_at passed', function () {
    mockSched.update.mockResolvedValue({ ok: false, error: 'stale_schedule', message: 'm' });
    var res = mkRes();
    op.intercept('update_ferm_schedule', { schedule_id: 'FS-1', expected_updated_at: 'T' },
      { staffEmail: 'a@b.c' }, res, 't', jest.fn());
    return res.done.then(function () {
      expect(res._status).toBe(409);
      expect(res._body.code).toBe('stale_schedule');
      expect(mockSched.update.mock.calls[0][1]).toEqual({ actor: 'a@b.c', expectedUpdatedAt: 'T' });
    });
  });

  test('delete in use -> 409 with counts', function () {
    mockSched.remove.mockResolvedValue({ ok: false, error: 'schedule_in_use', message: 'm', recipe_refs: 2, batch_refs: 1 });
    var res = mkRes();
    op.intercept('delete_ferm_schedule', { schedule_id: 'FS-1' }, {}, res, 't', jest.fn());
    return res.done.then(function () {
      expect(res._status).toBe(409);
      expect(res._body).toMatchObject({ code: 'schedule_in_use', recipe_refs: 2, batch_refs: 1 });
      expect(mockSched.remove.mock.calls[0][1].actor).toBe('middleware');
    });
  });

  test('batch_ref_unavailable -> 502 server_error', function () {
    var err = new Error('x'); err.code = 'batch_ref_unavailable';
    mockSched.remove.mockRejectedValue(err);
    var res = mkRes();
    op.intercept('delete_ferm_schedule', { schedule_id: 'FS-1' }, {}, res, 't', jest.fn());
    return res.done.then(function () {
      expect(res._status).toBe(502);
      expect(res._body).toEqual({ ok: false, error: 'server_error' });
    });
  });

  test('propagate passes response through', function () {
    mockSched.propagate.mockResolvedValue({ ok: true, batches_failed: ['B1'] });
    var res = mkRes();
    op.intercept('propagate_ferm_schedule', { schedule_id: 'FS-1' }, { staffEmail: 'a@b.c' }, res, 't', jest.fn());
    return res.done.then(function () {
      expect(res._body.batches_failed).toEqual(['B1']);
      expect(mockSched.propagate.mock.calls[0][1].actor).toBe('a@b.c');
    });
  });

  test('create_batch with schedule injects steps then forwards once', function () {
    mockSched.getStepsJson.mockResolvedValue({ ok: true, steps_json: '[1]' });
    var fwd = jest.fn();
    var res = mkRes();
    var payload = { schedule_id: 'FS-0012' };
    expect(op.intercept('create_batch', payload, {}, res, 't', fwd)).toBe(true);
    return new Promise(function (r) { setImmediate(r); }).then(function () {
      expect(payload.schedule_steps_json).toBe('[1]');
      expect(fwd).toHaveBeenCalledTimes(1);
    });
  });

  test('create_batch with unknown schedule returns not_found without forwarding', function () {
    var env = { ok: false, error: 'not_found', message: 'Schedule not found: FS-0099' };
    mockSched.getStepsJson.mockResolvedValue(env);
    var fwd = jest.fn();
    var res = mkRes();
    op.intercept('create_batch', { schedule_id: 'FS-0099' }, {}, res, 't', fwd);
    return res.done.then(function () {
      expect(res._status).toBe(200);
      expect(res._body).toEqual(env);
      expect(fwd).not.toHaveBeenCalled();
    });
  });

  test('create_batch without schedule_id is not owned', function () {
    expect(op.intercept('create_batch', {}, {}, mkRes(), 't', jest.fn())).toBe(false);
  });

  test('decorateForward: server_token write, public write, read', function () {
    mockMirror.isMirrorEnabled.mockReturnValue(true);
    var a = { server_token: 't' };
    op.decorateForward(a, false);
    expect(a).toEqual({ server_token: 't', collect_vessel_status: true, vessel_sheet_write: true });
    var b = {};
    op.decorateForward(b, false);
    expect(b).toEqual({ collect_vessel_status: true });
    var c = { server_token: 't' };
    op.decorateForward(c, true);
    expect(c).toEqual({ server_token: 't' });
  });

  test('afterUpstream applies changes with actor and strips key', function () {
    var changes = [{ vessel_id: 'FV-1', status: 'in_use' }];
    return op.afterUpstream({ ok: true, vessel_status_changes: changes }, { acting_user: 'a@b.c' }).then(function (out) {
      expect(mockVessel.applyStatusChanges).toHaveBeenCalledWith(changes, { actor: 'a@b.c' });
      expect(out).toEqual({ ok: true });
    });
  });

  test('afterUpstream apply failure logs ids and still returns data', function () {
    mockVessel.applyStatusChanges.mockRejectedValue(new Error('pg down'));
    return op.afterUpstream({ ok: true, vessel_status_changes: [{ vessel_id: 'FV-9', status: 'x' }] }, {}).then(function (out) {
      expect(out).toEqual({ ok: true });
      expect(mockLog.error.mock.calls[0][0]).toMatch(/FV-9/);
    });
  });

  test('get_batch_init schedules replaced by PG list', function () {
    // Apps Script get_batch_init returns schedules as getFermSchedules() -> {schedules: [...]};
    // admin.js reads data.schedules.schedules, so the overlay must keep that wrapper.
    var d = { ok: true, data: { schedules: { schedules: [{ schedule_id: 'OLD' }] }, other: 1 } };
    return op.afterUpstream(d, { action: 'get_batch_init' }).then(function (out) {
      expect(out.data.schedules).toEqual({ schedules: [{ schedule_id: 'FS-0012' }] });
      expect(out.data.other).toBe(1);
    });
  });
});

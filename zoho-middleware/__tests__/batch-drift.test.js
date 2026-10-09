'use strict';

/**
 * Tests for lib/batch-drift.js - Phase 87 Plan 15. Fake axios, fake transaction and fake Sentry:
 * no database, sheet or network.
 */

var batchCompare = require('../lib/batch-compare');
var drift = require('../lib/batch-drift');

var QUIET = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function pinnedHeaders() {
  var h = {};
  batchCompare.TABLES.forEach(function (t) {
    h[t.sheet] = t.spec.columns.map(function (c) { return c.header; });
  });
  return h;
}

function emptyExport() {
  var data = { headers: pinnedHeaders() };
  batchCompare.TABLES.forEach(function (t) { data[t.sheet] = []; });
  return { data: { ok: true, data: data } };
}

function fakeTx(tablesByName) {
  return function (fn) {
    var client = {
      query: jest.fn(function (sql) {
        if (/^set transaction/.test(sql)) return Promise.resolve({ rows: [] });
        var name = /from (\w+)/.exec(sql)[1];
        return Promise.resolve({ rows: (tablesByName && tablesByName[name]) || [] });
      })
    };
    return fn(client);
  };
}

function deps(over) {
  return Object.assign({
    axios: { post: jest.fn().mockResolvedValue(emptyExport()) },
    withTransaction: fakeTx({}),
    sentry: { captureMessage: jest.fn() },
    log: QUIET,
    env: { APPS_SCRIPT_URL: 'https://script.example.invalid/exec', APPS_SCRIPT_SERVER_TOKEN: 'srv' }
  }, over || {});
}

beforeEach(function () {
  Object.keys(QUIET).forEach(function (k) { QUIET[k].mockClear(); });
});

describe('runDriftCheck', function () {
  test('equal sides: logs 0 mismatches and does not call Sentry', async function () {
    var d = deps();
    var r = await drift.runDriftCheck(d);
    expect(r).toEqual({ ok: true, mismatchCount: 0 });
    expect(QUIET.info).toHaveBeenCalledWith('[batches-drift] 0 mismatches');
    expect(d.sentry.captureMessage).not.toHaveBeenCalled();
    var body = JSON.parse(d.axios.post.mock.calls[0][1]);
    expect(body.action).toBe('export_batch_tabs');
  });

  test('a mismatch raises Sentry with the component tag and counts only', async function () {
    var d = deps({
      withTransaction: fakeTx({ batches: [{ batch_id: 'SV-B-000001', customer_name: 'Secret Name' }] })
    });
    var r = await drift.runDriftCheck(d);
    expect(r.ok).toBe(false);
    expect(d.sentry.captureMessage).toHaveBeenCalledTimes(1);
    var args = d.sentry.captureMessage.mock.calls[0];
    expect(args[0]).toBe('batches drift detected');
    expect(args[1].tags).toEqual({ component: 'batches-drift' });
    expect(Object.keys(args[1].extra).sort()).toEqual(['headerOk', 'mismatchCount', 'tables']);
    expect(JSON.stringify(args)).not.toContain('Secret Name');
    var logged = QUIET.warn.mock.calls.join('\n');
    expect(logged).toContain('batches SV-B-000001 missing_in_sheet');
    expect(logged).not.toContain('Secret Name');
  });

  test('an Apps Script error is reported and resolves', async function () {
    var d = deps({ axios: { post: jest.fn().mockRejectedValue(new Error('boom')) } });
    var r = await drift.runDriftCheck(d);
    expect(r.ok).toBe(false);
    expect(d.sentry.captureMessage).toHaveBeenCalledWith('batches drift check failed',
      expect.objectContaining({ tags: { component: 'batches-drift' } }));
  });

  test('ok:false from export_batch_tabs is a failed check', async function () {
    var d = deps({ axios: { post: jest.fn().mockResolvedValue({ data: { ok: false } }) } });
    var r = await drift.runDriftCheck(d);
    expect(r.error).toMatch(/ok:false/);
  });

  test('a Postgres error is reported and resolves', async function () {
    var d = deps({ withTransaction: function () { return Promise.reject(new Error('pg down')); } });
    var r = await drift.runDriftCheck(d);
    expect(r.ok).toBe(false);
    expect(d.sentry.captureMessage.mock.calls[0][0]).toBe('batches drift check failed');
  });

  test('a throwing Sentry never escapes', async function () {
    var d = deps({
      axios: { post: jest.fn().mockRejectedValue(new Error('boom')) },
      sentry: { captureMessage: jest.fn(function () { throw new Error('sentry down'); }) }
    });
    await expect(drift.runDriftCheck(d)).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  test('missing Apps Script env is a failed check, not a throw', async function () {
    var r = await drift.runDriftCheck(deps({ env: {} }));
    expect(r.ok).toBe(false);
  });
});

describe('registerDriftTimer', function () {
  var handles = [];
  afterEach(function () {
    handles.forEach(clearInterval);
    handles = [];
  });

  function reg(mirror, mode) {
    var h = drift.registerDriftTimer({
      sheetMirror: { isMirrorEnabled: function () { return mirror; } },
      batchFlag: { getMode: function () { return mode; } },
      log: QUIET
    });
    if (h) handles.push(h);
    return h;
  }

  test('no-op off production', function () {
    expect(reg(false, 'postgres')).toBeNull();
  });

  test('no-op when BATCHES_STORE is not postgres', function () {
    expect(reg(true, 'sheets')).toBeNull();
  });

  test('production + postgres registers a 24 h interval', function () {
    var spy = jest.spyOn(global, 'setInterval');
    try {
      var h = reg(true, 'postgres');
      expect(h).toBeTruthy();
      expect(spy.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000);
    } finally {
      spy.mockRestore();
    }
  });
});

'use strict';

// Tests for the 'batch' entity in lib/ops-mirror.js — Phase 87 Plan 10 (DB-06, D-10).

var mockMirror = { enabled: true };
var mockStore = {};

jest.mock('axios');

jest.mock('../lib/sheet-mirror', function () {
  return {
    isMirrorEnabled: jest.fn(function () { return mockMirror.enabled; }),
    mirrorFireAndForget: jest.fn(function (label, fn) {
      if (!mockMirror.enabled) return undefined;
      try {
        var r = fn();
        if (r && typeof r.then === 'function') r.catch(function () {});
      } catch (e) { /* swallowed like the real gate */ }
      return undefined;
    })
  };
});

jest.mock('../lib/cache', function () {
  return {
    get: jest.fn(function (key) {
      return Promise.resolve(Object.prototype.hasOwnProperty.call(mockStore, key) ? mockStore[key] : null);
    }),
    set: jest.fn(function (key, value) { mockStore[key] = value; return Promise.resolve(); }),
    del: jest.fn(function (key) { delete mockStore[key]; return Promise.resolve(); }),
    isConnected: jest.fn(function () { return true; }),
    getClient: jest.fn(function () {
      return Promise.resolve({
        keys: jest.fn(function (pattern) {
          var prefix = pattern.replace('*', '');
          return Promise.resolve(Object.keys(mockStore).filter(function (k) { return k.indexOf(prefix) === 0; }));
        })
      });
    })
  };
});

jest.mock('../lib/db', function () {
  return { withTransaction: jest.fn(function (fn) { return fn({}); }) };
});
jest.mock('../lib/vessel-pg', function () { return { getVessel: jest.fn() }; });
jest.mock('../lib/ferm-schedule-pg', function () { return { getSchedule: jest.fn() }; });
jest.mock('../lib/batch-pg-read', function () { return { getBatchBundle: jest.fn() }; });
jest.mock('../lib/sentry-capture', function () { return { captureExceptionSafe: jest.fn() }; });
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var axios = require('axios');
var batchPgRead = require('../lib/batch-pg-read');
var sentryCapture = require('../lib/sentry-capture');
var opsMirror = require('../lib/ops-mirror');

var BID = 'SV-B-000010';
var KEY = 'ops:mirror-dirty:batch:' + BID;

function bundle(name) {
  return {
    batch: { batch_id: BID, name: name || 'N' },
    tasks: [{ task_id: 't1' }],
    readings: [{ reading_id: 'r1' }],
    history: [{ history_id: 'h1' }]
  };
}
function flush() { return jest.advanceTimersByTimeAsync(0); }
function sentBodies() {
  return axios.post.mock.calls.map(function (c) { return JSON.parse(c[1]); });
}

beforeEach(function () {
  jest.useFakeTimers();
  mockMirror.enabled = true;
  Object.keys(mockStore).forEach(function (k) { delete mockStore[k]; });
  jest.clearAllMocks();
  process.env.APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.APPS_SCRIPT_SERVER_TOKEN = 'tok';
  batchPgRead.getBatchBundle.mockResolvedValue(bundle());
  axios.post.mockResolvedValue({ data: { ok: true } });
});

afterEach(function () { jest.useRealTimers(); });

describe('batch entity config', function () {
  it('registers the batch entity prefix and label', function () {
    expect(opsMirror.ENTITIES.batch).toEqual({ prefix: 'ops:mirror-dirty:batch:', label: 'batches.mirror' });
  });
});

describe('buildMirrorRequest batch', function () {
  it('builds mirror_batch_state from a bundle', function () {
    var b = bundle();
    expect(opsMirror.buildMirrorRequest('batch', b, BID)).toEqual({
      action: 'mirror_batch_state', batch: b.batch, tasks: b.tasks, readings: b.readings, history: b.history
    });
  });

  it('builds mirror_batch_delete when the batch is gone', function () {
    expect(opsMirror.buildMirrorRequest('batch', null, BID)).toEqual({
      action: 'mirror_batch_delete', batch_id: BID
    });
  });
});

describe('schedule batch', function () {
  it('is a no-op when the mirror is disabled', async function () {
    mockMirror.enabled = false;
    opsMirror.schedule('batch', BID);
    await flush();
    expect(mockStore[KEY]).toBeUndefined();
    expect(axios.post).not.toHaveBeenCalled();
    expect(batchPgRead.getBatchBundle).not.toHaveBeenCalled();
  });

  it('sets marker, reads the bundle, posts with server_token, clears marker', async function () {
    var seen;
    axios.post.mockImplementation(function () {
      seen = mockStore[KEY];
      return Promise.resolve({ data: { ok: true } });
    });
    opsMirror.schedule('batch', BID);
    await flush();
    expect(seen).toBeDefined();
    expect(batchPgRead.getBatchBundle).toHaveBeenCalledWith({}, BID);
    var b = sentBodies();
    expect(b).toHaveLength(1);
    expect(b[0].action).toBe('mirror_batch_state');
    expect(b[0].server_token).toBe('tok');
    expect(b[0].tasks).toHaveLength(1);
    expect(b[0].readings).toHaveLength(1);
    expect(b[0].history).toHaveLength(1);
    expect(mockStore[KEY]).toBeUndefined();
  });

  it('posts mirror_batch_delete when the batch no longer exists', async function () {
    batchPgRead.getBatchBundle.mockResolvedValue(null);
    opsMirror.schedule('batch', BID);
    await flush();
    var b = sentBodies()[0];
    expect(b.action).toBe('mirror_batch_delete');
    expect(b.batch_id).toBe(BID);
  });

  it('retries on ok:false per RETRY_DELAYS_MS then tags Sentry with component/entity/id only', async function () {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'nope' } });
    opsMirror.schedule('batch', BID);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(1);
    for (var i = 0; i < opsMirror.RETRY_DELAYS_MS.length; i++) {
      await jest.advanceTimersByTimeAsync(opsMirror.RETRY_DELAYS_MS[i]);
    }
    expect(axios.post).toHaveBeenCalledTimes(1 + opsMirror.RETRY_DELAYS_MS.length);
    expect(sentryCapture.captureExceptionSafe).toHaveBeenCalledTimes(1);
    expect(sentryCapture.captureExceptionSafe.mock.calls[0][1].tags).toEqual({
      component: 'ops-mirror', entity: 'batch', id: BID
    });
    expect(mockStore[KEY]).toBeDefined();
  });
});

describe('sweep batch', function () {
  it('parses the batch marker key and re-drives the batch', async function () {
    mockStore[KEY] = { token: 't', set_at: 'x' };
    var p = opsMirror.sweep();
    await flush();
    var res = await p;
    expect(res.redriven).toBe(1);
    expect(batchPgRead.getBatchBundle).toHaveBeenCalledWith({}, BID);
    expect(sentBodies()[0].action).toBe('mirror_batch_state');
  });
});

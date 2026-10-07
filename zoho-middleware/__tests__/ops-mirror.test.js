'use strict';

// Tests for lib/ops-mirror.js — Phase 86 Plan 11 (DB-05, D-10).

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
jest.mock('../lib/sentry-capture', function () { return { captureExceptionSafe: jest.fn() }; });
jest.mock('../lib/logger', function () {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
});

var axios = require('axios');
var cache = require('../lib/cache');
var vesselPg = require('../lib/vessel-pg');
var fermSchedulePg = require('../lib/ferm-schedule-pg');
var sentryCapture = require('../lib/sentry-capture');
var opsMirror = require('../lib/ops-mirror');

var VID = 'PCB-009';
var SID = 'FS-0009';
var VKEY = 'ops:mirror-dirty:vessel:' + VID;
var SKEY = 'ops:mirror-dirty:fermsched:' + SID;

function vesselRow(notes) {
  return {
    vessel_id: VID, label: 'L', type: 'Carboy', material: 'Glass', capacity_liters: 23,
    status: 'Available', archived: false, bottom_diameter_cm: 1, top_diameter_cm: 2, depth_cm: 3,
    location: 'A', brand: 'B', notes: notes || '', updated_at: 'x', position: 4
  };
}
function scheduleRow(name) {
  return {
    schedule_id: SID, name: name || 'N', description: 'd', category: 'c', steps: '[]',
    is_active: true, created_at: 'c', created_by: 'u', last_updated: 'l', steps_parsed: []
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
  vesselPg.getVessel.mockResolvedValue(vesselRow());
  fermSchedulePg.getSchedule.mockResolvedValue(scheduleRow());
  axios.post.mockResolvedValue({ data: { ok: true } });
});

afterEach(function () { jest.useRealTimers(); });

describe('schedule', function () {
  it('is a no-op when the mirror is disabled', async function () {
    mockMirror.enabled = false;
    opsMirror.schedule('vessel', VID);
    await flush();
    expect(cache.set).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('sets marker, posts mirror_vessel_state with exact keys, clears marker', async function () {
    var seen;
    axios.post.mockImplementation(function () {
      seen = mockStore[VKEY];
      return Promise.resolve({ data: { ok: true } });
    });
    opsMirror.schedule('vessel', VID);
    await flush();
    expect(seen).toBeDefined();
    var b = sentBodies();
    expect(b).toHaveLength(1);
    expect(b[0].action).toBe('mirror_vessel_state');
    expect(Object.keys(b[0].vessel).sort()).toEqual([
      'archived', 'bottom_diameter_cm', 'brand', 'capacity_liters', 'depth_cm', 'label', 'location',
      'material', 'notes', 'status', 'top_diameter_cm', 'type', 'vessel_id'
    ]);
    expect(mockStore[VKEY]).toBeUndefined();
  });

  it('posts mirror_ferm_schedule_state with exact keys', async function () {
    opsMirror.schedule('fermsched', SID);
    await flush();
    var b = sentBodies()[0];
    expect(b.action).toBe('mirror_ferm_schedule_state');
    expect(Object.keys(b.schedule).sort()).toEqual([
      'category', 'created_at', 'created_by', 'description', 'is_active', 'last_updated', 'name',
      'schedule_id', 'steps'
    ]);
  });

  it('posts mirror_ferm_schedule_delete when the schedule is gone', async function () {
    fermSchedulePg.getSchedule.mockResolvedValue(null);
    opsMirror.schedule('fermsched', SID);
    await flush();
    var b = sentBodies()[0];
    expect(b.action).toBe('mirror_ferm_schedule_delete');
    expect(b.schedule_id).toBe(SID);
  });

  it('throws for an unknown entity', function () {
    expect(function () { opsMirror.schedule('staff', 'x'); }).toThrow('unknown mirror entity');
  });
});

describe('coalescing', function () {
  it('serialises per id and the last send carries the latest row', async function () {
    var releases = [];
    var inflight = 0;
    var max = 0;
    axios.post.mockImplementation(function () {
      inflight++;
      max = Math.max(max, inflight);
      return new Promise(function (resolve) {
        releases.push(function () { inflight--; resolve({ data: { ok: true } }); });
      });
    });
    opsMirror.schedule('vessel', VID);
    opsMirror.schedule('vessel', VID);
    opsMirror.schedule('vessel', VID);
    await flush();
    vesselPg.getVessel.mockResolvedValue(vesselRow('LATEST'));
    expect(releases).toHaveLength(1);
    for (var i = 0; i < 5; i++) {
      var pendingRelease = releases.splice(0);
      pendingRelease.forEach(function (r) { r(); });
      await flush();
    }
    expect(max).toBe(1);
    var b = sentBodies();
    expect(b[b.length - 1].vessel.notes).toBe('LATEST');
  });

  it('does not share a chain between a vessel and a schedule', async function () {
    var releases = [];
    axios.post.mockImplementation(function () {
      return new Promise(function (resolve) { releases.push(function () { resolve({ data: { ok: true } }); }); });
    });
    opsMirror.schedule('vessel', VID);
    opsMirror.schedule('fermsched', SID);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(2);
    releases.forEach(function (r) { r(); });
    await flush();
  });
});

describe('failure and retry', function () {
  it('retries 2 s / 10 s / 60 s / 300 s then alerts Sentry with entity+id tags; marker kept', async function () {
    axios.post.mockRejectedValue(new Error('boom'));
    opsMirror.schedule('vessel', VID);
    await flush();
    expect(axios.post).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(axios.post).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(10000);
    expect(axios.post).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(60000);
    expect(axios.post).toHaveBeenCalledTimes(4);
    expect(sentryCapture.captureExceptionSafe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(300000);
    expect(axios.post).toHaveBeenCalledTimes(5);
    expect(sentryCapture.captureExceptionSafe).toHaveBeenCalledWith(
      expect.any(Error),
      { level: 'error', tags: { component: 'ops-mirror', entity: 'vessel', id: VID } }
    );
    expect(mockStore[VKEY]).toBeDefined();
  });

  it('treats {ok:false} as failure', async function () {
    axios.post.mockResolvedValue({ data: { ok: false, error: 'nope' } });
    opsMirror.schedule('fermsched', SID);
    await flush();
    expect(mockStore[SKEY]).toBeDefined();
    await expect(opsMirror.mirrorLatest('fermsched', SID)).rejects.toThrow(/nope/);
  });

  it('missing vessel is an error, not a delete', async function () {
    vesselPg.getVessel.mockResolvedValue(null);
    await expect(opsMirror.mirrorLatest('vessel', VID)).rejects.toThrow('vessel not found for mirror');
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('sweep', function () {
  it('re-drives markers for both entities, parsing the entity from the key', async function () {
    mockStore[VKEY] = { token: 'a' };
    mockStore['ops:mirror-dirty:fermsched:FS-0003'] = { token: 'b' };
    var r = await opsMirror.sweep();
    expect(r).toEqual({ redriven: 2 });
    var actions = sentBodies().map(function (x) { return x.action; }).sort();
    expect(actions).toEqual(['mirror_ferm_schedule_state', 'mirror_vessel_state']);
  });

  it('skips a key whose chain is running', async function () {
    var release;
    axios.post.mockImplementationOnce(function () {
      return new Promise(function (resolve) { release = function () { resolve({ data: { ok: true } }); }; });
    });
    opsMirror.schedule('vessel', VID);
    await flush();
    var p = opsMirror.sweep();
    await flush();
    release();
    expect(await p).toEqual({ redriven: 0 });
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when disabled or Redis disconnected', async function () {
    mockStore[VKEY] = { token: 'a' };
    mockMirror.enabled = false;
    expect(await opsMirror.sweep()).toEqual({ redriven: 0 });
    mockMirror.enabled = true;
    cache.isConnected.mockReturnValueOnce(false);
    expect(await opsMirror.sweep()).toEqual({ redriven: 0 });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

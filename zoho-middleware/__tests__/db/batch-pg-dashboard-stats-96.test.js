'use strict';

/**
 * Real-Postgres getDashboardStats new arrays — Phase 96 Plan 02. Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var TASK_ROW_KEYS = ['batch_id', 'completed', 'completed_day', 'due_date', 'is_packaging', 'is_transfer', 'task_id', 'title'];
var READING_KEYS = ['batch_id', 'degrees_plato', 'ph', 'reading_at', 'reading_day', 'temperature'];
var VESSEL_KEYS = ['archived', 'capacity_liters', 'type', 'vessel_id'];
var META_KEYS = ['batch_id', 'has_invoice_link', 'og', 'planned_days', 'recipe_name', 'recipe_style', 'target_fg'];
var PHASE94_TASK_KEYS = ['batch_id', 'completed', 'completed_day', 'due_date', 'is_packaging', 'is_transfer', 'task_id'];

describeDb('batch-pg-dashboard-stats-96', function () {
  var container;
  var pool;
  var read;
  var harness;
  var NOW = new Date('2026-10-23T06:30:00.000Z');

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    read = require('../../lib/batch-pg-read');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });

  function client() { return harness.client(); }

  function tok(n) {
    var s = String(n);
    while (s.length < 32) s = 'a' + s;
    return s;
  }

  async function insertBatch(n, fields) {
    var f = Object.assign({
      status: 'primary', start_date: '2026-10-01', zoho_so_number: '', recipe_snapshot: '',
      customer_name: 'Secret Person', notes: 'private note text'
    }, fields || {});
    var id = 'SV-B-' + String(n).padStart(6, '0');
    await client().query(
      'insert into batches (batch_id, status, start_date, batch_type, batch_type_source, customer_name, notes, ' +
      'recipe_snapshot, zoho_so_number, access_token, created_at, last_updated, vessel_id, source) ' +
      "values ($1,$2,$3,'wine','name',$4,$5,$6,$7,$8, now(), now(), 'V1', 'kiosk')",
      [id, f.status, f.start_date, f.customer_name, f.notes, f.recipe_snapshot, f.zoho_so_number, tok(n)]);
    return id;
  }

  async function insertTask(id, step, opts) {
    var o = Object.assign({ title: 'Task ' + step, dayOffset: 0, due: '2026-10-24', completed: false, completedAt: null }, opts || {});
    await client().query(
      'insert into batch_tasks (batch_id, step_number, title, day_offset, due_date, completed, completed_at, completed_by, last_updated) ' +
      "values ($1, $2, $3, $4, $5, $6, $7, 'shared@secret.example', now())",
      [id, step, o.title, o.dayOffset, o.due, o.completed, o.completedAt]);
  }

  async function insertReading(id, at, plato, temp, ph) {
    await client().query(
      'insert into plato_readings (batch_id, reading_at, degrees_plato, temperature, ph, notes, recorded_by, created_at) ' +
      "values ($1, $2, $3, $4, $5, 'reading secret note', 'brewer@secret.example', now())",
      [id, at, plato, temp, ph]);
  }

  async function insertVessel(vid, position, type, cap, archived) {
    await client().query(
      'insert into vessels (vessel_id, position, label, type, capacity_liters, archived, updated_at) values ($1,$2,$3,$4,$5,$6, now())',
      [vid, position, vid, type, cap, archived]);
  }

  it('taskRows: open tasks of active batches plus completed tasks of any batch, whitelisted keys', async function () {
    var pend = await insertBatch(1, { status: 'pending' });
    var prim = await insertBatch(2, { status: 'primary' });
    var done = await insertBatch(3, { status: 'complete' });
    await insertTask(pend, 1, { title: 'pending open' });
    await insertTask(prim, 1, { title: 'Rack to secondary' });
    await insertTask(done, 1, { title: 'old open on complete' });
    await insertTask(done, 2, { title: 'Bottling', completed: true, completedAt: '2026-10-10T05:00:00Z' });

    var res = await read.getDashboardStats(client(), { now: NOW });
    var rows = res.data.taskRows;
    var titles = rows.map(function (r) { return r.title; }).sort();
    expect(titles).toEqual(['Bottling', 'Rack to secondary']);
    rows.forEach(function (r) { expect(Object.keys(r).sort()).toEqual(TASK_ROW_KEYS); });
    var b = rows.filter(function (r) { return r.title === 'Bottling'; })[0];
    expect(b.completed).toBe(true);
    expect(b.completed_day).toBe('2026-10-09');
    var open = rows.filter(function (r) { return r.title === 'Rack to secondary'; })[0];
    expect(open.due_date).toBe('2026-10-24');
    expect(open.completed_day).toBeNull();
  });

  it('readings: every reading of primary/secondary batches only, ordered, numeric', async function () {
    var prim = await insertBatch(1, { status: 'primary' });
    var sec = await insertBatch(2, { status: 'secondary' });
    var done = await insertBatch(3, { status: 'complete' });
    await insertReading(prim, '2026-10-05T12:00:00Z', '12.5', '20.1', null);
    await insertReading(prim, '2026-10-02T12:00:00Z', '18.25', null, '3.4');
    await insertReading(sec, '2026-10-03T07:30:00Z', '9', '18', '3.5');
    await insertReading(done, '2026-10-03T07:30:00Z', '5', '18', '3.5');

    var res = await read.getDashboardStats(client(), { now: NOW });
    var rows = res.data.readings;
    expect(rows.length).toBe(3);
    rows.forEach(function (r) { expect(Object.keys(r).sort()).toEqual(READING_KEYS); });
    expect(rows.map(function (r) { return r.batch_id; })).toEqual([prim, prim, sec]);
    expect(rows[0].degrees_plato).toBe(18.25);
    expect(rows[0].temperature).toBeNull();
    expect(rows[0].ph).toBe(3.4);
    expect(rows[1].degrees_plato).toBe(12.5);
    expect(rows[2].reading_day).toBe('2026-10-03');
    expect(rows[2].degrees_plato).toBe(9);
  });

  it('vessels: includes archived, numeric capacity, ordered by position', async function () {
    await insertVessel('VZ-002', 20, 'Fermenter', '23.5', false);
    await insertVessel('VZ-001', 10, 'Carboy', null, true);

    var res = await read.getDashboardStats(client(), { now: NOW });
    var rows = res.data.vessels.filter(function (v) { return v.vessel_id === 'VZ-001' || v.vessel_id === 'VZ-002'; });
    rows.forEach(function (r) { expect(Object.keys(r).sort()).toEqual(VESSEL_KEYS); });
    expect(rows.map(function (v) { return v.vessel_id; })).toEqual(['VZ-001', 'VZ-002']);
    expect(rows[0].archived).toBe(true);
    expect(rows[0].capacity_liters).toBeNull();
    expect(rows[1].archived).toBe(false);
    expect(rows[1].capacity_liters).toBe(23.5);
  });

  it('batchMeta: invoice flag, planned_days and parsed snapshot fields', async function () {
    var a = await insertBatch(1, {
      zoho_so_number: 'SO-1',
      recipe_snapshot: '{"name":"Hazy","style":"NEIPA","og":15.2,"target_fg":3.1}'
    });
    var b = await insertBatch(2, { recipe_snapshot: '{"fg":2.5}' });
    var c = await insertBatch(3, { recipe_snapshot: 'not json' });
    var d = await insertBatch(4, { recipe_snapshot: '[]' });
    var e = await insertBatch(5, { recipe_snapshot: '{"og":1.050,"name":"' + new Array(201).join('x') + '"}' });
    var f = await insertBatch(6, { recipe_snapshot: '' });
    await insertTask(a, 1, { dayOffset: 3 });
    await insertTask(a, 2, { dayOffset: 21 });

    var res = await read.getDashboardStats(client(), { now: NOW });
    var meta = {};
    res.data.batchMeta.forEach(function (m) {
      expect(Object.keys(m).sort()).toEqual(META_KEYS);
      meta[m.batch_id] = m;
    });
    expect(meta[a]).toEqual({
      batch_id: a, has_invoice_link: true, planned_days: 21, recipe_name: 'Hazy', recipe_style: 'NEIPA', og: 15.2, target_fg: 3.1
    });
    expect(meta[b].has_invoice_link).toBe(false);
    expect(meta[b].planned_days).toBeNull();
    expect(meta[b].target_fg).toBe(2.5);
    [c, d, f].forEach(function (id) {
      expect(meta[id].recipe_name).toBe('');
      expect(meta[id].recipe_style).toBe('');
      expect(meta[id].og).toBeNull();
      expect(meta[id].target_fg).toBeNull();
    });
    expect(meta[e].og).toBeNull();
    expect(meta[e].recipe_name.length).toBe(120);
  });

  it('leak guard: no secrets in the new arrays; existing key sets unchanged', async function () {
    var a = await insertBatch(1, { zoho_so_number: 'SO-1', recipe_snapshot: '{"name":"Hazy","secret":"leakme"}' });
    await insertTask(a, 1, { completed: true, completedAt: '2026-10-10T05:00:00Z' });
    await insertReading(a, '2026-10-05T12:00:00Z', '12.5', '20', '3.4');
    await insertVessel('VZ-009', 90, 'Fermenter', '20', false);

    var res = await read.getDashboardStats(client(), { now: NOW });
    var blob = JSON.stringify([res.data.taskRows, res.data.readings, res.data.vessels, res.data.batchMeta]);
    ['Secret Person', 'private note text', 'reading secret note', 'brewer@secret.example',
      'shared@secret.example', 'SO-1', 'leakme', tok(1)].forEach(function (s) {
      expect(blob).not.toContain(s);
    });
    expect(blob).not.toMatch(/customer_|access_token|completed_by|recorded_by|notes|recipe_snapshot/);
    res.data.tasks.forEach(function (t) { expect(Object.keys(t).sort()).toEqual(PHASE94_TASK_KEYS); });
    expect(Object.keys(res.data).sort()).toEqual([
      'asOf', 'batchMeta', 'batches', 'inviteSentIds', 'latestReadings', 'readings', 'staffBatchIds', 'summary', 'taskRows', 'tasks', 'vessels'
    ]);
  });
});

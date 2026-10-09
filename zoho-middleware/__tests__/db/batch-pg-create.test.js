'use strict';

/**
 * Real-Postgres createBatch — Phase 87 Plan 07 (DB-06, D-13).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

var STEPS = [
  { step_number: 1, title: 'Pitch', description: 'Pitch yeast', day_offset: 0 },
  { step_number: 2, title: 'Check', description: '', day_offset: 3 },
  { step_number: 3, title: 'Rack', description: '', day_offset: 7, is_transfer: true },
  { title: 'No number', description: '', day_offset: 10 },
  { step_number: 5, title: 'Bottle', description: '', day_offset: -1, is_packaging: true },
  { step_number: 6, title: 'Late', description: '', day_offset: 30 }
];

describeDb('batch-pg-create', function () {
  var container;
  var pool;
  var create;
  var vesselPg;
  var harness;
  var NOW = new Date('2026-10-09T18:00:00.000Z');

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    jest.resetModules();
    var db = require('../../lib/db');
    create = require('../../lib/batch-pg-create');
    vesselPg = require('../../lib/vessel-pg');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () { return pool; });

  beforeEach(async function () {
    var c = harness.client();
    await c.query(
      'insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $4)',
      ['FS-0001', 'Six step', JSON.stringify(STEPS), NOW]
    );
    await c.query(
      "insert into vessels (vessel_id, type, status, updated_at) values ('FV-001', 'Fermenter', 'Empty', $1), ('FV-002', 'Fermenter', 'Empty', $1)",
      [NOW]
    );
  });

  function client() { return harness.client(); }
  function base(extra) {
    return Object.assign({
      product_sku: 'SKU-1', customer_name: 'Ann Brewer', schedule_id: 'FS-0001', start_date: '2026-10-10'
    }, extra || {});
  }
  function run(payload, o) {
    return create.createBatch(client(), payload, Object.assign({ actor: 'staff@example.com', now: NOW }, o || {}));
  }
  async function count(table) {
    return Number((await client().query('select count(*) as n from ' + table)).rows[0].n);
  }

  it('rejects missing sku/recipe and missing customer', async function () {
    expect((await run({ customer_name: 'A' })).error).toBe('missing_fields');
    expect((await run({ product_sku: 'S' })).error).toBe('missing_fields');
    expect(await count('batches')).toBe(0);
  });

  it('composes customer_name from first/last', async function () {
    var r = await run({ product_sku: 'S', customer_firstname: 'Ann', customer_lastname: 'Lee' });
    var row = (await client().query('select * from batches where batch_id = $1', [r.batch_id])).rows[0];
    expect(row.customer_name).toBe('Ann Lee');
  });

  it('creates a primary batch with tasks, history and vessel In-Use in one go', async function () {
    var r = await run(base({ vessel_id: 'FV-001', shelf_id: 'S1', bin_id: 2, notes: 'n' }));
    expect(r.ok).toBe(true);
    expect(r.tasks_created).toBe(6);
    expect(r.access_token).toMatch(/^[0-9a-f]{32}$/);
    expect(r.batch_id).toMatch(/^SV-B-[0-9]{6,}$/);
    expect(r._vesselApplied).toEqual(['FV-001']);

    var b = (await client().query('select * from batches where batch_id = $1', [r.batch_id])).rows[0];
    expect(b.status).toBe('primary');
    expect(b.created_by).toBe('staff@example.com');
    expect(b.created_at.getTime()).toBe(NOW.getTime());
    expect(b.last_updated.getTime()).toBe(NOW.getTime());
    expect(b.bin_id).toBe('2');
    expect(JSON.parse(b.schedule_snapshot)).toHaveLength(6);
    expect(b.fermentation_started_at.toISOString()).toBe('2026-10-10T00:00:00.000Z');

    var tasks = (await client().query('select * from batch_tasks where batch_id = $1 order by task_id', [r.batch_id])).rows;
    expect(tasks.map(function (t) { return t.step_number; })).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tasks.map(function (t) { return t.day_offset; })).toEqual([0, 3, 7, 10, -1, 30]);
    // due_date is a local-midnight Date from node-pg
    function ymd(d) { return d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : null; }
    expect(tasks.map(function (t) { return ymd(t.due_date); })).toEqual([
      '2026-10-10', '2026-10-13', '2026-10-17', '2026-10-20', null, '2026-11-09'
    ]);
    expect(tasks[2].is_transfer).toBe(true);
    expect(tasks[4].is_packaging).toBe(true);
    expect(tasks.every(function (t) { return t.completed === false; })).toBe(true);

    var h = (await client().query('select * from vessel_history where batch_id = $1', [r.batch_id])).rows;
    expect(h).toHaveLength(1);
    expect(h[0].notes).toBe('Initial placement');
    expect(h[0].vessel_id).toBe('FV-001');
    expect(h[0].transferred_by).toBe('staff@example.com');

    var v = (await client().query("select status from vessels where vessel_id = 'FV-001'")).rows[0];
    expect(v.status).toBe('In-Use');
  });

  it('ignores an unknown vessel for the status update', async function () {
    var r = await run(base({ vessel_id: 'FV-099' }));
    expect(r.ok).toBe(true);
    expect(r._vesselApplied).toEqual([]);
  });

  it('creates a pending batch without tasks, history or vessel change', async function () {
    var r = await run({ product_sku: 'S', customer_name: 'A', vessel_id: 'FV-001' });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('pending');
    expect(r.tasks_created).toBe(0);
    expect(await count('batch_tasks')).toBe(0);
    expect(await count('vessel_history')).toBe(0);
    expect((await client().query("select status from vessels where vessel_id = 'FV-001'")).rows[0].status).toBe('Empty');
    var b = (await client().query('select * from batches where batch_id = $1', [r.batch_id])).rows[0];
    expect(b.status).toBe('pending');
    expect(b.schedule_id).toBeNull();
    expect(b.fermentation_started_at).toBeNull();
  });

  it('is pending when a schedule is given but no start date', async function () {
    var r = await run(base({ start_date: '' }));
    expect(r.status).toBe('pending');
    expect(r.tasks_created).toBe(0);
  });

  it('returns not_found for an unknown schedule and writes nothing', async function () {
    var r = await run(base({ schedule_id: 'FS-9999' }));
    expect(r).toEqual({ ok: false, error: 'not_found', message: 'Schedule not found: FS-9999' });
    expect(await count('batches')).toBe(0);
  });

  it('ignores client-sent schedule_steps_json', async function () {
    var r = await run(base({ schedule_steps_json: JSON.stringify([{ title: 'evil', day_offset: 1 }]) }));
    expect(r.tasks_created).toBe(6);
  });

  it('returns location_conflict for an occupied slot and writes nothing more', async function () {
    var first = await run(base({ vessel_id: 'FV-001', shelf_id: 'S1', bin_id: '1' }));
    expect(first.ok).toBe(true);
    var r = await run(base({ customer_name: 'Bob', notes: 'x', vessel_id: 'FV-001', shelf_id: 'S1', bin_id: 1 }));
    expect(r).toEqual({ ok: false, error: 'location_conflict', message: 'Location already in use by batch ' + first.batch_id });
    expect(await count('batches')).toBe(1);
  });

  it('blanks customer_email for kiosk source and keeps it otherwise', async function () {
    var k = await run(base({ source: 'kiosk', customer_email: 'a@example.com', notes: 'k' }));
    var m = await run(base({ customer_email: 'a@example.com', notes: 'm' }));
    var rows = (await client().query('select batch_id, customer_email, source from batches')).rows;
    var byId = {};
    rows.forEach(function (x) { byId[x.batch_id] = x; });
    expect(byId[k.batch_id].customer_email).toBe('');
    expect(byId[k.batch_id].source).toBe('kiosk');
    expect(byId[m.batch_id].customer_email).toBe('a@example.com');
    expect(byId[m.batch_id].source).toBe('manual');
  });

  it('sanitises text fields and stores recipe fields', async function () {
    var r = await run(base({
      notes: 'hi<script>alert(1)</script>there', recipe_id: 'RCP-0001',
      recipe_snapshot: '{"a":1}', target_volume_l: 23.5, scale_factor: '1.5'
    }));
    var b = (await client().query('select * from batches where batch_id = $1', [r.batch_id])).rows[0];
    expect(b.notes).toBe('hithere');
    expect(b.recipe_id).toBe('RCP-0001');
    expect(b.recipe_snapshot).toBe('{"a":1}');
    expect(Number(b.target_volume_l)).toBe(23.5);
    expect(Number(b.scale_factor)).toBe(1.5);
  });

  it('rejects a non-numeric target volume and a malformed start date', async function () {
    expect((await run(base({ target_volume_l: 'abc' }))).error).toBe('invalid_number');
    expect((await run(base({ start_date: 'tomorrow' }))).error).toBe('invalid_start_date');
    expect(await count('batches')).toBe(0);
  });

  it('rolls everything back when the vessel step throws', async function () {
    var spy = jest.spyOn(vesselPg, 'applyStatusChanges').mockRejectedValue(new Error('boom'));
    var c = client();
    await c.query('savepoint outer_sp');
    await expect(run(base({ vessel_id: 'FV-001' }))).rejects.toThrow('boom');
    await c.query('rollback to savepoint outer_sp');
    spy.mockRestore();
    expect(await count('batches')).toBe(0);
    expect(await count('batch_tasks')).toBe(0);
    expect(await count('vessel_history')).toBe(0);
  });

  it('persists nothing when a real transaction fails after the batch insert', async function () {
    // Separate pooled connection with a genuine BEGIN/ROLLBACK, committed data only.
    var c = await pool.connect();
    var spy = jest.spyOn(vesselPg, 'applyStatusChanges').mockRejectedValue(new Error('boom'));
    try {
      await c.query('begin');
      await c.query('insert into ferm_schedules (schedule_id, name, steps, created_at, updated_at) values ($1, $2, $3::jsonb, $4, $4) on conflict do nothing', ['FS-7777', 'Tmp', JSON.stringify(STEPS), NOW]);
      await c.query('commit');
      await c.query('begin');
      await expect(create.createBatch(c, { product_sku: 'ROLL-1', customer_name: 'R', schedule_id: 'FS-7777', start_date: '2026-10-10', vessel_id: 'FV-001' }, { actor: 'x', now: NOW })).rejects.toThrow('boom');
      await c.query('rollback');
      var n = await c.query("select count(*) as n from batches where product_sku = 'ROLL-1'");
      expect(Number(n.rows[0].n)).toBe(0);
    } finally {
      spy.mockRestore();
      await c.query('delete from ferm_schedules where schedule_id = $1', ['FS-7777']);
      c.release();
    }
  });
});

'use strict';

/**
 * Real-Postgres staff-access-pg semantics — Phase 86 Plan 07 (DB-05, D-03).
 * Runs only via `npm run test:db`.
 */

var pgHarness = require('./helpers/pg-harness');
var describeDb = pgHarness.describeDb;

describeDb('staff-access-pg', function () {
  var container;
  var pool;
  var sp;
  var harness;

  beforeAll(async function () {
    var started = await pgHarness.startPostgres();
    container = started.container;
    var migrateResult = pgHarness.applyMigrations(started.connectionString);
    if (migrateResult.code !== 0) {
      throw new Error('applyMigrations failed: ' + migrateResult.stderr);
    }
    jest.resetModules();
    var db = require('../../lib/db');
    sp = require('../../lib/staff-access-pg');
    pool = db.createPool(started.connectionString);
  }, 120000);

  afterAll(async function () {
    if (pool) await pool.end();
    if (container) await container.stop();
  }, 60000);

  harness = pgHarness.rollbackEachTest(function () {
    return pool;
  });

  async function seed(client, email, role) {
    await client.query('insert into staff_access (email, role, added_by) values ($1, $2, $3)', [email, role, 'seed@x.co']);
  }

  async function auditRows(client) {
    var r = await client.query('select * from staff_access_audit order by id');
    return r.rows;
  }

  it('addStaff normalises the email and writes an add audit row', async function () {
    var c = harness.client();
    var res = await sp.addStaff(c, { actor: 'Owner@X.co', target: ' New@Y.co ', role: 'staff', breakGlass: [] });
    expect(res).toEqual({ ok: true });
    var row = (await c.query("select * from staff_access where email = 'new@y.co'")).rows[0];
    expect(row.role).toBe('staff');
    expect(row.added_by).toBe('owner@x.co');
    var a = await auditRows(c);
    expect(a).toHaveLength(1);
    expect(a[0].action).toBe('add');
    expect(a[0].actor_email).toBe('owner@x.co');
    expect(a[0].target_email).toBe('new@y.co');
    expect(a[0].role_after).toBe('staff');
  });

  it('addStaff rejects duplicates, bad roles and bad emails', async function () {
    var c = harness.client();
    await seed(c, 'dup@x.co', 'staff');
    expect((await sp.addStaff(c, { actor: 'o@x.co', target: 'DUP@x.co', role: 'staff' })).error).toBe('staff_exists');
    expect((await sp.addStaff(c, { actor: 'o@x.co', target: 'a@x.co', role: 'admin' })).error).toBe('invalid_role');
    expect((await sp.addStaff(c, { actor: 'o@x.co', target: 'nope', role: 'staff' })).error).toBe('invalid_email');
    expect(await auditRows(c)).toHaveLength(0);
  });

  it('removeStaff rejects self-removal, break-glass members and unknown targets', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'b@x.co', 'owner');
    expect((await sp.removeStaff(c, { actor: 'a@x.co', target: 'A@x.co', breakGlass: [] })).error).toBe('cannot_remove_self');
    expect((await sp.removeStaff(c, { actor: 'a@x.co', target: 'b@x.co', breakGlass: ['b@x.co'] })).error).toBe('break_glass_member');
    expect((await sp.removeStaff(c, { actor: 'a@x.co', target: 'ghost@x.co', breakGlass: [] })).error).toBe('not_found');
  });

  it('removes one of two owners, then cannot remove the last one', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'b@x.co', 'owner');
    var ok = await sp.removeStaff(c, { actor: 'a@x.co', target: 'b@x.co', breakGlass: [] });
    expect(ok).toEqual({ ok: true, role_before: 'owner' });
    var last = await sp.removeStaff(c, { actor: 'c@x.co', target: 'a@x.co', breakGlass: [] });
    expect(last.ok).toBe(false);
    expect(last.error).toBe('last_owner');
    expect(last.message).toMatch(/at least one owner/i);
  });

  it('promoting staff to owner lets the original owner be removed', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'c@x.co', 'staff');
    expect((await sp.changeRole(c, { actor: 'a@x.co', target: 'c@x.co', role: 'owner', breakGlass: [] })).ok).toBe(true);
    expect((await sp.removeStaff(c, { actor: 'c@x.co', target: 'a@x.co', breakGlass: [] })).ok).toBe(true);
  });

  it('demoting the only owner is rejected as last_owner', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    var res = await sp.changeRole(c, { actor: 'c@x.co', target: 'a@x.co', role: 'staff', breakGlass: [] });
    expect(res.error).toBe('last_owner');
    expect((await c.query("select role from staff_access where email = 'a@x.co'")).rows[0].role).toBe('owner');
  });

  it('changeRole rejects self-demotion, break-glass members, unknown targets and bad roles', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'b@x.co', 'owner');
    expect((await sp.changeRole(c, { actor: 'a@x.co', target: 'a@x.co', role: 'staff', breakGlass: [] })).error).toBe('cannot_change_own_role');
    expect((await sp.changeRole(c, { actor: 'a@x.co', target: 'b@x.co', role: 'staff', breakGlass: ['b@x.co'] })).error).toBe('break_glass_member');
    expect((await sp.changeRole(c, { actor: 'a@x.co', target: 'z@x.co', role: 'staff', breakGlass: [] })).error).toBe('not_found');
    expect((await sp.changeRole(c, { actor: 'a@x.co', target: 'b@x.co', role: 'root', breakGlass: [] })).error).toBe('invalid_role');
  });

  it('a break-glass member without a row counts as an owner', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    var res = await sp.removeStaff(c, { actor: 'bg@x.co', target: 'a@x.co', breakGlass: ['bg@x.co'] });
    expect(res.ok).toBe(true);
  });

  it('a break-glass member WITH a staff row does not count as an owner', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'bg@x.co', 'staff');
    var res = await sp.removeStaff(c, { actor: 'bg@x.co', target: 'a@x.co', breakGlass: ['bg@x.co'] });
    expect(res.error).toBe('last_owner');
  });

  it('changeRole and removeStaff write audit rows with role_before / role_after', async function () {
    var c = harness.client();
    await seed(c, 'a@x.co', 'owner');
    await seed(c, 'b@x.co', 'owner');
    await sp.changeRole(c, { actor: 'a@x.co', target: 'b@x.co', role: 'staff', breakGlass: [] });
    await sp.removeStaff(c, { actor: 'a@x.co', target: 'b@x.co', breakGlass: [] });
    var a = await auditRows(c);
    expect(a.map(function (r) { return r.action; })).toEqual(['role_change', 'remove']);
    expect(a[0].role_before).toBe('owner');
    expect(a[0].role_after).toBe('staff');
    expect(a[1].role_before).toBe('staff');
    expect(a[1].role_after).toBeNull();
  });

  it('recordDenied writes a denied row and listAudit returns newest first', async function () {
    var c = harness.client();
    await sp.addStaff(c, { actor: 'a@x.co', target: 'n@x.co', role: 'staff', breakGlass: [] });
    await sp.recordDenied(c, { actor: 'a@x.co', target: 'a@x.co', note: 'tried to remove self' });
    var list = await sp.listAudit(c, { limit: 10 });
    expect(list).toHaveLength(2);
    expect(list[0].action).toBe('denied');
    expect(list[0].note).toBe('tried to remove self');
    expect(list[1].action).toBe('add');
    var capped = await sp.listAudit(c, { limit: 100000 });
    expect(capped.length).toBeLessThanOrEqual(200);
  });

  it('listStaff orders owners first then by email, and getRole reads one role', async function () {
    var c = harness.client();
    await seed(c, 'z@x.co', 'owner');
    await seed(c, 'b@x.co', 'staff');
    await seed(c, 'a@x.co', 'staff');
    var list = await sp.listStaff(c);
    expect(list.map(function (r) { return r.email; })).toEqual(['z@x.co', 'a@x.co', 'b@x.co']);
    expect(await sp.getRole(c, 'B@x.co')).toBe('staff');
    expect(await sp.getRole(c, 'nobody@x.co')).toBeNull();
  });

  it('concurrent mutual removal: exactly one of two owners succeeds', async function () {
    await pool.query("insert into staff_access (email, role, added_by) values ('ca@x.co','owner','seed'), ('cb@x.co','owner','seed')");
    var c1 = await pool.connect();
    var c2 = await pool.connect();
    try {
      async function run(client, actor, target) {
        await client.query('BEGIN');
        try {
          var res = await sp.removeStaff(client, { actor: actor, target: target, breakGlass: [] });
          await client.query('COMMIT');
          return res;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
      var results = await Promise.all([
        run(c1, 'ca@x.co', 'cb@x.co'),
        run(c2, 'cb@x.co', 'ca@x.co')
      ]);
      var oks = results.filter(function (r) { return r.ok; });
      var rejected = results.filter(function (r) { return !r.ok; });
      expect(oks).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].error).toBe('last_owner');
      var left = await pool.query("select email from staff_access where email in ('ca@x.co','cb@x.co')");
      expect(left.rows).toHaveLength(1);
    } finally {
      c1.release();
      c2.release();
      await pool.query("delete from staff_access where email in ('ca@x.co','cb@x.co')");
      await pool.query("delete from staff_access_audit where actor_email in ('ca@x.co','cb@x.co')");
    }
  });

  it('audit atomicity: a failing audit insert rolls the staff change back', async function () {
    await pool.query("insert into staff_access (email, role, added_by) values ('at1@x.co','owner','seed'), ('at2@x.co','staff','seed')");
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      var threw = false;
      try {
        // actor null -> audit.actor_email NOT NULL violation after the delete has run
        await sp.removeStaff(client, { actor: null, target: 'at2@x.co', breakGlass: [] });
      } catch (e) {
        threw = true;
      }
      expect(threw).toBe(true);
      await client.query('ROLLBACK');
      var still = await pool.query("select email from staff_access where email = 'at2@x.co'");
      expect(still.rows).toHaveLength(1);
      var audits = await pool.query("select id from staff_access_audit where target_email = 'at2@x.co'");
      expect(audits.rows).toHaveLength(0);
    } finally {
      client.release();
      await pool.query("delete from staff_access where email in ('at1@x.co','at2@x.co')");
    }
  });
});

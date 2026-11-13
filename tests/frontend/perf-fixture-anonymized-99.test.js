'use strict';

// Phase 99-01: guards the committed perf fixture. Everything under tests/ is publicly
// served on production, so the fixture must hold no personal data or capability tokens.

var fs = require('fs');
var path = require('path');
var anon = require('../perf/anonymize');

var anonymizeFixture = anon.anonymizeFixture;
var KEEP_KEYS = anon.KEEP_KEYS;

describe('anonymizeFixture rules', function () {
  test('exports a non-empty KEEP_KEYS allowlist', function () {
    expect(Array.isArray(KEEP_KEYS)).toBe(true);
    expect(KEEP_KEYS.length).toBeGreaterThan(10);
  });

  test('unknown string keys are redacted (allowlist-first)', function () {
    var out = anonymizeFixture({ mystery_field: 'Some Real Value', batch_id: 'SV-B-000001' });
    expect(out.mystery_field).toBe('Redacted text');
    expect(out.batch_id).toBe('SV-B-000001');
  });

  test('emails become customer{N}@example.test, deterministic per input', function () {
    var out = anonymizeFixture({ rows: [
      { customer_email: 'a@real.com' }, { email: 'b@real.com' }, { customer_email: 'a@real.com' },
      { bottling_invite_email: 'a@real.com' }
    ] });
    expect(out.rows[0].customer_email).toMatch(/^customer\d+@example\.test$/);
    expect(out.rows[2].customer_email).toBe(out.rows[0].customer_email);
    expect(out.rows[3].bottling_invite_email).toBe(out.rows[0].customer_email);
    expect(out.rows[1].email).not.toBe(out.rows[0].customer_email);
    expect(JSON.stringify(out)).not.toMatch(/real\.com/);
  });

  test('phone-like keys become 555-0100', function () {
    var out = anonymizeFixture({ customer_phone: '604-555-1234', mobile: '7785551234', tel: '1' });
    expect(out.customer_phone).toBe('555-0100');
    expect(out.mobile).toBe('555-0100');
    expect(out.tel).toBe('555-0100');
  });

  test('customer/contact name keys become Customer {N}, deterministic; recipe/product/vessel names kept', function () {
    var out = anonymizeFixture({
      batches: [
        { customer_name: 'Jane Doe', customer_firstname: 'Jane', customer_lastname: 'Doe', product_name: 'Merlot Kit' },
        { customer_name: 'Jane Doe', product_name: 'Merlot Kit' },
        { customer_name: 'John Roe' }
      ],
      recipe_snapshot_like: { name: 'House Pale Ale' },
      vessels: [{ vessel_id: 'V-1', type: 'carboy' }],
      contact: { name: 'Jane Doe', email: 'jane@real.com' }
    });
    expect(out.batches[0].customer_name).toMatch(/^Customer \d+$/);
    expect(out.batches[1].customer_name).toBe(out.batches[0].customer_name);
    expect(out.batches[2].customer_name).not.toBe(out.batches[0].customer_name);
    expect(out.batches[0].customer_firstname).toMatch(/^Customer \d+$/);
    expect(out.batches[0].customer_lastname).toMatch(/^Customer \d+$/);
    expect(out.batches[0].product_name).toBe('Merlot Kit');
    expect(out.recipe_snapshot_like.name).toBe('House Pale Ale');
    expect(out.vessels[0].type).toBe('carboy');
    expect(out.contact.name).toMatch(/^Customer \d+$/);
    expect(JSON.stringify(out)).not.toMatch(/Jane|Doe|Roe|John/);
  });

  test('token/secret/password/session/signature keys become "redacted"', function () {
    var out = anonymizeFixture({ public_token: 'abc', client_secret: 'x', password: 'p', session_id: 's', signature: 'z' });
    Object.keys(out).forEach(function (k) { expect(out[k]).toBe('redacted'); });
  });

  test('free-text keys become Redacted text', function () {
    var out = anonymizeFixture({ notes: 'call her', note: 'x', comment: 'y', message: 'z', description: 'd', address: '1 Main St' });
    Object.keys(out).forEach(function (k) { expect(out[k]).toBe('Redacted text'); });
  });

  test('contact/customer ids are pseudonymised deterministically', function () {
    var out = anonymizeFixture({ rows: [
      { customer_id: '123456789012345678' }, { customer_id: '123456789012345678' }, { customer_id: '999' },
      { zoho_contact_id: '555' }, { id: 'ml-uuid-1' }
    ] });
    expect(out.rows[0].customer_id).toBe(out.rows[1].customer_id);
    expect(out.rows[0].customer_id).not.toBe(out.rows[2].customer_id);
    expect(out.rows[0].customer_id).not.toMatch(/123456/);
    expect(out.rows[3].zoho_contact_id).not.toBe('555');
    expect(out.rows[4].id).not.toBe('ml-uuid-1');
  });

  test('ids, dates, numbers, booleans, null, empty strings and array lengths are unchanged', function () {
    var input = {
      batch_id: 'SV-B-000123', due_date: '2026-11-01', created_at: '2026-10-01T10:00:00.000Z',
      status: 'active', count: 5, flag: true, none: null, bin_id: '',
      staffBatchIds: ['SV-B-000001', 'SV-B-000002'], list: [1, 2, 3]
    };
    expect(anonymizeFixture(input)).toEqual(input);
  });

  test('JSON-string snapshots are parsed and anonymised inside', function () {
    var snap = JSON.stringify([{ title: 'Rack', description: 'Call Jane Doe', step_number: 1 }]);
    var out = anonymizeFixture({ schedule_snapshot: snap });
    var parsed = JSON.parse(out.schedule_snapshot);
    expect(parsed[0].title).toBe('Rack');
    expect(parsed[0].description).toBe('Redacted text');
    expect(parsed[0].step_number).toBe(1);
  });

  test('a kept key holding an @ or phone-like value is still redacted', function () {
    var out = anonymizeFixture({ product_name: 'x@y.com', title: 'call 6045551234' });
    expect(out.product_name).toBe('Redacted text');
    expect(out.title).toBe('Redacted text');
  });

  test('is pure: does not mutate its input', function () {
    var input = { customer_email: 'a@real.com' };
    anonymizeFixture(input);
    expect(input.customer_email).toBe('a@real.com');
  });

  test('month labels are kept under label, other labels redacted', function () {
    var out = anonymizeFixture({ a: [{ label: 'Jan' }, { label: 'Someone Special' }] });
    expect(out.a[0].label).toBe('Jan');
    expect(out.a[1].label).toBe('Redacted text');
  });
});

describe('committed fixture (tests/perf/fixture/dashboard-fixture.json)', function () {
  var FIXTURE = path.join(__dirname, '..', 'perf', 'fixture', 'dashboard-fixture.json');
  var text = fs.readFileSync(FIXTURE, 'utf8');
  var fx = JSON.parse(text);

  test('has the shape the harness needs', function () {
    ['get_dashboard_stats', 'get_batches', 'get_vessels', 'get_ferm_schedules', 'get_tasks_upcoming', 'get_waitlist'].forEach(function (k) {
      expect(fx[k]).toBeTruthy();
    });
    expect(fx.__rest['/api/admin/dashboard-cards']).toBeTruthy();
    expect(fx.get_dashboard_stats.data.batches.length).toBeGreaterThan(50);
  });

  test('every email-like string is on example.test', function () {
    var found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) || [];
    var bad = found.filter(function (s) { return !/@example\.test$/.test(s); });
    expect(bad).toEqual([]);
  });

  test('no 10-digit phone-like run', function () {
    expect(text.match(/\b\d{10}\b/g) || []).toEqual([]);
    expect(text.match(/\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g) || []).toEqual([]);
  });

  test('no long hex/base64url token-like run', function () {
    expect(text.match(/\b[A-Za-z0-9_-]{24,}\b/g) || []).toEqual([]);
  });

  test('no customer name remains: customer fields are placeholders', function () {
    var rows = fx.get_batches.data.batches;
    rows.forEach(function (b) {
      ['customer_name', 'customer_firstname', 'customer_lastname'].forEach(function (k) {
        if (b[k]) { expect(b[k]).toMatch(/^Customer \d+$/); }
      });
      if (b.customer_phone) { expect(b.customer_phone).toBe('555-0100'); }
    });
  });

  test('no real-looking object key (keys are schema names only)', function () {
    var keys = {};
    (function walk(v) {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { keys[k] = 1; walk(v[k]); }); }
    })(fx);
    Object.keys(keys).forEach(function (k) { expect(k).toMatch(/^[A-Za-z0-9_./-]+$/); });
  });
});

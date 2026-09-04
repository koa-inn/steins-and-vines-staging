'use strict';

// ---------------------------------------------------------------------------
// Phase 80-03: renderWaitlist coverage -- the horizontal-scroll wrapper, the
// D-02 Customer cell, and the D-15/D-16 Recipes cell. Follows the jsdom
// render-test harness established by brewpad-invite-tracking.test.js
// (document.body.innerHTML seed + a test-only render seam).
//
// Assertion style note (Task 2 <action> item 5, re-affirmed by Task 3): the
// "Customer cell" and "Recipes cell" describe blocks below use ONLY
// contains/substring assertions (toContain / not.toContain, or element
// counts) -- never toBe/toEqual against a cell's textContent/innerHTML.
// Plan 80-04 injects further markup into these same two cells (a "Link
// customer"/"Change" trigger, a "+ Attach recipe" trigger, a per-chip remove
// control, and swaps the chip label from the raw recipe id to the
// catalog-resolved name) and owns none of this file, so an exact-match
// assertion here is guaranteed to break wave 2 even though the code is
// correct. Assertions outside those two blocks may stay exact-match.
// ---------------------------------------------------------------------------

global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

function renderWithRows(rows) {
  document.body.innerHTML = '<div id="bp-panel-waitlist"></div>';
  bp._setWaitlistStateForTest({ rows: rows, filter: 'all', search: '' });
  bp.renderWaitlist();
  return document.getElementById('bp-panel-waitlist');
}

var LINKED_ROW = {
  id: 'w1',
  email: 'jane@example.com',
  status: 'waiting',
  signed_up_at: '2026-08-15T08:00:00.000Z',
  zoho_contact_id: 'zc-1',
  customer_name: 'Jane Smith',
  customer_phone: '604-555-0123',
  recipe_ids: '',
  mailerlite_synced: true
};

describe('renderWaitlist — table structure', function () {
  test('is exported and callable', function () {
    expect(typeof bp.renderWaitlist).toBe('function');
  });

  test('wraps the table in exactly one .bp-waitlist-table-wrap', function () {
    var panel = renderWithRows([LINKED_ROW]);
    expect(panel.querySelectorAll('.bp-waitlist-table-wrap').length).toBe(1);
    expect(panel.querySelector('.bp-waitlist-table-wrap .bp-active-batches-table')).not.toBeNull();
  });

  test('header row includes Customer and Recipes columns', function () {
    var panel = renderWithRows([LINKED_ROW]);
    var headerText = Array.prototype.map.call(panel.querySelectorAll('thead th'), function (th) {
      return th.textContent;
    });
    expect(headerText).toContain('Customer');
    expect(headerText).toContain('Recipes');
  });
});

describe('Customer cell', function () {
  test('a linked row renders name — email — phone', function () {
    var panel = renderWithRows([LINKED_ROW]);
    var cell = panel.querySelectorAll('tbody tr td')[1];
    expect(cell.textContent).toContain('Jane Smith');
    expect(cell.textContent).toContain('jane@example.com');
    expect(cell.textContent).toContain('604-555-0123');
    expect(cell.textContent).toContain('Jane Smith — jane@example.com — 604-555-0123');
  });

  test('a linked row with an empty phone omits the phone segment and its leading separator', function () {
    var row = Object.assign({}, LINKED_ROW, { customer_phone: '' });
    var panel = renderWithRows([row]);
    var cell = panel.querySelectorAll('tbody tr td')[1];
    expect(cell.textContent).toContain('Jane Smith — jane@example.com');
    expect(cell.textContent).not.toContain('jane@example.com —');
  });

  test('an unlinked row renders the bare email', function () {
    var row = {
      id: 'w2', email: 'unlinked@example.com', status: 'waiting',
      signed_up_at: '2026-08-16T08:00:00.000Z', zoho_contact_id: '', recipe_ids: '',
      mailerlite_synced: false
    };
    var panel = renderWithRows([row]);
    var cell = panel.querySelectorAll('tbody tr td')[1];
    expect(cell.textContent).toContain('unlinked@example.com');
    expect(cell.textContent).not.toContain('—');
  });

  test('a customer_name containing <script> renders escaped text with no script element', function () {
    var row = Object.assign({}, LINKED_ROW, { customer_name: '<script>alert(1)</script>Jane' });
    var panel = renderWithRows([row]);
    expect(panel.querySelector('script')).toBeNull();
    var cell = panel.querySelectorAll('tbody tr td')[1];
    expect(cell.textContent).toContain('<script>alert(1)</script>Jane');
  });
});

describe('Recipes cell', function () {
  test('recipe_ids of two ids renders two chips in stored order', function () {
    var row = Object.assign({}, LINKED_ROW, { recipe_ids: 'SV-R-000003|SV-R-000007' });
    var panel = renderWithRows([row]);
    var cell = panel.querySelectorAll('tbody tr td')[2];
    var chips = cell.querySelectorAll('.bp-batch-chip-inline');
    expect(chips.length).toBe(2);
    expect(chips[0].textContent).toContain('SV-R-000003');
    expect(chips[1].textContent).toContain('SV-R-000007');
  });

  test('an empty recipe_ids renders "No recipes attached"', function () {
    var row = Object.assign({}, LINKED_ROW, { recipe_ids: '' });
    var panel = renderWithRows([row]);
    var cell = panel.querySelectorAll('tbody tr td')[2];
    expect(cell.textContent).toContain('No recipes attached');
    expect(cell.querySelectorAll('.bp-batch-chip-inline').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3: pin marker, inline position editor, clear-pin (D-10-D-14). These
// target the `#` cell only, which plan 80-04 does not touch, so they may be
// exact-match (unlike the two blocks above).
// ---------------------------------------------------------------------------

describe('Pin marker and inline position editor (D-10-D-14)', function () {
  beforeEach(function () {
    global.fetch.mockReset();
    global.fetch.mockImplementation(function () {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve({ ok: true, data: {} }); }
      });
    });
  });

  function postedBodies() {
    return global.fetch.mock.calls.map(function (c) {
      try { return JSON.parse(c[1].body); } catch (e) { return null; }
    });
  }

  test('a pinned waiting row renders the pin glyph and its position number', function () {
    var row = Object.assign({}, LINKED_ROW, { status: 'waiting', position: 3 });
    var panel = renderWithRows([row]);
    var posCell = panel.querySelectorAll('tbody tr td')[0];
    expect(posCell.textContent).toContain('📌');
    expect(posCell.textContent).toContain('3');
  });

  test('a pinned non-waiting row renders "📌 —"', function () {
    var row = Object.assign({}, LINKED_ROW, { status: 'contacted', position: 2 });
    var panel = renderWithRows([row]);
    var posCell = panel.querySelectorAll('tbody tr td')[0];
    expect(posCell.textContent).toContain('📌');
    expect(posCell.textContent).toContain('—');
  });

  test('an unpinned non-waiting row renders plain "—"', function () {
    var row = Object.assign({}, LINKED_ROW, { status: 'contacted', position: '' });
    var panel = renderWithRows([row]);
    var posCell = panel.querySelectorAll('tbody tr td')[0];
    expect(posCell.textContent).toContain('—');
    expect(posCell.querySelector('.bp-waitlist-pin-marker')).toBeNull();
  });

  test('the pin button carries the correct aria-label on every row', function () {
    var panel = renderWithRows([LINKED_ROW]);
    var pinBtn = panel.querySelector('[data-waitlist-pin-id]');
    expect(pinBtn).not.toBeNull();
    expect(pinBtn.getAttribute('aria-label')).toBe("Pin this row's position");
  });

  test('the clear control carries aria-label="Clear pin" only on a pinned row', function () {
    var pinnedRow = Object.assign({}, LINKED_ROW, { position: 1 });
    var panel = renderWithRows([pinnedRow]);
    var clearBtn = panel.querySelector('[data-waitlist-clear-pin-id]');
    expect(clearBtn).not.toBeNull();
    expect(clearBtn.getAttribute('aria-label')).toBe('Clear pin');

    var unpinnedPanel = renderWithRows([LINKED_ROW]);
    expect(unpinnedPanel.querySelector('[data-waitlist-clear-pin-id]')).toBeNull();
  });

  test('saving position 0 shows the inline error and issues no fetch', function () {
    var panel = renderWithRows([LINKED_ROW]);
    var posCell = panel.querySelectorAll('tbody tr td')[0];
    bp._openWaitlistPositionEditForTest(posCell, LINKED_ROW.id);
    bp._saveWaitlistPositionForTest(posCell, LINKED_ROW.id, '0');
    expect(posCell.querySelector('.bp-waitlist-pos-error').textContent).toBe('Enter a position of 1 or higher.');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('saving position 2 issues exactly one adminApiPost with payload {action, id, position} and nothing else', function () {
    var panel = renderWithRows([LINKED_ROW]);
    var posCell = panel.querySelectorAll('tbody tr td')[0];
    bp._openWaitlistPositionEditForTest(posCell, LINKED_ROW.id);
    return bp._saveWaitlistPositionForTest(posCell, LINKED_ROW.id, '2').then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = postedBodies()[0];
      expect(body).toEqual({ action: 'update_waitlist_status', id: LINKED_ROW.id, position: 2 });
    });
  });

  test('clearing a pin sends position: \'\'', function () {
    renderWithRows([Object.assign({}, LINKED_ROW, { position: 1 })]);
    return bp._clearWaitlistPinForTest(LINKED_ROW.id).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = postedBodies()[0];
      expect(body).toEqual({ action: 'update_waitlist_status', id: LINKED_ROW.id, position: '' });
    });
  });

  test('no code path calls showConfirmSheet for saving or clearing a pin', function () {
    renderWithRows([Object.assign({}, LINKED_ROW, { position: 1 })]);
    return bp._clearWaitlistPinForTest(LINKED_ROW.id).then(function () {
      var sheet = document.getElementById('bp-confirm-sheet');
      expect(sheet === null || !sheet.classList.contains('bp-confirm-sheet--visible')).toBe(true);
    });
  });
});

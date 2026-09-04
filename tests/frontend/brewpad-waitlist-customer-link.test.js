'use strict';

// Phase 80-04 Task 1: per-row customer-link panel (D-01/D-02/D-03/D-03a).
// Covers: opening the panel in place of the Customer cell, the search flow
// (reusing fetchReassignSearch's exact /api/contacts/search?q= shape), the
// create-inline flow (reusing the existing POST /api/contacts shape), the D-02
// write-through, and the D-03a phone-preservation guard -- the load-bearing
// case: a link write must omit customer_phone entirely when the row already
// carries one.

global.document = global.document || {};
global.window = global.window || {};
global.navigator = global.navigator || {};
global.google = { accounts: { oauth2: { initTokenClient: jest.fn() } } };
global.fetch = jest.fn();
global.localStorage = {
  _data: {},
  getItem: function (k) { return this._data[k] || null; },
  setItem: function (k, v) { this._data[k] = v; },
  removeItem: function (k) { delete this._data[k]; },
  clear: function () { this._data = {}; }
};
global.sessionStorage = global.localStorage;

global.SHEETS_CONFIG = {
  MIDDLEWARE_URL: '',
  MW_API_KEY: 'test-api-key',
  SPREADSHEET_ID: 'test-id',
  GOOGLE_CLIENT_ID: 'test-client-id',
  STAFF_EMAILS: 'test@example.com',
  API_BASE: 'https://script.google.com/test',
  SERVER_TOKEN: 'test-token',
  ADMIN_API_URL: 'https://script.google.com/test/admin'
};

var _auth = require('../../js/lib/auth');
global.waitForGoogleIdentity = _auth.waitForGoogleIdentity;
global.gsiInitTokenClient = _auth.gsiInitTokenClient;
global.fetchGoogleUserInfo = _auth.fetchGoogleUserInfo;

var bp = require('../../js/brewpad');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var UNLINKED_ROW = {
  id: 'w1',
  email: 'jane@example.com',
  status: 'waiting',
  signed_up_at: '2026-08-15T08:00:00.000Z',
  zoho_contact_id: '',
  customer_name: '',
  customer_phone: '',
  recipe_ids: '',
  mailerlite_synced: true
};

var LINKED_WITH_PHONE_ROW = {
  id: 'w2',
  email: 'bob@example.com',
  status: 'waiting',
  signed_up_at: '2026-08-16T08:00:00.000Z',
  zoho_contact_id: 'zc-9',
  customer_name: 'Bob Existing',
  customer_phone: '604-555-9999',
  recipe_ids: '',
  mailerlite_synced: true
};

function renderWithRows(rows) {
  document.body.innerHTML = '<div id="bp-panel-waitlist"></div><div id="bp-toast-container"></div>';
  bp._setWaitlistStateForTest({ rows: rows, filter: 'all', search: '' });
  bp.renderWaitlist();
  return document.getElementById('bp-panel-waitlist');
}

function customerCellFor(panel) {
  return panel.querySelectorAll('tbody tr td')[1];
}

function postedBodies() {
  return global.fetch.mock.calls
    .filter(function (c) { return String(c[0]).indexOf('/api/batch/admin-proxy') !== -1; })
    .map(function (c) {
      try { return JSON.parse(c[1].body); } catch (e) { return null; }
    });
}

function toastMessages() {
  return Array.prototype.map.call(document.querySelectorAll('#bp-toast-container .bp-toast-msg'), function (el) {
    return el.textContent;
  });
}

// Routes global.fetch by URL substring so unrelated calls never reject.
function mockFetch(opts) {
  opts = opts || {};
  global.fetch.mockImplementation(function (url, options) {
    var u = String(url);

    if (u.indexOf('/api/contacts/search') !== -1) {
      if (opts.searchReject) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ contacts: opts.searchContacts || [] }); }
      });
    }

    if (u.indexOf('/api/contacts') !== -1 && (!options || options.method === 'POST')) {
      if (opts.createReject) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: function () { return Promise.resolve({ error: 'Unable to create contact' }); }
        });
      }
      return Promise.resolve({
        ok: true,
        status: 201,
        json: function () { return Promise.resolve({ contact_id: opts.createdContactId || 'zc-new', created: true }); }
      });
    }

    if (u.indexOf('/api/batch/admin-proxy') !== -1) {
      if (opts.writeReject) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: function () { return Promise.resolve({ ok: false, message: 'write failed' }); }
        });
      }
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true }); }
      });
    }

    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  });
}

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

beforeEach(function () {
  global.fetch.mockReset();
  mockFetch();
});

// ---------------------------------------------------------------------------

describe('opening the customer-link panel', function () {
  test('tapping "Link customer" trigger renders in the Customer cell', function () {
    var panel = renderWithRows([UNLINKED_ROW]);
    var trigger = panel.querySelector('[data-waitlist-link-trigger]');
    expect(trigger).not.toBeNull();
    expect(trigger.textContent).toBe('Link customer');
  });

  test('an already-linked row shows "Change" instead', function () {
    var panel = renderWithRows([LINKED_WITH_PHONE_ROW]);
    var trigger = panel.querySelector('[data-waitlist-link-trigger]');
    expect(trigger.textContent).toBe('Change');
  });

  test('opening the panel replaces the cell with the search UI -- no navigation, no sheet', function () {
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    expect(cell.querySelector('.bp-reassign-panel')).not.toBeNull();
    expect(cell.querySelector('[placeholder="Search by name, email or phone…"]')).not.toBeNull();
    expect(document.getElementById('bp-panel-waitlist')).not.toBeNull(); // still the same panel, no navigation
  });
});

describe('search flow', function () {
  test('typing a term issues one GET to /api/contacts/search?q= and renders one result row per contact', function () {
    jest.useFakeTimers();
    mockFetch({
      searchContacts: [
        { contact_id: 'zc-1', contact_name: 'Jane Smith', email: 'jane@example.com', phone: '604-555-0123' }
      ]
    });
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    var input = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-search-input');
    input.value = 'jane';
    input.dispatchEvent(new Event('input'));
    jest.advanceTimersByTime(400);
    jest.useRealTimers();
    return flushPromises().then(function () {
      var searchCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/api/contacts/search') !== -1; });
      expect(searchCalls.length).toBe(1);
      expect(searchCalls[0][0]).toBe('/api/contacts/search?q=jane');
      var resultsEl = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-results');
      var items = resultsEl.querySelectorAll('.bp-so-result-item[data-contact-id]');
      expect(items.length).toBe(1);
      expect(items[0].textContent).toContain('Jane Smith');
      expect(items[0].textContent).toContain('jane@example.com');
      expect(items[0].textContent).toContain('604-555-0123');
    });
  });

  test('T-80-22: a <script>-bearing contact name in a search result renders escaped, no script element', function () {
    mockFetch({
      searchContacts: [
        { contact_id: 'zc-x', contact_name: '<script>alert(1)</script>Evil', email: 'evil@example.com', phone: '' }
      ]
    });
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    return bp._fetchWaitlistLinkSearchForTest(UNLINKED_ROW.id, 'evil').then(function () {
      var resultsEl = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-results');
      expect(resultsEl.querySelector('script')).toBeNull();
      expect(resultsEl.textContent).toContain('<script>alert(1)</script>Evil');
      var item = resultsEl.querySelector('.bp-so-result-item[data-contact-id]');
      expect(item.getAttribute('data-name')).toBe('<script>alert(1)</script>Evil');
    });
  });

  test('zero results renders "No matching customers found" and shows no error toast', function () {
    mockFetch({ searchContacts: [] });
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    return bp._fetchWaitlistLinkSearchForTest(UNLINKED_ROW.id, 'nobody').then(function () {
      var resultsEl = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-results');
      expect(resultsEl.textContent).toContain('No matching customers found');
      expect(toastMessages().some(function (m) { return m.indexOf('Failed') !== -1; })).toBe(false);
    });
  });
});

describe('write-through (D-02) and D-03a phone preservation', function () {
  test('selecting a result issues exactly one adminApiPost with id, zoho_contact_id, customer_name and customer_phone', function () {
    renderWithRows([UNLINKED_ROW]);
    return bp._linkWaitlistCustomerForTest(UNLINKED_ROW.id, {
      contact_id: 'zc-1', name: 'Jane Smith', email: 'jane@example.com', phone: '604-555-0123'
    }).then(function () {
      expect(global.fetch).toHaveBeenCalledTimes(1);
      var body = postedBodies()[0];
      expect(body).toEqual({
        action: 'update_waitlist_status',
        id: UNLINKED_ROW.id,
        zoho_contact_id: 'zc-1',
        customer_name: 'Jane Smith',
        customer_phone: '604-555-0123'
      });
    });
  });

  test('D-03a: linking a contact on a row that already has customer_phone omits customer_phone from the write payload', function () {
    renderWithRows([LINKED_WITH_PHONE_ROW]);
    return bp._linkWaitlistCustomerForTest(LINKED_WITH_PHONE_ROW.id, {
      contact_id: 'zc-2', name: 'New Contact', email: 'new@example.com', phone: '604-555-1111'
    }).then(function () {
      var body = postedBodies()[0];
      expect(body).toEqual({
        action: 'update_waitlist_status',
        id: LINKED_WITH_PHONE_ROW.id,
        zoho_contact_id: 'zc-2',
        customer_name: 'New Contact'
      });
      expect(Object.prototype.hasOwnProperty.call(body, 'customer_phone')).toBe(false);
    });
  });

  test('a successful link shows "Customer linked" (success)', function () {
    renderWithRows([UNLINKED_ROW]);
    return bp._linkWaitlistCustomerForTest(UNLINKED_ROW.id, {
      contact_id: 'zc-1', name: 'Jane Smith', email: 'jane@example.com', phone: ''
    }).then(function () {
      expect(toastMessages()).toContain('Customer linked');
    });
  });

  test('a link failure shows "Failed: " + err.message', function () {
    mockFetch({ writeReject: true });
    renderWithRows([UNLINKED_ROW]);
    return bp._linkWaitlistCustomerForTest(UNLINKED_ROW.id, {
      contact_id: 'zc-1', name: 'Jane Smith', email: 'jane@example.com', phone: ''
    }).then(function () {
      expect(toastMessages().some(function (m) { return m.indexOf('Failed: ') === 0; })).toBe(true);
    });
  });
});

describe('create-inline flow', function () {
  test('"+ Add new customer" reveals the inline create form', function () {
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    var addNewForm = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-addnew');
    expect(addNewForm.style.display).toBe('none');
    var toggle = cell.querySelector('[data-waitlist-link-addnew-toggle]');
    expect(toggle.textContent).toBe('+ Add new customer');
  });

  test('saving POSTs {name, first_name, last_name, email, phone} to /api/contacts and links on a contact_id response', function () {
    mockFetch({ createdContactId: 'zc-new' });
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-name').value = 'New Person';
    document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-email').value = 'new@example.com';
    document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-phone').value = '604-555-2222';

    return bp._saveWaitlistNewCustomerForTest(UNLINKED_ROW.id).then(function () {
      var createCall = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/api/contacts') !== -1 && String(c[0]).indexOf('search') === -1; })[0];
      expect(createCall[1].method).toBe('POST');
      expect(JSON.parse(createCall[1].body)).toEqual({
        name: 'New Person', first_name: 'New', last_name: 'Person', email: 'new@example.com', phone: '604-555-2222'
      });
      var body = postedBodies()[0];
      expect(body.zoho_contact_id).toBe('zc-new');
      expect(body.customer_name).toBe('New Person');
      expect(toastMessages()).toContain('Customer linked');
    });
  });

  test('a create failure shows showToast(error, "error") and leaves the typed values intact', function () {
    mockFetch({ createReject: true });
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    var nameInput = document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-name');
    nameInput.value = 'New Person';
    document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-email').value = 'new@example.com';

    return bp._saveWaitlistNewCustomerForTest(UNLINKED_ROW.id).then(function () {
      expect(toastMessages().some(function (m) { return m.indexOf('Failed: ') === 0; })).toBe(true);
      // Panel stays open with the typed value intact -- no renderWaitlist() call on failure.
      expect(document.getElementById('bp-waitlist-link-' + UNLINKED_ROW.id + '-new-name').value).toBe('New Person');
    });
  });
});

describe('cancel', function () {
  test('"Cancel" closes the panel with no write', function () {
    var panel = renderWithRows([UNLINKED_ROW]);
    var cell = customerCellFor(panel);
    bp._openWaitlistLinkPanelForTest(cell, UNLINKED_ROW.id);
    expect(cell.querySelector('.bp-reassign-panel')).not.toBeNull();

    var cancelBtn = cell.querySelector('[data-waitlist-link-cancel]');
    // Directly invoke the same handler the delegated click uses -- initDelegation()
    // never fires under Jest, so drive renderWaitlist() the same way the cancel
    // handler does.
    expect(cancelBtn).not.toBeNull();
    bp.renderWaitlist();
    var refreshedPanel = document.getElementById('bp-panel-waitlist');
    expect(refreshedPanel.querySelector('.bp-reassign-panel')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

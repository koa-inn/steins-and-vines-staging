'use strict';

// Phase 80-05 Task 1: Contact column and review sheet with fail-closed send
// (D-04-D-09). Covers: the Contact button's disabled state on booked/removed
// rows, the sheet's loading/error/populated states, editable subject+body
// carrying the resolved booking link, the read-only To field, and D-08's
// fail-closed send -- the load-bearing case: a failed send leaves the sheet
// open, fires no success toast, and never calls adminApiPost.

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
// Fixtures / helpers
// ---------------------------------------------------------------------------

var WAITING_ROW = {
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

var LINKED_ROW = {
  id: 'w2',
  email: 'bob@example.com',
  status: 'waiting',
  signed_up_at: '2026-08-16T08:00:00.000Z',
  zoho_contact_id: 'zc-9',
  customer_name: 'Bob Existing',
  customer_phone: '',
  recipe_ids: '',
  mailerlite_synced: true
};

var BOOKED_ROW = {
  id: 'w3',
  email: 'booked@example.com',
  status: 'booked',
  signed_up_at: '2026-08-10T08:00:00.000Z',
  zoho_contact_id: '',
  customer_name: '',
  customer_phone: '',
  recipe_ids: '',
  mailerlite_synced: true
};

var REMOVED_ROW = {
  id: 'w4',
  email: 'removed@example.com',
  status: 'removed',
  signed_up_at: '2026-08-01T08:00:00.000Z',
  zoho_contact_id: '',
  customer_name: '',
  customer_phone: '',
  recipe_ids: '',
  mailerlite_synced: true
};

var SERVICES_OK = {
  services: [
    // WR-04: the Contact sheet selects by slug, never by array position. This fixture
    // carries a decoy first entry precisely so a regression to services[0] fails here.
    { id: 111, title: 'Ferment Kit Booking', slug: 'ferment-kit', bookingUrl: 'https://cal.com/steins-and-vines/ferment-kit' },
    { id: 222, title: 'Beer Waitlist Booking', slug: 'beer-waitlist', bookingUrl: 'https://cal.com/steins-and-vines/beer-waitlist' }
  ],
  staff: []
};

function renderWithRows(rows) {
  document.body.innerHTML = '<div id="bp-app"><div id="bp-panel-waitlist"></div></div><div id="bp-toast-container"></div>';
  bp._setWaitlistStateForTest({ rows: rows, filter: 'all', search: '' });
  bp.renderWaitlist();
  return document.getElementById('bp-panel-waitlist');
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

function flushPromises() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

// Routes global.fetch by URL substring so unrelated calls never reject.
function mockFetch(opts) {
  opts = opts || {};
  global.fetch.mockImplementation(function (url, options) {
    var u = String(url);

    if (u.indexOf('/api/bookings/services') !== -1) {
      if (opts.servicesReject) return Promise.reject(new Error('network down'));
      if (opts.servicesEmpty) {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ services: [], staff: [] }); } });
      }
      if (opts.servicesNoMatch) {
        // WR-04: a healthy response that simply does not contain the beer-waitlist
        // event type — the real production state until 80-CUTOVER §1a lands.
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({
              services: [
                { id: 111, title: 'Ferment Kit Booking', slug: 'ferment-kit', bookingUrl: 'https://cal.com/steins-and-vines/ferment-kit' },
                { id: 333, title: 'Bottling', slug: 'bottling', bookingUrl: 'https://cal.com/steins-and-vines/bottling' }
              ],
              staff: []
            });
          }
        });
      }
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(SERVICES_OK); } });
    }

    if (u.indexOf('/api/waitlist/') !== -1 && u.indexOf('/contact') !== -1) {
      if (opts.sendWriteFailed) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: function () { return Promise.resolve({ ok: false, error: 'contact_write_failed' }); }
        });
      }
      if (opts.sendFailed) {
        return Promise.resolve({
          ok: false,
          status: 502,
          json: function () { return Promise.resolve({ ok: false, error: 'contact_failed' }); }
        });
      }
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ ok: true, contacted_at: '2026-09-04T12:00:00.000Z' }); }
      });
    }

    if (u.indexOf('/api/batch/admin-proxy') !== -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } });
    }

    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  });
}

beforeEach(function () {
  global.fetch.mockReset();
  mockFetch();
});

// ---------------------------------------------------------------------------

describe('Contact button render + disabled state', function () {
  test('renders on every row', function () {
    var panel = renderWithRows([WAITING_ROW]);
    expect(panel.querySelector('[data-waitlist-contact-trigger]')).not.toBeNull();
  });

  test('disabled on a booked row', function () {
    var panel = renderWithRows([BOOKED_ROW]);
    var btn = panel.querySelector('[data-waitlist-contact-trigger]');
    expect(btn.disabled).toBe(true);
  });

  test('disabled on a removed row', function () {
    var panel = renderWithRows([REMOVED_ROW]);
    var btn = panel.querySelector('[data-waitlist-contact-trigger]');
    expect(btn.disabled).toBe(true);
  });

  test('not disabled on a waiting row', function () {
    var panel = renderWithRows([WAITING_ROW]);
    var btn = panel.querySelector('[data-waitlist-contact-trigger]');
    expect(btn.disabled).toBe(false);
  });
});

describe('opening the sheet', function () {
  test('shows "Preparing email…" synchronously while the booking-link fetch is in flight', function () {
    renderWithRows([WAITING_ROW]);
    bp._openWaitlistContactSheetForTest(WAITING_ROW.id);
    var body = document.getElementById('bp-waitlist-contact-body');
    expect(body.textContent).toContain('Preparing email…');
  });

  test('sheet title is "Contact {email}" when unlinked', function () {
    renderWithRows([WAITING_ROW]);
    bp._openWaitlistContactSheetForTest(WAITING_ROW.id);
    var title = document.querySelector('#bp-waitlist-contact-sheet .bp-create-sheet-title');
    expect(title.textContent).toBe('Contact jane@example.com');
  });

  test('sheet title is "Contact {customer_name}" when linked', function () {
    renderWithRows([LINKED_ROW]);
    bp._openWaitlistContactSheetForTest(LINKED_ROW.id);
    var title = document.querySelector('#bp-waitlist-contact-sheet .bp-create-sheet-title');
    expect(title.textContent).toBe('Contact Bob Existing');
  });

  test('booking-link fetch failure shows the error message with only Cancel', function () {
    mockFetch({ servicesReject: true });
    renderWithRows([WAITING_ROW]);
    return bp._openWaitlistContactSheetForTest(WAITING_ROW.id).then(function () {
      var body = document.getElementById('bp-waitlist-contact-body');
      expect(body.textContent).toContain('Could not prepare the booking link. Please try again.');
      expect(document.getElementById('bp-waitlist-contact-send')).toBeNull();
      expect(body.querySelector('.btn-secondary')).not.toBeNull();
    });
  });

  test('an empty services list is treated the same as a fetch failure', function () {
    mockFetch({ servicesEmpty: true });
    renderWithRows([WAITING_ROW]);
    return bp._openWaitlistContactSheetForTest(WAITING_ROW.id).then(function () {
      var body = document.getElementById('bp-waitlist-contact-body');
      expect(body.textContent).toContain('Could not prepare the booking link. Please try again.');
    });
  });

  test('WR-04: services present but no beer-waitlist slug fails closed — never falls back to services[0]', function () {
    mockFetch({ servicesNoMatch: true });
    renderWithRows([WAITING_ROW]);
    return bp._openWaitlistContactSheetForTest(WAITING_ROW.id).then(function () {
      var body = document.getElementById('bp-waitlist-contact-body');
      // The regression this guards: positional selection would have silently picked
      // ferment-kit here and mailed a waitlist customer the wrong appointment link.
      expect(body.textContent).toContain('Could not prepare the booking link. Please try again.');
      expect(body.textContent).not.toContain('ferment-kit');
      expect(body.textContent).not.toContain('bottling');
      expect(document.getElementById('bp-waitlist-contact-send')).toBeNull();
    });
  });

  test('success pre-fills To (read-only), Subject and Body with the booking link interpolated', function () {
    renderWithRows([WAITING_ROW]);
    return bp._openWaitlistContactSheetForTest(WAITING_ROW.id).then(function () {
      var toInput = document.querySelector('#bp-waitlist-contact-body input[type="email"]');
      expect(toInput.value).toBe('jane@example.com');
      expect(toInput.hasAttribute('readonly')).toBe(true);
      var subjectInput = document.getElementById('bp-waitlist-contact-subject');
      expect(subjectInput.value).toBe('Your spot on the Steins & Vines beer waitlist is ready!');
      var bodyInput = document.getElementById('bp-waitlist-contact-body-input');
      expect(bodyInput.value).toContain('https://cal.com/steins-and-vines/beer-waitlist');
      expect(bodyInput.value).toContain('Hi there,');
    });
  });

  test('greets the linked contact by first name when customer_name is present', function () {
    renderWithRows([LINKED_ROW]);
    return bp._openWaitlistContactSheetForTest(LINKED_ROW.id).then(function () {
      var bodyInput = document.getElementById('bp-waitlist-contact-body-input');
      expect(bodyInput.value).toContain('Hi Bob,');
    });
  });
});

describe('send (D-05, D-07, D-08)', function () {
  function openAndFlush(row) {
    renderWithRows([row]);
    return bp._openWaitlistContactSheetForTest(row.id);
  }

  test('editing subject/body changes what is sent, not the template defaults', function () {
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-subject').value = 'Edited subject';
      document.getElementById('bp-waitlist-contact-body-input').value = 'Edited body';
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      var sendCall = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/contact') !== -1; })[0];
      var body = JSON.parse(sendCall[1].body);
      expect(body.subject).toBe('Edited subject');
      expect(body.body).toBe('Edited body');
    });
  });

  test('Send issues exactly one POST with to/subject/body/bookingUrl, to taken from the row not the DOM', function () {
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      var sendCalls = global.fetch.mock.calls.filter(function (c) { return String(c[0]).indexOf('/contact') !== -1; });
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0][0]).toBe('/api/waitlist/w1/contact');
      var body = JSON.parse(sendCalls[0][1].body);
      expect(body).toEqual({
        to: 'jane@example.com',
        subject: 'Your spot on the Steins & Vines beer waitlist is ready!',
        body: body.body,
        bookingUrl: 'https://cal.com/steins-and-vines/beer-waitlist'
      });
    });
  });

  test('Send disables the button while in flight', function () {
    return openAndFlush(WAITING_ROW).then(function () {
      var sendBtn = document.getElementById('bp-waitlist-contact-send');
      sendBtn.click();
      expect(sendBtn.disabled).toBe(true);
      return flushPromises();
    });
  });

  test('on success the sheet closes, list refreshes, and shows "Email sent — marked Contacted"', function () {
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      // The sheet's close animation defers actual DOM removal by 180ms
      // (matches openRecipeFromBatchSheet's closeRcSheet timing) -- wait past it.
      return new Promise(function (resolve) { setTimeout(resolve, 200); });
    }).then(function () {
      expect(toastMessages()).toContain('Email sent — marked Contacted');
      expect(document.getElementById('bp-waitlist-contact-sheet')).toBeNull();
    });
  });

  test('no code path calls adminApiPost with status contacted -- the server owns that write', function () {
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      var proxyBodies = postedBodies();
      var wroteContacted = proxyBodies.some(function (b) { return b && b.status === 'contacted'; });
      expect(wroteContacted).toBe(false);
    });
  });

  test('D-08: a failed send keeps the sheet open, shows the inline error, re-enables Send, fires no success toast and no adminApiPost', function () {
    mockFetch({ sendFailed: true });
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      expect(document.getElementById('bp-waitlist-contact-sheet')).not.toBeNull();
      var errEl = document.getElementById('bp-waitlist-contact-error');
      expect(errEl.textContent).toContain('Could not send. Please try again.');
      var sendBtn = document.getElementById('bp-waitlist-contact-send');
      expect(sendBtn.disabled).toBe(false);
      expect(toastMessages().indexOf('Email sent — marked Contacted')).toBe(-1);
      expect(postedBodies().length).toBe(0);
    });
  });

  // WR-01 regression. On contact_write_failed the email HAS gone out — only the
  // row advance failed. Re-arming Send puts "send a duplicate" one tap away in
  // exactly the state where the phase knows a duplicate must not be sent. Send
  // must stay dead; Cancel remains the way out.
  test('WR-01: on contact_write_failed the Send button stays DISABLED — the mail already went out', function () {
    mockFetch({ sendWriteFailed: true });
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      var sendBtn = document.getElementById('bp-waitlist-contact-send');
      expect(sendBtn.disabled).toBe(true);
      // Cancel must still be available so the sheet is not a dead end.
      expect(document.getElementById('bp-waitlist-contact-cancel')).not.toBeNull();
    });
  });

  test('a contact_write_failed response is distinguishable from a contact_failed one', function () {
    mockFetch({ sendWriteFailed: true });
    return openAndFlush(WAITING_ROW).then(function () {
      document.getElementById('bp-waitlist-contact-send').click();
      return flushPromises();
    }).then(function () {
      var errEl = document.getElementById('bp-waitlist-contact-error');
      expect(errEl.textContent).toContain('Could not send. Please try again.');
      expect(errEl.textContent).toContain('went out');
    });
  });
});

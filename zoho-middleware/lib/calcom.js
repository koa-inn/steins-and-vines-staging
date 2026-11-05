var axios = require('axios');
var crypto = require('crypto');
var log = require('./logger');
var zohoApi = require('./zoho-api');

// ---------------------------------------------------------------------------
// Cal.com API v2 adapter
// Follows lib/zoho-api.js style (ES5, module.exports).
// Auth: Authorization: Bearer <CALCOM_API_KEY> (server-side only, Railway env).
// Security: CALCOM_API_KEY never sent to browser; only used server-side here.
// ---------------------------------------------------------------------------

var BASE = 'https://api.cal.com/v2';

// Per-endpoint version constants — MANDATORY, different per endpoint.
// Confirmed against live cal.com/docs/api-reference/v2 on 2026-06-04:
//   eventTypes: 2024-06-14 — from event-types docs
//   slots:      2024-09-04 — from slots docs
//   bookings:   2026-02-25 — confirmed (live docs returned 2026-02-25 matching RESEARCH §A3)
var CAL_VERSIONS = {
  eventTypes: '2024-06-14',
  slots: '2024-09-04',
  bookings: '2026-02-25',
  bookingsList: '2026-05-01' // GET /v2/bookings list — docs 2026-11-03; verify live in 97-12
};

/**
 * Build standard request headers for a Cal.com v2 call.
 * @param {string} version - The cal-api-version value for this endpoint.
 * @returns {Object}
 */
function makeHeaders(version) {
  return {
    'Authorization': 'Bearer ' + (process.env.CALCOM_API_KEY || ''),
    'cal-api-version': version
  };
}

// ---------------------------------------------------------------------------
// listEventType(id)
// GET /v2/event-types/{id}
// Backs GET /api/bookings/services — returns a single event type by numeric id.
// ---------------------------------------------------------------------------

/**
 * Fetch a single Cal.com event type by numeric id.
 * @param {number} id - Numeric event type id.
 * @returns {Promise<Object>} response.data
 */
function listEventType(id) {
  return zohoApi.withRetry(function () {
    return axios.get(BASE + '/event-types/' + id, {
      headers: makeHeaders(CAL_VERSIONS.eventTypes),
      timeout: 15000
    }).then(function (response) {
      return response.data;
    });
  });
}

// ---------------------------------------------------------------------------
// getSlots(eventTypeId, start, end, timeZone)
// GET /v2/slots
// Backs both GET /api/bookings/availability (month) and /slots (day).
// One range request replaces the Zoho per-day fan-out.
// ---------------------------------------------------------------------------

/**
 * Fetch available time slots for a Cal.com event type.
 * @param {number|string} eventTypeId - Numeric event type id.
 * @param {string} start - ISO-8601 or date-only start (e.g. "2026-06-01").
 * @param {string} end   - ISO-8601 or date-only end (e.g. "2026-06-30").
 * @param {string} [timeZone] - IANA timezone (default "America/Vancouver").
 * @returns {Promise<Object>} response.data — shape: { status, data: { "YYYY-MM-DD": [{start}] } }
 */
function getSlots(eventTypeId, start, end, timeZone) {
  return zohoApi.withRetry(function () {
    return axios.get(BASE + '/slots', {
      headers: makeHeaders(CAL_VERSIONS.slots),
      timeout: 15000,
      params: {
        eventTypeId: eventTypeId,
        start: start,
        end: end,
        timeZone: timeZone || 'America/Vancouver'
      }
    }).then(function (response) {
      return response.data;
    });
  });
}

// ---------------------------------------------------------------------------
// createBooking(body)
// POST /v2/bookings
// Backs POST /api/bookings — creates a booking; attendee.email triggers
// Cal.com's automatic confirmation email (bypasses Railway blocked SMTP).
// ---------------------------------------------------------------------------

/**
 * Create a Cal.com booking.
 * @param {Object} body - Booking payload: { start(UTC ISO), eventTypeId,
 *   attendee:{name,email,timeZone,language}, metadata:{notes,...} }
 * @returns {Promise<Object>} response.data — shape: { status, data:{id,uid,...} }
 */
function createBooking(body) {
  return zohoApi.withRetry(function () {
    return axios.post(BASE + '/bookings', body, {
      headers: makeHeaders(CAL_VERSIONS.bookings),
      timeout: 15000
    }).then(function (response) {
      return response.data;
    });
  });
}

// ---------------------------------------------------------------------------
// listBookings(opts)
// GET /v2/bookings (read-only, server-side). Backs the Phase 97 packaging
// calendar. Cursor-paginated, hard-capped at LIST_BOOKINGS_MAX_PAGES x 100.
// Responses hold attendee PII: nothing from them is logged here.
// ---------------------------------------------------------------------------

var LIST_BOOKINGS_MAX_PAGES = 5;

// CR-01: Cal.com 'upcoming' only returns bookings that have not ended yet, so a booking from earlier
// today would vanish from the calendar. 'past' covers ended ones (Cal.com excludes cancelled/rejected
// from both). One status per call on purpose: the comma-list form of `status` is documented but not
// verified live, so the two lists are fetched in parallel and merged by uid instead.
var LIST_BOOKINGS_STATUSES = ['upcoming', 'past'];

/**
 * List non-cancelled bookings (upcoming and already ended) for the given event types in a window.
 * @param {Object} opts - { eventTypeIds:number[], afterStart, beforeEnd } (ISO strings)
 * @returns {Promise<{bookings:Array, truncated:boolean}>}
 */
function listBookings(opts) {
  opts = opts || {};
  var ids = (opts.eventTypeIds || []).map(Number).filter(function (n) { return isFinite(n); });
  if (!ids.length) return Promise.resolve({ bookings: [], truncated: false });

  function fetchStatus(status) {
    var bookings = [];

    function fetchPage(cursor, pageNo) {
      var params = {
        status: status,
        eventTypeIds: ids.join(','),
        afterStart: opts.afterStart,
        beforeEnd: opts.beforeEnd,
        sortStart: 'asc',
        limit: 100
      };
      if (cursor) params.cursor = cursor;
      return zohoApi.withRetry(function () {
        return axios.get(BASE + '/bookings', {
          headers: makeHeaders(CAL_VERSIONS.bookingsList),
          timeout: 15000,
          params: params
        });
      }).then(function (response) {
        var body = (response && response.data) || {};
        if (Array.isArray(body.data)) bookings = bookings.concat(body.data);
        var pg = body.pagination || {};
        var more = pg.hasMore === true && typeof pg.nextCursor === 'string' && pg.nextCursor !== '';
        if (!more) return { bookings: bookings, truncated: false };
        if (pageNo >= LIST_BOOKINGS_MAX_PAGES) return { bookings: bookings, truncated: true };
        return fetchPage(pg.nextCursor, pageNo + 1);
      });
    }

    return fetchPage(null, 1);
  }

  return Promise.all(LIST_BOOKINGS_STATUSES.map(fetchStatus)).then(function (results) {
    var seen = {};
    var merged = [];
    var truncated = false;
    results.forEach(function (r) {
      if (r.truncated) truncated = true;
      r.bookings.forEach(function (b) {
        var key = b && (b.uid || b.id);
        if (key !== undefined && key !== null && key !== '') {
          if (Object.prototype.hasOwnProperty.call(seen, key)) return;
          seen[key] = true;
        }
        merged.push(b);
      });
    });
    return { bookings: merged, truncated: truncated };
  });
}

// ---------------------------------------------------------------------------
// verifyWebhook(rawBody, signature)
// Cal.com webhook HMAC-SHA256 verification.
// Scheme: single header x-cal-signature-256, HEX digest, signed over raw body.
// Mirrors lib/helcim.js#verifyWebhookSignature but simplified for Cal.com.
// ---------------------------------------------------------------------------

/**
 * Verify a Cal.com webhook signature.
 *
 * Signature header: x-cal-signature-256
 * Algorithm: HMAC-SHA256, hex digest over the raw request body string.
 * Fails open if CALCOM_WEBHOOK_SECRET is not configured (matches reCAPTCHA /
 * Helcim unconfigured pattern — safe for dev, log.warn'd).
 *
 * Security: uses crypto.timingSafeEqual to prevent timing-side-channel attacks.
 * T-25-02: forged signature — mitigated here (BOOK-05 + BOOK-06).
 * T-25-03: timing attack — mitigated by timingSafeEqual.
 *
 * @param {string} rawBody   - Raw request body string (req.rawBody from express.json verify).
 * @param {string} signature - Value from x-cal-signature-256 header.
 * @returns {boolean}
 */
function verifyWebhook(rawBody, signature) {
  var secret = process.env.CALCOM_WEBHOOK_SECRET || '';
  if (!secret) {
    var isProd = process.env.NODE_ENV === 'production';
    if (isProd) return false; // D-04: fail closed in prod — unsigned event rejected
    log.warn('[calcom] CALCOM_WEBHOOK_SECRET not set — skipping webhook signature verification');
    return true; // fail-open dev pattern
  }
  var expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    // Length mismatch between expected and provided signature — not valid
    return false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CAL_VERSIONS: CAL_VERSIONS,
  listEventType: listEventType,
  getSlots: getSlots,
  createBooking: createBooking,
  listBookings: listBookings,
  verifyWebhook: verifyWebhook
};

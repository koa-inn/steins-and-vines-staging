var express = require('express');
var zohoApi = require('../lib/zoho-api');
var calcom = require('../lib/calcom');
var cache = require('../lib/cache');
var log = require('../lib/logger');
var C = require('../lib/constants');
var checkoutHelpers = require('../lib/checkout-helpers');
var buildContactPayload = checkoutHelpers.buildContactPayload;

// zohoApi imports retained: normalizeTimeTo24h (used by POST /api/bookings),
// zohoGet/zohoPost (used by POST /api/contacts — unchanged).
var zohoGet = zohoApi.zohoGet;
var zohoPost = zohoApi.zohoPost;
var normalizeTimeTo24h = zohoApi.normalizeTimeTo24h;

var router = express.Router();

var AVAILABILITY_CACHE_PREFIX = C.CACHE_KEYS.AVAILABILITY_PREFIX;
var AVAILABILITY_CACHE_TTL = 300; // 5 minutes
var BOOKING_SERVICES_CACHE_KEY = C.CACHE_KEYS.BOOKING_SERVICES;
var BOOKING_SERVICES_CACHE_TTL = 86400; // 24 hours — services rarely change
var SLOTS_CACHE_PREFIX = C.CACHE_KEYS.SLOTS_PREFIX;
var SLOTS_CACHE_TTL = 300; // 5 minutes per date

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Cal.com ISO start string to a 12-hour "10:00 AM" label in
 * America/Vancouver. Frontend expects: s.time.match(/(\d+):(\d+)\s*(AM|PM)/i)
 *
 * @param {string} isoStart - e.g. "2026-06-05T09:00:00.000-07:00"
 * @returns {string} e.g. "9:00 AM"
 */
function slotToLabel(isoStart) {
  return new Date(isoStart).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Vancouver'
  });
}

/**
 * Combine body.date ("YYYY-MM-DD") + a 24h time ("10:00:00") into a UTC ISO
 * instant interpreted in America/Vancouver (Pitfall 2 — handles PST/PDT offset).
 *
 * @param {string} date   - "YYYY-MM-DD"
 * @param {string} time24 - "HH:MM:SS" (from normalizeTimeTo24h)
 * @returns {string}      - UTC ISO string ending in Z e.g. "2026-06-05T17:00:00Z"
 */
function buildUtcStart(date, time24) {
  // "YYYY-MM-DDTHH:MM:SS" without a timezone suffix is parsed as LOCAL time by
  // most engines. Node.js parses date-only strings as UTC and datetime strings
  // without TZ as local. Use the Intl approach: parse as Vancouver wall clock.
  //
  // Approach: create a Date by interpreting the string as if it were UTC, then
  // correct for Vancouver's offset using Intl.DateTimeFormat resolution.
  // More reliably: use a well-known trick via toLocaleString to discover the
  // offset, or simply build the ISO string with the offset obtained from
  // Intl.DateTimeFormat.
  //
  // Simpler + correct: ask the JS engine "what UTC instant corresponds to this
  // wall-clock time in America/Vancouver?" using the Intl offset trick.
  var wallClock = date + 'T' + time24; // "2026-06-05T10:00:00"

  // Step 1: parse as UTC to get a candidate Date
  var utcCandidate = new Date(wallClock + 'Z');

  // Step 2: determine what Vancouver local time that UTC instant maps to
  var vanParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(utcCandidate);

  var vanMap = {};
  vanParts.forEach(function (p) { vanMap[p.type] = p.value; });

  // Vancouver wall clock at utcCandidate (may not equal wallClock)
  var vanWall = vanMap.year + '-' + vanMap.month + '-' + vanMap.day +
    'T' + (vanMap.hour === '24' ? '00' : vanMap.hour) + ':' + vanMap.minute + ':' + vanMap.second;

  // Step 3: offset = utcCandidate - vanWall (in ms) — this IS the UTC offset
  var vanWallMs = new Date(vanWall + 'Z').getTime();
  var offsetMs = utcCandidate.getTime() - vanWallMs;

  // Step 4: the true UTC instant for our wallClock in Vancouver
  var desiredUtcMs = new Date(wallClock + 'Z').getTime() + offsetMs;
  var result = new Date(desiredUtcMs);
  return result.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build a Zoho /contacts create payload for POST /api/contacts.
 *
 * Wraps buildContactPayload (which nests email/phone under contact_persons,
 * not at the top level — the INV-000078 fix) and adds an explicit
 * first_name/last_name override so that BrewPad's pre-split name fields are
 * used verbatim instead of re-splitting the combined display name.
 *
 * @param {string} name        - Combined display name (always used for contact_name)
 * @param {string} email       - Customer email
 * @param {string} phone       - Customer phone (may be empty)
 * @param {string} firstName   - Explicit first name; if non-empty, skips whitespace split
 * @param {string} lastName    - Explicit last name; used when firstName is non-empty
 * @returns {object}           - Zoho /contacts create payload
 */
function buildContactsRoutePayload(name, email, phone, firstName, lastName) {
  var payload = buildContactPayload(name, email, phone);
  var explicitFirst = (firstName || '').trim();
  if (explicitFirst) {
    payload.contact_persons[0].first_name = explicitFirst;
    payload.contact_persons[0].last_name = (lastName || '').trim();
  }
  return payload;
}

// ---------------------------------------------------------------------------
// GET /api/bookings/services
// List configured Cal.com event types in legacy { services, staff } shape.
// Driven by CALCOM_EVENT_TYPE_FERMENT_KIT + CALCOM_EVENT_TYPE_BOTTLING env IDs
// (deviation from plan spec CALCOM_EVENT_TYPE_FERMENT — uses actual Railway names).
// ---------------------------------------------------------------------------

/**
 * GET /api/bookings/services
 * Lists Cal.com event types as services, returning { services:[...], staff:[] }.
 * Cached for 24h (BOOKING_SERVICES_CACHE_TTL).
 */
router.get('/api/bookings/services', async function (req, res) {
  try {
    // lib/cache.get() already JSON.parses, so a healthy hit is an OBJECT. Entries written
    // by the old double-stringifying code below parse back to a STRING; serving one made
    // res.json() emit double-encoded JSON and every consumer's `.services` came back
    // undefined. Treat any non-object hit as a miss so those entries self-heal rather than
    // sitting out their 24h TTL.
    var cached = await cache.get(BOOKING_SERVICES_CACHE_KEY);
    if (cached && typeof cached === 'object') {
      return res.json(cached);
    }

    // Read the configured event-type IDs; skip any that are not set. BEER_WAITLIST
    // backs the Phase 80 waitlist contact flow (80-CUTOVER §1a) — BrewPad selects it
    // by slug ('beer-consult'), so it must be surfaced here or that flow fails closed.
    var ids = [
      process.env.CALCOM_EVENT_TYPE_FERMENT_KIT,
      process.env.CALCOM_EVENT_TYPE_BOTTLING,
      process.env.CALCOM_EVENT_TYPE_BEER_WAITLIST
    ].filter(function (id) { return id && String(id).trim() !== ''; });

    var serviceData;
    if (ids.length === 0) {
      serviceData = [];
    } else {
      var results = await Promise.all(ids.map(function (id) {
        return calcom.listEventType(Number(id));
      }));
      serviceData = results.map(function (r) {
        var et = (r && r.data) || r || {};
        return {
          id: et.id,
          title: et.title,
          slug: et.slug,
          duration: et.lengthInMinutes,
          description: et.description || '',
          price: et.price || 0,
          currency: et.currency || 'CAD',
          bookingUrl: et.bookingUrl || ''
        };
      });
    }

    var payload = { services: serviceData, staff: [] };
    cache.set(BOOKING_SERVICES_CACHE_KEY, payload, BOOKING_SERVICES_CACHE_TTL).catch(function () {});
    res.json(payload);
  } catch (err) {
    log.error('[api/bookings/services] ' + err.message);
    res.status(502).json({ error: 'Unable to fetch booking services' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookings/availability?year=YYYY&month=MM
// Returns { source:'calcom', dates:[{date, available, slots_count}] } for days
// with ≥1 slot. ONE getSlots call for the whole month (not per-day fan-out).
// ---------------------------------------------------------------------------

/**
 * GET /api/bookings/availability?year=YYYY&month=MM
 * Returns which dates in a month have available slots.
 * Cached in Redis for 5 minutes.
 */
router.get('/api/bookings/availability', async function (req, res) {
  var year = req.query.year;
  var month = req.query.month;

  if (!year || !month) {
    return res.status(400).json({ error: 'Missing year or month query parameter' });
  }

  month = String(month).padStart(2, '0');
  var cacheKey = AVAILABILITY_CACHE_PREFIX + year + '-' + month;

  try {
    var cached = await cache.get(cacheKey);
    if (cached) {
      log.info('[api/bookings/availability] Cache hit for ' + year + '-' + month);
      return res.json({ source: 'cache', dates: cached });
    }

    log.info('[api/bookings/availability] Cache miss — fetching from Cal.com');

    // Build month range: first day .. last day
    var startDate = year + '-' + month + '-01';
    var daysInMonth = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
    var endDate = year + '-' + month + '-' + String(daysInMonth).padStart(2, '0');

    var eventTypeId = Number(process.env.CALCOM_EVENT_TYPE_FERMENT_KIT);
    var slotsResponse = await calcom.getSlots(eventTypeId, startDate, endDate, 'America/Vancouver');
    var byDate = (slotsResponse && slotsResponse.data) || {};

    // Emit only days with slots > 0
    var dates = Object.keys(byDate)
      .filter(function (d) { return Array.isArray(byDate[d]) && byDate[d].length > 0; })
      .map(function (d) {
        return { date: d, available: true, slots_count: byDate[d].length };
      });

    cache.set(cacheKey, dates, AVAILABILITY_CACHE_TTL);

    res.json({ source: 'calcom', dates: dates });
  } catch (err) {
    log.error('[api/bookings/availability] ' + err.message);
    res.status(502).json({ error: 'Unable to check availability' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/bookings/slots?date=YYYY-MM-DD
// Returns { date, slots:[{time}] } with 12-hour America/Vancouver labels.
// ---------------------------------------------------------------------------

/**
 * GET /api/bookings/slots?date=YYYY-MM-DD
 * Fetch available time slots for a specific date.
 */
router.get('/api/bookings/slots', async function (req, res) {
  var date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: 'Missing date query parameter' });
  }

  var slotsCacheKey = SLOTS_CACHE_PREFIX + date;

  try {
    var cached = await cache.get(slotsCacheKey);
    if (cached) {
      return res.json(cached);
    }

    var eventTypeId = Number(process.env.CALCOM_EVENT_TYPE_FERMENT_KIT);
    var slotsResponse = await calcom.getSlots(eventTypeId, date, date, 'America/Vancouver');
    var byDate = (slotsResponse && slotsResponse.data) || {};
    var rawSlots = (Array.isArray(byDate[date]) ? byDate[date] : []);

    var slots = rawSlots.map(function (s) {
      return { time: slotToLabel(s.start) };
    });

    var payload = { date: date, slots: slots };
    cache.set(slotsCacheKey, payload, SLOTS_CACHE_TTL).catch(function () {});
    res.json(payload);
  } catch (err) {
    log.error('[api/bookings/slots] ' + err.message);
    res.status(502).json({ error: 'Unable to fetch time slots' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/bookings
// Create an appointment in Cal.com.
//
// Expected body:
// {
//   date: "YYYY-MM-DD",
//   time: "10:00 AM",
//   customer: { name: "...", email: "...", phone: "..." },
//   notes: "optional"
// }
// ---------------------------------------------------------------------------

router.post('/api/bookings', async function (req, res) {
  var body = req.body;

  if (!body || !body.date || !body.time) {
    return res.status(400).json({ error: 'Missing date or time' });
  }
  if (!body.customer || !body.customer.name || !body.customer.email) {
    return res.status(400).json({ error: 'Missing customer name or email' });
  }
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return res.status(400).json({ error: 'Invalid date format (expected YYYY-MM-DD)' });
  }
  if (typeof body.customer.email !== 'string' || body.customer.email.length > 254 || body.customer.email.indexOf('@') === -1) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (body.customer.name.length > 200) {
    return res.status(400).json({ error: 'Name too long' });
  }
  if (body.customer.phone && String(body.customer.phone).length > 30) {
    return res.status(400).json({ error: 'Phone too long' });
  }
  if (body.notes && String(body.notes).length > 1000) {
    return res.status(400).json({ error: 'Notes too long' });
  }
  // Optional event-type selector: 'bottling' maps to CALCOM_EVENT_TYPE_BOTTLING;
  // anything else or absent defaults to CALCOM_EVENT_TYPE_FERMENT_KIT.
  // Validate defensively: must be a string of ≤32 chars if provided.
  if (body.service !== undefined && body.service !== null) {
    if (typeof body.service !== 'string' || body.service.length > 32) {
      return res.status(400).json({ error: 'Invalid service selector' });
    }
  }

  // Offline fallback: Cal.com not reachable or credentials not yet configured —
  // return a placeholder booking_id so the checkout flow can continue;
  // the full order notification is sent by /api/checkout
  if (req.zohoOffline) {
    var offlineBookingId = 'PENDING-' + Date.now().toString(36).toUpperCase();
    return res.status(201).json({ ok: true, booking_id: offlineBookingId, timeslot: body.date + ' ' + body.time });
  }

  // Resolve the event-type id from the optional selector.
  // Defaults to ferment-kit (backward compatible — current frontend sends no selector).
  // Falls back to ferment-kit if bottling id is unset in env.
  var resolvedEventTypeId;
  if (body.service === 'bottling' && process.env.CALCOM_EVENT_TYPE_BOTTLING && String(process.env.CALCOM_EVENT_TYPE_BOTTLING).trim() !== '') {
    resolvedEventTypeId = Number(process.env.CALCOM_EVENT_TYPE_BOTTLING);
  } else {
    resolvedEventTypeId = Number(process.env.CALCOM_EVENT_TYPE_FERMENT_KIT);
  }

  var time24 = normalizeTimeTo24h(body.time);
  var startUtc = buildUtcStart(body.date, time24);

  var bookingPayload = {
    start: startUtc,
    eventTypeId: resolvedEventTypeId,
    attendee: {
      name: body.customer.name,
      email: body.customer.email,
      timeZone: 'America/Vancouver',
      language: 'en'
    },
    metadata: {
      notes: body.notes || '',
      phone: body.customer.phone || ''
    }
  };

  try {
    var result = await calcom.createBooking(bookingPayload);
    var bookingData = (result && result.data) || {};

    // Invalidate availability + slots caches for this date/month
    var ym = body.date.substring(0, 7).split('-');
    cache.del(AVAILABILITY_CACHE_PREFIX + ym[0] + '-' + ym[1]);
    cache.del(SLOTS_CACHE_PREFIX + body.date);

    res.status(201).json({
      ok: true,
      booking_id: bookingData.uid || bookingData.id || null,
      timeslot: body.date + ' ' + body.time
    });
  } catch (err) {
    var message = err.message;
    if (err.response && err.response.data) {
      message = err.response.data.message || err.response.data.error || message;
    }
    log.error('[api/bookings POST] ' + message);
    res.status(502).json({ error: 'Unable to create booking' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/contacts
// Find an existing Zoho Books contact by email, or create a new one.
// UNCHANGED — still uses zohoGet/zohoPost (Zoho Books, not Zoho Bookings).
//
// Expected body:
// { name: "...", email: "...", phone: "..." }
//
// Returns: { contact_id: "..." }
// ---------------------------------------------------------------------------

router.post('/api/contacts', async function (req, res) {
  var body = req.body;
  if (!body || !body.email) {
    return res.status(400).json({ error: 'Missing email' });
  }
  if (typeof body.email !== 'string' || body.email.length > 254 || body.email.indexOf('@') === -1) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (body.name && String(body.name).length > 200) {
    return res.status(400).json({ error: 'Name too long' });
  }
  if (body.phone && String(body.phone).length > 30) {
    return res.status(400).json({ error: 'Phone too long' });
  }

  // Offline fallback: Zoho not authenticated — return a dummy contact_id so the
  // checkout flow can continue (the checkout route sends the full notification email)
  if (req.zohoOffline) {
    return res.json({ contact_id: 'offline', created: false, offline: true });
  }

  try {
    // Search for existing contact by email
    var data = await zohoGet('/contacts', { email: body.email });
    var contacts = data.contacts || [];
    if (contacts.length > 0) {
      return res.json({ contact_id: contacts[0].contact_id, created: false });
    }

    // Not found by email — create new contact.
    // Use buildContactsRoutePayload so email/phone are nested under
    // contact_persons (not top-level, which Zoho Books silently drops).
    // When body.first_name is provided (e.g. from BrewPad's explicit fields),
    // use those values verbatim instead of re-splitting the display name.
    var contactPayload = buildContactsRoutePayload(
      body.name || body.email,
      body.email,
      body.phone || '',
      body.first_name || '',
      body.last_name || ''
    );

    try {
      var createData = await zohoPost('/contacts', contactPayload);
      var contact = createData.contact || {};
      res.status(201).json({ contact_id: contact.contact_id, created: true });
    } catch (createErr) {
      // If name already exists, search by name and return that contact
      var msg = '';
      if (createErr.response && createErr.response.data) {
        msg = createErr.response.data.message || '';
      }
      if (msg.indexOf('already exists') !== -1) {
        var nameData = await zohoGet('/contacts', { contact_name: body.name });
        var nameContacts = nameData.contacts || [];
        if (nameContacts.length > 0) {
          return res.json({ contact_id: nameContacts[0].contact_id, created: false });
        }
        throw createErr; // couldn't find by name either
      }
      throw createErr;
    }
  } catch (err) {
    var message = err.message;
    if (err.response && err.response.data) {
      message = err.response.data.message || err.response.data.error || message;
    }
    log.error('[api/contacts POST] ' + message);
    res.status(502).json({ error: 'Unable to create contact' });
  }
});

module.exports = router;
module.exports.buildContactsRoutePayload = buildContactsRoutePayload;

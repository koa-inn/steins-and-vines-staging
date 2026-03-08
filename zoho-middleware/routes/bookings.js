var express = require('express');
var zohoApi = require('../lib/zoho-api');
var cache = require('../lib/cache');
var log = require('../lib/logger');

var bookingsGet = zohoApi.bookingsGet;
var bookingsPost = zohoApi.bookingsPost;
var zohoGet = zohoApi.zohoGet;
var zohoPost = zohoApi.zohoPost;
var normalizeTimeTo24h = zohoApi.normalizeTimeTo24h;

var router = express.Router();

var AVAILABILITY_CACHE_PREFIX = 'zoho:availability:';
var AVAILABILITY_CACHE_TTL = 300; // 5 minutes
var BOOKING_SERVICES_CACHE_KEY = 'zoho:booking-services';
var BOOKING_SERVICES_CACHE_TTL = 86400; // 24 hours — services rarely change
var SLOTS_CACHE_PREFIX = 'zoho:slots:';
var SLOTS_CACHE_TTL = 300; // 5 minutes per date

/**
 * GET /api/bookings/services
 * List all services and staff from Zoho Bookings (debug/setup helper).
 */
router.get('/api/bookings/services', function (req, res) {
  cache.get(BOOKING_SERVICES_CACHE_KEY)
    .then(function (cached) {
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      return Promise.all([
        bookingsGet('/services'),
        bookingsGet('/staffs')
      ])
        .then(function (results) {
          var services = (results[0].response && results[0].response.returnvalue &&
            results[0].response.returnvalue.data) || [];
          var staff = (results[1].response && results[1].response.returnvalue &&
            results[1].response.returnvalue.data) || [];
          var payload = { services: services, staff: staff };
          cache.set(BOOKING_SERVICES_CACHE_KEY, JSON.stringify(payload), BOOKING_SERVICES_CACHE_TTL).catch(function () {});
          res.json(payload);
        });
    })
    .catch(function (err) {
      log.error('[api/bookings/services] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch booking services' });
    });
});

/**
 * GET /api/bookings/availability?year=YYYY&month=MM
 * Returns which dates in a month have available slots.
 * Cached in Redis for 5 minutes.
 */
router.get('/api/bookings/availability', function (req, res) {
  var year = req.query.year;
  var month = req.query.month;

  if (!year || !month) {
    return res.status(400).json({ error: 'Missing year or month query parameter' });
  }

  month = String(month).padStart(2, '0');
  var cacheKey = AVAILABILITY_CACHE_PREFIX + year + '-' + month;

  cache.get(cacheKey)
    .then(function (cached) {
      if (cached) {
        log.info('[api/bookings/availability] Cache hit for ' + year + '-' + month);
        return res.json({ source: 'cache', dates: cached });
      }

      log.info('[api/bookings/availability] Cache miss — fetching from Zoho');

      // Calculate all dates in the month
      var daysInMonth = new Date(parseInt(year, 10), parseInt(month, 10), 0).getDate();
      var allDates = [];
      for (var d = 1; d <= daysInMonth; d++) {
        allDates.push(year + '-' + month + '-' + String(d).padStart(2, '0'));
      }

      // Process in batches of 5 to avoid exhausting Zoho's rate limit
      var BATCH_SIZE = 5;
      var allResults = [];

      function fetchBatch(startIndex) {
        var batch = allDates.slice(startIndex, startIndex + BATCH_SIZE);
        if (batch.length === 0) return Promise.resolve();

        return Promise.all(batch.map(function (ds) {
          return bookingsGet('/availableslots', {
            service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
            staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
            selected_date: ds
          }).then(function (data) {
            var raw = (data.response && data.response.returnvalue && data.response.returnvalue.data);
            var slots = Array.isArray(raw) ? raw : [];
            return { date: ds, available: slots.length > 0, slots_count: slots.length };
          }).catch(function () {
            return { date: ds, available: false, slots_count: 0 };
          });
        })).then(function (batchResults) {
          allResults = allResults.concat(batchResults);
          return fetchBatch(startIndex + BATCH_SIZE);
        });
      }

      return fetchBatch(0).then(function () {
        var dates = allResults.filter(function (r) { return r.available; });

        cache.set(cacheKey, dates, AVAILABILITY_CACHE_TTL);

        res.json({ source: 'zoho', dates: dates });
      });
    })
    .catch(function (err) {
      log.error('[api/bookings/availability] ' + err.message);
      res.status(502).json({ error: 'Unable to check availability' });
    });
});

/**
 * GET /api/bookings/slots?date=YYYY-MM-DD
 * Fetch available time slots for a specific date.
 */
router.get('/api/bookings/slots', function (req, res) {
  var date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: 'Missing date query parameter' });
  }

  var slotsCacheKey = SLOTS_CACHE_PREFIX + date;

  cache.get(slotsCacheKey)
    .then(function (cached) {
      if (cached) {
        return res.json(JSON.parse(cached));
      }

      return bookingsGet('/availableslots', {
        service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
        staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
        selected_date: date
      })
        .then(function (data) {
          var raw = (data.response && data.response.returnvalue && data.response.returnvalue.data);
          var slots = Array.isArray(raw) ? raw : [];
          var payload = { date: date, slots: slots };
          cache.set(slotsCacheKey, JSON.stringify(payload), SLOTS_CACHE_TTL).catch(function () {});
          res.json(payload);
        });
    })
    .catch(function (err) {
      log.error('[api/bookings/slots] ' + err.message);
      res.status(502).json({ error: 'Unable to fetch time slots' });
    });
});

/**
 * POST /api/bookings
 * Create an appointment in Zoho Bookings.
 *
 * Expected body:
 * {
 *   date: "YYYY-MM-DD",
 *   time: "10:00 AM",
 *   customer: { name: "...", email: "...", phone: "..." },
 *   notes: "optional"
 * }
 */
router.post('/api/bookings', function (req, res) {
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

  // Offline fallback: Zoho not authenticated — return a placeholder booking_id
  // so the checkout flow can continue; the full order notification is sent by /api/checkout
  if (req.zohoOffline) {
    var offlineBookingId = 'PENDING-' + Date.now().toString(36).toUpperCase();
    return res.status(201).json({ ok: true, booking_id: offlineBookingId, timeslot: body.date + ' ' + body.time });
  }

  var time24 = normalizeTimeTo24h(body.time);

  var bookingPayload = {
    service_id: process.env.ZOHO_BOOKINGS_SERVICE_ID,
    staff_id: process.env.ZOHO_BOOKINGS_STAFF_ID,
    from_time: body.date + ' ' + time24,
    customer_details: {
      name: body.customer.name,
      email: body.customer.email,
      phone_number: body.customer.phone || ''
    },
    additional_fields: {
      notes: body.notes || ''
    }
  };

  bookingsPost('/appointment', bookingPayload)
    .then(function (data) {
      var appointment = (data.response && data.response.returnvalue) || {};

      // Invalidate availability + slots caches for this date/month
      var ym = body.date.substring(0, 7).split('-');
      cache.del(AVAILABILITY_CACHE_PREFIX + ym[0] + '-' + ym[1]);
      cache.del(SLOTS_CACHE_PREFIX + body.date);

      res.status(201).json({
        ok: true,
        booking_id: appointment.booking_id || null,
        timeslot: body.date + ' ' + body.time
      });
    })
    .catch(function (err) {
      var message = err.message;
      if (err.response && err.response.data) {
        message = err.response.data.message || err.response.data.error || message;
      }
      log.error('[api/bookings POST] ' + message);
      res.status(502).json({ error: 'Unable to create booking' });
    });
});

/**
 * POST /api/contacts
 * Find an existing Zoho Books contact by email, or create a new one.
 *
 * Expected body:
 * { name: "...", email: "...", phone: "..." }
 *
 * Returns: { contact_id: "..." }
 */
router.post('/api/contacts', function (req, res) {
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

  // Search for existing contact by email
  zohoGet('/contacts', { email: body.email })
    .then(function (data) {
      var contacts = data.contacts || [];
      if (contacts.length > 0) {
        return res.json({ contact_id: contacts[0].contact_id, created: false });
      }

      // Not found by email — create new contact
      var contactPayload = {
        contact_name: body.name || body.email,
        contact_type: 'customer',
        email: body.email,
        phone: body.phone || ''
      };

      return zohoPost('/contacts', contactPayload)
        .then(function (createData) {
          var contact = createData.contact || {};
          res.status(201).json({ contact_id: contact.contact_id, created: true });
        })
        .catch(function (createErr) {
          // If name already exists, search by name and return that contact
          var msg = '';
          if (createErr.response && createErr.response.data) {
            msg = createErr.response.data.message || '';
          }
          if (msg.indexOf('already exists') !== -1) {
            return zohoGet('/contacts', { contact_name: body.name })
              .then(function (nameData) {
                var nameContacts = nameData.contacts || [];
                if (nameContacts.length > 0) {
                  return res.json({ contact_id: nameContacts[0].contact_id, created: false });
                }
                throw createErr; // couldn't find by name either
              });
          }
          throw createErr;
        });
    })
    .catch(function (err) {
      var message = err.message;
      if (err.response && err.response.data) {
        message = err.response.data.message || err.response.data.error || message;
      }
      log.error('[api/contacts POST] ' + message);
      res.status(502).json({ error: 'Unable to create contact' });
    });
});

module.exports = router;

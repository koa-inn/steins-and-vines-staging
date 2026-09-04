var axios = require('axios');

// ---------------------------------------------------------------------------
// Transactional email via the Resend HTTPS API.
//
// Why not SMTP: Railway blocks ALL outbound SMTP ports (25/465/587/2525) on
// both IPv4 and IPv6 — verified via a net.connect probe from inside the
// container. Gmail/nodemailer can therefore never connect. HTTPS (443) egress
// works fine, so transactional mail goes through Resend's REST API instead.
//
// Required env: RESEND_API_KEY. Optional: MAIL_FROM (must be an address on a
// Resend-verified domain; use 'onboarding@resend.dev' before steinsandvines.ca
// is verified). CONTACT_TO controls staff/notification recipients.
// ---------------------------------------------------------------------------

var RESEND_API = 'https://api.resend.com';

function fromAddress() {
  return process.env.MAIL_FROM || 'Steins & Vines <hello@steinsandvines.ca>';
}

function staffTo() {
  return process.env.CONTACT_TO || 'hello@steinsandvines.ca';
}

/**
 * Whether the mail transport is configured. Without RESEND_API_KEY every email
 * in this module is a no-op failure (staff notifications AND customer
 * confirmations).
 * @returns {boolean}
 */
function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function describeError(err) {
  if (err && err.response && err.response.data) {
    var d = err.response.data;
    return d.message || d.error || JSON.stringify(d);
  }
  return err && err.message ? err.message : String(err);
}

/**
 * POST one message through Resend. Resolves with the Resend response body
 * ({ id }) on success; rejects with a descriptive Error otherwise.
 *
 * @param {Object} msg
 * @param {string|string[]} msg.to
 * @param {string} msg.subject
 * @param {string} msg.text
 * @param {string} [msg.replyTo]
 * @param {string} [msg.from]
 */
function sendViaResend(msg) {
  if (!isConfigured()) {
    return Promise.reject(new Error('RESEND_API_KEY not set'));
  }
  if (!msg.to) {
    return Promise.reject(new Error('No recipient provided'));
  }

  var payload = {
    from: msg.from || fromAddress(),
    to: Array.isArray(msg.to) ? msg.to : [msg.to],
    subject: msg.subject,
    text: msg.text
  };
  if (msg.html) {
    payload.html = msg.html;
  }
  if (msg.replyTo) {
    payload.reply_to = msg.replyTo;
  }

  return axios.post(RESEND_API + '/emails', payload, {
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  }).then(function (res) {
    return res.data;
  }).catch(function (err) {
    throw new Error('Resend send failed: ' + describeError(err));
  });
}

/**
 * Verify the mail transport works. Used at startup so a missing/invalid Resend
 * API key surfaces on deploy instead of on the next customer's order.
 *
 * Never rejects — resolves a structured result so callers can log without a
 * try/catch and startup is never blocked by mail problems.
 *
 * @returns {Promise<{ok: boolean, configured: boolean, error?: string}>}
 */
function verifyTransport() {
  if (!isConfigured()) {
    return Promise.resolve({ ok: false, configured: false, error: 'RESEND_API_KEY not set' });
  }
  // A lightweight authenticated GET confirms the key is valid without sending.
  return axios.get(RESEND_API + '/domains', {
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY },
    timeout: 10000
  }).then(function () {
    return { ok: true, configured: true };
  }).catch(function (err) {
    return { ok: false, configured: true, error: describeError(err) };
  });
}

/**
 * Send a notification email when the checkout flow completes in offline mode
 * (Zoho is not authenticated). The store can then manually enter the reservation.
 *
 * @param {Object} orderData
 * @param {string} orderData.ref        - Offline reference number (e.g. REF-ABCD1234)
 * @param {Object} orderData.customer   - { name, email, phone }
 * @param {Array}  orderData.items      - [{ name, quantity, rate }]
 * @param {string} orderData.timeslot   - Human-readable timeslot string
 * @param {string} orderData.notes      - Order notes
 */
function sendOfflineOrderNotification(orderData) {
  var customer = orderData.customer || {};
  var items = orderData.items || [];
  var ref = orderData.ref || '';

  var subject = '[ACTION REQUIRED] Offline reservation: ' + (customer.name || 'Unknown') + ' — ' + ref;

  var itemLines = items.map(function (it) {
    return '  - ' + it.name + ' × ' + (it.quantity || 1) +
      (it.rate ? ' @ $' + Number(it.rate).toFixed(2) : '');
  }).join('\n');

  var body = [
    'A reservation was submitted while Zoho was unavailable.',
    'Please manually enter this in Zoho when the connection is restored.',
    '',
    'Reference: ' + ref,
    'Name:      ' + (customer.name || 'N/A'),
    'Email:     ' + (customer.email || 'N/A'),
    'Phone:     ' + (customer.phone || 'N/A'),
    'Timeslot:  ' + (orderData.timeslot || 'N/A'),
    '',
    'Items:',
    itemLines || '  (none)',
    '',
    'Notes: ' + (orderData.notes || 'None')
  ].join('\n');

  return sendViaResend({
    to: staffTo(),
    replyTo: customer.email || staffTo(),
    subject: subject,
    text: body
  });
}

/**
 * Send an internal notification email when a reservation is successfully placed online.
 * Fires non-blocking (caller should .catch() it).
 *
 * @param {Object} orderData
 * @param {string} orderData.orderNumber  - Zoho Sales Order number (e.g. SO-001234)
 * @param {Object} orderData.customer     - { name, email, phone }
 * @param {Array}  orderData.items        - [{ name, quantity, rate }]
 * @param {string} orderData.timeslot     - Human-readable timeslot string
 * @param {string} orderData.notes        - Order notes
 */
function sendReservationNotification(orderData) {
  var customer = orderData.customer || {};
  var items = orderData.items || [];
  var orderNumber = orderData.orderNumber || '';

  var subject = 'New reservation: ' + (customer.name || 'Unknown') + ' — ' + orderNumber;

  var itemLines = items.map(function (it) {
    return '  - ' + (it.name || 'Unknown item') + ' × ' + (it.quantity || 1) +
      (it.rate ? ' @ $' + Number(it.rate).toFixed(2) : '');
  }).join('\n');

  var body = [
    'A new reservation was placed on the website.',
    '',
    'Order:     ' + orderNumber,
    'Name:      ' + (customer.name || 'N/A'),
    'Email:     ' + (customer.email || 'N/A'),
    'Phone:     ' + (customer.phone || 'N/A'),
    'Timeslot:  ' + (orderData.timeslot || 'N/A'),
    '',
    'Items:',
    itemLines || '  (none)',
    '',
    'Notes: ' + (orderData.notes || 'None')
  ].join('\n');

  return sendViaResend({
    to: staffTo(),
    replyTo: customer.email || staffTo(),
    subject: subject,
    text: body
  });
}

/**
 * Send an admin alert when a payment void fails after a Zoho order failure.
 * Manual action is required to void the transaction in the payment processor.
 *
 * @param {Object} data
 * @param {string} data.txnId     - Payment transaction ID
 * @param {number} data.amount    - Charged amount
 * @param {string} data.error     - Error message
 * @param {string} data.timestamp - ISO timestamp
 */
function sendVoidFailureAlert(data) {
  var subject = '[ACTION REQUIRED] Helcim void failed — manual review needed';
  var body = [
    'A Helcim transaction void FAILED after a Zoho order failure.',
    'Manual action is required to void this transaction.',
    '',
    'Transaction ID: ' + (data.txnId || 'unknown'),
    'Amount:         $' + (Number(data.amount) || 0).toFixed(2),
    'Error:          ' + (data.error || 'unknown'),
    'Timestamp:      ' + (data.timestamp || new Date().toISOString()),
    '',
    'Please void this transaction manually in the Helcim dashboard.'
  ].join('\n');

  return sendViaResend({
    to: staffTo(),
    subject: subject,
    text: body
  });
}

/**
 * Send a plain-text order confirmation email to the customer.
 * Used as a fallback when the Zoho email API fails.
 *
 * @param {Object} data
 * @param {string} data.email        - Customer email address
 * @param {string} data.orderNumber  - Zoho Sales Order number (e.g. SO-001234)
 * @param {Array}  data.items        - [{ name, quantity, rate }]
 * @param {string} data.timeslot     - Human-readable timeslot string
 */
function sendCustomerConfirmation(data) {
  if (!data.email) return Promise.reject(new Error('No customer email provided'));

  var orderNumber = data.orderNumber || '';
  var items = data.items || [];
  var timeslot = data.timeslot || '';

  var subject = 'Steins & Vines — Order Confirmation ' + orderNumber;

  var itemLines = items.map(function (it) {
    return '  - ' + (it.name || 'Item') + ' x ' + (it.quantity || 1);
  }).join('\n');

  var body = [
    'Thank you for your order with Steins & Vines!',
    '',
    'Order Number: ' + orderNumber,
    timeslot ? 'Timeslot: ' + timeslot : '',
    '',
    'Items:',
    itemLines || '  (none)',
    '',
    'If you have any questions, reply to this email or call us at (604) 567-4565.',
    '',
    'Steins & Vines',
    '38021 Cleveland Ave, Squamish, BC'
  ].filter(function (line) { return line !== ''; }).join('\n');

  return sendViaResend({
    to: data.email,
    replyTo: staffTo(),
    subject: subject,
    text: body
  });
}

/**
 * Send a contact-form submission to the store. Replaces the inline SMTP
 * transport that previously lived in server.js (also blocked by Railway).
 *
 * @param {Object} data
 * @param {string} data.name    - Sender name (already CRLF-stripped by caller)
 * @param {string} data.email   - Sender email (used as reply-to)
 * @param {string} data.message - Message body
 */
function sendContactMessage(data) {
  var name = data.name || 'Unknown';
  return sendViaResend({
    to: staffTo(),
    replyTo: data.email,
    subject: 'New message from ' + name + ' via steinsandvines.ca',
    text: 'Name: ' + name + '\nEmail: ' + (data.email || 'N/A') + '\n\nMessage:\n' + (data.message || '')
  });
}

/**
 * Notify staff that someone joined the beer waitlist. The subscriber is also
 * added to MailerLite; this is just the heads-up so signups aren't missed.
 * @param {Object} data
 * @param {string} data.email - the customer's email (also reply-to)
 */
function sendWaitlistNotification(data) {
  var email = (data.email || '').trim();
  return sendViaResend({
    to: staffTo(),
    replyTo: email || staffTo(),
    subject: 'New beer waitlist signup',
    text: 'A new customer joined the beer waitlist:\n\nEmail: ' + (email || 'N/A') +
      '\n\nThey have also been added to the MailerLite beer-waitlist group.'
  });
}

/**
 * HTML-escape a string for safe insertion into HTML.
 * Escapes &, <, >, ", and '.
 * @param {string} s
 * @returns {string}
 */
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Send a bottling-appointment invite email to a customer with a pre-filled
 * Cal.com booking link. Supersedes the Apps Script MailApp path (POST
 * /api/batch/bottling-invite) — routed through Resend so Railway's blocked
 * SMTP ports are not a factor.
 *
 * @param {Object} data
 * @param {string} data.name        - Customer full name
 * @param {string} data.email       - Customer email address (required; validated)
 * @param {string} data.batchId     - Batch ID (e.g. SV-B-000001)
 * @param {string} data.productName - Product name (e.g. "Pinot Noir")
 */
function sendBottlingInvite(data) {
  var email = (data.email || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return Promise.reject(new Error('Invalid or missing customer email'));
  }

  var fullName = (data.name || '').trim();
  // Greeting: first word of name, or 'there' if name is empty
  var greeting = fullName ? fullName.split(/\s+/)[0] : 'there';
  var product = (data.productName || 'your batch').trim();
  var batchId = (data.batchId || '').trim();

  var baseUrl = process.env.CALCOM_BOTTLING_BOOKING_URL ||
    'https://cal.com/steins-and-vines-tw8csc/bottling-appointment';
  var bookingUrl = baseUrl +
    '?name=' + encodeURIComponent(fullName) +
    '&email=' + encodeURIComponent(email);

  var subject = 'Book your bottling appointment — Steins & Vines';

  var htmlBody =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2c2c2c;line-height:1.6;">' +
    '<p>Hi ' + htmlEscape(greeting) + ',</p>' +
    '<p>Your batch <strong>' + htmlEscape(product) + '</strong> (' + htmlEscape(batchId) + ') is ready for bottling. ' +
    'Pick a time that works for you:</p>' +
    '<p style="margin:24px 0;"><a href="' + bookingUrl + '" ' +
    'style="background:#4a6f4b;color:#ffffff;text-decoration:none;padding:12px 22px;' +
    'border-radius:6px;font-weight:bold;display:inline-block;">Book your bottling appointment</a></p>' +
    '<p style="font-size:13px;color:#5f5f5f;">Or paste this link into your browser:<br>' + htmlEscape(bookingUrl) + '</p>' +
    '<p>Cheers,<br>Steins &amp; Vines</p></div>';

  var plainBody =
    'Hi ' + greeting + ',\n\n' +
    'Your batch ' + product + ' (' + batchId + ') is ready for bottling. ' +
    'Pick a time that works for you:\n\n' + bookingUrl + '\n\nCheers,\nSteins & Vines';

  return sendViaResend({
    to: email,
    replyTo: 'hello@steinsandvines.ca',
    subject: subject,
    html: htmlBody,
    text: plainBody
  });
}

/**
 * Send a staff-composed contact email to a waitlist customer, inviting them to
 * book via a pre-resolved Cal.com link. Unlike sendBottlingInvite, this
 * function does NOT build the subject/body template — staff already reviewed
 * (and possibly edited) both in BrewPad before this is called, so the only
 * job here is "send exactly what was given." The bookingUrl is likewise
 * pre-resolved by the caller (from GET /api/bookings/services' listEventType-
 * backed cache) — this function must never construct one itself and must
 * never read CALCOM_BOTTLING_BOOKING_URL (Phase 80 D-06).
 *
 * @param {Object} data
 * @param {string} data.to         - Customer email address (required; validated)
 * @param {string} data.subject    - Staff-composed subject line (required)
 * @param {string} data.body       - Staff-composed plaintext body (required)
 * @param {string} data.bookingUrl - Pre-resolved Cal.com booking URL (required)
 */
function sendWaitlistContact(data) {
  data = data || {};
  var to = (data.to || '').trim();
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!to || !emailRegex.test(to)) {
    return Promise.reject(new Error('Invalid or missing recipient email'));
  }

  var subject = (data.subject || '').trim();
  if (!subject) {
    return Promise.reject(new Error('Missing email subject'));
  }

  var body = data.body || '';
  if (!body.trim()) {
    return Promise.reject(new Error('Missing email body'));
  }

  var bookingUrl = (data.bookingUrl || '').trim();
  if (!bookingUrl) {
    return Promise.reject(new Error('Missing booking URL'));
  }

  var paragraphs = body.split(/\n+/).map(function (p) {
    return '<p>' + htmlEscape(p) + '</p>';
  }).join('');

  var htmlBody =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2c2c2c;line-height:1.6;">' +
    paragraphs +
    // CR-01: bookingUrl is client-supplied here (req.body.bookingUrl via
    // pos.js), unlike sendBottlingInvite's server-constructed URL. It MUST be
    // escaped before entering the attribute or a `"` closes the href and
    // injects sibling attributes into the anchor. The plaintext echo below was
    // already escaped — this is the one interpolation that was not.
    '<p style="margin:24px 0;"><a href="' + htmlEscape(bookingUrl) + '" ' +
    'style="background:#4a6f4b;color:#ffffff;text-decoration:none;padding:12px 22px;' +
    'border-radius:6px;font-weight:bold;display:inline-block;">Book your appointment</a></p>' +
    '<p style="font-size:13px;color:#5f5f5f;">Or paste this link into your browser:<br>' + htmlEscape(bookingUrl) + '</p>' +
    '<p>Cheers,<br>Steins &amp; Vines</p></div>';

  return sendViaResend({
    to: to,
    replyTo: 'hello@steinsandvines.ca',
    subject: subject,
    html: htmlBody,
    text: body
  });
}

module.exports = {
  isConfigured: isConfigured,
  verifyTransport: verifyTransport,
  sendOfflineOrderNotification: sendOfflineOrderNotification,
  sendReservationNotification: sendReservationNotification,
  sendVoidFailureAlert: sendVoidFailureAlert,
  sendCustomerConfirmation: sendCustomerConfirmation,
  sendContactMessage: sendContactMessage,
  sendBottlingInvite: sendBottlingInvite,
  sendWaitlistNotification: sendWaitlistNotification,
  sendWaitlistContact: sendWaitlistContact
};

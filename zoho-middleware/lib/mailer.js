var nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
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
  var to = process.env.CONTACT_TO || 'hello@steinsandvines.ca';
  var customer = orderData.customer || {};
  var items = orderData.items || [];
  var ref = orderData.ref || '';

  var subject = '[ACTION REQUIRED] Offline reservation: ' + (customer.name || 'Unknown') + ' — ' + ref;

  var itemLines = items.map(function (it) {
    return '  - ' + it.name + ' \u00d7 ' + (it.quantity || 1) +
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

  return createTransport().sendMail({
    from: process.env.SMTP_USER,
    to: to,
    replyTo: customer.email || process.env.SMTP_USER,
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
  var to = process.env.CONTACT_TO || 'hello@steinsandvines.ca';
  var customer = orderData.customer || {};
  var items = orderData.items || [];
  var orderNumber = orderData.orderNumber || '';

  var subject = 'New reservation: ' + (customer.name || 'Unknown') + ' \u2014 ' + orderNumber;

  var itemLines = items.map(function (it) {
    return '  - ' + (it.name || 'Unknown item') + ' \u00d7 ' + (it.quantity || 1) +
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

  return createTransport().sendMail({
    from: process.env.SMTP_USER,
    to: to,
    replyTo: customer.email || process.env.SMTP_USER,
    subject: subject,
    text: body
  });
}

/**
 * Send an admin alert when a GP void fails after a Zoho order failure.
 * Manual action is required to void the transaction in Global Payments.
 *
 * @param {Object} data
 * @param {string} data.txnId     - Global Payments transaction ID
 * @param {number} data.amount    - Charged amount
 * @param {string} data.error     - Error message
 * @param {string} data.timestamp - ISO timestamp
 */
function sendVoidFailureAlert(data) {
  var to = process.env.CONTACT_TO || 'hello@steinsandvines.ca';
  var subject = '[ACTION REQUIRED] GP void failed — manual review needed';
  var body = [
    'A Global Payments transaction void FAILED after a Zoho order failure.',
    'Manual action is required to void this transaction.',
    '',
    'Transaction ID: ' + (data.txnId || 'unknown'),
    'Amount:         $' + (Number(data.amount) || 0).toFixed(2),
    'Error:          ' + (data.error || 'unknown'),
    'Timestamp:      ' + (data.timestamp || new Date().toISOString()),
    '',
    'Please void this transaction manually in the Global Payments dashboard.'
  ].join('\n');

  return createTransport().sendMail({
    from: process.env.SMTP_USER,
    to: to,
    subject: subject,
    text: body
  });
}

module.exports = {
  sendOfflineOrderNotification: sendOfflineOrderNotification,
  sendReservationNotification: sendReservationNotification,
  sendVoidFailureAlert: sendVoidFailureAlert
};

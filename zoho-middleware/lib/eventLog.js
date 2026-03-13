/**
 * Structured event logger for business-critical operations.
 *
 * Wraps the application logger to emit structured JSON events with a
 * consistent shape, making them easy to filter in Railway's log aggregator.
 *
 * ZERO PII POLICY — the data object passed to logEvent() MUST NEVER contain:
 *   - customerEmail / email
 *   - customerName / name / customer_name
 *   - customerPhone / phone
 *   - payment_token / card data of any kind
 *   - full address fields
 *
 * Safe fields: txnId, cartKey, itemCount, grandTotal, soNumber, soId,
 *              invoiceNumber, invoiceId, voidResult, voidError, refNumber
 */

var log = require('./logger');

/**
 * Emit a structured business-event log line.
 *
 * @param {string} eventType - Dot-namespaced event name, e.g. 'checkout.completed'
 * @param {object} data      - Supplementary fields (NO PII — see module header)
 */
function logEvent(eventType, data) {
  var extra = { event: eventType };
  if (data && typeof data === 'object') {
    Object.keys(data).forEach(function (k) { extra[k] = data[k]; });
  }
  log.info('[event] ' + eventType, extra);
}

module.exports = { logEvent: logEvent };

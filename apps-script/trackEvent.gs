/**
 * Anonymous product event tracking endpoint.
 *
 * Deployment:
 *   Extensions → Apps Script → Deploy → New Deployment → Web App
 *   Execute as: Me | Access: Anyone
 *
 * Receives batched events from the frontend and appends rows to
 * the "ProductEvents" sheet. No PII is collected.
 *
 * Expected POST body:
 *   { "events": [ { "type": "reserve"|"detail", "sku": "...", "name": "..." } ] }
 */

var EVENTS_SHEET_NAME = 'ProductEvents';
var MAX_EVENTS_PER_REQUEST = 50;
var VALID_EVENT_TYPES = ['reserve', 'detail'];

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var events = payload.events;

    if (!Array.isArray(events) || events.length === 0) {
      return _jsonResponse({ ok: false, error: 'No events provided' });
    }

    if (events.length > MAX_EVENTS_PER_REQUEST) {
      return _jsonResponse({ ok: false, error: 'Too many events (max ' + MAX_EVENTS_PER_REQUEST + ')' });
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENTS_SHEET_NAME);
    if (!sheet) {
      return _jsonResponse({ ok: false, error: 'Sheet not found' });
    }

    var now = new Date();
    var rows = [];

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (!ev.type || !ev.sku || !ev.name) continue;
      if (VALID_EVENT_TYPES.indexOf(ev.type) === -1) continue;

      rows.push([now, ev.type, String(ev.sku), String(ev.name)]);
    }

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
    }

    return _jsonResponse({ ok: true, recorded: rows.length });
  } catch (err) {
    return _jsonResponse({ ok: false, error: err.message });
  }
}

function doGet() {
  return _jsonResponse({ status: 'ok', sheet: EVENTS_SHEET_NAME });
}

function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

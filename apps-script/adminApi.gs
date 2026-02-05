/**
 * Secure Admin API for Steins & Vines
 *
 * This script provides SERVER-SIDE authentication and authorization for admin operations.
 * All requests are validated against the staff_emails list in the Config sheet.
 *
 * SECURITY MODEL:
 * - Every API request checks Session.getActiveUser().getEmail() against staff_emails
 * - Even users with Google account access cannot read/write data unless they're in the list
 * - This prevents bypassing the frontend authorization check
 *
 * DEPLOYMENT STEPS:
 * 1. Open the Google Spreadsheet that contains your data
 * 2. Go to Extensions → Apps Script
 * 3. In the Apps Script editor:
 *    a. Click "+" next to Files to create a new script file
 *    b. Name it "adminApi" (it will automatically add .gs)
 *    c. Delete any default code and paste this entire file
 * 4. Click the "Deploy" button → "New deployment"
 * 5. Click the gear icon next to "Select type" and choose "Web app"
 * 6. Configure the deployment:
 *    - Description: "Admin API v1"
 *    - Execute as: "User accessing the web app" ← CRITICAL!
 *    - Who has access: "Anyone with Google Account"
 * 7. Click "Deploy"
 * 8. Authorize the script when prompted (review permissions)
 * 9. Copy the Web App URL (looks like: https://script.google.com/macros/s/xxx/exec)
 * 10. Add the URL to your sheets-config.js:
 *     ADMIN_API_URL: 'https://script.google.com/macros/s/xxx/exec',
 *
 * UPDATING THE DEPLOYMENT:
 * - After making changes, go to Deploy → Manage deployments
 * - Click the pencil icon to edit
 * - Change "Version" to "New version"
 * - Click "Deploy"
 *
 * TESTING:
 * - Run the testAuth() function in the script editor to verify your setup
 * - Check the execution logs for any errors
 *
 * IMPORTANT: The script MUST be deployed with "Execute as: User accessing the web app"
 * so that Session.getActiveUser().getEmail() returns the actual user's email,
 * not the script owner's email.
 */

var CONFIG_SHEET_NAME = 'Config';
var RESERVATIONS_SHEET_NAME = 'Reservations';
var HOLDS_SHEET_NAME = 'Holds';
var SCHEDULE_SHEET_NAME = 'Schedule';
var HOMEPAGE_SHEET_NAME = 'Homepage';
var KITS_SHEET_NAME = 'Kits';

/**
 * Handle GET requests
 * Used for: auth check, reading data
 */
function doGet(e) {
  var authResult = checkAuthorization(e);
  if (!authResult.authorized) {
    return _jsonResponse({ ok: false, error: 'unauthorized', message: authResult.message });
  }

  var action = (e.parameter.action || '').toLowerCase();

  // Pagination parameters
  var limit = parseInt(e.parameter.limit, 10) || 0; // 0 = no limit
  var offset = parseInt(e.parameter.offset, 10) || 0;
  var status = e.parameter.status || ''; // Filter by status

  try {
    switch (action) {
      case 'check_auth':
        return _jsonResponse({ ok: true, email: authResult.email, authorized: true });

      case 'get_reservations':
        return _jsonResponse({ ok: true, data: getReservations(limit, offset, status) });

      case 'get_holds':
        return _jsonResponse({ ok: true, data: getHolds() });

      case 'get_schedule':
        return _jsonResponse({ ok: true, data: getSchedule() });

      case 'get_homepage':
        return _jsonResponse({ ok: true, data: getHomepage() });

      case 'get_kits':
        return _jsonResponse({ ok: true, data: getKits() });

      case 'get_config':
        return _jsonResponse({ ok: true, data: getConfig() });

      case 'get_dashboard_summary':
        return _jsonResponse({ ok: true, data: getDashboardSummary() });

      default:
        return _jsonResponse({ ok: false, error: 'invalid_action', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    return _jsonResponse({ ok: false, error: 'server_error', message: err.message });
  }
}

/**
 * Handle POST requests
 * Used for: updating data
 */
function doPost(e) {
  var authResult = checkAuthorization(e);
  if (!authResult.authorized) {
    return _jsonResponse({ ok: false, error: 'unauthorized', message: authResult.message });
  }

  try {
    var payload = JSON.parse(e.postData.contents);
    var action = (payload.action || '').toLowerCase();

    switch (action) {
      case 'update_reservation':
        return _jsonResponse(updateReservation(payload, authResult.email));

      case 'update_hold':
        return _jsonResponse(updateHold(payload, authResult.email));

      case 'update_schedule':
        return _jsonResponse(updateSchedule(payload));

      case 'update_homepage':
        return _jsonResponse(updateHomepage(payload));

      case 'update_kits':
        return _jsonResponse(updateKits(payload));

      default:
        return _jsonResponse({ ok: false, error: 'invalid_action', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    return _jsonResponse({ ok: false, error: 'server_error', message: err.message });
  }
}

/**
 * Check if the current user is authorized (email in staff_emails)
 * Validates OAuth token using Google's tokeninfo endpoint
 * Token can come from: URL parameter (GET) or POST body
 * @param {Object} e - The event object from doGet/doPost
 */
function checkAuthorization(e) {
  var email = null;
  var token = null;

  // Try to get token from URL parameter (for GET requests)
  if (e && e.parameter && e.parameter.token) {
    token = e.parameter.token;
  }

  // Try to get token from POST body (for POST requests)
  if (!token && e && e.postData && e.postData.contents) {
    try {
      var postBody = JSON.parse(e.postData.contents);
      if (postBody.token) {
        token = postBody.token;
      }
    } catch (err) {
      // Not JSON or no token in body
    }
  }

  // Validate token with Google's tokeninfo endpoint
  if (token) {
    try {
      var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token, {
        muteHttpExceptions: true
      });
      var statusCode = response.getResponseCode();
      if (statusCode === 200) {
        var tokenInfo = JSON.parse(response.getContentText());
        email = tokenInfo.email;
        Logger.log('Token validated for: ' + email);
      } else {
        Logger.log('Token validation failed with status: ' + statusCode);
      }
    } catch (err) {
      Logger.log('Token validation error: ' + err.message);
    }
  }

  // Fallback: try Session.getActiveUser() (works when user directly visits the web app)
  if (!email) {
    try {
      email = Session.getActiveUser().getEmail();
      if (email) {
        Logger.log('Got email from Session: ' + email);
      }
    } catch (err) {
      Logger.log('Session.getActiveUser error: ' + err.message);
    }
  }

  if (!email) {
    return {
      authorized: false,
      message: 'Could not determine user email. Please sign in again.'
    };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);

  if (!configSheet) {
    return { authorized: false, message: 'Config sheet not found' };
  }

  var configData = configSheet.getDataRange().getValues();
  var staffEmails = [];

  for (var i = 0; i < configData.length; i++) {
    if (configData[i][0] === 'staff_emails') {
      staffEmails = (configData[i][1] || '').split(',').map(function(e) {
        return e.trim().toLowerCase();
      });
      break;
    }
  }

  var emailLower = email.toLowerCase();
  if (staffEmails.indexOf(emailLower) === -1) {
    return {
      authorized: false,
      email: email,
      message: 'User ' + email + ' is not authorized as admin'
    };
  }

  return { authorized: true, email: email };
}

// ===== READ OPERATIONS =====

/**
 * Get reservations with optional pagination and filtering
 * @param {number} limit - Max rows to return (0 = all)
 * @param {number} offset - Starting row index (after header)
 * @param {string} status - Filter by status ('active' excludes archived, or specific status)
 */
function getReservations(limit, offset, status) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RESERVATIONS_SHEET_NAME);
  if (!sheet) return { values: [], total: 0, filtered: 0 };

  var data = sheet.getDataRange().getValues();
  if (data.length === 0) return { values: [], total: 0, filtered: 0 };

  var headers = data[0];
  var statusCol = headers.indexOf('status');
  var submittedCol = headers.indexOf('submitted_at');

  // Total rows (excluding header)
  var totalRows = data.length - 1;

  // Filter by status if specified
  var filteredData = [headers]; // Always include headers
  var dataRows = data.slice(1); // All data rows

  // Sort by submitted_at descending (newest first)
  if (submittedCol !== -1) {
    dataRows.sort(function(a, b) {
      var dateA = a[submittedCol] || '';
      var dateB = b[submittedCol] || '';
      return dateB.toString().localeCompare(dateA.toString());
    });
  }

  if (status && statusCol !== -1) {
    if (status === 'active') {
      // All except archived
      dataRows = dataRows.filter(function(row) {
        var rowStatus = (row[statusCol] || '').toString().toLowerCase().trim() || 'pending';
        return rowStatus !== 'archived';
      });
    } else if (status !== 'all') {
      // Specific status
      dataRows = dataRows.filter(function(row) {
        var rowStatus = (row[statusCol] || '').toString().toLowerCase().trim() || 'pending';
        return rowStatus === status.toLowerCase();
      });
    }
  }

  var filteredCount = dataRows.length;

  // Apply pagination
  if (limit > 0) {
    dataRows = dataRows.slice(offset, offset + limit);
  } else if (offset > 0) {
    dataRows = dataRows.slice(offset);
  }

  filteredData = filteredData.concat(dataRows);

  return {
    values: filteredData,
    total: totalRows,
    filtered: filteredCount,
    limit: limit,
    offset: offset
  };
}

function getHolds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HOLDS_SHEET_NAME);
  if (!sheet) return { values: [] };

  var data = sheet.getDataRange().getValues();
  return { values: data };
}

function getSchedule() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SCHEDULE_SHEET_NAME);
  if (!sheet) return { values: [] };

  var data = sheet.getDataRange().getValues();
  return { values: data };
}

function getHomepage() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HOMEPAGE_SHEET_NAME);
  if (!sheet) return { values: [] };

  var data = sheet.getDataRange().getValues();
  return { values: data };
}

function getKits() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(KITS_SHEET_NAME);
  if (!sheet) return { values: [] };

  var data = sheet.getDataRange().getValues();
  return { values: data };
}

function getConfig() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sheet) return { values: [] };

  var data = sheet.getDataRange().getValues();
  // Filter out sensitive data like staff_emails from being returned
  var filtered = data.filter(function(row) {
    return row[0] !== 'staff_emails';
  });
  return { values: filtered };
}

/**
 * Get dashboard summary metrics for the admin overview
 * Returns counts of reservations by status, pending holds, low stock kits, etc.
 */
function getDashboardSummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var today = new Date();
  var todayStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // Initialize summary object
  var summary = {
    reservationsToday: 0,
    pendingReservations: 0,
    confirmedReservations: 0,
    brewingReservations: 0,
    readyReservations: 0,
    completedReservations: 0,
    cancelledReservations: 0,
    archivedReservations: 0,
    totalActiveReservations: 0,
    pendingHolds: 0,
    lowStockKits: [],
    upcomingAppointments: []
  };

  // Get Reservations data
  var reservationsSheet = ss.getSheetByName(RESERVATIONS_SHEET_NAME);
  if (reservationsSheet) {
    var resData = reservationsSheet.getDataRange().getValues();
    if (resData.length > 1) {
      var headers = resData[0];
      var statusCol = headers.indexOf('status');
      var submittedCol = headers.indexOf('submitted_at');
      var appointmentCol = headers.indexOf('appointment_date');
      var nameCol = headers.indexOf('name');
      var kitCol = headers.indexOf('kit_name');

      for (var i = 1; i < resData.length; i++) {
        var row = resData[i];
        var status = (statusCol !== -1 ? (row[statusCol] || '').toString().toLowerCase().trim() : '') || 'pending';

        // Count by status
        switch (status) {
          case 'pending': summary.pendingReservations++; break;
          case 'confirmed': summary.confirmedReservations++; break;
          case 'brewing': summary.brewingReservations++; break;
          case 'ready': summary.readyReservations++; break;
          case 'completed': summary.completedReservations++; break;
          case 'cancelled': summary.cancelledReservations++; break;
          case 'archived': summary.archivedReservations++; break;
        }

        // Count reservations submitted today
        if (submittedCol !== -1 && row[submittedCol]) {
          var submittedDate = row[submittedCol].toString().substring(0, 10);
          if (submittedDate === todayStr) {
            summary.reservationsToday++;
          }
        }

        // Track upcoming appointments (next 7 days, only for active statuses)
        if (appointmentCol !== -1 && row[appointmentCol] &&
            (status === 'confirmed' || status === 'pending')) {
          var apptDate = new Date(row[appointmentCol]);
          var daysDiff = Math.ceil((apptDate - today) / (1000 * 60 * 60 * 24));
          if (daysDiff >= 0 && daysDiff <= 7) {
            summary.upcomingAppointments.push({
              name: nameCol !== -1 ? row[nameCol] : 'Unknown',
              kit: kitCol !== -1 ? row[kitCol] : '',
              date: Utilities.formatDate(apptDate, Session.getScriptTimeZone(), 'MMM d'),
              daysAway: daysDiff
            });
          }
        }
      }

      // Total active = all non-archived, non-cancelled
      summary.totalActiveReservations = summary.pendingReservations +
        summary.confirmedReservations + summary.brewingReservations +
        summary.readyReservations + summary.completedReservations;
    }
  }

  // Get Holds data
  var holdsSheet = ss.getSheetByName(HOLDS_SHEET_NAME);
  if (holdsSheet) {
    var holdsData = holdsSheet.getDataRange().getValues();
    if (holdsData.length > 1) {
      var holdHeaders = holdsData[0];
      var holdStatusCol = holdHeaders.indexOf('status');

      for (var j = 1; j < holdsData.length; j++) {
        var holdStatus = (holdStatusCol !== -1 ? (holdsData[j][holdStatusCol] || '').toString().toLowerCase().trim() : 'pending');
        if (holdStatus === 'pending' || holdStatus === 'active' || holdStatus === '') {
          summary.pendingHolds++;
        }
      }
    }
  }

  // Get Kits data for low stock alerts
  var kitsSheet = ss.getSheetByName(KITS_SHEET_NAME);
  if (kitsSheet) {
    var kitsData = kitsSheet.getDataRange().getValues();
    if (kitsData.length > 1) {
      var kitHeaders = kitsData[0];
      var kitNameCol = kitHeaders.indexOf('name');
      var stockCol = kitHeaders.indexOf('stock');
      var lowStockThresholdCol = kitHeaders.indexOf('low_stock_threshold');
      var activeCol = kitHeaders.indexOf('active');

      for (var k = 1; k < kitsData.length; k++) {
        var kitRow = kitsData[k];

        // Only check active kits
        var isActive = activeCol === -1 ||
          kitRow[activeCol] === true ||
          kitRow[activeCol] === 'TRUE' ||
          kitRow[activeCol] === 1 ||
          kitRow[activeCol] === '';

        if (!isActive) continue;

        var stock = stockCol !== -1 ? parseInt(kitRow[stockCol], 10) || 0 : 0;
        var threshold = lowStockThresholdCol !== -1 ? parseInt(kitRow[lowStockThresholdCol], 10) || 5 : 5;

        if (stock <= threshold && kitNameCol !== -1) {
          summary.lowStockKits.push({
            name: kitRow[kitNameCol],
            stock: stock,
            threshold: threshold
          });
        }
      }
    }
  }

  // Sort upcoming appointments by date
  summary.upcomingAppointments.sort(function(a, b) {
    return a.daysAway - b.daysAway;
  });

  // Limit to 5 upcoming appointments
  summary.upcomingAppointments = summary.upcomingAppointments.slice(0, 5);

  return summary;
}

// ===== WRITE OPERATIONS =====

/**
 * Update a reservation row with optimistic locking
 * payload: { reservationId, expectedVersion, updates: { status, notes, ... } }
 * expectedVersion: the last_updated timestamp the client has; if server has newer, reject
 */
function updateReservation(payload, userEmail) {
  var reservationId = payload.reservationId;
  var expectedVersion = payload.expectedVersion; // ISO timestamp string
  var updates = payload.updates || {};

  if (!reservationId) {
    return { ok: false, error: 'missing_id', message: 'reservationId is required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RESERVATIONS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  // Find column indices
  var idCol = headers.indexOf('reservation_id');
  var statusCol = headers.indexOf('status');
  var notesCol = headers.indexOf('notes');
  var lastUpdatedCol = headers.indexOf('last_updated');

  if (idCol === -1) {
    return { ok: false, error: 'invalid_sheet', message: 'reservation_id column not found' };
  }

  // Find the row with matching reservation_id
  var rowIndex = -1;
  var rowData = null;
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === reservationId) {
      rowIndex = i + 1; // 1-based for sheet
      rowData = data[i];
      break;
    }
  }

  if (rowIndex === -1) {
    return { ok: false, error: 'not_found', message: 'Reservation not found: ' + reservationId };
  }

  // Optimistic locking: check if the row has been modified since client loaded it
  if (expectedVersion && lastUpdatedCol !== -1) {
    var serverVersion = rowData[lastUpdatedCol];
    if (serverVersion) {
      var serverTime = new Date(serverVersion).getTime();
      var clientTime = new Date(expectedVersion).getTime();
      if (serverTime > clientTime) {
        return {
          ok: false,
          error: 'version_conflict',
          message: 'This reservation was modified by another user. Please refresh and try again.',
          serverVersion: serverVersion,
          clientVersion: expectedVersion
        };
      }
    }
  }

  // Apply updates
  var newTimestamp = new Date().toISOString();

  if (updates.status !== undefined && statusCol !== -1) {
    // Status is from a controlled list, but sanitize anyway for safety
    sheet.getRange(rowIndex, statusCol + 1).setValue(sanitizeInput(updates.status));
  }
  if (updates.notes !== undefined && notesCol !== -1) {
    // Sanitize notes to prevent XSS attacks
    sheet.getRange(rowIndex, notesCol + 1).setValue(sanitizeInput(updates.notes));
  }

  // Always update last_updated timestamp
  if (lastUpdatedCol !== -1) {
    sheet.getRange(rowIndex, lastUpdatedCol + 1).setValue(newTimestamp);
  }

  return { ok: true, message: 'Reservation updated', newVersion: newTimestamp };
}

/**
 * Update a hold row with optimistic locking
 * payload: { holdId, expectedVersion, updates: { status, resolved_at, resolved_by, notes } }
 */
function updateHold(payload, userEmail) {
  var holdId = payload.holdId;
  var expectedVersion = payload.expectedVersion;
  var updates = payload.updates || {};

  if (!holdId) {
    return { ok: false, error: 'missing_id', message: 'holdId is required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HOLDS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var idCol = headers.indexOf('hold_id');
  var statusCol = headers.indexOf('status');
  var resolvedAtCol = headers.indexOf('resolved_at');
  var resolvedByCol = headers.indexOf('resolved_by');
  var notesCol = headers.indexOf('notes');
  var lastUpdatedCol = headers.indexOf('last_updated');

  if (idCol === -1) {
    return { ok: false, error: 'invalid_sheet', message: 'hold_id column not found' };
  }

  var rowIndex = -1;
  var rowData = null;
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === holdId) {
      rowIndex = i + 1;
      rowData = data[i];
      break;
    }
  }

  if (rowIndex === -1) {
    return { ok: false, error: 'not_found', message: 'Hold not found: ' + holdId };
  }

  // Optimistic locking: check version
  if (expectedVersion && lastUpdatedCol !== -1) {
    var serverVersion = rowData[lastUpdatedCol];
    if (serverVersion) {
      var serverTime = new Date(serverVersion).getTime();
      var clientTime = new Date(expectedVersion).getTime();
      if (serverTime > clientTime) {
        return {
          ok: false,
          error: 'version_conflict',
          message: 'This hold was modified by another user. Please refresh and try again.',
          serverVersion: serverVersion,
          clientVersion: expectedVersion
        };
      }
    }
  }

  var newTimestamp = new Date().toISOString();

  if (updates.status !== undefined && statusCol !== -1) {
    sheet.getRange(rowIndex, statusCol + 1).setValue(sanitizeInput(updates.status));
  }
  if (updates.resolved_at !== undefined && resolvedAtCol !== -1) {
    sheet.getRange(rowIndex, resolvedAtCol + 1).setValue(updates.resolved_at);
  }
  if (updates.resolved_by !== undefined && resolvedByCol !== -1) {
    // Sanitize resolved_by in case it contains user-provided text
    sheet.getRange(rowIndex, resolvedByCol + 1).setValue(sanitizeInput(updates.resolved_by));
  }
  if (updates.notes !== undefined && notesCol !== -1) {
    // Sanitize notes to prevent XSS attacks
    sheet.getRange(rowIndex, notesCol + 1).setValue(sanitizeInput(updates.notes));
  }

  // Always update last_updated timestamp
  if (lastUpdatedCol !== -1) {
    sheet.getRange(rowIndex, lastUpdatedCol + 1).setValue(newTimestamp);
  }

  return { ok: true, message: 'Hold updated', newVersion: newTimestamp };
}

/**
 * Update the entire Schedule sheet
 * payload: { values: [[...], [...]] }
 */
function updateSchedule(payload) {
  var values = payload.values;
  if (!values || !Array.isArray(values)) {
    return { ok: false, error: 'invalid_data', message: 'values array required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SCHEDULE_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  // Sanitize all string values to prevent XSS
  var sanitizedValues = values.map(function(row) {
    return row.map(function(cell) {
      return typeof cell === 'string' ? sanitizeInput(cell) : cell;
    });
  });

  // Clear existing data and write new
  sheet.clearContents();
  if (sanitizedValues.length > 0) {
    var numCols = sanitizedValues[0].length;
    sheet.getRange(1, 1, sanitizedValues.length, numCols).setValues(sanitizedValues);
  }

  return { ok: true, message: 'Schedule updated' };
}

/**
 * Update the entire Homepage sheet
 * payload: { values: [[...], [...]] }
 */
function updateHomepage(payload) {
  var values = payload.values;
  if (!values || !Array.isArray(values)) {
    return { ok: false, error: 'invalid_data', message: 'values array required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HOMEPAGE_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  // Sanitize all string values to prevent XSS
  var sanitizedValues = values.map(function(row) {
    return row.map(function(cell) {
      return typeof cell === 'string' ? sanitizeInput(cell) : cell;
    });
  });

  sheet.clearContents();
  if (sanitizedValues.length > 0) {
    var numCols = sanitizedValues[0].length;
    sheet.getRange(1, 1, sanitizedValues.length, numCols).setValues(sanitizedValues);
  }

  return { ok: true, message: 'Homepage updated' };
}

/**
 * Update specific cells in the Kits sheet
 * payload: { updates: [{ row, col, value }, ...] }
 */
function updateKits(payload) {
  var updates = payload.updates;
  if (!updates || !Array.isArray(updates)) {
    return { ok: false, error: 'invalid_data', message: 'updates array required' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(KITS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  for (var i = 0; i < updates.length; i++) {
    var u = updates[i];
    if (u.row && u.col && u.value !== undefined) {
      // Sanitize string values to prevent XSS
      var value = typeof u.value === 'string' ? sanitizeInput(u.value) : u.value;
      sheet.getRange(u.row, u.col).setValue(value);
    }
  }

  return { ok: true, message: 'Kits updated', count: updates.length };
}

// ===== UTILITY =====

function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Sanitize user input to prevent XSS attacks
 * Strips script tags and other potentially dangerous HTML
 * @param {string} input - User-provided text
 * @returns {string} Sanitized text
 */
function sanitizeInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return String(input);

  var sanitized = input;

  // Remove script tags and their contents (case-insensitive, handles attributes)
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove individual script tags that might be unclosed
  sanitized = sanitized.replace(/<\/?script[^>]*>/gi, '');

  // Remove event handlers (onclick, onerror, onload, etc.)
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\s*on\w+\s*=\s*[^\s>]+/gi, '');

  // Remove javascript: and data: URLs
  sanitized = sanitized.replace(/javascript\s*:/gi, '');
  sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, '');

  // Remove iframe, object, embed tags
  sanitized = sanitized.replace(/<\/?iframe[^>]*>/gi, '');
  sanitized = sanitized.replace(/<\/?object[^>]*>/gi, '');
  sanitized = sanitized.replace(/<\/?embed[^>]*>/gi, '');

  // Remove style tags (can contain expressions in older IE)
  sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  sanitized = sanitized.replace(/<\/?style[^>]*>/gi, '');

  return sanitized;
}

/**
 * Test function - run this in the script editor to verify setup
 */
function testAuth() {
  var result = checkAuthorization();
  Logger.log('Auth result: ' + JSON.stringify(result));
  return result;
}

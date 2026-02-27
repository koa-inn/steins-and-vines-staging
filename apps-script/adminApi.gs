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
var BATCHES_SHEET_NAME = 'Batches';
var FERM_SCHEDULES_SHEET_NAME = 'FermSchedules';
var BATCH_TASKS_SHEET_NAME = 'BatchTasks';
var PLATO_READINGS_SHEET_NAME = 'PlatoReadings';
var VESSEL_HISTORY_SHEET_NAME = 'VesselHistory';

/**
 * Handle GET requests
 * Used for: auth check, reading data
 */
function doGet(e) {
  var action = (e.parameter.action || '').toLowerCase();

  // Public endpoint: batch detail via access token (no staff auth required)
  if (action === 'get_batch_public') {
    try {
      var batchPublicKey = 'gbp:' + (e.parameter.batch_id || '');
      return _jsonResponse(_cachedGet(batchPublicKey, 5, function() {
        return handleGetBatchPublic(e);
      }));
    } catch (err) {
      return _jsonResponse({ ok: false, error: 'server_error', message: err.message });
    }
  }

  var authResult = checkAuthorization(e);
  if (!authResult.authorized) {
    return _jsonResponse({ ok: false, error: 'unauthorized', message: authResult.message });
  }

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
        return _jsonResponse({ ok: true, data: _cachedGet('gds', 60, function() { return getDashboardSummary(); }) });

      // Batch tracking endpoints
      case 'get_batches':
        return _jsonResponse({ ok: true, data: _cachedGet('gbl', 300, function() {
          return getBatches(limit, offset, status);
        })});

      case 'get_batch':
        return _jsonResponse({ ok: true, data: _cachedGet('gb:' + (e.parameter.batch_id || ''), 300, function() {
          return getBatchDetail(e.parameter.batch_id);
        })});

      case 'get_ferm_schedules':
        return _jsonResponse({ ok: true, data: _cachedGet('gfs', 300, function() {
          return getFermSchedules();
        })});

      case 'get_tasks_calendar':
        return _jsonResponse({ ok: true, data: getTasksCalendar(e.parameter.start_date, e.parameter.end_date) });

      case 'get_tasks_upcoming':
        return _jsonResponse({ ok: true, data: _cachedGet('gtu', 300, function() {
          return getTasksUpcoming(limit || 50);
        })});

      case 'get_batch_dashboard_summary':
        return _jsonResponse({ ok: true, data: _cachedGet('gbds', 300, function() {
          return getBatchDashboardSummary();
        })});

      // Combined endpoint: batches + schedules + summary in one request
      case 'get_batch_init':
        return _jsonResponse({ ok: true, data: _cachedGet('gbi', 300, function() {
          return {
            batches: getBatches(limit, offset, status),
            schedules: getFermSchedules(),
            summary: getBatchDashboardSummary()
          };
        })});

      case 'get_vessels':
        return _jsonResponse({ ok: true, data: getVessels() });

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
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = (payload.action || '').toLowerCase();

    // Check if this is a batch-token-authenticated request (public batch URL)
    if (payload.batch_token && payload.batch_id) {
      var tokenResult = handleBatchTokenPost(payload, action);
      if (tokenResult.ok) _invalidateBatchCache(payload.batch_id);
      return _jsonResponse(tokenResult);
    }

    // All other actions require staff authorization
    var authResult = checkAuthorization(e);
    if (!authResult.authorized) {
      return _jsonResponse({ ok: false, error: 'unauthorized', message: authResult.message });
    }

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

      // Batch tracking endpoints (all invalidate batch cache after write)
      case 'create_batch': {
        var r = createBatch(payload, authResult.email);
        _invalidateBatchCache(r.batch_id || payload.batch_id);
        return _jsonResponse(r);
      }
      case 'update_batch': {
        var r = updateBatch(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'delete_batch': {
        var r = deleteBatch(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'update_batch_schedule': {
        var r = updateBatchSchedule(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'update_batch_task': {
        var r = updateBatchTask(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'bulk_update_batch_tasks': {
        var r = bulkUpdateBatchTasks(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'add_batch_task': {
        var r = addBatchTask(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'add_plato_reading': {
        var r = addPlatoReading(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'bulk_add_plato_readings': {
        var r = bulkAddPlatoReadings(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'update_plato_reading': {
        var r = updatePlatoReading(payload, authResult.email);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'delete_plato_reading': {
        var r = deletePlatoReading(payload);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }
      case 'create_ferm_schedule':
        return _jsonResponse(createFermSchedule(payload, authResult.email));

      case 'update_ferm_schedule':
        return _jsonResponse(updateFermSchedule(payload, authResult.email));

      case 'propagate_ferm_schedule':
        return _jsonResponse(propagateFermSchedule(payload, authResult.email));

      case 'delete_ferm_schedule':
        return _jsonResponse(deleteFermSchedule(payload));

      case 'regenerate_batch_token': {
        var r = regenerateBatchToken(payload);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }

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

  // Validate token with Google's tokeninfo endpoint (cached for 5 min)
  var tokenValidationResult = null;
  var cache = CacheService.getScriptCache();
  if (token) {
    var cacheKey = 'auth_' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)
        .map(function(b) { return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'); }).join('');
    var cachedEmail = cache.get(cacheKey);
    if (cachedEmail) {
      email = cachedEmail;
      tokenValidationResult = 'cached: ' + email;
    } else {
      try {
        var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token, {
          muteHttpExceptions: true
        });
        var statusCode = response.getResponseCode();
        var responseText = response.getContentText();
        if (statusCode === 200) {
          var tokenInfo = JSON.parse(responseText);
          email = tokenInfo.email;
          tokenValidationResult = 'success: ' + email;
          Logger.log('Token validated for: ' + email);
          cache.put(cacheKey, email, 300); // 5 min TTL
        } else {
          tokenValidationResult = 'failed with status ' + statusCode + ': ' + responseText.substring(0, 200);
          Logger.log('Token validation failed with status: ' + statusCode);
        }
      } catch (err) {
        tokenValidationResult = 'error: ' + err.message;
        Logger.log('Token validation error: ' + err.message);
      }
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
    // Log detail server-side only; do not expose auth internals to the caller
    Logger.log('checkAuthorization: could not determine email. hadToken=' + !!token +
      ', tokenLength=' + (token ? token.length : 0) +
      ', validation=' + (tokenValidationResult || 'not attempted'));
    return {
      authorized: false,
      message: 'Could not determine user email. Ensure you are signed in with a Google account.'
    };
  }

  // Staff emails list (cached for 5 min)
  var staffEmails = [];
  var cachedStaff = cache.get('staff_emails');
  if (cachedStaff) {
    staffEmails = cachedStaff.split(',');
  } else {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var configSheet = ss.getSheetByName(CONFIG_SHEET_NAME);

    if (!configSheet) {
      return { authorized: false, message: 'Config sheet not found' };
    }

    var configData = configSheet.getDataRange().getValues();

    for (var i = 0; i < configData.length; i++) {
      if (configData[i][0] === 'staff_emails') {
        staffEmails = (configData[i][1] || '').split(',').map(function(e) {
          return e.trim().toLowerCase();
        });
        break;
      }
    }
    cache.put('staff_emails', staffEmails.join(','), 300); // 5 min TTL
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

// ===== BATCH TRACKING =====

/**
 * Generate the next sequential ID for a sheet.
 * @param {string} sheetName
 * @param {string} prefix - e.g., 'SV-B-', 'BT-', 'FS-'
 * @param {number} padLength - zero-pad length (default 6)
 */
/**
 * Acquire a script-wide lock (prevents concurrent ID collisions).
 * Returns the lock object — caller MUST call lock.releaseLock() when done.
 */
function acquireScriptLock(timeoutMs) {
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  return lock;
}

function generateNextId(sheetName, prefix, padLength) {
  if (!padLength) padLength = 6;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) {
    var first = '';
    for (var p = 0; p < padLength; p++) first += '0';
    first = first.slice(0, padLength - 1) + '1';
    return prefix + first;
  }
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  var maxNum = 0;
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0] || '');
    if (id.indexOf(prefix) === 0) {
      var num = parseInt(id.substring(prefix.length), 10);
      if (num > maxNum) maxNum = num;
    }
  }
  var next = String(maxNum + 1);
  while (next.length < padLength) next = '0' + next;
  return prefix + next;
}

/**
 * Calculate due date from start date + day offset
 */
/**
 * Truncate a date value to YYYY-MM-DD (10 chars).
 * Handles ISO strings, Date objects, and Sheets empty-date artifacts.
 */
function toDateOnly(val) {
  if (!val) return '';
  var s = String(val).substring(0, 10);
  if (s === '1899-12-30' || s === '1899-12-31') return '';
  return s;
}

/**
 * Check if a vessel+shelf+bin combo is already used by another active batch.
 * Returns the conflicting batch_id or empty string if no conflict.
 */
function checkLocationConflict(vesselId, shelfId, binId, excludeBatchId) {
  if (!vesselId) return '';
  var batches = sheetToObjects(BATCHES_SHEET_NAME);
  for (var i = 0; i < batches.length; i++) {
    var b = batches[i];
    if (excludeBatchId && String(b.batch_id) === String(excludeBatchId)) continue;
    var s = String(b.status || '').toLowerCase();
    if (s !== 'primary' && s !== 'secondary') continue;
    if (String(b.vessel_id || '') === String(vesselId) &&
        String(b.shelf_id || '') === String(shelfId || '') &&
        String(b.bin_id || '') === String(binId || '')) {
      return String(b.batch_id);
    }
  }
  return '';
}

function calculateDueDate(startDateStr, dayOffset) {
  if (dayOffset < 0) return ''; // TBD for packaging
  var parts = startDateStr.split('-');
  var d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  d.setDate(d.getDate() + dayOffset);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Per-request cache for sheet data. Cleared between requests automatically
 * since Apps Script creates a fresh execution context per request.
 */
var _sheetCache = {};

/**
 * Read a sheet as array of objects [{col: val, ...}]
 * Results are cached per-request so each sheet is read at most once.
 * Pass skipCache=true to force a fresh read (e.g., after writes).
 */
function sheetToObjects(sheetName, skipCache) {
  if (!skipCache && _sheetCache[sheetName]) {
    // Return deep copies so callers can't corrupt the cache
    return _sheetCache[sheetName].map(function (obj) {
      var copy = {};
      for (var k in obj) copy[k] = obj[k];
      return copy;
    });
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return [];
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var result = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) val = val.toISOString();
      obj[headers[j]] = val;
    }
    obj._row = i + 1; // 1-based row for updates
    result.push(obj);
  }
  _sheetCache[sheetName] = result;
  // Return copies
  return result.map(function (obj) {
    var copy = {};
    for (var k in obj) copy[k] = obj[k];
    return copy;
  });
}

/**
 * Invalidate the per-request cache for a sheet (call after writes).
 */
function invalidateSheetCache(sheetName) {
  if (sheetName) {
    delete _sheetCache[sheetName];
  } else {
    _sheetCache = {};
  }
}

/**
 * Find a sheet row index (1-based) by matching column A to id.
 * Uses _sheetCache when available; populates cache on miss so subsequent
 * sheetToObjects calls for the same sheet avoid a redundant read.
 */
function findRowById(sheetName, id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() <= 1) return { sheet: sheet, row: -1, data: null, headers: null };

  // Check per-request _sheetCache first
  if (_sheetCache[sheetName]) {
    var cached = _sheetCache[sheetName];
    var headers = Object.keys(cached[0] || {}).filter(function(k) { return k !== '_row'; });
    for (var i = 0; i < cached.length; i++) {
      // Column A = first header key
      if (String(cached[i][headers[0]]) === String(id)) {
        var obj = {};
        for (var k in cached[i]) if (k !== '_row') obj[k] = cached[i][k];
        return { sheet: sheet, row: cached[i]._row, data: obj, headers: headers };
      }
    }
    return { sheet: sheet, row: -1, data: null, headers: headers };
  }

  // No cache — read sheet and populate _sheetCache
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var cacheArr = [];
  var found = null;
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      var val = data[i][j];
      if (val instanceof Date) val = val.toISOString();
      obj[headers[j]] = val;
    }
    obj._row = i + 1;
    cacheArr.push(obj);
    if (!found && String(data[i][0]) === String(id)) {
      var cleanObj = {};
      for (var k in obj) if (k !== '_row') cleanObj[k] = obj[k];
      found = { sheet: sheet, row: i + 1, data: cleanObj, headers: headers };
    }
  }
  _sheetCache[sheetName] = cacheArr;
  return found || { sheet: sheet, row: -1, data: null, headers: headers };
}

// --- GET: Batches ---

function getBatches(limit, offset, status) {
  var batches = sheetToObjects(BATCHES_SHEET_NAME);
  var total = batches.length;

  // Filter
  if (status && status !== 'all') {
    if (status === 'active') {
      batches = batches.filter(function (b) {
        var s = String(b.status || '').toLowerCase();
        return s === 'primary' || s === 'secondary';
      });
    } else {
      batches = batches.filter(function (b) {
        return String(b.status || '').toLowerCase() === status.toLowerCase();
      });
    }
  }

  var filtered = batches.length;

  // Enrich with task counts
  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);
  var taskCounts = {};
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!taskCounts[bid]) taskCounts[bid] = { total: 0, done: 0 };
    taskCounts[bid].total++;
    if (String(t.completed).toUpperCase() === 'TRUE') taskCounts[bid].done++;
  });

  batches.forEach(function (b) {
    var c = taskCounts[String(b.batch_id)] || { total: 0, done: 0 };
    b.tasks_total = c.total;
    b.tasks_done = c.done;
  });

  // Sort newest first
  batches.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  // Paginate
  if (limit > 0) {
    batches = batches.slice(offset, offset + limit);
  } else if (offset > 0) {
    batches = batches.slice(offset);
  }

  // Clean up: strip _row, access_token, and truncate date fields
  batches.forEach(function (b) {
    delete b._row;
    delete b.access_token;
    if (b.start_date) b.start_date = String(b.start_date).substring(0, 10);
  });

  return { batches: batches, total: total, filtered: filtered };
}

function getBatchDetail(batchId) {
  if (!batchId) return { error: 'batch_id required' };

  var result = findRowById(BATCHES_SHEET_NAME, batchId);
  if (result.row === -1) return { error: 'Batch not found: ' + batchId };

  var batch = result.data;
  delete batch._row;
  if (batch.start_date) batch.start_date = toDateOnly(batch.start_date);

  // Parse schedule_snapshot
  if (batch.schedule_snapshot && typeof batch.schedule_snapshot === 'string') {
    try { batch.schedule_snapshot_parsed = JSON.parse(batch.schedule_snapshot); } catch (e) {}
  }

  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(batchId);
  });
  tasks.forEach(function (t) {
    delete t._row;
    t.due_date = toDateOnly(t.due_date);
    if (t.completed_at) t.completed_at = String(t.completed_at).substring(0, 10);
  });
  tasks.sort(function (a, b) { return (Number(a.step_number) || 0) - (Number(b.step_number) || 0); });

  var readings = sheetToObjects(PLATO_READINGS_SHEET_NAME).filter(function (r) {
    return String(r.batch_id) === String(batchId);
  });
  readings.forEach(function (r) {
    delete r._row;
    if (r.timestamp) r.timestamp = String(r.timestamp).substring(0, 10);
  });
  readings.sort(function (a, b) { return String(a.timestamp || '').localeCompare(String(b.timestamp || '')); });

  var history = sheetToObjects(VESSEL_HISTORY_SHEET_NAME).filter(function (h) {
    return String(h.batch_id) === String(batchId);
  });
  history.forEach(function (h) {
    delete h._row;
    if (h.transferred_at) h.transferred_at = String(h.transferred_at).substring(0, 10);
  });
  history.sort(function (a, b) { return String(b.transferred_at || '').localeCompare(String(a.transferred_at || '')); });

  return { batch: batch, tasks: tasks, plato_readings: readings, vessel_history: history };
}

// --- GET: Public batch (token auth) ---

function handleGetBatchPublic(e) {
  var batchId = e.parameter.batch_id || '';
  var token = e.parameter.token || '';
  if (!batchId || !token) {
    return { ok: false, error: 'invalid_token', message: 'batch_id and token are required' };
  }
  // Format validation: batch_id must be SV-B-NNNNNN, token must be 32 hex chars
  if (!/^SV-B-\d{6}$/.test(batchId) || !/^[0-9a-f]{32}$/.test(token)) {
    return { ok: false, error: 'invalid_token', message: 'Invalid batch ID or token format' };
  }

  var result = findRowById(BATCHES_SHEET_NAME, batchId);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found' };
  }

  if (String(result.data.access_token) !== String(token)) {
    return { ok: false, error: 'invalid_token', message: 'Invalid access token' };
  }

  if (String(result.data.status || '').toLowerCase() === 'disabled') {
    return { ok: false, error: 'batch_disabled', message: 'This batch is no longer active' };
  }

  var batch = result.data;
  // Exclude sensitive fields
  delete batch.customer_email;
  delete batch.reservation_id;
  delete batch.access_token;
  delete batch._row;
  if (batch.start_date) batch.start_date = toDateOnly(batch.start_date);

  if (batch.schedule_snapshot && typeof batch.schedule_snapshot === 'string') {
    try { batch.schedule_snapshot_parsed = JSON.parse(batch.schedule_snapshot); } catch (e) {}
  }

  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(batchId);
  });
  tasks.forEach(function (t) {
    delete t._row;
    t.due_date = toDateOnly(t.due_date);
    if (t.completed_at) t.completed_at = String(t.completed_at).substring(0, 10);
  });
  tasks.sort(function (a, b) { return (Number(a.step_number) || 0) - (Number(b.step_number) || 0); });

  var readings = sheetToObjects(PLATO_READINGS_SHEET_NAME).filter(function (r) {
    return String(r.batch_id) === String(batchId);
  });
  readings.forEach(function (r) {
    delete r._row;
    if (r.timestamp) r.timestamp = String(r.timestamp).substring(0, 10);
  });
  readings.sort(function (a, b) { return String(a.timestamp || '').localeCompare(String(b.timestamp || '')); });

  var history = sheetToObjects(VESSEL_HISTORY_SHEET_NAME).filter(function (h) {
    return String(h.batch_id) === String(batchId);
  });
  history.forEach(function (h) {
    delete h._row;
    if (h.transferred_at) h.transferred_at = String(h.transferred_at).substring(0, 10);
  });
  history.sort(function (a, b) { return String(b.transferred_at || '').localeCompare(String(a.transferred_at || '')); });

  return { ok: true, data: { batch: batch, tasks: tasks, plato_readings: readings, vessel_history: history } };
}

// --- GET: Fermentation Schedule Templates ---

function getFermSchedules() {
  var schedules = sheetToObjects(FERM_SCHEDULES_SHEET_NAME).filter(function (s) {
    return String(s.is_active).toUpperCase() !== 'FALSE';
  });
  schedules.forEach(function (s) {
    delete s._row;
    if (s.steps && typeof s.steps === 'string') {
      try { s.steps_parsed = JSON.parse(s.steps); } catch (e) {}
    }
  });
  return { schedules: schedules };
}

// --- GET: Tasks Calendar ---

function getTasksCalendar(startDate, endDate) {
  if (!startDate || !endDate) return { tasks: [] };

  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);
  var batches = sheetToObjects(BATCHES_SHEET_NAME);

  // Build batch lookup (only active batches)
  var batchMap = {};
  batches.forEach(function (b) {
    var s = String(b.status || '').toLowerCase();
    if (s === 'primary' || s === 'secondary') {
      batchMap[String(b.batch_id)] = b;
    }
  });

  // Build set of batches ready for packaging (all non-pkg tasks done)
  var readyForPkg = {};
  var batchTaskGroups = {};
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!batchMap[bid]) return;
    if (!batchTaskGroups[bid]) batchTaskGroups[bid] = { allDone: true };
    if (String(t.is_packaging).toUpperCase() !== 'TRUE' &&
        String(t.completed).toUpperCase() !== 'TRUE') {
      batchTaskGroups[bid].allDone = false;
    }
  });
  for (var bid in batchTaskGroups) {
    if (batchTaskGroups[bid].allDone) readyForPkg[bid] = true;
  }

  var result = [];
  tasks.forEach(function (t) {
    var batch = batchMap[String(t.batch_id)];
    if (!batch) return; // skip tasks for inactive batches

    var dueDate = toDateOnly(t.due_date);
    // Include tasks within date range
    if (dueDate && (dueDate < startDate || dueDate > endDate)) return;
    // Only include packaging tasks if batch is ready for packaging
    if (!dueDate && String(t.is_packaging).toUpperCase() === 'TRUE') {
      if (!readyForPkg[String(t.batch_id)]) return;
    }
    if (!dueDate && String(t.is_packaging).toUpperCase() !== 'TRUE') return;

    result.push({
      task_id: t.task_id,
      batch_id: t.batch_id,
      product_name: batch.product_name || '',
      customer_name: batch.customer_name || '',
      vessel_id: batch.vessel_id || '',
      shelf_id: batch.shelf_id || '',
      title: t.title || '',
      due_date: dueDate,
      completed: String(t.completed).toUpperCase() === 'TRUE',
      is_packaging: String(t.is_packaging).toUpperCase() === 'TRUE',
      is_transfer: String(t.is_transfer).toUpperCase() === 'TRUE'
    });
  });

  return { tasks: result };
}

// --- GET: Tasks Upcoming ---

function getTasksUpcoming(limit) {
  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);
  var batches = sheetToObjects(BATCHES_SHEET_NAME);

  var batchMap = {};
  batches.forEach(function (b) {
    var s = String(b.status || '').toLowerCase();
    if (s === 'primary' || s === 'secondary') {
      batchMap[String(b.batch_id)] = b;
    }
  });

  var result = [];
  tasks.forEach(function (t) {
    var batch = batchMap[String(t.batch_id)];
    if (!batch) return;
    if (String(t.completed).toUpperCase() === 'TRUE') return; // skip done tasks

    result.push({
      task_id: t.task_id,
      batch_id: t.batch_id,
      product_name: batch.product_name || '',
      customer_name: batch.customer_name || '',
      vessel_id: batch.vessel_id || '',
      shelf_id: batch.shelf_id || '',
      bin_id: batch.bin_id || '',
      title: t.title || '',
      description: t.description || '',
      due_date: toDateOnly(t.due_date),
      is_packaging: String(t.is_packaging).toUpperCase() === 'TRUE',
      is_transfer: String(t.is_transfer).toUpperCase() === 'TRUE'
    });
  });

  // Sort: dated tasks by due_date ascending, then TBD packaging at end
  result.sort(function (a, b) {
    if (!a.due_date && !b.due_date) return 0;
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date.localeCompare(b.due_date);
  });

  return { tasks: result.slice(0, limit) };
}

// --- GET: Batch Dashboard Summary ---

function getBatchDashboardSummary() {
  var batches = sheetToObjects(BATCHES_SHEET_NAME);
  var tasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);

  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var weekEnd = Utilities.formatDate(
    new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
    Session.getScriptTimeZone(), 'yyyy-MM-dd'
  );

  var summary = {
    primaryCount: 0,
    secondaryCount: 0,
    completeCount: 0,
    disabledCount: 0,
    overdueTasks: 0,
    tasksDueToday: 0,
    tasksDueThisWeek: 0,
    readyForPackaging: 0
  };

  // Active batch IDs for task filtering
  var activeBatchIds = {};
  batches.forEach(function (b) {
    var s = String(b.status || '').toLowerCase();
    switch (s) {
      case 'primary': summary.primaryCount++; activeBatchIds[String(b.batch_id)] = true; break;
      case 'secondary': summary.secondaryCount++; activeBatchIds[String(b.batch_id)] = true; break;
      case 'complete': summary.completeCount++; break;
      case 'disabled': summary.disabledCount++; break;
    }
  });

  // Task analysis for active batches
  var batchTaskStatus = {}; // batch_id -> { allNonPackagingDone, hasPackaging }
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!activeBatchIds[bid]) return;

    var done = String(t.completed).toUpperCase() === 'TRUE';
    var isPkg = String(t.is_packaging).toUpperCase() === 'TRUE';
    var dueDate = String(t.due_date || '');

    if (!done) {
      if (dueDate && dueDate < today) summary.overdueTasks++;
      if (dueDate === today) summary.tasksDueToday++;
      if (dueDate && dueDate >= today && dueDate <= weekEnd) summary.tasksDueThisWeek++;
    }

    if (!batchTaskStatus[bid]) batchTaskStatus[bid] = { allNonPackagingDone: true, hasPackaging: false };
    if (isPkg) {
      batchTaskStatus[bid].hasPackaging = true;
    } else if (!done) {
      batchTaskStatus[bid].allNonPackagingDone = false;
    }
  });

  // Count batches ready for packaging
  Object.keys(batchTaskStatus).forEach(function (bid) {
    var s = batchTaskStatus[bid];
    if (s.hasPackaging && s.allNonPackagingDone) summary.readyForPackaging++;
  });

  return summary;
}

// --- GET: Vessels ---

function getVessels() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Vessels');
  if (!sheet || sheet.getLastRow() <= 1) return { vessels: [] };
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var vessels = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[String(headers[j]).trim()] = data[i][j];
    }
    vessels.push(obj);
  }
  return { vessels: vessels };
}

/**
 * Update the status column of a vessel in the Vessels sheet.
 * @param {string} vesselId - The vessel_id to update
 * @param {string} newStatus - The new status value (e.g., 'in-use', 'available')
 */
function setVesselStatus(vesselId, newStatus) {
  if (!vesselId) return;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Vessels');
  if (!sheet || sheet.getLastRow() <= 1) return;
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var idCol = -1, statusCol = -1;
  for (var j = 0; j < headers.length; j++) {
    var h = String(headers[j]).trim().toLowerCase();
    if (h === 'vessel_id') idCol = j;
    if (h === 'status') statusCol = j;
  }
  if (idCol === -1 || statusCol === -1) return;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === String(vesselId).trim()) {
      sheet.getRange(i + 1, statusCol + 1).setValue(newStatus);
      return;
    }
  }
}

// --- POST: Create Batch ---

function createBatch(payload, userEmail) {
  if (!payload.product_sku || !payload.customer_name || !payload.start_date || !payload.schedule_id) {
    return { ok: false, error: 'missing_fields', message: 'product_sku, customer_name, start_date, and schedule_id are required' };
  }

  // Validate schedule exists
  var schedResult = findRowById(FERM_SCHEDULES_SHEET_NAME, payload.schedule_id);
  if (schedResult.row === -1) {
    return { ok: false, error: 'not_found', message: 'Schedule not found: ' + payload.schedule_id };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var batchesSheet = ss.getSheetByName(BATCHES_SHEET_NAME);
  var tasksSheet = ss.getSheetByName(BATCH_TASKS_SHEET_NAME);
  var vesselSheet = ss.getSheetByName(VESSEL_HISTORY_SHEET_NAME);

  if (!batchesSheet || !tasksSheet || !vesselSheet) {
    return { ok: false, error: 'sheet_not_found', message: 'Required sheets not found. Create Batches, BatchTasks, and VesselHistory sheets.' };
  }

  // Check for location conflict
  if (payload.vessel_id) {
    var conflict = checkLocationConflict(payload.vessel_id, payload.shelf_id, payload.bin_id, '');
    if (conflict) {
      return { ok: false, error: 'location_conflict', message: 'Location already in use by batch ' + conflict };
    }
  }

  // Lock to prevent duplicate IDs from concurrent requests
  var lock = acquireScriptLock(15000);
  try {
    var batchId = generateNextId(BATCHES_SHEET_NAME, 'SV-B-', 6);
    var accessToken = Utilities.getUuid().replace(/-/g, '');
    var now = new Date().toISOString();
    var scheduleSnapshot = schedResult.data.steps || '[]';
    var steps;
    try { steps = JSON.parse(scheduleSnapshot); } catch (e) { steps = []; }

    // Append batch row
    batchesSheet.appendRow([
      batchId,
      'primary',
      sanitizeInput(payload.product_sku),
      sanitizeInput(payload.product_name || ''),
      sanitizeInput(payload.customer_id || ''),
      sanitizeInput(payload.customer_name),
      sanitizeInput(payload.customer_email || ''),
      payload.start_date,
      payload.schedule_id,
      scheduleSnapshot,
      sanitizeInput(payload.vessel_id || ''),
      sanitizeInput(payload.shelf_id || ''),
      sanitizeInput(payload.bin_id || ''),
      sanitizeInput(payload.notes || ''),
      accessToken,
      sanitizeInput(payload.reservation_id || ''),
      now,
      userEmail,
      now
    ]);

    // Create tasks from schedule (steps already parsed above)
    var tasksCreated = 0;
    var taskErrors = [];
    for (var i = 0; i < steps.length; i++) {
      try {
        var step = steps[i];
        var taskId = generateNextId(BATCH_TASKS_SHEET_NAME, 'BT-', 6);
        var dueDate = calculateDueDate(toDateOnly(payload.start_date), step.day_offset);

        tasksSheet.appendRow([
          taskId,
          batchId,
          step.step_number || (i + 1),
          sanitizeInput(step.title || ''),
          sanitizeInput(step.description || ''),
          step.day_offset,
          dueDate,
          step.is_packaging ? 'TRUE' : 'FALSE',
          step.is_transfer ? 'TRUE' : 'FALSE',
          'FALSE', // completed
          '',      // completed_at
          '',      // completed_by
          '',      // notes
          now      // last_updated
        ]);
        tasksCreated++;
      } catch (taskErr) {
        taskErrors.push('Step ' + (i + 1) + ': ' + taskErr.message);
      }
    }

    // Record initial vessel placement
    if (payload.vessel_id || payload.shelf_id || payload.bin_id) {
      try {
        var vhId = generateNextId(VESSEL_HISTORY_SHEET_NAME, 'VH-', 6);
        vesselSheet.appendRow([
          vhId,
          batchId,
          sanitizeInput(payload.vessel_id || ''),
          sanitizeInput(payload.shelf_id || ''),
          sanitizeInput(payload.bin_id || ''),
          now,
          userEmail,
          'Initial placement'
        ]);
      } catch (vhErr) {
        taskErrors.push('Vessel history: ' + vhErr.message);
      }
    }

    // Mark vessel as in-use
    if (payload.vessel_id) {
      try { setVesselStatus(payload.vessel_id, 'In-Use'); } catch (vsErr) {
        taskErrors.push('Vessel status: ' + vsErr.message);
      }
    }

    var resp = { ok: true, batch_id: batchId, access_token: accessToken, tasks_created: tasksCreated };
    if (taskErrors.length > 0) {
      resp.warnings = taskErrors;
    }
    return resp;
  } finally {
    lock.releaseLock();
  }
}

// --- POST: Update Batch ---

function updateBatch(payload, userEmail) {
  if (!payload.batch_id) {
    return { ok: false, error: 'missing_id', message: 'batch_id is required' };
  }

  var result = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found: ' + payload.batch_id };
  }

  var headers = result.headers;
  var sheet = result.sheet;
  var row = result.row;
  var current = result.data;
  var updates = payload.updates || {};
  var now = new Date().toISOString();

  // Optimistic locking
  if (payload.expectedVersion) {
    var serverVersion = current.last_updated;
    if (serverVersion) {
      var serverTime = new Date(serverVersion).getTime();
      var clientTime = new Date(payload.expectedVersion).getTime();
      if (serverTime > clientTime) {
        return { ok: false, error: 'version_conflict', message: 'Batch was modified by another user. Refresh and try again.' };
      }
    }
  }

  // Check for vessel/location changes — record history
  var locationChanged = false;
  var locationFields = ['vessel_id', 'shelf_id', 'bin_id'];
  locationFields.forEach(function (field) {
    if (updates[field] !== undefined && String(updates[field]) !== String(current[field] || '')) {
      locationChanged = true;
    }
  });

  if (locationChanged) {
    // Check for location conflict
    var newVessel = updates.vessel_id !== undefined ? updates.vessel_id : current.vessel_id || '';
    var newShelf = updates.shelf_id !== undefined ? updates.shelf_id : current.shelf_id || '';
    var newBin = updates.bin_id !== undefined ? updates.bin_id : current.bin_id || '';
    if (newVessel) {
      var conflict = checkLocationConflict(newVessel, newShelf, newBin, payload.batch_id);
      if (conflict) {
        return { ok: false, error: 'location_conflict', message: 'Location already in use by batch ' + conflict };
      }
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var vesselSheet = ss.getSheetByName(VESSEL_HISTORY_SHEET_NAME);
    if (vesselSheet) {
      var vhId = generateNextId(VESSEL_HISTORY_SHEET_NAME, 'VH-', 6);
      vesselSheet.appendRow([
        vhId,
        payload.batch_id,
        current.vessel_id || '',
        current.shelf_id || '',
        current.bin_id || '',
        now,
        userEmail,
        sanitizeInput(updates.transfer_notes || '')
      ]);
    }

    // Update vessel statuses if vessel changed
    var oldVessel = String(current.vessel_id || '');
    var newVessel = String(updates.vessel_id !== undefined ? updates.vessel_id : current.vessel_id || '');
    if (oldVessel !== newVessel) {
      if (oldVessel) setVesselStatus(oldVessel, 'Empty');
      if (newVessel) setVesselStatus(newVessel, 'In-Use');
    }
  }

  // Validate status value if provided
  if (updates.status !== undefined) {
    var validStatuses = ['primary', 'secondary', 'complete', 'disabled'];
    if (validStatuses.indexOf(String(updates.status).toLowerCase()) === -1) {
      return { ok: false, error: 'invalid_status', message: 'Invalid status: ' + updates.status + '. Must be one of: ' + validStatuses.join(', ') };
    }
    updates.status = String(updates.status).toLowerCase();
  }

  // Apply updates
  var allowedFields = ['status', 'vessel_id', 'shelf_id', 'bin_id', 'notes'];
  allowedFields.forEach(function (field) {
    if (updates[field] !== undefined) {
      var colIndex = headers.indexOf(field);
      if (colIndex !== -1) {
        sheet.getRange(row, colIndex + 1).setValue(sanitizeInput(String(updates[field])));
      }
    }
  });

  // Handle vessel status when batch status changes
  if (updates.status !== undefined) {
    var oldStatus = String(current.status || '').toLowerCase();
    var newStatus = String(updates.status).toLowerCase();
    var vesselId = String(current.vessel_id || '');
    if (vesselId) {
      var wasActive = (oldStatus === 'primary' || oldStatus === 'secondary');
      var isActive = (newStatus === 'primary' || newStatus === 'secondary');
      if (wasActive && !isActive) {
        setVesselStatus(vesselId, 'Empty');
      } else if (!wasActive && isActive) {
        setVesselStatus(vesselId, 'In-Use');
      }
    }
  }

  // Update last_updated
  var luCol = headers.indexOf('last_updated');
  if (luCol !== -1) sheet.getRange(row, luCol + 1).setValue(now);

  return { ok: true, message: 'Batch updated', newVersion: now };
}

// --- POST: Delete Batch (and all related data) ---

function deleteBatch(payload, userEmail) {
  if (!payload.batch_id) {
    return { ok: false, error: 'missing_id', message: 'batch_id is required' };
  }

  var batchResult = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (batchResult.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found: ' + payload.batch_id };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var batchId = payload.batch_id;

  // Release vessel if in-use
  var vesselId = String(batchResult.data.vessel_id || '');
  if (vesselId) {
    setVesselStatus(vesselId, 'Empty');
  }

  // Delete related rows from child sheets (bottom-up to avoid row shifting)
  var childSheets = [BATCH_TASKS_SHEET_NAME, PLATO_READINGS_SHEET_NAME, VESSEL_HISTORY_SHEET_NAME];
  childSheets.forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet || sheet.getLastRow() <= 1) return;
    var data = sheet.getDataRange().getValues();
    var headers = data[0];
    var bidCol = headers.indexOf('batch_id');
    if (bidCol === -1) return;
    // Collect rows to delete (from bottom up)
    var rowsToDelete = [];
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][bidCol]) === String(batchId)) {
        rowsToDelete.push(i + 1); // 1-based
      }
    }
    // Delete from bottom up so row numbers stay valid
    for (var j = rowsToDelete.length - 1; j >= 0; j--) {
      sheet.deleteRow(rowsToDelete[j]);
    }
  });

  // Delete the batch row itself
  batchResult.sheet.deleteRow(batchResult.row);

  return { ok: true, message: 'Batch ' + batchId + ' deleted' };
}

// --- POST: Update Batch Schedule (mid-fermentation edits) ---

function updateBatchSchedule(payload, userEmail) {
  if (!payload.batch_id || !payload.schedule_snapshot) {
    return { ok: false, error: 'missing_fields', message: 'batch_id and schedule_snapshot are required' };
  }

  var result = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found' };
  }

  var headers = result.headers;
  var sheet = result.sheet;
  var row = result.row;
  var current = result.data;
  var now = new Date().toISOString();

  // Optimistic locking
  if (payload.expectedVersion) {
    var serverTime = new Date(current.last_updated).getTime();
    var clientTime = new Date(payload.expectedVersion).getTime();
    if (serverTime > clientTime) {
      return { ok: false, error: 'version_conflict', message: 'Batch was modified. Refresh and try again.' };
    }
  }

  var newSteps;
  try {
    newSteps = typeof payload.schedule_snapshot === 'string' ? JSON.parse(payload.schedule_snapshot) : payload.schedule_snapshot;
  } catch (e) {
    return { ok: false, error: 'invalid_data', message: 'Invalid schedule_snapshot JSON' };
  }

  // Update schedule_snapshot on batch
  var snapCol = headers.indexOf('schedule_snapshot');
  if (snapCol !== -1) sheet.getRange(row, snapCol + 1).setValue(JSON.stringify(newSteps));
  var luCol = headers.indexOf('last_updated');
  if (luCol !== -1) sheet.getRange(row, luCol + 1).setValue(now);

  // Reconcile tasks
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tasksSheet = ss.getSheetByName(BATCH_TASKS_SHEET_NAME);
  var existingTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(payload.batch_id);
  });

  // Map existing tasks by step_number
  var existingByStep = {};
  existingTasks.forEach(function (t) { existingByStep[String(t.step_number)] = t; });

  var newStepNums = {};
  var tasksUpdated = 0;
  var tasksCreated = 0;
  var tasksRemoved = 0;
  var startDate = toDateOnly(current.start_date);

  // Read task headers once outside the loop
  var tHeaders = tasksSheet.getDataRange().getValues()[0];
  var titleCol = tHeaders.indexOf('title');
  var descCol = tHeaders.indexOf('description');
  var dayCol = tHeaders.indexOf('day_offset');
  var dateCol = tHeaders.indexOf('due_date');
  var luCol2 = tHeaders.indexOf('last_updated');

  newSteps.forEach(function (step) {
    var stepNum = String(step.step_number);
    newStepNums[stepNum] = true;
    var existing = existingByStep[stepNum];

    if (existing) {
      var dueDate = calculateDueDate(startDate, step.day_offset);

      if (titleCol !== -1) tasksSheet.getRange(existing._row, titleCol + 1).setValue(sanitizeInput(step.title || ''));
      if (descCol !== -1) tasksSheet.getRange(existing._row, descCol + 1).setValue(sanitizeInput(step.description || ''));
      if (dayCol !== -1) tasksSheet.getRange(existing._row, dayCol + 1).setValue(step.day_offset);
      if (dateCol !== -1) tasksSheet.getRange(existing._row, dateCol + 1).setValue(dueDate);
      if (luCol2 !== -1) tasksSheet.getRange(existing._row, luCol2 + 1).setValue(now);
      tasksUpdated++;
    } else {
      // Create new task
      var taskId = generateNextId(BATCH_TASKS_SHEET_NAME, 'BT-', 6);
      var dueDate2 = calculateDueDate(startDate, step.day_offset);
      tasksSheet.appendRow([
        taskId, payload.batch_id, step.step_number,
        sanitizeInput(step.title || ''), sanitizeInput(step.description || ''),
        step.day_offset, dueDate2,
        step.is_packaging ? 'TRUE' : 'FALSE',
        step.is_transfer ? 'TRUE' : 'FALSE',
        'FALSE', '', '', '', now
      ]);
      tasksCreated++;
    }
  });

  // Remove tasks no longer in snapshot (only if not completed)
  // Collect rows first, then delete from bottom up to avoid row-shifting
  var rowsToRemove = [];
  existingTasks.forEach(function (t) {
    if (!newStepNums[String(t.step_number)] && String(t.completed).toUpperCase() !== 'TRUE') {
      rowsToRemove.push(t._row);
      tasksRemoved++;
    }
  });
  rowsToRemove.sort(function (a, b) { return b - a; });
  for (var ri = 0; ri < rowsToRemove.length; ri++) {
    tasksSheet.deleteRow(rowsToRemove[ri]);
  }

  return { ok: true, tasks_updated: tasksUpdated, tasks_created: tasksCreated, tasks_removed: tasksRemoved };
}

// --- POST: Update Batch Task (check off / edit notes) ---

function updateBatchTask(payload, completedBy) {
  if (!payload.task_id) {
    return { ok: false, error: 'missing_id', message: 'task_id is required' };
  }

  var result = findRowById(BATCH_TASKS_SHEET_NAME, payload.task_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Task not found: ' + payload.task_id };
  }

  var headers = result.headers;
  var sheet = result.sheet;
  var row = result.row;
  var current = result.data;
  var updates = payload.updates || {};
  var now = new Date().toISOString();

  if (updates.completed !== undefined) {
    var completedCol = headers.indexOf('completed');
    var completedAtCol = headers.indexOf('completed_at');
    var completedByCol = headers.indexOf('completed_by');

    if (updates.completed) {
      if (completedCol !== -1) sheet.getRange(row, completedCol + 1).setValue('TRUE');
      if (completedAtCol !== -1) sheet.getRange(row, completedAtCol + 1).setValue(now);
      if (completedByCol !== -1) sheet.getRange(row, completedByCol + 1).setValue(completedBy || '');

      // If packaging task, set batch to complete
      if (String(current.is_packaging).toUpperCase() === 'TRUE') {
        // Invalidate sheet cache so handlePackagingCompletion sees the just-written completed=TRUE
        invalidateSheetCache(BATCH_TASKS_SHEET_NAME);
        handlePackagingCompletion(current.batch_id, now);
      }

      // Transfer task: update location and always release old vessel
      if (String(current.is_transfer).toUpperCase() === 'TRUE') {
        var batchCheck = findRowById(BATCHES_SHEET_NAME, current.batch_id);
        if (batchCheck.row !== -1) {
          var oldVesselId = String(batchCheck.data.vessel_id || '');

          if (payload.transfer_location) {
            // New location provided — updateBatch handles vessel status (old→Empty, new→In-Use)
            var loc = payload.transfer_location;
            updateBatch({
              batch_id: current.batch_id,
              updates: {
                vessel_id: loc.vessel_id || '',
                shelf_id: loc.shelf_id || '',
                bin_id: loc.bin_id || ''
              }
            }, completedBy || '');
          } else if (oldVesselId) {
            // No new location (skip or public page) — still free the old vessel
            setVesselStatus(oldVesselId, 'Empty');
          }

          // Auto-advance primary → secondary
          if (String(batchCheck.data.status).toLowerCase() === 'primary') {
            var sCol = batchCheck.headers.indexOf('status');
            var luCol2 = batchCheck.headers.indexOf('last_updated');
            if (sCol !== -1) batchCheck.sheet.getRange(batchCheck.row, sCol + 1).setValue('secondary');
            if (luCol2 !== -1) batchCheck.sheet.getRange(batchCheck.row, luCol2 + 1).setValue(now);
          }
        }
      }
    } else {
      // Un-checking
      if (completedCol !== -1) sheet.getRange(row, completedCol + 1).setValue('FALSE');
      if (completedAtCol !== -1) sheet.getRange(row, completedAtCol + 1).setValue('');
      if (completedByCol !== -1) sheet.getRange(row, completedByCol + 1).setValue('');

      // If packaging task was un-checked, revert batch from complete
      if (String(current.is_packaging).toUpperCase() === 'TRUE') {
        handlePackagingUncompletion(current.batch_id, now);
      }
    }
  }

  if (updates.notes !== undefined) {
    var notesCol = headers.indexOf('notes');
    if (notesCol !== -1) sheet.getRange(row, notesCol + 1).setValue(sanitizeInput(updates.notes));
  }

  var luCol = headers.indexOf('last_updated');
  if (luCol !== -1) sheet.getRange(row, luCol + 1).setValue(now);

  return { ok: true, message: 'Task updated' };
}

// --- POST: Bulk Update Batch Tasks ---

function bulkUpdateBatchTasks(payload, email) {
  if (!payload.tasks || !Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    return { ok: false, error: 'invalid_input', message: 'tasks array is required' };
  }
  if (payload.tasks.length > 50) {
    return { ok: false, error: 'too_many', message: 'Maximum 50 tasks per request' };
  }
  var results = [];
  for (var i = 0; i < payload.tasks.length; i++) {
    results.push(updateBatchTask(payload.tasks[i], email));
  }
  return { ok: true, results: results };
}

// --- POST: Add Ad-Hoc Batch Task ---

function addBatchTask(payload, userEmail) {
  if (!payload.batch_id || !payload.title) {
    return { ok: false, error: 'missing_fields', message: 'batch_id and title are required' };
  }

  // Verify batch exists
  var batchResult = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (batchResult.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found: ' + payload.batch_id };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tasksSheet = ss.getSheetByName(BATCH_TASKS_SHEET_NAME);
  if (!tasksSheet) return { ok: false, error: 'sheet_not_found' };

  // Find highest step_number for this batch to auto-number
  var existingTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(payload.batch_id);
  });
  var maxStep = 0;
  existingTasks.forEach(function (t) {
    var sn = Number(t.step_number) || 0;
    if (sn > maxStep) maxStep = sn;
  });

  var lock = acquireScriptLock(10000);
  try {
    var taskId = generateNextId(BATCH_TASKS_SHEET_NAME, 'BT-', 6);
    var now = new Date().toISOString();
    var startDate = toDateOnly(batchResult.data.start_date);
    var dayOffset = payload.day_offset !== undefined ? Number(payload.day_offset) : -1;
    var dueDate = payload.due_date || '';
    if (!dueDate && dayOffset >= 0 && startDate) {
      dueDate = calculateDueDate(startDate, dayOffset);
    }

    tasksSheet.appendRow([
      taskId,
      payload.batch_id,
      maxStep + 1,
      sanitizeInput(payload.title),
      sanitizeInput(payload.description || ''),
      dayOffset,
      dueDate,
      'FALSE', // is_packaging
      payload.is_transfer ? 'TRUE' : 'FALSE',
      'FALSE', // completed
      '',      // completed_at
      '',      // completed_by
      sanitizeInput(payload.notes || ''),
      now      // last_updated
    ]);

    return { ok: true, task_id: taskId, message: 'Task added' };
  } finally {
    lock.releaseLock();
  }
}

function handlePackagingCompletion(batchId, timestamp) {
  // Verify all non-packaging tasks are completed before allowing batch completion
  var allTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(batchId);
  });
  var hasIncomplete = false;
  for (var i = 0; i < allTasks.length; i++) {
    if (String(allTasks[i].is_packaging).toUpperCase() !== 'TRUE' &&
        String(allTasks[i].completed).toUpperCase() !== 'TRUE') {
      hasIncomplete = true;
      break;
    }
  }
  if (hasIncomplete) return; // Don't complete batch if tasks remain

  var result = findRowById(BATCHES_SHEET_NAME, batchId);
  if (result.row === -1) return;
  if (String(result.data.status).toLowerCase() === 'complete') return; // Already complete

  var statusCol = result.headers.indexOf('status');
  var luCol = result.headers.indexOf('last_updated');
  if (statusCol !== -1) result.sheet.getRange(result.row, statusCol + 1).setValue('complete');
  if (luCol !== -1) result.sheet.getRange(result.row, luCol + 1).setValue(timestamp);

  // Release the vessel back to available
  var vesselId = String(result.data.vessel_id || '');
  if (vesselId) {
    setVesselStatus(vesselId, 'Empty');
  }
}

function handlePackagingUncompletion(batchId, timestamp) {
  var result = findRowById(BATCHES_SHEET_NAME, batchId);
  if (result.row === -1) return;

  // Determine correct status: check if any transfer task was completed (implies secondary)
  var allTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME).filter(function (t) {
    return String(t.batch_id) === String(batchId);
  });
  var hasCompletedTransfer = false;
  for (var i = 0; i < allTasks.length; i++) {
    if (String(allTasks[i].is_transfer).toUpperCase() === 'TRUE' &&
        String(allTasks[i].completed).toUpperCase() === 'TRUE') {
      hasCompletedTransfer = true;
      break;
    }
  }
  var revertStatus = hasCompletedTransfer ? 'secondary' : 'primary';

  var statusCol = result.headers.indexOf('status');
  var luCol = result.headers.indexOf('last_updated');
  if (statusCol !== -1) result.sheet.getRange(result.row, statusCol + 1).setValue(revertStatus);
  if (luCol !== -1) result.sheet.getRange(result.row, luCol + 1).setValue(timestamp);

  // Re-claim the vessel as in-use
  var vesselId = String(result.data.vessel_id || '');
  if (vesselId) {
    setVesselStatus(vesselId, 'In-Use');
  }
}

// --- POST: Add Plato Reading ---

function addPlatoReading(payload, recordedBy) {
  if (!payload.batch_id) {
    return { ok: false, error: 'missing_id', message: 'batch_id is required' };
  }
  var plato = parseFloat(payload.degrees_plato);
  if (isNaN(plato) || plato < 0 || plato > 40) {
    return { ok: false, error: 'invalid_value', message: 'degrees_plato must be between 0 and 40' };
  }
  if (payload.timestamp && !/^\d{4}-\d{2}-\d{2}$/.test(payload.timestamp)) {
    return { ok: false, error: 'invalid_value', message: 'timestamp must be YYYY-MM-DD format' };
  }
  var temperature = (payload.temperature !== undefined && payload.temperature !== '') ? parseFloat(payload.temperature) : '';
  if (temperature !== '' && isNaN(temperature)) {
    return { ok: false, error: 'invalid_value', message: 'temperature must be a number' };
  }
  var ph = (payload.ph !== undefined && payload.ph !== '') ? parseFloat(payload.ph) : '';
  if (ph !== '' && (isNaN(ph) || ph < 0 || ph > 14)) {
    return { ok: false, error: 'invalid_value', message: 'ph must be a number between 0 and 14' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PLATO_READINGS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  var lock = acquireScriptLock(10000);
  try {
    var readingId = generateNextId(PLATO_READINGS_SHEET_NAME, 'PR-', 6);
    var now = new Date().toISOString();
    var timestamp = payload.timestamp || now;

    sheet.appendRow([
      readingId,
      payload.batch_id,
      timestamp,
      plato,
      sanitizeInput(payload.notes || ''),
      recordedBy || '',
      now,
      temperature,
      ph
    ]);

    return { ok: true, reading_id: readingId };
  } finally {
    lock.releaseLock();
  }
}

// --- POST: Bulk Add Plato Readings ---

function bulkAddPlatoReadings(payload, recordedBy) {
  if (!payload.batch_id) {
    return { ok: false, error: 'missing_id', message: 'batch_id is required' };
  }
  if (!payload.readings || !Array.isArray(payload.readings) || payload.readings.length === 0) {
    return { ok: false, error: 'invalid_input', message: 'readings array is required' };
  }
  if (payload.readings.length > 20) {
    return { ok: false, error: 'too_many', message: 'Maximum 20 readings per request' };
  }
  var results = [];
  for (var i = 0; i < payload.readings.length; i++) {
    var reading = payload.readings[i];
    reading.batch_id = payload.batch_id;
    results.push(addPlatoReading(reading, recordedBy));
  }
  return { ok: true, results: results };
}

// --- POST: Update Plato Reading ---

function updatePlatoReading(payload, userEmail) {
  if (!payload.reading_id) {
    return { ok: false, error: 'missing_id', message: 'reading_id is required' };
  }
  var updates = payload.updates || {};
  var result = findRowById(PLATO_READINGS_SHEET_NAME, payload.reading_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Reading not found: ' + payload.reading_id };
  }

  // Validate provided fields
  if (updates.degrees_plato !== undefined) {
    var plato = parseFloat(updates.degrees_plato);
    if (isNaN(plato) || plato < 0 || plato > 40) {
      return { ok: false, error: 'invalid_value', message: 'degrees_plato must be between 0 and 40' };
    }
  }
  if (updates.timestamp !== undefined && updates.timestamp !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(updates.timestamp)) {
    return { ok: false, error: 'invalid_value', message: 'timestamp must be YYYY-MM-DD format' };
  }
  if (updates.temperature !== undefined && updates.temperature !== '') {
    if (isNaN(parseFloat(updates.temperature))) {
      return { ok: false, error: 'invalid_value', message: 'temperature must be a number' };
    }
  }
  if (updates.ph !== undefined && updates.ph !== '') {
    var phVal = parseFloat(updates.ph);
    if (isNaN(phVal) || phVal < 0 || phVal > 14) {
      return { ok: false, error: 'invalid_value', message: 'ph must be a number between 0 and 14' };
    }
  }

  // Map field names to column headers
  var fieldMap = {
    degrees_plato: 'degrees_plato',
    timestamp: 'timestamp',
    temperature: 'temperature',
    ph: 'ph',
    notes: 'notes'
  };

  var headers = result.headers;
  for (var field in updates) {
    if (!fieldMap[field]) continue;
    var colName = fieldMap[field];
    var colIdx = headers.indexOf(colName);
    if (colIdx === -1) continue;
    var val = updates[field];
    if (field === 'notes') val = sanitizeInput(val || '');
    if (field === 'degrees_plato') val = parseFloat(val);
    if (field === 'temperature') val = (val !== '' && val !== undefined) ? parseFloat(val) : '';
    if (field === 'ph') val = (val !== '' && val !== undefined) ? parseFloat(val) : '';
    result.sheet.getRange(result.row, colIdx + 1).setValue(val);
  }

  invalidateSheetCache(PLATO_READINGS_SHEET_NAME);
  return { ok: true, reading_id: payload.reading_id };
}

// --- POST: Delete Plato Reading ---

function deletePlatoReading(payload) {
  if (!payload.reading_id) {
    return { ok: false, error: 'missing_id', message: 'reading_id is required' };
  }
  var result = findRowById(PLATO_READINGS_SHEET_NAME, payload.reading_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Reading not found: ' + payload.reading_id };
  }
  result.sheet.deleteRow(result.row);
  invalidateSheetCache(PLATO_READINGS_SHEET_NAME);
  return { ok: true, reading_id: payload.reading_id };
}

// --- POST: Batch Token Auth (public URL) ---

function handleBatchTokenPost(payload, action) {
  // Format validation: batch_id must be SV-B-NNNNNN, token must be 32 hex chars
  if (!/^SV-B-\d{6}$/.test(payload.batch_id || '') || !/^[0-9a-f]{32}$/.test(payload.batch_token || '')) {
    return { ok: false, error: 'invalid_token', message: 'Invalid batch ID or token format' };
  }
  var batch = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (batch.row === -1 || String(batch.data.access_token) !== String(payload.batch_token)) {
    return { ok: false, error: 'invalid_token', message: 'Invalid batch token' };
  }

  switch (action) {
    case 'update_batch_task':
      // Block packaging task completion from public URL (staff only)
      if (payload.task_id && payload.updates && payload.updates.completed) {
        var taskCheck = findRowById(BATCH_TASKS_SHEET_NAME, payload.task_id);
        if (taskCheck.row !== -1 && String(taskCheck.data.is_packaging).toUpperCase() === 'TRUE') {
          return { ok: false, error: 'unauthorized', message: 'Packaging tasks can only be completed by staff' };
        }
      }
      return updateBatchTask(payload, 'batch-url');
    case 'add_plato_reading':
      return addPlatoReading(payload, 'batch-url');
    case 'bulk_add_plato_readings':
      return bulkAddPlatoReadings(payload, 'batch-url');
    case 'delete_plato_reading': {
      // Verify the reading belongs to this batch before deleting
      var readingCheck = findRowById(PLATO_READINGS_SHEET_NAME, payload.reading_id);
      if (readingCheck.row !== -1 && String(readingCheck.data.batch_id) !== String(payload.batch_id)) {
        return { ok: false, error: 'unauthorized', message: 'Reading does not belong to this batch' };
      }
      return deletePlatoReading(payload);
    }
    default:
      return { ok: false, error: 'unauthorized_action', message: 'Action not allowed from batch URL' };
  }
}

// --- POST: Create Fermentation Schedule Template ---

function createFermSchedule(payload, userEmail) {
  if (!payload.name || !payload.steps) {
    return { ok: false, error: 'missing_fields', message: 'name and steps are required' };
  }

  var steps;
  try {
    steps = typeof payload.steps === 'string' ? JSON.parse(payload.steps) : payload.steps;
  } catch (e) {
    return { ok: false, error: 'invalid_data', message: 'Invalid steps JSON' };
  }

  if (!Array.isArray(steps) || steps.length < 2) {
    return { ok: false, error: 'invalid_data', message: 'At least 2 steps required' };
  }

  var hasPackaging = steps.some(function (s) { return s.is_packaging === true; });
  if (!hasPackaging) {
    return { ok: false, error: 'invalid_data', message: 'Exactly one step must be a packaging step' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(FERM_SCHEDULES_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  var scheduleId = generateNextId(FERM_SCHEDULES_SHEET_NAME, 'FS-', 4);
  var now = new Date().toISOString();

  sheet.appendRow([
    scheduleId,
    sanitizeInput(payload.name),
    sanitizeInput(payload.description || ''),
    sanitizeInput(payload.category || ''),
    JSON.stringify(steps),
    'TRUE',
    now,
    userEmail,
    now
  ]);

  return { ok: true, schedule_id: scheduleId };
}

// --- POST: Update Fermentation Schedule Template ---

function updateFermSchedule(payload, userEmail) {
  if (!payload.schedule_id) {
    return { ok: false, error: 'missing_id', message: 'schedule_id is required' };
  }

  var result = findRowById(FERM_SCHEDULES_SHEET_NAME, payload.schedule_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Schedule not found' };
  }

  var headers = result.headers;
  var sheet = result.sheet;
  var row = result.row;
  var now = new Date().toISOString();

  if (payload.name !== undefined) {
    var nameCol = headers.indexOf('name');
    if (nameCol !== -1) sheet.getRange(row, nameCol + 1).setValue(sanitizeInput(payload.name));
  }
  if (payload.description !== undefined) {
    var descCol = headers.indexOf('description');
    if (descCol !== -1) sheet.getRange(row, descCol + 1).setValue(sanitizeInput(payload.description));
  }
  if (payload.category !== undefined) {
    var catCol = headers.indexOf('category');
    if (catCol !== -1) sheet.getRange(row, catCol + 1).setValue(sanitizeInput(payload.category));
  }
  if (payload.steps !== undefined) {
    var steps;
    try {
      steps = typeof payload.steps === 'string' ? JSON.parse(payload.steps) : payload.steps;
    } catch (e) {
      return { ok: false, error: 'invalid_data', message: 'Invalid steps JSON' };
    }
    var stepsCol = headers.indexOf('steps');
    if (stepsCol !== -1) sheet.getRange(row, stepsCol + 1).setValue(JSON.stringify(steps));
  }

  var luCol = headers.indexOf('last_updated');
  if (luCol !== -1) sheet.getRange(row, luCol + 1).setValue(now);

  return { ok: true, message: 'Schedule updated' };
}

// --- POST: Propagate Ferm Schedule Template to Active Batches ---

function propagateFermSchedule(payload, userEmail) {
  if (!payload.schedule_id || !payload.steps) {
    return { ok: false, error: 'missing_fields', message: 'schedule_id and steps are required' };
  }

  var steps;
  try {
    steps = typeof payload.steps === 'string' ? JSON.parse(payload.steps) : payload.steps;
  } catch (e) {
    return { ok: false, error: 'invalid_data', message: 'Invalid steps JSON' };
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tasksSheet = ss.getSheetByName(BATCH_TASKS_SHEET_NAME);
  if (!tasksSheet) {
    return { ok: false, error: 'sheet_not_found', message: 'BatchTasks sheet not found' };
  }

  // Lock to prevent concurrent propagation from duplicating task IDs
  var lock = acquireScriptLock(15000);
  try {

  // Find all active batches using this schedule
  var allBatches = sheetToObjects(BATCHES_SHEET_NAME);
  var activeBatches = allBatches.filter(function (b) {
    if (String(b.schedule_id) !== String(payload.schedule_id)) return false;
    var s = String(b.status || '').toLowerCase();
    return s === 'primary' || s === 'secondary';
  });

  if (activeBatches.length === 0) {
    return { ok: true, batches_updated: 0, tasks_updated: 0, tasks_created: 0, tasks_removed: 0, message: 'No active batches use this template' };
  }

  var now = new Date().toISOString();
  var tHeaders = tasksSheet.getDataRange().getValues()[0];
  var titleCol = tHeaders.indexOf('title');
  var descCol  = tHeaders.indexOf('description');
  var dayCol   = tHeaders.indexOf('day_offset');
  var dateCol  = tHeaders.indexOf('due_date');
  var luCol    = tHeaders.indexOf('last_updated');

  var totalUpdated = 0, totalCreated = 0, totalRemoved = 0;
  var allTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);

  activeBatches.forEach(function (batch) {
    var startDate = toDateOnly(batch.start_date);
    var batchId   = String(batch.batch_id);

    // Get this batch's tasks
    var batchTasks = allTasks.filter(function (t) { return String(t.batch_id) === batchId; });

    // Index pending tasks by step_number (skip completed)
    var pendingByStep = {};
    batchTasks.forEach(function (t) {
      if (String(t.completed).toUpperCase() !== 'TRUE') {
        pendingByStep[String(t.step_number)] = t;
      }
    });

    // Track which step numbers the new template has
    var newStepNums = {};

    steps.forEach(function (step) {
      var stepNum = String(step.step_number);
      newStepNums[stepNum] = true;
      var existing = pendingByStep[stepNum];

      if (existing) {
        // Update pending task in place
        var dueDate = calculateDueDate(startDate, step.day_offset);
        if (titleCol !== -1) tasksSheet.getRange(existing._row, titleCol + 1).setValue(sanitizeInput(step.title || ''));
        if (descCol  !== -1) tasksSheet.getRange(existing._row, descCol  + 1).setValue(sanitizeInput(step.description || ''));
        if (dayCol   !== -1) tasksSheet.getRange(existing._row, dayCol   + 1).setValue(step.day_offset);
        if (dateCol  !== -1) tasksSheet.getRange(existing._row, dateCol  + 1).setValue(dueDate);
        if (luCol    !== -1) tasksSheet.getRange(existing._row, luCol    + 1).setValue(now);
        totalUpdated++;
      } else {
        // Add missing step as a new task
        var taskId   = generateNextId(BATCH_TASKS_SHEET_NAME, 'BT-', 6);
        var dueDate2 = calculateDueDate(startDate, step.day_offset);
        tasksSheet.appendRow([
          taskId, batchId, step.step_number,
          sanitizeInput(step.title || ''), sanitizeInput(step.description || ''),
          step.day_offset, dueDate2,
          step.is_packaging ? 'TRUE' : 'FALSE',
          step.is_transfer  ? 'TRUE' : 'FALSE',
          'FALSE', '', '', '', now
        ]);
        // Refresh allTasks cache entry so generateNextId doesn't duplicate
        allTasks.push({ task_id: taskId, batch_id: batchId, step_number: step.step_number, completed: 'FALSE' });
        totalCreated++;
      }
    });

    // Remove pending tasks whose step no longer exists in the template
    var rowsToRemove = [];
    batchTasks.forEach(function (t) {
      if (String(t.completed).toUpperCase() !== 'TRUE' && !newStepNums[String(t.step_number)]) {
        rowsToRemove.push(t._row);
        totalRemoved++;
      }
    });
    rowsToRemove.sort(function (a, b) { return b - a; });
    rowsToRemove.forEach(function (r) { tasksSheet.deleteRow(r); });

    // After deletes, row numbers shift — refresh allTasks for next iteration
    if (rowsToRemove.length > 0) {
      allTasks = sheetToObjects(BATCH_TASKS_SHEET_NAME);
    }
  });

  return {
    ok: true,
    batches_updated: activeBatches.length,
    tasks_updated: totalUpdated,
    tasks_created: totalCreated,
    tasks_removed: totalRemoved
  };
  } finally {
    lock.releaseLock();
  }
}

// --- POST: Delete (soft) Fermentation Schedule ---

function deleteFermSchedule(payload) {
  if (!payload.schedule_id) {
    return { ok: false, error: 'missing_id', message: 'schedule_id is required' };
  }

  var result = findRowById(FERM_SCHEDULES_SHEET_NAME, payload.schedule_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Schedule not found' };
  }

  var activeCol = result.headers.indexOf('is_active');
  if (activeCol !== -1) result.sheet.getRange(result.row, activeCol + 1).setValue('FALSE');

  var luCol = result.headers.indexOf('last_updated');
  if (luCol !== -1) result.sheet.getRange(result.row, luCol + 1).setValue(new Date().toISOString());

  return { ok: true, message: 'Schedule deactivated' };
}

// --- POST: Regenerate Batch Token ---

function regenerateBatchToken(payload) {
  if (!payload.batch_id) {
    return { ok: false, error: 'missing_id', message: 'batch_id is required' };
  }

  var result = findRowById(BATCHES_SHEET_NAME, payload.batch_id);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Batch not found' };
  }

  var newToken = Utilities.getUuid().replace(/-/g, '');
  var now = new Date().toISOString();
  var tokenCol = result.headers.indexOf('access_token');
  if (tokenCol !== -1) result.sheet.getRange(result.row, tokenCol + 1).setValue(newToken);

  var regenCol = result.headers.indexOf('last_regenerated_at');
  if (regenCol !== -1) result.sheet.getRange(result.row, regenCol + 1).setValue(now);

  var luCol = result.headers.indexOf('last_updated');
  if (luCol !== -1) result.sheet.getRange(result.row, luCol + 1).setValue(now);

  // Evict stale public batch cache so the old token stops working immediately
  try { CacheService.getScriptCache().remove('gbp:' + payload.batch_id); } catch (e) {}

  return { ok: true, access_token: newToken };
}

// ===== UTILITY =====

function _jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Cache-aware GET helper. Returns cached JSON if available, otherwise calls fetchFn and caches the result.
 * CacheService has a 100KB value limit — try/catch handles oversized values gracefully.
 * @param {string} cacheKey - Cache key
 * @param {number} ttl - Time-to-live in seconds
 * @param {Function} fetchFn - Function that returns the data object
 */
function _cachedGet(cacheKey, ttl, fetchFn) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  var result = fetchFn();
  try { cache.put(cacheKey, JSON.stringify(result), ttl); } catch (e) { /* value too large, skip */ }
  return result;
}

/**
 * Invalidate all batch-related caches after a write operation.
 * @param {string} batchId - The batch ID that was modified
 */
function _invalidateBatchCache(batchId) {
  var cache = CacheService.getScriptCache();
  var keys = ['gbl', 'gtu', 'gbds', 'gbi', 'gfs'];
  if (batchId) {
    keys.push('gb:' + batchId);
    keys.push('gbp:' + batchId);
  }
  cache.removeAll(keys);
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

/**
 * No-op function to keep the Apps Script runtime warm and avoid cold starts (1–3s).
 * Create a time-based trigger: Edit > Triggers > Add > keepWarm, time-driven, every 5 minutes.
 */
function keepWarm() { return true; }

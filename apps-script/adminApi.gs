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
var RECIPES_SHEET_NAME = 'Recipes';
var RECIPE_INGREDIENTS_SHEET_NAME = 'RecipeIngredients';
var GIFT_CARDS_SHEET_NAME = 'GiftCards';
var GIFT_CARD_TRANSACTIONS_SHEET_NAME = 'GiftCardTransactions';
var WAITLIST_SHEET_NAME = 'Waitlist';

// Cal.com public booking page for the Bottling Appointment event type (Phase 25).
// Customers self-book here; the brewpad "Send Bottling Invite" button emails this link.
var CALCOM_BOTTLING_BOOKING_URL = 'https://cal.com/steins-and-vines-tw8csc/bottling-appointment';

/**
 * Handle GET requests
 * Used for: auth check, reading data
 */
function doGet(e) {
  var action = (e.parameter.action || '').toLowerCase();

  // Public endpoint: featured products for homepage (no staff auth required)
  if (action === 'get_featured') {
    try {
      return _jsonResponse(_cachedGet('gfeatured', 300, function() {
        return getFeatured();
      }));
    } catch (err) {
      return _jsonResponse({ ok: false, error: 'server_error', message: err.message });
    }
  }

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

  // Server-token bypass for middleware GET requests (recipes, etc.)
  //
  // 2026-07-12: doPost validates against the script property SERVER_WRITE_TOKEN while
  // this read path validated against SERVER_TOKEN — two different properties for the
  // one secret the middleware actually holds (APPS_SCRIPT_SERVER_TOKEN). Writes
  // therefore authenticated and reads did not: every middleware GET fell through to
  // checkAuthorization and failed with "Could not determine user email". The only
  // caller is pos.js /api/batch/scan-invoices, whose duplicate-batch lookup silently
  // saw an empty set and swallowed the error. Accept either property so the
  // middleware's single token works on both verbs; SERVER_WRITE_TOKEN is the same
  // secret it already writes with, so this grants no new privilege.
  var serverTokenParam = e.parameter.server_token || '';
  var scriptPropsForGet = PropertiesService.getScriptProperties();
  var storedTokenForGet = scriptPropsForGet.getProperty('SERVER_TOKEN') ||
                          scriptPropsForGet.getProperty('SERVER_WRITE_TOKEN') || '';
  var isServerAuth = (serverTokenParam && storedTokenForGet && serverTokenParam === storedTokenForGet);
  var authResult = { authorized: false, email: null, message: '' };

  if (isServerAuth) {
    authResult = { authorized: true, email: 'middleware', message: '' };
  } else {
    authResult = checkAuthorization(e);
    if (!authResult.authorized) {
      return _jsonResponse({ ok: false, error: 'unauthorized', message: authResult.message });
    }
  }

  try {
    return _jsonResponse(handleReadAction(action, function (n) { return e.parameter[n]; }, authResult.email));
  } catch (err) {
    return _jsonResponse({ ok: false, error: 'server_error', message: err.message });
  }
}

/**
 * Shared read-action dispatch, reachable from both doGet (GET query-string
 * params) and doPost's OAuth-authenticated fall-through (POST JSON-body
 * params) -- Phase 64-03 / OPS-03 SC#3. Returns a plain result object (NOT
 * wrapped in _jsonResponse); callers wrap the return value themselves so the
 * response envelope stays identical across both transports.
 *
 * @param {string} action - lowercased action name
 * @param {function(string): *} getParam - abstracts the parameter source
 *   (e.parameter[name] for doGet, payload[name] for doPost)
 * @param {string} authEmail - the authorized staff email (for check_auth)
 */
function handleReadAction(action, getParam, authEmail) {
  // Pagination parameters
  var limit = parseInt(getParam('limit'), 10) || 0; // 0 = no limit
  var offset = parseInt(getParam('offset'), 10) || 0;
  var status = getParam('status') || ''; // Filter by status

  switch (action) {
    case 'check_auth':
      return { ok: true, email: authEmail, authorized: true };

    case 'get_reservations':
      return { ok: true, data: getReservations(limit, offset, status) };

    case 'get_holds':
      return { ok: true, data: getHolds() };

    case 'get_schedule':
      return { ok: true, data: getSchedule() };

    case 'get_homepage':
      return { ok: true, data: getHomepage() };

    case 'get_kits':
      return { ok: true, data: getKits() };

    case 'get_config':
      return { ok: true, data: getConfig() };

    case 'get_dashboard_summary':
      return { ok: true, data: _cachedGet('gds', 60, function() { return getDashboardSummary(); }) };

    // Batch tracking endpoints
    case 'get_batches':
      return { ok: true, data: _cachedGet('gbl', 300, function() {
        return getBatches(limit, offset, status);
      })};

    case 'get_batch':
      return { ok: true, data: _cachedGet('gb:' + (getParam('batch_id') || ''), 300, function() {
        return getBatchDetail(getParam('batch_id'));
      })};

    case 'get_ferm_schedules':
      return { ok: true, data: _cachedGet('gfs', 300, function() {
        return getFermSchedules();
      })};

    case 'get_tasks_calendar':
      return { ok: true, data: getTasksCalendar(getParam('start_date'), getParam('end_date')) };

    case 'get_tasks_upcoming':
      return { ok: true, data: _cachedGet('gtu', 300, function() {
        return getTasksUpcoming(limit || 50);
      })};

    case 'get_batch_dashboard_summary':
      return { ok: true, data: _cachedGet('gbds', 300, function() {
        return getBatchDashboardSummary();
      })};

    // Combined endpoint: batches + schedules + summary in one request
    case 'get_batch_init':
      return { ok: true, data: _cachedGet('gbi', 300, function() {
        return {
          batches: getBatches(limit, offset, status),
          schedules: getFermSchedules(),
          summary: getBatchDashboardSummary()
        };
      })};

    case 'get_vessels':
      return { ok: true, data: getVessels() };

    // Recipe endpoints
    case 'get_recipes':
      var recipesCacheKey = 'gr:list:' + (getParam('status') || 'all') + ':' + limit + ':' + offset;
      return { ok: true, data: _cachedGet(recipesCacheKey, 300, function() {
        return getRecipes(limit, offset, getParam('status') || 'all');
      })};

    case 'get_recipe':
      return { ok: true, data: _cachedGet('gr:' + (getParam('recipe_id') || ''), 300, function() {
        return getRecipeDetail(getParam('recipe_id'));
      })};

    // Gift card admin list (D-06 list action for admin view)
    case 'get_gift_cards':
      return { ok: true, data: getGiftCards() };

    // Waitlist admin list (Phase 78). getWaitlist() returns either an array of rows or the
    // ensureWaitlistSheet() failure object ({ok:false, error:'waitlist_unavailable', missing})
    // — return the failure object directly rather than nesting it under `data`.
    case 'get_waitlist':
      var wlResult = getWaitlist();
      if (wlResult && wlResult.ok === false) return wlResult;
      return { ok: true, data: wlResult };

    default:
      return { ok: false, error: 'invalid_action', message: 'Unknown action: ' + action };
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

    // Server-to-server writes from Railway middleware (no Google OAuth required)
    if (payload.server_token) {
      var scriptProps = PropertiesService.getScriptProperties();
      var storedToken = scriptProps.getProperty('SERVER_WRITE_TOKEN') || '';
      if (!storedToken || payload.server_token !== storedToken) {
        return _jsonResponse({ ok: false, error: 'unauthorized', message: 'Invalid server token' });
      }
      if (action === 'add_reservation') {
        return _jsonResponse(addReservation(payload));
      }
      if (action === 'create_batch') {
        var batchResult = createBatch(payload, 'kiosk-middleware');
        if (batchResult.ok && batchResult.batch_id) {
          _invalidateBatchCache(batchResult.batch_id);
        }
        return _jsonResponse(batchResult);
      }
      if (action === 'create_recipe') {
        var recipeResult = createRecipe(payload, 'middleware');
        _invalidateRecipeCache(recipeResult.recipe_id);
        return _jsonResponse(recipeResult);
      }
      if (action === 'update_recipe') {
        var updateResult = updateRecipe(payload, 'middleware');
        _invalidateRecipeCache(payload.recipe_id);
        return _jsonResponse(updateResult);
      }
      if (action === 'delete_recipe') {
        var deleteResult = deleteRecipe(payload, 'middleware');
        _invalidateRecipeCache(payload.recipe_id);
        return _jsonResponse(deleteResult);
      }
      if (action === 'get_recipes') {
        var grLimit = parseInt(payload.limit, 10) || 0;
        var grOffset = parseInt(payload.offset, 10) || 0;
        var grStatus = payload.status || 'all';
        var grCacheKey = 'gr:list:' + grStatus + ':' + grLimit + ':' + grOffset;
        return _jsonResponse({ ok: true, data: _cachedGet(grCacheKey, 300, function() {
          return getRecipes(grLimit, grOffset, grStatus);
        })});
      }
      if (action === 'get_recipe') {
        var grId = payload.recipe_id || '';
        return _jsonResponse({ ok: true, data: _cachedGet('gr:' + grId, 300, function() {
          return getRecipeDetail(grId);
        })});
      }
      // Gift-card lifecycle actions (server_token-gated, D-05)
      if (action === 'issue_gift_card') {
        return _jsonResponse(issueGiftCard(payload));
      }
      if (action === 'lookup_gift_card') {
        return _jsonResponse(lookupGiftCard(payload));
      }
      if (action === 'redeem_gift_card') {
        return _jsonResponse(redeemGiftCard(payload));
      }
      if (action === 'reload_gift_card') {
        return _jsonResponse(reloadGiftCard(payload));
      }
      if (action === 'void_gift_card') {
        return _jsonResponse(voidGiftCard(payload));
      }
      if (action === 'update_gift_card_invoice') {
        return _jsonResponse(updateGiftCardInvoice(payload));
      }
      if (action === 'get_next_cert_number') {
        return _jsonResponse({ ok: true, suggested: generateNextId(GIFT_CARDS_SHEET_NAME, 'GC-', 6) });
      }
      // Waitlist actions (server_token-gated, Phase 78)
      if (action === 'add_waitlist_entry') {
        return _jsonResponse(addWaitlistEntry(payload));
      }
      if (action === 'update_waitlist_status') {
        return _jsonResponse(updateWaitlistStatus(payload));
      }
      // BrewPad write actions (server_token-gated, Phase 76-01)
      if (action === 'update_batch') {
        var sUpdateBatchResult = updateBatch(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sUpdateBatchResult);
      }
      if (action === 'update_batch_schedule') {
        var sUpdateBatchScheduleResult = updateBatchSchedule(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sUpdateBatchScheduleResult);
      }
      if (action === 'delete_batch') {
        var sDeleteBatchResult = deleteBatch(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sDeleteBatchResult);
      }
      if (action === 'bulk_add_plato_readings') {
        var sBulkAddPlatoReadingsResult = bulkAddPlatoReadings(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sBulkAddPlatoReadingsResult);
      }
      if (action === 'bulk_update_batch_tasks') {
        var sBulkUpdateBatchTasksResult = bulkUpdateBatchTasks(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sBulkUpdateBatchTasksResult);
      }
      if (action === 'update_plato_reading') {
        var sUpdatePlatoReadingResult = updatePlatoReading(payload, 'middleware');
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sUpdatePlatoReadingResult);
      }
      if (action === 'delete_plato_reading') {
        var sDeletePlatoReadingResult = deletePlatoReading(payload);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(sDeletePlatoReadingResult);
      }
      if (action === 'create_ferm_schedule') {
        return _jsonResponse(createFermSchedule(payload, 'middleware'));
      }
      if (action === 'update_ferm_schedule') {
        return _jsonResponse(updateFermSchedule(payload, 'middleware'));
      }
      if (action === 'delete_ferm_schedule') {
        return _jsonResponse(deleteFermSchedule(payload));
      }
      return _jsonResponse({ ok: false, error: 'invalid_action', message: 'Unknown server action: ' + action });
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
      case 'send_bottling_invite':
        return _jsonResponse(sendBottlingInvite(payload, authResult.email));
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

      // Recipe CRUD endpoints (staff-auth)
      case 'create_recipe': {
        var r = createRecipe(payload, authResult.email);
        _invalidateRecipeCache(r.recipe_id);
        return _jsonResponse(r);
      }
      case 'update_recipe': {
        var r = updateRecipe(payload, authResult.email);
        _invalidateRecipeCache(payload.recipe_id);
        return _jsonResponse(r);
      }
      case 'delete_recipe': {
        var r = deleteRecipe(payload, authResult.email);
        _invalidateRecipeCache(payload.recipe_id);
        return _jsonResponse(r);
      }

      case 'regenerate_batch_token': {
        var r = regenerateBatchToken(payload);
        _invalidateBatchCache(payload.batch_id);
        return _jsonResponse(r);
      }

      default:
        // Not a known write action -- Phase 64-03 / OPS-03 SC#3: OAuth-authenticated
        // reads (get_batch, get_batches, get_vessels, etc.) now POST here too, since
        // adminApiGet moved the access token out of the URL query string. Delegate to
        // the same read dispatch doGet uses so both transports return identical
        // { ok, data } shapes (including invalid_action for a truly unknown action).
        return _jsonResponse(handleReadAction(action, function (n) { return payload[n]; }, authResult.email));
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

function getFeatured() {
  // Reads from ScriptProperties — no spreadsheet access needed, works for anonymous callers
  var stored = PropertiesService.getScriptProperties().getProperty('featured_skus');
  var skus = [];
  if (stored) {
    try { skus = JSON.parse(stored); } catch (e) {}
  }
  return { ok: true, skus: skus };
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
 * Add a new reservation row written by the Railway middleware after a successful checkout.
 * Called via server_token auth (no Google OAuth required).
 *
 * payload: {
 *   customer_name, customer_email, customer_phone,
 *   order_number, timeslot, notes,
 *   items: [{ name, quantity }]
 * }
 */
function addReservation(payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(RESERVATIONS_SHEET_NAME);
  if (!sheet) return { ok: false, error: 'sheet_not_found' };

  // Generate reservation ID: R-YYYYMMDD-NNN
  var now = new Date();
  var dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd');
  var lastRow = sheet.getLastRow();
  var resNum = String(lastRow).padStart(3, '0');
  var reservationId = 'R-' + dateStr + '-' + resNum;

  // Build comma-separated products string matching onFormSubmit format
  var items = payload.items || [];
  var productsStr = items.map(function (it) {
    var qty = Number(it.quantity) || 1;
    return qty > 1 ? (it.name + ' x' + qty) : it.name;
  }).join(', ');

  // Append order number to notes so it's visible in the admin panel
  var baseNotes = sanitizeInput(payload.notes || '');
  var orderNumber = sanitizeInput(payload.order_number || '');
  var notesWithOrder = orderNumber
    ? (baseNotes ? baseNotes + ' [Zoho: ' + orderNumber + ']' : 'Zoho: ' + orderNumber)
    : baseNotes;

  sheet.appendRow([
    reservationId,
    sanitizeInput(payload.customer_name || ''),
    sanitizeInput(payload.customer_email || ''),
    sanitizeInput(payload.customer_phone || ''),
    sanitizeInput(productsStr),
    sanitizeInput(payload.timeslot || ''),
    'pending',
    now.toISOString(),
    notesWithOrder
  ]);

  return { ok: true, reservation_id: reservationId };
}

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

  // Sync featured SKUs to ScriptProperties so the public get_featured endpoint
  // can serve them without requiring user authentication
  try {
    var featuredSkus = [];
    sanitizedValues.forEach(function(row) {
      if (String(row[0] || '').toLowerCase().trim() === 'featured') {
        var sku = String(row[4] || '').trim();
        var desc = String(row[3] || '').trim();
        if (sku) featuredSkus.push({ sku: sku, description: desc });
      }
    });
    PropertiesService.getScriptProperties().setProperty('featured_skus', JSON.stringify(featuredSkus));
  } catch (e) {}
  try { CacheService.getScriptCache().remove('gfeatured'); } catch (e) {}
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
 * Zero-pad `num` to `padLength` digits and prefix it. Mirrors generateNextId's own padding
 * loop (above) so hoisted, in-memory id minting produces identical ids to the un-hoisted
 * per-call path. Numbers longer than padLength are NOT truncated.
 * @param {string} prefix
 * @param {number} num
 * @param {number} [padLength] - defaults to 6
 * @returns {string}
 */
function formatPaddedId(prefix, num, padLength) {
  if (!padLength) padLength = 6;
  var s = String(num);
  while (s.length < padLength) s = '0' + s;
  return prefix + s;
}

/**
 * Given already-fetched 2D data rows (NO header row), return the highest integer suffix
 * among cells in `colIndex` that start with `prefix`. Returns 0 when none match. Mirrors
 * generateNextId's scan loop (above) but operates on a passed-in array instead of doing its
 * own Sheets read, so a caller that already has the data (e.g. for a comparison) can also
 * mint the next id from it without a second round-trip.
 * @param {Array<Array>} dataRows
 * @param {number} colIndex
 * @param {string} prefix
 * @returns {number}
 */
function maxIdNumFromColumn(dataRows, colIndex, prefix) {
  if (!dataRows || !dataRows.length) return 0;
  var maxNum = 0;
  for (var i = 0; i < dataRows.length; i++) {
    var id = String(dataRows[i][colIndex] || '');
    if (id.indexOf(prefix) === 0) {
      var num = parseInt(id.substring(prefix.length), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    }
  }
  return maxNum;
}

/**
 * Canonical comparison key for one RecipeIngredients row's (item_id, quantity, unit) tuple.
 * Mirrors the write path's exact coercions (updateRecipe's insert loop: sanitizeInput on
 * item_id/unit, `!== undefined ? Number(...) : 0` on quantity) so a JSON-payload tuple and a
 * Sheets-read-back tuple for the same logical row normalize to the same key.
 *
 * Deliberately does NOT case-fold item_id or unit. A false "changed" verdict from this
 * function costs one harmless, self-correcting wasted rewrite. A false "unchanged" verdict
 * silently discards a user's ingredient edit with no error surface. Every ambiguity here
 * must resolve toward "changed" — so casing, order and non-finite quantities are all
 * significant.
 * @param {*} itemId
 * @param {*} quantity
 * @param {*} unit
 * @returns {string}
 */
function normalizeRecipeIngredientTuple(itemId, quantity, unit) {
  var itemKey = String(itemId == null ? '' : itemId).trim();
  var unitKey = String(unit == null ? '' : unit).trim();

  var rawQty = (quantity === undefined || quantity === null || quantity === '') ? 0 : quantity;
  var n = Number(rawQty);
  var qtyKey;
  if (!isFinite(n)) {
    // Never let two unparseable quantities compare equal — always force "changed".
    qtyKey = '!nonfinite';
  } else {
    // Round to 9 decimal places to absorb Sheets/JSON float drift (e.g. 0.1 + 0.2) without
    // merging any quantity difference that matters at brewing magnitudes (kg/g/pcs).
    qtyKey = String(Math.round(n * 1e9) / 1e9);
  }

  return itemKey + ' ' + qtyKey + ' ' + unitKey;
}

/**
 * Order-sensitive, length-sensitive element-wise comparison of two arrays of tuple keys
 * (each produced by normalizeRecipeIngredientTuple). Used to decide whether an incoming
 * ingredient list actually differs from what is stored, so the expensive delete+insert can
 * be skipped when it does not (D-04).
 * @param {Array<string>} incomingTuples
 * @param {Array<string>} storedTuples
 * @returns {boolean}
 */
function recipeIngredientsUnchanged(incomingTuples, storedTuples) {
  var a = incomingTuples || [];
  var b = storedTuples || [];

  if (a.length !== b.length) return false;

  for (var i = 0; i < a.length; i++) {
    // A non-finite quantity on either side always forces "changed" — even two identical
    // sentinel tokens must never be treated as an unchanged match.
    if (a[i].indexOf('!nonfinite') !== -1 || b[i].indexOf('!nonfinite') !== -1) return false;
  }

  for (var j = 0; j < a.length; j++) {
    if (a[j] !== b[j]) return false;
  }

  return true;
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
        return s === 'primary' || s === 'secondary' || s === 'pending';
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

/**
 * SUPERSEDED 2026-06-16 by the middleware Resend path (POST /api/batch/bottling-invite).
 * BrewPad now sends bottling invites through the middleware (Resend over HTTPS, on the
 * verified steinsandvines.ca domain). This MailApp version is retained as a fallback only
 * — the original "Railway blocks SMTP" rationale no longer applies now that Resend is wired.
 *
 * Email the customer a link to self-book their Cal.com Bottling Appointment.
 * Sends via MailApp (Google infrastructure) — deliberately NOT the Railway
 * middleware SMTP path, which Railway blocks. Triggered by the brewpad
 * "Send Bottling Invite" button. Read-only on sheet data (no cache to invalidate).
 * @param {Object} payload - { batch_id }
 * @param {string} staffEmail - authenticated staff email (audit context)
 * @returns {Object} { ok, message }
 */
function sendBottlingInvite(payload, staffEmail) {
  var batchId = payload.batch_id || '';
  if (!batchId) return { ok: false, error: 'batch_id required', message: 'batch_id is required' };

  var result = findRowById(BATCHES_SHEET_NAME, batchId);
  if (result.row === -1) return { ok: false, error: 'not_found', message: 'Batch not found: ' + batchId };

  var batch = result.data;
  var email = String(batch.customer_email || '').trim();
  if (!email || email.indexOf('@') === -1) {
    return { ok: false, error: 'no_email', message: 'This batch has no customer email on file.' };
  }

  var fullName = String(batch.customer_name ||
    ((batch.customer_firstname || '') + ' ' + (batch.customer_lastname || ''))).trim();
  var greeting = String(batch.customer_firstname || fullName || 'there').trim();
  var product = String(batch.product_name || 'your batch').trim();

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Pre-fill the Cal.com booking page with the customer's name + email.
  var url = CALCOM_BOTTLING_BOOKING_URL +
    '?name=' + encodeURIComponent(fullName) +
    '&email=' + encodeURIComponent(email);

  var subject = 'Book your bottling appointment — Steins & Vines';
  var htmlBody =
    '<div style="font-family:Arial,sans-serif;font-size:15px;color:#2c2c2c;line-height:1.6;">' +
    '<p>Hi ' + esc(greeting) + ',</p>' +
    '<p>Your batch <strong>' + esc(product) + '</strong> (' + esc(batchId) + ') is ready for bottling. ' +
    'Pick a time that works for you:</p>' +
    '<p style="margin:24px 0;"><a href="' + url + '" ' +
    'style="background:#4a6f4b;color:#ffffff;text-decoration:none;padding:12px 22px;' +
    'border-radius:6px;font-weight:bold;display:inline-block;">Book your bottling appointment</a></p>' +
    '<p style="font-size:13px;color:#5f5f5f;">Or paste this link into your browser:<br>' + esc(url) + '</p>' +
    '<p>Cheers,<br>Steins &amp; Vines</p></div>';
  var plainBody =
    'Hi ' + greeting + ',\n\n' +
    'Your batch ' + product + ' (' + batchId + ') is ready for bottling. ' +
    'Pick a time that works for you:\n\n' + url + '\n\nCheers,\nSteins & Vines';

  try {
    MailApp.sendEmail({
      to: email,
      subject: subject,
      htmlBody: htmlBody,
      body: plainBody,
      name: 'Steins & Vines',
      replyTo: 'hello@steinsandvines.ca'
    });
  } catch (err) {
    return { ok: false, error: 'send_failed', message: 'Email failed: ' + (err && err.message ? err.message : err) };
  }

  return { ok: true, message: 'Bottling invite sent to ' + email };
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
      customer_firstname: batch.customer_firstname || '',
      customer_lastname: batch.customer_lastname || '',
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
      customer_firstname: batch.customer_firstname || '',
      customer_lastname: batch.customer_lastname || '',
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
    readyForPackaging: 0,
    pendingCount: 0
  };

  // Active batch metadata (for ready-to-bottle) + pending (needs-scheduling) collection.
  var activeBatchIds = {};
  var batchMeta = {};
  var needsScheduling = [];
  batches.forEach(function (b) {
    var bid = String(b.batch_id);
    var s = String(b.status || '').toLowerCase();
    if (s === 'primary' || s === 'secondary') {
      if (s === 'primary') summary.primaryCount++; else summary.secondaryCount++;
      activeBatchIds[bid] = true;
      batchMeta[bid] = {
        batch_id: bid,
        status: s,
        product_name: b.product_name || '',
        customer_name: String(b.customer_name ||
          ((b.customer_firstname || '') + ' ' + (b.customer_lastname || ''))).trim(),
        customer_email: String(b.customer_email || '').trim(),
        vessel_id: b.vessel_id || '',
        shelf_id: b.shelf_id || ''
      };
    } else if (s === 'complete') {
      summary.completeCount++;
    } else if (s === 'disabled') {
      summary.disabledCount++;
    } else if (s === 'pending') {
      summary.pendingCount++;
      needsScheduling.push({
        batch_id: bid,
        product_name: b.product_name || '',
        customer_name: String(b.customer_name ||
          ((b.customer_firstname || '') + ' ' + (b.customer_lastname || ''))).trim(),
        source: b.source || '',
        zoho_so_number: b.zoho_so_number || '',
        created_at: b.created_at || '',
        last_updated: b.last_updated || ''
      });
    }
  });

  // Robust truthiness for Google Sheets booleans ('TRUE'/'true'/true/1/'yes').
  function _isTrue(v) {
    var x = String(v).trim().toLowerCase();
    return x === 'true' || x === '1' || x === 'yes';
  }

  // Task analysis: due-date counters + per-batch packaging readiness.
  var pkgByBatch = {}; // batch_id -> { hasIncPkg, allNonPkgDone, pkgDue }
  tasks.forEach(function (t) {
    var bid = String(t.batch_id);
    if (!activeBatchIds[bid]) return;

    var done = _isTrue(t.completed);
    var isPkg = _isTrue(t.is_packaging);
    var dueDate = String(t.due_date || '').trim();
    if (dueDate.length > 10) dueDate = dueDate.substring(0, 10); // normalize datetime -> YYYY-MM-DD

    if (!done) {
      if (dueDate && dueDate < today) summary.overdueTasks++;
      if (dueDate === today) summary.tasksDueToday++;
      if (dueDate && dueDate >= today && dueDate <= weekEnd) summary.tasksDueThisWeek++;
    }

    if (!pkgByBatch[bid]) pkgByBatch[bid] = { hasIncPkg: false, allNonPkgDone: true, pkgDue: '' };
    if (isPkg) {
      if (!done) {
        pkgByBatch[bid].hasIncPkg = true;
        if (dueDate && (!pkgByBatch[bid].pkgDue || dueDate < pkgByBatch[bid].pkgDue)) {
          pkgByBatch[bid].pkgDue = dueDate;
        }
      }
    } else if (!done) {
      pkgByBatch[bid].allNonPkgDone = false;
    }
  });

  // Ready to Bottle: active batch with an INCOMPLETE packaging task, AND either
  // all its other (non-packaging) tasks are done (fermentation finished) OR the
  // bottling date has arrived/passed. A TBD-dated packaging task on a batch whose
  // other tasks aren't finished does NOT count — that was over-counting batches
  // still mid-ferment. Boolean parsing hardened above (TRUE/true/1/yes).
  var readyToBottle = [];
  Object.keys(pkgByBatch).forEach(function (bid) {
    var st = pkgByBatch[bid];
    var meta = batchMeta[bid];
    if (!meta || !st.hasIncPkg) return;
    var due = st.pkgDue;
    var dueReached = !!due && due <= today;
    if (st.allNonPkgDone || dueReached) {
      readyToBottle.push({
        batch_id: meta.batch_id,
        product_name: meta.product_name,
        customer_name: meta.customer_name,
        vessel_id: meta.vessel_id,
        shelf_id: meta.shelf_id,
        status: meta.status,
        bottling_due: due || '',
        overdue: !!due && due < today,
        has_email: !!meta.customer_email
      });
    }
  });

  // Overdue first, then soonest date, TBD last; tiebreak by batch_id.
  readyToBottle.sort(function (a, b) {
    var ad = a.bottling_due || '9999-12-31';
    var bd = b.bottling_due || '9999-12-31';
    if (ad !== bd) return ad < bd ? -1 : 1;
    return String(a.batch_id).localeCompare(String(b.batch_id));
  });

  summary.readyForPackaging = readyToBottle.length;
  summary.readyToBottle = readyToBottle;

  // Newest sale first so the most recently sold pending batch is on top.
  needsScheduling.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  summary.needsScheduling = needsScheduling;

  // Batches started per month (last 6 months) for the dashboard bar chart.
  var tz = Session.getScriptTimeZone();
  var nowD = new Date();
  var monthKeys = [];
  var monthCounts = {};
  for (var mi = 5; mi >= 0; mi--) {
    var dt = new Date(nowD.getFullYear(), nowD.getMonth() - mi, 1);
    var mk = Utilities.formatDate(dt, tz, 'yyyy-MM');
    monthKeys.push({ month: mk, label: Utilities.formatDate(dt, tz, 'MMM') });
    monthCounts[mk] = 0;
  }
  batches.forEach(function (b) {
    var sd = String(b.start_date || '').trim();
    if (sd.length >= 7) {
      var k = sd.substring(0, 7);
      if (monthCounts.hasOwnProperty(k)) monthCounts[k]++;
    }
  });
  summary.batchesByMonth = monthKeys.map(function (m) {
    return { month: m.month, label: m.label, count: monthCounts[m.month] };
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
  var isPending = !payload.schedule_id || !payload.start_date;
  if ((!payload.product_sku && !payload.recipe_id) || (!payload.customer_name && !payload.customer_firstname)) {
    return { ok: false, error: 'missing_fields', message: 'product_sku (or recipe_id) and customer name are required' };
  }

  // CR-01 fix (gap-closure 29.3): Dedup guard now matches on BOTH zoho_so_number AND product_sku.
  // Original guard (D-10.2) matched on zoho_so_number alone, which incorrectly blocked the second
  // kit item of a multi-kit invoice (kiosk path and bulk-create both call createBatch once per SKU
  // with the same zoho_so_number). A batch is a true duplicate only when BOTH invoice AND SKU match.
  // Batches with no zoho_so_number are unaffected (guard only fires when field is present).
  //
  // 2026-07-11: the invoice+SKU pair is NOT unique — a customer can buy the same kit
  // several times on one invoice (INV-000137 bought Italy Nebbiolo Style x3), and each
  // unit is its own fermentation batch. Matching on the pair alone admitted the first
  // unit and rejected the rest as duplicates, so multi-unit sales silently lost batches
  // (the middleware queued the rejects for retry, where they failed permanently and
  // aged out). The caller now sends unit_total = how many batches this invoice+SKU
  // should have; we allow creates until that many exist. Retry-safety is preserved:
  // once unit_total rows exist, further creates are still duplicates.
  //
  // CONTRACT (grep-checkable):
  //   createBatch({zoho_so_number:'INV-001', product_sku:'SKU-A', unit_total:3}) x3 — all 3 create
  //   createBatch({zoho_so_number:'INV-001', product_sku:'SKU-A', unit_total:3}) — 4th call: duplicate_so_number
  //   createBatch({zoho_so_number:'INV-001', product_sku:'SKU-A'}) — no unit_total: legacy, allows 1
  //   createBatch({zoho_so_number:'INV-001', product_sku:'SKU-B'}) — different SKU: independent count
  //
  // NOTE: This file has no Jest harness. Redeploy to Google Apps Script is required for this fix
  // to take effect in production. See 29.3-HUMAN-UAT.md for the mandatory redeploy step.
  if (payload.zoho_so_number && payload.product_sku) {
    var allowedUnits = Math.floor(Number(payload.unit_total));
    if (!isFinite(allowedUnits) || allowedUnits < 1) allowedUnits = 1;  // legacy callers

    var existingBatches = sheetToObjects(BATCHES_SHEET_NAME);
    var matching = [];
    for (var di = 0; di < existingBatches.length; di++) {
      var sameInvoice = String(existingBatches[di].zoho_so_number || '').trim() ===
                        String(payload.zoho_so_number).trim();
      var sameSku     = String(existingBatches[di].product_sku || '').trim() ===
                        String(payload.product_sku).trim();
      if (sameInvoice && sameSku) matching.push(existingBatches[di].batch_id);
    }
    if (matching.length >= allowedUnits) {
      return {
        ok: false,
        error: 'duplicate_so_number',
        message: 'SO/invoice ' + payload.zoho_so_number + ' + SKU ' + payload.product_sku +
                 ' already has ' + matching.length + ' of ' + allowedUnits +
                 ' batch(es): ' + matching.join(', ')
      };
    }
  } else if (payload.zoho_so_number && !payload.product_sku) {
    // Fallback: invoice-level dedup when no SKU provided (should not happen from 29.3 paths).
    var existingBatches2 = sheetToObjects(BATCHES_SHEET_NAME);
    for (var dj = 0; dj < existingBatches2.length; dj++) {
      if (String(existingBatches2[dj].zoho_so_number || '').trim() ===
          String(payload.zoho_so_number).trim()) {
        return {
          ok: false,
          error: 'duplicate_so_number',
          message: 'A batch for SO/invoice ' + payload.zoho_so_number + ' already exists: ' + existingBatches2[dj].batch_id
        };
      }
    }
  }

  // Auto-compose customer_name from first/last if not provided (backward compat)
  if (!payload.customer_name && payload.customer_firstname) {
    payload.customer_name = (payload.customer_firstname + ' ' + (payload.customer_lastname || '')).trim();
  }

  // Validate schedule exists (skip for pending batches)
  var schedResult = null;
  if (!isPending) {
    schedResult = findRowById(FERM_SCHEDULES_SHEET_NAME, payload.schedule_id);
    if (schedResult.row === -1) {
      return { ok: false, error: 'not_found', message: 'Schedule not found: ' + payload.schedule_id };
    }
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
    var scheduleSnapshot = isPending ? '' : (schedResult.data.steps || '[]');
    var steps = [];
    if (!isPending) {
      try { steps = JSON.parse(scheduleSnapshot); } catch (e) { steps = []; }
    }

    // Append batch row
    batchesSheet.appendRow([
      batchId,
      isPending ? 'pending' : 'primary',
      sanitizeInput(payload.product_sku),
      sanitizeInput(payload.product_name || ''),
      sanitizeInput(payload.customer_id || ''),
      sanitizeInput(payload.customer_name),
      sanitizeInput(payload.source === 'kiosk' ? '' : (payload.customer_email || '')),
      payload.start_date || '',
      payload.schedule_id || '',
      scheduleSnapshot,
      sanitizeInput(payload.vessel_id || ''),
      sanitizeInput(payload.shelf_id || ''),
      sanitizeInput(payload.bin_id || ''),
      sanitizeInput(payload.notes || ''),
      accessToken,
      sanitizeInput(payload.reservation_id || ''),
      now,
      userEmail,
      now,
      '',
      sanitizeInput(payload.source || 'manual'),
      sanitizeInput(payload.zoho_so_number || ''),
      isPending ? '' : (payload.start_date || now),  // col 23: fermentation_started_at (Phase 7)
      ''                                              // col 24: completed_at (Phase 7)
    ]);

    // Write customer_firstname / customer_lastname by header lookup (avoids positional coupling)
    var headers = batchesSheet.getRange(1, 1, 1, batchesSheet.getLastColumn()).getValues()[0];
    var newRow = batchesSheet.getLastRow();
    var fnCol = headers.indexOf('customer_firstname');
    var lnCol = headers.indexOf('customer_lastname');
    if (fnCol !== -1) batchesSheet.getRange(newRow, fnCol + 1).setValue(sanitizeInput(payload.customer_firstname || ''));
    if (lnCol !== -1) batchesSheet.getRange(newRow, lnCol + 1).setValue(sanitizeInput(payload.customer_lastname || ''));

    // Write recipe_id / recipe_snapshot by header lookup (avoids positional coupling)
    if (payload.recipe_id || payload.recipe_snapshot) {
      var bHeaders = batchesSheet.getRange(1, 1, 1, batchesSheet.getLastColumn()).getValues()[0];
      var recipeRow = batchesSheet.getLastRow();
      var recipeIdCol = bHeaders.indexOf('recipe_id');
      var snapshotCol = bHeaders.indexOf('recipe_snapshot');
      if (recipeIdCol !== -1 && payload.recipe_id) {
        batchesSheet.getRange(recipeRow, recipeIdCol + 1).setValue(sanitizeInput(payload.recipe_id));
      }
      if (snapshotCol !== -1 && payload.recipe_snapshot) {
        batchesSheet.getRange(recipeRow, snapshotCol + 1).setValue(payload.recipe_snapshot);
      }
    }

    // Write target_volume_l / scale_factor by header lookup (SEL-02 carry-through, Phase 36).
    // The recipe_snapshot already carries these (Phase 35); persisting them as first-class
    // batch columns lets the batch record show the chosen volume without re-entry.
    // NOTE: add 'target_volume_l' and 'scale_factor' column headers to the Batches sheet;
    // this block no-ops on the columns it cannot find, so it is safe to deploy before/after
    // the headers are added.
    if (payload.target_volume_l != null || payload.scale_factor != null) {
      var vHeaders = batchesSheet.getRange(1, 1, 1, batchesSheet.getLastColumn()).getValues()[0];
      var volRow = batchesSheet.getLastRow();
      var tvCol = vHeaders.indexOf('target_volume_l');
      var sfCol = vHeaders.indexOf('scale_factor');
      if (tvCol !== -1 && payload.target_volume_l != null) {
        batchesSheet.getRange(volRow, tvCol + 1).setValue(payload.target_volume_l);
      }
      if (sfCol !== -1 && payload.scale_factor != null) {
        batchesSheet.getRange(volRow, sfCol + 1).setValue(payload.scale_factor);
      }
    }

    var tasksCreated = 0;
    var taskErrors = [];

    if (!isPending) {
      // Create tasks from schedule (steps already parsed above)
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
    }

    var resp = { ok: true, batch_id: batchId, access_token: accessToken, tasks_created: tasksCreated };
    if (isPending) {
      resp.status = 'pending';
    }
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
  var allowedFields = [
    'status', 'vessel_id', 'shelf_id', 'bin_id', 'notes',
    // Phase 7: SO linking fields (D-04, D-05) and lifecycle date columns (D-09)
    'zoho_so_number', 'customer_id', 'customer_name', 'product_name',
    'customer_firstname', 'customer_lastname',
    'fermentation_started_at', 'completed_at',
    'recipe_id',   // Phase 16: recipe_id safe through sanitizeInput
    'start_date',  // Phase 27: guided activation sets start_date before schedule generation
    'customer_email', 'customer_phone',  // Phase 28: refresh-from-Zoho write-back (D-09)
    // Bottling-invite send tracking: stamped by the middleware after a successful
    // Resend send (POST /api/batch/bottling-invite) so staff don't double-ping a
    // customer. Both columns are header-driven — if the Batches sheet lacks them the
    // writes are silently skipped (headers.indexOf === -1), so the feature no-ops
    // safely until the columns are added and this script is redeployed.
    'bottling_invite_sent_at', 'bottling_invite_email'
  ];
  allowedFields.forEach(function (field) {
    if (updates[field] !== undefined) {
      var colIndex = headers.indexOf(field);
      if (colIndex !== -1) {
        sheet.getRange(row, colIndex + 1).setValue(sanitizeInput(String(updates[field])));
      }
    }
  });

  // Phase 16: Handle recipe_snapshot separately — raw setValue, bypass sanitizeInput
  // (sanitizeInput strips HTML tags which can appear in serialized JSON and corrupt it)
  // This mirrors createBatch() line 1819 which also uses raw setValue for recipe_snapshot.
  if (updates.recipe_snapshot !== undefined) {
    try { JSON.parse(updates.recipe_snapshot); } catch (e) {
      return { ok: false, error: 'invalid_snapshot', message: 'recipe_snapshot is not valid JSON' };
    }
    var snapCol = headers.indexOf('recipe_snapshot');
    if (snapCol !== -1) {
      sheet.getRange(row, snapCol + 1).setValue(updates.recipe_snapshot); // raw — no sanitizeInput
    }
  }

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
    // Phase 7/27: write fermentation_started_at when pending batch transitions to active (D-09)
    // Phase 27: honor the chosen start date from guided activation (not always now)
    // Priority: updates.fermentation_started_at > updates.start_date > current.start_date > now
    if (oldStatus === 'pending') {
      var fermCol = headers.indexOf('fermentation_started_at');
      if (fermCol !== -1) {
        var fermStamp;
        if (updates.fermentation_started_at) {
          fermStamp = sanitizeInput(String(updates.fermentation_started_at));
        } else if (updates.start_date) {
          fermStamp = sanitizeInput(String(updates.start_date));
        } else if (current.start_date) {
          fermStamp = sanitizeInput(String(current.start_date));
        } else {
          fermStamp = now;
        }
        sheet.getRange(row, fermCol + 1).setValue(fermStamp);
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
  // Persist schedule_id so the detail pane can pre-select the current schedule on a later
  // change (batches scheduled via update_batch_schedule otherwise leave schedule_id blank).
  if (payload.schedule_id) {
    var schedIdCol = headers.indexOf('schedule_id');
    if (schedIdCol !== -1) sheet.getRange(row, schedIdCol + 1).setValue(payload.schedule_id);
  }
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
  // Phase 7: record batch completion timestamp (D-09)
  var completedAtCol = result.headers.indexOf('completed_at');
  if (completedAtCol !== -1) result.sheet.getRange(result.row, completedAtCol + 1).setValue(timestamp);

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
  var plato = (payload.degrees_plato !== undefined && payload.degrees_plato !== '') ? parseFloat(payload.degrees_plato) : '';
  if (plato !== '' && (isNaN(plato) || plato > 40)) {
    return { ok: false, error: 'invalid_value', message: 'degrees_plato must be 40 or less' };
  }
  // At least one measurement must be provided
  var tempRaw = (payload.temperature !== undefined && payload.temperature !== '') ? parseFloat(payload.temperature) : '';
  var phRaw = (payload.ph !== undefined && payload.ph !== '') ? parseFloat(payload.ph) : '';
  if (plato === '' && tempRaw === '' && phRaw === '') {
    return { ok: false, error: 'invalid_input', message: 'At least one of degrees_plato, temperature, or ph is required' };
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
    if (isNaN(plato) || plato > 40) {
      return { ok: false, error: 'invalid_value', message: 'degrees_plato must be 40 or less' };
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

// ===== RECIPE CRUD =====

/**
 * Invalidate all recipe-related caches after a write operation.
 * @param {string} recipeId - The recipe ID that was modified
 */
function _invalidateRecipeCache(recipeId) {
  var cache = CacheService.getScriptCache();
  var keys = [];
  ['all', 'draft', 'active', 'inactive'].forEach(function(s) {
    keys.push('gr:list:' + s + ':0:0');
  });
  if (recipeId) {
    keys.push('gr:' + recipeId);
  }
  cache.removeAll(keys);
}

/**
 * GET: List all recipes with optional status filter and pagination.
 * @param {number} limit - Max results (0 = no limit)
 * @param {number} offset - Offset for pagination
 * @param {string} status - 'all', 'draft', 'active', or 'inactive'
 * @returns {{ recipes: Array, total: number, filtered: number }}
 */
function getRecipes(limit, offset, status) {
  var recipes = sheetToObjects(RECIPES_SHEET_NAME);
  var total = recipes.length;

  // Filter by status
  if (status && status !== 'all') {
    recipes = recipes.filter(function (r) {
      return String(r.status || '').toLowerCase() === status.toLowerCase();
    });
  }

  var filtered = recipes.length;

  // Sort newest first
  recipes.sort(function (a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });

  // Paginate
  if (limit > 0) {
    recipes = recipes.slice(offset, offset + limit);
  } else if (offset > 0) {
    recipes = recipes.slice(offset);
  }

  // Enrich with ingredient counts
  var allIngredients = sheetToObjects(RECIPE_INGREDIENTS_SHEET_NAME);
  recipes.forEach(function (r) {
    r.ingredient_count = allIngredients.filter(function (ing) {
      return String(ing.recipe_id) === String(r.recipe_id);
    }).length;
    delete r._row;
  });

  return { recipes: recipes, total: total, filtered: filtered };
}

/**
 * GET: Full recipe detail including ingredient list.
 * @param {string} recipeId
 * @returns {{ recipe: Object, ingredients: Array }}
 */
function getRecipeDetail(recipeId) {
  if (!recipeId) {
    return { ok: false, error: 'missing_id', message: 'recipe_id is required' };
  }

  var result = findRowById(RECIPES_SHEET_NAME, recipeId);
  if (result.row === -1) {
    return { ok: false, error: 'not_found', message: 'Recipe not found: ' + recipeId };
  }

  var recipe = result.data;
  delete recipe._row;

  var allIngredients = sheetToObjects(RECIPE_INGREDIENTS_SHEET_NAME);
  var ingredients = allIngredients.filter(function (ing) {
    return String(ing.recipe_id) === String(recipeId);
  });
  ingredients.forEach(function (ing) { delete ing._row; });

  return { recipe: recipe, ingredients: ingredients };
}

/**
 * POST: Create a new recipe with optional ingredient rows.
 * @param {Object} payload - Recipe fields + optional ingredients array
 * @param {string} userEmail - Authenticated staff email
 */
/**
 * Self-migrating helper: the Recipes sheet originally shipped without a
 * pricing_mode column, so the value was dropped on save and recipes always
 * reverted to 'locked'. Add the column (at the end) the first time we write,
 * so pricing_mode persists and round-trips via sheetToObjects' header mapping.
 * Existing rows read as '' which the frontend treats as 'locked'
 * (backward-compatible). Returns the zero-based column index.
 */
function ensureRecipesPricingModeColumn(sheet) {
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idx = headers.indexOf('pricing_mode');
  if (idx === -1) {
    sheet.getRange(1, lastCol + 1).setValue('pricing_mode').setFontWeight('bold');
    return lastCol; // zero-based index of the newly added column
  }
  return idx;
}

function normalizePricingMode(value) {
  return value === 'dynamic' ? 'dynamic' : 'locked';
}

function createRecipe(payload, userEmail) {
  if (!payload.name) {
    return { ok: false, error: 'missing_fields', message: 'name is required' };
  }

  var ingredients;
  if (payload.ingredients !== undefined) {
    try {
      ingredients = typeof payload.ingredients === 'string' ? JSON.parse(payload.ingredients) : payload.ingredients;
    } catch (e) {
      return { ok: false, error: 'invalid_data', message: 'Invalid ingredients JSON' };
    }
  }

  var lock = acquireScriptLock(15000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var recipesSheet = ss.getSheetByName(RECIPES_SHEET_NAME);
    if (!recipesSheet) {
      return { ok: false, error: 'sheet_not_found', message: 'Recipes sheet not found' };
    }

    var recipeId = generateNextId(RECIPES_SHEET_NAME, 'SV-R-', 6);
    var serviceFee = payload.service_fee !== undefined ? Number(payload.service_fee) : 45;
    var materialsFee = payload.materials_fee !== undefined ? Number(payload.materials_fee) : 5;
    var now = new Date().toISOString();

    recipesSheet.appendRow([
      recipeId,
      sanitizeInput(payload.name),
      sanitizeInput(payload.style || ''),
      sanitizeInput(payload.description || ''),
      payload.status || 'draft',
      payload.locked_price !== undefined ? Number(payload.locked_price) : '',
      serviceFee,
      materialsFee,
      payload.batch_size_l !== undefined ? Number(payload.batch_size_l) : '',
      payload.abv !== undefined ? Number(payload.abv) : '',
      payload.ibu !== undefined ? Number(payload.ibu) : '',
      payload.colour_srm !== undefined ? Number(payload.colour_srm) : '',
      sanitizeInput(payload.notes || ''),
      now,
      userEmail,
      now
    ]);

    // Persist pricing_mode by header lookup (column is self-migrated if missing)
    var pmCol = ensureRecipesPricingModeColumn(recipesSheet);
    recipesSheet.getRange(recipesSheet.getLastRow(), pmCol + 1)
      .setValue(normalizePricingMode(payload.pricing_mode));

    var ingredientErrors = [];
    var ingredientsCreated = 0;

    if (ingredients && ingredients.length > 0) {
      var ingSheet = ss.getSheetByName(RECIPE_INGREDIENTS_SHEET_NAME);
      if (!ingSheet) {
        return { ok: false, error: 'sheet_not_found', message: 'RecipeIngredients sheet not found -- run setupRecipeTabs() first' };
      }
      for (var i = 0; i < ingredients.length; i++) {
        try {
          var ing = ingredients[i];
          var ingId = generateNextId(RECIPE_INGREDIENTS_SHEET_NAME, 'RI-', 6);
          ingSheet.appendRow([
            ingId,
            recipeId,
            sanitizeInput(ing.item_id || ''),
            sanitizeInput(ing.item_name || ''),
            ing.quantity !== undefined ? Number(ing.quantity) : 0,
            sanitizeInput(ing.unit || '')
          ]);
          ingredientsCreated++;
        } catch (ingErr) {
          ingredientErrors.push('Ingredient ' + (i + 1) + ': ' + ingErr.message);
        }
      }
    }

    invalidateSheetCache(RECIPES_SHEET_NAME);
    invalidateSheetCache(RECIPE_INGREDIENTS_SHEET_NAME);

    var resp = { ok: true, recipe_id: recipeId, ingredients_created: ingredientsCreated };
    if (ingredientErrors.length > 0) {
      resp.ingredient_errors = ingredientErrors;
    }
    return resp;
  } finally {
    lock.releaseLock();
  }
}

/**
 * POST: Update an existing recipe's fields and optionally replace its ingredient list.
 * @param {Object} payload - recipe_id required; any other field is optional
 * @param {string} userEmail - Authenticated staff email
 */
function updateRecipe(payload, userEmail) {
  if (!payload.recipe_id) {
    return { ok: false, error: 'missing_id', message: 'recipe_id is required' };
  }

  // D-10: local 5s lock budget for THIS call site only (was 15000ms, the exact same ceiling
  // as the middleware's own axios timeout at zoho-middleware/routes/recipes.js:37). Waiting
  // the full 15s here meant that under lock contention the middleware could give up at the
  // very moment the lock was granted, so recipe saves failed with an indistinguishable 502.
  // 5000ms leaves roughly 10s of headroom for the now-~6-call write below, and a failed
  // acquisition returns fast with a distinguishable `lock_timeout` result (surfaced by the
  // middleware as an HTTP 422 carrying this message, not a 502). The acquisition try/catch
  // sits BEFORE the main try/finally and returns early on failure, so releaseLock() can never
  // run against a lock that was never acquired. The other 10 acquireScriptLock() call sites
  // in this file (createBatch, addBatchTask, addPlatoReading, propagateFermSchedule,
  // createRecipe, deleteRecipe, issueGiftCard, redeemGiftCard, reloadGiftCard, voidGiftCard)
  // are out of this phase's scope (recipe save, not batch/gift-card locking) and keep their
  // existing literals unchanged.
  var lock;
  try {
    lock = acquireScriptLock(5000);
  } catch (lockErr) {
    return { ok: false, error: 'lock_timeout', message: 'Recipe sheet is busy - another write is in progress. Please retry.' };
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var recipesSheet = ss.getSheetByName(RECIPES_SHEET_NAME);
    if (!recipesSheet) {
      return { ok: false, error: 'sheet_not_found', message: 'Recipes sheet not found' };
    }

    // D-08 ordering: run the self-migrating pricing_mode column BEFORE the row is read, and
    // unconditionally (not gated on payload.pricing_mode being present) -- the column may
    // need to migrate on any save. ensureRecipesPricingModeColumn() may append a header cell,
    // widening the row; findRowById() returns headers from a stale, already-populated
    // _sheetCache entry when one exists, so reading the row first would yield a short header
    // array and the batched setValues() below would then write a stale-width row. Invalidate
    // the cache immediately after so findRowById() below re-reads the (possibly new) width.
    var pmCol = ensureRecipesPricingModeColumn(recipesSheet);
    invalidateSheetCache(RECIPES_SHEET_NAME);

    var result = findRowById(RECIPES_SHEET_NAME, payload.recipe_id);
    if (result.row === -1) {
      return { ok: false, error: 'not_found', message: 'Recipe not found: ' + payload.recipe_id };
    }

    var headers = result.headers;
    var sheet = result.sheet;
    var row = result.row;
    var now = new Date().toISOString();

    // D-08: read the recipe row once, mutate a plain array in memory, then write once --
    // replaces ~14 individual setValue() calls (two forEach loops + pricing_mode +
    // updated_at) with a single ranged read + a single ranged write (or a formula-safe
    // per-cell fallback below). Column 0 (recipe_id, the primary key) is never mutated or
    // included in the written span.
    var rowValues = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
    var minCol = null;
    var maxCol = null;

    // Update string fields via header lookup
    var stringFields = ['name', 'style', 'description', 'status', 'notes'];
    stringFields.forEach(function (field) {
      if (payload[field] !== undefined) {
        var col = headers.indexOf(field);
        if (col > 0) {
          rowValues[col] = sanitizeInput(payload[field]);
          if (minCol === null || col < minCol) minCol = col;
          if (maxCol === null || col > maxCol) maxCol = col;
        }
      }
    });

    // Update numeric fields via header lookup (no sanitizeInput on numbers)
    var numericFields = ['locked_price', 'service_fee', 'materials_fee', 'batch_size_l', 'abv', 'ibu', 'colour_srm'];
    numericFields.forEach(function (field) {
      if (payload[field] !== undefined) {
        var col = headers.indexOf(field);
        if (col > 0) {
          rowValues[col] = Number(payload[field]);
          if (minCol === null || col < minCol) minCol = col;
          if (maxCol === null || col > maxCol) maxCol = col;
        }
      }
    });

    // Update pricing_mode (enum: locked | dynamic) via the self-migrated column
    if (payload.pricing_mode !== undefined && pmCol > 0) {
      rowValues[pmCol] = normalizePricingMode(payload.pricing_mode);
      if (minCol === null || pmCol < minCol) minCol = pmCol;
      if (maxCol === null || pmCol > maxCol) maxCol = pmCol;
    }

    // Always update updated_at
    var luCol = headers.indexOf('updated_at');
    if (luCol > 0) {
      rowValues[luCol] = now;
      if (minCol === null || luCol < minCol) minCol = luCol;
      if (maxCol === null || luCol > maxCol) maxCol = luCol;
    }

    var rowWriteMode = 'none';
    if (minCol !== null) {
      var span = maxCol - minCol + 1;
      // Formula-safety fallback (T-79-03-03): a ranged setValues() writes literals, so a
      // formula sitting in an UNMUTATED cell inside [minCol, maxCol] would be silently
      // flattened. Read the formulas for the exact span first; if any cell in it holds a
      // formula, fall back to per-cell setValue for only the mutated columns (today's
      // behaviour, at most 14 calls) instead of assuming the range is formula-free.
      var formulasInSpan = sheet.getRange(row, minCol + 1, 1, span).getFormulas()[0];
      var hasFormula = false;
      for (var fIdx = 0; fIdx < formulasInSpan.length; fIdx++) {
        if (formulasInSpan[fIdx]) { hasFormula = true; break; }
      }
      if (hasFormula) {
        for (var mc = minCol; mc <= maxCol; mc++) {
          sheet.getRange(row, mc + 1).setValue(rowValues[mc]);
        }
        rowWriteMode = 'per_cell';
      } else {
        sheet.getRange(row, minCol + 1, 1, span).setValues([rowValues.slice(minCol, maxCol + 1)]);
        rowWriteMode = 'batched';
      }
    }

    // Replace ingredient list if provided (D-04, D-05, D-06, D-07, D-09)
    var ingredientsUnchanged = null;
    var ingredientsWritten = 0;
    var ingredientRowsDeleted = 0;

    if (payload.ingredients !== undefined) {
      var ingredients;
      try {
        ingredients = typeof payload.ingredients === 'string' ? JSON.parse(payload.ingredients) : payload.ingredients;
      } catch (e) {
        return { ok: false, error: 'invalid_data', message: 'Invalid ingredients JSON' };
      }

      var ingSheet = ss.getSheetByName(RECIPE_INGREDIENTS_SHEET_NAME);

      // One read, three uses (D-04 + D-05 + D-07 all feed off this single getDataRange()
      // read): the delete-scan, the change-comparison, and the max-id computation.
      var ingData = (ingSheet && ingSheet.getLastRow() > 1) ? ingSheet.getDataRange().getValues() : [];
      var ingHeadersRow = ingData.length ? ingData[0] : [];
      var idCol = ingHeadersRow.indexOf('ingredient_id');
      var ridCol = ingHeadersRow.indexOf('recipe_id');
      var itemCol = ingHeadersRow.indexOf('item_id');
      var qtyCol = ingHeadersRow.indexOf('quantity');
      var unitCol = ingHeadersRow.indexOf('unit');
      // D-15 fixed column-order fallback when a header is missing or the sheet is empty --
      // the insert path already writes positionally, so this stays consistent with disk.
      if (idCol === -1) idCol = 0;
      if (ridCol === -1) ridCol = 1;
      if (itemCol === -1) itemCol = 2;
      if (qtyCol === -1) qtyCol = 4;
      if (unitCol === -1) unitCol = 5;

      // Build the stored side: this recipe's existing rows, their sheet row numbers, their
      // ingredient_ids and their comparison keys. Stored values are NOT re-sanitized -- they
      // were already sanitized when written, and re-running sanitizeInput would compare a
      // doubly-processed stored value against a singly-processed incoming one.
      var storedRows = [];
      var storedKeys = [];
      var storedIdSet = {};
      for (var si = 1; si < ingData.length; si++) {
        if (String(ingData[si][ridCol]) === String(payload.recipe_id)) {
          var storedIngId = String(ingData[si][idCol] || '').trim();
          storedRows.push({ sheetRow: si + 1, ingredientId: storedIngId });
          storedKeys.push(normalizeRecipeIngredientTuple(ingData[si][itemCol], ingData[si][qtyCol], ingData[si][unitCol]));
          if (storedIngId) storedIdSet[storedIngId] = true;
        }
      }

      // Build the incoming side from the exact values that would be written, so the
      // comparison key is derived from SANITIZED values on both sides (like-for-like).
      var incoming = [];
      var incomingKeys = [];
      for (var ii = 0; ii < ingredients.length; ii++) {
        var rawIng = ingredients[ii];
        var itemId = sanitizeInput(rawIng.item_id || '');
        var itemName = sanitizeInput(rawIng.item_name || '');
        var quantity = rawIng.quantity !== undefined ? Number(rawIng.quantity) : 0;
        var unit = sanitizeInput(rawIng.unit || '');
        var incomingIngId = String(rawIng.ingredient_id || '').trim();
        incoming.push({ itemId: itemId, itemName: itemName, quantity: quantity, unit: unit, ingredientId: incomingIngId });
        incomingKeys.push(normalizeRecipeIngredientTuple(itemId, quantity, unit));
      }

      // D-04: skip the delete+insert entirely when the tuples match. Accepted consequence:
      // the tuple is (item_id, quantity, unit) per D-15 -- a payload differing ONLY in
      // item_name will not refresh the stored item_name. Benign (item_name is a display
      // denormalization resolved from the Zoho catalog by item_id) but a real behaviour
      // change, written down here rather than discovered later.
      ingredientsUnchanged = recipeIngredientsUnchanged(incomingKeys, storedKeys);

      if (!ingredientsUnchanged) {
        // D-05: hoist id minting -- compute the max ONCE from the pre-delete snapshot (so
        // ids of rows about to be deleted are still counted and never reused), then
        // increment in memory. The full-column-scan id helper is never invoked from inside
        // updateRecipe -- that removes the 13 full-column scans this fix exists to eliminate.
        var maxIdNum = maxIdNumFromColumn(ingData.slice(1), idCol, 'RI-');

        // D-09: honour an incoming ingredient_id ONLY if it already belongs to THIS
        // recipe's stored rows and has not already been claimed by an earlier row in this
        // same payload. A foreign recipe's id, an invented id, or a duplicate within the
        // payload is NEVER honoured -- without this guard a client could pin a foreign
        // recipe's ingredient id onto this recipe, or duplicate one, producing colliding
        // primary keys in a sheet with no uniqueness constraint.
        var claimedIds = {};
        var rows = [];
        for (var ci = 0; ci < incoming.length; ci++) {
          var item = incoming[ci];
          var finalId;
          if (item.ingredientId && storedIdSet[item.ingredientId] && !claimedIds[item.ingredientId]) {
            finalId = item.ingredientId;
          } else {
            finalId = formatPaddedId('RI-', ++maxIdNum, 6);
          }
          claimedIds[finalId] = true;
          rows.push([finalId, payload.recipe_id, item.itemId, item.itemName, item.quantity, item.unit]);
        }

        // D-07: collapse the matched sheet rows into maximal contiguous runs and issue one
        // deleteRows(start, count) per run, in DESCENDING start-row order so earlier runs'
        // positions stay valid after later ones are removed. Recipe ingredient rows are
        // appended together, so this typically collapses to a single call.
        if (ingSheet && storedRows.length > 0) {
          var sheetRowNums = storedRows.map(function (r) { return r.sheetRow; }).sort(function (a, b) { return a - b; });
          var runs = [];
          var runStart = sheetRowNums[0];
          var runEnd = sheetRowNums[0];
          for (var ri = 1; ri < sheetRowNums.length; ri++) {
            if (sheetRowNums[ri] === runEnd + 1) {
              runEnd = sheetRowNums[ri];
            } else {
              runs.push([runStart, runEnd]);
              runStart = sheetRowNums[ri];
              runEnd = sheetRowNums[ri];
            }
          }
          runs.push([runStart, runEnd]);
          for (var rj = runs.length - 1; rj >= 0; rj--) {
            var runCount = runs[rj][1] - runs[rj][0] + 1;
            ingSheet.deleteRows(runs[rj][0], runCount);
            ingredientRowsDeleted += runCount;
          }
        }

        // D-06: batch the insert -- one setValues() instead of one appendRow() per
        // ingredient. Skip entirely when there are zero rows (a legitimate "all ingredients
        // removed" save -- the deletes above already handled it).
        if (ingSheet && rows.length > 0) {
          var startRow = ingSheet.getLastRow() + 1;
          // getRange() beyond getMaxRows() THROWS -- grow the grid first if needed, or this
          // optimisation turns into a hard save failure on a tightly-sized sheet.
          var needed = (startRow + rows.length - 1) - ingSheet.getMaxRows();
          if (needed > 0) ingSheet.insertRowsAfter(ingSheet.getMaxRows(), needed);
          ingSheet.getRange(startRow, 1, rows.length, 6).setValues(rows);
          ingredientsWritten = rows.length;
        }

        invalidateSheetCache(RECIPE_INGREDIENTS_SHEET_NAME);
      }
    }

    invalidateSheetCache(RECIPES_SHEET_NAME);

    // These diagnostic fields are dropped by the middleware (it returns a bare {ok:true} at
    // zoho-middleware/routes/recipes.js:665) -- they exist for the direct-to-Apps-Script
    // probe in 79-04, which is what makes the D-04 skip branch OBSERVABLE rather than
    // inferred.
    return {
      ok: true,
      message: 'Recipe updated',
      ingredients_unchanged: ingredientsUnchanged,
      ingredients_written: ingredientsWritten,
      ingredient_rows_deleted: ingredientRowsDeleted,
      row_write_mode: rowWriteMode
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * POST: Delete a recipe.
 * Per D-07: soft-deactivates (status=inactive) if any batch references the recipe.
 * Hard-deletes (removes rows) if no batch references exist.
 * @param {Object} payload - recipe_id required
 * @param {string} userEmail - Authenticated staff email
 */
function deleteRecipe(payload, userEmail) {
  if (!payload.recipe_id) {
    return { ok: false, error: 'missing_id', message: 'recipe_id is required' };
  }

  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(RECIPES_SHEET_NAME, payload.recipe_id);
    if (result.row === -1) {
      return { ok: false, error: 'not_found', message: 'Recipe not found: ' + payload.recipe_id };
    }

    // Check if any batch references this recipe
    var batches = sheetToObjects(BATCHES_SHEET_NAME);
    var hasReferences = batches.some(function (b) {
      return String(b.recipe_id || '') === String(payload.recipe_id);
    });

    if (hasReferences) {
      // Soft-deactivate: set status to inactive
      var headers = result.headers;
      var sheet = result.sheet;
      var row = result.row;
      var now = new Date().toISOString();

      var statusCol = headers.indexOf('status');
      if (statusCol !== -1) sheet.getRange(row, statusCol + 1).setValue('inactive');

      var luCol = headers.indexOf('updated_at');
      if (luCol !== -1) sheet.getRange(row, luCol + 1).setValue(now);

      invalidateSheetCache(RECIPES_SHEET_NAME);

      return { ok: true, message: 'Recipe deactivated (has batch references)', deactivated: true };
    }

    // Hard delete: remove ingredient rows first, then the recipe row
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ingSheet = ss.getSheetByName(RECIPE_INGREDIENTS_SHEET_NAME);

    if (ingSheet && ingSheet.getLastRow() > 1) {
      var ingData = ingSheet.getDataRange().getValues();
      var ingHeaders = ingData[0];
      var ridCol = ingHeaders.indexOf('recipe_id');
      var rowsToDelete = [];
      for (var i = 1; i < ingData.length; i++) {
        if (String(ingData[i][ridCol]) === String(payload.recipe_id)) {
          rowsToDelete.push(i + 1);
        }
      }
      for (var j = rowsToDelete.length - 1; j >= 0; j--) {
        ingSheet.deleteRow(rowsToDelete[j]);
      }
    }

    result.sheet.deleteRow(result.row);

    invalidateSheetCache(RECIPES_SHEET_NAME);
    invalidateSheetCache(RECIPE_INGREDIENTS_SHEET_NAME);

    return { ok: true, message: 'Recipe deleted', deleted: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run manually from Apps Script editor to create Recipes and RecipeIngredients tabs.
 * Safe to re-run — skips tabs that already exist.
 */
function setupRecipeTabs() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Recipes tab
  var recipesSheet = ss.getSheetByName(RECIPES_SHEET_NAME);
  if (!recipesSheet) {
    recipesSheet = ss.insertSheet(RECIPES_SHEET_NAME);
    recipesSheet.appendRow([
      'recipe_id', 'name', 'style', 'description', 'status',
      'locked_price', 'service_fee', 'materials_fee',
      'batch_size_l', 'abv', 'ibu', 'colour_srm',
      'notes', 'created_at', 'created_by', 'updated_at',
      'pricing_mode'
    ]);
    recipesSheet.getRange(1, 1, 1, 17).setFontWeight('bold');
    recipesSheet.setFrozenRows(1);
    Logger.log('Created Recipes tab with 17 columns');
  } else {
    Logger.log('Recipes tab already exists — skipped');
  }

  // RecipeIngredients tab
  var ingSheet = ss.getSheetByName(RECIPE_INGREDIENTS_SHEET_NAME);
  if (!ingSheet) {
    ingSheet = ss.insertSheet(RECIPE_INGREDIENTS_SHEET_NAME);
    ingSheet.appendRow([
      'ingredient_id', 'recipe_id', 'item_id', 'item_name', 'quantity', 'unit'
    ]);
    ingSheet.getRange(1, 1, 1, 6).setFontWeight('bold');
    ingSheet.setFrozenRows(1);
    Logger.log('Created RecipeIngredients tab with 6 columns');
  } else {
    Logger.log('RecipeIngredients tab already exists — skipped');
  }

  // Add recipe_id and recipe_snapshot columns to Batches tab (if not present)
  var batchesSheet = ss.getSheetByName(BATCHES_SHEET_NAME);
  if (batchesSheet) {
    var bHeaders = batchesSheet.getRange(1, 1, 1, batchesSheet.getLastColumn()).getValues()[0];
    if (bHeaders.indexOf('recipe_id') === -1) {
      var nextCol = batchesSheet.getLastColumn() + 1;
      batchesSheet.getRange(1, nextCol).setValue('recipe_id');
      batchesSheet.getRange(1, nextCol).setFontWeight('bold');
      Logger.log('Added recipe_id column to Batches tab at column ' + nextCol);
    } else {
      Logger.log('recipe_id column already exists in Batches tab');
    }
    if (bHeaders.indexOf('recipe_snapshot') === -1) {
      var snapCol = batchesSheet.getLastColumn() + 1;
      batchesSheet.getRange(1, snapCol).setValue('recipe_snapshot');
      batchesSheet.getRange(1, snapCol).setFontWeight('bold');
      Logger.log('Added recipe_snapshot column to Batches tab at column ' + snapCol);
    } else {
      Logger.log('recipe_snapshot column already exists in Batches tab');
    }
  }

  Logger.log('Recipe tab setup complete');
}

/**
 * Run manually from Apps Script editor to create the GiftCardTransactions ledger tab.
 * Safe to re-run — skips creation if the tab already exists, and reports any missing required
 * columns on a pre-existing tab with drifted headers (D-10, D-12).
 */
function setupGiftCardLedger() {
  var result = ensureGiftCardLedgerSheet();
  if (result.ok) {
    Logger.log('GiftCardTransactions tab ready (12 columns).');
  } else {
    Logger.log('GiftCardTransactions tab is missing required columns: ' + result.missing.join(', '));
  }
}

// ─── Gift Card Ledger — pure decision helpers (Phase 51, D-12) ──────────────
// These four helpers are strictly pure: no SpreadsheetApp, LockService, Session,
// CacheService or Logger reference anywhere in their bodies, and no reliance on
// module-level mutable state (in particular not _sheetCache). This is enforced by
// tests/frontend/adminapi-giftcard-ledger.test.js's source-slice purity assertion,
// not merely requested — it is what keeps them unit-testable outside Google's
// runtime as this file evolves.

/**
 * Trim + uppercase a gift-card certificate number for comparison. '' for null/undefined.
 * @param {*} value
 * @returns {string}
 */
function normalizeCertNumber(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

/**
 * Round a money amount to 2 decimal places, absorbing float drift (0.1 + 0.2 -> 0.3).
 * @param {number} number
 * @returns {number}
 */
function roundGiftCardAmount(number) {
  return Math.round(number * 100) / 100;
}

/**
 * Interpret a GiftCardTransactions cell value as a boolean flag. Sheets can hand back a real
 * boolean, a string ('TRUE'/'true'/'yes'/'y'/'1'), or a number (1) depending on how the cell was
 * written/edited by staff — this normalizes all of them.
 * @param {*} cellValue
 * @returns {boolean}
 */
function ledgerFlagTrue(cellValue) {
  if (cellValue === true) return true;
  if (cellValue === 1) return true;
  if (typeof cellValue === 'string') {
    var v = cellValue.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === 'y' || v === '1';
  }
  return false;
}

/**
 * The D-12 idempotency decision. Takes the GiftCardTransactions rows as its FIRST parameter —
 * it never reads the sheet itself; the caller (51-02) is responsible for the read.
 *
 * Priority order (see 51-CONTEXT.md D-12 and 51-01-PLAN.md <behavior> for the full rationale):
 *   1. a settled row matching cert+ref                              -> 'replay'
 *   2. any OTHER row matching cert+ref whose status isn't 'claimed' -> 'replay' (consumed-ref rule)
 *   3. a claimed row matching cert+ref                              -> 'blocked' (balance may or
 *      may not have moved yet — fail closed rather than report a possibly-wrong balance)
 *   4. any claimed row for the cert with a DIFFERENT ref            -> 'blocked' (the D-12 case:
 *      a client-side retry re-mints a fresh ref, so a ref-keyed guard alone would say 'proceed')
 *   5. otherwise                                                    -> 'proceed'
 *
 * `unsettled` is populated from the any-claimed-row observation regardless of which action is
 * returned, so the caller can see the cert is dirty even on a read-only 'replay' result.
 *
 * @param {Array<Object>} rows - GiftCardTransactions rows, shaped like sheetToObjects() output
 * @param {string} certNumber
 * @param {string} txRef
 * @returns {{action: string, row: (Object|null), unsettled: boolean}}
 */
function giftCardLedgerDecision(rows, certNumber, txRef) {
  var normCert = normalizeCertNumber(certNumber);
  var refStr = String(txRef);

  var settledSameRefMatch = null;
  var sameRefMatch = null;
  var firstClaimedRow = null;
  var anyClaimedRowExists = false;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (normalizeCertNumber(row.cert_number) !== normCert) continue;

    // Blocking (and the "is this row claimed" observation generally) requires an EXACT
    // 'claimed' match after trim+lowercase. This is intentionally forgiving by design: a staff
    // member who types anything else into the status cell clears a stuck claim with no code
    // change or redeploy (D-12's "there must be a way for staff to clear a stuck claim";
    // see docs/APPS_SCRIPT.md for the runbook).
    var status = String(row.status || '').trim().toLowerCase();
    var isClaimed = status === 'claimed';

    if (isClaimed) {
      anyClaimedRowExists = true;
      if (!firstClaimedRow) firstClaimedRow = row;
    }

    if (String(row.tx_ref) === refStr) {
      if (!sameRefMatch) sameRefMatch = row;
      if (status === 'settled' && !settledSameRefMatch) settledSameRefMatch = row;
    }
  }

  if (settledSameRefMatch) {
    return { action: 'replay', row: settledSameRefMatch, unsettled: anyClaimedRowExists };
  }

  if (sameRefMatch) {
    var sameRefStatus = String(sameRefMatch.status || '').trim().toLowerCase();
    if (sameRefStatus !== 'claimed') {
      // Consumed-ref rule: this exact tx_ref has already appeared in the ledger, so the balance
      // may already have moved under it — regardless of what the row's status has since been
      // edited to. Do NOT make this forgiving like the claimed-status check above: the two rules
      // pull in opposite directions on purpose. The escape hatch (editing status away from
      // 'claimed') frees the CARD for new attempts but must never un-protect the exact ref it
      // just rescued, or a resubmission of that ref would move money a second time — reopening
      // this phase's own defect immediately after its sanctioned remedy is used. Deleting the
      // row is the only full reset.
      return { action: 'replay', row: sameRefMatch, unsettled: anyClaimedRowExists };
    }
    return { action: 'blocked', row: sameRefMatch, unsettled: anyClaimedRowExists };
  }

  if (firstClaimedRow) {
    return { action: 'blocked', row: firstClaimedRow, unsettled: anyClaimedRowExists };
  }

  return { action: 'proceed', row: null, unsettled: anyClaimedRowExists };
}

// ─── Gift Card Ledger — IO helpers (Phase 51, D-10) ─────────────────────────
// These DO touch SpreadsheetApp; not unit-testable outside Google's runtime — only asserted by
// source shape in tests/frontend/adminapi-giftcard-ledger.test.js. The 51-03 live probe is the
// only thing that verifies a Sheets write actually behaves as documented here.

/**
 * Self-healing AND fail-closed, and that combination is the point: if the GiftCardTransactions
 * tab is absent, create it inline (so a forgotten setupGiftCardLedger() run can never brick
 * redemption) with the exact 12-column header row, bolded and frozen — the setupRecipeTabs()
 * shape verbatim. If the tab exists but ANY required column is missing (drifted headers), return
 * ledger_unavailable rather than repair headers or fall back to a positional write — money must
 * not move when the ledger cannot record it (T-51-01-02).
 * @returns {{ok: true, sheet: Object, headers: Array<string>, col: Object}
 *          |{ok: false, error: string, missing: Array<string>}}
 */
function ensureGiftCardLedgerSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(GIFT_CARD_TRANSACTIONS_SHEET_NAME);

  var headerNames = [
    'tx_id', 'cert_number', 'tx_ref', 'kind', 'amount', 'balance_before',
    'balance_after', 'status', 'needs_manual_review', 'created_at', 'settled_at', 'notes'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
    sheet.appendRow(headerNames);
    sheet.getRange(1, 1, 1, headerNames.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Created GiftCardTransactions tab with ' + headerNames.length + ' columns');
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  var missing = [];
  for (var i = 0; i < headerNames.length; i++) {
    var name = headerNames[i];
    var idx = headers.indexOf(name) + 1;
    col[name] = idx;
    if (idx === 0) missing.push(name);
  }

  if (missing.length > 0) {
    return { ok: false, error: 'ledger_unavailable', missing: missing };
  }

  return { ok: true, sheet: sheet, headers: headers, col: col };
}

/**
 * Append a CLAIM row before the balance changes (D-02's claim-before-mutate ordering). Uses
 * Utilities.getUuid() for tx_id rather than generateNextId — that helper scans the whole of
 * column A on every call, an acceptable cost for the low-write-rate VesselHistory/Recipes tabs
 * but not for a ledger that grows on every redeem and every reload (Phase 79's O(n)-scan finding).
 * @param {Object} ledger - the {sheet, col} result from ensureGiftCardLedgerSheet()
 * @param {string} certNumber
 * @param {string} txRef
 * @param {string} kind - 'redeem' | 'reload'
 * @param {number} amount
 * @param {number} balanceBefore
 * @returns {{ok: true, tx_id: string, row: number}|{ok: false, error: string}}
 */
function appendGiftCardClaim(ledger, certNumber, txRef, kind, amount, balanceBefore) {
  var txId = Utilities.getUuid();
  var now = new Date().toISOString();

  ledger.sheet.appendRow([
    txId,
    normalizeCertNumber(certNumber),
    String(txRef),
    kind,
    roundGiftCardAmount(amount),
    roundGiftCardAmount(balanceBefore),
    '',
    'claimed',
    false,
    now,
    '',
    ''
  ]);

  // Safe to read back via getLastRow() because every writer of this tab holds the script lock
  // and no other function in this file writes GiftCardTransactions — a future editor must
  // preserve that invariant or this read-back becomes unsafe.
  var rowIndex = ledger.sheet.getLastRow();
  var writtenTxId = ledger.sheet.getRange(rowIndex, ledger.col.tx_id).getValue();
  if (String(writtenTxId) !== txId) {
    return { ok: false, error: 'claim_write_failed' };
  }

  invalidateSheetCache(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
  return { ok: true, tx_id: txId, row: rowIndex };
}

/**
 * Mark a claim row SETTLED after the balance write succeeds. Re-verifies the tx_id cell of `row`
 * still matches `txId` before writing anything, so a settle call can never corrupt a row that a
 * concurrent process has since overwritten.
 * @param {Object} ledger
 * @param {Object} row - a row object carrying `_row` (from sheetToObjects / appendGiftCardClaim)
 * @param {string} txId
 * @param {number} balanceAfter
 * @returns {boolean}
 */
function settleGiftCardClaim(ledger, row, txId, balanceAfter) {
  var currentTxId = ledger.sheet.getRange(row._row, ledger.col.tx_id).getValue();
  if (String(currentTxId) !== String(txId)) return false;

  var now = new Date().toISOString();
  ledger.sheet.getRange(row._row, ledger.col.balance_after).setValue(roundGiftCardAmount(balanceAfter));
  ledger.sheet.getRange(row._row, ledger.col.status).setValue('settled');
  ledger.sheet.getRange(row._row, ledger.col.settled_at).setValue(now);

  invalidateSheetCache(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
  return true;
}

/**
 * Durably persist needs_manual_review on the claim row (D-08 — today this flag only ever exists
 * as a middleware response field and a Redis sentinel, never a sheet write). Leaves `status`
 * as-is so the row keeps blocking per giftCardLedgerDecision's D-12 rules.
 * @param {Object} ledger
 * @param {Object} row
 * @param {string} noteText
 * @returns {boolean}
 */
function flagGiftCardClaim(ledger, row, noteText) {
  ledger.sheet.getRange(row._row, ledger.col.needs_manual_review).setValue(true);
  ledger.sheet.getRange(row._row, ledger.col.notes).setValue(sanitizeInput(noteText || ''));

  invalidateSheetCache(GIFT_CARD_TRANSACTIONS_SHEET_NAME);
  return true;
}

// ─── Gift Card Lifecycle (Phase 44) ─────────────────────────────────────────
// Balance-of-record lives in the GiftCards Google Sheets tab.
// All balance-modifying handlers acquire LockService to prevent double-spend
// under concurrent HTTP requests (T-44-04 mitigation, D-05).
// Column indices are resolved at runtime by reading the header row so they
// remain correct if columns are ever reordered (RESEARCH [ASSUMED] note).

/**
 * Issue a new gift certificate.
 * Rejects duplicate cert_number (D-02); sets current_balance = face_value.
 * Uses acquireScriptLock to prevent concurrent duplicate insertions.
 * @param {Object} payload - { cert_number, face_value, issued_by?, notes? }
 */
function issueGiftCard(payload) {
  var certNum = sanitizeInput(String(payload.cert_number || '').trim().toUpperCase());
  var faceValue = parseFloat(payload.face_value);
  var issuedBy = sanitizeInput(payload.issued_by || 'kiosk');
  var notes = sanitizeInput(payload.notes || '');

  if (!certNum || isNaN(faceValue) || faceValue <= 0) {
    return { ok: false, error: 'missing_fields' };
  }

  var lock = acquireScriptLock(15000);
  try {
    // D-02: reject duplicate cert_number
    var existing = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (existing.row !== -1) {
      return { ok: false, error: 'duplicate' };
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    if (!sheet) return { ok: false, error: 'sheet_not_found' };

    var now = new Date().toISOString();
    var today = now.slice(0, 10);

    // 10-column schema (R-02): cert_number | face_value | current_balance | status | issued_date
    //   | issued_by | zoho_invoice_number | notes | last_updated | last_tx_ref
    sheet.appendRow([
      certNum,
      faceValue,
      faceValue,   // current_balance starts equal to face_value
      'active',
      today,
      issuedBy,
      '',          // zoho_invoice_number — set later via update_gift_card_invoice
      notes,
      now,
      ''           // last_tx_ref — empty at issue
    ]);

    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true, cert_number: certNum, face_value: faceValue, current_balance: faceValue };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Look up a gift certificate balance and status.
 * No lock needed — read-only (D-05: server-authoritative, never client-supplied).
 * @param {Object} payload - { cert_number }
 */
function lookupGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  if (!certNum) return { ok: false, error: 'missing_fields' };

  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) {
    return { ok: false, error: 'not_found' };
  }

  var gc = result.data;
  return {
    ok: true,
    data: {
      cert_number: gc.cert_number,
      current_balance: parseFloat(gc.current_balance) || 0,
      face_value: parseFloat(gc.face_value) || 0,
      status: gc.status,
      zoho_invoice_number: gc.zoho_invoice_number,
      issued_date: gc.issued_date,
      issued_by: gc.issued_by,
      last_updated: gc.last_updated
    }
  };
}

/**
 * Atomically decrement a gift certificate balance (partial redemption supported).
 *
 * Phase 51 (D-02/D-12) rewrite: the idempotency guard now reads the GiftCardTransactions LEDGER,
 * not the GiftCards row's last_tx_ref cell. A durable CLAIM row is appended BEFORE the balance
 * setValue() and marked SETTLED after it succeeds — money never moves without a record, and a
 * crash between the two leaves a claimed row that fails the next attempt closed rather than
 * silently decrementing twice (H6). D-12: blocking is keyed on the existence of an unsettled
 * claim for the CERTIFICATE, not on transaction_ref equality — kiosk-core.js:2486-2493 clears
 * _kioskPaymentKey on every terminal outcome including errors, so a crash-then-retry arrives with
 * a freshly minted ref that a ref-keyed guard alone would wave through.
 *
 * Failure-mode intent:
 *   - Crash between the claim append and the balance write: claim exists, balance unchanged.
 *     Next attempt is BLOCKED. Safe — the customer's balance is intact, a human resolves it.
 *   - Crash between the balance write and settle: claim exists, balance already moved. Next
 *     attempt is BLOCKED. This is precisely the window that produced the double-debit; closed.
 *   - An unsettled claim otherwise exists only for the ~1s of a normal write. Blocking a second
 *     redemption in that window is the correct fail-closed behaviour on a money path (D-12's
 *     accepted false-positive profile).
 *
 * T-44-04: acquireScriptLock still guards CONCURRENT double-spend (D-06: it does not, by itself,
 * solve the single-interrupted-execution crash window — that is what the ledger claim is for).
 * T-44-06: amount must be ≤ current_balance (float tolerance ±0.001).
 * @param {Object} payload - { cert_number, amount, transaction_ref }
 */
function redeemGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var amount = parseFloat(payload.amount);
  var txRef = String(payload.transaction_ref || '');

  if (!certNum || isNaN(amount) || amount <= 0 || !txRef) {
    return { ok: false, error: 'missing_fields' };
  }

  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };

    var gc = result.data;

    var ledger = ensureGiftCardLedgerSheet();
    if (!ledger.ok) {
      // Money must never move without a record — fail closed before any balance write.
      return { ok: false, error: 'ledger_unavailable', needs_manual_review: true };
    }

    var decision = giftCardLedgerDecision(sheetToObjects(GIFT_CARD_TRANSACTIONS_SHEET_NAME), certNum, txRef);

    if (decision.action === 'replay') {
      return {
        ok: true,
        idempotent: true,
        new_balance: parseFloat(gc.current_balance) || 0,
        status: gc.status,
        needs_manual_review: decision.unsettled
      };
    }

    if (decision.action === 'blocked') {
      flagGiftCardClaim(ledger, decision.row, 'Blocked duplicate redeem attempt: incoming tx_ref=' + txRef + ', amount=' + amount);
      return {
        ok: false,
        error: 'unsettled_claim',
        needs_manual_review: true,
        claim_tx_id: decision.row.tx_id,
        claim_tx_ref: decision.row.tx_ref,
        claim_created_at: decision.row.created_at
      };
    }

    if (String(gc.status) !== 'active') {
      return { ok: false, error: 'invalid_status', status: gc.status };
    }

    var balance = parseFloat(gc.current_balance) || 0;
    if (amount > balance + 0.001) {
      return { ok: false, error: 'insufficient_balance', balance: balance };
    }

    var newBalance = Math.round((balance - amount) * 100) / 100;
    var newStatus = newBalance <= 0 ? 'depleted' : 'active';
    var now = new Date().toISOString();

    var claim = appendGiftCardClaim(ledger, certNum, txRef, 'redeem', amount, balance);
    if (!claim.ok) {
      return { ok: false, error: 'claim_write_failed', needs_manual_review: true };
    }
    // appendGiftCardClaim returns a plain row-index number in `row`, not a sheetToObjects-shaped
    // object — settleGiftCardClaim/flagGiftCardClaim both index via `row._row`. Wrap it once here
    // so both later calls reference the same claim row consistently.
    var claimRowRef = { _row: claim.row };

    // Resolve column indices from header row at runtime (not hardcoded positionally)
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var balCol = headers.indexOf('current_balance') + 1;
    var statusCol = headers.indexOf('status') + 1;
    var updatedCol = headers.indexOf('last_updated') + 1;
    var txRefCol = headers.indexOf('last_tx_ref') + 1;

    try {
      sheet.getRange(result.row, balCol).setValue(newBalance);
      sheet.getRange(result.row, statusCol).setValue(newStatus);
      sheet.getRange(result.row, updatedCol).setValue(now);
      sheet.getRange(result.row, txRefCol).setValue(txRef);
    } catch (writeErr) {
      flagGiftCardClaim(ledger, claimRowRef, 'balance write failed: ' + writeErr.message);
      return { ok: false, error: 'write_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
    }

    // Do not let a settleGiftCardClaim exception propagate out of this function uncaught: the
    // balance has already changed by this point, so an uncaught throw would surface as a generic
    // Apps Script error and lose the durable needs_manual_review signal criterion 2 requires. The
    // ledger row stays 'claimed' either way, so the next attempt is still BLOCKED — money safety
    // holds regardless — but the operator-facing signal must not be dropped in this narrow window.
    try {
      var settled = settleGiftCardClaim(ledger, claimRowRef, claim.tx_id, newBalance);
      if (!settled) {
        flagGiftCardClaim(ledger, claimRowRef, 'settle failed: tx_id mismatch on claim row');
        return { ok: false, error: 'settle_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
      }
    } catch (settleErr) {
      flagGiftCardClaim(ledger, claimRowRef, 'settle threw: ' + settleErr.message);
      return { ok: false, error: 'settle_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
    }

    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true, new_balance: newBalance, status: newStatus, tx_id: claim.tx_id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Atomically increment a gift certificate balance (reload / top-up).
 * Restores status to 'active' if previously 'depleted'.
 * Cannot reload a voided certificate.
 *
 * Phase 51 (D-02/D-07/D-12) rewrite: mirrors redeemGiftCard's claim-before-mutate structure
 * exactly, so the two stay reviewable side by side. This matters as much here as on redeem — the
 * crash window this closes produces a duplicate CREDIT (the store gives away money for free),
 * which is audit H7 and ROADMAP criterion 1.
 *
 * IMPORTANT: reloadGiftCard had NO idempotency guard of any kind before this phase. It only ever
 * WROTE the last_tx_ref cell, never read it back — unlike redeemGiftCard's now-removed
 * ref-comparison guard against that same cell. Every prior duplicate reload attempt credited the
 * balance again with no guard whatsoever. The ledger decision below gives reload its first real
 * idempotency guard.
 *
 * Note: decision [44-05]'s ordering (the MIDDLEWARE credits the balance before the Zoho invoice/
 * payment, deliberately, to protect customer value) is untouched by this task — that ordering is
 * between the middleware's own steps. This task changes only how the credit is recorded inside
 * Apps Script, once the middleware has decided to call this function.
 *
 * @param {Object} payload - { cert_number, amount, transaction_ref }
 */
function reloadGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var amount = parseFloat(payload.amount);
  var txRef = String(payload.transaction_ref || '');

  if (!certNum || isNaN(amount) || amount <= 0 || !txRef) {
    return { ok: false, error: 'missing_fields' };
  }

  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };

    var gc = result.data;

    var ledger = ensureGiftCardLedgerSheet();
    if (!ledger.ok) {
      // Money must never move without a record — fail closed before any balance write.
      return { ok: false, error: 'ledger_unavailable', needs_manual_review: true };
    }

    var decision = giftCardLedgerDecision(sheetToObjects(GIFT_CARD_TRANSACTIONS_SHEET_NAME), certNum, txRef);

    if (decision.action === 'replay') {
      return {
        ok: true,
        idempotent: true,
        new_balance: parseFloat(gc.current_balance) || 0,
        status: gc.status,
        needs_manual_review: decision.unsettled
      };
    }

    if (decision.action === 'blocked') {
      flagGiftCardClaim(ledger, decision.row, 'Blocked duplicate reload attempt: incoming tx_ref=' + txRef + ', amount=' + amount);
      return {
        ok: false,
        error: 'unsettled_claim',
        needs_manual_review: true,
        claim_tx_id: decision.row.tx_id,
        claim_tx_ref: decision.row.tx_ref,
        claim_created_at: decision.row.created_at
      };
    }

    // Cannot reload a voided certificate
    if (String(gc.status) === 'void') {
      return { ok: false, error: 'invalid_status', status: gc.status };
    }

    var balance = parseFloat(gc.current_balance) || 0;
    var newBalance = Math.round((balance + amount) * 100) / 100;
    var now = new Date().toISOString();

    var claim = appendGiftCardClaim(ledger, certNum, txRef, 'reload', amount, balance);
    if (!claim.ok) {
      return { ok: false, error: 'claim_write_failed', needs_manual_review: true };
    }
    // appendGiftCardClaim returns a plain row-index number in `row`, not a sheetToObjects-shaped
    // object — settleGiftCardClaim/flagGiftCardClaim both index via `row._row`. Wrap it once here
    // so both later calls reference the same claim row consistently.
    var claimRowRef = { _row: claim.row };

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var balCol = headers.indexOf('current_balance') + 1;
    var statusCol = headers.indexOf('status') + 1;
    var updatedCol = headers.indexOf('last_updated') + 1;
    var txRefCol = headers.indexOf('last_tx_ref') + 1;

    try {
      sheet.getRange(result.row, balCol).setValue(newBalance);
      sheet.getRange(result.row, statusCol).setValue('active');  // restore if depleted
      sheet.getRange(result.row, updatedCol).setValue(now);
      sheet.getRange(result.row, txRefCol).setValue(txRef);
    } catch (writeErr) {
      flagGiftCardClaim(ledger, claimRowRef, 'balance write failed: ' + writeErr.message);
      return { ok: false, error: 'write_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
    }

    // Do not let a settleGiftCardClaim exception propagate out of this function uncaught: the
    // balance has already changed by this point, so an uncaught throw would surface as a generic
    // Apps Script error and lose the durable needs_manual_review signal criterion 2 requires. The
    // ledger row stays 'claimed' either way, so the next attempt is still BLOCKED — money safety
    // holds regardless — but the operator-facing signal must not be dropped in this narrow window.
    try {
      var settled = settleGiftCardClaim(ledger, claimRowRef, claim.tx_id, newBalance);
      if (!settled) {
        flagGiftCardClaim(ledger, claimRowRef, 'settle failed: tx_id mismatch on claim row');
        return { ok: false, error: 'settle_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
      }
    } catch (settleErr) {
      flagGiftCardClaim(ledger, claimRowRef, 'settle threw: ' + settleErr.message);
      return { ok: false, error: 'settle_failed', needs_manual_review: true, claim_tx_id: claim.tx_id };
    }

    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true, new_balance: newBalance, status: 'active', tx_id: claim.tx_id };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Void a gift certificate (sets status to 'void').
 * Only 'active' or 'depleted' certificates may be voided (T-44-07).
 * Records reason in the notes column.
 * @param {Object} payload - { cert_number, reason? }
 */
function voidGiftCard(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var reason = sanitizeInput(payload.reason || '');

  if (!certNum) return { ok: false, error: 'missing_fields' };

  var lock = acquireScriptLock(15000);
  try {
    var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
    if (result.row === -1) return { ok: false, error: 'not_found' };

    var gc = result.data;
    var currentStatus = String(gc.status);

    // Only allow void from 'active' or 'depleted' (not already 'void')
    if (currentStatus !== 'active' && currentStatus !== 'depleted') {
      return { ok: false, error: 'invalid_status', status: currentStatus };
    }

    var now = new Date().toISOString();
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var statusCol = headers.indexOf('status') + 1;
    var notesCol = headers.indexOf('notes') + 1;
    var updatedCol = headers.indexOf('last_updated') + 1;

    sheet.getRange(result.row, statusCol).setValue('void');
    if (reason && notesCol > 0) {
      sheet.getRange(result.row, notesCol).setValue(reason);
    }
    sheet.getRange(result.row, updatedCol).setValue(now);

    invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
    return { ok: true, status: 'void' };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Write the Zoho invoice number to a gift certificate row after the sale invoice is created.
 * Called as the final step of the issue flow (after zohoPost('/invoices') succeeds).
 * @param {Object} payload - { cert_number, zoho_invoice_number }
 */
function updateGiftCardInvoice(payload) {
  var certNum = String(payload.cert_number || '').trim().toUpperCase();
  var invoiceNumber = sanitizeInput(payload.zoho_invoice_number || '');

  if (!certNum || !invoiceNumber) return { ok: false, error: 'missing_fields' };

  var result = findRowById(GIFT_CARDS_SHEET_NAME, certNum);
  if (result.row === -1) return { ok: false, error: 'not_found' };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(GIFT_CARDS_SHEET_NAME);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var invoiceCol = headers.indexOf('zoho_invoice_number') + 1;
  var updatedCol = headers.indexOf('last_updated') + 1;

  if (invoiceCol > 0) sheet.getRange(result.row, invoiceCol).setValue(invoiceNumber);
  if (updatedCol > 0) sheet.getRange(result.row, updatedCol).setValue(new Date().toISOString());

  invalidateSheetCache(GIFT_CARDS_SHEET_NAME);
  return { ok: true };
}

/**
 * Return all gift certificate rows for the admin panel list view (D-06).
 * Staff-auth only (called via doGet with Google OAuth).
 */
function getGiftCards() {
  var cards = sheetToObjects(GIFT_CARDS_SHEET_NAME);
  return cards.map(function(gc) {
    return {
      cert_number: gc.cert_number,
      face_value: parseFloat(gc.face_value) || 0,
      current_balance: parseFloat(gc.current_balance) || 0,
      status: gc.status,
      issued_date: gc.issued_date,
      issued_by: gc.issued_by,
      zoho_invoice_number: gc.zoho_invoice_number,
      notes: gc.notes,
      last_updated: gc.last_updated
    };
  });
}

// ─── Waitlist (Phase 78, D-01) ───────────────────────────────────────────────
// A durable, staff-readable beer waitlist. Mirrors the GiftCardTransactions ledger's
// bootstrap + pure-decision shape (Phase 51), but at the "addReservation" rigor level —
// no LockService, no claim-before-mutate ceremony — because a waitlist signup moves no
// money (RESEARCH.md Pitfall 5, 78-CONTEXT.md D-01's accepted concurrent-write risk).

/**
 * Run manually from the Apps Script editor to create the Waitlist tab. Safe to re-run —
 * skips creation if the tab already exists, and reports any missing required columns on a
 * pre-existing tab with drifted headers.
 */
function setupWaitlist() {
  var result = ensureWaitlistSheet();
  if (result.ok) {
    Logger.log('Waitlist tab ready (7 columns).');
  } else {
    Logger.log('Waitlist tab is missing required columns: ' + result.missing.join(', '));
  }
}

/**
 * Self-healing AND fail-closed (same combination as ensureGiftCardLedgerSheet, Phase 51,
 * D-10): if the Waitlist tab is absent, create it inline with the exact 7-column header row,
 * bolded and frozen. If the tab exists but ANY required column is missing (drifted headers),
 * return waitlist_unavailable rather than repair headers or fall back to a positional write.
 * @returns {{ok: true, sheet: Object, headers: Array<string>, col: Object}
 *          |{ok: false, error: string, missing: Array<string>}}
 */
function ensureWaitlistSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(WAITLIST_SHEET_NAME);

  var headerNames = ['id', 'email', 'category', 'status', 'signed_up_at', 'mailerlite_synced', 'notes'];

  if (!sheet) {
    sheet = ss.insertSheet(WAITLIST_SHEET_NAME);
  }

  // A wholly empty sheet reports getLastColumn() === 0, and getRange(1, 1, 1, 0) throws
  // "The number of columns in the range must be at least 1." That covers both a tab we just
  // inserted and one that already existed but was blank (hand-created, or left by a partial
  // setupWaitlist run). Writing headers here clobbers nothing, so it is NOT the drifted-header
  // case the fail-closed check below guards — that one still refuses to repair.
  if (sheet.getLastColumn() === 0) {
    sheet.appendRow(headerNames);
    sheet.getRange(1, 1, 1, headerNames.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Initialised Waitlist tab with ' + headerNames.length + ' columns');
  }

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  var missing = [];
  for (var i = 0; i < headerNames.length; i++) {
    var name = headerNames[i];
    var idx = headers.indexOf(name) + 1;
    col[name] = idx;
    if (idx === 0) missing.push(name);
  }

  if (missing.length > 0) {
    return { ok: false, error: 'waitlist_unavailable', missing: missing };
  }

  return { ok: true, sheet: sheet, headers: headers, col: col };
}

/**
 * Trim + lowercase an email for comparison, stripping at most ONE leading apostrophe (the
 * formula-injection escape character written by waitlistCellSafe). '' for null/undefined.
 * Mirrors normalizeCertNumber, but lowercases instead of uppercasing — email is
 * case-insensitive and conventionally stored lowercase.
 * @param {*} value
 * @returns {string}
 */
function normalizeWaitlistEmail(value) {
  if (value === null || value === undefined) return '';
  var str = String(value);
  if (str.charAt(0) === "'") str = str.slice(1);
  return str.trim().toLowerCase();
}

/**
 * Run sanitizeInput() first, then, if the result's first character is a Sheets formula-injection
 * trigger (=, +, -, @), prefix it with a leading apostrophe so Google Sheets stores it as literal
 * text rather than evaluating it as a formula. LOCAL mitigation for the new waitlist cells only —
 * does NOT close M9 project-wide (RESEARCH.md Pitfall 6), and no other sanitizeInput call site
 * changes in this plan.
 * @param {*} value
 * @returns {string}
 */
function waitlistCellSafe(value) {
  var sanitized = sanitizeInput(value);
  var firstChar = sanitized.charAt(0);
  if (firstChar === '=' || firstChar === '+' || firstChar === '-' || firstChar === '@') {
    return "'" + sanitized;
  }
  return sanitized;
}

/**
 * Interpret a Waitlist mailerlite_synced cell value as a boolean flag. Sheets can hand back a
 * real boolean, a string ('TRUE'/'true'/'yes'/'y'/'1'), or a number (1) depending on how the
 * cell was written/edited (a D-04 backfill paste of TRUE vs. a code-written boolean true must
 * read back identically). Mirrors ledgerFlagTrue.
 * @param {*} value
 * @returns {boolean}
 */
function waitlistSyncedTrue(value) {
  if (value === true) return true;
  if (value === 1) return true;
  if (typeof value === 'string') {
    var v = value.trim().toLowerCase();
    return v === 'true' || v === 'yes' || v === 'y' || v === '1';
  }
  return false;
}

/**
 * The D-06 idempotency decision. Takes the Waitlist rows as its FIRST parameter — it never
 * reads the sheet itself; the caller is responsible for the read. PURE: zero references to
 * SpreadsheetApp/LockService/Session/CacheService/Logger, and no reliance on module-level
 * mutable state (_sheetCache). This is what makes it unit-testable via the `new Function`
 * source-extraction harness in tests/frontend/adminapi-waitlist-pure.test.js.
 *
 * A row with status 'removed' STILL counts as a match — a removed customer re-signing up must
 * not silently get a second row. addWaitlistEntry then reinstates that row to 'waiting' with a
 * refreshed signed_up_at (see waitlistShouldReinstate), so they rejoin at the back of the queue
 * rather than being duplicated or silently ignored.
 *
 * @param {Array<Object>} rows - Waitlist rows, shaped like sheetToObjects() output
 * @param {string} email
 * @param {string} category
 * @returns {{action: 'new'|'existing', row: (Object|null)}}
 */
/**
 * True when a dedupe-matched row should be reinstated because the customer is signing up again
 * after being removed. Pure — no Apps Script globals.
 *
 * Layered on top of waitlistDedupeDecision rather than folded into it, so that function's
 * action contract ('new' | 'existing') stays as-is.
 *
 * Only 'removed' reinstates. An active row is left alone: re-signing up must never reset a
 * `waiting` customer to the back of the queue, and must never cost a `booked` one their booking.
 */
function waitlistShouldReinstate(row) {
  if (!row) return false;
  return String(row.status === null || row.status === undefined ? '' : row.status)
    .trim().toLowerCase() === 'removed';
}

function waitlistDedupeDecision(rows, email, category) {
  var normEmail = normalizeWaitlistEmail(email);
  var normCategory = String(category || '').trim().toLowerCase();

  if (!normEmail) return { action: 'new', row: null };

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var rowEmail = normalizeWaitlistEmail(row.email);
    var rowCategory = String(row.category || '').trim().toLowerCase();
    if (rowEmail === normEmail && rowCategory === normCategory) {
      return { action: 'existing', row: row };
    }
  }

  return { action: 'new', row: null };
}

/**
 * Phase 80, D-15: serialize a list of recipe ids (e.g. `SV-R-000003`, from
 * generateNextId(RECIPES_SHEET_NAME, 'SV-R-', 6), adminApi.gs:3629) into the Waitlist sheet's
 * `recipe_ids` cell value. Pipe-delimited, no spaces — a pipe can never occur inside a
 * `SV-R-XXXXXX` id, so it is a safe, unambiguous separator. Drops falsy entries so a stray
 * `null`/`''`/`undefined` in the array never corrupts the round trip. PURE: zero references to
 * SpreadsheetApp/LockService/Session/CacheService/Logger/Utilities (same purity contract as
 * waitlistDedupeDecision/waitlistShouldReinstate).
 * @param {Array<string>} ids
 * @returns {string} '' for null/undefined/empty
 */
function serializeWaitlistRecipeIds(ids) {
  return (ids || []).filter(function (id) { return id; }).join('|');
}

/**
 * Phase 80, D-15: parse a Waitlist `recipe_ids` cell value back into an array of recipe ids.
 * Inverse of serializeWaitlistRecipeIds — drops empty segments so a stored '' round-trips to
 * [], and preserves order. PURE, same contract as serializeWaitlistRecipeIds above.
 * @param {*} value - the stored cell value
 * @returns {Array<string>} [] for null/undefined/empty
 */
function parseWaitlistRecipeIds(value) {
  if (!value) return [];
  return String(value).split('|').filter(function (s) { return s !== ''; });
}

/**
 * Add a new waitlist signup (or no-op on a D-06 dedupe hit). Called via server_token auth
 * (Railway middleware, POST /api/waitlist) — deliberately absent from both admin-proxy
 * whitelists, staff never add rows directly.
 *
 * Rigor level mirrors addReservation, NOT the money-adjacent gift-card handlers: plain
 * sheet.appendRow(...), no acquireScriptLock(). D-01 already accepts sheets' weak concurrent-
 * write posture for this non-money list; D-06's idempotency is the mitigation for a double
 * submit, not a lock (RESEARCH.md Pitfall 5).
 *
 * @param {Object} payload - { email, category }
 * @returns {{ok:true, id:string}|{ok:false, error:string}}
 */
function addWaitlistEntry(payload) {
  var ensured = ensureWaitlistSheet();
  if (!ensured.ok) return ensured;

  var email = normalizeWaitlistEmail(payload.email);
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    return { ok: false, error: 'invalid_email' };
  }

  var category = String(payload.category || 'beer').trim().toLowerCase();

  var rows = sheetToObjects(WAITLIST_SHEET_NAME);
  var decision = waitlistDedupeDecision(rows, email, category);

  // D-06 non-disclosure: the dedupe-hit and new-row branches return the IDENTICAL {ok, id}
  // key set. No disclosing field name may ever appear on either return path.
  if (decision.action === 'existing') {
    // CR-02: a removed customer signing up again is asking to rejoin. Reinstate the existing row
    // to waiting with a refreshed timestamp, so they land at the back of the queue and reappear
    // in BrewPad's Waiting filter. Without this the signup was silently ineffective — the
    // customer saw success and nothing changed. Deliberately NOT routed through
    // waitlistTransitionAllowed: that guard governs staff status edits via updateWaitlistStatus,
    // where removed -> waiting stays refused. This path is a customer signup event, not an edit.
    if (waitlistShouldReinstate(decision.row)) {
      ensured.sheet.getRange(decision.row._row, ensured.col.status).setValue('waiting');
      ensured.sheet.getRange(decision.row._row, ensured.col.signed_up_at)
        .setValue(new Date().toISOString());
      invalidateSheetCache(WAITLIST_SHEET_NAME);
    }
    return { ok: true, id: decision.row.id };
  }

  var id = Utilities.getUuid();
  ensured.sheet.appendRow([
    id,
    waitlistCellSafe(email),
    waitlistCellSafe(category),
    'waiting',
    new Date().toISOString(),
    false,
    ''
  ]);

  invalidateSheetCache(WAITLIST_SHEET_NAME);
  return { ok: true, id: id };
}

/**
 * Return all waitlist rows for the BrewPad admin view. Explicit field allowlist keeps _row
 * (sheetToObjects's internal 1-based index) out of the client payload, mirroring getGiftCards.
 * Deliberately no _cachedGet wrapper — get_gift_cards sets the precedent of skipping the cache
 * layer entirely for a low-volume staff list (sidesteps the Phase 69 stale-cache bug class).
 *
 * If the Waitlist tab is absent, ensureWaitlistSheet() creates it inline and this returns an
 * empty array (via the caller's {ok:true, data:[]}) rather than throwing. If the tab exists but
 * headers have drifted, this returns the ensureWaitlistSheet() failure object directly so the
 * caller (handleReadAction) can surface it undisguised.
 *
 * @returns {Array<Object>|{ok:false, error:string, missing:Array<string>}}
 */
function getWaitlist() {
  var ensured = ensureWaitlistSheet();
  if (!ensured.ok) return ensured;

  var rows = sheetToObjects(WAITLIST_SHEET_NAME);
  return rows.map(function (w) {
    return {
      id: w.id,
      email: w.email,
      category: w.category,
      status: w.status,
      signed_up_at: w.signed_up_at,
      mailerlite_synced: waitlistSyncedTrue(w.mailerlite_synced),
      notes: w.notes
    };
  });
}

/**
 * Update a waitlist row's status / notes / mailerlite_synced flag. Called from BrewPad via
 * /api/batch/admin-proxy (session-tier only). No acquireScriptLock() — see addWaitlistEntry's
 * comment; this is not a money-adjacent write.
 *
 * @param {Object} payload - { id, status?, notes?, mailerlite_synced? } — at least one of the
 *   three optional fields is required.
 * @returns {{ok:true, id:*, status:string}|{ok:false, error:string}}
 */
/**
 * D-05, server side: waitlist status is ONE-WAY. Returns true only if moving `current` to `next`
 * is permitted. Pure — no Apps Script globals, so it is directly unit-testable.
 *
 * Forward along waiting -> contacted -> booked (skipping a step is still forward), removal from
 * any active status, and a no-op re-set (so a retried write is idempotent). Everything else is
 * refused, including resurrecting a `removed` row, which has no UI or handler support today.
 * Unknown statuses on either side fail closed rather than defaulting to allow.
 *
 * The client mirrors this in js/brewpad.js (WAITLIST_STATUS_ORDER / nextWaitlistStatus), but the
 * client is not the record — anything reaching the admin proxy must be checked here too.
 */
function waitlistTransitionAllowed(current, next) {
  var ORDER = ['waiting', 'contacted', 'booked'];
  var cur = String(current === null || current === undefined ? '' : current).trim().toLowerCase();
  var nxt = String(next === null || next === undefined ? '' : next).trim().toLowerCase();

  var known = ORDER.concat(['removed']);
  if (known.indexOf(cur) === -1 || known.indexOf(nxt) === -1) return false;

  if (cur === nxt) return true;
  if (nxt === 'removed') return true;
  if (cur === 'removed') return false;

  return ORDER.indexOf(nxt) > ORDER.indexOf(cur);
}

function updateWaitlistStatus(payload) {
  var ensured = ensureWaitlistSheet();
  if (!ensured.ok) return ensured;

  var id = payload.id;
  if (!id) return { ok: false, error: 'not_found' };

  var hasStatus = Object.prototype.hasOwnProperty.call(payload, 'status');
  var hasNotes = Object.prototype.hasOwnProperty.call(payload, 'notes');
  var hasSynced = Object.prototype.hasOwnProperty.call(payload, 'mailerlite_synced');

  if (!hasStatus && !hasNotes && !hasSynced) {
    return { ok: false, error: 'no_fields' };
  }

  // D-05: validate BEFORE any setValue — an out-of-set status writes nothing.
  var validStatuses = ['waiting', 'contacted', 'booked', 'removed'];
  if (hasStatus && validStatuses.indexOf(payload.status) === -1) {
    return { ok: false, error: 'invalid_status' };
  }

  var result = findRowById(WAITLIST_SHEET_NAME, String(id).trim());
  if (result.row === -1) return { ok: false, error: 'not_found' };

  // D-05 one-way guard. Checked against the CURRENT status on the sheet, not against anything the
  // caller supplied, and before any setValue — a rejected transition must write nothing at all.
  if (hasStatus && !waitlistTransitionAllowed(result.data.status, payload.status)) {
    return { ok: false, error: 'invalid_transition' };
  }

  var sheet = ensured.sheet;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  if (hasStatus) {
    var statusCol = headers.indexOf('status') + 1;
    sheet.getRange(result.row, statusCol).setValue(payload.status);
  }
  if (hasNotes) {
    var notesCol = headers.indexOf('notes') + 1;
    sheet.getRange(result.row, notesCol).setValue(waitlistCellSafe(payload.notes));
  }
  if (hasSynced) {
    var syncedCol = headers.indexOf('mailerlite_synced') + 1;
    sheet.getRange(result.row, syncedCol).setValue(waitlistSyncedTrue(payload.mailerlite_synced));
  }

  invalidateSheetCache(WAITLIST_SHEET_NAME);

  var finalStatus = hasStatus ? payload.status : result.data.status;
  return { ok: true, id: id, status: finalStatus };
}

/**
 * No-op function to keep the Apps Script runtime warm and avoid cold starts (1–3s).
 * Create a time-based trigger: Edit > Triggers > Add > keepWarm, time-driven, every 5 minutes.
 */
function keepWarm() { return true; }

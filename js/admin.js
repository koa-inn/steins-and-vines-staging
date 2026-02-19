// ===== Steins & Vines Admin Dashboard =====

(function () {
  'use strict';

  // Build timestamp - updated on each deploy
  var BUILD_TIMESTAMP = '2026-02-19T23:23:24.715Z';
  console.log('[Admin] Build: ' + BUILD_TIMESTAMP);

  var accessToken = null;
  var userEmail = null;
  var tokenClient = null;
  var staffEmails = [];

  // Cached sheet data
  var kitsData = [];
  var kitsHeaders = [];
  var ingredientsData = [];
  var ingredientsHeaders = [];
  var reservationsData = [];
  var reservationsHeaders = [];
  var holdsData = [];
  var holdsHeaders = [];
  var scheduleData = [];
  var scheduleHeaders = [];

  // Dashboard summary (server-side aggregated metrics for accurate counts with pagination)
  var dashboardSummary = null;

  // Pending changes queue: [{item, field, value, sheetName, headers}]
  var pendingChanges = [];

  // ===== Standardized Status Definitions =====
  // Reservation workflow: pending → confirmed → brewing → ready → completed → archived
  var RESERVATION_STATUSES = {
    pending: { label: 'Pending', description: 'Awaiting confirmation', order: 1 },
    confirmed: { label: 'Confirmed', description: 'Appointment scheduled', order: 2 },
    brewing: { label: 'Brewing', description: 'Fermentation in progress', order: 3 },
    ready: { label: 'Ready', description: 'Ready for bottling pickup', order: 4 },
    completed: { label: 'Completed', description: 'Customer has bottled and picked up', order: 5 },
    cancelled: { label: 'Cancelled', description: 'Reservation was cancelled', order: 6 },
    archived: { label: 'Archived', description: 'Hidden from active view', order: 7 }
  };

  // Valid status transitions (from → [allowed destinations])
  var STATUS_TRANSITIONS = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['brewing', 'cancelled'],
    brewing: ['ready', 'cancelled'],
    ready: ['completed', 'cancelled'],
    completed: ['archived'],
    cancelled: ['archived'],
    archived: ['completed'] // Allow restore
  };

  // Hold statuses (simpler workflow)
  var HOLD_STATUSES = {
    pending: { label: 'Pending', order: 1 },
    confirmed: { label: 'Confirmed', order: 2 },
    released: { label: 'Released', order: 3 }
  };

  // ===== Pagination State =====
  var RESERVATIONS_PAGE_SIZE = 50;
  var reservationsPagination = {
    offset: 0,
    limit: RESERVATIONS_PAGE_SIZE,
    total: 0,
    filtered: 0,
    currentFilter: 'pending'
  };

  // ===== Toast Notification System =====

  function showToast(message, type, opts) {
    if (!type) type = 'info';
    if (!opts) opts = {};
    var container = document.getElementById('admin-toast-container');
    if (!container) return;

    var toast = document.createElement('div');
    toast.className = 'admin-toast admin-toast--' + type;

    var msgSpan = document.createElement('span');
    msgSpan.className = 'admin-toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (opts.undo) {
      var undoBtn = document.createElement('button');
      undoBtn.className = 'admin-toast-undo';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', function () {
        opts.undo();
        removeToast(toast);
      });
      toast.appendChild(undoBtn);
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'admin-toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { removeToast(toast); });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    var duration = opts.duration || (type === 'error' ? 6000 : 3500);
    var timer = setTimeout(function () { removeToast(toast); }, duration);
    toast._timer = timer;
  }

  function removeToast(toast) {
    if (toast._removed) return;
    toast._removed = true;
    clearTimeout(toast._timer);
    toast.classList.add('removing');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 150);
  }

  // ===== Confirm Dialog (replaces browser confirm) =====

  function showConfirm(message, onConfirm, onCancel) {
    var overlay = document.createElement('div');
    overlay.className = 'admin-confirm-overlay';

    var box = document.createElement('div');
    box.className = 'admin-confirm-box';

    var msg = document.createElement('div');
    msg.className = 'admin-confirm-msg';
    msg.textContent = message;
    box.appendChild(msg);

    var actions = document.createElement('div');
    actions.className = 'admin-confirm-actions';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
      if (onCancel) onCancel();
    });

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', function () {
      document.body.removeChild(overlay);
      if (onConfirm) onConfirm();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);
    overlay.appendChild(box);

    // Close on overlay click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        document.body.removeChild(overlay);
        if (onCancel) onCancel();
      }
    });

    document.body.appendChild(overlay);
    confirmBtn.focus();
  }

  // ===== Pipeline & Attention Rendering =====

  function renderPipeline(data) {
    var stages = { pending: 0, confirmed: 0, brewing: 0, ready: 0, completed: 0 };
    var sourceData = data || reservationsData;

    sourceData.forEach(function (r) {
      var status = (r.status || '').toLowerCase().trim() || 'pending';
      if (stages.hasOwnProperty(status)) {
        stages[status]++;
      }
    });

    var stagesEl = document.getElementById('pipeline-stages');
    if (!stagesEl) return;

    var total = stages.pending + stages.confirmed + stages.brewing + stages.ready + stages.completed;
    if (total === 0) {
      stagesEl.innerHTML = '<div class="pipeline-empty">No active batches</div>';
      return;
    }

    var html = '';
    var stageOrder = ['pending', 'confirmed', 'brewing', 'ready', 'completed'];
    var stageLabels = { pending: 'Pending', confirmed: 'Confirmed', brewing: 'Brewing', ready: 'Ready', completed: 'Done' };

    stageOrder.forEach(function (key) {
      if (stages[key] > 0) {
        var pct = Math.max((stages[key] / total) * 100, 12); // min 12% for readability
        html += '<div class="pipeline-stage pipeline-stage--' + key + '" style="flex:' + stages[key] + ';" data-filter="' + key + '">';
        html += '<span class="pipeline-stage-count">' + stages[key] + '</span>';
        html += '<span class="pipeline-stage-name">' + stageLabels[key] + '</span>';
        html += '</div>';
      }
    });

    stagesEl.innerHTML = html;

    // Click to filter reservations tab
    stagesEl.querySelectorAll('.pipeline-stage').forEach(function (el) {
      el.addEventListener('click', function () {
        var filter = el.getAttribute('data-filter');
        var select = document.getElementById('res-status-filter');
        if (select) {
          select.value = filter;
          select.dispatchEvent(new Event('change'));
        }
        document.querySelector('[data-tab="reservations"]').click();
      });
    });
  }

  function renderAttentionItems(summary) {
    var listEl = document.getElementById('attention-list');
    if (!listEl) return;

    var items = [];

    // Pending reservations to confirm
    var pendingRes = summary ? (summary.pendingReservations || 0) : 0;
    if (!summary) {
      reservationsData.forEach(function (r) {
        if ((r.status || '').toLowerCase().trim() === 'pending' || (!r.status && true)) pendingRes++;
      });
    }
    if (pendingRes > 0) {
      items.push({ text: pendingRes + ' reservation' + (pendingRes !== 1 ? 's' : '') + ' to confirm', dot: 'warning', tab: 'reservations', filter: 'pending' });
    }

    // Ready for pickup
    var readyRes = summary ? (summary.readyReservations || 0) : 0;
    if (!summary) {
      reservationsData.forEach(function (r) {
        if ((r.status || '').toLowerCase().trim() === 'ready') readyRes++;
      });
    }
    if (readyRes > 0) {
      items.push({ text: readyRes + ' ready for pickup', dot: 'success', tab: 'reservations', filter: 'ready' });
    }

    // Low stock
    var lowStock = summary ? (summary.lowStockKits || []).length : 0;
    if (!summary) {
      kitsData.forEach(function (kit) {
        var stock = parseInt(kit.stock, 10) || 0;
        var onHold = parseInt(kit.on_hold, 10) || 0;
        if (kit.hide !== 'true' && kit.hide !== 'TRUE' && (stock - onHold) <= 3) lowStock++;
      });
    }
    if (lowStock > 0) {
      items.push({ text: lowStock + ' kit' + (lowStock !== 1 ? 's' : '') + ' low stock', dot: 'danger', tab: 'kits' });
    }

    // Upcoming appointments
    var upcoming = summary ? (summary.upcomingAppointments || []).length : 0;
    if (upcoming > 0) {
      var nextAppt = summary.upcomingAppointments[0];
      var label = upcoming + ' upcoming appointment' + (upcoming !== 1 ? 's' : '');
      if (nextAppt.daysAway === 0) label = 'Appointment today';
      else if (nextAppt.daysAway === 1) label = 'Appointment tomorrow + ' + (upcoming - 1) + ' more';
      items.push({ text: label, dot: 'info', tab: 'scheduling' });
    }

    // Pending holds
    var pendingHolds = summary ? (summary.pendingHolds || 0) : 0;
    if (!summary) {
      holdsData.forEach(function (h) {
        if ((h.status || '').toLowerCase().trim() === 'pending') pendingHolds++;
      });
    }
    if (pendingHolds > 0) {
      items.push({ text: pendingHolds + ' hold' + (pendingHolds !== 1 ? 's' : '') + ' to confirm', dot: 'warning', tab: 'reservations', filter: 'pending' });
    }

    if (items.length === 0) {
      listEl.innerHTML = '<div class="attention-item"><span class="attention-dot attention-dot--success"></span>All clear — nothing needs attention</div>';
      return;
    }

    var html = '';
    items.forEach(function (item) {
      html += '<div class="attention-item" data-tab="' + item.tab + '"' + (item.filter ? ' data-filter="' + item.filter + '"' : '') + '>';
      html += '<span class="attention-dot attention-dot--' + item.dot + '"></span>';
      html += item.text;
      html += '</div>';
    });
    listEl.innerHTML = html;

    // Click to navigate
    listEl.querySelectorAll('.attention-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var tab = el.getAttribute('data-tab');
        var filter = el.getAttribute('data-filter');
        if (tab) document.querySelector('[data-tab="' + tab + '"]').click();
        if (filter) {
          var select = document.getElementById('res-status-filter');
          if (select) {
            select.value = filter;
            select.dispatchEvent(new Event('change'));
          }
        }
      });
    });
  }

  // ===== Initialization =====

  document.addEventListener('DOMContentLoaded', function () {
    // Mobile nav toggle (same as main.js)
    var toggle = document.querySelector('.nav-toggle');
    var navList = document.querySelector('.nav-list');
    if (toggle && navList) {
      toggle.addEventListener('click', function () {
        navList.classList.toggle('open');
      });
    }

    // Content loader
    var page = document.body.getAttribute('data-page');
    if (page) {
      fetch('content/' + page + '.json')
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var els = document.querySelectorAll('[data-content]');
          els.forEach(function (el) {
            var key = el.getAttribute('data-content');
            if (data[key] !== undefined) el.textContent = data[key];
          });
        })
        .catch(function () {});
    }

    initTabNavigation();
    initModalControls();
    initExportButtons();
    initImportControls();
    initFilterListeners();
    initSaveBar();
    initOrderControls();
    initScheduleControls();
    waitForGoogleIdentity();

    // Render order tab from localStorage immediately (doesn't need auth)
    renderOrderTab();
  });

  // ===== Google OAuth =====

  function waitForGoogleIdentity() {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      initGoogleAuth();
    } else {
      setTimeout(waitForGoogleIdentity, 100);
    }
  }

  function initGoogleAuth() {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: SHEETS_CONFIG.CLIENT_ID,
      scope: SHEETS_CONFIG.SCOPES + ' https://www.googleapis.com/auth/userinfo.email',
      callback: onTokenResponse
    });

    var signinBtn = document.getElementById('google-signin-btn');
    if (signinBtn) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Sign in with Google';
      btn.addEventListener('click', function () {
        tokenClient.requestAccessToken();
      });
      signinBtn.appendChild(btn);
    }

    document.getElementById('admin-signout').addEventListener('click', signOut);
    document.getElementById('admin-signout-denied').addEventListener('click', signOut);
  }

  function onTokenResponse(response) {
    if (response.error) {
      localStorage.removeItem('sv-admin-email');
      return;
    }
    accessToken = response.access_token;

    // Get user info
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    })
      .then(function (res) { return res.json(); })
      .then(function (info) {
        userEmail = info.email;
        checkAuthorization();
      })
      .catch(function () {
        showDenied();
      });
  }

  function checkAuthorization() {
    console.log('[Admin] Checking authorization for:', userEmail);

    // Use server-side validation if Admin API is configured (more secure)
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      console.log('[Admin] Using server-side auth validation');
      adminApiGet('check_auth')
        .then(function (result) {
          console.log('[Admin] Server auth result:', result);
          if (result.authorized) {
            showDashboard();
          } else {
            showDenied();
          }
        })
        .catch(function (err) {
          console.error('[Admin] Server auth failed:', err.message);
          showDenied();
        });
      return;
    }

    // Fallback: client-side check (less secure, for development)
    console.warn('[Admin] Using client-side auth (ADMIN_API_URL not configured)');
    sheetsGet(SHEETS_CONFIG.SHEET_NAMES.CONFIG + '!A:B')
      .then(function (data) {
        var rows = data.values || [];
        console.log('[Admin] Config sheet rows:', JSON.stringify(rows));
        for (var i = 0; i < rows.length; i++) {
          if (rows[i][0] === 'staff_emails') {
            staffEmails = (rows[i][1] || '').split(',').map(function (e) { return e.trim().toLowerCase(); });
            break;
          }
        }
        console.log('[Admin] Parsed staff emails:', staffEmails);
        console.log('[Admin] User email match:', staffEmails.indexOf(userEmail.toLowerCase()) !== -1);
        if (staffEmails.indexOf(userEmail.toLowerCase()) !== -1) {
          showDashboard();
        } else {
          showDenied();
        }
      })
      .catch(function (err) {
        // If Config sheet can't be read, deny access
        console.error('[Admin] Failed to read Config sheet:', err);
        showDenied();
      });
  }

  function showDashboard() {
    document.getElementById('admin-signin').style.display = 'none';
    document.getElementById('admin-denied').style.display = 'none';
    document.getElementById('admin-dashboard').style.display = '';
    document.getElementById('admin-user-email').textContent = userEmail;
    // Show shell bar sign-out
    var shellSignout = document.getElementById('admin-signout');
    if (shellSignout) shellSignout.style.display = '';
    localStorage.setItem('sv-admin-email', userEmail);
    loadAllData();
    loadEmailTemplates();

    // Set up token refresh (~50 min)
    setInterval(function () {
      tokenClient.requestAccessToken({ prompt: '' });
    }, 50 * 60 * 1000);
  }

  function showDenied() {
    document.getElementById('admin-signin').style.display = 'none';
    document.getElementById('admin-denied').style.display = '';
    document.getElementById('admin-dashboard').style.display = 'none';
  }

  function signOut() {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken);
    }
    accessToken = null;
    userEmail = null;
    localStorage.removeItem('sv-admin-email');
    document.getElementById('admin-signin').style.display = '';
    document.getElementById('admin-denied').style.display = 'none';
    document.getElementById('admin-dashboard').style.display = 'none';
    // Hide shell bar sign-out
    var shellSignout = document.getElementById('admin-signout');
    if (shellSignout) shellSignout.style.display = 'none';
    document.getElementById('admin-user-email').textContent = '';
  }

  // ===== Admin API Helper =====

  /**
   * Fetch with automatic retry on failure (e.g., timeout)
   * Waits 1 second before retrying once
   */
  function fetchWithRetry(url, options, retries) {
    if (retries === undefined) retries = 1;
    return fetch(url, options).catch(function (err) {
      if (retries > 0) {
        return new Promise(function (resolve) {
          setTimeout(resolve, 1000);
        }).then(function () {
          return fetchWithRetry(url, options, retries - 1);
        });
      }
      throw err;
    });
  }

  /**
   * Call the secure Admin API (server-side auth validation)
   * Falls back to direct Sheets API if ADMIN_API_URL is not configured
   * Note: Token is passed as URL parameter because GAS web apps can't read Authorization headers
   * @param {string} action - The action name (e.g., 'get_reservations')
   * @param {object} params - Optional additional URL parameters
   */
  function adminApiGet(action, params) {
    if (!SHEETS_CONFIG.ADMIN_API_URL) {
      return Promise.reject(new Error('Admin API not configured'));
    }
    var url = SHEETS_CONFIG.ADMIN_API_URL + '?action=' + encodeURIComponent(action) + '&token=' + encodeURIComponent(accessToken);
    if (params) {
      Object.keys(params).forEach(function (key) {
        url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      });
    }
    return fetchWithRetry(url, {
      method: 'GET'
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data.ok) {
        throw new Error(data.message || data.error || 'API error');
      }
      return data;
    });
  }

  function adminApiPost(action, payload) {
    if (!SHEETS_CONFIG.ADMIN_API_URL) {
      return Promise.reject(new Error('Admin API not configured'));
    }
    payload.action = action;
    payload.token = accessToken;
    return fetchWithRetry(SHEETS_CONFIG.ADMIN_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain' // Use text/plain to avoid CORS preflight
      },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.json();
    }).then(function (data) {
      if (!data.ok) {
        throw new Error(data.message || data.error || 'API error');
      }
      return data;
    });
  }

  // ===== Sheets API Helpers =====

  function sheetsGet(range) {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range);
    return fetchWithRetry(url, {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(function (res) {
      if (!res.ok) throw new Error('Sheets API error: ' + res.status);
      return res.json();
    });
  }

  function sheetsUpdate(range, values) {
    // If Admin API is configured, verify authorization server-side before write
    var writePromise;
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      writePromise = adminApiGet('check_auth').then(function (result) {
        if (!result.authorized) {
          throw new Error('Not authorized to make changes');
        }
      });
    } else {
      writePromise = Promise.resolve();
    }

    return writePromise.then(function () {
      var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
        SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range) +
        '?valueInputOption=USER_ENTERED';
      return fetchWithRetry(url, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: values })
      }).then(function (res) {
        if (!res.ok) throw new Error('Sheets API error: ' + res.status);
        return res.json();
      });
    });
  }

  function sheetsAppend(range, values) {
    // If Admin API is configured, verify authorization server-side before write
    var writePromise;
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      writePromise = adminApiGet('check_auth').then(function (result) {
        if (!result.authorized) {
          throw new Error('Not authorized to make changes');
        }
      });
    } else {
      writePromise = Promise.resolve();
    }

    return writePromise.then(function () {
      var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
        SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range) +
        ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
      return fetchWithRetry(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: values })
      }).then(function (res) {
        if (!res.ok) throw new Error('Sheets API error: ' + res.status);
        return res.json();
      });
    });
  }

  function sheetsBatchUpdate(requests) {
    // If Admin API is configured, verify authorization server-side before write
    var writePromise;
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      writePromise = adminApiGet('check_auth').then(function (result) {
        if (!result.authorized) {
          throw new Error('Not authorized to make changes');
        }
      });
    } else {
      writePromise = Promise.resolve();
    }

    return writePromise.then(function () {
      var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
        SHEETS_CONFIG.SPREADSHEET_ID + ':batchUpdate';
      return fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ requests: requests })
      }).then(function (res) {
        if (!res.ok) throw new Error('Sheets API error: ' + res.status);
        return res.json();
      });
    });
  }

  // ===== Load All Data =====

  function loadAllData() {
    // Reset pagination when loading all data
    reservationsPagination.offset = 0;
    reservationsPagination.currentFilter = document.getElementById('res-status-filter')?.value || 'pending';

    // Use Admin API if configured (server-side auth on every request)
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      Promise.all([
        adminApiGet('get_kits'),
        loadReservationsPage(), // Use paginated loading
        adminApiGet('get_holds'),
        adminApiGet('get_schedule'),
        adminApiGet('get_dashboard_summary') // Server-side aggregated metrics
      ]).then(function (results) {
        parseSheetData(results[0].data, 'kits');
        // Reservations already parsed in loadReservationsPage
        parseSheetData(results[2].data, 'holds');
        parseSheetData(results[3].data, 'schedule');

        // Store dashboard summary for accurate counts with pagination
        dashboardSummary = results[4].data || null;

        // Ingredients still loaded via public CSV (no auth needed)
        return sheetsGet(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:Z');
      }).then(function (ingredientsResult) {
        parseSheetData(ingredientsResult, 'ingredients');
        finishDataLoad();
      }).catch(function (err) {
        console.error('Failed to load data via Admin API:', err);
        // Show error to user
        showToast('Failed to load data: ' + err.message, 'error');
      });
      return;
    }

    // Fallback: direct Sheets API (less secure, no pagination)
    Promise.all([
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.KITS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!A:Z')
    ]).then(function (results) {
      parseSheetData(results[0], 'kits');
      parseSheetData(results[1], 'ingredients');
      parseSheetData(results[2], 'reservations');
      parseSheetData(results[3], 'holds');
      parseSheetData(results[4], 'schedule');
      // Set pagination totals for fallback mode
      reservationsPagination.total = reservationsData.length;
      reservationsPagination.filtered = reservationsData.length;
      finishDataLoad();
    }).catch(function (err) {
      console.error('Failed to load data:', err);
    });
  }

  /**
   * Load a page of reservations with server-side filtering
   */
  function loadReservationsPage() {
    if (!SHEETS_CONFIG.ADMIN_API_URL) {
      return Promise.resolve({ data: { values: [] } });
    }

    var params = {
      limit: reservationsPagination.limit,
      offset: reservationsPagination.offset,
      status: reservationsPagination.currentFilter
    };

    return adminApiGet('get_reservations', params).then(function (result) {
      // Parse the paginated data
      parseSheetData(result.data, 'reservations');

      // Store pagination metadata
      reservationsPagination.total = result.data.total || 0;
      reservationsPagination.filtered = result.data.filtered || 0;

      return result;
    });
  }

  /**
   * Change reservation page
   */
  function changeReservationsPage(direction) {
    var newOffset = reservationsPagination.offset + (direction * reservationsPagination.limit);

    // Bounds checking
    if (newOffset < 0) newOffset = 0;
    if (newOffset >= reservationsPagination.filtered) return;

    reservationsPagination.offset = newOffset;

    // Reload just the reservations
    loadReservationsPage().then(function () {
      renderReservationsTab();
    }).catch(function (err) {
      console.error('Failed to load reservations page:', err);
    });
  }

  /**
   * Go to specific reservation page
   */
  function goToReservationsPage(page) {
    var newOffset = (page - 1) * reservationsPagination.limit;

    if (newOffset < 0) newOffset = 0;
    if (newOffset >= reservationsPagination.filtered && reservationsPagination.filtered > 0) {
      newOffset = Math.floor((reservationsPagination.filtered - 1) / reservationsPagination.limit) * reservationsPagination.limit;
    }

    reservationsPagination.offset = newOffset;

    loadReservationsPage().then(function () {
      renderReservationsTab();
    }).catch(function (err) {
      console.error('Failed to load reservations page:', err);
    });
  }

  function finishDataLoad() {
    renderDashboard();
    renderReservationsTab();
    renderKitsTab();
    renderIngredientsTab();
    renderScheduleTab();
    populateKitBrandFilter();
    populateOrderKitSelect();
    // Load order items from sheet's on_order column into localStorage
    loadOrderFromSheet();
    populateOrderBrandFilter();
    renderOrderTab();
    loadHomepageData();
  }

  // ===== Dashboard Overview =====

  function renderDashboard() {
    // Use server-side summary if available (accurate with pagination)
    if (dashboardSummary) {
      renderDashboardFromSummary(dashboardSummary);
      return;
    }

    // Fallback: calculate from local data (may be incomplete with pagination)
    renderDashboardFromLocalData();
  }

  /**
   * Render dashboard using server-side aggregated summary
   * This provides accurate counts even when reservations are paginated
   */
  function renderDashboardFromSummary(summary) {
    // 1. Reservations Today
    document.getElementById('dash-reservations-today').textContent = summary.reservationsToday || 0;
    document.getElementById('dash-reservations-week').textContent = summary.totalActiveReservations + ' active total';

    // 2. Pending Actions
    var pendingReservations = summary.pendingReservations || 0;
    var readyReservations = summary.readyReservations || 0;
    var pendingHolds = summary.pendingHolds || 0;
    var totalPending = pendingReservations + readyReservations + pendingHolds;

    document.getElementById('dash-pending-actions').textContent = totalPending;
    var detailParts = [];
    if (pendingReservations > 0) detailParts.push(pendingReservations + ' to confirm');
    if (readyReservations > 0) detailParts.push(readyReservations + ' ready for pickup');
    if (pendingHolds > 0) detailParts.push(pendingHolds + ' hold' + (pendingHolds !== 1 ? 's' : ''));
    document.getElementById('dash-pending-detail').textContent = detailParts.join(', ') || 'No pending actions';

    // 3. Low Stock Alerts (from server summary)
    var lowStockItems = summary.lowStockKits || [];
    document.getElementById('dash-low-stock').textContent = lowStockItems.length;
    var stockValueEl = document.querySelector('.dashboard-card--stock .dashboard-card-value');
    if (lowStockItems.length === 0) {
      document.getElementById('dash-low-stock-detail').textContent = 'All items well stocked';
      if (stockValueEl) stockValueEl.style.color = '#388e3c';
    } else {
      if (stockValueEl) stockValueEl.style.color = '';
      var topItems = lowStockItems.slice(0, 2).map(function (item) {
        return item.name + ' (' + item.stock + ')';
      });
      var detailText = topItems.join(', ');
      if (lowStockItems.length > 2) {
        detailText += ' +' + (lowStockItems.length - 2) + ' more';
      }
      var detailEl = document.getElementById('dash-low-stock-detail');
      detailEl.innerHTML = detailText + ' <a id="dash-low-stock-link">View all</a>';
      document.getElementById('dash-low-stock-link').addEventListener('click', function () {
        document.querySelector('[data-tab="kits"]').click();
      });
    }

    // 4. Upcoming Appointments (from server summary)
    var upcomingAppts = summary.upcomingAppointments || [];
    document.getElementById('dash-upcoming-appts').textContent = upcomingAppts.length;
    if (upcomingAppts.length > 0) {
      var nextAppt = upcomingAppts[0];
      var apptText = 'Next: ' + nextAppt.date;
      if (nextAppt.daysAway === 0) apptText = 'Today: ' + nextAppt.name;
      else if (nextAppt.daysAway === 1) apptText = 'Tomorrow: ' + nextAppt.name;
      document.getElementById('dash-upcoming-detail').textContent = apptText;
    } else {
      document.getElementById('dash-upcoming-detail').textContent = 'None in next 7 days';
    }

    // Render pipeline and attention items
    renderPipeline(null); // uses reservationsData
    renderAttentionItems(summary);
  }

  /**
   * Fallback: render dashboard from locally loaded data
   * Note: may be incomplete when using pagination
   */
  function renderDashboardFromLocalData() {
    var today = new Date();
    var todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

    // Calculate week range (last 7 days)
    var weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    // Calculate next 7 days for upcoming appointments
    var nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    // 1. Reservations Today & This Week
    var reservationsToday = 0;
    var reservationsWeek = 0;
    reservationsData.forEach(function (r) {
      var submitted = r.submitted_at || '';
      var submittedDate = submitted.split('T')[0];
      if (submittedDate === todayStr) {
        reservationsToday++;
      }
      if (submitted && new Date(submitted) >= weekAgo) {
        reservationsWeek++;
      }
    });

    document.getElementById('dash-reservations-today').textContent = reservationsToday;
    document.getElementById('dash-reservations-week').textContent = reservationsWeek + ' this week';

    // 2. Pending Actions (items needing attention)
    var pendingReservations = 0;
    var readyReservations = 0;
    var pendingHolds = 0;
    reservationsData.forEach(function (r) {
      var status = (r.status || '').toLowerCase().trim() || 'pending';
      if (status === 'pending') pendingReservations++;
      if (status === 'ready') readyReservations++;
    });
    holdsData.forEach(function (h) {
      var status = (h.status || '').toLowerCase().trim() || 'pending';
      if (status === 'pending') pendingHolds++;
    });
    var totalPending = pendingReservations + readyReservations + pendingHolds;

    document.getElementById('dash-pending-actions').textContent = totalPending;
    var detailParts = [];
    if (pendingReservations > 0) detailParts.push(pendingReservations + ' to confirm');
    if (readyReservations > 0) detailParts.push(readyReservations + ' ready for pickup');
    if (pendingHolds > 0) detailParts.push(pendingHolds + ' hold' + (pendingHolds !== 1 ? 's' : ''));
    document.getElementById('dash-pending-detail').textContent = detailParts.join(', ') || 'No pending actions';

    // 3. Low Stock Alerts
    var lowStockThreshold = 3; // Alert when stock <= this number
    var lowStockItems = [];
    kitsData.forEach(function (kit) {
      var stock = parseInt(kit.stock, 10) || 0;
      var onHold = parseInt(kit.on_hold, 10) || 0;
      var available = stock - onHold;
      // Only check items that are not hidden and have been stocked before
      if (kit.hide !== 'true' && kit.hide !== 'TRUE') {
        if (available <= lowStockThreshold) {
          lowStockItems.push({
            name: kit.name,
            brand: kit.brand,
            available: available,
            stock: stock,
            onHold: onHold
          });
        }
      }
    });

    document.getElementById('dash-low-stock').textContent = lowStockItems.length;
    if (lowStockItems.length === 0) {
      document.getElementById('dash-low-stock-detail').textContent = 'All items well stocked';
      document.querySelector('.dashboard-card--stock .dashboard-card-value').style.color = '#388e3c';
    } else {
      var topItems = lowStockItems.slice(0, 2).map(function (item) {
        return (item.brand ? item.brand + ' ' : '') + item.name + ' (' + item.available + ')';
      });
      var detailText = topItems.join(', ');
      if (lowStockItems.length > 2) {
        detailText += ' +' + (lowStockItems.length - 2) + ' more';
      }
      var detailEl = document.getElementById('dash-low-stock-detail');
      detailEl.innerHTML = detailText + ' <a id="dash-low-stock-link">View all</a>';
      document.getElementById('dash-low-stock-link').addEventListener('click', function () {
        // Switch to Kits tab
        document.querySelector('[data-tab="kits"]').click();
      });
    }

    // 4. Upcoming Appointments (active reservations with timeslots in next 7 days)
    var upcomingAppts = 0;
    var nextApptDate = null;
    var activeStatuses = ['pending', 'confirmed', 'brewing'];
    reservationsData.forEach(function (r) {
      var status = (r.status || '').toLowerCase().trim() || 'pending';
      if (activeStatuses.indexOf(status) !== -1) {
        var timeslot = r.timeslot || '';
        // Parse timeslot - format might be "Mon Jan 15 @ 10:00 AM" or similar
        // Try to extract a date from the timeslot
        var timeslotDate = parseTimeslotDate(timeslot);
        if (timeslotDate && timeslotDate >= today && timeslotDate <= nextWeek) {
          upcomingAppts++;
          if (!nextApptDate || timeslotDate < nextApptDate) {
            nextApptDate = timeslotDate;
          }
        }
      }
    });

    document.getElementById('dash-upcoming-appts').textContent = upcomingAppts;
    if (upcomingAppts > 0 && nextApptDate) {
      var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var nextDay = dayNames[nextApptDate.getDay()];
      var nextDateStr = nextApptDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      document.getElementById('dash-upcoming-detail').textContent = 'Next: ' + nextDay + ' ' + nextDateStr;
    } else {
      document.getElementById('dash-upcoming-detail').textContent = 'None in next 7 days';
    }

    // Render pipeline and attention items (fallback mode — no summary)
    renderPipeline(null);
    renderAttentionItems(null);
  }

  function parseTimeslotDate(timeslot) {
    if (!timeslot) return null;
    // Try various date parsing approaches
    // Format examples: "Mon Jan 15 @ 10:00 AM", "2024-01-15 10:00", "January 15, 2024"

    // Try extracting date parts
    var dateMatch = timeslot.match(/(\w+)\s+(\w+)\s+(\d+)/); // "Mon Jan 15"
    if (dateMatch) {
      var monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      var monthStr = dateMatch[2].toLowerCase().substring(0, 3);
      var monthIndex = monthNames.indexOf(monthStr);
      var day = parseInt(dateMatch[3], 10);
      if (monthIndex !== -1 && day) {
        var year = new Date().getFullYear();
        var parsed = new Date(year, monthIndex, day);
        // If date is in the past, assume next year
        if (parsed < new Date()) {
          parsed.setFullYear(year + 1);
        }
        return parsed;
      }
    }

    // Try ISO format
    var isoMatch = timeslot.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return new Date(isoMatch[1], parseInt(isoMatch[2], 10) - 1, isoMatch[3]);
    }

    // Fallback: try native Date parsing
    var nativeParsed = new Date(timeslot);
    if (!isNaN(nativeParsed.getTime())) {
      return nativeParsed;
    }

    return null;
  }

  function parseSheetData(response, type) {
    var rows = response.values || [];
    if (rows.length === 0) return;
    var headers = rows[0];
    var data = [];
    for (var i = 1; i < rows.length; i++) {
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (rows[i][j] || '');
      }
      obj._rowIndex = i + 1; // 1-based row number in sheet
      data.push(obj);
    }
    switch (type) {
      case 'kits':
        kitsHeaders = headers;
        kitsData = data;
        break;
      case 'ingredients':
        ingredientsHeaders = headers;
        ingredientsData = data;
        break;
      case 'reservations':
        reservationsHeaders = headers;
        reservationsData = data;
        break;
      case 'holds':
        holdsHeaders = headers;
        holdsData = data;
        break;
      case 'schedule':
        scheduleHeaders = headers;
        scheduleData = data;
        break;
    }
  }

  // ===== Tab Navigation =====

  function initTabNavigation() {
    var tabs = document.querySelectorAll('.admin-tab-btn');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        tabs.forEach(function (t) { t.classList.remove('active'); });
        btn.classList.add('active');

        var panels = document.querySelectorAll('.admin-tab-panel');
        panels.forEach(function (p) { p.classList.remove('active'); });

        var target = document.getElementById('tab-' + btn.getAttribute('data-tab'));
        if (target) target.classList.add('active');
      });
    });
  }

  // ===== Modal Controls =====

  function initModalControls() {
    var modal = document.getElementById('admin-modal');
    var overlay = document.getElementById('admin-modal-overlay');
    var closeBtn = document.getElementById('admin-modal-close');

    function closeModal() {
      modal.style.display = 'none';
    }
    if (overlay) overlay.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
  }

  function openModal(title, bodyHTML) {
    document.getElementById('admin-modal-title').textContent = title;
    document.getElementById('admin-modal-body').innerHTML = bodyHTML;
    document.getElementById('admin-modal').style.display = '';
  }

  function closeModal() {
    document.getElementById('admin-modal').style.display = 'none';
  }

  // ===== Save Bar =====

  function initSaveBar() {
    var saveBtn = document.getElementById('admin-save-btn');
    var discardBtn = document.getElementById('admin-discard-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveAllChanges);
    if (discardBtn) discardBtn.addEventListener('click', discardAllChanges);
  }

  // ===== Filter Listeners =====

  function initFilterListeners() {
    var resFilter = document.getElementById('res-status-filter');
    if (resFilter) {
      resFilter.addEventListener('change', function () {
        // Reset to first page when filter changes
        reservationsPagination.offset = 0;
        reservationsPagination.currentFilter = this.value;

        // If using Admin API, reload from server with new filter
        if (SHEETS_CONFIG.ADMIN_API_URL) {
          loadReservationsPage().then(function () {
            renderReservationsTab();
          }).catch(function (err) {
            console.error('Failed to load filtered reservations:', err);
          });
        } else {
          // Client-side filtering
          renderReservationsTab();
        }
      });
    }

    var kitSearch = document.getElementById('kit-search');
    var kitSearchTimer;
    if (kitSearch) {
      kitSearch.addEventListener('input', function () {
        clearTimeout(kitSearchTimer);
        kitSearchTimer = setTimeout(renderKitsTab, 300);
      });
    }

    var kitBrandFilter = document.getElementById('kit-brand-filter');
    if (kitBrandFilter) kitBrandFilter.addEventListener('change', renderKitsTab);

    var kitStockFilter = document.getElementById('kit-stock-filter');
    if (kitStockFilter) kitStockFilter.addEventListener('change', renderKitsTab);

    initKitSortHeaders();

    var ingCatFilter = document.getElementById('ing-type-filter');
    if (ingCatFilter) ingCatFilter.addEventListener('change', renderIngredientsTab);

    initOrderFilterListeners();
  }

  // ===== Reservations & Holds Tab =====

  function renderReservationsTab() {
    var tbody = document.getElementById('reservations-tbody');
    var emptyMsg = document.getElementById('reservations-empty');
    if (!tbody) return;

    var filterVal = document.getElementById('res-status-filter').value;
    var filtered = reservationsData;

    // When using Admin API, data is already filtered server-side
    // Only apply client-side filtering for fallback mode
    if (!SHEETS_CONFIG.ADMIN_API_URL) {
      if (filterVal === 'all') {
        // Show everything including archived
        filtered = reservationsData;
      } else if (filterVal === 'active') {
        // Show all except archived
        filtered = reservationsData.filter(function (r) {
          var status = (r.status || '').toLowerCase().trim();
          if (!status) status = 'pending';
          return status !== 'archived';
        });
      } else {
        // Filter by specific status
        filtered = reservationsData.filter(function (r) {
          var status = (r.status || '').toLowerCase().trim();
          if (!status) status = 'pending'; // treat empty status as pending
          return status === filterVal;
        });
      }

      // Sort newest first by submitted_at (client-side)
      filtered.sort(function (a, b) {
        return (b.submitted_at || '').localeCompare(a.submitted_at || '');
      });

      // Update pagination totals for fallback mode
      reservationsPagination.filtered = filtered.length;
    }

    tbody.innerHTML = '';

    if (filtered.length === 0) {
      emptyMsg.style.display = '';
      document.getElementById('reservations-table').style.display = 'none';
      renderReservationsPagination();
      return;
    }
    emptyMsg.style.display = 'none';
    document.getElementById('reservations-table').style.display = '';

    filtered.forEach(function (res) {
      var resHolds = holdsData.filter(function (h) {
        return h.reservation_id === res.reservation_id;
      });

      // Main reservation row
      var tr = document.createElement('tr');
      tr.className = 'admin-res-row';

      var expandTd = document.createElement('td');
      var expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'admin-expand-btn';
      expandBtn.textContent = resHolds.length > 0 ? '+' : '';
      expandBtn.setAttribute('aria-expanded', 'false');
      expandTd.appendChild(expandBtn);
      tr.appendChild(expandTd);

      appendTd(tr, res.reservation_id);

      // Customer cell with name on one line, email below
      var custTd = document.createElement('td');
      var custName = document.createElement('span');
      custName.className = 'res-cell-primary';
      custName.textContent = res.customer_name || '';
      custTd.appendChild(custName);
      if (res.customer_email) {
        var custEmail = document.createElement('span');
        custEmail.className = 'res-cell-secondary';
        custEmail.textContent = res.customer_email;
        custTd.appendChild(custEmail);
      }
      if (res.customer_phone) {
        var custPhone = document.createElement('span');
        custPhone.className = 'res-cell-secondary';
        custPhone.textContent = res.customer_phone;
        custTd.appendChild(custPhone);
      }
      tr.appendChild(custTd);

      // Products cell — split comma-separated products onto separate lines
      var prodTd = document.createElement('td');
      var prodStr = res.products || '';
      var prodItems = prodStr.split(',');
      prodItems.forEach(function (item, idx) {
        var trimmed = item.trim();
        if (!trimmed) return;
        var prodSpan = document.createElement('span');
        prodSpan.className = 'res-cell-line';
        prodSpan.textContent = trimmed;
        prodTd.appendChild(prodSpan);
      });
      tr.appendChild(prodTd);

      // Timeslot cell — date on one line, time below
      var tsTd = document.createElement('td');
      var tsStr = (res.timeslot || '').trim();
      var tsSpaceIdx = tsStr.indexOf(' ');
      if (tsSpaceIdx > 0) {
        var tsDate = document.createElement('span');
        tsDate.className = 'res-cell-primary';
        tsDate.textContent = tsStr.substring(0, tsSpaceIdx);
        tsTd.appendChild(tsDate);
        var tsTime = document.createElement('span');
        tsTime.className = 'res-cell-secondary';
        tsTime.textContent = tsStr.substring(tsSpaceIdx + 1);
        tsTd.appendChild(tsTime);
      } else {
        tsTd.textContent = tsStr;
      }
      tr.appendChild(tsTd);

      var statusTd = document.createElement('td');
      var badge = document.createElement('span');
      var displayStatus = (res.status || '').trim().toLowerCase() || 'pending';
      // Normalize status to known values
      if (!RESERVATION_STATUSES[displayStatus]) {
        displayStatus = 'pending';
      }
      badge.className = 'hold-badge hold-badge--' + displayStatus;
      badge.textContent = RESERVATION_STATUSES[displayStatus].label;
      badge.title = RESERVATION_STATUSES[displayStatus].description;
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      appendTd(tr, res.submitted_at || '');

      var actionsTd = document.createElement('td');
      actionsTd.className = 'res-actions';

      // Email button — always available if there's an email
      if (res.customer_email) {
        var emailBtn = document.createElement('button');
        emailBtn.type = 'button';
        emailBtn.className = 'btn admin-btn-sm';
        emailBtn.textContent = 'Email';
        emailBtn.addEventListener('click', (function (reservation) {
          return function () { openConfirmationEmail(reservation); };
        })(res));
        actionsTd.appendChild(emailBtn);
      }

      // Status dropdown for valid transitions
      var allowedTransitions = STATUS_TRANSITIONS[displayStatus] || [];
      if (allowedTransitions.length > 0) {
        var statusSelect = document.createElement('select');
        statusSelect.className = 'admin-select admin-status-select';

        // Current status as first option
        var currentOpt = document.createElement('option');
        currentOpt.value = '';
        currentOpt.textContent = 'Change status...';
        statusSelect.appendChild(currentOpt);

        // Add allowed transitions
        allowedTransitions.forEach(function (targetStatus) {
          var opt = document.createElement('option');
          opt.value = targetStatus;
          opt.textContent = '→ ' + RESERVATION_STATUSES[targetStatus].label;
          statusSelect.appendChild(opt);
        });

        statusSelect.addEventListener('change', (function (reservation, holds, currentStatus) {
          return function () {
            var newStatus = this.value;
            if (!newStatus) return;

            var statusInfo = RESERVATION_STATUSES[newStatus];
            var confirmMsg = 'Change status to "' + statusInfo.label + '"';
            if (newStatus === 'cancelled') {
              confirmMsg += '? This will cancel the reservation.';
            } else if (newStatus === 'archived') {
              confirmMsg += '? It will be hidden from the active list.';
            } else {
              confirmMsg += '?';
            }

            if (!confirm(confirmMsg)) {
              this.value = '';
              return;
            }

            setReservationStatus(reservation, newStatus);

            // Auto-confirm holds when moving to confirmed
            if (newStatus === 'confirmed' && currentStatus === 'pending' && holds.length > 0) {
              confirmAllHolds(reservation, holds);
            }
          };
        })(res, resHolds, displayStatus));

        actionsTd.appendChild(statusSelect);
      }

      tr.appendChild(actionsTd);

      tbody.appendChild(tr);

      // Holds sub-rows (hidden by default)
      var holdRows = [];
      resHolds.forEach(function (hold) {
        var htr = document.createElement('tr');
        htr.className = 'admin-hold-row';
        htr.style.display = 'none';

        appendTd(htr, ''); // expand column spacer
        appendTd(htr, hold.hold_id || '');

        // Product name with SKU below
        var hProdTd = document.createElement('td');
        var hProdName = document.createElement('span');
        hProdName.className = 'res-cell-primary';
        hProdName.textContent = hold.product_name || '';
        hProdTd.appendChild(hProdName);
        if (hold.sku) {
          var hProdSku = document.createElement('span');
          hProdSku.className = 'res-cell-secondary';
          hProdSku.textContent = 'SKU: ' + hold.sku;
          hProdTd.appendChild(hProdSku);
        }
        htr.appendChild(hProdTd);

        appendTd(htr, 'Qty: ' + (hold.qty || ''));
        appendTd(htr, ''); // timeslot column spacer

        var hStatusTd = document.createElement('td');
        var hBadge = document.createElement('span');
        hBadge.className = 'hold-badge hold-badge--' + (hold.status || 'pending').toLowerCase();
        hBadge.textContent = hold.status || 'pending';
        hStatusTd.appendChild(hBadge);
        htr.appendChild(hStatusTd);

        appendTd(htr, hold.created_at || '');

        var hActionsTd = document.createElement('td');
        if ((hold.status || '').toLowerCase() === 'pending') {
          var confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'btn admin-btn-sm';
          confirmBtn.textContent = 'Confirm';
          confirmBtn.addEventListener('click', (function (h, r) {
            return function () { confirmHold(h, r); };
          })(hold, res));
          hActionsTd.appendChild(confirmBtn);

          var releaseBtn = document.createElement('button');
          releaseBtn.type = 'button';
          releaseBtn.className = 'btn-secondary admin-btn-sm';
          releaseBtn.textContent = 'Release';
          releaseBtn.addEventListener('click', (function (h, r) {
            return function () { releaseHold(h, r); };
          })(hold, res));
          hActionsTd.appendChild(releaseBtn);
        }
        htr.appendChild(hActionsTd);

        holdRows.push(htr);
        tbody.appendChild(htr);
      });

      // Toggle expand
      expandBtn.addEventListener('click', (function (rows, btn) {
        return function () {
          var expanded = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', String(!expanded));
          btn.textContent = expanded ? '+' : '\u2212';
          rows.forEach(function (r) {
            r.style.display = expanded ? 'none' : '';
          });
        };
      })(holdRows, expandBtn));
    });

    // Render pagination controls
    renderReservationsPagination();
  }

  /**
   * Render pagination controls for reservations
   */
  function renderReservationsPagination() {
    var container = document.getElementById('reservations-pagination');
    if (!container) return;

    var total = reservationsPagination.filtered;
    var limit = reservationsPagination.limit;
    var offset = reservationsPagination.offset;

    // Calculate pages
    var totalPages = Math.ceil(total / limit);
    var currentPage = Math.floor(offset / limit) + 1;

    // Don't show pagination if only one page
    if (totalPages <= 1) {
      container.innerHTML = total > 0 ? '<span class="pagination-info">' + total + ' reservation' + (total !== 1 ? 's' : '') + '</span>' : '';
      return;
    }

    var html = '<div class="pagination-controls">';

    // Previous button
    html += '<button type="button" class="btn-secondary pagination-btn" ' +
      (currentPage <= 1 ? 'disabled' : '') +
      ' data-page="prev">&larr; Previous</button>';

    // Page info
    var startItem = offset + 1;
    var endItem = Math.min(offset + limit, total);
    html += '<span class="pagination-info">' + startItem + '–' + endItem + ' of ' + total + '</span>';

    // Next button
    html += '<button type="button" class="btn-secondary pagination-btn" ' +
      (currentPage >= totalPages ? 'disabled' : '') +
      ' data-page="next">Next &rarr;</button>';

    html += '</div>';

    container.innerHTML = html;

    // Add event listeners
    container.querySelectorAll('.pagination-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var page = this.getAttribute('data-page');
        if (page === 'prev') {
          changeReservationsPage(-1);
        } else if (page === 'next') {
          changeReservationsPage(1);
        }
      });
    });
  }

  function appendTd(tr, text) {
    var td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  }

  function confirmHold(hold, reservation) {
    var qty = parseInt(hold.qty, 10) || 0;
    var holdRow = hold._rowIndex;

    // Find the kit row by SKU
    var kit = kitsData.find(function (k) { return k.sku === hold.sku; });

    // Use Admin API with version checking if available
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      var now = new Date().toISOString();
      adminApiPost('update_hold', {
        holdId: hold.hold_id,
        expectedVersion: hold.last_updated || null,
        updates: {
          status: 'confirmed',
          resolved_at: now,
          resolved_by: userEmail
        }
      })
        .then(function (result) {
          hold.status = 'confirmed';
          hold.resolved_at = now;
          hold.resolved_by = userEmail;
          if (result.newVersion) {
            hold.last_updated = result.newVersion;
          }
          // Update kit stock via direct API (no version conflict likely for inventory)
          if (kit) {
            return updateKitStockAfterConfirm(kit, qty);
          }
        })
        .then(function () {
          checkReservationStatus(reservation);
          renderReservationsTab();
          renderKitsTab();
          renderDashboard();
        })
        .catch(function (err) {
          if (err.message && err.message.indexOf('modified by another user') !== -1) {
            if (confirm(err.message + '\n\nWould you like to refresh the data now?')) {
              loadAllData();
            }
          } else {
            showToast('Failed to confirm hold: ' + err.message, 'error');
          }
        });
      return;
    }

    // Fallback: direct Sheets API
    var updates = [];

    // Update hold status to "confirmed"
    var holdStatusCol = holdsHeaders.indexOf('status');
    var holdResolvedAtCol = holdsHeaders.indexOf('resolved_at');
    var holdResolvedByCol = holdsHeaders.indexOf('resolved_by');
    var holdLastUpdatedCol = holdsHeaders.indexOf('last_updated');
    if (holdStatusCol !== -1) {
      var holdRange = SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdStatusCol) + holdRow;
      updates.push(sheetsUpdate(holdRange, [['confirmed']]));
    }
    if (holdResolvedAtCol !== -1) {
      var resolvedRange = SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdResolvedAtCol) + holdRow;
      updates.push(sheetsUpdate(resolvedRange, [[new Date().toISOString()]]));
    }
    if (holdResolvedByCol !== -1) {
      var byRange = SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdResolvedByCol) + holdRow;
      updates.push(sheetsUpdate(byRange, [[userEmail]]));
    }
    if (holdLastUpdatedCol !== -1) {
      var lastUpdatedRange = SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdLastUpdatedCol) + holdRow;
      updates.push(sheetsUpdate(lastUpdatedRange, [[new Date().toISOString()]]));
    }

    // Update kit: stock -= qty, on_hold -= qty
    if (kit) {
      var stockCol = kitsHeaders.indexOf('stock');
      var onHoldCol = kitsHeaders.indexOf('on_hold');
      if (stockCol !== -1) {
        var newStock = Math.max(0, (parseInt(kit.stock, 10) || 0) - qty);
        var stockRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(stockCol) + kit._rowIndex;
        updates.push(sheetsUpdate(stockRange, [[newStock]]));
        kit.stock = String(newStock);
      }
      if (onHoldCol !== -1) {
        var newOnHold = Math.max(0, (parseInt(kit.on_hold, 10) || 0) - qty);
        var onHoldRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onHoldCol) + kit._rowIndex;
        updates.push(sheetsUpdate(onHoldRange, [[newOnHold]]));
        kit.on_hold = String(newOnHold);
      }
    }

    Promise.all(updates).then(function () {
      hold.status = 'confirmed';
      hold.resolved_at = new Date().toISOString();
      hold.resolved_by = userEmail;
      hold.last_updated = new Date().toISOString();
      checkReservationStatus(reservation);
      renderReservationsTab();
      renderKitsTab();
      renderDashboard();
    }).catch(function (err) {
      showToast('Failed to confirm hold: ' + err.message, 'error');
    });
  }

  function updateKitStockAfterConfirm(kit, qty) {
    var updates = [];
    var stockCol = kitsHeaders.indexOf('stock');
    var onHoldCol = kitsHeaders.indexOf('on_hold');
    if (stockCol !== -1) {
      var newStock = Math.max(0, (parseInt(kit.stock, 10) || 0) - qty);
      var stockRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(stockCol) + kit._rowIndex;
      updates.push(sheetsUpdate(stockRange, [[newStock]]));
      kit.stock = String(newStock);
    }
    if (onHoldCol !== -1) {
      var newOnHold = Math.max(0, (parseInt(kit.on_hold, 10) || 0) - qty);
      var onHoldRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onHoldCol) + kit._rowIndex;
      updates.push(sheetsUpdate(onHoldRange, [[newOnHold]]));
      kit.on_hold = String(newOnHold);
    }
    return Promise.all(updates);
  }

  function releaseHold(hold, reservation) {
    var qty = parseInt(hold.qty, 10) || 0;
    var holdRow = hold._rowIndex;

    var kit = kitsData.find(function (k) { return k.sku === hold.sku; });

    // Use Admin API with version checking if available
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      var now = new Date().toISOString();
      adminApiPost('update_hold', {
        holdId: hold.hold_id,
        expectedVersion: hold.last_updated || null,
        updates: {
          status: 'released',
          resolved_at: now,
          resolved_by: userEmail
        }
      })
        .then(function (result) {
          hold.status = 'released';
          hold.resolved_at = now;
          hold.resolved_by = userEmail;
          if (result.newVersion) {
            hold.last_updated = result.newVersion;
          }
          // Release: only decrement on_hold (stock unchanged)
          if (kit) {
            return updateKitOnHoldAfterRelease(kit, qty);
          }
        })
        .then(function () {
          checkReservationStatus(reservation);
          renderReservationsTab();
          renderKitsTab();
          renderDashboard();
        })
        .catch(function (err) {
          if (err.message && err.message.indexOf('modified by another user') !== -1) {
            if (confirm(err.message + '\n\nWould you like to refresh the data now?')) {
              loadAllData();
            }
          } else {
            showToast('Failed to release hold: ' + err.message, 'error');
          }
        });
      return;
    }

    // Fallback: direct Sheets API
    var updates = [];

    var holdStatusCol = holdsHeaders.indexOf('status');
    var holdResolvedAtCol = holdsHeaders.indexOf('resolved_at');
    var holdResolvedByCol = holdsHeaders.indexOf('resolved_by');
    var holdLastUpdatedCol = holdsHeaders.indexOf('last_updated');
    if (holdStatusCol !== -1) {
      updates.push(sheetsUpdate(
        SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdStatusCol) + holdRow,
        [['released']]
      ));
    }
    if (holdResolvedAtCol !== -1) {
      updates.push(sheetsUpdate(
        SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdResolvedAtCol) + holdRow,
        [[new Date().toISOString()]]
      ));
    }
    if (holdResolvedByCol !== -1) {
      updates.push(sheetsUpdate(
        SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdResolvedByCol) + holdRow,
        [[userEmail]]
      ));
    }
    if (holdLastUpdatedCol !== -1) {
      updates.push(sheetsUpdate(
        SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!' + colLetter(holdLastUpdatedCol) + holdRow,
        [[new Date().toISOString()]]
      ));
    }

    // Release: only decrement on_hold (stock unchanged)
    if (kit) {
      var onHoldCol = kitsHeaders.indexOf('on_hold');
      if (onHoldCol !== -1) {
        var newOnHold = Math.max(0, (parseInt(kit.on_hold, 10) || 0) - qty);
        updates.push(sheetsUpdate(
          SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onHoldCol) + kit._rowIndex,
          [[newOnHold]]
        ));
        kit.on_hold = String(newOnHold);
      }
    }

    Promise.all(updates).then(function () {
      hold.status = 'released';
      hold.resolved_at = new Date().toISOString();
      hold.resolved_by = userEmail;
      hold.last_updated = new Date().toISOString();
      checkReservationStatus(reservation);
      renderReservationsTab();
      renderKitsTab();
      renderDashboard();
    }).catch(function (err) {
      showToast('Failed to release hold: ' + err.message, 'error');
    });
  }

  function updateKitOnHoldAfterRelease(kit, qty) {
    var onHoldCol = kitsHeaders.indexOf('on_hold');
    if (onHoldCol !== -1) {
      var newOnHold = Math.max(0, (parseInt(kit.on_hold, 10) || 0) - qty);
      var onHoldRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onHoldCol) + kit._rowIndex;
      kit.on_hold = String(newOnHold);
      return sheetsUpdate(onHoldRange, [[newOnHold]]);
    }
    return Promise.resolve();
  }

  function confirmAllHolds(reservation, holds) {
    var pending = holds.filter(function (h) { return (h.status || '').toLowerCase() === 'pending'; });
    if (pending.length === 0) return;

    var chain = Promise.resolve();
    pending.forEach(function (hold) {
      chain = chain.then(function () {
        return new Promise(function (resolve) {
          confirmHold(hold, reservation);
          // Small delay to avoid quota issues
          setTimeout(resolve, 200);
        });
      });
    });
  }

  function setReservationStatus(reservation, newStatus) {
    var statusCol = reservationsHeaders.indexOf('status');
    if (statusCol === -1) { showToast('Cannot find status column.', 'warning'); return; }

    // Use Admin API with version checking if available
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      adminApiPost('update_reservation', {
        reservationId: reservation.reservation_id,
        expectedVersion: reservation.last_updated || null,
        updates: { status: newStatus }
      })
        .then(function (result) {
          reservation.status = newStatus;
          if (result.newVersion) {
            reservation.last_updated = result.newVersion;
          }
          renderReservationsTab();
          renderDashboard();
        })
        .catch(function (err) {
          if (err.message && err.message.indexOf('modified by another user') !== -1) {
            if (confirm(err.message + '\n\nWould you like to refresh the data now?')) {
              loadAllData();
            }
          } else {
            showToast('Failed to update reservation: ' + err.message, 'error');
          }
        });
      return;
    }

    // Fallback: direct Sheets API (no version checking)
    var cellRef = SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!' + colLetter(statusCol) + reservation._rowIndex;
    sheetsUpdate(cellRef, [[newStatus]])
      .then(function () {
        reservation.status = newStatus;
        // Update last_updated locally
        var updatedCol = reservationsHeaders.indexOf('last_updated');
        if (updatedCol !== -1) {
          var now = new Date().toISOString();
          var updatedRef = SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!' + colLetter(updatedCol) + reservation._rowIndex;
          sheetsUpdate(updatedRef, [[now]]);
          reservation.last_updated = now;
        }
        renderReservationsTab();
        renderDashboard();
      })
      .catch(function (err) {
        showToast('Failed to update reservation: ' + err.message, 'error');
      });
  }

  function checkReservationStatus(reservation) {
    var resHolds = holdsData.filter(function (h) {
      return h.reservation_id === reservation.reservation_id;
    });
    if (resHolds.length === 0) return;

    var allConfirmed = resHolds.every(function (h) { return h.status === 'confirmed'; });
    var allReleased = resHolds.every(function (h) { return h.status === 'released'; });
    var allResolved = resHolds.every(function (h) { return h.status === 'confirmed' || h.status === 'released'; });

    var newStatus = null;
    if (allConfirmed) newStatus = 'confirmed';
    else if (allReleased) newStatus = 'cancelled';
    else if (allResolved) newStatus = 'confirmed'; // mix of confirmed/released

    if (newStatus && reservation.status !== newStatus) {
      var wasNotConfirmed = reservation.status !== 'confirmed';
      reservation.status = newStatus;

      // Use Admin API if available (no version check since this is auto-triggered)
      if (SHEETS_CONFIG.ADMIN_API_URL) {
        adminApiPost('update_reservation', {
          reservationId: reservation.reservation_id,
          expectedVersion: null, // Skip version check for auto-updates
          updates: { status: newStatus }
        })
          .then(function (result) {
            if (result.newVersion) {
              reservation.last_updated = result.newVersion;
            }
          })
          .catch(function (err) {
            console.error('Failed to auto-update reservation status:', err);
          });
      } else {
        var statusCol = reservationsHeaders.indexOf('status');
        if (statusCol !== -1) {
          sheetsUpdate(
            SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!' + colLetter(statusCol) + reservation._rowIndex,
            [[newStatus]]
          );
          // Also update last_updated
          var updatedCol = reservationsHeaders.indexOf('last_updated');
          if (updatedCol !== -1) {
            var now = new Date().toISOString();
            sheetsUpdate(
              SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!' + colLetter(updatedCol) + reservation._rowIndex,
              [[now]]
            );
            reservation.last_updated = now;
          }
        }
      }

      // Auto-open confirmation email when reservation transitions to confirmed
      if (newStatus === 'confirmed' && wasNotConfirmed && reservation.customer_email) {
        openConfirmationEmail(reservation);
      }
    }
  }

  // ===== Confirmation Email =====

  var emailTemplates = null;

  function loadEmailTemplates() {
    return fetch('content/email-templates.json')
      .then(function (res) { return res.json(); })
      .then(function (data) { emailTemplates = data; })
      .catch(function () { emailTemplates = null; });
  }

  function fillTemplate(template, vars) {
    var result = template;
    Object.keys(vars).forEach(function (key) {
      result = result.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), vars[key]);
    });
    return result;
  }

  function openConfirmationEmail(reservation) {
    var vars = {
      customer: reservation.customer_name || 'Customer',
      email: reservation.customer_email || '',
      products: reservation.products || '',
      timeslot: reservation.timeslot || ''
    };

    function send(subject, body) {
      window.open('mailto:' + encodeURIComponent(vars.email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body), '_blank');
    }

    if (emailTemplates && emailTemplates.confirmation) {
      var tpl = emailTemplates.confirmation;
      send(fillTemplate(tpl.subject, vars), fillTemplate(tpl.body, vars));
    } else {
      // Fallback if templates haven't loaded
      send(
        'Your Steins & Vines Reservation is Confirmed',
        'Hi ' + vars.customer + ',\n\nGreat news! Your reservation has been confirmed.\n\nReserved items: ' + vars.products + '\nAppointment: ' + vars.timeslot + '\n\nYour appointment is to start fermentation in store — it takes about 15 minutes. We\'ll contact you when it\'s time to come back and bottle.\n\nIf you need to reschedule, please reply to this email or give us a call.\n\nSee you soon!\nSteins & Vines'
      );
    }
  }

  // ===== Kit Inventory Tab =====

  var kitSortCol = 'name';
  var kitSortDir = 'asc';

  // Sortable column definitions: header text → data key
  var kitSortableColumns = {
    'SKU': 'sku',
    'Brand': 'brand',
    'Name': 'name',
    'Type': 'type',
    'Tint': 'tint',
    'Stock': 'stock',
    'On Hold': 'on_hold',
    'On Order': 'on_order',
    'Available': '_available',
    'In-Store': 'retail_instore',
    'Kit': 'retail_kit'
  };

  function initKitSortHeaders() {
    var thead = document.querySelector('#kits-table thead tr');
    if (!thead) return;
    var ths = thead.querySelectorAll('th');
    ths.forEach(function (th) {
      var text = th.textContent.trim();
      var dataKey = kitSortableColumns[text];
      if (dataKey) {
        th.className = 'sortable';
        th.setAttribute('data-sort-key', dataKey);
        if (dataKey === kitSortCol) {
          th.classList.add(kitSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
        th.addEventListener('click', function () {
          if (kitSortCol === dataKey) {
            kitSortDir = kitSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            kitSortCol = dataKey;
            kitSortDir = 'asc';
          }
          renderKitsTab();
        });
      }
    });
  }

  function populateKitBrandFilter() {
    var select = document.getElementById('kit-brand-filter');
    if (!select) return;
    var brands = [];
    kitsData.forEach(function (k) {
      if (k.brand && brands.indexOf(k.brand) === -1) brands.push(k.brand);
    });
    brands.sort();
    // Keep "All" option, remove old options
    while (select.options.length > 1) select.remove(1);
    brands.forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      select.appendChild(opt);
    });
  }

  function renderKitsTab() {
    var tbody = document.getElementById('kits-tbody');
    var emptyMsg = document.getElementById('kits-empty');
    if (!tbody) return;

    var brandFilter = document.getElementById('kit-brand-filter').value;
    var stockFilter = document.getElementById('kit-stock-filter').value;
    var searchInput = document.getElementById('kit-search');
    var query = searchInput ? searchInput.value.toLowerCase() : '';

    var filtered = kitsData.filter(function (k) {
      if (brandFilter !== 'all' && k.brand !== brandFilter) return false;
      var available = parseInt(k.available, 10);
      if (isNaN(available)) available = parseInt(k.stock, 10) || 0;
      if (stockFilter === 'in' && available <= 0) return false;
      if (stockFilter === 'low' && (available <= 0 || available > 5)) return false;
      if (stockFilter === 'out' && available > 0) return false;
      if (query) {
        var haystack = ((k.name || '') + ' ' + (k.brand || '') + ' ' + (k.sku || '') + ' ' + (k.type || '') + ' ' + (k.subcategory || '')).toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }
      return true;
    });

    // Sort
    filtered.sort(function (a, b) {
      var aVal, bVal;
      if (kitSortCol === '_available') {
        aVal = (parseInt(a.stock, 10) || 0) - (parseInt(a.on_hold, 10) || 0);
        bVal = (parseInt(b.stock, 10) || 0) - (parseInt(b.on_hold, 10) || 0);
      } else {
        aVal = a[kitSortCol] || '';
        bVal = b[kitSortCol] || '';
      }
      // Try numeric comparison
      var aNum = parseFloat(String(aVal).replace(/[^0-9.\-]/g, ''));
      var bNum = parseFloat(String(bVal).replace(/[^0-9.\-]/g, ''));
      var cmp;
      if (!isNaN(aNum) && !isNaN(bNum)) {
        cmp = aNum - bNum;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return kitSortDir === 'asc' ? cmp : -cmp;
    });

    // Update sort header indicators
    var ths = document.querySelectorAll('#kits-table thead th.sortable');
    ths.forEach(function (th) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.getAttribute('data-sort-key') === kitSortCol) {
        th.classList.add(kitSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });

    tbody.innerHTML = '';

    if (filtered.length === 0) {
      emptyMsg.style.display = '';
      document.getElementById('kits-table').style.display = 'none';
      return;
    }
    emptyMsg.style.display = 'none';
    document.getElementById('kits-table').style.display = '';

    filtered.forEach(function (kit) {
      var tr = document.createElement('tr');

      appendTd(tr, kit.sku || '');
      appendTd(tr, kit.brand || '');
      appendTd(tr, kit.name || '');
      appendTd(tr, kit.type || '');
      appendTd(tr, kit.tint || '');

      // Editable stock cell
      var stockTd = document.createElement('td');
      stockTd.className = 'admin-editable';
      stockTd.textContent = kit.stock || '0';
      stockTd.addEventListener('click', (function (cell, k, field) {
        return function () { startInlineEdit(cell, k, field); };
      })(stockTd, kit, 'stock'));
      tr.appendChild(stockTd);

      // Editable on_hold cell
      var onHoldTd = document.createElement('td');
      onHoldTd.className = 'admin-editable';
      onHoldTd.textContent = kit.on_hold || '0';
      onHoldTd.addEventListener('click', (function (cell, k, field) {
        return function () { startInlineEdit(cell, k, field); };
      })(onHoldTd, kit, 'on_hold'));
      tr.appendChild(onHoldTd);

      // Editable on_order cell
      var onOrderTd = document.createElement('td');
      onOrderTd.className = 'admin-editable';
      onOrderTd.textContent = kit.on_order || '0';
      onOrderTd.addEventListener('click', (function (cell, k, field) {
        return function () { startInlineEdit(cell, k, field); };
      })(onOrderTd, kit, 'on_order'));
      tr.appendChild(onOrderTd);

      // Available with badge
      var available = (parseInt(kit.stock, 10) || 0) - (parseInt(kit.on_hold, 10) || 0);
      var availTd = document.createElement('td');
      availTd.setAttribute('data-avail-sku', kit.sku || kit.name);
      var availBadge = document.createElement('span');
      updateAvailBadge(availBadge, available);
      availTd.appendChild(availBadge);
      tr.appendChild(availTd);

      appendTd(tr, kit.retail_instore ? '$' + String(kit.retail_instore).replace('$', '') : '');
      appendTd(tr, kit.retail_kit ? '$' + String(kit.retail_kit).replace('$', '') : '');

      // Actions column
      var actionsTd = document.createElement('td');
      var holdBtn = document.createElement('button');
      holdBtn.type = 'button';
      holdBtn.className = 'btn-secondary admin-btn-sm';
      holdBtn.textContent = 'Hold';
      holdBtn.addEventListener('click', (function (k) {
        return function () { openManualHoldModal(k); };
      })(kit));
      actionsTd.appendChild(holdBtn);

      var orderBtn = document.createElement('button');
      orderBtn.type = 'button';
      orderBtn.className = 'btn-secondary admin-btn-sm';
      orderBtn.textContent = '+Order';
      orderBtn.addEventListener('click', (function (k) {
        return function () { addToOrder(k.sku || '', k.brand || '', k.name || '', 1); };
      })(kit));
      actionsTd.appendChild(orderBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }

  function openManualHoldModal(kit) {
    var html = '<form id="manual-hold-form" class="admin-modal-form">';
    html += '<div class="form-group"><label>Product</label><input type="text" value="' + escapeHTML((kit.brand || '') + ' ' + (kit.name || '')) + '" disabled></div>';
    html += '<div class="form-group"><label for="hold-qty">Quantity</label><input type="number" id="hold-qty" value="1" min="1" required></div>';
    html += '<div class="form-group"><label for="hold-notes">Notes</label><input type="text" id="hold-notes" placeholder="e.g. Phone order for John"></div>';
    html += '<button type="submit" class="btn">Place Hold</button>';
    html += '</form>';

    openModal('Hold — ' + (kit.name || ''), html);

    document.getElementById('manual-hold-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var qty = parseInt(document.getElementById('hold-qty').value, 10) || 1;
      var notes = sanitizeInput(document.getElementById('hold-notes').value.trim());

      var now = new Date();
      var dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      var holdId = 'H-' + dateStr + '-M' + String(Math.floor(Math.random() * 900) + 100);

      var holdRow = [
        holdId,
        '', // no reservation_id for manual holds
        kit.sku || '',
        (kit.brand || '') + ' ' + (kit.name || ''),
        qty,
        'pending',
        now.toISOString(),
        '', // resolved_at
        '', // resolved_by
        notes
      ];

      // Append hold row
      sheetsAppend(SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!A:A', [holdRow])
        .then(function () {
          // Increment on_hold in Kits sheet
          var onHoldCol = kitsHeaders.indexOf('on_hold');
          if (onHoldCol !== -1) {
            var currentOnHold = parseInt(kit.on_hold, 10) || 0;
            var newOnHold = currentOnHold + qty;
            var range = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onHoldCol) + kit._rowIndex;
            return sheetsUpdate(range, [[newOnHold]]).then(function () {
              kit.on_hold = String(newOnHold);
            });
          }
        })
        .then(function () {
          closeModal();
          loadAllData();
        })
        .catch(function (err) {
          showToast('Failed to place hold: ' + err.message, 'error');
        });
    });
  }

  function updateAvailBadge(badge, available) {
    if (available <= 0) {
      badge.className = 'stock-badge stock-badge--out';
    } else if (available <= 5) {
      badge.className = 'stock-badge stock-badge--low';
    } else {
      badge.className = 'stock-badge stock-badge--in';
    }
    badge.textContent = available;
  }

  function refreshAvailableCell(item) {
    var key = item.sku || item.name;
    var availTd = document.querySelector('[data-avail-sku="' + key + '"]');
    if (!availTd) return;
    var available = (parseInt(item.stock, 10) || 0) - (parseInt(item.on_hold, 10) || 0);
    var badge = availTd.querySelector('.stock-badge');
    if (badge) {
      updateAvailBadge(badge, available);
    }
  }

  function startInlineEdit(cell, item, field) {
    if (cell.querySelector('input')) return; // already editing

    var currentVal = item[field] || '0';
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'admin-inline-input';
    input.value = currentVal;
    input.min = '0';

    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();

    function finishEdit() {
      var newVal = input.value.trim();
      if (newVal === '' || isNaN(newVal)) newVal = currentVal;

      cell.textContent = newVal;
      if (newVal !== currentVal) {
        item[field] = newVal;
        cell.classList.add('admin-cell-changed');
        queueChange(item, field, newVal);
        // Update available column if stock or on_hold changed
        if (field === 'stock' || field === 'on_hold') {
          refreshAvailableCell(item);
        }
      }
    }

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { cell.textContent = currentVal; }
    });
  }

  function queueChange(item, field, value) {
    // Replace existing pending change for same item+field, or add new
    for (var i = 0; i < pendingChanges.length; i++) {
      if (pendingChanges[i].item === item && pendingChanges[i].field === field) {
        pendingChanges[i].value = value;
        updateSaveBar();
        return;
      }
    }
    pendingChanges.push({ item: item, field: field, value: value });
    updateSaveBar();
  }

  function updateSaveBar() {
    var bar = document.getElementById('admin-save-bar');
    if (!bar) return;
    if (pendingChanges.length > 0) {
      bar.style.display = '';
      var count = pendingChanges.length;
      document.getElementById('admin-save-count').textContent =
        count + ' unsaved change' + (count === 1 ? '' : 's');
    } else {
      bar.style.display = 'none';
    }
  }

  function saveAllChanges() {
    if (pendingChanges.length === 0) return;

    var saveBtn = document.getElementById('admin-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

    var updates = [];
    pendingChanges.forEach(function (change) {
      var headers, sheetName;
      if (kitsData.indexOf(change.item) !== -1) {
        headers = kitsHeaders;
        sheetName = SHEETS_CONFIG.SHEET_NAMES.KITS;
      } else {
        headers = ingredientsHeaders;
        sheetName = SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS;
      }

      var colIndex = headers.indexOf(change.field);
      if (colIndex === -1) return;

      var range = sheetName + '!' + colLetter(colIndex) + change.item._rowIndex;
      updates.push(sheetsUpdate(range, [[change.value]]));

      // Also queue last_updated
      var updatedCol = headers.indexOf('last_updated');
      if (updatedCol !== -1) {
        var updatedRange = sheetName + '!' + colLetter(updatedCol) + change.item._rowIndex;
        updates.push(sheetsUpdate(updatedRange, [[new Date().toISOString()]]));
        change.item.last_updated = new Date().toISOString();
      }
    });

    Promise.all(updates).then(function () {
      pendingChanges = [];
      updateSaveBar();
      // Clear changed highlights
      var changed = document.querySelectorAll('.admin-cell-changed');
      changed.forEach(function (el) { el.classList.remove('admin-cell-changed'); });
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save All Changes'; }
    }).catch(function (err) {
      showToast('Failed to save changes: ' + err.message, 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save All Changes'; }
    });
  }

  function discardAllChanges() {
    // Reload data to revert local changes
    pendingChanges = [];
    updateSaveBar();
    loadAllData();
  }

  // Add Kit modal
  document.addEventListener('DOMContentLoaded', function () {
    var addKitBtn = document.getElementById('add-kit-btn');
    if (addKitBtn) {
      addKitBtn.addEventListener('click', function () {
        openAddKitModal();
      });
    }
  });

  function openAddKitModal() {
    var fields = [
      { key: 'type', label: 'Type', type: 'text', value: 'Wine' },
      { key: 'brand', label: 'Brand', type: 'text' },
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'subcategory', label: 'Subcategory', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'retail_instore', label: 'Retail In-Store', type: 'text', placeholder: '$0.00' },
      { key: 'retail_kit', label: 'Retail Kit', type: 'text', placeholder: '$0.00' },
      { key: 'time', label: 'Time', type: 'text', placeholder: '8 weeks' },
      { key: 'wholesale', label: 'Wholesale', type: 'text', placeholder: '$0.00' },
      { key: 'tasting_notes', label: 'Tasting Notes', type: 'text' },
      { key: 'abv', label: 'ABV', type: 'text', placeholder: '13%' },
      { key: 'tint', label: 'Tint Color', type: 'select', options: ['', 'red', 'white', 'rose', 'fruit', 'specialty', 'pilsner', 'amber', 'wheat', 'ipa', 'pale', 'session', 'saison', 'lager', 'stout', 'porter', 'redale', 'brown'] },
      { key: 'stock', label: 'Stock', type: 'number', value: '0' },
      { key: 'on_order', label: 'On Order', type: 'number', value: '0' },
      { key: 'favorite', label: 'Favorite', type: 'select', options: ['FALSE', 'TRUE'] }
    ];

    var html = '<form id="add-kit-form" class="admin-modal-form">';
    fields.forEach(function (f) {
      html += '<div class="form-group">';
      html += '<label for="kit-' + f.key + '">' + f.label + '</label>';
      if (f.type === 'select') {
        html += '<select id="kit-' + f.key + '" class="admin-select">';
        f.options.forEach(function (o) {
          html += '<option value="' + o + '">' + o + '</option>';
        });
        html += '</select>';
      } else {
        html += '<input type="' + f.type + '" id="kit-' + f.key + '"' +
          (f.value ? ' value="' + f.value + '"' : '') +
          (f.placeholder ? ' placeholder="' + f.placeholder + '"' : '') + '>';
      }
      html += '</div>';
    });
    html += '<button type="submit" class="btn">Add Kit</button>';
    html += '</form>';

    openModal('Add Kit', html);

    document.getElementById('add-kit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var row = kitsHeaders.map(function (h) {
        var el = document.getElementById('kit-' + h);
        if (el) {
          // Sanitize text inputs to prevent XSS
          return (el.type === 'text' || el.tagName === 'TEXTAREA')
            ? sanitizeInput(el.value)
            : el.value;
        }
        if (h === 'on_hold') return '0';
        if (h === 'available') return ''; // formula in sheet
        if (h === 'last_updated') return new Date().toISOString();
        return '';
      });

      sheetsAppend(SHEETS_CONFIG.SHEET_NAMES.KITS + '!A:A', [row])
        .then(function () {
          closeModal();
          loadAllData();
        })
        .catch(function (err) {
          showToast('Failed to add kit: ' + err.message, 'error');
        });
    });
  }

  // ===== Ingredients Tab =====

  function renderIngredientsTab() {
    var tbody = document.getElementById('ingredients-tbody');
    var emptyMsg = document.getElementById('ingredients-empty');
    if (!tbody) return;

    var catFilter = document.getElementById('ing-type-filter').value;
    var filtered = ingredientsData;
    if (catFilter !== 'all') {
      filtered = ingredientsData.filter(function (ing) {
        return ing.type === catFilter;
      });
    }

    tbody.innerHTML = '';

    if (filtered.length === 0) {
      emptyMsg.style.display = '';
      document.getElementById('ingredients-table').style.display = 'none';
      return;
    }
    emptyMsg.style.display = 'none';
    document.getElementById('ingredients-table').style.display = '';

    filtered.forEach(function (ing) {
      var tr = document.createElement('tr');

      appendTd(tr, ing.sku || '');
      appendTd(tr, ing.type || '');
      appendTd(tr, ing.name || '');
      appendTd(tr, ing.supplier || '');

      var rawCost = (ing.cost || '').replace(/\$/g, '').trim();
      appendTd(tr, rawCost ? '$' + rawCost : '');

      var actionsTd = document.createElement('td');
      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-secondary admin-btn-sm admin-btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (function (item) {
        return function () { deleteIngredient(item); };
      })(ing));
      actionsTd.appendChild(deleteBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });
  }

  function deleteIngredient(ing) {
    if (!confirm('Delete ingredient "' + ing.name + '"? This cannot be undone.')) return;

    // Delete row by clearing it (Sheets API doesn't support row delete via values API easily)
    var range = SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!' + 'A' + ing._rowIndex + ':' + colLetter(ingredientsHeaders.length - 1) + ing._rowIndex;
    var emptyRow = ingredientsHeaders.map(function () { return ''; });
    sheetsUpdate(range, [emptyRow])
      .then(function () {
        var idx = ingredientsData.indexOf(ing);
        if (idx !== -1) ingredientsData.splice(idx, 1);
        renderIngredientsTab();
      })
      .catch(function (err) {
        showToast('Failed to delete: ' + err.message, 'error');
      });
  }

  // Add Ingredient modal
  document.addEventListener('DOMContentLoaded', function () {
    var addIngBtn = document.getElementById('add-ingredient-btn');
    if (addIngBtn) {
      addIngBtn.addEventListener('click', function () {
        openAddIngredientModal();
      });
    }
  });

  function openAddIngredientModal() {
    var categories = ['Hops', 'Yeast', 'Additives', 'Finings', 'Sugar', 'Other'];
    var units = ['g', 'kg', 'packet', 'ml', 'L'];

    var nextSku = 'ING-' + String(ingredientsData.length + 1).padStart(3, '0');

    var html = '<form id="add-ing-form" class="admin-modal-form">';
    html += '<div class="form-group"><label for="ing-sku">SKU</label><input type="text" id="ing-sku" value="' + nextSku + '"></div>';
    html += '<div class="form-group"><label for="ing-type">Category</label><select id="ing-type" class="admin-select">';
    categories.forEach(function (c) { html += '<option value="' + c + '">' + c + '</option>'; });
    html += '</select></div>';
    html += '<div class="form-group"><label for="ing-name">Name</label><input type="text" id="ing-name" required></div>';
    html += '<div class="form-group"><label for="ing-unit">Unit</label><select id="ing-unit" class="admin-select">';
    units.forEach(function (u) { html += '<option value="' + u + '">' + u + '</option>'; });
    html += '</select></div>';
    html += '<div class="form-group"><label for="ing-stock_qty">Stock Qty</label><input type="number" id="ing-stock_qty" value="0" min="0"></div>';
    html += '<div class="form-group"><label for="ing-reorder_level">Reorder Level</label><input type="number" id="ing-reorder_level" value="0" min="0"></div>';
    html += '<div class="form-group"><label for="ing-supplier">Supplier</label><input type="text" id="ing-supplier"></div>';
    html += '<div class="form-group"><label for="ing-cost">Cost</label><input type="text" id="ing-cost" placeholder="$0.00"></div>';
    html += '<div class="form-group"><label for="ing-notes">Notes</label><input type="text" id="ing-notes"></div>';
    html += '<button type="submit" class="btn">Add Ingredient</button>';
    html += '</form>';

    openModal('Add Ingredient', html);

    document.getElementById('add-ing-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var row = ingredientsHeaders.map(function (h) {
        var el = document.getElementById('ing-' + h);
        if (el) {
          // Sanitize text inputs to prevent XSS
          return (el.type === 'text' || el.tagName === 'TEXTAREA')
            ? sanitizeInput(el.value)
            : el.value;
        }
        if (h === 'last_updated') return new Date().toISOString();
        return '';
      });

      sheetsAppend(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:A', [row])
        .then(function () {
          closeModal();
          loadAllData();
        })
        .catch(function (err) {
          showToast('Failed to add ingredient: ' + err.message, 'error');
        });
    });
  }

  // ===== Supplier Orders =====

  var orderSortCol = 'brand';
  var orderSortDir = 'asc';

  var orderSortableColumns = {
    'SKU': 'sku',
    'Brand': 'brand',
    'Name': 'name',
    'Qty': 'qty',
    'Cost': '_cost',
    'Line Total': '_total'
  };

  function initOrderSortHeaders() {
    var thead = document.querySelector('#order-table thead tr');
    if (!thead) return;
    var ths = thead.querySelectorAll('th');
    ths.forEach(function (th) {
      var text = th.textContent.trim();
      var dataKey = orderSortableColumns[text];
      if (dataKey) {
        th.className = 'sortable';
        th.setAttribute('data-sort-key', dataKey);
        if (dataKey === orderSortCol) {
          th.classList.add(orderSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
        th.addEventListener('click', function () {
          if (orderSortCol === dataKey) {
            orderSortDir = orderSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            orderSortCol = dataKey;
            orderSortDir = 'asc';
          }
          renderOrderTab();
        });
      }
    });
  }

  function initOrderFilterListeners() {
    var searchInput = document.getElementById('order-search');
    var orderSearchTimer;
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(orderSearchTimer);
        orderSearchTimer = setTimeout(renderOrderTab, 300);
      });
    }

    var brandFilter = document.getElementById('order-brand-filter');
    if (brandFilter) brandFilter.addEventListener('change', renderOrderTab);

    initOrderSortHeaders();
  }

  function populateOrderBrandFilter() {
    var select = document.getElementById('order-brand-filter');
    if (!select) return;
    var order = getOrder();
    var brands = [];
    order.forEach(function (item) {
      if (item.brand && brands.indexOf(item.brand) === -1) brands.push(item.brand);
    });
    brands.sort();
    while (select.options.length > 1) select.remove(1);
    brands.forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      select.appendChild(opt);
    });
  }

  var ORDER_STORAGE_KEY = 'sv-admin-order';

  function getOrder() {
    try {
      return JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY)) || [];
    } catch (e) {
      return [];
    }
  }

  function saveOrder(items) {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(items));
  }

  /**
   * Load order items from the sheet's on_order column into localStorage
   * Called after kitsData is loaded to sync sheet -> localStorage
   */
  function loadOrderFromSheet() {
    if (kitsData.length === 0) return;

    var order = [];
    kitsData.forEach(function (kit) {
      var onOrder = parseInt(kit.on_order, 10) || 0;
      if (onOrder > 0 && kit.sku) {
        order.push({
          sku: kit.sku,
          brand: kit.brand || '',
          name: kit.name || '',
          qty: onOrder
        });
      }
    });

    if (order.length > 0) {
      saveOrder(order);
      populateOrderBrandFilter();
      renderOrderTab();
      console.log('[Admin] Loaded ' + order.length + ' item(s) from sheet on_order column');
    }
  }

  var MULTIPLES_OF_TWO_BRANDS = ['Heritage Estates', 'Orchard Breezin\''];

  function requiresMultiplesOfTwo(brand) {
    return MULTIPLES_OF_TWO_BRANDS.indexOf(brand) !== -1;
  }

  function syncOnOrder(changedSkus) {
    if (!accessToken || kitsData.length === 0) return;
    var onOrderCol = kitsHeaders.indexOf('on_order');
    if (onOrderCol === -1) return;

    var order = getOrder();
    var updates = [];

    changedSkus.forEach(function (sku) {
      var kit = kitsData.find(function (k) { return k.sku === sku; });
      if (!kit) return;

      var orderItem = order.find(function (o) { return o.sku === sku; });
      var newOnOrder = orderItem ? orderItem.qty : 0;

      var range = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onOrderCol) + kit._rowIndex;
      updates.push(sheetsUpdate(range, [[newOnOrder]]));
      kit.on_order = String(newOnOrder);
    });

    if (updates.length > 0) {
      Promise.all(updates).then(function () {
        renderKitsTab();
      }).catch(function (err) {
        console.error('Failed to sync on_order:', err);
      });
    }
  }

  function addToOrder(sku, brand, name, qty) {
    var step = requiresMultiplesOfTwo(brand) ? 2 : 1;
    // Round qty up to nearest valid step
    if (step === 2 && qty % 2 !== 0) {
      qty = Math.ceil(qty / 2) * 2;
    }
    var order = getOrder();
    // If same SKU already in order, increment qty
    for (var i = 0; i < order.length; i++) {
      if (order[i].sku === sku) {
        order[i].qty += qty;
        if (step === 2 && order[i].qty % 2 !== 0) {
          order[i].qty = Math.ceil(order[i].qty / 2) * 2;
        }
        saveOrder(order);
        syncOnOrder([sku]);
        renderOrderTab();
        return;
      }
    }
    order.push({ sku: sku, brand: brand, name: name, qty: qty });
    saveOrder(order);
    syncOnOrder([sku]);
    populateOrderBrandFilter();
    renderOrderTab();
  }

  function removeFromOrder(sku) {
    var order = getOrder().filter(function (item) { return item.sku !== sku; });
    saveOrder(order);
    syncOnOrder([sku]);
    populateOrderBrandFilter();
    renderOrderTab();
  }

  function updateOrderQty(sku, newQty) {
    var order = getOrder();
    for (var i = 0; i < order.length; i++) {
      if (order[i].sku === sku) {
        var step = requiresMultiplesOfTwo(order[i].brand) ? 2 : 1;
        if (newQty <= 0) {
          order.splice(i, 1);
        } else {
          if (step === 2 && newQty % 2 !== 0) {
            newQty = Math.ceil(newQty / 2) * 2;
          }
          order[i].qty = newQty;
        }
        break;
      }
    }
    saveOrder(order);
    syncOnOrder([sku]);
    populateOrderBrandFilter();
    renderOrderTab();
  }

  function renderOrderTab() {
    var tbody = document.getElementById('order-tbody');
    var emptyMsg = document.getElementById('order-empty');
    var table = document.getElementById('order-table');
    if (!tbody) return;

    var order = getOrder();
    tbody.innerHTML = '';

    // Apply search filter
    var searchInput = document.getElementById('order-search');
    var query = searchInput ? searchInput.value.toLowerCase() : '';

    // Apply brand filter
    var brandFilterEl = document.getElementById('order-brand-filter');
    var brandFilter = brandFilterEl ? brandFilterEl.value : 'all';

    var filtered = order.filter(function (item) {
      if (brandFilter !== 'all' && item.brand !== brandFilter) return false;
      if (query) {
        var haystack = ((item.name || '') + ' ' + (item.brand || '') + ' ' + (item.sku || '')).toLowerCase();
        if (haystack.indexOf(query) === -1) return false;
      }
      return true;
    });

    // Apply sorting
    filtered.sort(function (a, b) {
      var aVal, bVal;
      if (orderSortCol === '_cost' || orderSortCol === '_total') {
        var aKit = kitsData.find(function (k) { return k.sku === a.sku; });
        var bKit = kitsData.find(function (k) { return k.sku === b.sku; });
        var aCost = aKit && aKit.wholesale ? parseFloat(String(aKit.wholesale).replace(/[^0-9.\-]/g, '')) || 0 : 0;
        var bCost = bKit && bKit.wholesale ? parseFloat(String(bKit.wholesale).replace(/[^0-9.\-]/g, '')) || 0 : 0;
        if (orderSortCol === '_total') {
          aVal = aCost * a.qty;
          bVal = bCost * b.qty;
        } else {
          aVal = aCost;
          bVal = bCost;
        }
      } else if (orderSortCol === 'qty') {
        aVal = a.qty || 0;
        bVal = b.qty || 0;
      } else {
        aVal = a[orderSortCol] || '';
        bVal = b[orderSortCol] || '';
      }
      var aNum = parseFloat(String(aVal).replace(/[^0-9.\-]/g, ''));
      var bNum = parseFloat(String(bVal).replace(/[^0-9.\-]/g, ''));
      var cmp;
      if (!isNaN(aNum) && !isNaN(bNum)) {
        cmp = aNum - bNum;
      } else {
        cmp = String(aVal).localeCompare(String(bVal));
      }
      return orderSortDir === 'asc' ? cmp : -cmp;
    });

    // Update sort header indicators
    var ths = document.querySelectorAll('#order-table thead th.sortable');
    ths.forEach(function (th) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.getAttribute('data-sort-key') === orderSortCol) {
        th.classList.add(orderSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      }
    });

    if (filtered.length === 0) {
      if (emptyMsg) emptyMsg.style.display = '';
      if (table) table.style.display = 'none';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    if (table) table.style.display = '';

    // Wire up "select all" checkbox
    var selectAllCb = document.getElementById('order-select-all');
    if (selectAllCb) {
      selectAllCb.checked = true;
      selectAllCb.onchange = function () {
        var cbs = tbody.querySelectorAll('.order-item-cb');
        for (var i = 0; i < cbs.length; i++) { cbs[i].checked = selectAllCb.checked; }
      };
    }

    var orderTotal = 0;

    filtered.forEach(function (item) {
      var tr = document.createElement('tr');

      // Checkbox cell
      var cbTd = document.createElement('td');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.className = 'order-item-cb';
      cb.setAttribute('data-sku', item.sku);
      cb.addEventListener('change', function () {
        if (!cb.checked && selectAllCb) selectAllCb.checked = false;
      });
      cbTd.appendChild(cb);
      tr.appendChild(cbTd);

      appendTd(tr, item.sku || '');
      appendTd(tr, item.brand || '');
      var nameTd = document.createElement('td');
      nameTd.textContent = item.name || '';
      if (requiresMultiplesOfTwo(item.brand)) {
        var pack = document.createElement('span');
        pack.textContent = ' (2-pack)';
        pack.style.color = '#888';
        pack.style.fontSize = '0.85em';
        nameTd.appendChild(pack);
      }
      tr.appendChild(nameTd);

      // Editable qty
      var qtyTd = document.createElement('td');
      var qtyControls = document.createElement('div');
      qtyControls.className = 'product-qty-controls';

      var step = requiresMultiplesOfTwo(item.brand) ? 2 : 1;

      var minusBtn = document.createElement('button');
      minusBtn.type = 'button';
      minusBtn.className = 'qty-btn';
      minusBtn.textContent = '\u2212';
      minusBtn.addEventListener('click', (function (s, q, st) {
        return function () { updateOrderQty(s, q - st); };
      })(item.sku, item.qty, step));

      var qtySpan = document.createElement('span');
      qtySpan.className = 'qty-value';
      qtySpan.textContent = item.qty;

      var plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.className = 'qty-btn';
      plusBtn.textContent = '+';
      plusBtn.addEventListener('click', (function (s, q, st) {
        return function () { updateOrderQty(s, q + st); };
      })(item.sku, item.qty, step));

      qtyControls.appendChild(minusBtn);
      qtyControls.appendChild(qtySpan);
      qtyControls.appendChild(plusBtn);
      qtyTd.appendChild(qtyControls);
      tr.appendChild(qtyTd);

      // Wholesale cost and line total
      var kit = kitsData.find(function (k) { return k.sku === item.sku; });
      var unitCost = 0;
      var costStr = '';
      if (kit && kit.wholesale) {
        costStr = String(kit.wholesale);
        unitCost = parseFloat(String(kit.wholesale).replace(/[^0-9.\-]/g, '')) || 0;
      }
      var lineTotal = unitCost * item.qty;
      orderTotal += lineTotal;
      appendTd(tr, unitCost ? '$' + unitCost.toFixed(2) : '');
      appendTd(tr, unitCost ? '$' + lineTotal.toFixed(2) : '');

      var actionsTd = document.createElement('td');
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn-secondary admin-btn-sm admin-btn-danger';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', (function (s) {
        return function () { removeFromOrder(s); };
      })(item.sku));
      actionsTd.appendChild(removeBtn);
      tr.appendChild(actionsTd);

      tbody.appendChild(tr);
    });

    // Total row
    var totalTr = document.createElement('tr');
    totalTr.style.fontWeight = '700';
    var colSpan = 6; // checkbox + sku + brand + name + qty + cost
    var spacerTd = document.createElement('td');
    spacerTd.colSpan = colSpan;
    spacerTd.style.textAlign = 'right';
    spacerTd.textContent = 'Order Total:';
    totalTr.appendChild(spacerTd);
    var totalTd = document.createElement('td');
    totalTd.textContent = '$' + orderTotal.toFixed(2);
    totalTr.appendChild(totalTd);
    var emptyTd = document.createElement('td');
    totalTr.appendChild(emptyTd);
    tbody.appendChild(totalTr);
  }

  var orderKitOptions = [];

  function populateOrderKitSelect() {
    orderKitOptions = kitsData.map(function (kit) {
      return {
        sku: kit.sku || '',
        brand: kit.brand || '',
        name: kit.name || '',
        label: (kit.brand || '') + ' — ' + (kit.name || '') + ' (' + (kit.sku || '') + ')'
      };
    });
  }

  function initKitSearchDropdown() {
    var input = document.getElementById('order-kit-search');
    var dropdown = document.getElementById('order-kit-dropdown');
    var hidden = document.getElementById('order-kit-select');
    if (!input || !dropdown || !hidden) return;

    var activeIndex = -1;

    function renderDropdown(query) {
      console.log('[Order] renderDropdown called, query:', query, 'options count:', orderKitOptions.length);
      var q = (query || '').toLowerCase();
      var matches = orderKitOptions.filter(function (opt) {
        if (!q) return true;
        return opt.label.toLowerCase().indexOf(q) !== -1;
      });
      console.log('[Order] matches:', matches.length);

      dropdown.innerHTML = '';
      activeIndex = -1;

      if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
      }

      matches.forEach(function (opt, idx) {
        var div = document.createElement('div');
        div.className = 'admin-kit-search-option';
        div.textContent = opt.label;
        div.setAttribute('data-index', idx);
        div.addEventListener('mousedown', function (e) {
          e.preventDefault(); // prevent input blur
          selectOption(opt);
        });
        dropdown.appendChild(div);
      });

      dropdown.style.display = 'block';
    }

    function selectOption(opt) {
      input.value = opt.label;
      hidden.value = opt.sku;
      hidden.setAttribute('data-brand', opt.brand);
      hidden.setAttribute('data-name', opt.name);
      dropdown.style.display = 'none';
      // Auto-set qty to 2 for brands that require multiples of 2
      var qtyInput = document.getElementById('order-kit-qty');
      if (qtyInput && requiresMultiplesOfTwo(opt.brand)) {
        qtyInput.value = '2';
        qtyInput.step = '2';
        qtyInput.min = '2';
      } else if (qtyInput) {
        qtyInput.value = '1';
        qtyInput.step = '1';
        qtyInput.min = '1';
      }
    }

    function highlightOption(idx) {
      var options = dropdown.querySelectorAll('.admin-kit-search-option');
      options.forEach(function (el) { el.classList.remove('active'); });
      if (idx >= 0 && idx < options.length) {
        options[idx].classList.add('active');
        options[idx].scrollIntoView({ block: 'nearest' });
      }
    }

    input.addEventListener('focus', function () {
      hidden.value = '';
      renderDropdown(input.value);
    });

    input.addEventListener('input', function () {
      hidden.value = '';
      renderDropdown(input.value);
    });

    input.addEventListener('blur', function () {
      // Delay to allow mousedown on option
      setTimeout(function () { dropdown.style.display = 'none'; }, 150);
    });

    input.addEventListener('keydown', function (e) {
      var options = dropdown.querySelectorAll('.admin-kit-search-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, options.length - 1);
        highlightOption(activeIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        highlightOption(activeIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < options.length) {
          var q = (input.value || '').toLowerCase();
          var matches = orderKitOptions.filter(function (opt) {
            if (!q) return true;
            return opt.label.toLowerCase().indexOf(q) !== -1;
          });
          if (matches[activeIndex]) selectOption(matches[activeIndex]);
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        input.blur();
      }
    });
  }

  function copyOrderToClipboard() {
    var order = getOrder();
    if (order.length === 0) { showToast('Order is empty.', 'warning'); return; }

    var lines = order.map(function (item) {
      return item.qty + 'x  ' + item.brand + ' — ' + item.name + '  (SKU: ' + item.sku + ')';
    });
    var text = 'Supplier Order — ' + new Date().toLocaleDateString() + '\n' +
      '—————————————————————\n' +
      lines.join('\n') +
      '\n—————————————————————\n' +
      'Total items: ' + order.reduce(function (sum, i) { return sum + i.qty; }, 0);

    navigator.clipboard.writeText(text).then(function () {
      var btn = document.getElementById('order-copy-btn');
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = 'Copy Order List'; }, 2000);
    }).catch(function () {
      // Fallback: select from a textarea
      prompt('Copy this order:', text);
    });
  }

  function acceptDelivery() {
    var order = getOrder();
    if (order.length === 0) { showToast('Order is empty.', 'warning'); return; }

    // Determine which SKUs are checked
    var checkedSkus = {};
    var cbs = document.querySelectorAll('.order-item-cb:checked');
    for (var i = 0; i < cbs.length; i++) {
      checkedSkus[cbs[i].getAttribute('data-sku')] = true;
    }

    var acceptedItems = order.filter(function (item) { return checkedSkus[item.sku]; });
    var remainingItems = order.filter(function (item) { return !checkedSkus[item.sku]; });

    if (acceptedItems.length === 0) { showToast('No items selected.', 'warning'); return; }

    var msg = 'Accept delivery for ' + acceptedItems.length + ' of ' + order.length + ' item(s)? This will add ordered quantities to stock and subtract from on_order for the selected kits.';
    if (!confirm(msg)) return;

    var acceptBtn = document.getElementById('order-accept-btn');
    if (acceptBtn) { acceptBtn.disabled = true; acceptBtn.textContent = 'Processing...'; }

    var updates = [];

    acceptedItems.forEach(function (item) {
      var kit = kitsData.find(function (k) { return k.sku === item.sku; });
      if (!kit) return;

      // Add qty to stock
      var stockCol = kitsHeaders.indexOf('stock');
      if (stockCol !== -1) {
        var newStock = (parseInt(kit.stock, 10) || 0) + item.qty;
        var stockRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(stockCol) + kit._rowIndex;
        updates.push(sheetsUpdate(stockRange, [[newStock]]));
        kit.stock = String(newStock);
      }

      // Reset on_order to 0 (item fulfilled)
      var onOrderCol = kitsHeaders.indexOf('on_order');
      if (onOrderCol !== -1) {
        var onOrderRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onOrderCol) + kit._rowIndex;
        updates.push(sheetsUpdate(onOrderRange, [[0]]));
        kit.on_order = '0';
      }

      // Update last_updated
      var updatedCol = kitsHeaders.indexOf('last_updated');
      if (updatedCol !== -1) {
        var updatedRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(updatedCol) + kit._rowIndex;
        updates.push(sheetsUpdate(updatedRange, [[new Date().toISOString()]]));
      }
    });

    Promise.all(updates).then(function () {
      saveOrder(remainingItems);
      renderOrderTab();
      renderKitsTab();
      if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Accept Delivery'; }
      showToast('Delivery accepted. Stock updated for ' + acceptedItems.length + ' item(s).' + (remainingItems.length > 0 ? ' ' + remainingItems.length + ' item(s) remain in the order.' : ''), 'success');
    }).catch(function (err) {
      if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Accept Delivery'; }
      showToast('Failed to update stock: ' + err.message, 'error');
    });
  }

  function clearOrder() {
    if (!confirm('Clear the entire order? This cannot be undone.')) return;
    var skus = getOrder().map(function (item) { return item.sku; });
    saveOrder([]);
    syncOnOrder(skus);
    renderOrderTab();
  }

  function importOrderCSV(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var lines = e.target.result.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) { showToast('CSV must have a header row and at least one data row.', 'warning'); return; }

      var headers = parseCSVLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
      var skuCol = headers.indexOf('sku');
      var qtyCol = headers.indexOf('qty');
      if (skuCol === -1 || qtyCol === -1) { showToast('CSV must have "SKU" and "Qty" columns.', 'warning'); return; }

      var added = 0;
      var skippedSkus = [];

      for (var i = 1; i < lines.length; i++) {
        var cols = parseCSVLine(lines[i]);
        var sku = (cols[skuCol] || '').trim();
        var qty = parseInt(cols[qtyCol], 10);
        if (!sku || isNaN(qty) || qty <= 0) continue;

        var kit = kitsData.find(function (k) { return k.sku === sku; });
        if (!kit) { skippedSkus.push(sku); continue; }

        addToOrder(sku, kit.brand, kit.name, qty);
        added++;
      }

      var msg = added + ' item(s) added to order.';
      if (skippedSkus.length > 0) {
        msg += '\n' + skippedSkus.length + ' skipped (unrecognized SKUs: ' + skippedSkus.join(', ') + ')';
      }
      showToast(msg, 'success');
    };
    reader.readAsText(file);
  }

  function initOrderControls() {
    initKitSearchDropdown();

    var addBtn = document.getElementById('order-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var hidden = document.getElementById('order-kit-select');
        var searchInput = document.getElementById('order-kit-search');
        var qtyInput = document.getElementById('order-kit-qty');
        var sku = hidden.value;
        if (!sku) { showToast('Type and select a kit first.', 'warning'); return; }
        var qty = parseInt(qtyInput.value, 10) || 1;
        var brand = hidden.getAttribute('data-brand') || '';
        var name = hidden.getAttribute('data-name') || '';
        addToOrder(sku, brand, name, qty);
        hidden.value = '';
        searchInput.value = '';
        qtyInput.value = '1';
      });
    }

    var copyBtn = document.getElementById('order-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', copyOrderToClipboard);

    var acceptBtn = document.getElementById('order-accept-btn');
    if (acceptBtn) acceptBtn.addEventListener('click', acceptDelivery);

    var clearBtn = document.getElementById('order-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearOrder);

    var importBtn = document.getElementById('order-import-btn');
    var importFile = document.getElementById('order-import-file');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function () {
        if (importFile.files.length > 0) importOrderCSV(importFile.files[0]);
        importFile.value = '';
      });
    }
  }

  // ===== Scheduling =====

  var DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function getDefaultSchedule() {
    var stored = localStorage.getItem('sv_schedule_defaults');
    if (stored) {
      try {
        var parsed = JSON.parse(stored);
        parsed.forEach(function (d) {
          if (!d.blockedSlots) d.blockedSlots = [];
        });
        return parsed;
      } catch (e) { /* fall through */ }
    }
    return [
      { day: 'Sun', start: '', end: '', open: false, blockedSlots: [] },
      { day: 'Mon', start: '', end: '', open: false, blockedSlots: [] },
      { day: 'Tue', start: '10:00 AM', end: '4:00 PM', open: true, blockedSlots: [] },
      { day: 'Wed', start: '10:00 AM', end: '4:00 PM', open: true, blockedSlots: [] },
      { day: 'Thu', start: '12:00 PM', end: '7:00 PM', open: true, blockedSlots: [] },
      { day: 'Fri', start: '10:00 AM', end: '4:00 PM', open: true, blockedSlots: [] },
      { day: 'Sat', start: '10:00 AM', end: '4:00 PM', open: true, blockedSlots: [] }
    ];
  }

  function saveDefaultSchedule(defaults) {
    localStorage.setItem('sv_schedule_defaults', JSON.stringify(defaults));
  }

  function buildTimeOptions() {
    var opts = [''];
    for (var h = 6; h <= 21; h++) {
      for (var m = 0; m < 60; m += 30) {
        var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        var suffix = h >= 12 ? 'PM' : 'AM';
        var mm = m < 10 ? '0' + m : '' + m;
        opts.push(hr12 + ':' + mm + ' ' + suffix);
      }
    }
    return opts;
  }

  function renderDefaultsTable() {
    var tbody = document.getElementById('schedule-defaults-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var defaults = getDefaultSchedule();
    var timeOpts = buildTimeOptions();

    defaults.forEach(function (d, idx) {
      var tr = document.createElement('tr');

      // Day
      var tdDay = document.createElement('td');
      tdDay.textContent = d.day;
      tr.appendChild(tdDay);

      // Start select
      var tdStart = document.createElement('td');
      var selStart = document.createElement('select');
      selStart.className = 'admin-select';
      selStart.dataset.idx = idx;
      selStart.dataset.field = 'start';
      timeOpts.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t || '—';
        if (t === d.start) opt.selected = true;
        selStart.appendChild(opt);
      });
      tdStart.appendChild(selStart);
      tr.appendChild(tdStart);

      // End select
      var tdEnd = document.createElement('td');
      var selEnd = document.createElement('select');
      selEnd.className = 'admin-select';
      selEnd.dataset.idx = idx;
      selEnd.dataset.field = 'end';
      timeOpts.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t || '—';
        if (t === d.end) opt.selected = true;
        selEnd.appendChild(opt);
      });
      tdEnd.appendChild(selEnd);
      tr.appendChild(tdEnd);

      // Status toggle
      var tdStatus = document.createElement('td');
      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-secondary admin-btn-sm' + (d.open ? ' schedule-open' : ' schedule-closed');
      toggleBtn.textContent = d.open ? 'Open' : 'Closed';
      toggleBtn.dataset.idx = idx;
      toggleBtn.addEventListener('click', function () {
        var i = parseInt(this.dataset.idx, 10);
        var defs = getDefaultSchedule();
        defs[i].open = !defs[i].open;
        if (!defs[i].open) { defs[i].start = ''; defs[i].end = ''; }
        saveDefaultSchedule(defs);
        renderDefaultsTable();
      });
      tdStatus.appendChild(toggleBtn);
      tr.appendChild(tdStatus);

      tbody.appendChild(tr);

      // Blocked-slot pills row for open days with valid start/end
      if (d.open && d.start && d.end) {
        var pillTr = document.createElement('tr');
        var pillTd = document.createElement('td');
        pillTd.colSpan = 4;
        pillTd.className = 'schedule-default-slots';

        var blocked = d.blockedSlots || [];
        var slots = generateTimeSlots(d.start, d.end);
        slots.forEach(function (time) {
          var pill = document.createElement('button');
          pill.type = 'button';
          var isBlocked = blocked.indexOf(time) !== -1;
          pill.className = 'schedule-default-slot' + (isBlocked ? ' blocked' : '');
          pill.textContent = time;
          pill.addEventListener('click', function () {
            var defs = getDefaultSchedule();
            if (!defs[idx].blockedSlots) defs[idx].blockedSlots = [];
            var pos = defs[idx].blockedSlots.indexOf(time);
            if (pos !== -1) {
              defs[idx].blockedSlots.splice(pos, 1);
            } else {
              defs[idx].blockedSlots.push(time);
            }
            saveDefaultSchedule(defs);
            renderDefaultsTable();
          });
          pillTd.appendChild(pill);
        });

        pillTr.appendChild(pillTd);
        tbody.appendChild(pillTr);
      }
    });
  }

  function readDefaultsFromTable() {
    var tbody = document.getElementById('schedule-defaults-tbody');
    if (!tbody) return getDefaultSchedule();
    var defaults = getDefaultSchedule();
    var selects = tbody.querySelectorAll('select');
    selects.forEach(function (sel) {
      var idx = parseInt(sel.dataset.idx, 10);
      var field = sel.dataset.field;
      defaults[idx][field] = sel.value;
      if (defaults[idx].start && defaults[idx].end) defaults[idx].open = true;
    });
    return defaults;
  }

  function generateTimeSlots(startStr, endStr) {
    var slots = [];
    if (!startStr || !endStr) return slots;
    var startMin = parseTimeToMinutes(startStr);
    var endMin = parseTimeToMinutes(endStr);
    for (var m = startMin; m < endMin; m += 30) {
      slots.push(minutesToTimeStr(m));
    }
    return slots;
  }

  function parseTimeToMinutes(str) {
    var parts = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!parts) return 0;
    var h = parseInt(parts[1], 10);
    var m = parseInt(parts[2], 10);
    var ampm = parts[3].toUpperCase();
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }

  function minutesToTimeStr(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    var ampm = h >= 12 ? 'PM' : 'AM';
    var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
    var mm = m < 10 ? '0' + m : '' + m;
    return hr12 + ':' + mm + ' ' + ampm;
  }

  function getMonthPrefix() {
    var year = scheduleCalMonth.getFullYear();
    var m = scheduleCalMonth.getMonth() + 1;
    return year + '-' + (m < 10 ? '0' + m : m);
  }

  function generateSlotsForMonth() {
    if (!scheduleCalMonth) return;
    var defaults = getDefaultSchedule();
    var year = scheduleCalMonth.getFullYear();
    var month = scheduleCalMonth.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var monthName = scheduleCalMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build a lookup of existing dates+times
    var existing = {};
    scheduleData.forEach(function (row) {
      existing[row.date + '|' + row.time] = true;
    });

    var newRows = [];
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(year, month, d);
      if (date < today) continue;
      var dayOfWeek = date.getDay();
      var def = defaults[dayOfWeek];
      if (!def.open || !def.start || !def.end) continue;

      var dateStr = formatDateISO(date);
      var blocked = def.blockedSlots || [];
      var slots = generateTimeSlots(def.start, def.end);
      slots.forEach(function (time) {
        if (blocked.indexOf(time) !== -1) return;
        if (!existing[dateStr + '|' + time]) {
          newRows.push([dateStr, time, 'available']);
        }
      });
    }

    if (newRows.length === 0) {
      showToast('No new slots to generate for ' + monthName + ' (all slots already exist).', 'warning');
      return;
    }

    if (!confirm('Generate ' + newRows.length + ' new slot(s) for ' + monthName + '?')) return;

    sheetsAppend(SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!A:C', newRows)
      .then(function () {
        showToast(newRows.length + ' slots generated for ' + monthName + '.', 'success');
        loadAllData();
      })
      .catch(function (err) {
        showToast('Failed to generate slots: ' + err.message, 'error');
      });
  }

  function formatDateISO(d) {
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  // Calendar state
  var scheduleCalMonth = null; // Date object for the displayed month
  var scheduleSelectedDate = null; // 'YYYY-MM-DD' of selected day

  function renderScheduleTab() {
    renderDefaultsTable();
    if (!scheduleCalMonth) {
      scheduleCalMonth = new Date();
      scheduleCalMonth.setDate(1);
    }
    renderScheduleCalendar();
  }

  function renderScheduleCalendar() {
    var container = document.getElementById('schedule-cal');
    if (!container) return;

    var year = scheduleCalMonth.getFullYear();
    var month = scheduleCalMonth.getMonth();
    var monthName = scheduleCalMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

    // Group schedule data by date
    var slotsByDate = {};
    scheduleData.forEach(function (row) {
      if (!slotsByDate[row.date]) slotsByDate[row.date] = [];
      slotsByDate[row.date].push(row);
    });

    var html = '<div class="schedule-cal-header">';
    html += '<button type="button" class="btn-secondary admin-btn-sm schedule-cal-prev">&laquo;</button>';
    html += '<span class="schedule-cal-title">' + escapeHTML(monthName) + '</span>';
    html += '<button type="button" class="btn-secondary admin-btn-sm schedule-cal-next">&raquo;</button>';
    html += '</div>';
    html += '<div class="schedule-cal-actions">';
    html += '<button type="button" class="btn admin-btn-sm" id="schedule-generate-month-btn">Generate Slots</button>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="schedule-reset-month-btn">Reset to Defaults</button>';
    html += '</div>';

    html += '<div class="schedule-cal-grid">';
    // Day headers
    DAYS_OF_WEEK.forEach(function (d) {
      html += '<div class="schedule-cal-dayheader">' + d + '</div>';
    });

    // First day offset
    var firstDay = new Date(year, month, 1).getDay();
    for (var i = 0; i < firstDay; i++) {
      html += '<div class="schedule-cal-cell empty"></div>';
    }

    var defaults = getDefaultSchedule();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var d = 1; d <= daysInMonth; d++) {
      var dateObj = new Date(year, month, d);
      var dateStr = formatDateISO(dateObj);
      var dayOfWeek = dateObj.getDay();
      var def = defaults[dayOfWeek];
      var isClosed = !def.open;
      var slots = slotsByDate[dateStr] || [];
      var available = slots.filter(function (s) { return s.status === 'available'; }).length;
      var booked = slots.filter(function (s) { return s.status === 'booked'; }).length;
      var blocked = slots.filter(function (s) { return s.status === 'blocked'; }).length;

      var dotClass = '';
      if (slots.length === 0) {
        dotClass = '';
      } else if (available > 0) {
        dotClass = 'dot-available';
      } else if (booked > 0 && available === 0) {
        dotClass = 'dot-booked';
      } else if (blocked > 0 && available === 0 && booked === 0) {
        dotClass = 'dot-blocked';
      }

      var selectedClass = (dateStr === scheduleSelectedDate) ? ' selected' : '';
      var closedClass = isClosed ? ' closed' : '';
      html += '<div class="schedule-cal-cell' + selectedClass + closedClass + '" data-date="' + dateStr + '">';
      html += '<span class="schedule-cal-day">' + d + '</span>';
      if (isClosed) {
        html += '<span class="schedule-cal-closed">Closed</span>';
      } else if (dotClass) {
        html += '<span class="schedule-cal-dot ' + dotClass + '"></span>';
      }
      if (slots.length > 0 && !isClosed) {
        html += '<span class="schedule-cal-counts">';
        html += '<span class="cal-count-open">' + available + '</span>';
        html += '<span class="cal-count-booked">' + booked + '</span>';
        html += '</span>';
      }
      html += '</div>';
    }

    html += '</div>';
    container.innerHTML = html;

    // Wire up navigation
    container.querySelector('.schedule-cal-prev').addEventListener('click', function () {
      scheduleCalMonth.setMonth(scheduleCalMonth.getMonth() - 1);
      renderScheduleCalendar();
    });
    container.querySelector('.schedule-cal-next').addEventListener('click', function () {
      scheduleCalMonth.setMonth(scheduleCalMonth.getMonth() + 1);
      renderScheduleCalendar();
    });

    // Wire up day clicks
    container.querySelectorAll('.schedule-cal-cell[data-date]').forEach(function (cell) {
      cell.addEventListener('click', function () {
        scheduleSelectedDate = this.dataset.date;
        renderScheduleCalendar();
        renderDaySlots(scheduleSelectedDate);
      });
    });

    // Wire up calendar action buttons
    var genMonthBtn = container.querySelector('#schedule-generate-month-btn');
    if (genMonthBtn) genMonthBtn.addEventListener('click', function () { generateSlotsForMonth(); });
    var resetMonthBtn = container.querySelector('#schedule-reset-month-btn');
    if (resetMonthBtn) resetMonthBtn.addEventListener('click', function () { resetMonthToDefaults(); });

    // If a day is selected, render its slots
    if (scheduleSelectedDate) renderDaySlots(scheduleSelectedDate);
  }

  function renderDaySlots(dateStr) {
    var container = document.getElementById('schedule-day-slots');
    if (!container) return;

    var daySlots = scheduleData.filter(function (row) { return row.date === dateStr; });
    // Sort by time
    daySlots.sort(function (a, b) {
      return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
    });

    if (daySlots.length === 0) {
      container.innerHTML = '<p class="admin-empty">No slots for ' + escapeHTML(dateStr) + '</p>';
      return;
    }

    var html = '<div class="schedule-day-header">';
    html += '<h4>' + escapeHTML(dateStr) + '</h4>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="schedule-block-day">Block Entire Day</button>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="schedule-open-day">Open Entire Day</button>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="schedule-reset-day">Reset to Default</button>';
    html += '</div>';

    html += '<div class="schedule-slots">';
    daySlots.forEach(function (slot) {
      var cls = 'schedule-slot slot-' + slot.status;
      var disabled = slot.status === 'booked' ? ' disabled' : '';
      html += '<button type="button" class="' + cls + '" data-date="' + escapeHTML(slot.date) + '" data-time="' + escapeHTML(slot.time) + '" data-row="' + slot._rowIndex + '"' + disabled + '>';
      html += escapeHTML(slot.time);
      if (slot.status === 'booked') html += ' <small>(booked)</small>';
      html += '</button>';
    });
    html += '</div>';

    container.innerHTML = html;

    // Wire up individual slot toggles
    container.querySelectorAll('.schedule-slot:not([disabled])').forEach(function (btn) {
      btn.addEventListener('click', function () {
        toggleSlot(this.dataset.date, this.dataset.time, parseInt(this.dataset.row, 10));
      });
    });

    // Wire up block/open/reset day buttons
    var blockBtn = document.getElementById('schedule-block-day');
    if (blockBtn) blockBtn.addEventListener('click', function () { bulkUpdateDay(dateStr, 'blocked'); });
    var openBtn = document.getElementById('schedule-open-day');
    if (openBtn) openBtn.addEventListener('click', function () { bulkUpdateDay(dateStr, 'available'); });
    var resetDayBtn = document.getElementById('schedule-reset-day');
    if (resetDayBtn) resetDayBtn.addEventListener('click', function () { resetDayToDefault(dateStr); });
  }

  function toggleSlot(date, time, rowIndex) {
    var slot = scheduleData.find(function (s) { return s.date === date && s.time === time; });
    if (!slot || slot.status === 'booked') return;

    var newStatus = slot.status === 'available' ? 'blocked' : 'available';
    var statusCol = scheduleHeaders.indexOf('status');
    if (statusCol === -1) return;

    var cellRef = SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!' + colLetter(statusCol) + rowIndex;
    sheetsUpdate(cellRef, [[newStatus]])
      .then(function () {
        slot.status = newStatus;
        renderScheduleCalendar();
      })
      .catch(function (err) {
        showToast('Failed to update slot: ' + err.message, 'error');
      });
  }

  function bulkUpdateDay(dateStr, newStatus) {
    var daySlots = scheduleData.filter(function (s) {
      return s.date === dateStr && s.status !== 'booked';
    });
    if (daySlots.length === 0) return;

    var statusCol = scheduleHeaders.indexOf('status');
    if (statusCol === -1) return;

    var promises = daySlots.map(function (slot) {
      var cellRef = SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!' + colLetter(statusCol) + slot._rowIndex;
      return sheetsUpdate(cellRef, [[newStatus]]).then(function () {
        slot.status = newStatus;
      });
    });

    Promise.all(promises)
      .then(function () {
        renderScheduleCalendar();
      })
      .catch(function (err) {
        showToast('Failed to update day: ' + err.message, 'error');
      });
  }

  function resetDayToDefault(dateStr) {
    var defaults = getDefaultSchedule();
    var date = new Date(dateStr + 'T00:00:00');
    var dayOfWeek = date.getDay();
    var def = defaults[dayOfWeek];
    var statusCol = scheduleHeaders.indexOf('status');
    if (statusCol === -1) return;

    // Build set of times that should be available per defaults
    var shouldBeAvailable = {};
    if (def.open && def.start && def.end) {
      var blocked = def.blockedSlots || [];
      var defSlots = generateTimeSlots(def.start, def.end);
      defSlots.forEach(function (time) {
        if (blocked.indexOf(time) === -1) {
          shouldBeAvailable[time] = true;
        }
      });
    }

    var daySlots = scheduleData.filter(function (s) { return s.date === dateStr; });
    var updates = [];
    daySlots.forEach(function (slot) {
      if (slot.status === 'booked') return;
      var shouldBeOpen = !!shouldBeAvailable[slot.time];
      if (shouldBeOpen && slot.status !== 'available') {
        updates.push({ slot: slot, newStatus: 'available' });
      } else if (!shouldBeOpen && slot.status !== 'blocked') {
        updates.push({ slot: slot, newStatus: 'blocked' });
      }
    });

    if (updates.length === 0) {
      showToast('Day already matches defaults.', 'warning');
      return;
    }

    var promises = updates.map(function (u) {
      var cellRef = SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!' + colLetter(statusCol) + u.slot._rowIndex;
      return sheetsUpdate(cellRef, [[u.newStatus]]).then(function () {
        u.slot.status = u.newStatus;
      });
    });

    Promise.all(promises)
      .then(function () {
        renderScheduleCalendar();
      })
      .catch(function (err) {
        showToast('Failed to reset day: ' + err.message, 'error');
      });
  }

  function resetMonthToDefaults() {
    if (!scheduleCalMonth) return;
    var defaults = getDefaultSchedule();
    var year = scheduleCalMonth.getFullYear();
    var month = scheduleCalMonth.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var statusCol = scheduleHeaders.indexOf('status');
    if (statusCol === -1) { showToast('Cannot find status column.', 'warning'); return; }

    var today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build set of what slots SHOULD be available per defaults
    var shouldBeAvailable = {};
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(year, month, d);
      if (date < today) continue; // skip past days
      var dateStr = formatDateISO(date);
      var dayOfWeek = date.getDay();
      var def = defaults[dayOfWeek];
      if (!def.open || !def.start || !def.end) continue;
      var blocked = def.blockedSlots || [];
      var slots = generateTimeSlots(def.start, def.end);
      slots.forEach(function (time) {
        if (blocked.indexOf(time) === -1) {
          shouldBeAvailable[dateStr + '|' + time] = true;
        }
      });
    }

    // Find all slots in this month
    var prefix = getMonthPrefix();
    var monthSlots = scheduleData.filter(function (s) {
      return s.date && s.date.substring(0, 7) === prefix;
    });

    var updates = [];
    monthSlots.forEach(function (slot) {
      if (slot.status === 'booked') return; // never touch booked
      var key = slot.date + '|' + slot.time;
      var shouldBeOpen = !!shouldBeAvailable[key];
      if (shouldBeOpen && slot.status !== 'available') {
        updates.push({ slot: slot, newStatus: 'available' });
      } else if (!shouldBeOpen && slot.status !== 'blocked') {
        updates.push({ slot: slot, newStatus: 'blocked' });
      }
    });

    if (updates.length === 0) {
      showToast('All slots already match defaults.', 'warning');
      return;
    }

    if (!confirm('This will update ' + updates.length + ' slot(s) in ' +
      scheduleCalMonth.toLocaleString('default', { month: 'long', year: 'numeric' }) +
      ' to match your default schedule. Booked slots will not be changed. Continue?')) return;

    var promises = updates.map(function (u) {
      var cellRef = SHEETS_CONFIG.SHEET_NAMES.SCHEDULE + '!' + colLetter(statusCol) + u.slot._rowIndex;
      return sheetsUpdate(cellRef, [[u.newStatus]]).then(function () {
        u.slot.status = u.newStatus;
      });
    });

    Promise.all(promises)
      .then(function () {
        showToast(updates.length + ' slot(s) updated to match defaults.', 'success');
        renderScheduleCalendar();
      })
      .catch(function (err) {
        showToast('Failed to reset slots: ' + err.message, 'error');
        loadAllData(); // reload to get consistent state
      });
  }

  function initScheduleControls() {
    // Generate and Reset buttons are wired up in renderScheduleCalendar()

    var saveDefaultsBtn = document.getElementById('schedule-save-defaults-btn');
    if (saveDefaultsBtn) {
      saveDefaultsBtn.addEventListener('click', function () {
        var defaults = readDefaultsFromTable();
        saveDefaultSchedule(defaults);
        showToast('Default schedule saved.', 'success');
      });
    }
  }

  // ===== Export =====

  function initExportButtons() {
    document.addEventListener('DOMContentLoaded', function () {
      var exportKitsBtn = document.getElementById('export-kits-btn');
      if (exportKitsBtn) exportKitsBtn.addEventListener('click', exportKitsCSV);

      var exportIngBtn = document.getElementById('export-ingredients-btn');
      if (exportIngBtn) exportIngBtn.addEventListener('click', exportIngredientsCSV);

      var exportWsBtn = document.getElementById('export-ws-btn');
      if (exportWsBtn) exportWsBtn.addEventListener('click', exportWineSchedulerCSV);
    });
  }

  function exportKitsCSV() {
    // WineScheduler-compatible format
    var wsHeaders = ['Product Name', 'SKU', 'Category', 'Subcategory', 'Price', 'Kit Price', 'Cost', 'Stock On Hand', 'On Order', 'Notes'];
    var rows = [wsHeaders];

    kitsData.forEach(function (kit) {
      rows.push([
        ((kit.brand || '') + ' ' + (kit.name || '')).trim(),
        kit.sku || '',
        kit.type || '',
        kit.subcategory || '',
        (kit.retail_instore || '').replace('$', ''),
        (kit.retail_kit || '').replace('$', ''),
        (kit.wholesale || '').replace('$', ''),
        kit.stock || '0',
        kit.on_order || '0',
        kit.tasting_notes || ''
      ]);
    });

    var today = new Date().toISOString().split('T')[0];
    downloadCSV(rows, 'sv-kits-export-' + today + '.csv');
  }

  function exportIngredientsCSV() {
    var rows = [ingredientsHeaders.slice()];
    ingredientsData.forEach(function (ing) {
      var row = ingredientsHeaders.map(function (h) { return ing[h] || ''; });
      rows.push(row);
    });

    var today = new Date().toISOString().split('T')[0];
    downloadCSV(rows, 'sv-ingredients-export-' + today + '.csv');
  }

  function exportWineSchedulerCSV() {
    var wsHeaders = ['Stock Code/SKU', 'Name', 'Retail Price', 'Wholesale Price', 'Qty'];
    var rows = [wsHeaders];

    // Add kits
    kitsData.forEach(function (kit) {
      rows.push([
        kit.sku || '',
        ((kit.brand || '') + ' ' + (kit.name || '')).trim(),
        (kit.retail_instore || '').replace('$', ''),
        (kit.wholesale || '').replace('$', ''),
        kit.stock || '0'
      ]);
    });

    // Add ingredients
    ingredientsData.forEach(function (ing) {
      rows.push([
        ing.sku || '',
        ing.name || '',
        (ing.cost || '').replace('$', ''),
        (ing.cost || '').replace('$', ''),
        ing.stock_qty || '0'
      ]);
    });

    var today = new Date().toISOString().split('T')[0];
    downloadCSV(rows, 'sv-winescheduler-export-' + today + '.csv');
  }

  function downloadCSV(rows, filename) {
    var csv = rows.map(function (row) {
      return row.map(function (cell) {
        var val = String(cell);
        if (val.indexOf(',') !== -1 || val.indexOf('"') !== -1 || val.indexOf('\n') !== -1) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      }).join(',');
    }).join('\n');

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ===== Import =====

  function initImportControls() {
    document.addEventListener('DOMContentLoaded', function () {
      var fileInput = document.getElementById('import-csv-input');
      if (fileInput) fileInput.addEventListener('change', handleImportFile);

      var applyBtn = document.getElementById('import-apply-btn');
      if (applyBtn) applyBtn.addEventListener('click', applyImport);

      var cancelBtn = document.getElementById('import-cancel-btn');
      if (cancelBtn) cancelBtn.addEventListener('click', cancelImport);
    });
  }

  var importPreviewData = null;

  function handleImportFile(e) {
    var file = e.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function (ev) {
      var text = ev.target.result;
      var lines = text.trim().split('\n');
      if (lines.length < 2) { showToast('CSV file is empty or has no data rows.', 'warning'); return; }

      var headers = parseCSVLine(lines[0]).map(function (h) { return h.trim(); });
      var rows = [];
      for (var i = 1; i < lines.length; i++) {
        var vals = parseCSVLine(lines[i]);
        if (vals.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j]] = vals[j].trim();
        }
        rows.push(obj);
      }

      importPreviewData = { headers: headers, rows: rows };
      renderImportPreview();
    };
    reader.readAsText(file);
  }

  function renderImportPreview() {
    if (!importPreviewData) return;

    var preview = document.getElementById('import-preview');
    var thead = document.getElementById('import-preview-head');
    var tbody = document.getElementById('import-preview-body');

    // Build header row
    var headerHtml = '<tr>';
    headerHtml += '<th>Change</th>';
    importPreviewData.headers.forEach(function (h) {
      headerHtml += '<th>' + escapeHTML(h) + '</th>';
    });
    headerHtml += '</tr>';
    thead.innerHTML = headerHtml;

    // Compare with existing kits
    tbody.innerHTML = '';
    var skuCol = importPreviewData.headers.indexOf('sku') !== -1 ? 'sku' : 'SKU';

    importPreviewData.rows.forEach(function (row) {
      var sku = row[skuCol] || row.sku || row.SKU || '';
      var existing = kitsData.find(function (k) { return k.sku === sku; });

      var tr = document.createElement('tr');
      var changeTd = document.createElement('td');

      if (!existing) {
        changeTd.textContent = 'NEW';
        changeTd.className = 'admin-diff-new';
      } else {
        var hasChanges = false;
        importPreviewData.headers.forEach(function (h) {
          var mappedH = h.toLowerCase().replace(/ /g, '_');
          if (existing[mappedH] !== undefined && existing[mappedH] !== (row[h] || '')) {
            hasChanges = true;
          }
        });
        changeTd.textContent = hasChanges ? 'MODIFIED' : 'UNCHANGED';
        changeTd.className = hasChanges ? 'admin-diff-mod' : '';
      }
      tr.appendChild(changeTd);

      importPreviewData.headers.forEach(function (h) {
        appendTd(tr, row[h] || '');
      });

      tbody.appendChild(tr);
    });

    preview.style.display = '';
  }

  function applyImport() {
    if (!importPreviewData || importPreviewData.rows.length === 0) return;

    // Map import headers to sheet headers and update the entire Kits sheet
    var sheetRows = [kitsHeaders];

    importPreviewData.rows.forEach(function (row) {
      var sheetRow = kitsHeaders.map(function (h) {
        // Try direct match first, then common mappings
        if (row[h] !== undefined) return row[h];
        // WineScheduler format mappings
        var mappings = {
          'type': 'Category',
          'subcategory': 'Subcategory',
          'name': 'Product Name',
          'retail_instore': 'Price',
          'retail_kit': 'Kit Price',
          'wholesale': 'Cost',
          'stock': 'Stock On Hand',
          'tasting_notes': 'Notes'
        };
        if (mappings[h] && row[mappings[h]] !== undefined) return row[mappings[h]];
        return '';
      });
      sheetRows.push(sheetRow);
    });

    var range = SHEETS_CONFIG.SHEET_NAMES.KITS + '!A1:' + colLetter(kitsHeaders.length - 1) + (sheetRows.length);
    sheetsUpdate(range, sheetRows)
      .then(function () {
        showToast('Import applied successfully.', 'success');
        cancelImport();
        loadAllData();
      })
      .catch(function (err) {
        showToast('Import failed: ' + err.message, 'error');
      });
  }

  function cancelImport() {
    importPreviewData = null;
    document.getElementById('import-preview').style.display = 'none';
    document.getElementById('import-csv-input').value = '';
  }

  // ===== CSV Parser (same as main.js) =====

  function parseCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          result.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    result.push(current);
    return result;
  }

  // ===== Homepage Promo Admin =====

  var homepageConfig = {
    'promo-news': [],
    'instafeed-url': '',
    'promo-featured-skus': [],
    'social-instagram': '',
    'social-facebook': '',
    'faq': []
  };
  var homepageSelectedProduct = null;
  var homepageHeaders = [];

  function loadHomepageData() {
    // Load from Google Sheets
    sheetsGet(SHEETS_CONFIG.SHEET_NAMES.HOMEPAGE + '!A:E')
      .then(function (data) {
        var rows = data.values || [];
        if (rows.length > 0) {
          homepageHeaders = rows[0];
        }

        // Reset config
        homepageConfig['promo-news'] = [];
        homepageConfig['promo-featured-skus'] = [];
        homepageConfig['social-instagram'] = '';
        homepageConfig['social-facebook'] = '';
        homepageConfig['faq'] = [];

        // Parse rows (skip header)
        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          var type = (row[0] || '').toLowerCase();
          if (type === 'news') {
            homepageConfig['promo-news'].push({
              date: row[1] || '',
              title: row[2] || '',
              text: row[3] || ''
            });
          } else if (type === 'featured') {
            var sku = row[4] || '';
            var desc = row[3] || '';
            if (sku) {
              homepageConfig['promo-featured-skus'].push({ sku: sku, description: desc });
            }
          } else if (type === 'instafeed') {
            homepageConfig['instafeed-url'] = row[3] || '';
          } else if (type === 'social') {
            var platform = (row[2] || '').toLowerCase().trim();
            var url = row[4] || '';
            if (platform === 'instagram') {
              homepageConfig['social-instagram'] = url;
            } else if (platform === 'facebook') {
              homepageConfig['social-facebook'] = url;
            }
          } else if (type === 'faq') {
            homepageConfig['faq'].push({
              question: row[2] || '',
              answer: row[3] || ''
            });
          }
        }

        renderHomepageNewsItems();
        renderHomepageFaqItems();
        renderHomepageFeaturedList();
        var feedField = document.getElementById('homepage-instafeed-url');
        if (feedField) feedField.value = homepageConfig['instafeed-url'] || '';
        var igField = document.getElementById('homepage-social-instagram');
        if (igField) igField.value = homepageConfig['social-instagram'] || '';
        var fbField = document.getElementById('homepage-social-facebook');
        if (fbField) fbField.value = homepageConfig['social-facebook'] || '';
      })
      .catch(function (err) {
        console.error('[Homepage] Error loading from sheet:', err);
      });
  }

  function initHomepageTab() {
    document.addEventListener('DOMContentLoaded', function () {
      // Homepage data will be loaded after auth via loadHomepageData()

      // Add news item button
      var addNewsBtn = document.getElementById('homepage-add-news');
      if (addNewsBtn) {
        addNewsBtn.addEventListener('click', function () {
          collectHomepageData(); // Save current values first
          homepageConfig['promo-news'].unshift({ date: '', title: '', text: '' });
          renderHomepageNewsItems();
        });
      }

      // Add FAQ button
      var addFaqBtn = document.getElementById('homepage-add-faq');
      if (addFaqBtn) {
        addFaqBtn.addEventListener('click', function () {
          collectHomepageData(); // Save current values first
          homepageConfig['faq'].push({ question: '', answer: '' });
          renderHomepageFaqItems();
        });
      }

      // Product search (debounced)
      var searchInput = document.getElementById('homepage-kit-search');
      var dropdown = document.getElementById('homepage-kit-dropdown');
      var homepageSearchTimer;
      if (searchInput && dropdown) {
        searchInput.addEventListener('input', function () {
          var self = this;
          clearTimeout(homepageSearchTimer);
          homepageSearchTimer = setTimeout(function () {
            var query = self.value.toLowerCase().trim();
            if (query.length < 2) {
              dropdown.style.display = 'none';
              return;
            }
            var matches = kitsData.filter(function (k) {
              return (k.name || '').toLowerCase().indexOf(query) !== -1 ||
                     (k.brand || '').toLowerCase().indexOf(query) !== -1 ||
                     (k.sku || '').toLowerCase().indexOf(query) !== -1;
            }).slice(0, 10);

            if (matches.length === 0) {
              dropdown.style.display = 'none';
              return;
            }

            dropdown.innerHTML = '';
            matches.forEach(function (kit) {
              var opt = document.createElement('div');
              opt.className = 'admin-kit-search-option';
              opt.innerHTML = '<strong>' + escapeHTML(kit.brand || '') + '</strong> ' +
                              escapeHTML(kit.name || '') +
                              ' <span style="opacity:0.6">(' + escapeHTML(kit.sku || '') + ')</span>';
              opt.addEventListener('click', function () {
                homepageSelectedProduct = kit;
                searchInput.value = (kit.brand || '') + ' ' + (kit.name || '');
                dropdown.style.display = 'none';
              });
              dropdown.appendChild(opt);
            });
            dropdown.style.display = 'block';
          }, 300);
        });

        searchInput.addEventListener('blur', function () {
          setTimeout(function () { dropdown.style.display = 'none'; }, 200);
        });
      }

      // Add product button
      var addProductBtn = document.getElementById('homepage-add-product');
      if (addProductBtn) {
        addProductBtn.addEventListener('click', function () {
          if (!homepageSelectedProduct || !homepageSelectedProduct.sku) {
            showToast('Please select a product from the search dropdown.', 'warning');
            return;
          }
          var alreadyAdded = homepageConfig['promo-featured-skus'].some(function (e) { return e.sku === homepageSelectedProduct.sku; });
          if (!alreadyAdded) {
            homepageConfig['promo-featured-skus'].push({ sku: homepageSelectedProduct.sku, description: '' });
            renderHomepageFeaturedList();
          }
          homepageSelectedProduct = null;
          searchInput.value = '';
        });
      }

      // Save button - saves to Google Sheets
      var saveBtn = document.getElementById('homepage-save-btn');
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          collectHomepageData();
          saveHomepageToSheets();
        });
      }
    });
  }

  function saveHomepageToSheets() {
    // Build rows for the sheet
    var rows = [['Type', 'Date', 'Title', 'Text', 'SKU']]; // Header row

    // Add news items
    homepageConfig['promo-news'].forEach(function (news) {
      rows.push(['news', news.date || '', news.title || '', news.text || '', '']);
    });

    // Add Instagram feed URL
    if (homepageConfig['instafeed-url']) {
      rows.push(['instafeed', '', '', homepageConfig['instafeed-url'], '']);
    }

    // Add featured products
    homepageConfig['promo-featured-skus'].forEach(function (entry) {
      rows.push(['featured', '', '', entry.description || '', entry.sku]);
    });

    // Add social links
    if (homepageConfig['social-instagram']) {
      rows.push(['social', '', 'instagram', '', homepageConfig['social-instagram']]);
    }
    if (homepageConfig['social-facebook']) {
      rows.push(['social', '', 'facebook', '', homepageConfig['social-facebook']]);
    }

    // Add FAQ items
    homepageConfig['faq'].forEach(function (faq) {
      rows.push(['faq', '', faq.question || '', faq.answer || '', '']);
    });

    // Clear the sheet first, then write new data
    // If Admin API is configured, verify authorization server-side before write
    var authPromise;
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      authPromise = adminApiGet('check_auth').then(function (result) {
        if (!result.authorized) {
          throw new Error('Not authorized to make changes');
        }
      });
    } else {
      authPromise = Promise.resolve();
    }

    var clearUrl = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      SHEETS_CONFIG.SPREADSHEET_ID + '/values/' +
      encodeURIComponent(SHEETS_CONFIG.SHEET_NAMES.HOMEPAGE + '!A:E') + ':clear';

    authPromise.then(function () {
      return fetch(clearUrl, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken }
      });
    })
    .then(function (res) {
      if (!res.ok) {
        return res.json().then(function (err) {
          throw new Error(err.error ? err.error.message : 'Failed to clear sheet');
        });
      }
      return res.json();
    })
    .then(function () {
      // Write new data starting at A1
      return sheetsUpdate(SHEETS_CONFIG.SHEET_NAMES.HOMEPAGE + '!A1', rows);
    })
    .then(function () {
      showToast('Homepage settings saved to Google Sheets!', 'success');
    })
    .catch(function (err) {
      console.error('[Homepage] Error saving:', err);
      showToast('Error saving homepage settings: ' + err.message, 'error');
    });
  }

  function collectHomepageData() {
    // Collect news items from DOM
    var newsItems = [];
    var newsContainer = document.getElementById('homepage-news-list');
    if (newsContainer) {
      var items = newsContainer.querySelectorAll('.homepage-news-item');
      items.forEach(function (item) {
        var dateInput = item.querySelector('.news-date');
        var titleInput = item.querySelector('.news-title');
        var textInput = item.querySelector('.news-text');
        if (dateInput && titleInput && textInput) {
          newsItems.push({
            date: dateInput.value || '',
            title: sanitizeInput(titleInput.value || ''),
            text: sanitizeInput(textInput.value || '')
          });
        }
      });
    }
    homepageConfig['promo-news'] = newsItems;

    // Collect Instagram feed URL
    var feedField = document.getElementById('homepage-instafeed-url');
    if (feedField) {
      homepageConfig['instafeed-url'] = sanitizeInput(feedField.value || '');
    }

    // Collect per-product descriptions from featured list
    var featuredItems = document.querySelectorAll('.homepage-featured-item');
    var updatedFeatured = [];
    featuredItems.forEach(function (item, idx) {
      var descField = item.querySelector('.featured-desc');
      var entry = homepageConfig['promo-featured-skus'][idx];
      if (entry) {
        updatedFeatured.push({
          sku: entry.sku,
          description: sanitizeInput(descField ? descField.value : '')
        });
      }
    });
    homepageConfig['promo-featured-skus'] = updatedFeatured;

    // Collect social links (sanitize URLs)
    var igField = document.getElementById('homepage-social-instagram');
    if (igField) {
      homepageConfig['social-instagram'] = sanitizeInput(igField.value || '');
    }
    var fbField = document.getElementById('homepage-social-facebook');
    if (fbField) {
      homepageConfig['social-facebook'] = sanitizeInput(fbField.value || '');
    }

    // Collect FAQ items from DOM (sanitize to prevent XSS)
    var faqItems = [];
    var faqContainer = document.getElementById('homepage-faq-list');
    if (faqContainer) {
      var items = faqContainer.querySelectorAll('.homepage-faq-item');
      items.forEach(function (item) {
        var questionInput = item.querySelector('.faq-question');
        var answerInput = item.querySelector('.faq-answer');
        if (questionInput && answerInput) {
          faqItems.push({
            question: sanitizeInput(questionInput.value || ''),
            answer: sanitizeInput(answerInput.value || '')
          });
        }
      });
    }
    homepageConfig['faq'] = faqItems;
  }


  function renderHomepageNewsItems() {
    var container = document.getElementById('homepage-news-list');
    if (!container) return;

    container.innerHTML = '';
    homepageConfig['promo-news'].forEach(function (news, idx) {
      var item = document.createElement('div');
      item.className = 'homepage-news-item';
      item.innerHTML =
        '<div class="homepage-news-item-fields">' +
          '<input type="text" class="news-date" placeholder="Date (e.g., Jan 15, 2026)" value="' + escapeHTML(news.date || '') + '">' +
          '<input type="text" class="news-title" placeholder="Title" value="' + escapeHTML(news.title || '') + '">' +
          '<textarea class="news-text" placeholder="News text...">' + escapeHTML(news.text || '') + '</textarea>' +
        '</div>' +
        '<div class="homepage-news-item-actions">' +
          '<button type="button" class="btn-secondary admin-btn-sm admin-btn-danger news-remove-btn" data-idx="' + idx + '">Remove</button>' +
        '</div>';
      container.appendChild(item);
    });

    // Wire up remove buttons
    container.querySelectorAll('.news-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        collectHomepageData(); // Save current values first
        var idx = parseInt(this.dataset.idx, 10);
        homepageConfig['promo-news'].splice(idx, 1);
        renderHomepageNewsItems();
      });
    });
  }

  function renderHomepageFaqItems() {
    var container = document.getElementById('homepage-faq-list');
    if (!container) return;

    container.innerHTML = '';
    homepageConfig['faq'].forEach(function (faq, idx) {
      var item = document.createElement('div');
      item.className = 'homepage-faq-item';
      item.innerHTML =
        '<div class="homepage-faq-item-fields">' +
          '<input type="text" class="faq-question" placeholder="Question" value="' + escapeHTML(faq.question || '') + '">' +
          '<textarea class="faq-answer" placeholder="Answer...">' + escapeHTML(faq.answer || '') + '</textarea>' +
        '</div>' +
        '<div class="homepage-faq-item-actions">' +
          '<button type="button" class="btn-secondary admin-btn-sm admin-btn-danger faq-remove-btn" data-idx="' + idx + '">Remove</button>' +
        '</div>';
      container.appendChild(item);
    });

    // Wire up remove buttons
    container.querySelectorAll('.faq-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        collectHomepageData(); // Save current values first
        var idx = parseInt(this.dataset.idx, 10);
        homepageConfig['faq'].splice(idx, 1);
        renderHomepageFaqItems();
      });
    });
  }

  function renderHomepageFeaturedList() {
    var container = document.getElementById('homepage-featured-list');
    if (!container) return;

    container.innerHTML = '';
    homepageConfig['promo-featured-skus'].forEach(function (entry, idx) {
      var kit = kitsData.find(function (k) { return k.sku === entry.sku; });
      var name = kit ? ((kit.brand || '') + ' ' + (kit.name || '')).trim() : 'Unknown';

      var item = document.createElement('div');
      item.className = 'homepage-featured-item';
      item.innerHTML =
        '<div class="homepage-featured-item-info">' +
          '<span class="homepage-featured-item-name">' + escapeHTML(name) + '</span>' +
          '<span class="homepage-featured-item-sku">SKU: ' + escapeHTML(entry.sku) + '</span>' +
        '</div>' +
        '<textarea class="admin-textarea featured-desc" rows="2" placeholder="Description for this product...">' +
          escapeHTML(entry.description || '') +
        '</textarea>' +
        '<button type="button" class="btn-secondary admin-btn-sm admin-btn-danger featured-remove-btn" data-idx="' + idx + '">Remove</button>';
      container.appendChild(item);
    });

    // Wire up remove buttons
    container.querySelectorAll('.featured-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(this.dataset.idx, 10);
        homepageConfig['promo-featured-skus'].splice(idx, 1);
        renderHomepageFeaturedList();
      });
    });
  }

  initHomepageTab();

  // ===== Utilities =====

  function colLetter(index) {
    var letter = '';
    while (index >= 0) {
      letter = String.fromCharCode(65 + (index % 26)) + letter;
      index = Math.floor(index / 26) - 1;
    }
    return letter;
  }

  function escapeHTML(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Sanitize user input to prevent XSS attacks
   * Strips script tags and other potentially dangerous HTML before sending to server
   * @param {string} input - User-provided text
   * @returns {string} Sanitized text
   */
  function sanitizeInput(input) {
    if (input === null || input === undefined) return '';
    if (typeof input !== 'string') return String(input);

    var sanitized = input;

    // Remove script tags and their contents (case-insensitive)
    sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    sanitized = sanitized.replace(/<\/?script[^>]*>/gi, '');

    // Remove event handlers (onclick, onerror, onload, etc.)
    sanitized = sanitized.replace(/\s*on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/\s*on\w+\s*=\s*[^\s>]+/gi, '');

    // Remove javascript: and data: URLs
    sanitized = sanitized.replace(/javascript\s*:/gi, '');
    sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, '');

    // Remove iframe, object, embed, style tags
    sanitized = sanitized.replace(/<\/?iframe[^>]*>/gi, '');
    sanitized = sanitized.replace(/<\/?object[^>]*>/gi, '');
    sanitized = sanitized.replace(/<\/?embed[^>]*>/gi, '');
    sanitized = sanitized.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    sanitized = sanitized.replace(/<\/?style[^>]*>/gi, '');

    return sanitized;
  }

  // ===== Kiosk Orders (Staff Order Board) =====

  var kioskOrdersTimer = null;

  function initKioskOrders() {
    var refreshBtn = document.getElementById('kiosk-orders-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', loadKioskOrders);
    }
    loadKioskOrders();

    // Auto-refresh every 15 seconds
    if (kioskOrdersTimer) clearInterval(kioskOrdersTimer);
    kioskOrdersTimer = setInterval(loadKioskOrders, 15000);
  }

  function loadKioskOrders() {
    var mwUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL)
      ? SHEETS_CONFIG.MIDDLEWARE_URL : '';
    if (!mwUrl) {
      var container = document.getElementById('kiosk-orders-list');
      if (container) container.innerHTML = '<p class="admin-order-info">Middleware URL not configured.</p>';
      return;
    }

    fetch(mwUrl + '/api/orders/recent?limit=20')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderKioskOrders(data.orders || []);
      })
      .catch(function (err) {
        var container = document.getElementById('kiosk-orders-list');
        if (container) container.innerHTML = '<p class="admin-order-info">Failed to load orders: ' + err.message + '</p>';
      });
  }

  function renderKioskOrders(orders) {
    var container = document.getElementById('kiosk-orders-list');
    if (!container) return;

    if (orders.length === 0) {
      container.innerHTML = '<p class="admin-order-info">No recent orders.</p>';
      return;
    }

    var html = '<table class="catalog-table kiosk-orders-table">';
    html += '<thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Timeslot</th><th>Status</th><th>Payment</th></tr></thead>';
    html += '<tbody>';

    orders.forEach(function (order) {
      var itemNames = order.items.map(function (it) {
        return it.name + (it.quantity > 1 ? ' x' + it.quantity : '');
      }).join(', ');

      var statusClass = '';
      var statusLabel = order.status || 'Walk-in';
      if (statusLabel.toLowerCase() === 'walk-in') statusClass = 'kiosk-status--walkin';
      else if (statusLabel.toLowerCase() === 'pending') statusClass = 'kiosk-status--pending';

      var paymentBadge = '';
      if (order.transaction_id) {
        paymentBadge = '<span class="kiosk-payment-badge kiosk-payment--paid">Paid</span>';
      } else if (parseFloat(order.deposit) > 0) {
        paymentBadge = '<span class="kiosk-payment-badge kiosk-payment--deposit">Deposit</span>';
      } else {
        paymentBadge = '<span class="kiosk-payment-badge kiosk-payment--pending">Pending</span>';
      }

      html += '<tr>';
      html += '<td data-label="Order">' + order.salesorder_number + '</td>';
      html += '<td data-label="Customer">' + (order.customer_name || '—') + '</td>';
      html += '<td data-label="Items">' + itemNames + '</td>';
      html += '<td data-label="Total">$' + Number(order.total).toFixed(2) + '</td>';
      html += '<td data-label="Timeslot">' + (order.timeslot || '—') + '</td>';
      html += '<td data-label="Status"><span class="kiosk-status ' + statusClass + '">' + statusLabel + '</span></td>';
      html += '<td data-label="Payment">' + paymentBadge + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // Hook kiosk orders into dashboard load
  var _origShowDashboard = showDashboard;
  showDashboard = function () {
    _origShowDashboard();
    initKioskOrders();
  };

  // ===== BATCH TRACKING =====

  var batchesData = [];
  var fermSchedulesData = [];
  var batchDashboardSummary = null;
  var calendarYear, calendarMonth;

  var BATCH_STATUSES = {
    primary: { label: 'Primary', color: 'blue' },
    secondary: { label: 'Secondary', color: 'amber' },
    complete: { label: 'Complete', color: 'green' },
    disabled: { label: 'Disabled', color: 'gray' }
  };

  // --- Sub-tab navigation ---

  function initBatchSubTabs() {
    var btns = document.querySelectorAll('.batch-sub-tab');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        btns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var views = document.querySelectorAll('.batch-view');
        views.forEach(function (v) { v.classList.remove('active'); });
        var target = document.getElementById('batch-view-' + btn.getAttribute('data-batch-view'));
        if (target) target.classList.add('active');

        // Lazy load calendar/upcoming on first visit
        var view = btn.getAttribute('data-batch-view');
        if (view === 'calendar') renderBatchCalendar(calendarYear, calendarMonth);
        if (view === 'upcoming') loadUpcomingTasks();
        if (view === 'schedules') loadScheduleTemplates();
      });
    });
  }

  // --- Data Loading ---

  function loadBatchesData(callback) {
    adminApiGet('get_batches', { status: document.getElementById('batch-status-filter') ? document.getElementById('batch-status-filter').value : 'active' })
      .then(function (result) {
        batchesData = (result.data && result.data.batches) || [];
        renderBatchList();
        if (callback) callback();
      })
      .catch(function (err) {
        showToast('Failed to load batches: ' + err.message, 'error');
      });
  }

  function loadScheduleTemplates(callback) {
    adminApiGet('get_ferm_schedules')
      .then(function (result) {
        fermSchedulesData = (result.data && result.data.schedules) || [];
        renderScheduleTemplates();
        if (callback) callback();
      })
      .catch(function (err) {
        showToast('Failed to load schedules: ' + err.message, 'error');
      });
  }

  function loadBatchDashboardSummary() {
    adminApiGet('get_batch_dashboard_summary')
      .then(function (result) {
        batchDashboardSummary = result.data || null;
        renderBatchPipeline();
        addBatchAttentionItems(batchDashboardSummary);
      })
      .catch(function () {});
  }

  // --- Batch List ---

  function renderBatchList() {
    var tbody = document.getElementById('batches-tbody');
    var emptyMsg = document.getElementById('batches-empty');
    if (!tbody) return;

    var search = (document.getElementById('batch-search') ? document.getElementById('batch-search').value : '').toLowerCase();
    var filtered = batchesData;
    if (search) {
      filtered = filtered.filter(function (b) {
        return (String(b.batch_id) + ' ' + String(b.product_name) + ' ' + String(b.customer_name) + ' ' + String(b.vessel_id)).toLowerCase().indexOf(search) !== -1;
      });
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      if (emptyMsg) emptyMsg.style.display = '';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    var html = '';
    filtered.forEach(function (b) {
      var statusInfo = BATCH_STATUSES[String(b.status).toLowerCase()] || { label: b.status, color: 'gray' };
      var location = [b.vessel_id, b.shelf_id, b.bin_id].filter(Boolean).join(' / ') || '—';
      var total = b.tasks_total || 0;
      var done = b.tasks_done || 0;
      var pct = total > 0 ? Math.round((done / total) * 100) : 0;
      var startDate = b.start_date || '—';

      html += '<tr data-batch-id="' + b.batch_id + '">';
      html += '<td class="batch-id-cell">' + b.batch_id + '</td>';
      html += '<td>' + (b.product_name || b.product_sku || '—') + '</td>';
      html += '<td>' + (b.customer_name || '—') + '</td>';
      html += '<td><span class="batch-status batch-status--' + statusInfo.color + '">' + statusInfo.label + '</span></td>';
      html += '<td>' + startDate + '</td>';
      html += '<td>' + location + '</td>';
      html += '<td><div class="batch-progress"><div class="batch-progress-bar" style="width:' + pct + '%"></div></div><span class="batch-progress-text">' + done + '/' + total + '</span></td>';
      html += '<td><button type="button" class="btn-secondary admin-btn-sm batch-qr-btn" data-batch-id="' + b.batch_id + '" data-token="' + (b.access_token || '') + '">QR</button></td>';
      html += '</tr>';
    });

    tbody.innerHTML = html;

    // Click row to open detail
    tbody.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.classList.contains('batch-qr-btn')) return;
        openBatchDetail(tr.getAttribute('data-batch-id'));
      });
    });

    // QR buttons
    tbody.querySelectorAll('.batch-qr-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var bid = btn.getAttribute('data-batch-id');
        var token = btn.getAttribute('data-token');
        var batch = batchesData.find(function (b) { return b.batch_id === bid; });
        showBatchQRModal(bid, token, batch || {});
      });
    });
  }

  // --- Batch Detail Modal ---

  function openBatchDetail(batchId) {
    openModal('Loading...', '<p>Loading batch details...</p>');
    adminApiGet('get_batch', { batch_id: batchId })
      .then(function (result) {
        renderBatchDetailModal(result.data);
      })
      .catch(function (err) {
        openModal('Error', '<p>Failed to load batch: ' + err.message + '</p>');
      });
  }

  function renderBatchDetailModal(data) {
    var b = data.batch;
    var tasks = data.tasks || [];
    var readings = data.plato_readings || [];
    var history = data.vessel_history || [];
    var statusInfo = BATCH_STATUSES[String(b.status).toLowerCase()] || { label: b.status, color: 'gray' };

    var html = '<div class="batch-detail">';

    // Header
    html += '<div class="batch-detail-header">';
    html += '<span class="batch-status batch-status--' + statusInfo.color + '">' + statusInfo.label + '</span>';
    html += '<span class="batch-detail-id">' + b.batch_id + '</span>';
    html += '</div>';

    // Info grid
    html += '<div class="batch-detail-grid">';
    html += '<div class="batch-detail-col"><strong>Product:</strong> ' + (b.product_name || b.product_sku) + '</div>';
    html += '<div class="batch-detail-col"><strong>Customer:</strong> ' + (b.customer_name || '—') + '</div>';
    html += '<div class="batch-detail-col"><strong>Start Date:</strong> ' + (b.start_date || '—') + '</div>';
    html += '<div class="batch-detail-col"><strong>Vessel:</strong> ' + (b.vessel_id || '—') + ' &nbsp;<strong>Shelf:</strong> ' + (b.shelf_id || '—') + ' &nbsp;<strong>Bin:</strong> ' + (b.bin_id || '—') + '</div>';
    html += '</div>';

    // Location edit
    var currentVesselLabel = '';
    if (b.vessel_id && vesselsData) {
      var cv = vesselsData.find(function (v) { return String(v.vessel_id) === String(b.vessel_id); });
      currentVesselLabel = cv ? buildVesselLabel(cv) : b.vessel_id;
    }
    html += '<details class="batch-detail-section"><summary>Edit Location</summary>';
    html += '<div class="batch-detail-location-edit">';
    html += '<div class="admin-kit-search-wrap" style="flex:2;">';
    html += '<input type="text" id="batch-edit-vessel-search" class="admin-inline-input" value="' + currentVesselLabel + '" placeholder="Search vessels..." autocomplete="off">';
    html += '<div class="admin-kit-search-dropdown" id="batch-edit-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="batch-edit-vessel" value="' + (b.vessel_id || '') + '">';
    html += '</div>';
    html += '<input type="text" id="batch-edit-shelf" value="' + (b.shelf_id || '') + '" placeholder="A" class="admin-inline-input">';
    html += '<input type="text" id="batch-edit-bin" value="' + (b.bin_id || '') + '" placeholder="01" class="admin-inline-input">';
    html += '<button type="button" class="btn admin-btn-sm" id="batch-save-location">Save</button>';
    html += '</div></details>';

    // Tasks
    html += '<div class="batch-detail-tasks-header"><h4>Tasks</h4>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="batch-add-task-btn">+ Add Task</button></div>';
    html += '<div class="batch-detail-tasks">';
    tasks.forEach(function (t) {
      var done = String(t.completed).toUpperCase() === 'TRUE';
      var isPkg = String(t.is_packaging).toUpperCase() === 'TRUE';
      var isTransfer = String(t.is_transfer).toUpperCase() === 'TRUE';
      var dueLabel = t.due_date ? String(t.due_date).substring(0, 10) : (isPkg ? 'TBD' : '—');
      var overdue = !done && t.due_date && String(t.due_date).substring(0, 10) < new Date().toISOString().substring(0, 10);
      var cls = 'batch-task-row';
      if (done) cls += ' batch-task-row--done';
      if (overdue) cls += ' batch-task-row--overdue';

      html += '<div class="' + cls + '">';
      html += '<label class="batch-task-check"><input type="checkbox" ' + (done ? 'checked' : '') + ' data-task-id="' + t.task_id + '" data-batch-id="' + b.batch_id + '" data-is-transfer="' + (isTransfer ? '1' : '') + '"> ';
      html += '<span class="batch-task-title">' + (t.title || 'Step ' + t.step_number) + '</span>';
      if (isTransfer) html += '<span class="batch-task-badge batch-task-badge--transfer">Transfer</span>';
      if (isPkg) html += '<span class="batch-task-badge batch-task-badge--pkg">Packaging</span>';
      html += '</label>';
      html += '<span class="batch-task-due">' + dueLabel + '</span>';
      if (done && t.completed_at) html += '<span class="batch-task-meta">Done ' + String(t.completed_at).substring(0, 10) + '</span>';
      html += '</div>';
    });
    html += '</div>';

    // Plato Readings
    html += '<h4>Plato Readings</h4>';
    if (readings.length > 0) {
      html += renderPlatoChart(readings, b.start_date);
      html += '<table class="admin-table batch-plato-table"><thead><tr><th>Date</th><th>&deg;P</th><th>Notes</th></tr></thead><tbody>';
      readings.slice().reverse().forEach(function (r) {
        html += '<tr><td>' + String(r.timestamp || '').substring(0, 10) + '</td><td>' + r.degrees_plato + '</td><td>' + (r.notes || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="admin-order-info">No readings recorded yet.</p>';
    }
    html += '<div class="batch-plato-add">';
    html += '<input type="number" id="plato-value" step="0.1" min="0" max="40" placeholder="&deg;P" class="admin-inline-input" style="width:80px;">';
    html += '<input type="text" id="plato-notes" placeholder="Notes" class="admin-inline-input">';
    html += '<button type="button" class="btn admin-btn-sm" id="plato-add-btn">Record</button>';
    html += '</div>';

    // Notes
    html += '<h4>Notes</h4>';
    html += '<textarea id="batch-notes-edit" class="admin-input" rows="3">' + (b.notes || '') + '</textarea>';
    html += '<button type="button" class="btn admin-btn-sm" id="batch-save-notes" style="margin-top:4px;">Save Notes</button>';

    // Vessel History
    if (history.length > 0) {
      html += '<h4>Location History</h4>';
      html += '<div class="batch-vessel-history">';
      history.forEach(function (h) {
        html += '<div class="batch-vh-entry">';
        html += '<strong>' + String(h.transferred_at || '').substring(0, 10) + '</strong> ';
        html += 'V:' + (h.vessel_id || '?') + ' S:' + (h.shelf_id || '?') + ' B:' + (h.bin_id || '?');
        if (h.notes) html += ' — ' + h.notes;
        html += '</div>';
      });
      html += '</div>';
    }

    // Actions
    html += '<div class="batch-detail-actions">';
    html += '<select id="batch-status-change" class="admin-select"><option value="">Change Status...</option>';
    ['primary', 'secondary', 'complete', 'disabled'].forEach(function (s) {
      html += '<option value="' + s + '"' + (s === String(b.status).toLowerCase() ? ' selected disabled' : '') + '>' + (BATCH_STATUSES[s] || {}).label + '</option>';
    });
    html += '</select>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="batch-view-url">Open Batch URL</button>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="batch-print-qr">Print QR</button>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="batch-regen-token">Regenerate URL</button>';
    html += '</div>';

    html += '</div>';

    openModal('Batch ' + b.batch_id, html);

    // Bind events
    var batchId = b.batch_id;
    var batchVersion = b.last_updated;
    var batchToken = b.access_token;

    // Task checkboxes
    document.querySelectorAll('.batch-task-check input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var taskId = cb.getAttribute('data-task-id');
        var isTransfer = cb.getAttribute('data-is-transfer') === '1';

        // If checking off a transfer task, prompt for new location
        if (cb.checked && isTransfer) {
          showTransferPrompt(batchId, taskId);
          return;
        }

        adminApiPost('update_batch_task', { task_id: taskId, updates: { completed: cb.checked } })
          .then(function () {
            showToast('Task ' + (cb.checked ? 'completed' : 'unchecked'), 'success');
            openBatchDetail(batchId);
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    });

    // Add Task button
    var addTaskBtn = document.getElementById('batch-add-task-btn');
    if (addTaskBtn) addTaskBtn.addEventListener('click', function () {
      showAddTaskForm(batchId);
    });

    // Vessel search in detail modal
    var detailVesselInput = document.getElementById('batch-edit-vessel-search');
    var detailVesselDropdown = document.getElementById('batch-edit-vessel-dropdown');
    var detailVesselHidden = document.getElementById('batch-edit-vessel');
    if (detailVesselInput && detailVesselDropdown && detailVesselHidden) {
      bindVesselSearch(detailVesselInput, detailVesselDropdown, detailVesselHidden, b.vessel_id || '');
      document.addEventListener('click', function (e) {
        if (!detailVesselDropdown.contains(e.target) && e.target !== detailVesselInput) detailVesselDropdown.style.display = 'none';
      });
    }

    // Shelf / Bin validation in detail modal
    var detailShelf = document.getElementById('batch-edit-shelf');
    var detailBin = document.getElementById('batch-edit-bin');
    if (detailShelf) bindShelfInput(detailShelf);
    if (detailBin) bindBinInput(detailBin);

    // Save location
    var saveLocBtn = document.getElementById('batch-save-location');
    if (saveLocBtn) saveLocBtn.addEventListener('click', function () {
      adminApiPost('update_batch', {
        batch_id: batchId,
        expectedVersion: batchVersion,
        updates: {
          vessel_id: document.getElementById('batch-edit-vessel').value,
          shelf_id: document.getElementById('batch-edit-shelf').value,
          bin_id: document.getElementById('batch-edit-bin').value
        }
      }).then(function () {
        showToast('Location updated', 'success');
        vesselsData = null; // refresh vessel cache
        openBatchDetail(batchId);
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });

    // Add plato reading
    var platoBtn = document.getElementById('plato-add-btn');
    if (platoBtn) platoBtn.addEventListener('click', function () {
      var val = parseFloat(document.getElementById('plato-value').value);
      if (isNaN(val)) { showToast('Enter a valid Plato value', 'error'); return; }
      adminApiPost('add_plato_reading', {
        batch_id: batchId,
        degrees_plato: val,
        notes: document.getElementById('plato-notes').value
      }).then(function () {
        showToast('Reading recorded', 'success');
        openBatchDetail(batchId);
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });

    // Save notes
    var notesBtn = document.getElementById('batch-save-notes');
    if (notesBtn) notesBtn.addEventListener('click', function () {
      adminApiPost('update_batch', {
        batch_id: batchId,
        expectedVersion: batchVersion,
        updates: { notes: document.getElementById('batch-notes-edit').value }
      }).then(function () {
        showToast('Notes saved', 'success');
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });

    // Status change
    var statusSelect = document.getElementById('batch-status-change');
    if (statusSelect) statusSelect.addEventListener('change', function () {
      var newStatus = statusSelect.value;
      if (!newStatus) return;
      adminApiPost('update_batch', {
        batch_id: batchId,
        expectedVersion: batchVersion,
        updates: { status: newStatus }
      }).then(function () {
        showToast('Status changed to ' + newStatus, 'success');
        openBatchDetail(batchId);
        loadBatchesData();
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });

    // Batch URL button
    var viewUrlBtn = document.getElementById('batch-view-url');
    if (viewUrlBtn) viewUrlBtn.addEventListener('click', function () {
      var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchToken);
      window.open(url, '_blank');
    });

    // Print QR
    var printQrBtn = document.getElementById('batch-print-qr');
    if (printQrBtn) printQrBtn.addEventListener('click', function () {
      printBatchQR(batchId, batchToken, b);
    });

    // Regenerate token
    var regenBtn = document.getElementById('batch-regen-token');
    if (regenBtn) regenBtn.addEventListener('click', function () {
      showConfirm('Regenerate batch URL? This will invalidate the current QR code.', function () {
        adminApiPost('regenerate_batch_token', { batch_id: batchId })
          .then(function (result) {
            showToast('Batch URL regenerated. Print a new QR code.', 'success');
            openBatchDetail(batchId);
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    });
  }

  // --- Transfer Prompt (shown when completing a transfer task) ---

  function showTransferPrompt(batchId, taskId) {
    var html = '<div class="batch-transfer-prompt">';
    html += '<p>This is a transfer step. Enter the new location:</p>';
    html += '<div class="form-group form-group-row">';
    html += '<div style="flex:2;"><label>Vessel</label>';
    html += '<div class="admin-kit-search-wrap" id="transfer-vessel-search-wrap">';
    html += '<input type="text" id="transfer-vessel-search" class="admin-inline-input" placeholder="Search vessels..." autocomplete="off">';
    html += '<div class="admin-kit-search-dropdown" id="transfer-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="transfer-vessel" value="">';
    html += '</div></div>';
    html += '<div><label>Shelf</label><input type="text" id="transfer-shelf" class="admin-inline-input" placeholder="A"></div>';
    html += '<div><label>Bin</label><input type="text" id="transfer-bin" class="admin-inline-input" placeholder="01"></div>';
    html += '</div>';
    html += '<div style="margin-top:8px;display:flex;gap:8px;">';
    html += '<button type="button" class="btn" id="transfer-confirm">Complete Transfer</button>';
    html += '<button type="button" class="btn-secondary" id="transfer-skip">Complete Without Transfer</button>';
    html += '</div>';
    html += '</div>';

    openModal('Transfer Step', html);

    // Bind vessel search
    var vInput = document.getElementById('transfer-vessel-search');
    var vDropdown = document.getElementById('transfer-vessel-dropdown');
    var vHidden = document.getElementById('transfer-vessel');
    if (vInput && vDropdown && vHidden) {
      bindVesselSearch(vInput, vDropdown, vHidden, '');
    }
    var shelfEl = document.getElementById('transfer-shelf');
    var binEl = document.getElementById('transfer-bin');
    if (shelfEl) bindShelfInput(shelfEl);
    if (binEl) bindBinInput(binEl);

    document.getElementById('transfer-confirm').addEventListener('click', function () {
      var vesselId = document.getElementById('transfer-vessel').value;
      var shelfId = document.getElementById('transfer-shelf').value;
      var binId = document.getElementById('transfer-bin').value;
      if (!vesselId) { showToast('Select a vessel', 'error'); return; }

      adminApiPost('update_batch_task', {
        task_id: taskId,
        updates: { completed: true },
        transfer_location: { vessel_id: vesselId, shelf_id: shelfId, bin_id: binId }
      }).then(function () {
        showToast('Transfer completed', 'success');
        vesselsData = null; // refresh vessel cache
        openBatchDetail(batchId);
      }).catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });

    document.getElementById('transfer-skip').addEventListener('click', function () {
      adminApiPost('update_batch_task', { task_id: taskId, updates: { completed: true } })
        .then(function () {
          showToast('Task completed', 'success');
          openBatchDetail(batchId);
        })
        .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });
  }

  // --- Add Ad-Hoc Task Form ---

  function showAddTaskForm(batchId) {
    var html = '<div class="batch-add-task-form">';
    html += '<div class="form-group"><label>Title</label><input type="text" id="add-task-title" class="admin-input" placeholder="Task title"></div>';
    html += '<div class="form-group"><label>Description</label><input type="text" id="add-task-desc" class="admin-input" placeholder="Optional description"></div>';
    html += '<div class="form-group"><label>Due Date</label><input type="date" id="add-task-date" class="admin-input"></div>';
    html += '<div class="form-group"><label><input type="checkbox" id="add-task-transfer"> This is a transfer step (vessel change)</label></div>';
    html += '<button type="button" class="btn" id="add-task-submit">Add Task</button>';
    html += '</div>';

    openModal('Add Task to Batch', html);

    document.getElementById('add-task-submit').addEventListener('click', function () {
      var title = document.getElementById('add-task-title').value;
      if (!title) { showToast('Enter a task title', 'error'); return; }

      var payload = {
        batch_id: batchId,
        title: title,
        description: document.getElementById('add-task-desc').value,
        due_date: document.getElementById('add-task-date').value || '',
        is_transfer: document.getElementById('add-task-transfer').checked
      };

      adminApiPost('add_batch_task', payload)
        .then(function () {
          showToast('Task added', 'success');
          openBatchDetail(batchId);
        })
        .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });
  }

  // --- Plato Chart (SVG) ---

  function renderPlatoChart(readings, startDate) {
    if (!readings || readings.length < 2) return '';
    var W = 400;
    var H = 150;
    var PAD = 30;

    var start = startDate ? new Date(startDate) : new Date(readings[0].timestamp);
    var points = readings.map(function (r) {
      var d = new Date(r.timestamp);
      var day = Math.round((d - start) / (1000 * 60 * 60 * 24));
      return { day: day, plato: Number(r.degrees_plato) };
    });

    var maxDay = Math.max.apply(null, points.map(function (p) { return p.day; })) || 1;
    var maxPlato = Math.max.apply(null, points.map(function (p) { return p.plato; })) || 1;
    var minPlato = Math.min.apply(null, points.map(function (p) { return p.plato; }));
    var range = maxPlato - minPlato || 1;

    var polyPoints = points.map(function (p) {
      var x = PAD + ((p.day / maxDay) * (W - PAD * 2));
      var y = H - PAD - (((p.plato - minPlato) / range) * (H - PAD * 2));
      return x + ',' + y;
    }).join(' ');

    var dotsSvg = points.map(function (p) {
      var x = PAD + ((p.day / maxDay) * (W - PAD * 2));
      var y = H - PAD - (((p.plato - minPlato) / range) * (H - PAD * 2));
      return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#5b7f3b"/>';
    }).join('');

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="batch-plato-svg">';
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#ccc" stroke-width="1"/>';
    svg += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#ccc" stroke-width="1"/>';
    svg += '<text x="' + PAD + '" y="' + (H - 5) + '" font-size="10" fill="#999">Day 0</text>';
    svg += '<text x="' + (W - PAD) + '" y="' + (H - 5) + '" font-size="10" fill="#999" text-anchor="end">Day ' + maxDay + '</text>';
    svg += '<text x="5" y="' + (PAD + 4) + '" font-size="10" fill="#999">' + maxPlato.toFixed(1) + '</text>';
    svg += '<text x="5" y="' + (H - PAD) + '" font-size="10" fill="#999">' + minPlato.toFixed(1) + '</text>';
    svg += '<polyline points="' + polyPoints + '" fill="none" stroke="#5b7f3b" stroke-width="2"/>';
    svg += dotsSvg;
    svg += '</svg>';
    return svg;
  }

  // --- Create Batch Modal ---

  function openCreateBatchModal() {
    // Ensure schedules are loaded
    if (fermSchedulesData.length === 0) {
      loadScheduleTemplates(function () { buildCreateBatchForm(); });
    } else {
      buildCreateBatchForm();
    }
  }

  // Vessel data cache
  var vesselsData = null;
  var zohoProductsCache = null;

  function loadVesselsData(cb) {
    adminApiGet('get_vessels')
      .then(function (result) {
        vesselsData = (result.data && result.data.vessels) || [];
        if (cb) cb();
      })
      .catch(function () {
        vesselsData = [];
        if (cb) cb();
      });
  }

  function buildVesselLabel(v) {
    var vid = String(v.vessel_id || '');
    var parts = [vid];
    if (v.type) parts.push(v.type);
    if (v.capacity_liters) parts.push(v.capacity_liters + 'L');
    if (v.material) parts.push(v.material);
    return parts.join(' — ');
  }

  /**
   * Bind typeahead search to a vessel input.
   * @param {HTMLElement} input - Text input for searching
   * @param {HTMLElement} dropdownEl - Dropdown container
   * @param {HTMLElement} hiddenEl - Hidden input storing vessel_id
   * @param {string} currentVesselId - Currently assigned vessel (shown even if in-use)
   */
  function bindVesselSearch(input, dropdownEl, hiddenEl, currentVesselId) {
    var timer;

    // Show all available vessels on focus (if empty)
    input.addEventListener('focus', function () {
      if (!input.value.trim()) showVesselOptions('', dropdownEl, hiddenEl, input, currentVesselId);
    });

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        showVesselOptions(input.value.trim().toLowerCase(), dropdownEl, hiddenEl, input, currentVesselId);
      }, 150);
    });

    // Allow clearing
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && input.value === '') {
        hiddenEl.value = '';
      }
    });
  }

  function showVesselOptions(term, dropdownEl, hiddenEl, input, currentVesselId) {
    if (!vesselsData) { dropdownEl.style.display = 'none'; return; }

    var matches = vesselsData.filter(function (v) {
      var vid = String(v.vessel_id || '');
      var status = String(v.status || '').toLowerCase();
      var isAvailable = !status || status === 'available' || status === 'empty';
      var isCurrent = vid === currentVesselId;

      // Show if available OR if it's the currently assigned vessel
      if (!isAvailable && !isCurrent) return false;

      if (!term) return true;
      var searchStr = (vid + ' ' + (v.type || '') + ' ' + (v.capacity_liters || '') + ' ' + (v.material || '') + ' ' + (v.location || '')).toLowerCase();
      return searchStr.indexOf(term) !== -1;
    });

    if (matches.length === 0) {
      dropdownEl.innerHTML = '<div class="admin-kit-search-option" style="color:var(--ink-tertiary);">No available vessels found</div>';
      dropdownEl.style.display = '';
      return;
    }

    var dHtml = '';
    matches.forEach(function (v) {
      var vid = String(v.vessel_id || '');
      var label = buildVesselLabel(v);
      var loc = v.location ? ' <span class="batch-cust-email-hint">' + v.location + '</span>' : '';
      var current = vid === currentVesselId ? ' <span class="batch-cust-email-hint">(current)</span>' : '';
      dHtml += '<div class="admin-kit-search-option" data-vid="' + vid + '">' + label + loc + current + '</div>';
    });

    dropdownEl.innerHTML = dHtml;
    dropdownEl.style.display = '';

    dropdownEl.querySelectorAll('.admin-kit-search-option').forEach(function (opt) {
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var vid = opt.getAttribute('data-vid');
        if (!vid) return;
        hiddenEl.value = vid;
        var v = vesselsData.find(function (x) { return String(x.vessel_id) === vid; });
        input.value = v ? buildVesselLabel(v) : vid;
        dropdownEl.style.display = 'none';
      });
    });
  }

  function bindShelfInput(el) {
    el.setAttribute('maxlength', '1');
    el.addEventListener('input', function () {
      el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
    });
    el.addEventListener('blur', function () {
      el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase();
    });
  }

  function bindBinInput(el) {
    el.setAttribute('maxlength', '2');
    el.addEventListener('input', function () {
      el.value = el.value.replace(/[^0-9]/g, '');
    });
    el.addEventListener('blur', function () {
      var n = parseInt(el.value, 10);
      if (isNaN(n) || n < 1) { el.value = ''; return; }
      if (n > 36) { el.value = '36'; n = 36; }
      el.value = n < 10 ? '0' + n : String(n);
    });
  }

  function buildCreateBatchForm() {
    // Ensure vessels are loaded
    if (!vesselsData) {
      loadVesselsData(function () { buildCreateBatchFormInner(); });
    } else {
      buildCreateBatchFormInner();
    }
  }

  function buildCreateBatchFormInner() {
    var html = '<div class="batch-create-form">';

    // Product search
    html += '<div class="form-group"><label>Product</label>';
    html += '<div class="admin-kit-search-wrap" id="batch-product-search-wrap">';
    html += '<input type="text" id="batch-product-search" class="admin-kit-search-input" placeholder="Search by name or SKU..." autocomplete="off">';
    html += '<div class="admin-kit-search-dropdown" id="batch-product-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="batch-product-sku" value="">';
    html += '<input type="hidden" id="batch-product-name" value="">';
    html += '</div></div>';

    // Customer search
    html += '<div class="form-group"><label>Customer</label>';
    html += '<div class="admin-kit-search-wrap" id="batch-customer-search-wrap">';
    html += '<input type="text" id="batch-customer-search" class="admin-kit-search-input" placeholder="Search Zoho contacts or type new name..." autocomplete="off">';
    html += '<div class="admin-kit-search-dropdown" id="batch-customer-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="batch-customer-id" value="">';
    html += '<input type="hidden" id="batch-customer-name" value="">';
    html += '<input type="hidden" id="batch-customer-email-val" value="">';
    html += '</div></div>';
    html += '<div id="batch-customer-info" class="batch-customer-info" style="display:none;"></div>';

    // Start date
    html += '<div class="form-group"><label>Start Date</label><input type="date" id="batch-start-date" class="admin-input" value="' + new Date().toISOString().substring(0, 10) + '"></div>';

    // Schedule template
    html += '<div class="form-group"><label>Fermentation Schedule</label><select id="batch-schedule-select" class="admin-select"><option value="">Select a template...</option>';
    fermSchedulesData.forEach(function (s) {
      html += '<option value="' + s.schedule_id + '">' + s.name + (s.category ? ' (' + s.category + ')' : '') + '</option>';
    });
    html += '</select></div>';
    html += '<div id="batch-schedule-preview" class="batch-schedule-preview"></div>';

    // Location - vessel search + shelf/bin text
    html += '<div class="form-group form-group-row">';
    html += '<div style="flex:2;"><label>Vessel</label>';
    html += '<div class="admin-kit-search-wrap" id="batch-vessel-search-wrap">';
    html += '<input type="text" id="batch-vessel-search" class="admin-kit-search-input" placeholder="Search vessels..." autocomplete="off">';
    html += '<div class="admin-kit-search-dropdown" id="batch-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="batch-vessel" value="">';
    html += '</div></div>';
    html += '<div><label>Shelf</label><input type="text" id="batch-shelf" class="admin-input" placeholder="A"></div>';
    html += '<div><label>Bin</label><input type="text" id="batch-bin" class="admin-input" placeholder="01"></div>';
    html += '</div>';

    // Notes
    html += '<div class="form-group"><label>Notes</label><textarea id="batch-create-notes" class="admin-input" rows="2"></textarea></div>';

    html += '<button type="button" class="btn" id="batch-submit-create">Create Batch</button>';
    html += '</div>';

    openModal('New Fermentation Batch', html);

    // Middleware URL — used by both product and customer search
    var mwUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) ? SHEETS_CONFIG.MIDDLEWARE_URL : '';

    // Product search behavior — load from Zoho via middleware
    var searchInput = document.getElementById('batch-product-search');
    var dropdown = document.getElementById('batch-product-dropdown');
    var searchTimer;

    function renderProductDropdown(matches, term) {
      if (matches.length === 0) {
        dropdown.innerHTML = '<div class="admin-kit-search-option" style="color:var(--ink-tertiary);">No products match "' + term + '"</div>';
        dropdown.style.display = '';
        return;
      }
      var dHtml = '';
      matches.forEach(function (k) {
        var sku = k.sku || '';
        var nm = k.name || '';
        dHtml += '<div class="admin-kit-search-option" data-sku="' + sku + '" data-name="' + nm + '">' + sku + ' — ' + nm + '</div>';
      });
      dropdown.innerHTML = dHtml;
      dropdown.style.display = '';
      dropdown.querySelectorAll('.admin-kit-search-option').forEach(function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          document.getElementById('batch-product-sku').value = opt.getAttribute('data-sku');
          document.getElementById('batch-product-name').value = opt.getAttribute('data-name');
          searchInput.value = opt.getAttribute('data-sku') + ' — ' + opt.getAttribute('data-name');
          dropdown.style.display = 'none';
        });
      });
    }

    // Fetch Zoho products once, then filter locally
    if (!zohoProductsCache && mwUrl) {
      fetch(mwUrl + '/api/products')
        .then(function (r) { return r.json(); })
        .then(function (data) { zohoProductsCache = data.items || []; })
        .catch(function () { zohoProductsCache = []; });
    }

    searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var term = searchInput.value.toLowerCase();
        if (term.length < 2) { dropdown.style.display = 'none'; return; }

        var products = zohoProductsCache || [];
        var matches = products.filter(function (k) {
          return ((k.name || '') + ' ' + (k.sku || '')).toLowerCase().indexOf(term) !== -1;
        }).slice(0, 10);

        renderProductDropdown(matches, term);
      }, 200);
    });

    // Customer search behavior
    var custInput = document.getElementById('batch-customer-search');
    var custDropdown = document.getElementById('batch-customer-dropdown');
    var custInfo = document.getElementById('batch-customer-info');
    var custTimer;

    function selectCustomer(name, email, contactId) {
      document.getElementById('batch-customer-name').value = name;
      document.getElementById('batch-customer-email-val').value = email || '';
      document.getElementById('batch-customer-id').value = contactId || '';
      custInput.value = name;
      custDropdown.style.display = 'none';

      if (email || contactId) {
        var infoHtml = '<span class="batch-customer-tag">' + name + '</span>';
        if (email) infoHtml += '<span class="batch-customer-email">' + email + '</span>';
        if (contactId) infoHtml += '<span class="batch-customer-zoho">Zoho: ' + contactId + '</span>';
        infoHtml += '<button type="button" class="btn-secondary admin-btn-sm batch-customer-clear">&times; Clear</button>';
        custInfo.innerHTML = infoHtml;
        custInfo.style.display = '';
        custInfo.querySelector('.batch-customer-clear').addEventListener('click', function () {
          document.getElementById('batch-customer-name').value = '';
          document.getElementById('batch-customer-email-val').value = '';
          document.getElementById('batch-customer-id').value = '';
          custInput.value = '';
          custInfo.style.display = 'none';
          custInput.focus();
        });
      } else {
        custInfo.style.display = 'none';
      }
    }

    custInput.addEventListener('input', function () {
      clearTimeout(custTimer);
      custTimer = setTimeout(function () {
        var term = custInput.value.trim();
        if (term.length < 2) { custDropdown.style.display = 'none'; return; }

        if (!mwUrl) {
          // No middleware — show "use as new customer" option
          custDropdown.innerHTML = '<div class="admin-kit-search-option batch-cust-new" data-name="' + term.replace(/"/g, '&quot;') + '">Use "' + term + '" as new customer</div>';
          custDropdown.style.display = '';
          custDropdown.querySelector('.batch-cust-new').addEventListener('mousedown', function (e) {
            e.preventDefault();
            selectCustomer(term, '', '');
          });
          return;
        }

        fetch(mwUrl + '/api/contacts?search=' + encodeURIComponent(term))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var contacts = data.contacts || [];
            var dHtml = '';
            contacts.slice(0, 8).forEach(function (c) {
              var cName = c.contact_name || '';
              var cEmail = c.email || '';
              var cId = c.contact_id || '';
              dHtml += '<div class="admin-kit-search-option batch-cust-option" data-name="' + cName.replace(/"/g, '&quot;') + '" data-email="' + cEmail.replace(/"/g, '&quot;') + '" data-id="' + cId + '">';
              dHtml += '<strong>' + cName + '</strong>';
              if (cEmail) dHtml += ' <span class="batch-cust-email-hint">' + cEmail + '</span>';
              dHtml += '</div>';
            });
            // Always show "new customer" option at bottom
            dHtml += '<div class="admin-kit-search-option batch-cust-new" data-name="' + term.replace(/"/g, '&quot;') + '">+ New customer: "' + term + '"</div>';
            custDropdown.innerHTML = dHtml;
            custDropdown.style.display = '';

            custDropdown.querySelectorAll('.batch-cust-option').forEach(function (opt) {
              opt.addEventListener('mousedown', function (e) {
                e.preventDefault();
                selectCustomer(opt.getAttribute('data-name'), opt.getAttribute('data-email'), opt.getAttribute('data-id'));
              });
            });
            custDropdown.querySelector('.batch-cust-new').addEventListener('mousedown', function (e) {
              e.preventDefault();
              selectCustomer(term, '', '');
            });
          })
          .catch(function () {
            custDropdown.innerHTML = '<div class="admin-kit-search-option batch-cust-new" data-name="' + term.replace(/"/g, '&quot;') + '">Use "' + term + '" as new customer</div>';
            custDropdown.style.display = '';
            custDropdown.querySelector('.batch-cust-new').addEventListener('mousedown', function (e) {
              e.preventDefault();
              selectCustomer(term, '', '');
            });
          });
      }, 300);
    });

    // Vessel search behavior
    var vesselInput = document.getElementById('batch-vessel-search');
    var vesselDropdown = document.getElementById('batch-vessel-dropdown');
    var vesselHidden = document.getElementById('batch-vessel');
    bindVesselSearch(vesselInput, vesselDropdown, vesselHidden, '');

    // Shelf / Bin validation
    bindShelfInput(document.getElementById('batch-shelf'));
    bindBinInput(document.getElementById('batch-bin'));

    // Close dropdowns on outside click
    document.addEventListener('click', function closeDropdowns(e) {
      if (!custDropdown.contains(e.target) && e.target !== custInput) custDropdown.style.display = 'none';
      if (!dropdown.contains(e.target) && e.target !== searchInput) dropdown.style.display = 'none';
      if (!vesselDropdown.contains(e.target) && e.target !== vesselInput) vesselDropdown.style.display = 'none';
    });

    // Schedule preview
    document.getElementById('batch-schedule-select').addEventListener('change', function () {
      var schedId = this.value;
      var preview = document.getElementById('batch-schedule-preview');
      var sched = fermSchedulesData.find(function (s) { return s.schedule_id === schedId; });
      if (!sched) { preview.innerHTML = ''; return; }
      var steps = sched.steps_parsed || [];
      if (!steps.length && sched.steps) {
        try { steps = JSON.parse(sched.steps); } catch (e) {}
      }
      var pHtml = '<div class="schedule-preview-steps">';
      steps.forEach(function (s) {
        var dayLabel = s.is_packaging ? 'TBD' : ('Day ' + s.day_offset);
        var badges = '';
        if (s.is_transfer) badges += ' <span class="batch-task-badge batch-task-badge--transfer">Transfer</span>';
        if (s.is_packaging) badges += ' <span class="batch-task-badge batch-task-badge--pkg">Packaging</span>';
        pHtml += '<div class="schedule-preview-step"><strong>' + dayLabel + ':</strong> ' + s.title + badges + (s.description ? ' — ' + s.description : '') + '</div>';
      });
      pHtml += '</div>';
      preview.innerHTML = pHtml;
    });

    // Submit
    document.getElementById('batch-submit-create').addEventListener('click', function () {
      var sku = document.getElementById('batch-product-sku').value;
      var productName = document.getElementById('batch-product-name').value;
      var customerName = document.getElementById('batch-customer-name').value || custInput.value.trim();
      var customerEmail = document.getElementById('batch-customer-email-val').value;
      var customerId = document.getElementById('batch-customer-id').value;
      var schedId = document.getElementById('batch-schedule-select').value;
      var startDate = document.getElementById('batch-start-date').value;

      if (!sku) { showToast('Select a product', 'error'); return; }
      if (!customerName) { showToast('Enter customer name', 'error'); return; }
      if (!schedId) { showToast('Select a schedule', 'error'); return; }
      if (!startDate) { showToast('Enter a start date', 'error'); return; }

      var submitBtn = document.getElementById('batch-submit-create');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      function doCreateBatch(resolvedId) {
        adminApiPost('create_batch', {
          product_sku: sku,
          product_name: productName,
          customer_id: resolvedId || customerId,
          customer_name: customerName,
          customer_email: customerEmail,
          start_date: startDate,
          schedule_id: schedId,
          vessel_id: document.getElementById('batch-vessel').value,
          shelf_id: document.getElementById('batch-shelf').value,
          bin_id: document.getElementById('batch-bin').value,
          notes: document.getElementById('batch-create-notes').value
        }).then(function (result) {
          showToast('Batch ' + result.batch_id + ' created with ' + result.tasks_created + ' tasks', 'success');
          closeModal();
          vesselsData = null; // refresh vessel cache on next use
          loadBatchesData();
          loadBatchDashboardSummary();
        }).catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Batch';
          showToast('Failed: ' + err.message, 'error');
        });
      }

      // If new customer (no Zoho ID) and we have middleware, create in Zoho first
      if (!customerId && mwUrl && customerEmail) {
        fetch(mwUrl + '/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: customerName, email: customerEmail })
        })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.contact_id) {
            document.getElementById('batch-customer-id').value = data.contact_id;
            doCreateBatch(data.contact_id);
          } else {
            doCreateBatch('');
          }
        })
        .catch(function () { doCreateBatch(''); });
      } else if (!customerId && mwUrl && !customerEmail) {
        // No email — can't create Zoho contact, proceed without
        doCreateBatch('');
      } else {
        doCreateBatch(customerId);
      }
    });
  }

  // --- Schedule Templates ---

  function renderScheduleTemplates() {
    var container = document.getElementById('schedules-list');
    var emptyMsg = document.getElementById('schedules-empty');
    if (!container) return;

    if (fermSchedulesData.length === 0) {
      container.innerHTML = '';
      if (emptyMsg) emptyMsg.style.display = '';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    var html = '';
    fermSchedulesData.forEach(function (s) {
      var steps = s.steps_parsed || [];
      if (!steps.length && s.steps) {
        try { steps = JSON.parse(s.steps); } catch (e) {}
      }

      html += '<div class="schedule-card">';
      html += '<div class="schedule-card-header">';
      html += '<strong>' + (s.name || 'Untitled') + '</strong>';
      html += '<span class="schedule-card-actions">';
      html += '<button type="button" class="btn-secondary admin-btn-sm sched-edit-btn" data-sched-id="' + s.schedule_id + '">Edit</button>';
      html += '<button type="button" class="btn-secondary admin-btn-sm admin-btn-danger sched-delete-btn" data-sched-id="' + s.schedule_id + '">Delete</button>';
      html += '</span>';
      html += '</div>';
      if (s.category) html += '<div class="schedule-card-meta">Category: ' + s.category + '</div>';
      html += '<div class="schedule-card-meta">' + steps.length + ' steps</div>';
      html += '<div class="schedule-card-steps">';
      steps.forEach(function (st) {
        var dayLabel = st.is_packaging ? 'TBD' : ('Day ' + st.day_offset);
        var stBadges = '';
        if (st.is_transfer) stBadges += ' <span class="batch-task-badge batch-task-badge--transfer">Transfer</span>';
        if (st.is_packaging) stBadges += ' <span class="batch-task-badge batch-task-badge--pkg">Packaging</span>';
        html += '<div class="schedule-step-line"><span class="schedule-step-day">' + dayLabel + '</span> ' + st.title + stBadges + '</div>';
      });
      html += '</div></div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.sched-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openEditScheduleModal(btn.getAttribute('data-sched-id'));
      });
    });

    container.querySelectorAll('.sched-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var sid = btn.getAttribute('data-sched-id');
        showConfirm('Delete this schedule template?', function () {
          adminApiPost('delete_ferm_schedule', { schedule_id: sid })
            .then(function () {
              showToast('Schedule deleted', 'success');
              loadScheduleTemplates();
            })
            .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
        });
      });
    });
  }

  function openCreateScheduleModal() {
    renderScheduleForm(null);
  }

  function openEditScheduleModal(schedId) {
    var sched = fermSchedulesData.find(function (s) { return s.schedule_id === schedId; });
    if (!sched) { showToast('Schedule not found', 'error'); return; }
    renderScheduleForm(sched);
  }

  function renderScheduleForm(existing) {
    var isEdit = !!existing;
    var regularSteps = [];
    var pkgTitle = 'Bottling / Packaging';
    var pkgDesc = '';
    if (existing) {
      var allSteps = existing.steps_parsed || [];
      if (!allSteps.length && existing.steps) {
        try { allSteps = JSON.parse(existing.steps); } catch (e) {}
      }
      allSteps.forEach(function (s) {
        if (s.is_packaging) {
          pkgTitle = s.title || pkgTitle;
          pkgDesc = s.description || pkgDesc;
        } else {
          regularSteps.push(s);
        }
      });
    }
    if (regularSteps.length === 0) {
      regularSteps = [{ step_number: 1, day_offset: 0, title: '', description: '' }];
    }

    var html = '<div class="schedule-form">';
    html += '<div class="form-group"><label>Template Name</label><input type="text" id="sched-name" class="admin-input" value="' + (existing ? existing.name || '' : '') + '"></div>';
    html += '<div class="form-group"><label>Description</label><textarea id="sched-desc" class="admin-input" rows="2">' + (existing ? existing.description || '' : '') + '</textarea></div>';
    html += '<div class="form-group"><label>Category</label><select id="sched-category" class="admin-select">';
    html += '<option value="">None</option>';
    ['wine', 'beer', 'cider', 'seltzer'].forEach(function (c) {
      html += '<option value="' + c + '"' + (existing && existing.category === c ? ' selected' : '') + '>' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>';
    });
    html += '</select></div>';

    html += '<h4>Fermentation Steps</h4>';
    html += '<p class="sched-form-hint">Add each step with its day offset from the start date. Steps are sorted by day automatically. Check "Transfer" if the step involves moving to a new vessel.</p>';
    html += '<div class="sched-steps-header"><span class="sched-col-day">Day</span><span class="sched-col-title">Title</span><span class="sched-col-desc">Description</span><span class="sched-col-transfer">Transfer</span><span class="sched-col-actions"></span></div>';
    html += '<div id="sched-steps-container"></div>';
    html += '<button type="button" class="btn-secondary admin-btn-sm" id="sched-add-step">+ Add Step</button>';

    html += '<h4>Packaging Step <span class="sched-pkg-note">(always last, date TBD until all other steps are done)</span></h4>';
    html += '<div class="sched-pkg-row">';
    html += '<input type="text" id="sched-pkg-title" class="admin-inline-input" value="' + pkgTitle + '" placeholder="Title" style="flex:1;">';
    html += '<input type="text" id="sched-pkg-desc" class="admin-inline-input" value="' + pkgDesc + '" placeholder="Description (optional)" style="flex:1;">';
    html += '</div>';

    html += '<br>';
    html += '<button type="button" class="btn" id="sched-submit">' + (isEdit ? 'Update Template' : 'Create Template') + '</button>';
    html += '</div>';

    openModal((isEdit ? 'Edit' : 'New') + ' Schedule Template', html);

    var stepsContainer = document.getElementById('sched-steps-container');
    window._schedSteps = regularSteps.slice();

    function renderSteps() {
      var sHtml = '';
      window._schedSteps.forEach(function (s, idx) {
        sHtml += '<div class="sched-step-row" data-idx="' + idx + '">';
        sHtml += '<input type="number" class="admin-inline-input sched-step-day" value="' + s.day_offset + '" placeholder="Day" min="0" style="width:60px;">';
        sHtml += '<input type="text" class="admin-inline-input sched-step-title" value="' + (s.title || '') + '" placeholder="Step title" style="flex:1;">';
        sHtml += '<input type="text" class="admin-inline-input sched-step-desc" value="' + (s.description || '') + '" placeholder="Description (optional)" style="flex:1;">';
        sHtml += '<label class="sched-transfer-check"><input type="checkbox" class="sched-step-transfer"' + (s.is_transfer ? ' checked' : '') + '></label>';
        sHtml += '<button type="button" class="btn-secondary admin-btn-sm admin-btn-danger sched-step-remove" title="Remove step">&times;</button>';
        sHtml += '</div>';
      });
      stepsContainer.innerHTML = sHtml;

      stepsContainer.querySelectorAll('.sched-step-row').forEach(function (row) {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        row.querySelector('.sched-step-day').addEventListener('change', function () {
          window._schedSteps[idx].day_offset = parseInt(this.value, 10) || 0;
        });
        row.querySelector('.sched-step-title').addEventListener('change', function () {
          window._schedSteps[idx].title = this.value;
        });
        row.querySelector('.sched-step-desc').addEventListener('change', function () {
          window._schedSteps[idx].description = this.value;
        });
        row.querySelector('.sched-step-transfer').addEventListener('change', function () {
          window._schedSteps[idx].is_transfer = this.checked;
        });
        row.querySelector('.sched-step-remove').addEventListener('click', function () {
          if (window._schedSteps.length <= 1) { showToast('Need at least 1 fermentation step', 'error'); return; }
          window._schedSteps.splice(idx, 1);
          renderSteps();
        });
      });
    }
    renderSteps();

    document.getElementById('sched-add-step').addEventListener('click', function () {
      var maxDay = 0;
      window._schedSteps.forEach(function (s) { if (s.day_offset > maxDay) maxDay = s.day_offset; });
      window._schedSteps.push({ step_number: 0, day_offset: maxDay + 7, title: '', description: '' });
      renderSteps();
    });

    document.getElementById('sched-submit').addEventListener('click', function () {
      var name = document.getElementById('sched-name').value;
      if (!name) { showToast('Enter a template name', 'error'); return; }

      // Read current values from inputs (in case user typed without triggering change)
      stepsContainer.querySelectorAll('.sched-step-row').forEach(function (row) {
        var idx = parseInt(row.getAttribute('data-idx'), 10);
        window._schedSteps[idx].day_offset = parseInt(row.querySelector('.sched-step-day').value, 10) || 0;
        window._schedSteps[idx].title = row.querySelector('.sched-step-title').value;
        window._schedSteps[idx].description = row.querySelector('.sched-step-desc').value;
        window._schedSteps[idx].is_transfer = row.querySelector('.sched-step-transfer').checked;
      });

      // Validate regular steps have titles
      var emptyTitle = false;
      window._schedSteps.forEach(function (s) { if (!s.title.trim()) emptyTitle = true; });
      if (emptyTitle) { showToast('Every step needs a title', 'error'); return; }

      // Sort regular steps by day_offset, then build final steps array
      var sorted = window._schedSteps.slice().sort(function (a, b) { return a.day_offset - b.day_offset; });
      var steps = sorted.map(function (s, idx) {
        return { step_number: idx + 1, day_offset: s.day_offset, title: s.title, description: s.description, is_packaging: false, is_transfer: !!s.is_transfer };
      });

      // Append packaging as final step
      steps.push({
        step_number: steps.length + 1,
        day_offset: -1,
        title: document.getElementById('sched-pkg-title').value || 'Bottling / Packaging',
        description: document.getElementById('sched-pkg-desc').value || '',
        is_packaging: true
      });

      var payload = {
        name: name,
        description: document.getElementById('sched-desc').value,
        category: document.getElementById('sched-category').value,
        steps: steps
      };

      var action = isEdit ? 'update_ferm_schedule' : 'create_ferm_schedule';
      if (isEdit) payload.schedule_id = existing.schedule_id;

      adminApiPost(action, payload)
        .then(function (result) {
          showToast('Schedule ' + (isEdit ? 'updated' : 'created'), 'success');
          closeModal();
          loadScheduleTemplates();
        })
        .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
    });
  }

  // --- Calendar View ---

  function initCalendarNav() {
    var now = new Date();
    calendarYear = now.getFullYear();
    calendarMonth = now.getMonth();

    var prevBtn = document.getElementById('cal-prev-month');
    var nextBtn = document.getElementById('cal-next-month');
    if (prevBtn) prevBtn.addEventListener('click', function () {
      calendarMonth--;
      if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
      renderBatchCalendar(calendarYear, calendarMonth);
    });
    if (nextBtn) nextBtn.addEventListener('click', function () {
      calendarMonth++;
      if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
      renderBatchCalendar(calendarYear, calendarMonth);
    });
  }

  function renderBatchCalendar(year, month) {
    if (year === undefined || month === undefined) return;
    var firstDay = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0);

    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    var startStr = year + '-' + pad(month + 1) + '-01';
    var endStr = year + '-' + pad(month + 1) + '-' + pad(lastDay.getDate());

    var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var label = document.getElementById('cal-month-label');
    if (label) label.textContent = monthNames[month] + ' ' + year;

    adminApiGet('get_tasks_calendar', { start_date: startStr, end_date: endStr })
      .then(function (result) {
        var tasks = (result.data && result.data.tasks) || [];
        var tasksByDate = {};
        tasks.forEach(function (t) {
          if (!t.due_date) return;
          if (!tasksByDate[t.due_date]) tasksByDate[t.due_date] = [];
          tasksByDate[t.due_date].push(t);
        });
        renderCalendarGrid(year, month, tasksByDate);
      })
      .catch(function (err) {
        showToast('Failed to load calendar: ' + err.message, 'error');
      });
  }

  function renderCalendarGrid(year, month, tasksByDate) {
    var grid = document.getElementById('batch-calendar-grid');
    if (!grid) return;

    var today = new Date();
    var todayStr = today.getFullYear() + '-' + (today.getMonth() < 9 ? '0' : '') + (today.getMonth() + 1) + '-' + (today.getDate() < 10 ? '0' : '') + today.getDate();

    var html = '';
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayNames.forEach(function (d) {
      html += '<div class="batch-cal-header">' + d + '</div>';
    });

    var firstDay = new Date(year, month, 1);
    var lastDay = new Date(year, month + 1, 0);
    var startDow = firstDay.getDay();

    // Fill leading blanks
    for (var i = 0; i < startDow; i++) {
      html += '<div class="batch-cal-day batch-cal-day--other-month"></div>';
    }

    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    for (var d = 1; d <= lastDay.getDate(); d++) {
      var dateStr = year + '-' + pad(month + 1) + '-' + pad(d);
      var isToday = dateStr === todayStr;
      var dayTasks = tasksByDate[dateStr] || [];
      var cls = 'batch-cal-day';
      if (isToday) cls += ' batch-cal-day--today';

      html += '<div class="' + cls + '" data-date="' + dateStr + '">';
      html += '<div class="batch-cal-day-num">' + d + '</div>';

      var shown = 0;
      dayTasks.forEach(function (t) {
        if (shown >= 3) return;
        var tCls = 'batch-cal-task';
        if (t.completed) tCls += ' batch-cal-task--done';
        else if (t.due_date < todayStr) tCls += ' batch-cal-task--overdue';
        else tCls += ' batch-cal-task--pending';
        html += '<div class="' + tCls + '">' + t.title + '</div>';
        shown++;
      });
      if (dayTasks.length > 3) {
        html += '<div class="batch-cal-task-count">+' + (dayTasks.length - 3) + ' more</div>';
      }
      html += '</div>';
    }

    grid.innerHTML = html;

    // Click day to show detail
    grid.querySelectorAll('.batch-cal-day[data-date]').forEach(function (el) {
      el.addEventListener('click', function () {
        grid.querySelectorAll('.batch-cal-day--selected').forEach(function (s) { s.classList.remove('batch-cal-day--selected'); });
        el.classList.add('batch-cal-day--selected');
        var dateStr = el.getAttribute('data-date');
        showCalendarDayDetail(dateStr, tasksByDate[dateStr] || []);
      });
    });
  }

  function showCalendarDayDetail(dateStr, tasks) {
    var container = document.getElementById('batch-calendar-day-detail');
    if (!container) return;

    if (tasks.length === 0) {
      container.innerHTML = '<p class="admin-order-info">No tasks on ' + dateStr + '</p>';
      return;
    }

    var todayStr = new Date().toISOString().substring(0, 10);
    var html = '<h3>' + dateStr + ' — ' + tasks.length + ' task' + (tasks.length !== 1 ? 's' : '') + '</h3>';
    tasks.forEach(function (t) {
      var doneClass = t.completed ? ' batch-cal-detail--done' : '';
      var overdueClass = (!t.completed && t.due_date && t.due_date < todayStr) ? ' batch-cal-detail--overdue' : '';
      html += '<div class="batch-cal-detail-task' + doneClass + overdueClass + '">';
      html += '<label><input type="checkbox" ' + (t.completed ? 'checked' : '') + ' data-task-id="' + t.task_id + '" data-batch-id="' + t.batch_id + '"> ';
      html += '<strong>' + t.title + '</strong></label>';
      html += ' — ' + t.batch_id + ' (' + (t.product_name || '') + ')';
      html += ' — ' + (t.vessel_id || '') + '/' + (t.shelf_id || '');
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        adminApiPost('update_batch_task', { task_id: cb.getAttribute('data-task-id'), updates: { completed: cb.checked } })
          .then(function () {
            showToast('Task ' + (cb.checked ? 'completed' : 'unchecked'), 'success');
            renderBatchCalendar(calendarYear, calendarMonth);
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    });
  }

  // --- Upcoming Tasks ---

  function loadUpcomingTasks() {
    adminApiGet('get_tasks_upcoming', { limit: 50 })
      .then(function (result) {
        renderUpcomingTasks((result.data && result.data.tasks) || []);
      })
      .catch(function (err) {
        showToast('Failed to load tasks: ' + err.message, 'error');
      });
  }

  function renderUpcomingTasks(tasks) {
    var container = document.getElementById('upcoming-tasks-list');
    var emptyMsg = document.getElementById('upcoming-empty');
    if (!container) return;

    if (tasks.length === 0) {
      container.innerHTML = '';
      if (emptyMsg) emptyMsg.style.display = '';
      return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    var todayStr = new Date().toISOString().substring(0, 10);
    var tomorrow = new Date(Date.now() + 86400000).toISOString().substring(0, 10);
    var weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10);

    var groups = {
      overdue: { label: 'Overdue', tasks: [] },
      today: { label: 'Today', tasks: [] },
      tomorrow: { label: 'Tomorrow', tasks: [] },
      thisWeek: { label: 'This Week', tasks: [] },
      later: { label: 'Later', tasks: [] },
      tbd: { label: 'TBD (Packaging)', tasks: [] }
    };

    tasks.forEach(function (t) {
      if (!t.due_date) groups.tbd.tasks.push(t);
      else if (t.due_date < todayStr) groups.overdue.tasks.push(t);
      else if (t.due_date === todayStr) groups.today.tasks.push(t);
      else if (t.due_date === tomorrow) groups.tomorrow.tasks.push(t);
      else if (t.due_date <= weekEnd) groups.thisWeek.tasks.push(t);
      else groups.later.tasks.push(t);
    });

    var html = '';
    ['overdue', 'today', 'tomorrow', 'thisWeek', 'later', 'tbd'].forEach(function (key) {
      var g = groups[key];
      if (g.tasks.length === 0) return;
      html += '<div class="upcoming-group">';
      html += '<h3 class="upcoming-group-label' + (key === 'overdue' ? ' upcoming-group-label--overdue' : '') + '">' + g.label + ' (' + g.tasks.length + ')</h3>';
      g.tasks.forEach(function (t) {
        html += '<div class="upcoming-task-row">';
        html += '<label><input type="checkbox" data-task-id="' + t.task_id + '" data-batch-id="' + t.batch_id + '"> ';
        html += '<strong>' + t.title + '</strong></label>';
        html += '<span class="upcoming-task-meta">' + t.batch_id + ' — ' + (t.product_name || '') + '</span>';
        html += '<span class="upcoming-task-loc">' + [t.vessel_id, t.shelf_id, t.bin_id].filter(Boolean).join('/') + '</span>';
        if (t.due_date) html += '<span class="upcoming-task-date">' + t.due_date + '</span>';
        html += '</div>';
      });
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        adminApiPost('update_batch_task', { task_id: cb.getAttribute('data-task-id'), updates: { completed: cb.checked } })
          .then(function () {
            showToast('Task completed', 'success');
            loadUpcomingTasks();
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    });
  }

  // --- QR Code Generation ---

  function generateBatchQR(batchId, accessToken) {
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(accessToken);
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr;
  }

  function showBatchQRModal(batchId, accessToken, batchData) {
    if (typeof qrcode === 'undefined') { showToast('QR library not loaded', 'error'); return; }
    var qr = generateBatchQR(batchId, accessToken);
    var svg = qr.createSvgTag(6);
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(accessToken);

    var body = '<div style="text-align:center;">';
    body += '<div style="margin:10px auto;">' + svg + '</div>';
    body += '<p><strong>' + batchId + '</strong></p>';
    body += '<p>' + (batchData.product_name || '') + '</p>';
    body += '<p>' + (batchData.customer_name || '') + '</p>';
    body += '<p style="font-size:0.8rem;word-break:break-all;color:#666;">' + url + '</p>';
    body += '<button type="button" class="btn" id="qr-print-btn">Print Label</button>';
    body += '<button type="button" class="btn-secondary" id="qr-copy-url-btn" style="margin-left:8px;">Copy URL</button>';
    body += '</div>';

    openModal('Batch QR Code', body);

    document.getElementById('qr-print-btn').addEventListener('click', function () {
      printBatchQR(batchId, accessToken, batchData);
    });
    document.getElementById('qr-copy-url-btn').addEventListener('click', function () {
      navigator.clipboard.writeText(url).then(function () {
        showToast('URL copied to clipboard', 'success');
      });
    });
  }

  function printBatchQR(batchId, accessToken, batchData) {
    if (typeof qrcode === 'undefined') return;
    var qr = generateBatchQR(batchId, accessToken);
    var svg = qr.createSvgTag(8);

    var pw = window.open('', '_blank');
    pw.document.write(
      '<html><head><title>Batch ' + batchId + '</title>' +
      '<style>body{font-family:sans-serif;text-align:center;padding:20px;margin:0;}.label{border:2px solid #333;padding:15px;display:inline-block;}.qr{margin:10px auto;}.info{margin:4px 0;font-size:14px;}.batch-id{font-size:18px;font-weight:bold;margin-bottom:8px;}@media print{.label{border:none;}}</style>' +
      '</head><body><div class="label">' +
      '<div class="batch-id">' + batchId + '</div>' +
      '<div class="qr">' + svg + '</div>' +
      '<div class="info"><strong>' + (batchData.product_name || '') + '</strong></div>' +
      '<div class="info">' + (batchData.customer_name || '') + '</div>' +
      '<div class="info">Started: ' + (batchData.start_date || '') + '</div>' +
      '<div class="info">Vessel: ' + (batchData.vessel_id || '?') + ' | Shelf: ' + (batchData.shelf_id || '?') + ' | Bin: ' + (batchData.bin_id || '?') + '</div>' +
      '</div></body></html>'
    );
    pw.document.close();
    setTimeout(function () { pw.print(); }, 250);
  }

  // --- Dashboard Integration ---

  function renderBatchPipeline() {
    var stagesEl = document.getElementById('batch-pipeline-stages');
    if (!stagesEl || !batchDashboardSummary) { if (stagesEl) stagesEl.innerHTML = '<div class="pipeline-empty">No batch data</div>'; return; }

    var s = batchDashboardSummary;
    var stages = { primary: s.primaryCount || 0, secondary: s.secondaryCount || 0, complete: s.completeCount || 0 };
    var total = stages.primary + stages.secondary + stages.complete;

    if (total === 0) {
      stagesEl.innerHTML = '<div class="pipeline-empty">No batches yet</div>';
      return;
    }

    var stageOrder = ['primary', 'secondary', 'complete'];
    var stageLabels = { primary: 'Primary', secondary: 'Secondary', complete: 'Complete' };
    var html = '';
    stageOrder.forEach(function (key) {
      if (stages[key] > 0) {
        html += '<div class="pipeline-stage pipeline-stage--' + key + '" style="flex:' + stages[key] + ';" data-filter="' + key + '">';
        html += '<span class="pipeline-stage-count">' + stages[key] + '</span>';
        html += '<span class="pipeline-stage-name">' + stageLabels[key] + '</span>';
        html += '</div>';
      }
    });
    stagesEl.innerHTML = html;

    stagesEl.querySelectorAll('.pipeline-stage').forEach(function (el) {
      el.addEventListener('click', function () {
        document.querySelector('[data-tab="batches"]').click();
        var filter = el.getAttribute('data-filter');
        var select = document.getElementById('batch-status-filter');
        if (select) { select.value = filter; loadBatchesData(); }
      });
    });
  }

  function addBatchAttentionItems(summary) {
    if (!summary) return;
    var listEl = document.getElementById('attention-list');
    if (!listEl) return;

    var items = [];
    if (summary.tasksDueToday > 0) {
      items.push({ text: summary.tasksDueToday + ' batch task' + (summary.tasksDueToday !== 1 ? 's' : '') + ' due today', dot: 'warning', tab: 'batches' });
    }
    if (summary.overdueTasks > 0) {
      items.push({ text: summary.overdueTasks + ' overdue batch task' + (summary.overdueTasks !== 1 ? 's' : ''), dot: 'danger', tab: 'batches' });
    }
    if (summary.readyForPackaging > 0) {
      items.push({ text: summary.readyForPackaging + ' batch' + (summary.readyForPackaging !== 1 ? 'es' : '') + ' ready for packaging', dot: 'success', tab: 'batches' });
    }

    if (items.length === 0) return;

    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'attention-item';
      div.setAttribute('data-tab', item.tab);
      div.innerHTML = '<span class="attention-dot attention-dot--' + item.dot + '"></span>' + item.text;
      div.addEventListener('click', function () {
        document.querySelector('[data-tab="' + item.tab + '"]').click();
      });
      listEl.appendChild(div);
    });
  }

  // --- Init Batch Controls ---

  function initBatchControls() {
    initBatchSubTabs();
    initCalendarNav();

    var createBtn = document.getElementById('create-batch-btn');
    if (createBtn) createBtn.addEventListener('click', openCreateBatchModal);

    var createSchedBtn = document.getElementById('create-schedule-btn');
    if (createSchedBtn) createSchedBtn.addEventListener('click', openCreateScheduleModal);

    var batchFilter = document.getElementById('batch-status-filter');
    if (batchFilter) batchFilter.addEventListener('change', function () { loadBatchesData(); });

    var batchSearch = document.getElementById('batch-search');
    var batchSearchTimer;
    if (batchSearch) batchSearch.addEventListener('input', function () {
      clearTimeout(batchSearchTimer);
      batchSearchTimer = setTimeout(renderBatchList, 300);
    });

    var refreshBtn = document.getElementById('upcoming-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadUpcomingTasks);
  }

  // Hook batch loading into data load
  var _origFinishDataLoad = finishDataLoad;
  finishDataLoad = function () {
    _origFinishDataLoad();
    if (SHEETS_CONFIG.ADMIN_API_URL) {
      loadBatchesData();
      loadBatchDashboardSummary();
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    initBatchControls();
  });

})();

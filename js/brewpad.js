// ===== Steins & Vines BrewPad — iPad Batch Terminal =====
// Self-contained IIFE — no dependency on admin.js.

(function () {
  'use strict';

  // ===== State =====

  var accessToken = null;
  var userEmail = null;
  var tokenClient = null;
  var _tokenRefreshTimer = null;
  var _silentRefreshTimer = null;
  var _handlingUnauthorized = false;
  var _activeTab = 'dashboard';

  // Batches
  var _batchesData = [];
  var _allBatchesData = [];  // full unfiltered batch list (all statuses) — source of truth for filter/search
  var _eagerLoadDone = false;
  var _eagerLoadTime = 0;
  var _batchesLoaded = false;
  var _batchesLoading = false;
  var _batchesLoadTime = 0;
  var _batchStatusFilter = 'active';
  var _batchSearch = '';
  var _batchSearchTimer = null;   // module-scope so switchTab() can cancel a pending re-render
  var _selectedBatchId = null;
  var _vesselsData = null;
  var _vesselsCacheTime = 0;       // TTL: reload vessel list if >30s stale
  var _vesselsMap = {};            // keyed by vessel_id for O(1) lookup
  var _fermSchedules = [];
  var _fermSchedulesCacheTime = 0; // TTL: reload schedule list if >5min stale

  // Batch detail
  var _detailPendingTasks = {};
  var _detailPlatoStaging = [];
  var _detailPlatoReadings = [];
  var _detailStartDate = null;
  var _detailBatchId = null;

  // Tasks
  var _upcomingTasks = [];
  var _upcomingLoaded = false;
  var _upcomingLoadTime = 0;
  var _taskPendingChanges = {};

  // Measurements
  var _measBatches = [];
  var _measSelectedBatchId = '';
  var _measReadings = [];
  var _measEntryRows = [];   // array of {id, timestamp, degrees_plato, temperature, ph, notes}
  var _measRowCounter = 0;   // unique ID for each row (for DOM keying)
  var _measStartDate = null;
  var _measRequestId = 0;   // increments on each batch select; stale responses are discarded
  var _measSearchTimer = null;

  // Dashboard
  var _dashSummary = null;
  var _dashLoadTime = 0;
  var _dashAutoRefreshTimer = null;

  // Product catalog
  var _kitCatalog = null;
  var _kitCatalogLoadTime = 0;

  var CACHE_TTL = 30000;       // 30s per-tab cache
  var KIT_CACHE_TTL = 300000;  // 5min product catalog

  // ===== Session =====

  var SESSION_KEY = 'sv-brewpad-session';

  function saveSession(token, expiresIn, email) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      token: token,
      expires_at: Date.now() + (expiresIn * 1000),
      email: email
    }));
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.expires_at < Date.now() + 5 * 60 * 1000) return null;
      return data;
    } catch (e) { return null; }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // ===== Toast =====

  function showToast(message, type, opts) {
    if (!type) type = 'info';
    if (!opts) opts = {};
    var container = document.getElementById('bp-toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'bp-toast bp-toast--' + type;
    var msgSpan = document.createElement('span');
    msgSpan.className = 'bp-toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);
    var closeBtn = document.createElement('button');
    closeBtn.className = 'bp-toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { removeToast(toast); });
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    var duration = opts.duration || (type === 'error' ? 6000 : 3500);
    toast._timer = setTimeout(function () { removeToast(toast); }, duration);
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

    var signoutBtn = document.getElementById('bp-signout');
    if (signoutBtn) signoutBtn.addEventListener('click', bpSignOut);

    var saved = loadSession();
    if (saved) {
      // Fallback: if no response in 15s, just show the signin button.
      // Do NOT clear session here — the token may still arrive.
      _silentRefreshTimer = setTimeout(function () {
        _silentRefreshTimer = null;
        showSignInButton();
      }, 15000);
      var _refreshAttempts = 0;
      function attemptSilentRefresh() {
        try {
          tokenClient.requestAccessToken({ prompt: '', login_hint: saved.email });
        } catch (err) {
          _refreshAttempts++;
          if (_refreshAttempts < 3) {
            setTimeout(attemptSilentRefresh, 1000 * _refreshAttempts);
          } else {
            clearTimeout(_silentRefreshTimer);
            _silentRefreshTimer = null;
            clearSession();
            showSignInButton();
          }
        }
      }
      attemptSilentRefresh();
      return;
    }
    showSignInButton();
  }

  function showSignInButton() {
    var container = document.getElementById('bp-google-signin-btn');
    if (container && !container.querySelector('button')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Sign in with Google';
      btn.addEventListener('click', function () { tokenClient.requestAccessToken(); });
      container.appendChild(btn);
    }
  }

  function onTokenResponse(response) {
    if (_silentRefreshTimer) { clearTimeout(_silentRefreshTimer); _silentRefreshTimer = null; }
    _handlingUnauthorized = false;
    if (response.error) {
      clearSession();
      showSignInButton();
      return;
    }
    accessToken = response.access_token;
    var expiresIn = response.expires_in || 3600;
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    })
      .then(function (res) { return res.json(); })
      .then(function (info) {
        userEmail = info.email;
        saveSession(accessToken, expiresIn, userEmail);
        checkAuthorization();
      })
      .catch(function () { showDenied(); });
  }

  function checkAuthorization() {
    adminApiGet('check_auth')
      .then(function (result) {
        if (result.authorized) { showApp(); } else { showDenied(); }
      })
      .catch(function () { showDenied(); });
  }

  function showApp() {
    document.getElementById('bp-signin').style.display = 'none';
    document.getElementById('bp-app').style.display = '';
    var emailEl = document.getElementById('bp-user-email');
    if (emailEl) emailEl.textContent = userEmail;
    var deniedMsg = document.getElementById('bp-denied-msg');
    if (deniedMsg) deniedMsg.style.display = 'none';

    if (_tokenRefreshTimer) clearInterval(_tokenRefreshTimer);
    _tokenRefreshTimer = setInterval(function () {
      tokenClient.requestAccessToken({ prompt: '' });
    }, 50 * 60 * 1000);

    // Multi-tab session sync: if another tab signs out, sign out this tab too
    window.addEventListener('storage', function (e) {
      if (e.key === SESSION_KEY && !e.newValue && accessToken) {
        accessToken = null; userEmail = null;
        handleUnauthorized();
      }
    });

    eagerLoad();
  }

  function showDenied() {
    var el = document.getElementById('bp-denied-msg');
    if (el) el.style.display = '';
  }

  function bpSignOut() {
    if (_tokenRefreshTimer) { clearInterval(_tokenRefreshTimer); _tokenRefreshTimer = null; }
    if (_dashAutoRefreshTimer) { clearInterval(_dashAutoRefreshTimer); _dashAutoRefreshTimer = null; }
    if (accessToken) google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
    userEmail = null;
    clearSession();
    document.getElementById('bp-signin').style.display = '';
    document.getElementById('bp-app').style.display = 'none';
    var emailEl = document.getElementById('bp-user-email');
    if (emailEl) emailEl.textContent = '';
  }

  function handleUnauthorized() {
    if (_handlingUnauthorized) return;
    _handlingUnauthorized = true;
    if (_tokenRefreshTimer) { clearInterval(_tokenRefreshTimer); _tokenRefreshTimer = null; }
    clearSession();
    accessToken = null;
    userEmail = null;
    document.getElementById('bp-signin').style.display = '';
    document.getElementById('bp-app').style.display = 'none';
    var emailEl = document.getElementById('bp-user-email');
    if (emailEl) emailEl.textContent = '';
    showSignInButton();
  }

  // ===== API Helpers =====

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

  function isUnauthorizedError(data) {
    var msg = ((data.message || data.error || '') + '').toLowerCase();
    return msg.indexOf('unauthorized') !== -1 || msg.indexOf('not authorized') !== -1;
  }

  function adminApiGet(action, params) {
    if (!SHEETS_CONFIG.ADMIN_API_URL) return Promise.reject(new Error('Admin API not configured'));
    var url = SHEETS_CONFIG.ADMIN_API_URL + '?action=' + encodeURIComponent(action) +
      '&token=' + encodeURIComponent(accessToken);
    if (params) {
      Object.keys(params).forEach(function (key) {
        url += '&' + encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
      });
    }
    return fetchWithRetry(url, { method: 'GET' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (isUnauthorizedError(data)) handleUnauthorized();
          throw new Error(data.message || data.error || 'API error');
        }
        return data;
      });
  }

  function adminApiPost(action, payload) {
    if (!SHEETS_CONFIG.ADMIN_API_URL) return Promise.reject(new Error('Admin API not configured'));
    payload.action = action;
    payload.token = accessToken;
    return fetchWithRetry(SHEETS_CONFIG.ADMIN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.ok) {
          if (isUnauthorizedError(data)) handleUnauthorized();
          throw new Error(data.message || data.error || 'API error');
        }
        return data;
      });
  }

  function mwUrl() {
    return (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL) || '';
  }

  // ===== Utilities =====

  function escapeHTML(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    return String(dateStr).substring(0, 10);
  }

  function isOverdue(dateStr) {
    if (!dateStr) return false;
    return String(dateStr).substring(0, 10) < todayStr();
  }

  function isToday(dateStr) {
    if (!dateStr) return false;
    return String(dateStr).substring(0, 10) === todayStr();
  }

  // ===== Tab Switching =====

  function switchTab(tab) {
    _activeTab = tab;

    // Cancel any pending search re-render from the previous tab
    if (_batchSearchTimer) { clearTimeout(_batchSearchTimer); _batchSearchTimer = null; }

    Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
      var isActive = btn.getAttribute('data-tab') === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    var panels = ['dashboard', 'batches', 'tasks', 'measurements'];
    panels.forEach(function (p) {
      var el = document.getElementById('bp-panel-' + p);
      if (el) el.style.display = (p === tab) ? '' : 'none';
    });

    var now = Date.now();
    if (tab === 'dashboard') {
      if (now - _dashLoadTime > CACHE_TTL) loadDashboard();
    } else if (tab === 'batches') {
      if (_allBatchesData.length > 0) {
        // Derive filtered list from cache — instant
        _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
        _batchesLoaded = true;
        renderBatchList();
      } else {
        loadBatches();
      }
    } else if (tab === 'tasks') {
      if (!_upcomingLoaded || now - _upcomingLoadTime > CACHE_TTL) loadTasks();
    } else if (tab === 'measurements') {
      loadMeasurementBatches();
    }
  }

  // ===== Dashboard =====

  function eagerLoad() {
    // Show loading in dashboard (the first visible panel)
    var dashInner = document.getElementById('bp-dashboard-inner');
    if (dashInner) dashInner.innerHTML = '<div class="bp-skeleton-block"></div><div class="bp-skeleton-block" style="height:120px;margin-top:12px;"></div>';

    Promise.all([
      adminApiGet('get_batch_dashboard_summary'),
      adminApiGet('get_batches', { status: 'all' }),   // fetch ALL statuses at once
      adminApiGet('get_vessels'),
      adminApiGet('get_ferm_schedules'),
      adminApiGet('get_tasks_upcoming', { limit: 200 })
    ]).then(function (results) {
      _dashSummary    = results[0].data || null;
      _dashLoadTime   = Date.now();

      _allBatchesData = (results[1].data && results[1].data.batches) || [];
      _batchesLoaded  = true;
      _batchesLoadTime = Date.now();

      _vesselsData    = (results[2].data && results[2].data.vessels) || [];
      _vesselsCacheTime = Date.now();
      _vesselsMap     = {};
      _vesselsData.forEach(function (v) { _vesselsMap[String(v.vessel_id)] = v; });

      _fermSchedules  = (results[3].data && results[3].data.schedules) || [];
      _fermSchedulesCacheTime = Date.now();

      _upcomingTasks  = (results[4].data && results[4].data.tasks) || [];
      _upcomingLoaded = true;
      _upcomingLoadTime = Date.now();

      _eagerLoadDone  = true;
      _eagerLoadTime  = Date.now();

      renderDashboard();
      startDashAutoRefresh();
    }).catch(function (err) {
      // Graceful fallback: load dashboard + batches separately
      _eagerLoadDone = false;
      loadDashboard();
      startDashAutoRefresh();
    });
  }

  function startDashAutoRefresh() {
    if (_dashAutoRefreshTimer) clearInterval(_dashAutoRefreshTimer);
    _dashAutoRefreshTimer = setInterval(function () {
      if (document.hidden) return;
      if (_activeTab === 'dashboard') loadDashboard();
    }, 60000);
  }

  function loadDashboard() {
    _dashLoadTime = Date.now();
    // Fetch summary + upcoming tasks together for the workload chart
    Promise.all([
      adminApiGet('get_batch_dashboard_summary'),
      adminApiGet('get_tasks_upcoming', { limit: 100 })
    ]).then(function (results) {
      _dashSummary = results[0].data || null;
      _upcomingTasks = (results[1].data && results[1].data.tasks) || _upcomingTasks;
      if (results[1].data) { _upcomingLoaded = true; _upcomingLoadTime = Date.now(); }
      // Reset all-batches cache so the next visit to the Batches tab fetches fresh data
      _allBatchesData = [];
      _batchesLoadTime = 0;
      renderDashboard();
    }).catch(function (err) {
      // Degrade gracefully: try summary-only
      adminApiGet('get_batch_dashboard_summary').then(function (r) {
        _dashSummary = r.data || null;
        renderDashboard();
      }).catch(function (e) {
        var inner = document.getElementById('bp-dashboard-inner');
        if (inner) inner.innerHTML = '<p class="bp-empty">Failed to load dashboard: ' + escapeHTML(e.message) + '</p>';
      });
    });
  }

  function renderDashboard() {
    var inner = document.getElementById('bp-dashboard-inner');
    if (!inner) return;
    var d = _dashSummary || {};
    var html = '';

    // Pipeline strip
    html += '<div class="bp-pipeline-strip">';
    var stages = [
      { key: 'primary',   label: 'Primary',   icon: '&#127863;' },
      { key: 'secondary', label: 'Secondary', icon: '&#127870;' },
      { key: 'complete',  label: 'Complete',  icon: '&#10003;'  }
    ];
    stages.forEach(function (s) {
      var count = (d.status_counts && d.status_counts[s.key]) || 0;
      html += '<button type="button" class="bp-pipeline-tile" data-status="' + s.key + '">';
      html += '<span class="bp-pipeline-icon">' + s.icon + '</span>';
      html += '<span class="bp-pipeline-count">' + count + '</span>';
      html += '<span class="bp-pipeline-label">' + s.label + '</span>';
      html += '</button>';
    });
    html += '</div>';

    // Attention items
    var attention = d.attention_items || [];
    html += '<div class="bp-section-header">Needs Attention</div>';
    if (attention.length > 0) {
      html += '<div class="bp-attention-list">';
      attention.forEach(function (item) {
        var cls = item.type === 'overdue' ? 'bp-attention--danger'
          : (item.type === 'due_today' ? 'bp-attention--warning' : 'bp-attention--success');
        html += '<div class="bp-attention-item ' + cls + '">';
        html += '<span class="bp-attention-dot"></span>';
        html += '<span class="bp-attention-text">' + escapeHTML(item.message || item.batch_id || '') + '</span>';
        html += '</div>';
      });
      html += '</div>';
    } else if (_dashSummary) {
      html += '<p class="bp-empty">All batches on track.</p>';
    }

    // 7-day workload bar chart
    if (_upcomingTasks && _upcomingTasks.length > 0) {
      html += '<div class="bp-section-header">Next 7 Days</div>';
      var today7 = todayStr();
      var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var days = [];
      for (var di = 0; di < 7; di++) {
        var dt = new Date(); dt.setDate(dt.getDate() + di);
        var dStr = dt.toISOString().slice(0, 10);
        days.push({ date: dStr, label: di === 0 ? 'Today' : dayNames[dt.getDay()], count: 0 });
      }
      _upcomingTasks.forEach(function (t) {
        var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
        if (done) return;
        var due = t.due_date ? String(t.due_date).slice(0, 10) : '';
        for (var di2 = 0; di2 < days.length; di2++) {
          if (days[di2].date === due) { days[di2].count++; break; }
        }
      });
      var maxCount = 1;
      days.forEach(function (d) { if (d.count > maxCount) maxCount = d.count; });
      html += '<div class="bp-workload-chart">';
      days.forEach(function (d) {
        var pct = Math.round((d.count / maxCount) * 100);
        var barCls = d.date < today7 ? 'bp-wl-bar--overdue' : (d.date === today7 ? 'bp-wl-bar--today' : 'bp-wl-bar--future');
        html += '<div class="bp-wl-day" data-date="' + d.date + '">';
        html += '<div class="bp-wl-bar-wrap"><div class="bp-wl-bar ' + barCls + '" style="height:' + (d.count > 0 ? Math.max(pct, 12) : 0) + '%"></div></div>';
        html += '<div class="bp-wl-count">' + (d.count || '') + '</div>';
        html += '<div class="bp-wl-label">' + escapeHTML(d.label) + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    html += '<button type="button" class="bp-fab" id="bp-dash-new-batch">+ New Batch</button>';
    inner.innerHTML = html;

    // Workload day clicks → tasks tab
    Array.prototype.forEach.call(inner.querySelectorAll('.bp-wl-day[data-date]'), function (col) {
      col.addEventListener('click', function () { switchTab('tasks'); });
    });

    // Pipeline tile clicks → batches tab with status filter (reset search too)
    Array.prototype.forEach.call(inner.querySelectorAll('.bp-pipeline-tile'), function (tile) {
      tile.addEventListener('click', function () {
        _batchStatusFilter = tile.getAttribute('data-status');
        _batchSearch = '';
        _batchesLoaded = false;
        switchTab('batches');
      });
    });

    var fabBtn = document.getElementById('bp-dash-new-batch');
    if (fabBtn) {
      fabBtn.addEventListener('click', function () {
        switchTab('batches');
        setTimeout(openCreateSheet, 180);
      });
    }
  }

  // ===== Batches =====

  function filterBatchesByStatus(batches, filter) {
    if (!filter || filter === 'all') return batches.slice();
    if (filter === 'active') {
      return batches.filter(function (b) {
        var s = String(b.status || '').toLowerCase();
        return s === 'primary' || s === 'secondary';
      });
    }
    return batches.filter(function (b) {
      return String(b.status || '').toLowerCase() === filter;
    });
  }

  function loadBatches() {
    // If eager-loaded cache is fresh, derive filtered list client-side (instant)
    var now = Date.now();
    if (_allBatchesData.length > 0 && now - _batchesLoadTime < CACHE_TTL * 4) {
      _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
      _batchesLoaded = true;
      renderBatchList();
      return;
    }

    // Cache stale — re-fetch all
    if (_batchesLoading) return;
    _batchesLoading = true;
    _batchesLoadTime = Date.now();

    var listPane = document.getElementById('bp-batch-list-pane');
    if (listPane) listPane.innerHTML = '<div class="bp-panel-inner"><div class="bp-skeleton-block"></div></div>';

    adminApiGet('get_batches', { status: 'all' })
      .then(function (r) {
        _allBatchesData = (r.data && r.data.batches) || [];
        _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
        _batchesLoaded = true;
        _batchesLoading = false;
        renderBatchList();
      })
      .catch(function (err) {
        _batchesLoading = false;
        var lp = document.getElementById('bp-batch-list-pane');
        if (lp) lp.innerHTML = '<div class="bp-panel-inner"><p class="bp-empty">Failed to load batches: ' + escapeHTML(err.message) + '</p></div>';
      });
  }

  var STATUS_LABELS = { primary: 'Primary', secondary: 'Secondary', complete: 'Complete', active: 'Active', packaging: 'Packaging' };
  var STATUS_COLORS = { primary: 'info', secondary: 'warning', complete: 'success', active: 'info', packaging: 'warning' };

  function renderBatchList() {
    var pane = document.getElementById('bp-batch-list-pane');
    if (!pane) return;

    var search = _batchSearch.toLowerCase().trim();
    var filtered = _batchesData.filter(function (b) {
      if (!search) return true;
      var hay = (String(b.batch_id) + ' ' + String(b.product_name || '') + ' ' +
        String(b.customer_name || '') + ' ' + String(b.vessel_id || '')).toLowerCase();
      return hay.indexOf(search) !== -1;
    });

    var html = '<div class="bp-panel-inner">';

    // Filter bar
    html += '<div class="bp-batch-filters">';
    var filterOpts = [
      { val: 'active', label: 'Active' },
      { val: 'primary', label: 'Primary' },
      { val: 'secondary', label: 'Secondary' },
      { val: 'complete', label: 'Complete' }
    ];
    filterOpts.forEach(function (f) {
      var active = _batchStatusFilter === f.val ? ' bp-filter-btn--active' : '';
      html += '<button type="button" class="bp-filter-btn' + active + '" data-status="' + f.val + '">' + f.label + '</button>';
    });
    html += '</div>';

    // Search + new batch
    html += '<div class="bp-batch-search-row">';
    html += '<input type="search" class="bp-search-input" id="bp-batch-search" placeholder="Search batches\u2026" value="' + escapeHTML(_batchSearch) + '" autocomplete="off" inputmode="search">';
    html += '<button type="button" class="btn bp-new-batch-btn" id="bp-list-new-batch">+ New Batch</button>';
    html += '</div>';

    if (filtered.length === 0) {
      html += '<p class="bp-empty">No batches found.</p>';
    } else {
      html += '<div class="bp-batch-cards">';
      filtered.forEach(function (b) {
        var statusKey = String(b.status || '').toLowerCase();
        var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
        var statusColor = STATUS_COLORS[statusKey] || 'info';
        var tasksDone = parseInt(b.tasks_done) || 0;
        var tasksTotal = parseInt(b.tasks_total) || 0;
        var isSelected = b.batch_id === _selectedBatchId;

        html += '<div class="bp-batch-card' + (isSelected ? ' bp-batch-card--selected' : '') + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
        html += '<div class="bp-batch-card-header">';
        html += '<span class="bp-batch-id">' + escapeHTML(b.batch_id) + '</span>';
        html += '<span class="bp-status-badge bp-status-badge--' + statusColor + '">' + escapeHTML(statusLabel) + '</span>';
        html += '</div>';
        html += '<div class="bp-batch-card-name">' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</div>';
        if (b.customer_name) html += '<div class="bp-batch-card-customer">' + escapeHTML(b.customer_name) + '</div>';
        html += '<div class="bp-batch-card-footer">';
        if (tasksTotal > 0) html += '<span class="bp-task-progress">' + tasksDone + '/' + tasksTotal + ' tasks</span>';
        var loc = [b.shelf_id, b.bin_id, b.vessel_id].filter(Boolean).join(' \u00b7 ');
        if (loc) html += '<span class="bp-batch-loc">' + escapeHTML(loc) + '</span>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    pane.innerHTML = html;

    // Filter buttons — instant client-side filter from _allBatchesData
    Array.prototype.forEach.call(pane.querySelectorAll('.bp-filter-btn'), function (btn) {
      btn.addEventListener('click', function () {
        _batchStatusFilter = btn.getAttribute('data-status');
        _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
        renderBatchList();
      });
    });

    // Search input — use module-scope timer so switchTab() can cancel it
    var searchInput = document.getElementById('bp-batch-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(_batchSearchTimer);
        _batchSearchTimer = setTimeout(function () {
          _batchSearchTimer = null;
          _batchSearch = searchInput.value;
          renderBatchList();
        }, 200);
      });
    }

    // New batch button
    var newBatchBtn = document.getElementById('bp-list-new-batch');
    if (newBatchBtn) newBatchBtn.addEventListener('click', openCreateSheet);

    // Batch card taps
    Array.prototype.forEach.call(pane.querySelectorAll('.bp-batch-card'), function (card) {
      card.addEventListener('click', function () {
        selectBatch(card.getAttribute('data-batch-id'));
      });
    });
  }

  function selectBatch(batchId) {
    _selectedBatchId = batchId;

    // Update selected highlight in list
    Array.prototype.forEach.call(document.querySelectorAll('.bp-batch-card'), function (card) {
      card.classList.toggle('bp-batch-card--selected', card.getAttribute('data-batch-id') === batchId);
    });

    // Show detail pane with skeleton
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.style.display = '';
      detailPane.innerHTML = '<div class="bp-detail-content"><div class="bp-skeleton-block"></div>' +
        '<div class="bp-skeleton-block" style="margin-top:10px;height:140px;"></div></div>';
      // Portrait: trigger slide-in and inert the list so focus can't escape behind the overlay
      setTimeout(function () {
        detailPane.classList.add('bp-detail-slide-in');
        var isPortrait = window.innerWidth <= 900 || (window.matchMedia && window.matchMedia('(orientation: portrait)').matches);
        var listPane = document.getElementById('bp-batch-list-pane');
        if (listPane && isPortrait) listPane.setAttribute('inert', '');
      }, 10);
    }

    var vesselProm = (_vesselsData && Date.now() - _vesselsCacheTime < CACHE_TTL)
      ? Promise.resolve()
      : adminApiGet('get_vessels').then(function (r) {
          _vesselsData = (r.data && r.data.vessels) || [];
          _vesselsCacheTime = Date.now();
          _vesselsMap = {};
          _vesselsData.forEach(function (v) { _vesselsMap[String(v.vessel_id)] = v; });
        }).catch(function () { _vesselsData = []; _vesselsCacheTime = Date.now(); _vesselsMap = {}; });

    Promise.all([adminApiGet('get_batch', { batch_id: batchId }), vesselProm])
      .then(function (results) {
        renderBatchDetail(results[0].data || {});
      })
      .catch(function (err) {
        var dp = document.getElementById('bp-batch-detail-pane');
        if (dp) dp.innerHTML = '<div class="bp-detail-content"><p class="bp-empty">Failed: ' + escapeHTML(err.message) + '</p></div>';
      });
  }

  function renderBatchDetail(data) {
    var b = data.batch || {};
    var tasks = data.tasks || [];
    var readings = data.plato_readings || [];

    _detailPendingTasks = {};
    _detailPlatoStaging = [];
    _detailPlatoReadings = readings.slice();
    _detailStartDate = b.start_date || null;
    _detailBatchId = b.batch_id;

    var statusKey = String(b.status || '').toLowerCase();
    var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
    var statusColor = STATUS_COLORS[statusKey] || 'info';

    var currentVesselLabel = b.vessel_id || '';
    if (b.vessel_id) {
      var cv = _vesselsMap[String(b.vessel_id)] || null;
      if (cv) currentVesselLabel = buildVesselLabel(cv);
    }

    var html = '<div class="bp-detail-content">';

    // Header
    html += '<div class="bp-detail-header">';
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-detail-back" id="bp-detail-back">\u2190</button>';
    html += '<div class="bp-detail-title-group">';
    html += '<span class="bp-detail-batch-id">' + escapeHTML(b.batch_id) + '</span>';
    html += '<span class="bp-status-badge bp-status-badge--' + statusColor + ' bp-status-clickable" id="bp-detail-status">' + escapeHTML(statusLabel) + '</span>';
    html += '</div>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-qr-btn">QR</button>';
    html += '</div>';

    // Info grid
    html += '<div class="bp-detail-info">';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Product</span><span>' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Customer</span><span>' + escapeHTML(b.customer_name || '\u2014') + '</span></div>';
    html += '<div class="bp-detail-info-row"><span class="bp-detail-info-label">Start</span><span>' + fmtDate(b.start_date) + '</span></div>';
    html += '</div>';

    // Location
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Location</div>';
    html += '<div class="bp-location-edit">';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-edit-vessel-text" class="bp-inline-input" value="' + escapeHTML(currentVesselLabel) + '" placeholder="Search vessels\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-edit-vessel" value="' + escapeHTML(b.vessel_id || '') + '">';
    html += '</div>';
    html += '<input type="text" id="bp-edit-shelf" class="bp-inline-input bp-shelf-input" value="' + escapeHTML(b.shelf_id || '') + '" placeholder="A">';
    html += '<input type="text" id="bp-edit-bin" class="bp-inline-input bp-bin-input" value="' + escapeHTML(b.bin_id || '') + '" placeholder="01">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-save-location">Save</button>';
    html += '</div></div>';

    // Tasks
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Tasks</div>';
    html += '<div id="bp-detail-tasks">' + renderDetailTasks(tasks) + '</div>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-save-tasks-btn" style="display:none;margin-top:8px;">Save Tasks</button>';
    html += '</div>';

    // Readings
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Measurements</div>';
    html += '<div id="bp-detail-readings">' + renderDetailReadings(_detailPlatoReadings, _detailStartDate) + '</div>';
    html += '</div>';

    // Notes
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Notes</div>';
    html += '<textarea id="bp-detail-notes" class="bp-inline-input bp-notes-input" rows="3">' + escapeHTML(b.notes || '') + '</textarea>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-save-notes-btn" style="margin-top:6px;">Save Notes</button>';
    html += '</div>';

    // Footer actions
    html += '<div class="bp-detail-actions">';
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-danger-btn" id="bp-delete-batch-btn">Delete Batch</button>';
    html += '</div>';

    html += '</div>';

    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (!detailPane) return;
    detailPane.innerHTML = html;

    // Back button (portrait)
    var backBtn = document.getElementById('bp-detail-back');
    if (backBtn) backBtn.addEventListener('click', closeBatchDetail);

    // Vessel search
    var vesselTextInput = document.getElementById('bp-edit-vessel-text');
    var vesselDropdown = document.getElementById('bp-vessel-dropdown');
    var vesselHidden = document.getElementById('bp-edit-vessel');
    if (vesselTextInput && vesselDropdown && vesselHidden) {
      bindVesselSearch(vesselTextInput, vesselDropdown, vesselHidden, b.vessel_id || '');
    }

    // Shelf + Bin
    var shelfEl = document.getElementById('bp-edit-shelf');
    var binEl = document.getElementById('bp-edit-bin');
    if (shelfEl) bindShelfInput(shelfEl);
    if (binEl) bindBinInput(binEl);

    // Save location
    var saveLocBtn = document.getElementById('bp-save-location');
    if (saveLocBtn) {
      saveLocBtn.addEventListener('click', function () {
        var vessel = vesselHidden ? vesselHidden.value.trim() : '';
        var shelf = shelfEl ? shelfEl.value.trim() : '';
        var bin = binEl ? binEl.value.trim() : '';
        saveLocBtn.disabled = true;
        adminApiPost('update_batch', {
          batch_id: b.batch_id,
          updates: { vessel_id: vessel, shelf_id: shelf, bin_id: bin }
        })
          .then(function () {
            showToast('Location saved', 'success');
            b.vessel_id = vessel; b.shelf_id = shelf; b.bin_id = bin;
            saveLocBtn.disabled = false;
            _batchesLoaded = false;
            _allBatchesData = [];
            _eagerLoadTime = 0;
          })
          .catch(function (err) {
            showToast('Failed: ' + err.message, 'error');
            saveLocBtn.disabled = false;
          });
      });
    }

    // Status badge — keyboard accessible
    var statusBadge = document.getElementById('bp-detail-status');
    if (statusBadge) {
      statusBadge.setAttribute('role', 'button');
      statusBadge.setAttribute('tabindex', '0');
      statusBadge.setAttribute('aria-label', 'Batch status: ' + (STATUS_LABELS[statusKey] || b.status || '') + '. Click to change.');
      statusBadge.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); statusBadge.click(); }
      });
      statusBadge.addEventListener('click', function () {
        var order = ['primary', 'secondary', 'complete'];
        var cur = String(b.status || '').toLowerCase();
        var idx = order.indexOf(cur);
        var next = order[(idx + 1) % order.length];
        if (!confirm('Change status to "' + (STATUS_LABELS[next] || next) + '"?')) return;
        adminApiPost('update_batch', { batch_id: b.batch_id, updates: { status: next } })
          .then(function () {
            b.status = next;
            statusBadge.textContent = STATUS_LABELS[next] || next;
            statusBadge.className = 'bp-status-badge bp-status-badge--' + (STATUS_COLORS[next] || 'info') + ' bp-status-clickable';
            statusBadge.setAttribute('aria-label', 'Batch status: ' + (STATUS_LABELS[next] || next) + '. Click to change.');
            showToast('Status updated', 'success');
            // Update the cached batch and refresh list immediately
            for (var bi = 0; bi < _batchesData.length; bi++) {
              if (_batchesData[bi].batch_id === b.batch_id) { _batchesData[bi].status = next; break; }
            }
            for (var bi2 = 0; bi2 < _allBatchesData.length; bi2++) {
              if (_allBatchesData[bi2].batch_id === b.batch_id) { _allBatchesData[bi2].status = next; break; }
            }
            _batchesLoaded = false;
            _dashLoadTime = 0;
            renderBatchList();
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    }

    // Task checkboxes
    bindDetailTaskCheckboxes(b.batch_id);

    // Save tasks
    var saveTasksBtn = document.getElementById('bp-save-tasks-btn');
    if (saveTasksBtn) {
      saveTasksBtn.addEventListener('click', function () {
        var tasksArr = Object.keys(_detailPendingTasks).map(function (id) {
          return { task_id: id, updates: { completed: _detailPendingTasks[id] } };
        });
        saveTasksBtn.disabled = true;
        saveTasksBtn.textContent = 'Saving\u2026';
        if (navigator.vibrate) navigator.vibrate(30);
        var saveTimeout = setTimeout(function () {
          saveTasksBtn.disabled = false;
          saveTasksBtn.textContent = 'Save Tasks (' + Object.keys(_detailPendingTasks).length + ')';
          showToast('Request timed out — check connection', 'error');
        }, 60000);
        adminApiPost('bulk_update_batch_tasks', { tasks: tasksArr })
          .then(function () {
            clearTimeout(saveTimeout);
            showToast(tasksArr.length + ' task' + (tasksArr.length !== 1 ? 's' : '') + ' updated', 'success');
            if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
            _detailPendingTasks = {};
            updateDetailTaskSaveBtn();
            saveTasksBtn.disabled = false;
            _upcomingLoaded = false;
            selectBatch(b.batch_id);
          })
          .catch(function (err) {
            clearTimeout(saveTimeout);
            showToast('Failed: ' + err.message, 'error');
            saveTasksBtn.disabled = false;
            updateDetailTaskSaveBtn();
          });
      });
    }

    // Readings handlers
    bindDetailReadingHandlers(b.batch_id);

    // Save notes
    var saveNotesBtn = document.getElementById('bp-save-notes-btn');
    if (saveNotesBtn) {
      saveNotesBtn.addEventListener('click', function () {
        var notes = (document.getElementById('bp-detail-notes') || {}).value || '';
        saveNotesBtn.disabled = true;
        adminApiPost('update_batch', { batch_id: b.batch_id, updates: { notes: notes } })
          .then(function () {
            showToast('Notes saved', 'success');
            b.notes = notes;
            saveNotesBtn.disabled = false;
          })
          .catch(function (err) {
            showToast('Failed: ' + err.message, 'error');
            saveNotesBtn.disabled = false;
          });
      });
    }

    // QR
    var qrBtn = document.getElementById('bp-detail-qr-btn');
    if (qrBtn) {
      qrBtn.addEventListener('click', function () {
        var token = b.access_token || '';
        if (!token) {
          adminApiGet('get_batch', { batch_id: b.batch_id }).then(function (r) {
            var bt = (r.data && r.data.batch && r.data.batch.access_token) || '';
            if (!bt) { showToast('No access token for this batch', 'warn'); return; }
            openBatchQR(b.batch_id, bt);
          }).catch(function () { showToast('Failed to load batch token', 'error'); });
          return;
        }
        openBatchQR(b.batch_id, token);
      });
    }

    // Delete
    var deleteBtn = document.getElementById('bp-delete-batch-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (!confirm('Delete batch ' + b.batch_id + '? This cannot be undone.')) return;
        adminApiPost('delete_batch', { batch_id: b.batch_id })
          .then(function () {
            showToast('Batch deleted', 'success');
            closeBatchDetail();
            _batchesLoaded = false;
            _allBatchesData = [];
            _eagerLoadTime = 0;
            _dashLoadTime = 0;
            loadBatches();
          })
          .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
      });
    }
  }

  function openBatchQR(batchId, token) {
    if (typeof qrcode === 'undefined') { showToast('QR library not loaded', 'error'); return; }
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(token);
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    var win = window.open('', '_blank');
    if (win) {
      win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        escapeHTML(batchId) + '</title></head><body style="text-align:center;padding:2rem;font-family:sans-serif;">' +
        qr.createImgTag(5) + '<br><code style="font-size:1.1rem;">' + escapeHTML(batchId) + '</code></body></html>');
      win.document.close();
    }
  }

  function renderDetailTasks(tasks) {
    if (!tasks || tasks.length === 0) return '<p class="bp-empty">No tasks for this batch.</p>';
    var html = '<div class="bp-task-list">';
    tasks.forEach(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      var overdue = !done && isOverdue(t.due_date);
      var today = !done && isToday(t.due_date);
      var rowCls = 'bp-task-row' +
        (done ? ' bp-task-row--done' : '') +
        (overdue ? ' bp-task-row--overdue' : '') +
        (today ? ' bp-task-row--today' : '');
      html += '<div class="' + rowCls + '">';
      html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"' + (done ? ' checked' : '') + '></label>';
      html += '<div class="bp-task-body">';
      html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
      if (t.due_date) html += '<span class="bp-task-due">' + fmtDate(t.due_date) + '</span>';
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function bindDetailTaskCheckboxes(batchId) {
    Array.prototype.forEach.call(
      document.querySelectorAll('#bp-detail-tasks .bp-task-check input[type="checkbox"]'),
      function (cb) {
        var origChecked = cb.checked;
        cb.addEventListener('change', function () {
          var taskId = cb.getAttribute('data-task-id');
          if (cb.checked === origChecked) {
            delete _detailPendingTasks[taskId];
          } else {
            _detailPendingTasks[taskId] = cb.checked;
          }
          if (navigator.vibrate) navigator.vibrate(cb.checked ? [40, 20, 60] : 20);
          var row = cb.closest('.bp-task-row');
          if (row) row.classList.toggle('bp-task-row--done', cb.checked);
          updateDetailTaskSaveBtn();
        });
      }
    );
  }

  function updateDetailTaskSaveBtn() {
    var btn = document.getElementById('bp-save-tasks-btn');
    var count = Object.keys(_detailPendingTasks).length;
    if (btn) {
      btn.style.display = count > 0 ? '' : 'none';
      btn.textContent = 'Save Tasks (' + count + ')';
    }
  }

  function renderDetailReadings(readings, startDate) {
    var html = renderDataGapWarning(readings);
    if (readings && readings.length >= 2) {
      html += renderPlatoChart(readings, startDate);
    }
    if (readings && readings.length > 0) {
      html += '<table class="bp-readings-table" aria-label="Plato readings"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th></tr></thead><tbody>';
      readings.slice().reverse().slice(0, 10).forEach(function (r) {
        html += '<tr>';
        html += '<td>' + fmtDate(r.timestamp) + '</td>';
        html += '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>';
        html += '<td>' + escapeHTML(r.temperature != null ? r.temperature : '') + '</td>';
        html += '<td>' + escapeHTML(r.ph != null ? r.ph : '') + '</td>';
        html += '<td>' + escapeHTML(r.notes || '') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="bp-empty">No readings yet.</p>';
    }
    html += '<div class="bp-reading-add-row">';
    html += '<input type="date" id="bp-detail-plato-date" class="bp-inline-input" style="width:120px;">';
    html += '<input type="number" id="bp-detail-plato-val" step="0.1" max="40" placeholder="&deg;P" class="bp-inline-input" style="width:64px;">';
    html += '<input type="number" id="bp-detail-plato-temp" step="0.1" placeholder="Temp" class="bp-inline-input" style="width:64px;">';
    html += '<input type="number" id="bp-detail-plato-ph" step="0.01" min="0" max="14" placeholder="pH" class="bp-inline-input" style="width:60px;">';
    html += '<input type="text" id="bp-detail-plato-notes" placeholder="Notes" class="bp-inline-input" style="flex:1;">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-add-reading">+ Add</button>';
    html += '</div>';
    html += '<div id="bp-detail-staging-wrap">' + renderDetailStagingTable() + '</div>';
    return html;
  }

  function renderDetailStagingTable() {
    if (_detailPlatoStaging.length === 0) return '';
    var html = '<table class="bp-readings-table bp-staging-table"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th><th></th></tr></thead><tbody>';
    _detailPlatoStaging.forEach(function (r, i) {
      html += '<tr>';
      html += '<td>' + escapeHTML(r.timestamp) + '</td>';
      html += '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>';
      html += '<td>' + escapeHTML(r.temperature != null ? r.temperature : '') + '</td>';
      html += '<td>' + escapeHTML(r.ph != null ? r.ph : '') + '</td>';
      html += '<td>' + escapeHTML(r.notes || '') + '</td>';
      html += '<td><button type="button" class="bp-staging-remove" data-idx="' + i + '">&times;</button></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-submit-readings">Submit All (' + _detailPlatoStaging.length + ')</button>';
    return html;
  }

  function bindDetailReadingHandlers(batchId) {
    var dateInput = document.getElementById('bp-detail-plato-date');
    if (dateInput) dateInput.value = todayStr();

    var addBtn = document.getElementById('bp-detail-add-reading');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var dateVal = (document.getElementById('bp-detail-plato-date') || {}).value || '';
        var gravRaw = (document.getElementById('bp-detail-plato-val') || {}).value || '';
        var tempRaw = (document.getElementById('bp-detail-plato-temp') || {}).value || '';
        var phRaw   = (document.getElementById('bp-detail-plato-ph') || {}).value || '';
        var notesVal = (document.getElementById('bp-detail-plato-notes') || {}).value || '';
        if (!dateVal) { showToast('Enter a date', 'error'); return; }
        if (gravRaw === '' && tempRaw === '' && phRaw === '') { showToast('Enter at least one measurement', 'error'); return; }
        var row = { timestamp: dateVal };
        if (gravRaw !== '') row.degrees_plato = parseFloat(gravRaw);
        if (tempRaw !== '') row.temperature   = parseFloat(tempRaw);
        if (phRaw   !== '') row.ph            = parseFloat(phRaw);
        if (notesVal) row.notes = notesVal;
        _detailPlatoStaging.push(row);
        var stagingWrap = document.getElementById('bp-detail-staging-wrap');
        if (stagingWrap) stagingWrap.innerHTML = renderDetailStagingTable();
        bindDetailStagingHandlers(batchId);
        ['bp-detail-plato-val', 'bp-detail-plato-temp', 'bp-detail-plato-ph', 'bp-detail-plato-notes'].forEach(function (id) {
          var el = document.getElementById(id); if (el) el.value = '';
        });
      });
    }
    bindDetailStagingHandlers(batchId);
  }

  function bindDetailStagingHandlers(batchId) {
    Array.prototype.forEach.call(document.querySelectorAll('#bp-detail-staging-wrap .bp-staging-remove'), function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        _detailPlatoStaging.splice(idx, 1);
        var wrap = document.getElementById('bp-detail-staging-wrap');
        if (wrap) wrap.innerHTML = renderDetailStagingTable();
        bindDetailStagingHandlers(batchId);
      });
    });

    var submitBtn = document.getElementById('bp-detail-submit-readings');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        if (!_detailPlatoStaging.length) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting\u2026';
        var rows = _detailPlatoStaging.slice();
        var stagingBackup = _detailPlatoStaging.slice();
        var readingTimeout = setTimeout(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit All (' + _detailPlatoStaging.length + ')';
          showToast('Request timed out — readings preserved', 'error');
        }, 60000);
        adminApiPost('bulk_add_plato_readings', { batch_id: batchId, readings: rows })
          .then(function (result) {
            clearTimeout(readingTimeout);
            showToast(rows.length + ' reading' + (rows.length !== 1 ? 's' : '') + ' recorded', 'success');
            var results = (result && result.results) || [];
            rows.forEach(function (r, i) {
              r.reading_id = (results[i] && results[i].reading_id) || ('confirmed-' + Date.now() + i);
              _detailPlatoReadings.push(r);
            });
            _detailPlatoStaging = [];
            var readingsEl = document.getElementById('bp-detail-readings');
            if (readingsEl) {
              readingsEl.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
              bindDetailReadingHandlers(batchId);
            }
          })
          .catch(function (err) {
            clearTimeout(readingTimeout);
            showToast('Failed: ' + err.message + ' — readings preserved', 'error');
            _detailPlatoStaging = stagingBackup; // Restore staging on network failure
            submitBtn.disabled = false;
            var wrap = document.getElementById('bp-detail-staging-wrap');
            if (wrap) wrap.innerHTML = renderDetailStagingTable();
            bindDetailStagingHandlers(batchId);
          });
      });
    }
  }

  function closeBatchDetail() {
    _selectedBatchId = null;
    // Restore list pane interactivity (was inert when detail overlaid it in portrait)
    var listPane = document.getElementById('bp-batch-list-pane');
    if (listPane) listPane.removeAttribute('inert');
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.classList.remove('bp-detail-slide-in');
      setTimeout(function () {
        detailPane.style.display = 'none';
      }, 240);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.bp-batch-card'), function (c) {
      c.classList.remove('bp-batch-card--selected');
    });
  }

  // ===== Vessel Search (adapted from admin.js) =====

  function buildVesselLabel(v) {
    var vid = String(v.vessel_id || '');
    var parts = [vid];
    if (v.type) parts.push(v.type);
    if (v.capacity_liters) parts.push(v.capacity_liters + 'L');
    if (v.material) parts.push(v.material);
    return parts.join(' \u2014 ');
  }

  function bindVesselSearch(input, dropdownEl, hiddenEl, currentVesselId) {
    function showOptions(term) {
      if (!_vesselsData) { dropdownEl.style.display = 'none'; return; }
      var matches = _vesselsData.filter(function (v) {
        var vid = String(v.vessel_id || '');
        var status = String(v.status || '').toLowerCase();
        var available = !status || status === 'available' || status === 'empty';
        if (!available && vid !== currentVesselId) return false;
        if (!term) return true;
        var s = (vid + ' ' + (v.type || '') + ' ' + (v.capacity_liters || '') + ' ' + (v.location || '')).toLowerCase();
        return s.indexOf(term.toLowerCase()) !== -1;
      });
      if (matches.length === 0) {
        dropdownEl.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No available vessels</div>';
      } else {
        dropdownEl.innerHTML = matches.map(function (v) {
          return '<div class="bp-vessel-option" data-vid="' + escapeHTML(String(v.vessel_id)) + '">' + escapeHTML(buildVesselLabel(v)) + '</div>';
        }).join('');
      }
      dropdownEl.style.display = '';
      Array.prototype.forEach.call(dropdownEl.querySelectorAll('.bp-vessel-option[data-vid]'), function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          var vid = opt.getAttribute('data-vid');
          hiddenEl.value = vid;
          var v = null;
          for (var i = 0; i < _vesselsData.length; i++) {
            if (String(_vesselsData[i].vessel_id) === vid) { v = _vesselsData[i]; break; }
          }
          input.value = v ? buildVesselLabel(v) : vid;
          dropdownEl.style.display = 'none';
        });
      });
    }

    input.addEventListener('focus', function () { if (!input.value.trim()) showOptions(''); });
    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { showOptions(input.value.trim()); }, 150);
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { dropdownEl.style.display = 'none'; }, 200);
    });
  }

  function bindShelfInput(el) {
    el.setAttribute('maxlength', '1');
    el.addEventListener('input', function () { el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase(); });
    el.addEventListener('blur',  function () { el.value = el.value.replace(/[^a-zA-Z]/g, '').toUpperCase(); });
  }

  function bindBinInput(el) {
    el.setAttribute('maxlength', '2');
    el.addEventListener('input', function () { el.value = el.value.replace(/[^0-9]/g, ''); });
    el.addEventListener('blur', function () {
      var n = parseInt(el.value, 10);
      if (isNaN(n) || n < 1) { el.value = ''; return; }
      if (n > 36) n = 36;
      el.value = n < 10 ? '0' + n : String(n);
    });
  }

  // ===== Plato Chart (enhanced) =====

  function renderDataGapWarning(readings) {
    if (!readings || readings.length === 0) return '';
    var last = readings[readings.length - 1];
    if (!last || !last.timestamp) return '';
    var lastDate = new Date(last.timestamp);
    var today = new Date();
    var daysSince = Math.floor((today - lastDate) / 86400000);
    if (daysSince < 3) return '';
    var cls = daysSince >= 7 ? 'bp-chart-warning--danger' : 'bp-chart-warning--warn';
    return '<div class="bp-chart-warning ' + cls + '">' +
      '\u26a0\ufe0f Last reading ' + daysSince + ' day' + (daysSince !== 1 ? 's' : '') + ' ago</div>';
  }

  function renderPlatoChart(readings, startDate) {
    if (!readings || readings.length < 2) return '';
    var W = 480; var H = 160; var PAD = 34;
    var start = startDate ? new Date(startDate) : new Date(readings[0].timestamp);

    var points = readings.map(function (r) {
      var d = new Date(r.timestamp);
      return {
        day: Math.round((d - start) / 86400000),
        plato: r.degrees_plato != null ? Number(r.degrees_plato) : NaN,
        temp: r.temperature != null ? Number(r.temperature) : NaN
      };
    }).filter(function (p) { return !isNaN(p.plato); });
    if (points.length < 2) return '';

    var maxDay = Math.max.apply(null, points.map(function (p) { return p.day; })) || 1;
    var maxP = Math.max.apply(null, points.map(function (p) { return p.plato; }));
    var minP = Math.min.apply(null, points.map(function (p) { return p.plato; }));
    if (maxP === minP) { maxP += 2; minP = Math.max(0, minP - 1); }
    var pRange = maxP - minP;

    function toX(day) { return PAD + (day / maxDay) * (W - PAD * 2); }
    function toY(plato) { return H - PAD - ((plato - minP) / pRange) * (H - PAD * 2); }

    // Fermentation rate (slope over last 2 readings)
    var rateStr = '';
    var lastTwo = points.slice(-2);
    if (lastTwo.length === 2 && lastTwo[1].day > lastTwo[0].day) {
      var rate = (lastTwo[0].plato - lastTwo[1].plato) / (lastTwo[1].day - lastTwo[0].day);
      rateStr = rate.toFixed(2) + '\u00b0P/day';
    }

    // Stuck fermentation: < 0.2°P change in last 5 days, batch is >5 days old
    var stuckWarning = '';
    if (maxDay > 5 && points.length >= 2) {
      var recent = points.filter(function (p) { return p.day >= maxDay - 5; });
      if (recent.length >= 2) {
        var gravChange = Math.abs(recent[0].plato - recent[recent.length - 1].plato);
        if (gravChange < 0.2) stuckWarning = 'Fermentation may be stalled (<0.2\u00b0P in 5 days)';
      }
    }

    // Build polyline for gravity
    var polyPoints = points.map(function (p) { return toX(p.day) + ',' + toY(p.plato); }).join(' ');
    var dots = points.map(function (p) {
      return '<circle cx="' + toX(p.day) + '" cy="' + toY(p.plato) + '" r="3.5" fill="#4a6f4b" stroke="#fff" stroke-width="1"/>';
    }).join('');

    // Temperature overlay
    var tempPts = points.filter(function (p) { return !isNaN(p.temp); });
    var tempPolyline = '';
    var tempLegend = '';
    if (tempPts.length >= 2) {
      var maxT = Math.max.apply(null, tempPts.map(function (p) { return p.temp; }));
      var minT = Math.min.apply(null, tempPts.map(function (p) { return p.temp; }));
      if (maxT === minT) { maxT += 2; minT -= 2; }
      var tRange = maxT - minT;
      function toYT(t) { return H - PAD - ((t - minT) / tRange) * (H - PAD * 2); }
      var tPoly = tempPts.map(function (p) { return toX(p.day) + ',' + toYT(p.temp); }).join(' ');
      tempPolyline = '<polyline points="' + tPoly + '" fill="none" stroke="#d67a3a" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.75"/>';
      // Temp axis labels on right
      var rightEdge = W - PAD + 4;
      tempPolyline += '<text x="' + rightEdge + '" y="' + (PAD + 4) + '" font-size="8" fill="#d67a3a">' + maxT.toFixed(0) + '\u00b0</text>';
      tempPolyline += '<text x="' + rightEdge + '" y="' + (H - PAD) + '" font-size="8" fill="#d67a3a">' + minT.toFixed(0) + '\u00b0</text>';
      tempLegend = '<line x1="' + (W - PAD - 44) + '" y1="' + (PAD - 10) + '" x2="' + (W - PAD - 30) + '" y2="' + (PAD - 10) + '" stroke="#d67a3a" stroke-width="1.5" stroke-dasharray="4 3"/>' +
        '<text x="' + (W - PAD - 27) + '" y="' + (PAD - 6) + '" font-size="8" fill="#d67a3a">Temp</text>';
    }

    // Mid grid line for reference
    var midP = minP + pRange / 2;
    var midY = toY(midP);

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="bp-plato-chart" role="img" aria-label="Fermentation gravity curve">';
    // Background grid
    svg += '<line x1="' + PAD + '" y1="' + midY + '" x2="' + (W - PAD) + '" y2="' + midY + '" stroke="#e8e2ca" stroke-width="1" stroke-dasharray="4 3"/>';
    svg += '<text x="2" y="' + (midY + 3) + '" font-size="8" fill="#c4b49a">' + midP.toFixed(1) + '</text>';
    // Axes
    svg += '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="#c4b49a" stroke-width="1"/>';
    svg += '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + PAD + '" y2="' + (H - PAD) + '" stroke="#c4b49a" stroke-width="1"/>';
    // Axis labels
    svg += '<text x="' + PAD + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672">Day 0</text>';
    svg += '<text x="' + (W - PAD) + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672" text-anchor="end">Day ' + maxDay + '</text>';
    svg += '<text x="2" y="' + (PAD + 4) + '" font-size="8" fill="#9a8672">' + maxP.toFixed(1) + '</text>';
    svg += '<text x="2" y="' + (H - PAD) + '" font-size="8" fill="#9a8672">' + minP.toFixed(1) + '</text>';
    svg += '<text x="' + (W / 2) + '" y="' + (H - 4) + '" font-size="8" fill="#9a8672" text-anchor="middle">\u00b0Plato</text>';
    // Gravity legend
    svg += '<line x1="' + (PAD + 4) + '" y1="' + (PAD - 10) + '" x2="' + (PAD + 18) + '" y2="' + (PAD - 10) + '" stroke="#4a6f4b" stroke-width="2"/>';
    svg += '<text x="' + (PAD + 21) + '" y="' + (PAD - 6) + '" font-size="8" fill="#4a6f4b">Gravity</text>';
    if (tempLegend) svg += tempLegend;
    // Lines + overlays
    if (tempPolyline) svg += tempPolyline;
    svg += '<polyline points="' + polyPoints + '" fill="none" stroke="#4a6f4b" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>';
    svg += dots;
    svg += '</svg>';

    var html = '<div class="bp-chart-wrap">';
    if (stuckWarning) html += '<div class="bp-chart-warning bp-chart-warning--danger">\u26a0\ufe0f ' + stuckWarning + '</div>';
    if (rateStr) html += '<div class="bp-chart-meta">Rate: <strong>' + rateStr + '</strong></div>';
    html += svg + '</div>';
    return html;
  }

  // ===== Create Batch Bottom Sheet =====

  function openCreateSheet() {
    var sheet = document.getElementById('bp-create-sheet');
    var inner = document.getElementById('bp-create-sheet-inner');
    if (!sheet || !inner) return;
    sheet.style.display = '';
    setTimeout(function () { sheet.classList.add('bp-create-sheet--open'); }, 10);
    buildCreateForm(inner);
    // Focus first input after slide-in animation completes
    setTimeout(function () {
      var firstInput = inner.querySelector('input[type="text"], input[type="search"]');
      if (firstInput) firstInput.focus();
    }, 260);
  }

  function closeCreateSheet() {
    var sheet = document.getElementById('bp-create-sheet');
    if (!sheet) return;
    sheet.classList.remove('bp-create-sheet--open');
    setTimeout(function () { sheet.style.display = 'none'; }, 240);
  }

  function buildCreateForm(container) {
    var today = todayStr();

    var schedOptions = '<option value="">\u2014 None \u2014</option>';
    _fermSchedules.forEach(function (s) {
      schedOptions += '<option value="' + escapeHTML(s.schedule_id) + '">' +
        escapeHTML(s.name || s.schedule_id) + '</option>';
    });

    var html = '<div class="bp-create-form">';
    html += '<div class="bp-create-form-header">';
    html += '<span class="bp-create-form-title">New Batch</span>';
    html += '<button type="button" class="bp-create-close" id="bp-create-close">&times;</button>';
    html += '</div>';

    // Product
    html += '<div class="bp-form-group"><label>Product</label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-product-text" class="bp-inline-input" placeholder="Search kits\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-new-product-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-product-sku">';
    html += '<input type="hidden" id="bp-new-product-name">';
    html += '</div></div>';

    // Customer
    html += '<div class="bp-form-group"><label>Customer <span class="bp-optional">(optional)</span></label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-customer-text" class="bp-inline-input" placeholder="Search customers\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-new-customer-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-customer-id">';
    html += '<input type="hidden" id="bp-new-customer-name-hidden">';
    html += '<input type="hidden" id="bp-new-customer-email">';
    html += '</div>';
    html += '<div id="bp-new-customer-section" style="display:none;" class="bp-new-customer-wrap">';
    html += '<div class="bp-form-subgroup">';
    html += '<input type="text"  id="bp-nc-name"  class="bp-inline-input" placeholder="Full name *" autocomplete="name">';
    html += '<input type="email" id="bp-nc-email" class="bp-inline-input" placeholder="Email *" autocomplete="email" inputmode="email">';
    html += '<input type="tel"   id="bp-nc-phone" class="bp-inline-input" placeholder="Phone (optional)" autocomplete="tel" inputmode="tel">';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-nc-save">Add Customer</button>';
    html += '</div></div></div>';

    // Start date
    html += '<div class="bp-form-group"><label>Start Date</label>';
    html += '<input type="date" id="bp-new-start-date" class="bp-inline-input" value="' + today + '"></div>';

    // Schedule
    html += '<div class="bp-form-group"><label>Schedule Template <span class="bp-optional">(optional)</span></label>';
    html += '<select id="bp-new-schedule" class="bp-inline-input">' + schedOptions + '</select></div>';

    // Vessel
    html += '<div class="bp-form-group"><label>Vessel <span class="bp-optional">(optional)</span></label>';
    html += '<div class="bp-vessel-wrap">';
    html += '<input type="text" id="bp-new-vessel-text" class="bp-inline-input" placeholder="Search vessels\u2026" autocomplete="off">';
    html += '<div class="bp-vessel-dropdown" id="bp-new-vessel-dropdown" style="display:none;"></div>';
    html += '<input type="hidden" id="bp-new-vessel">';
    html += '</div></div>';

    // Shelf + Bin
    html += '<div class="bp-form-group bp-form-row">';
    html += '<div><label>Shelf <span class="bp-optional">(optional)</span></label><input type="text" id="bp-new-shelf" class="bp-inline-input bp-shelf-input" placeholder="A"></div>';
    html += '<div><label>Bin <span class="bp-optional">(optional)</span></label><input type="text" id="bp-new-bin" class="bp-inline-input bp-bin-input" placeholder="01"></div>';
    html += '</div>';

    // Notes
    html += '<div class="bp-form-group"><label>Notes <span class="bp-optional">(optional)</span></label>';
    html += '<textarea id="bp-new-notes" class="bp-inline-input" rows="2"></textarea></div>';

    html += '<div class="bp-form-actions">';
    html += '<button type="button" class="btn-secondary" id="bp-create-cancel">Cancel</button>';
    html += '<button type="button" class="btn" id="bp-create-submit">Create Batch</button>';
    html += '</div></div>';

    container.innerHTML = html;

    document.getElementById('bp-create-close').addEventListener('click', closeCreateSheet);
    document.getElementById('bp-create-cancel').addEventListener('click', closeCreateSheet);

    bindProductSearch();
    bindCustomerSearch();

    var vInput = document.getElementById('bp-new-vessel-text');
    var vDropdown = document.getElementById('bp-new-vessel-dropdown');
    var vHidden = document.getElementById('bp-new-vessel');
    if (vInput && vDropdown && vHidden) bindVesselSearch(vInput, vDropdown, vHidden, '');

    var shelfEl = document.getElementById('bp-new-shelf');
    var binEl = document.getElementById('bp-new-bin');
    if (shelfEl) bindShelfInput(shelfEl);
    if (binEl) bindBinInput(binEl);

    var submitBtn = document.getElementById('bp-create-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        var productName = (document.getElementById('bp-new-product-name') || {}).value || '';
        if (!productName) {
          var textEl = document.getElementById('bp-new-product-text');
          if (textEl && textEl.value.trim()) productName = textEl.value.trim();
        }
        if (!productName) { showToast('Product is required', 'error'); return; }

        var productSku  = (document.getElementById('bp-new-product-sku') || {}).value || '';
        var startDate   = (document.getElementById('bp-new-start-date') || {}).value || today;
        var scheduleId  = (document.getElementById('bp-new-schedule') || {}).value || '';
        var vesselId    = (document.getElementById('bp-new-vessel') || {}).value || '';
        var shelf       = (document.getElementById('bp-new-shelf') || {}).value || '';
        var bin         = (document.getElementById('bp-new-bin') || {}).value || '';
        var notes       = (document.getElementById('bp-new-notes') || {}).value || '';
        var customerName = (document.getElementById('bp-new-customer-name-hidden') || {}).value || '';
        if (!customerName) {
          var custText = document.getElementById('bp-new-customer-text');
          if (custText && custText.value.trim()) customerName = custText.value.trim();
        }
        var customerEmail = (document.getElementById('bp-new-customer-email') || {}).value || '';

        submitBtn.disabled = true;
        adminApiPost('create_batch', {
          product_name: productName,
          product_sku: productSku,
          customer_name: customerName || 'Walk-In',
          customer_email: customerEmail,
          start_date: startDate,
          vessel_id: vesselId,
          shelf_id: shelf,
          bin_id: bin,
          schedule_id: scheduleId,
          notes: notes
        })
          .then(function (result) {
            showToast('Batch ' + (result.batch_id || '') + ' created', 'success');
            closeCreateSheet();
            _batchesLoaded = false;
            _allBatchesData = [];
            _eagerLoadTime = 0;
            _upcomingLoaded = false;
            _measBatches = [];
            _dashLoadTime = 0;
            loadBatches();
          })
          .catch(function (err) {
            showToast('Failed: ' + err.message, 'error');
            submitBtn.disabled = false;
          });
      });
    }
  }

  function bindProductSearch() {
    var input    = document.getElementById('bp-new-product-text');
    var dropdown = document.getElementById('bp-new-product-dropdown');
    var skuHidden  = document.getElementById('bp-new-product-sku');
    var nameHidden = document.getElementById('bp-new-product-name');
    if (!input || !dropdown || !skuHidden || !nameHidden) return;

    function showProductOptions(term) {
      if (!_kitCatalog) {
        dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">Loading catalog\u2026</div>';
        dropdown.style.display = '';
        loadKitCatalog(function () { showProductOptions(term); });
        return;
      }
      var matches = _kitCatalog.filter(function (p) {
        if (!term) return true;
        return ((p.name || '') + ' ' + (p.sku || '')).toLowerCase().indexOf(term.toLowerCase()) !== -1;
      }).slice(0, 15);
      if (matches.length === 0) {
        dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No kits found \u2014 type to use free text</div>';
      } else {
        dropdown.innerHTML = matches.map(function (p) {
          return '<div class="bp-vessel-option" data-sku="' + escapeHTML(p.sku || p.item_id || '') +
            '" data-name="' + escapeHTML(p.name || '') + '">' + escapeHTML(p.name || p.sku) + '</div>';
        }).join('');
      }
      dropdown.style.display = '';
      Array.prototype.forEach.call(dropdown.querySelectorAll('.bp-vessel-option[data-sku]'), function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          skuHidden.value  = opt.getAttribute('data-sku');
          nameHidden.value = opt.getAttribute('data-name');
          input.value = opt.getAttribute('data-name');
          dropdown.style.display = 'none';
        });
      });
    }

    input.addEventListener('focus', function () { showProductOptions(input.value); });
    var timer;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      skuHidden.value = ''; nameHidden.value = '';
      timer = setTimeout(function () { showProductOptions(input.value); }, 200);
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { dropdown.style.display = 'none'; }, 200);
    });
  }

  function loadKitCatalog(cb) {
    var now = Date.now();
    if (_kitCatalog && now - _kitCatalogLoadTime < KIT_CACHE_TTL) { if (cb) cb(); return; }
    fetch(mwUrl() + '/api/kiosk/products')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _kitCatalog = (data.items || []).filter(function (p) {
          return (p.product_type || '').toLowerCase() === 'kit';
        });
        _kitCatalogLoadTime = Date.now();
        if (cb) cb();
      })
      .catch(function () {
        _kitCatalog = []; // graceful degradation — free text still works
        if (cb) cb();
      });
  }

  function bindCustomerSearch() {
    var input    = document.getElementById('bp-new-customer-text');
    var dropdown = document.getElementById('bp-new-customer-dropdown');
    var custId    = document.getElementById('bp-new-customer-id');
    var custName  = document.getElementById('bp-new-customer-name-hidden');
    var custEmail = document.getElementById('bp-new-customer-email');
    var ncSection = document.getElementById('bp-new-customer-section');
    if (!input || !dropdown) return;

    var base = mwUrl();
    var timer;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (ncSection) ncSection.style.display = q.length >= 2 ? '' : 'none';
      if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }
      timer = setTimeout(function () {
        fetch(base + '/api/contacts?search=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var contacts = (data.contacts || []).slice(0, 10);
            if (!contacts.length) {
              dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No results \u2014 fill form below to add</div>';
            } else {
              dropdown.innerHTML = contacts.map(function (c) {
                return '<div class="bp-vessel-option" data-cid="' + escapeHTML(c.contact_id || '') +
                  '" data-cname="' + escapeHTML(c.contact_name || c.name || '') +
                  '" data-cemail="' + escapeHTML(c.email || '') + '">' +
                  escapeHTML(c.contact_name || c.name || '') +
                  (c.email ? ' <span class="bp-cust-email">' + escapeHTML(c.email) + '</span>' : '') +
                  '</div>';
              }).join('');
            }
            dropdown.style.display = '';
            Array.prototype.forEach.call(dropdown.querySelectorAll('.bp-vessel-option[data-cid]'), function (opt) {
              opt.addEventListener('mousedown', function (e) {
                e.preventDefault();
                if (custId)    custId.value    = opt.getAttribute('data-cid');
                if (custName)  custName.value  = opt.getAttribute('data-cname');
                if (custEmail) custEmail.value = opt.getAttribute('data-cemail');
                input.value = opt.getAttribute('data-cname');
                dropdown.style.display = 'none';
                if (ncSection) ncSection.style.display = 'none';
              });
            });
          })
          .catch(function () {
            dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">Search failed \u2014 fill form to add manually</div>';
            dropdown.style.display = '';
          });
      }, 250);
    });

    input.addEventListener('blur', function () {
      setTimeout(function () { dropdown.style.display = 'none'; }, 200);
    });

    // New customer save
    var ncSaveBtn = document.getElementById('bp-nc-save');
    if (ncSaveBtn) {
      ncSaveBtn.addEventListener('click', function () {
        var name  = ((document.getElementById('bp-nc-name') || {}).value || '').trim();
        var email = ((document.getElementById('bp-nc-email') || {}).value || '').trim();
        var phone = ((document.getElementById('bp-nc-phone') || {}).value || '').trim();
        if (!name)  { showToast('Name is required', 'error');  return; }
        if (!email) { showToast('Email is required', 'error'); return; }
        ncSaveBtn.disabled = true;
        fetch(base + '/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, phone: phone })
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            ncSaveBtn.disabled = false;
            if (data.contact_id) {
              if (custId)    custId.value    = data.contact_id;
              if (custName)  custName.value  = name;
              if (custEmail) custEmail.value = email;
              input.value = name;
              if (ncSection) ncSection.style.display = 'none';
              showToast('Customer added', 'success');
            } else {
              showToast(data.error || 'Failed to create customer', 'error');
            }
          })
          .catch(function () {
            ncSaveBtn.disabled = false;
            showToast('Failed to create customer', 'error');
          });
      });
    }
  }

  // ===== Tasks Tab =====

  function loadTasks() {
    // If tasks are already cached from eager load or recent fetch, render immediately
    if (_upcomingLoaded && _upcomingTasks.length > 0 && Date.now() - _upcomingLoadTime < CACHE_TTL * 4) {
      renderTasks();
      return;
    }
    _upcomingLoadTime = Date.now();
    var inner = document.getElementById('bp-tasks-inner');
    if (inner) inner.innerHTML = '<div class="bp-skeleton-block"></div>';
    adminApiGet('get_tasks_upcoming', { limit: 60 })
      .then(function (result) {
        _upcomingTasks = (result.data && result.data.tasks) || [];
        _upcomingLoaded = true;
        renderTasks();
      })
      .catch(function (err) {
        var inner2 = document.getElementById('bp-tasks-inner');
        if (inner2) inner2.innerHTML = '<p class="bp-empty">Failed to load tasks: ' + escapeHTML(err.message) + '</p>';
      });
  }

  function renderTasks() {
    var inner = document.getElementById('bp-tasks-inner');
    if (!inner) return;
    _taskPendingChanges = {};

    var today = todayStr();
    var weekEnd = new Date();
    weekEnd.setDate(weekEnd.getDate() + 7);
    var weekEndStr = weekEnd.toISOString().slice(0, 10);

    var groups = [
      { key: 'overdue', label: 'Overdue',   tasks: [], cls: 'bp-group--danger' },
      { key: 'today',   label: 'Today',     tasks: [], cls: 'bp-group--warning' },
      { key: 'week',    label: 'This Week', tasks: [], cls: '' },
      { key: 'later',   label: 'Later',     tasks: [], cls: '' }
    ];

    _upcomingTasks.forEach(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      if (done) return;

      var isPkg = t.is_packaging === true || t.is_packaging === 'TRUE';
      var due = t.due_date ? String(t.due_date).substring(0, 10) : '';

      // Packaging/bottling tasks with no due date are "TBD" — hide until all
      // other non-packaging tasks for the same batch are complete.
      if (isPkg && !due) {
        var otherPending = _upcomingTasks.some(function (other) {
          if (other.task_id === t.task_id) return false;
          if (other.batch_id !== t.batch_id) return false;
          var otherDone = other.completed === true || other.completed === 'TRUE' || other.completed === '1';
          if (otherDone) return false;
          var otherIsPkg = other.is_packaging === true || other.is_packaging === 'TRUE';
          return !otherIsPkg;
        });
        if (otherPending) return; // not ready yet
      }

      if (!due || due < today) { groups[0].tasks.push(t); }
      else if (due === today)  { groups[1].tasks.push(t); }
      else if (due <= weekEndStr) { groups[2].tasks.push(t); }
      else { groups[3].tasks.push(t); }
    });

    var html = '<div class="bp-tasks-toolbar">';
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-tasks-refresh">\u21bb Refresh</button>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-tasks-save-all" style="display:none;">Save All</button>';
    html += '</div>';

    var hasAny = groups.some(function (g) { return g.tasks.length > 0; });
    if (!hasAny) {
      html += '<p class="bp-empty">No upcoming tasks \u2014 all caught up!</p>';
    } else {
      groups.forEach(function (g) {
        if (g.tasks.length === 0) return;
        html += '<div class="bp-task-group ' + g.cls + '">';
        html += '<div class="bp-task-group-header">' + g.label +
          ' <span class="bp-task-group-count">(' + g.tasks.length + ')</span></div>';
        g.tasks.forEach(function (t) {
          html += '<div class="bp-task-row" data-task-id="' + escapeHTML(t.task_id) + '">';
          html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"></label>';
          html += '<div class="bp-task-body">';
          html += '<span class="bp-batch-chip">' + escapeHTML(t.batch_id || '') + '</span>';
          html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
          if (t.due_date) html += '<span class="bp-task-due">' + fmtDate(t.due_date) + '</span>';
          html += '</div></div>';
        });
        html += '</div>';
      });
    }

    inner.innerHTML = html;

    var refreshBtn = document.getElementById('bp-tasks-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _upcomingLoaded = false;
        loadTasks();
      });
    }

    var saveAllBtn = document.getElementById('bp-tasks-save-all');
    if (saveAllBtn) {
      saveAllBtn.addEventListener('click', function () {
        var tasksArr = Object.keys(_taskPendingChanges).map(function (id) {
          return { task_id: id, updates: { completed: _taskPendingChanges[id] } };
        });
        if (!tasksArr.length) return;
        saveAllBtn.disabled = true;
        adminApiPost('bulk_update_batch_tasks', { tasks: tasksArr })
          .then(function () {
            showToast(tasksArr.length + ' task' + (tasksArr.length !== 1 ? 's' : '') + ' updated', 'success');
            _taskPendingChanges = {};
            _upcomingLoaded = false;
            loadTasks();
          })
          .catch(function (err) {
            showToast('Failed: ' + err.message, 'error');
            saveAllBtn.disabled = false;
          });
      });
    }

    Array.prototype.forEach.call(inner.querySelectorAll('.bp-task-check input[type="checkbox"]'), function (cb) {
      cb.addEventListener('change', function () {
        var taskId = cb.getAttribute('data-task-id');
        if (cb.checked) {
          _taskPendingChanges[taskId] = true;
        } else {
          delete _taskPendingChanges[taskId];
        }
        if (navigator.vibrate) navigator.vibrate(cb.checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', cb.checked);
        var count = Object.keys(_taskPendingChanges).length;
        var sab = document.getElementById('bp-tasks-save-all');
        if (sab) {
          sab.style.display = count > 0 ? '' : 'none';
          sab.textContent = 'Save All (' + count + ')';
        }
      });
    });
  }

  // ===== Measurements Tab =====

  function loadMeasurementBatches() {
    var inner = document.getElementById('bp-measurements-inner');
    if (!inner) return;
    // Use cached all-batches data filtered to active — no network call
    if (_allBatchesData.length > 0) {
      _measBatches = _allBatchesData.filter(function (b) {
        var s = String(b.status || '').toLowerCase();
        return s === 'primary' || s === 'secondary' || s === 'active';
      });
      renderMeasurementsUI();
      return;
    }
    // Fallback: fetch if not cached
    inner.innerHTML = '<div class="bp-skeleton-block"></div>';
    adminApiGet('get_batches', { status: 'active' })
      .then(function (result) {
        _measBatches = (result.data && result.data.batches) || [];
        renderMeasurementsUI();
      })
      .catch(function (err) {
        inner.innerHTML = '<p class="bp-empty">Failed: ' + escapeHTML(err.message) + '</p>';
      });
  }

  function renderMeasurementsUI() {
    var inner = document.getElementById('bp-measurements-inner');
    if (!inner) return;
    _measEntryRows = [];
    _measRowCounter = 0;
    _measReadings = [];

    var html = '<div class="bp-panel-inner bp-meas-wrap">';
    html += '<div class="bp-meas-search-wrap">';
    html += '<input type="search" id="bp-meas-batch-search" class="bp-inline-input"';
    html += ' placeholder="Search batches by name, ID, vessel, location\u2026" autocomplete="off">';
    html += '<div id="bp-meas-batch-dropdown" class="bp-vessel-dropdown" style="display:none;"></div>';
    html += '<div id="bp-meas-selected-badge" class="bp-meas-selected" style="display:none;"></div>';
    html += '</div>';
    html += '<div id="bp-meas-content">';
    html += '<p class="bp-empty">Search for a batch above to record measurements.</p>';
    html += '</div>';
    html += '</div>';

    inner.innerHTML = html;

    // If a batch was already selected (tab revisit), restore it
    if (_measSelectedBatchId) {
      var matching = null;
      for (var bi = 0; bi < _measBatches.length; bi++) {
        if (_measBatches[bi].batch_id === _measSelectedBatchId) { matching = _measBatches[bi]; break; }
      }
      if (matching) {
        showMeasSelectedBadge(matching);
        loadMeasurementsForBatch(_measSelectedBatchId);
      } else {
        _measSelectedBatchId = '';
      }
    }

    bindMeasBatchSearch();
  }

  function loadMeasurementsForBatch(batchId) {
    var reqId = ++_measRequestId;   // capture current request ID to detect stale responses
    var content = document.getElementById('bp-meas-content');
    if (content) content.innerHTML = '<div class="bp-skeleton-block"></div>';
    adminApiGet('get_batch', { batch_id: batchId })
      .then(function (result) {
        if (reqId !== _measRequestId) return;  // another batch was selected before this resolved
        var data = result.data || {};
        _measReadings = (data.plato_readings || []).slice();
        _measStartDate = (data.batch && data.batch.start_date) || null;
        _measRowCounter = 0;
        _measEntryRows = [{ id: ++_measRowCounter, timestamp: todayStr() }];
        renderMeasurementsContent(batchId);
      })
      .catch(function (err) {
        if (reqId !== _measRequestId) return;
        var c = document.getElementById('bp-meas-content');
        if (c) c.innerHTML = '<p class="bp-empty">Failed: ' + escapeHTML(err.message) + '</p>';
      });
  }

  function renderMeasurementsContent(batchId) {
    var content = document.getElementById('bp-meas-content');
    if (!content) return;

    var html = '<div class="bp-meas-entry-section">';
    html += '<div class="bp-section-header">Record Readings</div>';
    html += '<div class="bp-meas-entry-table-wrap">';
    html += '<table class="bp-meas-entry-table">';
    html += '<thead><tr>';
    html += '<th>Date</th><th>&deg;P</th><th>Temp &deg;C</th><th>pH</th><th>Notes</th><th></th>';
    html += '</tr></thead>';
    html += '<tbody id="bp-meas-entry-tbody"></tbody>';
    html += '</table>';
    html += '<div class="bp-meas-entry-footer">';
    html += '<button type="button" class="btn-secondary bp-btn-sm" id="bp-meas-add-row">+ Row</button>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-meas-submit">Submit</button>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    html += '<div class="bp-meas-history-section">';
    html += '<div class="bp-section-header">History</div>';
    html += renderDataGapWarning(_measReadings);
    if (_measReadings.length >= 2) {
      html += renderPlatoChart(_measReadings, _measStartDate);
    }
    if (_measReadings.length > 0) {
      html += '<table class="bp-readings-table" aria-label="Plato readings"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th></tr></thead><tbody>';
      _measReadings.slice().reverse().slice(0, 10).forEach(function (r) {
        html += '<tr><td>' + fmtDate(r.timestamp) + '</td>' +
          '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>' +
          '<td>' + escapeHTML(r.temperature   != null ? r.temperature   : '') + '</td>' +
          '<td>' + escapeHTML(r.ph            != null ? r.ph            : '') + '</td>' +
          '<td>' + escapeHTML(r.notes || '') + '</td></tr>';
      });
      html += '</tbody></table>';
    } else {
      html += '<p class="bp-empty">No readings yet.</p>';
    }
    html += '</div>';

    content.innerHTML = html;

    renderMeasEntryRows();

    var addRowBtn = document.getElementById('bp-meas-add-row');
    if (addRowBtn) addRowBtn.addEventListener('click', addMeasRow);

    var submitBtn = document.getElementById('bp-meas-submit');
    if (submitBtn) submitBtn.addEventListener('click', function () { submitMeasRows(batchId); });
  }

  function renderMeasEntryRows() {
    var tbody = document.getElementById('bp-meas-entry-tbody');
    if (!tbody) return;
    var html = '';
    _measEntryRows.forEach(function (row) {
      var id = row.id;
      html += '<tr data-row-id="' + id + '">';
      html += '<td><input type="date" class="bp-meas-row-date bp-inline-input" value="' + escapeHTML(row.timestamp || todayStr()) + '"></td>';
      html += '<td><input type="number" class="bp-meas-row-plato bp-inline-input" step="0.1" max="40" placeholder="\u2014"></td>';
      html += '<td><input type="number" class="bp-meas-row-temp bp-inline-input" step="0.1" placeholder="\u2014"></td>';
      html += '<td><input type="number" class="bp-meas-row-ph bp-inline-input" step="0.01" min="0" max="14" placeholder="\u2014"></td>';
      html += '<td><input type="text" class="bp-meas-row-notes bp-inline-input" placeholder="optional"></td>';
      html += '<td><button type="button" class="bp-staging-remove" data-row-id="' + id + '">&times;</button></td>';
      html += '</tr>';
    });
    tbody.innerHTML = html;

    // Bind remove buttons
    Array.prototype.forEach.call(tbody.querySelectorAll('.bp-staging-remove[data-row-id]'), function (btn) {
      btn.addEventListener('click', function () {
        var rowId = parseInt(btn.getAttribute('data-row-id'), 10);
        if (_measEntryRows.length <= 1) {
          // Last row — just clear fields instead of removing
          var tr = tbody.querySelector('tr[data-row-id="' + rowId + '"]');
          if (tr) {
            var inputs = tr.querySelectorAll('input');
            Array.prototype.forEach.call(inputs, function (inp) {
              if (inp.type === 'date') { inp.value = todayStr(); }
              else { inp.value = ''; }
            });
          }
          _measEntryRows[0].timestamp = todayStr();
          return;
        }
        _measEntryRows = _measEntryRows.filter(function (r) { return r.id !== rowId; });
        renderMeasEntryRows();
      });
    });
  }

  function addMeasRow() {
    _measEntryRows.push({ id: ++_measRowCounter, timestamp: todayStr() });
    renderMeasEntryRows();
    var tbody = document.getElementById('bp-meas-entry-tbody');
    if (tbody) {
      var lastRow = tbody.querySelector('tr:last-child');
      if (lastRow) {
        var dateInput = lastRow.querySelector('.bp-meas-row-date');
        if (dateInput) dateInput.focus();
      }
    }
  }

  function submitMeasRows(batchId) {
    var rows = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('#bp-meas-entry-tbody tr[data-row-id]'),
      function (tr) {
        var date  = tr.querySelector('.bp-meas-row-date').value;
        var plato = tr.querySelector('.bp-meas-row-plato').value;
        var temp  = tr.querySelector('.bp-meas-row-temp').value;
        var ph    = tr.querySelector('.bp-meas-row-ph').value;
        var notes = tr.querySelector('.bp-meas-row-notes').value;
        if (!date || (plato === '' && temp === '' && ph === '')) return;
        var row = { timestamp: date };
        if (plato !== '') row.degrees_plato = parseFloat(plato);
        if (temp  !== '') row.temperature   = parseFloat(temp);
        if (ph    !== '') row.ph            = parseFloat(ph);
        if (notes) row.notes = notes;
        rows.push(row);
      }
    );
    if (!rows.length) { showToast('No measurements to submit', 'error'); return; }

    var submitBtn = document.getElementById('bp-meas-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting\u2026'; }

    var measTimeout = setTimeout(function () {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
      showToast('Request timed out \u2014 readings preserved', 'error');
    }, 60000);

    adminApiPost('bulk_add_plato_readings', { batch_id: batchId, readings: rows })
      .then(function (result) {
        clearTimeout(measTimeout);
        showToast(rows.length + ' reading' + (rows.length !== 1 ? 's' : '') + ' recorded', 'success');
        if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
        var results = (result && result.results) || [];
        rows.forEach(function (r, i) {
          r.reading_id = (results[i] && results[i].reading_id) || ('confirmed-' + Date.now() + i);
          _measReadings.push(r);
        });
        _measRowCounter = 0;
        _measEntryRows = [{ id: ++_measRowCounter, timestamp: todayStr() }];
        renderMeasurementsContent(batchId);
      })
      .catch(function (err) {
        clearTimeout(measTimeout);
        showToast('Failed: ' + err.message + ' \u2014 readings preserved', 'error');
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit'; }
      });
  }

  function showMeasSelectedBadge(batch) {
    var badge = document.getElementById('bp-meas-selected-badge');
    if (!badge) return;
    var loc = [batch.vessel_id, batch.shelf_id, batch.bin_id].filter(Boolean).join(' \u00b7 ');
    var label = escapeHTML(batch.batch_id) + ' \u2014 ' + escapeHTML(batch.product_name || batch.product_sku || '');
    if (loc) label += ' \u00b7 ' + escapeHTML(loc);
    badge.innerHTML = '<span>' + label + '</span>' +
      '<button type="button" class="bp-meas-selected-clear" aria-label="Clear selection">&times;</button>';
    badge.style.display = '';
    var clearBtn = badge.querySelector('.bp-meas-selected-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        _measSelectedBatchId = '';
        _measReadings = [];
        _measEntryRows = [];
        _measRowCounter = 0;
        badge.style.display = 'none';
        var searchInput = document.getElementById('bp-meas-batch-search');
        if (searchInput) { searchInput.value = ''; searchInput.focus(); }
        var dropdown = document.getElementById('bp-meas-batch-dropdown');
        if (dropdown) dropdown.style.display = 'none';
        var content = document.getElementById('bp-meas-content');
        if (content) content.innerHTML = '<p class="bp-empty">Search for a batch above to record measurements.</p>';
      });
    }
  }

  function bindMeasBatchSearch() {
    var searchInput = document.getElementById('bp-meas-batch-search');
    var dropdown = document.getElementById('bp-meas-batch-dropdown');
    if (!searchInput || !dropdown) return;

    function showMeasDropdown(term) {
      var lower = term.toLowerCase().trim();
      var matches = _measBatches.filter(function (b) {
        if (!lower) return true;
        var hay = (String(b.batch_id || '') + ' ' +
          String(b.product_name || '') + ' ' +
          String(b.product_sku  || '') + ' ' +
          String(b.customer_name || '') + ' ' +
          String(b.vessel_id || '') + ' ' +
          String(b.shelf_id || '') + ' ' +
          String(b.bin_id || '')).toLowerCase();
        return hay.indexOf(lower) !== -1;
      }).slice(0, 10);

      if (matches.length === 0) {
        dropdown.innerHTML = '<div class="bp-vessel-option bp-vessel-option--empty">No batches found</div>';
      } else {
        dropdown.innerHTML = matches.map(function (b) {
          var loc = [b.vessel_id, b.shelf_id && b.bin_id ? b.shelf_id + '-' + b.bin_id : (b.shelf_id || b.bin_id)].filter(Boolean).join(' \u00b7 ');
          var label = escapeHTML(b.batch_id) + ' \u2014 ' + escapeHTML(b.product_name || b.product_sku || '');
          if (b.vessel_id) label += ' \u2014 Vessel ' + escapeHTML(String(b.vessel_id));
          if (loc) label += ' \u00b7 ' + escapeHTML(loc);
          var status = String(b.status || '');
          if (status) label += ' [' + escapeHTML(status) + ']';
          return '<div class="bp-vessel-option" data-batch-id="' + escapeHTML(b.batch_id) + '">' + label + '</div>';
        }).join('');
      }
      dropdown.style.display = '';

      Array.prototype.forEach.call(dropdown.querySelectorAll('.bp-vessel-option[data-batch-id]'), function (opt) {
        opt.addEventListener('mousedown', function (e) {
          e.preventDefault();
          var batchId = opt.getAttribute('data-batch-id');
          var selectedBatch = null;
          for (var bi = 0; bi < _measBatches.length; bi++) {
            if (_measBatches[bi].batch_id === batchId) { selectedBatch = _measBatches[bi]; break; }
          }
          _measSelectedBatchId = batchId;
          searchInput.value = '';
          dropdown.style.display = 'none';
          if (selectedBatch) showMeasSelectedBadge(selectedBatch);
          _measRowCounter = 0;
          _measEntryRows = [{ id: ++_measRowCounter, timestamp: todayStr() }];
          loadMeasurementsForBatch(batchId);
        });
      });
    }

    searchInput.addEventListener('focus', function () {
      if (!searchInput.value.trim()) showMeasDropdown('');
    });

    searchInput.addEventListener('input', function () {
      clearTimeout(_measSearchTimer);
      _measSearchTimer = setTimeout(function () {
        _measSearchTimer = null;
        showMeasDropdown(searchInput.value);
      }, 150);
    });

    searchInput.addEventListener('blur', function () {
      setTimeout(function () { dropdown.style.display = 'none'; }, 200);
    });
  }

  // ===== Bootstrap =====

  document.addEventListener('DOMContentLoaded', function () {
    // Wire tab bar
    Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    waitForGoogleIdentity();
  });

})();

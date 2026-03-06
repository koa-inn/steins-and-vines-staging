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
  var _batchViewMode = 'cards';   // 'cards' or 'table'
  var _batchTableSortCol = 'batch_id';
  var _batchTableSortDir = 1;
  var _selectedBatchId = null;
  var _vesselsData = null;
  var _vesselsCacheTime = 0;       // TTL: reload vessel list if >30s stale
  var _vesselsMap = {};            // keyed by vessel_id for O(1) lookup
  var _fermSchedules = [];
  var _fermSchedulesCacheTime = 0; // TTL: reload schedule list if >5min stale

  // Batch detail
  var _detailPlatoStaging = [];
  var _detailPlatoReadings = [];
  var _detailStartDate = null;
  var _detailBatchId = null;

  // Tasks
  var _upcomingTasks = [];
  var _upcomingLoaded = false;
  var _upcomingLoadTime = 0;
  var _taskSaveTimers = {};    // keyed by taskId — per-checkbox auto-save debounce
  var _chartCache = {};        // keyed by batchId+readingCount+lastTimestamp

  // Measurements
  var _measBatches = [];
  var _measSharedDate = '';      // shared date for multi-batch sweep entry
  var _measMultiData = {};       // batchId -> {plato, temp, ph, notes} for current session
  var _measFilterText = '';      // grid search filter
  var _measFilterTimer = null;   // debounce timer for grid filter
  var _measSortCol = 'batch_id';
  var _measSortDir = 1;   // 1=asc, -1=desc

  // Dashboard
  var _dashSummary = null;
  var _dashLoadTime = 0;
  var _dashAutoRefreshTimer = null;
  var _notesAutoSaveTimer = null;
  var _dashExpandedDay = null;

  // Product catalog
  var _kitCatalog = null;
  var _kitCatalogLoadTime = 0;

  var CACHE_TTL = 300000;       // 5min per-tab cache (single-user — safe to cache aggressively)
  var CACHE_TTL_LONG = 600000;  // 10min for batch list + dashboard
  var KIT_CACHE_TTL = 600000;   // 10min product catalog

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
      // Show a loading indicator while the silent token refresh is in flight.
      var signinCard = document.querySelector('.bp-signin-card');
      if (signinCard) {
        var resumeEl = document.createElement('p');
        resumeEl.id = 'bp-resuming-msg';
        resumeEl.style.cssText = 'text-align:center;color:var(--ink-secondary);font-size:0.95rem;margin-top:12px;';
        resumeEl.textContent = 'Resuming session\u2026';
        signinCard.appendChild(resumeEl);
      }
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
    var resumeEl = document.getElementById('bp-resuming-msg');
    if (resumeEl) resumeEl.parentNode.removeChild(resumeEl);
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

    var clearCacheBtn = document.getElementById('bp-clear-cache');
    if (clearCacheBtn) {
      clearCacheBtn.addEventListener('click', function () {
        showConfirmSheet('Clear app cache and reload?', 'Clear & Reload', '', function () {
          var done = function () { location.reload(true); };
          if (window.caches) {
            caches.keys().then(function (keys) {
              return Promise.all(keys.map(function (k) { return caches.delete(k); }));
            }).then(function () {
              if (navigator.serviceWorker) {
                navigator.serviceWorker.getRegistrations().then(function (regs) {
                  regs.forEach(function (r) { r.unregister(); });
                  done();
                }).catch(done);
              } else { done(); }
            }).catch(done);
          } else { done(); }
        });
      });
    }

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

  function getBatchMeta(batchId) {
    if (!batchId || !_allBatchesData.length) return '';
    for (var i = 0; i < _allBatchesData.length; i++) {
      var b = _allBatchesData[i];
      if (b.batch_id === batchId) {
        var parts = [];
        if (b.product_name || b.product_sku) parts.push(b.product_name || b.product_sku);
        var loc = '';
        if (b.vessel_id) loc += b.vessel_id;
        if (b.shelf_id) loc += (loc ? ' ' : '') + b.shelf_id;
        if (b.bin_id) loc += '-' + b.bin_id;
        if (loc) parts.push(loc);
        return parts.join(' \u00b7 ');
      }
    }
    return '';
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
      if (now - _dashLoadTime > CACHE_TTL_LONG) loadDashboard();
    } else if (tab === 'batches') {
      if (_selectedBatchId) closeBatchDetail();   // close any open detail pane
      if (_allBatchesData.length > 0) {
        // Derive filtered list from cache — instant
        _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
        _batchesLoaded = true;
        renderBatchList();
      } else {
        loadBatches();
      }
    } else if (tab === 'tasks') {
      if (!_upcomingLoaded || now - _upcomingLoadTime > CACHE_TTL) {
        loadTasks();
      } else {
        renderTasks();
      }
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
      adminApiGet('get_tasks_upcoming', { limit: 200 }),
      // Pre-load kit catalog so "New Batch" form opens instantly
      fetch(mwUrl() + '/api/kiosk/products').then(function (r) { return r.json(); }).catch(function () { return { items: [] }; })
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

      // Kit catalog pre-loaded — no cold-start latency when opening New Batch form
      var kitItems = (results[5] && results[5].items) || [];
      _kitCatalog = kitItems.filter(function (p) { return (p.product_type || '').toLowerCase() === 'kit'; });
      _kitCatalogLoadTime = Date.now();

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
    }, 300000); // 5min — single user, no concurrent edits
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
    // API returns flat counts: primaryCount, secondaryCount, completeCount
    html += '<div class="bp-pipeline-strip">';
    var stages = [
      { key: 'primary',   label: 'Primary',   icon: '&#127863;', countField: 'primaryCount'   },
      { key: 'secondary', label: 'Secondary', icon: '&#127870;', countField: 'secondaryCount' },
      { key: 'complete',  label: 'Complete',  icon: '&#10003;',  countField: 'completeCount'  }
    ];
    stages.forEach(function (s) {
      var count = d[s.countField] || 0;
      html += '<button type="button" class="bp-pipeline-tile" data-status="' + s.key + '">';
      html += '<span class="bp-pipeline-icon">' + s.icon + '</span>';
      html += '<span class="bp-pipeline-count">' + count + '</span>';
      html += '<span class="bp-pipeline-label">' + s.label + '</span>';
      html += '</button>';
    });
    html += '</div>';

    // Stat cards + Active batches (computed from _allBatchesData)
    if (_allBatchesData.length > 0) {
      var thisYear = new Date().getFullYear();
      var ytdStarted = 0, ytdComplete = 0, activeNow = 0;
      var totalDays = 0, completedWithDays = [];
      _allBatchesData.forEach(function (b) {
        var yr = b.start_date ? parseInt(String(b.start_date).slice(0, 4), 10) : 0;
        if (yr === thisYear) ytdStarted++;
        var st = String(b.status || '').toLowerCase();
        if (yr === thisYear && st === 'complete') {
          ytdComplete++;
          if (b.start_date) {
            var daysDone = Math.floor((Date.now() - new Date(b.start_date)) / 86400000);
            if (daysDone > 0) { completedWithDays.push(daysDone); totalDays += daysDone; }
          }
        }
        if (st === 'primary' || st === 'secondary') activeNow++;
      });
      var avgDays = completedWithDays.length ? Math.round(totalDays / completedWithDays.length) : null;
      html += '<div class="bp-stat-grid">';
      html += '<div class="bp-stat-card"><div class="bp-stat-num">' + activeNow + '</div><div class="bp-stat-label">Fermenting now</div></div>';
      html += '<div class="bp-stat-card"><div class="bp-stat-num">' + ytdStarted + '</div><div class="bp-stat-label">Started this year</div></div>';
      html += '<div class="bp-stat-card"><div class="bp-stat-num">' + ytdComplete + '</div><div class="bp-stat-label">Completed this year</div></div>';
      html += '<div class="bp-stat-card"><div class="bp-stat-num">' + (avgDays !== null ? avgDays : '\u2014') + '</div><div class="bp-stat-label">Avg days to complete</div></div>';
      html += '</div>';
    }

    // Attention items — built client-side from scalar counts returned by the API
    // (overdueTasks, tasksDueToday, readyForPackaging)
    var attention = [];
    if (d.overdueTasks > 0) {
      attention.push({ cls: 'bp-attention--danger',
        text: d.overdueTasks + ' overdue task' + (d.overdueTasks !== 1 ? 's' : '') });
    }
    if (d.tasksDueToday > 0) {
      attention.push({ cls: 'bp-attention--warning',
        text: d.tasksDueToday + ' task' + (d.tasksDueToday !== 1 ? 's' : '') + ' due today' });
    }
    if (d.readyForPackaging > 0) {
      attention.push({ cls: 'bp-attention--success',
        text: d.readyForPackaging + ' batch' + (d.readyForPackaging !== 1 ? 'es' : '') + ' ready for packaging' });
    }
    html += '<div class="bp-section-header">Needs Attention</div>';
    if (attention.length > 0) {
      html += '<div class="bp-attention-list">';
      attention.forEach(function (item) {
        html += '<div class="bp-attention-item ' + item.cls + '">';
        html += '<span class="bp-attention-dot"></span>';
        html += '<span class="bp-attention-text">' + escapeHTML(item.text) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    } else if (_dashSummary) {
      html += '<p class="bp-empty">All batches on track.</p>';
    }

    // Today's tasks checklist
    var todayTasks = _upcomingTasks.filter(function (t) {
      var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
      return !done && t.due_date && String(t.due_date).slice(0, 10) === todayStr();
    });
    if (todayTasks.length) {
      html += '<div class="bp-section-header">Today\u2019s Tasks</div>';
      html += '<div class="bp-dash-task-list">';
      todayTasks.forEach(function (t) {
        html += '<div class="bp-task-row" data-task-id="' + escapeHTML(t.task_id) + '">';
        html += '<label class="bp-task-check"><input type="checkbox" data-task-id="' + escapeHTML(t.task_id) + '"></label>';
        html += '<div class="bp-task-body">';
        html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '">' + escapeHTML(t.batch_id || '') + '</button>';
        html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
        var meta = getBatchMeta(t.batch_id);
        if (meta) html += '<span class="bp-task-meta">' + escapeHTML(meta) + '</span>';
        html += '</div></div>';
      });
      html += '</div>';
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
        var expandedCls = _dashExpandedDay === d.date ? ' bp-wl-day--expanded' : '';
        html += '<div class="bp-wl-day' + expandedCls + '" data-date="' + d.date + '">';
        html += '<div class="bp-wl-bar-wrap"><div class="bp-wl-bar ' + barCls + '" style="transform:scaleY(' + (d.count > 0 ? Math.max(pct, 12) / 100 : 0) + ')"></div></div>';
        html += '<div class="bp-wl-count">' + (d.count || '') + '</div>';
        html += '<div class="bp-wl-label">' + escapeHTML(d.label) + '</div>';
        html += '</div>';
      });
      html += '</div>';
      // Expanded task card for tapped workload day — always render when a day is selected
      if (_dashExpandedDay) {
        var expandTasks = _upcomingTasks.filter(function (t) {
          var done = t.completed === true || t.completed === 'TRUE' || t.completed === '1';
          return !done && t.due_date && String(t.due_date).slice(0, 10) === _dashExpandedDay;
        });
        html += '<div class="bp-wl-expanded-card">';
        html += '<div class="bp-wl-expanded-date">' + fmtDate(_dashExpandedDay) + '</div>';
        if (expandTasks.length) {
          expandTasks.forEach(function (t) {
            html += '<div class="bp-wl-expanded-item">';
            html += '<span class="bp-batch-chip-inline">' + escapeHTML(t.batch_id || '') + '</span> ';
            html += escapeHTML(t.title || ('Step ' + t.step_number));
            html += '</div>';
          });
        } else {
          html += '<p class="bp-empty" style="margin:0;font-size:0.85rem;">No tasks this day.</p>';
        }
        html += '</div>';
      }
    }

    html += '<button type="button" class="bp-fab" id="bp-dash-new-batch">+ New Batch</button>';
    inner.innerHTML = html;

    // Pipeline tile + workload day clicks handled by delegation on #bp-dashboard-inner (see initDelegation)
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
    if (_allBatchesData.length > 0 && now - _batchesLoadTime < CACHE_TTL_LONG) {
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

    // Search + new batch + view toggle
    html += '<div class="bp-batch-search-row">';
    html += '<input type="search" class="bp-search-input" id="bp-batch-search" placeholder="Search batches\u2026" value="' + escapeHTML(_batchSearch) + '" autocomplete="off" inputmode="search">';
    html += '<button type="button" class="bp-view-toggle btn-secondary bp-btn-sm" id="bp-batch-view-toggle" title="' + (_batchViewMode === 'cards' ? 'Switch to table view' : 'Switch to card view') + '">' + (_batchViewMode === 'cards' ? '\u2630' : '\u229e') + '</button>';
    html += '<button type="button" class="btn bp-new-batch-btn" id="bp-list-new-batch">+ New Batch</button>';
    html += '</div>';

    if (filtered.length === 0) {
      html += '<p class="bp-empty">No batches found.</p>';
    } else if (_batchViewMode === 'table') {
      // Compact table view
      var today = todayStr();
      var sortedFiltered = filtered.slice().sort(function (a, b) {
        var av, bv;
        if (_batchTableSortCol === 'days') {
          av = a.start_date ? Date.now() - new Date(a.start_date) : 0;
          bv = b.start_date ? Date.now() - new Date(b.start_date) : 0;
          return (av - bv) * _batchTableSortDir;
        }
        av = String(a[_batchTableSortCol] || '').toLowerCase();
        bv = String(b[_batchTableSortCol] || '').toLowerCase();
        return av < bv ? -_batchTableSortDir : av > bv ? _batchTableSortDir : 0;
      });
      function batchSortIcon(col) {
        if (_batchTableSortCol !== col) return '<span class="bp-sort-icon">&#8645;</span>';
        return '<span class="bp-sort-icon">' + (_batchTableSortDir === 1 ? '&#8593;' : '&#8595;') + '</span>';
      }
      html += '<table class="bp-batch-table"><thead><tr>';
      html += '<th class="bp-sort-th' + (_batchTableSortCol === 'batch_id' ? ' bp-sort-active' : '') + '" data-sort="batch_id">Batch ' + batchSortIcon('batch_id') + '</th>';
      html += '<th class="bp-sort-th' + (_batchTableSortCol === 'product_name' ? ' bp-sort-active' : '') + '" data-sort="product_name">Product ' + batchSortIcon('product_name') + '</th>';
      html += '<th class="bp-sort-th' + (_batchTableSortCol === 'customer_name' ? ' bp-sort-active' : '') + '" data-sort="customer_name">Customer ' + batchSortIcon('customer_name') + '</th>';
      html += '<th>Vessel / Loc</th>';
      html += '<th class="bp-sort-th' + (_batchTableSortCol === 'status' ? ' bp-sort-active' : '') + '" data-sort="status">Stage ' + batchSortIcon('status') + '</th>';
      html += '<th class="bp-sort-th' + (_batchTableSortCol === 'days' ? ' bp-sort-active' : '') + '" data-sort="days">Days ' + batchSortIcon('days') + '</th>';
      html += '</tr></thead><tbody>';
      sortedFiltered.forEach(function (b) {
        var statusKey = String(b.status || '').toLowerCase();
        var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
        var statusColor = STATUS_COLORS[statusKey] || 'info';
        var isSelected = b.batch_id === _selectedBatchId;
        var overdueCount = 0;
        for (var oi = 0; oi < _upcomingTasks.length; oi++) {
          var ot = _upcomingTasks[oi];
          if (ot.batch_id !== b.batch_id) continue;
          var done = ot.completed === true || ot.completed === 'TRUE' || ot.completed === '1';
          if (done) continue;
          var due = ot.due_date ? String(ot.due_date).substring(0, 10) : '';
          if (due && due < today) overdueCount++;
        }
        var days = b.start_date ? Math.floor((Date.now() - new Date(b.start_date)) / 86400000) : '\u2014';
        var loc = [b.vessel_id, b.shelf_id && b.bin_id ? b.shelf_id + '-' + b.bin_id : (b.shelf_id || b.bin_id || '')].filter(Boolean).join(' ');
        var rowCls = (isSelected ? 'bp-batch-tr--selected' : '') + (overdueCount > 0 ? ' bp-batch-tr--urgent' : '');
        html += '<tr class="' + rowCls + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
        html += '<td class="bp-batch-tr-id">' + escapeHTML(b.batch_id) + (overdueCount > 0 ? ' <span class="bp-urgent-dot">\u25cf</span>' : '') + '</td>';
        html += '<td>' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</td>';
        html += '<td>' + escapeHTML(b.customer_name || '\u2014') + '</td>';
        html += '<td>' + escapeHTML(loc || '\u2014') + '</td>';
        html += '<td><span class="bp-status-badge bp-status-badge--' + statusColor + '" style="font-size:0.72rem;padding:1px 6px;">' + escapeHTML(statusLabel) + '</span></td>';
        html += '<td>' + days + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    } else {
      // Card view (default)
      html += '<div class="bp-batch-cards">';
      filtered.forEach(function (b) {
        var statusKey = String(b.status || '').toLowerCase();
        var statusLabel = STATUS_LABELS[statusKey] || b.status || '';
        var statusColor = STATUS_COLORS[statusKey] || 'info';
        var tasksDone = parseInt(b.tasks_done) || 0;
        var tasksTotal = parseInt(b.tasks_total) || 0;
        var isSelected = b.batch_id === _selectedBatchId;

        var today = todayStr();
        var overdueCount = 0;
        for (var oi = 0; oi < _upcomingTasks.length; oi++) {
          var ot = _upcomingTasks[oi];
          if (ot.batch_id !== b.batch_id) continue;
          var done = ot.completed === true || ot.completed === 'TRUE' || ot.completed === '1';
          if (done) continue;
          var due = ot.due_date ? String(ot.due_date).substring(0, 10) : '';
          if (due && due < today) overdueCount++;
        }
        var cardCls = 'bp-batch-card' +
          (isSelected ? ' bp-batch-card--selected' : '') +
          (overdueCount > 0 ? ' bp-batch-card--urgent' : '');

        html += '<div class="' + cardCls + '" data-batch-id="' + escapeHTML(b.batch_id) + '">';
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

    // Filter button + batch card clicks handled by delegation on #bp-batch-list-pane (see initDelegation)
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
  }

  function selectBatch(batchId) {
    // If the detail pane is already showing this exact batch (user tapped same card twice),
    // just ensure it is visible and skip the redundant network fetch.
    if (_detailBatchId === batchId && _selectedBatchId === batchId) {
      var existingDetail = document.getElementById('bp-batch-detail-pane');
      if (existingDetail && existingDetail.style.display !== 'none' &&
          existingDetail.querySelector('.bp-detail-content')) {
        return;
      }
    }

    _selectedBatchId = batchId;
    _chartCache = {};   // invalidate cached chart for previous batch

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

  function showConfirmSheet(message, okLabel, okCls, onOk) {
    var sheet = document.getElementById('bp-confirm-sheet');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'bp-confirm-sheet';
      sheet.className = 'bp-confirm-sheet';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.innerHTML =
        '<div class="bp-confirm-sheet-inner">' +
        '<p class="bp-confirm-sheet-msg" id="bp-confirm-sheet-msg"></p>' +
        '<div class="bp-confirm-sheet-actions">' +
        '<button type="button" id="bp-confirm-sheet-ok" class="btn"></button>' +
        '<button type="button" id="bp-confirm-sheet-cancel" class="btn-secondary">Cancel</button>' +
        '</div></div>';
      document.body.appendChild(sheet);
    }
    document.getElementById('bp-confirm-sheet-msg').textContent = message;
    var okBtn = document.getElementById('bp-confirm-sheet-ok');
    okBtn.textContent = okLabel;
    okBtn.className = 'btn ' + (okCls || '');

    function hide() {
      sheet.classList.remove('bp-confirm-sheet--visible');
      okBtn.removeEventListener('click', handleOk);
      document.getElementById('bp-confirm-sheet-cancel').removeEventListener('click', hide);
      sheet.removeEventListener('click', handleBackdrop);
    }
    function handleOk() { hide(); onOk(); }
    function handleBackdrop(e) { if (e.target === sheet) hide(); }

    okBtn.addEventListener('click', handleOk);
    document.getElementById('bp-confirm-sheet-cancel').addEventListener('click', hide);
    sheet.addEventListener('click', handleBackdrop);
    sheet.classList.add('bp-confirm-sheet--visible');
  }

  function renderBatchDetail(data) {
    var b = data.batch || {};
    var tasks = data.tasks || [];
    var readings = data.plato_readings || [];

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
    html += '<button type="button" class="btn-secondary bp-btn-sm bp-detail-back" id="bp-detail-back" aria-label="Back to batch list">\u2190</button>';
    html += '<div class="bp-detail-title-group">';
    html += '<span class="bp-detail-batch-id">' + escapeHTML(b.batch_id) + '</span>';
    html += '<span class="bp-status-badge bp-status-badge--' + statusColor + ' bp-status-clickable" id="bp-detail-status">' + escapeHTML(statusLabel) + '</span>';
    html += '</div>';
    html += '<button type="button" class="btn bp-btn-sm" id="bp-detail-qr-btn" title="Generate printable QR code for public batch page">Print QR</button>';
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
    html += '</div>';

    // Readings
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Measurements</div>';
    html += '<div id="bp-detail-readings">' + renderDetailReadings(_detailPlatoReadings, _detailStartDate) + '</div>';
    html += '</div>';

    // Notes
    html += '<div class="bp-detail-section">';
    html += '<div class="bp-detail-section-title">Notes</div>';
    html += '<textarea id="bp-detail-notes" class="bp-inline-input bp-notes-input" rows="3" placeholder="Auto-saved\u2026">' + escapeHTML(b.notes || '') + '</textarea>';
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
        showConfirmSheet(
          'Move ' + b.batch_id + ' to \u201c' + (STATUS_LABELS[next] || next) + '\u201d?',
          'Confirm', 'bp-confirm-btn--primary',
          function () {
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
          }
        );
      });
    }

    // Readings handlers
    bindDetailReadingHandlers(b.batch_id);

    // Notes auto-save (2 s debounce)
    var notesTextarea = document.getElementById('bp-detail-notes');
    if (notesTextarea) {
      notesTextarea.addEventListener('input', function () {
        clearTimeout(_notesAutoSaveTimer);
        _notesAutoSaveTimer = setTimeout(function () {
          var notes = notesTextarea.value || '';
          adminApiPost('update_batch', { batch_id: b.batch_id, updates: { notes: notes } })
            .then(function () {
              b.notes = notes;
              showToast('Notes saved', 'success');
            })
            .catch(function (err) { showToast('Notes save failed: ' + err.message, 'error'); });
        }, 2000);
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
        showConfirmSheet(
          'Delete ' + b.batch_id + '? This cannot be undone.',
          'Delete', 'bp-confirm-btn--danger',
          function () {
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
          }
        );
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
      setTimeout(function () { win.print(); }, 400);
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

  function renderDetailReadings(readings, startDate) {
    var html = renderDataGapWarning(readings);
    if (readings && readings.length >= 2) {
      var cacheKey = (_detailBatchId || '') + '-' + readings.length + '-' + (readings[readings.length - 1] ? readings[readings.length - 1].timestamp : '');
      if (!_chartCache[cacheKey]) {
        _chartCache[cacheKey] = renderPlatoChart(readings, startDate);
      }
      html += _chartCache[cacheKey];
    }
    if (readings && readings.length >= 2) {
      var ogReading = null, fgReading = null;
      for (var ri = 0; ri < readings.length; ri++) {
        if (readings[ri].degrees_plato != null && !ogReading) ogReading = readings[ri];
        if (readings[ri].degrees_plato != null) fgReading = readings[ri];
      }
      if (ogReading && fgReading && ogReading !== fgReading) {
        var og = parseFloat(ogReading.degrees_plato);
        var fg = parseFloat(fgReading.degrees_plato);
        var abv = (og - fg) / (2.0665 - 0.010665 * og);
        html += '<div class="bp-abv-strip">';
        html += '<span class="bp-abv-label">Est. ABV</span>';
        html += '<span class="bp-abv-val">' + abv.toFixed(1) + '%</span>';
        html += '<span class="bp-abv-detail">' + og.toFixed(1) + '°P → ' + fg.toFixed(1) + '°P</span>';
        html += '</div>';
      }
    }
    if (readings && readings.length > 0) {
      html += '<table class="bp-readings-table" aria-label="Plato readings"><thead><tr><th>Date</th><th>&deg;P</th><th>Temp</th><th>pH</th><th>Notes</th><th class="bp-reading-th-actions"></th></tr></thead><tbody>';
      var rdLen = readings.length;
      readings.slice().reverse().slice(0, 10).forEach(function (r, i) {
        var actualIdx = rdLen - 1 - i;
        html += '<tr>';
        html += '<td>' + fmtDate(r.timestamp) + '</td>';
        html += '<td>' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '</td>';
        html += '<td>' + escapeHTML(r.temperature != null ? r.temperature : '') + '</td>';
        html += '<td>' + escapeHTML(r.ph != null ? r.ph : '') + '</td>';
        html += '<td>' + escapeHTML(r.notes || '') + '</td>';
        html += '<td class="bp-reading-actions">';
        html += '<button class="bp-reading-edit" data-idx="' + actualIdx + '" title="Edit">\u270E</button>';
        html += '<button class="bp-reading-del" data-idx="' + actualIdx + '" title="Delete">&times;</button>';
        html += '</td>';
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
    // Staging remove buttons handled by delegation on #bp-batch-detail-pane (see initDelegation)
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
            _chartCache = {};   // new reading → invalidate memoized chart
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
      }, 180);
    }
    Array.prototype.forEach.call(document.querySelectorAll('.bp-batch-card'), function (c) {
      c.classList.remove('bp-batch-card--selected');
    });
  }

  function openReadingEditRow(idx) {
    var r = _detailPlatoReadings[idx];
    if (!r) return;
    var tbody = document.querySelector('#bp-detail-readings tbody');
    if (!tbody) return;
    // rows are rendered reversed; idx is actual position in _detailPlatoReadings
    // rendered row position = len - 1 - idx
    var rowPos = _detailPlatoReadings.length - 1 - idx;
    var rows = tbody.querySelectorAll('tr');
    var rowEl = rows[rowPos];
    if (!rowEl) return;
    rowEl.className = 'bp-reading-edit-row';
    rowEl.innerHTML =
      '<td><input class="bp-inline-input" id="re-date" type="date" value="' + escapeHTML(r.timestamp ? String(r.timestamp).slice(0, 10) : '') + '" style="width:110px;"></td>' +
      '<td><input class="bp-inline-input" id="re-plato" type="number" inputmode="decimal" step="0.1" max="40" value="' + escapeHTML(r.degrees_plato != null ? r.degrees_plato : '') + '" style="width:56px;"></td>' +
      '<td><input class="bp-inline-input" id="re-temp" type="number" inputmode="decimal" step="0.1" value="' + escapeHTML(r.temperature != null ? r.temperature : '') + '" style="width:56px;"></td>' +
      '<td><input class="bp-inline-input" id="re-ph" type="number" inputmode="decimal" step="0.01" min="0" max="14" value="' + escapeHTML(r.ph != null ? r.ph : '') + '" style="width:52px;"></td>' +
      '<td><input class="bp-inline-input" id="re-notes" type="text" value="' + escapeHTML(r.notes || '') + '" style="width:100%;"></td>' +
      '<td class="bp-reading-actions">' +
      '<button class="btn bp-btn-sm bp-reading-save-edit" data-idx="' + idx + '">Save</button>' +
      '<button class="bp-reading-cancel-edit btn-secondary bp-btn-sm" data-idx="' + idx + '">\u00d7</button>' +
      '</td>';
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
    // Backdrop tap to dismiss: tap outside the inner sheet panel closes it.
    sheet.addEventListener('click', function handleBackdropClick(e) {
      if (e.target === sheet) {
        closeCreateSheet();
        sheet.removeEventListener('click', handleBackdropClick);
      }
    });
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
    setTimeout(function () { sheet.style.display = 'none'; }, 180);
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
    var _custSearchAbort = null;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (ncSection) ncSection.style.display = q.length >= 2 ? '' : 'none';
      if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }
      timer = setTimeout(function () {
        if (_custSearchAbort) { try { _custSearchAbort.abort(); } catch (e) {} }
        _custSearchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var fetchOpts = _custSearchAbort ? { signal: _custSearchAbort.signal } : {};
        fetch(base + '/api/contacts?search=' + encodeURIComponent(q), fetchOpts)
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
          .catch(function (err) {
            if (err && err.name === 'AbortError') return; // stale request cancelled — ignore
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
    if (_upcomingLoaded && _upcomingTasks.length > 0 && Date.now() - _upcomingLoadTime < CACHE_TTL_LONG) {
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
          html += '<button type="button" class="bp-batch-chip" data-batch-id="' + escapeHTML(t.batch_id || '') + '" title="Open batch">' + escapeHTML(t.batch_id || '') + '</button>';
          html += '<span class="bp-task-title">' + escapeHTML(t.title || ('Step ' + t.step_number)) + '</span>';
          if (t.due_date) html += '<span class="bp-task-due">' + fmtDate(t.due_date) + '</span>';
          var meta = getBatchMeta(t.batch_id);
          if (meta) html += '<span class="bp-task-meta">' + escapeHTML(meta) + '</span>';
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

    // Checkbox auto-save + batch chip navigation handled by delegation on #bp-tasks-inner (see initDelegation)
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
    _measSharedDate = todayStr();
    _measMultiData = {};
    _measFilterText = '';

    var html = '<div class="bp-panel-inner bp-meas-wrap">';

    // Header: shared date + filter
    html += '<div class="bp-meas-header-row">';
    html += '<div class="bp-meas-date-group">';
    html += '<label class="bp-meas-date-label">Date</label>';
    html += '<input type="date" id="bp-meas-shared-date" class="bp-inline-input" value="' + todayStr() + '">';
    html += '</div>';
    html += '<input type="search" id="bp-meas-filter" class="bp-inline-input bp-meas-filter-input" placeholder="Filter batches\u2026" autocomplete="off">';
    html += '</div>';

    // Batch grid
    html += '<div class="bp-meas-grid-wrap" id="bp-meas-grid-wrap">';
    html += renderMeasGrid();
    html += '</div>';

    // Submit footer
    html += '<div class="bp-meas-footer">';
    html += '<button type="button" class="btn" id="bp-meas-submit-all" disabled>Submit Readings</button>';
    html += '<span class="bp-meas-footer-count" id="bp-meas-submit-count"></span>';
    html += '</div>';

    html += '</div>';
    inner.innerHTML = html;

    bindMeasEvents();
  }

  function getMeasSortVal(b) {
    if (_measSortCol === 'location') return (String(b.shelf_id || '') + String(b.bin_id || '')).toLowerCase();
    return String(b[_measSortCol] || '').toLowerCase();
  }

  function renderMeasGrid() {
    // Sorted copy — filtering is done via CSS display toggle later
    var batches = _measBatches.slice().sort(function (a, b) {
      var av = getMeasSortVal(a);
      var bv = getMeasSortVal(b);
      return av < bv ? -_measSortDir : av > bv ? _measSortDir : 0;
    });

    if (batches.length === 0) {
      return '<p class="bp-empty">No active batches.</p>';
    }

    function measSortIcon(col) {
      if (_measSortCol !== col) return '<span class="bp-sort-icon">&#8645;</span>';
      return '<span class="bp-sort-icon">' + (_measSortDir === 1 ? '&#8593;' : '&#8595;') + '</span>';
    }

    var html = '<table class="bp-meas-multi-table"><thead><tr>';
    html += '<th class="bp-meas-col-id bp-sort-th' + (_measSortCol === 'batch_id' ? ' bp-sort-active' : '') + '" data-sort="batch_id">Batch ' + measSortIcon('batch_id') + '</th>';
    html += '<th class="bp-meas-col-product bp-sort-th' + (_measSortCol === 'product_name' ? ' bp-sort-active' : '') + '" data-sort="product_name">Product ' + measSortIcon('product_name') + '</th>';
    html += '<th class="bp-meas-col-loc">' +
      '<span class="bp-sort-th' + (_measSortCol === 'vessel_id' ? ' bp-sort-active' : '') + '" data-sort="vessel_id">Vessel' + measSortIcon('vessel_id') + '</span>' +
      '<span class="bp-sort-sep"> / </span>' +
      '<span class="bp-sort-th' + (_measSortCol === 'location' ? ' bp-sort-active' : '') + '" data-sort="location">Loc' + measSortIcon('location') + '</span>' +
      '</th>';
    html += '<th class="bp-meas-col-num">&deg;P</th>';
    html += '<th class="bp-meas-col-num">Temp&deg;C</th>';
    html += '<th class="bp-meas-col-num">pH</th>';
    html += '<th class="bp-meas-col-notes">Notes</th>';
    html += '</tr></thead><tbody>';

    batches.forEach(function (b) {
      var saved = _measMultiData[b.batch_id] || {};
      var loc = b.vessel_id || '\u2014';
      if (b.shelf_id || b.bin_id) loc += ' ' + [b.shelf_id, b.bin_id].filter(Boolean).join('-');
      html += '<tr class="bp-meas-multi-row" data-batch-id="' + escapeHTML(b.batch_id) + '">';
      html += '<td class="bp-meas-col-id"><button type="button" class="bp-batch-chip" data-batch-id="' +
        escapeHTML(b.batch_id) + '" title="Open in Batches tab">' + escapeHTML(b.batch_id) + '</button></td>';
      html += '<td class="bp-meas-col-product">' + escapeHTML(b.product_name || b.product_sku || '\u2014') + '</td>';
      html += '<td class="bp-meas-col-loc">' + escapeHTML(loc) + '</td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-plato" step="0.1" max="40" placeholder="\u2014" value="' + escapeHTML(saved.plato || '') + '"></td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-temp" step="0.1" placeholder="\u2014" value="' + escapeHTML(saved.temp || '') + '"></td>';
      html += '<td class="bp-meas-col-num"><input type="number" inputmode="decimal" class="bp-meas-cell bp-meas-cell-ph" step="0.01" min="0" max="14" placeholder="\u2014" value="' + escapeHTML(saved.ph || '') + '"></td>';
      html += '<td class="bp-meas-col-notes"><input type="text" class="bp-meas-cell bp-meas-cell-notes" placeholder="optional" value="' + escapeHTML(saved.notes || '') + '"></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    html += '<p class="bp-empty" id="bp-meas-grid-empty" style="display:none;">No batches match filter.</p>';
    return html;
  }

  function bindMeasEvents() {
    var dateInput = document.getElementById('bp-meas-shared-date');
    if (dateInput) {
      dateInput.addEventListener('change', function () { _measSharedDate = dateInput.value; });
    }

    var filterInput = document.getElementById('bp-meas-filter');
    if (filterInput) {
      filterInput.addEventListener('input', function () {
        clearTimeout(_measFilterTimer);
        _measFilterTimer = setTimeout(function () {
          // Filter by toggling row visibility — DOM stays intact, inputs keep their values
          var lower = filterInput.value.toLowerCase().trim();
          var anyVisible = false;
          Array.prototype.forEach.call(
            document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
            function (row) {
              var batchId = row.getAttribute('data-batch-id');
              var b = null;
              for (var fi = 0; fi < _measBatches.length; fi++) {
                if (_measBatches[fi].batch_id === batchId) { b = _measBatches[fi]; break; }
              }
              var match = !lower || (b && (String(b.batch_id || '') + ' ' + String(b.product_name || '') + ' ' +
                String(b.vessel_id || '') + ' ' + String(b.shelf_id || '') + ' ' + String(b.bin_id || '')).toLowerCase().indexOf(lower) !== -1);
              row.style.display = match ? '' : 'none';
              if (match) anyVisible = true;
            }
          );
          // Show "no match" empty message if nothing visible
          var emptyMsg = document.getElementById('bp-meas-grid-empty');
          if (emptyMsg) emptyMsg.style.display = anyVisible ? 'none' : '';
          updateMeasSubmitCount();
        }, 150);
      });
    }

    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) submitBtn.addEventListener('click', submitMultiBatchReadings);

    // Meas cell input + batch chip clicks handled by delegation on #bp-measurements-inner (see initDelegation)
  }

  function saveMeasGridValues() {
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var batchId = row.getAttribute('data-batch-id');
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        var notes = (row.querySelector('.bp-meas-cell-notes') || {}).value || '';
        if (plato || temp || ph || notes) {
          _measMultiData[batchId] = { plato: plato, temp: temp, ph: ph, notes: notes };
        } else {
          delete _measMultiData[batchId];
        }
      }
    );
  }

  function updateMeasSubmitCount() {
    var count = 0;
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        if (plato || temp || ph) count++;
      }
    );
    var countEl = document.getElementById('bp-meas-submit-count');
    if (countEl) countEl.textContent = count > 0 ? count + ' batch' + (count !== 1 ? 'es' : '') + ' with readings' : '';
    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) submitBtn.disabled = count === 0;
  }

  function submitMultiBatchReadings() {
    var date = (document.getElementById('bp-meas-shared-date') || {}).value || todayStr();
    var entries = [];
    Array.prototype.forEach.call(
      document.querySelectorAll('.bp-meas-multi-row[data-batch-id]'),
      function (row) {
        var batchId = row.getAttribute('data-batch-id');
        var plato = (row.querySelector('.bp-meas-cell-plato') || {}).value || '';
        var temp  = (row.querySelector('.bp-meas-cell-temp')  || {}).value || '';
        var ph    = (row.querySelector('.bp-meas-cell-ph')    || {}).value || '';
        var notes = (row.querySelector('.bp-meas-cell-notes') || {}).value || '';
        if (!plato && !temp && !ph) return;
        var reading = { timestamp: date };
        if (plato !== '') reading.degrees_plato = parseFloat(plato);
        if (temp  !== '') reading.temperature   = parseFloat(temp);
        if (ph    !== '') reading.ph            = parseFloat(ph);
        if (notes) reading.notes = notes;
        entries.push({ batchId: batchId, reading: reading });
      }
    );

    if (!entries.length) { showToast('No measurements to submit', 'error'); return; }

    var submitBtn = document.getElementById('bp-meas-submit-all');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting\u2026'; }

    var measTimeout = setTimeout(function () {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Readings'; }
      showToast('Request timed out', 'error');
    }, 60000);

    // One API call per batch (bulk_add_plato_readings is per-batch)
    var promises = entries.map(function (entry) {
      return adminApiPost('bulk_add_plato_readings', {
        batch_id: entry.batchId,
        readings: [entry.reading]
      });
    });

    Promise.allSettled(promises)
      .then(function (results) {
        clearTimeout(measTimeout);
        var succeeded = [];
        var failed = [];
        results.forEach(function (r, i) {
          if (r.status === 'fulfilled') {
            succeeded.push(entries[i]);
          } else {
            failed.push(entries[i]);
          }
        });

        // Clear cells only for batches that succeeded
        succeeded.forEach(function (entry) {
          var row = document.querySelector('.bp-meas-multi-row[data-batch-id="' + entry.batchId + '"]');
          if (row) {
            Array.prototype.forEach.call(row.querySelectorAll('.bp-meas-cell'), function (inp) { inp.value = ''; });
            row.classList.remove('bp-meas-row--error');
          }
        });

        // Highlight rows that failed
        failed.forEach(function (entry) {
          var row = document.querySelector('.bp-meas-multi-row[data-batch-id="' + entry.batchId + '"]');
          if (row) row.classList.add('bp-meas-row--error');
        });

        if (failed.length === 0) {
          if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
          showToast(succeeded.length + ' batch' + (succeeded.length !== 1 ? 'es' : '') + ' recorded', 'success');
          if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submit Readings'; }
          var countEl = document.getElementById('bp-meas-submit-count');
          if (countEl) countEl.textContent = '';
        } else if (succeeded.length === 0) {
          showToast('All submissions failed \u2014 check connection', 'error');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Readings'; }
        } else {
          showToast(succeeded.length + ' of ' + entries.length + ' recorded. ' + failed.length + ' failed \u2014 highlighted in red.', 'warn');
          if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Retry Failed'; }
        }
        _measMultiData = {};
      });
  }

  // ===== Event Delegation (one-time setup) =====

  function initDelegation() {
    // Dashboard: pipeline tile + workload day clicks
    var dashInner = document.getElementById('bp-dashboard-inner');
    if (dashInner) {
      dashInner.addEventListener('click', function (e) {
        var tile = e.target.closest('.bp-pipeline-tile');
        if (tile) {
          _batchStatusFilter = tile.getAttribute('data-status');
          _batchSearch = '';
          _batchesLoaded = false;
          switchTab('batches');
          return;
        }
        var batchRow = e.target.closest('tr[data-batch-id]');
        if (batchRow) {
          switchTab('batches');
          selectBatch(batchRow.getAttribute('data-batch-id'));
          return;
        }
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (chip) {
          switchTab('batches');
          selectBatch(chip.getAttribute('data-batch-id'));
          return;
        }
        var day = e.target.closest('.bp-wl-day');
        if (day) {
          var date = day.getAttribute('data-date');
          _dashExpandedDay = (_dashExpandedDay === date) ? null : date;
          renderDashboard();
          return;
        }
      });
      dashInner.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          adminApiPost('bulk_update_batch_tasks', { tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 1500);
      });
    }

    // Batch list: filter button + batch card clicks
    var batchListPane = document.getElementById('bp-batch-list-pane');
    if (batchListPane) {
      batchListPane.addEventListener('click', function (e) {
        var filterBtn = e.target.closest('.bp-filter-btn');
        if (filterBtn) {
          _batchStatusFilter = filterBtn.getAttribute('data-status');
          _batchesData = filterBatchesByStatus(_allBatchesData, _batchStatusFilter);
          renderBatchList();
          return;
        }
        if (e.target.closest('#bp-batch-view-toggle')) {
          _batchViewMode = (_batchViewMode === 'cards') ? 'table' : 'cards';
          renderBatchList();
          return;
        }
        var sortTh = e.target.closest('th[data-sort]');
        if (sortTh) {
          var col = sortTh.getAttribute('data-sort');
          _batchTableSortDir = (_batchTableSortCol === col) ? -_batchTableSortDir : 1;
          _batchTableSortCol = col;
          renderBatchList();
          return;
        }
        var card = e.target.closest('.bp-batch-card');
        if (card) { selectBatch(card.getAttribute('data-batch-id')); return; }
        var row = e.target.closest('tr[data-batch-id]');
        if (row) selectBatch(row.getAttribute('data-batch-id'));
      });
    }

    // Tasks tab: checkbox auto-save + batch chip navigation
    var tasksInner = document.getElementById('bp-tasks-inner');
    if (tasksInner) {
      tasksInner.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          adminApiPost('bulk_update_batch_tasks', { tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 1500);
      });
      tasksInner.addEventListener('click', function (e) {
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (!chip) return;
        e.stopPropagation();
        switchTab('batches');
        selectBatch(chip.getAttribute('data-batch-id'));
      });
    }

    // Measurements: meas cell input + batch chip navigation + sort headers
    // Delegate on #bp-measurements-inner (stable) since #bp-meas-grid-wrap is dynamically created
    var measInner = document.getElementById('bp-measurements-inner');
    if (measInner) {
      measInner.addEventListener('input', function (e) {
        if (e.target.classList.contains('bp-meas-cell')) updateMeasSubmitCount();
      });
      measInner.addEventListener('click', function (e) {
        var th = e.target.closest('[data-sort]');
        if (th) {
          var col = th.getAttribute('data-sort');
          _measSortDir = (_measSortCol === col) ? -_measSortDir : 1;
          _measSortCol = col;
          saveMeasGridValues();
          var gridWrap = document.getElementById('bp-meas-grid-wrap');
          if (gridWrap) gridWrap.innerHTML = renderMeasGrid();
          updateMeasSubmitCount();
          return;
        }
        var chip = e.target.closest('.bp-batch-chip[data-batch-id]');
        if (!chip) return;
        e.stopPropagation();
        switchTab('batches');
        selectBatch(chip.getAttribute('data-batch-id'));
      });
    }

    // Detail pane: task checkbox auto-save + staging remove buttons
    var detailPane = document.getElementById('bp-batch-detail-pane');
    if (detailPane) {
      detailPane.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox' || !cb.hasAttribute('data-task-id')) return;
        if (!cb.closest('#bp-detail-tasks')) return;
        var taskId = cb.getAttribute('data-task-id');
        var checked = cb.checked;
        if (navigator.vibrate) navigator.vibrate(checked ? [40, 20, 60] : 20);
        var row = cb.closest('.bp-task-row');
        if (row) row.classList.toggle('bp-task-row--done', checked);
        if (row) row.setAttribute('data-save-state', 'saving');
        clearTimeout(_taskSaveTimers[taskId]);
        _taskSaveTimers[taskId] = setTimeout(function () {
          delete _taskSaveTimers[taskId];
          adminApiPost('bulk_update_batch_tasks', { tasks: [{ task_id: taskId, updates: { completed: checked } }] })
            .then(function () {
              for (var i = 0; i < _upcomingTasks.length; i++) {
                if (_upcomingTasks[i].task_id === taskId) {
                  _upcomingTasks[i].completed = checked ? 'TRUE' : 'FALSE';
                  break;
                }
              }
              if (row) {
                row.setAttribute('data-save-state', 'saved');
                setTimeout(function () { if (row) row.removeAttribute('data-save-state'); }, 1500);
              }
            })
            .catch(function () {
              cb.checked = !checked;
              if (row) row.classList.toggle('bp-task-row--done', !checked);
              if (row) row.setAttribute('data-save-state', 'error');
              showToast('Save failed \u2014 try again', 'error');
            });
        }, 1500);
      });
      detailPane.addEventListener('click', function (e) {
        var removeBtn = e.target.closest('.bp-staging-remove');
        if (removeBtn) {
          var idx = parseInt(removeBtn.getAttribute('data-idx'), 10);
          _detailPlatoStaging.splice(idx, 1);
          var wrap = document.getElementById('bp-detail-staging-wrap');
          if (wrap) {
            wrap.innerHTML = renderDetailStagingTable();
            bindDetailStagingHandlers(_detailBatchId);
          }
          return;
        }

        var delBtn = e.target.closest('.bp-reading-del');
        if (delBtn) {
          var idx = parseInt(delBtn.getAttribute('data-idx'), 10);
          var r = _detailPlatoReadings[idx];
          if (!r) return;
          showConfirmSheet('Delete reading from ' + fmtDate(r.timestamp) + '?', 'Delete', 'bp-confirm-btn--danger', function () {
            adminApiPost('delete_plato_reading', { reading_id: r.reading_id })
              .then(function () {
                _detailPlatoReadings.splice(idx, 1);
                _chartCache = {};
                var el = document.getElementById('bp-detail-readings');
                if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
                bindDetailReadingHandlers(_detailBatchId);
                showToast('Reading deleted', 'success');
              })
              .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          });
          return;
        }

        var editBtn = e.target.closest('.bp-reading-edit');
        if (editBtn) {
          var idx = parseInt(editBtn.getAttribute('data-idx'), 10);
          openReadingEditRow(idx);
          return;
        }

        var saveEditBtn = e.target.closest('.bp-reading-save-edit');
        if (saveEditBtn) {
          var idx = parseInt(saveEditBtn.getAttribute('data-idx'), 10);
          var r = _detailPlatoReadings[idx];
          if (!r) return;
          var updates = {};
          var dateVal = (document.getElementById('re-date') || {}).value;
          var platoVal = (document.getElementById('re-plato') || {}).value;
          var tempVal = (document.getElementById('re-temp') || {}).value;
          var phVal = (document.getElementById('re-ph') || {}).value;
          var notesVal = (document.getElementById('re-notes') || {}).value;
          if (dateVal) updates.timestamp = dateVal;
          if (platoVal !== '') updates.degrees_plato = parseFloat(platoVal);
          if (tempVal !== '') updates.temperature = parseFloat(tempVal);
          if (phVal !== '') updates.ph = parseFloat(phVal);
          updates.notes = notesVal;
          adminApiPost('update_plato_reading', { reading_id: r.reading_id, updates: updates })
            .then(function () {
              for (var k in updates) { if (Object.prototype.hasOwnProperty.call(updates, k)) r[k] = updates[k]; }
              _chartCache = {};
              var el = document.getElementById('bp-detail-readings');
              if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
              bindDetailReadingHandlers(_detailBatchId);
              showToast('Reading updated', 'success');
            })
            .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
          return;
        }

        var cancelEditBtn = e.target.closest('.bp-reading-cancel-edit');
        if (cancelEditBtn) {
          var el = document.getElementById('bp-detail-readings');
          if (el) el.innerHTML = renderDetailReadings(_detailPlatoReadings, _detailStartDate);
          bindDetailReadingHandlers(_detailBatchId);
          return;
        }
      });
    }
  }

  // ===== Bootstrap =====

  document.addEventListener('DOMContentLoaded', function () {
    // Wire tab bar
    Array.prototype.forEach.call(document.querySelectorAll('.bp-tab'), function (btn) {
      btn.addEventListener('click', function () {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    initDelegation();

    waitForGoogleIdentity();
  });

})();

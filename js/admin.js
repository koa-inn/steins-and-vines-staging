// ===== Steins & Vines Admin Dashboard =====

(function () {
  'use strict';

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

  // Pending changes queue: [{item, field, value, sheetName, headers}]
  var pendingChanges = [];

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
    // Read Config sheet to get staff_emails
    console.log('[Admin] Checking authorization for:', userEmail);
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
    localStorage.setItem('sv-admin-email', userEmail);
    loadAllData();

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
  }

  // ===== Sheets API Helpers =====

  function sheetsGet(range) {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range);
    return fetch(url, {
      headers: { Authorization: 'Bearer ' + accessToken }
    }).then(function (res) {
      if (!res.ok) throw new Error('Sheets API error: ' + res.status);
      return res.json();
    });
  }

  function sheetsUpdate(range, values) {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range) +
      '?valueInputOption=USER_ENTERED';
    return fetch(url, {
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
  }

  function sheetsAppend(range, values) {
    var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
      SHEETS_CONFIG.SPREADSHEET_ID + '/values/' + encodeURIComponent(range) +
      ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';
    return fetch(url, {
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
  }

  function sheetsBatchUpdate(requests) {
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
  }

  // ===== Load All Data =====

  function loadAllData() {
    Promise.all([
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.KITS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!A:Z'),
      sheetsGet(SHEETS_CONFIG.SHEET_NAMES.HOLDS + '!A:Z')
    ]).then(function (results) {
      parseSheetData(results[0], 'kits');
      parseSheetData(results[1], 'ingredients');
      parseSheetData(results[2], 'reservations');
      parseSheetData(results[3], 'holds');

      renderReservationsTab();
      renderKitsTab();
      renderIngredientsTab();
      populateKitBrandFilter();
      populateOrderKitSelect();
      populateOrderBrandFilter();
      renderOrderTab();
    }).catch(function (err) {
      console.error('Failed to load data:', err);
    });
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
    if (resFilter) resFilter.addEventListener('change', renderReservationsTab);

    var kitSearch = document.getElementById('kit-search');
    if (kitSearch) kitSearch.addEventListener('input', renderKitsTab);

    var kitBrandFilter = document.getElementById('kit-brand-filter');
    if (kitBrandFilter) kitBrandFilter.addEventListener('change', renderKitsTab);

    var kitStockFilter = document.getElementById('kit-stock-filter');
    if (kitStockFilter) kitStockFilter.addEventListener('change', renderKitsTab);

    initKitSortHeaders();

    var ingCatFilter = document.getElementById('ing-category-filter');
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
    if (filterVal !== 'all') {
      filtered = reservationsData.filter(function (r) {
        return (r.status || '').toLowerCase() === filterVal;
      });
    }

    // Sort newest first by submitted_at
    filtered.sort(function (a, b) {
      return (b.submitted_at || '').localeCompare(a.submitted_at || '');
    });

    tbody.innerHTML = '';

    if (filtered.length === 0) {
      emptyMsg.style.display = '';
      document.getElementById('reservations-table').style.display = 'none';
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
      appendTd(tr, (res.customer_name || '') + (res.customer_email ? ' (' + res.customer_email + ')' : ''));
      appendTd(tr, res.products || '');
      appendTd(tr, res.timeslot || '');

      var statusTd = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'hold-badge hold-badge--' + (res.status || 'pending').toLowerCase();
      badge.textContent = res.status || 'pending';
      statusTd.appendChild(badge);
      tr.appendChild(statusTd);

      appendTd(tr, res.submitted_at || '');

      var actionsTd = document.createElement('td');
      if ((res.status || '').toLowerCase() === 'pending' && resHolds.length > 0) {
        var confirmAllBtn = document.createElement('button');
        confirmAllBtn.type = 'button';
        confirmAllBtn.className = 'btn admin-btn-sm';
        confirmAllBtn.textContent = 'Confirm All';
        confirmAllBtn.addEventListener('click', (function (reservation, holds) {
          return function () { confirmAllHolds(reservation, holds); };
        })(res, resHolds));
        actionsTd.appendChild(confirmAllBtn);
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
        appendTd(htr, hold.product_name || '');
        appendTd(htr, 'SKU: ' + (hold.sku || ''));
        appendTd(htr, 'Qty: ' + (hold.qty || ''));

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

    var updates = [];

    // Update hold status to "confirmed"
    var holdStatusCol = holdsHeaders.indexOf('status');
    var holdResolvedAtCol = holdsHeaders.indexOf('resolved_at');
    var holdResolvedByCol = holdsHeaders.indexOf('resolved_by');
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
      checkReservationStatus(reservation);
      renderReservationsTab();
      renderKitsTab();
    }).catch(function (err) {
      alert('Failed to confirm hold: ' + err.message);
    });
  }

  function releaseHold(hold, reservation) {
    var qty = parseInt(hold.qty, 10) || 0;
    var holdRow = hold._rowIndex;

    var kit = kitsData.find(function (k) { return k.sku === hold.sku; });

    var updates = [];

    var holdStatusCol = holdsHeaders.indexOf('status');
    var holdResolvedAtCol = holdsHeaders.indexOf('resolved_at');
    var holdResolvedByCol = holdsHeaders.indexOf('resolved_by');
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
      checkReservationStatus(reservation);
      renderReservationsTab();
      renderKitsTab();
    }).catch(function (err) {
      alert('Failed to release hold: ' + err.message);
    });
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
      reservation.status = newStatus;
      var statusCol = reservationsHeaders.indexOf('status');
      if (statusCol !== -1) {
        sheetsUpdate(
          SHEETS_CONFIG.SHEET_NAMES.RESERVATIONS + '!' + colLetter(statusCol) + reservation._rowIndex,
          [[newStatus]]
        );
      }
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

      appendTd(tr, kit.retail_instore || '');
      appendTd(tr, kit.retail_kit || '');

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
      var notes = document.getElementById('hold-notes').value.trim();

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
          alert('Failed to place hold: ' + err.message);
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
      alert('Failed to save changes: ' + err.message);
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
        if (el) return el.value;
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
          alert('Failed to add kit: ' + err.message);
        });
    });
  }

  // ===== Ingredients Tab =====

  function renderIngredientsTab() {
    var tbody = document.getElementById('ingredients-tbody');
    var emptyMsg = document.getElementById('ingredients-empty');
    if (!tbody) return;

    var catFilter = document.getElementById('ing-category-filter').value;
    var filtered = ingredientsData;
    if (catFilter !== 'all') {
      filtered = ingredientsData.filter(function (ing) {
        return ing.category === catFilter;
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

      var stockQty = parseFloat(ing.stock_qty) || 0;
      var reorderLevel = parseFloat(ing.reorder_level) || 0;
      if (stockQty <= reorderLevel) {
        tr.className = 'admin-row-warning';
      }

      appendTd(tr, ing.id || '');
      appendTd(tr, ing.category || '');
      appendTd(tr, ing.name || '');

      // Editable stock cell
      var stockTd = document.createElement('td');
      stockTd.className = 'admin-editable';
      stockTd.textContent = ing.stock_qty || '0';
      stockTd.addEventListener('click', (function (cell, item) {
        return function () { startInlineEdit(cell, item, 'stock_qty'); };
      })(stockTd, ing));
      tr.appendChild(stockTd);

      appendTd(tr, ing.unit || '');
      appendTd(tr, ing.reorder_level || '');
      appendTd(tr, ing.supplier || '');
      appendTd(tr, ing.cost || '');

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
        alert('Failed to delete: ' + err.message);
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

    var nextId = 'ING-' + String(ingredientsData.length + 1).padStart(3, '0');

    var html = '<form id="add-ing-form" class="admin-modal-form">';
    html += '<div class="form-group"><label for="ing-id">ID</label><input type="text" id="ing-id" value="' + nextId + '"></div>';
    html += '<div class="form-group"><label for="ing-category">Category</label><select id="ing-category" class="admin-select">';
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
        if (el) return el.value;
        if (h === 'last_updated') return new Date().toISOString();
        return '';
      });

      sheetsAppend(SHEETS_CONFIG.SHEET_NAMES.INGREDIENTS + '!A:A', [row])
        .then(function () {
          closeModal();
          loadAllData();
        })
        .catch(function (err) {
          alert('Failed to add ingredient: ' + err.message);
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
    if (searchInput) searchInput.addEventListener('input', renderOrderTab);

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

  var MULTIPLES_OF_TWO_BRANDS = ['Heritage Estates', 'Orchard Breezin\''];

  function requiresMultiplesOfTwo(brand) {
    return MULTIPLES_OF_TWO_BRANDS.indexOf(brand) !== -1;
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
        renderOrderTab();
        return;
      }
    }
    order.push({ sku: sku, brand: brand, name: name, qty: qty });
    saveOrder(order);
    populateOrderBrandFilter();
    renderOrderTab();
  }

  function removeFromOrder(sku) {
    var order = getOrder().filter(function (item) { return item.sku !== sku; });
    saveOrder(order);
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
        var aCost = aKit && aKit.wholesale ? parseFloat(aKit.wholesale.replace(/[^0-9.\-]/g, '')) || 0 : 0;
        var bCost = bKit && bKit.wholesale ? parseFloat(bKit.wholesale.replace(/[^0-9.\-]/g, '')) || 0 : 0;
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
      appendTd(tr, item.name || '');

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
        costStr = kit.wholesale;
        unitCost = parseFloat(kit.wholesale.replace(/[^0-9.\-]/g, '')) || 0;
      }
      var lineTotal = unitCost * item.qty;
      orderTotal += lineTotal;
      appendTd(tr, costStr);
      appendTd(tr, '$' + lineTotal.toFixed(2));

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
    if (order.length === 0) { alert('Order is empty.'); return; }

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
    if (order.length === 0) { alert('Order is empty.'); return; }

    // Determine which SKUs are checked
    var checkedSkus = {};
    var cbs = document.querySelectorAll('.order-item-cb:checked');
    for (var i = 0; i < cbs.length; i++) {
      checkedSkus[cbs[i].getAttribute('data-sku')] = true;
    }

    var acceptedItems = order.filter(function (item) { return checkedSkus[item.sku]; });
    var remainingItems = order.filter(function (item) { return !checkedSkus[item.sku]; });

    if (acceptedItems.length === 0) { alert('No items selected.'); return; }

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

      // Subtract from on_order
      var onOrderCol = kitsHeaders.indexOf('on_order');
      if (onOrderCol !== -1) {
        var currentOnOrder = parseInt(kit.on_order, 10) || 0;
        var newOnOrder = Math.max(0, currentOnOrder - item.qty);
        var onOrderRange = SHEETS_CONFIG.SHEET_NAMES.KITS + '!' + colLetter(onOrderCol) + kit._rowIndex;
        updates.push(sheetsUpdate(onOrderRange, [[newOnOrder]]));
        kit.on_order = String(newOnOrder);
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
      alert('Delivery accepted. Stock updated for ' + acceptedItems.length + ' item(s).' + (remainingItems.length > 0 ? ' ' + remainingItems.length + ' item(s) remain in the order.' : ''));
    }).catch(function (err) {
      if (acceptBtn) { acceptBtn.disabled = false; acceptBtn.textContent = 'Accept Delivery'; }
      alert('Failed to update stock: ' + err.message);
    });
  }

  function clearOrder() {
    if (!confirm('Clear the entire order? This cannot be undone.')) return;
    saveOrder([]);
    renderOrderTab();
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
        if (!sku) { alert('Type and select a kit first.'); return; }
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
  }

  // ===== Export =====

  function initExportButtons() {
    document.addEventListener('DOMContentLoaded', function () {
      var exportKitsBtn = document.getElementById('export-kits-btn');
      if (exportKitsBtn) exportKitsBtn.addEventListener('click', exportKitsCSV);

      var exportIngBtn = document.getElementById('export-ingredients-btn');
      if (exportIngBtn) exportIngBtn.addEventListener('click', exportIngredientsCSV);
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
      if (lines.length < 2) { alert('CSV file is empty or has no data rows.'); return; }

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
        alert('Import applied successfully.');
        cancelImport();
        loadAllData();
      })
      .catch(function (err) {
        alert('Import failed: ' + err.message);
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

})();

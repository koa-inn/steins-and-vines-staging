// ===== Steins & Vines In-Store POS (Standalone Kiosk) =====
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

  // ===== Persistent Session =====
  var SESSION_KEY = 'sv-kiosk-session';

  function saveSession(token, expiresIn, email) {
    var data = {
      token: token,
      expires_at: Date.now() + (expiresIn * 1000),
      email: email
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      // Expired if within 5 minutes of expiry
      if (data.expires_at < Date.now() + 5 * 60 * 1000) return null;
      return data;
    } catch (e) { return null; }
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }

  // ===== Toast Notification System =====

  function showToast(message, type, opts) {
    if (!type) type = 'info';
    if (!opts) opts = {};
    var container = document.getElementById('kiosk-toast-container');
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

    var signoutBtn = document.getElementById('kiosk-signout');
    if (signoutBtn) signoutBtn.addEventListener('click', kioskSignOut);

    // Try restoring a saved session via silent token refresh
    var saved = loadSession();
    if (saved) {
      console.log('[Kiosk] Attempting silent token refresh for', saved.email);
      _silentRefreshTimer = setTimeout(function () {
        _silentRefreshTimer = null;
        console.warn('[Kiosk] Silent refresh timed out — showing sign-in button');
        clearSession();
        showSignInButton();
      }, 5000);
      try {
        tokenClient.requestAccessToken({ prompt: '', login_hint: saved.email });
      } catch (err) {
        clearTimeout(_silentRefreshTimer);
        _silentRefreshTimer = null;
        console.warn('[Kiosk] Silent refresh failed:', err.message);
        clearSession();
        showSignInButton();
      }
      return;
    }

    showSignInButton();
  }

  function showSignInButton() {
    var signinBtn = document.getElementById('kiosk-google-signin-btn');
    if (signinBtn && !signinBtn.querySelector('button')) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Sign in with Google';
      btn.addEventListener('click', function () {
        tokenClient.requestAccessToken();
      });
      signinBtn.appendChild(btn);
    }
  }

  function onTokenResponse(response) {
    if (_silentRefreshTimer) { clearTimeout(_silentRefreshTimer); _silentRefreshTimer = null; }
    _handlingUnauthorized = false;
    if (response.error) {
      console.warn('[Kiosk] Token response error:', response.error);
      clearSession();
      showSignInButton();
      return;
    }
    accessToken = response.access_token;
    var expiresIn = response.expires_in || 3600;

    // Get user info
    fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + accessToken }
    })
      .then(function (res) { return res.json(); })
      .then(function (info) {
        userEmail = info.email;
        saveSession(accessToken, expiresIn, userEmail);
        kioskCheckAuthorization();
      })
      .catch(function () {
        showKioskDenied();
      });
  }

  function kioskCheckAuthorization() {
    console.log('[Kiosk] Checking authorization for:', userEmail);

    adminApiGet('check_auth')
      .then(function (result) {
        console.log('[Kiosk] Server auth result:', result);
        if (result.authorized) {
          showKioskApp();
        } else {
          showKioskDenied();
        }
      })
      .catch(function (err) {
        console.error('[Kiosk] Server auth failed:', err.message);
        showKioskDenied();
      });
  }

  function showKioskApp() {
    document.getElementById('kiosk-signin').style.display = 'none';
    document.getElementById('kiosk-app').style.display = '';

    var emailEl = document.getElementById('kiosk-user-email');
    if (emailEl) emailEl.textContent = userEmail;

    var signoutBtn = document.getElementById('kiosk-signout');
    if (signoutBtn) signoutBtn.style.display = '';

    var deniedMsg = document.getElementById('kiosk-denied-msg');
    if (deniedMsg) deniedMsg.style.display = 'none';

    // Set up periodic token refresh (~50 min)
    if (_tokenRefreshTimer) clearInterval(_tokenRefreshTimer);
    _tokenRefreshTimer = setInterval(function () {
      tokenClient.requestAccessToken({ prompt: '' });
    }, 50 * 60 * 1000);

    kioskCheckTerminal();
    kioskLoadProducts();
  }

  function showKioskDenied() {
    var deniedMsg = document.getElementById('kiosk-denied-msg');
    if (deniedMsg) deniedMsg.style.display = '';
  }

  function kioskSignOut() {
    if (_tokenRefreshTimer) { clearInterval(_tokenRefreshTimer); _tokenRefreshTimer = null; }
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken);
    }
    accessToken = null;
    userEmail = null;
    clearSession();

    document.getElementById('kiosk-signin').style.display = '';
    document.getElementById('kiosk-app').style.display = 'none';

    var signoutBtn = document.getElementById('kiosk-signout');
    if (signoutBtn) signoutBtn.style.display = 'none';

    var emailEl = document.getElementById('kiosk-user-email');
    if (emailEl) emailEl.textContent = '';
  }

  function handleUnauthorized() {
    if (_handlingUnauthorized) return;
    _handlingUnauthorized = true;
    if (_tokenRefreshTimer) { clearInterval(_tokenRefreshTimer); _tokenRefreshTimer = null; }
    clearSession();
    accessToken = null;
    userEmail = null;

    document.getElementById('kiosk-signin').style.display = '';
    document.getElementById('kiosk-app').style.display = 'none';

    var signoutBtn = document.getElementById('kiosk-signout');
    if (signoutBtn) signoutBtn.style.display = 'none';

    var emailEl = document.getElementById('kiosk-user-email');
    if (emailEl) emailEl.textContent = '';

    showSignInButton();
  }

  // ===== Admin API Helpers =====

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
        if (isUnauthorizedError(data)) handleUnauthorized();
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
        if (isUnauthorizedError(data)) handleUnauthorized();
        throw new Error(data.message || data.error || 'API error');
      }
      return data;
    });
  }

  // ===== Shared Utilities =====

  // escapeHTML defined in js/lib/utils.js
  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ===== Batch QR + Label =====

  function generateBatchQR(batchId, batchAccessToken) {
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchAccessToken);
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr;
  }

  var LABEL_CSS =
    '@page{size:4in 6in;margin:0;}' +
    'body{margin:0;font-family:Arial,Helvetica,sans-serif;}' +
    '.label{width:4in;height:6in;padding:0.2in 0.25in;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;}' +
    '.top-row{display:flex;align-items:center;justify-content:space-between;padding-bottom:5px;border-bottom:1.5px solid #000;margin-bottom:6px;}' +
    '.logo-stack{display:flex;align-items:center;gap:8px;}' +
    '.logo-icon{height:48px;}' +
    '.logo-wordmark{height:20px;}' +
    '.qr-box{width:72px;height:72px;display:flex;align-items:center;justify-content:center;}' +
    '.qr-box svg{width:72px;height:72px;}' +
    '.qr-empty{width:72px;height:72px;border:1.5px solid #000;}' +
    '.batch-id{font-size:15px;font-weight:bold;text-align:center;margin:2px 0 1px;letter-spacing:1px;}' +
    '.product-name{font-size:11px;text-align:center;font-weight:600;margin-bottom:5px;}' +
    '.info-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:9.5px;line-height:1.5;margin-bottom:4px;}' +
    '.info-grid .lbl{font-weight:bold;text-align:right;white-space:nowrap;}' +
    '.write-line{border-bottom:1px solid #000;min-width:100px;display:inline-block;height:12px;}' +
    '.section-title{font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;border-bottom:0.5px solid #ccc;padding-bottom:1px;}' +
    '.schedule-wrap{min-height:108px;margin-bottom:4px;}' +
    '.schedule-table{width:100%;border-collapse:collapse;font-size:8.5px;line-height:1.4;}' +
    '.schedule-table td{padding:1px 4px 1px 0;vertical-align:top;}' +
    '.schedule-table td:first-child{white-space:nowrap;font-weight:600;width:52px;}' +
    '.schedule-table td:last-child{color:#555;font-size:8px;text-align:right;white-space:nowrap;}' +
    '.notes-box{border:1px solid #999;border-radius:2px;flex:1;min-height:40px;margin:0 0 6px;position:relative;}' +
    '.notes-box-label{position:absolute;top:-1px;left:4px;font-size:7px;font-weight:bold;color:#000;text-transform:uppercase;background:#fff;padding:0 2px;}' +
    '.agreement{flex-shrink:0;border-top:1px solid #999;padding-top:3px;}' +
    '.agreement-title{font-size:7px;font-weight:bold;text-align:center;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;}' +
    '.agreement-text{font-size:6.5px;line-height:1.35;text-align:justify;color:#333;margin-bottom:4px;}' +
    '.sig-area{display:flex;gap:6px;align-items:flex-end;}' +
    '.sig-block{flex:1;}.sig-block .sig-line{border-bottom:1px solid #000;height:14px;}' +
    '.sig-block .sig-label{font-size:6px;text-align:center;margin-top:1px;color:#555;}' +
    '.sig-block.sm{flex:0.4;}' +
    '.email-row{margin-bottom:4px;}.email-row .sig-line{border-bottom:1px solid #000;height:12px;}' +
    '.email-row .sig-label{font-size:6px;margin-top:1px;color:#555;}';

  var AGREEMENT_TEXT = 'By signing, I request assistance and guidance, as required, in preparing my wine must for fermentation. I acknowledge that by default, Steins &amp; Vines will add a natural shell fish derivative, Chitosan, for the purpose of clearing. I consent to my name, telephone number, address and email (if supplied) being kept in a database with the understanding that this information will not be sold or exchanged. I acknowledge that the wine made for me by Steins &amp; Vines is for my personal use only. I acknowledge that Steins &amp; Vines has transferred ownership of my wine and all ingredients to me.';

  function buildBatchLabelHTML(opts) {
    var b = opts.batch || {};
    var tasks = opts.tasks || [];
    var qrSvg = opts.qrSvg || '';
    var isBlank = opts.blank || false;
    var origin = window.location.origin;

    var iconUrl = origin + '/images/label-icon.png';
    var wordmarkUrl = origin + '/images/label-wordmark.png';

    var h = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
    h += '<title>' + (isBlank ? 'Blank Batch Form' : 'Batch ' + escapeHTML(b.batch_id || '')) + '</title>';
    h += '<style>' + LABEL_CSS + '</style></head><body><div class="label">';

    // Top row: logos + QR
    h += '<div class="top-row"><div class="logo-stack">';
    h += '<img class="logo-icon" src="' + iconUrl + '" alt="">';
    h += '<img class="logo-wordmark" src="' + wordmarkUrl + '" alt="">';
    h += '</div>';
    if (qrSvg) {
      h += '<div class="qr-box">' + qrSvg + '</div>';
    } else if (!isBlank) {
      h += '<div class="qr-empty"></div>';
    }
    h += '</div>';

    // Batch ID + Product
    h += '<div class="batch-id">' + (isBlank ? 'Batch ID: <span class="write-line" style="min-width:140px;"></span>' : escapeHTML(b.batch_id || '')) + '</div>';
    h += '<div class="product-name">' + (isBlank ? 'Kit: <span class="write-line" style="min-width:180px;"></span>' : escapeHTML(b.product_name || b.product_sku || '')) + '</div>';

    // Info grid
    h += '<div class="info-grid">';
    h += '<span class="lbl">Customer:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_name || '')) + '</span>';
    h += '<span class="lbl">Email:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_email || '')) + '</span>';
    h += '<span class="lbl">Phone:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_phone || '')) + '</span>';
    h += '<span class="lbl">Start Date:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(String(b.start_date || '').substring(0, 10))) + '</span>';
    var loc = isBlank ? '<span class="write-line"></span>' : escapeHTML([b.shelf_id, b.bin_id, b.vessel_id].filter(Boolean).join(' - ') || '—');
    h += '<span class="lbl">Primary Location:</span><span class="val">' + loc + '</span>';
    h += '<span class="lbl">Transfer 1:</span><span class="val"><span class="write-line"></span></span>';
    h += '<span class="lbl">Transfer 2:</span><span class="val"><span class="write-line"></span></span>';
    h += '<span class="lbl">Transfer 3:</span><span class="val"><span class="write-line"></span></span>';
    h += '</div>';

    // Schedule
    h += '<div class="section-title">Schedule</div>';
    h += '<div class="schedule-wrap"><table class="schedule-table">';

    if (!isBlank && tasks.length > 0) {
      var startMs = b.start_date ? new Date(String(b.start_date).substring(0, 10)).getTime() : 0;
      tasks.forEach(function (t) {
        var dayLabel = '—';
        var dateLabel = '';
        if (t.due_date) {
          var dueStr = String(t.due_date).substring(0, 10);
          dateLabel = dueStr;
          if (startMs) {
            var dayNum = Math.round((new Date(dueStr).getTime() - startMs) / 86400000);
            dayLabel = 'Day ' + (dayNum < 1 ? 1 : dayNum);
          }
        } else {
          dayLabel = 'TBD';
        }
        if (t.step_number === 1 || t.step_number === '1') dayLabel = 'Day 1';
        h += '<tr><td>' + escapeHTML(dayLabel) + '</td>';
        h += '<td>' + escapeHTML(t.title || 'Step ' + t.step_number) + '</td>';
        h += '<td>' + escapeHTML(dateLabel) + '</td></tr>';
      });
    } else {
      h += '<tr><td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;">Day</td>';
      h += '<td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;">Step</td>';
      h += '<td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;text-align:right;">Date</td></tr>';
      for (var i = 0; i < 8; i++) {
        h += '<tr><td style="border-bottom:0.5px solid #ccc;">____</td>';
        h += '<td style="border-bottom:0.5px solid #ccc;">&nbsp;</td>';
        h += '<td style="border-bottom:0.5px solid #ccc;">&nbsp;</td></tr>';
      }
    }
    h += '</table></div>';

    // Notes box
    h += '<div class="notes-box"><span class="notes-box-label">Notes</span></div>';

    // Agreement
    h += '<div class="agreement">';
    h += '<div class="agreement-title">Customer Agreement</div>';
    h += '<div class="agreement-text">' + AGREEMENT_TEXT + '</div>';
    h += '<div class="sig-area">';
    h += '<div class="sig-block"><div class="sig-line"></div><div class="sig-label">Signature</div></div>';
    h += '<div class="sig-block sm"><div class="sig-line"></div><div class="sig-label">Date</div></div>';
    h += '</div></div>';

    h += '</div></body></html>';
    return h;
  }

  // ===== Kiosk Sale State =====

  var _kioskProducts = [];
  var _kioskCart = {};
  var _kioskProductsLoaded = false;
  var _kioskProductsLoading = false;
  var _kioskCurrentView = 'browse';
  var _kioskSaleData = null;
  var _kioskSearchTimer = null;
  var _kioskTerminalReady = false;
  var _kioskCustomer = null; // { contact_id, name, email } or null (walk-in)
  var _kioskHideOutOfStock = false;

  // Customer browse mode state
  var _kioskCbTab = 'kits';
  var _kioskCbSearch = '';
  var _kioskCbSearchTimer = null;

  var MAKERS_FEE = 50; // Added to kit rates for in-store pricing

  // ===== Kiosk Helpers =====

  function kioskMwUrl() {
    return (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL)
      ? SHEETS_CONFIG.MIDDLEWARE_URL : '';
  }

  function kioskFmt(amount) {
    return '$' + (parseFloat(amount) || 0).toFixed(2);
  }

  // Returns item rate including $50 maker's fee for kits
  function kioskEffectiveRate(product) {
    var base = parseFloat(product.rate) || 0;
    return ((product.product_type || '').toLowerCase() === 'kit') ? base + MAKERS_FEE : base;
  }

  // Returns category label for a product, falling back to product_type
  function kioskItemCategory(p) {
    return p.category_name || p.product_type || '';
  }

  function kioskItemTax(item, qty) {
    var rate = kioskEffectiveRate(item);
    var pct = parseFloat(item.tax_percentage) || 0;
    return parseFloat((rate * qty * pct / 100).toFixed(2));
  }

  function kioskCartIsEmpty() {
    return Object.keys(_kioskCart).length === 0;
  }

  function kioskCartHasKits() {
    return Object.keys(_kioskCart).some(function (id) {
      return (_kioskCart[id].item.product_type || '').toLowerCase() === 'kit';
    });
  }

  // ===== Cart Totals =====

  function kioskCalcTotals() {
    var subtotal = 0;
    var taxTotal = 0;
    Object.keys(_kioskCart).forEach(function (id) {
      var entry = _kioskCart[id];
      var qty = entry.qty;
      var rate = kioskEffectiveRate(entry.item);
      subtotal += rate * qty;
      taxTotal += kioskItemTax(entry.item, qty);
    });
    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax: parseFloat(taxTotal.toFixed(2)),
      total: parseFloat((subtotal + taxTotal).toFixed(2))
    };
  }

  // ===== View Switching =====

  function kioskShowView(name) {
    var views = ['browse', 'browse-customer', 'customer', 'payment', 'review-batches', 'receipt', 'error'];
    views.forEach(function (v) {
      var el = document.getElementById('kiosk-view-' + v);
      if (el) el.style.display = (v === name) ? '' : 'none';
    });
    _kioskCurrentView = name;
  }

  // ===== Terminal Status Bar =====

  function kioskSetTerminalStatus(ready, msg) {
    _kioskTerminalReady = ready;
    var dot = document.getElementById('kiosk-terminal-dot');
    var label = document.getElementById('kiosk-terminal-label');
    if (!dot || !label) return;
    dot.className = 'kiosk-terminal-dot' +
      (ready ? ' kiosk-terminal-dot--ready' :
       (msg.indexOf('not configured') !== -1 ? ' kiosk-terminal-dot--error' : ' kiosk-terminal-dot--warn'));
    label.textContent = msg;
  }

  function kioskCheckTerminal() {
    var mwUrl = kioskMwUrl();
    if (!mwUrl) {
      kioskSetTerminalStatus(false, 'Terminal: middleware not configured');
      return;
    }
    fetch(mwUrl + '/api/pos/status')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.enabled) {
          kioskSetTerminalStatus(true, 'Terminal ready (' + (data.terminal_type || 'UPA') + ')');
        } else {
          var d = data.diagnostics || {};
          var msg = 'Terminal not enabled';
          if (!d.GP_APP_KEY_SET) msg = 'Terminal: GP_APP_KEY not set in Railway';
          else if (!d.GP_TERMINAL_ENABLED) msg = 'Terminal: GP_TERMINAL_ENABLED not set';
          else if (d.init_error) msg = 'Terminal init error: ' + d.init_error;
          else msg = 'Terminal: device not initialized';
          kioskSetTerminalStatus(false, msg);
        }
      })
      .catch(function () {
        kioskSetTerminalStatus(false, 'Terminal: middleware unreachable');
      });
  }

  // ===== Load Products =====

  function kioskLoadProducts(forceRefresh) {
    if (_kioskProductsLoading) return;
    if (_kioskProductsLoaded && !forceRefresh) {
      kioskRenderProducts();
      return;
    }

    var mwUrl = kioskMwUrl();
    if (!mwUrl) {
      var grid = document.getElementById('kiosk-product-grid');
      if (grid) grid.innerHTML = '<p class="kiosk-loading">Middleware URL not configured.</p>';
      return;
    }

    _kioskProductsLoading = true;
    var grid = document.getElementById('kiosk-product-grid');
    if (grid) grid.innerHTML = '<p class="kiosk-loading">Loading products...</p>';

    fetch(mwUrl + '/api/kiosk/products')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _kioskProducts = data.items || [];
        _kioskProductsLoaded = true;
        _kioskProductsLoading = false;
        kioskPopulateCategories();
        kioskRenderProducts();
      })
      .catch(function (err) {
        _kioskProductsLoading = false;
        var grid2 = document.getElementById('kiosk-product-grid');
        if (grid2) grid2.innerHTML = '<p class="kiosk-loading">Failed to load products: ' + err.message + '</p>';
      });
  }

  function kioskPopulateCategories() {
    var sel = document.getElementById('kiosk-category-filter');
    if (!sel) return;

    var cats = {};
    _kioskProducts.forEach(function (p) {
      var cat = kioskItemCategory(p);
      if (cat) cats[cat] = true;
    });

    while (sel.options.length > 1) sel.remove(1);

    Object.keys(cats).sort().forEach(function (cat) {
      var opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      sel.appendChild(opt);
    });
  }

  // ===== Render Product Grid =====

  function kioskRenderProducts() {
    var grid = document.getElementById('kiosk-product-grid');
    if (!grid) return;

    var searchTerm = (document.getElementById('kiosk-search') || {}).value || '';
    searchTerm = searchTerm.toLowerCase().trim();

    var catFilter = (document.getElementById('kiosk-category-filter') || {}).value || '';

    var filtered = _kioskProducts.filter(function (p) {
      if (_kioskHideOutOfStock && (parseFloat(p.stock_on_hand) || 0) <= 0) return false;
      var cat = kioskItemCategory(p);
      if (catFilter && cat.toLowerCase() !== catFilter.toLowerCase()) return false;
      if (searchTerm) {
        var haystack = ((p.name || '') + ' ' + (p.sku || '') + ' ' + cat).toLowerCase();
        if (haystack.indexOf(searchTerm) === -1) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = '<p class="kiosk-loading">No products match your search.</p>';
      return;
    }

    var html = '';
    filtered.forEach(function (p) {
      var cartEntry = _kioskCart[p.item_id];
      var inCart = cartEntry ? cartEntry.qty : 0;
      var stock = parseFloat(p.stock_on_hand) || 0;
      var outOfStock = stock <= 0;
      var lowStock = !outOfStock && stock <= 5;

      var cardClass = 'kiosk-product-card' + (outOfStock ? ' kiosk-product-card--out-of-stock' : '');

      var imgHtml;
      if (p.image_name && p.sku) {
        imgHtml = '<img class="kiosk-product-img" src="images/products/' +
          encodeURIComponent(p.sku) + '.png" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';">' +
          '<div class="kiosk-product-img-placeholder" style="display:none;">&#127817;</div>';
      } else {
        imgHtml = '<div class="kiosk-product-img-placeholder">&#127817;</div>';
      }

      var stockLabel = outOfStock ? 'Out of stock' :
        (lowStock ? 'Low stock (' + Math.round(stock) + ')' : 'In stock');
      var stockClass = outOfStock ? 'kiosk-product-stock--out' :
        (lowStock ? 'kiosk-product-stock--low' : '');

      html += '<div class="' + cardClass + '" data-item-id="' + p.item_id + '">';
      if (inCart > 0) {
        html += '<div class="kiosk-card-in-cart">' + inCart + '</div>';
      }
      html += imgHtml;
      var effectiveRate = kioskEffectiveRate(p);
      var isKit = (p.product_type || '').toLowerCase() === 'kit';
      html += '<div class="kiosk-product-body">';
      html += '<div class="kiosk-product-name">' + (p.name || '') + '</div>';
      if (p.sku) html += '<div class="kiosk-product-sku">' + p.sku + '</div>';
      html += '<div class="kiosk-product-price">' + kioskFmt(effectiveRate) + '</div>';
      if (isKit) html += '<div class="kiosk-product-makers-fee">incl. $' + MAKERS_FEE + ' maker\'s fee</div>';
      html += '<div class="kiosk-product-stock ' + stockClass + '">' + stockLabel + '</div>';
      html += '</div>';
      html += '</div>';
    });

    grid.innerHTML = html;

    var cards = grid.querySelectorAll('.kiosk-product-card:not(.kiosk-product-card--out-of-stock)');
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var itemId = card.getAttribute('data-item-id');
        var product = _kioskProducts.filter(function (p) { return p.item_id === itemId; })[0];
        if (!product) return;
        kioskAddToCart(product);
      });
    });
  }

  // ===== Cart Management =====

  function kioskAddToCart(product) {
    var id = product.item_id;
    if (_kioskCart[id]) {
      _kioskCart[id].qty += 1;
    } else {
      _kioskCart[id] = { item: product, qty: 1 };
    }
    kioskRenderCart();
    kioskRenderProducts();
  }

  // ===== Customer Browse Mode =====

  function kioskCbIsWine(p) {
    var haystack = ((p.name || '') + ' ' + kioskItemCategory(p)).toLowerCase();
    var keywords = ['wine', 'red', 'white', 'ros', 'cider', 'seltzer', 'chardonnay', 'merlot', 'cab', 'pinot', 'sauvignon', 'malbec', 'shiraz', 'gewurz'];
    for (var i = 0; i < keywords.length; i++) {
      if (haystack.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function kioskCbIsBeer(p) {
    var haystack = ((p.name || '') + ' ' + kioskItemCategory(p)).toLowerCase();
    var keywords = ['beer', 'ale', 'lager', 'ipa', 'stout', 'porter', 'hefe', 'wheat', 'pilsner', 'pale', 'amber'];
    for (var i = 0; i < keywords.length; i++) {
      if (haystack.indexOf(keywords[i]) !== -1) return true;
    }
    return false;
  }

  function kioskCbRenderWineCard(p) {
    var inCart = _kioskCart[p.item_id] ? _kioskCart[p.item_id].qty : 0;
    var oos = (parseFloat(p.stock_on_hand) || 0) <= 0;
    var cat = kioskItemCategory(p);
    var price = kioskEffectiveRate(p);
    var html = '<div class="kiosk-label-wine' + (oos ? ' oos' : '') + '" data-item-id="' + p.item_id + '">';
    if (inCart > 0) html += '<div class="kiosk-cb-in-cart-badge">' + inCart + '</div>';
    html += '<div class="cb-label-body">';
    html += '<div class="cb-ornament"></div>';
    html += '<div class="cb-product-name">' + escapeHTML(p.name) + '</div>';
    if (cat) html += '<div class="cb-product-category">' + escapeHTML(cat) + '</div>';
    html += '<div class="cb-spacer"></div>';
    html += '</div>';
    html += '<div class="cb-price-footer">';
    html += '<div class="cb-price-col"><div class="cb-price-label">In Store</div><div class="cb-price-value">' + kioskFmt(price) + '</div></div>';
    html += '</div>';
    html += '<button type="button" class="cb-add-btn' + (inCart > 0 ? ' in-cart' : '') + '" ' + (oos ? 'disabled' : '') + '>';
    html += oos ? 'Out of Stock' : (inCart > 0 ? '\u2713 In Cart (' + inCart + ')' : 'Add to Cart');
    html += '</button>';
    html += '</div>';
    return html;
  }

  function kioskCbRenderBeerCard(p) {
    var inCart = _kioskCart[p.item_id] ? _kioskCart[p.item_id].qty : 0;
    var oos = (parseFloat(p.stock_on_hand) || 0) <= 0;
    var cat = kioskItemCategory(p);
    var price = kioskEffectiveRate(p);
    var html = '<div class="kiosk-label-beer' + (oos ? ' oos' : '') + '" data-item-id="' + p.item_id + '">';
    if (inCart > 0) html += '<div class="kiosk-cb-in-cart-badge">' + inCart + '</div>';
    html += '<div class="cb-label-body">';
    html += '<div class="cb-product-category">' + escapeHTML(cat || 'Beer') + '</div>';
    html += '<div class="cb-product-name">' + escapeHTML(p.name) + '</div>';
    html += '<div class="cb-gold-rule"></div>';
    html += '<div class="cb-spacer"></div>';
    html += '</div>';
    html += '<div class="cb-price-footer">';
    html += '<div class="cb-price-col"><div class="cb-price-label">In Store</div><div class="cb-price-value">' + kioskFmt(price) + '</div></div>';
    html += '</div>';
    html += '<button type="button" class="cb-add-btn' + (inCart > 0 ? ' in-cart' : '') + '" ' + (oos ? 'disabled' : '') + '>';
    html += oos ? 'Out of Stock' : (inCart > 0 ? '\u2713 In Cart (' + inCart + ')' : 'Add to Cart');
    html += '</button>';
    html += '</div>';
    return html;
  }

  function kioskCbRenderCard(p) {
    var inCart = _kioskCart[p.item_id] ? _kioskCart[p.item_id].qty : 0;
    var oos = (parseFloat(p.stock_on_hand) || 0) <= 0;
    var cat = kioskItemCategory(p);
    var price = kioskEffectiveRate(p);
    var stock = parseFloat(p.stock_on_hand) || 0;
    var stockClass = oos ? 'out' : (stock <= 5 ? 'low' : '');
    var stockLabel = oos ? 'Out of stock' : (stock <= 5 ? 'Low stock (' + Math.round(stock) + ')' : '');
    var html = '<div class="kiosk-cb-card' + (oos ? ' oos' : '') + '" data-item-id="' + p.item_id + '">';
    if (inCart > 0) html += '<div class="kiosk-cb-in-cart-badge">' + inCart + '</div>';
    if (p.image_name && p.sku) {
      html += '<img class="cb-card-img" src="images/products/' + encodeURIComponent(p.sku) + '.png" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';">';
      html += '<div class="cb-card-img-placeholder" style="display:none;">\uD83D\uDCE6</div>';
    } else {
      html += '<div class="cb-card-img-placeholder">\uD83D\uDCE6</div>';
    }
    html += '<div class="cb-card-body">';
    html += '<div class="cb-card-name">' + escapeHTML(p.name) + '</div>';
    if (cat) html += '<div class="cb-card-category">' + escapeHTML(cat) + '</div>';
    html += '<div class="cb-card-price">' + kioskFmt(price) + '</div>';
    if (stockLabel) html += '<div class="cb-card-stock ' + stockClass + '">' + stockLabel + '</div>';
    html += '<button type="button" class="cb-add-btn' + (inCart > 0 ? ' in-cart' : '') + '" ' + (oos ? 'disabled' : '') + '>';
    html += oos ? 'Out of Stock' : (inCart > 0 ? '\u2713 In Cart (' + inCart + ')' : 'Add to Cart');
    html += '</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function kioskRenderCbGrid() {
    var grid = document.getElementById('kiosk-cb-grid');
    if (!grid) return;

    var search = _kioskCbSearch.toLowerCase().trim();

    var filtered = _kioskProducts.filter(function (p) {
      var ptype = (p.product_type || '').toLowerCase();
      if (_kioskCbTab === 'kits') {
        if (ptype !== 'kit') return false;
      } else {
        if (ptype !== 'ingredient' && ptype !== 'service') return false;
        if ((parseFloat(p.rate) || 0) === 0) return false;
      }
      if (search) {
        var haystack = ((p.name || '') + ' ' + kioskItemCategory(p)).toLowerCase();
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      grid.innerHTML = '<p class="kiosk-loading">No products found.</p>';
      return;
    }

    var html = '';
    filtered.forEach(function (p) {
      var ptype = (p.product_type || '').toLowerCase();
      if (ptype === 'kit') {
        if (kioskCbIsWine(p)) {
          html += kioskCbRenderWineCard(p);
        } else if (kioskCbIsBeer(p)) {
          html += kioskCbRenderBeerCard(p);
        } else {
          html += kioskCbRenderCard(p);
        }
      } else {
        html += kioskCbRenderCard(p);
      }
    });

    grid.innerHTML = html;

    Array.prototype.forEach.call(grid.querySelectorAll('.cb-add-btn:not([disabled])'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var card = btn.closest('[data-item-id]');
        if (!card) return;
        var itemId = card.getAttribute('data-item-id');
        var product = null;
        for (var i = 0; i < _kioskProducts.length; i++) {
          if (_kioskProducts[i].item_id === itemId) { product = _kioskProducts[i]; break; }
        }
        if (!product) return;
        kioskAddToCart(product);
        kioskRenderCbGrid();
        kioskUpdateCbCartBar();
      });
    });
  }

  function kioskUpdateCbCartBar() {
    var bar = document.getElementById('kiosk-cb-cart-bar');
    var summary = document.getElementById('kiosk-cb-cart-summary');
    if (!bar || !summary) return;
    var count = 0;
    var ids = Object.keys(_kioskCart);
    for (var i = 0; i < ids.length; i++) {
      count += _kioskCart[ids[i]].qty;
    }
    if (count === 0) {
      bar.style.display = 'none';
    } else {
      bar.style.display = '';
      var totals = kioskCalcTotals();
      summary.textContent = count + ' item' + (count !== 1 ? 's' : '') + ' \u2014 ' + kioskFmt(totals.total);
    }
  }

  function kioskShowCustomerBrowse() {
    kioskShowView('browse-customer');
    var btn = document.getElementById('kiosk-browse-mode-btn');
    if (btn) btn.style.display = 'none';
    kioskRenderCbGrid();
    kioskUpdateCbCartBar();
  }

  function kioskExitCustomerBrowse() {
    kioskShowView('browse');
    var btn = document.getElementById('kiosk-browse-mode-btn');
    if (btn) btn.style.display = '';
  }

  function kioskSetQty(itemId, qty) {
    if (qty <= 0) {
      delete _kioskCart[itemId];
    } else {
      if (_kioskCart[itemId]) {
        _kioskCart[itemId].qty = qty;
      }
    }
    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskClearCart() {
    _kioskCart = {};
    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskRenderCart() {
    var container = document.getElementById('kiosk-cart-items');
    var totalsEl = document.getElementById('kiosk-cart-totals');
    var checkoutBtn = document.getElementById('kiosk-checkout-btn');
    var checkoutTotal = document.getElementById('kiosk-checkout-total');
    if (!container) return;

    var keys = Object.keys(_kioskCart);

    if (keys.length === 0) {
      container.innerHTML = '<p class="kiosk-cart-empty">No items in cart</p>';
      if (totalsEl) totalsEl.style.display = 'none';
      if (checkoutBtn) checkoutBtn.disabled = true;
      if (checkoutTotal) checkoutTotal.textContent = '$0.00';
      return;
    }

    var html = '';
    keys.forEach(function (id) {
      var entry = _kioskCart[id];
      var item = entry.item;
      var qty = entry.qty;
      var lineTotal = kioskEffectiveRate(item) * qty;

      html += '<div class="kiosk-cart-line">';
      html += '<div class="kiosk-cart-line-name" title="' + (item.name || '') + '">' + (item.name || '') + '</div>';
      html += '<div class="kiosk-cart-qty">';
      html += '<button class="kiosk-qty-btn" data-action="dec" data-id="' + id + '">-</button>';
      html += '<span class="kiosk-qty-val">' + qty + '</span>';
      html += '<button class="kiosk-qty-btn" data-action="inc" data-id="' + id + '">+</button>';
      html += '</div>';
      html += '<div class="kiosk-cart-line-total">' + kioskFmt(lineTotal) + '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.kiosk-qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        if (!_kioskCart[id]) return;
        var newQty = _kioskCart[id].qty + (action === 'inc' ? 1 : -1);
        kioskSetQty(id, newQty);
      });
    });

    var totals = kioskCalcTotals();
    var subEl = document.getElementById('kiosk-subtotal');
    var taxEl = document.getElementById('kiosk-tax');
    var totalEl = document.getElementById('kiosk-total');
    if (subEl) subEl.textContent = kioskFmt(totals.subtotal);
    if (taxEl) taxEl.textContent = kioskFmt(totals.tax);
    if (totalEl) totalEl.textContent = kioskFmt(totals.total);
    if (totalsEl) totalsEl.style.display = '';
    if (checkoutBtn) checkoutBtn.disabled = false;
    if (checkoutTotal) checkoutTotal.textContent = kioskFmt(totals.total);
  }

  // ===== Checkout Flow =====

  function kioskStartCheckout() {
    if (kioskCartIsEmpty()) return;
    if (!_kioskTerminalReady) {
      showToast('POS terminal is not ready. Check terminal status below.', 'error');
      return;
    }
    _kioskCustomer = null;
    kioskShowCustomerStep();
  }

  function kioskShowCustomerStep() {
    kioskShowView('customer');

    var hasKits = kioskCartHasKits();
    var proceedBtn = document.getElementById('kiosk-customer-proceed');
    var skipBtn = document.getElementById('kiosk-customer-skip');
    var backBtn = document.getElementById('kiosk-customer-back');
    var searchInput = document.getElementById('kiosk-customer-search');
    var resultsEl = document.getElementById('kiosk-customer-results');
    var selectedEl = document.getElementById('kiosk-customer-selected');
    var newToggle = document.getElementById('kiosk-new-customer-toggle');
    var newForm = document.getElementById('kiosk-new-customer-form');
    var saveBtn = document.getElementById('kiosk-new-customer-save');

    // Reset state
    if (searchInput) searchInput.value = '';
    if (resultsEl) resultsEl.innerHTML = '';
    if (selectedEl) { selectedEl.style.display = 'none'; selectedEl.innerHTML = ''; }
    if (newForm) newForm.style.display = 'none';
    if (proceedBtn) proceedBtn.disabled = true;
    if (skipBtn) skipBtn.style.display = hasKits ? 'none' : '';

    function updateProceedState() {
      if (proceedBtn) proceedBtn.disabled = !_kioskCustomer;
    }

    function kioskSelectCustomer(c) {
      _kioskCustomer = c;
      if (searchInput) { searchInput.value = ''; }
      if (resultsEl) resultsEl.innerHTML = '';
      if (selectedEl) {
        selectedEl.style.display = '';
        selectedEl.innerHTML = '<span>' + (c.name || '') + (c.email ? ' &mdash; ' + c.email : '') + '</span>' +
          '<button type="button" style="background:none;border:none;cursor:pointer;font-size:1rem;padding:0 0.25rem;" id="kiosk-clear-customer">&times;</button>';
        var clearBtn = document.getElementById('kiosk-clear-customer');
        if (clearBtn) {
          clearBtn.onclick = function () {
            _kioskCustomer = null;
            selectedEl.style.display = 'none';
            selectedEl.innerHTML = '';
            updateProceedState();
          };
        }
      }
      if (newForm) newForm.style.display = 'none';
      updateProceedState();
    }

    if (backBtn) {
      backBtn.onclick = function () { kioskShowView('browse'); };
    }

    if (skipBtn) {
      skipBtn.onclick = function () { kioskProceedToPayment(); };
    }

    if (proceedBtn) {
      proceedBtn.onclick = function () {
        if (_kioskCustomer) kioskProceedToPayment();
      };
    }

    if (newToggle) {
      newToggle.onclick = function () {
        if (newForm) newForm.style.display = newForm.style.display === 'none' ? '' : 'none';
      };
    }

    if (saveBtn) {
      saveBtn.onclick = function () {
        var nameEl = document.getElementById('kiosk-new-name');
        var emailEl = document.getElementById('kiosk-new-email');
        var phoneEl = document.getElementById('kiosk-new-phone');
        var name = nameEl ? nameEl.value.trim() : '';
        var email = emailEl ? emailEl.value.trim() : '';
        var phone = phoneEl ? phoneEl.value.trim() : '';
        if (!name || !email) {
          showToast('Name and email are required', 'error');
          return;
        }
        saveBtn.disabled = true;
        var mwUrl = kioskMwUrl();
        fetch(mwUrl + '/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, phone: phone })
        })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (result) {
          saveBtn.disabled = false;
          if (result.data && result.data.contact_id) {
            if (nameEl) nameEl.value = '';
            if (emailEl) emailEl.value = '';
            if (phoneEl) phoneEl.value = '';
            kioskSelectCustomer({ contact_id: result.data.contact_id, name: name, email: email });
          } else {
            showToast(result.data.error || 'Could not create customer', 'error');
          }
        })
        .catch(function () {
          saveBtn.disabled = false;
          showToast('Could not create customer', 'error');
        });
      };
    }

    var searchTimer = null;
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var q = searchInput.value.trim();
        if (!q) { if (resultsEl) resultsEl.innerHTML = ''; return; }
        searchTimer = setTimeout(function () {
          var mwUrl = kioskMwUrl();
          fetch(mwUrl + '/api/contacts?search=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!resultsEl) return;
            var contacts = (data.contacts || []).slice(0, 8);
            if (!contacts.length) {
              resultsEl.innerHTML = '<div style="padding:0.4rem 0.6rem;color:#888;font-size:0.88rem;">No results</div>';
              return;
            }
            var html = '';
            contacts.forEach(function (c) {
              html += '<div class="kiosk-customer-result-row" data-id="' + (c.contact_id || '') + '">' +
                '<strong>' + (c.contact_name || c.name || '') + '</strong>' +
                (c.email ? ' <span style="color:#666;">' + c.email + '</span>' : '') +
                '</div>';
            });
            resultsEl.innerHTML = html;
            Array.prototype.forEach.call(resultsEl.querySelectorAll('.kiosk-customer-result-row'), function (row) {
              row.onclick = function () {
                var idx = Array.prototype.indexOf.call(resultsEl.querySelectorAll('.kiosk-customer-result-row'), row);
                var c = contacts[idx];
                kioskSelectCustomer({
                  contact_id: c.contact_id || '',
                  name: c.contact_name || c.name || '',
                  email: c.email || ''
                });
              };
            });
          })
          .catch(function () {
            if (resultsEl) resultsEl.innerHTML = '<div style="padding:0.4rem 0.6rem;color:#888;font-size:0.88rem;">Search failed</div>';
          });
        }, 300);
      });

      searchInput.addEventListener('focus', function () {
        var el = searchInput;
        setTimeout(function () {
          if (el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 350);
      });
    }

    var newFormInputIds = ['kiosk-new-name', 'kiosk-new-email', 'kiosk-new-phone'];
    newFormInputIds.forEach(function (inputId) {
      var el = document.getElementById(inputId);
      if (!el) return;
      el.addEventListener('focus', function () {
        var target = el;
        setTimeout(function () {
          if (target.scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 350);
      });
    });
  }

  function kioskProceedToPayment() {
    var totals = kioskCalcTotals();
    var mwUrl = kioskMwUrl();
    if (!mwUrl) {
      showToast('Middleware URL not configured', 'error');
      return;
    }

    var items = Object.keys(_kioskCart).map(function (id) {
      var entry = _kioskCart[id];
      return {
        item_id: entry.item.item_id,
        name: entry.item.name || '',
        quantity: entry.qty,
        rate: kioskEffectiveRate(entry.item),
        product_type: entry.item.product_type || ''
      };
    });

    kioskShowView('payment');

    var amountEl = document.getElementById('kiosk-payment-amount');
    var msgEl = document.getElementById('kiosk-terminal-msg');
    var spinnerEl = document.getElementById('kiosk-spinner');
    var itemsEl = document.getElementById('kiosk-payment-items');
    var cancelBtn = document.getElementById('kiosk-cancel-payment');

    if (amountEl) amountEl.textContent = kioskFmt(totals.total);
    if (msgEl) msgEl.textContent = 'Tap, insert, or swipe card on terminal...';
    if (spinnerEl) spinnerEl.style.display = '';

    if (itemsEl) {
      var itemHtml = '';
      items.forEach(function (it) {
        itemHtml += '<div class="kiosk-payment-item-row">';
        itemHtml += '<span>' + (it.name || '') + ' x' + (it.quantity || 1) + '</span>';
        itemHtml += '<span>' + kioskFmt((it.rate || 0) * (it.quantity || 1)) + '</span>';
        itemHtml += '</div>';
      });
      if (totals.tax > 0) {
        itemHtml += '<div class="kiosk-payment-item-row"><span>Tax</span><span>' + kioskFmt(totals.tax) + '</span></div>';
      }
      itemsEl.innerHTML = itemHtml;
    }

    var cancelled = false;
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.onclick = function () {
        cancelled = true;
        kioskShowView('browse');
        if (msgEl) msgEl.textContent = 'Cancelled.';
      };
    }

    var refNumber = 'KIOSK-' + Date.now();

    fetch(mwUrl + '/api/kiosk/sale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items,
        tax_total: totals.tax,
        reference_number: refNumber,
        contact_id: _kioskCustomer ? _kioskCustomer.contact_id : ''
      })
    })
    .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
    .then(function (result) {
      if (cancelled) return;
      if (spinnerEl) spinnerEl.style.display = 'none';

      if (result.status === 201 && result.data.ok) {
        _kioskSaleData = result.data;

        // Instead of auto-creating batches, show the batch review form for kit items
        var kitItems = items.filter(function (it) {
          return (it.product_type || '').toLowerCase() === 'kit';
        });

        if (kitItems.length > 0) {
          kioskShowBatchReview(result.data, totals, items, kitItems);
        } else {
          kioskShowReceipt(result.data, totals, items, []);
          kioskClearCart();
        }
      } else if (result.status === 402) {
        kioskShowError(
          'Payment Declined',
          result.data.error || 'Card was declined. Please try a different payment method.',
          true
        );
      } else if (result.data && result.data.payment_voided) {
        kioskShowError(
          'Sale Could Not Complete',
          (result.data.error || 'Payment was taken but could not be recorded. Payment has been voided.'),
          false
        );
      } else {
        kioskShowError(
          'Sale Error',
          result.data.error || 'An error occurred. Please try again.',
          true
        );
      }
    })
    .catch(function () {
      if (cancelled) return;
      if (spinnerEl) spinnerEl.style.display = 'none';
      kioskShowError('Connection Error', 'Could not reach the payment server. Please try again.', true);
    });
  }

  // ===== Batch Review (NEW) =====

  function kioskShowBatchReview(saleData, totals, items, kitItems) {
    kioskShowView('review-batches');
    var today = new Date().toISOString().slice(0, 10);
    var formList = document.getElementById('kiosk-batch-form-list');
    if (!formList) return;

    // Expand kits by quantity into individual batch entries
    var batchEntries = [];
    kitItems.forEach(function (it) {
      for (var q = 0; q < (it.quantity || 1); q++) {
        batchEntries.push({ name: it.name, sku: it.item_id || '' });
      }
    });

    var html = '';
    batchEntries.forEach(function (be, i) {
      html += '<div class="kiosk-batch-form-card" data-idx="' + i + '">';
      html += '<div class="kiosk-batch-form-title">' + escapeHTML(be.name) + '</div>';
      if (_kioskCustomer) {
        html += '<div class="kiosk-batch-form-customer">Customer: ' + escapeHTML(_kioskCustomer.name) + '</div>';
      }
      html += '<div class="form-group"><label>Start Date</label>' +
        '<input type="date" class="admin-input kiosk-batch-start-date" value="' + today + '"></div>';
      html += '<div class="form-group"><label>Vessel <span class="optional">(optional)</span></label>' +
        '<input type="text" class="admin-input kiosk-batch-vessel" placeholder="Leave blank to assign later"></div>';
      html += '<div class="form-group"><label>Schedule Template <span class="optional">(optional)</span></label>' +
        '<input type="text" class="admin-input kiosk-batch-schedule" placeholder="e.g. FS-0001"></div>';
      html += '</div>';
    });
    formList.innerHTML = html;

    var saveBtn = document.getElementById('kiosk-save-batches-btn');
    var skipBtn = document.getElementById('kiosk-skip-batches-btn');

    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.onclick = function () {
        saveBtn.disabled = true;
        var cards = formList.querySelectorAll('.kiosk-batch-form-card');
        var promises = batchEntries.map(function (be, i) {
          var card = cards[i];
          var startDate = card.querySelector('.kiosk-batch-start-date').value || today;
          var vessel = card.querySelector('.kiosk-batch-vessel').value.trim();
          var schedule = card.querySelector('.kiosk-batch-schedule').value.trim();
          return adminApiPost('create_batch', {
            product_name: be.name,
            product_sku: be.sku,
            customer_name: _kioskCustomer ? _kioskCustomer.name : 'Walk-In',
            customer_email: _kioskCustomer ? (_kioskCustomer.email || '') : '',
            start_date: startDate,
            vessel_id: vessel,
            schedule_id: schedule
          }).catch(function (err) {
            console.error('[kiosk] batch creation failed:', err);
            return null;
          });
        });
        Promise.all(promises).then(function (results) {
          var batches = results.filter(function (b) { return b && b.batch_id; });
          if (batches.length < promises.length) {
            showToast('Some batches could not be saved', 'warn');
          }
          kioskShowReceipt(saleData, totals, items, batches);
          kioskClearCart();
        });
      };
    }

    if (skipBtn) {
      skipBtn.onclick = function () {
        kioskShowReceipt(saleData, totals, items, []);
        kioskClearCart();
      };
    }
  }

  // ===== Receipt =====

  function kioskShowReceipt(saleData, totals, items, batches) {
    kioskShowView('receipt');
    batches = batches || [];

    var body = document.getElementById('kiosk-receipt-body');
    if (!body) return;

    var html = '';

    items.forEach(function (it) {
      html += '<div class="kiosk-receipt-row">';
      html += '<span>' + (it.name || '') + ' x' + (it.quantity || 1) + '</span>';
      html += '<span>' + kioskFmt((it.rate || 0) * (it.quantity || 1)) + '</span>';
      html += '</div>';
    });

    if (totals.tax > 0) {
      html += '<div class="kiosk-receipt-row"><span>Tax</span><span>' + kioskFmt(totals.tax) + '</span></div>';
    }

    html += '<div class="kiosk-receipt-row" style="font-weight:700;font-size:1.05rem;">';
    html += '<strong>Total</strong><strong>' + kioskFmt(saleData.total || totals.total) + '</strong>';
    html += '</div>';

    if (saleData.invoice_number) {
      html += '<div class="kiosk-receipt-row"><span>Invoice</span><span>' + saleData.invoice_number + '</span></div>';
    }
    if (saleData.transaction_id) {
      html += '<div class="kiosk-receipt-row"><span>Transaction</span><span style="font-size:0.8rem;font-family:monospace;">' + saleData.transaction_id + '</span></div>';
    }
    if (saleData.auth_code) {
      html += '<div class="kiosk-receipt-row"><span>Auth Code</span><span>' + saleData.auth_code + '</span></div>';
    }
    if (saleData.date) {
      html += '<div class="kiosk-receipt-row"><span>Date</span><span>' + saleData.date + '</span></div>';
    }

    if (batches.length > 0) {
      html += '<div class="kiosk-receipt-batches">';
      html += '<div class="kiosk-receipt-section-title">Batches Created</div>';
      batches.forEach(function (b, i) {
        html += '<div class="kiosk-receipt-batch-row">';
        html += '<span>' + (b.batch_id || '') + '</span>';
        html += '<button type="button" class="btn admin-btn-sm kiosk-save-label-btn" data-batch-idx="' + i + '">Save Label</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    body.innerHTML = html;

    if (batches.length > 0) {
      Array.prototype.forEach.call(body.querySelectorAll('.kiosk-save-label-btn'), function (btn) {
        btn.onclick = function () {
          var idx = parseInt(btn.getAttribute('data-batch-idx'), 10);
          var b = batches[idx];
          if (!b) return;
          var today = new Date().toISOString().slice(0, 10);
          var qrSvg = '';
          if (typeof qrcode !== 'undefined' && b.batch_id && b.access_token) {
            var qr = generateBatchQR(b.batch_id, b.access_token);
            qrSvg = qr.createSvgTag(4);
          }
          var labelHtml = buildBatchLabelHTML({
            batch: {
              batch_id: b.batch_id,
              customer_name: _kioskCustomer ? _kioskCustomer.name : 'Walk-In',
              customer_email: _kioskCustomer ? (_kioskCustomer.email || '') : '',
              start_date: b.start_date || today
            },
            tasks: [],
            qrSvg: qrSvg
          });
          var pw = window.open('', '_blank');
          if (pw) {
            pw.document.write(labelHtml);
            pw.document.close();
            setTimeout(function () { pw.print(); }, 250);
          }
        };
      });
    }

    var newSaleBtn = document.getElementById('kiosk-new-sale-btn');
    if (newSaleBtn) {
      newSaleBtn.onclick = function () {
        _kioskCustomer = null;
        kioskShowView('browse');
      };
    }
  }

  // ===== Error View =====

  function kioskShowError(title, msg, canRetry) {
    kioskShowView('error');

    var titleEl = document.getElementById('kiosk-error-title');
    var msgEl = document.getElementById('kiosk-error-msg');
    var retryBtn = document.getElementById('kiosk-retry-btn');
    var backBtn = document.getElementById('kiosk-back-btn');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;

    if (retryBtn) {
      retryBtn.style.display = canRetry ? '' : 'none';
      retryBtn.onclick = function () {
        kioskShowView('browse');
        kioskStartCheckout();
      };
    }

    if (backBtn) {
      backBtn.onclick = function () {
        kioskShowView('browse');
      };
    }
  }

  // ===== Init Kiosk Tab =====

  function initKioskSaleTab() {
    var searchInput = document.getElementById('kiosk-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(_kioskSearchTimer);
        _kioskSearchTimer = setTimeout(kioskRenderProducts, 200);
      });
    }

    var catFilter = document.getElementById('kiosk-category-filter');
    if (catFilter) {
      catFilter.addEventListener('change', kioskRenderProducts);
    }

    var refreshBtn = document.getElementById('kiosk-products-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _kioskProductsLoaded = false;
        kioskLoadProducts(true);
      });
    }

    var clearBtn = document.getElementById('kiosk-cart-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (kioskCartIsEmpty()) return;
        kioskClearCart();
      });
    }

    var oosToggle = document.getElementById('kiosk-hide-oos');
    if (oosToggle) {
      oosToggle.addEventListener('change', function () {
        _kioskHideOutOfStock = oosToggle.checked;
        kioskRenderProducts();
      });
    }

    var checkoutBtn = document.getElementById('kiosk-checkout-btn');
    if (checkoutBtn) {
      checkoutBtn.addEventListener('click', kioskStartCheckout);
    }

    // Customer browse mode wiring
    var browseModeBtn = document.getElementById('kiosk-browse-mode-btn');
    if (browseModeBtn) {
      browseModeBtn.addEventListener('click', kioskShowCustomerBrowse);
    }

    var cbBackBtn = document.getElementById('kiosk-cb-back-btn');
    if (cbBackBtn) {
      cbBackBtn.addEventListener('click', kioskExitCustomerBrowse);
    }

    var cbSearch = document.getElementById('kiosk-cb-search');
    if (cbSearch) {
      cbSearch.addEventListener('input', function () {
        clearTimeout(_kioskCbSearchTimer);
        _kioskCbSearch = cbSearch.value;
        _kioskCbSearchTimer = setTimeout(kioskRenderCbGrid, 200);
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('.kiosk-cb-tab'), function (tab) {
      tab.addEventListener('click', function () {
        _kioskCbTab = tab.getAttribute('data-cb-tab');
        Array.prototype.forEach.call(document.querySelectorAll('.kiosk-cb-tab'), function (t) {
          t.classList.remove('active');
        });
        tab.classList.add('active');
        var note = document.getElementById('kiosk-cb-kits-note');
        if (note) note.style.display = _kioskCbTab === 'kits' ? '' : 'none';
        kioskRenderCbGrid();
      });
    });

    var startPurchaseBtn = document.getElementById('kiosk-cb-start-purchase-btn');
    if (startPurchaseBtn) {
      startPurchaseBtn.addEventListener('click', kioskExitCustomerBrowse);
    }
  }

  // ===== Bootstrap =====

  document.addEventListener('DOMContentLoaded', function () {
    waitForGoogleIdentity();
    initKioskSaleTab();
  });

})();

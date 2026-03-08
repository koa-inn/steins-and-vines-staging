// Mobile nav toggle
document.addEventListener('DOMContentLoaded', function () {
  // Kiosk mode: activated by ?kiosk=1 or iPad home-screen launch
  var IS_KIOSK = (window.location.search.indexOf('kiosk=1') !== -1) ||
                 (window.navigator.standalone === true);

  if (IS_KIOSK) {
    document.body.classList.add('kiosk-mode');
    // Propagate ?kiosk=1 to all internal links
    var links = document.querySelectorAll('a[href]');
    links.forEach(function(link) {
      var href = link.getAttribute('href');
      if (href && href.indexOf('http') !== 0 && href.indexOf('mailto:') !== 0 && href.indexOf('tel:') !== 0) {
        link.setAttribute('href', href + (href.indexOf('?') !== -1 ? '&' : '?') + 'kiosk=1');
      }
    });
    initKioskMode();
  }

  var toggle = document.querySelector('.nav-toggle');
  var navList = document.querySelector('.nav-list');

  // Create backdrop overlay for mobile nav
  var navBackdrop = document.createElement('div');
  navBackdrop.className = 'nav-backdrop';
  var mainNav = document.querySelector('.main-nav');
  if (mainNav) {
    mainNav.appendChild(navBackdrop);
  } else {
    var header = document.querySelector('header');
    if (header && header.parentNode) {
      header.parentNode.insertBefore(navBackdrop, header.nextSibling);
    }
  }

  function closeNav() {
    if (navList) navList.classList.remove('open');
    navBackdrop.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.innerHTML = '&#9776;'; }
  }

  if (toggle && navList) {
    toggle.addEventListener('click', function () {
      var isOpen = navList.classList.toggle('open');
      navBackdrop.classList.toggle('open');
      document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.innerHTML = isOpen ? '&times;' : '&#9776;';
    });

    // Close mobile nav when backdrop is tapped
    navBackdrop.addEventListener('click', function () {
      closeNav();
    });

    // Auto-close mobile nav when a link is tapped
    var navLinks = navList.querySelectorAll('a');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        closeNav();
      });
    });

    // Close mobile nav on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navList.classList.contains('open')) {
        closeNav();
      }
    });
  }

  // Dismiss open tasting-notes tooltips when tapping outside
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.product-notes-btn')) return;
    var openTips = document.querySelectorAll('.product-notes-tooltip.show');
    openTips.forEach(function (tip) { tip.classList.remove('show'); });
  });

  // Content loader — fetches shared.json + page-specific JSON, merges, and applies
  var page = document.body.getAttribute('data-page');
  if (page) {
    var sharedFetch = fetch('content/shared.json')
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; });
    var pageFetch = fetch('content/' + page + '.json')
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; });

    Promise.all([sharedFetch, pageFetch])
      .then(function (results) {
        var shared = results[0];
        var pageData = results[1];
        // Page-specific values override shared
        var data = {};
        var key;
        for (key in shared) { if (shared.hasOwnProperty(key)) data[key] = shared[key]; }
        for (key in pageData) { if (pageData.hasOwnProperty(key)) data[key] = pageData[key]; }

        var els = document.querySelectorAll('[data-content]');
        els.forEach(function (el) {
          var k = el.getAttribute('data-content');
          if (data[k] !== undefined) {
            el.innerHTML = data[k];
          }
        });
      })
      .catch(function () {
        // Silently fail — fallback text already in HTML
      });
  }

  // Expose header height as CSS variable for sticky offsets
  var siteHeader = document.querySelector('.site-header');
  if (siteHeader) {
    var setHeaderHeight = function () {
      document.documentElement.style.setProperty('--header-height', siteHeader.offsetHeight + 'px');
    };
    setHeaderHeight();
    window.addEventListener('resize', setHeaderHeight);
  }

  // Expose product-tabs height as CSS variable for sticky offsets
  var productTabs = document.getElementById('product-tabs');
  if (productTabs) {
    var setTabsHeight = function () {
      document.documentElement.style.setProperty('--tabs-height', productTabs.offsetHeight + 'px');
    };
    setTabsHeight();
    window.addEventListener('resize', setTabsHeight);
  }

  // Migrate legacy single-cart data into dual carts
  migrateReservationData();

  // Warn if any cart item is older than 14 days
  (function () {
    var FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    var now = Date.now();
    var allItems = [];
    try { allItems = allItems.concat(JSON.parse(localStorage.getItem('sv-cart-ferment')) || []); } catch (e) {}
    try { allItems = allItems.concat(JSON.parse(localStorage.getItem('sv-cart-ingredients')) || []); } catch (e) {}
    var hasStale = false;
    for (var i = 0; i < allItems.length; i++) {
      if (allItems[i].cartAddedAt && (now - allItems[i].cartAddedAt) > FOURTEEN_DAYS) {
        hasStale = true;
        break;
      }
    }
    if (hasStale) {
      showToast('Some items in your cart were added more than 14 days ago \u2014 prices or availability may have changed.', 'warn');
    }
  }());

  // Dynamic preconnect to middleware origin for reduced connection latency
  var _mwPreconnectUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL)
    ? SHEETS_CONFIG.MIDDLEWARE_URL : '';
  if (_mwPreconnectUrl) {
    try {
      var _pcLink = document.createElement('link');
      _pcLink.rel = 'preconnect';
      _pcLink.href = new URL(_mwPreconnectUrl).origin;
      document.head.appendChild(_pcLink);
    } catch(e) {}
  }

  // Product catalog loader — shared by products.html, ingredients.html, and clean-URL sub-pages
  if (page === 'products' || page === 'ingredients' || page === 'ferment-in-store' || page === 'ingredients-supplies') {
    loadProducts();
    initReservationBar();
    initMobileBottomControls();
    initProductTabs();
    initCatalogViewToggle();
    // Preload ingredients immediately so the first tab switch is instant
    if (_allIngredients.length === 0) loadIngredients(function () {});

    // Auto-switch tab: ?tab= param overrides default; ingredients pages default to ingredients tab
    var tabParam = new URLSearchParams(window.location.search).get('tab');
    if (tabParam) {
      var tabBtn = document.querySelector('.product-tab-btn[data-product-tab="' + tabParam + '"]');
      if (tabBtn) tabBtn.click();
    } else if (page === 'ingredients' || page === 'ingredients-supplies') {
      var ingTabBtn = document.querySelector('.product-tab-btn[data-product-tab="ingredients"]');
      if (ingTabBtn) ingTabBtn.click();
    }
  }

  // Reservation page
  if (page === 'reservation') {
    initReservationPage();
  }

  // About page: tabs, FAQ, hours, services
  if (page === 'about') {
    loadFAQ();
    loadOpenHours();
    initAboutTabs();
    initCatalogViewToggle();
  }

  // Contact form inline validation
  if (page === 'contact') {
    loadOpenHours();
    setupContactValidation();
    setupContactSubmit();
  }

  // Featured products on homepage
  if (page === 'home') {
    loadFeaturedProducts();
    initReservationBar();
    setupBeerWaitlistForm();
  }

  // Footer hours on all public pages
  loadFooterHours();

  // Social links on all pages
  loadSocialLinks();

  // Listen for cart changes to refresh all UI controls (e.g. product card quantities)
  window.addEventListener('reservation-changed', function() {
    if (typeof refreshAllReserveControls === 'function') {
      refreshAllReserveControls();
    }
  });
});

// ===== Mobile Bottom Controls =====
// Moves .catalog-controls elements to a direct body child so position:fixed
// works reliably on iOS Safari regardless of DOM nesting depth.
function initMobileBottomControls() {
  if (window.innerWidth >= 1024) return;
  var controls = Array.prototype.slice.call(document.querySelectorAll('.catalog-controls'));
  if (controls.length === 0) return;

  var wrap = document.createElement('div');
  wrap.id = 'mobile-catalog-bar';
  document.body.appendChild(wrap);
  controls.forEach(function(ctrl) { wrap.appendChild(ctrl); });

  // Measure heights after first paint so CSS vars reflect actual layout
  requestAnimationFrame(function() {
    var catH = wrap.offsetHeight || 56;
    document.documentElement.style.setProperty('--catalog-bar-height', catH + 'px');
    var fixedBar = document.getElementById('reservation-bar');
    if (fixedBar && !fixedBar.classList.contains('hidden')) {
      document.documentElement.style.setProperty('--reservation-bar-height', fixedBar.offsetHeight + 'px');
    }
  });
}

// ===== Kiosk Mode =====

function initKioskMode() {
  createKioskBottomNav();
  initKioskAttractScreen();
  simplifyKioskCheckout();
}

function createKioskBottomNav() {
  var nav = document.createElement('nav');
  nav.className = 'kiosk-nav';
  nav.setAttribute('aria-label', 'Kiosk navigation');

  // Back button
  var backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'kiosk-nav-btn';
  backBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg><span>Back</span>';
  backBtn.addEventListener('click', function () { window.history.back(); });

  // Home button
  var homeBtn = document.createElement('a');
  homeBtn.className = 'kiosk-nav-btn';
  homeBtn.href = 'products.html?kiosk=1';
  homeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg><span>Home</span>';

  // Cart button
  var cartBtn = document.createElement('a');
  cartBtn.className = 'kiosk-nav-btn';
  cartBtn.href = 'reservation.html?kiosk=1';
  cartBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 18c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7.17 14.75l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1 1 0 0 0 20 4H5.21l-.94-2H1v2h2l3.6 7.59-1.35 2.44C4.52 15.37 5.48 17 7 17h12v-2H7.42c-.14 0-.25-.11-.25-.25z"/></svg><span>Cart</span>';

  var badge = document.createElement('span');
  badge.className = 'kiosk-nav-badge';
  badge.id = 'kiosk-cart-badge';
  cartBtn.appendChild(badge);

  nav.appendChild(backBtn);
  nav.appendChild(homeBtn);
  nav.appendChild(cartBtn);
  document.body.appendChild(nav);

  // Update cart badge (show total across both carts)
  function updateKioskBadge() {
    var items = [].concat(getReservation(FERMENT_CART_KEY), getReservation(INGREDIENT_CART_KEY));
    var count = 0;
    items.forEach(function (it) { count += (it.qty || 1); });
    badge.textContent = count > 0 ? String(count) : '';
  }
  updateKioskBadge();
  window.addEventListener('storage', updateKioskBadge);
  window.addEventListener('reservation-changed', updateKioskBadge);
}

function initKioskAttractScreen() {
  // Create attract screen overlay
  var attract = document.createElement('div');
  attract.className = 'kiosk-attract';
  attract.id = 'kiosk-attract';
  attract.innerHTML = '<img src="images/SV_Logo_PrimaryCircle_offwhite.svg" alt="" class="kiosk-attract-logo">'
    + '<div class="kiosk-attract-title">Tap to Start</div>'
    + '<div class="kiosk-attract-tagline">Craft your own wine & beer — browse our selection and reserve your kit today.</div>';
  document.body.appendChild(attract);

  var IDLE_TIMEOUT = 2 * 60 * 1000; // 2 minutes
  var idleTimer = null;

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(showAttractScreen, IDLE_TIMEOUT);
  }

  function showAttractScreen() {
    // Clear reservation on idle
    localStorage.removeItem('sv-reservation');
    attract.classList.add('active');
  }

  function dismissAttractScreen() {
    if (!attract.classList.contains('active')) return;
    attract.classList.remove('active');
    resetIdleTimer();
    // Navigate to products page
    if (window.location.pathname.indexOf('products.html') === -1) {
      window.location.href = 'products.html?kiosk=1';
    }
  }

  attract.addEventListener('click', dismissAttractScreen);
  attract.addEventListener('touchstart', dismissAttractScreen);

  // Listen for user activity
  var activityEvents = ['touchstart', 'click', 'scroll', 'keydown'];
  activityEvents.forEach(function (evt) {
    document.addEventListener(evt, function () {
      if (!attract.classList.contains('active')) {
        resetIdleTimer();
      }
    }, { passive: true });
  });

  resetIdleTimer();
}

// Terminal processing overlay for kiosk
function showTerminalOverlay(msg, sub) {
  var overlay = document.getElementById('kiosk-terminal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'kiosk-terminal-overlay';
    overlay.id = 'kiosk-terminal-overlay';
    overlay.innerHTML = '<div class="kiosk-terminal-spinner"></div>'
      + '<div class="kiosk-terminal-msg" id="kiosk-terminal-msg"></div>'
      + '<div class="kiosk-terminal-sub" id="kiosk-terminal-sub"></div>';
    document.body.appendChild(overlay);
  }
  var msgEl = document.getElementById('kiosk-terminal-msg');
  var subEl = document.getElementById('kiosk-terminal-sub');
  if (msgEl) msgEl.textContent = msg || 'Processing...';
  if (subEl) subEl.textContent = sub || '';
  overlay.classList.add('active');
}

function hideTerminalOverlay() {
  var overlay = document.getElementById('kiosk-terminal-overlay');
  if (overlay) overlay.classList.remove('active');
}

function simplifyKioskCheckout() {
  // On reservation page in kiosk mode: hide email and phone, simplify to name-only
  var page = document.body.getAttribute('data-page');
  if (page !== 'reservation') return;

  var emailGroup = document.getElementById('res-email');
  var phoneGroup = document.getElementById('res-phone');
  if (emailGroup && emailGroup.parentElement) {
    emailGroup.parentElement.classList.add('kiosk-hide');
    emailGroup.removeAttribute('required');
  }
  if (phoneGroup && phoneGroup.parentElement) {
    phoneGroup.parentElement.classList.add('kiosk-hide');
    phoneGroup.removeAttribute('required');
  }

  // Simplify the stepper labels for kiosk
  var stepperSteps = document.querySelectorAll('.stepper-step');
  if (stepperSteps.length >= 4) {
    // Step 3 becomes "Your Name" instead of "Your Details"
    var step3Label = stepperSteps[2].querySelector('.stepper-label');
    if (step3Label) step3Label.textContent = 'Your Name';
  }
}

function loadOpenHours() {
  var container = document.getElementById('open-hours');
  if (!container) return;

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : null;
  var localUrl = 'content/timeslots.csv';

  function parseAndRender(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return false;

    var headers = lines[0].split(',');
    var slots = [];
    for (var i = 1; i < lines.length; i++) {
      var values = lines[i].split(',');
      if (values.length < 3) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j].trim()] = values[j].trim();
      }
      slots.push(obj);
    }

    // Consider all slots (regardless of status) to show full default hours
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    slots = slots.filter(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      return d >= today;
    });

    if (slots.length === 0) return false;

    // Group by day-of-week, track earliest start and latest end
    var dayMap = {};
    slots.forEach(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      var dow = d.getDay();
      var timeParts = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!timeParts) return;
      var h = parseInt(timeParts[1], 10);
      var m = parseInt(timeParts[2], 10);
      var ampm = timeParts[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      var mins = h * 60 + m;

      if (!dayMap[dow]) dayMap[dow] = { min: mins, max: mins };
      if (mins < dayMap[dow].min) dayMap[dow].min = mins;
      if (mins > dayMap[dow].max) dayMap[dow].max = mins;
    });

    // Convert minutes back to time string
    function minsToStr(mins) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h >= 12 ? 'PM' : 'AM';
      var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      var mm = m < 10 ? '0' + m : '' + m;
      return hr12 + ':' + mm + ' ' + ampm;
    }

    // Build the hours list for each day Sun–Sat
    var html = '<h2>Open Hours</h2><ul class="open-hours-list">';
    for (var dow = 0; dow < 7; dow++) {
      var info = dayMap[dow];
      html += '<li class="open-hours-row' + (info ? '' : ' closed') + '">';
      html += '<span class="open-hours-day">' + DAY_NAMES[dow] + '</span>';
      if (info) {
        // The last slot starts at max, so end time is +30 min
        html += '<span class="open-hours-time">' + minsToStr(info.min) + ' &ndash; ' + minsToStr(info.max + 30) + '</span>';
      } else {
        html += '<span class="open-hours-time">Closed</span>';
      }
      html += '</li>';
    }
    html += '</ul>';
    container.innerHTML = html;
    return true;
  }

  function fetchAndRender(url) {
    return fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (csv) { return parseAndRender(csv); });
  }

  // Try remote first, fall back to local CSV
  var attempt = remoteUrl ? fetchAndRender(remoteUrl) : Promise.resolve(false);
  attempt
    .then(function (success) {
      if (!success) return fetchAndRender(localUrl);
    })
    .catch(function () {
      return fetchAndRender(localUrl).catch(function () {});
    });
}

function loadFAQ() {
  var container = document.getElementById('faq-list');
  if (!container) return;

  fetch('content/about.json')
    .then(function (res) { return res.ok ? res.json() : {}; })
    .then(function (data) {
      var faqs = data.faqs;
      if (!faqs || faqs.length === 0) return;

      var html = '';
      faqs.forEach(function (faq) {
        html += '<div class="faq-item">';
        html += '<button type="button" class="faq-question">' + escapeHTML(faq.question) + '</button>';
        html += '<div class="faq-answer"><p>' + escapeHTML(faq.answer) + '</p></div>';
        html += '</div>';
      });
      container.innerHTML = html;

      // Toggle FAQ answers
      container.querySelectorAll('.faq-question').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var item = this.parentElement;
          item.classList.toggle('open');
        });
      });
    })
    .catch(function (err) {
      console.error('[FAQ] Error loading:', err);
    });
}

function loadFooterHours() {
  var container = document.getElementById('footer-hours');
  if (!container) return;

  var DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : null;
  var localUrl = 'content/timeslots.csv';

  function parseAndRender(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return false;

    var headers = lines[0].split(',');
    var slots = [];
    for (var i = 1; i < lines.length; i++) {
      var values = lines[i].split(',');
      if (values.length < 3) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j].trim()] = values[j].trim();
      }
      slots.push(obj);
    }

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    slots = slots.filter(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      return d >= today;
    });

    if (slots.length === 0) return false;

    // Group by day-of-week, track earliest start and latest end
    var dayMap = {};
    slots.forEach(function (s) {
      var d = new Date(s.date + 'T00:00:00');
      var dow = d.getDay();
      var timeParts = s.time.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!timeParts) return;
      var h = parseInt(timeParts[1], 10);
      var m = parseInt(timeParts[2], 10);
      var ampm = timeParts[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      var mins = h * 60 + m;

      if (!dayMap[dow]) dayMap[dow] = { min: mins, max: mins };
      if (mins < dayMap[dow].min) dayMap[dow].min = mins;
      if (mins > dayMap[dow].max) dayMap[dow].max = mins;
    });

    function minsToStr(mins) {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h >= 12 ? 'PM' : 'AM';
      var hr12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      return hr12 + (m > 0 ? ':' + (m < 10 ? '0' + m : m) : '') + ampm;
    }

    // Build compact hours display
    var html = '';
    for (var dow = 0; dow < 7; dow++) {
      var info = dayMap[dow];
      html += '<span class="footer-hours-day' + (info ? '' : ' closed') + '">';
      html += '<span class="footer-hours-abbr">' + DAY_ABBR[dow] + '</span> ';
      if (info) {
        html += minsToStr(info.min) + '–' + minsToStr(info.max + 30);
      } else {
        html += 'Closed';
      }
      html += '</span>';
    }
    container.innerHTML = html;
    return true;
  }

  function fetchAndRender(url) {
    return fetch(url)
      .then(function (res) { return res.text(); })
      .then(function (csv) { return parseAndRender(csv); });
  }

  var attempt = remoteUrl ? fetchAndRender(remoteUrl) : Promise.resolve(false);
  attempt
    .then(function (success) {
      if (!success) return fetchAndRender(localUrl);
    })
    .catch(function () {
      return fetchAndRender(localUrl).catch(function () {});
    });
}

// ===== Social Links =====

function loadSocialLinks() {
  var container = document.querySelector('.footer-social');
  if (!container) return;

  var homepageCsvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL
    : null;

  if (!homepageCsvUrl) return; // Keep hardcoded links if no sheet configured

  fetch(homepageCsvUrl)
    .then(function (res) { return res.ok ? res.text() : ''; })
    .then(function (csv) {
      if (!csv.trim()) return;

      var lines = csv.trim().split('\n');
      var socialLinks = {};

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        var type = (values[0] || '').toLowerCase().trim();
        if (type === 'social') {
          var platform = (values[2] || '').toLowerCase().trim(); // Title column = platform name
          var url = (values[4] || '').trim(); // SKU column = URL
          if (platform && url) {
            socialLinks[platform] = url;
          }
        }
      }

      // Update existing links if we found any
      if (Object.keys(socialLinks).length > 0) {
        var igLink = container.querySelector('a[aria-label*="Instagram"]');
        var fbLink = container.querySelector('a[aria-label*="Facebook"]');

        if (igLink && socialLinks.instagram) {
          igLink.href = socialLinks.instagram;
        }
        if (fbLink && socialLinks.facebook) {
          fbLink.href = socialLinks.facebook;
        }
      }
    })
    .catch(function () {
      // Keep hardcoded links on error
    });

  function parseCSVLine(line) {
    var result = [];
    var current = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += c;
      }
    }
    result.push(current);
    return result;
  }
}

// ===== Homepage Promo Section =====

// ===== Responsive Product Image Helper =====

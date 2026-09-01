// REVIEW-03 (Phase 59): content photos (.facility-photo-img) are loading="lazy"
// and below the fold, so their 8px-bordered box renders EMPTY until the image
// lazy-loads on scroll — which the external review read as a "broken/blank frame".
// A brand-tone placeholder + shimmer (CSS, on .facility-photo-img:not(.is-loaded))
// fills that box. This helper is the progressive enhancement that removes the
// shimmer once each image finishes (or errors), by adding `is-loaded`. The image
// itself is never hidden by JS — the placeholder sits behind it — so if this does
// not run, images still display normally.
function initFacilityPhotoPlaceholders() {
  var imgs = document.querySelectorAll('.facility-photo-img');
  for (var i = 0; i < imgs.length; i++) {
    (function (img) {
      if (img.complete && img.naturalWidth > 0) {
        img.classList.add('is-loaded');
        return;
      }
      function markLoaded() { img.classList.add('is-loaded'); }
      img.addEventListener('load', markLoaded);
      // Mark a broken image loaded too, so the placeholder never shimmers forever.
      img.addEventListener('error', markLoaded);
    }(imgs[i]));
  }
}

// ===== Promo Banner =====
function initPromoBanner() {
  // D-02: Skip if already dismissed via localStorage
  try {
    if (localStorage.getItem('sv-promo-banner-dismissed')) return;
  } catch (e) { /* localStorage unavailable — proceed */ }

  // Skip banner in kiosk mode
  var isKiosk = (window.location.search.indexOf('kiosk=1') !== -1) ||
                (window.navigator.standalone === true);
  if (isKiosk) return;

  // Fetch content/home.json (may already be cached by content loader)
  // Root-absolute path: the promo banner is site-wide, so this must resolve from
  // any directory depth (e.g. /products/* subpages), not just the site root.
  fetch('/content/home.json')
    .then(function (r) { return r.ok ? r.json() : {}; })
    .then(function (data) {
      var config = data['promo-banner'];
      if (!config || !config.enabled) return;

      var el = document.getElementById('promo-banner');
      if (!el) return;

      // Populate banner content
      var tagEl = el.querySelector('.promo-banner-tag');
      var textEl = el.querySelector('.promo-banner-text');
      var ctaEl = el.querySelector('.promo-banner-cta');
      var dismissEl = el.querySelector('.promo-banner-dismiss');

      if (tagEl) tagEl.textContent = config.tag || '';
      if (textEl) textEl.innerHTML = config.text || '';
      if (ctaEl) {
        ctaEl.textContent = config.cta || '';
        ctaEl.href = config['cta-href'] || '#';
      }

      // Show banner by removing .hidden class (project convention)
      el.classList.remove('hidden');

      // Dismiss handler
      if (dismissEl) {
        dismissEl.addEventListener('click', function () {
          el.classList.add('hidden');
          try {
            localStorage.setItem('sv-promo-banner-dismissed', '1');
          } catch (e) { /* silently fail */ }
        });
      }
    })
    .catch(function () { /* silently fail — banner is non-critical */ });
}

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

  var _navPrevFocus = null;

  function closeNav() {
    if (navList) navList.classList.remove('open');
    navBackdrop.classList.remove('open');
    document.body.classList.remove('nav-open');
    if (toggle) { toggle.setAttribute('aria-expanded', 'false'); toggle.innerHTML = '&#9776;'; }
    var mainEl = document.querySelector('main');
    var footerEl = document.querySelector('footer');
    if (mainEl) mainEl.removeAttribute('aria-hidden');
    if (footerEl) footerEl.removeAttribute('aria-hidden');
    if (_navPrevFocus) { _navPrevFocus.focus(); _navPrevFocus = null; }
  }

  function openNav() {
    _navPrevFocus = document.activeElement;
    navList.classList.add('open');
    navBackdrop.classList.add('open');
    document.body.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.innerHTML = '&times;';
    var mainEl = document.querySelector('main');
    var footerEl = document.querySelector('footer');
    if (mainEl) mainEl.setAttribute('aria-hidden', 'true');
    if (footerEl) footerEl.setAttribute('aria-hidden', 'true');
    var firstLink = navList.querySelector('a');
    if (firstLink) firstLink.focus();
  }

  if (toggle && navList) {
    toggle.addEventListener('click', function () {
      if (navList.classList.contains('open')) {
        closeNav();
      } else {
        openNav();
      }
    });

    // Close mobile nav when backdrop is tapped
    navBackdrop.addEventListener('click', function () {
      closeNav();
    });

    // Auto-close mobile nav when a link is tapped (except dropdown parent)
    var navLinks = navList.querySelectorAll('a');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function (e) {
        var isDropdownParent = link.parentElement && link.parentElement.classList.contains('nav-dropdown');
        if (isDropdownParent && window.innerWidth <= 768) return;
        closeNav();
      });
    });

    // Focus trap + Escape key for mobile nav
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navList.classList.contains('open')) {
        closeNav();
        return;
      }
      if (e.key !== 'Tab' || !navList.classList.contains('open')) return;
      var focusable = navList.querySelectorAll('a, button, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  // Phone popover (call or text)
  var phoneWrap = document.querySelector('.header-phone-wrap');
  var phonePopover = document.querySelector('.header-phone-popover');
  if (phoneWrap && phonePopover) {
    phoneWrap.addEventListener('click', function (e) {
      if (e.target.closest('.header-phone-popover')) return;
      phonePopover.classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.header-phone-wrap')) {
        phonePopover.classList.remove('open');
      }
    });
  }

  // Nav dropdown toggle for mobile (touch devices)
  var navDropdown = document.querySelector('.nav-dropdown');
  if (navDropdown) {
    var dropdownLink = navDropdown.querySelector(':scope > a');
    if (dropdownLink) {
      dropdownLink.addEventListener('click', function (e) {
        if (window.innerWidth <= 768) {
          e.preventDefault();
          navDropdown.classList.toggle('open');
        }
      });
    }
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
    // Pages that ship an editorial content/<page>.json. Catalog/product subpages
    // (grains, yeast, hops, ...) and error/util pages have no page JSON — they use
    // shared.json + the static fallback markup only. Fetching a non-existent file
    // logs a console 404 regardless of graceful JS handling, so gate the request.
    var PAGES_WITH_CONTENT = ['home', 'about', 'contact', 'products', 'ingredients', 'reservation', 'admin'];
    // Root-absolute paths so they resolve from any directory depth (e.g. /products/*).
    var sharedFetch = fetch('/content/shared.json')
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; });
    var pageFetch = PAGES_WITH_CONTENT.indexOf(page) !== -1
      ? fetch('/content/' + page + '.json')
          .then(function (res) { return res.ok ? res.json() : {}; })
          .catch(function () { return {}; })
      : Promise.resolve({});

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
    try { allItems = allItems.concat(JSON.parse(localStorage.getItem(FERMENT_CART_KEY)) || []); } catch (e) {}
    try { allItems = allItems.concat(JSON.parse(localStorage.getItem(INGREDIENT_CART_KEY)) || []); } catch (e) {}
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

  // Landing copy "Read more" toggle on product sub-pages
  var lcToggle = document.querySelector('.landing-copy-toggle');
  if (lcToggle) {
    lcToggle.addEventListener('click', function () {
      var section = document.getElementById('landing-copy');
      var expanded = section.classList.toggle('is-expanded');
      lcToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      lcToggle.textContent = expanded ? 'Show less' : lcToggle.getAttribute('data-label');
    });
    lcToggle.setAttribute('data-label', lcToggle.textContent);
  }

  // Product catalog loader — shared by products.html, ingredients.html, and clean-URL sub-pages
  if (page === 'products' || page === 'ingredients' || page === 'ingredients-supplies') {
    loadProducts();
    initReservationBar();
    initCartDrawer();
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

  // Category-scoped catalogue pages — /wine and /beer (D-09); also wires the
  // beer waitlist form, which has never been reachable on its own page (D-11).
  initCategoryCatalogPage(page);

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
    initCartDrawer();
    setupBeerWaitlistForm();
    initPromoBanner();
  }

  // Hops + ingredient subpages — cart drawer for standalone catalogs
  if (['hops', 'grains', 'yeast', 'additives', 'packaging', 'equipment'].indexOf(page) !== -1) {
    initCartDrawer();
  }

  // NOTE: loadFooterHours() is intentionally NOT called. It derives hours
  // from the bookable timeslots CSV, which drifts if the first slot of the
  // day isn't exactly at opening time (e.g. buffered by 30 min for setup).
  // The footer's static HTML is the source of truth. To change hours, update
  // the three places listed above BUSINESS_HOURS. The function is kept here
  // in case you ever want CSV-driven display back.
  // loadFooterHours();

  // Re-evaluate the header open/closed badge every minute (based on Vancouver time)
  renderOpenStatus();
  setInterval(renderOpenStatus, 60 * 1000);

  // REVIEW-03: fill lazy content-image frames with a placeholder until they load
  initFacilityPhotoPlaceholders();

  // Social links on all pages
  loadSocialLinks();

  // Listen for cart changes to refresh all UI controls (e.g. product card quantities)
  window.addEventListener('reservation-changed', function() {
    if (typeof updateReservationBar === 'function') updateReservationBar();
    if (typeof renderCartSidebar === 'function') renderCartSidebar();
    if (typeof renderCartDrawer === 'function') renderCartDrawer();
    if (typeof refreshAllReserveControls === 'function') refreshAllReserveControls();
  });
});

// ===== Category-Scoped Catalogue Pages (/wine, /beer) =====
// D-09: /wine and /beer each render their own category-scoped catalogue via
// loadProducts(page) (contract established by plan 74-02). D-11: beer.html's
// waitlist form has carried data-page="beer" and #beer-waitlist-form since
// 2026-08-31, but the waitlist-form setup call below was only ever reachable
// from the page === 'home' branch — so it has never been wired on its own
// page and has
// been doing a native submit + full-page reload instead of posting to
// /api/waitlist. Extracted to a module-scope function so it is directly
// testable (see tests/frontend/init-category-page.test.js) and callable from
// the DOMContentLoaded dispatch above without disturbing any existing branch.
function initCategoryCatalogPage(page) {
  if (page !== 'wine' && page !== 'beer') return false;

  loadProducts(page);
  initReservationBar();
  initCartDrawer();
  initMobileBottomControls();
  initCatalogViewToggle();
  // Neither wine.html nor beer.html carries div.product-tabs#product-tabs
  // (the hub's tab switcher), so initProductTabs()/loadIngredients() are
  // intentionally NOT called here.

  if (page === 'beer') {
    setupBeerWaitlistForm();
  }

  return true;
}

// ===== Mobile Bottom Controls =====
// Moves .catalog-controls elements to a direct body child so position:fixed
// works reliably on iOS Safari regardless of DOM nesting depth.
function initMobileBottomControls() {
  if (window.innerWidth >= 1024) return;
  var controls = Array.prototype.slice.call(document.querySelectorAll('.catalog-controls'));
  if (controls.length === 0) return;

  var wrap = document.getElementById('mobile-catalog-bar');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'mobile-catalog-bar';
    document.body.appendChild(wrap);
  } else {
    wrap.innerHTML = '';
  }
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

// Clears all cart and milled-item state for the current kiosk customer.
// Called on idle reset (attract screen) to prevent cart leaks between customers.
// Exported for unit testing via module.exports below.
function _clearKioskSession() {
  try {
    // Dual carts (sv-cart-ferment, sv-cart-ingredients)
    localStorage.removeItem('sv-cart-ferment');
    localStorage.removeItem('sv-cart-ingredients');
    // Legacy reservation key — cleared for backward compatibility
    localStorage.removeItem(typeof RESERVATION_KEY !== 'undefined' ? RESERVATION_KEY : 'sv-reservation');
    // Milled-item state (persisted in sessionStorage by 12-checkout.js)
    sessionStorage.removeItem('sv-milled-keys');
  } catch (e) {}
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
    // Clear all cart/session state on idle so the next customer starts fresh
    _clearKioskSession();
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
  var localUrl = '/content/timeslots.csv';

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

function loadTestimonials() {
  var container = document.getElementById('testimonials-grid');
  if (!container) return;

  fetch('/content/reviews.json')
    .then(function (res) { return res.ok ? res.json() : {}; })
    .then(function (data) {
      var reviews = data.reviews;
      if (!reviews || !reviews.length) return;

      var html = '';
      reviews.forEach(function (r) {
        var stars = '';
        for (var i = 0; i < 5; i++) {
          stars += i < r.rating ? '&#9733;' : '&#9734;';
        }
        html += '<div class="testimonial-card">'
          + '<div class="testimonial-stars" aria-label="' + r.rating + ' out of 5 stars">' + stars + '</div>'
          + '<blockquote class="testimonial-text"><p>' + escapeHTML(r.text) + '</p>'
          + '<footer class="testimonial-name">&mdash; ' + escapeHTML(r.name) + '</footer>'
          + '</blockquote>'
          + '<a href="' + escapeHTML(r.url) + '" class="testimonial-link"'
          + ' target="_blank" rel="noopener">View on Google</a>'
          + '</div>';
      });
      container.innerHTML = html;
    })
    .catch(function () { /* silently fail - testimonials are non-critical */ });
}

function loadFAQ() {
  var container = document.getElementById('faq-list');
  if (!container) return;

  fetch('/content/about.json')
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
      console.error('[FAQ] Error loading:', err); // eslint-disable-line no-console -- operational: reports FAQ load failure for troubleshooting
    });
}

var HOURS_DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Canonical storefront hours. When changing hours, update THREE places:
//   1. This BUSINESS_HOURS constant (drives the header open/closed badge)
//   2. The static <div class="footer-hours">...</div> in every public HTML page
//      (index, about, contact, products, ingredients, reservation, products/*)
//   3. The "openingHoursSpecification" block in the LocalBusiness JSON-LD in
//      every public HTML page (same 8 files)
// Keys = day-of-week (0=Sun). Values = { open, close } in minutes since local
// midnight, interpreted in America/Vancouver time. Days not listed are closed.
var BUSINESS_HOURS = {
  2: { open: 10 * 60, close: 16 * 60 },   // Tue 10AM-4PM
  3: { open: 10 * 60, close: 16 * 60 },   // Wed 10AM-4PM
  4: { open: 12 * 60, close: 19 * 60 },   // Thu 12PM-7PM
  5: { open: 10 * 60, close: 16 * 60 },   // Fri 10AM-4PM
  6: { open: 10 * 60, close: 16 * 60 }    // Sat 10AM-4PM
};

function renderOpenStatus() {
  var els = document.querySelectorAll('.open-status');
  if (!els.length) return;

  // Current weekday + minutes-since-midnight in America/Vancouver (handles PST/PDT).
  var parts = {};
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Vancouver',
      weekday: 'short',
      hour: '2-digit', hour12: false,
      minute: '2-digit'
    }).formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  } catch (e) {
    return;
  }
  var weekdayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var dow = weekdayIndex[parts.weekday];
  var h = parseInt(parts.hour, 10);
  if (h === 24) h = 0; // some engines output '24' at midnight
  var currentMins = h * 60 + parseInt(parts.minute, 10);

  var today = BUSINESS_HOURS[dow];
  var isOpen = !!(today && currentMins >= today.open && currentMins < today.close);

  for (var j = 0; j < els.length; j++) {
    els[j].hidden = false;
    els[j].className = 'open-status' + (isOpen ? ' is-open' : ' is-closed');
    els[j].textContent = isOpen ? 'Open' : 'Closed';
  }
}

function loadFooterHours() {
  var container = document.getElementById('footer-hours');
  if (!container) return;

  var DAY_ABBR = HOURS_DAY_ABBR;

  var remoteUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : null;
  var localUrl = '/content/timeslots.csv';

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // Test-only: invoke the kiosk idle-reset cart clearing logic directly
    _resetKioskSessionForTest: _clearKioskSession,
    // REVIEW-03: lazy content-image placeholder load-state helper
    initFacilityPhotoPlaceholders: initFacilityPhotoPlaceholders,
    // D-09/D-11: /wine and /beer category-catalogue dispatch + beer waitlist wiring
    initCategoryCatalogPage: initCategoryCatalogPage
  };
}

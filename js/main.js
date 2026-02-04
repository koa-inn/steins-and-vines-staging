// ===== Anonymous Event Tracking =====

var _eventQueue = [];
var _EVENT_FLUSH_THRESHOLD = 5;

function trackEvent(type, sku, name) {
  var url = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.TRACK_EVENTS_URL)
    ? SHEETS_CONFIG.TRACK_EVENTS_URL
    : '';
  if (!url) return;
  _eventQueue.push({ type: type, sku: sku, name: name });
  if (_eventQueue.length >= _EVENT_FLUSH_THRESHOLD) {
    flushEvents();
  }
}

function flushEvents() {
  if (_eventQueue.length === 0) return;
  var url = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.TRACK_EVENTS_URL)
    ? SHEETS_CONFIG.TRACK_EVENTS_URL
    : '';
  if (!url) return;
  var payload = JSON.stringify({ events: _eventQueue });
  _eventQueue = [];
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
  }
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') {
    flushEvents();
  }
});

// Mobile nav toggle
document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.nav-toggle');
  var navList = document.querySelector('.nav-list');

  if (toggle && navList) {
    toggle.addEventListener('click', function () {
      navList.classList.toggle('open');
    });

    // Auto-close mobile nav when a link is tapped
    var navLinks = navList.querySelectorAll('a');
    navLinks.forEach(function (link) {
      link.addEventListener('click', function () {
        navList.classList.remove('open');
      });
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
            el.textContent = data[k];
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

  // Product catalog loader
  if (page === 'products') {
    loadProducts();
    initReservationBar();
    initProductTabs();
  }

  // Reservation page
  if (page === 'reservation') {
    initReservationPage();
  }

  // Open hours on about & contact pages
  if (page === 'about' || page === 'contact') {
    loadOpenHours();
  }

  // Featured products on homepage
  if (page === 'home') {
    loadFeaturedProducts();
  }

  // Footer hours on all public pages
  loadFooterHours();

  // Social links on all pages
  loadSocialLinks();
});

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

function loadFeaturedProducts() {
  var promoSection = document.getElementById('promo-section');
  var newsContainer = document.getElementById('promo-news-content');
  var noteContainer = document.getElementById('promo-featured-note');
  var productsContainer = document.getElementById('promo-featured-products');
  if (!promoSection) return;

  // Show loading skeleton immediately
  if (productsContainer) {
    productsContainer.innerHTML = '<div class="promo-loading-skeleton"><div class="skeleton-card"></div></div>';
  }

  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_CSV_URL
    : null;
  var localCsvUrl = 'content/products.csv';

  // Load homepage config from Google Sheets (published CSV)
  var homepageCsvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_HOMEPAGE_CSV_URL
    : null;

  // Fetch both CSVs in parallel for faster loading
  var configPromise = homepageCsvUrl
    ? fetch(homepageCsvUrl).then(function (res) { return res.ok ? res.text() : ''; })
    : fetch('content/home.json').then(function (res) { return res.ok ? res.json() : {}; }).then(function (j) { return { isJson: true, data: j }; });

  var productsPromise = csvUrl
    ? fetch(csvUrl).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return fetch(localCsvUrl).then(function (r) { return r.text(); }); })
    : fetch(localCsvUrl).then(function (r) { return r.text(); });

  Promise.all([configPromise, productsPromise])
    .then(function (results) {
      var result = results[0];
      var productsCsv = results[1];
      var config = { 'promo-news': [], 'promo-featured-note': '', 'promo-featured-skus': [] };

      if (result && result.isJson) {
        // Fallback JSON format
        config = result.data;
      } else if (typeof result === 'string' && result.trim()) {
        // Parse CSV from Google Sheets
        var lines = result.trim().split('\n');
        if (lines.length > 1) {
          for (var i = 1; i < lines.length; i++) {
            var values = parseHomepageCSVLine(lines[i]);
            var type = (values[0] || '').toLowerCase().trim();
            if (type === 'news') {
              config['promo-news'].push({
                date: (values[1] || '').trim(),
                title: (values[2] || '').trim(),
                text: (values[3] || '').trim()
              });
            } else if (type === 'note') {
              config['promo-featured-note'] = (values[3] || '').trim();
            } else if (type === 'featured') {
              var sku = (values[4] || '').trim();
              if (sku) config['promo-featured-skus'].push(sku);
            }
          }
        }
      }

      // Render news items
      if (newsContainer && config['promo-news'] && config['promo-news'].length > 0) {
        renderNews(config['promo-news']);
      }

      // Render featured note
      if (noteContainer && config['promo-featured-note']) {
        noteContainer.innerHTML = '<p>' + escapeHTMLPromo(config['promo-featured-note']) + '</p>';
      }

      // Parse and render products
      var featuredSkus = config['promo-featured-skus'] || [];
      var products = productsCsv ? parseCSV(productsCsv) : [];
      renderFeaturedProducts(products, featuredSkus);
    })
    .catch(function () {
      // Fallback: hide promo section on error
      promoSection.style.display = 'none';
    });

  function parseHomepageCSVLine(line) {
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

  function escapeHTMLPromo(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderNews(newsItems) {
    var html = '';
    newsItems.forEach(function (item) {
      html += '<div class="promo-news-item">';
      html += '<span class="promo-news-date">' + escapeHTMLPromo(item.date || '') + '</span>';
      html += '<h3>' + escapeHTMLPromo(item.title || '') + '</h3>';
      html += '<p>' + escapeHTMLPromo(item.text || '') + '</p>';
      html += '</div>';
    });
    newsContainer.innerHTML = html;
  }

  function parseCSV(csv) {
    var lines = csv.trim().split('\n');
    if (lines.length < 2) return [];
    var headers = lines[0].split(',').map(function (h) { return h.trim().toLowerCase().replace(/\s+/g, '_'); });
    var products = [];
    for (var i = 1; i < lines.length; i++) {
      var values = parseCSVLine(lines[i]);
      if (values.length < 2) continue;
      var obj = {};
      for (var j = 0; j < headers.length; j++) {
        obj[headers[j]] = (values[j] || '').trim();
      }
      products.push(obj);
    }
    return products;
  }

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

  function renderFeaturedProducts(products, featuredSkus) {
    var featured = [];

    // First priority: products matching SKUs from config
    if (featuredSkus && featuredSkus.length > 0) {
      featuredSkus.forEach(function (sku) {
        var match = products.find(function (p) { return p.sku === sku; });
        if (match) featured.push(match);
      });
    }

    // Fallback: products with featured/favorite = TRUE
    if (featured.length === 0) {
      featured = products.filter(function (p) {
        return (p.featured || '').trim().toUpperCase() === 'TRUE' ||
               (p.favorite || '').trim().toUpperCase() === 'TRUE';
      });
    }

    // Fallback: products with discounts
    if (featured.length === 0) {
      featured = products.filter(function (p) {
        return parseFloat(p.discount) > 0;
      }).slice(0, 3);
    }

    // Final fallback: first 3 products
    if (featured.length === 0) {
      featured = products.slice(0, 3);
    }

    if (featured.length === 0) {
      promoSection.style.display = 'none';
      return;
    }

    productsContainer.innerHTML = '';
    var carouselIndex = 0;
    var isAnimating = false;

    featured.forEach(function (product, idx) {
      var card = createProductCard(product);
      card.dataset.carouselIndex = idx;
      // First card starts active
      if (idx === 0) {
        card.classList.add('promo-slide-active');
      }
      productsContainer.appendChild(card);
    });

    // Set up carousel if multiple products
    if (featured.length > 1) {
      var nav = document.getElementById('promo-carousel-nav');
      var dotsContainer = document.getElementById('promo-carousel-dots');
      if (nav) nav.style.display = 'flex';

      if (dotsContainer) {
        dotsContainer.innerHTML = '';
        for (var i = 0; i < featured.length; i++) {
          var dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'promo-carousel-dot' + (i === 0 ? ' active' : '');
          dot.dataset.index = i;
          dot.setAttribute('aria-label', 'Go to product ' + (i + 1));
          dotsContainer.appendChild(dot);
        }
      }

      function showSlide(newIndex) {
        if (isAnimating || newIndex === carouselIndex) return;
        isAnimating = true;

        var cards = productsContainer.querySelectorAll('.product-card');
        var dots = dotsContainer ? dotsContainer.querySelectorAll('.promo-carousel-dot') : [];
        var currentCard = cards[carouselIndex];
        var nextCard = cards[newIndex];

        // Slide current card out
        currentCard.classList.remove('promo-slide-active');
        currentCard.classList.add('promo-slide-exit');

        // Slide next card in
        nextCard.classList.add('promo-slide-active');

        // Update dots
        dots.forEach(function (d, i) {
          d.classList.toggle('active', i === newIndex);
        });

        // Clean up after animation
        setTimeout(function () {
          currentCard.classList.remove('promo-slide-exit');
          carouselIndex = newIndex;
          isAnimating = false;
        }, 500);
      }

      var prevBtn = document.querySelector('.promo-carousel-prev');
      var nextBtn = document.querySelector('.promo-carousel-next');
      if (prevBtn) {
        prevBtn.addEventListener('click', function () {
          showSlide((carouselIndex - 1 + featured.length) % featured.length);
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', function () {
          showSlide((carouselIndex + 1) % featured.length);
        });
      }

      if (dotsContainer) {
        dotsContainer.addEventListener('click', function (e) {
          if (e.target.classList.contains('promo-carousel-dot')) {
            showSlide(parseInt(e.target.dataset.index, 10));
          }
        });
      }

      // Auto-rotate every 6 seconds
      setInterval(function () {
        showSlide((carouselIndex + 1) % featured.length);
      }, 6000);
    }
  }

  function createProductCard(product) {
    var card = document.createElement('div');
    card.className = 'product-card';

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardBrand = document.createElement('p');
    cardBrand.className = 'product-brand';
    cardBrand.textContent = product.brand || '';
    header.appendChild(cardBrand);

    var cardName = document.createElement('h4');
    cardName.textContent = product.name || '';
    header.appendChild(cardName);
    card.appendChild(header);

    var batchSize = (product.batch_size_liters || '').trim();
    if (product.subcategory || product.time || batchSize) {
      var detailRow = document.createElement('div');
      detailRow.className = 'product-detail-row';
      var details = [];
      if (product.subcategory) details.push(product.subcategory);
      if (product.time) details.push(product.time);
      if (batchSize) details.push(batchSize + 'L');
      for (var d = 0; d < details.length; d++) {
        if (d > 0) {
          var sep = document.createElement('span');
          sep.className = 'detail-sep';
          sep.textContent = '\u00b7';
          detailRow.appendChild(sep);
        }
        var detailSpan = document.createElement('span');
        detailSpan.textContent = details[d];
        detailRow.appendChild(detailSpan);
      }
      card.appendChild(detailRow);
    }

    if (product.tasting_notes) {
      var notesWrap = document.createElement('div');
      notesWrap.className = 'product-notes';

      var notesToggle = document.createElement('button');
      notesToggle.type = 'button';
      notesToggle.className = 'product-notes-toggle';
      notesToggle.setAttribute('aria-expanded', 'false');
      notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

      var notesBody = document.createElement('div');
      notesBody.className = 'product-notes-body';

      if (product.sku) {
        var imageCol = document.createElement('div');
        imageCol.className = 'product-notes-image';
        var img = document.createElement('img');
        img.src = 'images/products/' + product.sku + '.png';
        img.alt = product.name || 'Product image';
        img.loading = 'lazy';
        img.onerror = function() { this.parentElement.remove(); };
        imageCol.appendChild(img);
        notesBody.appendChild(imageCol);
      }

      var textCol = document.createElement('div');
      textCol.className = 'product-notes-text';
      var notesP = document.createElement('p');
      notesP.textContent = product.tasting_notes;
      textCol.appendChild(notesP);
      notesBody.appendChild(textCol);

      notesToggle.addEventListener('click', function (wrap, toggle) {
        return function () {
          var isOpen = wrap.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };
      }(notesWrap, notesToggle));

      notesWrap.appendChild(notesToggle);
      notesWrap.appendChild(notesBody);
      card.appendChild(notesWrap);
    }

    var discount = parseFloat(product.discount) || 0;

    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'product-discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
    var plusSign = pricingFrom ? '+' : '';
    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      var priceRow = document.createElement('div');
      priceRow.className = 'product-prices';
      if (instore) {
        var instoreBox = document.createElement('div');
        instoreBox.className = 'product-price-box';
        if (discount > 0) {
          var instoreNum = parseFloat(instore.replace(/[^0-9.]/g, ''));
          var instoreSale = (instoreNum * (1 - discount / 100)).toFixed(2);
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-original">' + instore + '</span><span class="product-price-value">$' + instoreSale + plusSign + '</span>';
        } else {
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + instore + plusSign + '</span>';
        }
        priceRow.appendChild(instoreBox);
      }
      if (kit) {
        var kitBox = document.createElement('div');
        kitBox.className = 'product-price-box';
        if (discount > 0) {
          var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
          var kitSale = (kitNum * (1 - discount / 100)).toFixed(2);
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-original">' + kit + '</span><span class="product-price-value">$' + kitSale + plusSign + '</span>';
        } else {
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + kit + plusSign + '</span>';
        }
        priceRow.appendChild(kitBox);
      }
      card.appendChild(priceRow);
    }

    // Reserve button
    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'product-reserve-wrap';
    var productKey = product.name + '|' + product.brand;
    renderFeaturedReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    return card;
  }

  function renderFeaturedReserveControl(container, product, productKey) {
    var reserved = getReservedItems();
    var isReserved = reserved.some(function (r) { return r.key === productKey; });

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'product-reserve-btn' + (isReserved ? ' reserved' : '');
    btn.textContent = isReserved ? 'Reserved' : 'Reserve';

    btn.addEventListener('click', function () {
      var items = getReservedItems();
      var idx = items.findIndex(function (r) { return r.key === productKey; });
      if (idx !== -1) {
        items.splice(idx, 1);
        btn.classList.remove('reserved');
        btn.textContent = 'Reserve';
      } else {
        items.push({
          key: productKey,
          name: product.name,
          brand: product.brand,
          type: product.type || 'Wine',
          sku: product.sku || ''
        });
        btn.classList.add('reserved');
        btn.textContent = 'Reserved';
      }
      localStorage.setItem('sv-reserved', JSON.stringify(items));
    });

    container.appendChild(btn);
  }

  function getReservedItems() {
    try {
      return JSON.parse(localStorage.getItem('sv-reserved')) || [];
    } catch (e) {
      return [];
    }
  }
}

// Shared CSV fetch helper — used by all tab loaders
function fetchCSV(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

// Reference to kits applyFilters so tab switcher can re-render
var applyKitsFilters = null;

function loadProducts() {
  var allProducts = [];
  var userHasSorted = false;
  var activeFilters = { type: [], brand: [], subcategory: [], time: [] };
  var saleFilterActive = false;

  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_CSV_URL
    : null;

  var CSV_CACHE_KEY = 'sv-products-csv';
  var CSV_CACHE_TS_KEY = 'sv-products-csv-ts';
  var CSV_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function getCachedCSV() {
    try {
      var csv = localStorage.getItem(CSV_CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CSV_CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CSV_CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCachedCSV(csv) {
    try {
      localStorage.setItem(CSV_CACHE_KEY, csv);
      localStorage.setItem(CSV_CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCachedCSV();
  var csvPromise;

  if (cached) {
    // Serve cached data immediately
    csvPromise = Promise.resolve(cached.csv);

    // Refresh in background if stale
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/products.csv';
      fetchCSV(refreshUrl).then(setCachedCSV).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/products.csv'); })
      : fetchCSV('content/products.csv');
    csvPromise.then(setCachedCSV);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        if ((obj.favorite || '').toLowerCase() === 'true') {
          obj._favRand = Math.random();
        }
        allProducts.push(obj);
      }

      buildFilterRow('filter-type', 'type', 'Type:');
      buildFilterRow('filter-brand', 'brand', 'Brand:');
      buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
      buildFilterRow('filter-time', 'time', 'Brew Time:');
      buildSaleFilter();
      applyFilters();

      // Expose so tab switcher can re-trigger kits rendering
      applyKitsFilters = applyFilters;

      var searchInput = document.getElementById('catalog-search');
      if (searchInput) {
        var searchTimer;
        searchInput.addEventListener('input', function () {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(applyFilters, 180);
        });
      }

      var sortSelect = document.getElementById('catalog-sort');
      if (sortSelect) {
        sortSelect.addEventListener('change', function () {
          userHasSorted = true;
          applyFilters();
        });
      }

      var toggleBtn = document.getElementById('catalog-toggle');
      var collapsible = document.getElementById('catalog-collapsible');
      if (toggleBtn && collapsible) {
        toggleBtn.addEventListener('click', function () {
          var expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
          toggleBtn.setAttribute('aria-expanded', String(!expanded));
          collapsible.classList.toggle('open');
        });
      }
    })
    .catch(function () {
      // Silently fail — noscript fallback is in the HTML
    });

  function buildFilterRow(containerId, field, label) {
    var container = document.getElementById(containerId);
    if (!container) return;

    var labelSpan = document.createElement('span');
    labelSpan.className = 'catalog-filter-label';
    labelSpan.textContent = label;
    container.appendChild(labelSpan);

    var uniqueValues = [];
    allProducts.forEach(function (r) {
      var val = r[field] || '';
      if (val && uniqueValues.indexOf(val) === -1) {
        uniqueValues.push(val);
      }
    });

    if (field === 'time') {
      uniqueValues.sort(function (a, b) {
        var numA = parseFloat(a) || 0;
        var numB = parseFloat(b) || 0;
        return numA - numB;
      });
    } else if (field === 'subcategory') {
      var styleOrder = ['red', 'white', 'rosé', 'rose', 'fruit', 'specialty'];
      uniqueValues.sort(function (a, b) {
        var aIdx = styleOrder.indexOf(a.toLowerCase());
        var bIdx = styleOrder.indexOf(b.toLowerCase());
        if (aIdx === -1) aIdx = styleOrder.length;
        if (bIdx === -1) bIdx = styleOrder.length;
        return aIdx - bIdx;
      });
    } else {
      uniqueValues.sort();
    }

    var allBtn = createFilterButton('All', containerId, field);
    allBtn.classList.add('active');
    container.appendChild(allBtn);

    uniqueValues.forEach(function (val) {
      container.appendChild(createFilterButton(val, containerId, field));
    });
  }

  function buildSaleFilter() {
    var hasSaleProducts = allProducts.some(function (p) {
      return parseFloat(p.discount) > 0;
    });
    var container = document.getElementById('filter-sale');
    if (!container || !hasSaleProducts) {
      if (container) container.style.display = 'none';
      return;
    }
    var labelSpan = document.createElement('span');
    labelSpan.className = 'catalog-filter-label';
    labelSpan.textContent = 'Sale:';
    container.appendChild(labelSpan);

    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = 'On Sale';
    btn.addEventListener('click', function () {
      saleFilterActive = !saleFilterActive;
      btn.classList.toggle('active', saleFilterActive);
      applyFilters();
    });
    container.appendChild(btn);
  }

  function createFilterButton(label, containerId, field) {
    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = label;
    btn.setAttribute('data-field', field);
    btn.setAttribute('data-value', label);
    btn.addEventListener('click', function () {
      if (label === 'All') {
        activeFilters[field] = [];
      } else {
        var idx = activeFilters[field].indexOf(label);
        if (idx !== -1) {
          activeFilters[field].splice(idx, 1);
        } else {
          activeFilters[field].push(label);
        }
      }
      var container = document.getElementById(containerId);
      var buttons = container.querySelectorAll('.catalog-filter-btn');
      buttons.forEach(function (b) { b.classList.remove('active'); });
      if (activeFilters[field].length === 0) {
        container.querySelector('[data-value="All"]').classList.add('active');
      } else {
        buttons.forEach(function (b) {
          if (activeFilters[field].indexOf(b.getAttribute('data-value')) !== -1) {
            b.classList.add('active');
          }
        });
      }
      applyFilters();
      updateFilterAvailability();
    });
    return btn;
  }

  function matchesFilters(product, excludeField) {
    var fields = ['type', 'brand', 'subcategory', 'time'];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f === excludeField) continue;
      if (activeFilters[f].length > 0 && activeFilters[f].indexOf(product[f]) === -1) return false;
    }
    return true;
  }

  function updateFilterAvailability() {
    var fields = ['type', 'brand', 'subcategory', 'time'];
    fields.forEach(function (field) {
      var containerId = 'filter-' + (field === 'subcategory' ? 'subcategory' : field);
      var container = document.getElementById(containerId);
      if (!container) return;
      var buttons = container.querySelectorAll('.catalog-filter-btn');
      buttons.forEach(function (btn) {
        var val = btn.getAttribute('data-value');
        if (val === 'All') return;
        var hasResults = allProducts.some(function (p) {
          return p[field] === val && matchesFilters(p, field);
        });
        if (hasResults) {
          btn.classList.remove('disabled');
          btn.disabled = false;
        } else {
          btn.classList.add('disabled');
          btn.disabled = true;
          btn.classList.remove('active');
          var idx = activeFilters[field].indexOf(val);
          if (idx !== -1) activeFilters[field].splice(idx, 1);
        }
      });
    });
  }

  function parsePrice(product) {
    var val = product.retail_instore || product.retail_kit || '0';
    return parseFloat(val.replace('$', '')) || 0;
  }

  function parseTimeValue(str) {
    var match = (str || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  function applyFilters() {
    var searchInput = document.getElementById('catalog-search');
    var query = searchInput ? searchInput.value.toLowerCase() : '';

    var filtered = allProducts.filter(function (r) {
      if (activeFilters.type.length > 0 && activeFilters.type.indexOf(r.type) === -1) return false;
      if (activeFilters.brand.length > 0 && activeFilters.brand.indexOf(r.brand) === -1) return false;
      if (activeFilters.subcategory.length > 0 && activeFilters.subcategory.indexOf(r.subcategory) === -1) return false;
      if (activeFilters.time.length > 0 && activeFilters.time.indexOf(r.time) === -1) return false;
      if (saleFilterActive && !(parseFloat(r.discount) > 0)) return false;
      if (!query) return true;
      var name = (r.name || '').toLowerCase();
      var sub = (r.subcategory || '').toLowerCase();
      var notes = (r.tasting_notes || '').toLowerCase();
      var brand = (r.brand || '').toLowerCase();
      return name.indexOf(query) !== -1 || sub.indexOf(query) !== -1 || notes.indexOf(query) !== -1 || brand.indexOf(query) !== -1;
    });

    var sortSelect = document.getElementById('catalog-sort');
    var sortVal = sortSelect ? sortSelect.value : 'name-asc';

    filtered.sort(function (a, b) {
      if (!userHasSorted) {
        var favA = (a.favorite || '').toLowerCase() === 'true' ? 0 : 1;
        var favB = (b.favorite || '').toLowerCase() === 'true' ? 0 : 1;
        if (favA !== favB) return favA - favB;
        if (favA === 0 && favB === 0) return (a._favRand || 0) - (b._favRand || 0);
      }

      switch (sortVal) {
        case 'name-asc':
          return (a.name || '').localeCompare(b.name || '');
        case 'name-desc':
          return (b.name || '').localeCompare(a.name || '');
        case 'price-asc':
          return parsePrice(a) - parsePrice(b);
        case 'price-desc':
          return parsePrice(b) - parsePrice(a);
        case 'time-asc':
          return parseTimeValue(a.time) - parseTimeValue(b.time);
        case 'time-desc':
          return parseTimeValue(b.time) - parseTimeValue(a.time);
        default:
          return 0;
      }
    });

    renderCatalog(filtered);
  }

  function renderCatalog(rows) {
    var catalog = document.getElementById('product-catalog');
    if (!catalog) return;

    // Remove existing sections, dividers, and no-results message, keep controls and noscript
    var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider');
    sections.forEach(function (el) { el.parentNode.removeChild(el); });

    if (rows.length === 0) {
      var msg = document.createElement('p');
      msg.className = 'catalog-no-results';
      msg.textContent = 'No products found.';
      catalog.appendChild(msg);
      return;
    }

    function getAvailable(r) {
      if (r.available !== undefined && r.available !== '') return parseInt(r.available, 10) || 0;
      return parseInt(r.stock, 10) || 0;
    }
    var inStock = rows.filter(function (r) { return getAvailable(r) > 0; });
    var orderIn = rows.filter(function (r) { return getAvailable(r) <= 0; });

    renderSection(catalog, 'Currently available', inStock);

    if (inStock.length > 0 && orderIn.length > 0) {
      var divider = document.createElement('div');
      divider.className = 'section-icon catalog-divider';
      var icon = document.createElement('img');
      icon.src = 'images/Icon_green.svg';
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
      divider.appendChild(icon);
      catalog.appendChild(divider);
    }

    renderSection(catalog, 'Available to order', orderIn, 'catalog-section--order');
  }

  function renderSection(catalog, title, items, extraClass) {
    if (items.length === 0) return;

    var wrapper = document.createElement('div');
    wrapper.className = 'catalog-section' + (extraClass ? ' ' + extraClass : '');

    var sectionHeader = document.createElement('div');
    sectionHeader.className = 'catalog-section-header';

    var sectionHeading = document.createElement('h2');
    sectionHeading.className = 'catalog-section-title';
    sectionHeading.textContent = title;
    sectionHeader.appendChild(sectionHeading);

    if (extraClass === 'catalog-section--order') {
      var note = document.createElement('p');
      note.className = 'process-note';
      note.textContent = 'Allow up to 2 weeks for items to be ordered in.';
      sectionHeader.appendChild(note);
    }

    wrapper.appendChild(sectionHeader);

    // Group by type, preserving CSV order
    var groups = {};
    var groupOrder = [];
    items.forEach(function (r) {
      if (!groups[r.type]) {
        groups[r.type] = [];
        groupOrder.push(r.type);
      }
      groups[r.type].push(r);
    });

    groupOrder.forEach(function (type) {
      var group = document.createElement('div');
      group.className = 'product-group';

      var heading = document.createElement('h3');
      heading.className = 'product-group-title';
      heading.textContent = type;
      group.appendChild(heading);

      var grid = document.createElement('div');
      grid.className = 'product-grid';

      groups[type].forEach(function (product) {
        var card = document.createElement('div');
        card.className = 'product-card';

        var header = document.createElement('div');
        header.className = 'product-card-header';

        var cardBrand = document.createElement('p');
        cardBrand.className = 'product-brand';
        cardBrand.textContent = product.brand;
        header.appendChild(cardBrand);

        var cardName = document.createElement('h4');
        cardName.textContent = product.name;
        header.appendChild(cardName);

        card.appendChild(header);

        var batchSize = (product.batch_size_liters || '').trim();
        if (product.subcategory || product.time || batchSize) {
          var detailRow = document.createElement('div');
          detailRow.className = 'product-detail-row';
          var details = [];
          if (product.subcategory) details.push(product.subcategory);
          if (product.time) details.push(product.time);
          if (batchSize) details.push(batchSize + 'L');
          for (var d = 0; d < details.length; d++) {
            if (d > 0) {
              var sep = document.createElement('span');
              sep.className = 'detail-sep';
              sep.textContent = '\u00b7';
              detailRow.appendChild(sep);
            }
            var detailSpan = document.createElement('span');
            detailSpan.textContent = details[d];
            detailRow.appendChild(detailSpan);
          }
          card.appendChild(detailRow);
        }

        if (product.tasting_notes) {
          var notesWrap = document.createElement('div');
          notesWrap.className = 'product-notes';

          var notesToggle = document.createElement('button');
          notesToggle.type = 'button';
          notesToggle.className = 'product-notes-toggle';
          notesToggle.setAttribute('aria-expanded', 'false');
          notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

          var notesBody = document.createElement('div');
          notesBody.className = 'product-notes-body';
          var notesP = document.createElement('p');
          notesP.textContent = product.tasting_notes;
          notesBody.appendChild(notesP);

          notesToggle.addEventListener('click', function (wrap, toggle, prod) {
            return function () {
              var isOpen = wrap.classList.toggle('open');
              toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
              if (isOpen) {
                trackEvent('detail', prod.sku || '', prod.name || '');
              }
            };
          }(notesWrap, notesToggle, product));

          notesWrap.appendChild(notesToggle);
          notesWrap.appendChild(notesBody);
          card.appendChild(notesWrap);
        }

        var discount = parseFloat(product.discount) || 0;

        if (discount > 0) {
          var badge = document.createElement('span');
          badge.className = 'product-discount-badge';
          badge.textContent = Math.round(discount) + '% OFF';
          card.appendChild(badge);
        }

        var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
        var plusSign = pricingFrom ? '+' : '';
        var instore = (product.retail_instore || '').trim();
        var kit = (product.retail_kit || '').trim();
        if (instore || kit) {
          var priceRow = document.createElement('div');
          priceRow.className = 'product-prices';
          if (instore) {
            var instoreBox = document.createElement('div');
            instoreBox.className = 'product-price-box';
            if (discount > 0) {
              var instoreNum = parseFloat(instore.replace(/[^0-9.]/g, ''));
              var instoreSale = (instoreNum * (1 - discount / 100)).toFixed(2);
              instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-original">' + instore + '</span><span class="product-price-value">$' + instoreSale + plusSign + '</span>';
            } else {
              instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + instore + plusSign + '</span>';
            }
            priceRow.appendChild(instoreBox);
          }
          if (kit) {
            var kitBox = document.createElement('div');
            kitBox.className = 'product-price-box';
            if (discount > 0) {
              var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
              var kitSale = (kitNum * (1 - discount / 100)).toFixed(2);
              kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-original">' + kit + '</span><span class="product-price-value">$' + kitSale + plusSign + '</span>';
            } else {
              kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + kit + plusSign + '</span>';
            }
            priceRow.appendChild(kitBox);
          }
          card.appendChild(priceRow);
        }

        var reserveWrap = document.createElement('div');
        reserveWrap.className = 'product-reserve-wrap';
        var productKey = product.name + '|' + product.brand;
        renderReserveControl(reserveWrap, product, productKey);
        card.appendChild(reserveWrap);

        grid.appendChild(card);
      });

      group.appendChild(grid);
      wrapper.appendChild(group);
    });

    catalog.appendChild(wrapper);
  }
}

// ===== Product Tab Switching =====

function initProductTabs() {
  var tabs = document.getElementById('product-tabs');
  if (!tabs) return;

  var ingredientsLoaded = false;
  var servicesLoaded = false;

  tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.product-tab-btn');
    if (!btn) return;

    var tab = btn.getAttribute('data-product-tab');

    // Swap active button
    var allBtns = tabs.querySelectorAll('.product-tab-btn');
    allBtns.forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');

    // Show/hide controls
    var controlIds = ['catalog-controls-kits', 'catalog-controls-ingredients', 'catalog-controls-services'];
    controlIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var activeControls = document.getElementById('catalog-controls-' + tab);
    if (activeControls) activeControls.classList.remove('hidden');

    // Show/hide kits process note
    var processNote = document.getElementById('kits-process-note');
    if (processNote) processNote.style.display = (tab === 'kits') ? '' : 'none';

    // Show/hide reservation bar on non-kits tabs
    var bars = document.querySelectorAll('.reservation-bar');
    bars.forEach(function (bar) {
      if (tab === 'kits') {
        updateReservationBar();
      } else {
        bar.classList.add('hidden');
      }
    });

    // Clear rendered catalog sections
    var catalog = document.getElementById('product-catalog');
    if (catalog) {
      var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider');
      sections.forEach(function (el) { el.parentNode.removeChild(el); });
    }

    // Load the appropriate tab
    if (tab === 'kits') {
      if (applyKitsFilters) applyKitsFilters();
    } else if (tab === 'ingredients') {
      if (!ingredientsLoaded) {
        ingredientsLoaded = true;
        loadIngredients(function () {
          // After first load, subsequent clicks just re-render
        });
      } else {
        renderIngredients();
      }
    } else if (tab === 'services') {
      if (!servicesLoaded) {
        servicesLoaded = true;
        loadServices(function () {});
      } else {
        renderServices();
      }
    }
  });

  // Wire up ingredients filter/sort toggle
  var ingredientToggle = document.getElementById('ingredient-toggle');
  var ingredientCollapsible = document.getElementById('ingredient-collapsible');
  if (ingredientToggle && ingredientCollapsible) {
    ingredientToggle.addEventListener('click', function () {
      var expanded = ingredientToggle.getAttribute('aria-expanded') === 'true';
      ingredientToggle.setAttribute('aria-expanded', String(!expanded));
      ingredientCollapsible.classList.toggle('open');
    });
  }
}

// ===== Ingredients & Supplies =====

var _allIngredients = [];
var _ingredientFilters = { unit: [] };

function loadIngredients(callback) {
  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_INGREDIENTS_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_INGREDIENTS_CSV_URL
    : null;

  var CACHE_KEY = 'sv-ingredients-csv';
  var CACHE_TS_KEY = 'sv-ingredients-csv-ts';
  var CACHE_TTL = 5 * 60 * 1000;

  function getCached() {
    try {
      var csv = localStorage.getItem(CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCached(csv) {
    try {
      localStorage.setItem(CACHE_KEY, csv);
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCached();
  var csvPromise;

  if (cached) {
    csvPromise = Promise.resolve(cached.csv);
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/ingredients.csv';
      fetchCSV(refreshUrl).then(setCached).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/ingredients.csv'); })
      : fetchCSV('content/ingredients.csv');
    csvPromise.then(setCached);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');
      _allIngredients = [];

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        _allIngredients.push(obj);
      }

      buildIngredientFilters();
      renderIngredients();
      wireIngredientEvents();
      if (callback) callback();
    })
    .catch(function () {});
}

function buildIngredientFilters() {
  var container = document.getElementById('filter-unit');
  if (!container || container.children.length > 0) return;

  var labelSpan = document.createElement('span');
  labelSpan.className = 'catalog-filter-label';
  labelSpan.textContent = 'Unit:';
  container.appendChild(labelSpan);

  var units = [];
  _allIngredients.forEach(function (r) {
    var val = (r.unit || '').trim();
    if (val && units.indexOf(val) === -1) units.push(val);
  });
  units.sort();

  var allBtn = document.createElement('button');
  allBtn.className = 'catalog-filter-btn active';
  allBtn.type = 'button';
  allBtn.textContent = 'All';
  allBtn.setAttribute('data-value', 'All');
  allBtn.addEventListener('click', function () {
    _ingredientFilters.unit = [];
    var btns = container.querySelectorAll('.catalog-filter-btn');
    btns.forEach(function (b) { b.classList.remove('active'); });
    allBtn.classList.add('active');
    renderIngredients();
  });
  container.appendChild(allBtn);

  units.forEach(function (val) {
    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.textContent = val;
    btn.setAttribute('data-value', val);
    btn.addEventListener('click', function () {
      var idx = _ingredientFilters.unit.indexOf(val);
      if (idx !== -1) {
        _ingredientFilters.unit.splice(idx, 1);
      } else {
        _ingredientFilters.unit.push(val);
      }
      var btns = container.querySelectorAll('.catalog-filter-btn');
      btns.forEach(function (b) { b.classList.remove('active'); });
      if (_ingredientFilters.unit.length === 0) {
        container.querySelector('[data-value="All"]').classList.add('active');
      } else {
        btns.forEach(function (b) {
          if (_ingredientFilters.unit.indexOf(b.getAttribute('data-value')) !== -1) {
            b.classList.add('active');
          }
        });
      }
      renderIngredients();
    });
    container.appendChild(btn);
  });
}

function wireIngredientEvents() {
  var searchInput = document.getElementById('ingredient-search');
  if (searchInput) {
    var timer;
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(renderIngredients, 180);
    });
  }

  var sortSelect = document.getElementById('ingredient-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', function () {
      renderIngredients();
    });
  }
}

function renderIngredients() {
  var catalog = document.getElementById('product-catalog');
  if (!catalog) return;

  // Clear existing rendered sections
  var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider');
  sections.forEach(function (el) { el.parentNode.removeChild(el); });

  var searchInput = document.getElementById('ingredient-search');
  var query = searchInput ? searchInput.value.toLowerCase() : '';

  var filtered = _allIngredients.filter(function (r) {
    if (_ingredientFilters.unit.length > 0 && _ingredientFilters.unit.indexOf(r.unit) === -1) return false;
    if (!query) return true;
    var name = (r.name || '').toLowerCase();
    var desc = (r.description || '').toLowerCase();
    return name.indexOf(query) !== -1 || desc.indexOf(query) !== -1;
  });

  var sortSelect = document.getElementById('ingredient-sort');
  var sortVal = sortSelect ? sortSelect.value : 'name-asc';

  filtered.sort(function (a, b) {
    switch (sortVal) {
      case 'name-asc': return (a.name || '').localeCompare(b.name || '');
      case 'name-desc': return (b.name || '').localeCompare(a.name || '');
      case 'price-asc': return (parseFloat(a.price_per_unit) || 0) - (parseFloat(b.price_per_unit) || 0);
      case 'price-desc': return (parseFloat(b.price_per_unit) || 0) - (parseFloat(a.price_per_unit) || 0);
      default: return 0;
    }
  });

  if (filtered.length === 0) {
    var msg = document.createElement('p');
    msg.className = 'catalog-no-results';
    msg.textContent = 'No ingredients or supplies found.';
    catalog.appendChild(msg);
    return;
  }

  var inStock = filtered.filter(function (r) { return (parseInt(r.stock, 10) || 0) > 0; });
  var outOfStock = filtered.filter(function (r) { return (parseInt(r.stock, 10) || 0) <= 0; });

  renderIngredientSection(catalog, 'In stock', inStock);

  if (inStock.length > 0 && outOfStock.length > 0) {
    var divider = document.createElement('div');
    divider.className = 'section-icon catalog-divider';
    var icon = document.createElement('img');
    icon.src = 'images/Icon_green.svg';
    icon.alt = '';
    icon.setAttribute('aria-hidden', 'true');
    divider.appendChild(icon);
    catalog.appendChild(divider);
  }

  renderIngredientSection(catalog, 'Out of stock', outOfStock, 'catalog-section--order');
}

function renderIngredientSection(catalog, title, items, extraClass) {
  if (items.length === 0) return;

  var wrapper = document.createElement('div');
  wrapper.className = 'catalog-section' + (extraClass ? ' ' + extraClass : '');

  var sectionHeader = document.createElement('div');
  sectionHeader.className = 'catalog-section-header';
  var heading = document.createElement('h2');
  heading.className = 'catalog-section-title';
  heading.textContent = title;
  sectionHeader.appendChild(heading);
  wrapper.appendChild(sectionHeader);

  var grid = document.createElement('div');
  grid.className = 'product-grid';

  items.forEach(function (item) {
    var card = document.createElement('div');
    card.className = 'product-card';

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardName = document.createElement('h4');
    cardName.textContent = item.name;
    header.appendChild(cardName);
    card.appendChild(header);

    // Unit + price detail row
    var unit = (item.unit || '').trim();
    var price = (item.price_per_unit || '').trim();
    if (unit || price) {
      var detailRow = document.createElement('div');
      detailRow.className = 'product-detail-row';
      var details = [];
      if (unit) details.push(unit);
      if (price) details.push(price.charAt(0) === '$' ? price : '$' + price);
      for (var d = 0; d < details.length; d++) {
        if (d > 0) {
          var sep = document.createElement('span');
          sep.className = 'detail-sep';
          sep.textContent = '\u00b7';
          detailRow.appendChild(sep);
        }
        var span = document.createElement('span');
        span.textContent = details[d];
        detailRow.appendChild(span);
      }
      card.appendChild(detailRow);
    }

    // Collapsible description (reusing product-notes pattern)
    if (item.description) {
      var notesWrap = document.createElement('div');
      notesWrap.className = 'product-notes';

      var notesToggle = document.createElement('button');
      notesToggle.type = 'button';
      notesToggle.className = 'product-notes-toggle';
      notesToggle.setAttribute('aria-expanded', 'false');
      notesToggle.innerHTML = 'More Information <span class="product-notes-chevron">&#9660;</span>';

      var notesBody = document.createElement('div');
      notesBody.className = 'product-notes-body';
      var notesP = document.createElement('p');
      notesP.textContent = item.description;
      notesBody.appendChild(notesP);

      notesToggle.addEventListener('click', (function (wrap, toggle) {
        return function () {
          var isOpen = wrap.classList.toggle('open');
          toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        };
      })(notesWrap, notesToggle));

      notesWrap.appendChild(notesToggle);
      notesWrap.appendChild(notesBody);
      card.appendChild(notesWrap);
    }

    // Stock badge
    var stockVal = parseInt(item.stock, 10) || 0;
    var badge = document.createElement('span');
    badge.className = 'stock-badge';
    if (stockVal > 0) {
      badge.classList.add('stock-badge--in');
      badge.textContent = 'In Stock';
    } else {
      badge.classList.add('stock-badge--out');
      badge.textContent = 'Out of Stock';
    }
    card.appendChild(badge);

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  catalog.appendChild(wrapper);
}

// ===== Services =====

var _allServices = [];

function loadServices(callback) {
  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SERVICES_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SERVICES_CSV_URL
    : null;

  var CACHE_KEY = 'sv-services-csv';
  var CACHE_TS_KEY = 'sv-services-csv-ts';
  var CACHE_TTL = 5 * 60 * 1000;

  function getCached() {
    try {
      var csv = localStorage.getItem(CACHE_KEY);
      var ts = parseInt(localStorage.getItem(CACHE_TS_KEY), 10) || 0;
      if (csv) return { csv: csv, fresh: (Date.now() - ts) < CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCached(csv) {
    try {
      localStorage.setItem(CACHE_KEY, csv);
      localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  var cached = getCached();
  var csvPromise;

  if (cached) {
    csvPromise = Promise.resolve(cached.csv);
    if (!cached.fresh) {
      var refreshUrl = csvUrl || 'content/services.csv';
      fetchCSV(refreshUrl).then(setCached).catch(function () {});
    }
  } else {
    csvPromise = csvUrl
      ? fetchCSV(csvUrl).catch(function () { return fetchCSV('content/services.csv'); })
      : fetchCSV('content/services.csv');
    csvPromise.then(setCached);
  }

  csvPromise
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      var headers = lines[0].split(',');
      _allServices = [];

      for (var i = 1; i < lines.length; i++) {
        var values = parseCSVLine(lines[i]);
        if (values.length < headers.length) continue;
        var obj = {};
        for (var j = 0; j < headers.length; j++) {
          obj[headers[j].trim()] = values[j].trim();
        }
        if (!obj.name && !obj.sku) continue;
        if (obj.hide && obj.hide.toLowerCase() === 'true') continue;
        _allServices.push(obj);
      }

      renderServices();
      wireServiceEvents();
      if (callback) callback();
    })
    .catch(function () {});
}

function wireServiceEvents() {
  var searchInput = document.getElementById('service-search');
  if (searchInput) {
    var timer;
    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(renderServices, 180);
    });
  }
}

function renderServices() {
  var catalog = document.getElementById('product-catalog');
  if (!catalog) return;

  var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider');
  sections.forEach(function (el) { el.parentNode.removeChild(el); });

  var searchInput = document.getElementById('service-search');
  var query = searchInput ? searchInput.value.toLowerCase() : '';

  var filtered = _allServices.filter(function (r) {
    if (!query) return true;
    var name = (r.name || '').toLowerCase();
    var desc = (r.desription || r.description || '').toLowerCase();
    return name.indexOf(query) !== -1 || desc.indexOf(query) !== -1;
  });

  if (filtered.length === 0) {
    var msg = document.createElement('p');
    msg.className = 'catalog-no-results';
    msg.textContent = 'No services found.';
    catalog.appendChild(msg);
    return;
  }

  var wrapper = document.createElement('div');
  wrapper.className = 'catalog-section';

  var sectionHeader = document.createElement('div');
  sectionHeader.className = 'catalog-section-header';
  var heading = document.createElement('h2');
  heading.className = 'catalog-section-title';
  heading.textContent = 'Our Services';
  sectionHeader.appendChild(heading);
  wrapper.appendChild(sectionHeader);

  var grid = document.createElement('div');
  grid.className = 'product-grid';

  filtered.forEach(function (svc) {
    var card = document.createElement('div');
    card.className = 'product-card';

    var header = document.createElement('div');
    header.className = 'product-card-header';
    var cardName = document.createElement('h4');
    cardName.textContent = svc.name;
    header.appendChild(cardName);
    card.appendChild(header);

    // Description (handles the typo column name)
    var descText = (svc.desription || svc.description || '').trim();
    if (descText) {
      var descEl = document.createElement('p');
      descEl.className = 'service-description';
      descEl.textContent = descText;
      card.appendChild(descEl);
    }

    // Price with optional discount
    var price = (svc.price || '').trim();
    var discount = parseFloat(svc.discount) || 0;

    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'product-discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    if (price) {
      var priceRow = document.createElement('div');
      priceRow.className = 'product-prices service-price';
      var priceBox = document.createElement('div');
      priceBox.className = 'product-price-box';

      if (discount > 0) {
        var priceNum = parseFloat(price.replace(/[^0-9.]/g, ''));
        var salePrice = (priceNum * (1 - discount / 100)).toFixed(2);
        priceBox.innerHTML = '<span class="product-price-label">Price</span><span class="product-price-original">' + (price.charAt(0) === '$' ? price : '$' + price) + '</span><span class="product-price-value">$' + salePrice + '</span>';
      } else {
        priceBox.innerHTML = '<span class="product-price-label">Price</span><span class="product-price-value">' + (price.charAt(0) === '$' ? price : '$' + price) + '</span>';
      }

      priceRow.appendChild(priceBox);
      card.appendChild(priceRow);
    }

    grid.appendChild(card);
  });

  wrapper.appendChild(grid);
  catalog.appendChild(wrapper);
}

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

// ===== Reservation System =====

var RESERVATION_KEY = 'sv-reservation';

function getReservation() {
  try {
    return JSON.parse(localStorage.getItem(RESERVATION_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveReservation(items) {
  localStorage.setItem(RESERVATION_KEY, JSON.stringify(items));
}

function getReservedQty(productKey) {
  var items = getReservation();
  for (var i = 0; i < items.length; i++) {
    if ((items[i].name + '|' + items[i].brand) === productKey) {
      return items[i].qty || 1;
    }
  }
  return 0;
}

function isReserved(productKey) {
  return getReservedQty(productKey) > 0;
}

function setReservationQty(product, qty) {
  var items = getReservation();
  var key = product.name + '|' + product.brand;
  var idx = -1;
  for (var i = 0; i < items.length; i++) {
    if ((items[i].name + '|' + items[i].brand) === key) {
      idx = i;
      break;
    }
  }

  if (qty <= 0) {
    if (idx !== -1) items.splice(idx, 1);
  } else if (idx !== -1) {
    items[idx].qty = qty;
  } else {
    var effectiveStock = (product.available !== undefined && product.available !== '')
      ? parseInt(product.available, 10) || 0
      : parseInt(product.stock, 10) || 0;
    items.push({
      name: product.name,
      brand: product.brand,
      price: product.retail_instore || product.retail_kit || '',
      discount: product.discount || '',
      stock: effectiveStock,
      time: product.time || '',
      qty: qty
    });
  }

  saveReservation(items);
  updateReservationBar();
}

function renderReserveControl(wrap, product, productKey) {
  wrap.innerHTML = '';
  var qty = getReservedQty(productKey);

  if (qty === 0) {
    var reserveBtn = document.createElement('button');
    reserveBtn.type = 'button';
    reserveBtn.className = 'product-reserve-btn';
    reserveBtn.textContent = 'Reserve';
    reserveBtn.addEventListener('click', function () {
      setReservationQty(product, 1);
      trackEvent('reserve', product.sku || '', product.name || '');
      renderReserveControl(wrap, product, productKey);
    });
    wrap.appendChild(reserveBtn);
  } else {
    var controls = document.createElement('div');
    controls.className = 'product-qty-controls';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.addEventListener('click', function () {
      setReservationQty(product, qty - 1);
      renderReserveControl(wrap, product, productKey);
    });

    var qtySpan = document.createElement('span');
    qtySpan.className = 'qty-value';
    qtySpan.textContent = qty;

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', function () {
      setReservationQty(product, qty + 1);
      renderReserveControl(wrap, product, productKey);
    });

    controls.appendChild(minusBtn);
    controls.appendChild(qtySpan);
    controls.appendChild(plusBtn);
    wrap.appendChild(controls);
  }
}

function initReservationBar() {
  var barHTML = '<div class="container">' +
    '<span class="reservation-bar-count"></span>' +
    '<a href="reservation.html" class="reservation-bar-link">Confirm Reservation &rarr;</a>' +
    '</div>';

  // Fixed bar at bottom of viewport
  var bar = document.createElement('div');
  bar.className = 'reservation-bar hidden';
  bar.id = 'reservation-bar';
  bar.innerHTML = barHTML;
  document.body.appendChild(bar);

  // Inline bar at bottom of catalog
  var catalog = document.getElementById('product-catalog');
  if (catalog) {
    var inlineBar = document.createElement('div');
    inlineBar.className = 'reservation-bar reservation-bar-inline hidden';
    inlineBar.id = 'reservation-bar-inline';
    inlineBar.innerHTML = barHTML;
    catalog.parentNode.insertBefore(inlineBar, catalog);
  }

  updateReservationBar();
}

function updateReservationBar() {
  var bars = document.querySelectorAll('.reservation-bar');
  if (bars.length === 0) return;
  var items = getReservation();
  var total = 0;
  items.forEach(function (item) { total += (item.qty || 1); });
  var label = total + (total === 1 ? ' kit selected' : ' kits selected');
  for (var i = 0; i < bars.length; i++) {
    var countEl = bars[i].querySelector('.reservation-bar-count');
    if (total > 0) {
      bars[i].classList.remove('hidden');
      if (countEl) countEl.textContent = label;
    } else {
      bars[i].classList.add('hidden');
    }
  }
}

// ===== Reservation Page =====

function initReservationPage() {
  renderReservationItems();
  loadTimeslots();
  setupReservationForm();
}

function refreshReservationDependents() {
  loadTimeslots();
  var selected = document.querySelector('input[name="timeslot"]:checked');
  if (selected) {
    updateCompletionEstimate(selected.value);
  } else {
    var estimateEl = document.getElementById('completion-estimate');
    if (estimateEl) estimateEl.style.display = 'none';
  }
}

function renderReservationItems() {
  var container = document.getElementById('reservation-items');
  var emptyMsg = document.getElementById('reservation-empty');
  if (!container) return;

  var items = getReservation();
  container.innerHTML = '';

  if (items.length === 0) {
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  items.forEach(function (item) {
    var row = document.createElement('div');
    row.className = 'reservation-item';

    var info = document.createElement('div');
    info.className = 'reservation-item-info';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'reservation-item-name';
    nameSpan.textContent = item.name;
    info.appendChild(nameSpan);

    var brandSpan = document.createElement('span');
    brandSpan.className = 'reservation-item-brand';
    brandSpan.textContent = item.brand;
    info.appendChild(brandSpan);

    if (item.time) {
      var timeSpan = document.createElement('span');
      timeSpan.className = 'reservation-item-time';
      timeSpan.textContent = item.time;
      info.appendChild(timeSpan);
    }

    if (item.price) {
      var priceSpan = document.createElement('span');
      priceSpan.className = 'reservation-item-price';
      var displayPrice = item.price;
      if (item.discount && parseFloat(item.discount) > 0) {
        var origNum = parseFloat((item.price || '0').replace('$', '')) || 0;
        var disc = parseFloat(item.discount);
        var saleNum = (origNum * (1 - disc / 100)).toFixed(2);
        displayPrice = '$' + saleNum;
      }
      priceSpan.textContent = displayPrice;
      info.appendChild(priceSpan);
    }

    if (item.discount && parseFloat(item.discount) > 0) {
      var discBadge = document.createElement('span');
      discBadge.className = 'reservation-item-discount';
      discBadge.textContent = Math.round(parseFloat(item.discount)) + '% OFF';
      info.appendChild(discBadge);
    }

    // Stock status badge
    var stockNum = parseInt(item.stock, 10) || 0;
    var stockBadge = document.createElement('span');
    stockBadge.className = 'reservation-item-stock';
    if (stockNum > 0) {
      stockBadge.classList.add('reservation-item-stock--available');
      stockBadge.textContent = 'In Stock';
    } else {
      stockBadge.classList.add('reservation-item-stock--order');
      stockBadge.textContent = 'Needs Ordering';
    }
    info.appendChild(stockBadge);

    row.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'reservation-item-actions';

    var qtyControls = document.createElement('div');
    qtyControls.className = 'product-qty-controls';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        for (var i = 0; i < current.length; i++) {
          if ((current[i].name + '|' + current[i].brand) === (itm.name + '|' + itm.brand)) {
            current[i].qty = (current[i].qty || 1) - 1;
            if (current[i].qty <= 0) current.splice(i, 1);
            break;
          }
        }
        saveReservation(current);
        renderReservationItems();
        refreshReservationDependents();
      };
    })(item));

    var qtySpan = document.createElement('span');
    qtySpan.className = 'qty-value';
    qtySpan.textContent = item.qty || 1;

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        for (var i = 0; i < current.length; i++) {
          if ((current[i].name + '|' + current[i].brand) === (itm.name + '|' + itm.brand)) {
            current[i].qty = (current[i].qty || 1) + 1;
            break;
          }
        }
        saveReservation(current);
        renderReservationItems();
        refreshReservationDependents();
      };
    })(item));

    qtyControls.appendChild(minusBtn);
    qtyControls.appendChild(qtySpan);
    qtyControls.appendChild(plusBtn);
    actions.appendChild(qtyControls);

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'reservation-item-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      var current = getReservation();
      var filtered = current.filter(function (r) {
        return (r.name + '|' + r.brand) !== (item.name + '|' + item.brand);
      });
      saveReservation(filtered);
      renderReservationItems();
      refreshReservationDependents();
    });
    actions.appendChild(removeBtn);

    row.appendChild(actions);

    container.appendChild(row);
  });

  // Subtotal (accounts for discount if stored)
  var subtotal = 0;
  items.forEach(function (item) {
    var price = parseFloat((item.price || '0').replace('$', '')) || 0;
    var disc = parseFloat(item.discount) || 0;
    if (disc > 0) price = price * (1 - disc / 100);
    subtotal += price * (item.qty || 1);
  });

  var subtotalRow = document.createElement('div');
  subtotalRow.className = 'reservation-subtotal';
  subtotalRow.innerHTML = '<span>Estimated Subtotal <span class="reservation-disclaimer">— Final pricing may vary.</span></span><span>$' + subtotal.toFixed(2) + '</span>';
  container.appendChild(subtotalRow);

  // Clear All button
  var clearWrap = document.createElement('div');
  clearWrap.className = 'reservation-clear-wrap';
  var clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn-secondary reservation-clear-btn';
  clearBtn.textContent = 'Clear Selected Items';
  clearBtn.addEventListener('click', function () {
    saveReservation([]);
    renderReservationItems();
    refreshReservationDependents();
  });
  clearWrap.appendChild(clearBtn);
  container.appendChild(clearWrap);
}

function loadTimeslots() {
  var container = document.getElementById('timeslot-groups');
  if (!container) return;

  var scheduleUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_SCHEDULE_CSV_URL
    : 'content/timeslots.csv';
  fetch(scheduleUrl)
    .then(function (res) { return res.text(); })
    .then(function (csv) {
      var lines = csv.trim().split('\n');
      if (lines.length < 2) return;

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

      // Filter to available slots only (schedule sheet includes all statuses)
      slots = slots.filter(function (s) {
        return !s.status || s.status === 'available';
      });

      // Check if any reserved item is out of stock
      var reservedItems = getReservation();
      var hasOutOfStock = reservedItems.some(function (item) {
        return (item.stock || 0) === 0;
      });

      // If out-of-stock items exist, calculate 2-week cutoff
      var twoWeekCutoff = null;
      if (hasOutOfStock) {
        twoWeekCutoff = new Date();
        twoWeekCutoff.setDate(twoWeekCutoff.getDate() + 14);
        twoWeekCutoff.setHours(0, 0, 0, 0);
      }

      // Group by date
      var slotsByDate = {};
      slots.forEach(function (slot) {
        if (!slotsByDate[slot.date]) {
          slotsByDate[slot.date] = [];
        }
        slotsByDate[slot.date].push(slot);
      });

      // Find all months that have data
      var allDates = Object.keys(slotsByDate).sort();
      if (allDates.length === 0) return;

      var firstDate = new Date(allDates[0] + 'T00:00:00');
      var lastDate = new Date(allDates[allDates.length - 1] + 'T00:00:00');

      // Build list of months (year-month) that have slots
      var monthsWithSlots = [];
      allDates.forEach(function (d) {
        var ym = d.substring(0, 7); // "YYYY-MM"
        if (monthsWithSlots.indexOf(ym) === -1) {
          monthsWithSlots.push(ym);
        }
      });
      monthsWithSlots.sort();

      // Start calendar at the current month (or first available if current month has no slots)
      var nowYM = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
      var currentMonthIndex = 0;
      for (var mi = 0; mi < monthsWithSlots.length; mi++) {
        if (monthsWithSlots[mi] >= nowYM) {
          currentMonthIndex = mi;
          break;
        }
        // If all months are before now, stay at the last one
        currentMonthIndex = mi;
      }

      container.innerHTML = '';

      // Notice for out-of-stock cutoff
      if (hasOutOfStock) {
        var notice = document.createElement('p');
        notice.className = 'timeslot-notice';
        notice.textContent = 'Some of your selected items need to be ordered in. Timeslots within the next 2 weeks are not available.';
        container.appendChild(notice);
      }

      // Calendar wrapper
      var cal = document.createElement('div');
      cal.className = 'cal';
      container.appendChild(cal);

      // Slots area below calendar
      var slotsArea = document.createElement('div');
      slotsArea.className = 'cal-slots';
      container.appendChild(slotsArea);

      var selectedDate = null;

      function renderCalendar() {
        cal.innerHTML = '';
        var ym = monthsWithSlots[currentMonthIndex];
        var year = parseInt(ym.substring(0, 4), 10);
        var month = parseInt(ym.substring(5, 7), 10) - 1; // 0-indexed

        // Header with arrows
        var header = document.createElement('div');
        header.className = 'cal-header';

        var prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'cal-nav';
        prevBtn.textContent = '\u2039';
        prevBtn.disabled = currentMonthIndex === 0;
        prevBtn.addEventListener('click', function () {
          if (currentMonthIndex > 0) {
            currentMonthIndex--;
            renderCalendar();
          }
        });

        var title = document.createElement('span');
        title.className = 'cal-title';
        var monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
          'July', 'August', 'September', 'October', 'November', 'December'];
        title.textContent = monthNames[month] + ' ' + year;

        var nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'cal-nav';
        nextBtn.textContent = '\u203A';
        nextBtn.disabled = currentMonthIndex === monthsWithSlots.length - 1;
        nextBtn.addEventListener('click', function () {
          if (currentMonthIndex < monthsWithSlots.length - 1) {
            currentMonthIndex++;
            renderCalendar();
          }
        });

        header.appendChild(prevBtn);
        header.appendChild(title);
        header.appendChild(nextBtn);
        cal.appendChild(header);

        // Day-of-week headers
        var grid = document.createElement('div');
        grid.className = 'cal-grid';
        var dowLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        dowLabels.forEach(function (d) {
          var dow = document.createElement('div');
          dow.className = 'cal-dow';
          dow.textContent = d;
          grid.appendChild(dow);
        });

        // Calendar days
        var firstOfMonth = new Date(year, month, 1);
        var startDow = firstOfMonth.getDay(); // 0=Sun
        var daysInMonth = new Date(year, month + 1, 0).getDate();

        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var todayStr = today.getFullYear() + '-' +
          String(today.getMonth() + 1).padStart(2, '0') + '-' +
          String(today.getDate()).padStart(2, '0');

        // Leading empty cells
        for (var e = 0; e < startDow; e++) {
          var empty = document.createElement('div');
          empty.className = 'cal-day cal-day--disabled';
          grid.appendChild(empty);
        }

        for (var d = 1; d <= daysInMonth; d++) {
          var dateStr = year + '-' + String(month + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
          var cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'cal-day';
          cell.textContent = d;
          cell.setAttribute('data-date', dateStr);

          var cellDate = new Date(dateStr + 'T00:00:00');
          var isPast = cellDate < today;
          var hasSlots = !!slotsByDate[dateStr];
          var hasAvailable = hasSlots && slotsByDate[dateStr].some(function (s) {
            return s.status === 'available';
          });
          var withinCutoff = twoWeekCutoff && cellDate < twoWeekCutoff;

          if (dateStr === todayStr) {
            cell.classList.add('cal-day--today');
          }

          if (dateStr === selectedDate) {
            cell.classList.add('cal-day--selected');
          }

          if (isPast || !hasSlots || withinCutoff) {
            cell.classList.add('cal-day--disabled');
            cell.disabled = true;
            if (!isPast && !hasSlots && !withinCutoff) {
              cell.classList.add('cal-day--closed');
              var closedLabel = document.createElement('span');
              closedLabel.className = 'cal-day-closed';
              closedLabel.textContent = 'Closed';
              cell.appendChild(closedLabel);
            }
          } else if (hasAvailable) {
            cell.classList.add('cal-day--available');
          } else {
            // Has slots but all booked
            cell.classList.add('cal-day--full');
          }

          (function (ds) {
            cell.addEventListener('click', function () {
              selectedDate = ds;
              renderCalendar();
              renderDaySlots(ds);
            });
          })(dateStr);

          grid.appendChild(cell);
        }

        cal.appendChild(grid);
      }

      var radioIndex = 0;

      function renderDaySlots(dateStr) {
        slotsArea.innerHTML = '';
        var daySlots = slotsByDate[dateStr];
        if (!daySlots) return;

        var dateObj = new Date(dateStr + 'T00:00:00');
        var heading = document.createElement('h3');
        heading.className = 'cal-slots-heading';
        heading.textContent = dateObj.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        });
        slotsArea.appendChild(heading);

        var grid = document.createElement('div');
        grid.className = 'cal-slots-grid';

        daySlots.forEach(function (slot) {
          var option = document.createElement('div');
          option.className = 'timeslot-option';
          var unavailable = slot.status === 'booked';
          if (unavailable) {
            option.classList.add('booked');
          }

          var id = 'timeslot-' + radioIndex;
          radioIndex++;

          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'timeslot';
          radio.id = id;
          radio.value = dateStr + ' ' + slot.time;
          if (unavailable) {
            radio.disabled = true;
          }

          var label = document.createElement('label');
          label.setAttribute('for', id);
          label.textContent = slot.time;

          option.appendChild(radio);
          option.appendChild(label);
          grid.appendChild(option);
        });

        slotsArea.appendChild(grid);
      }

      renderCalendar();

      // Attach listener for completion estimate
      container.addEventListener('change', function (e) {
        if (e.target.name === 'timeslot') {
          updateCompletionEstimate(e.target.value);
        }
      });
    })
    .catch(function () {
      container.innerHTML = '<p>Unable to load timeslots.</p>';
    });
}

function updateCompletionEstimate(timeslotValue) {
  var estimateEl = document.getElementById('completion-estimate');
  var textEl = document.getElementById('completion-estimate-text');
  if (!estimateEl || !textEl) return;

  var items = getReservation();
  if (items.length === 0) {
    estimateEl.style.display = 'none';
    return;
  }

  // Find the longest brew time (in weeks) among reserved items
  var maxWeeks = 0;
  items.forEach(function (item) {
    var weeks = parseInt(item.time, 10);
    if (!isNaN(weeks) && weeks > maxWeeks) {
      maxWeeks = weeks;
    }
  });

  if (maxWeeks === 0) {
    estimateEl.style.display = 'none';
    return;
  }

  // Parse the date portion of the timeslot value (e.g. "2026-02-15 10:00 AM")
  var datePart = timeslotValue.split(' ')[0];
  var startDate = new Date(datePart + 'T00:00:00');
  if (isNaN(startDate.getTime())) {
    estimateEl.style.display = 'none';
    return;
  }

  var weekStart = new Date(startDate);
  weekStart.setDate(weekStart.getDate() + (maxWeeks * 7));
  var weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  var opts = { month: 'long', day: 'numeric' };
  var startStr = weekStart.toLocaleDateString('en-US', opts);
  var endOpts = weekStart.getMonth() === weekEnd.getMonth() ? { day: 'numeric' } : opts;
  var endStr = weekEnd.toLocaleDateString('en-US', endOpts);
  var yearStr = weekEnd.getFullYear();

  textEl.textContent = 'Estimated ready the week of ' + startStr + '–' + endStr + ', ' + yearStr
    + ' (approximately ' + maxWeeks + ' week' + (maxWeeks !== 1 ? 's' : '')
    + ' from your appointment). This is an estimate — actual times may vary.';
  estimateEl.style.display = '';
}

// Google Form placeholder values — replace with your actual form URL and entry IDs
var GOOGLE_FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc-m7i0zWKTkT11nF1an6PXdR6JejpJNvDJOYPBkxz4wOYO9A/formResponse';
var GOOGLE_FORM_FIELDS = {
  name: 'entry.1466333029',
  email: 'entry.763864451',
  phone: 'entry.304343590',
  products: 'entry.1291378806',
  timeslot: 'entry.286083838'
};

function setupReservationForm() {
  var form = document.getElementById('reservation-form');
  if (!form) return;

  // Record page load time for bot detection
  var loadedAtField = document.getElementById('res-loaded-at');
  if (loadedAtField) loadedAtField.value = String(Date.now());

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    // Bot check: honeypot field should be empty
    var honeypot = document.getElementById('res-website');
    if (honeypot && honeypot.value) return;

    // Bot check: form submitted too fast (under 3 seconds)
    var loadedAt = parseInt(document.getElementById('res-loaded-at').value, 10) || 0;
    if (Date.now() - loadedAt < 3000) return;

    var items = getReservation();
    if (items.length === 0) {
      alert('Please add at least one product to your reservation.');
      return;
    }

    var selectedTimeslot = document.querySelector('input[name="timeslot"]:checked');
    if (!selectedTimeslot) {
      alert('Please select a timeslot.');
      return;
    }

    var name = document.getElementById('res-name').value.trim();
    var email = document.getElementById('res-email').value.trim();
    var phone = document.getElementById('res-phone').value.trim();

    var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      alert('Please enter a valid email address.');
      return;
    }

    var phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      alert('Please enter a valid phone number (at least 10 digits).');
      return;
    }

    var productNames = items.map(function (item) {
      var q = item.qty || 1;
      return item.name + (q > 1 ? ' x' + q : '');
    }).join(', ');
    var timeslot = selectedTimeslot.value;

    // Build hidden form for Google Form submission
    var hiddenForm = document.createElement('form');
    hiddenForm.method = 'POST';
    hiddenForm.action = GOOGLE_FORM_URL;
    hiddenForm.target = 'reservation-iframe';
    hiddenForm.style.display = 'none';

    var fields = [
      { name: GOOGLE_FORM_FIELDS.name, value: name },
      { name: GOOGLE_FORM_FIELDS.email, value: email },
      { name: GOOGLE_FORM_FIELDS.phone, value: phone },
      { name: GOOGLE_FORM_FIELDS.products, value: productNames },
      { name: GOOGLE_FORM_FIELDS.timeslot, value: timeslot }
    ];

    fields.forEach(function (f) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = f.name;
      input.value = f.value;
      hiddenForm.appendChild(input);
    });

    document.body.appendChild(hiddenForm);
    hiddenForm.submit();
    document.body.removeChild(hiddenForm);

    // Show confirmation
    localStorage.removeItem(RESERVATION_KEY);
    document.getElementById('reservation-list').style.display = 'none';
    document.getElementById('timeslot-picker').style.display = 'none';
    document.getElementById('reservation-form-section').style.display = 'none';
    document.getElementById('reservation-confirm').style.display = '';
  });
}

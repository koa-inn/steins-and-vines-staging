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
  document.addEventListener('click', function () {
    var openTips = document.querySelectorAll('.product-notes-tooltip.show');
    openTips.forEach(function (tip) { tip.classList.remove('show'); });
  });

  // Content loader — reads data-page on <body> and fetches the matching JSON
  var page = document.body.getAttribute('data-page');
  if (page) {
    fetch('content/' + page + '.json')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var els = document.querySelectorAll('[data-content]');
        els.forEach(function (el) {
          var key = el.getAttribute('data-content');
          if (data[key] !== undefined) {
            el.textContent = data[key];
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
  }

  // Reservation page
  if (page === 'reservation') {
    initReservationPage();
  }
});

function loadProducts() {
  var allProducts = [];
  var userHasSorted = false;
  var activeFilters = { type: [], brand: [], subcategory: [], time: [] };

  var csvUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.PUBLISHED_CSV_URL)
    ? SHEETS_CONFIG.PUBLISHED_CSV_URL
    : null;

  var CSV_CACHE_KEY = 'sv-products-csv';
  var CSV_CACHE_TS_KEY = 'sv-products-csv-ts';
  var CSV_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  function fetchCSV(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    });
  }

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
      applyFilters();

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

        if (product.tasting_notes) {
          var notes = document.createElement('div');
          notes.className = 'product-notes-tooltip';
          notes.textContent = product.tasting_notes;
          header.appendChild(notes);

          var notesBtn = document.createElement('button');
          notesBtn.type = 'button';
          notesBtn.className = 'product-notes-btn';
          notesBtn.setAttribute('aria-label', 'Tasting notes');
          notesBtn.innerHTML = '&#x1f50d;';
          notesBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var openTips = document.querySelectorAll('.product-notes-tooltip.show');
            openTips.forEach(function (tip) {
              if (tip !== notes) tip.classList.remove('show');
            });
            notes.classList.toggle('show');
          });
          header.appendChild(notesBtn);
        }

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

        var instore = (product.retail_instore || '').trim();
        var kit = (product.retail_kit || '').trim();
        if (instore || kit) {
          var priceRow = document.createElement('div');
          priceRow.className = 'product-prices';
          if (instore) {
            var instoreBox = document.createElement('div');
            instoreBox.className = 'product-price-box';
            instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + instore + '</span>';
            priceRow.appendChild(instoreBox);
          }
          if (kit) {
            var kitBox = document.createElement('div');
            kitBox.className = 'product-price-box';
            kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + kit + '</span>';
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

    if (item.price) {
      var priceSpan = document.createElement('span');
      priceSpan.className = 'reservation-item-price';
      priceSpan.textContent = item.price;
      info.appendChild(priceSpan);
    }

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

  // Subtotal
  var subtotal = 0;
  items.forEach(function (item) {
    var price = parseFloat((item.price || '0').replace('$', '')) || 0;
    subtotal += price * (item.qty || 1);
  });

  var subtotalRow = document.createElement('div');
  subtotalRow.className = 'reservation-subtotal';
  subtotalRow.innerHTML = '<span>Estimated Subtotal <span class="reservation-disclaimer">— Final pricing may vary.</span></span><span>$' + subtotal.toFixed(2) + '</span>';
  container.appendChild(subtotalRow);
}

function loadTimeslots() {
  var container = document.getElementById('timeslot-groups');
  if (!container) return;

  fetch('content/timeslots.csv')
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

      var currentMonthIndex = 0;

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
  products: 'entry.286083838',
  timeslot: 'entry.1291378806'
};

function setupReservationForm() {
  var form = document.getElementById('reservation-form');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();

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

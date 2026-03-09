function initProductTabs() {
  var tabs = document.getElementById('product-tabs');
  if (!tabs) return;

  tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.product-tab-btn');
    if (!btn) return;

    var tab = btn.getAttribute('data-product-tab');

    // On dedicated tab pages, clicking a tab navigates to that tab's URL
    var currentPage = document.body.getAttribute('data-page');
    var DEDICATED_TAB_PAGES = ['ferment-in-store', 'ingredients-supplies'];
    if (DEDICATED_TAB_PAGES.indexOf(currentPage) !== -1) {
      var TAB_URLS = {
        'kits': '/products/ferment-in-store.html',
        'ingredients': '/products/ingredients-supplies.html'
      };
      if (TAB_URLS[tab] && location.pathname !== TAB_URLS[tab]) {
        location.href = TAB_URLS[tab];
        return;
      }
    }

    _activeCartTab = tab;

    // Swap active button
    var allBtns = tabs.querySelectorAll('.product-tab-btn');
    allBtns.forEach(function (b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Show/hide controls
    var controlIds = ['catalog-controls-kits', 'catalog-controls-ingredients'];
    controlIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    var activeControls = document.getElementById('catalog-controls-' + tab);
    if (activeControls) activeControls.classList.remove('hidden');

    // Sync view mode to the new tab's preference
    catalogViewMode = getCatalogViewMode(tab);
    syncToggleButtons(catalogViewMode);

    // Show/hide tab-specific notes
    var millNote = document.getElementById('ingredients-mill-note');
    if (millNote) millNote.classList.toggle('hidden', tab !== 'ingredients');
    var pickupNote = document.getElementById('ingredients-pickup-note');
    if (pickupNote) pickupNote.classList.toggle('hidden', tab !== 'ingredients');

    var batchNote = document.getElementById('kits-batch-note');
    if (batchNote) batchNote.classList.toggle('hidden', tab !== 'kits');
    var processNote = document.getElementById('kits-process-note');
    if (processNote) processNote.classList.toggle('hidden', tab !== 'kits');
    var priceNote = document.getElementById('kits-price-note');
    if (priceNote) priceNote.classList.toggle('hidden', tab !== 'kits');
    var guaranteeNote = document.getElementById('kits-guarantee-note');
    if (guaranteeNote) guaranteeNote.classList.toggle('hidden', tab !== 'kits');

    // Always show reservation bar if there are items
    updateReservationBar();

    // Clear rendered catalog sections
    var catalog = document.getElementById('product-catalog');
    if (catalog) {
      var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid, .product-request-section');
      sections.forEach(function (el) { el.parentNode.removeChild(el); });
    }

    // Load the appropriate tab
    if (tab === 'kits') {
      if (applyKitsFilters) {
        applyKitsFilters();
      } else {
        // Products still loading — show skeletons so the user sees loading state
        if (catalog) showCatalogSkeletons(catalog, 6);
      }
    } else if (tab === 'ingredients') {
      if (_allIngredients.length === 0) {
        if (catalog) showCatalogSkeletons(catalog, 8);
        loadIngredients(function () {});
      } else {
        renderIngredients();
      }
    }
  });

  // Arrow key navigation between tabs (WAI-ARIA tabs pattern)
  tabs.addEventListener('keydown', function (e) {
    var allBtns = Array.prototype.slice.call(tabs.querySelectorAll('.product-tab-btn'));
    var idx = allBtns.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === 'ArrowRight') {
      allBtns[(idx + 1) % allBtns.length].focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      allBtns[(idx - 1 + allBtns.length) % allBtns.length].focus();
      e.preventDefault();
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

function initAboutTabs() {
  var tabs = document.getElementById('about-tabs');
  if (!tabs) return;

  var servicesLoaded = false;

  tabs.addEventListener('click', function (e) {
    var btn = e.target.closest('.product-tab-btn');
    if (!btn) return;
    var tab = btn.getAttribute('data-about-tab');

    var allBtns = tabs.querySelectorAll('.product-tab-btn');
    allBtns.forEach(function (b) {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    ['info', 'story', 'services'].forEach(function (name) {
      var panel = document.getElementById('about-panel-' + name);
      if (panel) panel.classList.toggle('hidden', name !== tab);
    });

    if (tab === 'services') {
      catalogViewMode = getCatalogViewMode('services');
      syncToggleButtons(catalogViewMode);
      if (!servicesLoaded) {
        servicesLoaded = true;
        loadServices(function () {});
      } else {
        renderServices();
      }
    }
  });

  // Arrow key navigation between tabs (WAI-ARIA tabs pattern)
  tabs.addEventListener('keydown', function (e) {
    var allBtns = Array.prototype.slice.call(tabs.querySelectorAll('.product-tab-btn'));
    var idx = allBtns.indexOf(document.activeElement);
    if (idx === -1) return;
    if (e.key === 'ArrowRight') {
      allBtns[(idx + 1) % allBtns.length].focus();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      allBtns[(idx - 1 + allBtns.length) % allBtns.length].focus();
      e.preventDefault();
    }
  });

  // ?tab= deep linking (e.g. about.html?tab=services)
  var params = new URLSearchParams(window.location.search);
  var initTab = params.get('tab');
  if (initTab) {
    var targetBtn = tabs.querySelector('[data-about-tab="' + initTab + '"]');
    if (targetBtn) targetBtn.click();
  }
}

// ===== Ingredients & Supplies =====

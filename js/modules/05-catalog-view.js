// Reference to kits applyFilters so tab switcher can re-render
var applyKitsFilters = null;

// ===== Catalog View Toggle =====
var catalogViewDefaults = { kits: 'cards', ingredients: 'table', services: 'cards' };
var catalogViewMode = 'cards'; // active tab's current mode

function getCatalogViewMode(tab) {
  var stored = localStorage.getItem('catalogViewMode-' + tab);
  return stored || catalogViewDefaults[tab] || 'cards';
}

function syncToggleButtons(view) {
  var allToggleBtns = document.querySelectorAll('.view-toggle-btn');
  allToggleBtns.forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-view') === view);
  });
}

function initCatalogViewToggle() {
  var allToggleBtns = document.querySelectorAll('.view-toggle-btn');
  // Set initial mode from the active tab (defaults to kits)
  var activeTab = document.querySelector('.product-tab-btn.active');
  var tab = activeTab ? activeTab.getAttribute('data-product-tab') : 'kits';
  catalogViewMode = getCatalogViewMode(tab);
  syncToggleButtons(catalogViewMode);

  allToggleBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var view = btn.getAttribute('data-view');
      if (view === catalogViewMode) return;
      catalogViewMode = view;
      // Save per-tab preference
      var curTab = document.querySelector('.product-tab-btn.active');
      var tabKey = curTab ? curTab.getAttribute('data-product-tab') : 'kits';
      localStorage.setItem('catalogViewMode-' + tabKey, view);
      syncToggleButtons(view);
      // Re-render the active tab
      if (tabKey === 'kits') {
        if (applyKitsFilters) applyKitsFilters();
      } else if (tabKey === 'ingredients') {
        renderIngredients();
      } else if (tabKey === 'services') {
        renderServices();
      }
    });
  });
}

function equalizeCardHeights() {
  var grids = document.querySelectorAll('.product-grid');
  grids.forEach(function (grid) {
    var cards = Array.prototype.slice.call(grid.children);
    // Reset min-heights (write) so we measure natural size
    cards.forEach(function (c) { c.style.minHeight = ''; });
    // Batch reads then writes via rAF to avoid layout thrashing
    requestAnimationFrame(function () {
      var rows = {};
      // Read phase: measure all cards
      cards.forEach(function (card) {
        var top = card.offsetTop;
        if (!rows[top]) rows[top] = [];
        rows[top].push({ el: card, h: card.offsetHeight });
      });
      // Write phase: set min-heights per row
      Object.keys(rows).forEach(function (top) {
        var row = rows[top];
        if (row.length < 2) return;
        var max = row.reduce(function (m, c) { return Math.max(m, c.h); }, 0);
        row.forEach(function (c) { c.el.style.minHeight = max + 'px'; });
      });
    });
  });
}

var _eqResizeTimer;
window.addEventListener('resize', function () {
  clearTimeout(_eqResizeTimer);
  _eqResizeTimer = setTimeout(equalizeCardHeights, 150);
});

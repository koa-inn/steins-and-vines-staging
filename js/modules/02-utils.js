// ===== Deep-link (?item=SKU) =====

var _deepLinkHandled = false;

function handleDeepLinkedItem() {
  if (_deepLinkHandled) return;
  var sku = (new URLSearchParams(window.location.search)).get('item');
  if (!sku) return;
  var el = document.querySelector('[data-sku="' + sku + '"]');
  if (!el) return;

  _deepLinkHandled = true;

  // Open notes / description toggle
  var notesWrap = el.querySelector('.notes-wrap') || el.querySelector('.product-notes');
  if (notesWrap && !notesWrap.classList.contains('open')) {
    notesWrap.classList.add('open');
    var toggleBtn = notesWrap.querySelector('button');
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
  }

  // Table-view: open the sibling detail row directly (no click needed)
  if (el.tagName === 'TR') {
    var detailRow = el.nextElementSibling;
    if (detailRow && detailRow.classList.contains('table-detail-row')) {
      detailRow.classList.add('open');
      var chev = el.querySelector('.table-expand-chevron');
      if (chev) chev.classList.add('open');
      el.classList.add('expanded');
    }
  }

  // Highlight ring then scroll into view
  el.classList.add('deep-link-highlight');
  setTimeout(function () {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 150);
}

function buildProductLinkBtn(sku) {
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'product-link-btn';
  btn.title = 'Copy link to this product';
  btn.setAttribute('aria-label', 'Copy link to this product');
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    var url = location.origin + location.pathname + '?item=' + encodeURIComponent(sku);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        btn.classList.add('product-link-btn--copied');
        setTimeout(function () { btn.classList.remove('product-link-btn--copied'); }, 2000);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btn.classList.add('product-link-btn--copied');
      setTimeout(function () { btn.classList.remove('product-link-btn--copied'); }, 2000);
    }
  });
  return btn;
}

// ===== Toast Notifications =====
function showToast(message, type) {
  var container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  var toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' toast--' + type : '');
  toast.textContent = message;
  container.appendChild(toast);
  // Trigger reflow then animate in
  toast.offsetHeight;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
    setTimeout(function () { toast.remove(); }, 300);
  }, 3500);
}

// Escape HTML entities for safe interpolation
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== Responsive Product Image Helper =====

function setResponsiveImg(img, sku) {
  img.src = 'images/products/' + sku + '.png';
  img.width = 400;
  img.height = 400;
  img.srcset = 'images/products/' + sku + '-400w.webp 400w, images/products/' + sku + '-800w.webp 800w';
  img.sizes = '(max-width: 768px) 45vw, 200px';
}

// Shared CSV fetch helper — used by all tab loaders
function fetchCSV(url) {
  return fetch(url).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  });
}

// Skeleton loading helper — creates placeholder cards that mimic real layout
function createSkeletonCard() {
  var card = document.createElement('div');
  card.className = 'skeleton-card';
  card.innerHTML =
    '<div class="skeleton-element skeleton-brand"></div>' +
    '<div class="skeleton-element skeleton-ornament"></div>' +
    '<div class="skeleton-element skeleton-title"></div>' +
    '<div class="skeleton-element skeleton-vintage"></div>' +
    '<div class="skeleton-element skeleton-detail"></div>' +
    '<div class="skeleton-badges">' +
      '<div class="skeleton-element skeleton-badge"></div>' +
      '<div class="skeleton-element skeleton-badge"></div>' +
      '<div class="skeleton-element skeleton-badge"></div>' +
    '</div>' +
    '<div class="skeleton-element skeleton-notes"></div>' +
    '<div class="skeleton-prices">' +
      '<div class="skeleton-element skeleton-price-box"></div>' +
      '<div class="skeleton-element skeleton-price-box"></div>' +
    '</div>' +
    '<div class="skeleton-element skeleton-btn"></div>';
  return card;
}

function showCatalogSkeletons(container, count) {
  if (!container) return;
  var grid = document.createElement('div');
  grid.className = 'catalog-skeleton-grid';
  for (var i = 0; i < count; i++) {
    grid.appendChild(createSkeletonCard());
  }
  container.appendChild(grid);
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

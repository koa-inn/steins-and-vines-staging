// ===== Steins & Vines — Shared Utility Functions =====
// Canonical implementations. Load this script before any page-specific JS.
// Note: showToast is NOT here — each page has a custom implementation
// (different container IDs, undo support, and CSS classes).

function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatCurrency(val) {
  var num = typeof val === 'number' ? val : parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
  if (isNaN(num)) return '';
  return '$' + num.toFixed(2);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHTML: escapeHTML, formatCurrency: formatCurrency };
}

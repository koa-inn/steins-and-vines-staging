// =============================================================================
// 12b-checkout-payment.js
// GP payment display helpers: deposit summary and payment option toggle.
// Relies on _paymentConfig, _makersFeeItem set by 12-checkout.js.
// Loaded before 12-checkout.js in the concat:js pipeline.
// =============================================================================

/**
 * Update the deposit summary display based on cart items and payment config.
 * DISPLAY ESTIMATE ONLY — server recomputes authoritative totals at checkout
 */
function updateDepositSummary() {
  var depositSummary = document.getElementById('deposit-summary');
  var isKioskMode = document.body.classList.contains('kiosk-mode');

  if (!depositSummary || !_paymentConfig || !_paymentConfig.enabled || isKioskMode) return;

  var _depCartKey = getActiveCheckoutCart();
  var items = _depCartKey ? getReservation(_depCartKey) : getAllCartItems();
  var total = 0;
  items.forEach(function (item) {
    var p = (parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0);
    var disc = parseFloat(item.discount) || 0;
    if (disc > 0) p = p * (1 - disc / 100);
    total += p * (item.qty || 1);
  });

  if (items.length === 0 || total <= 0) {
    depositSummary.classList.add('hidden');
    return;
  }

  var hasKits = items.some(function (item) { return (item.item_type || 'kit') === 'kit'; });

  // If kit order, check if user chose Pay in Full
  var payFull = false;
  var fullRadio = document.querySelector('input[name="payment-option"][value="full"]');
  if (fullRadio && fullRadio.checked) payFull = true;

  if (!hasKits || payFull) {
    var taxTotal = 0;
    items.forEach(function (item) {
      var p = (parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0);
      var disc = parseFloat(item.discount) || 0;
      if (disc > 0) p = p * (1 - disc / 100);
      var taxPct = parseFloat(item.tax_percentage) || 0;
      taxTotal += p * (item.qty || 1) * (taxPct / 100);
    });

    // If kit order, add makers fee to the kit subtotal only
    var baseTotal = total;
    if (hasKits && _makersFeeItem) {
      var kitSubtotalForDeposit = 0;
      items.forEach(function (item) {
        if ((item.item_type || 'kit') === 'kit') {
          var p = (parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0);
          var disc = parseFloat(item.discount) || 0;
          if (disc > 0) p = p * (1 - disc / 100);
          kitSubtotalForDeposit += p * (item.qty || 1);
        }
      });
      var kitQtyForDeposit = 0;
      items.forEach(function (item) {
        if ((item.item_type || 'kit') === 'kit') kitQtyForDeposit += (parseFloat(item.qty) || 1);
      });
      baseTotal = total + (parseFloat(_makersFeeItem.rate) || 50.00) * kitQtyForDeposit;
    }

    var grandTotal = baseTotal + taxTotal;

    var depHtml = '<div class="deposit-summary-row"><span>Subtotal</span><span>$' + baseTotal.toFixed(2) + '</span></div>';
    if (taxTotal > 0) {
      depHtml += '<div class="deposit-summary-row"><span>Tax</span><span>$' + taxTotal.toFixed(2) + '</span></div>';
    }
    depHtml += '<div class="deposit-summary-row deposit-summary-row--total"><span>Total</span><span>$' + grandTotal.toFixed(2) + '</span></div>';
    depositSummary.innerHTML = depHtml;
    depositSummary.classList.remove('hidden');

    // Update payment heading with total
    var depHeadingEl = document.getElementById('payment-heading');
    if (depHeadingEl) depHeadingEl.innerHTML = '<svg class="payment-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89-2 2-2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg> Payment \u2014 $' + grandTotal.toFixed(2);
  } else {
    var deposit = Math.min(_paymentConfig.depositAmount, total);
    var balance = Math.max(0, total - deposit);
    depositSummary.innerHTML = '<div class="deposit-summary-row"><span>Deposit</span><span id="deposit-summary-amount">$' + deposit.toFixed(2) + '</span></div>'
      + '<div class="deposit-summary-row"><span>Balance due at appointment</span><span id="deposit-summary-balance">$' + balance.toFixed(2) + '</span></div>';
    depositSummary.classList.remove('hidden');

    var depHeadingEl = document.getElementById('payment-heading');
    if (depHeadingEl) depHeadingEl.innerHTML = '<svg class="payment-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg> Payment \u2014 $' + deposit.toFixed(2) + ' deposit';
  }
}

function setupPaymentToggle() {
  var selector = document.getElementById('payment-option-selector');
  if (!selector) return;

  var radios = document.getElementsByName('payment-option');
  var fullDesc = document.getElementById('payment-option-full-desc');
  var depositDesc = document.getElementById('payment-option-deposit-desc');

  // DISPLAY ESTIMATE ONLY — server recomputes authoritative totals at checkout
  function updateToggleLabels() {
    var _toggleCartKey = getActiveCheckoutCart();
    var items = _toggleCartKey ? getReservation(_toggleCartKey) : getAllCartItems();
    var hasKits = items.some(function (i) { return (i.item_type || 'kit') === 'kit'; });
    var subtotal = 0;
    items.forEach(function (item) {
      var p = (parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0);
      var disc = parseFloat(item.discount) || 0;
      if (disc > 0) p = p * (1 - disc / 100);
      subtotal += p * (item.qty || 1);
    });

    var makersFeeAmount = 0;
    if (hasKits && _makersFeeItem) {
      // Makers fee is per kit quantity, applied to kit items only
      var kitQtyForToggle = 0;
      items.forEach(function (item) {
        if ((item.item_type || 'kit') === 'kit') kitQtyForToggle += (parseFloat(item.qty) || 1);
      });
      makersFeeAmount = (parseFloat(_makersFeeItem.rate) || 50.00) * kitQtyForToggle;
    }

    var totalWithFee = subtotal + makersFeeAmount;

    var estTax = 0;
    items.forEach(function (item) {
      var p = (parseFloat(String(item.price || '0').replace(/[^0-9.]/g, '')) || 0);
      var disc = parseFloat(item.discount) || 0;
      if (disc > 0) p = p * (1 - disc / 100);
      var taxPct = parseFloat(item.tax_percentage) || 0;
      estTax += p * (item.qty || 1) * (taxPct / 100);
    });

    var grandTotal = totalWithFee + estTax;

    if (fullDesc) fullDesc.textContent = 'Pay ' + formatCurrency(grandTotal) + ' total now via credit card.';
    if (depositDesc) {
      var depAmt = (_paymentConfig && _paymentConfig.depositAmount) ? _paymentConfig.depositAmount : 50;
      depositDesc.textContent = 'Pay ' + formatCurrency(depAmt) + ' deposit now; balance due later.';
    }
  }

  Array.prototype.forEach.call(radios, function (r) {
    r.addEventListener('change', function() {
      renderReservationItems();
      updateDepositSummary();
    });
  });

  window.addEventListener('reservation-changed', updateToggleLabels);
  updateToggleLabels();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    updateDepositSummary: updateDepositSummary,
    setupPaymentToggle: setupPaymentToggle
  };
}

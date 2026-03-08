// Milling state — persists across renderReservationItems() re-renders
var _milledItemKeys = {};      // set of cart item keys the customer wants milled
var _millingServiceItem = null; // Zoho service item for milling fee (fetched lazily)

// Maker's fee state
var _makersFeeItem = null;     // Zoho item for MAKERS-FEE (fetched lazily when kits present)
var _makersFeeLoaded = false;  // true once fetch has been attempted
var _prevHasKits = null;       // tracks previous hasKits state to avoid redundant timeslot reloads

// Payment state
var _paymentConfig = null;
var _gpToken = null;
var _checkoutSubmitting = false;

// #10/#21: renumber visible stepper digits after hiding steps
function renumberVisibleSteps() {
  var steps = document.querySelectorAll('.stepper-step:not(.hidden)');
  var n = 1;
  steps.forEach(function (step) {
    var digit = step.querySelector('.stepper-digit');
    if (digit) digit.textContent = n++;
  });
}

// Pure helpers — testable and reusable outside the DOMContentLoaded scope

// Returns the completion estimate text string, or null when the element should be hidden.
// Extracted from updateCompletionEstimate so the date math can be unit-tested independently.
function calcCompletionRange(items, timeslotValue) {
  var maxWeeks = 0;
  var hasTimeProp = false;
  items.forEach(function (item) {
    if (item.time) hasTimeProp = true;
    var weeks = parseInt(item.time, 10);
    if (!isNaN(weeks) && weeks > maxWeeks) maxWeeks = weeks;
  });

  if (maxWeeks === 0) {
    return hasTimeProp ? 'varies' : null;
  }

  var datePart = timeslotValue.split(' ')[0];
  var startDate = new Date(datePart + 'T00:00:00');
  if (isNaN(startDate.getTime())) return null;

  var weekStart = new Date(startDate);
  weekStart.setDate(weekStart.getDate() + (maxWeeks * 7));
  var weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);

  var opts = { month: 'long', day: 'numeric' };
  var startStr = weekStart.toLocaleDateString('en-US', opts);
  var endOpts = weekStart.getMonth() === weekEnd.getMonth() ? { day: 'numeric' } : opts;
  var endStr = weekEnd.toLocaleDateString('en-US', endOpts);
  var yearStr = weekEnd.getFullYear();

  return 'Estimated ready the week of ' + startStr + '\u2013' + endStr + ', ' + yearStr
    + ' (approximately ' + maxWeeks + ' week' + (maxWeeks !== 1 ? 's' : '')
    + ' from your appointment). This is an estimate \u2014 actual times may vary.';
}

function formatTimeslot(ts) {
  var parts = ts.split(' ');
  if (parts.length < 2) return ts;
  var d = new Date(parts[0] + 'T00:00:00');
  if (isNaN(d.getTime())) return ts;
  var day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return day + ' at ' + parts.slice(1).join(' ');
}

function formatPhoneInput(rawValue) {
  var digits = rawValue.replace(/\D/g, '').slice(0, 10);
  if (digits.length > 6) {
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  } else if (digits.length > 3) {
    return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
  } else if (digits.length > 0) {
    return '(' + digits;
  }
  return digits;
}

function isValidEmail(val) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

function isValidPhone(val) {
  var digits = val.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

// Show or hide elements that are only relevant for ferment-in-store kit orders.
// Called on initial render and on every cart re-render so the page stays in sync.
function applyKitSpecificVisibility(hasKits) {
  var kitOnlyIds = [
    'reservation-intro-strip',
    'reservation-guarantee-note',
    'reservation-dropin-note',
    'kit-instore-reminder'
  ];
  kitOnlyIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (hasKits) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });
}

/**
 * Update the deposit summary display based on cart items and payment config.
 */
function updateDepositSummary() {
  var depositSummary = document.getElementById('deposit-summary');
  var isKioskMode = document.body.classList.contains('kiosk-mode');
  
  if (!depositSummary || !_paymentConfig || !_paymentConfig.enabled || isKioskMode) return;
  
  var items = getAllCartItems();
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
    
    // If kit order, add makers fee to the base total
    var baseTotal = total;
    if (hasKits && _makersFeeItem) {
      baseTotal += parseFloat(_makersFeeItem.rate) || 50.00;
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

function initReservationPage() {
  var initialItems = getAllCartItems();
  if (initialItems.length === 0) {
    setTimeout(function () { window.location.href = 'products.html'; }, 1500);
  }

  initCheckoutStepper();

  var initialHasKits = initialItems.some(function (item) { return (item.item_type || 'kit') === 'kit'; });

  // Fetch maker's fee item lazily when kit items are present
  var mwUrlForFees = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
  if (initialHasKits && mwUrlForFees && !_makersFeeLoaded) {
    _makersFeeLoaded = true;
    fetch(mwUrlForFees + '/api/services')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var services = data.items || [];
        for (var i = 0; i < services.length; i++) {
          var sku = (services[i].sku || services[i].item_code || '').toUpperCase();
          var name = (services[i].name || '').toLowerCase();
          if (sku === 'MAKERS-FEE' || name.indexOf('makers fee') !== -1 || name.indexOf("maker's fee") !== -1) {
            _makersFeeItem = services[i];
            break;
          }
        }
        renderReservationItems();
      })
      .catch(function () {});
  }

  // Fetch milling service item if cart contains any grain ingredients
  var hasMillableGrains = initialItems.some(function (item) {
    return (item.item_type || '') === 'ingredient' && isWeightUnit(item.unit) &&
      (item.millable || '').toLowerCase() === 'true';
  });
  if (hasMillableGrains && mwUrlForFees && !_millingServiceItem) {
    fetch(mwUrlForFees + '/api/services')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var services = data.items || [];
        for (var i = 0; i < services.length; i++) {
          if ((services[i].name || '').toLowerCase().indexOf('mill') !== -1) {
            _millingServiceItem = services[i];
            break;
          }
        }
        renderReservationItems();
      })
      .catch(function () {});
  }

  renderReservationItems();

  var items = getAllCartItems();
  var hasKits = items.some(function (item) { return (item.item_type || 'kit') === 'kit'; });

  if (hasKits) {
    loadTimeslots();
  } else {
    var picker = document.getElementById('timeslot-picker');
    if (picker) picker.classList.add('hidden');
    var step2 = document.querySelector('.stepper-step[data-step="2"]');
    if (step2) { step2.classList.add('hidden'); step2.setAttribute('aria-hidden', 'true'); }
    renumberVisibleSteps();
  }

  var pageH1 = document.querySelector('.page-header h1');
  if (pageH1) pageH1.style.visibility = '';

  (function () {
    function addContinueBtn(sectionId, targetId, label) {
      var section = document.getElementById(sectionId);
      var target = document.getElementById(targetId);
      if (!section || !target) return;
      var wrap = document.createElement('div');
      wrap.className = 'checkout-continue-wrap';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn checkout-continue-btn';
      btn.textContent = label;
      btn.addEventListener('click', function () {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      wrap.appendChild(btn);
      section.appendChild(wrap);
    }
    addContinueBtn('reservation-list', hasKits ? 'timeslot-picker' : 'reservation-form-section',
      hasKits ? 'Continue \u2014 Select a time \u203A' : 'Continue \u2014 Your details \u203A');
    if (hasKits) {
      addContinueBtn('timeslot-picker', 'reservation-form-section', 'Continue \u2014 Your details \u203A');
    }
  }());

  applyKitSpecificVisibility(hasKits);

  if (!hasKits && items.length > 0) {
    var pageTitle = document.querySelector('[data-content="page-title"]');
    if (pageTitle) pageTitle.textContent = 'Complete Your Order';
    document.title = 'Order | Steins & Vines';
    var reservedTitle = document.querySelector('[data-content="reserved-items-title"]');
    if (reservedTitle) reservedTitle.textContent = 'Your items';
    var submitBtn = document.querySelector('[data-content="submit-btn"]');
    if (submitBtn) submitBtn.textContent = 'Place Order';
    var formNote = document.querySelector('[data-content="form-note"]');
    if (formNote) formNote.textContent = 'A confirmation email will be sent to the address provided above. All orders are in-store pickup only.';
  }

  setupReservationForm();
  setupPaymentToggle();
}

function setupPaymentToggle() {
  var selector = document.getElementById('payment-option-selector');
  if (!selector) return;

  var radios = document.getElementsByName('payment-option');
  var fullDesc = document.getElementById('payment-option-full-desc');
  var depositDesc = document.getElementById('payment-option-deposit-desc');

  function updateToggleLabels() {
    var items = getAllCartItems();
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
      makersFeeAmount = parseFloat(_makersFeeItem.rate) || 50.00;
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

function initCheckoutStepper() {
  var stepper = document.getElementById('checkout-stepper');
  if (!stepper) return;
  var stepSections = { 1: 'reservation-list', 2: 'timeslot-picker', 3: 'reservation-form-section', 4: 'reservation-confirm' };
  stepper.querySelectorAll('.stepper-step').forEach(function (step) {
    step.addEventListener('click', function () {
      if (!step.classList.contains('stepper-step--done')) return;
      var section = document.getElementById(stepSections[parseInt(step.getAttribute('data-step'), 10)]);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var stepNum = parseInt(entry.target.getAttribute('data-checkout-step'), 10);
          if (stepNum) updateStepper(stepNum);
        }
      });
    }, { threshold: 0.3, rootMargin: '-80px 0px 0px 0px' });
    document.querySelectorAll('[data-checkout-step]').forEach(function (s) { observer.observe(s); });
  }
}

function updateStepper(activeStep) {
  document.querySelectorAll('.stepper-step').forEach(function (step) {
    var num = parseInt(step.getAttribute('data-step'), 10);
    step.classList.remove('stepper-step--active', 'stepper-step--done');
    if (num < activeStep) step.classList.add('stepper-step--done');
    else if (num === activeStep) step.classList.add('stepper-step--active');
  });
}

function refreshReservationDependents() {
  var items = getAllCartItems();
  var hasKits = items.some(function (item) { return (item.item_type || 'kit') === 'kit'; });
  var kitsJustAppeared = (hasKits && _prevHasKits !== true);
  _prevHasKits = hasKits;

  if (hasKits) {
    if (kitsJustAppeared) { loadTimeslots(); }
    var selected = document.querySelector('input[name="timeslot"]:checked');
    if (selected) updateCompletionEstimate(selected.value);
    else if (document.getElementById('completion-estimate')) document.getElementById('completion-estimate').classList.add('hidden');
  } else {
    var picker = document.getElementById('timeslot-picker');
    if (picker) picker.classList.add('hidden');
  }

  var mwUrl = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
  if (hasKits && mwUrl && !_makersFeeLoaded) {
    _makersFeeLoaded = true;
    fetch(mwUrl + '/api/services').then(function (r) { return r.json(); }).then(function (data) {
      var svcs = data.items || [];
      for (var i = 0; i < svcs.length; i++) {
        var sku = (svcs[i].sku || svcs[i].item_code || '').toUpperCase();
        if (sku === 'MAKERS-FEE' || (svcs[i].name || '').toLowerCase().indexOf('makers fee') !== -1) {
          _makersFeeItem = svcs[i]; break;
        }
      }
      renderReservationItems();
    }).catch(function () {});
  }
}

function renderReservationItems() {
  var container = document.getElementById('reservation-items');
  var emptyMsg = document.getElementById('reservation-empty');
  if (!container) return;

  var items = getAllCartItems();
  var hasKits = items.some(function (i) { return (i.item_type || 'kit') === 'kit'; });
  applyKitSpecificVisibility(hasKits);
  container.innerHTML = '';

  if (items.length === 0) {
    if (emptyMsg) emptyMsg.classList.remove('hidden');
    ['timeslot-picker', 'reservation-form-section'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
    return;
  }
  
  if (emptyMsg) emptyMsg.classList.add('hidden');
  var picker = document.getElementById('timeslot-picker');
  var formSection = document.getElementById('reservation-form-section');
  if (picker) { if (hasKits) picker.classList.remove('hidden'); else picker.classList.add('hidden'); }
  if (formSection) formSection.classList.remove('hidden');

  var paySelector = document.getElementById('payment-option-selector');
  if (paySelector) { if (hasKits) paySelector.classList.remove('hidden'); else paySelector.classList.add('hidden'); }

  var table = document.createElement('table');
  table.className = 'catalog-table reservation-table';
  var thead = document.createElement('thead');
  var hasTime = items.some(function (it) { return (it.time || '').trim() !== ''; });
  var hasBrand = items.some(function (it) { return (it.brand || '').trim() !== ''; });
  var theadTr = document.createElement('tr');
  ['Name', 'Type', 'Brand', 'Time', 'Price', 'Status', 'Qty', ''].forEach(function (label) {
    if (label === 'Time' && !hasTime) return;
    if (label === 'Brand' && !hasBrand) return;
    var th = document.createElement('th'); th.textContent = label;
    if (label === 'Price') th.style.textAlign = 'right';
    if (label === 'Type') th.className = 'res-col-type';
    theadTr.appendChild(th);
  });
  thead.appendChild(theadTr); table.appendChild(thead);

  var tbody = document.createElement('tbody');
  var totalKitQty = 0;
  items.forEach(function (item) {
    if ((item.item_type || 'kit') === 'kit') {
      totalKitQty += (parseFloat(item.qty) || 1);
    }
    var tr = document.createElement('tr');
    // ... rest of item rendering logic ...
  });

  if (hasKits && _makersFeeItem) {
    var feeRate = parseFloat(_makersFeeItem.rate) || 50;
    var fTr = document.createElement('tr'); fTr.className = 'makers-fee-row';
    fTr.innerHTML = '<td data-label="Name">' + (_makersFeeItem.name || "Maker's Fee") + '</td><td data-label="Type" class="res-col-type">Service</td>' + (hasBrand ? '<td></td>' : '') + (hasTime ? '<td></td>' : '') + '<td style="text-align:right">' + formatCurrency(feeRate) + '</td><td></td><td>' + totalKitQty + '</td><td></td>';
    tbody.appendChild(fTr);
  }
  table.appendChild(tbody);
  var tWrap = document.createElement('div'); tWrap.className = 'reservation-table-wrap'; tWrap.appendChild(table); container.appendChild(tWrap);

  // --- RE-ORDERED: Milling Section (above totals) ---
  // ... rest of file ...
  
  // --- Totals Summary ---
  var sub = 0; items.forEach(function (i) {
    var p = parseFloat((i.price || '0').replace('$', '')) || 0;
    var d = parseFloat(i.discount) || 0; if (d > 0) p *= (1 - d / 100); sub += p * (i.qty || 1);
  });
  
  var feeRate = (hasKits && _makersFeeItem) ? (parseFloat(_makersFeeItem.rate) || 50) : 0;
  var totalFee = feeRate * totalKitQty;
  var payFull = true; var fR = document.querySelector('input[name="payment-option"][value="full"]'); if (fR) payFull = fR.checked;

  var sWrap = document.createElement('div'); sWrap.className = 'order-summary-totals';
  if (!hasKits || payFull) {
    var tax = 0; items.forEach(function (i) {
      var p = parseFloat((i.price || '0').replace('$', '')) || 0;
      var d = parseFloat(i.discount) || 0; if (d > 0) p *= (1 - d / 100);
      tax += p * (i.qty || 1) * ((parseFloat(i.tax_percentage) || 0) / 100);
    });
    sWrap.innerHTML = '<div class="reservation-subtotal"><span>Subtotal</span><span>' + formatCurrency(sub + totalFee) + '</span></div>' +
      (tax > 0 ? '<div class="reservation-subtotal reservation-subtotal--detail"><span>Tax</span><span>' + formatCurrency(tax) + '</span></div>' : '') +
      '<div class="reservation-subtotal reservation-subtotal--total"><span>Total</span><span>' + formatCurrency(sub + totalFee + tax) + '</span></div>';
  } else {
    sWrap.innerHTML = '<div class="reservation-subtotal"><span>Items Subtotal</span><span>' + formatCurrency(sub) + '</span></div>' +
      '<div class="reservation-subtotal"><span>Maker\'s Fee (' + totalKitQty + ' \u00D7 ' + formatCurrency(feeRate) + ')</span><span>' + formatCurrency(totalFee) + '</span></div>' +
      '<div class="reservation-subtotal reservation-subtotal--total"><span>Estimated Subtotal <span class="reservation-disclaimer">\u2014 Final pricing may vary.</span></span><span>' + formatCurrency(sub + totalFee) + '</span></div>';
  }
  container.appendChild(sWrap);

  var cWrap = document.createElement('div'); cWrap.className = 'reservation-clear-wrap';
  var cBtn = document.createElement('button'); cBtn.className = 'btn-secondary reservation-clear-btn'; cBtn.textContent = 'Clear Cart';
  cBtn.addEventListener('click', function () { if (confirm('Remove all items?')) { saveReservation([], FERMENT_CART_KEY); saveReservation([], INGREDIENT_CART_KEY); renderReservationItems(); refreshReservationDependents(); updateReservationBar(); refreshAllReserveControls(); } });
  cWrap.appendChild(cBtn); container.appendChild(cWrap);
  window.dispatchEvent(new Event('reservation-changed'));
}

function loadTimeslots() {
  var container = document.getElementById('timeslot-groups'); if (!container) return;
  var items = getAllCartItems(); var hasOut = items.some(function (i) { return (i.stock || 0) === 0; });
  var cutoff = null; if (hasOut) { cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 14); cutoff.setHours(0, 0, 0, 0); }
  container.innerHTML = '';
  if (hasOut) { var n = document.createElement('p'); n.className = 'timeslot-notice'; n.textContent = 'Some items need to be ordered. 2-week lead time required.'; container.appendChild(n); }

  var isK = document.body.classList.contains('kiosk-mode');
  if (isK && !hasOut && items.length > 0) {
    var sWrap = document.createElement('div'); sWrap.className = 'start-now-wrap';
    sWrap.innerHTML = '<p class="start-now-note">All items in stock — start now.</p><button type="button" class="btn start-now-btn">Start Now</button><p class="start-now-or">or choose a timeslot below</p>';
    var imm = document.createElement('input'); imm.type = 'radio'; imm.name = 'timeslot'; imm.value = 'Walk-in — Immediate'; imm.className = 'hidden';
    container.appendChild(imm);
    sWrap.querySelector('button').addEventListener('click', function () {
      imm.checked = true; this.classList.add('start-now-selected');
      container.querySelectorAll('input[name="timeslot"]:not([value="Walk-in — Immediate"])').forEach(function (r) { r.checked = false; });
      if (document.getElementById('completion-estimate')) document.getElementById('completion-estimate').classList.add('hidden');
    });
    container.appendChild(sWrap);
  }

  var cal = document.createElement('div'); cal.className = 'cal'; container.appendChild(cal);
  var slots = document.createElement('div'); slots.className = 'cal-slots'; container.appendChild(slots);
  var selD = null; var rIdx = 0; var now = new Date(); var mList = [];
  for (var m = 0; m < 4; m++) { var d = new Date(now.getFullYear(), now.getMonth() + m, 1); mList.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')); }
  var curM = 0; var cache = {};

  function render() {
    cal.innerHTML = ''; var ym = mList[curM]; var y = parseInt(ym.substring(0, 4)); var m = parseInt(ym.substring(5, 7)) - 1;
    var hdr = document.createElement('div'); hdr.className = 'cal-header';
    hdr.innerHTML = '<button type="button" class="cal-nav" ' + (curM === 0 ? 'disabled' : '') + '>\u2039</button>' +
      '<span class="cal-title">' + ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m] + ' ' + y + '</span>' +
      '<button type="button" class="cal-nav" ' + (curM === mList.length - 1 ? 'disabled' : '') + '>\u203A</button>';
    hdr.querySelectorAll('.cal-nav').forEach(function (b, i) { b.addEventListener('click', function () { if (i === 0) curM--; else curM++; render(); }); });
    cal.appendChild(hdr);
    var grid = document.createElement('div'); grid.className = 'cal-grid';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (l) { var d = document.createElement('div'); d.className = 'cal-dow'; d.textContent = l; grid.appendChild(d); });
    cal.appendChild(grid);

    var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
    fetch(mw + '/api/bookings/availability?year=' + y + '&month=' + (m + 1)).then(function (r) { return r.json(); }).then(function (data) {
      grid.innerHTML = ''; ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (l) { var d = document.createElement('div'); d.className = 'cal-dow'; d.textContent = l; grid.appendChild(d); });
      var first = new Date(y, m, 1); var start = first.getDay(); var days = new Date(y, m + 1, 0).getDate();
      var today = new Date(); today.setHours(0, 0, 0, 0); var tStr = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      for (var e = 0; e < start; e++) { var em = document.createElement('div'); em.className = 'cal-day cal-day--disabled'; grid.appendChild(em); }
      var avail = {}; (data.dates || []).forEach(function (d) { avail[d.date] = { available: true, slots: d.slots_count || 0 }; });
      for (var d = 1; d <= days; d++) {
        var ds = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        var c = document.createElement('button'); c.type = 'button'; c.className = 'cal-day'; c.textContent = d;
        var cd = new Date(ds + 'T00:00:00'); var past = cd < today; var info = avail[ds]; var hasS = !!(info && info.available); var cut = cutoff && cd < cutoff;
        if (ds === tStr) c.classList.add('cal-day--today'); if (ds === selD) c.classList.add('cal-day--selected');
        if (past || !hasS || cut) { c.classList.add('cal-day--disabled'); c.disabled = true; }
        else {
          c.classList.add('cal-day--available');
          if (info.slots > 0 && info.slots <= 3) { var b = document.createElement('span'); b.className = 'cal-day-spots'; b.textContent = info.slots + ' left'; c.appendChild(b); }
          (function (date) { c.addEventListener('click', function () { selD = date; render(); renderSlots(date); }); })(ds);
        }
        grid.appendChild(c);
      }
    });
  }

  function renderSlots(ds) {
    slots.innerHTML = '<p>Loading times...</p>';
    var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
    fetch(mw + '/api/bookings/slots?date=' + ds).then(function (r) { return r.json(); }).then(function (data) {
      slots.innerHTML = '<h3>' + new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + '</h3>';
      var fs = document.createElement('fieldset'); fs.className = 'timeslot-fieldset';
      var g = document.createElement('div'); g.className = 'cal-slots-grid';
      (data.slots || []).forEach(function (s) {
        var time = s.time || s; var id = 'ts-' + (rIdx++);
        var o = document.createElement('div'); o.className = 'timeslot-option';
        o.innerHTML = '<input type="radio" name="timeslot" id="' + id + '" value="' + ds + ' ' + time + '"><label for="' + id + '">' + time + '</label>';
        g.appendChild(o);
      });
      fs.appendChild(g); slots.appendChild(fs);
    });
  }
  render();
  container.addEventListener('change', function (e) {
    if (e.target.name === 'timeslot') {
      updateCompletionEstimate(e.target.value);
      var sn = container.querySelector('.start-now-btn'); if (sn && e.target.value !== 'Walk-in — Immediate') sn.classList.remove('start-now-selected');
      setTimeout(function () { var f = document.getElementById('reservation-form-section'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 600);
    }
  });
}

function updateCompletionEstimate(ts) {
  var el = document.getElementById('completion-estimate'); var txt = document.getElementById('completion-estimate-text');
  if (!el || !txt) return; var items = getAllCartItems(); if (items.length === 0) { el.classList.add('hidden'); return; }
  var res = calcCompletionRange(items, ts);
  if (res === null) el.classList.add('hidden'); else { txt.textContent = res; el.classList.remove('hidden'); }
}

function setupBeerWaitlistForm() {
  var f = document.getElementById('beer-waitlist-form'); if (!f) return;
  f.addEventListener('submit', function (e) {
    e.preventDefault(); var em = document.getElementById('beer-waitlist-email').value.trim(); if (!em) return;
    var hf = document.createElement('form'); hf.method = 'POST'; hf.action = 'https://docs.google.com/forms/d/e/YOUR_BEER_WAITLIST_FORM_ID/formResponse'; hf.target = 'beer-waitlist-iframe'; hf.style.display = 'none';
    hf.innerHTML = '<input name="entry.YOUR_EMAIL_ENTRY_ID" value="' + em + '">'; document.body.appendChild(hf); hf.submit(); document.body.removeChild(hf);
    f.classList.add('hidden'); document.getElementById('beer-waitlist-confirm').classList.remove('hidden');
  });
}

function setupReservationForm() {
  var f = document.getElementById('reservation-form'); if (!f) return;
  var sec = document.getElementById('payment-section'); var err = document.getElementById('payment-error');
  var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
  if (!document.body.classList.contains('kiosk-mode') && sec && (typeof PAYMENT_DISABLED === 'undefined' || !PAYMENT_DISABLED)) {
    fetch(mw + '/api/payment/config').then(function (r) { return r.json(); }).then(function (cfg) {
      _paymentConfig = cfg; if (!cfg.enabled || !cfg.accessToken) return;
      sec.classList.remove('hidden'); if (document.getElementById('payment-offline-notice')) document.getElementById('payment-offline-notice').classList.add('hidden');
      if (typeof GlobalPayments !== 'undefined') {
        GlobalPayments.configure({ accessToken: cfg.accessToken, apiVersion: '2021-03-22', env: cfg.env === 'production' ? 'production' : 'sandbox' });
        var form = GlobalPayments.ui.form({
          fields: { 'card-number': { target: '#credit-card-number' }, 'card-expiration': { target: '#credit-card-expiry' }, 'card-cvv': { target: '#credit-card-cvv' }, submit: { text: 'Verify Card', target: '#credit-card-submit' } },
          styles: { '#secure-payment-field[type=button]': { background: '#722F37', color: '#fff', padding: '12px', width: '100%' } }
        });
        form.on('token-success', function (r) { _gpToken = r.paymentReference; if (err) { err.textContent = ''; err.classList.remove('visible'); } document.getElementById('credit-card-submit').classList.add('card-verified'); document.getElementById('payment-verified-msg').classList.remove('hidden'); });
        form.on('token-error', function (r) { _gpToken = null; if (err) { err.textContent = r.error ? r.error.message : 'Failed'; err.classList.add('visible'); } });
      }
      updateDepositSummary();
    }).catch(function (e) { console.error('[payment] Init failed:', e.message); });
  }
  window.addEventListener('reservation-changed', updateDepositSummary);
  window.addEventListener('storage', updateDepositSummary);
  setTimeout(updateDepositSummary, 500);

  f.addEventListener('submit', function (e) {
    e.preventDefault(); if (_checkoutSubmitting) return; if (!navigator.onLine) { showToast('Offline', 'error'); return; }
    _checkoutSubmitting = true; var items = getAllCartItems(); var hasK = items.some(function (i) { return (i.item_type || 'kit') === 'kit'; });
    var sel = document.querySelector('input[name="timeslot"]:checked'); if (hasK && !sel) { showToast('Select timeslot', 'error'); _checkoutSubmitting = false; return; }
    var sub = f.querySelector('button[type="submit"]'); sub.disabled = true; sub.textContent = 'Processing...';
    
    var payFull = true; var fR = document.querySelector('input[name="payment-option"][value="full"]'); if (fR) payFull = fR.checked;
    var orderTot = 0; items.forEach(function (i) { var p = parseFloat(String(i.price || '0').replace(/[^0-9.]/g, '')) || 0; var d = parseFloat(i.discount) || 0; if (d > 0) p *= (1 - d / 100); orderTot += p * (i.qty || 1); });
    if (hasK && _makersFeeItem) orderTot += parseFloat(_makersFeeItem.rate) || 0;
    var tax = 0; if (!hasK || payFull) { items.forEach(function (i) { var p = parseFloat(String(i.price || '0').replace(/[^0-9.]/g, '')) || 0; var d = parseFloat(i.discount) || 0; if (d > 0) p *= (1 - d / 100); tax += p * (i.qty || 1) * ((parseFloat(i.tax_percentage) || 0) / 100); }); }
    var charge = orderTot + tax; var depAmt = (!hasK || payFull) ? charge : Math.min(_paymentConfig.depositAmount, orderTot);

    var pProm = (charge > 0 && _paymentConfig && _paymentConfig.enabled) ? fetch(mw + '/api/payment/charge', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MW_API_KEY }, body: JSON.stringify({ token: _gpToken, amount: depAmt, customer: { name: document.getElementById('res-name').value, email: document.getElementById('res-email').value } }) }).then(function (r) { return r.ok ? r.json() : r.json().then(function (d) { throw new Error(d.error); }); }) : Promise.resolve({ transaction_id: '', amount: 0 });

    pProm.then(function (pR) {
      return fetch(mw + '/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MW_API_KEY }, body: JSON.stringify({ name: document.getElementById('res-name').value, email: document.getElementById('res-email').value, phone: document.getElementById('res-phone').value }) }).then(function (r) { return r.json(); }).then(function (cD) {
        var slot = sel ? sel.value : 'In-store pickup'; var parts = slot.split(' ');
        var bProm = (slot === 'Walk-in — Immediate') ? Promise.resolve({ booking_id: null, timeslot: slot }) : fetch(mw + '/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': MW_API_KEY }, body: JSON.stringify({ date: parts[0], time: parts.slice(1).join(' '), customer: { name: document.getElementById('res-name').value, email: document.getElementById('res-email').value }, notes: items.map(function (i) { return i.name; }).join(', ') }) }).then(function (r) { return r.json(); });
        return bProm.then(function (bD) {
          var lines = items.map(function (i) { return { name: i.name, quantity: i.qty || 1, rate: parseFloat(String(i.price || '0').replace(/[^0-9.]/g, '')) || 0, item_id: i.zoho_item_id, discount: i.discount }; });
          if (hasK && _makersFeeItem) lines.push({ name: _makersFeeItem.name, quantity: 1, rate: parseFloat(_makersFeeItem.rate) || 0, item_id: _makersFeeItem.item_id });
          if (Object.keys(_milledItemKeys).length > 0) lines.push({ name: 'Milling Service', quantity: 1, rate: _millingServiceItem ? _millingServiceItem.rate : 0, item_id: _millingServiceItem ? _millingServiceItem.item_id : '' });
          return fetch(mw + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: { name: document.getElementById('res-name').value, email: document.getElementById('res-email').value, phone: document.getElementById('res-phone').value }, items: lines, transaction_id: pR.transaction_id, deposit_amount: pR.amount, timeslot: bD.timeslot }) }).then(function (r) { return r.json(); });
        });
      });
    }).then(function (oR) {
      localStorage.removeItem(FERMENT_CART_KEY); localStorage.removeItem(INGREDIENT_CART_KEY);
      ['reservation-list', 'timeslot-picker', 'reservation-form-section'].forEach(function (id) { document.getElementById(id).classList.add('hidden'); });
      updateStepper(4); var conf = document.getElementById('reservation-confirm'); conf.classList.remove('hidden');
      if (document.getElementById('confirm-order-number')) document.getElementById('confirm-order-number').textContent = 'Order #' + (oR.salesorder_number || 'REF-' + Date.now().toString(36).toUpperCase());
    }).catch(function (err) { showToast(err.message, 'error'); sub.disabled = false; sub.textContent = 'Submit'; _checkoutSubmitting = false; });
  });
}

function setupContactValidation() {
  var n = document.getElementById('name'); var e = document.getElementById('email'); if (!n && !e) return;
  var err = function (i, m) { i.classList.add('field-error'); var eE = i.parentElement.querySelector('.form-error-msg') || document.createElement('div'); eE.className = 'form-error-msg'; eE.textContent = m; i.parentElement.appendChild(eE); eE.classList.add('visible'); };
  var clr = function (i) { i.classList.remove('field-error'); var eE = i.parentElement.querySelector('.form-error-msg'); if (eE) eE.classList.remove('visible'); };
  if (n) { n.addEventListener('blur', function () { if (!this.value.trim()) err(this, 'Name is required.'); else clr(this); }); n.addEventListener('focus', function () { clr(this); }); }
  if (e) { e.addEventListener('blur', function () { var v = this.value.trim(); if (!v) err(this, 'Email is required.'); else if (!isValidEmail(v)) err(this, 'Invalid email.'); else clr(this); }); e.addEventListener('focus', function () { clr(this); }); }
}

function setupContactSubmit() {
  var f = document.getElementById('contact-form'); if (!f) return;
  f.addEventListener('submit', function (e) {
    e.preventDefault(); var btn = f.querySelector('[type="submit"]'); btn.disabled = true; btn.textContent = 'Sending...';
    var mw = (typeof SHEETS_CONFIG !== 'undefined') ? (SHEETS_CONFIG.MIDDLEWARE_URL || '') : '';
    fetch(mw + '/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('name').value, email: document.getElementById('email').value, message: document.getElementById('message').value }) }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.success) { f.style.display = 'none'; var s = document.createElement('div'); s.className = 'contact-success'; s.innerHTML = '<p>Thanks! We\'ll be in touch.</p>'; f.parentNode.insertBefore(s, f.nextSibling); }
      else throw new Error(d.error);
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Send'; showToast(err.message, 'error'); });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatTimeslot: formatTimeslot, formatPhoneInput: formatPhoneInput, isValidEmail: isValidEmail, isValidPhone: isValidPhone, calcCompletionRange: calcCompletionRange };
}

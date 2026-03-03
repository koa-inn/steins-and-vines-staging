var RESERVATION_KEY = 'sv-reservation';       // legacy, for migration only
var FERMENT_CART_KEY = 'sv-cart-ferment';
var INGREDIENT_CART_KEY = 'sv-cart-ingredients';
var _activeCartTab = 'kits';                  // tracks which product tab is active

function migrateReservationData() {
  try {
    var legacy = JSON.parse(localStorage.getItem(RESERVATION_KEY));
    if (!legacy || !legacy.length) return;
    var ferment = [];
    var ingredients = [];
    legacy.forEach(function (item) {
      var type = item.item_type || 'kit';
      if (type === 'kit') {
        ferment.push(item);
      } else {
        ingredients.push(item);
      }
    });
    if (ferment.length) localStorage.setItem(FERMENT_CART_KEY, JSON.stringify(ferment));
    if (ingredients.length) localStorage.setItem(INGREDIENT_CART_KEY, JSON.stringify(ingredients));
    localStorage.removeItem(RESERVATION_KEY);
  } catch (e) { /* ignore corrupt data */ }
}

function getCartKeyForTab(tab) {
  if (tab === 'ingredients') return INGREDIENT_CART_KEY;
  return FERMENT_CART_KEY;
}

function getCartKey(product) {
  var itemType = product._item_type || product.item_type || 'kit';
  if (itemType === 'ingredient') return INGREDIENT_CART_KEY;
  return FERMENT_CART_KEY;
}

function getReservation(cartKey) {
  try {
    var key = cartKey || getCartKeyForTab(_activeCartTab);
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch (e) {
    return [];
  }
}

function saveReservation(items, cartKey) {
  var key = cartKey || getCartKeyForTab(_activeCartTab);
  localStorage.setItem(key, JSON.stringify(items));
}

function getReservedQty(productKey) {
  // Search both carts so reserve controls always find the item
  var all = [].concat(getReservation(FERMENT_CART_KEY), getReservation(INGREDIENT_CART_KEY));
  for (var i = 0; i < all.length; i++) {
    if ((all[i].name + '|' + all[i].brand) === productKey) {
      return all[i].qty || 1;
    }
  }
  return 0;
}

function isReserved(productKey) {
  return getReservedQty(productKey) > 0;
}

function getEffectiveMax(product) {
  var itemType = product._item_type || product.item_type || 'kit';
  var maxOrder = parseInt(product.max_order_qty, 10);
  if (isNaN(maxOrder) || maxOrder <= 0) maxOrder = Infinity;
  if (itemType === 'ingredient' || itemType === 'service') {
    var stock = parseInt(product.stock, 10) || 0;
    return Math.min(maxOrder, stock);
  }
  return maxOrder;
}

function setReservationQty(product, qty) {
  var cartKey = getCartKey(product);
  var items = getReservation(cartKey);
  var key = product.name + '|' + (product.brand || '');
  var idx = -1;
  for (var i = 0; i < items.length; i++) {
    if ((items[i].name + '|' + items[i].brand) === key) {
      idx = i;
      break;
    }
  }

  var maxQty = getEffectiveMax(product);
  if (maxQty <= 0 && qty > 0) return;
  if (qty > maxQty) qty = maxQty;

  if (qty <= 0) {
    if (idx !== -1) {
      items.splice(idx, 1);
      if (navigator.vibrate) navigator.vibrate(10);
    }
  } else if (idx !== -1) {
    items[idx].qty = qty;
  } else {
    var effectiveStock = (product.available !== undefined && product.available !== '')
      ? parseInt(product.available, 10) || 0
      : parseInt(product.stock, 10) || 0;
    items.push({
      name: product.name,
      brand: product.brand || '',
      price: product.retail_instore || product.retail_kit || product.price_per_unit || product.price || '',
      discount: product.discount || '',
      stock: effectiveStock,
      time: product.time || '',
      qty: qty,
      item_type: product._item_type || 'kit',
      sku: product.sku || '',
      unit: product.unit || '',
      tax_percentage: parseFloat(product.tax_percentage) || 0,
      max_order_qty: product.max_order_qty || '',
      zoho_item_id: product.zoho_item_id || product.item_id || '',
      millable: product.millable || '',
      cartAddedAt: Date.now()
    });
    if (navigator.vibrate) navigator.vibrate(10);
  }

  saveReservation(items, cartKey);
  updateReservationBar();
}

function refreshAllReserveControls() {
  document.querySelectorAll('.product-reserve-wrap').forEach(function (wrap) {
    if (!wrap._reserveProduct) return;
    var fn = wrap._reserveRenderer || renderReserveControl;
    fn(wrap, wrap._reserveProduct, wrap._reserveKey);
  });
}

function renderReserveControl(wrap, product, productKey) {
  wrap._reserveProduct = product;
  wrap._reserveKey = productKey;
  wrap._reserveRenderer = renderReserveControl;
  wrap.innerHTML = '';
  var qty = getReservedQty(productKey);
  var maxQty = getEffectiveMax(product);

  if (qty === 0) {
    var reserveBtn = document.createElement('button');
    reserveBtn.type = 'button';
    if (maxQty <= 0) {
      reserveBtn.className = 'product-reserve-btn product-reserve-btn--disabled';
      reserveBtn.textContent = 'Out of Stock';
      reserveBtn.disabled = true;
    } else {
      reserveBtn.className = 'product-reserve-btn';
      var itemType = product._item_type || product.item_type || 'kit';
      reserveBtn.textContent = (itemType === 'kit') ? 'Reserve' : 'Add to Cart';
      reserveBtn.addEventListener('click', function () {
        setReservationQty(product, 1);
        trackEvent('add_to_cart', product.sku || '', product.name || '');
        renderReserveControl(wrap, product, productKey);
      });
    }
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
    if (qty >= maxQty) {
      plusBtn.className = 'qty-btn qty-btn--disabled';
      plusBtn.disabled = true;
    } else {
      plusBtn.className = 'qty-btn';
      plusBtn.addEventListener('click', function () {
        setReservationQty(product, qty + 1);
        renderReserveControl(wrap, product, productKey);
      });
    }
    plusBtn.textContent = '+';

    controls.appendChild(minusBtn);
    controls.appendChild(qtySpan);
    controls.appendChild(plusBtn);
    wrap.appendChild(controls);
  }
}

function isWeightUnit(unit) {
  var u = (unit || '').toLowerCase().trim();
  return u === 'kg' || u === 'g' || u.indexOf('kg') !== -1 || u.indexOf(' g') !== -1 || u === 'gram' || u === 'grams';
}

function hasWeightConfig(item) {
  return isWeightUnit(item.unit);
}

function renderWeightControl(wrap, product, productKey) {
  wrap._reserveProduct = product;
  wrap._reserveKey = productKey;
  wrap._reserveRenderer = renderWeightControl;
  wrap.innerHTML = '';
  var unit = (product.unit || '').trim();
  var unitLower = unit.toLowerCase();
  var isKg = unitLower === 'kg' || unitLower.indexOf('kg') !== -1;
  var minVal = parseFloat(product.low_amount) || (isKg ? 0.01 : 10);
  var maxVal = parseFloat(product.high_amount) || (isKg ? 15 : 5000);
  var stepVal = isKg ? (parseFloat(product.step) || 0.01) : 10;
  var decimals = isKg ? 2 : 0;
  var pricePerUnit = parseFloat((product.price_per_unit || '0').replace(/[^0-9.]/g, '')) || 0;
  var currentQty = getReservedQty(productKey);

  if (currentQty === 0) {
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'product-reserve-btn';
    addBtn.textContent = 'Add to Cart';
    addBtn.addEventListener('click', function () {
      setReservationQty(product, minVal);
      trackEvent('add_to_cart', product.sku || '', product.name || '');
      renderWeightControl(wrap, product, productKey);
    });
    wrap.appendChild(addBtn);
    return;
  }

  var initVal = currentQty;

  var container = document.createElement('div');
  container.className = 'weight-control';

  // Amount display badge
  var amountBadge = document.createElement('div');
  amountBadge.className = 'weight-control-amount-badge';
  amountBadge.textContent = parseFloat(initVal).toFixed(decimals) + ' ' + unit;
  container.appendChild(amountBadge);

  // Slider row: minus button, range, plus button
  var sliderRow = document.createElement('div');
  sliderRow.className = 'weight-control-slider-row';

  var minusBtn = document.createElement('button');
  minusBtn.type = 'button';
  minusBtn.className = 'weight-control-step-btn';
  minusBtn.textContent = '\u2212';
  minusBtn.setAttribute('aria-label', 'Decrease amount');

  var rangeInput = document.createElement('input');
  rangeInput.type = 'range';
  rangeInput.className = 'weight-control-range';
  rangeInput.min = String(minVal);
  rangeInput.max = String(maxVal);
  rangeInput.step = String(stepVal);
  rangeInput.value = String(initVal);
  rangeInput.setAttribute('aria-label', 'Select amount in ' + unit);

  var plusBtn = document.createElement('button');
  plusBtn.type = 'button';
  plusBtn.className = 'weight-control-step-btn';
  plusBtn.textContent = '+';
  plusBtn.setAttribute('aria-label', 'Increase amount');

  sliderRow.appendChild(minusBtn);
  sliderRow.appendChild(rangeInput);
  sliderRow.appendChild(plusBtn);
  container.appendChild(sliderRow);

  // Min/max labels below slider
  var rangeLabels = document.createElement('div');
  rangeLabels.className = 'weight-control-range-labels';
  var minLabel = document.createElement('span');
  minLabel.textContent = parseFloat(minVal).toFixed(decimals) + ' ' + unit;
  var maxLabel = document.createElement('span');
  maxLabel.textContent = parseFloat(maxVal).toFixed(decimals) + ' ' + unit;
  rangeLabels.appendChild(minLabel);
  rangeLabels.appendChild(maxLabel);
  container.appendChild(rangeLabels);

  // Exact input row
  var inputRow = document.createElement('div');
  inputRow.className = 'weight-control-input-row';

  var inputLabel = document.createElement('span');
  inputLabel.className = 'weight-control-input-label';
  inputLabel.textContent = 'Exact:';

  var numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.className = 'weight-control-input';
  numInput.setAttribute('inputmode', 'decimal');
  numInput.min = String(minVal);
  numInput.max = String(maxVal);
  numInput.step = String(stepVal);
  numInput.value = parseFloat(initVal).toFixed(decimals);
  numInput.setAttribute('aria-label', 'Type exact amount in ' + unit);

  var unitLabel = document.createElement('span');
  unitLabel.className = 'weight-control-unit-label';
  unitLabel.textContent = unit;

  inputRow.appendChild(inputLabel);
  inputRow.appendChild(numInput);
  inputRow.appendChild(unitLabel);
  container.appendChild(inputRow);

  // Price display
  var priceDisplay = document.createElement('div');
  priceDisplay.className = 'weight-control-price';
  container.appendChild(priceDisplay);

  // Add to cart button
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'weight-control-add';
  container.appendChild(addBtn);

  // Remove from cart button
  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'weight-control-remove';
  removeBtn.setAttribute('aria-label', 'Remove from cart');
  removeBtn.textContent = '\u00D7';
  container.appendChild(removeBtn);

  // Helper: snap value to nearest step and clamp
  function snapVal(v) {
    var snapped = Math.round(v / stepVal) * stepVal;
    if (snapped < minVal) snapped = minVal;
    if (snapped > maxVal) snapped = maxVal;
    return parseFloat(snapped.toFixed(decimals + 2));
  }

  // Helper: compute fill percentage for the range track
  function fillPercent(v) {
    if (maxVal === minVal) return 0;
    return ((v - minVal) / (maxVal - minVal)) * 100;
  }

  // Update all UI from current slider value
  function syncUI() {
    var amt = snapVal(parseFloat(rangeInput.value) || minVal);
    var total = amt * pricePerUnit;
    amountBadge.textContent = parseFloat(amt).toFixed(decimals) + ' ' + unit;
    priceDisplay.textContent = parseFloat(amt).toFixed(decimals) + ' ' + unit + ' \u00D7 $' + pricePerUnit.toFixed(2) + '/' + unit + ' = $' + total.toFixed(2);

    if (currentQty > 0) {
      addBtn.textContent = 'Update Cart \u2014 $' + total.toFixed(2);
      addBtn.className = 'weight-control-add weight-control-add--update';
    } else {
      addBtn.textContent = 'Add to Cart \u2014 $' + total.toFixed(2);
      addBtn.className = 'weight-control-add';
    }

    // Update filled track via CSS custom property
    rangeInput.style.setProperty('--fill', fillPercent(amt) + '%');
  }

  syncUI();

  // Slider input
  rangeInput.addEventListener('input', function () {
    numInput.value = parseFloat(snapVal(parseFloat(rangeInput.value))).toFixed(decimals);
    syncUI();
  });

  // Numeric input
  numInput.addEventListener('input', function () {
    var val = parseFloat(numInput.value);
    if (isNaN(val)) return;
    if (val < minVal) val = minVal;
    if (val > maxVal) val = maxVal;
    rangeInput.value = String(val);
    syncUI();
  });

  numInput.addEventListener('blur', function () {
    var val = snapVal(parseFloat(numInput.value) || minVal);
    numInput.value = parseFloat(val).toFixed(decimals);
    rangeInput.value = String(val);
    syncUI();
  });

  // Step buttons
  minusBtn.addEventListener('click', function () {
    var val = snapVal((parseFloat(rangeInput.value) || minVal) - stepVal);
    rangeInput.value = String(val);
    numInput.value = parseFloat(val).toFixed(decimals);
    syncUI();
  });

  plusBtn.addEventListener('click', function () {
    var val = snapVal((parseFloat(rangeInput.value) || minVal) + stepVal);
    rangeInput.value = String(val);
    numInput.value = parseFloat(val).toFixed(decimals);
    syncUI();
  });

  // Add to cart
  addBtn.addEventListener('click', function () {
    var amt = snapVal(parseFloat(numInput.value) || minVal);
    setReservationQty(product, amt);
    trackEvent('add_to_cart', product.sku || '', product.name || '');
    renderWeightControl(wrap, product, productKey);
  });

  removeBtn.addEventListener('click', function () {
    setReservationQty(product, 0);
    updateReservationBar();
    renderWeightControl(wrap, product, productKey);
  });

  wrap.appendChild(container);
}

function renderWeightControlCompact(wrap, product, productKey) {
  wrap._reserveProduct = product;
  wrap._reserveKey = productKey;
  wrap._reserveRenderer = renderWeightControlCompact;
  wrap.innerHTML = '';
  var unit = (product.unit || '').trim();
  var unitLower = unit.toLowerCase();
  var isKg = unitLower === 'kg' || unitLower.indexOf('kg') !== -1;
  var minVal = parseFloat(product.low_amount) || (isKg ? 0.01 : 10);
  var maxVal = parseFloat(product.high_amount) || (isKg ? 15 : 5000);
  var stepVal = isKg ? (parseFloat(product.step) || 0.01) : 10;
  var decimals = isKg ? 2 : 0;
  var pricePerUnit = parseFloat((product.price_per_unit || '0').replace(/[^0-9.]/g, '')) || 0;
  var currentQty = getReservedQty(productKey);

  if (currentQty === 0) {
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'product-reserve-btn';
    addBtn.textContent = 'Add to Cart';
    addBtn.addEventListener('click', function () {
      setReservationQty(product, minVal);
      trackEvent('add_to_cart', product.sku || '', product.name || '');
      renderWeightControlCompact(wrap, product, productKey);
    });
    wrap.appendChild(addBtn);
    return;
  }

  var initVal = currentQty;

  var container = document.createElement('div');
  container.className = 'weight-control-compact';

  // Top row: slider with amount badge
  var sliderRow = document.createElement('div');
  sliderRow.className = 'weight-control-compact-slider-row';

  var rangeInput = document.createElement('input');
  rangeInput.type = 'range';
  rangeInput.className = 'weight-control-range weight-control-range--compact';
  rangeInput.min = String(minVal);
  rangeInput.max = String(maxVal);
  rangeInput.step = String(stepVal);
  rangeInput.value = String(initVal);
  rangeInput.setAttribute('aria-label', 'Select amount in ' + unit);

  var amountTag = document.createElement('span');
  amountTag.className = 'weight-control-compact-amount';
  amountTag.textContent = parseFloat(initVal).toFixed(decimals) + ' ' + unit;

  sliderRow.appendChild(rangeInput);
  sliderRow.appendChild(amountTag);
  container.appendChild(sliderRow);

  // Bottom row: input + price + add button
  var actionRow = document.createElement('div');
  actionRow.className = 'weight-control-compact-action-row';

  var numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.className = 'weight-control-input';
  numInput.setAttribute('inputmode', 'decimal');
  numInput.min = String(minVal);
  numInput.max = String(maxVal);
  numInput.step = String(stepVal);
  numInput.value = parseFloat(initVal).toFixed(decimals);

  var unitLabel = document.createElement('span');
  unitLabel.className = 'weight-control-unit-label';
  unitLabel.textContent = unit;

  var priceTag = document.createElement('span');
  priceTag.className = 'weight-control-compact-price';
  priceTag.textContent = '$' + (initVal * pricePerUnit).toFixed(2);

  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'weight-control-add';
  addBtn.textContent = currentQty > 0 ? 'Update' : 'Add';

  var removeBtnC = document.createElement('button');
  removeBtnC.type = 'button';
  removeBtnC.className = 'weight-control-remove';
  removeBtnC.setAttribute('aria-label', 'Remove from cart');
  removeBtnC.textContent = '\u00D7';

  actionRow.appendChild(numInput);
  actionRow.appendChild(unitLabel);
  actionRow.appendChild(priceTag);
  actionRow.appendChild(addBtn);
  actionRow.appendChild(removeBtnC);
  container.appendChild(actionRow);

  // Helper: snap value to nearest step and clamp
  function snapVal(v) {
    var snapped = Math.round(v / stepVal) * stepVal;
    if (snapped < minVal) snapped = minVal;
    if (snapped > maxVal) snapped = maxVal;
    return parseFloat(snapped.toFixed(decimals + 2));
  }

  function fillPercent(v) {
    if (maxVal === minVal) return 0;
    return ((v - minVal) / (maxVal - minVal)) * 100;
  }

  function syncCompactUI() {
    var amt = snapVal(parseFloat(rangeInput.value) || minVal);
    amountTag.textContent = parseFloat(amt).toFixed(decimals) + ' ' + unit;
    priceTag.textContent = '$' + (amt * pricePerUnit).toFixed(2);
    rangeInput.style.setProperty('--fill', fillPercent(amt) + '%');
  }

  syncCompactUI();

  rangeInput.addEventListener('input', function () {
    numInput.value = parseFloat(snapVal(parseFloat(rangeInput.value))).toFixed(decimals);
    syncCompactUI();
  });

  numInput.addEventListener('input', function () {
    var val = parseFloat(numInput.value);
    if (isNaN(val)) return;
    if (val < minVal) val = minVal;
    if (val > maxVal) val = maxVal;
    rangeInput.value = String(val);
    syncCompactUI();
  });

  numInput.addEventListener('blur', function () {
    var val = snapVal(parseFloat(numInput.value) || minVal);
    numInput.value = parseFloat(val).toFixed(decimals);
    rangeInput.value = String(val);
    syncCompactUI();
  });

  addBtn.addEventListener('click', function () {
    var amt = snapVal(parseFloat(numInput.value) || minVal);
    setReservationQty(product, amt);
    trackEvent('add_to_cart', product.sku || '', product.name || '');
    renderWeightControlCompact(wrap, product, productKey);
  });

  removeBtnC.addEventListener('click', function () {
    setReservationQty(product, 0);
    updateReservationBar();
    renderWeightControlCompact(wrap, product, productKey);
  });

  wrap.appendChild(container);
}

function initReservationBar() {
  var barHTML = '<div class="container">' +
    '<span class="reservation-bar-count"></span>' +
    '<span class="reservation-bar-actions">' +
    '<button type="button" class="reservation-bar-clear">Clear Cart</button>' +
    '<a href="reservation.html" class="reservation-bar-link">Checkout &rarr;</a>' +
    '</span>' +
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

  // Bind clear buttons
  document.querySelectorAll('.reservation-bar-clear').forEach(function (btn) {
    btn.addEventListener('click', function () {
      saveReservation([]);
      updateReservationBar();
      refreshAllReserveControls();
    });
  });

  var sidebarClearBtn = document.getElementById('cart-sidebar-clear');
  if (sidebarClearBtn) {
    sidebarClearBtn.addEventListener('click', function () {
      saveReservation([]);
      updateReservationBar();
      renderCartSidebar();
      refreshAllReserveControls();
    });
  }

  // Ingredient minimum-qty checkout guard (all three checkout entry points)
  document.addEventListener('click', function (e) {
    var link = e.target.closest('.reservation-bar-link, .cart-sidebar-checkout, #cart-drawer-checkout');
    if (!link) return;
    var href = link.getAttribute('href') || '';
    if (href.indexOf('cart=ingredient') === -1) return;
    if (!hasMinQtyIngredients()) return;
    e.preventDefault();
    showMinQtyConfirm(href);
  });

  updateReservationBar();
  renderCartSidebar();
  initCartDrawer();
}

function updateReservationBar() {
  var bars = document.querySelectorAll('.reservation-bar');
  if (bars.length === 0) return;

  var isServices = (_activeCartTab === 'services');
  var activeKey = getCartKeyForTab(_activeCartTab);
  var items = getReservation(activeKey);
  var total = 0;
  items.forEach(function (item) { total += isWeightUnit(item.unit) ? 1 : (item.qty || 1); });

  // Count items in the other cart
  var otherKey = (activeKey === FERMENT_CART_KEY) ? INGREDIENT_CART_KEY : FERMENT_CART_KEY;
  var otherItems = getReservation(otherKey);
  var otherTotal = 0;
  otherItems.forEach(function (item) { otherTotal += isWeightUnit(item.unit) ? 1 : (item.qty || 1); });

  var isFerment = (_activeCartTab === 'kits');
  var noun = isFerment ? 'reservation' : 'order';
  var label = total + (total === 1 ? ' item in your ' + noun : ' items in your ' + noun);
  if (otherTotal > 0) {
    var otherNoun = isFerment ? 'order' : 'kits';
    label += ' (' + otherTotal + ' in ' + otherNoun + ' cart)';
  }

  var checkoutHref = 'reservation.html?cart=' + (isFerment ? 'ferment' : 'ingredient');

  for (var i = 0; i < bars.length; i++) {
    var countEl = bars[i].querySelector('.reservation-bar-count');
    var linkEl = bars[i].querySelector('.reservation-bar-link');
    if (linkEl) linkEl.setAttribute('href', checkoutHref);
    if (total > 0 && !isServices) {
      bars[i].classList.remove('hidden');
      if (countEl) countEl.textContent = label;
    } else {
      bars[i].classList.add('hidden');
    }
  }
  // Keep catalog-controls above reservation bar on mobile — no :has() needed
  var fixedBar = document.getElementById('reservation-bar');
  var barVisible = !!(fixedBar && !fixedBar.classList.contains('hidden'));
  document.body.classList.toggle('has-reservation-bar', barVisible);
  if (barVisible) {
    // Measure height synchronously (offsetHeight forces layout) so CSS var is
    // ready before the browser paints the next frame
    document.documentElement.style.setProperty('--reservation-bar-height', fixedBar.offsetHeight + 'px');
  }
  renderCartSidebar();
  renderCartDrawer();
}

function renderCartSidebar() {
  var container = document.getElementById('cart-sidebar-items');
  var footer = document.getElementById('cart-sidebar-footer');
  var totalEl = document.getElementById('cart-sidebar-total');
  var sidebarEl = document.getElementById('cart-sidebar');
  if (!container) return;

  var isFerment = (_activeCartTab === 'kits');
  var activeKey = getCartKeyForTab(_activeCartTab);
  var items = getReservation(activeKey);
  container.innerHTML = '';

  // Update sidebar header
  var headerEl = sidebarEl ? sidebarEl.querySelector('.cart-sidebar-header h3') : null;
  if (headerEl) headerEl.textContent = isFerment ? 'Your Reservations' : 'Your Order';

  // Update checkout link and button text
  var checkoutLink = sidebarEl ? sidebarEl.querySelector('.cart-sidebar-checkout') : null;
  if (checkoutLink) {
    checkoutLink.setAttribute('href', 'reservation.html?cart=' + (isFerment ? 'ferment' : 'ingredient'));
    checkoutLink.textContent = isFerment ? 'Reserve' : 'Checkout';
  }

  if (items.length === 0) {
    if (sidebarEl) sidebarEl.classList.remove('cart-sidebar--active');
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'cart-sidebar-empty';
    emptyMsg.textContent = isFerment ? 'No reservations yet.' : 'Your order is empty.';
    container.appendChild(emptyMsg);

    // Check if other cart has items
    var otherKey = isFerment ? INGREDIENT_CART_KEY : FERMENT_CART_KEY;
    var otherItems = getReservation(otherKey);
    if (otherItems.length > 0) {
      var otherNote = document.createElement('p');
      otherNote.className = 'cart-sidebar-note';
      var otherNoun = isFerment ? 'order' : 'kits';
      otherNote.textContent = 'You have ' + otherItems.length + ' item' + (otherItems.length > 1 ? 's' : '') + ' in your ' + otherNoun + ' cart \u2014 switch tabs to view.';
      container.appendChild(otherNote);
    }

    if (footer) footer.classList.add('hidden');
    return;
  }

  if (sidebarEl) sidebarEl.classList.add('cart-sidebar--active');

  if (footer) footer.classList.remove('hidden');

  var subtotal = 0;
  items.forEach(function (item) {
    var price = parseFloat((item.price || '0').replace(/[^0-9.]/g, '')) || 0;
    var disc = parseFloat(item.discount) || 0;
    if (disc > 0) price = price * (1 - disc / 100);
    var lineTotal = price * (item.qty || 1);
    subtotal += lineTotal;

    var row = document.createElement('div');
    row.className = 'cart-sidebar-item';

    var info = document.createElement('div');
    info.className = 'cart-sidebar-item-info';

    var nameEl = document.createElement('div');
    nameEl.className = 'cart-sidebar-item-name';
    nameEl.textContent = item.name;
    info.appendChild(nameEl);

    if (item.brand) {
      var brandEl = document.createElement('div');
      brandEl.className = 'cart-sidebar-item-brand';
      brandEl.textContent = item.brand;
      info.appendChild(brandEl);
    }

    var priceEl = document.createElement('div');
    priceEl.className = 'cart-sidebar-item-price';
    if (disc > 0) {
      priceEl.innerHTML = '<span class="cart-price-original">' + formatCurrency(item.price) + '</span> ' + formatCurrency(price);
    } else if (price > 0) {
      priceEl.textContent = formatCurrency(price);
    }
    info.appendChild(priceEl);

    row.appendChild(info);

    var controls = document.createElement('div');
    controls.className = 'cart-sidebar-item-controls';

    var itemIsWeighted = isWeightUnit(item.unit);

    if (itemIsWeighted) {
      var weightDisplay = document.createElement('div');
      weightDisplay.className = 'cart-sidebar-item-weight';
      weightDisplay.textContent = (item.qty || 0) + ' ' + item.unit;
      controls.appendChild(weightDisplay);
    } else {
      var itemMax = getEffectiveMax(item);
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
            if ((current[i].name + '|' + (current[i].brand || '')) === (itm.name + '|' + (itm.brand || ''))) {
              current[i].qty = (current[i].qty || 1) - 1;
              if (current[i].qty <= 0) current.splice(i, 1);
              break;
            }
          }
          saveReservation(current);
          updateReservationBar();
          renderCartSidebar();
        };
      })(item));

      var qtySpan = document.createElement('span');
      qtySpan.className = 'qty-value';
      qtySpan.textContent = item.qty || 1;

      var plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.textContent = '+';
      if ((item.qty || 1) >= itemMax) {
        plusBtn.className = 'qty-btn qty-btn--disabled';
        plusBtn.disabled = true;
      } else {
        plusBtn.className = 'qty-btn';
        plusBtn.addEventListener('click', (function (itm, max) {
          return function () {
            var current = getReservation();
            for (var i = 0; i < current.length; i++) {
              if ((current[i].name + '|' + (current[i].brand || '')) === (itm.name + '|' + (itm.brand || ''))) {
                var newQty = (current[i].qty || 1) + 1;
                if (newQty > max) newQty = max;
                current[i].qty = newQty;
                break;
              }
            }
            saveReservation(current);
            updateReservationBar();
            renderCartSidebar();
          };
        })(item, itemMax));
      }

      qtyControls.appendChild(minusBtn);
      qtyControls.appendChild(qtySpan);
      qtyControls.appendChild(plusBtn);
      controls.appendChild(qtyControls);
    }

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cart-sidebar-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        var filtered = current.filter(function (r) {
          return (r.name + '|' + (r.brand || '')) !== (itm.name + '|' + (itm.brand || ''));
        });
        saveReservation(filtered);
        updateReservationBar();
        renderCartSidebar();
        refreshAllReserveControls();
      };
    })(item));
    controls.appendChild(removeBtn);

    var lineTotalEl = document.createElement('div');
    lineTotalEl.className = 'cart-sidebar-line-total';
    lineTotalEl.textContent = '$' + lineTotal.toFixed(2);
    controls.appendChild(lineTotalEl);

    row.appendChild(controls);
    container.appendChild(row);
  });

  if (totalEl) totalEl.textContent = '$' + subtotal.toFixed(2);

  // Show note about other cart if it has items
  var otherKey2 = isFerment ? INGREDIENT_CART_KEY : FERMENT_CART_KEY;
  var otherItems2 = getReservation(otherKey2);
  if (otherItems2.length > 0) {
    var note = document.createElement('p');
    note.className = 'cart-sidebar-note';
    var noun2 = isFerment ? 'order' : 'kits';
    note.textContent = 'You also have ' + otherItems2.length + ' item' + (otherItems2.length > 1 ? 's' : '') + ' in your ' + noun2 + ' cart \u2014 switch tabs to view.';
    container.appendChild(note);
  }
}

// ===== Mobile Cart Drawer =====

function renderCartDrawer() {
  var container = document.getElementById('cart-drawer-items');
  var footer = document.getElementById('cart-drawer-footer');
  var totalEl = document.getElementById('cart-drawer-total');
  var titleEl = document.getElementById('cart-drawer-title');
  var checkoutLink = document.getElementById('cart-drawer-checkout');
  if (!container) return;

  var isFerment = (_activeCartTab === 'kits');
  var activeKey = getCartKeyForTab(_activeCartTab);
  var items = getReservation(activeKey);
  container.innerHTML = '';

  if (titleEl) titleEl.textContent = isFerment ? 'Your Reservations' : 'Your Order';
  if (checkoutLink) {
    checkoutLink.setAttribute('href', 'reservation.html?cart=' + (isFerment ? 'ferment' : 'ingredient'));
    checkoutLink.textContent = isFerment ? 'Reserve' : 'Checkout';
  }

  if (items.length === 0) {
    var emptyMsg = document.createElement('p');
    emptyMsg.className = 'cart-sidebar-empty';
    emptyMsg.textContent = isFerment ? 'No reservations yet.' : 'Your order is empty.';
    container.appendChild(emptyMsg);

    var otherKey = isFerment ? INGREDIENT_CART_KEY : FERMENT_CART_KEY;
    var otherItems = getReservation(otherKey);
    if (otherItems.length > 0) {
      var otherNote = document.createElement('p');
      otherNote.className = 'cart-sidebar-note';
      var otherNoun = isFerment ? 'order' : 'kits';
      otherNote.textContent = 'You have ' + otherItems.length + ' item' + (otherItems.length > 1 ? 's' : '') + ' in your ' + otherNoun + ' cart \u2014 switch tabs to view.';
      container.appendChild(otherNote);
    }
    if (footer) footer.classList.add('hidden');
    return;
  }

  if (footer) footer.classList.remove('hidden');

  var subtotal = 0;
  items.forEach(function (item) {
    var price = parseFloat((item.price || '0').replace(/[^0-9.]/g, '')) || 0;
    var disc = parseFloat(item.discount) || 0;
    if (disc > 0) price = price * (1 - disc / 100);
    var lineTotal = price * (item.qty || 1);
    subtotal += lineTotal;

    var row = document.createElement('div');
    row.className = 'cart-sidebar-item';

    var info = document.createElement('div');
    info.className = 'cart-sidebar-item-info';

    var nameEl = document.createElement('div');
    nameEl.className = 'cart-sidebar-item-name';
    nameEl.textContent = item.name;
    info.appendChild(nameEl);

    if (item.brand) {
      var brandEl = document.createElement('div');
      brandEl.className = 'cart-sidebar-item-brand';
      brandEl.textContent = item.brand;
      info.appendChild(brandEl);
    }

    var priceEl = document.createElement('div');
    priceEl.className = 'cart-sidebar-item-price';
    if (disc > 0) {
      priceEl.innerHTML = '<span class="cart-price-original">' + formatCurrency(item.price) + '</span> ' + formatCurrency(price);
    } else if (price > 0) {
      priceEl.textContent = formatCurrency(price);
    }
    info.appendChild(priceEl);
    row.appendChild(info);

    var controls = document.createElement('div');
    controls.className = 'cart-sidebar-item-controls';

    var itemIsWeighted = isWeightUnit(item.unit);
    if (itemIsWeighted) {
      var weightDisplay = document.createElement('div');
      weightDisplay.className = 'cart-sidebar-item-weight';
      weightDisplay.textContent = (item.qty || 0) + ' ' + item.unit;
      controls.appendChild(weightDisplay);
    } else {
      var itemMax = getEffectiveMax(item);
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
            if ((current[i].name + '|' + (current[i].brand || '')) === (itm.name + '|' + (itm.brand || ''))) {
              current[i].qty = (current[i].qty || 1) - 1;
              if (current[i].qty <= 0) current.splice(i, 1);
              break;
            }
          }
          saveReservation(current);
          updateReservationBar();
          renderCartDrawer();
        };
      })(item));

      var qtySpan = document.createElement('span');
      qtySpan.className = 'qty-value';
      qtySpan.textContent = item.qty || 1;

      var plusBtn = document.createElement('button');
      plusBtn.type = 'button';
      plusBtn.textContent = '+';
      if ((item.qty || 1) >= itemMax) {
        plusBtn.className = 'qty-btn qty-btn--disabled';
        plusBtn.disabled = true;
      } else {
        plusBtn.className = 'qty-btn';
        plusBtn.addEventListener('click', (function (itm, max) {
          return function () {
            var current = getReservation();
            for (var i = 0; i < current.length; i++) {
              if ((current[i].name + '|' + (current[i].brand || '')) === (itm.name + '|' + (itm.brand || ''))) {
                var newQty = (current[i].qty || 1) + 1;
                if (newQty > max) newQty = max;
                current[i].qty = newQty;
                break;
              }
            }
            saveReservation(current);
            updateReservationBar();
            renderCartDrawer();
          };
        })(item, itemMax));
      }

      qtyControls.appendChild(minusBtn);
      qtyControls.appendChild(qtySpan);
      qtyControls.appendChild(plusBtn);
      controls.appendChild(qtyControls);
    }

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'cart-sidebar-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', (function (itm) {
      return function () {
        var current = getReservation();
        var filtered = current.filter(function (r) {
          return (r.name + '|' + (r.brand || '')) !== (itm.name + '|' + (itm.brand || ''));
        });
        saveReservation(filtered);
        updateReservationBar();
        renderCartDrawer();
        refreshAllReserveControls();
      };
    })(item));
    controls.appendChild(removeBtn);

    var lineTotalEl = document.createElement('div');
    lineTotalEl.className = 'cart-sidebar-line-total';
    lineTotalEl.textContent = '$' + lineTotal.toFixed(2);
    controls.appendChild(lineTotalEl);

    row.appendChild(controls);
    container.appendChild(row);
  });

  if (totalEl) totalEl.textContent = '$' + subtotal.toFixed(2);

  var otherKey2 = isFerment ? INGREDIENT_CART_KEY : FERMENT_CART_KEY;
  var otherItems2 = getReservation(otherKey2);
  if (otherItems2.length > 0) {
    var note = document.createElement('p');
    note.className = 'cart-sidebar-note';
    var noun2 = isFerment ? 'order' : 'kits';
    note.textContent = 'You also have ' + otherItems2.length + ' item' + (otherItems2.length > 1 ? 's' : '') + ' in your ' + noun2 + ' cart \u2014 switch tabs to view.';
    container.appendChild(note);
  }
}

function openCartDrawer() {
  var drawer = document.getElementById('cart-drawer');
  var backdrop = document.getElementById('cart-drawer-backdrop');
  if (!drawer) return;
  renderCartDrawer();
  drawer.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCartDrawer() {
  var drawer = document.getElementById('cart-drawer');
  var backdrop = document.getElementById('cart-drawer-backdrop');
  if (!drawer) return;
  drawer.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  document.body.style.overflow = '';
}

function initCartDrawer() {
  var backdrop = document.getElementById('cart-drawer-backdrop');
  var closeBtn = document.getElementById('cart-drawer-close');
  var clearBtn = document.getElementById('cart-drawer-clear');
  var checkoutLink = document.getElementById('cart-drawer-checkout');

  if (backdrop) backdrop.addEventListener('click', closeCartDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeCartDrawer);
  if (checkoutLink) checkoutLink.addEventListener('click', closeCartDrawer);
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      saveReservation([]);
      updateReservationBar();
      renderCartDrawer();
      refreshAllReserveControls();
    });
  }

  // Tap on reservation bar (not its buttons) to open drawer
  document.querySelectorAll('.reservation-bar').forEach(function (bar) {
    bar.addEventListener('click', function (e) {
      // Don't open if clicking the checkout link, clear button, or inline bar
      if (e.target.closest('.reservation-bar-link') || e.target.closest('.reservation-bar-clear')) return;
      if (bar.classList.contains('reservation-bar-inline')) return;
      // Only open on mobile
      if (window.innerWidth >= 1024) return;
      openCartDrawer();
    });
  });
}

// ===== Min-qty checkout guard =====

function hasMinQtyIngredients() {
  var items = getReservation(INGREDIENT_CART_KEY);
  for (var i = 0; i < items.length; i++) {
    if (parseFloat(items[i].qty) === 0.01) return true;
  }
  return false;
}

function showMinQtyConfirm(dest) {
  var overlay = document.createElement('div');
  overlay.className = 'min-qty-overlay';
  overlay.innerHTML =
    '<div class="min-qty-dialog">' +
    '<p class="min-qty-msg">One or more items in your cart is set to the minimum quantity (0.01\u00a0kg). Did you mean to adjust the amount before checking out?</p>' +
    '<div class="min-qty-actions">' +
    '<button type="button" class="btn btn-secondary min-qty-back">\u2190 Back</button>' +
    '<a href="' + dest + '" class="btn min-qty-continue">Continue with my order</a>' +
    '</div>' +
    '</div>';
  overlay.querySelector('.min-qty-back').addEventListener('click', function () {
    document.body.removeChild(overlay);
  });
  document.body.appendChild(overlay);
}

// ===== Reservation Page =====

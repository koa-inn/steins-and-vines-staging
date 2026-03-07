// ===== Label Card Shared Helpers =====

function getTintClass(product) {
  if (product.tint) return 'tint-' + product.tint.toLowerCase().replace(/\s+/g, '');
  if (!product.subcategory) return '';
  var sub = product.subcategory.toLowerCase().replace(/[^a-z]/g, '');
  var map = { red:'tint-red', white:'tint-white', rose:'tint-rose', ros:'tint-rose',
    fruit:'tint-fruit', specialty:'tint-specialty', pilsner:'tint-pilsner',
    amber:'tint-amber', wheat:'tint-wheat', ipa:'tint-ipa', pale:'tint-pale',
    session:'tint-session', saison:'tint-saison', lager:'tint-lager',
    stout:'tint-stout', porter:'tint-porter', redale:'tint-redale', brown:'tint-brown' };
  return map[sub] || '';
}

function buildLabelNotesToggle(product) {
  var wrap = document.createElement('div');
  wrap.className = 'notes-wrap';

  var toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'notes-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = 'Tasting Notes <span class="chevron">&#9660;</span>';

  var body = document.createElement('div');
  body.className = 'notes-body';

  if (product.sku) {
    var imageCol = document.createElement('div');
    imageCol.className = 'notes-image';
    var img = document.createElement('img');
    setResponsiveImg(img, product.sku);
    img.alt = product.name || 'Product image';
    img.loading = 'lazy';
    img.onerror = function() { this.parentElement.remove(); };
    imageCol.appendChild(img);
    body.appendChild(imageCol);
  }

  if (product.tasting_notes) {
    var textCol = document.createElement('div');
    textCol.className = 'notes-text';
    var p = document.createElement('p');
    p.textContent = product.tasting_notes;
    textCol.appendChild(p);
    body.appendChild(textCol);
  }

  var traitBody = (product.body || '').trim();
  var traitOak = (product.oak || '').trim();
  var traitSweet = (product.sweetness || '').trim();
  if (traitBody || traitOak || traitSweet) {
    var traits = document.createElement('div');
    traits.className = 'wine-traits';
    var traitItems = [
      { label: 'Body', value: traitBody },
      { label: 'Oak', value: traitOak },
      { label: 'Sweetness', value: traitSweet }
    ];
    for (var ti = 0; ti < traitItems.length; ti++) {
      if (traitItems[ti].value) {
        var col = document.createElement('div');
        col.className = 'trait-col';
        var lbl = document.createElement('span');
        lbl.className = 'trait-label';
        lbl.textContent = traitItems[ti].label;
        var val = document.createElement('span');
        val.className = 'trait-value';
        val.textContent = traitItems[ti].value;
        col.appendChild(lbl);
        col.appendChild(val);
        traits.appendChild(col);
      }
    }
    body.appendChild(traits);
  }

  toggle.addEventListener('click', function (w, t, prod) {
    return function () {
      var isOpen = w.classList.toggle('open');
      t.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) {
        trackEvent('detail', prod.sku || '', prod.name || '');
      }
    };
  }(wrap, toggle, product));

  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

function formatCurrency(val) {
  var num = typeof val === 'number' ? val : parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
  if (isNaN(num)) return '';
  return '$' + num.toFixed(2);
}

function buildLabelPriceFooter(product) {
  var discount = parseFloat(product.discount) || 0;
  var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
  var plusSign = pricingFrom ? '+' : '';
  var instore = (product.retail_instore || '').trim();
  var kit = (product.retail_kit || '').trim();

  var footer = document.createElement('div');
  footer.className = 'price-footer';

  if (instore) {
    var col1 = document.createElement('div');
    col1.className = 'price-col';
    var lbl1 = document.createElement('div');
    lbl1.className = 'price-label';
    lbl1.textContent = 'Ferment in store';
    col1.appendChild(lbl1);
    var val1 = document.createElement('div');
    val1.className = 'price-value';
    if (discount > 0) {
      var num1 = parseFloat(instore.replace(/[^0-9.]/g, ''));
      var sale1 = formatCurrency(num1 * (1 - discount / 100));
      val1.innerHTML = '<s style="color:#999;font-size:0.8rem;">' + formatCurrency(instore) + '</s> ' + sale1 + plusSign;
    } else {
      val1.textContent = formatCurrency(instore) + plusSign;
    }
    col1.appendChild(val1);
    footer.appendChild(col1);
  }

  if (kit) {
    var col2 = document.createElement('div');
    col2.className = 'price-col';
    var lbl2 = document.createElement('div');
    lbl2.className = 'price-label';
    lbl2.textContent = 'Kit only';
    col2.appendChild(lbl2);
    var val2 = document.createElement('div');
    val2.className = 'price-value';
    if (discount > 0) {
      var num2 = parseFloat(kit.replace(/[^0-9.]/g, ''));
      var sale2 = formatCurrency(num2 * (1 - discount / 100));
      val2.innerHTML = '<s style="color:#999;font-size:0.8rem;">' + formatCurrency(kit) + '</s> ' + sale2 + plusSign;
    } else {
      val2.textContent = formatCurrency(kit) + plusSign;
    }
    col2.appendChild(val2);
    footer.appendChild(col2);
  }

  return footer;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getTintClass: getTintClass, formatCurrency: formatCurrency };
}

// KIT_CATEGORIES is defined in js/lib/constants.js (prepended to the concat pipeline).
// Node test env fallback — when this module is loaded in isolation via require():
if (typeof KIT_CATEGORIES === 'undefined' && typeof require !== 'undefined') {
  var KIT_CATEGORIES = require('../lib/constants').KIT_CATEGORIES;
}

/**
 * Flatten Zoho custom_fields array onto a target object.
 * Guards against prototype-pollution attacks (T-30-05-PP):
 * labels that normalise to __proto__, constructor, or prototype are skipped.
 * Same guard pattern used in js/modules/17-search-overlay.js:176.
 *
 * @param {Object} obj - Target object to flatten onto (mutated in place).
 * @param {Array}  customFields - Array of { label, value } objects from Zoho.
 */
function flattenCustomFields(obj, customFields) {
  if (!customFields || !customFields.length) return;
  customFields.forEach(function (cf) {
    var key = (cf.label || '').toLowerCase().replace(/\s+/g, '_');
    if (!key) return;
    // Prototype-pollution guard — skip dangerous keys (T-30-05-PP)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    if (cf.value !== undefined && cf.value !== null) {
      obj[key] = String(cf.value);
    }
  });
}

/**
 * Test whether a product's resolved category matches a category filter.
 * When categoryFilter is falsy, reproduces the pre-existing "any kit category"
 * test used by loadProducts(). When categoryFilter is truthy, it must both be
 * a recognised KIT_CATEGORIES value AND be present in the product's resolved
 * category string.
 *
 * @param {Object} obj - Product-like object (category / _zoho_category / type).
 * @param {String} [categoryFilter] - e.g. 'wine' or 'beer'; falsy = match any kit category.
 * @returns {Boolean}
 */
function matchesKitCategory(obj, categoryFilter) {
  if (!obj) return false;
  var cat = (obj.category || obj._zoho_category || obj.type || '').toLowerCase();
  if (!cat) return false;
  if (categoryFilter) {
    var target = categoryFilter.toLowerCase();
    return KIT_CATEGORIES.indexOf(target) !== -1 && cat.indexOf(target) !== -1;
  }
  return KIT_CATEGORIES.some(function (kc) { return cat.indexOf(kc) !== -1; });
}

/**
 * Build the "Join the Waitlist" CTA node used by beer kit cards in place of
 * the wine cart controls (D-12 — beer is booked-ahead only, no cart path).
 * Deliberately does NOT carry the product-reserve-wrap class: that class is
 * walked by refreshAllReserveControls() (js/modules/11-cart.js) which expects
 * an _reserveRenderer, and this link has no cart state to refresh.
 *
 * @param {Document} [doc] - Optional document to build against (tests pass a jsdom document).
 * @returns {HTMLElement} A div.reserve-link wrapping a single a.btn anchor.
 */
function buildWaitlistCtaLink(doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  var wrap = d.createElement('div');
  wrap.className = 'reserve-link';

  var isBeerPage = false;
  if (d && d.body) {
    isBeerPage = d.body.getAttribute('data-page') === 'beer';
  }

  var link = d.createElement('a');
  link.className = 'btn';
  link.href = isBeerPage ? '#waitlist' : 'beer.html#waitlist';
  link.textContent = 'Join the Waitlist';

  wrap.appendChild(link);
  return wrap;
}

/**
 * Sort a filter row's unique values into their per-field domain order.
 * Pure function — no DOM, no closure state — so it can be shared by both
 * loadProducts()'s per-category call list and tested in isolation.
 *
 * @param {String} field - The product field the filter row is built from (e.g. 'subcategory', 'abv', 'time').
 * @param {Array} values - Unique values to sort (NOT mutated — a sorted copy is returned).
 * @param {String} [categoryFilter] - Active category ('wine' | 'beer' | ''), gates the wine-only subcategory order.
 * @returns {Array} A new, sorted array.
 */
function sortFilterValues(field, values, categoryFilter) {
  var out = (values || []).slice();

  if (field === 'time' || field === 'abv') {
    out.sort(function (a, b) {
      var numA = parseFloat(a) || 0;
      var numB = parseFloat(b) || 0;
      return numA - numB;
    });
  } else if (field === 'subcategory' && categoryFilter !== 'beer') {
    var styleOrder = ['red', 'white', 'rosé', 'rose', 'fruit', 'specialty'];
    out.sort(function (a, b) {
      var aIdx = styleOrder.indexOf(a.toLowerCase());
      var bIdx = styleOrder.indexOf(b.toLowerCase());
      if (aIdx === -1) aIdx = styleOrder.length;
      if (bIdx === -1) bIdx = styleOrder.length;
      return aIdx - bIdx;
    });
  } else if (field === 'body') {
    var bodyOrder = ['light', 'light-medium', 'medium', 'medium-full', 'full'];
    out.sort(function (a, b) {
      var aIdx = bodyOrder.indexOf(a.toLowerCase());
      var bIdx = bodyOrder.indexOf(b.toLowerCase());
      if (aIdx === -1) aIdx = bodyOrder.length;
      if (bIdx === -1) bIdx = bodyOrder.length;
      return aIdx - bIdx;
    });
  } else if (field === 'sweetness') {
    var sweetOrder = ['dry', 'off-dry', 'semi-sweet', 'sweet'];
    out.sort(function (a, b) {
      var aIdx = sweetOrder.indexOf(a.toLowerCase());
      var bIdx = sweetOrder.indexOf(b.toLowerCase());
      if (aIdx === -1) aIdx = sweetOrder.length;
      if (bIdx === -1) bIdx = sweetOrder.length;
      return aIdx - bIdx;
    });
  } else {
    out.sort();
  }

  return out;
}

/**
 * Compute the display string for a recipe's price slot (D-07).
 * Reads only `recipe.price` / `recipe.price_from` — the public payload never
 * carries any other pricing field (ingredients, locked_price, service_fee,
 * materials_fee, computed_price, pricing_mode are all server-stripped).
 *
 * @param {Object} recipe - Public recipe payload ({price, price_from}).
 * @returns {String} The exact string to render in the price slot.
 */
function recipeDisplayPrice(recipe) {
  var price = recipe && recipe.price;
  if (typeof price !== 'number' || !isFinite(price)) {
    return 'Price set when you book';
  }
  var formatted = formatCurrency(price);
  return recipe.price_from ? 'From ' + formatted : formatted;
}

/**
 * Build a public recipe card — the plain `.product-card` idiom (D-02), never
 * the `.label-wine`/`.label-beer` bottle-label idiom, so a recipe never reads
 * as a purchasable product. Built entirely with createElement/textContent —
 * never innerHTML — since recipe name/style/description are staff-authored
 * free text rendered on a public page (T-74-12).
 *
 * Reads ONLY recipe_id, name, style, description, price, price_from — the
 * public payload's field allowlist (D-07, T-74-14).
 *
 * @param {Object} recipe - Public recipe payload.
 * @param {Document} [doc] - Optional document to build against (tests pass a stub).
 * @returns {HTMLElement} div.product-card
 */
// Injects the first-party Steins & Vines mark. Isolated in its own helper so
// buildRecipeCard's body stays free of innerHTML — T-74-12's mitigation
// evidence is a grep for innerHTML inside that function, and the only value
// ever passed here is a module-level constant, never recipe data.
function appendSvLogo(d, parent) {
  if (typeof SV_LOGO_SVG === 'undefined') return;
  var logo = d.createElement('div');
  logo.className = 'sv-logo';
  logo.innerHTML = SV_LOGO_SVG;
  parent.appendChild(logo);
}

// Recipe cards use the same bottle-label idiom as kit cards (owner UAT
// 2026-09-01) so the two blocks read as one catalogue. The recipe IS the
// ferment-in-store product, so it carries the in-store price and the waitlist
// CTA, while beer kit cards carry a kit-only price and a buy control.
function buildRecipeCard(recipe, doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);

  var card = d.createElement('div');
  card.className = 'label-beer';
  card.setAttribute('data-recipe-id', recipe.recipe_id);

  var body = d.createElement('div');
  body.className = 'label-body';

  appendSvLogo(d, body);

  var goldRule = d.createElement('div');
  goldRule.className = 'gold-rule';
  body.appendChild(goldRule);

  var beerName = d.createElement('div');
  beerName.className = 'beer-name';
  beerName.textContent = recipe.name;
  body.appendChild(beerName);

  if (recipe.style) {
    var sub = d.createElement('div');
    sub.className = 'subcategory';
    sub.textContent = recipe.style;
    body.appendChild(sub);
  }

  if (recipe.description) {
    var desc = d.createElement('p');
    desc.className = 'service-description';
    desc.textContent = recipe.description;
    body.appendChild(desc);
  }

  var spacer = d.createElement('div');
  spacer.className = 'notes-spacer';
  body.appendChild(spacer);

  card.appendChild(body);

  var footer = d.createElement('div');
  footer.className = 'price-footer';
  var priceCol = d.createElement('div');
  priceCol.className = 'price-col';
  var priceLabel = d.createElement('div');
  priceLabel.className = 'price-label';
  priceLabel.textContent = 'Ferment in store';
  priceCol.appendChild(priceLabel);
  var priceValue = d.createElement('div');
  priceValue.className = 'price-value';
  priceValue.textContent = recipeDisplayPrice(recipe);
  priceCol.appendChild(priceValue);
  footer.appendChild(priceCol);
  card.appendChild(footer);

  card.appendChild(buildWaitlistCtaLink(d));

  return card;
}

/**
 * Fetch active recipes for the public recipe block (D-05). Always resolves,
 * never rejects, to either { ok: true, recipes: [...] } or { ok: false }.
 * Recipes carry no category field of any kind — this phase's RESEARCH
 * (Pitfall 2) confirms the Recipes sheet has no category column, so recipes
 * are routed to the beer page only by a fixed category check, never by
 * style-keyword inference. LOCKED DECISION: if a wine recipe is ever created
 * it will need an explicit category field on the record, not a heuristic
 * added here.
 *
 * @param {String} categoryFilter - the active page's category ('wine' | 'beer' | '').
 * @param {String} middlewareUrl - SHEETS_CONFIG.MIDDLEWARE_URL.
 * @returns {Promise<{ok: Boolean, recipes: Array}>}
 */
function fetchActiveRecipes(categoryFilter, middlewareUrl) {
  if (!categoryFilter) return Promise.resolve({ ok: true, recipes: [] });
  if (categoryFilter !== 'beer') return Promise.resolve({ ok: true, recipes: [] });

  return fetch((middlewareUrl || '') + '/api/recipes?status=active')
    .then(function (r) {
      if (!r.ok) throw new Error('Recipes fetch failed: ' + r.status);
      return r.json();
    })
    .then(function (data) {
      return { ok: true, recipes: data.recipes || [] };
    })
    .catch(function () {
      return { ok: false };
    });
}

/**
 * Paint the recipe block (D-01/D-02/D-04). No-ops cleanly when
 * #recipe-catalog is absent (every page without a recipe block). A
 * zero-item result renders nothing at all (D-04 — no heading, no wrapper,
 * no placeholder). A failed fetch shows an inline retry scoped to this
 * container only — it must never touch #product-catalog, so a recipe
 * failure never blanks a kit block that loaded successfully.
 *
 * @param {{ok: Boolean, recipes: Array}} result - fetchActiveRecipes()'s resolution.
 * @param {Boolean} showSubCopy - append the differentiating sub-copy line;
 *   passed in rather than re-queried so the caller (which already knows
 *   whether the kit block is also rendering) controls it (D-02).
 * @param {String} categoryFilter - forwarded to the retry click handler's re-fetch.
 * @param {String} middlewareUrl - forwarded to the retry click handler's re-fetch.
 * @param {Document} [doc] - Optional document to build against (tests pass a jsdom document).
 */
function renderRecipeBlock(result, showSubCopy, categoryFilter, middlewareUrl, doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  var recipeEl = d.getElementById('recipe-catalog');
  if (!recipeEl) return;

  recipeEl.innerHTML = '';

  if (!result.ok) {
    var errorDiv = d.createElement('div');
    errorDiv.className = 'catalog-error';
    var errorMsg = d.createElement('p');
    errorMsg.textContent = "Couldn't load recipes right now. Check your connection and try again.";
    var retryBtn = d.createElement('button');
    retryBtn.className = 'btn-retry btn-outline';
    retryBtn.type = 'button';
    retryBtn.textContent = 'Try again';
    retryBtn.addEventListener('click', function () {
      fetchActiveRecipes(categoryFilter, middlewareUrl).then(function (r) {
        renderRecipeBlock(r, showSubCopy, categoryFilter, middlewareUrl, d);
      });
    });
    errorDiv.appendChild(errorMsg);
    errorDiv.appendChild(retryBtn);
    recipeEl.appendChild(errorDiv);
    return;
  }

  if (!result.recipes || result.recipes.length === 0) return;

  var section = d.createElement('div');
  section.className = 'catalog-section';

  var sectionHeader = d.createElement('div');
  sectionHeader.className = 'catalog-section-header';

  var heading = d.createElement('h2');
  heading.className = 'catalog-section-title';
  heading.textContent = 'Beer Recipes';
  sectionHeader.appendChild(heading);

  if (showSubCopy) {
    var note = d.createElement('p');
    note.className = 'process-note';
    note.textContent = 'Book a session and brew your own batch in our studio.';
    sectionHeader.appendChild(note);
  }

  section.appendChild(sectionHeader);

  var grid = d.createElement('div');
  grid.className = 'product-grid' + (result.recipes.length <= 3 ? ' product-grid--compact' : '');
  result.recipes.forEach(function (recipe) {
    grid.appendChild(buildRecipeCard(recipe, d));
  });
  section.appendChild(grid);

  recipeEl.appendChild(section);
}

/**
 * Decide which of the two catalog blocks renders first on a category page
 * (D-03). A pure, explicit comparison — never an emergent property of array
 * order. LOCKED tie-break: kits lead on an exact count tie (at launch /beer
 * has 1 kit and 1 active recipe).
 *
 * @param {Number} kitCount - in-stock kit count.
 * @param {Number} recipeCount - active recipe count (0 on a failed fetch).
 * @returns {Array} ['kits','recipes'] or ['recipes','kits'].
 */
function orderCatalogBlocks(kitCount, recipeCount) {
  return kitCount >= recipeCount ? ['kits', 'recipes'] : ['recipes', 'kits'];
}

  // Lifted to module scope so the beer buy path is unit-testable; it uses no
// loadProducts closure state, only module-level helpers from 02/04/11.
function buildBeerCard(product, doc) {
  var d = doc || (typeof document !== 'undefined' ? document : null);
  var tint = getTintClass(product);
  var card = d.createElement('div');
  card.className = 'label-beer' + (tint ? ' ' + tint : '');
  if (product.sku) card.setAttribute('data-sku', product.sku);

  var discount = parseFloat(product.discount) || 0;
  if (discount > 0) {
    var badge = d.createElement('span');
    badge.className = 'discount-badge';
    badge.textContent = Math.round(discount) + '% OFF';
    card.appendChild(badge);
  }

  var body = d.createElement('div');
  body.className = 'label-body';

  var logo = d.createElement('div');
  logo.className = 'sv-logo';
  logo.innerHTML = SV_LOGO_SVG;
  body.appendChild(logo);

  if (product.manufacturer) {
    var producer = d.createElement('div');
    producer.className = 'producer';
    producer.textContent = product.manufacturer;
    body.appendChild(producer);
  }

  var brand = d.createElement('div');
  brand.className = 'brand';
  brand.textContent = product.brand || '';
  body.appendChild(brand);

  var goldRule = d.createElement('div');
  goldRule.className = 'gold-rule';
  body.appendChild(goldRule);

  var beerName = d.createElement('div');
  beerName.className = 'beer-name';
  beerName.textContent = product.name || '';
  body.appendChild(beerName);

  if (product.subcategory) {
    var sub = d.createElement('div');
    sub.className = 'subcategory';
    sub.textContent = product.subcategory;
    body.appendChild(sub);
  }

  var bBatchSize = (product['batch_size_(l)'] || product.batch_size_liters || '').trim();
  if (product.time || bBatchSize) {
    var timeRow = d.createElement('div');
    timeRow.className = 'time';
    var timeParts = [];
    if (product.time) timeParts.push(product.time);
    if (bBatchSize) timeParts.push(bBatchSize + 'L');
    timeRow.textContent = timeParts.join(' \u00b7 ');
    body.appendChild(timeRow);
  }

  if (product.abv) {
    var abv = d.createElement('div');
    abv.className = 'abv';
    abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
    body.appendChild(abv);
  }

  if (product.tasting_notes || product.sku) {
    body.appendChild(buildLabelNotesToggle(product));
  }

  var spacer = d.createElement('div');
  spacer.className = 'notes-spacer';
  body.appendChild(spacer);

  card.appendChild(body);

  if (product.sku) card.appendChild(buildProductLinkBtn(product.sku));

  var kit = (product.retail_kit || '').trim();
  if (kit) {
    card.appendChild(buildLabelPriceFooter(product, { kitOnly: true }));
  }

  // D-12 (revised 2026-09-01, owner UAT): beer kits ARE purchasable, but as a
  // take-home kit only. There is deliberately no Reserve/ferment-in-store
  // control here — that experience is booked through the recipe waitlist, so
  // only the kit-buy path is offered.
  var beerProductKey = getProductKey(product);
  var beerKitBuyWrap = d.createElement('div');
  beerKitBuyWrap.className = 'reserve-link product-reserve-wrap';
  beerKitBuyWrap._reserveProduct = product;
  beerKitBuyWrap._reserveKey = beerProductKey;
  beerKitBuyWrap._reserveRenderer = renderKitBuyControl;
  renderKitBuyControl(beerKitBuyWrap, product);
  card.appendChild(beerKitBuyWrap);

  return card;
}

function loadProducts(categoryFilter) {
  var _categoryFilter = (categoryFilter || '').toLowerCase();
  var allProducts = [];
  var _kitsFuse = null;
  var userHasSorted = false;
  var activeFilters = { type: [], brand: [], manufacturer: [], subcategory: [], time: [], body: [], oak: [], sweetness: [], abv: [] };
  var saleFilterActive = false;
  // D-02 kit sub-copy, set once the recipe/kit join (below) knows whether
  // both blocks are rendering on this page — read by renderCatalog/renderSection.
  var _kitSubCopy = null;

  var middlewareUrl = (typeof SHEETS_CONFIG !== 'undefined' && SHEETS_CONFIG.MIDDLEWARE_URL)
    ? SHEETS_CONFIG.MIDDLEWARE_URL : '';

  // D-05/D-01: start the recipe fetch alongside the kit fetch below (not
  // sequentially after it) so neither block waits on the other unnecessarily.
  // Resolves synchronously-empty for every unscoped/wine caller (D-01
  // Pitfall 2 — recipes have no category field, routed to beer only).
  var recipePromise = fetchActiveRecipes(_categoryFilter, middlewareUrl);

  // Fallback: load kit products from the committed Zoho snapshot file.
  // This replaces the old Google Sheets published CSV fallback.
  // The snapshot is generated by: npm run snapshot (calls export-snapshot.js).
  function loadFromSnapshot() {
    return fetch('/content/zoho-snapshot.json')
      .then(function (r) {
        if (!r.ok) throw new Error('Snapshot fetch failed: ' + r.status);
        return r.json();
      })
      .then(function (snap) {
        return (snap.products || []);
      });
  }

  var MW_CACHE_KEY = 'sv-products-mw';
  var MW_CACHE_TS_KEY = 'sv-products-mw-ts';
  var MW_CACHE_TTL = 30 * 60 * 1000;

  function getCachedMW() {
    try {
      var data = localStorage.getItem(MW_CACHE_KEY);
      var ts = parseInt(localStorage.getItem(MW_CACHE_TS_KEY), 10) || 0;
      if (data) return { data: JSON.parse(data), fresh: (Date.now() - ts) < MW_CACHE_TTL };
    } catch (e) {}
    return null;
  }

  function setCachedMW(items) {
    if (!items || !items.length) return; // don't cache empty results — fallback to snapshot instead
    try {
      localStorage.setItem(MW_CACHE_KEY, JSON.stringify(items));
      localStorage.setItem(MW_CACHE_TS_KEY, String(Date.now()));
    } catch (e) {}
  }

  function fetchFromMiddleware() {
    return fetch(middlewareUrl + '/api/products')
      .then(function (r) {
        if (!r.ok) throw new Error('Middleware returned ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var items = data.items || [];
        return items.map(function (z) {
          // Map middleware shaped response fields (handles both pre-shaped cache and raw Zoho)
          var obj = {
            name: z.name || '',
            sku: z.sku || '',
            brand: z.brand || '',
            stock: z.stock || (z.stock_on_hand != null ? String(z.stock_on_hand) : '0'), // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
            description: z.description || '',
            discount: z.discount != null ? String(z.discount) : '0', // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
            _zoho_category: z._zoho_category || z.category_name || '',
            zoho_item_id: z.item_id || '',
            tax_percentage: z.tax_percentage != null ? z.tax_percentage : 0, // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
            tax_name: z.tax_name || '',
            type: z.type || '',
            subcategory: z.subcategory || '',
            tasting_notes: z.tasting_notes || '',
            favorite: z.favorite || '',
            abv: z.abv || '',
            time: z.time || '',
            millable: z.millable || '',
            retail_kit: z.retail_kit || '',
            retail_instore: z.retail_instore || '',
            manufacturer: z.manufacturer || ''
          };
          // Flatten custom fields if present (raw Zoho response — overrides top-level fields)
          flattenCustomFields(obj, z.custom_fields);
          // Derive prices from rate only if not already set
          if (z.rate != null) { // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
            var rateNum = parseFloat(z.rate);
            if (!obj.retail_kit) {
              obj.retail_kit = '$' + rateNum.toFixed(2);
            }
            if (!obj.retail_instore) {
              obj.retail_instore = '$' + (rateNum + 50).toFixed(2);
            }
          }
          return obj;
        }).filter(function (obj) {
          // Exclude items with Type = Ingredient or Service
          var t = (obj.type || '').toLowerCase();
          if (t === 'ingredient' || t === 'service') return false;
          // Only keep kit categories (wine, beer, cider, seltzer), optionally
          // scoped to a single category via _categoryFilter.
          return matchesKitCategory(obj, _categoryFilter);
        });
      });
  }

  function loadFromMiddleware() {
    var cached = getCachedMW();

    if (cached && cached.data && cached.data.length > 0) {
      var promise = Promise.resolve(cached.data);
      if (!cached.fresh) {
        fetchFromMiddleware().then(setCachedMW).catch(function () {});
      }
      return promise;
    }

    return fetchFromMiddleware().then(function (items) {
      setCachedMW(items);
      return items;
    });
  }

  // Show skeleton loading on first load
  var catalog = document.getElementById('product-catalog');
  if (catalog) {
    showCatalogSkeletons(catalog, 6);
  }

  var recipeEl = document.getElementById('recipe-catalog');
  if (_categoryFilter && recipeEl) {
    showCatalogSkeletons(recipeEl, 2);
  }

  var _usedSnapshotFallback = false;
  var dataPromise = middlewareUrl
    ? loadFromMiddleware().catch(function () {
        _usedSnapshotFallback = true;
        return loadFromSnapshot();
      })
    : loadFromSnapshot();

  dataPromise
    .then(function (items) {
      // Filter out non-kit items that may have leaked from middleware
      items = items.filter(function (obj) {
        var t = (obj.type || '').toLowerCase();
        if (t === 'ingredient' || t === 'service') return false;
        return matchesKitCategory(obj, _categoryFilter);
      });
      items.forEach(function (obj) {
        obj._item_type = 'kit';
        if ((obj.favorite || '').toLowerCase() === 'true') {
          obj._favRand = Math.random();
        }
        allProducts.push(obj);
      });

      if (typeof Fuse !== 'undefined') {
        _kitsFuse = new Fuse(allProducts, {
          keys: ['name', 'brand', 'manufacturer', 'subcategory', 'tasting_notes'],
          threshold: 0.35,
          minMatchCharLength: 2,
          ignoreLocation: true
        });
      }

      if (_categoryFilter === 'beer') {
        // D-13: beer only builds Style + ABV — no Brand/Producer/Time/Body/Oak/Sweetness/Sale.
        buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
        buildFilterRow('filter-abv', 'abv', 'ABV:');
      } else {
        buildFilterRow('filter-type', 'type', 'Type:');
        buildFilterRow('filter-brand', 'brand', 'Brand:');
        buildFilterRow('filter-manufacturer', 'manufacturer', 'Producer:');
        buildFilterRow('filter-subcategory', 'subcategory', 'Style:');
        buildFilterRow('filter-time', 'time', 'Production Time:');
        buildFilterRow('filter-body', 'body', 'Body:');
        buildFilterRow('filter-oak', 'oak', 'Oak:');
        buildFilterRow('filter-sweetness', 'sweetness', 'Sweetness:');
        buildSaleFilter();
      }
      // D-03/D-10: commit both blocks in a single paint. Neither block paints
      // until both fetches settle, so the final order never reflows (recipes
      // may resolve before or after the kit data above — recipePromise was
      // started alongside the kit fetch, not after it).
      recipePromise.then(function (recipeResult) {
        var kitCount = allProducts.filter(function (r) { return getAvailable(r) > 0; }).length;
        // A failed recipe fetch is treated as recipeCount === 0 for both the
        // D-03 ordering rule and the D-02 sub-copy differentiation rule.
        var effectiveRecipeCount = recipeResult.ok ? recipeResult.recipes.length : 0;
        var bothBlocksRender = kitCount > 0 && effectiveRecipeCount > 0;

        var order = orderCatalogBlocks(kitCount, effectiveRecipeCount);
        var catalogBlocks = document.getElementById('catalog-blocks');
        var productEl = document.getElementById('product-catalog');
        var recipeCatalogEl = document.getElementById('recipe-catalog');
        if (catalogBlocks && productEl && recipeCatalogEl && order[0] === 'recipes') {
          catalogBlocks.insertBefore(recipeCatalogEl, productEl);
        }

        _kitSubCopy = bothBlocksRender ? 'Take a kit home to ferment yourself.' : null;
        renderRecipeBlock(recipeResult, bothBlocksRender, _categoryFilter, middlewareUrl);

        // Only render kits if the kits tab is still active (guards against the
        // ?tab=ingredients URL param switching away before this async chain resolves)
        if (_activeCartTab === 'kits') applyFilters();
      });


      // Refresh button — clears middleware cache and reloads products (only once)
      if (!document.querySelector('#catalog-controls-kits .catalog-refresh-btn')) {
        var refreshBtn = document.createElement('button');
        refreshBtn.className = 'catalog-refresh-btn';
        refreshBtn.type = 'button';
        refreshBtn.title = 'Refresh products';
        refreshBtn.setAttribute('aria-label', 'Refresh products');
        refreshBtn.innerHTML = '&#8635;';
        refreshBtn.addEventListener('click', function () {
          try {
            localStorage.removeItem(MW_CACHE_KEY);
            localStorage.removeItem(MW_CACHE_TS_KEY);
          } catch(e) {}
          loadProducts();
        });
        var kitsViewToggle = document.querySelector('#catalog-controls-kits .catalog-view-toggle');
        if (kitsViewToggle) { kitsViewToggle.parentNode.insertBefore(refreshBtn, kitsViewToggle.nextSibling); }
      }

      // Check for SKU parameter and scroll to product (from homepage featured)
      var urlParams = new URLSearchParams(window.location.search);
      var targetSku = urlParams.get('sku');
      if (targetSku) {
        var scrollAttempts = 0;
        function tryScrollToProduct() {
          var targetCard = document.querySelector('[data-sku="' + targetSku + '"]');
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.add('highlight');
            setTimeout(function () { targetCard.classList.remove('highlight'); }, 2000);
          } else if (scrollAttempts < 10) {
            scrollAttempts++;
            setTimeout(tryScrollToProduct, 100);
          } else {
            // SKU not found in current tab — try switching to ingredients
            var ingTab = document.querySelector('.product-tab-btn[data-product-tab="ingredients"]');
            if (ingTab && !ingTab.classList.contains('active')) {
              ingTab.click();
              var ingAttempts = 0;
              function tryScrollIngredient() {
                var card = document.querySelector('[data-sku="' + targetSku + '"]');
                if (card) {
                  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  card.classList.add('highlight');
                  setTimeout(function () { card.classList.remove('highlight'); }, 2000);
                } else if (ingAttempts < 10) {
                  ingAttempts++;
                  setTimeout(tryScrollIngredient, 100);
                }
              }
              setTimeout(tryScrollIngredient, 50);
            }
          }
        }
        setTimeout(tryScrollToProduct, 50);
      }

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
      // Both middleware and snapshot failed — show error state with retry
      var catalogEl = document.getElementById('product-catalog');
      if (catalogEl) {
        catalogEl.innerHTML = '';
        var errorDiv = document.createElement('div');
        errorDiv.className = 'catalog-error';
        var errorMsg = document.createElement('p');
        errorMsg.textContent = "Couldn't load products. Check your connection and try again.";
        var retryBtn = document.createElement('button');
        retryBtn.className = 'btn-retry btn-outline';
        retryBtn.type = 'button';
        retryBtn.textContent = 'Try again';
        retryBtn.addEventListener('click', function () {
          loadProducts();
        });
        errorDiv.appendChild(errorMsg);
        errorDiv.appendChild(retryBtn);
        catalogEl.appendChild(errorDiv);
      }
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

    uniqueValues = sortFilterValues(field, uniqueValues, _categoryFilter);

    if (uniqueValues.length === 0) {
      container.classList.add('hidden');
      return;
    }

    var allBtn = createFilterButton('All', containerId, field);
    allBtn.classList.add('active');
    container.appendChild(allBtn);

    uniqueValues.forEach(function (val) {
      var count = allProducts.filter(function (p) { return p[field] === val; }).length;
      container.appendChild(createFilterButton(val, containerId, field, count));
    });
  }

  function buildSaleFilter() {
    var hasSaleProducts = allProducts.some(function (p) {
      return parseFloat(p.discount) > 0;
    });
    var container = document.getElementById('filter-sale');
    if (!container || !hasSaleProducts) {
      if (container) container.classList.add('hidden');
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

  function createFilterButton(label, containerId, field, count) {
    var btn = document.createElement('button');
    btn.className = 'catalog-filter-btn';
    btn.type = 'button';
    btn.setAttribute('data-field', field);
    btn.setAttribute('data-value', label);
    var labelNode = document.createTextNode(label);
    btn.appendChild(labelNode);
    if (count !== undefined && label !== 'All') {
      var countBadge = document.createElement('span');
      countBadge.className = 'filter-btn-count';
      countBadge.textContent = String(count);
      btn.appendChild(countBadge);
    }
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
    var fields = ['type', 'brand', 'manufacturer', 'subcategory', 'time', 'body', 'oak', 'sweetness', 'abv'];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f === excludeField) continue;
      if (activeFilters[f].length > 0 && activeFilters[f].indexOf(product[f]) === -1) return false;
    }
    return true;
  }

  function updateFilterAvailability() {
    var fields = ['type', 'brand', 'manufacturer', 'subcategory', 'time', 'body', 'oak', 'sweetness', 'abv'];
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
    var query = searchInput ? searchInput.value.trim() : '';

    var _kitsFuseSet = null;
    if (query && _kitsFuse) {
      var fuseResults = _kitsFuse.search(query);
      _kitsFuseSet = new Set(fuseResults.map(function (r) { return r.item; }));
    }

    var filtered = allProducts.filter(function (r) {
      if (activeFilters.type.length > 0 && activeFilters.type.indexOf(r.type) === -1) return false;
      if (activeFilters.brand.length > 0 && activeFilters.brand.indexOf(r.brand) === -1) return false;
      if (activeFilters.manufacturer.length > 0 && activeFilters.manufacturer.indexOf(r.manufacturer) === -1) return false;
      if (activeFilters.subcategory.length > 0 && activeFilters.subcategory.indexOf(r.subcategory) === -1) return false;
      if (activeFilters.time.length > 0 && activeFilters.time.indexOf(r.time) === -1) return false;
      if (activeFilters.body.length > 0 && activeFilters.body.indexOf(r.body) === -1) return false;
      if (activeFilters.oak.length > 0 && activeFilters.oak.indexOf(r.oak) === -1) return false;
      if (activeFilters.sweetness.length > 0 && activeFilters.sweetness.indexOf(r.sweetness) === -1) return false;
      if (activeFilters.abv.length > 0 && activeFilters.abv.indexOf(r.abv) === -1) return false;
      if (saleFilterActive && !(parseFloat(r.discount) > 0)) return false;
      if (!query) return true;
      if (_kitsFuse) return _kitsFuseSet.has(r);
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
        case 'brand-asc':
          return (a.brand || '').localeCompare(b.brand || '');
        case 'brand-desc':
          return (b.brand || '').localeCompare(a.brand || '');
        case 'style-asc':
          return (a.subcategory || '').localeCompare(b.subcategory || '');
        case 'style-desc':
          return (b.subcategory || '').localeCompare(a.subcategory || '');
        case 'price-asc':
          return parsePrice(a) - parsePrice(b);
        case 'price-desc':
          return parsePrice(b) - parsePrice(a);
        case 'time-asc':
          return parseTimeValue(a.time) - parseTimeValue(b.time);
        case 'time-desc':
          return parseTimeValue(b.time) - parseTimeValue(a.time);
        case 'reserved-desc':
          return getReservedQty(getProductKey(b)) - getReservedQty(getProductKey(a));
        case 'reserved-asc':
          return getReservedQty(getProductKey(a)) - getReservedQty(getProductKey(b));
        default:
          return 0;
      }
    });

    renderCatalog(filtered);
    updateFilterSummary();
    var filterStatus = document.getElementById('filter-status');
    if (filterStatus) {
      filterStatus.textContent = ''; // clear first to ensure screen reader re-announcement
      filterStatus.textContent = 'Showing ' + filtered.length + ' product' + (filtered.length !== 1 ? 's' : '');
    }
  }

  var filterLabels = { type: 'Type', brand: 'Brand', subcategory: 'Style', time: 'Time', body: 'Body', oak: 'Oak', sweetness: 'Sweetness' };

  function updateFilterSummary() {
    var summary = document.getElementById('filter-summary');
    if (!summary) return;
    summary.innerHTML = '';
    var hasAny = false;
    var fields = Object.keys(activeFilters);
    fields.forEach(function (field) {
      activeFilters[field].forEach(function (val) {
        hasAny = true;
        var chip = document.createElement('button');
        chip.className = 'filter-chip';
        chip.type = 'button';
        var chipLabel = document.createTextNode((filterLabels[field] || field) + ': ' + val + ' ');
        var chipX = document.createElement('span');
        chipX.className = 'chip-x';
        chipX.textContent = '\u00d7';
        chip.appendChild(chipLabel);
        chip.appendChild(chipX);
        chip.addEventListener('click', function () {
          var idx = activeFilters[field].indexOf(val);
          if (idx !== -1) activeFilters[field].splice(idx, 1);
          // Sync the filter button UI
          var containerId = 'filter-' + field;
          var container = document.getElementById(containerId);
          if (container) {
            var buttons = container.querySelectorAll('.catalog-filter-btn');
            buttons.forEach(function (b) {
              if (b.getAttribute('data-value') === val) b.classList.remove('active');
              if (b.getAttribute('data-value') === 'All' && activeFilters[field].length === 0) b.classList.add('active');
            });
          }
          applyFilters();
          updateFilterAvailability();
        });
        summary.appendChild(chip);
      });
    });
    if (saleFilterActive) {
      hasAny = true;
      var saleChip = document.createElement('button');
      saleChip.className = 'filter-chip';
      saleChip.type = 'button';
      saleChip.innerHTML = 'On Sale <span class="chip-x">&times;</span>';
      saleChip.addEventListener('click', function () {
        saleFilterActive = false;
        var saleBtn = document.querySelector('#filter-sale .catalog-filter-btn');
        if (saleBtn) saleBtn.classList.remove('active');
        applyFilters();
      });
      summary.appendChild(saleChip);
    }
    if (hasAny) {
      var clearBtn = document.createElement('button');
      clearBtn.className = 'filter-chip filter-chip--clear';
      clearBtn.type = 'button';
      clearBtn.textContent = 'Clear all';
      clearBtn.addEventListener('click', function () {
        Object.keys(activeFilters).forEach(function (f) { activeFilters[f] = []; });
        saleFilterActive = false;
        // Reset all filter button UIs
        document.querySelectorAll('.catalog-filter-btn').forEach(function (b) {
          if (b.getAttribute('data-value') === 'All') {
            b.classList.add('active');
          } else {
            b.classList.remove('active');
          }
        });
        var saleBtn = document.querySelector('#filter-sale .catalog-filter-btn');
        if (saleBtn) saleBtn.classList.remove('active');
        applyFilters();
        updateFilterAvailability();
      });
      summary.appendChild(clearBtn);
    }
    summary.classList.toggle('hidden', !hasAny);
  }

  // Hoisted out of renderCatalog (was nested) so the dual-block ordering join
  // (D-03) can compute the in-stock kit count with the exact same rule before
  // renderCatalog itself runs.
  function getAvailable(r) {
    if (r.available !== undefined && r.available !== '') return parseInt(r.available, 10) || 0;
    return parseInt(r.stock, 10) || 0;
  }

  function renderCatalog(rows) {
    var catalog = document.getElementById('product-catalog');
    if (!catalog) return;

    // Remove existing sections, dividers, skeletons, and no-results message
    var sections = catalog.querySelectorAll('.catalog-section, .catalog-no-results, .catalog-divider, .catalog-skeleton-grid');
    sections.forEach(function (el) { el.parentNode.removeChild(el); });

    if (rows.length === 0) {
      var msg = document.createElement('p');
      msg.className = 'catalog-no-results';
      msg.textContent = 'No products found.';
      catalog.appendChild(msg);
      return;
    }

    // Out-of-stock products are hidden site-wide, including build-to-order kits
    // that would previously appear under an "Available to order" section.
    var inStock = rows.filter(function (r) { return getAvailable(r) > 0; });

    if (inStock.length === 0) {
      var noneMsg = document.createElement('p');
      noneMsg.className = 'catalog-no-results';
      noneMsg.textContent = 'No products found.';
      catalog.appendChild(noneMsg);
      return;
    }

    // D-02: category pages carry their own kit heading; every existing
    // unscoped caller (products.html, products/ingredients-supplies.html,
    // the hub) keeps the pre-existing default heading unchanged.
    var kitTitle = _categoryFilter === 'wine' ? 'Wine Kits'
      : (_categoryFilter === 'beer' ? 'Beer Kits' : 'Currently available');
    renderSection(catalog, kitTitle, inStock, undefined, _kitSubCopy);
    injectKitListSchema(inStock);
    equalizeCardHeights();
    setTimeout(handleDeepLinkedItem, 200);
  }

  function buildWineCard(product) {
    var tint = getTintClass(product);
    var card = document.createElement('div');
    card.className = 'label-wine' + (tint ? ' ' + tint : '');
    if (product.sku) card.setAttribute('data-sku', product.sku);

    var discount = parseFloat(product.discount) || 0;
    if (discount > 0) {
      var badge = document.createElement('span');
      badge.className = 'discount-badge';
      badge.textContent = Math.round(discount) + '% OFF';
      card.appendChild(badge);
    }

    var body = document.createElement('div');
    body.className = 'label-body';

    var brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = product.brand || '';

    if (product.manufacturer) {
      var producer = document.createElement('div');
      producer.className = 'producer';
      producer.textContent = product.manufacturer;
      body.appendChild(producer);
    }
    body.appendChild(brand);

    var ornament = document.createElement('div');
    ornament.className = 'ornament';
    body.appendChild(ornament);

    var wineName = document.createElement('div');
    wineName.className = 'wine-name';
    wineName.textContent = product.name || '';
    body.appendChild(wineName);

    if (product.subcategory) {
      var sub = document.createElement('div');
      sub.className = 'subcategory';
      sub.textContent = product.subcategory;
      body.appendChild(sub);
    }

    var wBatchSize = (product['batch_size_(l)'] || product.batch_size_liters || '').trim();
    if (product.time || wBatchSize) {
      var timeRow = document.createElement('div');
      timeRow.className = 'time';
      var timeParts = [];
      if (product.time) timeParts.push(product.time);
      if (wBatchSize) timeParts.push(wBatchSize + 'L');
      timeRow.textContent = timeParts.join(' \u00b7 ');
      body.appendChild(timeRow);
    }

    if (product.abv) {
      var abv = document.createElement('div');
      abv.className = 'abv';
      abv.textContent = product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : '');
      body.appendChild(abv);
    }

    if (product.tasting_notes || product.sku || product.body || product.oak || product.sweetness) {
      body.appendChild(buildLabelNotesToggle(product));
    }

    var spacer = document.createElement('div');
    spacer.className = 'notes-spacer';
    body.appendChild(spacer);

    card.appendChild(body);

    if (product.sku) card.appendChild(buildProductLinkBtn(product.sku));

    var instore = (product.retail_instore || '').trim();
    var kit = (product.retail_kit || '').trim();
    if (instore || kit) {
      card.appendChild(buildLabelPriceFooter(product));
    }

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'reserve-link product-reserve-wrap';
    var productKey = getProductKey(product);
    reserveWrap._reserveProduct = product;
    reserveWrap._reserveKey = productKey;
    reserveWrap._reserveRenderer = renderReserveControl;
    renderReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    var kitBuyWrap = document.createElement('div');
    kitBuyWrap.className = 'reserve-link reserve-link--secondary product-reserve-wrap';
    kitBuyWrap._reserveProduct = product;
    kitBuyWrap._reserveKey = productKey;
    kitBuyWrap._reserveRenderer = renderKitBuyControl;
    renderKitBuyControl(kitBuyWrap, product);
    card.appendChild(kitBuyWrap);

    return card;
  }


  function buildDefaultCard(product) {
    var card = document.createElement('div');
    card.className = 'product-card';
    if (product.sku) {
      card.setAttribute('data-sku', product.sku);
    }

    var header = document.createElement('div');
    header.className = 'product-card-header';

    var cardBrand = document.createElement('p');
    cardBrand.className = 'product-brand';
    cardBrand.textContent = product.brand;

    if (product.manufacturer) {
      var cardProducer = document.createElement('p');
      cardProducer.className = 'product-producer';
      cardProducer.textContent = product.manufacturer;
      header.appendChild(cardProducer);
    }
    header.appendChild(cardBrand);

    var cardName = document.createElement('h4');
    cardName.textContent = product.name;
    header.appendChild(cardName);

    card.appendChild(header);

    var batchSize = (product['batch_size_(l)'] || product.batch_size_liters || '').trim();
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
        setResponsiveImg(img, product.sku);
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
          var instoreSale = formatCurrency(instoreNum * (1 - discount / 100));
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-original">' + formatCurrency(instore) + '</span><span class="product-price-value">' + instoreSale + plusSign + '</span>';
        } else {
          instoreBox.innerHTML = '<span class="product-price-label">Ferment in store</span><span class="product-price-value">' + formatCurrency(instore) + plusSign + '</span>';
        }
        priceRow.appendChild(instoreBox);
      }
      if (kit) {
        var kitBox = document.createElement('div');
        kitBox.className = 'product-price-box';
        if (discount > 0) {
          var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
          var kitSale = formatCurrency(kitNum * (1 - discount / 100));
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-original">' + formatCurrency(kit) + '</span><span class="product-price-value">' + kitSale + plusSign + '</span>';
        } else {
          kitBox.innerHTML = '<span class="product-price-label">Kit only</span><span class="product-price-value">' + formatCurrency(kit) + plusSign + '</span>';
        }
        priceRow.appendChild(kitBox);
      }
      card.appendChild(priceRow);
    }

    if (product.sku) card.appendChild(buildProductLinkBtn(product.sku));

    var reserveWrap = document.createElement('div');
    reserveWrap.className = 'product-reserve-wrap';
    var productKey = getProductKey(product);
    // Standard properties for refreshAllReserveControls sync
    reserveWrap._reserveProduct = product;
    reserveWrap._reserveKey = productKey;
    reserveWrap._reserveRenderer = renderReserveControl;
    renderReserveControl(reserveWrap, product, productKey);
    card.appendChild(reserveWrap);

    var kitBuyWrapDefault = document.createElement('div');
    kitBuyWrapDefault.className = 'product-reserve-wrap product-reserve-wrap--secondary';
    // Use renderKitBuyControl as the renderer for this specific wrap
    kitBuyWrapDefault._reserveProduct = product;
    kitBuyWrapDefault._reserveKey = productKey;
    kitBuyWrapDefault._reserveRenderer = renderKitBuyControl;
    renderKitBuyControl(kitBuyWrapDefault, product);
    card.appendChild(kitBuyWrapDefault);

    return card;
  }

  function renderSection(catalog, title, items, extraClass, subCopy) {
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
    } else if (subCopy) {
      // D-02 block-differentiation sub-copy — only passed when the sibling
      // recipe block is also rendering on this page (see loadProducts's
      // recipePromise join); with a single block on the page there's
      // nothing to differentiate.
      var subCopyNote = document.createElement('p');
      subCopyNote.className = 'process-note';
      subCopyNote.textContent = subCopy;
      sectionHeader.appendChild(subCopyNote);
    }

    wrapper.appendChild(sectionHeader);

    // Group by type, ordered by number of products (largest first)
    var groups = {};
    var groupOrder = [];
    items.forEach(function (r) {
      if (!groups[r.type]) {
        groups[r.type] = [];
        groupOrder.push(r.type);
      }
      groups[r.type].push(r);
    });
    groupOrder.sort(function (a, b) { return groups[b].length - groups[a].length; });

    // With a category filter active there is exactly one group, so an inner
    // "Wine"/"Beer" .product-group-title heading would immediately repeat
    // the block heading above it ("Wine Kits" -> "Wine"). Suppress it in
    // that case only; unscoped multi-group pages (hub/products) keep it.
    var suppressGroupHeading = !!(_categoryFilter && groupOrder.length === 1);

    if (catalogViewMode === 'table') {
      groupOrder.forEach(function (type) {
        var group = document.createElement('div');
        group.className = 'product-group';

        var heading = document.createElement('h3');
        heading.className = 'product-group-title';
        heading.textContent = type;
        if (!suppressGroupHeading) group.appendChild(heading);

        var table = document.createElement('table');
        table.className = 'catalog-table';
        var thead = document.createElement('thead');
        var sortSelect = document.getElementById('catalog-sort');
        var currentSort = sortSelect ? sortSelect.value : 'name-asc';
        var typeItems = groups[type];
        var kitsCols = [
          { label: 'Name', sort: 'name', field: 'name' },
          { label: 'Brand', sort: 'brand', field: 'brand' },
          { label: 'Style', sort: 'style', field: 'subcategory' },
          { label: 'Time', sort: 'time', field: 'time' },
          { label: 'In-Store Price', sort: 'price', field: 'retail_instore' },
          { label: 'Kit Price', sort: 'price', field: 'retail_kit' },
          { label: '', sort: null, field: null },
          { label: '', sort: null, field: null }
        ];
        // Determine which columns have data in this group
        var visibleCols = kitsCols.filter(function (col) {
          if (!col.field) return true; // always show (Name, Reserve)
          if (col.field === 'name') return true; // always show Name
          return typeItems.some(function (p) { return (p[col.field] || '').trim() !== ''; });
        });
        var visibleFields = {};
        visibleCols.forEach(function (col) { visibleFields[col.field || col.label] = true; });

        var theadTr = document.createElement('tr');
        visibleCols.forEach(function (col) {
          var th = document.createElement('th');
          th.textContent = col.label;
          if (col.field === 'retail_instore' || col.field === 'retail_kit') th.style.textAlign = 'right';
          if (col.sort) {
            th.setAttribute('data-sort', col.sort);
            var arrow = document.createElement('span');
            arrow.className = 'sort-arrow';
            var sortBase = currentSort.replace(/-asc$|-desc$/, '');
            if (sortBase === col.sort) {
              th.classList.add('sort-active');
              arrow.textContent = currentSort.indexOf('-desc') !== -1 ? '\u25BC' : '\u25B2';
            } else {
              arrow.textContent = '\u25B2';
            }
            th.appendChild(arrow);
            th.addEventListener('click', (function (sortKey) {
              return function () {
                var sel = document.getElementById('catalog-sort');
                if (!sel) return;
                var cur = sel.value;
                var base = cur.replace(/-asc$|-desc$/, '');
                if (base === sortKey) {
                  sel.value = sortKey + (cur.indexOf('-asc') !== -1 ? '-desc' : '-asc');
                } else {
                  sel.value = sortKey + '-asc';
                }
                userHasSorted = true;
                applyFilters();
              };
            })(col.sort));
          }
          theadTr.appendChild(th);
        });
        thead.appendChild(theadTr);
        table.appendChild(thead);

        var tbody = document.createElement('tbody');
        typeItems.forEach(function (product) {
          var tr = document.createElement('tr');
          var tint = getTintClass(product);
          if (tint) tr.className = tint;
          var discount = parseFloat(product.discount) || 0;
          var pricingFrom = (product.pricing_from || '').trim().toUpperCase() === 'TRUE';
          var plusSign = pricingFrom ? '+' : '';

          // Name + badge
          var tdName = document.createElement('td');
          tdName.setAttribute('data-label', 'Name');
          var nameSpan = document.createElement('span');
          nameSpan.className = 'table-name';
          nameSpan.textContent = product.name || '';
          tdName.appendChild(nameSpan);
          if (discount > 0) {
            var badge = document.createElement('span');
            badge.className = 'discount-badge-sm';
            badge.textContent = Math.round(discount) + '% OFF';
            tdName.appendChild(badge);
          }
          tr.appendChild(tdName);

          // Brand
          if (visibleFields['brand']) {
            var tdBrand = document.createElement('td');
            tdBrand.setAttribute('data-label', 'Brand');
            tdBrand.textContent = product.brand || '';
            tr.appendChild(tdBrand);
          }

          // Style (subcategory)
          if (visibleFields['subcategory']) {
            var tdStyle = document.createElement('td');
            tdStyle.setAttribute('data-label', 'Style');
            tdStyle.textContent = product.subcategory || '';
            tr.appendChild(tdStyle);
          }

          // Time
          if (visibleFields['time']) {
            var tdTime = document.createElement('td');
            tdTime.setAttribute('data-label', 'Time');
            tdTime.textContent = product.time || '';
            tr.appendChild(tdTime);
          }

          // In-Store price
          if (visibleFields['retail_instore']) {
            var tdInstore = document.createElement('td');
            tdInstore.setAttribute('data-label', 'In-Store');
            var instore = (product.retail_instore || '').trim();
            if (instore) {
              tdInstore.className = 'table-prices';
              if (discount > 0) {
                var instoreNum = parseFloat(instore.replace(/[^0-9.]/g, ''));
                var instoreSale = formatCurrency(instoreNum * (1 - discount / 100));
                tdInstore.innerHTML = '<span class="table-price-original">' + formatCurrency(instore) + '</span><span class="table-price-sale">' + instoreSale + plusSign + '</span>';
              } else {
                tdInstore.textContent = formatCurrency(instore) + plusSign;
              }
            }
            tr.appendChild(tdInstore);
          }

          // Kit price
          if (visibleFields['retail_kit']) {
            var tdKit = document.createElement('td');
            tdKit.setAttribute('data-label', 'Kit');
            var kit = (product.retail_kit || '').trim();
            if (kit) {
              tdKit.className = 'table-prices';
              if (discount > 0) {
                var kitNum = parseFloat(kit.replace(/[^0-9.]/g, ''));
                var kitSale = formatCurrency(kitNum * (1 - discount / 100));
                tdKit.innerHTML = '<span class="table-price-original">' + formatCurrency(kit) + '</span><span class="table-price-sale">' + kitSale + plusSign + '</span>';
              } else {
                tdKit.textContent = formatCurrency(kit) + plusSign;
              }
            }
            tr.appendChild(tdKit);
          }

          // Add to Cart (Reserve — ferment in store)
          var tdReserve = document.createElement('td');
          tdReserve.setAttribute('data-label', '');
          var productKey = getProductKey(product);
          renderReserveControl(tdReserve, product, productKey);
          tr.appendChild(tdReserve);

          // Buy Kit — take home
          var tdBuyKit = document.createElement('td');
          tdBuyKit.setAttribute('data-label', '');
          renderKitBuyControl(tdBuyKit, product);
          tr.appendChild(tdBuyKit);

          injectProductSchema(product, 'kit');

          // Mobile summary cells (hidden on desktop, shown on mobile via CSS)
          var metaParts = [];
          if (visibleFields['brand'] && (product.brand || '').trim()) metaParts.push(product.brand.trim());
          if (visibleFields['subcategory'] && (product.subcategory || '').trim()) metaParts.push(product.subcategory.trim());
          if (visibleFields['time'] && (product.time || '').trim()) metaParts.push(product.time.trim());
          var tdMobileMeta = document.createElement('td');
          tdMobileMeta.className = 'table-mobile-meta';
          if (metaParts.length) tdMobileMeta.textContent = metaParts.join(' \u00B7 ');
          tr.appendChild(tdMobileMeta);

          var priceHtmlParts = [];
          var mInstore = (product.retail_instore || '').trim();
          var mKit = (product.retail_kit || '').trim();
          if (mInstore) {
            var mInstoreNum = parseFloat(mInstore.replace(/[^0-9.]/g, ''));
            if (discount > 0 && mInstoreNum) {
              var mInstoreSale = formatCurrency(mInstoreNum * (1 - discount / 100));
              priceHtmlParts.push('<span class="mp-label">In-store</span> <span class="table-price-original">' + formatCurrency(mInstore) + '</span> <span class="table-price-sale">' + mInstoreSale + plusSign + '</span>');
            } else {
              priceHtmlParts.push('<span class="mp-label">In-store</span> ' + formatCurrency(mInstore) + plusSign);
            }
          }
          if (mKit) {
            var mKitNum = parseFloat(mKit.replace(/[^0-9.]/g, ''));
            if (discount > 0 && mKitNum) {
              var mKitSale = formatCurrency(mKitNum * (1 - discount / 100));
              priceHtmlParts.push('<span class="mp-label">Kit</span> <span class="table-price-original">' + formatCurrency(mKit) + '</span> <span class="table-price-sale">' + mKitSale + plusSign + '</span>');
            } else {
              priceHtmlParts.push('<span class="mp-label">Kit</span> ' + formatCurrency(mKit) + plusSign);
            }
          }
          var tdMobilePrices = document.createElement('td');
          tdMobilePrices.className = 'table-mobile-prices';
          if (priceHtmlParts.length) tdMobilePrices.innerHTML = priceHtmlParts.join(' <span class="mp-sep">\u00B7</span> ');
          tr.appendChild(tdMobilePrices);

          // Add expand chevron to name cell
          var chevron = document.createElement('span');
          chevron.className = 'table-expand-chevron';
          chevron.innerHTML = '&#9660;';
          tdName.insertBefore(chevron, tdName.firstChild);

          // Build detail row
          var detailTr = document.createElement('tr');
          detailTr.className = 'table-detail-row';
          var detailTd = document.createElement('td');
          detailTd.setAttribute('colspan', String(visibleCols.length + 2));
          detailTd.className = 'table-detail-cell';

          var detailContent = document.createElement('div');
          detailContent.className = 'table-detail-content';

          if (product.sku) {
            var detailImg = document.createElement('div');
            detailImg.className = 'table-detail-image';
            var img = document.createElement('img');
            setResponsiveImg(img, product.sku);
            img.alt = product.name || 'Product image';
            img.loading = 'lazy';
            img.onerror = function() { this.parentElement.remove(); };
            detailImg.appendChild(img);
            detailContent.appendChild(detailImg);
          }

          var detailText = document.createElement('div');
          detailText.className = 'table-detail-text';

          if (product.tasting_notes) {
            var notesP = document.createElement('p');
            notesP.className = 'table-detail-notes';
            notesP.textContent = product.tasting_notes;
            detailText.appendChild(notesP);
          }

          if (product.description && !product.tasting_notes) {
            var descP = document.createElement('p');
            descP.className = 'table-detail-notes';
            descP.textContent = product.description;
            detailText.appendChild(descP);
          }

          var detailTraitBody = (product.body || '').trim();
          var detailTraitOak = (product.oak || '').trim();
          var detailTraitSweet = (product.sweetness || '').trim();
          if (detailTraitBody || detailTraitOak || detailTraitSweet) {
            var traitParts = [];
            if (detailTraitBody) traitParts.push('<strong>Body:</strong> ' + escapeHTML(detailTraitBody));
            if (detailTraitOak) traitParts.push('<strong>Oak:</strong> ' + escapeHTML(detailTraitOak));
            if (detailTraitSweet) traitParts.push('<strong>Sweetness:</strong> ' + escapeHTML(detailTraitSweet));
            var traitsP = document.createElement('p');
            traitsP.className = 'table-detail-traits';
            traitsP.innerHTML = traitParts.join(' \u00B7 ');
            detailText.appendChild(traitsP);
          }

          var detailMeta = [];
          if (product.abv) detailMeta.push(product.abv + (product.abv.toLowerCase().indexOf('abv') === -1 ? ' ABV' : ''));
          var detailBatch = (product['batch_size_(l)'] || product.batch_size_liters || '').trim();
          if (detailBatch) detailMeta.push(detailBatch + 'L batch');
          if (detailMeta.length) {
            var metaP = document.createElement('p');
            metaP.className = 'table-detail-meta';
            metaP.textContent = detailMeta.join(' \u00B7 ');
            detailText.appendChild(metaP);
          }

          detailContent.appendChild(detailText);
          detailTd.appendChild(detailContent);
          detailTr.appendChild(detailTd);

          // Only add detail row if there's content
          if (detailContent.children.length > 0 && detailText.children.length > 0) {
            tbody.appendChild(tr);
            tbody.appendChild(detailTr);

            // Click to toggle
            (function(mainRow, detail, chev) {
              var skipClick = false;
              mainRow.addEventListener('mousedown', function(e) {
                if (e.target.closest('.product-reserve-wrap')) skipClick = true;
              });
              mainRow.style.cursor = 'pointer';
              mainRow.addEventListener('click', function(e) {
                if (skipClick) { skipClick = false; return; }
                if (e.target.closest('.product-reserve-wrap')) return;
                var isOpen = detail.classList.toggle('open');
                chev.classList.toggle('open', isOpen);
                mainRow.classList.toggle('expanded', isOpen);
                if (isOpen) {
                  trackEvent('detail', product.sku || '', product.name || '');
                }
              });
            })(tr, detailTr, chevron);
          } else {
            tbody.appendChild(tr);
          }
        });
        table.appendChild(tbody);
        group.appendChild(table);
        wrapper.appendChild(group);
      });
    } else {
      groupOrder.forEach(function (type) {
        var group = document.createElement('div');
        group.className = 'product-group';

        var heading = document.createElement('h3');
        heading.className = 'product-group-title';
        heading.textContent = type;
        if (!suppressGroupHeading) group.appendChild(heading);

        var grid = document.createElement('div');
        // UI-SPEC §2: caps a 1-3 card grid at 320px columns so a single
        // stretched card doesn't blow up to full container width.
        grid.className = 'product-grid' + (groups[type].length <= 3 ? ' product-grid--compact' : '');

        groups[type].forEach(function (product) {
          var productType = (product.type || '').toLowerCase();
          var card;
          if (productType.indexOf('wine') !== -1) {
            card = buildWineCard(product);
          } else if (productType.indexOf('beer') !== -1) {
            card = buildBeerCard(product);
          } else {
            card = buildDefaultCard(product);
          }
          grid.appendChild(card);
          injectProductSchema(product, 'kit');
        });

        group.appendChild(grid);
        wrapper.appendChild(group);
      });
    }

    catalog.appendChild(wrapper);
  }
}

// Renders a secondary "Buy Kit" button for kit products.
// Adds the kit to the ingredient cart (sv-cart-ingredients) with _item_type='kit-purchase'
// so it does NOT trigger the ferment-in-store reservation flow at checkout.
function renderKitBuyControl(wrap, product) {
  // Register for refreshAllReserveControls() so cart clears/removes update this button
  wrap._reserveProduct = product;
  wrap._reserveKey = getProductKey(product);
  wrap._reserveRenderer = renderKitBuyControl;

  wrap.innerHTML = '';
  // Build a kit-purchase product object: same fields but different type and price
  var kitProduct = {};
  for (var k in product) {
    if (Object.prototype.hasOwnProperty.call(product, k)) {
      kitProduct[k] = product[k];
    }
  }
  kitProduct._item_type = 'kit-purchase';
  // Use kit-only price for take-home purchases
  kitProduct.price = product.retail_kit || product.retail_instore || product.price || '';

  // Scope qty lookup to ingredient cart to avoid cross-contamination with Reserve (ferment) qty
  var productKey = getProductKey(product);
  var existingQty = getReservedQty(productKey, INGREDIENT_CART_KEY);

  if (existingQty === 0) {
    var buyBtn = document.createElement('button');
    buyBtn.type = 'button';
    buyBtn.className = 'product-reserve-btn product-reserve-btn--secondary';
    buyBtn.textContent = 'Buy Kit';
    buyBtn.addEventListener('click', function () {
      setReservationQty(kitProduct, 1);
      trackEvent('add_to_cart', product.sku || '', product.name + ' (kit)');
      ga4AddToCart(kitProduct, 1);
      renderKitBuyControl(wrap, product);
    });
    wrap.appendChild(buyBtn);
  } else {
    var controls = document.createElement('div');
    controls.className = 'product-qty-controls';

    var minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'qty-btn';
    minusBtn.textContent = '\u2212';
    minusBtn.setAttribute('aria-label', 'Decrease take-home kit quantity');
    minusBtn.addEventListener('click', function () {
      setReservationQty(kitProduct, existingQty - 1);
      renderKitBuyControl(wrap, product);
    });

    var qtySpan = document.createElement('span');
    qtySpan.className = 'qty-value';
    qtySpan.textContent = String(existingQty);

    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'qty-btn';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', 'Increase take-home kit quantity');
    plusBtn.addEventListener('click', function () {
      setReservationQty(kitProduct, existingQty + 1);
      renderKitBuyControl(wrap, product);
    });

    controls.appendChild(minusBtn);
    controls.appendChild(qtySpan);
    controls.appendChild(plusBtn);
    wrap.appendChild(controls);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { appendSvLogo: appendSvLogo, buildBeerCard: buildBeerCard, flattenCustomFields: flattenCustomFields, matchesKitCategory: matchesKitCategory, buildWaitlistCtaLink: buildWaitlistCtaLink, sortFilterValues: sortFilterValues, recipeDisplayPrice: recipeDisplayPrice, buildRecipeCard: buildRecipeCard, fetchActiveRecipes: fetchActiveRecipes, renderRecipeBlock: renderRecipeBlock, orderCatalogBlocks: orderCatalogBlocks };
}

// ===== Steins & Vines Kiosk Core (shared cart/payment/void logic) =====
// Extracted, environment-agnostic core shared by the standalone kiosk
// (js/kiosk.js) and the admin-embedded kiosk tab (js/admin.js). Phase 48
// de-fork: this file is the single source of truth for kiosk cart/payment/
// void logic (D-01).  Attaches window.KioskCore in the browser and
// module.exports under Node/Jest.
//
// 48-02 populates the non-payment surface: cart building, catalog/recipe
// rendering, totals (incl. the discount branch), and the full product-type
// discount subsystem (D-04, D-06 naming — public names drop the "kiosk"
// prefix). Payment/checkout/dual-cart migration is 48-03; admin consumption
// is 48-04.
//
// Environment-injection seam (D-02): the two real environment differences
// between the standalone kiosk and the admin-embedded kiosk tab are (1) the
// auth mechanism used on outgoing fetch calls and (2) a handful of pieces of
// cart/sale state (and the payment-path functions that own them) that are
// NOT part of this plan's migration scope — js/kiosk.js's kioskProceedToPayment
// / kioskShowReceipt / kioskCheckTerminal / kioskSetTerminalStatus / the
// custom-item + gift-card-issue modals / the imported-SO tracking vars are
// explicitly deferred to 48-03 (payment path) and are intentionally left
// UNTOUCHED in js/kiosk.js this plan. Because those not-yet-migrated
// functions read/write cart, discount, gift-card, customer, recipe-context,
// modified-ingredients and imported-SO state directly, that specific state
// cannot be physically relocated into this closure without editing the
// deferred payment path — so KioskCore.init(env) accepts get/set callbacks
// for exactly that subset (bridging, not owning, until 48-03 completes the
// migration and these become plain internal vars here too). All OTHER
// module-scope kiosk state (recipe browse, product filters/view mode,
// quote, availability, ingredient-modify-panel, discount presets, ...) is
// NOT touched by the deferred functions and is physically relocated into
// this closure's private state below, exposed via KioskCore accessors only
// where js/kiosk.js's remaining (non-deferred) code still needs them.

(function () {
  'use strict';

  // ===== Environment injection seam (D-02/D-06) =====
  // WR-01 (Phase 48 review): the middleware URL is resolved LAZILY on every read
  // via _mwUrlResolver, not captured once at init. This preserves the pre-phase
  // behaviour where kioskMwUrl() was re-evaluated per call, so the core recovers
  // if SHEETS_CONFIG.MIDDLEWARE_URL becomes available after init (async/late config
  // injection or script-order change) instead of permanently caching an empty string.
  var _mwUrlResolver = function () { return ''; };
  var _kcEnv = {
    get mwUrl() { return _mwUrlResolver(); },
    buildAuthOptions: function () {
      return {};
    },
    // ---- State bridged from the consumer (owned there until 48-03) ----
    getCart: function () { return {}; },
    setCart: function () {},
    getDiscount: function () { return null; },
    setDiscount: function () {},
    getGiftCard: function () { return null; },
    setGiftCard: function () {},
    getCustomer: function () { return null; },
    setCustomer: function () {},
    getRecipeContext: function () { return null; },
    setRecipeContext: function () {},
    getModifiedIngredients: function () { return null; },
    setModifiedIngredients: function () {},
    // ---- Behavior hooks bridging to not-yet-migrated code (custom-item /
    // gift-card-issue modals stay in the consumer per PATTERNS.md) ----
    showCustomItemModal: function () {},
    showGiftCardIssueModal: function () {}
  };

  function kcInit(env) {
    if (!env) {
      return;
    }
    // Accept either a resolver FUNCTION (preferred — lazy per-call, WR-01) or a
    // plain value (wrapped so any string-passing caller keeps eager semantics).
    if (typeof env.mwUrl === 'function') {
      _mwUrlResolver = env.mwUrl;
    } else if (typeof env.mwUrl !== 'undefined') {
      _mwUrlResolver = (function (v) { return function () { return v; }; }(env.mwUrl));
    }
    if (typeof env.buildAuthOptions === 'function') {
      _kcEnv.buildAuthOptions = env.buildAuthOptions;
    }
    var bridgedFns = [
      'getCart', 'setCart', 'getDiscount', 'setDiscount', 'getGiftCard', 'setGiftCard',
      'getCustomer', 'setCustomer', 'getRecipeContext', 'setRecipeContext',
      'getModifiedIngredients', 'setModifiedIngredients',
      'showCustomItemModal', 'showGiftCardIssueModal'
    ];
    bridgedFns.forEach(function (name) {
      if (typeof env[name] === 'function') {
        _kcEnv[name] = env[name];
      }
    });
    // 70-02 (KIOSK-MOTO): bind the HelcimPay postMessage listener once so the
    // phone-order tender can receive the iframe's SUCCESS/ABORTED result.
    _kcBindHelcimListener();
  }

  // Shallow-merges the injected auth options (headers / credentials) into a
  // fetch options object. This is the ONE real environment difference
  // (x-device-token header on the standalone kiosk vs. credentials:'include'
  // on the admin-embedded kiosk) — every outgoing fetch in this file routes
  // through it (PATTERNS.md auth-seam pattern).
  function _kcMergeAuth(opts) {
    opts = opts || {};
    var auth = _kcEnv.buildAuthOptions() || {};
    if (auth.headers) {
      opts.headers = opts.headers || {};
      for (var k in auth.headers) {
        if (Object.prototype.hasOwnProperty.call(auth.headers, k)) {
          opts.headers[k] = auth.headers[k];
        }
      }
    }
    if (typeof auth.credentials !== 'undefined') {
      opts.credentials = auth.credentials;
    }
    return opts;
  }

  // 57-01: client-error beacon. When a kiosk fetch fails, report the real error to
  // the middleware BEFORE kioskRenderLoadError clears the grid, so the exact error
  // (text/status/endpoint/auth-state) is captured to Sentry instead of vanishing
  // when staff tap Retry. The body carries ONLY the six whitelisted fields — never
  // the device-token value (it rides the auth header via _kcMergeAuth, and
  // auth_state below is a LABEL, not the token) and never card/customer data.
  // Fire-and-forget: a beacon failure can never throw into the caller and never
  // re-beacons (the POST's own .catch is a no-op and is not itself instrumented).
  function _kcReportClientError(info) {
    info = info || {};
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) return;
    var authOpts = _kcEnv.buildAuthOptions() || {};
    var authState = 'none';
    if (authOpts.headers && authOpts.headers['x-device-token']) {
      authState = 'device-token';
    } else if (authOpts.credentials === 'include') {
      authState = 'session-cookie';
    }
    var payload = {
      message: String(info.message == null ? '' : info.message).slice(0, 500), // eslint-disable-line eqeqeq -- intentional == null matches undefined too
      http_status: (typeof info.http_status === 'number' ? info.http_status : null),
      endpoint: info.endpoint || '',
      auth_state: authState,
      timestamp: new Date().toISOString(),
      user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : ''
    };
    // 57-03 (57-DIAGNOSIS.md beacon finding #2, client half): item_id is an
    // OPTIONAL structured field, only added when a caller passes one — never
    // added as an explicit `undefined` key, which would change the whitelisted
    // key set for every OTHER call site (kiosk-client-error-beacon.test.js Test
    // 5 pins the six-key shape for the network-reject paths). A Zoho item id
    // is not PII; length-capped defensively.
    if (info.item_id) {
      payload.item_id = String(info.item_id).slice(0, 40);
    }
    try {
      fetch(mwUrl + '/api/kiosk/client-error', _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })).catch(function () {});
    } catch (e) { /* never let telemetry break the kiosk */ }
  }

  // 68-01: terminal-push latency beacon. Measures real wall-time from the
  // moment the terminal prompt is shown (_kioskPushToTerminal) to the
  // sale-push 202 response, POSTs it to /api/kiosk/telemetry which emits
  // it server-side as kiosk.terminal_push_latency, so the reported "reader
  // isn't picking up" symptom can be correlated with the server's own
  // kiosk.sale_stage_timing events instead of guessed. A NEW sibling
  // function + NEW sink route — deliberately does NOT overload
  // _kcReportClientError/`/api/kiosk/client-error` (that beacon's 6-key
  // payload shape is pinned by kiosk-client-error-beacon.test.js). Same
  // fire-and-forget defensive wrapping as _kcReportClientError: a beacon
  // failure can never throw into the payment flow.
  function _kcReportTerminalPushLatency(info) {
    info = info || {};
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) return;
    var payload = {
      stage: String(info.stage == null ? '' : info.stage).slice(0, 40), // eslint-disable-line eqeqeq -- intentional == null matches undefined too
      duration_ms: (typeof info.duration_ms === 'number' && isFinite(info.duration_ms)) ? info.duration_ms : null,
      reference_number: String(info.reference_number == null ? '' : info.reference_number).slice(0, 64) // eslint-disable-line eqeqeq -- intentional == null matches undefined too
    };
    try {
      fetch(mwUrl + '/api/kiosk/telemetry', _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })).catch(function () {});
    } catch (e) { /* never let telemetry break the kiosk */ }
  }

  // Parse an 'HTTP nnn' status out of a caught error message, else null.
  function _kcHttpStatusFromErr(err) {
    var m = err && err.message ? String(err.message).match(/HTTP (\d{3})/) : null;
    return m ? parseInt(m[1], 10) : null;
  }

  // ===== 70-02 (KIOSK-MOTO): HelcimPay hosted-iframe phone-order tender =====
  // The PAN is entered ONLY inside Helcim's own iframe (secure.helcim.app) —
  // there is NO card-number field anywhere in our DOM/JS (PCI SAQ-A). The
  // server already initialized the HelcimPay session (pos.js tender:'moto'
  // branch) and returned checkout_token in the /api/kiosk/sale 202 response,
  // so the kiosk does NOT fetch /api/payment/initialize a second time — it
  // calls the global appendHelcimPayIframe(token) directly (that global is
  // injected by the start.js <script> added to kiosk.html in Task 3).
  //
  // _kcHelcimCheckoutToken is the active session token; the single
  // window 'message' listener (bound once in kcInit) matches it against
  // Helcim's eventName and, on SUCCESS, hands the server-VERIFIED-later txn
  // id to the handlers _kioskGoMoto installs. The captured amount is verified
  // server-side (pos.js verifyMotoCharge, Task 1) BEFORE any booking — a
  // client-supplied transaction_id is never trusted on its own.
  var _kcHelcimCheckoutToken = null;
  var _kcMotoHandlers = null; // { onSuccess: fn(txnId), onAbort: fn() } while an iframe is mounted
  var _kcHelcimListenerBound = false;

  // Port of js/modules/12-checkout.js:59-68 (verbatim) — extracts the txn id
  // from Helcim's postMessage payload. Reads ONLY transactionId; the raw
  // event is never logged (PCI).
  function extractHelcimTransactionId(postMessageData) {
    var em = postMessageData && postMessageData.eventMessage;
    if (typeof em === 'string') { try { em = JSON.parse(em); } catch (e) { return ''; } }
    // Helcim wraps the response: { data: { hash, data: { transactionId, ... } }, status: 200 }
    var inner = em && em.data && em.data.data;
    if (inner && inner.transactionId) return String(inner.transactionId);
    // Fallback: flat structure (em.data.transactionId)
    var flat = em && em.data;
    return (flat && flat.transactionId) ? String(flat.transactionId) : '';
  }

  // Origin-validated postMessage handler (ported from js/modules/12-checkout.js).
  // T-70-07 (Spoofing): a foreign-origin message is ignored so a spoofed SUCCESS
  // cannot fake a payment confirmation.
  // WR-03 (70-review): the allowlist now names the SAME Helcim origins as the
  // kiosk CSP frame-src/connect-src (secure.helcim.app + secure.myhelcim.com).
  // The prior bare `myhelcim.com` disagreed with the CSP's `secure.myhelcim.com`
  // in both directions — a latent "missing domain silently breaks the feature"
  // gap (CLAUDE.md rule 12). The shared 12-checkout.js public-checkout source
  // carries the same inconsistency and is a separate, out-of-scope follow-up.
  function _kcHandleHelcimMessage(event) {
    if (event.origin !== 'https://secure.helcim.app' && event.origin !== 'https://secure.myhelcim.com') {
      return;
    }
    var data = event.data || {};
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return; } }
    var nameMatches = _kcHelcimCheckoutToken && data.eventName === 'helcim-pay-js-' + _kcHelcimCheckoutToken;
    if (!nameMatches) return;
    if (data.eventStatus === 'SUCCESS') {
      var txnId = extractHelcimTransactionId(data);
      if (typeof removeHelcimPayIframe === 'function') removeHelcimPayIframe();
      var handlers = _kcMotoHandlers;
      _kcMotoHandlers = null;
      _kcHelcimCheckoutToken = null;
      if (handlers && typeof handlers.onSuccess === 'function') handlers.onSuccess(txnId);
    } else if (data.eventStatus === 'ABORTED') {
      if (typeof removeHelcimPayIframe === 'function') removeHelcimPayIframe();
      var abortHandlers = _kcMotoHandlers;
      _kcMotoHandlers = null;
      _kcHelcimCheckoutToken = null;
      if (abortHandlers && typeof abortHandlers.onAbort === 'function') abortHandlers.onAbort();
    }
  }

  // Bind the HelcimPay postMessage listener exactly once (idempotent across
  // both kiosk.js and admin.js consumers calling kcInit).
  function _kcBindHelcimListener() {
    if (_kcHelcimListenerBound) return;
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('message', _kcHandleHelcimMessage);
    _kcHelcimListenerBound = true;
  }

  // ===== Shared Utilities (standalone-bundle copies — kiosk.js/admin.js each
  // carry their own copy of these too; this file is a third independent
  // bundle so it carries its own, matching the existing project convention) =====

  // escapeHTML — canonical apostrophe-escaping implementation (mirrors js/lib/utils.js).
  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function removeToast(toast) {
    if (toast._removed) return;
    toast._removed = true;
    clearTimeout(toast._timer);
    toast.classList.add('removing');
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 150);
  }

  function showToast(message, type, opts) {
    if (!type) type = 'info';
    if (!opts) opts = {};
    var container = document.getElementById('kiosk-toast-container');
    if (!container) return;

    var toast = document.createElement('div');
    toast.className = 'admin-toast admin-toast--' + type;

    var msgSpan = document.createElement('span');
    msgSpan.className = 'admin-toast-msg';
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (opts.undo) {
      var undoBtn = document.createElement('button');
      undoBtn.className = 'admin-toast-undo';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', function () {
        opts.undo();
        removeToast(toast);
      });
      toast.appendChild(undoBtn);
    }

    var closeBtn = document.createElement('button');
    closeBtn.className = 'admin-toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function () { removeToast(toast); });
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    var duration = opts.duration || (type === 'error' ? 6000 : 3500);
    var timer = setTimeout(function () { removeToast(toast); }, duration);
    toast._timer = timer;
  }

  // ===== Fee constants (mirrors js/kiosk.js — standalone bundle, own copy) =====
  var MAKERS_FEE = 45; // Added to kit rates for in-store pricing
  var MAKERS_FEE_SKU = 'MAKERS-FEE';
  var MATERIALS_FEE = 5; // Materials fee (corks etc.) — carries PST
  var MATERIALS_FEE_SKU = 'MAT-FEE';
  // 67-02: the silent 5% default-tax fallback constant was removed — a missing
  // tax_percentage is now a fail-closed data error (INV-000160), never a guess.

  // 57-03: a loaded catalog is considered stale after this many ms and is
  // force-refreshed on the next wake (visibilitychange/pageshow/online), so a
  // long-open iPad self-heals a phantom item instead of requiring staff to
  // manually tap "Refresh the product list". 10 minutes bounds the staleness
  // window without refetching on every wake (T-57-03-03).
  var KIOSK_CATALOG_MAX_AGE_MS = 10 * 60 * 1000;

  // ===== Module-scope state relocated into this closure (D-02) =====
  // None of this state is read/written by js/kiosk.js's deferred payment-path
  // functions (kioskProceedToPayment/kioskShowReceipt/terminal/SO-checkout-fork),
  // so it is safe to own here outright.
  var _kioskProducts = [];
  var _kioskRecipes = [];
  var _kioskMakersFeeWaived = false;
  var _kioskProductsLoaded = false;
  var _kioskProductsLoading = false;
  // 57-03: timestamp of the last successful catalog load. A long-open kiosk
  // that never re-fetches can hold a STALE catalog containing a phantom item
  // (an item_id no longer in Zoho) indefinitely — the confirmed variant-2
  // cause in 57-DIAGNOSIS.md. Paired with KIOSK_CATALOG_MAX_AGE_MS below.
  var _kioskProductsLoadedAt = null;
  var _kioskCurrentView = 'browse';
  var _kioskMode = 'products';
  var _kioskRecipesLoaded = false;
  var _kioskRecipesLoading = false;
  var _kioskSelectedRecipe = null;
  var _kioskSaleType = null;
  var _kioskMillGrain = false;
  var _kioskRecipeAvailability = null;
  var _kioskTargetVolumeL = null;
  var _kioskScaleFactor = 1.0;
  var _kioskStockOverride = false;
  // ---- Payment-path state relocated here in 48-03 Task 1 (D-02) ----
  var _kioskTerminalReady = false;
  var _kioskSaleData = null; // receipt data from the last completed sale
  // 50-04 (D-50-05, T-50-20/T-50-21): ONE idempotency key per payment attempt
  // + a re-entrancy guard — the backstop for the disabled-button primary
  // guard (an iPad touch that registers twice before the DOM disables, a
  // client retry, a stale onclick already queued). Minted at the top of
  // kioskProceedToPayment(); cleared on every terminal outcome.
  var _kioskPaymentKey = null;
  var _kioskPaymentInFlight = false;
  // ---- Dual-cart / Sales-Order-import state relocated here in 48-03 Task 2 (D-02) ----
  var _kioskSalesOrders = [];
  var _kioskSoItems = [];       // items for new SO creation
  var _kioskSoCustomer = null;  // { contact_id, name, email }
  var _kioskSoPayingId = null;  // tracks SO being paid (for retry)
  // 50-04 (D-50-05, T-50-20/T-50-21): salesorder-pay's own key + guard,
  // separate from the sale-path ones above — kioskCollectPayment is
  // reachable from four call sites, only one of which is a button click.
  var _kioskSoPayKey = null;
  var _kioskSoPayInFlightId = null;
  var _kioskSoActiveChips = ['open', 'draft'];  // default active chip filter (D-10)
  var _kioskImportedSoId = null;        // SO ID when cart was imported from an SO
  var _kioskImportedSoNumber = null;    // SO number for display (e.g., "SO-001234")
  var _kioskImportedSoUpdated = false;  // true after SO update succeeds -- skip on retry (D-08)
  var _kioskQuote = null;
  var _kioskQuoteTimer = null;
  var _kioskModifyPanelOpen = false;
  var _kioskIngredientCatalog = [];
  var _kioskCatalogLoaded = false;
  var _kioskFilters = {
    search: '',
    category: '',
    type: '',
    stockStatus: '',
    hideOos: false,
    sort: 'name-asc'
  };
  var _kioskViewMode = (typeof localStorage !== 'undefined' && localStorage.getItem('sv-kiosk-view-mode')) || 'grid';
  var _kioskDiscountPresets = [];
  var _kioskEditingDiscountId = null; // null = creating a new preset; id = editing existing

  // ===== Cart building / catalog / render / totals (48-02 Task 1) =====

  function kioskFmt(amount) {
    return '$' + (parseFloat(amount) || 0).toFixed(2);
  }

  function kioskRenderRecipeIngredients(ingredients, el) {
    if (!el || !ingredients) return;
    var groups = (typeof groupRecipeIngredients === 'function')
      ? groupRecipeIngredients(ingredients)
      : [{ label: '', count: ingredients.length, items: ingredients }];
    var html = '';
    groups.forEach(function (group) {
      html += group.label
        ? '<strong>' + escapeHTML(group.label) + ' (' + group.count + ')</strong>'
        : '<strong>Ingredients:</strong>';
      html += '<ul style="margin:0.25rem 0;padding-left:1.25rem;">';
      group.items.forEach(function (ing) {
        html += '<li>' + escapeHTML(ing.item_name) + ' — ' + escapeHTML(String(ing.quantity || '')) + ' ' + escapeHTML(ing.unit || '') + '</li>';
      });
      html += '</ul>';
    });
    el.innerHTML = html;
  }

  // Fetch a dry-run quote from GET /api/kiosk/recipe-quote.
  // On success: store _kioskQuote and update Add-to-Cart button price.
  // On error: clear _kioskQuote (display falls back to base price).
  // Call debounced via kioskScheduleRecipeQuote (350 ms).
  function kioskFetchRecipeQuote() {
    if (!_kioskSelectedRecipe) return;
    var mw = _kcEnv.mwUrl;
    var recipeId = _kioskSelectedRecipe.recipe_id;
    var targetVol = _kioskTargetVolumeL || (Number(_kioskSelectedRecipe.batch_size_l) || null);
    var saleType = _kioskSaleType || 'in-store';
    var url = mw + '/api/kiosk/recipe-quote?recipe_id=' + encodeURIComponent(recipeId) +
              '&sale_type=' + encodeURIComponent(saleType);
    if (targetVol) url += '&target_volume_l=' + encodeURIComponent(targetVol);
    var modifiedIngredients = _kcEnv.getModifiedIngredients();
    if (Array.isArray(modifiedIngredients)) {
      url += '&modified_ingredients=' + encodeURIComponent(JSON.stringify(modifiedIngredients));
    }
    var discount = _kcEnv.getDiscount();
    if (discount && discount.presetId) {
      url += '&discount_preset_id=' + encodeURIComponent(discount.presetId);
    }
    var previewEl = document.getElementById('kiosk-recipe-price-preview');
    if (previewEl) {
      previewEl.style.display = '';
      previewEl.innerHTML = '<span style="color:var(--ink-tertiary);">Calculating…</span>';
    }
    return fetch(url, _kcMergeAuth({}))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (result.status === 200 && result.data && result.data.ok &&
            result.data.recipe_id === recipeId) {
          _kioskQuote = result.data;
          var el = document.getElementById('kiosk-recipe-price-preview');
          if (el) {
            el.style.display = '';
            var total = typeof result.data.total === 'number' ? result.data.total : null;
            if (total !== null) {
              var disc = result.data.discount;
              var before = result.data.total_before_discount;
              if (disc && typeof before === 'number' && before > total) {
                el.innerHTML = 'Estimated total: <s style="color:var(--ink-tertiary);">' +
                  escapeHTML('$' + before.toFixed(2)) + '</s> <strong>' + escapeHTML('$' + total.toFixed(2)) + '</strong>' +
                  ' <span style="color:var(--cellar-green,#2e6e4e);">(' + escapeHTML(disc.name) + ')</span>';
              } else {
                el.innerHTML = 'Estimated total: <strong>' + escapeHTML('$' + total.toFixed(2)) + '</strong>';
              }
            } else {
              el.innerHTML = '<span style="color:var(--batch-danger);">Price unavailable — check connection</span>';
            }
          }
          var summaryPriceEl = document.getElementById('kiosk-recipe-summary-price');
          if (summaryPriceEl) {
            if (total !== null) {
              summaryPriceEl.textContent = kioskFmt(total) + ' per batch';
            } else {
              summaryPriceEl.textContent = 'Price calculated at checkout';
            }
          }
          if (Array.isArray(result.data.ingredients) && result.data.ingredients.length > 0) {
            var ingListEl = document.getElementById('kiosk-recipe-ingredients');
            if (ingListEl) {
              kioskRenderRecipeIngredients(result.data.ingredients, ingListEl);
            }
          }
          kioskUpdateAddToCartButton();
        } else {
          _kioskQuote = null;
          var errEl = document.getElementById('kiosk-recipe-price-preview');
          if (errEl) {
            errEl.style.display = '';
            errEl.innerHTML = '<span style="color:var(--batch-danger);">Price unavailable — check connection</span>';
          }
          kioskUpdateAddToCartButton();
        }
      })
      .catch(function () {
        _kioskQuote = null;
        var errEl2 = document.getElementById('kiosk-recipe-price-preview');
        if (errEl2) {
          errEl2.style.display = '';
          errEl2.innerHTML = '<span style="color:var(--batch-danger);">Price unavailable — check connection</span>';
        }
        kioskUpdateAddToCartButton();
      });
  }

  function kioskScheduleRecipeQuote() {
    if (_kioskQuoteTimer) clearTimeout(_kioskQuoteTimer);
    _kioskQuoteTimer = setTimeout(kioskFetchRecipeQuote, 350);
  }

  // ---- Ingredient catalog for modify panel autocomplete ----

  function kioskLoadIngredientCatalog() {
    if (_kioskCatalogLoaded) return;
    var mw = _kcEnv.mwUrl;
    if (!mw) return;
    fetch(mw + '/api/ingredients?include_internal=1', _kcMergeAuth({}))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (data) {
        _kioskIngredientCatalog = data.items || data.ingredients || data || [];
        _kioskCatalogLoaded = true;
      })
      .catch(function () { /* non-fatal */ });
  }

  // ---- Modify panel row rendering ----

  // Render editable ingredient rows grouped by cf_type into #kiosk-modify-tbody.
  // data-ing-idx maps to the ORIGINAL flat array index via ingredients.indexOf(ing) (caveat #7).
  function renderKioskModifyRows() {
    var tbody = document.getElementById('kiosk-modify-tbody');
    if (!tbody) return;
    var ingredients = _kcEnv.getModifiedIngredients();
    if (!ingredients || ingredients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="kiosk-modify-empty">' +
        'No ingredients — use ‘+ Add Ingredient’ to build a custom list</td></tr>';
      return;
    }
    var groups = (typeof groupRecipeIngredients === 'function')
      ? groupRecipeIngredients(ingredients)
      : [{ label: '', count: ingredients.length, items: ingredients }];
    var html = '';
    groups.forEach(function (group) {
      if (group.label) {
        html += '<tr class="kiosk-modify-group-header"><td colspan="4" style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--ink-tertiary);">' +
          escapeHTML(group.label) + ' (' + group.count + ')</td></tr>';
      }
      group.items.forEach(function (ing) {
        var idx = ingredients.indexOf(ing); // CRITICAL: original flat-array index (caveat #7)
        var qtyVal = typeof ing.quantity !== 'undefined' ? ing.quantity : (ing.base_quantity || '');
        html += '<tr class="kiosk-modify-row" data-ing-idx="' + idx + '">';
        html += '<td class="ing-autocomplete-wrap"><input type="text" class="admin-input ing-search" ' +
          'style="font-size:1rem;" value="' +
          escapeHTML(ing.item_name || '') + '" autocomplete="off" /></td>';
        html += '<td><input type="number" class="admin-input ing-qty" step="0.01" min="0" ' +
          'inputmode="decimal" style="font-size:1rem;" value="' +
          escapeHTML(String(qtyVal)) + '" /></td>';
        html += '<td class="ing-unit">' + escapeHTML(ing.unit || '') + '</td>';
        html += '<td><button type="button" class="btn-secondary ing-remove" aria-label="Remove ' +
          escapeHTML(ing.item_name || '') + '">&#10005;</button></td>';
        html += '</tr>';
      });
    });
    tbody.innerHTML = html;
    attachKioskModifyRowListeners();
  }

  // Attach event listeners for remove, qty change, and search autocomplete on modify rows.
  function attachKioskModifyRowListeners() {
    var tbody = document.getElementById('kiosk-modify-tbody');
    if (!tbody) return;

    tbody.querySelectorAll('.ing-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.kiosk-modify-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        var modifiedIngredients = _kcEnv.getModifiedIngredients();
        if (isNaN(idx) || idx < 0 || !modifiedIngredients) return;
        modifiedIngredients.splice(idx, 1);
        renderKioskModifyRows();
        kioskScheduleRecipeQuote();
      });
    });

    tbody.querySelectorAll('.ing-qty').forEach(function (input) {
      input.addEventListener('change', function () {
        var row = input.closest('.kiosk-modify-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        var modifiedIngredients = _kcEnv.getModifiedIngredients();
        if (!isNaN(idx) && modifiedIngredients && modifiedIngredients[idx]) {
          modifiedIngredients[idx].quantity = parseFloat(input.value) || 0;
        }
        kioskScheduleRecipeQuote();
      });
    });

    tbody.querySelectorAll('.ing-search').forEach(function (input) {
      input.addEventListener('input', function () {
        kioskShowIngredientAutocomplete(input);
      });
      input.addEventListener('focus', function () {
        if (!input.value) kioskShowIngredientAutocomplete(input);
      });
      input.addEventListener('blur', function () {
        setTimeout(function () { kioskHideIngredientAutocomplete(input); }, 200);
      });
    });
  }

  // Simple autocomplete for the modify panel using _kioskIngredientCatalog
  function kioskShowIngredientAutocomplete(input) {
    kioskHideIngredientAutocomplete(input);
    var q = (input.value || '').toLowerCase().trim();
    var matches = _kioskIngredientCatalog.filter(function (item) {
      return (item.item_name || item.name || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
    if (!matches.length) return;
    var drop = document.createElement('div');
    drop.className = 'ing-autocomplete-drop';
    matches.forEach(function (item) {
      var opt = document.createElement('div');
      opt.setAttribute('role', 'option');
      opt.style.cssText = 'cursor:pointer;';
      opt.textContent = item.item_name || item.name || '';
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault();
        input.value = item.item_name || item.name || '';
        var row = input.closest('.kiosk-modify-row');
        var idx = parseInt(row && row.getAttribute('data-ing-idx'), 10);
        var modifiedIngredients = _kcEnv.getModifiedIngredients();
        if (!isNaN(idx) && modifiedIngredients && modifiedIngredients[idx]) {
          modifiedIngredients[idx].item_id = item.item_id || '';
          modifiedIngredients[idx].item_name = item.item_name || item.name || '';
          modifiedIngredients[idx].unit = item.unit || item.purchase_unit || '';
          var unitCell = row ? row.querySelector('.ing-unit') : null;
          if (unitCell) unitCell.textContent = modifiedIngredients[idx].unit;
        }
        kioskHideIngredientAutocomplete(input);
        kioskScheduleRecipeQuote();
      });
      drop.appendChild(opt);
    });
    var wrap = input.closest('.ing-autocomplete-wrap') || input.parentNode;
    if (wrap) {
      wrap.style.position = 'relative';
      wrap.appendChild(drop);
    }
  }

  function kioskHideIngredientAutocomplete(input) {
    var wrap = input.closest('.ing-autocomplete-wrap') || input.parentNode;
    if (!wrap) return;
    var drops = wrap.querySelectorAll('.ing-autocomplete-drop');
    drops.forEach(function (d) { d.parentNode.removeChild(d); });
  }

  // Returns item rate including maker's fee + materials fee for kits
  function kioskEffectiveRate(product) {
    var base = parseFloat(product.rate) || 0;
    return (kioskGetItemType(product) === 'kit') ? base + MAKERS_FEE + MATERIALS_FEE : base;
  }

  function kioskGetItemType(p) {
    var ptype = (p.product_type || '').toLowerCase();
    if (ptype === 'service') return 'service';
    var cfType = (p.cf_type || '').toLowerCase();
    if (cfType === 'consignment') return 'consignment';
    if (cfType && typeof KIT_CATEGORIES !== 'undefined' && KIT_CATEGORIES.indexOf(cfType) !== -1) return 'kit';
    if (cfType === 'ingredient') return 'ingredient';
    if (ptype === 'inventory' || ptype === 'goods') return 'ingredient';
    return ptype || 'other';
  }

  function kioskIsConsignment(p) {
    return kioskGetItemType(p) === 'consignment';
  }

  function kioskItemCategory(p) {
    return p.category_name || '';
  }

  function kioskIsWeightItem(p) {
    return (p.unit || '').toLowerCase() === 'kg';
  }

  // Stock overflow warning — fires when cart qty would exceed stock_on_hand (D-01, D-02, D-03)
  function kioskCheckStockOverflow(product, newQty) {
    var stock = parseFloat(product.stock_on_hand) || 0;
    var isService = (product.product_type || '').toLowerCase() === 'service';
    if (isService || kioskIsWeightItem(product) || stock <= 0) return true;
    if (newQty > stock) {
      var name = product.name || 'This item';
      return confirm('"' + name + '" — only ' + stock + ' in stock, cart would have ' + newQty + '. Add anyway?');
    }
    return true;
  }

  function kioskItemTax(item, qty) {
    var rate = parseFloat(item.rate) || 0;
    var pct = parseFloat(item.tax_percentage);
    // 67-02: a missing/unparseable tax_percentage is a DATA ERROR — return NaN
    // (a visible error) instead of silently rendering a false $0.00. This is
    // consistent with kioskCalcTotals' missing-tax detection (which flags the
    // item and blocks checkout). An explicit 0 is a VALID resolved rate.
    if (isNaN(pct)) return NaN;
    return parseFloat((rate * qty * pct / 100).toFixed(2));
  }

  function kioskCartIsEmpty() {
    return Object.keys(_kcEnv.getCart()).length === 0;
  }

  function kioskCartHasKits() {
    var cart = _kcEnv.getCart();
    return Object.keys(cart).some(function (id) {
      return kioskGetItemType(cart[id].item) === 'kit';
    });
  }

  function kioskFindMakersFee() {
    for (var i = 0; i < _kioskProducts.length; i++) {
      if ((_kioskProducts[i].sku || '').toUpperCase() === MAKERS_FEE_SKU) return _kioskProducts[i];
    }
    return null;
  }

  function kioskFindMaterialsFee() {
    for (var i = 0; i < _kioskProducts.length; i++) {
      if ((_kioskProducts[i].sku || '').toUpperCase() === MATERIALS_FEE_SKU) return _kioskProducts[i];
    }
    return null;
  }

  function kioskCountKitsInCart() {
    var count = 0;
    var cart = _kcEnv.getCart();
    var keys = Object.keys(cart);
    for (var i = 0; i < keys.length; i++) {
      var entry = cart[keys[i]];
      if (entry.item && kioskGetItemType(entry.item) === 'kit') {
        count += entry.qty;
      }
    }
    return count;
  }

  function kioskSyncKitFees() {
    if (_kioskMakersFeeWaived) return;
    var cart = _kcEnv.getCart();
    var makersFee = kioskFindMakersFee();
    var materialsFee = kioskFindMaterialsFee();
    var totalKits = kioskCountKitsInCart();
    if (totalKits > 0) {
      if (makersFee) cart[makersFee.item_id] = { item: makersFee, qty: totalKits };
      if (materialsFee) cart[materialsFee.item_id] = { item: materialsFee, qty: totalKits };
    } else {
      if (makersFee) delete cart[makersFee.item_id];
      if (materialsFee) delete cart[materialsFee.item_id];
      _kioskMakersFeeWaived = false;
    }
  }

  function kioskIsKitFee(item) {
    var sku = (item.sku || '').toUpperCase();
    return sku === MAKERS_FEE_SKU || sku === MATERIALS_FEE_SKU;
  }

  function kioskFindProductById(itemId) {
    if (!itemId) return null;
    for (var i = 0; i < _kioskProducts.length; i++) {
      if (_kioskProducts[i].item_id === itemId) return _kioskProducts[i];
    }
    return null;
  }

  function kioskR2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function kioskCalcTotals() {
    var cart = _kcEnv.getCart();
    var ids = Object.keys(cart);
    var subtotal = 0;
    ids.forEach(function (id) {
      var entry = cart[id];
      if (!entry || !entry.item) return; // skip non-item entries (defensive guard)
      subtotal += (parseFloat(entry.item.rate) || 0) * entry.qty;
    });
    subtotal = kioskR2(subtotal);

    var lineDiscount = {};
    var discountAmount = 0;
    var discount = _kcEnv.getDiscount();
    var recipeContext = _kcEnv.getRecipeContext();

    if (discount) {
      if (recipeContext) {
        // Recipe cart: the discount is server-authoritative — the discount-aware
        // quote already computed it against the recipe's product/fee portions.
        discountAmount = (_kioskQuote && _kioskQuote.discount && typeof _kioskQuote.discount.amount === 'number')
          ? _kioskQuote.discount.amount : 0;
        discountAmount = Math.min(discountAmount, subtotal);
      } else {
        // Standard cart: discount only the lines whose product type matches.
        var scope = discount.scope;
        var matchedIds = [];
        var matchedSubtotal = 0;
        ids.forEach(function (id) {
          var entry = cart[id];
          if (!entry || !entry.item) return;
          if (entry.item.custom || entry.item.gift_cert) return; // D-08: custom/gift_cert lines are never discounted
          var m;
          if (scope === 'cart') {
            m = true;
          } else if (scope === 'type' && typeof discountMatches === 'function') {
            m = discountMatches(classifyDiscountItem(entry.item), discount.applies_to || []);
          } else {
            m = false;
          }
          if (m) {
            matchedIds.push(id);
            matchedSubtotal += (parseFloat(entry.item.rate) || 0) * entry.qty;
          }
        });
        matchedSubtotal = kioskR2(matchedSubtotal);

        if (discount.type === 'percentage') {
          matchedIds.forEach(function (id) {
            var entry = cart[id];
            var lt = (parseFloat(entry.item.rate) || 0) * entry.qty;
            var d = kioskR2(lt * discount.value / 100);
            lineDiscount[id] = d;
            discountAmount += d;
          });
          discountAmount = kioskR2(discountAmount);
        } else {
          var fixed = Math.min(parseFloat(discount.value) || 0, matchedSubtotal);
          var remaining = fixed;
          matchedIds.forEach(function (id, k) {
            var entry = cart[id];
            var lt = (parseFloat(entry.item.rate) || 0) * entry.qty;
            var d;
            if (k === matchedIds.length - 1) {
              d = remaining;
            } else {
              d = matchedSubtotal > 0 ? kioskR2(fixed * (lt / matchedSubtotal)) : 0;
              remaining = kioskR2(remaining - d);
            }
            if (d > lt) d = lt;
            lineDiscount[id] = d;
          });
          discountAmount = kioskR2(fixed);
        }
      }
    }

    // Per-item tax using catalog tax_percentage (matches server-side calculation)
    var taxTotal = 0;
    var missingTaxItem = null;
    ids.forEach(function (id) {
      var entry = cart[id];
      if (!entry || !entry.item) return;
      var lt = (parseFloat(entry.item.rate) || 0) * entry.qty;
      var d = lineDiscount[id] || 0;
      // Recipe cart uses a uniform ratio (recipe lines are mostly tax-exempt anyway).
      if (recipeContext && discountAmount > 0 && subtotal > 0) {
        d = kioskR2(lt * (discountAmount / subtotal));
      }
      var taxable = Math.max(lt - d, 0);
      var pct = parseFloat(entry.item.tax_percentage);
      if (isNaN(pct)) {
        // 67-02: a missing/unparseable tax_percentage is a DATA ERROR, never a
        // guess — the removed silent 5% fallback under-quoted 12% GST+PST
        // items (INV-000160). DETECTION only here
        // (this runs on every cart render); the BLOCK happens at checkout
        // entry (kioskProceedToPayment) via kioskShowError, naming the item —
        // mirroring the 57-03 phantom-item guard shape. This line contributes
        // 0 tax; the sale is blocked before any charge, so the 0 never ships.
        if (!missingTaxItem) missingTaxItem = entry.item.name || entry.item.item_id || id;
        return;
      }
      taxTotal += taxable * (pct / 100);
    });
    taxTotal = kioskR2(taxTotal);

    return {
      subtotal: subtotal,
      discount: kioskR2(discountAmount),
      tax: taxTotal,
      total: kioskR2(subtotal - discountAmount + taxTotal),
      // 67-02: name/id of the first cart line whose tax could not be resolved
      // (null when every line has a valid numeric tax_percentage, incl. 0).
      missingTaxItem: missingTaxItem
    };
  }

  // ===== View Switching =====

  function kioskShowView(name) {
    var views = ['browse', 'browse-customer', 'customer', 'payment', 'review-batches', 'receipt', 'error', 'collect', 'create-so'];
    views.forEach(function (v) {
      var el = document.getElementById('kiosk-view-' + v);
      if (el) el.style.display = (v === name) ? '' : 'none';
    });
    _kioskCurrentView = name;
    if (name === 'browse') {
      var bmBtn = document.getElementById('kiosk-browse-mode-btn');
      if (bmBtn) bmBtn.style.display = '';
    }
  }

  // ===== Recipe Browser Mode Toggle =====

  function kioskSetMode(mode) {
    _kioskMode = mode;
    var prodGrid = document.getElementById('kiosk-product-grid');
    var recipeGrid = document.getElementById('kiosk-recipe-grid');
    var recipePrompt = document.getElementById('kiosk-recipe-prompt');
    var searchBar = document.querySelector('.kiosk-search-bar');
    var filterBar = document.querySelector('.kiosk-filter-bar');
    var resultCount = document.getElementById('kiosk-result-count');

    if (prodGrid) prodGrid.style.display = mode === 'products' ? '' : 'none';
    if (recipeGrid) recipeGrid.style.display = mode === 'recipes' ? 'grid' : 'none';
    if (recipePrompt) {
      recipePrompt.style.display = 'none';
      recipePrompt.classList.remove('kiosk-recipe-prompt-view');
    }
    if (searchBar) searchBar.style.display = mode === 'products' ? '' : 'none';
    if (filterBar) filterBar.style.display = mode === 'products' ? '' : 'none';
    if (resultCount) resultCount.style.display = mode === 'products' ? '' : 'none';

    var btns = document.querySelectorAll('.kiosk-mode-toggle__btn');
    btns.forEach(function (btn) {
      if (btn.getAttribute('data-mode') === mode) {
        btn.classList.add('kiosk-mode-toggle__btn--active');
      } else {
        btn.classList.remove('kiosk-mode-toggle__btn--active');
      }
    });

    if (mode === 'recipes' && !_kioskRecipesLoaded && !_kioskRecipesLoading) {
      kioskLoadRecipes();
    }
  }

  // ===== Load Products =====

  // forceRefresh modes (67 review fix WR-02):
  //   true      → re-fetch AND bust the server cache (?bust=1 → cold Zoho
  //               rebuild). Reserved for points that genuinely need fresh
  //               Zoho data (New Sale, post-sale stock refresh, staleness
  //               wake) — every bust costs Zoho quota and briefly leaves the
  //               server cache empty during the rebuild.
  //   'cached'  → re-fetch WITHOUT busting: re-reads the server's cached
  //               catalog (30-min TTL respected). Used at checkout entry,
  //               where a full bust per attempt (incl. abandoned ones) was
  //               pure Zoho-quota burn and opened a deleted-cache race
  //               against the sale POST.
  //   falsy     → render from memory if already loaded, else first fetch.
  function kioskLoadProducts(forceRefresh) {
    if (_kioskProductsLoading) return;
    if (_kioskProductsLoaded && !forceRefresh) {
      kioskRenderProducts();
      return;
    }

    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      var grid = document.getElementById('kiosk-product-grid');
      if (grid) grid.innerHTML = '<p class="kiosk-loading">Middleware URL not configured.</p>';
      return;
    }

    _kioskProductsLoading = true;
    var grid = document.getElementById('kiosk-product-grid');
    if (grid) grid.innerHTML = '<p class="kiosk-loading">Loading products...</p>';

    var url = mwUrl + '/api/kiosk/products' + (forceRefresh === true ? '?bust=1' : '');
    fetch(url, _kcMergeAuth({}))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _kioskProducts = data.items || [];
        _kioskProductsLoaded = true;
        _kioskProductsLoading = false;
        _kioskProductsLoadedAt = Date.now(); // 57-03: staleness clock resets on every successful load
        kioskPopulateCategories();
        kioskRenderProducts();
      })
      .catch(function (err) {
        _kioskProductsLoading = false;
        // Resilience: a failed refresh (e.g. a bust=1 request the server
        // rejects) must NOT wipe the grid. Keep the last-good products and
        // the loaded flag; only surface an error when we have nothing to show.
        if (_kioskProductsLoaded && _kioskProducts.length) {
          kioskRenderProducts();
          return;
        }
        _kcReportClientError({ message: 'Failed to load products: ' + (err && err.message),
          http_status: _kcHttpStatusFromErr(err), endpoint: '/api/kiosk/products' });
        kioskRenderLoadError('kiosk-product-grid', 'kiosk-products-retry',
          'Failed to load products: ' + err.message, function () { kioskLoadProducts(); });
      });
  }

  // A catalog load that fails with nothing to show must never be a dead end: the
  // iPad wakes from sleep with the wifi still reconnecting, the first fetch rejects,
  // and staff used to have to reload the whole page. Always offer a retry.
  function kioskRenderLoadError(gridId, retryId, message, onRetry) {
    var grid = document.getElementById(gridId);
    if (!grid) return;
    grid.innerHTML = '';

    var wrap = document.createElement('p');
    wrap.className = 'kiosk-loading';
    wrap.textContent = message + ' ';

    var btn = document.createElement('button');
    btn.id = retryId;
    btn.type = 'button';
    btn.className = 'btn-secondary';
    btn.textContent = 'Retry';
    btn.addEventListener('click', function () { onRetry(); });

    wrap.appendChild(btn);
    grid.appendChild(wrap);
  }

  // Self-healing: when the kiosk comes back (tab visible again, or the network
  // returns) and a catalog never loaded, retry it. Guarded on the loading flag so a
  // wake never stampedes an in-flight request, and on the loaded flag so a good grid
  // is never re-fetched (a failed refresh must not risk what we already have).
  function kioskRetryStalledLoads() {
    if (!_kioskProductsLoaded && !_kioskProductsLoading &&
        document.getElementById('kiosk-product-grid')) {
      kioskLoadProducts();
    } else if (_kioskProductsLoaded && !_kioskProductsLoading &&
               document.getElementById('kiosk-product-grid') &&
               (Date.now() - (_kioskProductsLoadedAt || 0)) >= KIOSK_CATALOG_MAX_AGE_MS) {
      // 57-03: the catalog loaded fine but has sat long enough that it may hold
      // a phantom item (57-DIAGNOSIS.md variant 2) — force-refresh on wake. The
      // existing keep-last-good `.catch` in kioskLoadProducts is inherited
      // unchanged, so a failed refresh here never wipes the good grid.
      kioskLoadProducts(true);
    }
    if (!_kioskRecipesLoaded && !_kioskRecipesLoading &&
        document.getElementById('kiosk-recipe-grid')) {
      kioskLoadRecipes();
    }
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') kioskRetryStalledLoads();
    });
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', kioskRetryStalledLoads);
    // 57-03: iOS Safari can restore a backgrounded/suspended tab via the
    // bfcache without firing visibilitychange — pageshow is the reliable wake
    // signal on iPad Safari for that case.
    window.addEventListener('pageshow', kioskRetryStalledLoads);
  }

  // ===== Recipe Browser =====

  function kioskLoadRecipes(forceRefresh) {
    if (_kioskRecipesLoading) return;
    if (_kioskRecipesLoaded && !forceRefresh) {
      kioskRenderRecipes();
      return;
    }
    _kioskRecipesLoading = true;
    var grid = document.getElementById('kiosk-recipe-grid');
    if (grid) grid.innerHTML = '<p class="kiosk-loading">Loading recipes...</p>';
    var mw = _kcEnv.mwUrl;
    fetch(mw + '/api/recipes?status=active', _kcMergeAuth({}))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        _kioskRecipes = data.recipes || [];
        _kioskRecipesLoaded = true;
        _kioskRecipesLoading = false;
        kioskRenderRecipes();
      })
      .catch(function (err) {
        _kioskRecipesLoading = false;
        // Resilience: a failed refresh must NOT wipe the grid. Keep the
        // last-good recipes and the loaded flag; only surface an error when
        // we have nothing to show.
        if (_kioskRecipesLoaded && _kioskRecipes.length) {
          kioskRenderRecipes();
          return;
        }
        _kcReportClientError({ message: 'Failed to load recipes: ' + (err && err.message),
          http_status: _kcHttpStatusFromErr(err), endpoint: '/api/recipes' });
        kioskRenderLoadError('kiosk-recipe-grid', 'kiosk-recipes-retry',
          'Failed to load recipes: ' + err.message, function () { kioskLoadRecipes(); });
      });
  }

  function kioskRecipePrice(recipe) {
    if (recipe.pricing_mode === 'dynamic' && Number(recipe.computed_price) > 0) return recipe.computed_price;
    if (recipe.pricing_mode !== 'dynamic' && Number(recipe.locked_price) > 0) return recipe.locked_price;
    if (Number(recipe.computed_price) > 0) return recipe.computed_price;
    if (Number(recipe.locked_price) > 0) return recipe.locked_price;
    return 0;
  }

  // Returns the display price adjusted for sale type context.
  // Dynamic recipes: take-out excludes service_fee + materials_fee from computed_price.
  // Locked recipes: always use locked_price regardless of sale type.
  function kioskRecipePriceForContext(recipe, saleType) {
    if (!recipe) return 0;
    if (recipe.pricing_mode === 'dynamic') {
      var base = Number(recipe.computed_price);
      if (!(base > 0)) return Number(recipe.locked_price) > 0 ? Number(recipe.locked_price) : 0;
      if (saleType === 'take-out') {
        var serviceFee = Number(recipe.service_fee) || 0;
        var materialsFee = Number(recipe.materials_fee) || 0;
        var takeOut = Math.round((base - serviceFee - materialsFee) * 100) / 100;
        return takeOut > 0 ? takeOut : base;
      }
      return base;
    }
    return Number(recipe.locked_price) > 0 ? Number(recipe.locked_price) : 0;
  }

  function kioskRenderRecipes() {
    if (_kioskMode !== 'recipes') return;
    var grid = document.getElementById('kiosk-recipe-grid');
    if (!grid) return;
    if (_kioskRecipes.length === 0) {
      grid.innerHTML = '<div class="kiosk-cart-empty"><p><strong>No active recipes</strong></p><p>No recipes are currently active.</p></div>';
      return;
    }
    var html = '';
    _kioskRecipes.forEach(function (r) {
      html += '<div class="kiosk-product-card kiosk-recipe-card" data-recipe-id="' + escapeHTML(r.recipe_id || '') + '">';
      html += '<div class="kiosk-product-body">';
      html += '<div class="kiosk-type-badge kiosk-type-badge--kit">Recipe</div>';
      html += '<div class="kiosk-product-name">' + escapeHTML(r.name || '') + '</div>';
      html += '<div class="kiosk-product-sku">' + escapeHTML(r.style || '') + (r.abv ? ' &middot; ' + r.abv + '%' : '') + '</div>';
      var rPrice = kioskRecipePrice(r);
      html += '<div class="kiosk-product-price" data-recipe-price-id="' + escapeHTML(r.recipe_id || '') + '">' + (rPrice > 0 ? kioskFmt(rPrice) : 'Market price') + '</div>';
      html += '<div class="kiosk-product-stock">' + (r.pricing_mode === 'dynamic' ? 'based on ingredients' : 'incl. brewing fee') + '</div>';
      html += '</div></div>';
    });
    grid.innerHTML = html;

    grid.querySelectorAll('.kiosk-recipe-card').forEach(function (card) {
      card.addEventListener('click', function () {
        var recipeId = card.getAttribute('data-recipe-id');
        var recipe = null;
        for (var i = 0; i < _kioskRecipes.length; i++) {
          if (_kioskRecipes[i].recipe_id === recipeId) { recipe = _kioskRecipes[i]; break; }
        }
        if (recipe) kioskShowRecipePrompt(recipe);
      });
    });

    // Background-warm computed_price for dynamic recipes whose detail cache was cold.
    _kioskRecipes.forEach(function (r) {
      if (r.pricing_mode !== 'dynamic') return;
      if (Number(r.computed_price) > 0) return;
      if (r._fetchedDetail) {
        if (r._fetchedDetail.recipe && r._fetchedDetail.recipe.computed_price != null) { // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
          r.computed_price = r._fetchedDetail.recipe.computed_price;
          var priceCell = grid.querySelector('[data-recipe-price-id="' + r.recipe_id + '"]');
          if (priceCell) {
            var warm = Number(r.computed_price);
            priceCell.textContent = warm > 0 ? kioskFmt(warm) : 'Market price';
          }
        }
        return;
      }
      (function (recipe) {
        var mwWarm = _kcEnv.mwUrl;
        fetch(mwWarm + '/api/recipes/' + encodeURIComponent(recipe.recipe_id), _kcMergeAuth({}))
          .then(function (resp) { return resp.json(); })
          .then(function (data) {
            recipe._fetchedDetail = data;
            if (data.recipe) {
              if (data.recipe.computed_price != null) recipe.computed_price = data.recipe.computed_price; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
              if (data.recipe.milling_fee_rate != null) recipe.milling_fee_rate = data.recipe.milling_fee_rate; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
              var priceEl = grid.querySelector('[data-recipe-price-id="' + recipe.recipe_id + '"]');
              if (priceEl) {
                var warm = kioskRecipePrice(recipe);
                priceEl.textContent = warm > 0 ? kioskFmt(warm) : 'Market price';
              }
            }
          })
          .catch(function () {}); // silently ignore — card retains locked_price as fallback
      }(r));
    });
  }

  function kioskShowRecipePrompt(recipe) {
    _kioskSelectedRecipe = recipe;
    _kioskSaleType = null;
    _kioskMillGrain = false;
    _kioskRecipeAvailability = null;

    var grid = document.getElementById('kiosk-recipe-grid');
    var prompt = document.getElementById('kiosk-recipe-prompt');
    if (grid) grid.style.display = 'none';
    if (prompt) {
      prompt.style.display = '';
      prompt.classList.add('kiosk-recipe-prompt-view');
    }

    var nameEl = document.getElementById('kiosk-recipe-selected-name');
    if (nameEl) nameEl.textContent = recipe.name || '';

    var summaryEl = document.getElementById('kiosk-recipe-summary');
    if (summaryEl) {
      var summaryHtml = '<div style="margin:0.5rem 0;color:var(--ink-secondary);font-size:0.9rem;">';
      summaryHtml += escapeHTML(recipe.style || '') + (recipe.abv ? ' &middot; ' + recipe.abv + '% ABV' : '');
      summaryHtml += '</div>';
      summaryHtml += '<div id="kiosk-recipe-summary-price" style="font-size:1.1rem;font-weight:700;color:var(--barrel);margin:0.5rem 0;">';
      var promptPrice = kioskRecipePrice(recipe);
      if (promptPrice > 0) {
        summaryHtml += kioskFmt(promptPrice) + ' per batch';
        if (recipe.pricing_mode === 'dynamic') summaryHtml += ' (based on ingredients)';
      } else {
        summaryHtml += 'Price calculated at checkout';
      }
      summaryHtml += '</div>';
      summaryHtml += '<div id="kiosk-recipe-ingredients" style="margin:0.75rem 0;font-size:0.85rem;color:var(--ink-secondary);">Loading ingredients...</div>';
      summaryEl.innerHTML = summaryHtml;

      if (recipe._fetchedDetail) {
        var ingEl = document.getElementById('kiosk-recipe-ingredients');
        if (ingEl && recipe._fetchedDetail.ingredients) {
          kioskRenderRecipeIngredients(recipe._fetchedDetail.ingredients, ingEl);
        }
        if (recipe._fetchedDetail.recipe && recipe._fetchedDetail.recipe.computed_price != null) { // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
          recipe.computed_price = recipe._fetchedDetail.recipe.computed_price;
          kioskUpdateSummaryPrice();
          kioskUpdateAddToCartButton();
        }
      } else {
        var mwForSummary = _kcEnv.mwUrl;
        fetch(mwForSummary + '/api/recipes/' + encodeURIComponent(recipe.recipe_id), _kcMergeAuth({}))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var ingEl2 = document.getElementById('kiosk-recipe-ingredients');
            if (ingEl2 && data.ingredients) {
              kioskRenderRecipeIngredients(data.ingredients, ingEl2);
            }
            recipe._fetchedDetail = data;
            if (data.recipe) {
              if (data.recipe.computed_price != null) recipe.computed_price = data.recipe.computed_price; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
              if (data.recipe.milling_fee_rate != null) recipe.milling_fee_rate = data.recipe.milling_fee_rate; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
              var cardGrid = document.getElementById('kiosk-recipe-grid');
              if (cardGrid) {
                var cardPriceEl = cardGrid.querySelector('[data-recipe-price-id="' + recipe.recipe_id + '"]');
                if (cardPriceEl) {
                  var warm = kioskRecipePrice(recipe);
                  cardPriceEl.textContent = warm > 0 ? kioskFmt(warm) : 'Market price';
                }
              }
              kioskUpdateSummaryPrice();
              kioskUpdateAddToCartButton();
            }
          })
          .catch(function () {
            var ingEl3 = document.getElementById('kiosk-recipe-ingredients');
            if (ingEl3) ingEl3.innerHTML = '';
          });
      }
    }

    var inStoreBtn = document.getElementById('kiosk-btn-in-store');
    var takeOutBtn = document.getElementById('kiosk-btn-take-out');
    if (inStoreBtn) { inStoreBtn.classList.remove('kiosk-sale-type-btn--selected'); inStoreBtn.classList.add('btn-secondary'); }
    if (takeOutBtn) { takeOutBtn.classList.remove('kiosk-sale-type-btn--selected'); takeOutBtn.classList.add('btn-secondary'); }

    var millingToggle = document.getElementById('kiosk-milling-toggle');
    var addBtn = document.getElementById('kiosk-add-recipe-to-cart');
    var millCheckbox = document.getElementById('kiosk-mill-grain');
    if (millingToggle) millingToggle.style.display = 'none';
    if (addBtn) addBtn.style.display = 'none';
    if (millCheckbox) millCheckbox.checked = false;

    var bannerEl = document.getElementById('kiosk-avail-banner');
    if (bannerEl) bannerEl.innerHTML = '';

    var volWrap     = document.getElementById('kiosk-recipe-volume-wrap');
    var volInput    = document.getElementById('kiosk-target-volume');
    var factorInput = document.getElementById('kiosk-target-factor');
    var factorRdout = document.getElementById('kiosk-scale-factor-readout');
    var conflictEl  = document.getElementById('kiosk-stock-conflict');
    var baseVol     = Number(recipe.batch_size_l) || 0;

    _kioskTargetVolumeL = baseVol > 0 ? baseVol : null;
    _kioskScaleFactor   = 1.0;
    _kioskStockOverride = false;
    if (conflictEl) conflictEl.style.display = 'none';

    if (volWrap) volWrap.style.display = '';
    if (baseVol > 0) {
      if (volInput) { volInput.value = baseVol; volInput.max = baseVol * 10; volInput.disabled = false; }
      if (factorInput) { factorInput.value = '1.00'; factorInput.max = '10'; factorInput.disabled = false; }
      if (factorRdout) factorRdout.textContent = '1.00\xd7 base ' + baseVol.toFixed(1) + ' L';
    } else {
      if (volInput) volInput.disabled = true;
      if (factorInput) factorInput.disabled = true;
      if (factorRdout) factorRdout.textContent = 'Set batch size (L) on this recipe to enable scaling';
    }

    if (volInput) {
      volInput.oninput = function () {
        var val = parseFloat(volInput.value) || 0;
        _kioskTargetVolumeL = val > 0 ? val : null;
        var factor = (val > 0 && baseVol > 0) ? val / baseVol : 1;
        _kioskScaleFactor = factor;
        if (factorInput) factorInput.value = factor.toFixed(2);
        if (factorRdout) {
          factorRdout.textContent = factor.toFixed(2) + '\xd7 base ' + baseVol.toFixed(1) + ' L';
        }
        _kioskStockOverride = false;
        if (conflictEl) conflictEl.style.display = 'none';
        kioskScheduleRecipeQuote();
      };
    }

    if (factorInput) {
      factorInput.oninput = function () {
        var rawFactor = parseFloat(factorInput.value) || 0;
        var clampedFactor = rawFactor <= 0 ? 0.1 : (rawFactor > 10 ? 10 : rawFactor);
        if (clampedFactor !== rawFactor && rawFactor > 0) {
          factorInput.value = clampedFactor.toFixed(2);
        }
        if (clampedFactor <= 0) return;

        var rawLitres = clampedFactor * baseVol;
        var roundedLitres = Math.round(rawLitres * 2) / 2;
        roundedLitres = Math.max(0.5, Math.min(roundedLitres, baseVol * 10));

        _kioskTargetVolumeL = roundedLitres;
        _kioskScaleFactor   = clampedFactor;

        if (volInput) volInput.value = roundedLitres;
        if (factorRdout) {
          factorRdout.textContent = clampedFactor.toFixed(2) + '\xd7 base ' + baseVol.toFixed(1) + ' L';
        }
        _kioskStockOverride = false;
        if (conflictEl) conflictEl.style.display = 'none';
        kioskScheduleRecipeQuote();
      };
    }

    kioskScheduleRecipeQuote();

    _kcEnv.setModifiedIngredients(null); // reset on recipe change
    _kioskModifyPanelOpen = false;

    var modifyWrap   = document.getElementById('kiosk-recipe-modify-wrap');
    var modifyToggle = document.getElementById('kiosk-modify-toggle');
    var modifyPanel  = document.getElementById('kiosk-modify-panel');
    var pricePreview = document.getElementById('kiosk-recipe-price-preview');
    var lockedNotice = document.getElementById('kiosk-locked-price-notice');
    var addRowBtn    = document.getElementById('kiosk-modify-add-row');

    if (modifyWrap) modifyWrap.style.display = '';
    if (modifyPanel) modifyPanel.style.display = 'none';
    if (pricePreview) { pricePreview.style.display = 'none'; pricePreview.innerHTML = ''; }
    if (lockedNotice) lockedNotice.style.display = 'none';

    if (modifyToggle) {
      modifyToggle.textContent = 'Modify Ingredients';
      modifyToggle.onclick = function () {
        _kioskModifyPanelOpen = !_kioskModifyPanelOpen;
        if (_kioskModifyPanelOpen) {
          var modifiedIngredients = _kcEnv.getModifiedIngredients();
          if (!Array.isArray(modifiedIngredients)) {
            var baseIngs = (recipe.ingredients && recipe.ingredients.length)
              ? recipe.ingredients
              : (_kioskSelectedRecipe && _kioskSelectedRecipe._fetchedDetail &&
                 _kioskSelectedRecipe._fetchedDetail.ingredients)
                ? _kioskSelectedRecipe._fetchedDetail.ingredients
                : [];
            _kcEnv.setModifiedIngredients(baseIngs.map(function (ing) {
              return Object.assign({}, ing);
            }));
          }
          if (modifyPanel) modifyPanel.style.display = '';
          modifyToggle.textContent = 'Modify Ingredients ▲';
          renderKioskModifyRows();
          if (lockedNotice && recipe.pricing_mode === 'locked') {
            lockedNotice.style.display = '';
          }
          if (pricePreview) pricePreview.style.display = '';
          kioskScheduleRecipeQuote();
          kioskLoadIngredientCatalog();
        } else {
          if (modifyPanel) modifyPanel.style.display = 'none';
          modifyToggle.textContent = 'Modify Ingredients';
        }
      };
    }

    if (addRowBtn) {
      addRowBtn.onclick = function () {
        var modifiedIngredients = _kcEnv.getModifiedIngredients();
        if (!Array.isArray(modifiedIngredients)) {
          modifiedIngredients = [];
        }
        modifiedIngredients.push({
          item_id: '',
          item_name: '',
          unit: '',
          quantity: 0
        });
        _kcEnv.setModifiedIngredients(modifiedIngredients);
        renderKioskModifyRows();
        kioskScheduleRecipeQuote();
      };
    }

    kioskCheckRecipeAvailability(recipe.recipe_id);
  }

  // Updates #kiosk-recipe-summary-price to reflect current sale type and computed_price.
  function kioskUpdateSummaryPrice() {
    var priceEl = document.getElementById('kiosk-recipe-summary-price');
    if (!priceEl || !_kioskSelectedRecipe) return;
    var recipe = _kioskSelectedRecipe;
    var contextPrice = kioskRecipePriceForContext(recipe, _kioskSaleType);
    var millingRate = Number(recipe.milling_fee_rate) || 0;
    if (_kioskMillGrain && _kioskSaleType === 'take-out' && millingRate > 0) {
      contextPrice += millingRate;
    }
    if (contextPrice > 0) {
      var label = kioskFmt(contextPrice) + ' per batch';
      if (recipe.pricing_mode === 'dynamic') {
        label += _kioskSaleType === 'take-out' ? ' (ingredients only)' : ' (based on ingredients)';
      }
      if (_kioskMillGrain && _kioskSaleType === 'take-out') label += ' (incl. milling)';
      priceEl.textContent = label;
    } else {
      priceEl.textContent = 'Price calculated at checkout';
    }
  }

  function kioskSelectSaleType(saleType) {
    _kioskSaleType = saleType;
    var inStoreBtn = document.getElementById('kiosk-btn-in-store');
    var takeOutBtn = document.getElementById('kiosk-btn-take-out');
    var millingToggle = document.getElementById('kiosk-milling-toggle');

    if (inStoreBtn) {
      if (saleType === 'in-store') { inStoreBtn.classList.add('kiosk-sale-type-btn--selected'); inStoreBtn.classList.remove('btn-secondary'); }
      else { inStoreBtn.classList.remove('kiosk-sale-type-btn--selected'); inStoreBtn.classList.add('btn-secondary'); }
    }
    if (takeOutBtn) {
      if (saleType === 'take-out') { takeOutBtn.classList.add('kiosk-sale-type-btn--selected'); takeOutBtn.classList.remove('btn-secondary'); }
      else { takeOutBtn.classList.remove('kiosk-sale-type-btn--selected'); takeOutBtn.classList.add('btn-secondary'); }
    }

    if (millingToggle) millingToggle.style.display = saleType === 'take-out' ? '' : 'none';

    // GAP-4 36-15: show price-preview as soon as a sale-type is selected (not just when modify panel opens)
    // The quote fetch triggered below will immediately set "Calculating…" then the real price.
    var pricePreviewEl = document.getElementById('kiosk-recipe-price-preview');
    if (pricePreviewEl) pricePreviewEl.style.display = '';

    kioskUpdateSummaryPrice();
    kioskScheduleRecipeQuote();  // Phase 35+36: re-quote on sale-type change (36-05)
    kioskUpdateAddToCartButton();
  }

  function kioskUpdateAddToCartButton() {
    var addBtn = document.getElementById('kiosk-add-recipe-to-cart');
    if (!addBtn || !_kioskSelectedRecipe || !_kioskSaleType) {
      if (addBtn) addBtn.style.display = 'none';
      return;
    }

    var avail = _kioskRecipeAvailability;
    if (avail && (avail.summary === 'cannot_brew' || avail.summary === 'unknown')) {
      addBtn.style.display = 'none';
      return;
    }

    // Phase 35+36: use server quote total when available (scaled + authoritative)
    var price;
    if (_kioskQuote && _kioskQuote.recipe_id === _kioskSelectedRecipe.recipe_id &&
        typeof _kioskQuote.total === 'number' && _kioskQuote.total > 0) {
      price = _kioskQuote.total;
    } else {
      price = kioskRecipePriceForContext(_kioskSelectedRecipe, _kioskSaleType);
      var millingRate = Number(_kioskSelectedRecipe.milling_fee_rate) || 0;
      if (_kioskMillGrain && _kioskSaleType === 'take-out' && millingRate > 0) {
        price += millingRate;
      }
    }
    // Phase 36: append "(Modified)" when ingredient list has been changed
    var isModified = Array.isArray(_kcEnv.getModifiedIngredients());
    var btnLabel = (price > 0 ? 'Add to Cart — ' + kioskFmt(price) : 'Add to Cart') +
                   (isModified ? ' (Modified)' : '');
    addBtn.textContent = btnLabel;
    addBtn.style.display = '';
  }

  function kioskCheckRecipeAvailability(recipeId) {
    var bannerEl = document.getElementById('kiosk-avail-banner');
    if (bannerEl) bannerEl.innerHTML = '<p class="kiosk-loading">Checking stock...</p>';
    var mw = _kcEnv.mwUrl;
    fetch(mw + '/api/recipes/' + encodeURIComponent(recipeId) + '/availability', _kcMergeAuth({}))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _kioskRecipeAvailability = data;
        kioskRenderAvailBanner(data);
        kioskUpdateAddToCartButton();
      })
      .catch(function () {
        _kioskRecipeAvailability = { summary: 'unknown' };
        kioskRenderAvailBanner({ summary: 'unknown' });
        kioskUpdateAddToCartButton();
      });
  }

  function kioskRenderAvailBanner(avail) {
    var bannerEl = document.getElementById('kiosk-avail-banner');
    if (!bannerEl) return;
    var summary = avail.summary || 'unknown';
    if (summary === 'all_ok') {
      bannerEl.innerHTML = '';
      return;
    }
    if (summary === 'some_low') {
      bannerEl.innerHTML = '<div class="kiosk-avail-warning">Some ingredients are low — this may be the last batch. <button type="button" class="btn-secondary" id="kiosk-avail-dismiss" style="margin-left:8px;padding:4px 12px;font-size:0.82rem;">Proceed anyway</button></div>';
      var dismissBtn = document.getElementById('kiosk-avail-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', function () { bannerEl.innerHTML = ''; });
      }
      return;
    }
    if (summary === 'cannot_brew') {
      bannerEl.innerHTML = '<div class="kiosk-avail-block">Cannot proceed: one or more ingredients are out of stock.</div>';
      return;
    }
    bannerEl.innerHTML = '<div class="kiosk-avail-block">Stock data unavailable — refresh and try again.</div>';
  }

  function kioskAddRecipeToCart() {
    if (!_kioskSelectedRecipe || !_kioskSaleType) return;
    var recipe = _kioskSelectedRecipe;
    var avail = _kioskRecipeAvailability;

    if (avail && (avail.summary === 'cannot_brew' || avail.summary === 'unknown')) return;

    _kcEnv.setCart({});

    function processRecipeData(data) {
      if (!data.recipe) {
        alert('Failed to load recipe details');
        return;
      }
      var cart = _kcEnv.getCart();
      var fullRecipe = data.recipe;
      var ingredients = data.ingredients || [];
      var pricingMode = fullRecipe.pricing_mode || recipe.pricing_mode || (Number(recipe.locked_price) > 0 ? 'locked' : 'dynamic');

      _kcEnv.setRecipeContext({
        recipe_id: recipe.recipe_id,
        recipe_name: recipe.name,
        sale_type: _kioskSaleType,
        mill_grain: _kioskMillGrain,
        locked_price: recipe.locked_price,
        pricing_mode: pricingMode,
        ingredients: ingredients,
        target_volume_l: _kioskTargetVolumeL
      });

      // Phase 35+36: Use server quote (scaled+modified) when available; fall back to base data
      var quoteForCart = (_kioskQuote &&
                          _kioskQuote.recipe_id === recipe.recipe_id &&
                          Array.isArray(_kioskQuote.ingredients))
                         ? _kioskQuote : null;

      if (pricingMode === 'dynamic') {
        // Add each ingredient as a priced line item
        // Prefer scaled+modified quantities from server quote when present
        var ingSource = quoteForCart ? quoteForCart.ingredients : ingredients;
        ingSource.forEach(function (ing, ingIdx) {
          // Unique per occurrence: a recipe can list the same item_id multiple
          // times (e.g. hop/salt additions at different times). Keying by
          // item_id alone collided and dropped all but the last → undercharge.
          var key = 'recipe-ing-' + ingIdx + '-' + (ing.item_id || ing.ingredient_id);
          var ingQty = Number(ing.quantity) || 0;
          var ingRate;
          if (quoteForCart) {
            // quote ingredient: line_total is authoritative; fall back to rate * qty
            ingRate = Number(ing.line_total) || (Number(ing.rate) * ingQty);
          } else {
            ingRate = (Number(ing.rate) || 0) * ingQty;
          }
          cart[key] = {
            item: {
              item_id: ing.item_id,
              name: escapeHTML(ing.item_name) + ' (' + ingQty + ' ' + escapeHTML(ing.unit || '') + ')',
              rate: ingRate,
              // 67 review (WR-04, KNOWN SEAM — deliberately deferred): this
              // `|| 0` (and the fee lines below) coerces a missing ingredient
              // tax to 0% — the same silent laundering Phase 67 removed for
              // product carts. It is left in place because the SERVER's
              // recipe total (recipe-scaling) computes no tax at all, so a
              // fail-closed client gate here would block sales the server
              // happily charges. The recipe path instead sends
              // client_grand_total/client_tax_total for the server's
              // LOG-ONLY divergence detector (pos-recipe.js); full recipe
              // tax fail-closed is a follow-up phase (67-REVIEW.md WR-04).
              tax_percentage: Number(ing.tax_percentage) || 0,
              product_type: 'recipe_ingredient'
            },
            qty: 1
          };
        });
        // Add fee lines for in-store sales
        if (_kioskSaleType === 'in-store') {
          if (Number(fullRecipe.service_fee) > 0) {
            cart['recipe-fee-brewing'] = {
              item: { item_id: 'fee-brewing', name: 'Brewing Fee', rate: parseFloat(fullRecipe.service_fee) || 0, tax_percentage: Number(fullRecipe.brewing_fee_tax) || 0, product_type: 'fee' },
              qty: 1
            };
          }
          if (Number(fullRecipe.materials_fee) > 0) {
            cart['recipe-fee-materials'] = {
              item: { item_id: 'fee-materials', name: 'Materials Fee', rate: parseFloat(fullRecipe.materials_fee) || 0, tax_percentage: Number(fullRecipe.materials_fee_tax) || 0, product_type: 'fee' },
              qty: 1
            };
          }
        }
        // Add milling fee for take-out when checked
        if (_kioskSaleType === 'take-out' && _kioskMillGrain) {
          var millingFee = Number(recipe.milling_fee_rate || fullRecipe.milling_fee_rate) || 0;
          cart['recipe-fee-milling'] = {
            item: { item_id: 'fee-milling', name: 'Milling Fee', rate: millingFee, tax_percentage: Number(recipe.milling_fee_tax || fullRecipe.milling_fee_tax) || 0, product_type: 'fee' },
            qty: 1
          };
        }
      } else {
        // Locked mode: ingredient lines as info-only (rate=0), plus single total line
        // Show SCALED+MODIFIED quantities from quote when available, otherwise base quantities
        var lockedIngSource = quoteForCart ? quoteForCart.ingredients : ingredients;
        lockedIngSource.forEach(function (ing, ingIdx) {
          // Unique per occurrence (see dynamic-mode note): same item_id may
          // appear multiple times in a recipe; index-qualify the cart key.
          var key = 'recipe-ing-' + ingIdx + '-' + (ing.item_id || ing.ingredient_id);
          cart[key] = {
            item: {
              item_id: ing.item_id,
              name: escapeHTML(ing.item_name) + ' (' + (Number(ing.quantity) || 0) + ' ' + escapeHTML(ing.unit || '') + ')',
              rate: 0,
              tax_percentage: 0,
              product_type: 'recipe_ingredient'
            },
            qty: 1
          };
        });
        // Single total line — use the PRE-DISCOUNT quote total when available, else
        // locked_price. The discount is applied separately in kioskCalcTotals from
        // the server quote, so the cart line must stay at the undiscounted amount.
        var packagePrice = quoteForCart
          ? Number(quoteForCart.total_before_discount != null ? quoteForCart.total_before_discount : quoteForCart.total) // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined
          : (parseFloat(recipe.locked_price) || 0);
        cart['recipe-total'] = {
          item: {
            item_id: recipe.recipe_id,
            name: escapeHTML(recipe.name || recipe.recipe_id) + ' — Package Price',
            rate: packagePrice,
            tax_percentage: 0,
            product_type: 'recipe'
          },
          qty: 1
        };
      }

      kioskSetMode('products');
      kioskRenderCart();
    }

    // Always fetch fresh to ensure tax rates and prices are current
    {
      var mw = _kcEnv.mwUrl;
      fetch(mw + '/api/recipes/' + encodeURIComponent(recipe.recipe_id), _kcMergeAuth({}))
        .then(function (r) { return r.json(); })
        .then(processRecipeData)
        .catch(function (err) {
          alert('Failed to load recipe: ' + err.message);
        });
    }
  }

  function kioskPopulateCategories() {
    var sel = document.getElementById('kiosk-category-filter');
    if (!sel) return;

    var typeFilter = _kioskFilters.type;
    var cats = {};
    _kioskProducts.forEach(function (p) {
      if (typeFilter === 'consignment') {
        if (!kioskIsConsignment(p)) return;
      } else if (typeFilter) {
        if ((p.product_type || '').toLowerCase() !== typeFilter) return;
      }
      var cat = kioskItemCategory(p);
      if (cat) cats[cat] = true;
    });

    var prev = sel.value;
    while (sel.options.length > 1) sel.remove(1);

    Object.keys(cats).sort().forEach(function (cat) {
      var opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      sel.appendChild(opt);
    });

    var hasUncategorized = _kioskProducts.some(function (p) {
      if (typeFilter === 'consignment') {
        if (!kioskIsConsignment(p)) return false;
      } else if (typeFilter) {
        if ((p.product_type || '').toLowerCase() !== typeFilter) return false;
      }
      return !kioskItemCategory(p);
    });
    if (hasUncategorized) {
      var otherOpt = document.createElement('option');
      otherOpt.value = '__other__';
      otherOpt.textContent = 'Other';
      sel.appendChild(otherOpt);
    }

    if (cats[prev] || prev === '__other__') {
      sel.value = prev;
    } else {
      sel.value = '';
      _kioskFilters.category = '';
    }
  }

  // ===== Filter + Sort Products =====

  function kioskGetFilteredProducts() {
    var search = (_kioskFilters.search || '').toLowerCase().trim();
    var cat = _kioskFilters.category;
    var type = _kioskFilters.type;
    var stockStatus = _kioskFilters.stockStatus;
    var hideOos = _kioskFilters.hideOos;

    var filtered = _kioskProducts.filter(function (p) {
      var itemType = kioskGetItemType(p);
      var isService = itemType === 'service';
      var stock = parseFloat(p.stock_on_hand) || 0;

      if (type && itemType !== type) return false;

      var itemCat = kioskItemCategory(p);
      if (cat === '__other__') {
        if (itemCat !== '') return false;
      } else if (cat && itemCat.toLowerCase() !== cat.toLowerCase()) return false;

      if (stockStatus === 'in-stock' && stock <= 0 && !isService) return false;
      if (stockStatus === 'low-stock' && (stock <= 0 || stock > 5)) return false;
      if (stockStatus === 'out-of-stock' && stock > 0) return false;

      if (hideOos && stock <= 0 && !isService) return false;

      if (search) {
        var haystack = ((p.name || '') + ' ' + (p.sku || '') + ' ' + itemCat + ' ' + itemType).toLowerCase();
        if (haystack.indexOf(search) === -1) return false;
      }
      return true;
    });

    var sort = _kioskFilters.sort || 'name-asc';
    filtered.sort(function (a, b) {
      switch (sort) {
        case 'name-asc': return (a.name || '').localeCompare(b.name || '');
        case 'name-desc': return (b.name || '').localeCompare(a.name || '');
        case 'price-asc': return (parseFloat(a.rate) || 0) - (parseFloat(b.rate) || 0);
        case 'price-desc': return (parseFloat(b.rate) || 0) - (parseFloat(a.rate) || 0);
        case 'stock-asc': return (parseFloat(a.stock_on_hand) || 0) - (parseFloat(b.stock_on_hand) || 0);
        default: return 0;
      }
    });
    return filtered;
  }

  // ===== Render Product Grid =====

  function kioskRenderProducts() {
    var grid = document.getElementById('kiosk-product-grid');
    if (!grid) return;
    var filtered = kioskGetFilteredProducts();

    var countEl = document.getElementById('kiosk-result-count');
    if (countEl) countEl.textContent = 'Showing ' + filtered.length + ' of ' + _kioskProducts.length + ' products';

    if (filtered.length === 0) {
      grid.innerHTML = '<p class="kiosk-loading">No products match your filters.</p>';
      return;
    }
    if (_kioskViewMode === 'list') {
      grid.classList.add('kiosk-product-grid--list');
      kioskRenderProductList(grid, filtered);
    } else {
      grid.classList.remove('kiosk-product-grid--list');
      kioskRenderProductGrid(grid, filtered);
    }
  }

  function kioskRenderProductGrid(grid, filtered) {
    var cart = _kcEnv.getCart();
    var html = '';
    filtered.forEach(function (p) {
      var cartEntry = cart[p.item_id];
      var inCart = cartEntry ? cartEntry.qty : 0;
      var stock = parseFloat(p.stock_on_hand) || 0;
      var itemType = kioskGetItemType(p);
      var isService = itemType === 'service';
      var outOfStock = !isService && stock <= 0;
      var lowStock = !outOfStock && !isService && stock <= 5;

      var cardClass = 'kiosk-product-card' + (outOfStock ? ' kiosk-product-card--out-of-stock' : '');

      var placeholderEmoji = isService ? '&#9881;' : '&#127866;';
      var imgHtml;
      if (p.image_name && p.sku) {
        imgHtml = '<img class="kiosk-product-img" src="images/products/' +
          encodeURIComponent(p.sku) + '.png" alt="" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\';">' +
          '<div class="kiosk-product-img-placeholder" style="display:none;">' + placeholderEmoji + '</div>';
      } else {
        imgHtml = '<div class="kiosk-product-img-placeholder">' + placeholderEmoji + '</div>';
      }

      var stockLabel, stockClass;
      if (isService) {
        stockLabel = '';
        stockClass = '';
      } else if (outOfStock) {
        stockLabel = stock < 0 ? (Math.round(stock) + ' in stock') : 'Out of stock';
        stockClass = 'kiosk-product-stock--out';
      } else if (lowStock) {
        stockLabel = 'Low stock (' + Math.round(stock) + ')';
        stockClass = 'kiosk-product-stock--low';
      } else {
        stockLabel = 'In stock';
        stockClass = '';
      }

      html += '<div class="' + cardClass + '" data-item-id="' + p.item_id + '">';
      if (inCart > 0) {
        html += '<div class="kiosk-card-in-cart">' + inCart + '</div>';
      }
      if (itemType === 'consignment') {
        html += '<div class="kiosk-consignment-badge">Consignment</div>';
      } else if (isService) {
        html += '<div class="kiosk-service-badge">Service</div>';
      }
      html += imgHtml;
      var displayRate = parseFloat(p.rate) || 0;
      html += '<div class="kiosk-product-body">';
      if (p.manufacturer && kioskGetItemType(p) === 'kit') {
        html += '<div class="kiosk-product-producer">' + escapeHTML(p.manufacturer) + '</div>';
      }
      html += '<div class="kiosk-product-name">' + escapeHTML(p.name || '') + '</div>';
      if (p.sku) html += '<div class="kiosk-product-sku">' + escapeHTML(p.sku) + '</div>';
      html += '<div class="kiosk-product-price">' + kioskFmt(displayRate) + '</div>';
      if (stockLabel) html += '<div class="kiosk-product-stock ' + stockClass + '">' + stockLabel + '</div>';
      html += '</div>';
      html += '</div>';
    });

    grid.innerHTML = html;

    var cards = grid.querySelectorAll('.kiosk-product-card');
    cards.forEach(function (card) {
      card.addEventListener('click', function () {
        var itemId = card.getAttribute('data-item-id');
        var product = _kioskProducts.filter(function (p) { return p.item_id === itemId; })[0];
        if (!product) return;
        var isService = (product.product_type || '').toLowerCase() === 'service';
        var stock = parseFloat(product.stock_on_hand) || 0;
        if (!isService && stock <= 0) {
          if (!confirm('"' + (product.name || 'This item') + '" is out of stock. Add to cart anyway (special order)?')) return;
        }
        kioskAddToCart(product);
      });
    });
  }

  function kioskRenderProductList(grid, filtered) {
    var html = '<table class="kiosk-list-table">';
    html += '<thead><tr>';
    html += '<th>Name</th>';
    html += '<th>Type</th>';
    html += '<th>Category</th>';
    html += '<th>Price</th>';
    html += '<th>Stock</th>';
    html += '<th></th>';
    html += '</tr></thead>';
    html += '<tbody>';

    filtered.forEach(function (p) {
      var stock = parseFloat(p.stock_on_hand) || 0;
      var itemType = kioskGetItemType(p);
      var isService = itemType === 'service';
      var outOfStock = !isService && stock <= 0;
      var rowClass = outOfStock ? ' kiosk-list-row--oos' : '';
      var displayRate = parseFloat(p.rate) || 0;
      var cat = kioskItemCategory(p);
      var typeLabel = itemType.charAt(0).toUpperCase() + itemType.slice(1);

      html += '<tr class="kiosk-list-row' + rowClass + '" data-item-id="' + escapeHTML(p.item_id) + '">';
      var kioskListName = p.manufacturer && kioskGetItemType(p) === 'kit'
        ? escapeHTML(p.manufacturer) + ' — ' + escapeHTML(p.name || '')
        : escapeHTML(p.name || '');
      html += '<td><div class="kiosk-list-name">' + kioskListName + '</div>';
      if (p.sku) html += '<div class="kiosk-list-sku">' + escapeHTML(p.sku) + '</div>';
      html += '</td>';

      html += '<td>';
      html += '<span class="kiosk-type-badge kiosk-type-badge--' + escapeHTML(itemType) + '">' + escapeHTML(typeLabel) + '</span>';
      html += '</td>';

      html += '<td>' + escapeHTML(cat) + '</td>';
      html += '<td>' + kioskFmt(displayRate) + '</td>';

      html += '<td>';
      if (isService) {
        html += '<span class="kiosk-stock--service">Service</span>';
      } else if (outOfStock) {
        html += '<span class="kiosk-product-stock--out">Out of stock</span>';
      } else if (stock <= 5) {
        html += '<span class="kiosk-product-stock--low">Low (' + Math.round(stock) + ')</span>';
      } else {
        html += Math.round(stock);
      }
      html += '</td>';

      html += '<td>';
      html += '<button type="button" class="kiosk-list-add-btn' + (outOfStock ? ' kiosk-list-add-btn--oos' : '') + '" data-item-id="' + escapeHTML(p.item_id) + '">+</button>';
      html += '</td>';

      html += '</tr>';
    });

    html += '</tbody></table>';
    grid.innerHTML = html;

    Array.prototype.forEach.call(grid.querySelectorAll('.kiosk-list-add-btn'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var itemId = btn.getAttribute('data-item-id');
        var product = null;
        for (var i = 0; i < _kioskProducts.length; i++) {
          if (_kioskProducts[i].item_id === itemId) { product = _kioskProducts[i]; break; }
        }
        if (!product) return;
        var isService = (product.product_type || '').toLowerCase() === 'service';
        var stock = parseFloat(product.stock_on_hand) || 0;
        if (!isService && stock <= 0) {
          if (!confirm('"' + (product.name || 'This item') + '" is out of stock. Add to cart anyway (special order)?')) return;
        }
        kioskAddToCart(product);
      });
    });
  }

  // ===== Cart Management =====

  function kioskAddToCart(product) {
    var cart = _kcEnv.getCart();
    var id = product.item_id;
    if (kioskIsWeightItem(product)) {
      var input = prompt('Enter quantity in kg for "' + (product.name || '') + '":', cart[id] ? cart[id].qty : '1');
      if (input === null) return;
      var qty = parseFloat(input);
      if (!isFinite(qty) || qty <= 0) return;
      qty = Math.round(qty * 1000) / 1000;
      cart[id] = { item: product, qty: qty };
    } else {
      var currentQty = cart[id] ? cart[id].qty : 0;
      var newQty = currentQty + 1;
      if (!kioskCheckStockOverflow(product, newQty)) return;
      if (cart[id]) {
        cart[id].qty = newQty;
      } else {
        cart[id] = { item: product, qty: 1 };
      }
    }

    if (kioskGetItemType(product) === 'kit') {
      _kioskMakersFeeWaived = false;
      kioskSyncKitFees();
    }

    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskSetQty(itemId, qty) {
    var cart = _kcEnv.getCart();
    var wasKit = cart[itemId] && kioskGetItemType(cart[itemId].item) === 'kit';
    if (qty <= 0) {
      delete cart[itemId];
    } else {
      if (cart[itemId]) {
        if (qty > cart[itemId].qty) {
          if (!kioskCheckStockOverflow(cart[itemId].item, qty)) return;
        }
        cart[itemId].qty = qty;
      }
    }
    if (wasKit) kioskSyncKitFees();
    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskRemoveFromCart(itemId) {
    var cart = _kcEnv.getCart();
    var wasFee = cart[itemId] && kioskIsKitFee(cart[itemId].item);
    var wasKit = cart[itemId] && kioskGetItemType(cart[itemId].item) === 'kit';
    delete cart[itemId];
    if (wasFee) {
      _kioskMakersFeeWaived = true;
    } else if (wasKit) {
      kioskSyncKitFees();
    }
    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskClearCart() {
    _kioskMakersFeeWaived = false;
    _kcEnv.setCart({});
    _kcEnv.setDiscount(null);
    _kcEnv.setGiftCard(null);
    _kioskSelectedRecipe = null;
    _kioskSaleType = null;
    _kioskMillGrain = false;
    _kioskRecipeAvailability = null;
    _kcEnv.setRecipeContext(null);
    _kioskQuote = null;
    _kcEnv.setModifiedIngredients(null);
    _kioskModifyPanelOpen = false;
    _kioskTargetVolumeL = null;
    kioskUpdateDiscountDisplay();
    kioskRenderCart();
    kioskRenderProducts();
  }

  function kioskRenderCart() {
    var container = document.getElementById('kiosk-cart-items');
    var totalsEl = document.getElementById('kiosk-cart-totals');
    var checkoutBtn = document.getElementById('kiosk-checkout-btn');
    var checkoutTotal = document.getElementById('kiosk-checkout-total');
    if (!container) return;

    var cart = _kcEnv.getCart();
    var keys = Object.keys(cart);

    var discountBtn = document.getElementById('kiosk-discount-btn');

    // SO import banner (D-01)
    var bannerHtml = '';
    var importedSoId = _kioskImportedSoId;
    var importedSoNumber = _kioskImportedSoNumber;
    if (importedSoId) {
      bannerHtml = '<div class="kiosk-cart-so-banner">' +
        '<span>Order: <strong>' + escapeHTML(importedSoNumber || '') + '</strong></span>' +
        '<button type="button" class="kiosk-cart-so-clear" title="Detach SO" aria-label="Detach SO">&#215;</button>' +
        '</div>';
    }

    if (keys.length === 0) {
      container.innerHTML = bannerHtml +
        '<p class="kiosk-cart-empty">No items in cart</p>' +
        '<div style="margin-top:0.5rem;">' +
        '<button id="kiosk-add-custom-btn" type="button" class="kiosk-add-custom-btn" style="width:100%;padding:0.6rem;font-size:0.95rem;border:1px dashed #888;border-radius:6px;background:none;cursor:pointer;color:#555;">' +
        '+ Add custom item' +
        '</button>' +
        '</div>' +
        '<div style="margin-top:0.5rem;">' +
        '<button id="kiosk-add-gc-btn" type="button" class="kiosk-add-custom-btn" style="width:100%;padding:0.6rem;font-size:0.95rem;border:1px dashed #5a3e1b;border-radius:6px;background:none;cursor:pointer;color:#5a3e1b;">' +
        '+ Issue / Reload Gift Card' +
        '</button>' +
        '</div>';
      var soClearEmpty = container.querySelector('.kiosk-cart-so-clear');
      if (soClearEmpty) {
        soClearEmpty.addEventListener('click', function () {
          kioskClearImportedSo();
          kioskRenderCart();
        });
      }
      var addCustomBtnEmpty = document.getElementById('kiosk-add-custom-btn');
      if (addCustomBtnEmpty) {
        addCustomBtnEmpty.addEventListener('click', function () {
          _kcEnv.showCustomItemModal();
        });
      }
      var addGcBtnEmpty = document.getElementById('kiosk-add-gc-btn');
      if (addGcBtnEmpty) {
        addGcBtnEmpty.addEventListener('click', function () {
          _kcEnv.showGiftCardIssueModal();
        });
      }
      if (totalsEl) totalsEl.style.display = 'none';
      if (checkoutBtn) checkoutBtn.disabled = true;
      if (checkoutTotal) checkoutTotal.textContent = '$0.00';
      if (discountBtn) discountBtn.disabled = true;
      kioskUpdateDiscountDisplay();
      return;
    }

    var html = '';
    keys.forEach(function (id) {
      var entry = cart[id];
      if (!entry || !entry.item) return; // skip non-item entries (defensive guard)
      var item = entry.item;
      var qty = entry.qty;
      var rate = parseFloat(item.rate) || 0;
      var lineTotal = rate * qty;
      // GIFTCARD-01: gift_cert lines render with fixed qty=1 and a remove button (no qty stepper)
      if (item.gift_cert) {
        html += '<div class="kiosk-cart-line">';
        html += '<div class="kiosk-cart-line-name" title="' + escapeHTML(item.name || '') + '">' + escapeHTML(item.name || '') + '</div>';
        html += '<div class="kiosk-cart-qty"><span class="kiosk-qty-val">1</span></div>';
        html += '<div class="kiosk-cart-line-total">' + kioskFmt(lineTotal) + '</div>';
        html += '<button class="kiosk-cart-remove-btn" data-id="' + id + '">&times;</button>';
        html += '</div>';
        return;
      }
      html += '<div class="kiosk-cart-line">';
      var isWeight = kioskIsWeightItem(item);
      html += '<div class="kiosk-cart-line-name" title="' + escapeHTML(item.name || '') + '">' + escapeHTML(item.name || '') + '</div>';
      if (isWeight) {
        html += '<div class="kiosk-cart-qty">';
        html += '<input type="number" class="kiosk-qty-input" data-id="' + id + '" value="' + qty + '" step="0.01" min="0.001" inputmode="decimal">';
        html += '<span class="kiosk-qty-unit">kg</span>';
        html += '</div>';
      } else {
        html += '<div class="kiosk-cart-qty">';
        html += '<button class="kiosk-qty-btn" data-action="dec" data-id="' + id + '">-</button>';
        html += '<input type="number" class="kiosk-qty-input" data-id="' + id + '" value="' + qty + '" step="1" min="1" inputmode="numeric">';
        html += '<button class="kiosk-qty-btn" data-action="inc" data-id="' + id + '">+</button>';
        html += '</div>';
      }
      html += '<div class="kiosk-cart-line-total">' + kioskFmt(lineTotal) + '</div>';
      html += '<button class="kiosk-cart-remove-btn" data-id="' + id + '">&times;</button>';
      html += '</div>';
    });

    html += '<div style="margin-top:0.5rem;">' +
      '<button id="kiosk-add-custom-btn" type="button" class="kiosk-add-custom-btn" style="width:100%;padding:0.6rem;font-size:0.95rem;border:1px dashed #888;border-radius:6px;background:none;cursor:pointer;color:#555;">' +
      '+ Add custom item' +
      '</button>' +
      '</div>';
    html += '<div style="margin-top:0.5rem;">' +
      '<button id="kiosk-add-gc-btn" type="button" class="kiosk-add-custom-btn" style="width:100%;padding:0.6rem;font-size:0.95rem;border:1px dashed #5a3e1b;border-radius:6px;background:none;cursor:pointer;color:#5a3e1b;">' +
      '+ Issue / Reload Gift Card' +
      '</button>' +
      '</div>';

    container.innerHTML = bannerHtml + html;

    var soClearBtn = container.querySelector('.kiosk-cart-so-clear');
    if (soClearBtn) {
      soClearBtn.addEventListener('click', function () {
        kioskClearImportedSo();
        kioskRenderCart();
      });
    }

    container.querySelectorAll('.kiosk-qty-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var action = btn.getAttribute('data-action');
        var liveCart = _kcEnv.getCart();
        if (!liveCart[id]) return;
        var newQty = liveCart[id].qty + (action === 'inc' ? 1 : -1);
        kioskSetQty(id, newQty);
      });
    });

    container.querySelectorAll('.kiosk-qty-input').forEach(function (input) {
      input.addEventListener('input', function () {
        var id = input.getAttribute('data-id');
        var val = parseFloat(input.value);
        var liveCart = _kcEnv.getCart();
        if (!liveCart[id] || !isFinite(val) || val <= 0) return;
        liveCart[id].qty = Math.round(val * 1000) / 1000;
        var rate = parseFloat(liveCart[id].item.rate) || 0;
        var lineEl = input.closest('.kiosk-cart-line');
        if (lineEl) {
          var totalEl = lineEl.querySelector('.kiosk-cart-line-total');
          if (totalEl) totalEl.textContent = kioskFmt(rate * liveCart[id].qty);
        }
        var totals = kioskCalcTotals();
        var subEl = document.getElementById('kiosk-subtotal');
        var taxEl = document.getElementById('kiosk-tax');
        var totalEl2 = document.getElementById('kiosk-total');
        var checkoutTotal = document.getElementById('kiosk-checkout-total');
        if (subEl) subEl.textContent = kioskFmt(totals.subtotal);
        if (taxEl) taxEl.textContent = kioskFmt(totals.tax);
        if (totalEl2) totalEl2.textContent = kioskFmt(totals.total);
        if (checkoutTotal) checkoutTotal.textContent = kioskFmt(totals.total);
        kioskUpdateDiscountDisplay();
      });
      input.addEventListener('change', function () {
        var id = input.getAttribute('data-id');
        var val = parseFloat(input.value);
        if (!isFinite(val) || val <= 0) {
          kioskRemoveFromCart(id);
        } else {
          kioskSetQty(id, Math.round(val * 1000) / 1000);
        }
      });
    });

    container.querySelectorAll('.kiosk-cart-remove-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        kioskRemoveFromCart(id);
      });
    });

    var addCustomBtn = document.getElementById('kiosk-add-custom-btn');
    if (addCustomBtn) {
      addCustomBtn.addEventListener('click', function () {
        _kcEnv.showCustomItemModal();
      });
    }
    var addGcBtn = document.getElementById('kiosk-add-gc-btn');
    if (addGcBtn) {
      addGcBtn.addEventListener('click', function () {
        _kcEnv.showGiftCardIssueModal();
      });
    }

    var totals = kioskCalcTotals();
    var subEl = document.getElementById('kiosk-subtotal');
    var taxEl = document.getElementById('kiosk-tax');
    var totalEl = document.getElementById('kiosk-total');
    if (subEl) subEl.textContent = kioskFmt(totals.subtotal);
    if (taxEl) taxEl.textContent = kioskFmt(totals.tax);
    if (totalEl) totalEl.textContent = kioskFmt(totals.total);
    if (totalsEl) totalsEl.style.display = '';
    if (checkoutBtn) checkoutBtn.disabled = false;
    if (checkoutTotal) checkoutTotal.textContent = kioskFmt(totals.total);
    if (discountBtn) discountBtn.disabled = kioskCartIsEmpty();
    kioskUpdateDiscountDisplay();
  }

  function kioskShowCustomerStep() {
    kioskShowView('customer');

    var hasKits = kioskCartHasKits();
    var proceedBtn = document.getElementById('kiosk-customer-proceed');
    var skipBtn = document.getElementById('kiosk-customer-skip');
    var backBtn = document.getElementById('kiosk-customer-back');
    var searchInput = document.getElementById('kiosk-customer-search');
    var resultsEl = document.getElementById('kiosk-customer-results');
    var selectedEl = document.getElementById('kiosk-customer-selected');
    var newToggle = document.getElementById('kiosk-new-customer-toggle');
    var newForm = document.getElementById('kiosk-new-customer-form');
    var saveBtn = document.getElementById('kiosk-new-customer-save');

    if (searchInput) searchInput.value = '';
    if (resultsEl) resultsEl.innerHTML = '';
    if (newForm) newForm.style.display = 'none';
    if (skipBtn) skipBtn.style.display = hasKits ? 'none' : '';

    function updateProceedState() {
      if (proceedBtn) proceedBtn.disabled = !_kcEnv.getCustomer();
    }

    function kioskSelectCustomer(c) {
      _kcEnv.setCustomer(c);
      if (searchInput) { searchInput.value = ''; }
      if (resultsEl) resultsEl.innerHTML = '';
      if (selectedEl) {
        selectedEl.style.display = '';
        selectedEl.innerHTML = '<span>' + escapeHTML(c.name || '') + (c.email ? ' &mdash; ' + escapeHTML(c.email) : '') + '</span>' +
          '<button type="button" style="background:none;border:none;cursor:pointer;font-size:1rem;padding:0 0.25rem;" id="kiosk-clear-customer">&times;</button>';
        var clearBtn = document.getElementById('kiosk-clear-customer');
        if (clearBtn) {
          clearBtn.onclick = function () {
            _kcEnv.setCustomer(null);
            selectedEl.style.display = 'none';
            selectedEl.innerHTML = '';
            updateProceedState();
          };
        }
      }
      if (newForm) newForm.style.display = 'none';
      updateProceedState();
    }

    var existingCustomer = _kcEnv.getCustomer();
    if (existingCustomer) {
      kioskSelectCustomer(existingCustomer);
    } else {
      if (selectedEl) { selectedEl.style.display = 'none'; selectedEl.innerHTML = ''; }
      if (proceedBtn) proceedBtn.disabled = true;
    }

    if (backBtn) {
      backBtn.onclick = function () { kioskShowView('browse'); };
    }

    if (skipBtn) {
      // 50-04 (D-50-05, T-50-21): disable-on-click is the PRIMARY guard — no
      // debounce on a touch surface known for double-registration. The
      // _kioskPaymentInFlight re-entrancy check inside kioskProceedToPayment
      // is the backstop for what this alone cannot cover.
      skipBtn.onclick = function () {
        skipBtn.disabled = true;
        kioskProceedToPayment();
      };
    }

    if (proceedBtn) {
      proceedBtn.onclick = function () {
        if (_kcEnv.getCustomer()) {
          proceedBtn.disabled = true;
          kioskProceedToPayment();
        }
      };
    }

    if (newToggle) {
      newToggle.onclick = function () {
        if (newForm) newForm.style.display = newForm.style.display === 'none' ? '' : 'none';
      };
    }

    if (saveBtn) {
      saveBtn.onclick = function () {
        var nameEl = document.getElementById('kiosk-new-name');
        var emailEl = document.getElementById('kiosk-new-email');
        var phoneEl = document.getElementById('kiosk-new-phone');
        var name = nameEl ? nameEl.value.trim() : '';
        var email = emailEl ? emailEl.value.trim() : '';
        var phone = phoneEl ? phoneEl.value.trim() : '';
        if (!name || !email) {
          showToast('Name and email are required', 'error');
          return;
        }
        saveBtn.disabled = true;
        var mwUrl = _kcEnv.mwUrl;
        fetch(mwUrl + '/api/contacts', _kcMergeAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, email: email, phone: phone })
        }))
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (result) {
          saveBtn.disabled = false;
          if (result.data && result.data.contact_id) {
            if (nameEl) nameEl.value = '';
            if (emailEl) emailEl.value = '';
            if (phoneEl) phoneEl.value = '';
            kioskSelectCustomer({ contact_id: result.data.contact_id, name: name, email: email });
          } else {
            showToast(result.data.error || 'Could not create customer', 'error');
          }
        })
        .catch(function () {
          saveBtn.disabled = false;
          showToast('Could not create customer', 'error');
        });
      };
    }

    var searchTimer = null;
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        clearTimeout(searchTimer);
        var q = searchInput.value.trim();
        if (!q) { if (resultsEl) resultsEl.innerHTML = ''; return; }
        searchTimer = setTimeout(function () {
          var mwUrl = _kcEnv.mwUrl;
          fetch(mwUrl + '/api/contacts/search?q=' + encodeURIComponent(q), _kcMergeAuth({}))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!resultsEl) return;
            var contacts = (data.contacts || []).slice(0, 8);
            if (!contacts.length) {
              resultsEl.innerHTML = '<div style="padding:0.4rem 0.6rem;color:#888;font-size:0.88rem;">No results</div>';
              return;
            }
            var html = '';
            contacts.forEach(function (c) {
              html += '<div class="kiosk-customer-result-row" data-id="' + escapeHTML(c.contact_id || '') + '">' +
                '<strong>' + escapeHTML(c.contact_name || c.name || '') + '</strong>' +
                (c.email ? ' <span style="color:#666;">' + escapeHTML(c.email) + '</span>' : '') +
                '</div>';
            });
            resultsEl.innerHTML = html;
            Array.prototype.forEach.call(resultsEl.querySelectorAll('.kiosk-customer-result-row'), function (row) {
              row.onclick = function () {
                var idx = Array.prototype.indexOf.call(resultsEl.querySelectorAll('.kiosk-customer-result-row'), row);
                var c = contacts[idx];
                kioskSelectCustomer({
                  contact_id: c.contact_id || '',
                  name: c.contact_name || c.name || '',
                  email: c.email || ''
                });
              };
            });
          })
          .catch(function () {
            if (resultsEl) resultsEl.innerHTML = '<div style="padding:0.4rem 0.6rem;color:#888;font-size:0.88rem;">Search failed</div>';
          });
        }, 300);
      });

      searchInput.addEventListener('focus', function () {
        var el = searchInput;
        setTimeout(function () {
          if (el.scrollIntoView) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 350);
      });
    }

    var newFormInputIds = ['kiosk-new-name', 'kiosk-new-email', 'kiosk-new-phone'];
    newFormInputIds.forEach(function (inputId) {
      var el = document.getElementById(inputId);
      if (!el) return;
      el.addEventListener('focus', function () {
        var target = el;
        setTimeout(function () {
          if (target.scrollIntoView) {
            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 350);
      });
    });
  }

  // 50-04 (D-50-05, T-50-22): the mirror of the D-50-03 server lock-release
  // rule — clear the sale-path in-flight guard + key AND re-enable the
  // Proceed/Skip buttons on every terminal outcome (success, cancel, every
  // error branch). Called from kioskShowError/kioskShowReceipt (which cover
  // every failure/success branch of the sale path) plus the explicit cancel
  // handlers, which never route through either. A missed call here bricks
  // the kiosk until reload — the button looks clickable but the re-entrancy
  // guard silently swallows the tap.
  function _kioskEndPaymentAttempt() {
    _kioskPaymentInFlight = false;
    _kioskPaymentKey = null;
    var proceedBtn = document.getElementById('kiosk-customer-proceed');
    var skipBtn = document.getElementById('kiosk-customer-skip');
    if (proceedBtn) proceedBtn.disabled = !_kcEnv.getCustomer();
    if (skipBtn) skipBtn.disabled = false;
  }

  function kioskShowError(title, msg, canRetry, extra) {
    // 50-04: every kioskShowError call in this file is a sale-path terminal
    // outcome (recipe/standard/cash/moto sale error, terminal error, decline,
    // the pre-flight phantom-item/missing-tax guards) — never the SO-pay path
    // (which uses kioskShowSoError). Safe to centralize the cleanup here.
    _kioskEndPaymentAttempt();
    kioskShowView('error');

    var titleEl = document.getElementById('kiosk-error-title');
    var msgEl = document.getElementById('kiosk-error-msg');
    var retryBtn = document.getElementById('kiosk-retry-btn');
    var backBtn = document.getElementById('kiosk-back-btn');
    var detailEl = document.getElementById('kiosk-error-detail');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;

    if (detailEl) {
      if (extra && extra.txnId) {
        detailEl.textContent = 'Ref: ' + extra.txnId;
        detailEl.style.display = '';
      } else {
        detailEl.style.display = 'none';
      }
    }

    if (retryBtn) {
      retryBtn.style.display = canRetry ? '' : 'none';
      retryBtn.onclick = function () {
        kioskShowView('browse');
        kioskStartCheckout();
      };
    }

    if (backBtn) {
      backBtn.onclick = function () {
        kioskShowView('browse');
      };
    }
  }

  // ===== Terminal Status Bar (48-03 Task 1 — lifted verbatim from js/kiosk.js,
  // D-02: kiosk.js is canonical for the shared payment path) =====

  function kioskSetTerminalStatus(ready, msg) {
    _kioskTerminalReady = ready;
    var dot = document.getElementById('kiosk-terminal-dot');
    var label = document.getElementById('kiosk-terminal-label');
    if (!dot || !label) return;
    dot.className = 'kiosk-terminal-dot' +
      (ready ? ' kiosk-terminal-dot--ready' :
       (msg.indexOf('not configured') !== -1 ? ' kiosk-terminal-dot--error' : ' kiosk-terminal-dot--warn'));
    label.textContent = msg;
  }

  function kioskCheckTerminal() {
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      kioskSetTerminalStatus(false, 'Terminal: middleware not configured');
      return;
    }
    fetch(mwUrl + '/api/pos/status')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.enabled) {
          kioskSetTerminalStatus(true, 'Terminal ready (' + (data.terminal_type || 'UPA') + ')');
        } else {
          var d = data.diagnostics || {};
          var msg = 'Terminal not enabled';
          if (!d.HELCIM_API_TOKEN_SET) msg = 'Terminal: HELCIM_API_TOKEN not set in Railway';
          else if (!d.HELCIM_DEVICE_CODE_SET) msg = 'Terminal: HELCIM_DEVICE_CODE not set in Railway';
          else if (d.init_error) msg = 'Terminal init error: ' + d.init_error;
          else msg = 'Terminal: device not initialized';
          kioskSetTerminalStatus(false, msg);
        }
      })
      .catch(function () {
        kioskSetTerminalStatus(false, 'Terminal: middleware unreachable');
      });
  }

  // ===== Checkout Flow (48-03 Task 1) =====

  function kioskStartCheckout() {
    if (kioskCartIsEmpty()) return;
    // 67-02: cart-lifecycle catalog refresh (INV-000160). The New Sale button
    // already force-refreshes, but staff who go straight from an old browse
    // session into checkout on a parked kiosk would still quote from a stale
    // snapshot. Fire-and-forget: kioskLoadProducts keeps the last-good catalog
    // on a failed refresh (never wipes the grid).
    // 67 review fix (WR-02): 'cached' (non-busting) re-fetch — the previous
    // kioskLoadProducts(true) sent ?bust=1, which deleted the server cache
    // and triggered a cold Zoho rebuild on EVERY checkout entry (incl.
    // abandoned ones) and opened a deleted-cache race against the sale POST.
    // A refresh here cannot change THIS cart's totals anyway (cart entries
    // hold references to the already-added item objects) — it only freshens
    // the grid for the next cart. The 67-01 server-side pre-charge assertion
    // is the real staleness guard for the current sale. No periodic polling —
    // this cart-lifecycle hook covers the exposure (30-min server cache TTL
    // genuinely respected now).
    kioskLoadProducts('cached');
    if (!_kioskTerminalReady) {
      showToast('POS terminal is not ready. Check terminal status below.', 'error');
      return;
    }
    kioskShowCustomerStep();
  }

  function kioskProceedToPayment() {
    // 50-04 (D-50-05, T-50-20/T-50-21): primary re-entrancy guard. A second
    // tap of Proceed/Skip (or any other re-entrant call) while an attempt is
    // already in flight is a no-op — this is the backstop the disabled
    // button alone cannot cover (an iPad touch that registers twice before
    // the DOM disables, a client retry, a stale onclick already queued).
    if (_kioskPaymentInFlight) return;

    var totals = kioskCalcTotals();
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      showToast('Middleware URL not configured', 'error');
      return;
    }

    // Mint the ONE key for this attempt now that it is actually proceeding.
    // Every re-entry within this attempt (GC panel Skip/Proceed, the
    // stock-override resubmit) reads this SAME closure-captured value via
    // the local `refNumber` below — never re-minted per invocation.
    _kioskPaymentInFlight = true;
    _kioskPaymentKey = 'KIOSK-' + Date.now();

    var items = Object.keys(_kcEnv.getCart()).map(function (id) {
      var entry = _kcEnv.getCart()[id];
      // GIFTCARD-01: gift_cert lines forward cert info; server prices via KIOSK_GIFT_CARD_ITEM_ID (D-05)
      if (entry.item.gift_cert) {
        return {
          gift_cert: true,
          gift_action: entry.item.gift_action,
          cert_number: entry.item.cert_number,
          quantity: 1,
          rate: parseFloat(entry.item.rate) || 0
        };
      }
      // D-04/D-08: custom lines forward description/note/taxable — no item_id
      if (entry.item.custom) {
        return {
          custom: true,
          description: entry.item.description || '',
          note: entry.item.note || '',
          quantity: entry.qty,
          rate: parseFloat(entry.item.rate) || 0,
          taxable: entry.item.taxable !== false
        };
      }
      return {
        item_id: entry.item.item_id,
        name: entry.item.name || '',
        sku: entry.item.sku || '',
        quantity: entry.qty,
        rate: parseFloat(entry.item.rate) || 0,
        product_type: entry.item.product_type || '',
        cf_type: entry.item.cf_type || ''
      };
    });

    // 57-03: pre-checkout phantom guard — the confirmed variant-2 stale-catalog
    // cause (57-DIAGNOSIS.md). A cart line whose item_id is no longer in the
    // current catalog must be blocked HERE, before the sale POST, not left to
    // the server's price-anchoring 400 (pos.js:325-333, which remains the
    // backstop if this check is ever bypassed — never removed, never trusted
    // as the sole guard). Scoped to a LOADED, non-empty catalog only (an
    // empty/never-fetched _kioskProducts means there is nothing authoritative
    // to check against yet, not a stale catalog) and to the plain
    // product-catalog sale (recipe ingredients live in a separate catalog;
    // an imported Sales Order's lines come straight from Zoho) — neither is a
    // candidate for THIS catalog going stale.
    if (!_kcEnv.getRecipeContext() && !_kioskImportedSoId &&
        _kioskProductsLoaded && _kioskProducts.length) {
      for (var pgI = 0; pgI < items.length; pgI++) {
        var pgItem = items[pgI];
        if (pgItem.custom || pgItem.gift_cert) continue;
        if (!kioskFindProductById(pgItem.item_id)) {
          kioskShowError('Item Unavailable',
            'Item "' + (pgItem.name || pgItem.item_id) + '" is no longer in the current catalog. ' +
            'Remove it and re-add it from the product grid, then try again.',
            true);
          return;
        }
      }
    }

    // 67-02: fail-closed missing-tax gate (INV-000160). A cart line whose
    // tax_percentage could not be resolved must block checkout HERE — the
    // displayed total would otherwise silently under-quote (the old 5% guess).
    // Same "detect bad cart line, name it, block checkout" shape as the 57-03
    // phantom guard above; runs AFTER it so a phantom item reports its root
    // cause ("Item Unavailable") first. Retry returns to browse → re-ring.
    // 67 review fix (WR-03): scoped to EXCLUDE imported-SO carts, mirroring
    // the 57-03 guard — an SO's charge amount is its Zoho balance via
    // kioskCollectPayment, so the client's per-line tax resolution is
    // irrelevant to that money path, and the "re-add it" guidance is wrong
    // for SO-built carts (lines map from Zoho, not the product grid).
    // Recipe carts are deliberately NOT excluded: their lines currently
    // coerce a missing tax to 0 (see the WR-04 note at the recipe cart
    // build) so the gate is a no-op there today, but if a future change
    // preserves NaN on recipe lines this gate must cover them.
    if (!_kioskImportedSoId && totals.missingTaxItem) {
      kioskShowError('Tax Unavailable',
        'Item "' + totals.missingTaxItem + '" has no tax rate in the current catalog. ' +
        'Refresh the product list and re-add it, then try again.',
        true);
      return;
    }

    // === CHECKOUT FORK: imported SO vs new sale (D-02, D-08) ===
    // 48-03 Task 2: the SO subsystem (kioskCollectPayment, kioskShowSoError,
    // the imported-SO tracking state) is now fully internalized in this
    // closure — no more _kcEnv bridging for the SO fork.
    if (_kioskImportedSoId && !_kioskImportedSoUpdated) {
      // Step 1: Update SO line items in Zoho first, then collect payment
      kioskShowView('payment');
      var amountEl = document.getElementById('kiosk-payment-amount');
      var msgEl = document.getElementById('kiosk-terminal-msg');
      var spinnerEl = document.getElementById('kiosk-spinner');
      if (amountEl) amountEl.textContent = kioskFmt(totals.total);
      if (msgEl) msgEl.textContent = 'Updating order ' + escapeHTML(_kioskImportedSoNumber) + '...';
      if (spinnerEl) spinnerEl.style.display = '';

      fetch(mwUrl + '/api/kiosk/salesorder-update', _kcMergeAuth({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ salesorder_id: _kioskImportedSoId, items: items })
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (result.data && result.data.ok) {
          _kioskImportedSoUpdated = true;
          // Update balance in local SO list so kioskCollectPayment uses correct amount
          for (var j = 0; j < _kioskSalesOrders.length; j++) {
            if (_kioskSalesOrders[j].salesorder_id === _kioskImportedSoId) {
              _kioskSalesOrders[j].balance = result.data.balance || 0;
              _kioskSalesOrders[j].total = result.data.total || 0;
              break;
            }
          }
          // 50-04: hand off from the sale-path guard to kioskCollectPayment's
          // own SO-pay guard — this kioskProceedToPayment() invocation has
          // reached a terminal outcome (control now belongs to the SO-pay
          // subsystem).
          _kioskEndPaymentAttempt();
          kioskCollectPayment(_kioskImportedSoId);
        } else {
          // D-02: SO update failed — do NOT proceed to terminal
          kioskShowSoError('Order Update Failed',
            'Order update failed — payment not taken. Check connection and retry.', true);
        }
      })
      .catch(function () {
        kioskShowSoError('Connection Error',
          'Order update failed — payment not taken. Check connection and retry.', true);
      });
      return;

    } else if (_kioskImportedSoId && _kioskImportedSoUpdated) {
      // D-08: Retry after terminal failure — SO already updated, skip update
      _kioskEndPaymentAttempt();
      kioskCollectPayment(_kioskImportedSoId);
      return;
    }

    // === New-sale flow: push to terminal, poll status, confirm on approval ===
    kioskShowView('payment');

    var amountEl = document.getElementById('kiosk-payment-amount');
    var msgEl = document.getElementById('kiosk-terminal-msg');
    var spinnerEl = document.getElementById('kiosk-spinner');
    var itemsEl = document.getElementById('kiosk-payment-items');
    var cancelBtn = document.getElementById('kiosk-cancel-payment');

    if (amountEl) amountEl.textContent = kioskFmt(totals.total);
    if (msgEl) msgEl.textContent = '';
    if (spinnerEl) spinnerEl.style.display = 'none';

    if (itemsEl) {
      var itemHtml = '';
      items.forEach(function (it) {
        itemHtml += '<div class="kiosk-payment-item-row">';
        itemHtml += '<span>' + escapeHTML(it.name || '') + ' x' + (it.quantity || 1) + '</span>';
        itemHtml += '<span>' + kioskFmt((it.rate || 0) * (it.quantity || 1)) + '</span>';
        itemHtml += '</div>';
      });
      if (totals.discount > 0) {
        itemHtml += '<div class="kiosk-payment-item-row"><span>Discount: ' + escapeHTML(_kcEnv.getDiscount() ? _kcEnv.getDiscount().name : '') + '</span><span>-' + kioskFmt(totals.discount) + '</span></div>';
      }
      if (totals.tax > 0) {
        itemHtml += '<div class="kiosk-payment-item-row"><span>Tax</span><span>' + kioskFmt(totals.tax) + '</span></div>';
      }
      itemsEl.innerHTML = itemHtml;
    }

    var cancelled = false;
    // Phase 44: Before terminal push, Cancel just returns to browse (no terminal to cancel yet)
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.onclick = function () {
        cancelled = true;
        // 50-04 (T-50-22): cancel is a terminal outcome too — clear the guard
        // so a subsequent Proceed/Skip tap is a genuinely new attempt.
        _kioskEndPaymentAttempt();
        kioskShowView('browse');
      };
    }

    // 50-04 (D-50-05): read the ONE key minted at the top of this function —
    // do NOT mint a fresh one here. Minting per-invocation here was the
    // T-50-20 defect vector once (before the mint site moved up to the top
    // of kioskProceedToPayment); the null-fallback only guards a
    // not-yet-migrated entry path (_kioskPaymentInFlight guarantees this is
    // already set by the time we reach here).
    var refNumber = _kioskPaymentKey || ('KIOSK-' + Date.now());
    var saleCompleted = false;
    var pollTimer = null;
    var pollStart = Date.now();
    // Soft timeout: at this point reveal the manual-confirm fallback button —
    // but KEEP POLLING (see the interval + setTimeout below).
    var POLL_TIMEOUT_MS = 45000;
    // Hard timeout: only here does auto-polling actually stop. Kept generous so
    // a slow-but-real card-present interaction (tap/insert/PIN + terminal +
    // webhook latency) still auto-confirms. Production incident (Aug 2026):
    // approvals were landing at ~56s while the poll cleared at 45s, so the late
    // approval was never seen and /confirm never fired — the card was charged
    // but no Zoho invoice was created (charged-but-unbooked orphan).
    var POLL_HARD_TIMEOUT_MS = 180000;

    // Determine sale endpoint: recipe sale or standard kiosk sale
    var isRecipeSale = !!_kcEnv.getRecipeContext();
    var saleUrl = isRecipeSale
      ? mwUrl + '/api/kiosk/recipe-sale'
      : mwUrl + '/api/kiosk/sale';
    var recipeSaleBody = isRecipeSale ? {
      recipe_id: _kcEnv.getRecipeContext().recipe_id,
      sale_type: _kcEnv.getRecipeContext().sale_type,
      mill_grain: _kcEnv.getRecipeContext().mill_grain,
      // Forward the selected batch size + ingredient edits so the SERVER charges
      // the scaled/modified total shown in the cart (not the base 1× recipe).
      target_volume_l: _kcEnv.getRecipeContext().target_volume_l,
      modified_ingredients: Array.isArray(_kcEnv.getModifiedIngredients()) ? _kcEnv.getModifiedIngredients() : undefined,
      customer_name: (_kcEnv.getCustomer() && _kcEnv.getCustomer().name) || '',
      contact_id: (_kcEnv.getCustomer() && _kcEnv.getCustomer().contact_id) || '',
      reference_number: refNumber,
      idempotency_key: refNumber,
      discount: _kcEnv.getDiscount() ? { preset_id: _kcEnv.getDiscount().presetId, name: _kcEnv.getDiscount().name, type: _kcEnv.getDiscount().type, value: _kcEnv.getDiscount().value, scope: _kcEnv.getDiscount().scope } : undefined,
      // D-07 (Manager Override): refreshed on every _kioskPushToTerminal
      // invocation (incl. the override-button resubmit) so a stale `false`
      // captured here isn't sent after the staff clicks Override.
      override: _kioskStockOverride || false,
      // 67 review fix (WR-04): recipe sales carry the kiosk's DISPLAYED
      // totals too (same field names as the standard sale body, 67-01
      // interface contract). The server side is a LOG-ONLY divergence
      // detector for recipes (pos-recipe.js) — its recomputed grandTotal
      // carries no tax component while this displayed total does, so a
      // blocking assertion would false-reject taxed recipe carts. Never
      // trusted for pricing.
      client_grand_total: totals.total,
      client_tax_total: totals.tax
    } : null;
    // Phase 44 (D-05): gift_card set inside _kioskPushToTerminal after the GC panel step
    var standardSaleBody = {
      items: items,
      reference_number: refNumber,
      idempotency_key: refNumber,
      // 67-02: the kiosk's DISPLAYED totals, sent for the server's pre-charge
      // assertion (67-01 interface contract — exact field names pinned there).
      // Display values only: the server never trusts them for pricing; it
      // asserts client_grand_total against its own computed grandTotal
      // (tolerance $0.01) and rejects divergence 400 BEFORE any terminal
      // charge. client_tax_total is observability-only, never asserted.
      client_grand_total: totals.total,
      client_tax_total: totals.tax,
      discount: _kcEnv.getDiscount() ? { preset_id: _kcEnv.getDiscount().presetId, name: _kcEnv.getDiscount().name, type: _kcEnv.getDiscount().type, value: _kcEnv.getDiscount().value, scope: _kcEnv.getDiscount().scope } : undefined,
      gift_card: undefined
    };
    var saleBody = isRecipeSale ? recipeSaleBody : standardSaleBody;

    var confirmBtn = document.getElementById('kiosk-confirm-payment');
    if (confirmBtn) confirmBtn.style.display = 'none';

    function handleSaleResult(result) {
      if (cancelled || saleCompleted) return;
      saleCompleted = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (confirmBtn) confirmBtn.style.display = 'none';
      if (result.status === 201 && result.data.ok) {
        // T-44-G11: If gift cert activation failed post-payment, show prominent blocking staff alert
        if (result.data.gift_card_activation_failed) {
          var certNums = items.filter(function (it) { return it.gift_cert; }).map(function (it) { return it.cert_number; }).join(', ');
          alert('STAFF ALERT: Gift cert activation FAILED — payment was taken. Record the certificate number(s) and activate manually before the customer leaves.' + (certNums ? '\nCertificate(s): ' + certNums : ''));
        }
        _kioskSaleData = result.data;
        // D-46-01: batch creation for kit items is handled server-side
        // (brewpad-integration.js createBatchesFromSale, fire-and-forget on
        // every kiosk sale confirm) — the client no longer POSTs its own
        // create_batch call (that path required a per-staff Google
        // accessToken which no longer exists on the standalone kiosk).
        kioskShowReceipt(result.data, totals, items, []);
        kioskClearCart();
      } else {
        if (result.data && result.data.payment_voided) {
          kioskShowError('Payment Voided',
            'Your payment was automatically reversed. No charge was made to the customer.',
            true, { txnId: result.data.voided_transaction_id || '' });
        } else {
          kioskShowError('Sale Error', (result.data && result.data.error) || 'Failed to create invoice.', true);
        }
      }
    }

    function confirmSale(txnId, tender) {
      if (cancelled || saleCompleted) return;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (msgEl) msgEl.textContent = 'Creating invoice...';
      if (spinnerEl) spinnerEl.style.display = '';
      if (confirmBtn) confirmBtn.style.display = 'none';
      if (cancelBtn) cancelBtn.disabled = true;

      if (isRecipeSale) {
        var confirmBody = {
          recipe_id: recipeSaleBody.recipe_id,
          sale_type: recipeSaleBody.sale_type,
          mill_grain: recipeSaleBody.mill_grain,
          // Mirror the sale request so the invoice + charge match the cart total.
          target_volume_l: recipeSaleBody.target_volume_l,
          modified_ingredients: recipeSaleBody.modified_ingredients,
          customer_name: recipeSaleBody.customer_name || '',
          contact_id: recipeSaleBody.contact_id || '',
          reference: refNumber,
          transaction_id: txnId,
          // CR-01: deterministic replay key so the server can short-circuit a duplicate confirm
          idempotency_key: refNumber,
          discount: recipeSaleBody.discount,
          // D-07 (Manager Override): belt-and-suspenders — pos-recipe.js
          // re-checks stock at confirm time too (pos-recipe.js:610).
          override: recipeSaleBody.override || false
        };
        fetch(mwUrl + '/api/kiosk/recipe-sale/confirm', _kcMergeAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(confirmBody)
        }))
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
        .then(function (result) {
          if (cancelled || saleCompleted) return;
          saleCompleted = true;
          if (spinnerEl) spinnerEl.style.display = 'none';
          if (result.status === 201 && result.data.ok) {
            _kioskSaleData = result.data;
            kioskShowReceipt(result.data, totals, items, []);
            kioskClearCart();
          } else if (result.data && result.data.payment_voided) {
            kioskShowError('Sale Could Not Complete',
              (result.data.error || 'Payment was taken but could not be recorded. Payment has been voided.'),
              false);
          } else {
            kioskShowError('Sale Error',
              (result.data && result.data.error) || 'An error occurred. Please try again.',
              true);
          }
        })
        .catch(function () {
          if (cancelled || saleCompleted) return;
          _kcReportClientError({ message: 'recipe-sale/confirm fetch rejected', http_status: null,
            endpoint: '/api/kiosk/recipe-sale/confirm' });
          if (spinnerEl) spinnerEl.style.display = 'none';
          kioskShowError('Connection Error', 'Could not confirm the recipe sale. Contact staff for assistance.', false);
        });
        return;
      }

      // Phase 44 (D-05): include gift_card in confirm body so server records split payment.
      // 70-01: tender is forwarded so the server can route cash bookings; cash NEVER
      // sends a transaction_id (txnId is undefined for cash — JSON.stringify drops it).
      fetch(mwUrl + '/api/kiosk/sale/confirm', _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: items,
          reference_number: refNumber,
          transaction_id: txnId,
          tender: tender || undefined,
          // CR-01: deterministic replay key so the server can short-circuit a duplicate confirm
          idempotency_key: refNumber,
          customer_name: _kcEnv.getCustomer() ? _kcEnv.getCustomer().name : '',
          contact_id: _kcEnv.getCustomer() ? _kcEnv.getCustomer().contact_id : '',
          discount: _kcEnv.getDiscount() ? { preset_id: _kcEnv.getDiscount().presetId, name: _kcEnv.getDiscount().name, type: _kcEnv.getDiscount().type, value: _kcEnv.getDiscount().value, scope: _kcEnv.getDiscount().scope } : undefined,
          gift_card: _kcEnv.getGiftCard() ? { cert_number: _kcEnv.getGiftCard().cert_number, amount_applied: _kcEnv.getGiftCard().amount_applied } : undefined
        })
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) { handleSaleResult(result); })
      .catch(function () {
        if (cancelled || saleCompleted) return;
        _kcReportClientError({ message: 'sale/confirm fetch rejected', http_status: null,
          endpoint: '/api/kiosk/sale/confirm' });
        if (spinnerEl) spinnerEl.style.display = 'none';
        kioskShowError('Connection Error', 'Could not reach the server. Please try again.', true);
      });
    }

    // Phase 44: _kioskPushToTerminal — called by GC panel "Proceed" / "Skip" buttons (or immediately for recipe sales).
    // Hides GC panel, switches cancel to terminal-cancel, updates amount display, then starts terminal push + poll.
    // D-07 (Manager Override): also re-invoked by the #kiosk-stock-override-btn
    // handler below to resubmit the sale with override=true after a 409.
    var _kioskPushToTerminal = function () {
      // D-07: refresh the override flag on every invocation (initial push AND
      // the override-button resubmit) so the current _kioskStockOverride value
      // is always sent — never a stale snapshot from construction time.
      if (isRecipeSale) {
        recipeSaleBody.override = _kioskStockOverride || false;
      }

      // Update standardSaleBody with the current gift card state (D-05: client-side clamp already applied in GC panel)
      if (!isRecipeSale) {
        standardSaleBody.gift_card = _kcEnv.getGiftCard()
          ? { cert_number: _kcEnv.getGiftCard().cert_number, amount_applied: _kcEnv.getGiftCard().amount_applied }
          : undefined;
        // WR-02 (70-review): the three tender paths share standardSaleBody. Cash
        // and MOTO suffix the key with their tender; the terminal path is the
        // baseline, so RESET the key to the bare refNumber here. This undoes any
        // prior cash/moto mutation so a switch FROM an aborted moto/cash attempt
        // TO the terminal does not inherit (and replay) that tender's cached
        // /sale response — while a genuine terminal double-tap still de-dupes.
        // (Bare refNumber also preserves the D-05 kiosk/admin parity contract.)
        standardSaleBody.idempotency_key = refNumber;
      }

      // Update amount display to terminal amount (total minus gift card)
      var terminalAmtDisplay = (!isRecipeSale && _kcEnv.getGiftCard())
        ? Math.max(0, Math.round((totals.total - _kcEnv.getGiftCard().amount_applied) * 100) / 100)
        : totals.total;
      if (amountEl) amountEl.textContent = kioskFmt(terminalAmtDisplay);

      // Hide GC panel
      var gcPanelEl = document.getElementById('kiosk-gc-panel');
      if (gcPanelEl) gcPanelEl.style.display = 'none';

      // Switch cancel button to terminal-cancel behavior
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.onclick = function () {
          cancelled = true;
          cancelBtn.disabled = true;
          // 50-04 (T-50-22): cancel is a terminal outcome — clear the guard
          // now, not after the /api/pos/cancel round-trip, so the buttons
          // aren't left disabled while the cancel POST is in flight.
          _kioskEndPaymentAttempt();
          if (msgEl) msgEl.textContent = 'Cancelling...';
          // 68-02: send the ref so the server can flag this sale as cancelled
          // (KIOSK_CANCELLED_PREFIX) — if a slow terminal push already landed
          // or lands after this, the Helcim webhook's APPROVED-result handler
          // voids it immediately instead of leaving it orphaned. The client no
          // longer needs to keep polling after cancel; the webhook is the
          // safety net.
          fetch(mwUrl + '/api/pos/cancel', _kcMergeAuth({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reference_number: refNumber })
          })).catch(function () {}).then(function () {
            kioskShowView('browse');
          });
        };
      }

      // Show terminal UI
      // 68-02: neutral message until the push is CONFIRMED sent (202 pending
      // below) — the previous immediate "Tap, insert, or swipe card..." told
      // staff to tap a reader that might not have received the push yet (the
      // reported "reader isn't picking up" perception). The real tap prompt
      // is set further down, only once the server confirms the push landed.
      if (msgEl) msgEl.textContent = (terminalAmtDisplay > 0) ? 'Contacting terminal…' : 'Processing gift card payment...';
      if (spinnerEl) spinnerEl.style.display = '';

      // 68-01: stamp the moment the terminal prompt is shown so the real
      // wall-time to the 202 response can be measured and beaconed
      // (_kcReportTerminalPushLatency below).
      var _kioskPushShownAt = Date.now();

      // Step 1: Push payment to terminal via backend (gift_card_only path skips terminal)
      fetch(saleUrl, _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(saleBody)
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (cancelled || saleCompleted) return;
        // Phase 44: gift-card-only path (full coverage, no terminal charge needed)
        if (result.status === 202 && result.data && result.data.gift_card_only) {
          confirmSale(undefined); // no transaction_id — terminal was not charged
          return;
        }
        // D-07 (Manager Override, ported from js/admin.js — the only WORKING
        // half; kiosk.js's own _kioskStockOverride was dead/never wired):
        // recipe-sale stock gate (pos-recipe.js:328) 409s with conflicts.
        // Render them + wire the override button to resubmit with override=true.
        if (isRecipeSale && result.status === 409 && result.data && result.data.conflicts) {
          if (spinnerEl) spinnerEl.style.display = 'none';
          var conflictEl = document.getElementById('kiosk-stock-conflict');
          var conflictMsgEl = document.querySelector('#kiosk-stock-conflict .kiosk-stock-conflict-msg');
          if (conflictMsgEl) {
            var lines = ['Insufficient stock for scaled batch:'];
            result.data.conflicts.forEach(function (c) {
              lines.push('• ' + (c.item_name || c.item_id) + ': need ' + c.needed + ' ' + (c.unit || '') + ', have ' + c.stock);
            });
            conflictMsgEl.textContent = lines.join('\n');
          }
          if (conflictEl) conflictEl.style.display = '';
          var overrideBtn = document.getElementById('kiosk-stock-override-btn');
          if (overrideBtn) {
            overrideBtn.onclick = function () {
              _kioskStockOverride = true;
              if (conflictEl) conflictEl.style.display = 'none';
              // Re-trigger the sale with override=true (re-invoke the same push routine).
              _kioskPushToTerminal();
            };
          }
          return;
        }
        if (result.status !== 202 || !result.data.pending) {
          if (spinnerEl) spinnerEl.style.display = 'none';
          // 57-03 (57-DIAGNOSIS.md beacon findings #1/#2, client half): this is
          // the server catalog-miss 400 (pos.js:325-333) — the exact branch the
          // 57-01 beacon never saw (it only fired from the network `.catch`).
          // Beacon it here with a structured item_id so a future occurrence is
          // observed unattended, surviving PAN redaction of the free-text
          // message (a 19-digit Zoho id collides with the 13-19-digit
          // card-number heuristic). Fire-and-forget; never blocks the UI.
          var saleErrMsg = (result.data && result.data.error) || '';
          var saleErrItemIdMatch = saleErrMsg.match(/(\d{15,})/);
          _kcReportClientError({
            message: saleErrMsg,
            http_status: result.status,
            endpoint: '/api/kiosk/sale',
            item_id: saleErrItemIdMatch ? saleErrItemIdMatch[1] : undefined
          });
          kioskShowError('Terminal Error', (result.data && result.data.error) || 'Failed to push to terminal.', true);
          return;
        }

        // 68-01: fire-and-forget beacon — real wall-time from "tap card" shown
        // to this 202 response. Never in the cancelled/saleCompleted-guarded
        // return path (both were already checked above).
        _kcReportTerminalPushLatency({
          duration_ms: Date.now() - _kioskPushShownAt,
          reference_number: result.data.reference,
          stage: 'push_to_202'
        });

        // 68-02: the push is now CONFIRMED sent — only now is it true that a
        // customer can tap/insert/swipe. (The gift-card-only 100%-covered
        // path already returned above, so reaching here always means a real
        // terminal push was made.)
        if (msgEl) msgEl.textContent = 'Tap, insert, or swipe card on terminal...';

        // Step 2: Poll for terminal result every 3 seconds
        var pollRef = result.data.reference;
        pollTimer = setInterval(function () {
          if (cancelled || saleCompleted) { clearInterval(pollTimer); pollTimer = null; return; }
          // Stop auto-polling only at the HARD cap — NOT the soft POLL_TIMEOUT_MS.
          // The soft-timeout setTimeout below reveals the manual-confirm fallback
          // without stopping the poll, so a late approval (after the soft timeout
          // but before the hard cap) is still detected and auto-confirmed.
          if (Date.now() - pollStart >= POLL_HARD_TIMEOUT_MS) {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (msgEl) msgEl.textContent = 'Terminal did not respond. Confirm manually if payment was taken, or cancel.';
            if (confirmBtn) { confirmBtn.style.display = ''; confirmBtn.disabled = false; confirmBtn.textContent = 'Confirm Manually'; }
            return;
          }
          fetch(mwUrl + '/api/kiosk/sale/status?ref=' + encodeURIComponent(pollRef), _kcMergeAuth({}))
          .then(function (r) { return r.json(); })
          .then(function (statusData) {
            if (cancelled || saleCompleted) return;
            if (statusData.status === 'approved') {
              confirmSale(statusData.transaction_id);
            } else if (statusData.status === 'declined') {
              if (saleCompleted) return;
              saleCompleted = true;
              if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              if (spinnerEl) spinnerEl.style.display = 'none';
              if (confirmBtn) confirmBtn.style.display = 'none';
              kioskShowError('Payment Declined', 'The card was declined or cancelled on the terminal. Please try again.', true);
            }
          })
          .catch(function () {});
        }, 3000);

        // F2 (45-09): only reveal the manual-confirm fallback once auto-confirm has had
        // its full chance (POLL_TIMEOUT_MS). A real card-present approval takes ~20-25s;
        // showing this button at 15s invited staff to preempt the poll/webhook, booking a
        // sale with no real Helcim txn id (the F2 orphan-then-manual-recovery symptom).
        // The server now also verifies a manual confirm against Helcim before booking.
        // WR-03 (Phase 48 review): armed HERE, inside the 202-pending branch — not
        // unconditionally after the fetch chain — so a 409 stock-conflict or terminal
        // error early-return can no longer leave it armed to overlay the override panel.
        setTimeout(function () {
          if (cancelled || saleCompleted) return;
          if (confirmBtn) {
            confirmBtn.style.display = '';
            confirmBtn.disabled = false;
            confirmBtn.textContent = 'Confirm Manually';
          }
          if (msgEl) msgEl.textContent = 'Waiting for terminal... or confirm manually if payment was taken.';
        }, POLL_TIMEOUT_MS);
      })
      .catch(function () {
        if (cancelled || saleCompleted) return;
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (msgEl) msgEl.textContent = 'Terminal connection lost. Confirm manually if payment was taken.';
      });
    };

    // 70-01 (KIOSK-CASH): _kioskGoCash — sibling to _kioskPushToTerminal, called
    // by the cash-tender panel's "Complete Sale" button. Staff have already
    // confirmed tendered >= cashRemainder in the change-due sub-panel below
    // (display-only — tendered/change are NEVER sent to the server). Skips the
    // terminal push + poll entirely: POST /api/kiosk/sale with tender:'cash',
    // then confirmSale(undefined, 'cash') — no transaction_id, ever.
    var _kioskGoCash = function () {
      // Mirrors _kioskPushToTerminal's gift-card-state sync (D-05: client-side
      // clamp already applied in the GC panel) — cash may skip the terminal
      // push entirely, so this assignment must happen here too.
      standardSaleBody.gift_card = _kcEnv.getGiftCard()
        ? { cert_number: _kcEnv.getGiftCard().cert_number, amount_applied: _kcEnv.getGiftCard().amount_applied }
        : undefined;
      standardSaleBody.tender = 'cash';
      // WR-02 (70-review): scope the idempotency key to THIS tender attempt.
      // The three tender paths share standardSaleBody; a bare refNumber key meant
      // that aborting a MOTO attempt and switching to cash replayed the cached
      // moto /sale response (no cash:true) and blocked the cash sale. A
      // tender-suffixed key keeps a genuine double-tap of the SAME tender
      // de-duped while letting a tender switch start a clean idempotency scope.
      standardSaleBody.idempotency_key = refNumber + ':cash';

      var cashRemainderDisplay = _kcEnv.getGiftCard()
        ? Math.max(0, Math.round((totals.total - _kcEnv.getGiftCard().amount_applied) * 100) / 100)
        : totals.total;
      if (amountEl) amountEl.textContent = kioskFmt(cashRemainderDisplay);

      var gcPanelElCash = document.getElementById('kiosk-gc-panel');
      if (gcPanelElCash) gcPanelElCash.style.display = 'none';

      if (cancelBtn) {
        cancelBtn.disabled = true; // 70-01: no terminal charge exists to cancel mid-flight
      }

      if (msgEl) msgEl.textContent = 'Processing cash payment...';
      if (spinnerEl) spinnerEl.style.display = '';

      fetch(saleUrl, _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardSaleBody)
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (cancelled || saleCompleted) return;
        if (result.status === 202 && result.data && result.data.cash) {
          confirmSale(undefined, 'cash'); // no transaction_id — cash never charges Helcim
          return;
        }
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (cancelBtn) cancelBtn.disabled = false;
        var cashErrMsg = (result.data && result.data.error) || '';
        _kcReportClientError({
          message: cashErrMsg, http_status: result.status, endpoint: '/api/kiosk/sale'
        });
        kioskShowError('Cash Sale Error', cashErrMsg || 'Failed to record the cash sale.', true);
      })
      .catch(function () {
        if (cancelled || saleCompleted) return;
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (cancelBtn) cancelBtn.disabled = false;
        kioskShowError('Connection Error', 'Could not reach the server. Please try again.', true);
      });
    };

    // 70-02 (KIOSK-MOTO): _kioskGoMoto — sibling to _kioskGoCash /
    // _kioskPushToTerminal, called by the "Phone order / card not present"
    // tender button. POSTs /api/kiosk/sale with tender:'moto'; the server
    // initializes a HelcimPay session in-process and returns checkout_token
    // in the 202 response (NO second /api/payment/initialize fetch — RESEARCH
    // Pattern 2). We then mount Helcim's hosted iframe (appendHelcimPayIframe)
    // so staff key the card into HELCIM'S origin — the PAN never touches our
    // DOM. The origin-validated postMessage listener (module scope) resolves
    // to confirmSale(txnId, 'moto'); the server re-verifies the captured
    // amount before booking (Task 1). Gift-card + moto split works exactly
    // like cash: moto covers the post-gift-card remainder.
    var _kioskGoMoto = function () {
      standardSaleBody.gift_card = _kcEnv.getGiftCard()
        ? { cert_number: _kcEnv.getGiftCard().cert_number, amount_applied: _kcEnv.getGiftCard().amount_applied }
        : undefined;
      standardSaleBody.tender = 'moto';
      // WR-02 (70-review): tender-scoped idempotency key — see _kioskGoCash. A
      // fresh moto attempt after a prior aborted tender starts a clean scope
      // instead of replaying a stale cached response.
      standardSaleBody.idempotency_key = refNumber + ':moto';

      var motoRemainderDisplay = _kcEnv.getGiftCard()
        ? Math.max(0, Math.round((totals.total - _kcEnv.getGiftCard().amount_applied) * 100) / 100)
        : totals.total;
      if (amountEl) amountEl.textContent = kioskFmt(motoRemainderDisplay);

      var gcPanelElMoto = document.getElementById('kiosk-gc-panel');
      if (gcPanelElMoto) gcPanelElMoto.style.display = 'none';

      // Cancel returns to browse — no charge exists until the iframe completes
      // (and its SUCCESS handler is what books). Clear any pending MOTO state.
      if (cancelBtn) {
        cancelBtn.disabled = false;
        cancelBtn.onclick = function () {
          cancelled = true;
          _kcMotoHandlers = null;
          _kcHelcimCheckoutToken = null;
          // 50-04 (T-50-22): cancel is a terminal outcome — clear the guard.
          _kioskEndPaymentAttempt();
          if (typeof removeHelcimPayIframe === 'function') removeHelcimPayIframe();
          kioskShowView('browse');
        };
      }

      if (msgEl) msgEl.textContent = 'Starting phone-order payment...';
      if (spinnerEl) spinnerEl.style.display = '';

      fetch(saleUrl, _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(standardSaleBody)
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (cancelled || saleCompleted) return;
        if (result.status === 202 && result.data && result.data.moto && result.data.checkout_token) {
          if (typeof appendHelcimPayIframe !== 'function') {
            if (spinnerEl) spinnerEl.style.display = 'none';
            if (cancelBtn) cancelBtn.disabled = false;
            kioskShowError('Payment Unavailable',
              'The secure card payment component failed to load. Refresh the kiosk and try again.', true);
            return;
          }
          _kcHelcimCheckoutToken = result.data.checkout_token;
          _kcMotoHandlers = {
            onSuccess: function (txnId) { confirmSale(txnId, 'moto'); },
            onAbort: function () {
              if (spinnerEl) spinnerEl.style.display = 'none';
              if (msgEl) msgEl.textContent = 'Payment cancelled — choose a tender to try again.';
              if (cancelBtn) cancelBtn.disabled = false;
              // Return to tender selection (re-show the panel + the right row).
              var gcPanelReshow = document.getElementById('kiosk-gc-panel');
              if (gcPanelReshow) gcPanelReshow.style.display = '';
              var initialRow = document.getElementById('kgcr-initial-row');
              var appliedRow = document.getElementById('kgcr-applied');
              if (_kcEnv.getGiftCard()) {
                if (appliedRow) appliedRow.style.display = '';
              } else if (initialRow) {
                initialRow.style.display = 'flex';
              }
            }
          };
          if (msgEl) msgEl.textContent = 'Enter the customer’s card in the secure payment window...';
          appendHelcimPayIframe(result.data.checkout_token);
          return;
        }
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (cancelBtn) cancelBtn.disabled = false;
        var motoErrMsg = (result.data && result.data.error) || '';
        _kcReportClientError({
          message: motoErrMsg, http_status: result.status, endpoint: '/api/kiosk/sale'
        });
        kioskShowError('Phone Order Error', motoErrMsg || 'Could not start the phone-order payment.', true);
      })
      .catch(function () {
        if (cancelled || saleCompleted) return;
        if (spinnerEl) spinnerEl.style.display = 'none';
        if (cancelBtn) cancelBtn.disabled = false;
        kioskShowError('Connection Error', 'Could not reach the server. Please try again.', true);
      });
    };

    if (confirmBtn) {
      confirmBtn.onclick = function () {
        if (saleCompleted) return;
        confirmBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        confirmSale('manual-confirm');
      };
    }

    // === Phase 44: Gift Card Tender Panel — inject for non-recipe standard sales only ===
    // For recipe sales, push to terminal immediately (no GC tender on recipe path).
    if (isRecipeSale) {
      _kioskPushToTerminal();
    } else {
      // Inject GC panel between kiosk-payment-items and payment footer
      if (itemsEl && itemsEl.parentNode) {
        var gcPanelEl2 = document.getElementById('kiosk-gc-panel');
        if (!gcPanelEl2) {
          gcPanelEl2 = document.createElement('div');
          gcPanelEl2.id = 'kiosk-gc-panel';
          gcPanelEl2.style.cssText = 'margin:0.75rem 0;padding:0.75rem;border:1px solid #e0e0e0;border-radius:8px;background:#fafafa;';
          itemsEl.parentNode.insertBefore(gcPanelEl2, itemsEl.nextSibling);
        }
        gcPanelEl2.style.display = '';
        gcPanelEl2.innerHTML = [
          '<div id="kgcr-initial-row" style="display:flex;gap:0.5rem;flex-wrap:wrap;">',
          '<button type="button" id="kgcr-open-btn" style="flex:1;min-width:110px;padding:0.5rem 0.75rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.9rem;">Apply Gift Card</button>',
          // 70-01 (KIOSK-CASH): Cash tender button — opens the change-due sub-panel below.
          '<button type="button" id="kgcr-cash-btn" style="flex:1;min-width:110px;padding:0.5rem 0.75rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.9rem;">Cash</button>',
          // 70-02 (KIOSK-MOTO): Phone-order (card-not-present) tender — mounts
          // Helcim\'s hosted iframe; the PAN is keyed into Helcim\'s origin only.
          '<button type="button" id="kgcr-moto-btn" style="flex:1;min-width:110px;padding:0.5rem 0.75rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.9rem;">Phone Order</button>',
          '<button type="button" id="kgcr-skip-btn" style="flex:2;min-width:110px;padding:0.5rem 0.75rem;background:var(--cellar-green,#2e7d32);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">Proceed to Terminal &#x2192;</button>',
          '</div>',
          '<div id="kgcr-form" style="display:none;margin-top:0.5rem;">',
          '<div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;">',
          '<input type="text" id="kgcr-cert" placeholder="GC-000000" autocomplete="off" ',
          'style="flex:1;padding:0.4rem 0.6rem;font-size:1rem;border:1px solid #ccc;border-radius:4px;text-transform:uppercase;" />',
          '<button type="button" id="kgcr-lookup-btn" style="padding:0.4rem 0.8rem;background:#fff;border:1px solid #bbb;border-radius:4px;cursor:pointer;font-size:0.9rem;">Look Up</button>',
          '</div>',
          '<div id="kgcr-balance-info" style="display:none;margin-bottom:0.5rem;padding:0.4rem 0.6rem;background:#f0f4f0;border-radius:4px;font-size:0.9rem;"></div>',
          '<div id="kgcr-amount-wrap" style="display:none;">',
          '<div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center;">',
          '<input type="number" id="kgcr-amount" placeholder="0.00" step="0.01" min="0.01" ',
          'style="flex:1;padding:0.4rem 0.6rem;font-size:1rem;border:1px solid #ccc;border-radius:4px;" />',
          '<button type="button" id="kgcr-confirm-btn" style="padding:0.4rem 0.8rem;background:var(--cellar-green,#2e7d32);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:0.9rem;">Apply</button>',
          '</div>',
          '</div>',
          '<div id="kgcr-error" style="display:none;color:#c00;font-size:0.88rem;margin-bottom:0.4rem;"></div>',
          '<button type="button" id="kgcr-back-btn" style="background:none;border:none;cursor:pointer;color:#666;font-size:0.85rem;padding:0;">&#x2190; Back</button>',
          '</div>',
          '<div id="kgcr-applied" style="display:none;margin-top:0.5rem;">',
          '<div id="kgcr-split-display" style="font-size:0.92rem;padding:0.3rem 0;margin-bottom:0.5rem;"></div>',
          '<div style="display:flex;gap:0.5rem;">',
          '<button type="button" id="kgcr-remove-btn" style="flex:1;padding:0.5rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.85rem;">Remove</button>',
          // 70-01: Cash covers the post-gift-card remainder (split tender).
          '<button type="button" id="kgcr-applied-cash-btn" style="flex:1;padding:0.5rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.85rem;">Cash</button>',
          // 70-02: Phone-order card covers the post-gift-card remainder (split tender).
          '<button type="button" id="kgcr-applied-moto-btn" style="flex:1;padding:0.5rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.85rem;">Phone Order</button>',
          '<button type="button" id="kgcr-proceed-btn" style="flex:2;padding:0.5rem;background:var(--cellar-green,#2e7d32);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">Proceed to Terminal &#x2192;</button>',
          '</div>',
          '</div>',
          // 70-01 (KIOSK-CASH): change-due sub-panel — client-only calculator.
          // tendered/change are NEVER sent to the server; only the sale total
          // (server-recomputed) is booked. Complete is disabled until
          // tendered >= the remainder currently due (post-gift-card, if any).
          '<div id="kgcr-cash-panel" style="display:none;margin-top:0.5rem;">',
          '<div id="kcash-remainder-display" style="font-size:0.92rem;margin-bottom:0.5rem;"></div>',
          '<div style="display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center;">',
          '<label for="kcash-tendered" style="font-size:0.85rem;color:#555;">Tendered</label>',
          '<input type="number" id="kcash-tendered" placeholder="0.00" step="0.01" min="0" ',
          'style="flex:1;padding:0.4rem 0.6rem;font-size:1rem;border:1px solid #ccc;border-radius:4px;" />',
          '</div>',
          '<div id="kcash-change-row" style="font-size:0.95rem;margin-bottom:0.5rem;">Change: <span id="kcash-change">$0.00</span></div>',
          '<div id="kcash-error" style="display:none;color:#c00;font-size:0.88rem;margin-bottom:0.4rem;"></div>',
          '<div style="display:flex;gap:0.5rem;">',
          '<button type="button" id="kcash-back-btn" style="flex:1;padding:0.5rem;background:#fff;border:1px solid #bbb;border-radius:6px;cursor:pointer;font-size:0.85rem;">&#x2190; Back</button>',
          '<button type="button" id="kcash-complete-btn" disabled style="flex:2;padding:0.5rem;background:var(--cellar-green,#2e7d32);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;opacity:0.5;">Complete Sale</button>',
          '</div>',
          '</div>'
        ].join('');

        var _gcLookedUpBalance = 0;
        var gcInitialRow = document.getElementById('kgcr-initial-row');
        var gcForm = document.getElementById('kgcr-form');
        var gcApplied = document.getElementById('kgcr-applied');
        var gcBalanceInfo = document.getElementById('kgcr-balance-info');
        var gcAmountWrap = document.getElementById('kgcr-amount-wrap');
        var gcErrorEl = document.getElementById('kgcr-error');
        var gcSplitDisplay = document.getElementById('kgcr-split-display');
        var gcOpenBtn = document.getElementById('kgcr-open-btn');
        var gcSkipBtn = document.getElementById('kgcr-skip-btn');
        var gcLookupBtn = document.getElementById('kgcr-lookup-btn');
        var gcConfirmBtn = document.getElementById('kgcr-confirm-btn');
        var gcBackBtn = document.getElementById('kgcr-back-btn');
        var gcRemoveBtn = document.getElementById('kgcr-remove-btn');
        var gcProceedBtn = document.getElementById('kgcr-proceed-btn');

        // 70-01 (KIOSK-CASH): cash tender + change-due sub-panel element refs.
        var cashBtn = document.getElementById('kgcr-cash-btn');
        var cashAppliedBtn = document.getElementById('kgcr-applied-cash-btn');
        var cashPanel = document.getElementById('kgcr-cash-panel');
        var cashRemainderDisplayEl = document.getElementById('kcash-remainder-display');
        var cashTenderedInput = document.getElementById('kcash-tendered');
        var cashChangeEl = document.getElementById('kcash-change');
        var cashErrorEl = document.getElementById('kcash-error');
        var cashBackBtn = document.getElementById('kcash-back-btn');
        var cashCompleteBtn = document.getElementById('kcash-complete-btn');
        var _kioskCashRemainder = 0;

        // Recomputes change (display-only, never sent) and toggles Complete's
        // disabled state: enabled only once tendered >= the remainder due.
        var updateCashCompleteState = function () {
          var tendered = parseFloat(cashTenderedInput ? cashTenderedInput.value : 0) || 0;
          var change = Math.round((tendered - _kioskCashRemainder) * 100) / 100;
          if (cashChangeEl) cashChangeEl.textContent = kioskFmt(change > 0 ? change : 0);
          var ok = tendered >= _kioskCashRemainder && _kioskCashRemainder > 0;
          if (cashCompleteBtn) {
            cashCompleteBtn.disabled = !ok;
            cashCompleteBtn.style.opacity = ok ? '1' : '0.5';
          }
        };

        // Opens the change-due sub-panel. cashRemainder is the post-gift-card
        // amount due — totals.total minus any applied gift-card amount.
        var openCashPanel = function () {
          _kioskCashRemainder = _kcEnv.getGiftCard()
            ? Math.max(0, Math.round((totals.total - _kcEnv.getGiftCard().amount_applied) * 100) / 100)
            : totals.total;
          if (gcInitialRow) gcInitialRow.style.display = 'none';
          if (gcApplied) gcApplied.style.display = 'none';
          if (gcForm) gcForm.style.display = 'none';
          if (gcErrorEl) { gcErrorEl.style.display = 'none'; gcErrorEl.textContent = ''; }
          if (cashErrorEl) { cashErrorEl.style.display = 'none'; cashErrorEl.textContent = ''; }
          if (cashRemainderDisplayEl) cashRemainderDisplayEl.textContent = 'Amount due: ' + kioskFmt(_kioskCashRemainder);
          if (cashTenderedInput) cashTenderedInput.value = '';
          if (cashChangeEl) cashChangeEl.textContent = kioskFmt(0);
          updateCashCompleteState();
          if (cashPanel) cashPanel.style.display = '';
          if (cashTenderedInput) cashTenderedInput.focus();
        };

        if (cashBtn) { cashBtn.onclick = openCashPanel; }
        if (cashAppliedBtn) { cashAppliedBtn.onclick = openCashPanel; }

        // 70-02 (KIOSK-MOTO): Phone-order tender buttons (initial row + the
        // gift-card-applied row) both lead straight to the HelcimPay iframe
        // via _kioskGoMoto — there is deliberately NO card-number input.
        var motoBtn = document.getElementById('kgcr-moto-btn');
        var motoAppliedBtn = document.getElementById('kgcr-applied-moto-btn');
        if (motoBtn) { motoBtn.onclick = function () { _kioskGoMoto(); }; }
        if (motoAppliedBtn) { motoAppliedBtn.onclick = function () { _kioskGoMoto(); }; }

        if (cashTenderedInput) {
          cashTenderedInput.oninput = updateCashCompleteState;
          cashTenderedInput.onchange = updateCashCompleteState;
        }

        if (cashBackBtn) {
          cashBackBtn.onclick = function () {
            if (cashPanel) cashPanel.style.display = 'none';
            if (cashErrorEl) { cashErrorEl.style.display = 'none'; cashErrorEl.textContent = ''; }
            if (_kcEnv.getGiftCard()) {
              if (gcApplied) gcApplied.style.display = '';
            } else if (gcInitialRow) {
              gcInitialRow.style.display = 'flex';
            }
          };
        }

        if (cashCompleteBtn) {
          cashCompleteBtn.onclick = function () {
            var tendered = parseFloat(cashTenderedInput ? cashTenderedInput.value : 0) || 0;
            if (tendered < _kioskCashRemainder) {
              if (cashErrorEl) { cashErrorEl.textContent = 'Tendered amount is less than the amount due.'; cashErrorEl.style.display = ''; }
              return;
            }
            cashCompleteBtn.disabled = true;
            if (cashBackBtn) cashBackBtn.disabled = true;
            _kioskGoCash();
          };
        }

        if (gcOpenBtn) {
          gcOpenBtn.onclick = function () {
            if (gcInitialRow) gcInitialRow.style.display = 'none';
            if (gcApplied) gcApplied.style.display = 'none';
            if (gcErrorEl) { gcErrorEl.style.display = 'none'; gcErrorEl.textContent = ''; }
            if (gcBalanceInfo) gcBalanceInfo.style.display = 'none';
            if (gcAmountWrap) gcAmountWrap.style.display = 'none';
            if (gcForm) gcForm.style.display = '';
            var ci = document.getElementById('kgcr-cert');
            if (ci) ci.focus();
          };
        }

        if (gcSkipBtn) {
          gcSkipBtn.onclick = function () { _kcEnv.setGiftCard(null); _kioskPushToTerminal(); };
        }

        if (gcBackBtn) {
          gcBackBtn.onclick = function () {
            if (gcForm) gcForm.style.display = 'none';
            if (gcApplied) gcApplied.style.display = 'none';
            if (gcInitialRow) gcInitialRow.style.display = 'flex';
            if (gcErrorEl) { gcErrorEl.style.display = 'none'; gcErrorEl.textContent = ''; }
          };
        }

        if (gcLookupBtn) {
          gcLookupBtn.onclick = function () {
            var ci = document.getElementById('kgcr-cert');
            var cert2 = ci ? ci.value.trim().toUpperCase() : '';
            if (!cert2) {
              if (gcErrorEl) { gcErrorEl.textContent = 'Enter a certificate number.'; gcErrorEl.style.display = ''; }
              return;
            }
            if (gcErrorEl) { gcErrorEl.style.display = 'none'; gcErrorEl.textContent = ''; }
            if (gcBalanceInfo) gcBalanceInfo.style.display = 'none';
            if (gcAmountWrap) gcAmountWrap.style.display = 'none';
            gcLookupBtn.disabled = true; gcLookupBtn.textContent = 'Looking up...';
            fetch(mwUrl + '/api/kiosk/gift-card/lookup?cert_number=' + encodeURIComponent(cert2), _kcMergeAuth({}))
            .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
            .then(function (res2) {
              gcLookupBtn.disabled = false; gcLookupBtn.textContent = 'Look Up';
              if (res2.status === 404 || !res2.data.ok) {
                if (gcErrorEl) { gcErrorEl.textContent = 'Certificate not found.'; gcErrorEl.style.display = ''; }
                return;
              }
              var d2 = res2.data.data || {};
              if (d2.status && d2.status !== 'active') {
                if (gcErrorEl) { gcErrorEl.textContent = 'Certificate is ' + d2.status + ' and cannot be redeemed.'; gcErrorEl.style.display = ''; }
                return;
              }
              _gcLookedUpBalance = parseFloat(d2.current_balance) || 0;
              if (_gcLookedUpBalance <= 0) {
                if (gcErrorEl) { gcErrorEl.textContent = 'Certificate has a zero balance.'; gcErrorEl.style.display = ''; }
                return;
              }
              if (gcBalanceInfo) {
                gcBalanceInfo.textContent = 'Balance: ' + kioskFmt(_gcLookedUpBalance) +
                  (d2.face_value ? ' (Face: ' + kioskFmt(parseFloat(d2.face_value)) + ')' : '');
                gcBalanceInfo.style.display = '';
              }
              var defAmt = Math.round(Math.min(_gcLookedUpBalance, totals.total) * 100) / 100;
              var ai = document.getElementById('kgcr-amount');
              if (ai) ai.value = defAmt.toFixed(2);
              if (gcAmountWrap) gcAmountWrap.style.display = '';
            })
            .catch(function () {
              gcLookupBtn.disabled = false; gcLookupBtn.textContent = 'Look Up';
              if (gcErrorEl) { gcErrorEl.textContent = 'Lookup failed. Check connection and try again.'; gcErrorEl.style.display = ''; }
            });
          };
        }

        if (gcConfirmBtn) {
          gcConfirmBtn.onclick = function () {
            var ci = document.getElementById('kgcr-cert');
            var ai = document.getElementById('kgcr-amount');
            var cert2 = ci ? ci.value.trim().toUpperCase() : '';
            var applied2 = parseFloat(ai ? ai.value : 0) || 0;
            // D-05: clamp to min(balance, total) client-side; server re-clamps
            applied2 = Math.round(Math.min(applied2, _gcLookedUpBalance, totals.total) * 100) / 100;
            if (applied2 <= 0) {
              if (gcErrorEl) { gcErrorEl.textContent = 'Amount must be greater than zero.'; gcErrorEl.style.display = ''; }
              return;
            }
            _kcEnv.setGiftCard({ cert_number: cert2, amount_applied: applied2, balance: _gcLookedUpBalance });
            var termAmt2 = Math.max(0, Math.round((totals.total - applied2) * 100) / 100);
            if (gcSplitDisplay) {
              gcSplitDisplay.innerHTML = '<strong>Gift Card:</strong> ' + kioskFmt(applied2) +
                (termAmt2 > 0
                  ? ' &nbsp;&nbsp; <strong>Terminal:</strong> ' + kioskFmt(termAmt2)
                  : ' &nbsp;&nbsp; <em>(Full coverage — no terminal charge)</em>');
            }
            if (amountEl) amountEl.textContent = kioskFmt(termAmt2 > 0 ? termAmt2 : totals.total);
            if (gcForm) gcForm.style.display = 'none';
            if (gcInitialRow) gcInitialRow.style.display = 'none';
            if (gcApplied) gcApplied.style.display = '';
            if (gcProceedBtn) gcProceedBtn.textContent = termAmt2 > 0 ? 'Proceed to Terminal →' : 'Complete Gift Card Payment →';
          };
        }

        if (gcRemoveBtn) {
          gcRemoveBtn.onclick = function () {
            _kcEnv.setGiftCard(null);
            if (amountEl) amountEl.textContent = kioskFmt(totals.total);
            if (gcApplied) gcApplied.style.display = 'none';
            if (gcInitialRow) gcInitialRow.style.display = 'flex';
            if (gcErrorEl) { gcErrorEl.style.display = 'none'; gcErrorEl.textContent = ''; }
          };
        }

        if (gcProceedBtn) {
          gcProceedBtn.onclick = function () { _kioskPushToTerminal(); };
        }
      } else {
        // GC panel injection failed (unexpected DOM state) — fall through to terminal immediately
        _kioskPushToTerminal();
      }
    }
  }

  // ===== Batch QR + Label (48-03 Task 1 — transitive dependency of
  // kioskShowReceipt's "Save Label" button; used nowhere else) =====

  function generateBatchQR(batchId, batchAccessToken) {
    var url = window.location.origin + '/batch.html?id=' + encodeURIComponent(batchId) + '&token=' + encodeURIComponent(batchAccessToken);
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr;
  }

  var LABEL_CSS =
    '@page{size:4in 6in;margin:0;}' +
    'body{margin:0;font-family:Arial,Helvetica,sans-serif;}' +
    '.label{width:4in;height:6in;padding:0.2in 0.25in;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;}' +
    '.top-row{display:flex;align-items:center;justify-content:space-between;padding-bottom:5px;border-bottom:1.5px solid #000;margin-bottom:6px;}' +
    '.logo-stack{display:flex;align-items:center;gap:8px;}' +
    '.logo-icon{height:48px;}' +
    '.logo-wordmark{height:20px;}' +
    '.qr-box{width:72px;height:72px;display:flex;align-items:center;justify-content:center;}' +
    '.qr-box svg{width:72px;height:72px;}' +
    '.qr-empty{width:72px;height:72px;border:1.5px solid #000;}' +
    '.batch-id{font-size:15px;font-weight:bold;text-align:center;margin:2px 0 1px;letter-spacing:1px;}' +
    '.product-name{font-size:11px;text-align:center;font-weight:600;margin-bottom:5px;}' +
    '.info-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;font-size:9.5px;line-height:1.5;margin-bottom:4px;}' +
    '.info-grid .lbl{font-weight:bold;text-align:right;white-space:nowrap;}' +
    '.write-line{border-bottom:1px solid #000;min-width:100px;display:inline-block;height:12px;}' +
    '.section-title{font-size:8.5px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin:4px 0 2px;border-bottom:0.5px solid #ccc;padding-bottom:1px;}' +
    '.schedule-wrap{min-height:108px;margin-bottom:4px;}' +
    '.schedule-table{width:100%;border-collapse:collapse;font-size:8.5px;line-height:1.4;}' +
    '.schedule-table td{padding:1px 4px 1px 0;vertical-align:top;}' +
    '.schedule-table td:first-child{white-space:nowrap;font-weight:600;width:52px;}' +
    '.schedule-table td:last-child{color:#555;font-size:8px;text-align:right;white-space:nowrap;}' +
    '.notes-box{border:1px solid #999;border-radius:2px;flex:1;min-height:40px;margin:0 0 6px;position:relative;}' +
    '.notes-box-label{position:absolute;top:-1px;left:4px;font-size:7px;font-weight:bold;color:#000;text-transform:uppercase;background:#fff;padding:0 2px;}' +
    '.agreement{flex-shrink:0;border-top:1px solid #999;padding-top:3px;}' +
    '.agreement-title{font-size:7px;font-weight:bold;text-align:center;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;}' +
    '.agreement-text{font-size:6.5px;line-height:1.35;text-align:justify;color:#333;margin-bottom:4px;}' +
    '.sig-area{display:flex;gap:6px;align-items:flex-end;}' +
    '.sig-block{flex:1;}.sig-block .sig-line{border-bottom:1px solid #000;height:14px;}' +
    '.sig-block .sig-label{font-size:6px;text-align:center;margin-top:1px;color:#555;}' +
    '.sig-block.sm{flex:0.4;}' +
    '.email-row{margin-bottom:4px;}.email-row .sig-line{border-bottom:1px solid #000;height:12px;}' +
    '.email-row .sig-label{font-size:6px;margin-top:1px;color:#555;}';

  var AGREEMENT_TEXT = 'By signing, I request assistance and guidance, as required, in preparing my wine must for fermentation. I acknowledge that by default, Steins &amp; Vines will add a natural shell fish derivative, Chitosan, for the purpose of clearing. I consent to my name, telephone number, address and email (if supplied) being kept in a database with the understanding that this information will not be sold or exchanged. I acknowledge that the wine made for me by Steins &amp; Vines is for my personal use only. I acknowledge that Steins &amp; Vines has transferred ownership of my wine and all ingredients to me.';

  function buildBatchLabelHTML(opts) {
    var b = opts.batch || {};
    var tasks = opts.tasks || [];
    var qrSvg = opts.qrSvg || '';
    var isBlank = opts.blank || false;
    var origin = window.location.origin;

    var iconUrl = origin + '/images/label-icon.png';
    var wordmarkUrl = origin + '/images/label-wordmark.png';

    var h = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
    h += '<title>' + (isBlank ? 'Blank Batch Form' : 'Batch ' + escapeHTML(b.batch_id || '')) + '</title>';
    h += '<style>' + LABEL_CSS + '</style></head><body><div class="label">';

    // Top row: logos + QR
    h += '<div class="top-row"><div class="logo-stack">';
    h += '<img class="logo-icon" src="' + iconUrl + '" alt="">';
    h += '<img class="logo-wordmark" src="' + wordmarkUrl + '" alt="">';
    h += '</div>';
    if (qrSvg) {
      h += '<div class="qr-box">' + qrSvg + '</div>';
    } else if (!isBlank) {
      h += '<div class="qr-empty"></div>';
    }
    h += '</div>';

    // Batch ID + Product
    h += '<div class="batch-id">' + (isBlank ? 'Batch ID: <span class="write-line" style="min-width:140px;"></span>' : escapeHTML(b.batch_id || '')) + '</div>';
    h += '<div class="product-name">' + (isBlank ? 'Kit: <span class="write-line" style="min-width:180px;"></span>' : escapeHTML(b.product_name || b.product_sku || '')) + '</div>';

    // Info grid
    h += '<div class="info-grid">';
    h += '<span class="lbl">Customer:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_name || '')) + '</span>';
    h += '<span class="lbl">Email:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_email || '')) + '</span>';
    h += '<span class="lbl">Phone:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(b.customer_phone || '')) + '</span>';
    h += '<span class="lbl">Start Date:</span><span class="val">' + (isBlank ? '<span class="write-line"></span>' : escapeHTML(String(b.start_date || '').substring(0, 10))) + '</span>';
    var loc = isBlank ? '<span class="write-line"></span>' : escapeHTML([b.shelf_id, b.bin_id, b.vessel_id].filter(Boolean).join(' - ') || '—');
    h += '<span class="lbl">Primary Location:</span><span class="val">' + loc + '</span>';
    h += '<span class="lbl">Transfer 1:</span><span class="val"><span class="write-line"></span></span>';
    h += '<span class="lbl">Transfer 2:</span><span class="val"><span class="write-line"></span></span>';
    h += '<span class="lbl">Transfer 3:</span><span class="val"><span class="write-line"></span></span>';
    h += '</div>';

    // Schedule
    h += '<div class="section-title">Schedule</div>';
    h += '<div class="schedule-wrap"><table class="schedule-table">';

    if (!isBlank && tasks.length > 0) {
      var startMs = b.start_date ? new Date(String(b.start_date).substring(0, 10)).getTime() : 0;
      tasks.forEach(function (t) {
        var dayLabel = '—';
        var dateLabel = '';
        if (t.due_date) {
          var dueStr = String(t.due_date).substring(0, 10);
          dateLabel = dueStr;
          if (startMs) {
            var dayNum = Math.round((new Date(dueStr).getTime() - startMs) / 86400000);
            dayLabel = 'Day ' + (dayNum < 1 ? 1 : dayNum);
          }
        } else {
          dayLabel = 'TBD';
        }
        if (t.step_number === 1 || t.step_number === '1') dayLabel = 'Day 1';
        h += '<tr><td>' + escapeHTML(dayLabel) + '</td>';
        h += '<td>' + escapeHTML(t.title || 'Step ' + t.step_number) + '</td>';
        h += '<td>' + escapeHTML(dateLabel) + '</td></tr>';
      });
    } else {
      h += '<tr><td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;">Day</td>';
      h += '<td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;">Step</td>';
      h += '<td style="font-weight:bold;font-size:7.5px;padding-bottom:2px;text-align:right;">Date</td></tr>';
      for (var i = 0; i < 8; i++) {
        h += '<tr><td style="border-bottom:0.5px solid #ccc;">____</td>';
        h += '<td style="border-bottom:0.5px solid #ccc;">&nbsp;</td>';
        h += '<td style="border-bottom:0.5px solid #ccc;">&nbsp;</td></tr>';
      }
    }
    h += '</table></div>';

    // Notes box
    h += '<div class="notes-box"><span class="notes-box-label">Notes</span></div>';

    // Agreement
    h += '<div class="agreement">';
    h += '<div class="agreement-title">Customer Agreement</div>';
    h += '<div class="agreement-text">' + AGREEMENT_TEXT + '</div>';
    h += '<div class="sig-area">';
    h += '<div class="sig-block"><div class="sig-line"></div><div class="sig-label">Signature</div></div>';
    h += '<div class="sig-block sm"><div class="sig-line"></div><div class="sig-label">Date</div></div>';
    h += '</div></div>';

    h += '</div></body></html>';
    return h;
  }

  // ===== Receipt (48-03 Task 1) =====

  function kioskShowReceipt(saleData, totals, items, batches) {
    // 50-04 (T-50-22): success is a terminal outcome too — both sale-path
    // callers of this function (handleSaleResult, confirmSale's recipe
    // branch) reach here only after a completed attempt.
    _kioskEndPaymentAttempt();
    kioskShowView('receipt');
    batches = batches || [];

    var body = document.getElementById('kiosk-receipt-body');
    if (!body) return;

    var html = '';

    items.forEach(function (it) {
      html += '<div class="kiosk-receipt-row">';
      html += '<span>' + escapeHTML(it.name || '') + ' x' + (it.quantity || 1) + '</span>';
      html += '<span>' + kioskFmt((it.rate || 0) * (it.quantity || 1)) + '</span>';
      html += '</div>';
    });

    if (totals.tax > 0) {
      html += '<div class="kiosk-receipt-row"><span>Tax</span><span>' + kioskFmt(totals.tax) + '</span></div>';
    }

    html += '<div class="kiosk-receipt-row" style="font-weight:700;font-size:1.05rem;">';
    html += '<strong>Total</strong><strong>' + kioskFmt(saleData.total || totals.total) + '</strong>';
    html += '</div>';

    if (saleData.invoice_number) {
      html += '<div class="kiosk-receipt-row"><span>Invoice</span><span>' + saleData.invoice_number + '</span></div>';
    }
    if (saleData.transaction_id) {
      html += '<div class="kiosk-receipt-row"><span>Transaction</span><span style="font-size:0.8rem;font-family:monospace;">' + saleData.transaction_id + '</span></div>';
    }
    if (saleData.auth_code) {
      html += '<div class="kiosk-receipt-row"><span>Auth Code</span><span>' + saleData.auth_code + '</span></div>';
    }
    if (saleData.date) {
      html += '<div class="kiosk-receipt-row"><span>Date</span><span>' + saleData.date + '</span></div>';
    }

    if (batches.length > 0) {
      html += '<div class="kiosk-receipt-batches">';
      html += '<div class="kiosk-receipt-section-title">Batches Created</div>';
      batches.forEach(function (b, i) {
        html += '<div class="kiosk-receipt-batch-row">';
        html += '<span>' + (b.batch_id || '') + '</span>';
        html += '<button type="button" class="btn admin-btn-sm kiosk-save-label-btn" data-batch-idx="' + i + '">Save Label</button>';
        html += '</div>';
      });
      html += '</div>';
    }

    body.innerHTML = html;

    if (batches.length > 0) {
      Array.prototype.forEach.call(body.querySelectorAll('.kiosk-save-label-btn'), function (btn) {
        btn.onclick = function () {
          var idx = parseInt(btn.getAttribute('data-batch-idx'), 10);
          var b = batches[idx];
          if (!b) return;
          var today = new Date().toISOString().slice(0, 10);
          var qrSvg = '';
          if (typeof qrcode !== 'undefined' && b.batch_id && b.access_token) {
            var qr = generateBatchQR(b.batch_id, b.access_token);
            qrSvg = qr.createSvgTag(4);
          }
          var labelHtml = buildBatchLabelHTML({
            batch: {
              batch_id: b.batch_id,
              customer_name: _kcEnv.getCustomer() ? _kcEnv.getCustomer().name : 'Walk-In',
              customer_email: _kcEnv.getCustomer() ? (_kcEnv.getCustomer().email || '') : '',
              start_date: b.start_date || today
            },
            tasks: [],
            qrSvg: qrSvg
          });
          var pw = window.open('', '_blank');
          if (pw) {
            pw.document.write(labelHtml);
            pw.document.close();
            setTimeout(function () { pw.print(); }, 250);
          }
        };
      });
    }

    var newSaleBtn = document.getElementById('kiosk-new-sale-btn');
    if (newSaleBtn) {
      newSaleBtn.onclick = function () {
        kioskLoadProducts(true);
        _kcEnv.setCustomer(null);
        kioskClearImportedSo();
        kioskShowView('browse');
      };
    }
  }

  // ===== Sales Orders / Collect Payment (48-03 Task 2 — dual-cart/SO-import
  // LOGIC lifted verbatim from js/kiosk.js, SC#1: exactly one place. kiosk.js
  // keeps its own SO-browse UI wiring (#kiosk-view-browse-customer et al.),
  // calling into these via KioskCore.* (PATTERNS.md Pitfall 5 scope fence —
  // no SO UI added to admin.html). =====

  function kioskShowCollect() {
    kioskShowView('collect');
    kioskLoadSalesOrders();
  }

  function kioskLoadSalesOrders() {
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      var list = document.getElementById('kiosk-so-list');
      if (list) list.innerHTML = '<p class="kiosk-loading">Middleware URL not configured.</p>';
      return;
    }

    var list = document.getElementById('kiosk-so-list');
    if (list) {
      list.innerHTML = '<div class="kiosk-so-skeleton"><div class="kiosk-so-skeleton-card"></div>' +
        '<div class="kiosk-so-skeleton-card"></div><div class="kiosk-so-skeleton-card"></div></div>';
    }

    fetch(mwUrl + '/api/kiosk/salesorders', _kcMergeAuth({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }))
    .then(function (r) { return r.json(); })
    .then(function (data) {
      _kioskSalesOrders = data.salesorders || [];
      kioskRenderSoChips();
      kioskRenderSoList();
    })
    .catch(function (err) {
      if (list) list.innerHTML = '<p class="kiosk-loading">Could not load sales orders. Check connection and try again.</p>';
    });
  }

  function kioskRenderSoList() {
    var list = document.getElementById('kiosk-so-list');
    if (!list) return;

    // Step 1: Chip filter (client-side, no re-fetch -- per D-09 discretion)
    var chipFiltered = _kioskSalesOrders;
    if (_kioskSoActiveChips.indexOf('all') === -1) {
      chipFiltered = _kioskSalesOrders.filter(function (so) {
        // Map Zoho 'confirmed' status to our 'paid' chip
        var displayStatus = (so.status === 'confirmed' || so.status === 'invoiced') ? 'paid' : so.status;
        return _kioskSoActiveChips.indexOf(displayStatus) !== -1;
      });
    }

    // Step 2: Search filter (existing pattern)
    var searchTerm = (document.getElementById('kiosk-so-search') || {}).value || '';
    searchTerm = searchTerm.toLowerCase().trim();
    var filtered = chipFiltered;
    if (searchTerm) {
      filtered = chipFiltered.filter(function (so) {
        var haystack = ((so.customer_name || '') + ' ' + (so.salesorder_number || '')).toLowerCase();
        return haystack.indexOf(searchTerm) !== -1;
      });
    }

    // Step 3: Empty state
    if (filtered.length === 0) {
      if (_kioskSoActiveChips.indexOf('all') !== -1 && _kioskSalesOrders.length === 0) {
        list.innerHTML = '<div class="kiosk-so-empty"><h3>No sales orders</h3><p>Create a new order to get started.</p></div>';
      } else {
        list.innerHTML = '<div class="kiosk-so-empty"><h3>No orders match this filter</h3><p>Try a different filter or search, or create a new order.</p></div>';
      }
      return;
    }

    // Step 4: Render cards
    var html = '';
    filtered.forEach(function (so) {
      var total = parseFloat(so.total) || 0;
      var balance = parseFloat(so.balance) || 0;
      var displayAmount = balance > 0 ? balance : total;
      var lineItems = so.line_items || [];
      var displayStatus = (so.status === 'confirmed' || so.status === 'invoiced') ? 'paid' : so.status;
      var isActionable = displayStatus === 'open' || displayStatus === 'draft';

      html += '<div class="kiosk-so-card" data-so-id="' + escapeHTML(so.salesorder_id) + '">';
      html += '<div class="kiosk-so-card-header">';
      html += '<span class="kiosk-so-number">' + escapeHTML(so.salesorder_number || '') + '</span>';
      html += '<span class="kiosk-so-balance">' + kioskFmt(displayAmount) + '</span>';
      html += '</div>';
      html += '<div class="kiosk-so-card-body">';
      html += '<span class="kiosk-so-customer">' + escapeHTML(so.customer_name || 'Unknown') + '</span>';
      html += '<span class="kiosk-so-date">' + escapeHTML(so.date || '') + '</span>';
      html += '</div>';

      html += '<div class="kiosk-so-card-detail" data-so-detail="' + escapeHTML(so.salesorder_id) + '" style="display:none;"></div>';
      html += '<button type="button" class="kiosk-so-toggle-btn" data-so-id="' + escapeHTML(so.salesorder_id) + '">View Items &#9662;</button>';

      // Action row (per D-05, D-11)
      html += '<div class="kiosk-so-card-actions">';
      if (isActionable) {
        if (displayAmount > 0) {
          html += '<button type="button" class="btn kiosk-so-pay-btn" data-so-id="' + escapeHTML(so.salesorder_id) + '">';
          html += 'Collect ' + kioskFmt(displayAmount);
          html += '</button>';
        } else {
          html += '<div class="kiosk-so-paid-badge">Paid</div>';
        }
        html += '<button type="button" class="btn-secondary kiosk-so-import-btn" data-so-id="' + escapeHTML(so.salesorder_id) + '">';
        html += 'Import to Cart';
        html += '</button>';
      } else {
        // D-11: closed/paid SO -- Reorder button
        html += '<div class="kiosk-so-paid-badge">' + escapeHTML(displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)) + '</div>';
        html += '<button type="button" class="btn-secondary kiosk-so-reorder-btn" data-so-id="' + escapeHTML(so.salesorder_id) + '">';
        html += 'Reorder Items';
        html += '</button>';
      }
      html += '</div>';

      html += '</div>';
    });

    list.innerHTML = html;

    // Wire pay buttons (existing pattern)
    Array.prototype.forEach.call(list.querySelectorAll('.kiosk-so-pay-btn'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        // 50-04 (D-50-05, T-50-21): disable-on-click primary guard. The
        // in-flight guard inside kioskCollectPayment (_kioskSoPayInFlightId)
        // is the real backstop — this function is reachable from three other
        // non-button call sites too.
        btn.disabled = true;
        kioskCollectPayment(btn.getAttribute('data-so-id'));
      });
    });

    // Wire import buttons (D-01)
    Array.prototype.forEach.call(list.querySelectorAll('.kiosk-so-import-btn'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        kioskImportSoToCart(btn.getAttribute('data-so-id'));
      });
    });

    // Wire reorder buttons (D-11)
    Array.prototype.forEach.call(list.querySelectorAll('.kiosk-so-reorder-btn'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        kioskReorderSo(btn.getAttribute('data-so-id'));
      });
    });

    // Wire view-items toggle buttons
    Array.prototype.forEach.call(list.querySelectorAll('.kiosk-so-toggle-btn'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var soId = btn.getAttribute('data-so-id');
        var detailEl = list.querySelector('[data-so-detail="' + soId + '"]');
        if (!detailEl) return;

        if (detailEl.style.display !== 'none') {
          detailEl.style.display = 'none';
          btn.innerHTML = 'View Items &#9662;';
          return;
        }

        if (detailEl.getAttribute('data-loaded')) {
          detailEl.style.display = '';
          btn.innerHTML = 'Hide Items &#9652;';
          return;
        }

        btn.innerHTML = 'Loading...';
        var mwUrl = _kcEnv.mwUrl;
        fetch(mwUrl + '/api/kiosk/salesorder/' + encodeURIComponent(soId), _kcMergeAuth({
          method: 'GET',
          headers: { 'Content-Type': 'application/json' }
        }))
        .then(function (r) { return r.json(); })
        .then(function (detail) {
          var items = detail.line_items || [];
          if (items.length === 0) {
            detailEl.innerHTML = '<div class="kiosk-so-detail-empty">No line items</div>';
          } else {
            var itemsHtml = '';
            items.forEach(function (li) {
              itemsHtml += '<div class="kiosk-so-detail-row">';
              itemsHtml += '<span class="kiosk-so-detail-name">' + escapeHTML(li.name || '') + '</span>';
              itemsHtml += '<span class="kiosk-so-detail-qty">&times; ' + (li.quantity || 1) + '</span>';
              itemsHtml += '<span class="kiosk-so-detail-rate">' + kioskFmt(li.rate || 0) + '</span>';
              itemsHtml += '</div>';
            });
            detailEl.innerHTML = itemsHtml;
          }
          detailEl.setAttribute('data-loaded', 'true');
          detailEl.style.display = '';
          btn.innerHTML = 'Hide Items &#9652;';
        })
        .catch(function () {
          detailEl.innerHTML = '<div class="kiosk-so-detail-empty">Could not load items</div>';
          detailEl.style.display = '';
          btn.innerHTML = 'View Items &#9662;';
        });
      });
    });
  }

  // ===== Status Chip Filter (D-09, D-10) =====

  function kioskRenderSoChips() {
    Array.prototype.forEach.call(document.querySelectorAll('.kiosk-so-chip'), function (chip) {
      var status = chip.getAttribute('data-status');
      if (_kioskSoActiveChips.indexOf(status) !== -1 ||
          (_kioskSoActiveChips.indexOf('all') !== -1 && status === 'all')) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  function kioskWireSoChips() {
    Array.prototype.forEach.call(document.querySelectorAll('.kiosk-so-chip'), function (chip) {
      chip.addEventListener('click', function () {
        var status = chip.getAttribute('data-status');
        if (status === 'all') {
          _kioskSoActiveChips = ['all'];
        } else {
          var allIdx = _kioskSoActiveChips.indexOf('all');
          if (allIdx !== -1) _kioskSoActiveChips.splice(allIdx, 1);
          var i = _kioskSoActiveChips.indexOf(status);
          if (i !== -1) {
            if (_kioskSoActiveChips.length > 1) _kioskSoActiveChips.splice(i, 1);
          } else {
            _kioskSoActiveChips.push(status);
          }
        }
        kioskRenderSoChips();
        kioskRenderSoList();
      });
    });
  }

  // ===== Import SO to Cart (D-01, D-02, D-03, D-04) =====

  function kioskImportSoToCart(soId) {
    var so = null;
    for (var i = 0; i < _kioskSalesOrders.length; i++) {
      if (_kioskSalesOrders[i].salesorder_id === soId) { so = _kioskSalesOrders[i]; break; }
    }
    if (!so) { showToast('Order not found', 'error'); return; }

    // D-03: confirm if cart non-empty
    if (Object.keys(_kcEnv.getCart()).length > 0) {
      if (!confirm('Replace current cart with items from ' + (so.salesorder_number || '') + '? Current cart will be cleared.')) return;
    }

    if (!_kioskProductsLoaded) {
      showToast('Products are still loading. Please wait and try again.', 'info');
      return;
    }

    showToast('Loading order items...', 'info');

    var mwUrl = _kcEnv.mwUrl;
    fetch(mwUrl + '/api/kiosk/salesorder/' + encodeURIComponent(soId), _kcMergeAuth({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }))
    .then(function (r) { return r.json(); })
    .then(function (detail) {
      var lineItems = detail.line_items || [];
      if (lineItems.length === 0) {
        showToast('This order has no line items to import', 'warning');
        return;
      }

      var newCart = {};
      _kcEnv.setCart(newCart);
      _kcEnv.setDiscount(null);
      var skipped = 0;

      lineItems.forEach(function (li) {
        if (!li.item_id) { skipped++; return; }
        var product = kioskFindProductById(li.item_id);
        if (product) {
          newCart[product.item_id] = { item: product, qty: li.quantity || 1 };
        } else {
          skipped++;
        }
      });

      _kioskImportedSoId = so.salesorder_id;
      _kioskImportedSoNumber = so.salesorder_number || '';
      _kioskImportedSoUpdated = false;

      if (skipped > 0) {
        showToast(skipped + ' item(s) not found in current catalog — skipped', 'warning');
      }

      kioskSyncKitFees();
      kioskRenderCart();
      kioskRenderProducts();
      kioskShowView('browse');
    })
    .catch(function () {
      showToast('Could not load order details — check connection', 'error');
    });
  }

  // ===== Reorder SO (D-11) =====

  function kioskReorderSo(soId) {
    var so = null;
    for (var i = 0; i < _kioskSalesOrders.length; i++) {
      if (_kioskSalesOrders[i].salesorder_id === soId) { so = _kioskSalesOrders[i]; break; }
    }
    if (!so) { showToast('Order not found', 'error'); return; }

    if (!confirm('Create a new order with the same items as ' + (so.salesorder_number || '') + '?')) return;

    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) { showToast('Middleware URL not configured', 'error'); return; }

    showToast('Loading order items...', 'info');

    fetch(mwUrl + '/api/kiosk/salesorder/' + encodeURIComponent(soId), _kcMergeAuth({
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    }))
    .then(function (r) { return r.json(); })
    .then(function (detail) {
      var lineItems = (detail.line_items || []).filter(function (li) { return !!li.item_id; });

      if (lineItems.length === 0) {
        showToast('No items could be copied from this order', 'error');
        return;
      }

      var payload = {
        customer_id: so.customer_id,
        items: lineItems.map(function (li) {
          return { item_id: li.item_id, name: li.name, quantity: li.quantity, rate: li.rate };
        })
      };

      return fetch(mwUrl + '/api/kiosk/salesorder-create', _kcMergeAuth({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }))
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (result) {
        if (result.data && result.data.ok) {
          showToast('New order created: ' + escapeHTML(result.data.salesorder_number || ''), 'success');
          kioskLoadSalesOrders();
        } else {
          showToast((result.data && result.data.error) || 'Could not create order', 'error');
        }
      });
    })
    .catch(function () {
      showToast('Could not create order — network error', 'error');
    });
  }

  // ===== Clear Imported SO State =====

  function kioskClearImportedSo() {
    _kioskImportedSoId = null;
    _kioskImportedSoNumber = null;
    _kioskImportedSoUpdated = false;
  }

  function kioskCollectPayment(soId) {
    var so = null;
    for (var i = 0; i < _kioskSalesOrders.length; i++) {
      if (_kioskSalesOrders[i].salesorder_id === soId) { so = _kioskSalesOrders[i]; break; }
    }
    if (!so) {
      showToast('Sales order not found', 'error');
      return;
    }

    // 50-04 (D-50-05, T-50-21): re-entrancy guard — a double-tap on the SAME
    // order while it is already in flight is a no-op. This function is
    // reachable from four call sites (the imported-SO update/retry forks in
    // kioskProceedToPayment, the .kiosk-so-pay-btn click, the post-SO-create
    // "Save & Pay" flow) — only one of which is covered by a disabled button.
    if (_kioskSoPayInFlightId === soId) return;

    _kioskSoPayingId = soId;
    var balance = parseFloat(so.balance) || 0;
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      showToast('Middleware URL not configured', 'error');
      return;
    }

    if (!_kioskTerminalReady) {
      showToast('POS terminal is not ready. Check terminal status below.', 'error');
      return;
    }

    // Mint the key for THIS order's payment attempt now that it is actually
    // proceeding.
    _kioskSoPayInFlightId = soId;
    _kioskSoPayKey = 'SOPAY-' + soId + '-' + Date.now();

    // Show payment view
    kioskShowView('payment');

    var amountEl = document.getElementById('kiosk-payment-amount');
    var msgEl = document.getElementById('kiosk-terminal-msg');
    var spinnerEl = document.getElementById('kiosk-spinner');
    var itemsEl = document.getElementById('kiosk-payment-items');
    var cancelBtn = document.getElementById('kiosk-cancel-payment');

    if (amountEl) amountEl.textContent = kioskFmt(balance);
    if (msgEl) msgEl.textContent = 'Collecting payment for ' + escapeHTML(so.salesorder_number || '') + '...';
    if (spinnerEl) spinnerEl.style.display = '';

    if (itemsEl) {
      var itemHtml = '<div class="kiosk-payment-item-row"><span>Order</span><span>' + escapeHTML(so.salesorder_number || '') + '</span></div>';
      itemHtml += '<div class="kiosk-payment-item-row"><span>Customer</span><span>' + escapeHTML(so.customer_name || '') + '</span></div>';
      var lineItems = so.line_items || [];
      lineItems.forEach(function (li) {
        itemHtml += '<div class="kiosk-payment-item-row">';
        itemHtml += '<span>' + escapeHTML(li.name || li.description || '') + ' x' + (li.quantity || 1) + '</span>';
        itemHtml += '<span>' + kioskFmt((parseFloat(li.rate) || 0) * (li.quantity || 1)) + '</span>';
        itemHtml += '</div>';
      });
      itemsEl.innerHTML = itemHtml;
    }

    var cancelled = false;
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.onclick = function () {
        cancelled = true;
        // 50-04 (T-50-22): cancel is a terminal outcome — clear the guard so
        // a legitimate retry (or a different order) isn't silently swallowed.
        _kioskSoPayInFlightId = null;
        _kioskSoPayKey = null;
        kioskShowCollect();
      };
    }

    fetch(mwUrl + '/api/kiosk/salesorder-pay', _kcMergeAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesorder_id: soId, idempotency_key: _kioskSoPayKey })
    }))
    .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
    .then(function (result) {
      if (cancelled) return;
      // 50-04 (T-50-22): every branch below — success and every failure
      // routed through kioskShowSoError — is a terminal outcome for THIS
      // order's attempt. Clear FIRST: the retry path in kioskShowSoError
      // re-enters kioskCollectPayment(_kioskSoPayingId) synchronously, so if
      // this guard is still set the retry is silently swallowed and the Pay
      // button appears dead.
      _kioskSoPayInFlightId = null;
      _kioskSoPayKey = null;
      if (spinnerEl) spinnerEl.style.display = 'none';

      if (result.data && result.data.ok) {
        // Show a simplified receipt for SO payment
        kioskShowView('receipt');
        var body = document.getElementById('kiosk-receipt-body');
        if (body) {
          var html = '';
          html += '<div class="kiosk-receipt-row"><span>Order</span><span>' + escapeHTML(result.data.salesorder_number || so.salesorder_number || '') + '</span></div>';
          html += '<div class="kiosk-receipt-row" style="font-weight:700;font-size:1.05rem;">';
          html += '<strong>Amount</strong><strong>' + kioskFmt(result.data.amount || balance) + '</strong>';
          html += '</div>';
          if (result.data.transaction_id) {
            html += '<div class="kiosk-receipt-row"><span>Transaction</span><span style="font-size:0.8rem;font-family:monospace;">' + escapeHTML(result.data.transaction_id) + '</span></div>';
          }
          if (result.data.card_type) {
            html += '<div class="kiosk-receipt-row"><span>Card</span><span>' + escapeHTML(result.data.card_type) + '</span></div>';
          }
          body.innerHTML = html;
        }
        var newSaleBtn = document.getElementById('kiosk-new-sale-btn');
        if (newSaleBtn) {
          newSaleBtn.onclick = function () {
            kioskLoadProducts(true);
            _kioskSoPayingId = null;
            if (_kioskImportedSoId) {
              // D-07: Return to empty cart/product grid after SO payment
              kioskClearImportedSo();
              _kcEnv.setCart({});
              _kcEnv.setDiscount(null);
              kioskRenderCart();
              kioskShowView('browse');
            } else {
              kioskShowCollect();
            }
          };
        }
      } else if (result.status === 402) {
        kioskShowSoError('Payment Declined', result.data.error || 'Card was declined. Please try a different payment method.', true);
      } else if (result.status === 504) {
        kioskShowSoError('Terminal Timeout', result.data.error || 'Terminal did not respond in time. Please try again.', true);
      } else if (result.data && result.data.payment_voided) {
        kioskShowSoError('Payment Voided',
          'Your payment was automatically reversed. No charge was made to the customer.',
          true, { txnId: result.data.voided_transaction_id || '' });
      } else {
        kioskShowSoError('Payment Error', (result.data && result.data.error) || 'An error occurred. Please try again.', true);
      }
    })
    .catch(function () {
      if (cancelled) return;
      // 50-04 (T-50-22): network failure never reaches the .then() clear
      // above — clear here too, or a connection error bricks SO-pay retries.
      _kioskSoPayInFlightId = null;
      _kioskSoPayKey = null;
      if (spinnerEl) spinnerEl.style.display = 'none';
      kioskShowSoError('Connection Error', 'Could not reach the payment server. Please try again.', true);
    });
  }

  function kioskShowSoError(title, msg, canRetry, extra) {
    // 50-04 (T-50-22): belt-and-suspenders — also release the sale-path
    // guard here. kioskShowSoError is reached both from inside
    // kioskCollectPayment (already cleared above) AND from the imported-SO
    // update/retry forks in kioskProceedToPayment BEFORE kioskCollectPayment
    // is ever entered, where only the sale-path flag was set. Harmless no-op
    // when either guard is already clear.
    _kioskEndPaymentAttempt();
    _kioskSoPayInFlightId = null;
    _kioskSoPayKey = null;
    kioskShowView('error');

    var titleEl = document.getElementById('kiosk-error-title');
    var msgEl = document.getElementById('kiosk-error-msg');
    var retryBtn = document.getElementById('kiosk-retry-btn');
    var backBtn = document.getElementById('kiosk-back-btn');
    var detailEl = document.getElementById('kiosk-error-detail');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = msg;

    if (detailEl) {
      if (extra && extra.txnId) {
        detailEl.textContent = 'Ref: ' + extra.txnId;
        detailEl.style.display = '';
      } else {
        detailEl.style.display = 'none';
      }
    }

    if (retryBtn) {
      retryBtn.style.display = canRetry ? '' : 'none';
      retryBtn.onclick = function () {
        if (_kioskSoPayingId) {
          kioskCollectPayment(_kioskSoPayingId);
        } else {
          kioskShowCollect();
        }
      };
    }

    if (backBtn) {
      backBtn.textContent = 'Back to Orders';
      backBtn.onclick = function () {
        _kioskSoPayingId = null;
        kioskShowCollect();
      };
    }
  }

  // ===== Create Sales Order =====

  function kioskShowCreateSo() {
    kioskShowView('create-so');
    _kioskSoItems = [];
    _kioskSoCustomer = null;

    // Reset UI
    var custSearch = document.getElementById('kiosk-so-customer-search');
    var custDropdown = document.getElementById('kiosk-so-customer-dropdown');
    var custInfo = document.getElementById('kiosk-so-customer-info');
    var itemSearch = document.getElementById('kiosk-so-item-search');
    var itemDropdown = document.getElementById('kiosk-so-item-dropdown');
    var itemsList = document.getElementById('kiosk-so-items-list');
    var totalEl = document.getElementById('kiosk-so-total');
    var notesEl = document.getElementById('kiosk-so-notes');

    if (custSearch) custSearch.value = '';
    if (custDropdown) { custDropdown.style.display = 'none'; custDropdown.innerHTML = ''; }
    if (custInfo) { custInfo.style.display = 'none'; custInfo.innerHTML = ''; }
    if (itemSearch) itemSearch.value = '';
    if (itemDropdown) { itemDropdown.style.display = 'none'; itemDropdown.innerHTML = ''; }
    if (itemsList) itemsList.innerHTML = '';
    if (totalEl) totalEl.textContent = '$0.00';
    if (notesEl) notesEl.value = '';

    // Ensure products are loaded
    if (!_kioskProductsLoaded && !_kioskProductsLoading) {
      kioskLoadProducts();
    }

    // Wire customer search
    var custTimer = null;
    if (custSearch) {
      custSearch.oninput = function () {
        clearTimeout(custTimer);
        var q = custSearch.value.trim();
        if (!q) { if (custDropdown) custDropdown.style.display = 'none'; return; }
        custTimer = setTimeout(function () {
          var mwUrl = _kcEnv.mwUrl;
          fetch(mwUrl + '/api/contacts/search?q=' + encodeURIComponent(q), _kcMergeAuth({}))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!custDropdown) return;
            var contacts = (data.contacts || []).slice(0, 8);
            if (!contacts.length) {
              custDropdown.innerHTML = '<div class="kiosk-dropdown-item" style="color:var(--ink-muted);">No results</div>';
              custDropdown.style.display = '';
              return;
            }
            var html = '';
            contacts.forEach(function (c) {
              html += '<div class="kiosk-dropdown-item" data-cid="' + escapeHTML(c.contact_id || '') + '" data-name="' + escapeHTML(c.contact_name || c.name || '') + '" data-email="' + escapeHTML(c.email || '') + '">';
              html += '<strong>' + escapeHTML(c.contact_name || c.name || '') + '</strong>';
              if (c.email) html += ' <span style="color:var(--ink-tertiary);">' + escapeHTML(c.email) + '</span>';
              html += '</div>';
            });
            custDropdown.innerHTML = html;
            custDropdown.style.display = '';
            Array.prototype.forEach.call(custDropdown.querySelectorAll('.kiosk-dropdown-item'), function (item) {
              item.addEventListener('click', function () {
                _kioskSoCustomer = {
                  contact_id: item.getAttribute('data-cid'),
                  name: item.getAttribute('data-name'),
                  email: item.getAttribute('data-email')
                };
                custDropdown.style.display = 'none';
                custSearch.value = '';
                kioskRenderSoCustomerInfo();
              });
            });
          })
          .catch(function () {
            if (custDropdown) {
              custDropdown.innerHTML = '<div class="kiosk-dropdown-item" style="color:var(--ink-muted);">Search failed</div>';
              custDropdown.style.display = '';
            }
          });
        }, 300);
      };
    }

    // Wire item search
    if (itemSearch) {
      itemSearch.oninput = function () {
        var q = itemSearch.value.trim().toLowerCase();
        if (!q) { if (itemDropdown) itemDropdown.style.display = 'none'; return; }
        var matches = _kioskProducts.filter(function (p) {
          var haystack = ((p.name || '') + ' ' + (p.sku || '')).toLowerCase();
          return haystack.indexOf(q) !== -1;
        }).slice(0, 10);
        if (!itemDropdown) return;
        if (!matches.length) {
          itemDropdown.innerHTML = '<div class="kiosk-dropdown-item" style="color:var(--ink-muted);">No products found</div>';
          itemDropdown.style.display = '';
          return;
        }
        var html = '';
        matches.forEach(function (p) {
          html += '<div class="kiosk-dropdown-item" data-item-id="' + escapeHTML(p.item_id) + '">';
          html += escapeHTML(p.name || '') + ' <span style="color:var(--ink-tertiary);">' + kioskFmt(parseFloat(p.rate) || 0) + '</span>';
          html += '</div>';
        });
        itemDropdown.innerHTML = html;
        itemDropdown.style.display = '';
        Array.prototype.forEach.call(itemDropdown.querySelectorAll('.kiosk-dropdown-item'), function (item) {
          item.addEventListener('click', function () {
            var itemId = item.getAttribute('data-item-id');
            var product = null;
            var soProducts = _kioskProducts;
            for (var i = 0; i < soProducts.length; i++) {
              if (soProducts[i].item_id === itemId) { product = soProducts[i]; break; }
            }
            if (product) kioskAddSoItem(product);
            itemDropdown.style.display = 'none';
            itemSearch.value = '';
          });
        });
      };
    }

    // Wire footer buttons
    var backBtn = document.getElementById('kiosk-create-so-back');
    var saveBtn = document.getElementById('kiosk-create-so-save');
    var payBtn = document.getElementById('kiosk-create-so-pay');

    if (backBtn) backBtn.onclick = function () { kioskShowCollect(); };
    if (saveBtn) saveBtn.onclick = function () { kioskCreateSalesOrder(false); };
    if (payBtn) payBtn.onclick = function () { kioskCreateSalesOrder(true); };
  }

  function kioskRenderSoCustomerInfo() {
    var custInfo = document.getElementById('kiosk-so-customer-info');
    if (!custInfo) return;
    if (!_kioskSoCustomer) {
      custInfo.style.display = 'none';
      custInfo.innerHTML = '';
      return;
    }
    custInfo.style.display = '';
    custInfo.innerHTML = '<div class="kiosk-so-customer-selected">' +
      '<span>' + escapeHTML(_kioskSoCustomer.name || '') +
      (_kioskSoCustomer.email ? ' &mdash; ' + escapeHTML(_kioskSoCustomer.email) : '') +
      '</span>' +
      '<button type="button" class="kiosk-so-customer-clear" id="kiosk-so-clear-customer">&times;</button>' +
      '</div>';
    var clearBtn = document.getElementById('kiosk-so-clear-customer');
    if (clearBtn) {
      clearBtn.onclick = function () {
        _kioskSoCustomer = null;
        kioskRenderSoCustomerInfo();
      };
    }
  }

  function kioskAddSoItem(product) {
    var existing = null;
    for (var i = 0; i < _kioskSoItems.length; i++) {
      if (_kioskSoItems[i].item_id === product.item_id) { existing = _kioskSoItems[i]; break; }
    }
    if (existing) {
      existing.quantity += 1;
    } else {
      _kioskSoItems.push({
        item_id: product.item_id,
        name: product.name || '',
        rate: parseFloat(product.rate) || 0,
        quantity: 1
      });
    }
    kioskRenderSoItems();
  }

  function kioskRemoveSoItem(itemId) {
    _kioskSoItems = _kioskSoItems.filter(function (it) { return it.item_id !== itemId; });
    kioskRenderSoItems();
  }

  function kioskRenderSoItems() {
    var listEl = document.getElementById('kiosk-so-items-list');
    var totalEl = document.getElementById('kiosk-so-total');
    if (!listEl) return;

    if (_kioskSoItems.length === 0) {
      listEl.innerHTML = '<p style="color:var(--ink-muted);font-size:0.9rem;padding:0.5rem 0;">No items added yet.</p>';
      if (totalEl) totalEl.textContent = '$0.00';
      return;
    }

    var total = 0;
    var html = '';
    _kioskSoItems.forEach(function (it) {
      var lineTotal = (parseFloat(it.rate) || 0) * (it.quantity || 1);
      total += lineTotal;
      html += '<div class="kiosk-so-item-row">';
      html += '<div class="kiosk-so-item-name">' + escapeHTML(it.name) + '</div>';
      html += '<div class="kiosk-so-item-controls">';
      html += '<button type="button" class="kiosk-qty-btn kiosk-so-qty-dec" data-item-id="' + escapeHTML(it.item_id) + '">-</button>';
      html += '<span class="kiosk-qty-val">' + it.quantity + '</span>';
      html += '<button type="button" class="kiosk-qty-btn kiosk-so-qty-inc" data-item-id="' + escapeHTML(it.item_id) + '">+</button>';
      html += '<span class="kiosk-so-item-total">' + kioskFmt(lineTotal) + '</span>';
      html += '<button type="button" class="kiosk-so-item-remove" data-item-id="' + escapeHTML(it.item_id) + '">&times;</button>';
      html += '</div>';
      html += '</div>';
    });
    listEl.innerHTML = html;
    if (totalEl) totalEl.textContent = kioskFmt(total);

    // Wire qty buttons
    Array.prototype.forEach.call(listEl.querySelectorAll('.kiosk-so-qty-dec'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-item-id');
        for (var i = 0; i < _kioskSoItems.length; i++) {
          if (_kioskSoItems[i].item_id === id) {
            _kioskSoItems[i].quantity -= 1;
            if (_kioskSoItems[i].quantity <= 0) { _kioskSoItems.splice(i, 1); }
            break;
          }
        }
        kioskRenderSoItems();
      });
    });

    Array.prototype.forEach.call(listEl.querySelectorAll('.kiosk-so-qty-inc'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-item-id');
        for (var i = 0; i < _kioskSoItems.length; i++) {
          if (_kioskSoItems[i].item_id === id) { _kioskSoItems[i].quantity += 1; break; }
        }
        kioskRenderSoItems();
      });
    });

    Array.prototype.forEach.call(listEl.querySelectorAll('.kiosk-so-item-remove'), function (btn) {
      btn.addEventListener('click', function () {
        kioskRemoveSoItem(btn.getAttribute('data-item-id'));
      });
    });
  }

  function kioskCreateSalesOrder(andPay) {
    if (!_kioskSoCustomer) {
      showToast('Please select a customer', 'error');
      return;
    }
    if (_kioskSoItems.length === 0) {
      showToast('Please add at least one item', 'error');
      return;
    }

    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) {
      showToast('Middleware URL not configured', 'error');
      return;
    }

    if (andPay && !_kioskTerminalReady) {
      showToast('POS terminal is not ready. Check terminal status below.', 'error');
      return;
    }

    var saveBtn = document.getElementById('kiosk-create-so-save');
    var payBtn = document.getElementById('kiosk-create-so-pay');
    if (saveBtn) saveBtn.disabled = true;
    if (payBtn) payBtn.disabled = true;

    var notesEl = document.getElementById('kiosk-so-notes');
    var notes = notesEl ? notesEl.value.trim() : '';

    var payload = {
      customer_id: _kioskSoCustomer.contact_id,
      items: _kioskSoItems.map(function (it) {
        return { item_id: it.item_id, name: it.name, quantity: it.quantity, rate: it.rate };
      }),
      notes: notes
    };

    fetch(mwUrl + '/api/kiosk/salesorder-create', _kcMergeAuth({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }))
    .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
    .then(function (result) {
      if (saveBtn) saveBtn.disabled = false;
      if (payBtn) payBtn.disabled = false;

      if (result.data && result.data.ok) {
        if (andPay) {
          // Inject the new SO into local list so kioskCollectPayment can find it
          var newSo = {
            salesorder_id: result.data.salesorder_id,
            salesorder_number: result.data.salesorder_number || '',
            customer_name: _kioskSoCustomer ? _kioskSoCustomer.name : '',
            balance: result.data.balance || result.data.total || 0,
            total: result.data.total || 0,
            date: new Date().toISOString().slice(0, 10),
            line_items: _kioskSoItems.map(function (it) {
              return { name: it.name, quantity: it.quantity, rate: it.rate };
            })
          };
          _kioskSalesOrders.unshift(newSo);
          kioskCollectPayment(result.data.salesorder_id);
        } else {
          showToast('Order ' + (result.data.salesorder_number || '') + ' created', 'success');
          kioskShowCollect();
        }
      } else {
        showToast((result.data && result.data.error) || 'Could not create order', 'error');
      }
    })
    .catch(function () {
      if (saveBtn) saveBtn.disabled = false;
      if (payBtn) payBtn.disabled = false;
      showToast('Could not create order — network error', 'error');
    });
  }

  // ===== Discount display (Task 1 — kioskCalcTotals/kioskRenderCart/kioskClearCart
  // above all call kioskUpdateDiscountDisplay directly, so it and its own
  // calcDiscountAmount dependency move here; the rest of the discount
  // subsystem — preset CRUD, popover, management modal — is 48-02 Task 2) =====

  function kioskUpdateDiscountDisplay() {
    var btn = document.getElementById('kiosk-discount-btn');
    var applied = document.getElementById('kiosk-discount-applied');
    var nameEl = document.getElementById('kiosk-discount-applied-name');
    var amountEl = document.getElementById('kiosk-discount-applied-amount');
    var discountRow = document.getElementById('kiosk-discount-total-row');
    var discountLabel = document.getElementById('kiosk-discount-total-label');
    var discountAmount = document.getElementById('kiosk-discount-total-amount');
    var discount = _kcEnv.getDiscount();

    if (discount) {
      if (btn) btn.style.display = 'none';
      if (applied) applied.style.display = '';
      if (nameEl) nameEl.textContent = discount.name;

      var savings = kioskCalcDiscountAmount();
      if (amountEl) amountEl.textContent = '-' + kioskFmt(savings);
      if (discountRow) discountRow.style.display = '';
      if (discountLabel) discountLabel.textContent = 'Discount: ' + discount.name;
      if (discountAmount) discountAmount.textContent = '-' + kioskFmt(savings);
    } else {
      if (btn) { btn.style.display = ''; btn.disabled = kioskCartIsEmpty(); }
      if (applied) applied.style.display = 'none';
      if (discountRow) discountRow.style.display = 'none';
    }
  }

  function kioskCalcDiscountAmount() {
    if (!_kcEnv.getDiscount()) return 0;
    return kioskCalcTotals().discount;
  }

  // ===== Discount System (48-02 Task 2 — D-04: product-type discount subsystem,
  // moves into core so the admin-embedded kiosk gets it for free) =====

  function kioskLoadDiscountPresets() {
    var mwUrl = _kcEnv.mwUrl;
    if (!mwUrl) return;
    fetch(mwUrl + '/api/kiosk/discounts', _kcMergeAuth({}))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _kioskDiscountPresets = (data.discounts || []).filter(function (d) { return d.active; });
      })
      .catch(function () {});
  }

  function kioskShowDiscountPopover() {
    var popover = document.getElementById('kiosk-discount-popover');
    var list = document.getElementById('kiosk-discount-preset-list');
    if (!popover || !list) return;

    var html = '';
    _kioskDiscountPresets.forEach(function (p) {
      var detail = p.type === 'percentage' ? (p.value + '% off') : ('$' + parseFloat(p.value).toFixed(2) + ' off');
      detail += ' (' + kioskDiscountScopeLabel(p) + ')';
      html += '<div class="kiosk-discount-preset-row" data-preset-id="' + escapeHTML(p.id) + '">';
      html += '<span class="kiosk-discount-preset-name">' + escapeHTML(p.name) + '</span>';
      html += '<span class="kiosk-discount-preset-detail">' + detail + '</span>';
      html += '</div>';
    });
    if (!_kioskDiscountPresets.length) {
      html = '<div style="padding:1rem;color:var(--ink-tertiary);text-align:center;">No presets configured</div>';
    }
    list.innerHTML = html;

    list.querySelectorAll('.kiosk-discount-preset-row').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-preset-id');
        var preset = null;
        for (var i = 0; i < _kioskDiscountPresets.length; i++) {
          if (_kioskDiscountPresets[i].id === id) { preset = _kioskDiscountPresets[i]; break; }
        }
        if (preset) kioskApplyDiscount(preset);
      });
    });

    popover.style.display = '';
  }

  function kioskApplyDiscount(preset) {
    _kcEnv.setDiscount({
      presetId: preset.id,
      name: preset.name,
      type: preset.type,
      value: preset.value,
      scope: preset.scope,
      applies_to: preset.applies_to || null
    });

    document.getElementById('kiosk-discount-popover').style.display = 'none';
    kioskRefreshAfterDiscountChange();
  }

  function kioskRemoveDiscount() {
    _kcEnv.setDiscount(null);
    kioskRefreshAfterDiscountChange();
  }

  // Recompute the displayed total after a discount changes. For recipe carts the
  // discount is server-authoritative, so re-fetch the (discount-aware) quote first.
  function kioskRefreshAfterDiscountChange() {
    if (_kioskSelectedRecipe && typeof kioskFetchRecipeQuote === 'function') {
      var p = kioskFetchRecipeQuote();
      if (p && typeof p.then === 'function') {
        p.then(function () { kioskUpdateDiscountDisplay(); kioskRenderCart(); });
        return;
      }
    }
    kioskUpdateDiscountDisplay();
    kioskRenderCart();
  }

  // Collect the selected applies_to tokens from the two-tier checkbox panel.
  // A fully-selected group collapses to its group token ('kit'/'ingredient').
  function kioskCollectAppliesTo() {
    var panel = document.getElementById('kiosk-discount-types');
    if (!panel) return [];
    var tokens = [];
    panel.querySelectorAll('input[data-group]').forEach(function (parent) {
      var group = parent.getAttribute('data-group');
      if (parent.checked) {
        tokens.push(group);
      } else {
        panel.querySelectorAll('input[data-token]').forEach(function (c) {
          if (c.getAttribute('data-token').indexOf(group + ':') === 0 && c.checked) {
            tokens.push(c.getAttribute('data-token'));
          }
        });
      }
    });
    panel.querySelectorAll('input[data-token]').forEach(function (c) {
      var t = c.getAttribute('data-token');
      if (t.indexOf(':') === -1 && c.checked) tokens.push(t); // service / recipe
    });
    return tokens;
  }

  // Load an existing preset into the Add/Edit form for editing.
  function kioskPopulateDiscountForm(preset) {
    var modal = document.getElementById('kiosk-discount-mgmt-modal');
    var form = document.getElementById('kiosk-discount-form');
    if (!modal || !form || !preset) return;

    _kioskEditingDiscountId = preset.id;
    document.getElementById('kiosk-discount-form-name').value = preset.name || '';
    document.getElementById('kiosk-discount-form-value').value = preset.value != null ? preset.value : ''; // eslint-disable-line eqeqeq -- intentional loose equality to match both null and undefined

    modal.querySelectorAll('.kiosk-discount-type-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-type') === (preset.type || 'percentage'));
    });
    var scope = (preset.scope === 'type') ? 'type' : 'cart';
    modal.querySelectorAll('.kiosk-discount-scope-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-scope') === scope);
    });

    var tp = document.getElementById('kiosk-discount-types');
    if (tp) {
      tp.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.checked = false; });
      tp.style.display = (scope === 'type') ? '' : 'none';
      if (scope === 'type') {
        var at = preset.applies_to || [];
        // Group tokens (kit/ingredient) tick the parent + all its children.
        at.forEach(function (tok) {
          var parent = tp.querySelector('input[data-group="' + tok + '"]');
          if (parent) {
            parent.checked = true;
            tp.querySelectorAll('input[data-token]').forEach(function (c) {
              if (c.getAttribute('data-token').indexOf(tok + ':') === 0) c.checked = true;
            });
          }
          var leaf = tp.querySelector('input[data-token="' + tok + '"]');
          if (leaf) leaf.checked = true;
        });
        // Reflect "all children selected" back onto each parent checkbox.
        tp.querySelectorAll('input[data-group]').forEach(function (parent) {
          var group = parent.getAttribute('data-group');
          var all = true, any = false;
          tp.querySelectorAll('input[data-token]').forEach(function (c) {
            if (c.getAttribute('data-token').indexOf(group + ':') === 0) { any = true; if (!c.checked) all = false; }
          });
          if (any) parent.checked = all;
        });
      }
    }

    form.style.display = '';
    var addBtn = document.getElementById('kiosk-discount-add-btn');
    if (addBtn) addBtn.style.display = 'none';
    var saveBtn = document.getElementById('kiosk-discount-save-btn');
    if (saveBtn) saveBtn.textContent = 'Update';
  }

  // Human-readable summary of a preset's targeting (for popover + mgmt list).
  function kioskDiscountScopeLabel(p) {
    if (!p || p.scope !== 'type') return 'Cart';
    var at = p.applies_to || [];
    if (!at.length) return 'Types';
    var labelMap = {
      kit: 'All Kits', ingredient: 'All Ingredients', service: 'Services', recipe: 'Recipes',
      'kit:wine': 'Wine', 'kit:beer': 'Beer', 'kit:cider': 'Cider', 'kit:seltzer': 'Seltzer',
      'ingredient:hops': 'Hops', 'ingredient:grain': 'Grain', 'ingredient:yeast': 'Yeast',
      'ingredient:additive': 'Additive', 'ingredient:packaging': 'Packaging',
      'ingredient:equipment': 'Equipment', 'ingredient:cleaning': 'Cleaning'
    };
    return at.map(function (t) { return labelMap[t] || t; }).join(', ');
  }

  function kioskShowDiscountMgmt() {
    var modal = document.getElementById('kiosk-discount-mgmt-modal');
    if (!modal) return;
    modal.style.display = '';
    kioskRenderDiscountMgmtList();

    var closeBtn = document.getElementById('kiosk-discount-mgmt-close');
    if (closeBtn) closeBtn.onclick = function () { modal.style.display = 'none'; };

    var addBtn = document.getElementById('kiosk-discount-add-btn');
    var form = document.getElementById('kiosk-discount-form');
    if (addBtn && form) {
      addBtn.onclick = function () {
        _kioskEditingDiscountId = null; // creating a new preset
        var sb = document.getElementById('kiosk-discount-save-btn');
        if (sb) sb.textContent = 'Save';
        form.style.display = '';
        addBtn.style.display = 'none';
        document.getElementById('kiosk-discount-form-name').value = '';
        document.getElementById('kiosk-discount-form-value').value = '';
        // Reset scope to "Whole Cart" and clear the type checkboxes
        modal.querySelectorAll('.kiosk-discount-scope-btn').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-scope') === 'cart');
        });
        var tp = document.getElementById('kiosk-discount-types');
        if (tp) {
          tp.style.display = 'none';
          tp.querySelectorAll('input[type="checkbox"]').forEach(function (c) { c.checked = false; });
        }
        // Reset type to percentage
        modal.querySelectorAll('.kiosk-discount-type-btn').forEach(function (b) {
          b.classList.toggle('active', b.getAttribute('data-type') === 'percentage');
        });
      };
    }

    var typeBtns = modal.querySelectorAll('.kiosk-discount-type-btn');
    typeBtns.forEach(function (btn) {
      btn.onclick = function () {
        typeBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
      };
    });

    var typesPanel = document.getElementById('kiosk-discount-types');
    var scopeBtns = modal.querySelectorAll('.kiosk-discount-scope-btn');
    scopeBtns.forEach(function (btn) {
      btn.onclick = function () {
        scopeBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        if (typesPanel) typesPanel.style.display = (btn.getAttribute('data-scope') === 'type') ? '' : 'none';
      };
    });

    // Two-tier checkbox sync: a parent ("All Kits"/"All Ingredients") toggles its
    // children; unchecking a child unchecks the parent.
    if (typesPanel) {
      typesPanel.querySelectorAll('input[data-group]').forEach(function (parent) {
        var group = parent.getAttribute('data-group');
        parent.onchange = function () {
          typesPanel.querySelectorAll('input[data-token]').forEach(function (c) {
            if (c.getAttribute('data-token').indexOf(group + ':') === 0) c.checked = parent.checked;
          });
        };
      });
      typesPanel.querySelectorAll('input[data-token]').forEach(function (c) {
        var t = c.getAttribute('data-token');
        if (t.indexOf(':') === -1) return; // single tokens (service/recipe) have no parent
        var group = t.split(':')[0];
        c.onchange = function () {
          var parent = typesPanel.querySelector('input[data-group="' + group + '"]');
          if (!parent) return;
          var all = true;
          typesPanel.querySelectorAll('input[data-token]').forEach(function (cc) {
            if (cc.getAttribute('data-token').indexOf(group + ':') === 0 && !cc.checked) all = false;
          });
          parent.checked = all;
        };
      });
    }

    var saveBtn = document.getElementById('kiosk-discount-save-btn');
    if (saveBtn) {
      saveBtn.onclick = function () {
        var name = (document.getElementById('kiosk-discount-form-name').value || '').trim();
        var value = parseFloat(document.getElementById('kiosk-discount-form-value').value);
        var typeBtn = modal.querySelector('.kiosk-discount-type-btn.active');
        var scopeBtn = modal.querySelector('.kiosk-discount-scope-btn.active');
        var type = typeBtn ? typeBtn.getAttribute('data-type') : 'percentage';
        var scope = scopeBtn ? scopeBtn.getAttribute('data-scope') : 'cart';

        if (!name) { showToast('Enter a discount name', 'error'); return; }
        if (!isFinite(value) || value <= 0) { showToast('Enter a valid value', 'error'); return; }
        if (type === 'percentage' && value > 100) { showToast('Percentage cannot exceed 100%', 'error'); return; }

        var payload = { name: name, type: type, value: value, scope: scope };
        if (scope === 'type') {
          payload.applies_to = kioskCollectAppliesTo();
          if (!payload.applies_to.length) { showToast('Pick at least one product type', 'error'); return; }
        }

        var mwUrl = _kcEnv.mwUrl;
        var editingId = _kioskEditingDiscountId;
        var url = editingId
          ? mwUrl + '/api/kiosk/discounts/' + encodeURIComponent(editingId)
          : mwUrl + '/api/kiosk/discounts';
        fetch(url, _kcMergeAuth({
          method: editingId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.ok) {
            showToast(editingId ? 'Preset updated' : 'Preset saved', 'success');
            _kioskEditingDiscountId = null;
            saveBtn.textContent = 'Save';
            kioskLoadDiscountPresets();
            form.style.display = 'none';
            document.getElementById('kiosk-discount-add-btn').style.display = '';
            kioskRenderDiscountMgmtList();
            setTimeout(function () { kioskRenderDiscountMgmtList(); }, 500);
          } else {
            showToast(data.error || 'Failed to save', 'error');
          }
        })
        .catch(function () { showToast('Network error', 'error'); });
      };
    }

    var cancelFormBtn = document.getElementById('kiosk-discount-cancel-btn');
    if (cancelFormBtn) {
      cancelFormBtn.onclick = function () {
        _kioskEditingDiscountId = null;
        var sb = document.getElementById('kiosk-discount-save-btn');
        if (sb) sb.textContent = 'Save';
        form.style.display = 'none';
        document.getElementById('kiosk-discount-add-btn').style.display = '';
      };
    }
  }

  function kioskRenderDiscountMgmtList() {
    var list = document.getElementById('kiosk-discount-mgmt-list');
    if (!list) return;

    var mwUrl = _kcEnv.mwUrl;
    fetch(mwUrl + '/api/kiosk/discounts', _kcMergeAuth({}))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.discounts || [];
        _kioskDiscountPresets = presets.filter(function (d) { return d.active; });

        if (!presets.length) {
          list.innerHTML = '<p style="padding:0.75rem 0;color:var(--ink-tertiary);text-align:center;">No presets yet</p>';
          return;
        }

        var html = '';
        presets.forEach(function (p) {
          var detail = p.type === 'percentage' ? (p.value + '%') : ('$' + parseFloat(p.value).toFixed(2));
          detail += ' · ' + kioskDiscountScopeLabel(p);
          var isActive = p.active !== false;
          html += '<div class="kiosk-discount-mgmt-row' + (isActive ? '' : ' kiosk-discount-mgmt-row--inactive') + '" data-id="' + escapeHTML(p.id) + '">';
          html += '<span class="kiosk-discount-mgmt-name">' + escapeHTML(p.name) + '</span>';
          html += '<span class="kiosk-discount-mgmt-info">' + detail + '</span>';
          html += '<button type="button" class="kiosk-discount-mgmt-toggle' + (isActive ? ' is-active' : '') + '" data-id="' + escapeHTML(p.id) + '" data-active="' + isActive + '">' + (isActive ? 'Active' : 'Paused') + '</button>';
          html += '<button type="button" class="kiosk-discount-mgmt-edit" data-id="' + escapeHTML(p.id) + '">Edit</button>';
          html += '<button type="button" class="kiosk-discount-mgmt-delete" data-id="' + escapeHTML(p.id) + '">&times;</button>';
          html += '</div>';
        });
        list.innerHTML = html;

        list.querySelectorAll('.kiosk-discount-mgmt-toggle').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var nowActive = btn.getAttribute('data-active') === 'true';
            fetch(mwUrl + '/api/kiosk/discounts/' + encodeURIComponent(id), _kcMergeAuth({
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ active: !nowActive })
            }))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.ok) {
                showToast(!nowActive ? 'Preset activated' : 'Preset paused', 'success');
                kioskLoadDiscountPresets();
                kioskRenderDiscountMgmtList();
              } else {
                showToast(data.error || 'Failed to update', 'error');
              }
            })
            .catch(function () { showToast('Network error', 'error'); });
          });
        });

        list.querySelectorAll('.kiosk-discount-mgmt-edit').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var preset = null;
            for (var i = 0; i < presets.length; i++) {
              if (presets[i].id === id) { preset = presets[i]; break; }
            }
            if (preset) kioskPopulateDiscountForm(preset);
          });
        });

        list.querySelectorAll('.kiosk-discount-mgmt-delete').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            if (!confirm('Delete this preset?')) return;
            fetch(mwUrl + '/api/kiosk/discounts/' + encodeURIComponent(id), _kcMergeAuth({
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' }
            }))
            .then(function () {
              showToast('Preset deleted', 'success');
              kioskLoadDiscountPresets();
              kioskRenderDiscountMgmtList();
            })
            .catch(function () { showToast('Failed to delete', 'error'); });
          });
        });
      })
      .catch(function () {
        list.innerHTML = '<p style="padding:0.75rem 0;color:#c00;">Failed to load presets</p>';
      });
  }

  // ===== Gift Card Management panel (Phase 54, D-54-01/02/03/05) =====
  // Kiosk-native lookup + void panel authored fresh in the shared module
  // (the kiosk page has no openModal/closeModal, unlike admin.js). Container
  // open/close mirrors kioskShowDiscountMgmt(); the two-step lookup->void
  // state machine ports js/admin.js's kioskShowAdminGiftCardMgmtModal()
  // behavior verbatim (D-54-02 behavior parity), with every fetch routed
  // through _kcMergeAuth instead of admin's hard-coded credentials:'include'
  // (D-54-03 — the admin-only bug pattern this phase exists to avoid).
  function kioskShowGiftCardMgmt() {
    var panel = document.getElementById('kgcm-panel');
    if (!panel) return;
    panel.style.display = '';

    var mwUrl = _kcEnv.mwUrl;
    var lookupView = document.getElementById('kgcm-lookup-view');
    var voidView = document.getElementById('kgcm-void-view');
    var certEl = document.getElementById('kgcm-cert');
    var errEl = document.getElementById('kgcm-error');
    var resultEl = document.getElementById('kgcm-result');
    var resultInfoEl = document.getElementById('kgcm-result-info');
    var lookupBtn = document.getElementById('kgcm-lookup-btn');
    var voidBtn = document.getElementById('kgcm-void-btn');
    var closeBtn = document.getElementById('kgcm-close');
    var voidConfirmLabel = document.getElementById('kgcm-void-confirm');
    var voidReasonEl = document.getElementById('kgcm-void-reason');
    var voidErrEl = document.getElementById('kgcm-void-error');
    var voidCancelBtn = document.getElementById('kgcm-void-cancel-btn');
    var voidConfirmBtn = document.getElementById('kgcm-void-confirm-btn');

    // Reset to the lookup view every time the panel is (re)opened.
    if (lookupView) lookupView.style.display = '';
    if (voidView) voidView.style.display = 'none';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (resultEl) resultEl.style.display = 'none';
    if (certEl) { certEl.value = ''; certEl.focus(); }

    // Tracks the last looked-up cert for void.
    var _mgmtCert = null;

    function showMgmtErr(msg) {
      if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
    }
    function hideMgmtErr() {
      if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    }

    if (closeBtn) {
      closeBtn.onclick = function () { panel.style.display = 'none'; };
    }

    if (lookupBtn) {
      lookupBtn.onclick = function () {
        var cert = certEl ? certEl.value.trim().toUpperCase() : '';
        if (!cert) { showMgmtErr('Please enter a certificate number.'); return; }
        hideMgmtErr();
        if (resultEl) resultEl.style.display = 'none';
        lookupBtn.disabled = true;
        lookupBtn.textContent = 'Looking up…';
        fetch(mwUrl + '/api/kiosk/gift-card/lookup?cert_number=' + encodeURIComponent(cert), _kcMergeAuth({}))
        .then(function (r) {
          return r.json().then(function (d) { return { status: r.status, data: d }; });
        })
        .then(function (result) {
          lookupBtn.disabled = false;
          lookupBtn.textContent = 'Look Up';
          if (result.status === 200 && result.data && result.data.ok) {
            // F7 (45-09): payload is nested under data.data, and the balance
            // field is current_balance — same contract kiosk.js's redeem
            // panel (kgcr-) consumes.
            var d = (result.data && result.data.data) || {};
            _mgmtCert = d.cert_number || cert;
            var statusStr = d.status || 'active';
            var statusColor = (statusStr === 'active') ? '#2e7d32' : '#c00';
            if (resultInfoEl) {
              resultInfoEl.innerHTML =
                '<strong>Cert #:</strong> ' + escapeHTML(_mgmtCert) + '<br>' +
                '<strong>Status:</strong> <span style="color:' + statusColor + ';font-weight:600;">' + escapeHTML(statusStr) + '</span><br>' +
                '<strong>Face Value:</strong> ' + kioskFmt(d.face_value || 0) + '<br>' +
                '<strong>Current Balance:</strong> ' + kioskFmt(d.current_balance || 0);
            }
            if (voidBtn) voidBtn.style.display = (statusStr === 'voided') ? 'none' : '';
            if (resultEl) resultEl.style.display = 'block';
          } else if (result.status === 404) {
            showMgmtErr('Certificate not found. Check the number and try again.');
          } else {
            showMgmtErr((result.data && result.data.error) || 'Lookup failed. Please try again.');
          }
        })
        .catch(function () {
          lookupBtn.disabled = false;
          lookupBtn.textContent = 'Look Up';
          showMgmtErr('Connection error. Please check your connection and try again.');
        });
      };
    }

    if (voidBtn) {
      voidBtn.onclick = function () {
        if (!_mgmtCert) return;
        // Switch to the void-confirmation view (D-54-02: two-step, required
        // reason, "cannot be undone" label — no manager-PIN gate).
        if (lookupView) lookupView.style.display = 'none';
        if (voidView) voidView.style.display = 'block';
        if (voidConfirmLabel) voidConfirmLabel.textContent = 'Void ' + _mgmtCert + '? This cannot be undone.';
        if (voidReasonEl) { voidReasonEl.value = ''; voidReasonEl.focus(); }
        if (voidErrEl) { voidErrEl.style.display = 'none'; voidErrEl.textContent = ''; }
      };
    }

    if (voidCancelBtn) {
      voidCancelBtn.onclick = function () {
        if (voidView) voidView.style.display = 'none';
        if (lookupView) lookupView.style.display = 'block';
      };
    }

    if (voidConfirmBtn) {
      voidConfirmBtn.onclick = function () {
        var reason = voidReasonEl ? voidReasonEl.value.trim() : '';
        if (!reason) {
          if (voidErrEl) { voidErrEl.textContent = 'Please enter a reason for voiding.'; voidErrEl.style.display = 'block'; }
          return;
        }
        if (!_mgmtCert) return;
        voidConfirmBtn.disabled = true;
        voidConfirmBtn.textContent = 'Voiding…';
        if (voidErrEl) { voidErrEl.style.display = 'none'; voidErrEl.textContent = ''; }
        fetch(mwUrl + '/api/kiosk/gift-card/void', _kcMergeAuth({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cert_number: _mgmtCert, reason: reason })
        }))
        .then(function (r) {
          return r.json().then(function (d) { return { status: r.status, data: d }; });
        })
        .then(function (result) {
          voidConfirmBtn.disabled = false;
          voidConfirmBtn.textContent = 'Confirm Void';
          if (result.status === 200 && result.data && result.data.ok) {
            panel.style.display = 'none';
            showToast('Gift Certificate ' + _mgmtCert + ' has been voided.', 'success');
          } else if (result.status === 404) {
            if (voidErrEl) { voidErrEl.textContent = 'Certificate not found.'; voidErrEl.style.display = 'block'; }
          } else if (result.status === 409) {
            if (voidErrEl) { voidErrEl.textContent = 'Certificate is already voided.'; voidErrEl.style.display = 'block'; }
          } else {
            if (voidErrEl) {
              voidErrEl.textContent = (result.data && result.data.error) || 'Void failed. Please try again.';
              voidErrEl.style.display = 'block';
            }
          }
        })
        .catch(function () {
          voidConfirmBtn.disabled = false;
          voidConfirmBtn.textContent = 'Confirm Void';
          if (voidErrEl) { voidErrEl.textContent = 'Connection error. Please try again.'; voidErrEl.style.display = 'block'; }
        });
      };
    }
  }

  // ===== Public namespace (D-06: prefix dropped) =====
  var KioskCore = {
    init: kcInit,

    // cart building / catalog / render / totals
    fmt: kioskFmt,
    renderRecipeIngredients: kioskRenderRecipeIngredients,
    fetchRecipeQuote: kioskFetchRecipeQuote,
    scheduleRecipeQuote: kioskScheduleRecipeQuote,
    loadIngredientCatalog: kioskLoadIngredientCatalog,
    renderKioskModifyRows: renderKioskModifyRows,
    attachKioskModifyRowListeners: attachKioskModifyRowListeners,
    showIngredientAutocomplete: kioskShowIngredientAutocomplete,
    hideIngredientAutocomplete: kioskHideIngredientAutocomplete,
    effectiveRate: kioskEffectiveRate,
    getItemType: kioskGetItemType,
    isConsignment: kioskIsConsignment,
    itemCategory: kioskItemCategory,
    isWeightItem: kioskIsWeightItem,
    checkStockOverflow: kioskCheckStockOverflow,
    itemTax: kioskItemTax,
    cartIsEmpty: kioskCartIsEmpty,
    cartHasKits: kioskCartHasKits,
    findMakersFee: kioskFindMakersFee,
    findMaterialsFee: kioskFindMaterialsFee,
    countKitsInCart: kioskCountKitsInCart,
    syncKitFees: kioskSyncKitFees,
    isKitFee: kioskIsKitFee,
    findProductById: kioskFindProductById,
    r2: kioskR2,
    calcTotals: kioskCalcTotals,
    showView: kioskShowView,
    setMode: kioskSetMode,
    loadProducts: kioskLoadProducts,
    loadRecipes: kioskLoadRecipes,
    recipePrice: kioskRecipePrice,
    recipePriceForContext: kioskRecipePriceForContext,
    renderRecipes: kioskRenderRecipes,
    showRecipePrompt: kioskShowRecipePrompt,
    updateSummaryPrice: kioskUpdateSummaryPrice,
    selectSaleType: kioskSelectSaleType,
    updateAddToCartButton: kioskUpdateAddToCartButton,
    checkRecipeAvailability: kioskCheckRecipeAvailability,
    renderAvailBanner: kioskRenderAvailBanner,
    addRecipeToCart: kioskAddRecipeToCart,
    populateCategories: kioskPopulateCategories,
    getFilteredProducts: kioskGetFilteredProducts,
    renderProducts: kioskRenderProducts,
    renderProductGrid: kioskRenderProductGrid,
    renderProductList: kioskRenderProductList,
    addToCart: kioskAddToCart,
    setQty: kioskSetQty,
    removeFromCart: kioskRemoveFromCart,
    clearCart: kioskClearCart,
    renderCart: kioskRenderCart,
    showCustomerStep: kioskShowCustomerStep,
    showError: kioskShowError,

    // terminal / checkout / payment / receipt (48-03 Task 1)
    setTerminalStatus: kioskSetTerminalStatus,
    checkTerminal: kioskCheckTerminal,
    startCheckout: kioskStartCheckout,
    proceedToPayment: kioskProceedToPayment,
    showReceipt: kioskShowReceipt,

    // dual-cart / sales-order-import (48-03 Task 2, SC#1: exactly one place)
    showCollect: kioskShowCollect,
    loadSalesOrders: kioskLoadSalesOrders,
    renderSoList: kioskRenderSoList,
    renderSoChips: kioskRenderSoChips,
    wireSoChips: kioskWireSoChips,
    importSoToCart: kioskImportSoToCart,
    reorderSo: kioskReorderSo,
    clearImportedSo: kioskClearImportedSo,
    collectPayment: kioskCollectPayment,
    showSoError: kioskShowSoError,
    showCreateSo: kioskShowCreateSo,
    renderSoCustomerInfo: kioskRenderSoCustomerInfo,
    addSoItem: kioskAddSoItem,
    removeSoItem: kioskRemoveSoItem,
    renderSoItems: kioskRenderSoItems,
    createSalesOrder: kioskCreateSalesOrder,

    // discount display (Task 1 slice — calcTotals dependency)
    updateDiscountDisplay: kioskUpdateDiscountDisplay,
    calcDiscountAmount: kioskCalcDiscountAmount,
    loadDiscountPresets: kioskLoadDiscountPresets,
    showDiscountPopover: kioskShowDiscountPopover,
    applyDiscount: kioskApplyDiscount,
    removeDiscount: kioskRemoveDiscount,
    refreshAfterDiscountChange: kioskRefreshAfterDiscountChange,
    collectAppliesTo: kioskCollectAppliesTo,
    populateDiscountForm: kioskPopulateDiscountForm,
    discountScopeLabel: kioskDiscountScopeLabel,
    showDiscountMgmt: kioskShowDiscountMgmt,
    renderDiscountMgmtList: kioskRenderDiscountMgmtList,

    // gift card management (Phase 54, D-54-03)
    showGiftCardMgmt: kioskShowGiftCardMgmt,

    // ---- Test-export-style accessors (mirror js/kiosk.js's existing idiom) ----
    _getQuote: function () { return _kioskQuote; },
    _setQuote: function (q) { _kioskQuote = q; },
    _getSelectedRecipe: function () { return _kioskSelectedRecipe; },
    _setSelectedRecipe: function (r) { _kioskSelectedRecipe = r; },
    _getSaleType: function () { return _kioskSaleType; },
    _setSaleType: function (s) { _kioskSaleType = s; },
    _getTargetVolumeL: function () { return _kioskTargetVolumeL; },
    _setTargetVolumeL: function (v) { _kioskTargetVolumeL = v; },
    _getCart: function () { return _kcEnv.getCart(); },
    _setCart: function (v) { _kcEnv.setCart(v); },
    _setRecipeAvailability: function (a) { _kioskRecipeAvailability = a; },
    _getModifiedIngredients: function () { return _kcEnv.getModifiedIngredients(); },
    _setModifiedIngredients: function (v) { _kcEnv.setModifiedIngredients(v); },
    _getMillGrain: function () { return _kioskMillGrain; },
    _setMillGrain: function (v) { _kioskMillGrain = v; },
    _getFilters: function () { return _kioskFilters; },
    _getViewMode: function () { return _kioskViewMode; },
    _setViewMode: function (v) { _kioskViewMode = v; },
    _setProductsLoaded: function (v) { _kioskProductsLoaded = v; },
    _getProductsLoaded: function () { return _kioskProductsLoaded; },
    _getProductsLoading: function () { return _kioskProductsLoading; },
    _getProducts: function () { return _kioskProducts; },
    _setModifyPanelOpen: function (v) { _kioskModifyPanelOpen = v; },
    // 48-03 Task 1: payment-path state accessors
    _getTerminalReady: function () { return _kioskTerminalReady; },
    _getSaleData: function () { return _kioskSaleData; },
    // D-07 (Manager Override) accessors
    _getStockOverride: function () { return _kioskStockOverride; },
    _setStockOverride: function (v) { _kioskStockOverride = v; },
    // 67 review fix (WR-03): imported-SO state accessors so tests can pin
    // the SO-cart scoping of the missing-tax gate.
    _getImportedSoId: function () { return _kioskImportedSoId; },
    _setImportedSo: function (id, num) { _kioskImportedSoId = id; _kioskImportedSoNumber = num || ''; },
    // 67 review fix (WR-04): recipe-context accessors (delegate through the
    // env bridge) so tests can pin the recipe sale body contract.
    _getRecipeContext: function () { return _kcEnv.getRecipeContext(); },
    _setRecipeContext: function (v) { _kcEnv.setRecipeContext(v); }
  };

  // ===== Dual-mode export (D-01) =====
  if (typeof window !== 'undefined') {
    window.KioskCore = KioskCore;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = KioskCore;
  }

})();

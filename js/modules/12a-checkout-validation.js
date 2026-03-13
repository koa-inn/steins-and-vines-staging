// =============================================================================
// 12a-checkout-validation.js
// Form validation, reCAPTCHA, phone formatting, and kit-visibility helpers.
// Loaded before 12-checkout.js in the concat:js pipeline.
// =============================================================================

// --- C1: reCAPTCHA v3 token helper ---
function getRecaptchaToken(action, callback) {
  if (typeof grecaptcha === 'undefined' || !window.RECAPTCHA_SITE_KEY) {
    callback('');
    return;
  }
  grecaptcha.ready(function () {
    grecaptcha.execute(window.RECAPTCHA_SITE_KEY, { action: action }).then(function (token) {
      callback(token);
    }).catch(function () { callback(''); });
  });
}

// --- H8: Client-side form validation ---
function validateCheckoutForm() {
  var name = document.getElementById('res-name');
  var email = document.getElementById('res-email');
  var phone = document.getElementById('res-phone');
  var errors = [];
  if (!name || !name.value.trim()) errors.push('Name is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) errors.push('Valid email is required');
  if (!phone || !phone.value.trim()) errors.push('Phone number is required');
  var errorContainer = document.getElementById('form-error-announce') || document.querySelector('[role="alert"]');
  if (errorContainer) {
    errorContainer.textContent = errors.join('. ');
    errorContainer.style.display = errors.length ? '' : 'none';
  }
  return errors.length === 0;
}

// #10/#21: renumber visible stepper digits after hiding steps
function renumberVisibleSteps() {
  var steps = document.querySelectorAll('.stepper-step:not(.hidden)');
  var n = 1;
  steps.forEach(function (step) {
    var digit = step.querySelector('.stepper-digit');
    if (digit) digit.textContent = n++;
  });
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

function setupContactValidation() {
  var n = document.getElementById('name'); var e = document.getElementById('email'); if (!n && !e) return;
  var err = function (i, m) { i.classList.add('field-error'); var eE = i.parentElement.querySelector('.form-error-msg') || document.createElement('div'); eE.className = 'form-error-msg'; eE.textContent = m; i.parentElement.appendChild(eE); eE.classList.add('visible'); };
  var clr = function (i) { i.classList.remove('field-error'); var eE = i.parentElement.querySelector('.form-error-msg'); if (eE) eE.classList.remove('visible'); };
  if (n) { n.addEventListener('blur', function () { if (!this.value.trim()) err(this, 'Name is required.'); else clr(this); }); n.addEventListener('focus', function () { clr(this); }); }
  if (e) { e.addEventListener('blur', function () { var v = this.value.trim(); if (!v) err(this, 'Email is required.'); else if (!isValidEmail(v)) err(this, 'Invalid email.'); else clr(this); }); e.addEventListener('focus', function () { clr(this); }); }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    getRecaptchaToken: getRecaptchaToken,
    validateCheckoutForm: validateCheckoutForm,
    renumberVisibleSteps: renumberVisibleSteps,
    formatPhoneInput: formatPhoneInput,
    isValidEmail: isValidEmail,
    isValidPhone: isValidPhone,
    applyKitSpecificVisibility: applyKitSpecificVisibility,
    setupContactValidation: setupContactValidation
  };
}

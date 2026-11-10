'use strict';

// Phase 101 D-19 (T-101-03): /api/kiosk/cart-quote is on the exact-path KIOSK_ROUTES
// allowlist, the same tier as /api/kiosk/sale. No prefix rule.

var authTiers = require('../lib/authTiers');

describe('/api/kiosk/cart-quote auth tier (Phase 101 D-19)', function () {
  test('is classified as a kiosk route exactly like /api/kiosk/sale', function () {
    expect(authTiers.isKioskRoute('/api/kiosk/sale')).toBe(true);
    expect(authTiers.isKioskRoute('/api/kiosk/cart-quote')).toBe(true);
    expect(authTiers.KIOSK_ROUTES.indexOf('/api/kiosk/cart-quote')).not.toBe(-1);
  });

  test('is an exact path: sub-paths are not matched', function () {
    expect(authTiers.isKioskRoute('/api/kiosk/cart-quote/x')).toBe(false);
    expect(authTiers.isKioskRoute('/api/kiosk/cart-quote2')).toBe(false);
  });

  test('device, session and legacy tiers are allowed; no tier is not', function () {
    ['device', 'session', 'legacy'].forEach(function (t) {
      expect(authTiers.allowKiosk(t)).toBe(true);
    });
    expect(authTiers.allowKiosk(null)).toBe(false);
    expect(authTiers.allowKiosk(undefined)).toBe(false);
  });
});

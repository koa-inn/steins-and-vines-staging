'use strict';

// 12-checkout.js depends on globals from 11-cart.js being present.
// These stubs prevent load-time ReferenceErrors.
global.SHEETS_CONFIG = { SPREADSHEET_ID: 'test', MIDDLEWARE_URL: '' };
global.navigator = global.navigator || {};
global.navigator.vibrate = jest.fn();

// 12-checkout.js reads the cart on load — set up an empty localStorage first.
beforeEach(function () {
  localStorage.clear();
  jest.clearAllMocks();
});

var checkout = require('../../js/modules/12-checkout');
var formatTimeslot   = checkout.formatTimeslot;
var formatPhoneInput = checkout.formatPhoneInput;
var isValidEmail     = checkout.isValidEmail;
var isValidPhone     = checkout.isValidPhone;

// ---------------------------------------------------------------------------
// formatTimeslot
// ---------------------------------------------------------------------------
describe('formatTimeslot', function () {
  test('formats "2026-02-15 10:00 AM" with weekday + time', function () {
    var result = formatTimeslot('2026-02-15 10:00 AM');
    // Exact day text varies by locale, just assert shape
    expect(result).toMatch(/at 10:00 AM/);
    expect(result).toMatch(/Feb/);
  });

  test('includes weekday short name', function () {
    var result = formatTimeslot('2026-02-15 10:00 AM');
    expect(result).toMatch(/Sun/); // 2026-02-15 is a Sunday
  });

  test('returns original value when no space (no time part)', function () {
    expect(formatTimeslot('2026-02-15')).toBe('2026-02-15');
  });

  test('returns original value for invalid date', function () {
    expect(formatTimeslot('not-a-date 10:00 AM')).toBe('not-a-date 10:00 AM');
  });

  test('preserves multi-word time portion "10:30 AM"', function () {
    var result = formatTimeslot('2026-03-01 10:30 AM');
    expect(result).toMatch(/at 10:30 AM/);
  });

  test('works with PM times', function () {
    var result = formatTimeslot('2026-03-01 2:00 PM');
    expect(result).toMatch(/at 2:00 PM/);
  });
});

// ---------------------------------------------------------------------------
// formatPhoneInput
// ---------------------------------------------------------------------------
describe('formatPhoneInput', function () {
  test('empty string returns empty string', function () {
    expect(formatPhoneInput('')).toBe('');
  });

  test('1 digit → opening paren', function () {
    expect(formatPhoneInput('6')).toBe('(6');
  });

  test('3 digits → area code in parens', function () {
    expect(formatPhoneInput('604')).toBe('(604');
  });

  test('4 digits → area code + space + one digit', function () {
    expect(formatPhoneInput('6045')).toBe('(604) 5');
  });

  test('6 digits → area code + 3-digit prefix', function () {
    expect(formatPhoneInput('604555')).toBe('(604) 555');
  });

  test('7 digits → adds hyphen', function () {
    expect(formatPhoneInput('6045551')).toBe('(604) 555-1');
  });

  test('10 digits → full formatted number', function () {
    expect(formatPhoneInput('6045551234')).toBe('(604) 555-1234');
  });

  test('strips non-digit characters', function () {
    expect(formatPhoneInput('(604) 555-1234')).toBe('(604) 555-1234');
  });

  test('ignores digits beyond 10', function () {
    expect(formatPhoneInput('60455512349999')).toBe('(604) 555-1234');
  });

  test('strips letters', function () {
    expect(formatPhoneInput('abc6045551234')).toBe('(604) 555-1234');
  });
});

// ---------------------------------------------------------------------------
// isValidEmail
// ---------------------------------------------------------------------------
describe('isValidEmail', function () {
  test('valid email', function () {
    expect(isValidEmail('user@example.com')).toBe(true);
  });

  test('valid email with subdomain', function () {
    expect(isValidEmail('user@mail.example.com')).toBe(true);
  });

  test('valid email with plus', function () {
    expect(isValidEmail('user+tag@example.com')).toBe(true);
  });

  test('missing @', function () {
    expect(isValidEmail('userexample.com')).toBe(false);
  });

  test('missing domain', function () {
    expect(isValidEmail('user@')).toBe(false);
  });

  test('missing TLD', function () {
    expect(isValidEmail('user@example')).toBe(false);
  });

  test('space in email', function () {
    expect(isValidEmail('user @example.com')).toBe(false);
  });

  test('empty string', function () {
    expect(isValidEmail('')).toBe(false);
  });

  test('hello@steinsandvines.ca', function () {
    expect(isValidEmail('hello@steinsandvines.ca')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isValidPhone
// ---------------------------------------------------------------------------
describe('isValidPhone', function () {
  test('10 digit number → valid', function () {
    expect(isValidPhone('6045551234')).toBe(true);
  });

  test('formatted (604) 555-1234 → valid', function () {
    expect(isValidPhone('(604) 555-1234')).toBe(true);
  });

  test('15 digits → valid (international max)', function () {
    expect(isValidPhone('604555123499999')).toBe(true);
  });

  test('9 digits → invalid', function () {
    expect(isValidPhone('604555123')).toBe(false);
  });

  test('16 digits → invalid', function () {
    expect(isValidPhone('6045551234999990')).toBe(false);
  });

  test('empty string → invalid', function () {
    expect(isValidPhone('')).toBe(false);
  });

  test('letters stripped before counting', function () {
    // "(604) 555-1234" has exactly 10 digits → valid
    expect(isValidPhone('(604) 555-1234')).toBe(true);
  });
});

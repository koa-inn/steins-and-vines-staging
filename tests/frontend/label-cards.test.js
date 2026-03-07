'use strict';

// 04-label-cards.js calls setResponsiveImg and trackEvent inside functions.
// Declare them as no-ops so the module loads cleanly.
global.setResponsiveImg = function () {};
global.trackEvent = function () {};

const { getTintClass, formatCurrency } = require('../../js/modules/04-label-cards');

describe('getTintClass', () => {
  test('returns tint-{tint} when product.tint is set', () => {
    expect(getTintClass({ tint: 'red' })).toBe('tint-red');
  });

  test('lowercases and strips spaces from tint property', () => {
    expect(getTintClass({ tint: 'Rose Wine' })).toBe('tint-rosewine');
  });

  test('returns empty string when no tint and no subcategory', () => {
    expect(getTintClass({})).toBe('');
    expect(getTintClass({ name: 'Unnamed' })).toBe('');
  });

  test('maps subcategory "Red" to tint-red', () => {
    expect(getTintClass({ subcategory: 'Red' })).toBe('tint-red');
  });

  test('maps subcategory "White" to tint-white', () => {
    expect(getTintClass({ subcategory: 'White' })).toBe('tint-white');
  });

  test('maps subcategory "Rose" to tint-rose', () => {
    expect(getTintClass({ subcategory: 'Rose' })).toBe('tint-rose');
  });

  test('maps subcategory "Ros" (accent-stripped) to tint-rose', () => {
    // subcategory.toLowerCase().replace(/[^a-z]/g, '') => "ros"
    expect(getTintClass({ subcategory: 'Rosé' })).toBe('tint-rose');
  });

  test('maps subcategory "IPA" to tint-ipa', () => {
    expect(getTintClass({ subcategory: 'IPA' })).toBe('tint-ipa');
  });

  test('maps subcategory "Stout" to tint-stout', () => {
    expect(getTintClass({ subcategory: 'Stout' })).toBe('tint-stout');
  });

  test('returns empty string for unknown subcategory', () => {
    expect(getTintClass({ subcategory: 'Unknown Style' })).toBe('');
  });

  test('tint property takes precedence over subcategory', () => {
    expect(getTintClass({ tint: 'amber', subcategory: 'Red' })).toBe('tint-amber');
  });

  test('subcategory matching is case-insensitive', () => {
    expect(getTintClass({ subcategory: 'PILSNER' })).toBe('tint-pilsner');
    expect(getTintClass({ subcategory: 'wheat' })).toBe('tint-wheat');
  });
});

describe('formatCurrency', () => {
  test('formats integer number', () => {
    expect(formatCurrency(5)).toBe('$5.00');
  });

  test('formats decimal number', () => {
    expect(formatCurrency(19.99)).toBe('$19.99');
  });

  test('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  test('formats negative number', () => {
    expect(formatCurrency(-5)).toBe('$-5.00');
  });

  test('parses numeric string', () => {
    expect(formatCurrency('5')).toBe('$5.00');
  });

  test('strips dollar sign from string before parsing', () => {
    expect(formatCurrency('$19.99')).toBe('$19.99');
  });

  test('returns empty string for NaN input', () => {
    expect(formatCurrency('not a number')).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(formatCurrency('')).toBe('');
  });

  test('rounds to 2 decimal places', () => {
    expect(formatCurrency(1.005)).toBe('$1.00');  // floating-point rounding
    expect(formatCurrency(1.999)).toBe('$2.00');
  });

  test('handles large number', () => {
    expect(formatCurrency(1234567.89)).toBe('$1234567.89');
  });
});

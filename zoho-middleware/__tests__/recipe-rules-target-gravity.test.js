'use strict';

var rules = require('../lib/recipe-rules');

describe('normalizeTargetGravity', function () {
  it('returns empty string for blank input', function () {
    expect(rules.normalizeTargetGravity('')).toBe('');
    expect(rules.normalizeTargetGravity(null)).toBe('');
    expect(rules.normalizeTargetGravity(undefined)).toBe('');
    expect(rules.normalizeTargetGravity('  ')).toBe('');
  });

  it('returns numbers within 2..40 inclusive', function () {
    expect(rules.normalizeTargetGravity(12)).toBe(12);
    expect(rules.normalizeTargetGravity('12.5')).toBe(12.5);
    expect(rules.normalizeTargetGravity(2)).toBe(2);
    expect(rules.normalizeTargetGravity(40)).toBe(40);
  });

  it('returns null for invalid input', function () {
    [1.9, 40.1, 'abc', NaN, [], {}, true].forEach(function (v) {
      expect(rules.normalizeTargetGravity(v)).toBeNull();
    });
  });
});

describe('checkTargetGravityPair', function () {
  it('requires fg below og when both are numbers', function () {
    expect(rules.checkTargetGravityPair(12, 3)).toBe(true);
    expect(rules.checkTargetGravityPair(3, 12)).toBe(false);
    expect(rules.checkTargetGravityPair(12, 12)).toBe(false);
    expect(rules.checkTargetGravityPair('', 3)).toBe(true);
    expect(rules.checkTargetGravityPair(12, '')).toBe(true);
  });
});

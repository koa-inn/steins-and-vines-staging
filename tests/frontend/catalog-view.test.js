'use strict';

// 05-catalog-view.js guards window.addEventListener with typeof check (added by us)
// jsdom provides localStorage and window, so this module loads cleanly.

const { getCatalogViewMode } = require('../../js/modules/05-catalog-view');

describe('getCatalogViewMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('kits defaults to "cards" when nothing stored', () => {
    expect(getCatalogViewMode('kits')).toBe('cards');
  });

  test('ingredients defaults to "table" when nothing stored', () => {
    expect(getCatalogViewMode('ingredients')).toBe('table');
  });

  test('services defaults to "cards" when nothing stored', () => {
    expect(getCatalogViewMode('services')).toBe('cards');
  });

  test('unknown tab defaults to "cards"', () => {
    expect(getCatalogViewMode('unknown')).toBe('cards');
    expect(getCatalogViewMode('')).toBe('cards');
  });

  test('returns stored value when set for kits', () => {
    localStorage.setItem('catalogViewMode-kits', 'table');
    expect(getCatalogViewMode('kits')).toBe('table');
  });

  test('returns stored value when set for ingredients', () => {
    localStorage.setItem('catalogViewMode-ingredients', 'cards');
    expect(getCatalogViewMode('ingredients')).toBe('cards');
  });

  test('stored value overrides default', () => {
    localStorage.setItem('catalogViewMode-services', 'table');
    expect(getCatalogViewMode('services')).toBe('table');
  });

  test('different tabs store independently', () => {
    localStorage.setItem('catalogViewMode-kits', 'table');
    localStorage.setItem('catalogViewMode-ingredients', 'cards');
    expect(getCatalogViewMode('kits')).toBe('table');
    expect(getCatalogViewMode('ingredients')).toBe('cards');
  });

  test('clearing localStorage restores default', () => {
    localStorage.setItem('catalogViewMode-kits', 'table');
    localStorage.clear();
    expect(getCatalogViewMode('kits')).toBe('cards');
  });
});

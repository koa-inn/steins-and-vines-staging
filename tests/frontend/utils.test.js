'use strict';

const { escapeHTML, parseCSVLine } = require('../../js/modules/02-utils');

describe('escapeHTML', () => {
  test('returns empty string for null', () => {
    expect(escapeHTML(null)).toBe('');
  });

  test('returns empty string for undefined', () => {
    expect(escapeHTML(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(escapeHTML('')).toBe('');
  });

  test('escapes ampersands', () => {
    expect(escapeHTML('A & B')).toBe('A &amp; B');
  });

  test('escapes less-than', () => {
    expect(escapeHTML('<div>')).toBe('&lt;div&gt;');
  });

  test('escapes greater-than', () => {
    expect(escapeHTML('a > b')).toBe('a &gt; b');
  });

  test('escapes double quotes', () => {
    expect(escapeHTML('"quoted"')).toBe('&quot;quoted&quot;');
  });

  test('escapes all special chars in one string', () => {
    expect(escapeHTML('<a href="x">A&B</a>')).toBe('&lt;a href=&quot;x&quot;&gt;A&amp;B&lt;/a&gt;');
  });

  test('passes through safe ASCII strings unchanged', () => {
    expect(escapeHTML('Hello World')).toBe('Hello World');
  });

  test('coerces numbers to string', () => {
    expect(escapeHTML(42)).toBe('42');
  });

  test('coerces objects via String()', () => {
    expect(escapeHTML({ toString: () => '<obj>' })).toBe('&lt;obj&gt;');
  });
});

describe('parseCSVLine', () => {
  test('parses simple comma-separated values', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  test('returns single-element array for no commas', () => {
    expect(parseCSVLine('hello')).toEqual(['hello']);
  });

  test('handles quoted field containing a comma', () => {
    expect(parseCSVLine('"hello, world",foo')).toEqual(['hello, world', 'foo']);
  });

  test('handles escaped double quotes inside quoted field', () => {
    expect(parseCSVLine('"say ""hi""",next')).toEqual(['say "hi"', 'next']);
  });

  test('handles empty fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  test('trailing comma produces empty last field', () => {
    expect(parseCSVLine('a,b,')).toEqual(['a', 'b', '']);
  });

  test('empty string returns one empty element', () => {
    expect(parseCSVLine('')).toEqual(['']);
  });

  test('handles whitespace inside fields', () => {
    expect(parseCSVLine(' hello , world ')).toEqual([' hello ', ' world ']);
  });

  test('handles quoted field with no special content', () => {
    expect(parseCSVLine('"simple",plain')).toEqual(['simple', 'plain']);
  });

  test('handles multiple consecutive commas', () => {
    expect(parseCSVLine('a,,,d')).toEqual(['a', '', '', 'd']);
  });

  test('handles mixed quoted and unquoted fields', () => {
    expect(parseCSVLine('name,"Smith, John",age')).toEqual(['name', 'Smith, John', 'age']);
  });
});

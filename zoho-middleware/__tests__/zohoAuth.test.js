'use strict';

// Mock cache (and by extension redis) before any module is loaded
jest.mock('../lib/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  acquireLock: jest.fn().mockResolvedValue(true),
  releaseLock: jest.fn().mockResolvedValue(undefined)
}));

var KEY_ENV = 'REDIS_ENCRYPTION_KEY';
var VALID_KEY = 'aa'.repeat(32); // 64 hex chars = 32 bytes of 0xAA

describe('encrypt / decrypt — with key configured', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    process.env[KEY_ENV] = VALID_KEY;
    zohoAuth = require('../lib/zohoAuth');
  });

  afterAll(() => {
    delete process.env[KEY_ENV];
  });

  test('roundtrip: decrypt(encrypt(text)) === original plaintext', () => {
    var plaintext = 'my-secret-refresh-token';
    var ciphertext = zohoAuth.encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(zohoAuth.decrypt(ciphertext)).toBe(plaintext);
  });

  test('encrypt produces iv:tag:hex format (3 colon-separated parts)', () => {
    var parts = zohoAuth.encrypt('test').split(':');
    expect(parts).toHaveLength(3);
  });

  test('each encrypt call produces a different ciphertext (random IV)', () => {
    var a = zohoAuth.encrypt('same text');
    var b = zohoAuth.encrypt('same text');
    expect(a).not.toBe(b);
  });

  test('roundtrip works for empty string', () => {
    var ct = zohoAuth.encrypt('');
    expect(zohoAuth.decrypt(ct)).toBe('');
  });

  test('roundtrip works for long tokens', () => {
    var token = 'x'.repeat(500);
    expect(zohoAuth.decrypt(zohoAuth.encrypt(token))).toBe(token);
  });

  test('decrypt returns null for corrupted auth tag', () => {
    var ct = zohoAuth.encrypt('data');
    var parts = ct.split(':');
    // Flip first two hex chars of the tag
    var flipped = (parts[1][0] === '0') ? 'f' : '0';
    parts[1] = flipped + flipped + parts[1].slice(2);
    var corrupted = parts.join(':');
    expect(zohoAuth.decrypt(corrupted)).toBeNull();
  });

  test('decrypt returns ciphertext unchanged if no colons (plaintext legacy)', () => {
    var legacy = 'my-old-unencrypted-token';
    expect(zohoAuth.decrypt(legacy)).toBe(legacy);
  });

  test('decrypt returns ciphertext if split gives wrong number of parts', () => {
    var twoColons = 'a:b';
    // key.length===32 so key check passes, but parts.length !== 3 → return ciphertext
    expect(zohoAuth.decrypt(twoColons)).toBe(twoColons);
  });
});

describe('encrypt / decrypt — without key configured', () => {
  var zohoAuth;

  beforeAll(() => {
    jest.resetModules();
    delete process.env[KEY_ENV];
    zohoAuth = require('../lib/zohoAuth');
  });

  test('encrypt is a no-op (returns plaintext unchanged)', () => {
    var text = 'my-token';
    expect(zohoAuth.encrypt(text)).toBe(text);
  });

  test('decrypt is a passthrough (returns input unchanged)', () => {
    expect(zohoAuth.decrypt('some-value')).toBe('some-value');
    expect(zohoAuth.decrypt('a:b:c')).toBe('a:b:c');
  });
});

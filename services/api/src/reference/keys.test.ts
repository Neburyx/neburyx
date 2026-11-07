import { describe, expect, it } from 'vitest';
import { deriveReferenceKeys, KEY_LABELS } from './keys.js';

const master = Buffer.alloc(32, 7);

describe('the keys derived from the reference key', () => {
  it('gives three keys of 32 bytes, no two equal and none equal to the reference key', () => {
    const keys = deriveReferenceKeys(master);
    const all = [keys.tokenMac, keys.tokenEncryption, keys.filterHash];
    for (const key of all) expect(key).toHaveLength(32);
    expect(new Set(all.map((key) => key.toString('hex'))).size).toBe(3);
    expect(all.some((key) => key.equals(master))).toBe(false);
  });

  it('gives the fixed values of HKDF-SHA-256 (checked against an independent implementation) for a fixed key, so the derivation cannot change silently', () => {
    const keys = deriveReferenceKeys(master);
    expect(keys.tokenMac.toString('hex')).toBe('b99d4d098feef7d00ff475a2e8e5ff54b52cf0143d752711def2e47c9a84c9b3');
    expect(keys.tokenEncryption.toString('hex')).toBe('9b67781123a827d0a16d889b8a1b91e6f52c2843851fcd74a6be959170c59d83');
    expect(keys.filterHash.toString('hex')).toBe('c96d1974019cadffe46e236a1df0b4d37546bb704d4ca4bc00e2cee5da6724d6');
  });

  it('is deterministic, depends on the reference key and names each use by its own label', () => {
    expect(deriveReferenceKeys(master).filterHash.equals(deriveReferenceKeys(master).filterHash)).toBe(true);
    expect(deriveReferenceKeys(Buffer.alloc(32, 8)).filterHash.equals(deriveReferenceKeys(master).filterHash)).toBe(false);
    expect(new Set(Object.values(KEY_LABELS)).size).toBe(3);
  });

  it.each([0, 16, 31, 33, 64])('refuses a reference key of %i bytes', (length) => {
    expect(() => deriveReferenceKeys(Buffer.alloc(length, 1))).toThrow();
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCursorCodec } from '../gate/cursor/codec.js';
import { createSigner, deriveSigningKey } from './signing-key.js';

describe('the signing key', () => {
  it('is derived from the cursor key material, is not that material, and is the same for the same material in two processes', () => {
    const material = randomBytes(32);
    const key = deriveSigningKey(material);
    expect(key.equals(material)).toBe(false);
    expect(key.length).toBe(32);
    expect(deriveSigningKey(Buffer.from(material)).equals(key)).toBe(true);
  });

  it('differs for different material', () => {
    expect(deriveSigningKey(randomBytes(32)).equals(deriveSigningKey(randomBytes(32)))).toBe(false);
  });

  it('signs to 64 lowercase hex characters, the same text the same way, and with the key it keeps to itself', () => {
    const mac = createSigner(deriveSigningKey(Buffer.alloc(32, 1)));
    expect(mac('a text')).toMatch(/^[0-9a-f]{64}$/);
    expect(mac('a text')).toBe(mac('a text'));
    expect(mac('a text')).not.toBe(mac('another text'));
    expect(createSigner(deriveSigningKey(Buffer.alloc(32, 2)))('a text')).not.toBe(mac('a text'));
  });

  it('does not accept a cursor as a signature, and a signature is no cursor', () => {
    const material = randomBytes(32);
    const codec = createCursorCodec({ key: material, clock: () => 0 });
    const mac = createSigner(deriveSigningKey(material));
    const binding = { source: 's', principal: 'p', policyVersion: 'none', filterHash: '', sort: 'x', target: 'y', targetVersion: '1' };
    const cursor = codec.mint(binding, { n: 1 });
    expect(cursor).not.toBe(mac(cursor));
    expect(() => codec.verify(mac('anything'), binding)).toThrow();
  });
});

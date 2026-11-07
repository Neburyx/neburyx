import { createHash, randomBytes } from 'node:crypto';
import { MAX_REFERENCE_VALUE_CHARACTERS, referenceValueSchema } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { deriveReferenceKeys } from './keys.js';
import { looksLikeToken, makeToken, readToken } from './token.js';

const keys = deriveReferenceKeys(Buffer.alloc(32, 7));
const place = { sourceId: 's', entityType: 't' };

// made by an independent implementation (Python's hmac and hashlib with the openssl command for AES-256-CTR), so a change of construction fails here
const VECTORS: readonly (readonly [string, string, string, string])[] = [
  ['s', 't', 'a', 'p1.hRhe5mJJQFUgc86niPR2-w_p'],
  ['ab', 'c', 'x', 'p1.Z0VBk-CttiyqiCHODsBMi6GC'],
  ['a', 'bc', 'x', 'p1.J_Rw_IdMMzqtxz8IUjJ8-O0k'],
  ['s', 't', '😀', 'p1.i1cFZgKZ5BNChltwRaDAd6b2LBY'],
  ['s', 't', '\ud800', 'p1.nXlOUHXfEgZjV5Kb_op8WW_P'],
  ['demo', 'phone', '+1-212-555-0100', 'p1.xG5uOs80Jv_qbt4YLBEP8Eump_MS7dAneXvh2XrDNZwF5eYSE9JnzEsZbzy4ow'],
  ['demo', 'email', 'ana@example.test', 'p1.pDytR7DUm7jTcNQx_QdFPFROQgVW5rFvK0kuxVXJkKlhObcQfT84vXOodB2Ug1pM'],
];

const codeOf = (action: () => unknown): string => {
  try {
    action();
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.code : 'not an AppError';
  }
};

describe('the token of a value', () => {
  it.each(VECTORS)('equals the published vector for %s, %s and a value of %j', (sourceId, entityType, value, expected) => {
    expect(makeToken(keys, { sourceId, entityType }, value)).toBe(expected);
    expect(readToken(keys, { sourceId, entityType }, expected)).toBe(value);
  });

  it('equals the published vector of the largest accepted value, by its digest', () => {
    const token = makeToken(keys, place, 'x'.repeat(MAX_REFERENCE_VALUE_CHARACTERS));
    expect(token).toHaveLength(266_691);
    expect(createHash('sha256').update(token).digest('hex')).toBe('6d017eade2f7a9d0e720d53c9c77a9666834fe83d014981fa498ca632cd08cbb');
    expect(readToken(keys, place, token)).toBe('x'.repeat(MAX_REFERENCE_VALUE_CHARACTERS));
  });

  it('is `p1.` and base64url text only, and the same for the same inputs', () => {
    const token = makeToken(keys, place, 'ana@example.test');
    expect(token).toMatch(/^p1\.[A-Za-z0-9_-]+$/);
    expect(makeToken(keys, place, 'ana@example.test')).toBe(token);
    expect(looksLikeToken(token)).toBe(true);
    expect(looksLikeToken('+1-212-555-0100')).toBe(false);
  });

  it('differs for another value, another source and another entity type, and tuples whose plain concatenations coincide differ', () => {
    const base = makeToken(keys, place, 'v');
    expect(new Set([base, makeToken(keys, place, 'w'), makeToken(keys, { sourceId: 'u', entityType: 't' }, 'v'), makeToken(keys, { sourceId: 's', entityType: 'u' }, 'v')]).size).toBe(4);
    expect(makeToken(keys, { sourceId: 'ab', entityType: 'c' }, 'x')).not.toBe(makeToken(keys, { sourceId: 'a', entityType: 'bc' }, 'x'));
  });

  it('gives back any string exactly, whatever it holds', () => {
    const odd = ['', 'plain', '😀 mixed ünïcode', '\ud800', '\udc00\ud800', 'a\u0000b', '.', '..', '~', 'p1.looks-like-a-token', ' leading and trailing ', 'x'.repeat(5000)];
    for (const value of odd) expect(readToken(keys, place, makeToken(keys, place, value))).toBe(value);
  });

  it('gives back random strings of random code units, also those that are not valid text', () => {
    for (let round = 0; round < 200; round += 1) {
      const units = Array.from({ length: Math.floor(Math.random() * 40) }, () => randomBytes(2).readUInt16LE());
      const value = String.fromCharCode(...units);
      expect(readToken(keys, place, makeToken(keys, place, value))).toBe(value);
    }
  });

  it('is longer than a path segment when the value is, and still made and read', () => {
    const value = 'q'.repeat(1000);
    const token = makeToken(keys, place, value);
    expect(token.length).toBeGreaterThan(400);
    expect(readToken(keys, place, token)).toBe(value);
  });

  it('refuses a value over the limit', () => {
    expect(codeOf(() => makeToken(keys, place, 'x'.repeat(MAX_REFERENCE_VALUE_CHARACTERS + 1)))).toBe('INVALID_REQUEST');
  });
});

describe('reading a token that is not exactly the one made', () => {
  const token = makeToken(keys, place, 'ana@example.test');
  const body = token.slice(3);
  const flip = (text: string, at: number): string => {
    const swapped = text[at] === 'A' ? 'B' : 'A';
    return text.slice(0, at) + swapped + text.slice(at + 1);
  };

  it.each([
    ['another source', () => readToken(keys, { sourceId: 'other', entityType: 't' }, token)],
    ['another entity type', () => readToken(keys, { sourceId: 's', entityType: 'other' }, token)],
    ['another key', () => readToken(deriveReferenceKeys(Buffer.alloc(32, 8)), place, token)],
    ['another version tag', () => readToken(keys, place, `p2.${body}`)],
    ['no tag', () => readToken(keys, place, body)],
    ['a truncation', () => readToken(keys, place, token.slice(0, -2))],
    ['an extension', () => readToken(keys, place, `${token}AA`)],
    ['an odd extension', () => readToken(keys, place, `${token}A`)],
    ['nothing after the tag', () => readToken(keys, place, 'p1.')],
    ['an IV alone', () => readToken(keys, place, `p1.${body.slice(0, 22)}`)],
    ['a character that is not base64url', () => readToken(keys, place, `p1.${body.slice(0, 5)}!${body.slice(6)}`)],
    ['padding', () => readToken(keys, place, `${token}=`)],
    ['standard base64 characters', () => readToken(keys, place, token.replace(/-/g, '+').replace(/_/g, '/') + '+')],
    ['an empty text', () => readToken(keys, place, '')],
  ])('refuses %s with INVALID_REQUEST', (_name, action) => {
    expect(codeOf(action)).toBe('INVALID_REQUEST');
  });

  it('refuses every single-character change of a token, in the IV and in the ciphertext', () => {
    for (let at = 3; at < token.length; at += 1) {
      expect(codeOf(() => readToken(keys, place, flip(token, at))), `position ${at}`).toBe('INVALID_REQUEST');
    }
  });

  it('answers every refusal with the same error, which says nothing about the check that failed', () => {
    const errors = [() => readToken(keys, { sourceId: 'x', entityType: 't' }, token), () => readToken(keys, place, token.slice(0, -3)), () => readToken(keys, place, 'p2.x')].map((action) => {
      try {
        action();
        return undefined;
      } catch (error) {
        return error;
      }
    });
    for (const error of errors) {
      expect(error).toBeInstanceOf(AppError);
      expect(error instanceof AppError ? [error.code, error.message, error.details, error.reason] : []).toEqual(['INVALID_REQUEST', 'INVALID_REQUEST', undefined, undefined]);
    }
  });
});

describe('the comparison of the IV', () => {
  it('is made with timingSafeEqual and with no plain comparison of the two IVs', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(new URL('./token.ts', import.meta.url), 'utf8');
    expect(text).toContain('timingSafeEqual(iv, expected)');
    expect(text).not.toMatch(/iv\s*[!=]==?\s*expected|expected\s*[!=]==?\s*iv|iv\.equals\(|expected\.equals\(/);
  });
});

describe('the places of a token and the size of a value', () => {
  it('refuses a source or an entity type with an unpaired surrogate, so two places cannot share one binding', () => {
    for (const bad of [{ sourceId: '\ud800', entityType: 't' }, { sourceId: 's', entityType: '\ud801' }]) {
      expect(codeOf(() => makeToken(keys, bad, 'v'))).toBe('INVALID_REQUEST');
      expect(codeOf(() => readToken(keys, bad, makeToken(keys, place, 'v')))).toBe('INVALID_REQUEST');
    }
    expect(makeToken(keys, { sourceId: 's', entityType: '\ufffd' }, 'v')).not.toBe(makeToken(keys, place, 'v'));
  });

  it('counts a value in the same unit as the request schema: 50,000 characters outside the basic plane fit, one more does not', () => {
    const fits = '😀'.repeat(MAX_REFERENCE_VALUE_CHARACTERS / 2);
    const over = `${fits}😀`;
    expect(referenceValueSchema.safeParse(fits).success).toBe(true);
    expect(readToken(keys, place, makeToken(keys, place, fits))).toBe(fits);
    expect(referenceValueSchema.safeParse(over).success).toBe(false);
    expect(codeOf(() => makeToken(keys, place, over))).toBe('INVALID_REQUEST');
  });
});

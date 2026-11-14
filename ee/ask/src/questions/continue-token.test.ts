import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASK_CONTINUE_LIFETIME_MS } from '@neburyx/contracts';
import { issueContinueToken, verifyContinueToken, type ContinueBinding } from './continue-token.js';

const sign = (text: string): string => createHmac('sha256', 'a-key').update(text).digest('hex');
const BINDING: ContinueBinding = { principalId: 'p-1', sourceId: 'demo', intent: 'shared', definition: 'd-1', entities: { id: 'A-1', other: 'B' }, mask: false };
const NOW = 1_800_000_000_000;

describe('the Continue token', () => {
  const token = issueContinueToken(sign, BINDING, NOW);

  it('is the expiry and 64 hex characters, and verifies for the same binding until it expires, more than once', () => {
    expect(token).toMatch(/^[0-9]{13}\.[0-9a-f]{64}$/);
    expect(token.startsWith(`${NOW + ASK_CONTINUE_LIFETIME_MS}.`)).toBe(true);
    expect(verifyContinueToken(sign, token, BINDING, NOW + 1)).toBe(true);
    expect(verifyContinueToken(sign, token, BINDING, NOW + 1000)).toBe(true);
    expect(verifyContinueToken(sign, token, { ...BINDING, entities: { other: 'B', id: 'A-1' } }, NOW + 1)).toBe(true);
  });

  it.each([
    ['another person', { principalId: 'p-2' }],
    ['another source', { sourceId: 'other' }],
    ['another intent', { intent: 'byId' }],
    ['another definition of the intent', { definition: 'd-2' }],
    ['other entities', { entities: { id: 'A-2', other: 'B' } }],
    ['an entity less', { entities: { id: 'A-1' } }],
    ['the other mask', { mask: true }],
  ])('does not verify for %s', (_name, over) => {
    expect(verifyContinueToken(sign, token, { ...BINDING, ...over }, NOW + 1)).toBe(false);
  });

  it('does not verify when it has expired, when its expiry was moved, when altered or malformed, or when it was issued for a longer life than the lifetime', () => {
    expect(verifyContinueToken(sign, token, BINDING, NOW + ASK_CONTINUE_LIFETIME_MS)).toBe(false);
    expect(verifyContinueToken(sign, token, BINDING, NOW + ASK_CONTINUE_LIFETIME_MS + 1)).toBe(false);
    const [expiry = '', signature = ''] = token.split('.');
    expect(verifyContinueToken(sign, `${Number(expiry) + 1}.${signature}`, BINDING, NOW + 1)).toBe(false);
    expect(verifyContinueToken(sign, `${expiry}.${signature.replace(/.$/, signature.endsWith('0') ? '1' : '0')}`, BINDING, NOW + 1)).toBe(false);
    for (const bad of ['', 'x', signature, `${expiry}.`, `.${signature}`, `${expiry}.${signature.toUpperCase()}`, `${expiry}.${signature}0`, `-1.${signature}`]) expect(verifyContinueToken(sign, bad, BINDING, NOW + 1), bad).toBe(false);
    const far = NOW + 10 * ASK_CONTINUE_LIFETIME_MS;
    const longLived = `${far}.${sign(JSON.stringify(['ask-continue', 1, 'p-1', 'demo', 'shared', { id: 'A-1', other: 'B' }, false, far]))}`;
    expect(verifyContinueToken(sign, longLived, BINDING, NOW + 1)).toBe(false);
  });

  it('is made with another key only by that key', () => {
    const other = (text: string): string => createHmac('sha256', 'another-key').update(text).digest('hex');
    expect(verifyContinueToken(other, token, BINDING, NOW + 1)).toBe(false);
  });

  it('holds no entity text', () => {
    expect(token).not.toContain('A-1');
  });
});

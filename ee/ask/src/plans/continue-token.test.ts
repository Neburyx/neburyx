import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CONTINUE_TOKEN_LABEL, continueTokenOf, verifyContinueToken } from './continue-token.js';
import { paramsHashOf } from './params-hash.js';

const mac = (key: string) => (canonical: string) => createHmac('sha256', key).update(canonical).digest('hex');
const PLAN = '01939999-0000-7000-8000-0000000000bb';
const OTHER_PLAN = '01939999-0000-7000-8000-0000000000cc';
const PARAMS = { ref: { entityType: 'node_a', stableId: 'a-1' }, limit: 5 };

describe('a token that is not the plan’s', () => {
  const good = continueTokenOf(mac('key-one'), PLAN, PARAMS);

  it.each([
    ['one made for another plan', continueTokenOf(mac('key-one'), OTHER_PLAN, PARAMS)],
    ['one made for other parameters', continueTokenOf(mac('key-one'), PLAN, { ...PARAMS, limit: 6 })],
    ['one made with another key', continueTokenOf(mac('key-two'), PLAN, PARAMS)],
    ['the hash of the parameters of a run', paramsHashOf(mac('key-one'), PARAMS)],
    ['an empty text', ''],
    ['a token in upper case', good.toUpperCase()],
    ['a token that is too short', good.slice(1)],
    ['a token that is too long', `${good}0`],
    ['text that is not hexadecimal', 'z'.repeat(64)],
    ['a number', 7],
    ['nothing', undefined],
    ['null', null],
  ])('is refused: %s', (_name, offered) => {
    expect(verifyContinueToken(mac('key-one'), PLAN, PARAMS, offered)).toBe(false);
  });

  it('is refused when the plan’s parameters were edited in a nested field', () => {
    expect(verifyContinueToken(mac('key-one'), PLAN, { ...PARAMS, ref: { ...PARAMS.ref, stableId: 'a-2' } }, good)).toBe(false);
  });
});

describe('the token of a plan', () => {
  it('is 64 lowercase hex characters and the same for the same plan, parameters and key, whatever the order of the keys', () => {
    const token = continueTokenOf(mac('key-one'), PLAN, PARAMS);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(continueTokenOf(mac('key-one'), PLAN, { limit: 5, ref: { stableId: 'a-1', entityType: 'node_a' } })).toBe(token);
    expect(verifyContinueToken(mac('key-one'), PLAN, PARAMS, token)).toBe(true);
  });

  it('is signed over a text that opens with its own label and holds the plan and a hash of the parameters, never the parameters', () => {
    const signed: string[] = [];
    continueTokenOf((canonical) => (signed.push(canonical), 'a'.repeat(64)), PLAN, PARAMS);
    const [label, version, planId, hash] = JSON.parse(signed[0] ?? '[]') as unknown[];
    expect([label, version, planId]).toEqual([CONTINUE_TOKEN_LABEL, 1, PLAN]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(signed[0]).not.toContain('a-1');
    expect(CONTINUE_TOKEN_LABEL).toBe('ask-continue');
  });

  it('binds any JSON value, so a plan of another kind binds what identifies it', () => {
    const token = continueTokenOf(mac('key-one'), PLAN, 'pattern:p-1:v3');
    expect(verifyContinueToken(mac('key-one'), PLAN, 'pattern:p-1:v3', token)).toBe(true);
    expect(verifyContinueToken(mac('key-one'), PLAN, 'pattern:p-1:v4', token)).toBe(false);
  });

  it('refuses a signature that is not 64 lowercase hex characters', () => {
    expect(() => continueTokenOf(() => 'short', PLAN, PARAMS)).toThrow();
  });
});

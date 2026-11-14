import { describe, expect, it } from 'vitest';
import { resultOf } from './report.js';
import { allowedMisses, verdictOf, type Scored } from './score.js';
import type { Question } from './questions.js';

const plan: Question = { id: 'p', wording: 'w', expect: { intent: 'byId', entities: { id: 'T-1' } } };
const refusal: Question = { id: 'r', wording: 'w', expect: 'refuse' };

describe('the verdict on one question', () => {
  it('is right for the expected intent with exactly the expected entities', () => {
    expect(verdictOf(plan, { ok: true, intent: 'byId', entities: { id: 'T-1' } })).toEqual({ unsupported: false });
  });

  it.each([
    ['another intent', { ok: true as const, intent: 'pair', entities: { id: 'T-1' } }, 'wrong-intent'],
    ['another value', { ok: true as const, intent: 'byId', entities: { id: 'T-2' } }, 'wrong-entities'],
    ['a value that differs only by surrounding whitespace', { ok: true as const, intent: 'byId', entities: { id: ' T-1' } }, 'wrong-entities'],
    ['an extra entity', { ok: true as const, intent: 'byId', entities: { id: 'T-1', more: 'x' } }, 'wrong-entities'],
    ['a renamed entity', { ok: true as const, intent: 'byId', entities: { other: 'T-1' } }, 'wrong-entities'],
    ['a refusal of the classifier', { ok: false as const, cause: 'bad-reply' as const }, 'bad-reply'],
    ['no answer at all', undefined, 'no-reply'],
  ])('is a miss for %s, with its cause', (_name, answer, cause) => {
    expect(verdictOf(plan, answer).miss).toBe(cause);
  });

  it('counts a plan question answered no-intent as a miss and as unsupported', () => {
    expect(verdictOf(plan, { ok: false, cause: 'no-intent' })).toEqual({ miss: 'no-intent', unsupported: true });
  });

  it('refuses a refusal question only with the cause no-intent', () => {
    expect(verdictOf(refusal, { ok: false, cause: 'no-intent' })).toEqual({ unsupported: false });
    expect(verdictOf(refusal, { ok: false, cause: 'model-failed' }).miss).toBe('model-failed');
    expect(verdictOf(refusal, { ok: false, cause: 'unknown-intent' }).miss).toBe('unknown-intent');
    expect(verdictOf(refusal, { ok: true, intent: 'byId', entities: { id: 'T-1' } }).miss).toBe('answered');
  });
});

describe('the targets', () => {
  it.each([
    [0, 0],
    [12, 0],
    [13, 1],
    [20, 1],
    [27, 2],
    [100, 8],
  ])('allow floor(8%% of %i plans) = %i misses', (plans, allowed) => {
    expect(allowedMisses(plans)).toBe(allowed);
  });

  const entry = (name: string, expectation: 'plan' | 'refuse', miss?: string): Scored => ({ name, expect: expectation, ...(miss === undefined ? {} : { miss }), unsupported: false });
  const plans = (right: number, wrong: number) => [...Array.from({ length: right }, (_u, i) => entry(`r${i}`, 'plan')), ...Array.from({ length: wrong }, (_u, i) => entry(`w${i}`, 'plan', 'wrong-intent'))];

  it('is met with every refusal refused and 25 of 27 plans right, and not with 24 of 27', () => {
    expect(resultOf([...plans(25, 2), entry('x', 'refuse')], false).targetsMet).toBe(true);
    expect(resultOf([...plans(24, 3), entry('x', 'refuse')], false).targetsMet).toBe(false);
  });

  it('is not met when one refusal is answered', () => {
    expect(resultOf([...plans(27, 0), entry('x', 'refuse', 'answered')], false).targetsMet).toBe(false);
  });

  it('is met with 19 of 20 plans and not with 18 of 20, as the old target said', () => {
    expect(resultOf(plans(19, 1), false).targetsMet).toBe(true);
    expect(resultOf(plans(18, 2), false).targetsMet).toBe(false);
  });
});

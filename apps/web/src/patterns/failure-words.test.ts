import { ERROR_CODES, PATTERN_PROBLEM_CODES, PATTERN_UNAVAILABLE_CODES, PATTERN_LIMITS } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '../api/client.js';
import { failureView } from './copy.js';
import { assertNoCodes, codesIn } from './no-codes.js';
import { runFailureView } from './run/run-copy.js';
import { FAILURE_CODES_WITH_WORDS, failureWords, rateLimitedSentence, tryAgainIn } from './failure-words.js';

const CLIENT = ['NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'SCHEMA_MISMATCH', 'ABORTED', 'UNEXPECTED_FAILURE'] as const;

const server = (code: (typeof ERROR_CODES)[number], details?: object): ApiFailure => ({ code, message: 'm', traceId: 't-1', retryable: false, ...(details === undefined ? {} : { details }) }) as unknown as ApiFailure;
const failureOf = (code: string): ApiFailure => ((CLIENT as readonly string[]).includes(code) ? ({ code } as ApiFailure) : server(code as (typeof ERROR_CODES)[number]));

describe('the table of failures in words', () => {
  it('has an entry for every code of the contract and every failure of the client, and no other', () => {
    expect([...FAILURE_CODES_WITH_WORDS].sort()).toEqual([...ERROR_CODES, ...CLIENT].sort());
  });

  it.each([...ERROR_CODES, ...CLIENT])('says %s in one sentence with no code in it', (code) => {
    const words = failureWords(failureOf(code), 'A source');
    expect(words.text.length).toBeGreaterThan(10);
    expect(words.text.endsWith('.')).toBe(true);
    expect(codesIn(words.text)).toEqual([]);
    expect(words.text).not.toMatch(/[A-Z]{3,}_[A-Z]/);
    expect(words.text).not.toContain('t-1');
  });

  it.each([...ERROR_CODES, ...CLIENT])('shows no code in the views of %s that the panels draw', (code) => {
    for (const view of [failureView(failureOf(code), 'A source'), runFailureView(failureOf(code), 'A source')]) assertNoCodes([view.text, view.detail, view.action ?? ''].join(' '), code);
  });

  it('offers an action only where the person can act', () => {
    expect(failureWords(failureOf('NETWORK_UNAVAILABLE'), 's').action).toBe('try-again');
    expect(failureWords(failureOf('ACCESS_DENIED'), 's').action).toBe('close');
    expect(failureWords(failureOf('ABORTED'), 's').action).toBeUndefined();
  });

  it('names the wait of a rate limit in whole seconds, from the field, and none without it', () => {
    const with8 = failureWords(server('RATE_LIMITED', { retryAfterMs: 7200 }), 's');
    expect(with8).toMatchObject({ text: 'You can try again in 8 s.', action: 'try-again', waitMs: 7200 });
    const without = failureWords(server('RATE_LIMITED'), 's');
    expect(without.text).not.toMatch(/\d/);
    expect(without.waitMs).toBeUndefined();
    expect(rateLimitedSentence(0)).toBe('You can try again now.');
    expect(tryAgainIn(8)).toBe('Try again in 8 s');
    expect(tryAgainIn(0)).toBe('Try again');
  });

  it('names the limit of a refused run from the field', () => {
    expect(failureWords(server('QUERY_BUDGET_EXCEEDED', { maxHops: 2 }), 's').text).toBe('The source allows at most 2 steps; the field is set to it.');
    expect(failureWords(server('QUERY_BUDGET_EXCEEDED', { maxPage: 50 }), 's').text).toBe('The source allows at most 50 results at a time; the field is set to it.');
    expect(failureWords(server('QUERY_BUDGET_EXCEEDED'), 's').text).not.toMatch(/\d/);
  });

  it('has a sentence of its own for each reason of a refused pattern, and keeps the one for any other', () => {
    expect(failureWords(server('INVALID_REQUEST', { reason: 'pattern-limit' }), 's').text).toBe(`This source already holds ${PATTERN_LIMITS.patternsPerSource} saved patterns. Delete one first.`);
    expect(failureWords(server('INVALID_REQUEST', { reason: 'pattern-personal-condition' }), 's').text).toContain('personal data');
    expect(failureWords(server('INVALID_REQUEST'), 's').text).toBe('The server did not accept this request.');
  });
});

describe('the scan for codes', () => {
  it('finds a code of the server and a pattern code of two words, in any text', () => {
    expect(codesIn('Could not read (SOURCE_BUSY).')).toEqual(['SOURCE_BUSY']);
    expect(codesIn('The step is too-many here, and bad-value there')).toEqual(['too-many', 'bad-value']);
    expect(() => assertNoCodes('Fine words.')).not.toThrow();
    expect(() => assertNoCodes('RATE_LIMITED', 'the banner')).toThrow('the banner shows RATE_LIMITED');
  });

  it('does not take an ordinary word for a code, and takes every listed code as a whole word only', () => {
    expect(codesIn('Something is missing here. This is not a NOT_FOUNDATION.')).toEqual([]);
    for (const code of [...ERROR_CODES, ...PATTERN_UNAVAILABLE_CODES, ...PATTERN_PROBLEM_CODES].filter((candidate) => /[-_]/.test(candidate))) expect(codesIn(`See ${code}.`)).toContain(code);
  });
});

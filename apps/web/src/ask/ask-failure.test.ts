import { describe, expect, it } from 'vitest';
import { ASK_REFUSAL_SENTENCES, ERROR_CODES } from '@neburyx/contracts';
import { failure } from '../patterns/patterns-kit.js';
import { askFailureWords, isContinueInvalid, isNotInThisEdition } from './ask-failure.js';

describe('the failures of an Ask call, in words', () => {
  it.each([
    ['ASK_UNSUPPORTED', undefined, 'Ask is not available right now.', undefined],
    ['ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }, 'Ask is not available right now.', undefined],
    ['ACCESS_DENIED', { reason: 'ai-preview-off' }, 'Ask is not available right now.', undefined],
    ['INVALID_REQUEST', { reason: 'continue-invalid' }, 'This stop has expired, or the graph or your access changed. Ask the question again.', undefined],
    ['INVALID_REQUEST', { reason: 'file-query-text' }, 'The query behind this question is not allowed to run.', undefined],
    ['INVALID_REQUEST', { reason: 'file-query-intent' }, 'This question has no query for this source.', undefined],
    ['INVALID_REQUEST', { reason: 'file-query-values' }, 'The values of this question do not fit its query.', undefined],
    ['INVALID_REQUEST', { reason: 'file-query-result' }, 'The query behind this question returned something that cannot be drawn on the graph.', undefined],
    ['AUDIT_UNAVAILABLE', undefined, 'The record of this could not be kept, so the answer is withheld. The question may have run. Try again later.', 'try-again'],
  ])('%s %j', (code, details, text, action) => {
    const words = askFailureWords(failure(code, details), 'a');
    expect(words.text).toBe(text);
    expect(words.action).toBe(action);
  });

  it('keeps the words of the product for the other codes, with Try again for a retryable one and none for a refusal of access', () => {
    expect(askFailureWords(failure('SOURCE_BUSY'), 'a').action).toBe('try-again');
    expect(askFailureWords(failure('NETWORK_UNAVAILABLE'), 'a').action).toBe('try-again');
    expect(askFailureWords(failure('SCHEMA_MISMATCH'), 'a').action).toBe('close');
    expect(askFailureWords(failure('RATE_LIMITED', { retryAfterMs: 4000 }), 'a').waitMs).toBe(4000);
  });

  it('names the edition and the continue by their reasons, and nothing else', () => {
    expect(isNotInThisEdition(failure('ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }))).toBe(true);
    expect(isNotInThisEdition(failure('ASK_UNSUPPORTED'))).toBe(false);
    expect(isContinueInvalid(failure('INVALID_REQUEST', { reason: 'continue-invalid' }))).toBe(true);
    expect(isContinueInvalid(failure('INVALID_REQUEST'))).toBe(false);
    expect(ASK_REFUSAL_SENTENCES.unavailable.length).toBeGreaterThan(0);
  });

  it('gives ASK_INTENT_INVALID and SOURCE_MISMATCH the words of Ask, with no retry', () => {
    for (const code of ['ASK_INTENT_INVALID', 'SOURCE_MISMATCH']) expect(askFailureWords(failure(code), 'a')).toEqual({ text: 'The values of this question do not fit what it asks for. Ask it again.' });
  });

  it('puts no code in any sentence, for every code of the contract', () => {
    for (const code of ERROR_CODES) {
      const { text } = askFailureWords(failure(code), 'source-xyz');
      expect(text, code).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      expect(text.length, code).toBeGreaterThan(0);
    }
  });
});

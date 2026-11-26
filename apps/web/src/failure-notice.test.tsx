import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_TABLE, SOURCE_UNAVAILABLE_ENTRIES, SOURCE_UNAVAILABLE_REASONS, type ErrorCode } from '@neburyx/contracts';
import type { ApiFailure } from './api/client.js';
import { FailureNotice, failureText, offersRetry } from './failure-notice.js';
import { FAILURE_CODES_WITH_WORDS, failureWords, type FailureCode } from './failure-words.js';
import { codesIn } from './patterns/no-codes.js';

const isServerCode = (code: FailureCode): code is ErrorCode => code in ERROR_TABLE;
const serverFailure = (code: ErrorCode, details?: object): ApiFailure => ({ code, message: ERROR_TABLE[code].message, retryable: ERROR_TABLE[code].retryable, traceId: 'tr-1', ...(details === undefined ? {} : { details }) }) as ApiFailure;
const failureOf = (code: FailureCode): ApiFailure => (isServerCode(code) ? serverFailure(code) : { code });
const unavailable = (reason: (typeof SOURCE_UNAVAILABLE_REASONS)[number]): ApiFailure => ({ code: 'SOURCE_UNAVAILABLE', message: SOURCE_UNAVAILABLE_ENTRIES[reason].message, retryable: SOURCE_UNAVAILABLE_ENTRIES[reason].retryable, traceId: 'tr-1', details: { reason } }) as ApiFailure;

afterEach(cleanup);

describe('the notice of a failure', () => {
  it.each(FAILURE_CODES_WITH_WORDS)('says %s in words, with the trace ID only for a failure of the server', (code) => {
    render(<FailureNotice failure={failureOf(code)} />);
    const text = screen.getByRole('alert').textContent;
    expect(codesIn(text)).toEqual([]);
    expect(text).toMatch(/^[A-Z].*\./);
    expect(text.endsWith(' · trace tr-1')).toBe(isServerCode(code));
  });

  it.each(SOURCE_UNAVAILABLE_REASONS)('says the sentence of the reason %s of an unavailable source', (reason) => {
    expect(failureText(unavailable(reason))).toBe(SOURCE_UNAVAILABLE_ENTRIES[reason].message);
  });

  it('says the unreachable sentence for an unavailable source that gives no reason', () => {
    expect(failureText(serverFailure('SOURCE_UNAVAILABLE'))).toBe(SOURCE_UNAVAILABLE_ENTRIES.unreachable.message);
  });

  it('calls a source it has no name for "The source", never a blank', () => {
    expect(failureText(serverFailure('SOURCE_BUSY'))).toBe('The source is busy. No read slot freed within the wait.');
    expect(failureText(serverFailure('QUERY_TIMEOUT'))).toBe('The source did not answer in time.');
    expect(failureText(serverFailure('QUERY_TIMEOUT', { timeoutMs: 5000 }))).toBe('The source did not answer within 5 s.');
    expect(failureText(serverFailure('SOURCE_BUSY'), 'Ledger')).toBe('Ledger is busy. No read slot freed within the wait.');
  });
});

describe('whether a failed read offers Try again', () => {
  const OFFERS: readonly FailureCode[] = ['QUERY_TIMEOUT', 'SOURCE_BUSY', 'SOURCE_UNAVAILABLE', 'RATE_LIMITED', 'EXPORT_FAILED', 'INTERNAL_ERROR', 'AUDIT_UNAVAILABLE', 'NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'UNEXPECTED_FAILURE'];

  it.each(FAILURE_CODES_WITH_WORDS)('follows what the sentence of %s tells the person to do', (code) => {
    expect(offersRetry(failureOf(code))).toBe(OFFERS.includes(code));
    expect(offersRetry(failureOf(code))).toBe(failureWords(failureOf(code), 'The source').action === 'try-again');
  });

  it.each(SOURCE_UNAVAILABLE_REASONS)('does not offer it for the reason %s when a retry cannot help', (reason) => {
    expect(offersRetry(unavailable(reason))).toBe(SOURCE_UNAVAILABLE_ENTRIES[reason].retryable);
  });
});

describe('the look of the notice', () => {
  it('writes only the trace ID as an ID, apart from the sentence', () => {
    render(<FailureNotice failure={serverFailure('SOURCE_BUSY')} />);
    const notice = screen.getByRole('alert');
    expect(notice.className).toBe('failure-notice');
    expect(notice.querySelector('.failure-trace')?.textContent).toBe('tr-1');
    expect(notice.textContent).toBe('The source is busy. No read slot freed within the wait. · trace tr-1');
  });
});

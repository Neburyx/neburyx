import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './error-codes.js';
import { ERROR_TABLE, findMissingCodes } from './error-table.js';

describe('findMissingCodes', () => {
  it('reports a code that a fixture table leaves out', () => {
    const { NOT_FOUND: _removed, ...fixture } = ERROR_TABLE;
    expect(findMissingCodes(fixture)).toEqual(['NOT_FOUND']);
  });

  it('reports nothing for the real table', () => {
    expect(findMissingCodes(ERROR_TABLE)).toEqual([]);
  });
});

describe('ERROR_TABLE', () => {
  it.each(ERROR_CODES.map((code) => [code]))('gives %s a message, a status and a retryable flag', (code) => {
    const entry = ERROR_TABLE[code];
    expect(entry.message.length).toBeGreaterThan(0);
    expect(Number.isInteger(entry.status)).toBe(true);
    expect(entry.status).toBeGreaterThanOrEqual(200);
    expect(entry.status).toBeLessThan(600);
    expect(typeof entry.retryable).toBe('boolean');
  });

  it('uses the message and retryable flag the architecture gives for the budget error', () => {
    expect(ERROR_TABLE.QUERY_BUDGET_EXCEEDED).toMatchObject({ message: 'Refine your filters to continue.', retryable: true });
  });

  it('marks the busy and rate-limited errors retryable, as the architecture says', () => {
    expect(ERROR_TABLE.SOURCE_BUSY.retryable).toBe(true);
    expect(ERROR_TABLE.RATE_LIMITED.retryable).toBe(true);
  });

  it('keeps every message free of query syntax and identifiers', () => {
    for (const code of ERROR_CODES) expect(ERROR_TABLE[code].message).not.toMatch(/MATCH|RETURN|WHERE|[A-Z]{2,}-\d+/);
  });
});

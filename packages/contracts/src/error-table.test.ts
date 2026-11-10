import { describe, expect, it } from 'vitest';
import { CONFLICT_REASONS, ERROR_CODES, SOURCE_UNAVAILABLE_REASONS } from './error-codes.js';
import { CONFLICT_ENTRIES, ERROR_TABLE, findMissingCodes, SOURCE_UNAVAILABLE_ENTRIES } from './error-table.js';

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

  it('gives an unavailable source with no reason the sentence and retry flag of unreachable', () => {
    expect(ERROR_TABLE.SOURCE_UNAVAILABLE).toEqual({ ...SOURCE_UNAVAILABLE_ENTRIES.unreachable, status: 503 });
  });

  it('gives each reason of an unavailable source a sentence free of query syntax and identifiers', () => {
    for (const reason of SOURCE_UNAVAILABLE_REASONS) expect(SOURCE_UNAVAILABLE_ENTRIES[reason].message).not.toMatch(/MATCH|RETURN|WHERE|[A-Z]{2,}-\d+/);
  });

  it('keeps the plain message of a CONFLICT with no reason', () => {
    expect(ERROR_TABLE.CONFLICT).toEqual({ message: 'This item was changed elsewhere. Reload to continue.', status: 409, retryable: false });
  });

  it('gives each reason of CONFLICT its own fixed message and a retryable flag of false', () => {
    expect(CONFLICT_ENTRIES['status-change-not-allowed']).toEqual({ message: 'An archived investigation must be reopened before it can be closed.', retryable: false });
    expect(CONFLICT_ENTRIES['source-changed']).toEqual({ message: 'This source now points to a different database or is no longer configured. This investigation is read-only.', retryable: false });
    expect(CONFLICT_ENTRIES['investigation-read-only']).toEqual({ message: 'This investigation is closed or archived. Reopen it to make changes.', retryable: false });
    for (const reason of CONFLICT_REASONS) expect(CONFLICT_ENTRIES[reason].message).not.toMatch(/MATCH|RETURN|WHERE|[A-Z]{2,}-\d+/);
  });

  it('keeps every message free of query syntax and identifiers', () => {
    for (const code of ERROR_CODES) expect(ERROR_TABLE[code].message).not.toMatch(/MATCH|RETURN|WHERE|[A-Z]{2,}-\d+/);
  });
});

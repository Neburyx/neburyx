import { describe, expect, it } from 'vitest';
import { ACCESS_DENIED_ENTRIES, ASK_UNSUPPORTED_ENTRIES } from './error-table.js';
import { ExtensionRefusal, parseExtensionRefusal, type ExtensionRequest } from './extension.js';

const fields = { code: 'ACCESS_DENIED', reason: 'ai-off', audited: true } as const;

describe('the sentence of a call to an AI route of a feature that is off', () => {
  it('says the feature is not available in this release yet, and cannot be retried', () => {
    expect(ACCESS_DENIED_ENTRIES['ai-off']).toEqual({
      message: 'This AI feature is not available in this release yet: it is switched off, or no AI provider is configured.',
      retryable: false,
    });
  });

  it('leaves the two export reasons as they were', () => {
    expect(ACCESS_DENIED_ENTRIES['access-changed'].message).toBe('Your access changed since this export was made. Export again to get a file that matches your current access.');
    expect(ACCESS_DENIED_ENTRIES['export-source-changed'].retryable).toBe(false);
  });
});

describe('a refusal of an extension', () => {
  it('is an error carrying a fixed name, the code, the reason and whether its audit event was written, and no message of its own', () => {
    const refusal = new ExtensionRefusal({ ...fields, audited: false });
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('ExtensionRefusal');
    expect([refusal.code, refusal.reason, refusal.audited, refusal.message]).toEqual(['ACCESS_DENIED', 'ai-off', false, '']);
  });

  it('names no other code or reason', () => {
    // @ts-expect-error a refusal names a code of the three it knows
    expect(() => new ExtensionRefusal({ ...fields, code: 'CONFLICT' })).not.toThrow();
    // @ts-expect-error a refusal names one reason
    expect(() => new ExtensionRefusal({ ...fields, reason: 'access-changed' })).not.toThrow();
  });
});

describe('the refusal of a request the route cannot accept', () => {
  it('carries the code and a reason, and is read back from its shape', () => {
    const invalid = { code: 'INVALID_REQUEST' as const, reason: 'overlap' };
    expect(parseExtensionRefusal(new ExtensionRefusal(invalid))).toEqual(invalid);
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', code: 'INVALID_REQUEST' })).toBeUndefined();
  });
});

describe('the refusal of a call that ran out of time', () => {
  it('carries the code and the limit, and is read back from its shape', () => {
    const timeout = { code: 'QUERY_TIMEOUT' as const, timeoutMs: 20_000 };
    expect(parseExtensionRefusal(new ExtensionRefusal(timeout))).toEqual(timeout);
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', code: 'QUERY_TIMEOUT', timeoutMs: 0 })).toBeUndefined();
  });
});

describe('recognising a refusal by its shape', () => {
  it('reads a refusal of this copy and a plain object or error of the same shape made by another copy', () => {
    expect(parseExtensionRefusal(new ExtensionRefusal(fields))).toEqual(fields);
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', ...fields })).toEqual(fields);
    const other = Object.assign(new Error(), { name: 'ExtensionRefusal', ...fields, audited: false });
    expect(parseExtensionRefusal(other)).toEqual({ ...fields, audited: false });
  });

  it.each([
    ['another code', { name: 'ExtensionRefusal', ...fields, code: 'CONFLICT' }],
    ['another reason', { name: 'ExtensionRefusal', ...fields, reason: 'access-changed' }],
    ['no audited mark', { name: 'ExtensionRefusal', code: 'ACCESS_DENIED', reason: 'ai-off' }],
    ['an audited mark that is not a boolean', { name: 'ExtensionRefusal', ...fields, audited: 'yes' }],
    ['another name', { name: 'Error', ...fields }],
    ['an ordinary error', new Error('boom')],
    ['text', 'ExtensionRefusal'],
    ['nothing', undefined],
  ])('reads nothing from %s', (_name, value) => {
    expect(parseExtensionRefusal(value)).toBeUndefined();
  });
});

describe('the request an extension handler is given', () => {
  const complete: ExtensionRequest = { principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined }, askClassifier: { availability: () => ({ available: false, reason: 'x' }), classify: async () => ({ ok: false, cause: 'unavailable' }) }, caseSummarizer: { maxElements: 0, availability: () => ({ available: false, reason: 'x' }), summarize: async () => ({ status: 'timeLimit', calls: 0 }) }, signal: new AbortController().signal };

  it('is only added to: a handler that reads the principal alone still takes it', async () => {
    const handler = async (request: ExtensionRequest): Promise<string> => request.principalId;
    expect(await handler(complete)).toBe('p');
  });

  it('cannot be built without any of its five fields', () => {
    const { audit, ...withoutAudit } = complete;
    const { previewOn, ...withoutSwitch } = complete;
    const { principalRole, ...withoutRole } = complete;
    const { traceId, ...withoutTrace } = complete;
    const { principalId, ...withoutId } = complete;
    // @ts-expect-error the audit sink is required
    const noAudit: ExtensionRequest = withoutAudit;
    // @ts-expect-error the switch is required
    const noSwitch: ExtensionRequest = withoutSwitch;
    // @ts-expect-error the role is required
    const noRole: ExtensionRequest = withoutRole;
    // @ts-expect-error the trace ID is required
    const noTrace: ExtensionRequest = withoutTrace;
    // @ts-expect-error the principal ID is required
    const noId: ExtensionRequest = withoutId;
    expect([audit, previewOn, principalRole, traceId, principalId].every((field) => field !== undefined)).toBe(true);
    expect([noAudit, noSwitch, noRole, noTrace, noId]).toHaveLength(5);
  });
});

describe('the refusal of an Ask call that cannot be answered here', () => {
  it('is recognised by its shape, carries no audited mark and is never taken for the preview refusal', () => {
    const thrown = new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect([thrown.code, thrown.reason, thrown.audited]).toEqual(['ASK_UNSUPPORTED', 'not-in-this-edition', undefined]);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', code: 'ASK_UNSUPPORTED', reason: 'ai-off' })).toBeUndefined();
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', code: 'ACCESS_DENIED', reason: 'not-in-this-edition', audited: true })).toBeUndefined();
  });

  it('has its own sentence in the error table', () => {
    expect(ASK_UNSUPPORTED_ENTRIES['not-in-this-edition']).toEqual({ message: 'Ask is not available in this edition.', retryable: false });
  });
});

describe('the refusal of a call that names a thing that is not there', () => {
  it('is recognised by its shape and carries neither a reason nor an audited mark', () => {
    const thrown = new ExtensionRefusal({ code: 'NOT_FOUND' });
    expect([thrown.code, thrown.reason, thrown.audited]).toEqual(['NOT_FOUND', undefined, undefined]);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'NOT_FOUND' });
  });
});

describe('the refusal of a call whose audit event could not be written', () => {
  it('is recognised by its shape and carries neither a reason nor an audited mark', () => {
    const thrown = new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
    expect([thrown.code, thrown.reason, thrown.audited]).toEqual(['AUDIT_UNAVAILABLE', undefined, undefined]);
    expect(parseExtensionRefusal(thrown)).toEqual({ code: 'AUDIT_UNAVAILABLE' });
  });
});

describe('the refusals of a read of the gate and of a run', () => {
  const recognised: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['a query budget with its figures', { code: 'QUERY_BUDGET_EXCEEDED', maxPage: 50, maxHops: 3 }],
    ['a query budget with the path result cap', { code: 'QUERY_BUDGET_EXCEEDED', pathResultsCap: 25 }],
    ['a query budget with none', { code: 'QUERY_BUDGET_EXCEEDED' }],
    ['a busy source', { code: 'SOURCE_BUSY' }],
    ['a cursor that no longer holds', { code: 'CURSOR_INVALIDATED' }],
    ['an unavailable source with its reason', { code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }],
    ['an unavailable source that waits', { code: 'SOURCE_UNAVAILABLE', reason: 'repeated-timeouts', retryAfterMs: 5000 }],
    ['a rate limit with its wait', { code: 'RATE_LIMITED', retryAfterMs: 1000 }],
    ['an access refusal with no reason', { code: 'ACCESS_DENIED' }],
    ['a source mismatch', { code: 'SOURCE_MISMATCH' }],
    ['a pattern that was changed', { code: 'CONFLICT', reason: 'pattern-changed' }],
    ['a pattern that is unavailable', { code: 'CONFLICT', reason: 'pattern-unavailable' }],
    ['an invalid intent', { code: 'ASK_INTENT_INVALID' }],
    ['an audit that is unavailable', { code: 'AUDIT_UNAVAILABLE' }],
  ];

  it.each(recognised)('reads %s from its shape, with what it holds and nothing else', (_name, held) => {
    expect(parseExtensionRefusal(new ExtensionRefusal(held as never))).toEqual(held);
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', ...held })).toEqual(held);
  });

  it.each([
    ['a reason of another code on an unavailable source', { code: 'SOURCE_UNAVAILABLE', reason: 'pattern-changed' }],
    ['an unavailable source with no reason', { code: 'SOURCE_UNAVAILABLE' }],
    ['a wait on an unavailable source that is not the breaker', { code: 'SOURCE_UNAVAILABLE', reason: 'unreachable', retryAfterMs: 5 }],
    ['a conflict with no reason', { code: 'CONFLICT' }],
    ['a conflict with a reason that is not a pattern one', { code: 'CONFLICT', reason: 'source-changed' }],
    ['a reason on an invalid intent', { code: 'ASK_INTENT_INVALID', reason: 'pattern-changed' }],
    ['a reason on a cursor that no longer holds', { code: 'CURSOR_INVALIDATED', reason: 'other' }],
    ['a reason that is not the preview one on an access refusal', { code: 'ACCESS_DENIED', reason: 'access-changed' }],
    ['a negative wait on a rate limit', { code: 'RATE_LIMITED', retryAfterMs: -1 }],
    ['a figure that is not a whole number', { code: 'QUERY_BUDGET_EXCEEDED', maxPage: 1.5 }],
    ['a code of the error model that a route does not refuse with', { code: 'INTERNAL_ERROR' }],
    ['an unknown code', { code: 'TEAPOT' }],
  ])('does not read %s', (_name, held) => {
    expect(parseExtensionRefusal({ name: 'ExtensionRefusal', ...held })).toBeUndefined();
  });

  it('keeps an access refusal that has no reason apart from the one that says the feature is off', () => {
    const plain = new ExtensionRefusal({ code: 'ACCESS_DENIED' });
    expect(parseExtensionRefusal(plain)).toEqual({ code: 'ACCESS_DENIED' });
    expect(plain.reason).toBeUndefined();
    expect(plain.audited).toBeUndefined();
  });
});

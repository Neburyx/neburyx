import { describe, expect, expectTypeOf, it } from 'vitest';
import { aiAuditDetailSchema, auditDetailSchema, isTokenCount, parseAiAuditDetail, parseAuditDetail, tokenCount, type AiAuditDetail, type AuditDetail, type AuditEvent, type TokenCount } from './audit.js';

const SHA = 'a'.repeat(64);

const AI = { modelRef: 'model-a', promptId: 'ask-plan', promptVersion: '1', promptSha256: SHA, tokensIn: 12, tokensOut: 'unknown' };

describe('the token count', () => {
  it.each([0, 1, 4096])('is made from the whole number %s', (value) => {
    expect(tokenCount(value)).toBe(value);
    expect(isTokenCount(value)).toBe(true);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])('refuses %s', (value) => {
    expect(() => tokenCount(value)).toThrow(RangeError);
    expect(isTokenCount(value)).toBe(false);
  });
});

describe('the AI fields of an audit event', () => {
  it('hold a model reference, a prompt id and version, and whole-number or unknown counts, and nothing else', () => {
    expectTypeOf<AiAuditDetail>().toEqualTypeOf<{
      readonly modelRef: string;
      readonly promptId: string;
      readonly promptVersion: string;
      readonly promptSha256: string;
      readonly piiPropertiesSent?: readonly string[];
      readonly tokensIn: TokenCount | 'unknown';
      readonly tokensOut: TokenCount | 'unknown';
      readonly cacheReadTokens?: TokenCount | 'unknown';
      readonly cacheWriteTokens?: TokenCount | 'unknown';
    }>();
    const detail: AuditDetail = { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(3), tokensOut: 'unknown' } };
    expect(detail.ai?.tokensIn).toBe(3);
  });

  it('refuse, at compile time, a plain number, a decimal, any other text and any further member', () => {
    // @ts-expect-error a plain number is not a token count
    const plain: AiAuditDetail = { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 1, tokensOut: 'unknown' };
    // @ts-expect-error a decimal is not a token count
    const decimal: AiAuditDetail = { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 1.5, tokensOut: 'unknown' };
    // @ts-expect-error only unknown is allowed as text
    const text: AiAuditDetail = { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'many', tokensOut: 'unknown' };
    // @ts-expect-error a prompt has no place in the event
    const withPrompt: AiAuditDetail = { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(1), tokensOut: 'unknown', prompt: 'x' };
    // @ts-expect-error a summary has no place in the event
    const withSummary: AuditDetail = { ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: tokenCount(1), tokensOut: 'unknown', summary: 'x' } };
    // @ts-expect-error the hash of the prompt text is required
    const noHash: AiAuditDetail = { modelRef: 'm', promptId: 'p', promptVersion: '1', tokensIn: tokenCount(1), tokensOut: 'unknown' };
    expect([plain, decimal, text, withPrompt, withSummary, noHash]).toHaveLength(6);
  });

  it('keep the other detail shapes apart: a detail holds one of the five', () => {
    // @ts-expect-error a detail is one shape, not two
    const both: AuditDetail = { reason: 'timeout', ai: { modelRef: 'm', promptId: 'p', promptVersion: '1', promptSha256: SHA, tokensIn: 'unknown', tokensOut: 'unknown' } };
    expect(both).toBeDefined();
  });

  it.each(['claude-sonnet-5-5', 'ask-plan', '2026-11-12', 'v1.2', 'provider:model/name'])('accept the code %s as a label', (code) => {
    expect(parseAiAuditDetail({ ...AI, modelRef: code }).modelRef).toBe(code);
  });

  it.each([['a missing hash', { ...AI, promptSha256: undefined }], ['upper-case digits', { ...AI, promptSha256: 'A'.repeat(64) }], ['63 digits', { ...AI, promptSha256: 'a'.repeat(63) }], ['65 digits', { ...AI, promptSha256: 'a'.repeat(65) }], ['text that is not hexadecimal', { ...AI, promptSha256: 'g'.repeat(64) }]])('refuses %s as the prompt hash', (_name, value) => {
    expect(aiAuditDetailSchema.safeParse(value).success).toBe(false);
  });

  it('accepts the names of the pii properties sent, and refuses an empty list, a name with whitespace, a name of 201 characters and 101 names', () => {
    expect(parseAiAuditDetail({ ...AI, piiPropertiesSent: ['person.phone', 'account.email'] }).piiPropertiesSent).toEqual(['person.phone', 'account.email']);
    expect(parseAiAuditDetail(AI).piiPropertiesSent).toBeUndefined();
    for (const bad of [[], ['a name'], ['x'.repeat(201)], Array.from({ length: 101 }, (_, index) => `t.p${index}`), [1], ['']]) {
      expect(aiAuditDetailSchema.safeParse({ ...AI, piiPropertiesSent: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('are parsed strictly: an unknown key, a text count, a decimal and a negative number are refused', () => {
    expect(parseAiAuditDetail(AI)).toEqual(AI);
    for (const bad of [{ ...AI, modelRef: 'a prompt with spaces' }, { ...AI, promptId: 'line\nbreak' }, { ...AI, promptVersion: 'x'.repeat(201) }, { ...AI, prompt: 'x' }, { ...AI, tokensIn: 'many' }, { ...AI, tokensIn: 1.5 }, { ...AI, tokensOut: -1 }, { ...AI, modelRef: '' }, { ...AI, tokensIn: undefined }]) {
      expect(aiAuditDetailSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('the detail of an audit event', () => {
  it.each([
    { reason: 'cancelled' },
    { target: 'entity', type: 'person' },
    { counts: { nodes: 2, edges: 1, missing: 0 } },
    { export: { format: 'csv', entities: 3, maskedFields: 1 } },
    { export: { format: 'json', refusal: 'access-changed' } },
    { ai: AI },
  ])('accepts the shape %j', (detail) => {
    expect(parseAuditDetail(detail)).toEqual(detail);
  });

  it.each([
    { text: 'x' },
    { reason: 'cancelled', prompt: 'x' },
    { reason: 'other' },
    { counts: { nodes: 1.5, edges: 1, missing: 0 } },
    { counts: { nodes: -1, edges: 1, missing: 0 } },
    { export: { format: 'csv', fileName: 'a.csv' } },
    { ai: { ...AI, summary: 'x' } },
    { reason: 'timeout', ai: AI },
  ])('refuses %j', (detail) => {
    expect(auditDetailSchema.safeParse(detail).success).toBe(false);
  });
});

describe('the audit event', () => {
  it('keeps the new columns optional, so the events of the existing writers are unchanged', () => {
    const event: AuditEvent = { actorId: 'a', actorRole: 'viewer', action: 'graph.expand', result: 'success', traceId: 't' };
    const full: AuditEvent = { ...event, sourceId: 's', investigationId: 'i', resourceType: 'entity', resourceRef: 'person:1', detail: { reason: 'timeout' } };
    expect([event, full]).toHaveLength(2);
  });
});

describe('the cache counts of an AI audit detail', () => {
  it('hold a count or unknown, and an event written without them still parses', () => {
    expect(parseAiAuditDetail(AI)).toEqual(AI);
    expect(parseAiAuditDetail({ ...AI, cacheReadTokens: 300, cacheWriteTokens: 'unknown' })).toEqual({ ...AI, cacheReadTokens: 300, cacheWriteTokens: 'unknown' });
    expect(parseAiAuditDetail({ ...AI, cacheReadTokens: 0, cacheWriteTokens: 0 })).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it.each([[-1], [1.5], ['many'], [null]])('refuses %s as a cache count', (value) => {
    expect(aiAuditDetailSchema.safeParse({ ...AI, cacheReadTokens: value }).success).toBe(false);
    expect(aiAuditDetailSchema.safeParse({ ...AI, cacheWriteTokens: value }).success).toBe(false);
  });
});

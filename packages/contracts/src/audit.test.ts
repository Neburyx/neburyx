import { describe, expect, expectTypeOf, it } from 'vitest';
import { aiAuditDetailSchema, assistantTurnAuditDetailSchema, auditDetailSchema, isTokenCount, parseAiAuditDetail, parseAuditDetail, tokenCount, type AiAuditDetail, type AuditDetail, type AuditEvent, type TokenCount } from './audit.js';

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
      readonly runId?: string;
      readonly tokensIn: TokenCount | 'unknown';
      readonly tokensOut: TokenCount | 'unknown';
      readonly cacheReadTokens?: TokenCount | 'unknown';
      readonly cacheWriteTokens?: TokenCount | 'unknown';
      readonly failure?: { readonly errorClass: string; readonly errorCode?: string; readonly errorType?: string };
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

  it('hold an optional run id that is a UUID, and refuse any other text as one', () => {
    const runId = '0192f000-0000-7000-8000-000000000042';
    expect(parseAiAuditDetail({ ...AI, runId }).runId).toBe(runId);
    expect(parseAiAuditDetail(AI)).not.toHaveProperty('runId');
    for (const bad of ['not-a-uuid', '', 'x'.repeat(200), 42]) expect(aiAuditDetailSchema.safeParse({ ...AI, runId: bad }).success).toBe(false);
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
    { reason: 'ai-off' },
    { reason: 'no-provider' },
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
    { reason: 'ai-off', text: 'x' },
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

describe('the fields the audit detail of a call no longer holds', () => {
  it('refuses the hash of filled instructions and the names of pii properties sent', () => {
    expect(aiAuditDetailSchema.safeParse({ ...AI, instructionsSha256: 'b'.repeat(64) }).success).toBe(false);
    expect(aiAuditDetailSchema.safeParse({ ...AI, piiPropertiesSent: ['person.phone'] }).success).toBe(false);
  });
});

describe('the audit detail of a saved pattern', () => {
  const base = { modelRef: 'm', promptId: 'ask.plan', promptVersion: '4', promptSha256: 'a'.repeat(64), tokensIn: 1, tokensOut: 2 };

  it('may say how many patterns a call offered and the hash of the text, and no more', () => {
    expect(parseAiAuditDetail({ ...base, patternCatalog: { count: 2, sha256: 'b'.repeat(64) } })).toMatchObject({ patternCatalog: { count: 2, sha256: 'b'.repeat(64) } });
    expect(parseAiAuditDetail(base)).not.toHaveProperty('patternCatalog');
    expect(() => parseAiAuditDetail({ ...base, patternCatalog: { count: 0, sha256: 'b'.repeat(64) } })).toThrow();
    expect(() => parseAiAuditDetail({ ...base, patternCatalog: { count: 1, sha256: 'b'.repeat(64), text: 'x' } })).toThrow();
  });
});

describe('the detail of a file-query run', () => {
  it('holds the intent and the hash of its query, and for a cancelled or timed-out read the reason', () => {
    expect(parseAuditDetail({ fileQuery: { intent: 'who-knows', queryHash: SHA.replace(/a/g, 'b') } })).toEqual({ fileQuery: { intent: 'who-knows', queryHash: SHA.replace(/a/g, 'b') } });
    expect(parseAuditDetail({ fileQuery: { intent: 'who-knows', queryHash: SHA.replace(/a/g, 'b') }, reason: 'timeout' }).reason).toBe('timeout');
    expect(parseAuditDetail({ fileQuery: {} })).toEqual({ fileQuery: {} });
  });

  it.each([
    ['another field in it', { fileQuery: { intent: 'x', value: 'Pat' } }],
    ['a field beside it', { fileQuery: { intent: 'x' }, counts: { nodes: 1, edges: 0, missing: 0 } }],
    ['an intent that is not a name', { fileQuery: { intent: 'MATCH (n) RETURN n' } }],
    ['a hash that is not a SHA-256', { fileQuery: { queryHash: 'abc' } }],
    ['a reason that is not one of the two', { fileQuery: { intent: 'x' }, reason: 'failed' }],
  ])('refuses %s', (_name, detail) => {
    expect(auditDetailSchema.safeParse(detail).success).toBe(false);
  });
});

describe('the case summary audit detail', () => {
  const detail = { elements: 12, elementsSha256: SHA, calls: 2, modelRef: 'claude-sonnet-5-5', promptId: 'case-summary', promptVersion: '1', instructionsSha256: SHA, outcome: 'ok' };

  it('accepts counts, hashes, the model and prompt and an outcome', () => {
    expect(parseAuditDetail({ summary: detail })).toEqual({ summary: detail });
    expect(auditDetailSchema.safeParse({ summary: { elements: 0, elementsSha256: SHA, calls: 0, outcome: 'unavailable' } }).success).toBe(true);
  });

  it('accepts the counts of the sentences kept and removed, and the outcomes partial and unsupported', () => {
    expect(auditDetailSchema.safeParse({ summary: { ...detail, outcome: 'partial', sentencesKept: 2, sentencesRemoved: 1 } }).success).toBe(true);
    expect(auditDetailSchema.safeParse({ summary: { ...detail, outcome: 'unsupported', sentencesKept: 0, sentencesRemoved: 0 } }).success).toBe(true);
    expect(auditDetailSchema.safeParse({ summary: { ...detail, sentencesKept: -1 } }).success).toBe(false);
  });

  it.each([
    ['a field of text', { ...detail, text: 'a sentence' }],
    ['an outcome that is not one', { ...detail, outcome: 'guilty' }],
    ['a hash that is not a hash', { ...detail, elementsSha256: 'not-a-hash' }],
    ['a count that is not a count', { ...detail, calls: -1 }],
    ['a model reference with a space', { ...detail, modelRef: 'a model name' }],
  ])('refuses %s', (_name, value) => {
    expect(auditDetailSchema.safeParse({ summary: value }).success).toBe(false);
  });
});

describe('the closing event of an assistant turn', () => {
  const MINIMAL = { outcome: 'refused', modelCalls: 0 };
  const FULL = { route: 'ask', outcome: 'answered', intent: 'widgetById', templateId: 'entity', paramsHash: SHA, steps: 1, citedElements: 2, modelCalls: 1, modelRef: 'model-a', promptId: 'assistant.route', promptVersion: '1', instructionsSha256: SHA, tokensIn: 20, tokensOut: 'unknown', runId: '01939999-0000-7000-8000-0000000000ff' };
  const parses = (turn: unknown): boolean => auditDetailSchema.safeParse({ turn }).success;

  it('takes property values sent as a boolean only, never a value', () => {
    expect(parses({ ...MINIMAL, modelCalls: 1, propertyValuesSent: true })).toBe(true);
    expect(parses({ ...MINIMAL, modelCalls: 1, propertyValuesSent: false })).toBe(true);
    for (const bad of ['true', 1, 0, null, { amount: 4200 }, 'Name-1']) expect(parses({ ...MINIMAL, modelCalls: 1, propertyValuesSent: bad })).toBe(false);
  });

  it('takes the table form with counts only, and refuses any other form or a count that is not a count', () => {
    expect(parses({ ...MINIMAL, outcome: 'answered', form: 'table', tableRowsShown: 3, tableRowsDropped: 1, tableRowsNotShown: 2 })).toBe(true);
    expect(parses({ ...MINIMAL, outcome: 'answered', listItemsShown: 3, listItemsDropped: 1 })).toBe(true);
    expect(parses({ ...MINIMAL, outcome: 'answered', listItemsShown: -1 })).toBe(false);
    expect(parses({ ...MINIMAL, outcome: 'answered', listItems: ['text'] })).toBe(false);
    for (const bad of [{ form: 'list' }, { form: 'table', tableRowsShown: -1 }, { form: 'table', tableRowsShown: 'three' }, { form: 'table', tableRowsDropped: 1.5 }, { form: 'table', cells: ['x'] }, { form: 'table', title: 'Accounts' }]) expect(parses({ ...MINIMAL, ...bad })).toBe(false);
  });

  it('takes the minimal and the full shape', () => {
    expect(parses(MINIMAL)).toBe(true);
    expect(parses(FULL)).toBe(true);
    expect(parseAuditDetail({ turn: FULL })).toEqual({ turn: FULL });
  });

  it('takes the number of selected elements the turn kept, and nothing of them', () => {
    expect(parses({ ...FULL, selectedElements: 2 })).toBe(true);
    expect(parses({ ...FULL, selectedElements: 0 })).toBe(true);
  });

  it.each([
    ['no outcome', { modelCalls: 0 }],
    ['no count of calls', { outcome: 'answered' }],
    ['an unknown outcome', { ...MINIMAL, outcome: 'done' }],
    ['a further member', { ...MINIMAL, message: 'x' }],
    ['a free string as a cause', { ...MINIMAL, cause: 'a sentence with spaces' }],
    ['a fractional count', { ...MINIMAL, citedElements: 1.5 }],
    ['a fractional count of selected elements', { ...MINIMAL, selectedElements: 1.5 }],
    ['a negative count of selected elements', { ...MINIMAL, selectedElements: -1 }],
    ['a selected element given as a key', { ...MINIMAL, selectedElements: ['n1'] }],
    ['a negative count', { ...MINIMAL, steps: -1 }],
    ['a plain decimal token count', { ...MINIMAL, tokensIn: 1.5 }],
    ['a malformed hash', { ...MINIMAL, paramsHash: 'abc' }],
    ['a malformed instructions hash', { ...MINIMAL, instructionsSha256: 'A'.repeat(64) }],
    ['a malformed run id', { ...MINIMAL, runId: 'run-1' }],
    ['a template that is not in the catalog', { ...MINIMAL, templateId: 'free-text' }],
  ])('refuses %s', (_name, turn) => {
    expect(parses(turn)).toBe(false);
  });

  it('keeps unknown tokens and an absent count absent', () => {
    expect(parseAuditDetail({ turn: { ...MINIMAL, tokensIn: 'unknown' } })).toEqual({ turn: { ...MINIMAL, tokensIn: 'unknown' } });
    expect(Object.keys(assistantTurnAuditDetailSchema.parse(MINIMAL))).toEqual(['outcome', 'modelCalls']);
  });
});

describe('the run id of the Ask event of an assistant turn', () => {
  const ASKED = { intent: 'widgetById', kind: 'template', outcome: 'complete', templateId: 'entity', paramsHash: SHA, rowCount: 1 };

  it('is an optional UUID of the askRun detail', () => {
    expect(auditDetailSchema.safeParse({ askRun: ASKED }).success).toBe(true);
    expect(auditDetailSchema.safeParse({ askRun: { ...ASKED, runId: '01939999-0000-7000-8000-0000000000ff' } }).success).toBe(true);
    expect(auditDetailSchema.safeParse({ askRun: { ...ASKED, runId: 'run-1' } }).success).toBe(false);
  });
});

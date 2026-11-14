import { describe, expect, it } from 'vitest';
import { askRunAuditDetailSchema, parseAuditDetail } from './audit.js';
import { ASK_REFUSAL_CAUSES } from './ask.js';
import { ASK_REFUSAL_SENTENCES } from './ask-classify.js';
import { askAnswerSchema, askContinueRequestSchema, askQuestionRequestSchema } from './ask-question.js';
import { INVALID_REQUEST_ENTRIES } from './error-table.js';

const TOKEN = `${Date.now() + 1000}.${'a'.repeat(64)}`;
const NODE = { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'A-1' }, display: { title: 'Account A-1', type: 'widget' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };

describe('the request of a question', () => {
  it('takes a source, a question within the limit and an optional mask, and nothing else', () => {
    expect(askQuestionRequestSchema.safeParse({ sourceId: 'demo', question: 'Who is here?' }).success).toBe(true);
    expect(askQuestionRequestSchema.safeParse({ sourceId: 'demo', question: 'x'.repeat(1000), mask: true }).success).toBe(true);
    for (const bad of [{ sourceId: 'demo', question: '  ' }, { sourceId: 'demo', question: '' }, { sourceId: 'demo', question: 'x'.repeat(1001) }, { sourceId: '', question: 'q' }, { sourceId: 'demo', question: 'q', extra: 1 }, { question: 'q' }, { sourceId: 'demo', question: 5 }]) {
      expect(askQuestionRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('counts the question in code points', () => {
    expect(askQuestionRequestSchema.safeParse({ sourceId: 'demo', question: '😀'.repeat(1000) }).success).toBe(true);
    expect(askQuestionRequestSchema.safeParse({ sourceId: 'demo', question: '😀'.repeat(1001) }).success).toBe(false);
  });
});

describe('the request to continue', () => {
  const ok = { sourceId: 'demo', intent: 'byId', entities: { id: 'A-1' }, continueToken: TOKEN };
  it('takes the intent, the entities and a token of the form, with an optional mask', () => {
    expect(askContinueRequestSchema.safeParse(ok).success).toBe(true);
    expect(askContinueRequestSchema.safeParse({ ...ok, mask: false }).success).toBe(true);
  });
  it.each([
    ['an entity that is a number', { entities: { id: 5 } }],
    ['an empty entity', { entities: { id: '' } }],
    ['an entity name with a dash', { entities: { 'a-b': 'x' } }],
    ['an entity over 256 characters', { entities: { id: 'x'.repeat(257) } }],
    ['21 entities', { entities: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`p${index}`, 'v'])) }],
    ['no token at all, as when the answer was a read cut at its bound and carried none', { continueToken: undefined }],
    ['a token without an expiry', { continueToken: 'a'.repeat(64) }],
    ['a token with upper case', { continueToken: `1.${'A'.repeat(64)}` }],
    ['a short token', { continueToken: '1.abc' }],
    ['an intent with a space', { intent: 'by id' }],
    ['an extra field', { extra: true }],
  ])('refuses %s', (_name, over) => {
    expect(askContinueRequestSchema.safeParse({ ...ok, ...over }).success).toBe(false);
  });
});

describe('the answer to a question', () => {
  const result = { templateId: 'entity' as const, result: NODE };
  it('is an answered question with its result, or a refusal with a cause and a fixed sentence', () => {
    expect(askAnswerSchema.safeParse({ answered: { intent: 'byId', entities: { id: 'A-1' }, outcome: 'complete', result } }).success).toBe(true);
    for (const cause of ASK_REFUSAL_CAUSES) expect(askAnswerSchema.safeParse({ refused: { cause, sentence: ASK_REFUSAL_SENTENCES[cause] } }).success, cause).toBe(true);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'missing-inputs', sentence: ASK_REFUSAL_SENTENCES['missing-inputs'], intent: 'byId', parameters: ['id'], found: [], missing: ['id'], extra: [] } }).success).toBe(true);
  });

  it('refuses an unknown cause, a field that could hold free text and an answer with both parts', () => {
    expect(askAnswerSchema.safeParse({ refused: { cause: 'because', sentence: 'x' } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'no-intent', sentence: 'x', reason: 'free text' } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'no-intent', sentence: 'x'.repeat(301) } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ answered: { intent: 'byId', entities: {}, outcome: 'complete', result }, refused: { cause: 'no-intent', sentence: 'x' } }).success).toBe(false);
  });

  it('names the saved pattern that ran only in the answer of the intent saved-pattern, and within the name limit', () => {
    const answered = (intent: string, patternName?: string) => ({ answered: { intent, entities: { pattern: '0195a000-0000-7000-8000-000000000001' }, outcome: 'complete', result, ...(patternName === undefined ? {} : { patternName }) } });
    expect(askAnswerSchema.safeParse(answered('saved-pattern', 'My ring')).success).toBe(true);
    expect(askAnswerSchema.safeParse(answered('saved-pattern')).success).toBe(true);
    expect(askAnswerSchema.safeParse(answered('byId', 'My ring')).success).toBe(false);
    expect(askAnswerSchema.safeParse(answered('saved-pattern', 'x'.repeat(101))).success).toBe(false);
    expect(askAnswerSchema.safeParse(answered('saved-pattern', '   ')).success).toBe(false);
  });

  it('gives a heavy result a token and no summary, and no other result a token', () => {
    const heavy = { templateId: 'shared-attribute' as const, result: { status: 'heavy' as const, templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound' as const, value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] } };
    expect(askAnswerSchema.safeParse({ answered: { intent: 'x', entities: {}, outcome: 'partial', result: heavy, continueToken: TOKEN } }).success).toBe(true);
    expect(askAnswerSchema.safeParse({ answered: { intent: 'x', entities: {}, outcome: 'partial', result: heavy } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ answered: { intent: 'x', entities: {}, outcome: 'complete', result, continueToken: TOKEN } }).success).toBe(false);
  });
});

describe('the audit detail of a question and the reason of a bad token', () => {
  it('holds names, hashes and counts only, and refuses any other field', () => {
    const detail = { intent: 'byId', kind: 'template' as const, outcome: 'complete' as const, templateId: 'entity', cause: 'nothing-found', paramsHash: 'a'.repeat(64), rowCount: 1 };
    expect(askRunAuditDetailSchema.parse(detail)).toEqual(detail);
    expect(parseAuditDetail({ askRun: detail })).toEqual({ askRun: detail });
    const pattern = { ...detail, intent: 'saved-pattern', templateId: 'saved-pattern', patternId: '0195a000-0000-7000-8000-000000000001', patternVersion: 3 };
    expect(askRunAuditDetailSchema.parse(pattern)).toEqual(pattern);
    for (const bad of [{ ...pattern, patternId: 'My ring' }, { ...pattern, patternVersion: 0 }, { ...pattern, patternVersion: 1.5 }, { ...pattern, patternName: 'My ring' }]) {
      expect(askRunAuditDetailSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{ ...detail, entity: 'A-1' }, { ...detail, paramsHash: 'short' }, { ...detail, kind: 'plan' }, { ...detail, outcome: 'ok' }, { ...detail, rowCount: -1 }, { ...detail, cause: 'Because Of Text' }, { ...detail, cause: 'smith' }, { ...detail, templateId: 'smith' }]) {
      expect(askRunAuditDetailSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('has a sentence for the reason continue-invalid', () => {
    expect(INVALID_REQUEST_ENTRIES['continue-invalid'].message).toContain('continue');
  });
});

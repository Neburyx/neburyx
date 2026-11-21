import { describe, expect, it } from 'vitest';
import { askRunAuditDetailSchema, parseAuditDetail } from './audit.js';
import { ASK_REFUSAL_CAUSES } from './ask.js';
import { ASK_REFUSAL_SENTENCES, valueNotFitSentence } from './ask-classify.js';
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
    // the cause of a value that does not fit also carries its kind and types (below)
    for (const cause of ASK_REFUSAL_CAUSES.filter((each) => each !== 'value-not-fit')) expect(askAnswerSchema.safeParse({ refused: { cause, sentence: ASK_REFUSAL_SENTENCES[cause] } }).success, cause).toBe(true);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'missing-inputs', sentence: ASK_REFUSAL_SENTENCES['missing-inputs'], intent: 'byId', parameters: ['id'], found: [], missing: ['id'], extra: [] } }).success).toBe(true);
  });

  it('refuses an unknown cause, a field that could hold free text and an answer with both parts', () => {
    expect(askAnswerSchema.safeParse({ refused: { cause: 'because', sentence: 'x' } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'no-intent', sentence: 'x', reason: 'free text' } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ refused: { cause: 'no-intent', sentence: 'x'.repeat(301) } }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ answered: { intent: 'byId', entities: {}, outcome: 'complete', result }, refused: { cause: 'no-intent', sentence: 'x' } }).success).toBe(false);
  });

  it('takes a label of 1 to 80 characters on the answer of an intent, and refuses an empty or longer one', () => {
    const answered = (label: string) => ({ answered: { intent: 'byId', entities: {}, outcome: 'complete', result, label } });
    expect(askAnswerSchema.safeParse(answered('Account by id')).success).toBe(true);
    expect(askAnswerSchema.safeParse(answered('x'.repeat(80))).success).toBe(true);
    expect(askAnswerSchema.safeParse(answered('')).success).toBe(false);
    expect(askAnswerSchema.safeParse(answered('x'.repeat(81))).success).toBe(false);
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

describe('a value that does not fit the type its role needs', () => {
  const REF = { sourceId: 'demo', entityType: 'gadget', stableId: 'A-1' };
  const refusal = (valueNotFit?: unknown, cause = 'value-not-fit') => ({ refused: { cause, sentence: 'x', intent: 'shared', ...(valueNotFit === undefined ? {} : { valueNotFit }) } });
  const OTHER = { kind: 'other-type', needed: 'widget', found: 'gadget', citation: { ref: REF, title: 'Gadget A-1', type: 'gadget' } };

  it('is a refusal of the cause `value-not-fit` that names the kind, the type the question needs and, for another type, the type found and the cited element', () => {
    expect(ASK_REFUSAL_CAUSES).toContain('value-not-fit');
    for (const fit of [OTHER, { kind: 'not-found', needed: 'widget' }, { kind: 'hidden', needed: 'widget' }]) expect(askAnswerSchema.safeParse(refusal(fit)).success, JSON.stringify(fit)).toBe(true);
  });

  it('is refused when the cause has no kind, another cause carries one, another type has no type found or no citation, or another kind names a type found', () => {
    for (const bad of [
      refusal(undefined),
      refusal(OTHER, 'nothing-found'),
      refusal({ kind: 'other-type', needed: 'widget' }),
      refusal({ kind: 'other-type', needed: 'widget', found: 'gadget' }),
      refusal({ kind: 'not-found', needed: 'widget', found: 'gadget' }),
      refusal({ kind: 'hidden', needed: 'widget', citation: OTHER.citation }),
      refusal({ kind: 'guess', needed: 'widget' }),
      refusal({ ...OTHER, extra: 1 }),
    ]) expect(askAnswerSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('has one sentence for each kind, built from types and a title only: the type found and the type needed for another type, "no <type> with that id" for none, and a neutral one for hidden', () => {
    const other = valueNotFitSentence({ kind: 'other-type', needed: 'widget', found: 'gadget', title: 'Gadget A-1' });
    expect(other).toBe('Gadget A-1 is a gadget; this question needs a widget. Nothing was run.');
    expect(valueNotFitSentence({ kind: 'not-found', needed: 'widget' })).toBe('There is no widget with that id. Nothing was run.');
    const hidden = valueNotFitSentence({ kind: 'hidden', needed: 'widget' });
    expect(hidden).toBe('That value does not give a widget this question can use. Nothing was run.');
    for (const sentence of [other, hidden, valueNotFitSentence({ kind: 'not-found', needed: 'widget' }), ASK_REFUSAL_SENTENCES['value-not-fit']]) expect(sentence).not.toMatch(/nothing (was )?found|nothing matches|no (one|match)/i);
    expect(hidden).not.toMatch(/exist|no widget|not found/i);
  });

  it('says of a step of a tool loop after reads that ran that the step was not run and the results above stand, for each kind', () => {
    const later = (kind: 'other-type' | 'not-found' | 'hidden') => valueNotFitSentence({ kind, needed: 'widget', found: 'gadget', title: 'Gadget A-1', laterStep: true });
    expect(later('other-type')).toBe('Gadget A-1 is a gadget; this question needs a widget. That step was not run; the results above stand.');
    expect(later('not-found')).toBe('There is no widget with that id. That step was not run; the results above stand.');
    expect(later('hidden')).toBe('That value does not give a widget this question can use. That step was not run; the results above stand.');
    for (const kind of ['other-type', 'not-found', 'hidden'] as const) expect(later(kind)).not.toContain('Nothing was run');
  });

  it('uses the masked title the gate gave and no other text of the request', () => {
    expect(valueNotFitSentence({ kind: 'other-type', needed: 'widget', found: 'gadget', title: '••••• 42' })).toContain('••••• 42 is a gadget');
  });
});

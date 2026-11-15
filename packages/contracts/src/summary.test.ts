import { describe, expect, it } from 'vitest';
import { summaryReadingSchema, summaryRequestSchema, summaryResponseSchema } from './summary.js';

const entity = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const coverage = { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' };
const draft = { sentences: [{ text: 'A sentence.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref: entity }], coverage, removedCount: 0, sent: 'text', model: 'm', calls: 1, summaryToken: 'v1.token' };

describe('the summary request', () => {
  it('takes the four lists of references, each empty by default, and nothing else', () => {
    expect(summaryRequestSchema.parse({ investigationId: 'i', sourceId: 's' })).toEqual({ investigationId: 'i', sourceId: 's', entities: [], edges: [], aggregates: [], derived: [] });
    expect(summaryRequestSchema.safeParse({ investigationId: 'i', sourceId: 's', text: 'x' }).success).toBe(false);
  });
});

describe('the summary response', () => {
  it.each([
    ['ok', { status: 'ok', ...draft }],
    ['partial', { status: 'partial', ...draft, removedCount: 2 }],
    ['unsupported', { status: 'unsupported', removedCount: 3, coverage, sent: 'text', model: 'm', calls: 2 }],
    ['tooLarge for the elements', { status: 'tooLarge', limit: 'elements', elements: 4, cap: 3 }],
    ['tooLarge for the text', { status: 'tooLarge', limit: 'text', estimatedTokens: 9, cap: 5 }],
    ['timeLimit', { status: 'timeLimit', calls: 2 }],
    ['failed', { status: 'failed', kind: 'unreachable', calls: 1 }],
  ])('accepts %s', (_name, value) => {
    expect(summaryResponseSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['an unsupported answer with sentences or a token', { status: 'unsupported', removedCount: 3, coverage, sent: 'text', model: 'm', calls: 2, sentences: [], summaryToken: 'x' }],
    ['a draft with no coverage line', { status: 'ok', ...draft, coverage: undefined }],
    ['a partial answer with no count removed', { status: 'partial', ...draft, removedCount: undefined }],
    ['a failure kind that is not one', { status: 'failed', kind: 'guilty', calls: 1 }],
    ['an unknown status', { status: 'done', calls: 1 }],
  ])('refuses %s', (_name, value) => {
    expect(summaryResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe('the reading of a view', () => {
  it('holds the elements, the unresolved count, the omission flag and the not-yet-retrieved count with its uncounted entities', () => {
    expect(summaryReadingSchema.safeParse({ nodes: [], edges: [], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 }).success).toBe(true);
    expect(summaryReadingSchema.safeParse({ nodes: [], edges: [], unresolved: -1, omitted: false, notRetrieved: { quality: 'unknown', scope: 'coverage' }, uncounted: 0 }).success).toBe(false);
  });
});

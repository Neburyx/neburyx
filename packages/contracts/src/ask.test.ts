import { describe, expect, it } from 'vitest';
import { isHeavyResult, ASK_PLAN_PARAMS, ASK_PLAN_TEMPLATE_IDS, askRunResultSchema, askSummarySchema, storedSavedPatternParamsSchema, ASK_SUMMARY_MAX_CITATIONS, ASK_SUMMARY_MAX_SENTENCES, ASK_SUMMARY_MAX_SENTENCE_LENGTH } from './ask.js';

describe('the result of a run', () => {
  it('has a variant for each template of the catalog, one for a file query and one for a saved pattern, and no other', () => {
    expect(askRunResultSchema.options).toHaveLength(ASK_PLAN_TEMPLATE_IDS.length + 2);
    expect(askRunResultSchema.options.map((option) => option.shape.templateId.value).sort()).toEqual([...ASK_PLAN_TEMPLATE_IDS, 'file-query', 'saved-pattern'].sort());
  });

  it('says a saved run that stopped as heavy is heavy, and a saved run that ran is not', () => {
    const heavy = { templateId: 'saved-pattern', result: { status: 'heavy', templateVersion: '1', estimate: { quality: 'lowerBound', value: 500, scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] } };
    expect(askRunResultSchema.safeParse(heavy).success).toBe(true);
    expect(isHeavyResult(askRunResultSchema.parse(heavy))).toBe(true);
    const ok = { templateId: 'saved-pattern', result: { status: 'ok', templateVersion: '1', count: { quality: 'exact', value: 0, scope: 'matches' }, matches: [], nodes: [], edges: [], notices: [], warnings: [] } };
    expect(isHeavyResult(askRunResultSchema.parse(ok))).toBe(false);
    expect(askRunResultSchema.safeParse({ ...ok, result: { status: 'unavailable', reasons: [{ code: 'preset-removed' }] } }).success).toBe(false);
  });
});


const ANCHOR = { entityType: 'node_a', stableId: 'A-1' };
const PLANS: Readonly<Record<string, Record<string, unknown>>> = {
  'shared-attribute': { ref: ANCHOR, attributeType: 'attr_type', via: 'attr_link', window: { days: 90 }, limit: 25 },
  'linked-entities': { ref: ANCHOR, targetType: 'target_type', via: ['link_type'], maxHops: 2 },
  entity: { ref: ANCHOR },
  'degree-preview': { ref: ANCHOR },
  expand: { ref: ANCHOR, relTypes: ['link_a'], neighborTypes: ['node_b'], direction: 'out', sort: 'observed', window: { days: 7 }, limit: 25 },
  'derived-rule-run': { ref: ANCHOR, ruleId: 'rule_a' },
  'derived-edge-support': { ruleId: 'rule_a', ends: [ANCHOR, { entityType: 'node_a', stableId: 'A-2' }] },
  search: { entityTypes: ['node_b'], text: 'PAY-77' },
};
const paramsOf = (templateId: string) => ASK_PLAN_PARAMS[templateId as keyof typeof ASK_PLAN_PARAMS];

describe('the parameters of the templates Ask can plan', () => {
  it.each(Object.entries(PLANS))('accepts the parameters of a %s plan', (templateId, params) => {
    expect(paramsOf(templateId).safeParse(params).success).toBe(true);
  });

  it('holds the eight templates, and in no template a source, a mask, a cursor, a continue flag, a filter or a rank', () => {
    expect([...ASK_PLAN_TEMPLATE_IDS].sort()).toEqual(['degree-preview', 'derived-edge-support', 'derived-rule-run', 'entity', 'expand', 'linked-entities', 'search', 'shared-attribute']);
    const names = new Set(Object.values(ASK_PLAN_PARAMS).flatMap((schema) => Object.keys(schema.shape)));
    for (const excluded of ['sourceId', 'mask', 'cursors', 'continue', 'filters', 'rank', 'typeahead']) expect(names.has(excluded)).toBe(false);
  });

  it.each([
    ['a parameter of another template', 'expand', { ...PLANS['expand'], ruleId: 'rule_a' }],
    ['an unknown parameter', 'entity', { ref: ANCHOR, extra: 1 }],
    ['filters on an expand', 'expand', { ...PLANS['expand'], filters: [{ property: 'p', op: 'eq', value: 'x' }] }],
    ['a rank on an expand', 'expand', { ...PLANS['expand'], rank: { by: 'p' } }],
    ['a cursor on an expand', 'expand', { ...PLANS['expand'], cursors: { node_b: 'abc' } }],
    ['a limit of 0 on an expand', 'expand', { ...PLANS['expand'], limit: 0 }],
    ['a source on a search', 'search', { ...PLANS['search'], sourceId: 'demo' }],
    ['a typeahead on a search', 'search', { ...PLANS['search'], typeahead: true }],
    ['three ends on an edge support', 'derived-edge-support', { ruleId: 'r', ends: [ANCHOR, ANCHOR, ANCHOR] }],
    ['no neighbor types on an expand', 'expand', { ref: ANCHOR }],
    ['parameters of another template', 'linked-entities', PLANS['shared-attribute']],
  ])('rejects %s', (_name, templateId, params) => {
    expect(paramsOf(templateId).safeParse(params).success).toBe(false);
  });

  it('takes a saved pattern in the stored form with the id and version and optionally the reference, and refuses the rest', () => {
    const id = '0195a000-0000-7000-8000-000000000001';
    expect(storedSavedPatternParamsSchema.safeParse({ patternId: id, patternVersion: 3, ref: ANCHOR }).success).toBe(true);
    expect(storedSavedPatternParamsSchema.safeParse({ patternId: id, patternVersion: 3 }).success).toBe(true);
    for (const bad of [{ patternId: 'not-an-id', patternVersion: 1 }, { patternId: id, patternVersion: 0 }, { patternKey: 'pat_1' }, { patternId: id, patternVersion: 1, name: 'x' }, {}]) {
      expect(storedSavedPatternParamsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is not one of the templates of the catalog', () => {
    expect([...ASK_PLAN_TEMPLATE_IDS]).not.toContain('saved-pattern');
  });
});

describe('the summary of a run answer', () => {
  const ref = { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' };
  const citation = (key: string, over: object = {}) => ({ key, element: ref, type: 'node_a', title: 'A', ...over });
  const summary = { sentences: [{ text: 'One match.', cites: ['n1'] }], citations: [citation('n1')] };

  it('refuses a sentence with no key, a key no citation holds, a citation no sentence cites and two citations with one key', () => {
    expect(askSummarySchema.safeParse({ ...summary, sentences: [{ text: 'x', cites: [] }] }).success).toBe(false);
    expect(askSummarySchema.safeParse({ ...summary, sentences: [{ text: 'x', cites: ['n9'] }] }).success).toBe(false);
    expect(askSummarySchema.safeParse({ ...summary, citations: [citation('n1'), citation('n2')] }).success).toBe(false);
    expect(askSummarySchema.safeParse({ ...summary, citations: [citation('n1'), citation('n1')] }).success).toBe(false);
  });

  it('refuses citations of more than one source, and takes a relationship reference as an element', () => {
    const other = { sourceId: 'other', entityType: 'node_a', stableId: 'a-2' };
    const both = { sentences: [{ text: 'x', cites: ['n1', 'n2'] }], citations: [citation('n1'), citation('n2', { element: other })] };
    expect(askSummarySchema.safeParse(both).success).toBe(false);
    const edge = { sourceId: 'demo', type: 'HOLDS', from: 'a-1', to: 'a-2', stableId: 'r-1' };
    expect(askSummarySchema.safeParse({ ...summary, citations: [citation('n1', { element: edge, type: 'HOLDS', title: 'HOLDS: A → B' })] }).success).toBe(true);
  });

  it('refuses a summary over the limits of sentences, of a sentence and of citations, and takes one at each limit', () => {
    const keys = Array.from({ length: ASK_SUMMARY_MAX_CITATIONS }, (_, index) => `n${index + 1}`);
    const atLimit = { sentences: Array.from({ length: ASK_SUMMARY_MAX_SENTENCES }, (_, index) => ({ text: 'x'.repeat(ASK_SUMMARY_MAX_SENTENCE_LENGTH), cites: index === 0 ? keys : ['n1'] })), citations: keys.map((key) => citation(key)) };
    expect(askSummarySchema.safeParse(atLimit).success).toBe(true);
    expect(askSummarySchema.safeParse({ ...atLimit, sentences: [...atLimit.sentences, { text: 'x', cites: ['n1'] }] }).success).toBe(false);
    expect(askSummarySchema.safeParse({ ...atLimit, sentences: [{ text: 'x'.repeat(ASK_SUMMARY_MAX_SENTENCE_LENGTH + 1), cites: keys }] }).success).toBe(false);
    expect(askSummarySchema.safeParse({ ...atLimit, citations: [...atLimit.citations, citation('n41')] }).success).toBe(false);
  });
});

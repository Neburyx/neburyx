import { describe, expect, it } from 'vitest';
import { isHeavyResult, ASK_PLAN_PARAM_NAMES, ASK_PLAN_TEMPLATE_IDS, askPlanRequestSchema, askPlanResponseSchema, askPlanSchema, askResolutionSchema, askResolutionsSchema, askRunRequestSchema, askRunResponseSchema, askRunResultSchema, askEditRequestSchema, askEditResponseSchema, askCancelRequestSchema, askCancelResponseSchema, ASK_MAX_RESOLUTIONS, ASK_MESSAGE_MAX_LENGTH, askSummarySchema, ASK_SUMMARY_MAX_CITATIONS, ASK_SUMMARY_MAX_SENTENCES, ASK_SUMMARY_MAX_SENTENCE_LENGTH } from './ask.js';

const REF = { entityType: 'node_a', stableId: 'A-1' };
const SHARED = { kind: 'plan', templateId: 'shared-attribute', templateVersion: 1, params: { ref: REF, attributeType: 'attr_type', via: 'attr_link', window: { days: 90 }, limit: 25 }, rationale: 'People who share a device.' };
const LINKED = { kind: 'plan', templateId: 'linked-entities', templateVersion: 1, params: { ref: REF, targetType: 'target_type', via: ['link_type'], maxHops: 2 }, rationale: 'Merchants reached by payments.' };

describe('the plan a planner answers', () => {
  it.each([['a shared-attribute plan', SHARED], ['a linked-entities plan', LINKED], ['an unsupported plan', { kind: 'unsupported', reason: 'No template fits this question.' }]])('accepts %s', (_name, plan) => {
    expect(askPlanSchema.safeParse(plan).success).toBe(true);
  });

  it.each([
    ['an unknown template', { ...SHARED, templateId: 'free-query' }],
    ['parameters that do not fit their template', { ...SHARED, params: { ...SHARED.params, direction: 'out' } }],
    ['parameters of another template', { ...LINKED, params: SHARED.params }],
    ['a text field beside the parameters', { ...SHARED, query: 'MATCH (n) RETURN n' }],
    ['a plan with no rationale', { ...SHARED, rationale: '' }],
    ['an unsupported plan with no reason', { kind: 'unsupported' }],
    ['an unknown kind', { kind: 'run', templateId: 'shared-attribute' }],
  ])('rejects %s', (_name, plan) => {
    expect(askPlanSchema.safeParse(plan).success).toBe(false);
  });
});

describe('the body of the plan endpoint', () => {
  it('takes one non-empty message of at most the limit and the source it is asked in, and nothing else', () => {
    expect(askPlanRequestSchema.safeParse({ message: 'Who shares a device?', sourceId: 's' }).success).toBe(true);
    expect(askPlanRequestSchema.safeParse({ message: '𝒳'.repeat(ASK_MESSAGE_MAX_LENGTH), sourceId: 's' }).success).toBe(true);
    for (const body of [{}, { message: 'Who shares a device?' }, { message: '', sourceId: 's' }, { message: 3, sourceId: 's' }, { message: '𝒳'.repeat(ASK_MESSAGE_MAX_LENGTH + 1), sourceId: 's' }, { message: 'x', sourceId: 's', send: true }, { sourceId: 's' }, { message: 'x', sourceId: '' }]) {
      expect(askPlanRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the body of the plan endpoint with the preview fields', () => {
  const hash = 'a'.repeat(64);
  const ref = { sourceId: 's', entityType: 'widget', stableId: 'w-1' };

  it('takes the resolutions, send and a preview hash, all optional', () => {
    expect(askPlanRequestSchema.safeParse({ message: 'x', sourceId: 's', resolutions: [{ start: 0, end: 1, ref }], send: false }).success).toBe(true);
    expect(askPlanRequestSchema.safeParse({ message: 'x', sourceId: 's', send: true, previewHash: hash }).success).toBe(true);
  });

  it('refuses a send without a hash, a hash that is not 64 lowercase hex characters, and an unknown field', () => {
    for (const body of [
      { message: 'x', sourceId: 's', send: true },
      { message: 'x', sourceId: 's', previewHash: 'abc' },
      { message: 'x', sourceId: 's', previewHash: 'A'.repeat(64) },
      { message: 'x', sourceId: 's', previewHash: `${hash}0` },
      { message: 'x', sourceId: 's', resolutions: [{ start: 0, end: 1 }] },
      { message: 'x', sourceId: '' },
      { message: 'x', sourceId: 's', allowWords: ['y'] },
    ]) {
      expect(askPlanRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the answer of the plan endpoint', () => {
  const hash = 'b'.repeat(64);
  const PLAN_ID = '01939999-0000-7000-8000-0000000000bb';
  const ENTITY_PLAN = { kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'one entity', params: { ref: { entityType: 'node_a', stableId: 'a-1' } } };

  it.each([
    ['a refusal with its family', { plan: { kind: 'unsupported', family: 'judgement', reason: 'no template' } }],
    ['a plan of a template, with its ID and expiry', { plan: ENTITY_PLAN, planId: PLAN_ID, expiresAt: '2026-11-13T10:15:00.000Z' }],
    ['a clarification', { clarification: { start: 0, end: 3, choices: [], count: { quality: 'exact', value: 0, scope: 'exact matches' }, unreferenced: 0 } }],
    ['the blocked tokens', { blocked: { tokens: [{ text: 'zorvath', start: 6, end: 13 }] } }],
    ['a preview', { preview: 'which widgets', previewHash: hash }],
    ['a changed preview', { preview: 'which widgets', previewHash: hash, changed: true }],
  ])('takes %s', (_name, body) => {
    expect(askPlanResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['a plan of a template with no ID', { plan: ENTITY_PLAN, expiresAt: '2026-11-13T10:15:00.000Z' }],
    ['a plan of a template with no expiry', { plan: ENTITY_PLAN, planId: PLAN_ID }],
    ['an ID that is not a uuid', { plan: ENTITY_PLAN, planId: 'p-1', expiresAt: '2026-11-13T10:15:00.000Z' }],
    ['an expiry that is not a time', { plan: ENTITY_PLAN, planId: PLAN_ID, expiresAt: 'soon' }],
    ['an unsupported plan with an ID', { plan: { kind: 'unsupported', reason: 'no template' }, planId: PLAN_ID }],
    ['an unsupported plan with an expiry', { plan: { kind: 'unsupported', reason: 'no template' }, expiresAt: '2026-11-13T10:15:00.000Z' }],
    ['a preview without its hash', { preview: 'x' }],
    ['a changed flag that is false', { preview: 'x', previewHash: hash, changed: false }],
    ['blocked tokens that are none', { blocked: { tokens: [] } }],
    ['a refusal without a family', { plan: { kind: 'unsupported', reason: 'no template' } }],
    ['a refusal with a family off the list', { plan: { kind: 'unsupported', family: 'made-up', reason: 'no template' } }],
    ['two answers at once', { preview: 'x', previewHash: hash, blocked: { tokens: [{ text: 'a', start: 0, end: 1 }] } }],
  ])('refuses %s', (_name, body) => {
    expect(askPlanResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the plan of a planner', () => {
  it('takes a refusal with a family, and one without (the add-only change)', () => {
    expect(askPlanSchema.safeParse({ kind: 'unsupported', family: 'path', reason: 'x' }).success).toBe(true);
    expect(askPlanSchema.safeParse({ kind: 'unsupported', reason: 'x' }).success).toBe(true);
    expect(askPlanSchema.safeParse({ kind: 'unsupported', family: 'made-up', reason: 'x' }).success).toBe(false);
  });
});

describe('the body of the run endpoint', () => {
  const planId = '0192f000-0000-7000-8000-0000000000a1';

  it('takes one plan ID that is a uuid and a mask flag that is a boolean, and nothing else', () => {
    expect(askRunRequestSchema.safeParse({ planId }).success).toBe(true);
    expect(askRunRequestSchema.safeParse({ planId, mask: true }).success).toBe(true);
    expect(askRunRequestSchema.safeParse({ planId, mask: false }).success).toBe(true);
    expect(askRunRequestSchema.safeParse({ planId, continue: true, continueToken: 'c'.repeat(64) }).success).toBe(true);
    for (const body of [{}, { planId: 'plan-1' }, { planId: 7 }, { planId, send: true }, { planId, mask: 'yes' }, { planId, mask: null }, { mask: true }, { planId, continue: true }, { planId, continueToken: 'c'.repeat(64) }, { planId, continue: false, continueToken: 'c'.repeat(64) }, { planId, continue: 'yes', continueToken: 'c'.repeat(64) }, { planId, continue: true, continueToken: 'short' }, { planId, continue: true, continueToken: 'C'.repeat(64) }]) {
      expect(askRunRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('the answer of the run endpoint', () => {
  const planId = '0192f000-0000-7000-8000-0000000000a1';
  const exact = { quality: 'exact', value: 0, scope: 'test' };
  const node = { ref: { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' }, display: { title: 'A', type: 'node_a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
  const shared = { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: exact, matchIds: [], nodes: [], edges: [], notices: [], warnings: [] };
  const heavy = { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] };
  const degree = { ref: node.ref, total: exact, byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
  const expanded = { ref: node.ref, pageSize: 25, nodes: [], edges: [], pages: [], warnings: [] };
  const derived = { ref: node.ref, results: [] };

  it.each([
    ['a shared-attribute result', { templateId: 'shared-attribute', result: shared }],
    ['a linked-entities result', { templateId: 'linked-entities', result: { ...shared, templateId: 'linked-entities' } }],
    ['an entity', { templateId: 'entity', result: node }],
    ['a degree preview', { templateId: 'degree-preview', result: degree }],
    ['an expansion', { templateId: 'expand', result: expanded }],
    ['the derived neighbors of a rule', { templateId: 'derived-rule-run', result: derived }],
  ])('takes %s with the outcome complete or partial', (_name, result) => {
    for (const outcome of ['complete', 'partial']) expect(askRunResponseSchema.safeParse({ planId, outcome, result }).success).toBe(true);
  });

  const token = 'c'.repeat(64);

  it('takes the stop of a heavy run only with a continue token, and only that result with one', () => {
    const stop = { templateId: 'shared-attribute', result: heavy };
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'partial', result: stop, continueToken: token }).success).toBe(true);
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'partial', result: { templateId: 'linked-entities', result: { ...heavy, templateId: 'linked-entities' } }, continueToken: token }).success).toBe(true);
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'partial', result: stop }).success).toBe(false);
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'complete', result: { templateId: 'entity', result: node }, continueToken: token }).success).toBe(false);
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'partial', result: stop, continueToken: 'short' }).success).toBe(false);
    expect(askRunResponseSchema.safeParse({ planId, outcome: 'partial', result: { templateId: 'shared-attribute', result: shared }, continueToken: token }).success).toBe(false);
  });

  it.each([
    ['the outcome failed, which only the record of a run says', { planId, outcome: 'failed', result: { templateId: 'entity', result: node } }],
    ['no result', { planId, outcome: 'complete' }],
    ['no outcome', { planId, result: { templateId: 'entity', result: node } }],
    ['a result of another template than the one it names', { planId, outcome: 'complete', result: { templateId: 'entity', result: degree } }],
    ['a template of no catalog', { planId, outcome: 'complete', result: { templateId: 'free-query', result: node } }],
    ['a result with a field it does not know', { planId, outcome: 'complete', result: { templateId: 'entity', result: node, query: 'x' } }],
    ['a plan ID that is not a uuid', { planId: 'p', outcome: 'complete', result: { templateId: 'entity', result: node } }],
  ])('refuses %s', (_name, body) => {
    expect(askRunResponseSchema.safeParse(body).success).toBe(false);
  });

  it('has a variant for each template of the catalog and one for a saved pattern, and no other', () => {
    expect(askRunResultSchema.options).toHaveLength(ASK_PLAN_TEMPLATE_IDS.length + 1);
    expect(askRunResultSchema.options.map((option) => option.shape.templateId.value).sort()).toEqual([...ASK_PLAN_TEMPLATE_IDS, 'saved-pattern'].sort());
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

describe('the resolutions of a question', () => {
  const picked = { start: 3, end: 9, ref: { sourceId: 'src', entityType: 'node_a', stableId: 'A-1' } };

  it.each([['a pick of an entity', picked], ['a span marked as a value', { start: 0, end: 4, value: true }]])('accepts %s', (_name, resolution) => {
    expect(askResolutionSchema.safeParse(resolution).success).toBe(true);
  });

  it.each([
    ['an extra field', { ...picked, label: 'x' }],
    ['a negative start', { ...picked, start: -1 }],
    ['an empty span', { ...picked, start: 4, end: 4 }],
    ['a span that ends before it starts', { ...picked, start: 5, end: 4 }],
    ['no reference and no value', { start: 0, end: 4 }],
    ['both a reference and a value', { ...picked, value: true }],
    ['a value other than true', { start: 0, end: 4, value: false }],
    ['a reference with no stable ID', { ...picked, ref: { sourceId: 'src', entityType: 'node_a' } }],
  ])('rejects %s', (_name, resolution) => {
    expect(askResolutionSchema.safeParse(resolution).success).toBe(false);
  });

  it('takes at most the allowed number of resolutions', () => {
    const many = (count: number) => Array.from({ length: count }, () => picked);
    expect(askResolutionsSchema.safeParse(many(ASK_MAX_RESOLUTIONS)).success).toBe(true);
    expect(askResolutionsSchema.safeParse(many(ASK_MAX_RESOLUTIONS + 1)).success).toBe(false);
  });
});

const ANCHOR = { entityType: 'node_a', stableId: 'A-1' };
const PLANS: Readonly<Record<string, Record<string, unknown>>> = {
  entity: { ref: ANCHOR },
  'degree-preview': { ref: ANCHOR },
  expand: { ref: ANCHOR, relTypes: ['link_a'], neighborTypes: ['node_b'], direction: 'out', sort: 'observed', window: { days: 7 }, limit: 25 },
  'derived-rule-run': { ref: ANCHOR, ruleId: 'rule_a' },
  'derived-edge-support': { ruleId: 'rule_a', ends: [ANCHOR, { entityType: 'node_a', stableId: 'A-2' }] },
  search: { entityTypes: ['node_b'], text: 'PAY-77' },
};
const planOf = (templateId: string, params: Record<string, unknown>) => ({ kind: 'plan', templateId, templateVersion: 1, params, rationale: 'A plan.' });

describe('the plans for the other templates', () => {
  it.each(Object.entries(PLANS))('accepts a %s plan', (templateId, params) => {
    expect(askPlanSchema.safeParse(planOf(templateId, params)).success).toBe(true);
  });

  it('holds the eight templates, and in no plan a source, a mask, a cursor, a continue flag, a filter or a rank', () => {
    expect([...ASK_PLAN_TEMPLATE_IDS].sort()).toEqual(['degree-preview', 'derived-edge-support', 'derived-rule-run', 'entity', 'expand', 'linked-entities', 'search', 'shared-attribute']);
    for (const excluded of ['sourceId', 'mask', 'cursors', 'continue', 'filters', 'rank', 'typeahead']) expect(ASK_PLAN_PARAM_NAMES).not.toContain(excluded);
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
  ])('rejects %s', (_name, templateId, params) => {
    expect(askPlanSchema.safeParse(planOf(templateId, params)).success).toBe(false);
  });

  it('rejects a text field beside the parameters of a new template', () => {
    expect(askPlanSchema.safeParse({ ...planOf('entity', { ref: ANCHOR }), query: 'x' }).success).toBe(false);
  });
});

describe('the edit and cancel endpoints', () => {
  const planId = '01939999-0000-7000-8000-0000000000bb';
  const plan = { kind: 'plan', templateId: 'entity', templateVersion: 1, rationale: 'one entity', params: { ref: { entityType: 'node_a', stableId: 'a-1' } } };

  it.each([
    ['an edit with its plan, template and parameters', { planId, templateId: 'entity', params: { ref: { sourceId: 'demo', entityType: 'node_a', stableId: 'a-2' } } }],
  ])('takes %s', (_name, body) => {
    expect(askEditRequestSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['no plan', { templateId: 'entity', params: {} }],
    ['a plan ID that is not a uuid', { planId: 'p-1', templateId: 'entity', params: {} }],
    ['no template', { planId, params: {} }],
    ['a template of no catalog', { planId, templateId: 'free-query', params: {} }],
    ['no parameters', { planId, templateId: 'entity' }],
    ['parameters that are not an object', { planId, templateId: 'entity', params: 'ref' }],
    ['a field it does not know', { planId, templateId: 'entity', params: {}, sourceId: 'demo' }],
  ])('refuses an edit with %s', (_name, body) => {
    expect(askEditRequestSchema.safeParse(body).success).toBe(false);
  });

  it('answers an edit with the new plan, its ID and its expiry, and nothing without them', () => {
    expect(askEditResponseSchema.safeParse({ plan, planId, expiresAt: '2026-11-13T10:15:00.000Z' }).success).toBe(true);
    expect(askEditResponseSchema.safeParse({ plan }).success).toBe(false);
    expect(askEditResponseSchema.safeParse({ plan: { kind: 'unsupported', reason: 'x' }, planId, expiresAt: '2026-11-13T10:15:00.000Z' }).success).toBe(false);
  });

  it('takes one plan ID that is a uuid to cancel, and answers it as cancelled', () => {
    expect(askCancelRequestSchema.safeParse({ planId }).success).toBe(true);
    for (const body of [{}, { planId: 'x' }, { planId, extra: 1 }]) expect(askCancelRequestSchema.safeParse(body).success).toBe(false);
    expect(askCancelResponseSchema.safeParse({ planId, state: 'cancelled' }).success).toBe(true);
    expect(askCancelResponseSchema.safeParse({ planId, state: 'run' }).success).toBe(false);
  });
});

describe('a plan that names a saved pattern', () => {
  const planned = { kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'The saved pattern fits.', params: { patternKey: 'pat_1', ref: { entityType: 'widget', stableId: '‹widget#1›' } } };
  const stored = { kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'The saved pattern fits.', params: { patternId: '0195a000-0000-7000-8000-000000000001', patternVersion: 3, ref: { entityType: 'widget', stableId: 'w-1' } } };

  it('is read in the form the model gives, with the key and optionally the reference, and in the stored form with the id and version', () => {
    expect(askPlanSchema.safeParse(planned).success).toBe(true);
    expect(askPlanSchema.safeParse({ ...planned, params: { patternKey: 'pat_12' } }).success).toBe(true);
    expect(askPlanSchema.safeParse(stored).success).toBe(true);
    expect(askPlanSchema.safeParse({ ...stored, params: { patternId: stored.params.patternId, patternVersion: 3 } }).success).toBe(true);
  });

  it.each([
    ['a key that is not of the form pat_n', { patternKey: 'Secret name' }],
    ['a key with a leading zero', { patternKey: 'pat_01' }],
    ['both a key and an id', { patternKey: 'pat_1', patternId: '0195a000-0000-7000-8000-000000000001', patternVersion: 1 }],
    ['an id that is not a UUID', { patternId: 'not-an-id', patternVersion: 1 }],
    ['a version below 1', { patternId: '0195a000-0000-7000-8000-000000000001', patternVersion: 0 }],
    ['a name beside the key', { patternKey: 'pat_1', name: 'x' }],
    ['no key and no id', {}],
  ])('refuses %s', (_name, params) => {
    expect(askPlanSchema.safeParse({ ...planned, params }).success).toBe(false);
  });

  it('is not one of the templates of the catalog, so the catalog and the vocabulary do not list it', () => {
    expect([...ASK_PLAN_TEMPLATE_IDS]).not.toContain('saved-pattern');
    expect(ASK_PLAN_PARAM_NAMES).not.toContain('patternKey');
  });

  it('is answered by the plan endpoint with its plan ID and expiry like any template plan', () => {
    expect(askPlanResponseSchema.safeParse({ plan: stored, planId: '0195a000-0000-7000-8000-000000000002', expiresAt: '2026-11-13T10:00:00.000Z' }).success).toBe(true);
  });

  it('may say the catalog of patterns was cut, as true and never as a count', () => {
    const base = { plan: stored, planId: '0195a000-0000-7000-8000-000000000002', expiresAt: '2026-11-13T10:00:00.000Z' };
    expect(askPlanResponseSchema.safeParse({ ...base, patternCatalogCut: true }).success).toBe(true);
    expect(askPlanResponseSchema.safeParse({ ...base, patternCatalogCut: false }).success).toBe(false);
    expect(askPlanResponseSchema.safeParse({ ...base, patternCatalogCut: 31 }).success).toBe(false);
  });

  it('may list the names offered to the model in a preview, and says the catalog was cut, never with a count', () => {
    const preview = { preview: 'Which ‹widget#1›?', previewHash: 'a'.repeat(64) };
    expect(askPlanResponseSchema.safeParse({ ...preview, patternLabels: ['Widgets and gadgets'], patternCatalogCut: true }).success).toBe(true);
    expect(askPlanResponseSchema.safeParse({ ...preview, patternLabels: [''] }).success).toBe(false);
    expect(askPlanResponseSchema.safeParse({ ...preview, patternCatalogCut: 3 }).success).toBe(false);
  });

  it('may be edited: the edit request names the saved-pattern template and the plan answers an edited plan of it', () => {
    expect(askEditRequestSchema.safeParse({ planId: '0195a000-0000-7000-8000-000000000002', templateId: 'saved-pattern', params: {} }).success).toBe(true);
    expect(askEditRequestSchema.safeParse({ planId: '0195a000-0000-7000-8000-000000000002', templateId: 'free-query', params: {} }).success).toBe(false);
    expect(askEditResponseSchema.safeParse({ plan: stored, planId: '0195a000-0000-7000-8000-000000000003', expiresAt: '2026-11-13T10:00:00.000Z' }).success).toBe(true);
  });
});

describe('the summary of a run answer', () => {
  const planId = '0192f000-0000-7000-8000-0000000000a1';
  const ref = { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' };
  const citation = (key: string, over: object = {}) => ({ key, element: ref, type: 'node_a', title: 'A', ...over });
  const summary = { sentences: [{ text: 'One match.', cites: ['n1'] }], citations: [citation('n1')] };
  const node = { ref, display: { title: 'A', type: 'node_a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
  const answer = (over: object = {}) => ({ planId, outcome: 'complete', result: { templateId: 'entity', result: node }, ...over });

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

  it('takes an answer with no summary, and one with a summary and an omissions line', () => {
    expect(askRunResponseSchema.safeParse(answer()).success).toBe(true);
    expect(askRunResponseSchema.safeParse(answer({ summary: { ...summary, omissions: '2 statements were left out.' } })).success).toBe(true);
    expect(askRunResponseSchema.safeParse(answer({ summary: { ...summary, omissions: '' } })).success).toBe(false);
  });

  it('refuses a summary on a result that stopped as heavy', () => {
    const heavy = { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 1000, scope: 'test' }, threshold: 1000, continueLimit: 25, notices: [], warnings: [] };
    const stop = answer({ outcome: 'partial', result: { templateId: 'shared-attribute', result: heavy }, continueToken: 'c'.repeat(64) });
    expect(askRunResponseSchema.safeParse(stop).success).toBe(true);
    expect(askRunResponseSchema.safeParse({ ...stop, summary }).success).toBe(false);
  });
});

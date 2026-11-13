import { describe, expect, it } from 'vitest';
import { ASK_PLAN_PARAM_NAMES, ASK_PLAN_TEMPLATE_IDS, askPlanRequestSchema, askPlanResponseSchema, askPlanSchema, askResolutionSchema, askResolutionsSchema, askRunRequestSchema, ASK_MAX_RESOLUTIONS, ASK_MESSAGE_MAX_LENGTH } from './ask.js';

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

  it.each([
    ['a plan', { plan: { kind: 'unsupported', reason: 'no template' } }],
    ['a clarification', { clarification: { start: 0, end: 3, choices: [], count: { quality: 'exact', value: 0, scope: 'exact matches' }, unreferenced: 0 } }],
    ['the blocked tokens', { blocked: { tokens: [{ text: 'zorvath', start: 6, end: 13 }] } }],
    ['a preview', { preview: 'which widgets', previewHash: hash }],
    ['a changed preview', { preview: 'which widgets', previewHash: hash, changed: true }],
  ])('takes %s', (_name, body) => {
    expect(askPlanResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['a preview without its hash', { preview: 'x' }],
    ['a changed flag that is false', { preview: 'x', previewHash: hash, changed: false }],
    ['blocked tokens that are none', { blocked: { tokens: [] } }],
    ['two answers at once', { preview: 'x', previewHash: hash, blocked: { tokens: [{ text: 'a', start: 0, end: 1 }] } }],
  ])('refuses %s', (_name, body) => {
    expect(askPlanResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('the body of the run endpoint', () => {
  it('takes one plan ID that is a uuid, and nothing else', () => {
    expect(askRunRequestSchema.safeParse({ planId: '0192f000-0000-7000-8000-0000000000a1' }).success).toBe(true);
    for (const body of [{}, { planId: 'plan-1' }, { planId: 7 }, { planId: '0192f000-0000-7000-8000-0000000000a1', send: true }]) {
      expect(askRunRequestSchema.safeParse(body).success).toBe(false);
    }
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

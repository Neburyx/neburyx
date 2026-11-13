import { askPlanSchema, type AskPlan } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { PlaceholderEntry } from '../resolution/index.js';
import { HydrationError, hydratePlan } from './hydrate.js';

type TemplatePlan = Extract<AskPlan, { kind: 'plan' }>;

const SOURCE = 'demo';
const REF = { sourceId: SOURCE, entityType: 'node_a', stableId: 'a-1' };
const OTHER = { sourceId: SOURCE, entityType: 'node_b', stableId: 'b-7' };
const MAP = new Map<string, PlaceholderEntry>([
  ['‹node_a#1›', { kind: 'entity', ref: REF }],
  ['‹node_b#1›', { kind: 'entity', ref: OTHER }],
  ['‹entity#1›', { kind: 'entity', ref: { sourceId: SOURCE, entityType: 'node a', stableId: 'c-3' } }],
  ['‹value#1›', { kind: 'value', text: 'ref 77' }],
  ['‹node_a#2›', { kind: 'entity', ref: { sourceId: 'elsewhere', entityType: 'node_a', stableId: 'z-9' } }],
]);

const base = { kind: 'plan', templateVersion: 1, rationale: 'because' } as const;
const entity = (stableId: string, entityType = 'node_a'): TemplatePlan => ({ ...base, templateId: 'entity', params: { ref: { entityType, stableId } } });
const reasonOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof HydrationError ? error.reason : 'other';
  }
  return undefined;
};

describe('a plan that cannot be turned back into references', () => {
  it.each([
    ['a placeholder the map does not hold', entity('‹node_a#9›'), 'unknown-placeholder'],
    ['a stable ID that is no placeholder at all', entity('a-1'), 'unknown-placeholder'],
    ['a value placeholder used as an entity', entity('‹value#1›'), 'not-an-entity'],
    ['an entity of another source than the request’s', entity('‹node_a#2›'), 'other-source'],
    ['an entity placeholder used as the text of a search', { ...base, templateId: 'search', params: { entityTypes: ['node_a'], text: '‹node_a#1›' } } as TemplatePlan, 'not-a-value'],
    ['a value placeholder the map does not hold', { ...base, templateId: 'search', params: { entityTypes: ['node_a'], text: '‹value#4›' } } as TemplatePlan, 'unknown-placeholder'],
    ['an end of a derived edge that is a value', { ...base, templateId: 'derived-edge-support', params: { ruleId: 'r', ends: [{ entityType: 'node_a', stableId: '‹node_a#1›' }, { entityType: 'node_a', stableId: '‹value#1›' }] } } as TemplatePlan, 'not-an-entity'],
  ])('fails for %s with the tag %s and no value in the error', (_name, plan, reason) => {
    expect(reasonOf(() => hydratePlan(plan, MAP, SOURCE))).toBe(reason);
    const error = (() => {
      try {
        hydratePlan(plan, MAP, SOURCE);
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(String((error as Error).message)).not.toMatch(/a-1|b-7|z-9|ref 77|‹/);
  });

  it('fails when the references it makes are not a valid plan', () => {
    const tooLong = new Map<string, PlaceholderEntry>([['‹value#1›', { kind: 'value', text: 'x'.repeat(5000) }]]);
    const plan = { ...base, templateId: 'search', params: { entityTypes: ['node_a'], text: '‹value#1›' } } as TemplatePlan;
    expect(reasonOf(() => hydratePlan(plan, tooLong, SOURCE))).toBe('invalid-plan');
  });
});

describe('a plan with placeholders that the map holds', () => {
  it('puts the whole reference of the map where the placeholder was, so the entity type is the map’s, not the model’s', () => {
    const hydrated = hydratePlan(entity('‹node_a#1›', 'node_b'), MAP, SOURCE);
    expect(hydrated).toEqual({ ...base, templateId: 'entity', params: { ref: { entityType: 'node_a', stableId: 'a-1' } } });
    expect(hydratePlan(entity('‹entity#1›', 'whatever'), MAP, SOURCE)).toMatchObject({ params: { ref: { entityType: 'node a', stableId: 'c-3' } } });
  });

  it('turns the value placeholder of a search into the text typed, and leaves the rest of the parameters as they were', () => {
    const plan = { ...base, templateId: 'search', params: { entityTypes: ['node_a', 'node_b'], text: '‹value#1›' } } as TemplatePlan;
    expect(hydratePlan(plan, MAP, SOURCE)).toEqual({ ...base, templateId: 'search', params: { entityTypes: ['node_a', 'node_b'], text: 'ref 77' } });
  });

  it('turns both ends of a derived edge and keeps its rule', () => {
    const plan = { ...base, templateId: 'derived-edge-support', params: { ruleId: 'rule_one', ends: [{ entityType: 'node_a', stableId: '‹node_a#1›' }, { entityType: 'node_b', stableId: '‹node_b#1›' }] } } as TemplatePlan;
    expect(hydratePlan(plan, MAP, SOURCE)).toMatchObject({ params: { ruleId: 'rule_one', ends: [{ entityType: 'node_a', stableId: 'a-1' }, { entityType: 'node_b', stableId: 'b-7' }] } });
  });

  it.each(['shared-attribute', 'linked-entities', 'degree-preview', 'derived-rule-run'] as const)('turns the anchor of a plan of %s and keeps its other parameters', (templateId) => {
    const extra = templateId === 'derived-rule-run' ? { ruleId: 'rule_one' } : templateId === 'linked-entities' ? { targetType: 'node_b' } : {};
    const plan = { ...base, templateId, params: { ref: { entityType: 'node_a', stableId: '‹node_a#1›' }, ...extra } } as TemplatePlan;
    expect(hydratePlan(plan, MAP, SOURCE)).toMatchObject({ templateId, params: { ref: { entityType: 'node_a', stableId: 'a-1' }, ...extra } });
  });

  it('turns the anchor of an expand and keeps its types and limit', () => {
    const plan = { ...base, templateId: 'expand', params: { ref: { entityType: 'node_a', stableId: '‹node_a#1›' }, neighborTypes: ['node_b'], limit: 5 } } as TemplatePlan;
    expect(hydratePlan(plan, MAP, SOURCE)).toMatchObject({ params: { ref: { stableId: 'a-1' }, neighborTypes: ['node_b'], limit: 5 } });
  });

  it('does not change the plan it is given', () => {
    const plan = entity('‹node_a#1›');
    hydratePlan(plan, MAP, SOURCE);
    expect(plan).toEqual(entity('‹node_a#1›'));
  });
});

describe('a plan that names a saved pattern', () => {
  const ID = '0195a000-0000-7000-8000-000000000001';
  const TARGETS = new Map([['pat_1', { id: ID, version: 3 }]]);
  const PLACEHOLDERS = new Map([['‹widget#1›', { kind: 'entity' as const, ref: { sourceId: 'demo', entityType: 'widget', stableId: 'w-1' } }]]);
  const named = (params: Record<string, unknown>): TemplatePlan => {
    const parsed = askPlanSchema.parse({ kind: 'plan', templateId: 'saved-pattern', templateVersion: 1, rationale: 'A pattern.', params });
    if (parsed.kind !== 'plan') throw new Error('not a plan');
    return parsed;
  };

  it('is given the id and version of the pattern its key stood for and the reference of its placeholder, and keeps no key', () => {
    const hydrated = hydratePlan(named({ patternKey: 'pat_1', ref: { entityType: 'widget', stableId: '‹widget#1›' } }), PLACEHOLDERS, 'demo', TARGETS);
    expect(hydrated).toMatchObject({ templateId: 'saved-pattern', params: { patternId: ID, patternVersion: 3, ref: { entityType: 'widget', stableId: 'w-1' } } });
    expect(JSON.stringify(hydrated)).not.toContain('pat_1');
  });

  it('has no reference when the pattern holds its starting entity', () => {
    expect(hydratePlan(named({ patternKey: 'pat_1' }), PLACEHOLDERS, 'demo', TARGETS)).toMatchObject({ params: { patternId: ID, patternVersion: 3 } });
  });

  it('fails for a key of no catalog of this request, with the placeholder, and for a reference of another source', () => {
    expect(() => hydratePlan(named({ patternKey: 'pat_2' }), PLACEHOLDERS, 'demo', TARGETS)).toThrow(HydrationError);
    expect(() => hydratePlan(named({ patternKey: 'pat_1' }), PLACEHOLDERS, 'demo')).toThrow(HydrationError);
    expect(() => hydratePlan(named({ patternKey: 'pat_1', ref: { entityType: 'widget', stableId: '‹widget#1›' } }), PLACEHOLDERS, 'elsewhere', TARGETS)).toThrow(expect.objectContaining({ reason: 'other-source' }));
  });
});

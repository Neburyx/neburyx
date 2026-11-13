import type { AiMappingView, AskPlan } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { problemsOfPlan } from './check.js';

const VIEW: AiMappingView = {
  types: [
    { name: 'node_a', kind: 'entity', properties: [] },
    { name: 'node_b', kind: 'entity', properties: [] },
    { name: 'link_a', kind: 'relationship', properties: [], ends: [{ from: 'node_a', to: 'node_b', timed: true }] },
    { name: 'link_b', kind: 'relationship', properties: [], ends: [{ from: 'node_b', to: 'node_a', timed: false }] },
  ],
  derivedRules: [{ id: 'rule_a', from: 'node_a', to: 'node_a' }],
};
const TEXT = 'about ‹node_a#1› and ‹node_a#2› and ‹value#1› and ‹entity#1›';
const ref = (stableId = '‹node_a#1›', entityType = 'node_a') => ({ entityType, stableId });
const plan = (templateId: string, params: Record<string, unknown>, templateVersion = 1): AskPlan => ({ kind: 'plan', templateId, templateVersion, params, rationale: 'A plan.' }) as AskPlan;
const check = (candidate: AskPlan, view: AiMappingView | undefined = VIEW) => problemsOfPlan(candidate, { text: TEXT, view });

const VALID: readonly (readonly [string, AskPlan])[] = [
  ['shared-attribute', plan('shared-attribute', { ref: ref(), attributeType: 'node_b', via: 'link_a', window: { days: 30 }, minShared: 2, limit: 25 })],
  ['linked-entities', plan('linked-entities', { ref: ref(), targetType: 'node_b', via: ['link_a', 'link_b'], direction: 'out', maxHops: 2 })],
  ['entity', plan('entity', { ref: ref() })],
  ['degree-preview', plan('degree-preview', { ref: ref() })],
  ['expand', plan('expand', { ref: ref(), relTypes: ['link_a'], neighborTypes: ['node_b'], direction: 'in', sort: 'observed', window: { days: 7 }, limit: 25 })],
  ['derived-rule-run', plan('derived-rule-run', { ref: ref(), ruleId: 'rule_a' })],
  ['derived-edge-support', plan('derived-edge-support', { ruleId: 'rule_a', ends: [ref('‹node_a#1›'), ref('‹node_a#2›')] })],
  ['search', plan('search', { entityTypes: ['node_b'], text: '‹value#1›' })],
];

describe('a plan checked against the catalog, the vocabulary and the text', () => {
  it.each(VALID)('lets a valid %s plan through unchanged, with no problem', (_id, candidate) => {
    expect(check(candidate)).toEqual([]);
  });

  it('takes an unsupported plan as it is', () => {
    expect(check({ kind: 'unsupported', reason: 'No template fits.' })).toEqual([]);
  });

  it.each([
    ['a version other than the catalog\'s', plan('entity', { ref: ref() }, 2), 'templateVersion: not the version of the catalog'],
    ['an entity type the mapping does not hold', plan('shared-attribute', { ref: ref(), attributeType: 'node_x', via: 'link_a' }), 'params.attributeType: not an entity type of the vocabulary'],
    ['a relationship type the mapping does not hold', plan('shared-attribute', { ref: ref(), attributeType: 'node_b', via: 'link_x' }), 'params.via: not a relationship type of the vocabulary'],
    ['a relationship type in a list the mapping does not hold', plan('linked-entities', { ref: ref(), targetType: 'node_b', via: ['link_a', 'link_x'] }), 'params.via.1: not a relationship type of the vocabulary'],
    ['a rule the mapping does not hold', plan('derived-rule-run', { ref: ref(), ruleId: 'rule_x' }), 'params.ruleId: not a derived rule of the vocabulary'],
    ['a neighbor type the mapping does not hold', plan('expand', { ref: ref(), neighborTypes: ['node_x'] }), 'params.neighborTypes.0: not an entity type of the vocabulary'],
    ['a stable ID the model made up', plan('entity', { ref: ref('A-1') }), 'params.ref.stableId: not an entity placeholder of the question'],
    ['a placeholder the question does not hold', plan('entity', { ref: ref('‹node_a#9›') }), 'params.ref.stableId: not an entity placeholder of the question'],
    ['a value placeholder as an anchor', plan('entity', { ref: ref('‹value#1›') }), 'params.ref.stableId: not an entity placeholder of the question'],
    ['an entity type that does not match its placeholder', plan('entity', { ref: ref('‹node_a#1›', 'node_b') }), 'params.ref.entityType: does not match the placeholder'],
    ['a neutral placeholder with an entity type the mapping does not hold', plan('entity', { ref: ref('‹entity#1›', 'node_x') }), 'params.ref.entityType: does not match the placeholder'],
    ['an end that is not a placeholder', plan('derived-edge-support', { ruleId: 'rule_a', ends: [ref('‹node_a#1›'), ref('A-2')] }), 'params.ends.1.stableId: not an entity placeholder of the question'],
    ['an entity placeholder as the text of a search', plan('search', { entityTypes: ['node_b'], text: '‹node_a#1›' }), 'params.text: not a value placeholder of the question'],
    ['text of the model\'s own as the text of a search', plan('search', { entityTypes: ['node_b'], text: 'a guess' }), 'params.text: not a value placeholder of the question'],
    ['a value placeholder the question does not hold', plan('search', { entityTypes: ['node_b'], text: '‹value#7›' }), 'params.text: not a value placeholder of the question'],
  ])('rejects %s', (_name, candidate, problem) => {
    expect(check(candidate)).toContain(problem);
  });

  it('lets a neutral placeholder through when the entity type is one of the mapping', () => {
    expect(check(plan('entity', { ref: ref('‹entity#1›', 'node_b') }))).toEqual([]);
  });

  it('rejects every type, rule and relationship when there is no vocabulary, so nothing passes without one', () => {
    expect(problemsOfPlan(plan('derived-rule-run', { ref: ref(), ruleId: 'rule_a' }), { text: TEXT, view: undefined })).toContain('params.ruleId: not a derived rule of the vocabulary');
  });

  it('writes problems as paths and codes, with no value of the plan or of the text', () => {
    const problems = check(plan('entity', { ref: ref('SENTINEL-ID') })).join(' ');
    expect(problems).not.toContain('SENTINEL');
  });
});

describe('a plan that names a saved pattern', () => {
  const PATTERNS = new Map([
    ['pat_1', { anchorType: 'node_a', startingEntity: 'asked' as const }],
    ['pat_2', { anchorType: 'node_b', startingEntity: 'held' as const }],
  ]);
  const saved = (params: Record<string, unknown>, templateVersion = 1): AskPlan => plan('saved-pattern', params, templateVersion);
  const checked = (candidate: AskPlan) => problemsOfPlan(candidate, { text: TEXT, view: VIEW, patterns: PATTERNS });

  it('has no problem when it names an offered key and, for a pattern that asks for its starting entity, a placeholder of the starting type', () => {
    expect(checked(saved({ patternKey: 'pat_1', ref: ref() }))).toEqual([]);
    expect(checked(saved({ patternKey: 'pat_2' }))).toEqual([]);
  });

  it('has a problem for a key that was not offered, and names the path only, never the key', () => {
    expect(checked(saved({ patternKey: 'pat_9', ref: ref() }))).toEqual(['params.patternKey: not a key of the saved patterns offered']);
    expect(problemsOfPlan(saved({ patternKey: 'pat_1', ref: ref() }), { text: TEXT, view: VIEW })).toEqual(['params.patternKey: not a key of the saved patterns offered']);
  });

  it('has a problem for a pattern that asks for its starting entity when the plan gives none, or one that is not an entity placeholder of the question, or one of another type', () => {
    expect(checked(saved({ patternKey: 'pat_1' }))).toEqual(['params.ref: the saved pattern asks for its starting entity']);
    expect(checked(saved({ patternKey: 'pat_1', ref: ref('‹value#1›') }))).toContain('params.ref.stableId: not an entity placeholder of the question');
    expect(checked(saved({ patternKey: 'pat_1', ref: ref('‹node_a#7›') }))).toContain('params.ref.stableId: not an entity placeholder of the question');
    expect(checked(saved({ patternKey: 'pat_1', ref: ref('‹entity#1›', 'node_b') }))).toEqual(['params.ref.entityType: not the type the saved pattern starts at']);
  });

  it('has a problem for a pattern that holds its starting entity when the plan gives one', () => {
    expect(checked(saved({ patternKey: 'pat_2', ref: ref('‹node_a#1›', 'node_b') }))).toEqual(['params.ref: the saved pattern holds its starting entity']);
  });

  it('has a problem for another template version, and for a plan in the stored form, which the model never makes', () => {
    expect(checked(saved({ patternKey: 'pat_2' }, 2))).toEqual(['templateVersion: not the version of the saved pattern plan']);
    expect(checked(saved({ patternId: '0195a000-0000-7000-8000-000000000001', patternVersion: 1 }))).toEqual(['params.patternKey: a saved pattern is named by its key']);
  });
});

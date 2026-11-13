import { askPlanSchema, type AiMappingView } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Expectation } from './questions.js';
import { scorePlan, type ScoreContext } from './score.js';
import type { PlannerAnswer } from './types.js';

const VIEW: AiMappingView = {
  types: [
    { name: 'widget', kind: 'entity', properties: [] },
    { name: 'gadget', kind: 'entity', properties: [] },
    { name: 'owns', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'gadget', timed: false }] },
    { name: 'links', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'widget', timed: false }] },
    { name: 'loops', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'gadget', timed: false }, { from: 'gadget', to: 'widget', timed: false }] },
  ],
  derivedRules: [{ id: 'twin', from: 'widget', to: 'widget' }, { id: 'cross', from: 'widget', to: 'gadget' }],
};
const CONTEXT: ScoreContext = { view: VIEW, defaultPage: 25 };
const ref = (stableId: string, entityType = 'widget') => ({ entityType, stableId });

function answered(templateId: string, params: object): PlannerAnswer {
  return { kind: 'answered', repaired: false, plan: askPlanSchema.parse({ kind: 'plan', templateId, templateVersion: 9, params, rationale: 'Because.' }) };
}
const refusalAnswer: PlannerAnswer = { kind: 'answered', repaired: false, plan: { kind: 'unsupported', reason: 'No template answers it.' } };
type Template = Extract<Expectation, { kind: 'plan' }>['template'];
const expected = (template: Template, params: Record<string, unknown>): Expectation => ({ kind: 'plan', template, params });
const verdictOf = (expect: Expectation, answer: PlannerAnswer, context = CONTEXT) => scorePlan(expect, answer, context);

describe('scoring a plan', () => {
  it('scores a refusal that got a plan as wrongly planned, and an expected plan that got a refusal as wrong', () => {
    expect(verdictOf({ kind: 'unsupported' }, answered('entity', { ref: ref('‹widget#1›') })).verdict).toBe('wrongly-planned');
    expect(verdictOf(expected('entity', { ref: ref('‹widget#1›') }), refusalAnswer).verdict).toBe('wrong');
    expect(verdictOf({ kind: 'unsupported' }, refusalAnswer).verdict).toBe('refused');
  });

  it('scores a value that is not a valid plan as wrong without naming a value', () => {
    // A value the planner can never return: the scorer still has to call it wrong.
    const invalid = z.custom<PlannerAnswer>(() => true).parse(JSON.parse('{"kind":"answered","repaired":false,"plan":{"kind":"plan","templateId":"entity","templateVersion":1,"params":{"query":"x"},"rationale":"Because."}}'));
    expect(verdictOf(expected('entity', { ref: ref('‹widget#1›') }), invalid)).toEqual({ verdict: 'wrong', fields: [] });
  });

  it.each([
    ['a minShared of 1', { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns' }, { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns', minShared: 1, limit: 25 }],
    ['a limit of the default page', { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns', limit: 25 }, { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns' }],
  ])('scores a shared-attribute plan that omits %s as right', (_name, left, right) => {
    expect(verdictOf(expected('shared-attribute', left), answered('shared-attribute', right)).verdict).toBe('right');
  });

  it('scores a shared-attribute plan with another minShared, limit, window or attribute as wrong and names the field', () => {
    const base = { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns' };
    expect(verdictOf(expected('shared-attribute', base), answered('shared-attribute', { ...base, minShared: 2 }))).toEqual({ verdict: 'wrong', fields: ['minShared'] });
    expect(verdictOf(expected('shared-attribute', base), answered('shared-attribute', { ...base, limit: 10 })).fields).toEqual(['limit']);
    expect(verdictOf(expected('shared-attribute', base), answered('shared-attribute', { ...base, window: { days: 90 } })).fields).toEqual(['window']);
    expect(verdictOf(expected('shared-attribute', base), answered('shared-attribute', { ...base, attributeType: 'widget' })).fields).toEqual(['attributeType']);
  });

  it('reads the default page from the mapping it is given', () => {
    const base = { ref: ref('‹widget#1›'), attributeType: 'gadget', via: 'owns' };
    const twenty = { ...CONTEXT, defaultPage: 20 };
    expect(verdictOf(expected('shared-attribute', { ...base, limit: 20 }), answered('shared-attribute', base), twenty).verdict).toBe('right');
    expect(verdictOf(expected('shared-attribute', { ...base, limit: 25 }), answered('shared-attribute', base), twenty).verdict).toBe('wrong');
  });

  it('scores a template other than the expected as wrong and names the template', () => {
    expect(verdictOf(expected('entity', { ref: ref('‹widget#1›') }), answered('degree-preview', { ref: ref('‹widget#1›') }))).toEqual({ verdict: 'wrong', fields: ['template'] });
  });

  it('derives the omitted linked-entities direction from the relationship ends and scores it right when it equals the expected', () => {
    const base = { ref: ref('‹widget#1›'), targetType: 'gadget', via: ['owns'] };
    expect(verdictOf(expected('linked-entities', { ...base, direction: 'out', maxHops: 1 }), answered('linked-entities', base)).verdict).toBe('right');
    expect(verdictOf(expected('linked-entities', { ...base, direction: 'in' }), answered('linked-entities', base)).fields).toEqual(['direction']);
  });

  it('reads a self-loop relationship as out and refuses to derive a direction from two or none', () => {
    const loop = { ref: ref('‹widget#1›'), targetType: 'widget', via: ['links'] };
    expect(verdictOf(expected('linked-entities', { ...loop, direction: 'out' }), answered('linked-entities', loop)).verdict).toBe('right');
    const both = { ref: ref('‹widget#1›'), targetType: 'gadget', via: ['owns', 'links'] };
    expect(verdictOf(expected('linked-entities', { ...both, direction: 'out' }), answered('linked-entities', both)).verdict).toBe('right');
    const ambiguous = { ref: ref('‹widget#1›'), targetType: 'gadget', via: ['owns', 'loops'] };
    expect(verdictOf(expected('linked-entities', { ...ambiguous, direction: 'out' }), answered('linked-entities', ambiguous))).toEqual({ verdict: 'wrong', fields: ['direction-underivable'] });
    const unknown = { ref: ref('‹gadget#1›', 'gadget'), targetType: 'widget', via: ['links'] };
    expect(verdictOf(expected('linked-entities', { ...unknown, direction: 'out' }), answered('linked-entities', unknown)).fields).toEqual(['direction-underivable']);
  });

  it('compares a chain of relationship types as a set, so another order is right and another element is wrong', () => {
    const left = { ref: ref('‹widget#1›'), targetType: 'gadget', direction: 'out', via: ['owns', 'links'] };
    expect(verdictOf(expected('linked-entities', left), answered('linked-entities', { ...left, via: ['links', 'owns'] })).verdict).toBe('right');
    expect(verdictOf(expected('linked-entities', left), answered('linked-entities', { ...left, via: ['owns', 'loops'] })).fields).toEqual(['via']);
  });

  it('fills the expand direction, sort and limit, and compares the type lists as sets', () => {
    const base = { ref: ref('‹gadget#1›', 'gadget'), relTypes: ['owns', 'links'], neighborTypes: ['widget', 'gadget'] };
    const same = { ref: ref('‹gadget#1›', 'gadget'), relTypes: ['links', 'owns'], neighborTypes: ['gadget', 'widget'], direction: 'both', sort: 'observed', limit: 25 };
    expect(verdictOf(expected('expand', base), answered('expand', same)).verdict).toBe('right');
    expect(verdictOf(expected('expand', base), answered('expand', { ...same, direction: 'in' })).fields).toEqual(['direction']);
  });

  it('compares the two ends of a derived-edge-support plan in order when the rule joins two types, and in either order when the two are the same', () => {
    const ends = [ref('‹widget#1›'), ref('‹gadget#1›', 'gadget')];
    const reversed = [ends[1], ends[0]];
    expect(verdictOf(expected('derived-edge-support', { ruleId: 'cross', ends }), answered('derived-edge-support', { ruleId: 'cross', ends: reversed })).fields).toEqual(['ends']);
    const same = [ref('‹widget#1›'), ref('‹widget#2›')];
    expect(verdictOf(expected('derived-edge-support', { ruleId: 'twin', ends: same }), answered('derived-edge-support', { ruleId: 'twin', ends: [same[1], same[0]] })).verdict).toBe('right');
  });

  it('ignores the rationale and the template version', () => {
    const answer = answered('entity', { ref: ref('‹widget#1›') });
    expect(verdictOf(expected('entity', { ref: ref('‹widget#1›') }), answer).verdict).toBe('right');
  });

  it('compares search types as a set and a different text as wrong', () => {
    const base = { entityTypes: ['widget', 'gadget'], text: '‹value#1›' };
    expect(verdictOf(expected('search', base), answered('search', { entityTypes: ['gadget', 'widget'], text: '‹value#1›' })).verdict).toBe('right');
    expect(verdictOf(expected('search', base), answered('search', { ...base, text: '‹value#2›' })).fields).toEqual(['text']);
  });
});

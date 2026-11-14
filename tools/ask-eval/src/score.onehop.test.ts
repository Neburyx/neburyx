import { askPlanSchema, type AiMappingView } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import type { Expectation } from './questions.js';
import { BLOCKED_REFUSAL_RULE, ONE_HOP_RULE, scorePlan, type ScoreContext } from './score.js';
import type { PlannerAnswer } from './types.js';

const VIEW: AiMappingView = {
  types: [
    { name: 'widget', kind: 'entity', properties: [] },
    { name: 'gadget', kind: 'entity', properties: [] },
    { name: 'owns', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'gadget', timed: false }] },
    { name: 'made', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'gadget', timed: false }] },
  ],
};
const CONTEXT: ScoreContext = { view: VIEW, defaultPage: 25 };
const ref = { entityType: 'widget', stableId: '‹widget#1›' };

const answered = (templateId: string, params: object): PlannerAnswer => ({ kind: 'answered', repaired: false, plan: askPlanSchema.parse({ kind: 'plan', templateId, templateVersion: 1, params, rationale: 'Because.' }) });
const expected = (template: 'linked-entities' | 'expand', params: Record<string, unknown>): Expectation => ({ kind: 'plan', template, params });

const LINKED = { ref, targetType: 'gadget', via: ['owns'], direction: 'out' };
const EXPAND = { ref, relTypes: ['owns'], neighborTypes: ['gadget'], direction: 'out' };

describe('the one-hop rule', () => {
  it('names itself', () => {
    expect(ONE_HOP_RULE).toBe('one-hop-neighbors');
  });

  it('counts an expand plan as right for an expected linked-entities plan over one relationship type, and says which rule did', () => {
    expect(scorePlan(expected('linked-entities', LINKED), answered('expand', EXPAND), CONTEXT)).toEqual({ verdict: 'right', fields: [], rule: ONE_HOP_RULE });
  });

  it('counts a linked-entities plan as right for an expected expand plan, the other direction of the equivalence', () => {
    expect(scorePlan(expected('expand', EXPAND), answered('linked-entities', LINKED), CONTEXT)).toEqual({ verdict: 'right', fields: [], rule: ONE_HOP_RULE });
  });

  it('takes a direction the mapping gives, a window that is the same and a limit that is the default', () => {
    const left = { ref, targetType: 'gadget', via: ['owns'], window: { days: 30 } };
    const right = { ...EXPAND, window: { days: 30 }, limit: 25 };
    expect(scorePlan(expected('linked-entities', left), answered('expand', right), CONTEXT).rule).toBe(ONE_HOP_RULE);
  });

  it('takes the default sort written out', () => {
    expect(scorePlan(expected('linked-entities', LINKED), answered('expand', { ...EXPAND, sort: 'observed' }), CONTEXT).rule).toBe(ONE_HOP_RULE);
  });

  it('leaves the same-template scoring as it was, with no rule', () => {
    expect(scorePlan(expected('expand', EXPAND), answered('expand', EXPAND), CONTEXT)).toEqual({ verdict: 'right', fields: [] });
  });

  it.each([
    ['two hops', { ...LINKED, maxHops: 2 }, EXPAND],
    ['two relationship types in via', { ...LINKED, via: ['owns', 'made'] }, EXPAND],
    ['another relationship type', LINKED, { ...EXPAND, relTypes: ['made'] }],
    ['another direction', LINKED, { ...EXPAND, direction: 'in' }],
    ['no direction in the expand plan, which is both', LINKED, { ref, relTypes: ['owns'], neighborTypes: ['gadget'] }],
    ['another target type', LINKED, { ...EXPAND, neighborTypes: ['widget'] }],
    ['two neighbor types', LINKED, { ...EXPAND, neighborTypes: ['gadget', 'widget'] }],
    ['no relationship type in the expand plan', LINKED, { ref, neighborTypes: ['gadget'], direction: 'out' }],
    ['another window', { ...LINKED, window: { days: 30 } }, { ...EXPAND, window: { days: 7 } }],
    ['a window only on one side', LINKED, { ...EXPAND, window: { days: 30 } }],
    ['another limit', LINKED, { ...EXPAND, limit: 5 }],
  ])('keeps the plans apart for %s', (_name, left, right) => {
    const score = scorePlan(expected('linked-entities', left), answered('expand', right), CONTEXT);
    expect(score.verdict).toBe('wrong');
    expect(score.rule).toBeUndefined();
  });

  it('keeps apart a linked-entities plan with no target type and an expand plan with one neighbor type', () => {
    const { targetType: _omitted, ...anyTarget } = LINKED;
    expect(anyTarget).not.toHaveProperty('targetType');
    expect(scorePlan(expected('expand', EXPAND), answered('linked-entities', anyTarget as never), CONTEXT).rule).toBeUndefined();
  });

  it('keeps apart plans of another anchor', () => {
    const other = { entityType: 'widget', stableId: '‹widget#2›' };
    expect(scorePlan(expected('linked-entities', LINKED), answered('expand', { ...EXPAND, ref: other }), CONTEXT).verdict).toBe('wrong');
  });

  it('gives no form to a linked-entities plan whose direction the mapping cannot derive, and takes an explicit direction both on both sides', () => {
    const view: AiMappingView = { types: [{ name: 'widget', kind: 'entity', properties: [] }, { name: 'loops', kind: 'relationship', properties: [], ends: [{ from: 'widget', to: 'widget', timed: false }, { from: 'widget', to: 'widget', timed: false }] }, { name: 'gadget', kind: 'entity', properties: [] }] };
    const ambiguous = { ref, targetType: 'gadget', via: ['absent'] };
    expect(scorePlan(expected('linked-entities', ambiguous), answered('expand', { ref, relTypes: ['absent'], neighborTypes: ['gadget'], direction: 'out' }), { view, defaultPage: 25 }).verdict).toBe('wrong');
    const both = scorePlan(expected('linked-entities', { ...LINKED, direction: 'both' }), answered('expand', { ...EXPAND, direction: 'both' }), CONTEXT);
    expect(both).toEqual({ verdict: 'right', fields: [], rule: ONE_HOP_RULE });
  });

  it('keeps them apart the other way round too, for two hops and another relationship type', () => {
    expect(scorePlan(expected('expand', EXPAND), answered('linked-entities', { ...LINKED, maxHops: 2 }), CONTEXT).verdict).toBe('wrong');
    expect(scorePlan(expected('expand', EXPAND), answered('linked-entities', { ...LINKED, via: ['made'] }), CONTEXT).verdict).toBe('wrong');
  });

  it('does not extend to other templates', () => {
    expect(scorePlan(expected('expand', EXPAND), answered('entity', { ref }), CONTEXT).verdict).toBe('wrong');
  });
});

describe('the report of the one-hop rule', () => {
  it('prints how many plans were right by the rule, and prints nothing when none was', async () => {
    const { parseQuestions } = await import('./questions.js');
    const { summarize } = await import('./report.js');
    const { tally } = await import('./targets.js');
    const questions = parseQuestions(`questions:\n  - id: one\n    wording: Which gadgets does ‹widget#1› own?\n    expect: { kind: plan, template: linked-entities, params: { ref: { entityType: widget, stableId: ‹widget#1› }, targetType: gadget, via: [owns], direction: out } }\n`);
    const result = { id: 'one', verdict: 'right' as const, fields: [], repaired: false, answered: 'plan' as const };
    expect(summarize(tally(questions, [{ ...result, rule: ONE_HOP_RULE }]), [{ ...result, rule: ONE_HOP_RULE }], 2, 'replay', undefined).lines).toContain('scored right by the one-hop rule: 1');
    expect(summarize(tally(questions, [result]), [result], 2, 'replay', undefined).lines.join('\n')).not.toContain('one-hop');
  });
});

describe('the blocked-before-planning rule', () => {
  const blockedAnswer: PlannerAnswer = { kind: 'blocked' };

  it('counts an expected refusal that the allowlist blocks as refused, and names the rule', () => {
    expect(scorePlan({ kind: 'unsupported' }, blockedAnswer, CONTEXT)).toEqual({ verdict: 'refused', fields: [], rule: BLOCKED_REFUSAL_RULE });
    expect(BLOCKED_REFUSAL_RULE).toBe('blocked-before-planning');
  });

  it('does not extend to a plan question that is blocked, which stays a miss, nor to a question expected blocked', () => {
    expect(scorePlan(expected('expand', EXPAND), blockedAnswer, CONTEXT)).toEqual({ verdict: 'blocked-unexpectedly', fields: [] });
    expect(scorePlan({ kind: 'blocked' }, blockedAnswer, CONTEXT)).toEqual({ verdict: 'blocked', fields: [] });
  });

  it('counts such a question among the refusals in the tally and prints how many, without a wording', async () => {
    const { parseQuestions } = await import('./questions.js');
    const { summarize } = await import('./report.js');
    const { tally } = await import('./targets.js');
    const questions = parseQuestions('questions:\n  - id: one\n    wording: Is ‹widget#1› fraudulent?\n    expect: { kind: unsupported }\n');
    const result = { id: 'one', verdict: 'refused' as const, fields: [], repaired: false, answered: 'blocked' as const, rule: BLOCKED_REFUSAL_RULE };
    const summary = summarize(tally(questions, [result]), [result], 2, 'replay', undefined);
    expect(summary.lines[0]).toBe('refusals: 1 of 1 refused');
    expect(summary.lines).toContain('scored refused because the allowlist blocked the question: 1');
    expect(summary.met).toBe(true);
  });
});

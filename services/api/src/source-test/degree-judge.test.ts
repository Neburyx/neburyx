import { describe, expect, it } from 'vitest';
import type { PlanOperator } from '../gate/types.js';
import fixtures from './fixtures/degree-plans.json' with { type: 'json' };
import { judgePlan } from './degree-judge.js';

const plans = fixtures as Record<string, Record<'cheap' | 'endpointLabel' | 'relationshipPredicate', PlanOperator[]>>;

describe('the plans of the degree probe captured from the supported images', () => {
  it('hold both the 5.26 and the 2026 image', () => {
    expect(Object.keys(plans).map((version) => version.split('.')[0])).toEqual(['5', '2026']);
  });

  it.each(Object.keys(plans))('show the degree function for the probe itself on %s', (version) => {
    expect(judgePlan(plans[version]?.cheap ?? null)).toEqual({ result: 'cheap', basis: 'degree-operator' });
  });
});

describe('the plans of the counts that expand, captured from the supported images', () => {
  it.each(Object.keys(plans))('show an Expand operator for a far-end label and for a relationship predicate on %s', (version) => {
    for (const shape of ['endpointLabel', 'relationshipPredicate'] as const) {
      expect(plans[version]?.[shape].some((operator) => operator.name.includes('Expand'))).toBe(true);
      expect(judgePlan(plans[version]?.[shape] ?? null)).toEqual({ result: 'not-cheap', basis: 'expand' });
    }
  });
});

describe('judging a plan', () => {
  const operator = (name: string, details: string | null): PlanOperator => ({ name, details, dbHits: 0 });

  it('is cheap when an operator names the degree function', () => {
    expect(judgePlan([operator('ProduceResults', 'c'), operator('Projection', 'getDegree((n)-[:T]->()) AS c')])).toEqual({ result: 'cheap', basis: 'degree-operator' });
  });

  it('is not cheap when an operator expands, also when another operator names the degree function', () => {
    expect(judgePlan([operator('Apply', null), operator('Expand(All)', '(n)-[r:T]->()'), operator('Projection', 'getDegree((n)-[:T]->()) AS c')])).toEqual({ result: 'not-cheap', basis: 'expand' });
    expect(judgePlan([operator('VarLengthExpand(All)', null)])).toEqual({ result: 'not-cheap', basis: 'expand' });
    expect(judgePlan([operator('OptionalExpand(All)', null)])).toEqual({ result: 'not-cheap', basis: 'expand' });
  });

  it('could not tell, with the plan not recognised, when no operator names the degree function', () => {
    expect(judgePlan([operator('ProduceResults', 'c'), operator('Projection', 'something else AS c')])).toEqual({ result: 'could-not-tell', basis: 'unrecognized-plan' });
    expect(judgePlan([])).toEqual({ result: 'could-not-tell', basis: 'unrecognized-plan' });
    expect(judgePlan([operator('Projection', null)])).toEqual({ result: 'could-not-tell', basis: 'unrecognized-plan' });
  });

  it('could not tell, with no plan, when the server showed none', () => {
    expect(judgePlan(null)).toEqual({ result: 'could-not-tell', basis: 'no-plan' });
  });
});

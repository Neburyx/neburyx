import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { MAX_PLAN_OPERATORS, planOf } from './driver.js';

const node = (operatorType: string, details: unknown, dbHits: unknown, children: unknown[] = []) => ({ operatorType, arguments: details === undefined ? {} : { Details: details }, dbHits, children }) as Parameters<typeof planOf>[0];

describe('the plan of a profile', () => {
  it('is flattened with the parent before its children, the database suffix dropped from each name and the db hits as numbers', () => {
    const profile = node('ProduceResults@neo4j', 'c', neo4j.int(0), [node('Projection@neo4j', 'getDegree((n)-[:T]->()) AS c', 1, [node('NodeByLabelScan@neo4j', 'n:L', neo4j.int(2))])]);
    expect(planOf(profile)).toEqual([
      { name: 'ProduceResults', details: 'c', dbHits: 0 },
      { name: 'Projection', details: 'getDegree((n)-[:T]->()) AS c', dbHits: 1 },
      { name: 'NodeByLabelScan', details: 'n:L', dbHits: 2 },
    ]);
  });

  it('keeps no details when the server gave none or not a string, and cuts a long one', () => {
    const plan = planOf(node('Apply', undefined, 0, [node('Filter', 12, 0), node('Limit', 'x'.repeat(500), 0)]));
    expect(plan?.map((operator) => operator.details?.length ?? null)).toEqual([null, null, 200]);
  });

  it.each([[null], [undefined], [false]] as const)('is null when the server sent %s', (profile) => {
    expect(planOf(profile)).toBeNull();
  });

  it('is null when it has more operators than are kept, and whole when it has exactly that many', () => {
    const chain = (length: number) => Array.from({ length }).reduce<ReturnType<typeof node>>((below) => node('Op', 'x', 0, below === undefined ? [] : [below]), undefined);
    expect(planOf(chain(MAX_PLAN_OPERATORS))).toHaveLength(MAX_PLAN_OPERATORS);
    expect(planOf(chain(MAX_PLAN_OPERATORS + 1))).toBeNull();
  });
});

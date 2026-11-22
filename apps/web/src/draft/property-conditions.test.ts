import { describe, expect, it } from 'vitest';
import type { MappedTypes } from '../state/presentation-state.js';
import type { PropertyCondition } from '../state/property-filter.js';
import { conditionOf, storedPropertyFilters } from './property-conditions.js';

const mapped: MappedTypes = {
  entityTypes: ['kind-a', 'kind-b'],
  relationshipTypes: ['link-a'],
  properties: {
    entity: { 'kind-a': { filterable: ['score', 'secret_a'], kinds: { score: 'unknown', secret_a: 'unknown' }, pii: ['secret_a'] }, 'kind-b': { filterable: ['score'], kinds: {}, pii: [] } },
    relationship: { 'link-a': { filterable: ['weight'], kinds: { weight: 'number' }, pii: [] } },
  },
};
const choice = (type: string, property: string, ...values: string[]): PropertyCondition => ({ on: 'entity', type, property, kind: 'text', op: 'in', values });
const range: PropertyCondition = { on: 'relationship', type: 'link-a', property: 'weight', kind: 'number', op: 'between', from: '9007199254740993', to: undefined };

describe('the property filters of a draft', () => {
  it('are written with their type, kind and values or bounds, an entity and a relationship one, two types with a property of one name apart', () => {
    expect(storedPropertyFilters([choice('kind-a', 'score', 'a'), choice('kind-b', 'score', 'b', 'c'), range], mapped)).toEqual([
      { on: 'entity', type: 'kind-a', key: 'score', kind: 'text', op: 'in', values: ['a'] },
      { on: 'entity', type: 'kind-b', key: 'score', kind: 'text', op: 'in', values: ['b', 'c'] },
      { on: 'relationship', type: 'link-a', key: 'weight', kind: 'number', op: 'between', values: [], from: '9007199254740993' },
    ]);
  });

  it('never include a filter on a personal-data property of its type, whatever the view holds, and hold no other value than the ones chosen', () => {
    const written = storedPropertyFilters([choice('kind-a', 'secret_a', 'SECRET-1'), choice('kind-a', 'score', 'a')], mapped);
    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain('SECRET-1');
  });

  it('are read back as the conditions they were written from', () => {
    const conditions = [choice('kind-a', 'score', 'a'), range];
    expect(storedPropertyFilters(conditions, mapped).map(conditionOf)).toEqual(conditions.map((condition) => (condition.op === 'between' ? { ...condition } : condition)));
  });

  it('is read as no condition when an entry is of the older shape, names a kind its operator cannot use, or an operator the web does not write', () => {
    expect(conditionOf({ key: 'score', op: 'eq', values: ['a'] })).toBeUndefined();
    expect(conditionOf({ on: 'entity', type: 'kind-a', key: 'score', kind: 'date', op: 'in', values: ['2026-01-01'] })).toBeUndefined();
    expect(conditionOf({ on: 'entity', type: 'kind-a', key: 'score', kind: 'text', op: 'between', values: [], from: 'a' })).toBeUndefined();
    expect(conditionOf({ on: 'entity', type: 'kind-a', key: 'score', kind: 'text', op: 'eq', values: ['a'] })).toBeUndefined();
  });
});

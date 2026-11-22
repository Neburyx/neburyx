import type { GraphNode, GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { elementKey } from './keys.js';
import { choicesOf, choiceTextOf, propertyFilteredKeys, satisfies, type ChoiceCondition } from './property-filter.js';
import { node, ref } from './test-data.js';
import type { LoadedGraph } from './loaded-graph.js';

const prop = (key: string, value: unknown, dataClass: GraphProperty['dataClass'] = 'text', masked = false): GraphProperty => ({ key, value, dataClass, masked, ...(masked ? { maskedBy: 'request' as const } : {}) });
const held = (id: string, type: string, ...properties: GraphProperty[]): GraphNode => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type }, properties });
const graphOf = (...nodes: GraphNode[]): LoadedGraph => ({ nodes, edges: [], entities: { value: nodes.length, quality: 'exact', scope: 'loaded in this view' }, relationships: { value: 0, quality: 'exact', scope: 'loaded in this view' } });
const ofType = (nodes: readonly GraphNode[], type: string): GraphNode[] => nodes.filter((candidate) => candidate.ref.entityType === type);
const choice = (type: string, property: string, kind: ChoiceCondition['kind'], ...values: string[]): ChoiceCondition => ({ on: 'entity', type, property, kind, op: 'in', values });

describe('the text a choice lists', () => {
  it('is the value as it is for text, true or false for a boolean, the canonical decimal for a number', () => {
    expect(choiceTextOf(prop('p', 'a'))).toBe('a');
    expect(choiceTextOf(prop('p', true, 'boolean'))).toBe('true');
    expect(choiceTextOf(prop('p', '2000.50', 'number'))).toBe('2000.5');
    expect(choiceTextOf(prop('p', 1e21, 'number'))).toBe('1000000000000000000000');
  });

  it('is nothing for a masked value, a missing one, one of another class or one that is not a number', () => {
    expect(choiceTextOf(prop('p', 'I••• L•••', 'text', true))).toBeUndefined();
    expect(choiceTextOf(undefined)).toBeUndefined();
    expect(choiceTextOf(prop('p', undefined))).toBeUndefined();
    expect(choiceTextOf(prop('p', 'x', 'date'))).toBeUndefined();
    expect(choiceTextOf(prop('p', Number.NaN, 'number'))).toBeUndefined();
    expect(choiceTextOf(prop('p', 'Infinity', 'number'))).toBeUndefined();
  });
});

describe('whether an item satisfies a condition', () => {
  const condition = choice('kind-a', 'score', 'text', 'a', 'b');

  it('does when its value is one of the chosen ones', () => {
    expect(satisfies(condition, prop('score', 'a'))).toBe(true);
    expect(satisfies(condition, prop('score', 'b'))).toBe(true);
  });

  it('does not for another value, a missing property, a masked value, or a value of another class', () => {
    expect(satisfies(condition, prop('score', 'c'))).toBe(false);
    expect(satisfies(condition, undefined)).toBe(false);
    expect(satisfies(condition, prop('score', 'a', 'text', true))).toBe(false);
    expect(satisfies(condition, prop('score', 'a', 'number'))).toBe(false);
    expect(satisfies(condition, prop('score', null))).toBe(false);
  });

  it('compares a number by its canonical text, so 2000.0 and 2000 are one value', () => {
    expect(satisfies(choice('kind-a', 'score', 'number', '2000'), prop('score', '2000.0', 'number'))).toBe(true);
    expect(satisfies(choice('kind-a', 'score', 'number', '2000'), prop('score', 2000, 'number'))).toBe(true);
    expect(satisfies(choice('kind-a', 'score', 'number', '2000'), prop('score', 2000, 'text'))).toBe(false);
    expect(satisfies(choice('kind-a', 'score', 'number', '1000000000000000000000'), prop('score', 1e21, 'number'))).toBe(true);
  });
});

describe('the choices the loaded entities of a type offer', () => {
  it('lists every distinct non-masked value once, in order, and counts the entities with no value', () => {
    const nodes = [held('1', 'kind-a', prop('score', 'b')), held('2', 'kind-a', prop('score', 'a')), held('3', 'kind-a', prop('score', 'b')), held('4', 'kind-a'), held('5', 'kind-b', prop('score', 'z'))];
    expect(choicesOf(ofType(nodes, 'kind-a'), 'score')).toEqual({ values: ['a', 'b'], observed: 'text', masked: false, missing: 1, unusable: 0, loaded: 4 });
  });

  it('orders numbers by value and booleans false before true', () => {
    expect(choicesOf([held('1', 'k', prop('n', '10', 'number')), held('2', 'k', prop('n', '9', 'number')), held('3', 'k', prop('n', '9.5', 'number'))], 'n').values).toEqual(['9', '9.5', '10']);
    expect(choicesOf([held('1', 'k', prop('b', true, 'boolean')), held('2', 'k', prop('b', false, 'boolean'))], 'b').values).toEqual(['false', 'true']);
  });

  it('has no observed kind for mixed classes, and none for a class a choice cannot be made on', () => {
    expect(choicesOf([held('1', 'k', prop('p', 'a')), held('2', 'k', prop('p', '1', 'number'))], 'p').observed).toBeUndefined();
    expect(choicesOf([held('1', 'k', prop('p', '2026-01-01', 'date'))], 'p').observed).toBeUndefined();
  });

  it('offers only the values of the declared kind when one is given, and counts the values a stored document would refuse', () => {
    const items = [held('1', 'k', prop('p', '5', 'number')), held('2', 'k', prop('p', 'a')), held('3', 'k', prop('p', '')), held('4', 'k', prop('p', 'x'.repeat(257)))];
    expect(choicesOf(items, 'p', 'text')).toMatchObject({ values: ['a'], unusable: 2 });
    expect(choicesOf(items, 'p', 'number').values).toEqual(['5']);
    expect(choicesOf([held('1', 'k', prop('p', '5', 'number'))], 'p', 'text').values).toEqual([]);
  });

  it('says a property is masked when any loaded value is, and counts and lists nothing of the masked ones', () => {
    const choices = choicesOf(ofType([held('1', 'k', prop('p', 'a')), held('2', 'k', prop('p', 'I••• L•••', 'text', true)), held('3', 'k')], 'k'), 'p');
    expect(choices.masked).toBe(true);
    expect(choices.values).toEqual(['a']);
    expect(choices.missing).toBe(1);
  });
});

describe('the entities a property condition leaves out', () => {
  const nodes = [held('1', 'kind-a', prop('score', 'a')), held('2', 'kind-a', prop('score', 'b')), held('3', 'kind-a', prop('score', 'c')), held('4', 'kind-a'), held('5', 'kind-a', prop('score', 'a', 'text', true)), held('6', 'kind-a', prop('score', 1, 'number')), held('7', 'kind-b', prop('score', 'zzz'))];
  const graph = graphOf(...nodes);
  const key = (id: string, type = 'kind-a'): string => elementKey(ref('a', type, id));

  it('leaves out the entities of its type that do not match, whatever the reason, and touches no other type', () => {
    const out = propertyFilteredKeys(graph, [choice('kind-a', 'score', 'text', 'a')]);
    expect([...out].sort()).toEqual([key('2'), key('3'), key('4'), key('5'), key('6')].sort());
    expect(out.has(key('7', 'kind-b'))).toBe(false);
  });

  it('ANDs the conditions on two properties of one type', () => {
    const two = graphOf(held('1', 'k', prop('p', 'a'), prop('q', 'x')), held('2', 'k', prop('p', 'a'), prop('q', 'y')), held('3', 'k', prop('p', 'b'), prop('q', 'x')));
    const out = propertyFilteredKeys(two, [choice('k', 'p', 'text', 'a'), choice('k', 'q', 'text', 'x')]);
    expect([...out].sort()).toEqual([elementKey(ref('a', 'k', '2')), elementKey(ref('a', 'k', '3'))].sort());
  });

  it('leaves out nothing without a condition, and gives the same set for the same graph and conditions', () => {
    expect(propertyFilteredKeys(graph, []).size).toBe(0);
    const conditions = [choice('kind-a', 'score', 'text', 'a')];
    expect(propertyFilteredKeys(graph, conditions)).toBe(propertyFilteredKeys(graph, conditions));
  });

  it('ignores a condition on a relationship type', () => {
    expect(propertyFilteredKeys(graph, [{ ...choice('kind-a', 'score', 'text', 'a'), on: 'relationship' }]).size).toBe(0);
  });
});

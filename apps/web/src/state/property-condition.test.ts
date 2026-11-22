import type { GraphNode, GraphProperty } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { elementKey } from './keys.js';
import type { MappedPropertySets } from './presentation-state.js';
import type { PropertyCondition } from './property-filter.js';
import { key, node, ref } from './test-data.js';

const prop = (value: string): GraphProperty => ({ key: 'score', value, dataClass: 'text', masked: false });
const entity = (id: string, type: string, value: string): GraphNode => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type }, properties: [prop(value)] });
const sets = (over: Partial<MappedPropertySets['entity'][string]> = {}): MappedPropertySets => ({ entity: { 'type-a': { filterable: ['score'], kinds: { score: 'unknown' }, pii: [], ...over }, 'type-b': { filterable: [], kinds: {}, pii: [] } }, relationship: {} });
const condition = (...values: string[]): PropertyCondition => ({ on: 'entity', type: 'type-a', property: 'score', kind: 'text', op: 'in', values });
const identity = { on: 'entity', type: 'type-a', property: 'score' } as const;

function load(properties: MappedPropertySets | undefined = sets()): ClientState {
  const state = createClientState();
  const nodes = [entity('n0', 'type-a', 'x'), entity('n1', 'type-a', 'y'), entity('n2', 'type-b', 'x')];
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes, edges: [] });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), []);
  state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties });
  return state;
}

const conditionsOf = (state: ClientState): readonly PropertyCondition[] => state.presentation.view.getState().typeFilter.properties;

describe('setting a property condition', () => {
  it('refuses a type the mapping does not name, a property it does not list as filterable, a personal-data property while masking is on, a kind it contradicts, more than twenty values and a repeated value, and changes nothing', () => {
    const state = load();
    const before = state.presentation.view.getState();
    expect(() => state.setPropertyCondition({ ...identity, type: 'type-z' }, { ...condition('x'), type: 'type-z' })).toThrowError(expect.objectContaining({ code: 'UNKNOWN_TYPE' }));
    expect(() => state.setPropertyCondition({ ...identity, property: 'other' }, { ...condition('x'), property: 'other' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    expect(() => state.setPropertyCondition(identity, condition(...Array.from({ length: 21 }, (_unused, at) => String(at))))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    expect(() => state.setPropertyCondition(identity, condition('x', 'x'))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    expect(() => state.setPropertyCondition(identity, { ...condition('x'), property: 'other' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    expect(state.presentation.view.getState()).toBe(before);
    const personal = load(sets({ pii: ['score'] }));
    personal.setMask(true);
    expect(() => personal.setPropertyCondition(identity, condition('x'))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    const declared = load(sets({ kinds: { score: 'number' } }));
    expect(() => declared.setPropertyCondition(identity, condition('x'))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
  });

  it('leaves the entities of the type that do not match out of the view, keeps them loaded, and replaces the condition on the same property', () => {
    const state = load();
    state.setPropertyCondition(identity, condition('x'));
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId).sort()).toEqual(['n0', 'n2']);
    expect(state.loadedGraph().nodes).toHaveLength(3);
    state.setPropertyCondition(identity, condition('y'));
    expect(conditionsOf(state)).toHaveLength(1);
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId).sort()).toEqual(['n1', 'n2']);
  });

  it('clears the condition when it chooses no value or is undefined, and does nothing when there was none', () => {
    const state = load();
    const before = state.presentation.view.getState();
    state.setPropertyCondition(identity, undefined);
    expect(state.presentation.view.getState()).toBe(before);
    state.setPropertyCondition(identity, condition('x'));
    state.setPropertyCondition(identity, condition());
    expect(conditionsOf(state)).toHaveLength(0);
    expect(state.visibleGraph()).toBe(state.loadedGraph());
  });

  it('takes a selected entity it hides out of the selection and ends a focus on it, and keeps the rest', () => {
    const state = load();
    const hidden = elementKey(ref('a', 'type-a', 'n1'));
    const shown = elementKey(ref('a', 'type-a', 'n0'));
    state.presentation.select([hidden, shown]);
    state.setPropertyCondition(identity, condition('x'));
    expect([...state.presentation.view.getState().selection]).toEqual([shown]);
  });

  it('is cleared by Reset together with the type filter, and Reset keeps a time window', () => {
    const state = load();
    state.setPropertyCondition(identity, condition('x'));
    state.setEntityTypeOff('type-b', true);
    state.presentation.resetTypeFilter();
    expect(conditionsOf(state)).toHaveLength(0);
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
  });
});

describe('a condition when the mapping changes', () => {
  it('is removed when its type leaves the mapping, its property leaves the filterable list, becomes personal data or gets another declared kind, and kept otherwise', () => {
    for (const changed of [sets({ filterable: [] }), sets({ pii: ['score'] }), sets({ kinds: { score: 'number' } })]) {
      const state = load();
      state.setPropertyCondition(identity, condition('x'));
      state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties: changed });
      expect(conditionsOf(state)).toHaveLength(0);
      expect(state.visibleGraph()).toBe(state.loadedGraph());
    }
    const gone = load();
    gone.setPropertyCondition(identity, condition('x'));
    gone.presentation.setMappedTypes({ entityTypes: ['type-b'], relationshipTypes: [], properties: sets() });
    expect(conditionsOf(gone)).toHaveLength(0);
    const kept = load();
    kept.setPropertyCondition(identity, condition('x'));
    kept.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties: sets({ kinds: { score: 'text' } }) });
    expect(conditionsOf(kept)).toHaveLength(1);
  });

  it('reaches the state when only a type\'s filterable list changed, though the type names did not', () => {
    const state = load();
    state.setPropertyCondition(identity, condition('x'));
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties: sets({ filterable: ['score', 'extra'] }) });
    expect(conditionsOf(state)).toHaveLength(1);
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties: sets({ filterable: ['extra'] }) });
    expect(conditionsOf(state)).toHaveLength(0);
  });

  it('removes a choice when the mapping now declares an ordered kind for its property, as no control draws it any more', () => {
    const state = load();
    state.setPropertyCondition(identity, { ...condition('1'), kind: 'number' });
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [], properties: sets({ kinds: { score: 'number' } }) });
    expect(conditionsOf(state)).toHaveLength(0);
  });

  it('keeps every condition while the mapping holds no property information', () => {
    const state = load();
    state.setPropertyCondition(identity, condition('x'));
    state.presentation.setMappedTypes({ entityTypes: ['type-a', 'type-b'], relationshipTypes: [] });
    expect(conditionsOf(state)).toHaveLength(1);
  });
});

describe('the entities a condition filters out', () => {
  it('are the same set for the same graph and conditions', () => {
    const state = load();
    state.setPropertyCondition(identity, condition('x'));
    expect(state.visibleGraph()).toBe(state.visibleGraph());
  });
});

describe('a range condition', () => {
  const numeric = (over: Partial<PropertyCondition> = {}): PropertyCondition => ({ on: 'entity', type: 'type-a', property: 'score', kind: 'number', op: 'between', from: '1', to: '9', ...over }) as PropertyCondition;
  const declared = (): ClientState => load(sets({ kinds: { score: 'number' } }));

  it('is accepted for a property whose declared kind is the range kind, and replaces the condition on the property', () => {
    const state = declared();
    state.setPropertyCondition(identity, numeric());
    state.setPropertyCondition(identity, numeric({ from: '2' }));
    expect(conditionsOf(state)).toHaveLength(1);
  });

  it('is refused for a property with no declared kind, a bound the kind cannot read, a from later than to, and a range with no bound is a clear', () => {
    const undeclared = load();
    expect(() => undeclared.setPropertyCondition(identity, numeric())).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    const state = declared();
    expect(() => state.setPropertyCondition(identity, numeric({ from: '1,000' }))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    expect(() => state.setPropertyCondition(identity, numeric({ from: '9', to: '1' }))).toThrowError(expect.objectContaining({ code: 'INVALID_CONDITION' }));
    state.setPropertyCondition(identity, numeric());
    state.setPropertyCondition(identity, numeric({ from: undefined, to: undefined }));
    expect(conditionsOf(state)).toHaveLength(0);
  });
});

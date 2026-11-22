import type { GraphEdge, GraphNode, GraphProperty, SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { filteredRelationshipsOf } from './filtered-relationships.js';
import { edgeKey, elementKey } from './keys.js';
import { mappedPropertiesOf } from './mapped-properties.js';
import type { MappedPropertySets } from './presentation-state.js';
import type { PropertyCondition } from './property-filter.js';
import { edgeRef, key, node, ref } from './test-data.js';
import { testProfile } from '../dev/test-profile.js';

const prop = (value: string): GraphProperty => ({ key: 'weight', value, dataClass: 'text', masked: false });
const entity = (id: string): GraphNode => ({ ...node('a', id), ref: ref('a', 'kind-a', id) });
const link = (id: string, from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge => ({ ref: edgeRef('a', id, 'link-a', 'kind-a', 'kind-a'), from: ref('a', 'kind-a', from), to: ref('a', 'kind-a', to), type: 'link-a', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [], ...over });
const sets: MappedPropertySets = { entity: { 'kind-a': { filterable: [], kinds: {}, pii: [] } }, relationship: { 'link-a': { filterable: ['weight'], kinds: { weight: 'unknown' }, pii: [] } } };
const condition = (...values: string[]): PropertyCondition => ({ on: 'relationship', type: 'link-a', property: 'weight', kind: 'text', op: 'in', values });
const identity = { on: 'relationship', type: 'link-a', property: 'weight' } as const;

function load(edges: readonly GraphEdge[], nodes: readonly GraphNode[] = ['n0', 'n1', 'n2', 'n3'].map(entity)): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes: [...nodes], edges: [...edges] });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
  state.presentation.setMappedTypes({ entityTypes: ['kind-a'], relationshipTypes: ['link-a'], properties: sets });
  return state;
}

const shownEdges = (state: ClientState): string[] => state.visibleGraph().edges.map((candidate) => candidate.ref).map((reference) => ('stableId' in reference ? reference.stableId : 'other')).sort();

describe('a condition on a relationship type', () => {
  const edges = [link('e1', 'n0', 'n1', { properties: [prop('heavy')] }), link('e2', 'n1', 'n2', { properties: [prop('light')] }), link('e3', 'n2', 'n3')];

  it('leaves the relationships of the type that do not match out of the view, with any reason, and keeps them loaded', () => {
    const state = load(edges);
    state.setPropertyCondition(identity, condition('heavy'));
    expect(shownEdges(state)).toEqual(['e1']);
    expect(state.loadedGraph().edges).toHaveLength(3);
  });

  it('leaves the entities whose every loaded relationship is out, and keeps one that has a relationship shown', () => {
    const state = load(edges);
    state.setPropertyCondition(identity, condition('heavy'));
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId).sort()).toEqual(['n0', 'n1']);
  });

  it('does not judge a derived or an aggregate relationship: it stays shown and is counted', () => {
    const derived = link('d1', 'n0', 'n3', { semantics: 'derived', derivation: { ruleId: 'rule-1', ruleVersion: 1, supportingEdgeRefs: [] }, ref: { sourceId: 'a', derived: { ruleId: 'rule-1', from: ref('a', 'kind-a', 'n0'), to: ref('a', 'kind-a', 'n3') } } });
    const aggregate = link('g1', 'n1', 'n3', { ref: { sourceId: 'a', aggregate: { type: 'link-a', from: ref('a', 'kind-a', 'n1'), to: ref('a', 'kind-a', 'n3') } }, memberCount: { value: 5, quality: 'exact', scope: 'aggregate:members' } });
    const state = load([...edges, derived, aggregate]);
    state.setPropertyCondition(identity, condition('heavy'));
    expect(shownEdges(state)).toEqual(['e1', 'other', 'other']);
    const graph = state.loadedGraph();
    expect(filteredRelationshipsOf(graph, state.presentation.view.getState().typeFilter).unjudged).toBe(2);
  });

  it('counts a relationship out by the time window and one out by the property together for an entity', () => {
    const state = load([link('e1', 'n0', 'n1', { properties: [prop('heavy')], observedAt: '2020-01-01T00:00:00Z' }), link('e2', 'n1', 'n2', { properties: [prop('light')], observedAt: '2026-03-01T00:00:00Z' }), link('e3', 'n0', 'n2', { properties: [prop('heavy')], observedAt: '2026-03-01T00:00:00Z' })]);
    state.presentation.setMappedTypes({ entityTypes: ['kind-a'], relationshipTypes: ['link-a'], properties: sets, datedRelationships: [{ type: 'link-a', from: 'kind-a', to: 'kind-a' }] });
    state.setTimeWindow({ from: '2026-01-01', to: '2026-12-31' });
    state.setPropertyCondition(identity, condition('heavy'));
    const filter = state.presentation.view.getState().typeFilter;
    const out = filteredRelationshipsOf(state.loadedGraph(), filter);
    expect([...out.relationships].sort()).toEqual([edgeKey(edgeRef('a', 'e1', 'link-a', 'kind-a', 'kind-a')), edgeKey(edgeRef('a', 'e2', 'link-a', 'kind-a', 'kind-a'))].sort());
    expect(out.entities.has(elementKey(ref('a', 'kind-a', 'n1')))).toBe(true);
    expect(out.entities.has(elementKey(ref('a', 'kind-a', 'n0')))).toBe(false);
  });

  it('is the one derivation the drawn graph, the filtered entities and Reset all use: a property condition alone changes all of them', () => {
    const state = load(edges);
    state.setPropertyCondition(identity, condition('heavy'));
    const filter = state.presentation.view.getState().typeFilter;
    expect(filter.time).toBeUndefined();
    expect(shownEdges(state)).toEqual(['e1']);
    expect(filteredRelationshipsOf(state.loadedGraph(), filter).entities.size).toBe(2);
    state.presentation.resetTypeFilter();
    expect(shownEdges(state)).toEqual(['e1', 'e2', 'e3']);
  });

  it('gives the same object whenever no relationship condition is set', () => {
    const state = load(edges);
    const filter = state.presentation.view.getState().typeFilter;
    expect(filteredRelationshipsOf(state.loadedGraph(), filter)).toBe(filteredRelationshipsOf(state.loadedGraph(), filter));
  });

  it('gives the same object for the same graph, filter and UTC day, and derives again on a new day', () => {
    const state = load(edges);
    state.setPropertyCondition(identity, condition('heavy'));
    const filter = state.presentation.view.getState().typeFilter;
    const graph = state.loadedGraph();
    const noon = new Date('2026-03-01T12:00:00Z');
    expect(filteredRelationshipsOf(graph, filter, noon)).toBe(filteredRelationshipsOf(graph, filter, new Date('2026-03-01T20:00:00Z')));
    const windowed = { ...filter, time: { window: { days: 7 }, rows: [{ type: 'link-a', from: 'kind-a', to: 'kind-a' }] } };
    expect(filteredRelationshipsOf(graph, windowed, noon)).not.toBe(filteredRelationshipsOf(graph, windowed, new Date('2026-03-02T12:00:00Z')));
  });
});

describe('the properties of a relationship type with several rows', () => {
  const row = (over: Partial<SourceProfile['relationshipTypes'][number]>): SourceProfile['relationshipTypes'][number] => ({ type: 'link-a', from: 'kind-a', to: 'kind-b', aggregate: false, observedAt: null, filterable: ['weight'], sortable: [], evidence: [], properties: [], stableIdProperty: null, ...over });
  const profileOf = (...rows: SourceProfile['relationshipTypes']): SourceProfile => ({ ...testProfile(), relationshipTypes: rows });

  it('lists a property when a stored row lists it, ignores an aggregate row, and takes the kind another row declares for a row that declares none', () => {
    const sets = mappedPropertiesOf(profileOf(row({ filterKinds: { weight: 'number' } }), row({ from: 'kind-b', to: 'kind-c', filterKinds: { weight: 'unknown' } }), row({ aggregate: true, from: 'kind-c', to: 'kind-a', filterable: ['other'] })));
    expect(sets.relationship['link-a']).toEqual({ filterable: ['weight'], kinds: { weight: 'number' }, pii: [] });
  });

  it('leaves a property out when the stored rows that list it declare different kinds, so nothing can be filtered by it', () => {
    const sets = mappedPropertiesOf(profileOf(row({ filterKinds: { weight: 'number' } }), row({ from: 'kind-b', to: 'kind-c', filterKinds: { weight: 'text' } })));
    expect(sets.relationship['link-a']?.filterable).toEqual([]);
  });

  it('has no entry for a type that has only an aggregate row', () => {
    expect(mappedPropertiesOf(profileOf(row({ aggregate: true }))).relationship['link-a']).toBeUndefined();
  });
});

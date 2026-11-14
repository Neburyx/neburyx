import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientState, type ClientState } from './client-state.js';
import { edgeKey, elementKey } from './keys.js';
import { boundsOf, instantOf, timeFilteredOf } from './time-window.js';
import { edge, key, node, ref } from './test-data.js';

const NOW = new Date('2026-11-14T10:30:00Z');
const typed = (id: string, entityType = 'kind-a'): GraphNode => ({ ...node('a', id), ref: ref('a', entityType, id), display: { title: id, type: entityType } });
const timed = (id: string, from: string, to: string, observedAt?: string, type = 'rel-a', ends: readonly [string, string] = ['kind-a', 'kind-a']): GraphEdge => ({
  ...edge('a', id, from, to),
  type,
  from: ref('a', ends[0], from),
  to: ref('a', ends[1], to),
  ...(observedAt === undefined ? {} : { observedAt }),
});
const rows = [{ type: 'rel-a', from: 'kind-a', to: 'kind-a' }];

function load(nodes: readonly GraphNode[], edges: readonly GraphEdge[], datedRelationships = rows): ClientState {
  const state = createClientState();
  state.bindSource('a');
  state.putResult(key('a'), { sourceId: 'a', nodes, edges });
  state.setLoaded([key('a')], nodes.map((candidate) => candidate.ref), edges.map((candidate) => candidate.ref));
  state.presentation.setMappedTypes({ entityTypes: ['kind-a', 'kind-b'], relationshipTypes: ['rel-a', 'rel-b'], datedRelationships });
  return state;
}

afterEach(() => vi.useRealTimers());

describe('the instant a time text names', () => {
  it('reads a zoned time as it is, and a local date time or a date as UTC', () => {
    expect(instantOf('2026-11-14T10:30:00+02:00')).toBe(Date.parse('2026-11-14T08:30:00Z'));
    expect(instantOf('2026-11-14T10:30:00')).toBe(Date.parse('2026-11-14T10:30:00Z'));
    expect(instantOf('2026-11-14')).toBe(Date.parse('2026-11-14T00:00:00Z'));
    expect(instantOf('2026-01-02T03:04:05+01:00[Europe/Paris]')).toBe(Date.parse('2026-01-02T02:04:05Z'));
  });

  it('reads text, a number and a date that does not exist as no usable time', () => {
    for (const text of ['yesterday', '1731580000', '2026-02-31', '', undefined]) expect(instantOf(text)).toBeUndefined();
  });
});

describe('the bounds of a window', () => {
  it('runs a number of days from 00:00 UTC that many days before today to the end of today', () => {
    expect(boundsOf({ days: 7 }, NOW)).toEqual({ start: Date.parse('2026-11-07T00:00:00Z'), end: Date.parse('2026-11-15T00:00:00Z') });
  });

  it('runs dates from 00:00 UTC of the first to the end of the last', () => {
    expect(boundsOf({ from: '2026-10-21', to: '2026-10-28' }, NOW)).toEqual({ start: Date.parse('2026-10-21T00:00:00Z'), end: Date.parse('2026-10-29T00:00:00Z') });
  });
});

describe('the time window on the loaded graph', () => {
  it('draws a relationship at the start instant and not one at 00:00 UTC after the last day', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load(
      [typed('n0'), typed('n1'), typed('n2'), typed('n3')],
      [timed('at-start', 'n0', 'n1', '2026-10-21T00:00:00Z'), timed('before', 'n0', 'n2', '2026-10-20T23:59:59Z'), timed('at-end', 'n1', 'n3', '2026-10-29T00:00:00Z'), timed('last-moment', 'n2', 'n3', '2026-10-28T23:59:59Z')],
    );
    state.setTimeWindow({ from: '2026-10-21', to: '2026-10-28' });
    expect(state.visibleGraph().edges.map((candidate) => candidate.ref)).toEqual([timed('at-start', 'n0', 'n1').ref, timed('last-moment', 'n2', 'n3').ref]);
    expect(state.loadedGraph().edges).toHaveLength(4);
  });

  it('draws an aggregate that overlaps the window and not one that does not', () => {
    const aggregate = (id: string, first: string, last: string): GraphEdge => ({
      ...timed(id, 'n0', 'n1'),
      ref: { sourceId: 'a', aggregate: { type: 'rel-a', from: ref('a', 'kind-a', 'n0'), to: ref('a', 'kind-a', 'n1') } },
      memberCount: { quality: 'exact', value: 3, scope: 'members' },
      observedFirst: first,
      observedLast: last,
    });
    const inside = aggregate('x', '2026-10-01', '2026-10-22');
    const outside = aggregate('y', '2026-09-01', '2026-10-01');
    const state = load([typed('n0'), typed('n1')], [inside]);
    const graph = state.loadedGraph();
    expect(timeFilteredOf(graph, { window: { from: '2026-10-21', to: '2026-10-28' }, rows }, NOW).relationships.size).toBe(0);
    const other = load([typed('n0'), typed('n1')], [outside]).loadedGraph();
    expect(timeFilteredOf(other, { window: { from: '2026-10-21', to: '2026-10-28' }, rows }, NOW).relationships.size).toBe(1);
  });

  it('filters out an entity whose loaded relationships are all outside, and keeps one with a relationship inside or with none', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1'), typed('n2'), typed('lone')], [timed('old', 'n0', 'n1', '2026-01-01'), timed('new', 'n1', 'n2', '2026-11-13')]);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId)).toEqual(['n1', 'n2', 'lone']);
    expect(state.visibleGraph().edges.map((candidate) => candidate.ref)).toEqual([timed('new', 'n1', 'n2').ref]);
  });

  it('leaves a relationship of a row with no time, and a derived relationship, as they were', () => {
    vi.useFakeTimers({ now: NOW });
    const derived: GraphEdge = { ...timed('d', 'n0', 'n1', '2020-01-01'), semantics: 'derived', derivation: { ruleId: 'r', ruleVersion: 1, supportingEdgeRefs: [] } };
    const state = load([typed('n0'), typed('n1'), typed('n2')], [timed('plain', 'n0', 'n2', '2020-01-01', 'rel-b'), derived]);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().edges).toHaveLength(2);
    expect(state.visibleGraph().nodes).toHaveLength(3);
  });

  it('judges each relationship by its own row when one type is dated on one row and not on another', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1'), typed('m0', 'kind-b'), typed('m1', 'kind-b')], [timed('dated-row', 'n0', 'n1', '2020-01-01'), timed('undated-row', 'm0', 'm1', '2020-01-01', 'rel-a', ['kind-b', 'kind-b'])]);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().edges.map((candidate) => candidate.ref)).toEqual([timed('undated-row', 'm0', 'm1', undefined, 'rel-a', ['kind-b', 'kind-b']).ref]);
  });

  it('keeps a relationship of a dated row that has no usable time shown, and counts it', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1'), typed('n2')], [timed('none', 'n0', 'n1'), timed('text', 'n1', 'n2', 'last week')]);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().edges).toHaveLength(2);
    expect(timeFilteredOf(state.loadedGraph(), state.presentation.view.getState().typeFilter.time, NOW).undated).toBe(2);
  });

  it('filters nothing out while the mapping has no dated row, and keeps the window', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1')], [timed('old', 'n0', 'n1', '2020-01-01')], []);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().edges).toHaveLength(1);
    expect(state.presentation.view.getState().typeFilter.time?.window).toEqual({ days: 7 });
    state.presentation.setMappedTypes({ entityTypes: ['kind-a'], relationshipTypes: ['rel-a'], datedRelationships: rows });
    expect(state.visibleGraph().edges).toHaveLength(0);
  });

  it('brings everything back on reset and removes nothing from the investigation', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1')], [timed('old', 'n0', 'n1', '2020-01-01')]);
    state.setTimeWindow({ days: 7 });
    expect(state.visibleGraph().nodes).toHaveLength(0);
    expect(state.loadedGraph().nodes).toHaveLength(2);
    state.setTimeWindow(undefined);
    expect(state.visibleGraph().nodes).toHaveLength(2);
    expect(state.visibleGraph().edges).toHaveLength(1);
  });

  it('is left alone by the Reset of the type filters, and leaves the type filters alone itself', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1'), typed('n2', 'kind-b')], [timed('old', 'n0', 'n1', '2020-01-01')]);
    state.setTimeWindow({ days: 7 });
    state.setEntityTypeOff('kind-b', true);
    state.presentation.resetTypeFilter();
    expect(state.presentation.view.getState().typeFilter.time?.window).toEqual({ days: 7 });
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.size).toBe(0);
    state.setEntityTypeOff('kind-b', true);
    state.setTimeWindow(undefined);
    expect(state.presentation.view.getState().typeFilter.offEntityTypes.has('kind-b')).toBe(true);
  });

  it('judges items an expansion adds by the same window at once', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1')], [timed('new', 'n0', 'n1', '2026-11-13')]);
    state.setTimeWindow({ days: 7 });
    const more = [typed('n2')];
    const moreEdges = [timed('older', 'n1', 'n2', '2020-01-01')];
    state.putResult(key('a', 'more'), { sourceId: 'a', nodes: more, edges: moreEdges });
    state.setLoaded([key('a'), key('a', 'more')], [...state.loadedGraph().nodes, ...more].map((candidate) => candidate.ref), [...state.loadedGraph().edges, ...moreEdges].map((candidate) => candidate.ref));
    expect(state.visibleGraph().nodes.map((candidate) => candidate.ref.stableId)).toEqual(['n0', 'n1']);
  });

  it('takes the items it filters out from the selection and the focus', () => {
    vi.useFakeTimers({ now: NOW });
    const state = load([typed('n0'), typed('n1'), typed('n2')], [timed('old', 'n0', 'n1', '2020-01-01'), timed('new', 'n1', 'n2', '2026-11-13')]);
    const gone = elementKey(ref('a', 'kind-a', 'n0'));
    state.presentation.select([gone, edgeKey(timed('old', 'n0', 'n1').ref)]);
    state.setTimeWindow({ days: 7 });
    expect([...state.presentation.view.getState().selection]).toEqual([]);
  });
});

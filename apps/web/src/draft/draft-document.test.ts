import type { GraphEdge } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { deriveLoadedGraph } from '../state/loaded-graph.js';
import { key, ref, result } from '../state/test-data.js';
import { draftOf, keptFrom, NOTHING_KEPT, refsOf } from './draft-document.js';

const PRESENTATION = { layout: 'force' as const, positions: new Map(), pins: new Set<string>(), hidden: new Set<string>(), viewport: undefined, typeFilter: { offEntityTypes: new Set<string>(), offRelationshipTypes: new Set<string>() }, mappedTypes: undefined };

function loaded(nodes: readonly string[], edges: ReadonlyArray<readonly [string, string, string]> = []) {
  const state = createClientState();
  state.bindSource('demo');
  const read = result('demo', nodes, edges);
  state.putResult(key('demo'), read);
  state.setLoaded([key('demo')], read.nodes.map((n) => n.ref), read.edges.map((e) => e.ref));
  return { state, graph: deriveLoadedGraph(state.server.getState(), state.investigation.getState()), nodeRefs: read.nodes.map((n) => n.ref) };
}

describe('the draft as it is written', () => {
  it('holds each loaded entity once with its position, pin and hidden mark, and the viewport and layout name', () => {
    const { graph, nodeRefs } = loaded(['A', 'B']);
    const [first, second] = nodeRefs;
    if (first === undefined || second === undefined) throw new Error('two entities');
    const body = draftOf({
      nodeRefs,
      graph,
      presentation: { ...PRESENTATION, layout: 'radial', positions: new Map([[elementKey(first), { x: 4, y: 5 }]]), pins: new Set([elementKey(first)]), hidden: new Set([elementKey(second)]), viewport: { zoom: 2, x: 3, y: 4 } },
      notes: 'kept note',
      kept: NOTHING_KEPT,
    });
    expect(body.layout.layout).toBe('radial');
    expect(body.layout.viewport).toEqual({ zoom: 2, x: 3, y: 4 });
    expect(body.layout.nodes).toEqual([
      { t: 'type-a', id: 'A', x: 4, y: 5, pinned: true, hidden: false, groupId: null },
      { t: 'type-a', id: 'B', pinned: false, hidden: true, groupId: null },
    ]);
    expect(body.queryContext.loaded.nodes).toEqual([{ t: 'type-a', id: 'A' }, { t: 'type-a', id: 'B' }]);
    expect(body.queryContext.expansions).toEqual([]);
    expect(body.notes).toBe('kept note');
  });

  it('names the entity type of both ends of a stored edge, an aggregate and a derived relationship, each in its own form', () => {
    const { graph, nodeRefs } = loaded(['A', 'B'], [['E-1', 'A', 'B']]);
    const stored = graph.edges[0];
    if (stored === undefined) throw new Error('an edge');
    const aggregate: GraphEdge = { ...stored, ref: { sourceId: 'demo', aggregate: { type: 'rel-b', from: ref('demo', 'type-a', 'A'), to: ref('demo', 'type-a', 'B') } }, type: 'rel-b', memberCount: { value: 3, quality: 'exact', scope: 'aggregate:members' } };
    const derived: GraphEdge = { ...stored, ref: { sourceId: 'demo', derived: { ruleId: 'shared', from: ref('demo', 'type-a', 'A'), to: ref('demo', 'type-a', 'B') } }, type: 'shared', semantics: 'derived', derivation: { ruleId: 'shared', ruleVersion: 1, supportingEdgeRefs: [] } };
    const body = draftOf({ nodeRefs, graph: { ...graph, edges: [stored, aggregate, derived] }, presentation: PRESENTATION, notes: null, kept: NOTHING_KEPT });
    const ends = { from: { t: 'type-a', id: 'A' }, to: { t: 'type-a', id: 'B' } };
    expect(body.queryContext.loaded.edges).toEqual([{ t: 'rel-a', ...ends, id: 'E-1' }, { t: 'rel-b', ...ends }, { t: 'shared', ...ends, ruleId: 'shared' }]);
    expect(body.layout.edges.every((entry) => entry.hidden === false)).toBe(true);
  });

  it('holds no selection, panel or property value', () => {
    const { graph, nodeRefs } = loaded(['A']);
    const text = JSON.stringify(draftOf({ nodeRefs, graph, presentation: PRESENTATION, notes: null, kept: NOTHING_KEPT }));
    expect(text).not.toMatch(/selection|panel|physics|direction|properties":\[\{/);
  });

  it('lists the types left on only when one is switched off, and none when the mapping is not known', () => {
    const { graph, nodeRefs } = loaded(['A']);
    const off = { offEntityTypes: new Set(['type-b']), offRelationshipTypes: new Set<string>() };
    const mapped = { entityTypes: ['type-a', 'type-b'], relationshipTypes: ['rel-a'] };
    expect(draftOf({ nodeRefs, graph, presentation: { ...PRESENTATION, typeFilter: off, mappedTypes: mapped }, notes: null, kept: NOTHING_KEPT }).queryContext.filters).toMatchObject({ entityTypes: ['type-a'], relTypes: [] });
    expect(draftOf({ nodeRefs, graph, presentation: { ...PRESENTATION, typeFilter: off }, notes: null, kept: NOTHING_KEPT }).queryContext.filters).toMatchObject({ entityTypes: [], relTypes: [] });
    expect(draftOf({ nodeRefs, graph, presentation: PRESENTATION, notes: null, kept: NOTHING_KEPT }).queryContext.filters).toMatchObject({ entityTypes: [], relTypes: [] });
  });

  it('keeps the items a read did not give back, and does not duplicate one that came back after all', () => {
    const { graph, nodeRefs } = loaded(['A']);
    const kept = { nodes: [{ t: 'type-a', id: 'GONE', pinned: true, hidden: false, groupId: null }, { t: 'type-a', id: 'A', pinned: false, hidden: false, groupId: null }], edges: [] };
    const body = draftOf({ nodeRefs, graph, presentation: PRESENTATION, notes: null, kept });
    expect(body.layout.nodes.map((entry) => entry.id)).toEqual(['A', 'GONE']);
    expect(body.queryContext.loaded.nodes.map((entry) => entry.id)).toEqual(['A', 'GONE']);
  });
});

describe('the references a stored draft names', () => {
  it('asks for each entity, and for each relationship in the list of its form', () => {
    const { graph, nodeRefs } = loaded(['A', 'B'], [['E-1', 'A', 'B']]);
    const body = draftOf({ nodeRefs, graph, presentation: PRESENTATION, notes: null, kept: NOTHING_KEPT });
    const asked = refsOf('demo', { ...body.queryContext, loaded: { ...body.queryContext.loaded, edges: [...body.queryContext.loaded.edges, { t: 'rel-b', from: { t: 'type-a', id: 'A' }, to: { t: 'type-a', id: 'B' } }, { t: 'shared', from: { t: 'type-a', id: 'A' }, to: { t: 'type-a', id: 'B' }, ruleId: 'shared' }] } });
    expect(asked.entities).toEqual([ref('demo', 'type-a', 'A'), ref('demo', 'type-a', 'B')]);
    expect(asked.edges).toEqual([{ sourceId: 'demo', type: 'rel-a', from: 'type-a', to: 'type-a', stableId: 'E-1' }]);
    expect(asked.aggregates).toEqual([{ sourceId: 'demo', aggregate: { type: 'rel-b', from: ref('demo', 'type-a', 'A'), to: ref('demo', 'type-a', 'B') } }]);
    expect(asked.derived).toEqual([{ sourceId: 'demo', derived: { ruleId: 'shared', from: ref('demo', 'type-a', 'A'), to: ref('demo', 'type-a', 'B') } }]);
  });

  it('keeps the entries of the references a read listed as missing, and no other', () => {
    const { graph, nodeRefs } = loaded(['A', 'B'], [['E-1', 'A', 'B']]);
    const body = draftOf({ nodeRefs, graph, presentation: PRESENTATION, notes: null, kept: NOTHING_KEPT });
    const asked = refsOf('demo', body.queryContext);
    const kept = keptFrom('demo', body.layout, body.queryContext, { entities: [ref('demo', 'type-a', 'B')], edges: asked.edges });
    expect(kept.nodes.map((entry) => entry.id)).toEqual(['B']);
    expect(kept.edges).toEqual([{ t: 'rel-a', from: { t: 'type-a', id: 'A' }, to: { t: 'type-a', id: 'B' }, id: 'E-1' }]);
  });
});

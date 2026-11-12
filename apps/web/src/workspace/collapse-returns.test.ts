import type { Count, DegreePreview, ElementRef, ExpandResponse } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { createExpandStore } from '../api/expand-store.js';
import { fakeClient } from '../api/fake-client.js';
import type { HeavyGuard } from '../api/heavy-guard.js';
import { testProfile } from '../dev/test-profile.js';
import { createClientState } from '../state/client-state.js';
import { elementKey } from '../state/keys.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { aggregateNodesOf } from './aggregate-nodes.js';
import { loadGraph } from './context-menu-kit.js';
import { coverageEntitiesOf } from './coverage-input.js';
import { loadedLine, remainderLine, shownCount } from './scope-text.js';
import { count, previewOf } from './supernode-kit.js';

const A = ref('a', 'type-a', 'n1');
const D = ref('a', 'type-a', 'n2');
const nodeOf = (type: string, id: string) => ({ ...node('a', id), ref: ref('a', type, id), display: { title: id, type } });
const page = (anchor: ElementRef, ids: readonly string[]): ExpandResponse => ({
  ref: anchor,
  pageSize: 25,
  nodes: [nodeOf(anchor.entityType, anchor.stableId), ...ids.map((id) => nodeOf('kind-b', id))],
  edges: ids.map((id) => ({ ref: edgeRef('a', `${anchor.stableId}-${id}`, 'link-a', 'type-a', 'kind-b'), from: anchor, to: ref('a', 'kind-b', id), type: 'link-a', direction: 'out' as const, semantics: 'stored' as const, properties: [], evidenceRefs: [], qualityFlags: [] })),
  pages: [{ neighborType: 'kind-b', returned: ids.length, hasMore: true, nextCursor: 'v1.c.m', matchingTotal: { value: 12, quality: 'exact', scope: 'x' } }],
  warnings: [],
});

/** What the server's coverage answer is made from: a preview held for every loaded node, or nothing. */
function rig(nodes: readonly ElementRef[] = [A], previewed: readonly ElementRef[] = nodes) {
  const asked: string[] = [];
  const held = new Set(previewed.map(elementKey));
  const client = fakeClient({
    expandNeighbors: (body) => {
      asked.push('expand');
      const anchor = nodes.find((entry) => entry.stableId === body.ref.stableId) ?? A;
      return Promise.resolve({ ok: true as const, value: page(anchor, anchor === A ? ['b1', 'b2'] : ['d1']) });
    },
  });
  const state = createClientState();
  loadGraph(state, nodes.map((entry) => node('a', entry.stableId)), []);
  // an ask that is checked fetches the node's preview first, as the heavy-operation check does
  const heavy: HeavyGuard = {
    decide: (ask) => {
      held.add(elementKey(ask.ref));
      return Promise.resolve({ kind: 'none' });
    },
    hold: () => undefined,
    release: () => undefined,
  };
  const store = createExpandStore(client, state, () => 'person', undefined, heavy);
  const aggregates = () =>
    aggregateNodesOf({
      graph: state.loadedGraph(),
      profile: testProfile('a', ['type-a']),
      touched: store.touched.getState(),
      previewOf: (target): DegreePreview | undefined => (held.has(elementKey(target)) ? previewOf({ ref: target, byNeighborType: [{ entityType: 'kind-b', count: count(12, 'exact') }] }) : undefined),
      expansionOf: store.of,
      relTypesOf: store.relTypesOf,
      mapped: () => ['kind-b'],
    }).map((item) => `${item.nodeKey} ${item.label}`);
  /** The not yet retrieved count the server would give: no number when a loaded node has no preview, otherwise what the previews say. */
  const notRetrieved = (): Count => (state.loadedGraph().nodes.some((entry) => !held.has(elementKey(entry.ref))) ? { quality: 'unknown', scope: 'x' } : { value: 100, quality: 'lowerBound', scope: 'x' });
  const lines = () => {
    const graph = state.loadedGraph();
    return [loadedLine(graph), remainderLine(shownCount(graph.nodes.map((entry) => elementKey(entry.ref)), new Set(), new Set()), { count: notRetrieved(), uncounted: 0 }), JSON.stringify(coverageEntitiesOf(graph))];
  };
  return { asked, state, store, aggregates, lines, held };
}

describe('after a collapse', () => {
  it('draws each aggregate at 0 / total, and at its earlier figure after the node is expanded again', async () => {
    const { store, aggregates } = rig();
    store.touch(A);
    expect(aggregates()).toEqual([`${elementKey(A)} kind-b · 0 / 12`]);
    await store.expand(A, ['kind-b']);
    const loaded = aggregates();
    expect(loaded).toEqual([`${elementKey(A)} kind-b · 2 / 12`]);
    store.collapse(A);
    expect(aggregates()).toEqual([`${elementKey(A)} kind-b · 0 / 12`]);
    await store.expand(A, ['kind-b']);
    expect(aggregates()).toEqual(loaded);
  });

  it('gives the scope lines and the entities the server is asked about exactly as before the expansion, and sends only the expansion', async () => {
    const { store, aggregates, lines, asked } = rig();
    store.touch(A);
    const before = { lines: lines(), aggregates: aggregates() };
    await store.expand(A, ['kind-b']);
    expect(lines()).not.toEqual(before.lines);
    store.collapse(A);
    expect(lines()).toEqual(before.lines);
    expect(aggregates()).toEqual(before.aggregates);
    expect(asked).toEqual(['expand']);
  });

  it('keeps no number where another node has no preview, and shows the count the server gives where the collapsed node itself had none', async () => {
    const other = rig([A, D], [A]);
    other.store.touch(A);
    const unknown = other.lines();
    expect(unknown[1]).toBe('2 shown · more not yet retrieved');
    await other.store.expand(A, ['kind-b']);
    other.store.collapse(A);
    expect(other.lines()).toEqual(unknown);

    const own = rig([A], []);
    own.store.touch(A);
    expect(own.lines()[1]).toBe('1 shown · more not yet retrieved');
    await own.store.expand(A, ['kind-b']);
    own.store.collapse(A);
    expect(own.lines()[1]).toBe('1 shown · ≥ 100 not yet retrieved (lower bound)');
  });

  it('leaves the aggregates and the entity the server is asked about for another expanded node as they were when a node is collapsed', async () => {
    const { store, aggregates, state } = rig([A, D]);
    store.touch(A);
    store.touch(D);
    await store.expand(D, ['kind-b']);
    await store.expand(A, ['kind-b']);
    const forD = (rows: readonly string[]) => rows.filter((row) => row.startsWith(elementKey(D)));
    const entityD = () => JSON.stringify(coverageEntitiesOf(state.loadedGraph()).filter((entry) => entry.ref.stableId === 'n2'));
    const aggregatesOfD = forD(aggregates());
    const coverageOfD = entityD();
    expect(aggregatesOfD).toEqual([`${elementKey(D)} kind-b · 1 / 12`]);
    store.collapse(A);
    expect(forD(aggregates())).toEqual(aggregatesOfD);
    expect(entityD()).toBe(coverageOfD);
    expect(aggregates().filter((row) => row.startsWith(elementKey(A)))).toEqual([`${elementKey(A)} kind-b · 0 / 12`]);
  });
});

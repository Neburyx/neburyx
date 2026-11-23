import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { edgeRef, node, ref } from '../state/test-data.js';
import { citationEntries } from './summary-model.js';

const typed = (stableId: string, type: string): GraphNode => ({ ...node('a', stableId), ref: ref('a', type, stableId), display: { title: `Title ${stableId}`, type: `Display ${type}` } });
const link = (stableId: string, from: GraphNode, to: GraphNode, type: string): GraphEdge => ({
  ref: edgeRef('a', stableId, type, from.ref.entityType, to.ref.entityType),
  from: from.ref,
  to: to.ref,
  type,
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
});
const graphOf = (nodes: readonly GraphNode[], edges: readonly GraphEdge[]): LoadedGraph => ({ nodes, edges, entities: { quality: 'exact', scope: 'loaded', value: nodes.length }, relationships: { quality: 'exact', scope: 'loaded', value: edges.length } });
const responseOf = (edges: readonly GraphEdge[]) => ({
  sentences: [{ cites: edges.map((held) => edgeKey(held.ref)) }],
  citations: edges.map((held) => ({ key: edgeKey(held.ref), kind: 'relationship' as const, ref: held.ref })),
});

describe('the numbered entries of a draft: the shape of a cited relationship', () => {
  const account = typed('el-1', 'kind-a');
  const payment = typed('el-2', 'kind-b');
  const owns = link('rel-1', account, payment, 'OWNS');

  it('keeps the type and the two ends, with their display type and title, of a relationship the graph held', () => {
    const [entry] = citationEntries(responseOf([owns]), graphOf([account, payment], [owns]));
    expect(entry?.shape).toEqual({
      relationshipType: 'OWNS',
      from: { key: elementKey(account.ref), type: 'Display kind-a', typeName: 'Display kind-a', title: 'Title el-1' },
      to: { key: elementKey(payment.ref), type: 'Display kind-b', typeName: 'Display kind-b', title: 'Title el-2' },
    });
  });

  it('keeps the name the profile gives each end type beside the type the source names', () => {
    const [entry] = citationEntries(responseOf([owns]), graphOf([account, payment], [owns]), (type) => `Named ${type}`);
    expect(entry?.shape?.from).toMatchObject({ type: 'Display kind-a', typeName: 'Named Display kind-a' });
    expect(entry?.shape?.to).toMatchObject({ type: 'Display kind-b', typeName: 'Named Display kind-b' });
  });

  it('keeps no shape for a relationship the graph did not hold, or whose end it did not hold', () => {
    const [absent] = citationEntries(responseOf([owns]), graphOf([], []));
    const [endMissing] = citationEntries(responseOf([owns]), graphOf([account], [owns]));
    expect(absent?.shape).toBeUndefined();
    expect(endMissing?.shape).toBeUndefined();
  });

  it('is fixed when the draft arrives: a later graph does not change an entry already made', () => {
    const entries = citationEntries(responseOf([owns]), graphOf([account, payment], [owns]));
    citationEntries(responseOf([owns]), graphOf([], []));
    expect(entries[0]?.shape?.from.title).toBe('Title el-1');
  });

  it('keeps no shape for an entity', () => {
    const [entry] = citationEntries({ sentences: [{ cites: ['n'] }], citations: [{ key: 'n', kind: 'entity', ref: account.ref }] }, graphOf([account], []));
    expect(entry?.shape).toBeUndefined();
  });
});

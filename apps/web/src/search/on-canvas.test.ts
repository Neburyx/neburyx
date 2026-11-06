import { describe, expect, it } from 'vitest';
import type { GraphNode, SourceProfile } from '@neburyx/contracts';
import { testProfile } from '../dev/test-profile.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { createClientState } from '../state/client-state.js';
import { edge, node } from '../state/test-data.js';
import { loadGraph } from '../workspace/context-menu-kit.js';
import { entitiesOnCanvas, findOnCanvas } from './on-canvas.js';

function graphOf(nodes: readonly GraphNode[], edges: readonly ReturnType<typeof edge>[]): LoadedGraph {
  const state = createClientState();
  loadGraph(state, nodes, edges);
  return state.loadedGraph();
}

const named = (stableId: string, title: string): GraphNode => ({ ...node('a', stableId), display: { title, type: 'type-a' } });
const profile: SourceProfile = testProfile('a');
const typeName = profile.entityTypes.find((type) => type.type === 'type-a')?.displayName ?? 'type-a';

describe('finding items on the canvas', () => {
  const graph = graphOf([named('ACC-48291', 'Review required'), named('ACC-71825', 'Active'), node('a', 'DEV-884')], [edge('a', 'REL-1', 'ACC-48291', 'DEV-884')]);
  const keysOf = (text: string): string[] => findOnCanvas(graph, profile, text).map((row) => row.id ?? row.title);

  it('finds an entity by part of its stable ID, case-insensitively', () => {
    expect(keysOf('acc-48')).toEqual(['ACC-48291']);
    expect(keysOf('ACC-')).toEqual(['ACC-48291', 'ACC-71825']);
  });

  it('finds an entity by part of its title and by its type display name', () => {
    expect(keysOf('review')).toEqual(['ACC-48291']);
    expect(keysOf(typeName.slice(0, 3)).sort()).toEqual(['ACC-48291', 'ACC-71825', 'DEV-884']);
  });

  it('finds a relationship by its type and by its stable ID', () => {
    expect(findOnCanvas(graph, profile, 'rel-a').map((row) => row.kind)).toEqual(['relationship']);
    expect(findOnCanvas(graph, profile, 'REL-1').map((row) => row.kind)).toEqual(['relationship']);
  });

  it('finds nothing for an empty text, a text no item contains, and a text with a space that no item has', () => {
    expect(keysOf('')).toEqual([]);
    expect(keysOf('zzz')).toEqual([]);
    expect(keysOf('ACC-48291 ')).toEqual([]);
  });

  it('matches a masked value as it is masked and not the value behind it', () => {
    const masked: GraphNode = { ...node('a', 'P-1'), display: { title: '•••• ••••', type: 'type-a' }, properties: [{ key: 'ownerName', value: '•••• ••••', dataClass: 'name', masked: true, maskedBy: 'request' }] };
    const among = graphOf([masked], []);
    expect(findOnCanvas(among, profile, '••')).toHaveLength(1);
    expect(findOnCanvas(among, profile, 'Ana')).toEqual([]);
  });

  it('lists neither a relationship with an end that is not loaded nor counts it, and counts only entities', () => {
    const open = graphOf([node('a', 'N-1')], [edge('a', 'REL-9', 'N-1', 'N-OUT')]);
    expect(findOnCanvas(open, profile, 'REL-9')).toEqual([]);
    expect(entitiesOnCanvas(open)).toBe(1);
    expect(entitiesOnCanvas(graph)).toBe(3);
  });
});

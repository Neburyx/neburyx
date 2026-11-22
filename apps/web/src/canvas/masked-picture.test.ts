import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { edge, node } from '../state/test-data.js';
import { stubFactory } from '../test-utils.js';
import { graphWithItems, pictureApart, PictureItemMissing } from './masked-picture.js';
import type { Scene } from './scene.js';
import { buildScene } from './build-scene.js';

const count = { value: 0, quality: 'exact' as const, scope: 'loaded in this view' };
const graphOf = (nodes: readonly GraphNode[], edges: readonly GraphEdge[]): LoadedGraph => ({ nodes, edges, entities: count, relationships: count });
const masked = (original: GraphNode): GraphNode => ({ ...original, display: { ...original.display, title: 'J••• L•••' } });
const BOUNDS = { maxWidth: 1000, maxHeight: 1000, maxArea: 1_000_000 };

describe('the graph with the items of a picture', () => {
  it('takes every entity and relationship from the items and keeps the rest of the graph', () => {
    const a = node('demo', 'A');
    const b = node('demo', 'B');
    const link = edge('demo', 'L-1', 'A', 'B');
    const swapped = graphWithItems(graphOf([a, b], [link]), { nodes: [masked(b), masked(a)], edges: [link] });
    expect(swapped.nodes.map((entry) => entry.display.title)).toEqual(['J••• L•••', 'J••• L•••']);
    expect(swapped.nodes.map((entry) => elementKey(entry.ref))).toEqual([elementKey(a.ref), elementKey(b.ref)]);
    expect(swapped.edges.map((entry) => edgeKey(entry.ref))).toEqual([edgeKey(link.ref)]);
  });

  it('fails when an entity or a relationship of the graph has no counterpart, so nothing is drawn as it is loaded', () => {
    const a = node('demo', 'A');
    const b = node('demo', 'B');
    const link = edge('demo', 'L-1', 'A', 'B');
    expect(() => graphWithItems(graphOf([a, b], []), { nodes: [masked(a)], edges: [] })).toThrow(PictureItemMissing);
    expect(() => graphWithItems(graphOf([a], [link]), { nodes: [masked(a)], edges: [] })).toThrow(PictureItemMissing);
  });
});

describe('a picture drawn apart', () => {
  const a = node('demo', 'A');
  const scene = (): Scene => buildScene(graphOf([masked(a)], []), new Map([[elementKey(a.ref), { x: 1, y: 2 }]]), undefined, new Set(), 'select', 'demo', 'as-drawn');

  it('is drawn by a renderer of its own in a container the person does not see, which is gone when the picture is made', async () => {
    const factory = stubFactory();
    const picture = await pictureApart(factory.create, scene(), BOUNDS);
    expect(picture).toBeInstanceOf(Blob);
    expect(factory.made).toHaveLength(1);
    const [made] = factory.made;
    expect(made?.scenes).toHaveLength(1);
    expect(made?.mounts[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(made?.mounts[0]?.isConnected).toBe(false);
    expect(made?.disposed).toBe(1);
    expect(document.querySelector('.picture-apart')).toBeNull();
  });

  it('is disposed and removed when the drawing fails', async () => {
    const factory = stubFactory({ failOn: 'draw' });
    await expect(pictureApart(factory.create, scene(), BOUNDS)).rejects.toThrow();
    expect(factory.made[0]?.disposed).toBe(1);
    expect(document.querySelector('.picture-apart')).toBeNull();
  });
});

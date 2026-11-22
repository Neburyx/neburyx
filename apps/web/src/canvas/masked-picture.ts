import type { GraphEdge, GraphNode } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import type { CanvasEvents, CreateRenderer, Scene } from './scene.js';
import type { SnapshotBounds } from './snapshot.js';

/** The items a picture is drawn from in place of the loaded ones. */
export interface PictureItems {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** The view and its drawing context as they were when a picture was asked for; what it draws is that view with other items, whatever the canvas shows later. */
export interface PictureCapture {
  readonly graph: LoadedGraph;
  draw(items: PictureItems, bounds: SnapshotBounds): Promise<Blob>;
}

/** A drawn item that the items do not hold: the picture would show it as it is loaded. */
export class PictureItemMissing extends Error {
  constructor() {
    super('an item of the drawing has no counterpart in the items of the picture');
  }
}

/** The graph with every entity and relationship taken from the items; one that has no counterpart there fails, so nothing is drawn as it is loaded. */
export function graphWithItems(graph: LoadedGraph, items: PictureItems): LoadedGraph {
  const nodes = new Map(items.nodes.map((node) => [elementKey(node.ref), node]));
  const edges = new Map(items.edges.map((edge) => [edgeKey(edge.ref), edge]));
  const replaced = <T>(held: ReadonlyMap<string, T>, key: string): T => {
    const found = held.get(key);
    if (found === undefined) throw new PictureItemMissing();
    return found;
  };
  return { ...graph, nodes: graph.nodes.map((node) => replaced(nodes, elementKey(node.ref))), edges: graph.edges.map((edge) => replaced(edges, edgeKey(edge.ref))) };
}

const NO_EVENTS = (onFailure: () => void): CanvasEvents => ({ click: () => undefined, box: () => undefined, viewport: () => undefined, contextMenu: () => undefined, move: () => undefined, failed: onFailure });

/** The scene as a picture, drawn by a renderer of its own in a container the person never sees; the canvas on screen is not touched. */
export async function pictureApart(createRenderer: CreateRenderer, scene: Scene, bounds: SnapshotBounds): Promise<Blob> {
  const host = document.createElement('div');
  host.className = 'picture-apart';
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  const renderer = createRenderer();
  let failed = false;
  try {
    renderer.mount(host, NO_EVENTS(() => (failed = true)), undefined);
    renderer.draw(scene);
    const picture = await renderer.snapshot(bounds);
    if (failed) throw new Error('the drawing failed');
    return picture;
  } finally {
    renderer.dispose();
    host.remove();
  }
}

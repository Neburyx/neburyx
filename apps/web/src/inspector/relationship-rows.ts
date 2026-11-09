import type { Count, DegreePreview, ElementRef, GraphEdge, GraphNode } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';
import { partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { combineDegreeCounts } from '../workspace/node-counts.js';

export interface RelationshipRow {
  readonly key: string;
  readonly edge: GraphEdge;
  /** The loaded entity at the other end of the relationship (the entity itself for one that loops back). */
  readonly otherEnd: GraphNode;
  readonly outgoing: boolean;
}

export interface RelationshipGroup {
  readonly type: string;
  readonly rows: readonly RelationshipRow[];
  /** The source's count of this relationship type at the entity in every direction; none until a preview is ready, and none when any direction has no count. */
  readonly total: Count | undefined;
}

export interface RelationshipList {
  /** Stored relationships by type, in type order, each type the preview counts or a row has. */
  readonly groups: readonly RelationshipGroup[];
  readonly derived: readonly RelationshipRow[];
  readonly unknownOrigin: readonly RelationshipRow[];
  /** Loaded relationships of the entity that the view does not draw because an end or the type is left out of it; a relationship with an end that is not loaded is not counted. */
  readonly leftOut: number;
}

const touches = (edge: GraphEdge, key: string): boolean => elementKey(edge.from) === key || elementKey(edge.to) === key;

/** The drawn relationships of an entity as rows, and what the view leaves out of its loaded ones. `loaded` is the graph before the view's filters, `visible` the one the canvas draws. */
export function relationshipList(loaded: LoadedGraph, visible: LoadedGraph, entity: ElementRef, preview: DegreePreview | undefined): RelationshipList {
  const key = elementKey(entity);
  const byKey = new Map(visible.nodes.map((node) => [elementKey(node.ref), node]));
  const drawn = new Set(partitionEdges(visible).drawable.map((edge) => edgeKey(edge.ref)));
  const rows: RelationshipRow[] = [];
  for (const edge of visible.edges) {
    if (!touches(edge, key) || !drawn.has(edgeKey(edge.ref))) continue;
    const outgoing = elementKey(edge.from) === key;
    const otherEnd = byKey.get(outgoing ? elementKey(edge.to) : elementKey(edge.from));
    if (otherEnd !== undefined) rows.push({ key: edgeKey(edge.ref), edge, otherEnd, outgoing });
  }
  const stored = rows.filter(({ edge }) => edge.semantics === 'stored');
  const types = new Set([...stored.map(({ edge }) => edge.type), ...(preview?.byType.map((entry) => entry.relationshipType) ?? [])]);
  const groups = [...types]
    .sort((a, b) => a.localeCompare(b))
    .map((type) => ({ type, rows: stored.filter(({ edge }) => edge.type === type), total: combineDegreeCounts(preview?.byType.filter((entry) => entry.relationshipType === type).map((entry) => entry.count) ?? []) }))
    .filter((group) => group.rows.length > 0 || group.total?.value !== 0);
  const loadedNodes = new Set(loaded.nodes.map((node) => elementKey(node.ref)));
  const leftOut = loaded.edges.filter((edge) => touches(edge, key) && loadedNodes.has(elementKey(edge.from)) && loadedNodes.has(elementKey(edge.to)) && !drawn.has(edgeKey(edge.ref))).length;
  return { groups, derived: rows.filter(({ edge }) => edge.semantics === 'derived'), unknownOrigin: rows.filter(({ edge }) => edge.semantics === 'unknown'), leftOut };
}

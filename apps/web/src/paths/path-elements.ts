import type { GraphEdge, GraphNode, PathsOk } from '@neburyx/contracts';
import { edgeKey, elementKey } from '../state/keys.js';

type Step = PathsOk['paths'][number]['steps'][number];

const sameEnds = (edge: GraphEdge, step: Step): boolean =>
  edge.type === step.relationshipType &&
  ((elementKey(edge.from) === elementKey(step.from) && elementKey(edge.to) === elementKey(step.to)) || (elementKey(edge.from) === elementKey(step.to) && elementKey(edge.to) === elementKey(step.from)));

/**
 * The relationship a step walked, among the answer's edges: the ones of its type between its two ends, and when several join the same pair, the one that carries the step's own evidence references. A step's
 * relationship is not named by an identifier of its own in the answer, so a pair joined twice by one type with the same evidence stays ambiguous and the first is taken.
 */
export function edgeOfStep(result: PathsOk, step: Step): GraphEdge | undefined {
  const candidates = result.edges.filter((edge) => sameEnds(edge, step));
  return candidates.find((edge) => edge.evidenceRefs.length === step.evidenceRefs.length && edge.evidenceRefs.every((reference, index) => reference === step.evidenceRefs[index])) ?? candidates[0];
}

export interface PathElements {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** The entities and relationships one path of the answer names. */
export function elementsOf(result: PathsOk, position: number): PathElements {
  const path = result.paths[position];
  if (path === undefined) return { nodes: [], edges: [] };
  const wanted = new Set(path.steps.flatMap((step) => [elementKey(step.from), elementKey(step.to)]));
  const edges = new Map<string, GraphEdge>();
  for (const step of path.steps) {
    const edge = edgeOfStep(result, step);
    if (edge !== undefined) edges.set(edgeKey(edge.ref), edge);
  }
  return { nodes: result.nodes.filter((node) => wanted.has(elementKey(node.ref))), edges: [...edges.values()] };
}

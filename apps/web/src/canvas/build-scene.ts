import type { SourceProfile } from '@neburyx/contracts';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { Position } from '../state/presentation-state.js';
import { entityLook } from './entity-look.js';
import { relationshipLook } from './relationship-look.js';
import type { Scene } from './scene.js';

/** A relationship whose entity is not loaded cannot be drawn between two entities, so it is left out of the drawing and counted in `omitted`. */
export function buildScene(graph: LoadedGraph, positions: ReadonlyMap<string, Position>, profile: SourceProfile | undefined, view: Scene['view'] = 'fit'): Scene {
  const entities = graph.nodes.map((node) => {
    const id = elementKey(node.ref);
    return { id, position: positions.get(id), look: entityLook(node, profile) };
  });
  const drawn = new Set(entities.map((entity) => entity.id));
  const relationships = graph.edges
    .map((edge) => ({ id: edgeKey(edge.ref), from: elementKey(edge.from), to: elementKey(edge.to), look: relationshipLook(edge) }))
    .filter((relationship) => drawn.has(relationship.from) && drawn.has(relationship.to));
  return { entities, relationships, profile, omitted: graph.edges.length - relationships.length, view };
}

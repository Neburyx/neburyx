import type { SourceProfile } from '@neburyx/contracts';
import { drawnKeys, partitionEdges, type LoadedGraph } from '../state/loaded-graph.js';
import { edgeKey, elementKey } from '../state/keys.js';
import type { PointerTool, Position } from '../state/presentation-state.js';
import { entityLook } from './entity-look.js';
import { relationshipLook } from './relationship-look.js';
import type { Scene, SceneEntity, SceneRelationship } from './scene.js';
import { aggregateKey, aggregateLinkKey, type AggregateNode } from '../workspace/aggregate-nodes.js';
import { BOX_HEIGHT, BOX_WIDTH, REMAINDER_RADIUS, REMAINDER_RING_STEP } from './layout-constants.js';

/** Every loaded entity must have a position; a relationship whose entity is not loaded cannot be drawn between two entities, so it is left out of the drawing and counted in `omitted`. */
export function buildScene(graph: LoadedGraph, positions: ReadonlyMap<string, Position>, profile: SourceProfile | undefined, selection: ReadonlySet<string>, tool: PointerTool, source: string | null, view: Scene['view'] = 'fit', pins: ReadonlySet<string> = new Set(), focused: string | undefined = undefined, focusRing = true, aggregates: readonly AggregateNode[] = []): Scene {
  const entities = graph.nodes.map((node) => {
    const id = elementKey(node.ref);
    const position = positions.get(id);
    if (position === undefined) throw new Error('NO_POSITION');
    return { id, position, look: entityLook(node, profile) };
  });
  const { drawable, notDrawable } = partitionEdges(graph);
  const relationships = drawable.map((edge) => ({ id: edgeKey(edge.ref), from: elementKey(edge.from), to: elementKey(edge.to), look: relationshipLook(edge, selection.has(elementKey(edge.from)) || selection.has(elementKey(edge.to))) }));
  const drawn = drawnKeys(graph);
  const remainders = aggregateItems(aggregates, positions);
  const walkable = new Set([...drawn, ...remainders.entities.map((entity) => entity.id)]);
  return { entities: [...entities, ...remainders.entities], relationships: [...relationships, ...remainders.relationships], profile, source, tool, selection: new Set([...selection].filter((key) => drawn.has(key))), pinned: new Set([...pins].filter((key) => drawn.has(key))), focused: focused !== undefined && walkable.has(focused) ? focused : undefined, focusRing, omitted: notDrawable.length, view };
}

const ANGLE_STEPS = 24;
const MAX_RINGS = 12;

const clashes = (at: Position, others: readonly Position[]): boolean => others.some((other) => Math.abs(other.x - at.x) < BOX_WIDTH && Math.abs(other.y - at.y) < BOX_HEIGHT);

/**
 * The aggregate nodes of the scene, each as near its node as there is room: on a ring around it (the first at straight above), and further out, ring by ring, where a loaded entity or another aggregate node already is. Nothing loaded is moved. A node that has no
 * position is skipped. Where no room is found in the rings, the node goes on the first ring anyway.
 */
function aggregateItems(aggregates: readonly AggregateNode[], positions: ReadonlyMap<string, Position>): { readonly entities: readonly SceneEntity[]; readonly relationships: readonly SceneRelationship[] } {
  const byNode = new Map<string, AggregateNode[]>();
  for (const aggregate of aggregates) byNode.set(aggregate.nodeKey, [...(byNode.get(aggregate.nodeKey) ?? []), aggregate]);
  const taken: Position[] = [...positions.values()];
  const entities: SceneEntity[] = [];
  const relationships: SceneRelationship[] = [];
  for (const [nodeKey, held] of byNode) {
    const anchor = positions.get(nodeKey);
    if (anchor === undefined) continue;
    held.forEach((aggregate, index) => {
      const start = -Math.PI / 2 + (2 * Math.PI * index) / held.length;
      let spot: Position | undefined;
      for (let ring = 0; ring < MAX_RINGS && spot === undefined; ring += 1) {
        const radius = REMAINDER_RADIUS + ring * REMAINDER_RING_STEP;
        for (let step = 0; step < ANGLE_STEPS && spot === undefined; step += 1) {
          const angle = start + (2 * Math.PI * step) / ANGLE_STEPS;
          const candidate = { x: anchor.x + radius * Math.cos(angle), y: anchor.y + radius * Math.sin(angle) };
          if (!clashes(candidate, taken)) spot = candidate;
        }
      }
      const position = spot ?? { x: anchor.x + REMAINDER_RADIUS * Math.cos(start), y: anchor.y + REMAINDER_RADIUS * Math.sin(start) };
      taken.push(position);
      const id = aggregateKey(nodeKey, aggregate.neighborType);
      entities.push({ id, remainder: true, position, look: { iconKey: aggregate.iconKey, line1: aggregate.name, line2: aggregate.figures, tip: { title: aggregate.label, detail: aggregate.detail } } });
      relationships.push({ id: aggregateLinkKey(nodeKey, aggregate.neighborType), from: nodeKey, to: id, remainder: true, look: { aggregate: false, origin: 'stored', label: undefined } });
    });
  }
  return { entities, relationships };
}
